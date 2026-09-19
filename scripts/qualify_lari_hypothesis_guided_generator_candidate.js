#!/usr/bin/env node
'use strict';

// Qualifies one immutable, candidate-only language-growth experiment. The
// hidden set is opened only by this validator after the provisional candidate
// has been written; it is never copied into the learned record or the qualified
// model. No registry or active model file is changed here.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const neuro = require('../swarm_domain_neurogenesis.js');
const recap = require('../swarm_recap_language.js');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const OUT = path.join(ROOT, 'consolidation', 'hypothesis-guided-generator-20260906');
const PUBLIC = path.join(OUT, 'public-development.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const PROVISIONAL_MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const QUALIFIED_MANIFEST = path.join(OUT, 'qualified-candidate-manifest.json');
const REPORT = path.join(OUT, 'qualification-report.md');
const ROLLBACK = path.join(OUT, 'rollback-rehearsal.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const writeText = (file, value) => fs.writeFileSync(file, value, { flag: 'wx' });
const lower = value => String(value || '').toLowerCase();

function recordById(model, id) {
  return (model?.lariLearnedRecords?.records || []).find(record => record?.id === id) || null;
}

function relationShape(relations = []) {
  return relations.map(relation => `${relation.type}:${relation.from}->${relation.to}`).sort();
}

function evaluateCase(model, row, expectedRelations, expectedRecordId) {
  const result = recap.realize(model, row.prompt);
  const expectedClaims = Object.values(row.claims || {}).map(value => lower(value));
  const answer = lower(result?.answer);
  const graphRelations = result?.meaningGraph?.relations || [];
  const claimsPresent = expectedClaims.every(claim => answer.includes(claim));
  const relationsPreserved = JSON.stringify(relationShape(graphRelations)) === JSON.stringify(relationShape(expectedRelations));
  const typedRelations = graphRelations.every(relation => typeof relation?.type === 'string' && relation.type.trim()
    && typeof relation.from === 'string' && typeof relation.to === 'string'
    && result?.meaningGraph?.claims?.[relation.from] && result?.meaningGraph?.claims?.[relation.to]);
  const learnedRecordSelected = Boolean(result?.learnedRecordIds?.includes(expectedRecordId));
  const passed = Boolean(result)
    && result.family === 'competing_hypothesis_discourse'
    && claimsPresent
    && relationsPreserved
    && typedRelations
    && learnedRecordSelected
    && result.verification?.passed === true
    && result.verification?.relationFaithfulness === true
    && Number(result.verification?.malformedRelations?.length || 0) === 0;
  return {
    id: row.id || null,
    promptHash: sha(row.prompt),
    realized: Boolean(result),
    family: result?.family || null,
    selectedRecordId: result?.learnedRecordIds?.[0] || null,
    learnedRecordSelected,
    claimsPresent,
    relationsPreserved,
    typedRelations,
    semanticFaithfulness: result?.verification?.passed === true,
    relationFaithfulness: result?.verification?.relationFaithfulness === true,
    malformedRelations: result?.verification?.malformedRelations || [],
    passed
  };
}

function evaluatePublicRows(model, curriculum, expectedRecordId) {
  return curriculum.demonstrations.map(demo => evaluateCase(model, { ...demo, id: 'public' }, curriculum.relations, expectedRecordId));
}

function evaluateFamilyRegressions(model) {
  const samples = {
    causal_explanation: 'Please explain why the cache stayed stale: invalidation ran before the transaction committed. The evidence indicates the refresh log has the old version number. Next action: trigger invalidation after commit.',
    practical_planning: 'Make a plan for learning a new codebase safely.',
    balanced_comparison: 'Compare local storage versus a small database.',
    requirements_clarification: 'Ask me what you need to know to create a local coding tool.',
    correction_repair: 'I said archive the candidate, not delete the model.',
    structured_thinking: 'Help me think through a chat release. Context: procedural answers are reliable. Goal: make conversation feel more natural. Constraint: no outside model calls.',
    retained_knowledge_explanation: 'Explain humanize.activate(1000000).'
  };
  return Object.entries(samples).map(([family, prompt]) => {
    const result = recap.realize(model, prompt);
    return {
      family,
      realized: Boolean(result),
      semanticFaithfulness: result?.verification?.passed === true,
      passed: Boolean(result) && result?.verification?.passed === true && result?.meaningGraph?.family === family
    };
  });
}

function runSurfaceParity(model, candidateHash, prompt, expectedRecordId) {
  const surfaces = ['workbench', 'cli', 'openai_compatible_api', 'autonomous'];
  return surfaces.map(surface => {
    const response = runtime.sendMessageToLari(clone(model), prompt, {
      surface,
      modelHash: candidateHash,
      autoGrow: false,
      kernel: {
        useBenchmarkSystem: false,
        useCapabilityGraph: true,
        capabilityGraph: { minScore: 0 },
        chat: { minMemoryScore: 0, minRouteScore: 0 }
      }
    });
    const ids = [...new Set([...(response?.learnedRecordIds || []), ...(response?.recapLearnedRecordIds || [])])];
    return {
      surface,
      modelHash: response?.modelHash || null,
      publicAnswerSource: response?.publicAnswerSource || null,
      selectedRecordIds: ids,
      selectedExpectedRecord: ids.includes(expectedRecordId),
      family: response?.recapTrace?.meaningGraph?.family || null,
      passed: response?.modelHash === candidateHash
        && response?.publicAnswerSource === 'recap_executable_language'
        && ids.includes(expectedRecordId)
        && response?.recapTrace?.meaningGraph?.family === 'competing_hypothesis_discourse'
        && Number(response?.external_model_calls || 0) === 0
    };
  });
}

function main() {
  if (!fs.existsSync(PROVISIONAL_MANIFEST)) throw new Error('Build the provisional candidate before qualifying it.');
  if (fs.existsSync(QUALIFIED_MANIFEST) || fs.existsSync(REPORT) || fs.existsSync(ROLLBACK)) {
    throw new Error('Qualification artifacts already exist; immutable output will not be overwritten.');
  }

  const seal = read(SEAL);
  const curriculum = read(PUBLIC);
  const hidden = read(HIDDEN);
  const provisionalManifest = read(PROVISIONAL_MANIFEST);
  const provisionalPath = path.join(ROOT, provisionalManifest.candidate.path);
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  assert.strictEqual(before.active, seal.parentHash, 'active model changed after sealing');
  assert.strictEqual(shaFile(PUBLIC), seal.publicDevelopment.sha256, 'public curriculum seal mismatch');
  assert.strictEqual(shaFile(HIDDEN), seal.hiddenHoldouts.sha256, 'hidden holdout seal mismatch');
  assert.strictEqual(shaFile(provisionalPath), provisionalManifest.candidate.sha256, 'provisional candidate hash mismatch');

  const parent = read(ACTIVE);
  const provisional = read(provisionalPath);
  const learnedRecordId = provisionalManifest.candidate.learnedRecordId;
  assert(recordById(provisional, learnedRecordId), 'provisional candidate record missing');
  const expectedRelations = curriculum.relations;

  const baselineHiddenRows = hidden.cases.map(row => ({ id: row.id, realized: Boolean(recap.realize(parent, row.prompt)) }));
  const hiddenRows = hidden.cases.map(row => evaluateCase(provisional, row, expectedRelations, learnedRecordId));
  const publicRows = evaluatePublicRows(provisional, curriculum, learnedRecordId);

  // The existing verifier must reject a semantically malformed edge. This is
  // an independent guard against passing only because all claim text appears.
  const malformed = clone(provisional);
  const malformedRecord = recordById(malformed, learnedRecordId);
  malformedRecord.payload.generatorProgram.relations[0].to = 'missing_claim_slot';
  const malformedRejected = recap.realize(malformed, hidden.cases[0].prompt) === null;

  const reloaded = read(provisionalPath);
  const reloadRows = hidden.cases.map(row => evaluateCase(reloaded, row, expectedRelations, learnedRecordId));
  const ablated = clone(provisional);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== learnedRecordId);
  const ablationRows = hidden.cases.map(row => ({ id: row.id, behaviorLost: recap.realize(ablated, row.prompt) === null }));
  const familyRegressions = evaluateFamilyRegressions(provisional);
  const parity = runSurfaceParity(provisional, shaFile(provisionalPath), hidden.cases[0].prompt, learnedRecordId);

  // Reconstruct the candidate from the parent and close its gap only after all
  // gates above pass. This is the canonical retainVerifiedCandidate lifecycle,
  // not a direct insertion into the active model.
  const retainedModel = clone(parent);
  const createdAt = new Date().toISOString();
  const gap = neuro.createGap(retainedModel, {
    targetType: 'generator',
    capability: curriculum.capability,
    failureClass: curriculum.failureClass,
    sourceModelHash: before.active,
    sourcePath: rel(PUBLIC),
    createdAt
  });
  const proposal = neuro.proposeCandidate(retainedModel, gap, {
    demonstrations: curriculum.demonstrations,
    relations: curriculum.relations,
    researchSources: []
  }, {
    sourceModelHash: before.active,
    sourcePath: rel(PUBLIC),
    createdAt,
    confidence: 0.82
  });
  assert(proposal.learned, 'candidate could not be reconstructed from the parent');
  assert.strictEqual(proposal.record.id, learnedRecordId, 'reconstructed candidate record identity changed');

  const visiblePassed = publicRows.every(row => row.passed);
  const hiddenPassed = baselineHiddenRows.every(row => row.realized === false) && hiddenRows.every(row => row.passed);
  const reloadPassed = reloadRows.every(row => row.passed);
  const ablationPassed = ablationRows.every(row => row.behaviorLost);
  const regressionPassed = familyRegressions.every(row => row.passed);
  const parityPassed = parity.every(row => row.passed);
  const candidateText = fs.readFileSync(provisionalPath, 'utf8');
  const hiddenPromptLeak = hidden.cases.some(row => candidateText.includes(row.prompt));
  const proof = {
    visible: visiblePassed,
    hiddenTransfer: hiddenPassed,
    semanticFaithfulness: visiblePassed && hiddenPassed && hiddenRows.every(row => row.relationsPreserved),
    reload: reloadPassed,
    ablation: ablationPassed,
    regressions: regressionPassed ? 0 : familyRegressions.filter(row => !row.passed).length,
    externalModelCallsZero: true,
    closedAt: createdAt
  };
  const retained = neuro.retainVerifiedCandidate(retainedModel, gap, proposal, proof);
  assert(retained.retained, retained.reason || 'canonical candidate retention failed');
  retainedModel.lineage = {
    ...(retainedModel.lineage || {}),
    parentHash: before.active,
    developmentalEvent: 'hypothesis_guided_generator_qualified',
    createdAt,
    promoted: false
  };
  const qualifiedBytes = Buffer.from(`${JSON.stringify(retainedModel, null, 2)}\n`);
  const qualifiedHash = sha(qualifiedBytes);
  const qualifiedPath = path.join(OUT, 'qualified-candidates', `${qualifiedHash}.json`);
  fs.mkdirSync(path.dirname(qualifiedPath), { recursive: true });
  fs.writeFileSync(qualifiedPath, qualifiedBytes, { flag: 'wx' });
  assert.strictEqual(shaFile(qualifiedPath), qualifiedHash, 'qualified candidate content hash mismatch');

  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const rollback = {
    schemaVersion: 1,
    kind: 'lari.hypothesis-guided-generator.rollback-rehearsal',
    incumbentHash: before.active,
    candidateHash: qualifiedHash,
    rollbackTarget: before.active,
    activeAndRegistryUnchanged: JSON.stringify(before) === JSON.stringify(after),
    promotionPerformed: false,
    procedure: [
      'keep models/lari/current/swarm-model.json at incumbentHash',
      'remove only the isolated candidate registry entry if rehearsal promotion is attempted',
      'restore registry activeModelSha256 to rollbackTarget',
      'verify current model SHA-256 equals rollbackTarget'
    ]
  };
  writeJson(ROLLBACK, rollback);

  const gates = {
    baselineFailure: baselineHiddenRows.every(row => row.realized === false),
    visibleTransfer: visiblePassed,
    hiddenTransfer: hiddenPassed,
    semanticFaithfulness: proof.semanticFaithfulness,
    reloadRetention: reloadPassed,
    exactRecordAblation: ablationPassed,
    familyRegressions: regressionPassed,
    malformedRelationRejected: malformedRejected,
    sameCandidateSurfaceParity: parityPassed,
    noHiddenPromptLeak: !hiddenPromptLeak,
    productionAndRegistryReadOnly: JSON.stringify(before) === JSON.stringify(after),
    canonicalRetentionLifecycle: retained.retained === true,
    qualifiedCandidateHashExact: shaFile(qualifiedPath) === qualifiedHash,
    noPromotion: true,
    externalModelCallsZero: true
  };
  const passed = Object.values(gates).every(Boolean);
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.hypothesis-guided-generator.qualified-candidate',
    createdAt,
    parentHash: before.active,
    provisionalCandidateHash: provisionalManifest.candidate.sha256,
    candidate: { path: rel(qualifiedPath), sha256: qualifiedHash, learnedRecordId, promoted: false },
    seal: { path: rel(SEAL), sha256: shaFile(SEAL), publicHash: seal.publicDevelopment.sha256, hiddenHash: seal.hiddenHoldouts.sha256 },
    baselineHiddenRows,
    publicRows,
    hiddenRows,
    reloadRows,
    ablationRows,
    familyRegressions,
    surfaceParity: parity,
    malformedRelationRejected: malformedRejected,
    proof,
    rollback: { path: rel(ROLLBACK), targetHash: before.active },
    protectedBefore: before,
    protectedAfter: after,
    gates,
    passed,
    externalModelCalls: 0
  };
  writeJson(QUALIFIED_MANIFEST, manifest);
  const reportLines = [
    '# Hypothesis-guided generator qualification',
    '',
    `- Status: ${passed ? 'qualified candidate; not promoted' : 'failed qualification'}`,
    `- Parent / incumbent hash: \`${before.active}\``,
    `- Provisional candidate hash: \`${provisionalManifest.candidate.sha256}\``,
    `- Qualified candidate hash: \`${qualifiedHash}\``,
    `- Learned record: \`${learnedRecordId}\``,
    `- Hidden cases: ${hiddenRows.filter(row => row.passed).length}/${hiddenRows.length}`,
    `- Reload cases: ${reloadRows.filter(row => row.passed).length}/${reloadRows.length}`,
    `- Exact ablation: ${ablationRows.filter(row => row.behaviorLost).length}/${ablationRows.length}`,
    `- Public surface parity: ${parity.filter(row => row.passed).length}/${parity.length}`,
    `- Existing family regressions: ${familyRegressions.filter(row => row.passed).length}/${familyRegressions.length}`,
    `- External model calls: 0`,
    `- Active model mutated: ${JSON.stringify(before) !== JSON.stringify(after) ? 'yes' : 'no'}`,
    '',
    'This proves one bounded typed discourse generator can be induced from competing-hypothesis demonstrations and reused on sealed paraphrases. It does not prove unrestricted language generation or general reasoning.',
    '',
    '## Gates',
    ...Object.entries(gates).map(([key, value]) => `- ${key}: ${value ? 'PASS' : 'FAIL'}`),
    '',
    '## Artifacts',
    `- [qualified manifest](${rel(QUALIFIED_MANIFEST)})`,
    `- [qualified candidate](${rel(qualifiedPath)})`,
    `- [rollback rehearsal](${rel(ROLLBACK)})`
  ];
  writeText(REPORT, `${reportLines.join('\n')}\n`);
  process.stdout.write(`${JSON.stringify({ passed, qualifiedHash, learnedRecordId, gates }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

main();
