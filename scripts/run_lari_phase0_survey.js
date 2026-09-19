#!/usr/bin/env node
'use strict';

/**
 * Phase 0: run every benchmark and record what actually passes.
 *
 * `npm test` gates 24 of 361 npm scripts. There are 303 benchmarks and nobody knows how many still
 * work, because nothing runs them. Every plan made against that ignorance has produced wasted work,
 * including five modules rebuilt in a single day.
 *
 * This runs them one at a time, bounded, and writes a resumable report. It fixes nothing and judges
 * nothing -- it produces the first honest map of the capability surface, which is the input every later
 * phase needs.
 *
 * Two things it records that a bare pass/fail would miss:
 *
 *   - `entryPoint`: whether the benchmark calls `sendMessageToLari` (asks Lari), the unified kernel, or
 *     neither (reaches past the front door into runtime internals). Measured 2026-07-31: only 17 of 303
 *     ask Lari. A passing benchmark that never asks Lari proves a function works, not that the product
 *     does, and the two must never be added together.
 *   - `timedOut` separately from `failed`. An oracle that did not finish is not a failure of the code,
 *     and conflating them is the tabulate 0/64 mistake.
 *
 * Resumable: an existing report is loaded and completed entries are skipped, so this can be run in
 * slices without losing work.
 *
 * Usage:
 *   node scripts/run_lari_phase0_survey.js [--timeout 120000] [--limit 0] [--filter <substring>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BENCH_DIR = path.join(ROOT, 'benchmarks');
const REPORT = path.join(ROOT, 'holdouts', 'PHASE0_SURVEY.json');

function parseArgs(argv) {
  const args = { timeout: 120000, limit: 0, filter: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--timeout') args.timeout = Number(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--filter') args.filter = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function entryPointOf(text) {
  if (/sendMessageToLari/.test(text)) return 'asks-lari';
  if (/runLariUnifiedTaskKernel/.test(text)) return 'unified-kernel';
  if (/swarm_model_runtime|SwarmModelRuntime/.test(text)) return 'runtime-internals';
  return 'no-runtime';
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let report = { schemaVersion: 1, kind: 'lari.phase0.survey', startedAt: new Date().toISOString(), results: {} };
  if (fs.existsSync(REPORT)) {
    try { report = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch (e) { /* start fresh */ }
  }
  report.results = report.results || {};

  let files = fs.readdirSync(BENCH_DIR).filter(f => f.startsWith('run_') && f.endsWith('.js')).sort();
  if (args.filter) files = files.filter(f => f.includes(args.filter));

  let ran = 0;
  for (const file of files) {
    if (args.limit && ran >= args.limit) break;
    if (report.results[file]) continue;   // resumable

    const text = fs.readFileSync(path.join(BENCH_DIR, file), 'utf8');
    const entryPoint = entryPointOf(text);
    const started = Date.now();
    const run = spawnSync('node', [path.join('benchmarks', file)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: args.timeout,
      windowsHide: true,
      env: { ...process.env, LARI_AUTONOMOUS_LEARNING: '0' }
    });

    // A timeout is not a failure of the code under test. Kept distinct on purpose.
    const timedOut = run.error && /ETIMEDOUT|timed out/i.test(String(run.error.message))
      || run.signal === 'SIGTERM';
    const outcome = timedOut ? 'timeout' : (run.status === 0 ? 'pass' : 'fail');

    report.results[file] = {
      outcome,
      entryPoint,
      exitCode: run.status,
      seconds: Math.round((Date.now() - started) / 1000),
      tail: String(run.stderr || run.stdout || '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 200)
    };
    ran += 1;
    console.log(`${outcome.padEnd(8)} ${entryPoint.padEnd(18)} ${file}`);
    fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  }

  const results = Object.values(report.results);
  const by = key => results.filter(r => r.outcome === key).length;
  report.summary = {
    completed: results.length,
    total: files.length,
    pass: by('pass'),
    fail: by('fail'),
    timeout: by('timeout'),
    passingThatAskLari: results.filter(r => r.outcome === 'pass' && r.entryPoint === 'asks-lari').length,
    passingViaInternals: results.filter(r => r.outcome === 'pass' && r.entryPoint === 'runtime-internals').length
  };
  report.reading = 'A pass whose entryPoint is runtime-internals proves a function works, not that the '
    + 'product does. Never add those to the passes that ask Lari.';
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${JSON.stringify(report.summary, null, 2)}`);
  console.log(`\n-> ${path.relative(ROOT, REPORT)}   (re-run to continue; completed entries are skipped)`);
}

try { main(); } catch (error) { console.error(String(error.message || error)); process.exit(1); }
