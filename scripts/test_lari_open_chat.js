#!/usr/bin/env node
'use strict';
// Open-chat routing/generation tests.
//
// Fail-before (2026-09-19 tutoring session): "hey whats up",
// "what does LARI stand for", and "check the thing for me" all collapsed onto
// the identical canned low-memory fallback because classifyChatIntent had no
// compound-greeting or self-identity patterns and synthesizeGeneralChatAnswer
// had no open_chat/self_identity branch. Pass-after: each gets a real,
// intent-appropriate answer, and no two of them share the canned fallback.
//
// Run: node scripts/test_lari_open_chat.js
const runtime = require('../swarm_model_runtime.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const CANNED = /I do not have enough local memory to answer that strongly yet/i;

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
  // --- intent classification ---
  check('classify: "hey whats up" -> small_talk',
    runtime.classifyChatIntent('hey whats up') === 'small_talk');
  check('classify: "yo whats up" -> small_talk',
    runtime.classifyChatIntent('yo whats up') === 'small_talk');
  check('classify: "whats up" -> small_talk',
    runtime.classifyChatIntent('whats up') === 'small_talk');
  check('classify: "what does LARI stand for" -> self_identity',
    runtime.classifyChatIntent('what does LARI stand for') === 'self_identity');
  check('classify: "who are you" -> self_identity',
    runtime.classifyChatIntent('who are you') === 'self_identity');
  check('classify: "who created you" -> self_identity',
    runtime.classifyChatIntent('who created you') === 'self_identity');
  check('classify: "check the thing for me" -> open_chat',
    runtime.classifyChatIntent('check the thing for me') === 'open_chat');
  // Negatives: longer/specific messages must not be swallowed.
  check('classify: "what are you working on" stays open_chat',
    runtime.classifyChatIntent('what are you working on') === 'open_chat');
  check('classify: "who are you talking about" stays open_chat',
    runtime.classifyChatIntent('who are you talking about') === 'open_chat');
  check('classify: "whats up with the server" stays open_chat',
    runtime.classifyChatIntent('whats up with the server') === 'open_chat');

  // --- end-to-end answers (fresh in-memory model) ---
  const model = {};

  const whatsUp = await ask(model, 'hey whats up');
  check('answer: "hey whats up" is not the canned fallback', !CANNED.test(whatsUp), whatsUp.slice(0, 80));
  check('answer: "hey whats up" reads like small talk', /vibing|on your mind|what is up/i.test(whatsUp), whatsUp.slice(0, 80));

  const acronym = await ask(model, 'what does LARI stand for');
  check('answer: acronym is not the canned fallback', !CANNED.test(acronym), acronym.slice(0, 80));
  check('answer: acronym expands LARI', /Local Autonomous Recursive Intelligence/i.test(acronym), acronym.slice(0, 80));

  const vague = await ask(model, 'check the thing for me');
  check('answer: vague request is not the canned fallback', !CANNED.test(vague), vague.slice(0, 80));
  check('answer: vague request gets one clarification question', /\?/.test(vague) && /which thing|what/i.test(vague), vague.slice(0, 80));

  const bluntNo = await ask(model, 'naw man, that wasnt an answer');
  check('answer: blunt correction is acknowledged, not deflected',
    !CANNED.test(bluntNo) && /fair|missed|after/i.test(bluntNo), bluntNo.slice(0, 80));

  const math = await ask(model, 'whats 12 * 8');
  check('answer: "whats 12 * 8" reaches the math lane', !CANNED.test(math) && /96/.test(math), math.slice(0, 80));

  // The previously-broken answers must now differ from each other.
  const distinct = new Set([whatsUp, acronym, vague, bluntNo]).size === 4;
  check('answers are distinct across the previously-broken prompts', distinct);

  // --- neighboring intents still intact ---
  const greeting = await ask(model, 'hey');
  check('regression: greeting intact', !CANNED.test(greeting) && /yo\.|i am here|i am local|what is good/i.test(greeting), greeting.slice(0, 60));
  const joke = await ask(model, 'tell me a joke');
  check('regression: joke intact', !CANNED.test(joke) && joke.length > 10, joke.slice(0, 60));
  const howAreYou = await ask(model, 'how are you');
  check('regression: small_talk intact', !CANNED.test(howAreYou), howAreYou.slice(0, 60));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('failures:', failures.join(', ')); process.exit(1); }
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
