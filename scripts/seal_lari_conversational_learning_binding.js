#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'conversational-learning-binding-20260829');
const PARENT_HASH = 'b90beb1028e61a94058a0af3252d72030b4cbab7f12b3ec19f8f6ad6fa1e8503';
const PARENT = path.join(ROOT, 'consolidation', 'language-understanding-20260829', 'candidates', `${PARENT_HASH}.json`);
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const cases = [
  { id: 'research_with_purpose', set: 'training', prompt: 'Research deterministic retry backoff so you can diagnose flaky CI jobs, and retain only verified facts.', expect: { target: 'deterministic retry backoff', purpose: 'diagnose flaky CI jobs', mode: 'research', evidenceRequired: true } },
  { id: 'procedural_learning', set: 'training', prompt: 'Learn how to isolate Python dependency failures before repairing a repository; require an unseen transfer test and reload retention.', expect: { target: 'isolate Python dependency failures', purpose: 'repairing a repository', mode: 'practice', executionRequired: true, unseenTransfer: true, reloadRetention: true } },
  { id: 'factual_hypothesis', set: 'hidden', prompt: 'Learn whether SQLite WAL mode permits concurrent readers during writes; verify it before retaining it.', expect: { target: 'whether SQLite WAL mode permits concurrent readers during writes', mode: 'research', claimTreatment: 'hypothesis_requires_evidence', evidenceRequired: true } },
  { id: 'semantic_variant', set: 'hidden', prompt: 'Study idempotency keys so that you can safely retry payment requests. Keep the lesson only after source verification.', expect: { target: 'idempotency keys', purpose: 'safely retry payment requests', mode: 'research', evidenceRequired: true } },
  { id: 'procedural_variant', set: 'hidden', prompt: 'Teach yourself how to localize race conditions before changing code, and prove the procedure on a fresh case after reload.', expect: { target: 'localize race conditions', purpose: 'changing code', mode: 'practice', executionRequired: true, unseenTransfer: true, reloadRetention: true } }
];
function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const sealPath = path.join(OUT, 'sealed-curriculum.json');
  const baselinePath = path.join(OUT, 'baseline-evidence.json');
  if (fs.existsSync(sealPath) || fs.existsSync(baselinePath)) throw new Error('Conversational-learning curriculum already sealed.');
  if (shaFile(PARENT) !== PARENT_HASH) throw new Error('Qualified language parent missing or changed.');
  const before = { parent: shaFile(PARENT), active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const model = JSON.parse(fs.readFileSync(PARENT, 'utf8'));
  const rows = cases.map(item => {
    const response = runtime.sendMessageToLari(clone(model), item.prompt, { modelHash: PARENT_HASH, autoGrow: false, userScope: item.id, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });
    return { id: item.id, set: item.set, prompt: item.prompt, expected: item.expect, intent: response.intent, subintent: response.subintent, action: response.action, learningSemantics: response.languageUnderstanding?.semantics?.learning || null, passed: Boolean(response.languageUnderstanding?.semantics?.learning), externalModelCalls: response.external_model_calls || 0 };
  });
  const after = { parent: shaFile(PARENT), active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  fs.writeFileSync(sealPath, `${JSON.stringify({ schemaVersion: 1, kind: 'lari.conversational-learning-binding.sealed-curriculum', sealedAt: new Date().toISOString(), parentHash: PARENT_HASH, cases }, null, 2)}\n`, { flag: 'wx' });
  const baseline = { schemaVersion: 1, kind: 'lari.conversational-learning-binding.baseline', createdAt: new Date().toISOString(), passedCount: rows.filter(row => row.passed).length, total: rows.length, rows, protectedBefore: before, protectedAfter: after, gates: { allFailuresSealed: rows.every(row => !row.passed), protectedFilesUnchanged: JSON.stringify(before) === JSON.stringify(after), externalModelCallsZero: rows.every(row => row.externalModelCalls === 0) } };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ baseline: `${baseline.passedCount}/${baseline.total}`, gates: baseline.gates, rows: rows.map(row => ({ id: row.id, intent: row.intent, action: row.action })) }, null, 2));
}
main();
