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
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'case-identity-production-promotion-20260907');
const CANDIDATE = path.join(ROOT, 'consolidation', 'research-to-executable-repair-acquisition-20260906', 'sphinx-7440-research-required-attempt-6', 'candidates', '44b209ab89d29e05cb743361020c7060498cf737113cba9356594d2274ed549b.json');
const REHEARSAL = path.join(ROOT, 'consolidation', 'case-identity-cross-repo-qualification-20260907', 'PROMOTION_REHEARSAL_FINAL.json');
const CANDIDATE_HASH = '44b209ab89d29e05cb743361020c7060498cf737113cba9356594d2274ed549b';
const INCUMBENT_HASH = 'beb2db6daa870dc134781ff9135247b942d3c578951b6fe90eacd03fbe9fca15';
const REGISTRY_HASH = 'ebd5771fb4a9ea510032a74450ae49d54cc11cbd7c4140f55440f8b3ca1e5767';
const REHEARSAL_HASH = '7a2778396f0980855552bebea9fda5d5d449a901eb25b7cd721e1c42c97cd5f3';

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (value, message) => { if (!value) throw new Error(message); };
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const tempFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.tmp') || /^\..+\.tmp$/.test(name)) : [];

function main() {
  assert(!fs.existsSync(OUT), `Refusing to overwrite ${rel(OUT)}`);
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Real registry root is not selected.');
  assert(sha(CANDIDATE) === CANDIDATE_HASH, 'Candidate hash drifted.');
  assert(sha(REHEARSAL) === REHEARSAL_HASH, 'Rehearsal evidence hash drifted.');
  const rehearsal = JSON.parse(fs.readFileSync(REHEARSAL, 'utf8'));
  assert(rehearsal.passed === true && rehearsal.verdict === 'Safe for real promotion', 'Final rehearsal is not green.');
  assert(Object.values(rehearsal.gates || {}).every(Boolean), 'Final rehearsal contains a failed gate.');
  assert(sha(registry.currentModelPath) === INCUMBENT_HASH, 'Production incumbent hash drifted.');
  assert(sha(registry.registryPath) === REGISTRY_HASH, 'Production registry hash drifted.');
  assert(tempFiles(path.dirname(registry.currentModelPath)).length === 0, 'Active namespace contains temporary files.');
  assert(tempFiles(path.dirname(registry.registryPath)).length === 0, 'Registry namespace contains temporary files.');

  fs.mkdirSync(path.join(OUT, 'backups'), { recursive: true });
  const activeBackup = path.join(OUT, 'backups', `sha256-${INCUMBENT_HASH}.json`);
  const registryBackup = path.join(OUT, 'backups', `registry-sha256-${REGISTRY_HASH}.json`);
  fs.copyFileSync(registry.currentModelPath, activeBackup, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(registry.registryPath, registryBackup, fs.constants.COPYFILE_EXCL);
  const backupManifest = {
    schemaVersion: 1,
    kind: 'lari.case_identity.pre_promotion_backup',
    createdAt: new Date().toISOString(),
    active: { source: rel(registry.currentModelPath), backup: rel(activeBackup), sha256: sha(activeBackup), size: fs.statSync(activeBackup).size },
    registry: { source: rel(registry.registryPath), backup: rel(registryBackup), sha256: sha(registryBackup), size: fs.statSync(registryBackup).size },
    candidate: { path: rel(CANDIDATE), sha256: sha(CANDIDATE), size: fs.statSync(CANDIDATE).size },
    rehearsal: { path: rel(REHEARSAL), sha256: sha(REHEARSAL) }
  };
  writeJson(path.join(OUT, 'pre-promotion-backup-manifest.json'), backupManifest);

  let promoted;
  try {
    promoted = registry.promoteLariModel(CANDIDATE, {
      stage: 'case-identity-production-promotion',
      transaction: 'hash-locked-real-production-promotion',
      candidateHash: CANDIDATE_HASH,
      candidateProvenance: rel(CANDIDATE),
      lineageParentHash: INCUMBENT_HASH,
      learnedRecordId: 'lari.learned.operator.semantic_mutation.1815a0cbc37ff663',
      rehearsalManifest: rel(REHEARSAL),
      rehearsalManifestHash: REHEARSAL_HASH,
      canonicalRuntime: 'sendMessageToLariAsync -> sendMessageToLari -> runLariUnifiedTaskKernel',
      ordinaryInferenceReadOnly: true,
      fallbackDiscoveryDisabled: true,
      externalModelCalls: 0
    });

    const rollbackPath = path.resolve(ROOT, promoted.previousModelPath);
    const candidates = registry.listLariModelCandidates();
    const resolution = registry.resolveLariModelPath();
    const gates = {
      exactCandidateActivated: sha(registry.currentModelPath) === CANDIDATE_HASH,
      rollbackTargetExact: fs.existsSync(rollbackPath) && sha(rollbackPath) === INCUMBENT_HASH,
      contentAddressedBackupExact: sha(activeBackup) === INCUMBENT_HASH && sha(registryBackup) === REGISTRY_HASH,
      lineageParentExact: promoted.metadata?.lineageParentHash === INCUMBENT_HASH,
      candidateProvenanceExact: promoted.metadata?.candidateProvenance === rel(CANDIDATE),
      rehearsalHashExact: promoted.metadata?.rehearsalManifestHash === REHEARSAL_HASH,
      registryResolutionOnly: resolution.source === 'registry' && path.resolve(resolution.path) === registry.currentModelPath,
      noFallbackCandidates: candidates.length === 1 && candidates[0].id === 'canonical-current',
      noTemporaryFiles: tempFiles(path.dirname(registry.currentModelPath)).length === 0 && tempFiles(path.dirname(registry.registryPath)).length === 0
    };
    assert(Object.values(gates).every(Boolean), `Immediate promotion gate failed: ${JSON.stringify(gates)}`);
    const manifest = {
      schemaVersion: 1,
      kind: 'lari.case_identity.production_promotion',
      createdAt: new Date().toISOString(),
      candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH },
      incumbent: { sha256: INCUMBENT_HASH, registrySha256: REGISTRY_HASH },
      promoted: { path: rel(registry.currentModelPath), sha256: sha(registry.currentModelPath), registrySha256: sha(registry.registryPath), promotedAt: promoted.promotedAt },
      rollback: { path: rel(rollbackPath), sha256: sha(rollbackPath) },
      backupManifest: rel(path.join(OUT, 'pre-promotion-backup-manifest.json')),
      gates,
      externalModelCalls: 0,
      status: 'promotion_succeeded'
    };
    writeJson(path.join(OUT, 'production-promotion-manifest.json'), manifest);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    if (promoted && fs.existsSync(activeBackup)) {
      registry.promoteLariModel(activeBackup, {
        transaction: 'automatic-rollback-case-identity-promotion',
        rollback: true,
        rollbackTargetHash: INCUMBENT_HASH,
        rolledBackFromHash: CANDIDATE_HASH,
        externalModelCalls: 0
      });
    }
    throw error;
  }
}

main();
