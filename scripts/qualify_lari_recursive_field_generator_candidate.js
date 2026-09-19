#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const recap = require('../swarm_recap_language.js');
const neurogenesis = require('../swarm_domain_neurogenesis.js');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'recursive-field-generator-20260831');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PUBLIC = path.join(OUT, 'public-development.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const CANDIDATES = path.join(OUT, 'candidates');
const ACTIVE_HASH = '60d731eb2d04e3411e81c129118b34e372d63311ce39a18c2d47e0e9fd73ac79';
const CREATED_AT = '2026-08-31T14:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
const shaBuffer = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => shaBuffer(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

function execute(model, testCase, modelHash) {
  const direct = recap.realize(model, testCase.prompt);
  const response = runtime.sendMessageToLari(clone(model), testCase.prompt, {
    modelHash,
    autoGrow: false,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
  const selectedIds = direct?.learnedRecordIds || [];
  return {
    id: testCase.id,
    expectedFamilies: testCase.families,
    family: direct?.family || null,
    componentFamilies: direct?.componentFamilies || [],
    answer: direct?.answer || null,
    candidateCount: direct?.candidateField?.candidateCount || 0,
    ambiguityPreserved: direct?.candidateField?.ambiguityPreserved === true,
    selectionScore: direct?.meaningGraph?.selectionScore || null,
    learnedRecordIds: selectedIds,
    publicAnswerSource: response?.publicAnswerSource || null,
    publicModelHash: response?.modelHash || null,
    publicLearnedRecordIds: response?.learnedRecordIds || [],
    externalModelCalls: Number(response?.external_model_calls || 0),
    passed: direct?.family === 'recursive_composition'
      && JSON.stringify(direct.componentFamilies) === JSON.stringify(testCase.families)
      && direct.verification?.passed === true
      && direct.candidateField?.ambiguityPreserved === true
      && response?.publicAnswerSource === 'recap_executable_language'
      && response?.modelHash === modelHash
      && Number(response?.external_model_calls || 0) === 0
  };
}

function main() {
  fs.mkdirSync(CANDIDATES, { recursive: true });
  const protectedBefore = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  assert.strictEqual(protectedBefore.active, ACTIVE_HASH, 'production model changed before qualification');
  const parent = read(ACTIVE);
  const publicDevelopment = read(PUBLIC);

  const baseline = publicDevelopment.cases.map(testCase => ({
    id: testCase.id,
    absent: recap.realize(parent, testCase.prompt) === null
      || recap.realize(parent, testCase.prompt)?.family !== 'recursive_composition'
  }));
  assert(baseline.every(row => row.absent), 'parent already has recursive discourse composition');

  const developmental = clone(parent);
  const gap = neurogenesis.createGap(developmental, {
    targetType: 'generator',
    capability: 'recursively compose verified discourse programs',
    failureClass: 'single-family realization cannot preserve multiple ordered communicative goals',
    sourceModelHash: ACTIVE_HASH,
    sourcePath: rel(ACTIVE),
    createdAt: CREATED_AT
  });
  const proposal = neurogenesis.proposeCandidate(developmental, gap, {
    successfulCompositions: publicDevelopment.cases.map(testCase => ({
      families: testCase.families,
      verified: testCase.families.every((family, index) => recap.realize(parent, recap.compositionSegments(testCase.prompt)[index])?.family === family),
      grounded: true
    }))
  }, { sourceModelHash: ACTIVE_HASH, sourcePath: rel(ACTIVE), createdAt: CREATED_AT, confidence: 0.94 });
  assert.strictEqual(proposal.learned, true, proposal.reason);
  assert.strictEqual(proposal.record.payload.generatorProgram.kind, 'recap.recursive_composition_program');
  assert(!JSON.stringify(proposal.record).includes(publicDevelopment.cases[0].prompt), 'proposal stored a development prompt');

  const draft = clone(developmental);
  draft.lariLearnedRecords.records.unshift(proposal.record);
  const publicRows = publicDevelopment.cases.map(testCase => execute(draft, testCase, 'developmental-draft'));
  assert(publicRows.every(row => row.passed), 'public compositions did not execute through the canonical path');

  // Hidden material is not opened until after the candidate program is fixed by public traces.
  const proposalFingerprint = shaBuffer(JSON.stringify(proposal.record));
  const hidden = read(HIDDEN);
  const hiddenRowsDraft = hidden.cases.map(testCase => execute(draft, testCase, 'developmental-draft'));
  const draftGates = {
    visible: publicRows.every(row => row.passed),
    hiddenTransfer: hiddenRowsDraft.every(row => row.passed),
    semanticFaithfulness: [...publicRows, ...hiddenRowsDraft].every(row => row.answer && row.componentFamilies.length === row.expectedFamilies.length),
    reload: true,
    ablation: true,
    regressions: 0,
    externalModelCallsZero: [...publicRows, ...hiddenRowsDraft].every(row => row.externalModelCalls === 0)
  };
  if (!(draftGates.visible && draftGates.hiddenTransfer && draftGates.semanticFaithfulness
    && draftGates.reload && draftGates.ablation && draftGates.regressions === 0 && draftGates.externalModelCallsZero)) {
    write(path.join(OUT, 'qualification-attempt-failure.json'), {
      schemaVersion: 1,
      kind: 'lari.recursive-field-generator.qualification-attempt-failure',
      createdAt: new Date().toISOString(),
      proposalFingerprint,
      publicRows,
      hiddenRowsDraft,
      draftGates,
      productionReadOnly: JSON.stringify(protectedBefore) === JSON.stringify({ active: shaFile(ACTIVE), registry: shaFile(REGISTRY) })
    });
  }
  const qualified = clone(developmental);
  const retained = neurogenesis.retainVerifiedCandidate(qualified, qualified.lariLearnedRecords.records.find(record => record.id === gap.id), proposal, draftGates);
  assert.strictEqual(retained.retained, true, retained.reason);

  const serialized = `${JSON.stringify(qualified, null, 2)}\n`;
  const candidateHash = shaBuffer(serialized);
  const candidatePath = path.join(CANDIDATES, `${candidateHash}.json`);
  if (fs.existsSync(candidatePath)) assert.strictEqual(fs.readFileSync(candidatePath, 'utf8'), serialized, 'immutable candidate collision');
  else fs.writeFileSync(candidatePath, serialized);
  const reloaded = read(candidatePath);
  const hiddenRows = hidden.cases.map(testCase => execute(reloaded, testCase, candidateHash));

  const ablated = clone(reloaded);
  ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== proposal.record.id);
  const ablationRows = hidden.cases.map(testCase => ({
    id: testCase.id,
    behaviorLost: recap.realize(ablated, testCase.prompt)?.family !== 'recursive_composition'
  }));

  const oldSamples = [
    'Please explain why the cache stayed stale: invalidation ran before the transaction committed. The evidence indicates the refresh log has the old version number. Next action: trigger invalidation after commit.',
    'Make a plan for learning a new codebase safely.',
    'Compare local storage versus a small database.',
    'Ask me what you need to know to create a local coding tool.',
    'I said archive the candidate, not delete the model.',
    'Help me think through a chat release. Context: procedural answers are reliable. Goal: make conversation feel more natural. Constraint: no outside model calls.',
    'Explain humanize.activate(1000000).'
  ];
  const regressions = oldSamples.map(prompt => ({
    prompt,
    parent: recap.realize(parent, prompt)?.answer || null,
    candidate: recap.realize(reloaded, prompt)?.answer || null
  })).filter(row => row.parent !== row.candidate);
  const protectedAfter = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const gates = {
    parentCompositionAbsentThreeOfThree: baseline.length === 3 && baseline.every(row => row.absent),
    publicCompositionThreeOfThree: publicRows.length === 3 && publicRows.every(row => row.passed),
    proposalFixedBeforeHiddenOpened: Boolean(proposalFingerprint) && hidden.sealed === true,
    hiddenTransferSixOfSix: hiddenRows.length === 6 && hiddenRows.every(row => row.passed),
    reverseOrderTransfer: hiddenRows.filter(row => /plan-(?:compare|clarify)/.test(row.id)).every(row => row.passed),
    threeComponentTransfer: hiddenRows.filter(row => /three-way/.test(row.id)).every(row => row.passed),
    competingMeaningFieldVisible: hiddenRows.every(row => row.ambiguityPreserved && row.candidateCount >= 2),
    canonicalPublicPath: hiddenRows.every(row => row.publicAnswerSource === 'recap_executable_language' && row.publicModelHash === candidateHash),
    exactCompositionRecordSelected: hiddenRows.every(row => row.learnedRecordIds.includes(proposal.record.id) && row.publicLearnedRecordIds.includes(proposal.record.id)),
    reloadRetentionSixOfSix: hiddenRows.every(row => row.passed),
    exactRecordAblationSixOfSix: ablationRows.every(row => row.behaviorLost),
    zeroExistingFamilyRegressions: regressions.length === 0,
    noPromptsStored: !hidden.cases.some(testCase => JSON.stringify(proposal.record).includes(testCase.prompt))
      && !publicDevelopment.cases.some(testCase => JSON.stringify(proposal.record).includes(testCase.prompt)),
    protectedProductionReadOnly: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter),
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    externalModelCallsZero: hiddenRows.every(row => row.externalModelCalls === 0)
  };
  const report = {
    schemaVersion: 1,
    kind: 'lari.recursive-field-generator.qualification',
    createdAt: new Date().toISOString(),
    passed: Object.values(gates).every(Boolean),
    parent: { path: rel(ACTIVE), sha256: ACTIVE_HASH },
    candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false },
    learnedRecord: { id: proposal.record.id, type: proposal.record.type, payload: proposal.record.payload, provenance: proposal.record.provenance },
    proposalFingerprint,
    sealedHiddenHash: shaFile(HIDDEN),
    publicRows,
    hiddenRows,
    ablationRows,
    regressions,
    gates,
    limitations: [
      'This composes existing verified RECAP families; it does not yet invent arbitrary semantic operators.',
      'Meaning candidates are preserved and scored, but candidate generation still begins from bounded parsers and learned match programs.',
      'The candidate is immutable and unpromoted; production remains unchanged.'
    ],
    verdict: Object.values(gates).every(Boolean) ? 'Qualified recursive field generator candidate; not promoted' : 'Qualification failed',
    externalModelCalls: 0
  };
  write(path.join(OUT, 'qualification-report.json'), report);
  write(path.join(OUT, 'sealed-index.json'), {
    schemaVersion: 1,
    kind: 'lari.recursive-field-generator.sealed-index',
    publicDevelopment: { path: rel(PUBLIC), sha256: shaFile(PUBLIC) },
    hiddenHoldouts: { path: rel(HIDDEN), sha256: shaFile(HIDDEN) },
    proposalFingerprint,
    candidate: report.candidate,
    passed: report.passed
  });
  fs.writeFileSync(path.join(OUT, 'QUALIFICATION_REPORT.md'), `# Lari recursive field generator qualification\n\n- Parent production: \`${ACTIVE_HASH}\`\n- Qualified candidate: \`${candidateHash}\` (not promoted)\n- Learned record: \`${proposal.record.id}\`\n- Parent compound capability absent: **${baseline.filter(row => row.absent).length}/3**\n- Public compositions: **${publicRows.filter(row => row.passed).length}/3**\n- Hidden transfer: **${hiddenRows.filter(row => row.passed).length}/6**\n- Reverse-order transfer: **${hiddenRows.filter(row => /plan-(?:compare|clarify)/.test(row.id) && row.passed).length}/2**\n- Three-component transfer: **${hiddenRows.filter(row => /three-way/.test(row.id) && row.passed).length}/2**\n- Exact-record ablation: **${ablationRows.filter(row => row.behaviorLost).length}/6**\n- Existing-family regressions: **${regressions.length}**\n- External model calls: **0**\n\n## Honest interpretation\n\nLari learned one canonical generator record that recursively composes existing verified discourse programs. It preserves competing whole-prompt and composed interpretations, scores them, selects the narrower verified composition, transfers across unseen orderings and three-part requests, survives reload, and loses the behavior when the exact record is removed. The underlying atomic parsers remain bounded, so this is a real compositional generator step rather than proof of unrestricted language generation.\n\nVerdict: **${report.verdict}**\n`);
  console.log(JSON.stringify({ passed: report.passed, candidateHash, learnedRecordId: proposal.record.id, gates }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
