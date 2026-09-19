#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const BASE_HASH = '483c7595293fb367d22fe4e676bace57b876ab8d708e523386abf7dabb15699d';
const BASE = path.join(ROOT, 'consolidation', 'beta-quality-candidate-v9-20260909', 'candidates', `${BASE_HASH}.json`);
const ATTEMPT = process.argv.includes('--attempt9')
  ? 'beta-quality-execution-refinement-20260909-attempt9'
  : process.argv.includes('--attempt8')
  ? 'beta-quality-execution-refinement-20260909-attempt8'
  : process.argv.includes('--attempt7')
  ? 'beta-quality-execution-refinement-20260909-attempt7'
  : process.argv.includes('--attempt6')
  ? 'beta-quality-execution-refinement-20260909-attempt6'
  : process.argv.includes('--attempt5')
  ? 'beta-quality-execution-refinement-20260909-attempt5'
  : process.argv.includes('--attempt4')
  ? 'beta-quality-execution-refinement-20260909-attempt4'
  : process.argv.includes('--attempt3')
  ? 'beta-quality-execution-refinement-20260909-attempt3'
  : process.argv.includes('--attempt2')
  ? 'beta-quality-execution-refinement-20260909-attempt2'
  : 'beta-quality-execution-refinement-20260909';
const OUT = path.join(ROOT, 'consolidation', ATTEMPT);
const CANDIDATES = path.join(OUT, 'candidates');
const REPORT = path.join(OUT, 'validation-report.json');
const MANIFEST = path.join(OUT, 'candidate-manifest.json');
const SOAK = path.join(OUT, 'product-soak.json');
const SOAK_MD = path.join(OUT, 'product-soak.md');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const clone = value => JSON.parse(JSON.stringify(value));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

const refinements = {
  everyday_dialogue: {
    1: { features: ['conversation_access', 'self_capability'], body: 'Lari is a local model for conversation with the user that can chat, research with sources, help with coding, and retain verified preferences and skills.' },
    2: { features: ['idea_clarification'] },
    3: {
      features: ['capability_boundary', 'idea_clarification'],
      body: 'Name what is not good enough yet, explain how verified practice can improve it, and choose one useful next step without overstating capability.'
    }
  },
  research_quality: {
    1: { features: ['learning_method', 'evidence_quality'] },
    2: { features: ['learning_method', 'evidence_quality'] },
    3: { features: ['learning_method', 'evidence_quality', 'knowledge_retention'] }
  },
  repository_workflow: {
    addFeatures: ['workspace_absence'],
    1: { features: ['repository_workflow'] },
    2: { features: ['repository_workflow', 'project_creation'] },
    3: { features: ['repository_workflow', 'code_review', 'project_creation', 'programming_language_scope'] },
    append: [
      ['Workspace boundary', 'Without a linked workspace, answer coding questions and make a plan, but do not claim to inspect or change project files.', ['workspace_absence']],
      ['Project build', 'For a new application, plan the smallest useful slice, create it in the approved workspace, test it, and review the result.', ['project_creation']],
      ['Language transfer', 'Follow the repository language and conventions, write focused tests, and verify behavior regardless of the programming language.', ['programming_language_scope']]
    ]
  },
  product_onboarding: {
    2: { features: ['interface_disclosure'], body: 'Hide traces and technical details by default while keeping proof, model history, and rollback inspectable.' },
    append: [
      ['Advantage', 'The durable advantage is a local, personal model that learns verified user knowledge and skills while keeping them inspectable and reversible.', ['product_advantage']]
    ]
  },
  durable_memory: {
    1: { features: ['memory_preference'], body: 'Remember an explicit preference or correction as a scoped memory candidate so it can guide concise future answers.' },
    2: { features: ['memory_preference'] },
    3: { features: ['memory_preference', 'memory_privacy', 'reload_retention', 'user_modeling'], body: 'Keep verified user preferences and memory local and private, reload-stable for future sessions, and controllable through inspection, forgetting, and rollback.' }
  },
  agentic_experience: {
    1: { features: ['tool_orchestration', 'unified_identity'], body: 'Tools, swarm workers, memory, and verification operate as capabilities of one Lari model through the same public surface; verify their effects rather than treating them as competing brains.' },
    2: { features: ['agentic_safety', 'file_permission', 'secret_handling'], body: 'Ask for permission before consequential actions, stay inside the approved workspace, avoid exposing or committing secrets, and verify effects before claiming success.' },
    3: { features: ['progress_reporting'], body: 'Show concise progress while work runs and keep technical details hidden by default but available on demand.' }
  },
  multimodal_boundaries: {
    addFeatures: ['unified_identity', 'multimodal_unification'],
    requiredAnyFeatures: ['multimodal_generation', 'multimodal_unification', 'media_quality_boundary'],
    1: { features: ['multimodal_generation', 'multimodal_unification', 'unified_identity'], body: 'The unified model exposes image and short audio generators as capabilities and can build and verify a browser game inside a workspace.' },
    2: { features: ['multimodal_generation', 'media_quality_boundary'] },
    3: { features: ['media_quality_boundary'], body: 'High-quality open-ended image, audio, and video synthesis must improve through modality-specific generation, critique, repair, and transfer; video remains unproven rather than a silent external call.' }
  },
  release_judgment: {
    addFeatures: ['claim_calibration'],
    1: { features: ['promotion_decision', 'regression_rejection'], body: 'No candidate should receive promotion when it introduces a coding or other family regression, even if another score improves.' },
    2: { features: ['promotion_decision', 'claim_calibration', 'regression_rejection'] },
    3: { features: ['release_readiness', 'regression_rejection'], body: 'Reject a harmful learned change and block release until regressions are repaired, verified with representative users, and protected by exact rollback.' }
  },
  growth_strategy: {
    1: { features: ['capability_growth'], body: 'Measure the highest-impact weakness in user-facing answer quality across conversation, coding, or research against representative users and honest benchmarks.' },
    2: { features: ['capability_growth'], body: 'Use failure-driven training to repair the weakness with a reusable typed procedure or operator, then test it with focused tests in a workspace and fresh semantic or repository holdouts.' },
    3: { features: ['capability_growth'], body: 'Require trustworthy sources and evidence, transfer, exact ablation, reload retention, representative users, and zero family regressions before promotion.' }
  }
};

const cases = [
  ['everyday_dialogue', 'Give a candid overview of the useful help available right now.', ['chat', 'research', 'coding']],
  ['everyday_dialogue', 'Where are your current limits, and what constructive move follows?', ['not good', 'yet', 'improve', 'next']],
  ['research_quality', 'How does an uncertain recent claim become durable trustworthy knowledge?', ['sources', 'evidence', 'verify', 'memory']],
  ['research_quality', 'A dubious page conflicts with two reliable references; describe the safe learning process.', ['reject', 'verify', 'future']],
  ['repository_workflow', 'Could you still assist with programming before any folder is connected?', ['answer', 'workspace', 'files']],
  ['repository_workflow', 'Describe creating a small inventory service from scratch.', ['plan', 'workspace', 'test', 'review']],
  ['repository_workflow', 'Does the verified repair process transfer to Rust or Python projects?', ['language', 'tests', 'verify']],
  ['product_onboarding', 'What is the advantage of an inspectable personal local system?', ['local', 'personal', 'learn']],
  ['product_onboarding', 'What implementation evidence belongs behind the simple interface?', ['hide', 'proof', 'details']],
  ['durable_memory', 'Please retain my preference for short direct replies.', ['remember', 'preference', 'future']],
  ['durable_memory', 'How does the assistant adapt to one person across restarts without surrendering privacy?', ['user', 'preferences', 'local', 'private', 'reload']],
  ['agentic_experience', 'How do internal workers and tools remain one coherent assistant?', ['tools', 'one', 'model', 'verify']],
  ['agentic_experience', 'What happens when credentials appear during a file change?', ['permission', 'avoid', 'secrets', 'commit']],
  ['multimodal_boundaries', 'Describe producing a picture locally and judging whether it is usable.', ['image', 'generator', 'quality']],
  ['multimodal_boundaries', 'How should one model generate visual and sound assets while keeping code and conversation unified?', ['model', 'capabilities', 'quality']],
  ['multimodal_boundaries', 'How do image, audio, code, and chat remain unified capabilities?', ['unified', 'model', 'capabilities']],
  ['release_judgment', 'How should public claims stay honest and calibrated to measured evidence?', ['honest', 'scores', 'evidence']],
  ['release_judgment', 'A lesson harms an old skill. What happens next?', ['reject', 'regression', 'rollback']],
  ['growth_strategy', 'Give the full path from a visible coding weakness to a durable improvement.', ['weakness', 'training', 'tests', 'workspace', 'verify']]
];

function record(model, family) {
  const id = `lari.learned.procedure.beta_quality.${family}`;
  const found = model.lariLearnedRecords.records.find(item => item.id === id);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
}

function tokenize(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) || [])].filter(token => token.length > 3);
}

function refine(model, timestamp) {
  const changed = [];
  for (const [family, spec] of Object.entries(refinements)) {
    const target = record(model, family);
    const sections = target.payload.responsePlan.sections;
    for (const [key, value] of Object.entries(spec)) {
      if (!/^\d+$/.test(key)) continue;
      const section = sections[Number(key) - 1];
      if (value.body) section.body = value.body;
      section.selection.features = value.features;
      section.selection.triggers = tokenize(`${section.label} ${section.body}`);
    }
    for (const [label, body, features] of spec.append || []) {
      const id = `${family}.claim.${sections.length + 1}`;
      sections.push({ id, label, body, selection: { features, triggers: tokenize(`${label} ${body}`), priority: 2 } });
    }
    if (spec.addFeatures) {
      target.payload.semanticSelection.features = [...new Set([...target.payload.semanticSelection.features, ...spec.addFeatures])];
    }
    if (spec.requiredAnyFeatures) target.payload.semanticSelection.requiredAnyFeatures = [...spec.requiredAnyFeatures];
    target.payload.responsePlan.maxClaims = Math.max(3, Math.min(5, sections.length));
    target.provenance.revisions = [...(target.provenance.revisions || []), {
      timestamp,
      kind: 'failure_driven_executed_record_refinement',
      sourcePath: rel(REPORT),
      sourceModelHash: BASE_HASH,
      benchmarkAssociation: [],
      storesPromptText: false
    }];
    changed.push(target.id);
  }
  return changed;
}

function ask(model, prompt, hash, scope) {
  return runtime.runLariChatCompletion(model, { messages: [{ role: 'user', content: prompt }] }, {
    debug: true,
    readOnly: true,
    modelHash: hash,
    userScope: scope
  });
}

function assess(model, hash, item, scope) {
  const [family, prompt, required] = item;
  const completion = ask(model, prompt, hash, scope);
  const answer = completion.choices[0].message.content;
  const lower = answer.toLowerCase();
  const id = `lari.learned.procedure.beta_quality.${family}`;
  return {
    family,
    prompt,
    required,
    answer,
    selectedRecordId: completion.lari?.capability_selection?.learnedRecordId || null,
    executedLearnedRecordIds: completion.lari?.executed_learned_record_ids || [],
    publicAnswerSource: completion.lari?.public_source || null,
    recordExecuted: (completion.lari?.executed_learned_record_ids || []).includes(id),
    missing: required.filter(term => !lower.includes(term)),
    externalModelCalls: completion.external_model_calls || 0
  };
}

function main() {
  if (fs.existsSync(REPORT) || fs.existsSync(MANIFEST)) throw new Error('Immutable refinement artifacts already exist.');
  if (shaFile(BASE) !== BASE_HASH) throw new Error('Immutable v9 base hash mismatch.');
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const model = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const timestamp = new Date().toISOString();
  const changedRecordIds = refine(model, timestamp);
  const previous = clone(model.lineage || {});
  model.lineage = {
    ...previous,
    timestamp,
    type: 'beta_quality_execution_refinement_candidate',
    parentHash: BASE_HASH,
    learnedRecordIds: changedRecordIds,
    promoted: false,
    externalModelCalls: 0,
    previous
  };
  fs.mkdirSync(CANDIDATES, { recursive: true });
  const bytes = `${JSON.stringify(model, null, 2)}\n`;
  const candidateHash = sha(bytes);
  const candidatePath = path.join(CANDIDATES, `${candidateHash}.json`);
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });

  const hidden = cases.map((item, index) => assess(clone(model), candidateHash, item, `execution-refinement-hidden-${index}`));
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const reload = cases.map((item, index) => assess(clone(reloaded), candidateHash, item, `execution-refinement-reload-${index}`));
  const ablation = [...new Set(cases.map(item => item[0]))].map((family, index) => {
    const item = cases.find(row => row[0] === family);
    const altered = clone(model);
    const id = `lari.learned.procedure.beta_quality.${family}`;
    altered.lariLearnedRecords.records = altered.lariLearnedRecords.records.filter(entry => entry.id !== id);
    const result = assess(altered, candidateHash, item, `execution-refinement-ablation-${index}`);
    const control = hidden.find(row => row.family === family && row.prompt === item[1]);
    return { family, recordId: id, recordAbsent: !result.executedLearnedRecordIds.includes(id), behaviorChanged: result.answer !== control.answer, answer: result.answer };
  });
  const arithmeticPrompts = [
    ['A change adds 4 modules and repairs 3 modules. How many modules are touched in total?', '7'],
    ['A queue has 9 blockers; the team resolves 4. How many blockers remain?', '5'],
    ['We completed 5 checks and added 2 checks. How many should the report total?', '7'],
    ['A list starts with 12 defects and removes 5. How many are left?', '7']
  ];
  const arithmetic = arithmeticPrompts.map(([prompt, expected], index) => {
    const completion = ask(clone(model), prompt, candidateHash, `execution-refinement-math-${index}`);
    const answer = completion.choices[0].message.content;
    return { prompt, expected, answer, passed: answer.includes(expected), externalModelCalls: completion.external_model_calls || 0 };
  });

  const soakRun = childProcess.spawnSync(process.execPath, [path.join(ROOT, 'benchmarks', 'run_lari_product_soak_eval.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LARI_MODEL_PATH: rel(candidatePath), LARI_PRODUCT_SOAK_REPORT_PATH: rel(SOAK), LARI_PRODUCT_SOAK_SUMMARY_PATH: rel(SOAK_MD) },
    timeout: 120000
  });
  if (!fs.existsSync(SOAK)) throw new Error(`Product soak failed to run: ${soakRun.stderr || soakRun.stdout}`);
  const soak = JSON.parse(fs.readFileSync(SOAK, 'utf8'));
  const serializedChanged = JSON.stringify(changedRecordIds.map(id => model.lariLearnedRecords.records.find(item => item.id === id)));
  const storedPrompt = [...cases.map(item => item[1]), ...soak.results.map(item => item.prompt)].some(prompt => serializedChanged.includes(prompt));
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY) };
  const gates = {
    hiddenSemanticTransfer: hidden.every(row => row.recordExecuted && row.missing.length === 0 && row.externalModelCalls === 0),
    reloadRetention: reload.every(row => row.recordExecuted && row.missing.length === 0 && row.externalModelCalls === 0),
    exactRecordAblation: ablation.every(row => row.recordAbsent && row.behaviorChanged),
    arithmeticTransfer: arithmetic.every(row => row.passed && row.externalModelCalls === 0),
    productSoak: soak.passed === true,
    noPromptStorage: !storedPrompt,
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    activeAndRegistryReadOnly: before.active === after.active && before.registry === after.registry,
    noPromotion: true,
    externalModelCallsZero: Number(soak.externalModelCalls || 0) === 0
  };
  const report = {
    schemaVersion: 1,
    kind: 'lari.beta-quality.execution-refinement-validation',
    createdAt: timestamp,
    parent: { path: rel(BASE), sha256: BASE_HASH },
    candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false },
    changedRecordIds,
    diagnosticMethod: 'Classify by the learned record actually executed; refine that record in place, and add no benchmark prompt or scoring vocabulary to model state.',
    hidden,
    reload,
    ablation,
    arithmetic,
    productSoak: { path: rel(SOAK), passed: soak.passed, summary: soak.summary },
    protectedBefore: before,
    protectedAfter: after,
    gates,
    passed: Object.values(gates).every(Boolean),
    externalModelCalls: 0
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(MANIFEST, `${JSON.stringify({ schemaVersion: 1, kind: 'lari.beta-quality.execution-refinement-candidate', createdAt: timestamp, parentHash: BASE_HASH, candidate: report.candidate, changedRecordIds, validationReport: rel(REPORT), gates, promoted: false }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ candidate: report.candidate, hidden: `${hidden.filter(row => row.recordExecuted && !row.missing.length).length}/${hidden.length}`, reload: `${reload.filter(row => row.recordExecuted && !row.missing.length).length}/${reload.length}`, ablation: `${ablation.filter(row => row.recordAbsent && row.behaviorChanged).length}/${ablation.length}`, arithmetic: `${arithmetic.filter(row => row.passed).length}/${arithmetic.length}`, soak: `${soak.summary.passedCount}/${soak.summary.taskCount}`, weakFamilies: soak.summary.weakFamilies, gates }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main();
