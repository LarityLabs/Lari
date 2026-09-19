#!/usr/bin/env node
'use strict';
// Broader factual-chat probe matrix (fail-before / pass-after).
// Categories: definitions, dates, people, quantities, historical-vs-current,
// unsupported/ambiguous (should fail closed), plus identity regression.
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime');
const registry = require('./lari_model_registry.js');

// Isolated model copy: the matrix does live research, which checkpoints.
// Never let it write to the canonical model file.
const ROOT = path.resolve(__dirname, '..');
const TEST_BASE = path.join(ROOT, '..', 'tmp');
fs.mkdirSync(TEST_BASE, { recursive: true });
const TEST_DIR = fs.mkdtempSync(path.join(TEST_BASE, 'lari-matrix-test-'));
const TEST_MODEL = path.join(TEST_DIR, 'swarm-model.json');
fs.copyFileSync(path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json'), TEST_MODEL);
process.env.LARI_MODEL_PATH = TEST_MODEL;

const loaded = registry.loadLariModel({});
const model = loaded.model;

async function ask(prompt) {
  const response = await runtime.sendMessageToLariAsync(model, { prompt }, {
    userScope: 'default',
    modelHash: null,
    autoGrow: false,
    operator: false,
    groundingTimeoutMs: 20000,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
  return String(response.answer || '');
}

const probes = [
  // identity regression (should keep passing)
  { id: 'identity1', prompt: 'who are you', expect: /lari/i },
  { id: 'identity2', prompt: 'who built you', expect: /betti/i },
  // definitions
  { id: 'def1', prompt: 'what is photosynthesis', expect: /photosynthesis|plants|sunlight/i },
  { id: 'def2', prompt: 'what was the Neo-Assyrian Empire', expect: /assyria/i },
  // dates
  { id: 'date1', prompt: 'in what year did the Titanic sink', expect: /1912/ },
  { id: 'date2', prompt: 'when did World War II end', expect: /1945/ },
  // people
  { id: 'person1', prompt: 'who was Albert Einstein', expect: /einstein|relativity|physicist/i },
  { id: 'person2', prompt: 'who is the president of France', expect: /macron|france/i },
  // quantities
  { id: 'qty1', prompt: 'how many continents are there', expect: /7|seven/ },
  { id: 'qty2', prompt: 'how many legs does a spider have', expect: /8|eight/ },
  // historical vs current
  { id: 'hist1', prompt: 'what was the capital of West Germany', expect: /bonn/i },
  { id: 'cur1', prompt: 'what is the capital of Germany', expect: /berlin/i },
  // structured attributes (already fixed, regression)
  { id: 'attr1', prompt: 'what is the capital of Spain', expect: /madrid/i },
  { id: 'attr2', prompt: 'what is the currency of Brazil', expect: /real/i },
  // unsupported / ambiguous -> should fail closed
  { id: 'closed1', prompt: 'what is the capital of Narnia', closed: true },
  { id: 'closed2', prompt: 'what did Greg eat for breakfast', closed: true },
];

async function main() {
  let pass = 0, fail = 0;
  for (const p of probes) {
    let answer;
    try { answer = await ask(p.prompt); }
    catch (e) { answer = 'ERROR: ' + e.message; }
    let status;
    if (p.closed) {
      // Fail-closed = an honest deflection ("don't know / not enough memory"),
      // not a fabricated answer. The deflection text is long, so check for
      // hedge language or the absence of a confident factual claim instead.
      const hedges = /don't know|not sure|cannot|can't|no idea|unknown|unable|not find|not have enough|not enough/i.test(answer);
      const confidentClaim = /\b(is|was|are|were) (the )?(capital|currency|president)/i.test(answer);
      status = (hedges && !confidentClaim) ? 'PASS' : 'FAIL';
    } else {
      status = p.expect.test(answer) ? 'PASS' : 'FAIL';
    }
    if (status === 'PASS') pass++; else fail++;
    console.log(`[${status}] ${p.id}: "${p.prompt}"`);
    console.log(`    -> ${answer.slice(0, 240).replace(/\n/g, ' ')}`);
  }
  console.log(`\n${pass}/${probes.length} passed, ${fail} failed`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
