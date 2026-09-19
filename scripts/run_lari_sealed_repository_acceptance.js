#!/usr/bin/env node
'use strict';

/**
 * Sealed real-repository acceptance runner.
 *
 * This is the one evaluation in this repository that can genuinely fail, and the only one whose
 * oracle Lari does not control: three real OSS checkouts pinned to specific commits, each carrying a
 * seeded regression, each with a committed test that must go fail -> pass. Nothing is keyed to these
 * repositories, so movement here is a real capability claim.
 *
 * Before 2026-07-25 this harness had no runner and no npm script; the recorded 20260722 result was
 * produced ad hoc, which is why it had not been re-measured since. It now runs with one command.
 *
 * What it does:
 *   1. Verifies every workspace exists and is a clean checkout (refusing to mix a stale patch with
 *      new output -- the bridge enforces this too, but failing early gives a clearer message).
 *   2. Confirms every sealed test FAILS first. A benchmark whose baseline already passes measures
 *      nothing, so this is a hard precondition, not a formality.
 *   3. Runs the dockerless bridge in --reuse-only mode (retained operators only, no new learning).
 *   4. Re-runs every test and reports the honest score.
 *   5. Restores the workspaces to their sealed buggy state so the next run is valid.
 *
 * Usage:
 *   npm run lari:sealed-acceptance
 *   node scripts/run_lari_sealed_repository_acceptance.js --keep-patches
 *   node scripts/run_lari_sealed_repository_acceptance.js --set <acceptance-dir>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SET = path.join(ROOT, 'consolidation', 'real-repository-acceptance-20260722');

function parseArgs(argv) {
  const args = {
    keepPatches: false,
    setDir: DEFAULT_SET,
    allowDiscovery: false,
    modelPath: null,
    artifactDir: null,
    reportPath: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--keep-patches') args.keepPatches = true;
    else if (token === '--allow-discovery') args.allowDiscovery = true;
    else if (token === '--set') {
      if (!argv[index + 1]) throw new Error('--set requires a directory.');
      args.setDir = path.resolve(argv[++index]);
    } else if (token === '--model-path') {
      if (!argv[index + 1]) throw new Error('--model-path requires a file.');
      args.modelPath = path.resolve(argv[++index]);
    } else if (token === '--artifact-dir') {
      if (!argv[index + 1]) throw new Error('--artifact-dir requires a directory.');
      args.artifactDir = path.resolve(argv[++index]);
    } else if (token === '--report') {
      if (!argv[index + 1]) throw new Error('--report requires a file.');
      args.reportPath = path.resolve(argv[++index]);
    } else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function git(cwd, gitArgs) {
  return spawnSync('git', gitArgs, { cwd, encoding: 'utf8', windowsHide: true });
}

/**
 * Delete every __pycache__ under a checkout before running its oracle.
 *
 * CPython validates cached bytecode against source mtime and size, so a same-length patch (for
 * example flipping min to max, or > to >=) can leave stale bytecode in force. The source would then
 * show the repair while the imported function still runs the old behaviour -- producing a pass or a
 * fail that reflects the cache rather than the patch. This was observed while building the 20260725
 * holdout, where a seeded min/max regression appeared to have no effect at all.
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

function runTest(workspace) {
  clearPycache(workspace.path);
  const runner = String(workspace.testRunner || 'python.script').toLowerCase();
  const commands = {
    'python.script': ['python', [workspace.testPath]],
    'python.pytest': ['python', ['-m', 'pytest', workspace.testPath]],
    'javascript.node': ['node', [workspace.testPath]],
    'typescript.node': ['node', [workspace.testPath]]
  };
  const command = commands[runner];
  if (!command) throw new Error(`Unsupported outer acceptance test runner: ${workspace.testRunner}`);
  const result = spawnSync(command[0], command[1], {
    cwd: workspace.path,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000
  });
  return { passed: result.status === 0, status: result.status, tail: String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | ') };
}

function sha256File(filePath) {
  return fs.existsSync(filePath) ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Run the sealed real-repository acceptance harness.');
    console.log('  --keep-patches     leave Lari patches applied for inspection (next run needs a reset)');
    console.log('  --allow-discovery  permit search and mutation families, not retained operators only');
    console.log('  --set <dir>        point at a different acceptance set (e.g. a fresh holdout)');
    console.log('  --model-path <file> load an explicit immutable candidate instead of registry current');
    console.log('  --artifact-dir <dir> persist bridge evidence in a new directory');
    console.log('  --report <file>    persist the final report without overwriting an existing file');
    return;
  }

  const instancesPath = path.join(args.setDir, 'instances.json');
  const workspaceMapPath = path.join(args.setDir, 'workspaces.json');
  for (const required of [instancesPath, workspaceMapPath]) {
    if (!fs.existsSync(required)) throw new Error(`Missing required input: ${required}`);
  }

  const workspaces = JSON.parse(fs.readFileSync(workspaceMapPath, 'utf8'));
  const entries = Object.entries(workspaces);
  const activeModelPath = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
  const registryPath = path.join(ROOT, 'models', 'lari', 'registry.json');
  const modelPath = args.modelPath || activeModelPath;
  if (!fs.existsSync(modelPath)) throw new Error(`Model file does not exist: ${modelPath}`);
  const modelHashBefore = sha256File(modelPath);
  const activeModelHashBefore = sha256File(activeModelPath);
  const registryHashBefore = sha256File(registryPath);

  // 1. Every workspace must exist and be clean.
  const dirty = [];
  for (const [id, workspace] of entries) {
    if (!fs.existsSync(workspace.path)) throw new Error(`Workspace missing for ${id}: ${workspace.path}`);
    const status = git(workspace.path, ['status', '--short']).stdout || '';
    if (status.trim()) dirty.push({ id, status: status.trim().split(/\r?\n/) });
  }
  if (dirty.length) {
    console.error(JSON.stringify({
      benchmark: 'lari-sealed-repository-acceptance',
      passed: false,
      error: 'workspaces-not-clean',
      detail: 'A previous run left patches applied. Reset with: git checkout -- . in each workspace.',
      dirty
    }, null, 2));
    process.exit(1);
  }

  // 2. Baseline must FAIL. Otherwise the measurement is meaningless.
  const baseline = entries.map(([id, workspace]) => ({ id, ...runTest(workspace) }));
  const unexpectedPasses = baseline.filter(item => item.passed);
  if (unexpectedPasses.length) {
    console.error(JSON.stringify({
      benchmark: 'lari-sealed-repository-acceptance',
      passed: false,
      error: 'baseline-already-passing',
      detail: 'These sealed tests pass before Lari runs, so they cannot measure a repair. The seeded '
        + 'regression is missing or was overwritten.',
      unexpectedPasses: unexpectedPasses.map(item => item.id)
    }, null, 2));
    process.exit(1);
  }

  // 3. Generate patches through the canonical bridge, retained operators only.
  //
  // One instance per bridge invocation, deliberately. The bridge aborts the whole run on the first
  // instance that cannot prove a fail-to-pass transition -- it is built to *prove* a set passes, not
  // to *score* a set where failures are expected. Running it over a holdout as a single batch would
  // report the first failure and leave every later instance unattempted, which reads as "0/N, no
  // patch attempted" regardless of what the model could actually repair. Isolating each instance is
  // what makes a partial score meaningful.
  let outDir;
  if (args.artifactDir) {
    if (fs.existsSync(args.artifactDir)) throw new Error(`Refusing to overwrite artifact directory: ${args.artifactDir}`);
    fs.mkdirSync(args.artifactDir, { recursive: true });
    outDir = args.artifactDir;
  } else {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-sealed-'));
  }
  const allInstances = JSON.parse(fs.readFileSync(instancesPath, 'utf8'));
  const instanceList = Array.isArray(allInstances) ? allInstances : (allInstances.instances || []);
  const bridgeRuns = [];

  for (const [id, workspace] of entries) {
    const instance = instanceList.find(item => item.instance_id === id);
    if (!instance) {
      bridgeRuns.push({ id, status: null, error: 'instance definition missing from instances.json' });
      continue;
    }
    const singleInstances = path.join(outDir, `${id}.instances.json`);
    const singleWorkspaces = path.join(outDir, `${id}.workspaces.json`);
    fs.writeFileSync(singleInstances, JSON.stringify([instance], null, 2) + '\n');
    fs.writeFileSync(singleWorkspaces, JSON.stringify({ [id]: workspace }, null, 2) + '\n');

    const run = spawnSync('node', [
      path.join(ROOT, 'scripts', 'lari_swebench_dockerless_bridge.js'),
      '--instances', singleInstances,
      '--workspace-map', singleWorkspaces,
      '--output', path.join(outDir, `${id}.predictions.jsonl`),
      '--provenance', path.join(outDir, `${id}.provenance.jsonl`),
      '--manifest', path.join(outDir, `${id}.manifest.json`),
      ...(args.modelPath ? ['--model-path', modelPath] : []),
      ...(args.allowDiscovery ? [] : ['--reuse-only'])
    ], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 1800000 });

    bridgeRuns.push({
      id,
      status: run.status,
      error: run.status === 0 ? null : String(run.stderr || '').trim().split(/\r?\n/)[0] || null
    });
  }

  const bridge = { status: bridgeRuns.every(item => item.status === 0) ? 0 : 1 };

  // 4. Score against the sealed oracles.
  const after = entries.map(([id, workspace]) => ({ id, ...runTest(workspace) }));
  const passedCount = after.filter(item => item.passed).length;

  const patches = Object.fromEntries(entries.map(([id, workspace]) => {
    const diff = git(workspace.path, ['diff', '--stat']).stdout || '';
    return [id, diff.trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(' | ') || 'no change'];
  }));

  // 5. Restore, so the set stays valid for the next run.
  if (!args.keepPatches) {
    for (const [, workspace] of entries) git(workspace.path, ['checkout', '--', '.']);
  }

  const report = {
    benchmark: 'lari-sealed-repository-acceptance',
    passed: passedCount === entries.length,
    score: `${passedCount}/${entries.length}`,
    passedCount,
    gateCount: entries.length,
    reuseOnly: !args.allowDiscovery,
    set: path.relative(ROOT, args.setDir).replace(/\\/g, '/'),
    modelPath: path.relative(ROOT, modelPath).replace(/\\/g, '/'),
    modelHash: modelHashBefore,
    candidateModelUnchanged: sha256File(modelPath) === modelHashBefore,
    activeModelHash: activeModelHashBefore,
    activeModelUnchanged: sha256File(activeModelPath) === activeModelHashBefore,
    registryUnchanged: sha256File(registryPath) === registryHashBefore,
    bridgeStatus: bridge.status,
    baselineAllFailed: true,
    cases: after.map(item => ({
      id: item.id,
      passed: item.passed,
      patch: patches[item.id],
      bridgeError: bridgeRuns.find(run => run.id === item.id)?.error || null,
      failureTail: item.passed ? null : item.tail
    })),
    patchesRestored: !args.keepPatches,
    externalModelCalls: 0
  };

  if (args.reportPath) {
    fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
    fs.writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error.stack || String(error));
  process.exit(1);
}
