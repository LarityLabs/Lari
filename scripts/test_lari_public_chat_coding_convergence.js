#!/usr/bin/env node
'use strict';

// Regression for one unified model with separate chat and coding lanes.  This
// is intentionally a read-only front-door test, not a benchmark: it verifies
// that the public CLI carrier and the canonical runtime make the same routing
// decision and do not mutate the active model.
const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const root = path.resolve(__dirname, '..');
// Resolve through the existing registry so this same read-only regression can
// validate either production or an explicitly isolated promotion rehearsal.
const activePath = registry.currentModelPath;
const registryPath = registry.registryPath;
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const activeHash = sha(activePath);
const before = { active: activeHash, registry: sha(registryPath) };
const model = JSON.parse(fs.readFileSync(activePath, 'utf8'));
const options = {
  modelHash: activeHash,
  autoGrow: false,
  autonomousLearning: false,
  operator: false,
  groundedFactual: true,
  kernel: {
    useBenchmarkSystem: false,
    useCapabilityGraph: true,
    capabilityGraph: { minScore: 0 },
    chat: { minMemoryScore: 0, minRouteScore: 0 }
  }
};

function cli(prompt) {
  const run = childProcess.spawnSync(process.execPath, ['scripts/lari_model_cli.js'], {
    cwd: root,
    input: JSON.stringify({ model: 'lari', prompt, context: { ...options, modelHash: activeHash } }),
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true
  });
  assert.strictEqual(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout.trim());
}

(async () => {
  const advicePrompt = 'Give exactly three short steps for debugging a failing test. Do not change any files.';
  const queuePrompt = 'Explain why a queue helps when requests arrive faster than workers can process them.';
  const canonicalAdvice = await runtime.sendMessageToLariAsync(clone(model), advicePrompt, options);
  const cliAdvice = cli(advicePrompt);
  const canonicalQueue = await runtime.sendMessageToLariAsync(clone(model), queuePrompt, options);
  const cliQueue = cli(queuePrompt);

  assert.strictEqual(canonicalAdvice.intent, 'chat');
  assert.strictEqual(canonicalAdvice.subintent, 'chat.memory_answer');
  assert.strictEqual(canonicalAdvice.action, 'chat');
  assert.strictEqual(canonicalAdvice.answer.split('\n').length, 3);
  assert.strictEqual(cliAdvice.response.intent, canonicalAdvice.intent);
  assert.strictEqual(cliAdvice.response.subintent, canonicalAdvice.subintent);
  assert.strictEqual(cliAdvice.response.action, canonicalAdvice.action);
  assert.strictEqual(cliAdvice.answer, canonicalAdvice.answer);
  assert.strictEqual(cliAdvice.model_hash, activeHash);

  assert.strictEqual(canonicalQueue.intent, 'chat');
  assert(!/lean manufacturing|visual mockup|multi-file workspace/i.test(canonicalQueue.answer), 'unrelated retained state answered a queue question');
  assert(!canonicalQueue.trace.some(entry => /grounded_factual_answer/.test(entry.phase)), 'ordinary chat was silently web-grounded');
  assert.strictEqual(cliQueue.response.intent, canonicalQueue.intent);
  assert.strictEqual(cliQueue.response.action, canonicalQueue.action);
  assert.strictEqual(cliQueue.answer, canonicalQueue.answer);
  assert.strictEqual(cliQueue.model_hash, activeHash);

  const after = { active: sha(activePath), registry: sha(registryPath) };
  assert.deepStrictEqual(after, before, 'public convergence test mutated production state');
  console.log(JSON.stringify({
    test: 'lari-public-chat-coding-convergence',
    passed: true,
    modelHash: activeHash,
    lanes: { advice: canonicalAdvice.intent, queue: canonicalQueue.intent },
    cliParity: true,
    activeReadOnly: true,
    externalModelCalls: 0
  }, null, 2));
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
