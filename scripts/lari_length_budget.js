#!/usr/bin/env node
/**
 * Lari length budget (2026-09-21): parse length demands and expand drafts
 * against them, deterministically, without fabrication.
 *
 * - parseLengthDemand(text): N words (exactly/at least/at most/bare),
 *   N paragraphs, N sentences, N bullet points, N lines.
 * - expandToBudget(sentences, demand, extraPool, opts): up to maxPasses
 *   (default 3) passes adding grounded sentences from extraPool until the
 *   word/sentence demand is met; then trims overshoot for exact/max
 *   demands. Returns { sentences, words, met, passes }.
 *
 * Expansion sources are always grounded (researched sentences, composer
 * pool, deterministic operator recombinations of grounded sentences).
 * Nothing is ever invented to fill a count.
 *
 * No em dashes in user-facing strings.
 */
'use strict';

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100
};

const COUNT_TOKEN = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';

function numberValue(value) {
  const clean = String(value || '').toLowerCase();
  if (/^\d+$/.test(clean)) return Number(clean);
  return NUMBER_WORDS[clean] || 0;
}

function countWords(text) {
  return (String(text || '').match(/\b[\w'-]+\b/g) || []).length;
}

function countSentences(text) {
  return String(text || '').split(/[.!?]+/).filter(s => s.trim()).length;
}

function countParagraphs(text) {
  return String(text || '').split(/\n\s*\n/).filter(s => s.trim()).length;
}

function countLines(text) {
  return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
}

function parseLengthDemand(text) {
  const t = String(text || '');
  const demand = {
    exactWords: 0, minWords: 0, maxWords: 0,
    exactSentences: 0, minSentences: 0, maxSentences: 0,
    paragraphs: 0, bullets: 0, lines: 0
  };
  let m;
  m = t.match(new RegExp(`\\bexactly\\s+(${COUNT_TOKEN})\\s+words?\\b`, 'i'));
  if (m) demand.exactWords = Math.min(2400, numberValue(m[1]));
  m = t.match(new RegExp(`\\b(?:at least|more than|with)\\s+(${COUNT_TOKEN})\\s+words?\\b`, 'i'))
    || t.match(new RegExp(`\\b(${COUNT_TOKEN})\\s*(?:\\+|or more)\\s+words?\\b`, 'i'));
  if (m) demand.minWords = Math.min(2400, numberValue(m[1]));
  m = t.match(new RegExp(`\\b(?:at most|no more than|less than|fewer than|under)\\s+(${COUNT_TOKEN})\\s+words?\\b`, 'i'));
  if (m) demand.maxWords = Math.min(2400, numberValue(m[1]));
  if (!demand.exactWords && !demand.minWords) {
    m = t.match(/\b(\d{2,4})\s+words?\s+(?:essay|summary|article|response|answer|report|long)\b/i)
      || t.match(/\b(\d{2,4})\+?\s+words?\b/i);
    if (m) demand.minWords = Math.min(2400, Number(m[1]));
  }
  m = t.match(new RegExp(`\\bexactly\\s+(${COUNT_TOKEN})\\s+sentences?\\b`, 'i'));
  if (m) demand.exactSentences = numberValue(m[1]);
  m = t.match(new RegExp(`\\b(?:at least|more than)\\s+(${COUNT_TOKEN})\\s+sentences?\\b`, 'i'));
  if (m) demand.minSentences = numberValue(m[1]);
  m = t.match(new RegExp(`\\b(?:at most|no more than|less than|fewer than)\\s+(${COUNT_TOKEN})\\s+sentences?\\b`, 'i'));
  if (m) demand.maxSentences = numberValue(m[1]);
  m = t.match(new RegExp(`\\b(${COUNT_TOKEN})\\s+paragraphs?\\b`, 'i'));
  if (m) demand.paragraphs = numberValue(m[1]);
  m = t.match(new RegExp(`\\b(${COUNT_TOKEN})\\s+bullet(?:\\s+points?)?\\b`, 'i'));
  if (m) demand.bullets = numberValue(m[1]);
  m = t.match(new RegExp(`\\bexactly\\s+(${COUNT_TOKEN})\\s+lines?\\b`, 'i'))
    || t.match(new RegExp(`\\bin\\s+(${COUNT_TOKEN})\\s+lines?\\b`, 'i'));
  if (m) demand.lines = numberValue(m[1]);
  return demand;
}

function normalizeKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Expand a sentence list against a length demand using only grounded extra
 * sentences. Deterministic: extraPool order is the priority order.
 */
function expandToBudget(sentences, demand = {}, extraPool = [], opts = {}) {
  const maxPasses = opts.maxPasses || 3;
  const perPass = opts.perPass || 12;
  const have = (sentences || []).map(s => String(s).trim()).filter(Boolean);
  const seen = new Set(have.map(normalizeKey));
  const extra = (extraPool || []).map(s => String(s).trim()).filter(s => s && !seen.has(normalizeKey(s)));

  const wordTarget = demand.exactWords || demand.minWords || 0;
  const sentTarget = demand.exactSentences || demand.minSentences || 0;
  const words = () => countWords(have.join(' '));

  let passes = 0;
  let ei = 0;
  while (passes < maxPasses && ei < extra.length) {
    const needWords = wordTarget > 0 && words() < wordTarget;
    const needSents = sentTarget > 0 && have.length < sentTarget;
    if (!needWords && !needSents) break;
    let added = 0;
    while (ei < extra.length && added < perPass && ((wordTarget > 0 && words() < wordTarget) || (sentTarget > 0 && have.length < sentTarget))) {
      const s = extra[ei++];
      const key = normalizeKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      have.push(s);
      added++;
    }
    passes++;
    if (added === 0) break;
  }

  // Trim overshoot for exact/max demands (mechanical cut, never invention).
  let out = have;
  const wordCap = demand.exactWords || demand.maxWords || 0;
  if (wordCap > 0 && words() > wordCap) {
    const all = out.join(' ').match(/\b[\w'-]+\b/g) || [];
    out = [all.slice(0, wordCap).join(' ')];
  }
  const sentCap = demand.exactSentences || demand.maxSentences || 0;
  if (sentCap > 0 && out.length > sentCap) out = out.slice(0, sentCap);

  const finalWords = countWords(out.join(' '));
  const metWords = wordTarget > 0 ? finalWords >= wordTarget : true;
  const metSents = sentTarget > 0 ? out.length >= sentTarget : true;
  return { sentences: out, words: finalWords, met: metWords && metSents, passes };
}

module.exports = {
  parseLengthDemand,
  countWords,
  countSentences,
  countParagraphs,
  countLines,
  expandToBudget,
  numberValue
};

if (require.main === module) {
  const d = parseLengthDemand('Write a 300+ word summary in exactly 4 paragraphs.');
  console.log(JSON.stringify(d));
}
