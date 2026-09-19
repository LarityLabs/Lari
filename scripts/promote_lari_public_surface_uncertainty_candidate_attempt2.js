#!/usr/bin/env node
'use strict';

// One-shot real-production promotion for the immutable public-surface
// uncertainty candidate.  It deliberately uses the existing registry
// transaction rather than introducing another activation mechanism.
//
// The wrapper is hash-locked, preserves independent content-addressed
// backups before activation, validates the actual public paths after
// activation, and automatically restores the incumbent if any post-promotion
// gate fails.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

delete process.env.LARI_REGISTRY_ROOT;
delete process.env.LARI_MODEL_PATH;
delete process.env.LARI_ATOMIC_WRITE_FAIL_BEFORE_RENAME;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
process.env.LARI_ALLOW_LEGACY_ROOT_MODEL = '0';
process.env.LARI_AUTONOMOUS_LEARNING = '0';
process.env.LARI_AUTONOMOUS_PROMOTION = '0';

const registry = require('./lari_model_registry.js');
const runtime = require('../swarm_model_runtime.js');
const recap = require('../swarm_recap_language.js');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE_HASH = 'beb2db6daa870dc134781ff9135247b942d3c578951b6fe90eacd03fbe9fca15';
const INCUMBENT_HASH = '1b042e4476ad5b3baf4826cd19812adc328ef27201e8590c4b168a0720f8bc22';
const INCUMBENT_REGISTRY_HASH = 'cedae0909ad2b75ab630cedf830c3103686f1e6ad092d57ce3e1ea0320a10fe4';
const REHEARSAL_INCUMBENT_REGISTRY_HASH = '7caadb3c2f05d82779ccea1eb36b7087f0533f115e44a530e7d5f1a4a06aa792';
const CANDIDATE_PARENT_HASH = 'ac842c3803ca7288b84555780a9f3ddeb7f0f1ec67ad077a91c25ffd1b7b8511';
const REHEARSAL_HASH = '9fc23103b12b079e8d81f4a4429237eb335f7be75cd3eff32acd345d8c422760';
const TYPED_RECORD_ID = 'lari.learned.knowledge.4fab0a17a9314c8f';
const EXPECTED_ADDITIONAL_RECORD_IDS = [
  'lari.learned.generator.neurogenesis.a199f97c795e2373c268',
  'lari.learned.generator.neurogenesis.d0868060afb74a1cbfee',
  'lari.learned.knowledge.25ff16f979accf19',
  'lari.learned.knowledge.4fab0a17a9314c8f',
  'lari.learned.knowledge.8cfa1c406f7036dc',
  'lari.learned.operator.semantic_mutation.b1de2702dd1ace54'
].sort();
const CANDIDATE = path.join(
  ROOT,
  'consolidation',
  'public-surface-uncertainty-convergence-attempt4-20260906',
  `candidate-${CANDIDATE_HASH}.json`
);
const REHEARSAL = path.join(
  ROOT,
  'consolidation',
  'public-surface-uncertainty-promotion-rehearsal-attempt2-20260906',
  'promotion-rehearsal-evidence.json'
);
const PREVIOUS_ATTEMPT_FAILURE = path.join(ROOT, 'consolidation', 'public-surface-uncertainty-production-promotion-20260906', 'production-promotion-failure.json');
const PREVIOUS_ATTEMPT_FAILURE_HASH = '68fc6b17cb9ac2b3a0970a98f357d67e3011ba73f7f555bc9b81255a73ec7754';
const OUT = path.join(ROOT, 'consolidation', 'public-surface-uncertainty-production-promotion-attempt2-20260906');
const PREFLIGHT = path.join(OUT, 'preflight-manifest.json');
const VALIDATION = path.join(OUT, 'post-promotion-validation.json');
const MANIFEST = path.join(OUT, 'production-promotion-manifest.json');
const FAILURE = path.join(OUT, 'production-promotion-failure.json');
const ACTIVE_BACKUP = path.join(OUT, 'backups', `sha256-${INCUMBENT_HASH}.json`);
const REGISTRY_BACKUP = path.join(OUT, 'backups', `registry-sha256-${INCUMBENT_REGISTRY_HASH}.json`);
const USER_SCOPE = 'public-surface-production-promotion';
const PROMPT = 'What is the cobalt-orbit quorum ledger?';
const EXPECTED_FACT = /cobalt-orbit.*quorum.*epoch.*witness|quorum.*epoch.*witness/i;

const clone = value => JSON.parse(JSON.stringify(value));
const shaBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => shaBytes(fs.readFileSync(file));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const stable = value => JSON.stringify(value ?? null);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function arraysEqual(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function writeExclusive(file, value, immutable = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (immutable) fs.chmodSync(file, 0o444);
  return file;
}

function preserve(source, target, expectedHash) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fs.readFileSync(source), { flag: 'wx' });
  assert(shaFile(target) === expectedHash, `Backup hash mismatch: ${rel(target)}`);
  fs.chmodSync(target, 0o444);
  return {
    path: rel(target),
    sha256: expectedHash,
    bytes: fs.statSync(target).size,
    immutable: (fs.statSync(target).mode & 0o222) === 0
  };
}

function fileInfo(file) {
  const stat = fs.statSync(file);
  return {
    path: rel(file),
    sha256: shaFile(file),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    immutable: (stat.mode & 0o222) === 0
  };
}

function temporaryFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.tmp') || /^\..+\.tmp$/.test(name));
}

function state() {
  return {
    active: shaFile(registry.currentModelPath),
    registry: shaFile(registry.registryPath)
  };
}

function worktreeSnapshot() {
  const run = spawnSync('git', ['status', '--short'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });
  const output = String(run.stdout || '');
  return {
    available: run.status === 0,
    exitCode: run.status,
    sha256: shaBytes(Buffer.from(output, 'utf8')),
    entries: output.split(/\r?\n/).filter(Boolean).length
  };
}

function productionEnv(extra = {}) {
  const env = { ...process.env };
  delete env.LARI_REGISTRY_ROOT;
  delete env.LARI_MODEL_PATH;
  delete env.LARI_ALLOW_REAL_PROMOTION;
  delete env.LARI_ATOMIC_WRITE_FAIL_BEFORE_RENAME;
  return {
    ...env,
    LARI_DISABLE_MODEL_FALLBACKS: '1',
    LARI_ALLOW_LEGACY_ROOT_MODEL: '0',
    LARI_AUTONOMOUS_LEARNING: '0',
    LARI_AUTONOMOUS_PROMOTION: '0',
    LARI_USER_SCOPE: USER_SCOPE,
    ...extra
  };
}

function context(surface) {
  return {
    surface,
    userScope: USER_SCOPE,
    autoResearchOnUncertainty: false,
    autonomousLearning: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 }
    }
  };
}

function normalizeSelection(selection = null) {
  if (!selection || typeof selection !== 'object') return null;
  return {
    capabilityId: selection.capabilityId || selection.capability_id || null,
    sourceSkillId: selection.sourceSkillId || selection.source_skill_id || null,
    learnedRecordId: selection.learnedRecordId || selection.learned_record_id || null,
    modelHash: selection.modelHash || selection.model_hash || null
  };
}

function publicView(raw = {}) {
  const completion = raw.chat_completion || raw.chatCompletion || raw;
  const lari = raw.lari || completion?.lari || raw.response?.chat_completion?.lari || {};
  const response = raw.response && typeof raw.response === 'object' ? raw.response : raw;
  const selection = response.capabilitySelection
    || response.capability_selection
    || raw.capability_selection
    || lari.capability_selection
    || null;
  const learned = response.learnedRecordIds
    || response.learned_record_ids
    || raw.learned_record_ids
    || lari.learned_record_ids
    || [];
  const answer = response.answer
    || raw.answer
    || completion?.choices?.[0]?.message?.content
    || raw.output_text
    || '';
  return {
    modelHash: response.modelHash
      || response.model_hash
      || raw.model_hash
      || lari.model_hash
      || normalizeSelection(selection)?.modelHash
      || null,
    capabilitySelection: normalizeSelection(selection),
    learnedRecordIds: [...new Set(learned || [])].sort(),
    action: response.action || raw.action || lari.action || null,
    publicAnswerSource: response.publicAnswerSource || response.public_source || raw.public_source || lari.public_source || null,
    answer: String(answer || '').trim(),
    passed: response.passed !== undefined
      ? response.passed === true
      : (raw.passed !== undefined ? raw.passed === true : (lari.passed !== undefined ? lari.passed === true : null)),
    externalModelCalls: Number(response.external_model_calls ?? raw.external_model_calls ?? lari.external_model_calls ?? 0)
  };
}

function signature(view) {
  return stable({
    modelHash: view.modelHash,
    capabilitySelection: view.capabilitySelection,
    learnedRecordIds: view.learnedRecordIds
  });
}

function parseAskDebug(stdout) {
  const marker = String(stdout || '').lastIndexOf('\n---\n');
  if (marker < 0) throw new Error(`lari:ask did not emit debug diagnostics:\n${stdout}`);
  const answer = String(stdout).slice(0, marker).trim();
  const diagnostics = JSON.parse(String(stdout).slice(marker + 5));
  return {
    view: publicView({
      response: diagnostics,
      answer,
      model_hash: diagnostics.modelHash,
      external_model_calls: diagnostics.externalModelCalls
    }),
    modelPath: diagnostics.modelPath || null
  };
}

function runAsk() {
  // npm is unavailable on this host and Node's native --run carrier crashes
  // before package startup. This executes the exact implementation mapped by
  // npm run lari:ask, and the evidence records that limitation explicitly.
  const run = spawnSync(process.execPath, ['scripts/lari_ask.js', '--debug', '--user', USER_SCOPE, PROMPT], {
    cwd: ROOT,
    env: productionEnv(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120000
  });
  if (run.status !== 0) throw new Error(`lari:ask implementation failed: ${run.stderr || run.stdout}`);
  return parseAskDebug(run.stdout);
}

function runAutonomous() {
  const payload = {
    model: 'lari',
    prompt: PROMPT,
    context: context('autonomous')
  };
  const run = spawnSync(process.execPath, ['scripts/lari_model_cli.js'], {
    cwd: ROOT,
    env: productionEnv(),
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120000
  });
  if (run.status !== 0) throw new Error(`Autonomous carrier failed: ${run.stderr || run.stdout}`);
  return publicView(JSON.parse(run.stdout));
}

function childLogs(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  return () => ({ stdout, stderr });
}

async function waitFor(url, child, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited during startup.`);
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      if (response.ok) return;
    } catch (_) {
      // Poll only the short-lived local service created for this validation.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${label} did not start within 30 seconds.`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`${url} returned non-JSON: ${text}`);
  }
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function runApi(port, statePath) {
  const child = spawn('python', ['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: ROOT,
    env: productionEnv({ LARI_RUNTIME_STATE_PATH: statePath }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = childLogs(child);
  try {
    await waitFor(`http://127.0.0.1:${port}/health`, child, 'OpenAI-compatible API');
    return publicView(await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
      model: 'lari',
      messages: [{ role: 'user', content: PROMPT }],
      include_diagnostics: true,
      lari_context: context('openai_compatible_api')
    }));
  } catch (error) {
    const output = logs();
    throw new Error(`${error.message}\nAPI stdout: ${output.stdout}\nAPI stderr: ${output.stderr}`);
  } finally {
    await stopChild(child);
  }
}

async function runWorkbench(port, statePath) {
  const child = spawn('python', ['start_workspace.py'], {
    cwd: ROOT,
    env: productionEnv({
      LARI_RUNTIME_STATE_PATH: statePath,
      LARI_WORKSPACE_HOST: '127.0.0.1',
      LARI_WORKSPACE_PORT: String(port),
      LARI_NO_BROWSER: '1'
    }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = childLogs(child);
  try {
    await waitFor(`http://127.0.0.1:${port}/api/lari/history`, child, 'Workbench');
    return publicView(await postJson(`http://127.0.0.1:${port}/api/lari/chat`, {
      prompt: PROMPT,
      includeDiagnostics: true,
      userScope: USER_SCOPE,
      lari_context: context('workbench')
    }));
  } catch (error) {
    const output = logs();
    throw new Error(`${error.message}\nWorkbench stdout: ${output.stdout}\nWorkbench stderr: ${output.stderr}`);
  } finally {
    await stopChild(child);
  }
}

async function observedSurface(name, invoke) {
  const before = state();
  const result = await invoke();
  const view = result?.view || result;
  const after = state();
  return {
    name,
    ...(result?.view ? result : {}),
    view,
    before,
    after,
    activeReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry
  };
}
function runReadOnlyRegression(script) {
  const run = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env: productionEnv(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 128 * 1024 * 1024
  });
  if (run.status !== 0) throw new Error(`${script} failed:\n${run.stderr || run.stdout}`);
  return JSON.parse(String(run.stdout).trim());
}

function legacyTransferSample(model) {
  const records = (model.lariLearnedRecords?.records || [])
    .filter(record => record?.provenance?.imported
      && record.type === 'knowledge'
      && !(record.provenance?.benchmarkAssociation || []).length
      && (record.normalizedTriggers || []).length >= 2)
    .slice(0, 17);
  const rows = records.map(record => {
    const prompt = `In a new situation, what reusable guidance applies when ${record.normalizedTriggers.slice(0, 4).reverse().join(', ')} matter?`;
    const matches = runtime.searchKnowledge(clone(model), prompt, { limit: 5, minScore: 0 }) || [];
    const routed = matches.some(match => (match.item?.id || match.id) === record.provenance.originalRecordId);
    const response = runtime.sendMessageToLari(clone(model), prompt, {
      ...context('legacy_transfer_sample'),
      modelHash: CANDIDATE_HASH
    });
    return {
      recordId: record.id,
      originalRecordId: record.provenance.originalRecordId || null,
      routed,
      nonEmptyAnswer: String(response.answer || '').trim().length > 0,
      passed: routed && String(response.answer || '').trim().length > 0
    };
  });
  return {
    total: rows.length,
    passedCount: rows.filter(row => row.passed).length,
    passed: rows.length === 17 && rows.every(row => row.passed),
    rows
  };
}

function recapFamilyRegression(model) {
  const samples = {
    causal_explanation: 'Please explain why the cache stayed stale: invalidation ran before the transaction committed. The evidence indicates the refresh log has the old version number. Next action: trigger invalidation after commit.',
    practical_planning: 'Make a plan for learning a new codebase safely.',
    balanced_comparison: 'Compare local storage versus a small database.',
    requirements_clarification: 'Ask me what you need to know to create a local coding tool.',
    correction_repair: 'I said archive the candidate, not delete the model.',
    structured_thinking: 'Help me think through a chat release. Context: procedural answers are reliable. Goal: make conversation feel more natural. Constraint: no outside model calls.',
    retained_knowledge_explanation: 'Explain humanize.activate(1000000).'
  };
  const rows = Object.entries(samples).map(([family, prompt]) => {
    const direct = recap.realize(model, prompt);
    const response = runtime.sendMessageToLari(clone(model), prompt, {
      ...context('family_regression'),
      modelHash: CANDIDATE_HASH
    });
    const expectedSource = family === 'retained_knowledge_explanation'
      ? 'verified_retained_knowledge'
      : 'recap_executable_language';
    const passed = direct?.meaningGraph?.family === family
      && direct?.verification?.passed === true
      && response.modelHash === CANDIDATE_HASH
      && response.publicAnswerSource === expectedSource
      && response.recapTrace?.meaningGraph?.family === family
      && response.recapTrace?.verification?.passed === true
      && Number(response.external_model_calls || 0) === 0;
    return { family, passed, expectedSource, source: response.publicAnswerSource || null };
  });
  return {
    total: rows.length,
    passedCount: rows.filter(row => row.passed).length,
    passed: rows.every(row => row.passed),
    rows
  };
}

function recordIds(model) {
  return new Set((model.lariLearnedRecords?.records || []).map(record => record?.id).filter(Boolean));
}

function preflight() {
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Real production registry was not selected.');
  assert(!fs.existsSync(OUT), `Refusing to overwrite promotion output: ${rel(OUT)}`);
  [CANDIDATE, REHEARSAL, PREVIOUS_ATTEMPT_FAILURE, registry.currentModelPath, registry.registryPath].forEach(file => {
    assert(fs.existsSync(file), `Missing required input: ${rel(file)}`);
  });

  const candidate = readJson(CANDIDATE);
  const incumbent = readJson(registry.currentModelPath);
  const currentRegistry = readJson(registry.registryPath);
  const rehearsal = readJson(REHEARSAL);
  const incumbentRecords = recordIds(incumbent);
  const candidateRecords = recordIds(candidate);
  const missingRecords = [...incumbentRecords].filter(id => !candidateRecords.has(id)).sort();
  const additionalRecords = [...candidateRecords].filter(id => !incumbentRecords.has(id)).sort();
  const topLevelContainment = {};
  for (const key of ['skills', 'knowledge', 'mutations']) {
    const ids = new Set((incumbent[key] || []).map(item => item?.id).filter(Boolean));
    const candidateIds = new Set((candidate[key] || []).map(item => item?.id).filter(Boolean));
    topLevelContainment[key] = [...ids].filter(id => !candidateIds.has(id)).sort();
  }
  const incumbentCompiled = incumbent.compiledSkills || [];
  const candidateCompiledIds = new Set((candidate.compiledSkills || []).map(item => item?.id).filter(Boolean));
  const omittedCompiled = incumbentCompiled
    .filter(skill => skill?.id && !candidateCompiledIds.has(skill.id))
    .map(skill => ({
      id: skill.id,
      sourceLearnedRecordId: skill.sourceLearnedRecordId || null,
      sourceOperatorIds: skill.sourceOperatorIds || [],
      backingTypedRecordPresent: Boolean(skill.sourceLearnedRecordId && candidateRecords.has(skill.sourceLearnedRecordId)),
      classification: 'derived_projection_not_independent_intelligence'
    }));
  const candidateLineageParent = candidate.lineage?.parentHash || null;
  const gates = {
    candidateHashExact: shaFile(CANDIDATE) === CANDIDATE_HASH,
    incumbentHashExact: shaFile(registry.currentModelPath) === INCUMBENT_HASH,
    registryHashExact: shaFile(registry.registryPath) === INCUMBENT_REGISTRY_HASH,
    registryHeadExact: currentRegistry.activeModelSha256 === INCUMBENT_HASH,
    candidateIsImmutable: (fs.statSync(CANDIDATE).mode & 0o222) === 0,
    rehearsalIsImmutable: (fs.statSync(REHEARSAL).mode & 0o222) === 0,
    rehearsalHashExact: shaFile(REHEARSAL) === REHEARSAL_HASH,
    priorAttemptFailureExact: shaFile(PREVIOUS_ATTEMPT_FAILURE) === PREVIOUS_ATTEMPT_FAILURE_HASH,
    priorAttemptRollbackExact: currentRegistry.metadata?.transaction === 'automatic-rollback-public-surface-uncertainty'
      && currentRegistry.metadata?.rollback === true
      && currentRegistry.metadata?.rollbackTargetHash === INCUMBENT_HASH,
    rehearsalPassed: rehearsal.passed === true
      && rehearsal.verdict === 'Safe for real promotion'
      && rehearsal.rehearsalOnly === true
      && rehearsal.realPromotionPerformed === false
      && Object.values(rehearsal.gates || {}).every(value => value === true),
    rehearsalCandidateExact: rehearsal.candidate?.sha256 === CANDIDATE_HASH
      && rehearsal.candidate?.parentHash === CANDIDATE_PARENT_HASH
      && rehearsal.candidate?.typedRecordId === TYPED_RECORD_ID,
    rehearsalIncumbentExact: rehearsal.incumbent?.sha256 === INCUMBENT_HASH
      && rehearsal.incumbent?.registrySha256 === REHEARSAL_INCUMBENT_REGISTRY_HASH,
    candidateLineageParentExact: candidateLineageParent === CANDIDATE_PARENT_HASH,
    allIncumbentTypedRecordsRetained: missingRecords.length === 0,
    candidateAdditionalTypedRecordsExact: arraysEqual(additionalRecords, EXPECTED_ADDITIONAL_RECORD_IDS),
    noLostIndependentTopLevelRecords: Object.values(topLevelContainment).every(ids => ids.length === 0),
    omittedCompiledEntriesHaveTypedBackings: omittedCompiled.length > 0
      && omittedCompiled.every(item => item.backingTypedRecordPresent),
    typedKnowledgeRecordPresent: candidateRecords.has(TYPED_RECORD_ID),
    canonicalRuntimeExact: candidate.lariConsolidation?.canonicalRuntime === 'sendMessageToLari -> runLariUnifiedTaskKernel',
    noTemporaryModelFiles: temporaryFiles(path.dirname(registry.currentModelPath)).length === 0,
    noTemporaryRegistryFiles: temporaryFiles(path.dirname(registry.registryPath)).length === 0,
    defaultRegistryOnly: registry.listLariModelCandidates().length === 1
      && registry.listLariModelCandidates()[0].id === 'canonical-current'
  };
  assert(Object.values(gates).every(Boolean), `Production preflight failed: ${JSON.stringify(gates)}`);

  return {
    candidate,
    incumbent,
    currentRegistry,
    rehearsal,
    candidateLineageParent,
    missingRecords,
    additionalRecords,
    topLevelContainment,
    omittedCompiled,
    gates
  };
}

function automaticRollback(error, backups) {
  const before = state();
  let result = null;
  if (before.active === CANDIDATE_HASH && fs.existsSync(ACTIVE_BACKUP)) {
    const restored = registry.promoteLariModel(ACTIVE_BACKUP, {
      stage: 'public-surface-uncertainty-production-promotion',
      transaction: 'automatic-rollback-public-surface-uncertainty',
      rollback: true,
      rollbackTargetHash: INCUMBENT_HASH,
      rolledBackFromHash: CANDIDATE_HASH,
      candidateLineageParentHash: CANDIDATE_PARENT_HASH,
      canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
      ordinaryInferenceReadOnly: true,
      fallbackDiscoveryDisabled: true,
      externalModelCalls: 0
    });
    const after = state();
    result = {
      attempted: true,
      activeHash: after.active,
      registryHash: after.registry,
      exactIncumbentRestored: after.active === INCUMBENT_HASH,
      promotionRecorded: restored.activeModelSha256 === INCUMBENT_HASH
    };
  } else {
    result = {
      attempted: false,
      activeHash: before.active,
      registryHash: before.registry,
      reason: 'candidate was not the active model at failure handling'
    };
  }
  if (!fs.existsSync(FAILURE)) {
    writeExclusive(FAILURE, {
      schemaVersion: 1,
      kind: 'lari.public-surface-uncertainty.production-promotion.failure',
      createdAt: new Date().toISOString(),
      candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH },
      incumbent: { sha256: INCUMBENT_HASH, registrySha256: INCUMBENT_REGISTRY_HASH },
      backups,
      error: { message: error.message, stack: error.stack },
      rollback: result
    }, true);
  }
  return result;
}

async function main() {
  const checked = preflight();
  if (process.argv.includes('--preflight-only')) {
    process.stdout.write(`${JSON.stringify({
      passed: true,
      candidateHash: CANDIDATE_HASH,
      incumbentHash: INCUMBENT_HASH,
      registryHash: INCUMBENT_REGISTRY_HASH,
      gates: checked.gates
    }, null, 2)}\n`);
    return;
  }
  const worktreeBefore = worktreeSnapshot();
  const backups = {
    active: preserve(registry.currentModelPath, ACTIVE_BACKUP, INCUMBENT_HASH),
    registry: preserve(registry.registryPath, REGISTRY_BACKUP, INCUMBENT_REGISTRY_HASH)
  };
  assert(backups.active.immutable && backups.registry.immutable, 'Content-addressed backups were not made immutable.');
  writeExclusive(PREFLIGHT, {
    schemaVersion: 1,
    kind: 'lari.public-surface-uncertainty.production-preflight',
    createdAt: new Date().toISOString(),
    candidate: fileInfo(CANDIDATE),
    incumbent: fileInfo(registry.currentModelPath),
    registry: fileInfo(registry.registryPath),
    rehearsal: fileInfo(REHEARSAL),
    priorAttemptFailure: fileInfo(PREVIOUS_ATTEMPT_FAILURE),
    candidateLineage: {
      parentHash: checked.candidateLineageParent,
      productionIncumbentHash: INCUMBENT_HASH,
      note: 'The immutable candidate parent is not the current production incumbent; both identities are preserved explicitly.'
    },
    typedRecordRetention: {
      incumbentRecordCount: recordIds(checked.incumbent).size,
      candidateRecordCount: recordIds(checked.candidate).size,
      missingIncumbentRecordIds: checked.missingRecords,
      additionalCandidateRecordIds: checked.additionalRecords
    },
    derivedProjectionClassification: {
      independentTopLevelMissing: checked.topLevelContainment,
      incumbentOnlyCompiledEntries: checked.omittedCompiled,
      conclusion: 'The omitted compiled entries are derived projections backed by retained canonical typed records; they are not deleted source intelligence.'
    },
    backups,
    worktreeBefore,
    gates: checked.gates,
    passed: true
  }, true);

  try {
    const promoted = registry.promoteLariModel(CANDIDATE, {
      stage: 'public-surface-uncertainty-production-promotion',
      transaction: 'hash-locked-real-production-promotion',
      candidateHash: CANDIDATE_HASH,
      candidateProvenance: rel(CANDIDATE),
      candidateLineageParentHash: CANDIDATE_PARENT_HASH,
      productionIncumbentHash: INCUMBENT_HASH,
      rollbackTargetHash: INCUMBENT_HASH,
      preflightManifest: rel(PREFLIGHT),
      preflightManifestHash: shaFile(PREFLIGHT),
      rehearsalManifest: rel(REHEARSAL),
      rehearsalManifestHash: REHEARSAL_HASH,
      typedKnowledgeRecordId: TYPED_RECORD_ID,
      canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
      ordinaryInferenceReadOnly: true,
      fallbackDiscoveryDisabled: true,
      externalModelCalls: 0
    });

    const afterPromotion = state();
    const postRegistry = readJson(registry.registryPath);
    const rollbackPath = path.resolve(ROOT, postRegistry.previousModelPath || '');
    const promotedModel = registry.loadLariModel().model;
    const resolved = registry.resolveLariModelPath();
    const candidates = registry.listLariModelCandidates();
    const immediate = {
      exactCandidateActivated: afterPromotion.active === CANDIDATE_HASH,
      registryHeadExact: postRegistry.activeModelSha256 === CANDIDATE_HASH,
      registryMetadataCandidateExact: postRegistry.metadata?.candidateHash === CANDIDATE_HASH,
      candidateProvenanceExact: postRegistry.metadata?.candidateProvenance === rel(CANDIDATE),
      candidateLineageParentExact: postRegistry.metadata?.candidateLineageParentHash === CANDIDATE_PARENT_HASH,
      productionIncumbentExact: postRegistry.metadata?.productionIncumbentHash === INCUMBENT_HASH,
      rollbackTargetExact: postRegistry.metadata?.rollbackTargetHash === INCUMBENT_HASH,
      registryBackupExact: Boolean(rollbackPath && fs.existsSync(rollbackPath) && shaFile(rollbackPath) === INCUMBENT_HASH),
      contentAddressedBackupsExact: shaFile(ACTIVE_BACKUP) === INCUMBENT_HASH
        && shaFile(REGISTRY_BACKUP) === INCUMBENT_REGISTRY_HASH,
      contentAddressedBackupsImmutable: (fs.statSync(ACTIVE_BACKUP).mode & 0o222) === 0
        && (fs.statSync(REGISTRY_BACKUP).mode & 0o222) === 0,
      allIncumbentTypedRecordsRetained: [...recordIds(checked.incumbent)].every(id => recordIds(promotedModel).has(id)),
      typedKnowledgeRecordPresent: recordIds(promotedModel).has(TYPED_RECORD_ID),
      registryOnlyResolution: resolved.source === 'registry'
        && resolved.path === registry.currentModelPath
        && candidates.length === 1
        && candidates[0].id === 'canonical-current',
      noTemporaryActivationFiles: temporaryFiles(path.dirname(registry.currentModelPath)).length === 0
        && temporaryFiles(path.dirname(registry.registryPath)).length === 0,
      immutableInputsUnchanged: shaFile(CANDIDATE) === CANDIDATE_HASH && shaFile(REHEARSAL) === REHEARSAL_HASH
    };
    assert(Object.values(immediate).every(Boolean), `Immediate production validation failed: ${JSON.stringify(immediate)}`);

    const portBase = 9180 + (process.pid % 40) * 2;
    const surfaces = {};
    surfaces.cli = await observedSurface('cli_implementation', async () => runAsk());
    surfaces.openai_compatible_api = await observedSurface('openai_compatible_api', async () => runApi(
      portBase,
      path.join(OUT, 'runtime-state-api.json')
    ));
    surfaces.workbench = await observedSurface('workbench', async () => runWorkbench(
      portBase + 1,
      path.join(OUT, 'runtime-state-workbench.json')
    ));
    surfaces.autonomous = await observedSurface('autonomous', async () => runAutonomous());
    const views = Object.values(surfaces).map(item => item.view);
    const surfaceChecks = {
      allFourSurfacesExercised: views.length === 4,
      exactCandidateHashAcrossSurfaces: views.every(view => view.modelHash === CANDIDATE_HASH),
      sameCapabilitySelection: views.map(signature).every(value => value === signature(views[0])),
      allIncludeTypedKnowledgeRecord: views.every(view => view.learnedRecordIds.includes(TYPED_RECORD_ID)),
      allRetainVerifiedFact: views.every(view => EXPECTED_FACT.test(view.answer)),
      sameAnswerAcrossSurfaces: views.every(view => view.answer === views[0].answer),
      noExternalModelCalls: views.every(view => view.externalModelCalls === 0),
      readOnlyActiveAndRegistry: Object.values(surfaces).every(item => item.activeReadOnly && item.registryReadOnly),
      cliResolvedActiveNotCandidate: surfaces.cli.modelPath === rel(registry.currentModelPath),
      autonomousCanonicalPath: surfaces.autonomous.view.action === 'chat'
        && surfaces.autonomous.view.publicAnswerSource === 'verified_retained_knowledge'
    };
    assert(Object.values(surfaceChecks).every(Boolean), `Public-surface parity failed: ${JSON.stringify(surfaceChecks)}`);

    const coldReload = await observedSurface('cold_reload_autonomous', async () => runAutonomous());
    const coldReloadChecks = {
      exactCandidateHash: coldReload.view.modelHash === CANDIDATE_HASH,
      sameCapabilitySelection: signature(coldReload.view) === signature(views[0]),
      retainedTypedRecord: coldReload.view.learnedRecordIds.includes(TYPED_RECORD_ID),
      retainedFact: EXPECTED_FACT.test(coldReload.view.answer),
      readOnly: coldReload.activeReadOnly && coldReload.registryReadOnly,
      noExternalModelCalls: coldReload.view.externalModelCalls === 0
    };
    assert(Object.values(coldReloadChecks).every(Boolean), `Cold reload validation failed: ${JSON.stringify(coldReloadChecks)}`);

    const regressionBefore = state();
    const recapRegression = runReadOnlyRegression('scripts/test_lari_recap_language.js');
    const chatCodingRegression = runReadOnlyRegression('scripts/test_lari_public_chat_coding_convergence.js');
    const directRecap = recapFamilyRegression(promotedModel);
    const legacyTransfer = legacyTransferSample(promotedModel);
    const regressionAfter = state();
    const regressionChecks = {
      recapScriptSevenOfSeven: recapRegression.passed === true
        && recapRegression.activeHash === CANDIDATE_HASH
        && recapRegression.families === '7/7',
      chatCodingFrontDoor: chatCodingRegression.passed === true
        && chatCodingRegression.modelHash === CANDIDATE_HASH
        && chatCodingRegression.cliParity === true,
      directRecapSevenOfSeven: directRecap.passed === true && directRecap.passedCount === 7,
      legacyTransferSeventeenOfSeventeen: legacyTransfer.passed === true && legacyTransfer.passedCount === 17,
      noRegressionWrites: stable(regressionBefore) === stable(regressionAfter)
    };
    assert(Object.values(regressionChecks).every(Boolean), `Regression validation failed: ${JSON.stringify(regressionChecks)}`);

    const validation = {
      schemaVersion: 1,
      kind: 'lari.public-surface-uncertainty.production-post-promotion-validation',
      createdAt: new Date().toISOString(),
      passed: true,
      candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH, parentHash: CANDIDATE_PARENT_HASH },
      incumbent: { sha256: INCUMBENT_HASH, registrySha256: INCUMBENT_REGISTRY_HASH },
      active: {
        path: rel(registry.currentModelPath),
        sha256: afterPromotion.active,
        registryPath: rel(registry.registryPath),
        registrySha256: afterPromotion.registry,
        promotedAt: promoted.promotedAt
      },
      immediate,
      publicSurfaces: surfaces,
      publicSurfaceChecks: surfaceChecks,
      coldReload,
      coldReloadChecks,
      regression: {
        recapScript: recapRegression,
        chatCodingScript: chatCodingRegression,
        directRecap,
        legacyTransfer,
        checks: regressionChecks
      },
      rollback: {
        registryBackupPath: rel(rollbackPath),
        registryBackupSha256: shaFile(rollbackPath),
        contentAddressedBackups: backups,
        procedure: 'Run registry.rollbackLariModel with the exact incumbent hash after setting LARI_ALLOW_REAL_PROMOTION=1, or promote the content-addressed active backup through the existing registry transaction.'
      },
      limitations: [
        'The cobalt-orbit knowledge source is a local fixture; this promotion proves one retained public uncertainty-research lifecycle, not arbitrary web-source quality.',
        'The host lacks npm and its bundled Node --run carrier crashes before package startup. The CLI gate executed scripts/lari_ask.js, the exact implementation mapped by npm run lari:ask; wrapper-level npm execution is not claimed.',
        'The registry manifest records activation lineage, while the loader resolves the current namespace directly. Manifest-driven path selection is not independently claimed.',
        'The 17-record transfer check is a legacy reusable-knowledge regression sample, not a new sealed external benchmark.',
        'Attempt 1 was automatically rolled back before surface results were evaluated because its wrapper mishandled the CLI result shape. Its immutable failure manifest and exact active-hash restoration are bound into this attempt preflight.'
      ],
      externalModelCalls: 0
    };
    writeExclusive(VALIDATION, validation, true);

    const manifest = {
      schemaVersion: 1,
      kind: 'lari.public-surface-uncertainty.production-promotion',
      createdAt: new Date().toISOString(),
      passed: true,
      candidate: validation.candidate,
      incumbent: validation.incumbent,
      promotion: validation.active,
      preflight: { path: rel(PREFLIGHT), sha256: shaFile(PREFLIGHT) },
      rehearsal: { path: rel(REHEARSAL), sha256: REHEARSAL_HASH },
      validation: { path: rel(VALIDATION), sha256: shaFile(VALIDATION) },
      rollback: validation.rollback,
      gates: {
        preflight: Object.values(checked.gates).every(Boolean),
        immediate: Object.values(immediate).every(Boolean),
        publicSurfaceParity: Object.values(surfaceChecks).every(Boolean),
        coldReload: Object.values(coldReloadChecks).every(Boolean),
        familyRegression: Object.values(regressionChecks).every(Boolean)
      },
      verdict: 'Promotion succeeded',
      externalModelCalls: 0
    };
    writeExclusive(MANIFEST, manifest, true);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const rollback = automaticRollback(error, backups);
    if (rollback.attempted) assert(rollback.exactIncumbentRestored, 'Automatic rollback did not restore the exact incumbent hash.');
    throw error;
  }
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});


