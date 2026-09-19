#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime');
const registry = require('./lari_model_registry');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE_DIR = path.join(ROOT, 'consolidation', 'learning-candidates');
const REPORT_PATH = path.join(ROOT, 'consolidation', 'lari-preference-migration-validation-report.json');

const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha256(fs.readFileSync(file));
const shaRecord = record => sha256(Buffer.from(JSON.stringify(record)));

function writeImmutable(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(bytes)) throw new Error(`Immutable candidate collision: ${file}`);
    return;
  }
  fs.writeFileSync(file, bytes, { flag: 'wx' });
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function archiveRecord(candidate, record, sourcePath, reason, classification = 'archived') {
  candidate.lariPreferenceArchive = candidate.lariPreferenceArchive || {
    schemaVersion: 1,
    canonicalStore: 'lariLearnedRecords.records',
    records: []
  };
  const rawRecord = clone(record);
  const recordSha256 = shaRecord(rawRecord);
  const id = `lari.preference.archive.sha256.${recordSha256.slice(0, 24)}`;
  const entry = {
    schemaVersion: 1,
    id,
    sourcePath,
    sourceRecordId: record?.id || null,
    sha256: recordSha256,
    size: Buffer.byteLength(JSON.stringify(rawRecord)),
    classification,
    reason,
    rawRecord
  };
  const duplicate = candidate.lariPreferenceArchive.records.some(item => item.sourcePath === sourcePath && (item.sha256 === recordSha256 || shaRecord(item.rawRecord) === recordSha256));
  if (!duplicate) candidate.lariPreferenceArchive.records.push(entry);
  return entry;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function main() {
  const activePath = registry.currentModelPath;
  const registryPath = registry.registryPath;
  const before = { active: shaFile(activePath), registry: shaFile(registryPath) };
  const candidate = clone(registry.loadLariModel().model);
  const createdAt = new Date().toISOString();
  const sourceCounts = {
    userModelPreferences: (candidate.userModel?.preferences || []).filter(item => !(item?.canonical && item?.recordId)).length,
    sessionPreferences: (candidate.lariSessionRuntime?.userMemory?.preferences || []).filter(item => !(item?.canonical && item?.recordId)).length,
    sessionCorrections: (candidate.lariSessionRuntime?.userMemory?.corrections || []).length,
    preferenceObservations: (candidate.userModel?.observations || []).filter(item => item?.type === 'preference_learned').length,
    unscopedTypedPreferences: (candidate.lariLearnedRecords?.records || []).filter(record => record?.type === 'preference' && !record?.payload?.userScope).length
  };

  runtime.classifyLariLegacyPreferenceRecords(candidate);
  (candidate.lariPreferenceArchive?.records || []).forEach(entry => {
    entry.sha256 = entry.sha256 || shaRecord(entry.rawRecord);
    entry.size = entry.size || Buffer.byteLength(JSON.stringify(entry.rawRecord));
  });

  const userModel = candidate.userModel || (candidate.userModel = {});
  const observations = userModel.observations || [];
  observations.forEach((record, index) => {
    if (record?.type !== 'preference_learned') return;
    archiveRecord(
      candidate,
      record,
      `userModel.observations[${index}]`,
      'legacy_preference_observation_is_duplicate_proof_not_canonical_intelligence'
    );
  });
  userModel.observations = observations.filter(item => item?.type !== 'preference_learned');

  const memory = candidate.lariSessionRuntime?.userMemory;
  if (memory) {
    (memory.corrections || []).forEach((record, index) => archiveRecord(
      candidate,
      record,
      `lariSessionRuntime.userMemory.corrections[${index}]`,
      'unscoped_legacy_session_correction_cannot_be_safely_assigned_to_a_user'
    ));
    memory.corrections = [];
  }

  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  candidate.lariLearnedRecords.records = (candidate.lariLearnedRecords.records || []).map((record, index) => {
    if (record?.type !== 'preference' || record?.payload?.userScope) return record;
    archiveRecord(
      candidate,
      record,
      `lariLearnedRecords.records[${index}]`,
      'unscoped_typed_preference_quarantined_until_a_user_scope_is_proven'
    );
    return {
      ...record,
      status: 'archived',
      provenance: {
        ...(record.provenance || {}),
        classification: 'archived_unscoped_preference',
        archiveReason: 'unscoped_typed_preference_quarantined_until_a_user_scope_is_proven'
      }
    };
  });

  runtime.refreshLariPreferenceProjections(candidate, { userScope: 'local.default' });
  candidate.lariPreferenceConsolidation = {
    schemaVersion: 1,
    createdAt,
    parentModelHash: before.active,
    canonicalStore: 'lariLearnedRecords.records',
    compatibilityProjections: ['userModel.preferences', 'lariSessionRuntime.userMemory.preferences'],
    archivePath: 'lariPreferenceArchive.records',
    sourceCounts,
    archivedRecordCount: candidate.lariPreferenceArchive?.records?.length || 0,
    promoted: false,
    immutableCandidate: true,
    external_model_calls: 0
  };
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: before.active,
    developmentalEvent: 'canonical_scoped_preference_consolidation',
    createdAt
  };

  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha256(candidateBytes);
  const candidatePath = path.join(CANDIDATE_DIR, `${candidateHash}.json`);
  writeImmutable(candidatePath, candidateBytes);

  const reload = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const after = { active: shaFile(activePath), registry: shaFile(registryPath) };
  const validationProbe = clone(reload);
  const first = runtime.learnUserPreference(validationProbe, {
    userScope: 'validation.alpha',
    domain: 'general',
    key: 'tone',
    value: 'concise',
    confidence: 0.95,
    source: 'migration_validation_explicit_signal',
    explicit: true,
    durable: true
  });
  const second = runtime.learnUserPreference(validationProbe, {
    userScope: 'validation.alpha',
    domain: 'general',
    key: 'tone',
    value: 'concise',
    confidence: 0.95,
    source: 'migration_validation_explicit_signal',
    explicit: true,
    durable: true
  });
  runtime.learnUserPreference(validationProbe, {
    userScope: 'validation.beta',
    domain: 'general',
    key: 'tone',
    value: 'detailed',
    confidence: 0.95,
    source: 'migration_validation_explicit_signal',
    explicit: true,
    durable: true
  });
  const roundTrip = JSON.parse(JSON.stringify(validationProbe));
  const alphaPreferences = runtime.getUserPreferences(roundTrip, 'general', { userScope: 'validation.alpha' });
  const betaPreferences = runtime.getUserPreferences(roundTrip, 'general', { userScope: 'validation.beta' });
  const archived = reload.lariPreferenceArchive?.records || [];
  const sourceRecordCount = Object.values(sourceCounts).reduce((sum, count) => sum + count, 0);
  const activeTyped = (reload.lariLearnedRecords?.records || []).filter(record => record?.type === 'preference' && record?.status === 'active');
  const gates = {
    candidateContentAddressed: shaFile(candidatePath) === candidateHash && path.basename(candidatePath) === `${candidateHash}.json`,
    sourceHashRecorded: reload.lariPreferenceConsolidation?.parentModelHash === before.active,
    everyLegacySourceClassified: archived.length >= sourceRecordCount
      && archived.every(item => item.sha256 && item.reason && item.sourcePath && item.rawRecord),
    allFourLiveLegacyPreferencesClassified: sourceCounts.userModelPreferences === 4
      && archived.filter(item => /^userModel\.preferences\[\d+\]$/.test(item.sourcePath || '')).length === 4,
    noUnscopedActiveTypedPreferences: activeTyped.every(record => !!record.payload?.userScope),
    compatibilityArraysAreDerivedPointers: (reload.userModel?.preferences || []).every(item => item.canonical && item.recordId)
      && (reload.lariSessionRuntime?.userMemory?.preferences || []).every(item => item.canonical && item.recordId),
    deterministicTypedIds: first.recordId === second.recordId,
    perUserIsolation: alphaPreferences.length === 1 && alphaPreferences[0].value === 'concise'
      && betaPreferences.length === 1 && betaPreferences[0].value === 'detailed',
    reloadRetention: runtime.canonicalLariPreferenceRecords(roundTrip, { userScope: 'validation.alpha' }).some(record => record.id === first.recordId),
    activeReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry,
    nonPromoted: reload.lariPreferenceConsolidation?.promoted === false,
    noExternalModelCalls: reload.lariPreferenceConsolidation?.external_model_calls === 0
  };
  const report = {
    schemaVersion: 1,
    report: 'lari-canonical-preference-migration-validation',
    createdAt,
    source: { path: relative(activePath), sha256: before.active },
    registry: { path: relative(registryPath), sha256: before.registry },
    candidate: { path: relative(candidatePath), sha256: candidateHash, promoted: false, immutable: true },
    sourceCounts,
    archivedRecords: archived.map(item => ({
      id: item.id,
      sourcePath: item.sourcePath,
      sourceRecordId: item.sourceRecordId || null,
      sha256: item.sha256,
      size: item.size,
      classification: item.classification,
      reason: item.reason,
      flags: item.flags || null
    })),
    gates,
    passed: Object.values(gates).every(Boolean),
    before,
    after,
    external_model_calls: 0
  };
  atomicWriteJson(REPORT_PATH, report);
  console.log(JSON.stringify({
    passed: report.passed,
    candidate: report.candidate,
    sourceCounts,
    archivedRecordCount: archived.length,
    gates,
    reportPath: relative(REPORT_PATH)
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
