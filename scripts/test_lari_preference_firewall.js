#!/usr/bin/env node
'use strict';

/**
 * The firewall between taste and truth, asserted end to end across the real lanes.
 *
 * `swarm_preference_feedback.js` states the boundary in its own header: a rating orders *how* something
 * is said and never decides *whether* it is true. That is the correct design and, until this file, it
 * was a comment. The existing suite asserts the correction path -- a rewrite that invents or drops a
 * fact is refused -- and asserts nothing about the rating path, which is the one that will see millions
 * of events and no human review.
 *
 * The failure being guarded against is specific and is the obvious way this project dies. Users thumbs-
 * down every "I don't know", because a refusal is unsatisfying. If ratings can reach the decision to
 * answer, Lari learns that guessing scores better than declining, and the whole groundedness argument
 * collapses into a model that says what pleases. This repository has already filled one vacuum with the
 * answer key (GSM8K) and another with canned strings; preference is the third vacuum and it is the
 * largest, because it arrives continuously and looks like progress.
 *
 * So: preference may reorder verified alternatives. It may not create one, suppress one, or convert a
 * refusal into an answer.
 *
 * Usage: node scripts/test_lari_preference_firewall.js
 */

const path = require('path');
const root = path.join(__dirname, '..');
const feedback = require(path.join(root, 'swarm_preference_feedback.js'));
const realization = require(path.join(root, 'swarm_claim_realization.js'));
const research = require(path.join(root, 'swarm_research_claims.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 260)}` : ''}`);
  }
}

/** Rate something the same way many times over, the way a real user base would. */
function hammer(model, ruleId, rating, times = 50, userScope = 'default') {
  for (let i = 0; i < times; i += 1) feedback.recordAnswerFeedback(model, { ruleId, rating, userScope });
}

const SOURCE = 'Ada Lovelace is a mathematician. The Analytical Engine is in London.';
const META = { source: 'https://example.org/ae' };

console.log('ranking reorders and never removes');
{
  const model = {};
  const candidates = [{ ruleId: 'a' }, { ruleId: 'b' }, { ruleId: 'c' }];
  hammer(model, 'a', 'down', 200);
  hammer(model, 'c', 'up', 200);
  const ranked = feedback.rankByPreference(model, candidates);
  check('every candidate survives ranking', ranked.length === candidates.length, ranked.length);
  check('the liked one is first', ranked[0].ruleId === 'c', ranked.map(r => r.ruleId));
  check('the disliked one is still present', ranked.some(r => r.ruleId === 'a'), ranked.map(r => r.ruleId));
  check('a hated phrasing is never scored out of existence',
    feedback.preferenceScore(model, 'a') > 0, feedback.preferenceScore(model, 'a'));
}

console.log('\nratings cannot turn a refusal into an answer');
{
  // The central assertion. Rate the very idea of declining into the ground, then ask something the
  // store cannot support, and it must still decline.
  const model = {};
  research.retainResearchClaims(model, SOURCE, META);
  hammer(model, 'no retained claim supports an answer', 'down', 500);
  hammer(model, 'source_attribution', 'down', 500);
  hammer(model, 'fact_definition', 'up', 500);

  const decline = research.answerFromResearch(model, 'Who won the football match last night?');
  check('an unsupported question is still declined after 500 downvotes on declining',
    decline.answered === false, decline);
  check('and no text was produced to fill the gap',
    !decline.text, decline.text);

  const supported = research.answerFromResearch(model, 'Tell me about Ada Lovelace');
  check('a supported question is still answered', supported.answered, supported.reason);
  check('and the answer is still grounded', supported.answered && supported.grounding.length === 0,
    supported.grounding);
}

console.log('\nratings cannot change what claims exist');
{
  const model = {};
  research.retainResearchClaims(model, SOURCE, META);
  const before = JSON.stringify(model.knowledge);
  hammer(model, 'fact_location', 'down', 300);
  hammer(model, 'fact_definition', 'up', 300);
  check('the claim store is byte-identical after 600 ratings',
    JSON.stringify(model.knowledge) === before);
  check('a downvoted claim type is still retained',
    model.knowledge.some(k => k.type === 'fact_location'));
  check('and still answerable',
    research.answerFromResearch(model, 'Where is The Analytical Engine').answered);
}

console.log('\nratings cannot license an ungrounded sentence');
{
  const claim = { type: 'fact_definition', values: { term: 'Ada Lovelace', category: 'mathematician' } };
  const model = {};

  // A phrasing that adds a fact nobody licensed. Rate it to the ceiling; it must still be refused.
  const invented = 'Ada Lovelace is a mathematician who died in "1852".';
  hammer(model, 'beloved-but-wrong', 'up', 500);
  const verdict = feedback.correctionToPhrasing(invented, claim, realization);
  check('a much-loved rewrite that invents a fact is still refused',
    verdict.accepted === false, verdict.reason);
  check('and the refusal names the grounding violation',
    /does not support/.test(String(verdict.reason)), verdict.reason);

  // And one that drops a fact the claim carried.
  const lossy = feedback.correctionToPhrasing('She was a mathematician.', claim, realization);
  check('a rewrite that drops a licensed fact is refused', lossy.accepted === false, lossy.reason);

  // A faithful rephrasing is accepted -- the firewall must not block legitimate taste.
  const good = feedback.correctionToPhrasing(
    'Ada Lovelace worked as a mathematician.', claim, realization);
  check('a faithful rephrasing is accepted, so taste still has somewhere to go',
    good.accepted === true, good.reason);
}

console.log('\none user\'s taste does not reach another user\'s content');
{
  const model = {};
  research.retainResearchClaims(model, SOURCE, META);
  hammer(model, 'fact_definition', 'down', 200, 'alice');
  check('alice\'s rating moved alice\'s score',
    feedback.preferenceScore(model, 'fact_definition', { userScope: 'alice' }) < 0.5);
  check('and left bob\'s untouched',
    feedback.preferenceScore(model, 'fact_definition', { userScope: 'bob' }) === 0.5,
    feedback.preferenceScore(model, 'fact_definition', { userScope: 'bob' }));
  check('bob still gets the same grounded answer',
    research.answerFromResearch(model, 'Tell me about Ada Lovelace').answered);
}

console.log('\nno rating is stored as an expected value');
{
  const model = {};
  const answer = 'the capital is Paris';
  const record = feedback.recordAnswerFeedback(model, { ruleId: 'x', rating: 'up', answer });
  const serialized = JSON.stringify(model);
  check('feedback state carries no minedFrom back-reference', !serialized.includes('minedFrom'));
  // Rule 2 names diagnostics explicitly, because that is where the last stored answer hid. A rated
  // answer is arbitrary text -- if Lari ever answers a benchmark item and a user rates it, a readable
  // sample field would put that answer into permanent state.
  check('the rated answer text is not stored anywhere in model state',
    !serialized.includes(answer), serialized.slice(0, 240));
  check('a fingerprint is kept instead, so two rated answers can still be told apart',
    typeof record.lastAnswerFingerprint === 'string' && record.lastAnswerFingerprint.length === 16,
    record.lastAnswerFingerprint);
  check('the same answer fingerprints identically',
    feedback.recordAnswerFeedback({}, { ruleId: 'x', rating: 'up', answer }).lastAnswerFingerprint
      === record.lastAnswerFingerprint);
  check('a different answer fingerprints differently',
    feedback.recordAnswerFeedback({}, { ruleId: 'x', rating: 'up', answer: 'something else' })
      .lastAnswerFingerprint !== record.lastAnswerFingerprint);
  check('rating without an answer stores no fingerprint at all',
    feedback.recordAnswerFeedback({}, { ruleId: 'x', rating: 'up' }).lastAnswerFingerprint === null);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
