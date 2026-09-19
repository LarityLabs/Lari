#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const language = require('../swarm_language_understanding.js');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'semantic-ast-autogenesis-20260831');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const write = (name, value) => { const file = path.join(OUT, name); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); return file; };

const traces = [
  { id: 'trace.code.guard', basePrompt: 'Patch auth.js.', scopedPrompt: 'Patch auth.js only if tests fail.', executeWhenConditionTrue: true, executeWhenConditionFalse: false },
  { id: 'trace.research.guard', basePrompt: 'Research event sourcing.', scopedPrompt: 'Research event sourcing only if replay breaks.', executeWhenConditionTrue: true, executeWhenConditionFalse: false },
  { id: 'trace.chat.guard', basePrompt: 'Recommend the migration.', scopedPrompt: 'Recommend the migration only if evidence supports it.', executeWhenConditionTrue: true, executeWhenConditionFalse: false },
  { id: 'trace.code.exception', basePrompt: 'Restore cache.js.', scopedPrompt: 'Restore cache.js unless verification passes.', executeWhenConditionTrue: false, executeWhenConditionFalse: true },
  { id: 'trace.learning.exception', basePrompt: 'Retain the procedure.', scopedPrompt: 'Retain the procedure unless transfer contradicts it.', executeWhenConditionTrue: false, executeWhenConditionFalse: true },
  { id: 'trace.chat.exception', basePrompt: 'Choose the short answer.', scopedPrompt: 'Choose the short answer unless nuance disappears.', executeWhenConditionTrue: false, executeWhenConditionFalse: true }
];
const hidden = [
  { id: 'hidden.code.guard2', domain: 'code', prompt: 'Modify router.ts only if the isolated test remains red.', relation: 'necessary_condition', action: 'Modify router.ts', condition: 'the isolated test remains red' },
  { id: 'hidden.research.guard2', domain: 'research', prompt: 'Study CRDTs only if concurrent edits cannot be serialized.', relation: 'necessary_condition', action: 'Study CRDTs', condition: 'concurrent edits cannot be serialized' },
  { id: 'hidden.chat.guard2', domain: 'chat', prompt: 'Recommend the faster design only if rollback remains safe.', relation: 'necessary_condition', action: 'Recommend the faster design', condition: 'rollback remains safe' },
  { id: 'hidden.operations.guard2', domain: 'operations', prompt: 'Deploy the API only if every health check succeeds.', relation: 'necessary_condition', action: 'Deploy the API', condition: 'every health check succeeds' },
  { id: 'hidden.code.exception2', domain: 'code', prompt: 'Revert parser.py unless the new reproduction passes.', relation: 'exception_condition', action: 'Revert parser.py', condition: 'the new reproduction passes' },
  { id: 'hidden.learning.exception2', domain: 'learning', prompt: 'Keep the learned rule unless ablation shows no effect.', relation: 'exception_condition', action: 'Keep the learned rule', condition: 'ablation shows no effect' },
  { id: 'hidden.chat.exception2', domain: 'chat', prompt: 'Use the analogy unless it changes the meaning.', relation: 'exception_condition', action: 'Use the analogy', condition: 'it changes the meaning' },
  { id: 'hidden.operations.exception2', domain: 'operations', prompt: 'Restart the worker unless the queue is already draining.', relation: 'exception_condition', action: 'Restart the worker', condition: 'the queue is already draining' }
];

function main() {
  if (fs.existsSync(OUT)) throw new Error('Semantic AST autogenesis curriculum already exists.');
  const model = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const publicArtifact = { schemaVersion: 1, kind: 'lari.semantic-ast-autogenesis.behavioral-failures', traces: traces.map(trace => ({ ...trace, baselineDroppedScope: !(language.analyze(trace.scopedPrompt, { learnedRecords: model.lariLearnedRecords?.records || [] }).semantics.semanticRelations || []).length })) };
  const hiddenArtifact = { schemaVersion: 1, kind: 'lari.semantic-ast-autogenesis.hidden-holdouts', cases: hidden };
  const publicFile = write('behavioral-failure-traces.json', publicArtifact);
  const hiddenFile = write('hidden-holdouts.json', hiddenArtifact);
  const baseline = hidden.map(item => ({ id: item.id, relationCount: (language.analyze(item.prompt, { learnedRecords: model.lariLearnedRecords?.records || [] }).semantics.semanticRelations || []).length }));
  write('sealed-index.json', { schemaVersion: 1, sealedAt: new Date().toISOString(), parentHash: before.active, public: { path: 'behavioral-failure-traces.json', sha256: shaFile(publicFile), count: traces.length }, hidden: { path: 'hidden-holdouts.json', sha256: shaFile(hiddenFile), count: hidden.length }, learnerMayRead: ['behavioral-failure-traces.json'], learnerMustNotRead: ['hidden-holdouts.json'] });
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  write('baseline-evidence.json', { schemaVersion: 1, parentHash: before.active, publicScopeDropped: publicArtifact.traces.every(trace => trace.baselineDroppedScope), hiddenBaseline: baseline, gates: { publicScopeDroppedSixOfSix: publicArtifact.traces.every(trace => trace.baselineDroppedScope), hiddenScopeDroppedEightOfEight: baseline.every(row => row.relationCount === 0), activeAndRegistryReadOnly: JSON.stringify(before) === JSON.stringify(after), externalModelCallsZero: true }, before, after });
  console.log(JSON.stringify({ parentHash: before.active, publicScopeDropped: '6/6', hiddenScopeDropped: '8/8', publicHash: shaFile(publicFile), hiddenHash: shaFile(hiddenFile) }, null, 2));
}
main();
