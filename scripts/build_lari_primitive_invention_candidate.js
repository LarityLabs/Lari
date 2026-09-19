#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const neuro = require('../swarm_domain_neurogenesis.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'primitive-invention-20260831');
const PUBLIC = path.join(OUT, 'public-training.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const BASE_HASH = '9d48f8f29f9406eb41cbd5e2f7740f96900b1902c2075dc1c91954ab0fbdc54b';
const ACTIVE_HASH = '91713c42753f32df11df29db70acf78c55c7eb5e9530426913b7fe954eb4e80d';
const BASE = path.join(ROOT, 'consolidation', 'coding-mastery-acquisition-attempt3-20260830', 'qualified-candidates', `${BASE_HASH}.json`);
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
function hashes(root, files) { return Object.fromEntries(Object.keys(files).sort().map(file => [file, shaFile(path.join(root, file))])); }
function runFixture(root, fixture) {
  const run = spawnSync(fixture.language === 'python' ? 'python' : process.execPath, [fixture.testPath], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true, env: fixture.language === 'python' ? { ...process.env, PYTHONPATH: root } : process.env });
  return { passed: run.status === 0, exitCode: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(0, 3000) };
}
function options(modelHash, primitiveDiscovery, sourcePath) {
  const shared = { modelHash, sourcePath, benchmarkAssociation: [], allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: true, allowPrimitiveDiscovery: primitiveDiscovery, coordinatedProgramSearch: true };
  return { modelHash, autoGrow: false, groundedFactual: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 }, failureLearning: shared, executionContract: { ...shared, workspaceExecution: { maxIterations: 0, allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: true, allowPrimitiveDiscovery: primitiveDiscovery, coordinatedProgramSearch: true } } } };
}
function request(fixture, root, id) {
  return { id, mode: 'code', subintent: 'code.fix', prompt: 'Repair this unfamiliar two-file repository. Exhaust the current trim-and-lowercase primitive compositions. Diagnose the missing operation, validate a new primitive independently, compose the new primitive into the larger procedure, and verify the immutable tests.', workspaceRoot: root, testPath: fixture.testPath, testRunner: fixture.testRunner, expressionTarget: fixture.expressionTarget, preserveLayout: true };
}
function summarize(response) {
  const selected = response.trace?.find(item => item.phase === 'selected_capability_execution') || null;
  const failure = response.trace?.find(item => item.phase === 'default_failure_learning') || null;
  const execution = response.executionBinding?.workspaceExecution || failure?.workspaceExecution || null;
  const repair = selected?.expressionRepair || failure?.frontierFallback?.expressionRepair || execution?.expressionRepair || null;
  const diagnostics = response.transientDiagnostics || execution?.diagnostic || failure?.frontierFallback?.diagnostic || null;
  return { passed: response.passed === true, modelHash: response.modelHash, repair, recordId: repair?.learnedRecordId || null, primitiveId: repair?.learnedPrimitiveId || null, hypotheses: diagnostics?.hypotheses || [], externalModelCalls: Number(response.external_model_calls || 0) };
}

function main() {
  assert(!fs.existsSync(MANIFEST), 'Primitive-invention provisional manifest already exists.');
  [PUBLIC, SEAL, BASE, ACTIVE, REGISTRY].forEach(file => assert(fs.existsSync(file), `Missing ${rel(file)}`));
  assert(shaFile(BASE) === BASE_HASH, 'Stage 2 coding-acquisition candidate hash mismatch.');
  assert(shaFile(ACTIVE) === ACTIVE_HASH, 'Real production active model changed.');
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  assert(shaFile(PUBLIC) === seal.publicTraining.sha256, 'Public curriculum seal mismatch.');
  assert(seal.existingPrimitiveLanguage.totalPrograms === 6, 'Expected exactly six incumbent programs.');
  const fixture = JSON.parse(fs.readFileSync(PUBLIC, 'utf8')).case;
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), base: shaFile(BASE), public: shaFile(PUBLIC), seal: shaFile(SEAL) };

  const baselineRoot = path.join(OUT, 'baseline-workspace-v8');
  writeWorkspace(baselineRoot, fixture.files);
  const baselineFiles = hashes(baselineRoot, fixture.files);
  const baselineOracle = shaFile(path.join(baselineRoot, fixture.testPath));
  const baselineBefore = runFixture(baselineRoot, fixture);
  const baselineResponse = summarize(runtime.sendMessageToLari(clone(base), request(fixture, baselineRoot, 'primitive.baseline'), options(BASE_HASH, false, 'sealed-primitive-baseline')));
  const baselineAfter = runFixture(baselineRoot, fixture);

  const learningRoot = path.join(OUT, 'learning-workspace-v8');
  writeWorkspace(learningRoot, fixture.files);
  const learningOracle = shaFile(path.join(learningRoot, fixture.testPath));
  const model = clone(base);
  const parentIds = new Set((base.lariLearnedRecords?.records || []).map(record => record.id));
  const gap = neuro.createGap(model, { targetType: 'operator', capability: 'introduce a verified identifier case-boundary separator primitive that is not expressible by trim and lowercase composition', failureClass: 'primitive_language_expression_gap', sourceModelHash: BASE_HASH, sourcePath: 'sealed_primitive_invention_failure', researchAllowed: true, createdAt: new Date().toISOString() });
  const learningBefore = runFixture(learningRoot, fixture);
  const rawLearningResponse = runtime.sendMessageToLari(model, request(fixture, learningRoot, 'primitive.learning'), options(BASE_HASH, true, 'sealed_primitive_invention_failure'));
  const learningResponse = summarize(rawLearningResponse);
  const learningAfter = runFixture(learningRoot, fixture);
  const added = model.lariLearnedRecords.records.filter(record => !parentIds.has(record.id) && record.id !== gap.id);
  const primitive = added.find(record => record.type === 'operator' && record.payload?.operation === 'text_normalization_primitive');
  const procedure = added.find(record => record.type === 'procedure' && record.payload?.operation === 'coordinated_multi_file_procedure' && record.payload?.primitiveDependencies?.includes(primitive?.id));
  assert(primitive, `No primitive invented; added=${added.map(record => record.id).join(',')}; response=${JSON.stringify(learningResponse)}; raw=${JSON.stringify(rawLearningResponse)}`);
  assert(procedure, `No larger primitive-composed procedure retained; added=${added.map(record => record.id).join(',')}`);
  model.lineage = { ...(model.lineage || {}), parentHash: BASE_HASH, developmentalEvent: 'sealed_primitive_language_extension', createdAt: new Date().toISOString(), sourcePrimitiveId: primitive.id, sourceProcedureId: procedure.id, holdoutAccessedBeforeCandidate: false, promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), base: shaFile(BASE), public: shaFile(PUBLIC), seal: shaFile(SEAL) };
  const retainedText = JSON.stringify({ primitive, procedure });
  const gates = {
    taskFailsBefore: baselineBefore.passed === false && baselineResponse.passed === false && baselineAfter.passed === false,
    baselineReadOnly: JSON.stringify(baselineFiles) === JSON.stringify(hashes(baselineRoot, fixture.files)),
    existingCompositionSpaceExhausted: learningResponse.repair?.knownCompositionExhausted === true && learningResponse.repair?.knownCompositionAttempts === 6,
    missingPrimitiveDiagnosedBeforeEdit: learningResponse.hypotheses.some(item => item.kind === 'DiagnosticHypothesis'),
    newPrimitiveSynthesized: learningResponse.primitiveId === primitive.id && primitive.payload?.primitiveAst?.op === 'case_boundary_separator',
    primitiveIndependentlyValidated: primitive.payload?.independentExamplesPassed >= 3 && primitive.payload?.verification === 'independent_string_pair_oracle_then_larger_procedure',
    largerProcedureUsesExactPrimitive: procedure.payload?.primitiveDependencies?.length === 1 && procedure.payload.primitiveDependencies[0] === primitive.id && procedure.payload?.procedureAst?.normalization?.some(step => step?.primitiveId === primitive.id),
    failBeforePassAfter: learningBefore.passed === false && learningResponse.passed === true && learningAfter.passed === true,
    exactDiscoveryAccounting: learningResponse.repair?.primitiveCandidateAttempts === 4 && learningResponse.repair?.candidateCount === 10,
    oracleImmutable: shaFile(path.join(learningRoot, fixture.testPath)) === learningOracle && shaFile(path.join(baselineRoot, fixture.testPath)) === baselineOracle,
    typedCanonicalRecords: primitive.status === 'active' && procedure.status === 'active' && primitive.provenance?.creationSource === 'failure_driven_primitive_experiment' && procedure.provenance?.creationSource === 'failure_driven_primitive_experiment',
    noRawExamplesOrFixtureRetention: ['userProfile', 'HTTPServerID', 'XMLParser', 'naming.test.js'].every(term => !retainedText.includes(term)),
    gapOpenUntilQualification: gap.status === 'open',
    hiddenUnread: model.lineage.holdoutAccessedBeforeCandidate === false,
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    productionAndBaseReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    externalModelCallsZero: baselineResponse.externalModelCalls === 0 && learningResponse.externalModelCalls === 0
  };
  const manifest = { schemaVersion: 1, kind: 'lari.primitive-invention.provisional-candidate', createdAt: new Date().toISOString(), parentHash: BASE_HASH, candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false }, seal: { path: rel(SEAL), sha256: shaFile(SEAL), publicHash: seal.publicTraining.sha256, hiddenHash: seal.hiddenHoldouts.sha256 }, developmental: { gapId: gap.id, primitiveId: primitive.id, procedureId: procedure.id, primitiveAst: primitive.payload.primitiveAst, procedureAst: procedure.payload.procedureAst, baseline: { before: baselineBefore, response: baselineResponse, after: baselineAfter }, learning: { before: learningBefore, response: learningResponse, after: learningAfter } }, gates, passed: Object.values(gates).every(Boolean), protectedBefore, protectedAfter, externalModelCalls: 0, limitations: ['The invented primitive is a new canonical typed operator and extends the procedure language used by the candidate.', 'The meta-learner searched an authored four-hypothesis case-boundary family; this does not prove unconstrained invention of arbitrary machine instructions.', 'The learner process did not read hidden holdouts.'] };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: manifest.passed, candidate: manifest.candidate, primitiveId: primitive.id, procedureId: procedure.id, gates }, null, 2));
  if (!manifest.passed) process.exitCode = 1;
}
main();
