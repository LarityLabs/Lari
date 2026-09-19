#!/usr/bin/env node
'use strict';

const registry = require('./lari_model_registry.js');

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';
  if (command === 'list') {
    output(registry.listLariModelHistory());
    return;
  }
  if (command !== 'rollback') throw new Error('Usage: npm run lari:history or npm run lari:rollback -- <sha256> --confirm');
  const targetHash = String(args[1] || '').toLowerCase();
  if (!args.includes('--confirm')) throw new Error('Rollback requires --confirm after reviewing the selected history point.');
  delete process.env.LARI_REGISTRY_ROOT;
  process.env.LARI_ALLOW_REAL_PROMOTION = '1';
  try {
    output(registry.rollbackLariModel(targetHash, {
      requestedBy: 'local-user',
      surface: process.env.LARI_ROLLBACK_SURFACE || 'cli'
    }));
  } finally {
    delete process.env.LARI_ALLOW_REAL_PROMOTION;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
}
