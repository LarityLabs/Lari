#!/usr/bin/env node
'use strict';
// Layer-3 tests: evidence relevance ranking + taught-fact precedence over
// weak evidence (2026-09-19).
//
// Fail-before (tutoring session 5, T54/T56/T57/T58): after teaching three
// facts about Greg (books/Fracktal Verse, Fortnite content, home
// server/Dell), "what books has Greg published", "does Greg play
// fortnite" and "tell me about Greg" ALL got
//   "Here is the best answer from local model memory:
//    - Greg is building a home server on an old Dell Latitude."
// The home-server fact's only shared token with those questions was "greg"
// (single-shared-token bullying: its topic is the bare subject "Greg",
// so topicCoverage hits 1.0), and the evidence route composed the answer
// before taught facts were ever consulted.
//
// Pass-after:
//  1. Evidence relevance tightened: a single shared content token —
//     especially a subject token like a name shared across many taught
//     facts — must not select a fact as evidence.
//  2. Precedence: a strong taught fact (explicit "remember that",
//     confidence >= 0.5, sharing real content beyond a bare subject
//     token) is consulted BEFORE the evidence route composes, and
//     outranks weak evidence — but never hijacks genuinely strong
//     evidence. Strength order: strong taught fact > strong evidence >
//     weak evidence.
//  3. T31 keeps passing: "whats my goal with you" still serves the goal
//     fact (via either path).
//  4. Pinned regressions: thanks -> "anytime"; native lanes (time, math)
//     never hijacked; every consulted candidate still flows through the
//     choke-point filter (screenLariChatAnswerForInternalRecords).
//
// Run: node scripts/test_lari_layer3_evidence_relevance.js
const runtime = require('../swarm_model_runtime.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const INTERNAL_MARKERS = /h2h|gsm8k|benchmark|arena|eval record|self-test|baseline fixture|public model api/i;
const SERVER_FACT = /home server/i;

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

  // --- pinned regression: thanks -> "anytime" (instruction pair) ---
  await ask(model, 'thanks');
  await ask(model, "when I say thanks just say 'anytime'");
  const thanksAfter = await ask(model, 'thanks');
  check('pinned: taught "thanks" still answers "anytime"',
    /^\s*anytime\.?\s*$/i.test(thanksAfter), `got: ${thanksAfter.slice(0, 80)}`);

  // --- teach the session-5 facts through the real entry point ---
  // T9: goal fact (T31 must keep working afterwards).
  await ask(model, 'my goal is a general local model better than the big ones. chat quality first, then agentic coding. remember that');
  // T50: books fact.
  await ask(model, 'yo, back again. Greg has published books on Amazon, including one called The Fracktal Verse Theory of Everything. remember that');
  // T51: fortnite fact.
  await ask(model, 'Greg makes Fortnite content with his crew. remember that');
  // T52: home-server fact (the bully: topic is the bare subject "Greg").
  await ask(model, 'Greg is building a home server on an old Dell Latitude. remember that');

  const factTopics = (model.lariLearnedRecords?.records || [])
    .filter(record => record?.payload?.kind === 'taught_fact')
    .map(record => record.payload.topic);
  check('setup: all four taught facts were retained',
    factTopics.length === 4, JSON.stringify(factTopics));

  // --- 1. "what books has Greg published" -> books fact, NOT the server fact ---
  const booksAnswer = await ask(model, 'what books has Greg published');
  check('books: answer serves the books fact',
    /fracktal verse|published books on amazon/i.test(booksAnswer), `got: ${booksAnswer.slice(0, 140)}`);
  check('books: answer is not the home-server fact',
    !SERVER_FACT.test(booksAnswer), `got: ${booksAnswer.slice(0, 140)}`);

  // --- 2. "does Greg play fortnite" -> fortnite fact, NOT the server fact ---
  const fortniteAnswer = await ask(model, 'does Greg play fortnite');
  check('fortnite: answer serves the fortnite fact',
    /fortnite content/i.test(fortniteAnswer), `got: ${fortniteAnswer.slice(0, 140)}`);
  check('fortnite: answer is not the home-server fact',
    !SERVER_FACT.test(fortniteAnswer), `got: ${fortniteAnswer.slice(0, 140)}`);

  // --- 3. "tell me about Greg" -> NOT the server fact alone on a bare "greg" match ---
  const aboutAnswer = await ask(model, 'tell me about Greg');
  check('about-greg: not the server fact alone on a bare "greg" match',
    !SERVER_FACT.test(aboutAnswer), `got: ${aboutAnswer.slice(0, 140)}`);

  // --- 4. T31 keeps passing: "whats my goal with you" -> goal fact ---
  const goalAnswer = await ask(model, 'whats my goal with you');
  check('goal (T31): still serves the goal fact',
    /general local model better than the big ones/i.test(goalAnswer), `got: ${goalAnswer.slice(0, 140)}`);

  // --- 5. native lanes never hijacked ---
  const timeAnswer = await ask(model, 'what time is it');
  check('native lane: "what time is it" still answers the time',
    /\d{1,2}:\d{2}/.test(timeAnswer), timeAnswer.slice(0, 80));
  const mathAnswer = await ask(model, 'whats 12 * 8');
  check('native lane: "whats 12 * 8" still computes 96',
    /(^|\D)96(\D|$)/.test(mathAnswer), mathAnswer.slice(0, 80));

  // --- 6. choke-point filter still screens every consulted candidate ---
  const poisonModel = {};
  runtime.retainTaughtFactFromChat(poisonModel, {
    topic: 'arena',
    summary: 'h2h.coding.polyglot_plan arena repair: answer through the public model API after the GSM8K-V benchmark eval record against the strong baseline fixture.'
  }, { userScope: 'default' });
  const poisonAnswer = await ask(poisonModel, 'whats the arena');
  check('choke-point: poisoned retained value cannot leak via a live answer',
    !INTERNAL_MARKERS.test(poisonAnswer), `got: ${poisonAnswer.slice(0, 160)}`);

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) { console.log('failures:', failures.join(' | ')); process.exit(1); }
}

main().catch(err => { console.error('test crashed:', err); process.exit(1); });
