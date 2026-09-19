#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const registry = require('./lari_model_registry.js');

const root = registry.root;

function readJson(relativePath) {
  const resolved = path.join(root, relativePath);
  if (!fs.existsSync(resolved)) return null;
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function count(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function modelStats(model) {
  return {
    modelName: model.modelName || model.modelDisplayName || 'Lari',
    schemaVersion: model.schemaVersion || null,
    generation: model.generation || null,
    skills: count(model.skills),
    compiledSkills: count(model.compiledSkills),
    mutations: count(model.mutations),
    requests: count(model.lariAutonomousRequests),
    modalityRegistryEntries: count(model.lariModalityRegistry),
    unifiedRuntimeEvents: count(model.lariUnifiedRuntimeEvents)
  };
}

function reportSummary(relativePath) {
  const resolved = path.join(root, relativePath);
  const report = readJson(relativePath);
  if (!report) return null;
  const stat = fs.statSync(resolved);
  const generatedAt = report.generatedAt || report.completedAt || report.created || stat.mtime.toISOString();
  const ageMs = Math.max(0, Date.now() - new Date(generatedAt).getTime());
  const officialEvaluation = report.officialEvaluation || null;
  const officialPassed = officialEvaluation
    ? Number(officialEvaluation.completed || 0) > 0
      && Number(officialEvaluation.resolved || 0) === Number(officialEvaluation.completed || 0)
      && Number(officialEvaluation.errors || 0) === 0
    : null;
  return {
    benchmark: report.benchmark || report.kind,
    passed: report.passed ?? officialPassed,
    verdict: report.verdict || report.readinessLevel || null,
    score: report.weightedScore ?? report.score ?? (officialEvaluation ? Number(officialEvaluation.resolved || 0) / Math.max(1, Number(officialEvaluation.completed || 0)) : null),
    passedCount: report.passedCount ?? report.summary?.passedCount ?? officialEvaluation?.resolved ?? null,
    gateCount: report.gateCount ?? report.summary?.gateCount ?? report.summary?.checkCount ?? report.summary?.taskCount ?? report.laneCount ?? officialEvaluation?.completed ?? null,
    blockers: report.blockers || report.launchBlockers || [],
    externalModelCalls: report.externalModelCalls ?? report.external_model_calls ?? null,
    modelHash: report.modelHash || report.candidate?.sha256 || report.failureDrivenLearning?.candidateSha256 || null,
    generatedAt,
    ageMs,
    stale: !Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000,
    path: relativePath
  };
}

const loaded = registry.loadLariModel();
const currentStats = modelStats(loaded.model);
const currentPath = loaded.resolved.relativePath || loaded.resolved.id;
const currentBytes = loaded.resolved.path && fs.existsSync(loaded.resolved.path)
  ? fs.statSync(loaded.resolved.path).size
  : 0;
const currentHash = loaded.resolved.path && fs.existsSync(loaded.resolved.path)
  ? crypto.createHash('sha256').update(fs.readFileSync(loaded.resolved.path)).digest('hex')
  : null;
const registryState = registry.readLariModelRegistry();
const declaredActiveHash = registryState?.activeModelSha256 || registryState?.metadata?.candidateHash || null;
const contaminationIndex = readJson('consolidation/recovery/contaminated-artifact-index.json');
const recoveryManifest = readJson('consolidation/recovery/truth-recovery-manifest.json');
const lineageMatches = Boolean(currentHash && declaredActiveHash && currentHash === declaredActiveHash);
const rollbackPath = registryState?.previousModelPath
  ? (path.isAbsolute(registryState.previousModelPath)
      ? registryState.previousModelPath
      : path.join(root, registryState.previousModelPath))
  : null;
const rollbackModel = rollbackPath && fs.existsSync(rollbackPath)
  ? JSON.parse(fs.readFileSync(rollbackPath, 'utf8'))
  : null;
const rollbackEligible = Boolean(
  rollbackModel
  && registry.countStoredBenchmarkAnswerMarkers(rollbackModel) === 0
);

const status = {
  model: {
    activePath: currentPath,
    source: loaded.resolved.source,
    bytes: currentBytes,
    sha256: currentHash,
    ...currentStats
  },
  registry: registryState,
  integrity: {
    declaredActiveHash,
    activeHash: currentHash,
    lineageMatches,
    contaminatedCandidatesQuarantined: contaminationIndex?.artifactCount || 0,
    rollbackEligible,
    cleanRecoveryCandidate: recoveryManifest?.recoveryCandidate || null
  },
  gates: {
    truth: reportSummary('benchmarks/latest-lari-public-truth-gate-report.json'),
    eval: reportSummary('benchmarks/latest-lari-model-control-plane-report.json'),
    smoke: reportSummary('benchmarks/latest-lari-first-run-product-smoke-report.json'),
    soak: reportSummary('benchmarks/latest-lari-product-soak-report.json'),
    traffic: reportSummary('consolidation/release-readiness/latest-lari-release-traffic-proof.json'),
    train: reportSummary('benchmarks/latest-lari-release-training-gate-report.json'),
    launch: reportSummary('benchmarks/latest-lari-alpha-launch-gauntlet-report.json'),
    frontier: reportSummary('benchmarks/latest-lari-frontier-launch-readiness-report.json'),
    swebenchOfficial: reportSummary('benchmarks/tmp-lari-swebench-multirepo-20260714/multi-repo-official-report.json'),
    frozenRepositoryAcceptance: reportSummary('consolidation/real-repository-acceptance-20260722/result.json')
  },
  release: {
    ready: false,
    classification: 'experimental executable-model research system',
    blockers: [
      ...(lineageMatches ? [] : ['active model hash does not match the registry-declared promoted hash']),
      'general chat has no broad native text generator',
      'honest GSM8K exact match is 5/1319',
      'completed mechanical sealed coding sets remain 0/6 and 0/6',
      'no clean candidate has explicit sealed unseen-capability release evidence',
      ...(rollbackEligible ? [] : ['no clean verified rollback target is available'])
    ]
  },
  canonicalCommands: {
    ask: 'npm run lari:ask -- "Ask Lari something"',
    eval: 'npm run lari:eval',
    train: 'npm run lari:train',
    launchCheck: 'npm run lari:launch-check',
    smoke: 'npm run lari:smoke',
    soak: 'npm run lari:soak',
    traffic: 'npm run lari:traffic-proof',
    truth: 'npm run lari:truth',
    fullReport: 'npm run lari:report'
  }
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
} else {
  const train = status.gates.train;
  const truth = status.gates.truth;
  const evalGate = status.gates.eval;
  const smoke = status.gates.smoke;
  const soak = status.gates.soak;
  const traffic = status.gates.traffic;
  const launch = status.gates.launch;
  const swebenchOfficial = status.gates.swebenchOfficial;
  const frozenRepositoryAcceptance = status.gates.frozenRepositoryAcceptance;
  const blockerMap = new Map();
  [...(launch?.blockers || []), ...(train?.blockers || []), ...(frozenRepositoryAcceptance?.blockers || [])].forEach(blocker => {
    const text = String(blocker || '').trim().replace(/[.;]+$/, '');
    const key = /swe-bench/i.test(text) && /official|credential/i.test(text)
      ? 'official-swe-bench'
      : text.toLowerCase();
    if (text && !blockerMap.has(key)) blockerMap.set(key, text);
  });
  const blockers = [...blockerMap.values()].filter(blocker => {
    if (swebenchOfficial?.passed && /swe-bench/i.test(String(blocker || '')) && /official|credential/i.test(String(blocker || ''))) return false;
    return true;
  });
  const gateText = gate => gate
    ? `${gate.passed ? 'pass' : 'fail'} ${gate.passedCount ?? '?'}/${gate.gateCount ?? '?'}${gate.stale ? ' (stale)' : ''}`
    : 'missing report';
  process.stdout.write([
    `Lari status`,
    `active: ${status.model.activePath} (${status.model.source}, ${Math.round(status.model.bytes / 1024 / 1024)} MB)`,
    `identity: ${status.integrity.lineageMatches ? 'registry hash matches active bytes' : `MISMATCH active=${status.model.sha256.slice(0, 12)} registry=${String(status.integrity.declaredActiveHash || 'missing').slice(0, 12)}`}`,
    `release: NOT READY (${status.release.classification})`,
    `model: ${status.model.compiledSkills} compiled skills, ${status.model.skills} skills, ${status.model.requests} retained requests`,
    `deterministic regression: ${gateText(truth)}`,
    `control-plane regression: ${gateText(evalGate)}`,
    `first-run contract regression: ${gateText(smoke)}`,
    `fixed-prompt regression: ${gateText(soak)}`,
    `synthetic availability: ${traffic?.passed ? `pass ${traffic.passedCount ?? 1200}/${traffic.gateCount ?? 1200} (8 repeated prompts; not capability)` : gateText(traffic)}`,
    `historical internal aggregate: ${train ? `${train.verdict || 'unknown'}; passed=${train.passed}; score=${train.score}` : 'missing report'}`,
    `historical alpha checklist: ${launch ? `${launch.passed ? 'pass' : 'fail'} ${launch.passedCount ?? '?'}/${launch.gateCount ?? '?'} score=${launch.score ?? '?'}` : 'missing report'}`,
    `swebench official proof: ${gateText(swebenchOfficial)}`,
    `frozen repo acceptance: ${gateText(frozenRepositoryAcceptance)}`,
    `full report: LARI_FULL_REPORT.md (refresh with npm run lari:report)`,
    `quarantined candidates: ${status.integrity.contaminatedCandidatesQuarantined}`,
    `release blockers: ${status.release.blockers.join('; ')}`,
    `historical blockers: ${blockers.length ? blockers.join('; ') : 'none recorded'}`
  ].join('\n') + '\n');
}
