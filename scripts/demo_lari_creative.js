#!/usr/bin/env node
/**
 * Demo: Lari's creativity engine, end to end (prototype v1).
 *
 * Fixed prompt: a paragraph about rivers. The seed pool below is authored
 * demo content, clearly labeled; phase 2 will fill the pool via Lari's
 * research loop instead. Zero external model calls, fully deterministic.
 *
 * Run: node scripts/demo_lari_creative.js
 */
'use strict';

const { composeCreative } = require('./lari_fractal_composer.js');
const sensei = require('./lari_sensei.js');

// Authored demo pool: grounded seed sentences about rivers, written for this
// prototype. Every one is labeled derivation kind "seed", ref "authored-pool".
// Phase 2 replaces this with sentences Lari researched himself.
const RIVERS_POOL = [
  'Rivers begin as small streams high in the mountains.',
  'A river carves its canyon one grain of sand at a time.',
  'Rivers carry silt, stones, and stories downstream.',
  'No river hurries, yet every river arrives.',
  'A river never runs backward, though it often bends.',
  'Rivers feed the fields that feed the towns.',
  'At dusk the river turns to hammered copper.',
  'Every river is a road that builds itself as it travels.',
  'Rivers remember every stone they have ever touched.',
  'A river does not argue with the canyon, it outlasts it.',
  'Rivers join other rivers and grow strong together.',
  'The river gives the valley its shape and its name.'
];

function main() {
  const result = composeCreative({
    topic: 'rivers',
    seedImage: 'a river cutting through a canyon at dusk, patient and unstoppable',
    targetSentences: 9,
    pool: RIVERS_POOL
  });

  if (!result.ok) {
    console.error(`honest refusal: ${result.honest}`);
    process.exit(1);
  }

  console.log(`${result.label}\n`);
  console.log('--- THE PIECE ---\n');
  console.log(`${result.piece}\n`);
  console.log('--- DERIVATION TRACE ---\n');
  for (const t of result.trace) {
    console.log(`[${t.index}] (${t.beat}) ${t.text}`);
    console.log(`    ${t.chain}`);
  }
  console.log('\n--- BRAID SUMMARY ---');
  console.log(`giants in registry: ${result.giantsAttempted}, lens applications kept: ${result.giantsApplied.length}`);
  for (const a of result.giantsApplied) {
    console.log(`- ${a.giantName} / ${a.lensName} on sentence ${a.sentenceIndex}`);
  }
  console.log(`\ntraceability: ${result.verification.ok ? 'every sentence rooted in seed' : 'FAILURES: ' + JSON.stringify(result.verification.failures)}`);
  console.log(`external_model_calls: ${result.external_model_calls}`);

  // Prove the sensei recorder works without touching chat.
  sensei.ensureSenseiFile();
  console.log(`\nsensei store: ${sensei.SENSEI_PATH} (git-ignored, ${sensei.listPairs().length} pairs recorded)`);
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(`demo failed: ${error.stack || error.message}`);
  process.exit(1);
}
