#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

delete process.env.LARI_REGISTRY_ROOT;
delete process.env.LARI_MODEL_PATH;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
process.env.LARI_ALLOW_LEGACY_ROOT_MODEL = '0';

const registry = require('./lari_model_registry.js');
const runtime = require('../swarm_model_runtime.js');
const root = path.resolve(__dirname, '..');
const candidateHash = '06f2543c86eb60dbc20814a437fc1290d52a832c112046c9fbb37974cdc9a8a3';
const incumbentHash = '36bd9214e19a48aba996dad1ea2d09cd4d0cbae08302b35a23ff29e23948399d';
const candidatePath = path.join(root, 'consolidation', 'symbolic-pushdown-neurogenesis-20260908', 'candidates', `${candidateHash}.json`);
const qualificationPath = path.join(root, 'consolidation', 'symbolic-pushdown-neurogenesis-20260908', 'qualification.json');
const rehearsalPath = path.join(root, 'consolidation', 'symbolic-pushdown-neurogenesis-20260908', 'promotion-rehearsal', 'promotion-rehearsal-evidence.json');
const releasePath = path.join(root, 'consolidation', 'beta-readiness-20260908', 'release-gates.json');
const outputRoot = path.join(root, 'consolidation', 'symbolic-pushdown-production-promotion-20260908');
const preflightPath = path.join(outputRoot, 'preflight.json');
const manifestPath = path.join(outputRoot, 'promotion.json');
const activeBackupPath = path.join(outputRoot, 'backups', `sha256-${incumbentHash}.json`);
const recordIds = [
  'lari.learned.operator.neurogenesis.43112c0c7fa4f4697157',
  'lari.learned.operator.neurogenesis.4e667192b40c02f090a2'
];

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const relative = file => path.relative(root, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function preserve(source, target, expectedHash) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fs.readFileSync(source), { flag: 'wx' });
  assert(sha256(target) === expectedHash, 'Content-addressed backup hash mismatch.');
  return { path: relative(target), sha256: expectedHash, bytes: fs.statSync(target).size };
}

assert(registry.registryRoot === registry.defaultRegistryRoot, 'Real production registry was not selected.');
assert(!fs.existsSync(outputRoot), 'Production promotion namespace already exists; refusing a duplicate promotion.');
for (const file of [candidatePath, qualificationPath, rehearsalPath, releasePath, registry.currentModelPath, registry.registryPath]) {
  assert(fs.existsSync(file), `Missing promotion input: ${relative(file)}`);
}
assert(sha256(candidatePath) === candidateHash, 'Candidate hash mismatch.');
assert(sha256(registry.currentModelPath) === incumbentHash, 'Production incumbent changed after rehearsal.');

const qualification = read(qualificationPath);
const rehearsal = read(rehearsalPath);
const release = read(releasePath);
const candidate = read(candidatePath);
const candidateRecordIds = new Set((candidate.lariLearnedRecords?.records || []).map(record => record.id));
const preflightGates = {
  qualificationPassed: qualification.passed === true && Object.values(qualification.gates || {}).every(Boolean),
  qualificationHashExact: qualification.candidate?.sha256 === candidateHash,
  rehearsalPassed: Object.values(rehearsal.gates || {}).every(Boolean),
  rehearsalHashExact: rehearsal.candidate?.sha256 === candidateHash && rehearsal.candidateAfter === candidateHash,
  rehearsalProtectedProduction: rehearsal.realBefore?.current === incumbentHash && rehearsal.realAfter?.current === incumbentHash,
  completeReleaseChain: release.passed === true && release.gateContract?.passed === 39 && release.gateContract?.expected === 39,
  releaseHashExact: release.candidate?.sha256 === candidateHash,
  releaseReadOnly: release.gates?.activeReadOnly === true && release.gates?.registryReadOnly === true,
  learnedRecordsPresent: recordIds.every(id => candidateRecordIds.has(id)),
  noStoredBenchmarkAnswers: registry.countStoredBenchmarkAnswerMarkers(candidate) === 0
};
assert(Object.values(preflightGates).every(Boolean), `Promotion preflight failed: ${JSON.stringify(preflightGates)}`);

const registryHash = sha256(registry.registryPath);
const backup = preserve(registry.currentModelPath, activeBackupPath, incumbentHash);
writeExclusive(preflightPath, {
  schemaVersion: 1,
  kind: 'lari.symbolic-pushdown.production-preflight',
  createdAt: new Date().toISOString(),
  candidate: { path: relative(candidatePath), sha256: candidateHash },
  incumbent: { path: relative(registry.currentModelPath), sha256: incumbentHash },
  registry: { path: relative(registry.registryPath), sha256: registryHash },
  backup,
  evidence: [qualificationPath, rehearsalPath, releasePath].map(file => ({ path: relative(file), sha256: sha256(file) })),
  gates: preflightGates,
  passed: true
});

const promoted = registry.promoteLariModel(candidatePath, {
  stage: 'symbolic-predicate-pushdown-production-promotion',
  transaction: 'hash-locked-real-production-promotion',
  candidateHash,
  candidateProvenance: relative(candidatePath),
  lineageParentHash: qualification.parentCandidate?.sha256 || null,
  productionIncumbentHash: incumbentHash,
  learnedRecordIds: recordIds,
  qualificationManifest: relative(qualificationPath),
  rehearsalManifest: relative(rehearsalPath),
  releaseGateManifest: relative(releasePath),
  preflightManifest: relative(preflightPath),
  canonicalRuntime: 'sendMessageToLariAsync -> sendMessageToLari -> runLariUnifiedTaskKernel',
  ordinaryInferenceReadOnly: true,
  fallbackDiscoveryDisabled: true,
  externalModelCalls: 0
});

const activeHash = sha256(registry.currentModelPath);
const rollbackPath = path.resolve(root, promoted.previousModelPath);
const beforeInference = { active: activeHash, registry: sha256(registry.registryPath) };
const loaded = registry.loadLariModel();
const response = runtime.sendMessageToLari(clone(loaded.model), 'Replace each run of digits with one hash marker in text: `ab12-c345`', {
  modelHash: candidateHash,
  autoGrow: false,
  userScope: 'production-promotion-smoke',
  kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
});
const relation = response.languageUnderstanding?.semantics?.semanticRelations?.find(item => item.type === 'learned_text_transduction');
const afterInference = { active: sha256(registry.currentModelPath), registry: sha256(registry.registryPath) };
const immediateGates = {
  exactCandidateActivated: activeHash === candidateHash,
  registryManifestExact: read(registry.registryPath).activeModelSha256 === candidateHash,
  exactRollbackTarget: fs.existsSync(rollbackPath) && sha256(rollbackPath) === incumbentHash,
  contentAddressedBackupExact: sha256(activeBackupPath) === incumbentHash,
  bothRecordsPresent: recordIds.every(id => (loaded.model.lariLearnedRecords?.records || []).some(record => record.id === id)),
  ordinarySelectionExact: relation?.operatorRecordId === recordIds[0] && relation?.transformedText === 'ab#-c#',
  responseHashExact: response.modelHash === candidateHash,
  inferenceReadOnly: JSON.stringify(beforeInference) === JSON.stringify(afterInference),
  registryOnly: registry.resolveLariModelPath().source === 'registry' && registry.listLariModelCandidates().length === 1,
  externalModelCallsZero: Number(response.external_model_calls || 0) === 0
};
assert(Object.values(immediateGates).every(Boolean), `Immediate production validation failed: ${JSON.stringify(immediateGates)}`);

const manifest = {
  schemaVersion: 1,
  kind: 'lari.symbolic-pushdown.production-promotion',
  createdAt: new Date().toISOString(),
  passed: true,
  candidate: { path: relative(candidatePath), sha256: candidateHash },
  incumbent: { sha256: incumbentHash, registrySha256: registryHash },
  promoted: { activeSha256: activeHash, promotedAt: promoted.promotedAt, registrySha256: afterInference.registry },
  rollback: { targetSha256: incumbentHash, registryBackupPath: relative(rollbackPath), contentAddressedBackup: backup },
  inference: { answer: response.answer, learnedRecordIds: response.learnedRecordIds || [], modelHash: response.modelHash },
  preflightGates,
  immediateGates,
  externalModelCalls: 0
};
writeExclusive(manifestPath, manifest);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
