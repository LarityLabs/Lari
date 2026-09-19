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
const IDS = {
  array: 'lari.learned.operator.neurogenesis.bc535718fcf928bd6ead',
  string: 'lari.learned.operator.neurogenesis.2469ea082df026142b03',
  number: 'lari.learned.operator.neurogenesis.31c20239996b13252fa3'
};
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const active = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));

const cases = [
  { id: 'array-js', family: 'array', language: 'javascript', functionName: 'tidyToolchain', input: "['vite', 'eslint', 'vite']", expected: "['eslint', 'vite']", prompt: 'Repair this toolchain canonicalization function: remove duplicate dependency names and sort the resulting list in ascending order.' },
  { id: 'array-py', family: 'array', language: 'python', functionName: 'tidy_toolchain', input: "['ruff', 'mypy', 'ruff']", expected: "['mypy', 'ruff']", prompt: 'Fix the package-list canonicalizer so duplicate dependencies disappear and the stable result is ascending.' },
  { id: 'string-js', family: 'string', language: 'javascript', functionName: 'projectReference', input: "'  ORBIT  '", expected: "'orbit-id'", prompt: 'Repair canonical project-key generation: trim surrounding space, lowercase the key, and append the required -id suffix.' },
  { id: 'string-py', family: 'string', language: 'python', functionName: 'project_reference', input: "'  NEBULA '", expected: "'nebula-id'", prompt: 'Fix project key normalization so it strips outside whitespace, uses lowercase, and finishes with -id.' },
  { id: 'number-js', family: 'number', language: 'javascript', functionName: 'calibrateProbe', input: '11', expected: '27', prompt: 'Repair the affine sensor calibration function. The retained relation doubles the raw reading and then adds five.' },
  { id: 'number-py', family: 'number', language: 'python', functionName: 'calibrate_probe', input: '14', expected: '33', prompt: 'Fix this probe calibration using the learned affine relation: scale the reading by two, then apply an offset of five.' }
];

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function materialize(testCase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lari-cross-domain-${testCase.id}-`));
  if (testCase.language === 'javascript') {
    write(root, 'src/transform.js', `function ${testCase.functionName}(value) {\n  return value;\n}\nmodule.exports = { ${testCase.functionName} };\n`);
    write(root, 'tests/transform.test.js', `const assert = require('assert');\nconst { ${testCase.functionName} } = require('../src/transform');\nassert.deepStrictEqual(${testCase.functionName}(${testCase.input}), ${testCase.expected});\n`);
    return { ...testCase, root, target: 'src/transform.js', test: 'tests/transform.test.js', runner: 'javascript.node' };
  }
  write(root, 'src/transform.py', `def ${testCase.functionName}(value):\n    return value\n`);
  write(root, 'tests/transform_test.py', `import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom src.transform import ${testCase.functionName}\nassert ${testCase.functionName}(${testCase.input}) == ${testCase.expected}\n`);
  return { ...testCase, root, target: 'src/transform.py', test: 'tests/transform_test.py', runner: 'python.script' };
}

function oracle(spec) {
  const run = spawnSync(spec.language === 'python' ? 'python' : process.execPath, [spec.test], { cwd: spec.root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return run.status === 0;
}

function run(testCase, model) {
  const spec = materialize(testCase);
  assert.strictEqual(oracle(spec), false, `${spec.id} must fail before Lari acts`);
  const executionOptions = { maxIterations: 0, allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, allowPrimitiveDiscovery: false, coordinatedProgramSearch: false, modelHash: protectedBefore.active, sourcePath: 'sealed_cross_domain_workspace_transfer', benchmarkAssociation: [] };
  const response = runtime.sendMessageToLari(model, {
    id: spec.id, mode: 'code', subintent: 'code.fix', prompt: spec.prompt,
    workspaceRoot: spec.root, testPath: spec.test, testRunner: spec.runner,
    expressionTarget: spec.target, preserveLayout: true
  }, { modelHash: protectedBefore.active, autoGrow: false, groundedFactual: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 }, failureLearning: executionOptions, executionContract: { workspaceExecution: executionOptions } } });
  const execution = response.executionBinding?.workspaceExecution
    || response.trace?.find(item => item.phase === 'default_failure_learning')?.frontierFallback
    || null;
  const repair = execution?.expressionRepair || null;
  return { spec, response, repair, passedAfter: oracle(spec) };
}

const directRows = cases.map(testCase => run(testCase, clone(active)));
for (const row of directRows) {
  assert.strictEqual(row.passedAfter, true, `${row.spec.id} must pass after repair: ${JSON.stringify({ action: row.response.action, passed: row.response.passed, answer: row.response.answer, repair: row.repair, executionBinding: row.response.executionBinding, trace: row.response.trace }, null, 2)}`);
  assert.strictEqual(row.response.passed, true, `${row.spec.id} must be verified through public inference`);
  assert.strictEqual(row.repair?.learnedRecordId, IDS[row.spec.family], `${row.spec.id} selected the wrong learned primitive`);
  assert.strictEqual(row.repair?.mode, 'retained_declarative_primitive_operator');
  assert.strictEqual(Number(row.response.external_model_calls || 0), 0);
}

const reloaded = JSON.parse(JSON.stringify(active));
for (const testCase of cases) {
  const row = run(testCase, clone(reloaded));
  assert.strictEqual(row.passedAfter, true, `${testCase.id} failed after cold reload`);
  assert.strictEqual(row.repair?.learnedRecordId, IDS[testCase.family]);
}

const ablations = [];
for (const family of Object.keys(IDS)) {
  const ablated = clone(active);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== IDS[family]);
  for (const testCase of cases.filter(item => item.family === family)) {
    const row = run(testCase, clone(ablated));
    assert.strictEqual(row.passedAfter, false, `${testCase.id} must fail when ${IDS[family]} is removed`);
    ablations.push(testCase.id);
  }
}

assert.deepStrictEqual({ active: shaFile(ACTIVE), registry: shaFile(REGISTRY) }, protectedBefore);
console.log(JSON.stringify({
  test: 'lari-cross-domain-workspace-program-transfer',
  passed: true,
  activeHash: protectedBefore.active,
  programs: Object.entries(IDS).map(([family, id]) => ({ family, learnedRecordId: id })),
  hiddenTransfer: `${directRows.length}/${directRows.length}`,
  coldReload: `${cases.length}/${cases.length}`,
  exactRecordAblation: `${ablations.length}/${cases.length}`,
  languages: ['javascript', 'python'],
  publicPath: 'sendMessageToLari -> runLariUnifiedTaskKernel -> runFrontierCodingRepairLoop',
  activeReadOnly: true,
  registryReadOnly: true,
  externalModelCalls: 0
}, null, 2));
