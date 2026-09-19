#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const realRegistryRoot = path.join(root, 'models', 'lari');
const customOutputRoot = process.argv[4] ? path.resolve(root, process.argv[4]) : null;
const rehearsalRoot = process.argv[5]
  ? path.resolve(root, process.argv[5])
  : customOutputRoot
    ? path.join(root, 'consolidation', 'stage-3-rehearsal', path.basename(customOutputRoot))
  : path.join(root, 'consolidation', 'stage-3-rehearsal');
const candidatePath = process.argv[2]
  ? path.resolve(root, process.argv[2])
  : path.join(root, 'consolidation', 'stage-2-unified-candidate.json');
const candidateHash = process.argv[3] || '963aa947dff519f91c72768ec349185c140eca6b0995562a45566bb32191a273';
const rehearsalPrompt = process.argv[6] || 'For a chat request, classify family and select the verified reusable procedure.';
const evidencePath = customOutputRoot
  ? path.join(customOutputRoot, 'promotion-rehearsal-evidence.json')
  : path.join(root, 'consolidation', 'stage-3-promotion-rehearsal-evidence.json');
const promotionReportPath = customOutputRoot
  ? path.join(customOutputRoot, 'promotion-report.md')
  : path.join(root, 'consolidation', 'stage-3-promotion-report.md');
const rollbackReportPath = customOutputRoot
  ? path.join(customOutputRoot, 'rollback-report.md')
  : path.join(root, 'consolidation', 'stage-3-rollback-report.md');
const faultReportPath = customOutputRoot
  ? path.join(customOutputRoot, 'fault-injection-report.md')
  : path.join(root, 'consolidation', 'stage-3-fault-injection-report.md');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function writeExclusive(filePath, content) {
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function cloneRegistry(name) {
  const destination = path.join(rehearsalRoot, name, 'registry');
  // A rehearsal needs the registry manifest and current active namespace, not
  // every historical backup ever retained beside it.  Copying the entire
  // directory multiplies multi-gigabyte backups for each fault scenario and
  // can exhaust the disk before any promotion check runs.
  fs.mkdirSync(path.join(destination, 'current'), { recursive: true });
  fs.copyFileSync(path.join(realRegistryRoot, 'registry.json'), path.join(destination, 'registry.json'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(realRegistryRoot, 'current', 'swarm-model.json'), path.join(destination, 'current', 'swarm-model.json'), fs.constants.COPYFILE_EXCL);
  return destination;
}

function worker(operation, registryRoot, argument = candidatePath) {
  const run = spawnSync(process.execPath, ['scripts/lari_stage3_registry_worker.js', operation, argument], {
    cwd: root,
    env: {
      ...process.env,
      LARI_REGISTRY_ROOT: relative(registryRoot),
      LARI_ALLOW_ISOLATED_REGISTRY_WRITES: '1',
      LARI_DISABLE_MODEL_FALLBACKS: '1',
      LARI_ALLOW_LEGACY_ROOT_MODEL: '0',
      LARI_REHEARSAL_CANDIDATE_PROVENANCE: relative(candidatePath)
    },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024
  });
  let result = null;
  try {
    result = JSON.parse(run.stdout.trim());
  } catch {
    throw new Error(`Stage 3 worker produced invalid JSON for ${operation}: ${run.stdout}\n${run.stderr}`);
  }
  if (run.status !== 0 || result.fatal) throw new Error(`Stage 3 worker failed for ${operation}: ${JSON.stringify(result.fatal || result)}`);
  return result;
}

function table(rows, columns) {
  const clean = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    `| ${columns.map(column => column.label).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map(column => clean(column.value(row))).join(' | ')} |`)
  ].join('\n');
}

function main() {
  if (customOutputRoot && fs.existsSync(customOutputRoot)) {
    throw new Error(`Refusing to overwrite rehearsal namespace: ${relative(customOutputRoot)}`);
  }
  for (const item of [rehearsalRoot, evidencePath, promotionReportPath, rollbackReportPath, faultReportPath]) {
    if (fs.existsSync(item)) throw new Error(`Refusing to overwrite Stage 3 artifact: ${relative(item)}`);
  }
  if (customOutputRoot) fs.mkdirSync(customOutputRoot, { recursive: true });
  if (sha256(candidatePath) !== candidateHash) throw new Error('Stage 2 candidate hash mismatch.');
  const realBefore = {
    current: sha256(path.join(realRegistryRoot, 'current', 'swarm-model.json')),
    registry: sha256(path.join(realRegistryRoot, 'registry.json')),
    legacyRoot: sha256(path.join(root, 'swarm-model.json'))
  };
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const candidateArtifactRoot = path.dirname(path.dirname(candidatePath));
  const stage5QualificationPath = [
    path.join(candidateArtifactRoot, 'qualification-report.json'),
    path.join(candidateArtifactRoot, 'qualification.json'),
    path.join(candidateArtifactRoot, 'validation-report.json')
  ].find(file => fs.existsSync(file));
  const stage5Qualification = stage5QualificationPath
    ? JSON.parse(fs.readFileSync(stage5QualificationPath, 'utf8'))
    : null;
  const adjacentCompositionEvidencePath = path.join(path.dirname(candidatePath), 'evidence.json');
  const adjacentCompositionEvidence = fs.existsSync(adjacentCompositionEvidencePath)
    ? JSON.parse(fs.readFileSync(adjacentCompositionEvidencePath, 'utf8'))
    : null;
  const provenance = {
    candidateHashMatches: sha256(candidatePath) === candidateHash,
    stage2: candidate.lariConsolidation?.stage === 2,
    stage5Neurogenesis: candidate.lineage?.developmentalEvent === 'multifile_procedure_neurogenesis_hidden_qualified'
      && stage5Qualification?.passed === true
      && stage5Qualification?.candidate?.sha256 === candidateHash,
    unknownRepositoryAcquisition: candidate.lineage?.developmentalEvent === 'sealed_unknown_repository_hidden_transfer_qualification'
      && stage5Qualification?.passed === true
      && stage5Qualification?.qualifiedCandidate?.sha256 === candidateHash,
    generatedPrimitiveFamily: candidate.lineage?.developmentalEvent === 'sealed_generated_primitive_family_hidden_qualification'
      && stage5Qualification?.passed === true
      && stage5Qualification?.qualifiedCandidate?.sha256 === candidateHash,
    semanticAstAutogenesis: candidate.lineage?.developmentalEvent === 'qualified_failure_induced_semantic_ast'
      && stage5Qualification?.passed === true
      && stage5Qualification?.candidateHash === candidateHash,
    referentialRelationAutogenesis: candidate.lineage?.developmentalEvent === 'qualified_failure_induced_referential_relation'
      && stage5Qualification?.passed === true
      && stage5Qualification?.candidateHash === candidateHash,
    crossDomainComposition: adjacentCompositionEvidence?.kind === 'lari.cross-domain-composition.candidate'
      && adjacentCompositionEvidence?.passed === true
      && adjacentCompositionEvidence?.candidateHash === candidateHash,
    mixedDomainProgramGrowth: candidate.lineage?.developmentalEvent === 'mixed_domain_program_growth_hidden_qualified'
      && stage5Qualification?.passed === true
      && stage5Qualification?.candidate?.sha256 === candidateHash,
    generalFiniteStateTransducer: candidate.lineage?.developmentalEvent === 'general_finite_state_transducer_neurogenesis'
      && stage5Qualification?.passed === true
      && stage5Qualification?.candidate?.sha256 === candidateHash
      && Array.isArray(stage5Qualification?.learnedRecords)
      && stage5Qualification.learnedRecords.length >= 2,
    symbolicPredicatePushdown: candidate.lineage?.developmentalEvent === 'symbolic_predicate_and_pushdown_neurogenesis'
      && stage5Qualification?.passed === true
      && stage5Qualification?.candidate?.sha256 === candidateHash
      && Array.isArray(stage5Qualification?.learnedRecords)
      && stage5Qualification.learnedRecords.some(record => record.representationFamily === 'induced_symbolic_finite_state_transducer')
      && stage5Qualification.learnedRecords.some(record => record.representationFamily === 'induced_symbolic_pushdown_transducer'),
    betaQualityExecutionRefinement: candidate.lineage?.type === 'beta_quality_execution_refinement_candidate'
      && stage5Qualification?.passed === true
      && stage5Qualification?.candidate?.sha256 === candidateHash
      && stage5Qualification?.gates?.hiddenSemanticTransfer === true
      && stage5Qualification?.gates?.reloadRetention === true
      && stage5Qualification?.gates?.exactRecordAblation === true
      && stage5Qualification?.gates?.productSoak === true,
    stage1BaseHash: candidate.lariConsolidation?.stage1BaseHash || null,
    canonicalRuntime: candidate.lariConsolidation?.canonicalRuntime
      || candidate.lineage?.canonicalRuntime
      || null,
    promotedInsideCandidate: candidate.lariConsolidation?.promoted === true
  };
  const expectedSurfaceAddition = provenance.mixedDomainProgramGrowth
    ? (stage5Qualification?.additions || []).find(addition => {
      const generator = candidate.lariLearnedRecords?.records?.find(record => record.id === addition.generatorId);
      try { return new RegExp(generator?.payload?.interactionProgram?.matcher?.source || '$a').test(rehearsalPrompt); } catch { return false; }
    }) || null
    : null;
  const expectedStateMachineRecord = provenance.generalFiniteStateTransducer || provenance.symbolicPredicatePushdown
    ? (stage5Qualification.learnedRecords || []).find(record => rehearsalPrompt.toLowerCase().includes(String(record.family || '').split('_')[0]))
      || stage5Qualification.learnedRecords[0]
    : null;

  const promotionRoot = cloneRegistry('promotion');
  const promotion = worker('promote', promotionRoot);
  const promotedRegistry = promotion.after.registry;
  const promotionBackupPath = path.resolve(root, promotedRegistry.previousModelPath);
  const promotionChecks = {
    activeHashMatchesCandidate: promotion.after.currentHash === candidateHash,
    registryManifestPointsToClone: promotedRegistry.activeModelPath === relative(path.join(promotionRoot, 'current', 'swarm-model.json')),
    promotedFromCandidate: promotedRegistry.promotedFrom === relative(candidatePath),
    backupPointerExists: fs.existsSync(promotionBackupPath),
    backupHashMatchesIncumbent: fs.existsSync(promotionBackupPath) && sha256(promotionBackupPath) === realBefore.current,
    metadataCandidateHash: promotedRegistry.metadata?.candidateSha256 === candidateHash,
    metadataProvenance: promotedRegistry.metadata?.candidateProvenance === relative(candidatePath),
    lineageFirstEntry: promotedRegistry.history?.[0]?.promotedFrom === relative(candidatePath),
    noFallbackCandidates: promotedRegistry.candidates?.every(item => item.id === 'canonical-current') === true,
    candidateProvenanceValid: provenance.candidateHashMatches
      && (provenance.stage2 || provenance.stage5Neurogenesis || provenance.unknownRepositoryAcquisition || provenance.generatedPrimitiveFamily || provenance.semanticAstAutogenesis || provenance.referentialRelationAutogenesis || provenance.crossDomainComposition || provenance.mixedDomainProgramGrowth || provenance.generalFiniteStateTransducer || provenance.symbolicPredicatePushdown || provenance.betaQualityExecutionRefinement)
      && provenance.canonicalRuntime === 'sendMessageToLari -> runLariUnifiedTaskKernel'
  };

  const coldStart = worker('inference', promotionRoot, rehearsalPrompt);
  const coldStartChecks = {
    resolvedRegistryClone: coldStart.resolved.source === 'registry' && coldStart.resolved.path === path.join(promotionRoot, 'current', 'swarm-model.json'),
    modelHash: coldStart.modelHash === candidateHash,
    selectedLearnedRecord: Boolean(coldStart.selection?.learnedRecordId),
    activeReadOnlyDuringInference: coldStart.before.currentHash === coldStart.after.currentHash && coldStart.after.currentHash === candidateHash,
    registryReadOnlyDuringInference: coldStart.before.registryHash === coldStart.after.registryHash,
    ...(expectedSurfaceAddition ? {
      exactGeneratorExecuted: coldStart.learnedRecordIds?.includes(expectedSurfaceAddition.generatorId) === true,
      exactOperatorExecuted: coldStart.learnedRecordIds?.includes(expectedSurfaceAddition.operatorId) === true
    } : {}),
    ...(expectedStateMachineRecord ? {
      exactStateMachineExecuted: coldStart.learnedRecordIds?.includes(expectedStateMachineRecord.id) === true
    } : {})
  };

  // Exercise each public entry-point shape against the rehearsed registry
  // clone. The wrappers intentionally remain thin: every call resolves the
  // same cloned active bytes and the same canonical runtime.
  const surfaceNames = ['workbench', 'cli', 'openai_compatible_api', 'autonomous'];
  const surfaceResults = surfaceNames.map(surface => {
    const operation = surface === 'autonomous' ? 'autonomous' : 'inference';
    const result = worker(operation, promotionRoot, rehearsalPrompt);
    return {
      surface,
      operation,
      modelHash: result.modelHash || null,
      selectedRecordId: expectedSurfaceAddition
        ? result.learnedRecordIds?.find(id => id === expectedSurfaceAddition.generatorId) || null
        : expectedStateMachineRecord
          ? result.learnedRecordIds?.find(id => id === expectedStateMachineRecord.id) || null
        : result.selection?.learnedRecordId || result.learnedRecordIds?.[0] || null,
      learnedRecordIds: result.learnedRecordIds || [],
      answer: result.answer || '',
      externalModelCalls: Number(result.external_model_calls || 0),
      activeReadOnly: result.before?.currentHash === result.after?.currentHash,
      registryReadOnly: result.before?.registryHash === result.after?.registryHash,
      passed: result.modelHash === candidateHash
        && Boolean(result.selection?.learnedRecordId || result.learnedRecordIds?.length)
        && Number(result.external_model_calls || 0) === 0
        && (!expectedSurfaceAddition || (result.learnedRecordIds || []).includes(expectedSurfaceAddition.generatorId))
        && (!expectedSurfaceAddition || (result.learnedRecordIds || []).includes(expectedSurfaceAddition.operatorId))
        && (!expectedStateMachineRecord || (result.learnedRecordIds || []).includes(expectedStateMachineRecord.id))
        && result.before?.currentHash === result.after?.currentHash
        && result.before?.registryHash === result.after?.registryHash
    };
  });
  const surfaceParityChecks = {
    allSurfacesResolveCandidateHash: surfaceResults.every(row => row.modelHash === candidateHash),
    sameSelectedRecord: new Set(surfaceResults.map(row => row.selectedRecordId)).size === 1,
    ...(expectedSurfaceAddition ? {
      exactGeneratorAcrossSurfaces: surfaceResults.every(row => row.learnedRecordIds.includes(expectedSurfaceAddition.generatorId)),
      exactOperatorAcrossSurfaces: surfaceResults.every(row => row.learnedRecordIds.includes(expectedSurfaceAddition.operatorId)),
      sameAnswerAcrossSurfaces: new Set(surfaceResults.map(row => row.answer)).size === 1
    } : {}),
    ...(expectedStateMachineRecord ? {
      exactStateMachineAcrossSurfaces: surfaceResults.every(row => row.learnedRecordIds.includes(expectedStateMachineRecord.id))
    } : {}),
    noExternalModelCalls: surfaceResults.every(row => row.externalModelCalls === 0),
    allSurfacesReadOnly: surfaceResults.every(row => row.activeReadOnly && row.registryReadOnly),
    allSurfaceRowsPass: surfaceResults.every(row => row.passed)
  };

  const rollbackRoot = cloneRegistry('rollback');
  const rollback = worker('rollback', rollbackRoot);
  const rollbackChecks = {
    promotedHashWasCandidate: rollback.promoted.metadata?.candidateSha256 === candidateHash,
    rollbackTargetHashWasIncumbent: rollback.rollbackTargetHash === realBefore.current,
    restoredPriorHashExactly: rollback.after.currentHash === realBefore.current,
    rollbackLineageRecorded: rollback.after.registry?.metadata?.rollback === true,
    rollbackPointerRecorded: rollback.after.registry?.metadata?.rollbackTargetSha256 === realBefore.current
  };

  const interruptCurrentRoot = cloneRegistry('interrupt-current');
  const interruptCurrent = worker('interrupt-current', interruptCurrentRoot);
  const interruptRegistryRoot = cloneRegistry('interrupt-registry');
  const interruptRegistry = worker('interrupt-registry', interruptRegistryRoot);
  const interruptionChecks = {
    currentWriteRejected: interruptCurrent.error?.code === 'LARI_ATOMIC_WRITE_INTERRUPTED',
    currentIncumbentIntact: interruptCurrent.after.currentHash === interruptCurrent.before.currentHash,
    currentRegistryIntact: interruptCurrent.after.registryHash === interruptCurrent.before.registryHash,
    currentNoTemporaryActivation: interruptCurrent.after.temporaryFiles.length === 0,
    registryWriteRejected: interruptRegistry.error?.code === 'LARI_ATOMIC_WRITE_INTERRUPTED',
    registryIncumbentRestored: interruptRegistry.after.currentHash === interruptRegistry.before.currentHash,
    registryManifestRestored: interruptRegistry.after.registryHash === interruptRegistry.before.registryHash,
    registryNoTemporaryActivation: interruptRegistry.after.temporaryFiles.length === 0
  };

  const corruptRoot = cloneRegistry('corrupt');
  const corruptBackupCountBefore = fs.readdirSync(path.join(corruptRoot, 'current')).filter(name => /backup-\d+/.test(name)).length;
  const corruptPath = path.join(rehearsalRoot, 'corrupt', 'corrupted-candidate.json');
  writeExclusive(corruptPath, '{"schemaVersion":2,"modelId":"lari-local-model","compiledSkills":');
  const corrupt = worker('corrupt', corruptRoot, corruptPath);
  const corruptChecks = {
    candidateRejected: Boolean(corrupt.error),
    incumbentIntact: corrupt.after.currentHash === corrupt.before.currentHash,
    registryIntact: corrupt.after.registryHash === corrupt.before.registryHash,
    noTemporaryActivation: corrupt.after.temporaryFiles.length === 0,
    noBackupCreatedBeforeValidation: fs.readdirSync(path.join(corruptRoot, 'current')).filter(name => /backup-\d+/.test(name)).length
      === corruptBackupCountBefore
  };

  const noFallbackRoot = path.join(rehearsalRoot, 'no-fallback', 'registry');
  fs.mkdirSync(path.join(noFallbackRoot, 'current'), { recursive: true });
  fs.copyFileSync(path.join(realRegistryRoot, 'registry.json'), path.join(noFallbackRoot, 'registry.json'), fs.constants.COPYFILE_EXCL);
  const noFallback = worker('resolve', noFallbackRoot);
  const fallbackChecks = {
    noCurrentResolvedToDefault: noFallback.resolved.source === 'default' && noFallback.resolved.path === null,
    onlyCanonicalCandidateConsidered: noFallback.candidateList.length === 1 && noFallback.candidateList[0].id === 'canonical-current',
    canonicalMissingReported: noFallback.candidateList[0].exists === false,
    noBenchmarkRootOrCandidateFallback: !noFallback.candidateList.some(item => /benchmark|legacy|adapter|marathon/i.test(`${item.id} ${item.relativePath}`))
  };

  const realAfter = {
    current: sha256(path.join(realRegistryRoot, 'current', 'swarm-model.json')),
    registry: sha256(path.join(realRegistryRoot, 'registry.json')),
    legacyRoot: sha256(path.join(root, 'swarm-model.json'))
  };
  const candidateAfter = sha256(candidatePath);
  const gates = {
    promotionRehearsal: Object.values(promotionChecks).every(Boolean),
    rollbackRehearsal: Object.values(rollbackChecks).every(Boolean),
    interruptedPromotion: Object.values(interruptionChecks).every(Boolean),
    corruptedCandidate: Object.values(corruptChecks).every(Boolean),
    fallbackIsolation: Object.values(fallbackChecks).every(Boolean),
    coldStart: Object.values(coldStartChecks).every(Boolean),
    surfaceParity: Object.values(surfaceParityChecks).every(Boolean),
    realRegistryUntouched: JSON.stringify(realBefore) === JSON.stringify(realAfter),
    candidateUntouched: candidateAfter === candidateHash
  };
  const evidence = {
    schemaVersion: 1,
    stage: 3,
    createdAt: new Date().toISOString(),
    candidate: { path: relative(candidatePath), sha256: candidateHash, provenance },
    candidateAfter,
    realBefore,
    realAfter,
    promotionNamespace: relative(promotionRoot),
    promotedModelPath: relative(path.join(promotionRoot, 'current', 'swarm-model.json')),
    promotedRegistryPath: relative(path.join(promotionRoot, 'registry.json')),
    promotion: { result: promotion, checks: promotionChecks },
    coldStart: { result: coldStart, checks: coldStartChecks },
    publicSurfaceParity: { rows: surfaceResults, checks: surfaceParityChecks },
    rollback: { result: rollback, checks: rollbackChecks },
    interruption: { current: interruptCurrent, registry: interruptRegistry, checks: interruptionChecks },
    corruption: { result: corrupt, checks: corruptChecks },
    fallback: { result: noFallback, checks: fallbackChecks },
    gates
  };
  writeExclusive(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const promotionReport = `# Lari Consolidation Stage 3 Promotion Rehearsal\n\n`
    + `Candidate: \`${candidateHash}\`\n\nIsolated active model: \`${evidence.promotedModelPath}\`\n\n`
    + `${table(Object.entries(promotionChecks).map(([check, passed]) => ({ check, passed })), [{ label: 'Promotion check', value: row => row.check }, { label: 'Passed', value: row => row.passed }])}\n\n`
    + `Cold-start inference resolved the cloned registry, selected learned record \`${coldStart.selection?.learnedRecordId}\`, and left both model and registry hashes unchanged.\n`;
  writeExclusive(promotionReportPath, promotionReport);
  const rollbackReport = `# Lari Consolidation Stage 3 Rollback Rehearsal\n\n`
    + `${table(Object.entries(rollbackChecks).map(([check, passed]) => ({ check, passed })), [{ label: 'Rollback check', value: row => row.check }, { label: 'Passed', value: row => row.passed }])}\n\n`
    + `Prior active SHA-256 restored exactly: \`${rollback.after.currentHash}\`.\n`;
  writeExclusive(rollbackReportPath, rollbackReport);
  const faultRows = [
    ...Object.entries(interruptionChecks).map(([check, passed]) => ({ scenario: 'interruption', check, passed })),
    ...Object.entries(corruptChecks).map(([check, passed]) => ({ scenario: 'corrupt candidate', check, passed })),
    ...Object.entries(fallbackChecks).map(([check, passed]) => ({ scenario: 'fallback isolation', check, passed }))
  ];
  const faultReport = `# Lari Consolidation Stage 3 Fault Injection\n\n`
    + `${table(faultRows, [{ label: 'Scenario', value: row => row.scenario }, { label: 'Check', value: row => row.check }, { label: 'Passed', value: row => row.passed }])}\n`;
  writeExclusive(faultReportPath, faultReport);
  for (const artifact of [evidencePath, promotionReportPath, rollbackReportPath, faultReportPath]) fs.chmodSync(artifact, 0o444);
  process.stdout.write(`${JSON.stringify({ candidateHash, promotionChecks, rollbackChecks, interruptionChecks, corruptChecks, fallbackChecks, coldStartChecks, gates }, null, 2)}\n`);
  if (!Object.values(gates).every(Boolean)) process.exitCode = 1;
}

main();
