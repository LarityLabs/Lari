'use strict';

/**
 * Phase B of LARI_ROADMAP.md: making research stick, as claims rather than as prose.
 *
 * Why this exists
 * ---------------
 * `model.knowledge` is length 0. Lari researches, cites, answers once, and forgets. Every research
 * probe it has ever run has evaporated, which is the exact opposite of the thesis -- durable
 * intelligence in executable state. The realization lane in `swarm_claim_realization.js` works and has
 * nothing outside repair provenance to talk about, because nothing else in this system ever produces a
 * claim.
 *
 * The failure this is designed against
 * ------------------------------------
 * The live model already contains `skill.grammatical_conjugation`, retained from a cited Wikipedia
 * lookup, and its `answerTemplate` is three sentences of pasted encyclopedia prose. Asked about
 * conjugation, Lari recites. That passes any check that asks "did this come from the source?" -- it is
 * nothing *but* the source -- and it is not knowledge, because nothing was extracted. A store of pasted
 * paragraphs is a worse search engine, not a model.
 *
 * So the unit here is a **typed proposition with slots**, never a sentence. `{ type: 'quantity',
 * values: { subject: 'Jupiter', count: '95', unit: 'moons' } }` is a claim. The sentence it came from is
 * not. Realization then builds language from the structure, which is why the output can be checked for
 * *not* being the source.
 *
 * The automatic oracles, named before the capability, per rule 1
 * -------------------------------------------------------------
 * Three, all machine-decidable:
 *
 *   1. FAITHFULNESS -- every slot value must appear in the cited span. Lari may not say something its
 *      source did not say. This is explicitly NOT a truth oracle: it cannot tell you the source is
 *      right, only that Lari did not embellish it. Anything quoting this must say "faithful to the
 *      source", never "true".
 *   2. ANTI-RECITATION -- the realized text may not reproduce a contiguous run of source words longer
 *      than RECITATION_LIMIT. This is the check that would have refused the conjugation skill. A
 *      generator that passes faithfulness by copying has not learned anything.
 *   3. EXTRACTION -- a claim must have at least two slots filled from distinct positions in the span.
 *      A one-slot "claim" that names a topic is a keyword, and keywords retained as knowledge are how a
 *      store fills with noise.
 *
 * Plus the three that already exist in swarm_claim_realization.js: grounding, proposition preservation,
 * and provenance.
 *
 * What this deliberately does not do
 * ----------------------------------
 * It does not decide whether a source is reliable, reconcile sources that disagree, or answer open
 * questions. Retained claims carry their source and are attributed at use. Two sources that conflict
 * produce two claims and Lari says both came from where they came from -- adjudication would require a
 * truth oracle, and there isn't one. Rule 12 applies throughout: a proposition absent from a source is
 * recorded as absent, never as false.
 */

const realization = require('./swarm_claim_realization.js');

/** Longest run of consecutive source words allowed in a realized answer. */
const RECITATION_LIMIT = 6;

/** Words carrying no propositional content, ignored when comparing an answer against its source. */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'by', 'from', 'as', 'and', 'or', 'but', 'that', 'which', 'it', 'its', 'this', 'these',
  'those', 'has', 'have', 'had', 'not', 'no', 'can', 'may', 'about', 'into', 'than', 'then', 'there'
]);

const words = text => String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'.-]*/g) || [];

/**
 * Extraction patterns: cited text in, typed propositions out.
 *
 * Deliberately few and deliberately shallow. Each produces slots that are spans of the source, so
 * faithfulness holds by construction and the check is a genuine test of the *pipeline* rather than a
 * formality. Widening this set is the way this lane grows; every addition needs a case where the old
 * set produced nothing and the new one produces something checkable.
 */
/**
 * A proper-noun span: "Jupiter", "Ada Lovelace", "The Analytical Engine".
 *
 * Written once and shared, because getting it wrong is not a faithfulness failure and so no oracle
 * catches it. The first version required continuation words to be lowercase, which silently truncated
 * every multi-word name: "Ada Lovelace" was retained as "Lovelace" and "The Analytical Engine" as
 * "Engine". Both passed every check -- they are substrings of the source, they fill two slots, they do
 * not recite -- and both are worse claims than the source supports. Faithful and truncated is still
 * wrong, and only reading the output caught it.
 */
const PROPER = '(?:The\\s+)?[A-Z][A-Za-z-]*(?:\\s+[A-Z][A-Za-z-]*){0,3}';

/** A short common-noun phrase, stopped before the clause runs on. */
const NOMINAL = '[a-z][A-Za-z-]*(?:\\s+[a-z][A-Za-z-]*){0,1}';

const EXTRACTORS = [
  {
    id: 'definition',
    // "X is a Y", "X is the Y" -- the commonest shape in reference prose.
    pattern: new RegExp(`\\b(${PROPER})\\s+is\\s+(?:a|an|the)\\s+(${NOMINAL})\\b`, 'g'),
    build: m => ({ type: 'fact_definition', values: { term: m[1].trim(), category: m[2].trim() } })
  },
  {
    id: 'quantity',
    pattern: new RegExp(`\\b(${PROPER})\\s+(?:has|have|contains?)\\s+((?:\\d[\\d,.]*)|(?:one|two|three|four|five|six|seven|eight|nine|ten))\\s+([a-z][a-z-]*)\\b`, 'g'),
    build: m => ({ type: 'fact_quantity', values: { subject: m[1].trim(), count: m[2].trim(), unit: m[3].trim() } })
  },
  {
    id: 'located',
    pattern: new RegExp(`\\b(${PROPER})\\s+is\\s+(?:located\\s+)?in\\s+(${PROPER})\\b`, 'g'),
    build: m => ({ type: 'fact_location', values: { subject: m[1].trim(), place: m[2].trim() } })
  },
  {
    id: 'dated',
    pattern: new RegExp(`\\b(${PROPER})\\s+(?:was|were)\\s+([a-z][a-z-]*ed)\\s+in\\s+(\\d{3,4})\\b`, 'g'),
    build: m => ({ type: 'fact_event_year', values: { subject: m[1].trim(), action: m[2].trim(), year: m[3].trim() } })
  }
];

/** Realization rules for research claims. Data, so growth can add to them the same way. */
const RESEARCH_REALIZATION_RULES = {
  ...realization.DEFAULT_REALIZATION_RULES,
  fact_definition: {
    slots: ['term', 'category'],
    say: c => `${c.term} falls under ${c.category}.`
  },
  fact_quantity: {
    slots: ['subject', 'count', 'unit'],
    say: c => `The ${c.unit} recorded for ${c.subject} number ${c.count}.`
  },
  fact_location: {
    slots: ['subject', 'place'],
    say: c => `${c.place} is where ${c.subject} sits.`
  },
  fact_event_year: {
    slots: ['subject', 'action', 'year'],
    say: c => `${c.year} is the year given for ${c.subject} being ${c.action}.`
  },
  source_attribution: {
    slots: ['source'],
    say: c => `I hold that from ${c.source}, and I have not verified it independently.`
  }
};

/** Pull typed propositions out of a cited span. */
function atomizeSource(sourceText, meta = {}) {
  const text = String(sourceText || '');
  const claims = [];
  const seen = new Set();
  for (const extractor of EXTRACTORS) {
    extractor.pattern.lastIndex = 0;
    for (const match of text.matchAll(extractor.pattern)) {
      const claim = extractor.build(match);
      const key = `${claim.type}|${Object.values(claim.values).join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claim.extractor = extractor.id;
      claim.source = meta.source || null;
      claim.span = match[0];
      claim.retrievedAt = meta.retrievedAt || new Date().toISOString();
      claims.push(claim);
    }
  }
  return claims;
}

/**
 * Oracle 1 -- faithfulness. Every slot value must occur in the cited span.
 *
 * Not a truth check. It proves Lari did not embellish; it says nothing about whether the source is
 * right, and no caller may report it as though it did.
 */
function faithfulnessViolations(claim, sourceText) {
  const haystack = String(sourceText || '').toLowerCase();
  const violations = [];
  for (const [slot, value] of Object.entries(claim?.values || {})) {
    if (!haystack.includes(String(value).toLowerCase())) {
      violations.push({ kind: 'unsupported-by-source', slot, value: String(value) });
    }
  }
  return violations;
}

/**
 * Oracle 2 -- anti-recitation. The answer may not be a copy of the source.
 *
 * Compares content words only; function-word runs are English, not borrowed substance. This is the
 * check the conjugation skill would have failed, and the reason a store of pasted paragraphs cannot
 * accumulate here.
 */
function recitationViolations(text, sourceText, limit = RECITATION_LIMIT) {
  const answer = words(text).filter(w => !FUNCTION_WORDS.has(w));
  const source = words(sourceText).filter(w => !FUNCTION_WORDS.has(w));
  if (answer.length < limit || source.length < limit) return [];
  const runs = new Set();
  for (let i = 0; i + limit <= source.length; i += 1) runs.add(source.slice(i, i + limit).join(' '));
  const violations = [];
  for (let i = 0; i + limit <= answer.length; i += 1) {
    const run = answer.slice(i, i + limit).join(' ');
    if (runs.has(run)) violations.push({ kind: 'recited-from-source', run });
  }
  return violations;
}

/**
 * Oracle 3 -- extraction. A claim must carry at least two distinct slots.
 *
 * One slot is a keyword, not a proposition, and a store that accepts keywords fills with noise that
 * later reads as knowledge.
 */
function extractionViolations(claim) {
  const values = Object.values(claim?.values || {}).map(v => String(v).trim()).filter(Boolean);
  if (values.length < 2) return [{ kind: 'not-a-proposition', slots: values.length }];
  if (new Set(values.map(v => v.toLowerCase())).size < 2) {
    return [{ kind: 'degenerate-proposition', slots: values.length }];
  }
  return [];
}

/** Run every oracle over one candidate claim. */
function verifyResearchClaim(claim, sourceText, rules = RESEARCH_REALIZATION_RULES) {
  const faithfulness = faithfulnessViolations(claim, sourceText);
  const extraction = extractionViolations(claim);
  const text = realization.realizeClaims([claim], rules);
  const grounding = realization.groundingViolations(text, [claim]);
  const dropped = realization.unrealizedClaims(text, [claim], rules);
  const recitation = text ? recitationViolations(text, sourceText) : [];
  return {
    claim,
    text,
    faithfulness,
    extraction,
    grounding,
    dropped,
    recitation,
    ok: !faithfulness.length && !extraction.length && !grounding.length && !dropped.length
      && !recitation.length && Boolean(text),
    externalModelCalls: 0
  };
}

/**
 * Retain verified claims into `model.knowledge`, and only verified ones.
 *
 * Every entry carries its source and the span it came from, so a later answer can attribute it and a
 * later audit can re-run the oracles against the same span. Deduplicated on the proposition, so
 * researching the same page twice does not inflate the store.
 */
function retainResearchClaims(model, sourceText, meta = {}) {
  if (!model) return { retained: [], rejected: [], externalModelCalls: 0 };
  if (!meta.source) {
    // A claim without a source cannot be attributed or re-checked, and an unattributable assertion is
    // the failure this lane exists to prevent.
    return { retained: [], rejected: [{ reason: 'no source supplied' }], externalModelCalls: 0 };
  }
  model.knowledge = Array.isArray(model.knowledge) ? model.knowledge : [];
  const existing = new Set(model.knowledge.map(k => `${k.type}|${Object.values(k.values || {}).join('|')}`));

  const retained = [];
  const rejected = [];
  for (const claim of atomizeSource(sourceText, meta)) {
    const key = `${claim.type}|${Object.values(claim.values).join('|')}`;
    if (existing.has(key)) continue;
    const verdict = verifyResearchClaim(claim, sourceText);
    if (!verdict.ok) {
      rejected.push({
        type: claim.type,
        values: claim.values,
        faithfulness: verdict.faithfulness,
        extraction: verdict.extraction,
        recitation: verdict.recitation,
        grounding: verdict.grounding
      });
      continue;
    }
    existing.add(key);
    const entry = {
      schemaVersion: 1,
      type: claim.type,
      values: claim.values,
      source: meta.source,
      sourceTitle: meta.title || null,
      span: claim.span,
      extractor: claim.extractor,
      retrievedAt: claim.retrievedAt,
      verifiedBy: ['faithfulness', 'extraction', 'grounding', 'preservation', 'anti-recitation'],
      // Stated on every entry so no consumer can quote this as a truth claim by accident.
      verificationMeaning: 'faithful to the cited span; NOT independently verified as true'
    };
    model.knowledge.push(entry);
    retained.push(entry);
  }
  return { retained, rejected, externalModelCalls: 0 };
}

/** Retained claims whose slot values all appear in the question. */
function matchRetainedClaims(model, question) {
  const asked = new Set(words(question).filter(w => !FUNCTION_WORDS.has(w)));
  if (!asked.size) return [];
  const store = Array.isArray(model?.knowledge) ? model.knowledge : [];
  const scored = [];
  for (const entry of store) {
    const values = Object.values(entry.values || {});
    const hits = values.filter(v => words(v).some(w => asked.has(w))).length;
    if (hits > 0) scored.push({ entry, hits });
  }
  return scored.sort((a, b) => b.hits - a.hits).map(s => s.entry);
}

/**
 * Answer from retained research, or decline.
 *
 * `answered: false` is a first-class outcome and must stay that way. The point of this lane is that
 * Lari can say something days after the research ran *and* can say nothing when the store does not
 * support it.
 */
function answerFromResearch(model, question, rules = RESEARCH_REALIZATION_RULES) {
  const matches = matchRetainedClaims(model, question);
  if (!matches.length) {
    return { answered: false, reason: 'no retained claim supports an answer', claims: [] };
  }
  const top = matches.slice(0, 3);
  const claims = top.map(entry => ({ type: entry.type, values: entry.values }));
  const sources = [...new Set(top.map(entry => entry.source))];
  claims.push({ type: 'source_attribution', values: { source: sources.join(' and ') } });

  const text = realization.realizeClaims(claims, rules);
  const grounding = realization.groundingViolations(text, claims);
  const dropped = realization.unrealizedClaims(text, claims, rules);
  const recitation = top.flatMap(entry => recitationViolations(text, entry.span));
  if (grounding.length || dropped.length || recitation.length) {
    return {
      answered: false,
      reason: 'answer failed its own checks',
      grounding, dropped, recitation, claims
    };
  }
  return {
    answered: true,
    text,
    claims,
    sources,
    retrievedAt: top.map(e => e.retrievedAt),
    grounding: [], dropped: [], recitation: [],
    externalModelCalls: 0
  };
}

module.exports = {
  RECITATION_LIMIT,
  EXTRACTORS,
  RESEARCH_REALIZATION_RULES,
  atomizeSource,
  faithfulnessViolations,
  recitationViolations,
  extractionViolations,
  verifyResearchClaim,
  retainResearchClaims,
  matchRetainedClaims,
  answerFromResearch
};
