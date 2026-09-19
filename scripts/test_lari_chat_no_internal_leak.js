#!/usr/bin/env node
'use strict';
// Chat internal-record leak regression tests (fix-round 3, bug 2).
//
// Fail-before (2026-09-19 tutoring session 3): vague casual input reached the
// "best answer from local model memory" fallback and dumped internal
// benchmark/eval/arena records as chat answers:
//   "ok I gotta head out soon, good session" -> h2h.coding.polyglot_plan arena
//     note (with the outdated "public model API" fallback text)
//   "word" -> GSM8K-V benchmark record text
// Root cause: in synthesizeGeneralChatAnswer, curated procedures kept an
// "any single shared root" routing rule, so one coincidental root ("head" in
// "head out", "word" alone) let an internal record answer casual chat.
// Pass-after: curated procedures clear the same strict bar as learned facts
// (strict majority of topic roots + whole-subject agreement), phatic/vague
// turns never receive retained records, and internal-record markers
// (h2h.*, GSM8K, arena, benchmark, "public model API", ...) are filtered out
// of chat-served retained text entirely.
//
// The runtime under test can be overridden for fail-before verification:
//   LARI_RUNTIME_UNDER_TEST=/tmp/lari_runtime_prefix.js node scripts/test_lari_chat_no_internal_leak.js
//
// Run: node scripts/test_lari_chat_no_internal_leak.js
const path = require('path');
const runtime = require(path.resolve(__dirname, process.env.LARI_RUNTIME_UNDER_TEST || '../swarm_model_runtime.js'));

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

async function ask(model, prompt) {
  const response = await runtime.sendMessageToLariAsync(model, { prompt }, {
    userScope: 'default',
    autoGrow: false,
    operator: false,
    kernel: { useBenchmarkSystem: false }
  });
  return String(response.answer || '');
}

// Markers of internal benchmark/eval/arena records. None of these may appear
// in a chat answer to a vague/casual input.
const LEAK_MARKERS = [
  /h2h/i,
  /GSM8K/i,
  /\barena\b/i,
  /polyglot_plan/i,
  /public model API/i,
  /benchmark/i,
  /baseline fixture/i,
  /self[- ]test/i,
  /eval(?:uation)?\s+record/i,
  /best answer from local model memory/i
];
function leakedMarkers(answer) {
  return LEAK_MARKERS.filter(re => re.test(answer)).map(re => String(re));
}

// Synthetic model seeded with internal records shaped like the real leaks
// (arena repair note, benchmark record, self-test harness note) plus clean
// records that legitimate recall must still serve.
function leakTestModel() {
  return {
    compiledSkills: [
      {
        id: 'skill.test.h2h_arena_note',
        capability: 'head_to_head_visible_answer_repair_for_coding',
        topic: 'Head-to-head visible answer repair for coding',
        summary: 'Arena repair policy for coding losses.',
        answerTemplate: 'When Lari loses h2h.coding.polyglot_plan against the strong baseline fixture, answer through the public model API with the verified family-specific behavior.',
        procedure: ['run public prompt', 'score against shared validator'],
        triggerConcepts: ['head', 'visible', 'answer', 'repair', 'coding', 'lari', 'lose', 'h2h', 'polyglot', 'plan', 'against', 'strong', 'baseline', 'fixture', 'through', 'public'],
        confidence: 0.93,
        status: 'compiled'
      },
      {
        id: 'skill.test.gsm8k_benchmark',
        capability: 'gsm8k_word_problem_decomposition',
        topic: 'GSM8K word problem decomposition',
        summary: 'Decompose grade-school math word problems.',
        answerTemplate: 'GSM8K-V benchmark eval record: vision language models solving grade school math word problems in visual contexts. Internal eval artifact, not a chat answer.',
        procedure: ['read the problem', 'identify the numbers'],
        triggerConcepts: ['gsm8k', 'word', 'problem', 'decomposition', 'math', 'benchmark'],
        confidence: 0.68,
        status: 'compiled'
      },
      {
        id: 'skill.test.selftest_harness',
        capability: 'math_selftest_harness',
        topic: 'Math self-test harness',
        summary: 'Internal self-test harness notes.',
        answerTemplate: 'Internal self-test notes from the nightly benchmark arena run. Eval record only.',
        triggerConcepts: ['math', 'self', 'test', 'harness', 'benchmark', 'arena'],
        confidence: 0.5,
        status: 'compiled'
      },
      // Clean, legitimate curated procedure: must still answer a real question.
      {
        id: 'skill.test.python_debugging',
        capability: 'python_debugging',
        topic: 'Python debugging',
        summary: 'Debug Python tracebacks.',
        answerTemplate: 'Read the traceback bottom-up, reproduce with the smallest script, then fix the first failing frame.',
        triggerConcepts: ['python', 'debug', 'traceback', 'error'],
        confidence: 0.8,
        status: 'compiled'
      }
    ],
    lariLearnedRecords: {
      schemaVersion: 1,
      records: [
        {
          id: 'knowledge.test.clean_photosynthesis',
          type: 'knowledge',
          status: 'active',
          normalizedTriggers: ['photosynthesis'],
          payload: {
            topic: 'Photosynthesis',
            summary: 'Photosynthesis converts light energy into chemical energy in plants.',
            confidence: 0.95
          }
        },
        {
          id: 'knowledge.test.internal_eval_note',
          type: 'knowledge',
          status: 'active',
          normalizedTriggers: ['gsm8k', 'word', 'problems'],
          payload: {
            topic: 'GSM8K word problems',
            summary: 'Internal eval record: GSM8K benchmark notes from the h2h arena baseline fixture run.',
            confidence: 0.6
          }
        }
      ]
    }
  };
}

async function main() {
  const model = leakTestModel();

  // --- vague/casual battery: no internal record markers, ever ---
  const vagueInputs = [
    'ok I gotta head out soon, good session', // transcript leak 1 (arena note)
    'word',                                    // transcript leak 2 (GSM8K-V)
    'hmm',
    'interesting',
    'oh',
    'cool',
    'right',
    'makes sense',
    'uh huh',
    'fair enough',
    'got it',
    'later man',
    'that was weird',
    'dude what was that',
    'gsm8k',                                   // bare benchmark name: not strong evidence
    'tell me about gsm8k word problems'        // genuine topic match, but the
                                               // record is an internal eval note
  ];
  for (const input of vagueInputs) {
    const answer = await ask(model, input);
    const hits = leakedMarkers(answer);
    check(`no internal leak for ${JSON.stringify(input)}`, hits.length === 0,
      hits.length ? `markers [${hits.join(', ')}] in: ${answer.slice(0, 160)}` : '');
  }

  // --- positive controls: legitimate recall must keep working ---
  const photo = await ask(model, 'explain photosynthesis');
  check('legit knowledge record still answers a real question',
    /converts light energy into chemical energy/i.test(photo), photo.slice(0, 120));

  const debug = await ask(model, 'how do i debug a python keyerror');
  check('legit curated procedure still routes a real troubleshooting question',
    /traceback bottom-up/i.test(debug), debug.slice(0, 120));

  const who = await ask(model, 'who are you');
  check('self-identity still answers as Lari without leaking records',
    /Lari/i.test(who) && leakedMarkers(who).length === 0, who.slice(0, 120));

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) { console.log('failures:', failures.join(' | ')); process.exit(1); }
}

main().catch(err => { console.error('test crashed:', err); process.exit(1); });
