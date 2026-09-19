#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const consolidation = path.join(root, 'consolidation');
const sealedDir = path.join(consolidation, 'stage-4-sealed');
const sealedPath = path.join(sealedDir, 'developmental-holdouts.json');
const manifestPath = path.join(consolidation, 'stage-4-hidden-holdout-manifest.json');
const family = 'deterministic canonical-key compaction';
const expectedConcepts = ['normalize', 'trim', 'lowercase', 'punctuation', 'empty', 'deduplicate', 'deterministic', 'sort', 'idempotent', 'invariant'];
const cases = [
  { id: 'sealed-1', kind: 'holdout', prompt: 'Design a reusable procedure that canonicalizes aliases in an append-only operation journal so equivalent keys collapse to one stable identifier and rerunning compaction changes nothing.' },
  { id: 'sealed-2', kind: 'holdout', prompt: 'How should a cache namespace cleaner turn messy human labels into unique canonical keys with reproducible output across machines?' },
  { id: 'sealed-3', kind: 'holdout', prompt: 'Give the procedure for compacting inconsistent deployment artifact labels into a unique deterministic set while safely ignoring blank labels.' },
  { id: 'sealed-4', kind: 'holdout', prompt: 'A route catalog contains whitespace, case, and punctuation variants. Explain a general canonicalization algorithm whose second run is a no-op.' },
  { id: 'sealed-5', kind: 'holdout', prompt: 'Specify how to reconcile message topic aliases into one repeatable ordered key list, including checks that prove the transformation is stable.' },
  { id: 'sealed-x1', kind: 'cross-context', prompt: 'For filenames arriving from different operating systems, outline a deterministic procedure to normalize equivalent names, remove unusable results, and avoid duplicates.' },
  { id: 'sealed-x2', kind: 'cross-context', prompt: 'For database migration identifiers entered by several teams, describe a canonical compaction process and the invariants that make repeated execution safe.' }
].map(item => ({ ...item, expectedConcepts, minimumConceptHits: 8 }));

function canonical(value) { return JSON.stringify(value); }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function writeExclusive(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }

if (fs.existsSync(sealedPath) || fs.existsSync(manifestPath)) throw new Error('Stage 4 holdouts are already sealed.');
fs.mkdirSync(sealedDir, { recursive: true });
const sealedAt = new Date().toISOString();
const sealed = { schemaVersion: 1, family, sealedAt, cases };
writeExclusive(sealedPath, sealed);
const manifest = {
  schemaVersion: 1,
  stage: 4,
  family,
  sealedAt,
  sealedBeforeLearning: true,
  taskFamilySearchTerms: ['deterministic canonical-key compaction', 'stable-key journal reconciliation', 'terminal outcome precedence'],
  priorOccurrenceCount: 0,
  caseCount: cases.length,
  holdoutCount: cases.filter(item => item.kind === 'holdout').length,
  crossContextCount: cases.filter(item => item.kind === 'cross-context').length,
  cases: cases.map(item => ({ id: item.id, kind: item.kind, sha256: sha(canonical(item)) })),
  sealedPayload: { path: 'consolidation/stage-4-sealed/developmental-holdouts.json', sha256: sha(fs.readFileSync(sealedPath)) },
  learnerAccessPolicy: 'The learner process may consume only the training failure and may not read this sealed payload.'
};
writeExclusive(manifestPath, manifest);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
