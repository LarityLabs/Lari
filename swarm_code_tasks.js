/**
 * swarm_code_tasks.js — Lari's local code gym on the MBPP-style problem set.
 *
 * Loads gym_data/mbpp_local.jsonl (function signature + hidden tests),
 * runs Lari's real code-task loop per problem:
 *   generateCandidates(model, task) -> runCodeSandbox -> hidden-test verify
 * and reports reward 1/0 per problem plus the pass rate.
 *
 * Sandboxing reuses teach.runCodeSandbox (temp dir, hard timeout, captured
 * stdio). Hidden tests are injected only into the verification harness —
 * generateCandidates sees the description only.
 *
 * CLI:
 *   node swarm_code_tasks.js [--file gym_data/mbpp_local.jsonl]
 *       [--max-candidates 6] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const teach = require('./swarm_code_self_teach.js');

const DEFAULT_FILE = path.join(__dirname, 'gym_data', 'mbpp_local.jsonl');

function loadProblems(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t));
  }
  return out;
}

/**
 * Verification harness: candidate source defines `solve`; we append a
 * driver that calls solve on the hidden tests and prints one result line.
 * Floats compare with tolerance; everything else with ==.
 */
function buildHarness(problem) {
  const testsJson = pyLiteral(problem.tests);
  return (
    '\n# ---- LARI HIDDEN-TEST HARNESS ----\n' +
    'import json as _json\n' +
    '_LARI_TESTS = ' + testsJson + '\n' +
    '_lari_results = []\n' +
    'for _t in _LARI_TESTS:\n' +
    '    try:\n' +
    '        _got = solve(*_t["args"])\n' +
    '        _exp = _t["expected"]\n' +
    '        if isinstance(_got, float) or isinstance(_exp, float):\n' +
    '            _ok = abs(float(_got) - float(_exp)) < 1e-9\n' +
    '        else:\n' +
    '            _ok = _got == _exp\n' +
    '        _lari_results.append(bool(_ok))\n' +
    '    except Exception as _e:\n' +
    '        _lari_results.append(False)\n' +
    'print("LARI_TESTS:" + _json.dumps(_lari_results))\n'
  );
}

/** JSON value -> Python literal (JSON true/false/null are not valid Python). */
function pyLiteral(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v); // JSON strings are valid Python
  if (Array.isArray(v)) return '[' + v.map(pyLiteral).join(', ') + ']';
  return '{' + Object.keys(v).map((k) => JSON.stringify(k) + ': ' + pyLiteral(v[k])).join(', ') + '}';
}

function parseHarness(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('LARI_TESTS:')) {
      try {
        return JSON.parse(line.slice('LARI_TESTS:'.length));
      } catch (_) { return null; }
    }
  }
  return null;
}

function runCodeGymProblem(model, problem, opts = {}) {
  const maxCandidates = opts.maxCandidates || 6;
  const task = {
    id: problem.id,
    language: problem.language || 'python',
    description: problem.description,
    verify: { type: 'function', function: problem.function, tests: problem.tests }
  };
  const candidates = teach.generateCandidates(model, task).slice(0, maxCandidates);
  const attempts = [];
  let passed = false;
  for (const cand of candidates) {
    const code = String(cand.code || '') + buildHarness(problem);
    const run = teach.runCodeSandbox(task.language, code, { timeoutMs: 10000 });
    let testResults = null;
    let ok = false;
    if (run.ok && !run.timedOut) {
      testResults = parseHarness(run.stdout);
      ok = Array.isArray(testResults) && testResults.length > 0 && testResults.every(Boolean);
    }
    attempts.push({
      source: cand.source,
      passed: ok,
      tests: testResults,
      reason: run.timedOut ? 'timeout' : (!run.ok ? 'runtime_error' : (testResults ? 'test_fail' : 'no_harness_output')),
      detail: !run.ok ? String(run.stderr || '').slice(0, 200) : undefined
    });
    if (ok) { passed = true; break; }
  }
  return {
    ok: true,
    taskId: problem.id,
    reward: passed ? 1 : 0,
    candidates: candidates.length,
    attempts
  };
}

function runCodeGym(model, problems, opts = {}) {
  const results = problems.map((p) => runCodeGymProblem(model, p, opts));
  const passed = results.filter((r) => r.reward === 1).length;
  return {
    ok: true,
    problems: problems.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    results
  };
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
  };
  const file = get('--file', DEFAULT_FILE);
  const problems = loadProblems(file);
  const model = {};
  const summary = runCodeGym(model, problems, {
    maxCandidates: parseInt(get('--max-candidates', '6'), 10)
  });
  if (args.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`code gym: ${summary.passed}/${summary.problems} passed (${(summary.passRate * 100).toFixed(1)}%)`);
  for (const r of summary.results) {
    const mark = r.reward ? 'PASS' : 'FAIL';
    const src = r.attempts.find((a) => a.passed);
    console.log(`  ${mark} ${r.taskId} (candidates=${r.candidates}${src ? `, via ${src.source}` : ''})`);
  }
}

if (require.main === module) main();

module.exports = { loadProblems, runCodeGymProblem, runCodeGym, buildHarness };
