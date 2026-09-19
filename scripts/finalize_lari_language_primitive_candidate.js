#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const neuro = require('../swarm_domain_neurogenesis.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'language-primitive-neurogenesis-20260831');
const PROVISIONAL = path.join(OUT, 'provisional-candidate-manifest.json');
const QUALIFICATION = path.join(OUT, 'qualification-report-attempt2.json');
const FINAL = path.join(OUT, 'qualified-candidate-manifest.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (value, message) => { if (!value) throw new Error(message); };

function main() {
  assert(!fs.existsSync(FINAL), 'Qualified language primitive manifest already exists.');
  const provisional = JSON.parse(fs.readFileSync(PROVISIONAL, 'utf8'));
  const qualification = JSON.parse(fs.readFileSync(QUALIFICATION, 'utf8'));
  assert(qualification.passed === true && Object.values(qualification.gates || {}).every(Boolean), 'Attempt 2 qualification did not pass every gate.');
  const provisionalPath = path.join(ROOT, provisional.candidate.path);
  assert(shaFile(provisionalPath) === provisional.candidate.sha256, 'Provisional candidate hash mismatch.');
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), provisional: shaFile(provisionalPath), qualification: shaFile(QUALIFICATION) };
  const model = JSON.parse(fs.readFileSync(provisionalPath, 'utf8'));
  const gap = model.lariLearnedRecords.records.find(record => record.id === provisional.gapId);
  const operator = model.lariLearnedRecords.records.find(record => record.id === provisional.operatorId);
  assert(gap?.status === 'open' && operator, 'Expected the exact open gap and qualified operator.');
  model.lariLearnedRecords.records = model.lariLearnedRecords.records.filter(record => record.id !== operator.id);
  const retained = neuro.retainVerifiedCandidate(model, gap, { learned: true, record: operator }, { visible: true, hiddenTransfer: true, semanticFaithfulness: true, reload: true, ablation: true, regressions: 0, externalModelCallsZero: true, closedAt: new Date().toISOString() });
  assert(retained.retained === true && gap.status === 'closed', `Retention failed: ${retained.reason || 'unknown'}`);
  assert(model.lariLearnedRecords.records.filter(record => record.id === operator.id).length === 1, 'Operator duplication detected.');
  model.lineage = { ...(model.lineage || {}), parentHash: provisional.parentHash, provisionalHash: provisional.candidate.sha256, developmentalEvent: 'qualified_language_side_semantic_primitive', qualificationEvidence: rel(QUALIFICATION), sourceGapId: gap.id, sourceOperatorId: operator.id, promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'qualified-candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), provisional: shaFile(provisionalPath), qualification: shaFile(QUALIFICATION) };
  const gates = { exactQualificationEvidence: qualification.candidateHash === provisional.candidate.sha256, gapClosedThroughCanonicalRetention: gap.status === 'closed' && gap.payload?.closedBy?.recordId === operator.id, exactOneOperator: model.lariLearnedRecords.records.filter(record => record.id === operator.id).length === 1, qualifiedHashExact: shaFile(candidatePath) === candidateHash, productionAndEvidenceReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter), noPromotion: model.lineage.promoted === false };
  const manifest = { schemaVersion: 1, kind: 'lari.language-primitive.qualified-candidate', createdAt: new Date().toISOString(), promoted: false, parentHash: provisional.parentHash, provisionalHash: provisional.candidate.sha256, candidate: { path: rel(candidatePath), sha256: candidateHash }, gapId: gap.id, operatorId: operator.id, operator, gates, protectedBefore, protectedAfter };
  fs.writeFileSync(FINAL, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: Object.values(gates).every(Boolean), candidateHash, operatorId: operator.id, gapId: gap.id, gapStatus: gap.status, gates }, null, 2));
}

main();
