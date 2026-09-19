#!/usr/bin/env node
'use strict';

/**
 * Contamination guard for Lari model state.
 *
 * This exists because 875 of 916 math "policies" in the active model turned out to be
 * expressions fitted to individual GSM8K **test-set** items using that item's gold answer,
 * keyed to the question's proper nouns. That made the reported GSM8K score (0.7763) a
 * measurement of "how many test items do we have a stored rule for" rather than of capability.
 * The full honest score, once those records were removed, was 0.0038 (5/1319).
 *
 * See LARI_INDEPENDENT_AUDIT_2026-07-24.md §3 and LARI_REALITY_AUDIT_AND_PLAN_2026-07-25.md.
 *
 * The rule this enforces: model state may contain learned *procedures*, never stored *answers*.
 * The operator layer already asserts this per-record via `storesTestAnswers: false`; this makes
 * the same discipline global and mechanical.
 *
 * Checks:
 *   1. HARD  - no model record anywhere carries a `minedFrom` back-reference to a test item.
 *   2. HARD  - the known answer-fitting scripts refuse to run (must carry a refusal gate).
 *   3. WARN  - scripts that dump a test split together with its gold answers.
 *
 * Usage:
 *   node scripts/check_lari_contamination.js
 *   node scripts/check_lari_contamination.js --strict   (warnings also fail)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Records here are quarantined contamination, retained deliberately for auditability.
const EXCLUDED_DIRS = new Set(['contamination-quarantine', 'node_modules', '.git']);
const REGISTRY_PATH = path.join(ROOT, 'models', 'lari', 'registry.json');
const QUARANTINE_INDEX_PATH = path.join(ROOT, 'consolidation', 'recovery', 'contaminated-artifact-index.json');
const CANDIDATE_DIRS = [
  path.join(ROOT, 'consolidation', 'learning-candidates'),
  path.join(ROOT, 'consolidation', 'coding-learning-candidates'),
  path.join(ROOT, 'consolidation', 'arc-learning-candidates'),
  path.join(ROOT, 'consolidation', 'recovery', 'candidates')
];

const ANSWER_FITTING_SCRIPTS = [
  'benchmarks/run_lari_math_generic_policy_synthesizer_eval.js',
  'benchmarks/run_lari_math_auto_template_miner_eval.js',
  'benchmarks/run_lari_lm_training_daemon_eval.js',
  'benchmarks/run_lari_math_lab_eval.js'
];

const GATE_MARKER = 'LARI_CONTAMINATION_GATE';

function walkJson(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walkJson(path.join(dir, entry.name), results);
    } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('.backup-')) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

function countMinedFrom(filePath) {
  // String scan first: these files reach 30 MB+ and parsing every one is wasteful.
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.includes('"minedFrom"')) return 0;
  return (text.match(/"minedFrom"\s*:/g) || []).length;
}

function unboundBenchmarkRuntimeSkills(model = {}) {
  return (model.compiledSkills || []).filter(skill =>
    /^skill\.runtime\./.test(String(skill?.id || ''))
    && /^runtimeCapability\./.test(String(skill?.sourceKnowledgeId || ''))
    && Array.isArray(skill?.evidence?.invokingBenchmarks)
    && !skill?.lariExecution
  );
}

function directJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(directory, entry.name));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const strict = process.argv.includes('--strict');
  const hardFailures = [];
  const warnings = [];

  // 1. No stored test answers in model state.
  const modelFiles = walkJson(path.join(ROOT, 'models'));
  let scanned = 0;
  for (const filePath of modelFiles) {
    scanned += 1;
    const count = countMinedFrom(filePath);
    if (count > 0) {
      hardFailures.push({
        check: 'stored-test-answers',
        file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        detail: `${count} record(s) carry a minedFrom back-reference to a benchmark test item. `
          + 'Quarantine them: node scripts/quarantine_lari_contaminated_math_rules.js'
      });
    }
  }

  const activeModelPath = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
  const activeModel = readJson(activeModelPath);
  const unboundActiveSkills = unboundBenchmarkRuntimeSkills(activeModel || {});
  if (unboundActiveSkills.length) {
    hardFailures.push({
      check: 'unbound-benchmark-runtime-skills',
      file: 'models/lari/current/swarm-model.json',
      detail: `${unboundActiveSkills.length} compiled skill(s) were derived from benchmark call sites but have no verified execution contract.`
    });
  }

  // 2. Every discoverable candidate is either clean or explicitly quarantined in place.
  const quarantine = readJson(QUARANTINE_INDEX_PATH);
  const quarantinedPaths = new Set((quarantine?.artifacts || []).map(item => item.path));
  const candidateFiles = [...new Set(CANDIDATE_DIRS.flatMap(directJsonFiles))];
  let candidateFilesScanned = 0;
  let quarantinedCandidateCount = 0;
  for (const filePath of candidateFiles) {
    candidateFilesScanned += 1;
    const count = countMinedFrom(filePath);
    if (!count) continue;
    const relative = path.relative(ROOT, filePath).replace(/\\/g, '/');
    if (quarantinedPaths.has(relative)) {
      quarantinedCandidateCount += 1;
      continue;
    }
    hardFailures.push({
      check: 'unquarantined-candidate-test-answers',
      file: relative,
      detail: `${count} stored benchmark-answer back-reference(s) exist in a candidate that is not in the quarantine index.`
    });
  }

  // 3. The current rollback target must be clean before it can be considered usable.
  const registry = readJson(REGISTRY_PATH);
  const rollbackPath = registry?.previousModelPath ? path.resolve(ROOT, registry.previousModelPath) : null;
  let rollbackEligible = null;
  if (rollbackPath && fs.existsSync(rollbackPath)) {
    const count = countMinedFrom(rollbackPath);
    rollbackEligible = count === 0;
    if (count > 0) warnings.push({
      check: 'rollback-target-contaminated',
      file: path.relative(ROOT, rollbackPath).replace(/\\/g, '/'),
      detail: `${count} stored benchmark-answer back-reference(s); this rollback target must not be activated.`
    });
  }

  // 4. Answer-fitting scripts must be gated off.
  for (const relative of ANSWER_FITTING_SCRIPTS) {
    const filePath = path.join(ROOT, relative);
    if (!fs.existsSync(filePath)) continue; // Removed entirely is an acceptable outcome.
    if (!fs.readFileSync(filePath, 'utf8').includes(GATE_MARKER)) {
      hardFailures.push({
        check: 'ungated-answer-fitter',
        file: relative,
        detail: `This script fits rules to gold answers and must carry a ${GATE_MARKER} refusal gate.`
      });
    }
  }

  // 5. Advisory: dumping a test split alongside gold answers enables fitting.
  const benchDir = path.join(ROOT, 'benchmarks');
  if (fs.existsSync(benchDir)) {
    for (const name of fs.readdirSync(benchDir)) {
      if (!name.endsWith('.js') || !name.startsWith('run_')) continue;
      const filePath = path.join(benchDir, name);
      const text = fs.readFileSync(filePath, 'utf8');
      if (text.includes('dump_gsm8k_public') && /['"]test['"]/.test(text) && !text.includes(GATE_MARKER)) {
        warnings.push({
          check: 'test-split-gold-dump',
          file: `benchmarks/${name}`,
          detail: 'Dumps a test split together with gold answers. Evaluating on test is fine; '
            + 'persisting gold labels where a miner can read them is how the contamination happened.'
        });
      }
    }
  }

  const report = {
    check: 'lari-contamination-guard',
    passed: hardFailures.length === 0 && (!strict || warnings.length === 0),
    modelFilesScanned: scanned,
    candidateFilesScanned,
    quarantinedCandidateCount,
    unboundBenchmarkRuntimeSkillCount: unboundActiveSkills.length,
    rollbackEligible,
    hardFailures,
    warnings
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error.stack || String(error));
  process.exit(1);
}
