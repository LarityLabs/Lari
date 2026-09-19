/**
 * Integration test for the round-2 miner-learning legacy migration
 * (fix round 3, BUG 1).
 *
 * This drives a scripted conversation against a SCRATCH COPY of a
 * legacy-state model (the live model's `lariDiscourseMiner` shape: version 1,
 * no successOperators / successExemplars keys). The live model file is only
 * ever COPIED (read-only) into /tmp; nothing is written back to it. If the
 * live model is not present (e.g. another machine), a legacy-shaped model is
 * built programmatically instead.
 *
 * The conversation must produce >= 1 induction on the migrated state, and
 * the copy's pre-existing history must survive migration.
 *
 * Run: node scripts/test_lari_miner_legacy_integration.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const miner = require('../swarm_discourse_miner.js');

const LIVE_MODEL = '/home/hatch/workspace/lari-live/users/5651270693/model.json';

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
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

function turn(userMessage, lariAnswer = 'ok', intent = 'open_chat') {
  return { userMessage, lariAnswer, intent, confidence: 0.8, userScope: 'default' };
}

// --- build the scratch legacy-state model in /tmp (live model is read-only) ---
let scratchPath = null;
let model = null;
let source = null;
let historyTurns = 0;
try {
  scratchPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lari-legacy-int-')), 'model.json');
  if (fs.existsSync(LIVE_MODEL)) {
    fs.copyFileSync(LIVE_MODEL, scratchPath); // COPY, never mutate the live file
    model = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
    source = 'live copy';
  } else {
    source = 'programmatic';
  }
} catch (e) {
  source = 'programmatic';
}
if (source === 'programmatic') {
  model = {
    lariDiscourseMiner: {
      version: 1, lastTurn: null,
      turnLog: Array.from({ length: 10 }, (_, i) => ({
        at: '2026-09-18T00:00:00.000Z', userScope: 'default',
        userMessage: `old question ${i}`, lariAnswer: 'old answer', intent: 'open_chat', confidence: 0.8, signal: 'neutral'
      })),
      pendingRecovery: null, pairs: [], clusters: {},
      calibration: { open_chat: { turns: 10, corrections: 0 } },
      inductions: [], discardedRecoveries: 0
    }
  };
  if (scratchPath) fs.writeFileSync(scratchPath, JSON.stringify(model));
}
historyTurns = model.lariDiscourseMiner.turnLog.length;
console.log(`  (scratch model source: ${source}, pre-existing turns: ${historyTurns})`);
check('scratch model is legacy-shaped (no success keys)',
  !('successOperators' in model.lariDiscourseMiner) && !('successExemplars' in model.lariDiscourseMiner));

// --- scripted conversation (driven through the hook-style path) ---
const b = stubBindings();
function hook(modelArg, t) {
  try { return miner.noteTurn(modelArg, t || {}, b); }
  catch (_) { return { signal: 'neutral', cues: [], pairCount: 0 }; }
}

const joke = 'Why do Java developers wear glasses? Because they do not C#.';
let threw = null;
try {
  hook(model, turn('hey whats up', 'not much, what about you', 'small_talk'));
  hook(model, turn('hey whats up', 'not much, what about you', 'small_talk')); // variant-free repeat builds the exemplar
  hook(model, turn('tell me a joke', joke));
  hook(model, turn('tell me a joke', joke));
  hook(model, turn('tell me a joke', joke));                                     // 3rd -> success operator induced
  hook(model, turn('naw man, that wasnt an answer', 'ok', 'open_chat'));        // Greg-style correction
  hook(model, turn("when i say brb just say 'got it'", 'ok', 'open_chat'));    // instruction -> immediate pair
  hook(model, turn('brb', 'got it', 'open_chat'));
  hook(model, turn('brb', 'got it', 'open_chat'));                              // 3rd observation -> operator
  hook(model, turn('thanks', 'anytime', 'open_chat'));                          // approval
} catch (e) { threw = e; }

const s = model.lariDiscourseMiner;
check('scripted conversation: no throws', threw === null, threw && threw.message);
check('legacy state migrated (success keys present)',
  Array.isArray(s.successOperators) && s.successExemplars && typeof s.successExemplars === 'object');
check('pre-existing history preserved', s.turnLog.length === historyTurns + 10,
  `turnLog=${s.turnLog.length} expected=${historyTurns + 10}`);
check('instruction pair completed', s.pairs.some(p => p.via === 'instruction'), `pairs=${s.pairs.length}`);
check('instructed exemplar seeded', s.successExemplars.brb && s.successExemplars.brb.instructed === true);
const learned = s.inductions.filter(i => i.learned);
check('scripted conversation produces >= 1 induction', learned.length >= 1, `learned=${learned.length}`);
check('success operators recorded', s.successOperators.length >= 1, `operators=${s.successOperators.length}`);
console.log('  induced operators:');
for (const o of s.successOperators) {
  console.log(`    - stimulus="${o.stimulusKey}" evidence=${o.evidenceCount} response="${String(o.responseExample).slice(0, 60)}"`);
}

// --- the live model file is byte-untouched ---
if (fs.existsSync(LIVE_MODEL)) {
  const liveRaw = fs.readFileSync(LIVE_MODEL, 'utf8');
  const live = JSON.parse(liveRaw);
  check('live model miner state still legacy (untouched)',
    !('successOperators' in live.lariDiscourseMiner) && !('successExemplars' in live.lariDiscourseMiner));
  check('live model turnLog unchanged', live.lariDiscourseMiner.turnLog.length === historyTurns,
    `live turnLog=${live.lariDiscourseMiner.turnLog.length} copy started at=${historyTurns}`);
}

// --- clean up the scratch copy ---
try { if (scratchPath) fs.rmSync(path.dirname(scratchPath), { recursive: true, force: true }); } catch (_) {}

console.log(`\n${passed} passed, ${failed} failed${failures.length ? ' — ' + failures.join(', ') : ''}`);
process.exit(failed ? 1 : 0);
