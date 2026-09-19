#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'language-understanding-20260829');
const PARENT_HASH = '16ccd5e32602890c05527e109becfa3ba98ba91dd6b1dc73f5c76dba384ecea8';
const PARENT = path.join(ROOT, 'consolidation', 'computational-english-integration-20260829', 'candidates', `${PARENT_HASH}.json`);
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const cases = [
  { id: 'read_only_explanation', set: 'training', prompt: 'Explain why tests/test_api.py fails, and do not modify anything.', expect: { intent: 'code', subintent: 'code.explain', preserveState: true, target: 'tests/test_api.py' } },
  { id: 'contradictory_edit', set: 'training', prompt: 'Edit parser.js but do not modify parser.js.', expect: { clarification: true, contradictionTarget: 'parser.js' } },
  { id: 'ordered_repair', set: 'training', prompt: 'First inspect parser.js, then edit validator.js, then run tests; if tests fail, restore the backup. Do not touch package-lock.json.', expect: { intent: 'code', orderedActions: ['inspect', 'edit', 'run', 'restore'], forbiddenTarget: 'package-lock.json', rollback: true } },
  { id: 'read_only_variant', set: 'hidden', prompt: 'Tell me what src/cache.js does without changing any files.', expect: { intent: 'code', subintent: 'code.explain', preserveState: true, target: 'src/cache.js' } },
  { id: 'contradiction_variant', set: 'hidden', prompt: 'Patch worker.js, but never touch worker.js.', expect: { clarification: true, contradictionTarget: 'worker.js' } },
  { id: 'ordered_variant', set: 'hidden', prompt: 'Inspect api.js and then update router.js. After that, run the test suite. If verification fails, restore the backup; leave package-lock.json unchanged.', expect: { intent: 'code', orderedActions: ['inspect', 'update', 'run', 'restore'], forbiddenTarget: 'package-lock.json', rollback: true } },
  { id: 'conditional_no_rollback', set: 'hidden', prompt: 'Run the tests. If they pass, summarize the result; do not edit the repository.', expect: { intent: 'code', preserveState: true, verification: true, condition: true } }
];
function run(model, prompt) {
  return runtime.sendMessageToLari(clone(model), prompt, { modelHash: PARENT_HASH, autoGrow: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });
}
function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const sealPath = path.join(OUT, 'sealed-curriculum.json');
  const baselinePath = path.join(OUT, 'baseline-evidence.json');
  if (fs.existsSync(sealPath) || fs.existsSync(baselinePath)) throw new Error('Language-understanding curriculum is already sealed.');
  if (shaFile(PARENT) !== PARENT_HASH) throw new Error('Qualified CE parent candidate is missing or changed.');
  const protectedBefore = { parent: shaFile(PARENT), active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const model = JSON.parse(fs.readFileSync(PARENT, 'utf8'));
  const rows = cases.map(item => {
    const response = run(model, item.prompt);
    return { id: item.id, set: item.set, prompt: item.prompt, expected: item.expect, intent: response.intent, subintent: response.subintent, action: response.action, answer: response.answer, languageUnderstanding: response.languageUnderstanding || null, passed: Boolean(response.languageUnderstanding), externalModelCalls: response.external_model_calls || 0 };
  });
  const sealed = { schemaVersion: 1, kind: 'lari.language-understanding.sealed-curriculum', sealedAt: new Date().toISOString(), parentHash: PARENT_HASH, cases };
  fs.writeFileSync(sealPath, `${JSON.stringify(sealed, null, 2)}\n`, { flag: 'wx' });
  const protectedAfter = { parent: shaFile(PARENT), active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const baseline = { schemaVersion: 1, kind: 'lari.language-understanding.baseline', createdAt: new Date().toISOString(), parentHash: PARENT_HASH, rows, passedCount: rows.filter(row => row.passed).length, total: rows.length, protectedBefore, protectedAfter, gates: { allFailuresSealed: rows.every(row => !row.passed), protectedFilesUnchanged: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter), externalModelCallsZero: rows.every(row => row.externalModelCalls === 0) } };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ baseline: `${baseline.passedCount}/${baseline.total}`, sealedFailures: rows.map(row => ({ id: row.id, intent: row.intent, subintent: row.subintent, action: row.action })), gates: baseline.gates }, null, 2));
}
main();
