#!/usr/bin/env node
'use strict';

/**
 * Continuous vocabulary-growth curriculum.
 *
 * The growth mechanism is proven -- a declared experiment measured 0/5 with growth disabled against
 * 5/5 with it enabled, on a defect class the seed vocabulary provably could not express. But it has
 * only ever run one defect at a time, as a benchmark. This runs it as a habit: mint practice defects
 * mechanically, attempt each one, propose and verify new rules where the vocabulary falls short, and
 * carry what survives into the next problem.
 *
 * That is the difference between "Lari can learn a rule" and "Lari has learned hundreds". It is
 * DreamCoder's wake-sleep shape applied to program repair, using the pieces already built: a generator
 * that can mint unlimited defects, an oracle nobody here controls, and a verified propose-retain loop.
 *
 * Discipline
 * ----------
 * - Practice defects are generated from their own seeds and are never drawn from a sealed set. The
 *   sealed sets exist to measure this, and training on them would make the measurement worthless.
 * - The active model is never touched. Vocabulary accrues in a copy passed with --model.
 * - Only rules that repaired a real defect through the project's own tests are retained, and only when
 *   the winning candidate came from the newly proposed family.
 * - What is retained is a substitution rule, never a file, line, or edit.
 *
 * Usage:
 *   node scripts/run_lari_growth_curriculum.js --repo <dir> --test-command "<cmd>" \
 *     --model <model-copy.json> --defects 20 --seed 4242 [--minutes 60]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const mutationRepair = require(path.join(ROOT, 'swarm_mutation_repair.js'));
const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
const { createResidentVerifier } = require(path.join(ROOT, 'scripts', 'lari_resident_verifier_client.js'));
const { coveredLinesForFailure } = require(path.join(ROOT, 'scripts', 'lari_coverage_localization.js'));

/**
 * Share of practice defects drawn from sites the vocabulary cannot yet repair.
 *
 * Three quarters, so most practice targets a real gap while the rest keeps producing honest
 * denominators for families that already work.
 */
const GAP_TARGET_SHARE = 0.75;

// Practice mutations. Deliberately spans classes the seed vocabulary cannot express, because those
// are the ones that force growth; a curriculum of already-solvable defects teaches nothing.
const PRACTICE_OPERATORS = [
  [' + ', ' - '], [' - ', ' + '], [' * ', ' + '], [' / ', ' * '], [' // ', ' / '], [' % ', ' // '],
  ['>=', '>'], ['<=', '<'], ['==', '!='], ['!=', '=='], [' and ', ' or '], [' or ', ' and '],
  [' & ', ' | '], [' | ', ' & '], ['max(', 'min('], ['min(', 'max(']
];

function parseArgs(argv) {
  const args = { repo: null, testCommand: null, modelPath: null, defects: 20, seed: 4242, minutes: 0, limit: 60, targetGaps: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--repo') args.repo = path.resolve(argv[++i]);
    else if (t === '--test-command') args.testCommand = argv[++i];
    else if (t === '--model') args.modelPath = path.resolve(argv[++i]);
    else if (t === '--defects') args.defects = Number(argv[++i]);
    else if (t === '--seed') args.seed = Number(argv[++i]);
    else if (t === '--minutes') args.minutes = Number(argv[++i]);
    else if (t === '--limit') args.limit = Number(argv[++i]);
    // Practise defects whose repair the vocabulary lacks. Off by default so a plain run stays a
    // uniform sample of the repository.
    else if (t === '--target-gaps') args.targetGaps = true;
    else throw new Error(`Unknown argument: ${t}`);
  }
  for (const required of ['repo', 'testCommand', 'modelPath']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function git(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

function runSuite(repo, command, timeout = 120000) {
  const result = spawnSync(command, { cwd: repo, shell: true, encoding: 'utf8', timeout });
  return { passed: result.status === 0, text: String(result.stdout || '') + String(result.stderr || '') };
}

function listSources(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['.git', '__pycache__', 'tests', 'test', 'docs', '.tox', 'build', 'dist'].includes(entry.name)) continue;
        stack.push(full);
      } else if (entry.name.endsWith('.py') && !entry.name.startsWith('test_') && entry.name !== 'setup.py') {
        out.push(full);
      }
    }
  }
  return out.sort();
}

// The resident verifier client is shared with the measurement path rather than copied. This function
// used to be a private copy with no request timeout, which is how a single non-halting candidate ran
// for 3h34m in a measurement run; the curriculum had the same defect and had simply not hit it yet.

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = JSON.parse(fs.readFileSync(args.modelPath, 'utf8'));
  const random = mulberry32(args.seed);
  const deadline = args.minutes ? Date.now() + args.minutes * 60000 : Infinity;

  git(args.repo, ['checkout', '--', '.']);
  git(args.repo, ['clean', '-qfd']);

  const baselineGreen = runSuite(args.repo, args.testCommand, 300000);
  if (!baselineGreen.passed) throw new Error('Baseline suite must be green before the curriculum starts.');

  const sources = listSources(args.repo);
  const startedVocabulary = Object.keys(runtime.lariMutationVocabulary(model) || {}).length;
  const log = [];
  let attempted = 0;
  let repaired = 0;
  let grown = 0;

  while (attempted < args.defects && Date.now() < deadline) {
    // Recomputed each defect: the vocabulary grows during the run, so what counts as a gap changes.
    const vocabulary = runtime.lariMutationVocabulary(model);
    const vocabularyPairs = new Set(
      Object.values(vocabulary || {}).flatMap(entry => (entry?.rules || []).map(rule => `${rule[0]}=>${rule[1]}`)));
    // Mint a practice defect: random file, random applicable site, random substitution.
    const file = sources[Math.floor(random() * sources.length)];
    const pristine = fs.readFileSync(file, 'utf8');
    const lines = pristine.split(/\r?\n/);
    const applicable = [];
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      for (const [from, to] of PRACTICE_OPERATORS) if (line.includes(from)) applicable.push({ index, from, to });
    });
    if (!applicable.length) continue;

    // Practise what the vocabulary cannot yet repair.
    //
    // Growth only fires when a defect's repair is outside the vocabulary, and minting defects
    // uniformly means most practice is either already repairable -- teaching nothing new -- or fails
    // for reasons that have nothing to do with vocabulary. Four runs and roughly five hours of compute
    // produced two rules that way.
    //
    // A defect that swaps `from` for `to` is repaired by the rule `to -> from`. So a site teaches
    // something new exactly when the vocabulary lacks that inverse. Preferring those sites is
    // curriculum design, not cheating: the defects are still mechanical, the oracle is still the
    // project's own suite, and what gets retained is still a generic rule. It is the difference
    // between practising randomly and practising what you cannot do yet.
    //
    // Not exclusive. A share stays uniform so the priors keep honest denominators for families that
    // already work -- a curriculum that only ever practises gaps would report success rates for
    // nothing else.
    const inverseMissing = ({ from, to }) => !vocabularyPairs.has(`${to}=>${from}`);
    const gaps = applicable.filter(inverseMissing);
    const pool = (args.targetGaps && gaps.length && random() < GAP_TARGET_SHARE) ? gaps : applicable;
    const site = pool[Math.floor(random() * pool.length)];
    const seeded = lines.map((line, index) => index === site.index ? line.replace(site.from, site.to) : line).join('\n');

    const relative = path.relative(args.repo, file).replace(/\\/g, '/');
    fs.writeFileSync(file, seeded);

    // Does it actually break anything? An equivalent mutant teaches nothing.
    const broken = runSuite(args.repo, args.testCommand, 180000);
    if (broken.passed) { fs.writeFileSync(file, pristine); continue; }

    attempted += 1;
    // The failing ids come from the baseline, never guessed from the filename. Collection errors count
    // too: a mutant that breaks an import reports ERROR with no FAILED line, and discarding those
    // threw away 147 of 250 practice defects on inflection -- including the ones that teach the
    // arithmetic rules the vocabulary is missing.
    const failingIds = mutationRepair.failingTestTargets(broken.text, 8);
    if (!failingIds.length) { fs.writeFileSync(file, pristine); continue; }

    const verifier = createResidentVerifier({
      repo: args.repo, targetRelative: relative, testIds: failingIds, baselineSource: seeded
    });
    const verify = async patched => (await verifier.verify(patched))?.passed === true;

    const failureText = broken.text;
    const testSource = failingIds.map(id => {
      try { return fs.readFileSync(path.join(args.repo, id.split('::')[0]), 'utf8'); } catch (_) { return ''; }
    }).join('\n');

    // Coverage localization, the same signal the measurement path has always used.
    //
    // Without it the curriculum localized by imports and traceback alone, and on a 2,900-line module
    // that is not enough: the defect at __init__.py:2491 fell outside every region, so no rule for its
    // operators was proposed and the run recorded a growth failure that was really a localization
    // failure. Costs one traced test run per defect.
    const coverage = coveredLinesForFailure({
      repo: args.repo,
      targetRelative: relative,
      failureText,
      failingFiles: mutationRepair.failingTestReferences(failureText).files
    });
    const regions = mutationRepair.localizeRegions({
      source: seeded, testSource, failureText, targetRelative: relative,
      testNames: failingIds.map(id => (id.split('::')[1] || '')),
      coveredLines: coverage.coveredLines
    });

    let fixed = null;
    let grownRule = null;
    // Every candidate the search executes, across the seed pass and any growth proposals. This is
    // what turns priors into statistics: without the losing attempts a family that has ever won
    // scores 1.0 for ever, and a family that has never won is indistinguishable from one that always
    // fails. The search has always reported it; this loop used to throw it away.
    const executed = [];
    const search = options => mutationRepair.repairByVerifiedMutationAsync({
      source: seeded,
      language: 'python',
      testSource,
      testNames: failingIds.map(id => (id.split('::')[1] || '')),
      failureText,
      targetRelative: relative,
      limit: args.limit,
      verify: async patched => ({ passed: await verify(patched) }),
      ...options
    });

    // Priors are read per defect, not once per run, so a rule verified on defect three is already
    // ordering the search on defect four. This is where compounding actually happens.
    const seedPass = await search({ vocabulary, familyPriors: runtime.lariMutationFamilyPriors(model) });
    executed.push(...(seedPass.attempted || []));
    if (seedPass.repaired) fixed = seedPass;

    if (!fixed) {
      const growth = await mutationRepair.growVocabularyByProposal({
        source: seeded,
        regions,
        vocabulary,
        language: 'python',
        testSource,
        failureText,
        targetRelative: relative,
        testNames: failingIds.map(id => (id.split('::')[1] || '')),
        verify: async patched => ({ passed: await verify(patched) })
      });
      executed.push(...(growth.attempted || []));
      if (growth.repaired) { fixed = growth.outcome; grownRule = growth.grownRule; }
    }

    await verifier.stop();
    fs.writeFileSync(file, pristine);
    git(args.repo, ['checkout', '--', '.']);

    // What the search cost is worth recording whether or not it succeeded. A defect Lari cannot repair
    // still says which substitutions were ruled out here, and that is the denominator the ordering
    // needs. Written before the success branch so a failed practice defect is not silently free.
    runtime.retainLariMutationSearchStatistics(model, { attempted: executed, sourcePath: `curriculum:${relative}` });

    if (fixed) {
      repaired += 1;
      runtime.retainLariMutationRepairOperator(model, {
        family: fixed.family, language: 'python', attempted: executed, winningDescription: fixed.description,
        sourcePath: `curriculum:${relative}`
      });
      if (grownRule) {
        grown += 1;
        runtime.retainLariMutationVocabularyRule(model, {
          family: grownRule.family, rule: grownRule.rule, reason: grownRule.reason,
          sourcePath: `curriculum:${relative}`
        });
      }
    }
    // Persist after every defect, not only after a win: the search statistics from a failure are
    // exactly the denominators that were missing, and they are worthless if they never reach disk.
    fs.writeFileSync(args.modelPath, JSON.stringify(model, null, 2) + '\n');

    log.push({
      n: attempted, target: relative, line: site.index + 1,
      seeded: `${site.from.trim()} -> ${site.to.trim()}`,
      repaired: Boolean(fixed), via: fixed ? fixed.family : null,
      covered: coverage.coveredLines.length, localized: regions.some(r => site.index >= r.start && site.index < r.end),
      grewRule: grownRule ? grownRule.rule.map(x => x.trim()).join(' -> ') : null,
      vocabularySize: Object.keys(runtime.lariMutationVocabulary(model) || {}).length
    });
    console.log(JSON.stringify(log.at(-1)));
  }

  const finalVocabulary = runtime.lariMutationVocabulary(model) || {};
  console.log('\n' + JSON.stringify({
    benchmark: 'lari-growth-curriculum',
    seed: args.seed,
    defectsAttempted: attempted,
    repaired,
    rulesGrown: grown,
    // Disclosed in the result, because a gap-targeted curriculum is a different sample of the
    // repository and its repair rate must not be compared with a uniform run's.
    practiceSelection: args.targetGaps ? `gap-targeted (${GAP_TARGET_SHARE} of sites)` : 'uniform',
    vocabularyFamiliesBefore: startedVocabulary,
    vocabularyFamiliesAfter: Object.keys(finalVocabulary).length,
    totalRules: Object.values(finalVocabulary).reduce((sum, entry) => sum + (entry.rules?.length || 0), 0),
    model: path.relative(ROOT, args.modelPath).replace(/\\/g, '/'),
    activeModelUntouched: true,
    externalModelCalls: 0
  }, null, 2));
}

main().catch(error => { console.error(error.stack || String(error)); process.exit(1); });
