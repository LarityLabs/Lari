#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const OPERATOR_ID = 'lari.learned.operator.neurogenesis.bc535718fcf928bd6ead';
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(language) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lari-declarative-${language}-`));
  if (language === 'javascript') {
    write(root, 'src/dependencies.js', "function normalizeDependencies(values) {\n  return values;\n}\nmodule.exports = { normalizeDependencies };\n");
    write(root, 'tests/dependencies.test.js', "const assert = require('assert');\nconst { normalizeDependencies } = require('../src/dependencies');\nassert.deepStrictEqual(normalizeDependencies(['typescript', 'eslint', 'typescript']), ['eslint', 'typescript']);\n");
    return { root, target: 'src/dependencies.js', test: 'tests/dependencies.test.js', runner: 'javascript.node' };
  }
  write(root, 'src/dependencies.py', "def normalize_dependencies(values):\n    return values\n");
  write(root, 'tests/dependencies_test.py', "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom src.dependencies import normalize_dependencies\nassert normalize_dependencies(['typescript', 'eslint', 'typescript']) == ['eslint', 'typescript']\n");
  return { root, target: 'src/dependencies.py', test: 'tests/dependencies_test.py', runner: 'python.script' };
}

function oracle(spec) {
  const executable = spec.runner === 'python.script' ? 'python' : process.execPath;
  const run = spawnSync(executable, [spec.test], { cwd: spec.root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { passed: run.status === 0, status: run.status, output: `${run.stdout || ''}${run.stderr || ''}`.slice(0, 2000) };
}

function options(hash) {
  const workspaceExecution = {
    maxIterations: 0,
    allowExpressionOperatorDiscovery: false,
    allowSemanticOperatorDiscovery: false,
    allowPrimitiveDiscovery: false,
    coordinatedProgramSearch: false,
    modelHash: hash,
    sourcePath: 'ordinary_public_workspace_request',
    benchmarkAssociation: []
  };
  return {
    modelHash: hash,
    autoGrow: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: workspaceExecution,
      executionContract: { workspaceExecution }
    }
  };
}

function runCase(model, language) {
  const spec = fixture(language);
  const before = oracle(spec);
  assert.strictEqual(before.passed, false, `${language} fixture must fail before repair`);
  const response = runtime.sendMessageToLari(model, {
    id: `declarative-workspace-${language}`,
    mode: 'code',
    subintent: 'code.fix',
    prompt: 'Repair the failing dependency normalization function so it removes duplicates and returns a stable ascending list. Verify the existing test and preserve the public function signature.',
    workspaceRoot: spec.root,
    testPath: spec.test,
    testRunner: spec.runner,
    expressionTarget: spec.target,
    preserveLayout: true
  }, options(protectedBefore.active));
  const after = oracle(spec);
  const execution = response.executionBinding?.workspaceExecution
    || response.trace?.find(item => item.phase === 'default_failure_learning')?.frontierFallback
    || null;
  const repair = execution?.expressionRepair || response.executionBinding?.workspaceExecution?.expressionRepair || null;
  return { spec, before, after, response, execution, repair };
}

const rows = [];
for (const language of ['javascript', 'python']) {
  const result = runCase(clone(active), language);
  assert.strictEqual(result.after.passed, true, `${language} retained primitive must repair the workspace`);
  assert.strictEqual(result.response.passed, true, `${language} public kernel response must be verified`);
  assert.strictEqual(result.repair?.learnedRecordId, OPERATOR_ID, `${language} must use the exact retained operator`);
  assert.strictEqual(result.repair?.mode, 'retained_declarative_primitive_operator');
  assert.strictEqual(Number(result.response.external_model_calls || 0), 0);
  rows.push({ language, operatorId: result.repair.learnedRecordId, mode: result.repair.mode, failBefore: !result.before.passed, passAfter: result.after.passed });
}

const reloaded = JSON.parse(JSON.stringify(active));
const reload = runCase(reloaded, 'javascript');
assert.strictEqual(reload.after.passed, true);
assert.strictEqual(reload.repair?.learnedRecordId, OPERATOR_ID);

const ablated = clone(active);
ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== OPERATOR_ID);
const ablation = runCase(ablated, 'javascript');
assert.strictEqual(ablation.after.passed, false, 'exact operator ablation must restore failure');
assert.notStrictEqual(ablation.repair?.learnedRecordId, OPERATOR_ID);

assert.deepStrictEqual({ active: shaFile(ACTIVE), registry: shaFile(REGISTRY) }, protectedBefore);

console.log(JSON.stringify({
  test: 'lari-declarative-workspace-binding',
  passed: true,
  activeHash: protectedBefore.active,
  operatorId: OPERATOR_ID,
  languages: rows,
  reloadRetention: true,
  exactOperatorAblationRestoresFailure: true,
  publicKernelPath: 'sendMessageToLari -> runLariUnifiedTaskKernel -> runFrontierCodingRepairLoop',
  activeReadOnly: true,
  registryReadOnly: true,
  externalModelCalls: 0
}, null, 2));
