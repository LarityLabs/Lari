'use strict';

/**
 * Roadmap phase F: a bounded loop that observes, acts, verifies, and stops.
 *
 * Why this is last
 * ----------------
 * An agentic loop is a multiplier. Wrapped around a capability that works it does more of what works;
 * wrapped around one that does not it produces confident nonsense at scale, and it produces it faster
 * than anyone can read it. Everything this loop can do -- repair a defect, synthesize a stub -- is a
 * capability measured elsewhere in this repository against a real oracle. The loop adds no capability
 * whatsoever, and that is deliberate: it is scheduling, not intelligence.
 *
 * The automatic oracle, named before the capability, per rule 1
 * ------------------------------------------------------------
 * The project's own test suite, at task scope instead of patch scope. A step is accepted only if the
 * suite is closer to green afterwards, measured by the number of failing tests. Four refusals:
 *
 *   1. MONOTONIC PROGRESS -- a step that does not reduce the failing-test count is rolled back. Without
 *      this, an agent wanders: it makes a change that trades one failure for another, then another, and
 *      terminates having rewritten everything and fixed nothing.
 *   2. NO PROGRESS, NO PERSISTENCE -- if a whole pass produces no accepted step, the loop stops. It
 *      does not try harder, raise a budget, or loosen a check.
 *   3. HARD BOUND -- a maximum number of steps, always. An unbounded loop against a flaky oracle is how
 *      a machine spends a night achieving nothing.
 *   4. EVERY STEP IS VERIFIED BEFORE IT IS KEPT -- there is no "probably fine". A step whose
 *      verification did not run is a step that did not happen.
 *
 * What the loop must never do
 * ---------------------------
 * Report success it did not verify. `completed` is true only when the suite is green, and a loop that
 * stops early says exactly why. The transcript records every step including the rejected ones, because
 * an agent that hides its failed attempts is one you cannot debug and cannot trust.
 *
 * Rule 12 applies to termination: the loop stopping without finishing is not evidence the task is
 * impossible, only that this loop did not do it, and `completed: false` is reported with the reason
 * rather than as a verdict about the task.
 */

const DEFAULT_MAX_STEPS = 12;

/**
 * Run the loop.
 *
 * Everything the loop can do arrives as an `action`: `{ id, describe(state), propose(state) }` where
 * `propose` returns `{ source, note }` or null. The loop knows nothing about repair or synthesis, which
 * is what keeps it honest -- it cannot invent a capability it was not given.
 *
 * `runSuite(source)` must return `{ passed, failingCount }`.
 */
function runAgenticLoop({ source, runSuite, actions = [], maxSteps = DEFAULT_MAX_STEPS } = {}) {
  const transcript = [];
  const started = Date.now();

  let current = String(source);
  let observation = runSuite(current);
  transcript.push({
    step: 0,
    phase: 'observe',
    failingCount: observation.failingCount,
    passed: observation.passed
  });

  if (observation.passed) {
    return {
      completed: true,
      reason: 'the suite was already green; nothing to do',
      steps: 0,
      source: current,
      transcript,
      externalModelCalls: 0
    };
  }

  let step = 0;
  while (step < maxSteps) {
    step += 1;
    let acceptedThisPass = false;

    for (const action of actions) {
      let proposal = null;
      try {
        proposal = action.propose({ source: current, failingCount: observation.failingCount });
      } catch (error) {
        transcript.push({ step, phase: 'act', action: action.id, error: String(error.message || error) });
        continue;
      }
      if (!proposal || !proposal.source || proposal.source === current) {
        transcript.push({ step, phase: 'act', action: action.id, proposed: false });
        continue;
      }

      // Refusal 4: verified before kept, always.
      const after = runSuite(proposal.source);
      // Refusal 1: monotonic progress, or roll back.
      const improved = after.failingCount < observation.failingCount;
      transcript.push({
        step,
        phase: 'verify',
        action: action.id,
        note: proposal.note || null,
        failingBefore: observation.failingCount,
        failingAfter: after.failingCount,
        accepted: improved
      });
      if (!improved) continue;   // rolled back: `current` is simply not replaced

      current = proposal.source;
      observation = after;
      acceptedThisPass = true;

      if (after.passed) {
        return {
          completed: true,
          reason: 'the suite is green and every step was verified',
          steps: step,
          source: current,
          transcript,
          seconds: Math.round((Date.now() - started) / 1000),
          externalModelCalls: 0
        };
      }
    }

    // Refusal 2: a pass that accepted nothing means the loop has nothing left to offer.
    if (!acceptedThisPass) {
      return {
        completed: false,
        reason: 'no action produced a verified improvement; stopping rather than wandering',
        steps: step,
        failingCount: observation.failingCount,
        source: current,
        transcript,
        seconds: Math.round((Date.now() - started) / 1000),
        externalModelCalls: 0
      };
    }
  }

  // Refusal 3: the hard bound.
  return {
    completed: false,
    reason: `step budget of ${maxSteps} exhausted with ${observation.failingCount} test(s) still failing`,
    steps: step,
    failingCount: observation.failingCount,
    source: current,
    transcript,
    seconds: Math.round((Date.now() - started) / 1000),
    externalModelCalls: 0
  };
}

/**
 * Describe a run from its transcript, for the claim lane.
 *
 * Past tense about what happened, counts drawn from the transcript rather than asserted, and rejected
 * steps reported alongside accepted ones. Same discipline as the execution-claim lane: no statement
 * quantifies over anything, and a loop that stopped short says so in the same sentence as its progress.
 */
function summarizeRun(result) {
  const verifications = result.transcript.filter(t => t.phase === 'verify');
  const accepted = verifications.filter(t => t.accepted);
  const rejected = verifications.filter(t => !t.accepted);
  const first = result.transcript.find(t => t.phase === 'observe');

  const parts = [];
  parts.push(`I started with ${first.failingCount} failing test${first.failingCount === 1 ? '' : 's'}.`);
  parts.push(`I tried ${verifications.length} change${verifications.length === 1 ? '' : 's'}, `
    + `kept ${accepted.length} and rolled back ${rejected.length}.`);
  if (result.completed) parts.push('The suite is green, and every change I kept was verified before I kept it.');
  else parts.push(`I stopped without finishing: ${result.reason}.`);
  return parts.join(' ');
}

module.exports = { DEFAULT_MAX_STEPS, runAgenticLoop, summarizeRun };
