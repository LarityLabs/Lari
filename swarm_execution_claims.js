'use strict';

/**
 * Phase C of LARI_ROADMAP.md: claims Lari can make because it ran the code.
 *
 * Why this is the one that matters
 * --------------------------------
 * Asked what a function does, a language model predicts the most likely description given everything
 * it has read. It is a very good guess and it is still a guess -- which is why hallucination is the
 * standing complaint about coding agents. Lari can do something categorically different: execute the
 * function and report what happened. A claim generated *from* an observed run cannot be unfaithful to
 * it, because the run is where it came from.
 *
 * That is the product argument in one sentence: every statement Lari makes about a codebase can carry
 * the execution that produced it.
 *
 * The discipline that keeps this honest: existential, never universal
 * ------------------------------------------------------------------
 * Rule 12 of LARI_WORKING_CONTEXT.md is "absence is never evidence", and it has already cost this project five false
 * grammar rules and 244,226 false lookup entries. The same inference is available here and is just as
 * wrong: observing `intword(0) == '0'` licenses *"when I called intword(0) it returned '0'"*. It does
 * NOT license *"intword returns '0' for zero"*, and it certainly does not license *"intword never
 * raises"*. Three green observations are three observations.
 *
 * So every claim type here names the call, and every realization rule is phrased in the past tense
 * about a specific invocation. There is deliberately no claim type that quantifies over inputs. If one
 * is ever added it needs a proof obligation, not a sample.
 *
 * The automatic oracles, named before the capability, per rule 1
 * -------------------------------------------------------------
 *   1. DETERMINISM -- every observation is made twice and must agree. A call that returns a timestamp,
 *      a random value or a set iteration order produces a claim that is false the moment it is stored.
 *      This is the oracle that makes the difference between "I ran it" and "I ran it and it means
 *      something".
 *   2. EXECUTION PROVENANCE -- the claim's value must be exactly what the interpreter printed, compared
 *      as a string. Nothing is normalised, rounded or tidied on the way in.
 *   3. Then the realization checks that already exist: grounding, preservation, provenance.
 *
 * A call that errors in the harness (import failure, syntax error, timeout) is distinguished from a
 * call that raises inside the code. The first yields no claim; the second yields a claim *about the
 * exception*, which is a real observation. Conflating them is how the tabulate run scored 0/64 against
 * an oracle that was never running.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const realization = require('./swarm_claim_realization.js');

const OBSERVE_TIMEOUT_MS = 20000;

/**
 * Run one expression inside a repository and report what the interpreter did.
 *
 * The probe prints a single JSON line so the result is parsed rather than scraped. `outcome` is one of:
 *   'returned'  -- the expression evaluated; `value` is its repr
 *   'raised'    -- the expression raised; `value` is the exception class name
 *   'unusable'  -- the harness could not run it at all. NOT a fact about the code.
 */
function observeCall({ repo, imports, expression, python = 'python' }) {
  const probe = [
    'import json, sys',
    'sys.path.insert(0, "src")',
    'sys.path.insert(0, ".")',
    'try:',
    `    ${imports}`,
    'except Exception as e:',
    '    print(json.dumps({"outcome": "unusable", "value": type(e).__name__ + ": " + str(e)}))',
    '    sys.exit(0)',
    'try:',
    `    _v = ${expression}`,
    '    print(json.dumps({"outcome": "returned", "value": repr(_v)}))',
    'except Exception as e:',
    '    print(json.dumps({"outcome": "raised", "value": type(e).__name__}))'
  ].join('\n');

  const run = spawnSync(python, ['-c', probe], {
    cwd: repo,
    encoding: 'utf8',
    timeout: OBSERVE_TIMEOUT_MS,
    windowsHide: true
  });

  if (run.error || run.status !== 0) {
    return { outcome: 'unusable', value: String(run.error?.message || run.stderr || 'non-zero exit').slice(0, 200) };
  }
  const line = String(run.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed.outcome !== 'string') throw new Error('malformed probe output');
    return parsed;
  } catch (e) {
    return { outcome: 'unusable', value: `probe output not parseable: ${String(line).slice(0, 120)}` };
  }
}

/**
 * Oracle 1 -- determinism. Observe twice; a disagreement means the call is not a stable fact.
 *
 * Returns the agreed observation, or a rejection naming both readings so the disagreement is visible
 * rather than averaged away.
 */
function observeStable(spec) {
  // A transient harness failure is retried once before it becomes a verdict.
  //
  // Observed under load: `intword(0)` was stable when run on its own and 'unusable' moments later
  // while a measurement run had the machine busy. Treating that as a fact would silently drop claims
  // about perfectly good code, and treating it as non-determinism would be worse -- it would report a
  // property of the machine as a property of the program. This repository has already been bitten by
  // an oracle that errored being read as an oracle that rejected.
  const observe = () => {
    const attempt = observeCall(spec);
    return attempt.outcome === 'unusable' ? observeCall(spec) : attempt;
  };

  const first = observe();
  if (first.outcome === 'unusable') {
    return { stable: false, reason: 'harness could not run the call', first, second: null };
  }
  const second = observe();
  if (second.outcome === 'unusable') {
    return { stable: false, reason: 'harness could not run the call', first, second };
  }
  if (first.outcome !== second.outcome || first.value !== second.value) {
    return { stable: false, reason: 'call is not deterministic', first, second };
  }
  return { stable: true, observation: first, first, second };
}

const EXECUTION_REALIZATION_RULES = {
  ...realization.DEFAULT_REALIZATION_RULES,
  // Past tense, specific call, no quantifier. The phrasing is the discipline.
  code_observed_return: {
    slots: ['expression', 'value'],
    say: c => `I ran ${c.expression} and it returned ${c.value}.`
  },
  code_observed_raise: {
    slots: ['expression', 'exception'],
    say: c => `I ran ${c.expression} and it raised ${c.exception}.`
  },
  code_observation_repeated: {
    slots: ['expression'],
    say: c => `I ran ${c.expression} twice and got the same result both times, so it is at least stable.`
  },
  code_observation_scope: {
    slots: ['observationCount'],
    say: c => `That is ${c.observationCount} ${Number(c.observationCount) === 1 ? 'observation' : 'observations'} of what happened, not a statement about every input.`
  }
};

/** Turn a stable observation into typed claims. Unstable ones yield nothing. */
function atomizeObservation(spec, stable) {
  if (!stable?.stable) return [];
  const claims = [];
  const expression = String(spec.expression);
  if (stable.observation.outcome === 'returned') {
    claims.push({ type: 'code_observed_return', values: { expression, value: stable.observation.value } });
  } else if (stable.observation.outcome === 'raised') {
    claims.push({ type: 'code_observed_raise', values: { expression, exception: stable.observation.value } });
  }
  if (claims.length) claims.push({ type: 'code_observation_repeated', values: { expression } });
  return claims;
}

/**
 * Oracle 2 -- execution provenance. Every claim value must be exactly what the interpreter printed.
 *
 * Separate from the realization lane's own provenance check, which compares against a record. Here the
 * record IS the run, and the comparison is byte-for-byte: a value that was rounded, unquoted or
 * prettified on the way in is a value the interpreter never produced.
 */
function executionProvenanceViolations(claims, spec, stable) {
  const permitted = new Set([String(spec.expression)]);
  if (stable?.observation) permitted.add(String(stable.observation.value));
  const violations = [];
  for (const claim of claims) {
    for (const [slot, value] of Object.entries(claim.values || {})) {
      if (!permitted.has(String(value))) {
        violations.push({ claim: claim.type, slot, value: String(value) });
      }
    }
  }
  return violations;
}

/**
 * Observe a call and produce verified claims about it, or refuse.
 *
 * `observed: false` is a first-class outcome, and it distinguishes the two reasons: the code was not
 * runnable (says nothing about the code) or the call was not deterministic (says something real, and
 * still no claim).
 */
function observeAndClaim(spec, rules = EXECUTION_REALIZATION_RULES) {
  const stable = observeStable(spec);
  if (!stable.stable) {
    return {
      observed: false,
      reason: stable.reason,
      readings: [stable.first, stable.second].filter(Boolean),
      claims: [],
      externalModelCalls: 0
    };
  }
  const claims = atomizeObservation(spec, stable);
  const text = realization.realizeClaims(claims, rules);
  const grounding = realization.groundingViolations(text, claims);
  const dropped = realization.unrealizedClaims(text, claims, rules);
  const provenance = executionProvenanceViolations(claims, spec, stable);
  const ok = Boolean(text) && !grounding.length && !dropped.length && !provenance.length;
  return {
    observed: ok,
    reason: ok ? null : 'claims failed their own checks',
    outcome: stable.observation.outcome,
    value: stable.observation.value,
    claims,
    text,
    grounding,
    dropped,
    provenance,
    externalModelCalls: 0
  };
}

/**
 * Describe a function from several observed calls.
 *
 * The summary is a list of what happened, closed by a claim stating how many observations it rests on.
 * That closing claim is not decoration: it is what stops a reader treating four examples as a
 * specification, and it is realized like any other claim so preservation forces it to be said.
 */
function describeFromObservations(specs, rules = EXECUTION_REALIZATION_RULES) {
  const claims = [];
  const observations = [];
  const refused = [];
  for (const spec of specs) {
    const result = observeAndClaim(spec, rules);
    if (!result.observed) { refused.push({ expression: spec.expression, reason: result.reason }); continue; }
    observations.push(result);
    // One outcome claim per call; the per-call stability line would be repetitive across a summary.
    claims.push(result.claims[0]);
  }
  if (!claims.length) {
    return { described: false, reason: 'no call produced a stable observation', refused, claims: [] };
  }
  claims.push({ type: 'code_observation_scope', values: { observationCount: claims.length } });

  const text = realization.realizeClaims(claims, rules);
  const grounding = realization.groundingViolations(text, claims);
  const dropped = realization.unrealizedClaims(text, claims, rules);
  return {
    described: !grounding.length && !dropped.length,
    text,
    claims,
    observationCount: observations.length,
    refused,
    grounding,
    dropped,
    externalModelCalls: 0
  };
}

module.exports = {
  OBSERVE_TIMEOUT_MS,
  EXECUTION_REALIZATION_RULES,
  observeCall,
  observeStable,
  atomizeObservation,
  executionProvenanceViolations,
  observeAndClaim,
  describeFromObservations
};
