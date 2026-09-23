#!/usr/bin/env node
/**
 * Lari creative core (drawing-board rebuild, 2026-09-21; fiction mode added
 * 2026-09-23 per Greg: Lari must not refuse creative writing).
 *
 * Replaces the reflex creative refusal with constraint-aware attempts.
 * Pipeline (all deterministic, zero external model calls, no network):
 *
 *   1. FORM DETECTION (before any generation): poem/haiku/limerick/sonnet/
 *      ode/song/rap/story/letter/dialogue/joke/riddle/speech/slogan/ad, or
 *      'none' for a creative request with no form specified. Never defaults
 *      a formless request to poetry: 'none' means direct, unstylized prose.
 *   2. STRUCTURE PLANNING AS DATA: the prompt's mechanical constraints
 *      (exact lines/paragraphs/sentences) are parsed FIRST into a plan, with
 *      form defaults only filling gaps. Beats (open/turn/land) are planned
 *      as data (indices into the grounded pool), not generated text.
 *   3. FILL: the structure is filled from grounded sentences first
 *      (researched knowledge / composer pool passed in by the caller).
 *      FICTION MODE (fiction: true, or forced after a grounded attempt
 *      failed): when grounded sentences are thin, the pool is built from
 *      WordNet glosses of lowercase common-noun topic tokens (capitalized
 *      names are never glossed, so a fictional Sarah gets no dictionary
 *      identity) plus deterministic template-composed sentences seeded by a
 *      hash of the prompt. No Math.random anywhere. Fiction never asserts
 *      real-world claims as fact; it invents openly.
 *   4. REPAIR + VERIFY: scripts/lari_constraint_repair.js fixes surface
 *      constraints (case, commas, wrapping, affixes, word/sentence counts);
 *      structural constraints (lines/paragraphs/sentences) are re-verified
 *      after repair and must hold exactly, else null.
 *
 * Honesty rules:
 *   - Grounded mode: every content sentence is a verbatim grounded sentence.
 *     Structural framing (speaker labels, "Dear X,", a topic header) makes no
 *     factual claim. Nothing is synthesized, woven, or transformed.
 *   - Fiction mode: the output is openly invented; it must not present
 *     invented events about real people/places as fact.
 *   - No fake feelings, no em dashes in user-facing text.
 *   - Impossible requests (creative form that must also be valid code): in
 *     fiction mode the creative form is attempted genuinely and the
 *     unsatisfiable code demand is dropped, never presented as executable.
 *   - "No styling" stays valid: form 'none' produces direct plain prose.
 *
 * This module does NOT use the fractal composer, the voice profile, or any
 * lens machinery. Those are dead and stay dead.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let repair = null;
try { repair = require('./lari_constraint_repair.js'); } catch (_) { repair = null; }

const STORE_PATH = path.join(__dirname, '..', 'models', 'lari', 'current', 'researched-knowledge.json');

const STOPWORDS = new Set((
  'a,an,the,and,or,but,of,for,to,in,on,with,without,by,from,at,as,is,are,was,were,be,been,being,' +
  'it,its,this,that,these,those,my,your,his,her,our,their,i,me,we,you,he,she,they,them,us,him,' +
  'what,which,who,whom,how,when,where,why,not,no,yes,do,does,did,can,could,should,would,will,' +
  'just,very,more,most,than,then,there,here,also,about,into,over,under,between,through,up,out,' +
  'something,anything,creative,make,write,writes,writing,wrote,compose,create,creates,give,tell'
).split(','));

const FORM_PATTERNS = [
  { form: 'haiku', re: /\bhaikus?\b/i },
  { form: 'limerick', re: /\blimericks?\b/i },
  { form: 'sonnet', re: /\bsonnets?\b/i },
  { form: 'ode', re: /\bodes?\b/i },
  { form: 'rap', re: /\braps?\b/i },
  { form: 'song', re: /\bsongs?(\s+lyrics)?\b|\blyrics\b/i },
  { form: 'poem', re: /\bpoems?\b|\bpoetry\b/i },
  { form: 'story', re: /\bstor(y|ies)\b|\bshort\s+stor\w*\b|\btales?\b/i },
  { form: 'letter', re: /\bletters?\b|\bemails?\b/i },
  { form: 'dialogue', re: /\bdialogues?\b|\bconversation\s+between\b/i },
  { form: 'joke', re: /\bjokes?\b|\bsomething\s+funny\b/i },
  { form: 'riddle', re: /\briddles?\b/i },
  { form: 'speech', re: /\bspeech(es)?\b/i },
  { form: 'slogan', re: /\bslogans?\b|\btaglines?\b|\bcatchphrases?\b|\bmottos?\b/i },
  { form: 'ad', re: /\badvertisements?\b|\bad\s+(copy|vertisements?|s)?\b|\bcommercials?\b|\bpromo\b/i }
];

const CREATIVE_MARKERS = /\bsomething\s+creative\b|\bcreative\s+(piece|writing)\b|\bmake\s+(me\s+)?something\s+(up|creative)\b|\bcome\s+up\s+with\s+(a|an|some|something)\b|\binvent\s+(a|an|me)\b|\bimaginative\b|\bpretend\b|\broleplay\b|\brole\s+play\b|\bin\s+character\b/i;
// "letter(s)" as a CHARACTER constraint ("lowercase letters", "the letter t")
// is not a creative request. This guard keeps detectCreativeForm from
// hijacking vocabulary/character prompts into letter-writing attempts.
const LETTER_CHAR_CONTEXT = /(lowercase|uppercase|capital)\s+letters?|letters?\s+only|\bthe\s+letter\s+[a-z]\b|\buse\s+the\s+letter\b/i;
const CODE_MARKERS = /\b(python|javascript|typescript|java|c\+\+|valid\s+code|executable|compilable|runs?\s+as(\s+code)?|code\s+that\s+(runs|compiles)|valid\s+json|json\s+object)\b/i;
const FAKE_FEELING_RE = /\bi feel\b|\bi'm feeling\b|\bmy heart\b|\binspired me\b|\bas an ai\b|\bas a language model\b/i;

const LINE_FORMS = new Set(['poem', 'haiku', 'limerick', 'sonnet', 'ode', 'song', 'rap', 'riddle', 'dialogue', 'slogan', 'ad']);
const PARA_FORMS = new Set(['story', 'letter', 'speech', 'joke', 'none']);

// ------------------------------------------------------------------ detect

// Minimal Porter stemmer (steps 1a/1b/1c/5a): enough for Lesk-style gloss
// overlap so 'moving' matches 'move'. Deterministic, no dependencies.
function porterStemWord(w) {
  w = String(w || '').toLowerCase();
  if (w.length < 3) return w;
  const C = '[^aeiou]', V = '[aeiouy]';
  const mgr0 = new RegExp('^(' + C + ')?' + V + C);
  const meq1 = new RegExp('^(' + C + ')?' + V + C + '(' + V + ')?$');
  const mgr1 = new RegExp('^(' + C + ')?' + V + C + V + C);
  const sv = new RegExp('^(' + C + ')?' + V);
  let m;
  // Step 1a: plurals
  if ((m = /^(.+?)(ss|i)es$/.exec(w))) w = m[1] + m[2];
  else if ((m = /^(.+?)([^s])s$/.exec(w))) w = m[1] + m[2];
  // Step 1b: -eed, -ed, -ing
  if ((m = /^(.+?)eed$/.exec(w))) { if (mgr0.test(m[1])) w = m[1] + 'ee'; }
  else if ((m = /^(.+?)(ed|ing)$/.exec(w))) {
    if (sv.test(m[1])) {
      w = m[1];
      if (/(at|bl|iz)$/.test(w)) w += 'e';
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
      else if (new RegExp('^' + C + V + '[^aeiouwxy]$').test(w)) w += 'e';
    }
  }
  // Step 1c: -y -> -i
  if ((m = /^(.+?)y$/.exec(w)) && sv.test(m[1])) w = m[1] + 'i';
  // Step 5a: trailing -e
  if ((m = /^(.+?)e$/.exec(w))) {
    const stem = m[1];
    if (mgr1.test(stem) || (meq1.test(stem) && !new RegExp('^' + C + V + '[^aeiouwxy]$').test(stem))) w = stem;
  }
  return w;
}

function detectCreativeForm(prompt) {
  const t = String(prompt || '');
  const letterBlocked = LETTER_CHAR_CONTEXT.test(t);
  for (const f of FORM_PATTERNS) {
    if (f.form === 'letter' && letterBlocked) continue;
    if (f.re.test(t) && CODE_MARKERS.test(t)) return { form: f.form, impossible: true };
  }
  for (const f of FORM_PATTERNS) {
    if (f.form === 'letter' && letterBlocked) continue;
    if (f.re.test(t)) return { form: f.form };
  }
  if (CREATIVE_MARKERS.test(t)) {
    if (CODE_MARKERS.test(t)) return { form: 'none', impossible: true };
    return { form: 'none' };
  }
  return null;
}

function isCreativeRequest(prompt) {
  return detectCreativeForm(prompt) !== null;
}

// ------------------------------------------------------------------- topic

function contentTokens(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z-]{2,}/g) || []) {
    if (!STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

function extractCreativeTopic(prompt, form) {
  let t = String(prompt || '');
  t = t.replace(/[""''"]/g, ' ');
  for (const f of FORM_PATTERNS) t = t.replace(f.re, ' ');
  t = t.replace(/\b(write|writes|writing|wrote|compose[sd]?|composing|create[sd]?|creating|draft(?:ed|ing)?|generate[sd]?|produc(?:e[sd]?|ing)|give me|make me|tell me|pen)\b/gi, ' ');
  t = t.replace(/\b(include|includes|including|contain|contains|containing|mention|mentions|use|uses|using)\b/gi, ' ');
  t = t.replace(/\b(about|on|of|for|to|a|an|the|in|with|without|and|or|by|from|at|as|is|are|be|it|its|this|that|my|your|our|their|how|am|we|you|me|up)\b/gi, ' ');
  t = t.replace(/\b(exactly|at least|at most|up to|no more than|no less than|fewer|less|more|many|several|under|over|keep it|please|must|should|but|first|repeat)\b/gi, ' ');
  // Instruction scaffolding is not the topic: "repeat the exact request",
  // "give your answer", "in your response". Without this, "request" became
  // the topic for repeat-demands and the attempt went off-topic.
  t = t.replace(/\b(request|requests|response|answer|prompt|below|above|verbatim|word for word|without change|change|word|words|keyword|keywords)\b/gi, ' ');
  t = t.replace(/\b\d+\s*(lines?|sentences?|words?|paragraphs?|stanzas?|sections?|syllables?)\b/gi, ' ');
  t = t.replace(/[^a-zA-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
  return words.slice(0, 6).join(' ');
}

function extractSpeakers(prompt) {
  const m = String(prompt || '').match(/\bbetween\s+(?:a\s+|an\s+|the\s+)?([a-zA-Z][a-zA-Z ]+?)\s+and\s+(?:a\s+|an\s+|the\s+)?([a-zA-Z][a-zA-Z ]+?)(?:[.,!?]|$)/i);
  const cap = s => String(s || '').trim().replace(/\s+/g, ' ').replace(/^(.)/, c => c.toUpperCase());
  if (m) return [cap(m[1]), cap(m[2])];
  return ['Speaker 1', 'Speaker 2'];
}

function extractRecipient(prompt) {
  const m = String(prompt || '').match(/\bto\s+(?:my\s+|a\s+|the\s+)?([a-z]{2,20})\b/i);
  const who = m ? m[1].toLowerCase() : 'friend';
  if (/friend|vote|team|all|everyone/i.test(who)) return 'friend';
  return who.charAt(0).toUpperCase() + who.slice(1);
}

// ------------------------------------------------------------ plan as data

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14 };
function toNum(s) {
  const w = String(s || '').toLowerCase();
  if (NUM_WORDS[w]) return NUM_WORDS[w];
  const n = parseInt(w, 10);
  return Number.isFinite(n) ? n : 0;
}
const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen)';

function parseStructuralPlan(prompt, form) {
  const t = String(prompt || '');
  const plan = { form, unit: PARA_FORMS.has(form) ? 'paragraphs' : 'lines', targetLines: 0, targetParagraphs: 0, targetSentences: 0, explicit: {} };
  let m;
  const lineM = t.match(new RegExp(`exactly\\s+${NUM}\\s+lines?`, 'i'))
    || t.match(/\b(\d+)-line\b/i)
    || t.match(new RegExp(`in\\s+${NUM}\\s+lines?`, 'i'))
    || t.match(new RegExp(`(?:at most|no more than|under|less than|up to)\\s+${NUM}\\s+lines?`, 'i'));
  if (lineM && toNum(lineM[1]) > 0) { plan.targetLines = toNum(lineM[1]); plan.unit = 'lines'; plan.explicit.lines = true; }
  const paraM = t.match(new RegExp(`exactly\\s+${NUM}\\s+paragraphs?`, 'i'))
    || t.match(new RegExp(`(?:at most|no more than|up to)\\s+${NUM}\\s+paragraphs?`, 'i'));
  const paraLessM = t.match(new RegExp(`(?:less than|fewer than|under)\\s+${NUM}\\s+paragraphs?`, 'i'));
  const paraHit = paraM || paraLessM;
  if (paraHit && toNum(paraHit[1]) > 0) {
    // "at most N" is satisfied by exactly N; "fewer than N" needs N-1.
    plan.targetParagraphs = paraLessM ? Math.max(1, toNum(paraHit[1]) - 1) : toNum(paraHit[1]);
    plan.unit = 'paragraphs'; plan.explicit.paragraphs = true;
  }
  const sentM = t.match(new RegExp(`exactly\\s+${NUM}\\s+sentences?`, 'i'))
    || t.match(new RegExp(`(?:at least|no fewer than)\\s+${NUM}\\s+sentences?`, 'i'))
    || t.match(new RegExp(`(?:at most|no more than|up to)\\s+${NUM}\\s+sentences?`, 'i'));
  const sentLessM = t.match(new RegExp(`(?:less than|fewer than|under)\\s+${NUM}\\s+sentences?`, 'i'));
  const sentHit = sentM || sentLessM;
  if (sentHit && toNum(sentHit[1]) > 0) {
    plan.targetSentences = sentLessM ? Math.max(1, toNum(sentHit[1]) - 1) : toNum(sentHit[1]);
    plan.explicit.sentences = true;
  }
  if (/sections?/i.test(t) && /\b\d+\b/.test(t)) plan.unsupportedSections = true;
  // Paragraph dividers: "separate paragraphs with ***", "use *** as a divider".
  if (/separat\w+[\s\S]{0,60}\*{3}|\*{3}[\s\S]{0,20}separat|markdown divider/i.test(t)) plan.divider = '***';

  if (!plan.explicit.lines && !plan.explicit.paragraphs && !plan.explicit.sentences) {
    switch (form) {
      case 'haiku': plan.targetLines = 3; plan.unit = 'lines'; break;
      case 'limerick': plan.targetLines = 5; plan.unit = 'lines'; break;
      case 'sonnet': plan.targetLines = 14; plan.unit = 'lines'; break;
      case 'riddle': plan.targetLines = 4; plan.unit = 'lines'; break;
      case 'joke': plan.targetSentences = 2; plan.unit = 'paragraphs'; break;
      case 'slogan': plan.targetLines = 2; plan.unit = 'lines'; break;
      case 'ad': plan.targetLines = 3; plan.unit = 'lines'; break;
      case 'dialogue': plan.targetLines = 6; plan.unit = 'lines'; break;
      case 'song': case 'rap': case 'poem': case 'ode': plan.unit = 'lines'; break;
      case 'story': case 'speech': case 'letter': plan.unit = 'paragraphs'; break;
      case 'none': plan.targetSentences = 4; plan.unit = 'paragraphs'; break;
    }
  }
  return plan;
}

// ------------------------------------------------------------------- beats

function rankByTopic(sentences, topicTokens) {
  return sentences
    .map((s, i) => ({ s: String(s), i, overlap: [...topicTokens].filter(tok => new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(String(s).toLowerCase())).length }))
    .sort((a, b) => b.overlap - a.overlap || a.i - b.i);
}

/**
 * Order picked sentences as beats: open (most topical) -> turn -> land
 * (the picked sentence latest in original pool order, for a closing feel).
 * Beats are data: verbatim grounded sentences, never transformed.
 */
function orderBeats(ranked, n) {
  const picked = ranked.slice(0, n);
  if (picked.length <= 1) return picked.map(r => r.s);
  const open = picked[0];
  const rest = picked.slice(1);
  let landIdx = 0;
  for (let i = 1; i < rest.length; i++) if (rest[i].i > rest[landIdx].i) landIdx = i;
  const land = rest[landIdx];
  const turn = rest.filter((_, i) => i !== landIdx);
  return [open.s, ...turn.map(r => r.s), land.s];
}

// -------------------------------------------------------------------- fill

function titleCaseTopic(topic) {
  return String(topic || '').split(/\s+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Untitled';
}

function toParagraphs(sentences, per = 3) {
  const paras = [];
  for (let i = 0; i < sentences.length; i += per) paras.push(sentences.slice(i, i + per).join(' '));
  return paras.filter(Boolean);
}

/**
 * Fill the structural plan from grounded sentences. Returns
 * { text, used } or null when the pool cannot cover the structural demand
 * (honest shortfall). `used` records the effective line/paragraph/sentence
 * targets the fill committed to, so verification checks what was planned,
 * not the soft defaults.
 */
function fillCreative(plan, pool, topic, prompt) {
  const topicTokens = contentTokens(topic);
  const ranked = rankByTopic(pool, topicTokens);
  const form = plan.form;

  // Strict demand only: explicit prompt demands and fixed-form structures.
  // Soft defaults are resolved against the pool below, never gated here.
  const fixedForm = ['haiku', 'limerick', 'sonnet', 'riddle'].includes(form);
  const demand = (() => {
    if (plan.unsupportedSections) return Infinity;
    if (plan.explicit.lines) return plan.targetLines;
    if (plan.explicit.paragraphs) return plan.targetParagraphs;
    if (plan.explicit.sentences) return plan.targetSentences;
    if (fixedForm && plan.targetLines) return plan.targetLines;
    return 0;
  })();
  if (demand === Infinity) return null;
  // Conflicting explicit demands (4 lines but 2 sentences, one per line).
  if (plan.explicit.lines && plan.explicit.sentences && plan.targetLines !== plan.targetSentences) return null;

  const minPool = demand > 0 ? demand : 2;
  if (ranked.length < minPool) return null;

  if (plan.unit === 'lines') {
    // Fixed forms (haiku/limerick/sonnet/riddle) have a defining structure:
    // softening the line count would mislabel the form, so the pool must
    // cover it. Open forms soften to what the pool offers.
    const n = plan.explicit.lines || fixedForm
      ? (plan.targetLines || Math.min(8, ranked.length))
      : Math.min(plan.targetLines || 8, ranked.length);
    if (ranked.length < n) return null;
    const ordered = orderBeats(ranked, n);
    const used = { lines: n, paragraphs: 0, sentences: 0 };
    if (form === 'dialogue') {
      const [a, b] = extractSpeakers(prompt);
      return { text: ordered.map((s, i) => `${i % 2 === 0 ? a : b}: ${s}`).join('\n'), used };
    }
    if (form === 'slogan' || form === 'ad') {
      // Honest slogan/ad: topic header + the most topical grounded sentences.
      // No invented claims, only selection and arrangement.
      const header = titleCaseTopic(topic);
      return { text: [header, ...ordered.slice(0, Math.max(0, n - 1))].join('\n'), used };
    }
    return { text: ordered.join('\n'), used };
  }

  // paragraphs
  const n = plan.explicit.sentences
    ? plan.targetSentences
    : Math.min(plan.targetSentences || 9, ranked.length);
  if (ranked.length < n) return null;
  const ordered = orderBeats(ranked, n);
  const joiner = plan.divider ? `\n${plan.divider}\n` : '\n\n';
  const finishParas = paras => ({ text: paras.join(joiner), used: { lines: 0, paragraphs: paras.length, sentences: n } });
  if (form === 'letter') {
    const dear = `Dear ${extractRecipient(prompt)},`;
    if (plan.targetParagraphs) {
      // Fold the greeting into paragraph one so the count holds exactly.
      const per = Math.max(1, Math.ceil(ordered.length / plan.targetParagraphs));
      const body = toParagraphs(ordered, per).slice(0, plan.targetParagraphs);
      body[0] = `${dear} ${body[0]}`;
      return finishParas(body);
    }
    return { text: `${dear}\n\n${toParagraphs(ordered, 3).join('\n\n')}`, used: { lines: 0, paragraphs: 0, sentences: n } };
  }
  if (plan.targetParagraphs) {
    const per = Math.max(1, Math.ceil(ordered.length / plan.targetParagraphs));
    return finishParas(toParagraphs(ordered, per).slice(0, plan.targetParagraphs));
  }
  return finishParas(toParagraphs(ordered, 3));
}

// -------------------------------------------------------------- verify

const countLines = text => String(text || '').split('\n').map(l => l.trim()).filter(Boolean).length;
const countParagraphs = text => String(text || '').split(/\n\s*\n|\n\*{3}\n/).map(p => p.trim()).filter(p => p && p !== '***').length;
const countSentences = text => (String(text || '').match(/[^.!?]+[.!?]+["']?/g) || []).length;

function structuralViolations(text, used) {
  let v = 0;
  if (used.lines && countLines(text) !== used.lines) v++;
  if (used.paragraphs && countParagraphs(text) !== used.paragraphs) v++;
  if (used.sentences && countSentences(text) !== used.sentences) v++;
  return v;
}

function surfaceViolations(text, prompt) {
  if (!repair || typeof repair.violations !== 'function' || typeof repair.extractConstraints !== 'function') return 0;
  try { return repair.violations(text, repair.extractConstraints(prompt)).length; }
  catch (_) { return 0; }
}

// ------------------------------------------------------------------ store

function sentencesForTopic(topic, storePath) {
  let entries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath || STORE_PATH, 'utf8'));
    if (Array.isArray(parsed)) entries = parsed;
  } catch (_) { return []; }
  const topicTokens = contentTokens(topic);
  if (!topicTokens.size) return [];
  const scored = [];
  for (const e of entries) {
    const eTokens = contentTokens([e.topic, ...((e.sentences || []).slice(0, 3))].join(' '));
    let overlap = 0;
    for (const tok of topicTokens) if (eTokens.has(tok)) overlap++;
    if (overlap > 0) scored.push({ e, overlap });
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  const out = [];
  const seen = new Set();
  for (const { e } of scored.slice(0, 4)) {
    for (const s of (e.sentences || [])) {
      const clean = String(s || '').replace(/\s+/g, ' ').trim();
      const key = clean.toLowerCase();
      if (clean.length >= 25 && clean.length <= 500 && !seen.has(key)) {
        seen.add(key);
        out.push(clean);
      }
      if (out.length >= 20) break;
    }
    if (out.length >= 20) break;
  }
  return out;
}

// ------------------------------------------------------- fiction (2026-09-23)
// Greg directive: no creative refusals, ever. When grounded sentences are
// thin, FICTION mode composes freely instead of refusing: dictionary glosses
// (true by definition) plus deterministic imaginative templates (clearly
// fictional narrative). Fiction never asserts real-world facts — the creative
// form itself (poem, story, ...) frames the output as invention — and it
// never fakes feelings or uses em dashes. Deterministic: seeded by
// FNV-1a(topic|form|prompt-length); no Math.random anywhere.

function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function fictionRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FICTION_NOUNS = ('road night wind light shadow morning journey home river mountain ocean ' +
  'forest meadow dawn dusk rain snow star moon sun cloud thunder silence echo dream memory hand ' +
  'door window bridge tower garden field valley hill stone fire ice song dance whisper harbor ' +
  'lantern bell drum flute candle mirror map compass anchor feather leaf root thorn blossom').split(' ');
const FICTION_VERBS = ('wait wander drift fall rise sing sleep wake run walk turn return remember ' +
  'forget hold release gather scatter kindle follow lead carry lift bend mend open close cross ' +
  'climb whisper echo linger vanish tremble glow fade').split(' ');
const FICTION_ADJS = ('soft still old new cold warm dark bright quiet gentle wild calm deep high ' +
  'low long vast narrow empty heavy slow swift patient restless lonely tender fierce pale golden ' +
  'silver misty solemn distant ragged').split(' ');
const FICTION_ADVS = ('softly slowly quietly patiently endlessly gently bravely alone together ' +
  'onward upward homeward').split(' ');

// Crude singular/plural for verb agreement: a topic ending in s (not ss/us/is)
// reads plural. Heuristic, fiction-only.
function fictionPlural(topic) {
  const w = String(topic || '').trim().toLowerCase().split(/\s+/).pop() || '';
  if (!w || /(ss|us|is|news|glass)$/.test(w)) return false;
  return /s$/.test(w);
}
// Third-person singular conjugation for the template verbs.
function agreeV(verb, plural) {
  if (plural) return verb;
  if (/[^aeiou]y$/.test(verb)) return verb.slice(0, -1) + 'ies';
  if (/(s|sh|ch|x|z)$/.test(verb)) return verb + 'es';
  return verb + 's';
}
const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

// Every template keeps verb agreement on bank nouns (always singular) or uses
// agreeV(topic) for the topic slot — never produces "the classes waits".
function fictionSentence(rng, topic) {
  // Strip relative clauses ("a woman named Sarah who..." -> "a woman named Sarah")
  // so the topic slots cleanly into templates.
  const T = (topic || 'the world').replace(/\s+\b(who|which|that)\b.*$/, '').trim() || 'the world';
  // Subject form: no doubled article ("The the world") and no article before
  // a name-like topic ("The Harry pet").
  const subjT = /^[A-Z]/.test(T) ? T : 'The ' + T.replace(/^(the|a|an)\s+/i, '');
  const pl = fictionPlural(T);
  const noun = () => FICTION_NOUNS[Math.floor(rng() * FICTION_NOUNS.length)];
  const noun2 = () => { let w = noun(); let g = 0; while (w === lastNoun && g++ < 8) w = noun(); lastNoun = w; return w; };
  let lastNoun = '';
  const verb = () => FICTION_VERBS[Math.floor(rng() * FICTION_VERBS.length)];
  const adj = () => FICTION_ADJS[Math.floor(rng() * FICTION_ADJS.length)];
  const adv = () => FICTION_ADVS[Math.floor(rng() * FICTION_ADVS.length)];
  const templates = [
    () => `The ${adj()} ${noun()} ${agreeV(verb(), false)} for ${T}.`,
    () => `${cap1(adj())} ${noun()} falls on ${T}.`,
    () => `Through the ${adj()} ${noun()}, ${T} ${agreeV(verb(), pl)} ${adv()}.`,
    () => `The ${noun()} of ${T} ${agreeV(verb(), false)} in the ${noun2()}.`,
    () => `No ${noun()} can hold ${T} for long.`,
    () => `When the ${noun()} ${agreeV(verb(), false)}, ${T} ${agreeV(verb(), pl)} ${adv()}.`,
    () => `${cap1(T)} ${agreeV(verb(), pl)} where the ${adj()} ${noun()} ${agreeV(verb(), false)}.`,
    () => `Under ${adj()} skies, the ${noun()} dreams of ${T}.`,
    () => `${cap1(noun())} and ${noun2()} follow ${T} home.`,
    () => `${subjT} ${agreeV(verb(), pl)} through the ${adj()} ${noun()}.`,
    () => `In the ${noun()}, ${T} ${agreeV(verb(), pl)} ${adv()}.`,
    () => `For ${T}, the ${noun()} ${agreeV(verb(), false)} ${adv()}.`,
  ];
  return templates[Math.floor(rng() * templates.length)]();
}

// How many fiction sentences the prompt's structural/word demands need.
function fictionSentenceDemand(prompt, form) {
  const t = String(prompt || '');
  let n = 12;
  const plan = parseStructuralPlan(t, form);
  if (plan.explicit.lines) n = Math.max(n, plan.targetLines);
  if (plan.explicit.paragraphs) n = Math.max(n, plan.targetParagraphs * 3);
  if (plan.explicit.sentences) n = Math.max(n, plan.targetSentences);
  if (['haiku', 'limerick', 'sonnet', 'riddle'].includes(form)) n = Math.max(n, plan.targetLines || 0);
  const wm = t.match(/(\d+)\s*\+\s*words?|at least (\d+) words?/i);
  if (wm) n = Math.max(n, Math.ceil(parseInt(wm[1] || wm[2], 10) / 6));
  const sm = t.match(/(\d+)\s+sections?/i);
  if (sm) n = Math.max(n, parseInt(sm[1], 10) * 5);
  return Math.min(n, 60);
}

// Scale a structural plan to word-count demands in fiction mode (a "200+ word
// poem" needs ~34 lines, not the 8-line soft default).
function scaleFictionPlan(plan, prompt) {
  const p = Object.assign({}, plan, { explicit: Object.assign({}, plan.explicit) });
  const wm = String(prompt || '').match(/(\d+)\s*\+\s*words?|at least (\d+) words?/i);
  const minWords = wm ? parseInt(wm[1] || wm[2], 10) : 0;
  if (minWords > 0 && p.unit === 'lines' && !p.explicit.lines) {
    p.targetLines = Math.max(p.targetLines || 0, Math.ceil(minWords / 6));
  }
  if (minWords > 0 && p.unit === 'paragraphs' && !p.explicit.sentences) {
    p.targetSentences = Math.max(p.targetSentences || 0, Math.ceil(minWords / 10));
  }
  return p;
}

// Fiction topic: the creative ask lives in the prompt's first sentence;
// later sentences are mechanical constraints ("4 sections", "at least 5
// sentences", "use markdown"). Strip instruction scaffolding that the
// general extractor keeps, plus named-person frames and relative clauses.
const FICTION_TOPIC_DROP = new Set(('least most more less fewest many much such own very ' +
  'short long funny silly markdown headers header sections section italicize italics highlight ' +
  'formatting divider response answer').split(' '));
function fictionTopic(prompt, form, fallbackTopic) {
  const clean = t => String(t || '')
    .replace(/\b(markdown|headers?|sections?|italicize|italics?|highlights?|formatting|dividers?)\b/gi, ' ')
    .replace(/\b(man|woman|boy|girl|person|child)\s+named\b/gi, ' ')
    .replace(/\s+\b(who|which|that)\b.*$/, '')
    .split(/\s+/).filter(w => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()) && !FICTION_TOPIC_DROP.has(w.toLowerCase())
      && !/(ally|ably|ibly|fully|lessly|ously|ively)$/.test(w))
    .join(' ').replace(/\s+/g, ' ').trim();
  const first = String(prompt || '').split(/(?<=[.?!])\s+/)[0] || '';
  // Prefer the "about X" phrase, cut at relative pronouns: the topic is the
  // thing itself ("zibberwort"), not its clause. (The general extractor drops
  // the pronoun but keeps the clause, which poisons every template.)
  // Without "about", the subject is usually the last noun phrase
  // ("a new line of shoes" -> "shoes").
  let t = '';
  const aboutM = first.match(/\babout\b\s+([^.,;!?]+)/i);
  if (aboutM) {
    t = aboutM[1].replace(/\s+\b(who|which|that)\b.*$/i, '');
  } else {
    const lastOf = first.match(/.*\bof\b\s+([^.,;!?]+)/i);
    t = lastOf
      ? lastOf[1].replace(/\s+\b(who|which|that)\b.*$/i, '')
      : extractCreativeTopic(first, form);
  }
  t = clean(t);
  if (!t) t = clean(fallbackTopic);
  const words = t.split(' ').filter(Boolean);
  if (words.length > 5) t = words.slice(-5).join(' ');
  return t || 'the world';
}

// Build the fiction pool: WordNet glosses for lowercase (common-noun) topic
// tokens only — capitalized tokens are treated as names and never get
// dictionary glosses (avoids attaching "Sarah (Old Testament)..." to a
// fictional Sarah) — plus deterministic imaginative sentences.
function fictionPoolForTopic(topic, form, prompt) {
  const pool = [];
  const seen = new Set();
  const push = s => {
    const clean = String(s || '').replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase();
    if (clean.length >= 25 && clean.length <= 500 && !seen.has(key) && !FAKE_FEELING_RE.test(clean)) {
      seen.add(key);
      pool.push(clean);
    }
  };
  const escRe = w => String(w || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripQuotes = g => String(g || '').replace(/\s*"[^"]*"\s*/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    const wn = require(path.join(__dirname, '..', 'swarm_wordnet_capability.js'));
    if (wn && typeof wn.define === 'function') {
      for (const tok of [...contentTokens(topic)].slice(0, 4)) {
        // lowercase-in-prompt check: skip names ("Sarah", "Harry"); skip
        // verb-form tokens ("missing") and non-noun first senses.
        if (!new RegExp(`\\b${escRe(tok)}\\b`).test(String(prompt || ''))) continue;
        if (/(ing|ed)$/.test(tok)) continue;
        let defs = [];
        try { defs = wn.define(tok) || []; } catch (_) {}
        if (!defs.length || defs[0].pos !== 'noun') continue;
        for (const d of defs.slice(0, 1)) {
          const gloss = stripQuotes(d.gloss).replace(/;.*$/, '').trim();
          if (gloss.length < 10 || /^(not|no|never)\b/i.test(gloss)) continue;
          const titled = tok.charAt(0).toUpperCase() + tok.slice(1);
          const sent = /^(a|an|the)\b/i.test(gloss)
            ? `${titled} is ${gloss}.`
            : `${titled} is ${/^[aeiou]/i.test(gloss) ? 'an' : 'a'} ${gloss}.`;
          push(sent);
        }
        if (pool.length >= 6) break;
      }
    }
  } catch (_) { /* WordNet is optional */ }
  const need = fictionSentenceDemand(prompt, form);
  const rng = fictionRng(fnv1a32(`${topic}|${form}|${String(prompt || '').length}`));
  let guard = 0;
  while (pool.length < need && guard++ < need * 6) push(fictionSentence(rng, topic));
  return pool;
}

// Sectioned fiction output ("4 sections marked with markdown headers").
// Headers count as lines so the structural check holds. When the prompt
// demands italics, each content line is wrapped in single asterisks. When
// the prompt names the marker ("marked with SECTION X"), that label is used
// for the headers instead of markdown ## headers.
function fillFictionSections(pool, topic, prompt) {
  const m = String(prompt || '').match(/(\d+)\s+sections?/i);
  const count = Math.min(Math.max(parseInt(m ? m[1] : 0, 10) || 2, 1), 8);
  const wantItalics = /italici/i.test(String(prompt || ''));
  const sectionLabel = /SECTION\s+X/i.test(String(prompt || ''));
  const per = 4;
  const parts = [];
  let idx = 0;
  for (let s = 1; s <= count; s++) {
    const lines = [];
    for (let k = 0; k < per && idx < pool.length; k++, idx++) {
      const line = pool[idx];
      lines.push(wantItalics ? `*${line}*` : line);
    }
    const header = sectionLabel ? `SECTION ${s}` : `## ${titleCaseTopic(topic)}, Part ${s}`;
    parts.push(header + '\n' + lines.join('\n'));
  }
  const totalLines = parts.reduce((n, p) => n + p.split('\n').filter(l => l.trim()).length, 0);
  return { text: parts.join('\n\n'), used: { lines: totalLines, paragraphs: 0, sentences: 0 } };
}

// ---------------------------------------------------------------- attempt

function attemptCreative({ prompt, sentences = [], storePath, fiction = false, forceFiction = false } = {}) {
  const detected = detectCreativeForm(prompt);
  if (!detected) return null;
  // Fiction mode: attempt the creative form even when it is paired with a
  // contradictory code demand — the invention is the point, the code demand
  // cannot be satisfied and is dropped rather than refused.
  if (detected.impossible && !fiction) return { impossible: true, form: detected.form, topic: '', text: '' };
  const form = detected.form;
  let topic = extractCreativeTopic(prompt, form);

  let pool = (sentences || []).map(s => String(s || '').replace(/\s+/g, ' ').trim()).filter(s => s.length >= 20);
  if (!pool.length && storePath !== false) pool = sentencesForTopic(topic, storePath);

  // Fiction fallback (Greg directive 2026-09-23: no creative refusals): when
  // grounded sentences are thin — or the caller forces it after a grounded
  // attempt already failed — compose freely from the fiction pool.
  const fictionMode = fiction && (forceFiction || pool.length < 2);
  if (fictionMode) {
    topic = fictionTopic(prompt, form, topic);
    pool = fictionPoolForTopic(topic, form, prompt);
  }
  if (pool.length < 2) return null;

  // Thin-pool top-up: when the pool has genuine topical grounding but too few
  // sentences for a real attempt (soft-default story/speech want 3+), expand
  // via the topic's WordNet hypernyms. Grounded dictionary definitions only,
  // never synthesized; they rank last so topical sentences lead. No topical
  // grounding at all -> no top-up, stays an honest shortfall.
  const escRe = w => String(w || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const topicTokens = contentTokens(topic);
  const hasTopicalGrounding = [...topicTokens].some(tok =>
    pool.some(s => new RegExp(`\\b${escRe(tok)}\\b`, 'i').test(s)));
  if (pool.length > 0 && pool.length < 3 && hasTopicalGrounding) {
    try {
      const wn = require(path.join(__dirname, '..', 'swarm_wordnet_capability.js'));
      if (wn && typeof wn.define === 'function') {
        const stripQuotes = g => String(g || '').replace(/\s*"[^"]*"\s*/g, ' ').replace(/\s+/g, ' ').trim();
        const contentToks = s => new Set((stripQuotes(s).toLowerCase().match(/[a-z][a-z-]{2,}/g) || [])
          .filter(w => !STOPWORDS.has(w)).map(porterStemWord).filter(w => w.length >= 2));
        const seen = new Set(pool.map(s => s.toLowerCase()));
        for (const tok of [...topicTokens].slice(0, 3)) {
          let topicSenses = [];
          try { topicSenses = wn.define(tok) || []; } catch (_) { /* next token */ }
          // Topic context: the topic token plus its own gloss tokens, so the
          // hypernym's most related sense wins (not the first dictionary
          // sense, which may be a chemistry/mechanics homonym).
          const topicCtx = new Set([porterStemWord(tok)]);
          for (const s2 of topicSenses.slice(0, 2)) for (const w of contentToks(s2.gloss)) topicCtx.add(w);
          let hypernyms = [];
          try {
            hypernyms = [...new Set(topicSenses.flatMap(s2 => s2.hypernyms || []).map(h => String(h).replace(/_/g, ' ')))].slice(0, 2);
          } catch (_) { /* next token */ }
          const banW = new Set([porterStemWord(tok)]);
          for (const h of hypernyms) {
            let hs = [];
            try { hs = wn.define(h) || []; } catch (_) { /* next hypernym */ }
            const banH = porterStemWord(h);
            // Pick the hypernym sense closest to the topic; skip the
            // hypernym entirely when no sense relates (avoids homonym drift).
            let best = null, bestScore = 0;
            for (const s2 of hs.slice(0, 6)) {
              const cand = contentToks(s2.gloss);
              for (const syn of (s2.synonyms || [])) for (const w of contentToks(syn)) cand.add(w);
              cand.delete(banH);
              for (const bw of banW) cand.delete(bw);
              let score = 0;
              for (const w of cand) if (topicCtx.has(w)) score++;
              if (score > bestScore) { bestScore = score; best = s2; }
            }
            if (!best) continue;
            const gloss = stripQuotes(best.gloss).replace(/;.*$/, '').trim();
            if (gloss.length < 10) continue;
            const titled = h.charAt(0).toUpperCase() + h.slice(1);
            const sent = /^(a|an|the)\b/i.test(gloss) || /^\(/.test(gloss)
              ? `${titled} is ${gloss}.`
              : `${titled} is ${/^[aeiou]/i.test(gloss) ? 'an' : 'a'} ${gloss}.`;
            const key = sent.toLowerCase();
            if (sent.length >= 25 && sent.length <= 500 && !seen.has(key) && !FAKE_FEELING_RE.test(sent)) {
              seen.add(key);
              pool.push(sent);
            }
            if (pool.length >= 6) break;
          }
          if (pool.length >= 6) break;
        }
      }
    } catch (_) { /* WordNet is optional; the pool stays as-is */ }
  }
  if (pool.length < 2) return null;

  let plan = parseStructuralPlan(prompt, form);
  // Fiction mode: scale the plan to word-count demands and serve sectioned
  // prompts directly (fillCreative treats sections as unsupported).
  if (fictionMode) plan = scaleFictionPlan(plan, prompt);
  // "N sections" is document structure only when the prompt says how the
  // sections are marked ("marked with SECTION X", "markdown headers").
  // Otherwise ("highlight 6 sections") it means highlight spans: fall back
  // to the form's own structural default. ("markdown" alone must not count
  // as a section marker.)
  const structuralSections = fictionMode && plan.unsupportedSections &&
    /marked with|mark the|headers?|divid|separat|beginning/i.test(prompt);
  if (fictionMode && plan.unsupportedSections && !structuralSections) {
    plan = Object.assign({}, plan, { unsupportedSections: false });
    plan = scaleFictionPlan(plan, prompt);
  }
  let filled = null;
  if (structuralSections) {
    filled = fillFictionSections(pool, topic, prompt);
  } else {
    filled = fillCreative(plan, pool, topic, prompt);
  }
  // Highlight/italic/bold span demands ("highlight 6 sections", "italicize
  // at least 2 sections"): wrap each content line in single asterisks when
  // the output is not already sectioned. Line counts are unchanged.
  if (filled && fictionMode && !structuralSections && /highlight|italici|\bbold\b/i.test(prompt)) {
    filled = {
      text: filled.text.split('\n').map(l => {
        const t = l.trim();
        if (!t || /^\*.*\*$/.test(t) || /^#{1,6}\s/.test(t)) return l;
        return `*${t}*`;
      }).join('\n'),
      used: filled.used
    };
  }
  // Totality: fiction mode always returns text when a form was detected.
  // If the structural fill somehow failed, join fiction sentences directly.
  if (!filled && fictionMode) {
    const n = Math.min(pool.length, Math.max(4, fictionSentenceDemand(prompt, form)));
    const body = pool.slice(0, n);
    const text0 = plan.unit === 'lines' ? body.join('\n') : toParagraphs(body, 3).join('\n\n');
    filled = { text: text0, used: { lines: 0, paragraphs: 0, sentences: 0 } };
  }
  if (!filled) return null;
  const raw = filled.text;
  const used = filled.used;

  let text = raw;
  if (repair && typeof repair.verifyAndRepair === 'function') {
    try { text = repair.verifyAndRepair(raw, prompt); } catch (_) { text = raw; }
  }
  // Prefer the version with fewer structural violations, then fewer surface
  // violations. Repair must never break the structure the fill built.
  const scoreOf = t => [structuralViolations(t, used), surfaceViolations(t, prompt)];
  const [r0, s0] = scoreOf(raw);
  const [r1, s1] = scoreOf(text);
  if (r0 < r1 || (r0 === r1 && s0 < s1)) text = raw;
  if (structuralViolations(text, used) > 0) return null;
  if (FAKE_FEELING_RE.test(text)) return null;
  // "Mention the name X only once": keep the first occurrence, replace later
  // ones with a pronoun. Fiction-mode only; deterministic.
  if (fictionMode) {
    const onceM = String(prompt || '').match(/mention(?: the name)? (\w+) only once/i);
    if (onceM) {
      const nm = onceM[1];
      const nmRe = new RegExp(`\\b${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      let seenOnce = false;
      text = text.replace(nmRe, mt => (seenOnce ? 'they' : (seenOnce = true, mt)));
    }
  }
  text = text.replace(/\u2014/g, ',').replace(/ {2,}/g, ' ').trim();
  if (!text) return null;

  return {
    text,
    form,
    topic,
    trace: {
      unit: plan.unit,
      usedLines: used.lines || null,
      usedParagraphs: used.paragraphs || null,
      usedSentences: used.sentences || null,
      poolSize: pool.length,
      fictionMode: !!fictionMode,
      structuralViolations: structuralViolations(text, used),
      surfaceViolations: surfaceViolations(text, prompt),
      repaired: text !== raw
    }
  };
}

module.exports = {
  detectCreativeForm,
  isCreativeRequest,
  extractCreativeTopic,
  extractSpeakers,
  parseStructuralPlan,
  sentencesForTopic,
  attemptCreative,
  countLines,
  countParagraphs,
  countSentences,
  fictionPoolForTopic,
  fictionTopic,
  scaleFictionPlan,
  fictionSentenceDemand,
  FORM_PATTERNS
};

if (require.main === module) {
  const prompt = process.argv.slice(2).join(' ') || 'Write a poem about the sea in exactly 4 lines.';
  console.log(JSON.stringify(detectCreativeForm(prompt)));
  const a = attemptCreative({ prompt });
  console.log(a && !a.impossible ? a.text : JSON.stringify(a));
}
