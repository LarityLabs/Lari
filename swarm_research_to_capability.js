'use strict';

/**
 * Turning what Lari reads into something it can actually do.
 *
 * The missing step in this project's loop. Lari can research -- fetch sources, score them, keep what
 * independent sources agree on. Lari can repair -- generate candidate patches and keep whatever passes
 * a project's own tests. Nothing joined them, so reading produced sentences and sentences produced
 * nothing. A gap it had read about was exactly as unfixable as a gap it had never heard of.
 *
 * What makes the join tractable is the shape of a repair rule. Lari's repair vocabulary is not code; it
 * is pairs -- `['>=', '>']`, `[' + ', ' - ']`. And prose about defects names those pairs constantly,
 * because that is how people describe bugs to each other: "use `>=` instead of `>`", "replace the
 * multiplication with floor division", "the `+` should have been a `-`". So a sentence can be read for
 * the substitution it mentions, and a substitution is directly executable by the engine that already
 * exists.
 *
 * The honesty constraint, which is the whole design
 * ------------------------------------------------
 * Reading is allowed to *propose* and never to *conclude*. An extracted pair is a hypothesis with a
 * citation, nothing more. It becomes a retained capability only by repairing a real defect through the
 * project's own suite -- the same bar every other rule in the vocabulary had to clear. Text is never
 * evidence that something works; it is only a suggestion about what to try.
 *
 * That distinction is not fussiness. This repository once stored answers it had derived rather than
 * verified, and the resulting score was worthless. A loop that could mark a capability learned because
 * a document described it would reproduce that failure with better manners, and it would be harder to
 * detect, because the model state would look like reasoning rather than like a lookup table.
 */

/** Code-ish tokens: operators and short identifiers, the things a substitution can be made of. */
const CODE_TOKEN = '[<>=!+\\-*/%&|^~]{1,3}|[A-Za-z_][A-Za-z0-9_]{0,20}\\(?';

/**
 * Sentence patterns that name a substitution.
 *
 * Ordered so that the ones stating direction unambiguously come first. "instead of" reverses the
 * pair relative to "replace X with Y", and getting that backwards would propose the defect rather
 * than the fix -- which the oracle would catch, but only after spending a verification on it.
 */
const SUBSTITUTION_PATTERNS = [
  { regex: new RegExp(`replace\\s+\`?(${CODE_TOKEN})\`?\\s+with\\s+\`?(${CODE_TOKEN})\`?`, 'gi'), order: 'from-to' },
  { regex: new RegExp(`change\\s+\`?(${CODE_TOKEN})\`?\\s+(?:in)?to\\s+\`?(${CODE_TOKEN})\`?`, 'gi'), order: 'from-to' },
  { regex: new RegExp(`swap\\s+\`?(${CODE_TOKEN})\`?\\s+for\\s+\`?(${CODE_TOKEN})\`?`, 'gi'), order: 'from-to' },
  { regex: new RegExp(`\`?(${CODE_TOKEN})\`?\\s+should\\s+(?:be|have been)\\s+\`?(${CODE_TOKEN})\`?`, 'gi'), order: 'from-to' },
  { regex: new RegExp(`\`(${CODE_TOKEN})\`\\s*(?:->|→|becomes)\\s*\`(${CODE_TOKEN})\``, 'gi'), order: 'from-to' },
  { regex: new RegExp(`use\\s+\`?(${CODE_TOKEN})\`?\\s+instead\\s+of\\s+\`?(${CODE_TOKEN})\`?`, 'gi'), order: 'to-from' },
  { regex: new RegExp(`\`?(${CODE_TOKEN})\`?\\s+rather\\s+than\\s+\`?(${CODE_TOKEN})\`?`, 'gi'), order: 'to-from' }
];

/** Operators are spaced in the vocabulary so ' + ' does not match the '+' inside '+='. */
function normalizeToken(token) {
  const bare = String(token).trim().replace(/`/g, '');
  if (/^[<>=!+\-*/%&|^~]{1,3}$/.test(bare)) {
    // Comparison operators are stored bare; arithmetic and boolean ones spaced.
    return /^(?:>=|<=|==|!=|<|>)$/.test(bare) ? bare : ` ${bare} `;
  }
  return bare;
}

/**
 * Read a source for substitutions it proposes.
 *
 * Returns hypotheses, each carrying the sentence that suggested it and the source it came from, so a
 * rule that later earns retention can say where the idea originated. Nothing here decides anything.
 */
function extractSubstitutionProposals(sources = []) {
  const proposals = new Map();

  for (const source of Array.isArray(sources) ? sources : [sources]) {
    const text = String(source?.text || source || '');
    const title = source?.title || source?.url || 'untitled source';

    for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
      for (const { regex, order } of SUBSTITUTION_PATTERNS) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(sentence)) !== null) {
          const first = normalizeToken(match[1]);
          const second = normalizeToken(match[2]);
          const from = order === 'from-to' ? first : second;
          const to = order === 'from-to' ? second : first;
          if (!from || !to || from === to) continue;
          if (from.trim().length > 21 || to.trim().length > 21) continue;
          const key = `${from}=>${to}`;
          const found = proposals.get(key) || { rule: [from, to], evidence: [], sources: new Set() };
          if (found.evidence.length < 3) found.evidence.push(sentence.trim().slice(0, 160));
          found.sources.add(title);
          proposals.set(key, found);
        }
      }
    }
  }

  return [...proposals.values()].map(entry => ({
    rule: entry.rule,
    evidence: entry.evidence,
    sources: [...entry.sources],
    // Ranked by how many independent sources suggested it; agreement is a better prior than order of
    // appearance, and costs nothing to compute.
    support: entry.sources.size
  })).sort((left, right) => right.support - left.support);
}

function extractOperatorForConcept(sources = [], concept = '') {
  const normalizedConcept = String(concept || '').toLowerCase();
  const conceptTerms = normalizedConcept.trim() ? [normalizedConcept.trim()] : [];
  if (/\bpower|exponent/.test(normalizedConcept)) conceptTerms.push('pow', 'exponent');
  if (/floor division|integer division/.test(normalizedConcept)) conceptTerms.push('floordiv', 'quotient');
  if (!conceptTerms.length) return { learned: false, reason: 'a semantic operator concept is required' };
  const operators = ['**', '//', '%', '>=', '<=', '==', '!=', '+', '-', '*', '/'];
  const support = new Map();
  for (const source of Array.isArray(sources) ? sources : [sources]) {
    const text = String(source?.text || '').toLowerCase();
    if (!conceptTerms.some(term => text.includes(term))) continue;
    for (const operator of operators) {
      const tokenPositions = [...text.matchAll(/\*\*|\/\/|>=|<=|==|!=|[+*/%<>!-]/g)]
        .filter(match => match[0] === operator).map(match => match.index);
      if (!tokenPositions.length) continue;
      const conceptPositions = conceptTerms.flatMap(term => {
        const positions = [];
        for (let index = text.indexOf(term); index >= 0; index = text.indexOf(term, index + term.length)) positions.push(index);
        return positions;
      });
      const operatorPosition = tokenPositions.sort((a, b) =>
        Math.min(...conceptPositions.map(p => Math.abs(p - a))) - Math.min(...conceptPositions.map(p => Math.abs(p - b))))[0];
      const distance = Math.min(...conceptPositions.map(position => Math.abs(position - operatorPosition)));
      const entry = support.get(operator) || { operator, sources: [], evidence: [], distances: [] };
      const title = source?.title || source?.url || 'technical source';
      if (!entry.sources.includes(title)) { entry.sources.push(title); entry.distances.push(distance); }
      const position = operatorPosition;
      entry.evidence.push(String(source.text).slice(Math.max(0, position - 180), position + 320).replace(/\s+/g, ' ').trim());
      support.set(operator, entry);
    }
  }
  const ranked = [...support.values()].map(entry => ({ ...entry, meanConceptDistance: entry.distances.reduce((sum, value) => sum + value, 0) / entry.distances.length }))
    .sort((left, right) => right.sources.length - left.sources.length || left.meanConceptDistance - right.meanConceptDistance || operators.indexOf(left.operator) - operators.indexOf(right.operator));
  const winner = ranked[0];
  if (!winner || winner.sources.length < 2) return { learned: false, reason: 'independent technical sources did not agree on an operator', candidates: ranked };
  return { learned: true, operator: normalizeToken(winner.operator), support: winner.sources.length, citation: { sources: winner.sources, evidence: winner.evidence.slice(0, 2) }, candidates: ranked };
}

/**
 * Turn source-backed knowledge about string case normalization into a typed *proposal*.
 *
 * Documentation can establish what lower()/casefold() do, but it cannot decide whether a
 * particular program should preserve case.  The latter must be explicit in the failure and the
 * proposal remains unlearned until the native oracle accepts a repair.  Citations are deliberately
 * reduced to stable source metadata: the learned primitive retains provenance, never document text
 * or task-specific expected output.
 */
function extractCaseNormalizationProposal(sources = [], failureText = '') {
  const failure = String(failureText || '');
  const saysCaseMustRemainDistinct = /(?:case[- ]?sensitive|case[- ]?distinct|different\s+case|preserv(?:e|es|ed)\s+(?:the\s+)?(?:original\s+)?case|case\s+(?:is|as)\s+(?:semantic|significant)|uppercase.{0,40}lowercase|lowercase.{0,40}uppercase)/i.test(failure);
  const namesIdentityContext = /\b(?:duplicate|identity|key|term|name|label|identifier|object|index|lookup|register|mapping|dictionary|glossary)\b/i.test(failure);
  if (!saysCaseMustRemainDistinct) return { proposed: false, verified: false, reason: 'failure evidence does not require a case distinction' };
  if (!namesIdentityContext) return { proposed: false, verified: false, reason: 'failure evidence does not identify a semantic identity context' };

  const citations = [];
  for (const source of Array.isArray(sources) ? sources : [sources]) {
    const text = String(source?.text || '').replace(/\s+/g, ' ').trim();
    const official = /^https:\/\/docs\.python\.org\//i.test(String(source?.url || ''))
      || /^official_/i.test(String(source?.sourceType || ''));
    const documentsNormalization = /(?:str\.(?:lower|casefold)\s*\(|\b(?:lower|casefold)\s*\(\)|converted\s+to\s+lowercase|caseless\s+matching|case[- ]?fold)/i.test(text);
    if (!official || !documentsNormalization || !source?.url) continue;
    const citation = {
      title: String(source.title || source.url).slice(0, 240),
      url: String(source.url),
      sourceType: String(source.sourceType || 'official_technical_reference')
    };
    if (!citations.some(existing => existing.url === citation.url)) citations.push(citation);
  }
  if (!citations.length) return { proposed: false, verified: false, reason: 'no authoritative source described a case-normalization operation' };
  return {
    proposed: true,
    verified: false,
    primitive: {
      kind: 'case-normalization-policy',
      matcher: 'semantic_identity_key',
      composition: 'preserve_case_distinction'
    },
    citation: { sources: citations }
  };
}

/**
 * Try what was read against the defect that motivated reading it.
 *
 * Every proposal is a candidate family of exactly one rule, tested by the same search and the same
 * oracle as any other. The first that repairs the defect is returned with its citation; the rest are
 * discarded, including any that merely sounded authoritative.
 */
async function learnRuleFromResearch({
  sources,
  source,
  regions,
  verify,
  mutationRepair,
  language = 'python',
  testSource = '',
  failureText = '',
  targetRelative = '',
  testNames = [],
  coveredLines = [],
  vocabulary,
  limit = 120,
  maxProposals = 8
}) {
  const repair = mutationRepair || require('./swarm_mutation_repair.js');
  const proposals = extractSubstitutionProposals(sources).slice(0, maxProposals);
  if (!proposals.length) return { learned: false, reason: 'no substitution proposed by any source', proposals: 0 };

  const base = vocabulary || repair.DEFAULT_VOCABULARY;
  const known = new Set();
  for (const entry of Object.values(base)) {
    for (const rule of entry?.rules || []) known.add(`${rule[0]}=>${rule[1]}`);
  }

  const untried = proposals.filter(proposal => !known.has(`${proposal.rule[0]}=>${proposal.rule[1]}`));
  if (!untried.length) return { learned: false, reason: 'every proposal is already in the vocabulary', proposals: proposals.length };

  // One pooled search over everything reading suggested, for the same reason growth pools its own
  // proposals: a budget per proposal multiplies oracle cost by the number of things read.
  const trial = JSON.parse(JSON.stringify(base));
  trial['researched-substitution'] = { kind: 'operator-substitution', rules: untried.map(proposal => proposal.rule) };

  const outcome = await repair.repairByVerifiedMutationAsync({
    source, language, testSource, failureText, targetRelative, testNames, coveredLines,
    limit,
    vocabulary: trial,
    onlyFamilies: ['researched-substitution'],
    familyPriors: null,
    verify
  });

  if (!outcome.repaired) {
    return { learned: false, reason: 'nothing that was read repaired the defect', proposals: untried.length, attempted: outcome.attempted || [] };
  }

  const winner = untried.find(proposal =>
    `${proposal.rule[0].trim()} -> ${proposal.rule[1].trim()}` === outcome.description);

  return {
    learned: true,
    rule: winner?.rule || null,
    citation: winner ? { sources: winner.sources, evidence: winner.evidence } : null,
    outcome,
    proposals: untried.length,
    attempted: outcome.attempted || []
  };
}

/**
 * Retain a rule that reading proposed and tests proved.
 *
 * Stored as a normal vocabulary rule so it participates in every future search on the same footing as
 * one Lari invented for itself, with the citation kept in provenance. What is retained is the rule,
 * never the sentence: "`*` becomes `//`" generalises to any file, while the paragraph that suggested
 * it is only history.
 */
function retainResearchedRule(model, { rule, citation, family = 'arithmetic-substitution', runtime, reason = '' }) {
  if (!model || !rule || !runtime?.retainLariMutationVocabularyRule) return null;
  const record = runtime.retainLariMutationVocabularyRule(model, {
    family,
    rule,
    reason: (reason || `proposed by reading, verified by tests`).slice(0, 160)
  });
  if (record) {
    record.payload.acquisitionRoute = 'research_proposed_test_verified';
    record.payload.citedSources = (citation?.sources || []).slice(0, 5);
    record.payload.citedEvidence = (citation?.evidence || []).slice(0, 2);
  }
  return record;
}

module.exports = {
  SUBSTITUTION_PATTERNS,
  normalizeToken,
  extractSubstitutionProposals,
  extractOperatorForConcept,
  extractCaseNormalizationProposal,
  learnRuleFromResearch,
  retainResearchedRule
};
