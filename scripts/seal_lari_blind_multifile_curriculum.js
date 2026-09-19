#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(ROOT, 'consolidation', 'blind-multifile-curriculum-20260723');
const PAYLOAD_PATH = path.join(OUTPUT_ROOT, 'sealed-cases.json');
const MANIFEST_PATH = path.join(OUTPUT_ROOT, 'seal-manifest.json');

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  if (fs.existsSync(PAYLOAD_PATH) || fs.existsSync(MANIFEST_PATH)) {
    throw new Error('Blind multi-file curriculum is already sealed; refusing to overwrite it.');
  }
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const sealedAt = new Date().toISOString();
  const payload = {
    schemaVersion: 1,
    family: 'coordinated_multi_file_falsy_count',
    training: {
      id: 'sealed-training-javascript',
      language: 'javascript',
      testPath: 'tests/dispatch.test.js',
      expressionTarget: 'src/queue.js',
      files: {
        'src/rules.js': 'function isDispatchable(parcel) {\n  return false;\n}\n\nmodule.exports = { isDispatchable };\n',
        'src/queue.js': 'const { isDispatchable } = require("./rules");\n\nfunction dispatchableCount(parcels) {\n  return 0;\n}\n\nmodule.exports = { dispatchableCount };\n',
        'tests/dispatch.test.js': 'const assert = require("assert");\nconst { isDispatchable } = require("../src/rules");\nconst { dispatchableCount } = require("../src/queue");\nconst readyA = { blocked: false, weight: 4 };\nconst stopped = { blocked: true, weight: 20 };\nconst readyB = { blocked: false, weight: 7 };\nassert.strictEqual(isDispatchable(readyA), true);\nassert.strictEqual(isDispatchable(stopped), false);\nassert.strictEqual(dispatchableCount([readyA, stopped, readyB]), 2);\nconsole.log("dispatch behavior verified");\n'
      }
    },
    holdout: {
      id: 'sealed-transfer-python',
      language: 'python',
      testPath: 'checks/verify_batch.py',
      expressionTarget: 'pipeline/batch.py',
      files: {
        'pipeline/__init__.py': '',
        'pipeline/checks.py': 'def can_process(job):\n    return False\n',
        'pipeline/batch.py': 'from .checks import can_process\n\ndef processable_count(jobs):\n    return 0\n',
        'checks/verify_batch.py': 'from pipeline.checks import can_process\nfrom pipeline.batch import processable_count\n\nfirst = {"suspended": False, "cost": 3}\npaused = {"suspended": True, "cost": 40}\nsecond = {"suspended": False, "cost": 8}\nassert can_process(first) is True\nassert can_process(paused) is False\nassert processable_count([first, paused, second]) == 2\nprint("batch behavior verified")\n'
      }
    }
  };
  const payloadBytes = Buffer.from(stableJson(payload));
  fs.writeFileSync(PAYLOAD_PATH, payloadBytes, { flag: 'wx' });
  const manifest = {
    schemaVersion: 1,
    sealedAt,
    payload: {
      path: path.relative(ROOT, PAYLOAD_PATH).replace(/\\/g, '/'),
      sha256: sha256Bytes(payloadBytes),
      bytes: payloadBytes.length
    },
    trainingId: payload.training.id,
    holdoutId: payload.holdout.id,
    holdoutVisibleToLearner: false,
    mutationPolicy: 'immutable'
  };
  fs.writeFileSync(MANIFEST_PATH, stableJson(manifest), { flag: 'wx' });
  fs.chmodSync(PAYLOAD_PATH, 0o444);
  fs.chmodSync(MANIFEST_PATH, 0o444);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main();
