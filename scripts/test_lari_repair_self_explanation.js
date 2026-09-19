#!/usr/bin/env node
'use strict';

/**
 * The oracle for Lari's first realization lane.
 *
 * NOT a capability gate and not a judgement about prose. It decides four machine-checkable properties
 * of an explanation generated from a repair record, and -- the part that matters -- it asserts each
 * one can fail. A verifier that cannot fail is decoration, and this repository has shipped one of
 * those before.
 *
 *   grounding    every number and quoted span in the text came from the claims
 *   preservation every claim handed in was actually said
 *   provenance   every claim value exists in the record it was atomized from
 *   fabrication  corrupting any of the above is detected
 *
 * The provenance check exists because the first version of this lane failed without noticing:
 * it derived a filename from an instance identifier, produced "wcwidth/escape/sequences.py" for a
 * file named escape_sequences.py, and passed every check, because the checks compared the text
 * against claims that were already wrong.
 *
 * Usage: node scripts/test_lari_repair_self_explanation.js
 */

const path = require('path');
const realization = require(path.join(__dirname, '..', 'swarm_claim_realization.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// A real record shape, with the fields a measurement run actually writes.
const record = {
  instance: 'wcwidth-aor-wcwidth_escape_sequences_py-l73',
  operator: 'AOR',
  repaired: true,
  family: 'arithmetic-substitution',
  description: '- -> +',
  grewVocabulary: { family: 'arithmetic-substitution', rule: [' - ', ' + '] },
  restoresUpstreamExactly: true,
  coveredLineCount: 188,
  coverageSelector: 'exact-node-ids',
  targetLineCovered: true,
  verifications: 1,
  fullSuiteRuns: 1,
  candidateCount: 188,
  budget: 640,
  nonHaltingCandidates: 7
};

console.log('repair self-explanation');

const explained = realization.explainRepair(record);
check('an explanation is produced', explained.text.length > 0);
check('it is grounded', explained.grounding.length === 0, JSON.stringify(explained.grounding));
check('every claim is realized', explained.dropped.length === 0, JSON.stringify(explained.dropped));
check('every claim value comes from the record', explained.provenance.length === 0, JSON.stringify(explained.provenance));
check('the lane calls no external model', explained.externalModelCalls === 0);

// It has to say the things that matter about a repair, or it is not an explanation.
check('it names the rule that won', /arithmetic-substitution/.test(explained.text));
check('it reports the search cost', /640/.test(explained.text));
check('it discloses that the rule was grown', /proposed/.test(explained.text));

// --- the checks must be able to fail ---

const injected = `${explained.text} I also rewrote 42 lines in payments.py.`;
const injectedViolations = realization.groundingViolations(injected, explained.claims);
check('grounding catches an injected fact', injectedViolations.length > 0,
  'an added sentence with an unlicensed number went undetected');

const truncated = explained.text.split('. ').slice(0, 2).join('. ');
const droppedClaims = realization.unrealizedClaims(truncated, explained.claims);
check('preservation catches a dropped claim', droppedClaims.length > 0,
  'silently omitting claims went undetected');

// The exact failure that motivated the provenance check: a plausible, wrong, derived filename.
const fabricatedClaims = [{ type: 'outcome_repaired', values: { operator: 'AOR', file: 'wcwidth/escape/sequences.py', line: 73 } }];
const fabricated = realization.claimProvenanceViolations(fabricatedClaims, record);
check('provenance catches a claim the record never contained', fabricated.length > 0,
  'a reconstructed filename that does not exist went undetected');

// And it must not cry wolf: a value genuinely present in the record has to pass.
const honestClaims = [{ type: 'rule_applied', values: { family: 'arithmetic-substitution', description: '- -> +' } }];
check('provenance accepts values the record does contain',
  realization.claimProvenanceViolations(honestClaims, record).length === 0);

// An unrepaired record must be describable too -- a generator that can only narrate success is a
// press release.
const failedRecord = { instance: 'wcwidth-crp-x-l1', operator: 'CRP', repaired: false, verifications: 593, budget: 640, coveredLineCount: 177, coverageSelector: 'exact-node-ids' };
const failedExplained = realization.explainRepair(failedRecord);
check('a failure is explained as readily as a success',
  failedExplained.ok && /could not repair/.test(failedExplained.text),
  failedExplained.text);

// --- learning to say something it has never said ---
//
// The property that separates this from a template. A claim type with no realization rule must be
// phraseable by proposal, verified by the same oracle, and retained as a rule keyed on the *type* --
// so it applies to every future claim of that shape rather than to the record it was learned from.
const speedRecord = { residentMsPerCandidate: 852, fastStage: 'resident' };
const speedClaim = { type: 'oracle_speed', values: { residentMsPerCandidate: 852, fastStage: 'resident' } };

check('the claim type is genuinely unknown beforehand',
  !realization.DEFAULT_REALIZATION_RULES.oracle_speed);

const grown = realization.growRealizationRule(speedClaim, realization.DEFAULT_REALIZATION_RULES, speedRecord);
check('a phrasing is learned for it', grown.learned === true, JSON.stringify(grown));
check('what it learned is grounded',
  realization.groundingViolations(grown.text, [speedClaim]).length === 0, grown.text);
check('the learned phrasing says every value it was given',
  Object.values(speedClaim.values).every(value => grown.text.includes(String(value))), grown.text);

// A rule, not a sentence: it has to work on a record it has never seen.
const learnedRules = { ...realization.DEFAULT_REALIZATION_RULES, [grown.claimType]: grown.rule };
const unseen = { type: 'oracle_speed', values: { residentMsPerCandidate: 1198, fastStage: 'resident' } };
const reused = realization.realizeClaims([unseen], learnedRules);
check('the learned rule generalises to an unseen record', /1198/.test(reused), reused);
check('and it did not memorise the record it was learned from', !/852/.test(reused), reused);

// Declining is a legitimate outcome. A generator that always emits something is how fabrication
// starts, so a claim carrying nothing must produce no rule rather than an empty flourish.
check('it declines when a claim carries nothing to say',
  realization.growRealizationRule({ type: 'empty', values: {} }).learned === false);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
