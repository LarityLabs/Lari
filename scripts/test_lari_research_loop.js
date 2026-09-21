#!/usr/bin/env node
/**
 * Small Lari research-learn-answer loop test (live chat path).
 *
 * Proves the loop wired into sendMessageToLariAsyncInner():
 *   composer knowledge shortfall -> lariResearchForPrompt -> persist ->
 *   one retry with the new knowledge in the composer's pool.
 *
 * Test 1: one-turn learn. An unknown topic researches AND answers in one turn.
 * Test 2: the learned fact survives restart/reload (file-backed).
 * Test 3: second request answers from retained research with fetching disabled.
 * Test 4: failed research stays honest (shortfall preserved, no filler).
 *
 * Run: node scripts/test_lari_research_loop.js
 * NOTE: pollutes the real research store (models/lari/current/researched-knowledge.json)
 * with the test topic. That matches benchmark behavior and is accepted.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RUNTIME_PATH = path.join(ROOT, 'swarm_model_runtime.js');
const RESEARCH_PATH = path.join(ROOT, 'scripts', 'lari_research.js');
const BASE_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const SCRATCH = path.join(process.env.HOME || '/root', 'workspace', 'scratch', 'lari-research-loop');
fs.mkdirSync(SCRATCH, { recursive: true });

const TURN_TIMEOUT_MS = 60000;
const SHORTFALL = /i do not have enough grounded local knowledge/i;

let runtime = require(RUNTIME_PATH);

function freshModel(tag) {
  const dst = path.join(SCRATCH, `model-${tag}-${process.pid}-${Date.now()}.json`);
  const m = JSON.parse(fs.readFileSync(BASE_MODEL, 'utf8'));
  m.__lariSourcePath = dst;
  fs.writeFileSync(dst, JSON.stringify(m));
  return JSON.parse(fs.readFileSync(dst, 'utf8'));
}

function replyText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  return String(r.answer || r.text || r.reply || '').trim();
}

async function turn(model, text) {
  const p = runtime.sendMessageToLariAsync(model, text, { persistLearnedModel: false });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), TURN_TIMEOUT_MS));
  const r = await Promise.race([p, timeout]);
  return { raw: r, text: replyText(r) };
}

// Fabrication patterns, mirroring scripts/audit_ifeval_fabrication.js.
const FILLER = [
  /sentence \d+ follows the requested topic/i,
  /paragraph \d+ follows the requested topic/i,
  /this section follows the request/i,
  /\bword1 word2\b/i,
  /\bdetail1 detail2\b/i,
  /\bitem 1\b/i,
  /\bfirst response\./i,
  /\bsecond response\./i,
  /\bWORD1 WORD2\b/i,
  /subject key point \d+/i,
  /another useful point supports/i,
  /useful concrete detail/i,
  /detail detail detail/i,
];

const results = [];
function report(id, pass, note) {
  results.push({ id, pass, note });
  console.log(`${pass ? 'PASS' : 'FAIL'} [loop] ${id} — ${note}`);
}

(async () => {
  const TOPIC = 'quokka';
  const PROMPT = `Write a 3 paragraph summary of the ${TOPIC}, each paragraph at least 50 words.`;

  // --- Test 1: one-turn learn -------------------------------------------
  const model1 = freshModel('t1');
  let t1;
  try {
    t1 = await turn(model1, PROMPT);
  } catch (err) {
    report('one-turn-learn', false, `turn threw: ${err.message}`);
    t1 = null;
  }
  if (t1) {
    const cr = t1.raw && t1.raw.composerResearch;
    const okResearch = !!cr && cr.added > 0;
    const noShortfall = !SHORTFALL.test(t1.text);
    const hasTopic = new RegExp(TOPIC, 'i').test(t1.text);
    const pass = okResearch && noShortfall && hasTopic;
    report('one-turn-learn', pass,
      `added=${cr ? cr.added : 'n/a'} topic="${cr ? String(cr.topic).slice(0, 40) : 'n/a'}" ` +
      `shortfallGone=${noShortfall} hasTopic=${hasTopic} len=${t1.text.length}`);
    if (!pass) console.log('  reply head: ' + t1.text.slice(0, 200));
  }

  // --- Test 2: survives restart/reload ----------------------------------
  delete require.cache[RUNTIME_PATH];
  // Also drop any other cached copies of the runtime (defensive).
  for (const key of Object.keys(require.cache)) {
    if (key.endsWith('swarm_model_runtime.js')) delete require.cache[key];
  }
  runtime = require(RUNTIME_PATH);
  const knowledge = runtime.getLariResearchedKnowledge();
  const entry = knowledge.find(e => new RegExp(TOPIC, 'i').test(String(e.topic || '')));
  report('survives-restart', !!entry && (entry.sentences || []).length > 0,
    entry ? `topic="${entry.topic}" sentences=${(entry.sentences || []).length} sources=${(entry.sources || []).length}` : 'topic entry missing after reload');

  // --- Test 3: retained knowledge, no fetch ------------------------------
  // Stub the research module in require.cache so any fetch attempt throws.
  require.cache[RESEARCH_PATH] = {
    id: RESEARCH_PATH,
    filename: RESEARCH_PATH,
    loaded: true,
    exports: {
      researchPrompt: async () => { throw new Error('must not fetch: retained knowledge should be used'); }
    }
  };
  for (const key of Object.keys(require.cache)) {
    if (key.endsWith('swarm_model_runtime.js')) delete require.cache[key];
  }
  runtime = require(RUNTIME_PATH);
  const model3 = freshModel('t3');
  let t3, threw = null;
  try {
    t3 = await turn(model3, PROMPT);
  } catch (err) {
    threw = err;
  }
  if (threw) {
    report('retained-no-fetch', false, `turn threw: ${threw.message}`);
  } else {
    const cr = t3.raw && t3.raw.composerResearch;
    const pass = !SHORTFALL.test(t3.text) && new RegExp(TOPIC, 'i').test(t3.text) && !cr;
    report('retained-no-fetch', pass,
      `noFetchThrow=true shortfallGone=${!SHORTFALL.test(t3.text)} hasTopic=${new RegExp(TOPIC, 'i').test(t3.text)} ` +
      `reResearched=${!!cr} len=${t3.text.length}`);
    if (!pass) console.log('  reply head: ' + t3.text.slice(0, 200));
  }
  // Restore the real research module for later tests.
  delete require.cache[RESEARCH_PATH];

  // --- Test 4: failed research stays honest ------------------------------
  for (const key of Object.keys(require.cache)) {
    if (key.endsWith('swarm_model_runtime.js')) delete require.cache[key];
  }
  runtime = require(RUNTIME_PATH);
  const model4 = freshModel('t4');
  const GIBBERISH = 'Explain zqblorp flimflam wobble in 3 paragraphs';
  let t4;
  try {
    t4 = await turn(model4, GIBBERISH);
  } catch (err) {
    report('failed-research-honest', false, `turn threw: ${err.message}`);
    t4 = null;
  }
  if (t4) {
    const cr = t4.raw && t4.raw.composerResearch;
    const noNewFacts = !cr || !(cr.added > 0);
    // Either the composer shortfall or the generic honest deflection counts
    // as staying honest; what must NOT happen is filler or a researched claim.
    const stillShortfall = SHORTFALL.test(t4.text) || /enough local memory/i.test(t4.text);
    const fillerHits = FILLER.filter(re => re.test(t4.text));
    const pass = noNewFacts && stillShortfall && fillerHits.length === 0;
    report('failed-research-honest', pass,
      `added=${cr ? cr.added : 0} stillShortfall=${stillShortfall} fillerHits=${fillerHits.length}`);
    if (!pass) console.log('  reply head: ' + t4.text.slice(0, 200));
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\nTOTAL: ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
