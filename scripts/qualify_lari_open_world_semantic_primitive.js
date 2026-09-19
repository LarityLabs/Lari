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
const OUT = path.join(ROOT, 'consolidation', 'open-world-apprenticeship-20260901');
const LEARNING_REPORT = path.join(OUT, 'learning-retry10-report.json');
const candidateArgIndex = process.argv.indexOf('--candidate');
const providedCandidatePath = candidateArgIndex >= 0 ? path.resolve(process.argv[candidateArgIndex + 1] || '') : null;
const primitiveArgIndex = process.argv.indexOf('--primitive');
const providedPrimitiveId = primitiveArgIndex >= 0 ? String(process.argv[primitiveArgIndex + 1] || '') : null;
const reportArgIndex = process.argv.indexOf('--report');
const REPORT = reportArgIndex >= 0
  ? path.resolve(process.argv[reportArgIndex + 1] || '')
  : path.join(OUT, 'semantic-primitive-qualification.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(root, concept, className, accessor, method, amount) {
  const source = [
    `class ${className}:`,
    `    def ${accessor}(self):`,
    `        return "+${amount}"`,
    `    def ${method}(self, values):`,
    '        return [str(value) for value in values]',
    '',
    'def readings(values):',
    `    producer = ${className}()`,
    `    labels = producer.${method}(values)`,
    '    return labels',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(root, 'primary.py'), source);
  fs.writeFileSync(path.join(root, 'legacy.py'), source);
  fs.writeFileSync(path.join(root, 'test_readings.py'), [
    'from primary import readings as primary_readings',
    'from legacy import readings as legacy_readings',
    '',
    'def test_context_transfer():',
    `    assert primary_readings([1, 2]) == ["${amount + 1}.0", "${amount + 2}.0"]`,
    `    assert legacy_readings([3]) == ["${amount + 3}.0"]`,
    ''
  ].join('\n'));
  return `Generated readings omit the ${concept} context. Retrieve the missing ${concept} from the output producer and restore the ${concept} into every numeric output. The implementation is primary.py.`;
}

function test(root) {
  const result = spawnSync('python', ['-m', 'pytest', '-q', '--maxfail=1', 'test_readings.py::test_context_transfer'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true
  });
  return { passed: result.status === 0, exitCode: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.slice(-4000) };
}

function run(model, modelHash, root, prompt, id) {
  const before = test(root);
  const response = runtime.sendMessageToLari(model, {
    id,
    mode: 'code',
    subintent: 'code.fix',
    prompt,
    workspaceRoot: root,
    testPath: 'test_readings.py',
    testRunner: 'python.pytest',
    testSelectors: ['test_readings.py::test_context_transfer'],
    tests: [{ path: 'test_readings.py', runner: 'python.pytest', selectors: ['test_readings.py::test_context_transfer'] }],
    preserveLayout: true,
    expressionTarget: 'primary.py'
  }, {
    modelHash,
    autoGrow: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: {
        modelHash,
        sourcePath: 'semantic-primitive-developmental-transfer-qualification',
        benchmarkAssociation: [],
        allowExpressionOperatorDiscovery: false,
        allowSemanticOperatorDiscovery: false,
        allowPrimitiveDiscovery: false,
        expressionSearch: false,
        expressionCandidateLimit: 4,
        mutationCandidateLimit: 1,
        taskTimeoutMs: 60000
      }
    }
  });
  const after = test(root);
  const event = model.lariDefaultFailureLearning?.events?.[0] || null;
  return {
    id,
    beforePassed: before.passed,
    responsePassed: response?.passed === true,
    afterPassed: after.passed,
    failToPass: before.passed === false && response?.passed === true && after.passed === true,
    retainedPatternId: event?.retainedPatternId || null,
    repairKind: event?.frontierFallback?.expressionRepair?.mode || null,
    externalModelCalls: Number(response?.external_model_calls || 0)
  };
}

function main() {
  assert(!fs.existsSync(REPORT), 'Immutable semantic primitive qualification already exists.');
  const learning = read(LEARNING_REPORT);
  const candidateRef = providedCandidatePath ? {
    path: path.relative(ROOT, providedCandidatePath).replace(/\\/g, '/'),
    sha256: shaFile(providedCandidatePath),
    learnedRecordIds: [providedPrimitiveId]
  } : learning.provisionalCandidate;
  assert(candidateRef?.sha256, 'Retry10 did not produce a provisional candidate.');
  const candidatePath = path.join(ROOT, candidateRef.path);
  assert(shaFile(candidatePath) === candidateRef.sha256, 'Candidate hash mismatch.');
  const activeBefore = shaFile(ACTIVE);
  const registryBefore = shaFile(REGISTRY);
  const candidateBefore = shaFile(candidatePath);
  const candidate = read(candidatePath);
  const primitiveId = providedPrimitiveId || candidateRef.learnedRecordIds[0];
  const primitive = candidate.lariLearnedRecords?.records?.find(record => record.id === primitiveId);
  assert(primitive?.payload?.operation === 'semantic_mutation_primitive', 'Candidate primitive missing.');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-semantic-primitive-qualification-'));
  try {
    const originRoot = path.join(base, 'origin');
    const baselineRoot = path.join(base, 'baseline');
    const ablationRoot = path.join(base, 'ablation');
    [originRoot, baselineRoot, ablationRoot].forEach(root => fs.mkdirSync(root));
    const originPrompt = fixture(originRoot, 'origin', 'OriginRenderer', 'get_origin', 'render_values', 200);
    const baselinePrompt = fixture(baselineRoot, 'baseline', 'BaselineSerializer', 'get_baseline', 'serialize_values', 300);
    const ablationPrompt = fixture(ablationRoot, 'origin', 'OriginRenderer', 'get_origin', 'render_values', 200);
    const origin = run(clone(candidate), candidateRef.sha256, originRoot, originPrompt, 'qualification.origin');
    const reloaded = read(candidatePath);
    const baseline = run(reloaded, candidateRef.sha256, baselineRoot, baselinePrompt, 'qualification.baseline.reload');
    const ablated = read(candidatePath);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== primitiveId);
    const ablation = run(ablated, candidateRef.sha256, ablationRoot, ablationPrompt, 'qualification.origin.ablation');
    const gates = {
      exactCandidateHash: shaFile(candidatePath) === candidateRef.sha256,
      sealedLearningFailToPass: learning.passedTasks === 1 && learning.gates?.exactFailToPassAtLeastOne === true,
      typedPrimitivePresent: primitive.type === 'operator' && primitive.status === 'active',
      noStoredSourceOrAnswers: primitive.provenance?.storesSourceCode === false && primitive.provenance?.storesTestAnswers === false,
      unseenOriginTransfer: origin.failToPass && origin.retainedPatternId === primitiveId,
      coldReloadBaselineTransfer: baseline.failToPass && baseline.retainedPatternId === primitiveId,
      exactAblationRestoresFailure: ablation.failToPass === false && ablation.afterPassed === false,
      zeroExternalModelCalls: [origin, baseline, ablation].every(row => row.externalModelCalls === 0),
      productionReadOnly: shaFile(ACTIVE) === activeBefore && shaFile(REGISTRY) === registryBefore,
      candidateReadOnly: shaFile(candidatePath) === candidateBefore
    };
    const passed = Object.values(gates).every(Boolean);
    const report = {
      schemaVersion: 1,
      kind: 'lari.open-world-apprenticeship.semantic-primitive-qualification',
      createdAt: new Date().toISOString(),
      passed,
      verdict: passed ? 'Developmental semantic primitive qualified; external apprenticeship target remains incomplete' : 'Semantic primitive qualification failed',
      candidate: candidateRef,
      primitive: { id: primitiveId, payload: primitive.payload, provenance: primitive.provenance },
      rows: [origin, baseline],
      ablation,
      gates,
      limitations: [
        'The two transfer fixtures are development-authored and are not external repository issues.',
        'Only one sealed unfamiliar repository task has passed; the 6-task target remains unmet.',
        'The candidate is immutable and unpromoted.'
      ]
    };
    fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    assert(passed, JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify({ passed, verdict: report.verdict, candidateHash: candidateRef.sha256, primitiveId, transfer: '2/2', reload: '1/1', ablation: '1/1', externalModelCalls: 0, promoted: false }, null, 2)}\n`);
  } finally {
    const resolved = path.resolve(base);
    assert(resolved.startsWith(path.resolve(os.tmpdir())), 'Refusing to remove non-temp qualification fixtures.');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main();
