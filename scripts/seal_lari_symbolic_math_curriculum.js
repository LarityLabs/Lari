#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'consolidation', 'symbolic-math-neurogenesis-20260912');
const sealPath = path.join(out, 'sealed-curriculum.json');
const manifestPath = path.join(out, 'seal-manifest.json');
if (fs.existsSync(sealPath) || fs.existsSync(manifestPath)) throw new Error('seal already exists');
const payload = {
  schemaVersion: 1,
  family: 'reciprocal_scale_product',
  ruleMeaning: 'When reciprocal ratios produce the same shared value, the requested product is sharedValue squared divided by the scale factor.',
  visible: [
    { id: 'train-1', prompt: 'Calculate the product when reciprocal ratios share value 10 and the second relation has scale factor 4.', numbers: [10, 4], expected: 25 },
    { id: 'train-2', prompt: 'Calculate the product implied by two reciprocal ratio equations with common value 12 and multiplier 3.', numbers: [12, 3], expected: 48 },
    { id: 'train-3', prompt: 'Calculate the product for reciprocal constraints sharing 8 with scale coefficient 2.', numbers: [8, 2], expected: 32 }
  ],
  hidden: [
    { id: 'hidden-1', prompt: 'Calculate the product when reciprocal ratios share value 15 and the second relation has scale factor 5.', numbers: [15, 5], expected: 45 },
    { id: 'hidden-2', prompt: 'Calculate the product implied by two reciprocal ratio equations with common value 18 and multiplier 6.', numbers: [18, 6], expected: 54 },
    { id: 'hidden-3', prompt: 'Calculate the product for reciprocal constraints sharing 21 with scale coefficient 7.', numbers: [21, 7], expected: 63 }
  ],
  forbidden: { benchmarkPrompts: true, benchmarkAnswers: true, exactPromptLocks: true, externalModelCalls: true }
};
const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(sealPath, bytes, { flag: 'wx' });
fs.writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), payload: { path: path.relative(root, sealPath).replace(/\\/g, '/'), sha256: hash, bytes: bytes.length } }, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ sealed: true, sha256: hash, cases: payload.visible.length + payload.hidden.length }, null, 2));
