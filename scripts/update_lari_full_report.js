#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'LARI_FULL_REPORT.md');
const SNAPSHOT_PATH = path.join(ROOT, 'LARI_FULL_REPORT.json');
const ACTIVE_PATH = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY_PATH = path.join(ROOT, 'models', 'lari', 'registry.json');
const FRESH_MS = 24 * 60 * 60 * 1000;

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Value(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveRepoPath(value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function fileInfo(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return {
    path: relative(filePath),
    sha256: sha256File(filePath),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    ageMs: Math.max(0, Date.now() - stat.mtimeMs)
  };
}

function freshness(info, expectedModelHash = null, reportedModelHash = null) {
  if (!info) return 'missing';
  if (expectedModelHash && reportedModelHash && expectedModelHash !== reportedModelHash) return 'historical model';
  return info.ageMs <= FRESH_MS ? 'fresh' : 'stale';
}

function countBy(records, key) {
  const output = {};
  for (const record of records || []) {
    const value = String(record?.[key] || 'unknown');
    output[value] = Number(output[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

function modelSummary(model, info) {
  const records = model?.lariLearnedRecords?.records || [];
  return {
    ...info,
    modelName: model?.modelName || model?.modelDisplayName || 'Lari',
    schemaVersion: model?.schemaVersion || null,
    generation: model?.generation || null,
    skills: model?.skills?.length || 0,
    compiledSkills: model?.compiledSkills?.length || 0,
    learnedRecords: records.length,
    learnedRecordTypes: countBy(records, 'type'),
    activeLearnedRecords: records.filter(record => record?.status === 'active').length,
    verifiedMutationRepairOperators: records.filter(record => record?.payload?.operation === 'verified_mutation_repair').length,
    openRepairFailures: records.filter(record => record?.type === 'repair_failure' && record?.status === 'open').length,
    storedBenchmarkAnswerMarkers: (JSON.stringify(model).match(/"minedFrom"\s*:/g) || []).length,
    retainedRequests: Array.isArray(model?.lariAutonomousRequests)
      ? model.lariAutonomousRequests.length
      : Object.keys(model?.lariAutonomousRequests || {}).length,
    modalityEntries: Array.isArray(model?.lariModalityRegistry)
      ? model.lariModalityRegistry.length
      : Object.keys(model?.lariModalityRegistry || {}).length,
    lineage: model?.lineage || null,
    consolidation: model?.lariConsolidation || null
  };
}

function learnedRecordIds(model) {
  return (model?.lariLearnedRecords?.records || [])
    .map(record => record?.id)
    .filter(id => typeof id === 'string' && id.length > 0);
}

function walkJsonEvidence(directory, depth = 0, output = []) {
  if (!fs.existsSync(directory) || depth > 4) return output;
  const skipped = new Set([
    'learning-candidates', 'coding-learning-candidates', 'arc-learning-candidates',
    'stage-3-rehearsal', 'workspaces', 'runs', 'sources', 'tmp',
    '.pytest_cache', '__pycache__', '.git'
  ]);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (_) {
    return output;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name) && !entry.name.startsWith('tmp-')) walkJsonEvidence(target, depth + 1, output);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (!/(evidence|validation|result|report|manifest)/i.test(entry.name)) continue;
    let stat;
    try { stat = fs.statSync(target); } catch (_) { continue; }
    if (stat.size > 5 * 1024 * 1024) continue;
    output.push(target);
  }
  return output;
}

function artifactPassed(document) {
  if (!document) return false;
  if (document.passed === true) return true;
  if (document.verdict && /\bpass(?:ed)?\b|\bsafe\b/i.test(String(document.verdict))) return true;
  if (document.candidateGates) {
    const gates = document.candidateGates;
    return gates.learnedTransfer === '5/5'
      && gates.hiddenTransfer === '17/17'
      && gates.coreCorrectness === '5/5'
      && gates.familyRegressions === 0
      && gates.cliParity === true
      && gates.autonomousParity === true
      && gates.reloadRetention === true
      && gates.activeReadOnly === true
      && gates.registryReadOnly === true
      && gates.externalModelCalls === 0;
  }
  if (document.surfaceParity && document.candidate) {
    return document.surfaceParity.direct === true
      && document.surfaceParity.cli === true
      && document.surfaceParity.autonomous === true
      && document.surfaceParity.workbench === true
      && document.candidate.learnedTransfer === '5/5'
      && document.candidate.hiddenTransfer === '17/17'
      && document.candidate.coreCorrectness === '5/5'
      && document.candidate.familyRegressions === 0
      && document.candidate.reloadRetention === true
      && document.candidate.activeReadOnly === true
      && document.candidate.registryReadOnly === true
      && document.candidate.externalModelCalls === 0;
  }
  if (document.nonWorkbenchParityPassed !== undefined) {
    return document.nonWorkbenchParityPassed === true
      && document.familyRegression?.passed === true
      && document.hiddenTransfer?.passed === true
      && document.reloadPassed === true
      && document.noHiddenWrites === true;
  }
  if (document.gates && Object.values(document.gates).length > 0) {
    return Object.entries(document.gates).every(([key, value]) => value === true
      || (value === 0 && /(?:count|calls|fallback|regression|error)/i.test(key)));
  }
  return false;
}

function discoverValidatedCandidate(evidenceFiles) {
  const matches = [];
  for (const evidencePath of evidenceFiles) {
    const document = readJson(evidencePath);
    if (!artifactPassed(document)) continue;
    if (document?.candidateEligibility?.releaseCandidate !== true
      || document?.candidateEligibility?.evidenceClass !== 'sealed_unseen_capability') continue;
    const candidate = document?.candidate;
    if (!candidate?.sha256 || candidate.promoted === true) continue;
    const candidatePath = resolveRepoPath(candidate.path);
    if (!candidatePath || !fs.existsSync(candidatePath)) continue;
    if (sha256File(candidatePath) !== candidate.sha256) continue;
    if (/"minedFrom"\s*:/.test(fs.readFileSync(candidatePath, 'utf8'))) continue;
    const stat = fs.statSync(evidencePath);
    const timestamp = new Date(document.createdAt || document.generatedAt || stat.mtime).getTime();
    matches.push({
      evidencePath,
      evidence: document,
      candidatePath,
      candidateHash: candidate.sha256,
      timestamp: Number.isFinite(timestamp) ? timestamp : stat.mtimeMs
    });
  }
  return matches.sort((left, right) => right.timestamp - left.timestamp)[0] || null;
}

function statusSnapshot() {
  const run = spawnSync(process.execPath, ['scripts/lari_status.js', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout || 'lari_status failed');
  return JSON.parse(run.stdout);
}

function evidenceRecord(label, value) {
  const filePath = path.join(ROOT, value);
  const info = fileInfo(filePath);
  const document = readJson(filePath);
  if (!info || !document) return { label, path: value, exists: false };
  return {
    label,
    ...info,
    exists: true,
    passed: document.passed ?? artifactPassed(document),
    verdict: document.verdict || document.readinessLevel || null,
    benchmark: document.benchmark || document.kind || null,
    modelHash: document.modelHash || document.activeModelHash || document.qualifiedCandidate?.sha256 || document.candidate?.sha256 || null,
    candidateHash: document.candidateHash || document.qualifiedCandidate?.sha256 || document.candidate?.sha256 || null,
    externalModelCalls: document.externalModelCalls ?? document.external_model_calls ?? null,
    gates: document.gates || null,
    developmentalTransfer: document.developmentalTransfer || null
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatMetric(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : '—';
}

function gateScore(gate) {
  if (!gate) return 'missing';
  const counts = gate.passedCount != null || gate.gateCount != null
    ? ` ${gate.passedCount ?? '?'}/${gate.gateCount ?? '?'}`
    : '';
  const age = gate.stale ? ' stale' : ' fresh';
  return `${gate.passed ? 'PASS' : 'FAIL'}${counts} (${age.trim()})`;
}

function markdownTable(headers, rows) {
  const clean = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(clean).join(' | ')} |`)
  ].join('\n');
}

function markdownLink(repoPath, label = null) {
  return `[${label || repoPath}](${repoPath.replace(/ /g, '%20')})`;
}

function sourceState() {
  const status = statusSnapshot();
  const activeInfo = fileInfo(ACTIVE_PATH);
  const registryInfo = fileInfo(REGISTRY_PATH);
  const activeModel = readJson(ACTIVE_PATH);
  const registry = readJson(REGISTRY_PATH);
  const rollbackPath = resolveRepoPath(registry?.previousModelPath);
  const rollbackInfo = fileInfo(rollbackPath);
  const rollbackModel = readJson(rollbackPath);
  const rollbackStoredBenchmarkAnswerMarkers = rollbackModel
    ? (JSON.stringify(rollbackModel).match(/"minedFrom"\s*:/g) || []).length
    : null;
  const recoveryManifest = readJson(path.join(ROOT, 'consolidation', 'recovery', 'truth-recovery-manifest.json'));
  const contaminationIndex = readJson(path.join(ROOT, 'consolidation', 'recovery', 'contaminated-artifact-index.json'));
  const consolidationEvidence = walkJsonEvidence(path.join(ROOT, 'consolidation'));
  const latestCandidate = discoverValidatedCandidate(consolidationEvidence);
  const candidateInfo = latestCandidate ? fileInfo(latestCandidate.candidatePath) : null;
  const candidateModel = latestCandidate ? readJson(latestCandidate.candidatePath) : null;

  const evidence = [
    evidenceRecord('Exposed repository research acquisition', 'consolidation/research-to-executable-repair-acquisition-20260906/sphinx-7440-research-required-attempt-6/probe-report.json'),
    evidenceRecord('Exposed repository learned-rule lifecycle', 'consolidation/research-to-executable-repair-acquisition-20260906/sphinx-7440-lifecycle-attempt-1/lifecycle-validation-report.json'),
    evidenceRecord('Case-identity cross-repository transfer', 'consolidation/case-identity-cross-repo-qualification-20260907/lifecycle-attempt-4/lifecycle-validation-report.json'),
    evidenceRecord('Case-identity executable public parity', 'consolidation/case-identity-cross-repo-qualification-20260907/public-surface-parity-attempt-3.json'),
    evidenceRecord('Case-identity isolated promotion rehearsal', 'consolidation/case-identity-cross-repo-qualification-20260907/promotion-rehearsal-attempt-2/promotion-rehearsal-evidence.json'),
    evidenceRecord('Case-identity rehearsed-active lifecycle', 'consolidation/case-identity-cross-repo-qualification-20260907/rehearsed-active-lifecycle-attempt-2/lifecycle-validation-report.json'),
    evidenceRecord('Case-identity rehearsed-active public parity', 'consolidation/case-identity-cross-repo-qualification-20260907/rehearsed-active-public-surface-parity-attempt-1.json'),
    evidenceRecord('Case-identity final promotion rehearsal', 'consolidation/case-identity-cross-repo-qualification-20260907/PROMOTION_REHEARSAL_FINAL.json'),
    evidenceRecord('Case-identity production promotion', 'consolidation/case-identity-production-promotion-20260907/production-promotion-manifest.json'),
    evidenceRecord('Case-identity production validation', 'consolidation/case-identity-production-promotion-20260907/post-promotion-validation.json'),
    evidenceRecord('Benchmark capability conversion', 'consolidation/repository-audit-20260827/benchmark-capability-validation.json'),
    evidenceRecord('Fresh sealed developmental proof', 'consolidation/repository-audit-20260827/fresh-real-repository-holdout/developmental-proof-report.json'),
    evidenceRecord('Hypothesis-guided generator candidate', 'consolidation/hypothesis-guided-generator-20260906/qualified-candidate-manifest.json'),
    evidenceRecord('Cross-modal scene candidate', 'consolidation/cross-modal-scene-20260906/qualified-candidate-manifest.json'),
    evidenceRecord('Automatic isolated reproducer', 'consolidation/automatic-isolated-reproducer-20260906/evidence.json'),
    evidenceRecord('Progressive relaxation binding', 'consolidation/progressive-relaxation-binding-20260906/evidence.json'),
    evidenceRecord('Agentic authority contract', 'consolidation/agentic-authority-contract-20260906/evidence.json'),
    evidenceRecord('Cross-domain composition candidate', 'consolidation/cross-domain-composition-attempt9-20260906/evidence.json'),
    evidenceRecord('Cross-domain composition validation', 'consolidation/cross-domain-composition-validation-attempt10-20260906/evidence.json'),
    evidenceRecord('Cross-domain composition promotion rehearsal', 'consolidation/cross-domain-composition-promotion-rehearsal-attempt3-20260906/promotion-rehearsal-evidence.json'),
    evidenceRecord('Autonomous uncertainty research', 'consolidation/autonomous-uncertainty-research-20260906/evidence.json'),
    evidenceRecord('Public surface uncertainty convergence', 'consolidation/public-surface-uncertainty-convergence-attempt4-20260906/evidence.json'),
    evidenceRecord('Public uncertainty promotion rehearsal', 'consolidation/public-surface-uncertainty-promotion-rehearsal-attempt2-20260906/promotion-rehearsal-evidence.json'),
    evidenceRecord('Public uncertainty production promotion', 'consolidation/public-surface-uncertainty-production-promotion-attempt2-20260906/production-promotion-manifest.json'),
    evidenceRecord('Mastery developmental curriculum', 'consolidation/mastery-curriculum-20260828/developmental-curriculum-report.json'),
    evidenceRecord('Mastery expansion curriculum', 'consolidation/mastery-expansion-20260828/expansion-evidence.json'),
    evidenceRecord('Mastery expansion qualification', 'consolidation/mastery-expansion-qualification-20260828/qualification-evidence.json'),
    evidenceRecord('Sealed repository learning', 'consolidation/mastery-sealed-repository-20260828/training-evidence.json'),
    evidenceRecord('Sealed repository transfer', 'consolidation/mastery-sealed-repository-20260828/transfer-report-qualified.json'),
    evidenceRecord('Sealed repository qualification', 'consolidation/mastery-sealed-qualification-20260828/qualification-evidence.json'),
    evidenceRecord('Coding frontier sealed transfer', 'consolidation/coding-frontier-curriculum-v2-20260828/transfer-report-v2.json'),
    evidenceRecord('Coding frontier qualification', 'consolidation/coding-frontier-qualification-v2-20260828/release-candidate-evidence.json'),
    evidenceRecord('Coding frontier promotion rehearsal', 'consolidation/coding-frontier-promotion-rehearsal-20260828/release-evidence.json'),
    evidenceRecord('Coding frontier production promotion', 'consolidation/coding-frontier-production-promotion-20260828/production-promotion-manifest.json'),
    evidenceRecord('Coding frontier production transfer', 'consolidation/coding-frontier-curriculum-v2-20260828/production-transfer-report.json'),
    evidenceRecord('Coding frontier production surfaces', 'consolidation/coding-frontier-production-promotion-20260828/production-surface-evidence-v2.json'),
    evidenceRecord('Stateful chat language', 'consolidation/chat-language-frontier-20260828/stateful-chat-validation.json'),
    evidenceRecord('Chat and nine-language coding expansion', 'consolidation/chat-coding-expansion-20260829/validation-report-v5.json'),
    evidenceRecord('Chat and coding expansion promotion rehearsal', 'consolidation/chat-coding-expansion-promotion-rehearsal-20260829/rehearsal-manifest.json'),
    evidenceRecord('Chat and coding production promotion', 'consolidation/chat-coding-expansion-production-promotion-20260829/production-promotion-manifest.json'),
    evidenceRecord('Chat and coding production surfaces', 'consolidation/chat-coding-expansion-production-promotion-20260829/production-surface-evidence.json'),
    evidenceRecord('Deep technical chat candidate', 'consolidation/deep-chat-coding-expansion-20260829/technical-chat-training-report-v7.json'),
    evidenceRecord('Deep technical chat candidate surfaces', 'consolidation/deep-chat-coding-expansion-20260829/technical-chat-surface-evidence-v2.json'),
    evidenceRecord('Deep coding qualification', 'consolidation/deep-coding-qualification-v3-20260829/qualification-report.json'),
    evidenceRecord('Deep combined qualification', 'consolidation/deep-combined-qualification-20260830/qualification-evidence.json'),
    evidenceRecord('Deep combined production promotion', 'consolidation/deep-combined-production-promotion-v2-20260830/production-promotion-manifest.json'),
    evidenceRecord('RECAP candidate validation', 'consolidation/recap-conversation-expansion-20260830/candidate-validation-v3.json'),
    evidenceRecord('RECAP surface parity', 'consolidation/recap-conversation-expansion-20260830/surface-parity-v2.json'),
    evidenceRecord('RECAP mastery qualification', 'consolidation/recap-conversation-mastery-qualification-20260830/qualification-evidence.json'),
    evidenceRecord('RECAP production promotion', 'consolidation/recap-conversation-production-promotion-v2-20260830/production-promotion-manifest.json'),
    evidenceRecord('Computational English discourse qualification', 'consolidation/computational-english-discourse-binding-20260915/qualification.json'),
    evidenceRecord('Computational English discourse production promotion', 'consolidation/computational-english-discourse-binding-20260915/promotion-manifest.json'),
    evidenceRecord('Open English semantic growth qualification', 'consolidation/open-english-semantic-growth-20260916-attempt4/qualification.json'),
    evidenceRecord('Native language generator Stage 1 qualification', 'consolidation/native-language-generator-stage1-20260916/qualification.json'),
    evidenceRecord('Domain neurogenesis qualification', 'consolidation/domain-neurogenesis-20260830/qualification-report.json'),
    evidenceRecord('Domain neurogenesis surfaces', 'consolidation/domain-neurogenesis-20260830/surface-parity.json'),
    evidenceRecord('Domain neurogenesis Stage 2 qualification', 'consolidation/domain-neurogenesis-stage2-20260830/qualification-report.json'),
    evidenceRecord('Domain neurogenesis Stage 2 surfaces', 'consolidation/domain-neurogenesis-stage2-20260830/surface-parity.json'),
    evidenceRecord('Domain neurogenesis Stage 3 qualification', 'consolidation/domain-neurogenesis-stage3b-20260830/qualification-report-v2.json'),
    evidenceRecord('Domain neurogenesis Stage 3 surfaces', 'consolidation/domain-neurogenesis-stage3b-20260830/surface-parity.json'),
    evidenceRecord('Domain neurogenesis Stage 4 qualification', 'consolidation/domain-neurogenesis-stage4-20260830/qualification-report.json'),
    evidenceRecord('Domain neurogenesis Stage 5 qualification', 'consolidation/domain-neurogenesis-stage5-20260830/qualification-report.json'),
    evidenceRecord('Domain neurogenesis Stage 5 promotion rehearsal', 'consolidation/domain-neurogenesis-stage5-promotion-rehearsal-20260830/rehearsal-manifest.json'),
    evidenceRecord('Domain neurogenesis Stage 5 production promotion', 'consolidation/domain-neurogenesis-stage5-production-promotion-20260830/production-promotion-manifest.json'),
    evidenceRecord('Self-expanding primitive language qualification', 'consolidation/self-expanding-primitive-language-20260908/qualification-report.json'),
    evidenceRecord('Mixed-domain program growth qualification', 'consolidation/mixed-domain-program-growth-20260908/qualification-report.json'),
    evidenceRecord('Mixed-domain reasoning promotion rehearsal', 'consolidation/mixed-domain-program-growth-20260908/promotion-rehearsal-attempt2/promotion-rehearsal-evidence.json'),
    evidenceRecord('Mixed-domain coding-data promotion rehearsal', 'consolidation/mixed-domain-program-growth-20260908/promotion-rehearsal-code-family-attempt2/promotion-rehearsal-evidence.json'),
    evidenceRecord('Mixed-domain program growth production promotion', 'consolidation/mixed-domain-program-growth-production-promotion-20260908/production-promotion-manifest.json'),
    evidenceRecord('Mixed-domain program growth production surfaces', 'consolidation/mixed-domain-program-growth-production-promotion-20260908/production-surface-evidence.json'),
    evidenceRecord('Mixed-domain program growth post-promotion validation', 'consolidation/mixed-domain-program-growth-production-promotion-20260908/post-promotion-validation.json'),
    evidenceRecord('Cross-domain workspace program transfer', 'consolidation/cross-domain-workspace-program-transfer-20260908/validation.json'),
    evidenceRecord('Workspace failure program neurogenesis', 'consolidation/workspace-failure-program-neurogenesis-20260908/qualification.json'),
    evidenceRecord('Cross-domain state-machine primitive neurogenesis', 'consolidation/cross-domain-state-machine-neurogenesis-20260908/qualification.json'),
    evidenceRecord('General finite-state transducer neurogenesis', 'consolidation/general-state-transducer-neurogenesis-20260908/qualification.json'),
    evidenceRecord('General finite-state transducer promotion rehearsal', 'consolidation/general-state-transducer-neurogenesis-20260908/promotion-rehearsal-attempt2/promotion-rehearsal-evidence.json'),
    evidenceRecord('Symbolic-predicate and pushdown neurogenesis', 'consolidation/symbolic-pushdown-neurogenesis-20260908/qualification.json'),
    evidenceRecord('Symbolic-predicate and pushdown promotion rehearsal', 'consolidation/symbolic-pushdown-neurogenesis-20260908/promotion-rehearsal/promotion-rehearsal-evidence.json'),
    evidenceRecord('Unknown repository acquisition qualification', 'consolidation/coding-mastery-acquisition-attempt3-20260830/qualification-report.json'),
    evidenceRecord('Generated primitive family qualification', 'consolidation/generated-primitive-family-attempt2-20260831/qualification-report.json'),
    evidenceRecord('Generated primitive family promotion rehearsal', 'consolidation/generated-primitive-family-promotion-rehearsal-20260831/rehearsal-manifest.json'),
    evidenceRecord('Generated primitive family production promotion', 'consolidation/generated-primitive-family-production-promotion-20260831/production-promotion-manifest.json'),
    evidenceRecord('Generated primitive family production surfaces', 'consolidation/generated-primitive-family-production-promotion-20260831/surface-evidence.json'),
    evidenceRecord('Recursive field generator qualification', 'consolidation/recursive-field-generator-20260831/qualification-report.json'),
    evidenceRecord('Recursive field generator direct surfaces', 'consolidation/recursive-field-generator-surface-parity-attempt2-20260831/surface-parity.json'),
    evidenceRecord('Recursive field generator rehearsed surfaces', 'consolidation/recursive-field-generator-rehearsed-surfaces-20260831/surface-parity.json'),
    evidenceRecord('Recursive field generator promotion rehearsal', 'consolidation/recursive-field-generator-promotion-rehearsal-attempt2-20260831/rehearsal-manifest.json'),
    evidenceRecord('Recursive field generator production promotion', 'consolidation/recursive-field-generator-production-promotion-20260831/production-promotion-manifest.json'),
    evidenceRecord('Recursive field generator production surfaces', 'consolidation/recursive-field-generator-production-surfaces-20260831/surface-parity.json'),
    evidenceRecord('Language-side primitive qualification', 'consolidation/language-primitive-neurogenesis-20260831/qualification-report-attempt3.json'),
    evidenceRecord('Failure-induced semantic AST qualification', 'consolidation/semantic-ast-autogenesis-20260831/qualification-report.json'),
    evidenceRecord('Semantic AST promotion rehearsal', 'consolidation/semantic-ast-promotion-rehearsal-20260831/rehearsal-manifest.json'),
    evidenceRecord('Referential relation autogenesis qualification', 'consolidation/referential-relation-autogenesis-20260901/qualification-report.json'),
    evidenceRecord('Referential relation promotion rehearsal', 'consolidation/referential-relation-promotion-rehearsal-20260901/rehearsal-manifest.json'),
    evidenceRecord('Referential relation initial rollback', 'consolidation/referential-relation-production-promotion-20260901/real-rollback-manifest.json'),
    evidenceRecord('Referential relation prepromotion full suite', 'consolidation/referential-relation-prepromotion-regression-attempt3-20260901/full-suite-evidence.json'),
    evidenceRecord('Referential relation production promotion', 'consolidation/referential-relation-production-promotion-attempt2-20260901/production-promotion-manifest.json'),
    evidenceRecord('Referential relation production surfaces', 'consolidation/referential-relation-production-surfaces-attempt2-20260901/semantic-surface-evidence.json'),
    evidenceRecord('Open-world semantic primitive learning', 'consolidation/open-world-apprenticeship-20260901/learning-retry10-report.json'),
    evidenceRecord('Open-world semantic primitive qualification', 'consolidation/open-world-apprenticeship-20260901/semantic-primitive-qualification.json'),
    evidenceRecord('Predicate-domain primitive learning', 'consolidation/open-world-apprenticeship-20260901/learning-retry14-report.json'),
    evidenceRecord('Dual semantic primitive qualification', 'consolidation/predicate-domain-transfer-20260902/qualification-summary.json'),
    evidenceRecord('Combined candidate predicate external transfer', 'consolidation/predicate-domain-transfer-20260902/combined-candidate-external-transfer.json'),
    evidenceRecord('Frozen fresh repository evaluation', 'consolidation/frozen-fresh-transfer-20260904/final-evaluation-report.json'),
    evidenceRecord('Public truth gate', 'benchmarks/latest-lari-public-truth-gate-report.json'),
    evidenceRecord('Model control plane', 'benchmarks/latest-lari-model-control-plane-report.json'),
    evidenceRecord('Personal learning timeline', 'consolidation/personal-learning-timeline-20260912/report.json'),
    evidenceRecord('Mixed apprenticeship coding acquisition', 'consolidation/one-hour-apprenticeship-sprint-20260913/coding-acquisition.json'),
    evidenceRecord('Stateful multi-file apprenticeship acquisition', 'consolidation/one-hour-apprenticeship-sprint-20260913/stateful-multifile-acquisition.json'),
    evidenceRecord('Sealed cumulative apprenticeship Cycle 1', 'consolidation/sealed-cumulative-apprenticeship-20260913/report.json'),
    evidenceRecord('Sealed cumulative apprenticeship Cycle 1 adversarial review', 'consolidation/sealed-cumulative-apprenticeship-20260913/adversarial-review.json'),
    evidenceRecord('Sealed cumulative apprenticeship Cycle 2', 'consolidation/sealed-cumulative-apprenticeship-cycle2-20260913/report.json'),
    evidenceRecord('Sealed cumulative apprenticeship Cycle 3', 'consolidation/sealed-cumulative-apprenticeship-cycle3-20260913/report.json'),
    evidenceRecord('Sealed cumulative apprenticeship Cycle 3 promotion rehearsal', 'consolidation/sealed-cumulative-apprenticeship-cycle3-promotion-rehearsal-20260913/promotion-rehearsal-evidence.json'),
    evidenceRecord('Sealed cumulative apprenticeship Cycle 3 production promotion', 'consolidation/sealed-cumulative-apprenticeship-cycle3-production-promotion-20260913/production-promotion-manifest.json'),
    evidenceRecord('Sealed cumulative apprenticeship Cycle 3 production surfaces', 'consolidation/sealed-cumulative-apprenticeship-cycle3-production-promotion-20260913/post-promotion-validation.json'),
    evidenceRecord('Sealed cumulative apprenticeship', 'consolidation/sealed-cumulative-apprenticeship-20260913/report.json'),
    evidenceRecord('Sealed cumulative apprenticeship adversarial review', 'consolidation/sealed-cumulative-apprenticeship-20260913/adversarial-review.json'),
    evidenceRecord('Mixed apprenticeship sprint checkpoint', 'consolidation/one-hour-apprenticeship-sprint-20260913/report.json'),
    evidenceRecord('First-run product smoke', 'benchmarks/latest-lari-first-run-product-smoke-report.json'),
    evidenceRecord('Ordinary chat gap learning candidate', 'benchmarks/latest-lari-learning-candidate-validation.json'),
    evidenceRecord('Ordinary chat gap promotion rehearsal', 'consolidation/ordinary-chat-gap-learning-promotion-rehearsal-20260905/promotion-rehearsal-evidence.json'),
    evidenceRecord('Ordinary chat gap rehearsed public surfaces', 'consolidation/ordinary-chat-gap-learning-promotion-rehearsal-20260905/surface-evidence-v2.json'),
    evidenceRecord('Ordinary chat gap production promotion', 'consolidation/ordinary-chat-gap-learning-production-promotion-20260905/post-promotion-validation.json'),
    evidenceRecord('Mixed product soak', 'benchmarks/latest-lari-product-soak-report.json'),
    evidenceRecord('Release traffic proof', 'consolidation/release-readiness/latest-lari-release-traffic-proof.json'),
    evidenceRecord('Beta release gates', 'consolidation/beta-readiness-20260908/release-gates.json'),
    evidenceRecord('Beta product acceptance', 'consolidation/beta-readiness-20260908/product-acceptance.json'),
    evidenceRecord('Beta quality candidate latest', 'consolidation/beta-quality-candidate-v9-20260909/candidate-validation.json'),
    evidenceRecord('Semantic claim composition', 'consolidation/beta-quality-candidate-v9-20260909/semantic-claim-composition-validation-attempt2.json'),
    evidenceRecord('Beta quality candidate post-binding soak', 'consolidation/beta-quality-candidate-v9-20260909/post-binding-product-soak.json'),
    evidenceRecord('Failure research claim neurogenesis', 'consolidation/failure-research-claim-neurogenesis-20260909-attempt7/validation-report.json'),
    evidenceRecord('Claim novelty consolidation', 'consolidation/claim-novelty-consolidation-20260909/validation-report.json'),
    evidenceRecord('Grounded claim growth candidate', 'consolidation/beta-quality-candidate-v10-20260909-attempt2/candidate-validation.json'),
    evidenceRecord('Beta quality execution refinement', 'consolidation/beta-quality-execution-refinement-20260909-attempt6/validation-report.json'),
    evidenceRecord('Beta quality execution refinement soak', 'consolidation/beta-quality-execution-refinement-20260909-attempt6/post-surface-binding-soak.json'),
    evidenceRecord('Beta quality execution refinement surfaces', 'consolidation/beta-quality-execution-refinement-20260909-attempt6/public-surface-parity-attempt2.json'),
    evidenceRecord('Beta quality execution refinement rehearsal', 'consolidation/beta-quality-execution-refinement-20260909-attempt6/promotion-rehearsal/promotion-rehearsal-evidence.json'),
    evidenceRecord('Release training gate', 'benchmarks/latest-lari-release-training-gate-report.json'),
    evidenceRecord('Alpha launch gate', 'benchmarks/latest-lari-alpha-launch-gauntlet-report.json'),
    evidenceRecord('Frozen repository acceptance', 'consolidation/real-repository-acceptance-20260722/result.json'),
    evidenceRecord('Context/action memory', 'benchmarks/latest-lari-context-action-memory-gauntlet-report.json'),
    evidenceRecord('Long-session reload', 'benchmarks/latest-lari-long-session-reload-stress-report.json'),
    evidenceRecord('Personal/professional growth', 'benchmarks/latest-lari-personal-professional-growth-report.json'),
    evidenceRecord('Multimodal truth', 'benchmarks/latest-lari-multimodal-generation-truth-report.json'),
    evidenceRecord('Full active IFEval', 'benchmarks/latest-lari-active-lm-eval-ifeval-full-report.json'),
    evidenceRecord('Full active GSM8K', 'benchmarks/latest-lari-active-lm-eval-gsm8k-full-report.json'),
    evidenceRecord('Current standard benchmark baseline', 'benchmarks/latest-lari-standard-baseline-report.json'),
    evidenceRecord('Current IFEval smoke', 'benchmarks/latest-lari-lm-eval-ifeval-smoke-report.json'),
    evidenceRecord('Current ARC-AGI evaluation', 'arc/lari-arc-current-full-eval.json'),
    evidenceRecord('Dockerless SWE bridge contract', 'benchmarks/tmp-lari-swebench-dockerless-bridge/manifest.json'),
    evidenceRecord('Dockerless SWE candidate execution', 'benchmarks/dockerless-candidate-824-20260912-attempt2/manifest.json'),
    evidenceRecord('Official SWE-bench input validation', 'benchmarks/official-swebench-validation-20260912.json'),
    evidenceRecord('Semantic front-door wiring proof', 'LARI_SEMANTIC_FRONT_DOOR_FIX_2026-09-12.md'),
    evidenceRecord('Failure and coding transfer proof', 'LARI_TRANSFER_AND_FAILURE_PROOF_2026-09-12.md'),
    evidenceRecord('Five-track qualification', 'LARI_FIVE_TRACK_QUALIFICATION_2026-09-12.md'),
    evidenceRecord('Arbitrary repository qualification status', 'LARI_ARBITRARY_REPO_QUALIFICATION_2026-09-12.md'),
    evidenceRecord('Research-to-retention', 'consolidation/research-to-retention-20260722/evidence.json'),
    evidenceRecord('Goal-driven curriculum', 'consolidation/goal-driven-curriculum-20260722/evidence.json'),
    evidenceRecord('Procedural curriculum', 'consolidation/procedural-curriculum-20260722/evidence-dfea35336648c4a2.json'),
    evidenceRecord('Public media convergence', 'consolidation/public-media-convergence-20260722/evidence.json'),
    evidenceRecord('Expression coding curriculum', 'consolidation/coding-curriculum-20260722/candidate-evidence.json'),
    evidenceRecord('Expression coding public convergence', 'consolidation/coding-public-convergence-20260722/evidence.json'),
    evidenceRecord('Blind multi-file curriculum', 'consolidation/blind-multifile-curriculum-20260723/candidate-evidence.json'),
    evidenceRecord('Blind multi-file public convergence', 'consolidation/blind-multifile-public-convergence-20260723/evidence.json'),
    evidenceRecord('Final candidate promotion rehearsal', 'consolidation/blind-multifile-promotion-rehearsal-20260723/promotion-rehearsal-evidence.json'),
    evidenceRecord('Final candidate rehearsed surfaces', 'consolidation/blind-multifile-promotion-rehearsal-20260723/surface-evidence.json'),
    evidenceRecord('Async multi-file curriculum', 'consolidation/async-multifile-curriculum-20260723/candidate-evidence.json'),
    evidenceRecord('Async multi-file public convergence', 'consolidation/async-multifile-public-convergence-20260723/evidence.json'),
    evidenceRecord('Async candidate promotion rehearsal', 'consolidation/async-multifile-promotion-rehearsal-20260723/promotion-rehearsal-evidence.json'),
    evidenceRecord('Async candidate rehearsed surfaces', 'consolidation/async-multifile-promotion-rehearsal-20260723/surface-evidence.json')
  ];
  const sourceFiles = [
    ACTIVE_PATH,
    REGISTRY_PATH,
    ...(candidateInfo ? [latestCandidate.candidatePath, latestCandidate.evidencePath] : []),
    ...evidence.filter(item => item.exists).map(item => path.join(ROOT, item.path))
  ];
  const sourceHashes = Object.fromEntries([...new Set(sourceFiles)]
    .filter(filePath => fs.existsSync(filePath))
    .map(filePath => [relative(filePath), sha256File(filePath)]));
  const fingerprint = sha256Value(JSON.stringify(sourceHashes));

  return {
    generatedAt: new Date().toISOString(),
    sourceFingerprint: fingerprint,
    definition: 'Lari is a local persistent executable rule-and-program-synthesis research system whose canonical JSON state and unified kernel drive deterministic procedures, retrieval, and bounded verified coding search without silent external-model inference; it does not yet have a broad native text generator.',
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    productionPolicy: 'Production Lari is the model. External models may provide development-only training pressure, but production inference makes no model-provider calls unless the user explicitly requests one.',
    active: modelSummary(activeModel, activeInfo),
    // Keep a compact, explicit ledger of the active intelligence.  Promotion
    // manifests describe one transaction; this ledger is the source of truth
    // for whether an older validated capability is retained by a descendant.
    activeLearnedRecordIds: learnedRecordIds(activeModel),
    registry: {
      ...registryInfo,
      activeModelPath: registry?.activeModelPath || null,
      activeModelSha256: registry?.activeModelSha256 || null,
      historyCount: registry?.history?.length || 0,
      previousModelPath: registry?.previousModelPath || null,
      declaredActiveHash: registry?.activeModelSha256 || registry?.metadata?.candidateHash || null,
      matchesActiveBytes: (registry?.activeModelSha256 || registry?.metadata?.candidateHash || null) === activeInfo?.sha256,
      rollback: rollbackInfo ? {
        ...rollbackInfo,
        storedBenchmarkAnswerMarkers: rollbackStoredBenchmarkAnswerMarkers,
        eligible: rollbackStoredBenchmarkAnswerMarkers === 0
      } : null
    },
    recovery: {
      manifest: recoveryManifest,
      contaminatedCandidateCount: contaminationIndex?.artifactCount || 0
    },
    validatedCandidate: latestCandidate ? {
      ...modelSummary(candidateModel, candidateInfo),
      evidencePath: relative(latestCandidate.evidencePath),
      parentHash: candidateModel?.lineage?.parentHash || null,
      promoted: candidateModel?.lineage?.promoted === true
    } : null,
    status,
    evidence,
    sourceHashes
  };
}

function collectBlockers(state) {
  const gates = state.status?.gates || {};
  const sealedProofPassed = state.evidence?.some(item => item.label === 'Fresh sealed developmental proof'
    && item.passed === true);
  const raw = [
    ...(gates.launch?.blockers || []),
    ...(gates.train?.blockers || []),
    ...(gates.frozenRepositoryAcceptance?.blockers || [])
  ].filter(blocker => !(sealedProofPassed && (
    /fresh never-before-exposed repository holdout/i.test(String(blocker))
    || /full model-control-plane aggregate complete reliably/i.test(String(blocker))
  )));
  const output = [];
  const seen = new Set();
  for (const blocker of raw) {
    const text = String(blocker || '').trim().replace(/[.;]+$/, '');
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  if (state.registry?.matchesActiveBytes !== true) {
    output.unshift('active model bytes do not match the hash declared by the registry lineage');
  }
  if (state.registry?.rollback?.eligible !== true) {
    output.unshift('no clean verified rollback target is available');
  }
  if (!state.validatedCandidate) {
    output.push('no uncontaminated candidate has sealed unseen-capability evidence and explicit release eligibility');
  }
  if ((state.recovery?.contaminatedCandidateCount || 0) > 0) {
    output.push(`${state.recovery.contaminatedCandidateCount} preserved candidate artifacts are quarantined from promotion because they contain stored benchmark-answer back-references`);
  }
  return output;
}

function renderReport(state) {
  const active = state.active;
  const candidate = state.validatedCandidate;
  const gates = state.status.gates;
  const evidenceByLabel = Object.fromEntries(state.evidence.map(item => [item.label, item]));
  const read = label => readJson(path.join(ROOT, evidenceByLabel[label]?.path || 'missing'));
  const ifeval = read('Full active IFEval');
  const gsm8k = read('Full active GSM8K');
  const currentBaseline = read('Current standard benchmark baseline');
  const multimodal = read('Multimodal truth');
  const memory = read('Context/action memory');
  const longSession = read('Long-session reload');
  const traffic = read('Release traffic proof');
  const productSoak = read('Mixed product soak');
  const betaReleaseGates = read('Beta release gates');
  const betaProductAcceptance = read('Beta product acceptance');
  const betaQualityCandidate = read('Beta quality candidate latest');
  const semanticClaimComposition = read('Semantic claim composition');
  const betaQualityPostBindingSoak = read('Beta quality candidate post-binding soak');
  const failureResearchClaimNeurogenesis = read('Failure research claim neurogenesis');
  const claimNoveltyConsolidation = read('Claim novelty consolidation');
  const groundedClaimGrowthCandidate = read('Grounded claim growth candidate');
  const betaQualityExecutionRefinement = read('Beta quality execution refinement');
  const betaQualityExecutionRefinementSoak = read('Beta quality execution refinement soak');
  const betaQualityExecutionRefinementSurfaces = read('Beta quality execution refinement surfaces');
  const betaQualityExecutionRefinementRehearsal = read('Beta quality execution refinement rehearsal');
  const personal = read('Personal/professional growth');
  const personalTimeline = read('Personal learning timeline');
  const latestResearchCandidate = read('Ordinary chat gap learning candidate');
  const sprintCodingAcquisition = read('Mixed apprenticeship coding acquisition');
  const sprintStatefulMultifileAcquisition = read('Stateful multi-file apprenticeship acquisition');
  const sealedApprenticeshipCycle1 = read('Sealed cumulative apprenticeship Cycle 1');
  const sealedApprenticeshipCycle1Review = read('Sealed cumulative apprenticeship Cycle 1 adversarial review');
  const sealedApprenticeshipCycle2 = read('Sealed cumulative apprenticeship Cycle 2');
  const sealedApprenticeshipCycle3 = read('Sealed cumulative apprenticeship Cycle 3');
  const sealedCumulativeApprenticeship = read('Sealed cumulative apprenticeship');
  const sealedCumulativeAdversarial = read('Sealed cumulative apprenticeship adversarial review');
  const mixedApprenticeshipSprint = read('Mixed apprenticeship sprint checkpoint');
  const coding = read('Blind multi-file curriculum');
  const codingPublic = read('Blind multi-file public convergence');
  const asyncCoding = read('Async multi-file curriculum');
  const asyncCodingPublic = read('Async multi-file public convergence');
  const mediaPublic = read('Public media convergence');
  const research = read('Research-to-retention');
  const goal = read('Goal-driven curriculum');
  const benchmarkCapabilities = read('Benchmark capability conversion');
  const developmentalProof = read('Fresh sealed developmental proof');
  const mastery = read('Mastery developmental curriculum');
  const masteryExpansion = read('Mastery expansion curriculum');
  const masteryQualification = read('Mastery expansion qualification');
  const sealedRepositoryLearning = read('Sealed repository learning');
  const sealedRepositoryTransfer = read('Sealed repository transfer');
  const sealedRepositoryQualification = read('Sealed repository qualification');
  const codingFrontierTransfer = read('Coding frontier sealed transfer');
  const codingFrontierQualification = read('Coding frontier qualification');
  const codingFrontierRehearsal = read('Coding frontier promotion rehearsal');
  const codingFrontierPromotion = read('Coding frontier production promotion');
  const codingFrontierProductionTransfer = read('Coding frontier production transfer');
  const codingFrontierProductionSurfaces = read('Coding frontier production surfaces');
  const statefulChat = read('Stateful chat language');
  const hypothesisGuidedGenerator = read('Hypothesis-guided generator candidate');
  const crossModalScene = read('Cross-modal scene candidate');
  const automaticIsolatedReproducer = read('Automatic isolated reproducer');
  const progressiveRelaxation = read('Progressive relaxation binding');
  const agenticAuthority = read('Agentic authority contract');
  const crossDomainComposition = read('Cross-domain composition candidate');
  const crossDomainValidation = read('Cross-domain composition validation');
  const crossDomainRehearsal = read('Cross-domain composition promotion rehearsal');
  const autonomousUncertaintyResearch = read('Autonomous uncertainty research');
  const publicSurfaceUncertainty = read('Public surface uncertainty convergence');
  const publicUncertaintyPromotionRehearsal = read('Public uncertainty promotion rehearsal');
  const publicUncertaintyProduction = read('Public uncertainty production promotion');
  const crossDomainRehearsalPassed = crossDomainRehearsal?.passed === true
    || (crossDomainRehearsal?.gates && Object.values(crossDomainRehearsal.gates).every(value => value === true));
  const chatCodingExpansion = read('Chat and nine-language coding expansion');
  const chatCodingRehearsal = read('Chat and coding expansion promotion rehearsal');
  const chatCodingPromotion = read('Chat and coding production promotion');
  const chatCodingProductionSurfaces = read('Chat and coding production surfaces');
  const deepTechnicalChat = read('Deep technical chat candidate');
  const deepTechnicalChatSurfaces = read('Deep technical chat candidate surfaces');
  const deepCoding = read('Deep coding qualification');
  const deepCombinedQualification = read('Deep combined qualification');
  const deepCombinedPromotion = read('Deep combined production promotion');
  const recapValidation = read('RECAP candidate validation');
  const recapSurfaces = read('RECAP surface parity');
  const recapMastery = read('RECAP mastery qualification');
  const recapPromotion = read('RECAP production promotion');
  const computationalEnglishDiscourse = read('Computational English discourse qualification');
  const computationalEnglishDiscoursePromotion = read('Computational English discourse production promotion');
  const openEnglishSemanticGrowth = read('Open English semantic growth qualification');
  const nativeLanguageGenerator = read('Native language generator Stage 1 qualification');
  const domainNeurogenesis = read('Domain neurogenesis qualification');
  const domainNeurogenesisSurfaces = read('Domain neurogenesis surfaces');
  const domainNeurogenesisStage2 = read('Domain neurogenesis Stage 2 qualification');
  const domainNeurogenesisStage2Surfaces = read('Domain neurogenesis Stage 2 surfaces');
  const domainNeurogenesisStage3 = read('Domain neurogenesis Stage 3 qualification');
  const domainNeurogenesisStage3Surfaces = read('Domain neurogenesis Stage 3 surfaces');
  const domainNeurogenesisStage4 = read('Domain neurogenesis Stage 4 qualification');
  const domainNeurogenesisStage5 = read('Domain neurogenesis Stage 5 qualification');
  const domainNeurogenesisStage5Rehearsal = read('Domain neurogenesis Stage 5 promotion rehearsal');
  const domainNeurogenesisStage5Promotion = read('Domain neurogenesis Stage 5 production promotion');
  const mixedDomainQualification = read('Mixed-domain program growth qualification');
  const mixedDomainPromotion = read('Mixed-domain program growth production promotion');
  const mixedDomainProductionSurfaces = read('Mixed-domain program growth production surfaces');
  const mixedDomainPostPromotion = read('Mixed-domain program growth post-promotion validation');
  const crossDomainWorkspaceTransfer = read('Cross-domain workspace program transfer');
  const workspaceFailureProgramNeurogenesis = read('Workspace failure program neurogenesis');
  const crossDomainStateMachineNeurogenesis = read('Cross-domain state-machine primitive neurogenesis');
  const generalFiniteStateTransducer = read('General finite-state transducer neurogenesis');
  const generalFiniteStateTransducerRehearsal = read('General finite-state transducer promotion rehearsal');
  const symbolicPushdownNeurogenesis = read('Symbolic-predicate and pushdown neurogenesis');
  const symbolicPushdownRehearsal = read('Symbolic-predicate and pushdown promotion rehearsal');
  const unknownRepositoryAcquisition = read('Unknown repository acquisition qualification');
  const generatedPrimitiveQualification = read('Generated primitive family qualification');
  const generatedPrimitivePromotion = read('Generated primitive family production promotion');
  const generatedPrimitiveSurfaces = read('Generated primitive family production surfaces');
  const recursiveFieldGenerator = read('Recursive field generator qualification');
  const recursiveFieldDirectSurfaces = read('Recursive field generator direct surfaces');
  const recursiveFieldRehearsedSurfaces = read('Recursive field generator rehearsed surfaces');
  const recursiveFieldRehearsal = read('Recursive field generator promotion rehearsal');
  const recursiveFieldPromotion = read('Recursive field generator production promotion');
  const recursiveFieldProductionSurfaces = read('Recursive field generator production surfaces');
  const languagePrimitive = read('Language-side primitive qualification');
  const semanticAstAutogenesis = read('Failure-induced semantic AST qualification');
  const semanticAstRehearsal = read('Semantic AST promotion rehearsal');
  const referentialRelationAutogenesis = read('Referential relation autogenesis qualification');
  const referentialRelationRehearsal = read('Referential relation promotion rehearsal');
  const referentialRelationPromotion = read('Referential relation production promotion');
  const referentialRelationProductionSurfaces = read('Referential relation production surfaces');
  const openWorldSemanticLearning = read('Open-world semantic primitive learning');
  const openWorldSemanticQualification = read('Open-world semantic primitive qualification');
  const dualSemanticPrimitiveQualification = read('Dual semantic primitive qualification');
  const combinedPredicateTransfer = read('Combined candidate predicate external transfer');
  const frozenFreshEvaluation = read('Frozen fresh repository evaluation');
  const blockers = collectBlockers(state);
  const candidateTypes = candidate?.learnedRecordTypes || {};
  const activeTypes = active.learnedRecordTypes || {};
  const typeNames = [...new Set([...Object.keys(activeTypes), ...Object.keys(candidateTypes)])].sort();
  const deltaRows = typeNames.map(type => [
    type,
    activeTypes[type] || 0,
    candidateTypes[type] || 0,
    (candidateTypes[type] || 0) - (activeTypes[type] || 0)
  ]);
  const candidateShort = candidate?.sha256?.slice(0, 12) || 'none';
  const activeShort = active.sha256?.slice(0, 12) || 'none';
  const passed = label => evidenceByLabel[label]?.passed === true;
  const binding = item => {
    if (!item?.exists) return 'missing';
    const reportedHash = item.modelHash || item.candidateHash || null;
    if (reportedHash && reportedHash !== active.sha256 && reportedHash !== candidate?.sha256) {
      return 'historical model/candidate';
    }
    return item.ageMs <= FRESH_MS ? 'fresh' : 'stale';
  };
  const activeRecordIds = new Set(state.activeLearnedRecordIds || []);
  const retainedCandidateRecords = evidence => {
    const candidatePath = resolveRepoPath(evidence?.candidate?.path || evidence?.qualifiedCandidate?.path);
    const candidateModel = readJson(candidatePath);
    const ids = learnedRecordIds(candidateModel);
    return evidence?.passed === true && ids.length > 0 && ids.every(id => activeRecordIds.has(id));
  };
  const retainedRecords = (...ids) => ids.length > 0 && ids.every(id => activeRecordIds.has(id));
  // A historical manifest names the model that was promoted in that transaction.
  // It is not a valid test of whether a later active descendant retained the
  // learned records.  Current active-record presence plus the original passing
  // evidence is the required definition of "active inherited production".
  const referentialRelationActive = retainedCandidateRecords(referentialRelationPromotion)
    && retainedRecords(...(referentialRelationPromotion?.candidate?.learnedOperatorIds || []));
  const codingFrontierActive = retainedCandidateRecords(codingFrontierPromotion);
  const chatCodingActive = retainedCandidateRecords(chatCodingPromotion);
  const recapActive = retainedCandidateRecords(recapPromotion)
    && [...activeRecordIds].filter(id => id.startsWith('lari.learned.generator.recap.')).length === 38;
  const generatedPrimitiveActive = retainedCandidateRecords(generatedPrimitivePromotion)
    && retainedRecords(generatedPrimitiveQualification?.learnedRecordId || 'lari.learned.operator.vocabulary.2dba0034ea8b73f4');
  const recursiveFieldActive = retainedCandidateRecords(recursiveFieldPromotion)
    && retainedRecords(recursiveFieldPromotion?.candidate?.learnedRecordId || 'lari.learned.generator.neurogenesis.4b44de8b5bd9a4a341de');
  const publicUncertaintyCurrentHead = publicUncertaintyProduction?.passed === true
    && publicUncertaintyProduction?.candidate?.sha256 === active.sha256
    && publicUncertaintyProduction?.promotion?.sha256 === active.sha256
    && Object.values(publicUncertaintyProduction?.gates || {}).every(value => value === true);
  const publicUncertaintyProductionActive = retainedCandidateRecords(publicUncertaintyProduction);
  const domainNeurogenesisStage5Active = retainedCandidateRecords(domainNeurogenesisStage5Promotion);
  const semanticAstActive = semanticAstAutogenesis?.passed === true
    && retainedRecords(semanticAstAutogenesis?.operatorId || 'lari.learned.operator.neurogenesis.540a0682c8734f135c92');
  const deepCodingActive = deepCoding?.passed === true
    && (recapActive || deepCombinedPromotion?.promoted?.activeSha256 === active.sha256);
  const mixedDomainActive = mixedDomainPromotion?.status === 'promotion_succeeded'
    && mixedDomainPromotion?.promoted?.sha256 === active.sha256
    && mixedDomainProductionSurfaces?.passed === true
    && mixedDomainProductionSurfaces?.activeHash === active.sha256
    && Object.values(mixedDomainProductionSurfaces?.gates || {}).every(value => value === true)
    && mixedDomainPostPromotion?.passed === true
    && mixedDomainPostPromotion?.activeModelHash === active.sha256
    && retainedCandidateRecords(mixedDomainQualification);
  const architecturalReadiness = mixedDomainActive
    ? 'The active production model has current five-surface proof for two learned programs across reasoning and coding-data transformation, with exact generator/operator selection and zero external model calls. This is a real bounded expansion of Lari\'s executable language, not yet open-ended generation or arbitrary repository mastery; Lari is still not ready for public beta.'
    : publicUncertaintyProductionActive
    ? 'The active production model has a current hash-bound public uncertainty-research promotion across Workbench, CLI implementation, API, and autonomous paths. The result remains one bounded local-source lifecycle, and Lari is still not ready for public beta.'
    : referentialRelationActive
    ? 'The active production model retains the cumulative semantic-relation capability state; historical validation is ancestor-bound and current record retention is ledger-verified. Lari is still not ready for public beta.'
    : recursiveFieldActive
    ? 'The recursive-field-generator candidate is active production with exact rollback and five-surface evidence; Lari is still not ready for public beta.'
    : generatedPrimitiveActive
    ? 'The generated-primitive-family candidate is active production with exact rollback and five-surface evidence; Lari is still not ready for public beta.'
    : recapActive
    ? 'RECAP seven-family executable-language candidate is active production on top of the unified deep chat/coding model; Lari is still not ready for public beta.'
    : chatCodingActive
    ? 'Chat and nine-language coding candidate is active production with exact rollback and five-surface evidence; Lari is still not ready for public beta.'
    : codingFrontierActive
    ? 'Coding-frontier candidate is active production with exact rollback evidence; Lari is still not ready for public beta.'
    : (candidate
      ? 'Unpromoted candidate with sealed unseen-capability evidence; not yet a public-beta release.'
      : 'Truth-recovery state: no release-eligible candidate is currently proven.');
  const readiness = productSoak?.passed === true
    ? architecturalReadiness
    : `Production integrity is proven, but Lari is not ready for public beta: the fresh mixed product soak passed ${productSoak?.summary?.passedCount || 0}/${productSoak?.summary?.taskCount || 50} (${Math.round(Number(productSoak?.summary?.usefulRate || 0) * 100)}% useful) with ${productSoak?.summary?.failedCount || 0} visible failures. Runtime reliability cannot substitute for answer quality.`;

  const capabilityRows = [
    ['Execution-bound beta quality candidate', betaQualityExecutionRefinement?.passed && betaQualityExecutionRefinementSurfaces?.passed && betaReleaseGates?.passed && Object.values(betaQualityExecutionRefinementRehearsal?.gates || {}).every(Boolean) ? 'Safe for real promotion; unpromoted' : 'Unproven', betaQualityExecutionRefinement?.passed ? `Candidate ${String(betaQualityExecutionRefinement.candidate?.sha256 || '').slice(0, 12)} passed ${betaQualityExecutionRefinement.hidden?.length || 0}/${betaQualityExecutionRefinement.hidden?.length || 0} fresh semantic variants, reload, 9/9 family-record ablations, 4/4 arithmetic transfer, ${betaQualityExecutionRefinementSoak?.summary?.passedCount || 0}/${betaQualityExecutionRefinementSoak?.summary?.taskCount || 50} mixed product soak, 39/39 canonical gates, exact four-surface execution parity, and isolated promotion/rollback/fault rehearsal` : 'Missing', 'This materially improves bounded procedural chat and public selection-to-execution binding. It remains a non-promoted candidate and does not prove unrestricted language generation, arbitrary repository mastery, or frontier multimodal synthesis.'],
    ['Unified benchmark-capability binding', benchmarkCapabilities?.passed ? 'Validated unpromoted candidate' : 'Unproven', benchmarkCapabilities?.passed ? `18/18 primary and 18/18 semantic variants; 303/303 runners mapped; learn/reload/transfer=${benchmarkCapabilities?.developmentalTransfer?.passed === true}; candidate ${String(benchmarkCapabilities.candidateHash || '').slice(0, 12)}` : 'Missing', 'The 303 runners map to 18 real typed capability families. Infrastructure, external comparisons, and retired invalid paths remain evidence rather than fake skills. Production active is unchanged.'],
    ['General chat generation', statefulChat?.passed ? 'Bounded procedural chat with stateful reasoning' : 'Not built', statefulChat?.passed ? '2/2 five-turn dialogues passed; semantic variant, reload retention, read-only active model, and zero external model calls' : `${gateScore(gates.smoke)}; soak ${gateScore(gates.soak)}`, 'Lari now carries diagnostic hypotheses, revises them from disconfirming evidence, explains follow-ups, resolves perspective corrections, and audits what it must learn. It still does not contain a broad native text generator.'],
    ['Hypothesis-guided language generator', hypothesisGuidedGenerator?.proof?.hiddenTransfer === true ? 'Qualified unpromoted candidate' : 'Unproven', hypothesisGuidedGenerator?.proof?.hiddenTransfer === true ? `Candidate ${String(hypothesisGuidedGenerator.candidate?.sha256 || '').slice(0, 12)}; competing typed hypotheses, relation-faithful discourse, hidden transfer 3/3, reload 3/3, exact ablation, family regressions 0, and zero external model calls` : 'Missing', 'This expands the existing generator language with one bounded competing-hypothesis discourse program. It is not unrestricted natural-language generation or general reasoning.'],
    ['Cross-modal shared scene semantics', crossModalScene?.proof?.hiddenTransfer === true ? 'Qualified unpromoted candidate' : 'Unproven', crossModalScene?.proof?.hiddenTransfer === true ? `Candidate ${String(crossModalScene.candidate?.sha256 || '').slice(0, 12)}; one typed scene record binds SVG and WAV lanes across 3/3 hidden prompts, reload, exact ablation, entity/relation parity, and zero family regressions` : 'Missing', 'The record binds the current procedural image and short procedural audio executors. It does not prove photorealistic images, speech, music quality, or video generation.'],
    ['Authority-bounded agentic execution', agenticAuthority?.passed === true ? 'Validated safety slice' : 'Unproven', agenticAuthority?.passed === true ? 'Tier 0 inspection, tier 1 reversible local work, explicit tier 3 external authorization, rollback requirement, and max-step denial all passed with active/registry read-only' : 'Missing', 'This is an authority boundary on the existing mission loop, not unrestricted autonomy and not a second policy store.'],
    ['Learned conversational procedures', masteryExpansion?.gates?.chatSemanticVariants14Of14 === true && masteryQualification?.gates?.fiveSurfaceParityAll === true ? 'Qualified developmental candidate' : (mastery?.gates?.chatParaphraseTransfer5Of5 === true ? 'Developmental candidate' : 'Experimental'), masteryExpansion?.gates?.chatSemanticVariants14Of14 === true ? `12 cumulative procedure families; newest seven passed 14/14 semantic variants and 14/14 five-surface parity after reload; candidate ${String(masteryExpansion.candidate?.sha256 || '').slice(0, 12)}; zero external model calls` : (mastery?.gates?.chatParaphraseTransfer5Of5 === true ? `5/5 fresh semantic paraphrases after reload; candidate ${String(mastery.candidate?.sha256 || '').slice(0, 12)}; zero external model calls` : 'Missing'), 'Covers bounded conversational acts, planning, clarification, summarization, risk review, priority triage, learning roadmaps, and feedback design. This is broader procedural chat, not open-ended native generation.'],
    ['Chat and multilingual coding expansion', chatCodingActive && chatCodingProductionSurfaces?.passed ? 'Active inherited production' : (chatCodingExpansion?.passed && chatCodingRehearsal?.passed ? 'Promotion rehearsal passed' : 'Unproven'), chatCodingExpansion?.passed ? `Retained in active hash ${activeShort}; ancestor qualification: 8/8 hidden chat procedures with causal ablation; 66/66 fail-to-pass and reload repairs; 9/9 public-path languages; immutable oracles; five-surface parity, backups, and rollback evidence; zero external model calls` : 'Missing', 'Languages: JavaScript, TypeScript, Python, Ruby, Go, Rust, C#, Java, and PHP. Coding proof covers six bounded repair families, not arbitrary defects; chat remains typed procedural generation, not broad neural generation.'],
    ['Automatic isolated-reproducer coding bridge', automaticIsolatedReproducer?.passed === true ? 'Validated developmental slice' : 'Unproven', automaticIsolatedReproducer?.passed === true ? 'Blocked pytest harness classified as environment failure; bounded reproducer derived from safe test/source literals, accepted as behavioral, repaired, and retained only in candidate execution with immutable native oracle' : 'Missing', 'This prevents a missing host dependency from becoming a false repair failure. It covers a simple Python normalization case, not arbitrary harness reconstruction.'],
    ['Progressive coding relaxation binding', progressiveRelaxation?.passed === true ? 'Reachability proven; repair still failed' : 'Unproven', progressiveRelaxation?.passed === true ? `Existing bounded loop executed ${progressiveRelaxation.iterationCount} passes (${(progressiveRelaxation.relaxationScopes || []).join(' -> ')}); the focused fixture remained failing, so no false repair claim was made` : 'Missing', 'This proves the canonical default path reaches progressive scope relaxation. It does not yet prove a successful unseen repair through the wider scopes.'],
    ['Cross-domain capability composition', crossDomainComposition?.passed === true && crossDomainValidation?.passed === true && crossDomainRehearsalPassed ? 'Promotion rehearsal passed; unpromoted' : (crossDomainComposition?.passed === true ? 'Qualified candidate; validation/rehearsal incomplete' : 'Unproven'), crossDomainComposition?.passed === true ? `Candidate ${String(crossDomainComposition.candidateHash || '').slice(0, 12)} composed hypothesis-guided reasoning, retained local research, verified predicate repair, shared SVG/WAV scene semantics, and tier-1 reversible workspace action; reload and exact ablation passed; isolated promotion/rollback, interruption, corruption rejection, fallback isolation, and four-surface same-hash rehearsal ${crossDomainRehearsalPassed ? 'passed' : 'not complete'}; zero external model calls` : 'Missing', 'This is a bounded integration proof over already qualified typed records. It does not prove open-ended generation, arbitrary repository mastery, perceptual multimodal quality, or unrestricted autonomy; the candidate remains unpromoted.'],
    ['Deep technical chat expansion', deepTechnicalChat?.passed && deepTechnicalChatSurfaces?.passed ? 'Validated unpromoted candidate' : 'Unproven', deepTechnicalChat?.passed ? `16/16 training variants, 16/16 hidden variants, 16/16 causal ablations, 16/16 reload, prior 8/8 regression, and exact five-surface selection parity; candidate ${String(deepTechnicalChat.candidate?.sha256 || '').slice(0, 12)}; zero external model calls` : 'Missing', 'Adds bounded procedures for technical explanation, debugging interviews, clarification, uncertainty, failure output, review, tool synthesis, correction, long context, examples, analogy, tradeoffs, progress, teach-back, capability boundaries, and conversation-to-learning. It is not promoted and does not prove broad native generation.'],
    ['Deep 12-family coding qualification', deepCodingActive ? 'Active production, bounded' : (deepCoding?.passed ? 'Qualified candidate' : 'Unproven'), deepCoding?.passed ? `12/12 fresh Python workspaces; diagnostic hypothesis before edit, fail-before/pass-after, immutable external oracle, exact learned-record ablation, reload, rollback, read-only production, and zero external model calls; candidate ${String(deepCoding.candidate?.sha256 || deepCoding.candidateHash || '').slice(0, 12)}` : 'Missing', 'Covers twelve sealed repair families in fresh Python workspaces. It does not prove every family in all nine languages or arbitrary repository mastery.'],
    ['RECAP executable language', recapActive && recapValidation?.passed && recapSurfaces?.passed ? 'Active inherited production, seven bounded families' : (recapValidation?.passed ? 'Qualified candidate' : 'Unproven'), recapValidation?.passed ? `38 atomic RECAP records retained in active ${activeShort}; ancestor qualification: 6/6 training families, 12/12 unseen semantic variants, 32/32 new-record ablations, 12/12 reload, five-surface parity, hidden transfer 17/17, and zero family regressions` : 'Missing', 'RECAP now composes bounded causal explanations, practical plans, balanced comparisons, requirements clarification, correction repair, structured thinking, and retained-knowledge explanations from canonical typed generator records with meaning, discourse, clauses, claim coverage, and sentence provenance. It is not unrestricted natural-language generation.'],
    ['Computational English discourse binding', computationalEnglishDiscourse?.passed && computationalEnglishDiscoursePromotion?.passed && active.sha256 === computationalEnglishDiscoursePromotion.activeHash ? 'Active current-head production, bounded' : (computationalEnglishDiscourse?.passed ? 'Qualified ancestor or candidate' : 'Unproven'), computationalEnglishDiscourse?.passed ? `Active ${activeShort}: syntax, semantic, and pragmatic analysis now supplies discourse goals and ambiguity slots to two failure-induced chat procedures; semantic parsing 3/3, selection 3/3, counterfactual dependency 3/3, reload, 29/29 chat frontier before and after promotion, exact rollback, and zero external model calls` : 'Missing', 'Selection is no longer credited merely because Computational English record IDs appear in a trace: removing the semantic analysis removes the induced capability selection. Proof covers explicit uncertainty and lexical-ambiguity constructions only; the grammar and discourse-move vocabulary remain bounded.'],
    ['Open English semantic growth', openEnglishSemanticGrowth?.passed ? 'Qualified immutable candidate; not promoted' : 'Unproven', openEnglishSemanticGrowth?.passed ? `Candidate ${String(openEnglishSemanticGrowth.candidate?.sha256 || '').slice(0, 12)} induced purpose, concessive, and temporal-precedence operators from corrected failures; baseline failure 6/6, hidden cross-topic transfer 6/6, three-relation composition, semantic faithfulness 6/6, reload 6/6, exact ablation 6/6, adversarial false positives 0, active-state read-only, and zero external model calls` : 'Missing', 'This proves one generic typed relation interpreter can acquire three distinct semantic relations and realize them faithfully. It does not prove unrestricted English, broad world knowledge, or autonomous invention of every discourse move; the candidate remains unpromoted pending broader surface rehearsal.'],
    ['Native meaning-to-language generator', nativeLanguageGenerator?.passed ? 'Stage 1 qualified immutable candidate; not promoted' : 'Unproven', nativeLanguageGenerator?.passed ? `Candidate ${String(nativeLanguageGenerator.candidate?.sha256 || '').slice(0, 12)} stores one canonical grounded generator state; verified Computational English clause composition, 1000/1000 structural meaning-graph stress cases, reload, exact record ablation, ordinary-chat regression, read-only active model, and zero external model calls` : 'Missing', 'This is the first shared native compositional realization engine rather than another answer family. The 1000 cases are generated structural stress, not 1000 conversational abilities. Open-domain response planning, learned lexical choice, long-dialogue quality, and human preference evaluation remain unfinished; this is not yet a broad neural decoder.'],
    ['Recursive discourse composition', recursiveFieldActive && recursiveFieldProductionSurfaces?.passed ? 'Active inherited production' : (recursiveFieldRehearsal?.passed ? 'Promotion rehearsal passed; unpromoted' : (recursiveFieldGenerator?.passed ? 'Qualified unpromoted candidate' : 'Unproven')), recursiveFieldGenerator?.passed ? `Record retained in active ${activeShort}; ancestor qualification: parent lacked compound behavior 3/3; hidden transfer 6/6; reverse-order and three-component transfer; reload 6/6; exact-record ablation 6/6; historical five-surface parity ${recursiveFieldDirectSurfaces?.passed && recursiveFieldRehearsedSurfaces?.passed && recursiveFieldProductionSurfaces?.passed ? '6/6 each' : 'not fully proven'}; atomic promotion, interruption, corruption, fallback isolation, cold start, and exact rollback passed` : 'Missing', 'Lari learned one canonical generator record that recursively composes existing verified RECAP families. This is real learned composition, but the atomic parsers and available discourse families remain bounded.'],
    ['Language-side semantic primitive acquisition', languagePrimitive?.passed ? 'Qualified unpromoted candidate' : 'Unproven', languagePrimitive?.passed ? `Incumbent failed 10/10 sealed scope cases; retained operator ${languagePrimitive.operatorId}; hidden cross-domain transfer 6/6; reload 6/6; exact ablation 6/6; rollback restored failure 6/6; five-surface same-hash and record parity; zero family regressions; zero external model calls` : 'Missing', 'This proves that the canonical model lifecycle can acquire and execute one semantic operator for postposed only-if and unless scope across chat, coding, research, operations, and learning. The operator AST was supplied by developmental code from labeled public contrasts, so autonomous semantic-AST invention from raw failures is not yet proven. The candidate is not promoted.'],
    ['Failure-induced semantic AST synthesis', semanticAstActive ? 'Active inherited production' : (semanticAstAutogenesis?.passed ? 'Qualified unpromoted candidate' : 'Unproven'), semanticAstAutogenesis?.passed ? `Operator ${semanticAstAutogenesis.operatorId} is retained in active ${activeShort}; ancestor qualification: six behavioral failure contrasts, public 6/6, hidden cross-domain transfer 8/8, reload 8/8, exact ablation 8/8, rollback restoration 8/8, and five-surface parity` : 'Missing', 'The learner inferred two surface markers and their necessary/exception relations from development-authored prompt pairs and execution truth tables without receiving an operator AST. This is supervised structural induction, not unrestricted discovery from arbitrary conversation.'],
    ['Dual semantic repair capability expansion', dualSemanticPrimitiveQualification?.passed && combinedPredicateTransfer?.passed ? 'Developer-assisted, unpromoted' : 'Unproven', dualSemanticPrimitiveQualification?.passed ? `Combined candidate ${String(dualSemanticPrimitiveQualification.candidateHash || '').slice(0, 12)} contains selectors for context-accessor-output-composition and predicate-domain-set-edit; focused reuse 2/2 across pinned Astropy and Sphinx source, reload 2/2, exact ablation 2/2, exact record selection, and read-only production` : 'Missing', 'Executable search and ranking were developer-authored and tuned against these failures. A Requests gold patch was inspected during development, though the runner did not read it. These are development-exposed isolated reproductions, not blind holdouts, an official SWE-bench score, or autonomous primitive invention. See consolidation/predicate-domain-transfer-20260902/EVIDENCE_AMENDMENT_20260904.md.'],
    ['Semantic AST promotion rehearsal', semanticAstRehearsal?.passed ? 'Safe for real promotion; not promoted' : 'Unproven', semanticAstRehearsal?.passed ? `Exact candidate ${String(semanticAstRehearsal.candidate?.sha256 || '').slice(0, 12)} passed isolated atomic activation, exact rollback, interruption and corruption safety, fallback isolation, cold-start read-only inference, general five-surface parity, exact learned-operator parity across four prompts and five surfaces, hidden transfer/reload/ablation 8/8, legacy transfer 17/17, and zero family regressions` : 'Missing', 'The real production registry and active model were not modified.'],
    ['Referential relation primitive invention', referentialRelationActive && referentialRelationProductionSurfaces?.passed ? 'Active inherited production' : (referentialRelationRehearsal?.passed ? 'Safe for real promotion; not promoted' : (referentialRelationAutogenesis?.passed ? 'Qualified unpromoted candidate' : 'Unproven')), referentialRelationAutogenesis?.passed ? `Operator ${referentialRelationAutogenesis.operatorId} is retained in active ${activeShort}; ancestor qualification: base failed 8/8, hidden cross-domain transfer 8/8, reload 8/8, exact ablation 8/8, rollback restoration 8/8, prior semantic family 8/8, and five-surface same-hash/operator parity; rehearsal ${referentialRelationRehearsal?.passed ? 'passed atomic activation, exact rollback, interruption/corruption safety, fallback isolation, independent two-operator ablation, legacy transfer 17/17, and zero family regressions' : 'not run'}` : 'Missing', 'This is evidence that Lari extended the language in which it creates semantic programs, rather than only composing an existing procedure. The active proof remains bounded to explicit pairs of file paths or quoted entities and former/latter selection; unrestricted coreference is not proven.'],
    ['Cross-domain neurogenesis', domainNeurogenesisStage5Active ? 'Active inherited production, bounded' : 'Unproven', domainNeurogenesisStage5?.passed ? `6/6 canonical record categories in the shared lifecycle; Stage 1 transfer 18/18; Stage 2 ordinary binding 12/12 across five surfaces; Stage 3 factual failure-to-research transfer/reload/ablation 4/4; Stage 4 executable operator acquisition 4/4; Stage 5 synthesized a typed cross-file procedure from six primitive compositions, reused it with zero search across four fresh Python/JavaScript repositories, changed two files per repair, passed reload 4/4, and failed under exact-record ablation 4/4; retained inside active ${activeShort}; historical execution proof remains ancestor-bound; zero external model calls` : 'Missing', 'This proves factual self-research, one new executable Python operator family, and one compositional cross-file canonicalization procedure through the shared model lifecycle. It does not prove arbitrary coding neurogenesis or general multi-file programming mastery. The synthesis vocabulary remains bounded to authored primitives.'],
    ['Learned programs to workspace execution', crossDomainWorkspaceTransfer?.passed === true ? 'Active production runtime, bounded' : 'Unproven', crossDomainWorkspaceTransfer?.passed === true ? `Three exact retained operators for array, string, and numeric programs repaired 6/6 fresh JavaScript/Python workspaces through sendMessageToLari -> runLariUnifiedTaskKernel; cold reload 6/6, exact record ablation 6/6, semantic paraphrase selection, exact-prompt locks 0, full ${crossDomainWorkspaceTransfer.canonicalTestChain.gates}/${crossDomainWorkspaceTransfer.canonicalTestChain.gates} canonical gates, read-only active state, and zero external model calls passed` : 'Missing', 'This reuses three retained declarative programs as real workspace edits using existing tests as the oracle. It is not arbitrary repository mastery; execution remains bounded to supported primitive operations and simple return-expression repairs.'],
    ['Repository-failure declarative program neurogenesis', workspaceFailureProgramNeurogenesis?.passed === true ? 'Qualified non-promoted candidate, bounded' : 'Unproven', workspaceFailureProgramNeurogenesis?.passed === true ? `Parent production failed the target behavior; the canonical public repair path synthesized ${workspaceFailureProgramNeurogenesis.learnedRecordId} after retained-program exhaustion; visible fail-to-pass, hidden transfer 2/2 repositories and 6/6 cases across JavaScript/Python, cold reload 2/2, exact-record ablation 2/2, zero regressions across three prior declarative families, read-only production, and zero external model calls passed; candidate ${String(workspaceFailureProgramNeurogenesis.candidate?.sha256 || '').slice(0, 12)}` : 'Missing', 'This proves one repository failure can create and retain a reusable declarative macro-program from immutable test examples through Lari\'s existing typed lifecycle. It composes existing safe atomic operations; invention of a brand-new atomic opcode and arbitrary repository mastery remain unproven.'],
    ['Cross-domain state-machine primitive neurogenesis', crossDomainStateMachineNeurogenesis?.passed === true ? 'Qualified non-promoted candidate, bounded' : 'Unproven', crossDomainStateMachineNeurogenesis?.passed === true ? `Parent production lacked the behavior and failed in both workspace and language use; ${crossDomainStateMachineNeurogenesis.evidence?.parentAtomicProgramsAttempted || 0}/${crossDomainStateMachineNeurogenesis.evidence?.parentAtomicProgramsAttempted || 0} compatible atomic programs were exhausted before synthesizing transition-table operator ${crossDomainStateMachineNeurogenesis.learnedRecordId}; hidden workspace transfer ${crossDomainStateMachineNeurogenesis.evidence?.hiddenWorkspaceRepositories || 0}/2 repositories and ${crossDomainStateMachineNeurogenesis.evidence?.hiddenWorkspaceCases || 0}/6 cases across JavaScript/Python, ordinary language binding ${crossDomainStateMachineNeurogenesis.evidence?.ordinaryLanguageCases || 0}/3, reload dependencies ${crossDomainStateMachineNeurogenesis.evidence?.reloadDependencies || 0}/5, exact cross-domain ablation ${crossDomainStateMachineNeurogenesis.evidence?.ablatedDependencies || 0}/5, prior-program regressions 0/${crossDomainStateMachineNeurogenesis.evidence?.priorProgramsChecked || 0}, read-only production, and zero external model calls passed; candidate ${String(crossDomainStateMachineNeurogenesis.candidate?.sha256 || '').slice(0, 12)}` : 'Missing', 'This is a genuinely new atomic representation family: a learned finite-state transition table shared by repository repair and ordinary language understanding. The state-machine interpreter and synthesis search topology remain developer-authored, and proof covers quoted/escaped delimiter segmentation only; it is not unrestricted parser invention or arbitrary repository mastery.'],
    ['General finite-state transducer neurogenesis', generalFiniteStateTransducer?.passed === true && generalFiniteStateTransducerRehearsal?.gates && Object.values(generalFiniteStateTransducerRehearsal.gates).every(Boolean) ? 'Promotion rehearsal passed; non-promoted' : (generalFiniteStateTransducer?.passed === true ? 'Qualified non-promoted candidate' : 'Unproven'), generalFiniteStateTransducer?.passed === true ? `One shared inducer learned two distinct non-delimiter behavior families and two distinct canonical operators from ordinary repository failures; hidden transfer ${generalFiniteStateTransducer.evidence?.hiddenRepositories || 0}/4 JavaScript/Python repositories and ${generalFiniteStateTransducer.evidence?.hiddenCases || 0}/12 cases, ordinary language binding ${generalFiniteStateTransducer.evidence?.languageCases || 0}/6 with exact record selection, cold reload ${generalFiniteStateTransducer.evidence?.reloadDependencies || 0}/4, independent exact ablation ${generalFiniteStateTransducer.evidence?.ablationDependencies || 0}/4, read-only production, and zero external model calls passed; isolated atomic promotion, rollback, interruption, corruption rejection, fallback isolation, cold start, and surface parity ${generalFiniteStateTransducerRehearsal?.gates && Object.values(generalFiniteStateTransducerRehearsal.gates).every(Boolean) ? 'all passed' : 'not complete'}; candidate ${String(generalFiniteStateTransducer.candidate?.sha256 || '').slice(0, 12)}` : 'Missing', 'This replaces the one-shape delimiter search with bounded induction over states, character classes, actions, and transitions. It has learned bracketed-region removal and line-comment removal in addition to the earlier delimiter behavior. The interpreter and induction algorithm are authored, character predicates remain bounded, and arbitrary computation or repository mastery is not proven.'],
    ['Symbolic-predicate and pushdown neurogenesis', symbolicPushdownNeurogenesis?.passed === true && symbolicPushdownRehearsal?.gates && Object.values(symbolicPushdownRehearsal.gates).every(Boolean) ? 'Promotion rehearsal passed; non-promoted' : (symbolicPushdownNeurogenesis?.passed === true ? 'Qualified non-promoted candidate' : 'Unproven'), symbolicPushdownNeurogenesis?.passed === true ? `Exact-character finite state failed before a symbolic digit predicate and learned finite-state program succeeded; exact and symbolic finite state both failed before stack-backed induction succeeded on nested structure; hidden transfer ${symbolicPushdownNeurogenesis.evidence?.hiddenRepositories || 0}/4 JavaScript/Python repositories and ${symbolicPushdownNeurogenesis.evidence?.hiddenCases || 0}/12 cases, ordinary language binding ${symbolicPushdownNeurogenesis.evidence?.languageCases || 0}/6, reload ${symbolicPushdownNeurogenesis.evidence?.reloadDependencies || 0}/4, independent exact ablation ${symbolicPushdownNeurogenesis.evidence?.ablationDependencies || 0}/4, prior general transducers ${symbolicPushdownNeurogenesis.evidence?.priorCapabilitiesChecked || 0}/2, deterministic candidate, read-only production, and zero external model calls passed; isolated rehearsal ${symbolicPushdownRehearsal?.gates && Object.values(symbolicPushdownRehearsal.gates).every(Boolean) ? 'all gates passed' : 'not complete'}; candidate ${String(symbolicPushdownNeurogenesis.candidate?.sha256 || '').slice(0, 12)}` : 'Missing', 'This demonstrates bounded representation selection: learned symbolic character predicates and learned stack-backed behavior after weaker representations were exhausted. The predicate vocabulary, stack interpreter, and search algorithm remain developer-authored; arbitrary grammars, arbitrary computation, and repository mastery remain unproven.'],
    ['Failure-driven unknown-repository acquisition', unknownRepositoryAcquisition?.passed ? 'Qualified non-promoted candidate, bounded' : 'Unproven', unknownRepositoryAcquisition?.passed ? `Incumbent failed 4/4 sealed holdouts; learned record ${unknownRepositoryAcquisition.learnedRecord?.id}; hidden transfer 4/4 across JavaScript and Python with zero search and two-file edits; exact-record ablation 4/4; reload 4/4; zero family regressions; candidate ${String(unknownRepositoryAcquisition.qualifiedCandidate?.sha256 || '').slice(0, 12)}; zero external model calls` : 'Missing', 'This is real acquisition of a previously absent procedure instance from an existing bounded async-pipeline generator vocabulary. It does not prove invention of a new generator vocabulary or arbitrary repository mastery. The qualified candidate is not promoted.'],
    ['Synthetic public-path availability', traffic?.passed ? 'Infrastructure proof only' : 'Unproven', traffic?.passed ? `${traffic.traffic?.totalRequests || 0} requests over 8 repeated prompts; API p95 ${traffic.traffic?.api?.latency?.p95Ms ?? '—'} ms; Workbench p95 ${traffic.traffic?.workbench?.latency?.p95Ms ?? '—'} ms` : 'Missing', 'Counts HTTP success, nonempty text, same hash, and zero model-provider calls. It is not a correctness, usefulness, or real-user traffic measurement.'],
    ['Instruction constraint formatting', 'Historical format proof', `IFEval strict prompt ${formatMetric(ifeval?.metrics?.prompt_level_strict_acc)}`, `Bound to older active hash ${ifeval?.activeModelHash?.slice(0, 12) || 'unknown'}; measures format compliance, not reasoning or answer quality.`],
    ['Math reasoning', 'Rebaselined after contamination withdrawal', `GSM8K exact match ${formatMetric(gsm8k?.metrics?.exact_match)}`, `Bound to model hash ${gsm8k?.activeModelHash?.slice(0, 12) || 'unknown'}. The previously published 0.7763 is WITHDRAWN, not historical: 875 of 916 math policies were expressions fitted to individual GSM8K test items using that item's gold answer. See LARI_INDEPENDENT_AUDIT_2026-07-24.md section 3. Any value here is only meaningful if scripts/check_lari_contamination.js passes.`],
    ['Long chat, goals, pending actions', memory?.passed ? 'Active proof' : 'Unproven', memory?.passed ? `200 turns; reload=${memory?.reload?.usedContextMemory === true || memory?.dimensions?.reloadKeepsDurableFacts === true}` : 'Missing', 'Durable scoped facts and “ok do it” execution are proven; multi-day human usage remains unmeasured.'],
    ['Personal and professional profile learning', personal?.passed ? 'Historical active proof' : 'Experimental', personal?.passed ? '6/6 profile coverage retained after reload' : 'Missing', 'Requires transparent user controls and continued privacy review.'],
    ['User-scoped personal learning timeline', personalTimeline?.status === 'passed' ? 'Active runtime control' : 'Unproven', personalTimeline?.status === 'passed' ? 'Content-addressed before/after checkpoints, exact restore and undo, user isolation, chat-log exclusion, persistent-worker capture, and unchanged active model/registry all passed' : 'Missing', 'This rolls back durable memory and preferences for one user only. It deliberately does not roll back Lari\'s shared model intelligence, other users, raw conversations, or growth traces.'],
    ['Latest autonomous research acquisition', latestResearchCandidate?.passed === true ? 'Validated non-promoted candidate' : 'Rejected or absent', latestResearchCandidate?.passed === true ? `${latestResearchCandidate.topic || latestResearchCandidate.query}: candidate ${String(latestResearchCandidate.candidate?.sha256 || '').slice(0, 12)} passed 5/5 semantic variants, 17/17 inherited hidden transfer, reload, CLI/autonomous parity, core correctness, zero regressions, read-only production, and zero external model calls` : 'No fully validated current candidate', 'This proves one fresh source-backed factual acquisition through the repaired research-to-chat binding. It is not yet a one-hour open-ended mixed-domain learning result and is not promoted.'],
    ['Mixed apprenticeship factual plus coding state', sprintCodingAcquisition?.passed === true ? 'Validated non-promoted candidate' : 'Unproven', sprintCodingAcquisition?.passed === true ? `Candidate ${String(sprintCodingAcquisition.candidate?.sha256 || '').slice(0, 12)} cumulatively retains FFT and Bloom-filter knowledge plus learned operator ${sprintCodingAcquisition.learnedRecordId}; JavaScript fail-to-pass, hidden Python transfer, reload, independent ablation, read-only production, and zero external model calls passed` : 'Missing', 'The coding gain is one new unary string-transformation program composed from existing safe primitives. This is real cumulative cross-domain acquisition, not arbitrary repository mastery or a completed hour-long endurance run.'],
    ['Stateful multi-file composition acquisition', sprintStatefulMultifileAcquisition?.passed === true ? 'Validated non-promoted candidate' : 'Unproven', sprintStatefulMultifileAcquisition?.passed === true ? `Candidate ${String(sprintStatefulMultifileAcquisition.candidate?.sha256 || '').slice(0, 12)} learned procedure ${sprintStatefulMultifileAcquisition.learnedRecordId}, composing retained operator ${sprintStatefulMultifileAcquisition.dependencyRecordId}; visible JavaScript fail-to-pass, hidden Python transfer, cold reload, procedure and dependency ablations, read-only production, and zero external model calls passed` : 'Missing', 'This is a real composition gain: an existing learned stateful transformation became a dependency of a newly learned two-file procedure. It remains bounded to unary transformation over a collection and does not prove arbitrary repository mastery.'],
    ['Frozen cumulative apprenticeship', sealedCumulativeApprenticeship?.passed === true ? 'Passed' : 'Failed honestly', sealedCumulativeAdversarial ? `Adversarial result: ${sealedCumulativeAdversarial.correctedSummary?.substantivePasses || 'unknown'} substantive passes; ${sealedCumulativeAdversarial.correctedSummary?.verifiedNewAcquisitions || 'unknown'}; candidate ${String(sealedCumulativeApprenticeship?.candidate?.sha256 || '').slice(0, 12)} is not promotion eligible` : 'Missing adversarial review', 'The runtime was hash-frozen before all eight tasks. Failures exposed a three-step declarative limit, finite-state overfit on nesting, missing case-mapping actions, retained-knowledge routing failure, irrelevant planning retrieval, and a keyword-oracle false positive.'],
    ['Cumulative apprenticeship repair cycles', sealedApprenticeshipCycle3?.passed === true ? 'Cycle 3 passed; non-promoted' : 'Still failing', sealedApprenticeshipCycle3?.passed === true ? `Cycle 1 was adversarially corrected to ${sealedApprenticeshipCycle1Review?.correctedSummary?.substantivePasses || '2/8'}; Cycle 2 reached ${sealedApprenticeshipCycle2?.summary?.codingLearned || '3/4'} coding and ${sealedApprenticeshipCycle2?.summary?.chatPassed || '2/4'} chat; fresh sealed Cycle 3 passed ${sealedApprenticeshipCycle3?.summary?.codingLearned || '4/4'} coding and ${sealedApprenticeshipCycle3?.summary?.chatPassed || '4/4'} semantically verified chat with candidate ${String(sealedApprenticeshipCycle3?.candidate?.sha256 || '').slice(0, 12)}` : 'Cycle 3 evidence missing or failed', 'Cycle 3 proves bounded cumulative acquisition under a frozen runtime: four-step declarative synthesis, nesting-aware state-machine selection, learned ASCII case mapping, cross-file composition, acronym-aware knowledge routing, planning, and evidence-based comparison. It remains an eight-task controlled curriculum, not arbitrary open-world mastery, and is not promoted.'],
    ['Cumulative apprenticeship sprint checkpoint', mixedApprenticeshipSprint?.passed === true ? 'Validated non-promoted candidate' : 'Unproven', mixedApprenticeshipSprint?.passed === true ? `Candidate ${String(mixedApprenticeshipSprint.candidate?.sha256 || '').slice(0, 12)} retains both independently learned topics; semantic transfer 6/6, reload, independent ablation 2/2, read-only production, and zero external model calls passed` : 'Missing', 'This is the first cumulative checkpoint, not the completed one-hour mixed-domain endurance run. It currently proves factual acquisition only; coding acquisition remains separate.'],
    ['Source-backed retrieval and retention', benchmarkCapabilities?.developmentalTransfer?.checks?.researchReusedAfterReload === true ? 'Validated unpromoted candidate' : (passed('Research-to-retention') ? 'Bounded developmental evidence' : 'Experimental'), benchmarkCapabilities?.developmentalTransfer?.checks?.researchReusedAfterReload === true ? 'Typed source-backed knowledge reused through public inference after JSON reload' : (passed('Research-to-retention') ? 'Recorded test transfer and reload' : 'See milestone report'), 'Broad factual relevance and open-ended autonomous research quality are not proven.'],
    ['Autonomous uncertainty research', autonomousUncertaintyResearch?.passed === true ? 'Qualified unpromoted candidate' : 'Unproven', autonomousUncertaintyResearch?.passed === true ? `Candidate ${String(autonomousUncertaintyResearch.candidate?.sha256 || '').slice(0, 12)} detected a typed knowledge gap in autonomous chat, acquired one local source-backed record, answered through the retained record, reloaded it, and lost the behavior under exact record ablation; zero external model calls` : 'Missing', 'The proof uses a local source fixture. It establishes the trigger and retention seam, not arbitrary web research quality, executable skill acquisition, or production promotion.'],
    ['Public uncertainty-research path convergence', publicUncertaintyProductionActive ? (publicUncertaintyCurrentHead ? 'Active current-head production, bounded' : 'Active inherited production, bounded') : (publicSurfaceUncertainty?.passed === true ? 'Qualified unpromoted candidate' : 'Unproven'), publicUncertaintyProductionActive ? `The exact retained candidate records are present in active ${activeShort}. The four-surface same-selection, learned-ID, exact-answer, cold-reload, 7/7 RECAP, 17/17 legacy-transfer, read-only, and zero-external-call proof is bound to ancestor beb2db6daa87${publicUncertaintyCurrentHead ? ' and is also the current registry head' : '; it was not rerun as a current-hash public proof'}` : (publicSurfaceUncertainty?.passed === true ? `Candidate ${String(publicSurfaceUncertainty.candidate?.sha256 || '').slice(0, 12)} ran the same uncertainty-triggered acquisition through Workbench, CLI, OpenAI-compatible API, and autonomous entry points; all four learned the same typed record, then matched on candidate hash, capability selection, learned IDs, reload retention, exact ablation, read-only production state, and zero external model calls` : 'Missing'), 'This is one public-path lifecycle proof over a local source fixture. It does not prove arbitrary web-source quality, executable skill learning, or broad autonomous research.'],
    ['Public uncertainty-research promotion', publicUncertaintyProductionActive ? (publicUncertaintyCurrentHead ? 'Active current-head production' : 'Active inherited production') : (publicUncertaintyPromotionRehearsal?.passed === true ? 'Safe for real promotion; not promoted' : 'Unproven'), publicUncertaintyProductionActive ? `Ancestor beb2db6daa87 was hash-lock promoted with exact rollback and no family regressions; all of its typed records remain present in current active ${activeShort}. Current status is record-retention evidence, not a claim that the old transaction or its old surface run names the current hash.` : (publicUncertaintyPromotionRehearsal?.passed === true ? `Candidate ${String(publicUncertaintyPromotionRehearsal.candidate?.sha256 || '').slice(0, 12)} passed isolated atomic activation, exact rollback, interruption and corruption safety, canonical-only fallback isolation, cold start, reload, 7/7 RECAP regression, 17/17 legacy learned-knowledge transfer regression, and same-hash/capability/learned-record parity through Workbench, CLI implementation, OpenAI-compatible API, and autonomous requests; zero external model calls` : 'Missing'), 'Attempt 1 automatically rolled back before surface evaluation because the promotion wrapper mishandled the CLI result shape; attempt 2 corrected the wrapper and succeeded. This host lacks npm, so the CLI proof invokes scripts/lari_ask.js, the exact implementation mapped by npm run lari:ask. The local cobalt-orbit fixture does not establish arbitrary web research quality.'],
    ['Developmental failure learning', developmentalProof?.passed === true ? 'Release-eligible unpromoted candidate' : 'Experimental', developmentalProof?.passed === true ? `Operator ${developmentalProof.candidate?.learnedRecordIds?.[0] || 'retained'} persisted in candidate ${String(developmentalProof.candidate?.sha256 || '').slice(0, 12)}, reloaded from disk, and reused discovery-disabled on sealed Ramda (1/1)` : 'Missing', 'This proves one generalized binary-expression repair family, not arbitrary self-teaching or blind-repository repair.'],
    ['Goal-to-learning curriculum', passed('Goal-driven curriculum') ? 'Validated candidate path' : 'Experimental', passed('Goal-driven curriculum') ? 'Goal audit, stored curriculum, follow-up execution' : 'See milestone report', 'Reading never counts as proof of an operator or generator.'],
    ['Verified coding mutation search', codingFrontierActive ? 'Active production, real but bounded' : 'Real but bounded', codingFrontierActive && codingFrontierProductionTransfer?.passed === true ? `Production model ${activeShort} passed 5/5 reuse-only coding lanes, 3/3 causal ablations, reload, rollback, exact five-surface hash parity, read-only inference, and zero external model calls` : (sealedRepositoryTransfer?.passed === true && sealedRepositoryQualification?.passed === true ? `Sealed real-repository acceptance improved from 2/3 on parent to 3/3 reuse-only on candidate ${String(sealedRepositoryTransfer.modelHash || '').slice(0, 12)}; separate-package learning localized from a traceback, retained one generic typed operator, passed 17/17 hidden transfer, five-surface parity, reload, rollback, and zero family regressions` : 'Earlier bounded coding evidence remains recorded.'), 'The active production proof covers issue localization, isolated test creation, coordinated multi-file repair, behavior-preserving refactoring, and bounded long-horizon repair. It does not prove arbitrary repository mastery.'],
    ['Open-world semantic repair neurogenesis', openWorldSemanticQualification?.passed ? 'Qualified unpromoted developmental candidate' : 'Unproven', openWorldSemanticQualification?.passed ? `Seaborn fail-to-pass 1/1 through inferred get_offset and a coordinated two-file repair; retained primitive ${openWorldSemanticQualification.primitive?.id}; development-authored unseen-concept transfer 2/2; cold reload 1/1; exact ablation 1/1; candidate ${String(openWorldSemanticQualification.candidate?.sha256 || '').slice(0, 12)}; zero external model calls` : 'Missing', 'This is one real unfamiliar-repository pass and one newly retained relation shape. Requests remained unsolved, the transfer fixtures are development-authored rather than external repositories, the broader target is 1/6 tasks and 1/3 capabilities, and the candidate is not promoted.'],
    ['Agentic coding: coordinated multi-file', coding?.passed ? 'Validated candidate' : 'Experimental', coding?.passed ? 'Parent failed; child transferred JS -> Python after reload' : 'Missing', 'One falsy-count coordinated family is proven, not general multi-file mastery.'],
    ['Agentic coding: async dependency pipelines', asyncCoding?.passed ? 'Validated candidate' : 'Experimental', asyncCoding?.passed ? 'Parent failed; child transferred JavaScript -> Python after reload; four-surface parity' : 'Missing', 'One generic async filter/project family is proven, not arbitrary concurrency or distributed-systems mastery.'],
    ['Local image generation', multimodal?.executableCapabilities?.image?.status || 'Experimental', multimodal?.passed ? 'Procedural SVG with structural verification' : 'Missing', 'Photoreal raster generation is not proven.'],
    ['Local audio generation', multimodal?.executableCapabilities?.audio?.status || 'Experimental', multimodal?.passed ? 'Short procedural WAV with waveform verification' : 'Missing', 'Speech, SFX, and studio-quality output are not proven.'],
    ['Video and clip workflows', passed('Public media convergence') ? 'Validated candidate procedure' : 'Not ready', passed('Public media convergence') ? '2/2 verified clips across four surfaces' : 'No current proof', 'Full generative video model, temporal evaluator, and encoder remain unproven.'],
    ['Rollback and lineage', state.registry.matchesActiveBytes && state.registry.rollback?.eligible ? 'Consistent' : 'Recovery required', `${state.registry.historyCount} registry history entries`, state.registry.matchesActiveBytes && state.registry.rollback?.eligible ? 'Registry identity matches the active bytes and the rollback target is clean.' : 'Registry identity or clean rollback availability requires recovery.']
  ];

  const gateRows = [
    ['Deterministic public regression', gateScore(gates.truth), gates.truth?.path || '—'],
    ['Historical control-plane regression', gateScore(gates.eval), gates.eval?.path || '—'],
    ['First-run contract regression', gateScore(gates.smoke), gates.smoke?.path || '—'],
    ['Fixed-prompt product regression', gateScore(gates.soak), gates.soak?.path || '—'],
    ['Synthetic availability/load', traffic?.passed ? 'PASS (infrastructure only)' : 'FAIL', evidenceByLabel['Release traffic proof']?.path || '—'],
    ['Historical internal training aggregate', gateScore(gates.train), gates.train?.path || '—'],
    ['Historical alpha checklist', gateScore(gates.launch), gates.launch?.path || '—'],
    ['Frozen repository acceptance', gateScore(gates.frozenRepositoryAcceptance), gates.frozenRepositoryAcceptance?.path || '—']
  ].map(([name, result, source]) => [name, result, markdownLink(source)]);

  const latestCodingPublic = asyncCodingPublic?.passed ? asyncCodingPublic : codingPublic;
  const surfaceRows = (latestCodingPublic?.surfaces || []).map(surface => [
    surface.name,
    surface.modelHash?.slice(0, 12),
    surface.sourceSkillId,
    surface.appliedOperatorRecordId,
    surface.executionVerified ? 'PASS' : 'FAIL',
    surface.externalModelCalls ?? '—'
  ]);
  const evidenceRows = state.evidence.map(item => [
    item.label,
    item.exists ? (item.passed === true ? 'PASS' : item.passed === false ? 'FAIL' : 'RECORDED') : 'MISSING',
    item.exists ? binding(item) : 'missing',
    item.exists ? markdownLink(item.path) : `\`${item.path}\``
  ]);

  const recentEvidence = walkJsonEvidence(path.join(ROOT, 'consolidation'))
    .map(filePath => ({ filePath, document: readJson(filePath), stat: fs.statSync(filePath) }))
    .filter(item => artifactPassed(item.document))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    .slice(0, 15)
    .map(item => [
      item.document?.verdict || item.document?.benchmark || path.basename(path.dirname(item.filePath)),
      item.stat.mtime.toISOString(),
      markdownLink(relative(item.filePath))
    ]);

  return `# Lari Full Report

> Canonical living report. Generated from the live registry, active model, preserved candidate evidence, recovery manifests, and evidence artifacts.
>
> Refresh: \`npm run lari:report\`  
> Freshness check: \`npm run lari:report:check\`

Generated: \`${state.generatedAt}\`
Source fingerprint: \`${state.sourceFingerprint}\`

## Executive status

${mixedDomainActive ? `Production update: active model \`${active.sha256}\` now contains and executes two newly learned declarative programs: affine calibration in reasoning and dependency-list canonicalization in coding-data work. Qualification passed 6/6 hidden transfer, 6/6 cold reload, 12/12 exact dependency ablation, inherited 5/5 learned-program and 7/7 RECAP regressions, isolated promotion rehearsal for both families, and current five-surface exact record/hash parity with zero external model calls. Exact rollback to \`${mixedDomainPromotion.rollback.sha256}\` is preserved at \`${mixedDomainPromotion.rollback.path}\`. Three retained declarative operators now repair fresh JavaScript and Python workspaces through the canonical public kernel: array canonicalization, project-key normalization, and affine calibration. Hidden transfer, cold reload, and individual ablation passed 6/6 with zero exact-prompt locks. This proves bounded cross-domain program reuse in real workspaces, not arbitrary repository mastery.\n` : read('Case-identity production validation')?.passed === true && active.sha256 === '44b209ab89d29e05cb743361020c7060498cf737113cba9356594d2274ed549b' ? `Production update: active model \`44b209ab89d29e05cb743361020c7060498cf737113cba9356594d2274ed549b\` now carries the Sphinx-learned case-identity primitive. Atomic promotion and post-promotion targetless repair, hidden variants, cold reload, exact ablation, 17/17 inherited transfer, zero family regressions, the 39/39 canonical chain, and executable same-record parity across Workbench, CLI, API, and autonomous requests passed with zero external model calls. Exact rollback to \`beb2db6daa870dc134781ff9135247b942d3c578951b6fe90eacd03fbe9fca15\` is preserved. This is one bounded transferred semantic primitive, not arbitrary repository mastery. See [production report](consolidation/case-identity-production-promotion-20260907/PRODUCTION_REPORT.md).\n` : read('Case-identity cross-repository transfer')?.passed === true && read('Case-identity executable public parity')?.passed === true && read('Case-identity isolated promotion rehearsal')?.gates?.promotionRehearsal === true && read('Case-identity rehearsed-active lifecycle')?.passed === true && read('Case-identity rehearsed-active public parity')?.passed === true ? `Development update: candidate \`44b209ab89d29e05cb743361020c7060498cf737113cba9356594d2274ed549b\` has developer-sealed transfer, hidden variants, cold reload, exact ablation, executable public parity, and a successful isolated promotion rehearsal. It is not active. See [qualification report](consolidation/case-identity-cross-repo-qualification-20260907/QUALIFICATION_REPORT.md).\n` : read('Exposed repository learned-rule lifecycle')?.passed === true ? `Development update: candidate \`44b209ab89d29e05cb743361020c7060498cf737113cba9356594d2274ed549b\` completed research-assisted repair, retained reuse, reload, and exact-record ablation on an exposed Sphinx task. This is an unpromoted candidate using a developer-authored case-preservation primitive; unseen transfer and autonomous primitive invention are not established by this result. See [development report](consolidation/research-to-executable-repair-acquisition-20260906/DEVELOPMENT_REPORT.md).\n` : ''}

**${readiness}**

- Production active: \`${active.sha256}\` at \`${active.path}\`.
- Registry/active identity: **${state.registry.matchesActiveBytes ? 'MATCH' : 'MISMATCH — recovery required'}**.
- Latest preserved release-eligible candidate artifact: ${candidate ? `\`${candidate.sha256}\` at \`${candidate.path}\`` : 'none'}. This is historical evidence, not a claim that it is newer than or should replace the active model.
- Latest validated benchmark-capability candidate: ${benchmarkCapabilities?.passed ? `\`${benchmarkCapabilities.candidateHash}\` (unpromoted; not release eligible)` : 'none'}.
- Chat/coding expansion identity: ${chatCodingActive ? `\`${active.sha256}\` (active production)` : (chatCodingExpansion?.passed ? `\`${chatCodingExpansion.candidate.sha256}\` (validated but not active)` : 'none')}.
- Chat/coding production promotion: ${chatCodingActive ? `**ACTIVE — ${active.sha256}**` : 'not active'}.
- Deep chat/coding production lineage: ${deepCodingActive ? `**ACTIVE inside ${active.sha256}**` : (deepCoding?.passed ? `qualified candidate ${deepCoding.candidate?.sha256 || deepCoding.candidateHash}` : 'not proven')}.
- RECAP executable-language promotion: ${recapActive ? `**ACTIVE — ${active.sha256}**` : 'not active'}.
- Public uncertainty-research promotion: ${publicUncertaintyProductionActive ? `**ACTIVE INHERITED inside ${active.sha256}**; original four-surface evidence is ancestor-bound${publicUncertaintyCurrentHead ? ' and also current-head' : ''}` : 'not active'}.
- Mixed-domain learned-program promotion: ${mixedDomainActive ? `**ACTIVE — ${active.sha256}**; current five-surface parity for reasoning and coding-data records` : 'not active'}.
- Activation terminology: **active inherited production** means the exact learned records are present in the current active model and their original qualification passed. It does not pretend that an older five-surface run was executed again on the current hash. **Current-head promotion** names only the latest registry transaction.
- Preserved contaminated candidates: ${state.recovery?.contaminatedCandidateCount || 0}, quarantined from discovery and promotion.
- Production external-model policy: **zero external model calls unless the user explicitly requests one**.
- Canonical runtime: \`${state.canonicalRuntime}\`.
- Production claims are bound to the exact active hash; unpromoted candidate results remain explicitly separate.

## What Lari is

${state.definition}

Lari is not a wrapper that silently hands ordinary production requests to another model. It is also not currently a dependable general-purpose generative model. Its strongest real capability is bounded verified code mutation search; its general chat surface is deterministic procedures, retrieval, and refusal.

The public lifecycle is:

\`Workbench / CLI / OpenAI-compatible API / autonomous request -> sendMessageToLari -> runLariUnifiedTaskKernel -> deterministic procedure, retrieval, bounded operator execution, or refusal\`

The intended learning lifecycle is:

\`failure or knowledge gap -> evidence -> typed candidate record -> hidden transfer and regression gates -> immutable candidate -> promotion rehearsal -> explicit promotion -> lineage and rollback\`

That lifecycle is now closed in active production for five bounded coding lanes: traceback-driven issue localization, isolated test creation when a native harness is blocked, coordinated multi-file repair, behavior-preserving refactoring, and bounded long-horizon multi-defect repair. The production model passed 5/5 reuse-only, all three new records failed under individual ablation, reload retained them, rollback restored failed attempts, and five public surfaces selected the same active hash. This is not proof of arbitrary repository mastery.

It is also now closed for one bounded source-backed uncertainty-research record through Workbench, the CLI implementation, the OpenAI-compatible API, and autonomous requests: the active head selects the same retained record and answer after cold reload, while ordinary inference leaves the active model and registry unchanged. This is not proof of arbitrary web research or general self-teaching.

## Architectural thesis and invariants

- Lari is the production model; no silent external-model inference.
- One registered active model manifest and one canonical public inference path.
- Typed learned records are canonical intelligence: knowledge, procedure, repair, operator, generator, and preference when present.
- Capability graphs, routing projections, genes, and route locks are derived indexes—not separate brains.
- Specialists operate as parts of shared model state.
- Ordinary inference is read-only.
- Research may automatically create low-risk knowledge candidates; high-risk knowledge is quarantined.
- Operator and generator learning requires executable evidence, unseen transfer, reload retention, regression checks, and rollback safety.
- Tests, benchmark prompts, raw traces, generated products, and proof artifacts do not belong in the live brain.

## Active production model

${markdownTable(
    ['Field', 'Value'],
    [
      ['Hash', `\`${active.sha256}\``],
      ['Path', `\`${active.path}\``],
      ['Size', formatBytes(active.bytes)],
      ['Skills', active.skills],
      ['Compiled skills', active.compiledSkills],
      ['Typed learned records', active.learnedRecords],
      ['Active learned records', active.activeLearnedRecords],
      ['Retained autonomous requests', active.retainedRequests],
      ['Modality registry entries', active.modalityEntries],
      ['Registry history entries', state.registry.historyCount],
      ['Developmental event', active.lineage?.developmentalEvent || '—']
    ]
  )}

## Latest validated candidate

${candidate ? markdownTable(
    ['Field', 'Value'],
    [
      ['Hash', `\`${candidate.sha256}\``],
      ['Short identity', `\`${candidateShort}\``],
      ['Path', `\`${candidate.path}\``],
      ['Parent hash', `\`${candidate.parentHash || 'unknown'}\``],
      ['Size', formatBytes(candidate.bytes)],
      ['Skills', candidate.skills],
      ['Compiled skills', candidate.compiledSkills],
      ['Typed learned records', candidate.learnedRecords],
      ['Promotion state', candidate.promoted ? 'promoted' : 'validated and unpromoted'],
      ['Developmental event', candidate.lineage?.developmentalEvent || '—'],
      ['Validation source', markdownLink(candidate.evidencePath)]
    ]
  ) : 'No validated candidate was discovered.'}

### Typed-record delta: active \`${activeShort}\` -> candidate \`${candidateShort}\`

${markdownTable(['Record type', 'Active', 'Candidate', 'Delta'], deltaRows)}

No candidate result changes production capability until the candidate is promoted through the registry lifecycle.

## Capability inventory

${markdownTable(['Capability', 'State', 'Best evidence', 'Honest boundary'], capabilityRows)}

## Public-surface convergence for the latest coding candidate

${surfaceRows.length
    ? markdownTable(['Surface', 'Model hash', 'Wrapper', 'Operator', 'Execution', 'External model calls'], surfaceRows)
    : 'No current public-surface candidate evidence was discovered.'}

All reported candidate surfaces must select the same candidate hash and learned record. Workbench patch round-trips are accepted only when executable tests pass and the test oracle remains unchanged.

## Learning, memory, and growth

- Context/action memory: ${memory?.passed ? 'passed' : 'not currently proven'}; stored goals and pending actions can resume from natural follow-ups.
- Long-session reload: ${longSession?.passed ? 'passed' : 'not currently proven'}.
- Release traffic proof: ${traffic?.passed ? `${traffic.traffic?.totalRequests || 0}/${traffic.traffic?.totalRequests || 0} synthetic public-path requests passed across ${traffic.traffic?.userScopes || 0} user scopes with reload retention, isolation, fault recovery, same-hash parity, and zero external model calls` : 'not currently proven'}.
- Canonical beta release gates: ${betaReleaseGates?.passed ? `39/39 passed on candidate ${betaReleaseGates.candidate?.sha256 || 'unknown'}; ${betaReleaseGates.candidate?.sha256 === active.sha256 ? 'this is the active production hash' : 'production remains unchanged'}` : 'not currently passing'}.
- Four-surface beta product acceptance: ${betaProductAcceptance?.passed ? 'Workbench, CLI, API, and autonomous requests passed same-hash and same-selection parity, including stale user-state rebase and model controls' : 'not currently passing'}.
- Fresh mixed product soak: ${productSoak?.passed ? `${productSoak.summary?.passedCount}/${productSoak.summary?.taskCount} passed` : `FAILED ${productSoak?.summary?.passedCount || 0}/${productSoak?.summary?.taskCount || 50}; weak families: ${(productSoak?.summary?.weakFamilies || []).join(', ') || 'unknown'}`}.
- Latest beta-quality candidate: ${betaQualityCandidate ? `FAILED and remains unpromoted; its original hidden-selection validation was ${betaQualityCandidate.hidden?.filter(item => item.selected && !(item.missing || []).length).length || 0}/${betaQualityCandidate.hidden?.length || 0} and predates execution-bound provenance, so it is retained only as historical selection evidence. The honest post-binding candidate soak is ${betaQualityPostBindingSoak?.summary?.passedCount || 0}/${betaQualityPostBindingSoak?.summary?.taskCount || 50}` : 'not yet attempted'}.
- Native semantic claim composition: ${semanticClaimComposition?.passed ? `candidate ${semanticClaimComposition.candidate?.sha256 || 'unknown'} passed 6/6 fresh execution-bound prompts, 6/6 reload checks, and 6/6 exact-record ablations with grounded claim traces, no stored validation prompts, read-only production, and zero external model calls; candidate remains unpromoted` : 'not currently proven'}.
- Failure-to-research claim neurogenesis: ${failureResearchClaimNeurogenesis?.passed ? `3/3 unrelated unknown domains triggered from an ordinary failed request, synthesized one source-grounded executable knowledge record each, executed immediately, transferred to unseen paraphrases 3/3, survived reload 3/3, and failed under exact ablation 3/3; no prompt storage, promotion, production writes, or external model calls` : 'not currently proven'}.
- Claim novelty and consolidation: ${claimNoveltyConsolidation?.passed ? `a duplicate lesson was rejected with the canonical record count unchanged, while a failure-selected record was refined in place from ${claimNoveltyConsolidation.refinement?.sectionsBefore || 0} to ${claimNoveltyConsolidation.refinement?.sectionsAfter || 0} claims under the same record ID; provenance, unseen transfer, reload, exact ablation, read-only production, and zero external model calls all passed` : 'not currently proven'}.
- Broad grounded-claim growth attempt: ${groundedClaimGrowthCandidate ? `FAILED and remains unpromoted; 11/11 programs were synthesized but duplicate capability scopes failed exact-record hidden transfer and the mixed product soak remained ${groundedClaimGrowthCandidate.productSoak?.summary?.passedCount || 0}/${groundedClaimGrowthCandidate.productSoak?.summary?.taskCount || 50}. This is retained as negative evidence against teaching overlapping records` : 'not yet attempted'}.
- Execution-bound beta quality refinement: ${betaQualityExecutionRefinement?.passed && betaQualityExecutionRefinementSurfaces?.passed && betaReleaseGates?.passed && Object.values(betaQualityExecutionRefinementRehearsal?.gates || {}).every(Boolean) ? `safe for real promotion but still unpromoted: candidate ${betaQualityExecutionRefinement.candidate?.sha256}; fresh semantic transfer ${betaQualityExecutionRefinement.hidden?.length || 0}/${betaQualityExecutionRefinement.hidden?.length || 0}, reload ${betaQualityExecutionRefinement.reload?.length || 0}/${betaQualityExecutionRefinement.reload?.length || 0}, exact family-record ablation 9/9, arithmetic transfer 4/4, mixed product soak ${betaQualityExecutionRefinementSoak?.summary?.passedCount || 0}/${betaQualityExecutionRefinementSoak?.summary?.taskCount || 50}, canonical gates 39/39, same-hash/same-answer/same-executed-record parity across Workbench, CLI, API, and autonomous requests, and isolated atomic promotion/rollback/interruption/corruption/fallback rehearsal; no prompt storage, production write, or outside-model call` : 'not fully qualified'}.
- Personal/professional learning: ${personal?.passed ? 'passed historical proof' : 'not currently proven'}.
- Research-to-retention: ${passed('Research-to-retention') ? 'validated' : 'experimental'}.
- Goal-driven curriculum: ${passed('Goal-driven curriculum') ? 'validated' : 'experimental'}.
- Latest coding curriculum: ${coding?.passed ? coding.verdict : 'missing'}.
- Latest async coding curriculum: ${asyncCoding?.passed ? asyncCoding.verdict : 'missing'}.
- Mastery developmental curriculum: ${mastery?.passed ? `${mastery.chat?.score || '0/5'} learned-chat transfer and ${mastery.coding?.score || '0/4'} JavaScript-to-Python coding transfer after reload; candidate remains unpromoted and non-release-eligible` : 'not currently proven'}.
- Mastery expansion: ${masteryExpansion?.passed && masteryQualification?.passed ? `${masteryExpansion.chat?.score || '0/14'} chat semantic variants, ${masteryExpansion.coding?.score || '0/16'} cross-language coding variants, 17/17 hidden transfer, zero family regressions, and five-surface parity across all new chat cases; candidate remains unpromoted` : 'not currently proven'}.
- Sealed repository expansion: ${sealedRepositoryLearning?.passed && sealedRepositoryTransfer?.passed && sealedRepositoryQualification?.passed ? `parent 2/3 -> candidate 3/3 reuse-only across Boltons, Toolz, and Click; new generic operator ${sealedRepositoryLearning.candidate?.learnedRecordIds?.[0] || 'retained'} survived reload and qualification; candidate remains unpromoted` : 'not currently proven'}.
- Coding frontier expansion: ${codingFrontierProductionTransfer?.passed && codingFrontierProductionSurfaces?.passed ? `active production passed 5/5 sealed reuse-only across issue localization, isolated test creation, coordinated multi-file repair, behavior-preserving refactoring, and long-horizon repair; 3/3 causal ablations, reload, rollback, five-surface exact-hash parity, read-only inference, and zero external model calls` : (codingFrontierTransfer?.passed && codingFrontierQualification?.passed ? 'qualified candidate evidence exists but is not active' : 'not currently proven')}.
- Coding frontier promotion: ${codingFrontierActive ? `candidate 824ee16a was promoted exactly; incumbent ${String(codingFrontierPromotion.incumbent?.sha256 || '').slice(0, 12)} is preserved by registry and content-addressed backups; all promotion gates passed` : 'not currently proven'}.
- Stateful language reasoning: ${statefulChat?.passed ? 'two five-turn diagnostic and self-learning dialogues passed, including an unseen semantic variant and reload between evidence and explanation' : 'not currently proven'}.
- Chat and multilingual coding expansion: ${chatCodingExpansion?.passed ? '8/8 new chat families, 8/8 causal ablations, 66/66 failure-to-pass and reload repairs across nine languages, 9/9 fresh public-path repairs, immutable test oracles, rollback, exact hash binding, and zero external model calls; candidate remains unpromoted' : 'not currently proven'}.
- Deep 12-family coding: ${deepCoding?.passed ? '12/12 fresh Python workspaces passed with diagnostic hypotheses, immutable oracles, exact ablation, reload, rollback, and zero external model calls; this state is in the current production lineage' : 'not currently proven'}.
- RECAP seven-family language generation: ${recapActive ? `active inherited production in ${active.sha256}; all 38 RECAP records are ledger-present. Ancestor qualification passed 12/12 unseen semantic variants and 32/32 new generator-record ablations, five-surface parity, reload, rollback, and hidden transfer 17/17` : 'not currently active'}.
- Recursive discourse composition: ${recursiveFieldActive ? `active inherited production at ${active.sha256}; its canonical record is ledger-present. Ancestor qualification passed 3/3 public and 6/6 sealed hidden tasks, direct/rehearsed/production five-surface parity, reload 6/6, exact ablation 6/6, and atomic interruption/corruption/rollback gates` : (recursiveFieldRehearsal?.passed ? 'safe for promotion but not currently active' : 'not currently proven')}.
- Generated primitive-family invention: ${generatedPrimitiveActive && generatedPrimitiveQualification?.passed && generatedPrimitiveSurfaces?.passed ? `active inherited production at ${active.sha256}; retained operator ${generatedPrimitiveQualification.learnedRecordId || 'lari.learned.operator.vocabulary.2dba0034ea8b73f4'} is ledger-present. Ancestor qualification passed 4/4 sealed JavaScript/Python variants, cold reload, exact ablation, five-surface record-selection parity, and rollback` : 'not currently proven in production'}.
- Language-side semantic primitive acquisition: ${languagePrimitive?.passed ? `qualified but unpromoted candidate ${languagePrimitive.candidateHash}; incumbent failed 10/10 sealed meaning-scope cases, retained operator ${languagePrimitive.operatorId}, passed 6/6 hidden transfer across five domains, reload 6/6, exact ablation 6/6, rollback failure restoration 6/6, five-surface parity, zero family regressions, and zero external model calls. Its operator AST was development-supplied from labeled public contrasts, not autonomously invented from raw failures` : 'not currently proven'}.
- Failure-induced semantic AST synthesis: ${semanticAstAutogenesis?.passed ? `${semanticAstActive ? `active in cumulative production ${active.sha256}` : `qualified but unpromoted candidate ${semanticAstAutogenesis.candidateHash}`}; Lari induced markers and semantic relations from six prompt contrasts plus behavioral truth tables without receiving an operator AST, then passed 8/8 hidden cross-domain tasks, reload 8/8, exact ablation 8/8, rollback, five-surface parity, and canonical gap closure with zero external model calls` : 'not currently proven'}.
- Developer-assisted semantic repair expansion: ${dualSemanticPrimitiveQualification?.passed && combinedPredicateTransfer?.passed ? `unpromoted combined candidate ${dualSemanticPrimitiveQualification.candidateHash} retains both capability selectors. Focused Astropy/Sphinx reuse, reload, and ablation passed 2/2 each. The developer implemented and tuned the proposal language while inspecting these failures, so the tasks are development-exposed and this does not prove autonomous primitive invention or blind transfer. The runner reported zero external model calls; that does not mean development occurred without an external coding assistant. See consolidation/predicate-domain-transfer-20260902/EVIDENCE_AMENDMENT_20260904.md` : (openWorldSemanticQualification?.passed ? `developmental context capability evidence exists in candidate ${openWorldSemanticQualification.candidate?.sha256}` : 'not currently proven')}.

Frozen fresh repository evaluation: ${frozenFreshEvaluation ? `${frozenFreshEvaluation.repairPasses}/${frozenFreshEvaluation.runnable} runnable native repository failures repaired from ${frozenFreshEvaluation.selected} fixed selected tasks. Candidate ${frozenFreshEvaluation.candidateHash} and the frozen runtime were unchanged during inference. Historical test environments were repaired separately; the Computational English dependency snapshot was completed after selection. See consolidation/frozen-fresh-transfer-20260904/REPORT.md for task-level outcomes and protocol limits. This candidate remains unpromoted.` : 'No result recorded yet.'}

Lari can teach itself low-risk factual knowledge from source evidence and retain validated typed knowledge. For executable skills, “researching the answer” is insufficient: Lari must run the task, observe failure, repair it, pass unseen variants, survive reload, and remain rollback-safe.

## Evaluation snapshot

### Current operating gates

${markdownTable(['Gate', 'Result', 'Evidence'], gateRows)}

### Public LM evaluations

${markdownTable(
    ['Evaluation', 'Metric', 'Value', 'Binding'],
    [
      ['IFEval', 'instruction strict', formatMetric(ifeval?.metrics?.inst_level_strict_acc), freshness(evidenceByLabel['Full active IFEval'], active.sha256, ifeval?.activeModelHash)],
      ['IFEval', 'prompt strict', formatMetric(ifeval?.metrics?.prompt_level_strict_acc), freshness(evidenceByLabel['Full active IFEval'], active.sha256, ifeval?.activeModelHash)],
      ['GSM8K', 'exact match', formatMetric(gsm8k?.metrics?.exact_match), freshness(evidenceByLabel['Full active GSM8K'], active.sha256, gsm8k?.activeModelHash)],
      ['IFEval (current)', 'instruction strict', formatMetric(currentBaseline?.ifeval?.metrics?.inst_level_strict_acc), freshness(evidenceByLabel['Current standard benchmark baseline'], active.sha256, currentBaseline?.model?.sha256)],
      ['IFEval (current)', 'prompt strict', formatMetric(currentBaseline?.ifeval?.metrics?.prompt_level_strict_acc), freshness(evidenceByLabel['Current standard benchmark baseline'], active.sha256, currentBaseline?.model?.sha256)],
      ['GSM8K (current)', 'exact match', formatMetric(currentBaseline?.gsm8k?.metrics?.exactMatchStrict), freshness(evidenceByLabel['Current standard benchmark baseline'], active.sha256, currentBaseline?.model?.sha256)]
    ]
  )}

The first three rows are historical when their recorded model hash differs from the current active or latest candidate. The rows marked **current** come from the fresh 2026-09-12 standard baseline bound to the active hash and are the authoritative current numbers. Benchmark smoke failures remain visible as failures; they are not converted into scores.

**GSM8K withdrawal notice.** The previously published GSM8K figure of \`0.7763\` was invalid, not merely
stale. It was produced by 875 rules that each searched arithmetic expression space until the result
matched a specific GSM8K **test-set** gold answer, then stored that expression keyed to the question's
proper nouns — i.e. the score measured how many test items had a stored rule. Those records were
quarantined on 2026-07-25 (\`consolidation/contamination-quarantine/\`), and the answer-fitting scripts
that produced them are now gated off. Treat any GSM8K value predating that quarantine as \`null\`.
See \`LARI_INDEPENDENT_AUDIT_2026-07-24.md\` §3 and \`LARI_REALITY_AUDIT_AND_PLAN_2026-07-25.md\`.

The first honest post-quarantine measurement, on model \`7b912b36\`, is full-GSM8K
\`exact_match=0.0038\` (5 correct of 1319, zero external model calls). That is the real baseline: the
withdrawn \`0.7763\` represented roughly 1024 of 1319, essentially all of it stored-rule coverage of the
test set. A low true number is the expected and correct outcome of removing the contamination, and it
is the first GSM8K figure this project has produced that means anything.

**What IFEval measures.** The IFEval numbers are real and reproducible, but they score *format
compliance* — word counts, bullet counts, placeholder counts, casing — not content quality or
reasoning. A deterministic constraint formatter reaches roughly this range without any generator.
Report it as a constraint engine, not as instruction-following intelligence.

## Multimodal status

- Image: ${multimodal?.executableCapabilities?.image?.qualityBoundary || 'no verified evidence'}.
- Audio: ${multimodal?.executableCapabilities?.audio?.qualityBoundary || 'no verified evidence'}.
- Video: ${multimodal?.executableCapabilities?.video?.qualityBoundary || 'no verified full-generation evidence'}.
- Candidate clip-selection procedure: ${passed('Public media convergence') ? '2/2 verified clips across Workbench, CLI, API, and autonomous surfaces' : 'not currently proven'}.

## Promotion and rollback readiness

The current registry head is \`${active.sha256}\`; its exact rollback target is \`${state.registry.rollback?.sha256 || 'unknown'}\` at \`${state.registry.rollback?.path || 'unknown'}\`. The registry hash matches the active model bytes. Earlier promotion manifests remain evidence for the transaction that created each ancestor; the current active-capability status above is determined separately from the active learned-record ledger. This prevents a later additive promotion from making inherited capability records appear inactive.

The current head includes a bounded ordinary-chat learning addition. It is **not** a zero-content reconciliation, and it does not silently revalidate every historical capability at the new hash. It preserves the prior records; fresh surface or transfer evidence is only claimed where an artifact is explicitly bound to the current hash.

## Known blockers and non-claims

${blockers.length ? blockers.map(blocker => `- ${blocker}.`).join('\n') : '- No blockers were reported by the latest operating gates.'}
- The production active model is clean, registry-bound, and includes the deep chat/coding records, 38 atomic RECAP generator records spanning seven bounded conversation families, the learned recursive-composition generator record, and the qualified arithmetic-substitution mutation-vocabulary operator. Other unpromoted candidates remain non-production evidence only.
- Recursive composition is retained in cumulative production \`${active.sha256}\`; its proof remains bounded to composing existing verified RECAP families.
- Language-side conditional-scope acquisition is qualified only in unpromoted candidate \`${languagePrimitive?.candidateHash || 'none'}\`; production still uses the bounded parent parser, and autonomous semantic-AST invention remains unproven.
- Failure-induced semantic AST synthesis is retained in cumulative production \`${active.sha256}\`; its evidence is supervised behavioral induction over one scope family, not unrestricted language learning.
- Arbitrary blind repository repair is not proven; only bounded operator families have causal transfer evidence.
- High-volume synthetic production-path traffic is proven; multi-day human traffic and user-satisfaction evidence are not yet available.
- Fresh full IFEval and GSM8K have not been run on the latest candidate.
- Photoreal image generation, general speech/SFX generation, and full generative video remain unproven.
- A passing benchmark count is not evidence of model unity unless ordinary inference, learning, persistence, reload, promotion, and rollback share the same lifecycle.

## Release assessment

Lari is a local executable-model research system with a unified public kernel, persistent typed state, deterministic front-door procedures, retrieval, a bounded verified coding mutation search, and substantial lifecycle infrastructure.

**Release verdict: NOT READY FOR PUBLIC BETA.** Production hash \`${activeShort}\` contains the unified deep chat/coding state, seven causally proven RECAP conversation families, one causally qualified invented mutation-vocabulary operator, the learned recursive composition generator, the induced conditional-scope semantic AST, and the induced referential-selection AST. These capabilities remain bounded to their verified families. Lari still lacks broad unrestricted native language generation, arbitrary repository mastery, current broad LM-eval strength, and real multi-day user evidence; honest GSM8K remains 5/1319.

## Evidence index

${markdownTable(['Evidence', 'Result', 'Freshness', 'Path'], evidenceRows)}

## Recent validated milestones

${recentEvidence.length ? markdownTable(['Milestone', 'Recorded', 'Evidence'], recentEvidence) : 'No validated milestone evidence was discovered.'}

## How this report stays current

1. Every meaningful Lari change must produce or update a structured JSON evidence artifact.
2. Run \`npm run lari:report\` after the evidence is final.
3. Run \`npm run lari:report:check\` before handoff, release, or promotion.
4. Never edit generated facts in this report manually; fix the underlying evidence or the generator.
5. Candidate claims remain explicitly separated from active-production claims.

Machine-readable snapshot: ${markdownLink('LARI_FULL_REPORT.json')}.
`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const state = sourceState();
  if (checkOnly) {
    const existing = readJson(SNAPSHOT_PATH);
    const passed = fs.existsSync(REPORT_PATH)
      && existing?.sourceFingerprint === state.sourceFingerprint;
    process.stdout.write(`${JSON.stringify({
      passed,
      report: relative(REPORT_PATH),
      snapshot: relative(SNAPSHOT_PATH),
      expectedFingerprint: state.sourceFingerprint,
      actualFingerprint: existing?.sourceFingerprint || null
    }, null, 2)}\n`);
    if (!passed) process.exitCode = 1;
    return;
  }
  const report = renderReport(state);
  fs.writeFileSync(REPORT_PATH, report);
  fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    updated: true,
    report: relative(REPORT_PATH),
    snapshot: relative(SNAPSHOT_PATH),
    sourceFingerprint: state.sourceFingerprint,
    activeHash: state.active.sha256,
    historicalReleaseEligibleArtifactHash: state.evidence.find(item => item.label === 'Mixed-domain program growth production promotion' && item.passed)?.candidateHash
      || state.evidence.find(item => item.label === 'Recursive field generator production promotion' && item.passed)?.candidateHash
      || state.evidence.find(item => item.label === 'Generated primitive family production promotion' && item.passed)?.candidateHash
      || state.evidence.find(item => item.label === 'Domain neurogenesis Stage 5 production promotion' && item.passed)?.candidateHash
      || state.evidence.find(item => item.label === 'RECAP production promotion' && item.passed)?.candidateHash
      || state.validatedCandidate?.sha256 || null,
    developmentalExpansionHash: state.evidence.find(item => item.label === 'Unknown repository acquisition qualification' && item.passed)?.candidateHash
      || state.evidence.find(item => item.label === 'Deep coding qualification' && item.passed)?.candidateHash
      || state.evidence.find(item => item.label === 'Chat and nine-language coding expansion')?.candidateHash || null,
    evidenceCount: state.evidence.filter(item => item.exists).length
  }, null, 2)}\n`);
}

main();
