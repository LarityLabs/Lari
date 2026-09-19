#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const BASE = path.join(ROOT, 'consolidation', 'beta-quality-candidate-v9-20260909', 'candidates', '483c7595293fb367d22fe4e676bace57b876ab8d708e523386abf7dabb15699d.json');
const OUT = path.join(ROOT, 'consolidation', 'claim-novelty-consolidation-20260909');
const REPORT = path.join(OUT, 'validation-report.json');
const TARGET = 'lari.learned.procedure.beta_quality.research_quality';
const clone = value => JSON.parse(JSON.stringify(value));
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shaText = value => crypto.createHash('sha256').update(value).digest('hex');
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

const duplicateLesson = {
  query: 'Explain how normal assistant conversation should remain direct and honest about capability boundaries.',
  sources: [
    { title: 'Conversation guidance', url: 'repo://LARI_PAPER.md#conversation', sourceType: 'internal_architecture_spec', trust: 0.94,
      text: 'A useful assistant answers directly and states honest capability boundaries. Natural conversation follows the user goal without exposing internal machinery by default.' }
  ]
};

const refinement = {
  query: 'Explain how source retractions should revise retained research knowledge.',
  hidden: 'What should happen to remembered evidence when its cited publisher retracts the source?',
  sources: [
    { title: 'Retraction handling specification', url: 'repo://LARI_PAPER.md#retractions', sourceType: 'internal_architecture_spec', trust: 0.96,
      text: 'When a publisher retracts a cited source, retained research marks the affected claim as disputed and preserves the prior provenance. The claim cannot support a future answer until replacement evidence is verified.' },
    { title: 'Retraction recovery procedure', url: 'repo://LARI_FULL_REPORT.md#retractions', sourceType: 'internal_verified_report', trust: 0.93,
      text: 'Retraction recovery searches for independent replacement sources, records the revision, and lowers confidence while evidence remains unresolved. A later answer exposes the disputed status rather than silently repeating the old claim.' }
  ]
};

function ask(model, prompt, hash, scope) {
  return runtime.sendMessageToLari(model, prompt, { modelHash: hash, autoGrow: false, userScope: scope,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });
}

function main() {
  if (fs.existsSync(REPORT)) throw new Error('Immutable novelty/consolidation proof already exists.');
  const beforeFiles = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const baseCount = base.lariLearnedRecords.records.length;

  const duplicateModel = clone(base);
  const duplicate = runtime.runAutonomousKnowledgeAcquisition(duplicateModel, duplicateLesson.query, {
    force: true,
    sources: duplicateLesson.sources,
    sourceAdapter: 'novelty_gate_duplicate_probe',
    sourceScoring: { minSourceScore: 0.15 }
  });

  const candidate = clone(base);
  const targetBefore = clone(candidate.lariLearnedRecords.records.find(record => record.id === TARGET));
  if (!targetBefore) throw new Error('Expected research-quality target is absent from v9.');
  const sectionsBefore = targetBefore.payload.responsePlan.sections.length;
  const learned = runtime.runAutonomousKnowledgeAcquisition(candidate, refinement.query, {
    force: true,
    sources: refinement.sources,
    sourceAdapter: 'failure_selected_research_refinement',
    sourceScoring: { minSourceScore: 0.15 },
    failureEvidence: {
      executedLearnedRecordIds: [TARGET],
      publicAnswerSource: 'learned_chat_procedure',
      action: 'chat'
    }
  });
  const targetAfter = candidate.lariLearnedRecords.records.find(record => record.id === TARGET);
  const addedClaimIds = learned.claimConsolidation?.addedClaimIds || [];
  candidate.lineage = { ...(candidate.lineage || {}), type: 'claim_novelty_consolidation_candidate', parentHash: shaFile(BASE), refinedRecordId: TARGET, addedClaimIds, promoted: false, createdAt: new Date().toISOString() };
  const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
  const candidateHash = shaText(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });

  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const response = ask(clone(reloaded), refinement.hidden, candidateHash, 'novelty-consolidation-hidden');
  const tracedIds = response.semanticClaimTrace?.map(item => item.claimId) || [];
  const ablated = clone(reloaded);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== TARGET);
  runtime.refreshLariKnowledgeProjections(ablated);
  const ablatedResponse = ask(ablated, refinement.hidden, candidateHash, 'novelty-consolidation-ablation');
  const afterFiles = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const serializedTarget = JSON.stringify(targetAfter);
  const gates = {
    duplicateRejectedWithoutNewRecord: duplicate.action === 'duplicate_existing_program'
      && duplicateModel.lariLearnedRecords.records.length === baseCount,
    exactFailedRecordRefined: learned.action === 'refined_existing_program'
      && learned.learned?.sourceLearnedRecordId === TARGET,
    recordIdentityPreserved: candidate.lariLearnedRecords.records.length === baseCount
      && targetAfter.id === targetBefore.id,
    uniqueGroundedClaimsAdded: addedClaimIds.length >= 2
      && targetAfter.payload.responsePlan.sections.length > sectionsBefore
      && targetAfter.payload.responsePlan.sections.filter(section => addedClaimIds.includes(section.id)).every(section => section.grounding?.citations?.length > 0),
    provenanceRevisionRecorded: targetAfter.provenance?.revisions?.[0]?.method === 'failure_selected_record_refinement'
      && targetAfter.provenance.revisions[0].addedClaimIds.length === addedClaimIds.length,
    hiddenTransferUsesSameRecord: response.executedLearnedRecordIds?.includes(TARGET) === true
      && addedClaimIds.some(id => tracedIds.includes(id))
      && /retract|disputed|replacement evidence/i.test(response.answer || ''),
    reloadRetention: response.semanticClaimVerification?.passed === true
      && response.semanticClaimVerification?.citationCoverage === true,
    exactAblationLosesRefinement: !ablatedResponse.executedLearnedRecordIds?.includes(TARGET)
      && !addedClaimIds.some(id => (ablatedResponse.semanticClaimTrace || []).some(item => item.claimId === id)),
    noPromptStorage: !serializedTarget.includes(refinement.query) && !serializedTarget.includes(refinement.hidden),
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    activeReadOnly: beforeFiles.active === afterFiles.active,
    registryReadOnly: beforeFiles.registry === afterFiles.registry,
    noPromotion: true,
    externalModelCallsZero: Number(response.external_model_calls || 0) === 0 && Number(ablatedResponse.external_model_calls || 0) === 0
  };
  const report = { schemaVersion: 1, kind: 'lari.claim-novelty-consolidation.validation', createdAt: new Date().toISOString(), parent: { path: rel(BASE), sha256: shaFile(BASE) },
    candidate: { path: rel(candidatePath), sha256: candidateHash, refinedRecordId: TARGET, addedClaimIds, promoted: false },
    duplicate: { action: duplicate.action, target: duplicate.claimConsolidation?.target || null, recordCountBefore: baseCount, recordCountAfter: duplicateModel.lariLearnedRecords.records.length },
    refinement: { action: learned.action, recordId: learned.learned?.sourceLearnedRecordId || null, sectionsBefore, sectionsAfter: targetAfter.payload.responsePlan.sections.length, addedClaimIds },
    hidden: { prompt: refinement.hidden, answer: response.answer, executedLearnedRecordIds: response.executedLearnedRecordIds, semanticClaimTrace: response.semanticClaimTrace, verification: response.semanticClaimVerification },
    ablation: { answer: ablatedResponse.answer, executedLearnedRecordIds: ablatedResponse.executedLearnedRecordIds, semanticClaimTrace: ablatedResponse.semanticClaimTrace },
    protectedBefore: beforeFiles, protectedAfter: afterFiles, gates, passed: Object.values(gates).every(Boolean) };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, candidate: report.candidate, duplicate: report.duplicate, refinement: report.refinement, gates }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
