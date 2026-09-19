'use strict';

/**
 * Spectrum localization: which lines of the file under repair the failing tests actually execute.
 *
 * This is the strongest fault signal the engine has. Import-based scoping infers where a defect might
 * be from what a test imports; coverage observes what it ran. The difference decides whether a search
 * looks at the defect at all -- and a candidate that is never generated cannot be ranked, budgeted or
 * verified, so localization failures look exactly like capability failures.
 *
 * The measurement path has run coverage since the beginning. The growth curriculum never did, and it
 * cost a run: practising `original + [default] * (num_desired - len(original))` at line 2491 of
 * tabulate/__init__.py, localization produced regions covering 1123-1129, 157-170, 1150-1175, 815-834
 * and 1696-2464. The defect was in none of them, so no rule for its operators was even proposed, and
 * nine such defects in one 40-defect run were recorded as growth failures. Same lesson as the
 * duplicated timeout and the duplicated verifier client: hardened infrastructure has to be shared, not
 * reimplemented in the place that happens to need it next.
 *
 * Selecting the tests to trace is harder than it looks. Exact pytest node ids cannot always be passed
 * back -- a parameterised id such as
 *     test_wrap_sequences_no_propagate[x\x1b[31mabcdefghij\x1b[0m-3-expected1]
 * carries escapes and brackets that do not survive a shell, so pytest matches nothing, reports "no
 * tests ran", and coverage records only import-time lines. So: exact ids, then ids with the parameter
 * stripped, then the whole failing test files. Broader selection traces a few extra lines; selecting
 * nothing traces almost none.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 300000;

/**
 * @param {object} options
 * @param {string} options.repo            repository root
 * @param {string} options.targetRelative  file under repair, repo-relative
 * @param {string} options.failureText     output of the failing baseline run
 * @param {string[]} options.failingFiles  test files that failed, for the last-resort selector
 * @param {number} [options.timeoutMs]
 * @returns {{ coveredLines: number[], selector: string }}
 */
function coveredLinesForFailure({ repo, targetRelative, failureText, failingFiles = [], timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const include = String(targetRelative).split(path.sep).join('/');
  const text = String(failureText || '');

  const exactIds = [...text.matchAll(/^FAILED\s+(\S+)/gm)].map(match => match[1]).slice(0, 8);
  const strippedIds = [...new Set(exactIds.map(id => id.replace(/\[.*$/, '')))];
  // A collection error names a file and no test at all; it is still the sharpest target available.
  const erroredFiles = [...text.matchAll(/^ERROR\s+(\S+)/gm)].map(match => match[1].replace(/\[.*$/, ''));

  const attempts = [
    { selector: 'exact-node-ids', args: exactIds },
    { selector: 'parameter-stripped-ids', args: strippedIds },
    { selector: 'failing-test-files', args: failingFiles },
    { selector: 'collection-error-files', args: erroredFiles }
  ].filter(attempt => attempt.args.length);

  for (const attempt of attempts) {
    const quoted = attempt.args.map(arg => JSON.stringify(arg)).join(' ');
    const run = spawnSync(
      `python -m coverage run --include="${include}" -m pytest -q -o addopts= ${quoted}`,
      { cwd: repo, shell: true, encoding: 'utf8', timeout: timeoutMs });
    // pytest exit 4 is a usage error / nothing collected; "no tests ran" says the same thing.
    if (run.status === 4 || /no tests ran/i.test(String(run.stdout || ''))) continue;

    const json = spawnSync(`python -m coverage json -o - --include="${include}"`,
      { cwd: repo, shell: true, encoding: 'utf8', timeout: timeoutMs });
    let executed = [];
    try {
      const data = JSON.parse(json.stdout);
      const key = Object.keys(data.files || {})[0];
      executed = key ? (data.files[key].executed_lines || []) : [];
    } catch (_) {
      executed = [];
    }
    if (executed.length) return { coveredLines: executed, selector: attempt.selector };
  }

  // Failure here is non-fatal by design: the search falls back to the weaker heuristics rather than
  // stopping. A run with no coverage is worse localized, not wrong.
  return { coveredLines: [], selector: 'none' };
}

module.exports = { coveredLinesForFailure };
