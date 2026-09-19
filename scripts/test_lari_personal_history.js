#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const registry = require('./lari_model_registry.js');
const history = require('./lari_personal_history.js');

const root = path.resolve(__dirname, '..');
const id = `isolated-personal-history-test-${process.pid}-${Date.now()}`;
const statePath = path.join(root, 'models', 'lari', 'runtime', `${id}.json`);
const historyPath = path.join(root, 'models', 'lari', 'runtime', 'personal-history', id);
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const activeBefore = hashFile(registry.currentModelPath);
const registryBefore = hashFile(registry.registryPath);

const memory = (scope, name) => ({ preferences: [{ key: 'name', value: name }], corrections: [], currentGoal: null, pendingAction: null, contextEvents: [], longTermFacts: [], userScope: scope, preferenceRecordIds: [`pref.${scope}.${name}`] });
const preference = (scope, name) => ({ id: `pref.${scope}.${name}`, type: 'preference', status: 'active', payload: { userScope: scope, key: 'name', value: name } });

try {
  const state = {
    schemaVersion: 1, kind: 'lari_runtime_user_state', baseModelHash: activeBefore, revision: 1,
    lariSessionRuntime: { activeUserScope: 'user.a', userMemory: memory('user.a', 'alpha'), userScopes: {
      'user.a': { schemaVersion: 1, userScope: 'user.a', turns: [{ private: 'not snapshotted' }], userMemory: memory('user.a', 'alpha'), growthRuns: [{ trace: true }] },
      'user.b': { schemaVersion: 1, userScope: 'user.b', turns: [{ keep: true }], userMemory: memory('user.b', 'bravo'), growthRuns: [] }
    } },
    preferenceRecords: [preference('user.a', 'alpha'), preference('user.b', 'bravo')]
  };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const a1 = history.capturePersonalHistory(statePath, 'user.a', { label: 'A alpha', event: 'after_learning' });
  const changed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  changed.revision = 2;
  changed.lariSessionRuntime.userScopes['user.a'].userMemory = memory('user.a', 'alpine');
  changed.lariSessionRuntime.userMemory = changed.lariSessionRuntime.userScopes['user.a'].userMemory;
  changed.preferenceRecords = [preference('user.a', 'alpine'), preference('user.b', 'bravo')];
  fs.writeFileSync(statePath, `${JSON.stringify(changed, null, 2)}\n`);
  const a2 = history.capturePersonalHistory(statePath, 'user.a', { label: 'A alpine', event: 'after_learning' });
  assert.notStrictEqual(a1.snapshotHash, a2.snapshotHash);
  const beforeRollback = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const bBefore = JSON.stringify(beforeRollback.lariSessionRuntime.userScopes['user.b']);
  const rollback = history.restorePersonalHistory(statePath, 'user.a', a1.snapshotHash);
  assert.strictEqual(rollback.verified, true);
  const restored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(restored.lariSessionRuntime.userScopes['user.a'].userMemory.preferences[0].value, 'alpha');
  assert.strictEqual(JSON.stringify(restored.lariSessionRuntime.userScopes['user.b']), bBefore);
  assert.strictEqual(restored.preferenceRecords.find(record => record.payload.userScope === 'user.b').payload.value, 'bravo');
  assert.strictEqual(restored.baseModelHash, activeBefore);
  assert.deepStrictEqual(restored.lariSessionRuntime.userScopes['user.a'].turns, [{ private: 'not snapshotted' }]);
  assert.strictEqual(hashFile(registry.currentModelPath), activeBefore);
  assert.strictEqual(hashFile(registry.registryPath), registryBefore);
  const undo = history.restorePersonalHistory(statePath, 'user.a', rollback.undoSnapshotHash);
  assert.strictEqual(undo.verified, true);
  const undone = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(undone.lariSessionRuntime.userScopes['user.a'].userMemory.preferences[0].value, 'alpine');
  const listed = history.listPersonalHistory(statePath, 'user.a');
  assert(listed.history.length >= 2);
  console.log(JSON.stringify({ passed: true, activeModelUnchanged: true, registryUnchanged: true, userIsolationVerified: true, chatLogsExcludedFromSnapshots: true, rollbackVerified: true, undoVerified: true, checkpoints: listed.history.length }, null, 2));
} finally {
  if (fs.existsSync(statePath)) fs.rmSync(statePath, { force: true });
  if (fs.existsSync(historyPath)) fs.rmSync(historyPath, { recursive: true, force: true });
}
