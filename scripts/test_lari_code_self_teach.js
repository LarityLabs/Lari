#!/usr/bin/env node
'use strict';

/**
 * Tests the self-teaching coding loop:
 *  1. Sandbox runs code and captures output.
 *  2. Seed tasks verify against their oracles (13/13).
 *  3. Solutions are retained; second cycle is instant (from memory).
 *  4. Failures become learning goals, not bluffs.
 *  5. Chat bridge answers verifiable requests, honestly declines others.
 */

const path = require('path');
const teach = require(path.join(__dirname, '..', 'swarm_code_self_teach.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 200)}` : ''}`);
  }
}

// 1. Sandbox.
const run = teach.runCodeSandbox('python', 'print(2 + 2)');
check('sandbox runs python', run.ok && run.stdout.trim() === '4', run.stdout);
const bad = teach.runCodeSandbox('python', 'print(undefined_var)');
check('sandbox reports errors', !bad.ok && /NameError|undefined_var/.test(bad.stderr));
const slow = teach.runCodeSandbox('python', 'while True: pass', { timeoutMs: 500 });
check('sandbox enforces timeout', slow.timedOut === true);
const js = teach.runCodeSandbox('javascript', 'console.log(3 * 3)');
check('sandbox runs javascript', js.ok && js.stdout.trim() === '9', js.stdout);

// 2. Full self-teach cycle.
const model = {};
const summary = teach.runCodingSelfTeachCycle(model, { maxTasks: 13 });
check('self-teach passes all seeds', summary.passed === 13 && summary.failed === 0,
  `${summary.passed}/${summary.total}`);
check('solutions retained', teach.getRetainedSolutions(model).length === 13);

// 3. Second cycle is from memory (fast, no sandbox needed for known tasks).
const s2 = teach.runCodingSelfTeachCycle(model, { maxTasks: 13 });
check('second cycle all retained', s2.passed === 13 && s2.results.every(r => r.skipped));

// 4. Failures become learning goals.
const failModel = {};
const impossible = {
  id: 'test-impossible', language: 'python',
  description: 'do something no pattern can do xyzzy',
  verify: { type: 'stdout', expected: 'never' }
};
const fr = teach.selfTeachCodingTask(failModel, impossible);
check('impossible task fails honestly', fr.passed === false);
check('failure becomes learning goal',
  (failModel.lariCodeGeneration?.learningGoals || []).length === 1);

// 5. Chat bridge.
const bridgeModel = {};
const good = teach.answerCodingRequest(bridgeModel, 'write a python script that prints the first 10 fibonacci numbers', {});
check('bridge answers verifiable request', !!(good && good.verified && /```python/.test(good.answer)));
const badReq = teach.answerCodingRequest({}, 'write a python script that predicts the stock market', {});
check('bridge declines unverifiable request', badReq === null);

console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
