#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

delete process.env.LARI_REGISTRY_ROOT;
delete process.env.LARI_MODEL_PATH;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
process.env.LARI_ALLOW_LEGACY_ROOT_MODEL = '0';

const registry = require('./lari_model_registry.js');
const root = path.resolve(__dirname, '..');
const failedHash = '317a7ba024a6298252d7dd7f17ff81355226692ab2591a14a051e7084ae4b9bb';
const targetHash = '06f2543c86eb60dbc20814a437fc1290d52a832c112046c9fbb37974cdc9a8a3';
const outputDir = path.join(root, 'consolidation', 'beta-quality-execution-refinement-production-promotion-20260909');
const promotionPath = path.join(outputDir, 'promotion-manifest.json');
const reportPath = path.join(outputDir, 'automatic-rollback-manifest.json');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (fs.existsSync(reportPath)) throw new Error('Rollback manifest already exists.');
if (!fs.existsSync(promotionPath)) throw new Error('Promotion manifest is missing.');
if (sha256(registry.currentModelPath) !== failedHash) throw new Error('Active model no longer matches the failed promotion hash.');

const rolledBack = registry.rollbackLariModel(targetHash, {
  reason: 'Automatic rollback after post-promotion chat-language frontier regression',
  failedGate: 'lari:test-chat-language-frontier',
  failedCandidateHash: failedHash,
  promotionManifest: path.relative(root, promotionPath).replace(/\\/g, '/'),
  externalModelCalls: 0
});
const activeHash = sha256(registry.currentModelPath);
const registryState = registry.readLariModelRegistry();
const report = {
  schemaVersion: 1,
  kind: 'lari-beta-quality-execution-automatic-rollback',
  createdAt: new Date().toISOString(),
  failedCandidateHash: failedHash,
  failedGate: 'lari:test-chat-language-frontier',
  restoredHash: activeHash,
  expectedRestoredHash: targetHash,
  registryActiveHash: registryState.activeModelSha256,
  changed: rolledBack.changed,
  rollback: rolledBack,
  passed: activeHash === targetHash && registryState.activeModelSha256 === targetHash,
  externalModelCalls: 0
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
