'use strict';

/**
 * The generator's missing wire: claims become sentences built from verified English.
 *
 * Two halves existed and were never connected
 * -------------------------------------------
 * `swarm_claim_realization.js` turns typed claims into text, stores realization rules as data, and can
 * propose and verify new phrasings. What it lacks is English: every rule is a hand-written `say:`
 * function, so "growing a phrasing" means mashing slot values into a template someone typed.
 *
 * Computational English ships the other half -- 142,650 lexemes, 37 rules each scored on independent
 * treebanks, and `compose()`, which assembles a phrase from its parts and CHECKS the agreement
 * constraints while doing it. Measured on 2026-08-01, CE was consumed by exactly one file in this
 * repository: `swarm_language_rules.js`, the grammar-induction lane, which is at its ceiling and gated
 * off. **Nothing called `compose()`.**
 *
 * Lari had propositions and no grammar. CE had grammar and no propositions.
 *
 * What this changes
 * -----------------
 * A realization rule stops being a string template and becomes a *specification* -- which phrase type,
 * which slots, which features -- and CE builds the surface form. The difference is not cosmetic:
 *
 *   - agreement is checked by a verified rule rather than by whoever wrote the template
 *   - a phrasing proposed at runtime is composed from attested structure instead of concatenation
 *   - the same claim can be realized with different determiners, number or modifiers without a new
 *     hand-written rule for each
 *
 * What it does NOT change: every output still passes the grounding oracle in
 * `swarm_claim_realization.js`. Composition decides *how* something is said. Whether it may be said at
 * all is still decided by the claims, and a composed sentence that fails grounding is refused exactly
 * like a templated one. CE is a source of grammar, never a source of facts -- it is data, not a model,
 * which is what keeps this inside VISION.md §3.
 *
 * Degrades to nothing. If CE is absent or a phrase type is unavailable, `composeFromClaim` returns null
 * and the caller keeps its existing rule. A generator that hard-fails when a dependency is missing is
 * worse than one that stays where it was.
 */

let ce = null;
try { ce = require('computational-english'); } catch (e) { ce = null; }

/** Is the composed grammar layer available at all? */
function available() {
  return Boolean(ce && typeof ce.compose === 'function');
}

/**
 * Compose a noun phrase for a claim slot, with number taken from the value rather than assumed.
 *
 * `count` is the thing that makes this worth doing: "1 rule" and "5 rules" are the same specification
 * with a different feature, where a template needs a conditional every time.
 */
function composeNounPhrase({ head, determiner = null, adjective = null, count = null }) {
  if (!available() || !head) return null;
  const parts = { HEAD: String(head) };
  if (determiner) parts.det = String(determiner);
  if (adjective) parts.amod = String(adjective);
  const plural = count !== null && Number(count) !== 1;
  try {
    const composed = ce.compose('noun-phrase', parts, plural ? { features: { HEAD: 'PL' } } : {});
    if (!composed || composed.error || !composed.text) return null;
    // A composed phrase whose own agreement check failed is not usable, whatever it looks like.
    const failed = (composed.checks || []).filter(check => check.satisfied === false);
    if (failed.length) return null;
    return { text: composed.text, checks: composed.checks || [] };
  } catch (error) {
    return null;
  }
}

/**
 * Build a realization rule that composes instead of interpolating.
 *
 * `spec(values)` returns the noun-phrase parts for a claim's values. The returned rule has the same
 * shape as any rule in `DEFAULT_REALIZATION_RULES`, so it participates on exactly the same footing --
 * including being refused by the grounding oracle if it says something the claim does not license.
 */
function composedRule({ slots, spec, frame }) {
  return {
    slots,
    composed: true,
    say: (values) => {
      const phrase = composeNounPhrase(spec(values));
      // No composition, no sentence. The caller falls back to its existing rule rather than emitting
      // a half-composed string.
      if (!phrase) return '';
      return frame(phrase.text, values);
    }
  };
}

/**
 * Realization rules for self-knowledge claims, composed rather than templated.
 *
 * These deliberately mirror rules that already exist as hand-written templates, so the two can be
 * compared on the same claims: same propositions, one interpolated and one composed, both gated by the
 * same oracle. That comparison is the evidence that this is an improvement rather than a rewrite.
 */
const COMPOSED_REALIZATION_RULES = {
  self_grown_count: composedRule({
    slots: ['grownCount'],
    spec: values => ({ head: 'rule', count: values.grownCount, adjective: 'new' }),
    frame: (phrase, values) => `I have learned ${values.grownCount} ${phrase} that were not in my original vocabulary.`
  }),
  self_vocabulary: composedRule({
    slots: ['families', 'ruleCount'],
    spec: values => ({ head: 'family', count: values.families }),
    frame: (phrase, values) => `I repair defects using ${values.ruleCount} substitution rules across ${values.families} ${phrase}.`
  })
};

/**
 * Realize claims with composition where it is available, and with the existing rules everywhere else.
 *
 * Per-claim rather than all-or-nothing: a claim CE can compose for is composed, and one it cannot is
 * left to the template. That keeps the change additive and means a missing phrase type costs one
 * sentence's polish rather than the whole answer.
 */
function realizationRulesWithComposition(baseRules) {
  if (!available()) return baseRules;
  const merged = { ...baseRules };
  for (const [claimType, rule] of Object.entries(COMPOSED_REALIZATION_RULES)) {
    const fallback = baseRules[claimType];
    merged[claimType] = {
      ...rule,
      say: (values) => {
        const composed = rule.say(values);
        if (composed) return composed;
        return fallback ? fallback.say(values) : '';
      }
    };
  }
  return merged;
}

module.exports = {
  available,
  composeNounPhrase,
  composedRule,
  COMPOSED_REALIZATION_RULES,
  realizationRulesWithComposition
};
