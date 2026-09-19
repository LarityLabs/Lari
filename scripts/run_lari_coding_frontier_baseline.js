#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const SET = path.join(ROOT, 'consolidation', 'coding-frontier-curriculum-v2-20260828');
const PAYLOAD = path.join(SET, 'sealed-holdouts.json');
const MANIFEST = path.join(SET, 'seal-manifest.json');
const MODEL = path.join(ROOT, 'consolidation', 'mastery-sealed-repository-20260828', 'candidates', '5a53e314702053b113e3d3e9a0aa6ee1d553e385a8e5d2dce32bab63e7df54b6.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const REPORT = path.join(SET, 'parent-baseline-report.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));

function writeWorkspace(root, files) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function clearCaches(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = path.join(root, entry.name);
    if (entry.name === '__pycache__' || entry.name === '.lari-test-tmp') fs.rmSync(child, { recursive: true, force: true });
    else clearCaches(child);
  }
}

function runTest(spec, workspace) {
  clearCaches(workspace);
  const command = spec.language === 'python' ? 'python' : process.execPath;
  const result = cp.spawnSync(command, [spec.testPath], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { passed: result.status === 0, status: result.status, tail: String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-6) };
}

function responseView(response) {
  const failure = response.trace?.find(item => item.phase === 'default_failure_learning') || null;
  const selected = response.trace?.find(item => item.phase === 'selected_capability_execution') || null;
  return {
    passed: response.passed === true,
    action: response.action || null,
    modelHash: response.modelHash || null,
    appliedOperatorRecordId: response.executionBinding?.appliedOperatorRecordId || failure?.retainedPatternId || null,
    expressionRepair: failure?.frontierFallback?.expressionRepair || selected?.expressionRepair || null,
    exactRunnerFailToPass: response.executionBinding?.verificationRule?.exactDeclaredRunnerFailToPass === true,
    externalModelCalls: response.external_model_calls || 0
  };
}

function main() {
  if (fs.existsSync(REPORT)) throw new Error('Parent frontier baseline already exists; refusing to overwrite it.');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (fileHash(PAYLOAD) !== manifest.payload.sha256) throw new Error('Sealed payload hash mismatch.');
  const sealed = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
  const modelHash = fileHash(MODEL);
  const protectedBefore = { model: modelHash, active: fileHash(ACTIVE), registry: fileHash(REGISTRY), payload: fileHash(PAYLOAD) };
  const parent = JSON.parse(fs.readFileSync(MODEL, 'utf8'));
  const rows = [];
  for (const spec of sealed.holdouts) {
    const workspace = path.join(SET, 'parent-baseline-workspaces', spec.id);
    writeWorkspace(workspace, spec.files);
    const testBeforeHash = fileHash(path.join(workspace, spec.testPath));
    const before = runTest(spec, workspace);
    if (before.passed) throw new Error(`${spec.id} must fail before Lari runs.`);
    const response = runtime.sendMessageToLari(clone(parent), {
      id: `coding.frontier.baseline.${spec.id}`,
      mode: 'code',
      subintent: 'code.fix',
      prompt: spec.request,
      workspaceRoot: workspace,
      testPath: spec.testPath,
      testRunner: spec.testRunner,
      ...(spec.expressionTarget ? { expressionTarget: spec.expressionTarget } : {}),
      ...(spec.publicExamples ? { publicExamples: spec.publicExamples, publicSymbol: spec.publicSymbol } : {}),
      preserveLayout: true
    }, {
      modelHash,
      autoGrow: false,
      groundedFactual: false,
      kernel: {
        useBenchmarkSystem: false,
        useCapabilityGraph: true,
        includeTransientDiagnostics: true,
        capabilityGraph: { minScore: 0 },
        chat: { minMemoryScore: 0, minRouteScore: 0 },
        failureLearning: {
          modelHash,
          sourcePath: `sealed-frontier:${spec.lane}`,
          benchmarkAssociation: [],
          allowExpressionOperatorDiscovery: false,
          allowSemanticOperatorDiscovery: false,
          coordinatedProgramSearch: true
        },
        executionContract: {
          modelHash,
          sourcePath: `sealed-frontier:${spec.lane}`,
          benchmarkAssociation: [],
          workspaceExecution: {
            maxIterations: 0,
            allowExpressionOperatorDiscovery: false,
            allowSemanticOperatorDiscovery: false,
            coordinatedProgramSearch: true
          }
        }
      }
    });
    const after = runTest(spec, workspace);
    rows.push({
      id: spec.id,
      lane: spec.lane,
      before,
      response: responseView(response),
      after,
      testOracleUnchanged: fileHash(path.join(workspace, spec.testPath)) === testBeforeHash,
      passed: !before.passed && after.passed && response.passed === true
    });
  }
  const protectedAfter = { model: fileHash(MODEL), active: fileHash(ACTIVE), registry: fileHash(REGISTRY), payload: fileHash(PAYLOAD) };
  const report = {
    schemaVersion: 1,
    kind: 'lari.coding-frontier.parent-baseline',
    createdAt: new Date().toISOString(),
    model: { path: path.relative(ROOT, MODEL).replace(/\\/g, '/'), sha256: modelHash },
    seal: manifest,
    score: `${rows.filter(row => row.passed).length}/${rows.length}`,
    rows,
    protectedFilesUnchanged: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    externalModelCalls: 0
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ score: report.score, lanes: rows.map(row => ({ lane: row.lane, passed: row.passed, action: row.response.action, operator: row.response.appliedOperatorRecordId, failure: row.after.tail.at(-1) || null })), protectedFilesUnchanged: report.protectedFilesUnchanged }, null, 2)}\n`);
}

main();
