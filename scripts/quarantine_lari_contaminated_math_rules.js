#!/usr/bin/env node
'use strict';

/**
 * Quarantine test-set-fitted math rules out of a Lari model.
 *
 * Background: 875 of 916 records in `lariMathReasoning.policies` were synthesized by
 * searching arithmetic expression space until the result matched a GSM8K **test-set** gold
 * answer, then keying that expression to the proper nouns of that one question. Each such
 * record carries a `minedFrom` back-reference containing the gold label it was fitted to.
 * See LARI_INDEPENDENT_AUDIT_2026-07-24.md §3 and LARI_REALITY_AUDIT_AND_PLAN_2026-07-25.md §1.
 *
 * Those records are stored test labels, not learned knowledge. While they remain in model
 * state, no math number the model produces is interpretable. This script moves them out.
 *
 * Quarantine, not deletion: the records are written to a quarantine file with provenance so
 * the contamination remains auditable and the operation stays reversible.
 *
 * Usage:
 *   node scripts/quarantine_lari_contaminated_math_rules.js --dry-run
 *   node scripts/quarantine_lari_contaminated_math_rules.js
 *   node scripts/quarantine_lari_contaminated_math_rules.js --model-path <path>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MODEL_PATH = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const QUARANTINE_DIR = path.join(ROOT, 'consolidation', 'contamination-quarantine');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseArgs(argv) {
  const args = { dryRun: false, modelPath: DEFAULT_MODEL_PATH, skipBackup: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--skip-backup') args.skipBackup = true;
    else if (token === '--model-path') {
      if (!argv[index + 1]) throw new Error('--model-path requires a value.');
      args.modelPath = path.resolve(argv[++index]);
    } else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function isContaminated(record) {
  return Boolean(record && typeof record === 'object' && record.minedFrom);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Quarantine test-set-fitted math rules out of a Lari model.');
    console.log('  --dry-run       report what would change, write nothing');
    console.log('  --model-path    target a model other than the active one');
    console.log('  --skip-backup   do not write a .backup copy (not recommended)');
    return;
  }

  if (!fs.existsSync(args.modelPath)) throw new Error(`Model not found: ${args.modelPath}`);

  const originalBuffer = fs.readFileSync(args.modelPath);
  const beforeHash = sha256(originalBuffer);
  const model = JSON.parse(originalBuffer.toString('utf8'));

  const policies = model?.lariMathReasoning?.policies;
  if (!Array.isArray(policies)) {
    throw new Error('Expected lariMathReasoning.policies to be an array; model shape has changed.');
  }

  const contaminated = policies.filter(isContaminated);
  const clean = policies.filter(record => !isContaminated(record));

  const summary = {
    modelPath: args.modelPath,
    modelHashBefore: beforeHash,
    policiesBefore: policies.length,
    quarantined: contaminated.length,
    policiesAfter: clean.length,
    dryRun: args.dryRun
  };

  if (contaminated.length === 0) {
    console.log(JSON.stringify({ ...summary, result: 'already-clean' }, null, 2));
    return;
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      ...summary,
      result: 'dry-run',
      sampleQuarantinedIds: contaminated.slice(0, 5).map(record => record.id),
      sampleStoredGoldLabels: contaminated.slice(0, 5).map(record => record.minedFrom?.expected)
    }, null, 2));
    return;
  }

  fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (!args.skipBackup) {
    const backupPath = `${args.modelPath}.backup-${stamp}`;
    fs.writeFileSync(backupPath, originalBuffer);
    summary.backupPath = backupPath;
  }

  const quarantinePath = path.join(QUARANTINE_DIR, `gsm8k-fitted-math-rules-${stamp}.json`);
  fs.writeFileSync(quarantinePath, JSON.stringify({
    schemaVersion: 1,
    kind: 'lari.contamination.quarantine',
    reason: 'Records were fitted to individual GSM8K test-set items using that item\'s gold answer. '
      + 'They are stored test labels, not learned knowledge, and make every math metric uninterpretable.',
    audit: [
      'LARI_INDEPENDENT_AUDIT_2026-07-24.md#3',
      'LARI_REALITY_AUDIT_AND_PLAN_2026-07-25.md#1'
    ],
    quarantinedAt: new Date().toISOString(),
    sourceModelPath: path.relative(ROOT, args.modelPath).replace(/\\/g, '/'),
    sourceModelHash: beforeHash,
    recordCount: contaminated.length,
    records: contaminated
  }, null, 2) + '\n');

  model.lariMathReasoning.policies = clean;

  const updatedBuffer = Buffer.from(JSON.stringify(model, null, 2) + '\n', 'utf8');
  fs.writeFileSync(args.modelPath, updatedBuffer);

  summary.quarantinePath = path.relative(ROOT, quarantinePath).replace(/\\/g, '/');
  summary.modelHashAfter = sha256(updatedBuffer);
  summary.result = 'quarantined';
  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || String(error));
  process.exit(1);
}
