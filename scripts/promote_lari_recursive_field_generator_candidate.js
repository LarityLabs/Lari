#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

delete process.env.LARI_REGISTRY_ROOT;
delete process.env.LARI_MODEL_PATH;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
process.env.LARI_ALLOW_LEGACY_ROOT_MODEL = '0';

const registry = require('./lari_model_registry.js');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const HASH = 'cab74f590d5ad4533202b1ee2c08b32e28ec47e3c8134ddd24a2bc5bdd7a0fed';
const INCUMBENT = '60d731eb2d04e3411e81c129118b34e372d63311ce39a18c2d47e0e9fd73ac79';
const REGISTRY_HASH = '81c402616e301fdb170478ddc5de4a9ff424d335c4b31cba53eb7ca9af23daae';
const RECORD_ID = 'lari.learned.generator.neurogenesis.4b44de8b5bd9a4a341de';
const SOURCE = path.join(ROOT, 'consolidation', 'recursive-field-generator-20260831');
const CANDIDATE = path.join(SOURCE, 'candidates', `${HASH}.json`);
const QUALIFICATION = path.join(SOURCE, 'qualification-report.json');
const REHEARSAL = path.join(ROOT, 'consolidation', 'recursive-field-generator-promotion-rehearsal-attempt2-20260831', 'rehearsal-manifest.json');
const DIRECT_SURFACES = path.join(ROOT, 'consolidation', 'recursive-field-generator-surface-parity-attempt2-20260831', 'surface-parity.json');
const REHEARSED_SURFACES = path.join(ROOT, 'consolidation', 'recursive-field-generator-rehearsed-surfaces-20260831', 'surface-parity.json');
const OUT = path.join(ROOT, 'consolidation', 'recursive-field-generator-production-promotion-20260831');
const PRODUCTION_SURFACE_OUT = path.join(ROOT, 'consolidation', 'recursive-field-generator-production-surfaces-20260831');
const PRODUCTION_SURFACES = path.join(PRODUCTION_SURFACE_OUT, 'surface-parity.json');
const PREFLIGHT = path.join(OUT, 'preflight-manifest.json');
const MANIFEST = path.join(OUT, 'production-promotion-manifest.json');
const FAILURE = path.join(OUT, 'production-promotion-failure.json');
const ACTIVE_BACKUP = path.join(OUT, 'backups', `sha256-${INCUMBENT}.json`);
const REGISTRY_BACKUP = path.join(OUT, 'backups', `registry-sha256-${REGISTRY_HASH}.json`);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function preserve(source, target, expected) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fs.readFileSync(source), { flag: 'wx' });
  assert(sha(target) === expected, `Backup mismatch ${rel(target)}`);
  return { path: rel(target), sha256: expected, bytes: fs.statSync(target).size };
}

function state() {
  return { active: sha(registry.currentModelPath), registry: sha(registry.registryPath) };
}

function temporaryFiles(directory) {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter(name => name.endsWith('.tmp') || /^\..+\.tmp$/.test(name))
    : [];
}

function rollback(error) {
  let result = null;
  if (fs.existsSync(ACTIVE_BACKUP) && fs.existsSync(registry.currentModelPath) && sha(registry.currentModelPath) === HASH) {
    const rolled = registry.promoteLariModel(ACTIVE_BACKUP, {
      transaction: 'automatic-rollback-recursive-field-generator',
      rollback: true,
      rollbackTargetHash: INCUMBENT,
      rolledBackFromHash: HASH,
      externalModelCalls: 0
    });
    result = {
      activeHash: sha(registry.currentModelPath),
      exact: sha(registry.currentModelPath) === INCUMBENT,
      promotedAt: rolled.promotedAt
    };
  }
  if (!fs.existsSync(FAILURE)) write(FAILURE, {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    error: { message: error.message, stack: error.stack },
    rollback: result
  });
  return result;
}

function probe(model, prompt, expectedFamilies) {
  const response = runtime.sendMessageToLari(clone(model), prompt, {
    modelHash: HASH,
    autoGrow: false,
    userScope: 'recursive-production-smoke',
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 }
    }
  });
  return {
    prompt,
    answer: response.answer,
    modelHash: response.modelHash,
    learnedRecordIds: response.learnedRecordIds || [],
    family: response.recapTrace?.meaningGraph?.family || null,
    componentFamilies: response.recapTrace?.meaningGraph?.components?.map(item => item.family) || [],
    source: response.publicAnswerSource,
    passed: response.passed === true
      && response.modelHash === HASH
      && response.publicAnswerSource === 'recap_executable_language'
      && response.recapTrace?.meaningGraph?.family === 'recursive_composition'
      && JSON.stringify(response.recapTrace?.meaningGraph?.components?.map(item => item.family) || []) === JSON.stringify(expectedFamilies)
      && (response.learnedRecordIds || []).includes(RECORD_ID)
      && Number(response.external_model_calls || 0) === 0
  };
}

function main() {
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Real production registry was not selected.');
  assert(!fs.existsSync(OUT), 'Production promotion namespace already exists.');
  assert(!fs.existsSync(PRODUCTION_SURFACE_OUT), 'Production surface namespace already exists.');
  [CANDIDATE, QUALIFICATION, REHEARSAL, DIRECT_SURFACES, REHEARSED_SURFACES, registry.currentModelPath, registry.registryPath]
    .forEach(file => assert(fs.existsSync(file), `Missing ${rel(file)}`));
  assert(sha(CANDIDATE) === HASH, 'Candidate hash mismatch.');
  assert(sha(registry.currentModelPath) === INCUMBENT, 'Incumbent hash changed.');
  assert(sha(registry.registryPath) === REGISTRY_HASH, 'Registry hash changed.');
  assert(!temporaryFiles(path.dirname(registry.currentModelPath)).length
    && !temporaryFiles(path.dirname(registry.registryPath)).length, 'Temporary activation files exist.');

  const qualification = read(QUALIFICATION);
  const rehearsal = read(REHEARSAL);
  const directSurfaces = read(DIRECT_SURFACES);
  const rehearsedSurfaces = read(REHEARSED_SURFACES);
  const candidate = read(CANDIDATE);
  const record = candidate.lariLearnedRecords?.records?.find(item => item.id === RECORD_ID);
  const gates = {
    qualificationPassed: qualification.passed === true && Object.values(qualification.gates || {}).every(Boolean),
    exactQualifiedCandidate: qualification.candidate?.sha256 === HASH,
    hiddenTransferReloadAblation: qualification.gates?.hiddenTransferSixOfSix === true
      && qualification.gates?.reloadRetentionSixOfSix === true
      && qualification.gates?.exactRecordAblationSixOfSix === true,
    zeroFamilyRegressions: qualification.gates?.zeroExistingFamilyRegressions === true,
    canonicalRecordPresent: record?.payload?.operation === 'recap.compose.recursive_verified'
      && record.payload.generatorProgram?.kind === 'recap.recursive_composition_program',
    rehearsalSafe: rehearsal.passed === true
      && rehearsal.verdict === 'Safe for real promotion'
      && Object.values(rehearsal.gates || {}).every(Boolean),
    exactRehearsedCandidate: rehearsal.candidate?.sha256 === HASH,
    directSurfaceParity: directSurfaces.passed === true && Object.values(directSurfaces.gates || {}).every(Boolean),
    rehearsedSurfaceParity: rehearsedSurfaces.passed === true && Object.values(rehearsedSurfaces.gates || {}).every(Boolean),
    externalModelCallsZero: qualification.externalModelCalls === 0
      && rehearsal.externalModelCalls === 0
      && directSurfaces.externalModelCalls === 0
      && rehearsedSurfaces.externalModelCalls === 0
  };
  assert(Object.values(gates).every(Boolean), `Preflight failed ${JSON.stringify(gates)}`);

  const backups = {
    active: preserve(registry.currentModelPath, ACTIVE_BACKUP, INCUMBENT),
    registry: preserve(registry.registryPath, REGISTRY_BACKUP, REGISTRY_HASH)
  };
  const gitStatus = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  write(PREFLIGHT, {
    schemaVersion: 1,
    kind: 'lari.recursive-field-generator.production-preflight',
    createdAt: new Date().toISOString(),
    candidate: { path: rel(CANDIDATE), sha256: HASH, bytes: fs.statSync(CANDIDATE).size },
    incumbent: { path: rel(registry.currentModelPath), sha256: INCUMBENT },
    registry: { path: rel(registry.registryPath), sha256: REGISTRY_HASH },
    backups,
    evidence: [QUALIFICATION, REHEARSAL, DIRECT_SURFACES, REHEARSED_SURFACES].map(file => ({ path: rel(file), sha256: sha(file) })),
    dirtyWorktree: {
      dirty: gitStatus.length > 0,
      entries: gitStatus.split('\0').filter(Boolean).length,
      sha256: crypto.createHash('sha256').update(gitStatus).digest('hex')
    },
    gates,
    passed: true
  });

  try {
    const promoted = registry.promoteLariModel(CANDIDATE, {
      stage: 'recursive-field-generator-production-promotion',
      transaction: 'hash-locked-real-production-promotion',
      candidateHash: HASH,
      candidateProvenance: rel(CANDIDATE),
      productionIncumbentHash: INCUMBENT,
      preflightManifest: rel(PREFLIGHT),
      preflightManifestHash: sha(PREFLIGHT),
      rehearsalManifest: rel(REHEARSAL),
      rehearsalManifestHash: sha(REHEARSAL),
      learnedGeneratorId: RECORD_ID,
      canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
      ordinaryInferenceReadOnly: true,
      fallbackDiscoveryDisabled: true,
      externalModelCalls: 0
    });
    const afterPromotion = state();
    const rollbackPath = path.resolve(ROOT, promoted.previousModelPath);
    const beforeInference = state();
    const loaded = registry.loadLariModel();
    const probes = [
      probe(loaded.model, 'Compare a monolith versus small services and then make a plan for evaluating the tradeoff.', ['balanced_comparison', 'practical_planning']),
      probe(loaded.model, 'Compare a queue versus a direct function call; then make a plan for testing the choice; then ask me what you need to know before you build the first prototype.', ['balanced_comparison', 'practical_planning', 'requirements_clarification'])
    ];
    const afterInference = state();
    const resolved = registry.resolveLariModelPath();
    const candidates = registry.listLariModelCandidates();
    const immediate = {
      exactCandidateActivated: afterPromotion.active === HASH,
      registryManifestExact: read(registry.registryPath).activeModelSha256 === HASH,
      exactRollbackTarget: fs.existsSync(rollbackPath) && sha(rollbackPath) === INCUMBENT,
      contentAddressedBackupsExact: sha(ACTIVE_BACKUP) === INCUMBENT && sha(REGISTRY_BACKUP) === REGISTRY_HASH,
      candidateProvenanceExact: promoted.metadata?.candidateProvenance === rel(CANDIDATE),
      recursiveCompositionActive: probes.every(item => item.passed),
      registryOnly: resolved.source === 'registry' && candidates.length === 1 && candidates[0].id === 'canonical-current',
      inferenceReadOnly: JSON.stringify(beforeInference) === JSON.stringify(afterInference),
      noTemporaryFiles: !temporaryFiles(path.dirname(registry.currentModelPath)).length
        && !temporaryFiles(path.dirname(registry.registryPath)).length,
      externalModelCallsZero: probes.every(item => item.passed)
    };
    assert(Object.values(immediate).every(Boolean), `Immediate validation failed ${JSON.stringify(immediate)}`);

    execFileSync(process.execPath, [
      'scripts/validate_lari_recursive_field_generator_surfaces.js',
      rel(PRODUCTION_SURFACE_OUT),
      'models/lari'
    ], { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: 'inherit', maxBuffer: 128 * 1024 * 1024 });
    const productionSurfaces = read(PRODUCTION_SURFACES);
    assert(productionSurfaces.passed === true && Object.values(productionSurfaces.gates || {}).every(Boolean), 'Production surface parity failed.');
    assert(sha(registry.currentModelPath) === HASH, 'Production model changed during surface validation.');

    const manifest = {
      schemaVersion: 1,
      kind: 'lari.recursive-field-generator.production-promotion',
      createdAt: new Date().toISOString(),
      passed: true,
      candidate: { path: rel(CANDIDATE), sha256: HASH, learnedRecordId: RECORD_ID },
      incumbent: { sha256: INCUMBENT, registrySha256: REGISTRY_HASH },
      promoted: {
        activePath: rel(registry.currentModelPath),
        activeSha256: sha(registry.currentModelPath),
        registryPath: rel(registry.registryPath),
        registrySha256: sha(registry.registryPath),
        promotedAt: promoted.promotedAt
      },
      rollback: {
        registryBackupPath: rel(rollbackPath),
        registryBackupSha256: sha(rollbackPath),
        contentAddressedBackups: backups
      },
      inference: { probes, readOnly: immediate.inferenceReadOnly },
      productionSurfaces: { path: rel(PRODUCTION_SURFACES), sha256: sha(PRODUCTION_SURFACES), passed: true },
      preflightGates: gates,
      immediateGates: immediate,
      status: 'promotion_succeeded',
      externalModelCalls: 0
    };
    write(MANIFEST, manifest);
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    const result = rollback(error);
    if (result) assert(result.exact, 'Automatic rollback was not exact.');
    throw error;
  }
}

main();
