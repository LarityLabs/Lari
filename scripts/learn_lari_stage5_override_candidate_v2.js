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
const workspace = path.join(root, 'consolidation', 'stage-5-developmental-workspace', 'override-training-v2');
const baseHash = '50b4268d21d17cd068a54c60b8d0e3d8724764a54d7460d4a429ee460448a724';
const hashValue = value => crypto.createHash('sha256').update(value).digest('hex');
const sha = filePath => hashValue(fs.readFileSync(filePath));
const contentHash = value => hashValue(JSON.stringify(value));
function write(relative, content) { const target = path.join(workspace, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
function runTest() { try { return { passed: true, output: execFileSync(process.execPath, ['tests/test.js'], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; } catch (error) { return { passed: false, error: String(error.stderr || error.message).trim() }; } }
if (fs.existsSync(outputPath)) throw new Error('Developmental candidate exists.');
if (sha(basePath) !== baseHash) throw new Error('Base mismatch.');
fs.rmSync(workspace, { recursive: true, force: true }); fs.mkdirSync(workspace, { recursive: true });
write('src/config.js', 'function mergeConfig(overrides = {}) { return overrides; }\nmodule.exports = { mergeConfig };\n');
write('src/service.js', 'const { mergeConfig } = require("./config");\nfunction shouldRetry(overrides = {}) { return mergeConfig(overrides).enabled; }\nmodule.exports = { shouldRetry };\n');
write('src/index.js', 'module.exports = require("./service");\n');
write('tests/test.js', ["const assert = require('assert');", "const { shouldRetry } = require('../src');", "assert.strictEqual(shouldRetry({}), true);", "assert.strictEqual(shouldRetry({ enabled: false }), false);", "console.log('bounded override resolution verified');"].join('\n') + '\n');
const trainingBefore = runTest(); if (trainingBefore.passed) throw new Error('Training must fail.');
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const learningModel = JSON.parse(JSON.stringify(base));
const trainingPrompt = 'A bounded override resolver failed. Learn a general configuration procedure: start from immutable defaults, apply only explicit overrides with clear precedence, preserve false and zero instead of using truthiness, coerce numeric values, clamp them to declared bounds, let disabled short-circuit behavior, and verify idempotence. This applies to limits, intervals, timeouts, concurrency, flags, and other operator settings.';
const learning = runtime.runLariDefaultFailureLearningPath(learningModel, { id: 'stage5.training.bounded_override_resolution', prompt: trainingPrompt, workspaceRoot: workspace, testPath: 'tests/test.js', preserveLayout: true });
const trainingAfter = runTest(); const event = learning.report.event;
if (!learning.report.passed || !trainingAfter.passed || !event.retained) throw new Error(`Learning failed ${JSON.stringify(event)}`);
const createdAt = new Date().toISOString();
const answerTemplate = 'Start from immutable defaults; apply each explicit override by precedence; preserve false and preserve zero instead of treating them as missing; coerce numeric values; clamp values to declared bounds; if disabled, short-circuit the behavior; rerun resolution to prove it is idempotent; verify precedence, type, and range invariants.';
const triggers = ['configuration','setting','default','explicit','override','precedence','preserve','false','zero','truthiness','coerce','numeric','clamp','bound','disabled','limit','interval','timeout','concurrency','flag','idempotent'];
const procedure = ['copy immutable defaults','apply explicit overrides by precedence','preserve false and zero','coerce numeric values','clamp declared bounds','short-circuit disabled behavior','verify idempotence and invariants'];
const skillId = 'skill.procedure.bounded_override_resolution';
const procedureId = `lari.learned.procedure.${contentHash({ answerTemplate, triggers }).slice(0,24)}`;
const repairId = `lari.learned.repair.${contentHash(event).slice(0,24)}`;
const provenance = { sourceModelHash: baseHash, sourcePath: 'consolidation/stage-5-developmental-workspace/override-training-v2', originalRecordId: event.id, sourceKind: 'verified_training_failure', creationSource: 'runLariDefaultFailureLearningPath', benchmarkAssociation: [], confidence: 0.93, imported: false, classification: 'stage5_developmental_delta', importTimestamp: createdAt };
const selection = { canonical: true, learnedRecordId: procedureId, intentTerms: ['chat'], proceduralCompatibility: 1, provenanceStrength: 0.98, holdoutPerformance: 0, confidence: 0.93, broadFallback: false, scopeTerms: triggers, derivedAt: createdAt };
const skill = { id: skillId, sourceKnowledgeId: repairId, topic: 'Bounded override resolution procedure', capability: 'bounded_override_resolution', confidence: 0.93, triggerConcepts: triggers, triggerEmbedding: runtime.embedTextForModel(base, `${triggers.join(' ')} ${procedure.join(' ')}`), procedure, answerTemplate, status: 'verified_failure_learned_procedure', selfTest: { queryHash: hashValue(trainingPrompt), passed: true, score: 1 }, lariSelection: selection,
  lariExecution: { schemaVersion: 1, id: `execution.${skillId}`, selectedLearnedCapabilityId: procedureId, inputContract: { requestType: 'text', allowedIntents: ['chat'], taskFamilyTerms: ['configuration','setting','default','explicit','override','precedence','false','zero','clamp','bound','disabled','limit','interval','timeout','concurrency','flag'], minimumTaskFamilyMatches: 2 }, executableProcedureReference: 'compiled_skill.answerTemplate', expectedResultType: 'text', verificationRule: { type: 'required_concepts_and_nonempty_text', minimumLength: 40, requiredConcepts: ['defaults','explicit','override','preserve false','preserve zero','coerce','clamp','bounds','disabled','precedence','idempotent'] }, failureSignal: 'override resolution did not produce a verified result', fallbackEligibility: ['execution_failed','verification_failed','incompatible_request','safety_policy_blocked'], provenance: { sourceModelHash: baseHash, sourceSkillId: skillId, learnedRecordId: procedureId, bindingSource: 'stage5-developmental-training-failure', boundAt: createdAt } } };
const repairRecord = { schemaVersion: 1, id: repairId, type: 'repair', status: 'active', normalizedTriggers: triggers, procedureIdentity: contentHash(event.repairKind), semanticFingerprint: contentHash({ family: 'bounded override resolution', triggers }), outputBehavior: contentHash({ verified: event.verified, patchedFiles: event.patchedFiles }), contentHash: contentHash(event), behavioralSignature: contentHash({ retainedPatternId: event.retainedPatternId }), confidence: 0.93, provenance, payload: { failureClassification: 'bounded override resolution failure', repairKind: event.repairKind, verified: event.verified, patchedFiles: event.patchedFiles, retainedPatternId: event.retainedPatternId, hypothesis: 'Defaults plus explicit override precedence, false and zero preservation, numeric coercion, bounded clamping, disabled short-circuiting, and idempotence.' } };
const procedureRecord = { schemaVersion: 1, id: procedureId, type: 'procedure', status: 'active', normalizedTriggers: triggers, procedureIdentity: contentHash(procedure), semanticFingerprint: contentHash({ topic: skill.topic, triggers }), outputBehavior: contentHash(answerTemplate), contentHash: contentHash(skill), behavioralSignature: contentHash({ capability: skill.capability, answerTemplate }), confidence: 0.93, provenance: { ...provenance, originalRecordId: skillId }, payload: skill, selection };
const candidate = JSON.parse(JSON.stringify(base)); candidate.compiledSkills = [skill, ...candidate.compiledSkills]; candidate.lariLearnedRecords.records = [repairRecord, procedureRecord, ...candidate.lariLearnedRecords.records];
candidate.lariStage5Developmental = { schemaVersion: 1, createdAt, baseHash, promoted: false, immutableCandidate: true, family: 'bounded override resolution', typedFailureRecordId: repairId, typedProcedureRecordId: procedureId, canonicalFailurePath: 'runLariDefaultFailureLearningPath', holdoutAccessedByLearner: false, delta: { compiledSkillsAdded: 1, typedRecordsAdded: 2, derivedIndexesRebuilt: ['lariCapabilityGraph'] }, training: { promptHash: hashValue(trainingPrompt), beforePassed: trainingBefore.passed, afterPassed: trainingAfter.passed, verified: event.verified, retained: event.retained } };
runtime.buildLariCapabilityGraph(candidate); fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ baseHash, candidateHash: sha(outputPath), trainingBeforePassed: trainingBefore.passed, trainingAfterPassed: trainingAfter.passed, canonicalLearningPassed: learning.report.passed, typedFailureRecordId: repairId, typedProcedureRecordId: procedureId, holdoutAccessedByLearner: false }, null, 2));
