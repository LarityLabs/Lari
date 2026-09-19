#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('./lari_model_registry');
const runtime = require('../swarm_model_runtime');

const root = path.resolve(__dirname, '..');
const latestLearning = path.join(root, 'benchmarks', 'latest-lari-failure-driven-learning-report.json');
const validationPath = path.join(root, 'benchmarks', 'latest-lari-learning-candidate-validation.json');
const outputPath = path.join(root, 'benchmarks', 'latest-lari-autonomous-learning-report.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function classifyRisk(query = '') {
  const text = query.toLowerCase();
  if (/\b(dose|dosage|medication|diagnos|treatment|legal advice|lawsuit|contract law|invest|stock|tax|credit|payment|billing|checkout|transaction|password|credential|authentication|authorization|identity security|exploit|malware|ransomware|phishing|backdoor|bypass|exfiltrat|evade detection|weapon|suicide|self-harm|delete files|permissions?|security policy|private data)\b/.test(text)) return 'high';
  if (/\b(run|execute|install|publish|send|purchase|spend|deploy|modify|write files)\b/.test(text)) return 'elevated';
  return 'low';
}

function runNode(script, args = [], env = {}) {
  const result = childProcess.spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, ...env },
    maxBuffer: 128 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.renameSync(temporary, file);
  } catch (error) {
    if (['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      fs.renameSync(temporary, file);
    } else {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      throw error;
    }
  }
}

function normalizedEvidence(options = {}) {
  let evidence = options.evidence || options.sources || [];
  if ((!Array.isArray(evidence) || !evidence.length) && process.env.LARI_LEARNING_EVIDENCE_JSON) {
    try { evidence = JSON.parse(process.env.LARI_LEARNING_EVIDENCE_JSON); } catch (_) { evidence = []; }
  }
  if (!Array.isArray(evidence)) return [];
  return evidence
    .map(item => ({
      title: item.title || null,
      url: item.url || null,
      sourceType: item.sourceType || null,
      text: item.text || item.summary || null,
      trust: item.trust ?? item.confidence ?? null,
      updatedAt: item.updatedAt || item.observedAt || null
    }))
    .filter(item => item.url && item.text)
    .slice(0, 5);
}

function planAutoLearnFromResponse(response = {}, prompt = '', options = {}) {
  const text = String(prompt || '').trim();
  const enabled = options.enabled !== false
    && process.env.LARI_AUTONOMOUS_LEARNING !== '0'
    && !options.explicitModelPath;
  if (!enabled || !text) return { request: null, status: null, practice: null, practiceStatus: null };
  const symbolicMathGap = response.action === 'arithmetic_reasoning_failed'
    || response.publicAnswerSource === 'native_math_reasoning_gap';
  const practice = symbolicMathGap ? {
    targetId: 'symbolic_math_reasoning',
    practiceKind: 'sealed_symbolic_math',
    automatic: true,
    goal: 'qualify the sealed symbolic-math capability gap',
    triggerHash: crypto.createHash('sha256').update(text).digest('hex'),
    origin: 'ordinary_execution_failure'
  } : null;
  const practiceStatus = practice ? {
    status: 'verified_practice_scheduled',
    targetId: practice.targetId,
    queued: true,
    promoted: false,
    candidateOnly: true,
    origin: practice.origin
  } : null;
  const explicitResearch = /\b(research|learn|study|look\s+up|find\s+out|teach\s+yourself)\b/i.test(text);
  const goalResearch = response.goalCurriculum?.safeResearchRequest || null;
  const ordinaryResearchableGap = response.intent === 'chat'
    && /^I do not have enough local memory to answer that strongly yet\./i.test(String(response.answer || ''))
    && /^\s*(?:what|why|how|when|where|who|explain|tell me|compare)\b/i.test(text)
    && !/\b(?:my preference|remember|personal|private|call me|i prefer)\b/i.test(text);
  const eligible = Boolean(goalResearch)
    || (explicitResearch && (response.factualGrounding?.retrieved === true
      || /^I don[’']t have a reliable answer for that yet\./i.test(String(response.answer || ''))))
    || ordinaryResearchableGap;
  if (!eligible) return { request: null, status: null, practice, practiceStatus };
  const query = String(goalResearch?.query || text).trim();
  const risk = classifyRisk(query);
  const request = risk === 'low' ? {
    query,
    evidence: goalResearch ? [] : normalizedEvidence({ evidence: response.factualGrounding?.evidence || [] }),
    origin: ordinaryResearchableGap ? 'ordinary_chat_capability_gap' : 'explicit_or_goal_research'
  } : null;
  return {
    request,
    status: {
      status: risk === 'low' ? 'candidate_learning_scheduled' : 'quarantined',
      risk,
      queued: risk === 'low',
      promoted: false,
      candidateOnly: risk === 'low',
      origin: request?.origin || null,
      promotionScheduled: false
    },
    practice,
    practiceStatus
  };
}

function queueAutoLearn(query, options = {}) {
  const risk = classifyRisk(query);
  if (risk !== 'low') {
    return { status: 'quarantined', risk, queued: false, promoted: false };
  }
  const evidence = normalizedEvidence(options);
  const env = { ...process.env };
  [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'MISTRAL_API_KEY',
    'COHERE_API_KEY',
    'GROQ_API_KEY',
    'TOGETHER_API_KEY',
    'OPENROUTER_API_KEY',
    'XAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'PERPLEXITY_API_KEY',
    'REPLICATE_API_TOKEN',
    'HF_TOKEN',
    'HUGGINGFACEHUB_API_TOKEN'
  ].forEach(name => { delete env[name]; });
  env.LARI_EXTERNAL_MODEL_CALLS = '0';
  if (evidence.length) env.LARI_LEARNING_EVIDENCE_JSON = JSON.stringify(evidence);
  const promote = options.promote !== false && process.env.LARI_AUTONOMOUS_PROMOTION !== '0';
  const child = childProcess.spawn(process.execPath, [__filename, ...(promote ? [] : ['--candidate-only']), query], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env
  });
  child.unref();
  return {
    status: 'candidate_learning_queued',
    risk,
    queued: Boolean(child.pid),
    pid: child.pid || null,
    promoted: false,
    promotionScheduled: promote,
    evidenceCount: evidence.length
  };
}

async function autoLearnUnlocked(query, options = {}) {
  const risk = classifyRisk(query);
  const before = {
    active: sha(registry.currentModelPath),
    registry: sha(registry.registryPath)
  };
  if (risk !== 'low') {
    const report = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      query,
      risk,
      status: 'quarantined',
      reason: 'automatic promotion is limited to low-risk knowledge learning',
      before,
      after: before,
      promoted: false,
      passed: true
    };
    atomic(outputPath, report);
    return report;
  }

  const evidence = normalizedEvidence(options);
  const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-auto-learn-'));
  const runLearningPath = path.join(reportDirectory, 'learning.json');
  const runValidationPath = path.join(reportDirectory, 'validation.json');
  const runReportEnv = {
    LARI_LEARNING_REPORT_PATH: runLearningPath,
    LARI_VALIDATION_REPORT_PATH: runValidationPath
  };
  const cleanupRunReports = () => {
    try { fs.rmSync(reportDirectory, { recursive: true, force: true }); } catch (_) {}
  };
  try {
    runNode('scripts/lari_learn.js', [query], evidence.length
      ? { ...runReportEnv, LARI_LEARNING_EVIDENCE_JSON: JSON.stringify(evidence) }
      : runReportEnv);
  } catch (error) {
    const after = { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
    const report = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      query,
      risk,
      status: 'learning_candidate_rejected',
      reason: 'candidate construction or its immediate transfer proof failed',
      error: String(error.stack || error),
      before,
      after,
      promoted: false,
      passed: false
    };
    cleanupRunReports();
    atomic(outputPath, report);
    return report;
  }
  const learning = JSON.parse(fs.readFileSync(runLearningPath, 'utf8'));
  try { atomic(latestLearning, learning); } catch (_) {}
  const candidate = path.join(root, learning.candidate.path);
  let validationError = null;
  try {
    runNode('scripts/validate_lari_learning_candidate.js', [learning.candidate.path, learning.candidate.sha256], runReportEnv);
  } catch (error) {
    validationError = String(error.stack || error);
  }
  let validation = null;
  try {
    validation = JSON.parse(fs.readFileSync(runValidationPath, 'utf8'));
    try { atomic(validationPath, validation); } catch (_) {}
  } catch (error) {
    validationError = validationError || String(error.stack || error);
  }
  cleanupRunReports();
  const requiredGates = [
    'hashExact',
    'learnedRecordPresent',
    'projectionsAreDerived',
    'candidateStateIsSurgical',
    'typedAbsenceFailsClosed',
    'derivedProjectionsRebuild',
    'learnedTransfer5of5',
    'semanticStructureRetained',
    'semanticCompositionGrounded',
    'hiddenTransfer17of17',
    'coreCorrectness5of5',
    'zeroFamilyRegressions',
    'cliParity',
    'autonomousParity',
    'reloadRetention',
    'noExternalModelCalls',
    'activeReadOnly',
    'registryReadOnly'
  ];
  const gateContractSatisfied = Boolean(validation)
    && validation.passed === true
    && validation.candidate?.sha256 === learning.candidate.sha256
    && validation.learnedRecordId === learning.learned?.typedRecordId
    && requiredGates.every(gate => validation.gates?.[gate] === true);
  if (validationError || !gateContractSatisfied) {
    const after = { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
    const report = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      query,
      risk,
      status: 'candidate_rejected',
      reason: validationError ? 'candidate validation errored' : 'candidate failed the complete promotion gate contract',
      validationError,
      evidenceReused: learning.evidence?.reusedPublicAnswerEvidence === true,
      candidate: learning.candidate,
      validation: validation ? { passed: validation.passed, gates: validation.gates } : null,
      before,
      after,
      promoted: false,
      passed: false
    };
    atomic(outputPath, report);
    return report;
  }

  if (options.promote === false) {
    const after = { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
    const report = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      query,
      risk,
      status: 'validated_candidate',
      evidenceReused: learning.evidence?.reusedPublicAnswerEvidence === true,
      candidate: learning.candidate,
      validation: { passed: validation.passed, gates: validation.gates },
      before,
      after,
      promoted: false,
      passed: gateContractSatisfied
        && before.active === after.active
        && before.registry === after.registry
    };
    atomic(outputPath, report);
    return report;
  }

  const currentBeforePromotion = {
    active: sha(registry.currentModelPath),
    registry: sha(registry.registryPath)
  };
  if (currentBeforePromotion.active !== before.active || currentBeforePromotion.registry !== before.registry) {
    const report = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      query,
      risk,
      status: 'validated_candidate_parent_changed',
      reason: 'another verified model change completed while this candidate was validating; candidate was preserved but not promoted',
      candidate: learning.candidate,
      validation: { passed: validation.passed, gates: validation.gates },
      before,
      after: currentBeforePromotion,
      promoted: false,
      passed: true
    };
    atomic(outputPath, report);
    return report;
  }

  // Promotion requires the candidate to produce the exact typed knowledge it
  // claims to have learned. Selection-only transfer can be green while the
  // public answer is still generic or wrong, so run the real public kernel on
  // the immutable candidate before touching the registry.
  const typedRecordId = learning.learned?.typedRecordId;
  const candidateModel = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  const candidateRecord = (candidateModel.lariLearnedRecords?.records || [])
    .find(record => record.id === typedRecordId);
  const reusePrompt = validation.learned?.[0]?.prompt || query;
  const prePromotionReuse = await runtime.sendMessageToLariAsync(candidateModel, reusePrompt, {
    modelHash: learning.candidate.sha256,
    operator: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 }
    }
  });
  const normalizeAnswer = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const candidatePlan = candidateRecord?.payload?.responsePlan || null;
  const groundedPlan = candidatePlan?.composition === 'grounded_research_claims';
  const reuseAnswer = String(prePromotionReuse.answer || '');
  const groundedTrace = (prePromotionReuse.semanticClaimTrace || prePromotionReuse.result?.semanticClaimTrace || [])
    .filter(item => item?.sourceRecordId === typedRecordId && (item?.grounding?.citations || []).length > 0);
  const requestedAnalogy = /\banalog(?:y|ies)\b/i.test(reusePrompt);
  const requestedExample = /\b(?:tiny|small|simple|concrete)\s+example\b|\bone example\b/i.test(reusePrompt);
  const beginnerAudience = /\b(?:plain language|beginner|newcomer|novice|without a background|twelve[- ]year[- ]old|12[- ]year[- ]old|child|kid)\b/i.test(reusePrompt);
  const topicWords = new Set(String(candidateRecord?.payload?.topic || '').toLowerCase().match(/[a-z]+/g) || []);
  const unexplainedLongWords = (reuseAnswer.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) || [])
    .filter(word => word.length > 17 && !topicWords.has(word));
  const sentenceWordCounts = reuseAnswer.split(/[.!?]+/).map(sentence => sentence.trim().split(/\s+/).filter(Boolean).length).filter(Boolean);
  const groundedReuseCorrect = groundedPlan
    && groundedTrace.length > 0
    && (candidatePlan?.realization?.missingRequestedRoles || []).length === 0
    && reuseAnswer.length >= 80
    && !/scholarly work\s*:|linear recursion ii|recursion and double recursion/i.test(reuseAnswer)
    && (!beginnerAudience || (unexplainedLongWords.length === 0 && sentenceWordCounts.every(count => count <= 28)))
    && (!requestedAnalogy || /\banalogy\s*:/i.test(reuseAnswer))
    && (!requestedExample || /\b(?:tiny )?example\s*:/i.test(reuseAnswer));
  const prePromotionReuseCorrect = Boolean(candidateRecord)
    && (prePromotionReuse.learnedRecordIds || []).includes(typedRecordId)
    && (groundedReuseCorrect
      || (!groundedPlan && normalizeAnswer(prePromotionReuse.answer) === normalizeAnswer(candidateRecord.payload?.summary)))
    && !prePromotionReuse.factualGrounding
    && (prePromotionReuse.external_model_calls || 0) === 0;
  if (!prePromotionReuseCorrect) {
    const after = { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
    const report = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      query,
      risk,
      status: 'validated_candidate_reuse_failed',
      reason: 'candidate selected the learned record but did not emit its exact verified public answer',
      candidate: learning.candidate,
      validation: { passed: validation.passed, gates: validation.gates },
      reuse: { prompt: reusePrompt, answer: prePromotionReuse.answer, learnedRecordIds: prePromotionReuse.learnedRecordIds || [], expectedLearnedRecordId: typedRecordId, correct: false },
      before,
      after,
      promoted: false,
      passed: false
    };
    atomic(outputPath, report);
    return report;
  }

  let promoted;
  process.env.LARI_ALLOW_REAL_PROMOTION = '1';
  try {
    promoted = registry.promoteLariModel(candidate, {
      stage: 'autonomous-safe-learning',
      candidateHash: learning.candidate.sha256,
      parentHash: before.active,
      gate: 'benchmarks/latest-lari-learning-candidate-validation.json',
      risk,
      query,
      evidenceReused: learning.evidence?.reusedPublicAnswerEvidence === true,
      externalModelCalls: 0
    });
  } finally {
    delete process.env.LARI_ALLOW_REAL_PROMOTION;
  }
  const loaded = registry.loadLariModel();
  const response = await runtime.sendMessageToLariAsync(loaded.model, reusePrompt, {
    modelHash: learning.candidate.sha256,
    operator: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 }
    }
  });
  const after = {
    active: sha(registry.currentModelPath),
    registry: sha(registry.registryPath)
  };
  const promotedRecord = (loaded.model.lariLearnedRecords?.records || [])
    .find(record => record.id === typedRecordId);
  const promotedPlan = promotedRecord?.payload?.responsePlan || null;
  const promotedGroundedTrace = (response.semanticClaimTrace || response.result?.semanticClaimTrace || [])
    .filter(item => item?.sourceRecordId === typedRecordId && (item?.grounding?.citations || []).length > 0);
  const promotedAnswer = String(response.answer || '');
  const promotedLongWords = (promotedAnswer.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) || [])
    .filter(word => word.length > 17 && !topicWords.has(word));
  const promotedSentenceWordCounts = promotedAnswer.split(/[.!?]+/).map(sentence => sentence.trim().split(/\s+/).filter(Boolean).length).filter(Boolean);
  const reuseCorrect = Boolean(promotedRecord)
    && (response.learnedRecordIds || []).includes(typedRecordId)
    && (promotedPlan?.composition === 'grounded_research_claims'
      ? promotedGroundedTrace.length > 0
        && (promotedPlan?.realization?.missingRequestedRoles || []).length === 0
        && String(response.answer || '').length >= 80
        && !/scholarly work\s*:|linear recursion ii|recursion and double recursion/i.test(String(response.answer || ''))
        && (!beginnerAudience || (promotedLongWords.length === 0 && promotedSentenceWordCounts.every(count => count <= 28)))
        && (!requestedAnalogy || /\banalogy\s*:/i.test(String(response.answer || '')))
        && (!requestedExample || /\b(?:tiny )?example\s*:/i.test(String(response.answer || '')))
      : normalizeAnswer(response.answer) === normalizeAnswer(promotedRecord.payload?.summary));
  let rollback = null;
  let finalAfter = after;
  if (!reuseCorrect) {
    process.env.LARI_ALLOW_REAL_PROMOTION = '1';
    try {
      rollback = registry.promoteLariModel(promoted.previousModelPath, {
        stage: 'automatic-rollback-failed-autonomous-reuse',
        rollback: true,
        rollbackTargetHash: before.active,
        rolledBackFromHash: learning.candidate.sha256,
        reason: 'post-promotion public reuse verification failed',
        externalModelCalls: 0
      });
    } finally {
      delete process.env.LARI_ALLOW_REAL_PROMOTION;
    }
    finalAfter = { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
  }
  const report = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    query,
    risk,
    status: reuseCorrect ? 'promoted' : 'promotion_rolled_back',
    evidenceReused: learning.evidence?.reusedPublicAnswerEvidence === true,
    candidate: learning.candidate,
    validation: { passed: validation.passed, gates: validation.gates },
    promotion: {
      promotedAt: promoted.promotedAt,
      rollbackPath: promoted.previousModelPath,
      activeHash: after.active
    },
    rollback: rollback ? { restoredHash: finalAfter.active, targetHash: before.active, passed: finalAfter.active === before.active } : null,
    reuse: {
      prompt: reusePrompt,
      answer: response.answer,
      learnedRecordIds: response.learnedRecordIds || [],
      expectedLearnedRecordId: typedRecordId,
      correct: reuseCorrect,
      grounding: response.factualGrounding || null,
      externalModelCalls: response.external_model_calls || 0
    },
    before,
    after: finalAfter,
    promoted: reuseCorrect,
    passed: after.active === learning.candidate.sha256
      && reuseCorrect
      && !response.factualGrounding
      && (response.external_model_calls || 0) === 0
  };
  atomic(outputPath, report);
  return report;
}

const autoLearnLockPath = path.join(registry.registryRoot, '.auto-learn.lock');

function acquireAutoLearnLock(query = '') {
  fs.mkdirSync(path.dirname(autoLearnLockPath), { recursive: true });
  if (fs.existsSync(autoLearnLockPath)) {
    const age = Date.now() - fs.statSync(autoLearnLockPath).mtimeMs;
    if (age > 30 * 60 * 1000) fs.unlinkSync(autoLearnLockPath);
  }
  let fd;
  try {
    fd = fs.openSync(autoLearnLockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
  fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, queryHash: crypto.createHash('sha256').update(query).digest('hex'), startedAt: new Date().toISOString() })}\n`);
  fs.closeSync(fd);
  return () => {
    try { fs.unlinkSync(autoLearnLockPath); } catch (_) {}
  };
}

async function autoLearn(query, options = {}) {
  if (options.promote === false) return autoLearnUnlocked(query, options);
  const release = acquireAutoLearnLock(query);
  if (!release) {
    const before = { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
    const report = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      query,
      risk: classifyRisk(query),
      status: 'learning_busy',
      reason: 'another verified learning candidate is already being evaluated',
      before,
      after: before,
      promoted: false,
      passed: true
    };
    atomic(outputPath, report);
    return report;
  }
  try {
    return await autoLearnUnlocked(query, options);
  } finally {
    release();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const candidateOnly = args.includes('--candidate-only');
  const query = args.filter(arg => arg !== '--candidate-only').join(' ').trim();
  if (!query) {
    console.error('Usage: npm run lari:learn:auto -- "unknown question"');
    process.exit(2);
  }
  autoLearn(query, { promote: candidateOnly ? false : undefined }).then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }).catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = { autoLearn, queueAutoLearn, classifyRisk, normalizedEvidence, planAutoLearnFromResponse };
