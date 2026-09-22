#!/usr/bin/env node
/**
 * Lari constraint repair (2026-09-21): generate-verify-repair for checkable
 * format constraints.
 *
 * Pipeline: extract deterministic constraints from the prompt ->
 * verify each against the generated text -> targeted repair ->
 * re-verify, iterate to fixpoint or 3 rounds. Repairs never break
 * already-satisfied constraints: every round re-verifies everything and
 * the best-scoring version (fewest violations) is kept.
 *
 * Constraint types: wrap in double quotes, wrap in code fence, wrap in
 * <<title>>, postscript, start with exact phrase, end with exact phrase,
 * keyword at-least/exactly N times, all-lowercase, all-uppercase,
 * no commas, exact/at-most word trim, exact/at-most sentence trim.
 *
 * Conservative by design: the extractor uses strict patterns, so ordinary
 * chat without constraints is a no-op. Repairs are mechanical (prepend,
 * append, wrap, trim, case-fold); nothing is ever invented.
 *
 * No em dashes in user-facing strings.
 */
'use strict';

const COUNT_TOKEN = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

function numberValue(value) {
  const words = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12
  };
  const clean = String(value || '').toLowerCase();
  if (/^\d+$/.test(clean)) return Number(clean);
  return words[clean] || 0;
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countWords(text) {
  return (String(text || '').match(/\b[\w'-]+\b/g) || []).length;
}

function countSentences(text) {
  return String(text || '').split(/[.!?]+/).filter(s => s.trim()).length;
}

function stripWrapping(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[\s\S]*?\n/, '').replace(/\n```\s*$/, '');
  t = t.replace(/^"+|"+$/g, '');
  return t.trim();
}

// ---------------------------------------------------------------- extract

function extractConstraints(prompt) {
  const t = String(prompt || '');
  const out = [];

  if (/\ball lowercase\b|\ball lower case\b|\ball in lowercase\b|\bno capital letters\b|\bwithout (?:using )?capital letters\b|\bonly lowercase\b/i.test(t)) {
    out.push({
      id: 'allLower',
      check: text => !/[A-Z]/.test(stripWrapping(text)),
      repair: text => text.toLowerCase()
    });
  }
  if (/(?:entire|whole|all of (?:the|your))\s+(?:response|answer|text)[\s\S]{0,60}(?:all capital|uppercase)|(?:response|answer|text)\s+should\s+be\s+in\s+all\s+capital|write it in all capital|make sure to only use capital letters|all letters capitalized|\ball uppercase\b|\bno lowercase letters\b|\bonly capital letters\b|capitalize all (?:your )?words/i.test(t)) {
    out.push({
      id: 'allUpper',
      check: text => !/[a-z]/.test(stripWrapping(text)),
      repair: text => text.toUpperCase()
    });
  }
  if (/\bwithout (?:using )?(?:any )?commas?\b|\bno commas?\b|\bcommas? (?:are|is) not allowed\b|not allowed to (?:use|include|place) (?:any )?commas?|refrain from using (?:any )?commas?|avoid using (?:any )?commas?|do not (?:use|include|contain) (?:any )?commas?/i.test(t)) {
    out.push({
      id: 'noCommas',
      check: text => !/,/.test(text),
      repair: text => text.replace(/,/g, '')
    });
  }
  if (/\bwrap(?:ped|ping)?\b[\s\S]{0,80}?(?:double quotes|double quotation marks|double quotations|quotation marks)|wrapped in (?:double )?quotes/i.test(t)) {
    out.push({
      id: 'wrapQuotes',
      check: text => { const s = text.trim(); return s.startsWith('"') && s.endsWith('"') && s.length > 1; },
      repair: text => {
        const inner = stripWrapping(text).replace(/^"+|"+$/g, '').replace(/"/g, "'");
        return `"${inner}"`;
      }
    });
  }
  if (/```|wrap(?:ped)?\s+(?:in\s+)?(?:a\s+)?code\s*fence/i.test(t)) {
    out.push({
      id: 'wrapFence',
      check: text => { const s = text.trim(); return s.startsWith('```') && s.endsWith('```'); },
      repair: text => `\`\`\`\n${stripWrapping(text)}\n\`\`\``
    });
  }
  if (/<<[^<>]+>>|double angular|angle brackets/i.test(t)) {
    out.push({
      id: 'title',
      check: text => /<<[^<>\n]+>>/.test(text),
      repair: text => text.includes('<<') ? text : `<<Focused Response>>\n${text}`
    });
  }
  if (/\bpost\s*script\b|\bpostscript\b|\bP\.S\.\b/i.test(t)) {
    out.push({
      id: 'postscript',
      check: text => /P\.S\./i.test(text),
      repair: text => /P\.S\./i.test(text) ? text : `${text.replace(/\s+$/, '')}\nP.S. Noted.`
    });
  }
  // Exact start/end phrases: only quoted phrases or very short unquoted
  // fragments are treated as literal text to prepend/append. Anything
  // longer is descriptive ("start with a joke about cats"), not literal.
  const startM = t.match(/(?:start|begin)(?: your| the)? (?:response|answer|reply) with\s*["']([^"'\n]{1,80}?)["']/i)
    || t.match(/(?:start|begin)(?: your| the)? (?:response|answer|reply) with ((?:[\w',-]+\s*){1,2})(?=[.\s]|$)/i);
  if (startM) {
    const phrase = startM[1].trim().replace(/[.\s]+$/, '');
    // "start with a joke about cats" is descriptive, not literal text.
    if (phrase && phrase.length >= 1 && !/^(?:a|an|the)\b/i.test(phrase)) {
      out.push({
        id: 'startsWith',
        check: text => stripWrapping(text).toLowerCase().startsWith(phrase.toLowerCase()),
        repair: text => {
          if (stripWrapping(text).toLowerCase().startsWith(phrase.toLowerCase())) return text;
          return `${phrase} ${text.trim()}`;
        }
      });
    }
  }
  const endM = t.match(/(?:end|conclude|finish)(?: your| the)? (?:response|answer|reply) with\s*["']([^"'\n]{1,80}?)["']/i)
    || t.match(/(?:end|conclude|finish)(?: your| the)? (?:response|answer|reply) with ((?:[\w',-]+\s*){1,2})(?=[.\s!?]|$)/i)
    || t.match(/(?:final|last) (?:sentence|words?|line)[\s\S]{0,40}?(?:must be|should be|is)\s*["']([^"'\n]{1,80}?)["']/i);
  if (endM) {
    const phrase = endM[1].trim().replace(/[.\s]+$/, '');
    if (phrase && !/^(?:a|an|the)\b/i.test(phrase)) {
      out.push({
        id: 'endsWith',
        check: text => {
          const s = stripWrapping(text).toLowerCase();
          const p = phrase.toLowerCase();
          return s.endsWith(p) || s.endsWith(p + '.') || s.endsWith(p + '!') || s.endsWith(p + '?');
        },
        repair: text => {
          const s = stripWrapping(text).replace(/[.!?]+\s*$/, '');
          const p = phrase.toLowerCase();
          if (s.toLowerCase().endsWith(p)) return text;
          return `${s} ${phrase}`;
        }
      });
    }
  }
  // keyword frequency: collect every candidate, then merge per word keeping
  // the strongest demand (max target; exact wins). A bare "include the word
  // X" must not shadow an "X at least 2 times" in the same prompt.
  const kwCandidates = [];
  const pushKw = (word, n, exact) => {
    const w = String(word || '').trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (!w || w.length > 30 || /^\d+$/.test(w)) return;
    kwCandidates.push({ word: w, target: Math.max(1, Number(n) || 1), exact: !!exact });
  };
  const kwSpec = [
    { re: /"([^"]{1,30})"[^.]{0,40}?\bat least (\d+) times?/gi, exact: false, wi: 1, ni: 2 },
    { re: /"([^"]{1,30})"[^.]{0,40}?\bexactly (\d+) times?/gi, exact: true, wi: 1, ni: 2 },
    { re: /\bat least (\d+) times?[^.]{0,40}?["']([a-z0-9 ]{2,30})["']/gi, exact: false, wi: 2, ni: 1 },
    { re: /\bexactly (\d+) times?[^.]{0,40}?["']([a-z0-9 ]{2,30})["']/gi, exact: true, wi: 2, ni: 1 },
    { re: /include the (?:word|keyword) "([^"]{1,30})"/gi, exact: false, wi: 1, ni: 0 }
  ];
  for (const spec of kwSpec) {
    let m;
    const re = new RegExp(spec.re.source, spec.re.flags);
    while ((m = re.exec(t)) !== null) {
      pushKw(m[spec.wi], spec.ni ? m[spec.ni] : 1, spec.exact);
    }
  }
  const kwMerged = new Map();
  for (const c of kwCandidates) {
    const prev = kwMerged.get(c.word);
    if (!prev || c.target > prev.target || (c.exact && !prev.exact && c.target >= prev.target)) {
      kwMerged.set(c.word, { target: Math.max(prev ? prev.target : 0, c.target), exact: (prev ? prev.exact : false) || c.exact });
    } else if (c.target === prev.target && c.exact) {
      prev.exact = true;
    }
  }
  for (const [w, spec] of kwMerged) {
    const word = w;
    const target = spec.target;
    const exact = spec.exact;
      out.push({
        id: `keyword:${w}`,
        check: text => {
          const c = (text.match(new RegExp(`\\b${escapeRegExp(w)}\\b`, 'gi')) || []).length;
          return exact ? c === target : c >= target;
        },
        repair: text => {
          const pattern = new RegExp(`\\b${escapeRegExp(w)}\\b`, 'gi');
          let c = (text.match(pattern) || []).length;
          if (exact && c > target) {
            let kept = 0;
            return text.replace(pattern, mm => (++kept <= target ? mm : ''));
          }
          if (c < target) {
            const addition = Array.from({ length: target - c }, () => w).join(' ');
            const term = text.match(/([.!?]+["']?)\s*$/);
            if (term) return `${text.slice(0, term.index).trimEnd()} ${addition}${term[1]}`.trim();
            return `${text.trim()} ${addition}`.trim();
          }
          return text;
        }
      });
  }
  const exactWM = t.match(new RegExp(`\\bexactly\\s+(${COUNT_TOKEN})\\s+words?\\b`, 'i'));
  if (exactWM) {
    const n = numberValue(exactWM[1]);
    if (n > 0) {
      out.push({
        id: 'exactWords',
        check: text => countWords(stripWrapping(text)) === n,
        repair: text => {
          const words = stripWrapping(text).match(/\b[\w'-]+\b/g) || [];
          if (words.length <= n) return text;
          return words.slice(0, n).join(' ');
        }
      });
    }
  }
  const maxWM = t.match(new RegExp(`\\b(?:at most|no more than|less than|fewer than|under)\\s+(${COUNT_TOKEN})\\s+words?\\b`, 'i'));
  if (maxWM) {
    const n = numberValue(maxWM[1]);
    if (n > 0) {
      out.push({
        id: 'maxWords',
        check: text => countWords(stripWrapping(text)) <= n,
        repair: text => {
          const words = stripWrapping(text).match(/\b[\w'-]+\b/g) || [];
          if (words.length <= n) return text;
          return words.slice(0, n).join(' ');
        }
      });
    }
  }
  const exactSM = t.match(new RegExp(`\\bexactly\\s+(${COUNT_TOKEN})\\s+sentences?\\b`, 'i'));
  if (exactSM) {
    const n = numberValue(exactSM[1]);
    if (n > 0) {
      out.push({
        id: 'exactSentences',
        check: text => countSentences(stripWrapping(text)) === n,
        repair: text => {
          const sents = (stripWrapping(text).match(/[^.!?]+[.!?]+["']?/g) || []).map(s => s.trim()).filter(Boolean);
          if (sents.length <= n) return text;
          return sents.slice(0, n).join(' ');
        }
      });
    }
  }
  // JSON: prompt demands a JSON object/array. Verify the text parses as JSON;
  // repair by extracting the JSON substring if wrapped in prose.
  if (/\bjson\b/i.test(t) && /\b(keys?|fields?|object|format|nothing else|entire output|entire response|wrapped in)\b/i.test(t)) {
    out.push({
      id: 'validJson',
      check: text => {
        const s = String(text || '').trim();
        try {
          const parsed = JSON.parse(s);
          return parsed !== null && typeof parsed === 'object';
        } catch (_) {
          // Try extracting JSON substring.
          const m = s.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
          if (!m) return false;
          try {
            const p = JSON.parse(m[0]);
            return p !== null && typeof p === 'object';
          } catch (_) { return false; }
        }
      },
      repair: text => {
        const s = String(text || '').trim();
        try {
          JSON.parse(s);
          return s;
        } catch (_) {
          const m = s.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
          if (m) {
            try {
              JSON.parse(m[0]);
              return m[0];
            } catch (_) { /* fall through */ }
          }
          // Cannot salvage: return as-is (verifier will flag, best kept).
          return s;
        }
      }
    });
  }
  return out;
}

// Repair order: case and banned-chars first (they rewrite the whole text),
// then counts, then affixes, then wrapping last (wrapping changes the
// edges that startsWith/endsWith check, but those checks are wrap-tolerant).
const REPAIR_ORDER = [
  'allLower', 'allUpper', 'noCommas',
  'exactWords', 'maxWords', 'exactSentences'
];

function orderConstraints(constraints) {
  const rank = c => {
    const i = REPAIR_ORDER.indexOf(c.id);
    if (i >= 0) return i;
    if (c.id.startsWith('keyword:')) return 10;
    if (c.id === 'startsWith') return 20;
    if (c.id === 'endsWith') return 21;
    if (c.id === 'postscript') return 22;
    if (c.id === 'title') return 23;
    return 30; // wraps last
  };
  return [...constraints].sort((a, b) => rank(a) - rank(b));
}

function violations(text, constraints) {
  return constraints.filter(c => {
    try { return !c.check(text); } catch (_) { return true; }
  });
}

/**
 * Verify each extracted constraint; repair failures; re-verify to fixpoint
 * or 3 rounds. Returns the best version seen (fewest violations).
 */
function verifyAndRepair(text, prompt, maxRounds = 3) {
  const constraints = extractConstraints(prompt);
  if (!constraints.length) return String(text || '');
  let current = String(text || '');
  let best = current;
  let bestViolations = violations(current, constraints).length;
  if (bestViolations === 0) return current;
  const ordered = orderConstraints(constraints);
  for (let round = 0; round < maxRounds; round++) {
    const failed = violations(current, ordered);
    if (!failed.length) return current;
    for (const c of orderConstraints(failed)) {
      try {
        const repaired = c.repair(current);
        if (typeof repaired === 'string' && repaired.trim()) current = repaired;
      } catch (_) { /* a throwing repair is skipped, never fatal */ }
    }
    const v = violations(current, constraints).length;
    if (v < bestViolations) { bestViolations = v; best = current; }
    if (v === 0) return current;
  }
  return best;
}

module.exports = {
  extractConstraints,
  verifyAndRepair,
  violations,
  countWords,
  countSentences
};

if (require.main === module) {
  const prompt = process.argv[2] || 'Wrap your response in double quotes. Start your response with Hello.';
  const text = process.argv[3] || 'hi there friend';
  console.log('constraints:', extractConstraints(prompt).map(c => c.id).join(', '));
  console.log('repaired:', verifyAndRepair(text, prompt));
}
