#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'chat-coding-expansion-20260829');
const PARENT_HASH = '7d3b16aabeca3848d3e7b668667311ae85f2e1e99a3ec6b65ede850e08715c0a';
const PARENT = path.join(ROOT, 'consolidation', 'conversational-learning-binding-20260829', 'candidates', `${PARENT_HASH}.json`);
const SEAL = path.join(OUT, 'sealed-curriculum.json');
const ORACLE_AMENDMENT = path.join(OUT, 'sealed-oracle-amendment.json');
const REPORT = path.join(OUT, 'training-report-v4.json');
const MANIFEST = path.join(OUT, 'candidate-manifest-v4.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (fs.existsSync(MANIFEST)) throw new Error('Expansion candidate manifest already exists.');
if (sha(PARENT) !== PARENT_HASH) throw new Error('Expansion parent is missing or changed.');
const before = { parent: sha(PARENT), active: sha(ACTIVE), registry: sha(REGISTRY), seal: sha(SEAL), oracleAmendment: sha(ORACLE_AMENDMENT) };
const result = spawnSync(process.execPath, [path.join(ROOT, 'benchmarks', 'run_lari_unknown_bug_workspace_gauntlet_eval.js')], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    LARI_MODEL_BASE: path.relative(ROOT, PARENT),
    LARI_CHAT_EXPANSION_SEAL: path.relative(ROOT, SEAL),
    LARI_GAUNTLET_TMP_ROOT: 'consolidation/chat-coding-expansion-20260829/workspaces-v4',
    LARI_GAUNTLET_REPORT: path.relative(ROOT, REPORT),
    LARI_CANDIDATE_DIR: 'consolidation/chat-coding-expansion-20260829/candidates'
  }, maxBuffer: 16 * 1024 * 1024
});
process.stdout.write(result.stdout || '');
if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}
const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
if (!report.passed || !report.candidate?.path) throw new Error('Training report did not produce a passing immutable candidate.');
const candidatePath = path.join(ROOT, report.candidate.path);
const after = { parent: sha(PARENT), active: sha(ACTIVE), registry: sha(REGISTRY), seal: sha(SEAL), oracleAmendment: sha(ORACLE_AMENDMENT) };
const manifest = {
  schemaVersion: 1, kind: 'lari.chat-coding-expansion.candidate', createdAt: new Date().toISOString(), promoted: false,
  candidate: report.candidate,
  sealedCurriculum: { path: path.relative(ROOT, SEAL).replace(/\\/g, '/'), sha256: before.seal },
  sealedOracleAmendment: { path: path.relative(ROOT, ORACLE_AMENDMENT).replace(/\\/g, '/'), sha256: before.oracleAmendment },
  trainingReport: { path: path.relative(ROOT, REPORT).replace(/\\/g, '/'), passed: report.passed },
  learnedChatRecordIds: report.learnedChatRecordIds,
  canonicalRepairRecordIds: report.run?.canonicalRepairRecordIds || [],
  languages: report.summary?.inferredLanguages || [],
  executableCases: report.summary?.afterFixed || 0,
  protectedBefore: before, protectedAfter: after,
  gates: {
    exactParent: before.parent === PARENT_HASH,
    candidateHashExact: sha(candidatePath) === report.candidate.sha256,
    nineLanguages: report.summary?.inferredLanguages?.length === 9,
    sixtySixFailureToPass: report.summary?.baselineFixed === 0 && report.summary?.afterFixed === 66,
    reloadSixtySix: report.summary?.reloadFixed === 66,
    immutableOraclesSixtySix: report.summary?.immutableOracles === 66 && report.oracleIntegrity?.every(item => item.unchanged),
    observedOracleExecutionsSixtySix: report.summary?.observedOracleExecutions === 66 && report.oracleIntegrity?.every(item => item.afterExecutionObserved && item.reloadExecutionObserved),
    eightChatRecords: report.learnedChatRecordIds?.length === 8,
    productionUnchanged: before.active === after.active && before.registry === after.registry,
    noPromotion: true,
    externalModelCallsZero: report.externalModelCalls === 0
  }
};
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ candidate: manifest.candidate, languages: manifest.languages, executableCases: manifest.executableCases, chatRecords: manifest.learnedChatRecordIds.length, gates: manifest.gates }, null, 2));
if (!Object.values(manifest.gates).every(Boolean)) process.exitCode = 1;
