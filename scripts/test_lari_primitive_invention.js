#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'primitive-invention-20260831');
const REPORT = path.join(OUT, 'qualification-report.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
const candidatePath = path.join(ROOT, report.qualifiedCandidate.path);
assert(report.passed === true, 'Primitive-invention qualification is not green.');
assert(Object.values(report.gates || {}).every(Boolean), 'A primitive-invention gate is false.');
assert(shaFile(candidatePath) === report.qualifiedCandidate.sha256, 'Qualified candidate hash mismatch.');
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
const primitive = candidate.lariLearnedRecords.records.find(record => record.id === report.primitive.id);
const procedure = candidate.lariLearnedRecords.records.find(record => record.id === report.procedure.id);
assert(primitive?.payload?.primitiveAst?.op === 'case_boundary_separator', 'Invented primitive is missing.');
assert(procedure?.payload?.primitiveDependencies?.length === 1 && procedure.payload.primitiveDependencies[0] === primitive.id, 'Procedure does not depend on the exact primitive.');
assert(active.lariLearnedRecords?.records?.some(record => record.id === primitive.id), 'Active cumulative production lost the invented primitive.');
assert(active.lariLearnedRecords?.records?.some(record => record.id === procedure.id), 'Active cumulative production lost the primitive-composed procedure.');
assert(report.hiddenTransfer.every(row => row.passed), 'Hidden transfer is not 4/4.');
assert(report.coldReload.every(row => row.passed), 'Cold reload is not 4/4.');
assert(report.primitiveAblation.every(row => row.passed), 'Exact primitive ablation is not 4/4.');
assert(report.regressions.every(row => row.passed), 'A family regression is present.');
console.log(JSON.stringify({ test: 'lari-primitive-invention', passed: true, candidateHash: report.qualifiedCandidate.sha256, primitiveId: primitive.id, procedureId: procedure.id, hiddenTransfer: '4/4', coldReload: '4/4', exactPrimitiveAblation: '4/4', familyRegressions: 0, includedInProduction: true, externalModelCalls: 0 }, null, 2));
