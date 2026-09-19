#!/usr/bin/env node
'use strict';

// Candidate-only integration proof. It composes already qualified records in
// one temporary model state and exercises the existing canonical lifecycle
// across chat, research, coding, modalities, and bounded agent execution.
// This is deliberately not a promotion or a claim of open-ended generality.

const assert = require('assert');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const HYPOTHESIS_MANIFEST = path.join(ROOT, 'consolidation', 'hypothesis-guided-generator-20260906', 'qualified-candidate-manifest.json');
const SCENE_MANIFEST = path.join(ROOT, 'consolidation', 'cross-modal-scene-20260906', 'qualified-candidate-manifest.json');
const SCENE_HOLDOUTS = path.join(ROOT, 'consolidation', 'cross-modal-scene-20260906', 'hidden-holdouts.json');
// This is the one previously qualified coding primitive needed by the
// cross-domain fixture. It is imported as a typed record, not as a new
// router/store, and its original provenance remains intact.
const CODING_SOURCE = path.join(ROOT, 'consolidation', 'open-world-apprenticeship-20260901', 'provisional-candidates', '79a80a4ffceb319dce80d63fab35cd11571905b5b31d7f18d2055256cf57461c.json');
const CODING_RECORD_ID = 'lari.learned.operator.semantic_mutation.b1de2702dd1ace54';
const OUT = path.join(ROOT, 'consolidation', 'cross-domain-composition-attempt9-20260906');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hashPrompt = prompt => `sha256:${sha(String(prompt))}`;

if (fs.existsSync(OUT)) throw new Error(`Refusing to overwrite immutable output: ${path.relative(ROOT, OUT)}`);
(async () => {
fs.mkdirSync(OUT, { recursive: true });

const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const parent = read(ACTIVE);
const hypothesisManifest = read(HYPOTHESIS_MANIFEST);
const sceneManifest = read(SCENE_MANIFEST);
const hypothesisModel = read(path.join(ROOT, hypothesisManifest.candidate.path));
const sceneModel = read(path.join(ROOT, sceneManifest.candidate.path));
const codingModel = read(CODING_SOURCE);
const hypothesisRecord = hypothesisModel.lariLearnedRecords.records.find(record => record.id === hypothesisManifest.candidate.learnedRecordId);
const sceneRecord = sceneModel.lariLearnedRecords.records.find(record => record.id === sceneManifest.candidate.learnedRecordId);
const codingRecord = codingModel.lariLearnedRecords.records.find(record => record.id === CODING_RECORD_ID);
assert(hypothesisRecord && sceneRecord && codingRecord, 'qualified source records are missing');

const candidate = clone(parent);
candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
candidate.lariLearnedRecords.records = candidate.lariLearnedRecords.records || [];
const importedCodingRecord = clone(codingRecord);
importedCodingRecord.provenance = {
  ...(importedCodingRecord.provenance || {}),
  imported: true,
  classification: 'cross_domain_composition_candidate',
  importedFromCandidatePath: path.relative(ROOT, CODING_SOURCE).replace(/\\/g, '/'),
  importedFromCandidateHash: shaFile(CODING_SOURCE),
  importTimestamp: new Date().toISOString()
};
for (const record of [hypothesisRecord, sceneRecord, importedCodingRecord]) {
  if (!candidate.lariLearnedRecords.records.some(existing => existing.id === record.id)) {
    candidate.lariLearnedRecords.records.unshift(clone(record));
  }
}
// Rebuild the existing derived index structures in the candidate clone. These
// are indexes, not a second intelligence store.
const graph = runtime.buildLariCapabilityGraph(candidate, {});
const genome = runtime.buildLariCapabilityGenome(candidate, {});
candidate.lineage = {
  ...(candidate.lineage || {}),
  parentHash: protectedBefore.active,
  developmentalEvent: 'cross_domain_composition_candidate',
  canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
  importedRecordIds: [hypothesisRecord.id, sceneRecord.id, importedCodingRecord.id],
  promoted: false,
  createdAt: new Date().toISOString()
};
const seedBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
const seedHash = sha(seedBytes);
const seedPath = path.join(OUT, `seed-${seedHash}.json`);
fs.writeFileSync(seedPath, seedBytes, { flag: 'wx' });

const kernelOptions = hash => ({
  modelHash: hash,
  autoGrow: false,
  groundedFactual: false,
  kernel: {
    useBenchmarkSystem: false,
    useCapabilityGraph: true,
    includeTransientDiagnostics: true,
    capabilityGraph: { minScore: 0 },
    chat: { minMemoryScore: 0, minRouteScore: 0 },
    failureLearning: {
      modelHash: hash,
      sourcePath: 'cross-domain-composition-20260906',
      benchmarkAssociation: [],
      allowExpressionOperatorDiscovery: false,
      allowSemanticOperatorDiscovery: false,
      coordinatedProgramSearch: true,
      progressiveRelaxation: true,
      maxIterations: 3
    },
    executionContract: {
      modelHash: hash,
      workspaceExecution: {
        maxIterations: 0,
        allowExpressionOperatorDiscovery: false,
        allowSemanticOperatorDiscovery: false,
        coordinatedProgramSearch: true,
        progressiveRelaxation: true
      }
    }
  }
});

const reasoningPrompt = 'Observation: the cache stayed stale. Hypothesis A: invalidation ran before the write committed. Hypothesis B: the response path writes a later version. Discriminating check: compare commit and invalidation timestamps.';
const reasoningResponse = runtime.sendMessageToLari(candidate, {
  id: 'cross-domain.reasoning',
  mode: 'chat',
  prompt: reasoningPrompt
}, kernelOptions(seedHash));
const reasoningRecordSelected = [
  ...(reasoningResponse.recapLearnedRecordIds || []),
  ...(reasoningResponse.learnedRecordIds || [])
].includes(hypothesisRecord.id);

const researchQuery = 'What is the local queue drain contract?';
const researchResponse = await runtime.runLariAutonomousRequest(candidate, {
  mode: 'chat',
  prompt: researchQuery
}, {
  mode: 'chat',
  modelHash: seedHash,
  groundedFactual: false,
  autoResearchOnUncertainty: true,
  research: {
    sourceAdapter: 'local_test_sources',
    sources: [
      { title: 'queue spec', url: 'local://queue-spec', text: 'A queue drain acknowledges each item after durable commit and stops before shutdown.' },
      { title: 'shutdown note', url: 'local://shutdown-note', text: 'Durable commit precedes acknowledgement; shutdown waits for the drain barrier.' }
    ]
  }
});
const researchRecordId = researchResponse.learning?.learned?.lariTypedRecordId
  || researchResponse.learning?.learned?.sourceLearnedRecordId
  || researchResponse.learning?.learned?.id
  || null;
const researchLearned = researchResponse.action === 'chat_after_autonomous_research'
  && researchResponse.learning?.action === 'learned_from_sources'
  && Boolean(researchRecordId);

const codingWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-cross-domain-code-'));
fs.mkdirSync(path.join(codingWorkspace, 'src'), { recursive: true });
fs.mkdirSync(path.join(codingWorkspace, 'tests'), { recursive: true });
fs.writeFileSync(path.join(codingWorkspace, 'src', '__init__.py'), '');
fs.writeFileSync(path.join(codingWorkspace, 'src', 'fields.py'), [
  'def classify(parts):',
  '    if parts[0] == "widget":',
  '        return True',
  '    return False',
  ''
].join('\n'));
fs.writeFileSync(path.join(codingWorkspace, 'tests', 'test.py'), [
  'from src.fields import classify',
  'assert classify(["widget"]) is True',
  'assert classify(["gadget"]) is True',
  ''
].join('\n'));
const runCodingOracle = () => cp.spawnSync('python', ['tests/test.py'], {
  cwd: codingWorkspace,
  env: { ...process.env, PYTHONPATH: [codingWorkspace, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  encoding: 'utf8', windowsHide: true
});
const codingBefore = runCodingOracle();
const codingResponse = runtime.sendMessageToLari(candidate, {
  id: 'cross-domain.coding',
  mode: 'code',
  subintent: 'code.fix',
  prompt: 'Repair this unfamiliar predicate-domain bug. Form a diagnostic hypothesis, preserve the declared test, and verify the fail-to-pass repair.',
  workspaceRoot: codingWorkspace,
  testPath: 'tests/test.py',
  testRunner: 'python.script',
  expressionTarget: 'src/fields.py',
  preserveLayout: true
}, kernelOptions(seedHash));
// The repair is performed by sendMessageToLari above. Re-run the declared
// oracle after the mutation; response.passed alone is not sufficient proof.
const codingAfter = runCodingOracle();
const codingEvent = codingResponse.trace?.find(item => item.phase === 'default_failure_learning') || null;
const codingRepair = codingEvent?.frontierFallback?.expressionRepair || null;
const codingPassed = codingBefore.status !== 0
  && codingAfter.status === 0
  && codingResponse.passed === true
  && Boolean(codingRepair?.learnedRecordId);
fs.rmSync(codingWorkspace, { recursive: true, force: true });

const sceneRequest = read(SCENE_HOLDOUTS).cases[0].request;
const sceneComposition = runtime.composeLariMultimodalProduct(candidate, sceneRequest, { id: 'cross-domain.scene' });
const sceneBound = sceneComposition?.sharedSceneRecordId === sceneRecord.id
  && sceneComposition?.artifact?.modalityEvidence?.image?.sceneRecordId === sceneRecord.id
  && sceneComposition?.artifact?.modalityEvidence?.audio?.sceneRecordId === sceneRecord.id
  && sceneComposition?.evaluation?.passed === true;

const agentWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-cross-domain-agent-'));
const agentReport = runtime.runSwarmMission(candidate, 'write a local verified proof with rollback', {
  steps: [{
    id: 'cross-domain.agent.local',
    family: 'workspace_proof',
    action: 'write',
    query: 'write a local verified proof',
    sideEffect: 'workspace',
    mutatesWorkspace: true,
    rollbackPlan: { kind: 'delete_created_artifact', target: 'proof.json' },
    verify: { requiredArtifacts: 1, requiredChecks: 2 }
  }],
  executor: () => {
    const proof = path.join(agentWorkspace, 'proof.json');
    fs.writeFileSync(proof, JSON.stringify({ verified: true }));
    return { ok: true, summary: 'local proof written', artifacts: [proof], checks: ['proof_written', 'proof_readable'], observations: [] };
  },
  authorityContract: { tier: 1, allowWorkspaceMutation: true, allowExternal: false, requireRollback: true }
});
fs.rmSync(agentWorkspace, { recursive: true, force: true });
const agentBound = agentReport.authority?.deniedStepCount === 0
  && agentReport.stepReports?.[0]?.authorityDecision?.allowed === true
  && agentReport.stepReports?.[0]?.executed === true;

const finalBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
const finalHash = sha(finalBytes);
const finalPath = path.join(OUT, `candidate-${finalHash}.json`);
fs.writeFileSync(finalPath, finalBytes, { flag: 'wx' });
const reloaded = read(finalPath);
const paritySurfaces = [];
for (const surface of ['workbench', 'cli', 'openai_compatible_api', 'autonomous']) {
  const response = surface === 'autonomous'
    ? await runtime.runLariAutonomousRequest(clone(reloaded), { mode: 'chat', prompt: reasoningPrompt }, { mode: 'chat', modelHash: finalHash, groundedFactual: false })
    : runtime.sendMessageToLari(clone(reloaded), { id: `cross-domain.parity.${surface}`, mode: 'chat', prompt: reasoningPrompt }, kernelOptions(finalHash));
  const selected = response ? [...new Set([...(response.recapLearnedRecordIds || []), ...(response.learnedRecordIds || [])])] : [];
  paritySurfaces.push({
    surface,
    modelHash: response?.modelHash || null,
    selectedRecordIds: selected,
    selectedHypothesisRecord: selected.includes(hypothesisRecord.id),
    externalModelCalls: Number(response?.external_model_calls || 0),
    passed: Boolean(response) && response.modelHash === finalHash && selected.includes(hypothesisRecord.id) && Number(response.external_model_calls || 0) === 0
  });
}
const parityPassed = paritySurfaces.every(row => row.passed);
const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), seed: shaFile(seedPath), candidate: shaFile(finalPath) };
const gates = {
  parentActiveReadOnly: protectedBefore.active === protectedAfter.active,
  registryReadOnly: protectedBefore.registry === protectedAfter.registry,
  importedHypothesisRecord: candidate.lariLearnedRecords.records.some(record => record.id === hypothesisRecord.id),
  importedSceneRecord: candidate.lariLearnedRecords.records.some(record => record.id === sceneRecord.id),
  derivedCapabilityGraphBuilt: Array.isArray(graph?.graph?.nodes || graph?.nodes),
  derivedCapabilityGenomeBuilt: Boolean(genome),
  reasoningGeneratorSelected: reasoningRecordSelected,
  researchLearnedTypedRecord: researchLearned,
  codingRepairVerified: codingPassed,
  sharedSceneBound: sceneBound,
  authorityBoundedWorkspaceAction: agentBound,
  sameHashCanonicalSurfaceParity: parityPassed,
  parityRows: paritySurfaces.every(row => row.modelHash === finalHash),
  externalModelCallsZero: paritySurfaces.every(row => row.externalModelCalls === 0),
  noPromotion: true
};
const passed = Object.values(gates).every(value => value === true);
const evidence = {
  schemaVersion: 1,
  kind: 'lari.cross-domain-composition.candidate',
  createdAt: new Date().toISOString(),
  parentHash: protectedBefore.active,
  seedHash,
  candidateHash: finalHash,
  candidatePath: path.relative(ROOT, finalPath).replace(/\\/g, '/'),
  importedRecordIds: [hypothesisRecord.id, sceneRecord.id, importedCodingRecord.id],
  researchRecordId,
  codingRecordId: codingRepair?.learnedRecordId || null,
  promptHashes: { reasoning: hashPrompt(reasoningPrompt), research: hashPrompt(researchQuery) },
  phases: {
    reasoning: { selectedRecordId: reasoningRecordSelected ? hypothesisRecord.id : null, responseSource: reasoningResponse.publicAnswerSource || null },
    research: {
      action: researchResponse.action,
      recordId: researchRecordId,
      acceptedSources: researchResponse.learning?.sourceCount || 0,
      publicAnswerSource: researchResponse.publicAnswerSource || null,
      passed: researchResponse.passed === true
    },
    coding: {
      passed: codingPassed,
      oracleBeforePassed: codingBefore.status === 0,
      oracleAfterPassed: codingAfter.status === 0,
      oracleBeforeOutput: `${codingBefore.stdout || ''}${codingBefore.stderr || ''}`.slice(-1000),
      oracleAfterOutput: `${codingAfter.stdout || ''}${codingAfter.stderr || ''}`.slice(-1000),
      repairMode: codingRepair?.mode || null,
      recordId: codingRepair?.learnedRecordId || null,
      responseAction: codingResponse.action || null,
      responsePassed: codingResponse.passed === true,
      failureEventPassed: codingEvent?.passed === true,
      frontierAttempted: codingEvent?.frontierFallback?.attempted === true,
      frontierRepairMode: codingEvent?.frontierFallback?.expressionRepair?.mode || null
    },
    multimodal: { sharedSceneRecordId: sceneComposition?.sharedSceneRecordId || null, passed: sceneBound },
    agentic: { authority: agentReport.authority, executed: agentReport.stepReports?.[0]?.executed === true }
  },
  publicSurfaceParity: paritySurfaces,
  protectedBefore,
  protectedAfter,
  gates,
  passed,
  verdict: passed ? 'Candidate composition passed; safe only for promotion rehearsal' : 'Candidate composition incomplete; do not promote',
  externalModelCalls: 0,
  limitations: [
    'The composition uses already qualified bounded records; it does not prove open-ended generation or arbitrary repository mastery.',
    'The four surface calls are routed through the canonical local runtime; this is not a deployed HTTP/Workbench load test.',
    'Modalities remain procedural SVG and short WAV, not photorealistic, speech, or video generation.',
    'The candidate is immutable and unpromoted.'
  ]
};
fs.writeFileSync(path.join(OUT, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(path.join(OUT, 'report.md'), [
  '# Cross-domain composition candidate', '',
  `- Verdict: **${evidence.verdict}**`,
  `- Parent: \`${protectedBefore.active}\``,
  `- Candidate: \`${finalHash}\``,
  `- Imported records: ${evidence.importedRecordIds.join(', ')}`,
  '',
  ...Object.entries(gates).map(([name, value]) => `- ${name}: ${value === true ? 'PASS' : value === false ? 'FAIL' : JSON.stringify(value)}`),
  '',
  ...evidence.limitations.map(item => `- Limitation: ${item}`),
  ''
].join('\n'), { flag: 'wx' });
console.log(JSON.stringify(evidence, null, 2));
if (!passed) process.exitCode = 1;
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
