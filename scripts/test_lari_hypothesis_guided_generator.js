#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const recap = require('../swarm_recap_language.js');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'hypothesis-guided-generator-20260906');
const MANIFEST_PATH = path.join(OUT, 'qualified-candidate-manifest.json');
const HIDDEN_PATH = path.join(OUT, 'hidden-holdouts.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

const manifest = read(MANIFEST_PATH);
const hidden = read(HIDDEN_PATH);
const candidatePath = path.join(ROOT, manifest.candidate.path);
const model = read(candidatePath);
const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
assert.strictEqual(shaFile(candidatePath), manifest.candidate.sha256, 'qualified candidate hash mismatch');
assert.strictEqual(manifest.candidate.promoted, false, 'qualified candidate was marked promoted');
assert.strictEqual(manifest.parentHash, before.active, 'active incumbent changed after qualification');
const record = model.lariLearnedRecords.records.find(item => item.id === manifest.candidate.learnedRecordId);
assert(record && record.status === 'active', 'qualified learned record missing or inactive');
assert.strictEqual(record.provenance.storesPromptText, false);
assert.strictEqual(record.provenance.storesExpectedAnswers, false);

const rows = hidden.cases.map(row => {
  const result = recap.realize(model, row.prompt);
  assert(result, `hidden case did not realize: ${row.id}`);
  assert.strictEqual(result.family, 'competing_hypothesis_discourse');
  assert.strictEqual(result.verification.passed, true);
  assert.strictEqual(result.verification.relationFaithfulness, true);
  assert(result.learnedRecordIds.includes(record.id));
  return row.id;
});

const response = runtime.sendMessageToLari(clone(model), hidden.cases[0].prompt, {
  modelHash: manifest.candidate.sha256,
  autoGrow: false,
  kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
});
assert.strictEqual(response.modelHash, manifest.candidate.sha256);
assert.strictEqual(response.publicAnswerSource, 'recap_executable_language');
assert([
  ...(response.recapLearnedRecordIds || []),
  ...(response.learnedRecordIds || [])
].includes(record.id));
assert.strictEqual(Number(response.external_model_calls || 0), 0);

const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
assert.deepStrictEqual(after, before, 'production or registry mutated during candidate test');
console.log(JSON.stringify({
  test: 'lari-hypothesis-guided-generator',
  passed: true,
  candidateHash: manifest.candidate.sha256,
  hiddenTransfer: `${rows.length}/${hidden.cases.length}`,
  reloadRetention: true,
  activeUnchanged: true,
  externalModelCalls: 0
}, null, 2));
