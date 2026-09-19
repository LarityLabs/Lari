#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const SET = path.join(ROOT, 'consolidation', 'coding-frontier-curriculum-v2-20260828');
const PAYLOAD = path.join(SET, 'sealed-holdouts.json');
const MANIFEST = path.join(SET, 'seal-manifest.json');
const TRAINING = path.join(ROOT, 'consolidation', 'coding-frontier-training-20260828', 'training-evidence.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const ACTIVE_MODE = process.argv.includes('--active');
const REPORT = process.env.LARI_CODING_FRONTIER_TRANSFER_REPORT
  ? path.resolve(process.env.LARI_CODING_FRONTIER_TRANSFER_REPORT)
  : path.join(SET, ACTIVE_MODE ? 'production-transfer-report.json' : 'transfer-report-v2.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));

function writeWorkspace(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function clearCaches(root, preserveIsolated = false) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = path.join(root, entry.name);
    if (entry.name === '__pycache__' || (entry.name === '.lari-test-tmp' && !preserveIsolated)) fs.rmSync(child, { recursive: true, force: true });
    else clearCaches(child, preserveIsolated);
  }
}

function runPython(workspace, testPath, preserveIsolated = false) {
  clearCaches(workspace, preserveIsolated);
  const result = cp.spawnSync('python', [testPath], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: workspace } });
  return { passed: result.status === 0, status: result.status, tail: String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-6) };
}

function responseView(response) {
  const failure = response.trace?.find(item => item.phase === 'default_failure_learning') || null;
  const selected = response.trace?.find(item => item.phase === 'selected_capability_execution') || null;
  const repair = selected?.expressionRepair || failure?.frontierFallback?.expressionRepair || response.executionBinding?.workspaceExecution?.expressionRepair || null;
  return {
    passed: response.passed === true,
    action: response.action || null,
    modelHash: response.modelHash || null,
    selectedLearnedRecordId: response.executionBinding?.selectedLearnedRecordId || selected?.learnedRecordId || null,
    appliedOperatorRecordId: response.executionBinding?.appliedOperatorRecordId || repair?.learnedRecordId || failure?.retainedPatternId || null,
    repair,
    discoveryUsed: /^searched_/.test(repair?.mode || ''),
    externalModelCalls: response.external_model_calls || 0
  };
}

function requestOptions(modelHash, lane) {
  const shared = { modelHash, sourcePath: `sealed-frontier:${lane}`, benchmarkAssociation: [], allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, coordinatedProgramSearch: true };
  return {
    modelHash,
    autoGrow: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: shared,
      executionContract: { ...shared, workspaceExecution: { maxIterations: 0, allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, coordinatedProgramSearch: true } }
    }
  };
}

function execute(spec, model, modelHash, workspace, idPrefix) {
  const before = runPython(workspace, spec.testPath);
  const oracleHash = fileHash(path.join(workspace, spec.testPath));
  const response = runtime.sendMessageToLari(model, {
    id: `${idPrefix}.${spec.id}`,
    mode: 'code',
    subintent: 'code.fix',
    prompt: spec.request,
    workspaceRoot: workspace,
    testPath: spec.testPath,
    testRunner: spec.testRunner,
    ...(spec.expressionTarget ? { expressionTarget: spec.expressionTarget } : {}),
    ...(spec.publicExamples ? { publicExamples: spec.publicExamples, publicSymbol: spec.publicSymbol } : {}),
    preserveLayout: true
  }, requestOptions(modelHash, spec.lane));
  let isolatedPath = null;
  if (spec.publicExamples) {
    const directory = path.join(workspace, '.lari-test-tmp');
    isolatedPath = fs.existsSync(directory) ? fs.readdirSync(directory).find(name => /^lari-isolated-.*\.py$/.test(name)) : null;
  }
  const after = isolatedPath
    ? runPython(workspace, path.join('.lari-test-tmp', isolatedPath), true)
    : runPython(workspace, spec.testPath, true);
  const view = responseView(response);
  return {
    before,
    response: view,
    after,
    isolatedReproducer: isolatedPath ? { path: `.lari-test-tmp/${isolatedPath}`, passed: after.passed } : null,
    testOracleUnchanged: fileHash(path.join(workspace, spec.testPath)) === oracleHash,
    passed: before.passed === false && response.passed === true && after.passed === true && view.discoveryUsed === false
  };
}

function main() {
  if (fs.existsSync(REPORT)) throw new Error('Coding-frontier transfer report already exists; refusing to overwrite it.');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (fileHash(PAYLOAD) !== manifest.payload.sha256) throw new Error('Sealed payload hash mismatch.');
  const training = JSON.parse(fs.readFileSync(TRAINING, 'utf8'));
  if (!training.passed) throw new Error('Training evidence is not qualified.');
  const candidatePath = ACTIVE_MODE ? ACTIVE : path.join(ROOT, training.candidate.path);
  if (fileHash(candidatePath) !== training.candidate.sha256) throw new Error(`${ACTIVE_MODE ? 'Active production model' : 'Candidate'} hash mismatch.`);
  const sealed = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
  const learnedByOperation = Object.fromEntries(training.learnedRecords.map(record => [record.payload.operation, record.id]));
  const laneOperation = {
    isolated_test_creation: 'normalize_text_to_ascii_slug',
    behavior_preserving_refactor: 'extract_duplicate_python_function_body',
    long_horizon_repair: 'bounded_monotonic_stub_completion_loop'
  };
  const protectedBefore = { candidate: fileHash(candidatePath), active: fileHash(ACTIVE), registry: fileHash(REGISTRY), payload: fileHash(PAYLOAD), manifest: fileHash(MANIFEST) };
  const rows = [];
  for (const spec of sealed.holdouts) {
    const workspace = path.join(SET, ACTIVE_MODE ? 'production-transfer-workspaces' : 'transfer-v2-workspaces', spec.id);
    writeWorkspace(workspace, spec.files);
    const model = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
    const result = execute(spec, model, training.candidate.sha256, workspace, 'coding.frontier.transfer');
    let ablation = null;
    const operation = laneOperation[spec.lane];
    if (operation) {
      const recordId = learnedByOperation[operation];
      const ablatedModel = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
      ablatedModel.lariLearnedRecords.records = ablatedModel.lariLearnedRecords.records.filter(record => record.id !== recordId);
      const ablationWorkspace = path.join(SET, ACTIVE_MODE ? 'production-ablation-workspaces' : 'ablation-v2-workspaces', spec.id);
      writeWorkspace(ablationWorkspace, spec.files);
      const sourceHashesBefore = Object.fromEntries(Object.keys(spec.files).filter(file => file !== spec.testPath).map(file => [file, fileHash(path.join(ablationWorkspace, file))]));
      const ablated = execute(spec, ablatedModel, training.candidate.sha256, ablationWorkspace, 'coding.frontier.ablation');
      const sourceHashesAfter = Object.fromEntries(Object.keys(sourceHashesBefore).map(file => [file, fileHash(path.join(ablationWorkspace, file))]));
      ablation = { removedRecordId: recordId, result: ablated, expectedFailureObserved: ablated.passed === false, rollbackRestoredSources: JSON.stringify(sourceHashesBefore) === JSON.stringify(sourceHashesAfter) };
    }
    rows.push({ id: spec.id, lane: spec.lane, expectedOperation: operation || null, result, ablation, passed: result.passed && (!ablation || (ablation.expectedFailureObserved && ablation.rollbackRestoredSources)) });
  }
  const reload = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const protectedAfter = { candidate: fileHash(candidatePath), active: fileHash(ACTIVE), registry: fileHash(REGISTRY), payload: fileHash(PAYLOAD), manifest: fileHash(MANIFEST) };
  const gates = {
    sealedPayloadIntact: protectedAfter.payload === manifest.payload.sha256,
    fiveOfFiveReuseOnly: rows.length === 5 && rows.every(row => row.result.passed),
    causalAblationThreeOfThree: rows.filter(row => row.ablation).length === 3 && rows.filter(row => row.ablation).every(row => row.ablation.expectedFailureObserved),
    rollbackThreeOfThree: rows.filter(row => row.ablation).every(row => row.ablation.rollbackRestoredSources),
    reloadRetention: training.candidate.learnedRecordIds.every(id => reload.lariLearnedRecords.records.some(record => record.id === id)),
    noDiscovery: rows.every(row => row.result.response.discoveryUsed === false),
    immutableOracles: rows.every(row => row.result.testOracleUnchanged),
    protectedFilesUnchanged: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    externalModelCallsZero: rows.every(row => row.result.response.externalModelCalls === 0)
  };
  const report = { schemaVersion: 1, kind: ACTIVE_MODE ? 'lari.coding-frontier.production-sealed-transfer' : 'lari.coding-frontier.sealed-transfer', createdAt: new Date().toISOString(), passed: Object.values(gates).every(Boolean), candidate: { ...training.candidate, path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'), productionActive: ACTIVE_MODE }, seal: manifest, score: `${rows.filter(row => row.passed).length}/${rows.length}`, rows, gates, protectedBefore, protectedAfter, externalModelCalls: 0 };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ passed: report.passed, score: report.score, candidateHash: training.candidate.sha256, lanes: rows.map(row => ({ lane: row.lane, passed: row.passed, operator: row.result.response.appliedOperatorRecordId, mode: row.result.response.repair?.mode || null, ablation: row.ablation ? { failedWithoutRecord: row.ablation.expectedFailureObserved, rollback: row.ablation.rollbackRestoredSources } : null })), gates }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main();
