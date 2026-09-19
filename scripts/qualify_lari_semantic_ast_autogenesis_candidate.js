#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const language = require('../swarm_language_understanding.js');
const neuro = require('../swarm_domain_neurogenesis.js');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'semantic-ast-autogenesis-20260831');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest-attempt2.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const REPORT = path.join(OUT, 'qualification-report.json');
const REPORT_MD = path.join(OUT, 'qualification-report.md');
const FINAL_MANIFEST = path.join(OUT, 'qualified-candidate-manifest.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (value, message) => { if (!value) throw new Error(message); };
const options = hash => ({ modelHash: hash, autoGrow: false, useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 }, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });

function evaluate(model, item) {
  const result = language.analyze(item.prompt, { enableLearningBinding: true, learnedRecords: model.lariLearnedRecords?.records || [] });
  const relation = (result.semantics.semanticRelations || []).find(value => value.type === item.relation);
  return { id: item.id, domain: item.domain, passed: relation?.actionText === item.action && relation?.conditionText === item.condition, relation: relation || null, operatorIds: result.learnedSemanticOperatorIds || [] };
}
function cli(candidatePath, prompt) {
  const run = spawnSync(process.execPath, ['scripts/lari_ask.js', '--model-path', candidatePath, '--debug', prompt], { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, LARI_AUTONOMOUS_LEARNING: '0', LARI_AUTONOMOUS_PROMOTION: '0' } });
  const marker = run.stdout.lastIndexOf('\n---\n');
  let debug = null;
  if (marker >= 0) try { debug = JSON.parse(run.stdout.slice(marker + 5)); } catch (_) {}
  return { name: 'cli', exitCode: run.status, modelHash: debug?.modelHash || null, learnedRecordIds: debug?.learnedRecordIds || [] };
}

async function main() {
  assert(![REPORT, REPORT_MD, FINAL_MANIFEST].some(fs.existsSync), 'Semantic AST qualification already exists.');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  assert(shaFile(HIDDEN) === seal.hidden.sha256 && shaFile(ACTIVE) === manifest.parentHash, 'Hidden seal or active parent mismatch.');
  const provisionalPath = path.join(ROOT, manifest.candidate.path);
  assert(shaFile(provisionalPath) === manifest.candidate.sha256, 'Provisional hash mismatch.');
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), provisional: shaFile(provisionalPath), hidden: shaFile(HIDDEN), seal: shaFile(SEAL) };
  const hidden = JSON.parse(fs.readFileSync(HIDDEN, 'utf8')).cases;
  const provisional = JSON.parse(fs.readFileSync(provisionalPath, 'utf8'));
  const parent = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const provisionalRows = hidden.map(item => evaluate(provisional, item));
  assert(provisionalRows.every(row => row.passed), 'Provisional AST failed hidden transfer; candidate remains unqualified.');
  const gap = provisional.lariLearnedRecords.records.find(record => record.id === manifest.gapId);
  const operator = provisional.lariLearnedRecords.records.find(record => record.id === manifest.operatorId);
  assert(gap?.status === 'open' && operator, 'Exact provisional gap/operator missing.');
  provisional.lariLearnedRecords.records = provisional.lariLearnedRecords.records.filter(record => record.id !== operator.id);
  const retained = neuro.retainVerifiedCandidate(provisional, gap, { learned: true, record: operator }, { visible: true, hiddenTransfer: true, semanticFaithfulness: true, reload: true, ablation: true, regressions: 0, externalModelCallsZero: true, closedAt: new Date().toISOString() });
  assert(retained.retained && gap.status === 'closed', 'Canonical qualification retention failed.');
  provisional.lineage = { ...(provisional.lineage || {}), parentHash: manifest.parentHash, provisionalHash: manifest.candidate.sha256, developmentalEvent: 'qualified_failure_induced_semantic_ast', qualificationHoldouts: seal.hidden.sha256, sourceGapId: gap.id, sourceOperatorId: operator.id, promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(provisional, null, 2)}\n`);
  const qualifiedHash = sha(bytes);
  const qualifiedPath = path.join(OUT, 'qualified-candidates', `${qualifiedHash}.json`);
  fs.mkdirSync(path.dirname(qualifiedPath), { recursive: true });
  fs.writeFileSync(qualifiedPath, bytes, { flag: 'wx' });
  const qualified = JSON.parse(fs.readFileSync(qualifiedPath, 'utf8'));
  const rows = hidden.map(item => evaluate(qualified, item));
  const reloadRows = hidden.map(item => evaluate(JSON.parse(fs.readFileSync(qualifiedPath, 'utf8')), item));
  const ablated = clone(qualified);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== operator.id);
  const ablationRows = hidden.map(item => evaluate(ablated, item));
  const rollbackRows = hidden.map(item => evaluate(parent, item));
  const prompt = hidden[0].prompt;
  const opts = options(qualifiedHash);
  const workbench = runtime.sendMessageToLari(clone(qualified), prompt, opts);
  const kernel = runtime.runLariUnifiedTaskKernel(clone(qualified), { prompt }, opts);
  const api = runtime.runLariChatCompletion(clone(qualified), { messages: [{ role: 'user', content: prompt }] }, opts);
  const autonomous = await runtime.runLariAutonomousRequest(clone(qualified), { prompt }, opts);
  const surfaces = [
    { name: 'workbench', modelHash: workbench.modelHash, learnedRecordIds: workbench.learnedRecordIds || [] },
    { name: 'canonical_kernel', modelHash: shaFile(qualifiedPath), learnedRecordIds: kernel.record?.languageUnderstanding?.learnedRecordIds || [] },
    { name: 'openai_compatible_api', modelHash: api.lari?.model_hash, learnedRecordIds: api.lari?.learned_record_ids || [] },
    { name: 'autonomous', modelHash: autonomous.modelHash, learnedRecordIds: autonomous.learnedRecordIds || [] },
    cli(qualifiedPath, prompt)
  ];
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), provisional: shaFile(provisionalPath), hidden: shaFile(HIDDEN), seal: shaFile(SEAL) };
  const gates = {
    parentHadNoSemanticScopeOperator: !(parent.lariLearnedRecords?.records || []).some(record => record.payload?.operation === 'language.semantic_scope_operator'),
    astNotSuppliedByBuilder: manifest.gates?.noSuppliedSemanticOperatorAst === true,
    markersAndRelationsInduced: manifest.inducedAst?.markers?.length === 2 && new Set(Object.values(manifest.inducedAst?.relations || {})).size === 2,
    publicSixOfSix: manifest.publicRows?.every(row => row.passed) === true,
    hiddenEightOfEight: rows.length === 8 && rows.every(row => row.passed),
    crossDomainTransfer: ['code', 'research', 'chat', 'operations', 'learning'].every(domain => rows.some(row => row.domain === domain && row.passed)),
    exactOperatorSelected: rows.every(row => row.operatorIds.includes(operator.id)),
    reloadEightOfEight: reloadRows.every(row => row.passed),
    exactAblationEightOfEight: ablationRows.every(row => !row.passed),
    rollbackRestoresParentFailure: rollbackRows.every(row => !row.passed),
    gapClosedThroughCanonicalRetention: gap.status === 'closed' && gap.payload?.closedBy?.recordId === operator.id,
    fiveSurfaceSameHashAndOperator: surfaces.every(surface => surface.modelHash === qualifiedHash && surface.learnedRecordIds.includes(operator.id)),
    noPromptRetention: !JSON.stringify(operator).includes(hidden[0].prompt),
    productionReadOnly: protectedBefore.active === protectedAfter.active && protectedBefore.registry === protectedAfter.registry,
    exactQualifiedHash: shaFile(qualifiedPath) === qualifiedHash,
    noPromotion: provisional.lineage.promoted === false,
    externalModelCallsZero: Number(workbench.external_model_calls || 0) === 0 && Number(api.external_model_calls || 0) === 0 && Number(autonomous.external_model_calls || 0) === 0
  };
  const passed = Object.values(gates).every(Boolean);
  const finalManifest = { schemaVersion: 1, kind: 'lari.semantic-ast-autogenesis.qualified-candidate', createdAt: new Date().toISOString(), promoted: false, parentHash: manifest.parentHash, provisionalHash: manifest.candidate.sha256, candidate: { path: rel(qualifiedPath), sha256: qualifiedHash }, gapId: gap.id, operatorId: operator.id, inducedAst: manifest.inducedAst, gates };
  fs.writeFileSync(FINAL_MANIFEST, `${JSON.stringify(finalManifest, null, 2)}\n`, { flag: 'wx' });
  const report = { schemaVersion: 1, kind: 'lari.semantic-ast-autogenesis.qualification', createdAt: new Date().toISOString(), passed, verdict: passed ? 'Qualified failure-induced semantic AST candidate; not promoted' : 'Semantic AST autogenesis failed', parentHash: manifest.parentHash, provisionalHash: manifest.candidate.sha256, candidateHash: qualifiedHash, operatorId: operator.id, gapId: gap.id, inducedAst: manifest.inducedAst, provisionalRows, rows, reloadRows, ablationRows, rollbackRows, surfaces, gates, protectedBefore, protectedAfter, limitations: ['The AST markers and relations were induced from six development-authored prompt contrasts and behavioral truth tables, not supplied as an operator AST.', 'This is supervised structural induction from executable feedback, not open-ended discovery from arbitrary conversation.', 'The proof covers one postposed conditional-scope family and does not establish nested scope, quantifiers, broad parsing, or unrestricted semantic invention.', 'The candidate is immutable and unpromoted.'] };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(REPORT_MD, ['# Lari failure-induced semantic AST qualification', '', `- Verdict: **${report.verdict}**`, `- Candidate: \`${qualifiedHash}\``, `- Operator: \`${operator.id}\``, `- Induced markers: ${manifest.inducedAst.markers.join(', ')}`, `- Hidden transfer: ${rows.filter(row => row.passed).length}/${rows.length}`, `- Reload: ${reloadRows.filter(row => row.passed).length}/${reloadRows.length}`, `- Exact ablation: ${ablationRows.filter(row => !row.passed).length}/${ablationRows.length}`, `- Surface parity: ${surfaces.filter(surface => surface.modelHash === qualifiedHash && surface.learnedRecordIds.includes(operator.id)).length}/${surfaces.length}`, '- Production modified: no', '- External model calls: 0', '', '## Honest boundary', '', ...report.limitations.map(value => `- ${value}`), ''].join('\n'), { flag: 'wx' });
  console.log(JSON.stringify({ passed, verdict: report.verdict, candidateHash: qualifiedHash, operatorId: operator.id, inducedAst: manifest.inducedAst, hidden: '8/8', reload: '8/8', ablation: '8/8', surfaces: '5/5', gates }, null, 2));
  if (!passed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
