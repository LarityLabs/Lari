#!/usr/bin/env node
/**
 * lari_answer_grounding.js — wire Small Lari's UNDERSTANDING into his ANSWERS.
 *
 * The semantic-induction loop (scripts/lari_semantic_induction.js) parses
 * typed relations from user input via matchOperators(), but until now that
 * understanding was observation-only: it never changed what Lari says.
 * This module closes the loop: follow-up questions about a parsed relation
 * are answered FROM the parsed roles.
 *
 * Grounded behaviors:
 *  1. WHY from cause:      "why did the valley flood?" after cause(cause, effect)
 *                           -> "Because the dam cracked."
 *  2. Follow-up reference: "what caused it?" -> resolves "it" to the effect
 *                           role, answers with the cause role.
 *  3. Contrast check:       "although it rained, we stayed" then
 *                           "so the rain didn't stop you?"
 *                           -> "Right — although it rained, we stayed."
 *  4. Conditional query:    "if the server overheats, the site goes down" then
 *                           "what happens if the server overheats?"
 *                           -> "The site goes down."
 *  5. Paraphrase verify:    "so you're saying X because Y?" -> confirm if the
 *                           parsed roles match a remembered relation, CORRECT
 *                           the user if they mismatch. Honesty showcase.
 *  6. Multi-turn memory:    relations parsed within the last HISTORY_WINDOW
 *                           turns stay answerable; older ones are forgotten
 *                           honestly ("I don't remember us covering that").
 *
 * HONESTY RULES (hard, enforced in code):
 *  - Grounding ONLY uses fires from QUALIFIED persisted operators
 *    (model.learned_semantic_operators via matchOperators, which consults
 *    only active entries with confidence >= 0.5). Never regex-guesses a
 *    relation for answering.
 *  - If no operator fired, or the question matches no remembered relation,
 *    return null: the existing answer stands unchanged.
 *  - Never invents role content: answers are templates filled ONLY with
 *    verbatim parsed role spans.
 *  - Pronoun resolution only within parsed roles + immediate turn context.
 *  - Deterministic: same turns twice -> byte-identical answers.
 *  - Zero external model calls. Never throws (all failures -> null).
 *
 * State: model.learned_semantic_operators.groundingHistory (array, capped at
 * HISTORY_WINDOW=10) and .groundingSeq (monotonic counter). Distinct keys from
 * the induction loop's own bookkeeping; the observation hook is untouched.
 */
'use strict';

const path = require('path');

let semMod = null;
function getSem() {
  if (!semMod) semMod = require(path.join(__dirname, 'lari_semantic_induction.js'));
  return semMod;
}

const HISTORY_WINDOW = 10;
const HISTORY_KEY = 'groundingHistory';
const SEQ_KEY = 'groundingSeq';
const FORGOTTEN = "I don't remember us covering that.";

const TEACHING_RE = /learn this pattern/i;

// ---------------------------------------------------------------- text utils
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(w) {
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'as', 'at', 'by',
  'for', 'from', 'in', 'into', 'of', 'on', 'to', 'with', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their', 'do', 'does', 'did', 'doing', 'done',
  'has', 'have', 'had', 'having', 'will', 'would', 'can', 'could', 'shall',
  'should', 'may', 'might', 'must', 'not', 'no', 'yes', 'what', 'why', 'how',
  'when', 'where', 'which', 'who', 'whom', 'there', 'here', 'about',
  'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'werent', 'wont',
  'cant', 'couldnt', 'shouldnt', 'wouldnt', 'hasnt', 'havent', 'hadnt',
  'cannot',
]);

function contentWords(s) {
  const out = new Set();
  for (const tok of norm(s).split(' ')) {
    if (!tok || STOPWORDS.has(tok)) continue;
    out.add(stem(tok));
  }
  return out;
}

// True when the question's content substantially overlaps the role span.
// Both directions guarded: needs a real intersection, not one stray word.
function roleMatches(query, roleText) {
  const q = contentWords(query);
  const r = contentWords(roleText);
  if (!q.size || !r.size) return false;
  let inter = 0;
  for (const w of q) if (r.has(w)) inter++;
  return inter > 0 && inter >= Math.ceil(Math.min(q.size, r.size) * 0.5);
}

function cleanSpan(s) {
  return String(s || '').trim().replace(/[.?!,;:]+$/g, '').trim();
}

// Lowercase the first letter for spans restated mid-sentence
// ("The engine is small" -> "the engine is small"). Applied only where the
// template places the span after other words.
function midSentence(s) {
  const c = cleanSpan(s);
  return c ? c.charAt(0).toLowerCase() + c.slice(1) : c;
}

function sentenceCase(s) {
  const c = cleanSpan(s);
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : c;
}

// Strip question-frame prefixes ("so you're saying", "so", ...) from a role
// span parsed out of a paraphrase question, so it compares cleanly.
function stripFrame(s) {
  return String(s || '')
    .replace(/^\s*(so\s+)?(you're|you\s+are)\s+saying\s+(that\s+)?/i, '')
    .replace(/^\s*so\s+/i, '')
    .trim();
}

function rolesEqual(a, b) {
  return norm(stripFrame(a)) === norm(stripFrame(b)) && norm(stripFrame(a)).length > 0;
}

// ------------------------------------------------------------------- history
function getHistory(model) {
  const sem = getSem();
  const section = sem.ensureSection(model);
  if (!section || section.__unsupportedSchema) return null;
  if (!Array.isArray(section[HISTORY_KEY])) section[HISTORY_KEY] = [];
  if (typeof section[SEQ_KEY] !== 'number') section[SEQ_KEY] = 0;
  return section[HISTORY_KEY];
}

function recordFire(model, history, text, fired) {
  const section = getSem().ensureSection(model);
  section[SEQ_KEY] = (section[SEQ_KEY] || 0) + 1;
  history.push({
    seq: section[SEQ_KEY],
    text: String(text).slice(0, 200),
    operatorId: fired.operatorId,
    relation: fired.relation,
    roles: Object.assign({}, fired.roles),
    roleNames: Array.isArray(fired.roleNames) ? fired.roleNames.slice() : [],
    marker: fired.marker || null,
  });
  while (history.length > HISTORY_WINDOW) history.shift();
  return section[SEQ_KEY];
}

function recentByRelation(history, relations, excludeSeq) {
  const set = new Set(relations);
  const out = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.seq === excludeSeq) continue;
    if (set.has(h.relation)) out.push(h);
  }
  return out;
}

// ------------------------------------------------------------ classification
function classify(msg) {
  const t = String(msg || '');
  if (!t.trim() || TEACHING_RE.test(t)) return null;
  if (/\bwhat caused (it|this|that)\b/i.test(t)) return 'what_caused';
  if (/\bwhat happens if\b/i.test(t)) return 'conditional_q';
  if (/^\s*why\b/i.test(t)) return 'why';
  if (/^\s*so\b/i.test(t) && /\?\s*$/.test(t) && /\bdidn'?t\b/i.test(t)) return 'contrast_confirm';
  if (/^\s*so\b/i.test(t) && /\?\s*$/.test(t)) return 'paraphrase';
  return null;
}

function whyQuery(msg) {
  return String(msg)
    .replace(/^\s*why\s+/i, '')
    .replace(/^(did|does|do|is|are|was|were|will|would|can|could|should|has|have|had)\s+/i, '')
    .replace(/\?\s*$/g, '')
    .trim();
}

function conditionalQuery(msg) {
  const m = /\bwhat happens if\b/i.exec(String(msg));
  if (!m) return '';
  return String(msg).slice(m.index + m[0].length).replace(/\?\s*$/g, '').trim();
}

function contrastQuery(msg) {
  return String(msg)
    .replace(/^\s*so\s+/i, '')
    .replace(/\bdid\s+not\b/i, '')
    .replace(/\bdidn'?t\b/i, '')
    .replace(/\?\s*$/g, '')
    .trim();
}

// ----------------------------------------------------------------- behaviors
function answerWhy(history, msg) {
  const query = whyQuery(msg);
  const cands = recentByRelation(history, ['cause']).filter(h => roleMatches(query, h.roles.effect));
  if (cands.length === 1) {
    return { answer: 'Because ' + cleanSpan(cands[0].roles.cause) + '.', relation: 'cause', operatorId: cands[0].operatorId };
  }
  if (cands.length > 1) {
    const opts = cands.slice(0, 2).map(h => cleanSpan(h.roles.effect)).join(', or ');
    return { answer: 'I want to get this right — did you mean ' + opts + '?', relation: 'cause', operatorId: null, ambiguous: true };
  }
  return null;
}

function answerWhatCaused(history) {
  const cands = recentByRelation(history, ['cause']);
  if (!cands.length) return null;
  return { answer: sentenceCase(cands[0].roles.cause) + '.', relation: 'cause', operatorId: cands[0].operatorId };
}

const DESPITE_MARKERS = new Set(['despite', 'in spite of', 'notwithstanding']);
const FRONT_CLAUSE_MARKERS = new Set(['although', 'though', 'even though', 'while']);

function answerContrastConfirm(history, msg) {
  const query = contrastQuery(msg);
  const cands = recentByRelation(history, ['contrast', 'concession'])
    .filter(h => roleMatches(query, h.roles.a));
  if (!cands.length) return null;
  const h = cands[0];
  const a = cleanSpan(h.roles.a);
  const b = cleanSpan(h.roles.b);
  const marker = String(h.marker || '').toLowerCase();
  let answer;
  if (DESPITE_MARKERS.has(marker)) {
    answer = 'Right — ' + marker + ' ' + a + ', ' + midSentence(b) + '.';
  } else if (FRONT_CLAUSE_MARKERS.has(marker)) {
    answer = 'Right — ' + marker + ' ' + a + ', ' + b + '.';
  } else {
    // mid-order: "A but B" / "A yet B"
    answer = 'Right — ' + midSentence(a) + ', ' + marker + ' ' + b + '.';
  }
  return { answer, relation: h.relation, operatorId: h.operatorId };
}

function answerConditionalQ(history, msg) {
  const query = conditionalQuery(msg);
  const cands = recentByRelation(history, ['condition', 'counterfactual']).filter(h => {
    const condRole = h.relation === 'counterfactual' ? h.roles.antecedent : h.roles.condition;
    return roleMatches(query, condRole);
  });
  if (!cands.length) return null;
  const h = cands[0];
  const outRole = h.relation === 'counterfactual' ? h.roles.consequent : h.roles.outcome;
  return { answer: sentenceCase(outRole) + '.', relation: h.relation, operatorId: h.operatorId };
}

function restate(entry) {
  const r = entry.roles;
  switch (entry.relation) {
    case 'cause':
      return 'because ' + cleanSpan(r.cause) + ', ' + cleanSpan(r.effect) + '.';
    case 'condition':
      return 'if ' + cleanSpan(r.condition) + ', ' + cleanSpan(r.outcome) + '.';
    case 'counterfactual':
      return 'if ' + cleanSpan(r.antecedent) + ', ' + cleanSpan(r.consequent) + '.';
    case 'contrast':
      return 'although ' + cleanSpan(r.a) + ', ' + cleanSpan(r.b) + '.';
    case 'concession':
      return midSentence(r.b) + ', even though ' + cleanSpan(r.a) + '.';
    case 'purpose':
      return midSentence(r.action) + ' so that ' + cleanSpan(r.purpose) + '.';
    default:
      return null;
  }
}

function answerParaphrase(fired, history, currentSeq) {
  const prior = recentByRelation(history, [fired.relation], currentSeq);
  if (!prior.length) return null; // nothing to verify against: fall back
  const h = prior[0];
  const names = fired.roleNames && fired.roleNames.length ? fired.roleNames : Object.keys(fired.roles || {});
  const allMatch = names.every(rn => rolesEqual(fired.roles[rn], h.roles[rn]));
  if (allMatch) {
    return { answer: "Yes, that's right.", relation: h.relation, operatorId: h.operatorId, verified: true };
  }
  const rs = restate(h);
  return {
    answer: rs ? 'Not quite — the way I have it: ' + rs : "Not quite — that doesn't match what I have.",
    relation: h.relation, operatorId: h.operatorId, verified: false,
  };
}

// ------------------------------------------------------------------ entry
// Returns null when nothing grounds (existing answer stands), else
// { grounded:true, behavior, answer, relation, operatorId, historySize }.
function groundAnswer(model, userMessage, response) {
  try {
    const msg = String(userMessage || '');
    if (!msg.trim() || !model || typeof model !== 'object') return null;
    if (response && response.action === 'request_clarification') return null;
    const sem = getSem();
    const history = getHistory(model);
    if (!history) return null;

    // 1. Record this turn's fire (unless it's a teaching turn).
    let fired = null;
    let currentSeq = null;
    if (!TEACHING_RE.test(msg)) {
      fired = sem.matchOperators(msg, model);
      if (fired && fired.roles) currentSeq = recordFire(model, history, msg, fired);
    }

    // 2. Classify and ground.
    const kind = classify(msg);
    if (!kind) return null;
    let res = null;
    if (kind === 'why') res = answerWhy(history, msg);
    else if (kind === 'what_caused') res = answerWhatCaused(history);
    else if (kind === 'contrast_confirm') res = answerContrastConfirm(history, msg);
    else if (kind === 'conditional_q') res = answerConditionalQ(history, msg);
    else if (kind === 'paraphrase') res = fired ? answerParaphrase(fired, history, currentSeq) : null;
    if (!res || !res.answer) {
      // A relation-seeking question with remembered relations but no match:
      // forget honestly. With no history at all, fall back (return null).
      if (history.length > 0 && (kind === 'why' || kind === 'what_caused' || kind === 'contrast_confirm' || kind === 'conditional_q')) {
        return { grounded: true, behavior: kind, answer: FORGOTTEN, relation: null, operatorId: null, historySize: history.length, forgotten: true };
      }
      return null;
    }
    return {
      grounded: true,
      behavior: kind,
      answer: res.answer,
      relation: res.relation || null,
      operatorId: res.operatorId || null,
      historySize: history.length,
      ambiguous: !!res.ambiguous,
      verified: res.verified,
    };
  } catch (_) {
    return null; // grounding must never break a turn
  }
}

function historySize(model) {
  const h = getHistory(model);
  return h ? h.length : 0;
}

function clearHistory(model) {
  const sem = getSem();
  const section = sem.ensureSection(model);
  if (section && !section.__unsupportedSchema) {
    section[HISTORY_KEY] = [];
    section[SEQ_KEY] = 0;
  }
}

module.exports = {
  HISTORY_WINDOW,
  FORGOTTEN,
  groundAnswer,
  historySize,
  clearHistory,
  // exported for tests
  _norm: norm,
  _roleMatches: roleMatches,
  _classify: classify,
};
