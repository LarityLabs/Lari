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
const CANDIDATE_HASH = '6b0099f28d6c4d879fc5ea3b8d43994d8df199ef5a8e5cd68ee6592bec36369b';
const INCUMBENT_HASH = '8e9e0003332ea03b383081410b06ddf670bbf7e0658996a7e5e95d9a17f907df';
const REGISTRY_HASH = '15af1e92b2ec9876c9bc6c2a5a8f1ec735d121941e474a90700c207d8e2e5cfb';
const CANDIDATE = path.join(ROOT, 'consolidation', 'deep-coding-qualification-v3-20260829', 'candidates', `${CANDIDATE_HASH}.json`);
const MANIFEST_INPUT = path.join(ROOT, 'consolidation', 'deep-coding-qualification-v3-20260829', 'combined-candidate-manifest.json');
const CODING = path.join(ROOT, 'consolidation', 'deep-coding-qualification-v3-20260829', 'qualification-report.json');
const CHAT = path.join(ROOT, 'consolidation', 'deep-coding-qualification-v3-20260829', 'five-surface-chat-evidence-v2.json');
const REHEARSAL = path.join(ROOT, 'consolidation', 'deep-combined-qualification-20260830', 'qualification-evidence.json');
const OUT = path.join(ROOT, 'consolidation', 'deep-combined-production-promotion-v2-20260830');
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
    const rolled = registry.promoteLariModel(ACTIVE_BACKUP, { transaction: 'automatic-rollback-deep-combined', rollback: true, rollbackTargetHash: INCUMBENT_HASH, rolledBackFromHash: CANDIDATE_HASH, externalModelCalls: 0 });
    result = { activeHash: sha(registry.currentModelPath), exact: sha(registry.currentModelPath) === INCUMBENT_HASH, promotedAt: rolled.promotedAt };
  }
  if (!fs.existsSync(FAILURE)) writeExclusive(FAILURE, { schemaVersion: 1, createdAt: new Date().toISOString(), error: { message: error.message, stack: error.stack }, rollback: result });
  return result;
}

function main() {
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Real registry was not selected.');
  assert(!fs.existsSync(OUT), 'Promotion namespace already exists.');
  [CANDIDATE, MANIFEST_INPUT, CODING, CHAT, REHEARSAL, registry.currentModelPath, registry.registryPath].forEach(file => assert(fs.existsSync(file), `Missing ${rel(file)}`));
  assert(sha(CANDIDATE) === CANDIDATE_HASH, 'Candidate hash mismatch.');
  assert(sha(registry.currentModelPath) === INCUMBENT_HASH, 'Production incumbent changed.');
  assert(sha(registry.registryPath) === REGISTRY_HASH, 'Production registry changed.');
  const combined = read(MANIFEST_INPUT), coding = read(CODING), chat = read(CHAT), rehearsal = read(REHEARSAL);
  const gates = {
    exactCandidate: combined.candidate?.sha256 === CANDIDATE_HASH,
    codingTwelveOfTwelve: coding.passed === true && coding.score === '12/12' && Object.values(coding.gates || {}).every(Boolean),
    chatSixteenOfSixteenFiveSurface: chat.passed === true && chat.rows?.length === 16 && Object.values(chat.gates || {}).every(Boolean),
    isolatedPromotionAndRollback: rehearsal.passed === true && rehearsal.gates?.exactCandidateHash === true && rehearsal.gates?.rollbackRestoresExactIncumbent === true,
    hiddenTransfer17Of17: rehearsal.gates?.hiddenTransfer17Of17 === true,
    zeroFamilyRegressions: rehearsal.gates?.zeroFamilyRegressions === true,
    noSilentFallback: rehearsal.gates?.noSilentFallback === true,
    noHiddenWrites: rehearsal.gates?.noHiddenModelWrites === true && rehearsal.gates?.realStateReadOnly === true,
    externalModelCallsZero: coding.gates?.externalModelCallsZero === true && chat.gates?.externalModelCallsZero === true && rehearsal.gates?.externalModelCallsZero === true
  };
  assert(Object.values(gates).every(Boolean), `Preflight gates failed: ${JSON.stringify(gates)}`);
  const backups = { active: preserve(registry.currentModelPath, ACTIVE_BACKUP, INCUMBENT_HASH), registry: preserve(registry.registryPath, REGISTRY_BACKUP, REGISTRY_HASH) };
  writeExclusive(PREFLIGHT, { schemaVersion: 1, kind: 'lari.deep-combined.production-preflight', createdAt: new Date().toISOString(), candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH, bytes: fs.statSync(CANDIDATE).size }, incumbent: { path: rel(registry.currentModelPath), sha256: INCUMBENT_HASH }, registry: { path: rel(registry.registryPath), sha256: REGISTRY_HASH }, backups, evidence: [MANIFEST_INPUT, CODING, CHAT, REHEARSAL].map(file => ({ path: rel(file), sha256: sha(file) })), gates, passed: true });
  try {
    const promoted = registry.promoteLariModel(CANDIDATE, { stage: 'deep-chat-coding-production-promotion', transaction: 'hash-locked-real-production-promotion', candidateHash: CANDIDATE_HASH, candidateProvenance: rel(CANDIDATE), productionIncumbentHash: INCUMBENT_HASH, preflightManifest: rel(PREFLIGHT), preflightManifestHash: sha(PREFLIGHT), canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel', ordinaryInferenceReadOnly: true, fallbackDiscoveryDisabled: true, externalModelCalls: 0 });
    const afterPromotion = state();
    const rollbackPath = path.resolve(ROOT, promoted.previousModelPath);
    const beforeInference = state();
    const loaded = registry.loadLariModel();
    const response = runtime.sendMessageToLari(clone(loaded.model), 'Tell me what this symptom establishes, what remains unknown, and how to verify the leading inference.', { modelHash: CANDIDATE_HASH, autoGrow: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });
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
      technicalChatActive: response.passed === true && response.modelHash === CANDIDATE_HASH && response.learnedRecordIds?.includes('lari.learned.procedure.chat.technical.evidence_uncertainty'),
      inferenceReadOnly: JSON.stringify(beforeInference) === JSON.stringify(afterInference),
      externalModelCallsZero: Number(response.external_model_calls || 0) === 0
    };
    assert(Object.values(immediate).every(Boolean), `Immediate production validation failed: ${JSON.stringify(immediate)}`);
    const manifest = { schemaVersion: 1, kind: 'lari.deep-combined.production-promotion', createdAt: new Date().toISOString(), passed: true, candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH }, incumbent: { sha256: INCUMBENT_HASH, registrySha256: REGISTRY_HASH }, promoted: { activePath: rel(registry.currentModelPath), activeSha256: afterPromotion.active, registryPath: rel(registry.registryPath), registrySha256: afterPromotion.registry, promotedAt: promoted.promotedAt }, rollback: { registryBackupPath: rel(rollbackPath), registryBackupSha256: sha(rollbackPath), contentAddressedBackups: backups }, inference: { learnedRecordIds: response.learnedRecordIds, modelHash: response.modelHash, readOnly: immediate.inferenceReadOnly }, preflightGates: gates, immediateGates: immediate, status: 'promotion_succeeded', externalModelCalls: 0 };
    writeExclusive(MANIFEST, manifest);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const result = rollback(error);
    if (result) assert(result.exact, 'Automatic rollback was not exact.');
    throw error;
  }
}

main();
