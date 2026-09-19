#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'predicate-domain-transfer-20260902');
const candidateIndex = process.argv.indexOf('--candidate');
const CANDIDATE = candidateIndex >= 0
  ? path.resolve(process.argv[candidateIndex + 1] || '')
  : path.join(ROOT, 'consolidation', 'open-world-apprenticeship-20260901', 'provisional-candidates', '0a3ce1e0c6bf51b5d61ddca8b0c089661905246d7ce5ae6577cddea8fad8c0fd.json');
const onlyIndex = process.argv.indexOf('--only');
const ONLY = onlyIndex >= 0 ? String(process.argv[onlyIndex + 1] || '') : null;
const REPORT = path.join(OUT, candidateIndex >= 0
  ? (ONLY ? `combined-candidate-external-transfer-${ONLY}.json` : 'combined-candidate-external-transfer.json')
  : (ONLY ? `external-transfer-attempt8-${ONLY}-report.json` : 'external-transfer-attempt8-report.json'));
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PRIMITIVE_ID = 'lari.learned.operator.semantic_mutation.b1de2702dd1ace54';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

const TASKS = [
  {
    id: 'astropy__astropy-7336',
    source: path.join(OUT, 'workspaces', 'astropy__astropy-7336'),
    selector: '.lari-harness/test_transfer.py::test_none_return_annotation_is_not_a_unit_contract',
    expectedSource: 'astropy/units/decorators.py'
  },
  {
    id: 'sphinx-doc__sphinx-9673',
    source: path.join(OUT, 'workspaces', 'sphinx-doc__sphinx-9673'),
    selector: '.lari-harness/test_transfer.py::test_plural_returns_field_receives_the_recorded_return_type',
    expectedSource: 'sphinx/ext/autodoc/typehints.py'
  }
];

function test(workspace) {
  const result = spawnSync('python', ['.lari-harness/test_transfer.py'], {
    cwd: workspace, encoding: 'utf8', timeout: 180000, windowsHide: true
  });
  return { passed: result.status === 0, exitCode: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.slice(-6000) };
}

function options(modelHash, sourcePath) {
  const shared = {
    modelHash,
    sourcePath,
    benchmarkAssociation: [],
    allowExpressionOperatorDiscovery: false,
    allowSemanticOperatorDiscovery: false,
    allowPrimitiveDiscovery: false,
    coordinatedProgramSearch: false,
    expressionSearch: false,
    mutationCandidateLimit: 32,
    taskTimeoutMs: 180000
  };
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
      executionContract: { ...shared, workspaceExecution: { maxIterations: 0, ...shared } }
    }
  };
}

function execute(model, modelHash, task, workspace, phase) {
  const before = test(workspace);
  const sourceBefore = shaFile(path.join(workspace, task.expectedSource));
  const publicTask = read(path.join(OUT, 'public-tasks.json')).tasks.find(item => item.instanceId === task.id);
  const response = runtime.sendMessageToLari(model, {
    id: `predicate-domain-transfer.${phase}.${task.id}`,
    mode: 'code',
    subintent: 'code.fix',
    prompt: publicTask.problemStatement,
    workspaceRoot: workspace,
    testPath: '.lari-harness/test_transfer.py',
    testRunner: 'python.script',
    tests: [{ path: '.lari-harness/test_transfer.py', runner: 'python.script' }],
    preserveLayout: true
  }, options(modelHash, `predicate-domain-external-transfer:${task.id}`));
  const after = test(workspace);
  const sourceAfter = shaFile(path.join(workspace, task.expectedSource));
  const trace = Array.isArray(response?.trace) ? response.trace : [];
  const selected = response?.executionBinding?.workspaceExecution?.expressionRepair
    || trace.find(item => item?.workspaceExecution?.expressionRepair)?.workspaceExecution?.expressionRepair
    || trace.find(item => item?.phase === 'default_failure_learning')?.frontierFallback?.expressionRepair
    || null;
  const appliedOperatorRecordId = response?.executionBinding?.appliedOperatorRecordId
    || response?.executionBinding?.workspaceExecution?.appliedOperatorRecordId
    || model.lariDefaultFailureLearning?.events?.[0]?.retainedPatternId
    || selected?.learnedRecordId
    || null;
  return {
    id: task.id,
    phase,
    before,
    after,
    responsePassed: response?.passed === true,
    modelHash: response?.modelHash || null,
    learnedRecordIds: [...new Set((response?.learnedRecordIds || []).map(String))],
    appliedOperatorRecordId,
    selectedRepair: selected,
    sourceChanged: sourceBefore !== sourceAfter,
    externalModelCalls: Number(response?.external_model_calls || 0),
    responseAction: response?.action || null,
    responseAnswer: String(response?.answer || '').slice(0, 3000),
    executionBinding: response?.executionBinding || null,
    trace: trace.map(item => ({
      phase: item?.phase || null,
      action: item?.action || null,
      workspacePassed: item?.workspaceExecution?.passed,
      repair: item?.workspaceExecution?.expressionRepair || item?.frontierFallback?.expressionRepair || null
    })),
    loopReport: clone(model.frontierCodingRepairLoops?.reports?.[0] || null),
    loopReports: clone((model.frontierCodingRepairLoops?.reports || []).slice(0, 3)),
    defaultFailureEvent: clone(model.lariDefaultFailureLearning?.events?.[0] || null),
    passed: !before.passed && response?.passed === true && after.passed && sourceBefore !== sourceAfter
  };
}

function copyTask(task, base, suffix) {
  const target = path.join(base, `${task.id}-${suffix}`);
  fs.cpSync(task.source, target, { recursive: true, force: false, filter: source => !source.split(path.sep).includes('.git') });
  return target;
}

function main() {
  assert(!fs.existsSync(REPORT), 'Immutable external transfer report already exists.');
  const candidateHash = shaFile(CANDIDATE);
  assert.strictEqual(candidateHash, path.basename(CANDIDATE, '.json'), 'Candidate hash mismatch.');
  const candidateBytesBefore = shaFile(CANDIDATE);
  const activeBefore = shaFile(ACTIVE);
  const registryBefore = shaFile(REGISTRY);
  const candidate = read(CANDIDATE);
  const primitive = (candidate.lariLearnedRecords?.records || []).find(record => record?.id === PRIMITIVE_ID);
  assert(primitive, `Candidate does not contain ${PRIMITIVE_ID}`);
  assert.strictEqual(primitive.payload?.primitive?.kind, 'predicate-domain-set-edit');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-predicate-domain-transfer-'));
  try {
    const selectedTasks = ONLY ? TASKS.filter(task => task.id === ONLY) : TASKS;
    assert(selectedTasks.length > 0, `No task matched --only ${ONLY}`);
    const transfer = selectedTasks.map(task => execute(clone(candidate), candidateHash, task, copyTask(task, temp, 'transfer'), 'transfer'));
    const reload = selectedTasks.map(task => execute(read(CANDIDATE), candidateHash, task, copyTask(task, temp, 'reload'), 'cold-reload'));
    const ablated = clone(candidate);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record?.id !== PRIMITIVE_ID);
    const ablation = selectedTasks.map(task => execute(clone(ablated), candidateHash, task, copyTask(task, temp, 'ablation'), 'exact-ablation'));
    const activeAfter = shaFile(ACTIVE);
    const registryAfter = shaFile(REGISTRY);
    const candidateBytesAfter = shaFile(CANDIDATE);
    const gates = {
      externalTransferComplete: transfer.length === selectedTasks.length && transfer.every(row => row.passed),
      coldReloadComplete: reload.length === selectedTasks.length && reload.every(row => row.passed),
      exactAblationRestoresFailure: ablation.length === selectedTasks.length && ablation.every(row => row.passed === false && row.before.passed === false && row.after.passed === false),
      samePrimitiveSelected: [...transfer, ...reload].every(row => row.learnedRecordIds.includes(PRIMITIVE_ID)
        || row.appliedOperatorRecordId === PRIMITIVE_ID
        || row.selectedRepair?.learnedRecordId === PRIMITIVE_ID),
      externalModelCallsZero: [...transfer, ...reload, ...ablation].every(row => row.externalModelCalls === 0),
      productionReadOnly: activeBefore === activeAfter && registryBefore === registryAfter,
      candidateReadOnly: candidateBytesBefore === candidateBytesAfter
    };
    const passed = Object.values(gates).every(Boolean);
    const report = {
      schemaVersion: 1,
      kind: 'lari.predicate-domain-set-edit.external-transfer',
      createdAt: new Date().toISOString(),
      canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
      candidate: { path: path.relative(ROOT, CANDIDATE).replace(/\\/g, '/'), sha256: candidateHash, promoted: false },
      primitive: { id: PRIMITIVE_ID, kind: primitive.payload.primitive.kind, storesSourceCode: primitive.provenance?.storesSourceCode, storesTestAnswers: primitive.provenance?.storesTestAnswers },
      transfer,
      reload,
      ablation,
      gates,
      passed,
      externalModelCalls: 0,
      limitations: [
        'Both tasks are real untouched SWE-bench Verified issues and pinned upstream source histories.',
        'Historical dependency stacks were replaced by focused isolated reproductions: Astropy uses dependency stubs around its real pure-Python decorator source; Sphinx uses an isolated historical docutils install.',
        'This is external transfer evidence for one predicate-domain primitive, not an official SWE-bench score or arbitrary repository mastery.'
      ],
      verdict: passed ? 'Predicate-domain primitive transferred across two untouched external repositories' : 'External predicate-domain transfer incomplete'
    };
    fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ passed, verdict: report.verdict, candidateHash, primitiveId: PRIMITIVE_ID, transfer: `${transfer.filter(row => row.passed).length}/${selectedTasks.length}`, reload: `${reload.filter(row => row.passed).length}/${selectedTasks.length}`, ablation: `${ablation.filter(row => !row.after.passed).length}/${selectedTasks.length}`, gates }, null, 2)}\n`);
    if (!passed) process.exitCode = 1;
  } finally {
    const resolved = path.resolve(temp);
    assert(resolved.startsWith(path.resolve(os.tmpdir())), 'Refusing to remove non-temp transfer workspace.');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main();
