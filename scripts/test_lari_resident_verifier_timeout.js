#!/usr/bin/env node
'use strict';

/**
 * Regression test for the runaway-candidate defect, third occurrence.
 *
 * NOT a capability gate. It builds a throwaway python package whose test hangs on purpose and asserts
 * that the client gives up, kills the process, and keeps going. It cannot fail for capability reasons.
 *
 * History it protects: a 15-minute timeout that made one instance cost ~20 hours; spawnSync killing a
 * shell while python grandchildren kept burning CPU; and -- on 2026-07-27 -- a resident verifier with
 * no request bound at all, which ran a single candidate for 3h34m and 12,522 seconds of CPU while the
 * node process sat idle waiting. Each time the fix was correct and each time it was reintroduced
 * somewhere the previous fix did not reach, which is why the client is now shared and tested.
 *
 * Usage: node scripts/test_lari_resident_verifier_timeout.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createResidentVerifier } = require(path.join(__dirname, 'lari_resident_verifier_client.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-resident-'));
  fs.mkdirSync(path.join(root, 'fixturepkg'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'fixturepkg', '__init__.py'), 'from .core import compute\n');
  // The value of LOOPS decides whether the module terminates: 0 returns immediately, -1 never does.
  // A statement deletion or an off-by-one in a real repository produces exactly this shape.
  fs.writeFileSync(path.join(root, 'fixturepkg', 'core.py'),
    'LOOPS = 0\n\n\ndef compute():\n    total = 0\n    n = LOOPS\n    while n != 0:\n        total += 1\n        n -= 1\n    return total\n');
  fs.writeFileSync(path.join(root, 'tests', 'test_core.py'),
    'from fixturepkg import compute\n\n\ndef test_compute():\n    assert compute() == 0\n');
  return root;
}

/**
 * A source file with non-ASCII characters must round-trip through the verifier.
 *
 * On Windows sys.stdin decodes with the ANSI code page, so UTF-8 bytes arrive mis-decoded and any byte
 * cp1252 cannot map becomes a lone surrogate that fails to write back out. The verifier then answered
 * {"passed": false} for *correct* code. It rejected everything in tabulate/__init__.py -- which draws
 * tables with box-drawing characters, and `┐` is E2 94 90 -- scoring 0 of 87 curriculum defects across
 * two runs, while pure-ASCII cli.py in the same repository and the same runs scored 57 of 103.
 */
async function nonAsciiSource() {
  console.log('\nresident verifier, non-ASCII source');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-utf8-'));
  fs.mkdirSync(path.join(root, 'boxpkg'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'boxpkg', '__init__.py'), 'from .core import border\n', 'utf8');
  fs.writeFileSync(path.join(root, 'boxpkg', 'core.py'),
    'CORNERS = ["┌", "─", "┬", "┐"]\n\n\ndef border(width):\n    return CORNERS[0] + "─" * width\n', 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'test_core.py'),
    'from boxpkg import border\n\n\ndef test_border():\n    assert border(3) == "┌───"\n', 'utf8');

  const targetRelative = 'boxpkg/core.py';
  const good = fs.readFileSync(path.join(root, targetRelative), 'utf8');
  const broken = good.replace('CORNERS[0] +', 'CORNERS[1] +');

  const verifier = createResidentVerifier({
    repo: root, targetRelative, testIds: ['tests/test_core.py::test_border'],
    baselineSource: broken, requestTimeoutMs: 30000, startupTimeoutMs: 60000
  });

  const wrong = await verifier.verify(broken);
  const right = await verifier.verify(good);
  check('a wrong candidate is rejected', wrong.passed === false, JSON.stringify(wrong));
  check('a correct candidate with non-ASCII source is accepted', right.passed === true, JSON.stringify(right));
  check('no oracle error was swallowed as a rejection', verifier.stats.errors === 0,
    `errors=${verifier.stats.errors} first=${verifier.stats.firstError}`);

  await verifier.stop();
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* temp dir */ }
}

async function main() {
  console.log('resident verifier timeout');
  const repo = buildFixture();
  const targetRelative = 'fixturepkg/core.py';
  const baselineSource = fs.readFileSync(path.join(repo, targetRelative), 'utf8');

  // Measured on this fixture: the first request costs ~9.3s and later ones ~1.1s. The first one pays
  // for pytest's collection and conftest handling, which happens after the process reports ready --
  // so the bound has to clear the first request, not the steady state. Fifteen seconds does, and a
  // hanging candidate still has nowhere to hide.
  const verifier = createResidentVerifier({
    repo, targetRelative, testIds: ['tests/test_core.py::test_compute'],
    baselineSource, requestTimeoutMs: 15000, startupTimeoutMs: 60000
  });

  const good = await verifier.verify(baselineSource);
  check('a terminating candidate is verified normally', good.passed === true, JSON.stringify(good));

  const hanging = baselineSource.replace('LOOPS = 0', 'LOOPS = -1');
  const startedAt = Date.now();
  const stuck = await verifier.verify(hanging);
  const elapsed = Date.now() - startedAt;

  check('a non-halting candidate is rejected rather than awaited', stuck.passed === false, JSON.stringify(stuck));
  check('it is reported as a timeout, not as an ordinary failure', stuck.timedOut === true);
  check('the bound is actually enforced', elapsed < 30000, `took ${elapsed}ms`);
  check('the timeout is counted', verifier.stats.timeouts === 1, `timeouts=${verifier.stats.timeouts}`);

  // The point of restarting: the search must continue after a runaway, from the seeded source rather
  // than from whatever the killed child left on disk.
  const after = await verifier.verify(baselineSource);
  check('the search continues after a runaway', after.passed === true, JSON.stringify(after));
  check('the restart is counted', verifier.stats.restarts === 1, `restarts=${verifier.stats.restarts}`);

  await verifier.stop();
  // A just-killed python can still hold the directory on Windows; cleanup failing is not a test result.
  try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* leave it to the temp dir */ }

  await nonAsciiSource();

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(error.stack || String(error)); process.exit(1); });
