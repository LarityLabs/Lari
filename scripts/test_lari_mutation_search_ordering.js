#!/usr/bin/env node
'use strict';

/**
 * Regression test for the search-budget bug that made learned priors inert.
 *
 * NOT a capability gate. It uses a synthetic file and a fake oracle, so it can only ever say that the
 * search reaches a candidate it is supposed to reach. It cannot fail for capability reasons and must
 * never be quoted as a repair score.
 *
 * The bug: `limit` was used both as the number of candidates to generate and as the number of oracle
 * runs to spend. Generation walks the localized region line by line, so the cut fell by line position
 * before the priors could see the list; ordering then permuted only the survivors. On the wcwidth
 * transfer set the winning candidate sat at authored position 356 of a 580-candidate pool, so an
 * 80-run budget never generated it and the priors changed nothing.
 *
 * What this asserts:
 *   1. With priors, a candidate beyond the verification budget in authored order is tried within it.
 *   2. The number of verifications never exceeds the budget -- the pool must not cost oracle runs.
 *   3. Without priors, behaviour is byte-identical to before the fix, so recorded scores stay
 *      comparable.
 *
 * Usage: node scripts/test_lari_mutation_search_ordering.js
 */

const path = require('path');
const mutationRepair = require(path.join(__dirname, '..', 'swarm_mutation_repair.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

/**
 * A file whose defect is deep enough that authored-order generation cannot reach it within budget.
 *
 * Every filler line offers comparison-boundary substitutions, which is what consumes the budget in a
 * real run; the defective line is the last one and needs an arithmetic substitution.
 */
function buildFixture(fillerLines) {
  const lines = ['def compute(values, width):'];
  for (let i = 0; i < fillerLines; i += 1) {
    lines.push(`    if values[${i}] < width and values[${i}] > 0: pass`);
  }
  lines.push('    return width - len(values)');   // defect: should be '+'
  const source = lines.join('\n');
  const repaired = source.replace('width - len(values)', 'width + len(values)');
  return { source, repaired, defectLine: lines.length };
}

const BUDGET = 20;
// Eight filler lines put the winner at authored position 168 of a 169-candidate pool: far outside a
// 20-run budget, and inside the 200-candidate pool the fix builds. The same shape as the real case
// (356 of 580), which is the point -- a fixture the fix cannot reach either would prove nothing.
//
// Recalibrated when numeric-constant learned to mutate repeated occurrences, which raised candidate
// density per line. The premise checks below fail loudly if this drifts again.
const { source, repaired } = buildFixture(8);

// The whole file is the region: no failing-test text is available here, and localization is not what
// this test is about.
const wholeFile = { source, language: 'python', testSource: '', failureText: '', targetRelative: 'compute.py' };

// The vocabulary a curriculum would have grown: seed families plus one arithmetic rule.
const vocabulary = JSON.parse(JSON.stringify(mutationRepair.DEFAULT_VOCABULARY));
vocabulary['arithmetic-substitution'] = { kind: 'operator-substitution', rules: [[' - ', ' + ']] };

// Priors of the shape lariMutationFamilyPriors returns: the arithmetic substitution has earned its
// place, the seed families have not been tried here.
const familyPriors = {
  'arithmetic-substitution': { attempts: 10, successes: 10 },
  'arithmetic-substitution:- -> +': { attempts: 9, successes: 9 }
};

// The share is passed explicitly, because the shipped default is 0: priors are recorded but not
// spent, after two sealed sets measured them losing an instance and none measured them winning one.
// This test is about whether the mechanism works when a caller asks for it, which is a different
// question from whether it should be on.
function run({ priors, share }) {
  const shareArgs = share === undefined ? {} : { priorBudgetShare: share };
  let verifications = 0;
  const outcome = mutationRepair.repairByVerifiedMutation({
    ...wholeFile,
    limit: BUDGET,
    vocabulary,
    familyPriors: priors,
    ...shareArgs,
    verify(patched) {
      verifications += 1;
      return { passed: patched === repaired };
    }
  });
  return { outcome, verifications };
}

console.log('mutation search ordering');

// Establish the premise: the winning candidate really is out of reach in authored order. If this ever
// stops holding the test below proves nothing, so it is asserted rather than assumed.
const regions = mutationRepair.localizeRegions({ ...wholeFile, testNames: [], coveredLines: [] });
const authored = mutationRepair.generateCandidates({ source, language: 'python', regions, limit: 100000, vocabulary });
const authoredIndex = authored.findIndex(candidate => candidate.source === repaired);
check('fixture premise: winner exists in the pool', authoredIndex >= 0, `index ${authoredIndex}`);
check('fixture premise: winner is beyond the budget in authored order',
  authoredIndex >= BUDGET, `authored index ${authoredIndex}, budget ${BUDGET}`);

const withPriors = run({ priors: familyPriors, share: 0.5 });
check('priors reach a candidate outside the authored budget',
  withPriors.outcome.repaired === true,
  `repaired=${withPriors.outcome.repaired} after ${withPriors.verifications} verifications`);
check('priors credit the family that actually won',
  withPriors.outcome.family === 'arithmetic-substitution',
  `family=${withPriors.outcome.family}`);
check('the wider pool costs no extra oracle runs',
  withPriors.verifications <= BUDGET,
  `${withPriors.verifications} verifications for a budget of ${BUDGET}`);
check('the pool is reported, so a run records what it searched',
  Number(withPriors.outcome.pooledCount) > BUDGET,
  `pooledCount=${withPriors.outcome.pooledCount}`);

// The shipped default must not spend budget on priors. Asserted rather than assumed, because it is a
// decision made on measured evidence and a silent change back would be invisible in every score.
const atDefaultShare = run({ priors: familyPriors, share: undefined });
check('priors are not spent at the default share',
  atDefaultShare.outcome.repaired === false,
  `repaired=${atDefaultShare.outcome.repaired} -- the default share is meant to be 0`);

const withoutPriors = run({ priors: null });
check('without priors the budget still bounds generation',
  withoutPriors.verifications <= BUDGET && Number(withoutPriors.outcome.pooledCount) <= BUDGET,
  `verifications=${withoutPriors.verifications} pooledCount=${withoutPriors.outcome.pooledCount}`);
check('without priors the deep candidate stays out of reach, as previously recorded runs assumed',
  withoutPriors.outcome.repaired === false,
  `repaired=${withoutPriors.outcome.repaired}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
