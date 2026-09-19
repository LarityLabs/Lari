'use strict';

/**
 * Roadmap phase E: writing a function body, verified by the project's own tests.
 *
 * Synthesis is repair from empty
 * ------------------------------
 * Every family in `swarm_mutation_repair.js` rewrites something that is present. A stub is the case
 * where nothing is present: the body is `pass`, the tests fail, and the fix is not a rewrite but a
 * construction. Framing it as repair is what lets the existing discipline carry over unchanged -- the
 * oracle is still the upstream suite, a candidate is still retained only after it passes, and a
 * candidate that passes without being right is still the thing to worry about.
 *
 * The automatic oracle, named before the capability, per rule 1
 * ------------------------------------------------------------
 * The project's own test suite, injected rather than assumed, so this module can be exercised without
 * pytest and used with it. Three additional refusals on top of "the suite passed":
 *
 *   1. NON-TRIVIALITY -- a body that ignores every parameter is refused unless the stub takes none.
 *      `return 0` passing a test suite means the suite is weak, and accepting it would let Lari
 *      "synthesize" constants for any signature. This is the synthesis form of the guard-flip problem
 *      that `repairScore` exists to catch.
 *   2. THE STUB MUST ACTUALLY FAIL FIRST -- if the suite is green before synthesis there is nothing to
 *      synthesize, and any body would be "verified". A capability that cannot fail is decoration.
 *   3. DETERMINISM -- the winning candidate is verified twice. A body that passes once and not again is
 *      a property of the machine, not of the program.
 *
 * What this is not
 * ----------------
 * Bounded enumeration over a small template space, not general program synthesis. It writes single
 * expression bodies over the parameters in scope. It will not write a loop, and it should not be quoted
 * as though it might. What it establishes is that the loop closes: a stub, a failing suite, a generated
 * body, a passing suite, and a retained result with provenance.
 *
 * Rule 12 applies to the search itself: a template that has never won is not evidence the template is
 * useless, so nothing is pruned on absence.
 */

/** Templates over the parameters in scope. Ordered cheapest-first; ordering is the only prior here. */
const EXPRESSION_TEMPLATES = [
  { id: 'identity', arity: 1, build: p => `${p[0]}` },
  { id: 'negate', arity: 1, build: p => `-${p[0]}` },
  { id: 'not', arity: 1, build: p => `not ${p[0]}` },
  { id: 'length', arity: 1, build: p => `len(${p[0]})` },
  { id: 'absolute', arity: 1, build: p => `abs(${p[0]})` },
  { id: 'string', arity: 1, build: p => `str(${p[0]})` },
  { id: 'sum', arity: 2, build: p => `${p[0]} + ${p[1]}` },
  { id: 'difference', arity: 2, build: p => `${p[0]} - ${p[1]}` },
  { id: 'product', arity: 2, build: p => `${p[0]} * ${p[1]}` },
  { id: 'floordiv', arity: 2, build: p => `${p[0]} // ${p[1]}` },
  { id: 'modulo', arity: 2, build: p => `${p[0]} % ${p[1]}` },
  { id: 'max', arity: 2, build: p => `max(${p[0]}, ${p[1]})` },
  { id: 'min', arity: 2, build: p => `min(${p[0]}, ${p[1]})` },
  { id: 'concat-str', arity: 2, build: p => `str(${p[0]}) + str(${p[1]})` },
  { id: 'compare-gt', arity: 2, build: p => `${p[0]} > ${p[1]}` },
  { id: 'compare-eq', arity: 2, build: p => `${p[0]} == ${p[1]}` },
  { id: 'sum-then-double', arity: 2, build: p => `(${p[0]} + ${p[1]}) * 2` },
  { id: 'constant-zero', arity: 0, build: () => '0' },
  { id: 'constant-empty', arity: 0, build: () => "''" },
  { id: 'constant-none', arity: 0, build: () => 'None' },
  { id: 'constant-true', arity: 0, build: () => 'True' },
  { id: 'constant-false', arity: 0, build: () => 'False' }
];

const STUB_BODY = /^\s*(?:pass|\.\.\.|raise\s+NotImplementedError.*)\s*$/;

/**
 * Find stub functions in a Python source: `def name(args):` whose body is only a placeholder.
 *
 * Deliberately shallow -- it reads indentation rather than parsing. A file this cannot read yields no
 * stubs, which is a refusal rather than a guess.
 */
function findStubs(source) {
  const lines = String(source).split(/\r?\n/);
  const stubs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->[^:]+)?:\s*$/);
    if (!match) continue;
    const [, indent, name, rawParams] = match;

    // Collect the body: lines more indented than the def, skipping a docstring.
    const body = [];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (!line.trim()) { j += 1; continue; }
      if ((line.match(/^\s*/) || [''])[0].length <= indent.length) break;
      body.push({ line, index: j });
      j += 1;
    }
    if (!body.length) continue;

    // A docstring-only body is still a stub; skip the docstring when judging.
    const meaningful = body.filter(b => !/^\s*(?:"""|''')/.test(b.line) && !/^\s*#/.test(b.line));
    const isStub = meaningful.length > 0 && meaningful.every(b => STUB_BODY.test(b.line));
    if (!isStub) continue;

    const params = rawParams.split(',')
      .map(p => p.split('=')[0].split(':')[0].trim())
      .filter(p => p && p !== 'self' && p !== 'cls' && !p.startsWith('*'));

    stubs.push({
      name,
      params,
      indent,
      defLine: i,
      bodyStart: meaningful[0].index,
      bodyEnd: body[body.length - 1].index
    });
  }
  return stubs;
}

/** Candidate bodies for a stub, cheapest first. */
function proposeBodies(stub) {
  const candidates = [];
  const seen = new Set();
  const push = (expression, templateId) => {
    const body = `${stub.indent}    return ${expression}`;
    if (seen.has(body)) return;
    seen.add(body);
    candidates.push({ body, expression, templateId });
  };

  for (const template of EXPRESSION_TEMPLATES) {
    if (template.arity === 0) { push(template.build([]), template.id); continue; }
    if (template.arity === 1) {
      for (const p of stub.params) push(template.build([p]), template.id);
      continue;
    }
    for (const a of stub.params) {
      for (const b of stub.params) {
        if (a === b) continue;
        push(template.build([a, b]), template.id);
      }
    }
  }
  return candidates;
}

/** Replace a stub's body with a candidate. */
function applyBody(source, stub, candidate) {
  const lines = String(source).split(/\r?\n/);
  const before = lines.slice(0, stub.bodyStart);
  const after = lines.slice(stub.bodyEnd + 1);
  return [...before, candidate.body, ...after].join('\n');
}

/**
 * Oracle 1 -- non-triviality. A body ignoring every parameter is refused when parameters exist.
 *
 * A constant that satisfies the suite says the suite is weak, and retaining it would let Lari claim to
 * have synthesized any function whose tests happen to be thin. Reported rather than silently skipped,
 * because "the tests accept a constant" is worth knowing.
 */
function trivialityViolation(stub, candidate) {
  if (!stub.params.length) return null;
  const usesAParameter = stub.params.some(p => new RegExp(`(?<![\\w.])${p}(?![\\w])`).test(candidate.expression));
  return usesAParameter ? null : { kind: 'ignores-every-parameter', expression: candidate.expression };
}

/**
 * Synthesize a body for one stub.
 *
 * `verify(source)` must return `{ passed: boolean }` and is injected, so this is testable without a
 * Python toolchain and usable with one. `budget` bounds the number of verifications, as in the repair
 * search, so an unsynthesizable stub costs a known amount rather than an unknown one.
 */
function synthesizeStub(source, stub, verify, { budget = 200, accept = null } = {}) {
  // Oracle 2: the stub must actually fail before anything is attempted.
  const baseline = verify(source);
  if (baseline.passed) {
    return { synthesized: false, reason: 'the suite already passes; there is nothing to synthesize', attempts: 0 };
  }

  // What counts as success, and why it has to be injectable.
  //
  // The default is the strict one: the whole suite goes green. That is right for a single stub and
  // wrong the moment there are two, because filling one leaves the other's tests failing and no
  // candidate can ever pass -- synthesis could not compose with itself, and the agentic loop measured
  // exactly that as "0 changes tried".
  //
  // A caller working at task scope supplies progress instead. It is deliberately the caller's choice
  // rather than a silent default: relaxing "all green" to "fewer failures" is exactly the kind of
  // loosened check that lets an agent claim work it did not do, so it has to be asked for.
  const isAccepted = typeof accept === 'function'
    ? (after) => accept(after, baseline)
    : (after) => after.passed;

  const candidates = proposeBodies(stub);
  const rejectedAsTrivial = [];
  let attempts = 0;

  for (const candidate of candidates) {
    if (attempts >= budget) break;
    const trivial = trivialityViolation(stub, candidate);
    const patched = applyBody(source, stub, candidate);
    attempts += 1;
    const result = verify(patched);
    if (!isAccepted(result)) continue;

    if (trivial) {
      // It was accepted and it is trivial. Do not retain it, and do not stop looking.
      rejectedAsTrivial.push({ ...trivial, note: 'passed the suite; refused as trivial' });
      continue;
    }
    // Oracle 3: determinism. Re-verified against the same acceptance test, not a weaker one.
    if (!isAccepted(verify(patched))) {
      return { synthesized: false, reason: 'a candidate passed once and failed on repeat', attempts, candidate };
    }
    return {
      synthesized: true,
      source: patched,
      body: candidate.body,
      expression: candidate.expression,
      templateId: candidate.templateId,
      attempts,
      candidatesGenerated: candidates.length,
      rejectedAsTrivial,
      // Provenance, so the claim lane can say what happened and why it is believed.
      provenance: {
        stub: stub.name,
        parameters: stub.params,
        oracle: 'project test suite',
        verifiedTwice: true
      },
      externalModelCalls: 0
    };
  }

  return {
    synthesized: false,
    reason: attempts >= budget ? 'budget exhausted' : 'no candidate passed',
    attempts,
    candidatesGenerated: candidates.length,
    rejectedAsTrivial,
    externalModelCalls: 0
  };
}

module.exports = {
  EXPRESSION_TEMPLATES,
  findStubs,
  proposeBodies,
  applyBody,
  trivialityViolation,
  synthesizeStub
};
