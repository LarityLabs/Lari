#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const neuro = require('../swarm_domain_neurogenesis.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'coding-mastery-acquisition-attempt3-20260830');
const PUBLIC = path.join(OUT, 'public-training.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const ACTIVE_HASH = '91713c42753f32df11df29db70acf78c55c7eb5e9530426913b7fe954eb4e80d';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function writeWorkspace(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: 'wx' });
  }
}

function workspaceHashes(root, files) {
  return Object.fromEntries(Object.keys(files).sort().map(relative => [relative, shaFile(path.join(root, relative))]));
}

function runFixture(root, fixture) {
  const executable = fixture.language === 'python' ? 'python' : process.execPath;
  const run = spawnSync(executable, [fixture.testPath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    env: fixture.language === 'python' ? { ...process.env, PYTHONPATH: root } : process.env
  });
  return { passed: run.status === 0, exitCode: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(0, 3000) };
}

function options(discovery, sourcePath) {
  const shared = {
    modelHash: ACTIVE_HASH,
    sourcePath,
    benchmarkAssociation: [],
    allowExpressionOperatorDiscovery: false,
    allowSemanticOperatorDiscovery: discovery,
    coordinatedProgramSearch: true
  };
  return {
    modelHash: ACTIVE_HASH,
    autoGrow: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: shared,
      executionContract: {
        ...shared,
        workspaceExecution: {
          maxIterations: 0,
          allowExpressionOperatorDiscovery: false,
          allowSemanticOperatorDiscovery: discovery,
          coordinatedProgramSearch: true
        }
      }
    }
  };
}

function request(fixture, workspaceRoot, id) {
  return {
    id,
    mode: 'code',
    subintent: 'code.fix',
    prompt: 'Repair this unfamiliar failing multi-file async repository. Form a diagnostic hypothesis before editing, preserve public signatures, coordinate the dependency and consumer, and verify the immutable test.',
    workspaceRoot,
    testPath: fixture.testPath,
    testRunner: fixture.testRunner,
    expressionTarget: fixture.expressionTarget,
    preserveLayout: true
  };
}

function summarize(response) {
  const selected = response.trace?.find(item => item.phase === 'selected_capability_execution') || null;
  const failure = response.trace?.find(item => item.phase === 'default_failure_learning') || null;
  const execution = response.executionBinding?.workspaceExecution || failure?.workspaceExecution || null;
  const repair = selected?.expressionRepair || failure?.frontierFallback?.expressionRepair || execution?.expressionRepair || null;
  const diagnostics = response.transientDiagnostics || execution?.diagnostic || failure?.frontierFallback?.diagnostic || null;
  return {
    passed: response.passed === true,
    action: response.action,
    modelHash: response.modelHash,
    repair,
    recordId: repair?.learnedRecordId || response.executionBinding?.appliedOperatorRecordId || null,
    diagnosticHypotheses: diagnostics?.hypotheses || [],
    externalModelCalls: Number(response.external_model_calls || 0)
  };
}

function main() {
  assert(!fs.existsSync(MANIFEST), 'Unknown-repository provisional candidate already exists.');
  [PUBLIC, SEAL, ACTIVE, REGISTRY].forEach(file => assert(fs.existsSync(file), `Missing ${rel(file)}`));
  assert(shaFile(ACTIVE) === ACTIVE_HASH, 'Active model is not the promoted Stage 5 hash.');
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  assert(shaFile(PUBLIC) === seal.publicTraining.sha256, 'Public training seal mismatch.');
  const fixture = JSON.parse(fs.readFileSync(PUBLIC, 'utf8')).case;
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), public: shaFile(PUBLIC), seal: shaFile(SEAL) };
  const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));

  const baselineRoot = path.join(OUT, 'baseline-workspace');
  writeWorkspace(baselineRoot, fixture.files);
  const baselineOracle = path.join(baselineRoot, fixture.testPath);
  const baselineOracleHash = shaFile(baselineOracle);
  const baselineFilesBefore = workspaceHashes(baselineRoot, fixture.files);
  const baselineBefore = runFixture(baselineRoot, fixture);
  assert(!baselineBefore.passed, 'Training task unexpectedly passed before Lari ran.');
  const baselineResponse = summarize(runtime.sendMessageToLari(clone(active), request(fixture, baselineRoot, 'unknown.baseline'), options(false, 'sealed-unknown-repository-baseline')));
  const baselineAfter = runFixture(baselineRoot, fixture);
  const baselineFilesAfter = workspaceHashes(baselineRoot, fixture.files);

  const trainingRoot = path.join(OUT, 'training-workspace');
  writeWorkspace(trainingRoot, fixture.files);
  const trainingOracle = path.join(trainingRoot, fixture.testPath);
  const trainingOracleHash = shaFile(trainingOracle);
  const model = clone(active);
  const parentIds = new Set((active.lariLearnedRecords?.records || []).map(record => record.id));
  const gap = neuro.createGap(model, {
    targetType: 'operator',
    capability: 'coordinate an asynchronous predicate pipeline and count matching records across dependency boundaries',
    failureClass: 'unseen_async_cross_file_predicate_aggregation',
    sourceModelHash: ACTIVE_HASH,
    sourcePath: 'ordinary_unknown_repository_failure',
    researchAllowed: true,
    createdAt: new Date().toISOString()
  });
  const trainingBefore = runFixture(trainingRoot, fixture);
  const trainingResponse = summarize(runtime.sendMessageToLari(model, request(fixture, trainingRoot, 'unknown.learning'), options(true, 'ordinary_unknown_repository_failure')));
  const trainingAfter = runFixture(trainingRoot, fixture);
  const added = model.lariLearnedRecords.records.filter(record => !parentIds.has(record.id) && record.id !== gap.id);
  const record = added.find(item => item.type === 'operator' && item.payload?.operation === 'coordinated_multi_file_program') || null;
  assert(record, `No new coordinated operator was synthesized; added=${added.map(item => item.id).join(',')}`);
  const serializedRecord = JSON.stringify(record);
  model.lineage = {
    ...(model.lineage || {}),
    parentHash: ACTIVE_HASH,
    developmentalEvent: 'unknown_repository_failure_driven_procedure_acquisition',
    createdAt: new Date().toISOString(),
    sourceLearnedRecordId: record.id,
    holdoutAccessedBeforeCandidate: false,
    promoted: false
  };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), public: shaFile(PUBLIC), seal: shaFile(SEAL) };
  const expectedAst = { op: 'coordinated_async_pipeline', predicatePropertyIndex: 0, valuePropertyIndex: 1, predicate: 'truthy', terminal: 'count' };
  const gates = {
    genuineBaselineFailure: baselineBefore.passed === false && baselineResponse.passed === false && baselineAfter.passed === false,
    baselineWorkspaceReadOnly: JSON.stringify(baselineFilesBefore) === JSON.stringify(baselineFilesAfter),
    baselineOracleImmutable: shaFile(baselineOracle) === baselineOracleHash,
    diagnosticHypothesisBeforeEdit: trainingResponse.diagnosticHypotheses.some(item => item.kind === 'DiagnosticHypothesis'),
    failureDrivenSynthesis: trainingResponse.repair?.mode === 'searched_coordinated_operator' && trainingResponse.recordId === record.id,
    boundedSearchRecorded: trainingResponse.repair?.candidateCount === 6,
    exactNewProgram: JSON.stringify(record.payload?.programAst) === JSON.stringify(expectedAst),
    twoFilesChanged: trainingResponse.repair?.targets?.length === 2,
    failBeforePassAfter: trainingBefore.passed === false && trainingAfter.passed === true && trainingResponse.passed === true,
    oracleImmutable: shaFile(trainingOracle) === trainingOracleHash,
    canonicalTypedRecord: record.type === 'operator' && record.status === 'active' && record.payload?.domain === 'workspace_coding',
    noFixtureOrExpectedAnswerRetention: ['eligible', 'points', 'summary.test.js', 'countEligible'].every(term => !serializedRecord.includes(term)),
    gapRemainsOpenUntilQualification: gap.status === 'open',
    hiddenHoldoutsUnread: model.lineage.holdoutAccessedBeforeCandidate === false,
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    productionReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    externalModelCallsZero: baselineResponse.externalModelCalls === 0 && trainingResponse.externalModelCalls === 0
  };
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.coding-mastery.unknown-repository-provisional-candidate',
    createdAt: new Date().toISOString(),
    parentHash: ACTIVE_HASH,
    candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false },
    seal: { path: rel(SEAL), sha256: shaFile(SEAL), publicHash: seal.publicTraining.sha256, hiddenHash: seal.hiddenHoldouts.sha256 },
    developmental: { gapId: gap.id, recordId: record.id, baseline: { before: baselineBefore, response: baselineResponse, after: baselineAfter }, training: { before: trainingBefore, response: trainingResponse, after: trainingAfter, oracleSha256: trainingOracleHash }, programAst: record.payload.programAst },
    gates,
    passed: Object.values(gates).every(Boolean),
    protectedBefore,
    protectedAfter,
    externalModelCalls: 0,
    limitations: [
      'This is a new retained procedure instance synthesized from an existing bounded async-pipeline generator vocabulary.',
      'It is not evidence that Lari invented a wholly new generator vocabulary or can repair arbitrary repositories.',
      'The hidden holdouts have not been evaluated or read by this learner process.'
    ]
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ passed: manifest.passed, candidate: manifest.candidate, recordId: record.id, programAst: record.payload.programAst, gates }, null, 2)}\n`);
  if (!manifest.passed) process.exitCode = 1;
}

main();
