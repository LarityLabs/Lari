#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (process.env.LARI_CONFIRM_INDEPENDENT_ROLLBACK !== 'rollback-4a5d511f-to-94f12e20') {
  throw new Error('Refusing rollback without LARI_CONFIRM_INDEPENDENT_ROLLBACK=rollback-4a5d511f-to-94f12e20.');
}

delete process.env.LARI_REGISTRY_ROOT;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';

const registry = require('./lari_model_registry.js');
const root = path.resolve(__dirname, '..');
const activeHash = '4a5d511f69654a6523f28b20effc2f37d940f3bddd1eafc93870409b52ae76a4';
const rollbackHash = '94f12e2063f700886746125e71139f28bb9cb11cb1d0302d99e102d12ffd1838';
const evidenceDir = path.join(root, 'consolidation', 'independent-repository-gate-20260718', 'production-promotion-20260722');
const promotionPath = path.join(evidenceDir, 'production-promotion-manifest.json');
const outputPath = path.join(evidenceDir, 'production-rollback-manifest.json');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(!fs.existsSync(outputPath), 'Production rollback manifest already exists; refusing a repeated rollback.');
assert(fs.existsSync(promotionPath), 'Production promotion manifest is missing.');
assert(sha256(registry.currentModelPath) === activeHash, 'Active hash changed; refusing stale rollback.');
const promotion = JSON.parse(fs.readFileSync(promotionPath, 'utf8'));
const rollbackPath = path.resolve(root, promotion.rollback.registryBackupPath);
assert(fs.existsSync(rollbackPath), 'Recorded rollback artifact is missing.');
assert(sha256(rollbackPath) === rollbackHash, 'Recorded rollback artifact hash mismatch.');

const restored = registry.promoteLariModel(rollbackPath, {
  transaction: 'exact-independent-candidate-production-rollback',
  rollback: true,
  rollbackTargetHash: rollbackHash,
  rolledBackFromHash: activeHash,
  sourcePromotionManifest: relative(promotionPath),
  sourcePromotionManifestHash: sha256(promotionPath)
});
const candidates = registry.listLariModelCandidates();
const gates = {
  exactIncumbentRestored: sha256(registry.currentModelPath) === rollbackHash,
  lineageRecorded: restored.metadata?.rollback === true
    && restored.metadata?.rollbackTargetHash === rollbackHash
    && restored.metadata?.rolledBackFromHash === activeHash,
  registryResolutionOnly: registry.resolveLariModelPath().source === 'registry',
  fallbackDiscoveryDisabled: candidates.length === 1 && candidates[0].id === 'canonical-current'
};
assert(Object.values(gates).every(Boolean), `Rollback gate failed: ${JSON.stringify(gates)}`);
const result = {
  schemaVersion: 1,
  kind: 'lari.independent-candidate-production-rollback',
  createdAt: new Date().toISOString(),
  rolledBackFrom: activeHash,
  restored: rollbackHash,
  source: relative(rollbackPath),
  registrySha256: sha256(registry.registryPath),
  gates,
  status: 'rollback_succeeded'
};
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
fs.chmodSync(outputPath, 0o444);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
