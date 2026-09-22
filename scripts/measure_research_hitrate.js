#!/usr/bin/env node
// Research hit-rate measurement: before/after on a fixed 40-prompt sample.
// Usage: node scripts/measure_research_hitrate.js <research-module-path> <sample-json> <out-json>
'use strict';
const fs = require('fs');
const path = require('path');
const modPath = path.resolve(process.argv[2]);
const samplePath = process.argv[3];
const outPath = process.argv[4];
const research = require(modPath);
const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

(async () => {
  const rows = [];
  let hits = 0;
  for (let i = 0; i < sample.length; i++) {
    const prompt = sample[i];
    let topic = '', n = 0, err = '';
    try {
      const r = await research.researchPrompt(prompt);
      topic = r.topic || '';
      n = (r.sentences || []).length;
    } catch (e) { err = String((e && e.message) || e).slice(0, 60); }
    const hit = n > 0;
    if (hit) hits++;
    rows.push({ prompt: prompt.slice(0, 80), topic, sentences: n, hit, err });
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${sample.length} hits=${hits}`);
  }
  fs.writeFileSync(outPath, JSON.stringify({ hits, total: sample.length, rows }, null, 1));
  console.log(`HIT RATE: ${hits}/${sample.length} = ${(100 * hits / sample.length).toFixed(1)}% -> ${outPath}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
