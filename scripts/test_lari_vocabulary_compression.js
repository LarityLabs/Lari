#!/usr/bin/env node
'use strict';

/**
 * Regression test for schema promotion.
 *
 * NOT a capability gate. It runs no search and no oracle; it checks that promotion preserves what was
 * verified and refuses when it cannot. It must never be quoted as a repair score.
 *
 * The expensive mistake this guards is silent loss. Promotion replaces a family's rule list wholesale,
 * and the rule count goes *up*, so a promotion that dropped a verified rule would look like progress
 * on every summary statistic while deleting capability that cost real verification to acquire.
 *
 * Usage: node scripts/test_lari_vocabulary_compression.js
 */

const path = require('path');
const compression = require(path.join(__dirname, '..', 'swarm_vocabulary_compression.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

console.log('vocabulary compression');

// The real grown arithmetic family from leap-after.json.
const grown = {
  'arithmetic-substitution': {
    kind: 'operator-substitution',
    rules: [[' // ', ' % '], [' // ', ' + '], [' + ', ' - '], [' + ', ' * '], [' - ', ' + ']]
  },
  'unary-negation': {
    kind: 'operator-substitution',
    rules: [['if ', 'if not '], ['not ', '']]
  },
  'numeric-constant': { kind: 'numeric-constant', rules: [] }
};

const result = compression.compressVocabulary(grown);
const arithmetic = result.vocabulary['arithmetic-substitution'];
const key = rule => `${rule[0]} ${rule[1]}`;
const present = new Set(arithmetic.rules.map(key));

check('the alphabet is read off the rules, not supplied',
  result.schemas[0].alphabet.sort().join(',') === '%,*,+,-,//',
  result.schemas[0].alphabet.join(','));

check('every verified rule survives promotion',
  grown['arithmetic-substitution'].rules.every(rule => present.has(key(rule))));

check('five learned rules become the twenty-rule closure', arithmetic.rules.length === 20,
  String(arithmetic.rules.length));

// The point of the exercise: pairings no defect ever forced, now reachable.
check('a pairing never learned is now present', present.has(key([' * ', ' // '])));
check('and another', present.has(key([' % ', ' * '])));

// What promotion actually buys at this stage, stated as the test rather than as a hope.
//
// The first version of this assertion claimed description length falls. It does not: five learned
// rules become one schema plus a five-operator alphabet, so the description goes from five items to
// six. Coverage quadruples and the description grows slightly. Calling that "compression" was wrong,
// and the assertion is now what the numbers support.
check('coverage expands fourfold', result.stats.rulesAfter === 22 && result.stats.newPairings === 15,
  `rules ${result.stats.rulesBefore}->${result.stats.rulesAfter}, new ${result.stats.newPairings}`);

check('description length does NOT yet fall, and the stats say so',
  result.stats.descriptionAfter === 6 && result.stats.descriptionBefore === 5,
  `${result.stats.descriptionBefore}->${result.stats.descriptionAfter}`);

// Compression arrives only once a family knows more rules than its alphabet has members. Asserted on
// a synthetic family so the crossover is pinned rather than assumed.
const dense = { d: { kind: 'operator-substitution', rules: [] } };
const ops = [' + ', ' - ', ' * ', ' // ', ' % '];
for (const from of ops) for (const to of ops) if (from !== to && dense.d.rules.length < 15) dense.d.rules.push([from, to]);
const denseResult = compression.compressVocabulary(dense);
check('a family with more rules than operators does compress',
  denseResult.stats.descriptionAfter < denseResult.stats.descriptionBefore,
  `${denseResult.stats.descriptionBefore}->${denseResult.stats.descriptionAfter}`);

// unary-negation inserts and removes text rather than exchanging set members. A closure over its
// "alphabet" would invent rules nothing verified.
check('non-substitution families are left alone',
  result.vocabulary['unary-negation'].rules.length === 2
  && result.skipped.some(item => item.family === 'unary-negation'));

check('families with no rules are left alone',
  result.skipped.some(item => item.family === 'numeric-constant'));

// A family whose rules span only two operators implies nothing beyond what it already has.
const tiny = compression.compressVocabulary({
  't': { kind: 'operator-substitution', rules: [[' + ', ' - '], [' - ', ' + ']] }
});
check('a two-operator family is not promoted', tiny.schemas.length === 0);

// The refusal path: if a closure somehow failed to cover an original rule, promotion must be declined
// rather than applied.
const preservation = compression.verifyPreservation(
  [[' + ', ' - '], [' ^ ', ' & ']], [[' + ', ' - ']]);
check('preservation check catches a dropped rule', preservation.preserved === false
  && preservation.missing.length === 1);

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
