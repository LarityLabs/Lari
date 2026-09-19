#!/usr/bin/env node
'use strict';

/**
 * Lari agentic coding: the five capabilities that make a coder.
 *
 * 1. DEBUG — take broken code + its error, fix it, verify the fix.
 * 2. MULTI-FILE — tasks spanning modules and imports, not single scripts.
 * 3. COMPOSE — combine retained solutions into bigger programs.
 * 4. SELF-CURRICULUM — invent harder practice tasks from mastered ones.
 * 5. RESEARCH WHEN STUCK — hit an unknown concept, research it, retry.
 *
 * Built on swarm_code_self_teach.js (sandbox, verification, retention) and
 * swarm_mutation_repair.js (verified mutation for logic errors).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const teach = require('./swarm_code_self_teach.js');

let mutationRepair = null;
try { mutationRepair = require('./swarm_mutation_repair.js'); } catch (_) {}

// ---------------------------------------------------------------------------
// Multi-file sandbox: write all files, run the entry point.
// ---------------------------------------------------------------------------

const LANGUAGE_RUNNERS = {
  python: { command: 'python3', ext: '.py' },
  javascript: { command: 'node', ext: '.js' }
};

function runSandboxKeepDir(language, files, entryPoint, options = {}) {
  const runner = LANGUAGE_RUNNERS[language];
  if (!runner) return { run: { ok: false, stdout: '', stderr: `unsupported language: ${language}`, exitCode: -1, timedOut: false }, dir: null, cleanup: () => {} };
  const timeoutMs = options.timeoutMs || 10000;
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-multifile-'));
    for (const [name, code] of Object.entries(files || {})) {
      const safe = String(name).replace(/[^A-Za-z0-9_.\-]/g, '_');
      fs.writeFileSync(path.join(dir, safe), String(code || ''));
    }
    const entry = String(entryPoint || Object.keys(files || {})[0] || `main${runner.ext}`)
      .replace(/[^A-Za-z0-9_.\-]/g, '_');
    const run = spawnSync(runner.command, [path.join(dir, entry)], {
      cwd: dir, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const timedOut = run.error && (run.error.code === 'ETIMEDOUT' || /timed out/i.test(run.error.message || ''));
    return {
      run: {
        ok: !timedOut && run.status === 0,
        stdout: String(run.stdout || ''),
        stderr: String(run.stderr || ''),
        exitCode: run.status,
        timedOut: !!timedOut
      },
      dir,
      cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
    };
  } catch (error) {
    const cleanup = () => { if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
    return { run: { ok: false, stdout: '', stderr: String((error && error.message) || error), exitCode: -1, timedOut: false }, dir, cleanup };
  }
}

function runMultiFileSandbox(language, files, entryPoint, options = {}) {
  const { run, cleanup } = runSandboxKeepDir(language, files, entryPoint, options);
  try { return run; } finally { cleanup(); }
}

// ---------------------------------------------------------------------------
// 1. DEBUG — fix broken code, verify the fix.
// ---------------------------------------------------------------------------

/**
 * Classify a runtime error from stderr.
 */
function classifyError(stderr, language) {
  const text = String(stderr || '');
  if (/SyntaxError|invalid syntax/i.test(text)) return 'syntax';
  if (/IndentationError|unexpected indent/i.test(text)) return 'indentation';
  if (/ImportError|cannot import name|No module named/i.test(text)) {
    const m = text.match(/cannot import name '([^']+)'/) || text.match(/No module named '([^']+)'/);
    return { type: 'import', symbol: m ? m[1] : null };
  }
  if (/NameError|is not defined/.test(text)) {
    const m = text.match(/name '([^']+)' is not defined|NameError: name '([^']+)'/i)
      || text.match(/([^ ]+) is not defined/);
    return { type: 'name', symbol: m ? (m[1] || m[2]) : null };
  }
  if (/TypeError/.test(text)) return 'type';
  if (/IndexError|out of range/i.test(text)) return 'index';
  if (/KeyError/.test(text)) return 'key';
  if (/ZeroDivisionError|division by zero/i.test(text)) return 'zero_division';
  if (/AssertionError|assert/i.test(text)) return 'assertion';
  return 'unknown';
}

/**
 * Tiny edit distance for cross-file typo repair.
 */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Cross-file repairs: when an import fails, look for similarly-named
 * definitions in the other files and propose renames.
 */
function proposeCrossFileRepairs(files, errorInfo) {
  const candidates = [];
  if (!errorInfo || errorInfo.type !== 'import' || !errorInfo.symbol) return candidates;
  const missing = errorInfo.symbol;
  for (const [fname, fcode] of Object.entries(files || {})) {
    const code = String(fcode);
    const defs = [...code.matchAll(/def\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
    for (const d of defs) {
      if (d !== missing && editDistance(d, missing) <= 2) {
        const fixed = code.replace(new RegExp(`\\b${d}\\b`, 'g'), missing);
        candidates.push({ file: fname, code: fixed, strategy: `rename_${d}_to_${missing}_in_${fname}` });
      }
    }
  }
  return candidates;
}

/**
 * Pattern-based repairs for common error classes. Each returns candidate
 * fixed code (or null if the pattern does not apply).
 */
function proposePatternRepairs(code, errorInfo, language) {
  const candidates = [];
  const lines = String(code).split('\n');

  if (errorInfo === 'syntax' || errorInfo === 'indentation') {
    // Missing colon after if/for/while/def/class/with.
    const fixed = lines.map(line => {
      if (/^\s*(if|for|while|def|class|with|elif|else|try|except|finally)\b.*[^\s:]$/.test(line)
        && !line.trim().endsWith(':')
        && !/^\s*#/.test(line)) {
        return line + ':';
      }
      return line;
    });
    const joined = fixed.join('\n');
    if (joined !== code) candidates.push({ code: joined, strategy: 'add_missing_colon' });
  }

  if (errorInfo && errorInfo.type === 'name' && errorInfo.symbol) {
    const sym = errorInfo.symbol;
    // Common typos: print->print, True/False casing, etc.
    const corrections = { 'Print': 'print', 'printl': 'print', 'Truee': 'True', 'Falsee': 'False', 'Nonee': 'None' };
    if (corrections[sym]) {
      const re = new RegExp(`\\b${sym}\\b`, 'g');
      candidates.push({ code: code.replace(re, corrections[sym]), strategy: `fix_typo_${sym}` });
    }
    // Undefined variable used once: maybe meant a builtin or string literal.
    if (language === 'python' && /^[a-z_]+$/.test(sym)) {
      // Try quoting it (common beginner error: forgetting quotes).
      const re = new RegExp(`\\b${sym}\\b`, 'g');
      candidates.push({ code: code.replace(re, `"${sym}"`), strategy: `quote_${sym}` });
    }
  }

  if (errorInfo === 'zero_division') {
    // Guard division: wrap in a check. Simple heuristic — replace `/ 0` patterns.
    const fixed = code.replace(/\/\s*0(?!\d)/g, '/ 1');
    if (fixed !== code) candidates.push({ code: fixed, strategy: 'avoid_divide_by_zero' });
  }

  if (errorInfo === 'index') {
    // Off-by-one: range(n) used with [n] access. Try range(n+1) -> range(n) adjustments is risky;
    // safer: clamp index access with min().
    // This is heuristic; verification decides.
  }

  // Off-by-one range mutations: range(a, b) -> range(b), range(0, b), range(a-1, b), range(a, b+1).
  // The generic mutation families only change one constant at a time, so they
  // cannot remove an argument. These cover the classic fencepost fixes.
  const rangeRe = /range\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;
  let m;
  const seen = new Set([code]);
  while ((m = rangeRe.exec(code)) !== null) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    const variants = [
      { src: m[0], dst: `range(${b})`, strategy: 'range_drop_start' },
      { src: m[0], dst: `range(0, ${b})`, strategy: 'range_zero_start' },
      { src: m[0], dst: `range(${a - 1}, ${b})`, strategy: 'range_decrement_start' },
      { src: m[0], dst: `range(${a}, ${b + 1})`, strategy: 'range_increment_stop' }
    ];
    for (const v of variants) {
      const fixed = code.replace(v.src, v.dst);
      if (!seen.has(fixed)) {
        seen.add(fixed);
        candidates.push({ code: fixed, strategy: v.strategy });
      }
    }
  }

  return candidates;
}

/**
 * Debug broken code: run it, classify the error, repair, verify.
 * Returns { fixed, code, strategy, attempts, verification }.
 */
function debugBrokenCode(task, options = {}) {
  const maxAttempts = options.maxAttempts || 5;
  const language = task.language || 'python';
  const files = task.files || { [`main.${language === 'python' ? 'py' : 'js'}`]: task.code };
  const entryPoint = task.entryPoint || Object.keys(files)[0];
  const expected = task.expectedOutput;

  const result = { fixed: false, code: null, strategy: null, attempts: [], verification: null };
  let currentFiles = { ...files };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const run = runMultiFileSandbox(language, currentFiles, entryPoint, options);
    const output = (run.stdout || '').replace(/\r\n/g, '\n').trim().replace(/\n+$/, '');
    const expNorm = String(expected || '').replace(/\r\n/g, '\n').trim().replace(/\n+$/, '');

    if (run.ok && output === expNorm) {
      result.fixed = true;
      result.code = currentFiles;
      result.verification = { passed: true, reason: 'output_match' };
      return result;
    }

    const errorInfo = run.ok ? 'wrong_output' : classifyError(run.stderr, language);
    const attemptRecord = { attempt: attempt + 1, error: errorInfo, stderr: (run.stderr || '').slice(0, 200) };

    // Generate repair candidates across all project files.
    const mainFile = entryPoint;
    let candidates = [];
    for (const [fname, fcode] of Object.entries(currentFiles)) {
      for (const c of proposePatternRepairs(fcode, errorInfo, language)) {
        candidates.push({ file: fname, code: c.code, strategy: c.strategy });
      }
    }
    // Cross-file repairs (e.g. fix the definition a broken import names).
    for (const c of proposeCrossFileRepairs(currentFiles, errorInfo)) {
      candidates.push(c);
    }

    // For wrong output or logic errors, try verified mutation repair on each file.
    if ((errorInfo === 'wrong_output' || errorInfo === 'assertion') && mutationRepair) {
      for (const [fname, fcode] of Object.entries(currentFiles)) {
        try {
          const mutated = mutationRepair.repairByVerifiedMutation({
            source: fcode,
            language,
            limit: 40,
            verify: (candidateCode) => {
              const testFiles = { ...currentFiles, [fname]: candidateCode };
              const r = runMultiFileSandbox(language, testFiles, entryPoint, { timeoutMs: 5000 });
              const out = (r.stdout || '').replace(/\r\n/g, '\n').trim().replace(/\n+$/, '');
              return { passed: r.ok && out === expNorm };
            }
          });
          if (mutated && mutated.repaired && mutated.source) {
            candidates.push({ file: fname, code: mutated.source, strategy: 'verified_mutation' });
          }
        } catch (_) {}
      }
    }

    if (!candidates.length) {
      attemptRecord.noCandidates = true;
      result.attempts.push(attemptRecord);
      result.verification = { passed: false, reason: run.ok ? 'wrong_output_no_repair' : 'unrepairable_error', detail: (run.stderr || '').slice(0, 200) };
      return result;
    }

    // Try each candidate; keep the first that improves (runs, or output closer).
    let improved = false;
    for (const cand of candidates) {
      const testFiles = { ...currentFiles, [cand.file || mainFile]: cand.code };
      const r = runMultiFileSandbox(language, testFiles, entryPoint, { timeoutMs: 5000 });
      const out = (r.stdout || '').replace(/\r\n/g, '\n').trim().replace(/\n+$/, '');
      if (r.ok && out === expNorm) {
        result.fixed = true;
        result.code = testFiles;
        result.strategy = cand.strategy;
        result.verification = { passed: true, reason: 'output_match' };
        attemptRecord.strategy = cand.strategy;
        result.attempts.push(attemptRecord);
        return result;
      }
      // Improvement = previously crashed, now runs (even with wrong output).
      if (!run.ok && r.ok) {
        currentFiles = testFiles;
        attemptRecord.strategy = cand.strategy;
        attemptRecord.progress = 'now_runs';
        improved = true;
        break;
      }
    }
    result.attempts.push(attemptRecord);
    if (!improved) {
      result.verification = { passed: false, reason: 'no_improvement', detail: (run.stderr || '').slice(0, 200) };
      return result;
    }
  }
  result.verification = { passed: false, reason: 'attempts_exhausted' };
  return result;
}

// ---------------------------------------------------------------------------
// 2. MULTI-FILE — practice tasks spanning modules.
// ---------------------------------------------------------------------------

const MULTIFILE_TASK_SEEDS = [
  {
    id: 'py-multifile-import',
    language: 'python',
    description: 'two files: math_helpers.py with an add function, main.py imports it and prints add(3, 4)',
    tags: ['modules', 'import'],
    difficulty: 2,
    files: {
      'math_helpers.py': 'def add(a, b):\n    return a + b\n',
      'main.py': 'from math_helpers import add\nprint(add(3, 4))\n'
    },
    entryPoint: 'main.py',
    verify: { type: 'stdout', expected: '7' }
  },
  {
    id: 'py-multifile-class',
    language: 'python',
    description: 'two files: counter.py with a Counter class, main.py uses it to count to 3',
    tags: ['modules', 'class'],
    difficulty: 2,
    files: {
      'counter.py': 'class Counter:\n    def __init__(self):\n        self.n = 0\n    def tick(self):\n        self.n += 1\n        return self.n\n',
      'main.py': 'from counter import Counter\nc = Counter()\nfor _ in range(3):\n    print(c.tick())\n'
    },
    entryPoint: 'main.py',
    verify: { type: 'stdout', expected: '1\n2\n3' }
  },
  {
    id: 'js-multifile-require',
    language: 'javascript',
    description: 'two files: helpers.js exports double, main.js requires it and prints double(21)',
    tags: ['modules', 'import'],
    difficulty: 2,
    files: {
      'helpers.js': 'function double(n) { return n * 2; }\nmodule.exports = { double };\n',
      'main.js': 'const { double } = require("./helpers.js");\nconsole.log(double(21));\n'
    },
    entryPoint: 'main.js',
    verify: { type: 'stdout', expected: '42' }
  }
];

function runMultiFileTask(model, task, options = {}) {
  const run = runMultiFileSandbox(task.language, task.files, task.entryPoint, options);
  const verification = teach.verifyAttempt(
    { verify: task.verify },
    run
  );
  const result = {
    taskId: task.id,
    passed: verification.passed,
    verification,
    attempts: [{ runOk: run.ok, verification }]
  };
  if (verification.passed && model) {
    teach.ensureCodeGeneration(model);
    const cg = model.lariCodeGeneration;
    if (!cg.solutions.some(s => s.taskId === task.id)) {
      cg.solutions.push({
        taskId: task.id,
        language: task.language,
        description: task.description,
        tags: task.tags || [],
        code: task.files,
        multiFile: true,
        entryPoint: task.entryPoint,
        verifiedAt: new Date().toISOString()
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 3. COMPOSE — combine retained solutions into bigger programs.
// ---------------------------------------------------------------------------

/**
 * Compose two retained solutions into a new task. The composed program runs
 * the first solution's logic, then applies the second to the result.
 * Currently supports python stdout-style solutions.
 */
function composeSolutions(model, taskIdA, taskIdB, options = {}) {
  const solutions = teach.getRetainedSolutions(model);
  const a = solutions.find(s => s.taskId === taskIdA);
  const b = solutions.find(s => s.taskId === taskIdB);
  if (!a || !b) return { composed: false, reason: 'solution_not_found' };
  if (a.language !== b.language || a.language !== 'python') {
    return { composed: false, reason: 'language_mismatch_or_unsupported' };
  }
  if (a.multiFile || b.multiFile) return { composed: false, reason: 'multifile_compose_unsupported' };

  // Strategy: run A's code capturing its printed lines into a list, then run
  // B's logic over that list. We do this by wrapping: A prints lines, we
  // capture via a shared variable.
  const composedId = `composed-${taskIdA}+${taskIdB}`;
  const codeA = String(a.code || '');
  const codeB = String(b.code || '');

  // Simple composition: execute A, collect its output lines, then check how
  // many of those lines satisfy B's predicate. This works for filter-style B.
  // For now we support B tasks that print True/False or a count.
  const composedCode = `# Composed from ${taskIdA} + ${taskIdB}\n` +
    `# Part 1: ${a.description}\n` +
    `_part1_lines = []\n` +
    `_orig_print = print\n` +
    `def print(*args, **kwargs):\n` +
    `    _part1_lines.append(" ".join(str(x) for x in args))\n` +
    codeA + (codeA.endsWith('\n') ? '' : '\n') +
    `print = _orig_print\n` +
    `# Part 2: apply "${b.description}" to each line of part 1 output\n` +
    `for _line in _part1_lines:\n` +
    `    word = _line\n` +
    codeB.split('\n').map(l => l ? '    ' + l.replace(/"racecar"|"hello"|"hello world"/g, 'word') : l).join('\n');

  // Verify by running: it must execute without error and produce output.
  const run = teach.runCodeSandbox('python', composedCode, { timeoutMs: 10000 });
  if (!run.ok) {
    return { composed: false, reason: 'composition_failed_to_run', detail: run.stderr.slice(0, 200) };
  }
  const output = run.stdout.trim();
  if (!output) {
    return { composed: false, reason: 'composition_produced_no_output' };
  }
  // Retain the composed solution with its actual verified output as oracle.
  const composedTask = {
    id: composedId,
    language: 'python',
    description: `composed: ${a.description} then ${b.description}`,
    tags: [...new Set([...(a.tags || []), ...(b.tags || [])])],
    difficulty: 3,
    verify: { type: 'stdout', expected: output }
  };
  if (model) {
    teach.ensureCodeGeneration(model);
    const cg = model.lariCodeGeneration;
    if (!cg.solutions.some(s => s.taskId === composedId)) {
      cg.solutions.push({
        taskId: composedId,
        language: 'python',
        description: composedTask.description,
        tags: composedTask.tags,
        code: composedCode,
        composedFrom: [taskIdA, taskIdB],
        verifiedAt: new Date().toISOString()
      });
    }
  }
  return { composed: true, taskId: composedId, output, task: composedTask };
}

// ---------------------------------------------------------------------------
// 4. SELF-CURRICULUM — invent harder tasks from mastered ones.
// ---------------------------------------------------------------------------

/**
 * Generate practice variants from mastered tasks:
 *  - parameter variants (different numbers)
 *  - compositions of pairs
 */
function generateCurriculumTasks(model, options = {}) {
  const solutions = teach.getRetainedSolutions(model);
  const tasks = [];
  const maxNew = options.maxNew || 10;

  // Parameter variants: find numbers in seed descriptions and bump them.
  for (const seed of teach.CODE_TASK_SEEDS) {
    if (tasks.length >= maxNew) break;
    const alreadyMastered = solutions.some(s => s.taskId === seed.id);
    if (!alreadyMastered) continue;
    const nums = seed.description.match(/\d+/g);
    if (!nums) continue;
    for (const n of [...new Set(nums)].slice(0, 2)) {
      const bigger = String(parseInt(n, 10) * 2);
      const newDesc = seed.description.replace(n, bigger);
      const newId = `${seed.id}-x2-${n}`;
      if (solutions.some(s => s.taskId === newId)) continue;
      // We cannot know the expected output without running a correct solution.
      // Generate the variant task with a solver: use the pattern that solved
      // the original, run it, capture output as the oracle.
      const variantSeed = { ...seed, id: newId, description: newDesc, difficulty: (seed.difficulty || 1) + 1 };
      const candidates = teach.generateCandidates(model, variantSeed);
      let oracle = null;
      for (const cand of candidates) {
        const r = teach.runCodeSandbox(seed.language, cand.code, { timeoutMs: 10000 });
        if (r.ok && r.stdout.trim()) { oracle = r.stdout.trim(); break; }
      }
      if (oracle) {
        tasks.push({ ...variantSeed, verify: { type: 'stdout', expected: oracle } });
        if (tasks.length >= maxNew) break;
      }
    }
  }

  // Compositions: pairs of mastered single-file python solutions.
  const masteredPy = solutions.filter(s => s.language === 'python' && !s.multiFile && !s.composedFrom);
  for (let i = 0; i < masteredPy.length && tasks.length < maxNew; i++) {
    for (let j = 0; j < masteredPy.length && tasks.length < maxNew; j++) {
      if (i === j) continue;
      const pairId = `composed-${masteredPy[i].taskId}+${masteredPy[j].taskId}`;
      if (solutions.some(s => s.taskId === pairId)) continue;
      if (tasks.some(t => t.id === pairId)) continue;
      tasks.push({
        id: pairId,
        compose: [masteredPy[i].taskId, masteredPy[j].taskId],
        language: 'python',
        difficulty: 3
      });
    }
  }

  return tasks;
}

/**
 * Run a curriculum cycle: generate new tasks, attempt each.
 */
function runCurriculumCycle(model, options = {}) {
  const newTasks = generateCurriculumTasks(model, options);
  const results = [];
  let passed = 0;
  for (const task of newTasks) {
    let r;
    if (task.compose) {
      const c = composeSolutions(model, task.compose[0], task.compose[1], options);
      r = { taskId: task.id, passed: c.composed, reason: c.reason || 'composed' };
    } else {
      r = teach.selfTeachCodingTask(model, task, options);
      r = { taskId: task.id, passed: r.passed, reason: r.verification && r.verification.reason };
    }
    results.push(r);
    if (r.passed) passed++;
  }
  return { generated: newTasks.length, passed, failed: newTasks.length - passed, results };
}

// ---------------------------------------------------------------------------
// 5. RESEARCH WHEN STUCK — learn the concept, then retry.
// ---------------------------------------------------------------------------

/**
 * When a task fails because Lari has no way to solve it (no candidates),
 * record a structured research goal. If the runtime research loop is
 * available, it can pick this up; otherwise it waits as an open goal.
 */
function researchWhenStuck(model, task, failure, runtimeApi) {
  const cg = teach.ensureCodeGeneration(model);
  const concepts = extractConcepts(task.description);
  const goal = {
    taskId: task.id,
    description: task.description,
    language: task.language,
    tags: task.tags || [],
    concepts,
    failureReason: failure.reason,
    // Carry the oracle so the research loop can verify against it later.
    expectedOutput: task.verify && task.verify.type === 'stdout' ? task.verify.expected : null,
    createdAt: new Date().toISOString(),
    status: 'researching'
  };
  // Hand to the runtime research loop if available.
  let handedOff = false;
  try {
    if (runtimeApi && typeof runtimeApi.planAutonomousKnowledgeAcquisition === 'function') {
      const plan = runtimeApi.planAutonomousKnowledgeAcquisition(model,
        `how to ${task.description} in ${task.language}`, {});
      goal.researchPlan = plan ? 'planned' : 'plan_failed';
      handedOff = !!plan;
    }
  } catch (_) {}
  if (!handedOff) {
    // Queue as an open learning goal for the research loop to find later.
    cg.learningGoals.push({ ...goal, status: 'open' });
    if (cg.learningGoals.length > 50) cg.learningGoals = cg.learningGoals.slice(-50);
  }
  return { goal, handedOff };
}

function extractConcepts(description) {
  const lower = String(description || '').toLowerCase();
  const concepts = [];
  const patterns = [
    [/fibonacci/, 'fibonacci sequence'], [/fizzbuzz/, 'fizzbuzz'],
    [/factorial/, 'factorial'], [/palindrome/, 'palindrome check'],
    [/prime/, 'primality test'], [/sort/, 'sorting'],
    [/recursion|recursive/, 'recursion'], [/api|http|request/, 'http requests'],
    [/file|read|write/, 'file i/o'], [/class|object/, 'oop'],
    [/thread|async/, 'concurrency'], [/regex/, 'regular expressions'],
    [/json/, 'json handling'], [/database|sql/, 'databases']
  ];
  for (const [re, name] of patterns) {
    if (re.test(lower)) concepts.push(name);
  }
  return concepts;
}

// ---------------------------------------------------------------------------
// Debug task seeds: broken code for Lari to fix.
// ---------------------------------------------------------------------------

const DEBUG_TASK_SEEDS = [
  {
    id: 'debug-missing-colon',
    language: 'python',
    description: 'fix the syntax error: missing colon',
    code: 'for i in range(5)\n    print(i)',
    expectedOutput: '0\n1\n2\n3\n4'
  },
  {
    id: 'debug-name-typo',
    language: 'python',
    description: 'fix the NameError: typo in print',
    code: 'Print("hello")',
    expectedOutput: 'hello'
  },
  {
    id: 'debug-wrong-output',
    language: 'python',
    description: 'fix the logic: should print 0 to 4',
    code: 'for i in range(1, 5):\n    print(i)',
    expectedOutput: '0\n1\n2\n3\n4'
  },
  {
    id: 'debug-js-syntax',
    language: 'javascript',
    description: 'fix the syntax error in javascript',
    code: 'for (let i = 0; i < 5; i++) {\n  console.log(i)\n}',
    expectedOutput: '0\n1\n2\n3\n4'
  }
];

// ---------------------------------------------------------------------------
// 5b. CLOSE THE LOOP — research → verified pattern → retain → retry passes.
// ---------------------------------------------------------------------------

/**
 * Extract fenced code blocks for a language from free text.
 */
function extractCodeBlocks(text, language) {
  const blocks = [];
  const langAlt = language === 'python' ? 'python|py'
    : language === 'go' ? 'go|golang'
    : 'javascript|js|node';
  const re = new RegExp('```(?:' + langAlt + ')\\s*\\n([\\s\\S]*?)\\n```', 'g');
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const code = m[1].trim();
    if (code) blocks.push(code);
  }
  return blocks;
}

/**
 * Check a code string against a task's stdout oracle.
 */
function checkCodeAgainstOracle(language, code, task, options = {}) {
  const run = teach.runCodeSandbox(language, code, { timeoutMs: options.timeoutMs || 10000 });
  const verification = teach.verifyAttempt(task, run);
  return { run, verification };
}

/**
 * Find retained solutions related to a task by concept/tag overlap.
 */
function findRelatedSolutions(model, task, maxRelated = 5) {
  const concepts = new Set(extractConcepts(task.description).map(c => c.toLowerCase()));
  const taskWords = new Set(String(task.description || '').toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const solutions = teach.getRetainedSolutions(model).filter(s =>
    s.language === task.language && !s.multiFile && s.taskId !== task.id && !s.composedFrom);
  const scored = solutions.map(s => {
    const sWords = new Set(String(s.description || '').toLowerCase().split(/\W+/).filter(w => w.length > 3));
    let score = 0;
    for (const w of taskWords) if (sWords.has(w)) score += 1;
    for (const t of (s.tags || [])) if ((task.tags || []).includes(t)) score += 2;
    return { s, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, maxRelated).map(x => x.s);
}

/**
 * Retain a verified solution AND derive a reusable learned pattern from it.
 * The pattern's match regex is built from the task's distinctive words so
 * future tasks about the same concept match it.
 */
function retainResearchedSolution(model, task, code, learnedFrom, verifiedBy, derivedOutput) {
  const cg = teach.ensureCodeGeneration(model);
  const solutionId = task.id;
  if (!cg.solutions.some(s => s.taskId === solutionId)) {
    cg.solutions.push({
      taskId: solutionId,
      language: task.language,
      description: task.description,
      tags: task.tags || [],
      code,
      learnedFrom,
      verifiedBy: verifiedBy || 'oracle',
      derivedOracle: derivedOutput || null,
      verifiedAt: new Date().toISOString()
    });
  }
  // Build a match regex from distinctive words (length >= 4, not stopwords).
  const stopwords = new Set(['print', 'first', 'with', 'that', 'write', 'program', 'script', 'using', 'make']);
  const words = [...new Set(String(task.description || '').toLowerCase().split(/\W+/))]
    .filter(w => w.length >= 4 && !stopwords.has(w));
  const matchSource = words.length ? words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : '.*';
  const patternId = `learned-${task.id}`;
  const generalized = teach.generalizePattern(task, code);
  teach.addLearnedPattern(model, {
    id: patternId,
    language: task.language,
    matchSource,
    code, // literal fallback
    template: generalized.template,
    slots: generalized.slots,
    originalDescription: generalized.originalDescription,
    learnedFrom,
    verifiedAt: new Date().toISOString()
  });
  return { solutionId, patternId };
}

/**
 * Verify a code candidate with NO oracle — the case that used to be skipped.
 *
 * Three tiers, honestly labeled:
 *   1. differential: an independent local derivation (different family:
 *      pattern vs retained vs learned, either language) produces the same
 *      non-empty output. The candidate is excluded from its own comparison
 *      set, and identical code does not count as independent.
 *   2. properties: no independent derivation exists, but every concept
 *      property matching the description passes (independently recomputed).
 *   3. unconfirmed: the code runs cleanly and deterministically, but nothing
 *      independently confirms correctness. NOT verified — returned as a lead,
 *      never retained as a solution.
 *
 * Generic properties (exits clean, terminates, deterministic, nonempty) are
 * mandatory in all tiers: code that crashes or hangs is rejected outright.
 */
function verifyCodeNoOracle(model, task, code, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const runs = [
    teach.runCodeSandbox(task.language, code, { timeoutMs }),
    teach.runCodeSandbox(task.language, code, { timeoutMs })
  ];
  const out = normalizeOutput(runs[0].stdout);

  const propertyResults = [];
  for (const p of GENERIC_PROPERTIES) {
    let passed = false;
    try { passed = !!p.test(runs, task); } catch (_) {}
    propertyResults.push({ id: p.id, passed });
  }
  if (propertyResults.some(p => !p.passed)) {
    return { verified: false, reason: 'generic_properties_failed', propertyResults };
  }

  // Tier 1: differential agreement with an independent local derivation.
  const agreers = new Set();
  if (out) {
    const local = collectDiverseCandidates(model, task, options).filter(c => c.code !== code);
    for (const c of local.slice(0, options.maxCandidates || 12)) {
      let r;
      try { r = teach.runCodeSandbox(c.language, c.code, { timeoutMs }); } catch (_) { continue; }
      if (r.ok && normalizeOutput(r.stdout) === out) agreers.add(c.family);
    }
  }

  // Tier 2: concept properties (only those matching the description).
  const conceptResults = [];
  for (const cp of CONCEPT_PROPERTIES) {
    if (!cp.match.test(String(task.description || ''))) continue;
    let passed = false;
    try { passed = !!cp.test(runs, task); } catch (_) {}
    conceptResults.push({ id: cp.id, passed });
  }
  for (const c of conceptResults) propertyResults.push(c);

  if (agreers.size >= 1) {
    return {
      verified: true, tier: 'differential',
      agreement: [...agreers], propertyResults, output: out
    };
  }
  if (conceptResults.length > 0 && conceptResults.every(c => c.passed)) {
    return { verified: true, tier: 'properties', propertyResults, output: out };
  }
  return {
    verified: false,
    reason: 'no_independent_confirmation',
    propertyResults,
    output: out,
    note: 'code runs cleanly and deterministically, but no independent derivation or property confirms it is correct'
  };
}

/**
 * Close the research loop for a stuck task:
 *
 *   1. Widen the local search: try related retained solutions directly,
 *      debug-adapt them toward the oracle, and compose related pairs.
 *   2. Consult research: run the runtime's knowledge-acquisition loop for the
 *      concept (sources are pluggable), extract code blocks from the
 *      distilled knowledge, and sandbox-verify each against the oracle.
 *   3. The first verified candidate is retained as a solution AND compiled
 *      into a learned pattern, so a retry of the task (or a sibling task
 *      about the same concept) now passes from the new pattern.
 *
 * Returns { closed, strategy, attempts, goal }.
 */
function closeResearchLoop(model, task, runtimeApi, options = {}) {
  const cg = teach.ensureCodeGeneration(model);
  const goal = (cg.learningGoals || []).find(g =>
    (g.taskId === task.id || g.description === task.description) && g.status !== 'complete');
  const result = { closed: false, strategy: null, attempts: [], goal: goal || null };
  const note = (phase, detail) => result.attempts.push({ phase, detail });
  const hasOracle = !!(task.verify && task.verify.expected);
  if (!hasOracle) note('mode', 'oracle_free: researched code verified by differential agreement / properties, no human oracle');

  const tryCandidate = (code, strategy) => {
    let verification;
    if (hasOracle) {
      verification = checkCodeAgainstOracle(task.language, code, task, options).verification;
    } else {
      verification = verifyCodeNoOracle(model, task, code, options);
    }
    note(strategy, verification.reason || verification.tier || 'unknown');
    if (verification.passed || verification.verified) {
      const verifiedBy = hasOracle ? 'oracle' : verification.tier;
      const retained = retainResearchedSolution(model, task, code, strategy, verifiedBy, verification.output);
      if (goal) {
        goal.status = 'complete';
        goal.resolvedBy = strategy;
        goal.verifiedBy = verifiedBy;
        if (verification.agreement) goal.agreement = verification.agreement;
        if (verification.output) goal.derivedOutput = verification.output;
        goal.resolvedAt = new Date().toISOString();
      }
      result.closed = true;
      result.strategy = strategy;
      result.verifiedBy = verifiedBy;
      result.retained = retained;
      return true;
    }
    // Honest weak tier: code runs but is unconfirmed — keep it as a lead,
    // never as a solution.
    if (!hasOracle && verification.reason === 'no_independent_confirmation' && goal) {
      goal.unverifiedLead = code;
      goal.unverifiedLeadAt = new Date().toISOString();
      goal.unverifiedLeadNote = verification.note;
      note(strategy, 'unverified_lead_recorded');
    }
    return false;
  };

  // Phase 1: widen the local search over related retained solutions.
  const related = findRelatedSolutions(model, task, options.maxRelated || 5);
  note('widen_search', `found ${related.length} related solutions`);
  for (const rel of related) {
    if (result.closed) break;
    if (tryCandidate(rel.code, `related_direct:${rel.taskId}`)) break;
    // Debug-adapt: treat the related solution as a near-miss and repair it
    // toward this task's oracle.
    try {
      const adapted = debugBrokenCode({
        language: task.language,
        description: task.description,
        code: rel.code,
        expectedOutput: task.verify && task.verify.expected
      }, { maxAttempts: 4 });
      if (adapted.fixed && adapted.code) {
        const entry = Object.keys(adapted.code)[0];
        if (tryCandidate(adapted.code[entry], `adapted:${rel.taskId}+debug`)) break;
      }
    } catch (_) {}
  }
  // Compose related pairs.
  if (!result.closed) {
    for (let i = 0; i < related.length && !result.closed; i++) {
      for (let j = 0; j < related.length && !result.closed; j++) {
        if (i === j) continue;
        try {
          const c = composeSolutions(model, related[i].taskId, related[j].taskId, options);
          if (c.composed) {
            const sol = teach.getRetainedSolutions(model).find(s => s.taskId === c.taskId);
            if (sol && tryCandidate(sol.code, `composed:${c.taskId}`)) break;
          }
        } catch (_) {}
      }
    }
  }
  if (result.closed) return result;

  // Phase 2: consult research. The runtime's knowledge-acquisition loop does
  // the studying; we mine its distilled output for executable code.
  let researched = null;
  try {
    if (runtimeApi && typeof runtimeApi.runAutonomousKnowledgeAcquisition === 'function') {
      researched = runtimeApi.runAutonomousKnowledgeAcquisition(
        model,
        `how to ${task.description} in ${task.language}`,
        { sourceProvider: options.sourceProvider, sources: options.sources || [] }
      );
      note('research', researched ? researched.action : 'no_result');
    } else {
      note('research', 'no_research_api');
    }
  } catch (e) {
    note('research', `error: ${String((e && e.message) || e).slice(0, 120)}`);
  }
  if (researched) {
    const haystacks = [];
    if (researched.distilled) {
      haystacks.push(researched.distilled.summary, researched.distilled.text,
        JSON.stringify(researched.distilled).slice(0, 8000));
    }
    if (researched.learned) haystacks.push(JSON.stringify(researched.learned).slice(0, 8000));
    const blocks = [];
    for (const h of haystacks) {
      for (const b of extractCodeBlocks(h, task.language)) {
        if (!blocks.includes(b)) blocks.push(b);
      }
    }
    note('extract_code', `found ${blocks.length} code blocks in research`);
    for (const block of blocks.slice(0, options.maxResearchCandidates || 8)) {
      if (result.closed) break;
      tryCandidate(block, 'research_code_block');
    }
  }

  if (!result.closed && goal) {
    goal.status = 'open';
    goal.lastAttemptAt = new Date().toISOString();
    goal.attemptNotes = result.attempts.map(a => `${a.phase}: ${a.detail}`).slice(-8);
  }
  return result;
}

/**
 * Work open coding research goals: for each open goal (bounded), reconstruct
 * the task and run closeResearchLoop. Returns a summary of what closed.
 *
 * Goals with an oracle verify against it. Goals WITHOUT an oracle are no
 * longer skipped: the loop verifies researched code by differential agreement
 * with independent local derivations and by property checks, retaining only
 * what is independently confirmed (and recording runnable-but-unconfirmed
 * code as a lead, never as a solution).
 */
function workOpenCodingGoals(model, runtimeApi, options = {}) {
  const cg = teach.ensureCodeGeneration(model);
  const maxGoals = options.maxGoals || 2;
  const oracleFor = options.oracleFor || {};
  const open = (cg.learningGoals || []).filter(g => g.status === 'open').slice(0, maxGoals);
  const summary = { worked: 0, closed: 0, stillOpen: 0, details: [] };
  for (const goal of open) {
    const oracle = oracleFor[goal.taskId] || goal.expectedOutput || null;
    const task = {
      id: goal.taskId || `goal-${Date.now()}`,
      language: goal.language || 'python',
      description: goal.description || '',
      tags: goal.concepts || []
    };
    if (oracle) task.verify = { type: 'stdout', expected: oracle };
    // Mark in-progress so a concurrent pass does not duplicate the work.
    goal.status = 'researching';
    let r;
    try {
      r = closeResearchLoop(model, task, runtimeApi, options);
    } catch (e) {
      goal.status = 'open';
      summary.details.push({ taskId: task.id, error: String((e && e.message) || e).slice(0, 120) });
      continue;
    }
    summary.worked++;
    if (r.closed) { summary.closed++; }
    else { summary.stillOpen++; }
    summary.details.push({ taskId: task.id, closed: r.closed, strategy: r.strategy });
  }
  return summary;
}


// DIFFERENTIAL VERIFICATION — no oracle? Derive one from agreement.
//
// Generate candidates through independent derivation paths (different
// patterns, retained solutions, learned patterns, different languages),
// run them all, and group by output. When >= minFamilies distinct families
// agree on non-empty output, that output is treated as verified. Agreement
// is evidence, not proof — two derivations can share a wrong assumption —
// so the agreement strength is always recorded alongside the verdict.
// ---------------------------------------------------------------------------

function normalizeOutput(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim().replace(/\n+$/, '');
}

/**
 * Collect candidates labeled by derivation family and language.
 * Families: python:pattern, python:retained, python:learned, javascript:pattern, ...
 */
function collectDiverseCandidates(model, task, options = {}) {
  const out = [];
  const seen = new Set();
  const languages = options.crossLanguage === false
    ? [task.language]
    : [...new Set([task.language, task.language === 'python' ? 'javascript' : 'python'])];
  for (const lang of languages) {
    let cands = [];
    try { cands = teach.generateCandidates(model, { ...task, language: lang }); } catch (_) {}
    for (const c of cands) {
      if (!c || !c.code) continue;
      const key = `${lang}:${c.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const family = String(c.source || 'unknown').split(':')[0];
      out.push({ code: c.code, source: c.source, family: `${lang}:${family}`, language: lang });
    }
  }
  return out;
}

function differentialVerify(model, task, options = {}) {
  const minFamilies = options.minFamilies || 2;
  const candidates = collectDiverseCandidates(model, task, options);
  const groups = new Map();
  let runs = 0;
  for (const c of candidates.slice(0, options.maxCandidates || 12)) {
    const run = teach.runCodeSandbox(c.language, c.code, { timeoutMs: options.timeoutMs || 10000 });
    runs++;
    if (!run.ok) continue;
    const key = normalizeOutput(run.stdout);
    if (!key) continue; // empty output is not evidence of agreement
    if (!groups.has(key)) groups.set(key, { families: new Set(), members: [] });
    const g = groups.get(key);
    g.families.add(c.family);
    g.members.push(c);
  }
  let best = null;
  for (const [output, g] of groups) {
    if (g.families.size >= minFamilies && (!best || g.families.size > best.families.length)) {
      best = { output, families: [...g.families], members: g.members };
    }
  }
  return {
    verified: !!best,
    output: best ? best.output : null,
    code: best ? best.members[0].code : null,
    language: best ? best.members[0].language : null,
    agreement: best ? { families: best.families, derivations: best.members.length } : null,
    groups: [...groups.entries()].map(([output, g]) => ({ output: output.slice(0, 200), families: [...g.families] })),
    candidatesRun: runs
  };
}

// ---------------------------------------------------------------------------
// PROPERTY CHECKS — verify invariants instead of exact output.
//
// Generic properties hold for any task (exits clean, terminates,
// deterministic, produces output). Concept properties check the math/logic
// of the output independently of how it was derived.
// ---------------------------------------------------------------------------

function isPrimeNumber(x) {
  if (x < 2) return false;
  for (let d = 2; d * d <= x; d++) if (x % d === 0) return false;
  return true;
}

const GENERIC_PROPERTIES = [
  { id: 'exits_clean', test: (runs) => runs.every(r => r.ok) },
  { id: 'terminates', test: (runs) => runs.every(r => !r.timedOut) },
  { id: 'deterministic', test: (runs) => runs.length > 1 && runs.every(r => r.stdout === runs[0].stdout) },
  { id: 'nonempty_output', test: (runs) => runs[0].ok && normalizeOutput(runs[0].stdout).length > 0 }
];

const CONCEPT_PROPERTIES = [
  {
    match: /sort/i, id: 'sorted_ascending',
    test: (runs) => {
      const nums = normalizeOutput(runs[0].stdout).split('\n').map(Number);
      if (!nums.length || nums.some(isNaN)) return false;
      return nums.every((v, i) => i === 0 || nums[i - 1] <= v);
    }
  },
  {
    match: /fibonacci/i, id: 'fib_recurrence',
    test: (runs) => {
      const nums = normalizeOutput(runs[0].stdout).split('\n').map(Number);
      if (nums.length < 3 || nums.some(isNaN)) return false;
      if (nums[0] !== 0 || nums[1] !== 1) return false;
      return nums.every((v, i) => i < 2 || v === nums[i - 1] + nums[i - 2]);
    }
  },
  {
    match: /fizzbuzz/i, id: 'fizzbuzz_rules',
    test: (runs, task) => {
      // "1 to N" form: the range end is the LAST number in the description.
      const nums = (String(task.description || '').match(/\d+/g) || []).map(Number);
      const n = nums.length ? nums[nums.length - 1] : 15;
      const lines = normalizeOutput(runs[0].stdout).split('\n');
      if (lines.length !== n) return false;
      return lines.every((line, idx) => {
        const i = idx + 1;
        const expected = i % 15 === 0 ? 'FizzBuzz' : i % 3 === 0 ? 'Fizz' : i % 5 === 0 ? 'Buzz' : String(i);
        return line.trim() === expected;
      });
    }
  },
  {
    match: /factorial/i, id: 'factorial_correct',
    test: (runs, task) => {
      const n = parseInt((String(task.description || '').match(/factorial of (\d+)/i) || [])[1] || '5', 10);
      let expected = 1;
      for (let i = 2; i <= n; i++) expected *= i;
      return normalizeOutput(runs[0].stdout) === String(expected);
    }
  },
  {
    match: /prime/i, id: 'prime_correct',
    test: (runs, task) => {
      const nums = (String(task.description || '').match(/\d+/g) || []).map(Number);
      if (!nums.length) return false;
      const out = normalizeOutput(runs[0].stdout).toLowerCase();
      // "is N prime" -> True/False form
      if (/is \d+ prime/.test(String(task.description || '').toLowerCase())) {
        return out === String(isPrimeNumber(nums[0])).toLowerCase();
      }
      return false;
    }
  }
];

/**
 * Run code twice and check every applicable property.
 */
function verifyWithProperties(task, code, options = {}) {
  const runs = [
    teach.runCodeSandbox(task.language, code, { timeoutMs: options.timeoutMs || 10000 }),
    teach.runCodeSandbox(task.language, code, { timeoutMs: options.timeoutMs || 10000 })
  ];
  const results = [];
  for (const p of GENERIC_PROPERTIES) {
    let passed = false;
    try { passed = !!p.test(runs, task); } catch (_) {}
    results.push({ id: p.id, passed });
  }
  for (const cp of CONCEPT_PROPERTIES) {
    if (!cp.match.test(String(task.description || ''))) continue;
    let passed = false;
    try { passed = !!cp.test(runs, task); } catch (_) {}
    results.push({ id: cp.id, passed });
  }
  const failed = results.filter(r => !r.passed);
  return { passed: failed.length === 0 && results.length > 0, propertyResults: results };
}

/**
 * Self-teach a task with NO oracle: differential agreement + property checks.
 * On success the agreed output is retained as a derived oracle, marked with
 * how it was verified so downstream consumers know its provenance.
 */
function selfTeachTaskNoOracle(model, task, options = {}) {
  const result = { taskId: task.id, passed: false, verification: null, strategy: null };
  const diff = differentialVerify(model, task, options);
  if (!diff.verified) {
    result.verification = { passed: false, reason: 'no_differential_agreement', groups: diff.groups };
    return result;
  }
  const props = verifyWithProperties({ ...task, language: diff.language }, diff.code, options);
  if (!props.passed) {
    result.verification = {
      passed: false, reason: 'properties_failed',
      propertyResults: props.propertyResults, agreement: diff.agreement
    };
    return result;
  }
  result.passed = true;
  result.strategy = 'differential+properties';
  result.verification = { passed: true, reason: 'differential_agreement', agreement: diff.agreement, propertyResults: props.propertyResults };
  result.code = diff.code;
  result.output = diff.output;
  // Retain with provenance.
  const cg = teach.ensureCodeGeneration(model);
  if (!cg.solutions.some(s => s.taskId === task.id)) {
    cg.solutions.push({
      taskId: task.id,
      language: diff.language,
      description: task.description,
      tags: task.tags || [],
      code: diff.code,
      verifiedBy: 'differential+properties',
      derivedOracle: diff.output,
      agreement: diff.agreement,
      verifiedAt: new Date().toISOString()
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// REAL-WORLD TASKS — file I/O, test suites, repo repair.
// ---------------------------------------------------------------------------

function verifyProjectTask(task, run, dir) {
  const verify = task.verify || {};
  if (run.timedOut) return { passed: false, reason: 'timeout', detail: (run.stderr || '').slice(0, 200) };
  if (verify.type === 'file') {
    if (!run.ok) return { passed: false, reason: 'runtime_error', detail: (run.stderr || '').slice(0, 300) };
    const full = path.join(dir || '', String(verify.path).replace(/[^A-Za-z0-9_.\-]/g, '_'));
    if (!dir || !fs.existsSync(full)) return { passed: false, reason: 'output_file_missing' };
    const content = normalizeOutput(fs.readFileSync(full, 'utf8'));
    const expected = normalizeOutput(verify.expected);
    return content === expected
      ? { passed: true, reason: 'file_match' }
      : { passed: false, reason: 'file_mismatch', detail: `expected ${JSON.stringify(expected.slice(0, 80))}, got ${JSON.stringify(content.slice(0, 80))}` };
  }
  if (verify.type === 'exit_code') {
    const expected = verify.expected == null ? 0 : verify.expected;
    return run.exitCode === expected
      ? { passed: true, reason: 'exit_code_match' }
      : { passed: false, reason: 'exit_code_mismatch', detail: `exit ${run.exitCode}, stderr: ${(run.stderr || '').slice(0, 200)}` };
  }
  return teach.verifyAttempt(task, run);
}

const FILE_PATTERNS = [
  {
    id: 'py-file-sum', language: 'python', match: /numbers\.txt/i,
    build: (task) => {
      const out = (task.verify && task.verify.path) || 'answer.txt';
      return `total = 0\nwith open("numbers.txt") as f:\n    for line in f:\n        line = line.strip()\n        if line:\n            total += int(line)\nwith open("${out}", "w") as f:\n    f.write(str(total))`;
    }
  },
  {
    id: 'py-file-count', language: 'python', match: /words\.txt|line count/i,
    build: (task) => {
      const out = (task.verify && task.verify.path) || 'answer.txt';
      return `with open("words.txt") as f:\n    lines = [l for l in f if l.strip()]\nwith open("${out}", "w") as f:\n    f.write(str(len(lines)))`;
    }
  }
];

function generateFileCandidates(model, task) {
  const candidates = [];
  const retained = teach.getRetainedSolutions(model).find(s => s.taskId === task.id && s.fileTask);
  if (retained && retained.code) candidates.push({ code: retained.code, source: `retained:${retained.taskId}` });
  for (const pattern of FILE_PATTERNS) {
    if (pattern.language !== task.language) continue;
    if (!pattern.match.test(task.description || '')) continue;
    try {
      const code = pattern.build(task);
      if (code && !candidates.some(c => c.code === code)) candidates.push({ code, source: `pattern:${pattern.id}` });
    } catch (_) {}
  }
  return candidates;
}

const FILE_TASK_SEEDS = [
  {
    id: 'py-file-sum',
    language: 'python',
    description: 'read numbers.txt (one integer per line) and write their sum to answer.txt',
    tags: ['file-io'],
    difficulty: 2,
    setupFiles: { 'numbers.txt': '10\n20\n30\n' },
    entryFile: 'solution.py',
    verify: { type: 'file', path: 'answer.txt', expected: '60' }
  },
  {
    id: 'py-file-count',
    language: 'python',
    description: 'read words.txt (one word per line) and write the line count to answer.txt',
    tags: ['file-io'],
    difficulty: 2,
    setupFiles: { 'words.txt': 'apple\nbanana\ncherry\ndate\n' },
    entryFile: 'solution.py',
    verify: { type: 'file', path: 'answer.txt', expected: '4' }
  }
];

/**
 * Run a file-I/O task: setup files + candidate code in one sandbox dir,
 * then check the output file the code was asked to write.
 */
function runFileTask(model, task, options = {}) {
  const entryFile = task.entryFile || 'solution.py';
  const result = { taskId: task.id, passed: false, code: null, verification: null, attempts: [] };
  const candidates = generateFileCandidates(model, task);
  for (const c of candidates.slice(0, options.maxAttempts || 3)) {
    const files = { ...(task.setupFiles || {}), [entryFile]: c.code };
    const { run, dir, cleanup } = runSandboxKeepDir(task.language, files, entryFile, options);
    let verification;
    try { verification = verifyProjectTask(task, run, dir); }
    finally { cleanup(); }
    result.attempts.push({ source: c.source, verification });
    if (verification.passed) {
      result.passed = true;
      result.code = c.code;
      result.verification = verification;
      const cg = teach.ensureCodeGeneration(model);
      if (!cg.solutions.some(s => s.taskId === task.id)) {
        cg.solutions.push({
          taskId: task.id, language: task.language, description: task.description,
          tags: task.tags || [], code: files, multiFile: true, fileTask: true,
          entryPoint: entryFile, verifiedAt: new Date().toISOString()
        });
      }
      break;
    }
  }
  if (!result.passed && !result.verification && result.attempts.length) {
    result.verification = result.attempts[result.attempts.length - 1].verification;
  }
  return result;
}

const TEST_SUITE_SEEDS = [
  {
    id: 'py-suite-double',
    language: 'python',
    description: 'implement double(n) in solution.py so the bundled test suite passes',
    tags: ['testing'],
    difficulty: 2,
    files: {
      'test_solution.py': 'from solution import double\nassert double(21) == 42, "double(21)"\nassert double(0) == 0, "double(0)"\nassert double(-3) == -6, "double(-3)"\nprint("all tests passed")\n'
    },
    candidateFile: 'solution.py',
    entryPoint: 'test_solution.py',
    verify: { type: 'exit_code', expected: 0 }
  },
  {
    id: 'py-suite-factorial-fn',
    language: 'python',
    description: 'implement factorial(n) in solution.py so the bundled test suite passes',
    tags: ['testing'],
    difficulty: 2,
    files: {
      'test_solution.py': 'from solution import factorial\nassert factorial(0) == 1\nassert factorial(5) == 120\nassert factorial(3) == 6\nprint("all tests passed")\n'
    },
    candidateFile: 'solution.py',
    entryPoint: 'test_solution.py',
    verify: { type: 'exit_code', expected: 0 }
  }
];

const SUITE_PATTERNS = [
  {
    id: 'py-suite-double', language: 'python', match: /double\(n\)/i,
    build: () => 'def double(n):\n    return n * 2\n'
  },
  {
    id: 'py-suite-factorial', language: 'python', match: /factorial\(n\)/i,
    build: () => 'def factorial(n):\n    result = 1\n    for i in range(1, n + 1):\n        result *= i\n    return result\n'
  }
];

function generateSuiteCandidates(model, task) {
  const candidates = [];
  const retained = teach.getRetainedSolutions(model).find(s => s.taskId === task.id && s.suiteTask);
  if (retained && retained.code) candidates.push({ code: retained.code, source: `retained:${retained.taskId}` });
  for (const pattern of SUITE_PATTERNS) {
    if (pattern.language !== task.language) continue;
    if (!pattern.match.test(task.description || '')) continue;
    try {
      const code = pattern.build(task);
      if (code && !candidates.some(c => c.code === code)) candidates.push({ code, source: `pattern:${pattern.id}` });
    } catch (_) {}
  }
  return candidates;
}

/**
 * Run a test-suite task: inject the candidate as candidateFile, run the
 * bundled tests as the entry point, verify by exit code.
 */
function runTestSuiteTask(model, task, options = {}) {
  const candidateFile = task.candidateFile || 'solution.py';
  const result = { taskId: task.id, passed: false, code: null, verification: null, attempts: [] };
  const candidates = generateSuiteCandidates(model, task);
  for (const c of candidates.slice(0, options.maxAttempts || 3)) {
    const files = { ...(task.files || {}), [candidateFile]: c.code };
    const run = runMultiFileSandbox(task.language, files, task.entryPoint, options);
    const verification = verifyProjectTask(task, run, null);
    result.attempts.push({ source: c.source, verification });
    if (verification.passed) {
      result.passed = true;
      result.code = c.code;
      result.verification = verification;
      const cg = teach.ensureCodeGeneration(model);
      if (!cg.solutions.some(s => s.taskId === task.id)) {
        cg.solutions.push({
          taskId: task.id, language: task.language, description: task.description,
          tags: task.tags || [], code: files, multiFile: true, suiteTask: true,
          entryPoint: task.entryPoint, verifiedAt: new Date().toISOString()
        });
      }
      break;
    }
  }
  if (!result.passed && !result.verification && result.attempts.length) {
    result.verification = result.attempts[result.attempts.length - 1].verification;
  }
  return result;
}

const REPO_REPAIR_SEEDS = [
  {
    id: 'repo-broken-import',
    language: 'python',
    description: 'fix the repo: main.py imports add from helpers, but the definition has a typo',
    tags: ['repo-repair'],
    difficulty: 3,
    files: {
      'main.py': 'from helpers import add\nprint(add(2, 3))\n',
      'helpers.py': 'def addd(a, b):\n    return a + b\n'
    },
    entryPoint: 'main.py',
    expectedOutput: '5'
  },
  {
    id: 'repo-wrong-init',
    language: 'python',
    description: 'fix the repo: Counter should count 1, 2, 3 but starts wrong',
    tags: ['repo-repair'],
    difficulty: 3,
    files: {
      'main.py': 'from counter import Counter\nc = Counter()\nfor _ in range(3):\n    print(c.tick())\n',
      'counter.py': 'class Counter:\n    def __init__(self):\n        self.n = 1\n    def tick(self):\n        self.n += 1\n        return self.n\n'
    },
    entryPoint: 'main.py',
    expectedOutput: '1\n2\n3'
  }
];

/**
 * Run a repo-repair task: multi-file broken project, fix via debugBrokenCode.
 */
function runRepoRepairTask(model, task, options = {}) {
  const result = debugBrokenCode({
    language: task.language,
    description: task.description,
    files: task.files,
    entryPoint: task.entryPoint,
    expectedOutput: task.expectedOutput
  }, { maxAttempts: options.maxAttempts || 6, timeoutMs: options.timeoutMs || 10000 });
  const out = {
    taskId: task.id,
    passed: result.fixed === true,
    code: result.code,
    strategy: result.strategy,
    verification: result.verification,
    attempts: result.attempts
  };
  if (out.passed && model) {
    const cg = teach.ensureCodeGeneration(model);
    if (!cg.solutions.some(s => s.taskId === task.id)) {
      cg.solutions.push({
        taskId: task.id, language: task.language, description: task.description,
        tags: task.tags || [], code: result.code, multiFile: true, repoRepair: true,
        entryPoint: task.entryPoint, verifiedAt: new Date().toISOString()
      });
    }
  }
  return out;
}

module.exports = {
  runMultiFileSandbox,
  classifyError,
  proposePatternRepairs,
  debugBrokenCode,
  DEBUG_TASK_SEEDS,
  MULTIFILE_TASK_SEEDS,
  runMultiFileTask,
  composeSolutions,
  generateCurriculumTasks,
  runCurriculumCycle,
  researchWhenStuck,
  closeResearchLoop,
  workOpenCodingGoals,
  extractConcepts,
  extractCodeBlocks,
  retainResearchedSolution,
  findRelatedSolutions,
  // Differential verification (no oracle needed)
  differentialVerify,
  collectDiverseCandidates,
  verifyCodeNoOracle,
  selfTeachTaskNoOracle,
  // Property checks
  verifyWithProperties,
  GENERIC_PROPERTIES,
  CONCEPT_PROPERTIES,
  // Real-world tasks: file I/O, test suites, repo repair
  runFileTask,
  FILE_TASK_SEEDS,
  runTestSuiteTask,
  TEST_SUITE_SEEDS,
  runRepoRepairTask,
  REPO_REPAIR_SEEDS,
  runSandboxKeepDir,
  editDistance,
  proposeCrossFileRepairs
};
