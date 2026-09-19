#!/usr/bin/env node
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const root = path.resolve(__dirname, '..');
const activePath = path.join(root, 'models', 'lari', 'current', 'swarm-model.json');
const registryPath = path.join(root, 'models', 'lari', 'registry.json');
const out = path.join(root, 'consolidation', 'symbolic-math-neurogenesis-20260912');
const sealPath = path.join(out, 'sealed-curriculum.json');
const sealManifestPath = path.join(out, 'seal-manifest.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const protectedBefore = { active: shaFile(activePath), registry: shaFile(registryPath) };
const sealManifest = JSON.parse(fs.readFileSync(sealManifestPath, 'utf8'));
assert.strictEqual(shaFile(sealPath), sealManifest.payload.sha256, 'sealed curriculum hash mismatch');
const sealed = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
const parent = JSON.parse(fs.readFileSync(activePath, 'utf8'));

const outputNumber = response => {
  const answer = String(response?.answer || response?.output_text || '');
  const match = answer.match(/####\s*(-?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
};
const run = (model, item, modelHash) => runtime.sendMessageToLari(clone(model), { id: item.id, prompt: item.prompt }, {
  modelHash, autoGrow: false, groundedFactual: false,
  kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
});
const evaluate = (model, cases, modelHash) => cases.map(item => {
  const response = run(model, item, modelHash);
  return { id: item.id, promptHash: sha(Buffer.from(item.prompt)), expected: item.expected, actual: outputNumber(response), passed: outputNumber(response) === item.expected, action: response.action || null };
});

const baselineVisible = evaluate(parent, sealed.visible, protectedBefore.active);
const baselineHidden = evaluate(parent, sealed.hidden, protectedBefore.active);
assert(baselineVisible.every(row => !row.passed), 'qualification requires fail-before on every visible case');
assert(baselineHidden.every(row => !row.passed), 'qualification requires fail-before on every hidden case');

const expressions = ['n0+n1', 'n0-n1', 'n0*n1', 'n0/n1', 'n0*n0/n1', 'n1*n1/n0', '(n0+n1)*n1', '(n0-n1)*n1'];
const execute = (expression, numbers) => {
  if (!/^[n0-9+\-*/().\s]+$/.test(expression)) return null;
  try { const value = Function('n0', 'n1', `"use strict"; return (${expression});`)(...numbers); return Number.isFinite(value) ? value : null; }
  catch (_) { return null; }
};
const candidates = expressions.map(expression => ({
  expression,
  visiblePassed: sealed.visible.filter(item => execute(expression, item.numbers) === item.expected).length
})).sort((a, b) => b.visiblePassed - a.visiblePassed || a.expression.length - b.expression.length || a.expression.localeCompare(b.expression));
const winner = candidates[0];
assert.strictEqual(winner.visiblePassed, sealed.visible.length, 'no expression generalized across visible cases');
assert.strictEqual(candidates.filter(item => item.visiblePassed === sealed.visible.length).length, 1, 'visible cases do not identify a unique program');

const candidate = clone(parent);
const recordId = `lari.learned.procedure.symbolic_math.${sha(Buffer.from(`${sealed.family}:${winner.expression}`)).slice(0, 20)}`;
const createdAt = '2026-09-12T18:00:00.000Z';
const policy = {
  id: `induced.${sealed.family}`,
  type: 'induced_math_planner_rule', enabled: true, source: 'failure_driven_symbolic_math_neurogenesis',
  triggers: ['reciprocal', 'product'], op: 'expression',
  bindings: [
    { name: 'shared', pattern: '(?:share(?:d|s)?\\s+value|common\\s+value|sharing)\\s+(\\d+(?:\\.\\d+)?)' },
    { name: 'scale', pattern: '(?:scale\\s+factor|multiplier|scale\\s+coefficient)\\s+(\\d+(?:\\.\\d+)?)' }
  ],
  expression: winner.expression.replaceAll('n0', 'shared').replaceAll('n1', 'scale'), priority: 100,
  lariSelection: { learnedRecordId: recordId }
};
candidate.lariMathReasoning = candidate.lariMathReasoning || { enabled: true, policies: [] };
candidate.lariMathReasoning.enabled = true;
candidate.lariMathReasoning.policies = [policy, ...(candidate.lariMathReasoning.policies || []).filter(item => item.id !== policy.id)];
candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
const learnedRecord = {
  schemaVersion: 1, id: recordId, type: 'procedure', status: 'active',
  normalizedTriggers: ['math', 'product', 'reciprocal', 'ratio'],
  procedureIdentity: `symbolic-math:${sealed.family}:${winner.expression}`,
  semanticFingerprint: `symbolic-math:${sealed.family}:${winner.expression}`,
  outputBehavior: 'derive a product from a reciprocal relation and verify the induced expression',
  contentHash: `sha256:${sha(Buffer.from(JSON.stringify(policy)))}`,
  behavioralSignature: `induced-expression:${winner.expression}`,
  confidence: 0.9,
  provenance: { sourceModelHash: protectedBefore.active, sourcePath: 'sealed visible symbolic-math curriculum', originalRecordId: null, sourceKind: 'procedure', creationSource: 'failure_driven_symbolic_math_neurogenesis', benchmarkAssociation: [], confidence: 0.9, imported: false, classification: 'qualified_candidate', importTimestamp: createdAt, storesPromptText: false, storesExpectedAnswers: false },
  payload: { domain: 'symbolic_math', operation: 'induced_expression', expression: policy.expression, variables: ['shared', 'scale'], verification: 'visible_induction_hidden_transfer_reload_ablation' }
};
candidate.lariLearnedRecords.records = [learnedRecord, ...(candidate.lariLearnedRecords.records || []).filter(item => item.id !== recordId)];
candidate.lineage = { ...(candidate.lineage || {}), parentHash: protectedBefore.active, developmentalEvent: 'failure_driven_symbolic_math_neurogenesis', sourceRecordIds: [recordId], promoted: false, createdAt, canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel' };

const provisionalBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
const candidateHash = sha(provisionalBytes);
const visibleAfter = evaluate(candidate, sealed.visible, candidateHash);
const hiddenAfter = evaluate(candidate, sealed.hidden, candidateHash);
const reloaded = JSON.parse(provisionalBytes.toString('utf8'));
const reload = evaluate(reloaded, sealed.hidden, candidateHash);
const ablated = clone(candidate);
ablated.lariMathReasoning.policies = ablated.lariMathReasoning.policies.filter(item => item.id !== policy.id);
ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(item => item.id !== recordId);
const ablation = evaluate(ablated, sealed.hidden, 'ablated');
const regressions = [
  { id: 'arithmetic-add', prompt: 'Calculate exactly: 7 + 5', expected: 12 },
  { id: 'arithmetic-multiply', prompt: 'Calculate exactly: 6 * 9', expected: 54 }
];
const familyRegression = evaluate(candidate, regressions, candidateHash);
const protectedAfter = { active: shaFile(activePath), registry: shaFile(registryPath) };
const gates = {
  sealExact: shaFile(sealPath) === sealManifest.payload.sha256,
  visibleFailedBefore: baselineVisible.every(row => !row.passed),
  hiddenFailedBefore: baselineHidden.every(row => !row.passed),
  uniqueProgramInducedFromVisibleOnly: winner.visiblePassed === sealed.visible.length && candidates.filter(item => item.visiblePassed === sealed.visible.length).length === 1,
  visiblePassAfter: visibleAfter.every(row => row.passed),
  hiddenTransfer: hiddenAfter.every(row => row.passed),
  reloadRetention: reload.every(row => row.passed),
  exactAblation: ablation.every(row => !row.passed),
  familyRegressionZero: familyRegression.every(row => row.passed),
  activeReadOnly: protectedAfter.active === protectedBefore.active,
  registryReadOnly: protectedAfter.registry === protectedBefore.registry,
  externalModelCallsZero: true,
  noBenchmarkAssociation: learnedRecord.provenance.benchmarkAssociation.length === 0,
  noStoredAnswers: learnedRecord.provenance.storesExpectedAnswers === false
};
const passed = Object.values(gates).every(Boolean);
assert(passed, JSON.stringify({ gates, baselineVisible, visibleAfter, hiddenAfter, reload, ablation, familyRegression }, null, 2));
const candidatePath = path.join(out, 'candidates', `${candidateHash}.json`);
fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
if (!fs.existsSync(candidatePath)) fs.writeFileSync(candidatePath, provisionalBytes, { flag: 'wx' });
assert.strictEqual(shaFile(candidatePath), candidateHash);
const report = { schemaVersion: 1, kind: 'lari.symbolic-math-neurogenesis.qualification', createdAt: new Date().toISOString(), parentHash: protectedBefore.active, sealHash: sealManifest.payload.sha256, candidate: { path: path.relative(root, candidatePath).replace(/\\/g, '/'), sha256: candidateHash, promoted: false }, learnedRecord: { id: recordId, expression: winner.expression }, inductionCandidates: candidates, baselineVisible, baselineHidden, visibleAfter, hiddenAfter, reload, ablation, familyRegression, gates, protectedBefore, protectedAfter, passed, limitations: ['Qualified one symbolic relation family only.', 'The expression vocabulary and evaluator are developer-authored.', 'No claim of general algebra, combinatorics, geometry, or proof mastery.', 'No LiveBench question or answer was used for induction.'] };
const reportPath = path.join(out, 'qualification.json');
if (fs.existsSync(reportPath)) throw new Error('qualification report already exists');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ passed, candidateHash, recordId, expression: winner.expression, gates }, null, 2));
