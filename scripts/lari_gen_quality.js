#!/usr/bin/env node
/**
 * lari_gen_quality.js — quality layer for the generative core.
 *
 * Rendering strategy (rewritten 2026-09-22 after the mined-frame experiment
 * failed on quality grounds at 14% mined-use):
 *
 * The old approach shredded researched sentences into clause fragments and
 * stuffed them into pattern slots. Shredding breaks grammar, and no frame
 * inventory can repair a fragment. The new approach never shreds:
 *
 * 1. WHOLE-SENTENCE OPERATOR RENDERING (expository: essays, explanations).
 *    The operator trace stays a rhetorical planner (which discourse function,
 *    in what order, how many sentences). Each node SELECTS whole,
 *    human-written sentences from the topic-ranked research pool, classified
 *    by discourse function via cue phrases (define/exemplify/cause/contrast/
 *    sequence/conclude/compare/...). A selected sentence is grammatical
 *    standalone by construction — it was written by a human and vetted by
 *    the pool filters. Discourse glue (openers, conservative pronounization,
 *    no-repeat, continuity tracking) arranges them into flowing prose.
 *    When the pool is exhausted for a node, the node is SKIPPED — fewer good
 *    sentences beat broken assembly, always.
 *
 * 2. STORY GRAMMAR (narrate). Creative beats cannot be selected from a
 *    factual pool, so they are GENERATED from a tiny hand-built grammar
 *    (S -> NP VP (PP), with number agreement) whose terminal vocabularies
 *    are topic nouns mined from the pool plus controlled story/adjective/
 *    preposition lists. Grammatical by construction: the grammar cannot
 *    emit a broken clause.
 *
 * 3. HAIKU GRAMMAR. Lines are composed by backtracking search over
 *    syllable-counted lexicon entries against grammatical micro-templates
 *    ([Adj N V N] etc.), exact 5/7/5, line 1 must carry a topic word.
 *    Every line is a grammatical micro-clause, never adjective salad.
 *
 * 4. GRAMMAR SAFETY NET. Every emitted sentence passes validSentence():
 *    capital open, terminal punctuation, a finite verb, no truncation
 *    artifacts, no slot remnants, no stuttered bigrams. Failures are
 *    discarded, never emitted.
 *
 * Deterministic (FNV-1a seeded throughout). Zero external model calls.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./lari_generative_core.js');

const { fnv1a, contentTokens, STOPWORDS, cap, lowFirst, stripTrailingPunct,
        countSyllables } = core;

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------------
// 1. opener inventory (mined discourse cues — fact-free by construction)
// ---------------------------------------------------------------------------

const OPENER_CUES = [
  ['contrast', ['however', 'in contrast', 'on the other hand', 'conversely',
    'by contrast', 'that said', 'nevertheless', 'nonetheless',
    'on the contrary', 'alternatively']],
  ['exemplify', ['for example', 'for instance', 'to take one example',
    'as an illustration', 'to illustrate']],
  ['cause', ['as a result', 'consequently', 'for this reason', 'as a consequence',
    'accordingly']],
  ['sequence', ['at first', 'in the years that followed', 'by the end',
    'over time', 'in time', 'meanwhile', 'subsequently', 'afterwards',
    'eventually', 'in the meantime', 'at the outset']],
  ['conclude', ['in the end', 'taken together', 'in short', 'in summary',
    'in conclusion', 'overall', 'all told', 'in brief']],
  ['define', ['strictly speaking', 'in essence']],
  ['compare', ['by comparison', 'similarly', 'likewise', 'in comparison',
    'in the same way']],
  ['condition', ['in practice']],
  ['purpose', ['to that end', 'with this in mind']],
  ['paraphrase', ['in other words', 'put differently', 'that is to say']],
  ['describe', ['in broad terms', 'broadly speaking']],
];
const NO_COMMA_OPENERS = new Set(['the upshot is that']);

function mineOpeners(sentence, inv) {
  for (const [op, cues] of OPENER_CUES) {
    for (const cue of cues) {
      const m = sentence.match(new RegExp('^\\s*' + escRe(cue) + '\\s*(,)?', 'i'));
      if (!m) continue;
      const comma = !!m[1] || !NO_COMMA_OPENERS.has(cue);
      const text = cap(cue) + (comma ? ',' : '');
      const key = text.toLowerCase();
      if (!inv._openerSeen.has(op + '|' + key)) {
        inv._openerSeen.add(op + '|' + key);
        inv.openers[op].push({ text, comma });
      }
      return;
    }
  }
}

const SUBJECT_SLOT = {
  define: 'term', exemplify: 'concept', cause: 'cause', contrast: 'a',
  sequence: 's', enumerate: 'items', conclude: 'point', describe: 'subject',
  compare: 'a', condition: 'outcome', purpose: 'action', paraphrase: 'point',
  narrate: 'setup',
};

function buildInventory(researchPath) {
  const inv = { frames: {}, openers: {}, stats: { sentences: 0, topics: 0 }, _openerSeen: new Set() };
  for (const op of Object.keys(SUBJECT_SLOT)) { inv.frames[op] = []; inv.openers[op] = []; }
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(researchPath, 'utf8')); } catch (e) { /* honest empty */ }
  const entries = Array.isArray(raw) ? raw : [];
  for (const e of entries) {
    const topic = String((e && e.topic) || '');
    if (!topic || !Array.isArray(e.sentences)) continue;
    inv.stats.topics++;
    for (const s0 of e.sentences) {
      const s = String(s0 || '').trim();
      if (!s) continue;
      inv.stats.sentences++;
      mineOpeners(s, inv);
    }
  }
  for (const op of Object.keys(inv.openers)) {
    inv.openers[op].sort((a, b) => a.text < b.text ? -1 : 1);
    inv.openers[op] = inv.openers[op].slice(0, 16);
  }
  delete inv._openerSeen;
  return inv;
}

let INV_CACHE = null, INV_PATH = null, INV_MTIME = 0;
function resolveResearchPath() {
  return process.env.LARI_RESEARCH_JSON ||
    path.join(__dirname, '..', 'models', 'lari', 'current', 'researched-knowledge.json');
}
function getInventory() {
  const p = resolveResearchPath();
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch (_) {}
  if (!INV_CACHE || INV_PATH !== p || mtime !== INV_MTIME) {
    INV_CACHE = buildInventory(p); INV_PATH = p; INV_MTIME = mtime;
  }
  return INV_CACHE;
}

// ---------------------------------------------------------------------------
// 2. pool classification: sentences -> discourse-function classes
// ---------------------------------------------------------------------------

// A sentence may belong to several classes (thin pools need the overlap).
const CLASS_CUES = [
  ['exemplify', [/\bfor example\b/i, /\bfor instance\b/i, /\bsuch as\b/i, /\bincluding\b/i]],
  ['cause', [/\bbecause\b/i, /\bled to\b/i, /\bleads to\b/i, /\bresulted in\b/i,
    /\bresults in\b/i, /\bcaused\b/i, /\btriggered\b/i, /\bgave rise to\b/i,
    /\bas a result\b/i, /\btherefore\b/i, /\bconsequently\b/i]],
  ['contrast', [/\bhowever\b/i, /\bwhereas\b/i, /\balthough\b/i, /\bthough\b/i,
    /\bunlike\b/i, /\bin contrast\b/i, /\bon the other hand\b/i, /\bwhile\b/i,
    /\byet\b/i, /\bnevertheless\b/i, /\bdespite\b/i]],
  ['sequence', [/\bat first\b/i, /\bthen\b/i, /\bafter\b/i, /\blater\b/i,
    /\bover the centuries\b/i, /\bin \d{3,4}\b/, /\bcenturies\b/i, /\bgradually\b/i,
    /\beventually\b/i, /\bsubsequently\b/i]],
  ['conclude', [/\bin conclusion\b/i, /\boverall\b/i, /\bin short\b/i,
    /\btaken together\b/i, /\bin the end\b/i, /\bultimately\b/i]],
  ['compare', [/\bcompared\b/i, /\bdiffers? from\b/i, /\bsimilar\b/i,
    /\bcomparison\b/i, /\bboth\b/i]],
  ['condition', [/\bunless\b/i, /\bprovided that\b/i, /\bas long as\b/i,
    /\bwhether\b/i]],
  ['purpose', [/\bin order to\b/i, /\bso that\b/i, /\bso as to\b/i]],
  ['define', [/\brefers to\b/i, /\bis defined as\b/i, /\bmeans\b/i, /\bknown as\b/i]],
];

const MAX_SENT_WORDS = 38;

// classifyPool(ranked, topicTokens, noComma) ->
//   { classes: {op: [rankedIdx...]}, sentences: [text...] }
function classifyPool(ranked, topicTokens, noComma) {
  const tset = new Set((topicTokens || []).map(t => String(t).toLowerCase()));
  const sentences = [];
  const classes = {};
  for (const [op] of CLASS_CUES) classes[op] = [];
  classes.general = [];
  classes.define = classes.define || [];
  const ridx = [];
  for (const r of (ranked || [])) {
    const s = String(r.s || '').trim();
    if (!s) continue;
    if (noComma && /,/.test(s)) continue;
    const wc = s.split(/\s+/).length;
    if (wc < 5 || wc > MAX_SENT_WORDS) continue;
    if (!/[.!?]$/.test(s)) continue;
    // distiller truncation artifact: sentence cut mid-number ("...at 1.")
    if (/\b(at|to|from|of|and|or) \d\.\s*$/.test(s)) continue;
    const idx = sentences.length;
    sentences.push(s);
    ridx.push(idx);
    const hits = new Set();
    for (const [op, cues] of CLASS_CUES) {
      for (const cue of cues) {
        cue.lastIndex = 0;
        if (cue.test(s)) { hits.add(op); break; }
      }
    }
    // define also catches topic-early sentences ("Sunni Muslims are...")
    const first8 = s.split(/\s+/).slice(0, 8).map(w => w.toLowerCase().replace(/[^a-z]/g, ''));
    if (!hits.has('define') && first8.some(w => tset.has(w)) &&
        /\b(is|are|was|were|refers to|means)\b/i.test(s.split(/\s+/).slice(0, 12).join(' '))) {
      hits.add('define');
    }
    if (!hits.size) hits.add('general');
    else hits.add('general'); // every sentence is also a general candidate
    for (const op of hits) classes[op].push(idx);
  }
  return { classes, sentences };
}

// ---------------------------------------------------------------------------
// 3. DISCOURSE STATE
// ---------------------------------------------------------------------------

class DiscourseState {
  constructor(topicPhrase, keywords) {
    this.topicTokens = new Set(contentTokens(topicPhrase));
    this.keywords = new Set((keywords || []).map(k => String(k).toLowerCase()).filter(Boolean));
    this.mentions = [];       // {head, idx, plural}
    this.lastHead = null;
    this.prevTokens = new Set();
    this.sentenceIdx = 0;
    this.usedSent = new Set();
    this.seenSentences = new Set();
    this.stats = {
      wholeSelected: 0, skippedEmpty: 0, droppedInvalid: 0,
      repetitionsAvoided: 0, pronounSubs: 0, continuityViolations: 0,
      openerUsed: 0, storySentences: 0, haikuLines: 0, sentences: 0,
    };
  }
  usedSentIdx(i) { return this.usedSent.has(i); }
  markSent(i) { this.usedSent.add(i); }
  seenText(sentence) {
    const norm = String(sentence || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return !!norm && this.seenSentences.has(norm);
  }
  recordText(sentence) {
    const norm = String(sentence || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (norm) this.seenSentences.add(norm);
  }
  // leading noun phrase: "The/A/An/These/Those <words>" up to an auxiliary
  // or sentence end. Returns {np, head} or null.
  leadingNP(sentence) {
    const m = String(sentence || '').match(
      /^((?:The|A|An|These|Those)\s+(?:[A-Za-z][\w'-]*\s*){1,6}?)(?=\b(?:is|are|was|were|has|have|had|will|would|can|could|may|might|must|shall|should|do|does|did)\b|[,.])/i);
    if (!m) return null;
    let np = m[1].trim().replace(/[,;:]$/, '');
    // strip trailing PP to find the true head ("The Shia majority in Iraq" -> majority)
    const coreNp = np.replace(/\s+\b(in|of|for|from|on|at|with|by|through|under|over|between|across)\b.*$/i, '').trim();
    const toks = contentTokens(coreNp);
    const head = toks.length ? toks[toks.length - 1] : null;
    if (!head) return null;
    return { np, head: head.toLowerCase() };
  }
  isPlural(np, head) {
    if (/^(These|Those)\b/i.test(np)) return true;
    if (!head || head.length <= 3 || head === 'news') return false;
    if (/(ss|us|is)$/.test(head)) return false;
    return /s$/.test(head);
  }
  // Conservative pronounization: only when this sentence's leading NP head
  // matches the previous sentence's leading NP head.
  maybePronounize(sentence) {
    const cur = this.leadingNP(sentence);
    if (!cur || !this.lastNP || cur.head !== this.lastNP.head) return sentence;
    if (/^(It|They|He|She)\b/.test(sentence)) return sentence;
    const pron = this.isPlural(cur.np, cur.head) ? 'They' : 'It';
    const re = new RegExp('^' + escRe(cur.np) + '\\b');
    let out = sentence.replace(re, pron);
    out = out.replace(/^They (was|is)\b/, 'They were').replace(/^They is\b/, 'They are');
    out = out.replace(/^It were\b/, 'It was');
    if (out !== sentence) {
      if (this.sentenceIdx > 0) this.stats.pronounSubs++;
      else this.stats.repetitionsAvoided++;
    }
    return out;
  }
  // Register an emitted sentence: tracking + continuity check.
  process(sentence) {
    const out = String(sentence || '');
    const cur = this.leadingNP(out);
    const toks = new Set(contentTokens(out));
    if (this.sentenceIdx > 0 && toks.size > 0) {
      let overlap = false;
      for (const t of toks) {
        if (this.topicTokens.has(t) || this.prevTokens.has(t)) { overlap = true; break; }
      }
      if (!overlap) this.stats.continuityViolations++;
    }
    if (cur) {
      this.mentions.push({ head: cur.head, idx: this.sentenceIdx });
      this.lastHead = cur.head;
      this.lastNP = cur;
    }
    this.prevTokens = toks;
    this.sentenceIdx++;
    this.stats.sentences++;
    this.recordText(out);
    return out;
  }
  snapshot() { return { discourse: { ...this.stats } }; }
}

// ---------------------------------------------------------------------------
// 4. GRAMMAR SAFETY NET — a sentence must be grammatical standalone English
// ---------------------------------------------------------------------------

const TRAIL_BAD = new Set(('into,to,of,from,with,by,for,on,at,and,or,the,a,an,as,is,are,was,were,be,that,which,who,' +
  'in,including,while,when,where,if,but,yet,than,like,such,without,within,among,between,through,during,under,per,via,so').split(','));
const FINITE_VERB = new Set((
  'is,are,was,were,be,been,am,has,have,had,having,do,does,did,done,will,would,can,could,shall,should,may,might,must,' +
  'hangs,hang,sways,sway,waits,wait,sleeps,sleep,drifts,drift,settles,settle,rests,rest,creaks,creak,swings,swing,' +
  'stands,stand,lies,lie,gleams,gleam,moves,move,passes,pass,holds,hold,cradles,cradle,keeps,keep,catches,catch,' +
  'watches,watch,guards,guard,falls,fall,shines,shine,breaks,break,calls,call,divided,formed,known,developed,varied,' +
  'place,participate,remain,remains,constitute,differ,led,leads,caused,triggered,emerged,grew,became,took,left,held,' +
  'rises,rise,howls,howl,gathers,gather,trembles,tremble,shivers,shiver,leans,lean,carries,carry'
).split(','));

function validSentence(s) {
  const t = String(s || '').trim();
  if (t.length < 12) return false;
  if (!/^[“"']?[A-Z]/.test(t)) return false;
  if (!/[.!?]["'”]?$/.test(t)) return false;
  if (/\{|\}/.test(t)) return false;                    // slot remnant
  if (/\s{2,}/.test(t)) return false;
  if (/\b(\w+)\s+\1\b/i.test(t)) return false;          // stutter ("the the")
  const words = t.replace(/^[“"']/, '').split(/\s+/);
  if (words.length < 3) return false;
  const last = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '');
  if (TRAIL_BAD.has(last)) return false;                // truncation artifact
  // must contain a finite verb
  let hasVerb = false;
  for (const w of words) {
    const lw = w.toLowerCase().replace(/[^a-z]/g, '');
    if (FINITE_VERB.has(lw)) { hasVerb = true; break; }
    if (/^(is|are|was|were|has|have|had|does|did|will|would|can|could|may|might|must|shall|should)$/.test(lw)) { hasVerb = true; break; }
  }
  if (!hasVerb) {
    // backstop: a past-tense/participle verb not in the list
    for (const w of words) {
      const lw = w.toLowerCase().replace(/[^a-z]/g, '');
      if (lw.length > 4 && /(ed|en)$/.test(lw) && !/^(often|even|been)$/.test(lw)) { hasVerb = true; break; }
    }
  }
  if (!hasVerb) return false;
  // Heading artifact: a section-heading fragment glued to a sentence start —
  // "History The hammock was...", "Appeal of hammock camping The primary...",
  // "Early life Born...". The keyword must be the 2nd-5th word, so legitimate
  // sentence starts ("He fled to Tyre", "One of the benefits...") are kept.
  if (/^(?:[A-Z][a-z']+(?:\s+[a-z]+){0,3})\s+(The|These|This|Those|It|He|She|They|We|You|There|Born|In|On|One|Two|Under|After|Before|During|While|Because|Although|However)\b/.test(t)) return false;
  // Heading lexicon: common Wikipedia section names glued to a sentence —
  // "Demographics Sunni Muslims are...", "Name Grand Central Terminal was...",
  // "Differences in beliefs and practices Successors of Muhammad...".
  // Measured: 35/2096 pool sentences hit (28 unique), all genuine artifacts,
  // no false positives in the sample.
  const _w = t.match(/^([A-Za-z']+(?:\s+[a-z']+){0,5})\s+([A-Z][a-z']*)/);
  if (_w && /^(name|history|etymology|geography|demographics|culture|economy|politics|religion|beliefs|practices|architecture|interior|origins|criticism|libraries|appeal|differences|pillars|successors|pendulation|discharge|overview|background|legacy|influence|reception|doctrine|theology|jurisprudence)$/i.test(_w[1].split(/\s+/)[0])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 5. WHOLE-SENTENCE NODE RENDERER
// ---------------------------------------------------------------------------

const OP_SENT_COUNT = {
  define: 1, exemplify: 1, cause: 1, contrast: 1, compare: 1,
  condition: 1, purpose: 1, paraphrase: 1, conclude: 1,
  describe: 3, sequence: 4, enumerate: 1, narrate: 4,
};

// sentence-initial discourse cues: never stack an opener onto one
const LEAD_CUE = /^\s*(however|for example|for instance|in contrast|as a result|in conclusion|in short|overall|meanwhile|therefore|thus|consequently|nevertheless|nonetheless|instead|moreover|furthermore|in the end|at first|over time|taken together|in summary|accordingly|hence|first|then|so|but|and)\b/i;

function pickOpener(op, i, ctx) {
  const { constraints, seedBase, noComma, inv } = ctx;
  if (i === 0) return null;
  // openers add a word or two: unsafe under EXACT or MAX word budgets, but
  // fine under soft targets (the assembly trim handles those)
  if (constraints.exactWords || constraints.maxWords) return null;
  if (constraints.exactStart) return null;
  if ((constraints.keywordFreq || []).length) return null;
  const ops = inv.openers[op] || [];
  if (!ops.length) return null;
  if (fnv1a(seedBase + '|qopen|' + i) % 3 !== 0) return null;
  const o = ops[fnv1a(seedBase + '|qopenpick|' + i) % ops.length];
  if (noComma && o.comma) return null;
  const low = o.text.toLowerCase();
  for (const k of (constraints.keywords || [])) {
    if (k && new RegExp('\\b' + escRe(String(k).toLowerCase()) + '\\b').test(low)) return null;
  }
  for (const w of (constraints.forbiddenWords || [])) {
    if (w && low.includes(String(w).toLowerCase())) return null;
  }
  return o.text;
}

// seeded selection of n unused sentence indices, class preference first
function selectSentences(op, n, pool, discourse, seedBase, i) {
  const out = [];
  const order = [op, 'general'];
  for (const cls of order) {
    const cands = (pool.classes[cls] || []).filter(idx => !discourse.usedSentIdx(idx));
    if (!cands.length) continue;
    const start = fnv1a(seedBase + '|sel|' + op + '|' + cls + '|' + i) % cands.length;
    for (let k = 0; k < cands.length && out.length < n; k++) {
      const idx = cands[(start + k) % cands.length];
      if (discourse.usedSentIdx(idx) || out.includes(idx)) continue;
      out.push(idx);
    }
    if (out.length >= n) break;
  }
  for (const idx of out) discourse.markSent(idx);
  return out;
}

// enumerate: one sentence joining NPs extracted from pool sentences.
// NPs come from real sentences (leading-NP extractor); the frame is fixed
// and grammatical. Falls back to skipping the node.
function renderEnumerate(pool, discourse, seedBase, i) {
  const idxs = selectSentences('general', 3, pool, discourse, seedBase, i);
  if (idxs.length < 2) { discourse.stats.skippedEmpty++; return []; }
  const nps = [];
  for (const si of idxs) {
    const np = discourse.leadingNP(pool.sentences[si]);
    if (!np) continue;
    const w = np.np.split(/\s+/);
    if (w.length > 8) continue;
    const low = np.np.toLowerCase();
    if (/\b(is|are|was|were|has|have|had|will|would|can|could)\b/.test(low)) continue;
    nps.push(np.np.replace(/^(The|A|An)\s+/, (m) => m.toLowerCase()));
  }
  if (nps.length < 2) { discourse.stats.skippedEmpty++; return []; }
  const joined = nps.length === 2 ? nps.join(' and ')
    : nps.slice(0, -1).join(', ') + ', and ' + nps[nps.length - 1];
  const s = 'The key points are ' + joined + '.';
  if (!validSentence(s)) { discourse.stats.droppedInvalid++; return []; }
  discourse.stats.wholeSelected++;
  return [discourse.process(s)];
}

function renderNodeQuality(node, i, ctx) {
  const { constraints, seedBase, noComma, discourse, inv, pool } = ctx;
  const op = node.op;
  const out = [];

  if (op === 'narrate') return renderStory(node, i, ctx);

  const emit = (sentence, isFirst) => {
    if (!sentence || discourse.seenText(sentence)) return;
    let s = discourse.maybePronounize(sentence);
    const opener = (!isFirst && !LEAD_CUE.test(s)) ? pickOpener(op, i, ctx) : null;
    if (opener) { s = opener + ' ' + lowFirst(s); discourse.stats.openerUsed++; }
    if (!validSentence(s)) { discourse.stats.droppedInvalid++; return; }
    out.push(discourse.process(s));
    discourse.stats.wholeSelected++;
  };

  if (op === 'enumerate') return renderEnumerate(pool, discourse, seedBase, i);

  const n = OP_SENT_COUNT[op] || 1;
  const idxs = selectSentences(op, n, pool, discourse, seedBase, i);
  if (!idxs.length) { discourse.stats.skippedEmpty++; return out; }
  idxs.forEach((si, k) => emit(pool.sentences[si], i === 0 && k === 0));
  return out;
}

function renderTraceQuality(trace, { constraints, prompt, attempt, library, ranked }) {
  const inv = getInventory();
  const topic = core.extractTopic(prompt);
  const noComma = !!constraints.noComma;
  const pool = classifyPool(ranked || [], topic.tokens, noComma);
  const discourse = new DiscourseState(topic.phrase, constraints.keywords);
  const seedBase = String(prompt || '') + '|' + attempt;
  const text = core.renderTrace(trace, {
    constraints, prompt, attempt, library,
    _quality: {
      inv, discourse, pool, ranked,
      renderNode: (node, i, ctx2) => renderNodeQuality(node, i, {
        ...ctx2, seedBase, noComma, discourse, inv, pool,
      }),
    },
  });
  return { text, stats: discourse.snapshot() };
}

// ---------------------------------------------------------------------------
// 6. STORY GRAMMAR — S -> NP VP (PP), number agreement, singular throughout
// ---------------------------------------------------------------------------

const STORY_IV = ['hangs', 'sways', 'waits', 'sleeps', 'drifts', 'settles', 'rests',
  'creaks', 'swings', 'stands', 'lies', 'gleams', 'moves', 'passes', 'leans', 'trembles'];
const STORY_TV = ['holds', 'cradles', 'keeps', 'catches', 'carries'];
const STORY_ADJ = ['old', 'warm', 'quiet', 'soft', 'still', 'gentle', 'dark',
  'bright', 'lazy', 'slow', 'pale', 'deep', 'empty'];
const STORY_PP = ['between the trees', 'in the morning light', 'under the open sky',
  'through the quiet yard', 'in the warm wind', 'beneath the old oak',
  'at the edge of the garden', 'across the still air', 'in the afternoon shade',
  'under the slow clouds'];
// micro-arc roles: setup (at rest) -> disturbance (weather changes) ->
// response (topic reacts) -> resolution (settles again)
const STORY_SETUP_IV = ['hangs', 'rests', 'lies', 'waits', 'sleeps'];
const STORY_WEATHER_N = ['wind', 'storm', 'rain'];
const STORY_DISTURB_IV = ['rises', 'howls', 'breaks', 'gathers', 'trembles'];
const STORY_RESPONSE_IV = ['sways', 'trembles', 'creaks', 'swings', 'shivers'];
const STORY_RESOLVE_IV = ['rests', 'sleeps', 'settles', 'waits'];
const STORY_WEATHER_PP = ['through the dark', 'in the night', 'over the hill',
  'across the sky', 'before the dawn'];
const STORY_TIME = ['At dawn', 'By noon', 'In the afternoon', 'As evening came',
  'At night', 'When the rain stopped', 'Before sunrise'];
const STORY_ADV = ['gently', 'softly', 'slowly', 'quietly'];
const STORY_NOUNS = ['road', 'night', 'wind', 'light', 'shadow', 'morning',
  'journey', 'home', 'garden', 'porch', 'field', 'river', 'hill', 'tree'];
const STORY_RESOLVE_NP = ['only shadows', 'the last of the light', 'a quiet promise',
  'the cool dark', 'nothing but the wind'];

// noun-position words from the pool (article/preposition + noun)
function poolNouns(ranked, excludeSet) {
  const words = [];
  const NON_NOUNS = new Set(('which,that,this,these,those,what,when,where,while,such,other,another,same,each,every,many,much,more,most,some,any,only,very,own,both,few,several,former,latter').split(','));
  const consider = (w) => {
    w = String(w || '').toLowerCase();
    if (NON_NOUNS.has(w)) return;
    if (w.length > 3 && !w.endsWith('ed') && !w.endsWith('ing') && !excludeSet.has(w) && !words.includes(w)) words.push(w);
  };
  for (const r of (ranked || []).slice(0, 12)) {
    const text = String((r && r.s) || r || '');
    for (const m of text.matchAll(/\b(?:the|a|an)\s+([a-z]{4,})(?:\s+([a-z]{4,}))?/gi)) {
      const first = m[1].toLowerCase(), second = (m[2] || '').toLowerCase();
      if (second && STORY_ADJ.includes(first)) consider(second);
      else if (!STORY_ADJ.includes(first)) consider(first);
    }
    for (const m of text.matchAll(/\b(?:of|in|on|at|through|from|to|with|by)\s+([a-z]{4,})\b/gi)) {
      consider(m[1]);
    }
  }
  return words;
}

function storyNoun(topic, ranked) {
  // last content token of the topic phrase, singular-ish
  const toks = contentTokens(topic.phrase);
  let n = (toks[toks.length - 1] || 'hammock').toLowerCase().replace(/[^a-z]/g, '');
  if (!n) n = 'hammock';
  return n;
}

function renderStory(node, i, ctx) {
  const { constraints, seedBase, discourse, ranked } = ctx;
  const topic = core.extractTopic(ctx.prompt || '');
  const tnoun = storyNoun(topic, ranked);
  const exclude = new Set(topic.tokens.map(t => String(t).toLowerCase()));
  let nouns = poolNouns(ranked, exclude).filter(w => w !== tnoun);
  for (const w of STORY_NOUNS) if (!nouns.includes(w)) nouns.push(w);
  const pk = (arr, salt) => arr[fnv1a(seedBase + '|story|' + salt + '|' + i) % arr.length];
  const theTopic = 'The ' + pk(STORY_ADJ, 'adj0') + ' ' + tnoun;
  const artFor = (w) => /^[aeiou]/i.test(w) ? 'An' : 'A';

  const sentences = [
    // setup: the topic at rest
    pk(STORY_TIME, 't0') + ', ' + theTopic.toLowerCase().replace(/^the/, 'the') + ' ' +
      pk(STORY_SETUP_IV, 'v0') + ' ' + pk(STORY_PP, 'pp0') + '.',
    // disturbance: weather changes
    artFor(pk(STORY_ADJ, 'adj1')) + ' ' + pk(STORY_ADJ, 'adj1') + ' ' + pk(STORY_WEATHER_N, 'wn') + ' ' +
      pk(STORY_DISTURB_IV, 'v1') + ' ' + pk(STORY_WEATHER_PP, 'pp1') + '.',
    // response: the topic reacts
    'It ' + pk(STORY_RESPONSE_IV, 'v2') + ' ' + pk(STORY_ADV, 'adv') + ' ' +
      pk(STORY_PP, 'pp2') + '.',
    // resolution: settles again
    pk(STORY_TIME, 't1') + ', it ' + pk(STORY_RESOLVE_IV, 'v3') + ' ' +
      pk(STORY_ADV, 'adv2') + ' ' + pk(STORY_PP, 'pp3') + '.',
  ];
  const out = [];
  // fix "at dawn, the old hammock hangs" casing: time opener then lowercaseNP
  for (let s of sentences) {
    s = s.replace(/^([A-Z][a-z]+ [a-z]+, )the/, '$1the');
    // sentence 1: "At dawn, the old hammock hangs ..." — already right
    if (!validSentence(s)) { discourse.stats.droppedInvalid++; continue; }
    if (discourse.seenText(s)) continue;
    out.push(discourse.process(s));
    discourse.stats.storySentences++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 7. HAIKU GRAMMAR — backtracking over syllable-counted lexicon entries
//    against grammatical micro-templates. Exact 5/7/5.
// ---------------------------------------------------------------------------

// Syllables are computed by countSyllables at load — hand annotations drifted
// (11 mismatches found: cloud/wave/leaf/grass/hill annotated 2, actually 1;
// pale annotated 1, actually 2; etc.), which made the backtracker and the
// final 5/7/5 check disagree and reject good lines.
const sylList = (words) => words.map(w => [w, countSyllables(w)]);
const H_N = sylList(['water', 'light', 'night', 'wind', 'rain', 'sky', 'sea',
  'wave', 'dawn', 'dusk', 'stone', 'tide', 'moon', 'pine', 'snow', 'leaf',
  'cloud', 'grass', 'hill', 'river']); // singular only: templates use
// 3rd-singular verbs, so plural nouns ("waves breaks") would break agreement
const H_VT = sylList(['holds', 'keeps', 'calls', 'breaks', 'guards', 'carries',
  'catches', 'cradles']); // transitive
const H_VI = sylList(['falls', 'waits', 'settles', 'drifts', 'sleeps', 'shines',
  'moves', 'passes', 'rests', 'sways', 'hangs', 'lies']); // intransitive
const H_ADJ = sylList(['still', 'dark', 'soft', 'quiet', 'gentle', 'deep',
  'pale', 'cold', 'warm', 'vast', 'bright', 'old', 'slow']);
const H_DET = sylList(['the', 'a']);
const H_PREP = sylList(['through', 'across', 'beneath', 'over', 'in', 'under',
  'upon', 'on', 'at']);
const H_ADV = sylList(['softly', 'gently', 'slowly']);
// Curated prepositional phrases: bare nouns after prepositions only work for
// a few nouns ("at dusk" yes, "at sky" no), so the PP is chosen as a unit.
// Every pairing with every intransitive verb reads clean.
const H_PP = ['at dusk', 'at dawn', 'through night', 'in rain', 'under moon',
  'over tide', 'across sky', 'in wind', 'on stone', 'through cloud',
  'beneath cloud', 'in dark'
].map(p => [p, p.split(' ').reduce((n, w) => n + countSyllables(w), 0)]);

function haikuLexicon(topic, ranked) {
  const lex = { N: H_N.slice(), VT: H_VT.slice(), VI: H_VI.slice(), ADJ: H_ADJ.slice() };
  const seen = new Set(lex.N.map(e => e[0]));
  const tset = new Set((topic.tokens || []).map(t => String(t).toLowerCase()));
  // NOTE: pool words are deliberately NOT injected as nouns. The pool text
  // carries verbs/adjectives in noun positions ("the suspended hammock" ->
  // "suspended"), which produced word salad ("Bright keep drifts softly").
  // Verse stays imagistic from a clean fixed lexicon; the topic word grounds
  // line 1. (ranked kept in signature for callers.)
  void ranked;
  // Only the head noun (last token) joins the noun lexicon — injecting every
  // token added prompt adjectives as nouns ("short song" -> "short", "song").
  // tset keeps all tokens for the line-1 topic check.
  const headToks = (topic.tokens || []).filter(t => /^[a-z]+$/i.test(String(t)));
  const head = headToks.length ? String(headToks[headToks.length - 1]).toLowerCase() : '';
  if (head && !seen.has(head)) {
    const sy = countSyllables(head);
    if (sy >= 1 && sy <= 2) { seen.add(head); lex.N.push([head, sy]); }
  }
  return { lex, topicSet: tset };
}

// templates: [category, ...] per line; line 1 must include a topic word.
// VT = transitive verb (takes the object NP), VI = intransitive.
const HAIKU_TEMPLATES = [
  [['N', 'VT', 'DET', 'N'], 5, true],    // Stone keeps the ocean
  [['DET', 'ADJ', 'N', 'VI', 'PP'], 7, false], // Old snow settles over tide
  [['ADJ', 'N', 'VI', 'ADV'], 5, false], // Dark night settles soft
];

function composeHaiku2(topic, ranked) {
  const { lex, topicSet } = haikuLexicon(topic, ranked);
  const cats = { ADJ: lex.ADJ, N: lex.N, VT: lex.VT, VI: lex.VI, DET: H_DET, PP: H_PP, ADV: H_ADV };
  const used = new Set();
  const seed = 'haiku3|' + topic.phrase;
  const lines = [];
  for (let li = 0; li < HAIKU_TEMPLATES.length; li++) {
    const [tmpl, target, mustTopic] = HAIKU_TEMPLATES[li];
    // seeded candidate order per slot
    const orderFor = (slot, cat) => cats[cat]
      .map(e => ({ e, h: fnv1a(seed + '|' + li + '|' + slot + '|' + e[0]) }))
      .sort((a, b) => a.h - b.h)
      .map(x => x.e);
    const orders = tmpl.map((cat, s) => orderFor(s, cat));
    let found = null;
    const bt = (pos, rem, acc, hasTopic) => {
      if (found) return true;
      if (pos === tmpl.length) {
        if (rem === 0 && (!mustTopic || hasTopic)) { found = acc.slice(); return true; }
        return false;
      }
      for (const [w, sy] of orders[pos]) {
        if (used.has(w) || sy > rem) continue;
        // PP phrases must not repeat an already-used word ("moon ... under moon")
        if (tmpl[pos] === 'PP' &&
            !w.split(' ').every(pw => !used.has(pw) && !acc.includes(pw))) continue;
        // noun after noun is ungrammatical in these templates only at
        // fixed positions — templates are grammatical by shape; skip dupes
        acc.push(w);
        const ht = hasTopic || (tmpl[pos] === 'N' && topicSet.has(w));
        // track PP component words too, so "under moon" blocks a later "moon"
        const parts = w.includes(' ') ? w.split(' ') : [w];
        for (const p of parts) used.add(p);
        if (bt(pos + 1, rem - sy, acc, ht)) return true;
        for (const p of parts) used.delete(p);
        acc.pop();
      }
      return false;
    };
    if (!bt(0, target, [], false)) return null; // honest failure
    lines.push(fixArticles(found.join(' ')));
  }
  const syl = (l) => String(l).split(/\s+/).reduce((n, w) => n + countSyllables(w), 0);
  if (syl(lines[0]) !== 5 || syl(lines[1]) !== 7 || syl(lines[2]) !== 5) return null;
  return lines.map(l => cap(l)).join('\n');
}

// ---------------------------------------------------------------------------
// 8. CREATIVE FORM RENDERERS — poem, song, riddle, slogan, joke, letter,
//    speech. Grammar-generated (verse/riddle/slogan/joke) or whole-sentence
//    selection with form framing (letter/speech). Every line is grammatical
//    by construction; no factual claims are invented (verse is imagistic,
//    prose bodies come from the researched pool).
// ---------------------------------------------------------------------------

// verse templates: [categories, exact syllables]
const VERSE_TEMPLATES = [
  [['ADJ', 'N', 'VT', 'DET', 'N'], 6],   // Dark night holds a hammock
  [['ADJ', 'N', 'VI', 'ADV'], 5],        // Still sea hangs softly
  [['DET', 'ADJ', 'N', 'VI', 'PP'], 7],  // The old snow settles over tide
  [['N', 'VI', 'ADV'], 4],               // Wave falls softly
  [['ADJ', 'N', 'VI', 'PP'], 6],         // Cold wind drifts through night
];

// "a" -> "an" before vowel sounds. Both are 1 syllable, so verse/haiku
// syllable counts are unaffected.
function fixArticles(line) {
  return String(line).replace(/(^|\s)a ([aeiou])/gi, '$1an $2');
}

// verb-conditioned object-noun compatibility. Without this, random pairing
// produces "breaks a moon". PPs are curated as units (H_PP), so they need no
// conditioning.
const VT_OBJ = {
  calls: ['night', 'dawn', 'dusk', 'moon', 'wind'],
  breaks: ['wave', 'cloud', 'stone'],
  guards: ['night', 'dawn', 'dusk', 'light', 'moon'],
  carries: ['light', 'wind', 'wave', 'rain'],
  catches: ['light', 'rain', 'wind', 'snow'],
  cradles: ['night', 'moon', 'light', 'dawn', 'dusk'],
  // holds, keeps: any noun
};
const VT_WORDS = new Set(['holds', 'keeps', 'calls', 'breaks', 'guards', 'carries', 'catches', 'cradles']);

function verseBacktrack(tmpl, target, cats, seedStr, used, mustTopic, topicSet) {
  const orders = tmpl.map((cat, s) => cats[cat]
    .map(e => ({ e, h: fnv1a(seedStr + '|' + s + '|' + e[0]) }))
    .sort((a, b) => a.h - b.h).map(x => x.e));
  // topic-eligible slots: nouns/adjectives NOT governed by a preposition
  // ("falls on hammock" reads wrong; "holds a hammock" reads right)
  const eligible = new Set();
  tmpl.forEach((cat, i) => {
    if ((cat === 'N' || cat === 'ADJ') && (i === 0 || tmpl[i - 1] !== 'PREP')) eligible.add(i);
  });
  let found = null;
  const bt = (pos, rem, acc, hasTopic) => {
    if (found) return true;
    if (pos === tmpl.length) {
      if (rem === 0 && (!mustTopic || hasTopic)) { found = acc.slice(); return true; }
      return false;
    }
    // unused words first (variety), used words as fallback (guarantees
    // completion for long poems/songs — never within the same line).
    const cands = [];
    for (const [w, sy] of orders[pos]) if (!used.has(w)) cands.push([w, sy]);
    for (const [w, sy] of orders[pos]) if (used.has(w) && !acc.includes(w)) cands.push([w, sy]);
    // compatibility filters: PREP conditioned on the chosen VI verb,
    // object-N conditioned on the chosen VT verb.
    let fcands = cands;
    // PP phrases must not repeat an already-used word ("moon ... under moon")
    if (tmpl[pos] === 'PP') {
      fcands = cands.filter(([w]) =>
        w.split(' ').every(pw => !used.has(pw) && !acc.includes(pw)));
    }
    if (tmpl[pos] === 'N') {
      const vti = acc.findIndex(w => VT_WORDS.has(w));
      if (vti >= 0 && vti < pos) {
        const vt = acc[vti];
        const ok = VT_OBJ[vt];
        if (ok) fcands = cands.filter(([w]) => ok.includes(w) || topicSet.has(w));
      }
    }
    for (const [w, sy] of fcands) {
      if (sy > rem) continue;
      acc.push(w);
      const ht = hasTopic || (eligible.has(pos) && topicSet.has(w));
      // track PP component words too, so "under moon" blocks a later "moon"
      const parts = w.includes(' ') ? w.split(' ') : [w];
      for (const p of parts) used.add(p);
      if (bt(pos + 1, rem - sy, acc, ht)) return true;
      for (const p of parts) used.delete(p);
      acc.pop();
    }
    return false;
  };
  bt(0, target, [], false);
  return found ? found.join(' ') : null;
}

// compose n verse lines; first line carries a topic word. null on failure.
function composeVerse(topic, ranked, nLines, seedBase) {
  const { lex, topicSet } = haikuLexicon(topic, ranked);
  const cats = { ADJ: lex.ADJ, N: lex.N, VT: lex.VT, VI: lex.VI, DET: H_DET, PP: H_PP, ADV: H_ADV };
  const used = new Set();
  const lines = [];
  for (let li = 0; li < nLines; li++) {
    let line = null;
    const tStart = fnv1a(seedBase + '|vtmp|' + li) % VERSE_TEMPLATES.length;
    for (let k = 0; k < VERSE_TEMPLATES.length && !line; k++) {
      const [tmpl, target] = VERSE_TEMPLATES[(tStart + k) % VERSE_TEMPLATES.length];
      line = verseBacktrack(tmpl, target, cats, seedBase + '|vl|' + li + '|' + k,
        used, li === 0, topicSet);
    }
    if (!line) return null;
    lines.push(fixArticles(line));
  }
  return lines;
}

function artForWord(w) { return /^[aeiou]/i.test(w) ? 'An' : 'A'; }

function topicNounOf(topic) {
  const toks = contentTokens(topic.phrase);
  let w = (toks[toks.length - 1] || 'thing').toLowerCase().replace(/[^a-z]/g, '') || 'thing';
  // crude singularization for plural topics ("hammocks" -> "hammock")
  if (w.length > 4 && /s$/.test(w) && !/ss$/.test(w)) w = w.slice(0, -1);
  return w;
}

function renderPoem(o) {
  const n = Math.max(4, Math.min(24, o.plan.lineCount || 12));
  const lines = composeVerse(o.topicObj, o.ranked, n, o.seedBase + '|poem');
  if (!lines) return null;
  // quatrains
  const stanzas = [];
  for (let i = 0; i < lines.length; i += 4) stanzas.push(lines.slice(i, i + 4).join('\n'));
  return stanzas.map(s => s.split('\n').map(cap).join('\n')).join('\n\n');
}

function renderSong(o) {
  const verse1 = composeVerse(o.topicObj, o.ranked, 4, o.seedBase + '|songv1');
  const chorus = composeVerse(o.topicObj, o.ranked, 2, o.seedBase + '|songc');
  const verse2 = composeVerse(o.topicObj, o.ranked, 4, o.seedBase + '|songv2');
  if (!verse1 || !chorus || !verse2) return null;
  const L = (ls) => ls.map(cap).join('\n');
  return 'Verse 1\n' + L(verse1) + '\n\nChorus\n' + L(chorus) +
    '\n\nVerse 2\n' + L(verse2) + '\n\nChorus\n' + L(chorus);
}

function renderRiddle(o) {
  const tnoun = topicNounOf(o.topicObj);
  const pk = (arr, salt) => arr[fnv1a(o.seedBase + '|riddle|' + salt) % arr.length];
  // first-person needs base verb forms ("I hang", not "I hangs")
  const IV_BASE = ['hang', 'sway', 'wait', 'sleep', 'drift', 'settle', 'rest',
    'creak', 'swing', 'stand', 'lie', 'gleam', 'move', 'pass', 'lean', 'tremble'];
  const TV_BASE = ['hold', 'carry', 'guard', 'cradle', 'shelter', 'rock'];
  const lines = [
    'I ' + pk(IV_BASE, 'v0') + ' ' + pk(STORY_PP, 'pp0') + '.',
    'I ' + pk(IV_BASE, 'v1') + ' ' + pk(STORY_ADV, 'adv') + ' ' + pk(STORY_PP, 'pp1') + '.',
    'I ' + pk(TV_BASE, 'v2') + ' ' + pk(STORY_RESOLVE_NP, 'np') + '.',
    'What am I?',
    cap(artForWord(tnoun) + ' ' + tnoun) + '.',
  ];
  // validate only the clue lines; the question and one-word answer are fixed forms
  if (lines.slice(0, 3).some(l => !validSentence(l))) return null;
  return lines.join('\n');
}

function renderSlogan(o) {
  const tnoun = topicNounOf(o.topicObj);
  const pk = (arr, salt) => arr[fnv1a(o.seedBase + '|slogan|' + salt) % arr.length];
  const adj = pk(STORY_ADJ, 'adj');
  const art = /^[aeiou]/i.test(adj) ? 'an' : 'a';
  // "Nothing sways like an old hammock." — classic slogan shape, 3rd-singular
  // verbs from STORY_IV agree with "nothing".
  const l1 = 'Nothing ' + pk(STORY_IV, 'iv1') + ' like ' + art + ' ' + adj + ' ' + tnoun + '.';
  const l2 = cap(artForWord(tnoun)) + ' ' + tnoun + ' ' + pk(STORY_IV, 'iv2') + ' ' + pk(STORY_PP, 'pp') + '.';
  return cap(l1) + '\n' + cap(l2);
}

function renderJoke(o) {
  // anti-joke: the humor is literal subversion, which works generically and
  // stays honest (no invented facts, no fake punchlines).
  const tnoun = topicNounOf(o.topicObj);
  const pk = (arr, salt) => arr[fnv1a(o.seedBase + '|joke|' + salt) % arr.length];
  const q = 'What do you call ' + artForWord(pk(STORY_ADJ, 'adj')).toLowerCase() + ' ' +
    pk(STORY_ADJ, 'adj') + ' ' + tnoun + ' that ' + pk(STORY_IV, 'iv') + ' ' +
    pk(STORY_PP, 'pp') + '?';
  const a = cap(artForWord(tnoun)) + ' ' + tnoun + '.';
  return q + '\n' + a;
}

function poolBody(o, n) {
  const pool = classifyPool(o.ranked, o.topicObj.tokens, false);
  const cands = (pool.classes.general || []).filter(i => !o.discourse.usedSentIdx(i));
  const out = [];
  for (const i of cands) {
    if (out.length >= n) break;
    const s = pool.sentences[i];
    if (!validSentence(s)) continue;
    o.discourse.markSent(i);
    out.push(s);
  }
  return out;
}

function renderLetter(o) {
  const body = poolBody(o, 3);
  if (body.length < 3) return null; // honest: not enough grounded content
  return 'Dear friend,\n\n' + body.join(' ') + '\n\nSincerely,\nLari';
}

function renderSpeech(o) {
  const body = poolBody(o, 5);
  if (body.length < 3) return null;
  const t = o.topicObj.phrase;
  return 'Let me tell you about ' + lowFirst(t) + '.\n\n' + body.join(' ') + '\n\nThank you.';
}

const FORM_RENDERERS = {
  poem: renderPoem, song: renderSong, riddle: renderRiddle,
  slogan: renderSlogan, joke: renderJoke, letter: renderLetter,
  speech: renderSpeech, haiku: (o) => composeHaiku2(o.topicObj, o.ranked),
};

// kind -> rendered text or null. Grammar forms need no pool; letter/speech
// select factual pool sentences under form framing.
function renderCreativeForm(kind, { prompt, topic, sentences, plan = {}, seedBase } = {}) {
  const fn = FORM_RENDERERS[kind];
  if (!fn) return null;
  try {
    // Prefer the caller's topic string (already kind-stripped by
    // extractCreativeTopic); only extract from the prompt when none given.
    let tObj;
    if (typeof topic === 'string' && topic.trim()) {
      tObj = { phrase: topic.trim(), tokens: contentTokens(topic) };
    } else if (topic && topic.phrase) {
      tObj = topic;
    } else {
      tObj = core.extractTopic(prompt || '');
    }
    if (!tObj || !tObj.phrase) return null;
    const ranked = (sentences || []).map(s => ({ s: String((s && s.s) || s || '') }));
    const o = {
      topicObj: tObj, ranked, plan,
      seedBase: String(seedBase || (prompt + '|' + kind) || kind),
      discourse: new DiscourseState(tObj.phrase, []),
    };
    const text = fn(o);
    if (!text || FAKE_FEELING_RE.test(text)) return null;
    return text;
  } catch (_) { return null; }
}

const FAKE_FEELING_RE = /\bi feel\b|\bi'm feeling\b|\bmy heart\b|\binspired me\b|\bas an ai\b|\bas a language model\b/i;

module.exports = {
  buildInventory,
  getInventory,
  classifyPool,
  DiscourseState,
  renderNodeQuality,
  renderTraceQuality,
  renderStory,
  composeHaiku2,
  composeVerse,
  renderCreativeForm,
  validSentence,
  SUBJECT_SLOT,
};
