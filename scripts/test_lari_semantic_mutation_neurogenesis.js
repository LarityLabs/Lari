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

function fixture(root, concept, className, accessor, method, amount) {
  const moduleSource = name => [
    `class ${className}:`,
    `    def ${accessor}(self):`,
    `        return "+${amount}"`,
    `    def ${method}(self, values):`,
    '        return [str(value) for value in values]',
    '',
    'def readings(values):',
    `    formatter = ${className}()`,
    `    labels = formatter.${method}(values)`,
    '    return labels',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(root, 'primary.py'), moduleSource('primary'));
  fs.writeFileSync(path.join(root, 'legacy.py'), moduleSource('legacy'));
  fs.writeFileSync(path.join(root, 'test_readings.py'), [
    'from primary import readings as primary_readings',
    'from legacy import readings as legacy_readings',
    '',
    'def test_context_is_restored():',
    `    assert primary_readings([1, 2]) == ["${amount + 1}.0", "${amount + 2}.0"]`,
    `    assert legacy_readings([3]) == ["${amount + 3}.0"]`,
    ''
  ].join('\n'));
  return `Generated readings omit the ${concept} context. Retrieve the missing ${concept} from the formatter and restore the ${concept} into every numeric output. The implementation is primary.py.`;
}

function run(model, root, prompt, discovery) {
  return runtime.runFrontierCodingRepairLoop(model, prompt, {
    workspaceRoot: root,
    tests: [{ path: 'test_readings.py', runner: 'python.pytest', selectors: ['test_readings.py::test_context_is_restored'] }],
    expressionTarget: 'primary.py',
    expressionCandidateLimit: 8,
    mutationCandidateLimit: 4,
    taskTimeoutMs: 60000,
    allowExpressionOperatorDiscovery: false,
    expressionSearch: false,
    allowSemanticOperatorDiscovery: false,
    allowPrimitiveDiscovery: discovery,
    modelHash: shaFile(ACTIVE),
    sourcePath: 'permanent-semantic-mutation-neurogenesis-gate',
    benchmarkAssociation: []
  });
}

function main() {
  const activeBefore = shaFile(ACTIVE);
  const registryBefore = shaFile(REGISTRY);
  const loaded = registry.loadLariModel();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-semantic-mutation-'));
  try {
    const learnRoot = path.join(base, 'learn');
    const transferRoot = path.join(base, 'transfer');
    const reloadRoot = path.join(base, 'reload');
    const ablationRoot = path.join(base, 'ablation');
    [learnRoot, transferRoot, reloadRoot, ablationRoot].forEach(root => fs.mkdirSync(root));
    const learningPrompt = fixture(learnRoot, 'bias', 'BiasFormatter', 'get_bias', 'format_ticks', 100);
    const working = clone(loaded.model);
    const learning = run(working, learnRoot, learningPrompt, true);
    const primitive = (working.lariLearnedRecords?.records || []).find(record =>
      record?.payload?.operation === 'semantic_mutation_primitive'
      && record?.payload?.primitive?.kind === 'context-accessor-output-composition');
    if (process.env.LARI_PRIMITIVE_LEARNING_ONLY) {
      process.stdout.write(`${JSON.stringify({ passed: learning.passed, expressionRepair: learning.expressionRepair, baselineFailureObserved: learning.runnerVerification?.baselineFailureObserved, diagnostic: learning.diagnostic, primitive }, null, 2)}\n`);
      return;
    }

    const transferPrompt = fixture(transferRoot, 'origin', 'OriginRenderer', 'get_origin', 'render_values', 200);
    const transfer = run(working, transferRoot, transferPrompt, false);
    const reloaded = clone(JSON.parse(JSON.stringify(working)));
    const reloadPrompt = fixture(reloadRoot, 'baseline', 'BaselineSerializer', 'get_baseline', 'serialize_values', 300);
    const reload = run(reloaded, reloadRoot, reloadPrompt, false);
    const ablated = clone(reloaded);
    ablated.lariLearnedRecords.records = (ablated.lariLearnedRecords?.records || []).filter(record => record.id !== primitive?.id);
    const ablationPrompt = fixture(ablationRoot, 'origin', 'OriginRenderer', 'get_origin', 'render_values', 200);
    const ablation = run(ablated, ablationRoot, ablationPrompt, false);

    const gates = {
      learningFailToPass: learning.passed === true && learning.expressionRepair?.mode === 'invented_semantic_mutation_primitive',
      typedPrimitiveRetained: primitive?.type === 'operator' && primitive?.status === 'active',
      primitiveStoresNoLocationOrAnswer: primitive?.provenance?.storesSourceCode === false
        && primitive?.provenance?.storesTestAnswers === false
        && !/bias|origin|baseline|primary\.py|100|200|300/i.test(JSON.stringify(primitive?.payload || {})),
      coordinatedTwoFileRepair: learning.expressionRepair?.targets?.length === 2,
      unseenConceptTransfer: transfer.passed === true && transfer.expressionRepair?.mode === 'retained_semantic_mutation_primitive',
      coldReloadTransfer: reload.passed === true && reload.expressionRepair?.mode === 'retained_semantic_mutation_primitive',
      exactAblationRestoresFailure: ablation.passed !== true,
      activeReadOnly: shaFile(ACTIVE) === activeBefore,
      registryReadOnly: shaFile(REGISTRY) === registryBefore,
      externalModelCallsZero: true
    };
    assert(Object.values(gates).every(Boolean), JSON.stringify({ gates, learning: learning.expressionRepair, primitive, transfer: transfer.expressionRepair, reload: reload.expressionRepair, ablation: ablation.expressionRepair }, null, 2));
    process.stdout.write(`${JSON.stringify({
      test: 'lari-semantic-mutation-neurogenesis',
      passed: true,
      gates,
      primitiveId: primitive.id,
      learningConcept: learning.expressionRepair.inferredConcept,
      transferConcept: transfer.expressionRepair.inferredConcept,
      reloadConcept: reload.expressionRepair.inferredConcept,
      externalModelCalls: 0,
      activeHash: activeBefore
    }, null, 2)}\n`);
  } finally {
    const resolved = path.resolve(base);
    assert(resolved.startsWith(path.resolve(os.tmpdir())), 'Refusing to remove a non-temp fixture.');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main();
