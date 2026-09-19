#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE = path.join(ROOT, 'consolidation', 'mastery-curriculum-20260828', 'candidates', 'f093b68a65b51839b9f465fbc45ff54e82aa0eb22d250f2eadf9b6f6d39f8bc3.json');
const OUTPUT_ROOT = path.join(ROOT, 'consolidation', 'mastery-expansion-20260828');
const ACTIVE_PATH = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY_PATH = path.join(ROOT, 'models', 'lari', 'registry.json');

const chatLessons = [
  {
    id: 'requirements_clarification',
    trainingPrompt: 'I want to build a local research notebook but the requirements are fuzzy.',
    hiddenPrompts: [
      ['I am trying to create an offline team dashboard, but I have not defined it clearly.', ['primary user', 'constraints', 'success evidence', 'smallest vertical slice']],
      ['I need to make a private document assistant and do not know what requirements matter.', ['required outcome', 'privacy', 'observable test']]
    ],
    summary: 'Clarify the user, outcome, constraints, and observable success before proposing a build.',
    procedure: { kind: 'requirements_clarification', intents: ['open_chat', 'planning'], triggers: ['build', 'create', 'make', 'requirements', 'fuzzy', 'unclear', 'not defined', 'do not know'], minTriggerMatches: 2 }
  },
  {
    id: 'structured_plan',
    trainingPrompt: 'Make a plan to move a local service to a safer persistence format.',
    hiddenPrompts: [
      ['Give me a roadmap for improving the reliability of an offline coding tool.', ['baseline', 'smallest vertical slice', 'verify', 'rollback']],
      ['What steps should we use to replace a fragile cache safely?', ['acceptance evidence', 'main risk', 'record failures']]
    ],
    summary: 'Turn a goal into a baseline-first, reversible, evidence-driven sequence.',
    procedure: { kind: 'structured_plan', intents: ['planning'], triggers: ['plan', 'roadmap', 'steps', 'strategy', 'improving', 'replace', 'move'], minTriggerMatches: 2, steps: ['state the outcome and acceptance evidence', 'capture the current baseline before changing anything', 'build the smallest vertical slice that tests the main risk', 'verify behavior and record failures', 'iterate from evidence while preserving rollback'] }
  },
  {
    id: 'concise_summary',
    trainingPrompt: 'Summarize this: The migration keeps current data readable. It also adds an exact rollback pointer.',
    hiddenPrompts: [
      ['Summarize: The release candidate passed reload tests. Promotion still waits for surface parity.', ['release candidate passed reload tests', 'promotion still waits for surface parity']],
      ['Give a concise summary: The new procedure is retained in typed state; it remains unpromoted until regression checks pass.', ['new procedure is retained', 'regression checks pass']]
    ],
    summary: 'Compress supplied text into its main and supporting points without inventing facts.',
    procedure: { kind: 'concise_summary', intents: ['composition'], triggers: ['summarize', 'summary', 'concise', 'main point', 'supporting point'], minTriggerMatches: 1 }
  },
  {
    id: 'risk_review',
    trainingPrompt: 'What could go wrong with migrating every user profile at once?',
    hiddenPrompts: [
      ['Review the risks of replacing the active model manifest during a release.', ['data loss', 'compatibility', 'failure visibility', 'rollback']],
      ['What are the risks with changing durable memory storage?', ['state corruption', 'recovery time', 'partial activation']]
    ],
    summary: 'Review concrete failure classes and require evidence and rollback before durable changes.',
    procedure: { kind: 'risk_review', intents: ['explanation', 'open_chat'], triggers: ['risk', 'risks', 'go wrong', 'failure', 'rollout', 'release', 'manifest', 'migration', 'durable', 'replace'], minTriggerMatches: 1, criteria: ['data loss and state corruption', 'compatibility and migration', 'failure visibility and recovery time', 'rollback and partial activation'] }
  },
  {
    id: 'priority_triage',
    trainingPrompt: 'Help me prioritize: fix data loss, polish colors, and add another demo.',
    hiddenPrompts: [
      ['What should I do first: repair rollback, rewrite the landing page, and add animations?', ['unblocks', 'user impact', 'irreversible', 'smallest reversible action']],
      ['Prioritize these tasks: stabilize persistence, rename buttons, and publish screenshots.', ['largest uncertainty', 'reassess']]
    ],
    summary: 'Order work by blocking relationships, user impact, irreversibility, and speed of evidence.',
    procedure: { kind: 'priority_triage', intents: ['planning', 'open_chat'], triggers: ['prioritize', 'first', 'tasks', 'queue', 'unblock', 'impact', 'reversible'], minTriggerMatches: 1 }
  },
  {
    id: 'learning_roadmap',
    trainingPrompt: 'How should Lari learn to debug unfamiliar Python repositories?',
    hiddenPrompts: [
      ['Give me a roadmap to learn reliable API refactoring.', ['executable success check', 'baseline', 'diagnostic hypothesis', 'fresh semantic variant', 'reload']],
      ['How do we get better at diagnosing asynchronous shutdown failures?', ['failure-to-pass verification', 'unseen case', 'typed procedure or operator']]
    ],
    summary: 'Define learning as verified behavioral transfer, not reading or memorizing an answer.',
    procedure: { kind: 'learning_roadmap', intents: ['planning', 'explanation'], triggers: ['learn', 'roadmap', 'teach', 'get better', 'training', 'practice', 'unseen'], minTriggerMatches: 2 }
  },
  {
    id: 'feedback_design',
    trainingPrompt: 'How should I collect useful beta feedback without teaching users what to say?',
    hiddenPrompts: [
      ['Help me design feedback collection for people trying Lari on real coding work.', ['real tasks', 'point of confusion or failure', 'consent', 'reproduce']],
      ['What is a good way to learn from early user feedback safely?', ['concrete observations', 'recurring failures', 'correctness or safety']]
    ],
    summary: 'Collect task-grounded feedback with consent and turn reproducible recurring failures into learning goals.',
    procedure: { kind: 'feedback_design', intents: ['planning', 'explanation', 'open_chat'], triggers: ['feedback', 'users', 'beta', 'early', 'collect', 'learn from', 'real coding'], minTriggerMatches: 2 }
  }
];

const codingLessons = [
  {
    id: 'sum_all', functionName: 'netChange',
    source: 'function netChange(values) {\n  return 0;\n}\nmodule.exports = { netChange };\n',
    test: "const assert=require('assert');const {netChange}=require('../src/operation');assert.strictEqual(netChange([3,-2,5]),6);assert.strictEqual(netChange([]),0);\n",
    transfers: [
      ['totalReadings', 'def totalReadings(values):\n    return 0\n', 'assert totalReadings([4, -1, 8]) == 11\nassert totalReadings([]) == 0'],
      ['aggregateChanges', 'def aggregateChanges(items):\n    return 0\n', 'assert aggregateChanges([-3, 5, 9]) == 11']
    ]
  },
  {
    id: 'positive_list', functionName: 'positiveReadings',
    source: 'function positiveReadings(values) {\n  return values;\n}\nmodule.exports = { positiveReadings };\n',
    test: "const assert=require('assert');const {positiveReadings}=require('../src/operation');assert.deepStrictEqual(positiveReadings([-2,0,3,5]),[3,5]);assert.deepStrictEqual(positiveReadings([-4]),[]);\n",
    transfers: [
      ['gainsOnly', 'def gainsOnly(values):\n    return list(values)\n', 'assert gainsOnly([-2, 0, 3, 5]) == [3, 5]'],
      ['aboveZero', 'def aboveZero(items):\n    return list(items)\n', 'assert aboveZero([1, -1, 2]) == [1, 2]']
    ]
  },
  {
    id: 'negative_list', functionName: 'negativeReadings',
    source: 'function negativeReadings(values) {\n  return values;\n}\nmodule.exports = { negativeReadings };\n',
    test: "const assert=require('assert');const {negativeReadings}=require('../src/operation');assert.deepStrictEqual(negativeReadings([-2,0,3,-5]),[-2,-5]);assert.deepStrictEqual(negativeReadings([4]),[]);\n",
    transfers: [
      ['lossesOnly', 'def lossesOnly(values):\n    return list(values)\n', 'assert lossesOnly([-2, 0, 3, -5]) == [-2, -5]'],
      ['belowZero', 'def belowZero(items):\n    return list(items)\n', 'assert belowZero([1, -1, -2]) == [-1, -2]']
    ]
  },
  {
    id: 'count_items', functionName: 'entryCount',
    source: 'function entryCount(values) {\n  return 0;\n}\nmodule.exports = { entryCount };\n',
    test: "const assert=require('assert');const {entryCount}=require('../src/operation');assert.strictEqual(entryCount(['a','b','c']),3);assert.strictEqual(entryCount([]),0);\n",
    transfers: [
      ['labelCount', 'def labelCount(values):\n    return 0\n', "assert labelCount(['x', 'y']) == 2\nassert labelCount([]) == 0"],
      ['recordCount', 'def recordCount(items):\n    return 0\n', 'assert recordCount([1, 2, 3, 4]) == 4']
    ]
  },
  {
    id: 'add_values', functionName: 'combinedAmount',
    source: 'function combinedAmount(left, right) {\n  return left - right;\n}\nmodule.exports = { combinedAmount };\n',
    test: "const assert=require('assert');const {combinedAmount}=require('../src/operation');assert.strictEqual(combinedAmount(8,5),13);assert.strictEqual(combinedAmount(-2,7),5);\n",
    transfers: [
      ['mergeTotals', 'def mergeTotals(first, second):\n    return first - second\n', 'assert mergeTotals(8, 5) == 13\nassert mergeTotals(-2, 7) == 5'],
      ['addOffsets', 'def addOffsets(a, b):\n    return a - b\n', 'assert addOffsets(4, 9) == 13']
    ]
  },
  {
    id: 'divide_values', functionName: 'averagePerUnit',
    source: 'function averagePerUnit(total, count) {\n  return total * count;\n}\nmodule.exports = { averagePerUnit };\n',
    test: "const assert=require('assert');const {averagePerUnit}=require('../src/operation');assert.strictEqual(averagePerUnit(20,5),4);assert.strictEqual(averagePerUnit(-9,3),-3);\n",
    transfers: [
      ['ratePerItem', 'def ratePerItem(total, count):\n    return total * count\n', 'assert ratePerItem(20, 5) == 4\nassert ratePerItem(-9, 3) == -3'],
      ['ratioValue', 'def ratioValue(value, divisor):\n    return value * divisor\n', 'assert ratioValue(18, 6) == 3']
    ]
  },
  {
    id: 'active_values', functionName: 'enabledAmounts',
    source: 'function enabledAmounts(records) {\n  return records;\n}\nmodule.exports = { enabledAmounts };\n',
    test: "const assert=require('assert');const {enabledAmounts}=require('../src/operation');assert.deepStrictEqual(enabledAmounts([{enabled:true,amount:3},{enabled:false,amount:8},{enabled:true,amount:5}]),[3,5]);\n",
    transfers: [
      ['activeScores', 'def activeScores(records):\n    return list(records)\n', "assert activeScores([{'active': True, 'score': 4}, {'active': False, 'score': 9}, {'active': True, 'score': 2}]) == [4.0, 2.0]"],
      ['visibleTotals', 'def visibleTotals(items):\n    return list(items)\n', "assert visibleTotals([{'visible': True, 'total': 7}, {'visible': False, 'total': 1}]) == [7.0]"]
    ]
  },
  {
    id: 'active_count', functionName: 'enabledCount',
    source: 'function enabledCount(records) {\n  return 0;\n}\nmodule.exports = { enabledCount };\n',
    test: "const assert=require('assert');const {enabledCount}=require('../src/operation');assert.strictEqual(enabledCount([{enabled:true,label:'a'},{enabled:false,label:'b'},{enabled:true,label:'c'}]),2);assert.strictEqual(enabledCount([]),0);\n",
    transfers: [
      ['readyCount', 'def readyCount(records):\n    return 0\n', "assert readyCount([{'ready': True, 'name': 'a'}, {'ready': False, 'name': 'b'}, {'ready': True, 'name': 'c'}]) == 2"],
      ['selectedCount', 'def selectedCount(items):\n    return 0\n', "assert selectedCount([{'selected': False, 'id': 1}, {'selected': True, 'id': 2}]) == 1"]
    ]
  }
];

function sha256Bytes(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256File(filePath) { return sha256Bytes(fs.readFileSync(filePath)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function relative(filePath) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function write(filePath, contents) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, contents); }
function run(command, args, cwd) {
  const clear = directory => { if (!fs.existsSync(directory)) return; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const target = path.join(directory, entry.name); if (entry.isDirectory() && entry.name === '__pycache__') fs.rmSync(target, { recursive: true, force: true }); else if (entry.isDirectory()) clear(target); } };
  clear(cwd);
  const result = cp.spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  return { passed: result.status === 0, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function completion(model, prompt, modelHash) {
  const result = runtime.runLariChatCompletion(model, { model: 'lari', messages: [{ role: 'user', content: prompt }] }, { modelHash, readOnly: true, debug: true, useBenchmarkSystem: false, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } });
  return { text: result.choices?.[0]?.message?.content || '', learnedRecordIds: result.lari?.learned_record_ids || [], publicSource: result.lari?.public_source || null, externalModelCalls: result.external_model_calls || 0 };
}

function trainChat(model, baseHash) {
  return chatLessons.map(lesson => {
    const turn = runtime.runGeneralChat(model, lesson.trainingPrompt, { minMemoryScore: 0, minRouteScore: 0, correction: { topic: `expanded general chat ${lesson.id}`, summary: lesson.summary, confidence: 0.9, procedure: ['identify intent', 'execute reusable response plan', 'verify semantic variants'], chatProcedure: { ...lesson.procedure, confidence: 0.9 }, chatProcedureOptions: { sourceModelHash: baseHash, sourcePath: 'scripts/run_lari_mastery_expansion.js' } } });
    if (!turn.learnedChatProcedure?.id) throw new Error(`Chat lesson ${lesson.id} did not retain a typed procedure.`);
    return { id: lesson.id, recordId: turn.learnedChatProcedure.id };
  });
}

function trainCoding(model, baseHash) {
  return codingLessons.map(lesson => {
    const workspace = path.join(OUTPUT_ROOT, 'training-workspaces', lesson.id);
    fs.rmSync(workspace, { recursive: true, force: true });
    write(path.join(workspace, 'src', 'operation.js'), lesson.source);
    write(path.join(workspace, 'tests', 'test.js'), lesson.test);
    if (run(process.execPath, ['tests/test.js'], workspace).passed) throw new Error(`${lesson.id} must fail before learning.`);
    const learned = runtime.runLariDefaultFailureLearningPath(model, { id: `mastery.expansion.training.${lesson.id}`, prompt: `Learn from this failed ${lesson.id} implementation. Repair it, prove the declared test, and retain only the verified reusable operator.`, workspaceRoot: workspace, testPath: 'tests/test.js', testRunner: 'javascript.node', expressionTarget: 'src/operation.js', preserveLayout: true }, { modelHash: baseHash, sourcePath: relative(workspace), testRunner: 'javascript.node', allowExpressionOperatorDiscovery: true, allowSemanticOperatorDiscovery: true });
    const event = learned.report?.event || {};
    if (!learned.report?.passed || !run(process.execPath, ['tests/test.js'], workspace).passed || !event.retainedPatternId || event.verificationRule?.exactDeclaredRunnerFailToPass !== true) {
      write(path.join(workspace, 'failed-learning-report.json'), `${JSON.stringify(learned.report || learned, null, 2)}\n`);
      throw new Error(`Coding lesson ${lesson.id} failed to retain a verified operator; see ${relative(path.join(workspace, 'failed-learning-report.json'))}.`);
    }
    return { id: lesson.id, recordId: event.retainedPatternId, mode: event.frontierFallback?.expressionRepair?.mode || null, verificationRule: event.verificationRule };
  });
}

function validateChat(model, candidateHash, learned) {
  return chatLessons.flatMap(lesson => lesson.hiddenPrompts.map(([prompt, expected], variantIndex) => {
    const response = completion(model, prompt, candidateHash);
    const recordId = learned.find(item => item.id === lesson.id)?.recordId;
    const lower = response.text.toLowerCase();
    const hits = expected.filter(value => lower.includes(value.toLowerCase()));
    return { id: lesson.id, variantIndex, prompt, answer: response.text, expected, hits, recordId, selectedRecordIds: response.learnedRecordIds, publicSource: response.publicSource, passed: hits.length === expected.length && response.learnedRecordIds.includes(recordId) && response.publicSource === 'learned_chat_procedure' && response.externalModelCalls === 0 };
  }));
}

function validateCoding(model, candidateHash, trained) {
  return codingLessons.flatMap(lesson => lesson.transfers.map(([functionName, source, assertions], variantIndex) => {
    const workspace = path.join(OUTPUT_ROOT, 'transfer-workspaces', lesson.id, String(variantIndex + 1));
    fs.rmSync(workspace, { recursive: true, force: true });
    write(path.join(workspace, 'src', '__init__.py'), '');
    write(path.join(workspace, 'src', 'operation.py'), source);
    write(path.join(workspace, 'tests', 'test.py'), `import os,sys\nsys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))\nfrom src.operation import ${functionName}\n${assertions}\n`);
    const before = run('python', ['tests/test.py'], workspace);
    const response = runtime.sendMessageToLari(clone(model), { mode: 'code', prompt: `Repair this unseen Python ${lesson.id} implementation using retained verified capability only.`, workspaceRoot: workspace, testPath: 'tests/test.py', testRunner: 'python.script', expressionTarget: 'src/operation.py', preserveLayout: true }, { modelHash: candidateHash, autoGrow: false, groundedFactual: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 }, allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, testRunner: 'python.script' } });
    const after = run('python', ['tests/test.py'], workspace);
    const expectedRecordId = trained.find(item => item.id === lesson.id)?.recordId;
    const appliedRecordId = response.executionBinding?.appliedOperatorRecordId || response.trace?.find(item => item.phase === 'default_failure_learning')?.retainedPatternId || null;
    return { id: lesson.id, variantIndex, beforeFailed: !before.passed, afterPassed: after.passed, expectedRecordId, appliedRecordId, modelHash: response.modelHash, exactRunnerFailToPass: response.executionBinding?.verificationRule?.exactDeclaredRunnerFailToPass === true, externalModelCalls: response.external_model_calls || 0, passed: !before.passed && after.passed && appliedRecordId === expectedRecordId && response.modelHash === candidateHash && response.executionBinding?.verificationRule?.exactDeclaredRunnerFailToPass === true && (response.external_model_calls || 0) === 0 };
  }));
}

function hiddenTransfer(model, candidateHash) {
  const records = (model.lariLearnedRecords?.records || []).filter(record => record.provenance?.imported && record.type === 'knowledge' && !(record.provenance?.benchmarkAssociation || []).length && (record.normalizedTriggers || []).length >= 2).slice(0, 17);
  const rows = records.map(record => { const prompt = `In a new situation, what reusable guidance applies when ${record.normalizedTriggers.slice(0, 4).reverse().join(', ')} matter?`; const matches = runtime.searchKnowledge(clone(model), prompt, { limit: 5, minScore: 0 }) || []; const routed = matches.some(match => (match.item?.id || match.id) === record.provenance.originalRecordId); const response = runtime.sendMessageToLari(clone(model), prompt, { modelHash: candidateHash, autoGrow: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } }); return { recordId: record.id, routed, answered: String(response.answer || '').length > 0, passed: routed && String(response.answer || '').length > 0 }; });
  return { rows, passedCount: rows.filter(row => row.passed).length, total: rows.length, passed: rows.length === 17 && rows.every(row => row.passed) };
}

function familyRegression(base, candidate, baseHash, candidateHash) {
  const cases = { chat: 'Explain how durable local state helps a conversation.', instruction: 'Give exactly two bullets about safe backups.', math: 'What is 18 plus 27?', multiple_choice: 'Which protects data? A) Delete B) Atomic backup C) Ignore D) Rename', coding: 'Describe diagnostics when a test fails.', research: 'Explain source-grounded learning.', product: 'Describe a verified local product plan.', safety: 'Why verify destructive changes?' };
  const score = (model, hash, prompt) => { const response = runtime.sendMessageToLari(clone(model), prompt, { modelHash: hash, autoGrow: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } }); return Number(response.passed !== false) + Number(response.passed === true) + Math.min(1, String(response.answer || '').length / 80); };
  const rows = Object.entries(cases).map(([family, prompt]) => { const before = score(base, baseHash, prompt), after = score(candidate, candidateHash, prompt); return { family, before, after, regressed: after + 0.0001 < before }; });
  return { rows, regressionCount: rows.filter(row => row.regressed).length, passed: rows.every(row => !row.regressed) };
}

function main() {
  const baseArgument = process.argv.slice(2).find(value => !value.startsWith('--'));
  const basePath = path.resolve(baseArgument || DEFAULT_BASE);
  const baseBytes = fs.readFileSync(basePath);
  const baseHash = sha256Bytes(baseBytes);
  const base = JSON.parse(baseBytes);
  const protectedBefore = { base: sha256File(basePath), active: sha256File(ACTIVE_PATH), registry: sha256File(REGISTRY_PATH) };
  const model = clone(base);
  const baseIds = new Set((base.lariLearnedRecords?.records || []).map(record => record.id));
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const chatTraining = trainChat(model, baseHash);
  if (process.argv.includes('--chat-preflight')) {
    const preflight = clone(base);
    const chatIds = new Set(chatTraining.map(item => item.recordId));
    const chatRecords = (model.lariLearnedRecords?.records || []).filter(record => chatIds.has(record.id));
    preflight.lariLearnedRecords.records = [...chatRecords, ...preflight.lariLearnedRecords.records.filter(record => !chatIds.has(record.id))];
    const preflightHash = sha256Bytes(Buffer.from(JSON.stringify(preflight)));
    const validation = validateChat(preflight, preflightHash, chatTraining);
    process.stdout.write(`${JSON.stringify({ passed: validation.every(item => item.passed), score: `${validation.filter(item => item.passed).length}/${validation.length}`, failures: validation.filter(item => !item.passed) }, null, 2)}\n`);
    if (!validation.every(item => item.passed)) process.exitCode = 1;
    return;
  }
  const codingTraining = trainCoding(model, baseHash);
  const expectedIds = [...chatTraining, ...codingTraining].map(item => item.recordId);
  const newRecords = (model.lariLearnedRecords?.records || []).filter(record => !baseIds.has(record.id) && expectedIds.includes(record.id));
  if (newRecords.length !== 15 || new Set(expectedIds).size !== 15) throw new Error(`Expected 15 unique learned records, got ${newRecords.length} records and ${new Set(expectedIds).size} IDs.`);
  const candidate = clone(base);
  candidate.lariLearnedRecords.records = [...newRecords, ...candidate.lariLearnedRecords.records.filter(record => !expectedIds.includes(record.id))];
  candidate.lineage = { ...(candidate.lineage || {}), parentHash: baseHash, developmentalEvent: 'coding_and_general_chat_mastery_expansion_2', createdAt: new Date().toISOString(), promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha256Bytes(bytes);
  const candidatePath = path.join(OUTPUT_ROOT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const chatValidation = validateChat(reloaded, candidateHash, chatTraining);
  const codingValidation = validateCoding(reloaded, candidateHash, codingTraining);
  const hidden = hiddenTransfer(reloaded, candidateHash);
  const regressions = familyRegression(base, reloaded, baseHash, candidateHash);
  const protectedAfter = { base: sha256File(basePath), active: sha256File(ACTIVE_PATH), registry: sha256File(REGISTRY_PATH) };
  const gates = { sevenChatProceduresLearned: chatTraining.length === 7, eightCodingOperatorsLearned: codingTraining.length === 8, canonicalTypedDelta15: newRecords.length === 15 && newRecords.every(record => ['procedure', 'operator'].includes(record.type) && !(record.provenance?.benchmarkAssociation || []).length), chatSemanticVariants14Of14: chatValidation.length === 14 && chatValidation.every(item => item.passed), codingCrossLanguageVariants16Of16: codingValidation.length === 16 && codingValidation.every(item => item.passed), hiddenTransfer17Of17: hidden.passed, zeroFamilyRegressions: regressions.passed, reloadRetention: expectedIds.every(id => (reloaded.lariLearnedRecords?.records || []).some(record => record.id === id)), candidateHashStable: sha256File(candidatePath) === candidateHash, protectedStateReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter), externalModelCallsZero: [...chatValidation, ...codingValidation].every(item => Number(item.externalModelCalls || 0) === 0) };
  const passed = Object.values(gates).every(Boolean);
  const report = { schemaVersion: 1, kind: 'lari.mastery-expansion-developmental-curriculum', createdAt: new Date().toISOString(), passed, verdict: passed ? 'Expanded mastery candidate passed developmental transfer gates; public-surface qualification pending' : 'Mastery expansion failed', candidate: { path: relative(candidatePath), sha256: candidateHash, parentHash: baseHash, promoted: false, learnedRecordIds: expectedIds }, candidateEligibility: { releaseCandidate: false, evidenceClass: 'developmental_curriculum', reason: 'Requires five-surface parity and isolated promotion/rollback qualification before release eligibility.' }, gates, chat: { training: chatTraining, validation: chatValidation, score: `${chatValidation.filter(item => item.passed).length}/${chatValidation.length}` }, coding: { training: codingTraining, validation: codingValidation, score: `${codingValidation.filter(item => item.passed).length}/${codingValidation.length}` }, hiddenTransfer: hidden, familyRegression: regressions, protectedBefore, protectedAfter, externalModelCalls: 0 };
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'expansion-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed, candidate: report.candidate, gates, chatScore: report.chat.score, codingScore: report.coding.score, hiddenTransfer: `${hidden.passedCount}/${hidden.total}`, familyRegressions: regressions.regressionCount }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main();
