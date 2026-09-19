#!/usr/bin/env node
'use strict';

/**
 * Recover the unique, non-benchmark knowledge from the frozen pre-audit state into the canonical
 * typed learned-record ledger. This is a one-way candidate builder: it never writes the active model,
 * registry, source snapshot, or an existing candidate.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const SOURCE = path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'candidates',
  'f8ccf06bb908e94b22b76a1b9efd94f38b90c9b6056918cec494fb06c28a662d.json');
const OUT_DIR = path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'recovery-candidates');
const REPORT = path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'knowledge-recovery-report.json');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const stable = value => JSON.stringify(value, Object.keys(value || {}).sort());
const tokens = value => [...new Set(String(value || '').toLowerCase().match(/[a-z0-9_]+/g) || [])]
  .filter(token => token.length > 1).sort();

function payloadFor(entry, model) {
  const topic = entry.kind === 'lexical_fact'
    ? `${entry.relation} of ${entry.subject}`
    : `observed execution of ${entry.subject}`;
  const summary = entry.kind === 'lexical_fact'
    ? `${entry.subject}: ${entry.relation} = ${entry.value}`
    : `${entry.expression} ${entry.outcome} ${entry.value}`;
  const procedure = entry.kind === 'lexical_fact'
    ? [`Answer only the recorded ${entry.relation} relation for ${entry.subject}.`, 'State that the fact comes from its retained curated source.']
    : [`Report the exact observed invocation ${entry.expression}.`, 'Do not generalize the observation to other inputs.'];
  const conceptTokens = tokens(`${topic} ${summary}`);
  return {
    ...entry,
    id: `audit.knowledge.${sha(stable(entry)).slice(0, 24)}`,
    topic,
    summary,
    procedure,
    conceptTokens,
    confidence: entry.kind === 'execution_observation' ? 0.92 : 0.78,
    embedding: runtime.embedText(`${topic} ${summary} ${procedure.join(' ')}`),
    embeddingModel: 'html-swarm-inhouse-semantic-v2'
  };
}

function typedRecord(entry, model, sourceHash, importedAt) {
  const payload = payloadFor(entry, model);
  const normalizedTriggers = tokens(`${payload.topic} ${payload.summary}`);
  const contentHash = sha(stable(entry));
  return {
    schemaVersion: 1,
    id: `lari.learned.knowledge.${contentHash.slice(0, 24)}`,
    type: 'knowledge',
    status: 'active',
    normalizedTriggers,
    procedureIdentity: sha(`${entry.kind}|${entry.subject}|${entry.relation || ''}|${entry.expression || ''}`),
    semanticFingerprint: sha(normalizedTriggers.join('|')),
    outputBehavior: sha(`${entry.outcome || entry.relation || ''}|${entry.value || ''}`),
    contentHash,
    behavioralSignature: sha(`${entry.kind}|${entry.subject}|${entry.outcome || entry.relation || ''}|${entry.value || ''}`),
    confidence: payload.confidence,
    provenance: {
      sourceModelHash: sourceHash,
      sourcePath: path.relative(ROOT, SOURCE).replace(/\\/g, '/'),
      originalRecordId: payload.id,
      sourceKind: 'knowledge',
      creationSource: entry.kind === 'execution_observation' ? 'deterministic_local_execution' : 'curated_lexical_resource',
      benchmarkAssociation: [],
      confidence: payload.confidence,
      imported: true,
      importTimestamp: importedAt,
      storesTestAnswers: false
    },
    payload
  };
}

function main() {
  if (!fs.existsSync(BASE) || !fs.existsSync(SOURCE)) throw new Error('Frozen base or source is missing.');
  const baseBytes = fs.readFileSync(BASE);
  const sourceBytes = fs.readFileSync(SOURCE);
  const base = JSON.parse(baseBytes);
  const source = JSON.parse(sourceBytes);
  const importedAt = new Date().toISOString();
  const sourceHash = sha(sourceBytes);
  const expectedSourceHash = path.basename(SOURCE, '.json');
  if (sourceHash !== expectedSourceHash) throw new Error('Frozen source hash does not match its immutable filename.');

  const sourceEntries = Array.isArray(source.knowledge) ? source.knowledge : [];
  const candidates = sourceEntries
    .filter(entry => ['execution_observation', 'lexical_fact'].includes(entry?.kind))
    .map(entry => typedRecord(entry, base, sourceHash, importedAt));
  const existing = new Map((base.lariLearnedRecords?.records || []).map(record => [record.contentHash, record]));
  const imported = candidates.filter(record => !existing.has(record.contentHash));
  const duplicates = candidates.filter(record => existing.has(record.contentHash));
  const candidate = JSON.parse(JSON.stringify(base));
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  candidate.lariLearnedRecords.records = [...imported, ...candidate.lariLearnedRecords.records];
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: sha(baseBytes),
    migrationSourceHash: sourceHash,
    migrationKind: 'audit-knowledge-recovery',
    promoted: false,
    createdAt: importedAt
  };
  candidate.knowledge = [];

  const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  const candidateHash = sha(serialized);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const candidatePath = path.join(OUT_DIR, `${candidateHash}.json`);
  if (fs.existsSync(candidatePath)) {
    if (shaFile(candidatePath) !== candidateHash) throw new Error('Existing candidate does not match its filename hash.');
  } else {
    fs.writeFileSync(candidatePath, serialized, { encoding: 'utf8', flag: 'wx' });
  }
  const byKind = Object.fromEntries(['execution_observation', 'lexical_fact'].map(kind => [
    kind,
    imported.filter(record => record.payload.kind === kind).length
  ]));
  const report = {
    schemaVersion: 1,
    kind: 'lari.audit-knowledge-recovery',
    createdAt: importedAt,
    promoted: false,
    base: { path: path.relative(ROOT, BASE).replace(/\\/g, '/'), sha256: sha(baseBytes) },
    source: { path: path.relative(ROOT, SOURCE).replace(/\\/g, '/'), sha256: sourceHash, records: sourceEntries.length },
    candidate: { path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'), sha256: candidateHash },
    classification: {
      imported: imported.length,
      duplicate: duplicates.length,
      conflicted: 0,
      invalid: sourceEntries.length - candidates.length,
      archivedWithReason: 0,
      byKind
    },
    excludedBenchmarkRuntimeSkills: (source.compiledSkills || []).filter(skill => /^skill\.runtime\./.test(String(skill?.id || ''))).length,
    activeModelModified: shaFile(BASE) !== sha(baseBytes),
    registryModified: false,
    externalModelCalls: 0
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: fs.existsSync(REPORT) ? 'w' : 'wx' });
  console.log(JSON.stringify(report, null, 2));
}

main();
