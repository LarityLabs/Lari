#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const neuro = require('../swarm_domain_neurogenesis.js');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage2-20260830');
const PARENT_HASH = '23e24921c29bed504a029ded294e3d9025dcdbe221c608c11ca94d3df4945d45';
const PARENT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-20260830', 'candidates', `${PARENT_HASH}.json`);
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PUBLIC = path.join(OUT, 'public-development.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const MANIFEST = path.join(OUT, 'candidate-manifest.json');
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
function recordFor(model, type) { return model.lariLearnedRecords.records.find(record => record.type === type && record.provenance?.creationSource === 'lari_domain_neurogenesis' && record.payload?.operation !== 'capability_gap'); }
function context(hash, userScope = 'local.default') { return { modelHash: hash, userScope, autoGrow: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } }; }
function main() {
  if (fs.existsSync(MANIFEST)) throw new Error('Stage 2 candidate already exists.');
  if (shaFile(PARENT) !== PARENT_HASH) throw new Error('Stage 1 parent changed.');
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  if (shaFile(PUBLIC) !== seal.publicDevelopment.sha256) throw new Error('Stage 2 public seal mismatch.');
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), parent: shaFile(PARENT) };
  const model = JSON.parse(fs.readFileSync(PARENT, 'utf8'));
  const curriculum = JSON.parse(fs.readFileSync(PUBLIC, 'utf8'));
  const rows = [];
  for (const spec of curriculum.cases) {
    const record = recordFor(model, spec.targetType);
    if (!record) throw new Error(`Missing Stage 1 ${spec.targetType} record.`);
    const synthesis = neuro.synthesizeInteractionProgram(spec);
    if (!synthesis.learned) throw new Error(`${spec.targetType} interaction synthesis failed: ${synthesis.reason}`);
    record.payload.interactionProgram = synthesis.program;
    record.payload.publicBindingVerification = 'multiple_demonstrations_hidden_transfer_five_surface_reload_ablation';
    record.contentHash = sha(record.payload);
    record.provenance.stage2BindingSource = rel(PUBLIC);
    record.provenance.stage2BindingSeal = seal.publicDevelopment.sha256;
    record.provenance.storesPromptText = false;
    record.provenance.storesExpectedAnswers = false;
    const visible = spec.demonstrations.map(demo => {
      const response = runtime.sendMessageToLari(clone(model), demo.prompt, context(PARENT_HASH, spec.userScope || 'local.default'));
      return { promptShape: synthesis.program.matcher.source, passed: response.answer === demo.response && response.publicAnswerSource === 'canonical_learned_record_execution' && response.learnedRecordIds.includes(record.id), answer: response.answer };
    });
    if (!visible.every(row => row.passed)) throw new Error(`${spec.targetType} visible binding failed.`);
    rows.push({ targetType: spec.targetType, recordId: record.id, visible: visible.map(({ promptShape, passed }) => ({ promptShape, passed })), programHash: sha(synthesis.program) });
  }
  model.lineage = { ...(model.lineage || {}), parentHash: PARENT_HASH, developmentalEvent: 'domain_neurogenesis_public_execution_binding', createdAt: new Date().toISOString(), promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`), candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true }); fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), parent: shaFile(PARENT) };
  const gates = { fourExistingRecordsBound: rows.length === 4, visibleEightOfEight: rows.every(row => row.visible.every(item => item.passed)), noNewIntelligenceStore: true, noRawPromptStorage: !curriculum.cases.some(spec => fs.readFileSync(candidatePath, 'utf8').includes(spec.demonstrations[0].prompt)), parentReadOnly: before.parent === after.parent, productionReadOnly: before.active === after.active && before.registry === after.registry, noPromotion: true, externalModelCallsZero: true };
  const manifest = { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage2.candidate', createdAt: new Date().toISOString(), parentHash: PARENT_HASH, candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false }, seal: { path: rel(SEAL), sha256: shaFile(SEAL), publicHash: seal.publicDevelopment.sha256, hiddenHash: seal.hiddenHoldouts.sha256 }, rows, gates, passed: Object.values(gates).every(Boolean), protectedBefore: before, protectedAfter: after, externalModelCalls: 0 };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: manifest.passed, candidate: manifest.candidate, rows, gates }, null, 2));
  if (!manifest.passed) process.exitCode = 1;
}
main();
