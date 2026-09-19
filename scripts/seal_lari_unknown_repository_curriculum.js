#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'coding-mastery-acquisition-attempt3-20260830');
const PUBLIC = path.join(OUT, 'public-training.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeExclusive = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
};

const publicTraining = {
  schemaVersion: 1,
  kind: 'lari.coding-mastery.public-training',
  case: {
    id: 'training.async.eligible-count',
    language: 'javascript',
    testRunner: 'javascript.node',
    testPath: 'tests/summary.test.js',
    expressionTarget: 'src/summary.js',
    files: {
      'src/select.js': "async function selectEligible(rows) {\n  return rows;\n}\n\nmodule.exports = { selectEligible };\n",
      'src/summary.js': "const { selectEligible } = require('./select');\n\nasync function countEligible(rows) {\n  return rows.length;\n}\n\nmodule.exports = { countEligible };\n",
      'tests/summary.test.js': "const assert = require('assert');\nconst { selectEligible } = require('../src/select');\nconst { countEligible } = require('../src/summary');\n(async () => {\n  const rows = [{ eligible: true, points: 4 }, { eligible: false, points: 9 }, { eligible: true, points: 2 }];\n  assert.deepStrictEqual(await selectEligible(rows), [rows[0], rows[2]]);\n  assert.strictEqual(await countEligible(rows), 2);\n  console.log('eligible helper and count verified');\n})().catch(error => { console.error(error); process.exit(1); });\n"
    }
  }
};

const hiddenHoldouts = {
  schemaVersion: 1,
  kind: 'lari.coding-mastery.hidden-holdouts',
  cases: [
    {
      id: 'hidden.js.ready-count', language: 'javascript', testRunner: 'javascript.node', testPath: 'checks/verify.js', expressionTarget: 'lib/report.js',
      files: {
        'lib/select.js': "async function chooseReady(items) {\n  return items;\n}\nmodule.exports = { chooseReady };\n",
        'lib/report.js': "const { chooseReady } = require('./select');\nasync function readyTotal(items) {\n  return items.length;\n}\nmodule.exports = { readyTotal };\n",
        'checks/verify.js': "const assert = require('assert');\nconst { chooseReady } = require('../lib/select');\nconst { readyTotal } = require('../lib/report');\n(async () => { const items = [{ ready: false, weight: 8 }, { ready: true, weight: 3 }, { ready: true, weight: 1 }]; assert.deepStrictEqual(await chooseReady(items), [items[1], items[2]]); assert.strictEqual(await readyTotal(items), 2); console.log('ready helper and count verified'); })().catch(error => { console.error(error); process.exit(1); });\n"
      }
    },
    {
      id: 'hidden.py.active-count', language: 'python', testRunner: 'python.script', testPath: 'checks/verify.py', expressionTarget: 'pipeline/report.py',
      files: {
        'pipeline/__init__.py': '',
        'pipeline/select.py': "async def select_active(records):\n    return records\n",
        'pipeline/report.py': "from .select import select_active\n\nasync def active_count(records):\n    return len(records)\n",
        'checks/verify.py': "import asyncio\nfrom pipeline.select import select_active\nfrom pipeline.report import active_count\nrecords = [{'active': True, 'score': 5}, {'active': False, 'score': 7}, {'active': True, 'score': 1}, {'active': False, 'score': 4}]\nassert asyncio.run(select_active(records)) == [records[0], records[2]]\nassert asyncio.run(active_count(records)) == 2\nprint('active helper and count verified')\n"
      }
    },
    {
      id: 'hidden.js.allowed-count', language: 'javascript', testRunner: 'javascript.node', testPath: 'spec/run.js', expressionTarget: 'core/stats.js',
      files: {
        'core/filter.js': "async function allowedEntries(entries) {\n  return entries;\n}\nmodule.exports = { allowedEntries };\n",
        'core/stats.js': "const { allowedEntries } = require('./filter');\nasync function allowedCount(entries) {\n  return entries.length;\n}\nmodule.exports = { allowedCount };\n",
        'spec/run.js': "const assert = require('assert');\nconst { allowedEntries } = require('../core/filter');\nconst { allowedCount } = require('../core/stats');\n(async () => { const entries = [{ allowed: true, amount: 10 }, { allowed: false, amount: 20 }, { allowed: false, amount: 3 }]; assert.deepStrictEqual(await allowedEntries(entries), [entries[0]]); assert.strictEqual(await allowedCount(entries), 1); console.log('allowed helper and count verified'); })().catch(error => { console.error(error); process.exit(1); });\n"
      }
    },
    {
      id: 'hidden.py.verified-count', language: 'python', testRunner: 'python.script', testPath: 'proof/check.py', expressionTarget: 'service/totals.py',
      files: {
        'service/__init__.py': '',
        'service/filtering.py': "async def verified_rows(rows):\n    return rows\n",
        'service/totals.py': "from .filtering import verified_rows\n\nasync def verified_total(rows):\n    return len(rows)\n",
        'proof/check.py': "import asyncio\nfrom service.filtering import verified_rows\nfrom service.totals import verified_total\nrows = [{'verified': False, 'cost': 2}, {'verified': True, 'cost': 6}, {'verified': True, 'cost': 4}]\nassert asyncio.run(verified_rows(rows)) == [rows[1], rows[2]]\nassert asyncio.run(verified_total(rows)) == 2\nprint('verified helper and count verified')\n"
      }
    }
  ]
};

function main() {
  if (fs.existsSync(SEAL) || fs.existsSync(PUBLIC) || fs.existsSync(HIDDEN)) throw new Error('Curriculum namespace already exists.');
  const publicBytes = Buffer.from(`${JSON.stringify(publicTraining, null, 2)}\n`);
  const hiddenBytes = Buffer.from(`${JSON.stringify(hiddenHoldouts, null, 2)}\n`);
  writeExclusive(PUBLIC, publicTraining);
  writeExclusive(HIDDEN, hiddenHoldouts);
  writeExclusive(SEAL, {
    schemaVersion: 1,
    kind: 'lari.coding-mastery.sealed-index',
    createdAt: new Date().toISOString(),
    publicTraining: { path: path.relative(ROOT, PUBLIC).replace(/\\/g, '/'), sha256: sha(publicBytes), cases: 1 },
    hiddenHoldouts: { path: path.relative(ROOT, HIDDEN).replace(/\\/g, '/'), sha256: sha(hiddenBytes), cases: hiddenHoldouts.cases.length },
    learnerMayRead: [path.relative(ROOT, PUBLIC).replace(/\\/g, '/')],
    learnerMustNotRead: [path.relative(ROOT, HIDDEN).replace(/\\/g, '/')]
  });
  process.stdout.write(`${JSON.stringify({ passed: true, publicHash: sha(publicBytes), hiddenHash: sha(hiddenBytes), hiddenCases: hiddenHoldouts.cases.length }, null, 2)}\n`);
}

main();
