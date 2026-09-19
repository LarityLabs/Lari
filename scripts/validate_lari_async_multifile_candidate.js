#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const PARENT_HASH = '0c5c55b4c99c6463aa0cccdfc6e3d28a9d9654c6eac480ca25c9564e4ad81e58';
const CANDIDATE_HASH = 'ce4c7f9454c2747f50f2c97016580adfe640ab9a1e1819706dd6c5e6bdfbd4b0';
const OPERATOR_ID = 'lari.learned.operator.coordinated.0897464d';
const WRAPPER_ID = 'skill.frontier_coding_repair_loop';
const parentPath = path.join(ROOT, 'consolidation', 'learning-candidates', `${PARENT_HASH}.json`);
const candidatePath = path.join(ROOT, 'consolidation', 'learning-candidates', `${CANDIDATE_HASH}.json`);
const activePath = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const registryPath = path.join(ROOT, 'models', 'lari', 'registry.json');
const proofRoot = path.join(ROOT, 'consolidation', 'async-multifile-public-convergence-20260723');
const prompt = 'Repair this failing async multi-file repository. Diagnose the dependency behavior, preserve async signatures, patch the helper and awaiting consumer together, and verify the immutable test.';

const sha256File = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const loadCandidate = () => JSON.parse(fs.readFileSync(candidatePath, 'utf8'));

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function seedWorkspace(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const helper = 'async function readSamples(samples) {\n  return [];\n}\n\nmodule.exports = { readSamples };\n';
  const consumer = 'const { readSamples } = require("./adapter");\n\nasync function enabledLatencies(samples) {\n  return [];\n}\n\nmodule.exports = { enabledLatencies };\n';
  const test = 'const assert = require("assert");\nconst { readSamples } = require("../src/adapter");\nconst { enabledLatencies } = require("../src/report");\n\n(async () => {\n  const first = { disabled: false, latency: 12 };\n  const skipped = { disabled: true, latency: 80 };\n  const second = { disabled: false, latency: 5 };\n  assert.deepStrictEqual(await readSamples([first, skipped, second]), [first, second]);\n  assert.deepStrictEqual(await enabledLatencies([first, skipped, second]), [12, 5]);\n  console.log("async sample behavior verified");\n})().catch(error => { console.error(error); process.exit(1); });\n';
  write(root, 'src/adapter.js', helper);
  write(root, 'src/report.js', consumer);
  write(root, 'tests/report.test.js', test);
  return { helper, consumer, test };
}

function runTest(root) {
  try {
    execFileSync(process.execPath, ['tests/report.test.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return true;
  } catch (_) {
    return false;
  }
}

function requestFor(root) {
  return { prompt, workspaceRoot: root, testPath: 'tests/report.test.js', expressionTarget: 'src/report.js', preserveLayout: true };
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

function normalize(name, response, workspacePassed, extra = {}) {
  const lari = response?.lari || {};
  const selection = response?.capabilitySelection || response?.capability_selection || lari.capability_selection || null;
  const binding = response?.executionBinding || response?.execution_binding || lari.execution_binding || null;
  const execution = binding?.workspaceExecution || null;
  return {
    name,
    modelHash: response?.modelHash || response?.model_hash || lari.model_hash || selection?.modelHash || null,
    sourceSkillId: selection?.sourceSkillId || null,
    executionSkillId: binding?.skillId || null,
    appliedOperatorRecordId: binding?.appliedOperatorRecordId || null,
    executionVerified: binding?.verified === true,
    exactFailBeforePassAfter: execution?.runnerVerification?.exactDeclaredRunnerFailToPass === true,
    oracleImmutable: execution?.runnerVerification?.oracleImmutable === true,
    operatorMode: execution?.expressionRepair?.mode || null,
    patchedTargets: execution?.expressionRepair?.targets || [],
    workspacePassed,
    fallbackReason: response?.fallbackReason || response?.fallback_reason || lari.fallback_reason || null,
    externalModelCalls: response?.external_model_calls ?? 0,
    ...extra
  };
}

function parseCli(stdout) {
  const marker = stdout.lastIndexOf('\n---\n');
  assert(marker >= 0, 'CLI diagnostics marker missing');
  return JSON.parse(stdout.slice(marker + 5));
}

function runCli(root) {
  const result = spawnSync(process.execPath, [
    'scripts/lari_ask.js',
    '--model-path', candidatePath,
    '--workspace-root', root,
    '--test-path', 'tests/report.test.js',
    '--expression-target', 'src/report.js',
    '--debug',
    prompt
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LARI_AUTONOMOUS_LEARNING: '0', LARI_AUTONOMOUS_PROMOTION: '0' },
    timeout: 120000
  });
  assert(result.status === 0, result.stderr || result.stdout || 'CLI failed');
  return parseCli(result.stdout);
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
  return { passedCount: tests.filter(test => test.passed).length, total: tests.length, passed: tests.length === 17 && tests.every(test => test.passed), tests };
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
    return Number(response.passed !== false) + Number(response.passed === true) + Math.min(1, String(response.answer || '').length / 80);
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
  const before = { parent: sha256File(parentPath), candidate: sha256File(candidatePath), active: sha256File(activePath), registry: sha256File(registryPath) };
  const parent = JSON.parse(fs.readFileSync(parentPath, 'utf8'));
  const candidate = loadCandidate();
  const parentIds = new Set(parent.lariLearnedRecords.records.map(record => record.id));
  const added = candidate.lariLearnedRecords.records.filter(record => !parentIds.has(record.id));
  fs.mkdirSync(proofRoot, { recursive: true });
  const roots = Object.fromEntries(['cli', 'api', 'autonomous', 'reload'].map(name => [name, path.join(proofRoot, 'workspaces', name)]));
  for (const root of Object.values(roots)) {
    seedWorkspace(root);
    assert(!runTest(root), `${root} did not fail before Lari`);
  }

  const cliView = normalize('cli', runCli(roots.cli), runTest(roots.cli));
  const apiPort = 18768;
  const workbenchPort = 18003;
  const api = startPython(['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', String(apiPort), '--model-path', candidatePath]);
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
    await Promise.all([waitFor(`http://127.0.0.1:${apiPort}/health`), waitFor(`http://127.0.0.1:${workbenchPort}/index.html`)]);
    apiCompletion = await postJson(`http://127.0.0.1:${apiPort}/v1/chat/completions`, {
      model: 'lari',
      messages: [{ role: 'user', content: prompt }],
      include_diagnostics: true,
      lari_context: { workspaceRoot: roots.api, testPath: 'tests/report.test.js', expressionTarget: 'src/report.js', preserveLayout: true }
    });
    const fixture = seedWorkspace(path.join(proofRoot, 'workspaces', 'workbench-source'));
    workbenchResult = await postJson(`http://127.0.0.1:${workbenchPort}/api/lari/chat`, {
      prompt,
      includeDiagnostics: true,
      workspaceBundle: {
        files: [
          { path: 'src/adapter.js', content: fixture.helper },
          { path: 'src/report.js', content: fixture.consumer },
          { path: 'tests/report.test.js', content: fixture.test }
        ],
        testPath: 'tests/report.test.js',
        expressionTarget: 'src/report.js',
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
  const autonomousView = normalize('autonomous', await runtime.runLariAutonomousRequest(loadCandidate(), requestFor(roots.autonomous), { modelHash: CANDIDATE_HASH }), runTest(roots.autonomous));
  const reloadView = normalize('cold_reload', await runtime.sendMessageToLariAsync(clone(loadCandidate()), requestFor(roots.reload), canonicalContext(CANDIDATE_HASH)), runTest(roots.reload));
  const surfaces = [workbenchView, cliView, apiView, autonomousView];
  for (const surface of [...surfaces, reloadView]) {
    assert(surface.modelHash === CANDIDATE_HASH, `${surface.name} selected wrong model`);
    assert(surface.sourceSkillId === WRAPPER_ID, `${surface.name} selected wrong wrapper`);
    assert(surface.executionSkillId === WRAPPER_ID, `${surface.name} executed wrong wrapper`);
    assert(surface.appliedOperatorRecordId === OPERATOR_ID, `${surface.name} selected wrong operator`);
    assert(surface.executionVerified && surface.workspacePassed, `${surface.name} failed execution`);
    assert(surface.exactFailBeforePassAfter && surface.oracleImmutable, `${surface.name} lacks verification`);
    assert(surface.operatorMode === 'retained_coordinated_operator', `${surface.name} searched instead of reusing`);
    assert(surface.patchedTargets.length === 2, `${surface.name} did not patch two files`);
    assert(surface.fallbackReason == null && surface.externalModelCalls === 0, `${surface.name} used fallback/model call`);
  }

  const transfer = hiddenTransfer(candidate);
  const regression = familyRegression(parent, candidate);
  const after = { parent: sha256File(parentPath), candidate: sha256File(candidatePath), active: sha256File(activePath), registry: sha256File(registryPath) };
  const gates = {
    exactlyOneTypedRecordAdded: added.length === 1 && added[0].id === OPERATOR_ID && added[0].payload?.programAst?.op === 'coordinated_async_pipeline',
    sameHashParity: surfaces.every(surface => surface.modelHash === CANDIDATE_HASH),
    sameWrapperParity: surfaces.every(surface => surface.sourceSkillId === WRAPPER_ID && surface.executionSkillId === WRAPPER_ID),
    sameOperatorParity: surfaces.every(surface => surface.appliedOperatorRecordId === OPERATOR_ID),
    retainedOperatorOnly: surfaces.every(surface => surface.operatorMode === 'retained_coordinated_operator'),
    twoFileExecution: surfaces.every(surface => surface.patchedTargets.length === 2),
    failBeforePassAfter: surfaces.every(surface => surface.exactFailBeforePassAfter),
    immutableOracles: surfaces.every(surface => surface.oracleImmutable),
    workbenchTwoFilePatchRoundTrip: workbenchView.returnedVerifiedPatch && workbenchView.returnedPatchFileCount === 2,
    hiddenTransfer17Of17: transfer.passed,
    zeroFamilyRegressions: regression.passed,
    reloadRetention: reloadView.executionVerified && reloadView.appliedOperatorRecordId === OPERATOR_ID,
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
    learnedOperatorRecordId: OPERATOR_ID,
    wrapperSkillId: WRAPPER_ID,
    surfaces,
    coldReload: reloadView,
    hiddenTransfer: transfer,
    familyRegression: regression,
    before,
    after,
    gates,
    passed,
    externalModelCalls: 0,
    verdict: passed ? 'ASYNC MULTI-FILE PUBLIC CONVERGENCE PASSED' : 'ASYNC MULTI-FILE PUBLIC CONVERGENCE FAILED'
  };
  fs.writeFileSync(path.join(proofRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  const rows = surfaces.map(surface => `| ${surface.name} | \`${surface.modelHash.slice(0, 12)}\` | \`${surface.appliedOperatorRecordId}\` | ${surface.patchedTargets.length} | ${surface.workspacePassed ? 'PASS' : 'FAIL'} |`).join('\n');
  fs.writeFileSync(path.join(proofRoot, 'report.md'),
    `# Lari async multi-file public convergence\n\nCandidate: \`${CANDIDATE_HASH}\` (unpromoted)\n\n`
    + `| Surface | Model hash | Applied operator | Files | Result |\n| --- | --- | --- | --- | --- |\n${rows}\n\n`
    + `Hidden transfer: **${transfer.passedCount}/${transfer.total}**. Family regressions: **${regression.rows.filter(row => row.regressed).length}**.\n\n`
    + `Verdict: **${evidence.verdict}**\n`,
  { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ surfaces, hiddenTransfer: `${transfer.passedCount}/${transfer.total}`, familyRegressions: regression.rows.filter(row => row.regressed).length, gates, verdict: evidence.verdict }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
