#!/usr/bin/env node
'use strict';

/**
 * Run every benchmark observed passing in the Phase 0 survey, so none of them can rot unnoticed.
 *
 * 85 of 303 benchmarks were failing and nobody knew, because `npm test` gated 24 of 361 npm scripts.
 * This closes that hole for the 206 that were healthy on 2026-07-31: if one of them breaks later, this
 * says so.
 *
 * It is separate from `npm test` on purpose. The suite has to stay fast enough to run on every commit;
 * this takes far longer, and it belongs in a slower lane rather than making the fast one unusable.
 *
 * **The counts are kept apart deliberately.** A benchmark that passes while reaching into runtime
 * internals proves a function works. A benchmark that passes while asking Lari proves the product
 * works. Only 16 of 303 use the front door. Adding those numbers together would manufacture a
 * capability claim, so this reports them separately and always will.
 *
 * Usage:
 *   node scripts/run_lari_phase0_gate.js [--timeout 120000] [--limit 0]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE_LIST = path.join(ROOT, 'holdouts', 'PHASE0_GATE_LIST.json');
const SURVEY = path.join(ROOT, 'holdouts', 'PHASE0_SURVEY.json');

function main() {
  const argv = process.argv.slice(2);
  const timeout = Number((argv[argv.indexOf('--timeout') + 1]) || 120000);
  const limit = Number((argv[argv.indexOf('--limit') + 1]) || 0);

  if (!fs.existsSync(GATE_LIST)) {
    console.error('No gate list. Run: npm run lari:phase0');
    process.exit(1);
  }
  const gate = JSON.parse(fs.readFileSync(GATE_LIST, 'utf8'));
  const survey = JSON.parse(fs.readFileSync(SURVEY, 'utf8'));

  const regressions = [];
  let ran = 0;
  let passed = 0;
  const askLari = { ran: 0, passed: 0 };

  for (const file of gate.benchmarks) {
    if (limit && ran >= limit) break;
    const entryPoint = (survey.results[file] || {}).entryPoint || 'unknown';
    const isFrontDoor = entryPoint === 'asks-lari' || entryPoint === 'unified-kernel';
    const run = spawnSync('node', [path.join('benchmarks', file)], {
      cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true,
      env: { ...process.env, LARI_AUTONOMOUS_LEARNING: '0' }
    });
    ran += 1;
    if (isFrontDoor) askLari.ran += 1;

    const ok = run.status === 0;
    if (ok) { passed += 1; if (isFrontDoor) askLari.passed += 1; }
    else {
      regressions.push({
        file,
        entryPoint,
        exitCode: run.status,
        tail: String(run.stderr || run.stdout || '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 180)
      });
      console.log(`REGRESSED  ${entryPoint.padEnd(18)} ${file}`);
    }
  }

  const summary = {
    benchmark: 'lari-phase0-gate',
    baselineDate: gate.generatedAt,
    ran,
    passed,
    regressions: regressions.length,
    frontDoor: askLari,
    reading: 'frontDoor counts benchmarks that ask Lari. The other passes prove functions work, not '
      + 'that the product does. Never add them together.',
    regressionDetail: regressions,
    externalModelCalls: 0
  };
  console.log(`\n${JSON.stringify(summary, null, 2)}`);
  process.exit(regressions.length ? 1 : 0);
}

main();
