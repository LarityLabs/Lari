#!/usr/bin/env node
'use strict';

/**
 * Asserts the execution-claim lane against a real repository, including that its oracles can FAIL.
 *
 * Runs against the preserved humanize checkout, so the observations are of real library code rather
 * than of a fixture written to make the test pass. If the repository is absent the suite skips rather
 * than fails -- an environment gap is not a regression, and pretending otherwise is how a green suite
 * stops meaning anything.
 *
 * The assertions that matter most are the negative ones:
 *   - a non-deterministic call must produce NO claim (test: `random`, `id()`)
 *   - an unrunnable import must be distinguished from code that raises
 *   - no claim may quantify over inputs
 *
 * Usage: node scripts/test_lari_execution_claims.js
 */

const fs = require('fs');
const path = require('path');
const execution = require(path.join(__dirname, '..', 'swarm_execution_claims.js'));

const REPO = 'C:/Users/goryg/.gemini/antigravity/scratch/lari-benchmark-repos/humanize';

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 260)}` : ''}`);
  }
}

if (!fs.existsSync(REPO)) {
  console.log(`SKIP: ${REPO} is not present. See holdouts/BENCHMARK_REPOSITORIES.json.`);
  process.exit(0);
}

const humanize = expression => ({ repo: REPO, imports: 'import humanize', expression });

console.log('observing real library code');
{
  const r = execution.observeAndClaim(humanize('humanize.intword(1000000)'));
  check('a real call is observed', r.observed, r);
  check('the outcome is a return', r.outcome === 'returned', r.outcome);
  check('the value is the interpreter\'s own repr', /^'.*'$/.test(String(r.value)), r.value);
  check('the text states the call and the value',
    r.observed && r.text.includes('humanize.intword(1000000)') && r.text.includes(r.value), r.text);
  check('the text is past tense about one invocation', r.observed && /^I ran /.test(r.text), r.text);
  check('no external model calls', r.externalModelCalls === 0);
}

console.log('\ncalls taking string arguments');
{
  // Regression: realizing this put the expression's own quotes into the text, and the grounding check
  // demanded they be licensed. They were not, because the word-level pass cannot license a span with
  // spaces in it. Every call with a string argument was unclaimable.
  const r = execution.observeAndClaim(humanize('humanize.intword("not a number", "%.99f")'));
  check('a call with quoted arguments is claimable', r.observed, { reason: r.reason, grounding: r.grounding });
  check('and its quoted arguments are not reported as ungrounded',
    r.grounding.length === 0, r.grounding);
}

console.log('\ncode that raises is a claim; a harness failure is not');
{
  const raises = execution.observeAndClaim(humanize('humanize.naturalsize(None)'));
  check('a raising call is observed', raises.observed, raises.reason);
  check('a raise is reported as a raise', raises.outcome === 'raised', raises.outcome);
  check('and names the exception class', raises.value === 'TypeError', raises.value);
  check('the text says it raised, not that it returned',
    raises.observed && /raised TypeError/.test(raises.text), raises.text);

  const broken = execution.observeAndClaim({ repo: REPO, imports: 'import nosuchmodule_zzz', expression: '1 + 1' });
  check('an unimportable module produces NO claim', broken.observed === false, broken);
  check('and is reported as a harness failure, not as a fact about the code',
    /could not run/.test(String(broken.reason)), broken.reason);
  check('no claims leak from an unusable run', broken.claims.length === 0);
}

console.log('\noracle 1: determinism, and it can fail');
{
  const stableSpec = { repo: REPO, imports: 'import humanize', expression: 'humanize.intword(1000)' };
  check('a pure call is stable', execution.observeStable(stableSpec).stable);

  // Adversarial: a call whose value changes between runs must not become a claim.
  const randomSpec = { repo: REPO, imports: 'import random', expression: 'random.random()' };
  const unstable = execution.observeStable(randomSpec);
  check('a random call is rejected as unstable', unstable.stable === false, unstable.reason);
  check('and the rejection says it is non-determinism, not a harness fault',
    /not deterministic/.test(String(unstable.reason)), unstable.reason);
  check('both disagreeing readings are kept, not averaged',
    unstable.first && unstable.second && unstable.first.value !== unstable.second.value,
    { first: unstable.first, second: unstable.second });

  const claimed = execution.observeAndClaim(randomSpec);
  check('an unstable call produces NO claim', claimed.observed === false && claimed.claims.length === 0);

  // The oracle earning its keep on real library code rather than on a contrived `random()`: this repr
  // embeds a memory address, so the value differs every run and the claim would be false on retrieval.
  const addressed = execution.observeStable(humanize('humanize.intcomma(object())'));
  check('a repr containing a memory address is rejected as unstable',
    addressed.stable === false && /not deterministic/.test(String(addressed.reason)),
    { reason: addressed.reason, first: addressed.first, second: addressed.second });
}

console.log('\noracle 2: execution provenance, and it can fail');
{
  const spec = humanize('humanize.intword(1000000)');
  const stable = execution.observeStable(spec);
  const good = execution.atomizeObservation(spec, stable);
  check('genuine claims pass provenance',
    execution.executionProvenanceViolations(good, spec, stable).length === 0);

  // Adversarial: tidy the value the way a summariser would, and it must be caught.
  const tidied = good.map(c => (c.type === 'code_observed_return'
    ? { ...c, values: { ...c.values, value: String(c.values.value).replace(/'/g, '') } }
    : c));
  const v = execution.executionProvenanceViolations(tidied, spec, stable);
  check('a value reformatted on the way in is caught', v.length > 0, v);
}

console.log('\nexistential, never universal');
{
  const specs = [
    humanize('humanize.intword(1000)'),
    humanize('humanize.intword(1000000)'),
    humanize('humanize.intword(0)')
  ];
  const described = execution.describeFromObservations(specs);
  check('several observations produce a description', described.described, described.reason || described);
  check('the description is grounded', described.described && described.grounding.length === 0, described.grounding);
  check('nothing was silently dropped', described.described && described.dropped.length === 0, described.dropped);

  const text = String(described.text || '');
  // The whole discipline, asserted: no claim may generalise from what was observed.
  for (const quantifier of [/\balways\b/i, /\bnever\b/i, /\bevery input\b/i, /\bfor all\b/i, /\bguarantees?\b/i]) {
    check(`the description avoids ${quantifier}`, !quantifier.test(text.replace(/not a statement about every input/i, '')), text);
  }
  check('it states how many observations it rests on',
    /\d+ observations of what happened/.test(text), text);
  check('and says explicitly that it is not a statement about every input',
    /not a statement about every input/.test(text), text);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
