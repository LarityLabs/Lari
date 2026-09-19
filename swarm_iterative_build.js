'use strict';

/**
 * Building the way people actually ask for things: run it, look at it, say what is wrong, repeat.
 *
 * The first version of this demanded an executable acceptance check up front, which is correct and
 * unusable -- nobody writes a test before they can ask for anything. What people do instead is run it,
 * see what happened, and say "no, it should also do X". That is a perfectly good oracle; it just
 * arrives in pieces.
 *
 * So acceptance is a ladder, and each rung is automatic once it exists:
 *
 *   1. It parses. Free, and rules out most of what a search proposes.
 *   2. It runs without crashing on the invocation the user gave. Free.
 *   3. It produces output the user approved. Automatic *after* the user approves it once.
 *
 * The third rung is what makes iteration compound. Every time the user says "yes, that is right",
 * that input and that output become a fixed example, and every future candidate has to keep
 * satisfying it. The user never writes a test; they approve outputs, and the suite accumulates as a
 * side effect of asking for what they wanted. Ten rounds of "not quite" leave behind ten checks that
 * no later change can quietly break.
 *
 * The trap, and why rung 1 and 2 can never stand alone
 * ---------------------------------------------------
 * "It runs without errors" is satisfied by a program that does nothing at all. A loop rewarded only
 * for not crashing will converge on an empty file, confidently. That is the same vacuum this project
 * filled with gold answers once already, and it is why an approved example is required before a build
 * counts as anything: running is a filter, never an achievement.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;

/** Rung 1: does it parse at all. Cheap enough to run on every candidate before anything else. */
function parses(workspace, entry, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const result = spawnSync(`python -m py_compile "${entry}"`, {
    cwd: workspace, shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true
  });
  return { passed: result.status === 0, output: String(result.stderr || '').slice(-800) };
}

/** Rung 2: does it run. A crash is a fact about the candidate; a missing interpreter is not. */
function runs(workspace, command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const result = spawnSync(command, {
    cwd: workspace, shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true
  });
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  const output = (String(result.stdout || '') + String(result.stderr || '')).slice(-4000);
  const cannotRun = /can'?t open file|No such file or directory|is not recognized as an internal|command not found/i.test(output);
  return {
    passed: result.status === 0 && !timedOut && !cannotRun,
    harnessBroken: cannotRun,
    timedOut,
    stdout: String(result.stdout || ''),
    output
  };
}

/**
 * Rung 3: everything the user has already approved must still hold.
 *
 * Examples are compared on trimmed stdout, because trailing whitespace is not what anyone meant when
 * they said the output was right.
 */
function satisfiesApprovedExamples(workspace, examples = [], options = {}) {
  for (const example of examples) {
    const attempt = runs(workspace, example.command, options);
    if (!attempt.passed) return { passed: false, failed: example, reason: 'stopped running', output: attempt.output };
    if (attempt.stdout.trim() !== String(example.output).trim()) {
      return { passed: false, failed: example, reason: 'output changed', got: attempt.stdout.trim().slice(0, 400) };
    }
  }
  return { passed: true };
}

/**
 * Record an output the user accepted.
 *
 * This is the only place a build gains a real criterion, and it is the user who supplies it simply by
 * approving. Stored with what produced it so it can be replayed exactly.
 */
function approveExample(session, { command, output, note = '' }) {
  session.examples = session.examples || [];
  const existing = session.examples.find(example => example.command === command);
  const record = {
    command,
    output: String(output).trim(),
    note: String(note).slice(0, 200),
    approvedAt: new Date().toISOString()
  };
  if (existing) Object.assign(existing, record);
  else session.examples.push(record);
  return record;
}

/**
 * The composite check a candidate must pass, given everything approved so far.
 *
 * Ordered cheapest first: parsing rejects most proposals for nothing, and only what survives is worth
 * running. `accepted` is deliberately false until at least one example exists -- a candidate that
 * merely runs has demonstrated nothing.
 */
function evaluateCandidate(workspace, session, options = {}) {
  const parsed = parses(workspace, session.entry, options);
  if (!parsed.passed) return { accepted: false, rung: 'parse', output: parsed.output };

  const ran = runs(workspace, session.command, options);
  if (ran.harnessBroken) return { accepted: false, rung: 'harness', output: ran.output, harnessBroken: true };
  if (!ran.passed) return { accepted: false, rung: 'run', output: ran.output };

  const examples = satisfiesApprovedExamples(workspace, session.examples || [], options);
  if (!examples.passed) return { accepted: false, rung: 'approved-example', output: examples.output || examples.got, failed: examples.failed };

  return {
    accepted: (session.examples || []).length > 0,
    rung: (session.examples || []).length ? 'approved-example' : 'runs-only',
    output: ran.stdout,
    // Said plainly so a caller cannot mistake "it ran" for "it is right".
    note: (session.examples || []).length ? null : 'runs without error, but nothing has been approved yet'
  };
}

/** A build session: what is being built, how it is run, and what the user has approved so far. */
function startSession({ entry, command, spec = '' }) {
  return { entry, command, spec, examples: [], rounds: [] };
}

/**
 * One round of iteration: propose candidates, keep the first that clears every rung.
 *
 * The user's part is what happens between rounds -- running it, looking, approving or objecting. This
 * only does the machine's part, and it reports which rung stopped it so the next round has something
 * to go on.
 */
async function iterate(workspace, session, {
  mutationRepair,
  projectSources = null,
  limit = 200,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const repair = mutationRepair || require('./swarm_mutation_repair.js');
  const entryPath = path.join(workspace, session.entry);
  const before = fs.readFileSync(entryPath, 'utf8');
  const baseline = evaluateCandidate(workspace, session, { timeoutMs });

  let accepted = null;
  let attempts = 0;
  const outcome = await repair.repairByVerifiedMutationAsync({
    source: before,
    language: /\.py$/.test(session.entry) ? 'python' : 'javascript',
    failureText: baseline.output || '',
    targetRelative: session.entry,
    coveredLines: before.split(/\r?\n/).map((_, index) => index + 1),
    limit,
    projectSources,
    familyPriors: null,
    verify(candidate) {
      attempts += 1;
      fs.writeFileSync(entryPath, candidate);
      const check = evaluateCandidate(workspace, session, { timeoutMs });
      if (check.accepted) accepted = candidate;
      else fs.writeFileSync(entryPath, before);
      return { passed: check.accepted };
    }
  });

  if (accepted) fs.writeFileSync(entryPath, accepted);
  const round = {
    accepted: Boolean(accepted),
    attempts,
    via: outcome.description || null,
    stoppedAt: accepted ? null : baseline.rung,
    examplesHeld: (session.examples || []).length
  };
  session.rounds.push(round);
  return { ...round, implementation: accepted, externalModelCalls: 0 };
}

/** How far up the ladder a candidate got. Higher is strictly better. */
const RUNGS = { parse: 0, harness: 0, run: 1, 'approved-example': 2, 'runs-only': 2 };
function rungOf(evaluation) {
  if (evaluation.accepted) return 3;
  return RUNGS[evaluation.rung] ?? 0;
}

/**
 * Build over several rounds, keeping anything that climbs.
 *
 * One candidate is one edit, and a working program usually needs several pieces -- the import, the
 * definition, the call. A single-edit search cannot assemble that, which is why a stub with a stated
 * expectation produced ten attempts and no acceptance.
 *
 * The ladder is the way out, because it is a gradient where pass/fail is not. A candidate that takes
 * the file from "does not parse" to "runs" has made real progress even though it is not finished, so
 * it is kept and the next round builds on it. That turns an all-or-nothing search into hill climbing,
 * and lets several edits accumulate.
 *
 * The risk is obvious and is handled at the end rather than during: climbing rewards a program that
 * merely runs, and the emptiest program runs best. So a session is only reported as built when the
 * approved examples pass. Progress is allowed to be partial; success is not.
 */
async function buildIteratively(workspace, session, options = {}) {
  const entryPath = path.join(workspace, session.entry);
  const rounds = [];
  let best = rungOf(evaluateCandidate(workspace, session, options));

  for (let round = 0; round < (options.rounds || 4); round += 1) {
    const before = fs.readFileSync(entryPath, 'utf8');
    let climbed = null;
    let climbedTo = best;
    let attempts = 0;

    const repair = options.mutationRepair || require('./swarm_mutation_repair.js');
    await repair.repairByVerifiedMutationAsync({
      source: before,
      language: /\.py$/.test(session.entry) ? 'python' : 'javascript',
      failureText: session.lastFailure || '',
      targetRelative: session.entry,
      coveredLines: before.split(/\r?\n/).map((_, index) => index + 1),
      limit: options.limit || 200,
      projectSources: options.projectSources || null,
      familyPriors: null,
      verify(candidate) {
        attempts += 1;
        fs.writeFileSync(entryPath, candidate);
        const evaluation = evaluateCandidate(workspace, session, options);
        const height = rungOf(evaluation);
        if (height > climbedTo) { climbedTo = height; climbed = candidate; }
        fs.writeFileSync(entryPath, before);
        // Only a finished build stops the search; a climb is recorded and the search continues.
        return { passed: evaluation.accepted };
      }
    });

    if (climbed) fs.writeFileSync(entryPath, climbed);
    const evaluation = evaluateCandidate(workspace, session, options);
    session.lastFailure = evaluation.output || '';
    rounds.push({ round: round + 1, attempts, climbedTo, rung: evaluation.rung, accepted: evaluation.accepted });
    best = rungOf(evaluation);
    if (evaluation.accepted) break;
    if (!climbed) break;                              // no further progress available
  }

  const final = evaluateCandidate(workspace, session, options);
  return {
    built: final.accepted,
    rounds,
    rung: final.rung,
    implementation: final.accepted ? fs.readFileSync(entryPath, 'utf8') : null,
    externalModelCalls: 0
  };
}

module.exports = {
  parses,
  runs,
  satisfiesApprovedExamples,
  approveExample,
  evaluateCandidate,
  startSession,
  iterate,
  buildIteratively
};
