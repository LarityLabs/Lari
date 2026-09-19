#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = registry.currentModelPath;
const REGISTRY = registry.registryPath;
const OUT = path.join(ROOT, 'consolidation', 'one-hour-apprenticeship-sprint-20260913');
const REPORT = path.join(OUT, 'stateful-multifile-acquisition.json');
const BASE_HASH = '259b656bbe85837e620a356b3b6675b6db5f11cd09d4ab7c9b340c33e1412296';
const BASE = path.join(OUT, 'candidates', `${BASE_HASH}.json`);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

if (fs.existsSync(REPORT)) throw new Error('Refusing to overwrite immutable stateful multi-file acquisition report.');
assert.strictEqual(shaFile(BASE), BASE_HASH, 'cumulative candidate hash mismatch');
const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };

function write(root, file, text) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function fixture(language, rows, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lari-stateful-multifile-${tag}-`));
  if (language === 'javascript') {
    write(root, 'lib/annotations.js', 'function stripAnnotations(value) {\n  return value;\n}\nmodule.exports = { stripAnnotations };\n');
    write(root, 'src/batch.js', "const { stripAnnotations } = require('../lib/annotations');\nfunction cleanBatch(values) {\n  return values;\n}\nmodule.exports = { cleanBatch };\n");
    write(root, 'tests/batch.test.js', `const assert=require('assert');\nconst {cleanBatch}=require('../src/batch');\n${rows.map(row => `assert.deepStrictEqual(cleanBatch(${JSON.stringify(row.input)}),${JSON.stringify(row.output)});`).join('\n')}\n`);
    return { root, language, test: 'tests/batch.test.js', runner: 'javascript.node', target: 'src/batch.js' };
  }
  write(root, 'lib/annotations.py', 'def strip_annotations(value):\n    return value\n');
  write(root, 'src/batch.py', 'from lib.annotations import strip_annotations\n\ndef clean_batch(values):\n    return values\n');
  write(root, 'tests/batch_test.py', `import os,sys\nsys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))\nfrom src.batch import clean_batch\n${rows.map(row => `assert clean_batch(${JSON.stringify(row.input)}) == ${JSON.stringify(row.output)}`).join('\n')}\n`);
  return { root, language, test: 'tests/batch_test.py', runner: 'python.script', target: 'src/batch.py' };
}

function oracle(spec) {
  const run = spawnSync(spec.language === 'python' ? 'python' : process.execPath, [spec.test], { cwd: spec.root, encoding: 'utf8', timeout: 15000, windowsHide: true });
  return run.status === 0;
}

function run(model, spec, discover, hash) {
  const before = oracle(spec);
  const testHash = shaFile(path.join(spec.root, spec.test));
  const response = runtime.sendMessageToLari(model, {
    id: `sprint.stateful-multifile.${spec.language}`,
    mode: 'code', subintent: 'code.fix',
    prompt: 'Repair this failing multi-file repository. Remove bracketed annotations from every string through the dependency helper, including nested annotations, then return the transformed collection. Preserve public signatures and immutable tests.',
    workspaceRoot: spec.root, testPath: spec.test, testRunner: spec.runner,
    expressionTarget: spec.target, preserveLayout: true
  }, {
    modelHash: hash, autoGrow: false, groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: {
        maxIterations: 0, modelHash: hash, sourcePath: 'immutable_stateful_multifile_repository', benchmarkAssociation: [],
        allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: discover,
        allowPrimitiveDiscovery: discover, coordinatedProgramSearch: true
      },
      executionContract: { workspaceExecution: {
        maxIterations: 0, allowExpressionOperatorDiscovery: false,
        allowSemanticOperatorDiscovery: discover, allowPrimitiveDiscovery: discover,
        coordinatedProgramSearch: true
      } }
    }
  });
  const execution = response.executionBinding?.workspaceExecution
    || response.trace?.find(item => item.phase === 'default_failure_learning')?.frontierFallback
    || null;
  return { before, after: oracle(spec), oracleImmutable: shaFile(path.join(spec.root, spec.test)) === testHash, response, repair: execution?.expressionRepair || null };
}

const visible = [
  { input: ['alpha[note]beta', '[draft]keep'], output: ['alphabeta', 'keep'] },
  { input: ['one[a[b]c]two', 'plain'], output: ['onetwo', 'plain'] },
  { input: ['x[first]y[second]z'], output: ['xyz'] }
];
const hidden = [
  { input: ['before[private]after', 'left[a[b[c]d]e]right'], output: ['beforeafter', 'leftright'] },
  { input: ['[omit]public', 'unchanged'], output: ['public', 'unchanged'] },
  { input: ['a[one]b[two[deep]]c'], output: ['abc'] }
];

const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
const recordIdsBefore = new Set(base.lariLearnedRecords.records.map(record => record.id));
const baseline = run(clone(base), fixture('javascript', visible, 'baseline'), false, BASE_HASH);
assert(!baseline.before && !baseline.after, `incumbent unexpectedly solved composition: ${JSON.stringify(baseline.repair)}`);

const candidate = clone(base);
const learning = run(candidate, fixture('javascript', visible, 'learning'), true, BASE_HASH);
assert(!learning.before && learning.after && learning.oracleImmutable, JSON.stringify(learning.repair, null, 2));
assert.strictEqual(learning.repair?.mode, 'searched_coordinated_procedure');
const learnedId = learning.repair.learnedRecordId;
const record = candidate.lariLearnedRecords.records.find(item => item.id === learnedId);
assert(record && !recordIdsBefore.has(learnedId), 'new coordinated procedure was not retained');
assert.strictEqual(record.payload.procedureAst.op, 'coordinated_unary_transform');
assert.strictEqual(record.payload.procedureAst.terminal, 'list');
const dependencyId = record.payload.procedureAst.operatorId;
assert(recordIdsBefore.has(dependencyId), 'procedure must compose a pre-existing retained operator');

const transfer = run(clone(candidate), fixture('python', hidden, 'hidden-python'), false, 'stateful-multifile-provisional');
assert(transfer.after && transfer.oracleImmutable && transfer.repair?.learnedRecordId === learnedId, JSON.stringify(transfer.repair, null, 2));
const reload = run(JSON.parse(JSON.stringify(candidate)), fixture('javascript', hidden, 'reload-js'), false, 'stateful-multifile-reload');
assert(reload.after && reload.repair?.learnedRecordId === learnedId, JSON.stringify(reload.repair, null, 2));

const withoutProcedure = clone(candidate);
withoutProcedure.lariLearnedRecords.records = withoutProcedure.lariLearnedRecords.records.filter(item => item.id !== learnedId);
const procedureAblation = run(withoutProcedure, fixture('javascript', hidden, 'ablate-procedure'), false, 'stateful-multifile-ablation');
const withoutDependency = clone(candidate);
withoutDependency.lariLearnedRecords.records = withoutDependency.lariLearnedRecords.records.filter(item => item.id !== dependencyId);
const dependencyAblation = run(withoutDependency, fixture('javascript', hidden, 'ablate-dependency'), false, 'stateful-multifile-dependency-ablation');
assert(!procedureAblation.after && !dependencyAblation.after, 'causal ablation must break the acquired behavior');

record.provenance.classification = 'qualified_candidate';
record.provenance.qualificationEvidence = 'consolidation/one-hour-apprenticeship-sprint-20260913/stateful-multifile-acquisition.json';
candidate.lineage = { ...(candidate.lineage || {}), parentHash: BASE_HASH, developmentalEvent: 'candidate_only_stateful_multifile_composition_acquisition', sourceCandidateHash: BASE_HASH, sourceRecordId: learnedId, promoted: false, createdAt: new Date().toISOString() };
const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
const candidateHash = sha(bytes);
const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };

const retainedIds = [
  'lari.learned.knowledge.dd5dc5557d4a4e7615d12fa1',
  'lari.learned.knowledge.e0a3f6aeba76a4e3b38e450a',
  'lari.learned.operator.neurogenesis.5e479304612371ddb958'
];
const gates = {
  priorCandidateExact: shaFile(BASE) === BASE_HASH,
  incumbentFailed: !baseline.after,
  visibleTwoFileFailToPass: !learning.before && learning.after && learning.repair?.targets?.length === 2,
  newProcedureLearned: !recordIdsBefore.has(learnedId),
  existingStatefulOperatorComposed: recordIdsBefore.has(dependencyId) && record.payload.primitiveDependencies?.includes(dependencyId),
  hiddenPythonTransfer: transfer.after && transfer.repair?.learnedRecordId === learnedId,
  coldReload: reload.after && reload.repair?.learnedRecordId === learnedId,
  exactProcedureAblation: !procedureAblation.after,
  exactDependencyAblation: !dependencyAblation.after,
  cumulativeStateRetained: retainedIds.every(id => candidate.lariLearnedRecords.records.some(record => record.id === id)),
  immutableCandidate: shaFile(candidatePath) === candidateHash,
  activeReadOnly: protectedAfter.active === protectedBefore.active,
  registryReadOnly: protectedAfter.registry === protectedBefore.registry,
  noExternalModelCalls: [learning, transfer, reload].every(item => Number(item.response.external_model_calls || 0) === 0)
};
const report = {
  schemaVersion: 1, createdAt: new Date().toISOString(), kind: 'lari.one-hour-apprenticeship-sprint.stateful-multifile-acquisition',
  parentCandidate: { path: rel(BASE), sha256: BASE_HASH },
  candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false },
  learnedRecordId: learnedId, dependencyRecordId: dependencyId, procedureAst: record.payload.procedureAst,
  evidence: { visibleRepositories: '1/1 JavaScript, 3/3 cases', hiddenTransfer: '1/1 Python, 3/3 cases', reload: '1/1 JavaScript, 3/3 cases', filesChangedPerRepair: 2, causalAblations: '2/2' },
  gates, passed: Object.values(gates).every(Boolean), protectedBefore, protectedAfter, externalModelCalls: 0,
  limitations: [
    'This proves cross-record composition of a retained stateful unary operator with a learned two-file collection procedure, not arbitrary multi-file programming.',
    'The generic helper-consumer composition grammar and interpreters are developer-authored; Lari selected the operator dependency and terminal by executable search.',
    'The candidate remains unpromoted and production is unchanged.'
  ]
};
fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ candidateHash, learnedRecordId: learnedId, dependencyRecordId: dependencyId, procedureAst: record.payload.procedureAst, gates, passed: report.passed }, null, 2));
if (!report.passed) process.exitCode = 1;
