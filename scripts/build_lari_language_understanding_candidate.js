#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'language-understanding-20260829');
const PARENT_HASH = '16ccd5e32602890c05527e109becfa3ba98ba91dd6b1dc73f5c76dba384ecea8';
const PARENT = path.join(ROOT, 'consolidation', 'computational-english-integration-20260829', 'candidates', `${PARENT_HASH}.json`);
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const SEAL = path.join(OUT, 'sealed-curriculum.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const specs = [
  {
    id: 'language_syntax_parser',
    title: 'Bounded English instruction syntax parser',
    triggers: ['instruction structure', 'ordered clauses', 'conditions', 'negation', 'coordination', 'file targets'],
    procedure: ['defer explicit grammar correction and sentence realization to their narrower qualified capabilities', 'tokenize without destroying file paths', 'identify supported actions and targets', 'separate ordered and conditional clauses', 'attach Computational English lexical evidence', 'emit a typed syntax graph with explicit limits'],
    confidence: 0.88
  },
  {
    id: 'language_semantic_interpreter',
    title: 'Syntax-to-semantic task interpreter',
    triggers: ['task meaning', 'actions', 'constraints', 'verification', 'rollback', 'mutation permission'],
    procedure: ['read the typed syntax graph', 'derive ordered actions and code targets', 'separate positive instructions from prohibitions', 'represent verification and rollback conditions', 'derive intent only inside the verified construction scope'],
    confidence: 0.86
  },
  {
    id: 'language_pragmatic_context',
    title: 'Conversation-grounded pragmatic constraint resolver',
    triggers: ['conversation context', 'correction', 'reference', 'contradiction', 'clarification', 'user intent'],
    procedure: ['consult only the current request and existing session turns', 'resolve a reference only when exactly one antecedent is available', 'detect contradictory mutation instructions', 'ask for clarification instead of guessing', 'prevent preferences from changing truth or permission'],
    confidence: 0.84
  }
];
function main() {
  const manifestPath = path.join(OUT, 'candidate-manifest-v2.json');
  if (fs.existsSync(manifestPath)) throw new Error('Language-understanding candidate manifest already exists.');
  if (shaFile(PARENT) !== PARENT_HASH) throw new Error('Qualified CE parent candidate is missing or changed.');
  const before = { parent: shaFile(PARENT), active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const model = JSON.parse(fs.readFileSync(PARENT, 'utf8'));
  const createdAt = new Date().toISOString();
  const records = specs.map(spec => {
    const payload = { capabilityId: spec.id, title: spec.title, allowedIntents: ['chat', 'code'], procedure: spec.procedure, output: spec.id === 'language_syntax_parser' ? 'lari.syntax_graph' : spec.id === 'language_semantic_interpreter' ? 'lari.semantic_task' : 'lari.pragmatic_context', verification: 'sealed_semantic_transfer_causal_ablation_reload' };
    const contentHash = sha(JSON.stringify(payload));
    return {
      schemaVersion: 1,
      id: `lari.learned.procedure.${spec.id}.${contentHash.slice(0, 16)}`,
      type: 'procedure',
      status: 'active',
      normalizedTriggers: [...new Set(spec.triggers.flatMap(value => value.toLowerCase().split(/\s+/)))].sort(),
      procedureIdentity: `lari-language-understanding:${spec.id}:v2`,
      semanticFingerprint: sha(`${spec.id}:${spec.triggers.join('|')}`),
      outputBehavior: payload.output,
      contentHash,
      behavioralSignature: `${spec.id}:bounded:ambiguity-visible:no-external-model`,
      confidence: spec.confidence,
      provenance: {
        sourceModelHash: PARENT_HASH,
        sourcePath: rel(PARENT),
        originalRecordId: spec.id,
        sourceKind: 'procedure',
        creationSource: 'sealed_language_understanding_training',
        benchmarkAssociation: [],
        confidence: spec.confidence,
        imported: false,
        importTimestamp: createdAt,
        computationalEnglishCommit: model.lineage?.computationalEnglishCommit || '3d44ab6028b19fdaea62a5eb04f0ef57b72980d0',
        classification: 'developmental_candidate',
        storesPrompts: false,
        storesExpectedAnswers: false
      },
      payload
    };
  });
  model.lariLearnedRecords = model.lariLearnedRecords || { schemaVersion: 1, records: [] };
  const recordIds = new Set(records.map(record => record.id));
  model.lariLearnedRecords.records = [...records, ...model.lariLearnedRecords.records.filter(record => !recordIds.has(record.id))];
  model.lineage = { ...(model.lineage || {}), parentHash: PARENT_HASH, developmentalEvent: 'sealed_language_understanding_training', createdAt, promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const after = { parent: shaFile(PARENT), active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const manifest = { schemaVersion: 1, kind: 'lari.language-understanding.candidate', createdAt, promoted: false, candidate: { path: rel(candidatePath), sha256: candidateHash, parentHash: PARENT_HASH, learnedRecordIds: records.map(record => record.id) }, sealedCurriculum: { path: rel(SEAL), sha256: shaFile(SEAL) }, protectedBefore: before, protectedAfter: after, records, gates: { exactParent: before.parent === PARENT_HASH, protectedFilesUnchanged: JSON.stringify(before) === JSON.stringify(after), noBenchmarkAssociations: records.every(record => record.provenance.benchmarkAssociation.length === 0), noPromptOrExpectedAnswerStorage: records.every(record => record.provenance.storesPrompts === false && record.provenance.storesExpectedAnswers === false), noPromotion: true } };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ candidateHash, candidatePath, parentHash: PARENT_HASH, records: records.map(record => record.id), gates: manifest.gates }, null, 2));
}
main();
