/**
 * Tests for the discourse miner: signal detection, failure->recovery pairing,
 * cluster induction (stubbed), calibration, and the runtime hook.
 *
 * Run: node scripts/test_lari_discourse_miner.js
 */
'use strict';

const miner = require('../swarm_discourse_miner.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function stubBindings() {
  const calls = { induce: [], route: 0 };
  return {
    calls,
    induceFromFailures: (model, pairs, options) => {
      calls.induce.push({ pairs: pairs.length, options });
      return { learned: true, record: { id: 'proc.test123', provenance: {} } };
    },
    discourseGoalOf: () => 'test_goal',
    classifyIntent: (p) => (/remember|what is/i.test(p) ? 'factual' : 'open_chat'),
    routeProcedure: (model, prompt) => { calls.route++; return { record: { id: 'proc.test123' } }; },
    getEpisodes: () => []
  };
}

function turn(userMessage, lariAnswer = 'ok', intent = 'open_chat') {
  return { userMessage, lariAnswer, intent, confidence: 0.8, userScope: 'default' };
}

// --- signal detection ---
{
  const m = {};
  const b = stubBindings();
  let r = miner.noteTurn(m, turn('what is a goose', 'a bird with a long neck'), b);
  check('first turn is neutral', r.signal === 'neutral', r.signal);
  r = miner.noteTurn(m, turn('not what I meant, I wanted the bird facts', 'geese mate for life'), b);
  check('explicit correction detected', r.signal === 'correction', r.signal);
  check('recovery pending after correction', !!m.lariDiscourseMiner.pendingRecovery);
  // New question instead of recovery -> pending recovery must be DISCARDED,
  // not manufactured into a junk pair.
  r = miner.noteTurn(m, turn('tell me about rivers', 'rivers flow to the sea'), b);
  check('new question does not fake a recovery', r.signal === 'neutral' && !m.lariDiscourseMiner.pendingRecovery, r.signal);
  check('junk pair discarded', m.lariDiscourseMiner.pairs.length === 0 && m.lariDiscourseMiner.discardedRecoveries === 1,
    `pairs=${m.lariDiscourseMiner.pairs.length} discarded=${m.lariDiscourseMiner.discardedRecoveries}`);
}

// approval completes the pair: correction answered, user accepts
{
  const m = {};
  const b = stubBindings();
  miner.noteTurn(m, turn('what is a goose', 'a bird with a long neck'), b);
  miner.noteTurn(m, turn('not what I meant, I wanted the bird facts', 'geese mate for life and hiss'), b);
  const r = miner.noteTurn(m, turn('thanks, perfect', 'anytime'), b);
  check('approval signal', r.signal === 'approval', r.signal);
  check('pair completed on approval', m.lariDiscourseMiner.pairs.length === 1, m.lariDiscourseMiner.pairs.length);
  const pair = m.lariDiscourseMiner.pairs[0];
  check('pair prompt is the failed question', pair.prompt === 'what is a goose', pair.prompt);
  check('pair correctedAnswer is the answer to the correction', pair.correctedAnswer === 'geese mate for life and hiss', pair.correctedAnswer);
}

// direct retry: user re-asks the same prompt; this turn's answer is the recovery
{
  const m = {};
  const b = stubBindings();
  miner.noteTurn(m, turn('what time is it in ohio', 'ohio is a state'), b);
  miner.noteTurn(m, turn('naw, what time is it in ohio', 'sorry about that'), b);
  const r = miner.noteTurn(m, turn('what time is it in ohio', 'it is 3:45 PM in Ohio'), b);
  check('direct retry is not a correction', r.signal === 'neutral', r.signal);
  check('pair completed on retry', m.lariDiscourseMiner.pairs.length === 1, m.lariDiscourseMiner.pairs.length);
  check('retry answer is the corrected answer',
    m.lariDiscourseMiner.pairs[0].correctedAnswer === 'it is 3:45 PM in Ohio',
    m.lariDiscourseMiner.pairs[0].correctedAnswer);
}

// rephrase-retry: correction with substance, then a rephrased retry of the
// failed prompt (rephrase detected vs the correction turn, retry recorded
// against the failed prompt)
{
  const m = {};
  const b = stubBindings();
  miner.noteTurn(m, turn('can you explain how recursion works in python', 'recursion is hard'), b);
  miner.noteTurn(m, turn('no thats not what I asked, I asked how recursion works in python', 'my mistake, rephrasing'), b);
  const r2 = miner.noteTurn(m, turn('asked how recursion works in python explain', 'a function that calls itself'), b);
  check('rephrase of failed prompt recorded as retry',
    r2.signal === 'rephrase' && !!m.lariDiscourseMiner.pendingRecovery.retryPrompt, r2.signal);
  miner.noteTurn(m, turn('thanks', 'you got it'), b);
  check('pair completed after rephrase-retry', m.lariDiscourseMiner.pairs.length === 1, m.lariDiscourseMiner.pairs.length);
  check('rephrase-retry answer is the corrected answer',
    m.lariDiscourseMiner.pairs[0].correctedAnswer === 'a function that calls itself',
    m.lariDiscourseMiner.pairs[0].correctedAnswer);
}

{
  const m = {};
  const b = stubBindings();
  miner.noteTurn(m, turn('explain recursion'), b);
  const r = miner.noteTurn(m, turn('naw'), b);
  check('short rejection "naw" is a correction', r.signal === 'correction', r.signal);
}

{
  const m = {};
  const b = stubBindings();
  miner.noteTurn(m, turn('explain recursion'), b);
  const r = miner.noteTurn(m, turn('naw man, that wasnt an answer at all'), b);
  check('leading rejection "naw man, ..." is a correction', r.signal === 'correction', r.signal);
}

{
  const m = {};
  const b = stubBindings();
  miner.noteTurn(m, turn('can you explain how recursion works in python'), b);
  const r = miner.noteTurn(m, turn('how does recursion work in python, explain please'), b);
  check('rephrase detected as implicit correction', r.signal === 'rephrase', r.signal);
}

{
  const m = {};
  const b = stubBindings();
  miner.noteTurn(m, turn('what time is it'), b);
  const r = miner.noteTurn(m, turn('thanks, perfect'), b);
  check('approval detected', r.signal === 'approval', r.signal);
}

{
  const m = {};
  const b = stubBindings();
  miner.noteTurn(m, turn('what time is it'), b);
  const r = miner.noteTurn(m, turn('and what about tomorrow'), b);
  check('ordinary follow-up stays neutral', r.signal === 'neutral', r.signal);
}

// --- induction at 3 pairs in one cluster ---
{
  const m = {};
  const b = stubBindings();
  const cycle = (q) => {
    miner.noteTurn(m, turn(q, 'bad answer'), b);
    miner.noteTurn(m, turn('not what I meant', 'better answer'), b);
    miner.noteTurn(m, turn('thanks, that is better', 'ack'), b);
  };
  cycle('question alpha one');
  cycle('question beta two');
  check('no induction before 3 pairs', b.calls.induce.length === 0, b.calls.induce.length);
  cycle('question gamma three');
  check('induction attempted at 3 pairs', b.calls.induce.length === 1, b.calls.induce.length);
  const ind = m.lariDiscourseMiner.inductions[0];
  check('induction learned', ind && ind.learned === true, JSON.stringify(ind));
  check('induction verified by routing', ind && ind.verified === true, JSON.stringify(ind));
  check('cluster consumed after attempt', (m.lariDiscourseMiner.clusters['goal:test_goal'] || []).length === 0);
}

// --- calibration ---
{
  const m = {};
  const b = stubBindings();
  for (let i = 0; i < 6; i++) {
    miner.noteTurn(m, turn(`vague question ${i}`, 'vague answer', 'explanation'), b);
    miner.noteTurn(m, turn('not what I meant', 'x', 'explanation'), b);
    miner.noteTurn(m, turn('ok next', 'y', 'explanation'), b);
  }
  const summary = miner.calibrationSummary(m);
  const exp = summary.find(s => s.intent === 'explanation');
  check('calibration recorded corrections', exp && exp.corrections >= 5, JSON.stringify(exp));
  const factor = miner.calibrationFactor(m.lariDiscourseMiner, 'explanation');
  check('calibration shrinks confidence when often corrected', factor < 1 && factor >= 0.5, factor);
  const fresh = miner.calibrationFactor({ calibration: {} }, 'nope');
  check('no shrinkage without samples', fresh === 1, fresh);
}

// --- runtime hook: chat still works, mining report attached ---
{
  const api = require('../swarm_model_runtime.js');
  const model = {};
  (async () => {
    const r1 = await api.sendMessageToLariAsync(model, 'what is a goose', {});
    check('chat turn works with miner hooked', typeof r1.answer === 'string' && r1.answer.length > 0);
    check('mining report attached', r1.discourseMining && r1.discourseMining.signal === 'neutral', JSON.stringify(r1.discourseMining && r1.discourseMining.signal));
    const r2 = await api.sendMessageToLariAsync(model, 'naw not what I meant', {});
    check('correction turn mined', r2.discourseMining && r2.discourseMining.signal === 'correction', JSON.stringify(r2.discourseMining && r2.discourseMining.signal));
    finish();
  })().catch(e => { console.log('  FAIL runtime hook threw — ' + e.message); failed++; failures.push('runtime hook'); finish(); });
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed${failures.length ? ' — ' + failures.join(', ') : ''}`);
  process.exit(failed ? 1 : 0);
}
