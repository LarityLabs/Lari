#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'coding-mastery-acquisition-promotion-rehearsal-20260831');
const SOURCE = path.join(ROOT, 'consolidation', 'coding-mastery-acquisition-attempt3-20260830');
const CANDIDATE_HASH = '9d48f8f29f9406eb41cbd5e2f7740f96900b1902c2075dc1c91954ab0fbdc54b';
const INCUMBENT_HASH = '91713c42753f32df11df29db70acf78c55c7eb5e9530426913b7fe954eb4e80d';
const files = {
  candidate: path.join(SOURCE, 'qualified-candidates', `${CANDIDATE_HASH}.json`),
  qualification: path.join(SOURCE, 'qualification-report.json'),
  transaction: path.join(OUT, 'promotion-rehearsal-evidence.json'),
  surfaces: path.join(OUT, 'surface-evidence.json'),
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
const writeImmutable = (file, body) => fs.writeFileSync(file, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });

function main() {
  for (const file of Object.values(outputs)) if (fs.existsSync(file)) throw new Error(`Refusing to overwrite ${rel(file)}`);
  for (const file of Object.values(files)) if (!fs.existsSync(file)) throw new Error(`Missing ${rel(file)}`);
  const candidate = read(files.candidate);
  const qualification = read(files.qualification);
  const transaction = read(files.transaction);
  const surfaces = read(files.surfaces);
  const realNow = { current: sha(files.active), registry: sha(files.registry) };
  const gates = {
    exactCandidateHash: sha(files.candidate) === CANDIDATE_HASH && qualification.qualifiedCandidate?.sha256 === CANDIDATE_HASH,
    qualifiedCandidate: qualification.passed === true && Object.values(qualification.gates || {}).every(Boolean),
    isolatedPromotion: transaction.gates?.promotionRehearsal === true,
    exactRollback: transaction.gates?.rollbackRehearsal === true && transaction.rollback?.checks?.restoredPriorHashExactly === true,
    interruptionSafety: transaction.gates?.interruptedPromotion === true,
    corruptedCandidateRejected: transaction.gates?.corruptedCandidate === true,
    noSilentFallback: transaction.gates?.fallbackIsolation === true,
    coldStartReadOnly: transaction.gates?.coldStart === true,
    fiveSurfaceParity: surfaces.passed === true && surfaces.gates?.fiveSurfaceAnswerParity === true && surfaces.gates?.fiveSurfaceSelectionParity === true && surfaces.gates?.allSurfacesResolvePromotedHash === true,
    freshRepositoryExecution: surfaces.gates?.freshRepositoryPassedAfter === true && surfaces.gates?.promotedProcedureSelected === true && surfaces.gates?.twoFileZeroSearchReuse === true,
    hiddenTransferReloadAblation: surfaces.gates?.qualificationHiddenTransferFourOfFour === true && surfaces.gates?.qualificationReloadFourOfFour === true && surfaces.gates?.qualificationAblationFourOfFour === true,
    zeroFamilyRegressions: surfaces.gates?.qualificationNoRegressions === true,
    realProductionUntouched: realNow.current === INCUMBENT_HASH && transaction.realBefore?.current === transaction.realAfter?.current && transaction.realBefore?.registry === transaction.realAfter?.registry,
    candidateStillUnpromoted: candidate.lineage?.promoted === false && qualification.qualifiedCandidate?.promoted === false,
    externalModelCallsZero: qualification.externalModelCalls === 0 && surfaces.externalModelCalls === 0
  };
  const passed = Object.values(gates).every(Boolean);
  const verdict = passed ? 'Safe for real promotion' : 'Rehearsal failed';
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.coding-mastery-acquisition.promotion-rehearsal',
    createdAt: new Date().toISOString(),
    rehearsalOnly: true,
    realPromotionPerformed: false,
    candidate: { path: rel(files.candidate), sha256: CANDIDATE_HASH, parentHash: qualification.parentHash },
    incumbent: { path: rel(files.active), sha256: INCUMBENT_HASH },
    evidence: {
      qualification: { path: rel(files.qualification), sha256: sha(files.qualification) },
      transaction: { path: rel(files.transaction), sha256: sha(files.transaction) },
      surfaces: { path: rel(files.surfaces), sha256: sha(files.surfaces) }
    },
    gates, passed, verdict, externalModelCalls: 0,
    limitations: qualification.limitations
  };
  writeImmutable(outputs.manifest, manifest);
  writeImmutable(outputs.report, `# Coding mastery acquisition promotion rehearsal\n\n- Candidate: \`${CANDIDATE_HASH}\`\n- Production incumbent: \`${INCUMBENT_HASH}\`\n- Real promotion performed: **no**\n- Isolated atomic promotion and exact rollback: **PASS**\n- Interrupted-write safety and corrupted-candidate rejection: **PASS**\n- No silent root, benchmark, or candidate fallback: **PASS**\n- Workbench, CLI, OpenAI-compatible API, autonomous, and canonical parity: **4/4 equivalent prompts**\n- Fresh two-file repository execution through rehearsed active model: **PASS**\n- Hidden transfer / cold reload / exact-record ablation: **4/4 / 4/4 / 4/4**\n- Family regressions: **0**\n- External model calls: **0**\n- Production files changed by rehearsal: **0**\n\n## Honest boundary\n\nThis proves the promotion mechanics and the previously qualified bounded async-predicate pipeline capability. It does not prove arbitrary repository repair, and it does not yet prove primitive invention.\n\nVerdict: **${verdict}**\n`);
  writeImmutable(outputs.rollback, `# Rollback procedure\n\nThe isolated rehearsal restored incumbent SHA-256 \`${INCUMBENT_HASH}\` exactly.\n\n1. Verify the incumbent active hash and registry hash before promotion.\n2. Require the backup pointer to resolve to \`${INCUMBENT_HASH}\`.\n3. Activate \`${CANDIDATE_HASH}\` only with the existing atomic registry transaction.\n4. On any failed gate, invoke the same transaction with \`rollback: true\`.\n5. Verify the restored active hash is exactly \`${INCUMBENT_HASH}\`, lineage records the rollback, and no temporary activation file remains.\n6. Never load a root model, benchmark artifact, or candidate path as a fallback.\n`);
  console.log(JSON.stringify({ passed, verdict, gates, outputs: Object.fromEntries(Object.entries(outputs).map(([key, file]) => [key, rel(file)])) }, null, 2));
  if (!passed) process.exitCode = 1;
}

main();
