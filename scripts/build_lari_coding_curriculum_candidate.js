#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const PARENT_HASH = 'dfea35336648c4a23c146c96231c19fad7bacab82922bfb849daedd88e09cc2c';
const parentPath = path.join(ROOT, 'consolidation', 'learning-candidates', `${PARENT_HASH}.json`);
const activePath = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const registryPath = path.join(ROOT, 'models', 'lari', 'registry.json');
const outputRoot = path.join(ROOT, 'consolidation', 'coding-curriculum-20260722');
const workspaceRoot = path.join(outputRoot, 'workspaces');
const candidateDir = path.join(ROOT, 'consolidation', 'learning-candidates');

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function resetDir(target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

function runNodeTest(root, testPath) {
  try {
    const output = execFileSync(process.execPath, [testPath], {
      cwd: root,
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

function runPythonTest(root, testPath) {
  try {
    const output = execFileSync('python', [testPath], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: root },
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

function seedTrainingWorkspace(root) {
  resetDir(root);
  writeFile(root, 'src/capacity.js',
    'function calculateCapacity(nodes, slotsPerNode) {\n' +
    '  return nodes + slotsPerNode;\n' +
    '}\n\n' +
    'module.exports = { calculateCapacity };\n');
  writeFile(root, 'tests/capacity.test.js',
    'const assert = require("assert");\n' +
    'const { calculateCapacity } = require("../src/capacity");\n' +
    'const cases = [[3, 4, 12], [1, 8, 8], [0, 5, 0], [7, 2, 14]];\n' +
    'for (const [nodes, slots, expected] of cases) {\n' +
    '  assert.strictEqual(calculateCapacity(nodes, slots), expected);\n' +
    '}\n' +
    'console.log("capacity behavior verified");\n');
}

function seedTransferWorkspace(root) {
  resetDir(root);
  writeFile(root, 'scheduler/__init__.py', '');
  writeFile(root, 'scheduler/load.py',
    'def estimate_load(worker_count, slots_each):\n' +
    '    return worker_count + slots_each\n');
  writeFile(root, 'checks/verify_load.py',
    'from scheduler.load import estimate_load\n\n' +
    'cases = [(2, 6, 12), (5, 3, 15), (0, 9, 0), (11, 1, 11)]\n' +
    'for workers, slots, expected in cases:\n' +
    '    assert estimate_load(workers, slots) == expected\n' +
    'print("scheduler load behavior verified")\n');
}

function kernelContext(modelHash, reuseOnly = false) {
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
      failureLearning: reuseOnly ? {
        allowExpressionOperatorDiscovery: false,
        allowSemanticOperatorDiscovery: false,
        coordinatedProgramSearch: false,
        expressionCandidateLimit: 0
      } : {
        expressionCandidateLimit: 40
      },
      executionContract: {
        workspaceExecution: reuseOnly ? {
          allowExpressionOperatorDiscovery: false,
          allowSemanticOperatorDiscovery: false,
          coordinatedProgramSearch: false
        } : {
          expressionCandidateLimit: 40
        }
      }
    }
  };
}

function codingRequest(root, testPath, expressionTarget) {
  return {
    prompt: 'Fix this failing coding repository. Diagnose the behavioral failure, isolate the cause, patch the smallest relevant expression, and verify the tests.',
    workspaceRoot: root,
    testPath,
    expressionTarget,
    preserveLayout: true
  };
}

function summarizeResponse(response) {
  const binding = response.executionBinding || null;
  const workspaceExecution = binding?.workspaceExecution || null;
  return {
    action: response.action || null,
    passed: response.passed === true,
    modelHash: response.modelHash || null,
    capabilitySelection: response.capabilitySelection || null,
    selectedLearnedRecordIds: response.learnedRecordIds || [],
    executionSkillId: binding?.skillId || null,
    executionLearnedRecordId: binding?.learnedRecordId || null,
    appliedOperatorRecordId: binding?.appliedOperatorRecordId || null,
    executionVerified: binding?.verified === true,
    evidenceGrade: binding?.evidenceGrade || workspaceExecution?.runnerVerification?.evidenceGrade || null,
    baselineFailureObserved: workspaceExecution?.runnerVerification?.baselineFailureObserved === true,
    failBeforePassAfter: workspaceExecution?.runnerVerification?.exactDeclaredRunnerFailToPass === true,
    oracleImmutable: workspaceExecution?.runnerVerification?.oracleImmutable === true,
    diagnostic: response.transientDiagnostics || workspaceExecution?.diagnostic || null,
    repairAttemptLedger: response.transientDiagnostics?.attemptLedger || workspaceExecution?.diagnostic?.attemptLedger || null,
    expressionRepair: workspaceExecution?.expressionRepair || null,
    fallbackReason: response.fallbackReason || null,
    externalModelCalls: response.external_model_calls ?? 0
  };
}

async function main() {
  const before = {
    parent: sha256File(parentPath),
    active: sha256File(activePath),
    registry: sha256File(registryPath)
  };
  if (before.parent !== PARENT_HASH) throw new Error('Parent candidate content hash does not match its filename');

  const parent = JSON.parse(fs.readFileSync(parentPath, 'utf8'));
  const parentRecordIds = new Set((parent.lariLearnedRecords?.records || []).map(record => record.id));
  const trainingRoot = path.join(workspaceRoot, 'training-javascript');
  seedTrainingWorkspace(trainingRoot);
  const trainingSource = path.join(trainingRoot, 'src', 'capacity.js');
  const trainingTest = 'tests/capacity.test.js';
  const trainingSourceBefore = sha256File(trainingSource);
  const trainingBaseline = runNodeTest(trainingRoot, trainingTest);
  if (trainingBaseline.passed) throw new Error('Training repository must fail before learning');

  const learningModel = clone(parent);
  const trainingResponse = await runtime.sendMessageToLariAsync(
    learningModel,
    codingRequest(trainingRoot, trainingTest, 'src/capacity.js'),
    kernelContext(PARENT_HASH, false)
  );
  const training = summarizeResponse(trainingResponse);
  const trainingAfter = runNodeTest(trainingRoot, trainingTest);
  if (!trainingAfter.passed || !training.executionVerified) {
    throw new Error(`Training repair did not verify: ${JSON.stringify(training, null, 2)}`);
  }

  const learnedRecords = (learningModel.lariLearnedRecords?.records || [])
    .filter(record => !parentRecordIds.has(record.id));
  if (learnedRecords.length !== 1) {
    throw new Error(`Expected exactly one new typed record, found ${learnedRecords.length}`);
  }
  const learnedRecord = learnedRecords[0];
  if (learnedRecord.id !== training.appliedOperatorRecordId) {
    throw new Error('Applied operator and newly retained record differ');
  }
  const serializedRecord = JSON.stringify(learnedRecord);
  if (/DiagnosticHypothesis|TransientDiagnosticTrace|capacity|slotsPerNode|estimate_load|worker_count/.test(serializedRecord)) {
    throw new Error('Learned record contains transient diagnosis or task-specific names');
  }

  const candidate = clone(parent);
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  candidate.lariLearnedRecords.records = [
    clone(learnedRecord),
    ...candidate.lariLearnedRecords.records.filter(record => record.id !== learnedRecord.id)
  ];
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: PARENT_HASH,
    developmentalEvent: 'failure_driven_expression_operator_curriculum',
    sourceLearnedRecordId: learnedRecord.id,
    createdAt: new Date().toISOString(),
    promoted: false
  };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha256Bytes(candidateBytes);
  const candidatePath = path.join(candidateDir, `${candidateHash}.json`);
  fs.mkdirSync(candidateDir, { recursive: true });
  if (fs.existsSync(candidatePath)) {
    if (sha256File(candidatePath) !== candidateHash) throw new Error('Existing candidate path has wrong content');
  } else {
    fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });
  }

  const parentTransferRoot = path.join(workspaceRoot, 'unseen-python-parent');
  const childTransferRoot = path.join(workspaceRoot, 'unseen-python-child');
  seedTransferWorkspace(parentTransferRoot);
  seedTransferWorkspace(childTransferRoot);
  const parentTransferBaseline = runPythonTest(parentTransferRoot, 'checks/verify_load.py');
  const childTransferBaseline = runPythonTest(childTransferRoot, 'checks/verify_load.py');
  if (parentTransferBaseline.passed || childTransferBaseline.passed) {
    throw new Error('Unseen transfer twins must both fail before execution');
  }

  const parentTransferResponse = await runtime.sendMessageToLariAsync(
    clone(parent),
    codingRequest(parentTransferRoot, 'checks/verify_load.py', 'scheduler/load.py'),
    kernelContext(PARENT_HASH, true)
  );
  const parentTransfer = summarizeResponse(parentTransferResponse);
  const parentTransferAfter = runPythonTest(parentTransferRoot, 'checks/verify_load.py');

  const reloadedChild = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const childTransferResponse = await runtime.sendMessageToLariAsync(
    reloadedChild,
    codingRequest(childTransferRoot, 'checks/verify_load.py', 'scheduler/load.py'),
    kernelContext(candidateHash, true)
  );
  const childTransfer = summarizeResponse(childTransferResponse);
  const childTransferAfter = runPythonTest(childTransferRoot, 'checks/verify_load.py');

  const after = {
    parent: sha256File(parentPath),
    candidate: sha256File(candidatePath),
    active: sha256File(activePath),
    registry: sha256File(registryPath)
  };
  const gates = {
    trainingFailedBefore: trainingBaseline.passed === false,
    typedDiagnosticCreated: training.diagnostic?.hypotheses?.some(item => item.kind === 'DiagnosticHypothesis') === true,
    diagnosticSupported: training.diagnostic?.supportedHypothesisId != null,
    boundedRelaxationUsed: Array.isArray(training.diagnostic?.scopePasses)
      && training.diagnostic.scopePasses.some(item => item.status === 'verified'),
    sharedAttemptLedgerUsed: Number(training.repairAttemptLedger?.executedAttemptCount || 0) > 0,
    trainingPassedAfter: trainingAfter.passed === true,
    nativeFailBeforePassAfter: training.failBeforePassAfter,
    immutableOracle: training.oracleImmutable,
    oneTypedRecordRetained: learnedRecords.length === 1 && learnedRecord.type === 'operator',
    transientDiagnosisNotRetained: !/DiagnosticHypothesis|TransientDiagnosticTrace/.test(serializedRecord),
    noTaskSpecificNamesRetained: !/capacity|slotsPerNode|estimate_load|worker_count/.test(serializedRecord),
    candidateReloaded: sha256File(candidatePath) === candidateHash,
    parentCannotReuseUnlearnedOperator: parentTransfer.executionVerified === false && parentTransferAfter.passed === false,
    childReusesSameOperator: childTransfer.executionVerified === true
      && childTransfer.appliedOperatorRecordId === learnedRecord.id,
    unseenPythonTransferPassed: childTransferAfter.passed === true,
    discoveryDisabledDuringTransfer: childTransfer.expressionRepair?.mode === 'retained_operator',
    noFallback: training.fallbackReason == null && childTransfer.fallbackReason == null,
    noExternalModelCalls: training.externalModelCalls === 0 && childTransfer.externalModelCalls === 0,
    parentImmutable: before.parent === after.parent,
    activeReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry,
    candidateUnpromoted: candidate.lineage.promoted === false
  };
  const passed = Object.values(gates).every(Boolean);
  const evidence = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
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
      sourceBeforeSha256: trainingSourceBefore,
      after: trainingAfter,
      response: training
    },
    transferAblation: {
      parent: { baseline: parentTransferBaseline, response: parentTransfer, after: parentTransferAfter },
      child: { baseline: childTransferBaseline, response: childTransfer, after: childTransferAfter }
    },
    learnedRecord,
    before,
    after,
    gates,
    passed,
    externalModelCalls: 0,
    verdict: passed ? 'CODING CURRICULUM CANDIDATE PASSED' : 'CODING CURRICULUM CANDIDATE FAILED'
  };
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'candidate-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, 'candidate-report.md'),
    `# Lari failure-driven coding curriculum\n\n` +
    `Parent: \`${PARENT_HASH}\`\n\n` +
    `Candidate: \`${candidateHash}\` (unpromoted)\n\n` +
    `Learned record: \`${learnedRecord.id}\`\n\n` +
    `The parent failed the unseen Python repository in reuse-only mode. The reloaded child selected the retained typed operator and passed the same behavior without discovery, fallback, or an external model call.\n\n` +
    `Verdict: **${evidence.verdict}**\n`);
  process.stdout.write(`${JSON.stringify({
    passed,
    candidate: evidence.candidate,
    training: {
      action: training.action,
      executionSkillId: training.executionSkillId,
      appliedOperatorRecordId: training.appliedOperatorRecordId,
      diagnosticHypothesisCount: training.diagnostic?.hypotheses?.length || 0,
      attemptCount: training.repairAttemptLedger?.executedAttemptCount || 0,
      afterPassed: trainingAfter.passed
    },
    transfer: {
      parentPassed: parentTransferAfter.passed,
      childPassed: childTransferAfter.passed,
      childMode: childTransfer.expressionRepair?.mode || null,
      appliedOperatorRecordId: childTransfer.appliedOperatorRecordId
    },
    gates,
    verdict: evidence.verdict
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
