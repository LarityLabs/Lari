#!/usr/bin/env node
'use strict';

// Regression proof for the existing diagnostic relaxation loop. This does not
// add a repair strategy or a benchmark corpus: it checks that the canonical
// default failure path actually invokes the already-implemented bounded scopes
// when a target-bound repair is not verified on its first pass.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-progressive-relaxation-'));
const write = (relative, content) => {
  const target = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
const runTest = () => {
  const result = cp.spawnSync(process.execPath, ['tests/test.js'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  return { passed: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
};

write('src/value.js', 'module.exports = { value: () => 0 };\n');
write('tests/test.js', [
  "const assert = require('assert');",
  "const { value } = require('../src/value');",
  'assert.strictEqual(value(), 1);',
  "console.log('value contract verified');"
].join('\n') + '\n');

const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const model = require(ACTIVE);
const before = runTest();
assert.strictEqual(before.passed, false, 'fixture must fail before the repair path');
const learning = runtime.runLariDefaultFailureLearningPath(clone(model), {
  id: 'progressive-relaxation-binding',
  prompt: 'A JavaScript value contract fails in an unfamiliar workspace. Form a diagnostic hypothesis, try the narrow symbol repair first, and widen only after a verified failure. Preserve the declared test and do not edit the test oracle.',
  workspaceRoot: workspace,
  testPath: 'tests/test.js',
  testRunner: 'javascript.node',
  preserveLayout: true
}, {
  modelHash: protectedBefore.active,
  sourcePath: 'scripts/test_lari_default_progressive_relaxation_binding.js',
  testRunner: 'javascript.node',
  allowExpressionOperatorDiscovery: false,
  allowSemanticOperatorDiscovery: false,
  coordinatedProgramSearch: true,
  maxIterations: 3,
  progressiveRelaxation: true,
  taskTimeoutMs: 120000
});
const after = runTest();
const event = learning.report?.event || {};
const frontier = event.frontierFallback || {};
const scopes = frontier.relaxationScopes || [];
const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };

try {
  assert(frontier.attempted === true, 'default path did not invoke the frontier fallback');
  assert(Number(frontier.iterationCount) >= 1, 'diagnostic relaxation loop did not execute');
  assert.strictEqual(scopes[0], 'hypothesis.symbol', 'first pass was not the narrow symbol scope');
  assert(scopes.length <= 3, 'relaxation exceeded the bounded three-pass limit');
  assert.deepStrictEqual(protectedAfter, protectedBefore, 'active model or registry changed');
  assert.strictEqual(fs.readFileSync(path.join(workspace, 'tests/test.js'), 'utf8'), [
    "const assert = require('assert');",
    "const { value } = require('../src/value');",
    'assert.strictEqual(value(), 1);',
    "console.log('value contract verified');"
  ].join('\n') + '\n', 'test oracle was changed');
  const evidence = {
    test: 'lari-default-progressive-relaxation-binding',
    passed: true,
    before,
    after,
    iterationCount: frontier.iterationCount,
    relaxationScopes: scopes,
    activeModelReadOnly: true,
    registryReadOnly: true,
    externalModelCalls: 0
  };
  const evidenceDir = path.join(ROOT, 'consolidation', 'progressive-relaxation-binding-20260906');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
