#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const neuro = require('../swarm_domain_neurogenesis.js');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
const parent = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
const model = clone(parent);
// This lifecycle test must begin from a real expressiveness gap even after the
// learned records have reached production.  Ablate the exact prior result in
// the isolated clone; never require the active model to forget a promotion.
const previouslyLearnedIds = new Set([
  'lari.learned.operator.neurogenesis.2469ea082df026142b03',
  'lari.learned.generator.neurogenesis.70e9eeb42ff30f691d8f',
  'lari.learned.repair.capability_gap.3e6e3ad90dfab4a66507',
  'lari.learned.repair.capability_gap.5c795879147d9eec096b'
]);
model.lariLearnedRecords.records = model.lariLearnedRecords.records
  .filter(record => !previouslyLearnedIds.has(record.id));
assert.strictEqual(
  neuro.executeInteractionProgram(model, 'Normalize project key: DELTA'),
  null,
  'the isolated exact-record ablation must restore the original capability gap'
);

const classifications = {
  authority_unavailable: { authorityDenied: true },
  environment_failure: { environmentFailure: true },
  resource_exhausted: { resourceExhausted: true },
  selection_failure: { compatibleCapabilityAvailable: true, capabilityExecuted: false },
  knowledge_missing: { missingKnowledge: true },
  execution_failure: { capabilityExecuted: true, executionPassed: false },
  expressiveness_gap: { compositionExhausted: true, attemptedCompositionCount: 12, independentExampleCount: 3, existingCompositionPassed: false }
};
for (const [expected, evidence] of Object.entries(classifications)) {
  assert.strictEqual(neuro.classifyCapabilityFailure(evidence).classification, expected);
}

const primitiveExamples = [
  { input: ' ALPHA ', output: 'alpha-id' },
  { input: ' Beta', output: 'beta-id' },
  { input: 'GAMMA  ', output: 'gamma-id' }
];
const expressivenessEvidence = {
  primitiveExamples,
  compositionExhausted: true,
  attemptedCompositionCount: 12,
  existingCompositionPassed: false,
  executableFailureObserved: true,
  executableProof: true
};
const rejectedWrongLayer = neuro.synthesizeDeclarativePrimitive({
  examples: primitiveExamples,
  environmentFailure: true,
  compositionExhausted: true,
  attemptedCompositionCount: 12
});
assert.strictEqual(rejectedWrongLayer.learned, false);
assert.match(rejectedWrongLayer.reason, /expressiveness_gap/);

const operatorGap = neuro.createGap(model, {
  targetType: 'operator',
  capability: 'derive canonical project keys from arbitrary user-provided names',
  failureClass: 'no retained program expresses the demonstrated canonicalization relation',
  failureEvidence: expressivenessEvidence,
  sourceModelHash: protectedBefore.active,
  sourcePath: 'ordinary_public_inference'
});
assert.strictEqual(operatorGap.payload.failureCategory, 'expressiveness_gap');
const operatorProposal = neuro.proposeCandidate(model, operatorGap, expressivenessEvidence, {
  sourceModelHash: protectedBefore.active,
  sourcePath: 'failure_driven_typed_examples',
  confidence: 0.9
});
assert.strictEqual(operatorProposal.learned, true, operatorProposal.reason);
const primitive = operatorProposal.record.payload.primitiveAst;
assert.deepStrictEqual(primitive.steps, [
  { op: 'lowercase' },
  { op: 'trim' },
  { op: 'suffix', value: '-id' }
]);
const serializedPrimitive = JSON.stringify(primitive);
for (const row of primitiveExamples) assert(!serializedPrimitive.includes(row.input), 'primitive retained a training input');
const operatorRetention = neuro.retainVerifiedCandidate(model, operatorGap, operatorProposal, {
  visible: true,
  hiddenTransfer: true,
  semanticFaithfulness: true,
  reload: true,
  ablation: true,
  regressions: 0,
  externalModelCallsZero: true
});
assert.strictEqual(operatorRetention.retained, true);

const interactionExamples = [
  { prompt: 'Normalize project key: ALPHA', response: 'Canonical key: alpha-id', claims: { source: 'ALPHA', canonical: 'alpha-id' } },
  { prompt: 'Normalize project key: BETA', response: 'Canonical key: beta-id', claims: { source: 'BETA', canonical: 'beta-id' } }
];
const generatorGap = neuro.createGap(model, {
  targetType: 'generator',
  capability: 'answer canonical project-key requests by executing the retained primitive',
  failureClass: 'primitive exists but ordinary request cannot execute it',
  failureEvidence: { compatibleCapabilityAvailable: true, capabilityExecuted: false },
  sourceModelHash: protectedBefore.active,
  sourcePath: 'ordinary_public_inference'
});
assert.strictEqual(generatorGap.payload.failureCategory, 'selection_failure');
const generatorProposal = neuro.proposeCandidate(model, generatorGap, {
  interactionDemonstrations: interactionExamples,
  derivedClaims: { canonical: { kind: 'primitive_apply', sourceSlot: 'source', primitiveId: operatorProposal.record.id } }
}, { sourceModelHash: protectedBefore.active, sourcePath: 'ordinary_public_inference', confidence: 0.9 });
assert.strictEqual(generatorProposal.learned, true, generatorProposal.reason);
const generatorRetention = neuro.retainVerifiedCandidate(model, generatorGap, generatorProposal, {
  visible: true,
  hiddenTransfer: true,
  semanticFaithfulness: true,
  reload: true,
  ablation: true,
  regressions: 0,
  externalModelCallsZero: true
});
assert.strictEqual(generatorRetention.retained, true);

const hidden = [
  ['Normalize project key: DELTA', 'Canonical key: delta-id'],
  ['Normalize project key: Epsilon', 'Canonical key: epsilon-id'],
  ['Normalize project key: ZETA', 'Canonical key: zeta-id']
];
for (const [prompt, expected] of hidden) {
  const direct = neuro.executeInteractionProgram(model, prompt);
  assert.strictEqual(direct.answer, expected);
  assert.deepStrictEqual(direct.learnedRecordIds, [generatorProposal.record.id, operatorProposal.record.id]);
  const publicResponse = runtime.sendMessageToLari(clone(model), prompt, {
    modelHash: 'developmental-candidate',
    autoGrow: false,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
  assert.strictEqual(publicResponse.answer, expected);
  assert(publicResponse.learnedRecordIds.includes(generatorProposal.record.id));
  assert(publicResponse.learnedRecordIds.includes(operatorProposal.record.id));
  assert.strictEqual(publicResponse.publicAnswerSource, 'canonical_learned_record_execution');
}

const reloaded = JSON.parse(JSON.stringify(model));
assert.strictEqual(neuro.executeInteractionProgram(reloaded, hidden[0][0]).answer, hidden[0][1]);
const primitiveAblated = clone(reloaded);
primitiveAblated.lariLearnedRecords.records = primitiveAblated.lariLearnedRecords.records.filter(record => record.id !== operatorProposal.record.id);
assert.strictEqual(neuro.executeInteractionProgram(primitiveAblated, hidden[0][0]), null);
const generatorAblated = clone(reloaded);
generatorAblated.lariLearnedRecords.records = generatorAblated.lariLearnedRecords.records.filter(record => record.id !== generatorProposal.record.id);
assert.strictEqual(neuro.executeInteractionProgram(generatorAblated, hidden[0][0]), null);
assert.deepStrictEqual({ active: shaFile(ACTIVE), registry: shaFile(REGISTRY) }, protectedBefore);

console.log(JSON.stringify({
  test: 'lari-self-expanding-primitive-language',
  passed: true,
  failureLayersClassified: Object.keys(classifications).length,
  learnedOperatorId: operatorProposal.record.id,
  learnedGeneratorId: generatorProposal.record.id,
  learnedSteps: primitive.steps,
  hiddenTransfer: `${hidden.length}/${hidden.length}`,
  publicKernelBinding: true,
  dependencySelectionVisible: true,
  reload: true,
  exactDependencyAblation: '2/2',
  activeModelMutation: false,
  externalModelCalls: 0
}, null, 2));
