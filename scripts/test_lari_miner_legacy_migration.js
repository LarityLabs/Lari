/**
 * Regression tests for the round-2 miner-learning legacy migration
 * (fix round 3, BUG 1).
 *
 * Background: the live model's persisted `lariDiscourseMiner` state was
 * written before round 2 added `successOperators` / `successExemplars`.
 * `minerState()` had no legacy migration, and `noteTurn()` built its report
 * literal reading `state.successOperators.length` BEFORE its internal try —
 * so every turn threw `TypeError: Cannot read properties of undefined
 * (reading 'length')`, and the runtime hook's silent catch swallowed it.
 * Live symptom: 143 turns logged, 0 pairs, 0 inductions.
 *
 * These tests pin the fix:
 *   - a legacy-shaped state (exactly the live model's shape) through
 *     noteTurn must not throw, must migrate the keys, and must preserve
 *     existing history;
 *   - the hook path (noteTurn inside try/catch, like the runtime) must
 *     return a REAL report and actually record the turn — not the silent
 *     fallback with the turn lost;
 *   - an instruction pair must complete end-to-end on the migrated state
 *     (pair + exemplar seeded), and repeated success must still induce a
 *     success operator;
 *   - corrupted key shapes (non-array successOperators, array
 *     successExemplars) must migrate cleanly instead of throwing.
 *
 * Run: node scripts/test_lari_miner_legacy_migration.js
 */
'use strict';

const miner = require('../swarm_discourse_miner.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// Exact shape of the live model on 2026-09-19: version 1, no
// successOperators / successExemplars, some pre-existing history.
function legacyState(overrides) {
  return Object.assign({
    version: 1,
    lastTurn: null,
    turnLog: [{ at: '2026-09-18T00:00:00.000Z', userScope: 'default', userMessage: 'old', lariAnswer: 'old', intent: 'open_chat', confidence: 0.9, signal: 'neutral' }],
    pendingRecovery: null,
    pairs: [],
    clusters: {},
    calibration: { open_chat: { turns: 1, corrections: 0 } },
    inductions: [],
    discardedRecoveries: 0
  }, overrides || {});
}

function turn(userMessage, lariAnswer = 'ok', intent = 'open_chat') {
  return { userMessage, lariAnswer, intent, confidence: 0.8, userScope: 'default' };
}

function stubBindings() {
  return {
    induceFromFailures: (model, pairs, options) => ({ learned: true, record: { id: 'proc.learn', provenance: {} } }),
    discourseGoalOf: () => null,
    classifyIntent: () => 'open_chat',
    routeProcedure: () => ({ record: { id: 'proc.learn' } }),
    getEpisodes: () => []
  };
}

// --- legacy state through noteTurn: no throw, migrates, preserves history ---
{
  const model = { lariDiscourseMiner: legacyState() };
  let threw = null;
  let report = null;
  try { report = miner.noteTurn(model, turn('hey whats up', 'not much', 'small_talk'), stubBindings()); }
  catch (e) { threw = e; }
  const s = model.lariDiscourseMiner;
  check('legacy state: noteTurn does not throw', threw === null, threw && threw.message);
  check('legacy state: turn recorded', s.turnLog.length === 2, `turnLog=${s.turnLog.length}`);
  check('legacy state: history preserved', s.turnLog[0].userMessage === 'old', s.turnLog[0].userMessage);
  check('legacy state: successOperators backfilled', Array.isArray(s.successOperators) && s.successOperators.length === 0);
  check('legacy state: successExemplars backfilled', s.successExemplars && typeof s.successExemplars === 'object' && !Array.isArray(s.successExemplars));
  check('legacy state: calibration preserved', s.calibration.open_chat && s.calibration.open_chat.turns >= 1, JSON.stringify(s.calibration));
  check('legacy state: version migrated to 2', s.version === 2, `version=${s.version}`);
  check('legacy state: report reflects real state', report && report.pairCount === 0 && report.signal === 'neutral');
}

// --- the hook path: silent catch must not be the only safety net ---
{
  const model = { lariDiscourseMiner: legacyState() };
  // Mirrors api.noteConversationTurn + the per-turn hook in swarm_model_runtime.js.
  function hookPath(modelArg, t) {
    try {
      return miner.noteTurn(modelArg, t || {}, stubBindings());
    } catch (_) { return { signal: 'neutral', cues: [], pairCount: 0 }; }
  }
  const before = model.lariDiscourseMiner.turnLog.length;
  const r = hookPath(model, turn('are you a he', 'yes', 'self_identity'));
  const after = model.lariDiscourseMiner.turnLog.length;
  check('hook path: no throw on legacy state', true);
  check('hook path: turn actually recorded (not silently swallowed)', after === before + 1, `before=${before} after=${after}`);
  check('hook path: report is real (successOperators field present)', r && typeof r.successOperators === 'number', JSON.stringify(r && r.signal));
}

// --- end-to-end instruction pair on a migrated legacy state ---
{
  const model = { lariDiscourseMiner: legacyState() };
  const b = stubBindings();
  miner.noteTurn(model, turn('what time is it', '10:00', 'time'), b);
  const r = miner.noteTurn(model, turn("when i say brb just say 'got it'", 'ok', 'open_chat'), b);
  const s = model.lariDiscourseMiner;
  check('instruction pair completes immediately on migrated state', s.pairs.length === 1, `pairs=${s.pairs.length}`);
  const p = s.pairs[0];
  check('instruction pair has prompt + corrected answer', p && p.prompt === 'brb' && p.correctedAnswer === 'got it',
    p && JSON.stringify({ prompt: p.prompt, correctedAnswer: p.correctedAnswer, via: p.via }));
  check('instruction seeds success exemplar', s.successExemplars && s.successExemplars.brb && s.successExemplars.brb.instructed === true,
    JSON.stringify(Object.keys(s.successExemplars || {})));
  // Two matching replies confirm the instructed rule -> 3rd observation induces the operator.
  miner.noteTurn(model, turn('brb', 'got it', 'open_chat'), b);
  miner.noteTurn(model, turn('brb', 'got it', 'open_chat'), b);
  check('instructed rule induces a success operator', s.successOperators.length >= 1, `operators=${s.successOperators.length}`);
  check('success induction audited', s.inductions.some(i => i.learned && i.kind === 'success_exemplar'), `inductions=${s.inductions.length}`);
  void r;
}

// --- repeated success on a migrated legacy state induces an operator ---
{
  const model = { lariDiscourseMiner: legacyState() };
  const b = stubBindings();
  const joke = 'Why do Java developers wear glasses? Because they do not C#.';
  for (let i = 0; i < 3; i++) miner.noteTurn(model, turn('tell me a joke', joke), b);
  const s = model.lariDiscourseMiner;
  check('repeated success induces >= 1 operator on migrated state', s.successOperators.length >= 1, `operators=${s.successOperators.length}`);
}

// --- corrupted key shapes migrate instead of throwing ---
{
  const model = { lariDiscourseMiner: legacyState({ successOperators: 'oops', successExemplars: ['not', 'an', 'object'] }) };
  let threw = null;
  try { miner.noteTurn(model, turn('hi', 'hello'), stubBindings()); } catch (e) { threw = e; }
  const s = model.lariDiscourseMiner;
  check('corrupted successOperators resets to []', threw === null && Array.isArray(s.successOperators), threw && threw.message);
  check('corrupted successExemplars resets to {}', s.successExemplars && typeof s.successExemplars === 'object' && !Array.isArray(s.successExemplars));
}

// --- fresh/degenerate inputs never throw ---
{
  for (const [label, m] of [['empty model', {}], ['null model', null], ['undefined state', { lariDiscourseMiner: undefined }]]) {
    let threw = null, r = null;
    try { r = miner.noteTurn(m, turn('hi', 'hello'), stubBindings()); } catch (e) { threw = e; }
    check(`${label}: noteTurn never throws`, threw === null && r && typeof r === 'object', threw && threw.message);
  }
}

console.log(`\n${passed} passed, ${failed} failed${failures.length ? ' — ' + failures.join(', ') : ''}`);
process.exit(failed ? 1 : 0);
