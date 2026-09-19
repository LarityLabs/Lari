'use strict';

/**
 * Generic verified mutation repair.
 *
 * Why this exists
 * ---------------
 * Lari's repair vocabulary was 20 patch kinds written as source literals
 * (`replace_subtract_with_add`, `css_primary_color_update`, ...). Each names a specific edit rather
 * than a class of edit, so a bug outside that list produced no candidate patch at all -- the
 * 20260725 holdout scored 0/4, with "no change" on every case, including one whose fix was exactly
 * the shape already retained. Nothing in the runtime could widen that list; only editing the source
 * could.
 *
 * This module replaces "which named edit do I know?" with "which principled mutation makes the real
 * tests pass?". Families describe *classes* of defect drawn from mutation-based automated program
 * repair, not individual fixes. That distinction matters: a family generalises to bugs nobody
 * anticipated, while a named patch kind only ever repeats itself.
 *
 * Nothing here is keyed to any repository, file, symbol, or test. Every candidate is proposed blind
 * and survives only by passing the project's own executable tests.
 *
 * Tractability
 * ------------
 * Each candidate costs a full test run, so mutating every site in a 2,800-line module is not
 * viable. Candidates are localized first:
 *
 *   1. Symbols the failing oracle imports. A test that does `from tabulate import _multiline_width`
 *      has told us which function it exercises. Using the oracle's own interface as the fault scope
 *      is cheap, needs no instrumentation, and works even when the failure is a plain assertion
 *      mismatch that produces no useful traceback.
 *   2. Source lines named in the failure text. When the defect raises (IndexError, ValueError), the
 *      traceback points at the line directly.
 *
 * Scope 1 is the load-bearing one; scope 2 sharpens ordering when available.
 */

const COMPARISON_OPERATORS = ['>=', '<=', '==', '!=', '>', '<'];

const AGGREGATION_FUNCTIONS = ['max', 'min', 'sum', 'len', 'any', 'all'];

const BOOLEAN_MUTATIONS = [
  { from: ' and ', to: ' or ' },
  { from: ' or ', to: ' and ' },
  { from: ' && ', to: ' || ' },
  { from: ' || ', to: ' && ' }
];

/**
 * How much wider than the verification budget the candidate pool may be when learned priors are
 * available to order it.
 *
 * Generation is free and verification is not, so the pool exists only to give the priors something
 * worth sorting. Ten covers the pools observed on real repositories (580-834 candidates for an
 * 80-run budget) without unbounded growth on a large localized region.
 */
const PRIOR_POOL_FACTOR = 10;

/**
 * How many occurrences of the same operator on one line may be mutated.
 *
 * Bounded because candidates cost oracle runs, and generous enough for real code: three covers
 * `a + b + c + d`. Repeated operators are common in width arithmetic and string building, which is
 * exactly where this engine's defects live.
 */
const MAX_OCCURRENCES_PER_LINE = 3;

/**
 * The share of the verification budget spent on prior-ordered candidates rather than authored order.
 *
 * Zero. Learned priors are still recorded, still travel with the vocabulary, and are still available
 * to any caller that passes a share -- but they are not spent by default, because nothing has ever
 * measured them winning an instance and two things have measured them losing one.
 *
 * Reachability across the burned sets, seed vocabulary against trained, at three budgets:
 *
 *     condition                    80      320     640
 *     seed vocabulary              6/30    12/30   13/30
 *     trained vocabulary, no priors 7/30   13/30   14/30
 *     trained vocabulary + priors  6-7/30  13/30   14/30
 *
 * And on the two sealed blind sets at budget 640: 460719 went 5/8 to 6/8, entirely from a grown
 * *rule* repairing an instance the seed vocabulary cannot express; 907843 went 5/8 to 4/8, entirely
 * from prior ordering pushing a candidate at position 567 out of a 640 budget.
 *
 * The two effects were shipped together and only one of them works. A wider vocabulary costs nothing
 * when no instance needs it; an ordering spends budget on every instance whether or not its evidence
 * applies. The honest reading is that priors are an unproven idea being charged to every search, so
 * they stop being charged until a measurement shows them paying.
 *
 * This is deliberately reversible and deliberately not a deletion: the statistics are real, they now
 * have honest denominators, and the compounding claim in this project depends on something like them
 * eventually working. Set a share explicitly to experiment.
 */
const PRIOR_BUDGET_SHARE = 0;

/**
 * Whether learned priors order within a localized region (true) or across the whole pool (false).
 *
 * Region-major, from the same sweep. Reachability across the burned sets, at a budget of 80:
 *
 *     ordering            all-operators  AOR-only
 *     seed, no priors           6/30       0/5
 *     trained, no priors        7/30       0/5
 *     pool-wide, share 0.5      6/30       3/5
 *     region-major, share 0.5   7/30       0/5
 *
 * Pool-wide ordering reaches more in total, but every instance it gains is on the set restricted to
 * the one class the learned rules cover, and it pays with an instance on the unrestricted sets --
 * which are the ones capability is measured on. Letting the targeted set pick the setting is how a
 * flattering number gets built, so it does not get a vote.
 *
 * The tradeoff is a budget artefact, not a principle: at a budget of 640 every ordering reaches
 * 14/30 and 3/5. Verification cost, not search order, is what is actually binding.
 */
const REGION_MAJOR_PRIORS = true;

/**
 * Operator classes, used to propose new vocabulary rather than to apply it.
 *
 * Members of a class are interchangeable at a syntax site: swapping one for another yields code that
 * still parses and means something different. That is what makes a proposal principled rather than a
 * guess, and it is how a defect class nobody anticipated can enter the vocabulary.
 */
const OPERATOR_CLASSES = {
  arithmetic: [' + ', ' - ', ' * ', ' / ', ' // ', ' % '],
  comparison: ['>=', '<=', '==', '!=', ' > ', ' < '],
  boolean: [' and ', ' or '],
  bitwise: [' & ', ' | ', ' ^ ', ' << ', ' >> '],
  aggregation: ['max(', 'min(', 'sum(', 'len(', 'any(', 'all(', 'sorted(']
};

/**
 * Where a unary `not` may be inserted or removed.
 *
 * Negation does not fit the classes above, which pair operators that can stand in for each other at
 * the same syntax site. `not` has no counterpart: it is present or it is absent. So it needs its own
 * proposal shape -- removal wherever it appears, and insertion only at anchors where Python accepts a
 * boolean expression.
 *
 * Until now Lari could not express this at all, which made an entire declared operator class
 * unreachable rather than merely unlearned: across the seven sealed sets, 4 of 46 instances are unary
 * insertions and every one of them was out of range by construction. The catalogue has said
 * `coveredByEngine: false` for UOI since the first holdout was generated, so this is a known gap being
 * closed rather than a lesson taken from a set's failures -- and it must be measured on a fresh sealed
 * set, never on one already burned.
 *
 * These are statements about Python syntax, not about any repository, and growth still has to propose
 * and verify each rule against real tests before it is retained.
 */
const UNARY_NEGATION_ANCHORS = ['return ', 'if ', 'elif ', 'while ', 'assert ', ' and ', ' or '];

/**
 * The seed vocabulary.
 *
 * This is the important structural change in the module: substitution rules are **data**, not literals
 * buried in the generator. The 20 patch kinds this module replaced were source constants, so the only
 * thing the loop could ever "learn" was which constant happened to work. Handing the vocabulary in as
 * data means a rule can be proposed at runtime, verified against real tests, retained in model state,
 * and rolled back through the existing candidate lifecycle -- the vocabulary becomes something Lari
 * has rather than something the source is.
 *
 * Callers pass their own vocabulary (from model state); this is only the starting point.
 */
const DEFAULT_VOCABULARY = {
  'comparison-boundary': {
    kind: 'operator-substitution',
    rules: COMPARISON_OPERATORS.flatMap(from =>
      COMPARISON_OPERATORS.filter(to => to !== from).map(to => [from, to]))
  },
  'aggregation-choice': {
    kind: 'operator-substitution',
    rules: AGGREGATION_FUNCTIONS.flatMap(from =>
      AGGREGATION_FUNCTIONS.filter(to => to !== from).map(to => [`${from}(`, `${to}(`]))
  },
  'boolean-polarity': {
    kind: 'operator-substitution',
    rules: BOOLEAN_MUTATIONS.map(item => [item.from, item.to])
  },
  'numeric-constant': { kind: 'numeric-constant', rules: [] },
  'guard-insertion': { kind: 'guard-insertion', rules: [] }
};

function vocabularyRules(vocabulary, family) {
  const entry = (vocabulary || DEFAULT_VOCABULARY)[family];
  return Array.isArray(entry?.rules) ? entry.rules : [];
}

/**
 * Propose substitution rules the current vocabulary cannot express.
 *
 * Reads the operators actually present in the suspicious region and, for any that no existing rule
 * uses as a left-hand side, proposes swaps to the other members of its class. So a region containing
 * floor division when nothing in the vocabulary mentions `//` yields candidate rules such as
 * `//` -> `/`.
 *
 * Every proposal is a **generic rule**, never a location. "`//` becomes `/`" is a statement about
 * operators that applies to any file; "line 47 of clip.py becomes X" would be a memorised answer, and
 * is exactly what this must not produce.
 */
function proposeVocabularyExtensions({ source, regions, vocabulary = DEFAULT_VOCABULARY, limit = 24 }) {
  const lines = String(source).split(/\r?\n/);

  // Coverage is per *substitution*, not per operator.
  //
  // This used to record only the left-hand side, so the moment any rule with `from` existed, no
  // further rule for that operator could ever be proposed. One outgoing substitution per operator,
  // permanently: having learned `+ becomes *`, Lari could never afterwards learn `+ becomes -`, and
  // the proposal step returned 29 candidates that never included it however high the limit went.
  //
  // That is a hard ceiling on the vocabulary, and it is the reason growth plateaued after the first
  // rule for each operator -- nine defects in one run needed `+ becomes -` and not one of them could
  // even be attempted. Keying on the pair lets an operator accumulate the full set of substitutions
  // its class allows, which is what "the vocabulary grows" has to mean.
  const covered = new Set();
  for (const entry of Object.values(vocabulary || {})) {
    for (const [from, to] of Array.isArray(entry?.rules) ? entry.rules : []) covered.add(`${from}=>${to}`);
  }

  const proposals = [];
  const seen = new Set();
  for (const region of regions || []) {
    for (let index = region.start; index < region.end && proposals.length < limit; index += 1) {
      const line = lines[index];
      if (!line || !line.trim() || /^\s*#/.test(line)) continue;
      for (const [className, members] of Object.entries(OPERATOR_CLASSES)) {
        for (const from of members) {
          if (!line.includes(from)) continue;
          for (const to of members) {
            if (to === from || covered.has(`${from}=>${to}`)) continue;
            const key = `${className}|${from}|${to}`;
            if (seen.has(key)) continue;
            seen.add(key);
            proposals.push({
              family: `${className}-substitution`,
              kind: 'operator-substitution',
              rule: [from, to],
              reason: `region contains "${from.trim()}", which no existing rule can substitute`
            });
          }
        }
      }

      // Unary negation, which no symmetric class can express.
      //
      // Removing a `not` is always syntactically safe where one appears. Inserting one is only safe at
      // an anchor, so insertion is proposed per anchor rather than as a bare substitution -- a rule
      // with an empty left-hand side would match everywhere and generate nonsense.
      const unary = [];
      if (line.includes('not ')) unary.push(['not ', '']);
      for (const anchor of UNARY_NEGATION_ANCHORS) {
        if (line.includes(anchor) && !line.includes(`${anchor}not `)) unary.push([anchor, `${anchor}not `]);
      }
      for (const rule of unary) {
        if (covered.has(`${rule[0]}=>${rule[1]}`)) continue;
        const key = `unary|${rule[0]}|${rule[1]}`;
        if (seen.has(key) || proposals.length >= limit) continue;
        seen.add(key);
        proposals.push({
          family: 'unary-negation',
          kind: 'operator-substitution',
          rule,
          reason: rule[1] === ''
            ? 'region contains a unary "not" that no existing rule can remove'
            : `region contains "${rule[0].trim()}", where a unary "not" could be missing`
        });
      }
    }
  }
  return proposals.slice(0, limit);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Symbols a test pulls out of the project, in import order.
 *
 * Handles `from x import a, b`, `from x import (a, b)`, and JS `const { a, b } = require('x')`.
 * Deliberately ignores the module path: we want the names being exercised, not where they live.
 */
function importedSymbols(testSource = '') {
  const text = String(testSource);
  const symbols = [];

  // Parenthesised imports span lines:
  //     from wcwidth.sgr_state import (_SGR_STATE_DEFAULT,
  //                                    _parse_extended_color)
  // Matching only to the first newline captured almost nothing and was a direct cause of scope
  // collapsing to the whole file. Consume the full parenthesised clause, and backslash continuations.
  const pythonFrom = /^[ \t]*from\s+[.\w]+\s+import\s+(\([\s\S]*?\)|(?:[^\n#(]|\\\n)+)/gm;
  for (const match of text.matchAll(pythonFrom)) {
    const clause = match[1].replace(/[()\\]/g, ' ');
    for (const piece of clause.split(',')) {
      const name = piece.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== '*') symbols.push(name);
    }
  }

  const jsDestructured = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(/g;
  for (const match of text.matchAll(jsDestructured)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(':').pop().trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) symbols.push(name);
    }
  }

  return uniqueStrings(symbols);
}

/**
 * Test files and test names named as failing in a suite's output.
 *
 * This is the localization signal that was missing when the engine scored 0/6 on the mechanical test
 * set. A focused per-bug oracle hands over its imports directly, but a whole project suite does not --
 * and the traceback for an assertion failure names only the test file, never the source under repair.
 * So scope collapsed to the entire file and a bounded budget was spent nowhere near the defect.
 *
 * pytest does however report `FAILED tests/test_sgr_state.py::test_sgr_state_color_override`. Reading
 * the named test files recovers exactly the import-based scoping that works elsewhere, and the test
 * *names* carry a further hint: test_sgr_state_color_override points at colour-override handling.
 *
 * Handles pytest FAILED/ERROR lines and unittest's "(module.Class.test_name)" form.
 */
/**
 * Test targets to re-run when checking a candidate: pytest node ids, or files when collection failed.
 *
 * Three callers derived these independently with `/^FAILED\s+(\S+)/`, which silently discards a whole
 * class of defect. A mutation like `'a' + 'b'` becoming `'a' - 'b'` raises TypeError at import, so
 * pytest never collects a test and reports `ERROR test_x.py - TypeError...` with no FAILED line at
 * all. Measured on inflection: 10 of 17 sampled mutants fail this way, and the growth curriculum
 * discarded 147 of 250 practice defects for exactly this reason -- including the ones that teach the
 * arithmetic rules the vocabulary is missing.
 *
 * A collection error names a file rather than a test, which is a valid pytest target and the most
 * specific one available. Parameterised ids are stripped because ANSI escapes and brackets do not
 * survive being passed back through a shell.
 */
function failingTestTargets(failureText = '', limit = 12) {
  const text = String(failureText);
  const ids = [...text.matchAll(/^FAILED\s+(\S+)/gm)].map(match => match[1].replace(/\[.*$/, ''));
  // Only consult collection errors when nothing failed outright: if real tests failed, they are the
  // sharper signal, and a whole errored file would just widen what stage 1 has to run.
  if (!ids.length) {
    ids.push(...[...text.matchAll(/^ERROR\s+(\S+)/gm)].map(match => match[1].replace(/\[.*$/, '')));
  }
  return uniqueStrings(ids).slice(0, limit);
}

function failingTestReferences(failureText = '') {
  const text = String(failureText);
  const files = [];
  const names = [];

  for (const match of text.matchAll(/^(?:FAILED|ERROR)\s+([^\s:]+\.py)(?:::([^\s:]+))?/gm)) {
    files.push(match[1].replace(/\\/g, '/'));
    if (match[2]) names.push(match[2].replace(/\[.*$/, ''));
  }
  // unittest style: "FAIL: test_thing (package.module.TestCase)"
  for (const match of text.matchAll(/^(?:FAIL|ERROR):\s+(\w+)\s+\(([\w.]+)\)/gm)) {
    names.push(match[1]);
  }

  return { files: uniqueStrings(files), names: uniqueStrings(names) };
}

/**
 * Line numbers (1-based) of the target file that appear in a failure trace.
 * Only lines attributed to the file under repair are useful; test-file frames are noise.
 */
function tracebackLines(failureText = '', targetRelative = '') {
  if (!failureText || !targetRelative) return [];
  const base = String(targetRelative).split(/[\\/]/).pop();
  if (!base) return [];
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}"?,\\s*line\\s+(\\d+)`, 'gi');
  const lines = [];
  for (const match of String(failureText).matchAll(pattern)) {
    const line = Number(match[1]);
    if (Number.isInteger(line) && line > 0) lines.push(line);
  }
  return uniqueStrings(lines.map(String)).map(Number);
}

/**
 * Line ranges worth mutating, most likely first.
 *
 * A definition's body runs from its `def`/`class`/`function` line until indentation returns to the
 * definition's own level. That is a coarse but reliable block finder for Python and adequate for JS
 * bodies, and it avoids taking a parser dependency.
 */
function localizeRegions({ source, testSource = '', failureText = '', targetRelative = '', testNames = [], coveredLines = [] }) {
  const lines = String(source).split(/\r?\n/);

  // Spectrum (coverage-based) localization, when the caller can supply it.
  //
  // This is the signal that import-and-name heuristics could not replace. Those heuristics failed on
  // two independently seeded test sets: they narrowed scope from a whole file to a handful of
  // candidates, but to the wrong region, and they say nothing at all about module-level code where no
  // definition encloses the defect. Lines actually executed by the failing tests are direct evidence,
  // not inference -- on wcwidth this is 88 lines of 516, with the defect inside.
  //
  // Contiguous runs are merged so a candidate site keeps a little surrounding context.
  const covered = [...new Set((Array.isArray(coveredLines) ? coveredLines : [])
    .map(Number).filter(line => Number.isInteger(line) && line > 0))].sort((a, b) => a - b);
  const coverageRegions = [];
  for (const line of covered) {
    const last = coverageRegions[coverageRegions.length - 1];
    if (last && line <= last.end + 2) last.end = Math.min(lines.length, line + 1);
    else coverageRegions.push({ start: Math.max(0, line - 1), end: Math.min(lines.length, line + 1) });
  }
  // Failing test names are a second scoping signal: test_sgr_state_color_override points at
  // colour-override handling. Weaker than an import, so these are appended after imported symbols and
  // only take effect when a token actually matches a definition in this file.
  const nameHints = uniqueStrings(
    (Array.isArray(testNames) ? testNames : [])
      .flatMap(name => String(name).replace(/^test_?/, '').split(/[^A-Za-z0-9]+/))
      .filter(token => token.length > 3)
  );
  const importedNames = importedSymbols(testSource);
  const regions = [];

  // An import names an exact symbol, so it is matched exactly. A test name only hints, so it is
  // matched as a substring -- otherwise "parse", drawn from test_sgr_state_parse_colors, fails to
  // reach `_parse_extended_color` purely because of the leading underscore, which is how a defect on
  // line 201 stayed outside every region.
  const definitionOf = (symbol, { fuzzy = false } = {}) => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = fuzzy
      ? new RegExp(`^([ \\t]*)(?:async\\s+)?(?:def|class|function)\\s+\\w*${escaped}\\w*\\b`, 'i')
      : new RegExp(`^([ \\t]*)(?:async\\s+)?(?:def|class|function)\\s+${escaped}\\b`);
    for (let index = 0; index < lines.length; index += 1) {
      const match = declaration.exec(lines[index]);
      if (!match) continue;
      const indent = match[1].length;

      // Consume a wrapped signature before measuring body indentation. In
      //     def _parse_extended_color(
      //         params: ..., base: int
      //     ) -> tuple[int, ...] | None:
      // the closing line sits at the definition's own indent, so an indent-only scan ends the block
      // after two lines and the body -- where the defect actually is -- falls outside every region.
      let cursor = index;
      let depth = 0;
      while (cursor < lines.length) {
        for (const char of lines[cursor]) {
          if (char === '(' || char === '[') depth += 1;
          else if (char === ')' || char === ']') depth -= 1;
        }
        if (depth <= 0 && /:\s*(?:#.*)?$/.test(lines[cursor])) break;
        cursor += 1;
      }

      let end = cursor + 1;
      while (end < lines.length) {
        const line = lines[end];
        if (line.trim() && (line.length - line.trimStart().length) <= indent) break;
        end += 1;
      }
      return { start: index, end, symbol };
    }
    return null;
  };

  for (const region of coverageRegions) {
    regions.push({ ...region, symbol: null, reason: 'executed by failing tests' });
  }

  for (const symbol of importedNames) {
    const region = definitionOf(symbol);
    if (region) regions.push({ ...region, reason: `oracle imports ${symbol}` });
  }
  for (const hint of nameHints) {
    const region = definitionOf(hint, { fuzzy: true });
    if (region && !regions.some(existing => existing.start === region.start)) {
      regions.push({ ...region, reason: `failing test name mentions ${hint}` });
    }
  }

  // Traceback frames get a tight window; they point almost exactly at the defect.
  for (const line of tracebackLines(failureText, targetRelative)) {
    const start = Math.max(0, line - 4);
    const end = Math.min(lines.length, line + 3);
    regions.push({ start, end, symbol: null, reason: `failure trace line ${line}` });
  }

  if (!regions.length) return [{ start: 0, end: lines.length, symbol: null, reason: 'whole file' }];

  // Order by how specific the signal is, because the candidate budget is spent in this order and a
  // region reached seventh may never be reached at all.
  //
  //   1. failure trace  - names the line directly
  //   2. failing test name - "test_sgr_state_color_override" points at colour handling specifically
  //   3. imported symbol - the test file imports many symbols; most are irrelevant to this failure
  //
  // Ranking imports above test-name hints put the region containing the defect seventh in line and
  // the budget ran out before reaching it, which read as a repair failure rather than a search-order
  // problem. Within a tier, smaller regions first.
  const specificity = region => {
    if (region.reason.startsWith('executed by failing tests')) return 0;
    if (region.reason.startsWith('failure trace')) return 1;
    if (region.reason.startsWith('failing test name')) return 2;
    if (region.reason.startsWith('oracle imports')) return 3;
    return 4;
  };
  return regions.sort((left, right) =>
    specificity(left) - specificity(right)
    || (left.end - left.start) - (right.end - right.start));
}

/**
 * Replace a whole number on a line, leaving numbers that are part of a larger token alone.
 *
 * `0xFE0E`, `utf8`, `x2` and `1_000` all contain digits that are not constants in their own right.
 * Substituting into them produces code that does not parse or does not mean what the family claims,
 * which is a wasted oracle run at best and an unattributable failure at worst.
 */
function replaceNumberOnLine(lines, lineIndex, number, replacement, occurrence = 0) {
  const line = lines[lineIndex];
  if (typeof line !== 'string') return null;
  const pattern = new RegExp(`(?<![\\w.])${number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.])`, 'g');
  let seen = -1;
  let result = null;
  line.replace(pattern, (matched, offset) => {
    seen += 1;
    if (seen === occurrence && result === null) {
      result = line.slice(0, offset) + replacement + line.slice(offset + matched.length);
    }
    return matched;
  });
  if (result === null) return null;
  const copy = lines.slice();
  copy[lineIndex] = result;
  return copy;
}

function replaceOnLine(lines, lineIndex, from, to, occurrence = 0) {
  const line = lines[lineIndex];
  let seen = -1;
  let cursor = 0;
  while (cursor <= line.length) {
    const found = line.indexOf(from, cursor);
    if (found === -1) return null;
    seen += 1;
    if (seen === occurrence) {
      const mutated = line.slice(0, found) + to + line.slice(found + from.length);
      const copy = lines.slice();
      copy[lineIndex] = mutated;
      return copy;
    }
    cursor = found + 1;
  }
  return null;
}

/**
 * Propose mutations within the localized regions.
 *
 * Families, each a defect class rather than a specific fix:
 *   comparison-boundary  - an off-by-one in a relational test
 *   aggregation-choice   - the wrong reducer over a collection
 *   guard-insertion      - an access that assumes non-emptiness
 *   numeric-constant     - a wrong magnitude or threshold
 *   boolean-polarity     - inverted connective
 */
/**
 * `onlyFamilies` restricts generation to specific families.
 *
 * Used when testing whether a newly proposed rule helps. Without it, each proposal re-generates every
 * seed candidate as well, so twelve proposals re-test roughly 480 already-known-failing mutations --
 * measured at 4035 seconds for a single instance. Testing a new rule should cost only that rule's
 * candidates.
 */
function generateCandidates({
  source, language = 'python', regions, limit = 240,
  vocabulary = DEFAULT_VOCABULARY, onlyFamilies = null, failureText = '', projectSources = null
}) {
  const familyFilter = Array.isArray(onlyFamilies) && onlyFamilies.length ? new Set(onlyFamilies) : null;
  const lines = String(source).split(/\r?\n/);
  const candidates = [];
  const seen = new Set();
  const isPython = language !== 'javascript';

  // Which region a candidate came from. Regions arrive narrowest-first, so this is a rank of how
  // specific the evidence for that line was -- the only per-defect signal the search has, and worth
  // preserving when anything else reorders the list.
  let regionIndex = 0;

  const push = (nextLines, family, description, lineIndex) => {
    if (candidates.length >= limit) return;
    const patched = nextLines.join('\n');
    if (patched === source || seen.has(patched)) return;
    if (familyFilter && !familyFilter.has(family)) return;
    seen.add(patched);
    candidates.push({ family, description, line: lineIndex + 1, source: patched, regionIndex });
  };

  for (const [ordinal, region] of regions.entries()) {
    regionIndex = ordinal;
    for (let index = region.start; index < region.end && candidates.length < limit; index += 1) {
      const line = lines[index];
      if (!line || !line.trim() || /^\s*#/.test(line)) continue;

      // Every operator-substitution family is driven by vocabulary data, so a rule proposed and
      // retained at runtime participates on exactly the same footing as a seed rule. This is what
      // makes the vocabulary something Lari has rather than something the source is.
      for (const [family, entry] of Object.entries(vocabulary || DEFAULT_VOCABULARY)) {
        if (entry?.kind !== 'operator-substitution') continue;
        for (const [from, to] of vocabularyRules(vocabulary, family)) {
          if (!line.includes(from)) continue;
          const bare = from.trim();
          // Avoid rewriting '>=' by matching the '>' inside it, and similar overlaps.
          if (bare.length === 1 && new RegExp(`[<>=!]\\${bare}|\\${bare}=`).test(line)) continue;
          // Every occurrence, not just the first.
          //
          // `replaceOnLine` has always taken an occurrence index and this loop never passed one, so a
          // line containing the same operator twice could only ever be mutated at its first instance.
          // Measured on tabulate: the defect at __init__.py:166 seeds
          //     return ":" + ("=" * (width - 1))   ->   return ":" + ("=" + (width - 1))
          // whose repair must rewrite the *second* `+`. The candidate was never generated, so the
          // search exhausted, growth proposed the correct rule, and the proposal failed too -- five
          // such defects in one curriculum run, all of them looking like a growth failure.
          //
          // The description stays the substitution direction, so what is retained is still a rule
          // about operators and never a position.
          for (let occurrence = 0; occurrence < MAX_OCCURRENCES_PER_LINE; occurrence += 1) {
            const next = replaceOnLine(lines, index, from, to, occurrence);
            if (!next) break;
            push(next, family, `${bare} -> ${to.trim()}`, index);
          }
        }
      }

      // numeric-constant
      //
      // Found with a word-bounded regex and, until now, replaced with a plain substring swap -- so a
      // line containing `0xFE0E` had the `0` of the hex literal rewritten and the candidate became
      // `1xFE0E`, which does not parse. Every such candidate is a wasted oracle run, and the
      // unparseable module made pytest fail in a way the client could not distinguish from the oracle
      // being broken. The replacement has to respect the same boundaries the search does.
      for (const match of uniqueStrings([...line.matchAll(/\b(\d{1,4})\b/g)].map(item => item[1]))) {
        const value = Number(match);
        for (const replacement of uniqueStrings([value + 1, value - 1, value * 10, value / 10, 0, 1]
          .filter(candidate => Number.isInteger(candidate) && candidate >= 0 && candidate !== value)
          .map(String))) {
          for (let occurrence = 0; occurrence < MAX_OCCURRENCES_PER_LINE; occurrence += 1) {
            const next = replaceNumberOnLine(lines, index, match, replacement, occurrence);
            if (!next) break;
            push(next, 'numeric-constant', `${match} -> ${replacement}`, index);
          }
        }
      }

      // guard-insertion: an indexed access that assumes the container is non-empty.
      const indexed = /([A-Za-z_$][A-Za-z0-9_$.]*)\s*\[\s*0\s*\]/.exec(line);
      if (indexed) {
        const container = indexed[1];
        const guard = isPython ? `bool(${container}) and ` : `Boolean(${container}) && `;
        if (!line.includes(guard)) {
          // Guard the smallest enclosing expression we can identify safely: the call or comparison
          // that consumes the indexed access.
          const consumer = new RegExp(`([A-Za-z_$][A-Za-z0-9_$.]*\\s*\\(\\s*)?${container.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\[\\s*0\\s*\\]`);
          const anchor = consumer.exec(line);
          if (anchor) {
            const callMatch = new RegExp(`([A-Za-z_$][A-Za-z0-9_$.]*\\(\\s*${container.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\[\\s*0\\s*\\][^)]*\\))`).exec(line);
            const target = callMatch ? callMatch[1] : `${container}[0]`;
            const next = replaceOnLine(lines, index, target, `${guard}${target}`);
            if (next) push(next, 'guard-insertion', `guard ${container} before indexing`, index);
          }
        }
      }
    }
  }

  // statement-insertion: a statement is missing, and the one that is missing is usually still in the
  // file.
  //
  // Every family above rewrites something that is present. Deletion is the one defect class where the
  // fix is not a rewrite but a restoration, and it is the largest gap this engine has: statement
  // deletion is 30% of every sealed instance and has always scored zero, because nothing could
  // express it.
  //
  // Inventing the missing line is not tractable. Finding it usually is. Measured across the 20 SDL
  // instances in this repository's sealed sets, the deleted statement appears *verbatim elsewhere in
  // the same file* in 13 of them, and 18 of 20 have some other statement assigning the same name.
  // That is the redundancy assumption from the automated-repair literature, and here it holds at 65%.
  // So candidates are drawn from the file's own statements rather than synthesized.
  //
  // The search space is the product of donors and positions, which is far too large to enumerate, so
  // it is ranked by evidence rather than truncated by luck. Every SDL instance measured was an
  // assignment, which means a deletion leaves a name unbound -- and the failure usually says which
  // one. A donor that assigns a name the failure complains about is tried before anything else.
  if (!familyFilter || familyFilter.has('statement-insertion')) {
    const undefinedNames = new Set(
      [...String(failureText).matchAll(/NameError:\s+(?:local variable|name)\s+'([A-Za-z_]\w*)'/g)]
        .map(match => match[1])
        .concat([...String(failureText).matchAll(/UnboundLocalError:.*?'([A-Za-z_]\w*)'/g)].map(m => m[1]))
    );

    // Donor statements: distinct, single-line, self-contained.
    //
    // Drawn from the file first and from the rest of the project second. Widening to the project is
    // what makes this a general capability rather than a same-file trick -- the missing line may have
    // a sibling in another module, and code in one repository tends to repeat its own idioms. It also
    // multiplies the search space by the size of the codebase, so a project donor is only admitted
    // when it binds a name the failure actually complains about. Evidence buys the extra reach;
    // without it, the pool stays local.
    const donors = new Map();
    // A file with no executable statements is a stub being built, not a program being repaired.
    const targetIsStub = lines.filter(line => {
      const t = line.trim();
      return t && !t.startsWith('#') && !/^(?:"""|''')/.test(t);
    }).length <= 1;

    const admit = (trimmed, origin) => {
      if (!trimmed || trimmed.length > 120) return;
      if (/^(?:#|"""|'''|@|def |class |import |from |return\b|pass\b|else:|try:|elif |except)/.test(trimmed)) return;
      if (/[:\\]$/.test(trimmed)) return;              // block openers and continuations need a body
      const assigned = (trimmed.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*=[^=]/) || [])[1];
      // Project donors normally need the failure to name what is missing, because the whole codebase
      // is far too large a pool to admit on a hunch. A file with essentially no code in it is the
      // exception: there is nothing to localize against and nothing to lose, so everything is a
      // plausible ingredient. This is what lets a build start from a stub, where the failure is
      // "expected 3, got nothing" and names no code at all.
      if (origin === 'project' && !targetIsStub && !(assigned && undefinedNames.has(assigned))) return;
      if (!donors.has(trimmed)) donors.set(trimmed, { text: trimmed, assigned: assigned || null, origin });
    };

    for (const line of lines) admit(line.trim(), 'file');
    for (const text of Object.values(projectSources || {})) {
      for (const line of String(text).split(/\r?\n/)) admit(line.trim(), 'project');
    }

    // Whole definitions, for when what is missing is not a line but a function.
    //
    // Single statements repair deletions; they cannot build. A failure that says a name cannot be
    // imported is not asking for a line, it is asking for a definition, and the same redundancy
    // argument applies one level up: a codebase that needs a function usually contains one shaped like
    // it. So function blocks are lifted from the project and renamed to the symbol the failure says is
    // missing -- a generic transformation, keyed to nothing, and worth exactly as much as the tests say
    // it is.
    const missingSymbols = new Set([
      ...[...String(failureText).matchAll(/cannot import name '([A-Za-z_]\w*)'/g)].map(m => m[1]),
      ...[...String(failureText).matchAll(/has no attribute '([A-Za-z_]\w*)'/g)].map(m => m[1]),
      ...undefinedNames
    ]);
    const blockDonors = [];
    if (missingSymbols.size || targetIsStub) {
      for (const text of Object.values(projectSources || {})) {
        const donorLines = String(text).split(/\r?\n/);
        for (let start = 0; start < donorLines.length; start += 1) {
          const header = donorLines[start].match(/^(\s*)def\s+([A-Za-z_]\w*)\s*\(/);
          if (!header) continue;
          const indent = header[1];
          let end = start + 1;
          while (end < donorLines.length) {
            const line = donorLines[end];
            if (line.trim() && !line.startsWith(indent + ' ') && !line.startsWith(indent + '\t')) break;
            end += 1;
          }
          const block = donorLines.slice(start, end).join('\n').replace(/\s+$/, '');
          if (!block || block.split('\n').length > 40) continue;
          for (const symbol of (missingSymbols.size ? missingSymbols : [null])) {
            blockDonors.push({
              text: block.replace(/^(\s*def\s+)[A-Za-z_]\w*/, `$1${symbol}`),
              assigned: symbol,
              origin: 'project-definition'
            });
          }
        }
      }
    }

    // Score whole (site, donor) pairs rather than looping positions inside donors.
    //
    // Nesting the loops ranks by position first, so every weak donor at an early line outranks the
    // right donor at the right line: on a fixture whose failure named the missing variable outright,
    // the correct restoration came out 14th. Evidence has to outrank position, which means the pair is
    // the unit being ordered.
    const placements = [];
    for (const [ordinal, region] of (regions || []).entries()) {
      for (let index = region.start; index < region.end; index += 1) {
        const line = lines[index];
        if (line === undefined) continue;
        const trimmed = line.trim();
        // A bare `pass` is where a statement most often went missing -- in this engine's own mutants
        // and in real stubbed-out code alike -- so it is a replacement site rather than an insertion
        // point, and a far better bet than any other line.
        const isStub = /^pass\b/.test(trimmed);
        if (!isStub && !trimmed) continue;
        placements.push({ index, isStub, indent: (line.match(/^\s*/) || [''])[0], trimmed, ordinal });
      }
    }

    // A definition has nowhere natural to go inside a stub, so the end of the file is also a site.
    if (blockDonors.length || targetIsStub) {
      placements.push({ index: lines.length, isStub: false, indent: '', trimmed: '', ordinal: 0, append: true });
    }

    const pairs = [];
    for (const placement of placements) {
      for (const donor of [...donors.values(), ...blockDonors]) {
        if (donor.text === placement.trimmed) continue;
        const namesTheGap = donor.assigned && undefinedNames.has(donor.assigned);
        pairs.push({
          placement,
          donor,
          // A stub is where a statement is missing; a donor binding the name the failure complains
          // about is what is missing. Together they are the only real evidence available, and they
          // dominate proximity, which is a guess.
          score: (placement.append && donor.origin === 'project-definition' ? 9 : 0)
            + (placement.isStub ? 8 : 0)
            + (namesTheGap ? 6 : 0)
            + (donor.assigned ? 1 : 0)
            + (donor.origin === 'file' ? 0.5 : 0)
            - (placement.ordinal * 0.01)
        });
      }
    }
    pairs.sort((left, right) => right.score - left.score);

    for (const pair of pairs) {
      if (candidates.length >= limit) break;
      regionIndex = pair.placement.ordinal;
      const next = lines.slice();
      // A lifted definition carries its own indentation; a single statement takes the site's.
      const isDefinition = pair.donor.origin === 'project-definition';
      const statement = isDefinition ? pair.donor.text : pair.placement.indent + pair.donor.text;
      if (pair.placement.append) next.push('', statement);
      else if (pair.placement.isStub) next[pair.placement.index] = statement;
      else next.splice(pair.placement.index, 0, statement);
      push(next, 'statement-insertion',
        isDefinition
          ? `supply a definition of ${pair.donor.assigned}`
          : `restore ${pair.donor.assigned ? `assignment to ${pair.donor.assigned}` : 'statement'}`,
        pair.placement.index);
    }
  }

  return candidates;
}

/**
 * Propose a new semantic primitive when an output-producing formatter has dropped contextual state.
 *
 * Unlike the token substitution vocabulary, this primitive composes two relations already visible
 * in the program: an output sequence produced by a formatter and a zero-argument context accessor
 * named by the defect report. The report supplies only a semantic concept (for example, "bias" or
 * "origin"); the accessor name and every insertion site are derived at runtime. No repository,
 * symbol, line, benchmark, or expected answer is stored in the primitive.
 */
function proposeContextRestorationCandidates({ issueText = '', projectSources = {}, primaryRelative = '', limit = 12 }) {
  const sources = projectSources && typeof projectSources === 'object' ? projectSources : {};
  const words = String(issueText || '').toLowerCase().match(/[a-z][a-z0-9_]{2,30}/g) || [];
  const stop = new Set([
    'about', 'after', 'again', 'also', 'because', 'before', 'being', 'created', 'creates', 'following',
    'from', 'have', 'into', 'large', 'legend', 'mentioned', 'numbers', 'only', 'order', 'other',
    'plot', 'reproduces', 'safely', 'settings', 'should', 'that', 'their', 'these', 'this', 'using',
    'the', 'value', 'values', 'which', 'with', 'without', 'wrong'
  ]);
  const cue = /(?:drop|dropped|missing|omit|omitted|offset|context|retrieve|restor|preserv|not\s+using)/i;
  const counts = new Map();
  for (const word of words) {
    if (stop.has(word) || /^\d/.test(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  const cueWindows = [...String(issueText || '').matchAll(/.{0,50}(?:drop(?:ped)?|miss(?:ing)?|omit(?:ted)?|retriev(?:e|ed)|not\s+using|without).{0,80}/gi)]
    .flatMap(match => String(match[0]).toLowerCase().match(/[a-z][a-z0-9_]{2,30}/g) || []);
  for (const word of cueWindows) {
    if (!stop.has(word)) counts.set(word, (counts.get(word) || 0) + 4);
  }
  if (!cue.test(issueText)) return [];
  const concepts = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([word]) => word.endsWith('s') && !/(?:ss|us|is|as)$/.test(word) ? word.slice(0, -1) : word);

  const findSites = (source, relative) => {
    const lines = String(source).split(/\r?\n/);
    const sites = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      let match = /^(\s*)([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.(?:format|render|serializ)[A-Za-z_]*\([^\n]*\)\s*$/.exec(line);
      if (match) {
        sites.push({ relative, index, indent: match[1], output: match[2], receiver: match[3] });
        continue;
      }
      match = /^(\s*)([A-Za-z_]\w*)\s*=\s*\[\s*([A-Za-z_]\w*)\([^\]]+\)\s+for\s+[^\]]+\]\s*$/.exec(line);
      if (match && new RegExp(`\\b${match[3]}\\s*=\\s*[^\\n]*(?:Formatter|formatter)`, 'i').test(lines.slice(Math.max(0, index - 30), index).join('\n'))) {
        sites.push({ relative, index, indent: match[1], output: match[2], receiver: match[3] });
      }
    }
    return sites;
  };

  const primarySource = String(sources[primaryRelative] || '');
  const formatterTypes = [...new Set([
    ...[...primarySource.matchAll(/^\s*class\s+([A-Za-z_]\w*)\b/gm)].map(match => match[1]),
    ...[...primarySource.matchAll(/\b([A-Za-z_]\w*(?:Formatter|Renderer|Serializer|Encoder|Decoder|Printer|Writer))\b/g)].map(match => match[1])
  ])];
  const relatedToPrimary = (relative, source) => relative === primaryRelative
    || formatterTypes.some(type => new RegExp(`\\b${type}\\b`).test(source));
  const allSites = Object.entries(sources)
    .filter(([relative, source]) => /\.py$/i.test(relative)
      && !/(?:^|\/)(?:tests?|specs?)(?:\/|$)|(?:^|\/)test_[^/]+\.py$/i.test(relative)
      && /format|render|serializ/i.test(source)
      && relatedToPrimary(relative, source))
    .flatMap(([relative, source]) => findSites(source, relative))
    .slice(0, 12);
  if (!allSites.length || !concepts.length) return [];

  const modes = [
    { id: 'numeric_add_each', expression: '_lari_item + _lari_context_value' },
    { id: 'numeric_multiply_each', expression: '_lari_item * _lari_context_value' },
    { id: 'string_prefix_each', expression: '_lari_context_text + str(_lari_item)' },
    { id: 'string_suffix_each', expression: 'str(_lari_item) + _lari_context_text' }
  ];
  const candidates = [];
  for (const concept of concepts) {
    const accessor = `get_${concept}`;
    for (const mode of modes) {
      const patches = [];
      for (const [relative, original] of Object.entries(sources)) {
        const sites = allSites.filter(site => site.relative === relative);
        if (!sites.length) continue;
        const lines = String(original).split(/\r?\n/);
        for (const site of [...sites].sort((left, right) => right.index - left.index)) {
          const i = site.indent;
          const common = [
            `${i}try:`,
            `${i}    _lari_context = ${site.receiver}.${accessor}()`,
            `${i}    if _lari_context:`,
            `${i}        _lari_context_text = str(_lari_context).replace("−", "-")`,
            `${i}        _lari_context_value = float(_lari_context_text)`,
            `${i}        ${site.output} = [str(${mode.expression}) for _lari_item in map(float, ${site.output})]`,
            `${i}except (AttributeError, TypeError, ValueError):`,
            `${i}    pass`
          ];
          lines.splice(site.index + 1, 0, ...common);
        }
        patches.push({ path: relative, source: lines.join('\n') });
      }
      candidates.push({
        family: 'context-accessor-output-composition',
        description: `${mode.id} through inferred ${accessor}`,
        primitive: {
          kind: 'context-accessor-output-composition',
          accessorTemplate: 'get_{issue_concept}',
          outputShape: 'numeric_sequence',
          composition: mode.id
        },
        inferredConcept: concept,
        accessor,
        patches
      });
      if (candidates.length >= limit) return candidates;
    }
  }
  return candidates;
}

/**
 * Propose edits to a prefix-predicate domain from literals present in the issue and failing oracle.
 *
 * This is a semantic set edit, not a repository patch template.  A predicate such as
 * `value.startswith("*")` represents a set of rejected prefixes.  When evidence names another
 * boundary value, the missing operation may be to add, remove, or replace a member of that set.
 * Candidate locations and members are derived anew for every failure and only an executable
 * fail-before/pass-after result may retain the primitive.
 */
function proposePrefixDomainCandidates({ issueText = '', projectSources = {}, primaryRelative = '', limit = 24 }) {
  const evidence = String(issueText || '');
  const sources = projectSources && typeof projectSources === 'object' ? projectSources : {};
  const hints = new Set();
  const domainHints = new Set();

  // A malformed URL often exposes the relevant prefix at the start of its host.  Keep only the
  // boundary punctuation, never the URL or hostname itself.
  for (const match of evidence.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/`'"<>]+)/gi)) {
    const host = String(match[1] || '').replace(/^[^@]*@/, '');
    if (host && /[^A-Za-z0-9]/.test(host[0])) hints.add(host[0]);
  }
  // Short quoted command-line switches and punctuation tokens are useful boundary evidence too.
  for (const match of evidence.matchAll(/[`'"]([^`'"\r\n]{1,24})[`'"]/g)) {
    const value = match[1];
    domainHints.add({ value, raw: JSON.stringify(value) });
    if (/^(?:--?[^\s]+|[^A-Za-z0-9\s])/.test(value)) hints.add(value);
  }
  // Structured issue examples frequently expose a domain member as a field label rather than a
  // quoted literal (for example `Returns:`). Treat those labels as evidence; verification still
  // decides whether any proposed membership expansion is valid.
  for (const match of evidence.matchAll(/^[ \t]*([A-Za-z][A-Za-z0-9_-]{1,23}):[ \t]*(?:$|\S)/gm)) {
    const value = match[1];
    domainHints.add({ value, raw: JSON.stringify(value) });
    if (value !== value.toLowerCase()) domainHints.add({ value: value.toLowerCase(), raw: JSON.stringify(value.toLowerCase()) });
  }
  if (/\bNone\b/.test(evidence)) domainHints.add({ value: 'None', raw: 'None' });
  // Pytest parameter ids and tracebacks may show the same values without quotes.
  for (const match of evidence.matchAll(/(?:^|[\s[(])(--?[A-Za-z][A-Za-z0-9_-]*)\b/gm)) hints.add(match[1]);
  const hintList = [...hints].filter(value => value.length <= 24).slice(0, 16);

  const issueWords = new Set((evidence.toLowerCase().match(/[a-z_][a-z0-9_]{2,30}/g) || [])
    .filter(word => !['that', 'this', 'with', 'from', 'when', 'then', 'into', 'instead', 'result'].includes(word)));
  const expectedBoundaryTypes = [...new Set(evidence.match(/\b[A-Z][A-Za-z0-9_]*(?:Error|Exception|URL)\b/g) || [])];
  const prefixIntent = /\b(?:url|uri|host|hostname|prefix|starts?|begins?|scheme)\b/i.test(evidence);
  const sites = [];
  for (const [relative, original] of Object.entries(sources)) {
    if (!/\.py$/i.test(relative)
      || /(?:^|\/)(?:tests?|specs?)(?:\/|$)|(?:^|\/)test_[^/]+\.py$/i.test(relative)) continue;
    const lines = String(original).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const call = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.startswith\(([^\n]+)\)/.exec(line);
      if (!call) continue;
      const literals = [];
      const literalPattern = /((?:[rubfRUBF]{0,2})?)(['"])((?:\\.|(?!\2).)*)\2/g;
      for (const match of call[2].matchAll(literalPattern)) {
        literals.push({ raw: match[0], prefix: match[1], quote: match[2], value: match[3] });
      }
      if (!literals.length) continue;
      const window = lines.slice(Math.max(0, index - 12), Math.min(lines.length, index + 13)).join('\n').toLowerCase();
      let score = issueWords.has(call[1].split('.').pop().toLowerCase()) ? 8 : 0;
      for (const word of issueWords) if (window.includes(word)) score += 1;
      for (const type of expectedBoundaryTypes) if (new RegExp(`\\b${type}\\b`).test(lines.slice(Math.max(0, index - 12), Math.min(lines.length, index + 13)).join('\n'))) score += 32;
      if (/invalid|error|reject|raise|validat/.test(window) && /invalid|error|reject|raise|validat/i.test(evidence)) score += 8;
      sites.push({ relative, original: String(original), lines, index, line, argument: call[2], literals, score });
    }
  }
  sites.sort((left, right) => right.score - left.score || left.relative.localeCompare(right.relative) || left.index - right.index);

  const candidates = [];
  const push = (site, nextArgument, operation, member) => {
    if (candidates.length >= limit || nextArgument === site.argument) return;
    const next = site.lines.slice();
    next[site.index] = site.line.replace(`.startswith(${site.argument})`, `.startswith(${nextArgument})`);
    candidates.push({
      family: 'predicate-prefix-domain-edit',
      description: `${operation} an evidence-derived member of a startswith predicate domain`,
      primitive: {
        kind: 'predicate-domain-set-edit',
        matcher: 'predicate_domain',
        composition: 'verified_set_edit_search'
      },
      inferredMember: member,
      operation,
      patches: [{ path: site.relative, source: next.join('\n') }]
    });
  };

  for (const site of (prefixIntent ? sites.slice(0, 40) : [])) {
    const values = new Set(site.literals.map(item => item.value));
    const exemplar = site.literals[0];
    for (const hint of hintList) {
      if (values.has(hint)) continue;
      const encoded = `${exemplar.prefix}${exemplar.quote}${hint.replace(/\\/g, '\\\\').replace(new RegExp(exemplar.quote, 'g'), `\\${exemplar.quote}`)}${exemplar.quote}`;
      const members = [...site.literals.map(item => item.raw), encoded];
      push(site, `(${members.join(', ')})`, 'add', hint);
    }
    for (let index = 0; index < site.literals.length; index += 1) {
      if (site.literals.length <= 1) break;
      const members = site.literals.filter((_, itemIndex) => itemIndex !== index).map(item => item.raw);
      push(site, members.length === 1 ? members[0] : `(${members.join(', ')})`, 'remove', site.literals[index].value);
    }
    for (const hint of hintList) {
      const encoded = `${exemplar.prefix}${exemplar.quote}${hint.replace(/\\/g, '\\\\').replace(new RegExp(exemplar.quote, 'g'), `\\${exemplar.quote}`)}${exemplar.quote}`;
      push(site, encoded, 'replace', hint);
    }
    if (candidates.length >= limit) break;
  }

  // Bind the same set-edit primitive to scalar equality/identity predicates.  This is the same
  // relation as startswith tuple expansion: a one-member semantic domain becomes a verified set.
  const equalitySites = [];
  const scalar = String.raw`(?:None|True|False|(?:[rubfRUBF]{0,2})?['"][^'"\n]{0,48}['"]|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)`;
  const equalityPattern = new RegExp(`(.+?)\\s+(is\\s+not|is|==|!=)\\s+(${scalar})(\\s*[:)])`);
  for (const [relative, original] of Object.entries(sources)) {
    if (!/\.py$/i.test(relative)
      || /(?:^|\/)(?:tests?|specs?)(?:\/|$)|(?:^|\/)test_[^/]+\.py$/i.test(relative)) continue;
    const lines = String(original).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = equalityPattern.exec(lines[index]);
      if (!match || !/^\s*(?:if|elif|return\b)/.test(match[1])) continue;
      const windowText = lines.slice(Math.max(0, index - 10), Math.min(lines.length, index + 11)).join('\n');
      const window = windowText.toLowerCase();
      let score = 0;
      if (relative === primaryRelative) score += 128;
      for (const word of issueWords) if (window.includes(word)) score += 1;
      const normalizedRelative = relative.toLowerCase();
      if (evidence.replace(/\\/g, '/').toLowerCase().includes(normalizedRelative)) score += 64;
      for (const word of issueWords) if (normalizedRelative.includes(word)) score += 8;
      for (const type of expectedBoundaryTypes) if (new RegExp(`\\b${type}\\b`).test(windowText)) score += 32;
      const existingValue = String(match[3]).replace(/^['"]|['"]$/g, '').toLowerCase();
      const hasMorphologicalBoundaryHint = [...domainHints].some(hint => {
        const hinted = String(hint.value || '').toLowerCase();
        return hinted === `${existingValue}s`
          || hinted.replace(/s$/, '') === existingValue.replace(/s$/, '');
      });
      if (hasMorphologicalBoundaryHint) score += 256;
      equalitySites.push({ relative, lines, index, line: lines[index], match, score });
    }
  }
  equalitySites.sort((left, right) => right.score - left.score || left.relative.localeCompare(right.relative) || left.index - right.index);
  const normalizedDomainHints = [...domainHints]
    .filter((item, index, all) => all.findIndex(other => other.raw === item.raw) === index)
    .sort((left, right) => (right.raw === 'None') - (left.raw === 'None'))
    .slice(0, 20);
  const queuedEqualityEdits = [];
  const scopedEqualitySites = [
    ...equalitySites.slice(0, 50),
    ...equalitySites.filter(site => site.relative === primaryRelative)
  ].filter((site, index, all) => all.findIndex(other => other.relative === site.relative && other.index === site.index) === index)
    .slice(0, 100);
  for (const site of scopedEqualitySites) {
    const [, left, operator, existing, suffix] = site.match;
    const bare = existing.replace(/^['"]|['"]$/g, '');
    const affinity = hint => (hint.raw === 'None' ? 4 : 0)
      + (String(hint.value).toLowerCase() === `${bare.toLowerCase()}s` ? 2 : 0)
      + (String(hint.value).toLowerCase().replace(/s$/, '') === bare.toLowerCase().replace(/s$/, '') ? 1 : 0);
    const orderedHints = normalizedDomainHints.slice().sort((leftHint, rightHint) => affinity(rightHint) - affinity(leftHint));
    for (const hint of orderedHints) {
      if (hint.raw === existing || String(hint.value) === existing.replace(/^['"]|['"]$/g, '')) continue;
      queuedEqualityEdits.push({ site, hint, affinity: affinity(hint), left, operator, existing, suffix });
    }
  }
  queuedEqualityEdits.sort((left, right) => right.affinity - left.affinity
    || right.site.score - left.site.score
    || left.site.relative.localeCompare(right.site.relative)
    || left.site.index - right.site.index);
  for (const edit of queuedEqualityEdits) {
      const membership = /^(?:is\s+not|!=)$/.test(edit.operator) ? 'not in' : 'in';
      const replacement = `${edit.left} ${membership} (${edit.existing}, ${edit.hint.raw})${edit.suffix}`;
      const next = edit.site.lines.slice();
      next[edit.site.index] = edit.site.line.replace(edit.site.match[0], replacement);
      candidates.push({
        family: 'predicate-domain-set-edit',
        description: 'expand an evidence-derived scalar predicate into a verified set predicate',
        primitive: { kind: 'predicate-domain-set-edit', matcher: 'predicate_domain', composition: 'verified_set_edit_search' },
        inferredMember: edit.hint.value,
        operation: 'expand_scalar_domain',
        patches: [{ path: edit.site.relative, source: next.join('\n') }]
      });
      if (candidates.length >= limit) return candidates;
  }
  return candidates;
}

/**
 * Decide which candidates to spend the verification budget on, and in what order.
 *
 * Separated from the search loop so that a synchronous caller and one driving a resident verifier
 * over a pipe run *the same* selection. The runaway-timeout bug had to be fixed twice because
 * hardened infrastructure was copied instead of shared; search order is exactly the kind of thing
 * that must not fork.
 */
function planCandidates({
  source,
  language = 'python',
  testSource = '',
  failureText = '',
  targetRelative = '',
  limit = 240,
  familyPriors = null,
  testNames = [],
  coveredLines = [],
  vocabulary = DEFAULT_VOCABULARY,
  onlyFamilies = null,
  priorBudgetShare = PRIOR_BUDGET_SHARE,
  regionMajorPriors = REGION_MAJOR_PRIORS,
  // Other files in the project, as { path: text }. Donors for a deleted statement may live in any of
  // them, and are only admitted when they bind a name the failure names.
  projectSources = null
}) {
  const regions = localizeRegions({ source, testSource, failureText, targetRelative, testNames, coveredLines });

  // Generation budget and verification budget are different budgets.
  //
  // `limit` is a *verification* budget: the expensive resource is oracle runs, at roughly a second
  // each even with the two-stage verifier. Generation is string manipulation and costs nothing. Using
  // one number for both is what made learned priors inert -- generation walks the regions line by
  // line, so truncating at 80 cuts the list off by *line position*, and the ordering could only
  // permute what survived that cut.
  //
  // Measured on the wcwidth transfer set: the upstream-restoring candidate sat at authored positions
  // 356, 339 and 440 of pools of 580-834, so it was never generated within 80 and priors moved it
  // from "unreachable" to "unreachable". With the pool widened first, the same priors place it at
  // 20, 20 and 37 -- comfortably inside the same 80-run budget. The oracle cost is unchanged; only
  // the choice of which 80 to spend it on changes.
  //
  // The pool is widened only when priors exist. With no ordering signal a wider pool is just a
  // different arbitrary truncation, not a better one, and keeping that path byte-identical means
  // every previously recorded no-priors score stays comparable.
  const poolLimit = (familyPriors && typeof familyPriors === 'object')
    ? Math.max(limit, limit * PRIOR_POOL_FACTOR)
    : limit;
  let candidates = generateCandidates({ source, language, regions, limit: poolLimit, vocabulary, onlyFamilies, failureText, projectSources });
  const pooledCount = candidates.length;

  // Learned search priors.
  //
  // The only thing worth carrying between repairs is which *families* tend to succeed -- never a
  // specific edit at a specific line, which would be memorising an answer rather than learning a
  // procedure. Ordering by past success rate makes the search find fixes earlier and within budget,
  // and it compounds: every verified repair sharpens the ordering for the next one. Ties keep their
  // original order, so with no priors behaviour is unchanged.
  if (familyPriors && typeof familyPriors === 'object') {
    const rateOf = stats => {
      if (!stats || !Number(stats.attempts)) return 0;
      return Number(stats.successes || 0) / Number(stats.attempts);
    };
    // Two granularities, mutation first.
    //
    // Family-level priors alone are too coarse to help much: ordering comparison-boundary first
    // still leaves the winning direction ('>=' -> '>') ninth *within* that family, which measured as
    // a 10 -> 9 improvement, i.e. nothing. The useful signal is which concrete substitution tends to
    // be the fix. That remains a fact about operators rather than about any repository or line, so it
    // generalises and is not a stored answer.
    const mutationRate = candidate => rateOf(familyPriors[`${candidate.family}:${candidate.description}`]);
    const familyRate = candidate => rateOf(familyPriors[candidate.family]);

    // Two kinds of evidence, and they are not equal.
    //
    // Localization is evidence about *this* defect: the failing tests executed this line. Priors are
    // evidence from *other* defects: this substitution has worked before, somewhere else. Sorting the
    // whole pool by priors lets the weaker kind override the stronger one, which is how a candidate
    // in the narrowest region loses its place to a same-family candidate 300 lines away.
    //
    // `regionMajor` keeps the region rank first and uses priors to order within a region. It is the
    // ordering that respects both, and the sweep decides which one is actually spent.
    const rank = (left, right) =>
      mutationRate(right.candidate) - mutationRate(left.candidate)
      || familyRate(right.candidate) - familyRate(left.candidate)
      || left.index - right.index;
    const ordered = comparator => candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort(comparator)
      .map(item => item.candidate);
    const ranked = regionMajorPriors
      ? ordered((left, right) =>
        (left.candidate.regionIndex || 0) - (right.candidate.regionIndex || 0) || rank(left, right))
      : ordered(rank);

    // Priors are a bet, so bound the stake.
    //
    // Ordering the whole pool by prior success starves families that have no record yet. A family
    // earns a record only by winning, so "no record" and "always fails" are scored identically, and
    // an 800-candidate pool then puts every proven substitution ahead of every unproven one. Measured
    // across the four burned blind sets, whole-pool ordering gained one arithmetic instance and lost
    // one constant-replacement instance whose winner slipped from position 63 to beyond 80: a
    // reallocation of the budget rather than an improvement to it.
    //
    // So the budget is split. A share goes to the prior-ordered pool, and the remainder keeps the
    // authored order the previously recorded scores were measured under, which bounds the loss from a
    // prior that does not apply here while keeping the gain from one that does.
    const share = Math.min(1, Math.max(0, Number(priorBudgetShare)));
    const priorSlots = Math.round(limit * share);
    const chosen = [];
    const taken = new Set();
    const take = (list, count) => {
      for (const candidate of list) {
        if (chosen.length >= limit || count <= 0) return;
        if (taken.has(candidate.source)) continue;
        taken.add(candidate.source);
        chosen.push(candidate);
        count -= 1;
      }
    };
    take(ranked, priorSlots);
    take(candidates, limit - chosen.length);
    // A short pool may leave slots unspent; fill them from whatever is left, in prior order.
    take(ranked, limit - chosen.length);
    candidates = chosen;
  }

  // Spend the verification budget on the best `limit` of the pool.
  if (candidates.length > limit) candidates = candidates.slice(0, limit);

  return { candidates, regions, pooledCount };
}

/** The shape both search loops return, so a caller cannot tell which one produced it. */
function repairOutcome({ winner, attempted, candidates, regions, pooledCount }) {
  if (winner) {
    return {
      repaired: true,
      family: winner.family,
      description: winner.description,
      line: winner.line,
      source: winner.source,
      candidatesTried: attempted.length,
      candidateCount: candidates.length,
      pooledCount,
      attempted
    };
  }
  return {
    repaired: false,
    family: null,
    description: null,
    line: null,
    source: null,
    candidatesTried: attempted.length,
    candidateCount: candidates.length,
    pooledCount,
    regions: regions.map(region => ({ reason: region.reason, startLine: region.start + 1, endLine: region.end })),
    attempted
  };
}

/**
 * Try localized mutations until the project's own tests pass.
 *
 * `verify(patchedSource)` must run the real oracle and return `{ passed }`. Nothing is written and
 * nothing is retained unless a candidate genuinely passes -- retention on anything weaker is how a
 * growth loop starts recording its own wishes.
 */
function repairByVerifiedMutation(options) {
  const { verify } = options;
  if (typeof verify !== 'function') throw new TypeError('verify(patchedSource) is required.');
  const plan = planCandidates(options);

  const attempted = [];
  for (const candidate of plan.candidates) {
    const result = verify(candidate.source);
    attempted.push({ family: candidate.family, description: candidate.description, line: candidate.line, passed: Boolean(result && result.passed) });
    if (result && result.passed) return repairOutcome({ winner: candidate, attempted, ...plan });
  }
  return repairOutcome({ winner: null, attempted, ...plan });
}

/**
 * Try to repair a defect the current vocabulary cannot express, by proposing rules and testing them.
 *
 * Called only after the seed search has exhausted, which is the signal that the vocabulary is the
 * thing at fault rather than the budget. Every proposal is a generic substitution -- "`+` becomes
 * `*`" -- never a location, and a proposal is credited only when the winning candidate came from a
 * rule that was not already in the vocabulary.
 *
 * All proposals are tested in **one** pooled search rather than one search each. The previous shape
 * gave each proposal its own budget of 20 candidates, which was fine on a 400-line module and silently
 * fatal on a 2,901-line one: restricted to a single family, the entire candidate pool for
 * tabulate/__init__.py is 79, and the winning candidates sat at positions 25 and 47. Twelve
 * proposals x 20 could not reach them, and raising each to a sufficient budget would have cost twelve
 * times as many oracle runs. Pooling costs one budget total and lets the ordering decide.
 *
 * Measured consequence of the old shape: on a 150-defect tabulate curriculum, ten defects whose repair
 * needed an absent rule all failed and none grew a rule, while the proposals themselves were correct.
 */
async function growVocabularyByProposal({
  source,
  regions,
  vocabulary,
  verify,
  language = 'python',
  testSource = '',
  failureText = '',
  targetRelative = '',
  testNames = [],
  coveredLines = [],
  // Twenty-four, from a sweep on the real case: at 12 the needed `+ becomes -` was never reached,
  // because coverage localization produces many small regions and the earliest ones exhaust the
  // budget on operators that are not the defect. At 24 it is proposed and its candidate sits at
  // position 87 of the pooled search, inside the verification budget below.
  proposalLimit = 24,
  limit = 120
}) {
  const proposals = proposeVocabularyExtensions({ source, regions, vocabulary, limit: proposalLimit });
  if (!proposals.length) return { repaired: false, proposals: 0, attempted: [] };

  // One vocabulary containing every proposal, and one search over it.
  const trial = JSON.parse(JSON.stringify(vocabulary));
  const byDescription = new Map();
  for (const proposal of proposals) {
    trial[proposal.family] = trial[proposal.family] || { kind: 'operator-substitution', rules: [] };
    const exists = trial[proposal.family].rules.some(rule => rule[0] === proposal.rule[0] && rule[1] === proposal.rule[1]);
    if (exists) continue;
    trial[proposal.family].rules.push(proposal.rule);
    byDescription.set(`${proposal.family}:${proposal.rule[0].trim()} -> ${proposal.rule[1].trim()}`, proposal);
  }
  if (!byDescription.size) return { repaired: false, proposals: proposals.length, attempted: [] };

  const outcome = await repairByVerifiedMutationAsync({
    source, language, testSource, failureText, targetRelative, testNames, coveredLines,
    limit,
    vocabulary: trial,
    // Only families carrying a proposal. The seed families already exhausted, and re-testing them
    // cost five times the necessary work before this was scoped.
    onlyFamilies: [...new Set(proposals.map(proposal => proposal.family))],
    // A proposed rule has no track record by definition, so there is nothing to order by.
    familyPriors: null,
    verify
  });

  // Credit only a rule that did not already exist. A grown rule must not take a seed rule's repair.
  const grown = outcome.repaired
    ? byDescription.get(`${outcome.family}:${outcome.description}`) || null
    : null;
  return {
    repaired: Boolean(grown),
    outcome: grown ? outcome : null,
    grownRule: grown,
    proposals: proposals.length,
    attempted: outcome.attempted || []
  };
}

/**
 * Propose preserving case at a semantic identity boundary when the failure itself says that two
 * spellings which differ only by case must remain distinct.
 *
 * This is intentionally narrower than a general "remove lower()" edit.  Case normalization is
 * often correct for presentation and fuzzy lookup.  It is only a candidate here when the failure
 * names case distinction *and* the normalized value is being supplied to an identity-like
 * registration, index, lookup, or key operation.  The retained primitive stores that relation,
 * never a repository name, target, identifier, literal, or expected output.
 */
function proposeCaseIdentityCandidates({ issueText = '', projectSources = {}, primaryRelative = '', limit = 12 }) {
  const evidence = String(issueText || '');
  const sources = projectSources && typeof projectSources === 'object' ? projectSources : {};
  const explicitCaseDistinction = /(?:case[- ]?sensitive|case[- ]?distinct|different\s+case|preserv(?:e|es|ed)\s+(?:the\s+)?(?:original\s+)?case|case\s+(?:is|as)\s+(?:semantic|significant)|uppercase.{0,40}lowercase|lowercase.{0,40}uppercase)/i.test(evidence);
  const identityEvidence = /\b(?:duplicates?|identit(?:y|ies)|keys?|terms?|names?|labels?|identifiers?|objects?|indexes|indices|lookups?|registers?|mappings?|dictionar(?:y|ies))\b/i.test(evidence);
  if (!explicitCaseDistinction || !identityEvidence) return [];

  const identitySite = /(?:\b(?:register|record|setdefault|lookup|resolve|index|object|key|identifier|name|term|label)\b|\b(?:[A-Za-z_]*_(?:note|object|key|identifier|name|term|label)|(?:note|object|key|identifier|name|term|label)_[A-Za-z_]+)\b)/i;
  const entries = Object.entries(sources)
    .filter(([relative]) => /\.py$/i.test(relative)
      && !/(?:^|\/)(?:tests?|specs?)(?:\/|$)|(?:^|\/)test_[^/]+\.py$/i.test(relative))
    .sort(([left], [right]) => (left === primaryRelative ? -1 : right === primaryRelative ? 1 : left.localeCompare(right)));
  const candidates = [];
  for (const [relative, original] of entries) {
    const lines = String(original).split(/\r?\n/);
    for (let index = 0; index < lines.length && candidates.length < limit; index += 1) {
      const line = lines[index];
      const localContext = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join('\n');
      if (!identitySite.test(localContext)) continue;
      const normalizers = [...line.matchAll(/\.(?:lower|casefold)\(\)/g)];
      for (const normalizer of normalizers) {
        if (candidates.length >= limit) break;
        const at = Number(normalizer.index || 0);
        const next = lines.slice();
        next[index] = `${line.slice(0, at)}${line.slice(at + normalizer[0].length)}`;
        candidates.push({
          family: 'case-identity-normalization-policy',
          description: 'preserve an evidence-required case distinction at an inferred semantic identity boundary',
          primitive: {
            kind: 'case-normalization-policy',
            matcher: 'semantic_identity_key',
            composition: 'preserve_case_distinction'
          },
          patches: [{ path: relative, source: next.join('\n') }]
        });
      }
    }
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/**
 * The same search, driven by an oracle that answers over a pipe.
 *
 * A resident verifier imports pytest and the test modules once and answers in about a second instead
 * of nine, which is what makes a budget of several hundred candidates affordable at all. It has to be
 * async -- a child process cannot be read synchronously -- so the loop is duplicated but the *plan*
 * is not: both call planCandidates, so ordering, budget split and pool width cannot drift apart.
 */
async function repairByVerifiedMutationAsync(options) {
  const { verify } = options;
  if (typeof verify !== 'function') throw new TypeError('verify(patchedSource) is required.');
  const plan = planCandidates(options);

  const attempted = [];
  for (const candidate of plan.candidates) {
    const result = await verify(candidate.source);
    attempted.push({ family: candidate.family, description: candidate.description, line: candidate.line, passed: Boolean(result && result.passed) });
    if (result && result.passed) return repairOutcome({ winner: candidate, attempted, ...plan });
  }
  return repairOutcome({ winner: null, attempted, ...plan });
}

module.exports = {
  DEFAULT_VOCABULARY,
  OPERATOR_CLASSES,
  vocabularyRules,
  proposeVocabularyExtensions,
  importedSymbols,
  failingTestReferences,
  failingTestTargets,
  tracebackLines,
  localizeRegions,
  generateCandidates,
  proposeContextRestorationCandidates,
  proposePrefixDomainCandidates,
  proposeCaseIdentityCandidates,
  planCandidates,
  repairByVerifiedMutation,
  repairByVerifiedMutationAsync,
  growVocabularyByProposal,
  FAMILIES: ['comparison-boundary', 'aggregation-choice', 'numeric-constant', 'boolean-polarity', 'guard-insertion']
};
