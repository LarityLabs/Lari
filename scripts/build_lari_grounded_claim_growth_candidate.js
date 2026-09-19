#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const BASE = path.join(ROOT, 'consolidation', 'beta-quality-candidate-v9-20260909', 'candidates', '483c7595293fb367d22fe4e676bace57b876ab8d708e523386abf7dabb15699d.json');
const ATTEMPT = process.argv.includes('--attempt2') ? '-attempt2' : '';
const OUT = path.join(ROOT, 'consolidation', `beta-quality-candidate-v10-20260909${ATTEMPT}`);
const REPORT = path.join(OUT, 'candidate-validation.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shaText = text => crypto.createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

const lessons = [
  ['conversation', 'Explain how normal assistant conversation should combine a direct answer with honest capability boundaries.', 'Can an assistant talk naturally while remaining candid about what it cannot yet do?', ['direct', 'honest'],
    'A useful assistant answers the immediate question directly before offering optional next steps. Honest conversation states relevant capability boundaries instead of bluffing, but still provides the nearest useful action.',
    'Natural conversation follows the user’s goal and tone without exposing internal machinery by default. A capability claim is warranted only when the behavior and its evidence are actually available.'],
  ['research', 'Explain how source-backed research becomes reusable knowledge after uncertainty.', 'How should uncertain information become trustworthy knowledge for a later session?', ['source', 'verify'],
    'When information is uncertain, research begins with a clear question and retrieves relevant sources. Claims are compared across sources, weak or conflicting evidence is rejected, and accepted claims retain citations and confidence.',
    'Reusable research memory stores supported claims rather than raw browsing logs. A later answer reuses the retained evidence after reload and verifies time-sensitive claims again when freshness matters.'],
  ['project', 'Explain how a new software project should be planned, built, and verified inside a workspace.', 'What is the practical path from an application idea to verified files in a workspace?', ['plan', 'workspace'],
    'Project creation starts by clarifying the user, required outcome, constraints, and observable acceptance test. The implementation plan maps those requirements to files and the smallest working vertical slice inside the approved workspace.',
    'A coding agent builds the project, runs its tests and build, inspects failures, repairs the cause, and reports the changed files. Work is complete only when executable verification passes in the workspace.'],
  ['interface', 'Explain how a product interface should hide optional internals while keeping proof inspectable.', 'What should a simple interface show first, and where should verification details live?', ['answer', 'details'],
    'The default interface shows the answer, artifact, or next action first and keeps noisy internal work collapsed. Progress is concise while a task runs, and detailed traces remain available on demand.',
    'Proof must not be hidden: users can inspect sources, tests, model identity, retained records, and rollback history when needed. Simplicity means progressive disclosure, not removal of evidence.'],
  ['memory', 'Explain how private user preferences and corrections remain inspectable, reversible, and durable after reload.', 'How should an assistant remember a correction without taking control away from the user?', ['preference', 'reload'],
    'An explicit user preference or correction is stored in the user’s private local scope and affects later relevant answers. The correction must survive reload only after it is represented as durable model memory.',
    'Users can inspect, edit, forget, or roll back personal memory. Sensitive details are not inferred as facts without consent, and professional context remains separated by user scope.'],
  ['media', 'Explain how image, audio, game, and video generation should report quality boundaries.', 'How should one model handle visual, sound, game, and motion requests honestly?', ['quality', 'video'],
    'One model can coordinate image, audio, and browser-game generators as modality capabilities, then evaluate each artifact against the request. Task completion requires modality-specific quality checks plus end-to-end verification.',
    'Open-ended high-quality video synthesis remains unproven until a local generator and quality gate pass representative tasks. An unavailable modality is reported as a capability gap rather than silently delegated to an outside model.'],
  ['agentic', 'Explain how tools and workers safely act inside a workspace with permission and visible progress.', 'How can tools and workers perform computer tasks as one safe model?', ['permission', 'verify'],
    'Tools and workers operate as capabilities selected by one shared model state, not as competing brains. The model keeps one answer, one model hash, and one execution trace across public surfaces.',
    'Consequential actions require appropriate user authority, remain inside the approved workspace, and protect credentials from output or commits. Progress is visible, effects are verified, and failure is reported instead of claimed as success.'],
  ['release', 'Explain how release promotion should reject regressions and require measured evidence, user soak, and rollback.', 'What evidence decides whether a stronger candidate is actually safe to release?', ['regression', 'rollback'],
    'A candidate is rejected when it causes a family regression even if another score improves. Promotion requires measured hidden transfer, representative product soak, unresolved bug review, reload retention, and exact model-hash parity.',
    'Release evidence includes successful real-user tasks rather than HTTP availability alone. Atomic promotion preserves the incumbent, and rollback must restore the prior active hash exactly.'],
  ['reasoning', 'Explain how structured reasoning should calculate counts, summarize files, and prioritize blockers.', 'How should a model combine numeric facts and choose the most important blockers?', ['count', 'blocker'],
    'Structured reasoning extracts each stated quantity, applies the requested arithmetic once, and labels the result with its unit. A file summary preserves separate counts for changed, added, removed, and report files before computing a total.',
    'Prioritization selects the smallest number of blockers with the greatest effect on the goal. The answer states the chosen blockers, why they dominate, and which observation would change the ordering.'],
  ['growth', 'Explain how failures drive capability growth through training, unseen holdouts, reload, and user evidence.', 'How can a failed chat, coding, or research task become a durable new capability?', ['failure', 'holdout'],
    'Capability growth begins with a user-visible failure and a diagnostic hypothesis about the missing knowledge, procedure, operator, or generator. Research can propose evidence, while executable tasks require practice and verification.',
    'The model retains a typed record only after fresh semantic or repository holdouts pass. Exact ablation must remove the behavior, reload must retain it, family regressions must remain zero, and representative users must confirm usefulness before promotion.'],
  ['safety', 'Explain how safe model behavior protects secrets, files, evidence, and learning quality.', 'What prevents unsafe file changes, secret exposure, and bad lessons from entering production?', ['secret', 'reject'],
    'Secrets, credentials, passwords, and tokens must not be revealed, logged into public output, or committed to a repository. File changes stay within the user-approved workspace and are followed by verification.',
    'Unsupported capability claims are rejected unless scores and evidence justify them. A learned candidate that damages an existing family is quarantined or rolled back rather than promoted.']
].map(([id, train, hidden, required, first, second]) => ({
  id, train, hidden, required,
  sources: [
    { title: `Lari ${id} design rule`, url: `repo://LARI_PAPER.md#${id}`, sourceType: 'internal_architecture_spec', trust: 0.95, text: first },
    { title: `Lari ${id} operational rule`, url: `repo://LARI_FULL_REPORT.md#${id}`, sourceType: 'internal_verified_report', trust: 0.92, text: second }
  ]
}));

function ask(model, prompt, hash, scope) {
  return runtime.sendMessageToLari(model, prompt, { modelHash: hash, autoGrow: false, userScope: scope,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } });
}

function main() {
  if (fs.existsSync(REPORT)) throw new Error('Immutable v10 report already exists.');
  if (shaFile(BASE) !== '483c7595293fb367d22fe4e676bace57b876ab8d708e523386abf7dabb15699d') throw new Error('Stage v9 base hash mismatch.');
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const candidate = clone(base);
  const learnedRecords = [];
  const acquisition = [];
  for (const lesson of lessons) {
    const working = clone(candidate);
    const run = runtime.runAutonomousKnowledgeAcquisition(working, lesson.train, {
      force: true,
      sources: lesson.sources,
      sourceAdapter: `internal_architecture_curriculum.${lesson.id}`,
      sourceScoring: { minSourceScore: 0.18 }
    });
    const recordId = run.learned?.sourceLearnedRecordId || run.learned?.lariTypedRecordId;
    const record = (working.lariLearnedRecords?.records || []).find(item => item.id === recordId);
    if (!record?.payload?.responsePlan) throw new Error(`${lesson.id} did not synthesize a claim program.`);
    candidate.lariLearnedRecords.records = [clone(record), ...candidate.lariLearnedRecords.records.filter(item => item.id !== record.id)];
    learnedRecords.push(record);
    acquisition.push({ id: lesson.id, action: run.action, recordId, claimCount: record.payload.responsePlan.sections.length, sourceCount: run.distilled?.sourceCount || 0 });
  }
  runtime.refreshLariKnowledgeProjections(candidate);
  candidate.lineage = { ...(candidate.lineage || {}), type: 'grounded_claim_growth_candidate', parentHash: shaFile(BASE), learnedRecordIds: learnedRecords.map(record => record.id), promoted: false, createdAt: new Date().toISOString() };
  const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
  const candidateHash = shaText(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const reload = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const hidden = lessons.map((lesson, index) => {
    const recordId = learnedRecords[index].id;
    const response = ask(clone(reload), lesson.hidden, candidateHash, `v10-hidden-${lesson.id}`);
    const lower = String(response.answer || '').toLowerCase();
    return { id: lesson.id, recordId, executed: response.executedLearnedRecordIds?.includes(recordId) === true, source: response.publicAnswerSource,
      requiredPresent: lesson.required.every(term => lower.includes(term)), grounded: response.semanticClaimVerification?.citationCoverage === true, answer: response.answer };
  });
  const ablation = lessons.map((lesson, index) => {
    const recordId = learnedRecords[index].id;
    const ablated = clone(reload);
    ablated.lariLearnedRecords.records = ablated.lariLearnedRecords.records.filter(record => record.id !== recordId);
    runtime.refreshLariKnowledgeProjections(ablated);
    const response = ask(ablated, lesson.hidden, candidateHash, `v10-ablation-${lesson.id}`);
    return { id: lesson.id, recordId, executionLost: !response.executedLearnedRecordIds?.includes(recordId) && !(response.semanticClaimTrace || []).some(claim => claim.sourceRecordId === recordId) };
  });
  const soakPath = path.join(OUT, 'product-soak.json');
  const soakSummary = path.join(OUT, 'product-soak.md');
  childProcess.spawnSync(process.execPath, [path.join(ROOT, 'benchmarks', 'run_lari_product_soak_eval.js')], { cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, LARI_MODEL_PATH: rel(candidatePath), LARI_PRODUCT_SOAK_REPORT_PATH: rel(soakPath), LARI_PRODUCT_SOAK_SUMMARY_PATH: rel(soakSummary) } });
  const soak = JSON.parse(fs.readFileSync(soakPath, 'utf8'));
  const serialized = JSON.stringify(learnedRecords);
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const gates = {
    synthesizedElevenOfEleven: learnedRecords.length === 11 && learnedRecords.every(record => record.payload?.responsePlan?.composition === 'grounded_research_claims'),
    hiddenTransferElevenOfEleven: hidden.every(row => row.executed && row.source === 'learned_chat_procedure' && row.requiredPresent && row.grounded),
    reloadRetentionElevenOfEleven: hidden.every(row => row.executed),
    exactAblationElevenOfEleven: ablation.every(row => row.executionLost),
    noTrainingOrHiddenPromptStored: lessons.every(lesson => !serialized.includes(lesson.train) && !serialized.includes(lesson.hidden)),
    broadProductQuality: soak.passed === true && soak.summary.passedCount >= 43 && soak.summary.weakFamilies.length === 0,
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    activeReadOnly: before.active === after.active,
    registryReadOnly: before.registry === after.registry,
    noPromotion: true,
    externalModelCallsZero: Number(soak.externalModelCalls || 0) === 0
  };
  const report = { schemaVersion: 1, kind: 'lari.grounded-claim-growth-candidate.validation', createdAt: new Date().toISOString(), parent: { path: rel(BASE), sha256: shaFile(BASE) },
    candidate: { path: rel(candidatePath), sha256: candidateHash, learnedRecordIds: learnedRecords.map(record => record.id), promoted: false }, acquisition, hidden, ablation,
    productSoak: { path: rel(soakPath), passed: soak.passed, summary: soak.summary }, protectedBefore: before, protectedAfter: after, gates, passed: Object.values(gates).every(Boolean) };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, candidate: report.candidate, hidden: `${hidden.filter(row => row.executed && row.requiredPresent && row.grounded).length}/${hidden.length}`, ablation: `${ablation.filter(row => row.executionLost).length}/${ablation.length}`, soak: `${soak.summary.passedCount}/${soak.summary.taskCount}`, gates }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
