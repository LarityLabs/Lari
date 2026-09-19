#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtimeRoot = path.join(root, 'models', 'lari', 'runtime');
const defaultStatePath = path.join(runtimeRoot, 'workbench-user-state.json');

const canonical = value => JSON.stringify(value, Object.keys(value || {}).sort());
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const scopeKey = scope => sha256(Buffer.from(String(scope), 'utf8'));

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

function validateStatePath(statePath) {
  const resolved = path.resolve(statePath || defaultStatePath);
  const relative = path.relative(runtimeRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Personal state path is outside the Lari runtime namespace.');
  return resolved;
}

function historyPaths(statePath, userScope) {
  const stateName = path.basename(statePath, path.extname(statePath)).replace(/[^a-z0-9_.-]/gi, '_');
  const directory = path.join(runtimeRoot, 'personal-history', stateName);
  const key = scopeKey(userScope);
  return { directory, objectRoot: path.join(directory, 'objects'), manifest: path.join(directory, 'users', `${key}.json`), key };
}

function preferenceBelongsTo(record, userScope) {
  return record?.type === 'preference' && String(record?.payload?.userScope || 'local.default') === userScope;
}

function extractUserState(state, userScope) {
  const scopes = state?.lariSessionRuntime?.userScopes || {};
  const scope = scopes[userScope];
  return {
    schemaVersion: 1,
    kind: 'lari_personal_state_snapshot',
    userScope,
    baseModelHash: state?.baseModelHash || null,
    scopePresent: Object.prototype.hasOwnProperty.call(scopes, userScope),
    // Conversation turns and growth traces are intentionally excluded. This
    // timeline is for durable personal learning, not chat-log restoration.
    userScopeState: scope ? { userScope, userMemory: scope.userMemory || null } : null,
    preferenceRecords: (state?.preferenceRecords || []).filter(record => preferenceBelongsTo(record, userScope))
  };
}

function snapshotHash(snapshot) {
  // Timestamps and labels live in the manifest, so identical personal state is
  // genuinely content addressed and deduplicates across repeated checkpoints.
  return sha256(Buffer.from(JSON.stringify(snapshot), 'utf8'));
}

function readManifest(paths, userScope) {
  if (!fs.existsSync(paths.manifest)) return { schemaVersion: 1, kind: 'lari_personal_history', userScopeHash: paths.key, userScope, entries: [] };
  const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  if (manifest.userScopeHash !== paths.key || manifest.userScope !== userScope) throw new Error('Personal history identity verification failed.');
  return manifest;
}

function capturePersonalHistory(statePath, userScope = 'local.default', options = {}) {
  const resolved = validateStatePath(statePath);
  if (!fs.existsSync(resolved) && !options.state) throw new Error('Lari personal state file does not exist.');
  const state = options.state || JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const snapshot = extractUserState(state, userScope);
  const hash = snapshotHash(snapshot);
  const paths = historyPaths(resolved, userScope);
  const objectPath = path.join(paths.objectRoot, `${hash}.json`);
  fs.mkdirSync(paths.objectRoot, { recursive: true });
  if (!fs.existsSync(objectPath)) atomicWriteJson(objectPath, snapshot);
  if (sha256(Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(objectPath, 'utf8'))), 'utf8')) !== hash) throw new Error('Personal history object hash verification failed.');
  const manifest = readManifest(paths, userScope);
  const entry = {
    snapshotHash: hash,
    capturedAt: new Date().toISOString(),
    label: String(options.label || 'Personal learning checkpoint').slice(0, 160),
    event: String(options.event || 'checkpoint').slice(0, 80),
    stateRevision: Number(state.revision || 0),
    baseModelHash: state.baseModelHash || null,
    preferenceCount: snapshot.preferenceRecords.length,
    scopePresent: snapshot.scopePresent,
    promptHash: options.prompt ? sha256(Buffer.from(String(options.prompt), 'utf8')) : null
  };
  const previous = manifest.entries[manifest.entries.length - 1];
  if (!previous || previous.snapshotHash !== hash || previous.event !== entry.event) manifest.entries.push(entry);
  manifest.updatedAt = entry.capturedAt;
  atomicWriteJson(paths.manifest, manifest);
  return { ...entry, userScope, userScopeHash: paths.key };
}

function listPersonalHistory(statePath, userScope = 'local.default') {
  const resolved = validateStatePath(statePath);
  const paths = historyPaths(resolved, userScope);
  const manifest = readManifest(paths, userScope);
  let currentHash = null;
  if (fs.existsSync(resolved)) currentHash = snapshotHash(extractUserState(JSON.parse(fs.readFileSync(resolved, 'utf8')), userScope));
  return { schemaVersion: 1, userScope, userScopeHash: paths.key, currentSnapshotHash: currentHash, history: manifest.entries.map(entry => ({ ...entry, current: entry.snapshotHash === currentHash })), external_model_calls: 0 };
}

function restorePersonalHistory(statePath, userScope, targetHash) {
  const resolved = validateStatePath(statePath);
  if (!/^[a-f0-9]{64}$/.test(targetHash)) throw new Error('A complete personal snapshot hash is required.');
  if (!fs.existsSync(resolved)) throw new Error('Lari personal state file does not exist.');
  const paths = historyPaths(resolved, userScope);
  const manifest = readManifest(paths, userScope);
  if (!manifest.entries.some(entry => entry.snapshotHash === targetHash)) throw new Error('Snapshot does not belong to this user history.');
  const objectPath = path.join(paths.objectRoot, `${targetHash}.json`);
  if (!fs.existsSync(objectPath)) throw new Error('Personal snapshot object is missing.');
  const snapshot = JSON.parse(fs.readFileSync(objectPath, 'utf8'));
  if (snapshotHash(snapshot) !== targetHash || snapshot.userScope !== userScope) throw new Error('Personal snapshot verification failed.');

  const beforeBytes = fs.readFileSync(resolved);
  const beforeStateHash = sha256(beforeBytes);
  const state = JSON.parse(beforeBytes.toString('utf8'));
  const undo = capturePersonalHistory(resolved, userScope, { state, label: 'Before personal rollback', event: 'rollback_undo' });
  state.lariSessionRuntime = state.lariSessionRuntime || {};
  state.lariSessionRuntime.userScopes = state.lariSessionRuntime.userScopes || {};
  if (snapshot.scopePresent) {
    const existing = state.lariSessionRuntime.userScopes[userScope] || { schemaVersion: 1, userScope, turns: [], growthRuns: [] };
    state.lariSessionRuntime.userScopes[userScope] = { ...existing, userMemory: snapshot.userScopeState?.userMemory || null };
  } else delete state.lariSessionRuntime.userScopes[userScope];
  state.preferenceRecords = (state.preferenceRecords || []).filter(record => !preferenceBelongsTo(record, userScope));
  state.preferenceRecords.push(...snapshot.preferenceRecords);
  if (state.lariSessionRuntime.activeUserScope === userScope) {
    state.lariSessionRuntime.userMemory = snapshot.scopePresent ? snapshot.userScopeState?.userMemory || null : null;
  }
  state.revision = Number(state.revision || 0) + 1;
  state.updatedAt = new Date().toISOString();
  atomicWriteJson(resolved, state);
  const after = extractUserState(JSON.parse(fs.readFileSync(resolved, 'utf8')), userScope);
  if (snapshotHash(after) !== targetHash) throw new Error('Personal rollback post-write verification failed.');
  return { action: 'personal_rollback', userScope, targetSnapshotHash: targetHash, undoSnapshotHash: undo.snapshotHash, beforeStateHash, afterStateHash: sha256(fs.readFileSync(resolved)), baseModelHash: state.baseModelHash || null, verified: true, external_model_calls: 0 };
}

function parseArgs(argv) {
  const positional = []; const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) positional.push(argv[i]);
    else { const key = argv[i].slice(2); options[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  }
  return { positional, options };
}

if (require.main === module) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'list';
  const userScope = String(options.user || 'local.default');
  const statePath = options.state || defaultStatePath;
  let result;
  if (command === 'list') result = listPersonalHistory(statePath, userScope);
  else if (command === 'checkpoint') result = capturePersonalHistory(statePath, userScope, { label: options.label, event: options.event });
  else if (command === 'rollback') {
    const target = String(positional[1] || '').toLowerCase();
    if (options.confirm !== target) throw new Error('Personal rollback confirmation must exactly match the snapshot hash.');
    result = restorePersonalHistory(statePath, userScope, target);
  } else throw new Error(`Unknown personal-history command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = { capturePersonalHistory, listPersonalHistory, restorePersonalHistory, extractUserState, snapshotHash };
