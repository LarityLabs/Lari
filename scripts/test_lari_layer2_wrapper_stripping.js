#!/usr/bin/env node
'use strict';
// Layer-2 tests: extraction must store the FACT, not the meta-instruction wrapper.
//
// Session 5 (2026-09-19): the correction "Lari is short for Singularity.
// when I ask what the name means, say that" produced topic `name mean` /
// summary ". when I ask what the name means, say that." (the wrapper, not
// the fact), and the wrapper was then served VERBATIM as a chat answer.
// The clean re-teach created a good fact, but the poisoned record's
// triggers still out-matched the real question.
//
// (a) extraction strips the wrapper and keeps the declarative fact;
// (b) a pure directive ("when I say thanks just say 'anytime'") is not a
//     fact -> null (it belongs to the miner's instruction-pair mechanism);
// (c) consult-time: a poisoned record + a clean record on the same topic
//     in a scratch model -> consult returns the clean fact.
// Extra: the verbatim T26 shape (remember-that mid-message) stores nothing
// poisonous; a legit multi-sentence teaching is still stored fully.
//
// Run: node scripts/test_lari_layer2_wrapper_stripping.js
// Fail-before: LAYER2_RUNTIME_PATH=/tmp/layer2_pristine/swarm_model_runtime.js node ...
const runtime = require(process.env.LAYER2_RUNTIME_PATH || '../swarm_model_runtime.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function main() {
  // --- (a) wrapper stripping: fact kept, wrapper dropped ---
  const wrapped = runtime.extractTaughtFactFromChat(
    "Lari is short for Singularity. when I ask what the name means, say that. remember that");
  check('a1: wrapped teaching extracts a fact', !!wrapped, JSON.stringify(wrapped));
  check('a2: summary is the declarative fact',
    wrapped && wrapped.summary === 'Lari is short for Singularity.',
    `got: ${JSON.stringify(wrapped && wrapped.summary)}`);
  check('a3: summary has no wrapper residue',
    wrapped && !/when i ask|say that/i.test(wrapped.summary),
    `got: ${JSON.stringify(wrapped && wrapped.summary)}`);
  check('a4: topic derived from the cleaned fact',
    wrapped && /lari/i.test(wrapped.topic) && !/mean/i.test(wrapped.topic),
    `got: ${JSON.stringify(wrapped && wrapped.topic)}`);

  // --- (b) pure directive is not a fact ---
  const directive = runtime.extractTaughtFactFromChat(
    "when I say thanks just say 'anytime'. remember that");
  check('b1: pure directive extracts null', directive === null, JSON.stringify(directive));
  const bare = runtime.extractTaughtFactFromChat('say that. remember that');
  check('b2: bare "say that" extracts null', bare === null, JSON.stringify(bare));

  // --- extra: verbatim T26 shape (remember-that mid-message) ---
  const t26 = runtime.extractTaughtFactFromChat(
    'naw man. Lari is short for Singularity. I told you to remember that. when I ask what the name means, say that');
  check('t26: mid-message remember-that stores nothing poisonous',
    t26 === null || !/when i ask/i.test(t26.summary),
    JSON.stringify(t26));

  // --- extra: legit multi-sentence teaching stays whole ---
  const multi = runtime.extractTaughtFactFromChat(
    'my goal is X. chat quality first, then agentic coding. remember that');
  check('multi: both declarative sentences retained',
    !!multi && /my goal is x/i.test(multi.summary) && /chat quality first/i.test(multi.summary),
    JSON.stringify(multi && multi.summary));

  // --- (c) consult-time poison defense on a scratch model ---
  const model = {};
  runtime.retainTaughtFactFromChat(model,
    { topic: 'Lari', summary: 'Lari is short for Singularity.' }, { userScope: 'default' });
  // Poisoned record written NEWER so it iterates first (retention prepends).
  runtime.retainTaughtFactFromChat(model,
    { topic: 'name mean', summary: '. when I ask what the name means, say that.' }, { userScope: 'default' });
  const records = model.lariLearnedRecords.records;
  check('c1: scratch model holds both records', records.length === 2, `got ${records.length}`);

  const consultOut = runtime.consultRetainedAnswerKnowledge(model, 'what does the name Lari mean', 'open_chat');
  const text = String((consultOut && consultOut.answer) || '');
  check('c2: consult returns an answer', text.length > 0, `got: ${text.slice(0, 80)}`);
  check('c3: consult serves the clean fact, not the wrapper',
    /singularity/i.test(text) && !/when i ask/i.test(text),
    `got: ${text.slice(0, 120)}`);

  // --- extra: poison-only model never serves the wrapper ---
  const poisonOnly = {};
  runtime.retainTaughtFactFromChat(poisonOnly,
    { topic: 'name mean', summary: '. when I ask what the name means, say that.' }, { userScope: 'default' });
  const poisonOut = runtime.consultRetainedAnswerKnowledge(poisonOnly, 'what does the name mean', 'open_chat');
  check('poison-only: wrapper is never served verbatim',
    !/when i ask/i.test(String((poisonOut && poisonOut.answer) || '')),
    `got: ${String((poisonOut && poisonOut.answer) || '').slice(0, 120)}`);

  console.log(`\nlayer2 wrapper stripping: ${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('failures: ' + failures.join(', ')); process.exit(1); }
}

main();
