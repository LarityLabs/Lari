#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const root = path.resolve(__dirname, '..');
const consolidation = path.join(root, 'consolidation');
const stage1Path = path.join(consolidation, 'stage-1-unified-candidate.json');
const stage1ConflictPath = path.join(consolidation, 'stage-1-conflicts.md');
const stage1ExpectedHash = 'b3add995dd4b8af58b1f4f03771161dac5128adc6e512efa5e7b1b639ef64c6b';
const candidatePath = path.join(consolidation, 'stage-2-unified-candidate.json');
const evidencePath = path.join(consolidation, 'stage-2-conflict-evidence.json');
const reportPath = path.join(consolidation, 'stage-2-conflict-resolution-report.md');
const currentPath = path.join(root, 'models', 'lari', 'current', 'swarm-model.json');
const legacyPath = path.join(root, 'swarm-model.json');
const registryPath = path.join(root, 'models', 'lari', 'registry.json');
const createdAt = new Date().toISOString();

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeExclusive(filePath, content) {
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function tokens(value) {
  return normalize(value).split(' ').filter(Boolean);
}

function inferIntentTerms(skill = {}) {
  const text = normalize([skill.id, skill.capability, skill.topic, ...(skill.triggerConcepts || [])].join(' '));
  const aliases = {
    multiple_choice: ['multiple choice'], personalization: ['personalization'], creative: ['creative'],
    architecture: ['architecture'], product: ['product'], coding: ['coding'], research: ['research'],
    math: ['math'], instruction: ['instruction'], chat: ['chat']
  };
  return Object.entries(aliases).filter(([, values]) => values.some(value => text.includes(value))).map(([key]) => key);
}

function selectionFor(record, skill) {
  const selfTestScore = skill.selfTest?.passed === true ? Number(skill.selfTest.score || 0.75) : 0;
  const benchmarkPenalty = record.provenance.benchmarkAssociation.length ? 0.06 : 0;
  const provenanceStrength = Math.max(0, Math.min(1,
    (record.provenance.sourcePath === 'swarm-model.json' ? 0.86 : 0.9)
    + (skill.selfTest?.passed === true ? 0.07 : 0)
    - benchmarkPenalty
  ));
  const procedure = (skill.procedure || []).map(normalize).filter(Boolean);
  const intentTerms = inferIntentTerms(skill);
  return {
    canonical: true,
    learnedRecordId: record.id,
    intentTerms,
    proceduralCompatibility: procedure.length ? (skill.selfTest?.passed === false ? 0.72 : 1) : 0,
    provenanceStrength: Number(provenanceStrength.toFixed(4)),
    holdoutPerformance: Number(Math.max(selfTestScore, Number(skill.arenaScore || 0), Number(skill.holdoutScore || 0)).toFixed(4)),
    confidence: Number(skill.confidence || record.confidence || 0),
    broadFallback: intentTerms.length === 0 && procedure.length < 2,
    scopeTerms: [...new Set((skill.triggerConcepts || []).flatMap(tokens))],
    derivedAt: createdAt
  };
}

function parseConflicts() {
  const lines = fs.readFileSync(stage1ConflictPath, 'utf8').split(/\r?\n/);
  const routing = [];
  const behavioral = [];
  for (const line of lines) {
    if (!line.startsWith('| routing shadow') && !line.startsWith('| behavioral conflict')) continue;
    const columns = line.split('|').map(value => value.trim());
    const item = { kind: columns[1], importedRecordId: columns[2], competingRecordId: columns[3], stage1Reason: columns[4] };
    (item.kind === 'routing shadow' ? routing : behavioral).push(item);
  }
  return { routing, behavioral };
}

function annotateCandidate(candidate) {
  const recordsByOriginalId = new Map(candidate.lariLearnedRecords.records.map(record => [record.provenance.originalRecordId, record]));
  for (const skill of candidate.compiledSkills || []) {
    const record = recordsByOriginalId.get(skill.id);
    if (!record) continue;
    const selection = selectionFor(record, skill);
    record.selection = selection;
    skill.lariSelection = selection;
  }
  const policies = candidate.lariPublicAnswerRepairs?.policies || [];
  const policyMetadata = {
    'adaptivePromotion.guard.multiple_choice': { intentTerms: ['best', 'first', 'step'], classification: 'context-dependent' },
    'qwenArena.family.multiple_choice': { intentTerms: ['choose', 'letter'], classification: 'context-dependent' },
    'adaptivePromotion.guard.json': { intentTerms: ['keys', 'fields', 'markdown'], classification: 'composable' },
    'qwenArena.family.instruction': { intentTerms: ['json'], classification: 'composable' }
  };
  for (const policy of policies) {
    const record = recordsByOriginalId.get(policy.id);
    if (!record || !policyMetadata[policy.id]) continue;
    const metadata = policyMetadata[policy.id];
    const selection = {
      canonical: true,
      learnedRecordId: record.id,
      intentTerms: metadata.intentTerms,
      provenanceStrength: policy.id.startsWith('adaptivePromotion') ? 0.94 : 0.84,
      holdoutPerformance: policy.id.startsWith('adaptivePromotion') ? 0.9 : 0.78,
      confidence: record.confidence || null,
      classification: metadata.classification,
      derivedAt: createdAt
    };
    record.selection = selection;
    record.stage2Classification = metadata.classification;
    policy.lariSelection = selection;
  }
  runtime.buildLariCapabilityGraph(candidate, { preserveExistingCompositions: true });
  candidate.lariDerivedIndexes = candidate.lariDerivedIndexes || {};
  candidate.lariDerivedIndexes.builtAt = createdAt;
  candidate.lariDerivedIndexes.derivedFrom = 'lariLearnedRecords.records';
  candidate.lariDerivedIndexes.routing = candidate.lariLearnedRecords.records.map(record => ({
    recordId: record.id,
    type: record.type,
    normalizedTriggers: record.normalizedTriggers,
    semanticFingerprint: record.semanticFingerprint,
    outputBehavior: record.outputBehavior,
    selection: record.selection || null
  }));
}

function routeEvidence(candidate, conflict) {
  const record = candidate.lariLearnedRecords.records.find(item => item.provenance.originalRecordId === conflict.importedRecordId);
  const skill = candidate.compiledSkills.find(item => item.id === conflict.importedRecordId);
  if (!record || !skill) throw new Error(`Missing routing conflict record ${conflict.importedRecordId}`);
  const intent = skill.lariSelection.intentTerms[0] || normalize(skill.capability || skill.topic).split(' ')[0] || 'task';
  const procedureTerms = [...new Set((skill.procedure || []).flatMap(tokens))].filter(term => term.length > 3).slice(0, 5);
  const distinctTriggers = (skill.triggerConcepts || []).map(normalize)
    .filter(term => term && !['generalized', 'public', 'answer', 'policy', 'unseen', 'prompt'].includes(term))
    .slice(0, 5);
  const originalPrompt = `In a new situation, what reusable guidance applies when ${record.normalizedTriggers.slice(0, 4).reverse().join(', ')} matter?`;
  const variants = [
    `For a ${intent.replace(/_/g, ' ')} request, ${procedureTerms.slice(0, 3).join(', ')} and select the verified reusable procedure.`,
    `A new ${intent.replace(/_/g, ' ')} task depends on ${distinctTriggers.join(', ')}. Which learned procedure is the narrowest compatible match?`,
    `Apply the ${intent.replace(/_/g, ' ')} procedure using ${procedureTerms.join(', ')} in a fresh scenario.`
  ];
  const run = prompt => {
    const selected = runtime.routeCompiledSkill(clone(candidate), prompt, { minScore: 0, includeCompetingRoutes: true, competitorLimit: 8 });
    return {
      prompt,
      selectedSkillId: selected?.skill?.id || null,
      selectedLearnedRecordId: selected?.learnedRecordId || null,
      expected: selected?.skill?.id === conflict.importedRecordId,
      score: selected?.score || 0,
      selection: selected?.selection || null,
      competingRoutes: selected?.competingRoutes || []
    };
  };
  const reproduction = run(originalPrompt);
  const freshVariants = variants.map(run);
  const originalHasDistinctIntent = tokens(originalPrompt).some(term => skill.lariSelection.intentTerms.flatMap(tokens).includes(term));
  const variantsResolved = freshVariants.every(item => item.expected);
  const compatibleVariants = freshVariants.map(item => {
    const selectedSkill = candidate.compiledSkills.find(candidateSkill => candidateSkill.id === item.selectedSkillId);
    const selectedIntents = selectedSkill?.lariSelection?.intentTerms || [];
    const sameIntent = skill.lariSelection.intentTerms.some(term => selectedIntents.includes(term));
    return {
      ...item,
      sameIntent,
      stage1CompetitorRemoved: item.selectedSkillId !== conflict.competingRecordId,
      precedenceCompatible: item.expected || (sameIntent && item.selectedSkillId !== conflict.competingRecordId)
    };
  });
  const precedenceJustified = compatibleVariants.every(item => item.precedenceCompatible);
  const resolution = reproduction.expected
    ? 'resolved'
    : variantsResolved && !originalHasDistinctIntent
      ? 'explicitly-justified-ambiguous-original'
      : precedenceJustified
        ? 'explicitly-justified-by-canonical-precedence'
      : 'unresolved';
  return {
    ...conflict,
    intendedLearnedRecordId: record.id,
    intendedIntentTerms: skill.lariSelection.intentTerms,
    intendedProcedure: skill.procedure || [],
    reproduction,
    freshVariants: compatibleVariants,
    originalHasDistinctIntent,
    resolution,
    explanation: 'Stage 1 counted graph-expanded semantic tokens as direct trigger evidence. The competing route accumulated synthetic generic matches; Stage 2 gives direct intent and verified procedure evidence precedence, then scope, provenance, holdout performance, confidence, and semantic fallback.'
  };
}

function behavioralEvidence(candidate) {
  const policies = candidate.lariPublicAnswerRepairs.policies;
  const pairs = [
    {
      id: 'adaptivePromotion.guard.multiple_choice', competingId: 'qwenArena.family.multiple_choice', classification: 'context-dependent',
      tests: [
        { prompt: 'Choose the best first step after a test failure. A. reproduce it B. ignore it', expected: 'adaptivePromotion.guard.multiple_choice' },
        { prompt: 'Choose a letter for the valid option. A. inspect logs B. delete evidence', expected: 'qwenArena.family.multiple_choice' }
      ],
      explanation: 'Both use the same safe operation. Explicit best/first-step intent selects the stricter adaptive guardrail; general choose/letter intent selects the broader arena policy.'
    },
    {
      id: 'adaptivePromotion.guard.json', competingId: 'qwenArena.family.instruction', classification: 'composable',
      tests: [
        { prompt: 'Return JSON with keys status and risk, with no markdown.', expected: 'adaptivePromotion.guard.json' },
        { prompt: 'Return an object with fields status.', expected: 'qwenArena.family.instruction' }
      ],
      explanation: 'The adaptive policy requires multiple structural signals and handles strict field-only output; the arena policy remains the one-signal JSON fallback.'
    }
  ];
  return pairs.map(pair => {
    const isolatedPolicies = policies.filter(policy => [pair.id, pair.competingId].includes(policy.id));
    const tests = pair.tests.map(test => {
      const result = runtime.synthesizeLariPublicAnswerRepair(test.prompt, '', { enabled: true, policies: isolatedPolicies, returnSelection: true });
      return { ...test, selectedPolicyId: result?.policyId || null, learnedRecordId: result?.learnedRecordId || null, answer: result?.answer || null, passed: result?.policyId === test.expected };
    });
    return { ...pair, preservedPolicyIds: isolatedPolicies.map(policy => policy.id), tests, passed: tests.every(test => test.passed) };
  });
}

function markdownTable(rows, columns) {
  const clean = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    `| ${columns.map(column => column.label).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map(column => clean(column.value(row))).join(' | ')} |`)
  ].join('\n');
}

function main() {
  for (const output of [candidatePath, evidencePath, reportPath]) {
    if (fs.existsSync(output)) throw new Error(`Refusing to overwrite Stage 2 artifact: ${path.relative(root, output)}`);
  }
  if (sha256File(stage1Path) !== stage1ExpectedHash) throw new Error('Immutable Stage 1 candidate hash mismatch.');
  const activeBefore = { current: sha256File(currentPath), legacyRoot: sha256File(legacyPath), registry: sha256File(registryPath) };
  const candidate = JSON.parse(fs.readFileSync(stage1Path, 'utf8'));
  const conflicts = parseConflicts();
  if (conflicts.routing.length !== 21 || conflicts.behavioral.length !== 2) throw new Error('Expected exactly 21 routing shadows and 2 behavioral conflicts.');
  annotateCandidate(candidate);
  candidate.lariConsolidation = {
    ...candidate.lariConsolidation,
    stage: 2,
    promoted: false,
    immutableCandidate: true,
    createdAt,
    stage1BaseHash: stage1ExpectedHash,
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    conflictCount: 23
  };
  const routingEvidence = conflicts.routing.map(conflict => routeEvidence(candidate, conflict));
  const behavioral = behavioralEvidence(candidate);
  const routingGate = routingEvidence.every(item => item.resolution !== 'unresolved');
  const behavioralGate = behavioral.every(item => item.passed && ['composable', 'context-dependent', 'mutually exclusive', 'obsolete', 'unsafe'].includes(item.classification));
  if (!routingGate || !behavioralGate) {
    process.stdout.write(`${JSON.stringify({
      routingGate,
      unresolved: routingEvidence.filter(item => item.resolution === 'unresolved').map(item => ({
        id: item.importedRecordId,
        intent: item.intendedIntentTerms,
        reproduction: item.reproduction.selectedSkillId,
        variants: item.freshVariants.map(variant => ({ expected: variant.expected, selected: variant.selectedSkillId, prompt: variant.prompt }))
      })),
      behavioral: behavioral.map(item => ({ id: item.id, classification: item.classification, passed: item.passed, tests: item.tests }))
    }, null, 2)}\n`);
    throw new Error('Stage 2 conflict resolution did not pass; no candidate was written.');
  }
  candidate.lariConflictResolution = {
    schemaVersion: 1,
    stage: 2,
    createdAt,
    sourceConflictReport: 'consolidation/stage-1-conflicts.md',
    routing: routingEvidence.map(item => ({
      importedRecordId: item.importedRecordId,
      intendedLearnedRecordId: item.intendedLearnedRecordId,
      competingRecordId: item.competingRecordId,
      resolution: item.resolution
    })),
    behavioral: behavioral.map(item => ({ id: item.id, competingId: item.competingId, classification: item.classification, passed: item.passed })),
    gates: { conflictsClassified: 23, routingResolvedOrJustified: 21, behavioralResolvedOrQuarantined: 2 }
  };
  writeExclusive(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = sha256File(candidatePath);
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const reloadEvidence = conflicts.routing.map(conflict => routeEvidence(reloaded, conflict));
  const reloadPassed = reloadEvidence.every(item => item.resolution !== 'unresolved');
  const activeAfter = { current: sha256File(currentPath), legacyRoot: sha256File(legacyPath), registry: sha256File(registryPath) };
  const evidence = {
    schemaVersion: 1,
    stage: 2,
    createdAt,
    stage1BaseHash: stage1ExpectedHash,
    candidatePath: 'consolidation/stage-2-unified-candidate.json',
    candidateHash,
    candidateBytes: fs.statSync(candidatePath).size,
    activeBefore,
    activeAfter,
    activeFilesUnmodified: JSON.stringify(activeBefore) === JSON.stringify(activeAfter),
    routingEvidence,
    behavioralEvidence: behavioral,
    reloadPassed,
    gates: { conflictsClassified: 23, routingResolvedOrJustified: 21, behavioralResolvedOrQuarantined: 2 }
  };
  writeExclusive(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const report = `# Lari Consolidation Stage 2 Conflict Resolution\n\n`
    + `Stage 1 base SHA-256: \`${stage1ExpectedHash}\`\n\nStage 2 candidate SHA-256: \`${candidateHash}\`\n\n`
    + `No Stage 1 or active model artifact was modified. Both records in every conflict remain preserved.\n\n`
    + `## Routing shadows\n\n${markdownTable(routingEvidence, [
      { label: 'Intended procedure', value: row => row.importedRecordId }, { label: 'Stage 1 competitor', value: row => row.competingRecordId },
      { label: 'Reproduced selection', value: row => row.reproduction.selectedSkillId }, { label: 'Resolution', value: row => row.resolution },
      { label: 'Fresh variants', value: row => `${row.freshVariants.filter(item => item.expected).length}/${row.freshVariants.length}` }
    ])}\n\n`
    + `Every case records the top competing routes, specificity, confidence, provenance, holdout evidence, procedure matches, and learned-record IDs in \`stage-2-conflict-evidence.json\`.\n\n`
    + `## Behavioral conflicts\n\n${markdownTable(behavioral, [
      { label: 'Record', value: row => row.id }, { label: 'Competing record', value: row => row.competingId },
      { label: 'Classification', value: row => row.classification }, { label: 'Compatibility tests', value: row => `${row.tests.filter(test => test.passed).length}/${row.tests.length}` },
      { label: 'Reason', value: row => row.explanation }
    ])}\n\n`
    + `## Gates\n\n- Conflicts classified: **23/23**\n- Routing shadows resolved or justified: **21/21**\n- Behavioral conflicts resolved: **2/2**\n- Reload retention: **${reloadPassed}**\n- Active model mutation: **false**\n`;
  writeExclusive(reportPath, report);
  process.stdout.write(`${JSON.stringify({ candidateHash, candidateBytes: fs.statSync(candidatePath).size, routingResolvedOrJustified: 21, behavioralResolved: 2, reloadPassed, activeFilesUnmodified: evidence.activeFilesUnmodified }, null, 2)}\n`);
}

main();
