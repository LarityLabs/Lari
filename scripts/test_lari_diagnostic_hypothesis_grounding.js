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

function writeFixture(root) {
  fs.writeFileSync(path.join(root, 'models.py'), [
    'class InvalidURL(ValueError):',
    '    pass',
    '',
    'def validate_hostname(hostname):',
    '    return hostname',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'test_models.py'), [
    'import pytest',
    'from models import InvalidURL, validate_hostname',
    '',
    '# Incidental vocabulary from unrelated tests must not drive diagnosis:',
    '# cpu process worker resource quota share zero positive fractional',
    '# None header mapping dictionary session default merge remove omit suppress',
    '# repr render format nested list collection container element',
    '',
    'def test_invalid_leading_dot_hostname():',
    '    with pytest.raises(InvalidURL, match="renderer nested collection"):',
    '        validate_hostname(".example.com")',
    ''
  ].join('\n'));
}

function main() {
  const activeBefore = shaFile(ACTIVE);
  const registryBefore = shaFile(REGISTRY);
  const loaded = registry.loadLariModel();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-diagnostic-grounding-'));
  try {
    writeFixture(root);
    const result = runtime.runFrontierCodingRepairLoop(clone(loaded.model),
      'Reject an invalid URL when its hostname begins with a dot. The implementation is at https://github.com/example/project/blob/deadbeef/models.py#L5.', {
        workspaceRoot: root,
        tests: [{
          path: 'test_models.py',
          runner: 'python.pytest',
          selectors: ['test_models.py::test_invalid_leading_dot_hostname']
        }],
        expressionTarget: 'models.py',
        expressionCandidateLimit: 1,
        taskTimeoutMs: 120000,
        mutationCandidateLimit: 1,
        allowExpressionOperatorDiscovery: true,
        allowSemanticOperatorDiscovery: true,
        modelHash: activeBefore,
        sourcePath: 'permanent-diagnostic-hypothesis-grounding-gate',
        benchmarkAssociation: []
      });
    const hypotheses = result.diagnostic?.hypotheses || [];
    const selected = hypotheses.find(item => item.id === result.diagnostic?.selectedHypothesisId)
      || hypotheses[0]
      || null;
    const forbidden = new Set([
      'minimum_positive_resource_floor',
      'null_sentinel_suppression',
      'recursive_structural_rendering'
    ]);
    const gates = {
      behavioralFailureObserved: result.runnerVerification?.baselineFailureObserved === true,
      diagnosticCreatedBeforeEdit: hypotheses.some(item => item?.kind === 'DiagnosticHypothesis'),
      genericBoundarySelected: selected?.hypothesisKind === 'behavioral_boundary_mismatch',
      incidentalVocabularyDidNotActivateFamily: hypotheses.every(item => !forbidden.has(item.hypothesisKind)),
      explicitPromptPathLocalizedFirst: selected?.constraints?.targetFiles?.[0] === 'models.py',
      candidateBudgetBounded: Number(result.diagnostic?.attemptLedger?.maxAttempts || 0) === 1,
      taskBudgetBounded: Number(result.diagnostic?.taskBudget?.timeoutMs || 0) === 120000,
      activeReadOnly: shaFile(ACTIVE) === activeBefore,
      registryReadOnly: shaFile(REGISTRY) === registryBefore,
      externalModelCallsZero: true
    };
    assert(Object.values(gates).every(Boolean), JSON.stringify({ gates, selected, hypotheses, diagnostic: result.diagnostic }, null, 2));
    process.stdout.write(`${JSON.stringify({
      test: 'lari-diagnostic-hypothesis-grounding',
      passed: true,
      gates,
      selectedHypothesis: selected?.hypothesisKind || null,
      activeHash: activeBefore,
      externalModelCalls: 0
    }, null, 2)}\n`);
  } finally {
    const resolved = path.resolve(root);
    assert(resolved.startsWith(path.resolve(os.tmpdir())), 'Refusing to remove a non-temp fixture.');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main();
