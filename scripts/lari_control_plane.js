#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const registry = require('./lari_model_registry.js');
const runtime = require('../swarm_model_runtime.js');

const root = path.resolve(__dirname, '..');
const activityPath = path.join(root, 'benchmarks', 'latest-lari-autonomous-learning-report.json');
const candidateRoot = path.join(root, 'consolidation', 'user-record-controls', 'candidates');
const manifestRoot = path.join(root, 'consolidation', 'user-record-controls', 'manifests');
const defaultUserStatePath = path.join(root, 'models', 'lari', 'runtime', 'workbench-user-state.json');
const sha256Bytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha256File = file => sha256Bytes(fs.readFileSync(file));
const relative = file => path.relative(root, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function recordSummary(record = {}) {
  return {
    id: record.id || null,
    type: record.type || null,
    status: record.status || null,
    confidence: record.confidence ?? null,
    triggers: (record.normalizedTriggers || []).slice(0, 8),
    outputBehavior: record.outputBehavior || null,
    creationSource: record.provenance?.creationSource || null,
    benchmarkAssociation: record.provenance?.benchmarkAssociation || [],
    imported: record.provenance?.imported === true,
    updatedAt: record.provenance?.lastVerifiedAt || record.payload?.updatedAt || record.payload?.createdAt || null
  };
}

function status() {
  const loaded = registry.loadLariModel();
  const activeHash = sha256File(registry.currentModelPath);
  const records = loaded.model.lariLearnedRecords?.records || [];
  const history = registry.listLariModelHistory();
  const activity = fs.existsSync(activityPath) ? read(activityPath) : null;
  const controlManifests = fs.existsSync(manifestRoot)
    ? fs.readdirSync(manifestRoot).filter(name => name.endsWith('.json')).map(name => path.join(manifestRoot, name))
    : [];
  const latestControlPath = controlManifests.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  const latestControl = latestControlPath ? read(latestControlPath) : null;
  const activityTime = Date.parse(activity?.createdAt || '') || 0;
  const controlTime = Date.parse(latestControl?.createdAt || '') || 0;
  const candidateSource = controlTime > activityTime ? latestControl : activity;
  const registryState = registry.readLariModelRegistry() || {};
  const registryCandidate = registryState.metadata?.candidateHash ? {
    sha256: registryState.metadata.candidateHash,
    path: registryState.promotedFrom || null,
    promoted: registryState.activeModelSha256 === registryState.metadata.candidateHash
  } : null;
  // Once a qualified candidate is promoted there may be no newer learning or
  // record-control candidate. Keep the promoted candidate visible from the
  // canonical registry provenance instead of returning a misleading null.
  const candidateFromActivity = Boolean(candidateSource?.candidate);
  const candidate = candidateFromActivity ? candidateSource.candidate : registryCandidate;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    active: { sha256: activeHash, path: relative(registry.currentModelPath), recordCount: records.length },
    candidate: candidate ? {
      sha256: candidate.sha256 || null,
      path: candidate.path || null,
      status: candidateFromActivity
        ? (candidateSource?.status || candidateSource?.action || null)
        : (candidate?.promoted ? 'promoted' : null),
      promoted: (candidateFromActivity && candidateSource?.promoted === true) || candidate.promoted === true,
      sameAsActive: candidate.sha256 === activeHash
    } : null,
    learningActivity: activity ? {
      status: activity.status || null,
      query: activity.query || null,
      risk: activity.risk || null,
      passed: activity.passed === true,
      promoted: activity.promoted === true,
      createdAt: activity.createdAt || null,
      candidateHash: activity?.candidate?.sha256 || null,
      evidenceReused: activity.evidenceReused === true
    } : null,
    records: records.map(recordSummary).slice(0, 80),
    recordCounts: records.reduce((counts, record) => {
      const key = `${record.type || 'unknown'}:${record.status || 'unknown'}`;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
    history: { points: history.history.length, rollbackAvailable: history.history.filter(item => item.rollbackAvailable).length },
    controls: {
      rollback: 'atomic verified production history activation',
      disable: 'immutable non-promoted candidate only',
      forgetPreference: 'scoped runtime-user-state removal with exact backup'
    },
    external_model_calls: 0
  };
}

function inspect(recordId) {
  const loaded = registry.loadLariModel();
  const record = (loaded.model.lariLearnedRecords?.records || []).find(item => item.id === recordId);
  if (!record) throw new Error('Learned record was not found in the active Lari model.');
  return { activeHash: sha256File(registry.currentModelPath), record, external_model_calls: 0 };
}

function stageDisable(recordId) {
  const activeBytes = fs.readFileSync(registry.currentModelPath);
  const parentHash = sha256Bytes(activeBytes);
  const model = JSON.parse(activeBytes.toString('utf8'));
  const records = model.lariLearnedRecords?.records || [];
  const record = records.find(item => item.id === recordId);
  if (!record) throw new Error('Learned record was not found in the active Lari model.');
  if (record.status !== 'active') throw new Error('Only an active learned record can be disabled.');
  record.status = 'disabled';
  record.provenance = {
    ...(record.provenance || {}),
    disabledAt: new Date().toISOString(),
    disabledBy: 'explicit_user_control',
    disabledFromModelHash: parentHash
  };
  model.compiledSkills = (model.compiledSkills || []).filter(skill => skill.sourceLearnedRecordId !== recordId);
  model.skills = (model.skills || []).filter(skill => skill.sourceLearnedRecordId !== recordId && skill.lariTypedRecordId !== recordId);
  runtime.refreshLariKnowledgeProjections(model, { pruneUnboundCompiledSkills: true });
  runtime.refreshLariPreferenceProjections(model, { userScope: record.payload?.userScope || 'local.default' });
  runtime.buildLariCapabilityGraph(model, { nodeLimit: 120 });
  model.lineage = {
    ...(model.lineage || {}),
    parentHash,
    developmentalEvent: 'user_staged_record_disable',
    recordId,
    createdAt: new Date().toISOString()
  };
  registry.assertNoStoredBenchmarkAnswers(model, 'user record-control candidate');
  registry.assertNoUnboundBenchmarkRuntimeSkills(model, 'user record-control candidate');
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha256Bytes(bytes);
  const candidatePath = path.join(candidateRoot, `${candidateHash}.json`);
  fs.mkdirSync(candidateRoot, { recursive: true });
  if (!fs.existsSync(candidatePath)) fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  if (sha256File(candidatePath) !== candidateHash) throw new Error('Staged disable candidate hash verification failed.');
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    action: 'stage_disable',
    recordId,
    parentHash,
    candidate: { path: relative(candidatePath), sha256: candidateHash, promoted: false },
    activeUnchanged: sha256File(registry.currentModelPath) === parentHash,
    externalModelCalls: 0
  };
  atomicWrite(path.join(manifestRoot, `${candidateHash}.json`), manifest);
  return manifest;
}

function forgetPreference(recordId, statePath = defaultUserStatePath) {
  const resolved = path.resolve(statePath);
  const relativeState = path.relative(path.join(root, 'models', 'lari', 'runtime'), resolved);
  if (relativeState.startsWith('..') || path.isAbsolute(relativeState)) throw new Error('Preference state path is outside the Lari runtime namespace.');
  if (!fs.existsSync(resolved)) throw new Error('Lari user-state file does not exist.');
  const beforeBytes = fs.readFileSync(resolved);
  const beforeHash = sha256Bytes(beforeBytes);
  const state = JSON.parse(beforeBytes.toString('utf8'));
  const records = state.preferenceRecords || [];
  const record = records.find(item => item.id === recordId);
  if (!record || record.type !== 'preference') throw new Error('Scoped preference record was not found.');
  state.preferenceRecords = records.filter(item => item.id !== recordId);
  if (state.lariSessionRuntime?.userMemory) {
    state.lariSessionRuntime.userMemory.preferences = (state.lariSessionRuntime.userMemory.preferences || []).filter(item => item.recordId !== recordId && item.id !== recordId);
    state.lariSessionRuntime.userMemory.preferenceRecordIds = (state.lariSessionRuntime.userMemory.preferenceRecordIds || []).filter(id => id !== recordId);
  }
  for (const scope of Object.values(state.lariSessionRuntime?.userScopes || {})) {
    if (!scope || typeof scope !== 'object') continue;
    scope.preferences = (scope.preferences || []).filter(item => item.recordId !== recordId && item.id !== recordId);
    scope.preferenceRecordIds = (scope.preferenceRecordIds || []).filter(id => id !== recordId);
  }
  state.revision = Number(state.revision || 0) + 1;
  state.updatedAt = new Date().toISOString();
  const backupPath = `${resolved}.backup-sha256-${beforeHash}.json`;
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, beforeBytes, { flag: 'wx' });
  if (sha256File(backupPath) !== beforeHash) throw new Error('Preference backup verification failed.');
  atomicWrite(resolved, state);
  return {
    action: 'forget_preference',
    recordId,
    statePath: relative(resolved),
    beforeHash,
    afterHash: sha256File(resolved),
    backup: { path: relative(backupPath), sha256: beforeHash },
    activeModelHash: sha256File(registry.currentModelPath),
    external_model_calls: 0
  };
}

const [command = 'status', recordId = '', confirmation = ''] = process.argv.slice(2);
let result;
if (command === 'status') result = status();
else if (command === 'inspect') result = inspect(recordId);
else if (command === 'stage-disable') {
  if (confirmation !== recordId) throw new Error('Record disable confirmation must exactly match the record ID.');
  result = stageDisable(recordId);
} else if (command === 'forget-preference') {
  if (confirmation !== recordId) throw new Error('Preference forget confirmation must exactly match the record ID.');
  result = forgetPreference(recordId);
} else throw new Error(`Unknown Lari control-plane command: ${command}`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
