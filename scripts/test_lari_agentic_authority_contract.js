#!/usr/bin/env node
'use strict';

// Bounded authority proof for the existing swarm mission loop. This is not a
// new planner or policy store: it verifies that an explicit authority contract
// can deny external effects before routing/execution while still permitting
// explicitly authorized local work with a rollback plan.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const sourceModel = require(ACTIVE);
const executorCalls = [];
const executor = ({ step }) => {
  executorCalls.push(step.id);
  return {
    ok: true,
    summary: `Controlled executor ran ${step.id}.`,
    artifacts: [`proof/${step.id}.json`],
    checks: ['executor_invoked', 'local_evidence_collected'],
    observations: []
  };
};

const readOnly = runtime.runSwarmMission(clone(sourceModel), 'inspect current local state', {
  steps: [{
    id: 'authority.read',
    family: 'inspection',
    action: 'inspect',
    query: 'inspect current model state',
    verify: { requiredArtifacts: 1, requiredChecks: 2 }
  }],
  executor,
  authorityContract: { tier: 0, allowExternal: false }
});
assert.strictEqual(readOnly.authority.deniedStepCount, 0, 'read-only work was denied');
assert.strictEqual(readOnly.stepReports[0].authorityDecision.requiredTier, 0, 'read-only work was assigned a mutation tier');
assert.strictEqual(readOnly.stepReports[0].executed, true, 'read-only executor did not run');

const localModel = clone(sourceModel);
const local = runtime.runSwarmMission(localModel, 'write a local workspace proof', {
  steps: [{
    id: 'authority.local',
    family: 'workspace_repair',
    action: 'repair',
    query: 'write a local workspace proof',
    sideEffect: 'workspace',
    mutatesWorkspace: true,
    rollbackPlan: { kind: 'restore_snapshot', target: 'workspace-before-authority.local' },
    verify: { requiredArtifacts: 1, requiredChecks: 2 }
  }],
  executor,
  authorityContract: {
    tier: 1,
    allowExternal: false,
    allowWorkspaceMutation: true,
    requireRollback: true
  }
});
assert.strictEqual(local.authority.deniedStepCount, 0, 'authorized local work was denied');
assert.strictEqual(local.stepReports[0].authorityDecision.requiredTier, 1, 'local work was not classified as tier 1');
assert.strictEqual(local.stepReports[0].authorityDecision.rollbackPlan.kind, 'restore_snapshot', 'rollback plan was not retained');
assert.strictEqual(local.stepReports[0].executed, true, 'authorized local executor did not run');

const callsBeforeExternal = executorCalls.length;
const external = runtime.runSwarmMission(clone(sourceModel), 'publish the artifact to production', {
  steps: [{
    id: 'authority.external',
    family: 'publication',
    action: 'publish',
    query: 'publish the artifact to production',
    external: true,
    authorityEffect: 'external',
    rollbackPlan: { kind: 'restore_previous_release', target: 'incumbent' },
    verify: { requiredArtifacts: 1, requiredChecks: 2 }
  }],
  executor,
  authorityContract: { tier: 3, allowExternal: false, requireRollback: true }
});
assert.strictEqual(external.authority.deniedStepCount, 1, 'external effect was not denied by default');
assert(external.stepReports[0].authorityDecision.reasons.includes('external_effect_not_authorized'), 'denial reason did not identify missing external authorization');
assert.strictEqual(external.stepReports[0].executed, false, 'denied external executor ran');
assert.strictEqual(executorCalls.length, callsBeforeExternal, 'denied external request reached the executor');

const authorizedExternal = runtime.runSwarmMission(clone(sourceModel), 'publish the artifact to staging', {
  steps: [{
    id: 'authority.external.authorized',
    family: 'publication',
    action: 'publish',
    query: 'publish the artifact to staging',
    external: true,
    authorityEffect: 'external',
    rollbackPlan: { kind: 'restore_previous_release', target: 'incumbent' },
    verify: { requiredArtifacts: 1, requiredChecks: 2 }
  }],
  executor,
  authorityContract: { tier: 3, allowExternal: true, requireRollback: true }
});
assert.strictEqual(authorizedExternal.authority.deniedStepCount, 0, 'explicitly authorized external work was denied');
assert.strictEqual(authorizedExternal.stepReports[0].executed, true, 'explicitly authorized external executor did not run');

const maxSteps = runtime.runSwarmMission(clone(sourceModel), 'inspect two independent facts', {
  steps: [
    { id: 'authority.max.1', family: 'inspection', action: 'inspect', query: 'inspect first fact', verify: { requiredArtifacts: 1, requiredChecks: 2 } },
    { id: 'authority.max.2', family: 'inspection', action: 'inspect', query: 'inspect second fact', verify: { requiredArtifacts: 1, requiredChecks: 2 } }
  ],
  executor,
  authorityContract: { tier: 2, allowExternal: false, maxSteps: 1 }
});
assert.strictEqual(maxSteps.authority.deniedStepCount, 1, 'maxSteps did not bound the mission');
assert(maxSteps.stepReports.some(step => step.authorityDecision.reasons.includes('max_steps_exceeded')), 'maxSteps denial was not recorded');

const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
assert.deepStrictEqual(protectedAfter, protectedBefore, 'active model or registry changed');

const evidence = {
  test: 'lari-agentic-authority-contract',
  passed: true,
  readOnlyTier: readOnly.stepReports[0].authorityDecision.requiredTier,
  localMutationTier: local.stepReports[0].authorityDecision.requiredTier,
  deniedExternal: external.stepReports[0].authorityDecision.reasons,
  authorizedExternal: authorizedExternal.stepReports[0].authorityDecision,
  maxStepsDenied: maxSteps.authority.deniedStepIds,
  activeModelReadOnly: true,
  registryReadOnly: true,
  externalModelCalls: 0
};
const evidenceDir = path.join(ROOT, 'consolidation', 'agentic-authority-contract-20260906');
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
