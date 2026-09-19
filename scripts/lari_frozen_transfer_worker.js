'use strict';
// Experiment adapter for the existing public kernel. No repair implementation lives here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const runtime = require('../swarm_model_runtime');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const candidate = JSON.parse(fs.readFileSync(config.candidate, 'utf8'));
if (sha(config.candidate) !== config.candidateHash) throw new Error('Candidate mismatch');
if (config.ablate) candidate.lariLearnedRecords.records = candidate.lariLearnedRecords.records.filter(r => r.id !== config.ablate);
const oracleHashes = Object.fromEntries(config.oracleFiles.map(f => [f, sha(path.join(config.workspace, f))]));
const shared = { modelHash: config.candidateHash, autoGrow: false, allowExpressionOperatorDiscovery: false,
  allowSemanticOperatorDiscovery: false, allowPrimitiveDiscovery: false, coordinatedProgramSearch: false,
  expressionSearch: false, mutationCandidateLimit: 32, taskTimeoutMs: 90000 };
const response = runtime.sendMessageToLari(candidate, {
  id: config.id, mode: 'code', subintent: 'code.fix', prompt: config.prompt,
  workspaceRoot: config.workspace, testPath: config.selectors[0].split('::')[0],
  testRunner: 'python.pytest', testSelectors: config.selectors,
  tests: [...new Set(config.selectors.map(s => s.split('::')[0]))].map(p => ({path:p,runner:'python.pytest',selectors:config.selectors.filter(s=>s.split('::')[0]===p)})), preserveLayout:true
}, { modelHash: config.candidateHash, autoGrow:false, groundedFactual:false, kernel:{useBenchmarkSystem:false,
  useCapabilityGraph:true, includeTransientDiagnostics:true, capabilityGraph:{minScore:0}, chat:{minMemoryScore:0,minRouteScore:0},
  failureLearning:shared, executionContract:{...shared,workspaceExecution:{...shared,maxIterations:0}} } });
const test = spawnSync('python',['-m','pytest','-q',...config.selectors],{cwd:config.workspace,encoding:'utf8',timeout:90000,windowsHide:true});
const event = candidate.lariDefaultFailureLearning?.events?.[0];
const recordId = event?.retainedPatternId || response.executionBinding?.appliedOperatorRecordId || null;
const oracleUnchanged = Object.entries(oracleHashes).every(([f,h])=>sha(path.join(config.workspace,f))===h);
const result = { id:config.id, responsePassed:response.passed===true, modelHash:response.modelHash,
  recordId, testExitCode:test.status, testOutput:`${test.stdout||''}${test.stderr||''}`.slice(-5000), oracleUnchanged,
  passed:response.passed===true && test.status===0 && oracleUnchanged,
  reportedExternalModelCalls:response.external_model_calls ?? null,
  action:response.action, answer:String(response.answer||'').slice(0,1500),
  failureReason:event?.reason, loadedModules:Object.keys(require.cache) };
fs.writeFileSync(config.result,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({id:result.id,passed:result.passed,recordId}));
