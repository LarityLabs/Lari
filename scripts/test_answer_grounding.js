#!/usr/bin/env node
/**
 * test_answer_grounding.js — scripted multi-turn tests for answer grounding
 * (scripts/lari_answer_grounding.js).
 *
 * Verifies that parsed semantic relations actually inform chat replies:
 *  1. WHY from cause            5. Paraphrase verification (confirm/correct)
 *  2. Follow-up reference       6. Multi-turn persistence + honest forgetting
 *  3. Contrast check            + Honesty probes (no invention, fallback)
 *  4. Conditional query         + Determinism + live runtime hook
 *
 * Scratch models only. No commit/push. Zero external model calls.
 * Run: node scripts/test_answer_grounding.js [--battery] [--harness]
 *   --battery  also runs the 46-item chat battery as a final regression.
 *   --harness  also runs the 131-gate semantic-induction harness.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const sem = require(path.join(ROOT, 'scripts', 'lari_answer_grounding.js').replace('lari_answer_grounding.js', 'lari_semantic_induction.js'));
const ag = require(path.join(ROOT, 'scripts', 'lari_answer_grounding.js'));
const BASE_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const SCRATCH = path.join(process.env.HOME || '/root', 'workspace', 'scratch', 'lari-answer-grounding');
fs.mkdirSync(SCRATCH, { recursive: true });

const RUN_BATTERY = process.argv.includes('--battery');
const RUN_HARNESS = process.argv.includes('--harness');
const T0 = Date.now();
const results = [];

function gate(behavior, name, pass, detail) {
  results.push({ behavior, name, pass: !!pass, detail: String(detail || '') });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${behavior}  ${name}  ${detail || ''}`);
}

function freshModel(tag) {
  const dst = path.join(SCRATCH, `model-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  const m = JSON.parse(fs.readFileSync(BASE_MODEL, 'utf8'));
  m.__lariSourcePath = dst;
  delete m[sem.SECTION];
  fs.writeFileSync(dst, JSON.stringify(m));
  return JSON.parse(fs.readFileSync(dst, 'utf8'));
}

function teach(model, texts) {
  for (const t of texts) sem.noteCandidate(model, { text: t, source: 'teaching' });
}

// Simulate one chat turn through the grounding module. Returns the full
// grounding result (null = no grounding, existing answer stands).
function turn(model, msg) {
  return ag.groundAnswer(model, msg, {});
}

function ans(model, msg) {
  const g = turn(model, msg);
  return g ? g.answer : null;
}

function setupStandard(model) {
  teach(model, [
    'Because the dam cracked, the valley flooded.',
    'Since the winds shifted, the fire spread east.',
    'The river rose because the dam cracked.',
    'The streets flooded since the rains came.',
    'Although it rained, we stayed.',
    'Though the road was long, they kept driving.',
    'The engine is small but it pulls hard.',
    'He was tired yet he kept going.',
    'If the server overheats, the site goes down.',
    'If the alarm sounds, evacuate the building.',
    'Unless it rains soon, the crops will fail.',
    'Unless you hurry, you will miss the train.',
    'The crops will fail unless it rains soon.',
    'You will miss the train unless you hurry.',
    'Despite the rain, we stayed.',
    'In spite of the delay, the show went on.',
    'If he had left earlier, he would have arrived on time.',
    'If she had studied harder, she would have passed the exam.',
  ]);
  return model;
}

async function main() {
  // ------------------------------------------------------- 1. WHY from cause
  {
    const m = setupStandard(freshModel('why'));
    turn(m, 'Because the dam cracked, the valley flooded.');
    gate('why', 'front-order', ans(m, 'why did the valley flood?') === 'Because the dam cracked.', JSON.stringify(ans(m, 'why did the valley flood?')));
    const m2 = setupStandard(freshModel('why2'));
    turn(m2, 'The engine overheated because the coolant leaked.');
    gate('why', 'mid-order', ans(m2, 'why did the engine overheat?') === 'Because the coolant leaked.', '');
    const m3 = setupStandard(freshModel('why3'));
    turn(m3, 'Since the winds shifted, the fire spread east.');
    gate('why', 'since-marker', ans(m3, 'why did the fire spread east?') === 'Because the winds shifted.', '');
    const m4 = setupStandard(freshModel('why4'));
    turn(m4, 'Because the dam cracked, the valley flooded.');
    turn(m4, 'Because the server overheated, the website went offline.');
    gate('why', 'recency', ans(m4, 'why did the website go offline?') === 'Because the server overheated.', '');
    const m5 = setupStandard(freshModel('why5'));
    turn(m5, 'Because the dam cracked, the valley flooded.');
    gate('why', 'no-match-forgets', ans(m5, 'why did the moon explode?') === ag.FORGOTTEN, '');
  }

  // -------------------------------------------------- 2. Follow-up reference
  {
    const m = setupStandard(freshModel('ref'));
    turn(m, 'Because the dam cracked, the valley flooded.');
    gate('what_caused', 'it-resolves-to-effect', ans(m, 'what caused it?') === 'The dam cracked.', '');
    gate('what_caused', 'this-variant', ans(m, 'what caused this?') === 'The dam cracked.', '');
    const m2 = setupStandard(freshModel('ref2'));
    turn(m2, 'The engine overheated because the coolant leaked.');
    gate('what_caused', 'mid-order', ans(m2, 'what caused it?') === 'The coolant leaked.', '');
    const m3 = freshModel('ref3');
    teach(m3, ['Although it rained, we stayed.', 'Though the road was long, they kept driving.']);
    turn(m3, 'Although it rained, we stayed.');
    gate('what_caused', 'no-cause-forgets', ans(m3, 'what caused it?') === ag.FORGOTTEN, '');
  }

  // ------------------------------------------------------- 3. Contrast check
  {
    const m = setupStandard(freshModel('cc'));
    turn(m, 'Although it rained, we stayed.');
    gate('contrast_confirm', 'although', ans(m, "so the rain didn't stop you?") === 'Right — although it rained, we stayed.', JSON.stringify(ans(m, "so the rain didn't stop you?")));
    const m2 = setupStandard(freshModel('cc2'));
    turn(m2, 'The engine is small but it pulls hard.');
    gate('contrast_confirm', 'but-mid', ans(m2, "so the small size didn't matter?") === 'Right — the engine is small, but it pulls hard.', JSON.stringify(ans(m2, "so the small size didn't matter?")));
    const m3 = setupStandard(freshModel('cc3'));
    turn(m3, 'Despite the rain, we stayed.');
    gate('contrast_confirm', 'despite', ans(m3, "so the rain didn't stop you?") === 'Right — despite the rain, we stayed.', JSON.stringify(ans(m3, "so the rain didn't stop you?")));
    const m4 = setupStandard(freshModel('cc4'));
    turn(m4, 'Although it rained, we stayed.');
    gate('contrast_confirm', 'no-match-forgets', ans(m4, "so the snow didn't stop you?") === ag.FORGOTTEN, '');
  }

  // ----------------------------------------------------- 4. Conditional query
  {
    const m = setupStandard(freshModel('cond'));
    turn(m, 'If the server overheats, the site goes down.');
    gate('conditional_q', 'if-front', ans(m, 'what happens if the server overheats?') === 'The site goes down.', '');
    const m2 = setupStandard(freshModel('cond2'));
    turn(m2, 'Unless it rains soon, the crops will fail.');
    gate('conditional_q', 'unless', ans(m2, "what happens if it doesn't rain soon?") === 'The crops will fail.', JSON.stringify(ans(m2, "what happens if it doesn't rain soon?")));
    const m3 = setupStandard(freshModel('cond3'));
    turn(m3, 'If he had left earlier, he would have arrived on time.');
    gate('conditional_q', 'counterfactual', ans(m3, 'what happens if he had left earlier?') === 'He would have arrived on time.', JSON.stringify(ans(m3, 'what happens if he had left earlier?')));
    const m4 = setupStandard(freshModel('cond4'));
    turn(m4, 'If the server overheats, the site goes down.');
    gate('conditional_q', 'no-match-forgets', ans(m4, 'what happens if the moon explodes?') === ag.FORGOTTEN, '');
  }

  // ----------------------------------------------- 5. Paraphrase verification
  {
    const m = setupStandard(freshModel('para'));
    turn(m, 'Because the dam cracked, the valley flooded.');
    gate('paraphrase', 'match-confirms',
      ans(m, "so you're saying the valley flooded because the dam cracked?") === "Yes, that's right.",
      JSON.stringify(ans(m, "so you're saying the valley flooded because the dam cracked?")));
    const m2 = setupStandard(freshModel('para2'));
    turn(m2, 'Because the dam cracked, the valley flooded.');
    const a2 = ans(m2, "so you're saying the dam cracked because the valley flooded?");
    gate('paraphrase', 'mismatch-corrects',
      a2 === 'Not quite — the way I have it: because the dam cracked, the valley flooded.',
      JSON.stringify(a2));
    const m3 = setupStandard(freshModel('para3'));
    turn(m3, 'Unless it rains soon, the crops will fail.');
    gate('paraphrase', 'unless-match-confirms',
      ans(m3, "so you're saying the crops will fail unless it rains soon?") === "Yes, that's right.",
      JSON.stringify(ans(m3, "so you're saying the crops will fail unless it rains soon?")));
    const m4 = freshModel('para4');
    teach(m4, ['Although it rained, we stayed.', 'Though the road was long, they kept driving.']);
    gate('paraphrase', 'no-operator-falls-back',
      ans(m4, "so you're saying the valley flooded because the dam cracked?") === null, '');
  }

  // ------------------------------------------ 6. Multi-turn persistence/window
  {
    const m = setupStandard(freshModel('win'));
    const pairs = [
      ['the bridge collapsed', 'the town was isolated'],
      ['the pipes burst', 'the basement flooded'],
      ['the storm hit', 'the power failed'],
      ['the alarm malfunctioned', 'the shift evacuated'],
      ['the fuel ran out', 'the generator stopped'],
      ['the cable snapped', 'the elevator stalled'],
      ['the filter clogged', 'the pressure spiked'],
      ['the driver braked late', 'the car skidded'],
      ['the software crashed', 'the data corrupted'],
      ['the tenth pipe burst', 'the basement flooded'],
      ['the levy broke', 'the fields drowned'],
    ];
    for (const [c, e] of pairs) turn(m, `Because ${c}, ${e}.`);
    gate('persistence', 'window-bounded', ag.historySize(m) === 10, `size=${ag.historySize(m)}`);
    gate('persistence', 'aged-out-forgotten',
      ans(m, 'why was the town isolated?') === ag.FORGOTTEN,
      JSON.stringify(ans(m, 'why was the town isolated?')));
    gate('persistence', 'recent-still-answers',
      ans(m, 'why did the fields drown?') === 'Because the levy broke.',
      JSON.stringify(ans(m, 'why did the fields drown?')));
  }

  // ------------------------------------------------------------ honesty probes
  {
    const m = setupStandard(freshModel('hon'));
    turn(m, 'Because the dam cracked, the valley flooded.');
    gate('honesty', 'never-parsed-not-invented',
      ans(m, 'why did the stock market crash?') === ag.FORGOTTEN, '');
    gate('honesty', 'unclassified-falls-back',
      ans(m, 'what caused the outage?') === null, '');
    const m2 = setupStandard(freshModel('hon2'));
    teach(m2, ['Because the dam cracked, the valley flooded.', 'Since the winds shifted, the fire spread east.']);
    // drop confidence below the qualification floor: must not ground
    const sec = m2[sem.SECTION];
    for (const e of sec.entries) e.confidence = 0.1;
    const fired = sem.matchOperators('Because the dam cracked, the valley flooded.', m2);
    gate('honesty', 'low-confidence-no-fire', fired === null, '');
    turn(m2, 'Because the dam cracked, the valley flooded.');
    gate('honesty', 'low-confidence-falls-back', ans(m2, 'why did the valley flood?') === null, '');
  }

  // ------------------------------------------------------------ determinism
  {
    const runSeq = () => {
      const m = setupStandard(freshModel('det'));
      const out = [];
      out.push(ans(m, 'Because the dam cracked, the valley flooded.'));
      out.push(ans(m, 'why did the valley flood?'));
      out.push(ans(m, 'what caused it?'));
      out.push(ans(m, "so you're saying the valley flooded because the dam cracked?"));
      out.push(ans(m, 'If the server overheats, the site goes down.'));
      out.push(ans(m, 'what happens if the server overheats?'));
      return JSON.stringify(out);
    };
    const a = runSeq();
    const b = runSeq();
    gate('determinism', 'identical-reruns', a === b, '');
  }

  // ------------------------------------------------------------ live runtime
  console.log('\n--- live runtime turns (integrated hook) ---');
  try {
    const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
    const send = runtime.sendMessageToLariAsync;
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), ms))]);
    const lm = freshModel('live');
    await withTimeout(send(lm, 'lari, learn this pattern: Because the dam cracked, the valley flooded.', {}), 60000);
    const r2 = await withTimeout(send(lm, 'lari, learn this pattern: Since the winds shifted, the fire spread east.', {}), 60000);
    const induced = !!(r2 && r2.semanticInduction && r2.semanticInduction.induced);
    await withTimeout(send(lm, 'Because the dam cracked, the valley flooded.', {}), 60000);
    const r4 = await withTimeout(send(lm, 'why did the valley flood?', {}), 60000);
    const whyOk = r4 && r4.answer === 'Because the dam cracked.' &&
      r4.answerGrounding && r4.answerGrounding.behavior === 'why';
    gate('live', 'why-via-hook', induced && whyOk,
      `induced=${induced} answer=${JSON.stringify(r4 && r4.answer)} behavior=${r4 && r4.answerGrounding && r4.answerGrounding.behavior}`);
    // paraphrase correction needs the mid-order operator: teach it live
    await withTimeout(send(lm, 'lari, learn this pattern: The river rose because the dam cracked.', {}), 60000);
    await withTimeout(send(lm, 'lari, learn this pattern: The streets flooded since the rains came.', {}), 60000);
    const r7 = await withTimeout(send(lm, "so you're saying the dam cracked because the valley flooded?", {}), 60000);
    const corrOk = r7 && typeof r7.answer === 'string' && r7.answer.indexOf('Not quite') === 0 &&
      r7.answerGrounding && r7.answerGrounding.behavior === 'paraphrase';
    gate('live', 'paraphrase-correction-via-hook', corrOk, JSON.stringify(r7 && r7.answer));
    console.log('\n--- live transcripts ---');
    console.log('greg: why did the valley flood?\n  lari: ' + (r4 && r4.answer));
    console.log("greg: so you're saying the dam cracked because the valley flooded?\n  lari: " + (r7 && r7.answer));
  } catch (e) {
    gate('live', 'runtime-turns', false, 'error: ' + (e && e.message));
  }

  // ---------------------------------------------------------------- summary
  const failed = results.filter(r => !r.pass);
  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.behavior}  ${r.name}  ${r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log(`total time: ${((Date.now() - T0) / 1000).toFixed(1)}s`);

  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  console.log('\n=== SHA-256 ===');
  console.log(`${sha(path.join(ROOT, 'scripts', 'lari_answer_grounding.js'))}  scripts/lari_answer_grounding.js`);
  console.log(`${sha(path.join(ROOT, 'scripts', 'test_answer_grounding.js'))}  scripts/test_answer_grounding.js`);
  console.log(`${sha(path.join(ROOT, 'swarm_model_runtime.js'))}  swarm_model_runtime.js (with hook)`);

  if (failed.length) {
    console.log('\nVERDICT: FAILED — see failures above.');
    process.exitCode = 1;
  } else {
    console.log('\nVERDICT: all grounding tests passed.');
  }

  if (RUN_HARNESS) {
    console.log('\n=== semantic-induction harness (regression) ===');
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('node', [path.join(ROOT, 'scripts', 'test_semantic_induction.js')], { cwd: ROOT, timeout: 600000 });
      const tail = out.toString().split('\n').slice(-8).join('\n');
      console.log(tail);
      if (!/131\/131 gates passed/.test(out.toString())) { console.log('HARNESS REGRESSION: gate count mismatch'); process.exitCode = 1; }
    } catch (e) {
      console.log('harness run failed:', e && e.message);
      process.exitCode = 1;
    }
  }

  if (RUN_BATTERY) {
    console.log('\n=== chat battery (regression) ===');
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('node', [path.join(ROOT, 'scripts', 'test_lari_chat_battery.js')], { cwd: ROOT, timeout: 600000 });
      const tail = out.toString().split('\n').slice(-25).join('\n');
      console.log(tail);
      if (!/TOTAL: 46\/46/.test(out.toString())) { console.log('BATTERY REGRESSION'); process.exitCode = 1; }
    } catch (e) {
      console.log('battery run failed:', e && e.message);
      process.exitCode = 1;
    }
  }
}

main().catch(e => { console.error('TEST ERROR:', e && e.stack || e); process.exitCode = 2; });
