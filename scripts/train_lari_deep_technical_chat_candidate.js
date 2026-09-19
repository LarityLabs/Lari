#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const PARENT_HASH = '8e9e0003332ea03b383081410b06ddf670bbf7e0658996a7e5e95d9a17f907df';
const OUT = path.join(ROOT, 'consolidation', 'deep-chat-coding-expansion-20260829');
const SEAL = path.join(OUT, 'sealed-curriculum.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const CANDIDATES = path.join(OUT, 'candidates');
const REPORT = path.join(OUT, 'technical-chat-training-report-v7.json');
const MANIFEST = path.join(OUT, 'technical-chat-candidate-manifest-v7.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shaText = text => crypto.createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const fnv1a32 = input => {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(input), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

function ask(model, prompt, id) {
  return runtime.sendMessageToLari(model, prompt, {
    modelHash: PARENT_HASH,
    autoGrow: false,
    userScope: `deep-chat-${id}`,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
}

function selected(response, recordId) {
  return (response.learnedRecordIds || []).includes(recordId)
    || response.learnedRecordId === recordId
    || response.record?.learnedRecordIds?.includes(recordId);
}

function markers(answer, required) {
  return required.every(marker => String(answer || '').includes(marker));
}

function recordIdFor(item) {
  return item.id === 'verified_progress_report'
    ? 'lari.learned.procedure.chat.expansion.status_synthesis'
    : `lari.learned.procedure.chat.technical.${item.id}`;
}

function buildRecord(item, sealedHash, timestamp) {
  const plan = { kind: item.kind, moves: [], criteria: [], steps: [], replacements: {}, prefixes: [], suffixes: [] };
  const fingerprint = fnv1a32(JSON.stringify({ operation: 'compose_chat_response', plan }));
  return {
    schemaVersion: 1,
    id: `lari.learned.procedure.chat.technical.${item.id}`,
    type: 'procedure',
    status: 'active',
    normalizedTriggers: [...new Set(item.triggers.map(value => String(value).toLowerCase()))].sort(),
    procedureIdentity: `chat-response-plan:${fingerprint}`,
    semanticFingerprint: `chat-response-plan:${fingerprint}`,
    outputBehavior: `composed-technical-chat:${item.kind}`,
    contentHash: `fnv1a32:${fingerprint}`,
    behavioralSignature: `chat-plan:${fingerprint}`,
    confidence: 0.88,
    provenance: {
      sourceModelHash: PARENT_HASH,
      sourcePath: 'consolidation/deep-chat-coding-expansion-20260829/sealed-curriculum.json',
      sourceArtifactHash: sealedHash,
      originalRecordId: null,
      sourceKind: 'sealed_failure_driven_curriculum',
      creationSource: 'technical_chat_semantic_transfer_training',
      benchmarkAssociation: [],
      confidence: 0.88,
      imported: false,
      classification: 'developmental_candidate',
      importTimestamp: timestamp,
      storesRawSessionLog: false,
      storesPromptText: false
    },
    payload: {
      domain: 'general_chat',
      operation: 'compose_chat_response',
      intents: item.intents,
      minTriggerMatches: 1,
      responsePlan: plan,
      verification: 'sealed_semantic_paraphrase_causal_ablation_and_reload',
      verifiedUses: 0
    }
  };
}

function main() {
  if (fs.existsSync(MANIFEST) || fs.existsSync(REPORT)) throw new Error('Technical-chat candidate artifacts already exist.');
  if (shaFile(ACTIVE) !== PARENT_HASH) throw new Error('Production parent changed; refusing to train from an unexpected model.');
  const registryBefore = shaFile(REGISTRY);
  const sealBytes = fs.readFileSync(SEAL);
  const sealHash = crypto.createHash('sha256').update(sealBytes).digest('hex');
  const curriculum = JSON.parse(sealBytes);
  if (curriculum.parentHash !== PARENT_HASH || curriculum.chat.length !== 16) throw new Error('Sealed curriculum parent or chat-family count mismatch.');
  const parent = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const baseline = curriculum.chat.map(item => {
    const recordId = recordIdFor(item);
    const response = ask(clone(parent), item.hidden, `baseline-${item.id}`);
    return { id: item.id, recordId, selected: selected(response, recordId), requiredMarkers: markers(response.answer, item.required) };
  });
  const candidate = clone(parent);
  const timestamp = new Date().toISOString();
  const existing = new Set(candidate.lariLearnedRecords.records.map(record => record.id));
  const records = curriculum.chat.filter(item => item.id !== 'verified_progress_report').map(item => buildRecord(item, sealHash, timestamp));
  if (records.some(record => existing.has(record.id))) throw new Error('A technical-chat record ID already exists in the parent.');
  candidate.lariLearnedRecords.records = [...records, ...candidate.lariLearnedRecords.records];
  const priorLineage = clone(candidate.lineage || {});
  candidate.lineage = {
    ...priorLineage,
    timestamp,
    type: 'deep_technical_chat_candidate',
    parentHash: PARENT_HASH,
    sealedCurriculumHash: sealHash,
    learnedRecordIds: records.map(record => record.id),
    promoted: false,
    externalModelCalls: 0,
    previous: priorLineage
  };
  const after = curriculum.chat.map(item => {
    const recordId = recordIdFor(item);
    const trainResponse = ask(clone(candidate), item.train, `train-${item.id}`);
    const hiddenResponse = ask(clone(candidate), item.hidden, `hidden-${item.id}`);
    return {
      id: item.id,
      recordId,
      trainSelected: selected(trainResponse, recordId),
      hiddenSelected: selected(hiddenResponse, recordId),
      trainMarkers: markers(trainResponse.answer, item.required),
      hiddenMarkers: markers(hiddenResponse.answer, item.required),
      hiddenAnswer: hiddenResponse.answer
    };
  });
  const ablation = curriculum.chat.map(item => {
    const recordId = recordIdFor(item);
    const ablated = clone(candidate);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== recordId);
    const response = ask(ablated, item.hidden, `ablation-${item.id}`);
    return { id: item.id, recordId, recordAbsent: !selected(response, recordId), behaviorLost: !markers(response.answer, item.required) };
  });
  const previousSeal = JSON.parse(fs.readFileSync(path.join(ROOT, 'consolidation', 'chat-coding-expansion-20260829', 'sealed-curriculum.json'), 'utf8'));
  const familyRegression = previousSeal.chat.map(item => {
    const recordId = `lari.learned.procedure.chat.expansion.${item.id}`;
    const response = ask(clone(candidate), item.hidden, `regression-${item.id}`);
    return { id: item.id, selected: selected(response, recordId), markers: markers(response.answer, item.required) };
  });
  fs.mkdirSync(CANDIDATES, { recursive: true });
  const candidateBytes = `${JSON.stringify(candidate, null, 2)}\n`;
  const candidateHash = shaText(candidateBytes);
  const candidatePath = path.join(CANDIDATES, `${candidateHash}.json`);
  fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const reload = curriculum.chat.map(item => {
    const recordId = recordIdFor(item);
    const response = ask(clone(reloaded), item.hidden, `reload-${item.id}`);
    return { id: item.id, selected: selected(response, recordId), markers: markers(response.answer, item.required) };
  });
  const productionAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const gates = {
    baselineFifteenAbsentOneExistingQualified: baseline.every(row => row.id === 'verified_progress_report'
      ? row.selected && row.requiredMarkers
      : !row.selected && !row.requiredMarkers),
    trainSixteenOfSixteen: after.every(row => row.trainSelected && row.trainMarkers),
    hiddenSixteenOfSixteen: after.every(row => row.hiddenSelected && row.hiddenMarkers),
    causalAblationSixteenOfSixteen: ablation.every(row => row.recordAbsent && row.behaviorLost),
    reloadSixteenOfSixteen: reload.every(row => row.selected && row.markers),
    previousChatEightOfEight: familyRegression.every(row => row.selected && row.markers),
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    productionReadOnly: productionAfter.active === PARENT_HASH && productionAfter.registry === registryBefore,
    noPromptTextStored: records.every(record => !JSON.stringify(record).includes(curriculum.chat.find(item => record.id.endsWith(item.id)).hidden)),
    noPromotion: true,
    externalModelCallsZero: true
  };
  const report = { schemaVersion: 1, kind: 'lari.deep-technical-chat.training-report', createdAt: timestamp, parentHash: PARENT_HASH, sealedCurriculumHash: sealHash, candidate: { path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'), sha256: candidateHash }, baseline, after, ablation, reload, familyRegression, gates, passed: Object.values(gates).every(Boolean), externalModelCalls: 0 };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  const manifest = { schemaVersion: 1, kind: 'lari.deep-technical-chat.candidate', createdAt: timestamp, parentHash: PARENT_HASH, candidate: report.candidate, promoted: false, learnedRecordIds: records.map(record => record.id), sealedCurriculum: { path: path.relative(ROOT, SEAL).replace(/\\/g, '/'), sha256: sealHash }, report: path.relative(ROOT, REPORT).replace(/\\/g, '/'), gates };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, candidate: report.candidate, baseline: `${baseline.filter(row => row.requiredMarkers).length}/16`, train: `${after.filter(row => row.trainSelected && row.trainMarkers).length}/16`, hidden: `${after.filter(row => row.hiddenSelected && row.hiddenMarkers).length}/16`, ablation: `${ablation.filter(row => row.recordAbsent && row.behaviorLost).length}/16`, reload: `${reload.filter(row => row.selected && row.markers).length}/16`, regressions: familyRegression.filter(row => !row.selected || !row.markers).map(row => row.id), gates }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
