#!/usr/bin/env node
'use strict';

/**
 * Generate the repository capability inventory and fail when it drifts.
 *
 * A function existing in the runtime is not automatically a model capability. A benchmark calling
 * that function directly is component evidence, not evidence that an ordinary Lari request can use
 * it. This audit records every benchmark runner, the entry point it exercises, the evidence shape,
 * and whether its latest report is both current-model-bound and fresh.
 *
 * Usage:
 *   node scripts/audit_lari_repository.js
 *   node scripts/audit_lari_repository.js --check
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INVENTORY_MD = path.join(ROOT, 'CAPABILITY_INVENTORY.md');
const INVENTORY_JSON = path.join(ROOT, 'CAPABILITY_INVENTORY.json');
const ACTIVE_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'consolidation', '.venv-lm-eval', 'models']);

const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const relative = file => path.relative(ROOT, file).replace(/\\/g, '/');

function walk(dir, found = []) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch (_) { return found; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, found);
    else if (entry.name.endsWith('.js')) found.push(rel.replace(/\\/g, '/'));
  }
  return found;
}

function parseJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

const PRODUCTION_PROOF_PATHS = [
  'consolidation/mixed-domain-program-growth-production-promotion-20260908/production-surface-evidence.json'
];

function currentProductionProofs(activeHash) {
  return PRODUCTION_PROOF_PATHS.map(value => path.join(ROOT, value)).flatMap(file => {
    if (!fs.existsSync(file)) return [];
    const report = parseJson(file);
    const kind = String(report?.kind || '');
    const boundHash = report?.activeHash || report?.activeModelHash || report?.modelHash || null;
    const time = reportDate(report, file);
    const fresh = time !== null && Date.now() - time <= FRESH_MS;
    const rows = Array.isArray(report?.rows) ? report.rows : [];
    const hasPublicParity = rows.length > 0 && rows.every(row => {
      const surfaces = row?.surfaces || {};
      return Object.keys(surfaces).length >= 4
        && Object.values(surfaces).every(surface => surface?.modelHash === activeHash);
    });
    const gatesPass = report?.gates && Object.values(report.gates).length > 0
      && Object.values(report.gates).every(value => value === true || value === 0);
    if (!/production-surface-evidence/.test(kind) || report?.passed !== true
      || boundHash !== activeHash || !fresh || !hasPublicParity || !gatesPass) return [];
    return [{
      path: relative(file), kind, activeModelHash: boundHash, fresh,
      recordedAt: new Date(time).toISOString(), publicSurfaceRows: rows.length,
      surfaces: [...new Set(rows.flatMap(row => Object.keys(row.surfaces || {})))].sort(),
      passed: true
    }];
  }).sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
}

function reportDate(report, file) {
  const value = report?.generatedAt || report?.createdAt || report?.completedAt || report?.timestamp;
  const parsed = value ? new Date(value).getTime() : fs.statSync(file).mtimeMs;
  return Number.isFinite(parsed) ? parsed : null;
}

function reportModelHash(report) {
  return report?.activeModelHash || report?.modelHash || report?.candidateHash
    || report?.candidate?.sha256 || report?.model?.sha256 || null;
}

function reportPassed(report) {
  if (!report) return null;
  if (typeof report.passed === 'boolean') return report.passed;
  if (typeof report.success === 'boolean') return report.success;
  return null;
}

function literalReportPaths(text) {
  const found = new Set();
  for (const match of text.matchAll(/["'`]([^"'`]*?(?:latest-|report)[^"'`]*?\.json)["'`]/gi)) {
    const value = match[1].replace(/\\/g, '/');
    if (!value.includes('${') && !value.includes('..')) found.add(value);
  }
  return [...found];
}

function evidenceNameTokens(value) {
  return new Set(String(value || '').toLowerCase()
    .replace(/\.(?:js|json)$/i, '')
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !['run', 'latest', 'report', 'eval'].includes(token)));
}

function latestEvidence(text, activeHash, runnerFile) {
  const candidates = [];
  const runnerTokens = evidenceNameTokens(runnerFile);
  for (const value of literalReportPaths(text)) {
    const possible = path.isAbsolute(value)
      ? [value]
      : [path.join(ROOT, value), path.join(ROOT, 'benchmarks', value)];
    for (const absolute of [...new Set(possible)]) {
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
      const report = parseJson(absolute);
      if (!report) continue;
      const time = reportDate(report, absolute);
      candidates.push({
        path: relative(absolute),
        passed: reportPassed(report),
        modelHash: reportModelHash(report),
        currentModelBound: reportModelHash(report) === activeHash,
        fresh: time !== null && Date.now() - time <= FRESH_MS,
        recordedAt: time === null ? null : new Date(time).toISOString(),
        nameAffinity: [...evidenceNameTokens(value)].filter(token => runnerTokens.has(token)).length
      });
    }
  }
  return candidates.sort((a, b) => b.nameAffinity - a.nameAffinity
    || String(b.recordedAt).localeCompare(String(a.recordedAt)))[0] || null;
}

function runtimeCalls(text) {
  return [...new Set([...text.matchAll(/\b(?:runtime|SwarmModelRuntime|api)\.([A-Za-z_$][\w$]*)\s*\(/g)]
    .map(match => match[1]))].sort();
}

function classifyBenchmark(file, text, npmNames, gated, activeHash) {
  const publicSurfaces = [];
  if (/\bsendMessageToLari(?:Async)?\s*\(/.test(text)) publicSurfaces.push('sendMessageToLari');
  if (/\brunLariAutonomousRequest\s*\(/.test(text)) publicSurfaces.push('autonomous');
  if (/lari_ask\.js|npm\s+run\s+lari:ask/.test(text)) publicSurfaces.push('cli');
  if (/lari_openai_server\.py|\/v1\/chat\/completions/.test(text)) publicSurfaces.push('openai-api');
  if (/index\.html|Workbench/i.test(text) && /sendMessage|chat/i.test(text)) publicSurfaces.push('workbench');

  const calls = runtimeCalls(text);
  const directKernel = /\brunLariUnifiedTaskKernel\s*\(/.test(text);
  const internalCalls = calls.filter(name => ![
    'sendMessageToLari', 'sendMessageToLariAsync', 'runLariAutonomousRequest',
    'runLariUnifiedTaskKernel'
  ].includes(name));
  const invokesRuntime = publicSurfaces.length > 0 || directKernel || calls.length > 0
    || /swarm_model_runtime|SwarmModelRuntime/.test(text);
  const realProcess = /spawnSync|spawn\(|execFileSync|child_process/.test(text);
  const executableVerification = realProcess && /(?:fail(?:ed)?|pass(?:ed)?|verify|assert|testPath|runner)/i.test(text);
  const loadsCanonicalState = /loadLariModel|models[\\/]lari[\\/]current[\\/]swarm-model\.json|registry\.currentModelPath/.test(text);
  const reload = /reload|reloaded|JSON\.parse\(fs\.readFileSync/.test(text);
  const sealed = /sealed|hidden[ _-]?holdout|unseen|oracleImmutable|manifest.*sha256/i.test(text);
  const fixture = /fixture|seed(?:ed|Workspace|Repo|Project)?\s*\(|hardcoded/i.test(text);
  const candidateOnly = /candidateModel|candidatePath|learning-candidates|promoted:\s*false/.test(text);
  const externalComparison = /(?:ollama|qwen|openai|anthropic|gemini|external model)/i.test(text)
    && /(?:competitor|teacher|baseline|head.to.head|api[_ -]?key|external[_ ]model[_ ]calls)/i.test(text);
  const retired = /LARI_(?:CONTAMINATION|CAPABILITY_INTEGRITY)_GATE/.test(text)
    && /REFUSED:|process\.exit\(1\)/.test(text.slice(0, 2500));
  const goldAnswerExposure = /"minedFrom"|sample\.expected|dump_gsm8k_public[^\n]+['"]test['"]|gold answer/i.test(text);
  const writesActive = /promoteLariModel|writeLariModel|currentModelPath[^\n]+writeFile/.test(text);
  const evidence = latestEvidence(text, activeHash, file);

  let evidenceClass;
  if (retired) evidenceClass = 'retired-contaminated-path';
  else if (externalComparison) evidenceClass = 'development-external-comparison';
  else if (publicSurfaces.length && executableVerification && sealed && reload) evidenceClass = 'public-sealed-transfer-proof';
  else if (publicSurfaces.length && executableVerification) evidenceClass = 'public-executable-capability-proof';
  else if (publicSurfaces.length) evidenceClass = 'public-surface-regression';
  else if (directKernel && executableVerification && sealed && reload) evidenceClass = 'kernel-sealed-transfer-development';
  else if (directKernel) evidenceClass = 'kernel-direct-development';
  else if (invokesRuntime) evidenceClass = 'internal-component-development';
  else evidenceClass = 'infrastructure-or-fixture';

  const currentProof = Boolean(
    evidence
    && evidence.passed === true
    && evidence.currentModelBound
    && evidence.fresh
    && evidence.nameAffinity >= 2
    && publicSurfaces.length
    && executableVerification
    && !retired
    && !goldAnswerExposure
  );

  return {
    file,
    sha256: sha256(text),
    npmScripts: npmNames,
    gatedByNpmTest: gated,
    evidenceClass,
    currentProof,
    publicSurfaces: [...new Set(publicSurfaces)],
    directKernel,
    internalRuntimeCalls: internalCalls,
    invokesRuntime,
    loadsCanonicalState,
    realProcess,
    executableVerification,
    sealed,
    reload,
    fixture,
    candidateOnly,
    writesActive,
    externalComparison,
    retired,
    goldAnswerExposure,
    latestEvidence: evidence
  };
}

function build() {
  const pkg = JSON.parse(read('package.json'));
  const scripts = pkg.scripts || {};
  const testChain = String(scripts.test || '').split('&&')
    .map(value => value.trim().replace(/^npm run /, '')).filter(Boolean);
  const activeHash = fs.existsSync(ACTIVE_MODEL) ? sha256(fs.readFileSync(ACTIVE_MODEL)) : null;
  const registry = parseJson(REGISTRY);
  const registryHash = registry?.activeModelSha256 || null;
  const activeProductionProofs = currentProductionProofs(activeHash);
  const allFiles = walk('.');
  const corpus = allFiles.map(file => { try { return read(file); } catch (_) { return ''; } }).join('\n');

  const modules = fs.readdirSync(ROOT).filter(file => /^swarm_.*\.js$/.test(file)).map(file => {
    const text = read(file);
    const base = file.replace('.js', '');
    return {
      file,
      lines: text.split('\n').length,
      reachable: new RegExp(`require\\([^)]*${base}|${base}\\.js`).test(corpus.replace(text, '')),
      exports: (text.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/) || [, ''])[1]
        .split(',').map(value => value.trim().split(':')[0].trim()).filter(value => /^[A-Za-z_]\w*$/.test(value))
    };
  }).sort((a, b) => b.lines - a.lines);

  const benchmarkFiles = fs.readdirSync(path.join(ROOT, 'benchmarks'))
    .filter(file => /^run_.*\.js$/.test(file)).sort();
  const npmByRunner = new Map();
  for (const [name, command] of Object.entries(scripts)) {
    for (const file of benchmarkFiles) {
      if (String(command).includes(file)) {
        if (!npmByRunner.has(file)) npmByRunner.set(file, []);
        npmByRunner.get(file).push(name);
      }
    }
  }
  const gatedCommands = new Set(testChain.map(name => scripts[name]).filter(Boolean));
  const benchmarks = benchmarkFiles.map(file => classifyBenchmark(
    file,
    read(`benchmarks/${file}`),
    (npmByRunner.get(file) || []).sort(),
    [...gatedCommands].some(command => String(command).includes(file)),
    activeHash
  ));

  const scriptFiles = fs.readdirSync(path.join(ROOT, 'scripts')).filter(file => file.endsWith('.js'));
  const referenced = file => Object.values(scripts).some(command => String(command).includes(file));
  const summary = {
    benchmarkCount: benchmarks.length,
    npmScriptCount: Object.keys(scripts).length,
    npmTestGateCount: testChain.length,
    benchmarksGatedByNpmTest: benchmarks.filter(item => item.gatedByNpmTest).length,
    publicSurfaceBenchmarks: benchmarks.filter(item => item.publicSurfaces.length).length,
    publicExecutableProofs: benchmarks.filter(item => item.evidenceClass === 'public-executable-capability-proof').length,
    publicSealedTransferProofs: benchmarks.filter(item => item.evidenceClass === 'public-sealed-transfer-proof').length,
    publicRegressions: benchmarks.filter(item => item.evidenceClass === 'public-surface-regression').length,
    kernelDirectDevelopment: benchmarks.filter(item => item.evidenceClass.includes('kernel-')).length,
    internalComponentDevelopment: benchmarks.filter(item => item.evidenceClass === 'internal-component-development').length,
    infrastructureOrFixture: benchmarks.filter(item => item.evidenceClass === 'infrastructure-or-fixture').length,
    developmentExternalComparisons: benchmarks.filter(item => item.evidenceClass === 'development-external-comparison').length,
    externalComparisonSignals: benchmarks.filter(item => item.externalComparison).length,
    retiredContaminatedPaths: benchmarks.filter(item => item.retired).length,
    goldAnswerExposurePaths: benchmarks.filter(item => item.goldAnswerExposure).length,
    currentFreshActiveProofs: benchmarks.filter(item => item.currentProof).length + activeProductionProofs.length,
    benchmarksWithoutNpmScript: benchmarks.filter(item => item.npmScripts.length === 0).length,
    scriptsWithoutNpmReference: scriptFiles.filter(file => !referenced(file)).length,
    registryHashMatchesActive: Boolean(activeHash && registryHash === activeHash),
    unboundBenchmarkRuntimeSkills: (() => {
      const model = parseJson(ACTIVE_MODEL) || {};
      return (model.compiledSkills || []).filter(skill =>
        /^skill\.runtime\./.test(String(skill?.id || ''))
        && /^runtimeCapability\./.test(String(skill?.sourceKnowledgeId || ''))
        && Array.isArray(skill?.evidence?.invokingBenchmarks)
        && !skill?.lariExecution
      ).length;
    })()
  };

  return {
    schemaVersion: 2,
    kind: 'lari.repository-capability-inventory',
    activeModelSha256: activeHash,
    registryActiveModelSha256: registryHash,
    sourceRule: 'A benchmark is current capability evidence only when it passes, is fresh, is bound to the active model hash, and exercises a public Lari surface without benchmark-answer exposure.',
    summary,
    modules,
    npmTestGates: testChain.map(name => ({ name, command: scripts[name] || null })),
    benchmarks,
    activeProductionProofs
  };
}

function markdown(inventory) {
  const { summary, benchmarks, modules } = inventory;
  const rows = benchmarks.map(item => [
    `\`${item.file}\``,
    item.evidenceClass,
    item.publicSurfaces.join(', ') || 'none',
    item.gatedByNpmTest ? 'yes' : 'no',
    item.latestEvidence ? `${item.latestEvidence.passed === true ? 'pass' : item.latestEvidence.passed === false ? 'fail' : 'unknown'} / ${item.latestEvidence.currentModelBound ? 'active' : 'other hash'} / ${item.latestEvidence.fresh ? 'fresh' : 'stale'}` : 'none',
    item.currentProof ? '**yes**' : 'no'
  ]);
  const table = (headers, values) => [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...values.map(row => `| ${row.join(' | ')} |`)
  ].join('\n');

  return `# Capability inventory

**Generated — do not edit by hand.** \`npm run lari:inventory\` regenerates the Markdown and JSON
inventories. \`npm run lari:inventory:check\` fails when either drifts from the filesystem.

This inventory separates code presence, component tests, public routing, sealed transfer, and current
active-model proof. A benchmark pass is not automatically a Lari capability.

## Evidence rule

${inventory.sourceRule}

## Repository scale

${table(['measure', 'count'], [
    ['benchmark runners', summary.benchmarkCount],
    ['npm scripts', summary.npmScriptCount],
    ['gates in npm test', summary.npmTestGateCount],
    ['benchmark runners directly gated by npm test', summary.benchmarksGatedByNpmTest],
    ['top-level swarm modules', modules.length],
    ['scripts without an npm reference', summary.scriptsWithoutNpmReference]
  ])}

## Benchmark evidence classes

${table(['class', 'count', 'meaning'], [
    ['public sealed transfer proof', summary.publicSealedTransferProofs, 'Strong structural shape; still requires a fresh active-hash-bound pass.'],
    ['public executable capability proof', summary.publicExecutableProofs, 'Uses a public Lari surface and executable verification.'],
    ['public surface regression', summary.publicRegressions, 'Checks visible behavior, often with repository-authored fixtures.'],
    ['kernel-direct development', summary.kernelDirectDevelopment, 'Calls the kernel directly; does not prove all public surfaces.'],
    ['internal component development', summary.internalComponentDevelopment, 'Bypasses the public model path.'],
    ['infrastructure or fixture', summary.infrastructureOrFixture, 'Tests machinery, data, or a fixture rather than a user capability.'],
    ['development external comparisons', summary.developmentExternalComparisons, 'Development pressure only; never production Lari inference.'],
    ['all external-comparison signals', summary.externalComparisonSignals, 'May overlap another evidence class; never production Lari inference.'],
    ['retired contaminated paths', summary.retiredContaminatedPaths, 'Must refuse execution.'],
    ['gold-answer exposure paths', summary.goldAnswerExposurePaths, 'Cannot be capability evidence.'],
    ['fresh active-model public proofs', summary.currentFreshActiveProofs, 'The only rows presently eligible to support a current capability claim.']
  ])}

## Active-model integrity

- Registry hash matches active bytes: **${summary.registryHashMatchesActive ? 'yes' : 'NO'}**
- Unbound benchmark-derived runtime skills in active model: **${summary.unboundBenchmarkRuntimeSkills}**
- Registry-declared hash: **${inventory.registryActiveModelSha256 || 'missing'}**
- Active bytes hash: **${inventory.activeModelSha256 || 'missing'}**

### Current production-surface proofs

${inventory.activeProductionProofs.length
    ? table(['artifact', 'rows', 'surfaces', 'recorded'], inventory.activeProductionProofs.map(item => [
      `\`${item.path}\``, item.publicSurfaceRows, item.surfaces.join(', '), item.recordedAt
    ]))
    : 'None.'}

## Modules

${table(['module', 'lines', 'reachable', 'exports'], modules.map(item => [
    `\`${item.file}\``, item.lines, item.reachable ? 'yes' : '**NO**',
    `${item.exports.slice(0, 4).join(', ')}${item.exports.length > 4 ? ' …' : ''}`
  ]))}

## Gates in \`npm test\`

${inventory.npmTestGates.map(item => `- \`${item.name}\` → \`${item.command || '(missing)'}\``).join('\n')}

## Every benchmark runner

The detailed machine-readable signals—including internal function calls, sealed/reload markers,
candidate-only status, active writes, gold-answer exposure, and report paths—are in
\`CAPABILITY_INVENTORY.json\`.

${table(['runner', 'evidence class', 'public surface', 'npm test', 'latest report', 'current proof'], rows)}
`;
}

function main() {
  const check = process.argv.includes('--check');
  const inventory = build();
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  const md = markdown(inventory);
  if (check) {
    const failures = [];
    if (!fs.existsSync(INVENTORY_MD) || fs.readFileSync(INVENTORY_MD, 'utf8') !== md) failures.push('CAPABILITY_INVENTORY.md');
    if (!fs.existsSync(INVENTORY_JSON) || fs.readFileSync(INVENTORY_JSON, 'utf8') !== json) failures.push('CAPABILITY_INVENTORY.json');
    if (!inventory.summary.registryHashMatchesActive) failures.push('registry hash does not match active model bytes');
    if (inventory.summary.unboundBenchmarkRuntimeSkills > 0) failures.push('active model contains unbound benchmark-derived runtime skills');
    if (failures.length) {
      console.error(`Capability inventory is stale: ${failures.join(', ')}`);
      console.error('Run: npm run lari:inventory');
      process.exit(1);
    }
    console.log(JSON.stringify({ fresh: true, activeModelSha256: inventory.activeModelSha256, summary: inventory.summary }, null, 2));
    return;
  }
  fs.writeFileSync(INVENTORY_MD, md);
  fs.writeFileSync(INVENTORY_JSON, json);
  console.log(JSON.stringify({ updated: ['CAPABILITY_INVENTORY.md', 'CAPABILITY_INVENTORY.json'], activeModelSha256: inventory.activeModelSha256, summary: inventory.summary }, null, 2));
}

main();
