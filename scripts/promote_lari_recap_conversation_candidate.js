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
const ROOT = path.resolve(__dirname, '..');
const CANDIDATE_HASH = '172c07d0fb235720bfdcf11cfeb5d12bb2c8c2d9dd8c6264042cef1dbbec04f4';
const INCUMBENT_HASH = '3b1832fac4a23f4ea616c3e8cca1c59c9fe8d68820775c200bad417b24e81fbb';
const REGISTRY_HASH = 'eae4c34976e98476535a34ba9b7a0d24b76b9c8f6d0a16be86a3e7032d4e11f8';
const CANDIDATE = path.join(ROOT, 'consolidation', 'recap-conversation-expansion-20260830', 'candidates', `${CANDIDATE_HASH}.json`);
const VALIDATION = path.join(ROOT, 'consolidation', 'recap-conversation-expansion-20260830', 'candidate-validation-v3.json');
const SURFACES = path.join(ROOT, 'consolidation', 'recap-conversation-expansion-20260830', 'surface-parity-v2.json');
const MASTERY = path.join(ROOT, 'consolidation', 'recap-conversation-mastery-qualification-20260830', 'qualification-evidence.json');
const OUT = path.join(ROOT, 'consolidation', 'recap-conversation-production-promotion-v2-20260830');
const PREFLIGHT = path.join(OUT, 'preflight-manifest.json');
const MANIFEST = path.join(OUT, 'production-promotion-manifest.json');
const FAILURE = path.join(OUT, 'production-promotion-failure.json');
const ACTIVE_BACKUP = path.join(OUT, 'backups', `sha256-${INCUMBENT_HASH}.json`);
const REGISTRY_BACKUP = path.join(OUT, 'backups', `registry-sha256-${REGISTRY_HASH}.json`);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
function writeExclusive(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }
function preserve(source, target, expected) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, fs.readFileSync(source), { flag: 'wx' }); assert(sha(target) === expected, `Backup hash mismatch: ${rel(target)}`); return { path: rel(target), sha256: expected, bytes: fs.statSync(target).size }; }
function state() { return { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) }; }

function rollback(error) {
  let result = null;
  if (fs.existsSync(ACTIVE_BACKUP) && fs.existsSync(registry.currentModelPath) && sha(registry.currentModelPath) === CANDIDATE_HASH) {
    const rolled = registry.promoteLariModel(ACTIVE_BACKUP, { transaction: 'automatic-rollback-recap-conversation', rollback: true, rollbackTargetHash: INCUMBENT_HASH, rolledBackFromHash: CANDIDATE_HASH, externalModelCalls: 0 });
    result = { activeHash: sha(registry.currentModelPath), exact: sha(registry.currentModelPath) === INCUMBENT_HASH, promotedAt: rolled.promotedAt };
  }
  if (!fs.existsSync(FAILURE)) writeExclusive(FAILURE, { schemaVersion: 1, createdAt: new Date().toISOString(), error: { message: error.message, stack: error.stack }, rollback: result });
  return result;
}

function runProbe(model, prompt, family, expectedCount) {
  const response = runtime.sendMessageToLari(clone(model), prompt, {
    modelHash: CANDIDATE_HASH,
    autoGrow: false,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
  const ids = (response.learnedRecordIds || []).filter(id => String(id).startsWith('lari.learned.generator.recap.'));
  return {
    family,
    answer: response.answer,
    modelHash: response.modelHash,
    source: response.publicAnswerSource,
    learnedRecordIds: ids,
    passed: response.passed === true && response.modelHash === CANDIDATE_HASH && response.publicAnswerSource === 'recap_executable_language' && response.recapTrace?.meaningGraph?.family === family && response.recapTrace?.verification?.passed === true && ids.length === expectedCount && Number(response.external_model_calls || 0) === 0
  };
}

function main() {
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Real registry was not selected.');
  assert(!fs.existsSync(OUT), 'Conversation promotion namespace already exists.');
  [CANDIDATE, VALIDATION, SURFACES, MASTERY, registry.currentModelPath, registry.registryPath].forEach(file => assert(fs.existsSync(file), `Missing ${rel(file)}`));
  assert(sha(CANDIDATE) === CANDIDATE_HASH, 'Candidate hash mismatch.');
  assert(sha(registry.currentModelPath) === INCUMBENT_HASH, 'Production incumbent changed.');
  assert(sha(registry.registryPath) === REGISTRY_HASH, 'Production registry changed.');
  const validation = read(VALIDATION), surfaces = read(SURFACES), mastery = read(MASTERY);
  const gates = {
    sealedCandidateValidation: validation.passed === true && Object.values(validation.gates || {}).every(Boolean),
    trainingSixOfSix: validation.gates?.trainSixOfSix === true,
    hiddenTwelveOfTwelve: validation.gates?.hiddenTwelveOfTwelve === true,
    exactRecordAblation32Of32: validation.gates?.causalAblationAllNewRecords === true && validation.learnedRecordIds?.length === 32,
    reloadTwelveOfTwelve: validation.gates?.reloadTwelveOfTwelve === true,
    exactFiveSurfaceParity: surfaces.passed === true && surfaces.rows?.length === 12 && Object.values(surfaces.gates || {}).every(Boolean),
    isolatedPromotionAndRollback: mastery.passed === true && mastery.gates?.exactCandidateHash === true && mastery.gates?.rollbackRestoresExactIncumbent === true,
    hiddenTransfer17Of17: mastery.gates?.hiddenTransfer17Of17 === true,
    zeroFamilyRegressions: mastery.gates?.zeroFamilyRegressions === true,
    noSilentFallback: mastery.gates?.noSilentFallback === true,
    noHiddenWrites: mastery.gates?.noHiddenModelWrites === true && mastery.gates?.realStateReadOnly === true,
    externalModelCallsZero: validation.gates?.externalModelCallsZero === true && surfaces.gates?.externalModelCallsZero === true && mastery.gates?.externalModelCallsZero === true
  };
  assert(Object.values(gates).every(Boolean), `Preflight gates failed: ${JSON.stringify(gates)}`);
  const backups = { active: preserve(registry.currentModelPath, ACTIVE_BACKUP, INCUMBENT_HASH), registry: preserve(registry.registryPath, REGISTRY_BACKUP, REGISTRY_HASH) };
  writeExclusive(PREFLIGHT, { schemaVersion: 1, kind: 'lari.recap-conversation.production-preflight', createdAt: new Date().toISOString(), candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH, bytes: fs.statSync(CANDIDATE).size }, incumbent: { path: rel(registry.currentModelPath), sha256: INCUMBENT_HASH }, registry: { path: rel(registry.registryPath), sha256: REGISTRY_HASH }, backups, evidence: [VALIDATION, SURFACES, MASTERY].map(file => ({ path: rel(file), sha256: sha(file) })), gates, passed: true });
  try {
    const promoted = registry.promoteLariModel(CANDIDATE, { stage: 'recap-conversation-production-promotion', transaction: 'hash-locked-real-production-promotion', candidateHash: CANDIDATE_HASH, candidateProvenance: rel(CANDIDATE), productionIncumbentHash: INCUMBENT_HASH, preflightManifest: rel(PREFLIGHT), preflightManifestHash: sha(PREFLIGHT), canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel', ordinaryInferenceReadOnly: true, fallbackDiscoveryDisabled: true, externalModelCalls: 0 });
    const afterPromotion = state();
    const rollbackPath = path.resolve(ROOT, promoted.previousModelPath);
    const beforeInference = state();
    const loaded = registry.loadLariModel();
    const probes = [
      runProbe(loaded.model, 'Make a plan for learning a new codebase safely.', 'practical_planning', 5),
      runProbe(loaded.model, 'I said archive the candidate, not delete the model.', 'correction_repair', 5)
    ];
    const afterInference = state();
    const resolved = registry.resolveLariModelPath();
    const candidates = registry.listLariModelCandidates();
    const immediate = {
      exactCandidateActivated: afterPromotion.active === CANDIDATE_HASH,
      registryManifestExact: read(registry.registryPath).activeModelSha256 === CANDIDATE_HASH,
      exactRollbackTarget: fs.existsSync(rollbackPath) && sha(rollbackPath) === INCUMBENT_HASH,
      contentAddressedBackupsExact: sha(ACTIVE_BACKUP) === INCUMBENT_HASH && sha(REGISTRY_BACKUP) === REGISTRY_HASH,
      candidateProvenanceExact: promoted.metadata?.candidateProvenance === rel(CANDIDATE),
      registryOnly: resolved.source === 'registry' && candidates.length === 1 && candidates[0].id === 'canonical-current',
      conversationFamiliesActive: probes.every(probe => probe.passed),
      inferenceReadOnly: JSON.stringify(beforeInference) === JSON.stringify(afterInference),
      externalModelCallsZero: probes.every(probe => probe.passed)
    };
    assert(Object.values(immediate).every(Boolean), `Immediate production validation failed: ${JSON.stringify(immediate)}`);
    const manifest = { schemaVersion: 1, kind: 'lari.recap-conversation.production-promotion', createdAt: new Date().toISOString(), passed: true, candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH }, incumbent: { sha256: INCUMBENT_HASH, registrySha256: REGISTRY_HASH }, promoted: { activePath: rel(registry.currentModelPath), activeSha256: afterPromotion.active, registryPath: rel(registry.registryPath), registrySha256: afterPromotion.registry, promotedAt: promoted.promotedAt }, rollback: { registryBackupPath: rel(rollbackPath), registryBackupSha256: sha(rollbackPath), contentAddressedBackups: backups }, inference: { probes, readOnly: immediate.inferenceReadOnly }, preflightGates: gates, immediateGates: immediate, status: 'promotion_succeeded', externalModelCalls: 0 };
    writeExclusive(MANIFEST, manifest);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const result = rollback(error);
    if (result) assert(result.exact, 'Automatic rollback was not exact.');
    throw error;
  }
}

main();
