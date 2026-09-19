'use strict';

/**
 * Lari's first realization lane: saying what it did, from its own executable state.
 *
 * Why this exists
 * ---------------
 * Lari has no text generator. What it has is roughly fifteen hardcoded strings, some regular
 * expressions and a retrieval path -- which is why the standing table says "no generator" and why the
 * paper's differentiator is unfinished. The objection has never been to Lari being able to speak; it
 * is to Lari being a wrapper around someone else's model. So the generator has to be made of Lari's
 * own state.
 *
 * Repair provenance is the place to start, because the claim graph already exists. Every verified
 * repair records which family won, which substitution, at which line, how many candidates were tried,
 * what the oracle did and whether the patch matched upstream. Nothing has to be invented to describe
 * it -- only selected, ordered and realized.
 *
 * The automatic oracle, named before the capability, per rule 1
 * ------------------------------------------------------------
 * A generator without a verifier is how this repository ended up storing gold answers once already.
 * Three checks, all machine-decidable, none of them a judgement about prose:
 *
 *   1. Grounding -- every number and every quoted identifier in the output must appear in the claims
 *      it was realized from. Nothing enters the text that did not come from the record.
 *   2. Proposition preservation -- every claim handed in must be realized. The generator may not
 *      quietly drop what it found inconvenient to say.
 *   3. Non-fabrication -- asserted adversarially: corrupt a claim or inject a sentence and the check
 *      must fail. A verifier that cannot fail is decoration.
 *
 * What this is not
 * ----------------
 * Not a language model, and not fluent prose. It is a grounded realizer: claims are typed data,
 * realization rules are data too, and the text is composed from the graph rather than interpolated
 * into a fixed paragraph. That distinction is the whole point -- a template would be the fifteen
 * hardcoded strings again with extra steps. Because the rules are data, they can later be proposed
 * and verified the same way mutation rules are, which is the path from this to a voice.
 */

/**
 * Realization rules, as data rather than as source literals.
 *
 * Same design decision as the mutation vocabulary: a rule Lari proposes at runtime participates on
 * exactly the same footing as one shipped here. `slots` names the claim fields a rule consumes, which
 * is what lets the grounding check know which values were licensed.
 */
/**
 * Morphology, so realization rules do not each have to remember English.
 *
 * "a AOR defect", "1 candidates", "ran 1 times" -- agreement errors make a grounded sentence read
 * like a template, which is precisely the thing this lane exists not to be. These are general over
 * any slot value, so a rule proposed at runtime inherits them for free.
 */
const article = word => (/^[aeiouAEIOU]/.test(String(word)) ? 'an' : 'a');
const plural = (count, one, many) => (Number(count) === 1 ? one : (many || `${one}s`));
const times = count => (Number(count) === 1 ? 'once' : `${count} times`);

const DEFAULT_REALIZATION_RULES = {
  outcome_repaired: {
    slots: ['operator', 'file', 'line'],
    say: c => `I repaired ${article(c.operator)} ${c.operator} defect in ${c.file} at line ${c.line}.`
  },
  outcome_unrepaired: {
    slots: ['operator', 'file', 'line'],
    say: c => `I could not repair the ${c.operator} defect in ${c.file} at line ${c.line}.`
  },
  outcome_repaired_unlocated: {
    slots: ['operator', 'instance'],
    say: c => `I repaired ${article(c.operator)} ${c.operator} defect, recorded as ${c.instance}.`
  },
  outcome_unrepaired_unlocated: {
    slots: ['operator', 'instance'],
    say: c => `I could not repair the ${c.operator} defect recorded as ${c.instance}.`
  },
  rule_applied: {
    slots: ['family', 'description'],
    say: c => `The fix came from my ${c.family} family, substituting ${c.description}.`
  },
  rule_grown: {
    slots: ['grownRule'],
    say: c => `That rule was not in my vocabulary before: I proposed ${c.grownRule} and kept it after it passed.`
  },
  search_cost: {
    slots: ['verifications', 'candidateCount', 'budget'],
    say: c => `I tried ${c.verifications} ${plural(c.verifications, 'candidate')} of ${c.candidateCount} generated, against a budget of ${c.budget}.`
  },
  search_exhausted: {
    slots: ['verifications', 'budget'],
    say: c => `I exhausted the search, spending all ${c.verifications} of my ${c.budget} allowed verifications.`
  },
  localization: {
    slots: ['coveredLineCount', 'coverageSelector'],
    say: c => `I narrowed the search to the ${c.coveredLineCount} ${plural(c.coveredLineCount, 'line')} the failing tests executed, selected by ${c.coverageSelector}.`
  },
  localization_missed: {
    slots: [],
    say: () => 'The defective line was not among the lines coverage reported, so my localization was working against me.'
  },
  oracle: {
    slots: ['fullSuiteRuns'],
    say: c => `Acceptance required the project's own suite, which I ran ${times(c.fullSuiteRuns)}.`
  },
  fidelity_exact: {
    slots: [],
    say: () => 'The patch is upstream\'s own text.'
  },
  fidelity_equivalent: {
    slots: ['repairedLine'],
    say: c => `The patch passes the suite without matching upstream's text; I wrote "${c.repairedLine}".`
  },
  halting_cost: {
    slots: ['nonHaltingCandidates'],
    say: c => `${c.nonHaltingCandidates} ${plural(c.nonHaltingCandidates, 'candidate')} never terminated and ${plural(c.nonHaltingCandidates, 'was', 'were')} cut off.`
  }
};

/**
 * Turn a repair record into typed claims.
 *
 * A claim is a fact with a name and the fields it licenses. Selection happens here and nowhere else,
 * so what the text may contain is decided by data rather than by phrasing.
 */
function atomizeRepairRecord(record = {}) {
  const claims = [];
  const add = (type, values) => claims.push({ type, values });

  // Locations are read, never reconstructed.
  //
  // The first version of this derived a filename from the instance identifier by turning underscores
  // into slashes, and produced "wcwidth/escape/sequences.py" for a file called escape_sequences.py.
  // Grounding passed it, because grounding compares the text against the claims and the claim itself
  // was already wrong. A generator that infers facts will eventually infer a false one, and the whole
  // argument for this lane is that it does not have to: the record either says where the defect was or
  // it does not.
  const file = record.targetFile || record.file || null;
  const line = record.line ?? null;

  if (file && line !== null) {
    add(record.repaired ? 'outcome_repaired' : 'outcome_unrepaired', {
      operator: record.operator || 'defect', file, line
    });
  } else {
    add(record.repaired ? 'outcome_repaired_unlocated' : 'outcome_unrepaired_unlocated', {
      operator: record.operator || 'defect', instance: record.instance || 'an unnamed instance'
    });
  }

  if (record.repaired && record.family) {
    add('rule_applied', { family: record.family, description: record.description || 'an unnamed substitution' });
  }
  if (record.grewVocabulary?.rule) {
    add('rule_grown', { grownRule: record.grewVocabulary.rule.map(part => String(part).trim() || '(nothing)').join(' -> ') });
  }
  if (record.repaired) {
    add('search_cost', {
      verifications: record.verifications, candidateCount: record.candidateCount, budget: record.budget
    });
  } else if (Number(record.verifications) > 0) {
    add('search_exhausted', { verifications: record.verifications, budget: record.budget });
  }
  if (Number(record.coveredLineCount) > 0) {
    add('localization', { coveredLineCount: record.coveredLineCount, coverageSelector: record.coverageSelector });
  }
  if (record.targetLineCovered === false) add('localization_missed', {});
  if (Number(record.fullSuiteRuns) >= 0 && record.repaired) {
    add('oracle', { fullSuiteRuns: record.fullSuiteRuns });
  }
  if (record.repaired && record.restoresUpstreamExactly === true) add('fidelity_exact', {});
  if (record.repaired && record.restoresUpstreamExactly === false) {
    add('fidelity_equivalent', { repairedLine: record.repairedLine });
  }
  if (Number(record.nonHaltingCandidates) > 0) {
    add('halting_cost', { nonHaltingCandidates: record.nonHaltingCandidates });
  }
  return claims;
}

/** Realize claims as text, in the order given. Unknown claim types are skipped, never invented. */
function realizeClaims(claims = [], rules = DEFAULT_REALIZATION_RULES) {
  const said = [];
  for (const claim of claims) {
    const rule = rules[claim.type];
    if (!rule) continue;
    said.push(String(rule.say(claim.values)).trim());
  }
  return said.join(' ');
}

/**
 * Every number and quoted identifier the claims license.
 *
 * Grounding is decided against this set, so a value that never appeared in a record cannot appear in
 * the text without being caught.
 */
function licensedTokens(claims = []) {
  const licensed = new Set();
  for (const claim of claims) {
    for (const value of Object.values(claim.values || {})) {
      const text = String(value);
      licensed.add(text);
      for (const number of text.matchAll(/\d+/g)) licensed.add(number[0]);
      for (const word of text.matchAll(/[A-Za-z_][\w./-]*/g)) licensed.add(word[0]);
      // Quoted spans inside a value are licensed too.
      //
      // A claim value can itself contain quotes -- an execution claim's expression is
      // `intword("not a number", "%.99f")`, and realizing it puts those quotes in the text, where the
      // quotation check then demanded they be licensed. They were not, because the word-level pass
      // only licenses single tokens and `not a number` has spaces. Every call taking a string argument
      // was unclaimable as a result. This only ever adds spans that literally occur inside a claim
      // value, so nothing can be licensed that the claims did not already carry.
      for (const quoted of text.matchAll(/"([^"]*)"/g)) licensed.add(quoted[1]);
      for (const quoted of text.matchAll(/'([^']*)'/g)) licensed.add(quoted[1]);
    }
  }
  return licensed;
}

/**
 * Check a realization against the claims it came from.
 *
 * Only numbers and quoted spans are checked. Function words are the realization rules' own vocabulary
 * and are not facts about anything; requiring them to be licensed would make every sentence a
 * violation and the check useless.
 */
function groundingViolations(text, claims = []) {
  const licensed = licensedTokens(claims);
  const violations = [];
  for (const number of String(text).matchAll(/\b\d+\b/g)) {
    if (!licensed.has(number[0])) violations.push({ kind: 'ungrounded-number', token: number[0] });
  }
  for (const quoted of String(text).matchAll(/"([^"]*)"/g)) {
    if (!licensed.has(quoted[1])) violations.push({ kind: 'ungrounded-quotation', token: quoted[1] });
  }
  return violations;
}

/** Claims that were handed in and never said. The generator may not drop what it found awkward. */
function unrealizedClaims(text, claims = [], rules = DEFAULT_REALIZATION_RULES) {
  const dropped = [];
  for (const claim of claims) {
    const rule = rules[claim.type];
    if (!rule) { dropped.push({ type: claim.type, reason: 'no realization rule' }); continue; }
    const fragment = String(rule.say(claim.values)).trim();
    if (!String(text).includes(fragment)) dropped.push({ type: claim.type, reason: 'not present in output' });
  }
  return dropped;
}

/**
 * Every claim value must be a value the record actually contains.
 *
 * The fourth check, and the one the first version was missing. Grounding compares text against
 * claims, so a claim that was wrong before realization began sailed through: a filename derived from
 * an instance identifier produced "wcwidth/escape/sequences.py", a path that does not exist, and every
 * check passed. Verifying text against claims only proves the realizer is faithful to what it was
 * told. This proves it was told the truth.
 *
 * Compared as strings against the record's own leaf values, so a derived value has to be assembled
 * from real ones rather than invented.
 */
function claimProvenanceViolations(claims = [], record = {}) {
  const known = new Set();
  const collect = value => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (typeof value === 'object') { Object.values(value).forEach(collect); return; }
    const text = String(value);
    known.add(text);
    known.add(text.trim());
  };
  collect(record);

  const violations = [];
  for (const claim of claims) {
    for (const [field, value] of Object.entries(claim.values || {})) {
      const text = String(value);
      if (known.has(text)) continue;
      // Derived forms are allowed only when every part came from the record.
      const parts = text.split(/\s*->\s*|\s+/).filter(Boolean);
      if (parts.length > 1 && parts.every(part => known.has(part) || known.has(part.replace(/[.,;]$/, '')))) continue;
      violations.push({ claim: claim.type, field, value: text });
    }
  }
  return violations;
}

/**
 * Propose ways to say a claim type nothing knows how to say yet.
 *
 * The same shape as vocabulary growth in the repair engine, pointed at language: when a claim arrives
 * with no realization rule, compose candidate phrasings from the slots the claim actually carries,
 * test each against the oracle, and retain the first that survives. What is retained is keyed on the
 * claim *type*, so it applies to every future claim of that type -- a rule, not a sentence about one
 * record, which is the same distinction that keeps the mutation vocabulary from being a lookup table.
 *
 * Proposals can only refer to slots present in the claim. That is what makes grounding hold by
 * construction rather than by luck: there is no way to phrase a fact the claim does not carry.
 */
function proposeRealizationRules(claim) {
  const slots = Object.keys(claim?.values || {});
  if (!slots.length) return [];
  const label = String(claim.type).replace(/_/g, ' ');
  const say = build => ({ slots, say: build, proposedFor: claim.type });

  const proposals = [
    // Subject-verb-object over every slot, which is the safest general shape.
    say(c => `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${slots.map(s => `${s} ${c[s]}`).join(', ')}.`),
    // A more natural reading when there is exactly one slot.
    slots.length === 1
      ? say(c => `My ${label} was ${c[slots[0]]}.`)
      : say(c => `My ${label} was ${slots.map(s => `${c[s]} ${s}`).join(' and ')}.`),
    // Last resort: name the values only, which still has to satisfy preservation.
    say(c => `${label}: ${slots.map(s => c[s]).join(' / ')}.`)
  ];
  return proposals;
}

/**
 * Learn a phrasing for an unknown claim type, or decline to say anything.
 *
 * Retention requires the same four properties any explanation must have, plus coverage: a phrasing
 * that quietly omits a slot would pass grounding by saying less, so it is rejected. Declining is a
 * legitimate outcome -- a generator that always produces something is how fabrication starts.
 */
function growRealizationRule(claim, rules = DEFAULT_REALIZATION_RULES, record = null) {
  for (const proposal of proposeRealizationRules(claim)) {
    const trial = { ...rules, [claim.type]: proposal };
    const text = realizeClaims([claim], trial);
    if (!text) continue;
    if (groundingViolations(text, [claim]).length) continue;
    if (unrealizedClaims(text, [claim], trial).length) continue;
    if (record && claimProvenanceViolations([claim], record).length) continue;
    // Coverage: every slot value must actually appear, or the rule is saying less than it was given.
    const coversEverySlot = Object.values(claim.values)
      .every(value => text.includes(String(value)));
    if (!coversEverySlot) continue;
    return { learned: true, claimType: claim.type, rule: proposal, text };
  }
  return { learned: false, claimType: claim.type, rule: null, text: '' };
}

/** Realize and verify in one step. `ok` is false if any check fails. */
function explainRepair(record, rules = DEFAULT_REALIZATION_RULES) {
  const claims = atomizeRepairRecord(record);
  const text = realizeClaims(claims, rules);
  const grounding = groundingViolations(text, claims);
  const dropped = unrealizedClaims(text, claims, rules);
  const provenance = claimProvenanceViolations(claims, record);
  return {
    text,
    claims,
    grounding,
    dropped,
    provenance,
    ok: grounding.length === 0 && dropped.length === 0 && provenance.length === 0,
    externalModelCalls: 0
  };
}

module.exports = {
  DEFAULT_REALIZATION_RULES,
  atomizeRepairRecord,
  realizeClaims,
  licensedTokens,
  groundingViolations,
  claimProvenanceViolations,
  unrealizedClaims,
  explainRepair,
  proposeRealizationRules,
  growRealizationRule
};
