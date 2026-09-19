#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'chat-coding-expansion-20260829');
const TARGET = path.join(OUT, 'sealed-oracle-amendment.json');
const CURRICULUM = path.join(OUT, 'sealed-curriculum.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (fs.existsSync(TARGET)) throw new Error('Oracle amendment is already sealed.');
const amendment = {
  schemaVersion: 1,
  kind: 'lari.chat-coding-expansion.oracle-integrity-amendment',
  createdAt: new Date().toISOString(),
  parentCurriculum: {
    path: path.relative(ROOT, CURRICULUM).replace(/\\/g, '/'),
    sha256: sha(CURRICULUM)
  },
  reason: 'Rust inline tests and the C# in-program oracle could be replaced by synthesized repairs, invalidating apparent passes.',
  immutableRequirements: {
    externalOracleFiles: true,
    hashAlgorithm: 'sha256',
    hashBeforeRepair: true,
    hashAfterRepair: true,
    unchangedForEveryCase: true,
    zeroTestRunsRejected: true,
    candidateMustBeRetrainedFromCleanParent: true
  },
  affectedLanguages: ['rust', 'csharp'],
  scope: 'All 66 coding curriculum cases must now preserve separately identified oracle files byte-for-byte.'
};
fs.writeFileSync(TARGET, `${JSON.stringify(amendment, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ path: path.relative(ROOT, TARGET).replace(/\\/g, '/'), sha256: sha(TARGET) }, null, 2));
