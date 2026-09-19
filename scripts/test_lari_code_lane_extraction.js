#!/usr/bin/env node
'use strict';
// Code-lane extraction hole (FIX A, 2026-09-19 tutoring session 6).
//
// Fail-before: a teaching on a code-lane turn (trigger words like bug/fix/
// verify/review route to action:code) got the canned code-lane reply while the
// kernel-entry taught-fact gate (request.mode === 'chat' only) skipped
// retention — 0/3 teachings stuck in the session. Pass-after: the kernel-entry
// gate also fires for mode === 'code', so the fact is STORED on the teaching
// turn. The teaching turn itself keeps its canned code-lane reply; the answer
// path is untouched.
//
// Fail-before proof: copy this file into a pristine clone of the runtime
// (gate reverted to chat-only) and run it there first — tests 1-3 fail, 4-6 pass.
//
// Run: node scripts/test_lari_code_lane_extraction.js
const runtime = require('../swarm_model_runtime.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const CODE_CANNED = /I routed the coding task locally/i;

async function ask(model, prompt) {
  const response = await runtime.sendMessageToLariAsync(model, { prompt }, {
    userScope: 'default',
    autoGrow: false,
    operator: false,
    kernel: { useBenchmarkSystem: false }
  });
  return { answer: String(response.answer || ''), response };
}

function taughtFacts(model) {
  const recs = (model.lariLearnedRecords && model.lariLearnedRecords.records) || [];
  return recs.filter(r => r && r.status === 'active' && r.type === 'knowledge'
    && r.payload && r.payload.kind === 'taught_fact');
}

const TEACH = "here's the debugging method, remember that: the debugging steps are reproduce the bug, shrink the case, fix it, then verify the fix";

async function main() {
  const model = {};

  // (1) Teaching on a code-lane turn IS retained.
  const t1 = await ask(model, TEACH);
  check('code-lane teaching turn gets the canned code-lane reply', CODE_CANNED.test(t1.answer),
    JSON.stringify(t1.answer.slice(0, 100)));
  check('code-lane turn makes zero external model calls', !(t1.response.external_model_calls > 0));
  const facts1 = taughtFacts(model);
  check('code-lane teaching is retained as a taught_fact', facts1.length === 1,
    `taught_fact count=${facts1.length}`);
  check('retained fact holds the taught content',
    facts1.length === 1 && /reproduce the bug/i.test(facts1[0].payload.summary || ''),
    facts1.length === 1 ? JSON.stringify(facts1[0].payload.summary) : 'no fact');

  // Idempotent re-teach: identical teaching does not duplicate the record.
  await ask(model, TEACH);
  const facts2 = taughtFacts(model);
  check('re-teaching the same fact is idempotent (stable id, update in place)',
    facts2.length === 1, `taught_fact count=${facts2.length}`);

  // (2) A paraphrased retest serves the stored fact.
  const t3 = await ask(model, 'what are the steps for debugging');
  check('paraphrased retest serves the taught fact',
    /reproduce the bug/i.test(t3.answer) && !CODE_CANNED.test(t3.answer),
    JSON.stringify(t3.answer.slice(0, 120)));
  check('retest makes zero external model calls', !(t3.response.external_model_calls > 0));

  // (4) Genuine code tasks still get the canned code-lane reply, and a
  // non-teaching code turn retains nothing.
  const model2 = {};
  const t4 = await ask(model2, 'fix the bug in my code, it crashes on empty input');
  check('genuine code task still gets the canned code-lane reply', CODE_CANNED.test(t4.answer),
    JSON.stringify(t4.answer.slice(0, 100)));
  check('non-teaching code turn retains no taught_fact', taughtFacts(model2).length === 0,
    `taught_fact count=${taughtFacts(model2).length}`);

  // Regression guards.
  const model3 = {};
  const t5 = await ask(model3, 'a race condition is when two threads touch shared data at the same time, remember that');
  check('plain chat teaching still retained (Layer 1 behavior intact)',
    taughtFacts(model3).length === 1, `taught_fact count=${taughtFacts(model3).length}`);
  const t6 = await ask(model3, 'what is 12 * 8');
  check('native math lane not hijacked', /\b96\b/.test(t6.answer),
    JSON.stringify(t6.answer.slice(0, 120)));

  console.log(`\n${passed} passed, ${failed} failed${failed ? ' — ' + failures.join('; ') : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
