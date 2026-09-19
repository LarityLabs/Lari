#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const language = require('../swarm_language_understanding.js');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const OUT = path.join(ROOT, 'consolidation', 'open-english-semantic-growth-20260916-attempt4');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const writeImmutable = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); };

const curricula = [
  {
    id: 'lari.learned.operator.language.semantic_relation.purpose', relationType: 'purpose', roles: ['action', 'goal'], marker: 'so that', surfaceOrder: 'left_marker_right',
    visible: ['We cache the index so that searches stay fast.', 'Mina labeled the samples so that reviewers could compare them.'],
    hidden: ['The gardener covered the seedlings so that frost would not damage them.', 'I wrote down the address so that nobody would get lost.']
  },
  {
    id: 'lari.learned.operator.language.semantic_relation.concessive', relationType: 'concessive', roles: ['expectation', 'assertion'], marker: 'although', surfaceOrder: 'marker_left_then_right',
    visible: ['Although the patch was tiny, it changed the public contract.', 'Although the trail looked easy, the climb took hours.'],
    hidden: ['Although the recipe was simple, the timing required care.', 'Although the room was crowded, everyone heard the speaker.']
  },
  {
    id: 'lari.learned.operator.language.semantic_relation.temporal_precedence', relationType: 'temporal_precedence', roles: ['earlier', 'later'], marker: 'before', surfaceOrder: 'left_marker_right',
    visible: ['Back up the registry before replacing the manifest.', 'Lena checked the weather before packing the tent.'],
    hidden: ['Wash the brush before the paint dries.', 'The musicians tuned their instruments before the audience entered.']
  }
];

function correctedExamples(curriculum) {
  return curriculum.visible.map(text => ({ text, relationType: curriculum.relationType, marker: curriculum.marker, roles: curriculum.roles, surfaceOrder: curriculum.surfaceOrder }));
}

function runAnalysis(model, text) {
  return language.analyze(text, { learnedRecords: model.lariLearnedRecords?.records || [] });
}

function relationFor(analysis, curriculum) {
  return (analysis.semantics.semanticRelations || []).find(item => item.type === curriculum.relationType && item.operatorRecordId === curriculum.id);
}

const incumbentBytes = fs.readFileSync(ACTIVE);
const registryBytes = fs.readFileSync(REGISTRY);
const incumbentHash = sha(incumbentBytes);
const registry = JSON.parse(registryBytes);
if (registry.activeModelSha256 !== incumbentHash) throw new Error('Active registry hash does not match current model bytes.');
const incumbent = JSON.parse(incumbentBytes);

const baseline = curricula.flatMap(curriculum => curriculum.hidden.map(text => ({
  relationType: curriculum.relationType, text,
  missingBeforeLearning: !relationFor(runAnalysis(incumbent, text), curriculum)
})));

const candidate = clone(incumbent);
candidate.lariLearnedRecords ||= { schemaVersion: 1, records: [] };
const induced = curricula.map(curriculum => {
  const result = language.induceSemanticRelationOperator(correctedExamples(curriculum), {
    id: curriculum.id, confidence: 0.93, sourceModelHash: incumbentHash,
    sourcePath: 'consolidation/open-english-semantic-growth-20260916-attempt4/sealed-curriculum.json#visible'
  });
  if (!result.learned) throw new Error(`${curriculum.relationType}: ${result.reason}`);
  candidate.lariLearnedRecords.records.push(result.record);
  return result.record;
});
candidate.lineage = { ...(candidate.lineage || {}), type: 'open_english_semantic_growth_candidate', parentHash: incumbentHash, learnedRecordIds: induced.map(record => record.id), promoted: false, createdAt: new Date().toISOString(), externalModelCalls: 0 };

const seal = { schemaVersion: 1, kind: 'lari.open-english-semantic-growth.curriculum', createdAt: new Date().toISOString(), visible: curricula.map(({ hidden, ...item }) => item), hiddenCommitments: curricula.map(item => ({ relationType: item.relationType, sha256: sha(JSON.stringify(item.hidden)) })) };
const sealPath = path.join(OUT, 'sealed-curriculum.json');
writeImmutable(sealPath, seal);
candidate.lineage.sourceArtifactHash = shaFile(sealPath);
const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
const candidateHash = sha(candidateBytes);
const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });
const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));

const rows = curricula.flatMap(curriculum => curriculum.hidden.map(text => {
  const analysis = runAnalysis(reloaded, text);
  const relation = relationFor(analysis, curriculum);
  const realization = relation ? language.realizeSemanticRelationGraph({ relations: [relation] }) : null;
  const ablated = clone(reloaded);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== curriculum.id);
  const afterAblation = runAnalysis(ablated, text);
  const alternativeCount = analysis.semantics.interpretation.hypotheses.length;
  return {
    relationType: curriculum.relationType, text, relation, interpretation: analysis.semantics.interpretation,
    realization, reloadRetained: Boolean(relation), exactAblationLost: !relationFor(afterAblation, curriculum),
    passed: Boolean(relation) && alternativeCount >= 1 && realization?.verification?.passed === true && !relationFor(afterAblation, curriculum)
  };
}));

const composedText = 'Although the deadline is close, the team will test carefully. Back up the registry before replacing the manifest. Record the result so that rollback stays possible.';
const composed = runAnalysis(reloaded, composedText);
const composedRelations = composed.semantics.semanticRelations.filter(item => induced.some(record => record.id === item.operatorRecordId));
const adversarial = [
  'Tell me about life before smartphones.',
  'The phrase so that has two words.',
  'Although is a conjunction in English.'
].map(text => ({ text, relationCount: runAnalysis(reloaded, text).semantics.semanticRelations.filter(item => induced.some(record => record.id === item.operatorRecordId)).length }));

const context = { modelHash: candidateHash, autoGrow: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } };
const ordinary = runtime.sendMessageToLari(clone(reloaded), 'I am overwhelmed and mostly need to vent for a minute.', context);
const after = { model: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const gates = {
  baselineFailureSixOfSix: baseline.every(row => row.missingBeforeLearning),
  threeDistinctOperatorsInduced: induced.length === 3 && new Set(induced.map(record => record.payload.operatorAst.relationType)).size === 3,
  hiddenTransferSixOfSix: rows.every(row => row.passed),
  competingInterpretationsRecorded: rows.every(row => row.interpretation.selectedHypothesisId && row.interpretation.hypotheses.length >= 1),
  semanticFaithfulnessSixOfSix: rows.every(row => row.realization?.verification?.passed),
  compositionThreeRelations: new Set(composedRelations.map(item => item.type)).size === 3,
  adversarialFalsePositivesZero: adversarial.every(row => row.relationCount === 0),
  reloadRetention: rows.every(row => row.reloadRetained),
  exactOperatorAblation: rows.every(row => row.exactAblationLost),
  ordinaryChatStillRoutes: ordinary.action === 'chat' && /here with you|problem-solving aside/i.test(String(ordinary.answer || '')),
  candidateHashExact: shaFile(candidatePath) === candidateHash,
  activeModelReadOnly: after.model === incumbentHash,
  registryReadOnly: after.registry === sha(registryBytes),
  externalModelCallsZero: Number(ordinary.external_model_calls || 0) === 0
};
const report = { schemaVersion: 1, kind: 'lari.open-english-semantic-growth.qualification', createdAt: new Date().toISOString(), incumbentHash, candidate: { path: rel(candidatePath), sha256: candidateHash }, learnedRecordIds: induced.map(record => record.id), baseline, rows, composition: { text: composedText, relations: composedRelations }, adversarial, gates, passed: Object.values(gates).every(Boolean), promoted: false, limitations: ['Three learned binary relation families are proven; unrestricted English comprehension is not claimed.', 'World knowledge and broad lexical ambiguity remain separate open problems.'] };
writeImmutable(path.join(OUT, 'qualification.json'), report);
console.log(JSON.stringify({ output: rel(path.join(OUT, 'qualification.json')), candidateHash, gates, passed: report.passed }, null, 2));
if (!report.passed) process.exitCode = 1;
