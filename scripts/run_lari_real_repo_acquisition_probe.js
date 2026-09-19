#!/usr/bin/env node
'use strict';

/*
 * Candidate-only evidence runner for one exposed, real repository failure.
 *
 * This is deliberately a protocol adapter, not a repair implementation.  It
 * copies the supplied workspace, runs the existing public kernel against the
 * copy, and serializes a candidate only if a new typed learned record clears
 * fail-before/pass-after and immutability gates.  The active model and
 * registry are fingerprints, never write targets.
 *
 * Usage:
 *   node scripts/run_lari_real_repo_acquisition_probe.js \
 *     --config task.json --workspace repo-copy --out consolidation/new-attempt \
 *     [--python C:\\path\\to\\python.exe] [--target package/module.py]
 *
 * The config follows the existing frozen-transfer shape: id, prompt,
 * selectors, passToPass, and optionally oracleFiles.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');

function usage(message = '') {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node scripts/run_lari_real_repo_acquisition_probe.js --config <task.json> --workspace <repo> --out <new-output-dir> [--python <python.exe>] [--target <source-file>] [--no-research | --research-required]\n');
  process.exitCode = 2;
}

function parseArgs(argv) {
  const parsed = { noResearch: false, researchRequired: false };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--no-research') {
      parsed.noResearch = true;
      continue;
    }
    if (key === '--research-required') {
      parsed.researchRequired = true;
      continue;
    }
    if (!key.startsWith('--')) {
      usage(`Unexpected argument: ${key}`);
      return null;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      usage(`Missing value for ${key}`);
      return null;
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }
  for (const name of ['config', 'workspace', 'out']) {
    if (!parsed[name]) {
      usage(`Missing --${name}`);
      return null;
    }
  }
  if (parsed.noResearch && parsed.researchRequired) {
    usage('--no-research and --research-required cannot be used together');
    return null;
  }
  return parsed;
}

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shaFile(file) {
  return sha(fs.readFileSync(file));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function compact(value, limit = 5000) {
  const text = String(value || '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sourceTreeHashes(root) {
  const ignored = new Set(['.git', '.lari-test-tmp', '.external-test-tmp', '.pytest_cache', '__pycache__', '.mypy_cache']);
  const rows = {};
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        const rel = path.relative(root, absolute).replace(/\\/g, '/');
        rows[rel] = shaFile(absolute);
      }
    }
  }
  return Object.fromEntries(Object.entries(rows).sort(([left], [right]) => left.localeCompare(right)));
}

function copyWorkspace(source, destination) {
  const ignored = new Set(['.git', '.lari-test-tmp', '.external-test-tmp', '.pytest_cache', '__pycache__', '.mypy_cache']);
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: from => !ignored.has(path.basename(from))
  });
}

function pythonEnvironment(workspace, python) {
  const temp = path.join(workspace, '.external-test-tmp');
  fs.mkdirSync(temp, { recursive: true });
  const pythonDirectory = python ? path.dirname(python) : null;
  const inheritedPath = process.env.Path || process.env.PATH || '';
  const combinedPath = pythonDirectory
    ? `${pythonDirectory}${path.delimiter}${inheritedPath}`
    : inheritedPath;
  return {
    ...process.env,
    PATH: combinedPath,
    Path: combinedPath,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PYTHONPATH: workspace,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    CI: '1',
    NO_COLOR: '1'
  };
}

function runPytest(workspace, python, selectors) {
  const executable = python || 'python';
  const result = spawnSync(executable, ['-m', 'pytest', '-q', '--maxfail=1', '--disable-warnings', '--tb=short', ...selectors], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 1024 * 1024,
    env: pythonEnvironment(workspace, python)
  });
  return {
    passed: result.status === 0,
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    output: compact(`${result.stdout || ''}${result.stderr || ''}`, 12000)
  };
}

function summarizeResponse(response, model) {
  const event = model.lariDefaultFailureLearning?.events?.[0] || null;
  const failureTrace = (response.trace || []).find(item => item.phase === 'default_failure_learning') || null;
  const researchTrace = (response.trace || []).filter(item => item.phase === 'failure_research').at(-1) || null;
  const selected = (response.trace || []).find(item => item.phase === 'selected_capability_execution') || null;
  return {
    passed: response.passed === true,
    action: response.action || null,
    modelHash: response.modelHash || null,
    intent: response.intent || null,
    executionBinding: response.executionBinding || null,
    transientDiagnostics: response.transientDiagnostics || null,
    selectedCapability: selected ? {
      skillId: selected.skillId || null,
      learnedRecordId: selected.learnedRecordId || null,
      executed: selected.executed === true,
      verified: selected.verified === true
    } : null,
    failureLearning: event ? {
      passed: event.passed === true,
      reason: event.reason || null,
      language: event.language || null,
      repairKind: event.repairKind || null,
      retainedPatternId: event.retainedPatternId || null,
      diagnosticHypothesisId: event.frontierFallback?.diagnosticHypothesisId || null,
      relaxationScopes: event.frontierFallback?.relaxationScopes || [],
      expressionRepair: event.frontierFallback?.expressionRepair || null,
      rollback: event.rollback || null
    } : (failureTrace || null),
    research: researchTrace ? {
      attempted: researchTrace.attempted === true,
      sourceCount: Number(researchTrace.sourceCount || 0),
      sourceUrls: Array.isArray(researchTrace.sources) ? researchTrace.sources : [],
      verified: researchTrace.verified === true,
      error: researchTrace.error || null
    } : null,
    externalModelCalls: Number(response.external_model_calls || 0),
    answer: compact(response.answer || '', 800)
  };
}

function stripTransientCandidateState(parent, learnedModel, newRecordIds, activeHash) {
  const candidate = clone(parent);
  const learnedRecords = learnedModel.lariLearnedRecords?.records || [];
  candidate.lariLearnedRecords = clone(learnedModel.lariLearnedRecords || parent.lariLearnedRecords || { schemaVersion: 1, records: [] });
  // The only learned state admitted here is the canonical typed-record store.
  // Request/session traces, test artifacts, and one-off failure reports stay
  // outside the live model candidate.
  candidate.lariDefaultFailureLearning = clone(parent.lariDefaultFailureLearning || { events: [], reports: [] });
  candidate.lariSessionRuntime = clone(parent.lariSessionRuntime || {});
  candidate.mutations = clone(parent.mutations || []);
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: activeHash,
    developmentalEvent: 'candidate_only_exposed_repository_failure_acquisition',
    learnedRecordIds: [...newRecordIds].sort(),
    createdAt: new Date().toISOString(),
    promoted: false
  };
  runtime.buildLariCapabilityGraph(candidate, {});
  return { candidate, learnedRecords };
}

async function runKernelWithPortablePython(model, request, context, python) {
  const beforePath = process.env.Path;
  const beforePATH = process.env.PATH;
  if (python) {
    const portableDirectory = path.dirname(python);
    const joined = `${portableDirectory}${path.delimiter}${beforePath || beforePATH || ''}`;
    process.env.Path = joined;
    process.env.PATH = joined;
  }
  try {
    return await runtime.sendMessageToLariAsync(model, request, context);
  } finally {
    if (beforePath === undefined) delete process.env.Path;
    else process.env.Path = beforePath;
    if (beforePATH === undefined) delete process.env.PATH;
    else process.env.PATH = beforePATH;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args) return;
  const researchRequired = args.researchRequired === true;
  const configPath = path.resolve(args.config);
  const sourceWorkspace = path.resolve(args.workspace);
  const out = path.resolve(args.out);
  const python = args.python ? path.resolve(args.python) : null;
  assert(fs.existsSync(configPath), `Missing config: ${configPath}`);
  assert(fs.existsSync(sourceWorkspace), `Missing workspace: ${sourceWorkspace}`);
  assert(!fs.existsSync(out), `Refusing to overwrite output: ${out}`);
  assert(fs.existsSync(ACTIVE) && fs.existsSync(REGISTRY), 'Active model or registry is missing.');
  if (python) assert(fs.existsSync(python), `Missing Python executable: ${python}`);

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const selectors = Array.isArray(config.selectors) ? config.selectors.filter(Boolean) : [];
  assert(config.id && config.prompt && selectors.length, 'Config must include id, prompt, and selectors.');
  const testPath = selectors[0].split('::')[0].replace(/\\/g, '/');
  const oracleFiles = Array.isArray(config.oracleFiles) && config.oracleFiles.length
    ? config.oracleFiles
    : [...new Set(selectors.map(selector => selector.split('::')[0].replace(/\\/g, '/')))];
  const protectedBefore = {
    active: shaFile(ACTIVE),
    registry: shaFile(REGISTRY),
    runtime: shaFile(path.join(ROOT, 'swarm_model_runtime.js')),
    mutationRepair: shaFile(path.join(ROOT, 'swarm_mutation_repair.js')),
    researchCapability: shaFile(path.join(ROOT, 'swarm_research_to_capability.js')),
    config: shaFile(configPath),
    sourceWorkspace: sha(JSON.stringify(sourceTreeHashes(sourceWorkspace)))
  };
  const parent = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const parentRecordIds = new Set((parent.lariLearnedRecords?.records || []).map(record => record.id));

  fs.mkdirSync(out, { recursive: true });
  const workspace = path.join(out, 'workspace');
  copyWorkspace(sourceWorkspace, workspace);
  const workspaceBefore = sourceTreeHashes(workspace);
  const oracleBefore = Object.fromEntries(oracleFiles.map(file => [file, shaFile(path.join(workspace, file))]));
  const externalBaseline = runPytest(workspace, python, selectors);

  const sharedFailureLearning = {
    modelHash: protectedBefore.active,
    sourcePath: 'candidate_only_exposed_repository_failure',
    benchmarkAssociation: [],
    allowExpressionOperatorDiscovery: !researchRequired,
    allowSemanticOperatorDiscovery: !researchRequired,
    allowPrimitiveDiscovery: !researchRequired,
    coordinatedProgramSearch: !researchRequired,
    expressionSearch: !researchRequired,
    identityPreservingRepairSearch: !researchRequired,
    progressiveRelaxation: true,
    maxIterations: args['max-iterations'] === undefined ? 3 : Number(args['max-iterations']),
    expressionCandidateLimit: args['candidate-limit'] === undefined ? 64 : Number(args['candidate-limit']),
    mutationCandidateLimit: 96,
    mutationProposalLimit: 12,
    taskTimeoutMs: 8 * 60 * 1000,
    testTimeoutMs: 90 * 1000
  };
  const request = {
    id: `candidate-only.${config.id}`,
    mode: 'code',
    subintent: 'code.fix',
    prompt: config.prompt,
    workspaceRoot: workspace,
    testPath,
    testRunner: 'python.pytest',
    testSelectors: selectors,
    tests: [{ path: testPath, runner: 'python.pytest', selectors }],
    preserveLayout: true,
    ...(args.target ? { expressionTarget: String(args.target).replace(/\\/g, '/') } : {})
  };
  const context = {
    modelHash: protectedBefore.active,
    autoGrow: false,
    groundedFactual: !args.noResearch,
    failureResearch: !args.noResearch,
    groundingTimeoutMs: 12000,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      includeTransientDiagnostics: true,
      capabilityGraph: { minScore: 0 },
      failureLearning: sharedFailureLearning,
      executionContract: {
        ...sharedFailureLearning,
        workspaceExecution: { ...sharedFailureLearning }
      }
    }
  };
  const learnedModel = clone(parent);
  const response = await runKernelWithPortablePython(learnedModel, request, context, python);
  const externalAfter = runPytest(workspace, python, selectors);
  const oracleAfter = Object.fromEntries(oracleFiles.map(file => [file, shaFile(path.join(workspace, file))]));
  const workspaceAfter = sourceTreeHashes(workspace);
  const newRecords = (learnedModel.lariLearnedRecords?.records || [])
    .filter(record => !parentRecordIds.has(record.id));
  const learnedRecordIds = newRecords.map(record => record.id);
  const protectedAfter = {
    active: shaFile(ACTIVE),
    registry: shaFile(REGISTRY),
    runtime: shaFile(path.join(ROOT, 'swarm_model_runtime.js')),
    mutationRepair: shaFile(path.join(ROOT, 'swarm_mutation_repair.js')),
    researchCapability: shaFile(path.join(ROOT, 'swarm_research_to_capability.js')),
    config: shaFile(configPath),
    sourceWorkspace: sha(JSON.stringify(sourceTreeHashes(sourceWorkspace)))
  };
  const responseSummary = summarizeResponse(response, learnedModel);
  const gates = {
    sourceTaskFailedBeforeLearning: externalBaseline.passed === false,
    canonicalPublicKernelUsed: responseSummary.action === 'default_failure_learning',
    diagnosticHypothesisObserved: Boolean(responseSummary.failureLearning?.diagnosticHypothesisId),
    failBeforePassAfter: externalBaseline.passed === false && response.passed === true && externalAfter.passed === true,
    oracleImmutable: JSON.stringify(oracleBefore) === JSON.stringify(oracleAfter),
    activeAndRegistryReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    workspaceChangedOnlyAfterVerifiedRepair: response.passed === true ? JSON.stringify(workspaceBefore) !== JSON.stringify(workspaceAfter) : JSON.stringify(workspaceBefore) === JSON.stringify(workspaceAfter),
    newCanonicalTypedRecord: newRecords.some(record => record.status === 'active' && ['operator', 'procedure', 'repair'].includes(record.type)),
    noExternalModelCalls: responseSummary.externalModelCalls === 0,
    sourceResearchAttempted: args.noResearch ? true : responseSummary.research?.attempted === true,
    sourceResearchUsed: args.noResearch ? false : Number(responseSummary.research?.sourceCount || 0) > 0,
    researchEvidenceRetrieved: !researchRequired || Number(responseSummary.research?.sourceCount || 0) > 0,
    researchEvidenceBoundToRetainedRecord: !researchRequired || newRecords.some(record => record.status === 'active'
      && Array.isArray(record.provenance?.researchSources)
      && record.provenance.researchSources.some(source => responseSummary.research?.sourceUrls?.includes(source?.url)))
  };
  const canSerializeCandidate = gates.sourceTaskFailedBeforeLearning
    && gates.canonicalPublicKernelUsed
    && gates.diagnosticHypothesisObserved
    && gates.failBeforePassAfter
    && gates.oracleImmutable
    && gates.activeAndRegistryReadOnly
    && gates.workspaceChangedOnlyAfterVerifiedRepair
    && gates.newCanonicalTypedRecord
    && gates.noExternalModelCalls
    && gates.researchEvidenceRetrieved
    && gates.researchEvidenceBoundToRetainedRecord;
  let candidate = null;
  let candidatePath = null;
  if (canSerializeCandidate) {
    const prepared = stripTransientCandidateState(parent, learnedModel, learnedRecordIds, protectedBefore.active);
    const bytes = Buffer.from(`${JSON.stringify(prepared.candidate, null, 2)}\n`);
    const candidateHash = sha(bytes);
    candidatePath = path.join(out, 'candidates', `${candidateHash}.json`);
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
    try { fs.chmodSync(candidatePath, 0o444); } catch (_) {}
    candidate = {
      path: relative(candidatePath),
      sha256: candidateHash,
      immutable: shaFile(candidatePath) === candidateHash,
      promoted: false,
      learnedRecordIds
    };
  }
  const report = {
    schemaVersion: 1,
    kind: 'lari.candidate_only.real_repository_acquisition_probe',
    createdAt: new Date().toISOString(),
    task: {
      id: config.id,
      configPath: relative(configPath),
      sourceWorkspace: relative(sourceWorkspace),
      copiedWorkspace: relative(workspace),
      declaredTestPath: testPath,
      selectors,
      explicitTarget: args.target ? String(args.target).replace(/\\/g, '/') : null,
      exposure: 'development-only; not a hidden holdout',
      learningPolicy: {
        researchRequired,
        researchDisabled: args.noResearch === true,
        allowExpressionOperatorDiscovery: sharedFailureLearning.allowExpressionOperatorDiscovery,
        allowSemanticOperatorDiscovery: sharedFailureLearning.allowSemanticOperatorDiscovery,
        allowPrimitiveDiscovery: sharedFailureLearning.allowPrimitiveDiscovery,
        coordinatedProgramSearch: sharedFailureLearning.coordinatedProgramSearch,
        expressionSearch: sharedFailureLearning.expressionSearch,
        identityPreservingRepairSearch: sharedFailureLearning.identityPreservingRepairSearch
      }
    },
    parent: { path: relative(ACTIVE), sha256: protectedBefore.active },
    protectedBefore,
    protectedAfter,
    baseline: externalBaseline,
    response: responseSummary,
    after: externalAfter,
    oracle: { before: oracleBefore, after: oracleAfter, unchanged: JSON.stringify(oracleBefore) === JSON.stringify(oracleAfter) },
    workspace: { beforeHash: sha(JSON.stringify(workspaceBefore)), afterHash: sha(JSON.stringify(workspaceAfter)), changed: JSON.stringify(workspaceBefore) !== JSON.stringify(workspaceAfter) },
    learnedRecords: newRecords.map(record => ({
      id: record.id,
      type: record.type,
      status: record.status,
      operation: record.payload?.operation || null,
      primitive: record.payload?.primitive || null,
      provenance: record.provenance || null
    })),
    candidate,
    gates,
    candidateSerialized: canSerializeCandidate,
    verdict: canSerializeCandidate
      ? 'candidate_created_unpromoted'
      : 'candidate_not_created_insufficient_verified_evidence',
    limitations: [
      'This task was already exposed to development and is not a hidden-transfer result.',
      researchRequired
        ? 'This candidate can serialize only when retrieved source metadata is bound to the native-test-verified learned record.'
        : 'Source research is reported separately from repair; a successful repair without retrieved evidence is not labeled research-to-executable learning.',
      'No active model, registry, source workspace, or task oracle is an output target of this runner.'
    ]
  };
  const reportPath = path.join(out, 'probe-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, report: relative(reportPath), candidate: report.candidate, gates: report.gates }, null, 2)}\n`);
  if (!canSerializeCandidate) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
