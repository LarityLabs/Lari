#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage5-20260830');
const HASH = '595541d08c308071049ea6bca168260f68c56efdc97a15cb7c96931a8e4b431a';
const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage4-20260830', 'candidates', `${HASH}.json`), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(path.join(OUT, 'public-development.json'), 'utf8')).case;
const workspace = path.join(OUT, 'training-workspace');
const shared = { modelHash: HASH, sourcePath: 'sealed-stage5-dispatch-diagnostic', benchmarkAssociation: [], allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: true, coordinatedProgramSearch: true };
const response = runtime.sendMessageToLari(model, { id: fixture.id, mode: 'code', subintent: 'code.fix', prompt: 'Repair this failing multi-file repository. Form a diagnostic hypothesis, preserve public signatures, coordinate the dependency and consumer, and verify the immutable test.', workspaceRoot: workspace, testPath: fixture.testPath, testRunner: 'node.script', expressionTarget: fixture.expressionTarget, preserveLayout: true }, { modelHash: HASH, autoGrow: false, groundedFactual: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, includeTransientDiagnostics: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 }, failureLearning: shared, executionContract: { ...shared, workspaceExecution: { ...shared, maxIterations: 0 } } } });
console.log(JSON.stringify({ passed: response.passed, action: response.action, answer: response.answer, executionBinding: response.executionBinding, transientDiagnostics: response.transientDiagnostics, trace: response.trace, failureLearning: model.lariDefaultFailureLearning }, null, 2));
