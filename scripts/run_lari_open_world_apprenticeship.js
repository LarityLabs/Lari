#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'open-world-apprenticeship-20260901');
const SEAL = path.join(OUT, 'apprenticeship-seal.json');
const PUBLIC = path.join(OUT, 'public-tasks.json');
const BASELINE = path.join(OUT, 'baseline-viability-report.json');
const WORKSPACE_MAP = path.join(OUT, 'workspace-map.json');
const attemptArgIndex = process.argv.indexOf('--attempt');
const ATTEMPT = attemptArgIndex >= 0 ? String(process.argv[attemptArgIndex + 1] || '') : 'attempt1';
if (!/^[a-z0-9-]+$/.test(ATTEMPT)) throw new Error('Invalid --attempt value.');
const onlyArgIndex = process.argv.indexOf('--only');
const ONLY_INSTANCE = onlyArgIndex >= 0 ? String(process.argv[onlyArgIndex + 1] || '') : null;
if (ONLY_INSTANCE && !/^[A-Za-z0-9_.-]+$/.test(ONLY_INSTANCE)) throw new Error('Invalid --only value.');
const candidateLimitArgIndex = process.argv.indexOf('--candidate-limit');
const CANDIDATE_LIMIT = candidateLimitArgIndex >= 0 ? Number(process.argv[candidateLimitArgIndex + 1]) : 8;
if (!Number.isInteger(CANDIDATE_LIMIT) || CANDIDATE_LIMIT < 1 || CANDIDATE_LIMIT > 256) throw new Error('Invalid --candidate-limit value.');
const taskTimeoutArgIndex = process.argv.indexOf('--task-timeout-ms');
const TASK_TIMEOUT_MS = taskTimeoutArgIndex >= 0 ? Number(process.argv[taskTimeoutArgIndex + 1]) : 180000;
if (!Number.isInteger(TASK_TIMEOUT_MS) || TASK_TIMEOUT_MS < 1000 || TASK_TIMEOUT_MS > 3600000) throw new Error('Invalid --task-timeout-ms value.');
const REPORT = path.join(OUT, ATTEMPT === 'attempt1' ? 'learning-attempt-report.json' : `learning-${ATTEMPT}-report.json`);
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const RUNS = path.join(OUT, ATTEMPT === 'attempt1' ? 'learning-workspaces' : `learning-workspaces-${ATTEMPT}`);

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function execute(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    timeout: options.timeout || 300000,
    windowsHide: true,
    env: process.env
  });
}

function requireOk(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${String(result.stderr || result.stdout || result.error?.message || '').slice(-4000)}`);
  }
}

function git(cwd, args, options = {}) {
  return execute('git', ['--no-optional-locks', ...args], { cwd, timeout: options.timeout || 300000 });
}

function runDeclaredTest(root, runner) {
  const parts = String(runner).split(/\s+/).filter(Boolean);
  const result = execute(parts[0], parts.slice(1), { cwd: root, timeout: 300000 });
  return {
    passed: result.status === 0,
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    output: `${result.stdout || ''}${result.stderr || ''}`.slice(-12000)
  };
}

function summarizeResponse(response) {
  const trace = Array.isArray(response?.trace) ? response.trace : [];
  const selected = trace.find(item => item.phase === 'selected_capability_execution') || null;
  const failure = trace.find(item => item.phase === 'default_failure_learning') || null;
  const workspace = response?.executionBinding?.workspaceExecution
    || failure?.workspaceExecution
    || failure?.frontierFallback?.workspaceExecution
    || null;
  const repair = selected?.expressionRepair
    || failure?.frontierFallback?.expressionRepair
    || workspace?.expressionRepair
    || null;
  const diagnostics = response?.transientDiagnostics
    || workspace?.diagnostic
    || failure?.frontierFallback?.diagnostic
    || null;
  return {
    passed: response?.passed === true,
    action: response?.action || null,
    answer: String(response?.answer || '').slice(0, 4000),
    modelHash: response?.modelHash || null,
    capabilitySelection: response?.capabilitySelection || null,
    learnedRecordIds: [...new Set((response?.learnedRecordIds || []).map(String))],
    executionBinding: response?.executionBinding || null,
    repair,
    diagnosticHypotheses: diagnostics?.hypotheses || [],
    relaxation: diagnostics?.relaxation || workspace?.relaxation || null,
    trace: trace.map(item => ({
      phase: item.phase || null,
      action: item.action || null,
      learnedRecordId: item.learnedRecordId || null,
      appliedOperatorRecordId: item.appliedOperatorRecordId || null,
      selectedCapabilityId: item.selectedCapabilityId || null,
      workspaceExecution: item.workspaceExecution ? {
        passed: item.workspaceExecution.passed === true,
        recordId: item.workspaceExecution.recordId || null,
        hypotheses: item.workspaceExecution.diagnostic?.hypotheses || []
      } : null
    })),
    externalModelCalls: Number(response?.external_model_calls || 0)
  };
}

function main() {
  assert(!fs.existsSync(REPORT), 'Immutable apprenticeship learning report already exists.');
  [SEAL, PUBLIC, BASELINE, WORKSPACE_MAP, ACTIVE, REGISTRY].forEach(file => assert(fs.existsSync(file), `Missing ${rel(file)}`));
  const seal = read(SEAL);
  const publicTasks = read(PUBLIC).tasks;
  const baseline = read(BASELINE);
  const workspaceMap = read(WORKSPACE_MAP);
  const activeBefore = shaFile(ACTIVE);
  const registryBefore = shaFile(REGISTRY);
  assert(activeBefore === seal.parent.sha256, 'Production model no longer matches sealed parent.');
  assert(baseline.integrity?.readOnly === true, 'Baseline preparation did not preserve production state.');
  const loaded = registry.loadLariModel();
  assert(loaded.resolved?.source === 'registry', `Refusing model source ${loaded.resolved?.source}`);
  assert(shaFile(loaded.resolved.path) === activeBefore, 'Registry load did not resolve the sealed active bytes.');
  const workingModel = clone(loaded.model);
  const originalIds = new Set((workingModel.lariLearnedRecords?.records || []).map(record => record.id));
  const eligible = baseline.rows.filter(row => row.baseline?.classification === 'behavioral_failure'
    && (!ONLY_INSTANCE || row.instanceId === ONLY_INSTANCE));
  assert(eligible.length > 0, 'No eligible behavioral failures matched this run.');
  fs.mkdirSync(RUNS, { recursive: true });
  const rows = [];

  for (const baselineRow of eligible) {
    const task = publicTasks.find(item => item.instanceId === baselineRow.instanceId);
    const mapping = workspaceMap[baselineRow.instanceId];
    const sourceWorkspace = path.resolve(mapping.path);
    const workspace = path.join(RUNS, baselineRow.instanceId);
    const row = { instanceId: baselineRow.instanceId, repo: task.repo, workspace: rel(workspace) };
    try {
      assert(!fs.existsSync(workspace), `Learning workspace already exists: ${rel(workspace)}`);
      requireOk(git(ROOT, ['clone', '--shared', sourceWorkspace, workspace], { timeout: 600000 }), `clone ${baselineRow.instanceId}`);
      const head = String(git(workspace, ['rev-parse', 'HEAD']).stdout || '').trim();
      const baselineTest = runDeclaredTest(workspace, mapping.testRunner);
      assert(!baselineTest.passed && baselineTest.exitCode === 1, `${baselineRow.instanceId} no longer has an eligible behavioral baseline.`);
      const testSelectors = String(mapping.testRunner).split(/\s+/).slice(3).filter(value => value && !value.startsWith('-'));
      assert(testSelectors.length > 0, `${baselineRow.instanceId} has no focused pytest selectors.`);
      const focusedTests = [...testSelectors.reduce((groups, selector) => {
        const testFile = selector.split('::', 1)[0].replace(/\\/g, '/');
        if (!groups.has(testFile)) groups.set(testFile, []);
        groups.get(testFile).push(selector);
        return groups;
      }, new Map()).entries()].map(([testFile, selectors]) => ({ path: testFile, runner: 'python.pytest', selectors }));
      const recordsBefore = new Set((workingModel.lariLearnedRecords?.records || []).map(record => record.id));
      const response = runtime.sendMessageToLari(workingModel, {
        id: `open-world.${baselineRow.instanceId}`,
        mode: 'code',
        subintent: 'code.fix',
        prompt: task.problemStatement,
        workspaceRoot: workspace,
        testPath: mapping.testPath,
        testRunner: 'python.pytest',
        testSelectors,
        tests: focusedTests,
        preserveLayout: true
      }, {
        modelHash: activeBefore,
        autoGrow: false,
        groundedFactual: false,
        kernel: {
          useBenchmarkSystem: false,
          useCapabilityGraph: true,
          includeTransientDiagnostics: true,
          capabilityGraph: { minScore: 0 },
          chat: { minMemoryScore: 0, minRouteScore: 0 },
          failureLearning: {
            modelHash: activeBefore,
            sourcePath: `open-world:${baselineRow.instanceId}`,
            benchmarkAssociation: [baselineRow.instanceId],
            researchAllowed: true,
            allowExpressionOperatorDiscovery: false,
            allowSemanticOperatorDiscovery: false,
            allowPrimitiveDiscovery: true,
            coordinatedProgramSearch: true,
            expressionSearch: false,
            expressionCandidateLimit: CANDIDATE_LIMIT,
            taskTimeoutMs: TASK_TIMEOUT_MS,
            mutationCandidateLimit: CANDIDATE_LIMIT
          },
          executionContract: {
            modelHash: activeBefore,
            sourcePath: `open-world:${baselineRow.instanceId}`,
            benchmarkAssociation: [baselineRow.instanceId],
            workspaceExecution: {
              allowExpressionOperatorDiscovery: false,
              allowSemanticOperatorDiscovery: false,
              allowPrimitiveDiscovery: true,
              coordinatedProgramSearch: true,
              expressionSearch: false,
              expressionCandidateLimit: CANDIDATE_LIMIT,
              taskTimeoutMs: TASK_TIMEOUT_MS,
              mutationCandidateLimit: CANDIDATE_LIMIT
            }
          }
        }
      });
      const summary = summarizeResponse(response);
      const failureEvent = clone(workingModel.lariDefaultFailureLearning?.events?.[0] || null);
      const afterTest = runDeclaredTest(workspace, mapping.testRunner);
      const diff = String(git(workspace, ['diff', '--binary', '--no-ext-diff', head, '--', '.']).stdout || '');
      const createdRecordIds = (workingModel.lariLearnedRecords?.records || [])
        .map(record => record.id)
        .filter(id => !recordsBefore.has(id));
      row.baseline = baselineTest;
      row.response = summary;
      row.failureEvent = failureEvent;
      row.after = afterTest;
      row.patch = { sha256: sha(Buffer.from(diff)), bytes: Buffer.byteLength(diff), empty: !diff.trim() };
      row.createdRecordIds = createdRecordIds;
      row.failToPass = !baselineTest.passed && summary.passed && afterTest.passed;
      row.diagnosticBeforeEdit = summary.diagnosticHypotheses.some(item => item?.kind === 'DiagnosticHypothesis');
      row.externalModelCalls = summary.externalModelCalls;
    } catch (error) {
      row.runnerError = error.message;
      row.failToPass = false;
    }
    rows.push(row);
  }

  const addedRecords = (workingModel.lariLearnedRecords?.records || []).filter(record => !originalIds.has(record.id));
  const verifiedIds = new Set(rows.filter(row => row.failToPass).flatMap(row => row.createdRecordIds || []));
  const retainedVerifiedRecords = addedRecords.filter(record => verifiedIds.has(record.id));
  let provisionalCandidate = null;
  if (retainedVerifiedRecords.length) {
    const candidate = clone(loaded.model);
    candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
    const byId = new Map(candidate.lariLearnedRecords.records.map(record => [record.id, record]));
    retainedVerifiedRecords.forEach(record => byId.set(record.id, clone(record)));
    candidate.lariLearnedRecords.records = [...byId.values()];
    candidate.lineage = {
      ...(candidate.lineage || {}),
      parentHash: activeBefore,
      developmentalEvent: 'open_world_apprenticeship_provisional',
      createdAt: new Date().toISOString(),
      promoted: false
    };
    const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
    const candidateHash = sha(bytes);
    const candidatePath = path.join(OUT, 'provisional-candidates', `${candidateHash}.json`);
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
    provisionalCandidate = { path: rel(candidatePath), sha256: candidateHash, promoted: false, learnedRecordIds: [...verifiedIds] };
  }

  const activeAfter = shaFile(ACTIVE);
  const registryAfter = shaFile(REGISTRY);
  const passedCount = rows.filter(row => row.failToPass).length;
  const report = {
    schemaVersion: 1,
    kind: 'lari.open-world-apprenticeship.learning-attempt',
    attempt: ATTEMPT,
    createdAt: new Date().toISOString(),
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    parentHash: activeBefore,
    candidateLimit: CANDIDATE_LIMIT,
    taskTimeoutMs: TASK_TIMEOUT_MS,
    sealSha256: shaFile(SEAL),
    eligibleTasks: eligible.length,
    passedTasks: passedCount,
    rows,
    provisionalCandidate,
    gates: {
      twoEligibleBehavioralFailures: eligible.length === 2,
      eligibleBehavioralFailuresSelected: eligible.length >= 1,
      diagnosticHypothesisEveryAttempt: rows.every(row => row.diagnosticBeforeEdit === true),
      exactFailToPassAtLeastOne: passedCount >= 1,
      noGoldSourcePatchReadByRunner: true,
      activeReadOnly: activeBefore === activeAfter,
      registryReadOnly: registryBefore === registryAfter,
      externalModelCallsZero: rows.every(row => Number(row.externalModelCalls || 0) === 0)
    },
    targetProgress: {
      independentTaskPasses: `${passedCount}/6`,
      newReusableCapabilities: `${retainedVerifiedRecords.length}/3`,
      fourLanguageGoal: '1/4 corpus lanes sealed; Python only',
      qualificationReached: false
    },
    passed: false,
    verdict: passedCount
      ? 'Developmental progress only; sealed transfer and qualification remain'
      : 'Production Lari did not solve either eligible open-world task; capability expansion required',
    externalModelCalls: 0,
    limitations: [
      'This is a developmental open-world attempt, not an official SWE-bench score.',
      'No learned record is qualified without fresh sealed transfer, reload, and exact ablation.',
      'The source dataset contains gold patches, but this runner reads only the public task file, baseline report, and workspace map.'
    ]
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, eligibleTasks: eligible.length, passedTasks: passedCount, provisionalCandidate, gates: report.gates, targetProgress: report.targetProgress }, null, 2)}\n`);
}

main();
