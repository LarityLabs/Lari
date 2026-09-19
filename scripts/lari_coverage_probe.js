#!/usr/bin/env node
'use strict';

/**
 * Which lines of a file the failing tests actually execute.
 *
 * Extracted from the measurement script rather than copied into it, because it is now needed twice
 * and this repository has already paid for duplicating hardened infrastructure once -- the
 * runaway-timeout fix had to be applied in two files because the runner had been copied instead of
 * shared.
 *
 * The two uses are different questions asked with the same instrument:
 *
 *   before the patch -- which lines are suspicious? (spectrum localization)
 *   after the patch  -- is the defect line still executed?
 *
 * The second is the one that matters for honesty. A patch can in principle satisfy the suite by
 * making the defective code unreachable rather than by correcting it, and nothing in a test result
 * distinguishes that from a fix. Coverage does: if the defect line is no longer executed by the tests
 * that used to fail on it, the patch disabled the code rather than repairing it.
 *
 * It also reaches a case the after-the-fact classifier structurally cannot.
 * `lari_repair_classification.js` can only flag branch-disabling when the seeded operator class is
 * out of range; a guard flip neutralising an *in-range* defect is indistinguishable from a legitimate
 * equivalent variant by any reasoning available after the fact.
 *
 * What this does NOT do, stated plainly because it was built on the opposite belief
 * ---------------------------------------------------------------------------------
 * It does not catch `wcwidth-sdl-wcwidth_wcswidth_py-l306`, the case that motivated it. That was
 * described earlier the same day as a patch that "made the block containing the defect unreachable".
 * Measured, that is false. Line 306 executes identically under all four conditions -- pristine
 * upstream, the mutant, the mutant plus the guard flip, and pristine plus the guard flip. The block
 * is entered in every case; flipping `last_measured_idx >= 0` to `< 0` changes which iterations enter
 * it, not whether it is entered.
 *
 * What remains true about that instance is weaker and was the only part actually established:
 * applying the guard flip alone to pristine upstream leaves the suite green, so no test discriminates
 * the guard's direction, and the patch does not restore the deleted statement. It satisfies the
 * oracle without repairing the defect -- but by exploiting an undiscriminated condition, not by
 * disabling code. The out-of-range rule in the classifier still flags it correctly, for the right
 * reason.
 *
 * So this probe is infrastructure for a failure mode that is real in principle and has not yet been
 * observed here. It is cheap -- one coverage run per accepted repair, not per candidate -- and it can
 * fire, which is verified synthetically in the test. It has never fired on real data, and that should
 * be said whenever its output is quoted.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Choose which tests to trace.
 *
 * Harder than it looks, and the reason is recorded because it produced two false misses once. Exact
 * pytest node ids cannot always be passed back: wcwidth parameterises tests with values like
 * `x\x1b[31mabcdefghij\x1b[0m-3-expected1`, whose escapes and brackets do not survive the shell, so
 * pytest matches nothing, reports "no tests ran", and coverage records only import-time lines.
 *
 * So the selectors are tried in order of precision and the first that traces anything wins. Broader
 * selection traces a few extra lines; selecting nothing traces almost none.
 */
function buildSelectors(baselineText, mutationRepair, limit = 8) {
  const exactIds = [...String(baselineText).matchAll(/^FAILED\s+(\S+)/gm)].map(match => match[1]).slice(0, limit);
  const baseIds = mutationRepair.failingTestTargets(baselineText, limit);
  const files = mutationRepair.failingTestReferences(baselineText).files;
  return [
    { selector: 'exact-node-ids', args: exactIds },
    { selector: 'parameter-stripped-ids', args: baseIds },
    { selector: 'failing-test-files', args: files }
  ].filter(attempt => attempt.args.length);
}

/**
 * Executed lines of `targetFile` under the given test selection.
 *
 * Returns `{ lines, selector }`. An empty result means coverage could not be obtained, which is not
 * the same as "nothing was executed" -- callers must not read emptiness as evidence.
 */
function coveredLines({ repo, targetFile, baselineText, mutationRepair, timeoutMs = 300000, forcedSelector = null }) {
  const include = String(targetFile).split(path.sep).join('/');
  let attempts = buildSelectors(baselineText, mutationRepair);
  if (forcedSelector) {
    const chosen = attempts.find(attempt => attempt.selector === forcedSelector);
    attempts = chosen ? [chosen] : attempts;
  }

  for (const attempt of attempts) {
    const run = spawnSync(
      `python -m coverage run --include="${include}" -m pytest -q -o addopts= `
      + attempt.args.map(arg => JSON.stringify(arg)).join(' '),
      { cwd: repo, shell: true, encoding: 'utf8', timeout: timeoutMs }
    );
    // Exit 4 is a pytest usage error; "no tests ran" says the same thing in prose. Either means the
    // selector failed to match, not that the code is dead.
    if (run.status === 4 || /no tests ran/i.test(String(run.stdout || ''))) continue;

    try {
      const json = spawnSync(`python -m coverage json -o - --include="${include}"`,
        { cwd: repo, shell: true, encoding: 'utf8', timeout: timeoutMs });
      const data = JSON.parse(json.stdout);
      const key = Object.keys(data.files || {})[0];
      const executed = key ? (data.files[key].executed_lines || []) : [];
      if (executed.length) return { lines: executed, selector: attempt.selector };
    } catch (_) { /* fall through to the next selector */ }
  }
  return { lines: [], selector: 'none' };
}

/**
 * Is the defect line still executed once the patch is applied?
 *
 * Writes the patched source, measures, and restores the file it found. The caller owns the working
 * tree and this must not be the thing that leaves it dirty.
 *
 * Returns:
 *   true   the defect line still runs -- the patch changed behaviour where the defect was
 *   false  the defect line no longer runs -- the patch disabled the code containing it
 *   null   coverage unavailable, or the patch shifted line numbers so the question is not well posed
 *
 * `null` is deliberately distinct from `false`. An instrument that cannot answer must never look
 * like an instrument answering "no" -- this repository has twice had a verifier that errored be read
 * as a verifier that rejected, and both times it cost real results.
 */
function defectLineStillExecuted({
  repo, targetFile, defectLine, patchedSource, baselineText, mutationRepair, selector = null, timeoutMs = 300000
}) {
  const absolute = path.join(repo, targetFile);
  let original;
  try { original = fs.readFileSync(absolute, 'utf8'); } catch (_) { return null; }

  // Substitution families preserve line count. If a patch has not, the recorded defect line no
  // longer denotes the same statement and the comparison would be meaningless.
  const originalLineCount = original.split(/\r?\n/).length;
  const patchedLineCount = String(patchedSource).split('\n').length;
  if (originalLineCount !== patchedLineCount) return null;

  try {
    fs.writeFileSync(absolute, patchedSource, 'utf8');
    const result = coveredLines({
      repo, targetFile, baselineText, mutationRepair, timeoutMs, forcedSelector: selector
    });
    if (!result.lines.length) return null;
    return result.lines.includes(defectLine);
  } catch (_) {
    return null;
  } finally {
    try { fs.writeFileSync(absolute, original, 'utf8'); } catch (_) { /* caller restores from git */ }
  }
}

module.exports = { buildSelectors, coveredLines, defectLineStillExecuted };
