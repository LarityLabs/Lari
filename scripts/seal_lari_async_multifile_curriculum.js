#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(ROOT, 'consolidation', 'async-multifile-curriculum-20260723');
const PAYLOAD_PATH = path.join(OUTPUT_ROOT, 'sealed-cases.json');
const MANIFEST_PATH = path.join(OUTPUT_ROOT, 'seal-manifest.json');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableJson = value => `${JSON.stringify(value, null, 2)}\n`;

function main() {
  if (fs.existsSync(PAYLOAD_PATH) || fs.existsSync(MANIFEST_PATH)) {
    throw new Error('Async multi-file curriculum is already sealed; refusing to overwrite it.');
  }
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const payload = {
    schemaVersion: 1,
    family: 'coordinated_async_dependency_pipeline',
    training: {
      id: 'sealed-async-training-javascript',
      language: 'javascript',
      testPath: 'tests/priorities.test.js',
      expressionTarget: 'src/service.js',
      files: {
        'src/client.js': 'async function loadTickets(tickets) {\n  return [];\n}\n\nmodule.exports = { loadTickets };\n',
        'src/service.js': 'const { loadTickets } = require("./client");\n\nasync function openPriorities(tickets) {\n  return [];\n}\n\nmodule.exports = { openPriorities };\n',
        'tests/priorities.test.js': 'const assert = require("assert");\nconst { loadTickets } = require("../src/client");\nconst { openPriorities } = require("../src/service");\n\n(async () => {\n  const first = { closed: false, priority: 4 };\n  const done = { closed: true, priority: 30 };\n  const second = { closed: false, priority: 7 };\n  assert.deepStrictEqual(await loadTickets([first, done, second]), [first, second]);\n  assert.deepStrictEqual(await openPriorities([first, done, second]), [4, 7]);\n  console.log("async ticket behavior verified");\n})().catch(error => { console.error(error); process.exit(1); });\n'
      }
    },
    holdout: {
      id: 'sealed-async-transfer-python',
      language: 'python',
      testPath: 'tests/verify_scores.py',
      expressionTarget: 'pipeline/report.py',
      files: {
        'pipeline/__init__.py': '',
        'pipeline/source.py': 'async def collect_jobs(jobs):\n    return []\n',
        'pipeline/report.py': 'from .source import collect_jobs\n\nasync def ready_scores(jobs):\n    return []\n',
        'tests/verify_scores.py': 'import asyncio\nfrom pipeline.source import collect_jobs\nfrom pipeline.report import ready_scores\n\nasync def main():\n    first = {"paused": False, "score": 3}\n    stopped = {"paused": True, "score": 50}\n    second = {"paused": False, "score": 8}\n    assert await collect_jobs([first, stopped, second]) == [first, second]\n    assert await ready_scores([first, stopped, second]) == [3, 8]\n    print("async job behavior verified")\n\nasyncio.run(main())\n'
      }
    }
  };
  const payloadBytes = Buffer.from(stableJson(payload));
  fs.writeFileSync(PAYLOAD_PATH, payloadBytes, { flag: 'wx' });
  const manifest = {
    schemaVersion: 1,
    sealedAt: new Date().toISOString(),
    payload: {
      path: path.relative(ROOT, PAYLOAD_PATH).replace(/\\/g, '/'),
      sha256: sha256(payloadBytes),
      bytes: payloadBytes.length
    },
    family: payload.family,
    trainingId: payload.training.id,
    holdoutId: payload.holdout.id,
    holdoutVisibleToLearner: false,
    mutationPolicy: 'immutable'
  };
  fs.writeFileSync(MANIFEST_PATH, stableJson(manifest), { flag: 'wx' });
  fs.chmodSync(PAYLOAD_PATH, 0o444);
  fs.chmodSync(MANIFEST_PATH, 0o444);
  process.stdout.write(stableJson(manifest));
}

main();
