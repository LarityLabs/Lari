/**
 * Tests for the discourse miner LEARNING behavior (the middle ground between
 * junk and nothing):
 *   - a scripted conversation with corrections, recoveries, and repeated
 *     successes produces >= 1 induction (success operators listed);
 *   - instruction corrections ("just say X") complete pairs immediately;
 *   - junk pairs (new unrelated question right after a correction) are
 *     STILL rejected.
 *
 * Run: node scripts/test_lari_miner_learning.js
 */
'use strict';

const miner = require('../swarm_discourse_miner.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function stubBindings() {
  return {
    induceFromFailures: (model, pairs, options) => ({ learned: true, record: { id: 'proc.learn', provenance: {} } }),
    discourseGoalOf: () => null,
    classifyIntent: () => 'open_chat',
    routeProcedure: () => ({ record: { id: 'proc.learn' } }),
    getEpisodes: () => []
  };
}

function turn(userMessage, lariAnswer = 'ok', intent = 'open_chat') {
  return { userMessage, lariAnswer, intent, confidence: 0.8, userScope: 'default' };
}

function drive(turns) {
  const m = {};
  const b = stubBindings();
  const reports = turns.map(t => miner.noteTurn(m, turn(t.user, t.answer), b));
  return { model: m, state: m.lariDiscourseMiner, reports };
}

// --- repeated success induces a discourse operator ---
{
  const { state } = drive([
    { user: 'tell me a joke', answer: 'Why do Java developers wear glasses? Because they do not C#.' },
    { user: 'tell me a joke', answer: 'Why do Java developers wear glasses? Because they do not C#.' },
    { user: 'tell me a joke', answer: 'Why do Java developers wear glasses? Because they do not C#.' },
  ]);
  check('repeated success induces >= 1 operator', state.successOperators.length >= 1, state.successOperators.length);
  const op = state.successOperators[0];
  check('operator targets the repeated stimulus', op && op.stimulusKey === 'tell me a joke', op && op.stimulusKey);
  check('operator carries the repeated response', op && /java developers/i.test(op.responseExample), op && op.responseExample);
  check('operator evidence count is 3', op && op.evidenceCount === 3, op && op.evidenceCount);
  check('operator id is namespaced', op && /^lari\.learned\.operator\.chat\.success\./.test(op.id), op && op.id);
}

// --- a corrected-then-repeated exchange must NOT induce ---
{
  const { state } = drive([
    { user: 'tell me a joke', answer: 'Why do Java developers wear glasses? Because they do not C#.' },
    { user: 'tell me a joke', answer: 'Why do Java developers wear glasses? Because they do not C#.' },
    { user: 'naw, that joke is stale, tell a different one', answer: 'ok, noted' },
    { user: 'tell me a joke', answer: 'Why do Java developers wear glasses? Because they do not C#.' },
  ]);
  check('correction resets the exemplar (no operator)', state.successOperators.length === 0,
    `operators=${state.successOperators.length}`);
}

// --- instruction correction completes a pair immediately ---
{
  const { state } = drive([
    { user: 'brb', answer: 'I did not quite catch that.' },
    { user: 'naw, brb means be right back. just say "got it"', answer: 'noted' },
  ]);
  check('instruction correction completes a pair', state.pairs.length === 1, state.pairs.length);
  const p = state.pairs[0];
  check('pair prompt is the failed stimulus', p && p.prompt === 'brb', p && p.prompt);
  check('pair corrected answer is the dictated response', p && p.correctedAnswer === 'got it', p && p.correctedAnswer);
  check('pair is marked as instruction-sourced', p && p.via === 'instruction', p && p.via);
}

// --- directive correction detection + instruction extraction ---
{
  const r = miner.detectSignal("when I say thanks just say 'anytime'", null);
  check('directive correction detected', r.signal === 'correction', r.signal);
  const ins = miner.extractInstruction("when I say thanks just say 'anytime'");
  check('instruction stimulus extracted', ins && ins.stimulus === 'thanks', JSON.stringify(ins));
  check('instruction response extracted', ins && ins.response === 'anytime', JSON.stringify(ins));
  check('instruction alternatives split', ins && ins.alternatives.includes('anytime'), JSON.stringify(ins && ins.alternatives));

  const ins2 = miner.extractInstruction("naw, same as the time question. just answer: its Saturday");
  check('colon-form instruction extracted', ins2 && ins2.response === 'its Saturday', JSON.stringify(ins2));

  const ins3 = miner.extractInstruction("naw, wrong. the answer:I built you to be local. say it back in your own words");
  check('say-it-back instruction extracted', ins3 && ins3.response === 'I built you to be local', JSON.stringify(ins3));

  check('vague "just say that" is not an instruction', miner.extractInstruction('just say that') === null);
  check('ordinary correction has no instruction', miner.extractInstruction('not what I meant, I wanted the bird facts') === null);
}

// --- long Greg-style corrections are detected ---
{
  const r = miner.detectSignal(
    'naw man, that was internal benchmark junk leaking into chat, never mention that stuff again, it is completely wrong and off topic for what I asked',
    null);
  check('long leading-rejection correction detected', r.signal === 'correction', `${r.signal} ${r.cues}`);
}

// --- junk pairs are still rejected (negative test) ---
{
  const { state } = drive([
    { user: 'what is a wombat', answer: 'a burrowing marsupial' },
    { user: 'no, that is not what I asked about', answer: 'my mistake' },
    { user: 'tell me about rivers', answer: 'rivers flow to the sea' },
  ]);
  check('junk pair rejected: no pairs', state.pairs.length === 0, `pairs=${state.pairs.length}`);
  check('junk pair rejected: discard audited', state.discardedRecoveries === 1, `discarded=${state.discardedRecoveries}`);
  check('junk pair rejected: no inductions', state.inductions.length === 0, `inductions=${state.inductions.length}`);
}

// --- approval after a correction still completes the pair (regression) ---
{
  const { state } = drive([
    { user: 'what is a goose', answer: 'a bird with a long neck' },
    { user: 'not what I meant, I wanted the bird facts', answer: 'geese mate for life and hiss' },
    { user: 'thanks, perfect', answer: 'anytime' },
  ]);
  check('approval completes the recovery pair', state.pairs.length === 1, state.pairs.length);
  check('approval pair via is approval', state.pairs[0] && state.pairs[0].via === 'approval', state.pairs[0] && state.pairs[0].via);
}

// --- full scripted conversation: >= 1 induction AND junk rejected ---
{
  const { state } = drive([
    { user: 'tell me a joke', answer: 'Why do Java developers wear glasses? Because they do not C#.' },
    { user: 'tell me a joke', answer: 'Why do Java developers wear glasses? Because they do not C#.' },
    { user: 'tell me a joke', answer: 'Why do Java developers wear glasses? Because they do not C#.' },
    { user: 'what is a goose', answer: 'a bird with a long neck' },
    { user: 'not what I meant, I wanted the bird facts', answer: 'geese mate for life and hiss at predators' },
    { user: 'thanks, perfect', answer: 'anytime' },
    { user: 'brb', answer: 'I did not quite catch that.' },
    { user: 'naw, brb means be right back. just say "got it"', answer: 'noted' },
    { user: 'brb', answer: 'got it' },
    // JUNK: new unrelated question right after a correction
    { user: 'what is a wombat', answer: 'a burrowing marsupial' },
    { user: 'no, that is not what I asked about', answer: 'my mistake' },
    { user: 'tell me about rivers', answer: 'rivers flow to the sea' },
    { user: 'bye', answer: 'Later. Try not to break anything while I am gone.' },
    { user: 'bye', answer: 'Later. Try not to break anything while I am gone.' },
    { user: 'bye', answer: 'Later. Try not to break anything while I am gone.' },
  ]);
  check('scripted conversation induces >= 1 operator', state.successOperators.length >= 1,
    `operators=${state.successOperators.length}`);
  const keys = state.successOperators.map(o => o.stimulusKey).sort();
  check('joke and farewell operators induced', keys.includes('tell me a joke') && keys.includes('bye'), keys.join(','));
  check('scripted conversation completes real pairs', state.pairs.length >= 2, `pairs=${state.pairs.length}`);
  const junkPairs = state.pairs.filter(p => /wombat|rivers/i.test(p.prompt + ' ' + p.correctionText));
  check('junk sequence contributes zero pairs', junkPairs.length === 0, `junkPairs=${junkPairs.length}`);
  check('junk discard still audited', state.discardedRecoveries >= 1, `discarded=${state.discardedRecoveries}`);
  const learned = state.inductions.filter(i => i.learned);
  check('inductions recorded as learned', learned.length >= 1, `learned=${learned.length}`);
  console.log('  induced operators:');
  for (const o of state.successOperators) {
    console.log(`    - ${o.id} stimulus="${o.stimulusKey}" evidence=${o.evidenceCount} response="${o.responseExample.slice(0, 60)}"`);
  }
}

console.log(`\n${passed} passed, ${failed} failed${failures.length ? ' — ' + failures.join(', ') : ''}`);
process.exit(failed ? 1 : 0);
