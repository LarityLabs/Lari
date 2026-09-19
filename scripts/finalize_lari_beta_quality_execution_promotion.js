#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const registry = require('./lari_model_registry.js');

const root = path.resolve(__dirname, '..');
const expectedHash = '034cf64f73dd78b4da1f9f6b4a30e4a3a59f5d81a136d1f6c6de49558ca69a22';
const rollbackHash = '06f2543c86eb60dbc20814a437fc1290d52a832c112046c9fbb37974cdc9a8a3';
const outputDir = path.join(root, 'consolidation', 'beta-quality-execution-refinement-production-promotion-20260909-attempt2');
const outputPath = path.join(outputDir, 'post-promotion-validation.json');
const markdownPath = path.join(outputDir, 'POST_PROMOTION_VALIDATION.md');
const sources = {
  promotion: path.join(outputDir, 'promotion-manifest.json'),
  releaseGates: path.join(root, 'consolidation', 'beta-readiness-20260908', 'release-gates.json'),
  productAcceptance: path.join(root, 'consolidation', 'beta-readiness-20260908', 'product-acceptance.json'),
  soak: path.join(root, 'benchmarks', 'latest-lari-product-soak-report.json'),
  smoke: path.join(root, 'benchmarks', 'latest-lari-first-run-product-smoke-report.json'),
  betaReadiness: path.join(root, 'consolidation', 'beta-readiness-20260908', 'beta-readiness-summary.json'),
  fullReport: path.join(root, 'LARI_FULL_REPORT.json')
};
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rel = file => path.relative(root, file).replace(/\\/g, '/');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(!fs.existsSync(outputPath) && !fs.existsSync(markdownPath), 'Post-promotion validation is already finalized.');
for (const file of Object.values(sources)) assert(fs.existsSync(file), `Missing evidence: ${rel(file)}`);
const evidence = Object.fromEntries(Object.entries(sources).map(([key, file]) => [key, read(file)]));
const activeHash = sha256(registry.currentModelPath);
const registryState = registry.readLariModelRegistry();
const control = JSON.parse(require('child_process').execFileSync(process.execPath, ['scripts/lari_control_plane.js', 'status'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, LARI_DISABLE_MODEL_FALLBACKS: '1', LARI_ALLOW_LEGACY_ROOT_MODEL: '0' }
}));
const rollbackVisible = registry.listLariModelHistory().history.some(item => item.sha256 === rollbackHash && item.rollbackAvailable);
const gates = {
  exactActiveHash: activeHash === expectedHash,
  registryHashMatches: registryState.activeModelSha256 === expectedHash,
  completeCanonicalChain39of39: evidence.releaseGates.passed === true
    && evidence.releaseGates.results?.length === 39
    && evidence.releaseGates.results.every(row => row.passed === true),
  activeReadOnlyDuringCanonicalChain: evidence.releaseGates.gates?.activeReadOnly === true
    && evidence.releaseGates.gates?.registryReadOnly === true,
  publicSurfaceProductAcceptance: evidence.productAcceptance.passed === true
    && evidence.productAcceptance.activeHash === expectedHash,
  productSoak50of50: evidence.soak.passed === true
    && evidence.soak.summary?.passedCount === 50
    && evidence.soak.summary?.taskCount === 50,
  firstRunSmoke9of9: evidence.smoke.passed === true
    && evidence.smoke.activeModelHash === expectedHash
    && evidence.smoke.summary?.passedCount === 9,
  controlPlaneConsistent: control.active?.sha256 === expectedHash
    && control.candidate?.sha256 === expectedHash
    && control.candidate?.sameAsActive === true
    && control.candidate?.promoted === true
    && control.candidate?.status === 'promoted',
  rollbackTargetAvailable: rollbackVisible,
  noExternalModelCalls: evidence.productAcceptance.externalModelCalls === 0
    && evidence.soak.externalModelCalls === 0
    && evidence.smoke.externalModelCalls === 0,
  controlledBetaVerdict: evidence.betaReadiness.verdict === 'READY FOR CONTROLLED PUBLIC BETA'
};
assert(Object.values(gates).every(Boolean), `Final post-promotion gate failed: ${JSON.stringify(gates)}`);

const report = {
  schemaVersion: 1,
  kind: 'lari-beta-quality-execution-post-promotion-validation',
  createdAt: new Date().toISOString(),
  activeHash,
  registryHash: sha256(registry.registryPath),
  rollbackHash,
  rollbackVisible,
  canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
  evidence: Object.fromEntries(Object.entries(sources).map(([key, file]) => [key, { path: rel(file), sha256: sha256(file) }])),
  gates,
  verdict: 'PROMOTION VALIDATED — READY FOR CONTROLLED PUBLIC BETA',
  externalModelCalls: 0
};
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
fs.writeFileSync(markdownPath, `# Lari post-promotion validation\n\n- Active hash: \`${activeHash}\`\n- Rollback hash: \`${rollbackHash}\`\n- Canonical chain: **39/39**\n- Product soak: **50/50**\n- First-run smoke: **9/9**\n- Public surfaces: **Workbench, CLI, OpenAI-compatible API, autonomous — passed with the active hash**\n- External model calls: **0**\n- Verdict: **PROMOTION VALIDATED — READY FOR CONTROLLED PUBLIC BETA**\n`, { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
