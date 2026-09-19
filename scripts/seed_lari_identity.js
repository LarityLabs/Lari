#!/usr/bin/env node
'use strict';
// Seeds Lari's self-identity as retained learned knowledge records via the
// normal ingestKnowledge path (the same path Lari itself uses when it learns).
// Identity answers are then served from retained state, not from web-style
// retrieval. Idempotent: record ids are deterministic from topic+source, so
// re-running replaces rather than duplicates.
// Usage: node scripts/seed_lari_identity.js [--dry-run]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime');

const root = path.resolve(__dirname, '..');
const modelPath = path.join(root, 'models', 'lari', 'current', 'swarm-model.json');
const dryRun = process.argv.includes('--dry-run');

const md5 = file => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');

const IDENTITY_FACTS = [
  {
    topic: 'Lari self-identity: name',
    summary: 'Lari, pronounced "Larry" (he/him)',
    confidence: 0.97
  },
  {
    topic: 'Lari self-identity: what',
    summary: 'a local personal AI model. LARI stands for Local Autonomous Recursive Intelligence, and the swarm runtime is the model: tools, memory, skills, and self-growth are all part of the same local system, so I answer from local retained knowledge with zero external model calls',
    confidence: 0.95
  },
  {
    topic: 'Lari self-identity: creator',
    summary: 'built by Greg Betti',
    confidence: 0.97
  },
  {
    topic: 'Lari self-identity: capabilities',
    summary: 'I can chat, learn from corrections, research and verify claims, remember your preferences, and work on local files when you link a workspace. I also handle coding tasks: reading code, fixing bugs, and running tests.',
    confidence: 0.9
  }
];

function main() {
  const before = md5(modelPath);
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const seeded = [];
  for (const fact of IDENTITY_FACTS) {
    const result = runtime.ingestKnowledge(model, {
      topic: fact.topic,
      summary: fact.summary,
      confidence: fact.confidence,
      sourceAdapter: 'developer_seeded_identity',
      sources: [{ kind: 'developer_statement', note: 'Identity facts stated by Greg Betti, the developer, during Lari chat-improvement work on 2026-09-19.' }]
    });
    seeded.push({ topic: fact.topic, recordId: result.lariTypedRecordId });
  }
  if (!dryRun) {
    const tmp = `${modelPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(model));
    fs.renameSync(tmp, modelPath);
  }
  const after = dryRun ? before : md5(modelPath);
  console.log(JSON.stringify({ dryRun, md5Before: before, md5After: after, seeded }, null, 2));
}

main();
