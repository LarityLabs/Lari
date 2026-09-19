#!/usr/bin/env node
'use strict';

/**
 * Oracle for turning reading into ability.
 *
 * NOT a capability gate: synthetic sources, a fake verifier, checked properties.
 *
 * The property this exists to protect is that reading proposes and only testing concludes. A loop
 * that could mark a capability learned because a document described it would repeat this project's
 * worst failure -- state that looks like reasoning and is actually assertion -- so the assertions
 * about *refusing* matter more here than the ones about succeeding.
 */

const path = require('path');
const research = require(path.join(__dirname, '..', 'swarm_research_to_capability.js'));
const mutationRepair = require(path.join(__dirname, '..', 'swarm_mutation_repair.js'));
const runtime = require(path.join(__dirname, '..', 'swarm_model_runtime.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

const sources = [
  { title: 'tutorial', text: 'For integer division you should use // instead of /. Replace `*` with `//` when you want the floor.' },
  { title: 'guide', text: 'Prefer >= rather than >. Change + to - when the offset is subtracted.' }
];

console.log('research to capability');

const proposals = research.extractSubstitutionProposals(sources);
check('it extracts substitutions from prose', proposals.length >= 3, `${proposals.length}`);
check('"instead of" is read in the right direction',
  proposals.some(p => p.rule[0].trim() === '/' && p.rule[1].trim() === '//'),
  JSON.stringify(proposals.map(p => p.rule)));
check('"replace X with Y" is read in the right direction',
  proposals.some(p => p.rule[0].trim() === '*' && p.rule[1].trim() === '//'));
check('"rather than" is read in the right direction',
  proposals.some(p => p.rule[0] === '>' && p.rule[1] === '>='));
check('every proposal carries the sentence that suggested it',
  proposals.every(p => p.evidence.length > 0 && p.sources.length > 0));
check('operators are normalised to the vocabulary form',
  proposals.some(p => p.rule[0] === ' * ' || p.rule[1] === ' // '),
  JSON.stringify(proposals.map(p => p.rule)));

// A defect only the read rule can repair.
const broken = 'def half(total):\n    return total * 2\n';
const fixed = 'def half(total):\n    return total // 2\n';

(async () => {
  const learned = await research.learnRuleFromResearch({
    sources, source: broken, regions: [{ start: 0, end: 2 }], targetRelative: 'h.py',
    mutationRepair, vocabulary: mutationRepair.DEFAULT_VOCABULARY, limit: 60,
    verify: patched => ({ passed: patched === fixed })
  });
  check('what it read repairs the defect', learned.learned === true, JSON.stringify(learned.reason));
  check('the rule credited is the one that worked',
    learned.rule && learned.rule[0].trim() === '*' && learned.rule[1].trim() === '//',
    JSON.stringify(learned.rule));
  check('the capability carries its citation',
    learned.citation?.sources?.length > 0 && learned.citation?.evidence?.length > 0);

  // Reading must not be able to conclude on its own.
  const wrong = await research.learnRuleFromResearch({
    sources, source: broken, regions: [{ start: 0, end: 2 }], targetRelative: 'h.py',
    mutationRepair, vocabulary: mutationRepair.DEFAULT_VOCABULARY, limit: 60,
    verify: () => ({ passed: false })
  });
  check('nothing is learned when the tests refuse it', wrong.learned === false, JSON.stringify(wrong.reason));

  const authoritative = [{ title: 'confident but wrong', text: 'Replace `*` with `@` to fix division bugs.' }];
  const bogus = await research.learnRuleFromResearch({
    sources: authoritative, source: broken, regions: [{ start: 0, end: 2 }], targetRelative: 'h.py',
    mutationRepair, vocabulary: mutationRepair.DEFAULT_VOCABULARY, limit: 60,
    verify: patched => ({ passed: patched === fixed })
  });
  check('a confident but wrong source teaches nothing', bogus.learned === false, JSON.stringify(bogus.reason));

  // Retention keeps a rule, not a sentence.
  const model = { lariLearnedRecords: { schemaVersion: 1, records: [] } };
  const record = research.retainResearchedRule(model, { rule: learned.rule, citation: learned.citation, runtime });
  check('a verified rule is retained', Boolean(record) && record.payload.operation === 'mutation_vocabulary_rule');
  check('retention records that reading proposed and tests decided',
    record.payload.acquisitionRoute === 'research_proposed_test_verified');
  check('retention cites where the idea came from', record.payload.citedSources.length > 0);
  check('what is stored is a rule, not the sentence',
    Array.isArray(record.payload.rule) && record.payload.rule.length === 2
    && record.provenance.storesTestAnswers === false);

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
