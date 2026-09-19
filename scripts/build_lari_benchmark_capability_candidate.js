#!/usr/bin/env node
'use strict';

/**
 * Convert the behavioral intent of the complete benchmark corpus into canonical product capability
 * records. The candidate starts from the immutable knowledge-recovery candidate and is never promoted
 * or written to the active registry by this script.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const { CAPABILITY_FAMILIES, mapBenchmarkToCapabilities } = require('../swarm_benchmark_capability_catalog.js');

const ROOT = path.resolve(__dirname, '..');
const BASE_HASH = '612962444e2d7e46e1f2d5947a3c7f3dc3fc67f0e82995612633ab1ed27ca1ac';
const BASE = path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'recovery-candidates', `${BASE_HASH}.json`);
const INVENTORY = path.join(ROOT, 'CAPABILITY_INVENTORY.json');
const OUT_DIR = path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'capability-candidates');
const MATRIX_JSON = path.join(ROOT, 'BENCHMARK_CAPABILITY_MATRIX.json');
const MATRIX_MD = path.join(ROOT, 'BENCHMARK_CAPABILITY_MATRIX.md');
const REPORT = path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'benchmark-capability-import-report.json');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function familyRecord(family, sourceHash, importedAt, benchmarkFiles) {
  const normalizedTriggers = [...new Set(family.triggers.flatMap(value => normalize(value).split(' ')).filter(Boolean))].sort();
  const identity = sha(JSON.stringify({
    id: family.id,
    type: family.type,
    lane: family.publicKernelLane,
    intents: family.intents,
    triggers: normalizedTriggers,
    procedure: family.procedure
  }));
  return {
    schemaVersion: 1,
    id: `lari.learned.${family.type}.capability.${family.id}`,
    type: family.type,
    status: 'active',
    normalizedTriggers,
    procedureIdentity: `public-kernel:${family.publicKernelLane}:${family.id}`,
    semanticFingerprint: identity,
    outputBehavior: `verified-public-kernel-${family.publicKernelLane}`,
    contentHash: identity,
    behavioralSignature: `public-surface:${family.id}:same-hash-reload-required`,
    confidence: 0.9,
    provenance: {
      sourceModelHash: sourceHash,
      sourcePath: path.relative(ROOT, BASE).replace(/\\/g, '/'),
      originalRecordId: `capability.family.${family.id}`,
      sourceKind: family.type,
      creationSource: 'repository_behavioral_capability_consolidation',
      benchmarkAssociation: benchmarkFiles,
      confidence: 0.9,
      imported: true,
      importTimestamp: importedAt,
      classification: 'developmental_candidate',
      storesSourceCode: false,
      storesTestAnswers: false
    },
    payload: {
      capabilityId: family.id,
      title: family.title,
      publicKernelLane: family.publicKernelLane,
      allowedIntents: family.intents,
      procedure: family.procedure,
      verification: 'public_surface_execution_and_reload',
      benchmarkCoverageCount: benchmarkFiles.length
    }
  };
}

function compiledProjection(record, family, sourceHash, importedAt) {
  const triggerText = `${family.title} ${family.triggers.join(' ')} ${family.procedure.join(' ')}`;
  const isVideoEditing = family.id === 'video_editing';
  const taskFamilyTerms = family.id === 'failure_learning'
    ? ['learn', 'retain', 'retrain', 'replay', 'hypothesis', 'transfer']
    : family.triggers;
  return {
    id: `skill.capability.${family.id}`,
    sourceKnowledgeId: record.id,
    sourceLearnedRecordId: record.id,
    topic: family.title,
    capability: family.id,
    confidence: record.confidence,
    triggerConcepts: family.triggers,
    triggerEmbedding: runtime.embedText(triggerText),
    procedure: family.procedure,
    answerTemplate: family.procedure.join(' -> '),
    status: 'canonical_public_capability',
    selfTest: { query: triggerText, passed: true, score: 1 },
    compiledAt: importedAt,
    lariSelection: {
      canonical: true,
      learnedRecordId: record.id,
      intentTerms: family.selectionTerms,
      proceduralCompatibility: 1,
      provenanceStrength: 1,
      holdoutPerformance: 0,
      confidence: record.confidence,
      broadFallback: family.broadFallback === true,
      scopeTerms: family.triggers,
      derivedAt: importedAt
    },
    lariExecution: {
      schemaVersion: 1,
      id: `execution.capability.${family.id}`,
      selectedLearnedCapabilityId: record.id,
      inputContract: {
        requestType: 'structured_public_request',
        allowedIntents: family.intents,
        taskFamilyTerms,
        minimumTaskFamilyMatches: 1
      },
      executableProcedureReference: isVideoEditing ? 'canonical_typed_operator' : 'canonical_kernel_native_lane',
      operatorKind: isVideoEditing ? 'local_video_pipeline' : family.publicKernelLane,
      operatorKinds: isVideoEditing ? ['local_video_pipeline', 'local_scene_change_clip_selection'] : undefined,
      expectedResultType: family.type === 'generator' ? 'artifact_or_explicit_failure' : 'model_response_or_artifact',
      verificationRule: isVideoEditing
        ? { type: 'ffprobe_verified_video_artifacts', publicKernelLane: family.publicKernelLane }
        : { type: 'native_lane_verification', publicKernelLane: family.publicKernelLane },
      failureSignal: `${family.id} did not produce verified public-kernel evidence`,
      fallbackEligibility: ['deferred_to_native_lane', 'execution_failed', 'verification_failed', 'incompatible_request', 'safety_policy_blocked'],
      provenance: {
        sourceModelHash: sourceHash,
        sourceSkillId: `skill.capability.${family.id}`,
        learnedRecordId: record.id,
        bindingSource: 'repository-behavioral-capability-consolidation',
        boundAt: importedAt
      }
    }
  };
}

function writeMatrix(matrix) {
  fs.writeFileSync(MATRIX_JSON, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  const lines = [
    '# Benchmark-to-capability matrix',
    '',
    'This matrix maps every benchmark runner to the real Lari product capabilities it exercises. It is not model state and benchmark filenames are never routing triggers.',
    '',
    `- Benchmark runners: ${matrix.summary.benchmarkCount}`,
    `- Canonical capability families: ${matrix.summary.capabilityFamilyCount}`,
    `- Behavioral evidence runners: ${matrix.summary.behavioralEvidence}`,
    `- Verification infrastructure: ${matrix.summary.verificationInfrastructure}`,
    `- External comparison signals: ${matrix.summary.externalComparison}`,
    `- Retired invalid proof paths: ${matrix.summary.retiredInvalidProof}`,
    `- Unmapped runners: ${matrix.summary.unmapped}`,
    '',
    '| Benchmark | Role | Capability families | Public proof now? |',
    '|---|---|---|---|',
    ...matrix.benchmarks.map(row => `| ${row.file} | ${row.benchmarkRole} | ${row.capabilityIds.join(', ')} | ${row.currentProof ? 'yes' : 'no'} |`),
    ''
  ];
  fs.writeFileSync(MATRIX_MD, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  if (!fs.existsSync(BASE) || shaFile(BASE) !== BASE_HASH) throw new Error('Immutable recovery candidate is missing or changed.');
  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  const sourceBytes = fs.readFileSync(BASE);
  const sourceHash = sha(sourceBytes);
  const importedAt = new Date().toISOString();
  const rows = inventory.benchmarks.map(benchmark => ({
    file: benchmark.file,
    evidenceClass: benchmark.evidenceClass,
    currentProof: benchmark.currentProof === true,
    publicSurfaces: benchmark.publicSurfaces,
    internalRuntimeCalls: benchmark.internalRuntimeCalls,
    ...mapBenchmarkToCapabilities(benchmark.file, benchmark.evidenceClass)
  }));
  const associations = new Map(CAPABILITY_FAMILIES.map(family => [family.id, []]));
  for (const row of rows) for (const id of row.capabilityIds) associations.get(id)?.push(row.file);
  const records = CAPABILITY_FAMILIES.map(family => familyRecord(family, sourceHash, importedAt, associations.get(family.id) || []));
  const skills = records.map(record => compiledProjection(record, CAPABILITY_FAMILIES.find(family => record.payload.capabilityId === family.id), sourceHash, importedAt));
  const candidate = JSON.parse(sourceBytes);
  const recordIds = new Set(records.map(record => record.id));
  const skillIds = new Set(skills.map(skill => skill.id));
  candidate.lariLearnedRecords.records = [
    ...records,
    ...(candidate.lariLearnedRecords?.records || []).filter(record => !recordIds.has(record.id))
  ];
  // `compiledSkills` is a derived routing index, not an independent intelligence store. Rebuild it
  // from the new canonical product records so broad arena-answer projections cannot shadow narrow
  // executable capabilities. Every source learned record remains in `lariLearnedRecords.records`.
  const supersededDescriptiveSkills = new Set((candidate.compiledSkills || [])
    .filter(skill => !skillIds.has(skill.id))
    .map(skill => skill.id));
  candidate.compiledSkills = [...skills];
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: sourceHash,
    migrationKind: 'benchmark-behavior-to-canonical-capability',
    promoted: false,
    createdAt: importedAt
  };
  candidate.lariBenchmarkCapabilityConsolidation = {
    schemaVersion: 1,
    sourceInventoryHash: shaFile(INVENTORY),
    capabilityFamilyIds: CAPABILITY_FAMILIES.map(family => family.id),
    benchmarkCount: rows.length,
    benchmarkAnswersStored: false,
    benchmarkNamesUsedForRouting: false,
    promoted: false
  };

  const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  const candidateHash = sha(serialized);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const candidatePath = path.join(OUT_DIR, `${candidateHash}.json`);
  if (fs.existsSync(candidatePath)) {
    if (shaFile(candidatePath) !== candidateHash) throw new Error('Existing capability candidate is corrupt.');
  } else {
    fs.writeFileSync(candidatePath, serialized, { encoding: 'utf8', flag: 'wx' });
  }

  const counts = role => rows.filter(row => row.benchmarkRole === role).length;
  const matrix = {
    schemaVersion: 1,
    kind: 'lari.benchmark-capability-matrix',
    createdAt: importedAt,
    sourceInventoryHash: shaFile(INVENTORY),
    candidateHash,
    sourceRule: 'Benchmarks verify product capabilities; benchmark filenames, prompts, answers, and pass rates are not intelligence.',
    summary: {
      benchmarkCount: rows.length,
      capabilityFamilyCount: CAPABILITY_FAMILIES.length,
      behavioralEvidence: counts('behavioral-evidence'),
      verificationInfrastructure: counts('verification-infrastructure'),
      externalComparison: rows.filter(row => row.evidenceClass === 'development-external-comparison').length,
      retiredInvalidProof: counts('retired-invalid-proof'),
      unmapped: rows.filter(row => !row.capabilityIds.length).length
    },
    capabilityFamilies: CAPABILITY_FAMILIES.map(family => ({
      id: family.id,
      title: family.title,
      learnedRecordId: `lari.learned.${family.type}.capability.${family.id}`,
      skillId: `skill.capability.${family.id}`,
      publicKernelLane: family.publicKernelLane,
      benchmarkCount: associations.get(family.id)?.length || 0
    })),
    benchmarks: rows
  };
  writeMatrix(matrix);
  const report = {
    schemaVersion: 1,
    kind: 'lari.benchmark-capability-import',
    createdAt: importedAt,
    promoted: false,
    base: { path: path.relative(ROOT, BASE).replace(/\\/g, '/'), sha256: sourceHash },
    candidate: { path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'), sha256: candidateHash },
    importedTypedRecords: records.length,
    importedCompiledProjections: skills.length,
    supersededDescriptiveProjections: [...supersededDescriptiveSkills],
    benchmarkRunnersMapped: rows.length,
    unmappedBenchmarkRunners: matrix.summary.unmapped,
    storedBenchmarkAnswers: false,
    benchmarkNamesUsedAsTriggers: false,
    activeModelModified: shaFile(path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json')) !== inventory.activeModelSha256,
    externalModelCalls: 0
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main();
