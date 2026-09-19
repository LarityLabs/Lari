'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const research = require('../swarm_external_tools');
const runtime = require('../swarm_model_runtime');
const active = path.resolve(__dirname, '../models/lari/current/swarm-model.json');
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(active)).digest('hex');
const before = hash();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-research-binding-'));
fs.writeFileSync(path.join(root, 'test.js'), 'throw new Error("unrepairable test oracle");\n');
const original = research.resolveResearchEvidence;
let calls = 0;
// Deterministic integration evidence: this test does not claim a live web result.
research.resolveResearchEvidence = async () => {
  calls++;
  return { sources: [{ url: 'https://example.org/test-source', text: 'Replace floor with ceil.', title: 'Test evidence' }] };
};
(async () => {
  try {
    const model = JSON.parse(fs.readFileSync(active));
    const ids = (model.lariLearnedRecords?.records || []).map(r => r.id);
    const stableIds = (model.lariLearnedRecords?.records || []).filter(r => r.type !== 'repair_failure').map(r => r.id);
    const request = { mode: 'code', subintent: 'code.fix', prompt: 'Repair the failing repository test.', workspaceRoot: root, testPath: 'test.js', testRunner: 'javascript.node' };
    const context = { autoGrow: false, operator: false, kernel: { useBenchmarkSystem: false, includeTransientDiagnostics: true, failureLearning: { allowExpressionOperatorDiscovery: false, allowSemanticOperatorDiscovery: false, mutationCandidateLimit: 1 } } };
    const response = await runtime.sendMessageToLariAsync(model, request, context);
    assert.equal(calls, 1);
    const trace = response.trace.find(row => row.phase === 'failure_research');
    assert.equal(trace.sourceCount, 1);
    assert.equal(trace.verified, false);
    // An exhausted repair now retains a typed diagnostic failure record so a
    // later learning cycle can study it.  The unverified research proposal
    // must still not enter learned knowledge or executable operators.
    const afterRecords = model.lariLearnedRecords?.records || [];
    const retainedIds = afterRecords.filter(r => r.type !== 'repair_failure').map(r => r.id).sort();
    const expectedIds = [...stableIds].sort();
    const removedIds = expectedIds.filter(id => !retainedIds.includes(id));
    const addedIds = retainedIds.filter(id => !expectedIds.includes(id));
    assert.deepEqual({ removedIds, addedIds }, { removedIds: [], addedIds: [] });
    assert(afterRecords.some(r => r.type === 'repair_failure'));
    await runtime.sendMessageToLariAsync(model, request, { ...context, failureResearch: false });
    assert.equal(calls, 1, 'Explicit research disable must be respected');
    assert.equal(hash(), before);
    console.log(JSON.stringify({ passed: true, automaticResearch: true, failedProposalNotRetained: true, explicitDisableRespected: true, activeUnchanged: true, liveWebTest: false }));
  } finally {
    research.resolveResearchEvidence = original;
    // Only the exact directory returned by mkdtemp is removed.
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
