#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const history = require('./lari_personal_history.js');

const root = path.resolve(__dirname, '..');
const id = `isolated-worker-personal-test-${process.pid}-${Date.now()}`;
const statePath = path.join(root, 'models', 'lari', 'runtime', `${id}.json`);
const historyPath = path.join(root, 'models', 'lari', 'runtime', 'personal-history', id);
const scope = 'test.personal.timeline';

try {
  const payload = {
    request_id: 'personal-learning-test',
    messages: [{ role: 'user', content: 'Remember that I prefer concise answers.' }],
    context: { userScope: scope, autonomousLearning: false }
  };
  const child = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'lari_persistent_runtime_worker.js'),
    '--model-path', path.join(root, 'models', 'lari', 'current', 'swarm-model.json'),
    '--state-path', statePath
  ], {
    cwd: root,
    input: `${JSON.stringify(payload)}\n`, encoding: 'utf8', timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LARI_DISABLE_MODEL_FALLBACKS: '1', LARI_ALLOW_LEGACY_ROOT_MODEL: '0' }
  });
  if (child.status !== 0) throw new Error(child.stderr || `worker exited ${child.status}`);
  const output = String(child.stdout).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.strictEqual(output[0].request_id, payload.request_id);
  assert(fs.existsSync(statePath));
  const listed = history.listPersonalHistory(statePath, scope);
  assert(listed.history.some(entry => entry.event === 'before_learning'));
  assert(listed.history.some(entry => entry.event === 'after_learning'));
  assert(listed.history.every(entry => entry.promptHash && !JSON.stringify(entry).includes('concise answers')));
  console.log(JSON.stringify({ passed: true, durableTurnCreatedTimeline: true, beforeAfterCaptured: true, rawPromptExcluded: true, checkpointCount: listed.history.length }, null, 2));
} finally {
  if (fs.existsSync(statePath)) fs.rmSync(statePath, { force: true });
  if (fs.existsSync(historyPath)) fs.rmSync(historyPath, { recursive: true, force: true });
}
