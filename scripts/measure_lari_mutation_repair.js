'use strict';
// Validation of swarm_mutation_repair.js against the 20260725 dev-set holdout.
//
// Restores through git rather than an in-memory copy of the file, and asserts the checkout is clean
// both before and after each instance. An earlier version of this harness trusted a string it had
// read at start-up, which silently preserved corruption left by a previous run and produced an
// untrustworthy result.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = 'C:/Users/goryg/.gemini/antigravity/scratch/html-agent-swarm';
const { repairByVerifiedMutation } = require(path.join(ROOT, 'swarm_mutation_repair.js'));
const SET = path.join(ROOT, 'consolidation', 'repo-holdout-repo-acceptance-20260725');
const workspaces = JSON.parse(fs.readFileSync(path.join(SET, 'workspaces.json'), 'utf8'));

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function isClean(cwd) {
  return !(git(cwd, ['status', '--short']).stdout || '').trim();
}

function restore(cwd) {
  git(cwd, ['checkout', '--', '.']);
  git(cwd, ['clean', '-qfd']);
}

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

function runOracle(workspace) {
  clearPycache(workspace.path);
  const result = spawnSync('python', [workspace.testPath], {
    cwd: workspace.path, encoding: 'utf8', windowsHide: true, timeout: 120000
  });
  return { passed: result.status === 0, text: String(result.stderr || result.stdout || '') };
}

const summary = [];
for (const [id, workspace] of Object.entries(workspaces)) {
  // The seeded commit is the baseline. Anything else in the tree is contamination from a prior run.
  restore(workspace.path);
  clearPycache(workspace.path);
  if (!isClean(workspace.path)) { summary.push({ id, error: 'could not reach a clean seeded baseline' }); continue; }

  const targetPath = path.join(workspace.path, workspace.expressionTarget);
  const seeded = fs.readFileSync(targetPath, 'utf8');
  const testSource = fs.readFileSync(path.join(workspace.path, workspace.testPath), 'utf8');

  const baseline = runOracle(workspace);
  if (baseline.passed) { summary.push({ id, error: 'baseline already passes; seed ineffective' }); restore(workspace.path); continue; }

  let verifications = 0;
  const started = Date.now();
  const result = repairByVerifiedMutation({
    source: seeded,
    language: /\.py$/i.test(workspace.expressionTarget) ? 'python' : 'javascript',
    testSource,
    failureText: baseline.text,
    targetRelative: workspace.expressionTarget,
    limit: 240,
    verify(patched) {
      verifications += 1;
      fs.writeFileSync(targetPath, patched);
      return runOracle(workspace);
    }
  });

  const verifiedPatch = result.repaired ? fs.readFileSync(targetPath, 'utf8') : null;

  // This is a measurement, not a promotion. Always return to the sealed baseline.
  restore(workspace.path);
  clearPycache(workspace.path);
  const cleanAfter = isClean(workspace.path);

  summary.push({
    id,
    repaired: result.repaired,
    family: result.family,
    description: result.description,
    line: result.line,
    candidatesTried: result.candidatesTried,
    candidateCount: result.candidateCount,
    verifications,
    seconds: Math.round((Date.now() - started) / 1000),
    cleanAfter,
    patchLine: verifiedPatch ? (verifiedPatch.split(/\r?\n/)[result.line - 1] || '').trim() : null,
    regions: result.repaired ? undefined : result.regions
  });
  console.log(JSON.stringify(summary.at(-1), null, 2));
}

const repaired = summary.filter(item => item.repaired).length;
console.log('\n==== DEV-SET RESULT: ' + repaired + '/' + summary.length + ' ====');
console.log('all checkouts clean afterwards: ' + summary.every(item => item.cleanAfter !== false));
