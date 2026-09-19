#!/usr/bin/env node
'use strict';

/**
 * Run both conditions of a transfer measurement, sequentially, against one sealed set.
 *
 * Why this is a script and not two commands
 * -----------------------------------------
 * The two conditions share a repository working tree. They check out, seed a mutation, write
 * candidates and reset -- so two of them running at once corrupt each other silently, and the result
 * looks like a measurement rather than like a mistake. On 2026-07-27 a sealed run was started while a
 * shakedown was still finishing, and the only safe response was to discard it and start over. A lock
 * makes that structurally impossible instead of a thing to remember.
 *
 * It also removes the chance of the two conditions differing in anything but the model: same manifest,
 * same budget, same growth setting, same oracle, in one place.
 *
 * Usage:
 *   node scripts/run_lari_transfer_comparison.js --manifest <manifest.json> --model <trained.json>
 *     [--limit 640] [--out <dir>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { manifestPath: null, modelPath: null, limit: 640, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') args.manifestPath = path.resolve(argv[++i]);
    else if (argv[i] === '--model') args.modelPath = path.resolve(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.manifestPath) throw new Error('--manifest is required');
  if (!args.modelPath) throw new Error('--model is required');
  return args;
}

/**
 * A lock on the repository under test, not on this script.
 *
 * Two different sealed sets can name the same repository, so the lock has to live where the conflict
 * actually is. Stale locks from a killed run are detected by checking whether the recorded process is
 * still alive -- a lock nobody can clear is its own outage.
 */
function acquireRepoLock(repo) {
  const lockPath = path.join(repo, '.lari-measurement-lock');
  if (fs.existsSync(lockPath)) {
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) { holder = null; }
    const pid = Number(holder?.pid);
    let alive = false;
    if (pid) {
      try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; }
    }
    if (alive) {
      throw new Error(
        `Another measurement holds ${repo} (pid ${pid}, started ${holder?.startedAt}). `
        + 'Two runs share this working tree and would corrupt each other. Wait for it, or stop it first.');
    }
    console.error(`clearing a stale lock from pid ${pid || 'unknown'}`);
    fs.rmSync(lockPath, { force: true });
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  const release = () => { try { fs.rmSync(lockPath, { force: true }); } catch (_) { /* best effort */ } };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  return release;
}

function measure({ manifestPath, limit, modelPath, outPath }) {
  const args = [path.join(ROOT, 'scripts', 'measure_lari_mechanical_holdout.js'),
    '--manifest', manifestPath, '--limit', String(limit), '--no-growth'];
  if (modelPath) args.push('--model', modelPath);
  const started = Date.now();
  // process.execPath, not 'node': on Windows a bare 'node' fails ENOENT from a spawn without a shell,
  // and this script reported it as a run that took zero seconds and produced an empty comparison.
  const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = String(run.stdout || '') + String(run.stderr || '');
  fs.writeFileSync(outPath, text);

  // A measurement that did not run must not look like a measurement that found nothing. The first
  // version of this script wrote a tidy comparison.json full of empty results after both conditions
  // failed to launch -- the same shape of error as an oracle reporting rejection when it never ran.
  if (run.error) throw new Error(`Could not start the measurement: ${run.error.code || run.error.message}`);
  if (run.status !== 0) throw new Error(`Measurement exited ${run.status}. Output kept at ${outPath}`);
  if (!/"benchmark"/.test(text)) throw new Error(`Measurement produced no summary. Output kept at ${outPath}`);
  return { text, seconds: Math.round((Date.now() - started) / 1000), status: run.status };
}

function parseRecords(text) {
  return text.split(/\n(?=\{)/)
    .map(block => { try { return JSON.parse(block); } catch (_) { return null; } })
    .filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));
  const sealPath = path.join(path.dirname(args.manifestPath), 'seal-commitment.json');
  if (!fs.existsSync(sealPath)) {
    throw new Error(`No seal at ${sealPath}. Predict and seal before measuring -- scripts/seal_lari_prediction.js.`);
  }
  const outDir = args.out || path.join(ROOT, 'holdouts', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const tag = manifest.id.replace(/[^a-z0-9]+/gi, '-');

  const release = acquireRepoLock(manifest.repo.path);
  try {
    console.error(`baseline: seed vocabulary, budget ${args.limit}`);
    const baseline = measure({
      manifestPath: args.manifestPath, limit: args.limit, modelPath: null,
      outPath: path.join(outDir, `${tag}-BASELINE.txt`)
    });
    console.error(`  ${baseline.seconds}s`);

    console.error(`transfer: ${path.basename(args.modelPath)}, budget ${args.limit}`);
    const transfer = measure({
      manifestPath: args.manifestPath, limit: args.limit, modelPath: args.modelPath,
      outPath: path.join(outDir, `${tag}-TRANSFER.txt`)
    });
    console.error(`  ${transfer.seconds}s`);

    const b = parseRecords(baseline.text);
    const t = parseRecords(transfer.text);
    const bRows = b.filter(r => r.instance);
    const tRows = t.filter(r => r.instance);
    const bSummary = b.find(r => r.benchmark) || {};
    const tSummary = t.find(r => r.benchmark) || {};

    // The delta alone is not the claim. A repair counts as transfer only when the winning family is
    // one the seed vocabulary does not contain, which is what separates "a learned rule worked" from
    // "the ordering happened to help".
    const seedFamilies = new Set(require(path.join(ROOT, 'swarm_mutation_repair.js')).FAMILIES);
    const credited = tRows.filter(row => {
      const before = bRows.find(x => x.instance === row.instance);
      return row.repaired && !before?.repaired && row.family && !seedFamilies.has(row.family);
    }).map(row => ({
      instance: row.instance,
      operator: row.operator,
      family: row.family,
      substitution: row.description,
      restoresUpstreamExactly: row.restoresUpstreamExactly,
      foundAtVerification: row.verifications,
      seconds: row.seconds
    }));

    const report = {
      holdout: manifest.id,
      budget: args.limit,
      baseline: { score: bSummary.score, exact: bSummary.repairsMatchingUpstreamExactly, seconds: baseline.seconds },
      transfer: { score: tSummary.score, exact: tSummary.repairsMatchingUpstreamExactly, seconds: transfer.seconds },
      creditedTransferRepairs: credited,
      regressions: bRows.filter(row => {
        const after = tRows.find(x => x.instance === row.instance);
        return row.repaired && !after?.repaired;
      }).map(row => row.instance),
      note: credited.length
        ? 'A repair is credited only when its winning family is absent from the seed vocabulary.'
        : 'No credited transfer repair. Any delta here came from ordering, not from a learned rule, and must be reported that way.'
    };
    const reportPath = path.join(path.dirname(args.manifestPath), 'comparison.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    console.error(`\nwrote ${reportPath}`);
  } finally {
    release();
  }
}

main();
