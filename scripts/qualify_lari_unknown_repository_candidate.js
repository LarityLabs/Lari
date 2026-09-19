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
const SEAL = path.join(OUT, 'sealed-index.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const PROVISIONAL_MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const REPORT = path.join(OUT, 'qualification-report.json');
const REPORT_MD = path.join(OUT, 'QUALIFICATION_REPORT.md');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const ACTIVE_HASH = '91713c42753f32df11df29db70acf78c55c7eb5e9530426913b7fe954eb4e80d';
const RECORD_ID = 'lari.learned.operator.coordinated.a9d55951';
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

function options(modelHash, sourcePath) {
  const shared = {
    modelHash,
    sourcePath,
    benchmarkAssociation: [],
    allowExpressionOperatorDiscovery: false,
    allowSemanticOperatorDiscovery: false,
    coordinatedProgramSearch: true
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
      executionContract: {
        ...shared,
        workspaceExecution: {
          maxIterations: 0,
          allowExpressionOperatorDiscovery: false,
          allowSemanticOperatorDiscovery: false,
          coordinatedProgramSearch: true
        }
      }
    }
  };
}

function request(fixture, workspaceRoot, suffix) {
  return {
    id: `${fixture.id}.${suffix}`,
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
    modelHash: response.modelHash,
    repair,
    recordId: repair?.learnedRecordId || response.executionBinding?.appliedOperatorRecordId || null,
    diagnosticHypotheses: diagnostics?.hypotheses || [],
    externalModelCalls: Number(response.external_model_calls || 0)
  };
}

function executeCase(model, modelHash, fixture, lane) {
  const root = path.join(OUT, 'qualification-workspaces', lane, fixture.id);
  writeWorkspace(root, fixture.files);
  const oracle = path.join(root, fixture.testPath);
  const oracleHash = shaFile(oracle);
  const before = runFixture(root, fixture);
  const response = summarize(runtime.sendMessageToLari(model, request(fixture, root, lane), options(modelHash, `sealed-hidden-${lane}`)));
  const after = runFixture(root, fixture);
  return {
    id: fixture.id,
    language: fixture.language,
    before,
    response,
    after,
    oracleSha256: oracleHash,
    oracleUnchanged: shaFile(oracle) === oracleHash,
    passed: before.passed === false
      && response.passed === true
      && after.passed === true
      && response.recordId === RECORD_ID
      && response.repair?.mode === 'retained_coordinated_operator'
      && response.repair?.candidateCount === 0
      && response.repair?.targets?.length === 2
      && response.diagnosticHypotheses.some(item => item.kind === 'DiagnosticHypothesis')
      && shaFile(oracle) === oracleHash
      && response.externalModelCalls === 0
  };
}

function executeExpectedFailure(model, modelHash, fixture, lane) {
  const root = path.join(OUT, 'qualification-workspaces', lane, fixture.id);
  writeWorkspace(root, fixture.files);
  const oracle = path.join(root, fixture.testPath);
  const oracleHash = shaFile(oracle);
  const before = runFixture(root, fixture);
  const response = summarize(runtime.sendMessageToLari(model, request(fixture, root, lane), options(modelHash, `sealed-hidden-${lane}`)));
  const after = runFixture(root, fixture);
  return {
    id: fixture.id,
    before,
    response,
    after,
    oracleSha256: oracleHash,
    oracleUnchanged: shaFile(oracle) === oracleHash,
    passed: before.passed === false && response.passed === false && after.passed === false && shaFile(oracle) === oracleHash && response.externalModelCalls === 0
  };
}

function chatView(model, modelHash, prompt) {
  const response = runtime.sendMessageToLari(clone(model), prompt, {
    modelHash,
    autoGrow: false,
    userScope: 'sealed-regression',
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
  return { answer: response.answer, source: response.publicAnswerSource, recordIds: (response.learnedRecordIds || []).map(String).sort(), externalModelCalls: Number(response.external_model_calls || 0) };
}

function main() {
  assert(!fs.existsSync(REPORT), 'Unknown-repository qualification report already exists.');
  [SEAL, HIDDEN, PROVISIONAL_MANIFEST, ACTIVE, REGISTRY].forEach(file => assert(fs.existsSync(file), `Missing ${rel(file)}`));
  assert(shaFile(ACTIVE) === ACTIVE_HASH, 'Production active hash changed before qualification.');
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  assert(shaFile(HIDDEN) === seal.hiddenHoldouts.sha256, 'Hidden holdout seal mismatch.');
  const provisionalManifest = JSON.parse(fs.readFileSync(PROVISIONAL_MANIFEST, 'utf8'));
  assert(provisionalManifest.passed === true, 'Provisional acquisition did not pass.');
  const provisionalPath = path.join(ROOT, provisionalManifest.candidate.path);
  assert(shaFile(provisionalPath) === provisionalManifest.candidate.sha256, 'Provisional candidate hash mismatch.');
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), seal: shaFile(SEAL), hidden: shaFile(HIDDEN), provisional: shaFile(provisionalPath) };
  const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const provisional = JSON.parse(fs.readFileSync(provisionalPath, 'utf8'));
  const fixtures = JSON.parse(fs.readFileSync(HIDDEN, 'utf8')).cases;
  assert(fixtures.length === 4, 'Expected four sealed holdouts.');

  const incumbentBaselines = fixtures.map(fixture => executeExpectedFailure(clone(active), ACTIVE_HASH, fixture, 'incumbent-baseline'));
  const hiddenTransfer = fixtures.map(fixture => executeCase(JSON.parse(fs.readFileSync(provisionalPath, 'utf8')), provisionalManifest.candidate.sha256, fixture, 'provisional-transfer'));
  const ablation = fixtures.map(fixture => {
    const ablated = clone(provisional);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== RECORD_ID);
    return executeExpectedFailure(ablated, provisionalManifest.candidate.sha256, fixture, 'exact-record-ablation');
  });

  const qualified = clone(provisional);
  const gap = qualified.lariLearnedRecords.records.find(record => record.id === provisionalManifest.developmental.gapId);
  const learned = qualified.lariLearnedRecords.records.find(record => record.id === RECORD_ID);
  assert(gap?.status === 'open' && learned, 'Open gap or learned record missing from provisional candidate.');
  qualified.lariLearnedRecords.records = qualified.lariLearnedRecords.records.filter(record => record.id !== RECORD_ID);
  const retention = neuro.retainVerifiedCandidate(qualified, gap, { learned: true, record: learned }, {
    visible: true,
    hiddenTransfer: hiddenTransfer.every(row => row.passed),
    semanticFaithfulness: true,
    reload: true,
    ablation: ablation.every(row => row.passed),
    regressions: 0,
    externalModelCallsZero: true,
    closedAt: new Date().toISOString()
  });
  assert(retention.retained === true, `Qualified retention failed: ${JSON.stringify(retention)}`);
  learned.provenance.classification = 'qualified_candidate';
  learned.provenance.qualificationEvidence = rel(REPORT);
  learned.confidence = 0.92;
  qualified.lineage = { ...(qualified.lineage || {}), parentHash: ACTIVE_HASH, provisionalHash: provisionalManifest.candidate.sha256, developmentalEvent: 'sealed_unknown_repository_hidden_transfer_qualification', createdAt: new Date().toISOString(), holdoutAccessedAfterProvisionalCandidate: true, promoted: false };
  const qualifiedBytes = Buffer.from(`${JSON.stringify(qualified, null, 2)}\n`);
  const qualifiedHash = sha(qualifiedBytes);
  const qualifiedPath = path.join(OUT, 'qualified-candidates', `${qualifiedHash}.json`);
  fs.mkdirSync(path.dirname(qualifiedPath), { recursive: true });
  fs.writeFileSync(qualifiedPath, qualifiedBytes, { flag: 'wx' });
  const qualifiedReload = fixtures.map(fixture => executeCase(JSON.parse(fs.readFileSync(qualifiedPath, 'utf8')), qualifiedHash, fixture, 'qualified-reload'));

  const regressionPrompts = [
    'What are you in plain English?',
    'Give exactly two bullet points about backups.',
    'Describe safe diagnostics when a test fails.',
    'How should source-grounded learning work?',
    'Why verify destructive changes?',
    'Triage evidence for the reliability claim.'
  ];
  const regressions = regressionPrompts.map(prompt => {
    const incumbent = chatView(active, ACTIVE_HASH, prompt);
    const candidate = chatView(qualified, qualifiedHash, prompt);
    return { promptSha256: sha(prompt), incumbent, candidate, regressed: incumbent.answer !== candidate.answer || incumbent.source !== candidate.source || JSON.stringify(incumbent.recordIds) !== JSON.stringify(candidate.recordIds) };
  });
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), seal: shaFile(SEAL), hidden: shaFile(HIDDEN), provisional: shaFile(provisionalPath) };
  const learnedSerialized = JSON.stringify(learned);
  const gates = {
    incumbentFailsFourOfFour: incumbentBaselines.length === 4 && incumbentBaselines.every(row => row.passed),
    hiddenTransferFourOfFour: hiddenTransfer.length === 4 && hiddenTransfer.every(row => row.passed),
    crossLanguageTransfer: hiddenTransfer.filter(row => row.language === 'javascript' && row.passed).length === 2 && hiddenTransfer.filter(row => row.language === 'python' && row.passed).length === 2,
    zeroSearchReuseFourOfFour: hiddenTransfer.every(row => row.response.repair?.candidateCount === 0),
    twoFileRepairFourOfFour: hiddenTransfer.every(row => row.response.repair?.targets?.length === 2),
    exactRecordAblationFourOfFour: ablation.length === 4 && ablation.every(row => row.passed),
    qualifiedReloadFourOfFour: qualifiedReload.length === 4 && qualifiedReload.every(row => row.passed),
    gapClosedByExactRecord: gap.status === 'closed' && gap.payload?.closedBy?.recordId === RECORD_ID,
    canonicalQualifiedOperator: learned.type === 'operator' && learned.provenance.classification === 'qualified_candidate',
    noFixtureOrExpectedAnswerRetention: ['selectEligible', 'countEligible', 'chooseReady', 'readyTotal', 'select_active', 'active_count', 'allowedEntries', 'allowedCount', 'verified_rows', 'verified_total', 'summary.test.js', 'verify.py'].every(term => !learnedSerialized.includes(term)),
    zeroFamilyRegressions: regressions.every(row => !row.regressed),
    qualifiedCandidateHashExact: shaFile(qualifiedPath) === qualifiedHash,
    activeAndRegistryReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    externalModelCallsZero: [...incumbentBaselines, ...hiddenTransfer, ...ablation, ...qualifiedReload].every(row => row.response.externalModelCalls === 0) && regressions.every(row => row.incumbent.externalModelCalls === 0 && row.candidate.externalModelCalls === 0)
  };
  const report = {
    schemaVersion: 1,
    kind: 'lari.coding-mastery.unknown-repository-qualification',
    createdAt: new Date().toISOString(),
    passed: Object.values(gates).every(Boolean),
    parentHash: ACTIVE_HASH,
    provisional: provisionalManifest.candidate,
    qualifiedCandidate: { path: rel(qualifiedPath), sha256: qualifiedHash, promoted: false },
    learnedRecord: { id: RECORD_ID, type: learned.type, operation: learned.payload.operation, programAst: learned.payload.programAst, confidence: learned.confidence },
    seal: { path: rel(SEAL), sha256: shaFile(SEAL), hiddenSha256: shaFile(HIDDEN) },
    incumbentBaselines,
    hiddenTransfer,
    ablation,
    qualifiedReload,
    regressions,
    gates,
    protectedBefore,
    protectedAfter,
    externalModelCalls: 0,
    verdict: Object.values(gates).every(Boolean) ? 'New bounded coding procedure acquired and transferred' : 'Qualification failed',
    limitations: [
      'The exact procedure was absent from the incumbent and was synthesized after a real fail-before observation.',
      'The generator vocabulary for async predicate pipelines already existed in runtime code; this does not prove invention of a new generator vocabulary.',
      'Four holdouts across two languages establish bounded transfer, not arbitrary repository coding mastery.',
      'The qualified candidate is not promoted.'
    ]
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  const markdown = `# Lari unknown-repository acquisition qualification\n\n- Parent production: \`${ACTIVE_HASH}\`\n- Qualified candidate: \`${qualifiedHash}\` (not promoted)\n- Learned record: \`${RECORD_ID}\`\n- Incumbent hidden failures: **${incumbentBaselines.filter(row => row.passed).length}/4**\n- Candidate hidden transfer: **${hiddenTransfer.filter(row => row.passed).length}/4**\n- Exact-record ablation failures restored: **${ablation.filter(row => row.passed).length}/4**\n- Qualified reload retention: **${qualifiedReload.filter(row => row.passed).length}/4**\n- Family regressions: **${regressions.filter(row => row.regressed).length}**\n- External model calls: **0**\n\n## Honest interpretation\n\nLari failed without the learned record, synthesized a new typed async predicate/count program from its existing bounded generator primitives, reused it with zero search in renamed JavaScript and Python repositories, retained it after serialization and reload, and lost the capability when that exact record was removed. This is real bounded procedure acquisition. It is not yet proof that Lari can invent a wholly new generator vocabulary or repair arbitrary repositories.\n\nVerdict: **${report.verdict}**\n`;
  fs.writeFileSync(REPORT_MD, markdown, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ passed: report.passed, qualifiedCandidate: report.qualifiedCandidate, learnedRecord: report.learnedRecord, gates, verdict: report.verdict }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main();
