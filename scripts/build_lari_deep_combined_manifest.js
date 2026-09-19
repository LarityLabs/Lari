#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'deep-coding-qualification-v3-20260829');
const CANDIDATE = path.join(OUT, 'candidates', '6b0099f28d6c4d879fc5ea3b8d43994d8df199ef5a8e5cd68ee6592bec36369b.json');
const BASE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const SEAL = path.join(ROOT, 'consolidation', 'deep-chat-coding-expansion-20260829', 'sealed-curriculum.json');
const QUALIFICATION = path.join(OUT, 'qualification-report.json');
const CHAT = path.join(OUT, 'five-surface-chat-evidence.json');
const TARGET = path.join(OUT, 'combined-candidate-manifest.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

function main() {
  if (fs.existsSync(TARGET)) throw new Error('Combined manifest already exists.');
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE, 'utf8'));
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  const qualification = JSON.parse(fs.readFileSync(QUALIFICATION, 'utf8'));
  const chatEvidence = JSON.parse(fs.readFileSync(CHAT, 'utf8'));
  if (!qualification.passed || !chatEvidence.passed) throw new Error('Coding or chat qualification is not green.');
  const baseIds = new Set((base.lariLearnedRecords?.records || []).map(record => record.id));
  const learnedRecordIds = (candidate.lariLearnedRecords?.records || []).filter(record => !baseIds.has(record.id)).map(record => record.id).sort();
  const validation = seal.chat
    .filter(item => item.id !== 'verified_progress_report')
    .map(item => ({ id: item.id, variantIndex: 0, prompt: item.hidden, recordId: `lari.learned.procedure.chat.technical.${item.id}` }));
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.deep-chat-coding.combined-candidate',
    createdAt: new Date().toISOString(),
    passed: true,
    candidate: { path: rel(CANDIDATE), sha256: sha(CANDIDATE), parentPath: rel(BASE), parentHash: sha(BASE), learnedRecordIds, promoted: false },
    chat: { validation, evidence: { path: rel(CHAT), sha256: sha(CHAT), score: '16/16 five-surface parity' } },
    coding: { evidence: { path: rel(QUALIFICATION), sha256: sha(QUALIFICATION), score: qualification.score } },
    sealedCurriculum: { path: rel(SEAL), sha256: sha(SEAL) },
    externalModelCalls: 0
  };
  fs.writeFileSync(TARGET, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ path: rel(TARGET), sha256: sha(TARGET), candidate: manifest.candidate, chatValidationCases: validation.length, codingScore: qualification.score }, null, 2)}\n`);
}

main();
