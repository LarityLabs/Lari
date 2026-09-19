#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'mixed-domain-program-growth-20260908');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const QUALIFICATION = path.join(OUT, 'qualification-report.json');
const REASONING_REHEARSAL = path.join(OUT, 'promotion-rehearsal-attempt2', 'promotion-rehearsal-evidence.json');
const CODE_REHEARSAL = path.join(OUT, 'promotion-rehearsal-code-family-attempt2', 'promotion-rehearsal-evidence.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const qualification = JSON.parse(fs.readFileSync(QUALIFICATION, 'utf8'));
const reasoning = JSON.parse(fs.readFileSync(REASONING_REHEARSAL, 'utf8'));
const coding = JSON.parse(fs.readFileSync(CODE_REHEARSAL, 'utf8'));
const candidatePath = path.join(ROOT, qualification.candidate.path);

assert.strictEqual(qualification.passed, true);
assert(Object.values(qualification.gates).every(Boolean));
assert.strictEqual(shaFile(candidatePath), qualification.candidate.sha256);
assert.strictEqual(qualification.rows.filter(row => row.passed).length, 6);
assert.strictEqual(qualification.reloadRows.filter(row => row.passed).length, 6);
assert.strictEqual(qualification.ablations.filter(row => row.behaviorLost).length, 12);
assert.strictEqual(qualification.inheritedRows.filter(row => row.passed).length, 5);
assert.strictEqual(qualification.recapRows.filter(row => row.passed).length, 7);
for (const rehearsal of [reasoning, coding]) {
  assert(Object.values(rehearsal.gates).every(Boolean));
  assert.strictEqual(rehearsal.candidate.sha256, qualification.candidate.sha256);
  assert(Object.values(rehearsal.publicSurfaceParity.checks).every(Boolean));
  assert.strictEqual(rehearsal.publicSurfaceParity.rows.length, 4);
  assert.strictEqual(new Set(rehearsal.publicSurfaceParity.rows.map(row => row.modelHash)).size, 1);
  assert.strictEqual(new Set(rehearsal.publicSurfaceParity.rows.map(row => row.selectedRecordId)).size, 1);
  assert.strictEqual(new Set(rehearsal.publicSurfaceParity.rows.map(row => row.answer)).size, 1);
  assert(rehearsal.publicSurfaceParity.rows.every(row => row.passed && row.externalModelCalls === 0 && row.activeReadOnly && row.registryReadOnly));
}
assert.deepStrictEqual({ active: shaFile(ACTIVE), registry: shaFile(REGISTRY) }, before);

console.log(JSON.stringify({
  test: 'lari-mixed-domain-program-growth',
  passed: true,
  candidateHash: qualification.candidate.sha256,
  newDomains: '2/2',
  hiddenTransfer: '6/6',
  reload: '6/6',
  exactDependencyAblation: '12/12',
  inheritedProgramTransfer: '5/5',
  inheritedRecap: '7/7',
  exactSurfaceParity: '2 families x 4/4 surfaces',
  atomicPromotionRehearsal: true,
  exactRollbackRehearsal: true,
  productionReadOnly: true,
  externalModelCalls: 0
}, null, 2));
