#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    debug: false,
    save: false,
    modelPath: process.env.LARI_MODEL_PATH || null,
    userScope: process.env.LARI_USER_SCOPE || process.env.LARI_USER || 'local.default',
    workspaceRoot: null,
    inputPath: null,
    outputDir: null,
    testPath: null,
    testRunner: null,
    testSelectors: [],
    expressionTarget: null,
    preserveLayout: true,
    autoSelect: false,
    selectionStrategy: null,
    clipCount: null,
    clipDuration: null,
    sceneThreshold: null,
    prompt: ''
  };
  const promptParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--debug') options.debug = true;
    else if (arg === '--save') options.save = true;
    else if (arg === '--no-save') options.save = false;
    else if (arg === '--model-path') {
      options.modelPath = args[index + 1] || null;
      index += 1;
    } else if (arg === '--user') {
      options.userScope = args[index + 1] || 'local.default';
      index += 1;
    } else if (arg.startsWith('--user=')) {
      options.userScope = arg.slice('--user='.length) || 'local.default';
    } else if (arg === '--workspace-root') {
      options.workspaceRoot = args[index + 1] || null;
      index += 1;
    } else if (arg === '--input') {
      options.inputPath = args[index + 1] || null;
      index += 1;
    } else if (arg === '--output-dir') {
      options.outputDir = args[index + 1] || null;
      index += 1;
    } else if (arg === '--test-path') {
      options.testPath = args[index + 1] || null;
      index += 1;
    } else if (arg === '--test-runner') {
      options.testRunner = args[index + 1] || null;
      index += 1;
    } else if (arg === '--test-selector') {
      const selector = args[index + 1] || '';
      if (selector) options.testSelectors.push(selector);
      index += 1;
    } else if (arg === '--expression-target') {
      options.expressionTarget = args[index + 1] || null;
      index += 1;
    } else if (arg === '--no-preserve-layout') {
      options.preserveLayout = false;
    } else if (arg === '--auto-select') {
      options.autoSelect = true;
    } else if (arg === '--selection-strategy') {
      options.selectionStrategy = args[index + 1] || null;
      index += 1;
    } else if (arg === '--clip-count') {
      options.clipCount = Number(args[index + 1]);
      index += 1;
    } else if (arg === '--clip-duration') {
      options.clipDuration = Number(args[index + 1]);
      index += 1;
    } else if (arg === '--scene-threshold') {
      options.sceneThreshold = Number(args[index + 1]);
      index += 1;
    } else {
      promptParts.push(arg);
    }
  }
  options.prompt = promptParts.join(' ').trim();
  return options;
}

function readStdinIfNeeded(existingPrompt) {
  if (existingPrompt) return Promise.resolve(existingPrompt);
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
    if (process.stdin.isTTY) resolve('');
  });
}

function cleanAnswer(text) {
  return String(text || '')
    .replace(/^Lari:\s*/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isConcreteAnswer(text) {
  const answer = String(text || '').trim();
  return /^function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(answer)
    || /####\s*-?\d/.test(answer);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prompt = await readStdinIfNeeded(options.prompt);
  if (!prompt) {
    process.stderr.write('Usage: npm run lari:ask -- "Ask Lari something" [-- --user USER_ID] [--debug] [--save]\n');
    process.exit(2);
  }

  const modelPath = options.modelPath || null;
  const loaded = registry.loadLariModel({ modelPath });
  const modelHash = loaded.resolved?.path ? sha256File(loaded.resolved.path) : null;
  const request = {
    prompt,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.inputPath ? { inputPath: options.inputPath } : {}),
    ...(options.outputDir ? { outputDir: options.outputDir } : {}),
    ...(options.testPath ? { testPath: options.testPath } : {}),
    ...(options.testRunner ? { testRunner: options.testRunner } : {}),
    ...(options.testSelectors.length ? { testSelectors: options.testSelectors } : {}),
    ...(options.expressionTarget ? { expressionTarget: options.expressionTarget } : {}),
    ...(options.testPath ? {
      mode: 'code',
      subintent: 'code.fix',
      preserveLayout: options.preserveLayout !== false
    } : {}),
    ...(options.autoSelect ? { autoSelect: true } : {}),
    ...(options.selectionStrategy ? { selectionStrategy: options.selectionStrategy } : {}),
    ...(Number.isFinite(options.clipCount) ? { clipCount: options.clipCount } : {}),
    ...(Number.isFinite(options.clipDuration) ? { clipDuration: options.clipDuration } : {}),
    ...(Number.isFinite(options.sceneThreshold) ? { sceneThreshold: options.sceneThreshold } : {})
  };
  let response = await runtime.sendMessageToLariAsync(loaded.model, request, {
    userScope: options.userScope,
    modelHash,
    autoGrow: false,
    operator: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 }
    }
  });
  const explicitResearch = /\b(research|learn|study|look\s+up|find\s+out|teach\s+yourself)\b/i.test(prompt);
  const goalResearch = response.goalCurriculum?.safeResearchRequest || null;
  const goalPractice = response.goalCurriculum?.safePracticeRequest || null;
  const inferredLearningPlan = require('./lari_auto_learn.js').planAutoLearnFromResponse(response, prompt, {
    enabled: true,
    explicitModelPath: Boolean(modelPath)
  });
  const learningQuery = goalResearch?.query || prompt;
  // A low-risk conceptual question that reaches Lari's explicit local-knowledge
  // boundary is a real learning signal.  Queue the existing isolated candidate
  // lifecycle without requiring the user to phrase it as a research command;
  // personal conversation and executable work remain outside this path.
  const ordinaryResearchableGap = response.intent === 'chat'
    && /^I do not have enough local memory to answer that strongly yet\./i.test(String(response.answer || ''))
    && /^\s*(?:what|why|how|when|where|who|explain|tell me|compare)\b/i.test(prompt)
    && !/\b(?:my preference|remember|personal|private|call me|i prefer)\b/i.test(prompt);
  const queueCandidateLearning = !modelPath && process.env.LARI_AUTONOMOUS_LEARNING !== '0'
    && (Boolean(goalResearch) || (explicitResearch
      && (response.factualGrounding?.retrieved === true
        || /^I don[’']t have a reliable answer for that yet\./i.test(String(response.answer || ''))))
      || ordinaryResearchableGap);
  const candidateLearningRequest = queueCandidateLearning ? {
    query: learningQuery,
    evidence: goalResearch ? [] : (response.factualGrounding?.evidence || []),
    origin: ordinaryResearchableGap ? 'ordinary_chat_capability_gap' : 'explicit_or_goal_research'
  } : null;
  const candidatePracticeRequest = !modelPath
    && process.env.LARI_AUTONOMOUS_LEARNING !== '0'
    && (goalPractice?.automatic === true || inferredLearningPlan.practice?.automatic === true)
    ? (goalPractice?.automatic === true ? goalPractice : inferredLearningPlan.practice)
    : null;

  const personalization = runtime.applyLariPersonalMemory
    ? runtime.applyLariPersonalMemory(loaded.model, prompt, response.answer || '', {
      userScope: options.userScope
    })
    : null;
  if (personalization?.output) response.answer = personalization.output;
  response.personalizationApplied = [...new Set((personalization?.applied || [])
    .map(item => item.recordId || item.id)
    .filter(Boolean))];

  const rawAnswer = cleanAnswer(response.answer || '');
  const preserveSelectedArtifactOutput = response.action === 'execute_selected_learned_capability'
    && response.executionBinding?.verified === true
    && Array.isArray(response.artifacts)
    && response.artifacts.length > 0;
  const preserveVerifiedOutput = preserveSelectedArtifactOutput
    || response.publicAnswerSource === 'recap_executable_language'
    || response.publicAnswerSource === 'learned_chat_procedure'
    || response.publicAnswerSource === 'canonical_learned_record_execution'
    || /^(?:goal_capability_audit|goal_capability_practice_queued|grounded_(?:research|factual)_answer|generate_local_(?:image|audio)_artifact|image_request_outside_executable_scope|audio_request_outside_executable_scope|video_generation_unavailable)$/.test(String(response.action || ''));
  const polishedAnswer = preserveVerifiedOutput
    ? rawAnswer
    : response.personalizationApplied.length
    ? rawAnswer
    : isConcreteAnswer(rawAnswer)
    ? rawAnswer
    : runtime.improveLariVisibleAnswerQuality
    ? runtime.improveLariVisibleAnswerQuality(prompt, rawAnswer)
    : runtime.repairLariVisibleAnswer
      ? runtime.repairLariVisibleAnswer(prompt, rawAnswer)
    : rawAnswer;
  const answer = polishedAnswer;
  fs.writeSync(1, `${answer}\n`);

  if (candidateLearningRequest) {
    const { classifyRisk } = require('./lari_auto_learn.js');
    const risk = classifyRisk(candidateLearningRequest.query);
    response.autonomousLearning = {
      status: risk === 'low' ? 'candidate_learning_scheduled' : 'quarantined',
      risk,
      queued: risk === 'low',
      promoted: false,
      candidateOnly: false,
      origin: candidateLearningRequest?.origin || null,
      promotionScheduled: risk === 'low' && process.env.LARI_AUTONOMOUS_PROMOTION !== '0'
    };
  }
  if (candidatePracticeRequest) {
    response.autonomousPractice = {
      status: 'verified_practice_scheduled',
      targetId: candidatePracticeRequest.targetId,
      queued: true,
      promoted: false,
      candidateOnly: true
    };
  }
  response.learningLifecycle = require('./lari_learning_lifecycle.js').projectLearningLifecycle(response);

  if (options.debug) {
    fs.writeSync(1, `\n---\n${JSON.stringify({
      mode: response.mode || null,
      action: response.action || null,
      passed: response.passed,
      modelPath: loaded.resolved.relativePath || loaded.resolved.id,
      capabilitySelection: response.capabilitySelection || null,
      learnedRecordIds: response.learnedRecordIds || [],
      modelHash: response.modelHash || modelHash,
      publicAnswerSource: response.publicAnswerSource || null,
      executionBinding: response.executionBinding || null,
      fallbackReason: response.fallbackReason || null,
      artifacts: (response.artifacts || []).map(artifact => typeof artifact === 'string' ? artifact : {
        type: artifact.type || null,
        modality: artifact.modality || null,
        mime: artifact.mime || null,
        encoding: artifact.encoding || null,
        bytes: Number(artifact.bytes || 0),
        generatorId: artifact.generatorId || null,
        verified: artifact.verified === true
      }),
      factualGrounding: response.factualGrounding || null,
      goalCurriculum: response.goalCurriculum || null,
      userScope: options.userScope,
      personalizationApplied: response.personalizationApplied || [],
      nativeRendered: response.nativeRendered || null,
      autonomousLearning: response.autonomousLearning || null,
      autonomousPractice: response.autonomousPractice || null,
      learningLifecycle: response.learningLifecycle || null,
      runtimeLineage: ['npm run lari:ask', 'sendMessageToLariAsync', 'sendMessageToLari', 'runLariUnifiedTaskKernel'],
      saved: options.save,
      externalModelCalls: 0
    }, null, 2)}\n`);
  }

  if (options.save && loaded.resolved?.path) {
    registry.writeLariModel(loaded.resolved.path, loaded.model);
  }
  if (candidateLearningRequest && response.autonomousLearning?.queued === true) {
    const { queueAutoLearn } = require('./lari_auto_learn.js');
    queueAutoLearn(candidateLearningRequest.query, {
      evidence: candidateLearningRequest.evidence,
      promote: true
    });
  }
  if (candidatePracticeRequest && response.autonomousPractice?.queued === true) {
    const { queueCapabilityPractice } = require('./lari_practice_capability.js');
    const queued = queueCapabilityPractice(candidatePracticeRequest);
    response.autonomousPractice = { ...response.autonomousPractice, ...queued };
  }
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
