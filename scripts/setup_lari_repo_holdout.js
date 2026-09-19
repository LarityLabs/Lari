#!/usr/bin/env node
'use strict';

/**
 * Materialize a sealed repository holdout from its manifest.
 *
 * Clones each project at a pinned commit, applies the seeded regression, installs the sealed test
 * oracle, and writes the instances.json / workspaces.json that the dockerless bridge consumes.
 *
 * The checkouts land under consolidation/ (git-ignored, since vendoring OSS clones is what made this
 * repository 24 GB). Only the manifest, the tests, and the seal are committed, which is enough to
 * reproduce the holdout exactly.
 *
 * Every seeded regression is verified to actually break its oracle before the set is usable. A seed
 * that silently fails to apply would produce a benchmark that passes for the wrong reason -- the same
 * class of error as a gate that cannot fail.
 *
 * Usage:
 *   node scripts/setup_lari_repo_holdout.js --manifest holdouts/repo-acceptance-20260725/manifest.json
 *   node scripts/setup_lari_repo_holdout.js --manifest <path> --force
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { force: false, manifestPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--force') args.force = true;
    else if (token === '--manifest') {
      if (!argv[index + 1]) throw new Error('--manifest requires a path.');
      args.manifestPath = path.resolve(argv[++index]);
    } else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.manifestPath && !args.help) throw new Error('--manifest is required.');
  return args;
}

function run(command, commandArgs, cwd, timeout = 300000) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', windowsHide: true, timeout });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Delete every __pycache__ under a checkout.
 *
 * CPython validates cached bytecode against the source file's mtime and size. A same-length edit
 * such as max -> min can therefore leave a stale .pyc in force: the source reads "min" while the
 * imported function still behaves like "max". That silently invalidates any measurement built on it,
 * so caches are cleared after every source mutation rather than trusted.
 */
function clearPycache(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (entry.name === '__pycache__') fs.rmSync(child, { recursive: true, force: true });
      else if (entry.name !== '.git') stack.push(child);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Materialize a sealed repository holdout from its manifest.');
    console.log('  --manifest <path>  holdout manifest to materialize (required)');
    console.log('  --force            re-clone even if the checkout already exists');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));
  const manifestDir = path.dirname(args.manifestPath);
  const setRoot = path.join(ROOT, 'consolidation', `repo-holdout-${manifest.id}`);
  fs.mkdirSync(setRoot, { recursive: true });

  const workspaces = {};
  const instances = [];
  const report = [];

  for (const instance of manifest.instances) {
    const checkout = path.join(setRoot, instance.instance_id);

    if (args.force && fs.existsSync(checkout)) fs.rmSync(checkout, { recursive: true, force: true });

    if (!fs.existsSync(checkout)) {
      const cloned = run('git', ['clone', '--quiet', instance.url, checkout], ROOT, 600000);
      if (!cloned.ok) throw new Error(`Clone failed for ${instance.instance_id}: ${cloned.stderr.trim()}`);
    }

    // Pin to the committed base commit, discarding anything left from a previous run.
    const checkedOut = run('git', ['checkout', '--quiet', '--force', instance.base_commit], checkout);
    if (!checkedOut.ok) throw new Error(`Checkout of ${instance.base_commit} failed for ${instance.instance_id}: ${checkedOut.stderr.trim()}`);
    run('git', ['clean', '-qfd'], checkout);

    // Install the sealed oracle.
    const testDir = path.join(checkout, '.lari-public-tests');
    fs.mkdirSync(testDir, { recursive: true });
    const oracleSource = fs.readFileSync(path.join(manifestDir, 'tests', instance.testFile), 'utf8');
    fs.writeFileSync(path.join(testDir, instance.testFile), oracleSource);

    // The oracle must PASS on pristine upstream source. If it does not, the oracle is wrong.
    const testRelative = `.lari-public-tests/${instance.testFile}`;
    clearPycache(checkout);
    const pristine = run('python', [testRelative], checkout);
    if (!pristine.ok) {
      throw new Error(
        `Oracle for ${instance.instance_id} fails on pristine upstream source at ${instance.base_commit}. `
        + `The test is wrong, not the code.\n${(pristine.stderr || pristine.stdout).trim().slice(-800)}`
      );
    }

    // Apply the seeded regression.
    const targetPath = path.join(checkout, instance.targetFile);
    const before = fs.readFileSync(targetPath, 'utf8');

    // git may check files out with CRLF on Windows, which silently defeats any anchor containing a
    // bare \n. Match against the file's actual line endings rather than assuming LF.
    let find = instance.seed.find;
    let replace = instance.seed.replace;
    if (!before.includes(find) && find.includes('\n') && before.includes('\r\n')) {
      find = find.replace(/\n/g, '\r\n');
      replace = replace.replace(/\n/g, '\r\n');
    }

    if (!before.includes(find)) {
      throw new Error(
        `Seed anchor not found in ${instance.instance_id} -> ${instance.targetFile}. `
        + 'Upstream source changed (re-pin the commit), or the anchor spans lines and the file uses '
        + 'different line endings.'
      );
    }
    const occurrences = before.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Seed anchor is ambiguous in ${instance.instance_id} (${occurrences} matches). Make it unique.`);
    }
    fs.writeFileSync(targetPath, before.replace(find, replace));

    // The regression must now BREAK the oracle, or the holdout measures nothing.
    clearPycache(checkout);
    const seeded = run('python', [testRelative], checkout);
    if (seeded.ok) {
      throw new Error(`Seeded regression for ${instance.instance_id} did not break its oracle. The bug or the test is ineffective.`);
    }

    // Commit the seeded state as this checkout's baseline. The acceptance runner treats a dirty tree
    // as a leftover patch from a previous run, so the seed must be committed rather than left as a
    // working-tree edit. This also makes `git checkout -- .` restore the seeded-buggy baseline,
    // matching how the 20260722 set behaves.
    run('git', ['add', '-A'], checkout);
    const committed = run('git', [
      '-c', 'user.name=Lari Holdout Setup',
      '-c', 'user.email=holdout@localhost',
      'commit', '--quiet', '-m', `Seed sealed regression and oracle for ${instance.instance_id}`
    ], checkout);
    if (!committed.ok) {
      throw new Error(`Could not commit the seeded baseline for ${instance.instance_id}: ${committed.stderr.trim()}`);
    }
    const residual = run('git', ['status', '--short'], checkout).stdout.trim();
    if (residual) {
      throw new Error(`Seeded checkout for ${instance.instance_id} is still dirty after commit:\n${residual}`);
    }

    // The bridge verifies that the checkout HEAD equals the instance's base_commit, so the instance
    // must be pinned to the SEEDED commit rather than to pristine upstream. The instance under repair
    // is the seeded state; the upstream commit is retained separately for provenance.
    const seededCommit = run('git', ['rev-parse', 'HEAD'], checkout).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(seededCommit)) {
      throw new Error(`Could not resolve the seeded commit for ${instance.instance_id}.`);
    }

    workspaces[instance.instance_id] = {
      path: checkout,
      testPath: testRelative,
      testRunner: 'python.script',
      expressionTarget: instance.targetFile,
      expressionCandidateLimit: 64,
      executor: 'local_isolated_checkout'
    };

    instances.push({
      instance_id: instance.instance_id,
      repo: instance.repo,
      base_commit: seededCommit,
      upstream_commit: instance.base_commit,
      problem_statement: instance.bugDescription
    });

    report.push({
      instance: instance.instance_id,
      classification: instance.classification,
      oraclePassesPristine: true,
      seedBreaksOracle: true,
      targetFile: instance.targetFile,
      upstreamCommit: instance.base_commit,
      seededCommit,
      oracleSha256: sha256(oracleSource)
    });
  }

  fs.writeFileSync(path.join(setRoot, 'workspaces.json'), JSON.stringify(workspaces, null, 2) + '\n');
  fs.writeFileSync(path.join(setRoot, 'instances.json'), JSON.stringify(instances, null, 2) + '\n');

  console.log(JSON.stringify({
    holdout: manifest.id,
    setRoot: path.relative(ROOT, setRoot).replace(/\\/g, '/'),
    instanceCount: instances.length,
    allOraclesValidated: true,
    detail: report
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}
