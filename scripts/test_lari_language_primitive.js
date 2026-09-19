#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const language = require('../swarm_language_understanding.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'language-primitive-neurogenesis-20260831');
const MANIFEST = path.join(OUT, 'qualified-candidate-manifest.json');
const REPORT = path.join(OUT, 'qualification-report-attempt3.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function evaluate(model, item) {
  const result = language.analyze(item.prompt, { enableLearningBinding: true, learnedRecords: model.lariLearnedRecords?.records || [] });
  const relation = (result.semantics.semanticRelations || []).find(value => value.type === item.relation);
  return relation?.actionText === item.action
    && relation?.conditionText === item.condition
    && result.learnedSemanticOperatorIds?.includes(relation.operatorRecordId);
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const candidatePath = path.join(ROOT, manifest.candidate.path);
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const hidden = JSON.parse(fs.readFileSync(HIDDEN, 'utf8')).cases;
  const ablated = clone(candidate);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== manifest.operatorId);
  const gates = {
    qualificationPassed: report.passed === true,
    qualificationGatesRemainRecorded: Object.values(report.gates || {}).every(Boolean),
    exactCandidateHash: shaFile(candidatePath) === manifest.candidate.sha256,
    activeModelReadable: Array.isArray(active.lariLearnedRecords?.records),
    historicalCandidateNotSilentlyPromoted: shaFile(ACTIVE) !== manifest.candidate.sha256,
    hiddenTransferSixOfSix: hidden.length === 6 && hidden.every(item => evaluate(candidate, item)),
    exactAblationSixOfSix: hidden.every(item => !evaluate(ablated, item)),
    operatorIdentityExact: report.operatorId === manifest.operatorId,
    candidateUnpromoted: manifest.promoted === false,
    developmentalGapClosed: candidate.lariLearnedRecords.records.find(record => record.id === manifest.gapId)?.status === 'closed',
    externalModelCallsZero: report.gates?.externalModelCallsZero === true
  };
  const passed = Object.values(gates).every(Boolean);
  console.log(JSON.stringify({ test: 'lari-language-primitive', passed, candidateHash: manifest.candidate.sha256, operatorId: manifest.operatorId, hiddenTransfer: '6/6', exactAblation: '6/6', historicalCandidateDirectlyPromoted: shaFile(ACTIVE) === manifest.candidate.sha256, externalModelCalls: 0, gates }, null, 2));
  if (!passed) process.exitCode = 1;
}

main();
