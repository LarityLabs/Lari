#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const language = require('../swarm_language_understanding.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'language-primitive-neurogenesis-20260831');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const writeExclusive = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); };

const publicCases = [
  { id: 'public.code.only-if', domain: 'code', prompt: 'Change auth.js only if its tests fail.', relation: 'necessary_condition', action: 'Change auth.js', condition: 'its tests fail' },
  { id: 'public.chat.unless', domain: 'chat', prompt: 'Recommend the safer plan unless rollback is impossible.', relation: 'exception_condition', action: 'Recommend the safer plan', condition: 'rollback is impossible' },
  { id: 'public.research.only-if', domain: 'research', prompt: 'Research event sourcing only if our architecture cannot guarantee replay.', relation: 'necessary_condition', action: 'Research event sourcing', condition: 'our architecture cannot guarantee replay' },
  { id: 'public.code.unless', domain: 'code', prompt: 'Modify worker.js unless the compatibility check fails.', relation: 'exception_condition', action: 'Modify worker.js', condition: 'the compatibility check fails' }
];

const hiddenCases = [
  { id: 'hidden.code.only-if', domain: 'code', prompt: 'Patch parser.py only if the isolated reproduction still fails.', relation: 'necessary_condition', action: 'Patch parser.py', condition: 'the isolated reproduction still fails' },
  { id: 'hidden.chat.unless', domain: 'chat', prompt: 'Choose the simpler explanation unless it drops an important caveat.', relation: 'exception_condition', action: 'Choose the simpler explanation', condition: 'it drops an important caveat' },
  { id: 'hidden.research.only-if', domain: 'research', prompt: 'Study vector clocks only if the current ordering guarantee is insufficient.', relation: 'necessary_condition', action: 'Study vector clocks', condition: 'the current ordering guarantee is insufficient' },
  { id: 'hidden.code.unless', domain: 'code', prompt: 'Restore cache.js unless the new test proves the cache is correct.', relation: 'exception_condition', action: 'Restore cache.js', condition: 'the new test proves the cache is correct' },
  { id: 'hidden.operations.only-if', domain: 'operations', prompt: 'Deploy the worker only if every dependency check passes.', relation: 'necessary_condition', action: 'Deploy the worker', condition: 'every dependency check passes' },
  { id: 'hidden.learning.unless', domain: 'learning', prompt: 'Retain the procedure unless hidden transfer contradicts it.', relation: 'exception_condition', action: 'Retain the procedure', condition: 'hidden transfer contradicts it' }
];

function baselineRow(item, model) {
  const result = language.analyze(item.prompt, { enableLearningBinding: true, learnedRecords: model.lariLearnedRecords?.records || [] });
  const relation = (result.semantics.semanticRelations || []).find(value => value.type === item.relation);
  return { ...item, passed: relation?.actionText === item.action && relation?.conditionText === item.condition, observed: relation || null, supported: result.supported };
}

function main() {
  const files = ['public-training.json', 'hidden-holdouts.json', 'sealed-index.json', 'baseline-evidence.json'].map(name => path.join(OUT, name));
  if (files.some(fs.existsSync)) throw new Error('Language primitive curriculum already exists.');
  const activeHash = shaFile(ACTIVE);
  const protectedBefore = { active: activeHash, registry: shaFile(REGISTRY) };
  const model = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const publicArtifact = { schemaVersion: 1, kind: 'lari.language-primitive.public-training', cases: publicCases };
  const hiddenArtifact = { schemaVersion: 1, kind: 'lari.language-primitive.hidden-holdouts', cases: hiddenCases };
  const publicBytes = Buffer.from(`${JSON.stringify(publicArtifact, null, 2)}\n`);
  const hiddenBytes = Buffer.from(`${JSON.stringify(hiddenArtifact, null, 2)}\n`);
  writeExclusive(files[0], publicArtifact);
  writeExclusive(files[1], hiddenArtifact);
  writeExclusive(files[2], { schemaVersion: 1, kind: 'lari.language-primitive.sealed-index', sealedAt: new Date().toISOString(), parentHash: activeHash, public: { path: 'public-training.json', sha256: sha(publicBytes), count: publicCases.length }, hidden: { path: 'hidden-holdouts.json', sha256: sha(hiddenBytes), count: hiddenCases.length }, learnerMayRead: ['public-training.json'], learnerMustNotRead: ['hidden-holdouts.json'] });
  const rows = [...publicCases, ...hiddenCases].map(item => baselineRow(item, model));
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  writeExclusive(files[3], { schemaVersion: 1, kind: 'lari.language-primitive.baseline', createdAt: new Date().toISOString(), parentHash: activeHash, rows, gates: { incumbentFailsAll: rows.every(row => !row.passed), activeAndRegistryReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter), externalModelCallsZero: true }, protectedBefore, protectedAfter });
  console.log(JSON.stringify({ parentHash: activeHash, baseline: `${rows.filter(row => row.passed).length}/${rows.length}`, incumbentFailsAll: rows.every(row => !row.passed), publicHash: sha(publicBytes), hiddenHash: sha(hiddenBytes) }, null, 2));
}

main();
