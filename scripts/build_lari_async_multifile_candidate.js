#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const PARENT_HASH = '0c5c55b4c99c6463aa0cccdfc6e3d28a9d9654c6eac480ca25c9564e4ad81e58';
const parentPath = path.join(ROOT, 'consolidation', 'learning-candidates', `${PARENT_HASH}.json`);
const activePath = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const registryPath = path.join(ROOT, 'models', 'lari', 'registry.json');
const outputRoot = path.join(ROOT, 'consolidation', 'async-multifile-curriculum-20260723');
const payloadPath = path.join(outputRoot, 'sealed-cases.json');
const manifestPath = path.join(outputRoot, 'seal-manifest.json');
const candidateDir = path.join(ROOT, 'consolidation', 'learning-candidates');
const workspaceRoot = path.join(outputRoot, 'workspaces');

const sha256Bytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha256File = filePath => sha256Bytes(fs.readFileSync(filePath));
const clone = value => JSON.parse(JSON.stringify(value));

function resetWorkspace(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function runTest(root, spec) {
  try {
    const executable = spec.language === 'python' ? 'python' : process.execPath;
    const env = spec.language === 'python' ? { ...process.env, PYTHONPATH: root } : process.env;
    const output = execFileSync(executable, [spec.testPath], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000
    });
    return { passed: true, output: output.trim(), error: null };
  } catch (error) {
    return { passed: false, output: String(error.stdout || '').trim(), error: String(error.stderr || error.message || '').trim() };
  }
}

function requestFor(spec, root) {
  return {
    prompt: 'Repair this failing async multi-file repository. Form a diagnostic hypothesis, preserve async signatures, fix the dependency helper and awaiting consumer together, and verify the immutable test.',
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
  if (sha256File(parentPath) !== PARENT_HASH) throw new Error('Parent hash precondition failed');
  const sealed = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  const before = {
    parent: sha256File(parentPath),
    active: sha256File(activePath),
    registry: sha256File(registryPath),
    sealedPayload: sha256File(payloadPath)
  };
  const parent = JSON.parse(fs.readFileSync(parentPath, 'utf8'));
  const parentRecordIds = new Set((parent.lariLearnedRecords?.records || []).map(record => record.id));

  const trainingRoot = path.join(workspaceRoot, 'training-javascript');
  resetWorkspace(trainingRoot, sealed.training.files);
  const trainingTestHash = sha256File(path.join(trainingRoot, sealed.training.testPath));
  const trainingBaseline = runTest(trainingRoot, sealed.training);
  if (trainingBaseline.passed) throw new Error('Training case must fail before learning');
  const learningModel = clone(parent);
  const trainingResponse = await runtime.sendMessageToLariAsync(
    learningModel,
    requestFor(sealed.training, trainingRoot),
    context(PARENT_HASH, false)
  );
  const trainingResult = summarize(trainingResponse);
  const trainingAfter = runTest(trainingRoot, sealed.training);
  if (!trainingAfter.passed || !trainingResult.executionVerified) {
    throw new Error(`Training repair failed: ${JSON.stringify(trainingResult, null, 2)}`);
  }

  const newRecords = (learningModel.lariLearnedRecords?.records || []).filter(record => !parentRecordIds.has(record.id));
  if (newRecords.length !== 1) throw new Error(`Expected one retained record, found ${newRecords.length}`);
  const learnedRecord = clone(newRecords[0]);
  const ast = learnedRecord.payload?.programAst;
  if (learnedRecord.type !== 'operator'
    || learnedRecord.payload?.operation !== 'coordinated_multi_file_program'
    || ast?.op !== 'coordinated_async_pipeline') {
    throw new Error('Training did not retain one typed async coordinated operator');
  }
  const serializedRecord = JSON.stringify(learnedRecord);
  if (/ticket|closed|priority|loadTickets|openPriorities|paused|ready_scores|collect_jobs|DiagnosticHypothesis|TransientDiagnosticTrace/i.test(serializedRecord)) {
    throw new Error('Retained operator contains fixture names or transient diagnostic state');
  }

  const candidate = clone(parent);
  candidate.lariLearnedRecords.records = [
    learnedRecord,
    ...candidate.lariLearnedRecords.records.filter(record => record.id !== learnedRecord.id)
  ];
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: PARENT_HASH,
    developmentalEvent: 'blind_async_coordinated_multifile_failure_curriculum',
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
  fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });
  fs.chmodSync(candidatePath, 0o444);

  const holdout = sealed.holdout;
  const parentRoot = path.join(workspaceRoot, 'holdout-python-parent');
  const childRoot = path.join(workspaceRoot, 'holdout-python-child');
  resetWorkspace(parentRoot, holdout.files);
  resetWorkspace(childRoot, holdout.files);
  const holdoutTestHash = sha256File(path.join(childRoot, holdout.testPath));
  const parentBaseline = runTest(parentRoot, holdout);
  const childBaseline = runTest(childRoot, holdout);
  if (parentBaseline.passed || childBaseline.passed) throw new Error('Holdout twins must fail initially');
  const parentResult = summarize(await runtime.sendMessageToLariAsync(clone(parent), requestFor(holdout, parentRoot), context(PARENT_HASH, true)));
  const parentAfter = runTest(parentRoot, holdout);
  const reloadedChild = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const childResult = summarize(await runtime.sendMessageToLariAsync(reloadedChild, requestFor(holdout, childRoot), context(candidateHash, true)));
  const childAfter = runTest(childRoot, holdout);
  const after = {
    parent: sha256File(parentPath),
    candidate: sha256File(candidatePath),
    active: sha256File(activePath),
    registry: sha256File(registryPath),
    sealedPayload: sha256File(payloadPath)
  };
  const gates = {
    sealedBeforeLearning: new Date(manifest.sealedAt) < new Date(candidate.lineage.createdAt),
    sealedPayloadImmutable: before.sealedPayload === after.sealedPayload && after.sealedPayload === manifest.payload.sha256,
    trainingFailedBefore: trainingBaseline.passed === false,
    diagnosticHypothesisCreated: trainingResult.diagnostic?.hypotheses?.some(item => item.kind === 'DiagnosticHypothesis') === true,
    asyncCoordinatedSearchUsed: trainingResult.mode === 'searched_coordinated_operator' && trainingResult.candidateCount === 6,
    twoFilesChanged: trainingResult.targets.length === 2,
    trainingPassedAfter: trainingAfter.passed === true,
    immutableTrainingOracle: trainingResult.oracleImmutable && sha256File(path.join(trainingRoot, sealed.training.testPath)) === trainingTestHash,
    exactlyOneTypedRecord: newRecords.length === 1 && learnedRecord.type === 'operator',
    genericAsyncOperator: ast.predicate === 'falsy' && ast.terminal === 'list',
    noFixtureOrTraceRetention: !/ticket|closed|priority|loadTickets|openPriorities|paused|ready_scores|collect_jobs|DiagnosticHypothesis|TransientDiagnosticTrace/i.test(serializedRecord),
    parentCannotTransfer: parentResult.executionVerified === false && parentAfter.passed === false,
    childTransfersAfterReload: childResult.executionVerified === true && childAfter.passed === true,
    sameRecordReused: childResult.learnedRecordId === learnedRecord.id,
    reuseWithoutSearch: childResult.mode === 'retained_coordinated_operator' && childResult.candidateCount === 0,
    twoFileTransfer: childResult.targets.length === 2,
    immutableHoldoutOracle: childResult.oracleImmutable && sha256File(path.join(childRoot, holdout.testPath)) === holdoutTestHash,
    crossLanguageBinding: reloadedChild.lariLearnedRecords.records.some(record => record.id === learnedRecord.id),
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
    candidate: { path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'), sha256: candidateHash, parentHash: PARENT_HASH, learnedRecordId: learnedRecord.id, promoted: false },
    training: { baseline: trainingBaseline, response: trainingResult, after: trainingAfter, testSha256: trainingTestHash },
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
    verdict: passed ? 'BLIND ASYNC MULTI-FILE CURRICULUM PASSED' : 'BLIND ASYNC MULTI-FILE CURRICULUM FAILED'
  };
  fs.writeFileSync(path.join(outputRoot, 'candidate-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(outputRoot, 'candidate-report.md'),
    `# Lari blind async multi-file curriculum\n\nParent: \`${PARENT_HASH}\`\n\nCandidate: \`${candidateHash}\` (unpromoted)\n\nLearned record: \`${learnedRecord.id}\`\n\n`
    + 'The sealed JavaScript failure required coordinated async edits to a dependency helper and its awaiting consumer. The parent then failed the sealed Python holdout in reuse-only mode; the cold-reloaded child reused the same typed operator with zero search and passed.\n\n'
    + `Verdict: **${evidence.verdict}**\n`,
  { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ candidate: evidence.candidate, ast, training: trainingResult, holdout: { parent: parentResult, child: childResult }, gates, verdict: evidence.verdict }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
