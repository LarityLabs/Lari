#!/usr/bin/env node
'use strict';

/**
 * Demonstrate learn -> persist -> reload -> reuse for verified mutation repair.
 *
 * The claim under test is the paper's central loop, restricted to something measurable: that a
 * verified repair leaves durable state which makes a later repair *better*, and that the improvement
 * survives being written to disk and read back in a fresh process.
 *
 * Design notes
 * ------------
 * The instance used is the comparison-boundary case, chosen because its winning family sorts late in
 * the authored candidate order. A run with no priors has to walk past several other families first,
 * so if learned priors do anything at all, the second run must reach the fix in fewer verifications.
 * Picking a case whose fix is already first would make the measurement unfalsifiable.
 *
 * Nothing here touches the active model. Phase 1 writes to a copy passed in with --model.
 *
 * Usage (two processes, so the reload is real rather than an in-memory reuse):
 *   node scripts/demonstrate_lari_mutation_learn_reuse.js --phase learn --model <copy.json>
 *   node scripts/demonstrate_lari_mutation_learn_reuse.js --phase reuse --model <copy.json>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const mutationRepair = require(path.join(ROOT, 'swarm_mutation_repair.js'));
const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));

const DEFAULT_SET = path.join(ROOT, 'consolidation', 'repo-holdout-repo-acceptance-20260725');
const INSTANCE = 'cachetools-maxsize-boundary';

function parseArgs(argv) {
  const args = { phase: null, modelPath: null, setDir: DEFAULT_SET, instance: INSTANCE };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--phase') args.phase = argv[++index];
    else if (token === '--model') args.modelPath = path.resolve(argv[++index]);
    else if (token === '--set') args.setDir = path.resolve(argv[++index]);
    else if (token === '--instance') args.instance = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.phase || !['learn', 'reuse'].includes(args.phase)) throw new Error('--phase must be learn or reuse');
  if (!args.modelPath) throw new Error('--model <path to a model copy> is required');
  return args;
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaces = JSON.parse(fs.readFileSync(path.join(args.setDir, 'workspaces.json'), 'utf8'));
  const workspace = workspaces[args.instance];
  if (!workspace) throw new Error(`Instance not in set: ${args.instance}`);

  const model = JSON.parse(fs.readFileSync(args.modelPath, 'utf8'));

  // Always start from the sealed seeded baseline so both phases face the identical bug.
  git(workspace.path, ['checkout', '--', '.']);
  git(workspace.path, ['clean', '-qfd']);
  clearPycache(workspace.path);

  const targetPath = path.join(workspace.path, workspace.expressionTarget);
  const seeded = fs.readFileSync(targetPath, 'utf8');
  const testSource = fs.readFileSync(path.join(workspace.path, workspace.testPath), 'utf8');
  const baseline = runOracle(workspace);
  if (baseline.passed) throw new Error('baseline already passes; the seed is ineffective');

  const priorsBefore = runtime.lariMutationFamilyPriors(model);

  let verifications = 0;
  const outcome = mutationRepair.repairByVerifiedMutation({
    source: seeded,
    language: /\.py$/i.test(workspace.expressionTarget) ? 'python' : 'javascript',
    testSource,
    failureText: baseline.text,
    targetRelative: workspace.expressionTarget,
    limit: 240,
    familyPriors: priorsBefore,
    verify(patched) {
      verifications += 1;
      fs.writeFileSync(targetPath, patched);
      const result = runOracle(workspace);
      if (!result.passed) fs.writeFileSync(targetPath, seeded);
      return result;
    }
  });

  let retained = null;
  if (outcome.repaired) {
    retained = runtime.retainLariMutationRepairOperator(model, {
      family: outcome.family,
      language: /\.py$/i.test(workspace.expressionTarget) ? 'python' : 'javascript',
      attempted: outcome.attempted,
      winningDescription: outcome.description || null,
      modelHash: null,
      sourcePath: `holdout:${args.instance}`
    });
    const session = runtime.ensureLariSessionRuntime(model);
    session.operators = session.operators || [];
    session.operators.push({
      id: `lariMutationOperator.${outcome.family}.${Date.now()}`,
      verified: true,
      patchKind: `verified_mutation_${String(outcome.family).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
      capability: 'workspace_coding',
      task: 'verified mutation repair',
      target: workspace.expressionTarget,
      targetFiles: [workspace.expressionTarget],
      modifiedFiles: 1,
      learnedRecordId: retained?.id || null,
      check: { output: 'executable tests passed', error: '' }
    });
    runtime.compileLariSessionOperatorSkills(model, {});
    fs.writeFileSync(args.modelPath, JSON.stringify(model, null, 2) + '\n');
  }

  // Restore: this is a measurement, never a promotion.
  git(workspace.path, ['checkout', '--', '.']);
  git(workspace.path, ['clean', '-qfd']);
  clearPycache(workspace.path);

  const skill = (model.lariSessionRuntime?.operatorSkills || [])
    .find(item => item.patchKind === `verified_mutation_${String(outcome.family || '').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`);
  const resolved = skill ? runtime.findLariCanonicalLearnedRecord(model, skill.id) : null;

  console.log(JSON.stringify({
    phase: args.phase,
    instance: args.instance,
    modelCopy: path.relative(ROOT, args.modelPath).replace(/\\/g, '/'),
    priorsBeforeRun: priorsBefore,
    repaired: outcome.repaired,
    family: outcome.family,
    description: outcome.description,
    verificationsUsedToFindFix: verifications,
    candidateCount: outcome.candidateCount,
    retainedRecordId: retained?.id || null,
    verifiedUses: retained?.payload?.verifiedUses ?? null,
    attempts: retained?.payload?.attempts ?? null,
    routableOperatorSkill: skill?.id || null,
    provenanceResolvesToRecord: Boolean(resolved && retained && resolved.id === retained.id),
    priorsAfterRun: runtime.lariMutationFamilyPriors(model),
    workspaceRestored: !(git(workspace.path, ['status', '--short']).stdout || '').trim()
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(String(error.message || error));
  process.exit(1);
}
