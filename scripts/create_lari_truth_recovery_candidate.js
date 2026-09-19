#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RECOVERY_ROOT = path.join(ROOT, 'consolidation', 'recovery');
const BACKUP_ROOT = path.join(RECOVERY_ROOT, 'backups');
const CANDIDATE_ROOT = path.join(RECOVERY_ROOT, 'candidates');
const ACTIVE_PATH = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY_PATH = path.join(ROOT, 'models', 'lari', 'registry.json');
const SOURCE_CANDIDATE_PATH = path.join(
  ROOT,
  'consolidation',
  'learning-candidates',
  'ce4c7f9454c2747f50f2c97016580adfe640ab9a1e1819706dd6c5e6bdfbd4b0.json'
);
const CANDIDATE_DIRS = [
  path.join(ROOT, 'consolidation', 'learning-candidates'),
  path.join(ROOT, 'consolidation', 'coding-learning-candidates'),
  path.join(ROOT, 'consolidation', 'arc-learning-candidates')
];

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function immutableWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.chmodSync(filePath, 0o444);
}

function fileRecord(filePath, sourcePath = null) {
  const stat = fs.statSync(filePath);
  return {
    sourcePath: sourcePath ? relative(sourcePath) : relative(filePath),
    storedPath: relative(filePath),
    sha256: sha256File(filePath),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

function countMarker(filePath, marker = '"minedFrom"') {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let carry = '';
  let count = 0;
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      const text = carry + buffer.toString('utf8', 0, bytes);
      count += text.split(marker).length - 1;
      carry = text.slice(-Math.max(marker.length - 1, 0));
    }
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

function discoverCandidateFiles() {
  const output = [];
  for (const directory of CANDIDATE_DIRS) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) output.push(path.join(directory, entry.name));
    }
  }
  return output.sort();
}

function gitOutput(args) {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return String(run.stdout || '').trim();
}

function recordFingerprint(record) {
  const stable = {
    id: record?.id || null,
    type: record?.type || null,
    normalizedTriggers: record?.normalizedTriggers || [],
    procedureIdentity: record?.procedureIdentity || null,
    semanticFingerprint: record?.semanticFingerprint || null,
    outputBehavior: record?.outputBehavior || null,
    payload: record?.payload || null
  };
  return sha256Buffer(JSON.stringify(stable));
}

function main() {
  for (const required of [ACTIVE_PATH, REGISTRY_PATH, SOURCE_CANDIDATE_PATH, BACKUP_ROOT]) {
    if (!fs.existsSync(required)) throw new Error(`Missing required recovery input: ${relative(required)}`);
  }

  fs.mkdirSync(CANDIDATE_ROOT, { recursive: true });
  const activeBytes = fs.readFileSync(ACTIVE_PATH);
  const active = JSON.parse(activeBytes);
  const registry = readJson(REGISTRY_PATH);
  const sourceCandidate = readJson(SOURCE_CANDIDATE_PATH);
  const activeHash = sha256Buffer(activeBytes);
  const sourceCandidateHash = sha256File(SOURCE_CANDIDATE_PATH);
  const registryDeclaredHash = registry?.metadata?.candidateHash || null;
  const activeRecords = active?.lariLearnedRecords?.records || [];
  const sourceRecords = sourceCandidate?.lariLearnedRecords?.records || [];
  const activeIds = new Set(activeRecords.map(record => record?.id).filter(Boolean));
  const candidateOnly = sourceRecords.filter(record => record?.id && !activeIds.has(record.id));

  const candidateOnlyReport = candidateOnly.map(record => ({
    id: record.id,
    type: record.type || null,
    status: record.status || null,
    operation: record?.payload?.operation || null,
    creationSource: record?.provenance?.creationSource || null,
    benchmarkAssociation: record?.provenance?.benchmarkAssociation || [],
    confidence: record?.confidence ?? record?.provenance?.confidence ?? null,
    contentSha256: recordFingerprint(record),
    classification: 'preserved_pending_independent_oracle_review',
    importedIntoRecoveryCandidate: false,
    reason: 'Unique intelligence is preserved in the immutable source candidate, but is not imported until its executable oracle and unseen-transfer evidence are independently verified.'
  }));

  const recoveryCandidate = JSON.parse(JSON.stringify(active));
  recoveryCandidate.lariTruthRecovery = {
    schemaVersion: 1,
    status: 'immutable_non_promoted_candidate',
    createdAt: new Date().toISOString(),
    basePath: relative(ACTIVE_PATH),
    baseSha256: activeHash,
    registryDeclaredSha256: registryDeclaredHash,
    registryMatchesBase: registryDeclaredHash === activeHash,
    contaminationMarkersInBase: countMarker(ACTIVE_PATH),
    importedRecordIds: [],
    preservedPendingRecordIds: candidateOnlyReport.map(record => record.id),
    sourceCandidatePath: relative(SOURCE_CANDIDATE_PATH),
    sourceCandidateSha256: sourceCandidateHash,
    promotionEligible: false,
    reason: 'Restore a clean content-addressed lineage before any capability promotion. No pending record is imported merely because an older benchmark called it validated.'
  };
  const serializedCandidate = `${JSON.stringify(recoveryCandidate, null, 2)}\n`;
  const recoveryHash = sha256Buffer(serializedCandidate);
  const recoveryPath = path.join(CANDIDATE_ROOT, `${recoveryHash}.json`);
  fs.writeFileSync(recoveryPath, serializedCandidate, { flag: 'wx' });
  fs.chmodSync(recoveryPath, 0o444);

  const contaminatedArtifacts = [];
  for (const filePath of discoverCandidateFiles()) {
    const count = countMarker(filePath);
    if (!count) continue;
    contaminatedArtifacts.push({
      path: relative(filePath),
      sha256: sha256File(filePath),
      bytes: fs.statSync(filePath).size,
      minedFromCount: count,
      status: 'quarantined_in_place_not_promotion_eligible',
      preserved: true
    });
  }
  const quarantineIndex = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    rule: 'Artifacts containing benchmark-answer back-references remain preserved for audit but are ineligible for candidate discovery, promotion, or rollback activation.',
    artifactCount: contaminatedArtifacts.length,
    artifacts: contaminatedArtifacts
  };
  immutableWrite(path.join(RECOVERY_ROOT, 'contaminated-artifact-index.json'), quarantineIndex);

  const backupFiles = fs.readdirSync(BACKUP_ROOT)
    .map(name => path.join(BACKUP_ROOT, name))
    .filter(filePath => fs.statSync(filePath).isFile())
    .sort()
    .map(filePath => fileRecord(filePath));
  const backupManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    head: gitOutput(['rev-parse', 'HEAD']),
    branch: gitOutput(['branch', '--show-current']),
    dirtyWorktreeAtManifest: gitOutput(['status', '--short']).split(/\r?\n/).filter(Boolean),
    active: fileRecord(ACTIVE_PATH),
    registry: fileRecord(REGISTRY_PATH),
    backups: backupFiles,
    candidateInventory: {
      scanned: discoverCandidateFiles().length,
      contaminated: contaminatedArtifacts.length
    }
  };
  immutableWrite(path.join(RECOVERY_ROOT, 'truth-recovery-backup-manifest.json'), backupManifest);

  const recoveryManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    verdict: 'clean lineage recovery candidate created; not promoted',
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    active: {
      path: relative(ACTIVE_PATH),
      sha256: activeHash,
      minedFromCount: countMarker(ACTIVE_PATH)
    },
    registry: {
      path: relative(REGISTRY_PATH),
      sha256: sha256File(REGISTRY_PATH),
      declaredCandidateHash: registryDeclaredHash,
      matchesActive: registryDeclaredHash === activeHash
    },
    sourceCandidate: {
      path: relative(SOURCE_CANDIDATE_PATH),
      sha256: sourceCandidateHash,
      minedFromCount: countMarker(SOURCE_CANDIDATE_PATH),
      uniqueRecordCount: candidateOnlyReport.length
    },
    recoveryCandidate: {
      path: relative(recoveryPath),
      sha256: recoveryHash,
      minedFromCount: countMarker(recoveryPath),
      importedRecordCount: 0,
      pendingRecordCount: candidateOnlyReport.length,
      promoted: false,
      promotionEligible: false
    },
    nextGate: 'Independently validate pending records and the clean candidate, then rehearse an atomic registry reconciliation. Do not promote from a contaminated source.'
  };
  immutableWrite(path.join(RECOVERY_ROOT, 'truth-recovery-manifest.json'), recoveryManifest);
  immutableWrite(path.join(RECOVERY_ROOT, 'candidate-only-record-audit.json'), {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceCandidatePath: relative(SOURCE_CANDIDATE_PATH),
    sourceCandidateSha256: sourceCandidateHash,
    baseActiveSha256: activeHash,
    records: candidateOnlyReport
  });

  process.stdout.write(`${JSON.stringify({
    activeHash,
    registryDeclaredHash,
    registryMatchesActive: registryDeclaredHash === activeHash,
    sourceCandidateHash,
    sourceCandidateContamination: countMarker(SOURCE_CANDIDATE_PATH),
    recoveryCandidate: relative(recoveryPath),
    recoveryHash,
    recoveryContamination: countMarker(recoveryPath),
    pendingUniqueRecords: candidateOnlyReport.length,
    contaminatedCandidatesIndexed: contaminatedArtifacts.length,
    promoted: false
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
}
