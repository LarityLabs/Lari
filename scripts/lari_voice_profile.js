#!/usr/bin/env node
/**
 * Lari voice profile (chat generator v2): ONE blended personality expressed
 * as MEASURABLE text-feature preferences, not string transforms.
 *
 * The 31 giants in scripts/lari_giants*.js inform the blend (names and voice
 * descriptions only; the lens transform functions are dead and are never
 * called here). The blend resolves to a single voice: plainspoken and warm,
 * concrete everyday words, rhythmic but not sing-song, occasional dry wit,
 * zero purple prose, zero sycophancy.
 *
 * Every feature is a deterministic function text -> { score (0..1), detail }.
 * voiceScore(text) is the weighted blend used by the chat generator's
 * scorer. No external model calls, no network, no em dashes in output.
 */
'use strict';

const STOPWORDS = new Set(String(
  'a,an,the,of,and,or,to,in,on,for,with,about,as,at,by,from,is,are,was,were,be,been,' +
  'it,its,this,that,these,those,what,which,who,whom,whose,how,when,where,why,do,does,' +
  'did,can,could,should,would,will,shall,may,might,must,you,your,he,she,they,them,his,' +
  'her,their,our,we,i,me,my,us,not,no,yes,if,then,than,so,such,very,more,most,less,' +
  'least,into,out,over,under,between,through,during,before,after,above,below,up,down,' +
  'there,here,when,while,again,once,also,just,only,own,same,too'
).split(','));

function sentences(text) {
  const parts = String(text || '').match(/[^.!?]+[.!?]+["']?/g) || [];
  const out = parts.map(p => p.trim()).filter(Boolean);
  const rest = String(text || '').replace(/[^.!?]+[.!?]+["']?/g, '').trim();
  if (rest) out.push(rest);
  return out.length ? out : [String(text || '').trim()].filter(Boolean);
}

function words(text) {
  return (String(text || '').toLowerCase().match(/[a-z][a-z']*/g) || []);
}

function contentWords(text) {
  const seen = new Set();
  const out = [];
  for (const w of words(text)) {
    if (w.length >= 3 && !STOPWORDS.has(w) && !seen.has(w)) { seen.add(w); out.push(w); }
  }
  return out;
}

const CONTRACTIONS = /\b(don't|can't|won't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|doesn't|didn't|wouldn't|couldn't|shouldn't|it's|i'm|you're|he's|she's|we're|they're|that's|there's|what's|let's|i've|you've|we've|i'll|you'll|he'll|she'll|it'll|we'll|they'll|i'd|you'd|he'd|she'd|we'd|they'd|mustn't|needn't)\b/i;
const SYCOPHANCY = /great question|i'd be happy to|happy to help|as an ai\b|as a language model|certainly!/i;
const PURPLE = /\b(delve|tapestry|luminous|effervescent|embark|nestled|realm\b|game-changer|deep dive|secret sauce|vibrant|bustling|testament to|furthermore|moreover|additionally|utilize|utilizing|leverage\b|in today's|fast-paced|cutting-edge|seamless|holistic|synergy|paradigm)\b/i;
const HEDGES = /\b(maybe|perhaps|possibly|sort of|kind of|it seems|as far as i know|i guess)\b/gi;

function featureSentenceLength(text) {
  const sents = sentences(text);
  const counts = sents.map(s => words(s).length).filter(n => n > 0);
  if (!counts.length) return { score: 0, detail: 'no words' };
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const max = Math.max(...counts);
  let score;
  if (avg >= 8 && avg <= 22) score = 1;
  else if (avg < 8) score = Math.max(0.15, avg / 8);
  else score = Math.max(0, 1 - (avg - 22) / 18);
  if (max > 40) score *= 0.7;
  return { score: round2(score), detail: `avg ${avg.toFixed(1)} words/sentence over ${counts.length} sentences` };
}

function featureWordSimplicity(text) {
  const ws = words(text);
  if (!ws.length) return { score: 0, detail: 'no words' };
  const long = ws.filter(w => w.length >= 10).length;
  const density = long / ws.length;
  const score = Math.max(0, 1 - density * 4);
  return { score: round2(score), detail: `${long}/${ws.length} long words` };
}

function featureRhythmVariety(text) {
  const counts = sentences(text).map(s => words(s).length).filter(n => n > 0);
  if (counts.length < 2) return { score: 0.5, detail: 'single sentence, neutral' };
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  if (mean === 0) return { score: 0.5, detail: 'neutral' };
  const variance = counts.reduce((a, n) => a + (n - mean) * (n - mean), 0) / counts.length;
  const cv = Math.sqrt(variance) / mean;
  const score = Math.min(1, cv * 2);
  return { score: round2(score), detail: `cv ${cv.toFixed(2)}` };
}

function featurePlainspoken(text) {
  if (SYCOPHANCY.test(text)) return { score: 0.2, detail: 'sycophancy marker found' };
  const hits = (String(text).match(new RegExp(CONTRACTIONS.source, 'gi')) || []).length;
  if (hits >= 1) return { score: 1, detail: `${hits} contraction(s)` };
  return { score: 0.55, detail: 'no contractions, neutral' };
}

function featurePurplePenalty(text) {
  const hits = (String(text).match(new RegExp(PURPLE.source, 'gi')) || []).length;
  const score = Math.max(0, 1 - hits * 0.4);
  return { score: round2(score), detail: hits ? `${hits} purple marker(s)` : 'clean' };
}

function featureDirectness(text) {
  const hedges = (String(text).match(HEDGES) || []).length;
  const score = Math.max(0, 1 - hedges * 0.25);
  return { score: round2(score), detail: hedges ? `${hedges} hedge(s)` : 'direct' };
}

function round2(n) { return Math.round(n * 100) / 100; }

const WEIGHTS = {
  sentenceLength: 0.20,
  wordSimplicity: 0.20,
  rhythmVariety: 0.10,
  plainspoken: 0.15,
  purplePenalty: 0.20,
  directness: 0.15
};

function breakdown(text) {
  return {
    sentenceLength: featureSentenceLength(text),
    wordSimplicity: featureWordSimplicity(text),
    rhythmVariety: featureRhythmVariety(text),
    plainspoken: featurePlainspoken(text),
    purplePenalty: featurePurplePenalty(text),
    directness: featureDirectness(text)
  };
}

/**
 * Single blended voice score 0..1. Short replies (<=6 words) skip sentence
 * metrics, which are meaningless at that length; they are judged only on
 * plainspoken/purple/directness so brevity is never punished.
 */
function voiceScore(text) {
  const t = String(text || '').trim();
  if (!t) return { score: 0, breakdown: {}, note: 'empty' };
  const wc = words(t).length;
  const b = breakdown(t);
  let score;
  if (wc <= 6) {
    score = (b.plainspoken.score + b.purplePenalty.score + b.directness.score) / 3;
    return { score: round2(score), breakdown: b, note: 'short reply, brevity not punished' };
  }
  score = Object.keys(WEIGHTS).reduce((acc, k) => acc + WEIGHTS[k] * b[k].score, 0);
  return { score: round2(score), breakdown: b, note: 'full profile' };
}

function describe() {
  return 'Lari voice: plainspoken and warm, concrete everyday words, 8-22 word ' +
    'sentences with rhythmic variety, contractions over stiffness, occasional ' +
    'dry wit, no purple prose, no sycophancy, no hedge-stacking. Blended from ' +
    '31 giants (names and voice descriptions only; lens transforms unused).';
}

module.exports = {
  sentences, words, contentWords,
  featureSentenceLength, featureWordSimplicity, featureRhythmVariety,
  featurePlainspoken, featurePurplePenalty, featureDirectness,
  voiceScore, describe, WEIGHTS
};

if (require.main === module) {
  const samples = [
    'Hey. Good to see you. What are we getting into?',
    'I do not have enough grounded local knowledge to answer that honestly.',
    'Great question! I would be happy to help you delve into the luminous tapestry of possibilities.'
  ];
  for (const s of samples) {
    const v = voiceScore(s);
    console.log(`score ${v.score} (${v.note}): ${s.slice(0, 60)}`);
  }
}
