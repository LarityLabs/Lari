#!/usr/bin/env node
'use strict';
// instruction_constraint_realization serving-lane tests.
//
// Fail-before (2026-09-19 tutoring session 6, FIX C): the constraint program
// inside synthesizeLariInstructionFollowingAnswer fabricated filler or
// mangled echoes for ordinary conversational prompts:
//
//   T13 "…give me your pick and one sentence why"
//       -> "Calm words provide useful practical detail."
//   T6  "naw man don't dodge. look at the function. …"
//       -> "The safe implementation validates its input and handles failure explicitly."
//   T14 "never say code works unless it has actually been run and checked. remember that"
//       -> "The safe implementation validates its input and handles failure explicitly."
//   T19 "don't claim something works unless it's been run and checked. remember that"
//       -> "Don't claim something works unless it's been run and ."  (dropped "checked")
//
// Root causes fixed:
//   1. The negative-clause parser treated colloquial negatives as forbidden-
//      word instructions: "don't dodge" -> forbid "dodge"; splitting
//      "…unless it's been run and checked" on "and" -> forbid "checked",
//      which was then stripped out of the echoed taught fact.
//   2. A structural-only constraint (sentence count) with no content to shape
//      fabricated topic-guess filler instead of deferring to the fallback.
//   3. The sentence-count branch discarded usable content for fabrication;
//      it now shapes the real content into the requested sentence count.
//
// To reproduce the fail-before evidence, run against the pristine clone:
//   LARI_RUNTIME_PATH=/tmp/fixc-pristine/swarm_model_runtime.js node scripts/test_lari_instruction_constraint_realization.js
// (expected: the T6/T13/T14/T19 checks FAIL there)
//
// Run: node scripts/test_lari_instruction_constraint_realization.js
const RUNTIME_PATH = process.env.LARI_RUNTIME_PATH || '../swarm_model_runtime.js';
const runtime = require(RUNTIME_PATH);

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const FILLER_T13 = 'Calm words provide useful practical detail.';
const FILLER_CODE = 'The safe implementation validates its input and handles failure explicitly.';
const MANGLED_T19 = "Don't claim something works unless it's been run and .";

const T6 = "naw man don't dodge. look at the function. trace through it with arr = [10, 20, 30]. what does it return and what's wrong?";
const T13 = "naw that wasn't vague, it was an either-or. recursion or iteration for tree traversal — give me your pick and one sentence why";
const T14 = 'never say code works unless it has actually been run and checked. remember that';
const T19 = "don't claim something works unless it's been run and checked. remember that";

async function ask(prompt) {
  const model = {};
  const response = await runtime.sendMessageToLariAsync(model, { prompt }, {
    userScope: 'default',
    autoGrow: false,
    operator: false,
    kernel: { useBenchmarkSystem: false }
  });
  return { answer: String(response.answer || ''), source: response.publicAnswerSource || null };
}

function synth(prompt, fallback) {
  return String(runtime.synthesizeLariInstructionFollowingAnswer(prompt, fallback, { enabled: true }));
}

async function main() {
  // --- (1) echo fidelity: taught content reproduced verbatim, "checked" intact ---
  const t19 = await ask(T19);
  check('T19 end-to-end keeps "checked"',
    /\bchecked\b/i.test(t19.answer) && t19.answer !== MANGLED_T19,
    JSON.stringify(t19.answer));
  check('T19 unit: echo fallback passes through verbatim',
    synth(T19, "Don't claim something works unless it's been run and checked.") === "Don't claim something works unless it's been run and checked.",
    JSON.stringify(synth(T19, "Don't claim something works unless it's been run and checked.")));
  const t14 = await ask(T14);
  // NOTE: on a fresh model T14's "code works" phrasing is grabbed by the code
  // lane ("I routed the coding task locally…") before any constraint applies
  // — that is the session's Finding 1 (code-lane hijack), out of scope for
  // this fix. What this fix guarantees: the constraint lane no longer
  // replaces the answer with the filler or mangles an echo.
  check('T14 end-to-end is not the "safe implementation" filler',
    t14.answer !== FILLER_CODE, JSON.stringify(t14.answer));

  // --- (2) T13 opinion pick-and-defend shape: no filler, lane defers ---
  const t13 = await ask(T13);
  check('T13 end-to-end is not the "Calm words" filler',
    t13.answer !== FILLER_T13 && !t13.answer.includes('Calm words provide useful practical detail'),
    JSON.stringify(t13.answer));
  check('T13 end-to-end is not the code filler either',
    t13.answer !== FILLER_CODE, JSON.stringify(t13.answer));
  check('T13 constraint lane did not fire (deferred to chat)',
    t13.source !== 'native_instruction_constraint_compiler',
    `source=${t13.source} answer=${JSON.stringify(t13.answer)}`);

  // --- (3) T6/T14 shapes: no generic "safe implementation" filler ---
  const t6 = await ask(T6);
  check('T6 end-to-end is not the "safe implementation" filler',
    t6.answer !== FILLER_CODE, JSON.stringify(t6.answer));
  check('T6 constraint lane did not fire (deferred to chat)',
    t6.source !== 'native_instruction_constraint_compiler',
    `source=${t6.source} answer=${JSON.stringify(t6.answer)}`);
  check('T14 end-to-end is not the "safe implementation" filler',
    t14.answer !== FILLER_CODE, JSON.stringify(t14.answer));
  check('T14 unit: generic-ack fallback is not replaced by code filler',
    synth(T14, 'I can remember that and use it in future answers.') !== FILLER_CODE);

  // --- positive controls: real constraints still realized ---
  const pos1 = synth('do not use the word blorp. blorp alpha beta gamma delta epsilon zeta eta theta',
    'blorp alpha beta gamma delta epsilon zeta eta theta blorp');
  check('real forbidden-word constraint still strips',
    !/blorp/i.test(pos1) && /alpha/.test(pos1), JSON.stringify(pos1));
  const posQ = synth('do not say "darn" in your reply. darn alpha beta gamma delta epsilon zeta eta theta',
    'darn alpha beta gamma delta epsilon zeta eta theta darn');
  check('real quoted forbidden word still strips',
    !/darn/i.test(posQ) && /alpha/.test(posQ), JSON.stringify(posQ));
  const moon = synth('write exactly 2 sentences about the moon', 'I do not have enough local memory to answer that strongly yet.');
  check('topic sentence-count fabrication preserved when a topic exists',
    /moon/i.test(moon) && moon !== 'I do not have enough local memory to answer that strongly yet.',
    JSON.stringify(moon));
  const shaped = synth(
    'in exactly one sentence, tell me the sky is blue and vast today and very pretty with birds',
    'The sky is blue and vast today. It is very pretty and the birds sing sweetly.');
  check('usable content is shaped into the sentence count, not discarded for filler',
    !shaped.includes('Calm words') && /^The sky is blue and vast today\./.test(shaped),
    JSON.stringify(shaped));

  console.log(`\n${passed} passed, ${failed} failed${failures.length ? ' — ' + failures.join('; ') : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
