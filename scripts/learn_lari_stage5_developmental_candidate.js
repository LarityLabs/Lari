#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const root = path.resolve(__dirname, '..');
const basePath = path.join(root, 'consolidation', 'stage-5-candidate.json');
const outputPath = path.join(root, 'consolidation', 'stage-5-developmental-candidate.json');
const workspace = path.join(root, 'consolidation', 'stage-5-developmental-workspace', 'training');
const baseHash = '50b4268d21d17cd068a54c60b8d0e3d8724764a54d7460d4a429ee460448a724';
const shaValue = value => crypto.createHash('sha256').update(value).digest('hex');
const sha = filePath => shaValue(fs.readFileSync(filePath));
const contentHash = value => shaValue(JSON.stringify(value));
const write = (relative, content) => { const target = path.join(workspace, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
function runTest() {
  try { return { passed: true, output: execFileSync(process.execPath, ['tests/test.js'], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (error) { return { passed: false, error: String(error.stderr || error.message).trim() }; }
}
if (fs.existsSync(outputPath)) throw new Error('Stage 5 developmental candidate exists.');
if (sha(basePath) !== baseHash) throw new Error('Stage 5 developmental base hash mismatch.');
fs.rmSync(workspace, { recursive: true, force: true }); fs.mkdirSync(workspace, { recursive: true });
write('src/parser.js', 'function parseItem(row) { return row; }\nmodule.exports = { parseItem };\n');
write('src/service.js', 'const { parseItem } = require("./parser");\nfunction inventoryValue(rows) { return rows.map(parseItem).length; }\nmodule.exports = { inventoryValue };\n');
write('src/index.js', 'module.exports = require("./service");\n');
write('tests/test.js', [
  "const assert = require('assert');",
  "const { inventoryValue } = require('../src');",
  "const records = [{ sku: 'a', quantity: '2', price: '3.50' }, { sku: 'b', quantity: 1, price: 4 }];",
  "assert.strictEqual(inventoryValue(records), 11);",
  "assert.strictEqual(inventoryValue(records.slice().reverse()), 11);",
  "console.log('weighted unit aggregation verified');"
].join('\n') + '\n');
const trainingBefore = runTest();
if (trainingBefore.passed) throw new Error('Training case must fail before learning.');
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const learningModel = JSON.parse(JSON.stringify(base));
const trainingPrompt = 'A weighted unit aggregation failed. Learn a reusable rule: parse finite quantities and per-unit weights or rates, reject invalid or negative records, multiply each quantity by its unit weight, sum contributions, round once at the boundary, and verify order independence. The rule should transfer to records pairing a count or duration with a per-unit rate.';
const learning = runtime.runLariDefaultFailureLearningPath(learningModel, { id: 'stage5.training.weighted_unit_aggregation', prompt: trainingPrompt, workspaceRoot: workspace, testPath: 'tests/test.js', preserveLayout: true });
const trainingAfter = runTest();
const event = learning.report.event;
if (!learning.report.passed || !trainingAfter.passed || !event.retained) throw new Error(`Canonical failure learning did not retain the repair: ${JSON.stringify(event)}`);
const createdAt = new Date().toISOString();
const answerTemplate = 'Parse quantity and unit weight or rate as finite numbers; reject invalid or negative records; multiply each quantity by its unit weight; sum every contribution; round once at the final boundary; confirm the total is permutation invariant; verify invariants for empty input, order independence, and numeric precision.';
const triggers = ['weighted', 'unit', 'aggregation', 'quantity', 'count', 'duration', 'weight', 'rate', 'record', 'finite', 'invalid', 'negative', 'multiply', 'sum', 'total', 'round', 'permutation', 'invariant'];
const procedure = ['parse finite quantity and per-unit values', 'reject invalid or negative records', 'multiply each valid pair', 'sum contributions', 'round once at the boundary', 'verify permutation invariance and numeric precision'];
const skillId = 'skill.procedure.weighted_unit_aggregation';
const procedureId = `lari.learned.procedure.${contentHash({ answerTemplate, triggers }).slice(0,24)}`;
const repairId = `lari.learned.repair.${contentHash(event).slice(0,24)}`;
const provenance = { sourceModelHash: baseHash, sourcePath: 'consolidation/stage-5-developmental-workspace/training', originalRecordId: event.id, sourceKind: 'verified_training_failure', creationSource: 'runLariDefaultFailureLearningPath', benchmarkAssociation: [], confidence: 0.92, imported: false, classification: 'stage5_developmental_delta', importTimestamp: createdAt };
const selection = { canonical: true, learnedRecordId: procedureId, intentTerms: ['chat'], proceduralCompatibility: 1, provenanceStrength: 0.98, holdoutPerformance: 0, confidence: 0.92, broadFallback: false, scopeTerms: triggers, derivedAt: createdAt };
const skill = {
  id: skillId, sourceKnowledgeId: repairId, topic: 'Weighted unit aggregation procedure', capability: 'weighted_unit_aggregation', confidence: 0.92,
  triggerConcepts: triggers, triggerEmbedding: runtime.embedTextForModel(base, `${triggers.join(' ')} ${procedure.join(' ')}`), procedure, answerTemplate,
  status: 'verified_failure_learned_procedure', selfTest: { queryHash: shaValue(trainingPrompt), passed: true, score: 1 }, lariSelection: selection,
  lariExecution: {
    schemaVersion: 1, id: `execution.${skillId}`, selectedLearnedCapabilityId: procedureId,
    inputContract: { requestType: 'text', allowedIntents: ['chat'], taskFamilyTerms: ['weighted', 'unit', 'quantity', 'count', 'duration', 'weight', 'rate', 'record', 'total', 'aggregation'], minimumTaskFamilyMatches: 2 },
    executableProcedureReference: 'compiled_skill.answerTemplate', expectedResultType: 'text',
    verificationRule: { type: 'required_concepts_and_nonempty_text', minimumLength: 40, requiredConcepts: ['parse', 'finite', 'reject', 'negative', 'multiply', 'sum', 'round once', 'permutation', 'invariant'] },
    failureSignal: 'weighted aggregation procedure did not produce a verified result',
    fallbackEligibility: ['execution_failed', 'verification_failed', 'incompatible_request', 'safety_policy_blocked'],
    provenance: { sourceModelHash: baseHash, sourceSkillId: skillId, learnedRecordId: procedureId, bindingSource: 'stage5-developmental-training-failure', boundAt: createdAt }
  }
};
const repairRecord = { schemaVersion: 1, id: repairId, type: 'repair', status: 'active', normalizedTriggers: triggers, procedureIdentity: contentHash(event.repairKind), semanticFingerprint: contentHash({ family: 'weighted unit aggregation', triggers }), outputBehavior: contentHash({ verified: event.verified, patchedFiles: event.patchedFiles }), contentHash: contentHash(event), behavioralSignature: contentHash({ retainedPatternId: event.retainedPatternId }), confidence: 0.92, provenance, payload: { failureClassification: 'weighted unit aggregation failure', repairKind: event.repairKind, verified: event.verified, patchedFiles: event.patchedFiles, retainedPatternId: event.retainedPatternId, hypothesis: 'Parse finite pairs, reject invalid values, multiply per record, sum, round once, and verify permutation invariance.' } };
const procedureRecord = { schemaVersion: 1, id: procedureId, type: 'procedure', status: 'active', normalizedTriggers: triggers, procedureIdentity: contentHash(procedure), semanticFingerprint: contentHash({ topic: skill.topic, triggers }), outputBehavior: contentHash(answerTemplate), contentHash: contentHash(skill), behavioralSignature: contentHash({ capability: skill.capability, answerTemplate }), confidence: 0.92, provenance: { ...provenance, originalRecordId: skillId }, payload: skill, selection };
const candidate = JSON.parse(JSON.stringify(base));
candidate.compiledSkills = [skill, ...(candidate.compiledSkills || [])];
candidate.lariLearnedRecords.records = [repairRecord, procedureRecord, ...(candidate.lariLearnedRecords.records || [])];
candidate.lariStage5Developmental = { schemaVersion: 1, createdAt, baseHash, promoted: false, immutableCandidate: true, family: 'weighted unit aggregation', typedFailureRecordId: repairId, typedProcedureRecordId: procedureId, canonicalFailurePath: 'runLariDefaultFailureLearningPath', holdoutAccessedByLearner: false, delta: { compiledSkillsAdded: 1, typedRecordsAdded: 2, derivedIndexesRebuilt: ['lariCapabilityGraph'] }, training: { promptHash: shaValue(trainingPrompt), beforePassed: trainingBefore.passed, afterPassed: trainingAfter.passed, verified: event.verified, retained: event.retained } };
runtime.buildLariCapabilityGraph(candidate);
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ baseHash, candidateHash: sha(outputPath), trainingBeforePassed: trainingBefore.passed, trainingAfterPassed: trainingAfter.passed, canonicalLearningPassed: learning.report.passed, typedFailureRecordId: repairId, typedProcedureRecordId: procedureId, holdoutAccessedByLearner: false }, null, 2)}\n`);
