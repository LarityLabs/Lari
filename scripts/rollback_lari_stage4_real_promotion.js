#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (process.env.LARI_CONFIRM_STAGE4_ROLLBACK !== 'rollback-to-eb212812') {
  throw new Error('Refusing real rollback without LARI_CONFIRM_STAGE4_ROLLBACK=rollback-to-eb212812.');
}
delete process.env.LARI_REGISTRY_ROOT;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
const registry = require('./lari_model_registry.js');
const root = path.resolve(__dirname, '..');
const rollbackPath = path.join(root, 'models', 'lari', 'current', 'swarm-model.backup-1783695593177.json');
const expectedActive = '963aa947dff519f91c72768ec349185c140eca6b0995562a45566bb32191a273';
const expectedRollback = 'eb212812e962ba5f43e65b6219a94ccd62fbbdb4535a862987823e6e74911a50';
const sha = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
if (registry.registryRoot !== registry.defaultRegistryRoot) throw new Error('Rollback did not resolve the production registry.');
if (sha(registry.currentModelPath) !== expectedActive) throw new Error('Active hash changed; refusing stale rollback.');
if (sha(rollbackPath) !== expectedRollback) throw new Error('Rollback artifact hash mismatch.');
const result = registry.promoteLariModel(rollbackPath, {
  stage: 4, transaction: 'exact-production-rollback', rollback: true,
  rollbackTargetHash: expectedRollback, rolledBackFromHash: expectedActive,
  sourcePromotionManifest: 'consolidation/stage-4-real-promotion-manifest.json'
});
const activeHash = sha(registry.currentModelPath);
if (activeHash !== expectedRollback) throw new Error(`Rollback activated unexpected hash ${activeHash}.`);
process.stdout.write(`${JSON.stringify({ activeHash, expectedRollback, registry: result }, null, 2)}\n`);
