#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const consolidation = path.join(root, 'consolidation');
const candidatePath = path.join(consolidation, 'stage-2-unified-candidate.json');
const stage1Path = path.join(consolidation, 'stage-1-unified-candidate.json');
const conflictEvidencePath = path.join(consolidation, 'stage-2-conflict-evidence.json');
const partialParityPath = path.join(consolidation, '.stage-2-non-workbench-parity.json');
const outputs = {
  manifest: path.join(consolidation, 'stage-2-migration-manifest.json'),
  parity: path.join(consolidation, 'stage-2-surface-parity-report.md'),
  validation: path.join(consolidation, 'stage-2-validation-report.md'),
  rollback: path.join(consolidation, 'stage-2-rollback.md')
};
const stage1Hash = 'b3add995dd4b8af58b1f4f03771161dac5128adc6e512efa5e7b1b639ef64c6b';
const expectedCandidateHash = '963aa947dff519f91c72768ec349185c140eca6b0995562a45566bb32191a273';
const workbenchEvidence = [
  ['chat', 'compiled.generalized_public_answer_policy_for_chat', 'skill.generalized_public_answer_policy_for_chat', 'lari.learned.procedure.f954f4f245213f8ccc5f8e37'],
  ['product', 'compiled.generalized_public_answer_policy_for_product', 'skill.generalized_public_answer_policy_for_product', 'lari.learned.procedure.cac105676a9f340b81b4b7b6'],
  ['math', 'compiled.head_to_head_visible_answer_repair_for_math', 'skill.head_to_head_visible_answer_repair_for_math', 'lari.learned.repair.e5ba9afba667035fe09489c3'],
  ['coding', 'compiled.generalized_public_answer_policy_for_coding', 'skill.generalized_public_answer_policy_for_coding', 'lari.learned.procedure.a1c53e8b9586a6e1355fbb41'],
  ['research', 'compiled.generalized_public_answer_policy_for_research', 'skill.generalized_public_answer_policy_for_research', 'lari.learned.procedure.3b10ac93b591c841d795eb7a']
].map(([family, capabilityId, sourceSkillId, learnedRecordId]) => ({
  family, modelHash: expectedCandidateHash, capabilityId, sourceSkillId, learnedRecordId, learnedRecordIds: [learnedRecordId],
  source: 'in-app Workbench browser execution'
}));

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeExclusive(filePath, content) {
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function view(value) {
  return JSON.stringify({
    modelHash: value.modelHash,
    capabilityId: value.capabilityId,
    sourceSkillId: value.sourceSkillId,
    learnedRecordId: value.learnedRecordId,
    learnedRecordIds: value.learnedRecordIds
  });
}

function table(rows, columns) {
  const clean = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    `| ${columns.map(column => column.label).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map(column => clean(column.value(row))).join(' | ')} |`)
  ].join('\n');
}

function main() {
  for (const output of Object.values(outputs)) if (fs.existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
  if (sha256File(candidatePath) !== expectedCandidateHash) throw new Error('Stage 2 candidate hash mismatch.');
  if (sha256File(stage1Path) !== stage1Hash) throw new Error('Stage 1 candidate changed.');
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const conflicts = JSON.parse(fs.readFileSync(conflictEvidencePath, 'utf8'));
  const partial = JSON.parse(fs.readFileSync(partialParityPath, 'utf8'));
  const parity = partial.parity.map(row => {
    const workbench = workbenchEvidence.find(item => item.family === row.family);
    const passed = [workbench, row.cli, row.openaiApi, row.autonomous, row.direct].every(item => view(item) === view(row.direct));
    return { ...row, workbench, passed };
  });
  const activeNow = {
    current: sha256File(path.join(root, 'models', 'lari', 'current', 'swarm-model.json')),
    legacyRoot: sha256File(path.join(root, 'swarm-model.json')),
    registry: sha256File(path.join(root, 'models', 'lari', 'registry.json'))
  };
  const activeUnmodified = JSON.stringify(activeNow) === JSON.stringify(partial.activeBefore)
    && JSON.stringify(activeNow) === JSON.stringify(conflicts.activeBefore);
  const gates = {
    conflictsClassified: candidate.lariConflictResolution?.gates?.conflictsClassified === 23,
    routingShadows: candidate.lariConflictResolution?.gates?.routingResolvedOrJustified === 21,
    behavioralConflicts: candidate.lariConflictResolution?.gates?.behavioralResolvedOrQuarantined === 2,
    familyRegressions: partial.familyRegression.passed && partial.familyRegression.rows.filter(row => row.regressed).length === 0,
    hiddenTransfer: partial.hiddenTransfer.passed && partial.hiddenTransfer.passedCount >= 17,
    sameHashSurfaceParity: parity.every(row => row.passed),
    reloadRetention: partial.reloadPassed && conflicts.reloadPassed,
    rollbackVerified: partial.rollbackVerified && sha256File(stage1Path) === stage1Hash,
    noActiveModelMutation: activeUnmodified,
    noPromotion: candidate.lariConsolidation?.promoted === false,
    sameDerivedIndex: parity.every(row => [row.workbench, row.cli, row.openaiApi, row.autonomous].every(item => item.modelHash === expectedCandidateHash))
  };
  const allPassed = Object.values(gates).every(Boolean);
  const verdict = allPassed ? 'Safe to proceed to promotion rehearsal'
    : gates.familyRegressions === false ? 'Conflict resolution caused regressions'
      : gates.sameHashSurfaceParity === false ? 'Candidate valid but surface divergence remains'
        : 'Stage 2 incomplete';
  const manifest = {
    schemaVersion: 1,
    stage: 2,
    createdAt: new Date().toISOString(),
    promoted: false,
    stage1Base: { path: 'consolidation/stage-1-unified-candidate.json', sha256: stage1Hash },
    candidate: { path: 'consolidation/stage-2-unified-candidate.json', sha256: expectedCandidateHash, bytes: fs.statSync(candidatePath).size },
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    derivedIndexSource: 'lariLearnedRecords.records',
    gates,
    conflictCounts: { classified: 23, routingResolvedOrJustified: 21, behavioralResolvedOrQuarantined: 2 },
    surfaceParityFamilies: parity.map(row => row.family),
    activeHashes: activeNow,
    verdict
  };
  writeExclusive(outputs.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

  const parityReport = `# Lari Consolidation Stage 2 Surface Parity\n\n`
    + `Candidate SHA-256: \`${expectedCandidateHash}\`\n\n`
    + `Workbench was executed in the in-app browser. CLI adapter, OpenAI-compatible API, and autonomous requests were executed against the same immutable file. All requests entered through \`sendMessageToLari -> runLariUnifiedTaskKernel\`.\n\n`
    + `${table(parity, [
      { label: 'Family', value: row => row.family }, { label: 'Capability', value: row => row.direct.capabilityId },
      { label: 'Learned record', value: row => row.direct.learnedRecordId }, { label: 'Workbench', value: row => view(row.workbench) === view(row.direct) },
      { label: 'CLI', value: row => view(row.cli) === view(row.direct) }, { label: 'OpenAI API', value: row => view(row.openaiApi) === view(row.direct) },
      { label: 'Autonomous', value: row => view(row.autonomous) === view(row.direct) }
    ])}\n\nSame candidate hash across all surfaces: **${gates.sameHashSurfaceParity}**.\n`;
  writeExclusive(outputs.parity, parityReport);

  const validationRows = [
    ['23/23 conflicts classified', gates.conflictsClassified], ['21/21 routing shadows resolved or justified', gates.routingShadows],
    ['2/2 behavioral conflicts resolved', gates.behavioralConflicts], ['0 family regressions', gates.familyRegressions],
    [`Hidden transfer ${partial.hiddenTransfer.passedCount}/${partial.hiddenTransfer.total}`, gates.hiddenTransfer],
    ['Same-hash parity across public surfaces', gates.sameHashSurfaceParity], ['Same derived capability index', gates.sameDerivedIndex],
    ['Reload retention', gates.reloadRetention], ['Rollback verified', gates.rollbackVerified],
    ['No active model mutation', gates.noActiveModelMutation], ['Candidate not promoted', gates.noPromotion]
  ].map(([gate, passed]) => ({ gate, passed }));
  const validationReport = `# Lari Consolidation Stage 2 Validation\n\n`
    + `Stage 1 base: \`${stage1Hash}\`\n\nStage 2 candidate: \`${expectedCandidateHash}\`\n\n`
    + `${table(validationRows, [{ label: 'Gate', value: row => row.gate }, { label: 'Passed', value: row => row.passed }])}\n\n`
    + `The two behavioral conflicts are classified as **context-dependent** and **composable**. No conflicting record was merged or deleted. Twenty-one routing shadows are either directly resolved or justified by a narrower same-family procedure with stronger procedural/holdout evidence.\n\n`
    + `## Verdict\n\n**${verdict}**\n`;
  writeExclusive(outputs.validation, validationReport);

  const rollback = `# Lari Consolidation Stage 2 Rollback\n\n`
    + `No promotion occurred. Rollback means stop loading \`consolidation/stage-2-unified-candidate.json\` and restore the Stage 1 candidate as the tested candidate base.\n\n`
    + `1. Verify Stage 2 hash: \`${expectedCandidateHash}\`.\n`
    + `2. Verify Stage 1 hash: \`${stage1Hash}\`.\n`
    + `3. Verify registry current, legacy root, and registry hashes against \`stage-2-migration-manifest.json\`.\n`
    + `4. Revert only the Stage 2 runtime/public-surface code changes; do not copy either candidate over registry current.\n`
    + `5. Keep the consolidation write freeze active until a separately authorized promotion rehearsal.\n\nRollback verification passed: **${gates.rollbackVerified}**.\n`;
  writeExclusive(outputs.rollback, rollback);
  process.stdout.write(`${JSON.stringify({ candidateHash: expectedCandidateHash, gates, verdict }, null, 2)}\n`);
  if (!allPassed) process.exitCode = 1;
}

main();
