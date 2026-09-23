/**
 * swarm_math_tasks.js — Lari's local math gym.
 *
 * Loads gym_data/math_local.jsonl (question + exact checkable answer) and
 * runs a deterministic program-synthesis math loop per problem:
 *   template-match the question -> generate a Python computation program
 *   -> runCodeSandbox -> compare the printed number to the expected answer.
 *
 * No model calls anywhere: the "learning" here is the template set, and
 * the verifier is exact numeric comparison (tolerance 1e-6). Problems the
 * templates cannot cover fail honestly — that is the measured boundary.
 *
 * CLI:
 *   node swarm_math_tasks.js [--file gym_data/math_local.jsonl] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const teach = require('./swarm_code_self_teach.js');

const DEFAULT_FILE = path.join(__dirname, 'gym_data', 'math_local.jsonl');

function loadProblems(file) {
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Deterministic solver templates: question text -> python program printing
// the answer. Each returns { code, source } or null.
// ---------------------------------------------------------------------------

const TEMPLATES = [
  {
    id: 'power-word',
    match: /What is (\d+) to the power of (\d+)\?/i,
    code: (m) => `print(${m[1]} ** ${m[2]})`
  },
  {
    id: 'percent-of',
    match: /What is ([\d.]+) percent of ([\d.]+)\?/i,
    code: (m) => `print(${m[1]} / 100 * ${m[2]})`
  },
  {
    id: 'sqrt',
    match: /square root of ([\d.]+)/i,
    code: (m, q) => {
      const dp = (q.match(/rounded to (\d+) decimal/i) || [])[1];
      const expr = `(${m[1]} ** 0.5)`;
      return dp ? `print(round(${expr}, ${dp}))` : `print(${expr})`;
    }
  },
  {
    id: 'linear',
    match: /Solve for x:\s*(\d+)x\s*(?:([+-])\s*([\d.]+))?\s*=\s*([\d.]+)/i,
    code: (m) => {
      const a = m[1], b = m[3] || '0', c = m[4];
      return (m[2] || '+') === '+' ? `print((${c} - ${b}) / ${a})` : `print((${c} + ${b}) / ${a})`;
    }
  },
  {
    id: 'gcd',
    match: /greatest common divisor of (\d+) and (\d+)/i,
    code: (m) => `import math\nprint(math.gcd(${m[1]}, ${m[2]}))`
  },
  {
    id: 'lcm',
    match: /least common multiple of (\d+) and (\d+)/i,
    code: (m) => `import math\nprint(math.lcm(${m[1]}, ${m[2]}))`
  },
  {
    id: 'mean',
    match: /mean of the numbers ([\d., ]+)/i,
    code: (m) => {
      const nums = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      return `print(sum([${nums.join(', ')}]) / ${nums.length})`;
    }
  },
  {
    id: 'factorial',
    match: /factorial of (\d+)/i,
    code: (m) => `import math\nprint(math.factorial(${m[1]}))`
  },
  {
    id: 'decimal-div',
    match: /What is (\d+) divided by (\d+) as a decimal\?/i,
    code: (m) => `print(${m[1]} / ${m[2]})`
  },
  {
    id: 'hypotenuse',
    match: /legs (\d+) and (\d+).*hypotenuse/i,
    code: (m) => `import math\nprint(math.hypot(${m[1]}, ${m[2]}))`
  },
  {
    id: 'sum-primes',
    match: /sum of the first (\d+) prime numbers/i,
    code: (m) => (
      'def primes(nth):\n' +
      '    out = []\n' +
      '    x = 2\n' +
      '    while len(out) < nth:\n' +
      '        if all(x % p for p in out):\n' +
      '            out.append(x)\n' +
      '        x += 1\n' +
      `    return out\nprint(sum(primes(${m[1]})))`
    )
  },
  {
    id: 'system-2x2',
    match: /x \+ y = ([\d.]+) and x - y = ([\d.]+)/i,
    code: (m) => `print((${m[1]} + ${m[2]}) / 2)`
  },
  {
    id: 'quadratic',
    match: /x squared (minus|plus) (\d+)x (plus|minus) (\d+)/i,
    code: (m) => {
      const b = (m[1] === 'minus' ? '-' : '') + m[2];
      const c = (m[3] === 'minus' ? '-' : '') + m[4];
      return `import math\nb = ${b}\nc = ${c}\nd = b*b - 4*c\nprint((-b + math.sqrt(d)) / 2 if d >= 0 else float("nan"))`;
    }
  },
  {
    id: 'arithmetic',
    // Last resort: plain arithmetic between "What is" and "?", no words.
    match: /What is ([\d\s+\-*/().]+)\?/,
    code: (m) => {
      const expr = m[1].trim();
      if (!expr || !/^[\d\s+\-*/().]+$/.test(expr)) return null;
      return `print(${expr})`;
    }
  }
];

function generateMathCandidates(problem) {
  const q = problem.question || '';
  for (const t of TEMPLATES) {
    const m = q.match(t.match);
    if (!m) continue;
    try {
      const code = t.code(m, q);
      if (code) return [{ code, source: 'math-template:' + t.id }];
    } catch (_) { /* fall through */ }
  }
  return [];
}

function answersMatch(got, expected) {
  const g = parseFloat(got), e = parseFloat(expected);
  if (!isFinite(g) || !isFinite(e)) return false;
  if (Number.isInteger(e) && Number.isInteger(g)) return g === e;
  return Math.abs(g - e) <= 1e-6 * Math.max(1, Math.abs(e));
}

function runMathProblem(model, problem, opts = {}) {
  const candidates = generateMathCandidates(problem).slice(0, opts.maxCandidates || 3);
  const attempts = [];
  let passed = false;
  for (const cand of candidates) {
    const run = teach.runCodeSandbox('python', cand.code, { timeoutMs: 10000 });
    const printed = String(run.stdout || '').trim().split('\n').pop();
    const ok = run.ok && !run.timedOut && answersMatch(printed, problem.answer);
    attempts.push({
      source: cand.source,
      passed: ok,
      printed,
      expected: problem.answer,
      reason: run.timedOut ? 'timeout' : (!run.ok ? 'runtime_error' : (ok ? 'answer_match' : 'answer_mismatch'))
    });
    if (ok) { passed = true; break; }
  }
  return {
    ok: true,
    problemId: problem.id,
    reward: passed ? 1 : 0,
    candidates: candidates.length,
    attempts
  };
}

function runMathGym(model, problems, opts = {}) {
  const results = problems.map((p) => runMathProblem(model, p, opts));
  const passed = results.filter((r) => r.reward === 1).length;
  return {
    ok: true,
    problems: problems.length,
    passed,
    score: results.length ? passed / results.length : 0,
    results
  };
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
  };
  const problems = loadProblems(get('--file', DEFAULT_FILE));
  const summary = runMathGym({}, problems);
  if (args.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`math gym: ${summary.passed}/${summary.problems} correct (${(summary.score * 100).toFixed(1)}%)`);
  for (const r of summary.results) {
    const mark = r.reward ? 'PASS' : 'FAIL';
    const src = r.attempts.find((a) => a.passed);
    const miss = r.reward ? '' : (r.candidates === 0 ? ' (no template)' : ` (got ${r.attempts[0] && r.attempts[0].printed}, want ${r.attempts[0] && r.attempts[0].expected})`);
    console.log(`  ${mark} ${r.problemId}${src ? ` via ${src.source}` : ''}${miss}`);
  }
}

if (require.main === module) main();

module.exports = { loadProblems, generateMathCandidates, runMathProblem, runMathGym };
