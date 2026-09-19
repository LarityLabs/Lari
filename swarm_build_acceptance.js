'use strict';

/**
 * The judge for building something, as opposed to fixing something.
 *
 * Lari's code generation today is ten regular expressions mapped to function bodies somebody typed
 * into the runtime: ask for a palindrome checker and it answers, ask for anything nobody anticipated
 * and it falls through. That is a lookup table, and adding more entries would make the demos pass
 * while measuring only how many cases were foreseen -- the same shape as the withdrawn maths score.
 *
 * What actually works in this project is a loop: propose a change, run a real check, keep it only if
 * the check passes. That loop has no opinion about whether the code it is improving already exists.
 * So building is treated as repair from a stub: start from something that plainly does not work, let
 * the verified-repair engine iterate, and accept only what the acceptance check accepts. Statement
 * insertion, added for deleted lines, is what makes this possible at all -- until then the engine
 * could only rewrite lines that were already there, and building requires adding them.
 *
 * The honesty rule, which is the entire point of the file
 * ------------------------------------------------------
 * An acceptance check must be executable and must come from the person asking, never from Lari. The
 * moment Lari writes its own success criteria it will write ones it passes, and every number after
 * that is worthless. This is the same boundary the repair engine keeps by using the project's own
 * suite instead of tests it authored.
 *
 * A task is therefore a specification plus a command that returns zero when the specification is met.
 * Nothing here inspects the check to work out what would satisfy it; the check is run, and its exit
 * status is the whole of its opinion.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * A build task.
 *
 * @typedef {object} BuildTask
 * @property {string} name
 * @property {string} spec            what is wanted, in the requester's words
 * @property {string} entry           file the implementation lives in, relative to the workspace
 * @property {string} acceptance      shell command; exit zero means the spec is met
 * @property {string} [stub]          starting content; defaults to something that plainly fails
 */

/** A starting point that fails honestly rather than one that looks half-finished. */
function defaultStub(task) {
  return `# ${task.spec}\n# Not implemented yet.\n`;
}

function runAcceptance(workspace, task, { timeoutMs = 120000 } = {}) {
  const started = Date.now();
  const result = spawnSync(task.acceptance, {
    cwd: workspace, shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true
  });
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  return {
    passed: result.status === 0 && !timedOut,
    timedOut,
    status: result.status,
    ms: Date.now() - started,
    output: (String(result.stdout || '') + String(result.stderr || '')).slice(-4000)
  };
}

/**
 * Prepare a workspace and confirm the task is honest before any building starts.
 *
 * Two checks, both refusals rather than warnings. A task whose acceptance passes against the stub is
 * not a task -- it asks for nothing, and building against it would record a success that means
 * nothing. A task whose acceptance cannot run at all is worse: every candidate would look like a
 * failure and the run would report an inability that belongs to the harness.
 */
function prepareBuild(workspace, task, options = {}) {
  fs.mkdirSync(path.dirname(path.join(workspace, task.entry)), { recursive: true });
  fs.writeFileSync(path.join(workspace, task.entry), task.stub || defaultStub(task));

  const baseline = runAcceptance(workspace, task, options);
  if (baseline.passed) {
    return { ready: false, reason: 'the acceptance check already passes against a stub, so it asks for nothing', baseline };
  }
  // An acceptance check that never ran is not an acceptance check that said no.
  //
  // Both exit non-zero and look identical from here, which is the same confusion that let a broken
  // verifier score 0 out of 87 earlier in this project while every run looked healthy. There is no
  // exit code for "your harness is wrong", so the shell's own complaints are read instead: a missing
  // script, an unrunnable command. Heuristic, and deliberately loud, because a run that cannot judge
  // must stop rather than report a score.
  const cannotRun = /can'?t open file|No such file or directory|is not recognized as an internal|command not found|ModuleNotFoundError: No module named ['"]?(?:pytest|unittest)/i
    .test(baseline.output);
  if (baseline.status === null || cannotRun) {
    return { ready: false, reason: 'the acceptance check could not be executed', baseline };
  }
  return { ready: true, baseline };
}

/**
 * Build by repair.
 *
 * The engine is handed the stub as the thing to fix and the acceptance output as the failure to
 * explain, exactly as it would be handed a broken module and a failing suite. Donor statements come
 * from whatever the requester made available -- their own project, a library, examples they trust --
 * because inventing a line is not something this engine can do and finding one usually is.
 *
 * Returns the accepted implementation or nothing. There is deliberately no partial credit: an app
 * that half works is an app that does not work, and a loop that reports progress on unaccepted code
 * is how a demo starts drifting away from the truth.
 */
async function buildUntilAccepted(workspace, task, {
  mutationRepair,
  projectSources = null,
  limit = 400,
  timeoutMs = 120000
} = {}) {
  const repair = mutationRepair || require('./swarm_mutation_repair.js');
  const prepared = prepareBuild(workspace, task, { timeoutMs });
  if (!prepared.ready) return { built: false, reason: prepared.reason, attempts: 0 };

  const entryPath = path.join(workspace, task.entry);
  const stub = fs.readFileSync(entryPath, 'utf8');
  let attempts = 0;
  let accepted = null;

  const outcome = await repair.repairByVerifiedMutationAsync({
    source: stub,
    language: /\.py$/.test(task.entry) ? 'python' : 'javascript',
    failureText: prepared.baseline.output,
    targetRelative: task.entry,
    // The whole stub is the region: there is no localization to be had in a file that does nothing.
    coveredLines: stub.split(/\r?\n/).map((_, index) => index + 1),
    limit,
    projectSources,
    familyPriors: null,
    verify(candidate) {
      attempts += 1;
      fs.writeFileSync(entryPath, candidate);
      const check = runAcceptance(workspace, task, { timeoutMs });
      if (check.passed) accepted = candidate;
      else fs.writeFileSync(entryPath, stub);
      return { passed: check.passed };
    }
  });

  if (accepted) fs.writeFileSync(entryPath, accepted);
  return {
    built: Boolean(accepted),
    reason: accepted ? null : 'nothing proposed satisfied the acceptance check',
    implementation: accepted,
    attempts,
    family: outcome.family || null,
    description: outcome.description || null,
    externalModelCalls: 0
  };
}

module.exports = { defaultStub, runAcceptance, prepareBuild, buildUntilAccepted };
