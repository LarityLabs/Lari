#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'conversational-learning-binding-20260829');
const PARENT_HASH = 'b90beb1028e61a94058a0af3252d72030b4cbab7f12b3ec19f8f6ad6fa1e8503';
const PARENT = path.join(ROOT, 'consolidation', 'language-understanding-20260829', 'candidates', `${PARENT_HASH}.json`);
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const SEAL = path.join(OUT, 'sealed-curriculum.json');
const MANIFEST = path.join(OUT, 'candidate-manifest-v2.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

function main() {
  if (fs.existsSync(MANIFEST)) throw new Error('Conversational-learning binding manifest already exists.');
  if (shaFile(PARENT) !== PARENT_HASH) throw new Error('Qualified language-understanding parent is missing or changed.');
  const protectedBefore = { parent: shaFile(PARENT), active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const model = JSON.parse(fs.readFileSync(PARENT, 'utf8'));
  const createdAt = new Date().toISOString();
  const payload = {
    capabilityId: 'conversational_learning_semantic_binding',
    title: 'Conversation meaning to existing Lari learning lifecycle binding',
    allowedIntents: ['research', 'code', 'chat'],
    procedure: [
      'extract one explicit learning target and optional purpose from the qualified semantic task',
      'carry evidence and success criteria into the existing curiosity goal',
      'send factual targets through autonomous knowledge acquisition as hypotheses requiring evidence',
      'send executable targets through the existing failure and practice lifecycle',
      'retain source reading for executable targets as evidence pending practice, never as capability proof',
      'require unseen transfer and reload retention when requested before capability promotion',
      'treat retention pronouns inside a parsed learning request as referring to the learned result rather than an unresolved conversation entity',
      'keep durable preferences in the existing preference store instead of the research lifecycle'
    ],
    output: 'lari.conversational_learning_binding',
    verification: 'sealed_semantic_causal_transfer_reload_rollback',
    promotionAllowedFromReading: false
  };
  const contentHash = sha(JSON.stringify(payload));
  const record = {
    schemaVersion: 1,
    id: `lari.learned.procedure.conversational_learning_semantic_binding.${contentHash.slice(0, 16)}`,
    type: 'procedure', status: 'active',
    normalizedTriggers: ['learn', 'research', 'retain', 'study', 'teach'],
    procedureIdentity: 'lari-conversational-learning-semantic-binding:v2',
    semanticFingerprint: sha('learning target purpose evidence execution transfer reload preference firewall'),
    outputBehavior: payload.output,
    contentHash,
    behavioralSignature: 'semantic-task:existing-learning-lifecycle:no-reading-promotion:no-external-model',
    confidence: 0.86,
    provenance: {
      sourceModelHash: PARENT_HASH, sourcePath: rel(PARENT), originalRecordId: payload.capabilityId,
      sourceKind: 'procedure', creationSource: 'sealed_conversational_learning_binding',
      benchmarkAssociation: [], confidence: 0.86, imported: false, importTimestamp: createdAt,
      classification: 'developmental_candidate', storesPrompts: false, storesExpectedAnswers: false
    },
    payload
  };
  model.lariLearnedRecords = model.lariLearnedRecords || { schemaVersion: 1, records: [] };
  model.lariLearnedRecords.records = [record, ...model.lariLearnedRecords.records.filter(item => item.id !== record.id)];
  model.lineage = { ...(model.lineage || {}), parentHash: PARENT_HASH, developmentalEvent: 'sealed_conversational_learning_binding', createdAt, promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const protectedAfter = { parent: shaFile(PARENT), active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const manifest = {
    schemaVersion: 1, kind: 'lari.conversational-learning-binding.candidate', createdAt, promoted: false,
    candidate: { path: rel(candidatePath), sha256: candidateHash, parentHash: PARENT_HASH, learnedRecordIds: [record.id] },
    sealedCurriculum: { path: rel(SEAL), sha256: shaFile(SEAL) }, record,
    protectedBefore, protectedAfter,
    gates: { exactParent: protectedBefore.parent === PARENT_HASH, protectedFilesUnchanged: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter), noBenchmarkAssociation: true, noPromptStorage: true, noPromotion: true }
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ candidateHash, candidatePath, parentHash: PARENT_HASH, recordId: record.id, gates: manifest.gates }, null, 2));
}
main();
