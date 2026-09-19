#!/usr/bin/env node
'use strict';
// Live-loop test: two in-process turns; the second corrects the first.
// Proves sendMessageToLariAsync auto-detects the correction and records it.
const path = require('path');
const fs = require('fs');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const storePath = path.join(__dirname, '..', 'learned_discourse_operators.json');
if (fs.existsSync(storePath)) fs.unlinkSync(storePath);

async function main() {
  const loaded = registry.loadLariModel({});
  const model = loaded.model;
  const ctx = { operator: false, autoResearchOnUncertainty: false, groundedFactual: false };

  // Turn 1: get an answer with rephrasable content.
  const r1 = await runtime.sendMessageToLariAsync(model, 'The first option is cheap. The second option is reliable. Which should I pick?', ctx);
  console.log('turn 1 answer:', JSON.stringify(String(r1.answer).slice(0, 120)));
  console.log('turn 1 discourseCorrection:', JSON.stringify(r1.discourseCorrection || null));

  // Turn 2: user corrects how Lari phrased it (shares content words + marker).
  const correction = `${String(r1.answer).split('.')[0]} yet the value is questionable.`;
  const r2 = await runtime.sendMessageToLariAsync(model, correction, ctx);
  console.log('turn 2 sent:', JSON.stringify(correction.slice(0, 100)));
  console.log('turn 2 discourseCorrection:', JSON.stringify(r2.discourseCorrection || null));

  // A non-correction follow-up must NOT trigger.
  const r3 = await runtime.sendMessageToLariAsync(model, 'Thanks, that helps.', ctx);
  console.log('turn 3 (thanks) discourseCorrection:', JSON.stringify(r3.discourseCorrection || null));

  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  console.log('store entries:', store.entries.length, '| pending signatures:', Object.keys(store.pending).length);
  console.log(r2.discourseCorrection?.detected ? 'LIVE LOOP: DETECTED' : 'LIVE LOOP: NOT DETECTED');
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
