'use strict';

/**
 * Product capability families that the benchmark corpus is intended to verify.
 *
 * This file is audit and migration metadata, not a router. Benchmark filenames never enter the
 * live model as triggers, procedures, or answers. A benchmark may exercise several implementation
 * functions, but those functions are components of a smaller user-facing capability.
 */

const CAPABILITY_FAMILIES = [
  {
    id: 'conversation',
    title: 'Direct conversation and answer quality',
    type: 'procedure',
    publicKernelLane: 'chat',
    intents: ['chat'],
    selectionTerms: ['chat', 'conversation', 'explain', 'question'],
    triggers: ['chat', 'conversation', 'answer', 'explain', 'respond', 'question', 'clarify', 'result', 'verify'],
    procedure: ['understand the request', 'answer directly', 'ground claims in retained state', 'repair unclear output'],
    benchmarkPatterns: [/chat/i, /answer/i, /response/i, /visible/i, /model_identity/i, /ask_cli/i, /grounded_factual/i, /public_truth/i, /public_lm_eval_adapter/i, /private_alpha_soak/i, /frontier_style/i]
  },
  {
    id: 'instruction_following',
    title: 'Constraint-aware instruction following',
    type: 'procedure',
    publicKernelLane: 'chat',
    intents: ['chat'],
    selectionTerms: ['instruction', 'exactly', 'bullet', 'json', 'format'],
    triggers: ['instruction', 'constraint', 'format', 'exactly', 'json', 'bullet', 'language'],
    procedure: ['extract explicit constraints', 'compose a compliant answer', 'validate format and content'],
    benchmarkPatterns: [/ifeval/i, /instruction/i]
  },
  {
    id: 'math_reasoning',
    title: 'Local arithmetic and word-problem reasoning',
    type: 'procedure',
    publicKernelLane: 'chat',
    intents: ['chat'],
    selectionTerms: ['math'],
    triggers: ['math', 'arithmetic', 'calculate', 'equation', 'percent', 'total', 'word problem'],
    procedure: ['parse quantities and operations', 'calculate locally', 'verify the result', 'format the answer'],
    benchmarkPatterns: [/gsm8k/i, /math/i, /arithmetic/i]
  },
  {
    id: 'multiple_choice_reasoning',
    title: 'Multiple-choice reasoning',
    type: 'procedure',
    publicKernelLane: 'chat',
    intents: ['chat'],
    selectionTerms: ['multiple choice', 'option', 'letter'],
    triggers: ['multiple choice', 'option', 'choice', 'select', 'letter', 'answer'],
    procedure: ['parse the question and options', 'eliminate incompatible choices', 'select and format the answer'],
    benchmarkPatterns: [/multiple_choice/i, /lm_skill_absorption/i]
  },
  {
    id: 'research_learning',
    title: 'Source-grounded research and retained learning',
    type: 'procedure',
    publicKernelLane: 'research',
    intents: ['research'],
    selectionTerms: ['research', 'source', 'evidence', 'learn'],
    triggers: ['research', 'learn', 'study', 'source', 'evidence', 'unknown', 'teach yourself'],
    procedure: ['form a focused question', 'gather and score sources', 'distill supported claims', 'retain typed knowledge', 'verify reuse'],
    benchmarkPatterns: [/research/i, /knowledge/i, /semantic_memory/i, /domain_expansion/i]
  },
  {
    id: 'personalization_memory',
    title: 'Scoped user preference and session memory',
    type: 'preference',
    publicKernelLane: 'chat',
    intents: ['chat'],
    selectionTerms: ['personalization', 'preference', 'remember', 'correction'],
    triggers: ['remember', 'preference', 'personalize', 'user', 'session', 'context', 'correction'],
    procedure: ['identify explicit user signals', 'store them in the user scope', 'apply them quietly', 'retain corrections across reload'],
    benchmarkPatterns: [/personal/i, /preference/i, /context_memory/i, /context_action/i, /long_session/i, /session_runtime/i]
  },
  {
    id: 'workspace_coding',
    title: 'Verified workspace coding and repair',
    type: 'operator',
    publicKernelLane: 'code',
    intents: ['code'],
    selectionTerms: ['workspace'],
    triggers: ['code', 'coding', 'workspace', 'repository', 'bug', 'failure', 'repair', 'patch', 'test'],
    procedure: ['inspect the workspace', 'reproduce the failure', 'form a diagnostic hypothesis', 'apply the smallest compatible patch', 'run fail-before pass-after verification'],
    benchmarkPatterns: [/cod(e|ing)/i, /workspace/i, /swebench/i, /repair/i, /mutation/i, /autorepair/i, /frontier_(?:preserving_edit|replacement_cycle|language_lane|multi_language|polyglot)/i, /adversarial_generalization/i]
  },
  {
    id: 'project_building',
    title: 'Local project creation, review, and repair',
    type: 'operator',
    publicKernelLane: 'product',
    intents: ['product', 'code'],
    selectionTerms: ['project', 'app', 'api', 'backend'],
    triggers: ['build', 'create', 'project', 'app', 'api', 'backend', 'product', 'review', 'verify'],
    procedure: ['plan the project', 'create local files', 'run checks', 'review failures', 'repair and verify the finished product'],
    benchmarkPatterns: [/project/i, /backend_api/i, /app_builder/i, /product_builder/i, /product_readiness/i, /product_soak/i, /product_(?:acquisition|gauntlet)/i, /live_product/i, /real_suite/i, /first_run_product_smoke/i]
  },
  {
    id: 'image_generation',
    title: 'Local procedural image generation',
    type: 'generator',
    publicKernelLane: 'product',
    intents: ['product'],
    selectionTerms: ['image', 'picture', 'svg', 'draw'],
    triggers: ['generate', 'image', 'picture', 'visual', 'svg', 'draw', 'scene'],
    procedure: ['select the promoted image generator', 'render locally', 'score structural quality', 'return only verified artifacts'],
    benchmarkPatterns: [/image/i, /visual/i, /photoreal/i, /texture/i, /diffusion/i]
  },
  {
    id: 'audio_generation',
    title: 'Local procedural audio generation',
    type: 'generator',
    publicKernelLane: 'product',
    intents: ['product'],
    selectionTerms: ['audio', 'music', 'wav', 'melody'],
    triggers: ['generate', 'audio', 'music', 'sound', 'wav', 'melody', 'loop'],
    procedure: ['select the promoted audio generator', 'render locally', 'verify waveform and duration', 'return only verified artifacts'],
    benchmarkPatterns: [/audio/i]
  },
  {
    id: 'video_editing',
    title: 'Verified local video clipping and scene selection',
    type: 'operator',
    publicKernelLane: 'product',
    intents: ['product'],
    selectionTerms: ['video', 'movie'],
    triggers: ['video', 'clip', 'scene change', 'trim', 'ffmpeg', 'ffprobe'],
    procedure: ['validate the input video', 'select bounded clips', 'write them locally', 'verify every output with ffprobe'],
    benchmarkPatterns: [/video/i]
  },
  {
    id: 'multimodal_product',
    title: 'Composed local multimodal products',
    type: 'operator',
    publicKernelLane: 'product',
    intents: ['product'],
    selectionTerms: ['multimodal', 'game', 'experience', 'compose'],
    triggers: ['multimodal', 'game', 'experience', 'product', 'image', 'audio', 'compose'],
    procedure: ['plan required lanes', 'generate local artifacts', 'compose the product', 'evaluate the whole result', 'repair missing or weak lanes'],
    benchmarkPatterns: [/multimodal/i, /game_lane/i, /product_composer/i, /chat_to_multimodal/i]
  },
  {
    id: 'tool_operator_execution',
    title: 'Verified local tool and operator execution',
    type: 'operator',
    publicKernelLane: 'code',
    intents: ['code', 'product'],
    selectionTerms: ['operator'],
    triggers: ['tool', 'operator', 'browser', 'retry', 'workflow', 'execute', 'verify'],
    procedure: ['select a compatible local operator', 'execute with bounded inputs', 'verify the result', 'retain reusable repairs'],
    benchmarkPatterns: [/operator/i, /tool/i, /browser/i, /workflow/i, /retry/i, /systems/i, /content_pipeline/i]
  },
  {
    id: 'failure_learning',
    title: 'Failure-driven repair learning',
    type: 'repair',
    publicKernelLane: 'code',
    intents: ['code', 'research'],
    selectionTerms: ['learn', 'retain', 'transfer', 'hypothesis'],
    triggers: ['failure', 'failed', 'learn', 'retain', 'retrain', 'replay', 'hypothesis', 'transfer', 'reload'],
    procedure: ['record the failure', 'classify the cause', 'repair under verification', 'retain a typed reusable lesson', 'prove unseen transfer after reload'],
    benchmarkPatterns: [/failure/i, /retrain/i, /experience_replay/i, /retention/i, /transfer/i]
  },
  {
    id: 'capability_composition',
    title: 'Capability selection and composition',
    type: 'operator',
    publicKernelLane: 'chat',
    intents: ['chat', 'code', 'product', 'research'],
    selectionTerms: ['capability'],
    triggers: ['capability', 'compose', 'graph', 'agent', 'specialist', 'swarm', 'route', 'skill'],
    procedure: ['build derived capability indexes', 'select the narrowest compatible capability', 'compose shared operators', 'verify the combined result'],
    benchmarkPatterns: [/capability/i, /composition/i, /agent_/i, /specialist/i, /swarm/i, /skill_/i, /unified_task_kernel/i, /general_intelligence/i, /arena_harness/i, /benchmark_system_(?:absorption|session_routing)/i]
  },
  {
    id: 'autonomous_execution',
    title: 'Autonomous task execution',
    type: 'operator',
    publicKernelLane: 'autonomous',
    intents: ['chat', 'code', 'product', 'research'],
    selectionTerms: ['autonomous'],
    triggers: ['autonomous', 'mission', 'task', 'execute', 'plan', 'checkpoint', 'long horizon'],
    procedure: ['classify the task', 'select shared capabilities', 'execute bounded steps', 'verify outcomes', 'record transferable failures'],
    benchmarkPatterns: [/autonomous/i, /mission/i, /task_eval/i, /long_horizon/i, /checkpoint/i, /real_world_task_market/i]
  },
  {
    id: 'model_growth',
    title: 'Candidate-only model growth and consolidation',
    type: 'procedure',
    publicKernelLane: 'research',
    intents: ['research'],
    selectionTerms: ['growth'],
    triggers: ['grow', 'growth', 'train', 'curriculum', 'self improve', 'consolidate', 'candidate'],
    procedure: ['identify a verified gap', 'train only an isolated candidate', 'test holdouts and transfer', 'retain lineage', 'leave promotion to the gate'],
    benchmarkPatterns: [/growth/i, /training/i, /curriculum/i, /self_improvement/i, /self_learning/i, /neurogenesis/i, /consolidat/i, /learning_curve/i, /(?:background|continual|live|super)_learning/i, /memory_reuse/i, /self_(?:directed_)?expansion/i, /structured_induction/i, /assertion_induction/i, /strategy_(?:arena|evolution)/i, /policy_/i, /subintent/i, /universal_improvement/i, /repo_brain/i, /qwen_competitor/i, /frontier_(?:arena|head_to_head)/i]
  },
  {
    id: 'model_lifecycle',
    title: 'Model integrity, promotion, reload, and rollback',
    type: 'operator',
    publicKernelLane: 'chat',
    intents: ['chat'],
    selectionTerms: ['rollback'],
    triggers: ['model', 'registry', 'candidate', 'promote', 'reload', 'rollback', 'hash', 'lineage', 'checkpoint', 'shard'],
    procedure: ['validate candidate integrity', 'compare against the incumbent', 'promote atomically only after gates pass', 'verify reload', 'restore the exact prior hash on rollback'],
    benchmarkPatterns: [/model_/i, /registry/i, /promotion/i, /reload/i, /rollback/i, /shard/i, /launch/i, /integrity/i, /dependency_package_check/i, /locality_report/i]
  }
];

const RETIRED_PATTERNS = [/benchmark_system_absorption/i, /benchmark_system_session_routing/i, /lm_training_daemon/i, /math_auto_template_miner/i, /math_generic_policy_synthesizer/i, /math_lab/i];

function mapBenchmarkToCapabilities(file, evidenceClass = '') {
  const name = String(file || '');
  const matches = CAPABILITY_FAMILIES
    .filter(family => family.benchmarkPatterns.some(pattern => pattern.test(name)))
    .map(family => family.id);
  const retired = RETIRED_PATTERNS.some(pattern => pattern.test(name)) || evidenceClass === 'retired-contaminated-path';
  return {
    capabilityIds: [...new Set(matches)],
    benchmarkRole: retired ? 'retired-invalid-proof' : evidenceClass === 'infrastructure-or-fixture' ? 'verification-infrastructure' : 'behavioral-evidence',
    eligibleForCapabilityProof: !retired && !['development-external-comparison', 'infrastructure-or-fixture'].includes(evidenceClass)
  };
}

module.exports = { CAPABILITY_FAMILIES, RETIRED_PATTERNS, mapBenchmarkToCapabilities };
