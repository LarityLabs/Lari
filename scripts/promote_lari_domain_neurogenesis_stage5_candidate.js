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
const CANDIDATE_HASH = '91713c42753f32df11df29db70acf78c55c7eb5e9530426913b7fe954eb4e80d';
const INCUMBENT_HASH = '172c07d0fb235720bfdcf11cfeb5d12bb2c8c2d9dd8c6264042cef1dbbec04f4';
const REGISTRY_HASH = '1634fd8f95fb1412516ca17abc3710a3946e23e4fa2b37f81b8f8b97c0cd9949';
const LEARNED_RECORD_ID = 'lari.learned.procedure.coordinated.1f3337c4';
const PARITY_RECORD_ID = 'lari.learned.procedure.neurogenesis.c6cd3f6d783e9fc0c9e0';
const CANDIDATE = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage5-20260830', 'candidates', `${CANDIDATE_HASH}.json`);
const QUALIFICATION = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage5-20260830', 'qualification-report.json');
const REHEARSAL = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage5-promotion-rehearsal-20260830', 'rehearsal-manifest.json');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage5-production-promotion-20260830');
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

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function preserve(source, target, expectedHash) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fs.readFileSync(source), { flag: 'wx' });
  assert(sha(target) === expectedHash, `Backup hash mismatch: ${rel(target)}`);
  return { path: rel(target), sha256: expectedHash, bytes: fs.statSync(target).size };
}

function state() {
  return { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
}

function tempFiles(directory) {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter(name => name.endsWith('.tmp') || /^\..+\.tmp$/.test(name))
    : [];
}

function rollback(error) {
  let result = null;
  if (fs.existsSync(ACTIVE_BACKUP) && fs.existsSync(registry.currentModelPath) && sha(registry.currentModelPath) === CANDIDATE_HASH) {
    const rolled = registry.promoteLariModel(ACTIVE_BACKUP, {
      transaction: 'automatic-rollback-domain-neurogenesis-stage5',
      rollback: true,
      rollbackTargetHash: INCUMBENT_HASH,
      rolledBackFromHash: CANDIDATE_HASH,
      externalModelCalls: 0
    });
    result = {
      activeHash: sha(registry.currentModelPath),
      exact: sha(registry.currentModelPath) === INCUMBENT_HASH,
      promotedAt: rolled.promotedAt
    };
  }
  if (!fs.existsSync(FAILURE)) {
    writeExclusive(FAILURE, {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      error: { message: error.message, stack: error.stack },
      rollback: result
    });
  }
  return result;
}

function main() {
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Real production registry was not selected.');
  assert(!fs.existsSync(OUT), 'Stage 5 production promotion namespace already exists.');
  [CANDIDATE, QUALIFICATION, REHEARSAL, registry.currentModelPath, registry.registryPath]
    .forEach(file => assert(fs.existsSync(file), `Missing ${rel(file)}`));
  assert(sha(CANDIDATE) === CANDIDATE_HASH, 'Candidate hash mismatch.');
  assert(sha(registry.currentModelPath) === INCUMBENT_HASH, 'Production incumbent hash changed.');
  assert(sha(registry.registryPath) === REGISTRY_HASH, 'Production registry hash changed.');
  assert(tempFiles(path.dirname(registry.currentModelPath)).length === 0, 'Temporary active-model files exist.');
  assert(tempFiles(path.dirname(registry.registryPath)).length === 0, 'Temporary registry files exist.');

  const qualification = read(QUALIFICATION);
  const rehearsal = read(REHEARSAL);
  const gates = {
    qualificationPassed: qualification.passed === true && Object.values(qualification.gates || {}).every(Boolean),
    exactQualifiedCandidate: qualification.candidate?.sha256 === CANDIDATE_HASH,
    hiddenTransferFourOfFour: qualification.gates?.hiddenRepositoriesFourOfFour === true,
    reloadFourOfFour: qualification.gates?.reloadFourOfFour === true,
    exactRecordAblationFourOfFour: qualification.gates?.exactRecordAblationFourOfFour === true,
    twoFileReuseFourOfFour: qualification.gates?.twoFileProcedureFourOfFour === true,
    zeroFamilyRegressions: qualification.gates?.priorStage4FourOfFour === true
      && qualification.gates?.priorStage3FourOfFour === true
      && qualification.gates?.priorStage2TwelveOfTwelve === true
      && qualification.gates?.priorRecapSevenOfSeven === true,
    rehearsalSafe: rehearsal.passed === true
      && rehearsal.verdict === 'Safe for real promotion'
      && Object.values(rehearsal.gates || {}).every(Boolean),
    exactRehearsedCandidate: rehearsal.candidate?.sha256 === CANDIDATE_HASH,
    externalModelCallsZero: Number(qualification.externalModelCalls || 0) === 0
  };
  assert(Object.values(gates).every(Boolean), `Preflight gates failed: ${JSON.stringify(gates)}`);

  const backups = {
    active: preserve(registry.currentModelPath, ACTIVE_BACKUP, INCUMBENT_HASH),
    registry: preserve(registry.registryPath, REGISTRY_BACKUP, REGISTRY_HASH)
  };
  writeExclusive(PREFLIGHT, {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis-stage5.production-preflight',
    createdAt: new Date().toISOString(),
    candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH, bytes: fs.statSync(CANDIDATE).size },
    incumbent: { path: rel(registry.currentModelPath), sha256: INCUMBENT_HASH },
    registry: { path: rel(registry.registryPath), sha256: REGISTRY_HASH },
    backups,
    evidence: [QUALIFICATION, REHEARSAL].map(file => ({ path: rel(file), sha256: sha(file) })),
    gates,
    passed: true
  });

  try {
    const promoted = registry.promoteLariModel(CANDIDATE, {
      stage: 'domain-neurogenesis-stage5-production-promotion',
      transaction: 'hash-locked-real-production-promotion',
      candidateHash: CANDIDATE_HASH,
      candidateProvenance: rel(CANDIDATE),
      productionIncumbentHash: INCUMBENT_HASH,
      preflightManifest: rel(PREFLIGHT),
      preflightManifestHash: sha(PREFLIGHT),
      rehearsalManifest: rel(REHEARSAL),
      rehearsalManifestHash: sha(REHEARSAL),
      learnedRecordId: LEARNED_RECORD_ID,
      canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
      ordinaryInferenceReadOnly: true,
      fallbackDiscoveryDisabled: true,
      externalModelCalls: 0
    });
    const afterPromotion = state();
    const rollbackPath = path.resolve(ROOT, promoted.previousModelPath);
    const beforeInference = state();
    const loaded = registry.loadLariModel();
    const response = runtime.sendMessageToLari(clone(loaded.model), 'Triage evidence for the reliability claim.', {
      modelHash: CANDIDATE_HASH,
      autoGrow: false,
      userScope: 'production-promotion-smoke',
      kernel: {
        useBenchmarkSystem: false,
        useCapabilityGraph: true,
        capabilityGraph: { minScore: 0 },
        chat: { minMemoryScore: 0, minRouteScore: 0 }
      }
    });
    const afterInference = state();
    const resolved = registry.resolveLariModelPath();
    const candidates = registry.listLariModelCandidates();
    const recordIds = (response.learnedRecordIds || []).map(String);
    const modelRecordIds = new Set((loaded.model.lariLearnedRecords?.records || []).map(record => record.id));
    const immediate = {
      exactCandidateActivated: afterPromotion.active === CANDIDATE_HASH,
      registryManifestExact: read(registry.registryPath).activeModelSha256 === CANDIDATE_HASH,
      exactRollbackTarget: fs.existsSync(rollbackPath) && sha(rollbackPath) === INCUMBENT_HASH,
      contentAddressedBackupsExact: sha(ACTIVE_BACKUP) === INCUMBENT_HASH && sha(REGISTRY_BACKUP) === REGISTRY_HASH,
      candidateProvenanceExact: promoted.metadata?.candidateProvenance === rel(CANDIDATE),
      learnedProcedurePresent: modelRecordIds.has(LEARNED_RECORD_ID),
      ordinaryCanonicalRecordSelected: recordIds.includes(PARITY_RECORD_ID),
      ordinaryResponseHashExact: response.modelHash === CANDIDATE_HASH,
      registryOnly: resolved.source === 'registry' && candidates.length === 1 && candidates[0].id === 'canonical-current',
      inferenceReadOnly: JSON.stringify(beforeInference) === JSON.stringify(afterInference),
      noTemporaryFiles: tempFiles(path.dirname(registry.currentModelPath)).length === 0
        && tempFiles(path.dirname(registry.registryPath)).length === 0,
      externalModelCallsZero: Number(response.external_model_calls || 0) === 0
    };
    assert(Object.values(immediate).every(Boolean), `Immediate production validation failed: ${JSON.stringify(immediate)}`);
    const manifest = {
      schemaVersion: 1,
      kind: 'lari.domain-neurogenesis-stage5.production-promotion',
      createdAt: new Date().toISOString(),
      passed: true,
      candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH },
      incumbent: { sha256: INCUMBENT_HASH, registrySha256: REGISTRY_HASH },
      promoted: {
        activePath: rel(registry.currentModelPath),
        activeSha256: afterPromotion.active,
        registryPath: rel(registry.registryPath),
        registrySha256: afterPromotion.registry,
        promotedAt: promoted.promotedAt
      },
      rollback: {
        registryBackupPath: rel(rollbackPath),
        registryBackupSha256: sha(rollbackPath),
        contentAddressedBackups: backups
      },
      inference: {
        answer: response.answer,
        learnedRecordIds: recordIds,
        modelHash: response.modelHash,
        publicAnswerSource: response.publicAnswerSource,
        readOnly: immediate.inferenceReadOnly
      },
      preflightGates: gates,
      immediateGates: immediate,
      status: 'promotion_succeeded',
      externalModelCalls: 0
    };
    writeExclusive(MANIFEST, manifest);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const result = rollback(error);
    if (result) assert(result.exact, 'Automatic rollback was not exact.');
    throw error;
  }
}

main();
