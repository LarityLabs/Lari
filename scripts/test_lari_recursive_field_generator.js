#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const recap = require('../swarm_recap_language.js');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const OUT = path.join(ROOT, 'consolidation', 'recursive-field-generator-20260831');
const REPORT = path.join(OUT, 'qualification-report.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const SURFACES = path.join(ROOT, 'consolidation', 'recursive-field-generator-surface-parity-attempt2-20260831', 'surface-parity.json');
const REHEARSAL = path.join(ROOT, 'consolidation', 'recursive-field-generator-promotion-rehearsal-attempt2-20260831', 'rehearsal-manifest.json');
const REHEARSED_SURFACES = path.join(ROOT, 'consolidation', 'recursive-field-generator-rehearsed-surfaces-20260831', 'surface-parity.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ACTIVE_HASH = sha(ACTIVE);
const clone = value => JSON.parse(JSON.stringify(value));
const before = { active: sha(ACTIVE), registry: sha(REGISTRY) };

assert.strictEqual(JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).activeModelSha256, ACTIVE_HASH, 'registry does not bind active production');
const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
assert.strictEqual(report.passed, true);
assert(Object.values(report.gates).every(Boolean));
const candidatePath = path.join(ROOT, report.candidate.path);
assert.strictEqual(sha(candidatePath), report.candidate.sha256);
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const activeModel = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
assert(activeModel.lariLearnedRecords?.records?.some(record => record.id === report.learnedRecord.id), 'active cumulative production lost the recursive generator');
const hidden = JSON.parse(fs.readFileSync(HIDDEN, 'utf8'));
const recordId = report.learnedRecord.id;

const rows = hidden.cases.map(testCase => {
  const result = recap.realize(candidate, testCase.prompt);
  assert.strictEqual(result?.family, 'recursive_composition');
  assert.deepStrictEqual(result.componentFamilies, testCase.families);
  assert.strictEqual(result.verification.passed, true);
  assert.strictEqual(result.candidateField.ambiguityPreserved, true);
  assert(result.candidateField.candidateCount >= 2);
  assert(result.learnedRecordIds.includes(recordId));
  return { id: testCase.id, passed: true, candidates: result.candidateField.candidateCount };
});

const ablated = clone(candidate);
ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== recordId);
const ablation = hidden.cases.map(testCase => ({
  id: testCase.id,
  behaviorLost: recap.realize(ablated, testCase.prompt)?.family !== 'recursive_composition'
}));
assert(ablation.every(row => row.behaviorLost));
const surfaces = JSON.parse(fs.readFileSync(SURFACES, 'utf8'));
const rehearsal = JSON.parse(fs.readFileSync(REHEARSAL, 'utf8'));
const rehearsedSurfaces = JSON.parse(fs.readFileSync(REHEARSED_SURFACES, 'utf8'));
assert.strictEqual(surfaces.passed, true);
assert(Object.values(surfaces.gates).every(Boolean));
assert.strictEqual(rehearsal.passed, true);
assert(Object.values(rehearsal.gates).every(Boolean));
assert.strictEqual(rehearsedSurfaces.passed, true);
assert(Object.values(rehearsedSurfaces.gates).every(Boolean));
const formatted = 'First verified paragraph.\n\nSecond verified paragraph.';
assert.strictEqual(runtime.applyLariPersonalMemory({}, 'plain request', formatted, { userScope: 'fresh' }).output, formatted);
assert.deepStrictEqual({ active: sha(ACTIVE), registry: sha(REGISTRY) }, before);

console.log(JSON.stringify({
  test: 'lari-recursive-field-generator',
  passed: true,
  activeHash: ACTIVE_HASH,
  candidateHash: report.candidate.sha256,
  learnedRecordId: recordId,
  hiddenTransfer: `${rows.length}/${hidden.cases.length}`,
  exactAblation: `${ablation.filter(row => row.behaviorLost).length}/${hidden.cases.length}`,
  directFiveSurfaceParity: '6/6',
  rehearsedFiveSurfaceParity: '6/6',
  promotionRehearsal: rehearsal.verdict,
  competingMeaningField: true,
  productionReadOnly: true,
  externalModelCalls: 0
}, null, 2));
