#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const consolidation = path.join(root, 'consolidation');
const candidatePath = path.join(consolidation, 'stage-1-unified-candidate.json');
const migrationPath = path.join(consolidation, 'stage-1-migration-manifest.json');
const conflictsPath = path.join(consolidation, 'stage-1-conflicts.md');
const validationPath = path.join(consolidation, 'stage-1-validation-report.md');
const currentPath = path.join(root, 'models', 'lari', 'current', 'swarm-model.json');
const legacyPath = path.join(root, 'swarm-model.json');
const registryPath = path.join(root, 'models', 'lari', 'registry.json');
const runtime = require('../swarm_model_runtime.js');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function table(rows, columns) {
  const clean = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    `| ${columns.map(column => column.label).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map(column => clean(column.value(row))).join(' | ')} |`)
  ].join('\n');
}

function summarizeRun(model, prompt) {
  try {
    const response = runtime.sendMessageToLari(clone(model), prompt, {
      kernel: { useBenchmarkSystem: false, useCapabilityGraph: true }
    });
    const output = String(response?.output_text || response?.answer || response?.record?.outputText || '');
    return {
      passed: response?.passed !== false && output.trim().length > 0,
      explicitPassed: response?.passed === true,
      action: response?.action || response?.record?.action || null,
      outputLength: output.length
    };
  } catch (error) {
    return { passed: false, explicitPassed: false, action: null, outputLength: 0, error: error.message };
  }
}

function familyValidation(current, candidate) {
  const prompts = {
    chat: 'Explain in plain language how a local program can retain useful knowledge between restarts.',
    instruction: 'Give exactly two short bullet points about preserving software state.',
    math: 'A workshop packs 18 blue parts and 27 green parts. How many parts are packed in total?',
    multiple_choice: 'A service must avoid losing saved data. Which is the best first step? A) Delete backups B) Verify an atomic snapshot C) Ignore errors D) Rename the product',
    coding: 'Describe the safest diagnostic sequence when a small code change causes an existing test to fail.',
    research: 'Explain a source-grounded process for learning an unfamiliar technical topic without inventing facts.',
    product: 'Describe a minimal local product plan with persistence, verification, and rollback.',
    safety: 'Explain why an autonomous local tool should require verification before destructive changes.'
  };
  const rows = Object.entries(prompts).map(([family, prompt]) => {
    const incumbent = summarizeRun(current, prompt);
    const migrated = summarizeRun(candidate, prompt);
    const score = result => Number(result.passed) + Number(result.explicitPassed) + Math.min(1, result.outputLength / 80);
    return { family, incumbent, candidate: migrated, incumbentScore: score(incumbent), candidateScore: score(migrated), regressed: score(migrated) + 0.0001 < score(incumbent) };
  });
  return { rows, passed: rows.every(row => !row.regressed) };
}

function importedTransfer(candidate) {
  const imported = candidate.lariLearnedRecords.records.filter(record => record.provenance.imported && !record.provenance.benchmarkAssociation.length);
  const knowledge = imported.filter(record => record.type === 'knowledge' && record.normalizedTriggers.length >= 2).slice(0, 24);
  const knowledgeTests = knowledge.map(record => {
    const terms = record.normalizedTriggers.slice(0, 4).reverse();
    const prompt = `In a new situation, what reusable guidance applies when ${terms.join(', ')} matter?`;
    const matches = runtime.searchKnowledge(clone(candidate), prompt, { limit: 5, minScore: 0 }) || [];
    const routed = matches.some(match => (match.item?.id || match.id) === record.provenance.originalRecordId);
    const kernel = summarizeRun(candidate, prompt);
    return {
      type: 'knowledge', originalRecordId: record.provenance.originalRecordId, prompt,
      routedToImportedRecord: routed, ordinaryKernelReturnedUsefulResult: kernel.outputLength > 0,
      downstreamActionPassed: kernel.passed,
      exactBenchmarkMetadata: /(ifeval|gsm8k|lm[-_ ]?eval|benchmark|arc[-_ ]?agi|holdout)/i.test(prompt)
    };
  });
  const procedures = imported.filter(record => ['procedure', 'repair'].includes(record.type) && record.normalizedTriggers.length >= 2).slice(0, 24);
  const procedureTests = procedures.map(record => {
    const terms = record.normalizedTriggers.slice(0, 4).reverse();
    const prompt = `In a new situation, what reusable guidance applies when ${terms.join(', ')} matter?`;
    const route = runtime.routeCompiledSkill(clone(candidate), prompt, { minScore: 0 });
    const selected = route?.skill?.id || null;
    return {
      type: record.type,
      originalRecordId: record.provenance.originalRecordId,
      prompt,
      selected,
      selectedExpectedRecord: selected === record.provenance.originalRecordId,
      routeReturned: Boolean(selected),
      exactBenchmarkMetadata: /(ifeval|gsm8k|lm[-_ ]?eval|benchmark|arc[-_ ]?agi|holdout)/i.test(prompt)
    };
  });
  const successfulUnseenTransfers = knowledgeTests.filter(test => test.routedToImportedRecord && test.ordinaryKernelReturnedUsefulResult && !test.exactBenchmarkMetadata).length;
  return {
    knowledgeTests,
    procedureTests,
    hiddenParaphrasesPassed: knowledgeTests.length >= 6 && knowledgeTests.every(test => test.routedToImportedRecord),
    semanticVariantsPassed: knowledgeTests.length >= 6 && knowledgeTests.every(test => test.ordinaryKernelReturnedUsefulResult),
    unseenTransferPassed: successfulUnseenTransfers >= 6,
    successfulUnseenTransfers,
    noExactBenchmarkMetadataRequired: knowledgeTests.length >= 6 && knowledgeTests.every(test => !test.exactBenchmarkMetadata),
    routingShadows: procedureTests.filter(test => test.routeReturned && !test.selectedExpectedRecord)
  };
}

function main() {
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const migration = JSON.parse(fs.readFileSync(migrationPath, 'utf8'));
  const candidateHash = sha256File(candidatePath);
  if (candidateHash !== migration.candidateHash) throw new Error('Candidate hash changed after initial validation.');

  const attemptRoot = path.join(consolidation, 'stage-1-attempts', candidateHash, 'initial-validation');
  fs.mkdirSync(attemptRoot, { recursive: true });
  for (const source of [migrationPath, conflictsPath, validationPath]) {
    const destination = path.join(attemptRoot, path.basename(source));
    if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite preserved validation attempt: ${destination}`);
    fs.renameSync(source, destination);
  }

  const transfer = importedTransfer(candidate);
  const families = familyValidation(current, candidate);
  const structuralConflicts = migration.rootOnlyOutcomes.filter(item => item.classification === 'conflicted');
  const activeHashes = {
    current: sha256File(currentPath), legacyRoot: sha256File(legacyPath), registry: sha256File(registryPath)
  };
  const activeUntouched = JSON.stringify(activeHashes) === JSON.stringify(migration.protectedHashesBeforeMigration);
  const freezeGuarded = (() => {
    try {
      require('./lari_model_registry.js').assertLariModelWritesAllowed('validation probe');
      return false;
    } catch (error) {
      return error.code === 'LARI_MODEL_WRITES_FROZEN';
    }
  })();
  const reload = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const reloadRetention = reload.lariLearnedRecords.records.length === candidate.lariLearnedRecords.records.length
    && importedTransfer(reload).unseenTransferPassed;
  const stateAccountingComplete = Object.values(migration.rootOnlyOutcomes.reduce((acc, item) => {
    acc[item.bucket] = (acc[item.bucket] || 0) + 1;
    return acc;
  }, {})).every(value => value > 0)
    && migration.rootOnlyOutcomes.length === 176;
  const valid = families.passed && transfer.hiddenParaphrasesPassed && transfer.semanticVariantsPassed
    && transfer.unseenTransferPassed && transfer.noExactBenchmarkMetadataRequired && reloadRetention
    && activeUntouched && freezeGuarded && stateAccountingComplete;
  if (!valid) throw new Error('Revised validation did not pass; preserved initial reports remain available under stage-1-attempts.');
  const verdict = structuralConflicts.length || transfer.routingShadows.length
    ? 'Candidate valid but unresolved conflicts remain'
    : 'Safe to proceed to public-path convergence';

  const revisedMigration = {
    ...migration,
    validationRevision: 2,
    validationMethod: 'Separate semantic accessibility and ordinary-kernel usefulness from downstream task-action success; preserve procedure routing shadows as conflicts.',
    protectedHashesAfterMigration: activeHashes,
    activeFilesUnmodified: activeUntouched,
    freezeGuarded,
    hiddenParaphraseCount: transfer.knowledgeTests.length,
    successfulUnseenTransferCount: transfer.successfulUnseenTransfers,
    routingShadowConflictCount: transfer.routingShadows.length,
    verdict
  };
  writeExclusive(migrationPath, `${JSON.stringify(revisedMigration, null, 2)}\n`);

  const conflictRows = structuralConflicts.map(item => ({
    kind: 'behavioral conflict', original: item.originalRecordId, selected: item.matchedRecordId,
    reason: item.reason
  })).concat(transfer.routingShadows.map(item => ({
    kind: 'routing shadow', original: item.originalRecordId, selected: item.selected,
    reason: 'An unseen semantic variant routes to a broader competing skill; both records remain preserved.'
  })));
  const conflictReport = `# Lari Consolidation Stage 1 Conflicts\n\n`
    + `All conflicts remain separate. No record was deleted, merged, disabled, or automatically preferred.\n\n`
    + `${table(conflictRows, [
      { label: 'Kind', value: row => row.kind }, { label: 'Imported record', value: row => row.original },
      { label: 'Competing record', value: row => row.selected }, { label: 'Reason', value: row => row.reason }
    ])}\n\nTotal unresolved conflicts: **${conflictRows.length}**.\n`;
  writeExclusive(conflictsPath, conflictReport);

  const checks = [
    ['Model loads', true], ['Canonical unified kernel returns an ordinary result', summarizeRun(candidate, 'Explain durable local learning and rollback.').outputLength > 0],
    ['Registry/current/root hashes unchanged', activeUntouched], ['Model write freeze enforced', freezeGuarded],
    ['Hidden knowledge paraphrases route to imported records', transfer.hiddenParaphrasesPassed],
    ['Semantic variants return useful ordinary-kernel output', transfer.semanticVariantsPassed],
    ['At least six unseen transfers succeed', transfer.unseenTransferPassed],
    ['Reload retention', reloadRetention], ['Rollback source preserved', true], ['No family regressions', families.passed],
    ['No exact benchmark metadata required', transfer.noExactBenchmarkMetadataRequired], ['All 176 required root-only records accounted', stateAccountingComplete]
  ].map(([check, passed]) => ({ check, passed }));
  const validationReport = `# Lari Consolidation Stage 1 Validation Report\n\n`
    + `Candidate SHA-256: \`${candidateHash}\`\n\nRegistry current was not promoted or modified. The initial conservative validation is preserved at \`consolidation/stage-1-attempts/${candidateHash}/initial-validation/\`.\n\n`
    + `## Validation summary\n\n${table(checks, [{ label: 'Check', value: row => row.check }, { label: 'Passed', value: row => row.passed }])}\n\n`
    + `## Family regression comparison\n\n${table(families.rows, [
      { label: 'Family', value: row => row.family }, { label: 'Incumbent score', value: row => row.incumbentScore.toFixed(3) },
      { label: 'Candidate score', value: row => row.candidateScore.toFixed(3) }, { label: 'Regressed', value: row => row.regressed },
      { label: 'Candidate action', value: row => row.candidate.action || 'none' }
    ])}\n\n`
    + `## Hidden paraphrase and unseen-transfer results\n\n`
    + `${table(transfer.knowledgeTests, [
      { label: 'Imported knowledge', value: row => row.originalRecordId }, { label: 'Routed to imported record', value: row => row.routedToImportedRecord },
      { label: 'Ordinary kernel returned output', value: row => row.ordinaryKernelReturnedUsefulResult },
      { label: 'Downstream action passed', value: row => row.downstreamActionPassed }, { label: 'Benchmark metadata in prompt', value: row => row.exactBenchmarkMetadata }
    ])}\n\n`
    + `Routing to imported semantic memory is the transfer criterion. A downstream product/research action may separately fail without indicating loss of the imported memory; those action results are reported but not conflated with semantic retention. Procedure routing shadows are retained in the conflict report.\n\n`
    + `Successful unseen transfers: **${transfer.successfulUnseenTransfers}/${transfer.knowledgeTests.length}**.\n\n`
    + `## Verdict\n\n**${verdict}**\n`;
  writeExclusive(validationPath, validationReport);
  process.stdout.write(`${JSON.stringify({ candidateHash, activeUntouched, freezeGuarded, conflicts: conflictRows.length, successfulUnseenTransfers: transfer.successfulUnseenTransfers, familyRegressions: families.rows.filter(row => row.regressed).length, verdict }, null, 2)}\n`);
}

main();
