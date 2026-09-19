#!/usr/bin/env node
'use strict';

/**
 * Oracle for user-guided speech.
 *
 * NOT a capability gate. It checks that a rating changes what Lari prefers to say, that a rewrite
 * becomes reusable, and -- the assertions that carry the weight -- that preference is confined to
 * expression and can never reach content.
 *
 * Preference is the only signal in this system with no verification behind it. Everything else is
 * decided by a suite, by source agreement, or by execution. So it is deliberately boxed in: it orders
 * alternatives that are already grounded and does nothing else. A system that let approval decide
 * truth would learn to say what pleases rather than what holds, which is worse than speaking stiffly.
 */

const path = require('path');
const feedback = require(path.join(__dirname, '..', 'swarm_preference_feedback.js'));
const realization = require(path.join(__dirname, '..', 'swarm_claim_realization.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

const claim = { type: 'search_cost', values: { verifications: 42, candidateCount: 188, budget: 640 } };

console.log('preference feedback');

const model = {};
check('an unrated phrasing starts neutral', feedback.preferenceScore(model, 'anything') === 0.5);

feedback.recordAnswerFeedback(model, { ruleId: 'verbose', rating: 'down', answer: 'a long sentence' });
feedback.recordAnswerFeedback(model, { ruleId: 'terse', rating: 'up', answer: 'a short one' });
feedback.recordAnswerFeedback(model, { ruleId: 'terse', rating: 'up' });

check('a thumbs down lowers a phrasing', feedback.preferenceScore(model, 'verbose') < 0.5);
check('a thumbs up raises one', feedback.preferenceScore(model, 'terse') > 0.5);
check('ratings reorder what Lari reaches for first',
  feedback.rankByPreference(model, [{ ruleId: 'verbose' }, { ruleId: 'terse' }])[0].ruleId === 'terse');
check('a disliked phrasing is demoted, not deleted',
  feedback.rankByPreference(model, [{ ruleId: 'verbose' }, { ruleId: 'terse' }]).length === 2);
check('one rating does not condemn a phrasing outright',
  feedback.preferenceScore(model, 'verbose') > 0.2, String(feedback.preferenceScore(model, 'verbose')));

// Ratings are per user: two people may disagree and both be right.
feedback.recordAnswerFeedback(model, { ruleId: 'verbose', rating: 'up', userScope: 'other' });
check('preferences are held per user',
  feedback.preferenceScore(model, 'verbose', { userScope: 'other' })
  > feedback.preferenceScore(model, 'verbose'));

// A rewrite is the most valuable feedback there is.
const accepted = feedback.correctionToPhrasing('Took 42 tries out of 188, budget was 640.', claim, realization);
check('a rewrite is accepted when it is faithful', accepted.accepted === true, JSON.stringify(accepted.reason));
check('the rewrite is generalised into a reusable shape',
  /\{NUMBER\}/.test(accepted.shape) && !/\b42\b/.test(accepted.shape), accepted.shape);

// The boundary that matters.
const invented = feedback.correctionToPhrasing('Took 42 of 188, budget 640, and I refactored 9 files.', claim, realization);
check('a rewrite that invents a fact is refused', invented.accepted === false, JSON.stringify(invented));

const dropped = feedback.correctionToPhrasing('Took a few tries.', claim, realization);
check('a rewrite that drops facts is refused', dropped.accepted === false, JSON.stringify(dropped.reason));

const empty = feedback.correctionToPhrasing('   ', claim, realization);
check('an empty rewrite teaches nothing', empty.accepted === false);

const summary = feedback.summarizeFeedback(model);
check('a user can see what their ratings changed',
  summary.up === 2 && summary.down === 1 && summary.mostLiked === 'terse', JSON.stringify(summary));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
