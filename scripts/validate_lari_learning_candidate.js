#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const childProcess = require('child_process');
const runtime = require('../swarm_model_runtime');
const registry = require('./lari_model_registry');

const root = path.resolve(__dirname, '..');
const candidatePath = path.resolve(root, process.argv[2] || '');
const expectedHash = process.argv[3] || '';
const learningPath = process.env.LARI_LEARNING_REPORT_PATH
  ? path.resolve(process.env.LARI_LEARNING_REPORT_PATH)
  : path.join(root, 'benchmarks', 'latest-lari-failure-driven-learning-report.json');
const outputPath = process.env.LARI_VALIDATION_REPORT_PATH
  ? path.resolve(process.env.LARI_VALIDATION_REPORT_PATH)
  : path.join(root, 'benchmarks', 'latest-lari-learning-candidate-validation.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

function atomicReport(value) {
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  fs.renameSync(temporary, outputPath);
}

function send(model, prompt, modelHash) {
  return runtime.sendMessageToLari(clone(model), prompt, {
    modelHash,
    autoGrow: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: {
        minMemoryScore: 0,
        minRouteScore: 0,
        retainedKnowledgeMinScore: 0.24,
        retainedKnowledgeAnswerScore: 0.28
      }
    }
  });
}

function answerSource(response) {
  return response.publicAnswerSource
    || response.source
    || response.lari?.source
    || response.trace?.find(item => item.phase === 'chat')?.publicAnswerSource
    || null;
}

function summary(response = {}) {
  return {
    answer: response.answer || response.output_text || '',
    modelHash: response.modelHash || response.model_hash || response.lari?.model_hash || null,
    action: response.action || response.lari?.action || null,
    source: answerSource(response),
    learnedRecordIds: response.learnedRecordIds || response.learned_record_ids || response.lari?.learned_record_ids || [],
    semanticClaimTrace: response.semanticClaimTrace || response.result?.semanticClaimTrace || [],
    externalModelCalls: response.external_model_calls ?? 0
  };
}

function completion(model, prompt) {
  const response = runtime.runLariChatCompletion(clone(model), {
    model: 'lari',
    messages: [{ role: 'user', content: prompt }]
  }, {
    debug: true,
    readOnly: true,
    benchmarkSystem: { minScore: 0 },
    capabilityGraph: { minScore: 0 },
    chat: { minMemoryScore: 0, minRouteScore: 0 }
  });
  return String(response?.choices?.[0]?.message?.content || '');
}

function numericAnswer(text) {
  const matches = String(text || '').match(/[-+]?\d[\d,]*(?:\.\d+)?/g) || [];
  const value = String(matches[matches.length - 1] || '').replace(/,/g, '');
  return value ? Number(value) : null;
}

function runCodeCheck(answer) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${answer}\nthis.__sumEven = sumEven;`, context, { timeout: 1000 });
  return typeof context.__sumEven === 'function'
    && context.__sumEven([1, 2, 3, 4, 6]) === 12
    && context.__sumEven([1, 3, 5]) === 0;
}

function coreCorrectness(model) {
  const cases = [
    {
      id: 'math-exact',
      family: 'math',
      prompt: 'What is 18 + 27?',
      check: answer => numericAnswer(answer) === 45
    },
    {
      id: 'instruction-two-bullets',
      family: 'instruction',
      prompt: 'Give exactly two bullet points about backups.',
      check: answer => String(answer).split(/\r?\n/).filter(line => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length === 2
    },
    {
      id: 'instruction-json-contract',
      family: 'instruction',
      prompt: 'Return only valid JSON with keys model, surface, and goal.',
      check: answer => {
        const parsed = JSON.parse(answer);
        return JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(['goal', 'model', 'surface']);
      }
    },
    {
      id: 'code-executes',
      family: 'coding',
      prompt: 'Write a concise JavaScript function named sumEven that returns the sum of even numbers in an array.',
      check: runCodeCheck
    },
    {
      id: 'read-only-inference',
      family: 'safety',
      prompt: 'Why should normal Lari inference be read-only by default?',
      check: answer => ['model', 'state', 'save'].every(term => normalize(answer).includes(term))
    }
  ];
  return cases.map(test => {
    let answer = '';
    try {
      answer = completion(model, test.prompt);
      return { id: test.id, family: test.family, prompt: test.prompt, answer, passed: test.check(answer) === true };
    } catch (error) {
      return { id: test.id, family: test.family, prompt: test.prompt, answer, passed: false, error: String(error.stack || error) };
    }
  });
}

function recordSelected(matches, recordId) {
  return matches.some(match => match.learnedRecordId === recordId
    && match.item?.sourceLearnedRecordId === recordId);
}

function forbiddenStatePaths(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const forbidden = new Set(['prompt', 'query', 'trace', 'path', 'workspacePath', 'session', 'turns']);
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = prefix ? `${prefix}.${key}` : key;
    return [
      ...(forbidden.has(key) ? [childPath] : []),
      ...forbiddenStatePaths(child, childPath)
    ];
  });
}

async function main() {
  if (!fs.existsSync(candidatePath)) throw new Error('candidate missing');
  if (!fs.existsSync(learningPath)) throw new Error('learning report missing');
  const learning = JSON.parse(fs.readFileSync(learningPath, 'utf8'));
  const candidateHash = sha(candidatePath);
  if (expectedHash && candidateHash !== expectedHash) throw new Error('candidate hash mismatch');
  if (learning.candidate?.sha256 !== candidateHash) throw new Error('learning report does not describe candidate');

  const activePath = registry.currentModelPath;
  const before = { active: sha(activePath), registry: sha(registry.registryPath) };
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
  const record = (candidate.lariLearnedRecords?.records || [])
    .find(item => item.id === learning.learned?.typedRecordId);
  if (!record || record.type !== 'knowledge' || record.status !== 'active') {
    throw new Error('new active typed knowledge record missing');
  }

  const topic = learning.learned.topic;
  const query = learning.query;
  const expectedSummary = normalize(record.payload?.summary);
  const expectedClaims = (record.payload?.responsePlan?.sections || []).map(section => normalize(section?.body)).filter(Boolean);
  const realizationPlan = record.payload?.responsePlan?.realization || {};
  const semanticComponents = Array.isArray(realizationPlan.semanticComposition) && realizationPlan.semanticComposition.length
    ? realizationPlan.semanticComposition
    : realizationPlan.semanticPattern && realizationPlan.groundingClaimId
      ? [{ pattern: realizationPlan.semanticPattern, groundingClaimId: realizationPlan.groundingClaimId, order: 0 }]
      : [];
  if (!expectedSummary) throw new Error('typed knowledge record has no expected summary');
  const variants = [
    query,
    `Explain ${topic} in plain language.`,
    `What should I understand about ${topic}?`,
    `Why is ${topic} noteworthy?`,
    `Describe ${topic} for someone encountering it for the first time.`
  ];
  const surfacePrompt = variants[0];
  const learned = variants.map(prompt => {
    const matches = runtime.searchKnowledge(clone(candidate), prompt, { limit: 5, minScore: 0 }) || [];
    const response = send(candidate, prompt, candidateHash);
    const answer = String(response.answer || '');
    const typedSelected = recordSelected(matches, record.id);
    const publicBound = (response.learnedRecordIds || []).includes(record.id);
    const normalizedAnswer = normalize(answer);
    const groundedTrace = (response.semanticClaimTrace || response.result?.semanticClaimTrace || [])
      .filter(item => item?.sourceRecordId === record.id && (item?.grounding?.citations || []).length > 0);
    const answerMatchesTypedPayload = normalizedAnswer === expectedSummary
      || (expectedClaims.length > 0 && expectedClaims.some(claim => normalizedAnswer.includes(claim)))
      || groundedTrace.length > 0;
    const avoidsMetadataAsAnswer = !/scholarly work\s*:|linear recursion ii|recursion and double recursion/i.test(answer);
    const avoidsCircularDefinition = !/process that exhibits .+ is (?:recursive|.+ive)\b/i.test(answer);
    const topicWords = new Set(String(topic).toLowerCase().match(/[a-z]+/g) || []);
    const unexplainedLongWords = (answer.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) || [])
      .filter(word => word.length > 17 && !topicWords.has(word));
    const sentenceWordCounts = answer.split(/[.!?]+/).map(sentence => sentence.trim().split(/\s+/).filter(Boolean).length).filter(Boolean);
    const audienceSatisfied = !/\b(?:plain language|beginner|newcomer|novice|without a background|twelve[- ]year[- ]old|12[- ]year[- ]old|child|kid)\b/i.test(prompt)
      || (unexplainedLongWords.length === 0 && sentenceWordCounts.every(count => count <= 28));
    const analogySatisfied = !/\banalog(?:y|ies)\b/i.test(prompt) || /\banalogy\s*:/i.test(answer);
    const exampleSatisfied = !/\b(?:tiny|small|simple|concrete)\s+example\b|\bone example\b/i.test(prompt) || /\b(?:tiny )?example\s*:/i.test(answer);
    const usefulExplanation = answer.length >= 80 && avoidsMetadataAsAnswer && avoidsCircularDefinition
      && audienceSatisfied && analogySatisfied && exampleSatisfied;
    return {
      prompt,
      answer,
      source: answerSource(response),
      typedSelected,
      publicBound,
      answerMatchesTypedPayload,
      groundedTraceCount: groundedTrace.length,
      usefulExplanation,
      audienceSatisfied,
      unexplainedLongWords,
      analogySatisfied,
      exampleSatisfied,
      passed: typedSelected
        && publicBound
        && answerSource(response) === 'verified_retained_knowledge'
        && answerMatchesTypedPayload
        && usefulExplanation
    };
  });

  const hiddenRecords = (candidate.lariLearnedRecords?.records || [])
    .filter(item => item.provenance?.imported
      && item.type === 'knowledge'
      && !(item.provenance?.benchmarkAssociation || []).length
      && item.normalizedTriggers?.length >= 2)
    .slice(0, 17);
  const hidden = hiddenRecords.map(item => {
    const prompt = `In a new situation, what reusable guidance applies when ${item.normalizedTriggers.slice(0, 4).reverse().join(', ')} matter?`;
    const matches = runtime.searchKnowledge(clone(candidate), prompt, { limit: 5, minScore: 0 }) || [];
    const match = matches.find(entry => entry.learnedRecordId === item.id);
    const payloadCorrect = Boolean(match)
      && match.item?.sourceLearnedRecordId === item.id
      && normalize(match.item?.summary) === normalize(item.payload?.summary);
    return { id: item.id, prompt, typedSelected: Boolean(match), payloadCorrect, passed: payloadCorrect };
  });

  const candidateCore = coreCorrectness(candidate);
  const activeCore = coreCorrectness(active);
  const activeCoreById = new Map(activeCore.map(item => [item.id, item]));
  const regressions = candidateCore.map(item => ({
    family: item.family,
    id: item.id,
    incumbentPassed: activeCoreById.get(item.id)?.passed === true,
    candidatePassed: item.passed,
    regressed: activeCoreById.get(item.id)?.passed === true && item.passed !== true
  }));

  const typedIds = new Set((candidate.lariLearnedRecords?.records || []).map(item => item.id));
  const projectionIntegrity = {
    allKnowledgeDerived: (candidate.selfTeaching?.knowledgeBase || []).every(item => item.sourceLearnedRecordId && typedIds.has(item.sourceLearnedRecordId)),
    allCompiledSkillsDerived: (candidate.compiledSkills || []).every(item => item.sourceLearnedRecordId && typedIds.has(item.sourceLearnedRecordId)),
    learnedKnowledgeProjectionPresent: (candidate.selfTeaching?.knowledgeBase || []).some(item => item.sourceLearnedRecordId === record.id),
    learnedSkillProjectionPresent: (candidate.compiledSkills || []).some(item => item.sourceLearnedRecordId === record.id)
  };
  const allowedTopLevelChanges = new Set(['lariLearnedRecords', 'selfTeaching', 'compiledSkills', 'lineage']);
  const changedTopLevelKeys = [...new Set([...Object.keys(active), ...Object.keys(candidate)])]
    .filter(key => JSON.stringify(active[key]) !== JSON.stringify(candidate[key]));
  const activeSelfTeachingMetadata = { ...(active.selfTeaching || {}) };
  const candidateSelfTeachingMetadata = { ...(candidate.selfTeaching || {}) };
  delete activeSelfTeachingMetadata.knowledgeBase;
  delete candidateSelfTeachingMetadata.knowledgeBase;
  // Before promotion the candidate must name the live incumbent as its
  // parent.  After a successful promotion the live file is the candidate, so
  // compare its lineage against the registry's recorded promotion parent
  // instead of falsely treating activation as a surgery violation.
  const liveRegistry = registry.readLariModelRegistry() || {};
  const candidateAlreadyActive = before.active === candidateHash
    && liveRegistry.activeModelSha256 === candidateHash
    && (liveRegistry.metadata?.lineageParentHash === candidate.lineage?.parentHash
      || liveRegistry.metadata?.parentHash === candidate.lineage?.parentHash);
  const stateSurgery = {
    changedTopLevelKeys,
    nonAllowedChanges: changedTopLevelKeys.filter(key => !allowedTopLevelChanges.has(key)),
    selfTeachingMetadataUnchanged: JSON.stringify(activeSelfTeachingMetadata) === JSON.stringify(candidateSelfTeachingMetadata),
    forbiddenTypedRecordStatePaths: forbiddenStatePaths(record),
    parentHashMatchesIncumbent: candidate.lineage?.parentHash === before.active || candidateAlreadyActive,
    validationContext: candidateAlreadyActive ? 'post_promotion_registry_lineage' : 'pre_promotion_incumbent'
  };
  stateSurgery.passed = stateSurgery.nonAllowedChanges.length === 0
    && stateSurgery.selfTeachingMetadataUnchanged
    && stateSurgery.forbiddenTypedRecordStatePaths.length === 0
    && stateSurgery.parentHashMatchesIncumbent;

  const absent = clone(candidate);
  absent.lariLearnedRecords.records = absent.lariLearnedRecords.records.filter(item => item.id !== record.id);
  const absentMatchesBeforeRebuild = runtime.searchKnowledge(absent, surfacePrompt, { limit: 5, minScore: 0 }) || [];
  const absentResponse = send(absent, surfacePrompt, candidateHash);
  const absentProjectionReport = runtime.refreshLariKnowledgeProjections(absent, { pruneUnboundCompiledSkills: true });
  const typedAbsenceControl = {
    staleProjectionRejected: !recordSelected(absentMatchesBeforeRebuild, record.id)
      && !(absentResponse.learnedRecordIds || []).includes(record.id),
    staleKnowledgeProjectionRemoved: !(absent.selfTeaching?.knowledgeBase || []).some(item => item.sourceLearnedRecordId === record.id),
    staleSkillProjectionRemoved: !(absent.compiledSkills || []).some(item => item.sourceLearnedRecordId === record.id),
    projectionReport: absentProjectionReport
  };
  typedAbsenceControl.passed = typedAbsenceControl.staleProjectionRejected
    && typedAbsenceControl.staleKnowledgeProjectionRemoved
    && typedAbsenceControl.staleSkillProjectionRemoved;

  const rebuild = clone(candidate);
  rebuild.selfTeaching.knowledgeBase = (rebuild.selfTeaching?.knowledgeBase || [])
    .filter(item => item.sourceLearnedRecordId !== record.id);
  rebuild.compiledSkills = (rebuild.compiledSkills || [])
    .filter(item => item.sourceLearnedRecordId !== record.id);
  runtime.refreshLariKnowledgeProjections(rebuild, { strict: true });
  runtime.compileSkills(rebuild, { threshold: 0.5, limit: 420 });
  const rebuildReport = runtime.refreshLariKnowledgeProjections(rebuild, { strict: true });
  const projectionRebuild = {
    knowledgeRestored: (rebuild.selfTeaching?.knowledgeBase || []).some(item => item.sourceLearnedRecordId === record.id),
    compiledSkillRestored: (rebuild.compiledSkills || []).some(item => item.sourceLearnedRecordId === record.id),
    report: rebuildReport
  };
  projectionRebuild.passed = projectionRebuild.knowledgeRestored && projectionRebuild.compiledSkillRestored;

  const direct = summary(send(candidate, surfacePrompt, candidateHash));
  const cliPayload = {
    prompt: surfacePrompt,
    model_path: path.relative(root, candidatePath),
    save_model: false,
    context: { groundedFactual: false, autonomousLearning: false }
  };
  const cliRun = childProcess.spawnSync(process.execPath, ['scripts/lari_model_cli.js'], {
    cwd: root,
    input: JSON.stringify(cliPayload),
    encoding: 'utf8',
    timeout: 30000
  });
  if (cliRun.status !== 0) throw new Error(`candidate CLI failed: ${cliRun.stderr || cliRun.stdout}`);
  const cliPayloadResult = JSON.parse(cliRun.stdout);
  const cli = summary(cliPayloadResult.response || cliPayloadResult);
  cli.modelHash = cliPayloadResult.model_hash || cli.modelHash;
  const autonomous = summary(await runtime.runLariAutonomousRequest(clone(candidate), surfacePrompt, {
    mode: 'chat',
    modelHash: candidateHash,
    groundedFactual: false
  }));
  const reloadedModel = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const reload = summary(send(reloadedModel, variants[1], candidateHash));
  const after = { active: sha(activePath), registry: sha(registry.registryPath) };

  const gates = {
    hashExact: !expectedHash || candidateHash === expectedHash,
    learnedRecordPresent: Boolean(record),
    projectionsAreDerived: Object.values(projectionIntegrity).every(Boolean),
    candidateStateIsSurgical: stateSurgery.passed,
    typedAbsenceFailsClosed: typedAbsenceControl.passed,
    derivedProjectionsRebuild: projectionRebuild.passed,
    learnedTransfer5of5: learned.length === 5 && learned.every(item => item.passed),
    semanticStructureRetained: Boolean(record.payload?.responsePlan?.realization?.semanticPattern)
      && learned.every(item => item.groundedTraceCount > 0),
    semanticCompositionGrounded: semanticComponents.length > 0
      && (realizationPlan.missingRequestedRoles || []).length === 0
      && semanticComponents.every(component => (record.payload?.responsePlan?.sections || []).some(section => section.id === component.groundingClaimId
        && (section.grounding?.citations || []).length > 0)),
    hiddenTransfer17of17: hidden.length === 17 && hidden.every(item => item.passed),
    coreCorrectness5of5: candidateCore.length === 5 && candidateCore.every(item => item.passed),
    zeroFamilyRegressions: regressions.every(item => !item.regressed),
    cliParity: cli.answer === direct.answer
      && cli.modelHash === candidateHash
      && cli.learnedRecordIds.includes(record.id),
    autonomousParity: autonomous.answer === direct.answer
      && autonomous.modelHash === candidateHash
      && autonomous.learnedRecordIds.includes(record.id),
    reloadRetention: reload.source === 'verified_retained_knowledge'
      && reload.learnedRecordIds.includes(record.id)
      && (normalize(reload.answer) === expectedSummary
        || (expectedClaims.length > 0 && expectedClaims.some(claim => normalize(reload.answer).includes(claim)))
        || reload.semanticClaimTrace.some(item => item?.sourceRecordId === record.id
          && (item?.grounding?.citations || []).length > 0)),
    noExternalModelCalls: [direct, cli, autonomous, reload].every(item => item.externalModelCalls === 0),
    activeReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry
  };
  const report = {
    schemaVersion: 3,
    benchmark: 'lari-learning-candidate-promotion-gate',
    createdAt: new Date().toISOString(),
    query,
    topic,
    learnedRecordId: record.id,
    candidate: {
      path: path.relative(root, candidatePath).replace(/\\/g, '/'),
      sha256: candidateHash,
      parentHash: candidate.lineage?.parentHash || null
    },
    projectionIntegrity,
    stateSurgery,
    typedAbsenceControl,
    projectionRebuild,
    learned,
    hiddenTransfer: { passed: hidden.filter(item => item.passed).length, total: hidden.length, rows: hidden },
    coreCorrectness: candidateCore,
    incumbentCoreCorrectness: activeCore,
    regressions,
    surfaces: { direct, cli, autonomous },
    reload,
    before,
    after,
    gates,
    passed: Object.values(gates).every(Boolean)
  };
  atomicReport(report);
  console.log(JSON.stringify({
    passed: report.passed,
    gates,
    learned: `${learned.filter(item => item.passed).length}/${learned.length}`,
    hidden: `${report.hiddenTransfer.passed}/${report.hiddenTransfer.total}`,
    core: `${candidateCore.filter(item => item.passed).length}/${candidateCore.length}`,
    regressions: regressions.filter(item => item.regressed).length
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => {
  const failure = {
    schemaVersion: 3,
    benchmark: 'lari-learning-candidate-promotion-gate',
    createdAt: new Date().toISOString(),
    candidate: {
      path: path.relative(root, candidatePath).replace(/\\/g, '/'),
      expectedHash: expectedHash || null,
      sha256: fs.existsSync(candidatePath) ? sha(candidatePath) : null
    },
    error: String(error.stack || error),
    gates: { validationCompletedWithoutError: false },
    passed: false
  };
  try { atomicReport(failure); } catch (_) {}
  console.error(error.stack || error);
  process.exit(1);
});
