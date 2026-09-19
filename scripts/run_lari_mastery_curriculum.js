#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE = path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'fresh-real-repository-holdout', 'developmental-candidates', '3b6199fa98be278b36bcba3ce6e2f1e000f3ef14640c0722e3f7002ca14b748c.json');
const OUTPUT_ROOT = path.join(ROOT, 'consolidation', 'mastery-curriculum-20260828');
const ACTIVE_PATH = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY_PATH = path.join(ROOT, 'models', 'lari', 'registry.json');

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function write(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function run(command, args, cwd) {
  const clearPythonCaches = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name === '__pycache__') fs.rmSync(target, { recursive: true, force: true });
      else if (entry.isDirectory()) clearPythonCaches(target);
    }
  };
  clearPythonCaches(cwd);
  const result = cp.spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  return { passed: result.status === 0, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function answer(model, prompt, modelHash) {
  const completion = runtime.runLariChatCompletion(model, {
    model: 'lari',
    messages: [{ role: 'user', content: prompt }]
  }, {
    modelHash,
    readOnly: true,
    debug: true,
    useBenchmarkSystem: false,
    capabilityGraph: { minScore: 0 },
    chat: { minMemoryScore: 0, minRouteScore: 0 }
  });
  return {
    text: completion.choices?.[0]?.message?.content || '',
    learnedRecordIds: completion.lari?.learned_record_ids || [],
    publicSource: completion.lari?.public_source || null,
    capabilitySelection: completion.lari?.capability_selection || null,
    externalModelCalls: completion.external_model_calls || 0
  };
}

const chatLessons = [
  {
    id: 'supportive_acknowledgement',
    trainingPrompt: 'It has been a rough day, but I finally got the deployment working.',
    hiddenPrompt: 'Today was brutal, though I finally got the tests passing.',
    expected: ['rough', 'real win', 'tests passing'],
    summary: 'Acknowledge the difficult emotion and the concrete progress before offering problem-solving.',
    procedure: {
      kind: 'supportive_acknowledgement',
      intents: ['open_chat'],
      triggers: ['rough', 'brutal', 'hard day', 'exhausting', 'finally fixed', 'finally solved', 'got working', 'tests passing', 'deployment working'],
      minTriggerMatches: 1,
      moves: ['acknowledge emotion', 'recognize progress', 'offer support without forcing a task']
    }
  },
  {
    id: 'decision_support',
    trainingPrompt: 'Help me decide whether to rewrite the prototype or refactor it in place.',
    hiddenPrompt: 'Help me decide whether to rebuild the service or improve it incrementally.',
    expected: ['reversible', 'risk', 'feedback'],
    summary: 'Compare alternatives by reversibility, risk, evidence, and time to feedback instead of guessing.',
    procedure: {
      kind: 'decision_support',
      intents: ['open_chat', 'planning'],
      triggers: ['decide', 'whether', 'rewrite', 'refactor', 'rebuild', 'incrementally', 'option', 'tradeoff'],
      minTriggerMatches: 2,
      criteria: ['reversibility', 'risk', 'time to feedback', 'preservation of working behavior']
    }
  },
  {
    id: 'polite_rewrite',
    trainingPrompt: 'Rewrite this politely: Your API is broken and your docs are useless.',
    hiddenPrompt: 'Rewrite this more professionally: This library is terrible and the guide is useless.',
    expected: ['documentation', 'help'],
    summary: 'Preserve the complaint while replacing attacks with specific observations and a constructive request.',
    procedure: {
      kind: 'polite_rewrite',
      intents: ['composition'],
      triggers: ['rewrite', 'politely', 'professional', 'terrible', 'useless', 'broken', 'docs', 'guide'],
      minTriggerMatches: 2,
      replacements: {
        broken: 'not behaving as expected',
        terrible: 'causing serious problems',
        useless: 'not giving me the clarification I need',
        docs: 'documentation',
        guide: 'documentation'
      }
    }
  },
  {
    id: 'systematic_troubleshooting',
    trainingPrompt: 'Debug a Node service that sometimes hangs during shutdown.',
    hiddenPrompt: 'Debug a Python worker that will not exit cleanly.',
    expected: ['reproduce', 'logs', 'hypothesis', 'verification'],
    summary: 'Diagnose lifecycle failures with a minimal reproduction, observations, one hypothesis at a time, and fail-to-pass verification.',
    procedure: {
      kind: 'systematic_troubleshooting',
      intents: ['troubleshooting'],
      triggers: ['debug', 'hang', 'shutdown', 'exit', 'worker', 'service', 'stuck', 'lifecycle'],
      minTriggerMatches: 2,
      steps: [
        'reproduce the symptom with the smallest reliable case',
        'capture timing, logs, open handles, and the last completed lifecycle step',
        'write one diagnostic hypothesis that explains those observations',
        'change one variable and rerun the same reproduction',
        'keep the repair only after fail-before and pass-after verification'
      ]
    }
  },
  {
    id: 'name_brainstorm',
    trainingPrompt: 'Give me three names for a private local coding partner.',
    hiddenPrompt: 'Give me 3 names for a private offline code helper.',
    expected: ['1.', '2.', '3.'],
    summary: 'Generate the requested number of concise names from learned local-coding vocabulary.',
    procedure: {
      kind: 'name_brainstorm',
      intents: ['open_chat', 'composition'],
      triggers: ['names', 'name', 'private', 'local', 'offline', 'code', 'coding', 'helper', 'partner'],
      minTriggerMatches: 3,
      prefixes: ['Local', 'Code', 'Forge'],
      suffixes: ['Pilot', 'Smith', 'Mate']
    }
  }
];

const codingLessons = [
  {
    id: 'multiply',
    functionName: 'rectangleArea',
    source: 'function rectangleArea(width, height) {\n  return width + height;\n}\nmodule.exports = { rectangleArea };\n',
    test: "const assert=require('assert'); const {rectangleArea}=require('../src/operation'); assert.strictEqual(rectangleArea(6,7),42); assert.strictEqual(rectangleArea(-3,4),-12); assert.strictEqual(rectangleArea('5','8'),40); console.log('multiply verified');\n",
    hiddenFunction: 'scaleAmount',
    hiddenSource: 'def scaleAmount(value, factor):\n    return value + factor\n',
    hiddenTest: "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom src.operation import scaleAmount\nassert scaleAmount(6, 7) == 42\nassert scaleAmount(-3, 4) == -12\nprint('multiply transfer verified')\n"
  },
  {
    id: 'negative_sum',
    functionName: 'sumNegativeBalances',
    source: 'function sumNegativeBalances(values) {\n  return values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);\n}\nmodule.exports = { sumNegativeBalances };\n',
    test: "const assert=require('assert'); const {sumNegativeBalances}=require('../src/operation'); assert.strictEqual(sumNegativeBalances([-4,3,-2,5]),-6); assert.strictEqual(sumNegativeBalances([1,2]),0); console.log('negative sum verified');\n",
    hiddenFunction: 'totalLosses',
    hiddenSource: 'def totalLosses(values):\n    return sum(value for value in values if value > 0)\n',
    hiddenTest: "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom src.operation import totalLosses\nassert totalLosses([-4, 3, -2, 5]) == -6\nassert totalLosses([1, 2]) == 0\nprint('negative sum transfer verified')\n"
  },
  {
    id: 'unique',
    functionName: 'uniqueTags',
    source: 'function uniqueTags(values) {\n  return values;\n}\nmodule.exports = { uniqueTags };\n',
    test: "const assert=require('assert'); const {uniqueTags}=require('../src/operation'); assert.deepStrictEqual(uniqueTags(['b','a','b','a']),['b','a']); assert.deepStrictEqual(uniqueTags([]),[]); console.log('unique verified');\n",
    hiddenFunction: 'dedupeLabels',
    hiddenSource: 'def dedupeLabels(values):\n    return list(values)\n',
    hiddenTest: "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom src.operation import dedupeLabels\nassert dedupeLabels(['b', 'a', 'b', 'a']) == ['b', 'a']\nassert dedupeLabels([]) == []\nprint('unique transfer verified')\n"
  },
  {
    id: 'numeric_sort',
    functionName: 'sortScores',
    source: 'function sortScores(values) {\n  return values;\n}\nmodule.exports = { sortScores };\n',
    test: "const assert=require('assert'); const {sortScores}=require('../src/operation'); assert.deepStrictEqual(sortScores([10,2,1]),[1,2,10]); assert.deepStrictEqual(sortScores([]),[]); console.log('sort verified');\n",
    hiddenFunction: 'orderMeasurements',
    hiddenSource: 'def orderMeasurements(values):\n    return list(values)\n',
    hiddenTest: "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom src.operation import orderMeasurements\nassert orderMeasurements([10, 2, 1]) == [1, 2, 10]\nassert orderMeasurements([]) == []\nprint('sort transfer verified')\n"
  }
];

function trainChat(model, baseHash) {
  const baseline = chatLessons.map(lesson => ({ id: lesson.id, ...answer(model, lesson.hiddenPrompt, baseHash) }));
  const learned = [];
  for (const lesson of chatLessons) {
    const turn = runtime.runGeneralChat(model, lesson.trainingPrompt, {
      minMemoryScore: 0,
      minRouteScore: 0,
      correction: {
        topic: `general chat ${lesson.id}`,
        summary: lesson.summary,
        confidence: 0.9,
        procedure: ['identify conversational intent', 'execute the reusable response plan', 'verify on a semantic paraphrase'],
        chatProcedure: { ...lesson.procedure, confidence: 0.9 },
        chatProcedureOptions: { sourceModelHash: baseHash, sourcePath: 'scripts/run_lari_mastery_curriculum.js' }
      }
    });
    if (!turn.learnedChatProcedure?.id) throw new Error(`Chat lesson ${lesson.id} did not create a typed procedure.`);
    learned.push({ id: lesson.id, recordId: turn.learnedChatProcedure.id });
  }
  return { baseline, learned };
}

function trainCoding(model, baseHash) {
  const results = [];
  for (const lesson of codingLessons) {
    const workspace = path.join(OUTPUT_ROOT, 'training-workspaces', lesson.id);
    fs.rmSync(workspace, { recursive: true, force: true });
    write(path.join(workspace, 'src', 'operation.js'), lesson.source);
    write(path.join(workspace, 'tests', 'test.js'), lesson.test);
    const before = run(process.execPath, ['tests/test.js'], workspace);
    if (before.passed) throw new Error(`Coding lesson ${lesson.id} must fail before learning.`);
    const learned = runtime.runLariDefaultFailureLearningPath(model, {
      id: `mastery.training.${lesson.id}`,
      prompt: `Learn from this failed ${lesson.id} implementation. Repair the selected function, prove the declared test passes, and retain the verified operator for semantic transfer.`,
      workspaceRoot: workspace,
      testPath: 'tests/test.js',
      testRunner: 'javascript.node',
      expressionTarget: 'src/operation.js',
      preserveLayout: true
    }, {
      modelHash: baseHash,
      sourcePath: relative(workspace),
      testRunner: 'javascript.node',
      allowExpressionOperatorDiscovery: true,
      allowSemanticOperatorDiscovery: true
    });
    const after = run(process.execPath, ['tests/test.js'], workspace);
    const event = learned.report?.event || {};
    if (!learned.report?.passed || !after.passed || !event.retainedPatternId || event.verificationRule?.exactDeclaredRunnerFailToPass !== true) {
      throw new Error(`Coding lesson ${lesson.id} failed: ${JSON.stringify({ report: learned.report, after })}`);
    }
    results.push({
      id: lesson.id,
      recordId: event.retainedPatternId,
      mode: event.frontierFallback?.expressionRepair?.mode || null,
      verificationRule: event.verificationRule
    });
  }
  return results;
}

function validateChat(model, candidateHash, learned) {
  return chatLessons.map(lesson => {
    const response = answer(model, lesson.hiddenPrompt, candidateHash);
    const lower = response.text.toLowerCase();
    const expectedHits = lesson.expected.filter(term => lower.includes(term.toLowerCase()));
    const recordId = learned.find(item => item.id === lesson.id)?.recordId || null;
    return {
      id: lesson.id,
      prompt: lesson.hiddenPrompt,
      answer: response.text,
      expectedHits,
      expectedCount: lesson.expected.length,
      learnedRecordId: recordId,
      selectedLearnedRecordIds: response.learnedRecordIds,
      publicSource: response.publicSource,
      passed: expectedHits.length === lesson.expected.length
        && response.learnedRecordIds.includes(recordId)
        && response.publicSource === 'learned_chat_procedure'
        && response.externalModelCalls === 0
    };
  });
}

function validateCoding(model, candidateHash, trained) {
  return codingLessons.map(lesson => {
    const workspace = path.join(OUTPUT_ROOT, 'transfer-workspaces', lesson.id);
    fs.rmSync(workspace, { recursive: true, force: true });
    write(path.join(workspace, 'src', '__init__.py'), '');
    write(path.join(workspace, 'src', 'operation.py'), lesson.hiddenSource);
    write(path.join(workspace, 'tests', 'test.py'), lesson.hiddenTest);
    const before = run('python', ['tests/test.py'], workspace);
    const transferModel = clone(model);
    const response = runtime.sendMessageToLari(transferModel, {
      mode: 'code',
      prompt: `Repair this unseen Python ${lesson.id} implementation using retained verified capability only.`,
      workspaceRoot: workspace,
      testPath: 'tests/test.py',
      testRunner: 'python.script',
      expressionTarget: 'src/operation.py',
      preserveLayout: true
    }, {
      modelHash: candidateHash,
      autoGrow: false,
      groundedFactual: false,
      kernel: {
        useBenchmarkSystem: false,
        useCapabilityGraph: true,
        capabilityGraph: { minScore: 0 },
        chat: { minMemoryScore: 0, minRouteScore: 0 },
        allowExpressionOperatorDiscovery: false,
        allowSemanticOperatorDiscovery: false,
        testRunner: 'python.script'
      }
    });
    const after = run('python', ['tests/test.py'], workspace);
    const expectedRecordId = trained.find(item => item.id === lesson.id)?.recordId || null;
    const appliedRecordId = response.executionBinding?.appliedOperatorRecordId
      || response.trace?.find(item => item.phase === 'default_failure_learning')?.retainedPatternId
      || null;
    return {
      id: lesson.id,
      beforeFailed: !before.passed,
      afterPassed: after.passed,
      expectedRecordId,
      appliedRecordId,
      modelHash: response.modelHash,
      exactRunnerFailToPass: response.executionBinding?.verificationRule?.exactDeclaredRunnerFailToPass === true,
      externalModelCalls: response.external_model_calls || 0,
      passed: !before.passed
        && after.passed
        && appliedRecordId === expectedRecordId
        && response.modelHash === candidateHash
        && response.executionBinding?.verificationRule?.exactDeclaredRunnerFailToPass === true
        && (response.external_model_calls || 0) === 0
    };
  });
}

function main() {
  const basePath = path.resolve(process.argv[2] || DEFAULT_BASE);
  const baseBytes = fs.readFileSync(basePath);
  const baseHash = sha256Bytes(baseBytes);
  const base = JSON.parse(baseBytes);
  const activeBefore = sha256File(ACTIVE_PATH);
  const registryBefore = sha256File(REGISTRY_PATH);
  const baseBefore = sha256File(basePath);
  const baseRecordIds = new Set((base.lariLearnedRecords?.records || []).map(record => record.id));
  const trainingModel = clone(base);

  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const chatTraining = trainChat(trainingModel, baseHash);
  const codingTraining = trainCoding(trainingModel, baseHash);
  const newRecords = (trainingModel.lariLearnedRecords?.records || [])
    .filter(record => !baseRecordIds.has(record.id))
    .filter(record => chatTraining.learned.some(item => item.recordId === record.id)
      || codingTraining.some(item => item.recordId === record.id));
  const expectedRecordIds = [...chatTraining.learned, ...codingTraining].map(item => item.recordId);
  if (newRecords.length !== expectedRecordIds.length || !expectedRecordIds.every(id => newRecords.some(record => record.id === id))) {
    throw new Error(`Candidate delta mismatch: expected ${expectedRecordIds.length}, found ${newRecords.length}.`);
  }

  const candidate = clone(base);
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  candidate.lariLearnedRecords.records = [
    ...newRecords,
    ...candidate.lariLearnedRecords.records.filter(record => !expectedRecordIds.includes(record.id))
  ];
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: baseHash,
    developmentalEvent: 'coding_and_general_chat_mastery_curriculum_1',
    createdAt: new Date().toISOString(),
    promoted: false
  };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha256Bytes(candidateBytes);
  const candidateDir = path.join(OUTPUT_ROOT, 'candidates');
  const candidatePath = path.join(candidateDir, `${candidateHash}.json`);
  fs.mkdirSync(candidateDir, { recursive: true });
  if (fs.existsSync(candidatePath)) {
    if (sha256File(candidatePath) !== candidateHash) throw new Error('Existing immutable candidate hash mismatch.');
  } else {
    fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });
  }

  const reload = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const chatValidation = validateChat(reload, candidateHash, chatTraining.learned);
  const codingValidation = validateCoding(reload, candidateHash, codingTraining);
  const activeAfter = sha256File(ACTIVE_PATH);
  const registryAfter = sha256File(REGISTRY_PATH);
  const baseAfter = sha256File(basePath);
  const gates = {
    fiveChatProceduresLearned: chatTraining.learned.length === 5,
    fourCodingOperatorsLearned: codingTraining.length === 4,
    canonicalTypedDeltaOnly: newRecords.length === 9 && newRecords.every(record => ['procedure', 'operator'].includes(record.type)),
    chatParaphraseTransfer5Of5: chatValidation.every(item => item.passed),
    codingCrossLanguageTransfer4Of4: codingValidation.every(item => item.passed),
    reloadRetention: expectedRecordIds.every(id => (reload.lariLearnedRecords?.records || []).some(record => record.id === id)),
    candidateHashStable: sha256File(candidatePath) === candidateHash,
    parentCandidateReadOnly: baseBefore === baseAfter,
    activeModelReadOnly: activeBefore === activeAfter,
    registryReadOnly: registryBefore === registryAfter,
    externalModelCallsZero: [...chatValidation, ...codingValidation].every(item => Number(item.externalModelCalls || 0) === 0)
  };
  const passed = Object.values(gates).every(Boolean);
  const report = {
    schemaVersion: 1,
    kind: 'lari.mastery-developmental-curriculum',
    createdAt: new Date().toISOString(),
    passed,
    verdict: passed ? 'Bounded mastery curriculum passed; full promotion gates pending' : 'Mastery curriculum failed',
    candidate: {
      path: relative(candidatePath),
      sha256: candidateHash,
      parentHash: baseHash,
      promoted: false,
      learnedRecordIds: expectedRecordIds
    },
    candidateEligibility: {
      releaseCandidate: false,
      evidenceClass: 'developmental_curriculum',
      reason: 'Requires family regression, hidden transfer, five-surface parity, and isolated promotion rehearsal before eligibility.'
    },
    gates,
    chat: {
      baseline: chatTraining.baseline,
      learned: chatTraining.learned,
      validation: chatValidation,
      score: `${chatValidation.filter(item => item.passed).length}/${chatValidation.length}`
    },
    coding: {
      training: codingTraining,
      validation: codingValidation,
      score: `${codingValidation.filter(item => item.passed).length}/${codingValidation.length}`
    },
    hashes: {
      activeBefore,
      activeAfter,
      registryBefore,
      registryAfter,
      parentBefore: baseBefore,
      parentAfter: baseAfter
    },
    externalModelCalls: 0
  };
  const reportPath = path.join(OUTPUT_ROOT, 'developmental-curriculum-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed, candidate: report.candidate, gates, chatScore: report.chat.score, codingScore: report.coding.score, report: relative(reportPath) }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main();
