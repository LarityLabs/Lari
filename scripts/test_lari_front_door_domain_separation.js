'use strict';

// Regression: explicit executable coding context must outrank generic chat
// coreference clarification. Chat requests still retain the clarification path.
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtime = require('../swarm_model_runtime');

const modelPath = path.join(__dirname, '..', 'models', 'lari', 'current', 'swarm-model.json');
const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-domain-separation-'));
fs.writeFileSync(path.join(workspaceRoot, 'test.js'), 'throw new Error("expected failure");\n');

const coding = runtime.sendMessageToLari(model, {
  mode: 'code',
  subintent: 'code.fix',
  prompt: 'Fix it in this repository and verify the test.',
  workspaceRoot,
  testPath: 'test.js',
  testRunner: 'javascript.node'
}, { modelHash: 'domain-separation-regression', autoGrow: false, kernel: {
  useBenchmarkSystem: false,
  useCapabilityGraph: true,
  capabilityGraph: { minScore: 0 },
  chat: { minMemoryScore: 0, minRouteScore: 0 }
} });

if (coding.action === 'request_clarification') {
  throw new Error('Explicit executable coding context was incorrectly diverted to clarification.');
}
if (coding.trace?.some(step => step.phase === 'pragmatic_clarification')) {
  throw new Error('Coding request emitted a pragmatic clarification trace.');
}

const chat = runtime.sendMessageToLari(model, 'Edit it, but do not change it.', {
  modelHash: 'domain-separation-regression',
  autoGrow: false,
  kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
});
if (chat.action !== 'request_clarification') {
  throw new Error('Ambiguous chat request no longer asks for clarification.');
}

fs.rmSync(workspaceRoot, { recursive: true, force: true });
console.log(JSON.stringify({ passed: true, codingAction: coding.action, chatAction: chat.action }, null, 2));
