'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const CANDIDATE = path.join(ROOT, 'consolidation', 'beta-quality-candidate-v9-20260909', 'candidates', '483c7595293fb367d22fe4e676bace57b876ab8d708e523386abf7dabb15699d.json');
const REPORT = path.resolve(ROOT, process.env.LARI_SEMANTIC_CLAIM_REPORT_PATH
  || path.join('consolidation', 'beta-quality-candidate-v9-20260909', 'semantic-claim-composition-validation.json'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

const cases = [
  ['repository_workflow', 'Walk me through inspecting an unknown repository and repairing the first verified defect.'],
  ['research_quality', 'How should retained research evidence support an answer after reload?'],
  ['agentic_experience', 'Explain how tools should request permission and verify safe workspace actions.'],
  ['release_judgment', 'What measured evidence should prevent a regressing candidate from promotion?'],
  ['multimodal_boundaries', 'What local image and audio generators are proven and where does video quality remain limited?'],
  ['growth_strategy', 'How should conversation, coding, and research weaknesses drive verified training gains?']
];

function ask(model, prompt, hash, scope) {
  return runtime.sendMessageToLari(model, prompt, {
    modelHash: hash,
    autoGrow: false,
    userScope: scope,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 }
    }
  });
}

function assess(model, family, prompt, hash, scope) {
  const expectedId = `lari.learned.procedure.beta_quality.${family}`;
  const response = ask(model, prompt, hash, scope);
  const source = (model.lariLearnedRecords?.records || []).find(record => record.id === expectedId);
  const claims = new Map((source?.payload?.responsePlan?.sections || []).map(section => [section.id, section]));
  const trace = response.semanticClaimTrace || [];
  const grounded = trace.length > 0 && trace.every(item => {
    const claim = claims.get(item.claimId);
    return claim && response.answer.includes(`${claim.label ? `${claim.label}: ` : ''}${claim.body}`);
  });
  return {
    family,
    prompt,
    expectedId,
    selectedIds: response.learnedRecordIds || [],
    executedIds: response.executedLearnedRecordIds || [],
    publicAnswerSource: response.publicAnswerSource || null,
    semanticClaimTrace: trace,
    semanticClaimVerification: response.semanticClaimVerification || null,
    grounded,
    answer: response.answer,
    externalModelCalls: Number(response.external_model_calls || 0),
    passed: (response.executedLearnedRecordIds || []).includes(expectedId)
      && response.publicAnswerSource === 'learned_chat_procedure'
      && response.semanticClaimVerification?.passed === true
      && grounded
      && Number(response.external_model_calls || 0) === 0
  };
}

function main() {
  if (!fs.existsSync(CANDIDATE)) throw new Error('Semantic-claim candidate is missing.');
  if (fs.existsSync(REPORT)) throw new Error('Semantic-claim validation artifact already exists.');
  const protectedBefore = { active: sha(ACTIVE), registry: sha(REGISTRY) };
  const candidateHash = sha(CANDIDATE);
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE, 'utf8'));
  const hidden = cases.map(([family, prompt], index) => assess(clone(candidate), family, prompt, candidateHash, `semantic-claim-hidden-${index}`));
  const reloaded = JSON.parse(fs.readFileSync(CANDIDATE, 'utf8'));
  const reload = cases.map(([family, prompt], index) => assess(clone(reloaded), family, prompt, candidateHash, `semantic-claim-reload-${index}`));
  const ablation = cases.map(([family, prompt], index) => {
    const expectedId = `lari.learned.procedure.beta_quality.${family}`;
    const ablated = clone(candidate);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== expectedId);
    const response = ask(ablated, prompt, candidateHash, `semantic-claim-ablation-${index}`);
    return {
      family,
      expectedId,
      executedAfterAblation: (response.executedLearnedRecordIds || []).includes(expectedId),
      claimTraceAfterAblation: response.semanticClaimTrace || [],
      behaviorLost: !(response.executedLearnedRecordIds || []).includes(expectedId)
        && !(response.semanticClaimTrace || []).some(item => item.sourceRecordId === expectedId)
    };
  });
  const candidateText = fs.readFileSync(CANDIDATE, 'utf8');
  const protectedAfter = { active: sha(ACTIVE), registry: sha(REGISTRY) };
  const gates = {
    hiddenExecutionBindingSixOfSix: hidden.length === 6 && hidden.every(item => item.passed),
    reloadExecutionBindingSixOfSix: reload.length === 6 && reload.every(item => item.passed),
    exactAblationSixOfSix: ablation.length === 6 && ablation.every(item => item.behaviorLost),
    candidateHashExact: candidateHash === '483c7595293fb367d22fe4e676bace57b876ab8d708e523386abf7dabb15699d',
    noValidationPromptStored: cases.every(([, prompt]) => !candidateText.includes(prompt)),
    productionReadOnly: protectedBefore.active === protectedAfter.active && protectedBefore.registry === protectedAfter.registry,
    externalModelCallsZero: [...hidden, ...reload].every(item => item.externalModelCalls === 0),
    noPromotion: true
  };
  const report = {
    schemaVersion: 1,
    kind: 'lari.semantic-claim-composition-validation',
    createdAt: new Date().toISOString(),
    candidate: { path: path.relative(ROOT, CANDIDATE).replace(/\\/g, '/'), sha256: candidateHash, promoted: false },
    hidden,
    reload,
    ablation,
    protectedBefore,
    protectedAfter,
    gates,
    passed: Object.values(gates).every(Boolean),
    externalModelCalls: 0
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ report: path.relative(ROOT, REPORT).replace(/\\/g, '/'), candidateHash, gates, passed: report.passed }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
