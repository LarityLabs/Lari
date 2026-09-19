#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const root = path.resolve(__dirname, '..');
const sealedPath = path.join(root, 'consolidation', 'stage-4-sealed', 'developmental-holdouts.json');
const manifestPath = path.join(root, 'consolidation', 'stage-4-hidden-holdout-manifest.json');
const outputPath = path.join(root, 'consolidation', 'stage-4-developmental-baseline.json');
const expectedBaseHash = '963aa947dff519f91c72768ec349185c140eca6b0995562a45566bb32191a273';
const sha = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function evaluate(response, testCase) {
  const answer = String(response.answer || '').toLowerCase();
  const hits = testCase.expectedConcepts.filter(concept => answer.includes(concept));
  return { id: testCase.id, kind: testCase.kind, promptHash: crypto.createHash('sha256').update(testCase.prompt).digest('hex'), hits, hitCount: hits.length, required: testCase.minimumConceptHits, passed: hits.length >= testCase.minimumConceptHits, capabilitySelection: response.capabilitySelection, learnedRecordIds: response.learnedRecordIds, answer };
}
if (fs.existsSync(outputPath)) throw new Error('Stage 4 developmental baseline already exists.');
if (sha(registry.currentModelPath) !== expectedBaseHash) throw new Error('Baseline active hash mismatch.');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const sealed = JSON.parse(fs.readFileSync(sealedPath, 'utf8'));
if (sha(sealedPath) !== manifest.sealedPayload.sha256) throw new Error('Sealed holdout payload hash mismatch.');
const before = { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
const model = registry.loadLariModel().model;
const results = sealed.cases.map(testCase => evaluate(runtime.sendMessageToLari(clone(model), testCase.prompt, {
  modelHash: expectedBaseHash, autoGrow: false,
  kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
}), testCase));
const after = { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
const report = {
  schemaVersion: 1, stage: 4, phase: 'developmental-baseline', createdAt: new Date().toISOString(),
  family: sealed.family, activeHash: expectedBaseHash, sealedAt: manifest.sealedAt,
  evaluatedBeforeLearning: true, results,
  passedCount: results.filter(item => item.passed).length, total: results.length,
  holdoutPassed: results.filter(item => item.kind === 'holdout' && item.passed).length,
  crossContextPassed: results.filter(item => item.kind === 'cross-context' && item.passed).length,
  activeReadOnly: JSON.stringify(before) === JSON.stringify(after), before, after
};
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ passed: `${report.passedCount}/${report.total}`, holdoutPassed: report.holdoutPassed, crossContextPassed: report.crossContextPassed, activeReadOnly: report.activeReadOnly }, null, 2)}\n`);
