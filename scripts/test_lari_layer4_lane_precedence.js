#!/usr/bin/env node
'use strict';
// Layer-4 tests (2026-09-19): lane precedence over taught facts + the
// session_context_memory hallucination guard.
//
// Fail-before (session 5 tutoring transcript,
// lari-tutoring-session-5-2026-09-19.md):
//  (a) "what is the thesis" -> the dictionary define lane (answered_define)
//      won over the explicitly taught "the thesis is the swarm is the model".
//  (b) "what is Lari short for" -> self_knowledge_realization answered with
//      the identity line, no taught "Singularity".
//  (c) "why did I build you" -> session_context_memory stitched the failed
//      "are we good" directive fragment ("good just say 'all good man'") into
//      a fake statement of Greg's goal.
//
// Pass-after:
//  (a,b) a STRONG taught fact (explicit "remember that" teaching, confidence
//      >= 0.9, good topic coverage of the question) outranks the define lane
//      and the self-knowledge / session-context-memory lanes for
//      factual-recall questions.
//  (c) synthesizeLariSessionContextAnswer never composes factual claims from
//      raw recent-turn text: directive fragments are not stored as session
//      goals, and a factual why-question about Lari's origin stays unclaimed
//      so the taught-fact/evidence layers (or the honest deflection) own it.
//
// Guards (must keep passing): the dictionary define lane still defines
// genuinely unknown words (a weak/non-explicit fact must not hijack it);
// the pinned thanks->"anytime" directive keeps working; native time/math
// lanes are never hijacked; "what does LARI stand for" keeps the acronym.
//
// Run: node scripts/test_lari_layer4_lane_precedence.js
const runtime = require('../swarm_model_runtime.js');

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

async function main() {
  // --- (a) thesis: strong taught fact outranks the dictionary define lane ---
  {
    const model = {};
    await ask(model, 'the thesis is the swarm is the model. remember that');
    const ans = await ask(model, 'what is the thesis');
    check('precedence: "what is the thesis" serves the taught thesis, not the dictionary',
      /the swarm is the model/i.test(ans) && !/unproved statement|treatise advancing/i.test(ans),
      ans.slice(0, 160));
  }

  // --- (b) Singularity: strong taught fact outranks self_knowledge_realization ---
  {
    const model = {};
    await ask(model, 'Lari is short for Singularity. remember that');
    const ans = await ask(model, 'what is Lari short for');
    check('precedence: "what is Lari short for" serves the taught Singularity fact',
      /singularity/i.test(ans), ans.slice(0, 160));
  }

  // --- (c) hallucination guard: failed directive must not become a "goal" ---
  {
    const model = {};
    await ask(model, "when I ask if we're good just say 'all good man'");
    await ask(model, 'are we good');
    const ans = await ask(model, 'why did I build you');
    check('no stitch: answer contains no directive fragments from the failed teaching',
      !/just say/i.test(ans) && !/all good man/i.test(ans), ans.slice(0, 200));
    check('no fake goal: answer does not present raw turn text as the current goal',
      !/current goal/i.test(ans), ans.slice(0, 200));
  }

  // --- (c2) factual why-question stays unclaimed even with a legitimate goal ---
  {
    const model = {};
    await ask(model, 'our goal is to build the home server dashboard');
    const ans = await ask(model, 'why did I build you');
    check('no compose: factual "why did I build you" is not answered from the session goal',
      !/home server dashboard/i.test(ans) && !/current goal/i.test(ans), ans.slice(0, 200));
  }

  // --- guards ---
  {
    const model = {};
    const defAns = await ask(model, 'what is epistemology');
    check('guard: define lane still defines genuinely unknown words',
      /epistemology/i.test(defAns) && /theory of knowledge|philosoph/i.test(defAns),
      defAns.slice(0, 160));

    await ask(model, 'thanks');
    await ask(model, "when I say thanks just say 'anytime'");
    const thanksAns = await ask(model, 'thanks');
    check('guard: pinned thanks -> "anytime" directive still honored',
      /^\s*anytime\.?\s*$/i.test(thanksAns), thanksAns.slice(0, 80));

    const timeAns = await ask(model, 'what time is it');
    check('guard: native time lane never hijacked',
      /\d{1,2}:\d{2}/.test(timeAns), timeAns.slice(0, 80));

    const mathAns = await ask(model, 'whats 15 * 4');
    check('guard: native math lane never hijacked',
      /(^|\D)60(\D|$)/.test(mathAns), mathAns.slice(0, 80));

    const acrAns = await ask(model, 'what does LARI stand for');
    check('guard: "what does LARI stand for" keeps the acronym',
      /Local Autonomous Recursive Intelligence/i.test(acrAns), acrAns.slice(0, 120));

    const whoAns = await ask(model, 'so who are you');
    check('guard: "so who are you" keeps he/him and Larry',
      /he\/him/i.test(whoAns) && /Larry/i.test(whoAns), whoAns.slice(0, 120));
  }

  // --- guard: weak / non-explicit facts must not hijack the define lane ---
  {
    const model = {};
    runtime.retainTaughtFactFromChat(model,
      { topic: 'epistemology', summary: 'Epistemology is the best thing ever.' },
      { userScope: 'default' });
    const rec = (model.lariLearnedRecords.records || []).find(r => r?.payload?.kind === 'taught_fact');
    if (rec) { rec.payload.confidence = 0.4; rec.payload.explicit = false; delete rec.payload.source; }
    const ans = await ask(model, 'what is epistemology');
    check('guard: weak non-explicit fact does not hijack the define lane',
      /theory of knowledge|philosoph/i.test(ans) && !/best thing ever/i.test(ans),
      ans.slice(0, 160));
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) { console.log('failures:', failures.join(' | ')); process.exit(1); }
}

main().catch(err => { console.error('test crashed:', err); process.exit(1); });
