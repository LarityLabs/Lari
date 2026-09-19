#!/usr/bin/env node
'use strict';

// Isolated promotion rehearsal for the immutable cumulative-apprenticeship
// Cycle 3 candidate. This is deliberately a test harness around the existing atomic
// registry transaction and existing public entry points. It never writes the
// real registry or active model namespace.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const recap = require('../swarm_recap_language.js');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const LEGACY_ROOT = path.join(ROOT, 'swarm-model.json');
const PARENT = path.join(ROOT, 'consolidation', 'one-hour-apprenticeship-sprint-20260913', 'candidates', '11bdeeacf3a605cf5959d8ddc6cc980848c98e2ad1025c0034c7c55e7d16cb77.json');
const CANDIDATE = path.join(ROOT, 'consolidation', 'sealed-cumulative-apprenticeship-cycle3-20260913', 'candidates', '4e285ade5e353853b253b3371d3411a24e4d4d162186cb2068b265f4cf2d30e2.json');
const QUALIFICATION = path.join(ROOT, 'consolidation', 'sealed-cumulative-apprenticeship-cycle3-20260913', 'report.json');
const CANDIDATE_HASH = '4e285ade5e353853b253b3371d3411a24e4d4d162186cb2068b265f4cf2d30e2';
const PARENT_HASH = '11bdeeacf3a605cf5959d8ddc6cc980848c98e2ad1025c0034c7c55e7d16cb77';
const TYPED_RECORD_ID = 'lari.learned.knowledge.4fab0a17a9314c8f';
const PROMPT = 'What is the cobalt-orbit quorum ledger?';
const EXPECTED_FACT = /cobalt-orbit.*quorum.*epoch.*witness|quorum.*epoch.*witness/i;
const ACQUIRED_RECORD_IDS = [
  'lari.learned.operator.neurogenesis.499acbcdd894611c290c',
  'lari.learned.operator.neurogenesis.c35818debd7272fc62c9',
  'lari.learned.operator.neurogenesis.d5723e57d0ebfd4a05df',
  'lari.learned.procedure.coordinated.d872075f'
];
const OUT = path.join(ROOT, 'consolidation', 'sealed-cumulative-apprenticeship-cycle3-promotion-rehearsal-20260913');
// The existing write guard intentionally permits only isolated promotion
// namespaces under this directory. Evidence lives outside it so the living
// report can index the rehearsal without scanning a writable clone.
const ISOLATED = path.join(ROOT, 'consolidation', 'stage-3-rehearsal', 'sealed-cumulative-apprenticeship-cycle3-promotion-rehearsal-20260913');
const USER_SCOPE = 'cumulative-apprenticeship-rehearsal';

const clone = value => JSON.parse(JSON.stringify(value));
const shaBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => shaBytes(fs.readFileSync(file));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const stable = value => JSON.stringify(value ?? null);

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function inside(container, target) {
  const relative = path.relative(container, target);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function protectedHashes() {
  return {
    active: shaFile(ACTIVE),
    registry: shaFile(REGISTRY),
    legacyRoot: shaFile(LEGACY_ROOT),
    parent: shaFile(PARENT),
    candidate: shaFile(CANDIDATE)
  };
}

function cloneRegistry(name) {
  const destination = path.join(ISOLATED, name, 'registry');
  const current = path.join(destination, 'current');
  fs.mkdirSync(current, { recursive: true });
  fs.copyFileSync(REGISTRY, path.join(destination, 'registry.json'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(ACTIVE, path.join(current, 'swarm-model.json'), fs.constants.COPYFILE_EXCL);
  return destination;
}

function rehearsalEnv(registryRoot, extra = {}) {
  const env = { ...process.env };
  // An inherited explicit path would bypass the rehearsal namespace, and real
  // promotion is expressly out of scope for this command.
  delete env.LARI_MODEL_PATH;
  delete env.LARI_ALLOW_REAL_PROMOTION;
  return {
    ...env,
    LARI_REGISTRY_ROOT: rel(registryRoot),
    LARI_ALLOW_ISOLATED_REGISTRY_WRITES: '1',
    LARI_DISABLE_MODEL_FALLBACKS: '1',
    LARI_ALLOW_LEGACY_ROOT_MODEL: '0',
    LARI_AUTONOMOUS_LEARNING: '0',
    LARI_AUTONOMOUS_PROMOTION: '0',
    LARI_USER_SCOPE: USER_SCOPE,
    LARI_REHEARSAL_CANDIDATE_PROVENANCE: rel(CANDIDATE),
    ...extra
  };
}

function worker(operation, registryRoot, argument = CANDIDATE) {
  const run = spawnSync(process.execPath, ['scripts/lari_stage3_registry_worker.js', operation, argument], {
    cwd: ROOT,
    env: rehearsalEnv(registryRoot),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024
  });
  let output;
  try {
    output = JSON.parse(String(run.stdout || '').trim());
  } catch (_) {
    throw new Error(`Registry worker returned invalid JSON for ${operation}: ${run.stdout}\n${run.stderr}`);
  }
  if (run.status !== 0 || output.fatal) {
    throw new Error(`Registry worker failed for ${operation}: ${JSON.stringify(output.fatal || output)}`);
  }
  return output;
}

function modelState(registryRoot) {
  const current = path.join(registryRoot, 'current', 'swarm-model.json');
  const registry = path.join(registryRoot, 'registry.json');
  return { active: shaFile(current), registry: shaFile(registry) };
}

function indexFingerprints(model) {
  return Object.fromEntries([
    'lariCapabilityGraph',
    'lariCapabilityGenome',
    'routeMemory'
  ].map(key => [key, model[key] === undefined ? null : shaBytes(Buffer.from(stable(model[key])))]));
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
  const selection = response.capabilitySelection || response.capability_selection || raw.capability_selection || lari.capability_selection || null;
  const learned = response.learnedRecordIds || response.learned_record_ids || raw.learned_record_ids || lari.learned_record_ids || [];
  const answer = response.answer || raw.answer || completion?.choices?.[0]?.message?.content || raw.output_text || '';
  return {
    modelHash: response.modelHash || response.model_hash || raw.model_hash || lari.model_hash || normalizeSelection(selection)?.modelHash || null,
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

function workerView(raw = {}) {
  return {
    modelHash: raw.modelHash || null,
    capabilitySelection: normalizeSelection(raw.selection),
    learnedRecordIds: [...new Set(raw.learnedRecordIds || [])].sort(),
    action: raw.action || null,
    publicAnswerSource: raw.publicAnswerSource || null,
    answer: String(raw.answer || '').trim(),
    passed: raw.passed === true,
    externalModelCalls: Number(raw.external_model_calls || 0),
    resolved: raw.resolved || null
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
  if (marker < 0) throw new Error(`npm run lari:ask did not emit debug diagnostics:\n${stdout}`);
  const answer = String(stdout).slice(0, marker).trim();
  const diagnostics = JSON.parse(String(stdout).slice(marker + 5));
  return publicView({
    response: diagnostics,
    answer,
    model_hash: diagnostics.modelHash,
    external_model_calls: diagnostics.externalModelCalls
  });
}

function runAsk(registryRoot) {
  // This host has neither an npm executable nor a usable Node --run carrier
  // (the bundled Windows runtime crashes before script startup). Invoke the
  // exact implementation mapped by `npm run lari:ask` in package.json; the
  // evidence labels this honestly as the underlying CLI script, not npm.
  const run = spawnSync(process.execPath, ['scripts/lari_ask.js', '--debug', '--user', USER_SCOPE, PROMPT], {
    cwd: ROOT,
    env: rehearsalEnv(registryRoot),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120000
  });
  if (run.status !== 0) throw new Error(`lari:ask implementation failed: ${run.stderr || run.stdout}`);
  const view = parseAskDebug(run.stdout);
  return { view, modelPath: JSON.parse(String(run.stdout).slice(String(run.stdout).lastIndexOf('\n---\n') + 5)).modelPath || null };
}

function runAutonomous(registryRoot) {
  const payload = {
    model: 'lari',
    prompt: PROMPT,
    context: context('autonomous')
  };
  const run = spawnSync(process.execPath, ['scripts/lari_model_cli.js'], {
    cwd: ROOT,
    env: rehearsalEnv(registryRoot),
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120000
  });
  if (run.status !== 0) throw new Error(`Autonomous carrier failed: ${run.stderr || run.stdout}`);
  return publicView(JSON.parse(run.stdout));
}

function readChildOutput(child) {
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
    } catch (_) { /* poll the short-lived local service */ }
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
  try { json = JSON.parse(text); } catch (_) { throw new Error(`${url} returned non-JSON: ${text}`); }
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function runApi(registryRoot, port, statePath) {
  const child = spawn('python', ['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: ROOT,
    env: rehearsalEnv(registryRoot, { LARI_RUNTIME_STATE_PATH: statePath }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = readChildOutput(child);
  try {
    await waitFor(`http://127.0.0.1:${port}/health`, child, 'OpenAI-compatible API');
    return publicView(await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
      model: 'lari',
      messages: [{ role: 'user', content: PROMPT }],
      include_diagnostics: true,
      lari_context: context('openai_compatible_api')
    }));
  } catch (error) {
    const logs = output();
    throw new Error(`${error.message}\nAPI stdout: ${logs.stdout}\nAPI stderr: ${logs.stderr}`);
  } finally {
    await stopChild(child);
  }
}

async function runWorkbench(registryRoot, port, statePath) {
  const child = spawn('python', ['start_workspace.py'], {
    cwd: ROOT,
    env: rehearsalEnv(registryRoot, {
      LARI_RUNTIME_STATE_PATH: statePath,
      LARI_WORKSPACE_HOST: '127.0.0.1',
      LARI_WORKSPACE_PORT: String(port),
      LARI_NO_BROWSER: '1'
    }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = readChildOutput(child);
  try {
    await waitFor(`http://127.0.0.1:${port}/api/lari/history`, child, 'Workbench');
    return publicView(await postJson(`http://127.0.0.1:${port}/api/lari/chat`, {
      prompt: PROMPT,
      includeDiagnostics: true,
      userScope: USER_SCOPE,
      lari_context: context('workbench')
    }));
  } catch (error) {
    const logs = output();
    throw new Error(`${error.message}\nWorkbench stdout: ${logs.stdout}\nWorkbench stderr: ${logs.stderr}`);
  } finally {
    await stopChild(child);
  }
}

async function observedSurface(name, registryRoot, invoke) {
  const before = modelState(registryRoot);
  const result = await invoke();
  const after = modelState(registryRoot);
  return {
    name,
    ...result,
    before,
    after,
    activeReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry
  };
}

function runReadOnlyRegression(script, registryRoot) {
  const run = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env: rehearsalEnv(registryRoot),
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
  return { total: rows.length, passedCount: rows.filter(row => row.passed).length, passed: rows.length === 17 && rows.every(row => row.passed), rows };
}

function checkRecapFamilies(model) {
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
  return { total: rows.length, passedCount: rows.filter(row => row.passed).length, passed: rows.every(row => row.passed), rows };
}

function markdownTable(rows, headers) {
  const clean = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    `| ${headers.map(header => header.label).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${headers.map(header => clean(header.value(row))).join(' | ')} |`)
  ].join('\n');
}

async function main() {
  if (fs.existsSync(OUT) || fs.existsSync(ISOLATED)) {
    throw new Error(`Refusing to overwrite rehearsal output: ${rel(OUT)} or ${rel(ISOLATED)}`);
  }
  for (const input of [ACTIVE, REGISTRY, LEGACY_ROOT, PARENT, CANDIDATE, QUALIFICATION]) {
    if (!fs.existsSync(input)) throw new Error(`Missing required input: ${rel(input)}`);
  }
  const realBefore = protectedHashes();
  if (realBefore.parent !== PARENT_HASH) throw new Error(`Unexpected parent hash ${realBefore.parent}`);
  if (realBefore.candidate !== CANDIDATE_HASH) throw new Error(`Unexpected candidate hash ${realBefore.candidate}`);
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE, 'utf8'));
  const parent = JSON.parse(fs.readFileSync(PARENT, 'utf8'));
  const qualification = JSON.parse(fs.readFileSync(QUALIFICATION, 'utf8'));
  const typedRecord = (candidate.lariLearnedRecords?.records || []).find(record => record.id === TYPED_RECORD_ID) || null;
  const parentIds = new Set((parent.lariLearnedRecords?.records || []).map(record => record.id));
  const candidateIds = new Set((candidate.lariLearnedRecords?.records || []).map(record => record.id));
  const addedRecords = [...candidateIds].filter(id => !parentIds.has(id));
  const candidateProvenance = {
    candidateHashExact: realBefore.candidate === CANDIDATE_HASH,
    parentHashExact: candidate.lineage?.parentHash === PARENT_HASH,
    canonicalRuntime: candidate.lineage?.canonicalRuntime === 'sendMessageToLari -> runLariUnifiedTaskKernel',
    unpromoted: candidate.lineage?.promoted === false && candidate.lariConsolidation?.promoted === false,
    typedKnowledgeRecord: typedRecord?.type === 'knowledge',
    parentRecordsPreserved: [...parentIds].every(id => candidateIds.has(id)),
    allAcquiredRecordsPresent: ACQUIRED_RECORD_IDS.every(id => candidateIds.has(id)),
    acquiredRecordsAreNew: ACQUIRED_RECORD_IDS.every(id => addedRecords.includes(id)),
    sealedQualificationPassed: qualification.passed === true
      && qualification.candidate?.sha256 === CANDIDATE_HASH
      && Object.values(qualification.gates || {}).every(Boolean),
    storedIndexFingerprint: stable(indexFingerprints(candidate))
  };

  fs.mkdirSync(OUT, { recursive: true });
  const promotionRoot = cloneRegistry('promotion');
  const promotion = worker('promote', promotionRoot);
  const promotedModelPath = path.join(promotionRoot, 'current', 'swarm-model.json');
  const promotedRegistryPath = path.join(promotionRoot, 'registry.json');
  const promotedRegistry = promotion.after.registry || {};
  const backupPath = promotedRegistry.previousModelPath ? path.resolve(ROOT, promotedRegistry.previousModelPath) : null;
  const promotedModel = JSON.parse(fs.readFileSync(promotedModelPath, 'utf8'));
  const promotionChecks = {
    exactCandidateActivated: shaFile(promotedModelPath) === CANDIDATE_HASH && promotion.after.currentHash === CANDIDATE_HASH,
    isolatedActivePath: promotedRegistry.activeModelPath === rel(promotedModelPath),
    manifestHashMatches: promotedRegistry.activeModelSha256 === CANDIDATE_HASH,
    candidateProvenanceRecorded: promotedRegistry.promotedFrom === rel(CANDIDATE)
      && promotedRegistry.metadata?.candidateHash === CANDIDATE_HASH
      && promotedRegistry.metadata?.candidateProvenance === rel(CANDIDATE),
    candidateLineagePreserved: candidateProvenance.parentHashExact && candidateProvenance.canonicalRuntime && candidateProvenance.unpromoted,
    backupPointerInsideClone: Boolean(backupPath) && inside(ISOLATED, backupPath),
    backupRestoresExactIncumbent: Boolean(backupPath) && fs.existsSync(backupPath) && shaFile(backupPath) === realBefore.active,
    historyRecordsPromotion: promotedRegistry.history?.[0]?.promotedFrom === rel(CANDIDATE)
      && promotedRegistry.history?.[0]?.metadata?.candidateHash === CANDIDATE_HASH,
    canonicalOnlyCandidateList: (promotedRegistry.candidates || []).length === 1
      && promotedRegistry.candidates?.[0]?.id === 'canonical-current',
    sameStoredDerivedIndexes: stable(indexFingerprints(promotedModel)) === candidateProvenance.storedIndexFingerprint
  };

  const coldStart = worker('inference', promotionRoot, PROMPT);
  const coldStartView = workerView(coldStart);
  const coldStartChecks = {
    resolvedIsolatedRegistry: coldStart.resolved?.source === 'registry' && coldStart.resolved?.path === promotedModelPath,
    hashExact: coldStartView.modelHash === CANDIDATE_HASH,
    retainedKnowledgeSelected: coldStartView.learnedRecordIds.includes(TYPED_RECORD_ID),
    answerRetained: EXPECTED_FACT.test(coldStartView.answer),
    activeReadOnly: coldStart.before?.currentHash === coldStart.after?.currentHash,
    registryReadOnly: coldStart.before?.registryHash === coldStart.after?.registryHash,
    noExternalModelCalls: coldStartView.externalModelCalls === 0
  };

  const portSeed = process.pid % 40;
  const surfaces = {};
  const cli = await observedSurface('cli', promotionRoot, async () => runAsk(promotionRoot));
  surfaces.cli = cli;
  const api = await observedSurface('openai_compatible_api', promotionRoot, async () => runApi(
    promotionRoot,
    9100 + portSeed,
    path.join(OUT, 'runtime', 'openai-api-state.json')
  ));
  surfaces.openai_compatible_api = api;
  const workbench = await observedSurface('workbench', promotionRoot, async () => runWorkbench(
    promotionRoot,
    9200 + portSeed,
    path.join(OUT, 'runtime', 'workbench-state.json')
  ));
  surfaces.workbench = workbench;
  const autonomous = await observedSurface('autonomous', promotionRoot, async () => runAutonomous(promotionRoot));
  surfaces.autonomous = autonomous;
  const surfaceViews = Object.values(surfaces).map(row => row.view || row);
  const selectionSignatures = surfaceViews.map(signature);
  const surfaceChecks = {
    allFourSurfacesExercised: Object.keys(surfaces).length === 4,
    allSurfacesExactHash: surfaceViews.every(view => view.modelHash === CANDIDATE_HASH),
    sameCapabilitySelection: selectionSignatures.every(value => value === selectionSignatures[0]),
    allIncludeTypedKnowledgeRecord: surfaceViews.every(view => view.learnedRecordIds.includes(TYPED_RECORD_ID)),
    allRetainAnswerFacts: surfaceViews.every(view => EXPECTED_FACT.test(view.answer)),
    noExternalModelCalls: surfaceViews.every(view => view.externalModelCalls === 0),
    allSurfaceInferenceReadOnly: Object.values(surfaces).every(row => row.activeReadOnly && row.registryReadOnly),
    cliResolvedCloneNotCandidate: cli.modelPath === rel(promotedModelPath),
    autonomousUsesCanonicalAutonomousPath: autonomous.action === 'chat' && autonomous.publicAnswerSource === 'verified_retained_knowledge'
  };

  const reload = await observedSurface('cold_reload_autonomous', promotionRoot, async () => runAutonomous(promotionRoot));
  const reloadView = reload.view || reload;
  const reloadChecks = {
    freshProcessRetainsCandidateHash: reloadView.modelHash === CANDIDATE_HASH,
    retainedRecordAfterReload: reloadView.learnedRecordIds.includes(TYPED_RECORD_ID),
    retainedAnswerAfterReload: EXPECTED_FACT.test(reloadView.answer),
    sameSelectionAsSurfaces: signature(reloadView) === selectionSignatures[0],
    activeReadOnly: reload.activeReadOnly,
    registryReadOnly: reload.registryReadOnly,
    noExternalModelCalls: reloadView.externalModelCalls === 0
  };

  const regressionBefore = modelState(promotionRoot);
  const recapRegression = runReadOnlyRegression('scripts/test_lari_recap_language.js', promotionRoot);
  const chatCodingRegression = runReadOnlyRegression('scripts/test_lari_public_chat_coding_convergence.js', promotionRoot);
  const familyRows = checkRecapFamilies(promotedModel);
  const legacyTransfer = legacyTransferSample(promotedModel);
  const regressionAfter = modelState(promotionRoot);
  const regressionChecks = {
    existingSevenFamilyRecapRegression: recapRegression.passed === true && recapRegression.activeHash === CANDIDATE_HASH && recapRegression.families === '7/7',
    existingChatCodingFrontDoorRegression: chatCodingRegression.passed === true && chatCodingRegression.modelHash === CANDIDATE_HASH && chatCodingRegression.cliParity === true,
    directSevenFamilyRecapRegression: familyRows.passed && familyRows.passedCount === 7,
    legacyTransferSample17Of17: legacyTransfer.passed && legacyTransfer.passedCount === 17,
    noFamilyRegressionWrites: stable(regressionBefore) === stable(regressionAfter)
  };

  const rollbackRoot = cloneRegistry('rollback');
  const rollback = worker('rollback', rollbackRoot);
  const rollbackChecks = {
    candidateWasActivatedInRollbackScenario: rollback.promoted?.activeModelSha256 === CANDIDATE_HASH,
    targetIsOriginalIncumbent: rollback.rollbackTargetHash === realBefore.active,
    activeRestoredExactly: rollback.after?.currentHash === realBefore.active,
    registryRecordsRollback: rollback.after?.registry?.metadata?.rollback === true
      && rollback.after?.registry?.metadata?.rollbackTargetSha256 === realBefore.active,
    noTemporaryActivation: (rollback.after?.temporaryFiles || []).length === 0
  };

  const interruptedCurrentRoot = cloneRegistry('interrupted-current');
  const interruptedCurrent = worker('interrupt-current', interruptedCurrentRoot);
  const interruptedRegistryRoot = cloneRegistry('interrupted-registry');
  const interruptedRegistry = worker('interrupt-registry', interruptedRegistryRoot);
  const interruptionChecks = {
    currentWriteInterrupted: interruptedCurrent.error?.code === 'LARI_ATOMIC_WRITE_INTERRUPTED',
    currentIncumbentRemainsActive: interruptedCurrent.after?.currentHash === interruptedCurrent.before?.currentHash,
    currentRegistryRemainsIntact: interruptedCurrent.after?.registryHash === interruptedCurrent.before?.registryHash,
    currentTemporaryFilesCleaned: (interruptedCurrent.after?.temporaryFiles || []).length === 0,
    registryWriteInterrupted: interruptedRegistry.error?.code === 'LARI_ATOMIC_WRITE_INTERRUPTED',
    registryIncumbentRestored: interruptedRegistry.after?.currentHash === interruptedRegistry.before?.currentHash,
    registryManifestRestored: interruptedRegistry.after?.registryHash === interruptedRegistry.before?.registryHash,
    registryTemporaryFilesCleaned: (interruptedRegistry.after?.temporaryFiles || []).length === 0
  };

  const corruptRoot = cloneRegistry('corrupt');
  const corruptPath = path.join(OUT, 'faults', 'corrupted-candidate.json');
  writeExclusive(corruptPath, '{"schemaVersion":1,"modelId":"lari-local-model","compiledSkills":');
  const corruptBackupBefore = fs.readdirSync(path.join(corruptRoot, 'current')).filter(name => /backup-\d+/.test(name)).length;
  const corrupt = worker('corrupt', corruptRoot, corruptPath);
  const corruptBackupAfter = fs.readdirSync(path.join(corruptRoot, 'current')).filter(name => /backup-\d+/.test(name)).length;
  const corruptionChecks = {
    corruptCandidateRejected: Boolean(corrupt.error),
    incumbentRemainsActive: corrupt.after?.currentHash === corrupt.before?.currentHash,
    registryRemainsIntact: corrupt.after?.registryHash === corrupt.before?.registryHash,
    noBackupBeforeValidation: corruptBackupAfter === corruptBackupBefore,
    noTemporaryActivation: (corrupt.after?.temporaryFiles || []).length === 0
  };

  const noFallbackRoot = path.join(ISOLATED, 'no-fallback', 'registry');
  fs.mkdirSync(noFallbackRoot, { recursive: true });
  fs.copyFileSync(REGISTRY, path.join(noFallbackRoot, 'registry.json'), fs.constants.COPYFILE_EXCL);
  const fallback = worker('resolve', noFallbackRoot);
  const fallbackChecks = {
    missingActiveResolvesDefault: fallback.resolved?.source === 'default' && fallback.resolved?.path === null,
    canonicalOnlyCandidateList: fallback.candidateList?.length === 1 && fallback.candidateList?.[0]?.id === 'canonical-current',
    canonicalCandidateAbsent: fallback.candidateList?.[0]?.exists === false,
    noRootBenchmarkOrCandidateFallback: !(fallback.candidateList || []).some(item => /benchmark|legacy|candidate|marathon|adapter/i.test(`${item.id} ${item.relativePath}`))
  };

  const realAfter = protectedHashes();
  const gates = {
    candidateProvenance: Object.values(candidateProvenance).filter(value => typeof value === 'boolean').every(Boolean),
    isolatedPromotion: Object.values(promotionChecks).every(Boolean),
    coldStart: Object.values(coldStartChecks).every(Boolean),
    publicSurfaceParity: Object.values(surfaceChecks).every(Boolean),
    reloadRetention: Object.values(reloadChecks).every(Boolean),
    familyRegression: Object.values(regressionChecks).every(Boolean),
    rollback: Object.values(rollbackChecks).every(Boolean),
    interruptedPromotion: Object.values(interruptionChecks).every(Boolean),
    corruptedCandidateRejected: Object.values(corruptionChecks).every(Boolean),
    fallbackIsolation: Object.values(fallbackChecks).every(Boolean),
    realProductionUntouched: stable(realBefore) === stable(realAfter),
    immutableInputsUntouched: realAfter.parent === PARENT_HASH && realAfter.candidate === CANDIDATE_HASH
  };
  const passed = Object.values(gates).every(Boolean);
  const evidence = {
    schemaVersion: 1,
    kind: 'lari.cumulative-apprenticeship-cycle3.promotion-rehearsal',
    createdAt: new Date().toISOString(),
    rehearsalOnly: true,
    realPromotionPerformed: false,
    candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH, parentHash: PARENT_HASH, typedRecordId: TYPED_RECORD_ID, acquiredRecordIds: ACQUIRED_RECORD_IDS },
    incumbent: { path: rel(ACTIVE), sha256: realBefore.active, registryPath: rel(REGISTRY), registrySha256: realBefore.registry },
    isolatedNamespace: rel(ISOLATED),
    promotion: { path: rel(promotionRoot), result: promotion, checks: promotionChecks },
    coldStart: { result: coldStartView, checks: coldStartChecks },
    publicSurfaces: {
      cli: { ...cli, view: cli.view },
      openai_compatible_api: api,
      workbench,
      autonomous
    },
    publicSurfaceChecks: surfaceChecks,
    reload: { result: reload, checks: reloadChecks },
    regression: {
      existingRecap: recapRegression,
      existingChatCoding: chatCodingRegression,
      recapFamilies: familyRows,
      legacyTransferSample: legacyTransfer,
      checks: regressionChecks
    },
    rollback: { result: rollback, checks: rollbackChecks },
    interruption: { current: interruptedCurrent, registry: interruptedRegistry, checks: interruptionChecks },
    corruption: { result: corrupt, checks: corruptionChecks },
    fallback: { result: fallback, checks: fallbackChecks },
    realBefore,
    realAfter,
    gates,
    passed,
    verdict: passed
      ? 'Safe for real promotion'
      : 'Rehearsal failed',
    externalModelCalls: 0,
    limitations: [
      'The four-surface parity prompt exercises an inherited retained-knowledge route; the newly acquired coding records are separately checked for exact preservation and remain covered by the sealed Cycle 3 qualification.',
      'The host lacks an npm executable, and its bundled Node 24 --run carrier crashes before script startup; this rehearsal invokes the exact scripts/lari_ask.js implementation mapped by npm run lari:ask and does not claim wrapper-level execution.',
      'The registry manifest records lineage and activation metadata; the current loader resolves the clone current namespace directly, so manifest-driven path selection is not independently implemented or claimed.',
      'The 17-record transfer check is a legacy reusable-knowledge regression sample, not a newly sealed external benchmark.'
    ]
  };
  writeExclusive(path.join(OUT, 'promotion-rehearsal-evidence.json'), evidence);
  writeExclusive(path.join(OUT, 'PROMOTION_REHEARSAL_REPORT.md'), [
    '# Sealed cumulative apprenticeship Cycle 3 promotion rehearsal', '',
    `- Candidate: \`${CANDIDATE_HASH}\``,
    `- Production incumbent: \`${realBefore.active}\``,
    '- Real promotion performed: **no**',
    `- Public surface selection parity: **${surfaceChecks.sameCapabilitySelection ? 'PASS' : 'FAIL'}**`,
    `- RECAP regression: **${familyRows.passedCount}/${familyRows.total}**`,
    `- Legacy learned-knowledge transfer regression: **${legacyTransfer.passedCount}/${legacyTransfer.total}**`,
    `- External model calls: **0**`,
    `- Verdict: **${evidence.verdict}**`, '',
    '## Gates', '',
    ...Object.entries(gates).map(([name, value]) => `- ${name}: ${value ? 'PASS' : 'FAIL'}`), '',
    '## Surface evidence', '',
    markdownTable(Object.values(surfaces).map(row => ({
      surface: row.name,
      hash: (row.view || row).modelHash,
      capability: (row.view || row).capabilitySelection?.capabilityId || '—',
      record: (row.view || row).capabilitySelection?.learnedRecordId || '—',
      retained: (row.view || row).learnedRecordIds.includes(TYPED_RECORD_ID),
      readOnly: row.activeReadOnly && row.registryReadOnly
    })), [
      { label: 'Surface', value: row => row.surface },
      { label: 'Model hash', value: row => row.hash },
      { label: 'Capability', value: row => row.capability },
      { label: 'Selected record', value: row => row.record },
      { label: 'Knowledge record retained', value: row => row.retained ? 'yes' : 'no' },
      { label: 'Active/registry read-only', value: row => row.readOnly ? 'yes' : 'no' }
    ]), '',
    '## Honest boundary', '',
    ...evidence.limitations.map(item => `- ${item}`), ''
  ].join('\n'));
  writeExclusive(path.join(OUT, 'ROLLBACK_PROCEDURE.md'), [
    '# Rehearsed rollback procedure', '',
    `The isolated rehearsal restored incumbent SHA-256 \`${realBefore.active}\` exactly.`, '',
    '1. Verify the incumbent active bytes and the registry hash before activation.',
    `2. Require the registry backup pointer to hash to \`${realBefore.active}\`.`,
    `3. Activate candidate \`${CANDIDATE_HASH}\` using the existing atomic registry transaction only.`,
    '4. If any activation or surface gate fails, promote the verified backup with rollback metadata.',
    '5. Verify restored active bytes, registry rollback metadata, and absence of temporary activation files.',
    '6. Do not resolve a legacy root, benchmark, or candidate path as a fallback.', ''
  ].join('\n'));
  for (const artifact of [
    path.join(OUT, 'promotion-rehearsal-evidence.json'),
    path.join(OUT, 'PROMOTION_REHEARSAL_REPORT.md'),
    path.join(OUT, 'ROLLBACK_PROCEDURE.md')
  ]) fs.chmodSync(artifact, 0o444);
  process.stdout.write(`${JSON.stringify({
    candidate: CANDIDATE_HASH,
    incumbent: realBefore.active,
    gates,
    passed,
    verdict: evidence.verdict,
    output: rel(OUT)
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
