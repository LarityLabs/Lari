#!/usr/bin/env node
'use strict';

// Regression for a real public-path invariant: a structured coding packet
// must survive every ingress surface intact until the canonical unified kernel
// sees it.  This is intentionally not a repair benchmark.  It proves route
// reachability, field preservation, and active-model immutability.

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
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function writeWorkspace(root) {
  const files = {
    'src/value.js': 'function confirmedValue() { return 0; }\nmodule.exports = { confirmedValue };\n',
    'tests/contract.js': [
      "const assert = require('assert');",
      "const { confirmedValue } = require('../src/value');",
      'assert.strictEqual(confirmedValue(), 1);',
      "console.log('workspace contract executed');"
    ].join('\n') + '\n'
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: 'wx' });
  }
  return files;
}

function issuePacket(workspaceRoot) {
  return {
    id: 'public-ingress.workspace-packet',
    mode: 'code',
    subintent: 'code.fix',
    workspaceRoot,
    testPath: 'tests/contract.js',
    testRunner: 'javascript.node',
    testSelectors: ['tests/contract.js'],
    tests: [{ path: 'tests/contract.js', runner: 'javascript.node', selectors: ['tests/contract.js'] }],
    expressionTarget: 'src/value.js',
    preserveLayout: true,
    // This is a route-preservation test, not a network-research test.
    groundedFactual: false,
    failureResearch: false
  };
}

function view(response = {}) {
  const body = response.response && typeof response.response === 'object' ? response.response : response;
  return {
    action: body.action || response.action || null,
    intent: body.intent || response.intent || null,
    passed: body.passed === true || response.passed === true,
    modelHash: body.modelHash || body.model_hash || response.modelHash || response.model_hash || null,
    trace: body.trace || response.trace || [],
    executionBinding: body.executionBinding || body.execution_binding || response.executionBinding || response.execution_binding || null,
    answer: String(body.answer || body.output_text || response.answer || response.output_text || '')
  };
}

function assertWorkspaceRoute(name, result, expectedHash) {
  assert.notStrictEqual(result.action, 'request_clarification', `${name} discarded an explicit workspace packet as ambiguous`);
  const canonicalWorkspaceBinding = result.trace.some(step => step.phase === 'workspace_repair_binding');
  assert(result.intent === 'code' || canonicalWorkspaceBinding, `${name} did not preserve code intent`);
  assert.strictEqual(result.action, 'default_failure_learning', `${name} did not enter the default failure-learning path`);
  assert.strictEqual(result.modelHash, expectedHash, `${name} did not use the active model hash`);
}

function runCliPacket(packet, root) {
  const run = spawnSync(process.execPath, ['scripts/lari_model_cli.js'], {
    cwd: ROOT,
    input: JSON.stringify({
      model: 'lari',
      messages: [{ role: 'user', content: 'Fix it in this repository and verify the declared test.' }],
      context: packet
    }),
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, LARI_AUTONOMOUS_LEARNING: '0', LARI_RUNTIME_STATE_PATH: path.join(root, 'cli-state.json') }
  });
  if (run.status !== 0) throw new Error(`CLI adapter failed: ${run.stderr || run.stdout}`);
  return view(JSON.parse(run.stdout));
}

function waitFor(url, child, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const timer = setInterval(() => {
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`${label} exited before becoming ready`));
        return;
      }
      http.get(url, response => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          clearInterval(timer);
          resolve();
        }
      }).on('error', () => {
        if (Date.now() >= deadline) {
          clearInterval(timer);
          reject(new Error(`${label} startup timed out`));
        }
      });
      if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`${label} startup timed out`));
      }
    }, 100);
  });
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function runApiPacket(packet, root) {
  const port = await reservePort();
  const child = spawn('python', ['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', String(port), '--state-path', path.join(root, 'api-state.json')], {
    cwd: ROOT,
    env: { ...process.env, LARI_AUTONOMOUS_LEARNING: '0' },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/health`, child, 'OpenAI-compatible API');
    const payload = await post(`http://127.0.0.1:${port}/v1/chat/completions`, {
      model: 'lari',
      include_diagnostics: true,
      messages: [{ role: 'user', content: 'Fix it in this repository and verify the declared test.' }],
      lari_context: packet
    });
    return view({
      action: payload.lari?.action,
      passed: payload.lari?.passed,
      modelHash: payload.lari?.model_hash,
      executionBinding: payload.lari?.execution_binding,
      answer: payload.choices?.[0]?.message?.content,
      intent: packet.mode
    });
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

async function runWorkbenchPacket(root) {
  const port = await reservePort();
  const child = spawn('python', ['start_workspace.py'], {
    cwd: ROOT,
    env: {
      ...process.env,
      LARI_AUTONOMOUS_LEARNING: '0',
      LARI_NO_BROWSER: '1',
      LARI_WORKSPACE_PORT: String(port),
      LARI_RUNTIME_STATE_PATH: path.join(root, 'workbench-state.json')
    },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  try {
    await waitFor(`http://127.0.0.1:${port}/index.html`, child, 'Workbench');
    const files = writeWorkspace(path.join(root, 'workbench-source'));
    const payload = await post(`http://127.0.0.1:${port}/api/lari/chat`, {
      prompt: 'Fix it in this repository and verify the declared test.',
      includeDiagnostics: true,
      workspaceBundle: {
        files: Object.entries(files).map(([path, content]) => ({ path, content })),
        testPath: 'tests/contract.js',
        testRunner: 'javascript.node',
        testSelectors: ['tests/contract.js'],
        expressionTarget: 'src/value.js',
        preserveLayout: true
      },
      lari_context: { groundedFactual: false, failureResearch: false }
    });
    return view(payload.response || payload);
  } finally {
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

async function runAutonomousPacket(packet, root) {
  const run = spawnSync(process.execPath, ['scripts/lari_model_cli.js'], {
    cwd: ROOT,
    input: JSON.stringify({
      model: 'lari',
      messages: [{ role: 'user', content: 'Fix it in this repository and verify the declared test.' }],
      context: { ...packet, surface: 'autonomous', workspaceLinked: true }
    }),
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, LARI_AUTONOMOUS_LEARNING: '0', LARI_RUNTIME_STATE_PATH: path.join(root, 'autonomous-state.json') }
  });
  if (run.status !== 0) throw new Error(`Autonomous adapter failed: ${run.stderr || run.stdout}`);
  return view(JSON.parse(run.stdout));
}

async function main() {
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-public-ingress-'));
  try {
    const cliRoot = path.join(root, 'cli');
    fs.mkdirSync(cliRoot);
    writeWorkspace(cliRoot);
    const cli = runCliPacket(issuePacket(cliRoot), root);

    const apiRoot = path.join(root, 'api');
    fs.mkdirSync(apiRoot);
    writeWorkspace(apiRoot);
    const api = await runApiPacket(issuePacket(apiRoot), root);

    const autonomousRoot = path.join(root, 'autonomous');
    fs.mkdirSync(autonomousRoot);
    writeWorkspace(autonomousRoot);
    const autonomous = await runAutonomousPacket(issuePacket(autonomousRoot), root);

    const workbench = await runWorkbenchPacket(root);
    const expectedHash = protectedBefore.active;
    assertWorkspaceRoute('CLI', cli, expectedHash);
    assertWorkspaceRoute('OpenAI-compatible API', api, expectedHash);
    assertWorkspaceRoute('autonomous request', autonomous, expectedHash);
    assertWorkspaceRoute('Workbench', workbench, expectedHash);
    const selectedRecords = [cli, api, autonomous, workbench]
      .map(result => result.executionBinding?.learnedRecordId || null);
    assert(selectedRecords.every(id => id === selectedRecords[0]), 'equivalent public requests selected different learned capabilities');
    const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
    assert.deepStrictEqual(protectedAfter, protectedBefore, 'public ingress mutated the active model or registry');
    process.stdout.write(`${JSON.stringify({
      test: 'lari-workspace-packet-public-ingress',
      passed: true,
      activeModelHash: expectedHash,
      surfaces: { cli, openaiApi: api, autonomous, workbench },
      activeModelReadOnly: true,
      registryReadOnly: true,
      externalModelCalls: 0
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
