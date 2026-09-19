#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const candidateRelative = process.argv[2]
  || 'consolidation/symbolic-pushdown-neurogenesis-20260908/candidates/06f2543c86eb60dbc20814a437fc1290d52a832c112046c9fbb37974cdc9a8a3.json';
const candidatePath = path.resolve(root, candidateRelative);
const activePath = path.join(root, 'models', 'lari', 'current', 'swarm-model.json');
const registryPath = path.join(root, 'models', 'lari', 'registry.json');
const outputPath = path.join(root, 'consolidation', 'beta-readiness-20260908', 'release-gates.json');

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const relative = file => path.relative(root, file).replace(/\\/g, '/');

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

if (!fs.existsSync(candidatePath)) throw new Error(`Missing candidate: ${relative(candidatePath)}`);
const expectedCandidateHash = path.basename(candidatePath, '.json');
if (!/^[a-f0-9]{64}$/.test(expectedCandidateHash) || sha256(candidatePath) !== expectedCandidateHash) {
  throw new Error('Candidate path is not bound to its exact SHA-256 content hash.');
}

const scripts = require('../package.json').scripts;
const gateNames = [...scripts.test.matchAll(/npm run ([^ &]+)/g)].map(match => match[1]);
const bundledPnpm = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'bin', 'fallback', 'pnpm.cmd');
const npmProbe = childProcess.spawnSync('npm', ['--version'], { shell: true, encoding: 'utf8', windowsHide: true });
const packageRunner = npmProbe.status === 0 ? 'npm' : (fs.existsSync(bundledPnpm) ? `"${bundledPnpm}"` : 'npm');
const before = { active: sha256(activePath), registry: sha256(registryPath), candidate: sha256(candidatePath) };
const results = [];
let failure = null;
const environment = {
  ...process.env,
  LARI_MODEL_PATH: relative(candidatePath),
  LARI_DISABLE_MODEL_FALLBACKS: '1',
  LARI_ALLOW_LEGACY_ROOT_MODEL: '0',
  LARI_EXTERNAL_MODEL_CALLS: '0'
};
const localPythonScripts = path.join(root, '.venv-lari-beta', 'Scripts');
if (fs.existsSync(localPythonScripts)) {
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') || 'Path';
  environment[pathKey] = `${localPythonScripts}${path.delimiter}${environment[pathKey] || ''}`;
  environment.VIRTUAL_ENV = path.join(root, '.venv-lari-beta');
}

for (const name of gateNames) {
  const startedAt = Date.now();
  const commands = String(scripts[name] || '').split(/\s*&&\s*/).filter(Boolean)
    .map(command => command.replace(/^npm\s+run\b/, `${packageRunner} run`));
  const commandsRun = [];
  let passed = true;
  for (const command of commands) {
    const result = childProcess.spawnSync(command, {
      cwd: root,
      env: environment,
      shell: true,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 600000,
      maxBuffer: 128 * 1024 * 1024
    });
    commandsRun.push({
      command,
      status: result.status,
      signal: result.signal || null,
      stdoutTail: String(result.stdout || '').slice(-4000),
      stderrTail: String(result.stderr || '').slice(-4000)
    });
    if (result.status !== 0) {
      passed = false;
      failure = { gate: name, command, status: result.status, signal: result.signal || null };
      break;
    }
  }
  results.push({ name, passed, durationMs: Date.now() - startedAt, commands: commandsRun });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${results.length}/${gateNames.length} ${name}\n`);
  if (!passed) break;
}

const after = { active: sha256(activePath), registry: sha256(registryPath), candidate: sha256(candidatePath) };
const report = {
  schemaVersion: 1,
  kind: 'lari.beta.release-gates',
  createdAt: new Date().toISOString(),
  candidate: { path: relative(candidatePath), sha256: expectedCandidateHash },
  gateContract: { source: 'package.json#scripts.test', expected: gateNames.length, passed: results.filter(item => item.passed).length },
  results,
  failure,
  before,
  after,
  gates: {
    completeCanonicalChain: results.length === gateNames.length && results.every(item => item.passed),
    exactCandidate: before.candidate === expectedCandidateHash && after.candidate === expectedCandidateHash,
    activeReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry,
    fallbacksDisabled: environment.LARI_DISABLE_MODEL_FALLBACKS === '1',
    externalModelCallsZero: environment.LARI_EXTERNAL_MODEL_CALLS === '0'
  }
};
report.passed = Object.values(report.gates).every(Boolean);
atomicWrite(outputPath, report);
process.stdout.write(`${JSON.stringify({ report: relative(outputPath), passed: report.passed, gates: report.gates }, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
