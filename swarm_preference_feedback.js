'use strict';

/**
 * Learning to speak better from the only judge that exists for taste: the user.
 *
 * Everything Lari learns has an automatic oracle. Repairs are judged by a project's own tests,
 * phrasings by whether independent sources attest them, facts by whether sources agree. Taste has
 * none. No machine can decide whether an answer reads well, which is why this lane stayed hand-written
 * long after the repair engine had grown past it.
 *
 * A thumbs up or down closes that gap exactly. It is a real oracle, it just happens to be a person,
 * and it arrives through ordinary use rather than through a training run. That makes shipping the
 * start of development rather than the end of it: every answer Lari gives is a question it is asking,
 * and every rating is an answer it can retain.
 *
 * What a rating may and may not decide
 * -----------------------------------
 * A rating orders *how* something is said. It never decides *whether* something is true. A thumbs up
 * cannot make an ungrounded sentence acceptable and a thumbs down cannot suppress a fact the claims
 * support -- if a correction is offered, it has to pass the same grounding check as anything else
 * before it is retained.
 *
 * That boundary is the whole safety of the design. Preference is the one signal in this system that
 * carries no verification of its own, so it is confined to ranking among alternatives that have
 * already been verified. Let it decide truth and Lari learns to say what pleases rather than what
 * holds, which is a worse failure than saying things stiffly.
 */

/** Ratings, kept as a small closed set so a score cannot be smuggled in as a rating. */
const RATINGS = { up: 1, down: -1 };

/**
 * Record what the user thought of an answer.
 *
 * Keyed on the realization rule that produced the text rather than on the text, because the rule is
 * what will be reused. Rating a sentence teaches nothing about the next sentence; rating the rule
 * that generated it teaches something about every future answer of that shape.
 */
function recordAnswerFeedback(model, { ruleId, claimType, rating, correction = null, answer = '', userScope = 'default' } = {}) {
  if (!model || !(rating in RATINGS)) return null;
  model.lariPreferenceFeedback = model.lariPreferenceFeedback || { schemaVersion: 1, records: [] };

  const key = ruleId || claimType || 'unattributed';
  const existing = model.lariPreferenceFeedback.records.find(record =>
    record.key === key && record.userScope === userScope);
  const now = new Date().toISOString();

  const record = existing || {
    key, claimType: claimType || null, userScope, up: 0, down: 0, corrections: [], firstSeenAt: now
  };
  if (rating === 'up') record.up += 1;
  else record.down += 1;
  record.lastRatedAt = now;
  // A fingerprint of the rated answer, never the answer.
  //
  // This field used to hold the first 200 characters, as a sample for a human reading the record.
  // Reasonable-sounding, and against rule 2, which forbids stored expected values in model state,
  // failure records "or diagnostics" -- the word is in the rule because a diagnostic is exactly where
  // the last one hid. Lari answering a benchmark item and a user rating it would have put that answer
  // into permanent state through a field nobody was auditing.
  //
  // The hash keeps what the sample was actually for -- telling two rated answers apart, and spotting
  // the same answer rated repeatedly -- and gives up being able to read it back. That is the right
  // trade here: the readable version cannot be made safe, because its contents are whatever Lari
  // happened to say.
  record.lastAnswerFingerprint = answer
    ? require('crypto').createHash('sha256').update(String(answer)).digest('hex').slice(0, 16)
    : null;
  record.lastAnswerLength = answer ? String(answer).length : 0;
  if (correction) {
    record.corrections = [
      { text: String(correction).slice(0, 300), at: now },
      ...record.corrections
    ].slice(0, 5);
  }
  if (!existing) model.lariPreferenceFeedback.records.unshift(record);
  return record;
}

/**
 * How much a rule is trusted, from its ratings.
 *
 * Laplace-smoothed so one thumbs down does not permanently condemn a rule and one thumbs up does not
 * crown it. A rule nobody has rated sits at 0.5, which is deliberately the same as a rule rated
 * evenly: absence of opinion is not disapproval, and the search-prior work earlier in this project is
 * the cautionary tale for treating it as such.
 */
function preferenceScore(model, key, { userScope = 'default' } = {}) {
  const record = (model?.lariPreferenceFeedback?.records || [])
    .find(entry => entry.key === key && entry.userScope === userScope);
  if (!record) return 0.5;
  return (record.up + 1) / (record.up + record.down + 2);
}

/**
 * Order candidate phrasings by what this user has liked.
 *
 * Only reorders; never removes. A phrasing the user has disliked stays available, because the
 * alternative may be worse and a lane that can run out of ways to say something answers with nothing.
 */
function rankByPreference(model, candidates = [], { userScope = 'default' } = {}) {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: preferenceScore(model, candidate.ruleId || candidate.claimType || candidate.key, { userScope })
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(entry => entry.candidate);
}

/**
 * Turn a user's rewrite into a candidate phrasing.
 *
 * The most valuable feedback is not the thumbs down, it is "say it like this". A correction becomes a
 * phrasing rule only if it still says everything the claim carried and adds nothing the claim does not
 * license -- checked by the same grounding oracle the generator is held to. A correction that
 * introduces a fact is refused, however much the user preferred it, because the user is the judge of
 * expression and the claims remain the judge of content.
 */
function correctionToPhrasing(correction, claim, realization) {
  const text = String(correction || '').trim();
  if (!text) return { accepted: false, reason: 'empty correction' };

  const grounding = realization.groundingViolations(text, [claim]);
  if (grounding.length) {
    return { accepted: false, reason: 'the correction states something the claim does not support', grounding };
  }
  const values = Object.values(claim?.values || {}).map(String);
  const missing = values.filter(value => !text.includes(value));
  if (missing.length) {
    return { accepted: false, reason: 'the correction drops something the claim carried', missing };
  }

  // Abstract the user's wording back into a reusable shape, so what is learned is their phrasing
  // rather than this one sentence.
  let shape = text;
  for (const value of values.sort((a, b) => b.length - a.length)) {
    shape = shape.split(value).join(/^\d+$/.test(value) ? '{NUMBER}' : '{NAME}');
  }
  return { accepted: true, shape, sourceText: text };
}

/** Feedback summary, for showing a user what their ratings have actually changed. */
function summarizeFeedback(model, { userScope = 'default' } = {}) {
  const records = (model?.lariPreferenceFeedback?.records || [])
    .filter(record => record.userScope === userScope);
  return {
    rated: records.length,
    up: records.reduce((sum, record) => sum + record.up, 0),
    down: records.reduce((sum, record) => sum + record.down, 0),
    corrections: records.reduce((sum, record) => sum + record.corrections.length, 0),
    mostLiked: records.slice().sort((a, b) =>
      preferenceScore(model, b.key, { userScope }) - preferenceScore(model, a.key, { userScope }))[0]?.key || null,
    mostDisliked: records.slice().sort((a, b) =>
      preferenceScore(model, a.key, { userScope }) - preferenceScore(model, b.key, { userScope }))[0]?.key || null
  };
}

module.exports = {
  RATINGS,
  recordAnswerFeedback,
  preferenceScore,
  rankByPreference,
  correctionToPhrasing,
  summarizeFeedback
};
