#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');
const { planAutoLearnFromResponse } = require('./lari_auto_learn.js');
const { main: practiceCapability } = require('./lari_practice_capability.js');

const root = path.resolve(__dirname, '..');
const activePath = path.join(root, 'models', 'lari', 'current', 'swarm-model.json');
const registryPath = path.join(root, 'models', 'lari', 'registry.json');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const prompt = 'Calculate the product when reciprocal ratios share value 15 and the second relation has scale factor 5.';

function runCli(script, payload) {
  const result = childProcess.spawnSync(process.execPath, [script], {
    cwd: root,
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

(async () => {
  const activeBefore = hash(activePath);
  const registryBefore = hash(registryPath);
  const loaded = registry.loadLariModel();
  const base = await runtime.sendMessageToLariAsync(loaded.model, { prompt }, {
    modelHash: activeBefore,
    autoGrow: false,
    operator: false,
    groundedFactual: false,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true }
  });
  assert.strictEqual(base.action, 'arithmetic_reasoning_failed');
  assert.strictEqual(base.passed, false);
  assert.strictEqual(base.executionBinding?.verified, false);

  const plan = planAutoLearnFromResponse(base, prompt);
  assert.strictEqual(plan.request, null);
  assert.strictEqual(plan.practice?.targetId, 'symbolic_math_reasoning');
  assert.strictEqual(plan.practice?.practiceKind, 'sealed_symbolic_math');
  assert.strictEqual(plan.practiceStatus?.candidateOnly, true);

  const practice = await practiceCapability({
    targetId: plan.practice.targetId,
    goal: plan.practice.goal,
    triggerHash: plan.practice.triggerHash
  });
  assert.strictEqual(practice.passed, true);
  assert.strictEqual(practice.candidateOnly, true);
  assert.strictEqual(practice.candidate.promoted, false);

  const apiStatePath = path.join(root, 'consolidation', 'capability-practice-jobs', 'loop-test-api-state.json');
  const api = childProcess.spawnSync(process.execPath, [path.join('scripts', 'lari_persistent_runtime_worker.js'), '--state-path', apiStatePath], {
    cwd: root,
    input: `${JSON.stringify({ request_id: 'loop-test', prompt, context: { autonomousLearning: true } })}\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });
  assert.strictEqual(api.status, 0, api.stderr || api.stdout);
  const apiResponse = JSON.parse(api.stdout.trim()).result.response;
  assert.strictEqual(apiResponse.action, 'arithmetic_reasoning_failed');
  assert.strictEqual(apiResponse.autonomousPractice?.queued, true);
  assert.strictEqual(apiResponse.autonomousPractice?.targetId, 'symbolic_math_reasoning');

  const cli = runCli(path.join('scripts', 'lari_model_cli.js'), { prompt, context: { autonomousLearning: true } });
  assert.strictEqual(cli.response.action, 'arithmetic_reasoning_failed');
  assert.strictEqual(cli.response.autonomousPractice?.queued, true);

  const autonomous = runCli(path.join('scripts', 'lari_model_cli.js'), {
    prompt,
    context: { surface: 'autonomous', autonomousLearning: true }
  });
  assert.strictEqual(autonomous.response.action, 'arithmetic_reasoning_failed');
  assert.strictEqual(autonomous.response.passed, false);
  assert.strictEqual(autonomous.response.autonomousPractice?.queued, true);

  const factual = planAutoLearnFromResponse({
    intent: 'chat',
    answer: 'I do not have enough local memory to answer that strongly yet.'
  }, 'What is a quasar?');
  assert.ok(factual.request);
  assert.strictEqual(factual.practice, null);

  assert.strictEqual(hash(activePath), activeBefore);
  assert.strictEqual(hash(registryPath), registryBefore);
  const report = {
    passed: true,
    activeHash: activeBefore,
    candidateHash: practice.candidate.sha256,
    learnedRecordId: practice.learnedRecordId,
    surfaces: ['direct_kernel', 'persistent_api_workbench_worker', 'cli_adapter', 'autonomous_adapter'],
    factualResearchStillSeparate: true,
    activeReadOnly: true,
    registryReadOnly: true,
    externalModelCalls: 0,
    limitation: 'Automatic executable practice is proven for the sealed symbolic-math family, not arbitrary capability families.'
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
