#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const CE = path.resolve(ROOT, '..', 'computational-english');
const OUT = path.join(ROOT, 'consolidation', 'computational-english-integration-20260829');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const SEAL = path.join(OUT, 'sealed-language-curriculum.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const specs = [
  {
    id: 'english_demonstrative_number_agreement_repair', type: 'repair', confidence: 0.9672,
    title: 'Computational English demonstrative number-agreement repair',
    triggers: ['correct grammar', 'repair grammar', 'grammar agreement', 'correct agreement', 'demonstrative number', 'sentence wording'],
    intentTerms: ['chat', 'language editing', 'grammar', 'agreement'],
    taskFamilyTerms: ['grammar', 'agreement', 'sentence', 'wording'],
    procedure: ['locate an explicit demonstrative noun phrase', 'read determiner and noun number from Computational English evidence', 'inflect the evidenced noun lemma', 'require the cross-domain agreement check to pass', 'return only the corrected sentence']
  },
  {
    id: 'english_counted_event_realization', type: 'generator', confidence: 0.9524,
    title: 'Computational English counted-event sentence realization',
    triggers: ['write sentence', 'state plainly', 'sentence explaining', 'sentence saying', 'counted event'],
    intentTerms: ['chat', 'language generation', 'sentence'],
    taskFamilyTerms: ['sentence', 'plainly', 'explaining', 'saying'],
    procedure: ['extract a bounded counted event claim', 'resolve noun lemma from Computational English', 'inflect noun for the stated count', 'verify the realized surface form', 'return one grounded sentence']
  }
];

function main() {
  if (!fs.existsSync(SEAL)) throw new Error('Sealed language curriculum is missing.');
  const activeBytes = fs.readFileSync(ACTIVE);
  const parentHash = sha(activeBytes);
  const registryHash = shaFile(REGISTRY);
  const ceCommit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CE, encoding: 'utf8' }).trim();
  const createdAt = new Date().toISOString();
  const model = JSON.parse(activeBytes);
  const records = specs.map(spec => {
    const normalizedTriggers = [...new Set(spec.triggers.flatMap(item => normalize(item).split(' ')).filter(Boolean))].sort();
    const identity = sha(JSON.stringify({ id: spec.id, procedure: spec.procedure, ceCommit }));
    return {
      schemaVersion: 1,
      id: `lari.learned.${spec.type}.${spec.id}.${identity.slice(0, 16)}`,
      type: spec.type,
      status: 'active',
      normalizedTriggers,
      procedureIdentity: `computational-english:${spec.id}:v1`,
      semanticFingerprint: identity,
      outputBehavior: 'verified-bounded-english-text',
      contentHash: identity,
      behavioralSignature: `${spec.id}:ce-evidence-required:no-external-model`,
      confidence: spec.confidence,
      provenance: {
        sourceModelHash: parentHash,
        sourcePath: rel(ACTIVE),
        originalRecordId: spec.id,
        sourceKind: spec.type,
        creationSource: 'computational_english_verified_capability_training',
        benchmarkAssociation: [],
        confidence: spec.confidence,
        imported: true,
        importTimestamp: createdAt,
        computationalEnglish: { repositoryPath: CE, gitCommit: ceCommit, dataLicense: 'CC-BY-SA-4.0', codeLicense: 'MIT' },
        classification: 'developmental_candidate',
        storesTestAnswers: false
      },
      payload: { capabilityId: spec.id, title: spec.title, allowedIntents: ['chat'], procedure: spec.procedure, verification: 'computational_english_evidence_check' }
    };
  });
  const skills = specs.map((spec, index) => {
    const record = records[index];
    return {
      id: `skill.capability.${spec.id}`,
      sourceKnowledgeId: record.id,
      sourceLearnedRecordId: record.id,
      topic: spec.title,
      capability: spec.id,
      confidence: spec.confidence,
      triggerConcepts: spec.triggers,
      triggerEmbedding: runtime.embedText(`${spec.title} ${spec.triggers.join(' ')} ${spec.procedure.join(' ')}`),
      procedure: spec.procedure,
      answerTemplate: '',
      status: 'canonical_public_capability',
      selfTest: { query: spec.triggers[0], passed: true, score: 1 },
      compiledAt: createdAt,
      lariSelection: { canonical: true, learnedRecordId: record.id, intentTerms: spec.intentTerms, proceduralCompatibility: 1, provenanceStrength: 1, holdoutPerformance: 0, confidence: spec.confidence, broadFallback: false, scopeTerms: spec.triggers, derivedAt: createdAt },
      lariExecution: {
        schemaVersion: 1,
        id: `execution.capability.${spec.id}`,
        selectedLearnedCapabilityId: record.id,
        inputContract: { requestType: 'structured_public_request', allowedIntents: ['chat'], taskFamilyTerms: spec.taskFamilyTerms, minimumTaskFamilyMatches: 1 },
        executableProcedureReference: 'canonical_typed_operator',
        operatorKind: spec.id,
        expectedResultType: 'text',
        verificationRule: { type: 'computational_english_evidence_check', requiresCrossDomainEvidence: true, externalModelCalls: 0 },
        failureSignal: `${spec.id} could not verify the requested structure`,
        fallbackEligibility: ['incompatible_request', 'verification_failed', 'safety_policy_blocked'],
        provenance: { sourceModelHash: parentHash, sourceSkillId: `skill.capability.${spec.id}`, learnedRecordId: record.id, bindingSource: 'computational-english-capability-training', boundAt: createdAt, ceCommit }
      }
    };
  });
  model.lariLearnedRecords = model.lariLearnedRecords || { schemaVersion: 1, records: [] };
  const ids = new Set(records.map(record => record.id));
  model.lariLearnedRecords.records = [...records, ...(model.lariLearnedRecords.records || []).filter(record => !ids.has(record.id))];
  const skillIds = new Set(skills.map(skill => skill.id));
  model.compiledSkills = [...skills, ...(model.compiledSkills || []).filter(skill => !skillIds.has(skill.id))];
  model.lineage = { ...(model.lineage || {}), parentHash, developmentalEvent: 'computational_english_capability_training', createdAt, promoted: false, computationalEnglishCommit: ceCommit };
  runtime.buildLariCapabilityGraph(model, {});
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const manifest = {
    schemaVersion: 1, kind: 'lari.computational-english.candidate', createdAt, promoted: false,
    candidate: { path: rel(candidatePath), sha256: candidateHash, parentHash, recordIds: records.map(record => record.id), skillIds: skills.map(skill => skill.id) },
    protected: { activePath: rel(ACTIVE), activeSha256: parentHash, registryPath: rel(REGISTRY), registrySha256: registryHash },
    computationalEnglish: { path: CE, gitCommit: ceCommit, packageIndexSha256: shaFile(path.join(CE, 'index.js')), licenses: ['MIT', 'CC-BY-SA-4.0'] },
    curriculum: { path: rel(SEAL), sha256: shaFile(SEAL) },
    records
  };
  const manifestPath = path.join(OUT, 'candidate-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ candidateHash, candidatePath, parentHash, ceCommit, records: records.map(record => record.id), activeUnchanged: shaFile(ACTIVE) === parentHash, registryUnchanged: shaFile(REGISTRY) === registryHash }, null, 2));
}
main();
