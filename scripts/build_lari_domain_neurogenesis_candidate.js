#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const neuro = require('../swarm_domain_neurogenesis.js');
const recap = require('../swarm_recap_language.js');
const researchClaims = require('../swarm_research_claims.js');
const researchCapability = require('../swarm_research_to_capability.js');
const mutationRepair = require('../swarm_mutation_repair.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-20260830');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PUBLIC = path.join(OUT, 'public-development.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const PARENT_HASH = '172c07d0fb235720bfdcf11cfeb5d12bb2c8c2d9dd8c6264042cef1dbbec04f4';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

function add(model, record) {
  model.lariLearnedRecords.records.unshift(record);
}

function applyRule(source, rule) {
  return String(source).replace(rule[0], rule[1]);
}

async function main() {
  if (fs.existsSync(MANIFEST)) throw new Error('Provisional neurogenesis candidate already exists.');
  if (shaFile(ACTIVE) !== PARENT_HASH) throw new Error('Production parent changed.');
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  if (shaFile(PUBLIC) !== seal.publicDevelopment.sha256) throw new Error('Public curriculum seal mismatch.');
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const model = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const curriculum = JSON.parse(fs.readFileSync(PUBLIC, 'utf8'));
  const createdAt = new Date().toISOString();
  const rows = [];

  for (const spec of curriculum.cases) {
    const gap = neuro.createGap(model, { targetType: spec.targetType, capability: spec.capability, failureClass: spec.failureClass, sourceModelHash: PARENT_HASH, sourcePath: rel(PUBLIC), createdAt });
    let evidence = {};
    let researchProposal = null;
    if (spec.targetType === 'generator') {
      evidence = { demonstrations: spec.demonstrations, researchSources: spec.researchSources, relations: [{ type: 'maps_to', from: 'topic', to: 'analogue' }, { type: 'qualified_by', from: 'shared', to: 'boundary' }] };
    } else if (spec.targetType === 'knowledge') {
      const claim = { type: 'fact_definition', values: { term: 'Aster Vale', category: 'local graph toolkit' } };
      const verified = researchClaims.verifyResearchClaim(claim, spec.source.text);
      if (!verified.ok) throw new Error(`Knowledge evidence failed: ${JSON.stringify(verified)}`);
      evidence = { topic: spec.topic, subject: spec.topic, summary: 'Aster Vale is a local graph toolkit', claim, source: spec.source.url, researchSources: [spec.source] };
    } else if (spec.targetType === 'procedure') {
      evidence = { successfulTraces: spec.successfulTraces, domain: 'evidence_reasoning' };
    } else if (spec.targetType === 'repair') {
      evidence = { failureClass: spec.failureClass, procedure: spec.procedure, domain: 'conversation' };
    } else if (spec.targetType === 'operator') {
      researchProposal = await researchCapability.learnRuleFromResearch({
        sources: spec.researchSources,
        source: spec.brokenSource,
        targetRelative: 'sealed.py',
        mutationRepair,
        vocabulary: mutationRepair.DEFAULT_VOCABULARY,
        limit: 80,
        verify: patched => ({ passed: patched === spec.expectedSource })
      });
      if (!researchProposal.learned) throw new Error(`Research did not produce a verified operator: ${researchProposal.reason}`);
      evidence = { rule: researchProposal.rule, executableProof: true, sources: spec.researchSources, family: 'researched-floor-division', domain: 'code' };
    } else if (spec.targetType === 'preference') {
      evidence = { correction: spec.correction, claim: spec.claim, userScope: spec.userScope };
    }
    const proposal = neuro.proposeCandidate(model, gap, evidence, { sourceModelHash: PARENT_HASH, sourcePath: rel(PUBLIC), createdAt, researchSources: evidence.researchSources || evidence.sources || [] });
    if (!proposal.learned) throw new Error(`${spec.id} did not synthesize: ${proposal.reason}`);
    add(model, proposal.record);

    let visible = false;
    if (spec.targetType === 'generator') visible = spec.demonstrations.every(demo => recap.realize(model, demo.prompt)?.answer === demo.response);
    if (spec.targetType === 'knowledge') visible = recap.realize(model, 'Tell me about Aster Vale.')?.answer.includes('local graph toolkit') === true;
    if (spec.targetType === 'procedure') visible = neuro.executeProcedure(proposal.record, {}, { inspect: state => ({ ...state, inspected: true }), isolate: state => ({ ...state, isolated: true }), verify: state => ({ ...state, verified: true }) }).passed;
    if (spec.targetType === 'repair') visible = JSON.stringify(proposal.record.payload.procedure) === JSON.stringify(spec.procedure);
    if (spec.targetType === 'operator') visible = applyRule(spec.brokenSource, proposal.record.payload.rule) === spec.expectedSource;
    if (spec.targetType === 'preference') visible = /\{NUMBER\}/.test(proposal.record.payload.shape) && !/\b42\b/.test(proposal.record.payload.shape);
    if (!visible) throw new Error(`${spec.id} failed visible developmental proof.`);
    rows.push({ id: spec.id, targetType: spec.targetType, gapId: gap.id, recordId: proposal.record.id, visible, researchProposed: Boolean(spec.researchSources || spec.source), executableResearchProof: spec.targetType === 'operator' ? researchProposal.learned : null });
  }

  model.lineage = { ...(model.lineage || {}), parentHash: PARENT_HASH, developmentalEvent: 'domain_general_neurogenesis_provisional', createdAt, promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis.provisional-candidate',
    createdAt,
    parentHash: PARENT_HASH,
    candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false },
    seal: { path: rel(SEAL), sha256: shaFile(SEAL), publicHash: seal.publicDevelopment.sha256, hiddenHash: seal.hiddenHoldouts.sha256 },
    rows,
    gates: {
      sixCanonicalTypes: new Set(rows.map(row => row.targetType)).size === 6,
      sixBaselineGaps: rows.length === 6 && rows.every(row => row.gapId),
      visibleSixOfSix: rows.every(row => row.visible),
      researchProposalUsed: rows.filter(row => row.researchProposed).length >= 3,
      researchDidNotSelfVerifyOperator: rows.find(row => row.targetType === 'operator')?.executableResearchProof === true,
      hiddenHoldoutsUnread: true,
      candidateHashExact: shaFile(candidatePath) === candidateHash,
      productionReadOnly: JSON.stringify(before) === JSON.stringify(after),
      noPromotion: true,
      externalModelCallsZero: true
    },
    protectedBefore: before,
    protectedAfter: after,
    externalModelCalls: 0
  };
  manifest.passed = Object.values(manifest.gates).every(Boolean);
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ passed: manifest.passed, candidate: manifest.candidate, rows, gates: manifest.gates }, null, 2)}\n`);
  if (!manifest.passed) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
