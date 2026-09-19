#!/usr/bin/env node
'use strict';

// Candidate-only public-surface qualification for one already learned operator.
// Every surface receives equivalent workspace bytes and the same immutable model.
// Discovery, research, and benchmark routing are disabled so success must come
// from the retained semantic primitive.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PRIMITIVE_ID = 'lari.learned.operator.semantic_mutation.1815a0cbc37ff663';
const PROMPT = 'A session combines stored parameters with request parameters. Parameter names are case-sensitive semantic identities: Mode must remain distinct from mode. Repair the behavior and verify the declared test.';
const PYTHON = path.join(ROOT, 'consolidation', 'frozen-fresh-transfer-20260904', 'python39', 'python.exe');

const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceText = [
  'def merge_setting(request_setting, session_setting):',
  '    merged = dict(session_setting)',
  '    merged.update((key.lower(), value) for key, value in request_setting.items())',
  '    return merged',
  ''
].join('\n');
const testText = [
  'from session_parameters import merge_setting',
  '',
  'def test_case_distinct_parameter_identity():',
  '    actual = merge_setting({"Mode": "request"}, {"mode": "session"})',
  '    assert actual == {"mode": "session", "Mode": "request"}',
  ''
].join('\n');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  if (!args.candidate || !args.out) throw new Error('Usage: --candidate <immutable.json> --out <new-report.json> [--expected-hash <sha256>]');
  return { candidate: path.resolve(args.candidate), out: path.resolve(args.out), only: args.only || null, expectedHash: args['expected-hash'] || null };
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function writeWorkspace(root) {
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'session_parameters.py'), sourceText, { flag: 'wx' });
  fs.writeFileSync(path.join(root, 'tests', 'test_case_identity.py'), testText, { flag: 'wx' });
}

function runOracle(root) {
  const result = spawnSync(PYTHON, ['-m', 'pytest', '-q', '--disable-warnings', '--tb=short', 'tests/test_case_identity.py::test_case_distinct_parameter_identity'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...process.env, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' }
  });
  return { passed: result.status === 0, status: result.status, output: String(result.stdout || result.stderr || '').slice(-2000) };
}

function failurePolicy(modelHash) {
  const shared = {
    modelHash,
    sourcePath: 'candidate_only_public_surface_parity',
    benchmarkAssociation: [],
    allowExpressionOperatorDiscovery: false,
    allowSemanticOperatorDiscovery: false,
    allowPrimitiveDiscovery: false,
    coordinatedProgramSearch: false,
    expressionSearch: false,
    identityPreservingRepairSearch: false,
    progressiveRelaxation: true,
    maxIterations: 0,
    expressionCandidateLimit: 4,
    mutationCandidateLimit: 32,
    mutationProposalLimit: 4,
    taskTimeoutMs: 180000,
    testTimeoutMs: 60000
  };
  return {
    useBenchmarkSystem: false,
    useCapabilityGraph: true,
    includeTransientDiagnostics: true,
    capabilityGraph: { minScore: 0 },
    failureLearning: shared,
    executionContract: { ...shared, workspaceExecution: { ...shared } }
  };
}

function packet(root, modelHash, surface) {
  return {
    id: `public-parity.${surface}`,
    mode: 'code',
    subintent: 'code.fix',
    workspaceRoot: root,
    testPath: 'tests/test_case_identity.py',
    testRunner: 'python.pytest',
    testSelectors: ['tests/test_case_identity.py::test_case_distinct_parameter_identity'],
    tests: [{ path: 'tests/test_case_identity.py', runner: 'python.pytest', selectors: ['tests/test_case_identity.py::test_case_distinct_parameter_identity'] }],
    expressionTarget: 'session_parameters.py',
    preserveLayout: true,
    groundedFactual: false,
    failureResearch: false,
    autonomousLearning: false,
    surface,
    kernel: failurePolicy(modelHash)
  };
}

function portableEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: `${path.dirname(PYTHON)}${path.delimiter}${process.env.PATH || ''}`,
    Path: `${path.dirname(PYTHON)}${path.delimiter}${process.env.Path || process.env.PATH || ''}`,
    LARI_AUTONOMOUS_LEARNING: '0'
  };
}

function selectedRepairId(body) {
  const trace = body?.trace || body?.response?.trace || [];
  return trace.find(item => item?.phase === 'default_failure_learning')?.frontierFallback?.expressionRepair?.learnedRecordId
    || body?.executionBinding?.appliedOperatorRecordId
    || body?.execution_binding?.appliedOperatorRecordId
    || (body?.learnedRecordIds || body?.learned_record_ids || []).find(id => id === PRIMITIVE_ID)
    || null;
}

function view(payload) {
  const body = payload?.response && typeof payload.response === 'object' ? payload.response : payload;
  const failureStep = (body.trace || []).find(item => item?.phase === 'default_failure_learning') || null;
  return {
    action: body.action || payload.action || null,
    passed: body.passed === true || payload.passed === true,
    modelHash: body.modelHash || body.model_hash || payload.model_hash || null,
    learnedRecordIds: body.learnedRecordIds || body.learned_record_ids || payload.learned_record_ids || [],
    appliedOperatorRecordId: body.executionBinding?.appliedOperatorRecordId || body.execution_binding?.appliedOperatorRecordId || payload.execution_binding?.appliedOperatorRecordId || null,
    selectedRepairId: selectedRepairId(body) || selectedRepairId(payload),
    failureReason: failureStep?.frontierFallback?.reason || failureStep?.reason || null,
    diagnosticTargetFiles: body.transientDiagnostics?.hypotheses?.[0]?.constraints?.targetFiles || [],
    attemptedCandidateCount: Number(body.transientDiagnostics?.attemptedCandidateCount || 0),
    externalModelCalls: Number(body.external_model_calls || payload.external_model_calls || 0)
  };
}

function runCli(candidate, context, statePath) {
  const result = spawnSync(process.execPath, ['scripts/lari_model_cli.js'], {
    cwd: ROOT,
    input: JSON.stringify({ model: 'lari', model_path: candidate, messages: [{ role: 'user', content: PROMPT }], context }),
    encoding: 'utf8', windowsHide: true, timeout: 240000,
    env: portableEnv({ LARI_RUNTIME_STATE_PATH: statePath })
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const viewed = view(JSON.parse(result.stdout));
  viewed.adapterStderr = String(result.stderr || '').slice(-4000);
  return viewed;
}

function waitFor(url, child, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const timer = setInterval(() => {
      if (child.exitCode !== null) return clearInterval(timer), reject(new Error(`${label} exited early`));
      http.get(url, response => {
        response.resume();
        if (response.statusCode < 500) clearInterval(timer), resolve();
      }).on('error', () => {
        if (Date.now() > deadline) clearInterval(timer), reject(new Error(`${label} startup timed out`));
      });
    }, 100);
  });
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function runApi(candidate, context, statePath) {
  const port = await reservePort();
  const child = spawn('python', ['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', String(port), '--model-path', candidate, '--state-path', statePath], {
    cwd: ROOT, env: portableEnv(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/health`, child, 'API');
    const payload = await post(`http://127.0.0.1:${port}/v1/chat/completions`, {
      model: 'lari', include_diagnostics: true, messages: [{ role: 'user', content: PROMPT }], lari_context: context
    });
    return view({
      action: payload.lari?.action,
      passed: payload.lari?.passed,
      model_hash: payload.lari?.model_hash,
      learned_record_ids: payload.lari?.learned_record_ids,
      execution_binding: payload.lari?.execution_binding,
      trace: payload.lari?.trace,
      external_model_calls: payload.external_model_calls
    });
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

async function runWorkbench(candidate, modelHash, statePath) {
  const port = await reservePort();
  const child = spawn('python', ['start_workspace.py'], {
    cwd: ROOT,
    env: portableEnv({ LARI_MODEL_PATH: candidate, LARI_NO_BROWSER: '1', LARI_WORKSPACE_PORT: String(port), LARI_RUNTIME_STATE_PATH: statePath }),
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/index.html`, child, 'Workbench');
    const payload = await post(`http://127.0.0.1:${port}/api/lari/chat`, {
      prompt: PROMPT,
      includeDiagnostics: true,
      workspaceBundle: {
        files: [
          { path: 'session_parameters.py', content: sourceText },
          { path: 'tests/test_case_identity.py', content: testText }
        ],
        testPath: 'tests/test_case_identity.py',
        testRunner: 'python.pytest',
        testSelectors: ['tests/test_case_identity.py::test_case_distinct_parameter_identity'],
        preserveLayout: true
      },
      lari_context: { groundedFactual: false, failureResearch: false, autonomousLearning: false, kernel: failurePolicy(modelHash) }
    });
    const result = view(payload.response || payload);
    result.patchVerified = payload.workspace_patch?.verified === true;
    result.patchFiles = (payload.workspace_patch?.files || []).map(file => file.path);
    return result;
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

async function main() {
  const args = parseArgs();
  assert(fs.existsSync(args.candidate), 'candidate missing');
  assert(!fs.existsSync(args.out), 'refusing to overwrite report');
  assert(fs.existsSync(PYTHON), 'portable Python missing');
  const modelHash = shaFile(args.candidate);
  assert.strictEqual(args.expectedHash || path.basename(args.candidate, '.json'), modelHash, 'candidate expected hash mismatch');
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), candidate: modelHash };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-case-public-parity-'));
  try {
    const surfaces = {};
    const requestedSurfaces = args.only ? [args.only] : ['cli', 'api', 'autonomous'];
    for (const name of requestedSurfaces.filter(name => name !== 'workbench')) {
      const workspace = path.join(root, name);
      writeWorkspace(workspace);
      assert.strictEqual(runOracle(workspace).passed, false, `${name} baseline unexpectedly passed`);
      const context = packet(workspace, modelHash, name === 'autonomous' ? 'autonomous' : name);
      surfaces[name] = name === 'api'
        ? await runApi(args.candidate, context, path.join(root, `${name}-state.json`))
        : runCli(args.candidate, context, path.join(root, `${name}-state.json`));
      surfaces[name].oracleAfter = runOracle(workspace).passed;
    }
    if (!args.only || args.only === 'workbench') {
      surfaces.workbench = await runWorkbench(args.candidate, modelHash, path.join(root, 'workbench-state.json'));
    }
    process.stderr.write(`${JSON.stringify({ diagnosticSurfaces: surfaces }, null, 2)}\n`);
    if (args.only) return;
    for (const [name, result] of Object.entries(surfaces)) {
      assert.strictEqual(result.passed, true, `${name} did not repair`);
      assert.strictEqual(result.modelHash, modelHash, `${name} model hash diverged`);
      assert.strictEqual(result.selectedRepairId || result.appliedOperatorRecordId, PRIMITIVE_ID, `${name} selected a different repair record`);
      assert.strictEqual(result.externalModelCalls, 0, `${name} used an external model`);
      if (name === 'workbench') assert(result.patchVerified && result.patchFiles.includes('session_parameters.py'), 'Workbench did not return its verified patch');
      else assert.strictEqual(result.oracleAfter, true, `${name} workspace still fails`);
    }
    const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), candidate: shaFile(args.candidate) };
    assert.deepStrictEqual(protectedAfter, protectedBefore, 'protected model state changed');
    const report = {
      schemaVersion: 1,
      kind: 'lari.candidate_only.public_surface_executable_repair_parity',
      createdAt: new Date().toISOString(),
      canonicalRuntime: 'sendMessageToLariAsync -> sendMessageToLari -> runLariUnifiedTaskKernel',
      candidate: { path: path.relative(ROOT, args.candidate).replace(/\\/g, '/'), sha256: modelHash, promoted: false },
      learnedRecordId: PRIMITIVE_ID,
      surfaces,
      gates: {
        allSurfacesPassed: Object.values(surfaces).every(result => result.passed === true),
        sameModelHash: Object.values(surfaces).every(result => result.modelHash === modelHash),
        sameLearnedRecord: Object.values(surfaces).every(result => (result.selectedRepairId || result.appliedOperatorRecordId) === PRIMITIVE_ID),
        noExternalModelCalls: Object.values(surfaces).every(result => result.externalModelCalls === 0),
        protectedStateReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter)
      },
      protectedBefore,
      protectedAfter,
      passed: true,
      limitations: [
        'This is candidate-only qualification, not production evidence.',
        'The public-surface fixture is an equivalent minimal behavioral task; the separate Requests run establishes cross-repository transfer.',
        'The evaluator is developer-authored and is not an independent external blind.'
      ]
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    try { fs.chmodSync(args.out, 0o444); } catch (_) {}
    process.stdout.write(`${JSON.stringify({ passed: true, report: path.relative(ROOT, args.out).replace(/\\/g, '/'), candidateHash: modelHash, learnedRecordId: PRIMITIVE_ID, gates: report.gates }, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
