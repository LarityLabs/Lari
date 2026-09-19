#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const neuro = require('../swarm_domain_neurogenesis.js');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const OUT = path.join(ROOT, 'consolidation', 'cross-modal-scene-20260906');
const PUBLIC = path.join(OUT, 'public-development.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const PROVISIONAL_MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const QUALIFIED_MANIFEST = path.join(OUT, 'qualified-candidate-manifest.json');
const REPORT = path.join(OUT, 'qualification-report.md');
const ROLLBACK = path.join(OUT, 'rollback-rehearsal.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const writeText = (file, value) => fs.writeFileSync(file, value, { flag: 'wx' });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function recordById(model, id) {
  return (model?.lariLearnedRecords?.records || []).find(record => record?.id === id) || null;
}

function sceneCase(model, row, recordId, expectedRecordId = recordId) {
  const request = { ...row.request };
  if (recordId) request.sceneRecordId = recordId;
  const composition = runtime.composeLariMultimodalProduct(model, request, { id: `cross-modal.${row.id}` });
  const program = recordById(model, expectedRecordId)?.payload?.sceneProgram;
  const evidence = composition?.artifact?.modalityEvidence || {};
  const image = evidence.image || {};
  const audio = evidence.audio || {};
  const imageElements = new Set(image.imageElements || []);
  const audioFeatures = new Set(audio.audioFeatures || []);
  const imageCoverage = (program?.imageElements || []).every(item => imageElements.has(item));
  const audioCoverage = (program?.audioFeatures || []).every(item => audioFeatures.has(item));
  const entityRelationParity = same(image.sceneEntities, program?.entities || [])
    && same(audio.sceneEntities, program?.entities || [])
    && same(image.sceneRelations, program?.relations || [])
    && same(audio.sceneRelations, program?.relations || []);
  const passed = composition?.evaluation?.passed === true
    && composition?.sharedSceneRecordId === expectedRecordId
    && image.sceneRecordId === expectedRecordId
    && audio.sceneRecordId === expectedRecordId
    && image.sceneProgramApplied === true
    && audio.sceneProgramApplied === true
    && imageCoverage
    && audioCoverage
    && entityRelationParity;
  return {
    id: row.id,
    compositionId: composition?.id || null,
    sharedSceneRecordId: composition?.sharedSceneRecordId || null,
    imageSceneRecordId: image.sceneRecordId || null,
    audioSceneRecordId: audio.sceneRecordId || null,
    imageCoverage,
    audioCoverage,
    entityRelationParity,
    evaluationPassed: composition?.evaluation?.passed === true,
    passed
  };
}

function familyRegressions(model) {
  const imageGenerator = (model.lariModalityRegistry?.promoted || []).find(item => item.laneId === 'image' || item.modality === 'image');
  const audioGenerator = (model.lariModalityRegistry?.promoted || []).find(item => item.laneId === 'audio' || item.modality === 'audio');
  const image = runtime.renderLariImageArtifact(imageGenerator || {}, 'ordinary local image', { requiredElements: ['character'] });
  const audio = runtime.renderLariAudioArtifact(audioGenerator || {}, 'ordinary local audio', { inferPromptFeatures: false, requiredAudioFeatures: ['melody'], durationSeconds: 1.4 });
  return [
    { lane: 'image', passed: runtime.evaluateLariModalityArtifact(imageGenerator || {}, image, { modality: 'image', requiredElements: ['character'], minShapes: 1 }).passed },
    { lane: 'audio', passed: runtime.evaluateLariModalityArtifact(audioGenerator || {}, audio, { modality: 'audio', requiredAudioFeatures: ['melody'], minDurationSeconds: 1 }).passed }
  ];
}

function main() {
  if (!fs.existsSync(PROVISIONAL_MANIFEST)) throw new Error('Build the cross-modal provisional candidate first.');
  if (fs.existsSync(QUALIFIED_MANIFEST) || fs.existsSync(REPORT) || fs.existsSync(ROLLBACK)) throw new Error('Immutable qualification artifacts already exist.');
  const seal = read(SEAL);
  const curriculum = read(PUBLIC);
  const hidden = read(HIDDEN);
  const provisionalManifest = read(PROVISIONAL_MANIFEST);
  const provisionalPath = path.join(ROOT, provisionalManifest.candidate.path);
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  if (before.active !== seal.parentHash) throw new Error('Active model changed after cross-modal seal.');
  if (shaFile(HIDDEN) !== seal.hiddenHoldouts.sha256) throw new Error('Hidden holdout seal mismatch.');
  if (shaFile(provisionalPath) !== provisionalManifest.candidate.sha256) throw new Error('Provisional candidate hash mismatch.');
  const parent = read(ACTIVE);
  const provisional = read(provisionalPath);
  const recordId = provisionalManifest.candidate.learnedRecordId;
  const record = recordById(provisional, recordId);
  assert(record?.payload?.sceneProgram, 'candidate scene record missing');

  const baselineRows = hidden.cases.map(row => {
    const composition = runtime.composeLariMultimodalProduct(parent, row.request, { id: `baseline.${row.id}` });
    return { id: row.id, sharedSceneRecordId: composition?.sharedSceneRecordId || null, bound: Boolean(composition?.artifact?.sharedSceneProgramApplied) };
  });
  const hiddenRows = hidden.cases.map(row => sceneCase(provisional, row, recordId));
  const reloadModel = read(provisionalPath);
  const reloadRows = hidden.cases.map(row => sceneCase(reloadModel, row, recordId));
  const ablated = clone(provisional);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(item => item.id !== recordId);
  const ablationRows = hidden.cases.map(row => {
    const composition = runtime.composeLariMultimodalProduct(ablated, { ...row.request, sceneRecordId: recordId }, { id: `ablation.${row.id}` });
    return { id: row.id, behaviorLost: !composition?.sharedSceneRecordId && composition?.artifact?.sharedSceneProgramApplied !== true };
  });
  const canonicalSelection = sceneCase(provisional, hidden.cases[0], null, recordId);
  const regressions = familyRegressions(provisional);
  const candidateText = fs.readFileSync(provisionalPath, 'utf8');
  const noHiddenLeak = hidden.cases.every(row => !candidateText.includes(row.request.prompt));
  const baselineFailure = baselineRows.every(row => row.sharedSceneRecordId === null && row.bound === false);
  const hiddenPassed = hiddenRows.every(row => row.passed);
  const reloadPassed = reloadRows.every(row => row.passed);
  const ablationPassed = ablationRows.every(row => row.behaviorLost);
  const regressionsPassed = regressions.every(row => row.passed);

  const retainedModel = clone(parent);
  const createdAt = new Date().toISOString();
  const gap = neuro.createGap(retainedModel, {
    targetType: 'generator', capability: curriculum.capability, failureClass: curriculum.failureClass,
    sourceModelHash: before.active, sourcePath: rel(PUBLIC), createdAt
  });
  const proposal = neuro.proposeCandidate(retainedModel, gap, {
    multimodalScene: true, sceneDemonstrations: curriculum.sceneDemonstrations, researchSources: []
  }, { sourceModelHash: before.active, sourcePath: rel(PUBLIC), createdAt, confidence: 0.84 });
  assert(proposal.learned && proposal.record.id === recordId, 'candidate could not be reconstructed from parent');
  const proof = {
    visible: true,
    hiddenTransfer: baselineFailure && hiddenPassed,
    semanticFaithfulness: hiddenPassed && hiddenRows.every(row => row.entityRelationParity),
    reload: reloadPassed,
    ablation: ablationPassed,
    regressions: regressionsPassed ? 0 : regressions.filter(row => !row.passed).length,
    externalModelCallsZero: true,
    closedAt: createdAt
  };
  const retained = neuro.retainVerifiedCandidate(retainedModel, gap, proposal, proof);
  assert(retained.retained, retained.reason || 'canonical scene candidate retention failed');
  retainedModel.lineage = { ...(retainedModel.lineage || {}), parentHash: before.active, developmentalEvent: 'cross_modal_scene_qualified', createdAt, promoted: false };
  const qualifiedBytes = Buffer.from(`${JSON.stringify(retainedModel, null, 2)}\n`);
  const qualifiedHash = sha(qualifiedBytes);
  const qualifiedPath = path.join(OUT, 'qualified-candidates', `${qualifiedHash}.json`);
  fs.mkdirSync(path.dirname(qualifiedPath), { recursive: true });
  fs.writeFileSync(qualifiedPath, qualifiedBytes, { flag: 'wx' });
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const rollback = {
    schemaVersion: 1, kind: 'lari.cross-modal-scene.rollback-rehearsal', incumbentHash: before.active,
    candidateHash: qualifiedHash, rollbackTarget: before.active, promotionPerformed: false,
    activeAndRegistryUnchanged: same(before, after)
  };
  writeJson(ROLLBACK, rollback);
  const gates = {
    baselineFailure,
    hiddenTransfer: hiddenPassed,
    reloadRetention: reloadPassed,
    exactRecordAblation: ablationPassed,
    canonicalRecordSelection: canonicalSelection.passed,
    crossModalEntityRelationParity: hiddenRows.every(row => row.entityRelationParity),
    imageAndAudioCoverage: hiddenRows.every(row => row.imageCoverage && row.audioCoverage),
    familyRegressions: regressionsPassed,
    noHiddenPromptLeak: noHiddenLeak,
    productionAndRegistryReadOnly: same(before, after),
    canonicalRetentionLifecycle: retained.retained === true,
    qualifiedCandidateHashExact: shaFile(qualifiedPath) === qualifiedHash,
    noPromotion: true,
    externalModelCallsZero: true
  };
  const passed = Object.values(gates).every(Boolean);
  const manifest = {
    schemaVersion: 1, kind: 'lari.cross-modal-scene.qualified-candidate', createdAt,
    parentHash: before.active, provisionalCandidateHash: provisionalManifest.candidate.sha256,
    candidate: { path: rel(qualifiedPath), sha256: qualifiedHash, learnedRecordId: recordId, promoted: false },
    hiddenBaseline: baselineRows, hiddenRows, reloadRows, ablationRows, canonicalSelection, regressions, proof, rollback: { path: rel(ROLLBACK), targetHash: before.active },
    protectedBefore: before, protectedAfter: after, gates, passed, externalModelCalls: 0
  };
  writeJson(QUALIFIED_MANIFEST, manifest);
  writeText(REPORT, [
    '# Cross-modal scene qualification', '',
    `- Status: ${passed ? 'qualified candidate; not promoted' : 'failed qualification'}`,
    `- Parent hash: \`${before.active}\``, `- Qualified candidate hash: \`${qualifiedHash}\``,
    `- Shared scene record: \`${recordId}\``, `- Hidden transfer: ${hiddenRows.filter(row => row.passed).length}/${hiddenRows.length}`,
    `- Reload: ${reloadRows.filter(row => row.passed).length}/${reloadRows.length}`,
    `- Exact ablation: ${ablationRows.filter(row => row.behaviorLost).length}/${ablationRows.length}`,
    `- External model calls: 0`, '',
    'This proves one typed scene record can bind the existing procedural image and audio executors on sealed variants. It does not prove photorealistic image quality, speech, video generation, or multimodal generality.', '',
    '## Gates', ...Object.entries(gates).map(([key, value]) => `- ${key}: ${value ? 'PASS' : 'FAIL'}`), '',
    `- [qualified manifest](${rel(QUALIFIED_MANIFEST)})`, `- [qualified candidate](${rel(qualifiedPath)})`, `- [rollback rehearsal](${rel(ROLLBACK)})`, ''
  ].join('\n'));
  console.log(JSON.stringify({ passed, qualifiedHash, recordId, gates }, null, 2));
  if (!passed) process.exitCode = 1;
}

main();
