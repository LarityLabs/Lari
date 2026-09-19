#!/usr/bin/env node
'use strict';

/**
 * Commit a prediction, in writing, before a measurement runs.
 *
 * Rule 3 of this repository: predict and seal before measuring, including what result would count as
 * failure. A benchmark you cannot be wrong about teaches nothing, and every wrong prediction here has
 * been informative -- the track record is deliberately kept.
 *
 * Seals were hand-written JSON until now, which is exactly the kind of step that quietly stops
 * happening when a session is busy. This writes one from the manifest, hashes the inputs so the set
 * cannot be swapped afterwards, and refuses to overwrite a seal that already exists: a prediction you
 * can revise after seeing the result is not a prediction.
 *
 * Usage:
 *   node scripts/seal_lari_prediction.js --manifest <manifest.json> --prediction <prediction.json>
 *
 * The prediction file supplies `question`, `conditions`, `predicted`, `reasoning`, `falsifiable`
 * and any `caveats`. Everything else -- composition, hashes, timestamps -- is derived.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { manifestPath: null, predictionPath: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') args.manifestPath = path.resolve(argv[++i]);
    else if (argv[i] === '--prediction') args.predictionPath = path.resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.manifestPath) throw new Error('--manifest is required');
  if (!args.predictionPath) throw new Error('--prediction is required');
  return args;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));
  const prediction = JSON.parse(fs.readFileSync(args.predictionPath, 'utf8'));
  const out = args.out || path.join(path.dirname(args.manifestPath), 'seal-commitment.json');

  if (fs.existsSync(out)) {
    throw new Error(`A seal already exists at ${out}. A prediction that can be revised is not a prediction.`);
  }
  for (const field of ['question', 'predicted', 'reasoning', 'falsifiable']) {
    if (!prediction[field]) throw new Error(`prediction.${field} is required`);
  }

  const restricted = Array.isArray(manifest.selection?.restrictedToOperators)
    ? manifest.selection.restrictedToOperators : null;

  const activeModel = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
  const seal = {
    schemaVersion: 1,
    kind: 'lari.measurement.seal_commitment',
    holdout: manifest.id,
    sealedAt: new Date().toISOString(),
    role: restricted
      ? 'DECLARED TARGETED EXPERIMENT -- not a blind holdout'
      : 'blind holdout -- unrestricted operator classes, never diagnosed against',
    notABlindHoldout: restricted
      ? `Instances are restricted to ${restricted.join(', ')}, so the score is not a general capability number and must never be reported as one.`
      : undefined,
    design: {
      question: prediction.question,
      conditions: prediction.conditions || null,
      measurement: prediction.measurement || null,
      creditRule: prediction.creditRule || null,
      falsifiable: prediction.falsifiable
    },
    prediction: {
      predicted: prediction.predicted,
      reasoning: prediction.reasoning,
      recordedBeforeExecution: true
    },
    caveats: prediction.caveats || [],
    predictionTrackRecord: prediction.predictionTrackRecord || null,
    claims: {
      bugsSelectedMechanicallyNotByHand: true,
      selectionSeed: manifest.selection?.seed ?? null,
      candidateSitesConsidered: manifest.selection?.candidateSiteCount ?? null,
      regeneratedUntilCompositionWasFavourable: false,
      oracleIsUpstreamProjectSuite: true,
      oraclesAuthoredByMe: false,
      externalModelCallsAllowed: 0
    },
    inputs: {
      manifestSha256: sha256(args.manifestPath),
      activeModelSha256: fs.existsSync(activeModel) ? sha256(activeModel) : null
    },
    composition: (manifest.instances || []).map(instance => ({
      instance: instance.instance_id,
      operator: instance.operator,
      coveredByEngine: instance.coveredByEngine
    }))
  };

  fs.writeFileSync(out, JSON.stringify(seal, null, 2) + '\n');
  console.log(JSON.stringify({ sealed: out, holdout: seal.holdout, predicted: seal.prediction.predicted }, null, 2));
}

main();
