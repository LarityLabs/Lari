'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const runtime = require('../swarm_model_runtime');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const active = path.join(root, 'models/lari/current/swarm-model.json');
const registry = path.join(root, 'models/lari/registry.json');
const clone = x => JSON.parse(JSON.stringify(x));
const view = r => ({ answer: r.answer, action: r.action, passed: r.passed, modelHash: r.modelHash,
  learnedRecordIds: r.learnedRecordIds || [], research: r.trace?.filter(x => /research/.test(x.phase)) || [] });
const context = hash => ({ modelHash: hash, autoGrow: false, operator: false, groundingTimeoutMs: 8000,
  kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 },
    failureLearning: { taskTimeoutMs: 30000, mutationCandidateLimit: 16 } } });
if (process.argv[2] === '--recall') {
  // Fresh process; reject attempted web use instead of silently allowing it.
  global.fetch = async () => { throw new Error('Network disabled for recall'); };
  const file = process.argv[3];
  const model = JSON.parse(fs.readFileSync(file));
  const response = runtime.sendMessageToLari(model, 'Explain Python floor division using retained knowledge.', { ...context(sha(fs.readFileSync(file))), groundedFactual: false });
  console.log(JSON.stringify(view(response)));
} else (async () => {
  const bytes = fs.readFileSync(active), modelHash = sha(bytes), intact = JSON.parse(bytes);
  const out = path.join(root, 'consolidation', `ordinary-use-${Date.now()}`); fs.mkdirSync(out);
  const snapshot = path.join(out, 'intact.json'); fs.writeFileSync(snapshot, bytes, { flag: 'wx' });
  const before = { active: modelHash, registry: sha(fs.readFileSync(registry)) };
  const chatCases = [
    { id: 'summary', prompt: 'Summarize in one sentence: The release was planned for Monday. Testing found a data-loss bug. We postponed the release until Thursday to fix it.', terms: ['Thursday', 'bug'] },
    { id: 'constraint', prompt: 'Give exactly three short steps for debugging a failing test. Do not change any files.', terms: ['test'] },
    { id: 'explanation', prompt: 'Explain why a queue helps when requests arrive faster than workers can process them.', terms: ['queue'] },
    { id: 'uncertainty', prompt: 'Our service crashed once. Is that enough evidence to conclude the database caused it?', terms: [] }
  ];
  fs.writeFileSync(path.join(out, 'task-spec.json'), JSON.stringify(chatCases, null, 2));
  const chat = [];
  for (const item of chatCases) {
    const r = await runtime.sendMessageToLariAsync(clone(intact), item.prompt, context(modelHash));
    chat.push({ ...item, response: view(r), requiredTermsPresent: item.terms.every(term => String(r.answer).toLowerCase().includes(term.toLowerCase())), qualityVerdict: 'requires human assessment' });
  }
  const coding = [];
  for (const language of ['python', 'javascript']) {
    const dir = path.join(out, language); fs.mkdirSync(dir);
    const python = language === 'python', source = python ? 'operation.py' : 'operation.js', test = python ? 'test.py' : 'test.js';
    fs.writeFileSync(path.join(dir, source), python ? 'def total(values):\n    return sum(values) + 1\n' : 'exports.total = values => values.reduce((a, b) => a + b, 1);\n');
    fs.writeFileSync(path.join(dir, test), python ? 'from operation import total\nassert total([]) == 0\nassert total([3, -2, 8]) == 9\n' : 'const assert=require("assert"), {total}=require("./operation"); assert.equal(total([]),0); assert.equal(total([3,-2,8]),9);\n');
    const oracleHash = sha(fs.readFileSync(path.join(dir,test)));
    const run = () => { const r = cp.spawnSync(python ? 'python' : process.execPath, [test], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10000 }); return { passed: r.status === 0, error: r.stderr }; };
    const initial = run();
    const response = await runtime.sendMessageToLariAsync(clone(intact), { prompt: 'Fix the total function so it sums the supplied values, including an empty list. Verify the tests.', mode: 'code', subintent: 'code.fix', workspaceRoot: dir, testPath: test, testRunner: python ? 'python.script' : 'javascript.node', expressionTarget: source }, context(modelHash));
    coding.push({ language, initial, after: run(), response: view(response), oracleUnchanged: sha(fs.readFileSync(path.join(dir,test))) === oracleHash });
  }
  const learningModel = clone(intact), priorIds = new Set(learningModel.lariLearnedRecords.records.map(r=>r.id));
  const research = await runtime.runLariAutonomousRequest(learningModel, 'Research Python floor division operator', { ...context(modelHash), mode: 'research_learning' });
  const candidate = path.join(out, 'learning-candidate.json'); fs.writeFileSync(candidate, JSON.stringify(learningModel));
  const cold = cp.spawnSync(process.execPath, [__filename, '--recall', candidate], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const prompt = chatCases[2].prompt;
  const api = runtime.runLariChatCompletion(clone(intact), { messages: [{ role: 'user', content: prompt }] }, context(modelHash));
  const cli = cp.spawnSync(process.execPath, ['scripts/lari_ask.js', '--model-path', snapshot, '--debug', '--no-save', prompt], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const report = { out, before, after: {active:sha(fs.readFileSync(active)),registry:sha(fs.readFileSync(registry))}, chat, coding,
    learning: { response:view(research), addedIds:learningModel.lariLearnedRecords.records.filter(r=>!priorIds.has(r.id)).map(r=>r.id), candidateHash:sha(fs.readFileSync(candidate)), coldRecall:{status:cold.status, output:cold.stdout, error:cold.stderr} },
    surfaces: { canonical:chat[2].response, api, cli:{status:cli.status,output:cli.stdout,error:cli.stderr}, workbench:'UI not exercised; no browser parity claim' },
    limitations:['Intact production state in isolated copies; runtime is the current development checkout.', 'Small developer-authored diagnostic sample; not sealed or representative.', 'Response passed flags and keyword hits are not chat-quality scores.'], promoted:false };
  fs.writeFileSync(path.join(out,'report.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify({out,chat:chat.map(x=>({id:x.id,...x.response})),coding:coding.map(x=>({language:x.language,passed:x.after.passed})),learning:report.learning,unchanged:JSON.stringify(before)===JSON.stringify(report.after)},null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
