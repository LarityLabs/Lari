#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RECOVERY_ROOT = path.join(ROOT, 'consolidation', 'recovery');
const ACTIVE_PATH = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY_PATH = path.join(ROOT, 'models', 'lari', 'registry.json');
const VALIDATION_PATH = path.join(RECOVERY_ROOT, 'truth-recovery-validation-v2.json');
const REPORT_PATH = path.join(RECOVERY_ROOT, 'truth-recovery-real-promotion.json');
const REHEARSAL_ROOT = path.join(ROOT, 'consolidation', 'stage-3-rehearsal', 'truth-recovery-exact-active');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function runNode(code) {
  return spawnSync(process.execPath, [], {
    cwd: ROOT,
    input: code,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    env: { ...process.env }
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function main() {
  if (!process.argv.includes('--execute')) throw new Error('Refusing real lineage reconciliation without --execute.');
  if (fs.existsSync(REPORT_PATH)) throw new Error('Truth-recovery real-promotion report already exists.');
  const validation = JSON.parse(fs.readFileSync(VALIDATION_PATH, 'utf8'));
  if (validation?.passed !== true) throw new Error('Clean recovery validation did not pass.');

  const activeBefore = sha256(ACTIVE_PATH);
  const registryBefore = sha256(REGISTRY_PATH);
  if (activeBefore !== '7b912b3693356d37a8f550f64bf95538d12462b7228ee50db9268492b3c9f0ac') {
    throw new Error(`Unexpected active recovery base: ${activeBefore}`);
  }
  const exactCandidatePath = path.join(RECOVERY_ROOT, 'candidates', `${activeBefore}.json`);
  if (!fs.existsSync(exactCandidatePath)) {
    fs.copyFileSync(ACTIVE_PATH, exactCandidatePath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(exactCandidatePath, 0o444);
  }
  if (sha256(exactCandidatePath) !== activeBefore) throw new Error('Exact-active candidate copy changed bytes.');
  if (/"minedFrom"\s*:/.test(fs.readFileSync(exactCandidatePath, 'utf8'))) throw new Error('Exact-active candidate is contaminated.');

  fs.mkdirSync(path.join(REHEARSAL_ROOT, 'current'), { recursive: true });
  fs.copyFileSync(ACTIVE_PATH, path.join(REHEARSAL_ROOT, 'current', 'swarm-model.json'));
  fs.copyFileSync(REGISTRY_PATH, path.join(REHEARSAL_ROOT, 'registry.json'));
  const rehearsal = runNode(`
    process.env.LARI_REGISTRY_ROOT = ${JSON.stringify(relative(REHEARSAL_ROOT))};
    process.env.LARI_ALLOW_ISOLATED_REGISTRY_WRITES = '1';
    process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');
    const registry = require('./scripts/lari_model_registry.js');
    const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const before = sha(registry.currentModelPath);
    const promoted = registry.promoteLariModel(${JSON.stringify(exactCandidatePath)}, {
      stage: 'truth-recovery-lineage-reconciliation-rehearsal',
      candidateHash: ${JSON.stringify(activeBefore)},
      releaseEligible: false,
      capabilityClaim: false,
      canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel'
    });
    const currentRegistry = registry.readLariModelRegistry();
    const backupPath = path.resolve(${JSON.stringify(ROOT)}, currentRegistry.previousModelPath);
    process.stdout.write(JSON.stringify({
      before,
      activeAfter: sha(registry.currentModelPath),
      registryDeclaredHash: currentRegistry.activeModelSha256 || currentRegistry.metadata?.candidateHash || null,
      backupHash: sha(backupPath),
      promotedFrom: currentRegistry.promotedFrom,
      contaminationChecked: currentRegistry.metadata?.contaminationChecked === true,
      noTemporaryFiles: !fs.readdirSync(path.dirname(registry.currentModelPath)).some(name => name.endsWith('.tmp'))
    }));
  `);
  const rehearsalPayload = parseJson(rehearsal.stdout);
  const rehearsalPassed = rehearsal.status === 0
    && rehearsalPayload?.before === activeBefore
    && rehearsalPayload?.activeAfter === activeBefore
    && rehearsalPayload?.registryDeclaredHash === activeBefore
    && rehearsalPayload?.backupHash === activeBefore
    && rehearsalPayload?.contaminationChecked === true
    && rehearsalPayload?.noTemporaryFiles === true;
  if (!rehearsalPassed) {
    throw new Error(`Exact-active rehearsal failed: ${rehearsal.stderr || rehearsal.stdout}`);
  }

  const realPromotion = runNode(`
    process.env.LARI_ALLOW_REAL_PROMOTION = '1';
    process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
    const registry = require('./scripts/lari_model_registry.js');
    const promoted = registry.promoteLariModel(${JSON.stringify(exactCandidatePath)}, {
      stage: 'truth-recovery-lineage-reconciliation',
      transaction: 'zero-content-change-active-registry-reconciliation',
      candidateHash: ${JSON.stringify(activeBefore)},
      lineageParentHash: ${JSON.stringify(activeBefore)},
      releaseEligible: false,
      capabilityClaim: false,
      reason: 'Reconcile the registry to the already-active uncontaminated bytes. This promotion adds no capability and makes no release claim.',
      recoveryManifest: 'consolidation/recovery/truth-recovery-manifest.json',
      recoveryValidation: 'consolidation/recovery/truth-recovery-validation-v2.json',
      canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
      ordinaryInferenceReadOnly: true,
      externalModelCalls: 0
    });
    process.stdout.write(JSON.stringify(promoted));
  `);
  if (realPromotion.status !== 0) throw new Error(`Real lineage reconciliation failed: ${realPromotion.stderr || realPromotion.stdout}`);

  const registryAfterDocument = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const activeAfter = sha256(ACTIVE_PATH);
  const registryAfter = sha256(REGISTRY_PATH);
  const previousPath = path.resolve(ROOT, registryAfterDocument.previousModelPath);
  const gates = {
    zeroContentChange: activeAfter === activeBefore,
    exactCandidateActivated: activeAfter === sha256(exactCandidatePath),
    registryDeclaresActualActive: (registryAfterDocument.activeModelSha256 || registryAfterDocument.metadata?.candidateHash) === activeAfter,
    promotedFromExactCandidate: path.resolve(ROOT, registryAfterDocument.promotedFrom) === exactCandidatePath,
    priorCleanBytesBackedUp: fs.existsSync(previousPath) && sha256(previousPath) === activeBefore,
    activeClean: !/"minedFrom"\s*:/.test(fs.readFileSync(ACTIVE_PATH, 'utf8')),
    rollbackTargetClean: !/"minedFrom"\s*:/.test(fs.readFileSync(previousPath, 'utf8')),
    explicitlyNotReleaseEligible: registryAfterDocument.metadata?.releaseEligible === false
      && registryAfterDocument.metadata?.capabilityClaim === false,
    contaminationChecked: registryAfterDocument.metadata?.contaminationChecked === true,
    isolatedRehearsalPassed: rehearsalPassed,
    noTemporaryFiles: !fs.readdirSync(path.dirname(ACTIVE_PATH)).some(name => name.endsWith('.tmp'))
      && !fs.readdirSync(path.dirname(REGISTRY_PATH)).some(name => name.endsWith('.tmp'))
  };
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    action: 'truth-recovery-lineage-reconciliation',
    candidate: {
      path: relative(exactCandidatePath),
      sha256: activeBefore,
      promoted: true
    },
    candidateEligibility: {
      releaseCandidate: false,
      evidenceClass: 'lineage_recovery_only',
      reason: 'Promotion reconciles metadata to already-active clean bytes and proves no new intelligence.'
    },
    before: {
      activeHash: activeBefore,
      registryHash: registryBefore,
      registryDeclaredHash: '4a5d511f69654a6523f28b20effc2f37d940f3bddd1eafc93870409b52ae76a4'
    },
    rehearsal: rehearsalPayload,
    after: {
      activeHash: activeAfter,
      registryHash: registryAfter,
      registryDeclaredHash: registryAfterDocument.activeModelSha256 || registryAfterDocument.metadata?.candidateHash || null,
      previousModelPath: relative(previousPath),
      previousModelHash: sha256(previousPath)
    },
    gates,
    passed: Object.values(gates).every(Boolean),
    verdict: Object.values(gates).every(Boolean)
      ? 'active model and registry lineage reconciled with zero model-content change'
      : 'lineage reconciliation failed'
  };
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  fs.chmodSync(REPORT_PATH, 0o444);
  process.stdout.write(`${JSON.stringify({ activeBefore, activeAfter, registryBefore, registryAfter, gates, passed: report.passed, verdict: report.verdict }, null, 2)}\n`);
  if (!report.passed) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
}
