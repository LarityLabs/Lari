#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const ATTEMPT = process.argv.includes('--attempt7') ? 'attempt7' : process.argv.includes('--attempt6') ? 'attempt6' : process.argv.includes('--attempt5') ? 'attempt5' : process.argv.includes('--attempt4') ? 'attempt4' : process.argv.includes('--attempt3') ? 'attempt3' : process.argv.includes('--attempt2') ? 'attempt2' : null;
const OUT = path.join(ROOT, 'consolidation', `failure-research-claim-neurogenesis-20260909${ATTEMPT ? `-${ATTEMPT}` : ''}`);
const REPORT = path.join(OUT, 'validation-report.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shaText = text => crypto.createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

const tasks = [
  {
    id: 'distributed_coordination',
    train: 'Explain the Zephyr handoff protocol and why epoch fencing matters.',
    hidden: 'Why does Zephyr reject an old coordinator after failover?',
    required: ['epoch', 'reject'],
    sources: [
      {
        title: 'Zephyr coordination specification',
        url: 'https://example.test/zephyr/spec',
        sourceType: 'official_spec_fixture',
        trust: 0.96,
        text: 'Zephyr handoff assigns every coordinator an increasing epoch before it may publish writes. A receiver rejects a Zephyr write whose epoch is lower than the highest epoch it has accepted. This Zephyr fencing rule prevents a delayed former coordinator from changing state after failover.'
      },
      {
        title: 'Zephyr operations guide',
        url: 'https://example.test/zephyr/operations',
        sourceType: 'official_manual_fixture',
        trust: 0.93,
        text: 'During Zephyr failover, the new coordinator persists its epoch before serving traffic. Operators verify Zephyr fencing by replaying a delayed old-epoch write and observing rejection.'
      }
    ]
  },
  {
    id: 'replay_protection',
    train: 'How should Borealis tokens handle replay after failover?',
    hidden: 'What stops a reused Borealis token from succeeding on a replacement node?',
    required: ['nonce', 'reject'],
    sources: [
      {
        title: 'Borealis token protocol',
        url: 'https://example.test/borealis/protocol',
        sourceType: 'official_spec_fixture',
        trust: 0.95,
        text: 'Every Borealis token carries a one-time nonce and a monotonic generation. A Borealis replacement node rejects a nonce already recorded in its replicated replay ledger. The generation prevents a token issued before failover from authorizing a later session.'
      },
      {
        title: 'Borealis recovery manual',
        url: 'https://example.test/borealis/recovery',
        sourceType: 'official_manual_fixture',
        trust: 0.92,
        text: 'Before Borealis resumes traffic after failover, it restores the replay ledger and current generation. A recovery check reuses a prior nonce and must observe the Borealis request being rejected.'
      }
    ]
  },
  {
    id: 'incremental_restore',
    train: 'Teach me how Calyx snapshot markers support a safe incremental restore.',
    hidden: 'Why must a Calyx restore validate its snapshot marker before applying later segments?',
    required: ['marker', 'segment'],
    sources: [
      {
        title: 'Calyx snapshot format',
        url: 'https://example.test/calyx/format',
        sourceType: 'official_spec_fixture',
        trust: 0.94,
        text: 'A Calyx snapshot marker contains the base sequence and checksum for the restored state. Calyx validates the marker checksum before applying any later segment. A segment whose starting sequence does not follow the marker is rejected.'
      },
      {
        title: 'Calyx restore procedure',
        url: 'https://example.test/calyx/restore',
        sourceType: 'official_manual_fixture',
        trust: 0.91,
        text: 'The Calyx restore process loads the snapshot, verifies its marker, and then applies segments in sequence order. Operators prove the restore by corrupting a marker in isolation and observing failure before any segment is applied.'
      }
    ]
  }
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

async function main() {
  if (fs.existsSync(REPORT)) throw new Error('Immutable neurogenesis validation already exists.');
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const candidate = clone(active);
  const baseline = [];
  const learning = [];
  const learnedRecords = [];

  for (const [index, task] of tasks.entries()) {
    const baseResponse = ask(clone(active), task.train, before.active, `claim-neurogenesis-baseline-${index}`);
    baseline.push({ id: task.id, passed: baseResponse.passed, source: baseResponse.publicAnswerSource, answer: baseResponse.answer });
    const working = clone(active);
    const response = await runtime.sendMessageToLariAsync(working, task.train, {
      modelHash: before.active,
      autoGrow: false,
      operator: false,
      userScope: `claim-neurogenesis-learning-${index}`,
      research: {
        sources: task.sources,
        sourceAdapter: 'sealed_authoritative_fixture',
        sourceScoring: { minSourceScore: 0.2 }
      },
      kernel: {
        useBenchmarkSystem: false,
        useCapabilityGraph: true,
        capabilityGraph: { minScore: 0 },
        chat: { minMemoryScore: 0, minRouteScore: 0 }
      }
    });
    const learnedRecordId = response.autonomousResearch?.learned?.sourceLearnedRecordId
      || response.autonomousResearch?.learned?.lariTypedRecordId
      || response.executedLearnedRecordIds?.find(id => id.startsWith('lari.learned.knowledge.'));
    const learnedRecord = (working.lariLearnedRecords?.records || []).find(record => record.id === learnedRecordId);
    if (!learnedRecord) throw new Error(`${task.id} did not retain a canonical learned record.`);
    candidate.lariLearnedRecords.records = [clone(learnedRecord), ...candidate.lariLearnedRecords.records.filter(record => record.id !== learnedRecord.id)];
    runtime.refreshLariKnowledgeProjections(candidate);
    learnedRecords.push(learnedRecord);
    learning.push({
      id: task.id,
      initialFailure: baseResponse.passed !== true,
      action: response.action,
      learnedRecordId,
      executed: response.executedLearnedRecordIds?.includes(learnedRecordId) === true,
      publicAnswerSource: response.publicAnswerSource,
      semanticClaimTrace: response.semanticClaimTrace,
      semanticClaimVerification: response.semanticClaimVerification,
      externalModelCalls: response.external_model_calls || 0
    });
  }

  candidate.lineage = {
    ...(candidate.lineage || {}),
    type: 'failure_research_grounded_claim_candidate',
    parentHash: before.active,
    learnedRecordIds: learnedRecords.map(record => record.id),
    promoted: false,
    createdAt: new Date().toISOString()
  };
  const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
  const candidateHash = shaText(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });

  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const hidden = tasks.map((task, index) => {
    const recordId = learnedRecords[index].id;
    const response = ask(clone(reloaded), task.hidden, candidateHash, `claim-neurogenesis-hidden-${index}`);
    const lower = String(response.answer || '').toLowerCase();
    return {
      id: task.id,
      recordId,
      executed: response.executedLearnedRecordIds?.includes(recordId) === true,
      source: response.publicAnswerSource,
      requiredPresent: task.required.every(term => lower.includes(term)),
      citationGrounded: response.semanticClaimVerification?.passed === true
        && response.semanticClaimVerification?.citationCoverage === true
        && (response.semanticClaimTrace || []).every(claim => (claim.grounding?.citations || []).length > 0),
      answer: response.answer,
      externalModelCalls: response.external_model_calls || 0
    };
  });
  const ablation = tasks.map((task, index) => {
    const recordId = learnedRecords[index].id;
    const ablated = clone(reloaded);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== recordId);
    runtime.refreshLariKnowledgeProjections(ablated);
    const response = ask(ablated, task.hidden, candidateHash, `claim-neurogenesis-ablation-${index}`);
    return {
      id: task.id,
      recordId,
      recordAbsent: !(ablated.lariLearnedRecords?.records || []).some(record => record.id === recordId),
      executionLost: !response.executedLearnedRecordIds?.includes(recordId)
        && !(response.semanticClaimTrace || []).some(claim => claim.sourceRecordId === recordId)
    };
  });
  const serializedRecords = JSON.stringify(learnedRecords);
  const promptLeaks = tasks.flatMap(task => [task.train, task.hidden]).filter(prompt => serializedRecords.includes(prompt));
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const gates = {
    failureTriggeredThreeOfThree: learning.length === 3 && learning.every(item => item.initialFailure),
    researchRetainedThreeOfThree: learning.every(item => item.action === 'chat_after_autonomous_research' && item.learnedRecordId),
    immediateExecutionThreeOfThree: learning.every(item => item.executed && item.publicAnswerSource === 'learned_chat_procedure'),
    groundedProgramSchemaThreeOfThree: learnedRecords.every(record => record.type === 'knowledge'
      && record.payload?.operation === 'compose_chat_response'
      && record.payload?.responsePlan?.composition === 'grounded_research_claims'
      && record.payload.responsePlan.sections.every(section => section.grounding?.citations?.length > 0)),
    hiddenTransferThreeOfThree: hidden.every(item => item.executed && item.source === 'learned_chat_procedure' && item.requiredPresent && item.citationGrounded),
    reloadRetentionThreeOfThree: hidden.every(item => item.executed),
    exactAblationThreeOfThree: ablation.every(item => item.recordAbsent && item.executionLost),
    noPromptStorage: promptLeaks.length === 0,
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    activeReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry,
    noPromotion: true,
    externalModelCallsZero: learning.every(item => item.externalModelCalls === 0) && hidden.every(item => item.externalModelCalls === 0)
  };
  const report = {
    schemaVersion: 1,
    kind: 'lari.failure-research-grounded-claim-neurogenesis.validation',
    createdAt: new Date().toISOString(),
    parentHash: before.active,
    candidate: { path: rel(candidatePath), sha256: candidateHash, learnedRecordIds: learnedRecords.map(record => record.id), promoted: false },
    baseline,
    learning,
    hidden,
    ablation,
    promptLeaks,
    protectedBefore: before,
    protectedAfter: after,
    gates,
    passed: Object.values(gates).every(Boolean)
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, candidate: report.candidate, gates }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
