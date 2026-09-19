#!/usr/bin/env node
'use strict';
// Fix B: paraphrase-robust taught-fact consultation (2026-09-19).
//
// Fail-before (tutoring session 6, R8): a stored 4-step debugging fact
//   "First reproduce it, then shrink it to the smallest case that still
//    fails, then change one thing, then confirm the change worked."
// (topic "first reproduce then") failed the paraphrased retest "what are
// the four steps for handling problems" — ZERO shared content tokens, so
// the hard relevance bar (exact shared token + >=50% topic coverage) fell
// through to the low-memory deflection. The near-verbatim retest R8b
// ("the four steps start with reproduce it, then what are the rest")
// passed on the single shared token "reproduce".
//
// Pass-after: consultTaughtFacts runs a soft second pass (exact / stem /
// WordNet-synonym / content-bigram / ordinal-count signals, all on
// NON-subject tokens only, score >= 2) when the hard pass matched nothing.
// The layer-3 anti-bullying guarantee is preserved: a bare-subject question
// never matches a fact whose only shared token is a subject token.
//
// Run: node scripts/test_lari_consultation_paraphrase.js
// Fail-before proof: LARI_RUNTIME_PATH=/tmp/fixb/pristine/swarm_model_runtime.js \
//   node scripts/test_lari_consultation_paraphrase.js
// (expect the three paraphrase cases to FAIL there, bullying cases to PASS)
const runtime = require(process.env.LARI_RUNTIME_PATH || '../swarm_model_runtime.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const INTERNAL_MARKERS = /h2h|gsm8k|benchmark|arena|eval record|self-test|baseline fixture|public model api/i;
const DEFLECTION = /I do not have enough local memory/i;

function teach(model, text) {
  const fact = runtime.extractTaughtFactFromChat(text);
  if (!fact) throw new Error('extraction failed for: ' + text.slice(0, 60));
  return runtime.retainTaughtFactFromChat(model, fact, { userScope: 'default' });
}

function consult(model, question) {
  const hit = runtime.consultRetainedAnswerKnowledge(model, question, 'open_chat', { prompt: question });
  return hit ? hit.answer : null;
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

async function main() {
  const model = {};
  // Session-5 bullying shapes: three distinct facts about Greg; the
  // home-server one's topic is the bare subject "Greg".
  teach(model, 'Greg has published books on Amazon, including The Fracktal Verse. remember that');
  teach(model, 'Greg makes Fortnite content with his crew. remember that');
  teach(model, 'Greg is building a home server on an old Dell Latitude. remember that');
  // Paraphrase pairs (taught newest-last so newest-first iteration is deterministic).
  teach(model, 'always fix bugs before adding features. remember that');
  teach(model, 'purchase fresh milk before the store closes. remember that');
  teach(model, 'first reproduce it, then shrink it to the smallest case that still fails, then change one thing, then confirm the change worked. remember that');

  const topics = (model.lariLearnedRecords?.records || [])
    .filter(r => r?.payload?.kind === 'taught_fact').map(r => r.payload.topic);
  check('setup: six taught facts retained', topics.length === 6, JSON.stringify(topics));

  // --- (1) paraphrase matches ---
  const r8 = consult(model, 'what are the four steps for handling problems');
  check('R8: paraphrase "what are the four steps for handling problems" serves the 4-step fact',
    !!r8 && /reproduce/i.test(r8), r8 ? r8.slice(0, 80) : '(null)');
  check('R8: served value carries no internal-record markers',
    !!r8 && !INTERNAL_MARKERS.test(r8));

  const r8b = consult(model, 'the four steps start with reproduce it, then what are the rest');
  check('R8b: token-overlap retest still serves the fact (hard pass priority)',
    !!r8b && /reproduce/i.test(r8b), r8b ? r8b.slice(0, 80) : '(null)');

  const pair2 = consult(model, 'repair the bug first');
  check('pair2: synonym paraphrase "repair the bug first" serves the fix-bugs fact',
    !!pair2 && /fix bugs/i.test(pair2), pair2 ? pair2.slice(0, 80) : '(null)');

  const pair3 = consult(model, 'buy milk early');
  check('pair3: synonym paraphrase "buy milk early" serves the purchase-milk fact',
    !!pair3 && /fresh milk/i.test(pair3), pair3 ? pair3.slice(0, 80) : '(null)');

  // Threshold guards: near-misses must NOT match.
  const singleBridge = consult(model, 'repair the car first');
  check('guard: single synonym bridge alone ("repair the car first") matches nothing',
    singleBridge === null, singleBridge ? singleBridge.slice(0, 80) : '(null)');
  const wrongCount = consult(model, 'what are the three steps for handling problems');
  check('guard: wrong step count ("three steps") does not serve the 4-step fact',
    wrongCount === null, wrongCount ? wrongCount.slice(0, 80) : '(null)');
  const noMatch = consult(model, 'what is the capital of France');
  check('guard: unrelated question matches nothing',
    noMatch === null, noMatch ? noMatch.slice(0, 80) : '(null)');

  // --- (2) bullying still blocked ---
  const fortniteQ = consult(model, 'does Greg play fortnite');
  check('bully: "does Greg play fortnite" does not serve the home-server fact',
    !fortniteQ || !/home server/i.test(fortniteQ), fortniteQ ? fortniteQ.slice(0, 80) : '(null)');
  check('bully: "does Greg play fortnite" still serves the fortnite fact',
    !!fortniteQ && /fortnite/i.test(fortniteQ), fortniteQ ? fortniteQ.slice(0, 80) : '(null)');
  const booksQ = consult(model, 'what books has Greg published');
  check('bully: "what books has Greg published" does not serve the home-server fact',
    !booksQ || !/home server/i.test(booksQ), booksQ ? booksQ.slice(0, 80) : '(null)');
  check('bully: "what books has Greg published" still serves the books fact',
    !!booksQ && /fracktal verse/i.test(booksQ), booksQ ? booksQ.slice(0, 80) : '(null)');
  const bareSubject = consult(model, 'tell me about Greg');
  check('bully: bare-subject "tell me about Greg" matches no fact',
    bareSubject === null, bareSubject ? bareSubject.slice(0, 80) : '(null)');

  // --- (3) end-to-end: the session-6 R8 turn through the real chat path ---
  const e2eModel = {};
  teach(e2eModel, 'first reproduce it, then shrink it to the smallest case that still fails, then change one thing, then confirm the change worked. remember that');
  const e2e = await ask(e2eModel, 'what are the four steps for handling problems');
  check('e2e: R8 through chat serves the fact, no low-memory deflection',
    /reproduce/i.test(e2e) && !DEFLECTION.test(e2e), e2e.slice(0, 100));
  check('e2e: answer carries no internal-record markers', !INTERNAL_MARKERS.test(e2e));

  console.log(`\n${passed} passed, ${failed} failed${failed ? ': ' + failures.join('; ') : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
