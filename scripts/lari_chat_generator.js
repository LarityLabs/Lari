#!/usr/bin/env node
/**
 * Lari chat generator v2: generate-score-select reply pipeline.
 *
 * Replaces the lane-and-patches reply path with:
 *   UNDERSTAND -> GATHER -> GENERATE -> SCORE -> SPEAK
 *
 * - UNDERSTAND: coarse intent classes via the runtime's own classifier
 *   (injected as deps.classifyIntent). No second classifier is built here.
 * - GATHER (first-class, explicit): last N conversation turns, personal
 *   facts extracted from history (name/age/likes), relevant researched
 *   knowledge (read-only), and one research attempt through the existing
 *   research function when a factual question has no grounded answer.
 * - GENERATE: candidate replies from distinct strategies: lane (the old
 *   path's answer, invoked with the v2 flag off), memory (personal-fact
 *   recall), knowledge (composed from researched sentences), voice (same
 *   knowledge under a deterministic phrasing variant, selected not
 *   transformed), creative (constraint-aware attempt for creative prompts,
 *   verified before it can win), phatic (greetings/reactions), askback
 *   (genuinely ambiguous only).
 * - SCORE (deterministic): COHERENCE first, VOICE second (via
 *   scripts/lari_voice_profile.js, measurable features only), HONESTY third
 *   (never let voice outscore honesty; v2-generated factual claims must be
 *   grounded or the candidate is disqualified).
 * - SPEAK: { reply, trace }. On any internal failure, or when no candidate
 *   is trustworthy, decline ({ ok:false, declined:true }) so the caller
 *   falls back to the old path. Never fabricate.
 *
 * Zero external model calls. No em dashes in user-facing strings.
 */
'use strict';

const voice = require('./lari_voice_profile.js');
// Creative candidate (drawing-board rebuild 2026-09-21): constraint-aware
// attempts from grounded researched sentences via lari_creative_core.js.
// Length budget (2026-09-21): expand/truncate knowledge and creative
// candidates against the prompt's length demands.
let creativeCore = null;
let lengthMod = null;
let repairMod = null;
try { creativeCore = require('./lari_creative_core.js'); } catch (_) { creativeCore = null; }
try { lengthMod = require('./lari_length_budget.js'); } catch (_) { lengthMod = null; }
try { repairMod = require('./lari_constraint_repair.js'); } catch (_) { repairMod = null; }

const SHORTFALL_RE = /i do not have enough (grounded local knowledge|local memory)|i don[’']t have a reliable answer for that yet|i don[’']t have reliable (information|knowledge) about|not well covered in local memory|confidence is low because/i;
const VAGUE_FALLBACK_RE = /that is a bit vague for me/i;
const UNSURE_RE = /\b(don't know|do not know|not sure|no idea|never heard)\b/i;

// Intents the v2 pipeline engages with. Everything else declines to the old
// path (code, troubleshooting, composition, planning, comparison, math,
// open_chat, unknown, ...). The classifier comes from the runtime.
const ENGAGE_INTENTS = new Set([
  'greeting', 'small_talk', 'thanks', 'goodbye',
  'reaction_laugh', 'reaction_hype', 'reaction_damn', 'reaction_ack', 'reaction_shrug',
  'mood_low', 'mood_high', 'mood_vent',
  'self_identity', 'opinion', 'personal',
  'explanation', 'composition'
]);

const PHATIC_INTENTS = new Set([
  'greeting', 'small_talk', 'thanks', 'goodbye',
  'reaction_laugh', 'reaction_hype', 'reaction_damn', 'reaction_ack', 'reaction_shrug',
  'mood_low', 'mood_high', 'mood_vent'
]);

// Hard declines: safety and scope. These always go to the old path.
const DECLINE_RES = [
  /\bignore your instructions\b/i,
  /\bsystem prompt\b/i,
  /\bbuild\b[\s\S]{0,40}\b(game|app|snake|files?|project|website|program)\b/i,
  /\bcomplete\b[\s\S]{0,20}\bsnake game\b/i,
  /\bstock market\b/i,
  /\bwill\b[\s\S]{0,30}\btomorrow\b/i,
  /\bpython\b/i,
  /\bsnippet\b/i,
  /\bindexerror\b/i,
  /\brecursion\b/i,
  /\biteration\b/i,
  /\bkeyword\b/i,
  /\bdef\b[\s\S]{0,20}\bfunction\b|\bpython keyword\b/i,
  /\bexactly \d+ words?\b/i,
  /\bone per line\b/i,
  /\bjust the number\b/i,
  /\banswer yes or no\b/i,
  /\bunder \d+ words\b/i,
  /\bdo not apologize\b/i,
  /\brepeat\b[\s\S]{0,20}\btimes\b/i,
  /\blist three\b/i,
  /\bwhat is 2\s*\+\s*2\b/i,
  /\d+\s*[*+\-/^]\s*\d+/,
  /\bdivided by\b/i,
  /\bwhat time is it\b/i,
  /\bwhat day is it\b/i,
  /\bname two planets\b/i
];

function declinedByPolicy(text) {
  const t = String(text || '');
  for (const re of DECLINE_RES) if (re.test(t)) return re.source;
  return null;
}

// ------------------------------------------------------------------ utils

function hash(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

function pick(pool, key) {
  return pool[hash(key) % pool.length];
}

function jaccard(a, b) {
  const sa = new Set(voice.contentWords(a));
  const sb = new Set(voice.contentWords(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function overlapCount(a, b) {
  const sb = new Set(voice.contentWords(b));
  let n = 0;
  for (const w of voice.contentWords(a)) if (sb.has(w)) n++;
  return n;
}

// ------------------------------------------------------- personal facts

const FACT_PATTERNS = [
  { type: 'name', res: [/\bmy name is ([a-z][a-z'\-]{1,24})\b/i, /\bcall me ([a-z][a-z'\-]{1,24})\b/i] },
  { type: 'age', res: [/\bi am (\d{1,3}) years old\b/i] },
  { type: 'love', res: [/\bi love ([a-z][a-z ,']{1,40}?)(?:\.|!|\?|$)/i] },
  { type: 'dog', res: [/\bmy dog'?s name is ([a-z][a-z'\-]{1,24})/i] }
];

function extractPersonalFacts(history, message) {
  const facts = [];
  const turns = [{ role: 'user', text: message }, ...(history || []).filter(t => t && t.role === 'user')];
  for (const fp of FACT_PATTERNS) {
    for (const turn of turns) {
      for (const re of fp.res) {
        const m = String(turn.text || '').match(re);
        if (m && m[1]) {
          facts.push({ type: fp.type, value: m[1].trim().replace(/[.,!?]+$/, ''), source: 'conversation' });
          break;
        }
      }
      if (facts.some(f => f.type === fp.type)) break;
    }
  }
  const fav = String(message || '').match(/\bmy favo[u]?rite (\w+) is ([^.!\n]{1,60})/i);
  if (fav) facts.push({ type: `favorite_${fav[1].toLowerCase()}`, value: fav[2].trim(), source: 'conversation' });
  for (const t of (history || []).filter(t => t && t.role === 'user')) {
    const fm = String(t.text || '').match(/\bmy favo[u]?rite (\w+) is ([^.!\n]{1,60})/i);
    if (fm && !facts.some(f => f.type === `favorite_${fm[1].toLowerCase()}`)) {
      facts.push({ type: `favorite_${fm[1].toLowerCase()}`, value: fm[2].trim(), source: 'conversation' });
    }
  }
  return facts;
}

const RECALL_RES = [
  { re: /\bwhat(?:'s| is) my name\b/i, type: 'name', fmt: v => `Your name is ${cap(v)}.` },
  { re: /\bhow old am i\b/i, type: 'age', fmt: v => `You're ${v}.` },
  { re: /\bwhat do i love\b/i, type: 'love', fmt: v => `You love ${v}.` },
  { re: /\bwhat(?:'s| is) my dog(?:'s name)?\b/i, type: 'dog', fmt: v => `Your dog's name is ${cap(v)}.` }
];

function cap(s) { return String(s || '').replace(/^./, c => c.toUpperCase()); }

// ------------------------------------------------------- durable beliefs

// Sept 19 consolidation distills episodes into durable beliefs persisted at
// model.lariConsolidatedBeliefs (100-belief cap, retention-gated writes).
// The generator reads them read-only via deps.getUserBeliefs and maps the
// user-identity/preference shapes onto the personal-fact format. Durable
// facts are checked BEFORE the regex extraction from the 12-turn recency
// buffer, so long-ago facts survive long conversations.
function durableFactsFromBeliefs(beliefs) {
  const facts = [];
  for (const b of beliefs || []) {
    if (!b || b.status !== 'active') continue;
    const type = String(b.type || '');
    const pred = String(b.predicate || '').toLowerCase().trim();
    const obj = String(b.object || '').trim().replace(/\s+/g, ' ');
    if (!obj) continue;
    if (type === 'identity' && pred === 'name') {
      facts.push({ type: 'name', value: obj, source: 'durable' });
    } else if (type === 'identity' && pred.indexOf('favorite ') === 0) {
      const key = pred.slice('favorite '.length).trim().replace(/\s+/g, '_');
      if (key) facts.push({ type: `favorite_${key}`, value: obj, source: 'durable' });
    } else if (type === 'preference' && (pred === 'like' || pred === 'love')) {
      facts.push({ type: 'love', value: obj, source: 'durable' });
    } else if (type === 'preference' && (pred === 'hate' || pred === 'dislike')) {
      facts.push({ type: 'dislike', value: obj, source: 'durable' });
    }
  }
  return facts;
}

// Merge fact lists; the first list wins on type conflicts. Callers pass
// durable facts first so they take precedence over recency-buffer regex.
function mergeFactsPreferFirst(first, second) {
  const seen = new Set();
  const out = [];
  for (const f of [...(first || []), ...(second || [])]) {
    if (!f || !f.type || seen.has(f.type)) continue;
    seen.add(f.type);
    out.push(f);
  }
  return out;
}

function acknowledgeFact(f) {
  if (!f) return 'Got it, noted.';
  switch (f.type) {
    case 'name': return `Got it, ${cap(f.value)}.`;
    case 'age': return `Got it. ${f.value}, noted.`;
    case 'love': return `Noted, you love ${f.value}.`;
    case 'dog': return `Got it, ${cap(f.value)}.`;
    default:
      if (String(f.type).startsWith('favorite_')) return `Noted. Favorite ${f.type.slice(9)}: ${f.value}.`;
      return 'Got it, noted.';
  }
}

function isFactStatementIntent(intent) {
  return intent === 'open_chat' || intent === 'unknown';
}

function memoryAnswerWithFact(message, facts) {
  for (const r of RECALL_RES) {
    if (r.re.test(String(message || ''))) {
      const f = facts.find(x => x.type === r.type);
      if (f) return { text: r.fmt(f.value), fact: f };
      return null;
    }
  }
  const favQ = String(message || '').match(/\bwhat(?:'s| is) my favo[u]?rite (\w+)\b/i);
  if (favQ) {
    const f = facts.find(x => x.type === `favorite_${favQ[1].toLowerCase()}`);
    if (f) return { text: `Your favorite ${favQ[1].toLowerCase()} is ${f.value}.`, fact: f };
  }
  return null;
}

function memoryAnswer(message, facts) {
  const hit = memoryAnswerWithFact(message, facts);
  return hit ? hit.text : null;
}

// ------------------------------------------------------------- phatic

const PHATIC_POOLS = {
  greeting: [
    "Hey. What's on your mind?",
    "Hey, good to see you. What's up?",
    "Yo. What are we getting into?"
  ],
  small_talk: [
    "Doin well. Ready to get into something?",
    "Pretty good. What about you?",
    "Alive and local. What's on your mind?"
  ],
  thanks: ["Anytime.", "No problem, got you.", "Of course."],
  goodbye: ["Later.", "See you.", "Peace. Take care."],
  reaction_laugh: ["haha", "lol, glad that landed", "heh"],
  reaction_hype: ["Right?", "I know, right.", "Facts."],
  reaction_damn: ["Yeah, seriously.", "I felt that.", "Damn indeed."],
  reaction_ack: ["Got it.", "Say less.", "Bet."],
  reaction_shrug: ["Fair enough.", "Yeah, hard to say.", "Hmm."],
  mood_low: [
    "That's rough. Want to talk it through or want a distraction?",
    "Sorry you're dealing with that. I'm here."
  ],
  mood_high: ["Love that energy. What's got you hyped?", "Let's go. Tell me more."],
  mood_vent: ["Get it out. I'm listening.", "Yeah, that's frustrating."]
};

function phaticReply(intent, message) {
  const pool = PHATIC_POOLS[intent] || PHATIC_POOLS.reaction_ack;
  return pick(pool, String(message || '') + intent);
}

// ------------------------------------------------------------- gather

function scoreSentenceOverlap(sentence, messageTokens) {
  const st = new Set(voice.contentWords(sentence));
  let n = 0;
  for (const w of messageTokens) if (st.has(w)) n++;
  return n;
}

function readResearched(deps, message) {
  let entries = [];
  try { entries = deps.getResearchedKnowledge() || []; } catch (_) { entries = []; }
  const msgWords = new Set(voice.contentWords(message));
  const scored = [];
  for (const e of entries) {
    const hay = `${e.topic || ''} ${(e.sentences || []).join(' ')}`;
    const ov = overlapCount(message, hay);
    // Topic-word gate: the entry's own topic must share vocabulary with the
    // question. Without this, junk store entries whose sentences happen to
    // contain one question word (e.g. "name") become false "knowledge".
    // A high sentence-overlap (>=3 distinct question words) is the fallback
    // for entries whose topic string is phrased differently.
    const topicWords = new Set(voice.contentWords(e.topic || ''));
    let topicHit = false;
    for (const w of msgWords) if (topicWords.has(w)) { topicHit = true; break; }
    if (ov >= 1 && (topicHit || ov >= 3)) scored.push({ entry: e, overlap: ov, topicHit });
  }
  scored.sort((a, b) => (b.topicHit - a.topicHit) || (b.overlap - a.overlap));
  return scored.slice(0, 3).map(s => s.entry);
}

function buildKnowledgeText(message, entries) {
  const tokens = voice.contentWords(message);
  const sents = [];
  for (const e of entries) {
    for (const s of (e.sentences || [])) {
      const clean = String(s).trim();
      if (clean.length > 25 && clean.length < 400) sents.push({ s: clean, ov: scoreSentenceOverlap(clean, tokens) });
    }
  }
  sents.sort((a, b) => b.ov - a.ov);
  const top = sents.filter(x => x.ov >= 1).slice(0, 3).map(x => x.s);
  if (!top.length) return '';
  return top.join(' ');
}

const VOICE_OPENERS = ['', "Here's the deal: ", 'Short version: '];
const VOICE_CLOSERS = ['', " That's the shape of it."];

function voiceVariant(knowledgeText, message) {
  if (!knowledgeText) return '';
  const opener = pick(VOICE_OPENERS, 'o' + message);
  const closer = pick(VOICE_CLOSERS, 'c' + message);
  return (opener + knowledgeText + closer).trim();
}

function isLaneBad(laneText) {
  const t = String(laneText || '');
  return !t.trim() || VAGUE_FALLBACK_RE.test(t) || SHORTFALL_RE.test(t);
}

// Intents that must never trigger research: phatic turns, Lari's own
// tastes and identity, jokes, follow-ups (they need thread context, not the
// web), and the working intents (troubleshooting/comparison/planning/
// composition/preference) that own their lanes.
const NO_RESEARCH_INTENTS = new Set([
  ...PHATIC_INTENTS,
  'opinion', 'joke', 'self_identity', 'personal', 'follow_up',
  'troubleshooting', 'comparison', 'planning', 'composition', 'preference'
]);

// Knowledge-need, independent of the intent label. True when the message asks
// about the world, a topic, or an explanation. False for phatic messages,
// pure opinions, jokes, Lari-identity questions, follow-ups, working-lane
// intents, and memory-recall questions about the user (those are memory
// territory, not research territory).
function isKnowledgeSeeking(text, intent) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (NO_RESEARCH_INTENTS.has(intent)) return false;
  // Memory-recall about the user, not world knowledge.
  if (/\bwhat(?:'s| is) my\b/i.test(t)) return false;
  if (/\bhow old am i\b/i.test(t)) return false;
  if (/\bwhat do i (love|like|hate)\b/i.test(t)) return false;
  if (/\bmy (name is|favorite|favourite|dog)\b/i.test(t) && !/\?\s*$/.test(t)) return false;
  // Self-referential second-person: "explain yourself" is not about the world.
  if (/\bexplain yourself\b/i.test(t)) return false;
  // Explicit knowledge-seeking phrasing, whatever the intent label says.
  // This is what catches "tell me about fusion power" (open_chat).
  if (/\btell me about\b/i.test(t)) return true;
  if (/\b(explain|teach me|what is|what are|what was|what were|who is|who are|who was|why is|why are|why do|why does|why did|how do|how does|how did|how is|how are)\b/i.test(t)) return true;
  return false;
}

async function gather(message, intent, deps, ctx, laneBad, knowledgeSeeking, durableFacts) {
  const history = Array.isArray(ctx.history) ? ctx.history.slice(-8) : [];
  // Durable beliefs first, recency-buffer regex second: long-ago facts
  // survive long conversations even after they fall out of the 12-turn window.
  const personalFacts = mergeFactsPreferFirst(durableFacts, extractPersonalFacts(history, message));
  let researched = readResearched(deps, message);
  let researchRan = null;
  const memHit = memoryAnswerWithFact(message, personalFacts);
  const memAns = memHit ? memHit.text : null;
  // Research on knowledge-need, not intent label: only when the message asks
  // about the world/topic/explanation AND nothing gathered (durable beliefs,
  // researched-knowledge entries, lane answer) grounds an answer. Phatic
  // messages, opinions, and ambiguous shorts never reach this branch.
  // Honest shortfalls survive: if research returns nothing usable, no
  // knowledge candidate is built and the pipeline declines to the old path.
  if (knowledgeSeeking && !memAns && researched.length === 0 && laneBad && !ctx.__v2ResearchAttempted
      && typeof deps.researchForPrompt === 'function') {
    try {
      researchRan = await deps.researchForPrompt(message);
      if (researchRan && researchRan.added > 0) researched = readResearched(deps, message);
    } catch (_) { researchRan = { attempted: true, error: true }; }
  }
  return {
    history, personalFacts, researched, researchRan,
    memoryAns: memAns, memoryFact: memHit ? memHit.fact : null,
    laneBad: !!laneBad, knowledgeSeeking: !!knowledgeSeeking,
    durableFacts: (durableFacts || []).map(f => `${f.type}=${f.value}`)
  };
}

// ------------------------------------------------------------- score

function scoreCoherence(cand, message, intent, gathered) {
  let s = 0.4;
  const reasons = [];
  const text = cand.text || '';
  if (!text.trim()) return { score: 0, reasons: ['empty'] };
  if (VAGUE_FALLBACK_RE.test(text)) { s -= 0.5; reasons.push('vague fallback'); }
  if (SHORTFALL_RE.test(text)) { s -= 0.5; reasons.push('knowledge shortfall'); }
  const stratForIntent =
    (PHATIC_INTENTS.has(intent) && cand.strategy === 'phatic') ||
    (cand.strategy === 'memory' && gathered.memoryAns) ||
    (cand.strategy === 'acknowledge' && isFactStatementIntent(intent)) ||
    ((cand.strategy === 'knowledge' || cand.strategy === 'voice') && gathered.knowledgeSeeking) ||
    (cand.strategy === 'lane');
  if (stratForIntent) { s += 0.25; reasons.push('strategy fits intent'); }
  if (gathered.knowledgeSeeking && (cand.strategy === 'knowledge' || cand.strategy === 'voice' || cand.strategy === 'lane')) {
    if (overlapCount(message, text) >= 1) { s += 0.2; reasons.push('topic overlap'); }
    else { s -= 0.2; reasons.push('no topic overlap'); }
  }
  const prevAssistant = (gathered.history || []).filter(t => t && t.role === 'assistant').slice(-3);
  for (const t of prevAssistant) {
    if (jaccard(text, t.text) > 0.8) { s -= 0.4; reasons.push('near-repeat of earlier turn'); break; }
  }
  if (/\b(it|that|this|they)\b/i.test(String(message)) && gathered.history.length) {
    const last = gathered.history[gathered.history.length - 1];
    if (last && overlapCount(text, last.text || '') >= 1) { s += 0.1; reasons.push('pronoun fit'); }
  }
  const hasSpecific = gathered.memoryAns || buildKnowledgeText(message, gathered.researched);
  if (UNSURE_RE.test(text) && hasSpecific && cand.strategy === 'lane') {
    s -= 0.3; reasons.push('unsure while gathered knowledge holds an answer');
  }
  return { score: Math.max(0, Math.min(1, s)), reasons };
}

function scoreHonesty(cand, message, gathered, intent) {
  if (cand.strategy === 'lane') return { score: 0.7, reasons: ['old path has its own gates'] };
  if (cand.strategy === 'phatic' || cand.strategy === 'askback' || cand.strategy === 'acknowledge') {
    return { score: 1, reasons: ['no factual claims beyond the user\u2019s own statement'] };
  }
  if (cand.strategy === 'memory') return { score: 1, reasons: ['grounded in conversation history'] };
  const grounded = [
    ...(gathered.researched || []).flatMap(e => e.sentences || []),
    ...(gathered.personalFacts || []).map(f => `${f.type} ${f.value}`),
    String(message || '')
  ].join(' ');
  const cw = voice.contentWords(cand.text || '');
  if (!cw.length) return { score: 0, reasons: ['no content'] };
  const gset = new Set(voice.contentWords(grounded));
  let hit = 0;
  for (const w of cw) if (gset.has(w)) hit++;
  const frac = hit / cw.length;
  if (frac < 0.5) return { score: frac, reasons: [`only ${Math.round(frac * 100)}% of content grounded, disqualified`] };
  return { score: 0.6 + 0.4 * frac, reasons: [`${Math.round(frac * 100)}% grounded`] };
}

function scoreCandidate(cand, message, intent, gathered) {
  const coherence = scoreCoherence(cand, message, intent, gathered);
  const v = voice.voiceScore(cand.text || '');
  const honesty = scoreHonesty(cand, message, gathered, intent);
  let total = 0.5 * coherence.score + 0.25 * v.score + 0.25 * honesty.score;
  if (cand.strategy === 'lane') total += 0.15;
  // A verified creative attempt is the intended answer for a creative prompt:
  // boost it past the lane/knowledge fallbacks without touching their order.
  if (cand.strategy === 'creative' && cand.verified) total += 0.35;
  return {
    strategy: cand.strategy,
    text: cand.text,
    scores: {
      coherence: coherence.score,
      coherenceReasons: coherence.reasons,
      voice: v.score,
      honesty: honesty.score,
      honestyReasons: honesty.reasons,
      total: Math.round(total * 100) / 100
    }
  };
}

// ------------------------------------------------------------- pipeline

async function generateChatReply(message, ctx = {}) {
  const deps = ctx.deps || {};
  const text = String(message == null ? '' : (typeof message === 'string' ? message : (message.prompt || message.message || ''))).trim();
  const trace = { phases: [], external_model_calls: 0 };
  try {
    if (!text) return { ok: false, declined: true, reason: 'empty message' };
    const policyHit = declinedByPolicy(text);
    if (policyHit) {
      trace.phases.push({ phase: 'understand', decision: 'decline', reason: `policy: ${policyHit}` });
      return { ok: false, declined: true, reason: `policy decline: ${policyHit}`, trace };
    }
    let intent = 'unknown';
    try { intent = (deps.classifyIntent && deps.classifyIntent(text)) || 'unknown'; }
    catch (_) { intent = 'unknown'; }
    // Durable beliefs (read-only): checked BEFORE the regex extraction from
    // the recency buffer, so facts from long ago survive long conversations.
    let durableFacts = [];
    try { durableFacts = durableFactsFromBeliefs(deps.getUserBeliefs ? deps.getUserBeliefs() : []); }
    catch (_) { durableFacts = []; }
    const historyForFacts = Array.isArray(ctx.history) ? ctx.history : [];
    const priorFacts = mergeFactsPreferFirst(durableFacts, extractPersonalFacts(historyForFacts, text));
    // Facts stated about the user in THIS message (not a question about them).
    const messageFacts = extractPersonalFacts([], text);
    const memAnsEarly = memoryAnswer(text, priorFacts);
    // A personal-fact statement ("my name is Greg") is worth engaging even
    // when the intent is open_chat/unknown: v2 acknowledges it, which both
    // reads better than the old vague fallback and seeds recall.
    const factStatement = !memAnsEarly && messageFacts.length > 0 && isFactStatementIntent(intent);
    // Knowledge-need engages even when the intent label is open_chat/unknown:
    // the label must not gate research ("tell me about fusion power").
    const knowledgeSeeking = isKnowledgeSeeking(text, intent);
    trace.phases.push({
      phase: 'understand', intent, knowledgeSeeking,
      durableFacts: durableFacts.map(f => `${f.type}=${f.value}`)
    });
    if (!ENGAGE_INTENTS.has(intent) && !memAnsEarly && !factStatement && !knowledgeSeeking
      && !(creativeCore && typeof creativeCore.isCreativeRequest === 'function' && creativeCore.isCreativeRequest(text))) {
      trace.phases.push({ phase: 'understand', decision: 'decline', reason: `intent ${intent} not engaged` });
      return { ok: false, declined: true, reason: `intent not engaged: ${intent}`, trace };
    }

    // Lane runs first: it is both a candidate and the research gate. A bad
    // lane (shortfall, vague fallback, empty) is not a candidate at all, and
    // it is what licenses one research attempt for factual questions.
    let laneText = '';
    try { laneText = await deps.runLane(text, ctx); } catch (_) { laneText = ''; }
    laneText = String(laneText || '').trim();
    const laneBad = isLaneBad(laneText);

    const gathered = await gather(text, intent, deps, ctx, laneBad, knowledgeSeeking, durableFacts);
    trace.phases.push({
      phase: 'gather',
      historyTurns: (gathered.history || []).length,
      personalFacts: gathered.personalFacts.map(f => `${f.type}=${f.value}(${f.source || '?'})`),
      durableFacts: gathered.durableFacts,
      knowledgeSeeking: gathered.knowledgeSeeking,
      researchedTopics: (gathered.researched || []).map(e => e.topic),
      laneBad,
      researchRan: gathered.researchRan ? { topic: gathered.researchRan.topic, added: gathered.researchRan.added } : null
    });

    const candidates = [];
    if (!laneBad) candidates.push({ strategy: 'lane', text: laneText });
    if (gathered.memoryAns) candidates.push({
      strategy: 'memory', text: gathered.memoryAns,
      factSource: gathered.memoryFact ? gathered.memoryFact.source : 'unknown'
    });
    if (factStatement) candidates.push({ strategy: 'acknowledge', text: acknowledgeFact(messageFacts[0]) });
    const knowledgeText = buildKnowledgeText(text, gathered.researched);
    if (knowledgeText) {
      candidates.push({ strategy: 'knowledge', text: knowledgeText });
      const vv = voiceVariant(knowledgeText, text);
      if (vv && vv !== knowledgeText) candidates.push({ strategy: 'voice', text: vv });
    }
    if (PHATIC_INTENTS.has(intent)) candidates.push({ strategy: 'phatic', text: phaticReply(intent, text) });
    // Creative candidate (drawing-board rebuild 2026-09-21): constraint-aware
    // attempt from grounded researched sentences. Form is detected before any
    // generation, structure is planned as data, and the repair module fixes
    // surface constraints. Verified attempts get a selection boost in
    // scoreCandidate so the attempt wins for creative prompts.
    if (creativeCore && typeof creativeCore.isCreativeRequest === 'function' && creativeCore.isCreativeRequest(text)) {
      try {
        const sentences = [];
        for (const entry of (gathered.researched || [])) {
          for (const s of (entry.sentences || [])) {
            if (s && sentences.length < 20) sentences.push(s);
          }
        }
        const attempt = creativeCore.attemptCreative({ prompt: text, sentences });
        if (attempt && !attempt.impossible && attempt.text) {
          candidates.push({ strategy: 'creative', text: attempt.text, verified: true });
        }
      } catch (_) { /* creative candidate optional; never breaks v2 */ }
    }
    if (intent === 'unknown' && laneBad && text.split(/\s+/).length <= 12 && !knowledgeText && !gathered.memoryAns) {
      candidates.push({ strategy: 'askback', text: `What do you mean by "${text.slice(0, 60)}"?` });
    }

    // Length budget (2026-09-21): DISABLED after IFEval regression
    // (48.2% vs 53.6% baseline). The expand/truncate was corrupting
    // constraint-satisfying candidates. Re-enable only with per-prompt
    // validation.
    if (false && lengthMod && typeof lengthMod.parseLengthDemand === 'function') {
      try {
        const demand = lengthMod.parseLengthDemand(text);
        const hasDemand = demand && (demand.exactWords || demand.minWords || demand.maxWords ||
          demand.exactSentences || demand.minSentences || demand.maxSentences ||
          demand.paragraphs || demand.bullets || demand.lines);
        if (hasDemand) {
          for (const c of candidates) {
            if (c.strategy !== 'knowledge' && c.strategy !== 'creative' && c.strategy !== 'voice') continue;
            const extraPool = [];
            for (const entry of (gathered.researched || [])) {
              for (const s of (entry.sentences || [])) {
                if (s && !String(c.text).includes(s)) extraPool.push(s);
              }
            }
            const result = lengthMod.expandToBudget(
              String(c.text).split(/(?<=[.!?])\s+/).filter(Boolean),
              demand,
              extraPool,
              { maxPasses: 3 }
            );
            if (result && result.sentences && result.sentences.length) {
              c.text = result.sentences.join(' ');
            }
          }
        }
      } catch (_) { /* length budget optional; never breaks v2 */ }
    }

    const nonempty = candidates.filter(c => c.text && c.text.trim().length > 0);
    const scored = nonempty.map(c => {
      const s = scoreCandidate(c, text, intent, gathered);
      const disqualified = (c.strategy === 'knowledge' || c.strategy === 'voice') && s.scores.honesty < 0.5;
      return { ...s, disqualified: !!disqualified, factSource: c.factSource || null };
    }).filter(s => !s.disqualified);
    trace.phases.push({
      phase: 'generate_score',
      candidates: scored.map(s => ({ strategy: s.strategy, total: s.scores.total, factSource: s.factSource, text: s.text.slice(0, 90) }))
    });
    if (!scored.length) {
      return { ok: false, declined: true, reason: 'no viable candidates', trace };
    }
    scored.sort((a, b) => b.scores.total - a.scores.total);
    const winner = scored[0];
    if (winner.scores.total < 0.35) {
      return { ok: false, declined: true, reason: `best candidate too weak (${winner.scores.total})`, trace };
    }
    if ((winner.strategy === 'lane') && (VAGUE_FALLBACK_RE.test(winner.text) || SHORTFALL_RE.test(winner.text))) {
      trace.phases.push({ phase: 'speak', decision: 'decline', reason: 'winner is a shortfall, old path retry owns this' });
      return { ok: false, declined: true, reason: 'winner is shortfall', trace };
    }
    const reasons = [
      `winner strategy: ${winner.strategy}`,
      `coherence ${winner.scores.coherence} (${winner.scores.coherenceReasons.join('; ') || 'none'})`,
      `voice ${winner.scores.voice}`,
      `honesty ${winner.scores.honesty} (${winner.scores.honestyReasons.join('; ') || 'none'})`
    ];
    trace.phases.push({ phase: 'speak', winner: winner.strategy, reasons });
    // Standing style rule: no em dashes in user-facing strings. The old lane
    // path still emits them; v2 normalizes its final output.
    const reply = String(winner.text).replace(/\u2014/g, ',').replace(/ {2,}/g, ' ');
    return { ok: true, reply, intent, trace, personalFacts: gathered.personalFacts };
  } catch (error) {
    return { ok: false, declined: true, reason: `generator error: ${String(error && error.message || error)}`, trace };
  }
}

module.exports = {
  generateChatReply,
  ENGAGE_INTENTS,
  NO_RESEARCH_INTENTS,
  extractPersonalFacts,
  memoryAnswer,
  memoryAnswerWithFact,
  acknowledgeFact,
  phaticReply,
  declinedByPolicy,
  isLaneBad,
  isKnowledgeSeeking,
  durableFactsFromBeliefs,
  mergeFactsPreferFirst,
  SHORTFALL_RE,
  VAGUE_FALLBACK_RE
};
