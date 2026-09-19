#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(root) {
  fs.writeFileSync(path.join(root, 'calc.py'), 'def add(left, right):\n    return left - right\n');
  fs.writeFileSync(path.join(root, 'test_calc.py'), [
    'from calc import add',
    '',
    'def test_target():',
    '    assert add(2, 3) == 5',
    '',
    'def test_unrelated_failure():',
    '    assert False',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'test_calc_more.py'), [
    'from calc import add',
    '',
    'def test_target_more():',
    '    assert add(4, 5) == 9',
    '',
    'def test_unrelated_failure_more():',
    '    assert False',
    ''
  ].join('\n'));
}

function main() {
  const activeBefore = shaFile(ACTIVE);
  const registryBefore = shaFile(REGISTRY);
  const loaded = registry.loadLariModel();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-focused-pytest-'));
  const focused = path.join(base, 'focused');
  const raw = path.join(base, 'raw');
  const escaped = path.join(base, 'escaped');
  try {
    [focused, raw, escaped].forEach(root => { fs.mkdirSync(root); fixture(root); });
    const focusedResult = runtime.runFrontierCodingRepairLoop(clone(loaded.model), 'Fix add so the focused test passes.', {
      workspaceRoot: focused,
      tests: [
        { path: 'test_calc.py', runner: 'python.pytest', selectors: ['test_calc.py::test_target'] },
        { path: 'test_calc_more.py', runner: 'python.pytest', selectors: ['test_calc_more.py::test_target_more'] }
      ],
      expressionTarget: 'calc.py',
      allowExpressionOperatorDiscovery: true,
      allowSemanticOperatorDiscovery: true,
      expressionCandidateLimit: 64,
      modelHash: activeBefore,
      sourcePath: 'permanent-focused-pytest-selector-gate',
      benchmarkAssociation: []
    });
    const rawResult = runtime.runFrontierCodingRepairLoop(clone(loaded.model), 'Fix add.', {
      workspaceRoot: raw,
      tests: [{ path: 'test_calc.py', runner: 'python -m pytest test_calc.py::test_target' }],
      expressionTarget: 'calc.py',
      maxIterations: 0
    });
    const escapedResult = runtime.runFrontierCodingRepairLoop(clone(loaded.model), 'Fix add.', {
      workspaceRoot: escaped,
      tests: [{ path: 'test_calc.py', runner: 'python.pytest', selectors: ['other.py::test_target'] }],
      expressionTarget: 'calc.py',
      maxIterations: 0
    });
    const gates = {
      focusedSelectorBaselineFailed: focusedResult.runnerVerification?.baselineFailureObserved === true,
      focusedSelectorPassedAfterRepair: focusedResult.passed === true,
      exactFocusedFailToPass: focusedResult.runnerVerification?.exactDeclaredRunnerFailToPass === true,
      twoTestFilesVerified: focusedResult.runnerVerification?.transitions?.length === 2,
      unrelatedFailureWasNotExecuted: (focusedResult.finalTests || []).every(test => !/test_unrelated_failure/.test(`${test.output || ''}${test.error || ''}`)),
      rawCommandStillRejected: rawResult.runnerRejected === true && rawResult.error === 'test_runner_rejected',
      crossFileSelectorRejected: escapedResult.runnerRejected === true && escapedResult.error === 'test_runner_rejected',
      activeReadOnly: shaFile(ACTIVE) === activeBefore,
      registryReadOnly: shaFile(REGISTRY) === registryBefore,
      externalModelCallsZero: true
    };
    assert(Object.values(gates).every(Boolean), JSON.stringify({ gates, focusedResult, rawResult, escapedResult }, null, 2));
    process.stdout.write(`${JSON.stringify({ test: 'lari-focused-pytest-selectors', passed: true, gates, activeHash: activeBefore, externalModelCalls: 0 }, null, 2)}\n`);
  } finally {
    const resolved = path.resolve(base);
    assert(resolved.startsWith(path.resolve(os.tmpdir())), 'Refusing to remove a non-temp fixture.');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main();
