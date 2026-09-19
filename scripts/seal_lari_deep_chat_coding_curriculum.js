#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PARENT_HASH = '8e9e0003332ea03b383081410b06ddf670bbf7e0658996a7e5e95d9a17f907df';
const OUT = path.join(ROOT, 'consolidation', 'deep-chat-coding-expansion-20260829');
const TARGET = path.join(OUT, 'sealed-curriculum.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

const chat = [
  ['code_explanation_depth', 'technical_code_explanation', ['explain','novice','expert','mechanism','code'], ['explanation'], 'Explain this retry loop first for a beginner and then at expert depth.', 'Walk me through this cache invalidation routine for a newcomer, then explain the precise mechanism.', ['Beginner:', 'Mechanism:', 'Expert detail:']],
  ['decisive_debugging_interview', 'debugging_interview', ['debug','question','reproduce','changed','failure'], ['troubleshooting','planning'], 'Interview me to debug an intermittent worker crash using only decisive questions.', 'Ask the minimum useful questions to diagnose a service that sometimes hangs during shutdown.', ['First decisive question:', 'Why it matters:', 'Next branch:']],
  ['technical_mutation_clarification', 'mutation_clarification', ['clarify','before','edit','expected','constraint'], ['planning','troubleshooting'], 'Clarify what matters before changing this parser.', 'Before modifying this migration, identify the missing requirement that changes the safe implementation.', ['Missing decision:', 'Why it changes the edit:', 'Safe next step:']],
  ['evidence_uncertainty', 'evidence_uncertainty', ['uncertain','evidence','unknown','infer','verify'], ['explanation','open_chat'], 'Separate what the logs prove from what we are only guessing.', 'Tell me what this symptom establishes, what remains unknown, and how to verify the leading inference.', ['Observed:', 'Inferred:', 'Unknown:', 'Verification:']],
  ['failure_output_explanation', 'failure_output_explanation', ['stack','trace','test','output','failure'], ['explanation','troubleshooting'], 'Explain this stack trace without jumping straight to a patch.', 'Interpret the failing test output and show where the causal chain begins.', ['Failure point:', 'Causal chain:', 'Not yet proven:']],
  ['severity_code_review', 'severity_code_review', ['review','severity','risk','repair','code'], ['explanation','troubleshooting'], 'Review this change with severity and actionable fixes.', 'Give me code-review feedback ordered by impact, with a concrete repair for the top issue.', ['Severity:', 'Evidence:', 'Repair:']],
  ['tool_result_synthesis', 'tool_result_synthesis', ['tool','result','output','noise','summary'], ['composition','explanation'], 'Summarize these tool results without dumping internal noise.', 'Turn this command output into a clean user update with evidence and unresolved failures.', ['Result:', 'Evidence:', 'Unresolved:']],
  ['correction_perspective_repair', 'correction_repair', ['correction','wrong','misunderstood','revise','instead'], ['open_chat','composition'], 'I said the API is synchronous, not asynchronous; revise your explanation.', 'That is not the constraint I gave you. Correct your interpretation and restate the plan.', ['Correction accepted:', 'Revised understanding:', 'Changed consequence:']],
  ['long_followup_coherence', 'long_context_coherence', ['follow','earlier','constraint','still','context'], ['open_chat','planning'], 'Continue the technical plan while preserving the constraints we established earlier.', 'Based on our earlier decision, state what still holds and what the new evidence changes.', ['Still true:', 'Changed:', 'Next:']],
  ['example_counterexample', 'example_counterexample', ['example','counterexample','edge','fails','rule'], ['explanation'], 'Teach this validation rule with an example and counterexample.', 'Show one case where this invariant holds and one edge case that breaks the naive version.', ['Example:', 'Counterexample:', 'Rule:']],
  ['analogy_then_mechanism', 'analogy_mechanism', ['analogy','mechanism','exact','like','works'], ['explanation'], 'Use an analogy for backpressure, then give the exact mechanism.', 'Explain optimistic concurrency with an intuition first and the precise state transition second.', ['Analogy:', 'Exact mechanism:', 'Limit of analogy:']],
  ['assumption_bound_tradeoff', 'assumption_tradeoff', ['tradeoff','recommend','assumption','option','because'], ['comparison','planning'], 'Recommend polling or webhooks and state the assumptions behind the choice.', 'Choose between a queue and direct calls, but make the recommendation conditional on explicit assumptions.', ['Assumptions:', 'Recommendation:', 'Reconsider when:']],
  ['verified_progress_report', 'verified_progress', ['progress','completed','verified','blocked','next'], ['planning','open_chat'], 'Report progress without mixing completed work with plans.', 'Give me a status update separating what is implemented, what is proven, what is blocked, and what happens next.', ['Completed:', 'Verified:', 'Blocked:', 'Next:']],
  ['teach_back_check', 'teach_back', ['teach','back','check','understanding','explain'], ['explanation'], 'Teach me the concept, then check whether I understood it.', 'Explain idempotency and finish with a short teach-back question.', ['Explanation:', 'Teach-back:', 'Success check:']],
  ['useful_capability_boundary', 'capability_boundary', ['cannot','boundary','unsupported','alternative','honest'], ['open_chat','explanation'], 'Tell me honestly if this capability is unsupported and give a useful next step.', 'State the boundary without bluffing, then offer the nearest safe action that is actually available.', ['Boundary:', 'Reason:', 'Useful next step:']],
  ['conversation_learning_plan', 'conversation_learning_plan', ['learn','research','practice','retain','conversation'], ['planning','explanation'], 'Turn our conversation into a plan for what Lari should research versus practice.', 'From this discussion, separate the knowledge gap from the executable skill gap and say what can be retained.', ['Research:', 'Practice:', 'Retention gate:']]
].map(([id, kind, triggers, intents, train, hidden, required]) => ({ id, kind, triggers, intents, train, hidden, required }));

const coding = [
  ['issue_localization', 'stack trace and symptom-driven issue localization'],
  ['isolated_test_creation', 'minimal isolated test creation when the native harness is blocked'],
  ['cross_file_contract', 'cross-file interface and contract repair'],
  ['schema_migration', 'type and schema migration with backward compatibility'],
  ['async_lifecycle', 'async ordering cancellation timeout and resource lifecycle repair'],
  ['serialization_config', 'serialization and configuration boundary repair'],
  ['dependency_drift', 'dependency API drift adaptation without oracle changes'],
  ['build_toolchain', 'build package and toolchain configuration repair'],
  ['behavior_refactor', 'behavior-preserving refactoring with equivalence checks'],
  ['error_boundaries', 'error propagation validation and boundary condition repair'],
  ['multi_defect_relaxation', 'coordinated multi-defect repair with progressive constraint relaxation'],
  ['long_horizon_repository', 'long-horizon localization test creation repair refactor and regression verification']
].map(([id, objective]) => ({
  id,
  objective,
  requiredEvidence: ['unknown failing workspace', 'diagnostic hypothesis before edit', 'immutable external oracle hash', 'fail-before', 'pass-after', 'fresh semantic transfer', 'reload retention', 'causal ablation'],
  languages: ['javascript','typescript','python','ruby','go','rust','csharp','java','php'],
  forbidden: ['exact-prompt lock','fixture path in learned state','oracle rewrite','benchmark metadata as route','external model call']
}));

function main() {
  if (fs.existsSync(TARGET)) throw new Error('Sealed curriculum already exists.');
  const active = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
  const activeHash = crypto.createHash('sha256').update(fs.readFileSync(active)).digest('hex');
  if (activeHash !== PARENT_HASH) throw new Error(`Expected production parent ${PARENT_HASH}, got ${activeHash}.`);
  const payload = {
    schemaVersion: 1,
    kind: 'lari.deep-chat-coding-expansion.sealed-curriculum',
    sealedAt: new Date().toISOString(),
    parentHash: PARENT_HASH,
    oraclePolicy: 'immutable external tests decide coding success; prompts and expected response markers never enter learned state',
    chat,
    coding,
    gates: {
      chatFamilies: 16,
      codingFamilies: 12,
      fiveSurfaceChatParityRequired: true,
      causalAblationRequired: true,
      reloadRequired: true,
      familyRegressionTolerance: 0,
      externalModelCalls: 0,
      promotionAllowed: false
    }
  };
  fs.mkdirSync(OUT, { recursive: true });
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(TARGET, bytes, { flag: 'wx' });
  console.log(JSON.stringify({ path: path.relative(ROOT, TARGET).replace(/\\/g, '/'), sha256: sha(bytes), parentHash: PARENT_HASH, chatFamilies: chat.length, codingFamilies: coding.length }, null, 2));
}

main();
