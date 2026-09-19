#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const neuro = require('../swarm_domain_neurogenesis.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const OUT = path.join(ROOT, 'consolidation', 'workspace-failure-program-neurogenesis-20260908');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const parent = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(language, name, rows, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lari-program-neurogenesis-${tag}-`));
  if (language === 'javascript') {
    write(root, 'src/reference.js', `function ${name}(value) {\n  return value;\n}\nmodule.exports = { ${name} };\n`);
    write(root, 'tests/reference.test.js', `const assert = require('assert');\nconst { ${name} } = require('../src/reference');\n${rows.map(row => `assert.strictEqual(${name}(${JSON.stringify(row.input)}), ${JSON.stringify(row.output)});`).join('\n')}\n`);
    return { root, language, name, rows, target: 'src/reference.js', test: 'tests/reference.test.js', runner: 'javascript.node' };
  }
  write(root, 'src/reference.py', `def ${name}(value):\n    return value\n`);
  write(root, 'tests/reference_test.py', `import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom src.reference import ${name}\n${rows.map(row => `assert ${name}(${JSON.stringify(row.input)}) == ${JSON.stringify(row.output)}`).join('\n')}\n`);
  return { root, language, name, rows, target: 'src/reference.py', test: 'tests/reference_test.py', runner: 'python.script' };
}

function oracle(spec) {
  const run = spawnSync(spec.language === 'python' ? 'python' : process.execPath, [spec.test], {
    cwd: spec.root, encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  return { passed: run.status === 0, status: run.status, outputHash: sha(`${run.stdout || ''}\n${run.stderr || ''}`) };
}

function invoke(model, spec, discover, modelHash) {
  const prompt = `Repair ${spec.name}: trim surrounding whitespace, convert the value to uppercase, and add the REF- prefix. Preserve the public signature and immutable tests.`;
  const response = runtime.sendMessageToLari(model, {
    id: `program-neurogenesis.${spec.name}`,
    mode: 'code', subintent: 'code.fix', prompt,
    workspaceRoot: spec.root, testPath: spec.test, testRunner: spec.runner,
    expressionTarget: spec.target, preserveLayout: true
  }, {
    modelHash, autoGrow: false, groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: {
        maxIterations: 0,
        modelHash,
        sourcePath: 'immutable_repository_tests',
        benchmarkAssociation: [],
        allowExpressionOperatorDiscovery: false,
        allowSemanticOperatorDiscovery: false,
        allowPrimitiveDiscovery: discover,
        coordinatedProgramSearch: false
      },
      executionContract: { workspaceExecution: {
        maxIterations: 0,
        allowExpressionOperatorDiscovery: false,
        allowSemanticOperatorDiscovery: false,
        allowPrimitiveDiscovery: discover,
        coordinatedProgramSearch: false
      } }
    }
  });
  const execution = response.executionBinding?.workspaceExecution
    || response.trace?.find(item => item.phase === 'default_failure_learning')?.frontierFallback
    || null;
  return { response, repair: execution?.expressionRepair || null };
}

function runCase(model, spec, discover, modelHash) {
  const before = oracle(spec);
  const testHash = shaFile(path.join(spec.root, spec.test));
  const sourceBefore = shaFile(path.join(spec.root, spec.target));
  const result = invoke(model, spec, discover, modelHash);
  const after = oracle(spec);
  return {
    before, after, result,
    oracleImmutable: shaFile(path.join(spec.root, spec.test)) === testHash,
    sourceChanged: shaFile(path.join(spec.root, spec.target)) !== sourceBefore
  };
}

const visibleRows = [
  { input: ' alpha ', output: 'REF-ALPHA' },
  { input: 'beta', output: 'REF-BETA' },
  { input: '  Gamma  ', output: 'REF-GAMMA' }
];
const visibleBaseline = fixture('javascript', 'makeReferenceCode', visibleRows, 'visible-baseline');
const baseline = runCase(clone(parent), visibleBaseline, false, protectedBefore.active);
assert.strictEqual(baseline.before.passed, false, 'visible repository must fail before repair');
assert.strictEqual(baseline.after.passed, false, 'incumbent must not solve the absent program with discovery disabled');

const learningSpec = fixture('javascript', 'makeReferenceCode', visibleRows, 'visible-learning');
const candidate = clone(parent);
const parentRecordIds = new Set((candidate.lariLearnedRecords?.records || []).map(record => record.id));
const learning = runCase(candidate, learningSpec, true, protectedBefore.active);
assert.strictEqual(learning.before.passed, false);
assert.strictEqual(learning.after.passed, true, JSON.stringify(learning.result, null, 2));
assert.strictEqual(learning.result.repair?.mode, 'synthesized_declarative_primitive_operator', JSON.stringify(learning.result.repair));
const learnedRecordId = learning.result.repair.learnedRecordId;
const gapId = learning.result.repair.capabilityGapId;
const learnedRecord = candidate.lariLearnedRecords.records.find(record => record.id === learnedRecordId);
const gap = candidate.lariLearnedRecords.records.find(record => record.id === gapId);
assert(learnedRecord && gap, 'runtime must create one typed primitive and its capability gap');
assert(!parentRecordIds.has(learnedRecordId), 'learned record must be absent from production parent');
assert.deepStrictEqual([...learnedRecord.payload.primitiveAst.steps.map(step => step.op)].sort(), ['prefix', 'trim', 'uppercase']);
assert(visibleRows.every(row => !JSON.stringify(learnedRecord.payload.primitiveAst).includes(row.input)), 'primitive AST must not store training inputs');

const hiddenDefinitions = [
  { language: 'python', name: 'canonical_ticket_ref', tag: 'hidden-python', rows: [
    { input: ' delta ', output: 'REF-DELTA' }, { input: 'Epsilon', output: 'REF-EPSILON' }, { input: '  zeta', output: 'REF-ZETA' }
  ] },
  { language: 'javascript', name: 'normalizeBuildReference', tag: 'hidden-js', rows: [
    { input: ' lunar ', output: 'REF-LUNAR' }, { input: 'Solar', output: 'REF-SOLAR' }, { input: '  comet  ', output: 'REF-COMET' }
  ] }
];

const hidden = hiddenDefinitions.map(definition => {
  const spec = fixture(definition.language, definition.name, definition.rows, definition.tag);
  const row = runCase(clone(candidate), spec, false, 'provisional-candidate');
  return { definition, row };
});
for (const item of hidden) {
  assert.strictEqual(item.row.before.passed, false);
  assert.strictEqual(item.row.after.passed, true, `${item.definition.tag} did not transfer`);
  assert.strictEqual(item.row.result.repair?.learnedRecordId, learnedRecordId, `${item.definition.tag} selected the wrong record`);
  assert.strictEqual(item.row.result.repair?.mode, 'retained_declarative_primitive_operator');
}

const reloaded = JSON.parse(JSON.stringify(candidate));
const reloadRows = hiddenDefinitions.map(definition => {
  const spec = fixture(definition.language, definition.name, definition.rows, `${definition.tag}-reload`);
  return runCase(clone(reloaded), spec, false, 'reloaded-provisional-candidate');
});
reloadRows.forEach(row => {
  assert.strictEqual(row.after.passed, true, 'cold-reloaded candidate lost the learned program');
  assert.strictEqual(row.result.repair?.learnedRecordId, learnedRecordId);
});

const ablated = clone(candidate);
ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== learnedRecordId);
const ablationRows = hiddenDefinitions.map(definition => {
  const spec = fixture(definition.language, definition.name, definition.rows, `${definition.tag}-ablation`);
  return runCase(clone(ablated), spec, false, 'ablated-provisional-candidate');
});
ablationRows.forEach(row => assert.strictEqual(row.after.passed, false, 'exact learned-record ablation must restore failure'));

const retainedRegressionPrograms = (parent.lariLearnedRecords?.records || []).filter(record => [
  'lari.learned.operator.neurogenesis.bc535718fcf928bd6ead',
  'lari.learned.operator.neurogenesis.2469ea082df026142b03',
  'lari.learned.operator.neurogenesis.31c20239996b13252fa3'
].includes(record.id));
const regressionExamples = {
  'lari.learned.operator.neurogenesis.bc535718fcf928bd6ead': { input: ['vite', 'eslint', 'vite'], output: ['eslint', 'vite'] },
  'lari.learned.operator.neurogenesis.2469ea082df026142b03': { input: '  ORBIT  ', output: 'orbit-id' },
  'lari.learned.operator.neurogenesis.31c20239996b13252fa3': { input: 11, output: 27 }
};
const regressionRows = retainedRegressionPrograms.map(record => {
  const expected = regressionExamples[record.id];
  const executed = neuro.executeDeclarativePrimitive(record.payload.primitiveAst, expected.input);
  return { id: record.id, passed: executed.passed && JSON.stringify(executed.value) === JSON.stringify(expected.output) };
});
assert.strictEqual(regressionRows.length, 3);
assert(regressionRows.every(row => row.passed), 'an existing declarative family regressed');

candidate.lariLearnedRecords.records = candidate.lariLearnedRecords.records.filter(record => record.id !== learnedRecordId);
const retained = neuro.retainVerifiedCandidate(candidate, gap, { learned: true, record: learnedRecord }, {
  visible: learning.after.passed && learning.oracleImmutable,
  hiddenTransfer: hidden.every(item => item.row.after.passed && item.row.oracleImmutable),
  semanticFaithfulness: visibleRows.every(row => {
    const execution = neuro.executeDeclarativePrimitive(learnedRecord.payload.primitiveAst, row.input);
    return execution.passed && execution.value === row.output;
  }),
  reload: reloadRows.every(row => row.after.passed),
  ablation: ablationRows.every(row => !row.after.passed),
  regressions: regressionRows.filter(row => !row.passed).length,
  externalModelCallsZero: Number(learning.result.response.external_model_calls || 0) === 0
});
assert.strictEqual(retained.retained, true, retained.reason);
learnedRecord.provenance.classification = 'qualified_candidate';
learnedRecord.provenance.qualificationEvidence = 'consolidation/workspace-failure-program-neurogenesis-20260908/qualification.json';
candidate.lineage = {
  ...(candidate.lineage || {}),
  parentHash: protectedBefore.active,
  developmentalEvent: 'workspace_failure_triggered_declarative_program_neurogenesis',
  sourceGapId: gapId,
  sourceRecordId: learnedRecordId,
  promoted: false,
  createdAt: new Date().toISOString()
};

const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
const candidateHash = sha(candidateBytes);
const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
if (!fs.existsSync(candidatePath)) fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });
const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const gates = {
  incumbentFailed: !baseline.after.passed,
  failureTriggeredSynthesis: learning.result.repair?.mode === 'synthesized_declarative_primitive_operator',
  compositionSpaceExhausted: learning.result.repair?.compositionSpaceExhausted === true,
  immutableVisibleOracle: learning.oracleImmutable,
  visibleFailToPass: !learning.before.passed && learning.after.passed,
  hiddenTransfer: hidden.every(item => item.row.after.passed && item.row.result.repair?.learnedRecordId === learnedRecordId),
  coldReload: reloadRows.every(row => row.after.passed && row.result.repair?.learnedRecordId === learnedRecordId),
  exactAblation: ablationRows.every(row => !row.after.passed),
  zeroFamilyRegressions: regressionRows.every(row => row.passed),
  noExamplesOrSourceStored: learnedRecord.provenance.storesSourceCode === false && learnedRecord.provenance.storesTestAnswers === false && visibleRows.every(row => !JSON.stringify(learnedRecord.payload.primitiveAst).includes(row.input)),
  gapClosedOnlyAfterQualification: gap.status === 'closed' && gap.payload.closedBy?.recordId === learnedRecordId,
  immutableCandidate: shaFile(candidatePath) === candidateHash,
  productionReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
  externalModelCallsZero: Number(learning.result.response.external_model_calls || 0) === 0 && hidden.every(item => Number(item.row.result.response.external_model_calls || 0) === 0)
};
const qualification = {
  schemaVersion: 1,
  kind: 'lari.workspace-failure-program-neurogenesis.qualification',
  createdAt: new Date().toISOString(),
  parentHash: protectedBefore.active,
  candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false },
  learnedRecordId, gapId,
  learnedProgram: learnedRecord.payload.primitiveAst,
  evidence: {
    visibleExamples: visibleRows.length,
    hiddenRepositories: hidden.length,
    hiddenCases: hidden.reduce((sum, item) => sum + item.definition.rows.length, 0),
    reloadRepositories: reloadRows.length,
    ablationRepositories: ablationRows.length,
    priorFamiliesChecked: regressionRows.length,
    testAnswersStored: false,
    sourceStored: false
  },
  gates,
  passed: Object.values(gates).every(Boolean),
  protectedBefore,
  protectedAfter,
  externalModelCalls: 0,
  limitations: [
    'This proves autonomous synthesis of one new reusable declarative macro-program from immutable repository examples after retained programs failed.',
    'The program is composed from Lari\'s existing safe atomic operations; it does not invent a new atomic opcode.',
    'The proof covers simple unary string-return repairs in JavaScript and Python, not arbitrary repository mastery.'
  ]
};
fs.mkdirSync(OUT, { recursive: true });
const qualificationPath = path.join(OUT, 'qualification.json');
fs.writeFileSync(qualificationPath, `${JSON.stringify(qualification, null, 2)}\n`);
const report = `# Workspace-failure program neurogenesis\n\n- Parent production hash: \`${protectedBefore.active}\`\n- Qualified candidate hash: \`${candidateHash}\`\n- Learned record: \`${learnedRecordId}\`\n- Promoted: **no**\n- Visible repository: fail before, pass after synthesis\n- Hidden transfer: ${hidden.length}/${hidden.length} repositories, ${qualification.evidence.hiddenCases}/${qualification.evidence.hiddenCases} cases across JavaScript and Python\n- Cold reload: ${reloadRows.length}/${reloadRows.length}\n- Exact record ablation: ${ablationRows.length}/${ablationRows.length} restored failure\n- Existing declarative-family regressions: 0/${regressionRows.length}\n- External model calls: 0\n- Production active model and registry: byte-for-byte unchanged\n\nThe failure exhausted every retained declarative program, extracted three typed behavioral examples from immutable repository tests, synthesized \`trim -> uppercase -> prefix(REF-)\`, independently executed that program, used it to repair the repository, and retained it only after hidden transfer, reload, regression, and ablation qualification.\n\nThis is a real new learned macro-program over Lari's existing safe primitive language. It is not yet evidence that Lari can invent a brand-new atomic opcode or repair arbitrary repositories.\n\n**Verdict: ${qualification.passed ? 'Qualified non-promoted candidate' : 'Qualification failed'}**\n`;
fs.writeFileSync(path.join(OUT, 'REPORT.md'), report);
assert(qualification.passed, JSON.stringify(gates, null, 2));
console.log(JSON.stringify({ passed: true, parentHash: protectedBefore.active, candidateHash, learnedRecordId, learnedProgram: qualification.learnedProgram, hiddenTransfer: `${hidden.length}/${hidden.length}`, coldReload: `${reloadRows.length}/${reloadRows.length}`, exactAblation: `${ablationRows.length}/${ablationRows.length}`, familyRegressions: 0, activeReadOnly: true, registryReadOnly: true, externalModelCalls: 0 }, null, 2));
