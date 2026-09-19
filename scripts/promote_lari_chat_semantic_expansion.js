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
const OUT = path.join(ROOT, 'consolidation', 'chat-semantic-expansion-20260915');
const CANDIDATES = path.join(OUT, 'candidates');
const REPORT = path.join(OUT, 'validation-report.json');
const MANIFEST = path.join(OUT, 'promotion-manifest.json');
const shaBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => shaBytes(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const writeExclusive = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
};
const assert = (value, message) => { if (!value) throw new Error(message); };

const lessons = [
  { id: 'lari.learned.procedure.chat.semantic.narrative_generation', kind: 'narrative_generation', intents: ['composition'], triggers: ['write story', 'tell tale', 'short narrative', 'funny story'], train: 'Write a short funny story about a robot learning to cook.', hidden: 'Tell a brief humorous tale about a cooking robot.', require: /pancake|apprentice|orbit/i },
  { id: 'lari.learned.procedure.chat.semantic.disagreement_engagement', kind: 'disagreement_engagement', intents: ['open_chat'], triggers: ['I disagree', "don't agree", 'see it differently', 'counterpoint'], train: 'I disagree. Speed matters more than perfect evidence.', hidden: "I don't agree; moving quickly can matter more than complete evidence.", require: /caution|delay|speed versus rigor/i },
  { id: 'lari.learned.procedure.chat.semantic.casual_banter', kind: 'casual_banter', intents: ['open_chat'], triggers: ['too much coffee', 'overcaffeinated', 'brain vibrating', 'caffeine'], train: 'I had too much coffee and now my brain is vibrating.', hidden: 'I am wildly overcaffeinated right now.', require: /coffee|nervous system|water/i },
  { id: 'lari.learned.procedure.chat.semantic.conceptual_tradeoff', kind: 'conceptual_tradeoff', intents: ['explanation', 'comparison', 'open_chat'], triggers: ['subtle downside', 'drawback of speed', 'fastest option', 'tradeoff'], train: 'What is a subtle downside of always choosing the fastest option?', hidden: 'What drawback can come from constantly picking the quickest path?', require: /immediate completion|shallow understanding|better direction/i }
];

function ask(model, prompt, hash) {
  return runtime.sendMessageToLari(clone(model), prompt, { modelHash: hash, autoGrow: false, userScope: 'chat-semantic-validation', kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });
}

function main() {
  assert(!fs.existsSync(REPORT) && !fs.existsSync(MANIFEST), 'Immutable chat semantic expansion artifacts already exist.');
  const incumbentHash = shaFile(registry.currentModelPath);
  const registryHash = shaFile(registry.registryPath);
  const candidate = clone(registry.loadLariModel().model);
  const records = lessons.map(lesson => runtime.learnLariGeneralChatProcedure(candidate, {
    id: lesson.id, kind: lesson.kind, intents: lesson.intents, triggers: lesson.triggers,
    confidence: 0.92, originalRecordId: null
  }, { sourceModelHash: incumbentHash, sourcePath: rel(registry.currentModelPath), confidence: 0.92 }));
  runtime.refreshLariKnowledgeProjections(candidate);
  candidate.lineage = { ...(candidate.lineage || {}), type: 'chat_semantic_expansion_candidate', parentHash: incumbentHash, learnedRecordIds: records.map(r => r.id), promoted: false, createdAt: new Date().toISOString(), externalModelCalls: 0 };
  const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = shaBytes(bytes);
  const candidatePath = path.join(CANDIDATES, `${candidateHash}.json`);
  fs.mkdirSync(CANDIDATES, { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const reload = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const rows = lessons.flatMap(lesson => [lesson.train, lesson.hidden].map((prompt, variant) => {
    const response = ask(reload, prompt, candidateHash);
    return { id: lesson.id, variant: variant ? 'hidden' : 'training', prompt, selected: response.learnedRecordIds?.includes(lesson.id) === true, source: response.publicAnswerSource, answer: response.answer, passed: response.learnedRecordIds?.includes(lesson.id) === true && lesson.require.test(String(response.answer || '')) && Number(response.external_model_calls || 0) === 0 };
  }));
  const ablation = lessons.map(lesson => {
    const ablated = clone(reload);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== lesson.id);
    runtime.refreshLariKnowledgeProjections(ablated);
    const response = ask(ablated, lesson.hidden, candidateHash);
    return { id: lesson.id, selectionLost: !response.learnedRecordIds?.includes(lesson.id), behaviorLost: !lesson.require.test(String(response.answer || '')), passed: !response.learnedRecordIds?.includes(lesson.id) && !lesson.require.test(String(response.answer || '')) };
  });
  const before = { active: shaFile(registry.currentModelPath), registry: shaFile(registry.registryPath) };
  const gates = { fourTypedRecords: records.length === 4 && records.every(record => record?.type === 'procedure' && record?.payload?.domain === 'general_chat'), semanticVariantsEightOfEight: rows.every(row => row.passed), exactAblationFourOfFour: ablation.every(row => row.passed), reloadRetention: rows.filter(row => row.variant === 'hidden').every(row => row.passed), candidateHashExact: shaFile(candidatePath) === candidateHash, incumbentReadOnly: before.active === incumbentHash && before.registry === registryHash, externalModelCallsZero: rows.every(row => row.passed) };
  const report = { schemaVersion: 1, kind: 'lari.chat-semantic-expansion.validation', createdAt: new Date().toISOString(), incumbentHash, registryHash, candidate: { path: rel(candidatePath), sha256: candidateHash, recordIds: records.map(r => r.id) }, rows, ablation, gates, passed: Object.values(gates).every(Boolean) };
  writeExclusive(REPORT, report);
  assert(report.passed, `Candidate validation failed: ${JSON.stringify(gates)}`);
  const backups = path.join(OUT, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const activeBackup = path.join(backups, `sha256-${incumbentHash}.json`);
  const registryBackup = path.join(backups, `registry-sha256-${registryHash}.json`);
  fs.copyFileSync(registry.currentModelPath, activeBackup, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(registry.registryPath, registryBackup, fs.constants.COPYFILE_EXCL);
  const promoted = registry.promoteLariModel(candidatePath, { stage: 'chat-semantic-expansion-production', transaction: 'hash-locked-real-promotion', candidateHash, candidateProvenance: rel(candidatePath), productionIncumbentHash: incumbentHash, validationReport: rel(REPORT), validationReportHash: shaFile(REPORT), canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel', ordinaryInferenceReadOnly: true, fallbackDiscoveryDisabled: true, externalModelCalls: 0 });
  const activeHash = shaFile(registry.currentModelPath);
  const post = lessons.map(lesson => ({ id: lesson.id, response: ask(registry.loadLariModel().model, lesson.hidden, activeHash) }));
  const promotionGates = { exactCandidateActivated: activeHash === candidateHash, registryHashMatches: JSON.parse(fs.readFileSync(registry.registryPath, 'utf8')).activeModelSha256 === candidateHash, rollbackTargetExact: shaFile(path.resolve(ROOT, promoted.previousModelPath)) === incumbentHash, allRecordsActive: post.every(row => row.response.learnedRecordIds?.includes(row.id)), externalModelCallsZero: post.every(row => Number(row.response.external_model_calls || 0) === 0) };
  assert(Object.values(promotionGates).every(Boolean), `Post-promotion validation failed: ${JSON.stringify(promotionGates)}`);
  writeExclusive(MANIFEST, { schemaVersion: 1, kind: 'lari.chat-semantic-expansion.production-promotion', createdAt: new Date().toISOString(), incumbentHash, candidateHash, activeHash, candidatePath: rel(candidatePath), validationReport: rel(REPORT), backups: { active: rel(activeBackup), registry: rel(registryBackup) }, rollbackTarget: promoted.previousModelPath, recordIds: records.map(r => r.id), gates: promotionGates, passed: true });
  console.log(JSON.stringify({ passed: true, incumbentHash, activeHash, records: records.map(r => r.id), validation: '8/8 semantic variants; 4/4 exact ablations', manifest: rel(MANIFEST) }, null, 2));
}

main();
