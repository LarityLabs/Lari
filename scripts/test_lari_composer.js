#!/usr/bin/env node
/**
 * Novel constrained composer regression test (2026-09-21).
 *
 * Verifies the composer's core guarantees deterministically:
 *   1. Never emits fabricated filler ("useful concrete detail", "detail detail", ...)
 *   2. Honest shortfall when the content pool cannot cover the demand
 *   3. Creative tasks (poem/joke) get an honest refusal, not a template
 *   4. Real content + mechanical constraints compose correctly
 *
 * Run: node scripts/test_lari_composer.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
const BASE_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const SCRATCH = path.join(process.env.HOME || '/root', 'workspace', 'scratch', 'lari-composer-test');
fs.mkdirSync(SCRATCH, { recursive: true });

const FILLER = /useful concrete detail|another useful point|offers useful detail|calm words provide|receives useful practical attention|(\bdetail\b[ ,]*){3,}|\*focus \d+\* offers useful/i;
const SHORTFALL = /i do not have enough grounded local knowledge|i cannot compose/i;

function freshModel(tag) {
  const dst = path.join(SCRATCH, `model-${tag}-${process.pid}.json`);
  const m = JSON.parse(fs.readFileSync(BASE_MODEL, 'utf8'));
  m.__lariSourcePath = dst;
  fs.writeFileSync(dst, JSON.stringify(m));
  return JSON.parse(fs.readFileSync(dst, 'utf8'));
}

async function ask(text) {
  const r = await runtime.sendMessageToLariAsync(freshModel(Math.random().toString(36).slice(2)), text, {});
  return typeof r === 'string' ? r : String((r && r.answer) || '');
}

const sentences = t => String(t).split(/[.!?]+/).filter(s => s.trim()).length;
const paragraphs = t => String(t).split(/\n\s*\n/).filter(s => s.trim()).length;

const CASES = [
  {
    id: 'composer-real-content',
    prompt: 'Write exactly 3 sentences about dogs.',
    check: a => ({
      pass: sentences(a) === 3 && !FILLER.test(a) && /dog/i.test(a),
      note: `${sentences(a)} sentences, filler=${FILLER.test(a)}: ${a.slice(0, 90)}`,
    }),
  },
  {
    id: 'composer-honest-shortfall',
    prompt: 'Write a 500 word essay about quantum teleportation with no commas.',
    check: a => ({
      pass: !FILLER.test(a) && SHORTFALL.test(a) && !/,/.test(a),
      note: `filler=${FILLER.test(a)} shortfall=${SHORTFALL.test(a)}: ${a.slice(0, 90)}`,
    }),
  },
  {
    id: 'composer-creative-refusal',
    prompt: 'Write a poem about the sea in exactly 4 lines.',
    check: a => ({
      pass: !FILLER.test(a) && /i cannot compose/i.test(a),
      note: `${a.slice(0, 90)}`,
    }),
  },
  {
    id: 'composer-word-count',
    prompt: 'Reply with exactly five words.',
    check: a => {
      const n = a.trim().split(/\s+/).filter(Boolean).length;
      return { pass: n === 5 && !FILLER.test(a), note: `${n} words: ${a.slice(0, 80)}` };
    },
  },
  {
    id: 'composer-paragraphs',
    prompt: 'Write 2 paragraphs about marketing.',
    check: a => ({
      pass: paragraphs(a) === 2 && !FILLER.test(a) && /market/i.test(a),
      note: `${paragraphs(a)} paragraphs, filler=${FILLER.test(a)}: ${a.slice(0, 90)}`,
    }),
  },
];

(async () => {
  let pass = 0;
  for (const c of CASES) {
    let result;
    try {
      const answer = await ask(c.prompt);
      result = c.check(answer);
    } catch (e) {
      result = { pass: false, note: `ERROR: ${e.message}` };
    }
    if (result.pass) pass++;
    console.log(`${result.pass ? 'PASS' : 'FAIL'} [composer] ${c.id} — ${result.note}`);
  }
  console.log(`\nTOTAL: ${pass}/${CASES.length} (${Math.round(pass / CASES.length * 100)}%)`);
  process.exit(pass === CASES.length ? 0 : 1);
})();
