#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const candidatePath = path.resolve(
  process.env.LARI_RELEASE_CANDIDATE
    || process.env.LARI_MODEL_PATH
    || path.join(root, 'consolidation', 'learning-candidates', 'ce4c7f9454c2747f50f2c97016580adfe640ab9a1e1819706dd6c5e6bdfbd4b0.json')
);
const activePath = path.join(root, 'models', 'lari', 'current', 'swarm-model.json');
const registryPath = path.join(root, 'models', 'lari', 'registry.json');
const evidenceDir = path.join(root, 'consolidation', 'release-readiness');
const runId = `traffic-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const runDir = path.join(evidenceDir, 'traffic-runs', runId);
const reportPath = process.env.LARI_RELEASE_TRAFFIC_REPORT_PATH
  ? path.resolve(root, process.env.LARI_RELEASE_TRAFFIC_REPORT_PATH)
  : path.join(evidenceDir, 'latest-lari-release-traffic-proof.json');
const summaryPath = process.env.LARI_RELEASE_TRAFFIC_SUMMARY_PATH
  ? path.resolve(root, process.env.LARI_RELEASE_TRAFFIC_SUMMARY_PATH)
  : path.join(evidenceDir, 'latest-lari-release-traffic-proof.md');
const apiStatePath = path.join(runDir, 'api-user-state.json');
const workbenchStatePath = path.join(runDir, 'workbench-user-state.json');
const apiPort = Number(process.env.LARI_TRAFFIC_API_PORT || 18774);
const workbenchPort = Number(process.env.LARI_TRAFFIC_WORKBENCH_PORT || 18005);
const apiRequests = Math.max(1, Number(process.env.LARI_TRAFFIC_API_REQUESTS || 800));
const workbenchRequests = Math.max(1, Number(process.env.LARI_TRAFFIC_WORKBENCH_REQUESTS || 400));
const apiConcurrency = Math.max(1, Number(process.env.LARI_TRAFFIC_API_CONCURRENCY || 24));
const workbenchConcurrency = Math.max(1, Number(process.env.LARI_TRAFFIC_WORKBENCH_CONCURRENCY || 16));
const userCount = Math.max(4, Number(process.env.LARI_TRAFFIC_USERS || 64));
let expectedCandidateHash = path.basename(candidatePath, '.json').toLowerCase();

fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.mkdirSync(path.dirname(summaryPath), { recursive: true });

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fileSnapshot(filePath) {
  const stat = fs.statSync(filePath);
  return {
    path: path.relative(root, filePath).replace(/\\/g, '/'),
    sha256: sha256(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function sourceSnapshot() {
  return [
    'swarm_model_runtime.js',
    'scripts/lari_persistent_runtime_worker.js',
    'scripts/lari_lm_eval_adapter.py',
    'scripts/lari_openai_server.py',
    'start_workspace.py'
  ].map(relative => fileSnapshot(path.join(root, relative)));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))].toFixed(2));
}

function latencySummary(values) {
  return {
    minMs: percentile(values, 0),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: percentile(values, 1)
  };
}

async function requestJson(url, payload, options = {}) {
  const started = performance.now();
  const response = await fetch(url, {
    method: options.method || 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: payload === undefined ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    signal: AbortSignal.timeout(options.timeoutMs || 120000)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = { unparsed: text };
  }
  return { status: response.status, body, latencyMs: performance.now() - started };
}

async function waitFor(url, processHandle, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Server exited before becoming ready with code ${processHandle.exitCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'unknown error'}`);
}

function collectOutput(child) {
  let output = '';
  child.stdout?.on('data', chunk => { output += chunk.toString(); });
  child.stderr?.on('data', chunk => { output += chunk.toString(); });
  return () => output.slice(-12000);
}

function startApi() {
  const child = spawn('python', [
    '-u', 'scripts/lari_openai_server.py',
    '--host', '127.0.0.1',
    '--port', String(apiPort),
    '--model-path', candidatePath,
    '--state-path', apiStatePath
  ], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });
  return { child, output: collectOutput(child) };
}

function startWorkbench() {
  const child = spawn('python', ['-u', 'start_workspace.py'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      LARI_NO_BROWSER: '1',
      LARI_MODEL_PATH: candidatePath,
      LARI_RUNTIME_STATE_PATH: workbenchStatePath,
      LARI_WORKSPACE_HOST: '127.0.0.1',
      LARI_WORKSPACE_PORT: String(workbenchPort)
    }
  });
  return { child, output: collectOutput(child) };
}

async function stopTree(handle) {
  if (!handle?.child || handle.child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(handle.child.pid), '/T', '/F'], {
      windowsHide: true,
      encoding: 'utf8'
    });
  } else {
    handle.child.kill('SIGTERM');
  }
  if (handle.child.exitCode !== null) return;
  await new Promise(resolve => {
    let settled = false;
    let timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    handle.child.once('close', done);
    handle.child.once('error', done);
    timer = setTimeout(() => {
      handle.child.stdout?.destroy();
      handle.child.stderr?.destroy();
      handle.child.unref();
      done();
    }, 5000);
  });
}

function apiPayload(prompt, user) {
  return {
    model: 'lari',
    messages: [{ role: 'user', content: prompt }],
    user,
    include_diagnostics: true
  };
}

function workbenchPayload(prompt, userScope) {
  return { prompt, userScope, includeDiagnostics: true };
}

function responseView(surface, result) {
  const body = result.body || {};
  if (surface === 'api') {
    return {
      text: body.choices?.[0]?.message?.content || '',
      modelHash: body.lari?.model_hash || null,
      capabilityId: body.lari?.capability_selection?.capabilityId || null,
      learnedRecordIds: body.lari?.learned_record_ids || [],
      externalModelCalls: Number(body.external_model_calls || 0)
    };
  }
  const response = body.response || {};
  return {
    text: body.output_text || response.output_text || response.answer || '',
    modelHash: body.model_hash || response.modelHash || null,
    capabilityId: response.capabilitySelection?.capabilityId || null,
    learnedRecordIds: response.learnedRecordIds || [],
    externalModelCalls: Number(body.external_model_calls || response.external_model_calls || 0)
  };
}

const promptFamilies = [
  { family: 'chat', prompt: 'Give me one practical way to make a difficult project feel manageable.' },
  { family: 'coding', prompt: 'Explain how to diagnose an off-by-one bug before editing code.' },
  { family: 'reasoning', prompt: 'If 18 requests succeed and 2 fail, what percentage succeeded?' },
  { family: 'research', prompt: 'How should you verify a technical claim before retaining it?' },
  { family: 'safety', prompt: 'What should you check before changing files in a user workspace?' },
  { family: 'product', prompt: 'Name two signs that a beta product is dependable.' },
  { family: 'memory', prompt: 'How should a personal assistant use a correction from its user?' },
  { family: 'agentic', prompt: 'Describe a safe fail-before and pass-after coding workflow.' }
];

async function runPool(surface, endpoint, count, concurrency) {
  const results = new Array(count);
  let cursor = 0;
  const started = performance.now();
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= count) return;
      const family = promptFamilies[index % promptFamilies.length];
      const user = `traffic.user.${index % userCount}`;
      try {
        const payload = surface === 'api'
          ? apiPayload(family.prompt, user)
          : workbenchPayload(family.prompt, user);
        const result = await requestJson(endpoint, payload);
        results[index] = { index, family: family.family, status: result.status, ...responseView(surface, result), latencyMs: result.latencyMs };
      } catch (error) {
        results[index] = { index, family: family.family, status: 0, text: '', modelHash: null, externalModelCalls: 0, latencyMs: null, error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const durationMs = performance.now() - started;
  const validLatencies = results.map(item => item.latencyMs).filter(Number.isFinite);
  const failures = results.filter(item =>
    item.status !== 200
    || !item.text.trim()
    || item.modelHash !== expectedCandidateHash
    || item.externalModelCalls !== 0
  );
  const families = Object.fromEntries(promptFamilies.map(({ family }) => {
    const values = results.filter(item => item.family === family);
    return [family, {
      requests: values.length,
      passed: values.filter(item => item.status === 200 && item.text.trim()).length
    }];
  }));
  return {
    requested: count,
    concurrency,
    durationMs: Number(durationMs.toFixed(2)),
    requestsPerSecond: Number((count / (durationMs / 1000)).toFixed(2)),
    latency: latencySummary(validLatencies),
    failures: failures.slice(0, 20),
    failureCount: failures.length,
    families,
    externalModelCalls: results.reduce((sum, item) => sum + item.externalModelCalls, 0),
    modelHashes: [...new Set(results.map(item => item.modelHash).filter(Boolean))]
  };
}

async function memoryProof(surface, endpoint, phase) {
  const user = `${surface}.durable.user`;
  const other = `${surface}.isolated.user`;
  const language = surface === 'api' ? 'Rust' : 'TypeScript';
  const send = (prompt, userScope) => requestJson(
    endpoint,
    surface === 'api' ? apiPayload(prompt, userScope) : workbenchPayload(prompt, userScope)
  );
  const learned = phase === 'before-restart'
    ? await send(`Remember that my preferred programming language is ${language}.`, user)
    : null;
  const recalled = await send('What programming language do I prefer?', user);
  const isolated = phase === 'before-restart'
    ? await send('What programming language do I prefer?', other)
    : null;
  const recalledView = responseView(surface, recalled);
  const isolatedView = isolated ? responseView(surface, isolated) : null;
  return {
    phase,
    learnedStatus: learned?.status ?? null,
    recalledStatus: recalled.status,
    recalledText: recalledView.text,
    isolatedStatus: isolated?.status ?? null,
    isolatedText: isolatedView?.text ?? null,
    expectedPreference: language,
    recalled: recalled.status === 200 && new RegExp(language, 'i').test(recalledView.text),
    isolated: !isolatedView || !new RegExp(language, 'i').test(isolatedView.text),
    modelHash: recalledView.modelHash,
    externalModelCalls: (learned ? responseView(surface, learned).externalModelCalls : 0)
      + recalledView.externalModelCalls
      + (isolatedView?.externalModelCalls || 0)
  };
}

async function faultProof(apiEndpoint, workbenchEndpoint) {
  const apiMalformed = await requestJson(apiEndpoint, '{not-json');
  const workbenchMalformed = await requestJson(workbenchEndpoint, '{not-json');
  const apiRecovery = await requestJson(apiEndpoint, apiPayload('Reply with a short healthy status.', 'fault.api'));
  const workbenchRecovery = await requestJson(workbenchEndpoint, workbenchPayload('Reply with a short healthy status.', 'fault.workbench'));
  return {
    apiMalformedRejected: apiMalformed.status >= 400,
    workbenchMalformedRejected: workbenchMalformed.status >= 400,
    apiRecovered: apiRecovery.status === 200 && Boolean(responseView('api', apiRecovery).text),
    workbenchRecovered: workbenchRecovery.status === 200 && Boolean(responseView('workbench', workbenchRecovery).text)
  };
}

function stateFileProof(statePath, expectedHash) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return {
    path: path.relative(root, statePath).replace(/\\/g, '/'),
    size: fs.statSync(statePath).size,
    baseModelHash: state.baseModelHash,
    revision: state.revision,
    userScopeCount: Object.keys(state.lariSessionRuntime?.userScopes || {}).length,
    preferenceRecordCount: (state.preferenceRecords || []).length,
    valid: state.baseModelHash === expectedHash && Number(state.revision) > 0
  };
}

function markdown(report) {
  return `# Lari Release Traffic Proof

- Passed: ${report.passed}
- Candidate: \`${report.candidate.sha256}\`
- Synthetic public requests: ${report.traffic.totalRequests}
- API: ${report.traffic.api.requested} at ${report.traffic.api.requestsPerSecond} req/s, p95 ${report.traffic.api.latency.p95Ms} ms
- Workbench: ${report.traffic.workbench.requested} at ${report.traffic.workbench.requestsPerSecond} req/s, p95 ${report.traffic.workbench.latency.p95Ms} ms
- Concurrent users: ${report.traffic.userScopes}
- External model calls: ${report.externalModelCalls}
- Same-hash parity: ${report.gates.sameHashParity}
- Reload retention: ${report.gates.reloadRetention}
- User isolation: ${report.gates.userIsolation}
- Active/candidate/registry immutable: ${report.gates.modelFilesImmutable}
- Fault recovery: ${report.gates.faultRecovery}

This is synthetic production-path load, not evidence of multi-day human usage.
`;
}

async function main() {
  if (!fs.existsSync(candidatePath)) throw new Error(`Candidate does not exist: ${candidatePath}`);
  const candidateHash = sha256(candidatePath);
  if (/^[a-f0-9]{64}$/.test(expectedCandidateHash) && candidateHash !== expectedCandidateHash) {
    throw new Error(`Candidate path/hash mismatch: expected ${expectedCandidateHash}, got ${candidateHash}`);
  }
  // Production traffic may intentionally target the canonical current path,
  // whose filename is not content-addressed. Bind every response to the bytes
  // actually loaded after retaining the stricter filename check for immutable
  // candidate paths.
  expectedCandidateHash = candidateHash;
  const before = {
    candidate: fileSnapshot(candidatePath),
    active: fileSnapshot(activePath),
    registry: fileSnapshot(registryPath)
  };
  const runtimeSources = sourceSnapshot();
  const apiEndpoint = `http://127.0.0.1:${apiPort}/v1/chat/completions`;
  const workbenchEndpoint = `http://127.0.0.1:${workbenchPort}/api/lari/chat`;
  let api = startApi();
  let workbench = startWorkbench();
  let apiOutput = api.output;
  let workbenchOutput = workbench.output;
  try {
    await Promise.all([
      waitFor(`http://127.0.0.1:${apiPort}/health`, api.child),
      waitFor(`http://127.0.0.1:${workbenchPort}/`, workbench.child)
    ]);
    const coldStart = await Promise.all([
      requestJson(apiEndpoint, apiPayload('Introduce yourself in one sentence.', 'cold.api')),
      requestJson(workbenchEndpoint, workbenchPayload('Introduce yourself in one sentence.', 'cold.workbench'))
    ]);
    const memoryBefore = await Promise.all([
      memoryProof('api', apiEndpoint, 'before-restart'),
      memoryProof('workbench', workbenchEndpoint, 'before-restart')
    ]);
    const [apiTraffic, workbenchTraffic] = await Promise.all([
      runPool('api', apiEndpoint, apiRequests, apiConcurrency),
      runPool('workbench', workbenchEndpoint, workbenchRequests, workbenchConcurrency)
    ]);
    const faults = await faultProof(apiEndpoint, workbenchEndpoint);

    await stopTree(api);
    await stopTree(workbench);
    api = startApi();
    workbench = startWorkbench();
    apiOutput = api.output;
    workbenchOutput = workbench.output;
    await Promise.all([
      waitFor(`http://127.0.0.1:${apiPort}/health`, api.child),
      waitFor(`http://127.0.0.1:${workbenchPort}/`, workbench.child)
    ]);
    const memoryAfter = await Promise.all([
      memoryProof('api', apiEndpoint, 'after-restart'),
      memoryProof('workbench', workbenchEndpoint, 'after-restart')
    ]);
    const after = {
      candidate: fileSnapshot(candidatePath),
      active: fileSnapshot(activePath),
      registry: fileSnapshot(registryPath)
    };
    const immutable = Object.keys(before).every(key =>
      before[key].sha256 === after[key].sha256
      && before[key].size === after[key].size
      && before[key].mtimeMs === after[key].mtimeMs
    );
    const coldViews = [
      responseView('api', coldStart[0]),
      responseView('workbench', coldStart[1])
    ];
    const allMemory = [...memoryBefore, ...memoryAfter];
    const modelHashes = [
      ...apiTraffic.modelHashes,
      ...workbenchTraffic.modelHashes,
      ...coldViews.map(item => item.modelHash),
      ...allMemory.map(item => item.modelHash)
    ].filter(Boolean);
    const externalModelCalls = apiTraffic.externalModelCalls
      + workbenchTraffic.externalModelCalls
      + coldViews.reduce((sum, item) => sum + item.externalModelCalls, 0)
      + allMemory.reduce((sum, item) => sum + item.externalModelCalls, 0);
    const gates = {
      allRequestsSucceeded: apiTraffic.failureCount === 0 && workbenchTraffic.failureCount === 0,
      sameHashParity: modelHashes.length > 0 && modelHashes.every(hash => hash === candidateHash),
      zeroExternalModelCalls: externalModelCalls === 0,
      reloadRetention: memoryAfter.every(item => item.recalled),
      userIsolation: memoryBefore.every(item => item.isolated),
      modelFilesImmutable: immutable,
      faultRecovery: Object.values(faults).every(Boolean),
      stateFilesValid: stateFileProof(apiStatePath, candidateHash).valid
        && stateFileProof(workbenchStatePath, candidateHash).valid,
      familyCoverage: Object.values(apiTraffic.families).every(item => item.passed === item.requests)
        && Object.values(workbenchTraffic.families).every(item => item.passed === item.requests)
    };
    const report = {
      proof: 'lari-release-traffic-proof',
      timestamp: new Date().toISOString(),
      runId,
      scope: {
        syntheticProductionTraffic: true,
        actualHumanTraffic: false,
        publicSurfaces: ['openai-compatible-api', 'workbench'],
        canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
        productionExternalModelsAllowed: false
      },
      candidate: before.candidate,
      active: before.active,
      registry: before.registry,
      runtimeSources,
      traffic: {
        totalRequests: apiRequests + workbenchRequests,
        userScopes: userCount,
        api: apiTraffic,
        workbench: workbenchTraffic
      },
      coldStart: {
        apiMs: Number(coldStart[0].latencyMs.toFixed(2)),
        workbenchMs: Number(coldStart[1].latencyMs.toFixed(2)),
        apiPassed: coldStart[0].status === 200 && Boolean(coldViews[0].text),
        workbenchPassed: coldStart[1].status === 200 && Boolean(coldViews[1].text)
      },
      memory: { beforeRestart: memoryBefore, afterRestart: memoryAfter },
      state: {
        api: stateFileProof(apiStatePath, candidateHash),
        workbench: stateFileProof(workbenchStatePath, candidateHash)
      },
      faults,
      before,
      after,
      gates,
      externalModelCalls,
      passed: Object.values(gates).every(Boolean)
        && coldStart.every(item => item.status === 200)
    };
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(summaryPath, markdown(report));
    console.log(JSON.stringify({
      passed: report.passed,
      candidateHash,
      totalRequests: report.traffic.totalRequests,
      apiRequestsPerSecond: report.traffic.api.requestsPerSecond,
      workbenchRequestsPerSecond: report.traffic.workbench.requestsPerSecond,
      apiP95Ms: report.traffic.api.latency.p95Ms,
      workbenchP95Ms: report.traffic.workbench.latency.p95Ms,
      gates,
      report: path.relative(root, reportPath).replace(/\\/g, '/')
    }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error);
    console.error(`API output:\n${apiOutput()}`);
    console.error(`Workbench output:\n${workbenchOutput()}`);
    throw error;
  } finally {
    await stopTree(api);
    await stopTree(workbench);
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
