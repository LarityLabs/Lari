#!/usr/bin/env node
'use strict';
// Teaching-retention battery (2026-09-23).
//
// End-to-end measurement of Lari's tutoring/learning pipeline: teach N novel
// items through the REAL chat entry point (sendMessageToLariAsync) on a fresh
// scratch model, then retest each one and count how many survive.
//
// Methodology:
//   1. Absence check: every retest prompt is asked BEFORE teaching; the item
//      only counts if the expected answer is absent (the model provably does
//      not already know it).
//   2. Teach: each item is taught once via the full pipeline (extraction,
//      discourse miner, retention gate, checkpoint refused on scratch).
//   3. Stored check: did a taught_fact record (or instruction pair) land in
//      the model? Distinguishes extraction loss from serving loss.
//   4. Retest: paraphrased question asked after all teachings; "survived"
//      means the answer carries the expected content.
//
// The item mix covers all five diagnosed teaching-loss layers:
//   layer 1 (extraction paths): code-lane teaching (quicksort), wrapper fact (beacon)
//   layer 2 (wrapper stripping): beacon fact must be served clean, never verbatim
//   layer 3 (evidence relevance): three marisol-vega facts must each route correctly
//   layer 4 (lane precedence): thesis + singularity must beat define/self-knowledge lanes
//   layer 5 (pairs): directive teachings must complete instruction pairs
// plus 12 plain novel facts and the session-6 R8 paraphrase case.
//
// Usage: node scripts/test_lari_teaching_retention.js
// Exit 0 when retention meets the bar, 1 otherwise (the per-item table is
// always printed so partial runs stay honest).
const runtime = require('../swarm_model_runtime.js');

const ITEMS = [
  // ---- novel facts ----
  { id: 'zorbia', teach: 'the capital of zorbia is velmar. remember that', retest: 'what is the capital of zorbia', want: /velmar/i },
  { id: 'zorblat', teach: 'the zorblat bird migrates in october. remember that', retest: 'when does the zorblat migrate', want: /october/i },
  { id: 'lumens', teach: 'the lumens reactor was invented by dr. aris thorne. remember that', retest: 'who invented the lumens reactor', want: /aris thorne/i },
  { id: 'deepwell', teach: 'the deepwell expedition reached a depth of 9000 meters. remember that', retest: 'how deep did the deepwell expedition go', want: /9000/ },
  { id: 'kessandra', teach: 'the treaty of kessandra was signed in 2149. remember that', retest: 'when was the treaty of kessandra signed', want: /2149/ },
  { id: 'meridia', teach: 'the flag of meridia is blue and gold. remember that', retest: 'what colors are on the flag of meridia', want: /blue and gold/i },
  { id: 'glimmerfish', teach: 'the glimmerfish glows because of bioluminescent algae. remember that', retest: 'why does the glimmerfish glow', want: /bioluminescent/i },
  { id: 'selene', teach: 'the tower of selene is 400 feet tall. remember that', retest: 'how tall is the tower of selene', want: /400/ },
  { id: 'halcyon', teach: 'the comet halcyon returns every 75 years. remember that', retest: 'how often does the comet halcyon return', want: /75/ },
  { id: 'underlibrary', teach: 'the first vault of the underlibrary holds star charts. remember that', retest: 'what does the first vault of the underlibrary hold', want: /star charts/i },
  { id: 'dalen', teach: 'the harvest festival of dalen lasts nine days. remember that', retest: 'how long does the harvest festival of dalen last', want: /nine/i },
  // ---- layer 3: same-subject facts must each route to the right one ----
  { id: 'vega-novel', teach: 'marisol vega wrote the novel the glass orchard. remember that', retest: 'who wrote the glass orchard', want: /marisol vega/i },
  { id: 'vega-born', teach: 'marisol vega was born in lisbon. remember that', retest: 'where was marisol vega born', want: /lisbon/i },
  { id: 'vega-prize', teach: 'marisol vega won the aurora prize in 2031. remember that', retest: 'when did marisol vega win the aurora prize', want: /2031/ },
  // ---- layer 2: wrapper must be stripped, fact served clean ----
  { id: 'beacon', teach: 'the beacon of nordvik is a lighthouse. when I ask about the beacon just say lighthouse. remember that', retest: 'what is the beacon of nordvik', want: /lighthouse/i, notWant: /when i ask/i },
  // ---- layer 1: code-lane teaching must still be extracted ----
  { id: 'quicksort', teach: 'the quicksort pivot bug is fixed by choosing the median of three. remember that', retest: 'what fixes the quicksort pivot bug', want: /median of three/i },
  // ---- layer 4: strong taught facts beat the lanes ----
  { id: 'thesis', teach: 'the thesis is the swarm is the model. remember that', retest: 'what is the thesis', want: /swarm is the model/i },
  { id: 'singularity', teach: 'lari is short for singularity. remember that', retest: 'what does the name lari mean', want: /singularity/i },
  // ---- session-6 R8: paraphrase with no shared content tokens ----
  { id: 'four-steps', teach: 'first reproduce it, then shrink it to the smallest case that still fails, then change one thing, then confirm the change worked. remember that', retest: 'what are the four steps for handling problems', want: /reproduce/i },
  // ---- layer 5: directive procedures ----
  { id: 'thanks', teach: "when I say thanks just say 'anytime'", retest: 'thanks', want: /^\s*anytime\.?\s*$/i, procedure: true },
  { id: 'good', teach: "when I ask if we're good just say 'all good man'", retest: 'are we good', want: /^\s*all good man\.?\s*$/i, procedure: true },
  { id: 'password', teach: "when I say the password just say 'swordfish'", retest: 'the password', want: /^\s*swordfish\.?\s*$/i, procedure: true },
  { id: 'over-out', teach: "when I say over and out just say 'roger that'", retest: 'over and out', want: /^\s*roger that\.?\s*$/i, procedure: true },
];

async function ask(model, prompt) {
  const r = await runtime.sendMessageToLariAsync(model, { prompt }, {
    userScope: 'default', autoGrow: false, operator: false,
    kernel: { useBenchmarkSystem: false }
  });
  return String(r.answer || '');
}

function storedFor(model, item) {
  const records = (model.lariLearnedRecords?.records || []);
  if (item.procedure) {
    const pairs = (model.lariDiscourseMiner?.pairs || []);
    return pairs.some(p => p && (p.via === 'instruction') && item.want.test(String(p.correctedAnswer || p.answer || '').trim()));
  }
  const keyBits = item.teach.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 4);
  return records.some(r => {
    const p = r?.payload || {};
    if (p.kind !== 'taught_fact') return false;
    const hay = `${p.topic || ''} ${p.summary || ''}`.toLowerCase();
    return keyBits.some(w => hay.includes(w));
  });
}

async function main() {
  const model = {}; // scratch only: never the live model file
  const rows = [];

  // Phase 1: absence check — every item must be unknown before teaching.
  for (const item of ITEMS) {
    const pre = await ask(model, item.retest);
    const known = item.want.test(pre) && !(item.notWant && item.notWant.test(pre));
    rows.push({ item, pre, preKnown: known });
    if (known) console.log(`  ABSENCE-FAIL ${item.id}: model already answers this (pre: ${pre.slice(0, 70)})`);
  }
  const usable = rows.filter(r => !r.preKnown);
  if (usable.length !== rows.length) {
    console.log(`\nABORT: ${rows.length - usable.length} item(s) already known; battery needs novel items.`);
    process.exit(2);
  }

  // Phase 2: teach everything through the full pipeline, in one session.
  for (const row of usable) {
    await ask(model, row.item.teach);
    row.stored = storedFor(model, row.item);
  }

  // Phase 3: retest everything.
  for (const row of usable) {
    const post = await ask(model, row.item.retest);
    row.post = post;
    row.survived = row.item.want.test(post) && !(row.item.notWant && row.item.notWant.test(post));
  }

  const n = usable.length;
  const storedCount = usable.filter(r => r.stored).length;
  const survivedCount = usable.filter(r => r.survived).length;
  console.log(`\nretention battery: N=${n} (${ITEMS.filter(i => !i.procedure).length} facts, ${ITEMS.filter(i => i.procedure).length} procedures)`);
  console.log(`stored after teaching: ${storedCount}/${n} | survived retest: ${survivedCount}/${n} (${Math.round(100 * survivedCount / n)}%)`);
  console.log('id                 stored  survived  retest excerpt');
  for (const r of usable) {
    const flag = r.survived ? 'PASS' : (r.stored ? 'LOST@serve' : 'LOST@extract');
    console.log(`${flag} ${r.item.id.padEnd(16)} ${String(r.stored).padEnd(7)} ${String(r.survived).padEnd(9)} ${r.post.slice(0, 72).replace(/\n/g, ' ')}`);
  }
  const bar = 0.8;
  console.log(survivedCount / n >= bar ? `\nBATTERY PASS (>= ${bar * 100}% retained)` : `\nBATTERY BELOW BAR (< ${bar * 100}% retained)`);
  process.exit(survivedCount / n >= bar ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
