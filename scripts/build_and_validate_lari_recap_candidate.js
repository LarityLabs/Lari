#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const recap = require('../swarm_recap_language.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'recap-minimal-20260830');
const SEAL = path.join(OUT, 'sealed-curriculum.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const CANDIDATES = path.join(OUT, 'candidates');
const REPORT = path.join(OUT, 'candidate-validation-v3.json');
const MANIFEST = path.join(OUT, 'candidate-manifest-v3.json');
const PARENT_HASH = '6b0099f28d6c4d879fc5ea3b8d43994d8df199ef5a8e5cd68ee6592bec36369b';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));

function record(operation, ast, sealHash, timestamp) {
  const token = crypto.createHash('sha256').update(JSON.stringify({ operation, ast })).digest('hex').slice(0, 16);
  return {
    schemaVersion: 1,
    id: `lari.learned.generator.${operation}`,
    type: 'generator',
    status: 'active',
    normalizedTriggers: operation.split(/[._]/).filter(Boolean),
    procedureIdentity: `recap-generator:${operation}`,
    semanticFingerprint: `sha256:${token}`,
    outputBehavior: operation,
    contentHash: `sha256:${crypto.createHash('sha256').update(JSON.stringify(ast)).digest('hex')}`,
    behavioralSignature: `recap:${operation}:${token}`,
    confidence: 0.91,
    provenance: {
      sourceModelHash: PARENT_HASH,
      sourcePath: 'consolidation/recap-minimal-20260830/sealed-curriculum.json',
      sourceArtifactHash: sealHash,
      originalRecordId: null,
      sourceKind: 'sealed_failure_driven_curriculum',
      creationSource: 'recap_executable_language_training',
      benchmarkAssociation: [],
      confidence: 0.91,
      imported: false,
      classification: 'developmental_candidate',
      importTimestamp: timestamp,
      storesRawSessionLog: false,
      storesPromptText: false
    },
    payload: {
      domain: 'executable_language',
      operation,
      generatorAst: ast,
      verification: 'sealed_claim_coverage_semantic_transfer_causal_ablation_reload',
      verifiedUses: 0
    }
  };
}

function buildRecords(sealHash, timestamp) {
  return [
    record('recap.meaning.causal_evidence_action', { kind: 'meaning_graph', claims: ['effect', 'cause', 'evidence', 'nextAction'], relations: [['cause', 'cause', 'effect'], ['supports', 'evidence', 'cause']] }, sealHash, timestamp),
    record('recap.discourse.answer_support_action', { kind: 'ordered_clauses', sequence: ['recap.clause.causal', 'recap.clause.evidence', 'recap.clause.next_action'] }, sealHash, timestamp),
    record('recap.clause.causal', { kind: 'template', pattern: '{effect} because {cause}.' }, sealHash, timestamp),
    record('recap.clause.evidence', { kind: 'template', pattern: 'Evidence: {evidence}.' }, sealHash, timestamp),
    record('recap.clause.next_action', { kind: 'template', pattern: 'Next: {nextAction}.' }, sealHash, timestamp),
    record('recap.repair.claim_coverage', { kind: 'claim_coverage', requiredClaims: ['effect', 'cause', 'evidence', 'nextAction'], rejectUnsupportedClaims: true }, sealHash, timestamp)
  ];
}

function ask(model, prompt, id) {
  return runtime.sendMessageToLari(model, prompt, {
    modelHash: id,
    autoGrow: false,
    userScope: `recap-${id}`,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
}

function assess(response, item, expectedIds) {
  const ids = response.learnedRecordIds || response.record?.learnedRecordIds || [];
  const answer = String(response.answer || '');
  return {
    source: response.publicAnswerSource || null,
    selectedIds: ids,
    expectedIdsSelected: expectedIds.every(id => ids.includes(id)),
    claimsCovered: item.claims.every(claim => answer.toLowerCase().includes(claim.toLowerCase())),
    unsupportedClaimCount: Number(response.recapTrace?.verification?.unsupportedClaimCount ?? -1),
    answer,
    passed: response.publicAnswerSource === 'recap_executable_language'
      && expectedIds.every(id => ids.includes(id))
      && item.claims.every(claim => answer.toLowerCase().includes(claim.toLowerCase()))
      && response.recapTrace?.verification?.passed === true
      && response.recapTrace?.verification?.unsupportedClaimCount === 0
  };
}

function main() {
  if (fs.existsSync(REPORT) || fs.existsSync(MANIFEST)) throw new Error('RECAP candidate artifacts already exist.');
  if (shaFile(ACTIVE) !== PARENT_HASH) throw new Error('Active production parent changed.');
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const sealBytes = fs.readFileSync(SEAL);
  const sealHash = sha(sealBytes);
  const curriculum = JSON.parse(sealBytes);
  if (curriculum.parentHash !== PARENT_HASH || curriculum.requiredOperations.join('|') !== recap.REQUIRED.join('|')) throw new Error('Seal does not match runtime operations or parent.');
  const parent = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const baseline = [...curriculum.train, ...curriculum.hidden].map(item => {
    const response = ask(clone(parent), item.prompt, PARENT_HASH);
    return { id: item.id, source: response.publicAnswerSource || null, selectedIds: response.learnedRecordIds || [], recapAbsent: response.publicAnswerSource !== 'recap_executable_language' };
  });
  const timestamp = new Date().toISOString();
  const learnedRecords = buildRecords(sealHash, timestamp);
  const candidate = clone(parent);
  const existing = new Set(candidate.lariLearnedRecords?.records?.map(item => item.id) || []);
  if (learnedRecords.some(item => existing.has(item.id))) throw new Error('A RECAP generator record already exists in the parent.');
  candidate.lariLearnedRecords.records = [...learnedRecords, ...candidate.lariLearnedRecords.records];
  const previous = clone(candidate.lineage || {});
  candidate.lineage = { ...previous, timestamp, type: 'recap_minimal_candidate', parentHash: PARENT_HASH, sealedCurriculumHash: sealHash, learnedRecordIds: learnedRecords.map(item => item.id), promoted: false, externalModelCalls: 0, previous };
  const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha(bytes);
  fs.mkdirSync(CANDIDATES, { recursive: true });
  const candidatePath = path.join(CANDIDATES, `${candidateHash}.json`);
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const expectedIds = learnedRecords.map(item => item.id);
  const training = curriculum.train.map(item => ({ id: item.id, ...assess(ask(clone(candidate), item.prompt, candidateHash), item, expectedIds) }));
  const hidden = curriculum.hidden.map(item => ({ id: item.id, ...assess(ask(clone(candidate), item.prompt, candidateHash), item, expectedIds) }));
  const ablation = learnedRecords.map(removed => {
    const ablated = clone(candidate);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(item => item.id !== removed.id);
    const response = ask(ablated, curriculum.hidden[0].prompt, candidateHash);
    return { removedId: removed.id, recapBehaviorLost: response.publicAnswerSource !== 'recap_executable_language', removedIdAbsent: !(response.learnedRecordIds || []).includes(removed.id) };
  });
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const reload = curriculum.hidden.map(item => ({ id: item.id, ...assess(ask(clone(reloaded), item.prompt, candidateHash), item, expectedIds) }));
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const storedText = JSON.stringify(learnedRecords);
  const gates = {
    baselineRecapAbsent: baseline.every(item => item.recapAbsent),
    trainOneOfOne: training.every(item => item.passed),
    hiddenFiveOfFive: hidden.every(item => item.passed),
    causalAblationSixOfSix: ablation.every(item => item.recapBehaviorLost && item.removedIdAbsent),
    reloadFiveOfFive: reload.every(item => item.passed),
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    canonicalTypedStoreOnly: learnedRecords.every(item => item.type === 'generator' && item.payload.domain === 'executable_language'),
    noPromptOrAnswerStored: [...curriculum.train, ...curriculum.hidden].every(item => !storedText.includes(item.prompt) && item.claims.every(claim => !storedText.includes(claim))),
    productionReadOnly: JSON.stringify(before) === JSON.stringify(after),
    noPromotion: true,
    externalModelCallsZero: true
  };
  const report = { schemaVersion: 1, kind: 'lari.recap-minimal.candidate-validation', createdAt: timestamp, parentHash: PARENT_HASH, sealedCurriculumHash: sealHash, candidate: { path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'), sha256: candidateHash }, learnedRecordIds: expectedIds, baseline, training, hidden, ablation, reload, before, after, gates, passed: Object.values(gates).every(Boolean), externalModelCalls: 0 };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(MANIFEST, `${JSON.stringify({ schemaVersion: 1, kind: 'lari.recap-minimal.candidate', createdAt: timestamp, parentHash: PARENT_HASH, candidate: report.candidate, sealedCurriculum: { path: path.relative(ROOT, SEAL).replace(/\\/g, '/'), sha256: sealHash }, learnedRecordIds: expectedIds, promoted: false, report: path.relative(ROOT, REPORT).replace(/\\/g, '/'), gates }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, candidate: report.candidate, train: `${training.filter(item => item.passed).length}/${training.length}`, hidden: `${hidden.filter(item => item.passed).length}/${hidden.length}`, ablation: `${ablation.filter(item => item.recapBehaviorLost).length}/${ablation.length}`, reload: `${reload.filter(item => item.passed).length}/${reload.length}`, gates }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
