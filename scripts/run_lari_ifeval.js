#!/usr/bin/env node
/**
 * IFEval response collector for Small Lari.
 *
 * For each of the 541 IFEval prompts, gets Lari's response with a FRESH
 * in-memory model clone (no cross-prompt learning contamination), checkpoint
 * persistence disabled, and writes {prompt, response} JSONL for the official
 * IFEval scorer (instruction_following_eval/evaluation_main.py).
 *
 * Zero external model calls. Read-only on the runtime and base model.
 *
 * Usage: node scripts/run_lari_ifeval.js [--limit N] [--offset N]
 * Output: ~/workspace/scratch/ifeval/responses.jsonl (appended, resumable)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
const BASE_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const SCRATCH = path.join(process.env.HOME || '/root', 'workspace', 'scratch', 'ifeval');
const INPUT = path.join(SCRATCH, 'input_data.jsonl');
const RESPONSES = path.join(SCRATCH, 'responses.jsonl');
const PROGRESS = path.join(SCRATCH, 'collector-progress.log');
const TURN_TIMEOUT_MS = 60000;

fs.mkdirSync(SCRATCH, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(PROGRESS, line);
  console.log(msg);
}

function replyText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  return String(r.answer || r.text || r.reply || '');
}

async function turn(model, text) {
  const p = runtime.sendMessageToLariAsync(model, text, { persistLearnedModel: false });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), TURN_TIMEOUT_MS));
  const r = await Promise.race([p, timeout]);
  return replyText(r);
}

(async () => {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf('--limit');
  const offsetArg = args.indexOf('--offset');
  const LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;
  const OFFSET = offsetArg >= 0 ? parseInt(args[offsetArg + 1], 10) : 0;

  log(`loading base model: ${BASE_MODEL}`);
  const baseModel = JSON.parse(fs.readFileSync(BASE_MODEL, 'utf8'));
  log(`base model loaded (${(JSON.stringify(baseModel).length / 1e6).toFixed(1)} MB serialized)`);

  // Sentinel scratch file so __lariSourcePath never points at the live model.
  const sentinel = path.join(SCRATCH, 'model-sentinel.json');
  if (!fs.existsSync(sentinel)) {
    fs.writeFileSync(sentinel, JSON.stringify(baseModel));
    log(`wrote sentinel scratch model: ${sentinel}`);
  }

  const prompts = fs.readFileSync(INPUT, 'utf8').split('\n')
    .filter(Boolean).map(line => JSON.parse(line));
  log(`loaded ${prompts.length} IFEval prompts`);

  // Resumable: skip prompts already answered.
  const done = new Set();
  if (fs.existsSync(RESPONSES)) {
    for (const line of fs.readFileSync(RESPONSES, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { done.add(JSON.parse(line).prompt); } catch (_) {}
    }
  }
  log(`already have ${done.size} responses, resuming`);

  let n = 0, answered = 0, timedOut = 0;
  const t0 = Date.now();
  for (const item of prompts) {
    if (n < OFFSET) { n++; continue; }
    if (n >= OFFSET + LIMIT) break;
    n++;
    if (done.has(item.prompt)) continue;
    const model = structuredClone(baseModel);
    model.__lariSourcePath = sentinel;
    let response = '';
    try {
      response = await turn(model, item.prompt);
      answered++;
    } catch (err) {
      timedOut++;
      log(`TIMEOUT key=${item.key}: ${String(err && err.message || err).slice(0, 80)}`);
    }
    fs.appendFileSync(RESPONSES, JSON.stringify({ key: item.key, prompt: item.prompt, response }) + '\n');
    if (answered % 25 === 0) {
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      log(`progress: ${answered} answered, ${timedOut} timeouts, ${el}s elapsed`);
    }
  }
  const el = ((Date.now() - t0) / 60000).toFixed(1);
  log(`DONE: ${answered} answered, ${timedOut} timeouts in ${el} min -> ${RESPONSES}`);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
