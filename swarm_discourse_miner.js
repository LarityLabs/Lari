'use strict';

// Discourse miner: the loop that makes Lari better at *talking*.
//
// Two halves, one loop:
//
//   1. AUTO-INDUCTION FROM LIVE TURNS. Every conversation turn is evidence.
//      When the user corrects Lari ("not what I meant", "naw", or simply
//      rephrases the question), the turn that failed is marked. When Lari's
//      next answer is accepted (no further correction), the failure->recovery
//      becomes a training pair { prompt, failedAnswer, correctedAnswer }.
//      Pairs are clustered by discourse goal; three pairs sharing one goal
//      trigger induceLariGeneralChatProcedureFromFailures, and the induced
//      program is verified by a trigger/reload check before it counts.
//      Fast path: a correction that DICTATES the right response ("just say
//      X", "when I say thanks just say 'anytime'") completes its pair
//      immediately and seeds a success exemplar.
//      Second track: repeated SUCCESS. The same stimulus answered the same
//      way three times, never corrected in between, induces a
//      success-exemplar discourse operator (observed phrase variants are
//      recorded for the fuzzy matching layer).
//      Nothing here alters the answer — it only observes and learns.
//
//   2. NIGHTLY CONSOLIDATION. Episodic memories are raw footage; beliefs are
//      what Lari actually *knows*. consolidateUserMemory() distills episodes
//      into durable beliefs (identity facts, preferences, directives,
//      topic familiarity, self-knowledge from calibration data) with
//      provenance, arbitrates contradictions (newer/confident wins, loser is
//      superseded not deleted), and caps the store. Meant to run nightly via
//      scripts/run_lari_consolidation.js.
//
// Both halves are deterministic, bounded, and never throw into the caller:
// the runtime wraps every call in try/catch ("observation never breaks chat").
//
// Bindings (provided by the runtime; the miner never reaches into closures):
//   induceFromFailures(model, pairs, options)
//   discourseGoalOf(model, prompt) -> string|null
//   classifyIntent(prompt) -> string
//   routeProcedure(model, prompt, intent) -> { record }|null
//   getEpisodes(model, userScope) -> [episode]
//   contentTokens(text) -> [token]

const STOP = new Set(('a,about,above,after,again,against,all,also,am,an,and,any,are,as,at,be,because,been,before,being,below,between,both,but,by,could,did,do,does,doing,down,during,each,few,for,from,further,had,has,have,having,he,her,here,hers,herself,him,himself,his,how,i,if,in,into,is,it,its,itself,just,like,me,more,most,my,myself,no,nor,not,now,of,off,on,once,only,or,other,ought,our,ours,ourselves,out,over,own,same,she,should,so,some,such,than,that,the,their,theirs,them,themselves,then,there,these,they,this,those,through,to,too,under,until,up,very,was,we,were,what,when,where,which,while,who,whom,why,with,would,you,your,yours,yourself,yourselves,very,really,quite,thing,things,stuff,get,got,going,know,think,want,need,please').split(','));

function words(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
}

function contentTokens(text) {
  return [...new Set(words(text).filter(t => t.length > 3 && !STOP.has(t)))];
}

function overlapRatio(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const b = new Set(bTokens);
  const inter = aTokens.filter(t => b.has(t)).length;
  return inter / Math.max(aTokens.length, bTokens.length);
}

// ---------------------------------------------------------------------------
// Signal detection: what did the user's latest message *do*?
// Signals are judged against the previous turn (the miner keeps lastTurn).
// ---------------------------------------------------------------------------

const CORRECTION_RES = [
  /\bnot what i (meant|asked|said|wanted)\b/i,
  /\byou('re| are) (misunderstanding|misunderstood|wrong|not listening|not getting it)\b/i,
  /\bthat'?s not (what i|it|right|correct)\b/i,
  /\bwrong answer\b/i,
  /\btry again\b/i,
  /\bi (asked|meant|said)\b.{0,50}\bnot\b/i,
  /\bno,? (that'?s|it'?s) not\b/i,
  /\bmissed the point\b/i,
  /\banswer(ing)? my question\b/i,
  // Instructional directive: the user teaches the right behavior after a
  // failure ("when I say thanks just say 'anytime'", "when I ask if we're
  // good just say 'all good man'", "brb means be right back, when I say
  // brb you say got it"). The leading verb tolerates ask/tell and the
  // stimulus may be embedded as a subordinate clause ("if we're good").
  // This is a correction.
  /\bwhen\s+i\s+(?:say|ask|tell)\b.{0,80}?\b(just\s+)?(say|answer|reply|respond)\b/i
];
const SHORT_REJECTIONS = new Set(['naw', 'nope', 'nah', 'wrong', 'no', 'incorrect']);
const APPROVAL_RE = /\b(thanks|thank you|thx|perfect|exactly|nailed it|nice|love it|good (one|shit|call)|lol|lmao|haha|awesome|great)\b/i;

function detectSignal(currentMessage, lastTurn) {
  const text = String(currentMessage || '').trim();
  if (!text) return { signal: 'neutral', cues: [] };
  const cues = [];
  const compact = text.toLowerCase().replace(/[!.?]+$/, '').trim();
  const wc = words(text).length;

  for (const re of CORRECTION_RES) {
    if (re.test(text)) { cues.push('explicit_correction'); return { signal: 'correction', cues }; }
  }
  if (wc <= 2 && SHORT_REJECTIONS.has(compact)) {
    cues.push('short_rejection'); return { signal: 'correction', cues };
  }
  // Leading rejection: "naw man, that wasnt an answer..." — Greg-style.
  // Bare "naw" is caught above; this catches it opening a longer correction.
  // Cap is 40 words: real corrections open with the rejection and then
  // explain ("naw man, that was internal benchmark junk leaking into chat...").
  if (/^\s*(naw|nah|nope|wrong|incorrect)\b/i.test(text) && wc <= 40) {
    cues.push('leading_rejection'); return { signal: 'correction', cues };
  }
  if (APPROVAL_RE.test(text) && (wc <= 10 || /^\s*(thanks|thank you|thx)\b/i.test(text))) {
    cues.push('approval'); return { signal: 'approval', cues };
  }
  // Implicit correction: user rephrases their previous question.
  if (lastTurn && lastTurn.userMessage) {
    const a = contentTokens(lastTurn.userMessage);
    const b = contentTokens(text);
    if (a.length >= 4 && b.length >= 4 && text.toLowerCase() !== String(lastTurn.userMessage).toLowerCase().trim()) {
      const ratio = overlapRatio(a, b);
      if (ratio >= 0.55) { cues.push(`rephrase_overlap_${ratio.toFixed(2)}`); return { signal: 'rephrase', cues }; }
    }
  }
  return { signal: 'neutral', cues };
}

// ---------------------------------------------------------------------------
// Instruction extraction: some corrections literally dictate the right
// response ("just say 'yes, im a he'", "when I say thanks just say
// 'you got it' or 'anytime'"). The dictated response is learnable evidence
// on its own — the pair completes immediately, no next-turn wait.
// Returns { stimulus, response, alternatives } or null. `stimulus` is the
// "when I say X" trigger when present, else null (caller falls back to the
// failed prompt).
// ---------------------------------------------------------------------------

const INSTRUCTION_RESPONSE_STOP = new Set(['that', 'this', 'it', 'so', 'them', 'something']);

function cleanInstructionResponse(raw) {
  let s = String(raw || '').replace(/["'“”‘’]/g, '').trim();
  s = s.replace(/[.,!?;:\s]+$/g, '').trim();
  return s;
}

// Restore the direct question form of a clause embedded after "if/whether"
// in a when-I-ask directive: "when I ask if we're good" teaches the rule
// for the question the user will actually ask ("are we good"). Handles the
// common contracted ("we're good" -> "are we good", "it's ready" -> "is it
// ready") and uncontracted ("we are good" -> "are we good") copula/auxiliary
// shapes; anything else returns unchanged so the stimulus stays exact and
// consult-time matching stays an exact normalized comparison (no fuzzy
// hijack risk).
function restoreQuestionForm(clause) {
  const s = String(clause || '').trim();
  let m;
  if ((m = /^(we|you|they)'re\s+(.+)$/i.exec(s))) return `are ${m[1].toLowerCase()} ${m[2]}`;
  if ((m = /^i'm\s+(.+)$/i.exec(s))) return `am i ${m[1]}`;
  if ((m = /^(he|she|it|that|this|there)'s\s+(.+)$/i.exec(s))) return `is ${m[1].toLowerCase()} ${m[2]}`;
  if ((m = /^(\w+)\s+(am|are|is|was|were|do|does|did|can|could|will|would|should|have|has|had)\s+(.+)$/i.exec(s))) {
    return `${m[2].toLowerCase()} ${m[1].toLowerCase()} ${m[3]}`;
  }
  return s;
}

function extractInstruction(correctionText) {
  const text = String(correctionText || '').trim();
  if (!text) return null;
  let stimulus = null;
  let response = null;
  let m = /\bwhen\s+i\s+(?:say|ask|tell)\s+(?:(if|whether|that)\s+)?(.+?)\s+just\s+(?:say|answer|reply|respond)\b\s*:?\s*(.+)$/i.exec(text);
  if (m) {
    // Restore the question form on the raw clause (apostrophes intact —
    // "we're good" needs its apostrophe for the inversion), then strip
    // quotes as before.
    let rawStimulus = String(m[2]).trim();
    // "when I ask if we're good": the subordinator embeds the question the
    // user will actually ask, so restore its direct form ("are we good") and
    // the stored stimulus matches the future prompt exactly. "that"
    // introduces a statement, not a question — no inversion there.
    if (/^(if|whether)$/i.test(m[1] || '')) rawStimulus = restoreQuestionForm(rawStimulus);
    stimulus = rawStimulus.replace(/["'“”‘’]/g, '').trim();
    response = cleanInstructionResponse(m[3]);
  } else if ((m = /\bwhen\s+i\s+(?:say|ask|tell)\s+(?:you\s+|me\s+)?(.+?)\s+you\s+say\s+(.+)$/i.exec(text))) {
    stimulus = String(m[1]).replace(/["'“”‘’]/g, '').trim();
    response = cleanInstructionResponse(m[2]);
  } else if ((m = /\bjust\s+(?:say|answer)\s*:\s*(.+)$/i.exec(text))) {
    response = cleanInstructionResponse(m[1]);
  } else if ((m = /\bjust\s+say\s+['"](.+?)['"]\s*$/i.exec(text))) {
    response = cleanInstructionResponse(m[1]);
  } else if ((m = /\banswer\s+(?:\w+\s+)?like\s+['"](.+?)['"]\s*$/i.exec(text))) {
    // "answer casual like 'not much, what about you'"
    response = cleanInstructionResponse(m[1]);
  } else if ((m = /\bthe\s+answer\s*(?:is\s*)?:?\s*(.+?)\s+say\s+it\s+back\b/i.exec(text))) {
    // "the answer:I built you because ... . say it back in your own words"
    response = cleanInstructionResponse(m[1]);
  }
  if (!response || response.length < 3 || INSTRUCTION_RESPONSE_STOP.has(response.toLowerCase())) return null;
  if (stimulus && stimulus.length > 120) stimulus = stimulus.slice(0, 120);
  const alternatives = response.split(/\s+or\s+|\s*\/\s*/i).map(s => s.trim()).filter(s => s.length >= 2);
  return { stimulus: stimulus || null, response, alternatives: alternatives.length ? alternatives : [response] };
}

// Normalized stimulus key: lowercase, punctuation collapsed. Phrase variants
// ("hey again" vs "hey") do NOT collapse here — the fuzzy matching layer
// handles those at answer time; the operator records every observed variant.
function stimulusKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Normalized response shape: numbers collapsed so "It's 10:54 AM EDT." and
// "It's 11:03 AM EDT." count as the same repeated success.
function responseShape(text) {
  return String(text || '').toLowerCase().replace(/\d+(\.\d+)?/g, '<n>').replace(/\s+/g, ' ').trim();
}

// Prompt overlap for the pair-completion gates. Content-token overlap when
// both sides have content tokens; falls back to raw-word overlap for short
// prompts ("are you a he") that carry no content tokens at all.
function promptOverlap(aText, bText) {
  const a = contentTokens(aText), b = contentTokens(bText);
  if (a.length && b.length) return overlapRatio(a, b);
  const aw = words(aText).filter(w => w.length > 1), bw = words(bText).filter(w => w.length > 1);
  return overlapRatio(aw, bw);
}

// ---------------------------------------------------------------------------
// Miner state (per model => per user in the Telegram setup).
// ---------------------------------------------------------------------------

function minerState(model) {
  if (!model || typeof model !== 'object') model = {};
  model.lariDiscourseMiner = model.lariDiscourseMiner || {
    version: 2,
    lastTurn: null,          // { userMessage, lariAnswer, confidence, intent, at }
    turnLog: [],             // bounded 200, audit only
    pendingRecovery: null,   // { failedTurn, correctionText, at }
    pairs: [],               // completed failure->recovery pairs, bounded 60
    clusters: {},            // key -> [pairIndex...] (indexes into pairs)
    calibration: {},         // intent -> { turns, corrections }
    inductions: [],          // induction attempts, audit
    successExemplars: {},    // stimulusKey -> { stimulus, responseShape, responseExample, count, affirmed, variants, instructed, induced }
    successOperators: [],    // induced stimulus->response operators from repeated successes, bounded 40
    discardedRecoveries: 0   // pending recoveries dropped: new question, not a retry
  };
  const s = model.lariDiscourseMiner;
  // Legacy migration (round-2 fix, 2026-09-19): successOperators and
  // successExemplars were added after some models had already persisted a
  // miner state. A legacy-shaped state reached noteTurn missing those keys,
  // and the report literal read .length on undefined BEFORE noteTurn's try —
  // every turn crashed and the hook's silent catch swallowed it (turns logged
  // 0 pairs, 0 inductions on the live model). Backfill defaults on first
  // touch so legacy state migrates cleanly without losing history.
  if (!Array.isArray(s.successOperators)) s.successOperators = [];
  if (!s.successExemplars || typeof s.successExemplars !== 'object' || Array.isArray(s.successExemplars)) s.successExemplars = {};
  if (!Array.isArray(s.pairs)) s.pairs = [];
  if (!Array.isArray(s.turnLog)) s.turnLog = [];
  if (!Array.isArray(s.inductions)) s.inductions = [];
  if (!s.clusters || typeof s.clusters !== 'object' || Array.isArray(s.clusters)) s.clusters = {};
  if (!s.calibration || typeof s.calibration !== 'object' || Array.isArray(s.calibration)) s.calibration = {};
  if (typeof s.discardedRecoveries !== 'number') s.discardedRecoveries = 0;
  if (s.version !== 2) s.version = 2;
  return s;
}

function recordCalibration(state, intent, corrected) {
  const key = String(intent || 'unknown');
  const bin = state.calibration[key] = state.calibration[key] || { turns: 0, corrections: 0 };
  bin.turns += 1;
  if (corrected) bin.corrections += 1;
}

// Empirical shrinkage for reported confidence. Only applies with enough
// samples (>=5 turns); floored so it can never halve confidence.
function calibrationFactor(state, intent) {
  const bin = state.calibration[String(intent || 'unknown')];
  if (!bin || bin.turns < 5) return 1;
  const rate = bin.corrections / bin.turns;
  if (rate <= 0.2) return 1;
  return Math.max(0.5, 1 - rate * 0.8);
}

function calibrationSummary(model) {
  const state = minerState(model);
  return Object.entries(state.calibration).map(([intent, bin]) => ({
    intent,
    turns: bin.turns,
    corrections: bin.corrections,
    rate: bin.turns ? bin.corrections / bin.turns : 0
  })).sort((a, b) => b.rate - a.rate);
}

// ---------------------------------------------------------------------------
// Pair completion + success-operator induction helpers.
// ---------------------------------------------------------------------------

// Push a completed failure->recovery pair, cluster it, and attempt induction
// when the cluster fills (3 pairs). Shared by every completion path.
function completePair(state, fields, model, bindings, report) {
  const pair = {
    prompt: String(fields.prompt || '').slice(0, 500),
    failedAnswer: String(fields.failedAnswer || '').slice(0, 500),
    correctedAnswer: String(fields.correctedAnswer || '').slice(0, 500),
    failedIntent: fields.failedIntent || null,
    correctionText: String(fields.correctionText || '').slice(0, 500),
    signal: fields.signal || null,
    via: fields.via || 'recovery',
    at: new Date().toISOString()
  };
  if (!pair.prompt || !pair.correctedAnswer) return false;
  state.pairs.push(pair);
  if (state.pairs.length > 60) state.pairs.splice(0, state.pairs.length - 60);
  const key = clusterKey(model, pair.prompt, bindings);
  state.clusters[key] = state.clusters[key] || [];
  state.clusters[key].push(state.pairs.length - 1);
  if (report) report.pairCount = state.pairs.length;
  // Three pairs, one cluster -> attempt induction (bounded: once per cluster fill).
  if (state.clusters[key].length >= 3) {
    const induced = tryInduceCluster(model, key, state, bindings);
    if (report) report.induced = induced;
  }
  return true;
}

// An explicit user instruction ("when I say thanks just say 'anytime'")
// seeds a success exemplar. The instruction itself counts double: a stated
// rule is stronger evidence than one observed repetition.
function seedInstructedExemplar(state, instruction) {
  const key = stimulusKey(instruction.stimulus);
  if (!key) return;
  const shape = responseShape(instruction.response);
  const now = new Date().toISOString();
  state.successExemplars[key] = {
    stimulus: String(instruction.stimulus).slice(0, 120),
    responseShape: shape,
    responseExample: String(instruction.response).slice(0, 300),
    alternatives: instruction.alternatives || [instruction.response],
    count: 2,
    affirmed: 0,
    violations: 0,
    variants: [String(instruction.stimulus).slice(0, 120)],
    instructed: true,
    induced: false,
    at: now,
    lastAt: now
  };
  pruneExemplars(state);
  maybeInduceSuccessOperator(state, key, state.successExemplars[key]);
}

function pruneExemplars(state) {
  const keys = Object.keys(state.successExemplars || {});
  if (keys.length <= 120) return;
  keys.sort((a, b) => String(state.successExemplars[a].lastAt || '').localeCompare(String(state.successExemplars[b].lastAt || '')));
  for (const k of keys.slice(0, keys.length - 120)) delete state.successExemplars[k];
}

// Repeated successful exchanges (same stimulus -> same response shape, never
// corrected in between) become a learnable discourse operator at 3
// observations. Observed phrase variants are recorded on the operator so the
// fuzzy matching layer can match them at answer time.
function maybeInduceSuccessOperator(state, key, ex) {
  if (!ex || ex.induced || ex.count < 3) return null;
  const crypto = require('crypto');
  const id = 'lari.learned.operator.chat.success.' + crypto.createHash('sha256')
    .update(key + '|' + ex.responseShape).digest('hex').slice(0, 12);
  const operator = {
    id,
    kind: 'success_exemplar_operator',
    stimulusKey: key,
    stimuli: [...(ex.variants || [])],
    responseShape: ex.responseShape,
    responseExample: ex.responseExample,
    alternatives: ex.alternatives || null,
    evidenceCount: ex.count,
    affirmed: ex.affirmed || 0,
    instructed: !!ex.instructed,
    confidence: Math.min(0.95, 0.6 + 0.1 * ex.count),
    inducedAt: new Date().toISOString(),
    provenance: { creationSource: 'discourse_miner_repeated_success', verification: 'uncorrected_repetition' }
  };
  ex.induced = true;
  state.successOperators.push(operator);
  if (state.successOperators.length > 40) state.successOperators.splice(0, state.successOperators.length - 40);
  state.inductions.push({ at: new Date().toISOString(), cluster: 'success:' + key, attempted: true, learned: true, kind: 'success_exemplar', operatorId: id, evidenceCount: ex.count });
  if (state.inductions.length > 40) state.inductions.splice(0, state.inductions.length - 40);
  return operator;
}

// Every non-correction turn is success evidence for its stimulus. A
// correction resets the exemplar for the failed stimulus (the response did
// not land). Approval affirms the previous turn's exemplar.
function recordSuccessExemplar(state, userMessage, lariAnswer, signal, prevTurn) {
  if (signal === 'correction' || signal === 'rephrase') {
    if (prevTurn && prevTurn.userMessage) {
      const ex = state.successExemplars[stimulusKey(prevTurn.userMessage)];
      if (ex && !ex.induced) { ex.count = 0; ex.affirmed = 0; }
    }
    return null;
  }
  if (signal === 'approval' && prevTurn && prevTurn.userMessage) {
    const aEx = state.successExemplars[stimulusKey(prevTurn.userMessage)];
    if (aEx) aEx.affirmed += 1;
  }
  if (!lariAnswer) return null;
  const key = stimulusKey(userMessage);
  if (!key) return null;
  const shape = responseShape(lariAnswer);
  const now = new Date().toISOString();
  const raw = String(userMessage).slice(0, 120);
  let ex = state.successExemplars[key];
  if (!ex || (!ex.instructed && ex.responseShape !== shape)) {
    // New stimulus, or Lari changed its answer: start (or restart) counting.
    ex = state.successExemplars[key] = {
      stimulus: raw, responseShape: shape, responseExample: String(lariAnswer).slice(0, 300),
      alternatives: null, count: 1, affirmed: 0, violations: 0,
      variants: [raw], instructed: false, induced: false, at: now, lastAt: now
    };
    pruneExemplars(state);
    return null;
  }
  if (ex.instructed && !ex.induced) {
    // Instruction-seeded: only a matching response confirms it. Anything
    // else is a violation of the user's stated rule, not new evidence.
    const matched = shape === ex.responseShape
      || (ex.alternatives || []).some(alt => shape.includes(responseShape(alt)));
    if (matched) {
      ex.count += 1;
      ex.lastAt = now;
      if (!ex.variants.includes(raw) && ex.variants.length < 6) ex.variants.push(raw);
    } else {
      ex.violations = (ex.violations || 0) + 1;
    }
    return maybeInduceSuccessOperator(state, key, ex);
  }
  ex.count += 1;
  ex.lastAt = now;
  if (!ex.variants.includes(raw) && ex.variants.length < 6) ex.variants.push(raw);
  return maybeInduceSuccessOperator(state, key, ex);
}

// ---------------------------------------------------------------------------
// Main entry: call once per completed turn, after the answer is final.
// Returns a small report; never throws.
// ---------------------------------------------------------------------------

function noteTurn(model, turn = {}, bindings = {}) {
  // Default report first: the try/catch placement here is load-bearing. The
  // report literal used to read state.successOperators.length BEFORE the try
  // (and minerState had no legacy migration), so a legacy-shaped state
  // crashed every turn with the hook's silent catch as the only safety net.
  // Now nothing outside the try can throw into the caller.
  const report = { signal: 'neutral', cues: [], induced: null, successInduced: null, successOperators: 0, pairCount: 0, confidenceCalibrated: null };

  try {
    const state = minerState(model);
    const userMessage = String(turn.userMessage || '').trim();
    const lariAnswer = String(turn.lariAnswer || '').trim();
    const intent = String(turn.intent || bindings.classifyIntent?.(userMessage) || 'unknown');
    const confidence = typeof turn.confidence === 'number' ? turn.confidence : null;
    const userScope = String(turn.userScope || 'default');
    report.successOperators = (state.successOperators || []).length;
    report.pairCount = (state.pairs || []).length;
    const detected = detectSignal(userMessage, state.lastTurn);
    const prevTurn = state.lastTurn;
    report.signal = detected.signal;
    report.cues = detected.cues;
    const isCorrection = detected.signal === 'correction' || detected.signal === 'rephrase';

    // 1. If a recovery was pending and this message is NOT another correction,
    //    decide whether the recovery genuinely landed. A training pair is
    //    completed ONLY when the recovery is tied to the failed prompt:
    //      - the user retried the same prompt (this message overlaps it), so
    //        THIS turn's answer is the recovery; or
    //      - the pending recovery already holds a rephrased retry, so Lari's
    //        answer to that retry (last turn) is the recovery; or
    //      - the user approved (thanks/perfect/...) Lari's answer; or
    //      - the correction itself restated the failed prompt, so Lari's reply
    //        to the correction is the recovery.
    //    Anything else (new question, topic change) discards the pending
    //    recovery instead of manufacturing a junk pair. Thresholds are 0.35:
    //    strict enough that an unrelated follow-up still fails, loose enough
    //    that a genuine restatement with different filler words passes.
    //    promptOverlap falls back to raw-word overlap for short prompts
    //    ("are you a he") that carry no content tokens at all.
    if (state.pendingRecovery && !isCorrection && prevTurn && prevTurn.lariAnswer) {
      const failed = state.pendingRecovery.failedTurn;
      const retryOverlap = promptOverlap(failed.userMessage || '', userMessage);
      const correctionOverlap = promptOverlap(failed.userMessage || '', state.pendingRecovery.correctionText || '');
      let correctedAnswer = null;
      let via = 'recovery';
      if (retryOverlap >= 0.35 && lariAnswer) {
        correctedAnswer = lariAnswer;                       // user retried -> this answer is the fix
        via = 'retry';
      } else if (state.pendingRecovery.retryPrompt) {
        correctedAnswer = prevTurn.lariAnswer;              // Lari answered the rephrased retry
        via = 'rephrase_retry';
      } else if (detected.signal === 'approval') {
        correctedAnswer = prevTurn.lariAnswer;              // user accepted the recovery
        via = 'approval';
      } else if (correctionOverlap >= 0.35) {
        correctedAnswer = prevTurn.lariAnswer;              // correction restated the prompt
        via = 'correction_restatement';
      }
      if (correctedAnswer) {
        completePair(state, {
          prompt: failed.userMessage,
          failedAnswer: failed.lariAnswer,
          correctedAnswer,
          failedIntent: failed.intent || null,
          correctionText: state.pendingRecovery.correctionText,
          signal: state.pendingRecovery.signal,
          via
        }, model, bindings, report);
      } else {
        state.discardedRecoveries = (state.discardedRecoveries || 0) + 1;
      }
      state.pendingRecovery = null;
    }

    // 3. This message corrects the previous turn -> mark failure, await recovery.
    //    Fast path: the correction DICTATES the right response ("just say X",
    //    "when I say thanks just say 'anytime'") — the pair completes NOW
    //    with the dictated response; no next-turn wait, no overlap math.
    //    Otherwise a rephrase that restates the FAILED prompt is a retry of
    //    it, not a new failure — record it on the pending recovery instead.
    if (isCorrection && prevTurn && prevTurn.userMessage) {
      const instruction = detected.signal === 'correction' ? extractInstruction(userMessage) : null;
      if (instruction && prevTurn.lariAnswer) {
        completePair(state, {
          prompt: instruction.stimulus || prevTurn.userMessage,
          failedAnswer: prevTurn.lariAnswer,
          correctedAnswer: instruction.response,
          failedIntent: prevTurn.intent || null,
          correctionText: userMessage.slice(0, 500),
          signal: detected.signal,
          via: 'instruction'
        }, model, bindings, report);
        seedInstructedExemplar(state, instruction);
        state.pendingRecovery = null;
      } else {
        const pending = state.pendingRecovery;
        const failedPrompt = pending && pending.failedTurn ? pending.failedTurn.userMessage || '' : '';
        const retryOfFailed = pending && !pending.retryPrompt && detected.signal === 'rephrase' &&
          promptOverlap(failedPrompt, userMessage) >= 0.35;
        if (retryOfFailed) {
          pending.retryPrompt = userMessage.slice(0, 500);
          pending.at = new Date().toISOString();
        } else {
          state.pendingRecovery = {
            failedTurn: { ...prevTurn },
            correctionText: userMessage.slice(0, 500),
            signal: detected.signal,
            at: new Date().toISOString()
          };
        }
      }
    }

    // 4. Calibration bookkeeping. A correction blames the *previous* turn's intent.
    if (isCorrection && prevTurn) {
      recordCalibration(state, prevTurn.intent || 'unknown', true);
    } else {
      recordCalibration(state, intent, false);
    }

    // 5. Success exemplars: every uncorrected turn is evidence that this
    //    stimulus -> response shape works. A correction resets the exemplar
    //    for the failed stimulus. Three uncorrected repetitions induce a
    //    discourse operator (also reported below).
    const successInduced = recordSuccessExemplar(state, userMessage, lariAnswer, detected.signal, prevTurn);
    if (successInduced) {
      report.successInduced = {
        id: successInduced.id,
        stimulusKey: successInduced.stimulusKey,
        stimuli: successInduced.stimuli,
        responseExample: successInduced.responseExample,
        evidenceCount: successInduced.evidenceCount,
        confidence: successInduced.confidence
      };
    }
    report.successOperators = (state.successOperators || []).length;

    // 6. Roll the turn log.
    state.turnLog.push({
      at: new Date().toISOString(), userScope,
      userMessage: userMessage.slice(0, 300), lariAnswer: lariAnswer.slice(0, 300),
      intent, confidence, signal: detected.signal
    });
    if (state.turnLog.length > 200) state.turnLog.splice(0, state.turnLog.length - 200);
    state.lastTurn = { userMessage, lariAnswer, confidence, intent, at: new Date().toISOString() };

    // 7. Calibrated confidence for this turn's answer.
    if (confidence != null) {
      const factor = calibrationFactor(state, intent);
      report.confidenceCalibrated = Math.round(confidence * factor * 1000) / 1000;
    }
  } catch (_) { /* observation never breaks chat */ }
  return report;
}

function clusterKey(model, prompt, bindings) {
  try {
    const goal = bindings.discourseGoalOf?.(model, prompt);
    if (goal) return `goal:${goal}`;
  } catch (_) {}
  try {
    return `intent:${bindings.classifyIntent?.(prompt) || 'unknown'}`;
  } catch (_) { return 'intent:unknown'; }
}

function tryInduceCluster(model, key, state, bindings) {
  const outcome = { cluster: key, attempted: false, learned: false };
  try {
    const idxs = (state.clusters[key] || []).slice(-3);
    const examples = idxs.map(i => state.pairs[i]).filter(Boolean)
      .map(p => ({ prompt: p.prompt, correctedAnswer: p.correctedAnswer, failedAnswer: p.failedAnswer }));
    if (examples.length < 3 || typeof bindings.induceFromFailures !== 'function') return outcome;
    outcome.attempted = true;
    outcome.exampleCount = examples.length;
    const result = bindings.induceFromFailures(model, examples, {
      sourceModelHash: null,
      sourcePath: 'discourse_miner_auto_induction'
    });
    outcome.learned = result?.learned === true;
    outcome.reason = result?.reason || null;
    if (outcome.learned && result.record) {
      outcome.recordId = result.record.id;
      // Verification: the induced program must actually win routing on its
      // own training prompts (trigger/reload check). Honest and cheap.
      let hits = 0;
      for (const ex of examples) {
        try {
          const routed = bindings.routeProcedure?.(model, ex.prompt, bindings.classifyIntent?.(ex.prompt) || 'open_chat');
          if (routed?.record?.id === result.record.id) hits += 1;
        } catch (_) {}
      }
      outcome.verified = hits >= 2;
      outcome.routingHits = hits;
      try {
        result.record.provenance = result.record.provenance || {};
        result.record.provenance.autoInduced = true;
        result.record.provenance.autoVerified = outcome.verified;
        result.record.provenance.verification = 'auto_induced_trigger_reload';
      } catch (_) {}
    }
    state.inductions.push({ at: new Date().toISOString(), ...outcome });
    if (state.inductions.length > 40) state.inductions.splice(0, state.inductions.length - 40);
    // Cluster is consumed whether induction succeeded or not; pairs stay for audit.
    state.clusters[key] = [];
  } catch (_) { /* never breaks chat */ }
  return outcome;
}

// ---------------------------------------------------------------------------
// Consolidation: episodes -> durable beliefs.
// ---------------------------------------------------------------------------

function beliefId(type, subject, predicate, object) {
  const crypto = require('crypto');
  return 'belief.' + crypto.createHash('sha256')
    .update(JSON.stringify([type, subject, predicate, String(object).toLowerCase().trim()]))
    .digest('hex').slice(0, 16);
}

function getBeliefs(model) {
  model.lariConsolidatedBeliefs = model.lariConsolidatedBeliefs || { version: 1, updatedAt: null, beliefs: [] };
  if (!Array.isArray(model.lariConsolidatedBeliefs.beliefs)) model.lariConsolidatedBeliefs.beliefs = [];
  return model.lariConsolidatedBeliefs;
}

function activeBeliefs(model, scope) {
  return getBeliefs(model).beliefs.filter(b => b && b.status === 'active' && (b.scope || 'default') === scope);
}

function getTopBeliefs(model, userScope = 'default', limit = 8) {
  return activeBeliefs(model, userScope)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, limit);
}

const IDENTITY_SUBJECT_STOP = new Set(['question', 'point', 'problem', 'issue', 'thing', 'things', 'stuff', 'answer', 'response', 'bad', 'wrong', 'not']);

function extractBeliefsFromEpisodes(episodes) {
  const found = [];
  const push = (type, subject, predicate, object, confidence, episode, text) => {
    let clean = String(object || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    clean = clean.replace(/\s+(now|today|currently|anymore)$/i, '').trim();
    if (!clean || clean.length < 2) return;
    found.push({
      id: beliefId(type, subject, predicate, clean),
      type, subject, predicate, object: clean, text: text || clean,
      confidence, scope: 'default', provenance: [episode.id],
      createdAt: new Date().toISOString(),
      observedAt: episode.timestamp || new Date().toISOString(),
      status: 'active',
      supersededBy: null
    });
  };
  for (const ep of episodes || []) {
    const summary = String(ep?.summary || '');
    if (!summary) continue;
    const boost = Math.min(0.1, (ep.importance || 0) * 0.1);
    let m;
    const rememberRe = /\bremember that ([^.;!?]+)/gi;
    while ((m = rememberRe.exec(summary))) {
      push('directive', 'user', 'remember', m[1], Math.min(0.98, 0.95), ep, `remember: ${m[1].trim()}`);
    }
    const nameRe = /\b(?:my name is|call me) ([^.;!?]+)/gi;
    while ((m = nameRe.exec(summary))) {
      push('identity', 'user', 'name', m[1], Math.min(0.98, 0.9 + boost), ep, `the user's name is ${m[1].trim()}`);
    }
    const myIsRe = /\bmy ([\w-]+(?: [\w-]+){0,2}) is ([^.;!?]+)/gi;
    while ((m = myIsRe.exec(summary))) {
      const subj = m[1].toLowerCase().trim();
      if (IDENTITY_SUBJECT_STOP.has(subj) || subj.split(' ').length > 3) continue;
      push('identity', 'user', subj, m[2], Math.min(0.95, 0.7 + boost), ep, `the user's ${subj} is ${m[2].trim()}`);
    }
    const iAmRe = /\bi (live in|work as|work at|am a|am an|own|do for work) ([^.;!?]+)/gi;
    while ((m = iAmRe.exec(summary))) {
      push('identity', 'user', m[1].toLowerCase(), m[2], Math.min(0.95, 0.75 + boost), ep, `the user ${m[1]} ${m[2].trim()}`);
    }
    const prefRe = /\bi (really )?(love|like|hate|dislike|prefer|enjoy) ([^.;!?]+)/gi;
    while ((m = prefRe.exec(summary))) {
      push('preference', 'user', m[2].toLowerCase(), m[3], Math.min(0.95, 0.7 + boost), ep, `the user ${m[2]}s ${m[3].trim()}`);
    }
    const habitRe = /\bi (always|never) ([^.;!?]+)/gi;
    while ((m = habitRe.exec(summary))) {
      push('behavioral', 'user', m[1].toLowerCase(), m[2], Math.min(0.9, 0.65 + boost), ep, `the user ${m[1]} ${m[2].trim()}`);
    }
  }
  // Topic familiarity: a topic recurring across episodes is durable context.
  const topicStats = {};
  for (const ep of episodes || []) {
    for (const t of ep?.topics || []) {
      const key = String(t).toLowerCase();
      topicStats[key] = topicStats[key] || { count: 0, importance: 0, episodes: [] };
      topicStats[key].count += 1;
      topicStats[key].importance += (ep.importance || 0);
      topicStats[key].episodes.push(ep.id);
    }
  }
  for (const [topic, st] of Object.entries(topicStats)) {
    if (st.count >= 3 && st.importance >= 1.5) {
      const latest = st.episodes.map(id => episodes.find(e => e.id === id)?.timestamp).filter(Boolean).sort().pop();
      found.push({
        id: beliefId('familiarity', 'user', 'discusses', topic),
        type: 'familiarity', subject: 'user', predicate: 'discusses', object: topic,
        text: `the user often discusses ${topic}`,
        confidence: Math.min(0.9, 0.55 + st.count * 0.05), scope: 'default',
        provenance: st.episodes.slice(0, 8),
        createdAt: new Date().toISOString(),
        observedAt: latest || new Date().toISOString(),
        status: 'active', supersededBy: null
      });
    }
  }
  return found;
}

function recencyBoost(isoDate) {
  const ageDays = (Date.now() - new Date(isoDate || 0).getTime()) / 86400000;
  if (!isFinite(ageDays) || ageDays < 0) return 1;
  return 1 + Math.max(0, (30 - Math.min(ageDays, 30)) / 30);
}

function sameClaim(a, b) {
  return a && b && a.type === b.type && a.subject === b.subject && a.predicate === b.predicate
    && String(a.object).toLowerCase().trim() === String(b.object).toLowerCase().trim();
}

function contradicts(a, b) {
  return a && b && a.type === b.type && a.subject === b.subject && a.predicate === b.predicate
    && String(a.object).toLowerCase().trim() !== String(b.object).toLowerCase().trim();
}

// Distill + arbitrate. Returns a report; mutates model.lariConsolidatedBeliefs.
function consolidateUserMemory(model, userScope = 'default', options = {}) {
  const store = getBeliefs(model);
  const getEpisodes = options.getEpisodes;
  const episodes = typeof getEpisodes === 'function' ? getEpisodes(model, userScope) : [];
  const report = {
    scope: userScope, episodesSeen: episodes.length,
    newBeliefs: 0, merged: 0, superseded: 0, calibrationBeliefs: 0,
    totalActive: 0, beliefs: []
  };
  try {
    const candidates = extractBeliefsFromEpisodes(episodes);

    // Calibration -> self-knowledge beliefs ("judgment you can read").
    // Threshold is heuristic: ~1 correction in 3 answers is already bad.
    try {
      const calib = calibrationSummary(model);
      for (const c of calib) {
        if (c.turns >= (options.minCalibrationTurns || 5) && c.rate >= (options.calibrationRateThreshold || 0.3)) {
          candidates.push({
            id: beliefId('self_knowledge', 'lari', 'correction_rate', c.intent),
            type: 'self_knowledge', subject: 'lari', predicate: 'correction_rate', object: c.intent,
            text: `I get corrected ${c.corrections}/${c.turns} of the time on ${c.intent} — hedge and clarify there`,
            confidence: Math.min(0.9, 0.5 + c.rate * 0.4), scope: userScope,
            provenance: ['discourse_miner_calibration'],
            createdAt: new Date().toISOString(),
            observedAt: new Date().toISOString(),
            status: 'active', supersededBy: null
          });
          report.calibrationBeliefs += 1;
        }
      }
    } catch (_) {}

    for (const cand of candidates) {
      cand.scope = userScope;
      const existing = store.beliefs.find(b => b && (b.scope || 'default') === userScope && b.id === cand.id);
      if (existing) {
        if (existing.status === 'active') {
          existing.provenance = [...new Set([...(existing.provenance || []), ...(cand.provenance || [])])].slice(0, 12);
          existing.confidence = Math.min(0.98, (existing.confidence || 0) + 0.02);
          report.merged += 1;
        } else if (existing.status === 'superseded') {
          // A superseded belief reappearing is new evidence: revive it as a contender.
          existing.status = 'active';
          existing.supersededBy = null;
          existing.provenance = [...new Set([...(existing.provenance || []), ...(cand.provenance || [])])].slice(0, 12);
          report.merged += 1;
        }
        continue;
      }
      // Contradiction check against active beliefs.
      const rival = store.beliefs.find(b => b && b.status === 'active'
        && (b.scope || 'default') === userScope && contradicts(b, cand));
      if (rival) {
        // Recency is judged by when the underlying evidence was *observed*
        // (episode time), not when the belief row was written.
        const rivalScore = (rival.confidence || 0) * recencyBoost(rival.observedAt || rival.createdAt);
        const candScore = (cand.confidence || 0) * recencyBoost(cand.observedAt || cand.createdAt);
        if (candScore > rivalScore) {
          rival.status = 'superseded';
          rival.supersededBy = cand.id;
          cand.supersedes = rival.id;
          cand.confidence = Math.min(0.98, cand.confidence + 0.03);
          store.beliefs.push(cand);
          report.newBeliefs += 1; report.superseded += 1;
        } else {
          rival.provenance = [...new Set([...(rival.provenance || []), ...(cand.provenance || [])])].slice(0, 12);
          rival.confidence = Math.min(0.98, (rival.confidence || 0) + 0.02);
          report.merged += 1;
        }
        continue;
      }
      store.beliefs.push(cand);
      report.newBeliefs += 1;
    }

    // Cap: keep the 100 most confident active beliefs per scope; prune the rest.
    const actives = store.beliefs.filter(b => b && b.status === 'active' && (b.scope || 'default') === userScope)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    if (actives.length > 100) {
      const drop = new Set(actives.slice(100).map(b => b.id));
      store.beliefs = store.beliefs.filter(b => !drop.has(b.id));
    }
    store.updatedAt = new Date().toISOString();
    report.totalActive = store.beliefs.filter(b => b && b.status === 'active' && (b.scope || 'default') === userScope).length;
    report.beliefs = getTopBeliefs(model, userScope, 12).map(b => ({ id: b.id, text: b.text, confidence: b.confidence, type: b.type }));
  } catch (_) { /* consolidation never breaks anything */ }
  return report;
}

module.exports = {
  detectSignal,
  contentTokens,
  extractInstruction,
  stimulusKey,
  responseShape,
  promptOverlap,
  noteTurn,
  minerState,
  calibrationSummary,
  calibrationFactor,
  consolidateUserMemory,
  getTopBeliefs,
  getBeliefs,
  activeBeliefs
};
