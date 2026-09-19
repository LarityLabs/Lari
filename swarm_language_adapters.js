'use strict';

/**
 * What Lari needs to know about a language in order to learn it.
 *
 * The repair loop has never actually been about Python. It proposes an edit, asks something whether
 * the edit is acceptable, and keeps what survives. Nothing in that depends on a language -- what
 * depends on a language is three small facts:
 *
 *   1. how to ask whether a candidate is even syntactically valid, so nonsense is rejected for free
 *   2. how to run the project's own tests, which is the judge
 *   3. which operators exist, so there is something to propose
 *
 * That is the whole adapter. Everything else -- localization, the search budget, growth, retention,
 * the honesty rules about what may be stored -- is already language-agnostic and stays untouched.
 *
 * The point is not breadth for its own sake. A defect class Lari has never seen in Python may be
 * ordinary in Go, and a rule learned in one language is a statement about an operator rather than
 * about a file, so `&& -> ||` is the same lesson wherever it is learned. Practising across languages
 * is a way of finding gaps that a single language cannot present.
 *
 * Kept deliberately thin. Each entry is a handful of facts that can be checked in a minute, not a
 * language model of the language, and an entry nobody has verified locally is marked as such rather
 * than assumed to work.
 */

const { spawnSync } = require('child_process');

/**
 * Operators grouped the way the mutation vocabulary groups them.
 *
 * Substitution within a group is what makes a proposal principled: members are interchangeable at a
 * syntax site, so swapping one for another yields code that still parses and means something else.
 */
const ADAPTERS = {
  python: {
    extensions: ['.py'],
    // Compiling is cheaper than running and rejects most of what a search proposes.
    syntaxCheck: file => `python -m py_compile "${file}"`,
    testCommand: 'python -m pytest -q -o addopts=',
    comment: '#',
    operators: {
      arithmetic: [' + ', ' - ', ' * ', ' / ', ' // ', ' % '],
      comparison: ['>=', '<=', '==', '!=', ' > ', ' < '],
      boolean: [' and ', ' or '],
      bitwise: [' & ', ' | ', ' ^ ', ' << ', ' >> '],
      unary: ['not ']
    }
  },
  javascript: {
    extensions: ['.js', '.mjs', '.cjs'],
    syntaxCheck: file => `node --check "${file}"`,
    testCommand: 'npm test --silent',
    comment: '//',
    operators: {
      arithmetic: [' + ', ' - ', ' * ', ' / ', ' % '],
      comparison: ['>=', '<=', '===', '!==', '==', '!=', ' > ', ' < '],
      boolean: [' && ', ' || '],
      bitwise: [' & ', ' | ', ' ^ ', ' << ', ' >> '],
      unary: ['!']
    }
  },
  ruby: {
    extensions: ['.rb'],
    syntaxCheck: file => `ruby -c "${file}"`,
    testCommand: 'ruby -Ilib -Itest -e "Dir.glob(\'./test/**/test_*.rb\').each { |f| require f }"',
    comment: '#',
    operators: {
      arithmetic: [' + ', ' - ', ' * ', ' / ', ' % '],
      comparison: ['>=', '<=', '==', '!=', ' > ', ' < '],
      boolean: [' && ', ' || ', ' and ', ' or '],
      bitwise: [' & ', ' | ', ' ^ ', ' << ', ' >> '],
      unary: ['!', 'not ']
    }
  },
  go: {
    extensions: ['.go'],
    // Go has no standalone syntax check, but vet parses and is fast.
    syntaxCheck: file => `go vet "${file}"`,
    testCommand: 'go test ./...',
    comment: '//',
    operators: {
      arithmetic: [' + ', ' - ', ' * ', ' / ', ' % '],
      comparison: ['>=', '<=', '==', '!=', ' > ', ' < '],
      boolean: [' && ', ' || '],
      bitwise: [' & ', ' | ', ' ^ ', ' << ', ' >> '],
      unary: ['!']
    }
  }
};

/** Which adapter handles a file. */
function adapterFor(file) {
  const lower = String(file).toLowerCase();
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.extensions.some(extension => lower.endsWith(extension))) return { name, ...adapter };
  }
  return null;
}

/**
 * Is this language usable on this machine right now?
 *
 * Asked rather than assumed, because an adapter for a toolchain that is not installed produces a run
 * where every candidate fails and the failure belongs to the harness -- the exact confusion that has
 * cost this project three training runs already.
 */
function probeToolchains(candidates = Object.keys(ADAPTERS)) {
  const versions = {
    python: 'python --version',
    javascript: 'node --version',
    ruby: 'ruby --version',
    go: 'go version'
  };
  const available = {};
  for (const name of candidates) {
    const probe = versions[name];
    if (!probe) { available[name] = { usable: false, reason: 'no version probe defined' }; continue; }
    const result = spawnSync(probe, { shell: true, encoding: 'utf8', timeout: 30000, windowsHide: true });
    available[name] = result.status === 0
      ? { usable: true, version: String(result.stdout || result.stderr).trim().split('\n')[0] }
      : { usable: false, reason: 'toolchain not found' };
  }
  return available;
}

/** A syntax check, run the way the language prefers. Invalid candidates cost nothing to reject. */
function checkSyntax(workspace, file, { timeoutMs = 30000 } = {}) {
  const adapter = adapterFor(file);
  if (!adapter) return { checked: false, passed: true, reason: 'no adapter for this file type' };
  const result = spawnSync(adapter.syntaxCheck(file), {
    cwd: workspace, shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true
  });
  return {
    checked: true,
    passed: result.status === 0,
    output: (String(result.stdout || '') + String(result.stderr || '')).slice(-600)
  };
}

/**
 * A vocabulary for a language, in the shape the repair engine already consumes.
 *
 * A rule learned here is a statement about operators, so it transfers wherever those operators mean
 * the same thing -- which is why this returns the same structure for every language rather than
 * something bespoke.
 */
function vocabularyFor(language) {
  const adapter = ADAPTERS[language];
  if (!adapter) return null;
  const pairs = group => (adapter.operators[group] || [])
    .flatMap(from => (adapter.operators[group] || []).filter(to => to !== from).map(to => [from, to]));
  return {
    'comparison-boundary': { kind: 'operator-substitution', rules: pairs('comparison') },
    'boolean-polarity': { kind: 'operator-substitution', rules: pairs('boolean') },
    'arithmetic-substitution': { kind: 'operator-substitution', rules: pairs('arithmetic') },
    'bitwise-substitution': { kind: 'operator-substitution', rules: pairs('bitwise') },
    'numeric-constant': { kind: 'numeric-constant', rules: [] }
  };
}

module.exports = { ADAPTERS, adapterFor, probeToolchains, checkSyntax, vocabularyFor };
