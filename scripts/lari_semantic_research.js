#!/usr/bin/env node
/**
 * lari_semantic_research.js — bridge: Small Lari's RESEARCH loop into his
 * semantic discovery/induction loop.
 *
 * Greg's standing rule: when Lari doesn't know a fact or how to do something,
 * he researches it and teaches himself. That rule existed for FACTS
 * (scripts/lari_research.js: shortfall -> research -> persist -> retry) but
 * the semantic stack never got the same treatment: discovery marked truth
 * conditions UNKNOWN and just stopped there. This module closes that gap.
 *
 * Three trigger conditions (all deterministic; no trigger -> no research):
 *  1. Discovery proposes a construction but truth inference returns UNKNOWN
 *     or contradictory  -> research what the marker signals -> distill truth.
 *  2. Induction encounters a marker-shaped token it cannot resolve to any
 *     known relation -> accumulate 2 examples -> research the marker.
 *  3. Answer grounding hits "I don't remember us covering that" on a
 *     relation-seeking question -> research the underlying FACT (existing
 *     research path) AND log the construction gap.
 *
 * The researched truth re-enters the EXISTING 7-gate qualification protocol.
 * A researched truth table that fails gates -> candidate rejected, logged
 * with the research trail. Operators are only ever added through the gates,
 * never directly. Provenance (article, sentence, pattern) is stored on the
 * operator record; exact ablation still works.
 *
 * Deterministic: seeded synthesis, injectable research function (tests use a
 * stub; production uses the Wikipedia-backed research path). Zero external
 * model calls. Scratch models/corpora only. Never throws.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

let semMod = null;
let discMod = null;
let researchMod = null;
function getSem() {
  if (!semMod) semMod = require(path.join(__dirname, 'lari_semantic_induction.js'));
  return semMod;
}
function getDisc() {
  if (!discMod) discMod = require(path.join(__dirname, 'lari_construction_discovery.js'));
  return discMod;
}
function getResearch() {
  if (!researchMod) researchMod = require(path.join(__dirname, 'lari_research.js'));
  return researchMod;
}

const ROOT = path.join(__dirname, '..');
const BRIDGE_SECTION = 'lari_semantic_research';
const MAX_LOG = 100;
const MIN_UNRESOLVED_EXAMPLES = 2;

// ---------------------------------------------------------------------------
// Bridge state section (hardened, bounded)
// ---------------------------------------------------------------------------
function ensureBridgeSection(model) {
  if (!model || typeof model !== 'object') return null;
  if (!model[BRIDGE_SECTION] || typeof model[BRIDGE_SECTION] !== 'object') {
    model[BRIDGE_SECTION] = { triggers: [], repairs: [], qualified: [], unresolvedMarkers: {} };
  }
  const s = model[BRIDGE_SECTION];
  for (const k of ['triggers', 'repairs', 'qualified']) {
    if (!Array.isArray(s[k])) s[k] = [];
  }
  if (!s.unresolvedMarkers || typeof s.unresolvedMarkers !== 'object') s.unresolvedMarkers = {};
  return s;
}

function nowIso(opts) {
  try {
    if (opts && typeof opts.clock === 'function') return opts.clock();
  } catch (_) { /* fall through */ }
  return new Date().toISOString();
}

// FNV-1a, byte-identical to the induction module's copy (which is not
// exported). Used only to reproduce deterministic record ids.
function fnv1aLocal(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// The record id the induction module would assign this operator:
// lari.learned.operator.semantic.<relation>.<fnv1a({relation,family,order,markers})>
function deterministicRecordId(relation, marker, order) {
  const family = `${relation}_fam`;
  const famOrder = order === 'mid' ? 'marker_mid' : 'marker_first';
  const identity = fnv1aLocal(JSON.stringify({ relation, family, order: famOrder, markers: [marker] }));
  return `lari.learned.operator.semantic.${relation}.${identity}`;
}

function logTrigger(model, entry, opts) {
  try {
    const s = ensureBridgeSection(model);
    if (!s) return null;
    const seq = (s.triggers.length ? s.triggers[s.triggers.length - 1].seq : 0) + 1;
    const rec = Object.assign({ seq, ts: nowIso(opts) }, entry);
    s.triggers.push(rec);
    while (s.triggers.length > MAX_LOG) s.triggers.shift();
    return rec;
  } catch (_) { return null; }
}

function logRepair(model, entry, opts) {
  try {
    const s = ensureBridgeSection(model);
    if (!s) return null;
    const rec = Object.assign({ ts: nowIso(opts) }, entry);
    s.repairs.push(rec);
    while (s.repairs.length > MAX_LOG) s.repairs.shift();
    return rec;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Trigger 1: discovery candidate with UNKNOWN / contradictory truth
// ---------------------------------------------------------------------------
function assessDiscoveryTrigger(candidate) {
  try {
    if (!candidate || typeof candidate !== 'object') return { triggered: false, reason: 'bad_candidate' };
    if (candidate.status === 'unqualified_unknown_truth') {
      const markers = Array.isArray(candidate.markers) ? candidate.markers : [];
      if (!markers.length) return { triggered: false, reason: 'no_markers' };
      return {
        triggered: true,
        kind: 'unknown_truth',
        marker: String(markers[0]).toLowerCase(),
        order: candidate.order || 'front',
        boundary: candidate.boundary || 'comma',
        instances: Array.isArray(candidate._instances) ? candidate._instances.slice(0, 4) : [],
        supportDialogues: candidate.supportDialogues || 0,
        votes: candidate.votes || null,
        reason: 'truth_unresolved_or_contradictory',
      };
    }
    // Resolved or rediscovered: dialogue evidence already did the job.
    return { triggered: false, reason: 'truth_resolved_no_research_needed', status: candidate.status || null };
  } catch (_) {
    return { triggered: false, reason: 'assess_error' };
  }
}

// ---------------------------------------------------------------------------
// Trigger 2: marker-shaped token no known relation can resolve
// ---------------------------------------------------------------------------
const CLOSED_CONNECTIVES = new Set([
  'however', 'nevertheless', 'nonetheless', 'therefore', 'hence', 'thus',
  'instead', 'otherwise', 'meanwhile', 'furthermore', 'moreover',
  'consequently', 'accordingly', 'likewise', 'besides', 'anyway', 'still',
]);

function knownMarkerSet() {
  const out = new Set();
  try {
    for (const c of getSem().CONSTRUCTIONS || []) {
      for (const f of c.families || []) {
        for (const m of f.markers || []) out.add(String(m).toLowerCase());
      }
    }
  } catch (_) { /* empty set: everything is unknown, still safe */ }
  return out;
}

function isMarkerShaped(word) {
  const w = String(word || '').toLowerCase();
  if (w.length >= 6 && /ly$/.test(w) && /^[a-z']+$/.test(w)) return true;
  return CLOSED_CONNECTIVES.has(w);
}

// A marker-shaped token in marker position that no construction parses.
// Returns {marker, order, text} or null. Never triggers on parsed text.
function detectUnresolvedMarker(text) {
  try {
    const sem = getSem();
    const src = String(text || '').trim();
    if (src.length < 8) return null;
    if (sem.parseAnyConstruction(src)) return null; // some relation owns it
    const known = knownMarkerSet();
    const stripped = src.replace(/[.!?]+$/, '');
    // Front position: "<word> <rest with a comma>"
    const fm = /^([A-Za-z']+)\s+(.+)$/.exec(stripped);
    if (fm && /[,]/.test(fm[2]) && isMarkerShaped(fm[1]) && !known.has(fm[1].toLowerCase())) {
      return { marker: fm[1].toLowerCase(), order: 'front', text: src.slice(0, 200) };
    }
    // Mid position: ", <word> ..." / "; <word> ..."
    const mm = /[,;]\s+([A-Za-z']+)\s+\S/.exec(stripped);
    if (mm && isMarkerShaped(mm[1]) && !known.has(mm[1].toLowerCase())) {
      return { marker: mm[1].toLowerCase(), order: 'mid', text: src.slice(0, 200) };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Accumulate unresolved-marker sightings on the model. Research readiness at
// MIN_UNRESOLVED_EXAMPLES examples (mirrors induction's MIN_EXAMPLES).
function noteUnresolvedMarker(model, text, opts) {
  try {
    const hit = detectUnresolvedMarker(text);
    if (!hit) return { noted: false, reason: 'no_unresolved_marker' };
    const s = ensureBridgeSection(model);
    if (!s) return { noted: false, reason: 'no_model' };
    const slot = s.unresolvedMarkers[hit.marker] || { order: hit.order, examples: [], repaired: false };
    if (!slot.examples.includes(hit.text)) slot.examples.push(hit.text.slice(0, 200));
    while (slot.examples.length > 4) slot.examples.shift();
    slot.order = hit.order;
    s.unresolvedMarkers[hit.marker] = slot;
    logTrigger(model, {
      kind: 'unresolved_marker_seen', marker: hit.marker, order: hit.order,
      reason: 'marker_shaped_token_no_relation_parses', examples: slot.examples.length,
    }, opts);
    return {
      noted: true, marker: hit.marker, order: hit.order,
      examples: slot.examples.length,
      ready: slot.examples.length >= MIN_UNRESOLVED_EXAMPLES && !slot.repaired,
    };
  } catch (_) {
    return { noted: false, reason: 'note_error' };
  }
}

// ---------------------------------------------------------------------------
// Trigger 3: grounding gap — relation-seeking question, nothing grounded
// ---------------------------------------------------------------------------
const GAP_FAMILY = {
  why: 'cause',
  what_caused: 'cause',
  contrast_confirm: 'contrast',
  conditional_q: 'condition',
};

function assessGroundingGap(gap) {
  try {
    const kind = gap && gap.kind;
    const family = GAP_FAMILY[kind];
    if (!family) return { triggered: false, reason: 'not_relation_seeking', kind: kind || null };
    if (gap.grounded) return { triggered: false, reason: 'grounded_no_gap', kind };
    return {
      triggered: true, kind: 'grounding_gap', questionKind: kind, family,
      question: String(gap.question || '').slice(0, 300),
      reason: 'relation_seeking_question_no_operator_fired',
    };
  } catch (_) {
    return { triggered: false, reason: 'assess_error' };
  }
}

// ---------------------------------------------------------------------------
// Research question formulation (deterministic templates)
// ---------------------------------------------------------------------------
const FAMILY_ADJECTIVE = {
  cause: 'causal', contrast: 'contrastive', condition: 'conditional',
  counterfactual: 'counterfactual conditional', purpose: 'purpose',
  concession: 'concessive',
};

function formulateQuestions(trigger) {
  const qs = [];
  if (!trigger || !trigger.triggered) return qs;
  if (trigger.kind === 'unknown_truth' || trigger.kind === 'unresolved_marker') {
    const m = String(trigger.marker || '').trim();
    if (m) qs.push(`What does the discourse marker '${m}' signal in a sentence?`);
  } else if (trigger.kind === 'family_gap') {
    const adj = FAMILY_ADJECTIVE[trigger.family];
    if (adj) qs.push(`What is a ${adj} construction?`);
    else if (trigger.marker) qs.push(`What does the discourse marker '${trigger.marker}' signal in a sentence?`);
  }
  return qs;
}

// Default research path: the EXISTING Wikipedia-backed research machinery.
// Tests inject a stub via opts.researchFn. researchFn(question) ->
// Promise<{sentences: string[], sources: string[]}>.
async function defaultResearch(question) {
  const mod = getResearch();
  const res = await mod.researchTopic(String(question || ''), []);
  return { sentences: res.sentences || [], sources: res.sources || [] };
}

// ---------------------------------------------------------------------------
// Truth-condition distillation: definitional-pattern mapper
//
// Maps researched definitional sentences to per-role boolean truth.
// a = first/left span, b = second/right span (matches discovered spec roles).
// If no pattern matches, or the sentence hedges (may-or-may-not /
// hypothetical / uncertain), truth stays UNKNOWN: honest, never guessed.
// A sentence only counts if it mentions the marker (inflection-tolerant).
// ---------------------------------------------------------------------------
const TRUTH_PATTERNS = [
  {
    name: 'concession_both_true',
    res: [
      /\bconced\w*\b[^.]{0,80}\b(contrast\w*|opposing)\b/i,
      /\backnowledg\w*\b[^.]{0,80}\b(contrast\w*|fact)\b/i,
      /\bboth\b[^.]{0,60}\b(true|asserted|presented as true)\b/i,
      /\bconcessive\b[^.]{0,80}\b(true|asserted)\b/i,
    ],
    truth: { a: true, b: true },
  },
  {
    name: 'prevention_b_false',
    res: [
      /\bprevent\w*\b[^.]{0,60}\bfrom\b[^.]{0,40}\b(happen\w*|occurr\w*|taking place)\b/i,
      /\b(stopp\w*|keep\w*|block\w*|hinder\w*)\b[^.]{0,40}\b\w+\b[^.]{0,40}\bfrom\b[^.]{0,40}\b(happen\w*|occurr\w*)\b/i,
      /\bprevent\w*\b[^.]{0,80}\b(did not|does not|never)\b[^.]{0,30}\b(happen|occur|take place)\b/i,
      /\bkeeps?\b[^.]{0,40}\ban event\b[^.]{0,40}\bfrom\b[^.]{0,40}\boccurr\w*\b/i,
    ],
    truth: { a: true, b: false },
  },
  {
    name: 'counterfactual_both_false',
    res: [
      /\bcontrary to fact\b/i,
      /\bwhat\b[^.]{0,40}\b(did not|would not|never)\b[^.]{0,30}\bhappen\b/i,
      /\bdescribes?\b[^.]{0,60}\b(that|which)\b[^.]{0,30}\b(did not|never)\b[^.]{0,30}\b(happen|occur)\b/i,
    ],
    truth: { a: false, b: false },
  },
  {
    name: 'cause_both_true',
    res: [
      /\bcause\b[^.]{0,40}\b(brings? about|produces?|leads? to)\b[^.]{0,40}\beffect\b/i,
      /\bcausal\b[^.]{0,80}\b(true|asserted)\b/i,
      /\bthe reason\b[^.]{0,40}\b(true|given)\b[^.]{0,40}\bconclusion\b[^.]{0,40}\b(true|follows)\b/i,
      /\bboth\b[^.]{0,40}\b(cause|reason)\b[^.]{0,20}\band\b[^.]{0,20}\b(effect|result|conclusion)\b[^.]{0,20}\b(true|asserted|follow)/i,
    ],
    truth: { a: true, b: true },
  },
  {
    name: 'temporal_both_true',
    res: [
      /\bone event\b[^.]{0,40}\b(follows?|precedes?)\b[^.]{0,40}\banother\b/i,
      /\bboth events\b[^.]{0,40}\b(occurred|happened|took place)\b/i,
    ],
    truth: { a: true, b: true },
  },
  {
    name: 'comparison_both_true',
    res: [
      /\bcompar\w*\b[^.]{0,60}\b(one|entity)\b[^.]{0,40}\b(exceeds?|greater than|more than)\b[^.]{0,40}\banother\b/i,
    ],
    truth: { a: true, b: true },
  },
];
// Hedged / non-boolean semantics: never assign boolean truth here.
const NON_BOOLEAN_GUARD = /\bmay or may not\b|\bhypothetical\b|\buncertain\b/i;

function markerMentionRe(marker) {
  const m = String(marker || '').toLowerCase().replace(/[^a-z]/g, '');
  if (m.length < 2) return null;
  const prefix = m.slice(0, Math.min(m.length, Math.max(4, m.length - 3)));
  return new RegExp(`\\b${prefix}\\w*\\b`, 'i');
}

// distillTruth(sentences, marker, opts) ->
//   {matched:true, truth:{a,b}, pattern, sentence, source} |
//   {matched:false, reason}
function distillTruth(sentences, marker, opts) {
  try {
    const mention = markerMentionRe(marker);
    if (!mention) return { matched: false, reason: 'bad_marker' };
    const list = Array.isArray(sentences) ? sentences : [];
    for (const item of list) {
      const sentence = typeof item === 'string' ? item : (item && item.sentence) || '';
      const source = typeof item === 'string' ? (opts && opts.source) || '' : (item && item.source) || '';
      if (!sentence || !mention.test(sentence)) continue;
      if (NON_BOOLEAN_GUARD.test(sentence)) continue; // hedged: stay honest
      const hits = TRUTH_PATTERNS.filter(pat => pat.res.some(re => re.test(sentence)));
      if (hits.length > 1) {
        // The definition matches patterns with different truth tables:
        // ambiguous -> honest no-match, never a guess.
        const truths = new Set(hits.map(h => JSON.stringify(h.truth)));
        if (truths.size > 1) return { matched: false, reason: 'contradictory_definition' };
      }
      if (hits.length) {
        const pat = hits[0];
        return {
          matched: true,
          truth: { a: pat.truth.a, b: pat.truth.b },
          pattern: pat.name,
          sentence: sentence.slice(0, 300),
          source: String(source || '').slice(0, 300),
        };
      }
    }
    return { matched: false, reason: 'no_definitional_pattern_matched' };
  } catch (_) {
    return { matched: false, reason: 'distill_error' };
  }
}

// ---------------------------------------------------------------------------
// Hidden-transfer synthesis (seeded; vocab disjoint from any corpus pool)
// ---------------------------------------------------------------------------
const TRANSFER_PAIRS = [
  ['the dam', 'cracked'], ['the valley', 'flooded'], ['the quarterback', 'was injured'],
  ['the volcano', 'erupted'], ['the village', 'evacuated'], ['the orchard', 'froze'],
  ['the lighthouse', 'flickered'], ['the antenna', 'snapped'], ['the reservoir', 'emptied'],
  ['the tunnel', 'collapsed'], ['the harvest', 'failed'], ['the beacon', 'dimmed'],
];
const TRANSFER_AGENTS = ['the warden', 'the medic', 'the sentry', 'the engineer', 'the captain', 'the ranger'];
const TRANSFER_TARGETS = ['the riot', 'the infection', 'the breach', 'the collision', 'the blackout', 'the stampede'];

function cap1(s) {
  const t = String(s || '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function synthesizeTransfers(marker, order, n, seed) {
  const rnd = getDisc().mulberry32(seed == null ? 918273 : seed);
  const out = [];
  const used = new Set();
  let guard = 0;
  while (out.length < n && guard++ < n * 50) {
    const i1 = Math.floor(rnd() * TRANSFER_PAIRS.length);
    const i2 = Math.floor(rnd() * TRANSFER_PAIRS.length);
    if (i1 === i2) continue;
    const [s1, e1] = TRANSFER_PAIRS[i1];
    const [s2, e2] = TRANSFER_PAIRS[i2];
    const key = `${s1}|${e1}|${s2}|${e2}|${order}`;
    if (used.has(key)) continue;
    used.add(key);
    if (order === 'front') {
      out.push({
        text: `${cap1(marker)} ${s1} ${e1}, ${s2} ${e2}.`,
        ka: `${s1} ${e1}`.replace(/^the /, ''), kb: `${s2} ${e2}`.replace(/^the /, ''),
      });
    } else {
      const a = TRANSFER_AGENTS[Math.floor(rnd() * TRANSFER_AGENTS.length)];
      const o = TRANSFER_TARGETS[Math.floor(rnd() * TRANSFER_TARGETS.length)];
      out.push({
        text: `${cap1(a)} ${e1} ${marker} ${s2} ${e2}.`,
        ka: `${a} ${e1}`.replace(/^the /, ''), kb: `${s2} ${e2}`.replace(/^the /, ''),
      });
    }
  }
  return out;
}

function rolesInclude(fired, ka, kb) {
  try {
    const a = String((fired.roles || {}).a || '').toLowerCase();
    const b = String((fired.roles || {}).b || '').toLowerCase();
    return a.includes(String(ka).toLowerCase()) && b.includes(String(kb).toLowerCase());
  } catch (_) { return false; }
}

function negativeControls(marker, order) {
  if (order === 'front') {
    return [
      'The dam cracked and the valley flooded.',
      `The dam cracked, ${marker} the valley flooded.`,
      `${cap1(marker)} the dam cracked.`,
      'Hello world.',
    ];
  }
  return [
    'The warden stopped the riot.',
    `${cap1(marker)} the warden the riot.`,
    'The warden prevented.',
    'Hello world.',
  ];
}

// ---------------------------------------------------------------------------
// 7-gate re-qualification for a researched truth table.
// Operates on a SCRATCH model only. Registration rolls back on any failure.
// ---------------------------------------------------------------------------
function relationNameFor(marker) {
  return 'disc_' + String(marker).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function qualifyCandidate(cand, truthInfo, opts) {
  const gates = [];
  const gate = (name, ok, detail) => { gates.push({ name, ok: !!ok, detail: detail || '' }); return !!ok; };
  const sem = getSem();
  const disc = getDisc();
  try {
    const marker = String((cand.markers && cand.markers[0]) || '').toLowerCase();
    if (!marker) { gate('input', false, 'no marker'); return { qualified: false, gates }; }
    if (!truthInfo || !truthInfo.truth ||
        typeof truthInfo.truth.a !== 'boolean' || typeof truthInfo.truth.b !== 'boolean') {
      gate('input', false, 'truth not boolean');
      return { qualified: false, gates };
    }
    const relation = relationNameFor(marker);
    const order = cand.order === 'mid' ? 'mid' : 'front';
    const trainTexts = (cand.instances || []).slice(0, 2).map(i => i.text);
    if (trainTexts.length < 2) { gate('input', false, 'need 2 training instances'); return { qualified: false, gates }; }
    const transfers = synthesizeTransfers(marker, order, 10, (opts && opts.seed) || 918273);
    const negatives = negativeControls(marker, order);

    // Gate 1: baseline novelty — nothing parses these surfaces pre-registration,
    // and the discovered family registers cleanly.
    const g1 = [...trainTexts, ...transfers.map(t => t.text)]
      .every(t => sem.parseAnyConstruction(t) === null);

    // Register the discovered family (rollback on any later failure).
    const beforeLen = sem.CONSTRUCTIONS.length;
    const rollback = () => { sem.CONSTRUCTIONS.length = beforeLen; };
    let reg;
    if (sem.CONSTRUCTIONS.some(c => c.relation === relation)) {
      reg = { registered: true, already: true };
    } else {
      const spec = disc.buildDiscoveredSpec({
        status: 'pending',
        truth: { a: truthInfo.truth.a, b: truthInfo.truth.b },
        markers: [marker],
        order,
        boundary: cand.boundary || (order === 'front' ? 'comma' : 'none'),
        roleNames: ['a', 'b'],
        supportDialogues: cand.supportDialogues || 0,
        instances: (cand.instances || []).length,
      });
      if (!spec) { gate('baseline (novelty)', false, 'buildDiscoveredSpec refused'); return { qualified: false, gates }; }
      reg = disc.registerSpec(spec);
    }
    if (!gate('baseline (novelty)', g1 && reg.registered === true,
      `novel=${g1} spec=${reg.already ? 'already_registered' : relation}`)) {
      rollback(); return { qualified: false, gates };
    }

    // Gate 2: training — two instances induce exactly one record.
    const model = {};
    let recordId = null;
    for (const t of trainTexts) {
      const r = sem.noteCandidate(model, { text: t, source: 'semantic_research_bridge' });
      if (r.induced) recordId = r.recordId;
    }
    const section = model[sem.SECTION] || {};
    const entries = (section.entries || []).filter(e =>
      e && e.payload && e.payload.operatorAst && e.payload.operatorAst.relation === relation);
    const oneRecord = entries.length === 1;
    const markersOk = oneRecord &&
      JSON.stringify(entries[0].payload.operatorAst.markers) === JSON.stringify([marker]);
    const truthOk = oneRecord &&
      entries[0].payload.operatorAst.truth.a === truthInfo.truth.a &&
      entries[0].payload.operatorAst.truth.b === truthInfo.truth.b;
    const trainParse = trainTexts.every(t => {
      const f = sem.matchOperators(t, model);
      return f && f.relation === relation && f.marker === marker;
    });
    if (!gate('training (induction)', oneRecord && markersOk && truthOk && trainParse,
      `records=${entries.length} truth=${JSON.stringify(oneRecord && entries[0].payload.operatorAst.truth)}`)) {
      rollback(); return { qualified: false, gates };
    }

    // Gate 3: hidden transfer — 10 unseen-vocabulary examples.
    let hits = 0;
    const misses = [];
    for (const tr of transfers) {
      const f = sem.matchOperators(tr.text, model);
      if (f && f.relation === relation && rolesInclude(f, tr.ka, tr.kb)) hits++;
      else misses.push(`${tr.text} [got ${f ? f.relation : 'null'}]`);
    }
    if (!gate('hidden transfer', hits === transfers.length,
      `${hits}/${transfers.length}${misses.length ? ' MISS: ' + misses.slice(0, 2).join(' | ') : ''}`)) {
      rollback(); return { qualified: false, gates };
    }

    // Gate 4: negative controls refuse.
    let negOk = 0;
    const negBad = [];
    for (const nx of negatives) {
      const f = sem.matchOperators(nx, model);
      if (f === null) negOk++;
      else negBad.push(`${nx} [got ${f.relation}/${f.marker}]`);
    }
    if (!gate('negative controls', negOk === negatives.length,
      `${negOk}/${negatives.length}${negBad.length ? ' BAD: ' + negBad.join(' | ') : ''}`)) {
      rollback(); return { qualified: false, gates };
    }

    // Gate 5: cold reload — scratch model + spec file round-trip in a child.
    const scratchDir = (opts && opts.scratchDir) || path.join(process.env.HOME || '/tmp', 'workspace', 'scratch', 'lari-semantic-research');
    try { fs.mkdirSync(scratchDir, { recursive: true }); } catch (_) { /* ignore */ }
    const modelPath = path.join(scratchDir, `cold-${relation}.json`);
    const specPath = path.join(scratchDir, `cold-${relation}.specs.json`);
    let coldHits = -1;
    try {
      fs.writeFileSync(modelPath, JSON.stringify(model));
      disc.saveDiscoveredSpecs(specPath);
      const childSrc = `
        const fs = require('fs');
        const sem = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lari_semantic_induction.js'))});
        const disc = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lari_construction_discovery.js'))});
        disc.loadDiscoveredSpecs(${JSON.stringify(specPath)});
        const model = JSON.parse(fs.readFileSync(${JSON.stringify(modelPath)}, 'utf8'));
        const texts = ${JSON.stringify(transfers.slice(0, 3).map(t => t.text))};
        const kw = ${JSON.stringify(transfers.slice(0, 3).map(t => ({ a: t.ka, b: t.kb })))};
        let hits = 0;
        texts.forEach((text, i) => {
          const f = sem.matchOperators(text, model);
          if (f && f.relation === ${JSON.stringify(relation)} &&
              String((f.roles||{}).a).toLowerCase().includes(kw[i].a) &&
              String((f.roles||{}).b).toLowerCase().includes(kw[i].b)) hits++;
        });
        console.log('COLD_HITS=' + hits);
      `;
      const out = execFileSync('node', ['-e', childSrc], { cwd: ROOT, timeout: 60000 }).toString();
      const m = /COLD_HITS=(\d+)/.exec(out);
      coldHits = m ? parseInt(m[1], 10) : -1;
    } catch (_) { coldHits = -1; }
    if (!gate('cold reload', coldHits === 3, `${coldHits}/3 after restart + spec reload`)) {
      rollback(); return { qualified: false, gates };
    }

    // Gate 6: exact ablation — record removed -> capability gone, others intact.
    const ablated = JSON.parse(JSON.stringify(model));
    ablated[sem.SECTION].entries = ablated[sem.SECTION].entries.filter(e => e.id !== recordId);
    const gone = [...trainTexts, ...transfers.slice(0, 3).map(t => t.text)]
      .every(t => sem.matchOperators(t, ablated) === null);
    if (!gate('exact ablation', gone, 'record removed -> zero parses')) {
      rollback(); return { qualified: false, gates };
    }

    // Gate 7: bridge regression — previously qualified bridge operators intact.
    // Priors get minimal active records injected into the scratch model so
    // matchOperators can actually fire them (records live in models, not in
    // the process-global construction registry).
    let regOk = true;
    const regBad = [];
    const priors = ((opts && opts.priorQualified) || []).filter(p => p && p.relation && p.marker);
    if (priors.length) {
      const sec7 = model[sem.SECTION] || (model[sem.SECTION] = {});
      sec7.entries = Array.isArray(sec7.entries) ? sec7.entries : [];
      priors.forEach((p, i) => {
        sec7.entries.push({
          id: `bridge_prior_${i}_${p.relation}`,
          type: 'operator',
          status: 'active',
          confidence: 0.9,
          normalizedTriggers: [String(p.marker).toLowerCase()],
          payload: {
            operation: 'language.semantic_operator',
            operatorAst: {
              kind: 'lari.semantic_operator',
              relation: p.relation,
              markers: [String(p.marker).toLowerCase()],
              surfaceOrders: [p.order === 'mid' ? 'marker_mid' : 'marker_first'],
              roles: ['a', 'b'],
              truth: p.truth && typeof p.truth.a === 'boolean'
                ? { a: p.truth.a, b: p.truth.b } : { a: true, b: true },
            },
          },
        });
      });
    }
    for (const prior of priors) {
      const f = sem.matchOperators(prior.exampleText, model);
      if (!(f && f.relation === prior.relation)) { regOk = false; regBad.push(prior.relation); }
    }
    if (!gate('regression (bridge priors)', regOk, regBad.length ? 'BROKE: ' + regBad.join(',') : `${((opts && opts.priorQualified) || []).length} priors intact`)) {
      rollback(); return { qualified: false, gates };
    }

    // Success: attach truth provenance to the record.
    const record = entries[0];
    try {
      record.provenance = record.provenance || {};
      record.provenance.truthSource = {
        repairKind: 'researched_truth',
        researchQuestion: truthInfo.researchQuestion || '',
        article: truthInfo.source || '',
        sentence: truthInfo.sentence || '',
        pattern: truthInfo.pattern || '',
        researchedAt: nowIso(opts),
      };
    } catch (_) { /* provenance best-effort */ }
    return { qualified: true, relation, recordId, record, gates, model };
  } catch (err) {
    gate('exception', false, String((err && err.message) || err).slice(0, 120));
    return { qualified: false, gates };
  }
}

// ---------------------------------------------------------------------------
// Full repair pipeline: trigger -> research -> distill -> qualify.
// Never throws; every outcome is logged.
// ---------------------------------------------------------------------------
async function repairUnknownTruth(candidate, model, opts) {
  const o = opts || {};
  try {
    const trigger = assessDiscoveryTrigger(candidate);
    if (!trigger.triggered) {
      return { ok: false, reason: trigger.reason, researched: false };
    }
    // Idempotent: this marker's family already qualified earlier in this
    // process. No re-research, no duplicate registration; report the
    // deterministic record id so reruns agree exactly.
    const sem0 = getSem();
    const relation0 = relationNameFor(trigger.marker);
    const fam0 = sem0.CONSTRUCTIONS.find(c => c.relation === relation0);
    if (fam0) {
      const t0 = (fam0.families && fam0.families[0] && fam0.families[0].truth) || null;
      const truth0 = t0 ? { a: !!t0.a, b: !!t0.b } : null;
      const recordId0 = deterministicRecordId(relation0, trigger.marker, trigger.order);
      logRepair(model, { kind: trigger.kind, marker: trigger.marker, qualified: true, reason: 'already_repaired', relation: relation0 }, o);
      return {
        ok: true, reason: 'already_repaired', researched: false,
        relation: relation0, recordId: recordId0,
        distilled: truth0 ? { matched: true, truth: truth0, pattern: 'previously_qualified' } : null,
        prior: {
          relation: relation0, marker: trigger.marker, order: trigger.order,
          exampleText: (trigger.instances[0] && trigger.instances[0].text) || '',
          truth: truth0,
        },
        qual: { qualified: true, relation: relation0, recordId: recordId0, gates: [], model },
      };
    }
    const questions = formulateQuestions(trigger);
    if (!questions.length) {
      logTrigger(model, { kind: trigger.kind, marker: trigger.marker, reason: 'no_question_formulated' }, o);
      return { ok: false, reason: 'no_question_formulated', researched: false };
    }
    const researchFn = o.researchFn || defaultResearch;
    const researched = [];
    for (const q of questions) {
      let res;
      try {
        res = await researchFn(q);
      } catch (err) {
        logTrigger(model, { kind: trigger.kind, marker: trigger.marker, reason: 'research_error', error: String((err && err.message) || err).slice(0, 120) }, o);
        logRepair(model, { kind: trigger.kind, marker: trigger.marker, qualified: false, reason: 'research_error' }, o);
        return { ok: false, reason: 'research_error', researched: false };
      }
      researched.push({
        question: q,
        sentences: (res && res.sentences) || [],
        sources: (res && res.sources) || [],
      });
    }
    logTrigger(model, {
      kind: trigger.kind, marker: trigger.marker, order: trigger.order,
      reason: trigger.reason, questions,
      sentencesFound: researched.reduce((n, r) => n + r.sentences.length, 0),
    }, o);

    const allSentences = [];
    for (const r of researched) {
      for (const s of r.sentences) allSentences.push({ sentence: s, source: (r.sources[0] || '') });
    }
    const distilled = distillTruth(allSentences, trigger.marker, {});
    if (!distilled.matched) {
      logRepair(model, {
        kind: trigger.kind, marker: trigger.marker, qualified: false,
        reason: 'research_no_truth', questions,
        sentencesSeen: allSentences.length,
      }, o);
      return { ok: false, reason: 'research_no_truth', researched: true, questions, sentencesSeen: allSentences.length };
    }

    const qual = qualifyCandidate(
      {
        markers: [trigger.marker], order: trigger.order, boundary: trigger.boundary,
        instances: trigger.instances, supportDialogues: trigger.supportDialogues,
      },
      {
        truth: distilled.truth, pattern: distilled.pattern,
        sentence: distilled.sentence, source: distilled.source,
        researchQuestion: questions[0],
      },
      o
    );
    logRepair(model, {
      kind: trigger.kind, marker: trigger.marker, qualified: qual.qualified,
      reason: qual.qualified ? 'qualified' : 'gates_failed',
      gates: qual.gates.map(g => `${g.name}:${g.ok ? 'PASS' : 'FAIL'}`).join(' '),
      relation: qual.relation || null,
      pattern: distilled.pattern, sentence: distilled.sentence, source: distilled.source,
      researchQuestion: questions[0],
    }, o);
    if (qual.qualified) {
      try {
        const s = ensureBridgeSection(model);
        s.qualified.push({
          relation: qual.relation, marker: trigger.marker, order: trigger.order,
          exampleText: trigger.instances[0].text, truth: distilled.truth,
        });
      } catch (_) { /* ignore */ }
    }
    return {
      ok: qual.qualified, reason: qual.qualified ? 'qualified' : 'gates_failed',
      researched: true, questions, distilled, qual,
      prior: qual.qualified ? {
        relation: qual.relation, marker: trigger.marker, order: trigger.order,
        exampleText: trigger.instances[0].text, truth: distilled.truth,
      } : null,
    };
  } catch (err) {
    return { ok: false, reason: 'repair_error', researched: false };
  }
}

// Repair path for trigger 2: unresolved markers with >=2 examples.
async function maybeRepairUnresolvedMarkers(model, opts) {
  const o = opts || {};
  const out = [];
  try {
    const s = ensureBridgeSection(model);
    if (!s) return out;
    for (const marker of Object.keys(s.unresolvedMarkers).sort()) {
      const slot = s.unresolvedMarkers[marker];
      if (!slot || slot.repaired || slot.examples.length < MIN_UNRESOLVED_EXAMPLES) continue;
      const trigger = {
        triggered: true, kind: 'unresolved_marker', marker,
        order: slot.order || 'front',
        boundary: slot.order === 'mid' ? 'none' : 'comma',
        instances: slot.examples.map(t => ({ text: t })),
        supportDialogues: 0, reason: 'marker_shaped_token_no_relation_parses',
      };
      const questions = formulateQuestions(trigger);
      const researchFn = o.researchFn || defaultResearch;
      let researched = null;
      try {
        researched = await researchFn(questions[0]);
      } catch (_) { researched = null; }
      logTrigger(model, {
        kind: 'unresolved_marker', marker, order: slot.order,
        reason: 'research_attempt', questions,
        sentencesFound: researched ? (researched.sentences || []).length : 0,
      }, o);
      slot.repaired = true;
      if (!researched) {
        logRepair(model, { kind: 'unresolved_marker', marker, qualified: false, reason: 'research_error' }, o);
        out.push({ marker, ok: false, reason: 'research_error' });
        continue;
      }
      const all = (researched.sentences || []).map(sn => ({ sentence: sn, source: (researched.sources || [])[0] || '' }));
      const distilled = distillTruth(all, marker, {});
      if (!distilled.matched) {
        logRepair(model, { kind: 'unresolved_marker', marker, qualified: false, reason: 'research_no_truth', questions }, o);
        out.push({ marker, ok: false, reason: 'research_no_truth' });
        continue;
      }
      const qual = qualifyCandidate(
        { markers: [marker], order: slot.order || 'front', boundary: slot.order === 'mid' ? 'none' : 'comma', instances: slot.examples.map(t => ({ text: t })), supportDialogues: 0 },
        { truth: distilled.truth, pattern: distilled.pattern, sentence: distilled.sentence, source: distilled.source, researchQuestion: questions[0] },
        o
      );
      logRepair(model, {
        kind: 'unresolved_marker', marker, qualified: qual.qualified,
        reason: qual.qualified ? 'qualified' : 'gates_failed',
        gates: qual.gates.map(g => `${g.name}:${g.ok ? 'PASS' : 'FAIL'}`).join(' '),
        relation: qual.relation || null,
      }, o);
      if (qual.qualified) {
        try {
          s.qualified.push({
            relation: qual.relation, marker, order: slot.order || 'front',
            exampleText: slot.examples[0], truth: distilled.truth,
          });
        } catch (_) { /* ignore */ }
      }
      out.push({ marker, ok: qual.qualified, reason: qual.qualified ? 'qualified' : 'gates_failed', qual });
    }
  } catch (_) { /* never throw */ }
  return out;
}

// Convenience: discovery no longer just stops at UNKNOWN — repair what research can.
async function discoverAndRepair(dialogues, model, opts) {
  const o = opts || {};
  const disc = getDisc();
  const result = disc.discoverFromDialogues(dialogues);
  const repairs = [];
  const s = ensureBridgeSection(model);
  const priorQualified = s ? s.qualified.slice() : [];
  for (const cand of result.candidates || []) {
    if (cand.status !== 'unqualified_unknown_truth') continue;
    const r = await repairUnknownTruth(cand, model, Object.assign({}, o, {
      priorQualified: (ensureBridgeSection(model) || {}).qualified || priorQualified,
    }));
    repairs.push({ marker: (cand.markers || [])[0] || '?', ok: r.ok, reason: r.reason });
  }
  return { discovery: result, repairs };
}

// ---------------------------------------------------------------------------
// Trigger 3 repair: grounding gap -> research the FACT, note construction gap.
// The researched fact bundle is persisted into the CALLER-provided store
// (scratch in tests); the bridge never touches the live research store.
// ---------------------------------------------------------------------------
function persistResearchedFact(store, topic, sentences, sources, opts) {
  const cleanTopic = String(topic || '').trim();
  const cleanSentences = [...new Set((sentences || []).map(x => String(x || '').replace(/\s+/g, ' ').trim())
    .filter(x => x.length >= 25 && x.length <= 500))].slice(0, 40);
  if (!cleanTopic || !cleanSentences.length || !Array.isArray(store)) return 0;
  const existing = store.find(e => String(e.topic || '').toLowerCase() === cleanTopic.toLowerCase());
  if (existing) {
    const known = new Set(existing.sentences || []);
    let added = 0;
    for (const sn of cleanSentences) {
      if (!known.has(sn)) { existing.sentences.push(sn); known.add(sn); added++; }
    }
    existing.sentences = existing.sentences.slice(0, 60);
    for (const src of (sources || [])) {
      if (!existing.sources.includes(src)) existing.sources.push(src);
    }
    existing.researchedAt = nowIso(opts);
    return added;
  }
  store.push({
    topic: cleanTopic,
    sentences: cleanSentences,
    sources: [...new Set(sources || [])].slice(0, 6),
    researchedAt: nowIso(opts),
  });
  return cleanSentences.length;
}

async function repairGroundingGap(question, kind, model, opts) {
  const o = opts || {};
  try {
    const trigger = assessGroundingGap({ question, kind, grounded: false });
    const gap = { family: GAP_FAMILY[kind] || null, kind, question: String(question || '').slice(0, 200) };
    if (!trigger.triggered) {
      return { repaired: false, reason: trigger.reason, constructionGap: gap };
    }
    let topic = '';
    try { topic = getResearch().inferResearchTopic(question).topic || ''; } catch (_) { topic = ''; }
    logTrigger(model, {
      kind: 'grounding_gap', questionKind: kind, family: trigger.family,
      reason: trigger.reason, topic: topic || null,
    }, o);
    if (!topic) {
      return { repaired: false, reason: 'no_topic', constructionGap: gap };
    }
    const researchFn = o.researchFn || defaultResearch;
    let res;
    try {
      res = await researchFn(topic);
    } catch (err) {
      logRepair(model, { kind: 'grounding_gap', family: trigger.family, qualified: false, reason: 'research_error' }, o);
      return { repaired: false, reason: 'research_error', constructionGap: gap };
    }
    const store = o.knowledgeStore || null;
    const added = persistResearchedFact(store, (res && res.topic) || topic, (res && res.sentences) || [], (res && res.sources) || [], o);
    logRepair(model, {
      kind: 'grounding_gap', family: trigger.family, qualified: true,
      reason: 'fact_researched', topic, added,
      sentencesSeen: ((res && res.sentences) || []).length,
    }, o);
    return {
      repaired: true, topic, added,
      sentencesSeen: ((res && res.sentences) || []).length,
      constructionGap: gap,
    };
  } catch (_) {
    return { repaired: false, reason: 'repair_error', constructionGap: { family: null, kind, question: '' } };
  }
}

module.exports = {
  BRIDGE_SECTION,
  ensureBridgeSection,
  assessDiscoveryTrigger,
  detectUnresolvedMarker,
  noteUnresolvedMarker,
  assessGroundingGap,
  formulateQuestions,
  distillTruth,
  TRUTH_PATTERNS,
  synthesizeTransfers,
  qualifyCandidate,
  repairUnknownTruth,
  maybeRepairUnresolvedMarkers,
  discoverAndRepair,
  repairGroundingGap,
  persistResearchedFact,
  defaultResearch,
  deterministicRecordId,
  relationNameFor,
};
