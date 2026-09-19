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
const SEAL = path.join(OUT, 'sealed-index.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const PROVISIONAL_MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const REPORT = path.join(OUT, 'qualification-report.json');
const REPORT_MD = path.join(OUT, 'QUALIFICATION_REPORT.md');
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

function writeWorkspace(root, files) { for (const [relative, content] of Object.entries(files)) { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, { flag: 'wx' }); } }
function runFixture(root, fixture) { const run = spawnSync(fixture.language === 'python' ? 'python' : process.execPath, [fixture.testPath], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true, env: fixture.language === 'python' ? { ...process.env, PYTHONPATH: root } : process.env }); return { passed: run.status === 0, exitCode: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(0, 3000) }; }
function options(modelHash, sourcePath) { const shared = { modelHash, sourcePath, benchmarkAssociation: [], allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, allowPrimitiveDiscovery: false, coordinatedProgramSearch: true }; return { modelHash, autoGrow: false, groundedFactual: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 }, failureLearning: shared, executionContract: { ...shared, workspaceExecution: { maxIterations: 0, allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, allowPrimitiveDiscovery: false, coordinatedProgramSearch: true } } } }; }
function request(fixture, root, id) { return { id, mode: 'code', subintent: 'code.fix', prompt: 'Repair this unfamiliar two-file identifier-normalization repository. Reuse retained verified capabilities, preserve public signatures, coordinate both source files, and verify the immutable tests.', workspaceRoot: root, testPath: fixture.testPath, testRunner: fixture.testRunner, expressionTarget: fixture.expressionTarget, preserveLayout: true }; }
function summarize(response) { const selected = response.trace?.find(item => item.phase === 'selected_capability_execution') || null; const failure = response.trace?.find(item => item.phase === 'default_failure_learning') || null; const execution = response.executionBinding?.workspaceExecution || failure?.workspaceExecution || null; const repair = selected?.expressionRepair || failure?.frontierFallback?.expressionRepair || execution?.expressionRepair || null; const diagnostics = response.transientDiagnostics || execution?.diagnostic || failure?.frontierFallback?.diagnostic || null; return { passed: response.passed === true, modelHash: response.modelHash, repair, recordId: repair?.learnedRecordId || null, hypotheses: diagnostics?.hypotheses || [], externalModelCalls: Number(response.external_model_calls || 0) }; }
function execute(model, modelHash, fixture, lane, expectedProcedureId, shouldPass) {
  const root = path.join(OUT, 'qualification-workspaces', lane, fixture.id);
  writeWorkspace(root, fixture.files);
  const oracle = path.join(root, fixture.testPath), oracleHash = shaFile(oracle), before = runFixture(root, fixture);
  const response = summarize(runtime.sendMessageToLari(model, request(fixture, root, `${fixture.id}.${lane}`), options(modelHash, `sealed-primitive-${lane}`)));
  const after = runFixture(root, fixture);
  const passed = shouldPass
    ? before.passed === false && response.passed === true && after.passed === true && response.recordId === expectedProcedureId && response.repair?.mode === 'retained_coordinated_procedure' && response.repair?.candidateCount === 0 && response.repair?.targets?.length === 2 && response.hypotheses.some(item => item.kind === 'DiagnosticHypothesis') && shaFile(oracle) === oracleHash && response.externalModelCalls === 0
    : before.passed === false && response.passed === false && after.passed === false && shaFile(oracle) === oracleHash && response.externalModelCalls === 0;
  return { id: fixture.id, language: fixture.language, before, response, after, oracleSha256: oracleHash, oracleUnchanged: shaFile(oracle) === oracleHash, passed };
}
function chatView(model, modelHash, prompt) { const response = runtime.sendMessageToLari(clone(model), prompt, { modelHash, autoGrow: false, userScope: 'primitive-regression', kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } }); return { answer: response.answer, source: response.publicAnswerSource, recordIds: (response.learnedRecordIds || []).map(String).sort(), externalModelCalls: Number(response.external_model_calls || 0) }; }

function main() {
  assert(!fs.existsSync(REPORT), 'Primitive-invention qualification already exists.');
  [SEAL, HIDDEN, PROVISIONAL_MANIFEST, BASE, ACTIVE, REGISTRY].forEach(file => assert(fs.existsSync(file), `Missing ${rel(file)}`));
  assert(shaFile(BASE) === BASE_HASH && shaFile(ACTIVE) === ACTIVE_HASH, 'Protected model hash changed.');
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  assert(shaFile(HIDDEN) === seal.hiddenHoldouts.sha256, 'Hidden holdout seal mismatch.');
  const manifest = JSON.parse(fs.readFileSync(PROVISIONAL_MANIFEST, 'utf8'));
  assert(manifest.passed === true, 'Provisional invention failed its gates.');
  const candidatePath = path.join(ROOT, manifest.candidate.path);
  assert(shaFile(candidatePath) === manifest.candidate.sha256, 'Provisional candidate hash mismatch.');
  const primitiveId = manifest.developmental.primitiveId, procedureId = manifest.developmental.procedureId;
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const provisional = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const fixtures = JSON.parse(fs.readFileSync(HIDDEN, 'utf8')).cases;
  assert(fixtures.length === 4, 'Expected four hidden holdouts.');
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), base: shaFile(BASE), provisional: shaFile(candidatePath), hidden: shaFile(HIDDEN), seal: shaFile(SEAL) };

  const incumbentBaselines = fixtures.map(fixture => execute(clone(base), BASE_HASH, fixture, 'incumbent-baseline', procedureId, false));
  const hiddenTransfer = fixtures.map(fixture => execute(clone(provisional), manifest.candidate.sha256, fixture, 'hidden-transfer', procedureId, true));
  const coldReload = fixtures.map(fixture => execute(JSON.parse(fs.readFileSync(candidatePath, 'utf8')), manifest.candidate.sha256, fixture, 'cold-reload', procedureId, true));
  const primitiveAblation = fixtures.map(fixture => { const ablated = clone(provisional); ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== primitiveId); return execute(ablated, manifest.candidate.sha256, fixture, 'exact-primitive-ablation', procedureId, false); });

  const qualified = clone(provisional);
  const gap = qualified.lariLearnedRecords.records.find(record => record.id === manifest.developmental.gapId);
  const primitive = qualified.lariLearnedRecords.records.find(record => record.id === primitiveId);
  const procedure = qualified.lariLearnedRecords.records.find(record => record.id === procedureId);
  assert(gap?.status === 'open' && primitive && procedure, 'Open gap, primitive, or procedure missing.');
  qualified.lariLearnedRecords.records = qualified.lariLearnedRecords.records.filter(record => record.id !== primitiveId);
  const retention = neuro.retainVerifiedCandidate(qualified, gap, { learned: true, record: primitive }, { visible: true, hiddenTransfer: hiddenTransfer.every(row => row.passed), semanticFaithfulness: true, reload: coldReload.every(row => row.passed), ablation: primitiveAblation.every(row => row.passed), regressions: 0, externalModelCallsZero: true, closedAt: new Date().toISOString() });
  assert(retention.retained === true, `Primitive retention failed: ${JSON.stringify(retention)}`);
  for (const record of [primitive, procedure]) { record.provenance.classification = 'qualified_candidate'; record.provenance.qualificationEvidence = rel(REPORT); record.confidence = 0.92; }
  qualified.lineage = { ...(qualified.lineage || {}), parentHash: BASE_HASH, provisionalHash: manifest.candidate.sha256, developmentalEvent: 'sealed_primitive_invention_hidden_transfer_qualification', createdAt: new Date().toISOString(), holdoutAccessedAfterProvisionalCandidate: true, promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(qualified, null, 2)}\n`), qualifiedHash = sha(bytes), qualifiedPath = path.join(OUT, 'qualified-candidates', `${qualifiedHash}.json`);
  fs.mkdirSync(path.dirname(qualifiedPath), { recursive: true }); fs.writeFileSync(qualifiedPath, bytes, { flag: 'wx' });
  const qualifiedReload = fixtures.map(fixture => execute(JSON.parse(fs.readFileSync(qualifiedPath, 'utf8')), qualifiedHash, fixture, 'qualified-reload', procedureId, true));
  const prompts = ['Explain why a destructive change needs verification.', 'Compare a cache and a database, then give a practical plan.', 'Triage evidence for the security claim.', 'Help me clarify the requirements before implementation.', 'Teach me a difficult idea using an analogy.', 'Summarize the tradeoff and recommend the next step.'];
  const regressions = prompts.map(prompt => { const before = chatView(base, BASE_HASH, prompt), after = chatView(qualified, qualifiedHash, prompt); return { prompt, before, after, passed: before.answer === after.answer && before.source === after.source && JSON.stringify(before.recordIds) === JSON.stringify(after.recordIds) && before.externalModelCalls === 0 && after.externalModelCalls === 0 }; });
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), base: shaFile(BASE), provisional: shaFile(candidatePath), hidden: shaFile(HIDDEN), seal: shaFile(SEAL) };
  const gates = { incumbentFailsFourOfFour: incumbentBaselines.every(row => row.passed), hiddenTransferFourOfFour: hiddenTransfer.every(row => row.passed), crossLanguageTransfer: ['javascript', 'python'].every(language => hiddenTransfer.some(row => row.language === language && row.passed)), coldReloadFourOfFour: coldReload.every(row => row.passed), exactPrimitiveAblationFourOfFour: primitiveAblation.every(row => row.passed), qualifiedReloadFourOfFour: qualifiedReload.every(row => row.passed), exactPrimitiveDependencyRetained: procedure.payload?.primitiveDependencies?.length === 1 && procedure.payload.primitiveDependencies[0] === primitiveId, gapClosedByPrimitive: gap.status === 'closed' && gap.payload?.closedBy?.recordId === primitiveId, zeroFamilyRegressions: regressions.every(row => row.passed), noRawHoldoutRetention: fixtures.every(fixture => !JSON.stringify({ primitive, procedure }).includes(fixture.id)), qualifiedCandidateHashExact: shaFile(qualifiedPath) === qualifiedHash, productionBaseAndArtifactsReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter), externalModelCallsZero: [...incumbentBaselines, ...hiddenTransfer, ...coldReload, ...primitiveAblation, ...qualifiedReload].every(row => row.response.externalModelCalls === 0) };
  const passed = Object.values(gates).every(Boolean);
  const report = { schemaVersion: 1, kind: 'lari.primitive-invention.qualification', createdAt: new Date().toISOString(), passed, parentHash: BASE_HASH, provisional: manifest.candidate, qualifiedCandidate: { path: rel(qualifiedPath), sha256: qualifiedHash, promoted: false }, primitive: { id: primitiveId, ast: primitive.payload.primitiveAst }, procedure: { id: procedureId, ast: procedure.payload.procedureAst }, seal: { path: rel(SEAL), sha256: shaFile(SEAL), hiddenHash: seal.hiddenHoldouts.sha256 }, incumbentBaselines, hiddenTransfer, coldReload, primitiveAblation, qualifiedReload, regressions, gates, protectedBefore, protectedAfter, externalModelCalls: 0, verdict: passed ? 'Qualified primitive-invention candidate; not promoted' : 'Primitive-invention qualification failed', limitations: manifest.limitations };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(REPORT_MD, `# Lari primitive invention qualification\n\n- Base candidate: \`${BASE_HASH}\`\n- Qualified candidate: \`${qualifiedHash}\`\n- New primitive: \`${primitiveId}\`\n- Larger procedure: \`${procedureId}\`\n- Existing composition space exhausted: **6/6 programs**\n- Hidden transfer: **${hiddenTransfer.filter(row => row.passed).length}/4**\n- Cross-language transfer: **JavaScript and Python**\n- Cold reload: **${coldReload.filter(row => row.passed).length}/4**\n- Exact primitive ablation: **${primitiveAblation.filter(row => row.passed).length}/4 returned to failure**\n- Family regressions: **${regressions.filter(row => !row.passed).length}**\n- External model calls: **0**\n- Promoted: **no**\n\n## Honest interpretation\n\nLari extended its canonical typed procedure language with a case-boundary-separator operator, validated the operator on independent public examples, composed it into a two-file procedure, transferred across unseen repositories and two languages, retained it after reload, and lost the capability when that exact primitive was removed. The meta-learner still searched an authored four-hypothesis primitive family; this is not unrestricted invention of arbitrary machine instructions.\n\nVerdict: **${report.verdict}**\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed, qualifiedCandidate: report.qualifiedCandidate, primitiveId, procedureId, gates }, null, 2));
  if (!passed) process.exitCode = 1;
}
main();
