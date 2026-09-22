#!/usr/bin/env node
/**
 * Lari giants registry: the "shoulders of giants" voice lenses.
 *
 * Each giant is a writer/thinker/musician Greg chose. Each giant carries 2-3
 * lens operators. A lens operator is a REAL deterministic text transform
 * (string in, string out), never a vibe description. The fractal composer
 * braids drafts through these lenses; the consistency gate decides what
 * survives. Every applied lens is recorded in the derivation trace, which is
 * the honesty guarantee: no sentence appears that cannot show its derivation.
 *
 * Zero external model calls. No network. Pure functions only.
 *
 * Registry data is assembled here via registerGiants(). Phase 2 will let Lari
 * research additional giants himself through the research loop instead of
 * relying on hand-authored lenses.
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

// Common verbs, for transforms that need to find or echo a verb. Deliberately
// small and plain; lenses must degrade gracefully when no verb is found.
const VERBS = [
  'run', 'runs', 'flow', 'flows', 'carve', 'carves', 'cut', 'cuts', 'move', 'moves',
  'carry', 'carries', 'shape', 'shapes', 'feed', 'feeds', 'make', 'makes', 'take', 'takes',
  'give', 'gives', 'go', 'goes', 'come', 'comes', 'sing', 'sings', 'play', 'plays',
  'write', 'writes', 'speak', 'speaks', 'tell', 'tells', 'walk', 'walks', 'roll', 'rolls',
  'keep', 'keeps', 'hold', 'holds', 'bring', 'brings', 'turn', 'turns', 'fall', 'falls',
  'rise', 'rises', 'bend', 'bends', 'wind', 'winds', 'dance', 'dances', 'whisper', 'whispers',
  'roar', 'roars', 'sleep', 'sleeps', 'dream', 'dreams', 'remember', 'remembers',
  'forget', 'forgets', 'stand', 'stands', 'sit', 'sits', 'lie', 'lies', 'wait', 'waits',
  'watch', 'watches', 'follow', 'follows', 'lead', 'leads', 'break', 'breaks', 'build', 'builds',
  'burn', 'burns', 'shine', 'shines', 'fade', 'fades', 'grow', 'grows', 'die', 'dies',
  'live', 'lives', 'love', 'loves', 'hate', 'hates', 'know', 'knows', 'see', 'sees',
  'hear', 'hears', 'feel', 'feels', 'find', 'finds', 'lose', 'loses', 'leave', 'leaves',
  'return', 'returns', 'begin', 'begins', 'end', 'ends'
];

function hash(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

const util = {
  STOPWORDS,
  VERBS,
  hash,
  sentences(text) {
    const parts = String(text || '').match(/[^.!?]+[.!?]+["']?/g) || [];
    const out = parts.map(p => p.trim()).filter(Boolean);
    const rest = String(text || '').replace(/[^.!?]+[.!?]+["']?/g, '').trim();
    if (rest) out.push(rest);
    return out.length ? out : [String(text || '').trim()].filter(Boolean);
  },
  words(text) {
    return (String(text || '').toLowerCase().match(/[a-z][a-z']*/g) || []);
  },
  contentWords(text) {
    const seen = new Set();
    const out = [];
    for (const w of util.words(text)) {
      if (w.length >= 3 && !STOPWORDS.has(w) && !seen.has(w)) { seen.add(w); out.push(w); }
    }
    return out;
  },
  nouns(text) {
    // Heuristic content nouns: longer content words, appearance order, deduped.
    // Excludes the verb allowlist so echo-type lenses do not nominalize verbs
    // ("holy the begin"). Still heuristic, never a real POS tagger.
    const seen = new Set();
    const out = [];
    for (const w of util.words(text)) {
      if (w.length >= 4 && !STOPWORDS.has(w) && !VERBS.includes(w) && !seen.has(w)) { seen.add(w); out.push(w); }
    }
    return out;
  },
  verbs(text) {
    const seen = new Set();
    const out = [];
    for (const w of util.words(text)) {
      if (VERBS.includes(w) && !seen.has(w)) { seen.add(w); out.push(w); }
    }
    return out;
  },
  pick(list, key) {
    if (!Array.isArray(list) || !list.length) return undefined;
    return list[hash(String(key)) % list.length];
  },
  stripEnd(text) {
    return String(text || '').replace(/[.!?]+["']?\s*$/, '').trim();
  },
  endWith(text, mark = '.') {
    return util.stripEnd(text) + mark;
  },
  lowerFirst(s) {
    s = String(s || '');
    return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  },
  capFirst(s) {
    s = String(s || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  },
  hasNegation(text) {
    return /\b(not|never|no|n't|nothing|none|nobody)\b/i.test(String(text || ''));
  },
  sanitize(text) {
    // No em dashes in user-facing strings, ever. Commas do the job.
    return String(text || '').replace(/\u2014/g, ',').replace(/\u2013/g, ',');
  },
  wordCount(text) {
    return (String(text || '').match(/[a-zA-Z][a-zA-Z']*/g) || []).length;
  }
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Registry data: 31 giants across four category modules (untracked prototype
// files, each a tested unit). Every lens is a pure (text, util) => string
// transform. Phase 2 will let Lari research new giants himself instead of
// hand-authored lenses.
// ---------------------------------------------------------------------------
let GIANTS = [].concat(
  require('./lari_giants_writers.js'),
  require('./lari_giants_rap.js'),
  require('./lari_giants_rock_country_blues.js'),
  require('./lari_giants_newschool.js')
);
function registerGiants(arr) {
  if (!Array.isArray(arr)) throw new Error('registerGiants expects an array');
  GIANTS = arr;
}

function listGiants() {
  return GIANTS.slice();
}

function getGiant(id) {
  return GIANTS.find(g => g.id === id) || null;
}

function validateRegistry() {
  const errors = [];
  const seen = new Set();
  for (const g of GIANTS) {
    if (!g || typeof g !== 'object') { errors.push('registry entry is not an object'); continue; }
    for (const field of ['id', 'name', 'voice']) {
      if (!g[field] || typeof g[field] !== 'string') errors.push(`${g.id || '?'}: missing ${field}`);
    }
    if (seen.has(g.id)) errors.push(`duplicate giant id: ${g.id}`);
    seen.add(g.id);
    if (!Array.isArray(g.sources) || !g.sources.length) errors.push(`${g.id}: no sources`);
    if (!Array.isArray(g.lenses) || g.lenses.length < 2 || g.lenses.length > 3) {
      errors.push(`${g.id}: expected 2-3 lenses, got ${(g.lenses || []).length}`);
    }
    const lensSeen = new Set();
    for (const lens of (g.lenses || [])) {
      if (lensSeen.has(lens.id)) errors.push(`${g.id}: duplicate lens id ${lens.id}`);
      lensSeen.add(lens.id);
      for (const field of ['id', 'name', 'description']) {
        if (!lens[field] || typeof lens[field] !== 'string') errors.push(`${g.id}: lens missing ${field}`);
      }
      if (typeof lens.transform !== 'function') errors.push(`${g.id}/${lens.id}: transform is not a function`);
      for (const s of [g.voice, g.name, lens.name, lens.description]) {
        if (/\u2014|\u2013/.test(String(s || ''))) errors.push(`${g.id}/${lens.id}: em dash in static string`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// Review harness: run every lens over sample inputs, report throws,
// em dashes, and word-count anomalies. Used to catch word salad before it ships.
function smokeTestLenses(sampleInputs) {
  const report = [];
  for (const g of GIANTS) {
    for (const lens of g.lenses) {
      for (const input of sampleInputs) {
        let output;
        try {
          output = lens.transform(input, util);
        } catch (error) {
          report.push({ giant: g.id, lens: lens.id, input, status: 'THREW', detail: error.message });
          continue;
        }
        if (typeof output !== 'string') {
          report.push({ giant: g.id, lens: lens.id, input, status: 'NOT_STRING', detail: typeof output });
          continue;
        }
        const problems = [];
        if (/[\u2014\u2013]/.test(output)) problems.push('em-dash');
        const wc = util.wordCount(output);
        if (output !== input && (wc < 4 || wc > 60)) problems.push(`word-count=${wc}`);
        report.push({
          giant: g.id, lens: lens.id, input,
          status: problems.length ? 'SUSPECT' : 'OK',
          detail: problems.join(',') || `${wc}w`,
          output: output.slice(0, 160)
        });
      }
    }
  }
  return report;
}

module.exports = {
  util,
  registerGiants,
  listGiants,
  getGiant,
  validateRegistry,
  smokeTestLenses
};

if (require.main === module) {
  const v = validateRegistry();
  console.log(`giants: ${GIANTS.length}, lenses: ${GIANTS.reduce((n, g) => n + g.lenses.length, 0)}`);
  console.log(v.ok ? 'registry valid' : `INVALID:\n- ${v.errors.join('\n- ')}`);
  process.exit(v.ok ? 0 : 1);
}
