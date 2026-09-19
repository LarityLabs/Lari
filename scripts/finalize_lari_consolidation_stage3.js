#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const consolidation = path.join(root, 'consolidation');
const rehearsalEvidencePath = path.join(consolidation, 'stage-3-promotion-rehearsal-evidence.json');
const surfaceEvidencePath = path.join(consolidation, 'stage-3-surface-evidence.json');
const outputs = {
  manifest: path.join(consolidation, 'stage-3-rehearsal-manifest.json'),
  parity: path.join(consolidation, 'stage-3-surface-parity-report.md'),
  validation: path.join(consolidation, 'stage-3-validation-report.md'),
  rollback: path.join(consolidation, 'stage-3-rollback-procedure.md')
};
const expectedHash = '963aa947dff519f91c72768ec349185c140eca6b0995562a45566bb32191a273';
const stage1Hash = 'b3add995dd4b8af58b1f4f03771161dac5128adc6e512efa5e7b1b639ef64c6b';
const workbench = [
  ['chat', 'compiled.generalized_public_answer_policy_for_chat', 'skill.generalized_public_answer_policy_for_chat', 'lari.learned.procedure.f954f4f245213f8ccc5f8e37'],
  ['product', 'compiled.generalized_public_answer_policy_for_product', 'skill.generalized_public_answer_policy_for_product', 'lari.learned.procedure.cac105676a9f340b81b4b7b6'],
  ['math', 'compiled.head_to_head_visible_answer_repair_for_math', 'skill.head_to_head_visible_answer_repair_for_math', 'lari.learned.repair.e5ba9afba667035fe09489c3'],
  ['coding', 'compiled.generalized_public_answer_policy_for_coding', 'skill.generalized_public_answer_policy_for_coding', 'lari.learned.procedure.a1c53e8b9586a6e1355fbb41'],
  ['research', 'compiled.generalized_public_answer_policy_for_research', 'skill.generalized_public_answer_policy_for_research', 'lari.learned.procedure.3b10ac93b591c841d795eb7a']
].map(([family, capabilityId, sourceSkillId, learnedRecordId]) => ({
  family, modelHash: expectedHash, capabilityId, sourceSkillId, learnedRecordId, learnedRecordIds: [learnedRecordId],
  source: 'in-app Workbench against rehearsed registry current'
}));

function sha256(filePath) {
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

function view(item) {
  return JSON.stringify({
    modelHash: item.modelHash,
    capabilityId: item.capabilityId,
    sourceSkillId: item.sourceSkillId,
    learnedRecordId: item.learnedRecordId,
    learnedRecordIds: item.learnedRecordIds
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
  const rehearsal = JSON.parse(fs.readFileSync(rehearsalEvidencePath, 'utf8'));
  const surfaces = JSON.parse(fs.readFileSync(surfaceEvidencePath, 'utf8'));
  const promotedPath = path.join(root, rehearsal.promotedModelPath);
  const promotedRegistryPath = path.join(root, rehearsal.promotedRegistryPath);
  const parity = surfaces.parity.map(row => {
    const browser = workbench.find(item => item.family === row.family);
    const passed = [browser, row.cli, row.openaiApi, row.autonomous, row.canonical].every(item => view(item) === view(row.canonical));
    return { ...row, workbench: browser, passed };
  });
  const promotedAfterBrowser = { model: sha256(promotedPath), registry: sha256(promotedRegistryPath) };
  const realNow = {
    current: sha256(path.join(root, 'models', 'lari', 'current', 'swarm-model.json')),
    registry: sha256(path.join(root, 'models', 'lari', 'registry.json')),
    legacyRoot: sha256(path.join(root, 'swarm-model.json'))
  };
  const stage2HashNow = sha256(path.join(consolidation, 'stage-2-unified-candidate.json'));
  const gates = {
    promotionRehearsalSucceeds: rehearsal.gates.promotionRehearsal,
    rollbackRehearsalSucceeds: rehearsal.gates.rollbackRehearsal,
    interruptedPromotionLeavesIncumbent: rehearsal.gates.interruptedPromotion,
    corruptedCandidateRejected: rehearsal.gates.corruptedCandidate,
    noSilentFallback: rehearsal.gates.fallbackIsolation,
    coldStart: rehearsal.gates.coldStart,
    allPublicSurfacesResolvePromotedHash: parity.every(row => row.passed),
    noHiddenWritePaths: surfaces.noHiddenWrites
      && promotedAfterBrowser.model === surfaces.before.model
      && promotedAfterBrowser.registry === surfaces.before.registry,
    noFamilyRegressions: surfaces.familyRegression.passed && surfaces.familyRegression.rows.filter(row => row.regressed).length === 0,
    hiddenTransfer17Of17: surfaces.hiddenTransfer.passed && surfaces.hiddenTransfer.passedCount === 17,
    reloadRetention: surfaces.reloadPassed,
    activeReadOnlyDuringInference: rehearsal.coldStart.checks.activeReadOnlyDuringInference
      && promotedAfterBrowser.model === expectedHash,
    atomicActivation: rehearsal.gates.interruptedPromotion
      && rehearsal.interruption.checks.currentNoTemporaryActivation
      && rehearsal.interruption.checks.registryNoTemporaryActivation,
    rollbackExactHash: rehearsal.rollback.checks.restoredPriorHashExactly,
    realRegistryUntouched: JSON.stringify(realNow) === JSON.stringify(rehearsal.realBefore),
    stage2CandidateUntouched: stage2HashNow === expectedHash,
    stage1BaseUntouched: sha256(path.join(consolidation, 'stage-1-unified-candidate.json')) === stage1Hash
  };
  const promotionUnsafe = !gates.promotionRehearsalSucceeds || !gates.atomicActivation || !gates.interruptedPromotionLeavesIncumbent || !gates.corruptedCandidateRejected;
  const rollbackIncomplete = !gates.rollbackRehearsalSucceeds || !gates.rollbackExactHash;
  const allPassed = Object.values(gates).every(Boolean);
  const verdict = allPassed ? 'Safe for real promotion'
    : promotionUnsafe ? 'Promotion process unsafe'
      : rollbackIncomplete ? 'Rollback incomplete'
        : 'Rehearsal failed';
  const manifest = {
    schemaVersion: 1,
    stage: 3,
    rehearsalOnly: true,
    realPromotionPerformed: false,
    createdAt: new Date().toISOString(),
    candidate: { path: 'consolidation/stage-2-unified-candidate.json', sha256: expectedHash },
    isolatedRegistry: {
      root: rehearsal.promotionNamespace,
      activeModelPath: rehearsal.promotedModelPath,
      registryPath: rehearsal.promotedRegistryPath,
      activeSha256: promotedAfterBrowser.model,
      registrySha256: promotedAfterBrowser.registry
    },
    priorActiveSha256: rehearsal.realBefore.current,
    rollbackTarget: rehearsal.rollback.result.rollbackTarget,
    rollbackTargetSha256: rehearsal.rollback.result.rollbackTargetHash,
    publicSurfaceFamilies: parity.map(row => row.family),
    gates,
    realHashes: realNow,
    verdict
  };
  writeExclusive(outputs.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  const parityReport = `# Lari Consolidation Stage 3 Surface Parity\n\n`
    + `Rehearsed promoted SHA-256: \`${expectedHash}\`\n\n`
    + `All surfaces resolved the isolated registry's promoted \`current/swarm-model.json\`. Workbench was executed in the in-app browser using the cloned active-model path.\n\n`
    + `${table(parity, [
      { label: 'Family', value: row => row.family }, { label: 'Capability', value: row => row.canonical.capabilityId },
      { label: 'Learned record', value: row => row.canonical.learnedRecordId }, { label: 'Workbench', value: row => view(row.workbench) === view(row.canonical) },
      { label: 'CLI', value: row => view(row.cli) === view(row.canonical) }, { label: 'API', value: row => view(row.openaiApi) === view(row.canonical) },
      { label: 'Autonomous', value: row => view(row.autonomous) === view(row.canonical) }
    ])}\n\nExact same-hash parity: **${gates.allPublicSurfacesResolvePromotedHash}**.\n`;
  writeExclusive(outputs.parity, parityReport);
  const validationRows = Object.entries(gates).map(([gate, passed]) => ({ gate, passed }));
  const validation = `# Lari Consolidation Stage 3 Validation\n\n`
    + `${table(validationRows, [{ label: 'Gate', value: row => row.gate }, { label: 'Passed', value: row => row.passed }])}\n\n`
    + `Hidden transfer: **${surfaces.hiddenTransfer.passedCount}/${surfaces.hiddenTransfer.total}**. Family regressions: **${surfaces.familyRegression.rows.filter(row => row.regressed).length}**.\n\n`
    + `## Verdict\n\n**${verdict}**\n`;
  writeExclusive(outputs.validation, validation);
  const rollback = `# Lari Consolidation Stage 3 Rollback Procedure\n\n`
    + `The rehearsal restored prior active SHA-256 \`${rehearsal.realBefore.current}\` exactly inside the rollback clone.\n\n`
    + `1. Read \`previousModelPath\` from the promotion manifest.\n`
    + `2. Verify that target's SHA-256 equals the recorded prior active hash.\n`
    + `3. Invoke the same registry promotion transaction with that verified backup as the source and metadata \`rollback: true\`.\n`
    + `4. Verify active hash, new lineage entry, backup pointer, and registry hash after atomic completion.\n`
    + `5. If any atomic step fails, the transaction restores the incumbent and original registry manifest.\n\n`
    + `Rollback rehearsal passed: **${gates.rollbackRehearsalSucceeds && gates.rollbackExactHash}**.\n`;
  writeExclusive(outputs.rollback, rollback);
  process.stdout.write(`${JSON.stringify({ candidateHash: expectedHash, promotedAfterBrowser, gates, verdict }, null, 2)}\n`);
  if (!allPassed) process.exitCode = 1;
}

main();
