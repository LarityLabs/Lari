#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const CE = path.resolve(ROOT, '..', 'computational-english');
const OUT = path.join(ROOT, 'consolidation', 'computational-english-integration-20260829');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const cases = [
  { id: 'lexical_plural_retention', set: 'retention', prompt: 'What is the plural of child?', includes: ['children'] },
  { id: 'lexical_pos_retention', set: 'retention', prompt: 'What part of speech is the word run?', includes: ['run'] },
  { id: 'agreement_training', set: 'training', prompt: 'Correct the grammar in this sentence: these diagnostic test failed.', exact: 'These diagnostic tests failed.' },
  { id: 'realization_training', set: 'training', prompt: 'Write a clear sentence explaining that three tests failed.', exact: 'Three tests failed.' },
  { id: 'agreement_hidden_plural', set: 'hidden', prompt: 'Please correct the agreement here: those failing test blocked the release.', exact: 'Those failing tests blocked the release.' },
  { id: 'agreement_hidden_singular', set: 'hidden', prompt: 'Repair the grammar: this stale caches caused the failure.', exact: 'This stale cache caused the failure.' },
  { id: 'realization_hidden_plural', set: 'hidden', prompt: 'State plainly that two checks passed.', exact: 'Two checks passed.' },
  { id: 'realization_hidden_singular', set: 'hidden', prompt: 'Give me one sentence saying a single case remained.', exact: 'One case remained.' }
];
function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const sealPath = path.join(OUT, 'sealed-language-curriculum.json');
  const baselinePath = path.join(OUT, 'baseline-evidence.json');
  if (fs.existsSync(sealPath) || fs.existsSync(baselinePath)) throw new Error('Language curriculum or baseline is already sealed.');
  const ceCommit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CE, encoding: 'utf8' }).trim();
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), ceCommit };
  const sealed = { schemaVersion: 1, kind: 'lari.computational-english.sealed-curriculum', sealedAt: new Date().toISOString(), protectedBefore, cases };
  fs.writeFileSync(sealPath, `${JSON.stringify(sealed, null, 2)}\n`, { flag: 'wx' });
  const model = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const rows = cases.map(item => {
    const response = runtime.sendMessageToLari(JSON.parse(JSON.stringify(model)), item.prompt, { modelHash: protectedBefore.active, autoGrow: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });
    const answer = String(response.answer || '').trim();
    const passed = item.exact ? normalize(answer) === normalize(item.exact) : item.includes.every(term => normalize(answer).includes(normalize(term)));
    return { id: item.id, set: item.set, prompt: item.prompt, expected: item.exact || item.includes, intent: runtime.classifyLariUnifiedTaskIntent({ prompt: item.prompt }), subintent: runtime.classifyLariUnifiedTaskSubintent({ prompt: item.prompt }), answer, learnedRecordIds: response.learnedRecordIds || [], modelHash: response.modelHash, externalModelCalls: response.external_model_calls || 0, passed };
  });
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), ceCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CE, encoding: 'utf8' }).trim() };
  const baseline = { schemaVersion: 1, kind: 'lari.computational-english.baseline', createdAt: new Date().toISOString(), curriculumSha256: shaFile(sealPath), passedCount: rows.filter(row => row.passed).length, total: rows.length, rows, protectedBefore, protectedAfter, gates: { protectedFilesUnchanged: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter), externalModelCallsZero: rows.every(row => row.externalModelCalls === 0) } };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ sealPath, baselinePath, passed: `${baseline.passedCount}/${baseline.total}`, failures: rows.filter(row => !row.passed).map(row => ({ id: row.id, intent: row.intent, answer: row.answer })), gates: baseline.gates }, null, 2));
}
main();
