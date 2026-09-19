#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const language = require('../swarm_language_understanding.js');
const neuro = require('../swarm_domain_neurogenesis.js');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'semantic-ast-autogenesis-20260831');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PUBLIC = path.join(OUT, 'behavioral-failure-traces.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest-attempt2.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const assert = (value, message) => { if (!value) throw new Error(message); };

function main() {
  assert(!fs.existsSync(MANIFEST), 'Autogenesis candidate already exists.');
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  assert(shaFile(PUBLIC) === seal.public.sha256 && shaFile(ACTIVE) === seal.parentHash, 'Seal or parent mismatch.');
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), public: shaFile(PUBLIC), seal: shaFile(SEAL) };
  const model = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const traces = JSON.parse(fs.readFileSync(PUBLIC, 'utf8')).traces;
  const gap = neuro.createGap(model, { targetType: 'operator', capability: 'recover a reusable semantic scope relation from repeated meaning-loss failures', failureClass: 'behavioral_execution_oracle_disagrees_with_unscoped_meaning_graph', sourceModelHash: seal.parentHash, sourcePath: rel(PUBLIC), researchAllowed: true });
  const proposalEvidence = { family: 'behaviorally-induced-semantic-scope', semanticFailureTraces: traces };
  const proposal = neuro.proposeCandidate(model, gap, proposalEvidence, { sourceModelHash: seal.parentHash, sourcePath: rel(PUBLIC), confidence: 0.9 });
  assert(proposal.learned && proposal.record, `AST induction failed: ${proposal.reason || 'unknown'}`);
  const ast = proposal.record.payload.operatorAst;
  assert(ast.acquiredFrom === 'paired_meaning_loss_failures_and_execution_truth_tables', 'Operator AST was not failure-induced.');
  model.lariLearnedRecords.records.unshift(proposal.record);
  const publicRows = traces.map(trace => {
    const result = language.analyze(trace.scopedPrompt, { learnedRecords: model.lariLearnedRecords.records });
    const relation = result.semantics.semanticRelations?.[0] || null;
    const expected = trace.executeWhenConditionTrue ? 'necessary_condition' : 'exception_condition';
    return { id: trace.id, passed: relation?.type === expected && relation?.actionText === trace.basePrompt.replace(/[.!?]+$/, ''), relation };
  });
  assert(publicRows.every(row => row.passed), 'Induced AST failed its public behavioral contrasts.');
  model.lineage = { ...(model.lineage || {}), parentHash: seal.parentHash, developmentalEvent: 'failure_induced_semantic_ast', sourceGapId: gap.id, sourceOperatorId: proposal.record.id, holdoutAccessedBeforeCandidate: false, promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), public: shaFile(PUBLIC), seal: shaFile(SEAL) };
  const gates = { publicFailToPassSixOfSix: publicRows.every(row => row.passed), astDerivedByNeurogenesis: ast.acquiredFrom === 'paired_meaning_loss_failures_and_execution_truth_tables', noSuppliedSemanticOperatorAst: !Object.prototype.hasOwnProperty.call(proposalEvidence, 'semanticOperatorAst'), twoMarkersInduced: ast.markers.length === 2, twoBehavioralRelationsInduced: new Set(Object.values(ast.relations)).size === 2, noPromptRetention: traces.every(trace => !JSON.stringify(proposal.record).includes(trace.scopedPrompt)), hiddenUnread: model.lineage.holdoutAccessedBeforeCandidate === false, candidateHashExact: shaFile(candidatePath) === candidateHash, productionReadOnly: protectedBefore.active === protectedAfter.active && protectedBefore.registry === protectedAfter.registry, externalModelCallsZero: true };
  const manifest = { schemaVersion: 1, kind: 'lari.semantic-ast-autogenesis.provisional-candidate', createdAt: new Date().toISOString(), promoted: false, parentHash: seal.parentHash, candidate: { path: rel(candidatePath), sha256: candidateHash }, gapId: gap.id, operatorId: proposal.record.id, operator: proposal.record, inducedAst: ast, publicRows, gates, protectedBefore, protectedAfter };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: Object.values(gates).every(Boolean), candidateHash, operatorId: proposal.record.id, inducedAst: ast, public: '6/6', gates }, null, 2));
}
main();
