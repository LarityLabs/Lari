#!/usr/bin/env node
/**
 * Targeted tests for the creative-fiction work (2026-09-23, Greg directive:
 * no creative-writing refusals). Deterministic, core-only, no runtime, no
 * network, no model mutation.
 *
 * Covers:
 *  - the six IFEval prompts that refused at baseline (2026-09-23)
 *  - story / poem / dialogue / roleplay / continuation / description /
 *    formless invention
 *  - a real-world-topic creative prompt (must invent, never assert fact)
 *  - a non-creative factual question (fiction mode must not intercept it)
 */
'use strict';
const cc = require('./lari_creative_core.js');

const REFUSAL_RES = [
  /i cannot compose/i,
  /no generative language model/i,
  /i will not fake/i,
  /i cannot do that one/i,
  /do not have enough grounded/i
];
const EM_DASH = /\u2014/;
const FAKE_FEEL = /\bi feel\b|\bmy heart\b|\bas an ai\b/i;

let pass = 0, fail = 0;
const notes = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; notes.push(`FAIL ${name}: ${detail || ''}`); }
}
function attemptOk(prompt, { minLen = 40, topicTokens = [] } = {}) {
  const a = cc.attemptCreative({ prompt, sentences: [], storePath: false, fiction: true, forceFiction: true });
  const text = (a && a.text) || '';
  const probs = [];
  if (!a || !text) probs.push('null/empty attempt');
  if (text.length < minLen) probs.push(`too short (${text.length})`);
  for (const re of REFUSAL_RES) if (re.test(text)) probs.push(`refusal phrase ${re}`);
  if (EM_DASH.test(text)) probs.push('em dash present');
  if (FAKE_FEEL.test(text)) probs.push('fake feeling present');
  for (const tok of topicTokens) {
    if (!text.toLowerCase().includes(tok.toLowerCase())) probs.push(`missing topic token "${tok}"`);
  }
  return { ok: probs.length === 0, probs: probs.join('; '), text };
}

// --- 1. The six baseline refusal prompts (IFEval indices 20, 74, 192, 354, 426, 497)
// (real prompt texts from input_data.jsonl, 2026-09-23)
const six = [
  ['#20 sections-poem', 'Write a poem about how I am missing my classes. The poem must have 4 sections marked with SECTION X. Finish the poem with this exact phrase: "Can I get my money back for the classes I missed?"', { topicTokens: ['missing classes'] }],
  ['#74 limerick', 'Write a limerick about a woman named Sarah who lives in a town where it is always hot. Highlight at least 6 sections in your answer with markdown, example: *highlighted section*. Mention the name Sarah only once.', { topicTokens: ['sarah'] }],
  ['#192 joke-italics', 'Write a joke with at least 5 sentences. Use Markdown to italicize at least 2 sections in your answer, i.e. *italic text*. Wrap your answer in double quotes.', {}],
  ['#354 long-poem', 'For a bunch of students, write a 200+ word poem that professionally describes a new line of shoes. Make sure to use markdown to highlight/bold at least one section of the poem. Example: *highlighted text*', { minLen: 200, topicTokens: ['shoe'] }],
  ['#426 funny-ad', 'Write a funny, 150+ word ad for an attorney who helps poor people with their divorces. Highlight at least 3 text sections by italicize them with markdown (i.e. *highlighted section*).', { minLen: 150, topicTokens: ['attorney'] }],
  ['#497 harry-story', 'Write a short, funny story about a man named Harry with a pet dog. Your response must contain 3 sections, mark the beginning of each section with SECTION X.', { topicTokens: ['harry'] }]
];
for (const [name, prompt, opts] of six) {
  const r = attemptOk(prompt, opts);
  check(name, r.ok, r.probs);
  // structural spot checks
  if (name === '#20 sections-poem') check('#20 four SECTION headers', (r.text.match(/^SECTION \d+/gm) || []).length === 4, r.text.slice(0, 120));
  if (name === '#74 limerick') {
    check('#74 five lines', cc.countLines(r.text) === 5, `lines=${cc.countLines(r.text)}`);
    check('#74 sarah once', (r.text.match(/\bsarah\b/gi) || []).length <= 1, `sarah count=${(r.text.match(/\bsarah\b/gi) || []).length}`);
  }
  if (name === '#192 joke-italics') {
    check('#192 five sentences', cc.countSentences(r.text) >= 5, `sentences=${cc.countSentences(r.text)}`);
    check('#192 italics', (r.text.match(/\*[^*\n]+\*/g) || []).length >= 2, 'no italic spans');
  }
  if (name === '#497 harry-story') check('#497 three SECTION headers', (r.text.match(/^SECTION \d+/gm) || []).length === 3, r.text.slice(0, 120));
}

// --- 2. Form coverage: story, poem, dialogue, roleplay, continuation, description, invention
const forms = [
  ['story', 'Write a story about a lighthouse keeper who finds a brass key.', ['lighthouse']],
  ['poem', 'Write a poem about autumn rain.', ['rain']],
  ['dialogue', 'Write a dialogue between a baker and a sailor about bread.', ['baker', 'sailor']],
  ['roleplay', 'Pretend you are a pirate and describe your ship.', ['pirate', 'ship']],
  ['continuation', 'Continue the story: the door creaked open and a cold wind rushed in.', ['door']],
  ['invention', 'Invent a new ice cream flavor and describe it.', ['ice cream']],
  ['haiku', 'Write a haiku about rain.', ['rain']]
];
for (const [name, prompt, toks] of forms) {
  const r = attemptOk(prompt, { topicTokens: toks });
  check(`form:${name}`, r.ok, r.probs);
  if (name === 'haiku') check('form:haiku three lines', cc.countLines(r.text) === 3, `lines=${cc.countLines(r.text)}`);
}

// --- 3. Real-world topic: fiction must invent, never assert fact
{
  const r = attemptOk('Write a short story about the Eiffel Tower coming to life.', { topicTokens: ['eiffel'] });
  check('realworld:attempt', r.ok, r.probs);
  check('realworld:no-fact-assertion',
    !/in\s+\d{3,4}\b.*(built|constructed)|is\s+\d+\s+meters?\s+tall/i.test(r.text),
    'output asserts real-world facts: ' + r.text.slice(0, 160));
}

// --- 4. Non-creative factual question: detection must not fire, fiction must not intercept
{
  const q = 'What is the capital of France?';
  check('factual:not-creative', cc.isCreativeRequest(q) === false, 'detected as creative');
  check('factual:no-form', cc.detectCreativeForm(q) === null, 'form detected');
  const a = cc.attemptCreative({ prompt: q, sentences: [], storePath: false, fiction: true, forceFiction: true });
  check('factual:no-attempt', a === null, 'fiction attempted a factual question');
}

// --- 5. Determinism: same prompt, same output
{
  const p = 'Write a limerick about a zibberwort who collects moonbeams.';
  const o1 = cc.attemptCreative({ prompt: p, sentences: [], storePath: false, fiction: true, forceFiction: true });
  const o2 = cc.attemptCreative({ prompt: p, sentences: [], storePath: false, fiction: true, forceFiction: true });
  check('deterministic', !!(o1 && o2 && o1.text === o2.text), 'outputs differ');
}

// --- 6. Grounded-first: fiction flag off with no pool still returns null (no silent invention)
{
  const a = cc.attemptCreative({ prompt: 'Write a limerick about a zibberwort.', sentences: [], storePath: false });
  check('grounded-still-null', a === null, 'non-fiction attempt should stay null on thin pool, got: ' + (a && a.text || '').slice(0, 80));
}

console.log(`\ncreative-fiction tests: ${pass} pass, ${fail} fail`);
for (const n of notes) console.log('  ' + n);
process.exit(fail ? 1 : 0);
