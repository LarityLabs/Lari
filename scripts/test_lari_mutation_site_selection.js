#!/usr/bin/env node
'use strict';

/**
 * Mutation sites must be executable code, not prose.
 *
 * Five of the twenty instances generated for the humanize transfer sets were mutations inside
 * docstrings. The measurement found them inert and dropped them silently, so both sets lost a quarter
 * of their instances and the blind set lost three of its four CRP instances -- the class the seed
 * vocabulary covers -- which moved the reported numbers in the control's disfavour.
 *
 * The old guard skipped lines *beginning* with `#`, `"""` or `'''`. A docstring's body begins with
 * neither. The five that got through:
 *
 *   number.py:217  >>> intword("1234100", "%0.3f")            doctest example
 *   time.py:393    >>> _quotient_and_remainder(36, 25, ...)   doctest example
 *   number.py:451  'under 1.0 million'                        doctest expected output
 *   time.py:134    >>> assert naturaldelta(later - now) ...   doctest example
 *   number.py:70   "... Anything else will return the output" English prose containing "return "
 *
 * The last one is the clearest statement of the problem: the generator seeded a UOI defect into an
 * English sentence because the sentence contains the word "return".
 *
 * These are asserted by line number against the pinned humanize checkout. If that repository is absent
 * the suite skips rather than fails -- an environment gap is not a regression.
 *
 * Usage: node scripts/test_lari_mutation_site_selection.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = 'C:/Users/goryg/.gemini/antigravity/scratch/lari-benchmark-repos/humanize';
const GENERATOR = path.join(__dirname, 'generate_lari_mechanical_holdout.js');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 200)}` : ''}`);
  }
}

if (!fs.existsSync(REPO)) {
  console.log(`SKIP: ${REPO} is not present. See holdouts/BENCHMARK_REPOSITORIES.json.`);
  process.exit(0);
}
if (spawnSync('python', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('SKIP: python is not available; site selection depends on tokenize.');
  process.exit(0);
}

const { codeBearingLines, candidateSites } = require(GENERATOR);

console.log('docstring interiors are not mutation sites');
{
  const cases = [
    ['src/humanize/number.py', 217, 'doctest example: >>> intword("1234100", "%0.3f")'],
    ['src/humanize/time.py', 393, 'doctest example: >>> _quotient_and_remainder(...)'],
    ['src/humanize/number.py', 451, "doctest expected output: 'under 1.0 million'"],
    ['src/humanize/time.py', 134, 'doctest example: >>> assert naturaldelta(later - now) ...'],
    ['src/humanize/number.py', 70, 'English prose containing the word "return"']
  ];
  const cache = new Map();
  for (const [rel, line, why] of cases) {
    const file = path.join(REPO, rel);
    if (!cache.has(file)) cache.set(file, codeBearingLines(file));
    const codeLines = cache.get(file);
    check(`${rel}:${line} is not code-bearing (${why})`,
      codeLines instanceof Set && !codeLines.has(line),
      codeLines instanceof Set ? 'line reported as code' : 'tokenizer returned null');
  }
}

console.log('\nreal code is still selectable, or the fix would be useless');
{
  const file = path.join(REPO, 'src/humanize/number.py');
  const codeLines = codeBearingLines(file);
  check('the tokenizer returned a set', codeLines instanceof Set);
  const text = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  // A generous sample of genuine statements must survive.
  const realCode = [];
  text.forEach((line, i) => {
    const t = line.trim();
    if (/^(?:return|if|for|while|elif)\b/.test(t) || /^[a-z_]+\s*=/.test(t)) realCode.push(i + 1);
  });
  const kept = realCode.filter(n => codeLines.has(n));
  check('most genuine statements remain selectable',
    realCode.length > 20 && kept.length / realCode.length > 0.9,
    { realCode: realCode.length, kept: kept.length });

  // And the file is not simply all-code, or the check proves nothing.
  check('some lines in the file are correctly excluded',
    codeLines.size < text.length * 0.9, { codeLines: codeLines.size, fileLines: text.length });
}

console.log('\nthe tokenizer fails loudly rather than silently accepting everything');
{
  const tmp = path.join(require('os').tmpdir(), `lari-bad-syntax-${process.pid}.py`);
  fs.writeFileSync(tmp, 'def broken(:\n    this is not python\n');
  const result = codeBearingLines(tmp);
  check('an untokenizable file returns null rather than a permissive set', result === null, result);
  fs.unlinkSync(tmp);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
