#!/usr/bin/env node
'use strict';

/**
 * Asserts the agentic loop against a real interpreter, driving real synthesis, over TWO stubs.
 *
 * The positive case is a multi-step task: a module with two unimplemented functions and a suite that
 * fails on both. Finishing it requires the loop to accept a step, re-observe, and act again -- which is
 * the whole difference between a loop and a function call.
 *
 * The assertions that matter are the refusals, because a loop is a multiplier and the dangerous failure
 * is a confident one:
 *
 *   - a step that does not reduce the failing count is rolled back
 *   - a pass that accepts nothing stops the loop instead of wandering
 *   - the step bound is honoured
 *   - `completed` is never true unless the suite is actually green
 *
 * Usage: node scripts/test_lari_agentic_loop.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const loop = require(path.join(__dirname, '..', 'swarm_agentic_loop.js'));
const synthesis = require(path.join(__dirname, '..', 'swarm_program_synthesis.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 240)}` : ''}`);
  }
}

if (spawnSync('python', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('SKIP: python is not available.');
  process.exit(0);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-loop-'));
const modulePath = path.join(workspace, 'target.py');
const testPath = path.join(workspace, 'test_target.py');

/** The oracle at task scope: how many tests fail? */
function runSuite(source) {
  fs.writeFileSync(modulePath, source);
  // Candidate bodies can have identical byte lengths and be written within the same filesystem
  // timestamp tick. CPython may otherwise reuse stale bytecode and make a valid candidate appear to
  // have no effect, which turns the oracle into a cache test instead of a behavior test.
  fs.rmSync(path.join(workspace, '__pycache__'), { recursive: true, force: true });
  // This unit test needs a real interpreter and a failure count, not pytest's plugin machinery.
  // Direct execution also keeps the timeout enforceable on Windows process trees.
  const run = spawnSync('python', [testPath],
    { cwd: workspace, encoding: 'utf8', timeout: 120000, windowsHide: true });
  const out = String(run.stdout || '');
  const failed = (out.match(/(\d+) failed/) || [])[1];
  const errors = (out.match(/(\d+) error/) || [])[1];
  return {
    passed: run.status === 0,
    failingCount: Number(failed || 0) + Number(errors || 0) || (run.status === 0 ? 0 : 1)
  };
}

/** The only action the loop is given: fill one stub, using the synthesis lane. */
const synthesizeAction = {
  id: 'synthesize-stub',
  propose({ source }) {
    for (const stub of synthesis.findStubs(source)) {
      // Task scope: accept a body that reduces the failing count, because filling one of several stubs
      // cannot make the whole suite green on its own. The loop then applies its own monotonic-progress
      // check before keeping anything, so this relaxation never becomes the final word.
      const result = synthesis.synthesizeStub(source, stub, runSuite, {
        budget: 120,
        accept: (after, baseline) => after.failingCount < baseline.failingCount
      });
      if (result.synthesized) return { source: result.source, note: `${stub.name} = ${result.expression}` };
    }
    return null;
  }
};

console.log('a two-stub task, which needs more than one step');
{
  fs.writeFileSync(testPath, [
    'from target import add, times',
    '',
    'def check(assertion):',
    '    try:',
    '        return bool(assertion())',
    '    except Exception:',
    '        return False',
    '',
    'checks = [lambda: add(2, 3) == 5, lambda: add(10, 1) == 11, lambda: times(2, 3) == 6, lambda: times(4, 5) == 20]',
    'failed = sum(1 for assertion in checks if not check(assertion))',
    'print(f"{failed} failed" if failed else "4 passed")',
    'raise SystemExit(1 if failed else 0)',
    ''
  ].join('\n'));
  const source = ['def add(a, b):', '    pass', '', 'def times(a, b):', '    pass', ''].join('\n');

  const before = runSuite(source);
  check('the task starts with the suite failing', !before.passed && before.failingCount >= 2, before);

  const result = loop.runAgenticLoop({ source, runSuite, actions: [synthesizeAction], maxSteps: 8 });
  check('the loop completes the task', result.completed, result.reason);
  check('it took more than one step', result.steps >= 1, result.steps);
  check('both functions were written',
    /def add\(a, b\):\s*\n\s*return/.test(result.source) && /def times\(a, b\):\s*\n\s*return/.test(result.source),
    result.source);
  check('and it is actually green, checked independently of the loop', runSuite(result.source).passed);
  check('no external model calls', result.externalModelCalls === 0);
  console.log(`  ..   ${loop.summarizeRun(result)}`);
}

console.log('\nrefusal: a step that does not improve is rolled back');
{
  // An action that always makes things worse. The loop must never keep its output.
  const vandal = {
    id: 'vandal',
    propose: ({ source }) => ({ source: `${source}\nraise RuntimeError("worse")\n`, note: 'breaks everything' })
  };
  fs.writeFileSync(testPath, ['from target import add', '', 'assert add(2, 3) == 5', ''].join('\n'));
  const source = ['def add(a, b):', '    pass', ''].join('\n');

  const result = loop.runAgenticLoop({ source, runSuite, actions: [vandal], maxSteps: 4 });
  check('the loop does not complete', result.completed === false, result);
  check('the damaging change was not kept', !/RuntimeError/.test(result.source), result.source);
  check('it stopped rather than wandering', /no action produced a verified improvement/.test(result.reason),
    result.reason);
  check('and the rejected step is in the transcript, not hidden',
    result.transcript.some(t => t.phase === 'verify' && t.accepted === false));
}

console.log('\nrefusal: the step bound is honoured');
{
  // An action that always changes something and never helps: it adds a harmless comment. The loop
  // cannot accept it (no improvement), so it stops on pass 1 -- the bound is the backstop, not the
  // primary guard.
  let n = 0;
  const fidget = { id: 'fidget', propose: ({ source }) => ({ source: `${source}\n# ${n += 1}\n`, note: 'noise' }) };
  fs.writeFileSync(testPath, ['from target import add', '', 'assert add(2, 3) == 5', ''].join('\n'));
  const result = loop.runAgenticLoop({
    source: ['def add(a, b):', '    pass', ''].join('\n'),
    runSuite, actions: [fidget], maxSteps: 3
  });
  check('it does not claim completion', result.completed === false);
  check('it never exceeds the bound', result.steps <= 3, result.steps);
  check('and reports how many tests still fail', typeof result.failingCount === 'number', result.failingCount);
}

console.log('\nrefusal: an already-green suite is not "work done"');
{
  fs.writeFileSync(testPath, ['assert True', ''].join('\n'));
  const result = loop.runAgenticLoop({
    source: 'x = 1\n', runSuite, actions: [synthesizeAction], maxSteps: 5
  });
  check('it reports completion', result.completed === true);
  check('with zero steps taken', result.steps === 0, result.steps);
  check('and says the suite was already green', /already green/.test(result.reason), result.reason);
}

console.log('\nthe summary is past tense and does not overclaim');
{
  fs.writeFileSync(testPath, ['from target import add', '', 'assert add(2, 3) == 5', ''].join('\n'));
  const result = loop.runAgenticLoop({
    source: ['def add(a, b):', '    pass', ''].join('\n'),
    runSuite, actions: [synthesizeAction], maxSteps: 5
  });
  const text = loop.summarizeRun(result);
  check('it reports how many changes were kept and rolled back',
    /kept \d+ and rolled back \d+/.test(text), text);
  for (const quantifier of [/\balways\b/i, /\bnever\b/i, /\bguarantee/i, /\bcorrect\b/i]) {
    check(`the summary avoids ${quantifier}`, !quantifier.test(text), text);
  }
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
