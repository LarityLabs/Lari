#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const recap = require('../swarm_recap_language.js');
const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const REPORT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-20260830', 'qualification-report.json');
const SURFACES = path.join(ROOT, 'consolidation', 'domain-neurogenesis-20260830', 'surface-parity.json');
const STAGE2_REPORT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage2-20260830', 'qualification-report.json');
const STAGE2_SURFACES = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage2-20260830', 'surface-parity.json');
const STAGE3_REPORT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage3b-20260830', 'qualification-report-v2.json');
const STAGE3_SURFACES = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage3b-20260830', 'surface-parity.json');
const STAGE4_REPORT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage4-20260830', 'qualification-report.json');
const STAGE5_REPORT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage5-20260830', 'qualification-report.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ACTIVE_HASH = sha(ACTIVE);
const clone = value => JSON.parse(JSON.stringify(value));
const before = { active: sha(ACTIVE), registry: sha(REGISTRY) };

assert.strictEqual(JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).activeModelSha256, ACTIVE_HASH, 'registry does not bind active production');
const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
const surfaces = JSON.parse(fs.readFileSync(SURFACES, 'utf8'));
const stage2 = JSON.parse(fs.readFileSync(STAGE2_REPORT, 'utf8'));
const stage2Surfaces = JSON.parse(fs.readFileSync(STAGE2_SURFACES, 'utf8'));
const stage3 = JSON.parse(fs.readFileSync(STAGE3_REPORT, 'utf8'));
const stage3Surfaces = JSON.parse(fs.readFileSync(STAGE3_SURFACES, 'utf8'));
const stage4 = JSON.parse(fs.readFileSync(STAGE4_REPORT, 'utf8'));
const stage5 = JSON.parse(fs.readFileSync(STAGE5_REPORT, 'utf8'));
assert.strictEqual(report.passed, true);
assert.strictEqual(surfaces.passed, true);
assert.strictEqual(stage2.passed, true);
assert.strictEqual(stage2Surfaces.passed, true);
assert.strictEqual(stage3.passed, true);
assert.strictEqual(stage3Surfaces.passed, true);
assert.strictEqual(stage4.passed, true);
assert.strictEqual(stage5.passed, true);
assert(Object.values(report.gates).every(Boolean));
assert(Object.values(surfaces.gates).every(Boolean));
assert(Object.values(stage2.gates).every(Boolean));
assert(Object.values(stage2Surfaces.gates).every(Boolean));
assert(Object.values(stage3.gates).every(Boolean));
assert(Object.values(stage3Surfaces.gates).every(Boolean));
assert(Object.values(stage4.gates).every(Boolean));
assert(Object.values(stage5.gates).every(Boolean));
const candidatePath = path.join(ROOT, report.candidate.path);
assert.strictEqual(sha(candidatePath), report.candidate.sha256);
const model = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const records = model.lariLearnedRecords.records.filter(record => record.provenance?.creationSource === 'lari_domain_neurogenesis');
const learned = records.filter(record => record.payload?.operation !== 'capability_gap');
const gaps = records.filter(record => record.payload?.operation === 'capability_gap');
assert.deepStrictEqual([...new Set(learned.map(record => record.type))].sort(), ['generator', 'knowledge', 'operator', 'preference', 'procedure', 'repair']);
assert.strictEqual(gaps.length, 6);
assert(gaps.every(gap => gap.status === 'closed' && gap.payload.closedBy?.recordId));
const prompt = 'Teach version control using a laboratory notebook. Shared relation: both preserve an ordered history of changes. Boundary: version control can merge changes from multiple authors.';
const generated = recap.realize(model, prompt);
assert.strictEqual(generated?.family, 'teaching_analogy');
assert.strictEqual(generated?.verification?.passed, true);
const generator = learned.find(record => record.type === 'generator');
const ablated = clone(model);
ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== generator.id);
assert.strictEqual(recap.realize(ablated, prompt), null);
assert.deepStrictEqual({ active: sha(ACTIVE), registry: sha(REGISTRY) }, before);
const stage3Path = path.join(ROOT, stage3.candidate.path);
assert.strictEqual(sha(stage3Path), stage3.candidate.sha256);
assert.strictEqual(stage3.rows.filter(row => row.passed).length, 4);
assert.strictEqual(stage3.reloadRows.filter(row => row.passed).length, 4);
assert.strictEqual(stage3.ablationRows.filter(row => row.behaviorLost).length, 4);
assert.strictEqual(stage3Surfaces.rows.filter(row => row.sameAnswer && row.sameSelection && row.recordSelected).length, 4);
assert.deepStrictEqual({ active: sha(ACTIVE), registry: sha(REGISTRY) }, before);
const stage2Path = path.join(ROOT, stage2.candidate.path);
assert.strictEqual(sha(stage2Path), stage2.candidate.sha256);
assert.strictEqual(stage2.rows.filter(row => row.passed).length, 12);
assert.strictEqual(stage2.reloadRows.filter(row => row.passed).length, 12);
assert.strictEqual(stage2.ablations.filter(row => row.behaviorLost).length, 4);
assert.strictEqual(stage2Surfaces.rows.filter(row => row.sameAnswer && row.sameSelection && row.expectedSelected).length, 12);
assert.deepStrictEqual({ active: sha(ACTIVE), registry: sha(REGISTRY) }, before);
const stage4Path = path.join(ROOT, stage4.candidate.path);
assert.strictEqual(sha(stage4Path), stage4.candidate.sha256);
assert.strictEqual(stage4.rows.filter(row => row.passed).length, 4);
assert.strictEqual(stage4.reloadRows.filter(row => row.passed).length, 4);
assert.strictEqual(stage4.ablationRows.filter(row => !row.passed).length, 4);
assert.strictEqual(stage4.qualifiedRows.filter(row => row.passed).length, 4);
assert.strictEqual(stage4.externalModelCalls, 0);
assert.deepStrictEqual({ active: sha(ACTIVE), registry: sha(REGISTRY) }, before);
const stage5Path = path.join(ROOT, stage5.candidate.path);
assert.strictEqual(sha(stage5Path), stage5.candidate.sha256);
assert.strictEqual(stage5.rows.filter(row => row.passed).length, 4);
assert.strictEqual(stage5.reloadRows.filter(row => row.passed).length, 4);
assert.strictEqual(stage5.ablationRows.filter(row => !row.passed).length, 4);
assert.strictEqual(stage5.qualifiedRows.filter(row => row.passed).length, 4);
assert.strictEqual(stage5.rows.filter(row => row.result.repair?.mode === 'retained_coordinated_procedure' && row.result.repair?.targets?.length === 2).length, 4);
assert.strictEqual(stage5.externalModelCalls, 0);
assert.deepStrictEqual({ active: sha(ACTIVE), registry: sha(REGISTRY) }, before);

console.log(JSON.stringify({
  test: 'lari-domain-neurogenesis',
  passed: true,
  candidateHash: stage5.candidate.sha256,
  canonicalTypes: '6/6',
  hiddenTransfer: '18/18',
  ablation: '6/6',
  reload: '18/18',
  publicLanguageSurfaces: '6/6 x 5',
  ordinaryTypedRecordTransfer: '12/12',
  ordinaryTypedRecordReload: '12/12',
  ordinaryTypedRecordAblation: '4/4',
  ordinaryTypedRecordSurfaces: '12/12 x 5',
  developmentalFailureGap: true,
  autonomousOnlineResearchSources: stage3.developmental.research.retrievedSourceCount,
  autonomousResearchHiddenTransfer: '4/4',
  autonomousResearchReload: '4/4',
  autonomousResearchAblation: '4/4',
  autonomousResearchSurfaces: '4/4 x 5',
  executableCodingNeurogenesisHiddenTransfer: '4/4',
  executableCodingNeurogenesisReload: '4/4',
  executableCodingNeurogenesisAblation: '4/4',
  executableCodingNeurogenesisQualifiedReload: '4/4',
  multiFileProcedureNeurogenesisHiddenTransfer: '4/4',
  multiFileProcedureNeurogenesisReload: '4/4',
  multiFileProcedureNeurogenesisAblation: '4/4',
  multiFileProcedureNeurogenesisTwoFileReuse: '4/4',
  productionReadOnly: true,
  externalModelCalls: 0
}, null, 2));
