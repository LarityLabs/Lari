'use strict';

// Native dictionary: Princeton WordNet (lexical database of English — words and
// definitions, plus the relations between meanings). This is ground truth the
// same way the clock is: WordNet *defines* the words, so definitions are read,
// never researched and never gated. The data files ship locally via the
// wordnet-db package; this module is a small purpose-built reader (no heavy
// NLP dependency) that parses the dict files on first use.
//
// Public API:
//   define(word) -> [{ pos, synonyms, gloss, hypernyms }]
//   enrichContentWords(text, { maxWords }) -> [{ word, senses }]
//   isLoaded()

const fs = require('fs');
const path = require('path');

const DICT_DIR = path.join(__dirname, 'node_modules', 'wordnet-db', 'dict');
const POS_ORDER = ['n', 'v', 'a', 'r'];
const POS_LABEL = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' };
const POS_FILE = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' };

let indexCache = null; // Map key -> [{ pos, offsets }]
let dataCache = {}; // pos -> Map offset -> raw line
let loadError = null;

function dictAvailable() {
  try {
    return fs.statSync(DICT_DIR).isDirectory();
  } catch (_) {
    return false;
  }
}

function loadIndex() {
  if (indexCache || loadError) return;
  if (!dictAvailable()) {
    loadError = 'wordnet dict dir missing';
    return;
  }
  indexCache = new Map();
  for (const pos of POS_ORDER) {
    let text;
    try {
      text = fs.readFileSync(path.join(DICT_DIR, `index.${POS_FILE[pos]}`), 'utf8');
    } catch (err) {
      loadError = `index.${POS_FILE[pos]} unreadable`;
      return;
    }
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line || line.startsWith('  ')) continue; // license header lines
      const toks = line.split(' ');
      if (toks.length < 7) continue;
      const lemma = toks[0];
      const synsetCount = parseInt(toks[2], 10);
      const ptrCount = parseInt(toks[3], 10);
      if (!Number.isFinite(synsetCount) || !Number.isFinite(ptrCount)) continue;
      const offsets = toks.slice(6 + ptrCount, 6 + ptrCount + synsetCount);
      if (!offsets.length) continue;
      const key = lemma.toLowerCase();
      if (!indexCache.has(key)) indexCache.set(key, []);
      indexCache.get(key).push({ pos, offsets });
    }
  }
}

function dataLines(pos) {
  if (dataCache[pos]) return dataCache[pos];
  const map = new Map();
  dataCache[pos] = map;
  let text;
  try {
    text = fs.readFileSync(path.join(DICT_DIR, `data.${POS_FILE[pos]}`), 'utf8');
  } catch (_) {
    return map;
  }
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line || line.startsWith('  ')) continue;
    const offset = line.slice(0, 8);
    if (/^\d{8}$/.test(offset)) map.set(offset, line);
  }
  return map;
}

function cleanWord(raw) {
  return String(raw || '').replace(/_/g, ' ').replace(/\((?:p|a|ip)\)$/, '').trim();
}

// Parse one data.<pos> line into { offset, pos, synonyms, gloss, hypernymOffsets }.
function parseSynset(pos, line) {
  const bar = line.indexOf(' | ');
  const head = (bar >= 0 ? line.slice(0, bar) : line).trim().split(' ');
  const gloss = bar >= 0 ? line.slice(bar + 3).trim() : '';
  const offset = head[0];
  const wordCount = parseInt(head[3], 10);
  if (!Number.isFinite(wordCount) || wordCount < 0) return null;
  const synonyms = [];
  for (let i = 0; i < wordCount; i += 1) {
    const w = cleanWord(head[4 + i * 2]);
    if (w && !synonyms.includes(w)) synonyms.push(w);
  }
  const ptrBase = 4 + wordCount * 2;
  const ptrCount = parseInt(head[ptrBase], 10) || 0;
  const hypernymOffsets = [];
  for (let i = 0; i < ptrCount; i += 1) {
    const symbol = head[ptrBase + 1 + i * 4];
    const target = head[ptrBase + 2 + i * 4];
    if ((symbol === '@' || symbol === '@i') && /^\d{8}$/.test(target || '')) {
      hypernymOffsets.push({ offset: target, pos: head[ptrBase + 3 + i * 4] || pos });
    }
  }
  return { offset, pos, synonyms, gloss, hypernymOffsets };
}

function synsetWords(pos, offset) {
  const line = dataLines(pos).get(offset);
  if (!line) return [];
  const parsed = parseSynset(pos, line);
  return parsed ? parsed.synonyms : [];
}

function lookupKey(word) {
  return String(word || '').toLowerCase().trim().replace(/\s+/g, '_');
}

// Irregular inflections WordNet's index can't derive by rule. Fixed linguistic
// data, not learned — safe to hardcode.
const IRREGULARS = {
  geese: 'goose', teeth: 'tooth', feet: 'foot', mice: 'mouse', men: 'man',
  women: 'woman', children: 'child', oxen: 'ox', people: 'person',
  brought: 'bring', bought: 'buy', thought: 'think', taught: 'teach',
  went: 'go', gone: 'go', been: 'be', was: 'be', were: 'be',
  ran: 'run', swam: 'swim', began: 'begin', drunk: 'drink', sung: 'sing'
};

// Definitions for one word. Tries the word as-is, then a light singular
// fallback (WordNet's index only holds base forms).
function define(word) {
  loadIndex();
  if (!indexCache) return [];
  const keys = [lookupKey(word)];
  const irregular = IRREGULARS[keys[0]];
  if (irregular) keys.push(irregular);
  const singular = keys[0].replace(/(?<![ss])s$/, '');
  if (singular !== keys[0] && singular.length >= 3) keys.push(singular);
  const ies = keys[0].replace(/ies$/, 'y');
  if (ies !== keys[0] && ies.length >= 3) keys.push(ies);
  const senses = [];
  for (const key of keys) {
    const entries = indexCache.get(key);
    if (!entries) continue;
    for (const entry of entries) {
      const lines = dataLines(entry.pos);
      for (const offset of entry.offsets) {
        const line = lines.get(offset);
        if (!line) continue;
        const parsed = parseSynset(entry.pos, line);
        if (!parsed || !parsed.gloss) continue;
        const hypernyms = [];
        for (const h of parsed.hypernymOffsets.slice(0, 3)) {
          for (const w of synsetWords(h.pos, h.offset).slice(0, 2)) {
            if (!hypernyms.includes(w)) hypernyms.push(w);
          }
          if (hypernyms.length >= 4) break;
        }
        senses.push({
          pos: POS_LABEL[entry.pos] || entry.pos,
          synonyms: parsed.synonyms.slice(0, 6),
          gloss: parsed.gloss,
          hypernyms: hypernyms.slice(0, 4)
        });
      }
    }
    if (senses.length) break; // prefer the first key that hits
  }
  return senses;
}

const STOPWORDS = new Set(String(
  'a an the and or but of in on at to for with by from as is are was were be been being ' +
  'i you he she it we they me him her us them my your his its our their this that these those ' +
  'what which who whom whose when where why how do does did can could would should will shall ' +
  'not no yes if then than so such very just about into over after before between through ' +
  'it s t don doesn isn aren wasn weren there here please tell give get got make made like ' +
  'know time'
).split(' '));

function enrichContentWords(text, options = {}) {
  const maxWords = options.maxWords || 10;
  const tokens = String(text || '').toLowerCase().match(/[a-z][a-z'-]*/g) || [];
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    const word = token.replace(/['-]$/, '');
    if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    const senses = define(word);
    if (senses.length) {
      out.push({ word, senses: senses.slice(0, 3) });
      if (out.length >= maxWords) break;
    }
  }
  return out;
}

function isLoaded() {
  loadIndex();
  return Boolean(indexCache);
}

module.exports = { define, enrichContentWords, isLoaded, dictAvailable };
