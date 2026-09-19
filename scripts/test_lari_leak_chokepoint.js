#!/usr/bin/env node
'use strict';
// Chat internal-record leak CHOKE-POINT tests (fix-round 4, bug 1).
//
// Fail-before (2026-09-19 session 4): "the thesis is the swarm is the model.
// remember that" classified as chat/chat.personalization; the capability
// graph routed to compiled.head_to_head_visible_answer_repair_for_personalization
// (score 0.3231) and the answer-repair-skill phase served the skill's
// answerTemplate VERBATIM as the chat answer:
//   "When Lari loses h2h.personalization.style against the strong baseline
//    fixture, answer through the public model API with the verified
//    family-specific behavior."
// A previous fix filtered internal records on the general-chat evidence path,
// follow-ups, retainedKnowledgeRoute, and the curated-procedure matcher — but
// NOT the answer-repair-skill path.
// Pass-after: the internal-record filter is enforced at formatLariSessionAnswer,
// the SINGLE place where a kernel record becomes the public session answer, so
// ANY skill answerTemplate/description/summary route is screened by
// construction. Blocked turns fall back to normal chat behavior (retention
// acknowledgment / deflection), never an empty or broken answer.
//
// The end-to-end battery runs against a scratch COPY of the live model
// (copied to the OS temp dir; the live model file is never written).
// The runtime under test can be overridden for fail-before verification:
//   LARI_RUNTIME_UNDER_TEST=../tmp_prefix_runtime.js node scripts/test_lari_leak_chokepoint.js
//
// Run: node scripts/test_lari_leak_chokepoint.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require(path.resolve(__dirname, process.env.LARI_RUNTIME_UNDER_TEST || '../swarm_model_runtime.js'));

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

async function ask(model, prompt) {
  // Fresh deep copy per ask: turns mutate the model (learning, rotation
  // state), and each battery case must see the same starting model.
  const fresh = JSON.parse(JSON.stringify(model));
  const response = await runtime.sendMessageToLariAsync(fresh, { prompt }, {
    userScope: 'default',
    autoGrow: false,
    operator: false,
    kernel: { useBenchmarkSystem: false }
  });
  return String(response.answer || '');
}

// Markers of internal benchmark/eval/arena records. None of these may appear
// in a chat answer.
const LEAK_MARKERS = [
  /h2h/i,
  /GSM8K/i,
  /\barena\b/i,
  /polyglot_plan/i,
  /public model API/i,
  /benchmark/i,
  /baseline fixture/i,
  /self[- ]test/i,
  /eval(?:uation)?\s+record/i,
  /best answer from local model memory/i
];
function leakedMarkers(answer) {
  return LEAK_MARKERS.filter(re => re.test(answer)).map(re => String(re));
}

const LEAKED_TEXT = 'When Lari loses h2h.personalization.style against the strong baseline fixture, answer through the public model API with the verified family-specific behavior.';
const RETENTION_ACK = 'I can remember that and use it in future answers.';
const DEFLECTION = 'I do not have enough local memory to answer that strongly yet.';

// Scratch copy of the live model (read-only source; never mutated in place).
// Returns null when the live model is absent, so the end-to-end sections skip
// instead of crashing.
function loadScratchModel() {
  const src = '/home/hatch/workspace/lari-live/users/5651270693/model.json';
  if (!fs.existsSync(src)) return null;
  const dst = path.join(os.tmpdir(), 'lari_leak_chokepoint_model.json');
  fs.copyFileSync(src, dst);
  const scratch = JSON.parse(fs.readFileSync(dst, 'utf8'));
  // CRITICAL: the parsed model carries __lariSourcePath pointing at the LIVE
  // file, and checkpointLariModel writes to __lariSourcePath. Without this
  // repoint, any learning turn in the battery below would checkpoint the LIVE
  // model (this actually happened on 2026-09-19). Point it at the scratch copy
  // so checkpoints land in /tmp and the live model is never touched.
  scratch.__lariSourcePath = dst;
  return scratch;
}

function collectSkillTexts(model) {
  const texts = [];
  const push = (kind, id, text) => {
    const t = String(text || '').trim();
    if (t) texts.push({ kind, id, text: t });
  };
  (model.skills || []).forEach(s => push('skill', s.id, s.description));
  (model.compiledSkills || []).forEach(s => push('compiled', s.id, [s.answerTemplate, s.summary, s.description].filter(Boolean).join(' ')));
  ((model.selfTeaching || {}).knowledgeBase || []).forEach(s => push('kb', s.topic, [s.summary, s.description].filter(Boolean).join(' ')));
  return texts;
}

async function main() {
  const screen = runtime.screenLariChatAnswerForInternalRecords;
  check('runtime exports screenLariChatAnswerForInternalRecords(answer, record)', typeof screen === 'function');

  // --- Section A: choke-point unit tests (no model needed) ---
  if (typeof screen === 'function') {
    const blocked = screen(LEAKED_TEXT, { intent: 'chat', prompt: 'the thesis is the swarm is the model. remember that' });
    check('unit: leaked answerTemplate is blocked', blocked.blocked === true);
    check('unit: blocked remember-turn falls back to the retention acknowledgment',
      blocked.answer === RETENTION_ACK, JSON.stringify(blocked.answer).slice(0, 100));

    const blockedPlain = screen(LEAKED_TEXT, { intent: 'chat', prompt: 'tell me something' });
    check('unit: blocked non-remember turn falls back to the honest deflection',
      blockedPlain.blocked === true && blockedPlain.answer === DEFLECTION, JSON.stringify(blockedPlain.answer).slice(0, 100));

    const legit = 'Read the traceback bottom-up, reproduce with the smallest script, then fix the first failing frame.';
    const legitOut = screen(legit, { intent: 'chat', prompt: 'how do i debug a python keyerror' });
    check('unit: legitimate skill text passes through unchanged',
      legitOut.blocked === false && legitOut.answer === legit, JSON.stringify(legitOut.answer).slice(0, 100));

    const emptyOut = screen('', { intent: 'chat', prompt: 'hi' });
    check('unit: empty answer is not blocked and stays empty', emptyOut.blocked === false && emptyOut.answer === '');

    const nonChat = screen(LEAKED_TEXT, { intent: 'code', prompt: 'fix it' });
    check('unit: non-chat intents are not screened (fixed canned answers carry no skill text)',
      nonChat.blocked === false && nonChat.answer === LEAKED_TEXT);
  }

  // --- Section B: end-to-end battery on a scratch copy of the live model ---
  const model = loadScratchModel();
  if (!model) {
    console.log('  SKIP end-to-end battery: live model not found at ~/workspace/lari-live/users/5651270693/model.json');
  } else {
    // MUST NOT leak (previously leaked verbatim on pre-fix code).
    for (const input of [
      'the thesis is the swarm is the model. remember that',
      'the swarm is the model. remember that'
    ]) {
      const answer = await ask(model, input);
      const hits = leakedMarkers(answer);
      check(`no leak for ${JSON.stringify(input)}`, hits.length === 0,
        hits.length ? `markers [${hits.join(', ')}] in: ${answer.slice(0, 160)}` : '');
      check(`blocked turn still answers normally for ${JSON.stringify(input)}`,
        answer === RETENTION_ACK, answer.slice(0, 100));
    }

    // Controls: never leaked; must still answer sensibly (no leak AND no new breakage).
    const rememberAlone = await ask(model, 'remember that');
    check('control: "remember that" answers with the retention acknowledgment',
      leakedMarkers(rememberAlone).length === 0 && rememberAlone === RETENTION_ACK, rememberAlone.slice(0, 100));

    for (const input of ['the thesis is the swarm is the model', 'swarm. remember that', 'the model is local. remember that']) {
      const answer = await ask(model, input);
      const hits = leakedMarkers(answer);
      const expected = input === 'the thesis is the swarm is the model' ? null : RETENTION_ACK;
      const sensible = hits.length === 0 && answer.length > 0
        && (expected === null || answer === expected);
      check(`control: ${JSON.stringify(input)} answers sensibly`, sensible, answer.slice(0, 100));
    }

    // Legit recall end-to-end: real retained content still reaches chat.
    const who = await ask(model, 'who are you');
    check('legit recall: "who are you" still answers as Lari without leaking',
      /Lari/i.test(who) && /Larry/.test(who) && leakedMarkers(who).length === 0, who.slice(0, 120));

    // --- Section C: sweep — vague/chat inputs, zero internal-record text ---
    const sweepInputs = [
      'hmm', 'interesting', 'oh', 'cool', 'right', 'makes sense', 'uh huh',
      'fair enough', 'got it', 'later man', 'that was weird', 'dude what was that',
      'ok I gotta head out soon, good session', 'word',
      'the thesis is the swarm is the model. remember that',
      'the swarm is the model. remember that',
      'remember this for later', 'remember that the sky is blue',
      'what do you think about the swarm model',
      'tell me about yourself'
    ];
    for (const input of sweepInputs) {
      const answer = await ask(model, input);
      const hits = leakedMarkers(answer);
      check(`sweep: no internal text for ${JSON.stringify(input)}`, hits.length === 0,
        hits.length ? `markers [${hits.join(', ')}] in: ${answer.slice(0, 160)}` : '');
    }

    // --- Section D: every internal skill text is blocked; every legit one passes ---
    if (typeof screen === 'function') {
      const texts = collectSkillTexts(model);
      let internalCount = 0, legitCount = 0;
      const badBlocks = [], badPasses = [];
      for (const { kind, id, text } of texts) {
        const isInternal = runtime.isInternalEvalRecordText
          ? runtime.isInternalEvalRecordText(text)
          : leakedMarkers(text).length > 0;
        const out = screen(text, { intent: 'chat', prompt: 'generic chat turn' });
        if (isInternal) {
          internalCount++;
          if (!out.blocked) badPasses.push(`${kind}:${id}`);
        } else {
          legitCount++;
          if (out.blocked || out.answer !== text) badBlocks.push(`${kind}:${id}`);
        }
      }
      check(`screen coverage: all ${internalCount} internal skill texts are blocked at the choke point`,
        badPasses.length === 0, badPasses.slice(0, 5).join(' | '));
      check(`screen precision: all ${legitCount} legitimate skill texts pass through unmodified`,
        badBlocks.length === 0, badBlocks.slice(0, 5).join(' | '));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) { console.log('failures:', failures.join(' | ')); process.exit(1); }
}

main().catch(err => { console.error('test crashed:', err); process.exit(1); });
