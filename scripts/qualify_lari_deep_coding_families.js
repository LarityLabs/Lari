#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'deep-coding-qualification-v3-20260829');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const CURRICULUM = path.join(ROOT, 'consolidation', 'deep-chat-coding-expansion-20260829', 'sealed-curriculum.json');
const CHAT_CANDIDATE = path.join(ROOT, 'consolidation', 'deep-chat-coding-expansion-20260829', 'candidates', '28f6b51f83e673ad6df7e39b17feb2024479fc166c7f10e7134b75f4ab534325.json');
const ASYNC_EVIDENCE = path.join(ROOT, 'consolidation', 'async-multifile-curriculum-20260723', 'candidate-evidence.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

function writeWorkspace(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function clearCaches(root, preserveIsolated = false) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const target = path.join(root, entry.name);
    if (entry.name === '__pycache__' || (entry.name === '.lari-test-tmp' && !preserveIsolated)) fs.rmSync(target, { recursive: true, force: true });
    else clearCaches(target, preserveIsolated);
  }
}

function runPython(root, testPath, preserveIsolated = false) {
  clearCaches(root, preserveIsolated);
  const run = cp.spawnSync('python', [testPath], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: root } });
  return { passed: run.status === 0, status: run.status, tail: String(run.stderr || run.stdout || '').trim().split(/\r?\n/).slice(-8) };
}

const specs = [
  {
    family: 'issue_localization', operation: 'guard_empty_indexed_sequence_access', testPath: 'checks/public_api.py',
    prompt: 'Localize the IndexError in this package from the immutable runner. Empty result sequences are valid and must not be indexed, while string results still need adaptation.',
    files: {
      'parcel/__init__.py': 'from .adapter import adapt\n',
      'parcel/source.py': 'def fetch(callback, item):\n    return callback(item)\n',
      'parcel/adapter.py': 'from .source import fetch\n\ndef adapt(callback, item):\n    results = fetch(callback, item)\n    if isinstance(results[0], str):\n        return [{"name": value} for value in results]\n    return results\n',
      'checks/public_api.py': 'from parcel import adapt\nassert adapt(lambda _: [], "x") == []\nassert adapt(lambda _: ["one"], "x") == [{"name": "one"}]\nnative = [{"name": "two"}]\nassert adapt(lambda _: native, "x") is native\nprint("issue localization verified")\n'
    }
  },
  {
    family: 'isolated_test_creation', operation: 'normalize_text_to_ascii_slug', testPath: 'tests/native_suite.py', expressionTarget: 'labels/slug.py',
    prompt: 'The native suite is blocked by a missing legacy harness. Build a minimal isolated reproduction from the public examples, repair slug_key to lowercase hyphen-separated text, and leave the blocked suite unchanged.',
    publicExamples: [{ args: ['  Blue Sky!  '], comparator: 'equal', expected: 'blue-sky' }, { args: ['Cache_Key'], comparator: 'equal', expected: 'cache-key' }],
    publicSymbol: { modulePath: 'labels/slug.py', symbolPath: ['slug_key'] },
    files: { 'labels/__init__.py': '', 'labels/slug.py': 'def slug_key(value):\n    return str(value).strip()\n', 'tests/native_suite.py': 'import retired_test_harness\nfrom labels.slug import slug_key\nassert slug_key("Blue Sky") == "blue-sky"\n' }
  },
  {
    family: 'cross_file_contract', operation: 'coordinated_multi_file_program', recordId: 'lari.learned.operator.coordinated.9f75f432', testPath: 'checks/total.py', expressionTarget: 'ledger/summary.py',
    prompt: 'Repair this failing multi-file contract. Coordinate the eligibility predicate and the consumer total while preserving both public signatures.',
    files: {
      'ledger/__init__.py': '', 'ledger/rules.py': 'def is_billable(row):\n    return False\n',
      'ledger/summary.py': 'from .rules import is_billable\n\ndef billable_total(rows):\n    return 0\n',
      'checks/total.py': 'from ledger.rules import is_billable\nfrom ledger.summary import billable_total\na={"billable": True, "cost": 6}\nb={"billable": False, "cost": 90}\nc={"billable": True, "cost": 5}\nassert is_billable(a) is True\nassert is_billable(b) is False\nassert billable_total([a,b,c]) == 11\nprint("cross-file contract verified")\n'
    }
  },
  {
    family: 'schema_migration', operation: 'thread_public_parameter_to_nested_collaborator', testPath: 'checks/schema.py', expressionTarget: 'codec/model.py',
    prompt: 'Complete the backward-compatible schema migration. The public fill_mode constructor parameter must be validated, retained as state, exposed by get_params, and passed to the nested Codec collaborator.',
    files: {
      'codec/__init__.py': '',
      'codec/model.py': 'class Codec:\n    def __init__(self, strategy="mean", fill_mode=None):\n        self.strategy = strategy\n        self.fill_mode = fill_mode\n\nclass Encoder:\n    _parameter_constraints = {"strategy": [str]}\n\n    def __init__(self, strategy="mean"):\n        self.strategy = strategy\n\n    def get_params(self):\n        return {"strategy": self.strategy}\n\n    def build(self):\n        return Codec(strategy=self.strategy)\n',
      'checks/schema.py': 'from codec.model import Encoder\nmodel = Encoder(fill_mode="missing")\nassert model.fill_mode == "missing"\nassert model.get_params()["fill_mode"] == "missing"\nassert model.build().fill_mode == "missing"\nassert "fill_mode" in model._parameter_constraints\nassert Encoder().fill_mode is None\nprint("schema migration verified")\n'
    }
  },
  {
    family: 'async_lifecycle', operation: 'coordinated_multi_file_program', recordId: 'lari.learned.operator.coordinated.0897464d', testPath: 'tests/async_flow.py', expressionTarget: 'flow/report.py',
    prompt: 'Repair this async multi-file dependency lifecycle across two files. Preserve async signatures, await the dependency helper in its consumer, exclude paused jobs, and return their weights in source order.',
    files: {
      'flow/__init__.py': '', 'flow/source.py': 'async def collect_jobs(jobs):\n    return []\n',
      'flow/report.py': 'from .source import collect_jobs\n\nasync def ready_weights(jobs):\n    return []\n',
      'tests/async_flow.py': 'import asyncio\nfrom flow.source import collect_jobs\nfrom flow.report import ready_weights\nasync def main():\n    a={"paused": False, "weight": 2}\n    b={"paused": True, "weight": 40}\n    c={"paused": False, "weight": 9}\n    assert await collect_jobs([a,b,c]) == [a,c]\n    assert await ready_weights([a,b,c]) == [2,9]\nasyncio.run(main())\nprint("async lifecycle verified")\n'
    }
  },
  {
    family: 'serialization_config', operation: 'suppress_null_sentinels_after_merge', testPath: 'checks/config.py', expressionTarget: 'settings/merge.py',
    prompt: 'Repair configuration serialization after defaults and overrides merge. None is an omission sentinel and must be removed from the complete materialized mapping, not only from the override mapping.',
    files: {
      'settings/__init__.py': '',
      'settings/merge.py': 'def materialize(defaults, overrides):\n    output = dict(defaults)\n    output.update(overrides)\n    for (key, value) in overrides.items():\n        if value is None:\n            del output[key]\n    return output\n',
      'checks/config.py': 'from settings.merge import materialize\nassert materialize({"token": None, "mode": "safe"}, {"tries": 3}) == {"mode": "safe", "tries": 3}\nassert materialize({"a": 1}, {"a": None, "b": 2}) == {"b": 2}\nprint("serialization config verified")\n'
    }
  },
  {
    family: 'dependency_drift', operation: 'widen_concrete_type_check_to_semantic_base', testPath: 'checks/dependency.py', expressionTarget: 'bridge/dispatch.py',
    prompt: 'Adapt to dependency API drift: WidgetPanel is now a supported WidgetBase sibling. Dispatch must accept the semantic base class rather than only concrete Widget.',
    files: {
      'bridge/__init__.py': '',
      'bridge/types.py': 'class WidgetBase: pass\nclass Widget(WidgetBase): pass\nclass WidgetPanel(WidgetBase): pass\n',
      'bridge/dispatch.py': 'from .types import Widget\n\ndef accepts(owner):\n    return isinstance(owner, Widget)\n',
      'checks/dependency.py': 'from bridge.dispatch import accepts\nfrom bridge.types import Widget, WidgetPanel\nassert accepts(Widget()) is True\nassert accepts(WidgetPanel()) is True\nassert accepts(object()) is False\nprint("dependency drift verified")\n'
    }
  },
  {
    family: 'build_toolchain', operation: 'validate_local_reference_against_source_root', testPath: 'checks/references.py', expressionTarget: 'docs/checker.py',
    prompt: 'Repair the local build reference checker. Internal file paths must be resolved under the source root: existing references work, missing references are broken, and no network fallback is allowed.',
    files: {
      'docs/__init__.py': '', 'docs/guide.txt': 'ready\n',
      'docs/checker.py': 'from os import path\n\nclass Builder: pass\n\nclass LinkBuilder(Builder):\n    def __init__(self, srcdir):\n        self.srcdir = srcdir\n\n    def check(self, uri):\n        if uri.startswith(("http:", "https:")):\n            return "remote", "", 0\n        elif not uri.startswith(("http:", "https:")):\n            return "local", "", 0\n',
      'checks/references.py': 'import os\nfrom docs.checker import LinkBuilder\nb=LinkBuilder(os.path.abspath("docs"))\nassert b.check("guide.txt")[0] == "working"\nassert b.check("missing.txt")[0] == "broken"\nassert b.check("../outside.txt")[0] == "broken"\nprint("build references verified")\n'
    }
  },
  {
    family: 'behavior_refactor', operation: 'extract_duplicate_python_function_body', testPath: 'checks/refactor.py', expressionTarget: 'keys/names.py',
    prompt: 'Refactor the duplicated normalization into the required private helper _canonical_name without changing either public behavior or signature.',
    files: {
      'keys/__init__.py': '',
      'keys/names.py': 'import re\n\ndef query_name(value):\n    text = str(value).strip().lower()\n    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")\n\ndef storage_name(value):\n    text = str(value).strip().lower()\n    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")\n',
      'checks/refactor.py': 'import ast, pathlib\nfrom keys.names import query_name, storage_name\nassert query_name(" Red Fox ") == "red-fox"\nassert storage_name("A/B") == "a-b"\ntree=ast.parse(pathlib.Path("keys/names.py").read_text())\nf={n.name:n for n in tree.body if isinstance(n,ast.FunctionDef)}\nassert "_canonical_name" in f\nfor name in ("query_name","storage_name"):\n assert any(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=="_canonical_name" for n in ast.walk(f[name]))\nprint("refactor verified")\n'
    }
  },
  {
    family: 'error_boundaries', operation: 'clamp_positive_resource_count', testPath: 'checks/boundary.py', expressionTarget: 'workers/quota.py',
    prompt: 'Repair this resource boundary condition. A positive fractional CPU quota must never produce zero workers after integer normalization; larger allocations must keep their value.',
    files: {
      'workers/__init__.py': '',
      'workers/quota.py': 'def worker_count(cpu_share, quota):\n    return int(cpu_share / quota)\n',
      'checks/boundary.py': 'from workers.quota import worker_count\nassert worker_count(1, 4) == 1\nassert worker_count(8, 2) == 4\nassert worker_count(3, 2) == 1\nprint("resource boundary verified")\n'
    }
  },
  {
    family: 'multi_defect_relaxation', operation: 'bounded_monotonic_stub_completion_loop', testPath: 'checks/math.py', expressionTarget: 'mathbox/ops.py',
    prompt: 'Repair both independent stubs with progressive constraint relaxation. Re-observe after each accepted edit, require monotonic failure reduction, and roll back any non-improvement.',
    files: {
      'mathbox/__init__.py': '', 'mathbox/ops.py': 'def subtract_amount(left, right):\n    pass\n\ndef divide_amount(left, right):\n    pass\n',
      'checks/math.py': 'from mathbox.ops import subtract_amount, divide_amount\nfailures=0\nfor actual,expected in ((subtract_amount(9,4),5),(subtract_amount(3,8),-5),(divide_amount(8,2),4),(divide_amount(9,3),3)):\n failures += actual != expected\nprint(f"{failures} failed" if failures else "4 passed")\nraise SystemExit(1 if failures else 0)\n'
    }
  },
  {
    family: 'long_horizon_repository', operation: 'bounded_monotonic_stub_completion_loop', testPath: 'checks/verify_pipeline.py', expressionTarget: 'pipeline/stages.py',
    prompt: 'Complete this bounded long-horizon repository repair. Localize all independent failures, add the missing implementations one at a time, re-run the immutable suite after each accepted step, and stop only when green.',
    files: {
      'pipeline/__init__.py': '', 'pipeline/stages.py': 'def add_offset(left, right):\n    pass\n\ndef multiply_scale(left, right):\n    pass\n',
      'checks/verify_pipeline.py': 'from pipeline.stages import add_offset, multiply_scale\nfailures=0\nfor actual,expected in ((add_offset(7,2),9),(add_offset(-2,5),3),(multiply_scale(3,4),12),(multiply_scale(-2,6),-12)):\n failures += actual != expected\nprint(f"{failures} failed" if failures else "4 passed")\nraise SystemExit(1 if failures else 0)\n'
    }
  }
];

function view(response) {
  const selected = response.trace?.find(item => item.phase === 'selected_capability_execution') || null;
  const failure = response.trace?.find(item => item.phase === 'default_failure_learning') || null;
  const execution = response.executionBinding?.workspaceExecution || null;
  const repair = selected?.expressionRepair || failure?.frontierFallback?.expressionRepair || execution?.expressionRepair || null;
  const diagnostics = response.transientDiagnostics || execution?.diagnostic || failure?.frontierFallback?.diagnostic || null;
  return { responsePassed: response.passed === true, modelHash: response.modelHash || null, repair, recordId: repair?.learnedRecordId || response.executionBinding?.appliedOperatorRecordId || null, diagnosticHypotheses: diagnostics?.hypotheses || [], externalModelCalls: response.external_model_calls || 0 };
}

function options(modelHash, family) {
  const shared = { modelHash, sourcePath: `sealed-deep-coding:${family}`, benchmarkAssociation: [], allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, coordinatedProgramSearch: true };
  return { modelHash, autoGrow: false, groundedFactual: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 }, failureLearning: shared, executionContract: { ...shared, workspaceExecution: { maxIterations: 0, allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, coordinatedProgramSearch: true } } } };
}

function execute(spec, model, modelHash, root, prefix) {
  writeWorkspace(root, spec.files);
  const oracle = path.join(root, spec.testPath);
  const oracleHash = fileHash(oracle);
  const before = runPython(root, spec.testPath);
  const response = runtime.sendMessageToLari(model, { id: `${prefix}.${spec.family}`, mode: 'code', subintent: 'code.fix', prompt: spec.prompt, workspaceRoot: root, testPath: spec.testPath, testRunner: 'python.script', ...(spec.expressionTarget ? { expressionTarget: spec.expressionTarget } : {}), ...(spec.publicExamples ? { publicExamples: spec.publicExamples, publicSymbol: spec.publicSymbol } : {}), preserveLayout: true }, options(modelHash, spec.family));
  const result = view(response);
  let isolated = null;
  if (spec.publicExamples) {
    const temp = path.join(root, '.lari-test-tmp');
    isolated = fs.existsSync(temp) ? fs.readdirSync(temp).find(name => /^lari-isolated-.*\.py$/.test(name)) : null;
  }
  const after = isolated ? runPython(root, path.join('.lari-test-tmp', isolated), true) : runPython(root, spec.testPath, true);
  const expectedId = spec.recordId || (model.lariLearnedRecords?.records || []).find(record => record.payload?.operation === spec.operation)?.id || null;
  return { before, after, response: result, expectedRecordId: expectedId, oracleSha256: oracleHash, oracleUnchanged: fileHash(oracle) === oracleHash, diagnosticBeforeEdit: result.diagnosticHypotheses.some(item => item.kind === 'DiagnosticHypothesis'), passed: before.passed === false && after.passed === true && result.responsePassed && result.recordId === expectedId && result.repair?.verified === true && !/^searched_/.test(result.repair?.mode || '') && result.externalModelCalls === 0 && fileHash(oracle) === oracleHash };
}

function main() {
  if (fs.existsSync(OUT)) throw new Error(`Refusing to overwrite immutable qualification namespace ${rel(OUT)}`);
  const protectedBefore = { active: fileHash(ACTIVE), registry: fileHash(REGISTRY), curriculum: fileHash(CURRICULUM), chatCandidate: fileHash(CHAT_CANDIDATE), asyncEvidence: fileHash(ASYNC_EVIDENCE) };
  const curriculum = JSON.parse(fs.readFileSync(CURRICULUM, 'utf8'));
  const asyncEvidence = JSON.parse(fs.readFileSync(ASYNC_EVIDENCE, 'utf8'));
  if (!asyncEvidence.passed || !asyncEvidence.learnedRecord?.id) throw new Error('The sealed async transfer evidence is not qualified.');
  const candidate = JSON.parse(fs.readFileSync(CHAT_CANDIDATE, 'utf8'));
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  const asyncRecord = clone(asyncEvidence.learnedRecord);
  asyncRecord.provenance = { ...asyncRecord.provenance, imported: true, sourceModelHash: asyncEvidence.candidate.sha256, sourcePath: asyncEvidence.candidate.path, originalRecordId: asyncEvidence.learnedRecord.id, creationSource: 'sealed_async_multifile_curriculum_import', importTimestamp: new Date().toISOString(), benchmarkAssociation: [] };
  candidate.lariLearnedRecords.records = [asyncRecord, ...candidate.lariLearnedRecords.records.filter(record => record.id !== asyncRecord.id)];
  const provisionalBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const provisionalHash = sha(provisionalBytes);
  const rows = [];
  for (const spec of specs) {
    const row = execute(spec, clone(candidate), provisionalHash, path.join(OUT, 'workspaces', spec.family), 'deep.coding.transfer');
    const ablated = clone(candidate);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== row.expectedRecordId);
    const ablationRoot = path.join(OUT, 'ablations', spec.family);
    writeWorkspace(ablationRoot, spec.files);
    const sourceNames = Object.keys(spec.files).filter(name => name !== spec.testPath);
    const sourceBefore = Object.fromEntries(sourceNames.map(name => [name, fileHash(path.join(ablationRoot, name))]));
    const ablation = execute(spec, ablated, provisionalHash, ablationRoot, 'deep.coding.ablation');
    const sourceAfter = Object.fromEntries(sourceNames.map(name => [name, fileHash(path.join(ablationRoot, name))]));
    row.ablation = { removedRecordId: row.expectedRecordId, expectedFailureObserved: ablation.passed === false, sourceRollbackExact: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), response: ablation.response };
    row.passed = row.passed && row.diagnosticBeforeEdit && row.ablation.expectedFailureObserved && row.ablation.sourceRollbackExact;
    rows.push({ family: spec.family, operation: spec.operation, ...row });
  }
  candidate.lineage = { ...(candidate.lineage || {}), parentHash: protectedBefore.chatCandidate, developmentalEvent: 'sealed_12_family_coding_qualification_and_async_operator_convergence', sealedCurriculumSha256: protectedBefore.curriculum, sourceCandidateHash: protectedBefore.chatCandidate, importedRecordIds: [asyncRecord.id], qualificationStatus: rows.every(row => row.passed) ? 'passed' : 'failed', promoted: false, createdAt: new Date().toISOString() };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha(candidateBytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });
  fs.chmodSync(candidatePath, 0o444);
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const expectedFamilies = new Set(curriculum.coding.map(item => item.id));
  const protectedAfter = { active: fileHash(ACTIVE), registry: fileHash(REGISTRY), curriculum: fileHash(CURRICULUM), chatCandidate: fileHash(CHAT_CANDIDATE), asyncEvidence: fileHash(ASYNC_EVIDENCE) };
  const gates = {
    twelveOfTwelveQualified: rows.length === 12 && rows.every(row => row.passed),
    sealedFamilyCoverage: rows.every(row => expectedFamilies.has(row.family)) && expectedFamilies.size === 12,
    diagnosticHypothesisBeforeEveryEdit: rows.every(row => row.diagnosticBeforeEdit),
    immutableExternalOracles: rows.every(row => row.oracleUnchanged),
    failBeforePassAfter: rows.every(row => !row.before.passed && row.after.passed),
    retainedCapabilityOnly: rows.every(row => !/^searched_/.test(row.response.repair?.mode || '')),
    causalAblationTwelveOfTwelve: rows.every(row => row.ablation.expectedFailureObserved),
    rollbackTwelveOfTwelve: rows.every(row => row.ablation.sourceRollbackExact),
    reloadRetention: specs.every(spec => (reloaded.lariLearnedRecords?.records || []).some(record => record.id === (spec.recordId || candidate.lariLearnedRecords.records.find(item => item.payload?.operation === spec.operation)?.id))),
    asyncRecordImportedFromQualifiedEvidence: reloaded.lariLearnedRecords.records.some(record => record.id === asyncRecord.id && record.provenance?.sourceModelHash === asyncEvidence.candidate.sha256),
    externalModelCallsZero: rows.every(row => row.response.externalModelCalls === 0),
    candidateImmutable: fileHash(candidatePath) === candidateHash,
    protectedStateReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter)
  };
  const passed = Object.values(gates).every(Boolean);
  const report = { schemaVersion: 1, kind: 'lari.deep-coding-12-family-qualification', createdAt: new Date().toISOString(), passed, sealedCurriculum: { path: rel(CURRICULUM), sha256: protectedBefore.curriculum }, candidate: { path: rel(candidatePath), sha256: candidateHash, parentPath: rel(CHAT_CANDIDATE), parentHash: protectedBefore.chatCandidate, promoted: false, importedRecordIds: [asyncRecord.id] }, score: `${rows.filter(row => row.passed).length}/${rows.length}`, rows, gates, protectedBefore, protectedAfter, limitations: ['Qualification proves twelve fresh Python workspaces; it does not prove every family in every listed language.', 'The async record was imported from its prior sealed JavaScript-to-Python causal transfer proof and re-qualified on a new Python variant.', 'Candidate remains unpromoted.'] };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'qualification-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(OUT, 'QUALIFICATION_REPORT.md'), `# Lari deep coding qualification\n\nCandidate: \`${candidateHash}\` (unpromoted)\n\nSealed family score: **${report.score}**\n\n- Diagnostic hypothesis before edit: **${rows.filter(row => row.diagnosticBeforeEdit).length}/12**\n- Fail-before/pass-after: **${rows.filter(row => !row.before.passed && row.after.passed).length}/12**\n- Causal ablation: **${rows.filter(row => row.ablation.expectedFailureObserved).length}/12**\n- Exact rollback: **${rows.filter(row => row.ablation.sourceRollbackExact).length}/12**\n- External model calls: **0**\n\nVerdict: **${passed ? 'QUALIFIED' : 'FAILED'}**\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ passed, score: report.score, candidate: report.candidate, families: rows.map(row => ({ family: row.family, operation: row.operation, passed: row.passed, recordId: row.response.recordId, mode: row.response.repair?.mode || null, diagnostic: row.diagnosticBeforeEdit, ablation: row.ablation.expectedFailureObserved })), gates }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main();
