/**
 * Tests for the three new verification/task capabilities:
 *   1. Differential verification (no oracle — agreement across derivations)
 *   2. Property checks (invariants instead of exact output)
 *   3. Real-world tasks: file I/O, test suites, repo repair
 *
 * Run: node scripts/test_lari_code_verify.js
 */
'use strict';

const agentic = require('../swarm_code_agentic.js');
const teach = require('../swarm_code_self_teach.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function freshModel() {
  return { lariCodeGeneration: { solutions: [], practiceLog: [], learningGoals: [] } };
}

console.log('== 1. Differential verification ==');
{
  const model = freshModel();
  // No oracle anywhere: "first 10 fibonacci numbers" must be derived in
  // python AND javascript independently and agree.
  const task = {
    id: 'no-oracle-fib-10',
    language: 'python',
    description: 'print the first 10 fibonacci numbers, one per line',
    tags: ['fibonacci']
  };
  const diff = agentic.differentialVerify(model, task);
  check('differential agreement found without oracle', diff.verified === true,
    JSON.stringify(diff.groups));
  check('agreement spans python and javascript families',
    diff.agreement && diff.agreement.families.some(f => f.startsWith('python')) &&
    diff.agreement.families.some(f => f.startsWith('javascript')),
    JSON.stringify(diff.agreement));
  const expected = '0\n1\n1\n2\n3\n5\n8\n13\n21\n34';
  check('agreed output is actually correct', diff.output === expected,
    JSON.stringify((diff.output || '').slice(0, 60)));
}

console.log('== 1b. Differential verification is honest when derivations are thin ==');
{
  const model = freshModel();
  // "triangular numbers" has no pattern, no retained solution, no learned
  // pattern in a fresh model — nothing to agree with.
  const task = {
    id: 'no-oracle-tri-7',
    language: 'python',
    description: 'print the first 7 triangular numbers, one per line',
    tags: ['triangular']
  };
  const diff = agentic.differentialVerify(model, task);
  check('no agreement claimed with < 2 families', diff.verified === false,
    JSON.stringify(diff.groups));
  check('no phantom output retained', diff.output === null);

  // Threshold enforcement: even with 2 agreeing families, minFamilies 3 fails.
  const fibTask = {
    id: 'no-oracle-fib-10b', language: 'python',
    description: 'print the first 10 fibonacci numbers, one per line', tags: ['fibonacci']
  };
  const strict = agentic.differentialVerify(freshModel(), fibTask, { minFamilies: 3 });
  check('minFamilies threshold enforced', strict.verified === false);
}

console.log('== 1c. Self-teach without oracle end to end ==');
{
  const model = freshModel();
  const task = {
    id: 'no-oracle-fib-10c', language: 'python',
    description: 'print the first 10 fibonacci numbers, one per line', tags: ['fibonacci']
  };
  const r = agentic.selfTeachTaskNoOracle(model, task);
  check('no-oracle self-teach passes', r.passed === true,
    JSON.stringify(r.verification && r.verification.reason));
  check('retained with provenance marker', teach.getRetainedSolutions(model).some(s =>
    s.taskId === task.id && s.verifiedBy === 'differential+properties' && s.derivedOracle === r.output));
}

console.log('== 2. Property checks ==');
{
  const goodFizz = 'for i in range(1, 16):\n    s = ""\n    if i % 3 == 0:\n        s += "Fizz"\n    if i % 5 == 0:\n        s += "Buzz"\n    print(s or i)\n';
  const task = { id: 'prop-fizz', language: 'python', description: 'print FizzBuzz from 1 to 15, one per line' };
  const good = agentic.verifyWithProperties(task, goodFizz);
  check('correct fizzbuzz passes all properties', good.passed === true,
    JSON.stringify(good.propertyResults));
  check('fizzbuzz_rules property present and passing',
    good.propertyResults.some(p => p.id === 'fizzbuzz_rules' && p.passed));

  const badFizz = 'for i in range(1, 16):\n    print(i)\n'; // no Fizz/Buzz at all
  const bad = agentic.verifyWithProperties(task, badFizz);
  check('wrong fizzbuzz fails fizzbuzz_rules', bad.passed === false &&
    bad.propertyResults.some(p => p.id === 'fizzbuzz_rules' && !p.passed),
    JSON.stringify(bad.propertyResults));
  check('wrong fizzbuzz still passes generic properties (it runs fine)',
    bad.propertyResults.filter(p => ['exits_clean', 'terminates', 'deterministic'].includes(p.id)).every(p => p.passed));

  const unsorted = 'print(3)\nprint(1)\nprint(2)\n';
  const sortTask = { id: 'prop-sort', language: 'python', description: 'sort the numbers 3, 1, 2 ascending, one per line' };
  const sortBad = agentic.verifyWithProperties(sortTask, unsorted);
  check('unsorted output fails sorted_ascending',
    sortBad.propertyResults.some(p => p.id === 'sorted_ascending' && !p.passed));

  const sorted = 'for x in sorted([3, 1, 2]):\n    print(x)\n';
  const sortGood = agentic.verifyWithProperties(sortTask, sorted);
  check('sorted output passes sorted_ascending',
    sortGood.propertyResults.some(p => p.id === 'sorted_ascending' && p.passed));

  const nondeterministic = 'import random\nprint(random.randint(1, 1000))\n';
  const ndTask = { id: 'prop-nd', language: 'python', description: 'print a random number' };
  const nd = agentic.verifyWithProperties(ndTask, nondeterministic);
  check('nondeterministic code fails deterministic property',
    nd.propertyResults.some(p => p.id === 'deterministic' && !p.passed));
}

console.log('== 3a. File I/O tasks ==');
{
  const model = freshModel();
  const sumTask = agentic.FILE_TASK_SEEDS.find(t => t.id === 'py-file-sum');
  const r1 = agentic.runFileTask(model, sumTask);
  check('file task reads numbers.txt and writes sum', r1.passed === true,
    JSON.stringify(r1.verification));
  check('file task solution retained', teach.getRetainedSolutions(model).some(s => s.taskId === 'py-file-sum'));

  // Second run comes from retained memory, still passes.
  const r1b = agentic.runFileTask(model, sumTask);
  check('file task passes from retained solution', r1b.passed === true);

  const countTask = agentic.FILE_TASK_SEEDS.find(t => t.id === 'py-file-count');
  const r2 = agentic.runFileTask(model, countTask);
  check('file task counts lines to answer.txt', r2.passed === true,
    JSON.stringify(r2.verification));
}

console.log('== 3b. Test-suite tasks ==');
{
  const model = freshModel();
  const doubleTask = agentic.TEST_SUITE_SEEDS.find(t => t.id === 'py-suite-double');
  const r1 = agentic.runTestSuiteTask(model, doubleTask);
  check('test-suite task implements double(n)', r1.passed === true,
    JSON.stringify(r1.verification));

  const factTask = agentic.TEST_SUITE_SEEDS.find(t => t.id === 'py-suite-factorial-fn');
  const r2 = agentic.runTestSuiteTask(model, factTask);
  check('test-suite task implements factorial(n)', r2.passed === true,
    JSON.stringify(r2.verification));
}

console.log('== 3c. Repo repair tasks ==');
{
  const model = freshModel();
  const importTask = agentic.REPO_REPAIR_SEEDS.find(t => t.id === 'repo-broken-import');
  const r1 = agentic.runRepoRepairTask(model, importTask);
  check('repo repair fixes cross-file import typo', r1.passed === true,
    JSON.stringify({ strategy: r1.strategy, verification: r1.verification }));
  check('repo repair strategy names the rename',
    /rename_addd_to_add/.test(r1.strategy || ''), r1.strategy);

  const counterTask = agentic.REPO_REPAIR_SEEDS.find(t => t.id === 'repo-wrong-init');
  const r2 = agentic.runRepoRepairTask(model, counterTask);
  check('repo repair fixes wrong initial value via mutation', r2.passed === true,
    JSON.stringify({ strategy: r2.strategy, attempts: (r2.attempts || []).length }));
}

console.log('== 3d. exit_code verify type ==');
{
  const ok = teach.verifyAttempt({ verify: { type: 'exit_code', expected: 0 } },
    { ok: true, timedOut: false, exitCode: 0, stdout: '', stderr: '' });
  check('exit_code 0 matches', ok.passed === true);
  const bad = teach.verifyAttempt({ verify: { type: 'exit_code', expected: 0 } },
    { ok: true, timedOut: false, exitCode: 1, stdout: '', stderr: 'AssertionError' });
  check('exit_code 1 mismatches', bad.passed === false && bad.reason === 'exit_code_mismatch');
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failures.length) { console.log('Failures:', failures.join(', ')); process.exit(1); }
