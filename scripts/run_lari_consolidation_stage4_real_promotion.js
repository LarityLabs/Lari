#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

delete process.env.LARI_REGISTRY_ROOT;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';

const registry = require('./lari_model_registry.js');
const root = path.resolve(__dirname, '..');
const consolidation = path.join(root, 'consolidation');
const candidatePath = path.join(consolidation, 'stage-2-unified-candidate.json');
const rehearsalPath = path.join(consolidation, 'stage-3-rehearsal-manifest.json');
const outputPath = path.join(consolidation, 'stage-4-real-promotion-manifest.json');
const expectedCandidateHash = '963aa947dff519f91c72768ec349185c140eca6b0995562a45566bb32191a273';
const expectedIncumbentHash = 'eb212812e962ba5f43e65b6219a94ccd62fbbdb4535a862987823e6e74911a50';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tempFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.tmp') || /^\..+\.tmp$/.test(name));
}

function main() {
  assert(!fs.existsSync(outputPath), 'Stage 4 promotion manifest already exists; refusing to repeat production promotion.');
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Production promotion resolved a non-production registry root.');
  assert(fs.existsSync(candidatePath), 'Stage 2 candidate is missing.');
  assert(fs.existsSync(rehearsalPath), 'Stage 3 rehearsal manifest is missing.');
  assert(fs.existsSync(registry.currentModelPath), 'Production incumbent is missing.');
  const rehearsal = JSON.parse(fs.readFileSync(rehearsalPath, 'utf8'));
  const candidateHash = sha256(candidatePath);
  const incumbentHash = sha256(registry.currentModelPath);
  assert(candidateHash === expectedCandidateHash, `Candidate hash mismatch: ${candidateHash}`);
  assert(incumbentHash === expectedIncumbentHash, `Incumbent hash mismatch: ${incumbentHash}`);
  assert(rehearsal.verdict === 'Safe for real promotion', `Stage 3 verdict is ${rehearsal.verdict}`);
  assert(Object.values(rehearsal.gates || {}).every(Boolean), 'A Stage 3 rehearsal gate is not passing.');
  assert(tempFiles(path.dirname(registry.currentModelPath)).length === 0, 'Temporary files exist in the active namespace before promotion.');
  assert(tempFiles(path.dirname(registry.registryPath)).length === 0, 'Temporary files exist in the registry namespace before promotion.');

  const beforeRegistryHash = sha256(registry.registryPath);
  const promoted = registry.promoteLariModel(candidatePath, {
    stage: 4,
    transaction: 'real-production-promotion',
    candidateHash,
    candidateProvenance: 'consolidation/stage-2-unified-candidate.json',
    lineageParentHash: incumbentHash,
    rehearsalManifest: 'consolidation/stage-3-rehearsal-manifest.json',
    rehearsalManifestHash: sha256(rehearsalPath),
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    ordinaryInferenceReadOnly: true,
    fallbackDiscoveryDisabled: true
  });

  const activeHash = sha256(registry.currentModelPath);
  const registryHash = sha256(registry.registryPath);
  const rollbackPath = path.resolve(root, promoted.previousModelPath);
  const rollbackHash = sha256(rollbackPath);
  const candidates = registry.listLariModelCandidates();
  const resolution = registry.resolveLariModelPath();
  const noTemps = tempFiles(path.dirname(registry.currentModelPath)).length === 0
    && tempFiles(path.dirname(registry.registryPath)).length === 0;
  const gates = {
    exactCandidateActivated: activeHash === expectedCandidateHash,
    rollbackTargetExact: rollbackHash === expectedIncumbentHash,
    lineageParentExact: promoted.metadata?.lineageParentHash === expectedIncumbentHash,
    candidateProvenanceExact: promoted.metadata?.candidateProvenance === 'consolidation/stage-2-unified-candidate.json',
    backupPointerExact: promoted.previousModelPath === relative(rollbackPath),
    registryResolutionOnly: resolution.source === 'registry' && path.resolve(resolution.path) === registry.currentModelPath,
    fallbackDiscoveryDisabled: candidates.length === 1 && candidates[0].id === 'canonical-current',
    noTemporaryFiles: noTemps,
    rollbackReadable: JSON.parse(fs.readFileSync(rollbackPath, 'utf8')).modelId === 'lari-local-model'
  };
  assert(Object.values(gates).every(Boolean), `Post-promotion gate failed: ${JSON.stringify(gates)}`);

  const manifest = {
    schemaVersion: 1,
    stage: 4,
    phase: 'real-promotion',
    createdAt: new Date().toISOString(),
    productionRegistryRoot: relative(registry.registryRoot),
    candidate: { path: relative(candidatePath), sha256: candidateHash },
    incumbent: { activeSha256: incumbentHash, registrySha256: beforeRegistryHash },
    promoted: {
      activeModelPath: relative(registry.currentModelPath),
      activeSha256: activeHash,
      registryPath: relative(registry.registryPath),
      registrySha256: registryHash,
      promotedAt: promoted.promotedAt,
      promotedFrom: promoted.promotedFrom,
      lineageParentHash: promoted.metadata.lineageParentHash
    },
    rollback: { path: relative(rollbackPath), sha256: rollbackHash },
    fallbackCandidates: candidates.map(item => ({ id: item.id, path: item.relativePath, exists: item.exists })),
    gates,
    status: 'promotion_succeeded'
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main();
