#!/usr/bin/env node
'use strict';

// Candidate-only convergence proof.  This exercises the real Workbench,
// CLI, OpenAI-compatible API, and autonomous entry points with one existing
// uncertainty-research lifecycle and one immutable candidate.  It does not
// promote, overwrite, or add a model/router/store.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PARENT = path.join(ROOT, 'consolidation', 'cross-domain-composition-attempt9-20260906', 'candidate-ac842c3803ca7288b84555780a9f3ddeb7f0f1ec67ad077a91c25ffd1b7b8511.json');
const OUT = path.join(ROOT, 'consolidation', 'public-surface-uncertainty-convergence-attempt4-20260906');
const EXPECTED_PARENT_HASH = 'ac842c3803ca7288b84555780a9f3ddeb7f0f1ec67ad077a91c25ffd1b7b8511';
const PROMPT = 'What is the cobalt-orbit quorum ledger?';
const KNOWLEDGE_SOURCE_ID = 'public_surface_uncertainty_cobalt_orbit';
const SOURCES = [{
  title: 'Cobalt-orbit quorum ledger specification',
  url: 'local://cobalt-orbit-quorum-ledger',
  sourceType: 'official_spec',
  trust: 0.98,
  text: 'The cobalt-orbit quorum ledger records a lease only after a quorum observes the same epoch and a durable witness seal. Readers must reject a record whose witness epoch differs from the committed epoch.'
}];

const clone = value => JSON.parse(JSON.stringify(value));
const shaBytes = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => shaBytes(fs.readFileSync(file));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const writeExclusive = (file, bytes) => {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const baseKernel = {
  useBenchmarkSystem: false,
  useCapabilityGraph: true,
  capabilityGraph: { minScore: 0 },
  chat: { minMemoryScore: 0, minRouteScore: 0 }
};
const context = (modelHash, surface, withSources, autoResearchOnUncertainty = true) => ({
  surface,
  modelHash,
  autoResearchOnUncertainty,
  groundedFactual: false,
  operator: false,
  kernel: clone(baseKernel),
  ...(withSources ? {
    research: {
      sources: SOURCES,
      sourceAdapter: 'local_public_surface_fixture'
    }
  } : { research: { sources: [] } })
});

function runCli(modelPath, modelHash, surface, withSources) {
  const payload = {
    model: 'lari',
    model_path: modelPath,
    prompt: PROMPT,
    context: {
      ...context(modelHash, surface, withSources),
      includeDiagnostics: true
    }
  };
  const result = spawnSync(process.execPath, ['scripts/lari_model_cli.js'], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, LARI_DISABLE_MODEL_FALLBACKS: '1' }
  });
  if (result.status !== 0) throw new Error(`CLI failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

async function waitFor(url, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before ${url}`);
    try {
      const response = await fetch(url);
      // Consume the health response before the short-lived server is closed;
      // otherwise undici can observe an interrupted keep-alive socket while
      // the next surface is starting.
      await response.arrayBuffer();
      if (response.ok) return;
    } catch (_) { /* keep polling */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new Error(`${url} returned non-JSON: ${text}`); }
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function runApi(modelPath, modelHash, withSources, port) {
  const child = spawn('python', ['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', String(port), '--model-path', modelPath, '--stateless'], {
    cwd: ROOT,
    env: { ...process.env, LARI_DISABLE_MODEL_FALLBACKS: '1', LARI_ALLOW_LEGACY_ROOT_MODEL: '0' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/health`, child);
    return await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
      model: 'lari',
      messages: [{ role: 'user', content: PROMPT }],
      include_diagnostics: true,
      lari_context: context(modelHash, 'openai_compatible_api', withSources)
    });
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 250));
  }
}

async function runWorkbench(modelPath, modelHash, withSources, port, statePath) {
  const child = spawn('python', ['start_workspace.py'], {
    cwd: ROOT,
    env: {
      ...process.env,
      LARI_MODEL_PATH: modelPath,
      LARI_RUNTIME_STATE_PATH: statePath,
      LARI_WORKSPACE_PORT: String(port),
      LARI_NO_BROWSER: '1',
      LARI_DISABLE_MODEL_FALLBACKS: '1',
      LARI_ALLOW_LEGACY_ROOT_MODEL: '0'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/api/lari/history`, child);
    return await postJson(`http://127.0.0.1:${port}/api/lari/chat`, {
      prompt: PROMPT,
      includeDiagnostics: true,
      lari_context: context(modelHash, 'workbench', withSources)
    });
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function publicView(raw) {
  const completion = raw?.chat_completion || raw?.chatCompletion || raw;
  const lari = raw?.lari || completion?.lari || raw?.response?.chat_completion?.lari || {};
  const response = raw?.response || raw?.response?.response || raw;
  const selection = response?.capabilitySelection || raw?.capability_selection || lari.capability_selection || null;
  const learned = response?.learnedRecordIds || raw?.learned_record_ids || lari.learned_record_ids || [];
  const research = response?.autonomousResearch || raw?.autonomous_research || lari.autonomous_research
    || (raw?.learning?.action ? raw.learning : null);
  const answer = response?.answer || raw?.answer || completion?.choices?.[0]?.message?.content || '';
  return {
    modelHash: response?.modelHash || raw?.model_hash || lari.model_hash || null,
    capabilitySelection: selection ? {
      capabilityId: selection.capabilityId || selection.capability_id || null,
      sourceSkillId: selection.sourceSkillId || selection.source_skill_id || null,
      learnedRecordId: selection.learnedRecordId || selection.learned_record_id || null,
      modelHash: selection.modelHash || selection.model_hash || null
    } : null,
    learnedRecordIds: [...new Set(learned)].sort(),
    action: response?.action || raw?.action || lari.action || null,
    publicAnswerSource: response?.publicAnswerSource || raw?.public_source || lari.public_source || null,
    answer,
    passed: response?.passed !== undefined
      ? response.passed === true
      : (raw?.passed !== undefined ? raw.passed === true : (lari.passed !== undefined ? lari.passed === true : null)),
    research: research ? {
      action: research.action || null,
      learnedRecordId: research.learned?.lariTypedRecordId || research.learned?.sourceLearnedRecordId || research.learned?.id || null,
      sourceCount: research.sourceCount || 0
    } : null,
    externalModelCalls: Number(response?.external_model_calls ?? raw?.external_model_calls ?? 0)
  };
}

function parityView(view) {
  return {
    modelHash: view.modelHash,
    capabilitySelection: view.capabilitySelection,
    learnedRecordIds: view.learnedRecordIds,
    action: view.action,
    publicAnswerSource: view.publicAnswerSource,
    answer: view.answer,
    passed: view.passed
  };
}

async function main() {
  if (fs.existsSync(OUT)) throw new Error(`Refusing to overwrite immutable output: ${rel(OUT)}`);
  if (!fs.existsSync(PARENT)) throw new Error(`Missing immutable Stage 2 candidate: ${rel(PARENT)}`);
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), parent: shaFile(PARENT) };
  if (protectedBefore.parent !== EXPECTED_PARENT_HASH) throw new Error(`Unexpected parent hash ${protectedBefore.parent}`);
  const parent = JSON.parse(fs.readFileSync(PARENT, 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });

  const canonicalTrainingModel = clone(parent);
  const canonicalTraining = await runtime.sendMessageToLariAsync(
    canonicalTrainingModel,
    PROMPT,
    context(EXPECTED_PARENT_HASH, 'canonical', true)
  );
  const canonicalResearch = canonicalTraining.autonomousResearch || null;
  const typedRecord = (canonicalTrainingModel.lariLearnedRecords?.records || []).find(record =>
    record?.type === 'knowledge'
    && record?.payload?.topic
    && /cobalt-orbit quorum ledger/i.test(String(record.payload.topic))
  );
  if (!canonicalResearch || canonicalResearch.action !== 'learned_from_sources' || !typedRecord) {
    throw new Error(`Canonical public uncertainty learning did not retain a typed record: ${JSON.stringify(publicView(canonicalTraining))}`);
  }
  canonicalTrainingModel.lineage = {
    ...(canonicalTrainingModel.lineage || {}),
    parentHash: EXPECTED_PARENT_HASH,
    developmentalEvent: 'public_surface_uncertainty_research_convergence_candidate',
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    typedRecordId: typedRecord.id,
    publicSurfaces: ['workbench', 'cli', 'openai_compatible_api', 'autonomous'],
    promoted: false,
    createdAt: new Date().toISOString()
  };
  const candidateBytes = Buffer.from(`${JSON.stringify(canonicalTrainingModel, null, 2)}\n`);
  const candidateHash = shaBytes(candidateBytes);
  const candidatePath = path.join(OUT, `candidate-${candidateHash}.json`);
  writeExclusive(candidatePath, candidateBytes);

  const training = {
    canonical: publicView(canonicalTraining),
    cli: publicView(runCli(PARENT, EXPECTED_PARENT_HASH, 'cli', true)),
    openai_compatible_api: publicView(await runApi(PARENT, EXPECTED_PARENT_HASH, true, 8931 + (process.pid % 20))),
    workbench: publicView(await runWorkbench(PARENT, EXPECTED_PARENT_HASH, true, 8951 + (process.pid % 20), path.join(OUT, 'workbench-state.json'))),
    autonomous: publicView(await runtime.runLariAutonomousRequest(clone(parent), { mode: 'chat', prompt: PROMPT }, {
      ...context(EXPECTED_PARENT_HASH, 'autonomous', true),
      mode: 'chat'
    }))
  };
  const trainingRows = Object.values(training);
  const trainingRecordIds = trainingRows.map(row => row.research?.learnedRecordId || null);
  const trainingGates = {
    canonicalLearned: training.canonical.research?.action === 'learned_from_sources',
    allSurfacesLearned: trainingRows.every(row => row.research?.action === 'learned_from_sources'),
    sameTypedResearchRecord: trainingRecordIds.every(id => id && id === trainingRecordIds[0]),
    sameParentHash: trainingRows.every(row => row.modelHash === EXPECTED_PARENT_HASH),
    externalModelCallsZero: trainingRows.every(row => row.externalModelCalls === 0)
  };

  const reloadedCandidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const parity = {
    canonical: publicView(await runtime.sendMessageToLariAsync(clone(reloadedCandidate), PROMPT, context(candidateHash, 'canonical', false, false))),
    cli: publicView(runCli(candidatePath, candidateHash, 'cli', false)),
    openai_compatible_api: publicView(await runApi(candidatePath, candidateHash, false, 8971 + (process.pid % 20))),
    workbench: publicView(await runWorkbench(candidatePath, candidateHash, false, 8991 + (process.pid % 20), path.join(OUT, 'workbench-reload-state.json'))),
    autonomous: publicView(await runtime.runLariAutonomousRequest(clone(reloadedCandidate), { mode: 'chat', prompt: PROMPT }, {
      ...context(candidateHash, 'autonomous', false, false),
      mode: 'chat'
    }))
  };
  const parityValues = Object.values(parity).map(parityView).map(value => JSON.stringify(value));
  const selectedIds = Object.values(parity).map(row => row.capabilitySelection?.learnedRecordId || null);

  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const reloadResponse = await runtime.sendMessageToLariAsync(reloaded, PROMPT, context(candidateHash, 'reload', false, false));
  const ablated = clone(reloadedCandidate);
  ablated.lariLearnedRecords.records = (ablated.lariLearnedRecords.records || []).filter(record => record.id !== typedRecord.id);
  // Rebuild the existing derived projections after removing the canonical
  // record. This keeps the ablation exact without deleting unrelated state.
  runtime.refreshLariKnowledgeProjections(ablated, { pruneUnboundCompiledSkills: true });
  const ablationResponse = await runtime.sendMessageToLariAsync(ablated, PROMPT, context(candidateHash, 'ablation', false, false));
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), parent: shaFile(PARENT), candidate: shaFile(candidatePath) };
  const gates = {
    ...trainingGates,
    candidateHashExact: protectedAfter.candidate === candidateHash,
    sameHashParity: parityValues.every(value => value === parityValues[0]),
    sameLearnedCapability: selectedIds.every(id => id && id === selectedIds[0]),
    retainedAnswer: Object.values(parity).every(row => row.passed === true && /cobalt-orbit|quorum|witness|epoch/i.test(row.answer)),
    reloadRetention: publicView(reloadResponse).passed === true && /cobalt-orbit|quorum|witness|epoch/i.test(publicView(reloadResponse).answer),
    exactRecordAblation: publicView(ablationResponse).passed !== true || !/cobalt-orbit|quorum|witness|epoch/i.test(publicView(ablationResponse).answer),
    activeAndRegistryReadOnly: protectedBefore.active === protectedAfter.active && protectedBefore.registry === protectedAfter.registry && protectedBefore.parent === protectedAfter.parent,
    noExternalModelCalls: Object.values(parity).every(row => row.externalModelCalls === 0) && Number(reloadResponse.external_model_calls || 0) === 0 && Number(ablationResponse.external_model_calls || 0) === 0,
    noPromotion: reloadedCandidate.lineage?.promoted === false
  };
  const passed = Object.values(gates).every(Boolean);
  const evidence = {
    schemaVersion: 1,
    kind: 'lari.public-surface-uncertainty-research-convergence.candidate',
    createdAt: new Date().toISOString(),
    parent: { path: rel(PARENT), sha256: EXPECTED_PARENT_HASH },
    candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false },
    prompt: PROMPT,
    typedRecordId: typedRecord.id,
    training,
    trainingGates,
    parity,
    reload: publicView(reloadResponse),
    ablation: publicView(ablationResponse),
    protectedBefore,
    protectedAfter,
    gates,
    passed,
    verdict: passed ? 'Public surfaces converge on one uncertainty-research lifecycle and one retained capability; candidate remains unpromoted.' : 'Public surface convergence proof failed; candidate remains unpromoted.',
    externalModelCalls: 0,
    limitations: [
      'The research source in this proof is a local fixture; production web retrieval still depends on source quality and network availability.',
      'Workbench and OpenAI API servers were exercised locally with the same immutable candidate path and diagnostics enabled.',
      'No production registry or active model file was modified and no candidate was promoted.'
    ]
  };
  writeExclusive(path.join(OUT, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  writeExclusive(path.join(OUT, 'report.md'), [
    '# Public-surface uncertainty-research convergence', '',
    `- Verdict: **${evidence.verdict}**`,
    `- Candidate: \`${candidateHash}\``,
    `- Typed record: \`${typedRecord.id}\``, '',
    ...Object.entries(gates).map(([name, value]) => `- ${name}: ${value ? 'PASS' : 'FAIL'}`), '',
    ...evidence.limitations.map(item => `- Limitation: ${item}`), ''
  ].join('\n'));
  fs.chmodSync(candidatePath, 0o444);
  console.log(JSON.stringify(evidence, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
