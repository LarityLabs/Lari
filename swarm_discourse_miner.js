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
  /\banswer(ing)? my question\b/i
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
  if (/^\s*(naw|nah|nope|wrong|incorrect)\b/i.test(text) && wc <= 12) {
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
// Miner state (per model => per user in the Telegram setup).
// ---------------------------------------------------------------------------

function minerState(model) {
  model.lariDiscourseMiner = model.lariDiscourseMiner || {
    version: 1,
    lastTurn: null,          // { userMessage, lariAnswer, confidence, intent, at }
    turnLog: [],             // bounded 200, audit only
    pendingRecovery: null,   // { failedTurn, correctionText, at }
    pairs: [],               // completed failure->recovery pairs, bounded 60
    clusters: {},            // key -> [pairIndex...] (indexes into pairs)
    calibration: {},         // intent -> { turns, corrections }
    inductions: [],          // induction attempts, audit
    discardedRecoveries: 0   // pending recoveries dropped: new question, not a retry
  };
  return model.lariDiscourseMiner;
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
// Main entry: call once per completed turn, after the answer is final.
// Returns a small report; never throws.
// ---------------------------------------------------------------------------

function noteTurn(model, turn = {}, bindings = {}) {
  const state = minerState(model);
  const userMessage = String(turn.userMessage || '').trim();
  const lariAnswer = String(turn.lariAnswer || '').trim();
  const intent = String(turn.intent || bindings.classifyIntent?.(userMessage) || 'unknown');
  const confidence = typeof turn.confidence === 'number' ? turn.confidence : null;
  const userScope = String(turn.userScope || 'default');
  const report = { signal: 'neutral', cues: [], induced: null, pairCount: state.pairs.length, confidenceCalibrated: null };

  try {
    const detected = detectSignal(userMessage, state.lastTurn);
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
    //    recovery instead of manufacturing a junk pair.
    if (state.pendingRecovery && !isCorrection && state.lastTurn && state.lastTurn.lariAnswer) {
      const failed = state.pendingRecovery.failedTurn;
      const failedTokens = contentTokens(failed.userMessage || '');
      const retryOverlap = overlapRatio(failedTokens, contentTokens(userMessage));
      const correctionOverlap = overlapRatio(failedTokens, contentTokens(state.pendingRecovery.correctionText || ''));
      let correctedAnswer = null;
      if (failedTokens.length >= 1 && retryOverlap >= 0.5 && lariAnswer) {
        correctedAnswer = lariAnswer;                       // user retried -> this answer is the fix
      } else if (state.pendingRecovery.retryPrompt) {
        correctedAnswer = state.lastTurn.lariAnswer;        // Lari answered the rephrased retry
      } else if (detected.signal === 'approval') {
        correctedAnswer = state.lastTurn.lariAnswer;        // user accepted the recovery
      } else if (failedTokens.length >= 1 && correctionOverlap >= 0.5) {
        correctedAnswer = state.lastTurn.lariAnswer;        // correction restated the prompt
      }
      if (correctedAnswer) {
        const pair = {
          prompt: failed.userMessage,
          failedAnswer: failed.lariAnswer,
          correctedAnswer,
          failedIntent: failed.intent || null,
          correctionText: state.pendingRecovery.correctionText,
          signal: state.pendingRecovery.signal,
          at: new Date().toISOString()
        };
        state.pairs.push(pair);
        if (state.pairs.length > 60) state.pairs.splice(0, state.pairs.length - 60);
        const key = clusterKey(model, pair.prompt, bindings);
        state.clusters[key] = state.clusters[key] || [];
        state.clusters[key].push(state.pairs.length - 1);
        report.pairCount = state.pairs.length;
        // 2. Three pairs, one cluster -> attempt induction (bounded: once per cluster fill).
        if (state.clusters[key].length >= 3) {
          report.induced = tryInduceCluster(model, key, state, bindings);
        }
      } else {
        state.discardedRecoveries = (state.discardedRecoveries || 0) + 1;
      }
      state.pendingRecovery = null;
    }

    // 3. This message corrects the previous turn -> mark failure, await recovery.
    //    Exception: a rephrase that restates the FAILED prompt is a retry of it,
    //    not a new failure — record it on the pending recovery instead.
    if (isCorrection && state.lastTurn && state.lastTurn.userMessage) {
      const pending = state.pendingRecovery;
      const failedPrompt = pending && pending.failedTurn ? pending.failedTurn.userMessage || '' : '';
      const retryOfFailed = pending && !pending.retryPrompt && detected.signal === 'rephrase' &&
        overlapRatio(contentTokens(failedPrompt), contentTokens(userMessage)) >= 0.5;
      if (retryOfFailed) {
        pending.retryPrompt = userMessage.slice(0, 500);
        pending.at = new Date().toISOString();
      } else {
        state.pendingRecovery = {
          failedTurn: { ...state.lastTurn },
          correctionText: userMessage.slice(0, 500),
          signal: detected.signal,
          at: new Date().toISOString()
        };
      }
    }

    // 4. Calibration bookkeeping. A correction blames the *previous* turn's intent.
    if (isCorrection && state.lastTurn) {
      recordCalibration(state, state.lastTurn.intent || 'unknown', true);
    } else {
      recordCalibration(state, intent, false);
    }

    // 5. Roll the turn log.
    state.turnLog.push({
      at: new Date().toISOString(), userScope,
      userMessage: userMessage.slice(0, 300), lariAnswer: lariAnswer.slice(0, 300),
      intent, confidence, signal: detected.signal
    });
    if (state.turnLog.length > 200) state.turnLog.splice(0, state.turnLog.length - 200);
    state.lastTurn = { userMessage, lariAnswer, confidence, intent, at: new Date().toISOString() };

    // 6. Calibrated confidence for this turn's answer.
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
  noteTurn,
  minerState,
  calibrationSummary,
  calibrationFactor,
  consolidateUserMemory,
  getTopBeliefs,
  getBeliefs,
  activeBeliefs
};
