#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const MODEL_PATH = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY_PATH = path.join(ROOT, 'models', 'lari', 'registry.json');
const OUTPUT_DIR = path.join(ROOT, 'consolidation', 'chat-language-frontier-20260828');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'stateful-chat-validation.json');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ACTIVE_HASH = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')).activeModelSha256;
const loadModel = () => JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
const context = userScope => ({
  userScope,
  modelHash: ACTIVE_HASH,
  autoGrow: false,
  kernel: {
    useBenchmarkSystem: false,
    useCapabilityGraph: true,
    capabilityGraph: { minScore: 0 },
    chat: { minMemoryScore: 0, minRouteScore: 0 }
  }
});

async function turn(model, userScope, prompt) {
  const response = await runtime.sendMessageToLariAsync(model, prompt, context(userScope));
  return {
    prompt,
    answer: response.answer,
    action: response.action,
    modelHash: response.modelHash,
    learnedRecordIds: response.learnedRecordIds || [],
    contextMemory: response.contextMemory || null,
    externalModelCalls: response.external_model_calls || 0
  };
}

async function runDialogue(seedModel, userScope, prompts, reloadAfter = -1) {
  let model = seedModel;
  const turns = [];
  for (let index = 0; index < prompts.length; index += 1) {
    turns.push(await turn(model, userScope, prompts[index]));
    if (index === reloadAfter) model = JSON.parse(JSON.stringify(model));
  }
  return { model, turns };
}

async function main() {
  const before = { model: sha256(MODEL_PATH), registry: sha256(REGISTRY_PATH) };
  if (before.model !== ACTIVE_HASH) throw new Error('Stateful chat validation requires model bytes matching the active registry hash.');

  const primary = await runDialogue(loadModel(), 'chat.stateful.primary', [
    'I think the build cache is stale because the generated assets are old.',
    'I already cleared the cache and the failure stayed exactly the same.',
    'Why does that change the diagnosis?',
    'What do YOU need to learn before you can diagnose this unfamiliar build system?',
    'No, I asked what you need to learn, not what I need to learn.'
  ], 1);
  const variant = await runDialogue(loadModel(), 'chat.stateful.variant', [
    'I suspect the incremental compiler cache is poisoned because unchanged bundles keep reappearing.',
    'I disabled the incremental cache, yet the error persisted.',
    'Why should that lower confidence in the original explanation?',
    'What must you understand before you can repair an unfamiliar monorepo toolchain?',
    'Not what I should study—what should you learn?'
  ], 1);

  const dialogueGates = dialogue => ({
    hypothesisCaptured: /testable hypothesis/i.test(dialogue.turns[0].answer),
    evidenceRevisesDiagnosis: /weakens the hypothesis/i.test(dialogue.turns[1].answer),
    reloadRetainsReasoning: /because a useful diagnosis/i.test(dialogue.turns[2].answer),
    learningGapAudit: /i need to learn/i.test(dialogue.turns[3].answer) && /diagnostic hypothesis/i.test(dialogue.turns[3].answer),
    correctionResolved: /you asked about my missing knowledge, not yours/i.test(dialogue.turns[4].answer),
    contextPathUsed: dialogue.turns.every(item => item.action === 'session_context_memory'),
    exactHash: dialogue.turns.every(item => item.modelHash === ACTIVE_HASH),
    externalModelCallsZero: dialogue.turns.every(item => item.externalModelCalls === 0)
  });
  const primaryGates = dialogueGates(primary);
  const variantGates = dialogueGates(variant);
  const after = { model: sha256(MODEL_PATH), registry: sha256(REGISTRY_PATH) };
  const gates = {
    primaryFiveOfFive: Object.values(primaryGates).every(Boolean),
    semanticVariantFiveOfFive: Object.values(variantGates).every(Boolean),
    reloadRetention: primaryGates.reloadRetainsReasoning && variantGates.reloadRetainsReasoning,
    activeModelReadOnly: before.model === after.model,
    registryReadOnly: before.registry === after.registry,
    exactProductionHash: before.model === ACTIVE_HASH && after.model === ACTIVE_HASH,
    externalModelCallsZero: primaryGates.externalModelCallsZero && variantGates.externalModelCallsZero
  };
  const report = {
    schemaVersion: 1,
    kind: 'lari.stateful-chat-language.validation',
    createdAt: new Date().toISOString(),
    activeHash: ACTIVE_HASH,
    primary: { turns: primary.turns, gates: primaryGates },
    semanticVariant: { turns: variant.turns, gates: variantGates },
    before,
    after,
    gates,
    passed: Object.values(gates).every(Boolean),
    externalModelCalls: 0
  };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.relative(ROOT, OUTPUT_PATH).replace(/\\/g, '/'), gates, passed: report.passed }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
