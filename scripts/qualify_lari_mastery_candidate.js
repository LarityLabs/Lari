#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE_PATH = path.resolve(ROOT, process.argv[2] || '');
const EXPECTED_HASH = process.argv[3] || '';
const BASE_PATH = path.resolve(ROOT, process.argv[4] || '');
const OUTPUT_ROOT = path.resolve(ROOT, process.argv[5] || 'consolidation/mastery-qualification-20260828');
const CANDIDATE_EVIDENCE_PATH = process.argv[6] ? path.resolve(ROOT, process.argv[6]) : null;
const REHEARSAL_ROOT = path.join(ROOT, 'consolidation', 'stage-3-rehearsal', path.basename(OUTPUT_ROOT));
const REAL_REGISTRY_ROOT = path.join(ROOT, 'models', 'lari');
const ACTIVE_PATH = path.join(REAL_REGISTRY_ROOT, 'current', 'swarm-model.json');
const REGISTRY_PATH = path.join(REAL_REGISTRY_ROOT, 'registry.json');

const DEFAULT_PROMPTS = [
  ['supportive_acknowledgement', 'Today was brutal, though I finally got the tests passing.', 'lari.learned.procedure.chat.5ac8499a'],
  ['decision_support', 'Help me decide whether to rebuild the service or improve it incrementally.', 'lari.learned.procedure.chat.cd0cdb09'],
  ['polite_rewrite', 'Rewrite this more professionally: This library is terrible and the guide is useless.', 'lari.learned.procedure.chat.31e07390'],
  ['systematic_troubleshooting', 'Debug a Python worker that will not exit cleanly.', 'lari.learned.procedure.chat.2f21b786'],
  ['name_brainstorm', 'Give me 3 names for a private offline code helper.', 'lari.learned.procedure.chat.1b6daa09']
].map(([id, prompt, expectedRecordId]) => ({ id, prompt, expectedRecordId }));

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function writeExclusive(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function cloneRegistry(name) {
  const target = path.join(REHEARSAL_ROOT, name, 'registry');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(REAL_REGISTRY_ROOT, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  return target;
}

function registryEnv(registryRoot, stateName = 'surface') {
  return {
    ...process.env,
    LARI_REGISTRY_ROOT: relative(registryRoot),
    LARI_ALLOW_ISOLATED_REGISTRY_WRITES: '1',
    LARI_DISABLE_MODEL_FALLBACKS: '1',
    LARI_ALLOW_LEGACY_ROOT_MODEL: '0',
    LARI_REHEARSAL_CANDIDATE_PROVENANCE: relative(CANDIDATE_PATH),
    LARI_RUNTIME_STATE_PATH: path.join(OUTPUT_ROOT, 'runtime', `${stateName}.json`)
  };
}

function worker(operation, registryRoot, argument = CANDIDATE_PATH) {
  const run = spawnSync(process.execPath, ['scripts/lari_stage3_registry_worker.js', operation, String(argument)], {
    cwd: ROOT,
    env: registryEnv(registryRoot, `worker-${operation}`),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true
  });
  let parsed;
  try { parsed = JSON.parse(run.stdout.trim()); } catch { throw new Error(run.stderr || run.stdout || `Invalid worker output for ${operation}`); }
  if (run.status !== 0 || parsed.fatal) throw new Error(parsed.fatal?.message || run.stderr || run.stdout);
  return parsed;
}

function selectionView(value = {}) {
  const body = value.response && typeof value.response === 'object' ? value.response : value;
  const selection = body.capabilitySelection || body.capability_selection || body.selection || value.lari?.capability_selection || null;
  return {
    modelHash: body.modelHash || body.model_hash || value.model_hash || value.lari?.model_hash || selection?.modelHash || null,
    capabilityId: selection?.capabilityId || null,
    sourceSkillId: selection?.sourceSkillId || null,
    learnedRecordId: selection?.learnedRecordId || null,
    learnedRecordIds: body.learnedRecordIds || body.learned_record_ids || value.lari?.learned_record_ids || [],
    externalModelCalls: body.external_model_calls || value.external_model_calls || value.lari?.external_model_calls || 0
  };
}

function cliSurface(registryRoot, prompt) {
  const run = spawnSync(process.execPath, ['scripts/lari_ask.js', '--debug', prompt], {
    cwd: ROOT,
    env: registryEnv(registryRoot, 'cli'),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true
  });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout);
  const marker = run.stdout.lastIndexOf('\n---\n');
  if (marker < 0) throw new Error('CLI debug metadata was not emitted.');
  return selectionView(JSON.parse(run.stdout.slice(marker + 5)));
}

async function waitFor(url, child, label) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (child.exitCode !== null) throw new Error(`${label} exited before startup.`);
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${label} startup timed out.`);
}

async function apiSurface(url, prompt) {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'lari', messages: [{ role: 'user', content: prompt }], include_diagnostics: true, lari_context: {} })
  });
  if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
  return selectionView(await response.json());
}

async function workbenchSurface(url, prompt) {
  const response = await fetch(`${url}/api/lari/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, includeDiagnostics: true, userScope: 'mastery.qualification' })
  });
  if (!response.ok) throw new Error(`Workbench returned ${response.status}: ${await response.text()}`);
  return selectionView(await response.json());
}

function canonicalContext(modelHash) {
  return {
    modelHash,
    autoGrow: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 }
    }
  };
}

function familyRegression(base, candidate, baseHash) {
  const cases = {
    chat: 'Explain in plain language how local state can survive a restart.',
    instruction: 'Give exactly two short bullets about safe backups.',
    math: 'What is 18 plus 27?',
    multiple_choice: 'Which best protects saved data? A) Delete it B) Atomic backup C) Ignore errors D) Rename it',
    coding: 'Describe the safest diagnostic sequence after a code change breaks a test.',
    research: 'Describe source-grounded learning without invented facts.',
    product: 'Describe a minimal local product plan with verification and rollback.',
    safety: 'Why should destructive changes require verification?'
  };
  const score = (model, hash, prompt) => {
    const response = runtime.sendMessageToLari(clone(model), prompt, canonicalContext(hash));
    return Number(response.passed !== false) + Number(response.passed === true) + Math.min(1, String(response.answer || '').length / 80);
  };
  const rows = Object.entries(cases).map(([family, prompt]) => {
    const before = score(base, baseHash, prompt);
    const after = score(candidate, EXPECTED_HASH, prompt);
    return { family, prompt, before, after, regressed: after + 0.0001 < before };
  });
  return { rows, regressionCount: rows.filter(row => row.regressed).length, passed: rows.every(row => !row.regressed) };
}

function hiddenTransfer(model) {
  const records = (model.lariLearnedRecords?.records || [])
    .filter(record => record.provenance?.imported && record.type === 'knowledge'
      && !(record.provenance?.benchmarkAssociation || []).length
      && (record.normalizedTriggers || []).length >= 2)
    .slice(0, 17);
  const rows = records.map(record => {
    const prompt = `In a new situation, what reusable guidance applies when ${(record.normalizedTriggers || []).slice(0, 4).reverse().join(', ')} matter?`;
    const matches = runtime.searchKnowledge(clone(model), prompt, { limit: 5, minScore: 0 }) || [];
    const routed = matches.some(match => (match.item?.id || match.id) === record.provenance.originalRecordId);
    const response = runtime.sendMessageToLari(clone(model), prompt, canonicalContext(EXPECTED_HASH));
    return { recordId: record.id, routed, answered: String(response.answer || '').length > 0, passed: routed && String(response.answer || '').length > 0 };
  });
  return { rows, passedCount: rows.filter(row => row.passed).length, total: rows.length, passed: rows.length === 17 && rows.every(row => row.passed) };
}

async function main() {
  if (!EXPECTED_HASH || !fs.existsSync(CANDIDATE_PATH) || !fs.existsSync(BASE_PATH)) throw new Error('Usage: qualify_lari_mastery_candidate.js <candidate> <sha256> <base> [output-root]');
  if (fs.existsSync(OUTPUT_ROOT)) throw new Error(`Refusing to overwrite qualification namespace: ${relative(OUTPUT_ROOT)}`);
  if (fs.existsSync(REHEARSAL_ROOT)) throw new Error(`Refusing to overwrite rehearsal namespace: ${relative(REHEARSAL_ROOT)}`);
  if (sha256(CANDIDATE_PATH) !== EXPECTED_HASH) throw new Error('Candidate hash mismatch.');
  const realBefore = { active: sha256(ACTIVE_PATH), registry: sha256(REGISTRY_PATH), candidate: sha256(CANDIDATE_PATH), base: sha256(BASE_PATH) };
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE_PATH, 'utf8'));
  const base = JSON.parse(fs.readFileSync(BASE_PATH, 'utf8'));
  const candidateEvidence = CANDIDATE_EVIDENCE_PATH && fs.existsSync(CANDIDATE_EVIDENCE_PATH)
    ? JSON.parse(fs.readFileSync(CANDIDATE_EVIDENCE_PATH, 'utf8'))
    : null;
  const prompts = candidateEvidence?.chat?.validation?.length
    ? candidateEvidence.chat.validation.map(item => ({ id: `${item.id}.${item.variantIndex}`, prompt: item.prompt, expectedRecordId: item.recordId }))
    : DEFAULT_PROMPTS;
  const expectedDeltaIds = candidateEvidence?.candidate?.learnedRecordIds
    || candidateEvidence?.learnedRecordIds
    || DEFAULT_PROMPTS.map(item => item.expectedRecordId);
  const typedDeltaIds = (candidate.lariLearnedRecords?.records || [])
    .filter(record => !(base.lariLearnedRecords?.records || []).some(parent => parent.id === record.id))
    .map(record => record.id);

  const promotionRoot = cloneRegistry('promotion');
  const promotion = worker('promote', promotionRoot);
  const promotedPath = path.join(promotionRoot, 'current', 'swarm-model.json');
  const promotedRegistryPath = path.join(promotionRoot, 'registry.json');
  const beforeSurface = { model: sha256(promotedPath), registry: sha256(promotedRegistryPath) };
  const apiPort = Number(process.env.LARI_MASTERY_API_PORT || 8898);
  const workbenchPort = Number(process.env.LARI_MASTERY_WORKBENCH_PORT || 8897);
  const env = { ...registryEnv(promotionRoot, 'servers'), LARI_WORKSPACE_PORT: String(workbenchPort), LARI_NO_BROWSER: '1' };
  const api = spawn('python', ['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', String(apiPort)], { cwd: ROOT, env: { ...env, LARI_RUNTIME_STATE_PATH: path.join(OUTPUT_ROOT, 'runtime', 'api.json') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const workbench = spawn('python', ['start_workspace.py'], { cwd: ROOT, env: { ...env, LARI_RUNTIME_STATE_PATH: path.join(OUTPUT_ROOT, 'runtime', 'workbench.json') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let apiError = '', workbenchError = '';
  api.stderr.on('data', chunk => { apiError += chunk.toString(); });
  workbench.stderr.on('data', chunk => { workbenchError += chunk.toString(); });
  let parity;
  try {
    await Promise.all([waitFor(`http://127.0.0.1:${apiPort}/health`, api, 'API'), waitFor(`http://127.0.0.1:${workbenchPort}/index.html`, workbench, 'Workbench')]);
    parity = [];
    for (const item of prompts) {
      const canonical = selectionView(worker('inference', promotionRoot, item.prompt));
      const cli = cliSurface(promotionRoot, item.prompt);
      const autonomous = selectionView(worker('autonomous', promotionRoot, item.prompt));
      const openaiApi = await apiSurface(`http://127.0.0.1:${apiPort}`, item.prompt);
      const workbenchApi = await workbenchSurface(`http://127.0.0.1:${workbenchPort}`, item.prompt);
      const views = { canonical, cli, autonomous, openaiApi, workbenchApi };
      const signatures = Object.values(views).map(value => JSON.stringify(value));
      parity.push({ ...item, views, sameSelection: signatures.every(value => value === signatures[0]), expectedSelected: Object.values(views).every(value => value.learnedRecordIds.includes(item.expectedRecordId)), externalModelCallsZero: Object.values(views).every(value => Number(value.externalModelCalls || 0) === 0) });
    }
  } finally {
    api.kill(); workbench.kill();
    if (api.exitCode === null) await new Promise(resolve => setTimeout(resolve, 300));
    if (workbench.exitCode === null) await new Promise(resolve => setTimeout(resolve, 300));
  }

  const afterSurface = { model: sha256(promotedPath), registry: sha256(promotedRegistryPath) };
  const reloadRows = prompts.map(item => {
    const value = selectionView(worker('inference', promotionRoot, item.prompt));
    return { id: item.id, expectedRecordId: item.expectedRecordId, selected: value.learnedRecordIds.includes(item.expectedRecordId), modelHash: value.modelHash, passed: value.learnedRecordIds.includes(item.expectedRecordId) && value.modelHash === EXPECTED_HASH };
  });
  const hidden = hiddenTransfer(candidate);
  const regressions = familyRegression(base, candidate, realBefore.base);
  const rollbackRoot = cloneRegistry('rollback');
  const rollback = worker('rollback', rollbackRoot);
  const realAfter = { active: sha256(ACTIVE_PATH), registry: sha256(REGISTRY_PATH), candidate: sha256(CANDIDATE_PATH), base: sha256(BASE_PATH) };
  const gates = {
    exactCandidateHash: promotion.after.currentHash === EXPECTED_HASH,
    canonicalTypedDeltaExpected: typedDeltaIds.length === expectedDeltaIds.length && expectedDeltaIds.every(id => typedDeltaIds.includes(id)),
    fiveSurfaceParityAll: parity.length === prompts.length && parity.every(item => item.sameSelection && item.expectedSelected),
    externalModelCallsZero: parity.every(item => item.externalModelCallsZero),
    hiddenTransfer17Of17: hidden.passed,
    zeroFamilyRegressions: regressions.passed,
    reloadRetentionAll: reloadRows.length === prompts.length && reloadRows.every(item => item.passed),
    noHiddenModelWrites: JSON.stringify(beforeSurface) === JSON.stringify(afterSurface),
    rollbackRestoresExactIncumbent: rollback.promoted.metadata?.candidateSha256 === EXPECTED_HASH && rollback.after.currentHash === realBefore.active,
    realStateReadOnly: JSON.stringify(realBefore) === JSON.stringify(realAfter),
    noSilentFallback: promotion.after.registry?.candidates?.every(item => item.id === 'canonical-current') === true
  };
  const passed = Object.values(gates).every(Boolean);
  const evidence = {
    schemaVersion: 1,
    kind: 'lari.mastery-candidate-qualification',
    createdAt: new Date().toISOString(),
    candidate: { path: relative(CANDIDATE_PATH), sha256: EXPECTED_HASH, parentPath: relative(BASE_PATH), parentHash: realBefore.base, promoted: false },
    isolatedPromotion: { namespace: relative(promotionRoot), result: promotion },
    parity,
    hiddenTransfer: hidden,
    familyRegression: regressions,
    reload: reloadRows,
    rollback: { namespace: relative(rollbackRoot), result: rollback },
    beforeSurface,
    afterSurface,
    realBefore,
    realAfter,
    typedDeltaIds,
    serverDiagnostics: { apiError: apiError.trim(), workbenchError: workbenchError.trim() },
    gates,
    passed,
    verdict: passed ? 'Qualified for expansion base; remains unpromoted' : 'Qualification failed'
  };
  writeExclusive(path.join(OUTPUT_ROOT, 'qualification-evidence.json'), evidence);
  writeExclusive(path.join(OUTPUT_ROOT, 'QUALIFICATION_REPORT.md'), `# Lari mastery candidate qualification\n\nCandidate: \`${EXPECTED_HASH}\`\n\n- Five-surface learned-record parity: **${parity.filter(item => item.sameSelection && item.expectedSelected).length}/${prompts.length}**\n- Hidden transfer: **${hidden.passedCount}/${hidden.total}**\n- Family regressions: **${regressions.regressionCount}**\n- Reload retention: **${reloadRows.filter(item => item.passed).length}/${prompts.length}**\n- Exact rollback: **${gates.rollbackRestoresExactIncumbent ? 'passed' : 'failed'}**\n- Real production mutation: **${gates.realStateReadOnly ? 'none' : 'detected'}**\n\nVerdict: **${evidence.verdict}**\n`);
  process.stdout.write(`${JSON.stringify({ passed, candidateHash: EXPECTED_HASH, gates, hiddenTransfer: `${hidden.passedCount}/${hidden.total}`, familyRegressions: regressions.regressionCount, parity: `${parity.filter(item => item.sameSelection && item.expectedSelected).length}/${prompts.length}`, verdict: evidence.verdict }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
