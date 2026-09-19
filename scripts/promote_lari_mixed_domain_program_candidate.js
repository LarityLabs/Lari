#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
delete process.env.LARI_REGISTRY_ROOT;
delete process.env.LARI_MODEL_PATH;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
process.env.LARI_ALLOW_LEGACY_ROOT_MODEL = '0';
const registry = require('./lari_model_registry.js');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'mixed-domain-program-growth-production-promotion-20260908');
const CANDIDATE_HASH = '36bd9214e19a48aba996dad1ea2d09cd4d0cbae08302b35a23ff29e23948399d';
const INCUMBENT_HASH = '44b209ab89d29e05cb743361020c7060498cf737113cba9356594d2274ed549b';
const REGISTRY_HASH = '341e7da05e337cde2709ab7671ad651eb1b0a692f62fe50469590f3998656c33';
const PARENT_HASH = '7b5ccd888b3dd1cb80d715c0915707502f4eed9009d94e457b0cd246ef78c041';
const CANDIDATE = path.join(ROOT, 'consolidation', 'mixed-domain-program-growth-20260908', 'candidates', `${CANDIDATE_HASH}.json`);
const QUALIFICATION = path.join(ROOT, 'consolidation', 'mixed-domain-program-growth-20260908', 'qualification-report.json');
const REHEARSALS = [
  path.join(ROOT, 'consolidation', 'mixed-domain-program-growth-20260908', 'promotion-rehearsal-attempt2', 'promotion-rehearsal-evidence.json'),
  path.join(ROOT, 'consolidation', 'mixed-domain-program-growth-20260908', 'promotion-rehearsal-code-family-attempt2', 'promotion-rehearsal-evidence.json')
];
const EXPECTED_EVIDENCE_HASHES = {
  [QUALIFICATION]: 'ab58aa42cd7f062e69d4a0ad1ca5253c7bb17d7fa5dbbaa1391d85c012b2513b',
  [REHEARSALS[0]]: 'cc830fa9b420eaaf5aa4a2fc76ed855334ef019940925a829647c8c1ab274b74',
  [REHEARSALS[1]]: '41678d7d63aa3e4c47bb660a7e074781dc525d09f6831faa1977cc40796af631'
};
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (value, message) => { if (!value) throw new Error(message); };
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const temporaryFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.tmp') || /^\..+\.tmp$/.test(name)) : [];

function main() {
  assert(!fs.existsSync(OUT), `Refusing to overwrite ${rel(OUT)}`);
  assert(registry.registryRoot === registry.defaultRegistryRoot, 'Real registry root is not selected.');
  assert(sha(CANDIDATE) === CANDIDATE_HASH, 'Candidate hash drifted.');
  assert(sha(registry.currentModelPath) === INCUMBENT_HASH, 'Production incumbent hash drifted.');
  assert(sha(registry.registryPath) === REGISTRY_HASH, 'Production registry hash drifted.');
  for (const [file, expected] of Object.entries(EXPECTED_EVIDENCE_HASHES)) assert(sha(file) === expected, `Evidence hash drifted: ${rel(file)}`);
  const qualification = JSON.parse(fs.readFileSync(QUALIFICATION, 'utf8'));
  assert(qualification.passed === true && qualification.candidate.sha256 === CANDIDATE_HASH && Object.values(qualification.gates).every(Boolean), 'Qualification is not fully green.');
  for (const file of REHEARSALS) {
    const rehearsal = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(rehearsal.candidate.sha256 === CANDIDATE_HASH && Object.values(rehearsal.gates).every(Boolean), `Rehearsal is not fully green: ${rel(file)}`);
    assert(Object.values(rehearsal.publicSurfaceParity.checks).every(Boolean), `Exact surface parity is not green: ${rel(file)}`);
  }
  assert(temporaryFiles(path.dirname(registry.currentModelPath)).length === 0 && temporaryFiles(path.dirname(registry.registryPath)).length === 0, 'Production namespace contains temporary files.');
  fs.mkdirSync(path.join(OUT, 'backups'), { recursive: true });
  const activeBackup = path.join(OUT, 'backups', `sha256-${INCUMBENT_HASH}.json`);
  const registryBackup = path.join(OUT, 'backups', `registry-sha256-${REGISTRY_HASH}.json`);
  fs.copyFileSync(registry.currentModelPath, activeBackup, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(registry.registryPath, registryBackup, fs.constants.COPYFILE_EXCL);
  writeJson(path.join(OUT, 'pre-promotion-backup-manifest.json'), {
    schemaVersion: 1,
    kind: 'lari.mixed-domain-program-growth.pre-promotion-backup',
    createdAt: new Date().toISOString(),
    active: { source: rel(registry.currentModelPath), backup: rel(activeBackup), sha256: sha(activeBackup), size: fs.statSync(activeBackup).size },
    registry: { source: rel(registry.registryPath), backup: rel(registryBackup), sha256: sha(registryBackup), size: fs.statSync(registryBackup).size },
    candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH, size: fs.statSync(CANDIDATE).size },
    qualification: { path: rel(QUALIFICATION), sha256: sha(QUALIFICATION) },
    rehearsals: REHEARSALS.map(file => ({ path: rel(file), sha256: sha(file) }))
  });
  let promoted = null;
  try {
    promoted = registry.promoteLariModel(CANDIDATE, {
      stage: 'mixed-domain-program-growth-production-promotion',
      transaction: 'hash-locked-real-production-promotion',
      candidateHash: CANDIDATE_HASH,
      candidateProvenance: rel(CANDIDATE),
      lineageParentHash: PARENT_HASH,
      productionIncumbentHash: INCUMBENT_HASH,
      learnedRecordIds: qualification.additions.flatMap(item => [item.operatorId, item.generatorId]),
      qualificationManifest: rel(QUALIFICATION),
      qualificationManifestHash: sha(QUALIFICATION),
      rehearsalManifests: REHEARSALS.map(rel),
      rehearsalManifestHashes: REHEARSALS.map(sha),
      canonicalRuntime: 'sendMessageToLariAsync -> sendMessageToLari -> runLariUnifiedTaskKernel',
      ordinaryInferenceReadOnly: true,
      fallbackDiscoveryDisabled: true,
      externalModelCalls: 0
    });
    const rollbackPath = path.resolve(ROOT, promoted.previousModelPath);
    const resolution = registry.resolveLariModelPath();
    const candidates = registry.listLariModelCandidates();
    const gates = {
      exactCandidateActivated: sha(registry.currentModelPath) === CANDIDATE_HASH,
      rollbackTargetExact: fs.existsSync(rollbackPath) && sha(rollbackPath) === INCUMBENT_HASH,
      contentAddressedBackupsExact: sha(activeBackup) === INCUMBENT_HASH && sha(registryBackup) === REGISTRY_HASH,
      directCandidateParentExact: promoted.metadata?.lineageParentHash === PARENT_HASH,
      productionIncumbentExact: promoted.metadata?.productionIncumbentHash === INCUMBENT_HASH,
      candidateProvenanceExact: promoted.metadata?.candidateProvenance === rel(CANDIDATE),
      registryResolutionOnly: resolution.source === 'registry' && path.resolve(resolution.path) === registry.currentModelPath,
      noFallbackCandidates: candidates.length === 1 && candidates[0].id === 'canonical-current',
      noTemporaryFiles: temporaryFiles(path.dirname(registry.currentModelPath)).length === 0 && temporaryFiles(path.dirname(registry.registryPath)).length === 0
    };
    assert(Object.values(gates).every(Boolean), `Immediate promotion gate failed: ${JSON.stringify(gates)}`);
    const manifest = { schemaVersion: 1, kind: 'lari.mixed-domain-program-growth.production-promotion', createdAt: new Date().toISOString(), candidate: { path: rel(CANDIDATE), sha256: CANDIDATE_HASH }, incumbent: { sha256: INCUMBENT_HASH, registrySha256: REGISTRY_HASH }, promoted: { path: rel(registry.currentModelPath), sha256: sha(registry.currentModelPath), registrySha256: sha(registry.registryPath), promotedAt: promoted.promotedAt }, rollback: { path: rel(rollbackPath), sha256: sha(rollbackPath) }, gates, externalModelCalls: 0, status: 'promotion_succeeded' };
    writeJson(path.join(OUT, 'production-promotion-manifest.json'), manifest);
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    if (promoted && fs.existsSync(activeBackup)) registry.promoteLariModel(activeBackup, { transaction: 'automatic-rollback-mixed-domain-program-growth', rollback: true, rollbackTargetHash: INCUMBENT_HASH, rolledBackFromHash: CANDIDATE_HASH, externalModelCalls: 0 });
    throw error;
  }
}
main();
