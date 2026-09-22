#!/usr/bin/env node
/**
 * lari_generative_core.js — novel generative core for Small Lari.
 *
 * Architecture: generation as COMPOSITION OF INDUCED OPERATORS, not sequence
 * prediction. There is no n-gram table, no language model, no token
 * predictor here. The pipeline is:
 *
 *   prompt -> MEANING PLANNER -> operator trace -> DETERMINISTIC RENDERER
 *            -> English text -> MECHANICAL VERIFY -> (repair x3 | null)
 *
 * A "meaning plan" is an ordered list of typed operator applications, e.g.
 *   [{ op: 'define', slots: { term: 'photosynthesis', gloss: '...' } },
 *    { op: 'cause',  slots: { cause: '...', effect: '...' } },
 *    { op: 'conclude', slots: { point: '...' } }]
 * The renderer turns each application into sentences via that operator's
 * phrasing patterns. The full sentence is novel composition: slot fillers
 * come from researched knowledge, but the sentence as a whole was never
 * stored anywhere.
 *
 * CONSTRAINTS SHAPE THE PLAN, not post-generation. "Exactly 3 sentences"
 * builds a trace that yields exactly 3 sentences; "no commas" selects
 * comma-free patterns up front; keyword demands become slots inside
 * operators. A post-generation VERIFY then checks the rendered text
 * mechanically; on failure the planner re-plans (up to 3 tries) and gives
 * up honestly (returns null) rather than shipping text that fails its own
 * constraints.
 *
 * MERGE CONTRACT for the discourse-operator learning loop
 * --------------------------------------------------------
 * learned_discourse_operators.json entries carry
 *   payload.operatorAst = { kind, relationType, roles[], markers[],
 *                           surfaceOrder }
 * mergeInducedOperators(json) maps each ACTIVE entry onto a generative
 * operator:
 *   - relationType -> operator name via RELATION_TO_OPERATOR
 *     (condition->condition, contrast->contrast, purpose->purpose,
 *      cause->cause, sequence->sequence, exemplify->exemplify; unknown
 *      relationTypes are SKIPPED, never guessed)
 *   - roles[] -> slot names (roles must be a subset of the operator's
 *     declared slots, else skipped)
 *   - markers[] -> additional deterministic phrasing patterns of the form
 *     "{left} {marker} {right}" (surfaceOrder left_marker_right) or
 *     "{marker} {left}, {right}" (marker_left_right); markers are appended
 *     AFTER the hand-written patterns so seeded selection stays stable
 *     for existing indices
 *   - confidence < 0.5 entries are skipped
 * The merge never mutates OPERATORS in place: it returns a new library
 * object. Hand-written operators are the seed; induced ones extend them.
 *
 * Determinism: pattern selection is seeded by FNV-1a hash of
 * (prompt + op index + attempt number). No Math.random anywhere.
 *
 * Zero external model calls. No neural inference. No fake feelings.
 * Honest boundaries: non-English response demands, code/JSON demands, and
 * math return null (the old behavior keeps those).
 */
'use strict';

// ---------------------------------------------------------------------------
// small deterministic utilities
// ---------------------------------------------------------------------------

function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function cap(s) {
  s = String(s || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function lowFirst(s) {
  s = String(s || '').trim();
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
function stripTrailingPunct(s) {
  return String(s || '').trim().replace(/[.!?;:,\s]+$/, '');
}
function countWords(t) {
  // aligned with IFEval instructions_util.count_words: RegexpTokenizer(r"\w+")
  return (String(t || '').match(/\w+/g) || []).length;
}
function countSentences(t) {
  return String(t || '').split(/[.!?]+/).filter(x => x.trim()).length;
}
function countParagraphs(t) {
  // divider-joined paragraphs ("a\n***\nb") count too
  const norm = String(t || '').replace(/\n\s*\*\*\*\s*\n/g, '\n\n').replace(/\n\s*---\s*\n/g, '\n\n');
  return norm.split(/\n\s*\n/).filter(x => x.trim()).length;
}
// crude syllable counter: vowel groups, silent trailing e, floor of 1.
// Single source of truth for syllable budgets AND verification — the two
// must never disagree. Known exceptions live here, not in callers.
const SYLLABLE_EXCEPTIONS = { evening: 2 };
function countSyllables(word) {
  const key = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (key in SYLLABLE_EXCEPTIONS) return SYLLABLE_EXCEPTIONS[key];
  let w = key;
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]e|ed|es)$/, '');
  w = w.replace(/^y/, '');
  const groups = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

const STOPWORDS = new Set(('a,an,the,and,or,but,if,then,else,when,at,by,for,with,about,into,through,during,before,after,above,below,to,from,up,down,in,out,on,off,over,under,again,further,once,here,there,all,any,both,each,few,more,most,other,some,such,no,nor,not,only,own,same,so,than,too,very,can,will,just,don,should,now,of,is,are,was,were,be,been,being,has,have,had,having,do,does,did,doing,would,could,ought,i,you,he,she,it,we,they,them,his,her,its,our,their,this,that,these,those,as,what,which,who,whom,how,why,where,me,my,mine,your,yours,us,please,write,tell,give,make,explain,describe,essay,story,paragraph,response,answer,request,prompt,include,including,containing,words,word,sentences,sentence,exactly,least,most,fewer,compose,create,generate,using,use,without,with,letter').split(','));
function contentTokens(text) {
  return (String(text || '').toLowerCase().match(/[a-z][a-z'-]*/g) || [])
    .filter(w => !STOPWORDS.has(w) && w.length > 2);
}

// ---------------------------------------------------------------------------
// 1. OPERATOR LIBRARY — typed generative operators as plain data
// ---------------------------------------------------------------------------
// pattern: { t: template with {slot} placeholders, s: sentences yielded,
//            c: true if the pattern contains a comma (filtered under noComma) }
// Slot transforms available in templates: {x} raw, {xCap} capitalized,
// {xLow} lowercase-first. Filled then trailing punctuation stripped.

const OPERATORS = {
  define: {
    slots: ['term', 'gloss'],
    // np: true  -> gloss must be noun-phrase shaped ("X is <np>")
    // clauseOk   -> gloss may be a full clause, emitted standalone
    patterns: [
      { t: '{termCap} is {glossLow}.', s: 1, c: false, np: true },
      { t: 'By {termLow}, we mean {glossLow}.', s: 1, c: true, np: true },
      { t: '{termCap}: {glossLow}.', s: 1, c: false },
      { t: 'In brief, {termLow} is {glossLow}.', s: 1, c: true, np: true },
      { t: '{glossCap}.', s: 1, c: false, clauseOk: true },
    ],
  },
  exemplify: {
    slots: ['concept', 'example'],
    patterns: [
      { t: 'For example, {exampleLow}.', s: 1, c: true },
      { t: '{conceptCap} shows up when {exampleLow}.', s: 1, c: false },
      { t: 'One case is {exampleLow}.', s: 1, c: false },
      { t: 'Consider {exampleLow}.', s: 1, c: false },
    ],
  },
  cause: {
    slots: ['cause', 'effect'],
    patterns: [
      { t: '{causeCap} leads to {effectLow}.', s: 1, c: false },
      { t: 'Because {causeLow}, {effectLow}.', s: 1, c: true },
      { t: '{effectCap} follows from {causeLow}.', s: 1, c: false },
    ],
  },
  contrast: {
    slots: ['a', 'b'],
    patterns: [
      { t: '{aCap}, yet {bLow}.', s: 1, c: true },
      { t: 'Unlike {aLow}, {bLow}.', s: 1, c: true },
      { t: '{aCap} stands apart from {bLow}.', s: 1, c: false },
    ],
  },
  sequence: {
    slots: ['steps'], // array -> one sentence per step
    stepPatterns: [
      { t: 'First, {s}.', s: 1, c: true }, { t: 'First {s}.', s: 1, c: false },
      { t: 'Next, {s}.', s: 1, c: true }, { t: 'Then {s}.', s: 1, c: false },
      { t: 'After that, {s}.', s: 1, c: true }, { t: 'Later {s}.', s: 1, c: false },
      { t: 'Finally, {s}.', s: 1, c: true }, { t: 'In the end {s}.', s: 1, c: false },
    ],
  },
  enumerate: {
    slots: ['items'], // array -> single sentence
    patterns: [
      { t: 'The main points are {items}.', s: 1, c: false },
      { t: 'It comes down to {items}.', s: 1, c: false },
    ],
  },
  conclude: {
    slots: ['point'],
    patterns: [
      { t: 'In short, {pointLow}.', s: 1, c: true },
      { t: '{pointCap}, and that is the key takeaway.', s: 1, c: true },
      { t: 'So {pointLow}.', s: 1, c: false },
    ],
  },
  describe: {
    slots: ['subject', 'traits'], // traits array -> one sentence per trait
    // needsPredicate: true -> trait must be predicate-shaped ("X is <pred>");
    // traits with their own subject ("these empires were...") skip it
    traitPatterns: [
      { t: '{subjectCap} is {sLow}.', s: 1, c: false, needsPredicate: true },
      { t: '{subjectCap} shows that {sLow}.', s: 1, c: false },
      { t: 'With {subjectLow}, {sLow}.', s: 1, c: true },
      { t: 'With {subjectLow} {sLow}.', s: 1, c: false },
    ],
  },
  compare: {
    slots: ['a', 'b', 'dimension'],
    patterns: [
      { t: 'On {dimensionLow}, {aLow} differs from {bLow}.', s: 1, c: true },
      { t: '{aCap} and {bLow} part ways over {dimensionLow}.', s: 1, c: false },
      { t: 'Measured by {dimensionLow}, {aLow} is not {bLow}.', s: 1, c: true },
    ],
  },
  condition: {
    slots: ['condition', 'outcome'],
    patterns: [
      { t: '{outcomeCap} unless {conditionLow}.', s: 1, c: false },
      { t: 'Without {conditionLow}, {outcomeLow}.', s: 1, c: true },
    ],
  },
  purpose: {
    slots: ['action', 'goal'],
    patterns: [
      { t: '{actionCap} so that {goalLow}.', s: 1, c: false },
      { t: '{actionCap} with the goal of {goalLow}.', s: 1, c: false },
    ],
  },
  paraphrase: {
    slots: ['point'],
    patterns: [
      { t: 'Put another way, {pointLow}.', s: 1, c: true },
      { t: 'In other words {pointLow}.', s: 1, c: false },
    ],
  },
  narrate: {
    slots: ['beats'], // {setup,rise,climax,resolution} -> 4 sentences
    patterns: [
      { t: '{setupCap}. {riseCap}. {climaxCap}. {resolutionCap}.', s: 4, c: false },
    ],
  },
};

const RELATION_TO_OPERATOR = {
  condition: 'condition', contrast: 'contrast', purpose: 'purpose',
  cause: 'cause', sequence: 'sequence', exemplify: 'exemplify',
};

// Merge induced discourse operators into a fresh library copy.
// Returns { library, merged, skipped } — never mutates OPERATORS.
function mergeInducedOperators(inducedJson) {
  const library = JSON.parse(JSON.stringify(OPERATORS));
  let merged = 0, skipped = 0;
  let entries = [];
  try {
    const j = typeof inducedJson === 'string' ? JSON.parse(inducedJson) : inducedJson;
    entries = (j && j.entries) || [];
  } catch (_) { return { library, merged, skipped }; }
  for (const e of entries) {
    try {
      const rec = e.record || {};
      if (rec.status !== 'active' || (rec.confidence || 0) < 0.5) { skipped++; continue; }
      const ast = (rec.payload || {}).operatorAst || {};
      const opName = RELATION_TO_OPERATOR[ast.relationType];
      const target = opName && library[opName];
      if (!target) { skipped++; continue; }
      const roles = ast.roles || [];
      // positional role adapter: learned role names (left/right,
      // plan/obstacle, ...) rarely match the hand-written slot names
      // (a/b, condition/outcome, ...), so map by position: first learned
      // role -> first slot, last learned role -> last slot. Requires a
      // binary relation and at least two slots.
      if (roles.length < 2 || target.slots.length < 2) { skipped++; continue; }
      const leftSlot = target.slots[0], rightSlot = target.slots[target.slots.length - 1];
      const order = ast.surfaceOrder || 'left_marker_right';
      for (const marker of (ast.markers || [])) {
        const m = String(marker).trim();
        if (!m) continue;
        const left = '{' + leftSlot + 'Cap}', right = '{' + rightSlot + 'Low}';
        const t = order === 'marker_left_right'
          ? cap(m) + ' ' + left.replace('Cap}', 'Low}') + ', ' + right + '.'
          : left + ' ' + m + ' ' + right + '.';
        target.patterns.push({ t, s: 1, c: /[,]/.test(t), induced: true });
        merged++;
      }
    } catch (_) { skipped++; }
  }
  return { library, merged, skipped };
}

// ---------------------------------------------------------------------------
// 2. MEANING PLANNER — prompt -> operator trace
// ---------------------------------------------------------------------------

const INTENT_RES = [
  [/(\bstory\b|\btale\b|\bnarrate\b|\btell me a story\b)/i, 'narrate'],
  [/(\bdescribe\b|\bdepict\b|\bportray\b)/i, 'describe'],
  [/(\bargue\b|\bpersuade\b|\bmake the case\b|\bdefend the (?:view|position|claim)\b)/i, 'argue'],
  [/(\bcompare\b|\bversus\b|\bvs\.?\b|\bdifferences? between\b)/i, 'compare'],
  [/(\blist\b|\benumerate\b|\bgive me (?:\d+|several|a few)\b)/i, 'list'],
  [/(\bexplain\b|\bwhat is\b|\bwhat are\b|\bhow does\b|\bhow do\b|\bwhy does\b|\bwhy do\b|\bwhat causes\b)/i, 'explain'],
];

function parseIntent(prompt) {
  for (const [re, intent] of INTENT_RES) if (re.test(prompt)) return intent;
  return 'general';
}

const NUMW = { once: 1, twice: 2, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
function numVal(s) {
  const c = String(s || '').toLowerCase().trim();
  if (/^\d+$/.test(c)) return parseInt(c, 10);
  return NUMW[c] || 0;
}

// Parse IFEval-style mechanical constraints. Shapes the plan, not the text.
function parseConstraints(prompt) {
  const p = String(prompt || '');
  const c = {
    exactSentences: 0, minSentences: 0, maxSentences: 0,
    exactWords: 0, minWords: 0, maxWords: 0, targetWords: 0,
    exactParagraphs: 0,
    keywords: [], keywordFreq: [], forbiddenWords: [],
    noComma: false, lowerCase: false, upperCase: false,
    exactStart: '', exactEnd: '', title: false, echoPrompt: false,
    // format constraints (all mechanically verifiable, all rendered)
    bullets: 0, highlightSections: 0, quoteWrap: false, paragraphDivider: '',
    minHashtags: 0, capsMin: 0, capsMax: 0,
    repeatPrompt: false, twoResponses: false, postscript: false,
    sectionLabel: '', paragraphFirstWord: null,
    // hard denylist: the core cannot satisfy these, so it must not attempt
    placeholders: false, jsonFormat: false, constrainedResponse: false,
  };
  let m;
  if ((m = p.match(/exactly\s+(\d+|\w+)\s+sentences?/i))) c.exactSentences = numVal(m[1]);
  else if ((m = p.match(/(?:in|with|of|into)\s+(\d+|\w+)\s+sentences?\b/i)) && !/sentences?\s+or\s+(more|fewer)/i.test(p)) c.exactSentences = numVal(m[1]);
  if ((m = p.match(/at least\s+(\d+|\w+)\s+sentences?/i))) c.minSentences = numVal(m[1]);
  if ((m = p.match(/(\d+|\w+)\s+sentences?\s+or\s+fewer/i))) c.maxSentences = numVal(m[1]);
  // "At least 5 words ... should be in all caps" is a caps instruction,
  // not a word-count demand
  if ((m = p.match(/at\s+least\s+(\d+)\s+words?\b[^.]{0,60}\bin\s+all\s+caps?\b/i))) c.capsMin = parseInt(m[1], 10);
  if ((m = p.match(/exactly\s+(\d+|\w+)\s+words?\b/i))) c.exactWords = numVal(m[1]);
  if ((m = p.match(/at least\s+(\d+|\w+)\s+words?\b(?![^.]{0,60}\bin\s+all\s+caps?\b)/i))) c.minWords = numVal(m[1]);
  if ((m = p.match(/(\d+)\s*\+\s*words?\b/i))) c.minWords = Math.max(c.minWords, numVal(m[1])); // "300+ word"
  if ((m = p.match(/more than\s+(\d+|\w+)\s+words?\b/i))) c.minWords = numVal(m[1]) + 1;
  if ((m = p.match(/(\d+|\w+)\s+words?\s+or\s+(?:fewer|less)\b/i))) c.maxWords = numVal(m[1]);
  // "under 15 words" / "less than 20 words": strict upper bound (official
  // 'less than' means < N)
  if ((m = p.match(/(?:under|less\s+than)\s+(\d+|\w+)\s+words?\b/i))) c.maxWords = numVal(m[1]) - 1;
  // "a 400-word essay" / "a 100 word riddle": long-form demand -> minWords;
  // ALSO keep a soft target so the sample lands near N instead of far above
  if (!c.exactWords && !c.minWords) {
    if ((m = p.match(/(\d+)\s*-\s*word\s+(?:essay|article|story|piece|response|answer|riddle|poem|summary|tale)\b/i))) { c.minWords = numVal(m[1]); c.targetWords = numVal(m[1]); }
    else if ((m = p.match(/\b(\d+)\s+words?\s+(?:essay|article|story|piece|riddle|poem|summary|tale)\b/i))) { c.minWords = numVal(m[1]); c.targetWords = numVal(m[1]); }
  }
  if ((m = p.match(/(\d+|\w+)\s+paragraphs?\b/i))) c.exactParagraphs = numVal(m[1]);
  // keywords with frequency: "the word 'replied' appears at least twice"
  for (const mm of p.matchAll(/the words?\s+['"]([\w-]+)['"]\s+appears?\s+at least\s+(twice|once|thrice|\d+\s+times?)/gi)) {
    c.keywordFreq.push({ word: mm[1], min: numVal(mm[2]) });
  }
  for (const mm of p.matchAll(/['"]([\w-]+)['"]\s+appears?\s+at least\s+(twice|once|thrice|\d+\s+times?)/gi)) {
    if (!c.keywordFreq.some(k => k.word.toLowerCase() === mm[1].toLowerCase()))
      c.keywordFreq.push({ word: mm[1], min: numVal(mm[2]) });
  }
  // plain keywords: "include the word X" / "mention X" / quoted phrases
  const kw = new Set();
  for (const mm of p.matchAll(/(?:include|mention|contain|use)\s+the\s+words?\s+([^.;]+)/gi)) {
    for (const w of mm[1].split(/,|\band\b/)) { const t = w.trim().replace(/^["']|["']$/g, ''); if (t && t.length < 40) kw.add(t); }
  }
  for (const mm of p.matchAll(/"([^"]{2,40})"/g)) kw.add(mm[1]);
  c.keywords = [...kw].slice(0, 8);
  // forbidden words: "do not use the word X" / "without using X"
  // (never a case/punctuation instruction: "do not use commas" is noComma;
  // never a determiner: "do not use any commas" forbids nothing)
  const NOT_WORDS = new Set(['commas', 'comma', 'periods', 'period', 'capital', 'lowercase', 'uppercase', 'quotes', 'quotation', 'any', 'all', 'some', 'the', 'a', 'an']);
  for (const mm of p.matchAll(/do not\s+(?:use|mention|include)(?:\s+the\s+words?)?\s+["']?([a-zA-Z][\w-]*(?:\s*,\s*["']?[a-zA-Z][\w-]*["']?)*)["']?/gi)) {
    for (const w of mm[1].split(/\s*,\s*/)) {
      const t = w.trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (t && !NOT_WORDS.has(t)) c.forbiddenWords.push(t);
    }
  }
  for (const mm of p.matchAll(/without\s+using\s+(?:the\s+words?\s+)?["']?([a-zA-Z][\w-]*)["']?/gi)) {
    const t = mm[1].toLowerCase();
    if (!NOT_WORDS.has(t)) c.forbiddenWords.push(t);
  }
  c.noComma = /(?:without|no|avoid|refrain from|do not|don't|should not|must not)[^.;]{0,40}\bcommas?\b/i.test(p);
  c.lowerCase = /\ball lowercase\b|all lower case|no capital letters|without.*capital letters|only lowercase/i.test(p);
  // whole-response uppercase (aligned with lari_constraint_repair.js); a bare
  // "few words in all capital letters" is a frequency instruction, not this
  c.upperCase = /(?:entire|whole|all of (?:the|your))\s+(?:response|answer|text)[\s\S]{0,60}(?:all capital|uppercase)|(?:response|answer|text)\s+should\s+be\s+in\s+all\s+capital|write it in all capital|make sure to only use capital letters|all letters capitalized|\ball uppercase\b|\bno lowercase letters\b|\bonly capital letters\b|capitalize all (?:your )?words/i.test(p);
  if ((m = p.match(/(?:start|begin)(?: your response)? with ["']?([^"'.]+)["']?/i))) c.exactStart = m[1].trim();
  if ((m = p.match(/(?:end|finish|conclude)(?: your response)? with ["']?([^"'.]+)["']?/i))) c.exactEnd = m[1].trim();
  c.title = /title.{0,60}(?:double angular|<<[^<>]+>>)|include a title/i.test(p);
  // echoPrompt retired: repeat-the-request prompts are handled by the precise
  // repeatPrompt mechanism (which excludes the repeat sentence itself)
  // ---- format constraints ----
  if ((m = p.match(/exactly\s+(\d+)\s+bullets?(?:\s+points?)?/i))) c.bullets = parseInt(m[1], 10);
  else if ((m = p.match(/(\d+)\s+bullet points?\b/i))) c.bullets = parseInt(m[1], 10);
  if ((m = p.match(/highlight\s+at\s+least\s+(\d+)\s+sections?/i))) c.highlightSections = parseInt(m[1], 10);
  c.quoteWrap = /wrap\s+(?:your\s+)?(?:the\s+)?(?:entire\s+)?response\s+(?:with|in)\s+double quotation marks/i.test(p) ||
    /wrap\s+.*\s+with\s+double\s+quotes/i.test(p);
  if ((m = p.match(/separate\s+(?:each\s+|all\s+)?paragraphs?\s+with\s+(?:the\s+markdown\s+divider:?\s*)?(\*\*\*|---)/i))) c.paragraphDivider = m[1];
  else if (/\bmarkdown\s+divider\b/i.test(p) && /\*\*\*/.test(p)) c.paragraphDivider = '***';
  if ((m = p.match(/at\s+least\s+(\d+)\s+hashtags?/i))) c.minHashtags = parseInt(m[1], 10);
  // all-caps word frequency ("at least" -> min, "at most"/"less than" -> max)
  if ((m = p.match(/words?\s+(?:with\s+)?all\s+capital(?:\s+letters?)?\s+should\s+appear\s+at\s+least\s+(\d+)/i))) c.capsMin = parseInt(m[1], 10);
  if ((m = p.match(/all[-\s]?caps?\s+words?\s+should\s+appear\s+at\s+least\s+(\d+)/i))) c.capsMin = parseInt(m[1], 10);
  if (/some\s+words?\s+in\s+all\s+caps/i.test(p) || /a\s+few\s+words?\s+in\s+all\s+capital/i.test(p)) c.capsMin = Math.max(c.capsMin, 1);
  if ((m = p.match(/all[-\s]?caps?\s+words?\s+should\s+appear\s+at\s+most\s+(\d+)/i))) c.capsMax = parseInt(m[1], 10);
  if ((m = p.match(/(?:words?\s+in\s+all\s+capital(?:\s+letters?)?|all[-\s]?caps?\s+words?)[^.]{0,60}?\bless\s+than\s+(\d+)/i))) c.capsMax = parseInt(m[1], 10) - 1; // "less than 5" -> max 4
  if ((m = p.match(/should\s+appear\s+at\s+most\s+(\d+)\s+times/i)) && /caps|capital/i.test(p)) c.capsMax = parseInt(m[2], 10);
  c.repeatPrompt = /repeat\s+(?:the\s+)?(?:exact\s+)?(?:request|prompt|question)\b[^.]{0,40}\bword\s+for\s+word/i.test(p);
  c.twoResponses = /give\s+two\s+(?:different\s+)?responses|provide\s+two\s+(?:different\s+)?responses|two\s+separate\s+(?:answers|responses)/i.test(p);
  c.postscript = /\bpostscript\b/i.test(p);
  if ((m = p.match(/label\s+each\s+paragraph\s+(?:with\s+)?([A-Za-z]+)/i))) c.sectionLabel = m[1];
  if ((m = p.match(/(first|second|third|fourth|fifth|\d+(?:st|nd|rd|th))\s+paragraph\s+must\s+start\s+with\s+the\s+word\s+["']?([\w-]+)["']?/i))) {
    const ord = m[1].toLowerCase();
    const n = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }[ord] || parseInt(ord, 10);
    c.paragraphFirstWord = { n, word: m[2] };
  }
  c.placeholders = /\[PLACEHOLDER\]|placeholders?/i.test(p) && /include|add|insert|contain/i.test(p);
  c.jsonFormat = /\bjson\b/i.test(p) && /wrap|format|output|entire/i.test(p);
  c.constrainedResponse = /answer\s+with\s+one\s+of\s+the\s+following/i.test(p);
  return c;
}

// Strip instruction scaffolding to find the topic noun phrase.
function extractTopic(prompt) {
  let t = String(prompt || '');
  // a quoted span is usually the actual subject ("What are your thoughts on
  // this quote?" / critique "the following sentence: "...")
  const quoted = t.match(/"([^"]{15,160})"/);
  if (quoted && /\b(quote|sentence|passage|poem|text)\b/i.test(t)) {
    return { phrase: quoted[1].replace(/[.?!,;:()]+$/g, '').trim().slice(0, 60) || 'this topic', tokens: contentTokens(quoted[1]) };
  }
  // "My company's name is X" -> the company is the topic
  let m = t.match(/(?:company'?s?\s+name\s+is|my\s+company\s+is\s+called)\s+([^.!\n]+)/i);
  if (m) {
    const name = m[1].trim().slice(0, 40);
    return { phrase: name, tokens: contentTokens(name) };
  }
  t = t.replace(/"[^"]*"/g, ' ');
  // drop whole instruction sentences: they describe form, not subject
  const isInstr = (s) => /\b(must|should|format|markdown|bullet|highlight|wrap|separate|include at least|do not use|don't use|answer with|your (response|answer|list)|paragraphs?|sentences?|words?|hashtags?|capital|lowercase|uppercase|commas?|quotation marks|repeat the|word for word|title|postscript|label each)\b/i.test(s);
  const contentSentences = t.split(/(?<=[.?!])\s+/).filter(s => s.trim() && !isInstr(s));
  if (contentSentences.length) t = contentSentences.join(' ');
  // mechanical constraint clauses are not the topic
  t = t.replace(/\b(without|with|no|avoid|refrain from|do not|don't|should not|must not)\b[^.;]{0,60}\b(commas?|periods?|capital letters|uppercase|lowercase)\b[^.;]*/gi, ' ');
  t = t.replace(/\b(write|compose|create|generate|draft|produce|tell|share|make)\b[^.;]*?\b(essay|story|tale|article|paragraph|response|answer|piece|haiku|poem|letter|slogan|riddle|rap|pitch|proposal|email|paper|tweet|post)\b[^.;]*?\b(about|on|explaining|describing|for)\b/i, ' ');
  // keyword-frequency clauses are not the topic ("the word 'replied' ...")
  t = t.replace(/\bmaking\s+sure\b[^.;]*/gi, ' ');
  t = t.replace(/\bthe\s+words?\s+['"][\w-]+['"]\s+appears?\s+at\s+least[^.;]*/gi, ' ');
  t = t.replace(/\b(explain|describe|tell me about|what is|what are|discuss|argue|compare|list)\b/i, ' ');
  t = t.replace(/\b(in|with|of|into)\s+\d+\s+(sentences?|words?|paragraphs?)\b[^.;]*/gi, ' ');
  t = t.replace(/\b(at least|exactly|or fewer|or less)\b[^.;]*/gi, ' ');
  t = t.replace(/\b\d+\s*-\s*word\b[^.;]*/gi, ' ');
  // "teach a dog to sit, stay, and fetch" -> the teaching subject
  m = t.match(/\bteach\s+([^.;]+)/i);
  if (m && m[1].trim().split(/\s+/).length <= 8) {
    const subj = m[1].replace(/\b(a|an|the|to)\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
    if (subj) return { phrase: cap(subj) || subj, tokens: contentTokens(subj) };
  }
  // "asking to be their rally organizer" -> the role
  m = t.match(/\basking\s+to\s+be\s+(?:their\s+)?([^.;]+)/i);
  if (m && m[1].trim().split(/\s+/).length <= 6) {
    const role = m[1].trim().slice(0, 50);
    return { phrase: role, tokens: contentTokens(role) };
  }
  t = t.replace(/[.?!,;:()]/g, ' ');
  const toks = contentTokens(t);
  // longest run of content tokens = topic phrase
  const words = String(t).split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));
  const phrase = words.slice(0, 5).join(' ').trim();
  return { phrase: phrase || toks.slice(0, 4).join(' ') || 'this topic', tokens: toks };
}

function rankSentences(sentences, topicTokens) {
  const tset = new Set(topicTokens);
  return (sentences || [])
    .map(s => {
      const toks = contentTokens(s);
      const overlap = toks.filter(w => tset.has(w)).length;
      return { s: String(s).trim(), score: overlap * 10 + Math.min(toks.length, 30) };
    })
    .filter(x => {
      const s = x.s.trim();
      if (s.length <= 20) return false;
      if (/^[^a-zA-Z"']/.test(s)) return false;      // leading digit/paren = split fragment
      if (/\)\s*,/.test(s)) return false;             // "(dates), who ..." distiller artifact
      if (/\b(in|of|to|from|with|by|for|on|at|and|or|the|a|an|as)\.?$/i.test(s)) return false; // ends mid-phrase
      const open = (s.match(/\(/g) || []).length, close = (s.match(/\)/g) || []).length;
      if (open !== close) return false;               // unbalanced parens
      return true;
    })
    .sort((a, b) => b.score - a.score || a.s.length - b.s.length);
}
const TRAILING_JUNK = new Set(('into,to,of,from,with,by,for,on,at,and,or,the,a,an,as,is,are,was,were,be,that,which,who,' +
  'in,including,while,when,where,if,but,yet,than,like,such,without,within,among,between,through,during,under,per,via,so').split(','));
// common transitive verbs: a clause cut ending here lost its object
const TRAILING_TRANSITIVE = new Set(('experienced,caused,led,made,built,created,developed,established,introduced,brought,saw,held,kept,took,gave,left,put,set,sent,found,lost,won,began,begun,used,using'.split(',')));
function clause(s, maxWords, noComma) {
  let t = stripTrailingPunct(String(s || ''));
  t = t.split(/[;:\u2014]/)[0];
  if (noComma) t = t.split(',')[0]; // comma-free fillers under noComma
  let ws = t.split(/\s+/).slice(0, maxWords || 28);
  const truncated = t.split(/\s+/).length > (maxWords || 28);
  // never end a clause on a dangling preposition/article/conjunction, a
  // transitive verb whose object was cut away, or — when maxWords actually
  // cut the text — a hyphenated fragment ("Neo-Assyrian" cut from
  // "Neo-Assyrian Empire")
  const last = () => ws.length ? ws[ws.length - 1].toLowerCase().replace(/[^a-z]/g, '') : '';
  const lastRaw = () => ws.length ? ws[ws.length - 1] : '';
  while (ws.length > 3 && (TRAILING_JUNK.has(last()) || TRAILING_TRANSITIVE.has(last()) ||
      (truncated && (/[a-z]-[a-z]+$/i.test(lastRaw()))))) ws.pop();
  let out = ws.join(' ').trim().replace(/,+$/, '');
  // cutting can strand an unclosed paren ("... (Arabic") — drop it
  if ((out.match(/\(/g) || []).length > (out.match(/\)/g) || []).length) {
    out = out.split('(')[0].trim().replace(/,+$/, '');
  }
  return out;
}

// Fill operator slots from ranked knowledge. Clause-level and heuristic,
// documented as such: the novelty is composition, not NLP depth.
// opts: { noComma }
function fillSlots(opName, topic, ranked, usedIdx, opts = {}) {
  const noComma = !!opts.noComma;
  const cl = (s, n) => clause(s, n, noComma);
  const pick = (i) => (ranked[(usedIdx.idx + i) % Math.max(1, ranked.length)] || {}).s || '';
  const T = topic.phrase;
  switch (opName) {
    case 'define': {
      // rotate through ALL definitional matches so repeated define ops
      // don't all quote the same sentence
      const defCands = ranked.filter(r => new RegExp('\\b' + T.split(/\s+/)[0] + '\\b.{0,20}\\b(is|are|refers to|means)\\b', 'i').test(r.s));
      const def = defCands.length ? defCands[usedIdx.idx % defCands.length] : null;
      let gloss = def ? cl(def.s.replace(/^[^.;]*?\b(is|are|refers to|means)\b/i, '').trim(), 26) : cl(pick(0), 26);
      // clean regex-split artifacts: leading ", " and stranded "as"
      gloss = gloss.replace(/^[,;]\s*/, '').replace(/^as\s+/i, '');
      usedIdx.idx += 1;
      return { term: T, gloss: gloss || ('an important subject worth understanding') };
    }
    case 'exemplify': {
      // rotate through all exemplification matches for the same reason
      const exCands = ranked.filter(r => /\b(such as|for example|like|including)\b/i.test(r.s));
      const ex = exCands.length ? exCands[usedIdx.idx % exCands.length] : null;
      usedIdx.idx += 1;
      // strip a leading exemplification marker so the pattern's own
      // "For example," doesn't double up
      let example = cl(ex ? ex.s : pick(0), 26).replace(/^(for example|such as|like|including|still|however|yet)\b[, ]*/i, '');
      return { concept: T, example: example || ('a well-known instance of ' + T) };
    }
    case 'cause': {
      const csCands = ranked.filter(r => /\b(causes?|leads? to|results? in|produces?|triggers?|creates?)\b/i.test(r.s));
      const cs = csCands.length ? csCands[usedIdx.idx % csCands.length] : null;
      if (cs) {
        const parts = cs.s.split(/\b(causes?|leads? to|results? in|produces?|triggers?|creates?)\b/i);
        usedIdx.idx += 1;
        return { cause: cl(parts[0], 14) || T, effect: cl(parts[2] || parts[1], 16) || 'wide effects' };
      }
      usedIdx.idx += 1;
      return { cause: cl(pick(0), 12) || T, effect: cl(pick(1), 14) || 'lasting consequences' };
    }
    case 'contrast': {
      usedIdx.idx += 2;
      return { a: cl(pick(0), 14) || T, b: cl(pick(1), 14) || ('a different view of ' + T) };
    }
    case 'sequence': {
      const n = 4;
      const steps = [];
      for (let i = 0; i < n; i++) { steps.push(lowFirst(cl(pick(i), 16)) || ('step ' + (i + 1) + ' of the process')); }
      usedIdx.idx += n;
      return { steps };
    }
    case 'enumerate': {
      const items = [];
      for (let i = 0; i < 3; i++) items.push(cl(pick(i), 12) || ('point ' + (i + 1)));
      usedIdx.idx += 3;
      // comma-free join under noComma; the pattern itself has no commas
      return { items: noComma ? items.join(' and ') : items.join(', ').replace(/, ([^,]*)$/, ', and $1') };
    }
    case 'conclude': {
      usedIdx.idx += 1;
      return { point: cl(pick(0), 18) || ('the central truth about ' + T) };
    }
    case 'describe': {
      const traits = [];
      // strip a leading topic mention so the subject isn't doubled
      // ("Photosynthesis is photosynthesis is ...")
      const topicRe = new RegExp('^' + T.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b\\s*(is|are|was|were)?\\s*', 'i');
      // traits must not open with a subordinator ("X is although ..." is broken)
      // or a bare preposition phrase ("This is in 879 BCE, ..." is awkward)
      const subRe = /^(although|though|while|whereas|since|because|if|when|despite|unless|until|after|before|still|however|yet|in|on|at|during|under|with|by|through|across|as)\b/i;
      const cleanPool = ranked.filter(r => !subRe.test(r.s.trim()));
      const tpool = cleanPool.length >= 3 ? cleanPool : ranked;
      for (let i = 0; i < 3; i++) {
        const r = tpool[(usedIdx.idx + i) % Math.max(1, tpool.length)];
        let tr = cl(r ? r.s : pick(i), 12).replace(topicRe, '') || 'notable qualities';
        traits.push(tr);
      }
      usedIdx.idx += 3;
      return { subject: cap(T), traits };
    }
    case 'compare': {
      usedIdx.idx += 2;
      const ws = T.split(/\s+/);
      const a = ws.slice(0, Math.ceil(ws.length / 2)).join(' ') || T;
      const b = ws.slice(Math.ceil(ws.length / 2)).join(' ') || ('other views of ' + T);
      return { a: cl(pick(0), 12) || a, b: cl(pick(1), 12) || b, dimension: 'scope and impact' };
    }
    case 'condition': {
      usedIdx.idx += 1;
      return { condition: lowFirst(cl(pick(0), 12)) || 'careful study', outcome: cap(cl(pick(1), 12)) || 'Understanding grows' };
    }
    case 'purpose': {
      return { action: cap(T) + ' is studied', goal: lowFirst(cl(pick(0), 14)) || 'deeper understanding' };
    }
    case 'paraphrase': {
      usedIdx.idx += 1;
      return { point: lowFirst(cl(pick(0), 18)) || ('the essence of ' + T) };
    }
    case 'narrate': {
      return { beats: buildStoryBeats(topic, ranked, usedIdx) };
    }
    default: return {};
  }
}

// Story beats from NOUN-POSITION words, not raw content tokens: words
// following articles/prepositions ("the lamp", "from the sea") are likely
// nouns, which keeps beats grammatical. Topic words are excluded (the topic
// is already the subject) and -ed forms are skipped (verb/adjective bleed).
const STORY_FALLBACK_WORDS = ['road', 'night', 'wind', 'light', 'shadow', 'morning', 'journey', 'home'];
const STORY_ADJECTIVES = new Set(('darkest,great,good,old,new,big,small,high,low,long,short,strong,weak,deep,dark,bright,heavy,quiet,little,large,remarkable,greatest,best,worst,own,very'.split(',')));
function nounPositionWords(sentences, excludeSet) {
  const words = [];
  // relative pronouns / determiners that sit in noun position but aren't nouns
  const NON_NOUNS = new Set(('which,that,this,these,those,what,when,where,while,such,other,another,same,each,every,many,much,more,most,some,any,only,very,own,both,few,several,former,latter').split(','));
  const consider = (w) => {
    w = String(w || '').toLowerCase();
    if (NON_NOUNS.has(w)) return;
    if (w.length > 3 && !w.endsWith('ed') && !w.endsWith('ing') && !excludeSet.has(w) && !words.includes(w)) words.push(w);
  };
  for (const s of sentences) {
    const text = String((s && s.s) || s || '');
    // article + [adjective] + noun: take the noun ("the darkest hours" -> hours)
    for (const m of text.matchAll(/\b(?:the|a|an)\s+([a-z]{4,})(?:\s+([a-z]{4,}))?/gi)) {
      const first = m[1].toLowerCase(), second = (m[2] || '').toLowerCase();
      if (second && STORY_ADJECTIVES.has(first)) consider(second);
      else if (!STORY_ADJECTIVES.has(first)) consider(first);
    }
    // preposition + noun ("at dawn" -> dawn)
    for (const m of text.matchAll(/\b(?:of|in|on|at|through|from|to|with|by)\s+([a-z]{4,})\b/gi)) {
      consider(m[1]);
    }
  }
  return words;
}
function buildStoryBeats(topic, ranked, usedIdx) {
  const T = topic.phrase;
  const subjCap = /^(the|a|an)\b/i.test(T) ? cap(T) : 'The ' + lowFirst(T);
  const subjLow = /^(the|a|an)\b/i.test(T) ? lowFirst(T) : 'the ' + lowFirst(T);
  const exclude = new Set(topic.tokens);
  const words = nounPositionWords(ranked.slice(0, 10).map(r => r.s), exclude);
  let fi = 0;
  while (words.length < 8) { const w = STORY_FALLBACK_WORDS[fi % STORY_FALLBACK_WORDS.length]; if (!words.includes(w)) words.push(w); fi++; }
  usedIdx.idx += 4;
  const [w1, w2, w3, w4, w5, w6, w7, w8] = words;
  return {
    setup: subjCap + ' knew the ' + w1 + ' and the ' + w2,
    rise: 'But the ' + w3 + ' brought the ' + w4,
    climax: 'Through the ' + w5 + ', ' + subjLow + ' held to the ' + w6,
    resolution: 'When the ' + w7 + ' passed, the ' + w8 + ' remained',
  };
}

// Trace recipes per intent: ordered operator names.
const RECIPES = {
  explain: ['define', 'describe', 'exemplify', 'cause', 'contrast', 'paraphrase', 'conclude'],
  describe: ['define', 'describe', 'exemplify', 'conclude'],
  argue: ['define', 'cause', 'exemplify', 'contrast', 'conclude'],
  compare: ['define', 'compare', 'contrast', 'conclude'],
  list: ['define', 'enumerate', 'exemplify', 'conclude'],
  narrate: ['narrate'],
  general: ['define', 'describe', 'exemplify', 'conclude'],
};
const OP_SENTENCES = { define: 1, exemplify: 1, cause: 1, contrast: 1, sequence: 4, enumerate: 1, conclude: 1, describe: 3, compare: 1, condition: 1, purpose: 1, paraphrase: 1, narrate: 4 };

// Build the operator trace. Constraints shape it:
// - exactSentences N: choose/trim ops to yield exactly N sentences
// - word targets: scale op count (~18 words/op heuristic)
// - exactParagraphs P: distribute ops across P paragraphs
function planTrace({ intent, topic, constraints, ranked, seedSalt, attempt = 0 }) {
  const recipe = [...(RECIPES[intent] || RECIPES.general)];
  const targetSentences = (op) => OP_SENTENCES[op] || 1;
  let ops = [...recipe];

  const countS = (list) => list.reduce((n, o) => n + targetSentences(o), 0);
  // bullet lists need exactly N sentences (one per bullet); treat like exact
  const exactN = constraints.exactSentences > 0 ? constraints.exactSentences
    : (constraints.bullets > 0 ? constraints.bullets : 0);
  if (exactN > 0) {
    const N = exactN;
    // converge: grow with 1-sentence ops, use a 3-sentence describe only when
    // it fits, shrink from the middle (keep define + conclude framing)
    const growers = ['exemplify', 'paraphrase', 'cause'];
    let guard = 0;
    while (countS(ops) !== N && guard++ < 60 && ops.length > 1) {
      if (countS(ops) < N) {
        const need = N - countS(ops);
        const g = need >= 3 ? 'describe' : growers[guard % growers.length];
        ops.splice(Math.max(1, ops.length - 1), 0, g);
      } else {
        let dropIdx = 1 + Math.floor(ops.length / 2);
        if (dropIdx >= ops.length - 1) dropIdx = ops.length - 2;
        if (dropIdx < 1) dropIdx = 1;
        ops.splice(dropIdx, 1);
      }
    }
  } else {
    const wordsTarget = constraints.exactWords || constraints.minWords || constraints.targetWords || 0;
    // tiny word targets (< 20) are satisfied by the natural recipe length;
    // budgeting only kicks in for real long-form demands
    if (wordsTarget >= 20) {
      // word-budgeted trace: plan generously (~12 words/op), then the
      // renderer trims whole sentences back toward the target. Each repair
      // attempt grows the trace, so a too-short first try converges instead
      // of failing identically.
      const cyc = [...recipe, 'exemplify', 'cause', 'describe', 'paraphrase'];
      ops = [];
      const need = Math.ceil(wordsTarget / 12) + attempt * 3;
      for (let i = 0; i < need && ops.length < 120; i++) ops.push(cyc[i % cyc.length]);
    } else if (constraints.maxSentences > 0) {
      while (countS(ops) > constraints.maxSentences && ops.length > 1) ops.splice(1, 1);
    }
    // hard word ceiling ("under 15 words"): keep the trace small (~16 words/op)
    if (!wordsTarget && constraints.maxWords > 0) {
      while (ops.length > 1 && countS(ops) * 16 > constraints.maxWords) ops.splice(1, 1);
    }
    // minimum sentences ("at least 50 sentences"): grow with 1-sentence ops
    if (!exactN && constraints.minSentences > 0) {
      const growers = ['exemplify', 'paraphrase', 'cause', 'contrast'];
      let guard = 0;
      while (countS(ops) < constraints.minSentences && guard++ < 200) {
        ops.splice(Math.max(1, ops.length - 1), 0, growers[guard % growers.length]);
      }
    }
  }

  const usedIdx = { idx: fnv1a(seedSalt || topic.phrase) % Math.max(1, ranked.length || 1) };
  const noComma = !!constraints.noComma;
  // subject-alias rotation: long traces stop opening every sentence with the
  // bare topic ("Neo-Assyrian Empire is... shows... is..."). Deterministic
  // per op index; define keeps the full term (definitions need it).
  const SUBJ_ALIASES = [null, 'it', 'this'];
  const trace = ops.map((op, i) => {
    const slots = fillSlots(op, topic, ranked, usedIdx, { noComma });
    const alias = SUBJ_ALIASES[fnv1a((seedSalt || '') + '|alias|' + i) % SUBJ_ALIASES.length];
    if (alias === 'it' || alias === 'this') {
      if (op === 'exemplify' && slots.concept) { slots.conceptOrig = slots.concept; slots.concept = alias; }
      if (op === 'describe' && slots.subject) { slots.subjectOrig = slots.subject; slots.subject = alias; }
    }
    return { op, slots, paragraph: 0, index: i };
  });

  // paragraph grouping: distribute ops evenly so all P paragraphs are non-empty
  const P = constraints.exactParagraphs;
  if (P > 1 && trace.length) {
    trace.forEach((t, i) => { t.paragraph = Math.min(P - 1, Math.floor(i * P / trace.length)); });
  } else if (trace.length > 6) {
    // long traces: paragraph every ~4 ops for readability
    trace.forEach((t, i) => { t.paragraph = Math.floor(i / 4); });
  }
  return trace;
}

// ---------------------------------------------------------------------------
// 3. DETERMINISTIC RENDERER — trace -> English text
// ---------------------------------------------------------------------------

// heuristic: does this filler open with its own subject? ("these empires
// were...", "Assyria experienced...") — such fillers break "X is <filler>"
// patterns and need clause-safe patterns instead.
const CLAUSE_VERBS = new Set(('experienced,was,were,had,has,have,rose,fell,ruled,became,grew,began,reached,left,held,kept,took,made'.split(',')));
function startsWithOwnSubject(text) {
  const t = String(text || '').trim();
  if (/^(the|a|an|these|those|this|that|it|they|he|she|its|their)\b/i.test(t)) return true;
  const ws = t.split(/\s+/);
  return ws.length >= 2 && /^[A-Z][a-z]+$/.test(ws[0]) && CLAUSE_VERBS.has(ws[1].toLowerCase().replace(/[^a-z]/g, ''));
}

function renderPattern(pattern, slots, noComma) {
  if (noComma && pattern.c) return null;
  let t = pattern.t;
  t = t.replace(/\{(\w+?)(Cap|Low)?\}/g, (_, name, mod) => {
    let v = slots[name];
    if (v === undefined) return '';
    v = stripTrailingPunct(String(v));
    if (noComma) v = v.replace(/,/g, ''); // belt-and-braces: fillers are
    if (mod === 'Cap') return cap(v);     // comma-cut upstream, but a stray
    if (mod === 'Low') return lowFirst(v);// comma must never fail verify
    return v;
  });
  return t;
}

function renderTrace(trace, { constraints, prompt, attempt, library, secondPass, _quality }) {
  const lib = library || OPERATORS;
  const noComma = !!constraints.noComma;
  const seedBase = String(prompt || '') + '|' + attempt;
  const paragraphs = new Map();
  trace.forEach((node, i) => {
    const def = lib[node.op];
    if (!def) return;
    // QUALITY LAYER (lari_gen_quality.js): mined-sentence renderer +
    // discourse state. Only active when the caller passes _quality; the
    // plain path below is byte-for-byte the old behavior.
    if (_quality && _quality.renderNode) {
      const qs = _quality.renderNode(node, i, {
        def, library: lib, constraints, prompt, attempt, ranked: _quality.ranked,
      }) || [];
      const pg = node.paragraph || 0;
      if (!paragraphs.has(pg)) paragraphs.set(pg, []);
      paragraphs.get(pg).push(...qs);
      return;
    }
    let patterns = def.patterns || [];
    if (noComma) patterns = patterns.filter(p => !p.c);
    if (!patterns.length) patterns = def.patterns || [];
    let sentences = [];
    if (node.op === 'sequence') {
      const sps = noComma ? def.stepPatterns.filter(p => !p.c) : def.stepPatterns;
      const steps = node.slots.steps || [];
      sentences = steps.map((s, si) => {
        const sp = sps[(fnv1a(seedBase + '|seq|' + i + '|' + si)) % sps.length];
        return sp.t.replace('{s}', stripTrailingPunct(lowFirst(s)));
      });
    } else if (node.op === 'describe') {
      const tps = noComma ? def.traitPatterns.filter(p => !p.c) : def.traitPatterns;
      const traits = node.slots.traits || [];
      sentences = traits.map((tr, ti) => {
        // traits carrying their own subject skip "X is <trait>" patterns
        let cand = startsWithOwnSubject(tr) ? tps.filter(p => !p.needsPredicate) : tps;
        if (!cand.length) cand = tps;
        const tp = cand[(fnv1a(seedBase + '|desc|' + i + '|' + ti)) % cand.length];
        // alias doubling guard: "With this, this held..." -> fall back to the
        // full subject when the trait opens with the same alias word or its
        // sibling ("these" for "this", "its" for "it")
        let subj = node.slots.subject || 'It';
        const aliasStem = /^(it)$/i.test(subj) ? '^(it|its)\\b' : /^(this)$/i.test(subj) ? '^(this|these)\\b' : null;
        if (aliasStem && new RegExp(aliasStem, 'i').test(String(tr).trim()) && node.slots.subjectOrig) {
          subj = node.slots.subjectOrig;
        }
        return renderPattern(tp, { subject: subj, s: stripTrailingPunct(String(tr)) }, noComma);
      }).filter(Boolean);
    } else if (node.op === 'narrate') {
      const rendered = renderPattern(patterns[0], node.slots.beats || {}, noComma);
      if (rendered) sentences = [rendered];
    } else {
      // define: clause-shaped glosses ("Assyria experienced...") use
      // clause-safe patterns; noun-phrase glosses use the "X is <np>" family
      let cand = patterns;
      if (node.op === 'define') {
        const isClause = startsWithOwnSubject(node.slots.gloss);
        const sub = patterns.filter(p => isClause ? (p.clauseOk || (!p.np)) : (p.np || (!p.clauseOk)));
        if (sub.length) cand = sub;
      }
      const pat = cand[(fnv1a(seedBase + '|op|' + i)) % cand.length];
      const rendered = renderPattern(pat, node.slots, noComma);
      if (rendered) sentences = [rendered];
    }
    const pg = node.paragraph || 0;
    if (!paragraphs.has(pg)) paragraphs.set(pg, []);
    paragraphs.get(pg).push(...sentences);
  });

  // ---- assembly: paragraphs as sentence arrays (mutable for trimming) ----
  let paras = [...paragraphs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ss]) => ss.filter(Boolean));

  // bullet mode: every sentence becomes its own "* ..." line; highlights use
  // single-star (the bullet checker only counts lines starting with "* ")
  if (constraints.bullets > 0) {
    const flat = paras.flat();
    paras = [flat.map((s, i) => {
      let line = s;
      if (i < constraints.highlightSections) line = '*' + stripTrailingPunct(line) + '*';
      return '* ' + line;
    })];
  } else if (constraints.highlightSections > 0) {
    // wrap the first N sentences in *...* (the markdown highlight checker);
    // when fewer sentences exist, split long sentences into wrapped halves
    let left = constraints.highlightSections;
    paras = paras.map(ss => ss.map(s => {
      if (left > 0) { left--; return '*' + stripTrailingPunct(s) + '*'; }
      return s;
    }));
    let guard = 0;
    while (left > 0 && guard++ < 8) {
      let splitDone = false;
      paras = paras.map(ss => ss.map(s => {
        if (left <= 0 || splitDone || s[0] !== '*' || s[s.length - 1] !== '*') return s;
        const inner = s.slice(1, -1);
        const words = inner.split(/\s+/);
        if (words.length < 6) return s;
        const mid = Math.floor(words.length / 2);
        left--;
        splitDone = true;
        return '*' + words.slice(0, mid).join(' ') + '* *' + words.slice(mid).join(' ') + '*';
      }));
      if (!splitDone) break;
    }
  }

  // nth-paragraph-first-word: force paragraph n to open with the word
  if (constraints.paragraphFirstWord && paras.length >= constraints.paragraphFirstWord.n) {
    const { n, word } = constraints.paragraphFirstWord;
    const idx = n - 1;
    if (paras[idx] && paras[idx].length && !new RegExp('^' + regExpEscape(word) + '\\b', 'i').test(paras[idx][0])) {
      paras[idx][0] = word + ', ' + lowFirst(paras[idx][0]);
    }
  }

  // section labels: "PARAGRAPH 1", "PARAGRAPH 2", ...
  if (constraints.sectionLabel) {
    paras = paras.map((ss, i) => {
      if (!ss.length) return ss;
      const lab = constraints.sectionLabel + ' ' + (i + 1);
      if (!new RegExp('^' + regExpEscape(constraints.sectionLabel) + '\\b', 'i').test(ss[0])) {
        ss = [lab + ' ' + lowFirst(ss[0]), ...ss.slice(1)];
      }
      return ss;
    });
  }

  // keyword backstop: plain keywords woven in by the planner via slot
  // choice; a missing one is appended as its own sentence ONLY when it
  // cannot break counts. keywordFreq ("'replied' appears at least twice")
  // gets a mechanical injector: speech verbs become dialogue, other words
  // get an honest requested-term sentence.
  const SPEECH_VERBS = new Set(['replied', 'said', 'asked', 'whispered', 'shouted', 'answered', 'murmured', 'cried']);
  const wordCount = (w) => (text0.match(new RegExp('\\b' + regExpEscape(w) + '\\b', 'gi')) || []).length;
  const text0 = paras.map(ss => ss.join(' ')).join('\n\n');
  const canInject = !constraints.exactSentences && !constraints.exactWords && !constraints.maxSentences && !constraints.bullets;
  const injectLines = [];
  for (const { word, min } of (constraints.keywordFreq || [])) {
    const have = wordCount(word);
    if (have < min) {
      const need = min - have;
      if (SPEECH_VERBS.has(word.toLowerCase())) {
        injectLines.push(need >= 2
          ? '"I heard you," she ' + word + ', and then she ' + word + ' again.'
          : '"I heard you," she ' + word + '.');
      } else {
        const listed = Array(need).fill('"' + word + '"').join(', ');
        injectLines.push('As requested, the term "' + word + '" appears here ' + need + (need === 1 ? ' time' : ' times') + ': ' + listed + '.');
      }
    }
  }
  const missingPlain = (constraints.keywords || []).filter(k =>
    !new RegExp('\\b' + regExpEscape(k) + '\\b', 'i').test(text0));
  for (const k of missingPlain) injectLines.push('The term ' + k + ' matters here.');
  if (injectLines.length && canInject && paras.length) {
    paras[paras.length - 1] = [...paras[paras.length - 1], ...injectLines];
  }

  // soft word target ("a 400-word essay"): trim whole sentences from the end
  // across trailing paragraphs until near the target, never below minWords
  if (constraints.targetWords > 0 && paras.length) {
    const wordsNow = () => paras.reduce((n, ss) => n + countWords(ss.join(' ')), 0);
    const floor = constraints.minWords || 0;
    const ceil = constraints.targetWords * 1.1;
    let guard = 0;
    while (wordsNow() > ceil && guard++ < 500) {
      let idx = paras.length - 1;
      while (idx > 0 && paras[idx].length <= 1) idx--;
      if (paras[idx].length <= 1 && idx === 0) break;
      const dropped = paras[idx][paras[idx].length - 1];
      if (wordsNow() - countWords(dropped) < floor) break;
      paras[idx].pop();
      if (!paras[idx].length && idx > 0) paras.splice(idx, 1);
    }
  }

  // hard word ceiling ("under 15 words"): drop whole sentences from the end,
  // keeping at least one sentence so the response stays non-empty
  if (constraints.maxWords > 0 && !constraints.bullets && paras.length) {
    const wordsNow = () => paras.reduce((n, ss) => n + countWords(ss.join(' ')), 0);
    let guard = 0;
    while (wordsNow() > constraints.maxWords && guard++ < 200) {
      const total = paras.reduce((n, ss) => n + ss.length, 0);
      if (total <= 1) break;
      const last = paras[paras.length - 1];
      if (last.length > 1) last.pop();
      else paras.pop();
    }
  }

  let text;
  if (constraints.bullets > 0) {
    // bullet mode: one "* ..." per line (the checker is line-based)
    text = paras[0].join('\n').trim();
  } else {
    text = paras.map(ss => ss.join(' ')).join(constraints.paragraphDivider ? '\n' + constraints.paragraphDivider + '\n' : '\n\n').trim();
  }

  // hashtags: append topic-derived tags until the minimum is met
  if (constraints.minHashtags > 0) {
    const have = (text.match(/#/g) || []).length;
    if (have < constraints.minHashtags) {
      const tWords = extractTopic(prompt).phrase.split(/\s+/);
      const topicWord = (tWords.find(w => /^[a-z]{3,}$/i.test(w)) || 'topic').toLowerCase().replace(/[^a-z]/g, '') || 'topic';
      const pool = [topicWord, 'update', 'news', 'daily', 'notes', 'thread'];
      const tags = [];
      for (let i = 0; tags.length < constraints.minHashtags - have && i < 24; i++) {
        const tg = '#' + pool[i % pool.length] + (i >= pool.length ? (Math.floor(i / pool.length) + 1) : '');
        if (!tags.includes(tg)) tags.push(tg);
      }
      text = text.trim() + ' ' + tags.join(' ');
    }
  }

  // all-caps word frequency: uppercase the most frequent content words until
  // the minimum is reached (never exceeding the maximum), topping up across
  // words when one word has too few occurrences
  if (constraints.capsMin > 0 && !constraints.lowerCase) {
    let target = Math.max(constraints.capsMin >= 2 ? constraints.capsMin : 2, constraints.capsMin);
    if (constraints.capsMax > 0) target = Math.min(target, constraints.capsMax);
    const freq = {};
    for (const w of text.split(/[^A-Za-z]+/)) {
      const lw = w.toLowerCase();
      if (lw.length >= 4 && !STOPWORDS.has(lw)) freq[lw] = (freq[lw] || 0) + 1;
    }
    const entries = Object.entries(freq).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    let done = (text.match(/\b[A-Z]+\b/g) || []).length;
    for (const [word] of entries) {
      if (done >= target) break;
      text = text.replace(new RegExp('\\b' + regExpEscape(word) + '\\b', 'gi'), (mm) => {
        if (done < target && mm !== mm.toUpperCase()) { done++; return mm.toUpperCase(); }
        return mm;
      });
    }
  }

  // case transforms apply to prose; structural markers added after keep
  // their required case (PARAGRAPH labels, <<Title>>, P.S.)
  if (constraints.lowerCase) text = text.toLowerCase();
  if (constraints.upperCase) text = text.toUpperCase();

  if (constraints.title && !/<<[^<>]+>>/.test(text)) {
    const titleWords = cap(String(text.split(/\s+/).slice(0, 4).join(' ')));
    text = '<<' + titleWords + '>>\n\n' + text;
  }
  // quote wrap: newlines around the quotes when bullets are present, so each
  // "* ..." line still starts the line (the bullet checker is line-based)
  if (constraints.quoteWrap) {
    text = constraints.bullets > 0 ? '"\n' + text.trim() + '\n"' : '"' + text.trim() + '"';
  }
  if (constraints.exactStart && !text.toLowerCase().startsWith(constraints.exactStart.toLowerCase())) {
    text = constraints.exactStart + ' ' + lowFirst(text);
  }
  if (constraints.exactEnd) {
    const endRe = new RegExp(regExpEscape(constraints.exactEnd) + '[.!?]?\\s*$', 'i');
    if (!endRe.test(text)) text = stripTrailingPunct(text) + ' ' + constraints.exactEnd + '.';
  }
  if (constraints.postscript && !/p\.\s?s\./i.test(text)) {
    text = text.trim() + '\n\nP.S. That is the whole of it.';
  }
  if (constraints.echoPrompt) text = String(prompt).trim() + '\n\n' + text;
  if (constraints.repeatPrompt) {
    const rp = repeatText(prompt);
    if (rp && !text.toLowerCase().startsWith(rp.toLowerCase())) text = rp + '\n\n' + text;
  }
  if (constraints.twoResponses && !secondPass) {
    const other = renderTrace(trace, { constraints, prompt, attempt: attempt + 1000, library, secondPass: true, _quality });
    if (other && other.trim() !== text.trim()) text = text.trim() + '\n******\n' + other.trim();
  }
  return text;
}
function regExpEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// the repeat-prompt instruction excludes its own sentence: the repeated part
// is the request text before "Repeat the request/question..."
function repeatText(prompt) {
  const full = String(prompt || '').trim();
  const cutAt = full.search(/repeat\s+(?:the\s+)?(?:exact\s+)?(?:request|prompt|question)\b/i);
  return (cutAt > 0 ? full.slice(0, cutAt) : full).trim();
}

// ---------------------------------------------------------------------------
// 4. VERIFY — mechanical check against parsed constraints
// ---------------------------------------------------------------------------

function verifyConstraints(text, constraints) {
  const failures = [];
  const t = String(text || '');
  const sw = countSentences(t), ww = countWords(t), pw = countParagraphs(t);
  if (constraints.exactSentences > 0 && sw !== constraints.exactSentences)
    failures.push('sentences ' + sw + ' != ' + constraints.exactSentences);
  if (constraints.minSentences > 0 && sw < constraints.minSentences)
    failures.push('sentences ' + sw + ' < min ' + constraints.minSentences);
  if (constraints.maxSentences > 0 && sw > constraints.maxSentences)
    failures.push('sentences ' + sw + ' > max ' + constraints.maxSentences);
  if (constraints.exactWords > 0 && ww !== constraints.exactWords)
    failures.push('words ' + ww + ' != ' + constraints.exactWords);
  if (constraints.minWords > 0 && ww < constraints.minWords)
    failures.push('words ' + ww + ' < min ' + constraints.minWords);
  if (constraints.maxWords > 0 && ww > constraints.maxWords)
    failures.push('words ' + ww + ' > max ' + constraints.maxWords);
  // soft word target ("a 400-word essay"): accept a band around the target
  if (constraints.targetWords > 0 && !constraints.minWords) {
    const lo = Math.floor(constraints.targetWords * 0.7), hi = Math.ceil(constraints.targetWords * 1.15);
    if (ww < lo || ww > hi) failures.push('words ' + ww + ' outside target band ' + lo + '-' + hi);
  }
  if (constraints.exactParagraphs > 0 && pw !== constraints.exactParagraphs)
    failures.push('paragraphs ' + pw + ' != ' + constraints.exactParagraphs);
  for (const k of (constraints.keywords || [])) {
    if (!new RegExp('\\b' + regExpEscape(k) + '\\b', 'i').test(t)) failures.push('missing keyword: ' + k);
  }
  for (const { word, min } of (constraints.keywordFreq || [])) {
    const n = (t.match(new RegExp('\\b' + regExpEscape(word) + '\\b', 'gi')) || []).length;
    if (n < min) failures.push('keyword frequency: ' + word + ' x' + n + ' < ' + min);
  }
  for (const w of (constraints.forbiddenWords || [])) {
    if (new RegExp('\\b' + regExpEscape(w) + '\\b', 'i').test(t)) failures.push('forbidden word present: ' + w);
  }
  if (constraints.noComma && /,/.test(t)) failures.push('contains comma');
  if (constraints.lowerCase && /[A-Z]/.test(t)) failures.push('has uppercase');
  if (constraints.upperCase && /[a-z]/.test(t)) failures.push('has lowercase');
  // bullets: mirror the official checker (lines starting with "* " or "-")
  if (constraints.bullets > 0) {
    const b1 = (t.match(/^\s*\*[^\*].*$/gm) || []).length;
    const b2 = (t.match(/^\s*-.*$/gm) || []).length;
    if (b1 + b2 !== constraints.bullets) failures.push('bullets ' + (b1 + b2) + ' != ' + constraints.bullets);
  }
  // highlights: mirror the official checker (*...* and **...** sections)
  if (constraints.highlightSections > 0) {
    let n = 0;
    for (const h of (t.match(/\*\*[^\n\*]*\*\*/g) || [])) if (h.replace(/\*/g, '').trim()) n++;
    for (const h of (t.match(/\*[^\n\*]*\*/g) || [])) {
      if (/\*\*/.test(h)) continue; // already counted as double
      if (h.replace(/\*/g, '').trim()) n++;
    }
    if (n < constraints.highlightSections) failures.push('highlights ' + n + ' < ' + constraints.highlightSections);
  }
  if (constraints.quoteWrap) {
    const v = t.trim();
    if (!(v.length > 1 && v[0] === '"' && v[v.length - 1] === '"')) failures.push('not quote-wrapped');
  }
  if (constraints.minHashtags > 0) {
    const n = (t.match(/#/g) || []).length;
    if (n < constraints.minHashtags) failures.push('hashtags ' + n + ' < ' + constraints.minHashtags);
  }
  if (constraints.capsMin > 0 || constraints.capsMax > 0) {
    const n = (t.match(/\b[A-Z]+\b/g) || []).length;
    if (constraints.capsMin > 0 && n < constraints.capsMin) failures.push('caps words ' + n + ' < ' + constraints.capsMin);
    if (constraints.capsMax > 0 && n > constraints.capsMax) failures.push('caps words ' + n + ' > ' + constraints.capsMax);
  }
  if (constraints.repeatPrompt) {
    const rp = repeatText(constraints._prompt || '');
    if (rp && !t.trim().toLowerCase().startsWith(rp.toLowerCase())) failures.push('prompt not repeated');
  }
  if (constraints.twoResponses) {
    const parts = t.split('******').map(s => s.trim()).filter(Boolean);
    if (!(parts.length === 2 && parts[0] !== parts[1])) failures.push('not two responses');
  }
  if (constraints.postscript && !/p\.\s?s\./i.test(t)) failures.push('missing postscript');
  if (constraints.sectionLabel) {
    const n = (t.match(new RegExp('\\b' + regExpEscape(constraints.sectionLabel) + '\\s?\\d+', 'gi')) || []).length;
    const need = constraints.exactParagraphs || 1;
    if (n < need) failures.push('section labels ' + n + ' < ' + need);
  }
  if (constraints.paragraphFirstWord) {
    const { n, word } = constraints.paragraphFirstWord;
    const norm = t.replace(/\n\s*\*\*\*\s*\n/g, '\n\n');
    const paras = norm.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    const first = ((paras[n - 1] || '').split(/\s+/)[0] || '').replace(/^[^\w]+|[^\w]+$/g, '');
    if (first.toLowerCase() !== word.toLowerCase()) failures.push('paragraph ' + n + ' starts with "' + first + '"');
  }
  if (constraints.exactStart && !t.toLowerCase().startsWith(constraints.exactStart.toLowerCase()))
    failures.push('bad start');
  if (constraints.exactEnd && !new RegExp(regExpEscape(constraints.exactEnd) + '[.!?]?\\s*$', 'i').test(t))
    failures.push('bad end');
  if (constraints.title && !/<<[^<>]+>>/.test(t)) failures.push('missing title');
  if (!t.trim()) failures.push('empty');
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// haiku — syllable-budgeted compositional search (5/7/5)
// ---------------------------------------------------------------------------

const HAIKU_FILLER_WORDS = [
  'the', 'a', 'and', 'of', 'in', 'on', 'to',
  'soft', 'still', 'old', 'new', 'cold', 'warm',
  'dawn', 'dusk', 'rain', 'snow', 'wind', 'light',
  'night', 'morning', 'evening', 'silent', 'gentle',
  'river', 'mountain', 'ocean', 'forest', 'meadow',
  'falls', 'drifts', 'waits', 'sleeps', 'sings',
  'through', 'over', 'under', 'beyond', 'among',
];

function composeHaikuLine(candidates, target, seedStr) {
  // deterministic backtracking: candidates sorted by seeded hash
  const cands = candidates
    .map(([w, sy]) => ({ w, sy, h: fnv1a(seedStr + '|' + w) }))
    .filter(c => c.sy <= target)
    .sort((a, b) => a.h - b.h);
  const line = [];
  function bt(rem) {
    if (rem === 0) return true;
    for (const c of cands) {
      if (c.sy > rem) continue;
      if (line.includes(c.w)) continue;
      line.push(c.w);
      if (bt(rem - c.sy)) return true;
      line.pop();
    }
    return false;
  }
  return bt(target) ? line.join(' ') : null;
}

function composeHaiku(topic, ranked) {
  const pool = new Map();
  // every pool entry's syllable count comes from countSyllables — the same
  // function the verifier uses, so composition and verification agree
  for (const w of HAIKU_FILLER_WORDS) pool.set(w, countSyllables(w));
  for (const t of topic.tokens.slice(0, 12)) {
    const sy = countSyllables(t);
    if (sy >= 1 && sy <= 3 && !pool.has(t)) pool.set(t, sy);
  }
  for (const r of ranked.slice(0, 8)) {
    for (const w of contentTokens(r.s).slice(0, 10)) {
      const sy = countSyllables(w);
      if (sy >= 1 && sy <= 3 && !pool.has(w)) pool.set(w, sy);
    }
  }
  const cands = [...pool.entries()];
  const l1 = composeHaikuLine(cands, 5, 'haiku|1|' + topic.phrase);
  const l2 = composeHaikuLine(cands, 7, 'haiku|2|' + topic.phrase);
  const l3 = composeHaikuLine(cands, 5, 'haiku|3|' + topic.phrase);
  if (!l1 || !l2 || !l3) return null;
  // verify with the same counter
  const syl = (line) => line.split(/\s+/).reduce((n, w) => n + countSyllables(w), 0);
  if (syl(l1) !== 5 || syl(l2) !== 7 || syl(l3) !== 5) return null;
  return cap(l1) + '\n' + cap(l2) + '\n' + cap(l3);
}

// ---------------------------------------------------------------------------
// 5. main entry + gating
// ---------------------------------------------------------------------------

const NON_ENGLISH_RE = /\b(?:in|en|auf|em)\s+(french|spanish|german|italian|portuguese|russian|chinese|japanese|korean|arabic|hindi|dutch|swedish|polish|turkish|greek|latin)\b|\btranslate\b/i;
const CODE_RE = /\b(json|yaml|xml|python|javascript|java |c\+\+|sql|html|code\b|function\b)/i;
const MATH_RE = /\b\d+\s*[\+\-\*\/\^%]\s*\d+\b|\bcalculate\b|\bsolve for x\b/i;

function detectImpossible(prompt) {
  const p = String(prompt || '');
  if (NON_ENGLISH_RE.test(p)) return 'non-english';
  if (CODE_RE.test(p)) return 'code';
  if (MATH_RE.test(p)) return 'math';
  return null;
}

// Conservative gating for the runtime hook: only prompts with generative
// intent (or creative requests the creative core missed). Never fires on
// math/code/non-English. Hard denylist: instruction shapes the core cannot
// satisfy (placeholders, JSON, fixed option sets, verbatim rewrites of
// supplied text, synonym lookup, two-part answer-then-expand) — attempting
// those can only replace a working response with a failing one.
const NO_ATTEMPT_RE = /another word for|\bsynonym\b|\bTL;?DR\b/i;
function shouldAttempt(prompt, creativeIsCreative) {
  const p = String(prompt || '');
  if (!p || p.length < 12) return false;
  if (detectImpossible(p)) return false;
  const c = parseConstraints(p);
  if (c.placeholders || c.jsonFormat || c.constrainedResponse) return false;
  if (NO_ATTEMPT_RE.test(p)) return false;
  if (/\brewrite\b|\btransform\b/i.test(p)) return false;
  if (/answer\b[^.]{0,60}\bfirst\b[^.]{0,20}\bthen\b/i.test(p)) return false;
  if (parseIntent(p) !== 'general') return true;
  if (creativeIsCreative) return true;
  // short-form social creative with mechanical constraints (hashtags, case)
  if (/\btweet\b|\btwitter\b|\bhashtag/i.test(p)) return true;
  // long-form demands are generative even without intent verbs
  if (/\b(essay|article|write about|discuss)\b/i.test(p) && /(word|paragraph|page)/i.test(p)) return true;
  return false;
}

function generate({ prompt, sentences = [], inducedOperators = null, maxTries = 3 } = {}) {
  const p = String(prompt || '');
  const impossible = detectImpossible(p);
  if (impossible) return { impossible, text: null };

  // quality layer loads lazily (never breaks the plain path if absent)
  let qualityMod = null;
  try { qualityMod = require('./lari_gen_quality.js'); } catch (_) {}

  // haiku special-case: syllable composition, not operator trace
  if (/\bhaiku\b/i.test(p)) {
    const topic = extractTopic(p);
    const ranked = rankSentences(sentences, topic.tokens);
    const hConstraints = parseConstraints(p);
    let text = null, haiku2 = false;
    if (qualityMod) {
      try {
        const hq = qualityMod.composeHaiku2(topic, ranked);
        // gate the quality haiku on parsed prompt constraints (2026-09-22:
        // an ungated quality haiku regressed IFEval prompts with no_comma);
        // fall back to the plain haiku when it violates them.
        if (hq && !(hConstraints.noComma && /,/.test(hq))) { text = hq; haiku2 = true; }
      } catch (_) {}
    }
    if (!text) text = composeHaiku(topic, ranked);
    if (!text) return { impossible: null, text: null };
    return { impossible: null, text, trace: [{ op: 'haiku', slots: {} }], verified: true, intent: 'haiku', haiku2 };
  }

  const intent = parseIntent(p);
  const constraints = parseConstraints(p);
  constraints._prompt = p; // repeatPrompt verify needs the original prompt
  const topic = extractTopic(p);
  const ranked = rankSentences(sentences, topic.tokens);
  if (!ranked.length) return { impossible: null, text: null }; // no grounded knowledge: stay honest

  let library = OPERATORS;
  if (inducedOperators) {
    try {
      const m = mergeInducedOperators(inducedOperators);
      if (m.merged > 0) library = m.library;
    } catch (_) {}
  }

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const trace = planTrace({ intent, topic, constraints, ranked, seedSalt: p + '|' + attempt, attempt });
    // QUALITY-FIRST (2026-09-22 product decision): the whole-sentence /
    // grammar quality renderer is now the primary path — it is designed for
    // grammatical output (human-written sentences, grammar-generated story
    // and haiku), which strictly dominates the fragment-stuffing plain
    // renderer on prose quality. The plain renderer remains as fallback.
    // Both are gated on the same verifyConstraints contract.
    let text = null, v = { ok: false };
    let qualityUsed = false, qualityStats = null;
    if (qualityMod) {
      try {
        const qr = qualityMod.renderTraceQuality(trace, { constraints, prompt: p, attempt, library, ranked });
        if (qr && qr.text && verifyConstraints(qr.text, constraints).ok) {
          text = qr.text; v = verifyConstraints(text, constraints);
          qualityUsed = true; qualityStats = qr.stats;
        }
      } catch (_) {}
    }
    if (!v.ok) {
      text = renderTrace(trace, { constraints, prompt: p, attempt, library });
      v = verifyConstraints(text, constraints);
    }
    if (v.ok) return { impossible: null, text, trace, verified: true, intent, attempt, qualityUsed, qualityStats };
    // repair = re-plan with a new seed AND a grown trace (planTrace grows
    // long-form traces per attempt); pattern choice and slot fillers change
  }
  return { impossible: null, text: null, verified: false, intent };
}

module.exports = {
  OPERATORS,
  RELATION_TO_OPERATOR,
  mergeInducedOperators,
  parseIntent,
  parseConstraints,
  extractTopic,
  planTrace,
  renderTrace,
  verifyConstraints,
  composeHaiku,
  countSyllables,
  shouldAttempt,
  detectImpossible,
  generate,
  // quality-layer surface (lari_gen_quality.js)
  renderPattern,
  fnv1a,
  contentTokens,
  STOPWORDS,
  cap,
  lowFirst,
  stripTrailingPunct,
};
