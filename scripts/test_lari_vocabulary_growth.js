#!/usr/bin/env node
'use strict';

/**
 * Regression test for the growth-budget defect.
 *
 * NOT a capability gate: synthetic source, fake oracle, no repository. It cannot fail for capability
 * reasons and must never be quoted as a repair score.
 *
 * What it protects. Vocabulary growth is the differentiator of this project, and it silently stopped
 * working on any file large enough to matter. Each proposal used to get its own budget of 20
 * candidates, which sufficed on a 400-line module and failed on a 2,901-line one: restricted to a
 * single family the whole pool is only 79 candidates, but the winners sat at positions 25 and 47. A
 * 150-defect curriculum on tabulate produced ten defects whose repair needed an absent rule, failed
 * all ten, and grew nothing -- while the proposals themselves were correct the whole time. Nothing in
 * the output said "budget"; it just looked like growth not working.
 *
 * Usage: node scripts/test_lari_vocabulary_growth.js
 */

const path = require('path');
const mutationRepair = require(path.join(__dirname, '..', 'swarm_mutation_repair.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

/**
 * A defect whose repair needs a rule the vocabulary does not have, placed deep enough in the file
 * that a small per-proposal budget cannot reach it. Every filler line carries an arithmetic operator
 * so the proposed family generates candidates ahead of the real one, which is what consumed the
 * budget on tabulate.
 */
function buildFixture(fillerLines) {
  const lines = ['def compute(values, width):', '    total = 0'];
  for (let i = 0; i < fillerLines; i += 1) lines.push(`    total = total + ${i} * 2`);
  lines.push('    return width + len(values)');   // defect: upstream multiplies
  const source = lines.join('\n');
  const repaired = source.replace('width + len(values)', 'width * len(values)');
  return { source, repaired };
}

async function main() {
  console.log('vocabulary growth');

  // Ten filler lines put the winner at position 101 of a 105-candidate pool: far outside the old
  // per-proposal budget of 20, and inside the pooled one. The same shape as the real failure, where
  // tabulate's pool was 79 and the winners sat at 25 and 47.
  const { source, repaired } = buildFixture(10);
  const regions = [{ start: 0, end: source.split('\n').length }];

  // Seed vocabulary has no arithmetic family at all, so '+ becomes *' is unreachable without growth.
  const vocabulary = JSON.parse(JSON.stringify(mutationRepair.DEFAULT_VOCABULARY));
  check('premise: the seed vocabulary cannot express this repair',
    !vocabulary['arithmetic-substitution'],
    'an arithmetic family already exists, so the fixture proves nothing');

  const proposals = mutationRepair.proposeVocabularyExtensions({ source, regions, vocabulary, limit: 12 });
  const wanted = proposals.find(p => p.rule[0].trim() === '+' && p.rule[1].trim() === '*');
  check('the needed rule is proposed', Boolean(wanted),
    proposals.map(p => p.rule.map(x => x.trim()).join('->')).join(', '));

  // Where the winner sits once every proposal is pooled into one vocabulary -- the number the old
  // per-proposal budget of 20 had to clear, and did not.
  const trial = JSON.parse(JSON.stringify(vocabulary));
  for (const proposal of proposals) {
    trial[proposal.family] = trial[proposal.family] || { kind: 'operator-substitution', rules: [] };
    trial[proposal.family].rules.push(proposal.rule);
  }
  const pooled = mutationRepair.generateCandidates({
    source, language: 'python', regions, limit: 100000, vocabulary: trial,
    onlyFamilies: [...new Set(proposals.map(p => p.family))]
  });
  const winnerAt = pooled.findIndex(c => c.source === repaired);
  check('premise: the winner is beyond a 20-candidate budget', winnerAt >= 20, `winner at ${winnerAt}`);

  let verifications = 0;
  const growth = await mutationRepair.growVocabularyByProposal({
    source, regions, vocabulary, language: 'python', targetRelative: 'compute.py',
    verify(patched) { verifications += 1; return { passed: patched === repaired }; }
  });

  check('growth repairs a defect the vocabulary could not express', growth.repaired === true,
    `repaired=${growth.repaired} after ${verifications} verifications`);
  check('the grown rule is the one that was needed',
    growth.grownRule?.rule?.[0]?.trim() === '+' && growth.grownRule?.rule?.[1]?.trim() === '*',
    JSON.stringify(growth.grownRule?.rule));
  check('what is retained is a rule, never a location',
    Array.isArray(growth.grownRule?.rule) && growth.grownRule.rule.length === 2
      && !JSON.stringify(growth.grownRule.rule).includes('compute'),
    JSON.stringify(growth.grownRule?.rule));
  check('all proposals share one budget rather than one each',
    verifications <= 120, `${verifications} verifications`);

  // A rule already in the vocabulary must not be credited as growth.
  const seedCanDoIt = JSON.parse(JSON.stringify(vocabulary));
  seedCanDoIt['arithmetic-substitution'] = { kind: 'operator-substitution', rules: [[' + ', ' * ']] };
  const noCredit = await mutationRepair.growVocabularyByProposal({
    source, regions, vocabulary: seedCanDoIt, language: 'python', targetRelative: 'compute.py',
    verify(patched) { return { passed: patched === repaired }; }
  });
  check('an existing rule is never credited as a grown one', noCredit.repaired === false,
    JSON.stringify(noCredit.grownRule?.rule));

  // Repeated operators on one line.
  //
  // The generator only ever mutated the first occurrence, so a defect whose repair must rewrite a
  // later one produced no candidate at all. Taken verbatim from tabulate/__init__.py:166, where
  //     return ":" + ("=" * (width - 1))
  // was seeded to `+` and the fix has to change the second `+`, not the first. Five defects in one
  // curriculum run failed this way and every one of them looked like a growth failure.
  const repeated = 'def f(width):\n    return ":" + ("=" + (width - 1))\n';
  const repairedRepeat = 'def f(width):\n    return ":" + ("=" * (width - 1))\n';
  const repeatVocab = JSON.parse(JSON.stringify(mutationRepair.DEFAULT_VOCABULARY));
  repeatVocab['arithmetic-substitution'] = { kind: 'operator-substitution', rules: [[' + ', ' * ']] };
  const repeatCandidates = mutationRepair.generateCandidates({
    source: repeated, language: 'python', regions: [{ start: 0, end: 2 }], limit: 1000,
    vocabulary: repeatVocab, onlyFamilies: ['arithmetic-substitution']
  });
  // Unary negation: an entire declared operator class that the engine could not express at all.
  //
  // The holdout generator seeds UOI by turning `return X` into `return not X`. No symmetric operator
  // class can describe removing a `not`, so 4 of 46 instances across the sealed sets were out of range
  // by construction. Growth has to be able to propose it, and to retain a rule rather than a location.
  const negated = 'def wide(ucs, w):\n    if w > 0 and ucs < 100:\n        return not _is_wide(ucs)\n    return False\n';
  const unnegated = negated.replace('return not _is_wide', 'return _is_wide');
  const unaryGrowth = await mutationRepair.growVocabularyByProposal({
    source: negated, regions: [{ start: 0, end: 4 }], vocabulary: mutationRepair.DEFAULT_VOCABULARY,
    language: 'python', targetRelative: 'w.py',
    verify(patched) { return { passed: patched === unnegated }; }
  });
  check('growth repairs a unary-insertion defect', unaryGrowth.repaired === true,
    JSON.stringify(unaryGrowth.grownRule));
  check('the rule retained for it removes the negation',
    unaryGrowth.grownRule?.family === 'unary-negation'
      && unaryGrowth.grownRule?.rule?.[0] === 'not ' && unaryGrowth.grownRule?.rule?.[1] === '',
    JSON.stringify(unaryGrowth.grownRule?.rule));

  check('a later occurrence of the same operator is reachable',
    repeatCandidates.some(candidate => candidate.source === repairedRepeat),
    repeatCandidates.map(c => c.source.split('\n')[1].trim()).join(' | '));
  check('the first occurrence is still offered too',
    repeatCandidates.some(candidate => candidate.source.includes('":" * ')),
    `${repeatCandidates.length} candidates`);

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(error.stack || String(error)); process.exit(1); });
