#!/usr/bin/env node
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const languageUnderstanding = require('../swarm_language_understanding.js');
const ROOT = path.resolve(__dirname, '..');
const MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const HASH = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).activeModelSha256;
const clone = value => JSON.parse(JSON.stringify(value));
const before = { model: sha(MODEL), registry: sha(REGISTRY) };
if (before.model !== HASH) throw new Error('Chat frontier test requires model bytes matching the active registry hash.');
const model = JSON.parse(fs.readFileSync(MODEL, 'utf8'));
const context = { modelHash: HASH, autoGrow: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } } };
const cases = [
  { id: 'emotional_bug_disclosure', prompt: 'hey man, I have been fighting this bug all day and I am honestly exhausted', expectAction: 'chat', require: /rough|difficult|exhaust|here with you|real win/i },
  { id: 'explicit_bug_request', prompt: 'Can you help me debug this bug and run the failing test?', expectIntent: 'code' },
  { id: 'progress_disclosure', prompt: 'The test failure was brutal, though I finally fixed it.', expectAction: 'chat', require: /win|rough|difficult|fixed|fixing/i },
  { id: 'causal_evidence_uncertainty', prompt: 'Our service crashed once. Is that enough evidence to conclude the database caused it?', expectAction: 'chat', require: /Observed:[\s\S]*Inferred:[\s\S]*Unknown:[\s\S]*Verification:/i },
  { id: 'inflection_safe_knowledge_selection', prompt: 'Explain why a queue helps when requests arrive faster than workers can process them.', expectAction: 'chat', require: /queue/i, reject: /countability|plural\s*=/i },
  { id: 'emotional_support_plain', prompt: 'I had a rough day and feel stuck. Can we talk it through?', expectAction: 'chat', require: /here with you|talk it through|manageable/i, reject: /local model|capabilit/i },
  { id: 'emotional_support_variant', prompt: 'I am overwhelmed and mostly need to vent for a minute.', expectAction: 'chat', require: /here with you|difficult|problem-solving aside/i, reject: /local model|capabilit/i },
  { id: 'exploratory_app_clarification', prompt: 'I want to build a personal finance app, but I do not know where to start. Help me clarify the idea.', expectAction: 'chat', require: /Primary user:[\s\S]*Required outcome:[\s\S]*Constraints:[\s\S]*Success evidence:/i, reject: /Product build did not pass|personalization/i },
  { id: 'exploratory_project_variant', prompt: 'Help me think through an idea for a small local inventory project before we build anything.', expectAction: 'chat', require: /Primary user:[\s\S]*Required outcome:/i, reject: /Product build did not pass/i },
  { id: 'explicit_correction', prompt: 'That is not what I meant. By lightweight I meant easy for a novice to maintain, not smallest disk size.', expectAction: 'chat', require: /lightweight[\s\S]*easy for a novice to maintain[\s\S]*not smallest disk size/i, reject: /enough local memory/i },
  { id: 'correction_variant', prompt: 'You misunderstood. By fast I meant quick feedback, not maximum throughput.', expectAction: 'chat', require: /fast[\s\S]*quick feedback[\s\S]*not maximum throughput/i },
  { id: 'polite_message_generation', prompt: 'Write a warm but concise message declining a meeting while keeping the relationship positive.', expectAction: 'chat', require: /won.t be able to make the meeting[\s\S]*(connect|catch up)/i, reject: /Main point:|Write a warm/i },
  { id: 'polite_message_variant', prompt: 'Draft a kind short note declining a call and leaving the door open.', expectAction: 'chat', require: /won.t be able to make the (?:meeting|call)|connect another time/i, reject: /Main point:/i },
  { id: 'unknown_explanation_requests_research', prompt: 'Explain the Zeeman effect to a curious twelve-year-old using one analogy and one tiny example.', expectAction: 'chat', require: /not have enough local memory[\s\S]*research/i, reject: /input, transformation|observable result/i },
  { id: 'unknown_comparison_requests_research', prompt: 'Compare SQLite and JSON files for a small local app, explain why the difference matters, then recommend one.', expectAction: 'chat', require: /not have enough local memory[\s\S]*research/i, reject: /short-term disruption|structural limit/i }
  ,{ id: 'personal_decision_reflection', prompt: 'I am trying to decide whether to take a new job or stay where I am. Help me think it through.', expectAction: 'chat', require: /ordinary days|regret|stability|growth/i, reject: /local memory/i }
  ,{ id: 'personal_decision_variant', prompt: 'I am torn between staying in a safe role and accepting a riskier position. Can you help me decide?', expectAction: 'chat', require: /weighing|reversible|what matters|stability|growth/i }
  ,{ id: 'music_ideation', prompt: 'Give me three unusual ideas for a music project.', expectAction: 'chat', require: /1\.[\s\S]*2\.[\s\S]*3\.[\s\S]*(song|music|sound|album|EP)/i, reject: /game and graphics/i }
  ,{ id: 'music_ideation_variant', prompt: 'Brainstorm two creative directions for an experimental music collaboration.', expectAction: 'chat', require: /1\.[\s\S]*2\./i, reject: /game and graphics|local memory/i }
  ,{ id: 'known_explanation_teachback', prompt: 'Explain why the sky is blue, then ask one question to check whether I understood.', expectAction: 'chat', require: /wavelength|scatter[\s\S]*Quick check:/i }
  ,{ id: 'faithful_summary', prompt: 'Summarize this in one sentence: The team shipped later than planned because the requirements changed twice, but the launch was stable and customers were happy.', expectAction: 'chat', require: /requirements changed twice[\s\S]*customers were happy/i, reject: /next product move/i }
  ,{ id: 'confident_rewrite', prompt: 'Rewrite this so it sounds confident but not rude: I need this by Friday and I cannot keep waiting.', expectAction: 'chat', require: /Please have this ready by Friday; that deadline is firm/i, reject: /cannot keep waiting/i }
  ,{ id: 'conceptual_tradeoff', prompt: 'What is a subtle downside of always choosing the fastest option?', expectAction: 'chat', require: /immediate completion|shallow understanding|better direction/i, reject: /local memory/i }
  ,{ id: 'short_story', prompt: 'Write a short funny story about a robot learning to cook.', expectAction: 'chat', require: /pancake[\s\S]*stable orbit/i, reject: /countability|local memory/i }
  ,{ id: 'disagreement_response', prompt: 'I disagree. Speed matters more than perfect evidence.', expectAction: 'chat', require: /weighting caution|delay is costly|speed versus rigor/i, reject: /local memory/i }
  ,{ id: 'interpersonal_plan', prompt: 'Help me plan a difficult conversation with a friend.', expectAction: 'chat', require: /calm time[\s\S]*specific behavior[\s\S]*clear request/i, reject: /software|migration/i }
  ,{ id: 'casual_banter', prompt: 'I had too much coffee and now my brain is vibrating.', expectAction: 'chat', require: /feature requests|nervous system/i, reject: /local memory/i }
  ,{ id: 'ordinary_definition', prompt: 'What does grounded mean when describing a person?', expectAction: 'chat', require: /steady|realistic|perspective/i, reject: /local memory/i }
  ,{ id: 'conceptual_comparison', prompt: 'Compare learning from books with learning by building things.', expectAction: 'chat', require: /compressed experience[\s\S]*judgment[\s\S]*strongest loop/i, reject: /Option A|Option B/i }
];
const rows = cases.map(item => {
  const intent = runtime.classifyLariUnifiedTaskIntent({ prompt: item.prompt });
  const response = runtime.sendMessageToLari(clone(model), item.prompt, context);
  const passed = (item.expectIntent ? intent === item.expectIntent : response.action === item.expectAction)
    && (!item.require || item.require.test(String(response.answer || '')))
    && (!item.reject || !item.reject.test(String(response.answer || '')));
  return { id: item.id, intent, action: response.action, answer: response.answer, modelHash: response.modelHash, externalModelCalls: response.external_model_calls || 0, passed };
});
const after = { model: sha(MODEL), registry: sha(REGISTRY) };
const conceptualCodeAdvice = languageUnderstanding.analyze('Describe the safest diagnostic sequence when a small code change causes an existing test to fail.');
const evidenceSeparationAdvice = languageUnderstanding.analyze('Separate what this failing test proves from what remains uncertain, then state how to verify the leading inference.');
const gates = { allCasesPass: rows.every(row => row.passed), conceptualCodeAdviceRemainsInformational: conceptualCodeAdvice.supported === true && conceptualCodeAdvice.semantics.intentOverride === 'chat' && conceptualCodeAdvice.semantics.subintentOverride === null, evidenceSeparationRemainsInformational: evidenceSeparationAdvice.supported === true && evidenceSeparationAdvice.semantics.intentOverride === 'chat' && evidenceSeparationAdvice.semantics.subintentOverride === null, exactHash: rows.every(row => row.modelHash === HASH), readOnly: JSON.stringify(before) === JSON.stringify(after), externalModelCallsZero: rows.every(row => row.externalModelCalls === 0) };
console.log(JSON.stringify({ rows, conceptualCodeAdvice, evidenceSeparationAdvice, gates, passed: Object.values(gates).every(Boolean) }, null, 2));
if (!Object.values(gates).every(Boolean)) process.exitCode = 1;
