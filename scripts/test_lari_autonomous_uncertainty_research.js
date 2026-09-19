#!/usr/bin/env node
'use strict';

// Candidate-only proof that autonomous chat can notice an uncertainty gap,
// use the existing source-backed acquisition lifecycle, retain a typed record,
// and reuse it after reload. This is not a new benchmark or persistence layer.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const OUT = path.join(ROOT, 'consolidation', 'autonomous-uncertainty-research-20260906');
const PARENT_HASH = crypto.createHash('sha256').update(fs.readFileSync(ACTIVE)).digest('hex');
const PROMPT = 'What is the quartz-ladder lease fencing protocol?';
const SOURCES = [{
  title: 'Quartz ladder protocol',
  url: 'local://quartz-ladder-protocol',
  text: 'Quartz-ladder leases acknowledge only after a durable fence-token commit. Readers may continue until the epoch changes.'
}];

const clone = value => JSON.parse(JSON.stringify(value));
const hashBytes = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => hashBytes(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeExclusive = (file, value) => {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const options = (modelHash, autoResearchOnUncertainty, withSources) => ({
  mode: 'chat',
  modelHash,
  groundedFactual: false,
  autoResearchOnUncertainty,
  research: withSources ? { sources: SOURCES, sourceAdapter: 'local_test_sources' } : { sources: [] }
});

async function main() {
  if (fs.existsSync(OUT)) throw new Error(`Refusing to overwrite immutable output: ${path.relative(ROOT, OUT)}`);
  const protectedBefore = { active: fileHash(ACTIVE), registry: fileHash(REGISTRY) };
  if (protectedBefore.active !== PARENT_HASH) throw new Error('Active model changed before candidate construction.');
  const parent = read(ACTIVE);

  const baselineModel = clone(parent);
  const baseline = await runtime.runLariAutonomousRequest(baselineModel, { mode: 'chat', prompt: PROMPT }, options(PARENT_HASH, false, false));

  const candidate = clone(parent);
  const learned = await runtime.runLariAutonomousRequest(candidate, { mode: 'chat', prompt: PROMPT }, options(PARENT_HASH, true, true));
  const learnedRecordId = learned.learning?.learned?.lariTypedRecordId
    || learned.learning?.learned?.sourceLearnedRecordId
    || learned.learning?.learned?.id
    || null;
  if (!learnedRecordId) throw new Error('Autonomous uncertainty research did not return a typed learned-record ID.');
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: PARENT_HASH,
    developmentalEvent: 'autonomous_uncertainty_research_candidate',
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    learnedRecordId,
    promoted: false,
    createdAt: new Date().toISOString()
  };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = hashBytes(candidateBytes);
  const candidatePath = path.join(OUT, `candidate-${candidateHash}.json`);
  fs.mkdirSync(OUT, { recursive: true });
  writeExclusive(candidatePath, candidateBytes);

  const reloaded = read(candidatePath);
  const reload = await runtime.runLariAutonomousRequest(reloaded, { mode: 'chat', prompt: PROMPT }, options(candidateHash, false, false));

  const ablated = clone(candidate);
  ablated.lariLearnedRecords.records = (ablated.lariLearnedRecords.records || [])
    .filter(record => record.id !== learnedRecordId);
  const ablation = await runtime.runLariAutonomousRequest(ablated, { mode: 'chat', prompt: PROMPT }, options(candidateHash, false, false));

  const baselineHasRecord = JSON.stringify(baselineModel).includes(learnedRecordId);
  const candidateRecord = candidate.lariLearnedRecords.records.find(record => record.id === learnedRecordId) || null;
  const retainedAfterReload = reload.publicAnswerSource === 'verified_retained_knowledge'
    && /fence-token|epoch/i.test(String(reload.answer || ''))
    && reload.passed === true;
  const ablationLostBehavior = ablation.publicAnswerSource !== 'verified_retained_knowledge'
    && !/fence-token|epoch/i.test(String(ablation.answer || ''));
  const protectedAfter = { active: fileHash(ACTIVE), registry: fileHash(REGISTRY), candidate: fileHash(candidatePath) };
  const gates = {
    baselineDetectedGap: baselineHasRecord === false && baseline.publicAnswerSource !== 'verified_retained_knowledge',
    uncertaintyTriggeredResearch: learned.action === 'chat_after_autonomous_research'
      && learned.learning?.action === 'learned_from_sources'
      && learned.learning?.sourceCount === 1,
    typedRecordRetained: candidateRecord?.type === 'knowledge'
      && candidateRecord?.provenance?.sourceKind === 'grounded_research_knowledge'
      && candidateRecord?.provenance?.storesTestAnswers === undefined,
    visibleFollowupPassed: learned.passed === true && learned.publicAnswerSource === 'verified_retained_knowledge',
    reloadRetention: retainedAfterReload,
    exactRecordAblation: ablationLostBehavior,
    noExternalModelCalls: Number(learned.external_model_calls || 0) === 0
      && Number(reload.external_model_calls || 0) === 0
      && Number(ablation.external_model_calls || 0) === 0,
    activeAndRegistryReadOnly: protectedBefore.active === protectedAfter.active
      && protectedBefore.registry === protectedAfter.registry,
    candidateHashExact: protectedAfter.candidate === candidateHash,
    noPromotion: true
  };
  const passed = Object.values(gates).every(Boolean);
  const evidence = {
    schemaVersion: 1,
    kind: 'lari.autonomous-uncertainty-research.candidate',
    createdAt: new Date().toISOString(),
    parentHash: PARENT_HASH,
    candidate: { path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'), sha256: candidateHash, promoted: false },
    learnedRecordId,
    baseline: { action: baseline.action, publicAnswerSource: baseline.publicAnswerSource || null, passed: baseline.passed, externalModelCalls: Number(baseline.external_model_calls || 0) },
    learning: { action: learned.action, answer: learned.answer, learning: learned.learning, publicAnswerSource: learned.publicAnswerSource || null, passed: learned.passed, externalModelCalls: Number(learned.external_model_calls || 0) },
    reload: { action: reload.action, answer: reload.answer, publicAnswerSource: reload.publicAnswerSource || null, passed: reload.passed, externalModelCalls: Number(reload.external_model_calls || 0) },
    ablation: { action: ablation.action, answer: ablation.answer, publicAnswerSource: ablation.publicAnswerSource || null, passed: ablation.passed, externalModelCalls: Number(ablation.external_model_calls || 0) },
    protectedBefore,
    protectedAfter,
    gates,
    passed,
    verdict: passed ? 'Autonomous uncertainty research retained and reload-verified; candidate remains unpromoted' : 'Autonomous uncertainty research proof failed; candidate remains unpromoted',
    externalModelCalls: 0,
    limitations: [
      'The source provider in this proof is a local fixture; production web grounding remains subject to source quality and network availability.',
      'The learned result is typed source-backed knowledge, not an executable coding operator or broad language generator.',
      'The candidate is immutable and was not promoted.'
    ]
  };
  writeExclusive(path.join(OUT, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  writeExclusive(path.join(OUT, 'report.md'), [
    '# Autonomous uncertainty research candidate', '',
    `- Verdict: **${evidence.verdict}**`,
    `- Candidate: \`${candidateHash}\``,
    `- Learned record: \`${learnedRecordId}\``, '',
    ...Object.entries(gates).map(([name, value]) => `- ${name}: ${value ? 'PASS' : 'FAIL'}`), '',
    ...evidence.limitations.map(item => `- Limitation: ${item}`), ''
  ].join('\n'));
  console.log(JSON.stringify(evidence, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
