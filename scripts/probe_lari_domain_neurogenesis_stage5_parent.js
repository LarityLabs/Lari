#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage5-20260830');
const PARENT_HASH = '595541d08c308071049ea6bca168260f68c56efdc97a15cb7c96931a8e4b431a';
const PARENT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage4-20260830', 'candidates', `${PARENT_HASH}.json`);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const workspace = path.join(OUT, 'parent-probe-workspace-attempt-2');
const fixture = JSON.parse(fs.readFileSync(path.join(OUT, 'public-development.json'), 'utf8')).case;
if (sha(PARENT) !== PARENT_HASH) throw new Error('Stage 4 parent hash mismatch.');
if (fs.existsSync(workspace)) throw new Error('Parent probe workspace already exists.');
for (const [relative, content] of Object.entries(fixture.files)) {
  const target = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { flag: 'wx' });
}
const run = () => { const result = spawnSync(process.execPath, [fixture.testPath], { cwd: workspace, encoding: 'utf8', timeout: 10000, windowsHide: true }); return { passed: result.status === 0, exitCode: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.slice(0, 3000) }; };
const before = run();
const model = JSON.parse(fs.readFileSync(PARENT, 'utf8'));
const response = runtime.sendMessageToLari(model, { id: fixture.id, mode: 'code', subintent: 'code.fix', prompt: 'Repair this failing multi-file repository. Form a diagnostic hypothesis, preserve public signatures, coordinate the dependency and consumer, and verify the immutable test.', workspaceRoot: workspace, testPath: fixture.testPath, testRunner: 'javascript.node', expressionTarget: fixture.expressionTarget, preserveLayout: true }, { modelHash: PARENT_HASH, autoGrow: false, groundedFactual: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 }, failureLearning: { modelHash: PARENT_HASH, sourcePath: 'sealed-stage5-parent-probe', benchmarkAssociation: [], allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, coordinatedProgramSearch: true }, executionContract: { workspaceExecution: { maxIterations: 0, allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, coordinatedProgramSearch: true } } } });
const after = run();
const result = { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage5.parent-probe', parentHash: PARENT_HASH, before, after, response: { passed: response.passed === true, action: response.action, answer: response.answer, learnedRecordIds: response.learnedRecordIds, externalModelCalls: response.external_model_calls || 0 }, genuineGap: before.passed === false && after.passed === false && response.passed !== true, externalModelCalls: response.external_model_calls || 0 };
fs.writeFileSync(path.join(OUT, 'parent-gap-probe-v2.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
if (!result.genuineGap || result.externalModelCalls !== 0) process.exitCode = 1;
