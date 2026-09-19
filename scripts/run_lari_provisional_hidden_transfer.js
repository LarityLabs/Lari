'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const runtime = require('../swarm_model_runtime');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE = path.join(ROOT, 'consolidation/open-world-apprenticeship-20260901/provisional-candidates/79a80a4ffceb319dce80d63fab35cd11571905b5b31d7f18d2055256cf57461c.json');
const OUT = path.join(ROOT, 'consolidation/provisional-hidden-transfer-20260905.json');
const RECORD = 'lari.learned.operator.semantic_mutation.b1de2702dd1ace54';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const fileSha = f => sha(fs.readFileSync(f));
const clone = x => JSON.parse(JSON.stringify(x));
const run = root => { const r = cp.spawnSync('python', ['tests/test.py'], { cwd: root, encoding: 'utf8', windowsHide: true }); return { passed: r.status === 0, status: r.status, output: `${r.stdout || ''}${r.stderr || ''}`.slice(-1500) }; };
function makeWorkspace(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lari-hidden-${label}-`));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'fields.py'), 'def classify(parts):\n    if parts[0] == "widget":\n        return True\n    return False\n');
  fs.writeFileSync(path.join(root, 'tests', 'test.py'), 'from src.fields import classify\nassert classify(["widget"]) is True\nassert classify(["gadget"]) is True\n');
  return root;
}
function opts(hash) { return { modelHash: hash, autoGrow: false, groundedFactual: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 }, failureLearning: { modelHash: hash, sourcePath: 'sealed-hidden-transfer-20260905', benchmarkAssociation: [], allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, coordinatedProgramSearch: true }, executionContract: { modelHash: hash, workspaceExecution: { maxIterations: 0, allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, coordinatedProgramSearch: true } } } }; }
function execute(model, hash, label) { const root = makeWorkspace(label); const oracle = fileSha(path.join(root, 'tests/test.py')); const before = run(root); const response = runtime.sendMessageToLari(model, { id: `hidden.${label}`, mode: 'code', subintent: 'code.fix', prompt: 'Repair this unfamiliar predicate-domain bug. Form a diagnostic hypothesis, preserve the declared test, and verify the fail-to-pass repair.', workspaceRoot: root, testPath: 'tests/test.py', testRunner: 'python.script', expressionTarget: 'src/fields.py', preserveLayout: true }, opts(hash)); const after = run(root); const repair = response.trace?.find(x => x.phase === 'default_failure_learning')?.frontierFallback?.expressionRepair || null; const result = { label, before, after, action: response.action, passed: response.passed === true, recordId: repair?.learnedRecordId || null, mode: repair?.mode || null, hypotheses: response.transientDiagnostics?.hypotheses || [], oracleUnchanged: fileSha(path.join(root, 'tests/test.py')) === oracle, externalModelCalls: Number(response.external_model_calls || 0) }; fs.rmSync(root, { recursive: true, force: true }); return result; }
if (fs.existsSync(OUT)) throw new Error('Immutable transfer report already exists.');
const candidateBytes = fs.readFileSync(CANDIDATE); const candidateHash = sha(candidateBytes); const base = JSON.parse(candidateBytes); const activePath = path.join(ROOT, 'models/lari/current/swarm-model.json'); const registryPath = path.join(ROOT, 'models/lari/registry.json'); const protectedBefore = { active: fileSha(activePath), registry: fileSha(registryPath), candidate: candidateHash };
const transfer = execute(clone(base), candidateHash, 'transfer');
const reloadModel = JSON.parse(candidateBytes); const reload = execute(reloadModel, candidateHash, 'reload');
const ablated = clone(base); ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(r => r.id !== RECORD); const ablation = execute(ablated, candidateHash, 'ablation');
const protectedAfter = { active: fileSha(activePath), registry: fileSha(registryPath), candidate: fileSha(CANDIDATE) };
const gates = { baselineFailed: transfer.before.passed === false, transferPass: transfer.passed && transfer.after.passed && transfer.recordId === RECORD, reloadPass: reload.passed && reload.after.passed && reload.recordId === RECORD, exactAblationFails: ablation.passed === false && ablation.after.passed === false, oracleIntegrity: transfer.oracleUnchanged && reload.oracleUnchanged && ablation.oracleUnchanged, noExternalModelCalls: [transfer, reload, ablation].every(x => x.externalModelCalls === 0), productionReadOnly: protectedBefore.active === protectedAfter.active && protectedBefore.registry === protectedAfter.registry, candidateUnchanged: protectedBefore.candidate === protectedAfter.candidate };
const report = { schemaVersion: 1, kind: 'lari.provisional.hidden-transfer', createdAt: new Date().toISOString(), candidate: { path: 'consolidation/open-world-apprenticeship-20260901/provisional-candidates/79a80a4ffceb319dce80d63fab35cd11571905b5b31d7f18d2055256cf57461c.json', sha256: candidateHash }, transfer, reload, ablation, protectedBefore, protectedAfter, gates, passed: Object.values(gates).every(Boolean), verdict: Object.values(gates).every(Boolean) ? 'Hidden transfer qualified; candidate remains unpromoted' : 'Hidden transfer failed; candidate remains unpromoted' };
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }); console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1;
