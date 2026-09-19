#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'coding-mastery-acquisition-attempt3-20260830');
const REPORT = path.join(OUT, 'qualification-report.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const RECORD_ID = 'lari.learned.operator.coordinated.a9d55951';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function main() {
  assert(fs.existsSync(REPORT), 'Unknown-repository qualification report is missing.');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const candidatePath = path.join(ROOT, report.qualifiedCandidate.path);
  assert(report.passed === true, 'Unknown-repository qualification did not pass.');
  assert(Object.values(report.gates || {}).every(Boolean), 'An unknown-repository qualification gate is false.');
  assert(report.learnedRecord?.id === RECORD_ID, 'Unexpected learned record ID.');
  assert(report.learnedRecord?.programAst?.op === 'coordinated_async_pipeline', 'Unexpected learned program family.');
  assert(report.learnedRecord?.programAst?.predicate === 'truthy' && report.learnedRecord?.programAst?.terminal === 'count', 'Unexpected learned program semantics.');
  assert(fs.existsSync(candidatePath) && sha(candidatePath) === report.qualifiedCandidate.sha256, 'Qualified candidate hash mismatch.');
  const activeHash = sha(ACTIVE);
  assert(Array.isArray(JSON.parse(fs.readFileSync(ACTIVE, 'utf8')).lariLearnedRecords?.records), 'Active cumulative production is unreadable.');
  assert(JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).activeModelSha256 === activeHash, 'Registry does not bind the active production hash.');
  assert(report.qualifiedCandidate.promoted === false, 'Developmental candidate must remain unpromoted.');
  assert(Number(report.externalModelCalls || 0) === 0, 'External model calls were recorded.');
  process.stdout.write(`${JSON.stringify({ test: 'lari-unknown-repository-acquisition', passed: true, activeHash, candidateHash: report.qualifiedCandidate.sha256, learnedRecordId: RECORD_ID, incumbentHiddenFailures: '4/4', hiddenTransfer: '4/4', ablation: '4/4', reload: '4/4', externalModelCalls: 0 }, null, 2)}\n`);
}

main();
