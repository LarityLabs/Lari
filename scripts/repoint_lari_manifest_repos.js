#!/usr/bin/env node
'use strict';

/**
 * Repoint sealed manifests at the preserved repository checkouts.
 *
 * Every manifest in holdouts/ recorded a repository path under %TEMP% from a July 2026 session. The
 * repositories are now preserved at scratch/lari-benchmark-repos, but saving them changed nothing on
 * its own: the manifests still named the temp path, so every sealed set in this project remained
 * unreproducible the moment that directory is cleared. Half a fix is not a fix.
 *
 * Editing a sealed artifact is exactly what VISION.md warns about, so this is deliberately the
 * narrowest possible change and it refuses rather than guesses:
 *
 *   - It rewrites `repo.path` ONLY. Seed, instance list, operators, oracle, commit and every hash are
 *     untouched, and the script asserts they are byte-identical before and after.
 *   - It refuses to repoint unless the checkout at the new path is at the SAME commit the manifest
 *     names. A path pointing at different code would silently invalidate the set while making it look
 *     healthy, which is worse than a broken path.
 *   - It records `repoPathHistory` on the manifest, so the edit is visible rather than silent.
 *
 * A path is where a copy lives; the commit is what was measured. Repointing a path to a verified
 * identical checkout does not change any experiment. Changing anything else here would.
 *
 * Usage:
 *   node scripts/repoint_lari_manifest_repos.js --to <dir> [--apply]
 * Without --apply it reports what it would do and writes nothing.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOLDOUTS = path.join(ROOT, 'holdouts');

function args(argv) {
  const out = { to: null, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--to') out.to = path.resolve(argv[++i]);
    else if (argv[i] === '--apply') out.apply = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!out.to) throw new Error('--to <dir> is required');
  return out;
}

function findManifests(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findManifests(full, found);
    else if (entry.name === 'manifest.json') found.push(full);
  }
  return found;
}

function headOf(repoDir) {
  try {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

function main() {
  const { to, apply } = args(process.argv.slice(2));
  const rows = [];

  for (const file of findManifests(HOLDOUTS)) {
    const raw = fs.readFileSync(file, 'utf8');
    const manifest = JSON.parse(raw);
    const name = path.basename(path.dirname(file));
    const current = manifest.repo?.path || null;
    const commit = manifest.repo?.commit || null;

    if (!current) { rows.push({ name, action: 'skip', why: 'no repo path recorded' }); continue; }

    // A temp path is repointed whether or not it currently resolves.
    //
    // The first version skipped anything that still existed, which repointed nothing: the scratchpad
    // had not been cleared yet, so every stale path resolved and the script reported all clear. That is
    // the defect restating itself -- the problem was never that the paths are broken today, it is that
    // they are one cleanup away from being broken with no warning, and "it works right now" is exactly
    // the reading that let this sit unnoticed across every sealed set in the project.
    const fragile = /[\\/](?:Temp|tmp|TEMP)[\\/]/.test(current);
    if (!fragile && fs.existsSync(current)) {
      rows.push({ name, action: 'skip', why: 'path is durable and resolves' });
      continue;
    }
    if (!commit) { rows.push({ name, action: 'REFUSE', why: 'no commit recorded; cannot verify a replacement' }); continue; }

    const candidate = path.join(to, path.basename(current));
    if (!fs.existsSync(candidate)) {
      rows.push({ name, action: 'REFUSE', why: `no preserved checkout at ${candidate}` });
      continue;
    }
    const head = headOf(candidate);
    if (head !== commit) {
      rows.push({
        name,
        action: 'REFUSE',
        why: `commit mismatch: manifest names ${String(commit).slice(0, 12)}, checkout is ${String(head).slice(0, 12)}`
      });
      continue;
    }

    if (!apply) { rows.push({ name, action: 'would repoint', why: candidate }); continue; }

    // The narrowest possible edit, then assert that it was the only one.
    const before = JSON.parse(raw);
    manifest.repo.path = candidate;
    manifest.repoPathHistory = [
      ...(manifest.repoPathHistory || []),
      {
        from: current,
        to: candidate,
        at: new Date().toISOString().slice(0, 10),
        why: 'the original path was a session scratchpad under %TEMP%; the checkout is preserved and verified at the same commit',
        verifiedCommit: commit
      }
    ];
    const after = JSON.parse(JSON.stringify(manifest));
    delete after.repoPathHistory;
    after.repo.path = current;
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      rows.push({ name, action: 'REFUSE', why: 'the edit changed more than repo.path; refusing to write' });
      continue;
    }

    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    rows.push({ name, action: 'repointed', why: candidate });
  }

  for (const row of rows) {
    console.log(`${row.action.padEnd(14)} ${row.name.padEnd(34)} ${row.why}`);
  }
  const refused = rows.filter(r => r.action === 'REFUSE');
  console.log(`\n${rows.length} manifests, ${rows.filter(r => r.action === 'repointed').length} repointed, `
    + `${rows.filter(r => r.action === 'would repoint').length} pending, ${refused.length} refused.`);
  if (!apply) console.log('Dry run. Re-run with --apply to write.');
  process.exit(refused.length ? 1 : 0);
}

main();
