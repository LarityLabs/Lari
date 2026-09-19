const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const defaultRegistryRoot = path.join(root, 'models', 'lari');
const registryRoot = process.env.LARI_REGISTRY_ROOT
  ? path.resolve(root, process.env.LARI_REGISTRY_ROOT)
  : defaultRegistryRoot;
const currentDir = path.join(registryRoot, 'current');
const currentModelPath = path.join(currentDir, 'swarm-model.json');
const registryPath = path.join(registryRoot, 'registry.json');
const migrationFreezePath = path.join(root, 'consolidation', 'stage-1-freeze.json');

const fallbackCandidates = [
  {
    id: 'marathon-checkpoint',
    path: path.join(root, 'benchmarks', 'tmp-lari-research-learning-marathon', 'lari-research-learning-marathon-model.json'),
    rank: 100
  },
  {
    id: 'public-adapter-trained',
    path: path.join(root, 'benchmarks', 'tmp-lari-public-adapter', 'lm-eval-trained-model.json'),
    rank: 80
  }
];

const legacyRootCandidate = {
  id: 'legacy-root-swarm-model',
  path: path.join(root, 'swarm-model.json'),
  rank: 10,
  legacy: true
};

function defaultLariModel() {
  return {
    schemaVersion: 1,
    modelId: 'lari-local-model',
    modelName: 'Lari',
    modelDisplayName: 'Lari',
    generation: 1,
    skills: [],
    knowledge: [],
    compiledSkills: [],
    mutations: []
  };
}

function relativeToRoot(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeLariModel(model = {}) {
  return {
    ...defaultLariModel(),
    ...model,
    modelId: 'lari-local-model',
    modelName: 'Lari',
    modelDisplayName: 'Lari'
  };
}

function assertLariModelWritesAllowed(operation = 'write Lari model state') {
  if (!fs.existsSync(migrationFreezePath)) return true;
  const explicitRealPromotion = process.env.LARI_ALLOW_REAL_PROMOTION === '1'
    && registryRoot === defaultRegistryRoot
    && operation === 'promote a candidate';
  if (explicitRealPromotion) return true;
  const consolidationRoot = path.join(root, 'consolidation');
  const relativeRegistry = path.relative(consolidationRoot, registryRoot);
  const relativeToProduction = path.relative(defaultRegistryRoot, registryRoot);
  const outsideProductionNamespace = relativeToProduction !== ''
    && (relativeToProduction === '..' || relativeToProduction.startsWith(`..${path.sep}`))
    && !path.isAbsolute(relativeToProduction);
  const isolatedRehearsal = process.env.LARI_ALLOW_ISOLATED_REGISTRY_WRITES === '1'
    && relativeRegistry !== ''
    && relativeRegistry !== '..'
    && !relativeRegistry.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeRegistry)
    && outsideProductionNamespace;
  if (isolatedRehearsal) return true;
  const error = new Error(`Lari model writes are frozen during consolidation Stage 1; refused to ${operation}.`);
  error.code = 'LARI_MODEL_WRITES_FROZEN';
  error.freezePath = migrationFreezePath;
  throw error;
}

function validateLariModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new TypeError('Lari model must be a JSON object.');
  if (model.schemaVersion !== undefined && (!Number.isInteger(model.schemaVersion) || model.schemaVersion < 1)) {
    throw new TypeError('Lari model schemaVersion must be a positive integer.');
  }
  for (const key of ['skills', 'compiledSkills', 'mutations']) {
    if (model[key] !== undefined && !Array.isArray(model[key])) throw new TypeError(`Lari model ${key} must be an array.`);
  }
  return model;
}

function countStoredBenchmarkAnswerMarkers(model) {
  const text = typeof model === 'string' ? model : JSON.stringify(model);
  return (text.match(/"minedFrom"\s*:/g) || []).length;
}

function assertNoStoredBenchmarkAnswers(model, sourcePath = 'candidate') {
  const count = countStoredBenchmarkAnswerMarkers(model);
  if (count > 0) {
    const error = new Error(`Refused contaminated Lari model ${sourcePath}: ${count} stored benchmark-answer back-reference(s).`);
    error.code = 'LARI_CANDIDATE_CONTAMINATED';
    error.sourcePath = sourcePath;
    error.storedBenchmarkAnswerCount = count;
    throw error;
  }
  return true;
}

/**
 * Benchmark call-site metadata is evidence about a component, not an executable learned capability.
 * The retired runtime-skill importer created skills from function names and benchmark pass rates but
 * supplied no verified execution contract. Such a record can win routing while having no sound way to
 * execute the selected behavior, so it must never enter the active model namespace.
 */
function findUnboundBenchmarkRuntimeSkills(model = {}) {
  return (model.compiledSkills || []).filter(skill =>
    /^skill\.runtime\./.test(String(skill?.id || ''))
    && /^runtimeCapability\./.test(String(skill?.sourceKnowledgeId || ''))
    && Array.isArray(skill?.evidence?.invokingBenchmarks)
    && !skill?.lariExecution
  );
}

function assertNoUnboundBenchmarkRuntimeSkills(model, sourcePath = 'candidate') {
  const skills = findUnboundBenchmarkRuntimeSkills(model);
  if (skills.length) {
    const error = new Error(`Refused Lari model ${sourcePath}: ${skills.length} benchmark-derived runtime skill(s) have no verified execution contract.`);
    error.code = 'LARI_CANDIDATE_UNBOUND_BENCHMARK_CAPABILITIES';
    error.sourcePath = sourcePath;
    error.skillIds = skills.map(skill => skill.id);
    throw error;
  }
  return true;
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    const failureTarget = process.env.LARI_ATOMIC_WRITE_FAIL_BEFORE_RENAME || '';
    if (failureTarget && (failureTarget === path.basename(filePath) || failureTarget === relativeToRoot(filePath))) {
      delete process.env.LARI_ATOMIC_WRITE_FAIL_BEFORE_RENAME;
      const injected = new Error(`Injected interruption before atomic activation of ${relativeToRoot(filePath)}.`);
      injected.code = 'LARI_ATOMIC_WRITE_INTERRUPTED';
      throw injected;
    }
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  return filePath;
}

function listLariModelCandidates() {
  const includeLegacyRoot = process.env.LARI_ALLOW_LEGACY_ROOT_MODEL === '1';
  const disableFallbacks = process.env.LARI_DISABLE_MODEL_FALLBACKS !== '0';
  const candidates = [
    { id: 'canonical-current', path: currentModelPath, rank: 1000 },
    ...(!disableFallbacks ? fallbackCandidates : []),
    ...(includeLegacyRoot ? [legacyRootCandidate] : [])
  ].map(candidate => ({
    ...candidate,
    exists: fs.existsSync(candidate.path),
    relativePath: relativeToRoot(candidate.path)
  }));
  return candidates.sort((a, b) => b.rank - a.rank);
}

function resolveLariModelPath(options = {}) {
  const explicit = options.modelPath || process.env.LARI_MODEL_PATH;
  if (explicit) {
    const resolved = path.resolve(root, explicit);
    return {
      id: 'explicit',
      path: resolved,
      relativePath: relativeToRoot(resolved),
      exists: fs.existsSync(resolved),
      source: 'explicit'
    };
  }
  const found = listLariModelCandidates().find(candidate => candidate.exists);
  if (found) return { ...found, source: found.id === 'canonical-current' ? 'registry' : 'fallback' };
  return {
    id: 'default-empty-model',
    path: null,
    relativePath: null,
    exists: false,
    source: 'default'
  };
}

function loadLariModel(options = {}) {
  const resolved = resolveLariModelPath(options);
  const model = resolved.path && resolved.exists
    ? normalizeLariModel(validateLariModel(readJsonIfExists(resolved.path)))
    : defaultLariModel();
  if (resolved.path && resolved.exists) {
    assertNoStoredBenchmarkAnswers(model, resolved.relativePath || relativeToRoot(resolved.path));
    assertNoUnboundBenchmarkRuntimeSkills(model, resolved.relativePath || relativeToRoot(resolved.path));
    // Remember where this model was loaded from so live-learning checkpoints
    // write back to the same file. Non-enumerable: never serialized.
    Object.defineProperty(model, '__lariSourcePath', {
      value: resolved.path,
      writable: true,
      enumerable: false,
      configurable: true
    });
  }
  return { model, resolved };
}

function writeLariModel(filePath, model) {
  assertLariModelWritesAllowed(`write ${relativeToRoot(path.resolve(root, filePath))}`);
  const resolved = path.resolve(root, filePath);
  atomicWriteJson(resolved, normalizeLariModel(validateLariModel(model)));
  return resolved;
}

// Checkpoint the live in-memory model back to the file it was loaded from.
// This is what makes research durable: without it, records learned during a
// chat turn evaporate when the process exits and the next turn re-researches
// the same question. Backs up the previous file first (existing timestamped
// backup convention). Refuses when the model was never loaded from disk or
// when model writes are frozen.
function checkpointLariModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new TypeError('checkpointLariModel requires a Lari model object.');
  }
  const sourcePath = model.__lariSourcePath || null;
  if (!sourcePath) {
    const error = new Error('Refused Lari model checkpoint: model was not loaded from a file (no __lariSourcePath).');
    error.code = 'LARI_CHECKPOINT_NO_SOURCE';
    throw error;
  }
  assertLariModelWritesAllowed(`checkpoint live model to ${relativeToRoot(sourcePath)}`);
  validateLariModel(model);
  if (fs.existsSync(sourcePath)) {
    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, '.json');
    const backupPath = path.join(dir, `${base}.backup-${Date.now()}.json`);
    fs.copyFileSync(sourcePath, backupPath);
    // Keep only the newest few backups: each is a full model copy and an
    // unbounded pile will fill small disks (seen on a 512MB /tmp tmpfs).
    try {
      const keep = Math.max(1, parseInt(process.env.LARI_CHECKPOINT_BACKUPS || '5', 10) || 5);
      const olds = fs.readdirSync(dir)
        .filter(f => f.startsWith(base + '.backup-') && f.endsWith('.json'))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const o of olds.slice(keep)) {
        try { fs.unlinkSync(path.join(dir, o.f)); } catch (_) {}
      }
    } catch (_) {}
  }
  atomicWriteJson(sourcePath, normalizeLariModel(model));
  return sourcePath;
}

function promoteLariModel(sourcePath, metadata = {}) {
  assertLariModelWritesAllowed('promote a candidate');
  const source = path.resolve(root, sourcePath);
  if (!fs.existsSync(source)) throw new Error(`Cannot promote missing Lari model: ${source}`);
  const model = normalizeLariModel(validateLariModel(readJsonIfExists(source)));
  assertNoStoredBenchmarkAnswers(model, relativeToRoot(source));
  assertNoUnboundBenchmarkRuntimeSkills(model, relativeToRoot(source));
  const sourceHash = sha256File(source);
  if (metadata.candidateHash && metadata.candidateHash !== sourceHash) {
    const error = new Error(`Refused Lari promotion: declared candidate hash ${metadata.candidateHash} does not match ${sourceHash}.`);
    error.code = 'LARI_CANDIDATE_HASH_MISMATCH';
    throw error;
  }
  const promotionMetadata = {
    ...metadata,
    candidateHash: sourceHash,
    contaminationChecked: true,
    storedBenchmarkAnswerCount: 0,
    benchmarkCapabilityIntegrityChecked: true,
    unboundBenchmarkRuntimeSkillCount: 0
  };
  fs.mkdirSync(currentDir, { recursive: true });
  const existingRegistry = readLariModelRegistry();
  const promotedAt = new Date().toISOString();
  const previous = fs.existsSync(currentModelPath)
    ? path.join(currentDir, `swarm-model.backup-${Date.now()}.json`)
    : null;
  if (previous) fs.copyFileSync(currentModelPath, previous);
  const registry = {
    schemaVersion: 1,
    activeModelPath: relativeToRoot(currentModelPath),
    promotedFrom: relativeToRoot(source),
    previousModelPath: previous ? relativeToRoot(previous) : null,
    promotedAt,
    activeModelSha256: sourceHash,
    metadata: promotionMetadata,
    history: [
      {
        activeModelPath: relativeToRoot(currentModelPath),
        promotedFrom: relativeToRoot(source),
        previousModelPath: previous ? relativeToRoot(previous) : null,
        promotedAt,
        activeModelSha256: sourceHash,
        metadata: promotionMetadata
      },
      ...(existingRegistry?.history || []).slice(0, 49)
    ],
    candidates: listLariModelCandidates(),
    external_model_calls: 0
  };
  try {
    atomicWriteJson(currentModelPath, model);
    atomicWriteJson(registryPath, registry);
  } catch (error) {
    if (previous && fs.existsSync(previous)) {
      atomicWriteJson(currentModelPath, normalizeLariModel(validateLariModel(readJsonIfExists(previous))));
    }
    if (existingRegistry) atomicWriteJson(registryPath, existingRegistry);
    throw error;
  }
  return registry;
}

function readLariModelRegistry() {
  return readJsonIfExists(registryPath);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveHistoryPath(relativePath) {
  if (!relativePath) return null;
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}

function historyLabel(entry = {}, fallback = 'Lari version') {
  const metadata = entry.metadata || {};
  if (metadata.query) return `Learned — ${String(metadata.query).slice(0, 80)}`;
  const stage = metadata.reason ?? metadata.transaction ?? metadata.stage;
  return String(stage || fallback).replace(/[-_]+/g, ' ');
}

function publicHistoryMetadata(metadata = {}) {
  return Object.fromEntries(['stage', 'transaction', 'reason', 'query', 'recordId', 'rollback']
    .filter(key => metadata[key] !== undefined)
    .map(key => [key, metadata[key]]));
}

function listLariModelHistory() {
  const registry = readLariModelRegistry() || { history: [] };
  const currentHash = fs.existsSync(currentModelPath) ? sha256File(currentModelPath) : null;
  const states = [];
  const seen = new Set();
  const add = item => {
    const resolved = resolveHistoryPath(item.path);
    const exists = Boolean(resolved && fs.existsSync(resolved));
    const declaredHash = String(item.sha256 || '').toLowerCase();
    const actualHash = exists ? sha256File(resolved) : null;
    const hash = actualHash || declaredHash;
    if (!/^[a-f0-9]{64}$/.test(hash) || seen.has(hash)) return;
    const storedBenchmarkAnswerCount = exists
      ? countStoredBenchmarkAnswerMarkers(fs.readFileSync(resolved, 'utf8'))
      : null;
    states.push({
      sha256: hash,
      declaredSha256: /^[a-f0-9]{64}$/.test(declaredHash) ? declaredHash : null,
      hashBindingMatches: !exists || !/^[a-f0-9]{64}$/.test(declaredHash) || declaredHash === actualHash,
      label: item.label || 'Lari version',
      activatedAt: item.activatedAt || null,
      current: hash === currentHash,
      rollbackAvailable: exists && storedBenchmarkAnswerCount === 0,
      storedBenchmarkAnswerCount,
      sourcePath: item.path || null,
      size: exists ? fs.statSync(resolved).size : null,
      metadata: publicHistoryMetadata(item.metadata || {})
    });
    seen.add(hash);
  };
  if (currentHash) add({
    sha256: currentHash,
    path: relativeToRoot(currentModelPath),
    label: `Current — ${historyLabel(registry.history?.[0] || registry, 'active Lari')}`,
    activatedAt: registry.promotedAt || registry.history?.[0]?.promotedAt || null,
    metadata: registry.metadata || registry.history?.[0]?.metadata || {}
  });
  (registry.history || []).forEach((entry, index, history) => {
    const metadata = entry.metadata || {};
    const candidateHash = metadata.candidateHash || null;
    add({
      sha256: candidateHash,
      path: entry.promotedFrom,
      label: historyLabel(entry, `Version ${index + 1}`),
      activatedAt: entry.promotedAt,
      metadata
    });
    const next = history[index + 1];
    const previousHash = metadata.lineageParentHash
      || metadata.parentHash
      || metadata.rollbackTargetHash
      || next?.metadata?.candidateHash
      || null;
    add({
      sha256: previousHash,
      path: entry.previousModelPath,
      label: next ? historyLabel(next, `Version ${index + 2}`) : `Before ${historyLabel(entry)}`,
      activatedAt: next?.promotedAt || null,
      metadata: next?.metadata || { restoredFrom: entry.previousModelPath }
    });
  });
  return {
    schemaVersion: 1,
    activeHash: currentHash,
    generatedAt: new Date().toISOString(),
    history: states,
    external_model_calls: 0
  };
}

function rollbackLariModel(targetHash, metadata = {}) {
  const normalizedHash = String(targetHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) throw new Error('Rollback target must be a complete SHA-256 hash.');
  const timeline = listLariModelHistory();
  if (timeline.activeHash === normalizedHash) {
    return { changed: false, activeHash: timeline.activeHash, targetHash: normalizedHash, registry: readLariModelRegistry() };
  }
  const target = timeline.history.find(item => item.sha256 === normalizedHash && item.rollbackAvailable);
  if (!target) throw new Error('Rollback target is not an available verified Lari history point.');
  const targetPath = resolveHistoryPath(target.sourcePath);
  if (!targetPath || sha256File(targetPath) !== normalizedHash) throw new Error('Rollback target hash verification failed.');
  const beforeHash = timeline.activeHash;
  const promoted = promoteLariModel(targetPath, {
    ...metadata,
    stage: 'user-history-rollback',
    transaction: 'atomic-user-requested-rollback',
    rollback: true,
    rollbackTargetHash: normalizedHash,
    rollbackFromHash: beforeHash,
    rollbackLabel: target.label,
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    externalModelCalls: 0
  });
  const afterHash = sha256File(currentModelPath);
  if (afterHash !== normalizedHash) throw new Error('Rollback activation did not produce the selected hash.');
  return {
    changed: true,
    beforeHash,
    activeHash: afterHash,
    targetHash: normalizedHash,
    label: target.label,
    automaticUndoTargetHash: beforeHash,
    promotedAt: promoted.promotedAt,
    previousModelPath: promoted.previousModelPath,
    external_model_calls: 0
  };
}

module.exports = {
  root,
  defaultRegistryRoot,
  registryRoot,
  currentModelPath,
  registryPath,
  migrationFreezePath,
  defaultLariModel,
  listLariModelCandidates,
  resolveLariModelPath,
  loadLariModel,
  writeLariModel,
  promoteLariModel,
  listLariModelHistory,
  rollbackLariModel,
  readLariModelRegistry,
  normalizeLariModel,
  validateLariModel,
  countStoredBenchmarkAnswerMarkers,
  assertNoStoredBenchmarkAnswers,
  findUnboundBenchmarkRuntimeSkills,
  assertNoUnboundBenchmarkRuntimeSkills,
  assertLariModelWritesAllowed,
  atomicWriteJson,
  checkpointLariModel
};
