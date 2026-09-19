#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const ATTEMPT = process.argv.includes('--attempt9')
  ? 'beta-quality-candidate-v9-20260909'
  : process.argv.includes('--attempt8')
  ? 'beta-quality-candidate-v8-20260908'
  : process.argv.includes('--attempt7')
  ? 'beta-quality-candidate-v7-20260908'
  : process.argv.includes('--attempt6')
  ? 'beta-quality-candidate-v6-20260908'
  : process.argv.includes('--attempt5')
  ? 'beta-quality-candidate-v5-20260908'
  : process.argv.includes('--attempt4')
  ? 'beta-quality-candidate-v4-20260908'
  : process.argv.includes('--attempt3')
  ? 'beta-quality-candidate-v3-20260908'
  : process.argv.includes('--attempt2') ? 'beta-quality-candidate-v2-20260908' : 'beta-quality-candidate-20260908';
const OUT = path.join(ROOT, 'consolidation', ATTEMPT);
const SEAL = path.join(OUT, 'sealed-curriculum.json');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const CANDIDATES = path.join(OUT, 'candidates');
const REPORT = path.join(OUT, 'candidate-validation.json');
const MANIFEST = path.join(OUT, 'candidate-manifest.json');
const SOAK_REPORT = path.join(OUT, 'candidate-product-soak.json');
const SOAK_SUMMARY = path.join(OUT, 'candidate-product-soak.md');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shaText = text => crypto.createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const tokens = text => String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const CLAIM_STOP = new Set(['about', 'after', 'and', 'before', 'being', 'can', 'each', 'for', 'from', 'into', 'only', 'rather', 'should', 'that', 'the', 'their', 'then', 'this', 'through', 'when', 'while', 'with']);

function semanticClaimSections(family) {
  return family.sections.map(([label, body], index) => {
    const bodyTokens = [...new Set(tokens(`${label} ${body}`).filter(token => token.length > 3 && !CLAIM_STOP.has(token)))];
    const features = (family.semanticSelection?.features || []).filter(feature => {
      const featureTokens = String(feature).split('_').filter(token => token.length > 3);
      return featureTokens.some(token => bodyTokens.some(bodyToken => bodyToken === token || bodyToken.startsWith(token) || token.startsWith(bodyToken)));
    });
    return {
      id: `${family.id}.claim.${index + 1}`,
      label,
      body,
      selection: {
        features,
        triggers: bodyTokens,
        priority: Math.max(0, family.sections.length - index)
      }
    };
  });
}

function recordFor(family, parentHash, sealHash, timestamp) {
  const identity = shaText(JSON.stringify({ triggers: family.triggers.slice().sort(), sections: family.sections })).slice(0, 16);
  return {
    schemaVersion: 1,
    id: `lari.learned.procedure.beta_quality.${family.id}`,
    type: 'procedure',
    status: 'active',
    normalizedTriggers: [...new Set(family.triggers.flatMap(tokens))].sort(),
    procedureIdentity: `chat-response-plan:${identity}`,
    semanticFingerprint: `beta-quality:${identity}`,
    outputBehavior: `composed-general-chat:capability-guidance:${family.id}`,
    contentHash: `sha256:${identity}`,
    behavioralSignature: `beta-quality-guidance:${family.id}:${identity}`,
    confidence: 0.91,
    provenance: {
      sourceModelHash: parentHash,
      sourcePath: rel(SEAL),
      sourceArtifactHash: sealHash,
      originalRecordId: null,
      sourceKind: 'sealed_failure_driven_curriculum',
      creationSource: 'beta_quality_semantic_transfer_training',
      benchmarkAssociation: [],
      confidence: 0.91,
      imported: false,
      classification: 'developmental_candidate',
      importTimestamp: timestamp,
      storesRawSessionLog: false,
      storesPromptText: false,
      storesBenchmarkAnswer: false
    },
    payload: {
      domain: 'general_chat',
      operation: 'compose_chat_response',
      intents: ['open_chat', 'planning', 'explanation', 'troubleshooting', 'comparison', 'preference', 'feedback', 'chat'],
      minTriggerMatches: family.minTriggerMatches,
      semanticTriggerGroups: family.semanticTriggerGroups || [],
      semanticSelection: family.semanticSelection || null,
      responsePlan: {
        kind: 'capability_guidance',
        maxClaims: family.semanticClaimComposition ? 3 : null,
        composition: family.semanticClaimComposition ? 'semantic_claim_selection' : null,
        sections: family.semanticClaimComposition
          ? semanticClaimSections(family)
          : family.sections.map(([label, body]) => ({ label, body }))
      },
      verification: 'sealed_semantic_transfer_exact_ablation_reload_and_product_soak',
      verifiedUses: 0
    }
  };
}

function ask(model, prompt, modelHash, scope) {
  return runtime.sendMessageToLari(model, prompt, {
    modelHash,
    autoGrow: false,
    userScope: scope,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
}

function assess(response, family, recordId) {
  const answer = String(response?.answer || '');
  const lower = answer.toLowerCase();
  return {
    selected: (response?.learnedRecordIds || []).includes(recordId),
    markers: family.required.filter(marker => lower.includes(String(marker).toLowerCase())),
    missing: family.required.filter(marker => !lower.includes(String(marker).toLowerCase())),
    answer,
    externalModelCalls: Number(response?.external_model_calls || 0)
  };
}

function main() {
  if (!fs.existsSync(SEAL)) throw new Error('Seal the beta-quality curriculum first.');
  if (fs.existsSync(REPORT) || fs.existsSync(MANIFEST)) throw new Error('Beta-quality candidate artifacts already exist.');
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const sealHash = shaFile(SEAL);
  const curriculum = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  if (curriculum.parentHash !== before.active || curriculum.families.length !== 9) throw new Error('Sealed curriculum does not match the active parent or expected family count.');
  const parent = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
  const timestamp = new Date().toISOString();
  const records = curriculum.families.map(family => recordFor(family, before.active, sealHash, timestamp));
  const existingIds = new Set(parent.lariLearnedRecords?.records?.map(record => record.id) || []);
  if (records.some(record => existingIds.has(record.id))) throw new Error('A beta-quality record already exists in the active parent.');

  const baseline = curriculum.families.map(family => {
    const id = `lari.learned.procedure.beta_quality.${family.id}`;
    return family.hidden.map((prompt, index) => ({ family: family.id, index, ...assess(ask(clone(parent), prompt, before.active, `beta-baseline-${family.id}-${index}`), family, id) }));
  }).flat();

  const candidate = clone(parent);
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  candidate.lariLearnedRecords.records = [...records, ...candidate.lariLearnedRecords.records];
  const previousLineage = clone(candidate.lineage || {});
  candidate.lineage = {
    ...previousLineage,
    timestamp,
    type: 'beta_quality_candidate',
    parentHash: before.active,
    sealedCurriculumHash: sealHash,
    learnedRecordIds: records.map(record => record.id),
    promoted: false,
    externalModelCalls: 0,
    previous: previousLineage
  };
  fs.mkdirSync(CANDIDATES, { recursive: true });
  const candidateBytes = `${JSON.stringify(candidate, null, 2)}\n`;
  const candidateHash = shaText(candidateBytes);
  const candidatePath = path.join(CANDIDATES, `${candidateHash}.json`);
  fs.writeFileSync(candidatePath, candidateBytes, { flag: 'wx' });

  const hidden = curriculum.families.map(family => {
    const id = `lari.learned.procedure.beta_quality.${family.id}`;
    return family.hidden.map((prompt, index) => ({ family: family.id, index, ...assess(ask(clone(candidate), prompt, candidateHash, `beta-hidden-${family.id}-${index}`), family, id) }));
  }).flat();
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const reload = curriculum.families.map(family => {
    const id = `lari.learned.procedure.beta_quality.${family.id}`;
    return family.hidden.map((prompt, index) => ({ family: family.id, index, ...assess(ask(clone(reloaded), prompt, candidateHash, `beta-reload-${family.id}-${index}`), family, id) }));
  }).flat();
  const ablation = curriculum.families.map(family => {
    const id = `lari.learned.procedure.beta_quality.${family.id}`;
    const ablated = clone(candidate);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== id);
    const result = assess(ask(ablated, family.hidden[0], candidateHash, `beta-ablation-${family.id}`), family, id);
    return { family: family.id, recordId: id, recordAbsent: !result.selected, behaviorLost: result.missing.length > 0, remainingMarkers: result.markers, answer: result.answer };
  });

  const regressions = [
    ['causal_uncertainty', 'Our service crashed once. Is that enough evidence to conclude the database caused it?', 'lari.learned.procedure.chat.technical.evidence_uncertainty'],
    ['support', 'Today was brutal, though I finally got the tests passing.', 'lari.learned.procedure.chat.5ac8499a'],
    ['decision', 'Help me decide whether to rebuild the service or improve it incrementally.', 'lari.learned.procedure.chat.cd0cdb09'],
    ['review', 'Review this code change with severity and actionable fixes.', 'lari.learned.procedure.chat.technical.severity_code_review'],
    ['learning_plan', 'From this conversation separate what Lari should research, practice, and retain.', 'lari.learned.procedure.chat.technical.conversation_learning_plan']
  ].map(([id, prompt, recordId]) => {
    const response = ask(clone(candidate), prompt, candidateHash, `beta-regression-${id}`);
    return { id, recordId, selected: (response.learnedRecordIds || []).includes(recordId), answer: response.answer };
  });

  const soakRun = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'benchmarks', 'run_lari_product_soak_eval.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LARI_MODEL_PATH: rel(candidatePath), LARI_PRODUCT_SOAK_REPORT_PATH: rel(SOAK_REPORT), LARI_PRODUCT_SOAK_SUMMARY_PATH: rel(SOAK_SUMMARY) },
    timeout: 120000
  });
  if (!fs.existsSync(SOAK_REPORT)) throw new Error(`Candidate soak did not produce a report: ${soakRun.stderr || soakRun.stdout}`);
  const soak = JSON.parse(fs.readFileSync(SOAK_REPORT, 'utf8'));
  const serializedRecords = JSON.stringify(records);
  const activeSoak = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmarks', 'latest-lari-product-soak-report.json'), 'utf8'));
  const promptLeak = [...curriculum.families.flatMap(family => [family.train, ...family.hidden]), ...activeSoak.results.map(item => item.prompt)]
    .some(prompt => serializedRecords.includes(prompt));
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const gates = {
    parentBaselineDoesNotSelectNewRecords: baseline.every(row => !row.selected),
    hiddenTransferEighteenOfEighteen: hidden.length === 18 && hidden.every(row => row.selected && row.missing.length === 0 && row.externalModelCalls === 0),
    reloadRetentionEighteenOfEighteen: reload.length === 18 && reload.every(row => row.selected && row.missing.length === 0 && row.externalModelCalls === 0),
    exactAblationNineOfNine: ablation.length === 9 && ablation.every(row => row.recordAbsent && row.behaviorLost),
    priorChatRegressionsZero: regressions.every(row => row.selected),
    productSoakPassesWithoutAnswerBank: soak.passed === true && soak.summary.passedCount >= 43 && soak.summary.weakFamilies.length === 0,
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    noTrainingHiddenOrSoakPromptStored: !promptLeak,
    canonicalTypedRecordsOnly: records.every(record => record.type === 'procedure' && record.payload.operation === 'compose_chat_response'),
    productionReadOnly: before.active === after.active && before.registry === after.registry,
    noPromotion: true,
    externalModelCallsZero: hidden.every(row => row.externalModelCalls === 0) && reload.every(row => row.externalModelCalls === 0) && Number(soak.externalModelCalls || 0) === 0
  };
  const report = {
    schemaVersion: 1,
    kind: 'lari.beta-quality.candidate-validation',
    createdAt: timestamp,
    parentHash: before.active,
    sealedCurriculum: { path: rel(SEAL), sha256: sealHash },
    candidate: { path: rel(candidatePath), sha256: candidateHash, learnedRecordIds: records.map(record => record.id), promoted: false },
    baseline,
    hidden,
    reload,
    ablation,
    regressions,
    productSoak: { path: rel(SOAK_REPORT), passed: soak.passed, summary: soak.summary },
    protectedBefore: before,
    protectedAfter: after,
    gates,
    passed: Object.values(gates).every(Boolean),
    externalModelCalls: 0
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(MANIFEST, `${JSON.stringify({ schemaVersion: 1, kind: 'lari.beta-quality.candidate', createdAt: timestamp, parentHash: before.active, candidate: report.candidate, sealedCurriculum: report.sealedCurriculum, validationReport: rel(REPORT), promoted: false, gates }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, candidate: report.candidate, baselineSelected: baseline.filter(row => row.selected).length, hidden: `${hidden.filter(row => row.selected && !row.missing.length).length}/${hidden.length}`, reload: `${reload.filter(row => row.selected && !row.missing.length).length}/${reload.length}`, ablation: `${ablation.filter(row => row.recordAbsent && row.behaviorLost).length}/${ablation.length}`, regressions: regressions.filter(row => !row.selected).map(row => row.id), soak: `${soak.summary.passedCount}/${soak.summary.taskCount}`, gates }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
