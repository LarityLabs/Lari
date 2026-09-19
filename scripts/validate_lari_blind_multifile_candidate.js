#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const PARENT_HASH = 'c2271bd0ab5e81dc08ec36af18cb7fbae83994280337cc61cc696504a8216513';
const CANDIDATE_HASH = '0c5c55b4c99c6463aa0cccdfc6e3d28a9d9654c6eac480ca25c9564e4ad81e58';
const OPERATOR_RECORD_ID = 'lari.learned.operator.coordinated.25cea203';
const WRAPPER_SKILL_ID = 'skill.frontier_coding_repair_loop';
const parentPath = path.join(ROOT, 'consolidation', 'learning-candidates', `${PARENT_HASH}.json`);
const candidatePath = path.join(ROOT, 'consolidation', 'learning-candidates', `${CANDIDATE_HASH}.json`);
const activePath = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const registryPath = path.join(ROOT, 'models', 'lari', 'registry.json');
const proofRoot = path.join(ROOT, 'consolidation', 'blind-multifile-public-convergence-20260723');
const prompt = 'Repair this failing multi-file repository. Diagnose the shared behavior, patch the helper and consumer together, and verify the immutable tests.';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadCandidate() {
  return JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function seedWorkspace(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const helper = 'function isVisible(entry) {\n  return false;\n}\n\nmodule.exports = { isVisible };\n';
  const consumer = 'const { isVisible } = require("./access");\n\nfunction visibleCount(entries) {\n  return 0;\n}\n\nmodule.exports = { visibleCount };\n';
  const test = 'const assert = require("assert");\nconst { isVisible } = require("../src/access");\nconst { visibleCount } = require("../src/catalog");\nconst first = { archived: false, rank: 2 };\nconst hidden = { archived: true, rank: 9 };\nconst second = { archived: false, rank: 5 };\nassert.strictEqual(isVisible(first), true);\nassert.strictEqual(isVisible(hidden), false);\nassert.strictEqual(visibleCount([first, hidden, second]), 2);\nconsole.log("catalog behavior verified");\n';
  writeFile(root, 'src/access.js', helper);
  writeFile(root, 'src/catalog.js', consumer);
  writeFile(root, 'tests/catalog.test.js', test);
  return { helper, consumer, test };
}

function runTest(root) {
  try {
    execFileSync(process.execPath, ['tests/catalog.test.js'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000
    });
    return true;
  } catch (_) {
    return false;
  }
}

function requestFor(root) {
  return {
    prompt,
    workspaceRoot: root,
    testPath: 'tests/catalog.test.js',
    expressionTarget: 'src/catalog.js',
    preserveLayout: true
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalize(name, response, workspacePassed, extra = {}) {
  const lari = response?.lari || {};
  const selection = response?.capabilitySelection || response?.capability_selection || lari.capability_selection || null;
  const binding = response?.executionBinding || response?.execution_binding || lari.execution_binding || null;
  return {
    name,
    modelHash: response?.modelHash || response?.model_hash || lari.model_hash || selection?.modelHash || null,
    action: response?.action || lari.action || null,
    sourceSkillId: selection?.sourceSkillId || null,
    selectedLearnedRecordId: selection?.learnedRecordId || null,
    executionSkillId: binding?.skillId || null,
    appliedOperatorRecordId: binding?.appliedOperatorRecordId || null,
    executionVerified: binding?.verified === true,
    exactFailBeforePassAfter: binding?.workspaceExecution?.runnerVerification?.exactDeclaredRunnerFailToPass === true,
    oracleImmutable: binding?.workspaceExecution?.runnerVerification?.oracleImmutable === true,
    operatorMode: binding?.workspaceExecution?.expressionRepair?.mode || null,
    patchedTargets: binding?.workspaceExecution?.expressionRepair?.targets || [],
    workspacePassed,
    fallbackReason: response?.fallbackReason || response?.fallback_reason || lari.fallback_reason || null,
    externalModelCalls: response?.external_model_calls ?? 0,
    ...extra
  };
}

function parseCliDiagnostics(stdout) {
  const marker = stdout.lastIndexOf('\n---\n');
  assert(marker >= 0, 'CLI diagnostics marker missing');
  return JSON.parse(stdout.slice(marker + 5));
}

function runCli(root) {
  const run = spawnSync(process.execPath, [
    'scripts/lari_ask.js',
    '--model-path', candidatePath,
    '--workspace-root', root,
    '--test-path', 'tests/catalog.test.js',
    '--expression-target', 'src/catalog.js',
    '--debug',
    prompt
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LARI_AUTONOMOUS_LEARNING: '0', LARI_AUTONOMOUS_PROMOTION: '0' },
    timeout: 120000
  });
  assert(run.status === 0, run.stderr || run.stdout || 'CLI failed');
  return parseCliDiagnostics(run.stdout);
}

function startPython(args, env = {}) {
  return spawn('python', args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function canonicalContext(modelHash) {
  return {
    modelHash,
    autoGrow: false,
    operator: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 },
      failureLearning: {
        allowExpressionOperatorDiscovery: false,
        allowSemanticOperatorDiscovery: false,
        coordinatedProgramSearch: true
      }
    }
  };
}

function hiddenTransfer(model) {
  const records = (model.lariLearnedRecords?.records || [])
    .filter(record => record.provenance?.imported
      && record.type === 'knowledge'
      && !(record.provenance?.benchmarkAssociation || []).length
      && (record.normalizedTriggers || []).length >= 2)
    .slice(0, 17);
  const tests = records.map(record => {
    const transferPrompt = `In a new situation, what reusable guidance applies when ${record.normalizedTriggers.slice(0, 4).reverse().join(', ')} matter?`;
    const matches = runtime.searchKnowledge(clone(model), transferPrompt, { limit: 5, minScore: 0 }) || [];
    const routed = matches.some(match => (match.item?.id || match.id) === record.provenance.originalRecordId);
    const response = runtime.sendMessageToLari(clone(model), transferPrompt, canonicalContext(CANDIDATE_HASH));
    return { recordId: record.id, passed: routed && String(response.answer || '').length > 0 };
  });
  return {
    passedCount: tests.filter(test => test.passed).length,
    total: tests.length,
    passed: tests.length === 17 && tests.every(test => test.passed),
    tests
  };
}

function familyRegression(parent, candidate) {
  const prompts = {
    chat: 'Explain how durable local state supports a long-running conversation.',
    instruction: 'Give exactly two bullets about safe backups.',
    math: 'What is 18 plus 27?',
    multipleChoice: 'Which protects state? A) Delete B) Atomic backup C) Ignore errors D) Random rename',
    coding: 'Explain why coding repairs need fail-before/pass-after evidence.',
    research: 'Explain a source-grounded way to learn an unfamiliar topic.',
    product: 'Describe a verified local product improvement plan.',
    safety: 'Why verify destructive changes before applying them?'
  };
  const score = (model, modelHash, familyPrompt) => {
    const response = runtime.sendMessageToLari(clone(model), familyPrompt, canonicalContext(modelHash));
    return Number(response.passed !== false)
      + Number(response.passed === true)
      + Math.min(1, String(response.answer || '').length / 80);
  };
  const rows = Object.entries(prompts).map(([family, familyPrompt]) => {
    const before = score(parent, PARENT_HASH, familyPrompt);
    const after = score(candidate, CANDIDATE_HASH, familyPrompt);
    return { family, before, after, regressed: after + 0.0001 < before };
  });
  return { rows, passed: rows.every(row => !row.regressed) };
}

async function main() {
  assert(sha256File(parentPath) === PARENT_HASH, 'Parent hash mismatch');
  assert(sha256File(candidatePath) === CANDIDATE_HASH, 'Candidate hash mismatch');
  const before = {
    parent: sha256File(parentPath),
    candidate: sha256File(candidatePath),
    active: sha256File(activePath),
    registry: sha256File(registryPath)
  };
  const parent = JSON.parse(fs.readFileSync(parentPath, 'utf8'));
  const candidate = loadCandidate();
  const parentIds = new Set((parent.lariLearnedRecords?.records || []).map(record => record.id));
  const added = (candidate.lariLearnedRecords?.records || []).filter(record => !parentIds.has(record.id));

  fs.mkdirSync(proofRoot, { recursive: true });
  const roots = Object.fromEntries(['cli', 'api', 'autonomous', 'reload'].map(name => [
    name,
    path.join(proofRoot, 'workspaces', name)
  ]));
  for (const root of Object.values(roots)) {
    seedWorkspace(root);
    assert(!runTest(root), `${root} did not fail before Lari`);
  }

  const cliView = normalize('cli', runCli(roots.cli), runTest(roots.cli));
  const apiPort = 18767;
  const workbenchPort = 18002;
  const api = startPython([
    'scripts/lari_openai_server.py',
    '--host', '127.0.0.1',
    '--port', String(apiPort),
    '--model-path', candidatePath
  ]);
  const workbench = startPython(['start_workspace.py'], {
    LARI_MODEL_PATH: candidatePath,
    LARI_WORKSPACE_HOST: '127.0.0.1',
    LARI_WORKSPACE_PORT: String(workbenchPort),
    LARI_NO_BROWSER: '1',
    LARI_AUTONOMOUS_LEARNING: '0',
    LARI_AUTONOMOUS_PROMOTION: '0'
  });

  let apiCompletion;
  let workbenchResult;
  try {
    await Promise.all([
      waitFor(`http://127.0.0.1:${apiPort}/health`),
      waitFor(`http://127.0.0.1:${workbenchPort}/index.html`)
    ]);
    apiCompletion = await postJson(`http://127.0.0.1:${apiPort}/v1/chat/completions`, {
      model: 'lari',
      messages: [{ role: 'user', content: prompt }],
      include_diagnostics: true,
      lari_context: {
        workspaceRoot: roots.api,
        testPath: 'tests/catalog.test.js',
        expressionTarget: 'src/catalog.js',
        preserveLayout: true
      }
    });
    const fixture = seedWorkspace(path.join(proofRoot, 'workspaces', 'workbench-source'));
    workbenchResult = await postJson(`http://127.0.0.1:${workbenchPort}/api/lari/chat`, {
      prompt,
      includeDiagnostics: true,
      workspaceBundle: {
        files: [
          { path: 'src/access.js', content: fixture.helper },
          { path: 'src/catalog.js', content: fixture.consumer },
          { path: 'tests/catalog.test.js', content: fixture.test }
        ],
        testPath: 'tests/catalog.test.js',
        expressionTarget: 'src/catalog.js',
        preserveLayout: true
      }
    });
  } finally {
    api.kill();
    workbench.kill();
  }

  const apiView = normalize('openai_api', apiCompletion, runTest(roots.api));
  const patch = workbenchResult.workspace_patch;
  const workbenchPatched = patch?.verified === true && patch.files?.length === 2;
  const workbenchView = normalize('workbench', workbenchResult.response, workbenchPatched, {
    returnedVerifiedPatch: workbenchPatched,
    returnedPatchFileCount: patch?.files?.length || 0
  });
  const autonomousResponse = await runtime.runLariAutonomousRequest(
    loadCandidate(),
    requestFor(roots.autonomous),
    { modelHash: CANDIDATE_HASH }
  );
  const autonomousView = normalize('autonomous', autonomousResponse, runTest(roots.autonomous));
  const reloadResponse = await runtime.sendMessageToLariAsync(
    clone(loadCandidate()),
    requestFor(roots.reload),
    canonicalContext(CANDIDATE_HASH)
  );
  const reloadView = normalize('cold_reload', reloadResponse, runTest(roots.reload));
  const surfaces = [workbenchView, cliView, apiView, autonomousView];

  for (const surface of [...surfaces, reloadView]) {
    assert(surface.modelHash === CANDIDATE_HASH, `${surface.name} selected the wrong model`);
    assert(surface.sourceSkillId === WRAPPER_SKILL_ID, `${surface.name} selected the wrong wrapper`);
    assert(surface.executionSkillId === WRAPPER_SKILL_ID, `${surface.name} executed the wrong wrapper`);
    assert(surface.appliedOperatorRecordId === OPERATOR_RECORD_ID, `${surface.name} selected the wrong operator`);
    assert(surface.executionVerified, `${surface.name} did not verify execution`);
    assert(surface.exactFailBeforePassAfter, `${surface.name} lacks fail-before/pass-after`);
    assert(surface.oracleImmutable, `${surface.name} mutated its oracle`);
    assert(surface.operatorMode === 'retained_coordinated_operator', `${surface.name} searched instead of reusing`);
    assert(surface.patchedTargets.length === 2, `${surface.name} did not coordinate two files`);
    assert(surface.workspacePassed, `${surface.name} workspace failed`);
    assert(surface.fallbackReason == null, `${surface.name} used a fallback`);
    assert(surface.externalModelCalls === 0, `${surface.name} called an external model`);
  }

  const transfer = hiddenTransfer(candidate);
  const regression = familyRegression(parent, candidate);
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const after = {
    parent: sha256File(parentPath),
    candidate: sha256File(candidatePath),
    active: sha256File(activePath),
    registry: sha256File(registryPath)
  };
  const gates = {
    exactlyOneTypedRecordAdded: added.length === 1 && added[0].id === OPERATOR_RECORD_ID && added[0].type === 'operator',
    sameHashParity: surfaces.every(surface => surface.modelHash === CANDIDATE_HASH),
    sameWrapperParity: surfaces.every(surface => surface.sourceSkillId === WRAPPER_SKILL_ID),
    sameOperatorParity: surfaces.every(surface => surface.appliedOperatorRecordId === OPERATOR_RECORD_ID),
    retainedOperatorOnly: surfaces.every(surface => surface.operatorMode === 'retained_coordinated_operator'),
    twoFileExecution: surfaces.every(surface => surface.patchedTargets.length === 2),
    failBeforePassAfter: surfaces.every(surface => surface.exactFailBeforePassAfter),
    immutableOracles: surfaces.every(surface => surface.oracleImmutable),
    workbenchTwoFilePatchRoundTrip: workbenchView.returnedVerifiedPatch && workbenchView.returnedPatchFileCount === 2,
    hiddenTransfer17Of17: transfer.passed,
    zeroFamilyRegressions: regression.passed,
    reloadRetention: reloadView.executionVerified
      && reloadView.appliedOperatorRecordId === OPERATOR_RECORD_ID
      && reloaded.lariLearnedRecords.records.some(record => record.id === OPERATOR_RECORD_ID),
    parentImmutable: before.parent === after.parent,
    candidateReadOnly: before.candidate === after.candidate,
    activeReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry,
    candidateUnpromoted: candidate.lineage?.promoted === false,
    noFallback: surfaces.every(surface => surface.fallbackReason == null),
    noExternalModelCalls: surfaces.every(surface => surface.externalModelCalls === 0)
  };
  const passed = Object.values(gates).every(Boolean);
  const evidence = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    parent: { path: path.relative(ROOT, parentPath).replace(/\\/g, '/'), sha256: PARENT_HASH },
    candidate: { path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'), sha256: CANDIDATE_HASH, promoted: false },
    canonicalPath: ['sendMessageToLari', 'runLariUnifiedTaskKernel', 'runFrontierCodingRepairLoop'],
    learnedOperatorRecordId: OPERATOR_RECORD_ID,
    wrapperSkillId: WRAPPER_SKILL_ID,
    surfaces,
    coldReload: reloadView,
    hiddenTransfer: transfer,
    familyRegression: regression,
    before,
    after,
    gates,
    passed,
    verdict: passed ? 'BLIND MULTI-FILE PUBLIC CONVERGENCE PASSED' : 'BLIND MULTI-FILE PUBLIC CONVERGENCE FAILED'
  };
  fs.writeFileSync(path.join(proofRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  const rows = surfaces.map(surface =>
    `| ${surface.name} | \`${surface.modelHash.slice(0, 12)}\` | \`${surface.appliedOperatorRecordId}\` | ${surface.patchedTargets.length} | ${surface.workspacePassed ? 'PASS' : 'FAIL'} |`
  ).join('\n');
  fs.writeFileSync(path.join(proofRoot, 'report.md'),
    `# Lari blind multi-file public convergence\n\n`
    + `Candidate: \`${CANDIDATE_HASH}\` (unpromoted)\n\n`
    + `| Surface | Model hash | Applied operator | Files | Result |\n`
    + `| --- | --- | --- | --- | --- |\n${rows}\n\n`
    + `Hidden transfer: **${transfer.passedCount}/${transfer.total}**. Family regressions: **${regression.rows.filter(row => row.regressed).length}**. Workbench returned both verified source edits.\n\n`
    + `Verdict: **${evidence.verdict}**\n`,
  { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({
    surfaces,
    hiddenTransfer: `${transfer.passedCount}/${transfer.total}`,
    familyRegressions: regression.rows.filter(row => row.regressed).length,
    gates,
    verdict: evidence.verdict
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
