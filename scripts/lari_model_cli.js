#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function parseCliOptions(argv = []) {
  const options = {
    userScope: process.env.LARI_USER_SCOPE || process.env.LARI_USER || null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--user') {
      options.userScope = argv[index + 1] || null;
      index += 1;
    } else if (arg.startsWith('--user=')) {
      options.userScope = arg.slice('--user='.length) || null;
    }
  }
  return options;
}

function createDefaultModel() {
  return {
    schemaVersion: 1,
    modelId: 'lari-local-model',
    modelName: 'Lari',
    modelDisplayName: 'Lari',
    generation: 1,
    skills: [],
    knowledge: [],
    compiledSkills: [],
    mutations: []
  };
}

function loadModel(modelPath) {
  if (!modelPath) return registry.loadLariModel().model;
  const resolved = path.resolve(modelPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Explicit Lari model path does not exist: ${resolved}`);
  }
  const text = fs.readFileSync(resolved, 'utf8').trim();
  if (!text) {
    throw new Error(`Explicit Lari model path is empty: ${resolved}`);
  }
  const model = { ...createDefaultModel(), ...JSON.parse(text) };
  registry.assertNoStoredBenchmarkAnswers(model, resolved);
  registry.assertNoUnboundBenchmarkRuntimeSkills(model, resolved);
  return model;
}

function saveModel(modelPath, model) {
  if (!modelPath) return;
  registry.writeLariModel(path.resolve(modelPath), model);
}

function normalizeMessages(request = {}) {
  if (Array.isArray(request.messages)) return request.messages;
  if (typeof request.prompt === 'string') return [{ role: 'user', content: request.prompt }];
  if (typeof request.input === 'string') return [{ role: 'user', content: request.input }];
  return [{ role: 'user', content: String(request || '') }];
}

function buildStructuredLariRequest(prompt, payload = {}, context = {}) {
  const request = { prompt };
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
  const numberFields = ['clipCount', 'clipDuration', 'sceneThreshold'];
  const booleanFields = ['autoSelect', 'preserveLayout'];
  for (const field of stringFields) {
    const source = sources.find(item => typeof item?.[field] === 'string' && item[field].trim());
    if (source) request[field] = source[field].trim();
  }
  for (const field of numberFields) {
    const source = sources.find(item => Number.isFinite(Number(item?.[field])));
    if (source) request[field] = Number(source[field]);
  }
  for (const field of booleanFields) {
    const source = sources.find(item => typeof item?.[field] === 'boolean');
    if (source) request[field] = source[field];
  }
  for (const field of ['clips', 'segments']) {
    const source = sources.find(item => Array.isArray(item?.[field]));
    if (source) request[field] = source[field];
  }
  // These are existing, typed kernel inputs.  Keeping them intact is what lets
  // an issue packet reach the same default failure-learning path on the API
  // and Workbench as it does through direct invocation.  The runtime validates
  // workspace paths, runners, test declarations, and isolated-reproducer
  // descriptors before it executes them.
  for (const field of ['testSelectors', 'tests', 'publicExamples']) {
    const source = sources.find(item => Array.isArray(item?.[field]));
    if (source) request[field] = source[field];
  }
  for (const field of ['publicSymbol', 'isolatedReproducer']) {
    const source = sources.find(item => item?.[field] && typeof item[field] === 'object' && !Array.isArray(item[field]));
    if (source) request[field] = source[field];
  }
  return request;
}

function hasStructuredLariTask(request = {}) {
  const mediaTask = Boolean(request.workspaceRoot && request.inputPath)
    && (Array.isArray(request.clips)
      || Array.isArray(request.segments)
      || request.autoSelect === true
      || request.selectionStrategy === 'scene_change');
  const codingTask = Boolean(request.workspaceRoot && request.testPath);
  return mediaTask || codingTask;
}

function completionShape(response, modelName = 'lari') {
  const artifactDescriptors = (response.artifacts || []).map(artifact => typeof artifact === 'string' ? artifact : {
    type: artifact.type || null,
    modality: artifact.modality || null,
    mime: artifact.mime || null,
    encoding: artifact.encoding || null,
    bytes: Number(artifact.bytes || 0),
    generatorId: artifact.generatorId || null,
    verified: artifact.verified === true
  });
  return {
    id: `chatcmpl-lari-adapter-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: response.output_text || response.answer || '' },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: String(response.output_text || response.answer || '').split(/\s+/).filter(Boolean).length,
      total_tokens: String(response.output_text || response.answer || '').split(/\s+/).filter(Boolean).length
    },
      action: response.action || null,
      artifacts: response.artifacts || [],
      goal_curriculum: response.goalCurriculum || null,
    lari: {
      response_id: response.id,
      mode: response.mode,
      action: response.action,
      passed: response.passed === true,
      proof: response.internal_proof || null,
      model_hash: response.modelHash || null,
      capability_selection: response.capabilitySelection || null,
      learned_record_ids: response.learnedRecordIds || [],
      executed_learned_record_ids: response.executedLearnedRecordIds || [],
      public_source: response.publicAnswerSource || null,
      autonomous_research: response.autonomousResearch || null,
      execution_binding: response.executionBinding || null,
      fallback_reason: response.fallbackReason || null,
      factual_grounding: response.factualGrounding || null,
      user_scope: response.userScope || 'local.default',
      personalization_applied: response.personalizationApplied || [],
      artifacts: artifactDescriptors
    },
    external_model_calls: 0
  };
}

(async () => {
  try {
    const cliOptions = parseCliOptions(process.argv.slice(2));
    const payload = JSON.parse((await readStdin()) || '{}');
    let candidateLearningRequest = null;
    const modelPath = payload.model_path
      || process.env.LARI_MODEL_PATH
      || null;
    const model = loadModel(modelPath);
    const messages = normalizeMessages(payload);
    const payloadContext = payload.context || payload.lari_context || {};
    const userScope = payloadContext.userScope
      || payloadContext.user_scope
      || payloadContext.userId
      || payload.user
      || cliOptions.userScope
      || 'local.default';
    const context = {
      ...payloadContext,
      userScope,
      requiredConcepts: payload.required_concepts || payloadContext.requiredConcepts || [],
      threshold: payload.threshold || payloadContext.threshold,
      minWords: payload.min_words || payloadContext.minWords
    };
    const resolvedModelPath = modelPath
      ? path.resolve(modelPath)
      : registry.resolveLariModelPath().path;
    let modelHash = resolvedModelPath && fs.existsSync(resolvedModelPath) ? sha256File(resolvedModelPath) : null;
    const prompt = messages.slice().reverse().find(message => message.role === 'user')?.content || '';
    const structuredRequest = buildStructuredLariRequest(prompt, payload, context);
    const autonomousSurface = context.surface === 'autonomous' || context.autonomousRequest === true;
    let canonicalCompletion = null;
    // Every interactive public request, structured or not, enters through the
    // async canonical front door.  It is the only path that can perform
    // evidence-backed research and it always reaches
    // sendMessageToLari -> runLariUnifiedTaskKernel before shaping an
    // OpenAI-compatible response.  The old unstructured branch used a second
    // chat-completion stack with its own answer polishing and could therefore
    // diverge from Workbench and CLI behavior.
    let response = await (autonomousSurface ? runtime.runLariAutonomousRequest(model, structuredRequest, {
      ...context, modelHash, mode: context.mode || 'chat', groundedFactual: context.groundedFactual !== false
    }) : runtime.sendMessageToLariAsync(model, structuredRequest, {
      ...context,
      modelHash,
      autoGrow: false,
      operator: false,
      kernel: {
        ...(context.kernel || {}),
        useBenchmarkSystem: false,
        useCapabilityGraph: true,
        capabilityGraph: { ...(context.kernel?.capabilityGraph || {}), minScore: 0 },
        chat: { minMemoryScore: 0, minRouteScore: 0, ...(context.kernel?.chat || {}) }
      }
    }));
    if (!canonicalCompletion) {
      canonicalCompletion = completionShape(response, payload.model || 'lari');
    }
    const needsAsyncGrounding = !autonomousSurface && (
      /^(?:learning_failed_no_evidence|research_failed)$/i.test(String(response.action || ''))
      || (response.contextMemory?.executedPendingAction === true && response.intent === 'research')
      || /\b(research|learn|study|look\s+up|find\s+out|teach\s+yourself)\b/i.test(prompt)
    );
    if (needsAsyncGrounding) {
      response = await runtime.sendMessageToLariAsync(model, structuredRequest, {
        ...context,
        modelHash,
        autoGrow: false,
        operator: false,
        kernel: {
          ...(context.kernel || {}),
          useBenchmarkSystem: false,
          useCapabilityGraph: true,
          capabilityGraph: { ...(context.kernel?.capabilityGraph || {}), minScore: 0 },
          chat: { minMemoryScore: 0, minRouteScore: 0, ...(context.kernel?.chat || {}) }
        }
      });
      canonicalCompletion = completionShape(response, payload.model || 'lari');
    }
    const explicitResearch = /\b(research|learn|study|look\s+up|find\s+out|teach\s+yourself)\b/i.test(prompt);
    const goalResearch = response.goalCurriculum?.safeResearchRequest || null;
    const goalPractice = response.goalCurriculum?.safePracticeRequest || null;
    const inferredLearningPlan = require('./lari_auto_learn.js').planAutoLearnFromResponse(response, prompt, {
      enabled: context.autonomousLearning !== false,
      explicitModelPath: Boolean(modelPath)
    });
    const learningQuery = goalResearch?.query || prompt;
    // An ordinary factual or conceptual question that Lari explicitly cannot
    // answer is a developmental signal.  It should enter the established
    // research -> candidate -> transfer/reload gate, even when the user did
    // not use the word "research".  Keep casual/private conversation and
    // executable work out of this path, and never promote from public traffic.
    const ordinaryResearchableGap = response.intent === 'chat'
      && /^I do not have enough local memory to answer that strongly yet\./i.test(String(response.answer || ''))
      && /^\s*(?:what|why|how|when|where|who|explain|tell me|compare)\b/i.test(prompt)
      && !/\b(?:my preference|remember|personal|private|call me|i prefer)\b/i.test(prompt);
    if (!modelPath && context.autonomousLearning !== false && process.env.LARI_AUTONOMOUS_LEARNING !== '0'
      && (Boolean(goalResearch) || (explicitResearch
        && (response.factualGrounding?.retrieved === true
          || /^I don[’']t have a reliable answer for that yet\./i.test(String(response.answer || ''))))
        || ordinaryResearchableGap)) {
      const { classifyRisk } = require('./lari_auto_learn.js');
      const risk = classifyRisk(learningQuery);
      candidateLearningRequest = risk === 'low' ? {
        query: learningQuery,
        evidence: goalResearch ? [] : (response.factualGrounding?.evidence || []),
        origin: ordinaryResearchableGap ? 'ordinary_chat_capability_gap' : 'explicit_or_goal_research'
      } : null;
      response.autonomousLearning = {
        status: risk === 'low' ? 'candidate_learning_scheduled' : 'quarantined',
        risk,
        queued: risk === 'low',
        promoted: false,
        candidateOnly: risk === 'low',
        origin: candidateLearningRequest?.origin || null,
        promotionScheduled: false
      };
    }
    const candidatePracticeRequest = !modelPath
      && context.autonomousLearning !== false
      && process.env.LARI_AUTONOMOUS_LEARNING !== '0'
      && (goalPractice?.automatic === true || inferredLearningPlan.practice?.automatic === true)
      ? (goalPractice?.automatic === true ? goalPractice : inferredLearningPlan.practice)
      : null;
    if (candidatePracticeRequest) {
      response.autonomousPractice = {
        status: 'verified_practice_scheduled',
        targetId: candidatePracticeRequest.targetId,
        queued: true,
        promoted: false,
        candidateOnly: true
      };
    }
    const personalization = runtime.applyLariPersonalMemory
      ? runtime.applyLariPersonalMemory(model, prompt, response.answer || '', { ...context, userScope })
      : null;
    if (personalization?.output) response.answer = personalization.output;
    response.personalizationApplied = [...new Set((personalization?.applied || [])
      .map(item => item.recordId || item.id)
      .filter(Boolean))];
    response.output_text = response.answer || '';
    response.userScope = userScope;
    if (canonicalCompletion) {
      if (canonicalCompletion.choices?.[0]?.message) {
        canonicalCompletion.choices[0].message.content = response.output_text;
      }
      canonicalCompletion.lari = {
        ...(canonicalCompletion.lari || {}),
        user_scope: userScope,
        personalization_applied: response.personalizationApplied
      };
    }
    if (payload.save_model === true && modelPath) saveModel(modelPath, model);
    const result = {
      object: 'lari.adapter.response',
      model: payload.model || 'lari',
      output_text: response.output_text || response.answer || '',
      answer: response.answer || response.output_text || '',
      response,
      chat_completion: canonicalCompletion || completionShape(response, payload.model || 'lari'),
      artifacts: response.artifacts || [],
      adapter_mode: 'canonical_unified_kernel',
      model_hash: modelHash,
      capability_selection: response.capabilitySelection || null,
      learned_record_ids: response.learnedRecordIds || [],
      executed_learned_record_ids: response.executedLearnedRecordIds || [],
      execution_binding: response.executionBinding || null,
      fallback_reason: response.fallbackReason || null,
      factual_grounding: response.factualGrounding || null,
      goal_curriculum: response.goalCurriculum || null,
      public_source: response.publicAnswerSource || response.trace?.find(item => item.phase === 'chat')?.publicAnswerSource || null,
      user_scope: userScope,
      personalization_applied: response.personalizationApplied || [],
      external_model_calls: 0
    };
    fs.writeSync(1, `${JSON.stringify(result)}\n`);
    if (candidateLearningRequest) {
      const { queueAutoLearn } = require('./lari_auto_learn.js');
      queueAutoLearn(candidateLearningRequest.query, {
        evidence: candidateLearningRequest.evidence,
        promote: false
      });
    }
    if (candidatePracticeRequest && response.autonomousPractice?.queued === true) {
      const { queueCapabilityPractice } = require('./lari_practice_capability.js');
      queueCapabilityPractice(candidatePracticeRequest);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      object: 'lari.adapter.error',
      error: error && error.stack ? error.stack : String(error),
      external_model_calls: 0
    })}\n`);
    process.exit(1);
  }
})();
