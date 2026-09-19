#!/usr/bin/env node
'use strict';

// Product acceptance, not a benchmark: exercise the actual public adapters and
// novice controls against the active model without mutating production state.
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const root = path.resolve(__dirname, '..');
const active = path.join(root, 'models/lari/current/swarm-model.json');
const registry = path.join(root, 'models/lari/registry.json');
const out = path.join(root, 'consolidation/beta-readiness-20260908');
const state = path.join(out, 'product-acceptance-user-state.json');
const reportPath = path.join(out, 'product-acceptance.json');
const prompt = 'Our service crashed once. Is that enough evidence to conclude the database caused it?';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const before = { active: sha(active), registry: sha(registry) };
const baseContext = {
  groundedFactual: false,
  autoResearchOnUncertainty: false,
  operator: false,
  autoGrow: false,
  kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
};

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function start(command, args, env = {}) {
  return childProcess.spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitFor(url, process) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`server exited (${process.exitCode}) before ${url}`);
    try { const response = await fetch(url); await response.arrayBuffer(); if (response.ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function view(raw) {
  const completion = raw.chat_completion || raw;
  const response = raw.response || {};
  const lari = completion.lari || raw.lari || {};
  return {
    answer: response.answer || completion.choices?.[0]?.message?.content || raw.answer || raw.output_text || '',
    action: response.action || lari.action || raw.action || null,
    passed: response.passed ?? lari.passed ?? raw.passed ?? null,
    modelHash: response.modelHash || lari.model_hash || raw.model_hash || raw.modelHash || null,
    capabilitySelection: response.capabilitySelection || lari.capability_selection || raw.capabilitySelection || null,
    learnedRecordIds: response.learnedRecordIds || lari.learned_record_ids || raw.learnedRecordIds || [],
    externalModelCalls: Number(response.external_model_calls ?? completion.external_model_calls ?? raw.external_model_calls ?? 0)
  };
}

function runCli() {
  const payload = { model: 'lari', model_path: active, prompt, context: { ...baseContext, surface: 'cli', modelHash: before.active } };
  const result = childProcess.spawnSync(process.execPath, ['scripts/lari_model_cli.js'], { cwd: root, input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return view(JSON.parse(result.stdout));
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  atomicWrite(state, {
    schemaVersion: 1,
    kind: 'lari_runtime_user_state',
    baseModelHash: '0'.repeat(64),
    revision: 3,
    lariSessionRuntime: { turns: [], userScopes: {}, activeUserScope: null },
    preferenceRecords: []
  });
  const suffix = process.pid % 100;
  const workbenchPort = 8800 + suffix;
  const apiPort = 9000 + suffix;
  const workbench = start('python', ['start_workspace.py'], {
    LARI_MODEL_PATH: active,
    LARI_RUNTIME_STATE_PATH: state,
    LARI_WORKSPACE_PORT: String(workbenchPort),
    LARI_NO_BROWSER: '1',
    LARI_DISABLE_MODEL_FALLBACKS: '1',
    LARI_ALLOW_LEGACY_ROOT_MODEL: '0'
  });
  const api = start('python', ['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', String(apiPort), '--model-path', active, '--stateless'], {
    LARI_DISABLE_MODEL_FALLBACKS: '1',
    LARI_ALLOW_LEGACY_ROOT_MODEL: '0'
  });
  try {
    await Promise.all([
      waitFor(`http://127.0.0.1:${workbenchPort}/api/lari/history`, workbench),
      waitFor(`http://127.0.0.1:${apiPort}/health`, api)
    ]);
    const workbenchRaw = await json(`http://127.0.0.1:${workbenchPort}/api/lari/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, includeDiagnostics: true, userScope: 'beta.acceptance', lari_context: baseContext })
    });
    const apiRaw = await json(`http://127.0.0.1:${apiPort}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'lari', messages: [{ role: 'user', content: prompt }], include_diagnostics: true, lari_context: baseContext })
    });
    const control = await json(`http://127.0.0.1:${workbenchPort}/api/lari/control-plane`);
    const record = await json(`http://127.0.0.1:${workbenchPort}/api/lari/record?id=${encodeURIComponent('lari.learned.procedure.chat.technical.evidence_uncertainty')}`);
    const history = await json(`http://127.0.0.1:${workbenchPort}/api/lari/history`);
    const model = JSON.parse(fs.readFileSync(active, 'utf8'));
    const surfaces = {
      workbench: view(workbenchRaw),
      openaiCompatibleApi: view(apiRaw),
      cli: runCli(),
      autonomous: view(await runtime.runLariAutonomousRequest(clone(model), { mode: 'chat', prompt }, { ...baseContext, mode: 'chat', surface: 'autonomous', modelHash: before.active }))
    };
    const rows = Object.values(surfaces);
    const parity = rows.map(row => JSON.stringify({
      answer: row.answer,
      modelHash: row.modelHash,
      capabilitySelection: row.capabilitySelection,
      learnedRecordIds: [...row.learnedRecordIds].sort()
    }));
    const after = { active: sha(active), registry: sha(registry) };
    const gates = {
      fourPublicSurfacesPassed: rows.length === 4 && rows.every(row => row.passed === true),
      sameHashParity: rows.every(row => row.modelHash === before.active),
      sameSelectionAndAnswer: parity.every(item => item === parity[0]),
      staleUserStateRebased: workbenchRaw.response?.modelHash === before.active,
      activeControlVisible: control.active?.sha256 === before.active,
      candidateControlVisible: /^[a-f0-9]{64}$/.test(control.candidate?.sha256 || ''),
      recordInspectionWorks: record.record?.id === 'lari.learned.procedure.chat.technical.evidence_uncertainty',
      historyAndRollbackTargetVisible: history.activeHash === before.active
        && Array.isArray(history.history)
        && history.history.some(item => item.current === true && item.rollbackAvailable === true),
      productionReadOnly: before.active === after.active && before.registry === after.registry,
      externalModelCallsZero: rows.every(row => row.externalModelCalls === 0)
    };
    const report = {
      schemaVersion: 1,
      kind: 'lari.beta.product-acceptance',
      createdAt: new Date().toISOString(),
      activeHash: before.active,
      surfaces,
      controls: { active: control.active, candidate: control.candidate, recordId: record.record?.id || null, historyEntryCount: history.history?.length || 0 },
      before,
      after,
      gates,
      passed: Object.values(gates).every(Boolean),
      externalModelCalls: 0,
      limitations: [
        'This acceptance run uses one representative natural-language request; it is not broad chat-quality evidence.',
        'Rollback visibility is exercised here; destructive real-production rollback is covered by the promotion rehearsal rather than repeated during ordinary acceptance.',
        'Image, audio, video, unrestricted agentic behavior, and arbitrary repository mastery remain outside this acceptance claim.'
      ]
    };
    atomicWrite(reportPath, report);
    console.log(JSON.stringify({ report: path.relative(root, reportPath).replace(/\\/g, '/'), activeHash: report.activeHash, gates, passed: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    workbench.kill();
    api.kill();
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
