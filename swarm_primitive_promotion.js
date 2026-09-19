'use strict';

/**
 * Roadmap item 4 / phase E prerequisite: promoting shared structure to a primitive.
 *
 * Why this is the piece that makes capability compound
 * ----------------------------------------------------
 * The vocabulary has grown from 64 rules to 77 and every one of them is flat. Learning `+ -> -` teaches
 * nothing about `* -> //`. Accumulating rules one at a time is linear, and a linear learner needs a
 * curriculum proportional to the space it wants to cover. What makes growth super-linear is noticing
 * that many rules are instances of one thing, and storing the one thing.
 *
 * This is deliberately NOT `swarm_vocabulary_compression.js`. That module does schema promotion: it
 * reads a family's operator alphabet and expands to the closure, which makes the vocabulary *larger*
 * (5 rules became 20) and the search *more expensive*. Its own test said so. Useful for coverage,
 * useless for compounding, and it was honestly renamed to generalisation.
 *
 * This module goes the other way. It looks for structure shared *across families* and replaces many
 * rules with one parameterised primitive that is cheaper to store than what it subsumes.
 *
 * The automatic oracle, named before the capability, per rule 1
 * ------------------------------------------------------------
 * Three checks, all machine-decidable, and a promotion is refused unless all three pass:
 *
 *   1. PRESERVATION -- every rule the primitive claims to subsume must be regenerable from it, exactly.
 *      A primitive that loses a verified rule is a capability regression wearing an abstraction's
 *      clothes.
 *   2. COMPRESSION (MDL) -- the primitive plus its parameters must have a strictly smaller description
 *      length than the rules it replaces. This is the criterion the DreamCoder result rests on and it
 *      is the one that cannot be argued with: if the abstraction does not pay for itself in bits, it is
 *      decoration. `swarm_vocabulary_compression.js` grew from 5 to 6 and called it compression; this
 *      refuses to.
 *   3. NON-VACUITY -- a primitive must subsume at least MIN_SUBSUMED rules from at least two distinct
 *      families. One family's rules generalising to themselves is a rename, not an abstraction, and a
 *      primitive covering everything predicts nothing.
 *
 * What promotion does NOT do
 * --------------------------
 * It does not make the search cheaper, and nothing here should be quoted as if it did. Generating from
 * a primitive yields at least the rules it replaced. The claim is about what Lari can *learn next* --
 * a primitive carries evidence to pairings never tried -- and that claim is unmeasured until a
 * curriculum runs against it. Rule 12 applies: absence of a rule in the vocabulary is not evidence the
 * pairing is wrong, so a promoted primitive proposes candidates rather than asserting rules.
 */

/** A primitive must subsume at least this many rules, across at least two families, to be worth it. */
const MIN_SUBSUMED = 4;
const MIN_FAMILIES = 2;

/**
 * Description length in symbols, counted the same way for rules and for primitives.
 *
 * Deliberately crude and deliberately consistent: what matters is that both sides of the comparison are
 * measured by the same ruler, not that the ruler is principled information theory. A rule is its two
 * operand strings; a primitive is its name, its alphabet, and one index pair per subsumed rule.
 */
function describeLengthOfRules(rules) {
  return rules.reduce((total, rule) => total + rule.reduce((n, part) => n + String(part).trim().length + 1, 0), 0);
}

/** A primitive's name is a label paid once; charging its characters measures naming style, not structure. */
const PRIMITIVE_NAME_COST = 1;

function describeLengthOfPrimitive(primitive) {
  const alphabet = primitive.alphabet.reduce((n, symbol) => n + String(symbol).trim().length + 1, 0);
  // Each subsumed rule costs two indices into the alphabet rather than two whole operand strings.
  const indices = primitive.pairs.length * 2;
  // The first version charged String(primitive.name).length, which made a descriptive name cost 28
  // symbols and refused promotions on the strength of what the primitive was called. That measures the
  // author, not the abstraction.
  return PRIMITIVE_NAME_COST + alphabet + indices;
}

/**
 * Read a vocabulary and propose primitives over binary-operator substitution families.
 *
 * A family qualifies if its rules are all two-part substitutions of trimmed non-empty operands -- which
 * is what "replace this operator with that one" looks like as data. The alphabet is the union of every
 * operand seen across the qualifying families, so a primitive spans them.
 */
function proposePrimitives(vocabulary = {}) {
  const contributing = [];
  const alphabet = new Set();
  const pairs = [];

  for (const [family, entry] of Object.entries(vocabulary)) {
    const rules = (entry && entry.rules) || [];
    if (!rules.length) continue;
    const binary = rules.every(rule => Array.isArray(rule)
      && rule.length === 2
      && rule.every(part => String(part).trim().length > 0));
    if (!binary) continue;
    contributing.push(family);
    for (const [from, to] of rules) {
      alphabet.add(String(from).trim());
      alphabet.add(String(to).trim());
      pairs.push({ family, from: String(from).trim(), to: String(to).trim() });
    }
  }

  if (contributing.length < MIN_FAMILIES || pairs.length < MIN_SUBSUMED) return [];

  return [{
    name: 'binary-operator-substitution',
    alphabet: [...alphabet].sort(),
    families: contributing.sort(),
    pairs,
    // Spacing is part of a rule's identity in this engine (" + " is not "+"), so the primitive records
    // how to rebuild the padded form rather than assuming it.
    render: (from, to) => [` ${from} `, ` ${to} `]
  }];
}

/** Every rule a primitive claims to subsume, regenerated from it. */
function expandPrimitive(primitive) {
  return primitive.pairs.map(pair => primitive.render(pair.from, pair.to));
}

/**
 * Oracle 1 -- preservation. Every subsumed rule must come back out, exactly.
 *
 * Compared on trimmed operands, because the engine's rules carry padding that the primitive rebuilds
 * rather than stores. A rule that cannot be regenerated is reported by name.
 */
function preservationViolations(primitive, vocabulary) {
  const regenerated = new Set(expandPrimitive(primitive)
    .map(rule => rule.map(part => String(part).trim()).join('=>')));
  const missing = [];
  for (const family of primitive.families) {
    for (const rule of (vocabulary[family] && vocabulary[family].rules) || []) {
      const key = rule.map(part => String(part).trim()).join('=>');
      if (!regenerated.has(key)) missing.push({ family, rule: key });
    }
  }
  return missing;
}

/** Oracle 2 -- MDL. The abstraction must pay for itself in symbols. */
function compressionOf(primitive, vocabulary) {
  const subsumed = primitive.families.flatMap(family => (vocabulary[family] && vocabulary[family].rules) || []);
  const before = describeLengthOfRules(subsumed);
  const after = describeLengthOfPrimitive(primitive);
  return { before, after, saved: before - after, compresses: after < before, rulesSubsumed: subsumed.length };
}

/** Oracle 3 -- non-vacuity. */
function vacuityViolations(primitive) {
  const problems = [];
  if (primitive.pairs.length < MIN_SUBSUMED) {
    problems.push({ kind: 'too-few-rules', subsumed: primitive.pairs.length, required: MIN_SUBSUMED });
  }
  if (new Set(primitive.families).size < MIN_FAMILIES) {
    problems.push({ kind: 'single-family', families: primitive.families });
  }
  if (primitive.alphabet.length < 2) {
    problems.push({ kind: 'degenerate-alphabet', alphabet: primitive.alphabet });
  }
  return problems;
}

/**
 * Promote, or refuse and say which oracle refused.
 *
 * Refusal is the common case and must stay cheap to reach. A vocabulary with no shared structure should
 * produce no primitives rather than a bad one.
 */
function promote(vocabulary = {}) {
  const accepted = [];
  const rejected = [];
  for (const primitive of proposePrimitives(vocabulary)) {
    const preservation = preservationViolations(primitive, vocabulary);
    const vacuity = vacuityViolations(primitive);
    const compression = compressionOf(primitive, vocabulary);
    if (preservation.length || vacuity.length || !compression.compresses) {
      rejected.push({ name: primitive.name, preservation, vacuity, compression });
      continue;
    }
    accepted.push({ ...primitive, compression });
  }
  return { accepted, rejected, externalModelCalls: 0 };
}

/**
 * Pairings the primitive can express that the vocabulary has never verified.
 *
 * These are CANDIDATES, never rules. The whole discipline of this repository says an unverified
 * proposal is a hypothesis: it has to survive the upstream test suite before it is retained, exactly
 * like a grown mutation rule. Returning them as rules would be inventing capability, which is the
 * failure rule 12 describes.
 */
function proposeUntriedPairings(primitive, vocabulary) {
  const known = new Set();
  for (const family of primitive.families) {
    for (const rule of (vocabulary[family] && vocabulary[family].rules) || []) {
      known.add(rule.map(part => String(part).trim()).join('=>'));
    }
  }
  const untried = [];
  for (const from of primitive.alphabet) {
    for (const to of primitive.alphabet) {
      if (from === to) continue;
      if (known.has(`${from}=>${to}`)) continue;
      untried.push({ rule: primitive.render(from, to), status: 'candidate', verified: false });
    }
  }
  return untried;
}

module.exports = {
  MIN_SUBSUMED,
  MIN_FAMILIES,
  describeLengthOfRules,
  describeLengthOfPrimitive,
  proposePrimitives,
  expandPrimitive,
  preservationViolations,
  compressionOf,
  vacuityViolations,
  promote,
  proposeUntriedPairings
};
