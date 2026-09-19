'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const runtime = require('../swarm_model_runtime');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'consolidation', `public-researched-repair-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const active = path.join(root, 'models/lari/current/swarm-model.json');
const registry = path.join(root, 'models/lari/registry.json');
const protectedBefore = { active: hash(active), registry: hash(registry) };
const model = JSON.parse(fs.readFileSync(active));
const removedForExperiment = process.argv.includes('--controlled-gap')
  ? model.lariLearnedRecords.records.filter(r => r.payload?.acquisitionRoute === 'research_proposed_test_verified').map(r => r.id) : [];
model.lariLearnedRecords.records = model.lariLearnedRecords.records.filter(r => !removedForExperiment.includes(r.id));
function workspace(lane) {
  const dir = path.join(out, lane); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'operation.py'), 'def quotient(a, b):\n    return a * b\n');
  fs.writeFileSync(path.join(dir, 'test.py'), lane === 'transfer' || lane === 'ablation'
    ? 'from operation import quotient\nassert quotient(29, 6) == 4\nassert quotient(-29, 6) == -5\nassert quotient(29, -6) == -5\nassert quotient(0, 7) == 0\n'
    : 'from operation import quotient\nassert quotient(17, 4) == 4\nassert quotient(-17, 4) == -5\nassert quotient(8, 2) == 4\n');
  return dir;
}
function oracle(dir) { const result = cp.spawnSync('python', ['test.py'], { cwd: dir, encoding: 'utf8', windowsHide: true }); return { passed: result.status === 0, output: result.stderr }; }
async function execute(state, lane, researchEnabled) {
  const dir = workspace(lane), before = oracle(dir), oracleHash = hash(path.join(dir, 'test.py'));
  const options = { allowSemanticOperatorDiscovery: false, allowExpressionOperatorDiscovery: false, allowPrimitiveDiscovery: false, expressionSearch: true, mutationCandidateLimit: 32, taskTimeoutMs: 30000 };
  const response = await runtime.sendMessageToLariAsync(state, {
    prompt: 'Repair the Python integer quotient function: it must implement floor division.',
    mode: 'code', subintent: 'code.fix', workspaceRoot: dir, testPath: 'test.py', testRunner: 'python.script', expressionTarget: 'operation.py'
  }, { autoGrow: false, operator: false, failureResearch: researchEnabled,
    research: { timeoutMs: 8000 }, kernel: { useBenchmarkSystem: false, includeTransientDiagnostics: true,
      failureLearning: options, executionContract: { workspaceExecution: { ...options, maxIterations: 0 } } } });
  return { before, after: oracle(dir), action: response.action, passed: response.passed,
    research: response.trace?.filter(x => x.phase === 'failure_research'),
    failureEvent: state.lariDefaultFailureLearning?.events?.[0],
    repair: response.trace?.find(x => x.phase === 'default_failure_learning')?.frontierFallback?.expressionRepair,
    oracleUnchanged: hash(path.join(dir, 'test.py')) === oracleHash };
}
(async () => {
  const baseline = await execute(JSON.parse(JSON.stringify(model)), 'baseline', false);
  const learning = await execute(model, 'learning', true);
  const candidate = path.join(out, 'candidate.json'); fs.writeFileSync(candidate, JSON.stringify(model), { flag: 'wx' });
  const reload = await execute(JSON.parse(fs.readFileSync(candidate)), 'reload', false);
  const transfer = await execute(JSON.parse(fs.readFileSync(candidate)), 'transfer', false);
  const ablated = JSON.parse(fs.readFileSync(candidate));
  const ablatedIds = ablated.lariLearnedRecords.records.filter(r => r.payload?.acquisitionRoute === 'research_proposed_test_verified').map(r => r.id);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(r => !ablatedIds.includes(r.id));
  const ablation = await execute(ablated, 'ablation', false);
  const report = { baseline, learning, reload, transfer, ablation, ablatedIds, removedForExperiment, protectedBefore, protectedAfter: { active: hash(active), registry: hash(registry) },
    records: model.lariLearnedRecords.records.filter(x => x.payload?.acquisitionRoute === 'research_proposed_test_verified').map(x => ({ id: x.id, rule: x.payload.rule })),
    limitations: ['Developer-authored integration fixture; not a hidden holdout.', 'Discovery disabled to isolate the research handoff.', 'Transfer varies test inputs within one function shape; arbitrary repository repair remains unproven.'], promoted: false };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, ...report }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
