#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const candidatePath = path.resolve(ROOT, process.argv[2] || '');
const outputPath = path.resolve(ROOT, process.argv[3] || 'consolidation/beta-quality-execution-refinement-public-parity.json');
const activePath = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const registryPath = path.join(ROOT, 'models', 'lari', 'registry.json');
const statePath = outputPath.replace(/\.json$/i, '-workbench-state.json');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

if (!fs.existsSync(candidatePath)) throw new Error('Candidate path is required.');
const candidateHash = hashFile(candidatePath);
if (path.basename(candidatePath, '.json') !== candidateHash) throw new Error('Candidate filename/hash mismatch.');
if (fs.existsSync(outputPath)) throw new Error('Refusing to overwrite immutable parity report.');

const context = surface => ({
  surface,
  modelHash: candidateHash,
  userScope: `beta-quality-parity-${surface}`,
  autoGrow: false,
  autoResearchOnUncertainty: false,
  groundedFactual: false,
  kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
});
const prompt = 'Describe the practical help Lari can provide now and the limits it should admit.';

function start(command, args, env) {
  return spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitFor(url, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before ${url}`);
    try { const response = await fetch(url); await response.arrayBuffer(); if (response.ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${url}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

function view(raw) {
  const completion = raw?.chat_completion || raw?.chatCompletion || raw;
  const response = raw?.response || raw;
  const lari = completion?.lari || raw?.lari || {};
  return {
    answer: response?.answer || completion?.choices?.[0]?.message?.content || raw?.answer || raw?.output_text || '',
    action: response?.action || lari.action || raw?.action || null,
    passed: response?.passed ?? lari.passed ?? raw?.passed ?? null,
    modelHash: response?.modelHash || raw?.model_hash || lari.model_hash || null,
    learnedRecordIds: [...new Set(response?.learnedRecordIds || raw?.learned_record_ids || lari.learned_record_ids || [])].sort(),
    executedLearnedRecordIds: [...new Set(response?.executedLearnedRecordIds || raw?.executed_learned_record_ids || lari.executed_learned_record_ids || [])].sort(),
    publicAnswerSource: response?.publicAnswerSource || raw?.public_source || lari.public_source || null,
    externalModelCalls: Number(response?.external_model_calls ?? raw?.external_model_calls ?? completion?.external_model_calls ?? 0)
  };
}

function cli() {
  const result = spawnSync(process.execPath, ['scripts/lari_model_cli.js'], {
    cwd: ROOT,
    input: JSON.stringify({ model: 'lari', model_path: candidatePath, prompt, context: context('cli') }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LARI_DISABLE_MODEL_FALLBACKS: '1', LARI_ALLOW_LEGACY_ROOT_MODEL: '0' }
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function main() {
  const protectedBefore = { active: hashFile(activePath), registry: hashFile(registryPath), candidate: candidateHash };
  const suffix = process.pid % 100;
  const workbenchPort = 18100 + suffix;
  const apiPort = 18200 + suffix;
  const workbench = start('python', ['start_workspace.py'], {
    LARI_MODEL_PATH: candidatePath,
    LARI_RUNTIME_STATE_PATH: statePath,
    LARI_WORKSPACE_PORT: String(workbenchPort),
    LARI_NO_BROWSER: '1',
    LARI_DISABLE_MODEL_FALLBACKS: '1',
    LARI_ALLOW_LEGACY_ROOT_MODEL: '0'
  });
  const api = start('python', ['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', String(apiPort), '--model-path', candidatePath, '--stateless'], {
    LARI_DISABLE_MODEL_FALLBACKS: '1',
    LARI_ALLOW_LEGACY_ROOT_MODEL: '0'
  });
  try {
    await Promise.all([waitFor(`http://127.0.0.1:${workbenchPort}/api/lari/history`, workbench), waitFor(`http://127.0.0.1:${apiPort}/health`, api)]);
    const workbenchRaw = await post(`http://127.0.0.1:${workbenchPort}/api/lari/chat`, { prompt, includeDiagnostics: true, userScope: context('workbench').userScope, lari_context: context('workbench') });
    const apiRaw = await post(`http://127.0.0.1:${apiPort}/v1/chat/completions`, { model: 'lari', messages: [{ role: 'user', content: prompt }], include_diagnostics: true, lari_context: context('openai-compatible-api') });
    const model = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
    const surfaces = {
      workbench: view(workbenchRaw),
      cli: view(cli()),
      openaiCompatibleApi: view(apiRaw),
      autonomous: view(await runtime.runLariAutonomousRequest(clone(model), { mode: 'chat', prompt }, { ...context('autonomous'), mode: 'chat' }))
    };
    const rows = Object.values(surfaces);
    const parity = rows.map(row => JSON.stringify({ answer: row.answer, action: row.action, learnedRecordIds: row.learnedRecordIds, publicAnswerSource: row.publicAnswerSource }));
    const protectedAfter = { active: hashFile(activePath), registry: hashFile(registryPath), candidate: hashFile(candidatePath) };
    const recordId = 'lari.learned.procedure.beta_quality.everyday_dialogue';
    const gates = {
      fourSurfacesPassed: rows.length === 4 && rows.every(row => row.passed === true),
      sameCandidateHash: rows.every(row => row.modelHash === candidateHash),
      sameSelectionAndAnswer: parity.every(item => item === parity[0]),
      exactLearnedRecordExecuted: rows.every(row => row.executedLearnedRecordIds.includes(recordId)),
      noFallback: rows.every(row => row.publicAnswerSource === 'learned_chat_procedure'),
      noMutation: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
      externalModelCallsZero: rows.every(row => row.externalModelCalls === 0)
    };
    const report = { schemaVersion: 1, kind: 'lari.beta-quality.public-surface-parity', createdAt: new Date().toISOString(), candidate: { path: path.relative(ROOT, candidatePath).replace(/\\/g, '/'), sha256: candidateHash }, prompt, surfaces, protectedBefore, protectedAfter, gates, passed: Object.values(gates).every(Boolean), externalModelCalls: 0 };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ report: path.relative(ROOT, outputPath).replace(/\\/g, '/'), candidateHash, gates, passed: report.passed }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    workbench.kill();
    api.kill();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
