#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'predicate-domain-transfer-20260902');
const CANDIDATE_DIR = path.join(OUT, 'combined-candidates');
const MANIFEST = path.join(OUT, 'combined-candidate-manifest.json');
const CONTEXT_HASH = '5ab4f7b7dcdcd2203d4a11bf9eadd99189a90c58d22f7f1a1137a4813e550d2d';
const PREDICATE_HASH = '0a3ce1e0c6bf51b5d61ddca8b0c089661905246d7ce5ae6577cddea8fad8c0fd';
const CONTEXT_ID = 'lari.learned.operator.semantic_mutation.11f90a0b66147743';
const PREDICATE_ID = 'lari.learned.operator.semantic_mutation.b1de2702dd1ace54';
const sourcePath = hash => path.join(ROOT, 'consolidation', 'open-world-apprenticeship-20260901', 'provisional-candidates', `${hash}.json`);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function main() {
  assert(!fs.existsSync(MANIFEST), 'Immutable combined-candidate manifest already exists.');
  const contextPath = sourcePath(CONTEXT_HASH);
  const predicatePath = sourcePath(PREDICATE_HASH);
  assert.strictEqual(shaFile(contextPath), CONTEXT_HASH, 'Context candidate hash mismatch.');
  assert.strictEqual(shaFile(predicatePath), PREDICATE_HASH, 'Predicate candidate hash mismatch.');
  const candidate = read(contextPath);
  const predicate = read(predicatePath);
  const contextRecord = (candidate.lariLearnedRecords?.records || []).find(record => record?.id === CONTEXT_ID);
  const predicateRecord = (predicate.lariLearnedRecords?.records || []).find(record => record?.id === PREDICATE_ID);
  assert(contextRecord, 'Context primitive is missing from its source candidate.');
  assert(predicateRecord, 'Predicate primitive is missing from its source candidate.');
  assert(!(candidate.lariLearnedRecords?.records || []).some(record => record?.id === PREDICATE_ID), 'Predicate primitive already exists in base.');

  candidate.lariLearnedRecords.records = [predicateRecord, ...candidate.lariLearnedRecords.records];
  candidate.lineage = {
    parentHashes: [CONTEXT_HASH, PREDICATE_HASH],
    developmentalEvent: 'lossless_dual_semantic_primitive_consolidation',
    createdAt: new Date().toISOString(),
    promoted: false,
    learnedRecordIds: [CONTEXT_ID, PREDICATE_ID],
    evidence: {
      contextPrimitiveQualification: 'consolidation/open-world-apprenticeship-20260901/semantic-primitive-qualification.json',
      predicatePrimitiveLearning: 'consolidation/open-world-apprenticeship-20260901/learning-retry14-report.json',
      predicateExternalTransfer: 'consolidation/predicate-domain-transfer-20260902/external-transfer-attempt8-report.json'
    },
    previous: candidate.lineage || null
  };

  const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha(bytes);
  fs.mkdirSync(CANDIDATE_DIR, { recursive: true });
  const candidatePath = path.join(CANDIDATE_DIR, `${candidateHash}.json`);
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const records = candidate.lariLearnedRecords.records.filter(record => [CONTEXT_ID, PREDICATE_ID].includes(record?.id));
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.combined-semantic-primitive-candidate',
    createdAt: candidate.lineage.createdAt,
    promoted: false,
    candidate: {
      path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'),
      sha256: candidateHash,
      size: bytes.length
    },
    parents: [
      { role: 'context-primitive-base', sha256: CONTEXT_HASH, path: path.relative(ROOT, contextPath).replace(/\\/g, '/') },
      { role: 'predicate-primitive-import', sha256: PREDICATE_HASH, path: path.relative(ROOT, predicatePath).replace(/\\/g, '/') }
    ],
    records: records.map(record => ({
      id: record.id,
      kind: record.payload?.primitive?.kind,
      composition: record.payload?.primitive?.composition,
      storesSourceCode: record.provenance?.storesSourceCode,
      storesTestAnswers: record.provenance?.storesTestAnswers
    })),
    activeRegistryModified: false
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main();
