#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const BASE_PATH = path.join(ROOT, 'consolidation', 'mastery-expansion-20260828', 'candidates', '40eeb1d0ff3a5e76fdf0f94bc22d11abb263e687165f141f468a56c6ba15bd8d.json');
const OUT = path.join(ROOT, 'consolidation', 'mastery-sealed-repository-20260828');
const TRAINING = path.join(OUT, 'training-workspace');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const SEALED = path.join(ROOT, 'consolidation', 'real-repository-acceptance-20260722');

function bytesHash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function fileHash(file) { return bytesHash(fs.readFileSync(file)); }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function immutableJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(bytes)) throw new Error(`Refusing to overwrite immutable artifact: ${rel(file)}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  return bytesHash(bytes);
}
function runPython(workspace) {
  for (const candidate of [path.join(workspace, 'src', '__pycache__'), path.join(workspace, 'tests', '__pycache__')]) {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
  const result = cp.spawnSync('python', ['tests/test_training.py'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  return { passed: result.status === 0, status: result.status, tail: String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-5) };
}

function holdoutSeal() {
  const workspaceMap = JSON.parse(fs.readFileSync(path.join(SEALED, 'workspaces.json'), 'utf8'));
  const click = workspaceMap['pallets__click-sealed-empty-completion'];
  const files = [
    path.join(SEALED, 'instances.json'),
    path.join(SEALED, 'workspaces.json'),
    path.join(click.path, click.testPath),
    path.join(click.path, click.expressionTarget),
    path.join(OUT, 'baseline-report.json')
  ];
  const gitHead = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: click.path, encoding: 'utf8', windowsHide: true });
  const gitStatus = cp.spawnSync('git', ['status', '--short'], { cwd: click.path, encoding: 'utf8', windowsHide: true });
  return {
    schemaVersion: 1,
    kind: 'lari.sealed-repository-holdout-manifest',
    sealedAt: new Date().toISOString(),
    learnerAccess: false,
    learnerReceivedHoldoutContent: false,
    purpose: 'Hash the pre-existing holdout before teaching; no holdout content or metadata is passed into learning.',
    clickWorkspace: { gitHead: gitHead.stdout.trim(), gitStatus: gitStatus.stdout.trim(), clean: !gitStatus.stdout.trim() },
    artifacts: files.map(file => ({ path: rel(file), sha256: fileHash(file), size: fs.statSync(file).size }))
  };
}

function createTrainingWorkspace() {
  fs.rmSync(TRAINING, { recursive: true, force: true });
  write(path.join(TRAINING, 'src', '__init__.py'), 'from .api import normalize\n');
  write(path.join(TRAINING, 'src', 'provider.py'), 'def collect(callback, value):\n    return callback(value)\n');
  write(path.join(TRAINING, 'src', 'normalizer.py'), [
    'from .provider import collect',
    '',
    'def normalize(callback, value):',
    '    results = collect(callback, value)',
    '    if isinstance(results[0], str):',
    '        return [{"value": item} for item in results]',
    '    return results',
    ''
  ].join('\n'));
  write(path.join(TRAINING, 'src', 'api.py'), 'from .normalizer import normalize\n\n__all__ = ["normalize"]\n');
  write(path.join(TRAINING, 'tests', 'test_training.py'), [
    'import os, sys',
    'sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))',
    'from src.api import normalize',
    '',
    'assert normalize(lambda value: [], "x") == []',
    'assert normalize(lambda value: ["a", "b"], "x") == [{"value": "a"}, {"value": "b"}]',
    'items = [{"value": "native"}]',
    'assert normalize(lambda value: items, "x") is items',
    'print("training package verified")',
    ''
  ].join('\n'));
}

function main() {
  const baseBytes = fs.readFileSync(BASE_PATH);
  const baseHash = bytesHash(baseBytes);
  if (baseHash !== path.basename(BASE_PATH, '.json')) throw new Error('Base candidate filename/hash mismatch.');
  const protectedBefore = { base: fileHash(BASE_PATH), active: fileHash(ACTIVE), registry: fileHash(REGISTRY) };
  fs.mkdirSync(OUT, { recursive: true });
  const sealPath = path.join(OUT, 'holdout-seal-manifest.json');
  const seal = fs.existsSync(sealPath) ? JSON.parse(fs.readFileSync(sealPath, 'utf8')) : holdoutSeal();
  immutableJson(sealPath, seal);

  createTrainingWorkspace();
  const before = runPython(TRAINING);
  if (before.passed) throw new Error('Training package must fail before learning.');

  const base = JSON.parse(baseBytes);
  const learningModel = clone(base);
  const baseIds = new Set((base.lariLearnedRecords?.records || []).map(record => record.id));
  const learned = runtime.runLariDefaultFailureLearningPath(learningModel, {
    id: 'mastery.sealed_training.optional_sequence_boundary',
    prompt: 'A public package API crashes when a callback returns an empty optional sequence. Localize the defect from the failing declared test, preserve empty results, preserve string normalization, preserve native objects, prove fail-to-pass, and retain only the reusable procedure.',
    workspaceRoot: TRAINING,
    testPath: 'tests/test_training.py',
    testRunner: 'python.script',
    preserveLayout: true
  }, {
    modelHash: baseHash,
    sourcePath: rel(TRAINING),
    testRunner: 'python.script',
    benchmarkAssociation: [],
    allowExpressionOperatorDiscovery: true,
    allowSemanticOperatorDiscovery: true
  });
  const after = runPython(TRAINING);
  const event = learned.report?.event || {};
  const newRecords = (learningModel.lariLearnedRecords?.records || []).filter(record => !baseIds.has(record.id));
  const record = newRecords.find(item => item.id === event.retainedPatternId);
  if (!learned.report?.passed || !after.passed || !record || event.verificationRule?.exactDeclaredRunnerFailToPass !== true) {
    const failure = { before, after, report: learned.report, newRecordIds: newRecords.map(item => item.id) };
    write(path.join(OUT, 'training-failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
    throw new Error(`Separate-package learning failed; see ${rel(path.join(OUT, 'training-failure.json'))}`);
  }
  if (record.type !== 'operator' || record.payload?.operation !== 'guard_empty_indexed_sequence_access') {
    throw new Error(`Wrong retained intelligence: ${record.type}/${record.payload?.operation}`);
  }

  const candidate = clone(base);
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  candidate.lariLearnedRecords.records = [record, ...candidate.lariLearnedRecords.records.filter(item => item.id !== record.id)];
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: baseHash,
    developmentalEvent: 'sealed_repository_empty_sequence_guard_learning',
    createdAt: new Date().toISOString(),
    promoted: false
  };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = bytesHash(candidateBytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  if (!fs.existsSync(candidatePath)) {
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });
  }
  if (fileHash(candidatePath) !== candidateHash) throw new Error('Immutable candidate verification failed.');
  const candidateText = candidateBytes.toString('utf8').toLowerCase();
  const forbidden = ['pallets__click', 'shell_complete', 'empty_completion', 'src/click/core.py', '.lari-public-tests/test_empty_completion.py'];
  const leakage = forbidden.filter(term => candidateText.includes(term));
  const reload = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const protectedAfter = { base: fileHash(BASE_PATH), active: fileHash(ACTIVE), registry: fileHash(REGISTRY) };
  const gates = {
    holdoutSealedBeforeLearning: seal.learnerAccess === false && seal.clickWorkspace.clean,
    baselineFailed: before.passed === false,
    learnerLocalizedWithoutExpressionTarget: !event.frontierFallback?.expressionRepair?.requestedTarget,
    exactDeclaredRunnerFailToPass: event.verificationRule?.exactDeclaredRunnerFailToPass === true,
    reusableOperatorRetained: record.payload?.operation === 'guard_empty_indexed_sequence_access',
    onlyOneTypedRecordAdded: newRecords.length === 1 && record.type === 'operator',
    reloadRetention: (reload.lariLearnedRecords?.records || []).some(item => item.id === record.id),
    noHoldoutMetadataInCandidate: leakage.length === 0,
    immutableCandidateHash: fileHash(candidatePath) === candidateHash,
    protectedFilesUnchanged: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    externalModelCallsZero: learned.report?.external_model_calls === 0
  };
  const passed = Object.values(gates).every(Boolean);
  const evidence = {
    schemaVersion: 1,
    kind: 'lari.sealed-repository-developmental-learning',
    createdAt: new Date().toISOString(),
    passed,
    candidate: { path: rel(candidatePath), sha256: candidateHash, parentHash: baseHash, promoted: false, learnedRecordIds: [record.id] },
    training: { workspace: rel(TRAINING), before, after, event, learnedRecord: record },
    holdout: { sealManifest: rel(path.join(OUT, 'holdout-seal-manifest.json')), learnerReceivedHoldoutContent: false, leakage },
    gates,
    protectedHashes: { before: protectedBefore, after: protectedAfter },
    externalModelCalls: 0
  };
  write(path.join(OUT, 'training-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  write(path.join(OUT, 'TRAINING_REPORT.md'), [
    '# Lari sealed-repository learning report', '',
    `- Result: **${passed ? 'PASS' : 'FAIL'}**`,
    `- Parent: \`${baseHash}\``,
    `- Candidate: \`${candidateHash}\``,
    `- Learned record: \`${record.id}\``,
    `- Operation: \`${record.payload.operation}\``,
    '- Training source: separate three-module Python package; the historical Click holdout was not supplied to the learner.',
    `- Fail-before/pass-after: ${!before.passed && after.passed ? 'yes' : 'no'}`,
    `- Candidate contains holdout identifiers: ${leakage.length ? leakage.join(', ') : 'no'}`,
    '- Promotion: no; registry current and active model were not modified.', '',
    'This proves one bounded learned invariant. It does not by itself prove arbitrary repository repair or coordinated multi-file editing.', ''
  ].join('\n'));
  process.stdout.write(`${JSON.stringify({ passed, candidate: evidence.candidate, gates, report: rel(path.join(OUT, 'training-evidence.json')) }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main();
