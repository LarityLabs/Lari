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
const ROOT = path.resolve(__dirname, '..');
const ACTIVE_HASH = 'cab74f590d5ad4533202b1ee2c08b32e28ec47e3c8134ddd24a2bc5bdd7a0fed';
const TARGET_HASH = '60d731eb2d04e3411e81c129118b34e372d63311ce39a18c2d47e0e9fd73ac79';
const OUT = path.join(ROOT, 'consolidation', 'recursive-field-generator-production-promotion-20260831');
const PROMOTION = path.join(OUT, 'production-promotion-manifest.json');
const BACKUP = path.join(OUT, 'backups', `sha256-${TARGET_HASH}.json`);
const REPORT = path.join(OUT, 'real-rollback-manifest.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function main() {
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Real production registry was not selected.');
  assert(!fs.existsSync(REPORT), 'Rollback has already been recorded.');
  assert(fs.existsSync(PROMOTION) && JSON.parse(fs.readFileSync(PROMOTION, 'utf8')).passed === true, 'Promotion manifest is missing or failed.');
  assert(sha(registry.currentModelPath) === ACTIVE_HASH, 'Active model no longer matches the promoted hash.');
  assert(fs.existsSync(BACKUP) && sha(BACKUP) === TARGET_HASH, 'Exact rollback backup is missing or corrupt.');
  const rolled = registry.promoteLariModel(BACKUP, {
    transaction: 'explicit-recursive-field-generator-rollback',
    rollback: true,
    rollbackTargetHash: TARGET_HASH,
    rolledBackFromHash: ACTIVE_HASH,
    promotionManifest: rel(PROMOTION),
    externalModelCalls: 0
  });
  const report = {
    schemaVersion: 1,
    kind: 'lari.recursive-field-generator.real-rollback',
    createdAt: new Date().toISOString(),
    passed: sha(registry.currentModelPath) === TARGET_HASH,
    fromHash: ACTIVE_HASH,
    restoredHash: sha(registry.currentModelPath),
    backupPath: rel(BACKUP),
    promotedAt: rolled.promotedAt,
    externalModelCalls: 0
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
