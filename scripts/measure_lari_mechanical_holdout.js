#!/usr/bin/env node
'use strict';

/**
 * Measure verified mutation repair against a sealed mechanical TEST set.
 *
 * This runs once against a set whose bugs were chosen by a seeded PRNG rather than by hand, and whose
 * oracle is the project's own suite. Half its instances belong to operator classes the repair engine
 * has no family for, so the ceiling is below 100% by construction and the seal forbids adding a family
 * to chase it.
 *
 * Each candidate costs a full upstream suite run, so a candidate budget applies and is reported with
 * the result. A budget is a real constraint rather than a concession: an unbounded search that
 * eventually stumbles on a fix is not a useful capability.
 *
 * Usage:
 *   node scripts/measure_lari_mechanical_holdout.js --manifest holdouts/mechanical-testset-20260725/manifest.json
 *   node scripts/measure_lari_mechanical_holdout.js --manifest <path> --limit 80
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const mutationRepair = require(path.join(ROOT, 'swarm_mutation_repair.js'));
const { createResidentVerifier } = require(path.join(ROOT, 'scripts', 'lari_resident_verifier_client.js'));
const { classifyRepair, summarizeRepairs } = require(path.join(ROOT, 'scripts', 'lari_repair_classification.js'));
const coverageProbe = require(path.join(ROOT, 'scripts', 'lari_coverage_probe.js'));

function parseArgs(argv) {
  const args = { manifestPath: null, limit: 80, growth: true, modelPath: null, resident: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') args.manifestPath = path.resolve(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    // Control condition for the growth experiment: seed vocabulary only, no proposals.
    else if (argv[i] === '--no-growth') args.growth = false;
    // Load a grown vocabulary from a model copy. Without it the run uses the seed vocabulary,
    // which is the correct 'before' condition for a curriculum before/after measurement.
    else if (argv[i] === '--model') args.modelPath = path.resolve(argv[++i]);
    // Fall back to a cold pytest for stage 1. Slower by roughly 9x; kept because it is the
    // configuration every score before 2026-07-27 was measured under.
    else if (argv[i] === '--no-resident') args.resident = false;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.manifestPath) throw new Error('--manifest is required');
  return args;
}

function git(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function clearPycache(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (entry.name === '__pycache__') fs.rmSync(child, { recursive: true, force: true });
      else if (entry.name !== '.git') stack.push(child);
    }
  }
}

/**
 * Run the project's suite, defending against candidates that never terminate.
 *
 * Two defects made a real measurement run for 2h43m without finishing:
 *
 *   1. A 15-minute timeout. The suite normally completes in about five seconds, but a statement
 *      deletion (SDL) can remove a loop increment or exit condition and produce an infinite loop. Every
 *      such candidate then burned the full timeout, so one instance alone would have taken ~20 hours.
 *      A non-terminating candidate is simply a failed candidate; 90 seconds is already 18x the normal
 *      runtime.
 *   2. spawnSync's timeout kills the shell it started, not the python grandchildren underneath it.
 *      Eight orphaned pytest processes accumulated, each still burning CPU and competing with the run,
 *      which is why later instances got slower and slower.
 *
 * So: a short timeout, and an explicit sweep of python processes spawned during this call.
 */
function runSuite(repo, command) {
  clearPycache(repo);
  const startedAt = Date.now();
  const result = spawnSync(command, { cwd: repo, shell: true, encoding: 'utf8', timeout: 90000 });
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';

  if (timedOut) {
    // Reap grandchildren the shell left behind. Scoped to processes started after this call began, so
    // unrelated python on the machine is never touched.
    try {
      const iso = new Date(startedAt - 2000).toISOString();
      spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt [datetime]'${iso}' } | Stop-Process -Force -ErrorAction SilentlyContinue`
      ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    } catch (_) {
      // Best effort; a leaked process slows the run but does not corrupt the result.
    }
  }

  return {
    passed: result.status === 0,
    timedOut,
    text: String(result.stdout || '') + String(result.stderr || '')
  };
}

/**
 * Two-stage verification.
 *
 * The upstream suite takes about 14 seconds, so 80 candidates against 6 instances is roughly two
 * hours of wall clock -- almost all of it spent re-running 1317 passing tests to learn that a
 * candidate did not fix the one that was failing.
 *
 * Stage 1 runs only the tests that were failing before the repair. A candidate that does not fix
 * those cannot be the answer, and that check costs about a second. Stage 2 runs the complete suite,
 * and only a candidate that clears stage 1 ever gets there.
 *
 * This does not weaken the oracle. Acceptance still requires the full upstream suite to pass, so a
 * patch that fixes the target while breaking something else is still rejected -- which matters,
 * because that is precisely the overfitting failure a narrow oracle let through earlier today. Stage 1
 * is a filter on what is worth checking properly, not a substitute for checking.
 */
function makeTwoStageVerifier({ repo, fullCommand, failureText, applyPatch, resident }) {
  // Parameterised ids cannot be passed back to pytest (ANSI escapes and brackets do not survive the
  // shell), so the shared helper strips them -- and it falls back to collection-error files, which a
  // FAILED-only regex silently dropped along with the whole class of import-breaking defects.
  const baseIds = mutationRepair.failingTestTargets(failureText, 12);
  const fastCommand = (!resident && baseIds.length)
    ? `python -m pytest -q -o addopts= ${baseIds.map(id => JSON.stringify(id)).join(' ')}`
    : null;

  const stats = { fastRejections: 0, fullRuns: 0 };
  const verify = async patchedSource => {
    if (resident) {
      // The resident writes the candidate to disk itself, which is also what stage 2 then reads.
      // A candidate that does not terminate is bounded by the client and counted as a rejection.
      const fast = await resident.verify(patchedSource);
      if (fast?.passed !== true) {
        stats.fastRejections += 1;
        return { passed: false };
      }
    } else {
      applyPatch(patchedSource);
      if (fastCommand) {
        const fast = runSuite(repo, fastCommand);
        if (!fast.passed) {
          stats.fastRejections += 1;
          return { passed: false };
        }
      }
    }
    stats.fullRuns += 1;
    const full = runSuite(repo, fullCommand);
    return { passed: full.passed };
  };
  return { verify, stats, fastStageEnabled: Boolean(fastCommand) || Boolean(resident), testIds: baseIds };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));

  // Vocabulary under test: the seed set, or whatever a curriculum has grown into a model copy.
  let vocabulary = mutationRepair.DEFAULT_VOCABULARY;
  let vocabularySource = 'seed';
  // Priors must travel with the vocabulary they describe.
  //
  // A first transfer run loaded a grown vocabulary but passed familyPriors: null, and scored 0/5 on a
  // set the vocabulary provably covered -- the correct candidate was generated but never reached,
  // because one arithmetic rule competed with 64 seed rules for an 80-candidate budget. Growth widens
  // coverage and dilutes search at the same time; only the priors make the wider vocabulary usable.
  let familyPriors = null;
  if (args.modelPath) {
    const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
    const model = JSON.parse(fs.readFileSync(args.modelPath, 'utf8'));
    vocabulary = runtime.lariMutationVocabulary(model) || mutationRepair.DEFAULT_VOCABULARY;
    familyPriors = runtime.lariMutationFamilyPriors(model);
    vocabularySource = path.basename(args.modelPath);
  }
  const repo = manifest.repo.path;
  const command = manifest.oracle.command;

  const results = [];
  for (const instance of manifest.instances) {
    git(repo, ['checkout', '--', '.']);
    git(repo, ['clean', '-qfd']);
    clearPycache(repo);

    const targetPath = path.join(repo, instance.targetFile);
    const pristine = fs.readFileSync(targetPath, 'utf8');

    // Re-apply the sealed mutation.
    let seeded;
    if (instance.seed.deletion) {
      const lines = pristine.split(/\r?\n/);
      lines[instance.line - 1] = instance.seed.replace;
      seeded = lines.join('\n');
    } else {
      const lines = pristine.split(/\r?\n/);
      const line = lines[instance.line - 1];
      if (!line || !line.includes(instance.seed.find)) {
        results.push({ instance: instance.instance_id, error: 'seed anchor missing at sealed line' });
        continue;
      }
      lines[instance.line - 1] = line.replace(instance.seed.find, instance.seed.replace);
      seeded = lines.join('\n');
    }
    fs.writeFileSync(targetPath, seeded);

    const baseline = runSuite(repo, command);
    if (baseline.passed) {
      results.push({ instance: instance.instance_id, error: 'seeded suite is green; mutation ineffective on replay' });
      git(repo, ['checkout', '--', '.']);
      continue;
    }

    const started = Date.now();
    // The failing ids come from the baseline run, never inferred from the filename -- guessing them
    // produced three separate false diagnoses in one session.
    const residentIds = mutationRepair.failingTestTargets(baseline.text, 12);
    const resident = (args.resident && residentIds.length)
      ? createResidentVerifier({
        repo,
        targetRelative: instance.targetFile.split(path.sep).join('/'),
        testIds: residentIds,
        // What a restarted child restores, and what the file must hold before one starts: the seeded
        // defect, not whatever candidate a killed child left behind.
        baselineSource: seeded
      })
      : null;

    const staged = makeTwoStageVerifier({
      repo,
      fullCommand: command,
      failureText: baseline.text,
      applyPatch(patched) { fs.writeFileSync(targetPath, patched); },
      resident
    });
    let verifications = 0;
    // Recover scope from the suite's own report of which tests failed. A whole-project suite gives no
    // import signal by itself, and an assertion traceback names only the test file -- which is why an
    // earlier run scoped to the entire file and spent its budget nowhere near the defect.
    const failing = mutationRepair.failingTestReferences(baseline.text);

    // Spectrum localization: lines the failing tests actually execute. Direct evidence rather than
    // inference from names, and the only signal that works for module-level code. Failure here is
    // non-fatal -- the run simply falls back to the weaker heuristics.
    let coveredLines = [];
    let coverageSelector = 'none';
    try {
      const probe = coverageProbe.coveredLines({
        repo,
        targetFile: instance.targetFile,
        baselineText: baseline.text,
        mutationRepair
      });
      coveredLines = probe.lines;
      coverageSelector = probe.selector;
    } catch (_) {
      coveredLines = [];
    }


    const failingSource = failing.files.map(file => {
      try { return fs.readFileSync(path.join(repo, file), 'utf8'); } catch (_) { return ''; }
    }).join('\n');

    const outcome = await mutationRepair.repairByVerifiedMutationAsync({
      source: seeded,
      language: 'python',
      testSource: failingSource,
      testNames: failing.names,
      coveredLines,
      failureText: baseline.text,
      targetRelative: instance.targetFile,
      limit: args.limit,
      vocabulary,
      familyPriors,
      async verify(patched) {
        verifications += 1;
        const result = await staged.verify(patched);
        if (!result.passed) fs.writeFileSync(targetPath, seeded);
        return result;
      }
    });

    // Vocabulary growth. An exhausted search means the current vocabulary cannot express this
    // defect, so propose substitution rules for operators present in the suspicious region that no
    // existing rule covers, and try them. A proposal is only credited when the winning candidate came
    // from the newly proposed family, so a new rule cannot take credit for a seed rule's repair.
    let grownRule = null;
    if (args.growth && outcome.repaired !== true && outcome.regions?.length) {
      const growth = await mutationRepair.growVocabularyByProposal({
        source: seeded,
        regions: outcome.regions.map(r => ({ start: Math.max(0, Number(r.startLine || 1) - 1), end: Number(r.endLine || 0) })),
        vocabulary,
        language: 'python',
        testSource: failingSource,
        testNames: failing.names,
        coveredLines,
        failureText: baseline.text,
        targetRelative: instance.targetFile,
        async verify(patched) {
          verifications += 1;
          const result = await staged.verify(patched);
          if (!result.passed) fs.writeFileSync(targetPath, seeded);
          return result;
        }
      });
      if (growth.repaired) {
        Object.assign(outcome, growth.outcome);
        grownRule = growth.grownRule;
      }
    }

    const repairedLine = outcome.repaired
      ? (fs.readFileSync(targetPath, 'utf8').split(/\r?\n/)[outcome.line - 1] || '').trim().slice(0, 140)
      : null;

    // Whether the patch is the upstream code, decided from the winning candidate rather than from the
    // working tree.
    //
    // This used to read the target file inside the result record -- after the checkout below had
    // already restored it -- so it compared upstream against upstream and reported "restored" for
    // every repair, including one that passed the suite while differing from upstream. A field that
    // cannot report the interesting case is worse than no field: "patches match upstream exactly" is
    // a claim this repository makes, and it needs something that could have contradicted it.
    //
    // The repository is CRLF and the engine works on '\n'-joined lines, so compare line by line.
    const restoresUpstreamExactly = outcome.repaired && outcome.source
      ? (() => {
        const patchedLines = String(outcome.source).split('\n');
        const upstreamLines = pristine.split(/\r?\n/);
        return patchedLines.length === upstreamLines.length
          && patchedLines.every((line, index) => line === upstreamLines[index]);
      })()
      : null;

    // Stop the resident before touching the working tree: it holds the repository as its cwd and
    // restores the file it was started on when it shuts down.
    if (resident) await resident.stop();

    // Does the patched program still execute the line the defect was seeded on?
    //
    // The strongest available check that a repair is a repair. A patch can satisfy the suite by
    // making the defective code unreachable instead of correcting it, and the test result cannot tell
    // the difference: on _wcswidth.py:306 a deleted statement was "repaired" by flipping a guard four
    // lines above, and every test passed because the block stopped running.
    //
    // `lari_repair_classification.js` catches that only when the seeded class is out of range. This
    // sees it directly and works for in-range defects too, which was the gap that classifier could
    // not close. One coverage run per accepted repair, not per candidate.
    //
    // Runs after the resident stops and before the checkout below, so the working tree is this
    // function's to borrow. It restores what it found, and the checkout is the backstop.
    let defectLineCoveredAfterPatch = null;
    if (outcome.repaired && outcome.source && coveredLines.length) {
      defectLineCoveredAfterPatch = coverageProbe.defectLineStillExecuted({
        repo,
        targetFile: instance.targetFile,
        defectLine: instance.line,
        patchedSource: outcome.source,
        baselineText: baseline.text,
        mutationRepair,
        selector: coverageSelector === 'none' ? null : coverageSelector
      });
    }

    git(repo, ['checkout', '--', '.']);
    git(repo, ['clean', '-qfd']);
    clearPycache(repo);

    // A patch that passes the suite is not automatically a repair. See lari_repair_classification.js
    // for the case that forced this distinction -- an SDL defect scored repaired by a guard flip that
    // made the deleted statement unreachable, in all three conditions of the curriculum-leap run.
    const classification = classifyRepair({
      operator: instance.operator,
      coveredByEngine: instance.coveredByEngine,
      repaired: outcome.repaired,
      restoresUpstreamExactly,
      family: outcome.family,
      defectLineCoveredAfterPatch
    });

    results.push({
      instance: instance.instance_id,
      operator: instance.operator,
      coveredByEngine: instance.coveredByEngine,
      repaired: outcome.repaired,
      suspectEquivalent: classification.suspectEquivalent,
      suspectReason: classification.suspectReason,
      grewVocabulary: grownRule ? { family: grownRule.family, rule: grownRule.rule } : null,
      family: outcome.family,
      description: outcome.description,
      repairedLine,
      restoresUpstreamExactly,
      defectLineCoveredAfterPatch,
      coveredLineCount: coveredLines.length,
      coverageSelector,
      targetLineCovered: coveredLines.includes(instance.line),
      failingTestFiles: failing.files.length,
      failingTestNames: failing.names.slice(0, 4),
      verifications,
      fastRejections: staged.stats.fastRejections,
      fullSuiteRuns: staged.stats.fullRuns,
      fastStage: resident ? 'resident' : (staged.fastStageEnabled ? 'cold-pytest' : 'none'),
      residentMsPerCandidate: resident && resident.stats.requests
        ? Math.round(resident.stats.totalMs / resident.stats.requests) : null,
      // Candidates that did not terminate within the bound, and the restarts they cost. A run that
      // reports neither is a run where this never happened, not a run without the protection.
      nonHaltingCandidates: resident ? resident.stats.timeouts : null,
      residentRestarts: resident ? resident.stats.restarts : null,
      candidateCount: outcome.candidateCount,
      pooledCount: outcome.pooledCount,
      budget: args.limit,
      seconds: Math.round((Date.now() - started) / 1000)
    });
    console.log(JSON.stringify(results.at(-1), null, 2));
  }

  // Excluded instances are printed, not swallowed.
  //
  // Both `continue` paths above push an error record, and the per-instance print sits at the end of the
  // success path, so an excluded instance used to be invisible twice: absent from the log and absent
  // from the denominator. The blind humanize control printed "1/5" beside a declared ceiling of "4/8"
  // with nothing saying three instances had vanished, and it was caught by reading the log against the
  // manifest rather than by any check. If two conditions exclude different instances their scores are
  // not comparable at all, and nothing in the output would have revealed it.
  const excluded = results.filter(item => item.error);
  for (const item of excluded) console.log(JSON.stringify(item, null, 2));

  const scored = results.filter(item => !item.error);
  const repaired = scored.filter(item => item.repaired).length;
  const inRange = scored.filter(item => item.coveredByEngine);
  const inRangeRepaired = inRange.filter(item => item.repaired).length;
  const summary = summarizeRepairs(scored);

  console.log('\n' + JSON.stringify({
    benchmark: 'lari-mechanical-testset',
    holdout: manifest.id,
    seed: manifest.selection.seed,
    // What the oracle passed. Kept unchanged so this number stays comparable with every result
    // recorded before the classifier existed.
    score: `${repaired}/${scored.length}`,
    // The denominator's provenance, beside the denominator. `score` itself stays as-is so the
    // historical series remains comparable, but a reader must never have to reconstruct why it is
    // smaller than the set.
    instancesInManifest: manifest.instances.length,
    instancesScored: scored.length,
    instancesExcluded: excluded.length,
    exclusions: excluded.map(item => ({ instance: item.instance, reason: item.error })),
    // What survives classification. This is the capability number; quote this one.
    repairScore: summary.repairScore,
    suspectEquivalentRepairs: summary.suspectEquivalentRepairs,
    suspectEquivalentInstances: summary.suspectEquivalentInstances,
    declaredCeiling: manifest.expectedCeiling,
    inRangeScore: `${inRangeRepaired}/${inRange.length}`,
    outOfRangeRepaired: scored.filter(item => !item.coveredByEngine && item.repaired).length,
    // Patches that pass the suite while differing from upstream are the ones worth looking at: they
    // are where a weak oracle would show up.
    repairsMatchingUpstreamExactly: `${scored.filter(item => item.restoresUpstreamExactly === true).length}/${repaired}`,
    candidateBudget: args.limit,
    fastStage: args.resident ? 'resident verifier' : 'cold pytest',
    growthEnabled: args.growth,
    vocabularySource,
    priorsLoaded: Boolean(familyPriors),
    vocabularyFamilies: Object.keys(vocabulary).length,
    vocabularyRules: Object.values(vocabulary).reduce((sum, e) => sum + (e.rules?.length || 0), 0),
    vocabularyRulesGrown: scored.filter(item => item.grewVocabulary).length,
    oracle: manifest.oracle.kind,
    externalModelCalls: 0
  }, null, 2));
}

main().catch(error => { console.error(error.stack || String(error)); process.exit(1); });
