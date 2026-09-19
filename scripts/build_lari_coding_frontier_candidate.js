#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'coding-frontier-training-20260828');
const BASE = path.join(ROOT, 'consolidation', 'mastery-sealed-repository-20260828', 'candidates', '5a53e314702053b113e3d3e9a0aa6ee1d553e385a8e5d2dce32bab63e7df54b6.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

function writeWorkspace(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function runPython(root, testPath, options = {}) {
  for (const entry of ['__pycache__', ...(options.preserveIsolatedReproducer ? [] : ['.lari-test-tmp'])]) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  const run = cp.spawnSync('python', [testPath], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { passed: run.status === 0, status: run.status, tail: String(run.stderr || run.stdout || '').trim().split(/\r?\n/).slice(-6) };
}

const lessons = [
  {
    id: 'public-example-isolation',
    operation: 'normalize_text_to_ascii_slug',
    testPath: 'tests/legacy_suite.py',
    expressionTarget: 'text/token.py',
    prompt: 'The legacy test harness cannot import. Build a minimal isolated reproduction from these public examples, repair token_key to produce lowercase hyphen-separated text, and verify it without changing the blocked suite.',
    publicSymbol: { modulePath: 'text/token.py', symbolPath: ['token_key'] },
    publicExamples: [
      { args: ['  Green Tea!  '], comparator: 'equal', expected: 'green-tea' },
      { args: ['Fast_Path'], comparator: 'equal', expected: 'fast-path' }
    ],
    files: {
      'text/__init__.py': '',
      'text/token.py': 'def token_key(value):\n    return str(value).strip()\n',
      'tests/legacy_suite.py': 'import unavailable_old_runner\nfrom text.token import token_key\nassert token_key("Green Tea") == "green-tea"\n'
    }
  },
  {
    id: 'duplicate-body-refactor',
    operation: 'extract_duplicate_python_function_body',
    testPath: 'tests/verify_structure.py',
    expressionTarget: 'tokens/clean.py',
    prompt: 'Refactor the duplicated normalization into the required private helper while preserving public behavior and signatures.',
    files: {
      'tokens/__init__.py': '',
      'tokens/clean.py': 'import re\n\ndef query_token(value):\n    text = str(value).strip().lower()\n    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")\n\ndef cache_token(value):\n    text = str(value).strip().lower()\n    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")\n',
      'tests/verify_structure.py': 'import ast, os, pathlib, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom tokens.clean import query_token, cache_token\nassert query_token("Green Tea") == "green-tea"\nassert cache_token("A/B") == "a-b"\nsource = pathlib.Path("tokens/clean.py").read_text()\nfunctions = {node.name: node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)}\nassert "_canonicalize_token" in functions\nfor name in ("query_token", "cache_token"):\n    assert any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_canonicalize_token" for node in ast.walk(functions[name]))\nprint("training refactor verified")\n'
    }
  },
  {
    id: 'monotonic-two-stub-loop',
    operation: 'bounded_monotonic_stub_completion_loop',
    testPath: 'tests/verify_math.py',
    expressionTarget: 'mathkit/ops.py',
    prompt: 'Complete this bounded long-horizon task. Re-observe after each accepted change, require monotonic failure-count reduction, repair both independent stubs, and stop only when the immutable suite is green.',
    files: {
      'mathkit/__init__.py': '',
      'mathkit/ops.py': 'def subtract_values(left, right):\n    pass\n\ndef divide_values(left, right):\n    pass\n',
      'tests/verify_math.py': 'import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom mathkit.ops import subtract_values, divide_values\nfailures = 0\nfor actual, expected in ((subtract_values(8, 3), 5), (subtract_values(10, 4), 6), (divide_values(8, 2), 4), (divide_values(9, 3), 3)):\n    failures += actual != expected\nprint(f"{failures} failed" if failures else "4 passed")\nraise SystemExit(1 if failures else 0)\n'
    }
  }
];

function responseRepair(response) {
  const selected = response.trace?.find(item => item.phase === 'selected_capability_execution');
  const failure = response.trace?.find(item => item.phase === 'default_failure_learning');
  return selected?.expressionRepair || failure?.frontierFallback?.expressionRepair || response.executionBinding?.workspaceExecution?.expressionRepair || null;
}

function main() {
  const evidencePath = path.join(OUT, 'training-evidence.json');
  if (fs.existsSync(evidencePath)) throw new Error('Coding-frontier training evidence already exists.');
  const baseBytes = fs.readFileSync(BASE);
  const baseHash = sha(baseBytes);
  const protectedBefore = { base: baseHash, active: fileHash(ACTIVE), registry: fileHash(REGISTRY) };
  const base = JSON.parse(baseBytes);
  const model = clone(base);
  const baseIds = new Set((base.lariLearnedRecords?.records || []).map(record => record.id));
  const results = [];
  for (const lesson of lessons) {
    const workspace = path.join(OUT, 'workspaces', lesson.id);
    writeWorkspace(workspace, lesson.files);
    const testHash = fileHash(path.join(workspace, lesson.testPath));
    const before = runPython(workspace, lesson.testPath);
    if (before.passed) throw new Error(`${lesson.id} must fail before training.`);
    const response = runtime.sendMessageToLari(model, {
      id: `coding.frontier.training.${lesson.id}`,
      mode: 'code',
      subintent: 'code.fix',
      prompt: lesson.prompt,
      workspaceRoot: workspace,
      testPath: lesson.testPath,
      testRunner: 'python.script',
      expressionTarget: lesson.expressionTarget,
      ...(lesson.publicExamples ? { publicExamples: lesson.publicExamples, publicSymbol: lesson.publicSymbol } : {}),
      preserveLayout: true
    }, {
      modelHash: baseHash,
      autoGrow: false,
      groundedFactual: false,
      kernel: {
        useBenchmarkSystem: false,
        useCapabilityGraph: true,
        includeTransientDiagnostics: true,
        capabilityGraph: { minScore: 0 },
        chat: { minMemoryScore: 0, minRouteScore: 0 },
        failureLearning: { modelHash: baseHash, sourcePath: rel(workspace), benchmarkAssociation: [], allowExpressionOperatorDiscovery: true, allowSemanticOperatorDiscovery: true, coordinatedProgramSearch: true },
        executionContract: { modelHash: baseHash, sourcePath: rel(workspace), benchmarkAssociation: [], workspaceExecution: { allowExpressionOperatorDiscovery: true, allowSemanticOperatorDiscovery: true, coordinatedProgramSearch: true } }
      }
    });
    const repair = responseRepair(response);
    const isolated = lesson.publicExamples
      ? fs.readdirSync(path.join(workspace, '.lari-test-tmp')).find(name => /^lari-isolated-.*\.py$/.test(name))
      : null;
    const after = lesson.publicExamples
      ? runPython(workspace, path.join('.lari-test-tmp', isolated || 'missing.py'), { preserveIsolatedReproducer: true })
      : runPython(workspace, lesson.testPath);
    results.push({ id: lesson.id, operation: lesson.operation, before, after, responsePassed: response.passed === true, repair, transientDiagnostics: response.passed ? undefined : response.transientDiagnostics, failureTrace: response.passed ? undefined : response.trace?.filter(item => ['selected_capability_execution', 'default_failure_learning'].includes(item.phase)), testOracleUnchanged: fileHash(path.join(workspace, lesson.testPath)) === testHash, externalModelCalls: response.external_model_calls || 0 });
    if (!response.passed || !after.passed || repair?.verified !== true) throw new Error(`${lesson.id} training failed: ${JSON.stringify(results.at(-1), null, 2)}`);
  }
  const newRecords = (model.lariLearnedRecords?.records || []).filter(record => !baseIds.has(record.id));
  const desired = lessons.map(lesson => lesson.operation);
  const learned = newRecords.filter(record => desired.includes(record.payload?.operation));
  if (learned.length !== lessons.length || !desired.every(operation => learned.some(record => record.payload?.operation === operation))) {
    throw new Error(`Expected ${lessons.length} typed frontier records; got ${learned.map(record => record.payload?.operation).join(', ')}`);
  }
  const serialized = JSON.stringify(learned);
  const forbidden = ['green tea', 'fast_path', 'query_token', 'cache_token', 'subtract_values', 'divide_values', 'unavailable_old_runner', 'expected'];
  const leakage = forbidden.filter(term => serialized.toLowerCase().includes(term));
  if (leakage.length) throw new Error(`Learned records retained fixture data: ${leakage.join(', ')}`);
  const candidate = clone(base);
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  candidate.lariLearnedRecords.records = [...learned, ...candidate.lariLearnedRecords.records.filter(record => !learned.some(item => item.id === record.id))];
  candidate.lineage = { ...(candidate.lineage || {}), parentHash: baseHash, developmentalEvent: 'sealed_coding_frontier_training', createdAt: new Date().toISOString(), promoted: false };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha(candidateBytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });
  const reload = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const protectedAfter = { base: fileHash(BASE), active: fileHash(ACTIVE), registry: fileHash(REGISTRY) };
  const gates = {
    threeIndependentLessonsPassed: results.length === 3 && results.every(item => item.responsePassed && item.after.passed),
    exactlyThreeTypedOperatorsAdded: learned.length === 3 && learned.every(record => record.type === 'operator'),
    noFixtureOrExpectedValueRetention: leakage.length === 0,
    reloadRetention: learned.every(record => reload.lariLearnedRecords.records.some(item => item.id === record.id)),
    immutableCandidate: fileHash(candidatePath) === candidateHash,
    protectedFilesUnchanged: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    externalModelCallsZero: results.every(item => item.externalModelCalls === 0)
  };
  const evidence = { schemaVersion: 1, kind: 'lari.coding-frontier.training', createdAt: new Date().toISOString(), passed: Object.values(gates).every(Boolean), candidate: { path: rel(candidatePath), sha256: candidateHash, parentHash: baseHash, promoted: false, learnedRecordIds: learned.map(record => record.id) }, results, learnedRecords: learned, gates, protectedBefore, protectedAfter, externalModelCalls: 0 };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ passed: evidence.passed, candidate: evidence.candidate, lessons: results.map(item => ({ id: item.id, operation: item.operation, mode: item.repair?.mode, steps: item.repair?.steps || null })), gates }, null, 2)}\n`);
  if (!evidence.passed) process.exitCode = 1;
}

main();
