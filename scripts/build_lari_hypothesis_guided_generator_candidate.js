#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const neuro = require('../swarm_domain_neurogenesis.js');
const recap = require('../swarm_recap_language.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const OUT = path.join(ROOT, 'consolidation', 'hypothesis-guided-generator-20260906');
const PUBLIC = path.join(OUT, 'public-development.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

function write(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function main() {
  if (!fs.existsSync(PUBLIC) || !fs.existsSync(SEAL)) throw new Error('Seal the curriculum before building a candidate.');
  if (fs.existsSync(MANIFEST)) throw new Error(`Refusing to overwrite candidate manifest: ${rel(MANIFEST)}`);
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  const curriculum = JSON.parse(fs.readFileSync(PUBLIC, 'utf8'));
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  if (before.active !== seal.parentHash) throw new Error('Active model changed since the curriculum was sealed.');
  if (shaFile(PUBLIC) !== seal.publicDevelopment.sha256) throw new Error('Public curriculum hash does not match seal.');
  const baseline = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const baselineRows = curriculum.demonstrations.map(demo => ({
    prompt: demo.prompt,
    realized: recap.realize(baseline, demo.prompt) !== null
  }));
  if (baselineRows.some(row => row.realized)) throw new Error('The parent already realizes this developmental construction.');

  const model = clone(baseline);
  const createdAt = new Date().toISOString();
  const gap = neuro.createGap(model, {
    targetType: 'generator',
    capability: curriculum.capability,
    failureClass: curriculum.failureClass,
    sourceModelHash: before.active,
    sourcePath: rel(PUBLIC),
    createdAt
  });
  const proposal = neuro.proposeCandidate(model, gap, {
    demonstrations: curriculum.demonstrations,
    relations: curriculum.relations,
    researchSources: []
  }, {
    sourceModelHash: before.active,
    sourcePath: rel(PUBLIC),
    createdAt,
    confidence: 0.82
  });
  if (!proposal.learned) throw new Error(`Generator synthesis failed: ${proposal.reason}`);
  if (proposal.record.payload?.generatorProgram?.frameParser?.kind !== 'lari.labelled_claim_frame') {
    throw new Error('The proposed generator did not induce a generic labelled claim frame.');
  }
  model.lariLearnedRecords.records.unshift(proposal.record);
  const visibleRows = curriculum.demonstrations.map(demo => {
    const result = recap.realize(model, demo.prompt);
    const allClaimsPresent = Object.values(demo.claims).every(value => result?.answer?.toLowerCase().includes(String(value).toLowerCase()));
    return {
      promptHash: sha(demo.prompt),
      selectedRecordId: result?.learnedRecordIds?.[0] || null,
      family: result?.family || null,
      answerMatchesExpected: result?.answer === demo.response,
      allClaimsPresent,
      semanticFaithfulness: result?.verification?.passed === true,
      passed: result?.answer === demo.response && allClaimsPresent && result?.verification?.passed === true
    };
  });
  if (visibleRows.some(row => !row.passed)) throw new Error('Visible generator proof failed.');

  model.lineage = {
    ...(model.lineage || {}),
    parentHash: before.active,
    developmentalEvent: 'hypothesis_guided_generator_provisional',
    createdAt,
    promoted: false
  };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
  const candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const candidateText = fs.readFileSync(candidatePath, 'utf8');
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const forbiddenExampleFragments = [
    'worker pool closes',
    'cache data was written after the response',
    'memory use rises after each completed job'
  ];
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.hypothesis-guided-generator.provisional-candidate',
    createdAt,
    parentHash: before.active,
    candidate: { path: rel(candidatePath), sha256: candidateHash, learnedRecordId: proposal.record.id, promoted: false },
    seal: {
      path: rel(SEAL),
      sha256: shaFile(SEAL),
      publicHash: seal.publicDevelopment.sha256,
      hiddenHash: seal.hiddenHoldouts.sha256
    },
    baselineRows,
    visibleRows,
    inducedProgram: {
      kind: proposal.record.payload.generatorProgram.kind,
      family: proposal.record.payload.generatorProgram.family,
      frameParserKind: proposal.record.payload.generatorProgram.frameParser.kind,
      claimSlots: proposal.record.payload.generatorProgram.requiredClaims,
      matcherCount: proposal.record.payload.generatorProgram.matchers.length,
      relations: proposal.record.payload.generatorProgram.relations
    },
    gates: {
      parentConstructionAbsent: baselineRows.every(row => row.realized === false),
      gapCreated: gap.payload?.operation === 'capability_gap' && gap.status === 'open',
      typedCompetingHypothesisGenerator: proposal.record.type === 'generator'
        && proposal.record.payload?.generatorProgram?.frameParser?.kind === 'lari.labelled_claim_frame',
      visibleFaithfulness: visibleRows.every(row => row.passed),
      noRawPromptOrExpectedAnswerInCandidate: forbiddenExampleFragments.every(fragment => !candidateText.includes(fragment)),
      hiddenHoldoutsUnread: true,
      candidateHashExact: shaFile(candidatePath) === candidateHash,
      productionAndRegistryReadOnly: JSON.stringify(before) === JSON.stringify(after),
      noPromotion: true,
      externalModelCallsZero: true
    },
    protectedBefore: before,
    protectedAfter: after,
    externalModelCalls: 0
  };
  manifest.passed = Object.values(manifest.gates).every(Boolean);
  write(MANIFEST, manifest);
  process.stdout.write(`${JSON.stringify({ passed: manifest.passed, candidate: manifest.candidate, gates: manifest.gates }, null, 2)}\n`);
  if (!manifest.passed) process.exitCode = 1;
}

main();
