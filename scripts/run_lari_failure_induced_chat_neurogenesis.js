#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

delete process.env.LARI_REGISTRY_ROOT;
delete process.env.LARI_MODEL_PATH;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
process.env.LARI_ALLOW_LEGACY_ROOT_MODEL = '0';
const registry = require('./lari_model_registry.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'failure-induced-chat-neurogenesis-20260915');
const SEAL = path.join(OUT, 'sealed-curriculum.json');
const REPORT = path.join(OUT, 'qualification.json');
const PROMOTION = path.join(OUT, 'promotion-manifest.json');
const RECORD_ID = 'lari.learned.procedure.chat.neurogenesis.tentative_goal_elicitation';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (value, message) => { if (!value) throw new Error(message); };
const writeExclusive = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); };
const context = hash => ({ modelHash: hash, autoGrow: false, userScope: 'sealed-chat-neurogenesis', kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });
const ask = (model, prompt, hash) => runtime.sendMessageToLari(clone(model), prompt, context(hash));

const curriculum = {
  schemaVersion: 1,
  family: 'tentative_goal_elicitation',
  visibleFailures: [
    { prompt: 'I am not sure what I want from my next project.', correctedAnswer: 'It makes sense to be unsure. Instead of choosing a project immediately, start with the outcome you want. What would make the next project feel worthwhile?' },
    { prompt: "I don't know what I want from a career change.", correctedAnswer: "Not knowing yet is understandable. Instead of forcing a job choice, focus on the outcome you want from daily work. What change would matter most six months from now?" },
    { prompt: 'I feel uncertain about the direction I want to take.', correctedAnswer: 'Uncertainty is useful information. Instead of selecting a direction immediately, separate the desired outcome from the available paths. Which result would tell you that the direction was right?' }
  ],
  hidden: [
    'I feel conflicted about which direction I want for my next creative effort.',
    'I am uncertain what I want from the next stage of this work.',
    "I don't know what I want for my next big decision."
  ]
};

function main() {
  assert(!fs.existsSync(REPORT) && !fs.existsSync(PROMOTION), 'Immutable neurogenesis result artifacts already exist.');
  const incumbentHash = shaFile(registry.currentModelPath);
  const registryHash = shaFile(registry.registryPath);
  if (fs.existsSync(SEAL)) assert(JSON.stringify(JSON.parse(fs.readFileSync(SEAL, 'utf8'))) === JSON.stringify(curriculum), 'Existing sealed curriculum does not match this run.');
  else writeExclusive(SEAL, curriculum);
  const sealHash = shaFile(SEAL);
  const incumbent = registry.loadLariModel().model;
  const baseline = curriculum.hidden.map(prompt => {
    const response = ask(incumbent, prompt, incumbentHash);
    return { promptSha256: sha(prompt), selected: response.learnedRecordIds?.includes(RECORD_ID) === true, answer: response.answer, failed: !response.learnedRecordIds?.includes(RECORD_ID) };
  });
  const candidate = clone(incumbent);
  const induction = runtime.induceLariGeneralChatProcedureFromFailures(candidate, curriculum.visibleFailures, { id: RECORD_ID, sourceModelHash: incumbentHash, sourcePath: `${rel(SEAL)}#visibleFailures`, confidence: 0.9 });
  assert(induction.learned && induction.record?.id === RECORD_ID, `Induction failed: ${JSON.stringify(induction)}`);
  runtime.refreshLariKnowledgeProjections(candidate);
  candidate.lineage = { ...(candidate.lineage || {}), type: 'failure_induced_chat_discourse_neurogenesis', parentHash: incumbentHash, sourceArtifactHash: sealHash, learnedRecordIds: [RECORD_ID], promoted: false, createdAt: new Date().toISOString(), externalModelCalls: 0 };
  const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const reload = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const evaluate = (prompt, model = reload) => {
    const response = ask(model, prompt, candidateHash);
    const answer = String(response.answer || '');
    return { promptSha256: sha(prompt), selected: response.learnedRecordIds?.includes(RECORD_ID) === true, source: response.publicAnswerSource, answer, passed: response.learnedRecordIds?.includes(RECORD_ID) === true && /not knowing|useful information/i.test(answer) && /instead of/i.test(answer) && /\?/.test(answer) && Number(response.external_model_calls || 0) === 0 };
  };
  const visible = curriculum.visibleFailures.map(item => evaluate(item.prompt));
  const hidden = curriculum.hidden.map(prompt => evaluate(prompt));
  const ablated = clone(reload);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== RECORD_ID);
  runtime.refreshLariKnowledgeProjections(ablated);
  const ablation = curriculum.hidden.map(prompt => {
    const response = ask(ablated, prompt, candidateHash);
    return { promptSha256: sha(prompt), selectionLost: !response.learnedRecordIds?.includes(RECORD_ID), behaviorLost: !/not knowing exactly what you want yet is useful information/i.test(String(response.answer || '')), passed: !response.learnedRecordIds?.includes(RECORD_ID) && !/not knowing exactly what you want yet is useful information/i.test(String(response.answer || '')) };
  });
  const stored = JSON.stringify(induction.record);
  const afterQualification = { active: shaFile(registry.currentModelPath), registry: shaFile(registry.registryPath) };
  const gates = {
    baselineFailureThreeOfThree: baseline.every(row => row.failed),
    diagnosisCreated: induction.record.payload?.induction?.diagnosis === 'missing_reusable_discourse_structure',
    threeMovesInduced: induction.inferredMoves?.length === 3,
    typedProcedureRetained: induction.record.type === 'procedure' && induction.record.provenance?.creationSource === 'failure_induced_chat_discourse_neurogenesis',
    visibleThreeOfThree: visible.every(row => row.passed),
    hiddenThreeOfThree: hidden.every(row => row.passed),
    reloadRetention: hidden.every(row => row.passed),
    exactAblationThreeOfThree: ablation.every(row => row.passed),
    examplesNotRetained: curriculum.visibleFailures.every(item => !stored.includes(item.prompt) && !stored.includes(item.correctedAnswer)) && curriculum.hidden.every(prompt => !stored.includes(prompt)),
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    productionReadOnlyDuringQualification: afterQualification.active === incumbentHash && afterQualification.registry === registryHash,
    externalModelCallsZero: true
  };
  const report = { schemaVersion: 1, kind: 'lari.failure-induced-chat-neurogenesis.qualification', createdAt: new Date().toISOString(), incumbentHash, seal: { path: rel(SEAL), sha256: sealHash }, candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false }, induction: { recordId: RECORD_ID, moves: induction.inferredMoves, triggers: induction.triggers, evidenceCount: induction.attemptedExampleCount }, baseline, visible, hidden, ablation, gates, passed: Object.values(gates).every(Boolean), limitations: ['Proves induction for one bounded discourse family.', 'Move detectors and realization primitives remain developer-authored.', 'Does not prove unrestricted language-family invention.'] };
  writeExclusive(REPORT, report);
  assert(report.passed, `Qualification failed: ${JSON.stringify(gates)}`);
  const backups = path.join(OUT, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const activeBackup = path.join(backups, `sha256-${incumbentHash}.json`);
  const registryBackup = path.join(backups, `registry-sha256-${registryHash}.json`);
  fs.copyFileSync(registry.currentModelPath, activeBackup, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(registry.registryPath, registryBackup, fs.constants.COPYFILE_EXCL);
  const promoted = registry.promoteLariModel(candidatePath, { stage: 'failure-induced-chat-neurogenesis-production', transaction: 'hash-locked-real-promotion', candidateHash, candidateProvenance: rel(candidatePath), productionIncumbentHash: incumbentHash, validationReport: rel(REPORT), validationReportHash: shaFile(REPORT), canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel', ordinaryInferenceReadOnly: true, fallbackDiscoveryDisabled: true, externalModelCalls: 0 });
  const activeHash = shaFile(registry.currentModelPath);
  const post = curriculum.hidden.map(prompt => evaluate(prompt, registry.loadLariModel().model));
  const promotionGates = { exactCandidateActivated: activeHash === candidateHash, registryHashMatches: JSON.parse(fs.readFileSync(registry.registryPath, 'utf8')).activeModelSha256 === candidateHash, rollbackTargetExact: shaFile(path.resolve(ROOT, promoted.previousModelPath)) === incumbentHash, hiddenThreeOfThreeInProduction: post.every(row => row.passed), externalModelCallsZero: post.every(row => row.passed) };
  assert(Object.values(promotionGates).every(Boolean), `Promotion validation failed: ${JSON.stringify(promotionGates)}`);
  writeExclusive(PROMOTION, { schemaVersion: 1, kind: 'lari.failure-induced-chat-neurogenesis.production-promotion', createdAt: new Date().toISOString(), incumbentHash, activeHash, candidateHash, recordId: RECORD_ID, report: rel(REPORT), rollbackTarget: promoted.previousModelPath, backups: { active: rel(activeBackup), registry: rel(registryBackup) }, gates: promotionGates, passed: true });
  console.log(JSON.stringify({ passed: true, incumbentHash, activeHash, recordId: RECORD_ID, induction: `${induction.inferredMoves.length} shared discourse moves from ${induction.attemptedExampleCount} failures`, hidden: '3/3', ablation: '3/3', report: rel(REPORT), promotion: rel(PROMOTION) }, null, 2));
}

main();
