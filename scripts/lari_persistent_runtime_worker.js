#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');
const { planAutoLearnFromResponse, queueAutoLearn } = require('./lari_auto_learn.js');
const { queueCapabilityPractice } = require('./lari_practice_capability.js');
const { capturePersonalHistory } = require('./lari_personal_history.js');
const { projectLearningLifecycle } = require('./lari_learning_lifecycle.js');

function parseArgs(argv = []) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) output[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) output[key] = argv[++index];
    else output[key] = true;
  }
  return output;
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(temporary, 'wx');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
}

function loadBaseModel(modelPath) {
  if (modelPath) {
    const absolute = path.resolve(modelPath);
    const bytes = fs.readFileSync(absolute);
    return { model: JSON.parse(bytes.toString('utf8')), path: absolute, sha256: sha256Bytes(bytes) };
  }
  const loaded = registry.loadLariModel();
  const bytes = fs.readFileSync(loaded.resolved.path);
  return { model: loaded.model, path: loaded.resolved.path, sha256: sha256Bytes(bytes) };
}

function preferenceRecords(model) {
  return (model.lariLearnedRecords?.records || []).filter(record =>
    record?.type === 'preference' && record?.payload?.userScope
  );
}

function applyRuntimeState(model, state, baseModelHash) {
  if (!state) return { applied: false, rebased: false };
  const rebased = state.baseModelHash !== baseModelHash;
  if (state.lariSessionRuntime) model.lariSessionRuntime = state.lariSessionRuntime;
  const retained = (model.lariLearnedRecords?.records || []).filter(record => record?.type !== 'preference');
  model.lariLearnedRecords = model.lariLearnedRecords || { schemaVersion: 1, records: [] };
  model.lariLearnedRecords.records = [...(state.preferenceRecords || []), ...retained];
  return { applied: true, rebased, previousBaseModelHash: rebased ? state.baseModelHash : null };
}

function stateSnapshot(model, base, revision) {
  return {
    schemaVersion: 1,
    kind: 'lari_runtime_user_state',
    baseModelHash: base.sha256,
    baseModelPath: base.path.replace(/\\/g, '/'),
    revision,
    updatedAt: new Date().toISOString(),
    lariSessionRuntime: model.lariSessionRuntime || null,
    preferenceRecords: preferenceRecords(model)
  };
}

function resetRuntimePersonalState(model) {
  const runtimeState = model.lariSessionRuntime || {};
  model.lariSessionRuntime = {
    ...runtimeState,
    turns: [],
    userScopes: {},
    activeUserScope: null,
    userMemory: {
      preferences: [],
      corrections: [],
      currentGoal: null,
      pendingAction: null,
      contextEvents: [],
      longTermFacts: [],
      userScope: 'local.default',
      preferenceRecordIds: []
    },
    growthRuns: [],
    lastGrowthAt: null,
    lastGrowthTurn: 0
  };
  if (model.userModel) {
    model.userModel = {
      ...model.userModel,
      activeUserScope: null,
      preferences: [],
      preferenceRecordIds: [],
      observations: []
    };
  }
}

function completionShape(response, modelName = 'lari') {
  const text = response.output_text || response.answer || '';
  return {
    id: `chatcmpl-lari-runtime-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: String(text).split(/\s+/).filter(Boolean).length,
      total_tokens: String(text).split(/\s+/).filter(Boolean).length
    },
    lari: {
      response_id: response.id || null,
      mode: response.mode || null,
      action: response.action || null,
      passed: response.passed === true,
      model_hash: response.modelHash || null,
      capability_selection: response.capabilitySelection || null,
      learned_record_ids: response.learnedRecordIds || [],
      executed_learned_record_ids: response.executedLearnedRecordIds || [],
      public_source: response.publicAnswerSource || null,
      autonomous_research: response.autonomousResearch || null,
      execution_binding: response.executionBinding || null,
      fallback_reason: response.fallbackReason || null,
      user_scope: response.userScope || 'local.default',
      personalization_applied: response.personalizationApplied || [],
      autonomous_learning: response.autonomousLearning || null,
      autonomous_practice: response.autonomousPractice || null
      ,learning_lifecycle: response.learningLifecycle || null
    },
    external_model_calls: 0
  };
}

function buildStructuredLariRequest(prompt, payload = {}, context = {}) {
  const request = { prompt: String(prompt || '') };
  const sources = [context, payload];
  const stringFields = [
    'id',
    'mode',
    'subintent',
    'workspaceRoot',
    'inputPath',
    'outputDir',
    'testPath',
    'testRunner',
    'expressionTarget',
    'mainClass',
    'selectionStrategy',
    'ffmpegPath',
    'ffprobePath'
  ];
  for (const field of stringFields) {
    const source = sources.find(item => typeof item?.[field] === 'string' && item[field].trim());
    if (source) request[field] = itemValue(source[field]);
  }
  for (const field of ['preserveLayout', 'autoSelect']) {
    const source = sources.find(item => typeof item?.[field] === 'boolean');
    if (source) request[field] = source[field];
  }
  for (const field of ['clipCount', 'clipDuration', 'sceneThreshold']) {
    const source = sources.find(item => Number.isFinite(Number(item?.[field])));
    if (source) request[field] = Number(source[field]);
  }
  for (const field of ['clips', 'segments', 'testSelectors', 'tests', 'publicExamples']) {
    const source = sources.find(item => Array.isArray(item?.[field]));
    if (source) request[field] = source[field];
  }
  for (const field of ['publicSymbol', 'isolatedReproducer']) {
    const source = sources.find(item => item?.[field] && typeof item[field] === 'object' && !Array.isArray(item[field]));
    if (source) request[field] = source[field];
  }
  return request;
}

function itemValue(value) {
  return String(value).trim();
}

const args = parseArgs(process.argv.slice(2));
const explicitModelPath = args.modelPath || process.env.LARI_MODEL_PATH || null;
let base = loadBaseModel(explicitModelPath);
const statePath = path.resolve(args.statePath || process.env.LARI_RUNTIME_STATE_PATH || path.join('models', 'lari', 'runtime', 'user-state.json'));
let model = base.model;
let revision = 0;
let stateLoad = { applied: false, rebased: false, previousBaseModelHash: null };
if (fs.existsSync(statePath)) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // Runtime user state is deliberately separate from model intelligence. On a
  // verified promotion, retain the user's scoped conversation/preferences and
  // rebind them to the new active hash instead of making Workbench unusable.
  stateLoad = applyRuntimeState(model, state, base.sha256);
  revision = Number(state.revision || 0);
} else {
  resetRuntimePersonalState(model);
}
let lastPersistedPreferenceCount = preferenceRecords(model).length;

function reloadActiveModelIfChanged() {
  if (explicitModelPath || !fs.existsSync(registry.currentModelPath)) return null;
  const activeHash = sha256Bytes(fs.readFileSync(registry.currentModelPath));
  if (activeHash === base.sha256) return null;
  const priorHash = base.sha256;
  const retainedState = stateSnapshot(model, base, revision);
  const next = loadBaseModel(null);
  if (next.sha256 !== activeHash) throw new Error('Registry active model changed during persistent-worker reload.');
  model = next.model;
  base = next;
  stateLoad = applyRuntimeState(model, retainedState, base.sha256);
  stateLoad = { ...stateLoad, rebased: true, previousBaseModelHash: priorHash };
  lastPersistedPreferenceCount = preferenceRecords(model).length;
  return { reloaded: true, previousModelHash: priorHash, modelHash: base.sha256 };
}

async function processRequest(payload = {}) {
  const modelReload = reloadActiveModelIfChanged();
  if (payload.operation === 'health') {
    return {
      ok: true,
      modelHash: base.sha256,
      stateRevision: revision,
      stateRebased: stateLoad.rebased === true,
      previousBaseModelHash: stateLoad.previousBaseModelHash || null,
      modelReload,
      userScopeCount: Object.keys(model.lariSessionRuntime?.userScopes || {}).length,
      external_model_calls: 0
    };
  }
  if (payload.operation === 'flush') {
    atomicWriteJson(statePath, stateSnapshot(model, base, revision));
    return { ok: true, modelHash: base.sha256, stateRevision: revision, external_model_calls: 0 };
  }
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : [{ role: 'user', content: String(payload.prompt || payload.input || '') }];
  const prompt = [...messages].reverse().find(message => message?.role === 'user')?.content || '';
  const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
  const userScope = context.userScope || context.user_scope || payload.user || 'local.default';
  const structuredRequest = buildStructuredLariRequest(prompt, payload, context);
  const personalStateBeforeTurn = stateSnapshot(model, base, revision);
  const runtimeOptions = {
    ...context,
    userScope,
    modelHash: base.sha256,
    autoGrow: false,
    operator: false,
    groundedFactual: context.groundedFactual !== false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 },
      ...(context.kernel || {})
    }
  };
  let response = await runtime.sendMessageToLariAsync(model, structuredRequest, runtimeOptions);
  const explicitResearch = /\b(research|learn|study|look\s+up|find\s+out|teach\s+yourself)\b/i.test(String(prompt));
  const needsGroundingFollowup = /^(?:learning_failed_no_evidence|research_failed)$/i.test(String(response.action || ''))
    || (response.contextMemory?.executedPendingAction === true && response.intent === 'research')
    || explicitResearch;
  if (needsGroundingFollowup) {
    response = await runtime.sendMessageToLariAsync(model, structuredRequest, runtimeOptions);
  }
  const learningPlan = planAutoLearnFromResponse(response, prompt, {
    enabled: context.autonomousLearning !== false,
    explicitModelPath: Boolean(explicitModelPath)
  });
  if (learningPlan.status) response.autonomousLearning = learningPlan.status;
  if (learningPlan.practiceStatus) response.autonomousPractice = learningPlan.practiceStatus;
  const personalization = runtime.applyLariPersonalMemory
    ? runtime.applyLariPersonalMemory(model, prompt, response.answer || '', { ...context, userScope })
    : null;
  if (personalization?.output) response.answer = personalization.output;
  response.output_text = response.answer || '';
  response.userScope = userScope;
  response.personalizationApplied = [...new Set((personalization?.applied || [])
    .map(item => item.recordId || item.id)
    .filter(Boolean))];
  revision += 1;
  const currentPreferenceCount = preferenceRecords(model).length;
  const durableSignal = currentPreferenceCount !== lastPersistedPreferenceCount
    || /\b(?:remember|my preferred|my preference|i prefer|call me|from now on)\b/i.test(String(prompt));
  if (durableSignal || revision % 10 === 0) {
    const nextState = stateSnapshot(model, base, revision);
    if (durableSignal) {
      capturePersonalHistory(statePath, userScope, {
        state: personalStateBeforeTurn,
        label: 'Before personal learning',
        event: 'before_learning',
        prompt
      });
    }
    atomicWriteJson(statePath, nextState);
    if (durableSignal) {
      capturePersonalHistory(statePath, userScope, {
        state: nextState,
        label: 'After personal learning',
        event: 'after_learning',
        prompt
      });
    }
    lastPersistedPreferenceCount = currentPreferenceCount;
  }
  if (learningPlan.request && response.autonomousLearning?.queued === true) {
    const queued = queueAutoLearn(learningPlan.request.query, {
      evidence: learningPlan.request.evidence,
      // Low-risk knowledge still passes the complete candidate validation
      // contract before the existing atomic promotion transaction may run.
      promote: true
    });
    response.autonomousLearning = { ...response.autonomousLearning, ...queued };
  }
  if (learningPlan.practice && response.autonomousPractice?.queued === true) {
    const queued = queueCapabilityPractice(learningPlan.practice);
    response.autonomousPractice = { ...response.autonomousPractice, ...queued };
  }
  response.learningLifecycle = projectLearningLifecycle(response);
  return {
    object: 'lari.persistent.runtime.response',
    model: payload.model || 'lari',
    output_text: response.output_text,
    answer: response.answer,
    response,
    chat_completion: completionShape(response, payload.model || 'lari'),
    model_hash: base.sha256,
    state_path: statePath.replace(/\\/g, '/'),
    state_revision: revision,
    model_reload: modelReload,
    user_scope: userScope,
    external_model_calls: 0
  };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
input.on('line', line => {
  if (!line.trim()) return;
  chain = chain.then(async () => {
    let payload;
    try {
      payload = JSON.parse(line);
      const result = await processRequest(payload);
      process.stdout.write(`${JSON.stringify({ request_id: payload.request_id || null, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        request_id: payload?.request_id || null,
        error: error?.stack || String(error),
        external_model_calls: 0
      })}\n`);
    }
  });
});
input.on('close', () => {
  chain.then(() => flushOnExit()).catch(() => {});
});

function flushOnExit() {
  try {
    atomicWriteJson(statePath, stateSnapshot(model, base, revision));
  } catch (_) {}
}

process.on('SIGINT', () => { flushOnExit(); process.exit(0); });
process.on('SIGTERM', () => { flushOnExit(); process.exit(0); });
