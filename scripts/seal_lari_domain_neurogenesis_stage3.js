#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage3-20260830');
const PARENT_HASH = '66868903579c864e3d6c1b49ddb07ae10ea7600649802fd4d32745b70c704706';
const PARENT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage2-20260830', 'candidates', `${PARENT_HASH}.json`);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const write = (name, value) => { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); fs.writeFileSync(path.join(OUT, name), bytes, { flag: 'wx' }); return { path: name, sha256: sha(bytes) }; };

function main() {
  if (fs.existsSync(OUT)) throw new Error('Stage 3 seal already exists.');
  if (shaFile(PARENT) !== PARENT_HASH) throw new Error('Stage 2 parent changed.');
  fs.mkdirSync(OUT, { recursive: false });
  const createdAt = new Date().toISOString();
  const publicDevelopment = {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis-stage3.public-development',
    createdAt,
    parentHash: PARENT_HASH,
    targetType: 'knowledge',
    discoveryPrompt: 'What is a Merkle tree?',
    expectedFailureSource: 'relevance_fail_closed',
    researchPolicy: {
      requestPattern: 'Research and learn {topic}',
      userSuppliedSourcesAllowed: false,
      sourceProviderAllowed: false,
      onlineGroundedResearchRequired: true,
      minimumRetrievedSources: 2,
      externalModelCallsAllowed: false
    }
  };
  const hidden = {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis-stage3.hidden-holdouts',
    createdAt,
    parentHash: PARENT_HASH,
    cases: [
      { id: 'knowledge.1', prompt: 'Explain Merkle trees.', requiredConcepts: ['cryptographic hash', 'data'] },
      { id: 'knowledge.2', prompt: 'Tell me about a Merkle tree.', requiredConcepts: ['tree', 'hash'] },
      { id: 'knowledge.3', prompt: 'What do you know about Merkle trees?', requiredConcepts: ['verification', 'data structure'] },
      { id: 'knowledge.4', prompt: 'Please explain the Merkle tree concept.', requiredConcepts: ['leaf', 'node'] }
    ]
  };
  const publicFile = write('public-development.json', publicDevelopment);
  const hiddenFile = write('hidden-holdouts.json', hidden);
  const seal = {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis-stage3.seal',
    createdAt,
    parentHash: PARENT_HASH,
    publicDevelopment: { ...publicFile, learnerReadable: true },
    hiddenHoldouts: { ...hiddenFile, cases: hidden.cases.length, learnerReadable: false },
    productionMutationAllowed: false,
    promotionAllowed: false
  };
  write('sealed-index.json', seal);
  console.log(JSON.stringify({ passed: true, output: path.relative(ROOT, OUT).replace(/\\/g, '/'), parentHash: PARENT_HASH, publicHash: publicFile.sha256, hiddenHash: hiddenFile.sha256 }, null, 2));
}
main();
