#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, 'consolidation', 'stage-5-candidate.json');
const baseHash = '963aa947dff519f91c72768ec349185c140eca6b0995562a45566bb32191a273';
const sha = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
if (fs.existsSync(outputPath)) throw new Error('Stage 5 candidate already exists.');
if (sha(registry.currentModelPath) !== baseHash) throw new Error('Production active hash does not match the Stage 5 base.');
const candidate = JSON.parse(JSON.stringify(registry.loadLariModel().model));
const createdAt = new Date().toISOString();
const bindings = [
  {
    skillId: 'skill.source_backed_research_learning', allowedIntents: ['research'],
    taskFamilyTerms: ['source', 'research', 'evidence', 'claim', 'confidence', 'domain'], minimumTaskFamilyMatches: 2,
    requiredConcepts: ['sources', 'claims', 'confidence', 'memory']
  },
  {
    skillId: 'skill.frontier_coding_repair_loop', allowedIntents: ['chat', 'code'],
    taskFamilyTerms: ['coding', 'repair', 'failure', 'cause', 'patch', 'test'], minimumTaskFamilyMatches: 2,
    requiredConcepts: ['failure', 'cause', 'patches', 'tests']
  },
  {
    skillId: 'skill.audio_generation_improvement', allowedIntents: ['chat', 'product'],
    taskFamilyTerms: ['audio', 'melody', 'bass', 'percussion', 'artifact'], minimumTaskFamilyMatches: 2,
    requiredConcepts: ['melody', 'bass', 'percussion', 'artifact']
  }
];
for (const binding of bindings) {
  const skill = candidate.compiledSkills.find(item => item.id === binding.skillId);
  if (!skill) throw new Error(`Missing executable learned skill ${binding.skillId}.`);
  skill.lariExecution = {
    schemaVersion: 1,
    id: `execution.${skill.id}`,
    selectedLearnedCapabilityId: skill.lariSelection?.learnedRecordId || null,
    inputContract: {
      requestType: 'text',
      allowedIntents: binding.allowedIntents,
      taskFamilyTerms: binding.taskFamilyTerms,
      minimumTaskFamilyMatches: binding.minimumTaskFamilyMatches
    },
    executableProcedureReference: 'compiled_skill.answerTemplate',
    expectedResultType: 'text',
    verificationRule: { type: 'required_concepts_and_nonempty_text', minimumLength: 24, requiredConcepts: binding.requiredConcepts },
    failureSignal: 'selected learned procedure did not produce a verified text result',
    fallbackEligibility: ['execution_failed', 'verification_failed', 'incompatible_request', 'safety_policy_blocked'],
    provenance: {
      sourceModelHash: baseHash,
      sourceSkillId: skill.id,
      learnedRecordId: skill.lariSelection?.learnedRecordId || null,
      bindingSource: 'consolidation-stage-5',
      boundAt: createdAt
    }
  };
}
candidate.lariStage5 = {
  schemaVersion: 1,
  createdAt,
  baseHash,
  promoted: false,
  immutableCandidate: true,
  canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
  executionContractVersion: 1,
  boundSkillIds: bindings.map(item => item.skillId),
  rejectedStage4DeltaImported: false,
  allowedDelta: ['execution-contract changes', 'route-to-executor bindings', 'task-family compatibility', 'fallback-reason recording', 'derived capability graph']
};
runtime.buildLariCapabilityGraph(candidate);
fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
const candidateHash = sha(outputPath);
process.stdout.write(`${JSON.stringify({ baseHash, candidateHash, boundSkillIds: candidate.lariStage5.boundSkillIds, rejectedStage4DeltaImported: false }, null, 2)}\n`);
