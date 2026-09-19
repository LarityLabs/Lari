#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const recap = require('../swarm_recap_language.js');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const ROOT = path.resolve(__dirname, '..');
// Resolve through the existing registry so this same read-only regression can
// validate either production or an explicitly isolated promotion rehearsal.
const ACTIVE = registry.currentModelPath;
const REGISTRY = registry.registryPath;
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ACTIVE_HASH = sha(ACTIVE);
const clone = value => JSON.parse(JSON.stringify(value));
const prompt = 'Please explain why the cache stayed stale: invalidation ran before the transaction committed. The evidence indicates the refresh log has the old version number. Next action: trigger invalidation after commit.';
const claims = ['the cache stayed stale', 'invalidation ran before the transaction committed', 'the refresh log has the old version number', 'trigger invalidation after commit'];
const samples = {
  causal_explanation: prompt,
  practical_planning: 'Make a plan for learning a new codebase safely.',
  balanced_comparison: 'Compare local storage versus a small database.',
  requirements_clarification: 'Ask me what you need to know to create a local coding tool.',
  correction_repair: 'I said archive the candidate, not delete the model.',
  structured_thinking: 'Help me think through a chat release. Context: procedural answers are reliable. Goal: make conversation feel more natural. Constraint: no outside model calls.',
  retained_knowledge_explanation: 'Explain humanize.activate(1000000).'
};

const before = { active: sha(ACTIVE), registry: sha(REGISTRY) };
assert.strictEqual(JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).activeModelSha256, ACTIVE_HASH, 'registry does not bind the active production model');
const model = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
const pureBefore = JSON.stringify(model);
const familyResults = Object.entries(samples).map(([family, familyPrompt]) => {
  const direct = recap.realize(model, familyPrompt);
  assert(direct, `RECAP did not realize ${family}`);
  assert.strictEqual(direct.meaningGraph.family, family);
  assert.strictEqual(direct.verification.passed, true);
  assert.strictEqual(direct.verification.unsupportedClaimCount, 0);
  assert.strictEqual(direct.learnedRecordIds.filter(id => String(id).startsWith('lari.learned.generator.recap.')).length, recap.FAMILIES[family].length);
  const response = runtime.sendMessageToLari(clone(model), familyPrompt, {
    modelHash: ACTIVE_HASH,
    autoGrow: false,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
  // The retained-knowledge lane is intentionally higher precedence for this
  // family; direct RECAP realization remains covered above, while public
  // routing must report the actual canonical source rather than a stale label.
  const expectedPublicSource = family === 'retained_knowledge_explanation'
    ? 'verified_retained_knowledge'
    : 'recap_executable_language';
  assert.strictEqual(response.publicAnswerSource, expectedPublicSource);
  assert.strictEqual(response.modelHash, ACTIVE_HASH);
  assert.strictEqual(response.recapTrace?.meaningGraph?.family, family);
  assert.strictEqual(response.recapTrace?.verification?.passed, true);
  assert.strictEqual((response.learnedRecordIds || []).filter(id => String(id).startsWith('lari.learned.generator.recap.')).length, recap.FAMILIES[family].length);
  assert.strictEqual(Number(response.external_model_calls || 0), 0);
  return { family, passed: true };
});
assert.strictEqual(JSON.stringify(model), pureBefore, 'RECAP mutated model state during inference');
const causal = recap.realize(model, prompt);
assert(claims.every(claim => causal.answer.toLowerCase().includes(claim)));

const ablations = Object.entries(recap.FAMILIES).flatMap(([family, operations]) => operations.map(operation => {
  const ablated = clone(model);
  const removed = ablated.lariLearnedRecords.records.find(record => record?.payload?.operation === operation);
  assert(removed, `missing typed generator record for ${operation}`);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== removed.id);
  return { family, operation, behaviorLost: recap.realize(ablated, samples[family]) === null };
}));
assert(ablations.every(row => row.behaviorLost), 'every required generator record must be causally necessary');
assert.strictEqual(recap.realize(model, 'Tell me a joke about a cache.'), null, 'unsupported free-form prose must not be claimed as RECAP');
assert.strictEqual(recap.realize(model, 'What is Lari in one sentence?'), null, 'retained knowledge must not shadow Lari self-knowledge');
assert.strictEqual(recap.realize(model, 'Who are you?'), null, 'retained knowledge must not shadow identity requests');
const after = { active: sha(ACTIVE), registry: sha(REGISTRY) };
assert.deepStrictEqual(after, before, 'production files changed during inference tests');

console.log(JSON.stringify({
  test: 'lari-recap-language',
  passed: true,
  activeHash: ACTIVE_HASH,
  families: `${familyResults.length}/${Object.keys(recap.FAMILIES).length}`,
  claimCoverage: `${claims.length}/${claims.length}`,
  causalAblation: `${ablations.filter(row => row.behaviorLost).length}/${ablations.length}`,
  readOnly: true,
  externalModelCalls: 0
}, null, 2));
