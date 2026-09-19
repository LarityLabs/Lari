#!/usr/bin/env node
'use strict';

/**
 * Generate a sealed test-set holdout by mechanical mutation.
 *
 * Why not hand-pick the bugs
 * --------------------------
 * The 20260725 holdout is a dev set: it revealed four gaps and the repair families were then written
 * to cover those classes, so a score on it cannot separate "the approach generalises" from "the
 * approach was fitted to these four cases". Hand-picking a second set would repeat that, one level up.
 *
 * So selection here is mechanical and seeded. Sites and mutations are drawn from the standard
 * mutation-testing catalogue with a recorded PRNG seed, which makes the set reproducible and removes
 * the opportunity to steer it. The catalogue deliberately includes classes the current repair engine
 * has NO family for -- arithmetic operator replacement, unary insertion, statement deletion -- so a
 * perfect score is not reachable by construction. A test set that could only pass would measure
 * nothing.
 *
 * Oracle
 * ------
 * The project's own test suite, not tests written here. That removes the last authoring bias: with
 * 1300+ upstream assertions, a patch that merely satisfies a narrow hand-written check cannot pass
 * (the dev set had exactly that failure -- `size != maxsize` passed a weak oracle while being wrong).
 *
 * Usage:
 *   node scripts/generate_lari_mechanical_holdout.js --repo <dir> --test-command "<cmd>" \
 *     --seed 20260725 --count 6 --out <manifest.json>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Standard mutation-testing operators. `coveredByEngine` records, honestly and in advance, whether a
// repair family exists for the class -- so the expected ceiling is stated before measuring.
const CATALOGUE = [
  // '>' is excluded as a bare rule because it also appears in Python's return annotation arrow.
  // Rewriting "def f(x) -> int:" to "-> =" is a syntax error, not a behavioural defect, and the
  // 49172 set shipped exactly that as an instance. Spaced forms only.
  { op: 'ROR', label: 'relational operator replacement', coveredByEngine: true,
    rules: [['>=', '>'], ['<=', '<'], [' > ', ' >= '], [' < ', ' <= '], ['==', '!='], ['!=', '==']] },
  { op: 'AOR', label: 'arithmetic operator replacement', coveredByEngine: false,
    rules: [[' + ', ' - '], [' - ', ' + '], [' * ', ' + '], [' // ', ' * ']] },
  { op: 'LCR', label: 'logical connector replacement', coveredByEngine: true,
    rules: [[' and ', ' or '], [' or ', ' and ']] },
  { op: 'CRP', label: 'constant replacement', coveredByEngine: true, constant: true },
  { op: 'UOI', label: 'unary operator insertion', coveredByEngine: false, unary: true },
  { op: 'SDL', label: 'statement deletion', coveredByEngine: false, deletion: true }
];

function parseArgs(argv) {
  const args = { seed: 20260725, count: 6, repo: null, testCommand: null, out: null, operators: null };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--repo') args.repo = path.resolve(argv[++i]);
    else if (t === '--test-command') args.testCommand = argv[++i];
    else if (t === '--seed') args.seed = Number(argv[++i]);
    else if (t === '--count') args.count = Number(argv[++i]);
    else if (t === '--out') args.out = path.resolve(argv[++i]);
    // Restrict to specific operator classes. Used for declared targeted experiments -- for
    // example testing vocabulary growth, which requires classes the seed vocabulary cannot
    // express. A set built this way is NOT a blind holdout and must be labelled as such.
    else if (t === '--operators') args.operators = String(argv[++i]).split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else throw new Error(`Unknown argument: ${t}`);
  }
  for (const req of ['repo', 'testCommand', 'out']) if (!args[req]) throw new Error(`--${req} is required`);
  return args;
}

// Deterministic PRNG so the seed fully determines the set.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function listPythonSources(root) {
  const results = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['.git', '__pycache__', 'tests', 'test', 'docs', '.tox', 'build', 'dist'].includes(entry.name)) continue;
        stack.push(full);
      } else if (entry.name.endsWith('.py') && !entry.name.startsWith('test_') && entry.name !== 'setup.py') {
        results.push(full);
      }
    }
  }
  return results.sort();
}

/**
 * Line numbers that carry executable code, decided by Python's own tokenizer.
 *
 * The previous guard skipped lines that *begin* with `#`, `"""` or `'''`, which does not skip the body
 * of a docstring. Five instances across the humanize sets were mutations inside docstrings -- doctest
 * examples like `>>> intword("1234100", "%0.3f")`, a doctest expected-output line, and one that
 * rewrote English prose because the word `return` occurs in it ("will return the output" became "will
 * return not the output"). None can change behaviour, so the measurement correctly found them inert and
 * silently dropped them, and the sets lost a quarter of their instances.
 *
 * A defect seeded in prose is not a defect. Deciding this with a regex is what produced the bug, so it
 * is decided by `tokenize` instead: a line is code-bearing if it carries at least one token that is not
 * a string, a comment, or whitespace bookkeeping. That keeps `x = "hello"` (a real assignment) and
 * drops a docstring's interior.
 *
 * Returns null if the file cannot be tokenized, and the caller falls back rather than silently
 * accepting every line.
 */
function codeBearingLines(file, python = 'python') {
  const probe = [
    'import io, json, sys, tokenize',
    'src = open(sys.argv[1], "rb").read()',
    'ignore = {tokenize.STRING, tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE,',
    '          tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER, tokenize.ENCODING}',
    'lines = set()',
    'try:',
    '    for tok in tokenize.tokenize(io.BytesIO(src).readline):',
    '        if tok.type in ignore:',
    '            continue',
    '        for n in range(tok.start[0], tok.end[0] + 1):',
    '            lines.add(n)',
    'except Exception as e:',
    '    print(json.dumps({"error": type(e).__name__ + ": " + str(e)}))',
    '    sys.exit(0)',
    'print(json.dumps({"lines": sorted(lines)}))'
  ].join('\n');

  const run = spawnSync(python, ['-c', probe, file], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (run.error || run.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(run.stdout || '').trim().split(/\r?\n/).pop());
    return parsed.lines ? new Set(parsed.lines) : null;
  } catch (e) {
    return null;
  }
}

function candidateSites(sourceFiles, root) {
  const sites = [];
  let untokenizable = 0;
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const codeLines = codeBearingLines(file);
    if (!codeLines) untokenizable += 1;
    lines.forEach((line, index) => {
      // tokenize reports 1-based lines; `index` is 0-based.
      if (codeLines && !codeLines.has(index + 1)) return;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('"""') || trimmed.startsWith("'''")) return;
      if (/^(?:import|from)\b/.test(trimmed)) return;
      for (const entry of CATALOGUE) {
        if (entry.rules) {
          for (const [from, to] of entry.rules) {
            if (line.includes(from)) sites.push({ file, index, op: entry.op, from, to, coveredByEngine: entry.coveredByEngine });
          }
        } else if (entry.constant) {
          for (const match of new Set([...line.matchAll(/\b(\d{1,4})\b/g)].map(m => m[1]))) {
            sites.push({ file, index, op: entry.op, from: match, to: String(Number(match) + 1), coveredByEngine: entry.coveredByEngine });
          }
        } else if (entry.unary && /\breturn\s+[A-Za-z_(]/.test(trimmed)) {
          sites.push({ file, index, op: entry.op, from: 'return ', to: 'return not ', coveredByEngine: entry.coveredByEngine });
        } else if (entry.deletion && /^(?:self\.|[a-z_]+\s*=|[a-z_]+\()/.test(trimmed) && !/^return\b/.test(trimmed)) {
          sites.push({ file, index, op: entry.op, from: null, to: null, deletion: true, coveredByEngine: entry.coveredByEngine });
        }
      }
    });
  }
  if (untokenizable) {
    // Never silent. A file that could not be tokenized falls back to the old line heuristic, which is
    // exactly the heuristic that seeded defects into prose, so the count has to travel with the set.
    console.error(`WARNING: ${untokenizable} source file(s) could not be tokenized; `
      + 'those fell back to the line heuristic and may yield sites inside docstrings.');
  }
  sites.untokenizableFiles = untokenizable;
  return sites;
}

function applyMutation(text, site) {
  const lines = text.split(/\r?\n/);
  const line = lines[site.index];
  if (site.deletion) {
    const indent = line.match(/^\s*/)[0];
    lines[site.index] = `${indent}pass  # mutated: statement removed`;
  } else {
    if (!line.includes(site.from)) return null;
    lines[site.index] = line.replace(site.from, site.to);
  }
  const next = lines.join('\n');
  return next === text ? null : next;
}

/**
 * Run the suite with a bounded timeout and reap orphaned workers.
 *
 * The measurement runner was hardened against this and the generator was not, so the same defect bit
 * twice from a second file. A mutation can delete a loop increment and produce an infinite loop; with a
 * fifteen-minute timeout each such candidate burns fifteen minutes, and because spawnSync kills only
 * the shell rather than the python beneath it, the orphans accumulate and compete for the machine. One
 * observed run had a single pytest at 3411 seconds of CPU after 58 minutes, with generation stalled
 * behind it.
 *
 * A non-terminating mutant is simply not a usable instance. 90 seconds is already several times the
 * normal suite runtime for the projects in use here.
 */
function runSuite(repo, testCommand) {
  const startedAt = Date.now();
  const result = spawnSync(testCommand, { cwd: repo, shell: true, encoding: 'utf8', timeout: 90000 });
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';

  if (timedOut) {
    try {
      const iso = new Date(startedAt - 2000).toISOString();
      spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt [datetime]'${iso}' } | Stop-Process -Force -ErrorAction SilentlyContinue`
      ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    } catch (_) {
      // Best effort. A leaked worker slows generation but does not corrupt the set.
    }
  }

  return {
    passed: result.status === 0,
    timedOut,
    tail: String(result.stdout || result.stderr || '').trim().split(/\r?\n/).slice(-2).join(' | ')
  };
}

function git(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function main() {
  const args = parseArgs(process.argv.slice(2));
  git(args.repo, ['checkout', '--', '.']);
  git(args.repo, ['clean', '-qfd']);

  const baseline = runSuite(args.repo, args.testCommand);
  if (!baseline.passed) throw new Error(`Baseline suite must be green before seeding. Got: ${baseline.tail}`);

  const sources = listPythonSources(args.repo);
  let sites = candidateSites(sources, args.repo);
  if (args.operators) sites = sites.filter(site => args.operators.includes(site.op));
  const random = mulberry32(args.seed);
  // Shuffle deterministically from the seed, then take the first sites that produce a real failure.
  const shuffled = sites.map(site => ({ site, key: random() })).sort((a, b) => a.key - b.key).map(item => item.site);

  const accepted = [];
  const rejected = [];
  for (const site of shuffled) {
    if (accepted.length >= args.count) break;
    const relative = path.relative(args.repo, site.file).replace(/\\/g, '/');
    if (accepted.some(item => item.targetFile === relative && item.line === site.index + 1)) continue;

    const original = fs.readFileSync(site.file, 'utf8');
    const mutated = applyMutation(original, site);
    if (!mutated) continue;
    fs.writeFileSync(site.file, mutated);

    // Reject mutants that do not parse. A syntax error is not a seeded regression: the module cannot
    // import, the suite dies at collection with no FAILED lines, nothing can be localized, and
    // "repairing" it only means undoing a typo. The green-suite check below cannot catch these,
    // because a syntax error makes the suite red and therefore looks like a valid bug.
    const syntax = spawnSync(`python -m py_compile "${site.file.replace(/\\/g, '/')}"`,
      { cwd: args.repo, shell: true, encoding: 'utf8', timeout: 60000 });
    if (syntax.status !== 0) {
      fs.writeFileSync(site.file, original);
      rejected.push({ relative, line: site.index + 1, op: site.op, reason: 'mutant does not parse (syntax error, not a behavioural defect)' });
      continue;
    }

    const outcome = runSuite(args.repo, args.testCommand);
    const mutatedLine = mutated.split(/\r?\n/)[site.index];
    fs.writeFileSync(site.file, original);

    if (outcome.passed) { rejected.push({ relative, line: site.index + 1, op: site.op, reason: 'suite still green (equivalent mutant)' }); continue; }
    if (outcome.timedOut) { rejected.push({ relative, line: site.index + 1, op: site.op, reason: 'suite did not terminate (non-halting mutant)' }); continue; }

    accepted.push({
      instance_id: `${path.basename(args.repo)}-${site.op}-${relative.replace(/[^a-z0-9]+/gi, '_')}-L${site.index + 1}`.toLowerCase(),
      operator: site.op,
      operatorLabel: (CATALOGUE.find(c => c.op === site.op) || {}).label || site.op,
      coveredByEngine: site.coveredByEngine,
      targetFile: relative,
      line: site.index + 1,
      seed: { find: site.deletion ? original.split(/\r?\n/)[site.index] : site.from, replace: site.deletion ? mutatedLine : site.to, deletion: Boolean(site.deletion) },
      mutatedLine: mutatedLine.trim().slice(0, 160),
      failureTail: outcome.tail.slice(0, 200)
    });
  }

  git(args.repo, ['checkout', '--', '.']);
  git(args.repo, ['clean', '-qfd']);

  const manifest = {
    schemaVersion: 1,
    kind: 'lari.repository_holdout.mechanical_manifest',
    id: `mechanical-testset-${path.basename(args.repo)}-${args.seed}`,
    createdAt: new Date().toISOString(),
    selection: {
      method: args.operators
        ? `seeded deterministic shuffle restricted to operator classes: ${args.operators.join(', ')}`
        : 'seeded deterministic shuffle over standard mutation-testing operators',
      restrictedToOperators: args.operators || null,
      isBlindHoldout: !args.operators,
      seed: args.seed,
      prng: 'mulberry32',
      catalogue: CATALOGUE.map(c => ({ op: c.op, label: c.label, coveredByEngine: c.coveredByEngine })),
      candidateSiteCount: sites.length,
      note: 'Sites were not chosen by hand. The catalogue includes classes the repair engine has no '
        + 'family for (AOR, UOI, SDL), so a perfect score is unreachable by construction.'
    },
    oracle: {
      command: args.testCommand,
      kind: 'upstream project test suite',
      note: 'The project\'s own suite, not tests authored here, so difficulty cannot be shaped and a '
        + 'patch cannot pass by satisfying a narrow hand-written assertion.'
    },
    repo: { path: args.repo, commit: (git(args.repo, ['rev-parse', 'HEAD']).stdout || '').trim() },
    expectedCeiling: `${accepted.filter(a => a.coveredByEngine).length}/${accepted.length} (instances whose operator class has a family)`,
    instances: accepted,
    rejectedEquivalentMutants: rejected.length
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({
    out: path.relative(ROOT, args.out).replace(/\\/g, '/'),
    seed: args.seed,
    candidateSites: sites.length,
    accepted: accepted.length,
    rejectedEquivalent: rejected.length,
    byOperator: accepted.reduce((acc, item) => { acc[item.operator] = (acc[item.operator] || 0) + 1; return acc; }, {}),
    coveredByEngine: accepted.filter(a => a.coveredByEngine).length,
    expectedCeiling: manifest.expectedCeiling,
    manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(args.out)).digest('hex')
  }, null, 2));
}

// Run as a script; importable as a module so site selection can be asserted directly. Without this the
// only way to test which lines are eligible is to generate a whole set, which costs an hour and
// validates every mutant against the suite.
if (require.main === module) {
  try { main(); } catch (error) { console.error(String(error.message || error)); process.exit(1); }
}

module.exports = { codeBearingLines, candidateSites, CATALOGUE, applyMutation };
