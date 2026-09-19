#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

delete process.env.LARI_REGISTRY_ROOT;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';

const registry = require('./lari_model_registry.js');
const root = path.resolve(__dirname, '..');
const candidateHash = '034cf64f73dd78b4da1f9f6b4a30e4a3a59f5d81a136d1f6c6de49558ca69a22';
const incumbentHash = '06f2543c86eb60dbc20814a437fc1290d52a832c112046c9fbb37974cdc9a8a3';
const base = path.join(root, 'consolidation', 'beta-quality-execution-refinement-20260909-attempt9');
const candidatePath = path.join(base, 'candidates', `${candidateHash}.json`);
const rehearsalPath = path.join(base, 'promotion-rehearsal', 'promotion-rehearsal-evidence.json');
const validationPath = path.join(base, 'validation-report.json');
const parityPath = path.join(base, 'public-surface-parity.json');
const releaseGatesPath = path.join(root, 'consolidation', 'beta-readiness-20260908', 'release-gates.json');
const outputDir = path.join(root, 'consolidation', 'beta-quality-execution-refinement-production-promotion-20260909-attempt2');
const outputPath = path.join(outputDir, 'promotion-manifest.json');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function allTrue(value) {
  const values = Object.values(value || {});
  return values.length > 0 && values.every(Boolean);
}

function tempFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.tmp') || /^\..+\.tmp$/.test(name));
}

function main() {
  assert(!fs.existsSync(outputPath), 'Production promotion manifest already exists; refusing to repeat the transaction.');
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Promotion did not resolve the production registry.');
  for (const filePath of [candidatePath, rehearsalPath, validationPath, parityPath, releaseGatesPath, registry.currentModelPath, registry.registryPath]) {
    assert(fs.existsSync(filePath), `Required promotion input is missing: ${relative(filePath)}`);
  }

  const actualCandidateHash = sha256(candidatePath);
  const actualIncumbentHash = sha256(registry.currentModelPath);
  const registryBeforeHash = sha256(registry.registryPath);
  assert(actualCandidateHash === candidateHash, `Candidate hash mismatch: ${actualCandidateHash}`);
  assert(actualIncumbentHash === incumbentHash, `Incumbent changed since rehearsal: ${actualIncumbentHash}`);

  const rehearsal = readJson(rehearsalPath);
  const validation = readJson(validationPath);
  const parity = readJson(parityPath);
  const releaseGates = readJson(releaseGatesPath);
  assert(rehearsal.candidate?.sha256 === candidateHash, 'Rehearsal is not bound to the exact candidate.');
  assert(allTrue(rehearsal.gates), 'Promotion rehearsal has a failing gate.');
  assert(validation.candidate?.sha256 === candidateHash && validation.passed === true && allTrue(validation.gates), 'Candidate validation is not fully passing.');
  assert(parity.candidate?.sha256 === candidateHash && parity.passed === true && allTrue(parity.gates), 'Four-surface parity is not fully passing.');
  assert(releaseGates.candidate?.sha256 === candidateHash && releaseGates.passed === true && allTrue(releaseGates.gates), 'Canonical release chain is not fully passing for this candidate.');
  assert(tempFiles(path.dirname(registry.currentModelPath)).length === 0, 'Temporary files exist in the active model namespace.');
  assert(tempFiles(path.dirname(registry.registryPath)).length === 0, 'Temporary files exist in the registry namespace.');

  fs.mkdirSync(outputDir, { recursive: true });
  const promoted = registry.promoteLariModel(candidatePath, {
    stage: 'beta-quality-execution-refinement-production-promotion',
    transaction: 'real-production-promotion',
    reason: 'Activate the rehearsed execution-bound beta quality candidate',
    candidateHash,
    candidateProvenance: relative(candidatePath),
    lineageParentHash: incumbentHash,
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    ordinaryInferenceReadOnly: true,
    fallbackDiscoveryDisabled: true,
    validationReport: relative(validationPath),
    validationReportHash: sha256(validationPath),
    surfaceParityReport: relative(parityPath),
    surfaceParityReportHash: sha256(parityPath),
    promotionRehearsal: relative(rehearsalPath),
    promotionRehearsalHash: sha256(rehearsalPath),
    releaseGatesReport: relative(releaseGatesPath),
    releaseGatesReportHash: sha256(releaseGatesPath)
  });

  const rollbackPath = path.resolve(root, promoted.previousModelPath);
  const resolution = registry.resolveLariModelPath();
  const activeHash = sha256(registry.currentModelPath);
  const rollbackHash = sha256(rollbackPath);
  const candidates = registry.listLariModelCandidates();
  const gates = {
    exactCandidateActivated: activeHash === candidateHash,
    exactIncumbentBackedUp: rollbackHash === incumbentHash,
    registryHashBound: promoted.activeModelSha256 === candidateHash,
    lineageParentExact: promoted.metadata?.lineageParentHash === incumbentHash,
    candidateProvenanceExact: promoted.metadata?.candidateProvenance === relative(candidatePath),
    canonicalRegistryResolution: resolution.source === 'registry' && path.resolve(resolution.path) === registry.currentModelPath,
    fallbackDiscoveryDisabled: candidates.length === 1 && candidates[0].id === 'canonical-current',
    noTemporaryFiles: tempFiles(path.dirname(registry.currentModelPath)).length === 0
      && tempFiles(path.dirname(registry.registryPath)).length === 0,
    rollbackReadable: readJson(rollbackPath).modelId === 'lari-local-model'
  };

  if (!allTrue(gates)) {
    registry.promoteLariModel(rollbackPath, {
      transaction: 'automatic-post-promotion-rollback',
      reason: 'Post-promotion integrity gate failed',
      rollback: true,
      rollbackTarget: relative(rollbackPath),
      rollbackTargetSha256: rollbackHash,
      failedCandidateHash: candidateHash
    });
    throw new Error(`Post-promotion integrity gate failed; incumbent restored: ${JSON.stringify(gates)}`);
  }

  const manifest = {
    schemaVersion: 1,
    kind: 'lari-real-production-promotion',
    createdAt: new Date().toISOString(),
    candidate: { path: relative(candidatePath), sha256: candidateHash },
    incumbent: { activeSha256: incumbentHash, registrySha256: registryBeforeHash },
    promoted: {
      activeModelPath: relative(registry.currentModelPath),
      activeSha256: activeHash,
      registryPath: relative(registry.registryPath),
      registrySha256: sha256(registry.registryPath),
      promotedAt: promoted.promotedAt,
      canonicalRuntime: promoted.metadata.canonicalRuntime
    },
    rollback: { path: relative(rollbackPath), sha256: rollbackHash },
    evidence: {
      validation: { path: relative(validationPath), sha256: sha256(validationPath) },
      publicSurfaceParity: { path: relative(parityPath), sha256: sha256(parityPath) },
      promotionRehearsal: { path: relative(rehearsalPath), sha256: sha256(rehearsalPath) },
      releaseGates: { path: relative(releaseGatesPath), sha256: sha256(releaseGatesPath) }
    },
    gates,
    status: 'promotion_succeeded_pending_post_promotion_validation'
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main();
