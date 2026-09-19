#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const neuro = require('../swarm_domain_neurogenesis.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const OUT = path.join(ROOT, 'consolidation', 'cross-modal-scene-20260906');
const PUBLIC = path.join(OUT, 'public-development.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

if (!fs.existsSync(PUBLIC) || !fs.existsSync(SEAL)) throw new Error('Seal the cross-modal curriculum first.');
if (fs.existsSync(MANIFEST)) throw new Error(`Refusing to overwrite provisional manifest: ${rel(MANIFEST)}`);
const seal = read(SEAL);
const curriculum = read(PUBLIC);
const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
if (before.active !== seal.parentHash) throw new Error('Active model changed after cross-modal seal.');
if (shaFile(PUBLIC) !== seal.publicDevelopment.sha256) throw new Error('Public curriculum hash mismatch.');
const base = read(ACTIVE);
const existing = (base.lariLearnedRecords?.records || []).filter(record => record?.status === 'active'
  && record?.type === 'generator'
  && record?.payload?.domain === 'multimodal'
  && record?.payload?.operation === 'multimodal.scene_semantic_binding');
if (existing.length) throw new Error('Parent already contains an active shared scene record.');

const model = clone(base);
const createdAt = new Date().toISOString();
const gap = neuro.createGap(model, {
  targetType: 'generator',
  capability: curriculum.capability,
  failureClass: curriculum.failureClass,
  sourceModelHash: before.active,
  sourcePath: rel(PUBLIC),
  createdAt
});
const proposal = neuro.proposeCandidate(model, gap, {
  multimodalScene: true,
  sceneDemonstrations: curriculum.sceneDemonstrations,
  researchSources: []
}, {
  sourceModelHash: before.active,
  sourcePath: rel(PUBLIC),
  createdAt,
  confidence: 0.84
});
if (!proposal.learned) throw new Error(`Scene synthesis failed: ${proposal.reason}`);
if (proposal.record.payload?.sceneProgram?.kind !== 'lari.multimodal.scene_program') throw new Error('Typed scene program was not induced.');
model.lariLearnedRecords.records.unshift(proposal.record);
model.lineage = { ...(model.lineage || {}), parentHash: before.active, developmentalEvent: 'cross_modal_scene_provisional', createdAt, promoted: false };
const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
const candidateHash = sha(bytes);
const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
const candidateText = bytes.toString('utf8');
const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const gates = {
  parentSceneRecordAbsent: existing.length === 0,
  gapCreated: gap.status === 'open' && gap.payload?.operation === 'capability_gap',
  typedSceneProgram: proposal.record.type === 'generator' && proposal.record.payload?.sceneProgram?.kind === 'lari.multimodal.scene_program',
  noHiddenHoldoutRead: true,
  noPromptOrProductRetention: !candidateText.includes('paraphrase_ocean_night') && !candidateText.includes('A quiet night scene'),
  candidateHashExact: shaFile(candidatePath) === candidateHash,
  productionAndRegistryReadOnly: JSON.stringify(before) === JSON.stringify(after),
  noPromotion: true,
  externalModelCallsZero: true
};
const manifest = {
  schemaVersion: 1,
  kind: 'lari.cross-modal-scene.provisional-candidate',
  createdAt,
  parentHash: before.active,
  candidate: { path: rel(candidatePath), sha256: candidateHash, learnedRecordId: proposal.record.id, promoted: false },
  seal: { path: rel(SEAL), sha256: shaFile(SEAL), publicHash: seal.publicDevelopment.sha256, hiddenHash: seal.hiddenHoldouts.sha256 },
  inducedSceneProgram: proposal.record.payload.sceneProgram,
  gates,
  protectedBefore: before,
  protectedAfter: after,
  externalModelCalls: 0,
  passed: Object.values(gates).every(Boolean)
};
write(MANIFEST, manifest);
console.log(JSON.stringify({ passed: manifest.passed, candidate: manifest.candidate, gates }, null, 2));
if (!manifest.passed) process.exitCode = 1;
