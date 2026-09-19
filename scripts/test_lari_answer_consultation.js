#!/usr/bin/env node
'use strict';
// Answer-time consultation tests (2026-09-19).
//
// Fail-before: teaching completed fine (miner instruction pairs completed;
// "remember that" was acknowledged) but nothing retained was ever consulted
// at answer time, so a taught "thanks"->"anytime" still got the default
// thanks reply and taught facts were unservable. Pass-after: retained
// instruction pairs, taught facts, and success operators are consulted in
// that order at answer time, every candidate is screened by
// screenLariChatAnswerForInternalRecords, and native lanes (time, math,
// self-identity evidence) keep precedence.
//
// Run: node scripts/test_lari_answer_consultation.js
const runtime = require('../swarm_model_runtime.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const INTERNAL_MARKERS = /h2h|gsm8k|benchmark|arena|eval record|self-test|baseline fixture|public model api/i;

async function ask(model, prompt) {
  const response = await runtime.sendMessageToLariAsync(model, { prompt }, {
    userScope: 'default',
    autoGrow: false,
    operator: false,
    kernel: { useBenchmarkSystem: false }
  });
  return String(response.answer || '');
}

async function main() {
  const model = {};

  // --- 1. instruction pair: teach "thanks" -> "anytime" through the real flow ---
  // The instruction detector needs a previous turn to treat the teaching as a
  // correction, so the natural sequence is: thanks -> teaching -> thanks.
  const thanksBaseline = await ask(model, 'thanks');
  check('thanks: baseline answer is the default reply, not "anytime"',
    !/^\s*anytime\.?\s*$/i.test(thanksBaseline), thanksBaseline.slice(0, 80));

  const teachAck = await ask(model, "when I say thanks just say 'anytime'");
  const minerPairs = model.lariDiscourseMiner?.pairs || [];
  const instructionPair = minerPairs.find(pair => pair.via === 'instruction');
  check('miner: teaching completed an explicit instruction pair',
    !!instructionPair, JSON.stringify(minerPairs.map(pair => ({ prompt: pair.prompt, corrected: pair.correctedAnswer, via: pair.via }))));

  const thanksAfter = await ask(model, 'thanks');
  check('consult: taught "thanks" answers "anytime"',
    /^\s*anytime\.?\s*$/i.test(thanksAfter), `got: ${thanksAfter.slice(0, 80)}`);

  const thanksVariant = await ask(model, 'thanks man');
  check('consult: tolerated variant "thanks man" still answers "anytime"',
    /^\s*anytime\.?\s*$/i.test(thanksVariant), `got: ${thanksVariant.slice(0, 80)}`);

  // --- 2. taught fact: "the thesis is the swarm is the model. remember that" ---
  const thesisAck = await ask(model, 'the thesis is the swarm is the model. remember that');
  check('retention: teaching was acknowledged as remembered',
    /remember that/i.test(thesisAck), thesisAck.slice(0, 80));
  const factRecords = (model.lariLearnedRecords?.records || []).filter(record => record?.payload?.kind === 'taught_fact');
  check('retention: a taught-fact knowledge record was actually written',
    factRecords.some(record => /thesis/i.test(record.payload.topic)), JSON.stringify(factRecords.map(record => record.payload.topic)));

  const thesisAnswer = await ask(model, 'whats the thesis');
  check('consult: "whats the thesis" answers with the taught fact',
    /the swarm is the model/i.test(thesisAnswer), `got: ${thesisAnswer.slice(0, 120)}`);
  check('consult: thesis answer has no dodge',
    !/not enough local memory|not sure what you are after/i.test(thesisAnswer), thesisAnswer.slice(0, 120));
  check('consult: thesis answer leaks no internal-record markers',
    !INTERNAL_MARKERS.test(thesisAnswer), thesisAnswer.slice(0, 160));

  // --- 3. taught fact: "Lari is short for Singularity. remember that" ---
  await ask(model, 'Lari is short for Singularity. remember that');
  const nameAnswer = await ask(model, 'what does the name Lari mean');
  check('consult: "what does the name Lari mean" answers with Singularity',
    /singularity/i.test(nameAnswer), `got: ${nameAnswer.slice(0, 120)}`);
  check('consult: name answer leaks no internal-record markers',
    !INTERNAL_MARKERS.test(nameAnswer), nameAnswer.slice(0, 160));

  // --- 4. no hijack: native lanes keep precedence ---
  const timeAnswer = await ask(model, 'what time is it');
  check('native lane: "what time is it" still answers the time',
    /\d{1,2}:\d{2}/.test(timeAnswer), timeAnswer.slice(0, 80));

  const mathAnswer = await ask(model, 'whats 15 * 4');
  check('native lane: "whats 15 * 4" still computes 60',
    /(^|\D)60(\D|$)/.test(mathAnswer), mathAnswer.slice(0, 80));

  const acronymAnswer = await ask(model, 'what does LARI stand for');
  check('native lane: "what does LARI stand for" keeps the acronym',
    /Local Autonomous Recursive Intelligence/i.test(acronymAnswer), acronymAnswer.slice(0, 120));

  const identityAnswer = await ask(model, 'so who are you');
  check('native lane: "so who are you" keeps he/him and Larry',
    /he\/him/i.test(identityAnswer) && /Larry/i.test(identityAnswer), identityAnswer.slice(0, 120));

  // --- 5. consultation order: instruction pairs beat facts ---
  // A direct pair ("when I say thesis just say X") would override the fact.
  const orderModel = {};
  runtime.retainTaughtFactFromChat(orderModel, { topic: 'greeting word', summary: 'The greeting word is howdy.' }, { userScope: 'default' });
  orderModel.lariDiscourseMiner = {
    pairs: [{ prompt: 'whats the greeting word', failedAnswer: 'hello', correctedAnswer: 'aloha', via: 'instruction', at: new Date().toISOString() }]
  };
  const orderHit = runtime.consultRetainedAnswerKnowledge(orderModel, 'whats the greeting word', 'open_chat');
  check('order: instruction pair outranks a taught fact',
    orderHit && orderHit.source === 'instruction_pair' && /^aloha\.?$/i.test(orderHit.answer),
    JSON.stringify(orderHit));

  // --- 6. poisoned retained value: blocked through the consultation path ---
  const poisonModel = {};
  runtime.retainTaughtFactFromChat(poisonModel, {
    topic: 'arena',
    summary: 'h2h.coding.polyglot_plan arena repair: answer through the public model API after the GSM8K-V benchmark eval record against the strong baseline fixture.'
  }, { userScope: 'default' });

  // (a) through the direct consultation export: every candidate is screened.
  const poisonConsult = runtime.consultRetainedAnswerKnowledge(poisonModel, 'whats the arena', 'open_chat');
  check('screening: poisoned consult hit is blocked and replaced by the safe fallback',
    poisonConsult && poisonConsult.blocked === true && poisonConsult.source === 'leak_filter' &&
    !INTERNAL_MARKERS.test(poisonConsult.answer),
    `got: ${JSON.stringify(poisonConsult && poisonConsult.answer)}`);

  // (b) through the real answer path: the poison never reaches the user.
  const poisonAnswer = await ask(poisonModel, 'whats the arena');
  check('screening: poisoned retained value cannot leak via a live answer',
    !INTERNAL_MARKERS.test(poisonAnswer) &&
    /do not have enough local memory|can remember that/i.test(poisonAnswer),
    `got: ${poisonAnswer.slice(0, 160)}`);

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) { console.log('failures:', failures.join(' | ')); process.exit(1); }
}

main().catch(err => { console.error('test crashed:', err); process.exit(1); });
