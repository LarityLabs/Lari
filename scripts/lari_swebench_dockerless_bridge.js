#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'scripts', 'lari_swebench_remote_tool_config.example.json');
const MODEL_NAME = 'lari-local-html-swarm';
const CANONICAL_PATH = 'sendMessageToLari -> runLariUnifiedTaskKernel';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return fs.existsSync(filePath) ? sha256(fs.readFileSync(filePath)) : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseArgs(argv) {
  const args = { validateOnly: false, selfTest: false, reuseOnly: false };
  const aliases = {
    '--instances': 'instancesPath', '--workspace-map': 'workspaceMapPath', '--workspace-root': 'workspaceRoot',
    '--output': 'predictionsPath', '--provenance': 'provenancePath', '--manifest': 'manifestPath',
    '--model-path': 'modelPath', '--remote-config': 'remoteConfigPath', '--sb-cli-output': 'sbCliPredictionsPath',
    '--failure-report': 'failureReportPath', '--candidate-dir': 'candidateDir', '--candidate-report': 'candidateReportPath'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--validate-only') args.validateOnly = true;
    else if (token === '--self-test') args.selfTest = true;
    else if (token === '--reuse-only') args.reuseOnly = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else if (aliases[token]) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${token} requires a value.`);
      args[aliases[token]] = argv[++index];
    } else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Dockerless SWE-bench prediction bridge for Lari.',
    '',
    'Validate official-shaped input without credentials, uploads, workspaces, or inference:',
    '  node scripts/lari_swebench_dockerless_bridge.js --instances <instances.jsonl> --validate-only --manifest <manifest.json>',
    '',
    'Generate predictions from isolated pinned checkouts:',
    '  node scripts/lari_swebench_dockerless_bridge.js --instances <instances.jsonl> --workspace-map <workspaces.json> --output <predictions.jsonl> --provenance <provenance.jsonl> --manifest <manifest.json> [--sb-cli-output <predictions.json>] [--reuse-only]',
    '',
    'Run the fully offline local contract proof:',
    '  node scripts/lari_swebench_dockerless_bridge.js --self-test',
    '',
    'The bridge never starts Modal, SWE-ReX, sb-cli, Docker, or an external model. Remote execution and evaluation remain explicit operator steps.'
  ].join('\n');
}

function readJsonOrJsonl(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  if (/^[\[{]/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.instances)) return parsed.instances;
      return [parsed];
    } catch (_) {
      // A JSONL file also begins with "{"; fall through to line parsing.
    }
  }
  return text.split(/\r?\n/).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`); }
  });
}

function validateInstances(instances) {
  if (!Array.isArray(instances) || instances.length === 0) throw new Error('At least one SWE-bench instance is required.');
  const seen = new Set();
  return instances.map((instance, index) => {
    const label = `instance ${index + 1}`;
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) throw new Error(`${label} must be an object.`);
    for (const field of ['instance_id', 'repo', 'base_commit', 'problem_statement']) {
      if (typeof instance[field] !== 'string' || !instance[field].trim()) throw new Error(`${label} requires non-empty ${field}.`);
    }
    if (seen.has(instance.instance_id)) throw new Error(`Duplicate instance_id: ${instance.instance_id}`);
    seen.add(instance.instance_id);
    if (!/^[^/\s]+\/[^/\s]+$/.test(instance.repo)) throw new Error(`${instance.instance_id} repo must be owner/name.`);
    if (!/^[0-9a-f]{7,64}$/i.test(instance.base_commit)) throw new Error(`${instance.instance_id} base_commit must be a pinned Git commit hash.`);
    return { ...instance };
  });
}

function containsCredentialMaterial(value, keyPath = '') {
  if (!value || typeof value !== 'object') return [];
  const findings = [];
  for (const [key, child] of Object.entries(value)) {
    const nextPath = keyPath ? `${keyPath}.${key}` : key;
    if (/^(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)$/i.test(key) && child !== null && child !== '') {
      findings.push(nextPath);
    }
    findings.push(...containsCredentialMaterial(child, nextPath));
  }
  return findings;
}

function validateRemoteConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Remote tool configuration must be an object.');
  if (config.architecture?.reasoner !== 'Lari') throw new Error('Remote tool configuration must declare Lari as the sole reasoner.');
  if (config.architecture?.externalModelEndpoint !== null) throw new Error('externalModelEndpoint must be null.');
  if (config.architecture?.externalModelCalls !== 0) throw new Error('externalModelCalls must be 0.');
  if (config.patchAuthoring?.canonicalRuntimePath !== CANONICAL_PATH) throw new Error(`canonicalRuntimePath must be "${CANONICAL_PATH}".`);
  const credentialFindings = containsCredentialMaterial(config);
  if (credentialFindings.length) throw new Error(`Remote configuration embeds credential material: ${credentialFindings.join(', ')}`);
  for (const [name, executor] of Object.entries(config.executors || {})) {
    if (executor.modelEndpoint !== null) throw new Error(`executors.${name}.modelEndpoint must be null.`);
    if (executor.externalModelCalls !== 0) throw new Error(`executors.${name}.externalModelCalls must be 0.`);
  }
  return config;
}

function readRemoteConfig(configPath = DEFAULT_CONFIG_PATH) {
  return validateRemoteConfig(JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8')));
}

function readWorkspaceMap(filePath) {
  if (!filePath) return {};
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Workspace map must be an object keyed by instance_id.');
  return parsed;
}

function resolveInside(root, relative, label) {
  if (!relative) return null;
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`${label} escapes the isolated workspace.`);
  return { absolute, relative: rel.replace(/\\/g, '/') };
}

function workspaceSpec(instance, workspaceMap, workspaceRoot) {
  let raw = workspaceMap[instance.instance_id];
  if (typeof raw === 'string') raw = { path: raw };
  raw = raw || {};
  const candidate = raw.path || raw.workspacePath || (workspaceRoot ? path.join(workspaceRoot, instance.instance_id) : null);
  if (!candidate) throw new Error(`${instance.instance_id} has no isolated workspace mapping.`);
  const root = path.resolve(candidate);
  const test = resolveInside(root, raw.testPath || raw.test_path || instance.test_path || null, `${instance.instance_id} testPath`);
  const target = resolveInside(root, raw.expressionTarget || raw.expression_target || instance.expression_target || null, `${instance.instance_id} expressionTarget`);
  const rawCandidateLimit = raw.expressionCandidateLimit ?? raw.expression_candidate_limit ?? instance.expression_candidate_limit;
  const expressionCandidateLimit = rawCandidateLimit == null ? null : Number(rawCandidateLimit);
  if (expressionCandidateLimit != null && (!Number.isInteger(expressionCandidateLimit) || expressionCandidateLimit < 1 || expressionCandidateLimit > 256)) {
    throw new Error(`${instance.instance_id} expressionCandidateLimit must be an integer from 1 through 256.`);
  }
  return {
    root,
    testPath: test?.relative || null,
    testRunner: raw.testRunner || raw.test_runner || instance.test_runner || null,
    expressionTarget: target?.relative || null,
    expressionCandidateLimit,
    isolatedReproducer: raw.isolatedReproducer || raw.isolated_reproducer || instance.isolated_reproducer || null,
    executor: raw.executor || 'local_isolated_checkout'
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: options.encoding === null ? null : 'utf8',
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 120000
  });
  const allowed = options.allowedStatuses || [0];
  if (!allowed.includes(result.status)) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${detail}`);
  }
  return result;
}

function git(workspaceRoot, args, options = {}) {
  return run('git', ['--no-optional-locks', ...args], { ...options, cwd: workspaceRoot });
}

function inspectPinnedWorkspace(instance, spec) {
  if (!fs.existsSync(spec.root) || !fs.statSync(spec.root).isDirectory()) throw new Error(`${instance.instance_id} workspace does not exist: ${spec.root}`);
  const topLevel = String(git(spec.root, ['rev-parse', '--show-toplevel']).stdout).trim();
  if (path.resolve(topLevel).toLowerCase() !== path.resolve(spec.root).toLowerCase()) {
    throw new Error(`${instance.instance_id} mapping must point to the Git worktree root, not ${spec.root}.`);
  }
  const head = String(git(spec.root, ['rev-parse', 'HEAD']).stdout).trim();
  const expected = String(git(spec.root, ['rev-parse', `${instance.base_commit}^{commit}`]).stdout).trim();
  if (head !== expected) throw new Error(`${instance.instance_id} checkout is at ${head}, expected ${expected}.`);
  const status = String(git(spec.root, ['status', '--porcelain=v1', '--untracked-files=all']).stdout).trim();
  if (status) throw new Error(`${instance.instance_id} checkout is not clean; refusing to mix an existing patch with Lari output.`);
  if (spec.testPath && !fs.existsSync(path.join(spec.root, spec.testPath))) throw new Error(`${instance.instance_id} testPath does not exist: ${spec.testPath}`);
  if (spec.expressionTarget && !fs.existsSync(path.join(spec.root, spec.expressionTarget))) throw new Error(`${instance.instance_id} expressionTarget does not exist: ${spec.expressionTarget}`);
  return { head, expected, clean: true };
}

function manualNewFilePatch(relativePath, content) {
  if (content.includes('\0')) throw new Error(`Cannot encode an untracked binary file in model_patch: ${relativePath}`);
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  const body = lines.map(line => `+${line}`).join('\n');
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    ...(normalized.endsWith('\n') ? [] : ['\\ No newline at end of file'])
  ].join('\n');
}

function collectPatch(workspaceRoot, baseCommit) {
  const isRuntimeScratchPath = relativePath => {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    return normalized === '.lari-test-tmp'
      || normalized.startsWith('.lari-test-tmp/')
      || normalized === '.lari-go'
      || normalized.startsWith('.lari-go/');
  };
  // Remove only Git's final record separator. trimEnd() is unsafe here: a
  // unified diff can end with a context line whose required prefix is one
  // space, and stripping it corrupts the hunk's declared line count.
  const tracked = String(git(workspaceRoot, [
    'diff', '--binary', '--no-ext-diff', baseCommit, '--', '.',
    ':(exclude).lari-test-tmp/**', ':(exclude).lari-go/**'
  ]).stdout)
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '');
  const untrackedRaw = String(git(workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z']).stdout || '');
  const untracked = untrackedRaw.split('\0').filter(Boolean).filter(relativePath => !isRuntimeScratchPath(relativePath)).sort();
  const additions = untracked.map(relativePath => {
    const safe = resolveInside(workspaceRoot, relativePath, 'untracked path');
    return manualNewFilePatch(safe.relative, fs.readFileSync(safe.absolute, 'utf8'));
  });
  return [tracked, ...additions].filter(Boolean).join('\n') + (tracked || additions.length ? '\n' : '');
}

function createModalTestExecutor(instance, spec) {
  if (spec.executor !== 'modal_direct_official_swebench_image') return null;
  let invocation = 0;
  const runnerRoot = path.join(ROOT, 'benchmarks', 'tmp-lari-swebench-modal-runner-20260715', instance.instance_id);
  return ({ declaration }) => {
    invocation += 1;
    const testAbsolute = resolveInside(spec.root, declaration.path, `${instance.instance_id} remote test`).absolute;
    const patch = collectPatch(spec.root, instance.base_commit);
    const expectedImage = `swebench/sweb.eval.x86_64.${instance.instance_id.toLowerCase().replace('__', '_1776_')}:latest`;
    const job = {
      schemaVersion: 1,
      architecture: {
        reasoner: 'Lari',
        canonicalRuntimePath: CANONICAL_PATH,
        externalModelEndpoint: null,
        externalModelCalls: 0
      },
      instance: { instanceId: instance.instance_id, repo: instance.repo, baseCommit: instance.base_commit },
      deployment: { image: expectedImage, timeout: 1200 },
      test: {
        path: declaration.path,
        runnerId: declaration.runnerId,
        fingerprint: declaration.fingerprint,
        content: fs.readFileSync(testAbsolute, 'utf8')
      },
      patch
    };
    fs.mkdirSync(runnerRoot, { recursive: true });
    const jobPath = path.join(runnerRoot, `runner-${String(invocation).padStart(2, '0')}.job.json`);
    const reportPath = path.join(runnerRoot, `runner-${String(invocation).padStart(2, '0')}.report.json`);
    writeJson(jobPath, job);
    fs.rmSync(reportPath, { force: true });
    const command = process.platform === 'win32' ? 'py' : 'python3';
    const prefix = process.platform === 'win32' ? ['-3.12'] : [];
    const executed = run(command, [
      ...prefix,
      path.join(ROOT, 'scripts', 'lari_swerex_modal_transport.py'),
      '--runner-job', jobPath,
      '--report', reportPath
    ], { allowedStatuses: [0, 1], timeout: 25 * 60 * 1000 });
    if (!fs.existsSync(reportPath)) {
      throw new Error(`Modal runner produced no report: ${String(executed.stderr || executed.stdout || '').slice(0, 4000)}`);
    }
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (report.validated?.jobSha256 !== sha256File(jobPath)) {
      throw new Error('Modal runner report is not bound to the current immutable job bytes');
    }
    if (report.integrity?.activeModelReadOnly !== true || report.integrity?.registryReadOnly !== true) {
      throw new Error('Modal runner did not preserve the active model and registry');
    }
    return {
      passed: report.execution?.passed === true,
      output: report.execution?.output || '',
      error: report.execution?.error || null,
      runnerAllowed: true,
      executionBackend: 'modal_direct_official_swebench_image',
      externalModelCalls: 0,
      evidenceHash: report.execution?.evidenceHash || null
    };
  };
}

function extractResponseProvenance(response) {
  const trace = Array.isArray(response?.trace) ? response.trace : [];
  const executedRecordIds = trace.flatMap(item => [
    item?.learnedRecordId,
    item?.appliedOperatorRecordId,
    item?.retainedPatternId,
    item?.frontierFallback?.expressionRepair?.learnedRecordId,
    item?.frontierFallback?.expressionRepair?.retainedPatternId
  ]).filter(Boolean);
  const learnedRecordIds = [...new Set([
    ...(response?.learnedRecordIds || []),
    ...executedRecordIds
  ])];
  const executionBinding = response?.executionBinding || null;
  const verificationRule = executionBinding?.verificationRule || null;
  const verification = {
    evidenceGrade: verificationRule?.evidenceGrade || null,
    oracleImmutable: verificationRule?.oracleImmutable === true,
    testContentSha256s: [...new Set((verificationRule?.testContentSha256s || []).filter(value => /^[a-f0-9]{64}$/i.test(String(value))))],
    causalReplayRequired: verificationRule?.causalReplayRequired === true,
    causalReplayVerified: verificationRule?.causalReplayVerified === true,
    patchSetSha256: /^[a-f0-9]{64}$/i.test(String(verificationRule?.patchSetSha256 || '')) ? verificationRule.patchSetSha256 : null,
    developmentalEvidenceOnly: verificationRule?.developmentalEvidenceOnly === true
  };
  const trustedEvidenceGrade = ['native_behavioral', 'sealed_isolated_behavioral'].includes(verification.evidenceGrade);
  const sealedEvidenceValid = verification.evidenceGrade !== 'sealed_isolated_behavioral'
    || (verification.causalReplayRequired
      && verification.causalReplayVerified
      && verification.patchSetSha256
      && verification.developmentalEvidenceOnly);
  return {
    action: response?.action || null,
    passed: response?.passed === true,
    capabilitySelection: response?.capabilitySelection || null,
    learnedRecordIds,
    executedRecordIds: [...new Set(executedRecordIds)],
    executionBinding: executionBinding ? {
      contractId: executionBinding.contractId || null,
      skillId: executionBinding.skillId || null,
      learnedRecordId: executionBinding.learnedRecordId || null,
      appliedOperatorRecordId: executionBinding.appliedOperatorRecordId || null,
      executed: executionBinding.executed === true,
      verified: executionBinding.verified === true,
      resultType: executionBinding.resultType || null,
      verificationRule
    } : null,
    verification,
    exactRunnerFailToPass: verificationRule?.type === 'executable_tests'
      && verificationRule?.baselineFailureObserved === true
      && verificationRule?.exactDeclaredRunnerFailToPass === true
      && Number(verificationRule?.testCount || 0) > 0
      && Number(verificationRule?.failToPassCount || 0) > 0
      && verification.oracleImmutable
      && verification.testContentSha256s.length > 0
      && trustedEvidenceGrade
      && sealedEvidenceValid,
    trace,
    traceHash: sha256(Buffer.from(JSON.stringify(trace))),
    externalModelCalls: response?.external_model_calls || 0
  };
}

function writeJson(filePath, value) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath, rows) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '');
}

function relativeOrAbsolute(filePath) {
  if (!filePath) return null;
  const relative = path.relative(ROOT, path.resolve(filePath)).replace(/\\/g, '/');
  return relative.startsWith('../') ? path.resolve(filePath) : relative;
}

async function generate(options) {
  const instancesPath = path.resolve(options.instancesPath);
  const instances = validateInstances(readJsonOrJsonl(instancesPath));
  const remoteConfigPath = path.resolve(options.remoteConfigPath || DEFAULT_CONFIG_PATH);
  const remoteConfig = readRemoteConfig(remoteConfigPath);
  const inputHash = sha256File(instancesPath);
  const configHash = sha256File(remoteConfigPath);
  const createdAt = new Date().toISOString();

  if (options.validateOnly) {
    const manifest = {
      schemaVersion: 1,
      kind: 'lari.swebench.dockerless.validation',
      createdAt,
      validationOnly: true,
      instanceCount: instances.length,
      instanceIds: instances.map(item => item.instance_id),
      input: { path: relativeOrAbsolute(instancesPath), sha256: inputHash },
      remoteToolConfig: { path: relativeOrAbsolute(remoteConfigPath), sha256: configHash, valid: true },
      canonicalRuntimePath: CANONICAL_PATH,
      networkActionsPerformed: 0,
      credentialsRead: 0,
      uploadsPerformed: 0,
      externalModelCalls: 0,
      valid: true
    };
    writeJson(options.manifestPath, manifest);
    return { manifest, predictions: [], provenance: [] };
  }

  if (!options.predictionsPath || !options.provenancePath || !options.manifestPath) {
    throw new Error('--output, --provenance, and --manifest are required when generating predictions.');
  }
  if (options.reuseOnly && (options.candidateDir || options.candidateReportPath)) {
    throw new Error('--reuse-only cannot emit or update a learning candidate.');
  }
  const workspaceMap = readWorkspaceMap(options.workspaceMapPath);
  const loaded = registry.loadLariModel(options.modelPath ? { modelPath: path.resolve(options.modelPath) } : {});
  if (!loaded.resolved.path || !loaded.resolved.exists) throw new Error('The canonical Lari model could not be resolved.');
  if (loaded.resolved.source !== 'registry' && !options.modelPath) throw new Error(`Refusing non-registry model source: ${loaded.resolved.source}`);
  const modelPath = loaded.resolved.path;
  const modelHash = sha256File(modelPath);
  const registryHashBefore = sha256File(registry.registryPath);
  const activeHashBefore = sha256File(registry.currentModelPath);
  const baseModel = clone(loaded.model);
  const workingModel = clone(loaded.model);
  const predictions = [];
  const provenance = [];

  for (const instance of instances) {
    const spec = workspaceSpec(instance, workspaceMap, options.workspaceRoot);
    const checkout = inspectPinnedWorkspace(instance, spec);
    const testExecutor = createModalTestExecutor(instance, spec);
    const model = workingModel;
    const learnedRecordIdsBefore = new Set((model.lariLearnedRecords?.records || []).map(record => record.id));
    const response = runtime.sendMessageToLari(model, {
      id: `swebench.${instance.instance_id}`,
      mode: 'code',
      subintent: 'code.fix',
      prompt: instance.problem_statement,
      workspaceRoot: spec.root,
      testPath: spec.testPath,
      testRunner: spec.testRunner,
      expressionTarget: spec.expressionTarget,
      isolatedReproducer: spec.isolatedReproducer,
      preserveLayout: true
    }, {
      modelHash,
      autoGrow: false,
      groundedFactual: false,
      failureLearning: {
        modelHash,
        sourcePath: 'swebench:' + instance.instance_id,
        benchmarkAssociation: [instance.instance_id],
        allowExpressionOperatorDiscovery: !options.reuseOnly,
        allowSemanticOperatorDiscovery: !options.reuseOnly,
        isolatedReproducer: spec.isolatedReproducer
      },
      executionContract: {
        modelHash,
        sourcePath: 'swebench:' + instance.instance_id,
        benchmarkAssociation: [instance.instance_id],
        workspaceExecution: {
          maxIterations: options.reuseOnly ? 0 : undefined,
          allowExpressionOperatorDiscovery: !options.reuseOnly,
          allowSemanticOperatorDiscovery: !options.reuseOnly,
          ...(spec.expressionCandidateLimit ? { expressionCandidateLimit: spec.expressionCandidateLimit } : {}),
          ...(testExecutor ? { testExecutor } : {})
        }
      },
      kernel: {
        useBenchmarkSystem: false,
        useCapabilityGraph: true,
        capabilityGraph: { minScore: 0 },
        chat: { minMemoryScore: 0, minRouteScore: 0 },
        failureLearning: {
          modelHash,
          sourcePath: 'swebench:' + instance.instance_id,
          benchmarkAssociation: [instance.instance_id],
          allowExpressionOperatorDiscovery: !options.reuseOnly,
          allowSemanticOperatorDiscovery: !options.reuseOnly
        },
        executionContract: {
          modelHash,
          sourcePath: 'swebench:' + instance.instance_id,
          benchmarkAssociation: [instance.instance_id],
          workspaceExecution: {
            maxIterations: options.reuseOnly ? 0 : undefined,
            allowExpressionOperatorDiscovery: !options.reuseOnly,
            allowSemanticOperatorDiscovery: !options.reuseOnly,
            ...(spec.expressionCandidateLimit ? { expressionCandidateLimit: spec.expressionCandidateLimit } : {}),
            isolatedReproducer: spec.isolatedReproducer,
            ...(testExecutor ? { testExecutor } : {})
          }
        }
      }
    });
    const learnedRecordIdsAfter = new Set((model.lariLearnedRecords?.records || []).map(record => record.id));
    const createdLearnedRecordIds = [...learnedRecordIdsAfter].filter(id => !learnedRecordIdsBefore.has(id));
    if (options.reuseOnly && createdLearnedRecordIds.length) {
      throw new Error(`${instance.instance_id} created learned records during reuse-only execution: ${createdLearnedRecordIds.join(', ')}`);
    }
    const modelPatch = collectPatch(spec.root, checkout.expected);
    const responseProvenance = extractResponseProvenance(response);
    if (responseProvenance.externalModelCalls !== 0) throw new Error(`${instance.instance_id} reported an external model call.`);
    const selectedCapabilityAction = responseProvenance.action === 'execute_selected_learned_capability'
      || responseProvenance.action === 'default_failure_learning';
    if (!responseProvenance.passed
      || !selectedCapabilityAction
      || responseProvenance.executionBinding?.executed !== true
      || responseProvenance.executionBinding?.verified !== true
      || responseProvenance.exactRunnerFailToPass !== true) {
      writeJson(options.failureReportPath, {
        schemaVersion: 1,
        kind: 'lari.swebench.rejected-prediction',
        createdAt: new Date().toISOString(),
        instanceId: instance.instance_id,
        modelHash,
        response: responseProvenance,
        rejection: 'selected capability did not prove immutable trusted fail-to-pass evidence, including causal replay when isolated',
        reuseOnly: options.reuseOnly,
        activeModelReadOnly: activeHashBefore === sha256File(registry.currentModelPath),
        registryReadOnly: registryHashBefore === sha256File(registry.registryPath),
        externalModelCalls: 0
      });
      throw new Error(`${instance.instance_id} did not prove an exact declared-runner failure-to-pass transition.`);
    }
    if (!responseProvenance.capabilitySelection?.learnedRecordId
      || !responseProvenance.executedRecordIds.includes(responseProvenance.capabilitySelection.learnedRecordId)) {
      throw new Error(`${instance.instance_id} selected learned capability is not bound to executed provenance.`);
    }
    if (!modelPatch.trim()) throw new Error(`${instance.instance_id} produced no patch after verified execution.`);
    const patchHash = sha256(Buffer.from(modelPatch));
    predictions.push({ instance_id: instance.instance_id, model_name_or_path: MODEL_NAME, model_patch: modelPatch });
    provenance.push({
      schemaVersion: 1,
      kind: 'lari.swebench.prediction.provenance',
      createdAt: new Date().toISOString(),
      instanceId: instance.instance_id,
      repo: instance.repo,
      baseCommit: checkout.expected,
      problemStatementHash: sha256(Buffer.from(instance.problem_statement)),
      model: {
        identity: 'Lari',
        source: loaded.resolved.source,
        path: relativeOrAbsolute(modelPath),
        sha256: modelHash,
        canonicalRuntimePath: CANONICAL_PATH
      },
      executor: {
        kind: 'tool_only_workspace',
        selected: spec.executor,
        modelEndpoint: null,
        externalModelCalls: 0
      },
      workspace: { root: spec.root, cleanAtStart: true, head: checkout.head, testPath: spec.testPath, testRunner: spec.testRunner, expressionTarget: spec.expressionTarget },
      verification: responseProvenance.verification,
      response: responseProvenance,
      patch: { sha256: patchHash, bytes: Buffer.byteLength(modelPatch), empty: modelPatch.length === 0 },
      activeModelReadOnly: true,
      registryReadOnly: true,
      externalModelCalls: 0
    });
  }

  const activeHashAfter = sha256File(registry.currentModelPath);
  const registryHashAfter = sha256File(registry.registryPath);
  if (activeHashBefore !== activeHashAfter) throw new Error('Canonical active model changed during prediction generation.');
  if (registryHashBefore !== registryHashAfter) throw new Error('Lari registry changed during prediction generation.');
  const evidenceGradeCounts = provenance.reduce((counts, item) => {
    const grade = item.verification?.evidenceGrade || 'untrusted';
    counts[grade] = Number(counts[grade] || 0) + 1;
    return counts;
  }, {});
  const developmentalEvidenceOnly = provenance.some(item => item.verification?.developmentalEvidenceOnly === true);
  const baseRecords = new Map((baseModel.lariLearnedRecords?.records || []).map(record => [record.id, record]));
  const learnedRecords = (workingModel.lariLearnedRecords?.records || [])
    .filter(record => !baseRecords.has(record.id) || JSON.stringify(baseRecords.get(record.id)) !== JSON.stringify(record));
  let candidateInfo = null;
  if (options.candidateDir && learnedRecords.length) {
    const candidate = clone(baseModel);
    const recordsById = new Map((candidate.lariLearnedRecords?.records || []).map(record => [record.id, record]));
    learnedRecords.forEach(record => recordsById.set(record.id, clone(record)));
    candidate.lariLearnedRecords = {
      ...(candidate.lariLearnedRecords || { schemaVersion: 1 }),
      records: [...recordsById.values()]
    };
    candidate.lineage = {
      ...(candidate.lineage || {}),
      parentHash: modelHash,
      developmentalEvent: 'verified_failure_repair',
      developmentalEvidenceOnly,
      createdAt
    };
    const serialized = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
    const candidateHash = sha256(serialized);
    const candidateDir = path.resolve(options.candidateDir);
    const candidatePath = path.join(candidateDir, candidateHash + '.json');
    fs.mkdirSync(candidateDir, { recursive: true });
    if (!fs.existsSync(candidatePath)) fs.writeFileSync(candidatePath, serialized, { flag: 'wx' });
    if (sha256File(candidatePath) !== candidateHash) throw new Error('Immutable learning candidate hash mismatch.');
    fs.chmodSync(candidatePath, 0o444);
    candidateInfo = {
      path: relativeOrAbsolute(candidatePath),
      sha256: candidateHash,
      parentHash: modelHash,
      promoted: false,
      learnedRecordIds: learnedRecords.map(record => record.id),
      learnedRecordCount: learnedRecords.length
    };
    writeJson(options.candidateReportPath, {
      schemaVersion: 1,
      kind: 'lari.swebench.verified-failure-learning-candidate',
      createdAt,
      candidate: candidateInfo,
      sourceInstances: instances.map(instance => instance.instance_id),
      reuseOnly: options.reuseOnly,
      evidenceGradeCounts,
      developmentalEvidenceOnly,
      activeModelReadOnly: activeHashBefore === activeHashAfter,
      registryReadOnly: registryHashBefore === registryHashAfter,
      externalModelCalls: 0
    });
  }
  writeJsonl(options.predictionsPath, predictions);
  writeJsonl(options.provenancePath, provenance);
  if (options.sbCliPredictionsPath) writeJson(options.sbCliPredictionsPath, predictions);
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.swebench.dockerless.prediction-manifest',
    createdAt,
    instanceCount: instances.length,
    input: { path: relativeOrAbsolute(instancesPath), sha256: inputHash },
    predictions: { path: relativeOrAbsolute(options.predictionsPath), sha256: sha256File(path.resolve(options.predictionsPath)), count: predictions.length },
    sbCliPredictions: options.sbCliPredictionsPath
      ? { path: relativeOrAbsolute(options.sbCliPredictionsPath), sha256: sha256File(path.resolve(options.sbCliPredictionsPath)), count: predictions.length, format: 'json_list' }
      : null,
    provenance: { path: relativeOrAbsolute(options.provenancePath), sha256: sha256File(path.resolve(options.provenancePath)), count: provenance.length },
    candidate: candidateInfo,
    remoteToolConfig: { path: relativeOrAbsolute(remoteConfigPath), sha256: configHash },
    model: { identity: 'Lari', path: relativeOrAbsolute(modelPath), sha256: modelHash, canonicalRuntimePath: CANONICAL_PATH },
    reuseOnly: options.reuseOnly,
    evidence: {
      gradeCounts: evidenceGradeCounts,
      developmentalEvidenceOnly,
      sealedIsolationIsOfficialSwebenchEvidence: false
    },
    integrity: {
      activeModel: { before: activeHashBefore, after: activeHashAfter, unchanged: activeHashBefore === activeHashAfter },
      registry: { before: registryHashBefore, after: registryHashAfter, unchanged: registryHashBefore === registryHashAfter }
    },
    remoteActionsPerformed: 0,
    uploadsPerformed: 0,
    credentialsRead: 0,
    externalModelCalls: 0
  };
  writeJson(options.manifestPath, manifest);
  return { manifest, predictions, provenance, candidate: candidateInfo };
}

function initSelfTestFixture(root) {
  const resolved = path.resolve(root);
  const allowedRoot = path.resolve(ROOT, 'benchmarks', 'tmp-lari-swebench-dockerless-bridge', 'workspace');
  if (resolved !== allowedRoot) throw new Error(`Refusing to reset unexpected self-test workspace: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'math.js'), 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(root, 'tests', 'test.js'), "const { add } = require('../math');\nif (add(40, 2) !== 42) throw new Error('expected 42');\n");
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'lari-self-test@example.invalid']);
  git(root, ['config', 'user.name', 'Lari Bridge Self Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'pinned failing fixture']);
  return String(git(root, ['rev-parse', 'HEAD']).stdout).trim();
}

async function selfTest() {
  const testRoot = path.join(ROOT, 'benchmarks', 'tmp-lari-swebench-dockerless-bridge');
  const workspace = path.join(testRoot, 'workspace');
  const baseCommit = initSelfTestFixture(workspace);
  const instancesPath = path.join(testRoot, 'instances.jsonl');
  const workspaceMapPath = path.join(testRoot, 'workspaces.json');
  const predictionsPath = path.join(testRoot, 'predictions.jsonl');
  const sbCliPredictionsPath = path.join(testRoot, 'predictions.sb-cli.json');
  const provenancePath = path.join(testRoot, 'provenance.jsonl');
  const manifestPath = path.join(testRoot, 'manifest.json');
  fs.writeFileSync(instancesPath, `${JSON.stringify({
    instance_id: 'lari__dockerless-bridge-1', repo: 'lari/dockerless-bridge', base_commit: baseCommit,
    problem_statement: 'A workspace regression makes the executable test fail. Diagnose the implementation, repair it, verify the test, and retain the reusable coding behavior.'
  })}\n`);
  writeJson(workspaceMapPath, {
    'lari__dockerless-bridge-1': { path: workspace, testPath: 'tests/test.js', expressionTarget: 'math.js', executor: 'offline_self_test' }
  });
  const before = { active: sha256File(registry.currentModelPath), registry: sha256File(registry.registryPath) };
  const validation = await generate({ instancesPath, remoteConfigPath: DEFAULT_CONFIG_PATH, manifestPath: path.join(testRoot, 'validation-manifest.json'), validateOnly: true });
  const generated = await generate({ instancesPath, workspaceMapPath, predictionsPath, sbCliPredictionsPath, provenancePath, manifestPath, remoteConfigPath: DEFAULT_CONFIG_PATH });
  const executableTest = run(process.execPath, ['tests/test.js'], { cwd: workspace, allowedStatuses: [0] });
  let dirtyWorkspaceRejected = false;
  try {
    await generate({ instancesPath, workspaceMapPath, predictionsPath: path.join(testRoot, 'should-not-exist.jsonl'), provenancePath: path.join(testRoot, 'should-not-exist-provenance.jsonl'), manifestPath: path.join(testRoot, 'should-not-exist-manifest.json'), remoteConfigPath: DEFAULT_CONFIG_PATH });
  } catch (error) {
    dirtyWorkspaceRejected = /checkout is not clean/.test(String(error?.message || error));
  }
  let reuseOnlyCandidateEmissionRejected = false;
  try {
    await generate({
      instancesPath,
      workspaceMapPath,
      predictionsPath: path.join(testRoot, 'reuse-only-should-not-exist.jsonl'),
      provenancePath: path.join(testRoot, 'reuse-only-provenance-should-not-exist.jsonl'),
      manifestPath: path.join(testRoot, 'reuse-only-manifest-should-not-exist.json'),
      candidateDir: path.join(testRoot, 'reuse-only-candidate-should-not-exist'),
      candidateReportPath: path.join(testRoot, 'reuse-only-candidate-report-should-not-exist.json'),
      remoteConfigPath: DEFAULT_CONFIG_PATH,
      reuseOnly: true
    });
  } catch (error) {
    reuseOnlyCandidateEmissionRejected = /reuse-only cannot emit or update a learning candidate/.test(String(error?.message || error));
  }
  let externalEndpointRejected = false;
  try {
    const unsafe = clone(readRemoteConfig(DEFAULT_CONFIG_PATH));
    unsafe.architecture.externalModelEndpoint = 'https://example.invalid/inference';
    validateRemoteConfig(unsafe);
  } catch (error) {
    externalEndpointRejected = /externalModelEndpoint must be null/.test(String(error?.message || error));
  }
  const after = { active: sha256File(registry.currentModelPath), registry: sha256File(registry.registryPath) };
  const syntheticVerificationResponse = verificationRule => extractResponseProvenance({
    passed: true,
    action: 'execute_selected_learned_capability',
    executionBinding: { executed: true, verified: true, verificationRule },
    trace: [],
    external_model_calls: 0
  });
  const sealedVerificationBase = {
    type: 'executable_tests',
    baselineFailureObserved: true,
    exactDeclaredRunnerFailToPass: true,
    testCount: 1,
    failToPassCount: 1,
    evidenceGrade: 'sealed_isolated_behavioral',
    oracleImmutable: true,
    testContentSha256s: ['a'.repeat(64)],
    causalReplayRequired: true,
    developmentalEvidenceOnly: true
  };
  const sealedWithoutReplay = syntheticVerificationResponse({ ...sealedVerificationBase, causalReplayVerified: false, patchSetSha256: null });
  const sealedWithReplay = syntheticVerificationResponse({ ...sealedVerificationBase, causalReplayVerified: true, patchSetSha256: 'b'.repeat(64) });
  const prediction = generated.predictions[0];
  const proof = {
    validationOnlyPassed: validation.manifest.valid === true && validation.manifest.networkActionsPerformed === 0,
    officialPredictionShape: Object.keys(prediction || {}).sort().join(',') === 'instance_id,model_name_or_path,model_patch',
    sbCliJsonListShape: Array.isArray(JSON.parse(fs.readFileSync(sbCliPredictionsPath, 'utf8'))),
    nonemptyPatch: /diff --git a\/math\.js b\/math\.js/.test(prediction?.model_patch || ''),
    executableTestPassed: executableTest.status === 0,
    provenanceBound: generated.provenance[0]?.patch?.sha256 === sha256(Buffer.from(prediction?.model_patch || '')),
    canonicalRuntimeBound: generated.provenance[0]?.model?.canonicalRuntimePath === CANONICAL_PATH,
    learnedSelectionRecorded: (generated.provenance[0]?.response?.learnedRecordIds || []).length >= 1,
    executedOperatorRecorded: (generated.provenance[0]?.response?.executedRecordIds || []).length >= 1,
    selectedCapabilityExecuted: generated.provenance[0]?.response?.executedRecordIds
      ?.includes(generated.provenance[0]?.response?.capabilitySelection?.learnedRecordId),
    exactDeclaredRunnerFailToPass: generated.provenance[0]?.response?.exactRunnerFailToPass === true,
    nativeEvidenceIntegrityRecorded: generated.provenance[0]?.verification?.evidenceGrade === 'native_behavioral'
      && generated.provenance[0]?.verification?.oracleImmutable === true
      && generated.provenance[0]?.verification?.testContentSha256s?.every(value => /^[a-f0-9]{64}$/i.test(value)),
    sealedEvidenceWithoutReplayRejected: sealedWithoutReplay.exactRunnerFailToPass === false,
    sealedEvidenceWithReplayAcceptedAsDevelopmental: sealedWithReplay.exactRunnerFailToPass === true
      && sealedWithReplay.verification.developmentalEvidenceOnly === true,
    executionBindingVerified: generated.provenance[0]?.response?.executionBinding?.verified === true,
    zeroExternalModelCalls: generated.provenance[0]?.externalModelCalls === 0,
    activeModelReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry,
    noRemoteAction: generated.manifest.remoteActionsPerformed === 0 && generated.manifest.uploadsPerformed === 0,
    noCredentialsRead: generated.manifest.credentialsRead === 0,
    dirtyWorkspaceRejected,
    reuseOnlyCandidateEmissionRejected,
    externalModelEndpointRejected: externalEndpointRejected
  };
  const passed = Object.values(proof).every(Boolean);
  const report = { schemaVersion: 1, test: 'lari-swebench-dockerless-bridge-self-test', passed, proof, artifacts: { instancesPath, workspaceMapPath, predictionsPath, sbCliPredictionsPath, provenancePath, manifestPath }, externalModelCalls: 0 };
  writeJson(path.join(testRoot, 'self-test-report.json'), report);
  if (!passed) throw new Error(`Self-test failed: ${JSON.stringify(proof)}`);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.selfTest) {
    const report = await selfTest();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (!args.instancesPath) throw new Error('--instances is required.');
  const result = await generate(args);
  process.stdout.write(`${JSON.stringify({
    valid: result.manifest.valid !== false,
    validationOnly: result.manifest.validationOnly === true,
    instanceCount: result.manifest.instanceCount,
    predictionCount: result.predictions.length,
    modelHash: result.manifest.model?.sha256 || null,
    candidateHash: result.candidate?.sha256 || null,
    externalModelCalls: 0
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}

module.exports = {
  CANONICAL_PATH,
  collectPatch,
  generate,
  readJsonOrJsonl,
  selfTest,
  validateInstances,
  validateRemoteConfig
};
