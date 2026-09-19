#!/usr/bin/env node
'use strict';
// Layer-5 (2026-09-19): instruction pairs must complete for UNRECOGNIZED intents.
//
// Fail-before (session 5, D2): "when I ask if we're good just say 'all good
// man'" completed no instruction pair — detectSignal only recognized the
// literal "when i say" as an instructional directive, and extractInstruction
// dropped the "if"-embedded stimulus — so "are we good" (open_chat,
// unrecognized intent) deflected instead of answering "all good man".
//
// Pass-after: the directive is detected as a correction regardless of the
// ask/if phrasing, the fast path completes a via:'instruction' pair with the
// restored direct-question stimulus ("are we good"), and the answer-time
// consult matches it by normalized stimulus text with no intent gate — while
// the pinned D1 shape ("when I say thanks just say 'anytime'") behaves
// identically, including across a JSON reload, and vague non-directive
// corrections still complete no instruction pair.
//
// Run: node scripts/test_lari_layer5_unrecognized_intent_pairs.js
const runtime = require('../swarm_model_runtime.js');
const miner = require('../swarm_discourse_miner.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

async function ask(model, prompt) {
  const response = await runtime.sendMessageToLariAsync(model, { prompt }, {
    userScope: 'default',
    autoGrow: false,
    operator: false,
    kernel: { useBenchmarkSystem: false }
  });
  return String(response.answer || '');
}

function instructionPairs(model) {
  return (model.lariDiscourseMiner?.pairs || []).filter(pair => pair.via === 'instruction');
}

async function main() {
  const DIRECTIVE = "when I ask if we're good just say 'all good man'";

  // --- 1. Unit: the ask/if directive is a correction and extracts cleanly ---
  const signal = miner.detectSignal(DIRECTIVE, null);
  check('miner: ask/if directive detects as a correction',
    signal.signal === 'correction', JSON.stringify(signal));

  const ins = miner.extractInstruction(DIRECTIVE);
  check('miner: ask/if directive extracts stimulus "are we good"',
    !!ins && ins.stimulus === 'are we good', JSON.stringify(ins && { stimulus: ins.stimulus, response: ins.response }));
  check('miner: ask/if directive extracts response "all good man"',
    !!ins && ins.response === 'all good man', JSON.stringify(ins && ins.response));

  // --- 2. Unit: pinned D1 shape is byte-identical to before ---
  const thanksIns = miner.extractInstruction("when I say thanks just say 'anytime'");
  check('miner: pinned thanks shape still extracts stimulus "thanks"',
    !!thanksIns && thanksIns.stimulus === 'thanks', JSON.stringify(thanksIns && thanksIns.stimulus));
  check('miner: pinned thanks shape still extracts response "anytime"',
    !!thanksIns && thanksIns.response === 'anytime', JSON.stringify(thanksIns && thanksIns.response));

  // --- 3. Unit: noteTurn fast path completes the pair with no intent gate ---
  const unitModel = {};
  miner.noteTurn(unitModel, { userMessage: 'hey', lariAnswer: 'Yo. What is up?', intent: 'greeting' });
  const report = miner.noteTurn(unitModel, { userMessage: DIRECTIVE, lariAnswer: 'Noted.', intent: 'open_chat' });
  check('noteTurn: directive signal is correction', report.signal === 'correction', report.signal);
  const unitPair = instructionPairs(unitModel)[0];
  check('noteTurn: via=instruction pair completed for the unrecognized-intent stimulus',
    !!unitPair && unitPair.prompt === 'are we good' && unitPair.correctedAnswer === 'all good man',
    JSON.stringify(unitModel.lariDiscourseMiner?.pairs?.map(p => ({ prompt: p.prompt, via: p.via }))));

  // --- 4. E2E: teach the rule, then ask the unrecognized-intent question ---
  const model = {};
  await ask(model, 'hey');
  await ask(model, DIRECTIVE);
  const e2ePair = instructionPairs(model)[0];
  check('e2e: directive completed a via=instruction pair',
    !!e2ePair, JSON.stringify((model.lariDiscourseMiner?.pairs || []).map(p => ({ prompt: p.prompt, via: p.via }))));
  check('e2e: pair prompt is the restored stimulus "are we good"',
    !!e2ePair && e2ePair.prompt === 'are we good', e2ePair && e2ePair.prompt);

  const answer = await ask(model, 'are we good');
  check('e2e: "are we good" answers "all good man" (no deflection)',
    /^\s*all good man\.?\s*$/i.test(answer), `got: ${answer.slice(0, 80)}`);

  // --- 5. Guard: vague non-directive corrections complete no instruction pair ---
  const guardModel = {};
  await ask(guardModel, 'hey');
  await ask(guardModel, 'naw man, that wasnt an answer');
  check('guard: blunt correction with no dictate completes no instruction pair',
    instructionPairs(guardModel).length === 0,
    JSON.stringify(instructionPairs(guardModel).map(p => p.prompt)));

  const guardModel2 = {};
  await ask(guardModel2, 'hey');
  await ask(guardModel2, "when I ask if we're good"); // directive language, but no dictated response
  check('guard: "when I ask" without a dictated response completes no instruction pair',
    instructionPairs(guardModel2).length === 0,
    JSON.stringify(instructionPairs(guardModel2).map(p => p.prompt)));

  // --- 6. Pinned regression: thanks -> "anytime", live and after reload ---
  const thanksModel = {};
  await ask(thanksModel, 'thanks');
  await ask(thanksModel, "when I say thanks just say 'anytime'");
  const thanksAfter = await ask(thanksModel, 'thanks');
  check('pinned: taught "thanks" answers "anytime"',
    /^\s*anytime\.?\s*$/i.test(thanksAfter), `got: ${thanksAfter.slice(0, 80)}`);
  const thanksVariant = await ask(thanksModel, 'thanks man');
  check('pinned: tolerated variant "thanks man" still answers "anytime"',
    /^\s*anytime\.?\s*$/i.test(thanksVariant), `got: ${thanksVariant.slice(0, 80)}`);

  const reloaded = JSON.parse(JSON.stringify(thanksModel));
  delete reloaded.__lariSourcePath; // never let a scratch model write back anywhere
  const thanksReloaded = await ask(reloaded, 'thanks');
  check('pinned: thanks -> "anytime" survives a JSON reload',
    /^\s*anytime\.?\s*$/i.test(thanksReloaded), `got: ${thanksReloaded.slice(0, 80)}`);

  // --- 7. Reload for the new rule too ---
  const reloaded2 = JSON.parse(JSON.stringify(model));
  delete reloaded2.__lariSourcePath;
  const goodReloaded = await ask(reloaded2, 'are we good');
  check('e2e: "are we good" -> "all good man" survives a JSON reload',
    /^\s*all good man\.?\s*$/i.test(goodReloaded), `got: ${goodReloaded.slice(0, 80)}`);

  console.log(`\nlayer5_unrecognized_intent_pairs: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('failures:', failures.join(', ')); process.exit(1); }
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
