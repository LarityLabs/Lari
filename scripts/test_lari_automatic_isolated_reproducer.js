#!/usr/bin/env node
'use strict';

// Proves that the canonical coding loop can derive a bounded isolated
// reproducer from a blocked native harness and declared source/test evidence.
// The generated cases are transient; only verified reusable repair state may
// be retained by the candidate lifecycle.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-auto-reproducer-'));
const write = (relative, content) => {
  const target = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

write('labels/__init__.py', '');
write('labels/slug.py', [
  'def slug_key(value):',
  '    return str(value).strip()',
  ''
].join('\n'));
write('tests/native_suite.py', [
  'import retired_test_harness',
  'from labels.slug import slug_key',
  '',
  'assert slug_key("Blue Sky!") == "blue-sky"',
  'assert slug_key("Cache_Key") == "cache-key"',
  ''
].join('\n'));

const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const result = runtime.runFrontierCodingRepairLoop(clone(require(ACTIVE)), 'The blocked Python harness hides a text normalization bug. Repair slug_key to produce lowercase hyphen-separated text from the declared examples, without changing the test oracle.', {
  workspaceRoot: workspace,
  tests: ['tests/native_suite.py'],
  expressionTarget: 'labels/slug.py',
  testRunner: 'python.pytest',
  autoIsolatedReproducer: true,
  allowExpressionOperatorDiscovery: true,
  allowSemanticOperatorDiscovery: true,
  coordinatedProgramSearch: true,
  maxIterations: 3,
  expressionCandidateLimit: 64,
  modelHash: protectedBefore.active,
  sourcePath: 'scripts/test_lari_automatic_isolated_reproducer.js',
  taskTimeoutMs: 120000
});

try {
  const isolated = result.diagnostic?.isolatedReproducerEvidence;
  assert(result.baselineTaxonomy?.nativeFailureClasses?.includes('environment_failure'), 'native harness did not reproduce an environment failure');
  assert.strictEqual(isolated?.attempted, true, 'automatic isolated reproducer was not attempted');
  assert.strictEqual(isolated?.accepted, true, 'automatic isolated reproducer was not accepted as behavioral');
  assert.strictEqual(isolated?.developmentalEvidenceOnly, true, 'isolated result was not marked developmental');
  assert(/^sha256:[a-f0-9]{64}$/.test(isolated.descriptorHash), 'descriptor provenance hash missing');
  assert(isolated.path.startsWith('.lari-test-tmp/lari-isolated-'), 'isolated path escaped the bounded temporary area');
  assert.strictEqual(result.runnerVerification?.baselineFailureObserved, true, 'isolated behavioral baseline was not adopted');
  assert.strictEqual(result.runnerVerification?.oracleImmutable, true, 'test oracle was not immutable');
  assert.strictEqual(shaFile(ACTIVE), protectedBefore.active, 'active model changed');
  assert.strictEqual(shaFile(REGISTRY), protectedBefore.registry, 'registry changed');
  const evidence = {
    test: 'lari-automatic-isolated-reproducer',
    passed: true,
    nativeFailureClasses: result.baselineTaxonomy.nativeFailureClasses,
    isolatedReproducer: isolated,
    repaired: result.passed,
    runnerEvidenceGrade: result.runnerVerification.evidenceGrade,
    activeModelReadOnly: true,
    registryReadOnly: true,
    externalModelCalls: 0
  };
  const evidenceDir = path.join(ROOT, 'consolidation', 'automatic-isolated-reproducer-20260906');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
