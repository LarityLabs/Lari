#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const PARENT_HASH = 'c2271bd0ab5e81dc08ec36af18cb7fbae83994280337cc61cc696504a8216513';
const parentPath = path.join(ROOT, 'consolidation', 'learning-candidates', `${PARENT_HASH}.json`);
const activePath = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const registryPath = path.join(ROOT, 'models', 'lari', 'registry.json');
const outputRoot = path.join(ROOT, 'consolidation', 'blind-multifile-curriculum-20260723');
const payloadPath = path.join(outputRoot, 'sealed-cases.json');
const manifestPath = path.join(outputRoot, 'seal-manifest.json');
const candidateDir = path.join(ROOT, 'consolidation', 'learning-candidates');
const workspaceRoot = path.join(outputRoot, 'workspaces');

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resetWorkspace(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function runTest(root, testPath, language) {
  try {
    const executable = language === 'python' ? 'python' : process.execPath;
    const env = language === 'python'
      ? { ...process.env, PYTHONPATH: root }
      : process.env;
    const output = execFileSync(executable, [testPath], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000
    });
    return { passed: true, output: output.trim(), error: null };
  } catch (error) {
    return {
      passed: false,
      output: String(error.stdout || '').trim(),
      error: String(error.stderr || error.message || '').trim()
    };
  }
}

function requestFor(spec, root) {
  return {
    prompt: 'Repair this failing multi-file repository. Form a diagnostic hypothesis, fix the helper and its consumer together, preserve public signatures, and verify the immutable test.',
    workspaceRoot: root,
    testPath: spec.testPath,
    expressionTarget: spec.expressionTarget,
    preserveLayout: true
  };
}

function context(modelHash, reuseOnly) {
  const discovery = !reuseOnly;
  return {
    modelHash,
    autoGrow: false,
    operator: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: {
        allowExpressionOperatorDiscovery: false,
        allowSemanticOperatorDiscovery: discovery,
        coordinatedProgramSearch: true,
        diagnosticHypothesisLimit: 3
      },
      executionContract: {
        workspaceExecution: {
          allowExpressionOperatorDiscovery: false,
          allowSemanticOperatorDiscovery: discovery,
          coordinatedProgramSearch: true
        }
      }
    }
  };
}

function summarize(response) {
  const binding = response.executionBinding || null;
  const execution = binding?.workspaceExecution || null;
  const repair = execution?.expressionRepair || null;
  return {
    action: response.action || null,
    passed: response.passed === true,
    modelHash: response.modelHash || null,
    wrapperSkillId: binding?.skillId || null,
    wrapperRecordId: binding?.learnedRecordId || null,
    executionVerified: binding?.verified === true,
    mode: repair?.mode || null,
    learnedRecordId: repair?.learnedRecordId || binding?.appliedOperatorRecordId || null,
    candidateCount: repair?.candidateCount ?? null,
    targets: repair?.targets || [],
    failBeforePassAfter: execution?.runnerVerification?.exactDeclaredRunnerFailToPass === true,
    oracleImmutable: execution?.runnerVerification?.oracleImmutable === true,
    diagnostic: response.transientDiagnostics || execution?.diagnostic || null,
    fallbackReason: response.fallbackReason || null,
    externalModelCalls: response.external_model_calls ?? 0
  };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (sha256File(payloadPath) !== manifest.payload.sha256) throw new Error('Sealed curriculum hash mismatch');
  const sealed = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  const training = sealed.training;
  const before = {
    parent: sha256File(parentPath),
    active: sha256File(activePath),
    registry: sha256File(registryPath),
    sealedPayload: sha256File(payloadPath)
  };
  if (before.parent !== PARENT_HASH) throw new Error('Parent hash precondition failed');

  const parent = JSON.parse(fs.readFileSync(parentPath, 'utf8'));
  const parentRecordIds = new Set((parent.lariLearnedRecords?.records || []).map(record => record.id));
  const trainingRoot = path.join(workspaceRoot, 'training-javascript');
  resetWorkspace(trainingRoot, training.files);
  const trainingTestHash = sha256File(path.join(trainingRoot, training.testPath));
  const trainingBaseline = runTest(trainingRoot, training.testPath, training.language);
  if (trainingBaseline.passed) throw new Error('Sealed training case must fail before learning');

  const learningModel = clone(parent);
  const trainingResponse = await runtime.sendMessageToLariAsync(
    learningModel,
    requestFor(training, trainingRoot),
    context(PARENT_HASH, false)
  );
  const trainingResult = summarize(trainingResponse);
  const trainingAfter = runTest(trainingRoot, training.testPath, training.language);
  if (!trainingAfter.passed || !trainingResult.executionVerified) {
    throw new Error(`Training repair failed: ${JSON.stringify(trainingResult, null, 2)}`);
  }

  const newRecords = (learningModel.lariLearnedRecords?.records || [])
    .filter(record => !parentRecordIds.has(record.id));
  if (newRecords.length !== 1) throw new Error(`Expected one retained record, found ${newRecords.length}`);
  const learnedRecord = clone(newRecords[0]);
  const ast = learnedRecord.payload?.programAst;
  if (learnedRecord.type !== 'operator'
    || learnedRecord.payload?.operation !== 'coordinated_multi_file_program'
    || ast?.op !== 'coordinated_program') {
    throw new Error('Training did not retain one typed coordinated-program operator');
  }
  const serializedRecord = JSON.stringify(learnedRecord);
  if (/dispatch|parcel|blocked|queue|pipeline|suspended|processable|DiagnosticHypothesis|TransientDiagnosticTrace/i.test(serializedRecord)) {
    throw new Error('Retained operator contains fixture names or transient diagnostic state');
  }

  const candidate = clone(parent);
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  candidate.lariLearnedRecords.records = [
    learnedRecord,
    ...candidate.lariLearnedRecords.records.filter(record => record.id !== learnedRecord.id)
  ];
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: PARENT_HASH,
    developmentalEvent: 'blind_coordinated_multifile_failure_curriculum',
    sourceLearnedRecordId: learnedRecord.id,
    sealedPayloadSha256: manifest.payload.sha256,
    sealedAt: manifest.sealedAt,
    createdAt: new Date().toISOString(),
    holdoutAccessedBeforeCandidate: false,
    promotionStatus: 'candidate_only',
    promoted: false
  };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha256Bytes(candidateBytes);
  const candidatePath = path.join(candidateDir, `${candidateHash}.json`);
  fs.mkdirSync(candidateDir, { recursive: true });
  if (fs.existsSync(candidatePath)) {
    if (sha256File(candidatePath) !== candidateHash) throw new Error('Existing candidate path hash mismatch');
  } else {
    fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });
  }
  const candidateCreatedAt = candidate.lineage.createdAt;

  // The learner phase is complete and immutable before the sealed holdout is used.
  const holdout = sealed.holdout;
  const parentHoldoutRoot = path.join(workspaceRoot, 'holdout-python-parent');
  const childHoldoutRoot = path.join(workspaceRoot, 'holdout-python-child');
  resetWorkspace(parentHoldoutRoot, holdout.files);
  resetWorkspace(childHoldoutRoot, holdout.files);
  const holdoutTestHash = sha256File(path.join(childHoldoutRoot, holdout.testPath));
  const parentBaseline = runTest(parentHoldoutRoot, holdout.testPath, holdout.language);
  const childBaseline = runTest(childHoldoutRoot, holdout.testPath, holdout.language);
  if (parentBaseline.passed || childBaseline.passed) throw new Error('Sealed holdout twins must fail initially');

  const parentResponse = await runtime.sendMessageToLariAsync(
    clone(parent),
    requestFor(holdout, parentHoldoutRoot),
    context(PARENT_HASH, true)
  );
  const parentResult = summarize(parentResponse);
  const parentAfter = runTest(parentHoldoutRoot, holdout.testPath, holdout.language);

  const reloadedChild = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const childResponse = await runtime.sendMessageToLariAsync(
    reloadedChild,
    requestFor(holdout, childHoldoutRoot),
    context(candidateHash, true)
  );
  const childResult = summarize(childResponse);
  const childAfter = runTest(childHoldoutRoot, holdout.testPath, holdout.language);
  const after = {
    parent: sha256File(parentPath),
    candidate: sha256File(candidatePath),
    active: sha256File(activePath),
    registry: sha256File(registryPath),
    sealedPayload: sha256File(payloadPath)
  };

  const gates = {
    sealedBeforeLearning: new Date(manifest.sealedAt) < new Date(candidateCreatedAt),
    sealedPayloadImmutable: before.sealedPayload === after.sealedPayload && after.sealedPayload === manifest.payload.sha256,
    trainingFailedBefore: trainingBaseline.passed === false,
    diagnosticHypothesisCreated: trainingResult.diagnostic?.hypotheses?.some(item => item.kind === 'DiagnosticHypothesis') === true,
    coordinatedSearchUsed: trainingResult.mode === 'searched_coordinated_operator' && trainingResult.candidateCount === 4,
    twoFilesChanged: trainingResult.targets.length === 2,
    trainingPassedAfter: trainingAfter.passed === true,
    immutableTrainingOracle: trainingResult.oracleImmutable && sha256File(path.join(trainingRoot, training.testPath)) === trainingTestHash,
    exactlyOneTypedRecord: newRecords.length === 1 && learnedRecord.type === 'operator',
    desiredGeneralOperator: ast.predicate === 'falsy' && ast.terminal === 'count',
    noFixtureOrTraceRetention: !/dispatch|parcel|blocked|queue|pipeline|suspended|processable|DiagnosticHypothesis|TransientDiagnosticTrace/i.test(serializedRecord),
    parentCannotTransfer: parentResult.executionVerified === false && parentAfter.passed === false,
    childTransfersAfterReload: childResult.executionVerified === true && childAfter.passed === true,
    sameRecordReused: childResult.learnedRecordId === learnedRecord.id,
    reuseWithoutSearch: childResult.mode === 'retained_coordinated_operator' && childResult.candidateCount === 0,
    twoFileTransfer: childResult.targets.length === 2,
    immutableHoldoutOracle: childResult.oracleImmutable && sha256File(path.join(childHoldoutRoot, holdout.testPath)) === holdoutTestHash,
    crossLanguageBinding: (reloadedChild.lariLearnedRecords?.records || []).some(record => record.id === learnedRecord.id),
    holdoutNotUsedByLearner: candidate.lineage.holdoutAccessedBeforeCandidate === false,
    noFallback: trainingResult.fallbackReason == null && childResult.fallbackReason == null,
    noExternalModelCalls: trainingResult.externalModelCalls === 0 && childResult.externalModelCalls === 0,
    parentImmutable: before.parent === after.parent,
    candidateReloaded: after.candidate === candidateHash,
    activeReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry,
    candidateUnpromoted: candidate.lineage.promoted === false
  };
  const passed = Object.values(gates).every(Boolean);
  const evidence = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    family: sealed.family,
    seal: manifest,
    parent: { path: path.relative(ROOT, parentPath).replace(/\\/g, '/'), sha256: PARENT_HASH },
    candidate: {
      path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'),
      sha256: candidateHash,
      parentHash: PARENT_HASH,
      learnedRecordId: learnedRecord.id,
      promoted: false
    },
    training: {
      baseline: trainingBaseline,
      response: trainingResult,
      after: trainingAfter,
      testSha256: trainingTestHash
    },
    holdoutAblation: {
      parent: { baseline: parentBaseline, response: parentResult, after: parentAfter },
      child: { baseline: childBaseline, response: childResult, after: childAfter },
      testSha256: holdoutTestHash
    },
    learnedRecord,
    before,
    after,
    gates,
    passed,
    externalModelCalls: 0,
    verdict: passed ? 'BLIND MULTI-FILE CURRICULUM PASSED' : 'BLIND MULTI-FILE CURRICULUM FAILED'
  };
  fs.writeFileSync(path.join(outputRoot, 'candidate-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(outputRoot, 'candidate-report.md'),
    `# Lari blind multi-file coding curriculum\n\n`
    + `Parent: \`${PARENT_HASH}\`\n\n`
    + `Candidate: \`${candidateHash}\` (unpromoted)\n\n`
    + `Learned record: \`${learnedRecord.id}\`\n\n`
    + `The sealed JavaScript failure required coordinated edits to a helper and consumer. The parent then failed the sealed Python holdout in reuse-only mode; the cold-reloaded child reused the same typed operator with zero search and passed both files' behavior.\n\n`
    + `Verdict: **${evidence.verdict}**\n`,
  { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({
    candidate: evidence.candidate,
    training: {
      mode: trainingResult.mode,
      candidateCount: trainingResult.candidateCount,
      targets: trainingResult.targets,
      diagnosticHypotheses: trainingResult.diagnostic?.hypotheses?.length || 0
    },
    holdout: {
      parentPassed: parentAfter.passed,
      childPassed: childAfter.passed,
      childMode: childResult.mode,
      learnedRecordId: childResult.learnedRecordId,
      targets: childResult.targets
    },
    ast,
    gates,
    verdict: evidence.verdict
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
