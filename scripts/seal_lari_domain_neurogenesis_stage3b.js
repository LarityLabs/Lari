#!/usr/bin/env node
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage3b-20260830');
const PARENT_HASH = '66868903579c864e3d6c1b49ddb07ae10ea7600649802fd4d32745b70c704706';
const PARENT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage2-20260830', 'candidates', `${PARENT_HASH}.json`);
const sha = value => crypto.createHash('sha256').update(value).digest('hex'), shaFile = file => sha(fs.readFileSync(file));
const write = (name, value) => { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); fs.writeFileSync(path.join(OUT, name), bytes, { flag: 'wx' }); return { path: name, sha256: sha(bytes) }; };
function main() {
  if (fs.existsSync(OUT)) throw new Error('Stage 3b seal already exists.');
  if (shaFile(PARENT) !== PARENT_HASH) throw new Error('Stage 2 parent changed.');
  fs.mkdirSync(OUT, { recursive: false });
  const createdAt = new Date().toISOString();
  const publicDevelopment = { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage3b.public-development', createdAt, parentHash: PARENT_HASH, targetType: 'knowledge', discoveryPrompt: 'What is a Merkle tree?', expectedFailureSource: 'relevance_fail_closed', researchPolicy: { requestPattern: 'Research and learn {topic}', userSuppliedSourcesAllowed: false, sourceProviderAllowed: false, onlineGroundedResearchRequired: true, minimumRetrievedSources: 2, externalModelCallsAllowed: false } };
  const hidden = { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage3b.hidden-holdouts', createdAt, parentHash: PARENT_HASH, cases: [
    { id: 'fresh.1', prompt: 'Explain the Merkle tree.', requiredConcepts: ['cryptographic hash', 'data block'] },
    { id: 'fresh.2', prompt: 'Tell me about Merkle trees.', requiredConcepts: ['verification', 'data structure'] },
    { id: 'fresh.3', prompt: 'What do you know about the Merkle tree?', requiredConcepts: ['leaf', 'child nodes'] },
    { id: 'fresh.4', prompt: 'Please explain hash trees.', requiredConcepts: ['hash tree', 'cryptographic'] }
  ] };
  const publicFile = write('public-development.json', publicDevelopment), hiddenFile = write('hidden-holdouts.json', hidden);
  write('sealed-index.json', { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage3b.seal', createdAt, parentHash: PARENT_HASH, supersedesExposedSeal: 'consolidation/domain-neurogenesis-stage3-20260830/sealed-index.json', publicDevelopment: { ...publicFile, learnerReadable: true }, hiddenHoldouts: { ...hiddenFile, cases: hidden.cases.length, learnerReadable: false }, productionMutationAllowed: false, promotionAllowed: false });
  console.log(JSON.stringify({ passed: true, output: path.relative(ROOT, OUT).replace(/\\/g, '/'), parentHash: PARENT_HASH, publicHash: publicFile.sha256, hiddenHash: hiddenFile.sha256 }, null, 2));
}
main();
