#!/usr/bin/env node
'use strict';

/**
 * Can the search reach the fix at all?
 *
 * A measurement run answers "did the oracle accept a patch", at roughly 80 suite runs per instance.
 * Most of the failures in this repo's history were not the oracle rejecting a good patch -- they were
 * the correct candidate never being generated, or being generated past the end of the budget. That is
 * a question about *search*, and it needs no oracle at all: replay the sealed mutation, build the same
 * regions and the same candidate list the engine would build, and look for the candidate that restores
 * the upstream line.
 *
 * Costs one baseline suite run and one coverage run per instance instead of eighty, so a condition can
 * be checked in minutes rather than hours. It answers reachability only: a reached candidate still has
 * to pass the full upstream suite in a real run, and an unreachable one cannot pass anything.
 *
 * Two conditions are reported per instance, since the interesting failure is asymmetric -- learned
 * priors can rescue a candidate that authored order buried, and can equally starve a family that has
 * no prior record yet.
 *
 * Usage:
 *   node scripts/probe_lari_search_reachability.js --manifest <manifest.json> [--model <copy.json>]
 *     [--limit 80] [--cache <dir>]
 *   node scripts/probe_lari_search_reachability.js --manifest <a> --manifest <b> --model <copy.json>
 *     --sweep 0,0.25,0.5,1 --cache <dir>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const mutationRepair = require(path.join(ROOT, 'swarm_mutation_repair.js'));

function parseArgs(argv) {
  const args = { manifestPaths: [], modelPath: null, limit: 80, cacheDir: null, sweep: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') args.manifestPaths.push(path.resolve(argv[++i]));
    else if (argv[i] === '--model') args.modelPath = path.resolve(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--cache') args.cacheDir = path.resolve(argv[++i]);
    // Sweep the prior/authored budget split across every manifest given, and report reachability per
    // share. Every set passed here is a burned dev set by definition -- a share picked on a sealed set
    // would be tuning against the number it is supposed to report.
    else if (argv[i] === '--sweep') args.sweep = String(argv[++i]).split(',').map(Number);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.manifestPaths.length) throw new Error('--manifest is required');
  return args;
}

function git(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function clearPycache(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (entry.name === '__pycache__') fs.rmSync(child, { recursive: true, force: true });
      else if (entry.name !== '.git') stack.push(child);
    }
  }
}

function runSuite(repo, command) {
  clearPycache(repo);
  const result = spawnSync(command, { cwd: repo, shell: true, encoding: 'utf8', timeout: 90000 });
  return { passed: result.status === 0, text: String(result.stdout || '') + String(result.stderr || '') };
}

/** Seed the sealed mutation and return both the defective source and the line it must be restored to. */
function seedInstance(repo, instance) {
  const targetPath = path.join(repo, instance.targetFile);
  const pristine = fs.readFileSync(targetPath, 'utf8');
  const lines = pristine.split(/\r?\n/);
  const upstreamLine = lines[instance.line - 1];
  if (instance.seed.deletion) {
    lines[instance.line - 1] = instance.seed.replace;
  } else {
    if (!upstreamLine || !upstreamLine.includes(instance.seed.find)) return null;
    lines[instance.line - 1] = upstreamLine.replace(instance.seed.find, instance.seed.replace);
  }
  return { targetPath, upstreamLine, seeded: lines.join('\n') };
}

/**
 * Oracle facts -- which tests fail and which lines they execute -- are the only expensive part, and
 * they do not depend on the vocabulary, so they are gathered once and cached across conditions.
 */
function oracleFacts(manifest, cachePath) {
  if (cachePath && fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const repo = manifest.repo.path;
  const command = manifest.oracle.command;
  const cache = {};
  for (const instance of manifest.instances) {
    git(repo, ['checkout', '--', '.']);
    git(repo, ['clean', '-qfd']);
    const seeded = seedInstance(repo, instance);
    if (!seeded) { cache[instance.instance_id] = { error: 'seed anchor missing at sealed line' }; continue; }
    fs.writeFileSync(seeded.targetPath, seeded.seeded);

    const baseline = runSuite(repo, command);
    const failing = mutationRepair.failingTestReferences(baseline.text);

    // Same selector cascade as the measurement script: exact pytest ids, then parameter-stripped ids,
    // then whole failing files. Parameterised ids with ANSI escapes do not survive the shell.
    let coveredLines = [];
    let coverageSelector = 'none';
    try {
      const include = instance.targetFile.split(path.sep).join('/');
      const exactIds = [...baseline.text.matchAll(/^FAILED\s+(\S+)/gm)].map(m => m[1]).slice(0, 8);
      const baseIds = mutationRepair.failingTestTargets(baseline.text, 8);
      const attempts = [
        { selector: 'exact-node-ids', args: exactIds },
        { selector: 'parameter-stripped-ids', args: baseIds },
        { selector: 'failing-test-files', args: failing.files }
      ].filter(attempt => attempt.args.length);
      for (const attempt of attempts) {
        const run = spawnSync(
          `python -m coverage run --include="${include}" -m pytest -q -o addopts= ${attempt.args.map(a => JSON.stringify(a)).join(' ')}`,
          { cwd: repo, shell: true, encoding: 'utf8', timeout: 300000 });
        if (run.status === 4 || /no tests ran/i.test(String(run.stdout || ''))) continue;
        const json = spawnSync(`python -m coverage json -o - --include="${include}"`,
          { cwd: repo, shell: true, encoding: 'utf8', timeout: 300000 });
        const data = JSON.parse(json.stdout);
        const key = Object.keys(data.files || {})[0];
        const executed = key ? (data.files[key].executed_lines || []) : [];
        if (executed.length) { coveredLines = executed; coverageSelector = attempt.selector; break; }
      }
    } catch (_) { coveredLines = []; }

    cache[instance.instance_id] = {
      seededSuiteGreen: baseline.passed,
      failureText: baseline.text,
      failingNames: failing.names,
      failingFiles: failing.files,
      failingSource: failing.files.map(file => {
        try { return fs.readFileSync(path.join(repo, file), 'utf8'); } catch (_) { return ''; }
      }).join('\n'),
      coveredLines,
      coverageSelector
    };
    git(repo, ['checkout', '--', '.']);
    process.stderr.write(`  cached ${instance.instance_id} (${coveredLines.length} covered lines)\n`);
  }
  if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(cache));
  return cache;
}

function reachability({ manifest, facts, vocabulary, familyPriors, limit, priorBudgetShare, regionMajorPriors }) {
  const repo = manifest.repo.path;
  const rows = [];
  for (const instance of manifest.instances) {
    const fact = facts[instance.instance_id];
    if (!fact || fact.error) { rows.push({ instance: instance.instance_id, error: fact?.error || 'no facts' }); continue; }
    const seeded = seedInstance(repo, instance);
    if (!seeded) { rows.push({ instance: instance.instance_id, error: 'seed anchor missing' }); continue; }

    let tried = 0;
    const outcome = mutationRepair.repairByVerifiedMutation({
      source: seeded.seeded,
      language: 'python',
      testSource: fact.failingSource,
      testNames: fact.failingNames,
      coveredLines: fact.coveredLines,
      failureText: fact.failureText,
      targetRelative: instance.targetFile,
      limit,
      vocabulary,
      familyPriors,
      ...(priorBudgetShare === undefined ? {} : { priorBudgetShare }),
      ...(regionMajorPriors === undefined ? {} : { regionMajorPriors }),
      // Stand-in oracle: accept exactly the upstream line. Reachability, not correctness.
      verify(patched) {
        tried += 1;
        return { passed: patched.split('\n')[instance.line - 1] === seeded.upstreamLine };
      }
    });

    rows.push({
      instance: instance.instance_id,
      operator: instance.operator,
      reached: Boolean(outcome.repaired),
      position: outcome.repaired ? outcome.candidatesTried : null,
      family: outcome.family,
      verificationsSpent: tried,
      pooledCount: outcome.pooledCount,
      targetLineCovered: fact.coveredLines.includes(instance.line)
    });
  }
  return rows;
}

function loadSet(manifestPath, cacheDir) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const cachePath = cacheDir
    ? path.join(cacheDir, `${manifest.id || path.basename(path.dirname(manifestPath))}.oracle-facts.json`)
    : null;
  process.stderr.write(`gathering oracle facts for ${manifest.id}\n`);
  return { manifest, manifestPath, facts: oracleFacts(manifest, cachePath) };
}

function sweep(args) {
  const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
  const model = JSON.parse(fs.readFileSync(args.modelPath, 'utf8'));
  const vocabulary = runtime.lariMutationVocabulary(model) || mutationRepair.DEFAULT_VOCABULARY;
  const familyPriors = runtime.lariMutationFamilyPriors(model);
  const sets = args.manifestPaths.map(manifestPath => loadSet(manifestPath, args.cacheDir));

  // Sets restricted to the one operator class the learned rules cover are tallied separately. Folding
  // them into a single total would let the set built to be passed argue for whatever setting suits it,
  // which is exactly the flattering-number failure this project keeps having to unlearn.
  const isRestricted = set => Array.isArray(set.manifest.selection?.restrictedToOperators);
  const tally = (label, options) => {
    const counts = { unrestricted: [0, 0], restricted: [0, 0] };
    for (const set of sets) {
      const rows = reachability({ ...set, limit: args.limit, ...options });
      const bucket = isRestricted(set) ? counts.restricted : counts.unrestricted;
      bucket[0] += rows.filter(row => row.reached).length;
      bucket[1] += rows.length;
    }
    console.log(`${label.padEnd(19)}${String(`${counts.unrestricted[0]}/${counts.unrestricted[1]}`).padEnd(13)}`
      + `${counts.restricted[0]}/${counts.restricted[1]}`);
    return counts;
  };

  // The reference line: what the seed vocabulary reaches with no priors at all, which is the
  // condition every previously recorded score was measured under.
  console.log('\ncondition          all-operators AOR-only');
  tally('seed, no priors', { vocabulary: mutationRepair.DEFAULT_VOCABULARY, familyPriors: null });
  tally('trained, no priors', { vocabulary, familyPriors: null });

  console.log('');
  for (const regionMajor of [false, true]) {
    for (const share of args.sweep) {
      tally(`${regionMajor ? 'region-major' : 'pool-wide'} ${share}`,
        { vocabulary, familyPriors, priorBudgetShare: share, regionMajorPriors: regionMajor });
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.sweep) {
    if (!args.modelPath) throw new Error('--sweep requires --model');
    return sweep(args);
  }
  const { manifest, facts } = loadSet(args.manifestPaths[0], args.cacheDir);

  const conditions = [{
    name: 'seed vocabulary, no priors',
    vocabulary: mutationRepair.DEFAULT_VOCABULARY,
    familyPriors: null
  }];
  if (args.modelPath) {
    const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
    const model = JSON.parse(fs.readFileSync(args.modelPath, 'utf8'));
    const vocabulary = runtime.lariMutationVocabulary(model) || mutationRepair.DEFAULT_VOCABULARY;
    const familyPriors = runtime.lariMutationFamilyPriors(model);
    conditions.push({ name: `${path.basename(args.modelPath)} vocabulary, no priors`, vocabulary, familyPriors: null });
    conditions.push({ name: `${path.basename(args.modelPath)} vocabulary + priors`, vocabulary, familyPriors });
  }

  const report = { manifest: manifest.id, limit: args.limit, conditions: [] };
  for (const condition of conditions) {
    const rows = reachability({ manifest, facts, vocabulary: condition.vocabulary, familyPriors: condition.familyPriors, limit: args.limit });
    const reached = rows.filter(row => row.reached).length;
    report.conditions.push({ condition: condition.name, reached, of: rows.length, rows });
    console.log(`\n${condition.name}: ${reached}/${rows.length} reachable within ${args.limit} verifications`);
    for (const row of rows) {
      console.log('  ' + String(row.instance).padEnd(42)
        + String(row.operator || '').padEnd(5)
        + (row.reached ? `reached at ${row.position} (${row.family})` : `unreachable (pool ${row.pooledCount})`));
    }
  }
  const out = path.join(path.dirname(args.manifestPaths[0]), 'search-reachability.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${out}`);
}

main();
