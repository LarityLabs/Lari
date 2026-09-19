#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const ROOT = path.resolve(__dirname, '..');
const RECOVERY = JSON.parse(fs.readFileSync(path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'knowledge-recovery-report.json')));
const CANDIDATE = path.join(ROOT, RECOVERY.candidate.path);
const SOURCE = path.join(ROOT, RECOVERY.source.path);
const REPORT = path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'knowledge-recovery-validation.json');
const PROMPT = 'What is the plural of child?';
const OBSERVATION_PROMPT = 'What did apnumber return when you ran it?';
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function view(response = {}) {
  const lari = response.lari || response.chat_completion?.lari || {};
  const body = response.response || response;
  const choice = response.choices?.[0]?.message?.content || response.chat_completion?.choices?.[0]?.message?.content;
  return {
    answer: body.answer || body.output_text || choice || '',
    modelHash: body.modelHash || response.model_hash || lari.model_hash || null,
    learnedRecordIds: body.learnedRecordIds || lari.learned_record_ids || [],
    capabilitySelection: body.capabilitySelection || lari.capability_selection || null,
    externalModelCalls: body.external_model_calls ?? response.external_model_calls ?? 0
  };
}

function cli() {
  const run = spawnSync(process.execPath, ['scripts/lari_ask.js', '--debug', '--model-path', CANDIDATE, PROMPT], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout);
  const marker = run.stdout.lastIndexOf('\n---\n');
  const meta = JSON.parse(run.stdout.slice(marker + 5));
  return view({ response: { ...meta, answer: run.stdout.slice(0, marker).trim() } });
}

async function waitFor(url, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before becoming ready: ${url}`);
    try { if ((await fetch(url)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function post(url, payload) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${url}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const activeBefore = shaFile(registry.currentModelPath);
  const registryBefore = shaFile(registry.registryPath);
  const candidateBefore = shaFile(CANDIDATE);
  if (candidateBefore !== RECOVERY.candidate.sha256) throw new Error('Candidate hash does not match recovery manifest.');
  const model = JSON.parse(fs.readFileSync(CANDIDATE, 'utf8'));
  const context = { modelHash: candidateBefore, autoGrow: false, kernel: { useBenchmarkSystem: false } };

  const direct = view(runtime.sendMessageToLari(clone(model), PROMPT, context));
  const autonomous = view(await runtime.runLariAutonomousRequest(clone(model), PROMPT, context));
  const cliResult = cli();

  const env = {
    ...process.env,
    LARI_MODEL_PATH: CANDIDATE,
    LARI_DISABLE_MODEL_FALLBACKS: '1',
    LARI_ALLOW_LEGACY_ROOT_MODEL: '0',
    LARI_NO_BROWSER: '1',
    LARI_WORKSPACE_PORT: '8932',
    LARI_RUNTIME_STATE_PATH: path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'runtime-state.json')
  };
  const api = spawn('python', ['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', '8931', '--model-path', CANDIDATE], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const workbench = spawn('python', ['start_workspace.py'], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });

  let apiResult;
  let workbenchResult;
  try {
    await Promise.all([
      waitFor('http://127.0.0.1:8931/health', api),
      waitFor('http://127.0.0.1:8932/index.html', workbench)
    ]);
    apiResult = view(await post('http://127.0.0.1:8931/v1/chat/completions', {
      model: 'lari', messages: [{ role: 'user', content: PROMPT }], include_diagnostics: true
    }));
    workbenchResult = view(await post('http://127.0.0.1:8932/api/lari/chat', {
      prompt: PROMPT, includeDiagnostics: true, userScope: 'audit.surface-parity'
    }));
  } finally {
    api.kill();
    workbench.kill();
  }

  const reloaded = JSON.parse(fs.readFileSync(CANDIDATE, 'utf8'));
  const reload = view(runtime.sendMessageToLari(reloaded, PROMPT, context));
  const observation = view(runtime.sendMessageToLari(clone(model), OBSERVATION_PROMPT, context));
  const surfaces = { direct, cli: cliResult, openaiApi: apiResult, workbench: workbenchResult, autonomous };
  const expected = JSON.stringify(direct);
  const sourceModel = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  let sourceRejected = false;
  let sourceRejectionCode = null;
  try { registry.assertNoUnboundBenchmarkRuntimeSkills(sourceModel, RECOVERY.source.path); }
  catch (error) { sourceRejected = true; sourceRejectionCode = error.code || null; }
  const publicSourceLoad = spawnSync(process.execPath, ['scripts/lari_ask.js', '--model-path', SOURCE, PROMPT], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  registry.assertNoStoredBenchmarkAnswers(model, RECOVERY.candidate.path);
  registry.assertNoUnboundBenchmarkRuntimeSkills(model, RECOVERY.candidate.path);

  const recovered = (model.lariLearnedRecords?.records || []).filter(record =>
    record?.provenance?.sourceModelHash === RECOVERY.source.sha256
    && ['execution_observation', 'lexical_fact'].includes(record?.payload?.kind)
  );
  const gates = {
    modelLoads: model.modelId === 'lari-local-model',
    all184RecordsRecovered: recovered.length === 184,
    classificationComplete: Object.values(RECOVERY.classification).filter(Number.isFinite).slice(0, 5).reduce((a, b) => a + b, 0) === 184,
    benchmarkRuntimeScaffoldingExcluded: RECOVERY.excludedBenchmarkRuntimeSkills === 128
      && registry.findUnboundBenchmarkRuntimeSkills(model).length === 0,
    contaminatedSourceRejected: sourceRejected && sourceRejectionCode === 'LARI_CANDIDATE_UNBOUND_BENCHMARK_CAPABILITIES',
    publicSourceLoadRejected: publicSourceLoad.status !== 0
      && /LARI_CANDIDATE_UNBOUND_BENCHMARK_CAPABILITIES|benchmark-derived runtime skill/i.test(`${publicSourceLoad.stdout}\n${publicSourceLoad.stderr}`),
    lexicalCapabilityWorks: /children/i.test(direct.answer) && direct.learnedRecordIds.some(id => /^lari\.learned\.knowledge\./.test(id)),
    executionObservationWorks: /apnumber\(/i.test(observation.answer) && /returned/i.test(observation.answer),
    sameHashAndSelectionAcrossPublicSurfaces: Object.values(surfaces).every(item => JSON.stringify(item) === expected),
    reloadRetention: JSON.stringify(reload) === expected,
    noExternalModelCalls: Object.values(surfaces).every(item => item.externalModelCalls === 0),
    activeModelReadOnly: shaFile(registry.currentModelPath) === activeBefore,
    registryReadOnly: shaFile(registry.registryPath) === registryBefore,
    candidateReadOnlyDuringInference: shaFile(CANDIDATE) === candidateBefore
  };
  const report = {
    schemaVersion: 1,
    kind: 'lari.audit-knowledge-recovery-validation',
    createdAt: new Date().toISOString(),
    candidateHash: candidateBefore,
    prompt: PROMPT,
    surfaces,
    observation,
    reload,
    sourceRejectionCode,
    gates,
    passed: Object.values(gates).every(Boolean),
    externalModelCalls: 0
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ candidateHash: candidateBefore, gates, passed: report.passed }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exit(1);
});
