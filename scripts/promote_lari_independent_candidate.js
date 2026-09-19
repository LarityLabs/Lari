#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

delete process.env.LARI_REGISTRY_ROOT;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';

const registry = require('./lari_model_registry.js');
const runtime = require('../swarm_model_runtime.js');
const root = path.resolve(__dirname, '..');
const candidateHash = '4a5d511f69654a6523f28b20effc2f37d940f3bddd1eafc93870409b52ae76a4';
const incumbentHash = '94f12e2063f700886746125e71139f28bb9cb11cb1d0302d99e102d12ffd1838';
const registryHash = '6263985b59c8f5c18e4b2dc4ccafadd25f21ddb54bf362336450524027e850ae';
const candidatePath = path.join(root, 'consolidation', 'learning-candidates', `${candidateHash}.json`);
const rehearsalDir = path.join(root, 'consolidation', 'independent-repository-gate-20260718', 'promotion-rehearsal-20260722-complete');
const rehearsalPath = path.join(rehearsalDir, 'rehearsal-manifest.json');
const outputDir = path.join(root, 'consolidation', 'independent-repository-gate-20260718', 'production-promotion-20260722');
const preflightPath = path.join(outputDir, 'preflight-manifest.json');
const promotionPath = path.join(outputDir, 'production-promotion-manifest.json');
const failurePath = path.join(outputDir, 'production-promotion-failure.json');
const backupPath = path.join(outputDir, 'backups', `sha256-${incumbentHash}.json`);

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeExclusiveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.chmodSync(filePath, 0o444);
}

function tempFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.tmp') || /^\..+\.tmp$/.test(name));
}

function resolveRehearsalArtifact(artifactPath) {
  return /^(benchmarks|models|consolidation)\//.test(artifactPath)
    ? path.join(root, artifactPath)
    : path.join(rehearsalDir, artifactPath);
}

function dirtyWorktreeState() {
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  return {
    dirty: status.length > 0,
    entryCount: status.split('\0').filter(Boolean).length,
    sha256: sha256Text(status)
  };
}

function preserveContentAddressedBackup() {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, fs.readFileSync(registry.currentModelPath), { flag: 'wx' });
    fs.chmodSync(backupPath, 0o444);
  }
  assert(sha256(backupPath) === incumbentHash, 'Content-addressed incumbent backup hash mismatch.');
  return {
    path: relative(backupPath),
    sha256: incumbentHash,
    size: fs.statSync(backupPath).size,
    immutable: (fs.statSync(backupPath).mode & 0o222) === 0
  };
}

function rollbackAfterFailure(rollbackPath, originalError) {
  let rollback = null;
  let rollbackError = null;
  try {
    if (rollbackPath && fs.existsSync(rollbackPath) && sha256(rollbackPath) === incumbentHash) {
      const restored = registry.promoteLariModel(rollbackPath, {
        transaction: 'automatic-rollback-after-independent-candidate-promotion-failure',
        rollback: true,
        rollbackTargetHash: incumbentHash,
        rolledBackFromHash: candidateHash,
        sourcePromotionEvidence: relative(promotionPath)
      });
      rollback = {
        activeHash: sha256(registry.currentModelPath),
        registryHash: sha256(registry.registryPath),
        promotedAt: restored.promotedAt,
        exact: sha256(registry.currentModelPath) === incumbentHash
      };
    }
  } catch (error) {
    rollbackError = { message: error.message, stack: error.stack };
  }
  const failure = {
    schemaVersion: 1,
    kind: 'lari.independent-candidate-production-promotion-failure',
    createdAt: new Date().toISOString(),
    candidateHash,
    incumbentHash,
    error: { message: originalError.message, stack: originalError.stack },
    rollback,
    rollbackError
  };
  if (!fs.existsSync(failurePath)) writeExclusiveJson(failurePath, failure);
  return rollback;
}

async function main() {
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Promotion resolved a non-production registry root.');
  assert(!fs.existsSync(promotionPath), 'Production promotion manifest already exists; refusing a repeated transaction.');
  assert(!fs.existsSync(failurePath), 'A prior production promotion failure exists; refusing without forensic review.');
  assert(fs.existsSync(candidatePath), 'Immutable candidate is missing.');
  assert(fs.existsSync(rehearsalPath), 'Completed rehearsal manifest is missing.');
  assert(fs.existsSync(registry.currentModelPath), 'Production incumbent is missing.');
  assert(fs.existsSync(registry.registryPath), 'Production registry is missing.');
  assert(sha256(candidatePath) === candidateHash, 'Candidate hash precondition failed.');
  assert(sha256(registry.currentModelPath) === incumbentHash, 'Incumbent hash precondition failed.');
  assert(sha256(registry.registryPath) === registryHash, 'Registry hash precondition failed.');
  assert(tempFiles(path.dirname(registry.currentModelPath)).length === 0, 'Temporary active-model files exist.');
  assert(tempFiles(path.dirname(registry.registryPath)).length === 0, 'Temporary registry files exist.');

  const rehearsal = readJson(rehearsalPath);
  const artifactChecks = Object.entries(rehearsal.artifacts || {}).map(([name, artifact]) => {
    const artifactPath = resolveRehearsalArtifact(artifact.path);
    return {
      name,
      path: relative(artifactPath),
      expectedSha256: artifact.sha256,
      actualSha256: fs.existsSync(artifactPath) ? sha256(artifactPath) : null,
      passed: fs.existsSync(artifactPath) && sha256(artifactPath) === artifact.sha256
    };
  });
  const rehearsalChecks = {
    verdict: rehearsal.verdict === 'Safe for real promotion',
    candidateExact: rehearsal.candidate?.sha256 === candidateHash,
    incumbentExact: rehearsal.incumbent?.sha256Before === incumbentHash && rehearsal.incumbent?.sha256After === incumbentHash,
    registryExact: rehearsal.realRegistry?.sha256Before === registryHash && rehearsal.realRegistry?.sha256After === registryHash,
    publicSurfaceParity: Object.entries(rehearsal.publicSurfaceParity || {})
      .filter(([key]) => key.startsWith('same'))
      .every(([, value]) => value === true),
    hiddenTransfer: rehearsal.developmentalGates?.hiddenTransfer === '17/17',
    familyRegressions: rehearsal.developmentalGates?.familyRegressions === 0,
    reloadRetention: rehearsal.developmentalGates?.reloadRetention === true,
    noHiddenWrites: rehearsal.developmentalGates?.noHiddenWrites === true,
    controlPlane: rehearsal.developmentalGates?.controlPlane === '30/30',
    allArtifactsExact: artifactChecks.length > 0 && artifactChecks.every(item => item.passed),
    noExternalModels: rehearsal.implementation?.externalModelCalls === 0
  };
  assert(Object.values(rehearsalChecks).every(Boolean), `Rehearsal precondition failed: ${JSON.stringify(rehearsalChecks)}`);

  const backup = preserveContentAddressedBackup();
  const preflight = {
    schemaVersion: 1,
    kind: 'lari.independent-candidate-production-promotion-preflight',
    createdAt: new Date().toISOString(),
    candidate: { path: relative(candidatePath), sha256: candidateHash, size: fs.statSync(candidatePath).size },
    incumbent: { path: relative(registry.currentModelPath), sha256: incumbentHash, size: fs.statSync(registry.currentModelPath).size },
    registry: { path: relative(registry.registryPath), sha256: registryHash, size: fs.statSync(registry.registryPath).size },
    rehearsal: { path: relative(rehearsalPath), sha256: sha256(rehearsalPath), checks: rehearsalChecks, artifacts: artifactChecks },
    backup,
    worktree: dirtyWorktreeState(),
    temporaryFiles: [],
    passed: true
  };
  writeExclusiveJson(preflightPath, preflight);

  let rollbackPath = null;
  try {
    const promoted = registry.promoteLariModel(candidatePath, {
      stage: 'independent-repository-gate-production-promotion',
      transaction: 'hash-locked-real-production-promotion',
      candidateHash,
      candidateProvenance: relative(candidatePath),
      lineageParentHash: incumbentHash,
      preflightManifest: relative(preflightPath),
      preflightManifestHash: sha256(preflightPath),
      rehearsalManifest: relative(rehearsalPath),
      rehearsalManifestHash: sha256(rehearsalPath),
      canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
      ordinaryInferenceReadOnly: true,
      fallbackDiscoveryDisabled: true,
      externalModelCalls: 0
    });
    rollbackPath = path.resolve(root, promoted.previousModelPath);
    const afterPromotionHash = sha256(registry.currentModelPath);
    const afterRegistryHash = sha256(registry.registryPath);
    const candidates = registry.listLariModelCandidates();
    const resolved = registry.resolveLariModelPath();
    const beforeInference = { active: afterPromotionHash, registry: afterRegistryHash };
    const loaded = registry.loadLariModel();
    const response = runtime.sendMessageToLari(
      JSON.parse(JSON.stringify(loaded.model)),
      'For a chat request, classify family and select the verified reusable procedure.',
      {
        modelHash: afterPromotionHash,
        autoGrow: false,
        kernel: {
          useBenchmarkSystem: false,
          useCapabilityGraph: true,
          capabilityGraph: { minScore: 0 },
          chat: { minMemoryScore: 0, minRouteScore: 0 }
        }
      }
    );
    const afterInference = { active: sha256(registry.currentModelPath), registry: sha256(registry.registryPath) };
    const rollbackHash = sha256(rollbackPath);
    const gates = {
      exactCandidateActivated: afterPromotionHash === candidateHash,
      exactRollbackTarget: rollbackHash === incumbentHash,
      contentAddressedBackupExact: sha256(backupPath) === incumbentHash,
      lineageParentExact: promoted.metadata?.lineageParentHash === incumbentHash,
      candidateProvenanceExact: promoted.metadata?.candidateProvenance === relative(candidatePath),
      rehearsalProvenanceExact: promoted.metadata?.rehearsalManifestHash === sha256(rehearsalPath),
      registryResolutionOnly: resolved.source === 'registry' && path.resolve(resolved.path) === registry.currentModelPath,
      fallbackDiscoveryDisabled: candidates.length === 1 && candidates[0].id === 'canonical-current',
      noTemporaryFiles: tempFiles(path.dirname(registry.currentModelPath)).length === 0
        && tempFiles(path.dirname(registry.registryPath)).length === 0,
      inferenceReturned: Boolean(response?.output || response?.answer || response?.passed),
      inferenceExactHash: response?.modelHash === candidateHash,
      inferenceSelectedCapability: Boolean(response?.capabilitySelection?.capabilityId),
      ordinaryInferenceReadOnly: beforeInference.active === afterInference.active
        && beforeInference.registry === afterInference.registry,
      noExternalModels: promoted.external_model_calls === 0 && promoted.metadata?.externalModelCalls === 0
    };
    assert(Object.values(gates).every(Boolean), `Immediate post-promotion gate failed: ${JSON.stringify(gates)}`);

    const manifest = {
      schemaVersion: 1,
      kind: 'lari.independent-candidate-production-promotion',
      createdAt: new Date().toISOString(),
      canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
      candidate: { path: relative(candidatePath), sha256: candidateHash },
      incumbent: { sha256: incumbentHash, registrySha256: registryHash },
      preflight: { path: relative(preflightPath), sha256: sha256(preflightPath) },
      rehearsal: { path: relative(rehearsalPath), sha256: sha256(rehearsalPath) },
      promoted: {
        activeModelPath: relative(registry.currentModelPath),
        activeSha256: afterPromotionHash,
        registryPath: relative(registry.registryPath),
        registrySha256: afterRegistryHash,
        promotedAt: promoted.promotedAt,
        promotedFrom: promoted.promotedFrom
      },
      rollback: {
        registryBackupPath: relative(rollbackPath),
        registryBackupSha256: rollbackHash,
        contentAddressedBackup: backup
      },
      inference: {
        modelHash: response.modelHash,
        capabilityId: response.capabilitySelection?.capabilityId || null,
        learnedRecordIds: response.learnedRecordIds || [],
        readOnly: gates.ordinaryInferenceReadOnly
      },
      fallbackCandidates: candidates.map(item => ({ id: item.id, path: item.relativePath, exists: item.exists })),
      gates,
      status: 'promotion_succeeded'
    };
    writeExclusiveJson(promotionPath, manifest);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const rollback = rollbackAfterFailure(rollbackPath, error);
    if (rollbackPath) assert(rollback?.exact === true, 'Promotion failed and exact automatic rollback did not complete.');
    throw error;
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
