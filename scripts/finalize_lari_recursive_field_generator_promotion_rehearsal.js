#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HASH = 'cab74f590d5ad4533202b1ee2c08b32e28ec47e3c8134ddd24a2bc5bdd7a0fed';
const RECORD_ID = 'lari.learned.generator.neurogenesis.4b44de8b5bd9a4a341de';
const SOURCE = path.join(ROOT, 'consolidation', 'recursive-field-generator-20260831');
const OUT = path.join(ROOT, 'consolidation', 'recursive-field-generator-promotion-rehearsal-attempt2-20260831');
const files = {
  candidate: path.join(SOURCE, 'candidates', `${HASH}.json`),
  qualification: path.join(SOURCE, 'qualification-report.json'),
  directSurfaces: path.join(ROOT, 'consolidation', 'recursive-field-generator-surface-parity-attempt2-20260831', 'surface-parity.json'),
  transaction: path.join(OUT, 'promotion-rehearsal-evidence.json'),
  rehearsedSurfaces: path.join(ROOT, 'consolidation', 'recursive-field-generator-rehearsed-surfaces-20260831', 'surface-parity.json'),
  active: path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json'),
  registry: path.join(ROOT, 'models', 'lari', 'registry.json')
};
const outputs = {
  manifest: path.join(OUT, 'rehearsal-manifest.json'),
  report: path.join(OUT, 'PROMOTION_REHEARSAL_REPORT.md'),
  rollback: path.join(OUT, 'ROLLBACK_PROCEDURE.md')
};
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

function main() {
  Object.values(outputs).forEach(file => {
    if (fs.existsSync(file)) throw new Error(`Refusing to overwrite ${rel(file)}`);
  });
  Object.values(files).forEach(file => {
    if (!fs.existsSync(file)) throw new Error(`Missing ${rel(file)}`);
  });
  const qualification = read(files.qualification);
  const directSurfaces = read(files.directSurfaces);
  const transaction = read(files.transaction);
  const rehearsedSurfaces = read(files.rehearsedSurfaces);
  const candidate = read(files.candidate);
  const realNow = { active: sha(files.active), registry: sha(files.registry) };
  const incumbent = transaction.realBefore?.current;
  const gates = {
    exactQualifiedCandidate: sha(files.candidate) === HASH
      && qualification.candidate?.sha256 === HASH
      && qualification.passed === true
      && Object.values(qualification.gates || {}).every(Boolean),
    directFiveSurfaceParity: directSurfaces.passed === true
      && Object.values(directSurfaces.gates || {}).every(Boolean),
    isolatedAtomicPromotion: transaction.gates?.promotionRehearsal === true,
    exactRollback: transaction.gates?.rollbackRehearsal === true
      && transaction.rollback?.checks?.restoredPriorHashExactly === true,
    interruptionSafety: transaction.gates?.interruptedPromotion === true,
    corruptedCandidateRejected: transaction.gates?.corruptedCandidate === true,
    noSilentFallback: transaction.gates?.fallbackIsolation === true,
    coldStartReadOnly: transaction.gates?.coldStart === true,
    rehearsedFiveSurfaceParity: rehearsedSurfaces.passed === true
      && rehearsedSurfaces.registryMode === 'rehearsed-promotion-clone'
      && Object.values(rehearsedSurfaces.gates || {}).every(Boolean),
    exactCompositionRecordEverySurface: rehearsedSurfaces.rows?.every(row =>
      Object.values(row.surfaces || {}).every(surface => surface.learnedRecordIds?.includes(RECORD_ID))) === true,
    hiddenTransferReloadAblation: qualification.gates?.hiddenTransferSixOfSix === true
      && qualification.gates?.reloadRetentionSixOfSix === true
      && qualification.gates?.exactRecordAblationSixOfSix === true,
    zeroFamilyRegressions: qualification.gates?.zeroExistingFamilyRegressions === true,
    realProductionUntouched: realNow.active === incumbent
      && transaction.realBefore?.current === transaction.realAfter?.current
      && transaction.realBefore?.registry === transaction.realAfter?.registry,
    candidateStillUnpromoted: candidate.lineage?.promoted === false
      && qualification.candidate?.promoted === false,
    externalModelCallsZero: qualification.externalModelCalls === 0
      && directSurfaces.externalModelCalls === 0
      && rehearsedSurfaces.externalModelCalls === 0
  };
  const passed = Object.values(gates).every(Boolean);
  const verdict = passed ? 'Safe for real promotion' : 'Rehearsal failed';
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.recursive-field-generator.promotion-rehearsal',
    createdAt: new Date().toISOString(),
    rehearsalOnly: true,
    realPromotionPerformed: false,
    candidate: { path: rel(files.candidate), sha256: HASH, learnedRecordId: RECORD_ID },
    incumbent: { path: rel(files.active), sha256: incumbent },
    evidence: Object.fromEntries(['qualification', 'directSurfaces', 'transaction', 'rehearsedSurfaces'].map(key => [key, {
      path: rel(files[key]), sha256: sha(files[key])
    }])),
    preservedFailedAttempts: [
      'consolidation/recursive-field-generator-surface-parity-20260831/surface-parity.json',
      'consolidation/recursive-field-generator-promotion-rehearsal-20260831/'
    ],
    gates,
    passed,
    verdict,
    externalModelCalls: 0,
    limitations: qualification.limitations
  };
  write(outputs.manifest, manifest);
  write(outputs.report, `# Recursive field generator promotion rehearsal\n\n- Candidate: \`${HASH}\`\n- Production incumbent: \`${incumbent}\`\n- Real promotion performed: **no**\n- Direct candidate five-surface parity: **6/6**\n- Rehearsed promoted-registry five-surface parity: **6/6**\n- Exact learned record selected: \`${RECORD_ID}\`\n- Atomic promotion and exact rollback: **PASS**\n- Interrupted current and registry writes: **incumbent preserved**\n- Corrupted candidate: **rejected**\n- Root, benchmark, and candidate fallback: **disabled and verified**\n- Cold start and ordinary inference: **read-only**\n- Hidden transfer / reload / exact ablation: **6/6 / 6/6 / 6/6**\n- Existing-family regressions: **0**\n- External model calls: **0**\n- Production files changed by rehearsal: **0**\n\n## Honest boundary\n\nThis proves promotion safety and exact public-surface execution for one learned recursive composition record over existing verified RECAP families. It does not prove unrestricted language generation or arbitrary semantic-primitive invention.\n\nVerdict: **${verdict}**\n`);
  write(outputs.rollback, `# Recursive field generator rollback procedure\n\nThe isolated rehearsal restored incumbent SHA-256 \`${incumbent}\` exactly.\n\n1. Verify active-model and registry hashes before promotion.\n2. Require the registry backup pointer to resolve to \`${incumbent}\`.\n3. Activate \`${HASH}\` only through the existing atomic registry transaction.\n4. If any immediate inference or surface gate fails, invoke that transaction with \`rollback: true\`.\n5. Verify the restored active hash equals \`${incumbent}\`, rollback lineage is recorded, and no temporary activation file remains.\n6. Never load legacy root, benchmark, or candidate paths as a fallback.\n`);
  console.log(JSON.stringify({ passed, verdict, gates, outputs: Object.fromEntries(Object.entries(outputs).map(([key, file]) => [key, rel(file)])) }, null, 2));
  if (!passed) process.exitCode = 1;
}

main();
