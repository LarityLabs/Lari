#!/usr/bin/env node
'use strict';

/**
 * Asserts synthesis end to end against a real Python interpreter, and asserts that it REFUSES.
 *
 * The positive case is deliberately unglamorous -- a stub, a failing Python suite, a generated body, a
 * passing run -- because the claim is only that the loop closes. The assertions that carry weight are
 * the negative ones:
 *
 *   - a constant body that satisfies a thin suite is refused, not retained
 *   - a stub whose suite is already green synthesizes nothing
 *   - an unsynthesizable stub costs a bounded number of verifications and says so
 *
 * Everything runs in a temporary directory. Nothing touches the benchmark repositories.
 *
 * Usage: node scripts/test_lari_program_synthesis.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
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

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-synth-'));
const modulePath = path.join(workspace, 'target.py');
const testPath = path.join(workspace, 'test_target.py');

/** The injected oracle: write the candidate, run the suite, report pass/fail. */
function makeVerifier() {
  let calls = 0;
  const verify = (source) => {
    calls += 1;
    fs.writeFileSync(modulePath, source);
    // This test validates synthesis, not pytest integration. A direct assertion script keeps the
    // oracle real while avoiding Windows pytest plugin children that can outlive spawnSync timeout.
    const run = spawnSync('python', [testPath],
      { cwd: workspace, encoding: 'utf8', timeout: 120000, windowsHide: true });
    return { passed: run.status === 0 };
  };
  verify.calls = () => calls;
  return verify;
}

console.log('finding stubs');
{
  const source = [
    'def combine(a, b):',
    '    """Add two numbers."""',
    '    pass',
    '',
    'def already_written(x):',
    '    return x * 2',
    '',
    'def not_implemented(y):',
    '    raise NotImplementedError',
    ''
  ].join('\n');
  const stubs = synthesis.findStubs(source);
  const names = stubs.map(s => s.name);
  check('finds a `pass` stub', names.includes('combine'), names);
  check('finds a NotImplementedError stub', names.includes('not_implemented'), names);
  check('does NOT treat a written function as a stub', !names.includes('already_written'), names);
  const combine = stubs.find(s => s.name === 'combine');
  check('reads the parameters', JSON.stringify(combine.params) === '["a","b"]', combine.params);
  check('a docstring does not stop it being a stub', combine.bodyStart > combine.defLine);
}

console.log('\nsynthesizing a real function against a real Python suite');
{
  fs.writeFileSync(testPath, [
    'from target import combine',
    '',
    'assert combine(2, 3) == 5',
    'assert combine(10, 1) == 11',
    'assert combine(0, 0) == 0',
    ''
  ].join('\n'));
  const source = ['def combine(a, b):', '    pass', ''].join('\n');
  const stub = synthesis.findStubs(source)[0];
  const verify = makeVerifier();
  const result = synthesis.synthesizeStub(source, stub, verify, { budget: 200 });

  check('a body was synthesized', result.synthesized, result.reason);
  check('it is the correct expression', result.synthesized && /a \+ b|b \+ a/.test(result.expression),
    result.expression);
  check('it was verified twice', result.synthesized && result.provenance.verifiedTwice === true);
  check('the oracle is named as the project suite',
    result.synthesized && result.provenance.oracle === 'project test suite');
  check('it used a bounded number of verifications', result.attempts > 0 && result.attempts <= 200,
    result.attempts);
  check('no external model calls', result.externalModelCalls === 0);
  console.log(`  ..   found "${result.expression}" after ${result.attempts} verifications `
    + `of ${result.candidatesGenerated} candidates`);

  // The synthesized source really does pass, checked independently of the search.
  fs.writeFileSync(modulePath, result.source);
  const final = spawnSync('python', [testPath],
    { cwd: workspace, encoding: 'utf8', timeout: 120000, windowsHide: true });
  check('the retained source passes the suite on an independent run', final.status === 0);
}

console.log('\noracle 1: a trivial body is refused even when it passes');
{
  // A suite that ONLY a constant can satisfy, which took three attempts to construct and each failure
  // was informative:
  //
  //   `weak(0, 0) == 0`            -- `return a` satisfies it, and `a` is not trivial
  //   `weak(5, 7) == 0` etc.       -- `a // b` is 0 for both, and is not trivial either
  //   expecting 0 at all           -- `not a` returns False, and False == 0 in Python, so a
  //                                   syntactically non-trivial body is semantically constant
  //   `weak(...) is None`          -- a `pass` body returns None implicitly, so the STUB passes and
  //                                   oracle 2 fires: there is nothing to synthesize
  //
  // Two of those are worth remembering beyond this test. The triviality check is syntactic, so a body
  // that mentions a parameter and ignores its value passes it. And a Python stub is not a blank -- it
  // returns None, so None can never be the thing synthesis has to discover.
  //
  // The empty string avoids all four: no expression over these parameters yields it, and a stub does
  // not return it.
  fs.writeFileSync(testPath, [
    'from target import weak',
    '',
    "assert weak(5, 7) == ''",
    "assert weak(1, 2) == ''",
    ''
  ].join('\n'));
  const source = ['def weak(a, b):', '    pass', ''].join('\n');
  const stub = synthesis.findStubs(source)[0];
  const result = synthesis.synthesizeStub(source, stub, makeVerifier(), { budget: 200 });

  check('a constant that satisfies the suite is refused as trivial',
    !result.synthesized || /(?<![\w.])a(?![\w])|(?<![\w.])b(?![\w])/.test(result.expression),
    result.expression || result.reason);
  check('and the refusal is recorded rather than silently skipped',
    (result.rejectedAsTrivial || []).length > 0, result.rejectedAsTrivial);
  check('the recorded refusal says it passed the suite',
    (result.rejectedAsTrivial || []).every(r => /passed the suite/.test(r.note)));
  console.log(`  ..   refused ${(result.rejectedAsTrivial || []).length} trivial `
    + 'body/bodies that the suite accepted');
}

console.log('\noracle 2: nothing to synthesize when the suite is already green');
{
  fs.writeFileSync(testPath, ['assert True', ''].join('\n'));
  const source = ['def unused(a):', '    pass', ''].join('\n');
  const stub = synthesis.findStubs(source)[0];
  const result = synthesis.synthesizeStub(source, stub, makeVerifier(), { budget: 50 });
  check('synthesis refuses when the suite already passes', result.synthesized === false, result);
  check('and says so', /already passes/.test(result.reason), result.reason);
  check('without spending any verifications on candidates', result.attempts === 0, result.attempts);
}

console.log('\nan unsynthesizable stub fails within budget and says why');
{
  fs.writeFileSync(testPath, [
    'from target import impossible',
    '',
    'assert impossible(2, 3) == 999',
    'assert impossible(1, 1) == 7',
    ''
  ].join('\n'));
  const source = ['def impossible(a, b):', '    pass', ''].join('\n');
  const stub = synthesis.findStubs(source)[0];
  const result = synthesis.synthesizeStub(source, stub, makeVerifier(), { budget: 40 });
  check('it does not claim success', result.synthesized === false, result);
  check('it reports a bounded cost', result.attempts <= 40, result.attempts);
  check('and names the reason', /budget exhausted|no candidate passed/.test(result.reason), result.reason);
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
