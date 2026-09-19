#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const neuro = require('../swarm_domain_neurogenesis.js');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'mixed-domain-program-growth-20260908');
const PARENT_REPORT = path.join(ROOT, 'consolidation', 'self-expanding-primitive-language-20260908', 'qualification-report.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PUBLIC = path.join(OUT, 'public-training.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (value, message) => { if (!value) throw new Error(message); };
const context = hash => ({ modelHash: hash, autoGrow: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });

function main() {
  assert(!fs.existsSync(SEAL) && !fs.existsSync(MANIFEST), 'Refusing to overwrite immutable mixed-domain artifacts.');
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const parentReport = JSON.parse(fs.readFileSync(PARENT_REPORT, 'utf8'));
  const parentPath = path.join(ROOT, parentReport.candidate.path);
  assert(parentReport.passed === true && shaFile(parentPath) === parentReport.candidate.sha256, 'Qualified Stage 1 parent is invalid.');
  const publicData = JSON.parse(fs.readFileSync(PUBLIC, 'utf8'));
  const seal = { schemaVersion: 1, kind: 'lari.mixed-domain-program-growth.sealed-index', createdAt: new Date().toISOString(), parentHash: parentReport.candidate.sha256, public: { path: rel(PUBLIC), sha256: shaFile(PUBLIC) }, hidden: { path: rel(HIDDEN), sha256: shaFile(HIDDEN), accessedByBuilder: false } };
  fs.writeFileSync(SEAL, `${JSON.stringify(seal, null, 2)}\n`, { flag: 'wx' });
  const model = JSON.parse(fs.readFileSync(parentPath, 'utf8'));
  const baselineRows = publicData.families.flatMap(family => family.interactionDemonstrations.map(item => {
    const response = runtime.sendMessageToLari(clone(model), item.prompt, context(parentReport.candidate.sha256));
    return { family: family.id, promptHash: sha(item.prompt), answer: response.answer, expected: item.response, failedAsRequired: response.answer !== item.response };
  }));
  assert(baselineRows.every(row => row.failedAsRequired), 'Parent unexpectedly implements a mixed-domain target.');
  const additions = [];
  for (const family of publicData.families) {
    const primitiveEvidence = { primitiveExamples: family.primitiveExamples, compositionExhausted: true, attemptedCompositionCount: 64, existingCompositionPassed: false, executableFailureObserved: true, executableProof: true };
    const operatorGap = neuro.createGap(model, { targetType: 'operator', capability: family.capability, failureClass: `no retained ${family.domain} program expresses the demonstrated relation`, failureEvidence: primitiveEvidence, sourceModelHash: parentReport.candidate.sha256, sourcePath: rel(PUBLIC) });
    const operatorProposal = neuro.proposeCandidate(model, operatorGap, { ...primitiveEvidence, domain: family.domain }, { sourceModelHash: parentReport.candidate.sha256, sourcePath: rel(PUBLIC), confidence: 0.9 });
    assert(operatorProposal.learned, `${family.id}: ${operatorProposal.reason || 'operator synthesis failed'}`);
    model.lariLearnedRecords.records.unshift(operatorProposal.record);
    const generatorGap = neuro.createGap(model, { targetType: 'generator', capability: `execute ${family.capability} for ordinary requests`, failureClass: 'compatible primitive exists but ordinary request cannot execute it', failureEvidence: { compatibleCapabilityAvailable: true, capabilityExecuted: false }, sourceModelHash: parentReport.candidate.sha256, sourcePath: rel(PUBLIC) });
    const generatorProposal = neuro.proposeCandidate(model, generatorGap, { domain: family.domain, interactionDemonstrations: family.interactionDemonstrations, derivedClaims: { canonical: { kind: 'primitive_apply', sourceSlot: 'source', primitiveId: operatorProposal.record.id } } }, { sourceModelHash: parentReport.candidate.sha256, sourcePath: rel(PUBLIC), confidence: 0.9 });
    assert(generatorProposal.learned, `${family.id}: ${generatorProposal.reason || 'generator synthesis failed'}`);
    model.lariLearnedRecords.records.unshift(generatorProposal.record);
    additions.push({ family: family.id, domain: family.domain, operatorGapId: operatorGap.id, generatorGapId: generatorGap.id, operatorId: operatorProposal.record.id, generatorId: generatorProposal.record.id, program: operatorProposal.record.payload.primitiveAst });
  }
  const publicRows = publicData.families.flatMap(family => family.interactionDemonstrations.map(item => {
    const expectedRecords = additions.find(row => row.family === family.id);
    const response = runtime.sendMessageToLari(clone(model), item.prompt, context('provisional-mixed-domain'));
    return { family: family.id, promptHash: sha(item.prompt), answer: response.answer, expected: item.response, learnedRecordIds: response.learnedRecordIds || [], passed: response.answer === item.response && response.publicAnswerSource === 'canonical_learned_record_execution' && response.learnedRecordIds.includes(expectedRecords.operatorId) && response.learnedRecordIds.includes(expectedRecords.generatorId) };
  }));
  assert(publicRows.every(row => row.passed), 'Mixed-domain records are not executable through the public kernel.');
  model.lineage = { ...(model.lineage || {}), parentHash: parentReport.candidate.sha256, canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel', developmentalEvent: 'mixed_domain_program_growth_provisional', createdAt: new Date().toISOString(), sourceFamilies: additions.map(row => row.family), sourceGapIds: additions.flatMap(row => [row.operatorGapId, row.generatorGapId]), sourceRecordIds: additions.flatMap(row => [row.operatorId, row.generatorId]), holdoutAccessedBeforeCandidate: false, promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const gates = { exactQualifiedParent: shaFile(parentPath) === parentReport.candidate.sha256, allParentBaselinesFail: baselineRows.every(row => row.failedAsRequired), twoDistinctDomains: new Set(additions.map(row => row.domain)).size === 2, fourCanonicalRecordsAdded: additions.length === 2 && new Set(additions.flatMap(row => [row.operatorId, row.generatorId])).size === 4, distinctLearnedPrograms: new Set(additions.map(row => row.program.programSha256)).size === 2, publicFailToPass: publicRows.every(row => row.passed), dependencyExecutionVisible: publicRows.every(row => { const ids = additions.find(item => item.family === row.family); return row.learnedRecordIds.includes(ids.operatorId) && row.learnedRecordIds.includes(ids.generatorId); }), hiddenUnreadBeforeCandidate: model.lineage.holdoutAccessedBeforeCandidate === false, exactCandidateHash: shaFile(candidatePath) === candidateHash, productionReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter), externalModelCallsZero: true };
  const manifest = { schemaVersion: 1, kind: 'lari.mixed-domain-program-growth.provisional-candidate', createdAt: new Date().toISOString(), promoted: false, parent: parentReport.candidate, candidate: { path: rel(candidatePath), sha256: candidateHash }, seal: { path: rel(SEAL), sha256: shaFile(SEAL), hiddenSha256: seal.hidden.sha256 }, additions, baselineRows, publicRows, gates, passed: Object.values(gates).every(Boolean), protectedBefore, protectedAfter, externalModelCalls: 0, limitations: ['The coding-facing family canonicalizes dependency data; it does not edit or repair a repository.', 'The reasoning family infers one affine relation; it is not broad mathematical reasoning.', 'This proves cumulative multi-domain program acquisition, not unrestricted open-ended learning.'] };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: manifest.passed, parentHash: parentReport.candidate.sha256, candidateHash, additions, gates }, null, 2));
  if (!manifest.passed) process.exitCode = 1;
}
main();
