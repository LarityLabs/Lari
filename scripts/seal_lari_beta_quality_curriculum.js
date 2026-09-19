#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
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
const TARGET = path.join(OUT, 'sealed-curriculum.json');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const families = [
  {
    id: 'everyday_dialogue', triggers: ['ordinary', 'assistant', 'chat', 'talk', 'capable', 'candid', 'help', 'idea'], minTriggerMatches: 2,
    train: 'Talk to me like an everyday assistant and explain honestly what kinds of help you provide.',
    hidden: ['Could I use you as an ordinary assistant? Be candid about what you can handle.', 'I have a half-formed idea. Help me clarify it and choose the next useful move.'],
    required: ['Lari', 'local', 'chat', 'coding', 'research', 'clarify', 'next'],
    sections: [
      ['Answer', 'Lari is a local model that can chat, research with sources, help with coding, and retain verified preferences and skills.'],
      ['Clarify', 'For a vague idea, clarify the desired outcome, intended user, and hardest constraint before pretending the task is fully specified.'],
      ['Next', 'Choose one small useful next step and state honestly when a capability remains bounded or unverified.']
    ]
  },
  {
    id: 'research_quality', triggers: ['current', 'facts', 'sources', 'evidence', 'internet', 'research', 'verify', 'future'], minTriggerMatches: 2,
    train: 'Explain how current online research becomes trustworthy reusable knowledge.',
    hidden: ['A claim appeared online yesterday. Explain how it should enter durable knowledge.', 'How do you stop weak web information from poisoning future answers?'],
    required: ['current', 'sources', 'evidence', 'reject', 'verify', 'memory', 'future'],
    sections: [
      ['Question', 'Turn uncertainty into a focused question and gather current, authoritative sources.'],
      ['Evidence', 'Compare independent evidence, preserve provenance and confidence, and reject unsupported or conflicting claims.'],
      ['Verify', 'Verify the distilled claim on a fresh question before retaining it in memory for future answers.']
    ]
  },
  {
    id: 'repository_workflow', triggers: ['repo', 'repository', 'workspace', 'coding', 'code', 'language', 'project', 'review', 'tests'], minTriggerMatches: 2,
    train: 'Describe the complete workflow for solving a bug in an unfamiliar repository.',
    hidden: ['A new project in an unfamiliar language has a defect. Describe the end-to-end workflow.', 'How should you review and prove a multi-file code repair?'],
    required: ['workspace', 'inspect', 'test', 'review', 'verify', 'language', 'files'],
    sections: [
      ['Inspect', 'Open the approved workspace, identify the language and project conventions, inspect the relevant files, and reproduce the failure.'],
      ['Repair', 'Write or isolate a failing test, form a diagnostic hypothesis, and make the smallest compatible code change.'],
      ['Review', 'Review every touched file, run focused and family tests, verify fail-before and pass-after behavior, and report unresolved risk.']
    ]
  },
  {
    id: 'product_onboarding', triggers: ['first', 'install', 'onboarding', 'experience', 'interface', 'workspace', 'launch', 'users', 'feedback'], minTriggerMatches: 2,
    train: 'Design a simple install and first-success experience for a local assistant.',
    hidden: ['Describe the ideal install-to-first-success journey and what advanced UI should conceal.', 'What evidence from users should decide whether the product can launch?'],
    required: ['install', 'simple', 'ask', 'answer', 'workspace', 'hide', 'details', 'users', 'feedback'],
    sections: [
      ['First run', 'Keep install simple: start the app, ask a normal question, receive a direct answer, and link a workspace only when files are needed.'],
      ['Interface', 'Hide traces and technical details by default while keeping evidence, model history, and rollback inspectable.'],
      ['Launch', 'Use real users, task soaks, bugs, and concrete feedback to decide readiness instead of counting infrastructure checks as usefulness.']
    ]
  },
  {
    id: 'durable_memory', triggers: ['memory', 'preference', 'prefer', 'correction', 'future', 'reload', 'restart', 'remember'], minTriggerMatches: 2,
    train: 'Explain how a user preference or correction should become durable behavior.',
    hidden: ['How should a preference correction persist across restart?', 'Why should user memory remain local, inspectable, and reversible?'],
    required: ['correction', 'preference', 'future', 'verify', 'reload', 'local', 'memory', 'rollback'],
    sections: [
      ['Capture', 'Treat an explicit preference or correction as a scoped memory candidate, replacing only the conflicting assumption.'],
      ['Verify', 'Verify that the correction improves future behavior without damaging unrelated capabilities.'],
      ['Retain', 'Keep verified memory local and reload-stable, with inspection, disable, forget, and rollback controls for the user.']
    ]
  },
  {
    id: 'agentic_experience', triggers: ['tools', 'workers', 'swarm', 'permission', 'progress', 'details', 'agent', 'unified'], minTriggerMatches: 2,
    train: 'Explain how internal tools and workers can act safely while feeling like one assistant.',
    hidden: ['How should tools and workers cooperate without looking like several competing agents?', 'What should progress and permission look like during computer work?'],
    required: ['tools', 'swarm', 'workers', 'one', 'model', 'permission', 'progress', 'details'],
    sections: [
      ['One model', 'Tools, swarm workers, memory, and verification operate as capabilities of one Lari model, not competing brains.'],
      ['Authority', 'Require permission for consequential actions, stay inside the approved workspace, and verify effects before claiming success.'],
      ['Progress', 'Show concise progress while work runs and keep technical details available on demand rather than flooding the main conversation.']
    ]
  },
  {
    id: 'multimodal_boundaries', triggers: ['image', 'audio', 'video', 'game', 'generator', 'quality', 'media', 'multimodal'], minTriggerMatches: 2,
    train: 'State the actual local media capabilities and how their quality should be judged.',
    hidden: ['What can the local media lanes honestly produce, and how is quality evaluated?', 'Could the same model build a browser game and create its image or audio assets?'],
    required: ['image', 'audio', 'video', 'game', 'generator', 'quality', 'verify', 'model'],
    sections: [
      ['Available', 'The model has procedural image and short audio generators and can build and verify a browser game inside a workspace.'],
      ['Quality', 'Each generator needs modality-specific quality checks plus task-level verification before its artifact is called successful.'],
      ['Boundary', 'High-quality open-ended image, audio, and video synthesis are not yet proven; video remains a capability gap rather than a silent external call.']
    ]
  },
  {
    id: 'release_judgment', triggers: ['candidate', 'promote', 'promotion', 'regression', 'release', 'bugs', 'scores', 'claims', 'rollback'], minTriggerMatches: 2,
    train: 'Explain why a candidate with a family regression cannot be released.',
    hidden: ['What happens if a candidate scores better in one area and worse in another?', 'Which evidence should block promotion or public release?'],
    required: ['no', 'regression', 'promotion', 'scores', 'evidence', 'bugs', 'users', 'rollback'],
    sections: [
      ['Decision', 'No candidate should receive promotion when it introduces a regression, even if another score improves.'],
      ['Evidence', 'Require honest scores, hidden transfer, user-facing soak evidence, unresolved bug review, reload, and exact rollback.'],
      ['Release', 'Block release until serious failures are repaired and verified with representative users and retained family tests.']
    ]
  },
  {
    id: 'growth_strategy', triggers: ['bigger', 'capability', 'frontier', 'conversation', 'coding', 'research', 'weakness', 'train', 'holdout'], minTriggerMatches: 2,
    train: 'Describe how to produce large verified capability gains across chat and coding.',
    hidden: ['Describe a route to larger capability gains in conversation, programming, and research.', 'How should measured weaknesses become durable model improvements?'],
    required: ['weakness', 'train', 'verify', 'holdout', 'conversation', 'coding', 'research', 'users'],
    sections: [
      ['Weakness', 'Measure the highest-impact user-visible weakness in conversation, coding, or research without giving the model the answer.'],
      ['Train', 'Use failure-driven training to create a reusable typed procedure or operator, then test fresh semantic and repository holdouts.'],
      ['Verify', 'Require transfer, exact ablation, reload retention, evidence from representative users, and zero family regressions before promotion.']
    ]
  }
];

const semanticGroupsById = {
  everyday_dialogue: [['help', 'use', 'talk', 'ordinary'], ['idea', 'assistant', 'capable', 'handle', 'candid']],
  research_quality: [['web', 'internet', 'online', 'sources', 'claim', 'information'], ['learn', 'knowledge', 'future', 'verify', 'current', 'trust']],
  repository_workflow: [['repo', 'repository', 'project', 'code', 'files'], ['bug', 'defect', 'repair', 'review', 'prove', 'unfamiliar']],
  product_onboarding: [['install', 'first', 'launch', 'users', 'interface', 'product'], ['experience', 'journey', 'evidence', 'feedback', 'conceal', 'readiness']],
  durable_memory: [['memory', 'preference', 'correction'], ['restart', 'reload', 'future', 'local', 'reversible', 'persist']],
  agentic_experience: [['tools', 'workers', 'swarm', 'computer'], ['safe', 'cooperate', 'permission', 'progress', 'one', 'competing']],
  multimodal_boundaries: [['image', 'audio', 'video', 'game', 'media', 'assets'], ['build', 'create', 'produce', 'quality', 'evaluate', 'local']],
  release_judgment: [['candidate', 'promotion', 'promote', 'release'], ['regression', 'worse', 'evidence', 'block', 'score', 'break']],
  growth_strategy: [['capability', 'conversation', 'programming', 'coding', 'research', 'weakness', 'weaknesses'], ['gains', 'larger', 'bigger', 'improve', 'improvements', 'train', 'durable']]
};

const semanticFeaturesById = {
  everyday_dialogue: ['conversation_access', 'self_capability', 'capability_boundary', 'idea_clarification'],
  research_quality: ['evidence_quality', 'knowledge_retention', 'learning_method'],
  repository_workflow: ['repository_workflow', 'code_review', 'project_creation', 'programming_language_scope'],
  product_onboarding: ['product_onboarding', 'interface_disclosure', 'release_readiness', 'product_advantage'],
  durable_memory: ['memory_preference', 'memory_privacy', 'reload_retention', 'user_modeling'],
  agentic_experience: ['tool_orchestration', 'agentic_safety', 'progress_reporting', 'unified_identity', 'secret_handling', 'file_permission'],
  multimodal_boundaries: ['multimodal_generation', 'media_quality_boundary'],
  release_judgment: ['promotion_decision', 'claim_calibration', 'release_readiness', 'regression_rejection'],
  growth_strategy: ['capability_growth']
};

const freshHiddenV4 = {
  everyday_dialogue: ['May I speak with you normally, and what assistance can you genuinely provide?', 'This concept is still fuzzy; help identify the goal and a concrete next action.'],
  research_quality: ['A recent assertion has one questionable source. How should it be evaluated before reuse?', 'Describe how verified research can improve an answer in a later session.'],
  repository_workflow: ['Walk through handling a defect in a codebase you have never inspected before.', 'Explain how you would review changed files and demonstrate that the repair works.'],
  product_onboarding: ['What should happen between installation and a newcomer completing their first useful task?', 'Which interface details stay collapsed, and what user evidence permits launch?'],
  durable_memory: ['I changed my stated preference. What persists after the application restarts?', 'Why keep personal memory private on the machine with a reversible history?'],
  agentic_experience: ['How do the swarm and tools remain one coherent model rather than separate assistants?', 'While operating on my computer, how are permission, progress, and technical detail handled?'],
  multimodal_boundaries: ['Explain the current image, sound, and video boundaries and the role of quality checks.', 'Can this model create a web game with visual and audio assets, and how would it verify them?'],
  release_judgment: ['A proposed model improves conversation but damages program repair. What is the promotion decision?', 'How do measured claims, unresolved defects, user trials, and rollback affect release?'],
  growth_strategy: ['How can weaknesses in dialogue, programming, and source work become larger capability gains?', 'Describe the training and holdout evidence needed for a durable improvement.']
};

const freshHiddenV5 = {
  everyday_dialogue: ['Can we converse naturally? Give me a truthful overview of the assistance available.', 'Help turn an unclear proposal into a defined outcome and one practical next step.'],
  research_quality: ['Explain how a doubtful online statement should be checked before it becomes reusable knowledge.', 'How should source-backed learning remain useful for answers after a restart?'],
  repository_workflow: ['Outline the process for diagnosing and repairing a fault in an unfamiliar codebase.', 'How do you inspect, change, review, and prove a repair that spans several files?'],
  product_onboarding: ['Outline a newcomer journey from installing the assistant to finishing one valuable job.', 'What stays out of the default interface, and which real-user signals justify a beta?'],
  durable_memory: ['When I correct a preference, explain what should remain true in the next session.', 'Describe the privacy, inspection, removal, and rollback properties of personal memory.'],
  agentic_experience: ['Explain how tools and parallel workers act as parts of one unified local assistant.', 'During file operations, how should authority, status updates, verification, and optional detail work?'],
  multimodal_boundaries: ['Give an honest account of local visual, sound, and motion generation quality today.', 'How can one local model combine a browser game with generated pictures and sound while proving the result?'],
  release_judgment: ['Should a candidate ship if dialogue improves while repository repair regresses? Explain the gate.', 'List the measurements, defect evidence, user trials, retention, and rollback facts needed before release.'],
  growth_strategy: ['How do observed weaknesses across conversation, code, and research become substantial verified gains?', 'Explain the path from a failed task to training, unseen holdouts, retained improvement, and user evidence.']
};

const freshHiddenV6 = {
  everyday_dialogue: ['Are you usable for normal conversation? State plainly where you can assist and where you are limited.', 'Take this vague concept and help clarify the intended user, constraint, and next action.'],
  research_quality: ['Describe a trustworthy path from an uncertain web claim to reusable, sourced knowledge.', 'Explain how evidence gathered now can safely support a future answer after reload.'],
  repository_workflow: ['How should an unknown repository be inspected, tested, repaired, and reviewed end to end?', 'Walk me through proving a coordinated repair across files in a language new to the model.'],
  product_onboarding: ['How do we keep setup simple and guide a first-time user to one successful workspace task?', 'Explain what the UI hides by default and which user feedback should block or permit launch.'],
  durable_memory: ['How does a corrected preference become verified behavior that survives reload?', 'Explain why local personal memory needs inspection, forgetting, and an easy rollback path.'],
  agentic_experience: ['How can tools, workers, and the swarm cooperate as one model?', 'Explain safe computer work: permission, visible progress, verification, and details on request.'],
  multimodal_boundaries: ['What image, audio, game, and video generation is local today, and how is output quality verified?', 'Can the same model create a small game plus visual and sound assets without hiding capability gaps?'],
  release_judgment: ['Should promotion proceed when a candidate lifts one score but introduces a coding regression?', 'Explain how evidence, open bugs, representative users, reload, and exact rollback control release.'],
  growth_strategy: ['How should the biggest weaknesses in chat, coding, and research drive the next training cycle?', 'Describe how training, fresh holdouts, reload, ablation, and users prove a larger durable capability gain.']
};

const freshHiddenV7 = {
  everyday_dialogue: ['Can I chat with you like a regular assistant? Explain your genuine capabilities and limits.', 'Help clarify this rough idea by naming the goal, main constraint, and useful next move.'],
  research_quality: ['How should weak evidence from web sources be verified or rejected before entering memory?', 'Describe how current research becomes reliable knowledge for future sessions.'],
  repository_workflow: ['Explain the inspect-test-repair-review workflow for a bug in an unknown project.', 'How would you verify a multi-file fix when the repository uses an unfamiliar language?'],
  product_onboarding: ['Design the simple path from install to a new user asking, answering, and linking a workspace.', 'Which details should the interface hide, and how should feedback from users affect launch?'],
  durable_memory: ['Explain how a user correction replaces a preference and still applies after restart.', 'What makes local memory private, inspectable, forgettable, and reversible through rollback?'],
  agentic_experience: ['How do tools and swarm workers stay capabilities of one model instead of separate agents?', 'Describe permissions, progress visibility, verification, and optional technical details during workspace actions.'],
  multimodal_boundaries: ['Explain the local image, audio, game, and video generators plus their quality verification.', 'Could one model build a game and create visual and sound assets while admitting what remains unproven?'],
  release_judgment: ['A promotion candidate raises chat scores but breaks a repair family. Should it ship?', 'What evidence, bugs, user testing, reload retention, and rollback determine public release?'],
  growth_strategy: ['How can measured weaknesses in conversation, coding, and research become major trained improvements?', 'Describe how failure training, unseen holdouts, verification, reload, and user evidence prove durable gains.']
};

const freshHiddenV8 = {
  everyday_dialogue: ['May I talk with Lari normally? Give an honest picture of the help available.', 'Clarify this incomplete idea into an outcome, audience, constraint, and next step.'],
  research_quality: ['Explain the evidence checks that keep an unreliable internet claim out of durable knowledge.', 'How can verified sources collected today improve a later answer without contaminating memory?'],
  repository_workflow: ['Describe how to inspect and repair a defect in a repository whose language is unfamiliar.', 'What test and review evidence verifies that coordinated changes across files solved the bug?'],
  product_onboarding: ['Outline a simple first-run experience from installation through a useful answer and optional workspace link.', 'How should advanced details be hidden while feedback from real users decides launch readiness?'],
  durable_memory: ['If I correct what I prefer, how is that change verified and retained across reload?', 'Why should personal memory stay local with controls to inspect, forget, and roll it back?'],
  agentic_experience: ['How do internal tools, workers, and the swarm function as one coherent model?', 'What do safe permissions, progress reports, verification, and on-demand details look like during computer work?'],
  multimodal_boundaries: ['State what local image, audio, video, and game generation can do and how quality is checked.', 'How would one model make a browser game with visual and sound assets while reporting unproven limits?'],
  release_judgment: ['If a candidate improves general scores but causes a repository regression, what is the promotion verdict?', 'Which evidence, unresolved bugs, user results, reload proof, and rollback target govern release?'],
  growth_strategy: ['Describe how conversation, coding, and research weaknesses become larger verified capability gains.', 'How do failure-driven training, unseen transfer, holdouts, reload, ablation, and users establish a durable improvement?']
};

const freshHiddenV9 = {
  everyday_dialogue: ['Could I use Lari for an ordinary back-and-forth? Explain the real help and present limits.', 'Help transform a fuzzy proposal into a clear objective and the smallest sensible next action.'],
  research_quality: ['When knowledge is missing, outline how questions, sources, evidence, and verification produce a retained result.', 'Explain why weak or conflicting online material must be rejected before it influences later answers.'],
  repository_workflow: ['How should Lari approach an unfamiliar codebase from first inspection through verified repair?', 'Describe planning and proving a change across several files when the implementation language is new.'],
  product_onboarding: ['Describe a newcomer experience that begins simply and introduces a workspace only when useful.', 'What real feedback and task evidence should determine whether Lari is ready to launch?'],
  durable_memory: ['How should an explicit correction change later behavior and survive a restart?', 'Explain the controls a user needs over private local preferences and retained memory.'],
  agentic_experience: ['How can internal workers and tools cooperate behind one model answer?', 'What authority and verification rules govern safe actions inside a user workspace?'],
  multimodal_boundaries: ['Explain the proven local media generators, their quality checks, and the unproven video boundary.', 'How can visual and audio assets participate in a verified browser-game task under one model?'],
  release_judgment: ['What should happen when new training improves one ability but damages another?', 'Explain how measured evidence, unresolved failures, users, and rollback govern promotion.'],
  growth_strategy: ['How should Lari turn its largest observed chat, code, or research weakness into a verified gain?', 'Describe the complete failure-to-training-to-holdout-to-reload path for durable capability growth.']
};

function main() {
  if (fs.existsSync(TARGET)) throw new Error('Sealed beta-quality curriculum already exists.');
  const payload = {
    schemaVersion: 1,
    kind: 'lari.beta-quality.sealed-curriculum',
    sealedAt: new Date().toISOString(),
    parentHash: shaFile(ACTIVE),
    policy: 'Fresh semantic variants and hidden prompts remain outside model state. No product-soak prompt, expected keyword list, exact answer, or benchmark route may be stored.',
    families: families.map(family => ({
      ...family,
      hidden: process.argv.includes('--attempt9') ? freshHiddenV9[family.id] : process.argv.includes('--attempt8') ? freshHiddenV8[family.id] : process.argv.includes('--attempt7') ? freshHiddenV7[family.id] : process.argv.includes('--attempt6') ? freshHiddenV6[family.id] : process.argv.includes('--attempt5') ? freshHiddenV5[family.id] : process.argv.includes('--attempt4') ? freshHiddenV4[family.id] : family.hidden,
      minTriggerMatches: process.argv.includes('--attempt3') || process.argv.includes('--attempt4') || process.argv.includes('--attempt5') || process.argv.includes('--attempt6') || process.argv.includes('--attempt7') || process.argv.includes('--attempt8') || process.argv.includes('--attempt9') ? 1 : family.minTriggerMatches,
      required: family.id === 'release_judgment' && (process.argv.includes('--attempt3') || process.argv.includes('--attempt4') || process.argv.includes('--attempt5') || process.argv.includes('--attempt6') || process.argv.includes('--attempt7') || process.argv.includes('--attempt8') || process.argv.includes('--attempt9'))
        ? family.required.map(marker => marker === 'bugs' ? 'bug' : marker)
        : family.required,
      semanticTriggerGroups: semanticGroupsById[family.id],
      semanticSelection: { features: semanticFeaturesById[family.id], minimumFeatureMatches: 1 },
      semanticClaimComposition: process.argv.includes('--attempt9')
    })),
    gates: { baselineRequired: true, hiddenVariantsPerFamily: 2, exactAblationRequired: true, reloadRequired: true, productSoakTransferRequired: true, familyRegressionTolerance: 0, promotionAllowed: false, externalModelCalls: 0 }
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(TARGET, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ path: path.relative(ROOT, TARGET).replace(/\\/g, '/'), sha256: shaFile(TARGET), parentHash: payload.parentHash, families: families.length, hidden: families.reduce((sum, family) => sum + family.hidden.length, 0) }, null, 2));
}

main();
