#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

delete process.env.LARI_REGISTRY_ROOT;
delete process.env.LARI_MODEL_PATH;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
process.env.LARI_ALLOW_LEGACY_ROOT_MODEL = '0';

const registry = require('./lari_model_registry.js');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const CANDIDATE_HASH = '824ee16a5c6eb9aece485f79a61e8e4a6772b5d31e07156a67482f9da85d9d4c';
const INCUMBENT_HASH = 'db0738a5f1989f874d560637a163fadb44e3a366e5b581ebacfbf8ea67ce1201';
const REGISTRY_HASH = '5addb40dfe35469cec3c2d34c0c1ec35e1e9c65bacb90ddfc9d73a4a8602cb33';
const CANDIDATE = path.join(ROOT, 'consolidation', 'coding-frontier-training-20260828', 'candidates', `${CANDIDATE_HASH}.json`);
const REHEARSAL = path.join(ROOT, 'consolidation', 'coding-frontier-promotion-rehearsal-20260828', 'promotion-rehearsal-evidence.json');
const SURFACES = path.join(ROOT, 'consolidation', 'coding-frontier-promotion-rehearsal-20260828', 'surface-evidence.json');
const TRANSFER = path.join(ROOT, 'consolidation', 'coding-frontier-curriculum-v2-20260828', 'transfer-report-v2.json');
const QUALIFICATION = path.join(ROOT, 'consolidation', 'coding-frontier-qualification-v2-20260828', 'qualification-evidence.json');
const OUT = path.join(ROOT, 'consolidation', 'coding-frontier-production-promotion-20260828');
const PREFLIGHT = path.join(OUT, 'preflight-manifest.json');
const MANIFEST = path.join(OUT, 'production-promotion-manifest.json');
const FAILURE = path.join(OUT, 'production-promotion-failure.json');
const BACKUP = path.join(OUT, 'backups', `sha256-${INCUMBENT_HASH}.json`);

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const assert = (value, message) => { if (!value) throw new Error(message); };
function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}
function temps(directory) {
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.tmp') || /^\..+\.tmp$/.test(name)) : [];
}
function state() {
  return { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
}
function preserveIncumbent() {
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, fs.readFileSync(registry.currentModelPath), { flag: 'wx' });
  assert(sha(BACKUP) === INCUMBENT_HASH, 'Content-addressed incumbent backup mismatch.');
  return { path: rel(BACKUP), sha256: sha(BACKUP), bytes: fs.statSync(BACKUP).size };
}
function rollbackAfterFailure(error) {
  let rollback = null;
  if (fs.existsSync(BACKUP) && sha(registry.currentModelPath) === CANDIDATE_HASH) {
    const result = registry.promoteLariModel(BACKUP, {
      transaction: 'automatic-rollback-after-coding-frontier-promotion-failure',
      rollback: true,
      rollbackTargetHash: INCUMBENT_HASH,
      rolledBackFromHash: CANDIDATE_HASH,
      externalModelCalls: 0
    });
    rollback = { activeHash: sha(registry.currentModelPath), exact: sha(registry.currentModelPath) === INCUMBENT_HASH, promotedAt: result.promotedAt };
  }
  if (!fs.existsSync(FAILURE)) writeExclusive(FAILURE, { schemaVersion: 1, createdAt: new Date().toISOString(), error: { message: error.message, stack: error.stack }, rollback });
  return rollback;
}

function main() {
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Promotion did not resolve the production registry.');
  assert(!fs.existsSync(MANIFEST), 'Production promotion manifest already exists; refusing a repeated promotion.');
  assert(!fs.existsSync(FAILURE), 'A previous promotion failure requires review.');
  for (const file of [CANDIDATE, REHEARSAL, SURFACES, TRANSFER, QUALIFICATION, registry.currentModelPath, registry.registryPath]) assert(fs.existsSync(file), `Required promotion input missing: ${rel(file)}`);
  assert(sha(CANDIDATE) === CANDIDATE_HASH, 'Candidate hash mismatch.');
  assert(sha(registry.currentModelPath) === INCUMBENT_HASH, 'Production incumbent hash changed.');
  assert(sha(registry.registryPath) === REGISTRY_HASH, 'Production registry hash changed.');
  assert(temps(path.dirname(registry.currentModelPath)).length === 0 && temps(path.dirname(registry.registryPath)).length === 0, 'Temporary activation files exist.');
  const rehearsal = read(REHEARSAL), surfaces = read(SURFACES), transfer = read(TRANSFER), qualification = read(QUALIFICATION);
  const preflightGates = {
    exactCandidate: rehearsal.candidate?.sha256 === CANDIDATE_HASH && sha(CANDIDATE) === CANDIDATE_HASH,
    rehearsalAllPassed: Object.values(rehearsal.gates || {}).every(Boolean),
    surfacesSameHashSelection: surfaces.nonWorkbenchParityPassed === true && surfaces.parity?.every(row => [row.canonical, row.cli, row.autonomous, row.openaiApi, row.workbenchApi].every(view => view.modelHash === CANDIDATE_HASH)),
    hiddenTransfer17Of17: surfaces.hiddenTransfer?.passed === true && surfaces.hiddenTransfer?.passedCount === 17,
    zeroFamilyRegressions: surfaces.familyRegression?.passed === true,
    reloadAndReadOnly: surfaces.reloadPassed === true && surfaces.noHiddenWrites === true,
    sealedCodingFiveOfFive: transfer.passed === true && transfer.score === '5/5',
    causalAblationAndRollback: transfer.gates?.causalAblationThreeOfThree === true && transfer.gates?.rollbackThreeOfThree === true,
    wholeModelQualification: qualification.passed === true && Object.values(qualification.gates || {}).every(Boolean),
    externalModelCallsZero: transfer.externalModelCalls === 0
  };
  assert(Object.values(preflightGates).every(Boolean), `Promotion preflight failed: ${JSON.stringify(preflightGates)}`);
  const backup = preserveIncumbent();
  const gitStatus = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  writeExclusive(PREFLIGHT, {
    schemaVersion: 1,
    kind: 'lari.coding-frontier.production-promotion-preflight',
    createdAt: new Date().toISOString(),
    candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH, bytes: fs.statSync(CANDIDATE).size },
    incumbent: { path: rel(registry.currentModelPath), sha256: INCUMBENT_HASH, bytes: fs.statSync(registry.currentModelPath).size },
    registry: { path: rel(registry.registryPath), sha256: REGISTRY_HASH },
    backup,
    evidence: [REHEARSAL, SURFACES, TRANSFER, QUALIFICATION].map(file => ({ path: rel(file), sha256: sha(file) })),
    dirtyWorktree: { dirty: gitStatus.length > 0, entries: gitStatus.split('\0').filter(Boolean).length, sha256: crypto.createHash('sha256').update(gitStatus).digest('hex') },
    gates: preflightGates,
    passed: true
  });

  try {
    const promoted = registry.promoteLariModel(CANDIDATE, {
      stage: 'coding-frontier-production-promotion',
      transaction: 'hash-locked-real-production-promotion',
      candidateHash: CANDIDATE_HASH,
      candidateProvenance: rel(CANDIDATE),
      lineageParentHash: INCUMBENT_HASH,
      preflightManifest: rel(PREFLIGHT),
      preflightManifestHash: sha(PREFLIGHT),
      rehearsalEvidence: rel(REHEARSAL),
      rehearsalEvidenceHash: sha(REHEARSAL),
      canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
      ordinaryInferenceReadOnly: true,
      fallbackDiscoveryDisabled: true,
      externalModelCalls: 0
    });
    const afterPromotion = state();
    const rollbackPath = path.resolve(ROOT, promoted.previousModelPath);
    const beforeInference = state();
    const loaded = registry.loadLariModel();
    const response = runtime.sendMessageToLari(JSON.parse(JSON.stringify(loaded.model)), 'Explain in plain language how a local program can retain useful knowledge between restarts.', {
      modelHash: CANDIDATE_HASH,
      autoGrow: false,
      kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
    });
    const afterInference = state();
    const candidates = registry.listLariModelCandidates();
    const resolved = registry.resolveLariModelPath();
    const gates = {
      exactCandidateActivated: afterPromotion.active === CANDIDATE_HASH,
      exactRollbackTarget: fs.existsSync(rollbackPath) && sha(rollbackPath) === INCUMBENT_HASH,
      contentAddressedBackupExact: sha(BACKUP) === INCUMBENT_HASH,
      registryManifestExact: read(registry.registryPath).activeModelSha256 === CANDIDATE_HASH,
      lineageParentExact: promoted.metadata?.lineageParentHash === INCUMBENT_HASH,
      candidateProvenanceExact: promoted.metadata?.candidateProvenance === rel(CANDIDATE),
      registryOnly: resolved.source === 'registry' && candidates.length === 1 && candidates[0].id === 'canonical-current',
      immediateInferencePassed: response.passed === true && response.modelHash === CANDIDATE_HASH && Boolean(response.capabilitySelection?.capabilityId),
      immediateInferenceReadOnly: JSON.stringify(beforeInference) === JSON.stringify(afterInference),
      noTemporaryFiles: temps(path.dirname(registry.currentModelPath)).length === 0 && temps(path.dirname(registry.registryPath)).length === 0,
      externalModelCallsZero: Number(response.external_model_calls || 0) === 0
    };
    assert(Object.values(gates).every(Boolean), `Immediate production validation failed: ${JSON.stringify(gates)}`);
    const manifest = {
      schemaVersion: 1,
      kind: 'lari.coding-frontier.production-promotion',
      createdAt: new Date().toISOString(),
      passed: true,
      candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH },
      incumbent: { sha256: INCUMBENT_HASH, registrySha256: REGISTRY_HASH },
      promoted: { activePath: rel(registry.currentModelPath), activeSha256: afterPromotion.active, registryPath: rel(registry.registryPath), registrySha256: afterPromotion.registry, promotedAt: promoted.promotedAt },
      rollback: { registryBackupPath: rel(rollbackPath), registryBackupSha256: sha(rollbackPath), contentAddressedBackup: backup },
      inference: { capabilityId: response.capabilitySelection.capabilityId, learnedRecordIds: response.learnedRecordIds || [], modelHash: response.modelHash, readOnly: gates.immediateInferenceReadOnly },
      gates,
      status: 'promotion_succeeded',
      externalModelCalls: 0
    };
    writeExclusive(MANIFEST, manifest);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const rollback = rollbackAfterFailure(error);
    if (rollback) assert(rollback.exact, 'Automatic rollback was not exact.');
    throw error;
  }
}

main();
