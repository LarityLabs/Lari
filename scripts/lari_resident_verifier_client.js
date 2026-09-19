'use strict';

/**
 * Client for scripts/lari_resident_verifier.py, with the timeout the cold path always had.
 *
 * Why this file exists at all
 * --------------------------
 * The runaway-timeout defect has now been introduced three times in this repository, each time by
 * someone adding a new place that runs candidate patches. A statement deletion or an off-by-one in a
 * loop bound produces a candidate that never terminates; without a bound, one candidate consumes the
 * entire run.
 *
 * The first two occurrences were in cold `pytest` runners and were fixed with a 90-second timeout plus
 * a sweep of orphaned python processes. The third was this: wiring the resident verifier into the
 * measurement path replaced a timeout-protected cold pytest with an in-process pytest call that had no
 * bound at all. It ran a single candidate for 3 hours 34 minutes, burning 12,522 seconds of CPU and
 * 1.8 GB of memory, and produced nothing. Node sat at 1.4 seconds of CPU waiting for an answer that
 * was never coming, so the run looked like a slow run rather than a stuck one.
 *
 * So the client lives in one file and both callers use it. Copying hardened infrastructure is what
 * caused the repeat; sharing it is the fix.
 *
 * A non-halting candidate is simply a failed candidate. On timeout the child is killed rather than
 * waited on -- a stuck pytest cannot be interrupted from the outside on Windows, and abandoning a
 * request would desynchronise the response queue, which pairs replies to requests by order. The next
 * request starts a fresh process from a known-good source file.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERIFIER = path.join(ROOT, 'scripts', 'lari_resident_verifier.py');

/**
 * Roughly 35x the ~850ms a candidate costs on wcwidth, in the same spirit as the cold path's 90
 * seconds against a five-second suite: generous enough that a merely slow candidate is not mistaken
 * for a stuck one, short enough that a stuck one costs less than a cold run would have.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Startup is a different bound from a request, and conflating them is its own bug.
 *
 * A child has to start python and import pytest and the test modules before it can answer anything --
 * seconds, not milliseconds, and the whole reason the process is resident. Bounding startup by the
 * per-request timeout made every first request time out, and because the abandoned ready-handler
 * stayed in the queue, the ready line then settled the *next* request's promise. Every subsequent
 * answer was one reply out of step, so a working candidate reported failure.
 */
const DEFAULT_STARTUP_TIMEOUT_MS = 120000;

/** Marker for a race lost to the clock, distinguishable from any real reply. */
const TIMED_OUT = Symbol('timed-out');

/**
 * How many consecutive oracle errors to tolerate before refusing to continue.
 *
 * One can be a transient; a run of them means the oracle is not executing at all, and every further
 * candidate would be recorded as rejected by a verifier that never ran. A run that cannot judge
 * should stop rather than produce a score.
 */
const ERROR_TOLERANCE = 5;

function afterMs(ms) {
  return new Promise(resolve => setTimeout(() => resolve(TIMED_OUT), ms));
}

function spawnChild(repo, targetRelative, testIds) {
  const child = spawn('python', [VERIFIER, repo, targetRelative, ...testIds],
    { encoding: 'utf8', windowsHide: true });
  const pending = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const settle = pending.shift();
      if (!settle) continue;
      try { settle(JSON.parse(line)); } catch (_) { settle({ passed: false }); }
    }
  });
  // stderr is piped by default and nothing reads it; an unread pipe that fills would block the child.
  child.stderr.on('data', () => {});
  child.on('error', () => {});
  return { child, pending };
}

/**
 * @param {object} options
 * @param {string} options.repo               repository root
 * @param {string} options.targetRelative     file under repair, repo-relative, forward slashes
 * @param {string[]} options.testIds          failing test ids, taken from the baseline run
 * @param {string} options.baselineSource     source to restore before starting or restarting a child
 * @param {number} [options.requestTimeoutMs]
 */
function createResidentVerifier({
  repo,
  targetRelative,
  testIds,
  baselineSource,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS
}) {
  const targetPath = path.join(repo, targetRelative);
  const stats = {
    requests: 0, timeouts: 0, restarts: 0, startupFailures: 0,
    errors: 0, consecutiveErrors: 0, firstError: null, totalMs: 0
  };
  let current = null;

  const ensure = async () => {
    if (current) return current;
    // A killed child leaves the offending candidate on disk, and the next child reads that file as the
    // source it will restore on shutdown. Put the known-good source back first.
    if (typeof baselineSource === 'string') fs.writeFileSync(targetPath, baselineSource);
    const started = spawnChild(repo, targetRelative, testIds);
    current = started;
    const ready = new Promise(resolve => started.pending.push(resolve));
    const result = await Promise.race([ready, afterMs(startupTimeoutMs)]);
    if (result === TIMED_OUT) {
      // Never continue with a queue that still holds an abandoned handler: the ready line would
      // settle the next request's promise and every answer after it would be one reply out of step.
      stats.startupFailures += 1;
      discard();
      return null;
    }
    return current;
  };

  const discard = () => {
    if (!current) return;
    const dying = current;
    current = null;
    // Settle anything still queued so no caller waits on a dead process.
    for (const settle of dying.pending.splice(0)) settle({ passed: false });
    try { dying.child.kill(); } catch (_) { /* already gone */ }
  };

  const verify = async source => {
    const active = await ensure();
    stats.requests += 1;
    if (!active) return { passed: false, timedOut: true };

    const response = await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; resolve(value); } };
      const timer = setTimeout(() => finish(TIMED_OUT), requestTimeoutMs);
      active.pending.push(value => { clearTimeout(timer); finish(value); });
      try {
        active.child.stdin.write(JSON.stringify({ source }) + '\n');
      } catch (_) {
        clearTimeout(timer);
        finish({ passed: false });
      }
    });

    if (response === TIMED_OUT) {
      stats.timeouts += 1;
      stats.restarts += 1;
      discard();
      return { passed: false, timedOut: true };
    }

    // An oracle that errored is not an oracle that rejected.
    //
    // The verifier answers {"passed": false, "error": "..."} when it could not run the tests at all.
    // Treating that as an ordinary rejection is how a UTF-8 encoding fault scored 0 of 87 defects on
    // one file while two curriculum runs looked healthy. A candidate cannot be judged by an oracle
    // that did not execute, so errors are counted separately and a run producing only errors stops.
    if (response?.error) {
      stats.errors += 1;
      stats.consecutiveErrors += 1;
      // Keep pytest's own words. "pytest exit 4" alone sent one debugging session hunting the caller
      // when the answer was in the output the verifier had already captured and the client discarded.
      if (!stats.firstError) {
        stats.firstError = [String(response.error), String(response.output || '').trim()]
          .filter(Boolean).join(' | ').slice(0, 800);
      }
      if (stats.consecutiveErrors >= ERROR_TOLERANCE) {
        throw new Error(
          `Resident verifier failed ${stats.consecutiveErrors} times in a row and judged nothing: `
          + `${stats.firstError}. Refusing to continue -- every candidate would be recorded as `
          + 'rejected by an oracle that never ran.');
      }
      return { passed: false, oracleError: String(response.error).slice(0, 300) };
    }
    stats.consecutiveErrors = 0;
    stats.totalMs += Number(response?.ms || 0);
    return { passed: response?.passed === true };
  };

  const stop = async () => {
    if (!current) return;
    const active = current;
    const shutdown = new Promise(resolve => active.pending.push(resolve));
    try { active.child.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n'); } catch (_) { /* dead already */ }
    await Promise.race([shutdown, afterMs(5000)]);
    discard();
  };

  return { verify, stop, stats };
}

module.exports = { createResidentVerifier, DEFAULT_REQUEST_TIMEOUT_MS };
