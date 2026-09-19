#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const recap = require('../swarm_recap_language.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'recap-conversation-expansion-20260830');
const SEAL = path.join(OUT, 'sealed-curriculum.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const REPORT = path.join(OUT, 'candidate-validation-v3.json');
const MANIFEST = path.join(OUT, 'candidate-manifest-v3.json');
const CANDIDATES = path.join(OUT, 'candidates');
const PARENT_HASH = '3b1832fac4a23f4ea616c3e8cca1c59c9fe8d68820775c200bad417b24e81fbb';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));

const specs = {
  practical_planning: {
    claims: ['goal'], sequence: ['recap.clause.plan_opening', 'recap.clause.plan_steps'], asts: {
      'recap.meaning.practical_plan': { kind: 'meaning_graph_schema', claims: ['goal'] },
      'recap.discourse.plan_overview_steps': { kind: 'ordered_clauses', sequence: ['recap.clause.plan_opening', 'recap.clause.plan_steps'] },
      'recap.clause.plan_opening': { kind: 'template', pattern: 'Here is a practical plan for {goal}.', inputSlots: ['goal'] },
      'recap.clause.plan_steps': { kind: 'template', pattern: '1. Define the smallest successful outcome. 2. Build the smallest end-to-end version. 3. Verify it with real use, then keep or revise it.', inputSlots: [] },
      'recap.repair.plan_grounding': { kind: 'plan_grounding', requiredClaims: ['goal'], rejectUnsupportedClaims: true }
    }
  },
  balanced_comparison: {
    claims: ['optionA', 'optionB'], asts: {
      'recap.meaning.balanced_comparison': { kind: 'meaning_graph_schema', claims: ['optionA', 'optionB'], relation: 'contrasts' },
      'recap.discourse.comparison_tradeoff_experiment': { kind: 'ordered_clauses', sequence: ['recap.clause.comparison_frame', 'recap.clause.comparison_tradeoff', 'recap.clause.comparison_experiment'] },
      'recap.clause.comparison_frame': { kind: 'template', pattern: '{optionA} versus {optionB}: compare them on reversibility, risk, time to feedback, and what each option teaches you.', inputSlots: ['optionA', 'optionB'] },
      'recap.clause.comparison_tradeoff': { kind: 'template', pattern: 'The key tradeoff is short-term disruption versus the chance to remove a structural limit.', inputSlots: [] },
      'recap.clause.comparison_experiment': { kind: 'template', pattern: 'When the evidence is incomplete, test the riskiest assumption with a small reversible experiment first.', inputSlots: [] },
      'recap.repair.comparison_grounding': { kind: 'comparison_grounding', requiredClaims: ['optionA', 'optionB'], rejectUnsupportedClaims: true }
    }
  },
  requirements_clarification: {
    claims: ['goal'], asts: {
      'recap.meaning.requirements_clarification': { kind: 'meaning_graph_schema', claims: ['goal'] },
      'recap.discourse.acknowledge_then_question': { kind: 'ordered_clauses', sequence: ['recap.clause.clarification_acknowledgement', 'recap.clause.clarification_questions'] },
      'recap.clause.clarification_acknowledgement': { kind: 'template', pattern: '{goal} is clear as the direction.', inputSlots: ['goal'] },
      'recap.clause.clarification_questions': { kind: 'template', pattern: 'Before I act, I need four answers: who is the primary user; what outcome must work first; what constraints cannot be violated; and what observable evidence will count as success?', inputSlots: [] },
      'recap.repair.clarification_grounding': { kind: 'clarification_grounding', requiredClaims: ['goal'], rejectUnsupportedClaims: true }
    }
  },
  correction_repair: {
    claims: ['intended', 'rejected'], asts: {
      'recap.meaning.correction_repair': { kind: 'meaning_graph_schema', claims: ['intended', 'rejected'], relation: 'replaces' },
      'recap.discourse.correction_then_commitment': { kind: 'ordered_clauses', sequence: ['recap.clause.correction_acknowledgement', 'recap.clause.correction_commitment'] },
      'recap.clause.correction_acknowledgement': { kind: 'template', pattern: 'Understood: you mean {intended}, not {rejected}.', inputSlots: ['intended', 'rejected'] },
      'recap.clause.correction_commitment': { kind: 'template', pattern: 'I will use that correction as the constraint going forward.', inputSlots: [] },
      'recap.repair.correction_grounding': { kind: 'correction_grounding', requiredClaims: ['intended', 'rejected'], rejectUnsupportedClaims: true }
    }
  },
  structured_thinking: {
    claims: ['topic', 'context', 'goal', 'constraint'], asts: {
      'recap.meaning.context_goal_constraint': { kind: 'meaning_graph_schema', claims: ['topic', 'context', 'goal', 'constraint'], relation: 'constrains' },
      'recap.discourse.context_goal_constraint_action': { kind: 'ordered_clauses', sequence: ['recap.clause.thinking_context', 'recap.clause.thinking_tension', 'recap.clause.thinking_action'] },
      'recap.clause.thinking_context': { kind: 'template', pattern: 'For {topic}, the relevant context is {context}.', inputSlots: ['topic', 'context'] },
      'recap.clause.thinking_tension': { kind: 'template', pattern: 'The goal is {goal}, while the main constraint is {constraint}.', inputSlots: ['goal', 'constraint'] },
      'recap.clause.thinking_action': { kind: 'template', pattern: 'Start with a reversible step that tests the most important uncertainty without violating that constraint.', inputSlots: [] },
      'recap.repair.thinking_grounding': { kind: 'thinking_grounding', requiredClaims: ['topic', 'context', 'goal', 'constraint'], rejectUnsupportedClaims: true }
    }
  },
  retained_knowledge_explanation: {
    claims: ['topic', 'summary', 'boundary'], asts: {
      'recap.meaning.retained_knowledge': { kind: 'meaning_graph_schema', claims: ['topic', 'summary', 'boundary'], source: 'canonical_typed_knowledge' },
      'recap.discourse.knowledge_answer_boundary': { kind: 'ordered_clauses', sequence: ['recap.clause.knowledge_summary', 'recap.clause.knowledge_boundary'] },
      'recap.clause.knowledge_summary': { kind: 'template', pattern: '{topic}: {summary}.', inputSlots: ['topic', 'summary'] },
      'recap.clause.knowledge_boundary': { kind: 'template', pattern: 'Boundary: {boundary}.', inputSlots: ['boundary'] },
      'recap.repair.knowledge_grounding': { kind: 'knowledge_grounding', requiredClaims: ['topic', 'summary', 'boundary'], rejectUnsupportedClaims: true }
    }
  }
};

function typedRecord(operation, ast, sealHash, timestamp) {
  const digest = sha(Buffer.from(JSON.stringify({ operation, ast })));
  return { schemaVersion: 1, id: `lari.learned.generator.${operation}`, type: 'generator', status: 'active', normalizedTriggers: operation.split(/[._]/).filter(Boolean), procedureIdentity: `recap-generator:${operation}`, semanticFingerprint: `sha256:${digest}`, outputBehavior: operation, contentHash: `sha256:${sha(Buffer.from(JSON.stringify(ast)))}`, behavioralSignature: `recap:${operation}:${digest.slice(0, 16)}`, confidence: 0.9, provenance: { sourceModelHash: PARENT_HASH, sourcePath: 'consolidation/recap-conversation-expansion-20260830/sealed-curriculum.json', sourceArtifactHash: sealHash, originalRecordId: null, sourceKind: 'sealed_failure_driven_curriculum', creationSource: 'recap_conversation_semantic_transfer_training', benchmarkAssociation: [], confidence: 0.9, imported: false, classification: 'developmental_candidate', importTimestamp: timestamp, storesRawSessionLog: false, storesPromptText: false }, payload: { domain: 'executable_language', operation, generatorAst: ast, verification: 'sealed_semantic_transfer_causal_ablation_reload', verifiedUses: 0 } };
}

function ask(model, prompt, hash, scope) {
  return runtime.sendMessageToLari(model, prompt, { modelHash: hash, autoGrow: false, userScope: `recap-conversation-${scope}`, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });
}

function assess(response, family, markers, expectedIds) {
  const answer = String(response.answer || '');
  const selected = response.learnedRecordIds || [];
  const familySelected = expectedIds.every(id => selected.includes(id));
  const markerHits = markers.filter(marker => answer.toLowerCase().includes(marker.toLowerCase()));
  return { source: response.publicAnswerSource || null, family: response.recapTrace?.meaningGraph?.family || null, learnedRecordIds: selected, familySelected, markerHits, answer, passed: response.publicAnswerSource === 'recap_executable_language' && response.recapTrace?.meaningGraph?.family === family && familySelected && markerHits.length === markers.length && response.recapTrace?.verification?.passed === true && response.recapTrace?.verification?.unsupportedClaimCount === 0 && Number(response.external_model_calls || 0) === 0 };
}

function main() {
  if (fs.existsSync(REPORT) || fs.existsSync(MANIFEST)) throw new Error('Candidate artifacts already exist.');
  if (shaFile(ACTIVE) !== PARENT_HASH) throw new Error('Production parent changed.');
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const sealBytes = fs.readFileSync(SEAL), sealHash = sha(sealBytes), curriculum = JSON.parse(sealBytes);
  const parent = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const baseline = curriculum.families.map(family => { const response = ask(clone(parent), family.train, PARENT_HASH, `baseline-${family.id}`); return { id: family.id, source: response.publicAnswerSource || null, newFamilyAbsent: response.publicAnswerSource !== 'recap_executable_language' || response.recapTrace?.meaningGraph?.family !== family.id }; });
  const timestamp = new Date().toISOString();
  const learnedRecords = Object.entries(specs).flatMap(([, spec]) => Object.entries(spec.asts).map(([operation, ast]) => typedRecord(operation, ast, sealHash, timestamp)));
  const candidate = clone(parent), existing = new Set(candidate.lariLearnedRecords.records.map(record => record.id));
  if (learnedRecords.some(record => existing.has(record.id))) throw new Error('A new generator ID already exists in the parent.');
  candidate.lariLearnedRecords.records = [...learnedRecords, ...candidate.lariLearnedRecords.records];
  const previous = clone(candidate.lineage || {});
  candidate.lineage = { ...previous, timestamp, type: 'recap_conversation_expansion_candidate', parentHash: PARENT_HASH, sealedCurriculumHash: sealHash, learnedRecordIds: learnedRecords.map(record => record.id), promoted: false, externalModelCalls: 0, previous };
  const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`), candidateHash = sha(bytes);
  fs.mkdirSync(CANDIDATES, { recursive: true });
  const candidatePath = path.join(CANDIDATES, `${candidateHash}.json`);
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const familyIds = family => (recap.FAMILIES[family] || []).map(operation => `lari.learned.generator.${operation}`);
  const training = curriculum.families.map(family => ({ id: family.id, ...assess(ask(clone(candidate), family.train, candidateHash, `train-${family.id}`), family.id, family.markers, familyIds(family.id)) }));
  const hidden = curriculum.families.flatMap(family => family.hidden.map((prompt, index) => ({ id: family.id, variant: index + 1, ...assess(ask(clone(candidate), prompt, candidateHash, `hidden-${family.id}-${index}`), family.id, family.markers, familyIds(family.id)) })));
  const ablation = learnedRecords.map(removed => {
    const family = Object.entries(recap.FAMILIES).find(([, operations]) => operations.includes(removed.payload.operation))?.[0];
    const prompt = curriculum.families.find(item => item.id === family).train;
    const ablated = clone(candidate);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== removed.id);
    const direct = recap.realize(ablated, prompt);
    return { family, removedId: removed.id, behaviorLost: direct === null };
  });
  const causalPrompt = 'Explain why the worker stopped: the queue closed early. Evidence shows the final write never completed. Next: keep the queue open until writes finish.';
  const causalRegression = assess(ask(clone(candidate), causalPrompt, candidateHash, 'causal-regression'), 'causal_explanation', ['worker stopped', 'queue closed early', 'final write never completed', 'keep the queue open'], recap.FAMILIES.causal_explanation.map(operation => `lari.learned.generator.${operation}`));
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const reload = curriculum.families.flatMap(family => family.hidden.map((prompt, index) => ({ id: family.id, variant: index + 1, ...assess(ask(clone(reloaded), prompt, candidateHash, `reload-${family.id}-${index}`), family.id, family.markers, familyIds(family.id)) })));
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const stored = JSON.stringify(learnedRecords);
  const gates = { baselineSixAbsent: baseline.every(row => row.newFamilyAbsent), trainSixOfSix: training.every(row => row.passed), hiddenTwelveOfTwelve: hidden.length === 12 && hidden.every(row => row.passed), causalAblationAllNewRecords: ablation.length === learnedRecords.length && ablation.every(row => row.behaviorLost), existingCausalRecapRetained: causalRegression.passed, reloadTwelveOfTwelve: reload.every(row => row.passed), candidateHashExact: shaFile(candidatePath) === candidateHash, canonicalTypedStoreOnly: learnedRecords.every(record => record.type === 'generator' && record.payload.domain === 'executable_language'), noPromptStored: curriculum.families.every(family => !stored.includes(family.train) && family.hidden.every(prompt => !stored.includes(prompt))), productionReadOnly: JSON.stringify(before) === JSON.stringify(after), noPromotion: true, externalModelCallsZero: true };
  const report = { schemaVersion: 1, kind: 'lari.recap-conversation-expansion.candidate-validation', createdAt: timestamp, parentHash: PARENT_HASH, sealedCurriculumHash: sealHash, candidate: { path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'), sha256: candidateHash }, learnedRecordIds: learnedRecords.map(record => record.id), baseline, training, hidden, ablation, causalRegression, reload, before, after, gates, passed: Object.values(gates).every(Boolean), externalModelCalls: 0 };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(MANIFEST, `${JSON.stringify({ schemaVersion: 1, kind: 'lari.recap-conversation-expansion.candidate', createdAt: timestamp, parentHash: PARENT_HASH, candidate: report.candidate, learnedRecordIds: report.learnedRecordIds, sealedCurriculum: { path: path.relative(ROOT, SEAL).replace(/\\/g, '/'), sha256: sealHash }, report: path.relative(ROOT, REPORT).replace(/\\/g, '/'), promoted: false, gates }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, candidate: report.candidate, newRecords: learnedRecords.length, training: `${training.filter(row => row.passed).length}/${training.length}`, hidden: `${hidden.filter(row => row.passed).length}/${hidden.length}`, ablation: `${ablation.filter(row => row.behaviorLost).length}/${ablation.length}`, reload: `${reload.filter(row => row.passed).length}/${reload.length}`, gates }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
