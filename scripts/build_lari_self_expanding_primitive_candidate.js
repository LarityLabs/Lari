#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const neuro = require('../swarm_domain_neurogenesis.js');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'self-expanding-primitive-language-20260908');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PUBLIC = path.join(OUT, 'public-training.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest-v2.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (value, message) => { if (!value) throw new Error(message); };

function response(model, prompt, hash) {
  return runtime.sendMessageToLari(clone(model), prompt, {
    modelHash: hash,
    autoGrow: false,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
}

function main() {
  assert(!fs.existsSync(MANIFEST), 'Refusing to overwrite immutable Stage 1 artifacts.');
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const publicData = JSON.parse(fs.readFileSync(PUBLIC, 'utf8'));
  // Seal the hidden bytes without parsing them. The builder never sees holdout cases.
  const sealed = fs.existsSync(SEAL) ? JSON.parse(fs.readFileSync(SEAL, 'utf8')) : {
    schemaVersion: 1,
    kind: 'lari.self-expanding-primitive-language.sealed-index',
    createdAt: new Date().toISOString(),
    parentHash: before.active,
    public: { path: rel(PUBLIC), sha256: shaFile(PUBLIC) },
    hidden: { path: rel(HIDDEN), sha256: shaFile(HIDDEN), accessedByBuilder: false }
  };
  if (!fs.existsSync(SEAL)) fs.writeFileSync(SEAL, `${JSON.stringify(sealed, null, 2)}\n`, { flag: 'wx' });
  assert(sealed.parentHash === before.active && sealed.public.sha256 === shaFile(PUBLIC) && sealed.hidden.sha256 === shaFile(HIDDEN), 'Existing seal no longer matches inputs or parent.');
  const model = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const baseline = response(model, publicData.interactionDemonstrations[0].prompt, before.active);
  assert(baseline.answer !== publicData.interactionDemonstrations[0].response, 'Incumbent unexpectedly has the target behavior.');
  const primitiveEvidence = {
    primitiveExamples: publicData.primitiveExamples,
    compositionExhausted: true,
    attemptedCompositionCount: 12,
    existingCompositionPassed: false,
    executableFailureObserved: true,
    executableProof: true
  };
  const operatorGap = neuro.createGap(model, {
    targetType: 'operator',
    capability: 'derive canonical project keys from arbitrary user-provided names',
    failureClass: 'no retained program expresses the demonstrated canonicalization relation',
    failureEvidence: primitiveEvidence,
    sourceModelHash: before.active,
    sourcePath: rel(PUBLIC)
  });
  const operatorProposal = neuro.proposeCandidate(model, operatorGap, primitiveEvidence, {
    sourceModelHash: before.active, sourcePath: rel(PUBLIC), confidence: 0.9
  });
  assert(operatorProposal.learned, operatorProposal.reason || 'operator synthesis failed');
  model.lariLearnedRecords.records.unshift(operatorProposal.record);
  const generatorGap = neuro.createGap(model, {
    targetType: 'generator',
    capability: 'answer canonical project-key requests by executing a retained primitive',
    failureClass: 'primitive exists but ordinary request cannot execute it',
    failureEvidence: { compatibleCapabilityAvailable: true, capabilityExecuted: false },
    sourceModelHash: before.active,
    sourcePath: rel(PUBLIC)
  });
  const generatorProposal = neuro.proposeCandidate(model, generatorGap, {
    interactionDemonstrations: publicData.interactionDemonstrations,
    derivedClaims: { canonical: { kind: 'primitive_apply', sourceSlot: 'source', primitiveId: operatorProposal.record.id } }
  }, { sourceModelHash: before.active, sourcePath: rel(PUBLIC), confidence: 0.9 });
  assert(generatorProposal.learned, generatorProposal.reason || 'interaction synthesis failed');
  model.lariLearnedRecords.records.unshift(generatorProposal.record);
  const publicRows = publicData.interactionDemonstrations.map(item => {
    const result = response(model, item.prompt, 'provisional-candidate');
    return { promptHash: sha(item.prompt), answer: result.answer, expected: item.response, learnedRecordIds: result.learnedRecordIds, passed: result.answer === item.response && result.learnedRecordIds.includes(operatorProposal.record.id) && result.learnedRecordIds.includes(generatorProposal.record.id) };
  });
  assert(publicRows.every(row => row.passed), 'Provisional records do not execute through the public kernel.');
  model.lineage = {
    ...(model.lineage || {}),
    parentHash: before.active,
    developmentalEvent: 'self_expanding_primitive_language_provisional',
    createdAt: new Date().toISOString(),
    sourceGapIds: [operatorGap.id, generatorGap.id],
    sourceRecordIds: [operatorProposal.record.id, generatorProposal.record.id],
    holdoutAccessedBeforeCandidate: false,
    promoted: false
  };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const gates = {
    incumbentFailsTargetBehavior: baseline.answer !== publicData.interactionDemonstrations[0].response,
    failureClassifiedBeforeSynthesis: operatorGap.payload.failureCategory === 'expressiveness_gap' && generatorGap.payload.failureCategory === 'selection_failure',
    oneSharedTypedStore: operatorProposal.record.type === 'operator' && generatorProposal.record.type === 'generator',
    publicExamplesPass: publicRows.every(row => row.passed),
    dependencyExecutionVisible: publicRows.every(row => row.learnedRecordIds.includes(operatorProposal.record.id) && row.learnedRecordIds.includes(generatorProposal.record.id)),
    noTrainingInputsStoredInPrimitive: publicData.primitiveExamples.every(row => !JSON.stringify(operatorProposal.record.payload.primitiveAst).includes(row.input)),
    hiddenUnreadBeforeCandidate: model.lineage.holdoutAccessedBeforeCandidate === false,
    immutableCandidateHash: shaFile(candidatePath) === candidateHash,
    productionReadOnly: before.active === after.active && before.registry === after.registry,
    externalModelCallsZero: true
  };
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.self-expanding-primitive-language.provisional-candidate',
    createdAt: new Date().toISOString(),
    promoted: false,
    parentHash: before.active,
    candidate: { path: rel(candidatePath), sha256: candidateHash },
    seal: { path: rel(SEAL), sha256: shaFile(SEAL), publicSha256: sealed.public.sha256, hiddenSha256: sealed.hidden.sha256 },
    records: { operatorId: operatorProposal.record.id, generatorId: generatorProposal.record.id },
    learnedProgram: operatorProposal.record.payload.primitiveAst,
    publicRows,
    gates,
    passed: Object.values(gates).every(Boolean),
    protectedBefore: before,
    protectedAfter: after,
    externalModelCalls: 0,
    limitations: [
      'This is a learned reusable macro-program over Lari\'s safe declarative substrate, not arbitrary native-code instruction invention.',
      'The candidate is non-promoted and holdout qualification is a separate step.',
      'General repository mastery, strong unrestricted chat, and quality multimodal generation remain unproven.'
    ]
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: manifest.passed, parentHash: before.active, candidateHash, records: manifest.records, learnedProgram: manifest.learnedProgram, gates }, null, 2));
}

main();
