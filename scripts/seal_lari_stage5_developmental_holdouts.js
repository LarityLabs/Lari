#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'consolidation', 'stage-5-sealed');
const payloadPath = path.join(dir, 'developmental-holdouts.json');
const manifestPath = path.join(root, 'consolidation', 'stage-5-developmental-holdout-manifest.json');
const expectedConcepts = ['parse', 'finite', 'reject', 'negative', 'multiply', 'quantity', 'unit weight', 'sum', 'round once', 'permutation', 'invariant'];
const cases = [
  { id: 'weighted-1', kind: 'holdout', prompt: 'Explain a reusable procedure for totaling storage usage records where each row has a quantity and a per-unit weight, including malformed and negative rows.' },
  { id: 'weighted-2', kind: 'holdout', prompt: 'How should energy samples with hours and unit draw be aggregated into one stable weighted total without order-dependent rounding?' },
  { id: 'weighted-3', kind: 'holdout', prompt: 'Describe a general method to calculate cargo mass from parcel counts and mass per parcel while safely handling invalid numeric input.' },
  { id: 'weighted-4', kind: 'holdout', prompt: 'Give the algorithm for combining material batch quantities with grams per unit, with deterministic precision and validation invariants.' },
  { id: 'weighted-5', kind: 'holdout', prompt: 'A cloud ledger records usage quantity and cost per unit. Specify a permutation-safe aggregation procedure and its verification checks.' },
  { id: 'weighted-x1', kind: 'cross-context', prompt: 'For nutrition planning, explain how servings and calories per serving should produce a verified weighted total despite bad rows.' },
  { id: 'weighted-x2', kind: 'cross-context', prompt: 'For labor estimation, describe how hours and rate per hour should be combined, validated, and rounded reproducibly.' }
].map(item => ({ ...item, expectedConcepts, minimumConceptHits: 9 }));
const shaValue = value => crypto.createHash('sha256').update(value).digest('hex');
if (fs.existsSync(payloadPath) || fs.existsSync(manifestPath)) throw new Error('Stage 5 developmental holdouts already sealed.');
fs.mkdirSync(dir, { recursive: true });
const sealedAt = new Date().toISOString();
const payload = { schemaVersion: 1, family: 'weighted unit aggregation', sealedAt, cases };
fs.writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
const manifest = {
  schemaVersion: 1, stage: 5, family: payload.family, sealedAt, sealedBeforeLearning: true,
  priorOccurrenceCount: 0, holdoutCount: 5, crossContextCount: 2,
  cases: cases.map(item => ({ id: item.id, kind: item.kind, sha256: shaValue(JSON.stringify(item)) })),
  sealedPayload: { path: 'consolidation/stage-5-sealed/developmental-holdouts.json', sha256: shaValue(fs.readFileSync(payloadPath)) },
  learnerAccessPolicy: 'Learner receives only one training failure and does not read this payload.'
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
