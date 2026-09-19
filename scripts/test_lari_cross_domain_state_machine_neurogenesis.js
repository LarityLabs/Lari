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
const OUT = path.join(ROOT, 'consolidation', 'cross-domain-state-machine-neurogenesis-20260908');
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

function workspaceFixture(language, name, rows, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lari-state-machine-${tag}-`));
  if (language === 'javascript') {
    write(root, 'src/fields.js', `function ${name}(value) {\n  return [value];\n}\nmodule.exports = { ${name} };\n`);
    write(root, 'tests/fields.test.js', `const assert = require('assert');\nconst { ${name} } = require('../src/fields');\n${rows.map(row => `assert.deepStrictEqual(${name}(${JSON.stringify(row.input)}), ${JSON.stringify(row.output)});`).join('\n')}\n`);
    return { root, language, name, rows, target: 'src/fields.js', test: 'tests/fields.test.js', runner: 'javascript.node' };
  }
  write(root, 'src/fields.py', `def ${name}(value):\n    return [value]\n`);
  write(root, 'tests/fields_test.py', `import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom src.fields import ${name}\n${rows.map(row => `assert ${name}(${JSON.stringify(row.input)}) == ${JSON.stringify(row.output)}`).join('\n')}\n`);
  return { root, language, name, rows, target: 'src/fields.py', test: 'tests/fields_test.py', runner: 'python.script' };
}

function oracle(spec) {
  const run = spawnSync(spec.language === 'python' ? 'python' : process.execPath, [spec.test], {
    cwd: spec.root, encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  return run.status === 0;
}

function workspaceRun(model, spec, discover, hash) {
  const before = oracle(spec);
  const oracleHash = shaFile(path.join(spec.root, spec.test));
  const response = runtime.sendMessageToLari(model, {
    id: `state-machine.${spec.name}`,
    mode: 'code', subintent: 'code.fix',
    prompt: `Repair ${spec.name} using stateful escaped delimited field segmentation. Preserve quoted delimiters, decode escaped delimiters, preserve the public signature, and satisfy immutable tests.`,
    workspaceRoot: spec.root, testPath: spec.test, testRunner: spec.runner,
    expressionTarget: spec.target, preserveLayout: true
  }, {
    modelHash: hash, autoGrow: false, groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: {
        maxIterations: 0, modelHash: hash, sourcePath: 'immutable_state_machine_repository_tests', benchmarkAssociation: [],
        allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false,
        allowPrimitiveDiscovery: discover, coordinatedProgramSearch: false
      },
      executionContract: { workspaceExecution: {
        maxIterations: 0, allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false,
        allowPrimitiveDiscovery: discover, coordinatedProgramSearch: false
      } }
    }
  });
  const execution = response.executionBinding?.workspaceExecution
    || response.trace?.find(item => item.phase === 'default_failure_learning')?.frontierFallback
    || null;
  return {
    before,
    after: oracle(spec),
    oracleImmutable: shaFile(path.join(spec.root, spec.test)) === oracleHash,
    response,
    repair: execution?.expressionRepair || null
  };
}

function languageRun(model, input, hash) {
  const prompt = `Inspect structured fields: ${input}`;
  const response = runtime.sendMessageToLari(clone(model), { id: `language.${sha(input).slice(0, 8)}`, prompt }, {
    modelHash: hash, autoGrow: false, groundedFactual: false,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
  const relation = response.languageUnderstanding?.semantics?.semanticRelations?.find(item => item.type === 'structured_segments') || null;
  return { response, relation };
}

const visibleExamples = [
  { input: 'alpha|"beta|gamma"|delta\\|echo', output: ['alpha', 'beta|gamma', 'delta|echo'] },
  { input: 'one|two\\|three|"four|five"', output: ['one', 'two|three', 'four|five'] },
  { input: '"north|west"|south|east', output: ['north|west', 'south', 'east'] }
];
const atomicParents = (parent.lariLearnedRecords?.records || []).filter(record => record?.status === 'active'
  && record?.type === 'operator'
  && ['declarative_primitive_program', 'text_normalization_primitive', 'state_machine_primitive'].includes(record?.payload?.operation));
assert(atomicParents.length > 0, 'the existing atomic vocabulary must be exercised before declaring exhaustion');
const expressingParents = atomicParents.filter(record => {
  const expressesTarget = visibleExamples.every(row => {
    const result = record.payload.operation === 'state_machine_primitive'
      ? neuro.executeStateMachinePrimitive(record.payload.operatorAst, row.input)
      : record.payload.operation === 'text_normalization_primitive'
        ? neuro.executeTextNormalizationPrimitive(record.payload.primitiveAst, row.input)
      : neuro.executeDeclarativePrimitive(record.payload.primitiveAst, row.input);
    return result.passed && JSON.stringify(result.value) === JSON.stringify(row.output);
  });
  return expressesTarget;
});

// This file originally proved neurogenesis before the resulting operator was
// promoted. Once production inherits that capability, repeating the old
// assertion ("the parent must fail") is logically invalid. In production-gate
// mode, prove that the learned operator is executable on fresh variants,
// survives reload, and is causally necessary under family ablation.
if (expressingParents.length) {
  const inheritedCases = [
    { language: 'python', name: 'read_promoted_fields', tag: 'promoted-python', rows: [
      { input: 'amber|"blue|cyan"|green\\|gold', output: ['amber', 'blue|cyan', 'green|gold'] },
      { input: 'api|worker\\|pool|cache', output: ['api', 'worker|pool', 'cache'] }
    ] },
    { language: 'javascript', name: 'decodePromotedFrame', tag: 'promoted-js', rows: [
      { input: 'north|"east|west"|south\\|pole', output: ['north', 'east|west', 'south|pole'] },
      { input: 'build|test\\|smoke|ship', output: ['build', 'test|smoke', 'ship'] }
    ] }
  ];
  const inheritedRows = inheritedCases.map(definition => workspaceRun(
    clone(parent),
    workspaceFixture(definition.language, definition.name, definition.rows, definition.tag),
    false,
    protectedBefore.active
  ));
  const languageRows = inheritedCases.flatMap(definition => definition.rows.map(row => ({
    expected: row.output,
    run: languageRun(parent, row.input, protectedBefore.active)
  })));
  const reloadedRows = inheritedCases.map(definition => workspaceRun(
    clone(JSON.parse(JSON.stringify(parent))),
    workspaceFixture(definition.language, `${definition.name}Reload`, definition.rows, `reload-${definition.tag}`),
    false,
    protectedBefore.active
  ));
  const ablated = clone(parent);
  const expressingIds = new Set(expressingParents.map(record => record.id));
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => !expressingIds.has(record.id));
  const ablationRows = inheritedCases.map(definition => workspaceRun(
    clone(ablated),
    workspaceFixture(definition.language, `${definition.name}Ablated`, definition.rows, `ablation-${definition.tag}`),
    false,
    protectedBefore.active
  ));
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const gates = {
    promotedCapabilityDetected: expressingParents.length > 0,
    freshWorkspaceTransfer: inheritedRows.every(row => row.before === false && row.after === true && row.oracleImmutable),
    ordinaryLanguageBinding: languageRows.every(row => JSON.stringify(row.run.relation?.segmentTexts) === JSON.stringify(row.expected)
      && expressingIds.has(row.run.relation?.operatorRecordId)),
    coldReload: reloadedRows.every(row => row.after === true && row.oracleImmutable),
    familyAblationRestoresFailure: ablationRows.every(row => row.after === false),
    productionReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    externalModelCallsZero: [...inheritedRows, ...reloadedRows, ...ablationRows]
      .every(row => Number(row.response?.external_model_calls || 0) === 0)
  };
  const passed = Object.values(gates).every(Boolean);
  console.log(JSON.stringify({
    test: 'lari-cross-domain-state-machine-production-retention',
    activeHash: protectedBefore.active,
    learnedRecordIds: [...expressingIds],
    freshWorkspaceTransfer: `${inheritedRows.filter(row => row.after).length}/${inheritedRows.length}`,
    ordinaryLanguageBinding: `${languageRows.filter(row => row.run.relation).length}/${languageRows.length}`,
    coldReload: `${reloadedRows.filter(row => row.after).length}/${reloadedRows.length}`,
    familyAblation: `${ablationRows.filter(row => !row.after).length}/${ablationRows.length}`,
    gates,
    passed
  }, null, 2));
  process.exit(passed ? 0 : 1);
}

const baselineSpec = workspaceFixture('javascript', 'decodeStructuredFields', visibleExamples, 'baseline');
const baseline = workspaceRun(clone(parent), baselineSpec, false, protectedBefore.active);
assert.strictEqual(baseline.before, false);
assert.strictEqual(baseline.after, false, 'production parent must fail when discovery is disabled');

const learningSpec = workspaceFixture('javascript', 'decodeStructuredFields', visibleExamples, 'learning');
const candidate = clone(parent);
const parentIds = new Set(candidate.lariLearnedRecords.records.map(record => record.id));
const learning = workspaceRun(candidate, learningSpec, true, protectedBefore.active);
assert.strictEqual(learning.before, false);
assert.strictEqual(learning.after, true, JSON.stringify(learning.repair, null, 2));
assert.strictEqual(learning.repair?.mode, 'synthesized_state_machine_primitive', JSON.stringify(learning.repair));
const learnedRecordId = learning.repair.learnedRecordId;
const gapId = learning.repair.capabilityGapId;
const learnedRecord = candidate.lariLearnedRecords.records.find(record => record.id === learnedRecordId);
const gap = candidate.lariLearnedRecords.records.find(record => record.id === gapId);
assert(learnedRecord && gap && !parentIds.has(learnedRecordId));
assert.strictEqual(learnedRecord.payload.operatorAst.kind, 'lari.state_machine_primitive');
assert.strictEqual(learnedRecord.payload.atomicVocabularyExhausted, true);
assert(visibleExamples.every(row => !JSON.stringify(learnedRecord.payload.operatorAst).includes(row.input)), 'machine must not store example inputs');

const hiddenDefinitions = [
  { language: 'python', name: 'read_manifest_fields', tag: 'python', rows: [
    { input: 'red|"blue|green"|gold\\|silver', output: ['red', 'blue|green', 'gold|silver'] },
    { input: '"api|worker"|cache|db', output: ['api|worker', 'cache', 'db'] },
    { input: 'first|second\\|continued|third', output: ['first', 'second|continued', 'third'] }
  ] },
  { language: 'javascript', name: 'segmentProtocolFrame', tag: 'javascript', rows: [
    { input: 'mars|"jupiter|io"|saturn\\|ring', output: ['mars', 'jupiter|io', 'saturn|ring'] },
    { input: '"left|center"|right|tail', output: ['left|center', 'right', 'tail'] },
    { input: 'build|test\\|smoke|ship', output: ['build', 'test|smoke', 'ship'] }
  ] }
];

const hiddenWorkspaceRows = hiddenDefinitions.map(definition => {
  const spec = workspaceFixture(definition.language, definition.name, definition.rows, `hidden-${definition.tag}`);
  return workspaceRun(clone(candidate), spec, false, 'provisional-state-machine-candidate');
});
hiddenWorkspaceRows.forEach(row => {
  assert.strictEqual(row.before, false);
  assert.strictEqual(row.after, true, JSON.stringify(row.repair));
  assert.strictEqual(row.repair?.mode, 'retained_state_machine_primitive');
  assert.strictEqual(row.repair?.learnedRecordId, learnedRecordId);
  assert.strictEqual(row.oracleImmutable, true);
});

const languageCases = [
  { input: 'red|"blue|green"|gold\\|silver', output: ['red', 'blue|green', 'gold|silver'] },
  { input: '"api|worker"|cache|db', output: ['api|worker', 'cache', 'db'] },
  { input: 'build|test\\|smoke|ship', output: ['build', 'test|smoke', 'ship'] }
];
const parentLanguageRows = languageCases.map(item => languageRun(parent, item.input, protectedBefore.active));
assert(parentLanguageRows.every(row => !row.relation), 'parent must lack the cross-domain structured relation');
const candidateLanguageRows = languageCases.map(item => languageRun(candidate, item.input, 'provisional-state-machine-candidate'));
candidateLanguageRows.forEach((row, index) => {
  assert.deepStrictEqual(row.relation?.segmentTexts, languageCases[index].output);
  assert.strictEqual(row.relation?.operatorRecordId, learnedRecordId);
  assert(row.response.learnedRecordIds.includes(learnedRecordId));
});

const reloaded = JSON.parse(JSON.stringify(candidate));
const reloadWorkspaceRows = hiddenDefinitions.map(definition => {
  const spec = workspaceFixture(definition.language, definition.name, definition.rows, `reload-${definition.tag}`);
  return workspaceRun(clone(reloaded), spec, false, 'reloaded-state-machine-candidate');
});
reloadWorkspaceRows.forEach(row => {
  assert.strictEqual(row.after, true);
  assert.strictEqual(row.repair?.learnedRecordId, learnedRecordId);
});
const reloadLanguageRows = languageCases.map(item => languageRun(reloaded, item.input, 'reloaded-state-machine-candidate'));
reloadLanguageRows.forEach((row, index) => assert.deepStrictEqual(row.relation?.segmentTexts, languageCases[index].output));

const ablated = clone(candidate);
ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== learnedRecordId);
const ablationWorkspaceRows = hiddenDefinitions.map(definition => {
  const spec = workspaceFixture(definition.language, definition.name, definition.rows, `ablation-${definition.tag}`);
  return workspaceRun(clone(ablated), spec, false, 'ablated-state-machine-candidate');
});
assert(ablationWorkspaceRows.every(row => !row.after));
const ablationLanguageRows = languageCases.map(item => languageRun(ablated, item.input, 'ablated-state-machine-candidate'));
assert(ablationLanguageRows.every(row => !row.relation));

const priorProgramChecks = [
  { id: 'lari.learned.operator.neurogenesis.bc535718fcf928bd6ead', input: ['vite', 'eslint', 'vite'], output: ['eslint', 'vite'] },
  { id: 'lari.learned.operator.neurogenesis.2469ea082df026142b03', input: '  ORBIT  ', output: 'orbit-id' },
  { id: 'lari.learned.operator.neurogenesis.31c20239996b13252fa3', input: 11, output: 27 }
].map(item => {
  const record = candidate.lariLearnedRecords.records.find(row => row.id === item.id);
  const result = neuro.executeDeclarativePrimitive(record?.payload?.primitiveAst, item.input);
  return { id: item.id, passed: result.passed && JSON.stringify(result.value) === JSON.stringify(item.output) };
});
assert(priorProgramChecks.every(row => row.passed));

const qualifiedCandidate = clone(parent);
const deterministicTimestamp = '2026-09-08T09:00:00.000Z';
const qualifiedRecord = clone(learnedRecord);
const qualifiedGap = clone(gap);
qualifiedRecord.provenance.importTimestamp = deterministicTimestamp;
qualifiedRecord.provenance.classification = 'qualified_candidate';
qualifiedRecord.provenance.qualificationEvidence = 'consolidation/cross-domain-state-machine-neurogenesis-20260908/qualification.json';
qualifiedGap.provenance.importTimestamp = deterministicTimestamp;
qualifiedGap.payload.createdAt = deterministicTimestamp;
qualifiedCandidate.lariLearnedRecords.records = qualifiedCandidate.lariLearnedRecords.records.filter(record => record.id !== learnedRecordId && record.id !== gapId);
qualifiedCandidate.lariLearnedRecords.records.unshift(qualifiedGap);
const retained = neuro.retainVerifiedCandidate(qualifiedCandidate, qualifiedGap, { learned: true, record: qualifiedRecord }, {
  visible: learning.after && learning.oracleImmutable,
  hiddenTransfer: hiddenWorkspaceRows.every(row => row.after) && candidateLanguageRows.every(row => row.relation),
  semanticFaithfulness: languageCases.every((item, index) => JSON.stringify(candidateLanguageRows[index].relation.segmentTexts) === JSON.stringify(item.output)),
  reload: reloadWorkspaceRows.every(row => row.after) && reloadLanguageRows.every(row => row.relation),
  ablation: ablationWorkspaceRows.every(row => !row.after) && ablationLanguageRows.every(row => !row.relation),
  regressions: priorProgramChecks.filter(row => !row.passed).length,
  externalModelCallsZero: true,
  closedAt: deterministicTimestamp
});
assert.strictEqual(retained.retained, true, retained.reason);
qualifiedCandidate.lineage = {
  ...(qualifiedCandidate.lineage || {}),
  parentHash: protectedBefore.active,
  developmentalEvent: 'cross_domain_state_machine_primitive_neurogenesis',
  sourceGapId: gapId,
  sourceRecordId: learnedRecordId,
  promoted: false,
  createdAt: deterministicTimestamp
};

const bytes = Buffer.from(`${JSON.stringify(qualifiedCandidate, null, 2)}\n`);
const candidateHash = sha(bytes);
const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
if (!fs.existsSync(candidatePath)) fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const gates = {
  absentFromParent: !parentIds.has(learnedRecordId) && atomicParents.every(record => record.payload.operation !== 'state_machine_primitive'),
  parentWorkspaceFailure: !baseline.after,
  parentLanguageDependencyFailure: parentLanguageRows.every(row => !row.relation),
  atomicVocabularyExhausted: learning.repair.atomicVocabularyExhausted === true && learning.repair.atomicProgramAttempts === atomicParents.length,
  transitionTableSynthesized: learnedRecord.payload.operatorAst.kind === 'lari.state_machine_primitive',
  visibleFailToPass: !learning.before && learning.after && learning.oracleImmutable,
  hiddenWorkspaceTransfer: hiddenWorkspaceRows.every(row => row.after && row.repair?.learnedRecordId === learnedRecordId),
  ordinaryLanguageBinding: candidateLanguageRows.every(row => row.relation?.operatorRecordId === learnedRecordId),
  coldReload: reloadWorkspaceRows.every(row => row.after) && reloadLanguageRows.every(row => row.relation),
  exactCrossDomainAblation: ablationWorkspaceRows.every(row => !row.after) && ablationLanguageRows.every(row => !row.relation),
  priorProgramRegressionsZero: priorProgramChecks.every(row => row.passed),
  noExamplesOrSourceStored: learnedRecord.provenance.storesSourceCode === false && learnedRecord.provenance.storesTestAnswers === false && visibleExamples.every(row => !JSON.stringify(learnedRecord.payload.operatorAst).includes(row.input)),
  gapClosedAfterQualification: qualifiedGap.status === 'closed' && qualifiedGap.payload.closedBy?.recordId === learnedRecordId,
  candidateImmutable: shaFile(candidatePath) === candidateHash,
  productionReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
  externalModelCallsZero: [learning.response, ...candidateLanguageRows.map(row => row.response)].every(response => Number(response.external_model_calls || 0) === 0)
};
const qualification = {
  schemaVersion: 1,
  kind: 'lari.cross-domain-state-machine-neurogenesis.qualification',
  createdAt: new Date().toISOString(),
  parentHash: protectedBefore.active,
  candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false },
  learnedRecordId,
  gapId,
  learnedPrimitive: learnedRecord.payload.operatorAst,
  evidence: {
    parentAtomicProgramsAttempted: atomicParents.length,
    visibleExamples: visibleExamples.length,
    hiddenWorkspaceRepositories: hiddenWorkspaceRows.length,
    hiddenWorkspaceCases: hiddenDefinitions.reduce((sum, item) => sum + item.rows.length, 0),
    ordinaryLanguageCases: languageCases.length,
    reloadDependencies: reloadWorkspaceRows.length + reloadLanguageRows.length,
    ablatedDependencies: ablationWorkspaceRows.length + ablationLanguageRows.length,
    priorProgramsChecked: priorProgramChecks.length
  },
  gates,
  passed: Object.values(gates).every(Boolean),
  protectedBefore,
  protectedAfter,
  externalModelCalls: 0,
  limitations: [
    'The synthesized artifact is a generic transition table executed by a developer-authored state-machine interpreter.',
    'This proves one new atomic representation family and two consumer bindings, not unrestricted parser invention.',
    'Workspace proof covers unary string-to-array functions in JavaScript and Python; arbitrary repository mastery remains unproven.'
  ]
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'qualification.json'), `${JSON.stringify(qualification, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Cross-domain state-machine primitive neurogenesis\n\n- Parent production: \`${protectedBefore.active}\`\n- Candidate: \`${candidateHash}\`\n- Learned record: \`${learnedRecordId}\`\n- Promoted: **no**\n- Existing atomic programs exhausted: ${atomicParents.length}/${atomicParents.length}\n- Visible repository fail-to-pass: yes\n- Hidden repository transfer: ${hiddenWorkspaceRows.length}/${hiddenWorkspaceRows.length} repositories, ${qualification.evidence.hiddenWorkspaceCases}/${qualification.evidence.hiddenWorkspaceCases} cases\n- Ordinary language-understanding binding: ${candidateLanguageRows.length}/${candidateLanguageRows.length}\n- Reload dependencies: ${qualification.evidence.reloadDependencies}/${qualification.evidence.reloadDependencies}\n- Exact cross-domain ablations: ${qualification.evidence.ablatedDependencies}/${qualification.evidence.ablatedDependencies}\n- Prior declarative regressions: 0/${priorProgramChecks.length}\n- External model calls: 0\n- Production mutation: none\n\nLari synthesized a finite-state transition table for escaped, quoted delimiter segmentation after its existing atomic programs could not express the required string-to-structure behavior. The same typed operator repaired unseen JavaScript/Python repositories and produced structured semantic relations during ordinary public inference.\n\nThe interpreter and synthesis search space remain developer-authored. This is one qualified primitive family, not unrestricted parser or repository mastery.\n\n**Verdict: ${qualification.passed ? 'Qualified non-promoted candidate' : 'Qualification failed'}**\n`);
assert(qualification.passed, JSON.stringify(gates, null, 2));
console.log(JSON.stringify({ passed: true, parentHash: protectedBefore.active, candidateHash, learnedRecordId, machineHash: learnedRecord.payload.operatorAst.programSha256, atomicProgramsExhausted: `${atomicParents.length}/${atomicParents.length}`, hiddenWorkspaceTransfer: `${hiddenWorkspaceRows.length}/${hiddenWorkspaceRows.length}`, ordinaryLanguageBinding: `${candidateLanguageRows.length}/${candidateLanguageRows.length}`, coldReloadDependencies: qualification.evidence.reloadDependencies, exactAblationDependencies: qualification.evidence.ablatedDependencies, priorProgramRegressions: 0, productionReadOnly: true, externalModelCalls: 0 }, null, 2));
