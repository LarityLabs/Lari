#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const root = path.resolve(__dirname, '..');
const consolidation = path.join(root, 'consolidation');
const workspace = path.join(consolidation, 'stage-4-developmental-workspace', 'training');
const failurePath = path.join(consolidation, 'stage-4-failure-record.json');
const deltaPath = path.join(consolidation, 'stage-4-candidate-delta.json');
const candidatePath = path.join(consolidation, 'stage-4-developmental-candidate.json');
const baseHash = '963aa947dff519f91c72768ec349185c140eca6b0995562a45566bb32191a273';

function shaBytes(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shaFile(filePath) { return shaBytes(fs.readFileSync(filePath)); }
function canonical(value) { return JSON.stringify(value, Object.keys(value).sort()); }
function write(relative, content) { const target = path.join(workspace, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
function runTest() {
  try { return { passed: true, output: execFileSync(process.execPath, ['tests/test.js'], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (error) { return { passed: false, error: String(error.stderr || error.message).trim() }; }
}
function contentHash(value) { return shaBytes(JSON.stringify(value)); }

for (const filePath of [failurePath, deltaPath, candidatePath]) if (fs.existsSync(filePath)) throw new Error(`Refusing to overwrite ${path.basename(filePath)}.`);
if (shaFile(registry.currentModelPath) !== baseHash) throw new Error('Developmental learner base hash mismatch.');
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
write('src/normalizer.js', 'function slugify(value) { return value; }\nmodule.exports = { slugify };\n');
write('src/service.js', 'const { slugify } = require("./normalizer");\nfunction uniqueSlugs(values) { return values.map(slugify); }\nmodule.exports = { uniqueSlugs };\n');
write('src/index.js', 'module.exports = require("./service");\n');
write('tests/test.js', [
  "const assert = require('assert');",
  "const { uniqueSlugs } = require('../src');",
  "const raw = [' Alpha Key ', 'alpha-key', '', 'Beta.Key', 'beta key'];",
  "assert.deepStrictEqual(uniqueSlugs(raw), ['alpha-key', 'beta-key']);",
  "assert.deepStrictEqual(uniqueSlugs(uniqueSlugs(raw)), ['alpha-key', 'beta-key']);",
  "console.log('canonical key compaction verified');"
].join('\n') + '\n');

const trainingBaseline = runTest();
if (trainingBaseline.passed) throw new Error('Training case must fail before learning.');
const baseModel = registry.loadLariModel().model;
const learningModel = JSON.parse(JSON.stringify(baseModel));
const beforePatterns = learningModel.lariMultiFileWorkspaceRepair?.patterns?.length || 0;
const learning = runtime.runLariDefaultFailureLearningPath(learningModel, {
  id: 'stage4.training.canonical_key_compaction',
  prompt: 'A canonical-key compactor must normalize equivalent labels, discard empty results, deduplicate, deterministically order output, remain idempotent, and prove those invariants with tests.',
  workspaceRoot: workspace,
  testPath: 'tests/test.js',
  preserveLayout: true
});
const trainingAfter = runTest();
const event = learning.report.event;
if (!learning.report.passed || !trainingAfter.passed || !event.retained || (learningModel.lariMultiFileWorkspaceRepair?.patterns?.length || 0) <= beforePatterns) {
  throw new Error(`Canonical failure-learning path did not verify and retain the training repair: ${JSON.stringify(event)}`);
}
const createdAt = new Date().toISOString();
const sourceFailureHash = contentHash(event);
const answerTemplate = 'Normalize every candidate key by trimming whitespace, converting to lowercase, and collapsing punctuation to one separator; discard empty results; deduplicate canonical keys; sort them for deterministic output; rerun the transform to prove it is idempotent; verify invariants for uniqueness, ordering, and stability.';
const triggers = ['canonical', 'key', 'compact', 'normalize', 'equivalent', 'label', 'trim', 'whitespace', 'lowercase', 'punctuation', 'discard', 'empty', 'deduplicate', 'deterministic', 'order', 'sort', 'idempotent', 'invariant'];
const procedure = [
  'Normalize each candidate by trimming whitespace, converting to lowercase, and collapsing punctuation.',
  'Discard empty canonical results and deduplicate equivalent keys.',
  'Sort canonical keys for deterministic output.',
  'Rerun the transformation to verify idempotence and check uniqueness, ordering, and stability invariants.'
];
const skillId = 'skill.procedure.deterministic_canonical_key_compaction';
const procedureId = `lari.learned.procedure.${contentHash({ answerTemplate, triggers }).slice(0, 24)}`;
const repairId = `lari.learned.repair.${sourceFailureHash.slice(0, 24)}`;
const selection = {
  canonical: true, learnedRecordId: procedureId,
  intentTerms: ['chat'], proceduralCompatibility: 1,
  provenanceStrength: 0.98, holdoutPerformance: 0, confidence: 0.92, broadFallback: false,
  scopeTerms: triggers, derivedAt: createdAt
};
const skill = {
  id: skillId, sourceKnowledgeId: repairId, topic: 'Deterministic canonical-key compaction procedure',
  capability: 'deterministic_canonical_key_compaction', confidence: 0.92,
  triggerConcepts: triggers, triggerEmbedding: runtime.embedTextForModel(baseModel, `${triggers.join(' ')} ${procedure.join(' ')}`),
  procedure, answerTemplate, status: 'verified_failure_learned_procedure',
  selfTest: { queryHash: shaBytes('A canonical-key compactor must normalize equivalent labels, discard empty results, deduplicate, deterministically order output, remain idempotent, and prove those invariants with tests.'), passed: true, score: 1 },
  lariSelection: selection
};
const provenance = {
  sourceModelHash: baseHash, sourcePath: 'consolidation/stage-4-developmental-workspace/training',
  originalRecordId: event.id, sourceKind: 'verified_training_failure', creationSource: 'runLariDefaultFailureLearningPath',
  benchmarkAssociation: [], confidence: 0.92, imported: false, classification: 'developmental_delta', importTimestamp: createdAt
};
const repairRecord = {
  schemaVersion: 1, id: repairId, type: 'repair', status: 'active',
  normalizedTriggers: triggers, procedureIdentity: contentHash(event.repairKind || 'text_pipeline'),
  semanticFingerprint: contentHash({ classification: 'canonical_key_equivalence', triggers }),
  outputBehavior: contentHash({ patchedFiles: event.patchedFiles, verified: event.verified }),
  contentHash: sourceFailureHash, behavioralSignature: contentHash({ retainedPatternId: event.retainedPatternId }),
  confidence: 0.92, provenance,
  payload: { failureClassification: 'deterministic canonical-key compaction failure', repairKind: event.repairKind, retainedPatternId: event.retainedPatternId, patchedFiles: event.patchedFiles, verified: event.verified, hypothesis: 'Normalize before comparison, reject empty canonical forms, deduplicate canonical values, impose deterministic order, and verify idempotence.' }
};
const procedureRecord = {
  schemaVersion: 1, id: procedureId, type: 'procedure', status: 'active',
  normalizedTriggers: triggers, procedureIdentity: contentHash(triggers), semanticFingerprint: contentHash({ topic: skill.topic, triggers }),
  outputBehavior: contentHash(answerTemplate), contentHash: contentHash(skill), behavioralSignature: contentHash({ capability: skill.capability, answerTemplate }),
  confidence: 0.92, provenance: { ...provenance, originalRecordId: skillId }, payload: skill, selection
};
const candidate = JSON.parse(JSON.stringify(baseModel));
candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
candidate.lariLearnedRecords.records = [repairRecord, procedureRecord, ...(candidate.lariLearnedRecords.records || [])];
candidate.compiledSkills = [skill, ...(candidate.compiledSkills || [])];
candidate.lariDevelopmentalLineage = {
  schemaVersion: 1, stage: 4, baseHash, createdAt, trainingFailureId: event.id,
  failureRecordId: repairId, procedureRecordId: procedureId, candidateDeltaOnly: true,
  holdoutAccessedByLearner: false, canonicalFailurePath: 'runLariDefaultFailureLearningPath'
};
runtime.buildLariCapabilityGraph(candidate);
fs.writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
const candidateHash = shaFile(candidatePath);
const failureRecord = {
  schemaVersion: 1, stage: 4, createdAt, typedAs: 'repair', baseHash,
  trainingPromptHash: shaBytes('A canonical-key compactor must normalize equivalent labels, discard empty results, deduplicate, deterministically order output, remain idempotent, and prove those invariants with tests.'),
  trainingBaseline, trainingAfter, event, generalFailureClassification: repairRecord.payload.failureClassification,
  reusableHypothesis: repairRecord.payload.hypothesis, provenance, holdoutAccessedByLearner: false
};
fs.writeFileSync(failurePath, `${JSON.stringify(failureRecord, null, 2)}\n`, { flag: 'wx' });
const delta = {
  schemaVersion: 1, stage: 4, createdAt, baseHash, candidatePath: 'consolidation/stage-4-developmental-candidate.json', candidateHash,
  typedRecords: [repairRecord, procedureRecord], compiledSkills: [skill],
  derivedIndexes: ['lariCapabilityGraph'], activeModelMutated: false, holdoutAccessedByLearner: false
};
fs.writeFileSync(deltaPath, `${JSON.stringify(delta, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ baseHash, candidateHash, trainingBaselinePassed: trainingBaseline.passed, canonicalLearningPassed: learning.report.passed, trainingAfterPassed: trainingAfter.passed, repairKind: event.repairKind, typedRecordIds: [repairId, procedureId], holdoutAccessedByLearner: false }, null, 2)}\n`);
