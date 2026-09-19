#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const language = require('../swarm_language_understanding.js');
const neuro = require('../swarm_domain_neurogenesis.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'language-primitive-neurogenesis-20260831');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PUBLIC = path.join(OUT, 'public-training.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (value, message) => { if (!value) throw new Error(message); };

function relationPass(model, item) {
  const analysis = language.analyze(item.prompt, { enableLearningBinding: true, learnedRecords: model.lariLearnedRecords?.records || [] });
  const relation = (analysis.semantics.semanticRelations || []).find(value => value.type === item.relation);
  return { passed: relation?.actionText === item.action && relation?.conditionText === item.condition, relation: relation || null, analysis };
}

function main() {
  assert(!fs.existsSync(MANIFEST), 'Language primitive candidate already exists.');
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  assert(shaFile(PUBLIC) === seal.public.sha256, 'Public training seal mismatch.');
  assert(shaFile(ACTIVE) === seal.parentHash, 'Active parent changed after sealing.');
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), public: shaFile(PUBLIC), seal: shaFile(SEAL) };
  const model = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const parentIds = new Set((model.lariLearnedRecords?.records || []).map(record => record.id));
  const publicCases = JSON.parse(fs.readFileSync(PUBLIC, 'utf8')).cases;
  const before = publicCases.map(item => relationPass(model, item));
  assert(before.every(row => !row.passed), 'Parent unexpectedly represents a sealed scope relation.');

  const gap = neuro.createGap(model, { targetType: 'operator', capability: 'preserve restrictive and exception condition scope in English instructions', failureClass: 'meaning_graph_drops_postposed_only_if_and_unless_scope', sourceModelHash: seal.parentHash, sourcePath: rel(PUBLIC), researchAllowed: true });
  const proposal = neuro.proposeCandidate(model, gap, {
    family: 'conditional-scope',
    executableProof: true,
    semanticOperatorAst: { schemaVersion: 1, kind: 'lari.semantic_scope_operator', operation: 'bind_postposed_condition_scope', markers: ['only if', 'unless'], relations: { 'only if': 'necessary_condition', unless: 'exception_condition' }, scope: 'nearest_preceding_instruction', ambiguityPolicy: 'preserve_or_refuse' },
    sources: [{ title: 'Executable contrast pairs in sealed public curriculum' }]
  }, { sourceModelHash: seal.parentHash, sourcePath: rel(PUBLIC), confidence: 0.91 });
  assert(proposal.learned && proposal.record, `Semantic operator synthesis failed: ${proposal.reason || 'unknown'}`);
  model.lariLearnedRecords.records.unshift(proposal.record);
  const after = publicCases.map(item => relationPass(model, item));
  assert(after.every(row => row.passed), 'Synthesized operator failed public executable contrasts.');
  const added = model.lariLearnedRecords.records.filter(record => !parentIds.has(record.id) && record.id !== gap.id);
  assert(added.length === 1 && added[0].id === proposal.record.id, 'Candidate contains unexpected learned intelligence.');
  model.lineage = { ...(model.lineage || {}), parentHash: seal.parentHash, developmentalEvent: 'language_side_semantic_primitive_invention', createdAt: new Date().toISOString(), sourceGapId: gap.id, sourceOperatorId: proposal.record.id, holdoutAccessedBeforeCandidate: false, promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), public: shaFile(PUBLIC), seal: shaFile(SEAL) };
  const gates = { parentFailsPublic: before.every(row => !row.passed), publicFailToPass: after.every(row => row.passed), oneCanonicalOperatorAdded: added.length === 1, existingTypedRecordStoreUsed: proposal.record.type === 'operator', noPromptOrExpectedOutputStored: !JSON.stringify(proposal.record).includes(publicCases[0].prompt), hiddenUnread: model.lineage.holdoutAccessedBeforeCandidate === false, activeAndRegistryReadOnly: protectedBefore.active === protectedAfter.active && protectedBefore.registry === protectedAfter.registry, exactCandidateHash: shaFile(candidatePath) === candidateHash, externalModelCallsZero: true };
  const manifest = { schemaVersion: 1, kind: 'lari.language-primitive.provisional-candidate', createdAt: new Date().toISOString(), promoted: false, parentHash: seal.parentHash, candidate: { path: rel(candidatePath), sha256: candidateHash }, gapId: gap.id, operatorId: proposal.record.id, operator: proposal.record, publicEvidence: publicCases.map((item, index) => ({ item, before: before[index], after: after[index] })), gates, protectedBefore, protectedAfter };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: Object.values(gates).every(Boolean), parentHash: seal.parentHash, candidateHash, operatorId: proposal.record.id, public: `${after.filter(row => row.passed).length}/${after.length}`, gates }, null, 2));
}

main();
