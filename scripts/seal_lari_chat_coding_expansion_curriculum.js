#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'chat-coding-expansion-20260829');
const PARENT_HASH = '7d3b16aabeca3848d3e7b668667311ae85f2e1e99a3ec6b65ede850e08715c0a';
const PARENT = path.join(ROOT, 'consolidation', 'conversational-learning-binding-20260829', 'candidates', `${PARENT_HASH}.json`);
const DEST = path.join(OUT, 'sealed-curriculum.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
if (fs.existsSync(DEST)) throw new Error('Expansion curriculum is already sealed.');
if (sha(fs.readFileSync(PARENT)) !== PARENT_HASH) throw new Error('Parent candidate is missing or changed.');
const chat = [
  { id: 'explanation_ladder', kind: 'explanation_ladder', intents: ['explanation'], triggers: ['explain','simple','example','deeper','understand'], train: 'Explain event loops simply, then give me the mechanism and a concrete example.', hidden: 'Help me understand database transactions at three levels: short version, how it works, and an example.', required: ['Short version:', 'Mechanism:', 'Example:'] },
  { id: 'assumption_audit', kind: 'assumption_audit', intents: ['planning','explanation'], triggers: ['assumption','assuming','unknown','validate','premise'], train: 'Audit the assumptions behind this launch plan before we commit.', hidden: 'What are we assuming about this migration, and how would we test those assumptions?', required: ['Assumption audit:', 'Evidence check:', 'First test:'] },
  { id: 'comparison_matrix', kind: 'comparison_matrix', intents: ['comparison'], triggers: ['compare','versus','tradeoff','criteria','option'], train: 'Compare rebuilding versus incremental refactoring using a clear decision matrix.', hidden: 'Show me the tradeoffs between queues and event streams as a compact matrix.', required: ['Criterion', 'Option A', 'Option B'] },
  { id: 'critique_and_repair', kind: 'critique_and_repair', intents: ['explanation','open_chat'], triggers: ['critique','review','weak','improve','repair'], train: 'Critique this proposal and tell me exactly how to improve it.', hidden: 'Review this approach for weak points and propose repairs.', required: ['What works:', 'Weak point:', 'Repair:'] },
  { id: 'retrospective', kind: 'retrospective', intents: ['open_chat','planning'], triggers: ['retrospective','went','learned','repeat','improve'], train: 'Run a retrospective on what went well, what failed, and what we should change next time.', hidden: 'Help me learn from this attempt: what worked, what did not, and what changes now?', required: ['Keep:', 'Change:', 'Next experiment:'] },
  { id: 'idea_expansion', kind: 'idea_expansion', intents: ['open_chat','planning'], triggers: ['brainstorm','ideas','expand','directions','possibilities'], train: 'Brainstorm several distinct ways we could improve onboarding.', hidden: 'Expand this product idea into a few genuinely different directions.', required: ['Conservative:', 'Adjacent:', 'Bold:'] },
  { id: 'status_synthesis', kind: 'status_synthesis', intents: ['open_chat','planning'], triggers: ['status','progress','done','blocked','next'], train: 'Give me a clean status update: completed, evidence, blockers, and next step.', hidden: 'Where do we stand? Separate what is finished, what is proven, what is blocked, and what comes next.', required: ['Completed:', 'Evidence:', 'Blocked:', 'Next:'] },
  { id: 'question_decomposition', kind: 'question_decomposition', intents: ['explanation','planning'], triggers: ['break','question','subquestions','investigate','decompose'], train: 'Break this hard question into the smaller questions we need to answer.', hidden: 'Decompose this problem into a sequence of answerable investigations.', required: ['Core question:', 'Subquestions:', 'Decision point:'] }
];
const languages = [
  ['javascript','JavaScript',['.js','.cjs','.mjs'],'node'], ['typescript','TypeScript',['.ts','.tsx'],'typescript'],
  ['python','Python',['.py'],'python'], ['ruby','Ruby',['.rb'],'ruby'], ['go','Go',['.go'],'go'],
  ['rust','Rust',['.rs'],'cargo'], ['csharp','C#',['.cs','.csproj'],'dotnet'],
  ['java','Java',['.java'],'java'], ['php','PHP',['.php'],'php']
].map(([id,label,extensions,runner]) => ({ id,label,extensions,runner }));
const body = { schemaVersion: 1, kind: 'lari.chat-coding-expansion.sealed-curriculum', sealedAt: new Date().toISOString(), parentHash: PARENT_HASH, chat, coding: { languages, requiredRepairFamilies: ['parser_validator','config_defaults','inventory_totals','text_pipeline','async_pipeline','checkout_totals'], minimumExecutableCases: 66, minimumLanguages: 9, suppliedLanguageForbidden: true, suppliedRepairKindForbidden: true, failBeforePassAfterRequired: true, reloadRequired: true }, forbidden: ['exact prompt route locks','expected answer storage','external model inference','production mutation','benchmark metadata in learned records'] };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(DEST, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ sealed: path.relative(ROOT, DEST).replace(/\\/g,'/'), sha256: sha(fs.readFileSync(DEST)), chatFamilies: chat.length, languages: languages.length, codingCases: 66 }, null, 2));
