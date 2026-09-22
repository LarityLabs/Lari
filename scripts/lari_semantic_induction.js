#!/usr/bin/env node
/**
 * lari_semantic_induction.js — native semantic-operator induction loop for Small Lari.
 *
 * Small Lari's own novel understanding-side learning loop. From 2-4 examples of
 * one grammatical construction (taught explicitly or harvested from corrections),
 * Lari deterministically induces an executable semantic operator record:
 *   { markers, boundary, roles, truth conditions, modality, refusal policy }
 * and retains it in the model JSON state. The canonical understanding path then
 * consults those operators on every turn, supplying typed semantic relations
 * (cause(A,B), contrast(A,B), condition(A,B), purpose, counterfactual, ...) to
 * downstream chat/research logic.
 *
 * Design rules (all deliberate):
 * - Deterministic: seeded FNV-1a hashing for record IDs, fixed family order,
 *   longest-marker-first matching, fully ordered candidate tie-breaking.
 *   Same input twice -> byte-identical output.
 * - Zero external model calls. Zero neural inference. Pure rule-based induction.
 * - Honest scoping: induction only fires when a majority of examples share one
 *   relation, one marker family, and one surface order. Minority examples are
 *   quarantined with a logged reason, never silently merged. Markers recorded
 *   are the UNION of observed markers (never unobserved family members).
 *   Nonmatching surfaces are refused (null), never guessed.
 * - Noise tolerance (explicit, bounded): case-insensitive; Damerau distance <=1
 *   for single-word markers of length >= 5 ("becuase" -> because); semicolons
 *   accepted as clause boundaries; missing commas accepted ONLY when exactly
 *   one determiner-anchored split yields two valid role spans. Ambiguity ->
 *   refusal, never a guess.
 * - Nesting policy: OUTERMOST marker wins. Inner constructions are preserved
 *   verbatim inside role spans and never re-parsed (no misattribution).
 *   Same surface position: narrower (guard-constrained) construction wins.
 * - Observation only: noteTurn() never alters an answer; it records evidence,
 *   induces operators, and reports what fired for the debug trace.
 * - State hardening: corrupt records are skipped, never crash; unknown future
 *   schema versions degrade to no-op with a logged reason; pending windows
 *   are bounded; quarantine is bounded.
 *
 * Model state section: model.learned_semantic_operators = {
 *   schemaVersion: 1, entries: [operator records], pending: {signature: [examples]},
 *   quarantined: [ {text, reason, signature, seq} ],
 *   stats: { taught, corrections, induced, quarantined, understood: {...}, recentFires: [] }
 * }
 */
'use strict';

const SCHEMA_VERSION = 1;
const MIN_EXAMPLES = 2;
const MAX_EXAMPLES = 4;
const MAX_QUARANTINE = 50;
const SECTION = 'learned_semantic_operators';

// ---------------------------------------------------------------------------
// Seeded construction specs. These are Small Lari's native authored semantics:
// the *candidate space*. Induction only retains what 2+ real examples confirm.
//
// truth values: true = asserted, false = denied, 'conditional' = hypothetical,
//               'intended' = goal state.
// roleOrder: [leftSpanRole, rightSpanRole] — which role each side of the
//   marker/boundary fills. (Mid-order families flip cause/effect etc.)
// guard: named disambiguation rule (see GUARDS). Families with guards are
//   narrower constructions and win ties at the same surface position.
// ---------------------------------------------------------------------------
const CONSTRUCTIONS = [
  {
    relation: 'cause',
    roles: ['cause', 'effect'], // mirrors generator's cause slots
    families: [
      {
        id: 'because_front',
        markers: ['because', 'since'],
        order: 'marker_first', // "Because A, B" / "Since A, B"
        boundary: 'comma',
        roleOrder: ['cause', 'effect'],
        truth: { cause: true, effect: true },
        modality: 'actual',
        guard: 'since_pragmatic',
        // 'as' excluded: hopelessly ambiguous with temporal 'as'.
      },
      {
        id: 'because_mid',
        markers: ['because', 'since'],
        order: 'marker_mid', // "B because A" / "B since A"
        boundary: 'none',
        roleOrder: ['effect', 'cause'],
        truth: { cause: true, effect: true },
        modality: 'actual',
        guard: 'since_pragmatic',
      },
    ],
  },
  {
    relation: 'contrast',
    roles: ['a', 'b'], // mirrors generator's contrast slots
    families: [
      {
        id: 'concessive_front',
        markers: ['even though', 'although', 'though'],
        order: 'marker_first', // "Although A, B"
        boundary: 'comma',
        roleOrder: ['a', 'b'],
        truth: { a: true, b: true },
        modality: 'actual',
      },
      {
        id: 'while_front',
        markers: ['while'],
        order: 'marker_first', // "While A, B" (concessive reading)
        boundary: 'comma',
        roleOrder: ['a', 'b'],
        truth: { a: true, b: true },
        modality: 'actual',
        guard: 'while_temporal',
        // Temporal "while" (progressive / time-headed clause) is refused.
      },
      {
        id: 'contrast_mid',
        markers: ['but', 'yet'],
        order: 'marker_mid', // "A but B" / "A, yet B"
        boundary: 'none',
        roleOrder: ['a', 'b'],
        truth: { a: true, b: true },
        modality: 'actual',
      },
    ],
  },
  {
    // Narrower than plain condition: must come before it so the guarded
    // construction wins ties at the same surface position.
    relation: 'counterfactual',
    roles: ['antecedent', 'consequent'],
    families: [
      {
        id: 'cf_front',
        markers: ['if'],
        order: 'marker_first', // "If he had left, he would have arrived."
        boundary: 'comma',
        roleOrder: ['antecedent', 'consequent'],
        truth: { antecedent: false, consequent: false },
        modality: 'past_counterfactual',
        guard: 'cf_form',
      },
      {
        id: 'cf_mid',
        markers: ['if'],
        order: 'marker_mid', // "He would have arrived if he had left."
        boundary: 'none',
        roleOrder: ['consequent', 'antecedent'],
        truth: { antecedent: false, consequent: false },
        modality: 'past_counterfactual',
        guard: 'cf_form',
      },
    ],
  },
  {
    relation: 'condition',
    roles: ['condition', 'outcome'], // mirrors generator's condition slots
    families: [
      {
        id: 'if_front',
        markers: ['if'],
        order: 'marker_first', // "If A, B"
        boundary: 'comma',
        roleOrder: ['condition', 'outcome'],
        truth: { condition: 'conditional', outcome: 'conditional' },
        modality: 'hypothetical',
        guard: 'pragmatic_if',
      },
      {
        id: 'unless_front',
        markers: ['unless'],
        order: 'marker_first', // "Unless A, B"
        boundary: 'comma',
        roleOrder: ['condition', 'outcome'],
        truth: { condition: false, outcome: true },
        modality: 'hypothetical',
      },
      {
        id: 'unless_mid',
        markers: ['unless'],
        order: 'marker_mid', // "B unless A"
        boundary: 'none',
        roleOrder: ['outcome', 'condition'],
        truth: { condition: false, outcome: true },
        modality: 'hypothetical',
      },
    ],
  },
  {
    relation: 'purpose',
    roles: ['action', 'purpose'],
    families: [
      {
        id: 'in_order_to_front',
        markers: ['in order to'],
        order: 'marker_first', // "In order to P, A"
        boundary: 'comma',
        roleOrder: ['purpose', 'action'],
        truth: { action: true, purpose: 'intended' },
        modality: 'intentional',
      },
      {
        id: 'to_front',
        markers: ['to'],
        order: 'marker_first', // "To P, A"
        boundary: 'comma',
        roleOrder: ['purpose', 'action'],
        truth: { action: true, purpose: 'intended' },
        modality: 'intentional',
        guard: 'pragmatic_to',
      },
      {
        id: 'in_order_to_mid',
        markers: ['in order to'],
        order: 'marker_mid', // "A in order to P"
        boundary: 'none',
        roleOrder: ['action', 'purpose'],
        truth: { action: true, purpose: 'intended' },
        modality: 'intentional',
      },
      {
        id: 'so_that_mid',
        markers: ['so that'],
        order: 'marker_mid', // "A so that P"
        boundary: 'none',
        roleOrder: ['action', 'purpose'],
        truth: { action: true, purpose: 'intended' },
        modality: 'intentional',
      },
      {
        id: 'to_mid',
        markers: ['to'],
        order: 'marker_mid', // "A to P" — guarded: no complement verbs, no datives
        boundary: 'none',
        roleOrder: ['action', 'purpose'],
        truth: { action: true, purpose: 'intended' },
        modality: 'intentional',
        guard: 'to_complement',
        scanOrder: 'last', // purpose infinitive is the LAST "to": "He moved to Madrid to learn Spanish."
      },
    ],
  },
  {
    relation: 'concession',
    roles: ['a', 'b'],
    families: [
      {
        id: 'despite_front',
        markers: ['in spite of', 'despite', 'notwithstanding'],
        order: 'marker_first', // "Despite A, B"
        boundary: 'comma',
        roleOrder: ['a', 'b'],
        truth: { a: true, b: true },
        modality: 'actual',
      },
      {
        id: 'despite_mid',
        markers: ['in spite of', 'despite'],
        order: 'marker_mid', // "B despite A" — surface order swaps the roles
        boundary: 'none',
        roleOrder: ['b', 'a'], // a = the conceded fact (post), b = main clause (pre)
        truth: { a: true, b: true },
        modality: 'actual',
      },
    ],
  },
];

// 'since' is temporal and pragmatic as well as causal.
const TEMPORAL_HEADWORDS = new Set([
  'yesterday', 'today', 'tomorrow', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february',
  'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'last', 'next', 'this', 'morning',
  'afternoon', 'evening', 'night', 'week', 'month', 'year', 'decade',
]);

// Imperative starters: "Since you're here, grab a seat." is pragmatic,
// not propositional cause.
const IMPERATIVE_STARTERS = new Set([
  'grab', 'take', 'come', 'go', 'sit', 'have', 'make', 'let', 'look',
  'listen', 'tell', 'give', 'put', 'keep', 'try', 'enjoy', 'help',
  'ask', 'get', 'do',
]);

// Verbs that take "to"-infinitive complements: "I want to leave" is not
// purpose. Any of these in the action span vetoes to_mid.
const COMPLEMENT_VERBS = new Set([
  'want', 'wants', 'wanted', 'need', 'needs', 'needed', 'like', 'likes',
  'liked', 'love', 'loves', 'loved', 'hate', 'hates', 'hated', 'try',
  'tries', 'tried', 'attempt', 'attempts', 'attempted', 'plan', 'plans',
  'planned', 'intend', 'intends', 'intended', 'hope', 'hopes', 'hoped',
  'wish', 'wishes', 'wished', 'expect', 'expects', 'expected', 'decide',
  'decides', 'decided', 'agree', 'agrees', 'agreed', 'promise', 'promises',
  'promised', 'offer', 'offers', 'offered', 'seem', 'seems', 'seemed',
  'appear', 'appears', 'appeared', 'tend', 'tends', 'tended', 'begin',
  'begins', 'began', 'begun', 'start', 'starts', 'started', 'continue',
  'continues', 'continued', 'learn', 'learns', 'learned', 'forget',
  'forgets', 'forgot', 'forgotten', 'remember', 'remembers', 'remembered',
  'prefer', 'prefers', 'preferred', 'choose', 'chooses', 'chose', 'chosen',
  'used',
]);

// Pragmatic frames: "If you ask me, he's honest." / "To be honest, he's right."
const PRAGMATIC_IF = /^(you ask me|if you ask|truth be told|if i may|if i might|if you don't mind|if you dont mind)\b/i;
const PRAGMATIC_TO = /^(be honest|be fair|be frank|tell the truth|sum up|summarize)\b/i;

const CORRECTION_RELATION_MAP = {
  cause: 'cause',
  concessive: 'contrast',
  contrast: 'contrast',
  condition: 'condition',
};

const TEACHING_PATTERN = /^\s*lari\s*,\s*learn\s+(?:this\s+pattern|this)\s*:\s*(.+?)\s*$/i;

// ---------------------------------------------------------------------------
// Small deterministic utilities
// ---------------------------------------------------------------------------
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Damerau-Levenshtein (optimal string alignment): adjacent transposition
// costs 1, so "becuase" -> "because" is distance 1.
function damerau(a, b) {
  a = String(a);
  b = String(b);
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = [];
  for (let i = 0; i <= m; i++) { d[i] = [i]; for (let j = 1; j <= n; j++) d[i][j] = 0; }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

function cleanSpan(span) {
  return String(span || '')
    .replace(/^[\s,;:"'“”‘’()\-–—]+/, '')
    .replace(/[\s,;:"'“”‘’()\-–—.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validSpan(span) {
  const s = cleanSpan(span);
  if (s.length < 3) return false;
  if (!/[a-z]/i.test(s)) return false;
  if (s.split(/\s+/).length < 2) return false; // no single-token role spans
  return true;
}

function stripSentencePunctuation(text) {
  return String(text || '').trim().replace(/[.!?]+$/, '').trim();
}

function headWord(span) {
  return String(span || '').split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
}

// ---------------------------------------------------------------------------
// Disambiguation guards: named, explicit, testable. Return true = parse stands.
// ---------------------------------------------------------------------------
function guardPass(guard, roles, marker) {
  switch (guard) {
    case 'since_pragmatic': {
      if (!/^since$/i.test(marker || '')) return true;
      const cHead = headWord(roles.cause);
      if (TEMPORAL_HEADWORDS.has(cHead)) return false; // "Since Tuesday, ..."
      if (/^\d{4}$/.test(String(roles.cause || '').split(/\s+/)[0])) return false; // "Since 2019, ..."
      const eHead = headWord(roles.effect);
      if (IMPERATIVE_STARTERS.has(eHead)) return false; // "Since you're here, grab a seat."
      return true;
    }
    case 'while_temporal': {
      const a = String(roles.a || '');
      // Past-progressive while-clause = temporal frame, not concession.
      if (/^(i|he|she|it|we|they|you)\s+(was|were)\s+\w+ing\b/i.test(a)) return false;
      if (TEMPORAL_HEADWORDS.has(headWord(a))) return false;
      return true;
    }
    case 'cf_form': {
      // Past counterfactual: "had" in the antecedent, "would have" in the consequent.
      return /\bhad\b/i.test(String(roles.antecedent || '')) &&
        /\bwould\s+have\b/i.test(String(roles.consequent || ''));
    }
    case 'pragmatic_if': {
      return !PRAGMATIC_IF.test(String(roles.condition || ''));
    }
    case 'pragmatic_to': {
      const p = String(roles.purpose || '');
      if (PRAGMATIC_TO.test(p)) return false;
      // Directional "to": "To the store, we walked." — a purpose infinitive
      // never starts with a determiner, possessive, or pronoun, so any such
      // purpose span is a directional/dative "to", not purpose.
      if (/^(the|a|an|this|that|these|those|my|his|her|their|our|your|its|i|you|he|she|it|we|they|me|him|us|them)\b/i.test(p)) return false;
      return true;
    }
    case 'to_complement': {
      const action = String(roles.action || '');
      const purpose = String(roles.purpose || '');
      const toks = action.toLowerCase().split(/\s+/).map(t => t.replace(/[^a-z]/g, ''));
      if (toks.some(t => COMPLEMENT_VERBS.has(t))) return false; // "I want to leave."
      if (/\btoo\b/i.test(action)) return false; // "too tired to continue"
      // Dative / directional "to": "to the store", "to him", "spoke to the
      // crowd in spite of X" — a purpose infinitive never starts with a
      // determiner, possessive, or pronoun.
      if (/^(the|a|an|this|that|these|those|my|his|her|their|our|your|its|i|you|he|she|it|we|they|me|him|us|them)\b/i.test(purpose)) return false;
      return true;
    }
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Marker matching: exact first, then bounded typo tolerance.
// ---------------------------------------------------------------------------
function matchFrontMarker(source, marker) {
  const exact = new RegExp(`^${escapeRegex(marker)}\\b\\s*(.+)$`, 'i').exec(source);
  if (exact) return { remainder: exact[1], markerText: marker };
  // Typo tolerance: single-word markers of length >= 5, Damerau <= 1.
  if (marker.length < 5 || marker.includes(' ')) return null;
  const m = /^([A-Za-z']+)\s+(.+)$/.exec(source);
  if (!m) return null;
  if (damerau(m[1].toLowerCase(), marker.toLowerCase()) > 1) return null;
  return { remainder: m[2], markerText: marker };
}

function matchMidMarker(source, marker, scanOrder) {
  const last = scanOrder === 'last';
  const exactRe = new RegExp(`(\\s+)(${escapeRegex(marker)})(\\s+)`, 'gi');
  if (!last) {
    const m = new RegExp(`^(.+?)${exactRe.source}(.+)$`, 'i').exec(source);
    if (m && m[1].trim()) {
      return {
        left: m[1], right: m[5], markerText: marker,
        markerIndex: m[1].length + m[2].length,
      };
    }
  } else {
    // Last-occurrence scan: collect every " marker " hit, try from the end.
    const hits = [];
    let m;
    exactRe.lastIndex = 0;
    while ((m = exactRe.exec(source))) {
      if (m.index > 0) hits.push({ left: source.slice(0, m.index), right: source.slice(m.index + m[0].length), markerIndex: m.index + m[1].length });
    }
    for (let i = hits.length - 1; i >= 0; i--) {
      if (hits[i].left.trim() && hits[i].right.trim()) {
        return { left: hits[i].left, right: hits[i].right, markerText: marker, markerIndex: hits[i].markerIndex };
      }
    }
  }
  // Typo tolerance: single-word markers of length >= 5, word scan (never
  // sentence-initial for mid order).
  if (marker.length < 5 || marker.includes(' ')) return null;
  const words = [];
  const re = /[A-Za-z']+/g;
  let m;
  while ((m = re.exec(source))) words.push({ w: m[0], idx: m.index });
  const order = last ? [...Array(words.length).keys()].slice(1).reverse() : [...Array(words.length).keys()].slice(1);
  for (const i of order) {
    if (damerau(words[i].w.toLowerCase(), marker.toLowerCase()) > 1) continue;
    const left = source.slice(0, words[i].idx);
    const right = source.slice(words[i].idx + words[i].w.length);
    if (!left.trim() || !right.trim()) continue;
    return { left, right, markerText: marker, markerIndex: words[i].idx };
  }
  return null;
}

// Missing-comma fallback: accept ONLY when exactly one determiner-anchored
// split yields two valid role spans. Ambiguity -> null (honest refusal).
function uniqueCommaLessSplit(rest) {
  const cands = [];
  const re = /\b(the|a|an|this|that|these|those|he|she|it|they|we|you|i)\b/gi;
  let m;
  while ((m = re.exec(rest))) {
    const left = cleanSpan(rest.slice(0, m.index));
    const right = cleanSpan(rest.slice(m.index));
    if (validSpan(left) && validSpan(right)) {
      cands.push({ left, right });
      if (cands.length > 1) return null;
    }
  }
  return cands.length === 1 ? cands[0] : null;
}

// ---------------------------------------------------------------------------
// Construction parsing: text -> parse object | null.
// Nesting policy: OUTERMOST marker wins (decided in matchOperators by
// markerIndex); inner constructions stay verbatim inside role spans.
// ---------------------------------------------------------------------------
function normalizeRoles(construction, roles, markerText) {
  if (construction.relation === 'cause' && /^because$/i.test(markerText || '') && roles.cause) {
    // "because of the storm" -> cause span "the storm".
    roles.cause = roles.cause.replace(/^of\s+/i, '').trim();
  }
}

function parseWithFamily(text, construction, family) {
  const source = stripSentencePunctuation(text);
  if (!source) return null;
  const markers = [...family.markers].sort((a, b) => b.length - a.length);
  const [leftRole, rightRole] = family.roleOrder || construction.roles;

  if (family.order === 'marker_first') {
    // Must START with the marker: "Because A, B".
    for (const marker of markers) {
      const fm = matchFrontMarker(source, marker);
      if (!fm) continue;
      const rest = fm.remainder;
      let left = null;
      let right = null;
      const commaAt = rest.search(/[,;]/);
      if (commaAt >= 0) {
        left = cleanSpan(rest.slice(0, commaAt));
        right = cleanSpan(rest.slice(commaAt + 1));
      } else {
        const split = uniqueCommaLessSplit(rest);
        if (!split) continue; // boundary required; ambiguous -> try next marker
        left = split.left;
        right = split.right;
      }
      if (!validSpan(left) || !validSpan(right)) continue;
      const roles = { [leftRole]: left, [rightRole]: right };
      normalizeRoles(construction, roles, fm.markerText);
      if (!validSpan(roles[leftRole]) || !validSpan(roles[rightRole])) continue;
      if (family.guard && !guardPass(family.guard, roles, fm.markerText)) continue;
      return {
        relation: construction.relation,
        familyId: family.id,
        marker: fm.markerText.toLowerCase(),
        order: family.order,
        boundary: family.boundary,
        roles,
        truth: { ...family.truth },
        modality: family.modality,
        markerIndex: 0,
        specificity: family.guard ? 1 : 0,
      };
    }
    return null;
  }

  // marker_mid: "B <marker> A" — marker must not be sentence-initial here.
  for (const marker of markers) {
    const mm = matchMidMarker(source, marker, family.scanOrder);
    if (!mm) continue;
    // Cross-talk guard: a "to" that is really the tail of "in order to"
    // belongs to the in_order_to family (defined earlier, wins at teach
    // time); to_mid must not claim it at match time either — refusing is
    // more honest than a misattributed parse.
    if (family.id === 'to_mid' && /\bin order$/i.test(cleanSpan(mm.left))) continue;
    const left = cleanSpan(mm.left);
    const right = cleanSpan(mm.right);
    if (!validSpan(left) || !validSpan(right)) continue;
    const roles = { [leftRole]: left, [rightRole]: right };
    normalizeRoles(construction, roles, mm.markerText);
    if (!validSpan(roles[leftRole]) || !validSpan(roles[rightRole])) continue;
    if (family.guard && !guardPass(family.guard, roles, mm.markerText)) continue;
    return {
      relation: construction.relation,
      familyId: family.id,
      marker: mm.markerText.toLowerCase(),
      order: family.order,
      boundary: family.boundary,
      roles,
      truth: { ...family.truth },
      modality: family.modality,
      markerIndex: mm.markerIndex,
      specificity: family.guard ? 1 : 0,
    };
  }
  return null;
}

function parseConstruction(text, construction) {
  for (const family of construction.families) {
    const parsed = parseWithFamily(text, construction, family);
    if (parsed) return parsed;
  }
  return null;
}

function parseAnyConstruction(text) {
  // Best-parse selection mirrors matchOperators: outermost marker wins;
  // ties go to the narrower (guard-constrained, earlier-defined) construction.
  const cands = [];
  CONSTRUCTIONS.forEach((construction, cIdx) => {
    const parsed = parseConstruction(text, construction);
    if (parsed) cands.push({ parsed, cIdx });
  });
  if (!cands.length) return null;
  cands.sort((a, b) =>
    (a.parsed.markerIndex - b.parsed.markerIndex) ||
    (a.cIdx - b.cIdx) ||
    (b.parsed.specificity - a.parsed.specificity));
  return cands[0].parsed;
}

// ---------------------------------------------------------------------------
// Model state section (hardened)
// ---------------------------------------------------------------------------
function freshStats() {
  return {
    taught: 0, corrections: 0, induced: 0, quarantined: 0,
    understood: { cause: 0, contrast: 0, counterfactual: 0, condition: 0, purpose: 0, concession: 0 },
    recentFires: [],
  };
}

function ensureSection(model) {
  if (!model || typeof model !== 'object') return null;
  if (!model[SECTION] || typeof model[SECTION] !== 'object') {
    model[SECTION] = { schemaVersion: SCHEMA_VERSION, entries: [], pending: {}, quarantined: [], stats: freshStats() };
  }
  const section = model[SECTION];
  // Unknown future schema: degrade to inert no-op, never clobber.
  if (typeof section.schemaVersion === 'number' && section.schemaVersion > SCHEMA_VERSION) {
    section.__unsupportedSchema = true;
    return section;
  }
  if (!Array.isArray(section.entries)) section.entries = [];
  if (!section.pending || typeof section.pending !== 'object') section.pending = {};
  if (!Array.isArray(section.quarantined)) section.quarantined = [];
  if (!section.stats || typeof section.stats !== 'object') section.stats = freshStats();
  if (!section.stats.understood || typeof section.stats.understood !== 'object') {
    section.stats.understood = freshStats().understood;
  }
  return section;
}

function candidateSignature(parsed) {
  return [parsed.relation, parsed.familyId, parsed.order].join('::');
}

function dedupeKey(text) {
  return stripSentencePunctuation(text).toLowerCase().replace(/\s+/g, ' ');
}

function quarantineExample(section, example, reason, signature) {
  if (!section) return;
  if (!Array.isArray(section.quarantined)) section.quarantined = [];
  if (!section.stats || typeof section.stats !== 'object') section.stats = freshStats();
  section.stats.quarantined = (section.stats.quarantined || 0) + 1;
  section.quarantined.push({
    text: String((example && example.text) || '').slice(0, 200),
    marker: (example && example.marker) || null,
    relation: (example && example.relation) || null,
    reason,
    signature: signature || null,
    seq: section.stats.quarantined,
  });
  while (section.quarantined.length > MAX_QUARANTINE) section.quarantined.shift();
}

// ---------------------------------------------------------------------------
// Candidate capture
// ---------------------------------------------------------------------------
function noteCandidate(model, example = {}) {
  const section = ensureSection(model);
  if (!section) return { recorded: false, reason: 'no_model' };
  if (section.__unsupportedSchema) return { recorded: false, reason: 'unsupported_schema_version' };
  const text = String(example.text || '').trim();
  if (text.length < 8) return { recorded: false, reason: 'text_too_short' };
  const parsed = parseAnyConstruction(text);
  if (!parsed) {
    return { recorded: false, reason: 'no_construction_matched', text: text.slice(0, 80) };
  }
  const signature = candidateSignature(parsed);
  const pending = section.pending[signature] || [];
  const key = dedupeKey(text);
  if (pending.some(p => p.key === key)) {
    return { recorded: false, reason: 'duplicate_example', signature, pendingCount: pending.length };
  }
  pending.push({
    key,
    text: stripSentencePunctuation(text),
    marker: parsed.marker,
    relation: parsed.relation,
    familyId: parsed.familyId,
    order: parsed.order,
    source: example.source || 'unknown',
    failedUtterance: example.failedUtterance ? String(example.failedUtterance).slice(0, 200) : null,
  });
  // Sliding window: keep the freshest MAX_EXAMPLES.
  while (pending.length > MAX_EXAMPLES) pending.shift();
  section.pending[signature] = pending;

  const stats = section.stats;
  if (example.source === 'teaching') stats.taught++;
  else if (example.source === 'correction') stats.corrections++;

  // Already have an operator for this signature? Later evidence can still
  // *refine* it, but only with observed markers from the same family —
  // never unobserved ones. Same example sequence -> same final state.
  // Re-teaching never forks a duplicate record.
  const existing = (section.entries || []).find(e => e && e.status === 'active' &&
    e.payload && e.payload.operatorAst && e.payload.operatorAst.signature === signature);
  if (existing) {
    const ast = existing.payload.operatorAst;
    const construction = CONSTRUCTIONS.find(c => c.relation === parsed.relation);
    const family = construction && construction.families.find(f => f.id === parsed.familyId);
    let refined = false;
    if (family && Array.isArray(ast.markers) && family.markers.includes(parsed.marker) && !ast.markers.includes(parsed.marker)) {
      ast.markers = [...ast.markers, parsed.marker].sort();
      existing.normalizedTriggers = ast.markers.slice();
      ast.induction = ast.induction || {};
      ast.induction.refinements = (ast.induction.refinements || 0) + 1;
      ast.induction.exampleTexts = [...(ast.induction.exampleTexts || []), stripSentencePunctuation(text)].slice(-8);
      refined = true;
    }
    return { recorded: true, signature, pendingCount: pending.length, induced: false, refined, reason: 'operator_already_active', recordId: existing.id };
  }

  if (pending.length >= MIN_EXAMPLES) {
    const induced = induceOperator(section, signature, pending);
    return { recorded: true, signature, pendingCount: 0, induced: induced.induced === true, recordId: (induced.record && induced.record.id) || null, reason: induced.reason || null, quarantined: induced.quarantined || 0 };
  }
  return { recorded: true, signature, pendingCount: pending.length, induced: false, reason: 'need_more_examples' };
}

// ---------------------------------------------------------------------------
// Deterministic rule-based induction. Majority coherence: examples are grouped
// by (relation, family, order); the largest coherent group induces; minority
// examples are quarantined with a logged reason, never merged.
// ---------------------------------------------------------------------------
function induceOperator(section, signature, examples) {
  const valid = (examples || []).filter(e => e && e.text && e.relation && e.marker && e.familyId && e.order);
  if (!valid.length) return { induced: false, reason: 'no_valid_examples' };
  const groups = new Map();
  for (const e of valid) {
    const k = [e.relation, e.familyId, e.order].join('::');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const ranked = [...groups.entries()].sort((a, b) => (b[1].length - a[1].length) || (a[0] < b[0] ? -1 : 1));
  const top = ranked[0][1];
  let quarantined = 0;
  for (const entry of ranked.slice(1)) {
    for (const e of entry[1]) { quarantineExample(section, e, 'incoherent_minority', signature); quarantined++; }
  }
  if (top.length < MIN_EXAMPLES) {
    return { induced: false, reason: quarantined ? 'examples_incoherent_no_majority' : 'at_least_two_examples_required', quarantined };
  }
  const first = top[0];
  const construction = CONSTRUCTIONS.find(c => c.relation === first.relation);
  const family = construction && construction.families.find(f => f.id === first.familyId);
  if (!construction || !family) return { induced: false, reason: 'unknown_construction', quarantined };

  // Markers: union of OBSERVED markers only (sorted). Never unobserved family members.
  const markers = [...new Set(top.map(e => String(e.marker).toLowerCase()))].sort();
  const identity = fnv1a(JSON.stringify({ relation: first.relation, family: first.familyId, order: first.order, markers }));
  const id = `lari.learned.operator.semantic.${first.relation}.${identity}`;
  if ((section.entries || []).some(e => e && e.id === id)) {
    return { induced: false, reason: 'operator_already_exists', quarantined, record: section.entries.find(e => e.id === id) };
  }

  const record = {
    id,
    type: 'operator',
    status: 'active',
    confidence: 0.9,
    normalizedTriggers: markers.slice(),
    payload: {
      operation: 'language.semantic_operator',
      operatorAst: {
        kind: 'lari.semantic_operator',
        signature,
        relation: first.relation,
        roles: construction.roles.slice(),
        markers,
        surfaceOrders: [first.order],
        boundary: family.boundary,
        truth: { ...family.truth },
        modality: family.modality,
        induction: {
          exampleCount: top.length,
          sources: [...new Set(top.map(e => e.source))],
          exampleTexts: top.map(e => e.text),
        },
      },
    },
    provenance: {
      creationSource: 'native_semantic_induction',
      sourceKind: 'operator',
      benchmarkAssociation: [],
      confidence: 0.9,
      imported: false,
      classification: 'developmental_candidate',
    },
  };
  section.entries.push(record);
  delete section.pending[signature];
  section.stats.induced++;
  return { induced: true, record, quarantined };
}

// ---------------------------------------------------------------------------
// Canonical understanding: consult learned operators on input text.
// Multi-parse selection: OUTERMOST marker wins (smallest markerIndex);
// ties at the same position go to the narrower (guard-constrained)
// construction, then definition order. Refuses nonmatching surfaces: null.
// ---------------------------------------------------------------------------
function matchOperators(text, model) {
  const section = ensureSection(model);
  if (!section || section.__unsupportedSchema) return null;
  const source = stripSentencePunctuation(text);
  if (!source || source.length < 8) return null;
  const cands = [];
  const entries = Array.isArray(section.entries) ? section.entries : [];
  entries.forEach((entry, entryIdx) => {
    if (!entry || entry.status !== 'active') return;
    if ((entry.confidence || 0) < 0.5) return;
    const ast = entry.payload && entry.payload.operatorAst;
    if (!ast || ast.kind !== 'lari.semantic_operator') return;
    if (!Array.isArray(ast.markers)) return;
    const cIdx = CONSTRUCTIONS.findIndex(c => c.relation === ast.relation);
    if (cIdx < 0) return;
    const construction = CONSTRUCTIONS[cIdx];
    // Only families/orders the operator actually learned.
    const families = construction.families.filter(f =>
      ast.markers.some(m => f.markers.includes(m)) &&
      (ast.surfaceOrders || []).includes(f.order));
    // Deterministic family order = construction definition order.
    families.forEach((family, familyIdx) => {
      const allowedMarkers = family.markers.filter(m => ast.markers.includes(m));
      const parsed = parseWithFamily(source, construction, { ...family, markers: allowedMarkers });
      if (parsed) cands.push({ parsed, entry, entryIdx, familyIdx, cIdx });
    });
  });
  if (!cands.length) return null;
  cands.sort((a, b) =>
    (a.parsed.markerIndex - b.parsed.markerIndex) ||
    (a.cIdx - b.cIdx) ||
    (b.parsed.specificity - a.parsed.specificity) ||
    (a.entryIdx - b.entryIdx) ||
    (a.familyIdx - b.familyIdx));
  const win = cands[0];
  const ast = win.entry.payload.operatorAst;
  return {
    operatorId: win.entry.id,
    relation: ast.relation,
    roles: win.parsed.roles,
    roleNames: ast.roles,
    marker: win.parsed.marker,
    truth: ast.truth,
    modality: ast.modality,
  };
}

// ---------------------------------------------------------------------------
// Per-turn hook: observation only. Never alters the answer.
// ---------------------------------------------------------------------------
function noteTurn(model, turn = {}) {
  const report = { taught: false, induced: false, fired: null, pendingCount: 0 };
  try {
    const userMessage = String(turn.userMessage || '');
    // (b) Explicit teaching: "lari, learn this pattern: <sentence>"
    const teaching = TEACHING_PATTERN.exec(userMessage);
    if (teaching && teaching[1]) {
      const res = noteCandidate(model, { text: teaching[1], source: 'teaching' });
      report.taught = res.recorded === true;
      report.induced = res.induced === true;
      report.pendingCount = res.pendingCount || 0;
      report.recordId = res.recordId || null;
      report.signature = res.signature || null;
    }
    // (a) Correction feed: reuse the discourse-correction detection result.
    const dc = turn.discourseCorrection;
    if (dc && dc.detected && CORRECTION_RELATION_MAP[dc.relationType]) {
      const correctionText = String(turn.correctionText || turn.userMessage || '');
      if (correctionText.length >= 8) {
        const res = noteCandidate(model, {
          text: correctionText,
          source: 'correction',
          failedUtterance: turn.lariAnswer || null,
        });
        if (res.recorded) {
          report.taught = true;
          report.induced = res.induced === true;
          report.pendingCount = res.pendingCount || 0;
          report.recordId = res.recordId || null;
          report.signature = res.signature || null;
        }
      }
    }
    // Understanding: consult learned operators on the user's message.
    const fired = matchOperators(userMessage, model);
    if (fired) {
      report.fired = fired;
      const section = ensureSection(model);
      if (section && !section.__unsupportedSchema) {
        const u = section.stats.understood;
        if (u && Object.prototype.hasOwnProperty.call(u, fired.relation)) u[fired.relation]++;
        section.stats.recentFires.push({
          operatorId: fired.operatorId,
          relation: fired.relation,
          marker: fired.marker,
          text: userMessage.slice(0, 120),
        });
        while (section.stats.recentFires.length > 20) section.stats.recentFires.shift();
      }
    }
  } catch (_) { /* observation must never break the turn */ }
  return report;
}

function operatorCount(model) {
  const section = ensureSection(model);
  if (!section || section.__unsupportedSchema) return 0;
  return (section.entries || []).filter(e => e && e.status === 'active').length;
}

// ---------------------------------------------------------------------------
// Discovered-construction registration (construction-discovery layer).
//
// The discovery module mines candidate construction families from raw
// dialogue and, after truth inference, registers them here so the EXISTING
// induction machinery (noteCandidate -> induceOperator -> matchOperators)
// works unchanged: the family spec enters the candidate space, examples
// parse against it, and the 7-gate protocol qualifies the operator before
// anything persists. Registration alone creates no records and changes no
// matching behavior until an operator is induced.
// ---------------------------------------------------------------------------
function registerDiscoveredConstruction(spec) {
  if (!spec || typeof spec !== 'object') return { registered: false, reason: 'bad_spec' };
  const rel = String(spec.relation || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!rel) return { registered: false, reason: 'bad_relation' };
  if (!Array.isArray(spec.roles) || spec.roles.length < 2) return { registered: false, reason: 'need_two_roles' };
  if (!Array.isArray(spec.families) || !spec.families.length) return { registered: false, reason: 'no_families' };
  if (CONSTRUCTIONS.some(c => c.relation === rel)) return { registered: false, reason: 'relation_exists' };
  const families = [];
  for (const f of spec.families) {
    if (!f || !Array.isArray(f.markers) || !f.markers.length) return { registered: false, reason: 'bad_family_markers' };
    if (f.order !== 'marker_first' && f.order !== 'marker_mid') return { registered: false, reason: 'bad_order' };
    const truth = {};
    for (const r of spec.roles) {
      if (typeof (f.truth || {})[r] !== 'boolean') return { registered: false, reason: 'truth_must_be_boolean' };
      truth[r] = f.truth[r];
    }
    families.push({
      id: String(f.id || `${rel}_${families.length}`),
      markers: [...new Set(f.markers.map(m => String(m).toLowerCase()))].sort(),
      order: f.order,
      boundary: f.boundary === 'comma' || f.boundary === 'semicolon' ? f.boundary : 'none',
      roleOrder: Array.isArray(f.roleOrder) && f.roleOrder.length === spec.roles.length ? f.roleOrder.slice() : spec.roles.slice(),
      truth,
      modality: typeof f.modality === 'string' && f.modality ? f.modality : 'actual',
      discovered: true,
    });
  }
  CONSTRUCTIONS.push({ relation: rel, roles: spec.roles.slice(), families, discovered: true });
  return { registered: true, relation: rel, families: families.length };
}

function listDiscoveredConstructions() {
  return CONSTRUCTIONS.filter(c => c.discovered).map(c => c.relation);
}

function listOperators(model) {
  const section = ensureSection(model);
  if (!section || section.__unsupportedSchema) return [];
  return (section.entries || []).filter(e => e && e.status === 'active').map(e => ({
    id: e.id,
    relation: e.payload && e.payload.operatorAst && e.payload.operatorAst.relation,
    markers: e.payload && e.payload.operatorAst && e.payload.operatorAst.markers,
    roles: e.payload && e.payload.operatorAst && e.payload.operatorAst.roles,
  }));
}

function quarantinedList(model) {
  const section = ensureSection(model);
  if (!section) return [];
  return Array.isArray(section.quarantined) ? section.quarantined.slice() : [];
}

module.exports = {
  SECTION,
  SCHEMA_VERSION,
  MIN_EXAMPLES,
  MAX_EXAMPLES,
  CONSTRUCTIONS,
  TEACHING_PATTERN,
  parseConstruction,
  parseAnyConstruction,
  noteCandidate,
  induceOperator,
  matchOperators,
  noteTurn,
  ensureSection,
  operatorCount,
  listOperators,
  quarantinedList,
  registerDiscoveredConstruction,
  listDiscoveredConstructions,
  parseWithFamily,
  damerau,
};
