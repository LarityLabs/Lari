#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const candidateDir = path.join(root, 'consolidation', 'learning-candidates');
const baseHash = 'c3b092fd296eed284d23d18a039882d88bc2619da70e78a6da076eb2703f2240';
const sources = [
  {
    hash: 'a83ccef66ef416e8d198d7940bdaf31aafa3fdb5b94d30019624caf4ad02df6d',
    recordId: 'lari.learned.operator.semantic.a8b052c6',
    instanceId: 'matplotlib__matplotlib-26466',
    proof: { failToPass: '1/1', passToPass: '100/100' }
  },
  {
    hash: 'd3fe559620505d6c5b58f15ed4b6dd32ddba8e9de9b4b853cc443de1d2e46cfc',
    recordId: 'lari.learned.operator.semantic.22bc8bb1',
    instanceId: 'pytest-dev__pytest-7236',
    proof: { failToPass: '1/1', passToPass: '52/52' }
  },
  {
    hash: '61bc415ad1bc324bdac30822ebabb4a31e8169a6208d3079fa592019501c0244',
    recordId: 'lari.learned.operator.semantic.e20b3f0a',
    instanceId: 'scikit-learn__scikit-learn-25232',
    proof: { failToPass: '1/1', passToPass: '214/214' }
  }
];

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = hash => {
  const file = path.join(candidateDir, `${hash}.json`);
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== hash) throw new Error(`candidate hash mismatch: ${hash}`);
  return JSON.parse(bytes);
};

const base = read(baseHash);
const records = [...(base.lariLearnedRecords?.records || [])];
const baseIds = new Set(records.map(record => record.id));
const imported = sources.map(source => {
  const model = read(source.hash);
  if (model.lineage?.parentHash !== baseHash) throw new Error(`wrong parent: ${source.hash}`);
  const record = model.lariLearnedRecords?.records?.find(item => item.id === source.recordId);
  if (!record || record.status !== 'active' || record.type !== 'operator') {
    throw new Error(`missing active operator: ${source.recordId}`);
  }
  if (baseIds.has(record.id)) throw new Error(`record already present in base: ${record.id}`);
  return JSON.parse(JSON.stringify(record));
});

const candidate = JSON.parse(JSON.stringify(base));
candidate.lariLearnedRecords.records = [...records, ...imported];
candidate.lineage = {
  parentHash: baseHash,
  developmentalEvent: 'official_swebench_verified_bundle',
  createdAt: new Date().toISOString()
};
candidate.lariLinuxSWEVerified = {
  schemaVersion: 1,
  promoted: false,
  soleReasoner: 'Lari',
  externalModelCalls: 0,
  canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
  imported: sources.map(source => ({
    sourceCandidateHash: source.hash,
    recordId: source.recordId,
    instanceId: source.instanceId,
    proof: source.proof
  })),
  quarantined: [
    { instanceId: 'pylint-dev__pylint-4604', reason: 'public false positive; official target and maintenance tests failed' },
    { instanceId: 'astropy__astropy-8707', reason: 'official evaluator dependency skew prevented a valid class-test grade' },
    { instanceId: 'psf__requests-6028', reason: 'required paid proxy reproducer unavailable; no substitute evidence accepted' }
  ]
};

const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
const candidateHash = sha(Buffer.from(serialized));
const candidatePath = path.join(candidateDir, `${candidateHash}.json`);
if (!fs.existsSync(candidatePath)) fs.writeFileSync(candidatePath, serialized, { flag: 'wx' });
if (sha(fs.readFileSync(candidatePath)) !== candidateHash) throw new Error('sealed candidate changed');
fs.chmodSync(candidatePath, 0o444);

const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const reloadedIds = new Set(reloaded.lariLearnedRecords.records.map(record => record.id));
const gates = {
  exactBaseRetained: records.every((record, index) => JSON.stringify(record) === JSON.stringify(reloaded.lariLearnedRecords.records[index])),
  allProvenRecordsPresent: sources.every(source => reloadedIds.has(source.recordId)),
  exactlyThreeRecordsAdded: reloaded.lariLearnedRecords.records.length === records.length + 3,
  reloadRetention: sources.every(source => reloadedIds.has(source.recordId)),
  immutableHash: sha(fs.readFileSync(candidatePath)) === candidateHash,
  notPromoted: reloaded.lariLinuxSWEVerified.promoted === false
};
if (!Object.values(gates).every(Boolean)) throw new Error(`seal gates failed: ${JSON.stringify(gates)}`);
process.stdout.write(`${JSON.stringify({ candidateHash, candidatePath: path.relative(root, candidatePath).replace(/\\/g, '/'), recordIds: sources.map(source => source.recordId), gates }, null, 2)}\n`);
