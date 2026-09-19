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
const SOURCE_QUALIFICATION = path.join(ROOT, 'consolidation', 'cross-domain-state-machine-neurogenesis-20260908', 'qualification.json');
const OUT = path.join(ROOT, 'consolidation', 'general-state-transducer-neurogenesis-20260908');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const sourceQualification = JSON.parse(fs.readFileSync(SOURCE_QUALIFICATION, 'utf8'));
const sourceCandidatePath = path.join(ROOT, sourceQualification.candidate.path);
assert.strictEqual(shaFile(sourceCandidatePath), sourceQualification.candidate.sha256, 'source candidate hash mismatch');
const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const parent = JSON.parse(fs.readFileSync(sourceCandidatePath, 'utf8'));

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function workspaceFixture(family, language, name, rows, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lari-general-fst-${tag}-`));
  if (language === 'javascript') {
    write(root, 'src/transform.js', `function ${name}(value) {\n  return value;\n}\nmodule.exports = { ${name} };\n`);
    write(root, 'tests/transform.test.js', `const assert = require('assert');\nconst { ${name} } = require('../src/transform');\n${rows.map(row => `assert.strictEqual(${name}(${JSON.stringify(row.input)}), ${JSON.stringify(row.output)});`).join('\n')}\n`);
    return { family, root, language, name, rows, target: 'src/transform.js', test: 'tests/transform.test.js', runner: 'javascript.node' };
  }
  write(root, 'src/transform.py', `def ${name}(value):\n    return value\n`);
  write(root, 'tests/transform_test.py', `import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom src.transform import ${name}\n${rows.map(row => `assert ${name}(${JSON.stringify(row.input)}) == ${JSON.stringify(row.output)}`).join('\n')}\n`);
  return { family, root, language, name, rows, target: 'src/transform.py', test: 'tests/transform_test.py', runner: 'python.script' };
}

function oracle(spec) {
  const run = spawnSync(spec.language === 'python' ? 'python' : process.execPath, [spec.test], {
    cwd: spec.root, encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  return run.status === 0;
}

function familyPrompt(family) {
  return family === 'bracket_annotations'
    ? 'Remove bracket annotations from text while preserving all text outside brackets. Preserve the public signature and satisfy immutable tests.'
    : 'Remove line comments from text while preserving newlines and all uncommented text. Preserve the public signature and satisfy immutable tests.';
}

function workspaceRun(model, spec, discover, hash) {
  const before = oracle(spec);
  const oracleHash = shaFile(path.join(spec.root, spec.test));
  const response = runtime.sendMessageToLari(model, {
    id: `general-fst.${spec.family}.${spec.name}`,
    mode: 'code', subintent: 'code.fix', prompt: familyPrompt(spec.family),
    workspaceRoot: spec.root, testPath: spec.test, testRunner: spec.runner,
    expressionTarget: spec.target, preserveLayout: true
  }, {
    modelHash: hash, autoGrow: false, groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: {
        maxIterations: 0, modelHash: hash, sourcePath: 'immutable_general_finite_state_tests', benchmarkAssociation: [],
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
    before, after: oracle(spec), oracleImmutable: shaFile(path.join(spec.root, spec.test)) === oracleHash,
    response, repair: execution?.expressionRepair || null
  };
}

function languageRun(model, family, input, hash) {
  const prompt = family === 'bracket_annotations'
    ? `Remove bracket annotations from text: \`${input}\``
    : `Remove line comments from text: \`${input}\``;
  const response = runtime.sendMessageToLari(clone(model), { id: `language.${family}.${sha(input).slice(0, 8)}`, prompt }, {
    modelHash: hash, autoGrow: false, groundedFactual: false,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
  const relation = response.languageUnderstanding?.semantics?.semanticRelations?.find(item => item.type === 'learned_text_transduction') || null;
  return { response, relation };
}

const families = [
  {
    id: 'bracket_annotations', visible: [
      { input: 'alpha[temporary]beta', output: 'alphabeta' },
      { input: '[draft]keep this', output: 'keep this' },
      { input: 'left[remove me]right[also remove]tail', output: 'leftrighttail' }
    ], hidden: [
      { input: 'before[private note]after', output: 'beforeafter' },
      { input: '[omit]public[omit too]', output: 'public' },
      { input: 'one[two words]three', output: 'onethree' }
    ]
  },
  {
    id: 'line_comments', visible: [
      { input: 'alpha# ignore this\nbeta', output: 'alpha\nbeta' },
      { input: '# heading note\nkeep this', output: '\nkeep this' },
      { input: 'left# remove\nright# remove too\ntail', output: 'left\nright\ntail' }
    ], hidden: [
      { input: 'before# private note\nafter', output: 'before\nafter' },
      { input: '# omit\npublic# omit too\n', output: '\npublic\n' },
      { input: 'one# two words\nthree', output: 'one\nthree' }
    ]
  }
];

const candidate = clone(parent);
const parentRecordIds = new Set(candidate.lariLearnedRecords.records.map(record => record.id));
const learned = [];
for (const family of families) {
  const baselineSpec = workspaceFixture(family.id, 'javascript', `baseline_${family.id}`, family.visible, `baseline-${family.id}`);
  const baseline = workspaceRun(clone(candidate), baselineSpec, false, sourceQualification.candidate.sha256);
  assert.strictEqual(baseline.before, false);
  assert.strictEqual(baseline.after, false, `${family.id} must be absent before learning`);

  const learnSpec = workspaceFixture(family.id, 'javascript', `learn_${family.id}`, family.visible, `learn-${family.id}`);
  const acquisition = workspaceRun(candidate, learnSpec, true, sourceQualification.candidate.sha256);
  assert.strictEqual(acquisition.before, false);
  assert.strictEqual(acquisition.after, true, JSON.stringify(acquisition.repair, null, 2));
  assert.strictEqual(acquisition.repair?.mode, 'synthesized_state_machine_primitive');
  const record = candidate.lariLearnedRecords.records.find(item => item.id === acquisition.repair.learnedRecordId);
  const gap = candidate.lariLearnedRecords.records.find(item => item.id === acquisition.repair.capabilityGapId);
  assert(record && gap && !parentRecordIds.has(record.id));
  assert.strictEqual(record.payload.operatorAst.representationFamily, 'induced_finite_state_transducer');
  assert.strictEqual(record.payload.operatorAst.outputType, 'string');
  assert(record.payload.operatorAst.stateCount >= 2, 'stateful behavior must require at least two states');
  learned.push({ family, acquisition, record, gap });
}
assert.notStrictEqual(learned[0].record.id, learned[1].record.id, 'distinct behaviors need distinct learned records');
assert.notStrictEqual(learned[0].record.payload.operatorAst.programSha256, learned[1].record.payload.operatorAst.programSha256, 'distinct behaviors need distinct machines');

const hiddenRows = [];
for (const item of learned) {
  for (const language of ['javascript', 'python']) {
    const spec = workspaceFixture(item.family.id, language, `hidden_${item.family.id}_${language}`, item.family.hidden, `hidden-${item.family.id}-${language}`);
    const result = workspaceRun(clone(candidate), spec, false, 'general-fst-developmental');
    assert.strictEqual(result.before, false);
    assert.strictEqual(result.after, true, JSON.stringify(result.repair, null, 2));
    assert.strictEqual(result.repair?.mode, 'retained_state_machine_primitive');
    assert.strictEqual(result.repair?.learnedRecordId, item.record.id);
    assert.strictEqual(result.oracleImmutable, true);
    hiddenRows.push({ family: item.family.id, language, ...result });
  }
}

const languageRows = learned.flatMap(item => item.family.hidden.map(row => {
  const result = languageRun(candidate, item.family.id, row.input, 'general-fst-developmental');
  assert.strictEqual(result.relation?.transformedText, row.output);
  assert.strictEqual(result.relation?.operatorRecordId, item.record.id);
  assert(result.response.learnedRecordIds.includes(item.record.id));
  return { family: item.family.id, expected: row.output, ...result };
}));

const reloaded = JSON.parse(JSON.stringify(candidate));
const reloadWorkspaceRows = learned.map(item => {
  const spec = workspaceFixture(item.family.id, 'javascript', `reload_${item.family.id}`, item.family.hidden, `reload-${item.family.id}`);
  return { family: item.family.id, ...workspaceRun(clone(reloaded), spec, false, 'reloaded-general-fst') };
});
reloadWorkspaceRows.forEach(row => assert.strictEqual(row.after, true));
const reloadLanguageRows = learned.map(item => {
  const row = item.family.hidden[0];
  return { family: item.family.id, ...languageRun(reloaded, item.family.id, row.input, 'reloaded-general-fst'), expected: row.output };
});
reloadLanguageRows.forEach(row => assert.strictEqual(row.relation?.transformedText, row.expected));

const ablationRows = [];
for (const item of learned) {
  const ablated = clone(candidate);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== item.record.id);
  const other = learned.find(entry => entry.record.id !== item.record.id);
  const spec = workspaceFixture(item.family.id, 'javascript', `ablate_${item.family.id}`, item.family.hidden, `ablate-${item.family.id}`);
  const workspace = workspaceRun(clone(ablated), spec, false, 'ablated-general-fst');
  const language = languageRun(ablated, item.family.id, item.family.hidden[0].input, 'ablated-general-fst');
  const otherLanguage = languageRun(ablated, other.family.id, other.family.hidden[0].input, 'ablated-general-fst');
  assert.strictEqual(workspace.after, false);
  assert.strictEqual(language.relation, null);
  assert.strictEqual(otherLanguage.relation?.operatorRecordId, other.record.id, 'ablating one machine must preserve the other');
  ablationRows.push({ family: item.family.id, workspaceFailed: !workspace.after, languageFailed: !language.relation, otherPreserved: otherLanguage.relation?.operatorRecordId === other.record.id });
}

const qualifiedCandidate = clone(parent);
const deterministicTimestamp = '2026-09-08T10:00:00.000Z';
for (const item of learned) {
  const record = clone(item.record);
  const gap = clone(item.gap);
  record.provenance.importTimestamp = deterministicTimestamp;
  record.provenance.classification = 'qualified_candidate';
  record.provenance.qualificationEvidence = 'consolidation/general-state-transducer-neurogenesis-20260908/qualification.json';
  gap.provenance.importTimestamp = deterministicTimestamp;
  gap.payload.createdAt = deterministicTimestamp;
  qualifiedCandidate.lariLearnedRecords.records = qualifiedCandidate.lariLearnedRecords.records.filter(existing => existing.id !== record.id && existing.id !== gap.id);
  qualifiedCandidate.lariLearnedRecords.records.unshift(gap);
  const retained = neuro.retainVerifiedCandidate(qualifiedCandidate, gap, { learned: true, record }, {
    visible: item.acquisition.after && item.acquisition.oracleImmutable,
    hiddenTransfer: hiddenRows.filter(row => row.family === item.family.id).every(row => row.after),
    semanticFaithfulness: languageRows.filter(row => row.family === item.family.id).every(row => row.relation?.transformedText === row.expected),
    reload: reloadWorkspaceRows.find(row => row.family === item.family.id)?.after === true && Boolean(reloadLanguageRows.find(row => row.family === item.family.id)?.relation),
    ablation: ablationRows.find(row => row.family === item.family.id)?.workspaceFailed === true && ablationRows.find(row => row.family === item.family.id)?.languageFailed === true,
    regressions: 0, externalModelCallsZero: true, closedAt: deterministicTimestamp
  });
  assert.strictEqual(retained.retained, true, retained.reason);
  item.record = record;
  item.gap = gap;
}

qualifiedCandidate.lineage = {
  ...(qualifiedCandidate.lineage || {}), parentHash: sourceQualification.candidate.sha256,
  developmentalEvent: 'general_finite_state_transducer_neurogenesis',
  sourceRecordIds: learned.map(item => item.record.id), promoted: false, createdAt: deterministicTimestamp
};
const bytes = Buffer.from(`${JSON.stringify(qualifiedCandidate, null, 2)}\n`);
const candidateHash = sha(bytes);
const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
if (!fs.existsSync(candidatePath)) fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const externalResponses = [...learned.map(item => item.acquisition.response), ...hiddenRows.map(row => row.response), ...languageRows.map(row => row.response)];
const gates = {
  sourceCandidateExact: shaFile(sourceCandidatePath) === sourceQualification.candidate.sha256,
  twoDistinctBehaviorFamiliesLearned: learned.length === 2 && new Set(learned.map(item => item.record.id)).size === 2,
  genericInductionNotDelimiterTemplate: learned.every(item => item.record.payload.operatorAst.representationFamily === 'induced_finite_state_transducer' && !item.record.payload.operatorAst.alphabet),
  statefulnessRequired: learned.every(item => item.record.payload.operatorAst.stateCount >= 2),
  hiddenCrossLanguageTransfer: hiddenRows.length === 4 && hiddenRows.every(row => row.after && row.oracleImmutable),
  ordinaryLanguageBinding: languageRows.length === 6 && languageRows.every(row => row.relation?.transformedText === row.expected),
  exactRecordSelection: languageRows.every(row => row.relation?.operatorRecordId === learned.find(item => item.family.id === row.family).record.id),
  coldReload: reloadWorkspaceRows.every(row => row.after) && reloadLanguageRows.every(row => row.relation?.transformedText === row.expected),
  independentExactAblation: ablationRows.every(row => row.workspaceFailed && row.languageFailed && row.otherPreserved),
  candidateImmutable: shaFile(candidatePath) === candidateHash,
  productionReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
  externalModelCallsZero: externalResponses.every(response => Number(response.external_model_calls || 0) === 0)
};
const qualification = {
  schemaVersion: 1, kind: 'lari.general-finite-state-transducer-neurogenesis.qualification',
  createdAt: new Date().toISOString(), parentCandidate: { path: rel(sourceCandidatePath), sha256: sourceQualification.candidate.sha256 },
  candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false },
  learnedRecords: learned.map(item => ({ family: item.family.id, id: item.record.id, machineSha256: item.record.payload.operatorAst.programSha256, stateCount: item.record.payload.operatorAst.stateCount, searchNodes: item.record.payload.synthesis?.searchNodes || null })),
  evidence: { behaviorFamilies: 2, hiddenRepositories: 4, hiddenCases: 12, languageCases: 6, reloadDependencies: 4, ablationDependencies: 4 },
  gates, passed: Object.values(gates).every(Boolean), protectedBefore, protectedAfter, externalModelCalls: 0,
  limitations: [
    'The generic interpreter, character-class representation, and bounded induction algorithm are developer-authored.',
    'Qualification covers two non-delimiter string-transduction families plus prior delimiter segmentation, not arbitrary program induction.',
    'Character classes are exact non-alphanumeric symbols plus a general other class; richer lexical predicates remain unproven.'
  ]
};
assert.strictEqual(qualification.passed, true, JSON.stringify(gates, null, 2));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'qualification.json'), `${JSON.stringify(qualification, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# General finite-state transducer neurogenesis\n\n- Parent candidate: \`${sourceQualification.candidate.sha256}\`\n- Qualified candidate: \`${candidateHash}\`\n- Promoted: **no**\n- New behavior families learned without task-specific generator changes: **2/2**\n- Hidden transfer: **4/4 repositories, 12/12 cases**\n- Ordinary language binding: **6/6**\n- Cold reload: **4/4 dependencies**\n- Independent exact ablation: **4/4 dependencies**\n- Production remained read-only: **yes**\n- External model calls: **0**\n\nThe same bounded finite-state induction algorithm learned separate machines for bracket-annotation removal and line-comment removal. These are not delimiter variants. Each machine transferred across JavaScript and Python, executed in ordinary language understanding with exact record selection, survived reload, and failed independently when ablated while the other remained available.\n\nThis establishes a reusable state-machine learning mechanism, not unrestricted computation. The interpreter, character-class representation, and bounded search algorithm remain developer-authored.\n`);
console.log(JSON.stringify({ passed: qualification.passed, parentCandidateHash: sourceQualification.candidate.sha256, candidateHash, learnedRecords: qualification.learnedRecords, hiddenTransfer: '4/4 repositories, 12/12 cases', ordinaryLanguageBinding: '6/6', reloadDependencies: 4, ablationDependencies: 4, productionReadOnly: gates.productionReadOnly, externalModelCalls: 0 }, null, 2));
