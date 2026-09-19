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
const SOURCE_QUALIFICATION = path.join(ROOT, 'consolidation', 'general-state-transducer-neurogenesis-20260908', 'qualification.json');
const OUT = path.join(ROOT, 'consolidation', 'symbolic-pushdown-neurogenesis-20260908');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lari-symbolic-stack-${tag}-`));
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
  return family === 'digit_run_abstraction'
    ? 'Replace each run of digits with one hash marker in text. Preserve letters, punctuation, the public signature, and immutable tests.'
    : 'Remove balanced nested bracket regions from text at arbitrary nesting depth. Preserve outside text, the public signature, and immutable tests.';
}

function workspaceRun(model, spec, discover, hash) {
  const before = oracle(spec);
  const oracleHash = shaFile(path.join(spec.root, spec.test));
  const response = runtime.sendMessageToLari(model, {
    id: `symbolic-stack.${spec.family}.${spec.name}`,
    mode: 'code', subintent: 'code.fix', prompt: familyPrompt(spec.family),
    workspaceRoot: spec.root, testPath: spec.test, testRunner: spec.runner,
    expressionTarget: spec.target, preserveLayout: true
  }, {
    modelHash: hash, autoGrow: false, groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: {
        maxIterations: 0, modelHash: hash, sourcePath: 'immutable_symbolic_pushdown_tests', benchmarkAssociation: [],
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
  return { before, after: oracle(spec), oracleImmutable: shaFile(path.join(spec.root, spec.test)) === oracleHash, response, repair: execution?.expressionRepair || null };
}

function languageRun(model, family, input, hash) {
  const prompt = family === 'digit_run_abstraction'
    ? `Replace each run of digits with one hash marker in text: \`${input}\``
    : family === 'nested_bracket_regions'
      ? `Remove nested bracket regions from text: \`${input}\``
      : family === 'bracket_annotations'
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
    id: 'digit_run_abstraction', expectedRepresentation: 'induced_symbolic_finite_state_transducer', visible: [
      { input: 'item123code', output: 'item#code' },
      { input: '99bottles', output: '#bottles' },
      { input: 'a1b22c333', output: 'a#b#c#' },
      { input: 'release-2026.09', output: 'release-#.#' }
    ], hidden: [
      { input: 'v7beta004end', output: 'v#beta#end' },
      { input: '123-start-45-stop', output: '#-start-#-stop' },
      { input: 'no digits here', output: 'no digits here' }
    ]
  },
  {
    id: 'nested_bracket_regions', expectedRepresentation: 'induced_symbolic_pushdown_transducer', visible: [
      { input: 'a[b]c', output: 'ac' },
      { input: 'a[b[c]d]e', output: 'ae' },
      { input: 'a[b[c[d]e]f]g', output: 'ag' },
      { input: 'a[b[c[d[e]f]g]h]i', output: 'ai' },
      { input: 'a[b[c[d[e[f]g]h]i]j]k', output: 'ak' }
    ], hidden: [
      { input: 'before[one[two[three[four[five[six]x]y]z]q]r]after', output: 'beforeafter' },
      { input: 'A[1[Two[3[Four[5]Six]Seven]8]Nine]B', output: 'AB' },
      { input: 'left[a[b]c]middle[d[e[f]g]h]right', output: 'leftmiddleright' }
    ]
  }
];

const candidate = clone(parent);
const sourceRecordIds = new Set(candidate.lariLearnedRecords.records.map(record => record.id));
const learned = [];
for (const family of families) {
  const baselineSpec = workspaceFixture(family.id, 'javascript', `baseline_${family.id}`, family.visible, `baseline-${family.id}`);
  const baseline = workspaceRun(clone(candidate), baselineSpec, false, sourceQualification.candidate.sha256);
  assert.strictEqual(baseline.before, false);
  assert.strictEqual(baseline.after, false, `${family.id} must fail before learning`);

  const learnSpec = workspaceFixture(family.id, 'javascript', `learn_${family.id}`, family.visible, `learn-${family.id}`);
  const acquisition = workspaceRun(candidate, learnSpec, true, sourceQualification.candidate.sha256);
  assert.strictEqual(acquisition.before, false);
  assert.strictEqual(acquisition.after, true, JSON.stringify(acquisition.repair, null, 2));
  assert.strictEqual(acquisition.repair?.mode, 'synthesized_state_machine_primitive');
  assert.strictEqual(acquisition.repair?.representationFamily, family.expectedRepresentation);
  const record = candidate.lariLearnedRecords.records.find(item => item.id === acquisition.repair.learnedRecordId);
  const gap = candidate.lariLearnedRecords.records.find(item => item.id === acquisition.repair.capabilityGapId);
  assert(record && gap && !sourceRecordIds.has(record.id));
  assert.strictEqual(record.payload.operatorAst.representationFamily, family.expectedRepresentation);
  if (family.id === 'digit_run_abstraction') {
    assert(record.payload.operatorAst.charClasses.predicates.some(predicate => predicate.test === 'digit'));
    assert(acquisition.repair.representationAttempts.some(attempt => attempt.kind === 'exact_finite_state' && !attempt.learned));
    assert(acquisition.repair.representationAttempts.some(attempt => attempt.kind === 'symbolic_finite_state' && attempt.learned));
  } else {
    assert.strictEqual(record.payload.operatorAst.memory?.kind, 'stack');
    assert(acquisition.repair.representationAttempts.some(attempt => attempt.kind === 'exact_finite_state' && !attempt.learned));
    assert(acquisition.repair.representationAttempts.some(attempt => attempt.kind === 'symbolic_finite_state' && !attempt.learned));
    assert(acquisition.repair.representationAttempts.some(attempt => attempt.kind === 'symbolic_pushdown' && attempt.learned));
  }
  learned.push({ family, baseline, acquisition, record, gap });
}

const hiddenRows = [];
for (const item of learned) for (const language of ['javascript', 'python']) {
  const spec = workspaceFixture(item.family.id, language, `hidden_${item.family.id}_${language}`, item.family.hidden, `hidden-${item.family.id}-${language}`);
  const result = workspaceRun(clone(candidate), spec, false, 'symbolic-pushdown-developmental');
  assert.strictEqual(result.before, false);
  assert.strictEqual(result.after, true, JSON.stringify(result.repair, null, 2));
  assert.strictEqual(result.repair?.learnedRecordId, item.record.id);
  assert.strictEqual(result.oracleImmutable, true);
  hiddenRows.push({ family: item.family.id, language, ...result });
}

const languageRows = learned.flatMap(item => item.family.hidden.map(row => {
  const result = languageRun(candidate, item.family.id, row.input, 'symbolic-pushdown-developmental');
  assert.strictEqual(result.relation?.transformedText, row.output);
  assert.strictEqual(result.relation?.operatorRecordId, item.record.id);
  return { family: item.family.id, expected: row.output, ...result };
}));

const reloaded = JSON.parse(JSON.stringify(candidate));
const reloadRows = learned.map(item => {
  const spec = workspaceFixture(item.family.id, 'python', `reload_${item.family.id}`, item.family.hidden, `reload-${item.family.id}`);
  const workspace = workspaceRun(clone(reloaded), spec, false, 'reloaded-symbolic-pushdown');
  const language = languageRun(reloaded, item.family.id, item.family.hidden[0].input, 'reloaded-symbolic-pushdown');
  assert.strictEqual(workspace.after, true);
  assert.strictEqual(language.relation?.operatorRecordId, item.record.id);
  return { family: item.family.id, workspace, language };
});

const ablationRows = [];
for (const item of learned) {
  const ablated = clone(candidate);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== item.record.id);
  const other = learned.find(entry => entry.record.id !== item.record.id);
  const spec = workspaceFixture(item.family.id, 'javascript', `ablate_${item.family.id}`, item.family.hidden, `ablate-${item.family.id}`);
  const workspace = workspaceRun(clone(ablated), spec, false, 'ablated-symbolic-pushdown');
  const language = languageRun(ablated, item.family.id, item.family.hidden[0].input, 'ablated-symbolic-pushdown');
  const otherLanguage = languageRun(ablated, other.family.id, other.family.hidden[0].input, 'ablated-symbolic-pushdown');
  assert.strictEqual(workspace.after, false);
  assert.strictEqual(language.relation, null);
  assert.strictEqual(otherLanguage.relation?.operatorRecordId, other.record.id);
  ablationRows.push({ family: item.family.id, workspaceFailed: !workspace.after, languageFailed: !language.relation, otherPreserved: otherLanguage.relation?.operatorRecordId === other.record.id });
}

const priorChecks = [
  { family: 'bracket_annotations', input: 'a[x]b', output: 'ab' },
  { family: 'line_comments', input: 'a#x\nb', output: 'a\nb' }
].map(check => {
  const result = languageRun(candidate, check.family, check.input, 'symbolic-pushdown-developmental');
  return { ...check, passed: result.relation?.transformedText === check.output };
});
assert(priorChecks.every(check => check.passed));

const qualifiedCandidate = clone(parent);
const deterministicTimestamp = '2026-09-08T11:00:00.000Z';
for (const item of learned) {
  const record = clone(item.record);
  const gap = clone(item.gap);
  record.provenance.importTimestamp = deterministicTimestamp;
  record.provenance.classification = 'qualified_candidate';
  record.provenance.qualificationEvidence = 'consolidation/symbolic-pushdown-neurogenesis-20260908/qualification.json';
  gap.provenance.importTimestamp = deterministicTimestamp;
  gap.payload.createdAt = deterministicTimestamp;
  qualifiedCandidate.lariLearnedRecords.records = qualifiedCandidate.lariLearnedRecords.records.filter(existing => existing.id !== record.id && existing.id !== gap.id);
  qualifiedCandidate.lariLearnedRecords.records.unshift(gap);
  const retained = neuro.retainVerifiedCandidate(qualifiedCandidate, gap, { learned: true, record }, {
    visible: item.acquisition.after && item.acquisition.oracleImmutable,
    hiddenTransfer: hiddenRows.filter(row => row.family === item.family.id).every(row => row.after),
    semanticFaithfulness: languageRows.filter(row => row.family === item.family.id).every(row => row.relation?.transformedText === row.expected),
    reload: reloadRows.find(row => row.family === item.family.id)?.workspace.after === true,
    ablation: ablationRows.find(row => row.family === item.family.id)?.workspaceFailed === true && ablationRows.find(row => row.family === item.family.id)?.languageFailed === true,
    regressions: priorChecks.filter(check => !check.passed).length,
    externalModelCallsZero: true, closedAt: deterministicTimestamp
  });
  assert.strictEqual(retained.retained, true, retained.reason);
  item.record = record;
  item.gap = gap;
}
qualifiedCandidate.lineage = {
  ...(qualifiedCandidate.lineage || {}), parentHash: sourceQualification.candidate.sha256,
  developmentalEvent: 'symbolic_predicate_and_pushdown_neurogenesis',
  sourceRecordIds: learned.map(item => item.record.id), promoted: false, createdAt: deterministicTimestamp,
  canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel'
};
const bytes = Buffer.from(`${JSON.stringify(qualifiedCandidate, null, 2)}\n`);
const candidateHash = sha(bytes);
const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
if (!fs.existsSync(candidatePath)) fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const gates = {
  sourceCandidateExact: shaFile(sourceCandidatePath) === sourceQualification.candidate.sha256,
  exactClassFailureThenPredicateInduction: learned[0].acquisition.repair.representationAttempts[0].learned === false && learned[0].record.payload.operatorAst.representationFamily === 'induced_symbolic_finite_state_transducer',
  finiteStateFailureThenPushdownInduction: learned[1].acquisition.repair.representationAttempts.slice(0, 2).every(attempt => !attempt.learned) && learned[1].record.payload.operatorAst.representationFamily === 'induced_symbolic_pushdown_transducer',
  hiddenCrossLanguageTransfer: hiddenRows.length === 4 && hiddenRows.every(row => row.after && row.oracleImmutable),
  ordinaryLanguageBinding: languageRows.length === 6 && languageRows.every(row => row.relation?.transformedText === row.expected),
  exactRecordSelection: languageRows.every(row => row.relation?.operatorRecordId === learned.find(item => item.family.id === row.family).record.id),
  coldReload: reloadRows.every(row => row.workspace.after && row.language.relation),
  independentExactAblation: ablationRows.every(row => row.workspaceFailed && row.languageFailed && row.otherPreserved),
  priorGeneralTransducersPreserved: priorChecks.every(check => check.passed),
  candidateImmutable: shaFile(candidatePath) === candidateHash,
  productionReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
  externalModelCallsZero: [...learned.map(item => item.acquisition.response), ...hiddenRows.map(row => row.response), ...languageRows.map(row => row.response)].every(response => Number(response.external_model_calls || 0) === 0)
};
const qualification = {
  schemaVersion: 1, kind: 'lari.symbolic-predicate-pushdown-neurogenesis.qualification', createdAt: new Date().toISOString(),
  parentCandidate: { path: rel(sourceCandidatePath), sha256: sourceQualification.candidate.sha256 },
  candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false },
  learnedRecords: learned.map(item => ({ family: item.family.id, id: item.record.id, representationFamily: item.record.payload.operatorAst.representationFamily, machineSha256: item.record.payload.operatorAst.programSha256, stateCount: item.record.payload.operatorAst.stateCount, memory: item.record.payload.operatorAst.memory || null })),
  evidence: { newRepresentationFamilies: 2, hiddenRepositories: 4, hiddenCases: 12, languageCases: 6, reloadDependencies: 4, ablationDependencies: 4, priorCapabilitiesChecked: 2 },
  gates, passed: Object.values(gates).every(Boolean), protectedBefore, protectedAfter, externalModelCalls: 0,
  limitations: [
    'The predicate vocabulary, stack interpreter, and bounded program-search algorithm are developer-authored.',
    'Predicate induction currently distinguishes exact punctuation, ASCII digits, uppercase, lowercase, and whitespace.',
    'The pushdown proof covers balanced nested region removal; arbitrary grammars, parsing, and repository mastery remain unproven.'
  ]
};
assert.strictEqual(qualification.passed, true, JSON.stringify(gates, null, 2));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'qualification.json'), `${JSON.stringify(qualification, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Symbolic-predicate and pushdown neurogenesis\n\n- Parent candidate: \`${sourceQualification.candidate.sha256}\`\n- Qualified candidate: \`${candidateHash}\`\n- Promoted: **no**\n- New representation families learned: **2/2**\n- Hidden transfer: **4/4 repositories, 12/12 cases**\n- Ordinary language binding: **6/6**\n- Cold reload: **4/4 dependencies**\n- Independent exact ablation: **4/4 dependencies**\n- Prior general transducers preserved: **2/2**\n- Production remained read-only: **yes**\n- External model calls: **0**\n\nLari first exhausted exact-character finite-state induction and learned a symbolic digit predicate plus a two-state transducer for digit-run abstraction. On the nested task it exhausted both exact and symbolic finite-state representations, then learned a stack-backed symbolic transducer that transferred to nesting deeper than its training cases. Both records execute through the same canonical workspace and language paths.\n\nThe predicate vocabulary, stack machine, and bounded search algorithm remain authored. This is evidence of representation selection and learned stateful programs, not unrestricted grammar induction or arbitrary computation.\n`);
console.log(JSON.stringify({ passed: qualification.passed, parentCandidateHash: sourceQualification.candidate.sha256, candidateHash, learnedRecords: qualification.learnedRecords, hiddenTransfer: '4/4 repositories, 12/12 cases', languageBinding: '6/6', reloadDependencies: 4, ablationDependencies: 4, productionReadOnly: gates.productionReadOnly, externalModelCalls: 0 }, null, 2));
