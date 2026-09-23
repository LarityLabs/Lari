#!/usr/bin/env node
'use strict';
// Layer-1: taught-fact extraction must fire on ALL chat answer paths, not
// just the general-chat path.
//
// Session 5 (T8, T41) proved the failure: "the thesis is the swarm is the
// model. remember that" routed through answer_with_repaired_skill (capability
// graph -> repaired skill) and extractTaughtFactFromChat never ran, so no
// thesis fact was ever stored (12 taught facts, zero with thesis triggers).
// The same held for the session_context_memory path ("why did I build you").
//
// This test drives the REAL entry point (sendMessageToLariAsync) on scratch
// models and asserts:
//   1. repaired-skill path: the T8 reproduction routes via
//      answer_with_repaired_skill AND stores a taught_fact record.
//   2. session-context-memory path: extraction fires there too.
//   3. idempotency: re-teach updates in place (one record per stable id).
//   4. guards preserved: trailing "?" and sub-3-word fragments store nothing.
//   5. external_model_calls stays 0 across all turns.
//
// Fail-before: run against a pristine clone; the record assertions fail.
// Pass-after: all pass once extraction is hoisted to the chat entry point.
//
// Run: node scripts/test_lari_layer1_extraction_paths.js
const runtime = require('../swarm_model_runtime.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function taughtFacts(model) {
  return (model.lariLearnedRecords?.records || []).filter(r => r?.payload?.kind === 'taught_fact');
}

// A compiled skill that mimics the T8 setup: a repaired answer skill whose
// triggers match the thesis teaching, so the kernel serves the turn via
// answer_with_repaired_skill instead of runGeneralChat.
function buildRepairedSkillModel() {
  return {
    compiledSkills: [{
      id: 'answer_repair_thesis_stub',
      capability: 'answer_repair',
      topic: 'thesis acknowledgment answer repair',
      status: 'answer_repair_ready',
      summary: 'Answer-template fallback for thesis-style teachings.',
      answerTemplate: 'I can remember that and use it in future answers.',
      confidence: 0.9,
      triggerConcepts: ['thesis', 'swarm', 'model', 'remember'],
      lariSelection: { canonical: true }
    }]
  };
}

async function ask(model, prompt) {
  return await runtime.sendMessageToLariAsync(model, { prompt }, {
    userScope: 'default',
    autoGrow: false,
    operator: false,
    persistLearnedModel: false,
    kernel: { useBenchmarkSystem: false }
  });
}

function externalModelCallsLeaked(response) {
  return /"external_model_calls"\s*:\s*[1-9]/.test(JSON.stringify(response || {}));
}

async function main() {
  // --- 1. T8 reproduction: repaired-skill path must store the teaching ---
  const repaired = buildRepairedSkillModel();
  const thesisTurn = await ask(repaired, 'the thesis is the swarm is the model. remember that');
  const thesisAction = thesisTurn?.action || thesisTurn?.record?.action || null;
  check('T8 routing reproduced: turn served via answer_with_repaired_skill',
    thesisAction === 'answer_with_repaired_skill', `action was: ${thesisAction}`);
  const thesisFacts = taughtFacts(repaired).filter(r => /thesis/i.test(`${r.payload?.topic || ''} ${r.payload?.summary || ''}`));
  check('LAYER-1: repaired-skill path stored a thesis taught_fact record',
    thesisFacts.length >= 1,
    `taught_facts: ${JSON.stringify(taughtFacts(repaired).map(r => r.payload?.topic))}`);
  if (thesisFacts.length) {
    check('LAYER-1: stored fact summary carries the thesis content',
      /the swarm is the model/i.test(thesisFacts[0].payload.summary), thesisFacts[0].payload.summary);
  }

  // --- 2. idempotency: re-teach updates in place ---
  const beforeCount = taughtFacts(repaired).length;
  const reTeach = await ask(repaired, 'the thesis is the swarm is the model. remember that');
  const afterCount = taughtFacts(repaired).length;
  const thesisIds = taughtFacts(repaired)
    .filter(r => /thesis/i.test(`${r.payload?.topic || ''} ${r.payload?.summary || ''}`))
    .map(r => r.id);
  check('idempotent: re-teach does not duplicate the thesis record',
    afterCount === beforeCount && new Set(thesisIds).size === thesisIds.length,
    `before=${beforeCount} after=${afterCount}`);
  check('external_model_calls stayed 0 on the repaired-skill turns',
    !externalModelCallsLeaked(thesisTurn) && !externalModelCallsLeaked(reTeach));

  // --- 3. session_context_memory path must store the teaching ---
  const ctx = {};
  await ask(ctx, 'my goal is testing lari memory lanes'); // seeds session currentGoal
  const whyTurn = await ask(ctx, 'why did I build you? remember that my goal is a local persistent AI');
  const whyAction = whyTurn?.action || whyTurn?.record?.action || null;
  // Post Layer-4, factual origin questions are deliberately NOT served by
  // session_context_memory (that path must not compose factual answers from
  // raw recent turns). Layer-1's guarantee is unchanged and is what this
  // section tests: the teaching is stored no matter which path serves the
  // answer — extraction now runs at the kernel entry, before routing.
  check('origin question not served by session_context_memory composition',
    whyAction !== 'session_context_memory', `action was: ${whyAction}`);
  const ctxFacts = taughtFacts(ctx).filter(r => /local persistent AI/i.test(`${r.payload?.topic || ''} ${r.payload?.summary || ''}`));
  check('LAYER-1: session_context_memory path stored the taught fact',
    ctxFacts.length >= 1,
    `taught_facts: ${JSON.stringify(taughtFacts(ctx).map(r => r.payload?.summary))}`);
  check('external_model_calls stayed 0 on the context-memory turn',
    !externalModelCallsLeaked(whyTurn));

  // --- 4. guards preserved ---
  const guards = {};
  await ask(guards, 'do you remember that song?');
  await ask(guards, 'remember that blue sky');
  await ask(guards, 'remember that');
  check('guards: questions and sub-3-word fragments store no taught_fact',
    taughtFacts(guards).length === 0,
    `taught_facts: ${JSON.stringify(taughtFacts(guards).map(r => r.payload?.summary))}`);

  // --- 5. code-lane turns extract too (FIX A, 2026-09-19 session 6) ---
  // "...repo...fix...failing test" classifies as the code lane, but the
  // kernel-entry gate fires for mode === 'code' as well, so the teaching is
  // STORED; the teaching turn keeps its code-lane reply. This section used
  // to assert the pre-fix behavior (no extraction on code-lane turns);
  // updated 2026-09-23 to the intended behavior, matching
  // test_lari_code_lane_extraction.js and docs/self-learning.md.
  const code = {};
  await ask(code, 'remember that the repo build failed; fix the failing test');
  const codeFacts = taughtFacts(code);
  check('code-lane teaching is extracted and stored as a taught_fact',
    codeFacts.length === 1 && /repo build failed/i.test(codeFacts[0]?.payload?.summary || ''),
    `taught_facts: ${JSON.stringify(codeFacts.map(r => r.payload?.summary))}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILURES:', failures.join(', ')); process.exit(1); }
}

main().catch(error => { console.error('FATAL', error); process.exit(1); });
