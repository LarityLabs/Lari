#!/usr/bin/env node
/**
 * test_semantic_research.js — validation for the research bridge
 * (scripts/lari_semantic_research.js).
 *
 * All synthetic and deterministic. The research function is injected as a
 * stub; no network, no external model calls. Scratch models/corpora only.
 *
 * Phases:
 *  0. Mapper unit tests: 21 definitional sentences -> truth or honest no-match.
 *  1. Withheld-evidence: 4 constructions with dialogue evidence stripped to
 *     UNKNOWN; the bridge must learn truth via (stubbed) research matching
 *     the withheld ground truth, then qualify through all 7 gates.
 *  2. No-waste: 6 cases where no research should fire.
 *  3. Research-failure: 4 unresearchable markers -> honest UNKNOWN, nothing persists.
 *  4. Grounding-gap repair: fact researched + construction gap noted.
 *  5. Regressions: discovery 59/59, induction 131/131, battery 46/46,
 *     grounding 31/31 (subprocesses).
 *
 * Run: node scripts/test_semantic_research.js [--regressions]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const bridge = require(path.join(ROOT, 'scripts', 'lari_semantic_research.js'));
const sem = require(path.join(ROOT, 'scripts', 'lari_semantic_induction.js'));
const disc = require(path.join(ROOT, 'scripts', 'lari_construction_discovery.js'));

const RUN_REGRESSIONS = process.argv.includes('--regressions');
const FIXED_CLOCK = () => '2026-09-22T12:00:00.000Z';

let passed = 0, failed = 0;
const failures = [];
function gate(phase, name, ok, detail) {
  if (ok) { passed++; console.log(`PASS  ${phase}  ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; failures.push(`${phase}: ${name}`); console.log(`FAIL  ${phase}  ${name}${detail ? '  ' + detail : ''}`); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------------------------------------------------------------------------
// Phase 0: mapper unit tests
// ---------------------------------------------------------------------------
const MAPPER_CASES = [
  // concession_both_true
  { s: "The discourse marker 'admittedly' concedes a point while asserting a contrasting claim; both the conceded point and the main claim are presented as true.", m: 'admittedly', e: { a: true, b: true } },
  { s: "The word 'admittedly' acknowledges a contrasting fact without withdrawing the main assertion.", m: 'admittedly', e: { a: true, b: true } },
  { s: "'Nevertheless' signals a concessive contrast: the first clause is acknowledged as true and the second is asserted as true despite it.", m: 'nevertheless', e: { a: true, b: true } },
  // prevention_b_false
  { s: "To say 'A prevented B' means A stopped B from happening; A occurred but B did not happen.", m: 'prevented', e: { a: true, b: false } },
  { s: "Prevention keeps an event from occurring: the preventing action is real, but the prevented outcome never takes place.", m: 'prevented', e: { a: true, b: false } },
  // counterfactual_both_false
  { s: "A counterfactual conditional is contrary to fact: it describes what did not happen.", m: 'counterfactual', e: { a: false, b: false } },
  { s: "A counterfactual describes what would not happen if things were different; what is described never happened.", m: 'counterfactual', e: { a: false, b: false } },
  // cause_both_true
  { s: "'Hence' marks a causal relation: the reason given is true and the resulting conclusion follows as true.", m: 'hence', e: { a: true, b: true } },
  { s: "'Because' introduces a cause that brings about its effect; both the cause and the effect occur.", m: 'because', e: { a: true, b: true } },
  // temporal_both_true
  { s: "'After' indicates that one event follows another; both events occurred.", m: 'after', e: { a: true, b: true } },
  // comparison_both_true
  { s: "In 'taller than', the comparative states that one entity exceeds another in height; both entities exist.", m: 'than', e: { a: true, b: true } },
  // honest no-match cases
  { s: "Admittedly, the results may or may not hold under replication.", m: 'admittedly', e: 'no-match' },
  { s: "'If' introduces a hypothetical condition; what follows is uncertain.", m: 'if', e: 'no-match' },
  { s: "'To' in 'to win' expresses an intended goal.", m: 'to', e: 'no-match' },
  { s: "A concessive clause does not deny that both parts happened.", m: 'admittedly', e: 'no-match' },
  { s: "The weather was mild.", m: 'hence', e: 'no-match' },
  { s: "'Prevented' is the past tense of prevent.", m: 'prevented', e: 'no-match' },
  { s: "Researchers disagree about whether 'nevertheless' is formal or informal.", m: 'nevertheless', e: 'no-match' },
  { s: "'Hence' is an adverb of Latin origin.", m: 'hence', e: 'no-match' },
  { s: "She said that both options were true at the time.", m: 'hence', e: 'no-match' },
  { s: "'Unless' means 'except if'; the outcome depends on the condition.", m: 'unless', e: 'no-match' },
];

function phaseMapper() {
  console.log('\n=== phase 0: mapper unit tests ===');
  let i = 0;
  for (const c of MAPPER_CASES) {
    i++;
    const r = bridge.distillTruth([{ sentence: c.s, source: 'unit' }], c.m, {});
    const ok = c.e === 'no-match' ? r.matched === false : (r.matched === true && eq(r.truth, c.e));
    gate('mapper', `case ${i} (${r.matched ? r.pattern : 'no-match'})`, ok,
      ok ? '' : `expected ${JSON.stringify(c.e)} got ${JSON.stringify(r.matched ? r.truth : 'no-match')}`);
  }
}

// ---------------------------------------------------------------------------
// Stub research (deterministic, in-memory knowledge base)
// ---------------------------------------------------------------------------
const STUB_KB = {
  "what does the discourse marker 'admittedly' signal in a sentence?": {
    sentences: [
      "The discourse marker 'admittedly' concedes a point while asserting a contrasting claim; both the conceded point and the main claim are presented as true.",
      "In grammar, 'admittedly' marks a concessive relation: the speaker acknowledges a contrasting fact without denying it.",
    ],
    sources: ['https://en.wikipedia.org/wiki/Concession_(grammar)'],
  },
  "what does the discourse marker 'prevented' signal in a sentence?": {
    sentences: [
      "To say 'A prevented B' means A stopped B from happening; A occurred but B did not happen.",
      "Prevention keeps an event from occurring: the preventing action is real, the prevented outcome never takes place.",
    ],
    sources: ['https://en.wikipedia.org/wiki/Prevention'],
  },
  "what does the discourse marker 'nevertheless' signal in a sentence?": {
    sentences: [
      "'Nevertheless' signals a concessive contrast: the first clause is acknowledged as true and the second clause is asserted as true despite it.",
      "A concessive marker like 'nevertheless' concedes the preceding point while maintaining the contrasting claim.",
    ],
    sources: ['https://en.wikipedia.org/wiki/Concession_(grammar)'],
  },
  "what does the discourse marker 'hence' signal in a sentence?": {
    sentences: [
      "'Hence' marks a causal relation: the reason given is true and the resulting conclusion follows as true.",
      "In logic, 'hence' introduces a conclusion drawn from true premises; both the cause and the effect are asserted.",
    ],
    sources: ['https://en.wikipedia.org/wiki/Causality'],
  },
  "valley flood": {
    sentences: [
      "The valley flooded after the dam cracked in 1998, displacing hundreds of residents downstream.",
      "Engineers attributed the valley flood to structural failure of the aging dam.",
    ],
    sources: ['https://en.wikipedia.org/wiki/Flood'],
  },
};
let stubCalls = [];
async function stubResearch(q) {
  stubCalls.push(String(q));
  const hit = STUB_KB[String(q).trim().toLowerCase()];
  if (!hit) return { sentences: [], sources: [] };
  return { sentences: hit.sentences.slice(), sources: hit.sources.slice() };
}

// ---------------------------------------------------------------------------
// Withheld-evidence corpora (no outcome evidence -> UNKNOWN truth)
// ---------------------------------------------------------------------------
const CORPUS_PAIRS = [
  ['the bridge', 'collapsed'], ['the server', 'overheated'], ['the crew', 'departed'],
  ['the engine', 'stalled'], ['the river', 'overflowed'], ['the committee', 'adjourned'],
  ['the tower', 'swayed'], ['the valve', 'burst'], ['the forest', 'burned'],
  ['the orchard', 'froze'], ['the tunnel', 'caved'], ['the beacon', 'dimmed'],
];
const FILLERS = [
  'The weather stayed mild that week.',
  'Everyone arrived on time.',
  'The room was quiet and clean.',
  'The schedule looked reasonable.',
  'The lights were bright overhead.',
];
function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function frontCorpus(marker, seed) {
  const rnd = disc.mulberry32(seed);
  const idx = [...CORPUS_PAIRS.keys()];
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[idx[i], idx[j]] = [idx[j], idx[i]]; }
  const dialogues = [];
  let k = 0;
  for (let d = 0; d < 4; d++) {
    const turns = [];
    for (let i = 0; i < 3; i++) {
      const a = CORPUS_PAIRS[idx[k % idx.length]];
      const b = CORPUS_PAIRS[idx[(k + 5) % idx.length]];
      k++;
      turns.push({ speaker: 'user', text: `${cap1(marker)} ${a[0]} ${a[1]}, ${b[0]} ${b[1]}.` });
      turns.push({ speaker: 'user', text: FILLERS[(d * 3 + i) % FILLERS.length] });
    }
    dialogues.push({ id: d, turns });
  }
  return dialogues;
}

const PREVENT_AGENTS = ['The crew', 'The pilot', 'The clinic', 'The guard', 'The team', 'The staff'];
const PREVENT_OBJS = ['the blaze', 'the crash', 'the outbreak', 'the theft', 'the leak', 'the fire'];
function preventedCorpus(seed) {
  const rnd = disc.mulberry32(seed);
  const dialogues = [];
  let k = 0;
  for (let d = 0; d < 4; d++) {
    const turns = [];
    for (let i = 0; i < 3; i++) {
      const a = PREVENT_AGENTS[(k) % PREVENT_AGENTS.length];
      const o = PREVENT_OBJS[(k + 2) % PREVENT_OBJS.length];
      k++;
      turns.push({ speaker: 'user', text: `${a} prevented ${o}.` });
      turns.push({ speaker: 'user', text: FILLERS[(d * 3 + i) % FILLERS.length] });
    }
    dialogues.push({ id: d, turns });
    void rnd;
  }
  return dialogues;
}

const WITHHELD = [
  { marker: 'admittedly', order: 'front', truth: { a: true, b: true }, corpus: () => frontCorpus('admittedly', 101) },
  { marker: 'prevented', order: 'mid', truth: { a: true, b: false }, corpus: () => preventedCorpus(202) },
  { marker: 'nevertheless', order: 'front', truth: { a: true, b: true }, corpus: () => frontCorpus('nevertheless', 303) },
  { marker: 'hence', order: 'front', truth: { a: true, b: true }, corpus: () => frontCorpus('hence', 404) },
];

async function phaseWithheld() {
  console.log('\n=== phase 1: withheld-evidence (research -> truth -> gates) ===');
  const model = {};
  const priorQualified = [];
  const recordIds = {};
  for (const w of WITHHELD) {
    const label = `withheld:${w.marker}`;
    const corpus = w.corpus();
    const res = disc.discoverFromDialogues(corpus);
    const cand = (res.candidates || []).find(c => (c.markers || [])[0] === w.marker);
    gate(label, 'discovery proposes candidate', !!cand, cand ? `status=${cand.status}` : 'absent');
    if (!cand) continue;
    gate(label, 'truth is UNKNOWN (evidence withheld)', cand.status === 'unqualified_unknown_truth', `status=${cand.status}`);
    stubCalls = [];
    const r = await bridge.repairUnknownTruth(cand, model, {
      researchFn: stubResearch, clock: FIXED_CLOCK, seed: 777, priorQualified: priorQualified.slice(),
    });
    gate(label, 'research triggered', stubCalls.length === 1, `calls=${stubCalls.length}`);
    gate(label, 'distilled truth matches withheld ground truth',
      r.ok && r.distilled && r.distilled.matched && eq(r.distilled.truth, w.truth),
      r.distilled && r.distilled.matched ? `${JSON.stringify(r.distilled.truth)} via ${r.distilled.pattern}` : `reason=${r.reason}`);
    const allGates = r.qual && r.qual.gates ? r.qual.gates : [];
    const gatesOk = r.ok && allGates.length === 7 && allGates.every(g => g.ok);
    gate(label, 'all 7 gates pass', gatesOk,
      allGates.map(g => `${g.name}:${g.ok ? 'P' : 'F'}`).join(' '));
    if (r.ok) {
      recordIds[w.marker] = r.qual.recordId;
      if (r.prior) priorQualified.push(r.prior);
      const prov = r.qual.record && r.qual.record.provenance && r.qual.record.provenance.truthSource;
      gate(label, 'provenance stored on record', !!(prov && prov.sentence && prov.pattern && prov.researchQuestion),
        prov ? `pattern=${prov.pattern}` : 'missing');
      // Fires on unseen vocabulary in the qualification model.
      const demo = w.order === 'front'
        ? `${cap1(w.marker)} the dam cracked, the valley flooded.`
        : `The warden prevented the riot.`;
      const f = sem.matchOperators(demo, r.qual.model);
      gate(label, 'fires on unseen vocabulary', !!(f && f.relation === r.qual.relation),
        f ? `${f.relation}/${f.marker}` : 'null');
      // Exact ablation on the qualification model (gate 6 re-verified here).
      const ablated = JSON.parse(JSON.stringify(r.qual.model));
      ablated[sem.SECTION].entries = ablated[sem.SECTION].entries.filter(e => e.id !== r.qual.recordId);
      gate(label, 'ablation kills capability', sem.matchOperators(demo, ablated) === null, '');
    }
    // Determinism: rerunning the same repair is idempotent — no re-research,
    // same deterministic record id.
    stubCalls = [];
    const r2 = await bridge.repairUnknownTruth(cand, {}, {
      researchFn: stubResearch, clock: FIXED_CLOCK, seed: 777, priorQualified: [],
    });
    gate(label, 'deterministic record id', r2.ok && r2.recordId === recordIds[w.marker] && stubCalls.length === 0,
      r2.ok ? `${r2.reason} ${String(r2.recordId).slice(-8)}` : `reason=${r2.reason}`);
  }
  // discoverAndRepair convenience path on a fresh marker corpus.
  const m2 = {};
  stubCalls = [];
  const dr = await bridge.discoverAndRepair(frontCorpus('admittedly', 505), m2, {
    researchFn: stubResearch, clock: FIXED_CLOCK, seed: 777,
  });
  const rep = (dr.repairs || []).find(x => x.marker === 'admittedly');
  gate('discoverAndRepair', 'repairs unknown_truth automatically', !!(rep && rep.ok), rep ? rep.reason : 'no repair entry');
}

// ---------------------------------------------------------------------------
// Phase 2: no-waste — research must NOT fire
// ---------------------------------------------------------------------------
async function phaseNoWaste() {
  console.log('\n=== phase 2: no-waste ===');
  stubCalls = [];
  const model = {};
  // 1. resolved candidate: no trigger.
  const t1 = bridge.assessDiscoveryTrigger({ status: 'pending', markers: ['if'], truth: { a: 'conditional' } });
  gate('nowaste', 'resolved candidate: no trigger', t1.triggered === false, t1.reason);
  // 2. rediscovered candidate: no trigger.
  const t2 = bridge.assessDiscoveryTrigger({ status: 'rediscovered', markers: ['because'] });
  gate('nowaste', 'rediscovered candidate: no trigger', t2.triggered === false, t2.reason);
  // 3. text parsed by a seeded family: no unresolved marker.
  gate('nowaste', 'seeded parse: no unresolved marker',
    bridge.detectUnresolvedMarker('Because the dam cracked, the valley flooded.') === null, '');
  // 4. grounded question: no grounding gap.
  const t4 = bridge.assessGroundingGap({ question: 'why did the valley flood?', kind: 'why', grounded: true });
  gate('nowaste', 'grounded question: no gap', t4.triggered === false, t4.reason);
  // 5. paraphrase kind: not relation-seeking for research.
  const t5 = bridge.assessGroundingGap({ question: "so you're saying X?", kind: 'paraphrase', grounded: false });
  gate('nowaste', 'paraphrase kind: no gap', t5.triggered === false, t5.reason);
  // 6. unresolved marker seen once: logged, no research yet.
  const n1 = bridge.noteUnresolvedMarker(model, 'Consequently the bridge collapsed, the crew departed.', { clock: FIXED_CLOCK });
  gate('nowaste', 'single sighting: logged not researched', n1.noted === true && n1.ready === false, `examples=${n1.examples}`);
  const before = stubCalls.length;
  const n2 = bridge.noteUnresolvedMarker(model, 'Consequently the server overheated, the grid surged.', { clock: FIXED_CLOCK });
  gate('nowaste', 'second sighting: ready', n2.noted === true && n2.ready === true, '');
  await bridge.maybeRepairUnresolvedMarkers(model, { researchFn: stubResearch, clock: FIXED_CLOCK, seed: 888 });
  gate('nowaste', 'research ran once at readiness', stubCalls.length === before + 1, `calls=${stubCalls.length - before}`);
  await bridge.maybeRepairUnresolvedMarkers(model, { researchFn: stubResearch, clock: FIXED_CLOCK, seed: 888 });
  gate('nowaste', 'no repeat research after repair flag', stubCalls.length === before + 1, `calls=${stubCalls.length - before}`);
  gate('nowaste', 'zero stray research calls overall', stubCalls.length === 1, `total=${stubCalls.length}`);
}

// ---------------------------------------------------------------------------
// Phase 3: research failure — honest UNKNOWN, nothing persists
// ---------------------------------------------------------------------------
async function phaseResearchFailure() {
  console.log('\n=== phase 3: research failure (honest UNKNOWN) ===');
  const cases = [
    { marker: 'blorpt', sentences: [] },
    { marker: 'zqx', sentences: ['The weather was mild that week.'] },
    { marker: 'flum', sentences: ["'Flum' may or may not indicate anything at all."] },
    { marker: 'wug', sentences: ["'Wug' expresses an intended goal that might be achieved."] },
  ];
  for (const c of cases) {
    const label = `fail:${c.marker}`;
    const before = sem.CONSTRUCTIONS.length;
    const model = {};
    stubCalls = [];
    const cand = {
      markers: [c.marker], order: 'front', boundary: 'comma',
      status: 'unqualified_unknown_truth', supportDialogues: 3,
      _instances: [
        { text: `${cap1(c.marker)} the dam cracked, the valley flooded.` },
        { text: `${cap1(c.marker)} the server overheated, the grid surged.` },
      ],
      votes: null,
    };
    const r = await bridge.repairUnknownTruth(cand, model, {
      researchFn: async () => { stubCalls.push(c.marker); return { sentences: c.sentences.slice(), sources: [] }; },
      clock: FIXED_CLOCK, seed: 999,
    });
    gate(label, 'research attempted', stubCalls.length === 1, '');
    gate(label, 'honest UNKNOWN, not qualified', r.ok === false && r.reason === 'research_no_truth', `reason=${r.reason}`);
    gate(label, 'no construction registered', sem.CONSTRUCTIONS.length === before &&
      !sem.CONSTRUCTIONS.some(x => x.relation === 'disc_' + c.marker), '');
    const sec = model[bridge.BRIDGE_SECTION];
    gate(label, 'nothing qualified in bridge state', !sec || (sec.qualified || []).length === 0, '');
    gate(label, 'failure logged with trail', !!(sec && (sec.repairs || []).some(x => x.marker === c.marker && x.qualified === false)), '');
  }
}

// ---------------------------------------------------------------------------
// Phase 4: grounding-gap repair
// ---------------------------------------------------------------------------
async function phaseGroundingGap() {
  console.log('\n=== phase 4: grounding-gap repair ===');
  stubCalls = [];
  const model = {};
  const store = [];
  const r = await bridge.repairGroundingGap('Why did the valley flood?', 'why', model, {
    researchFn: stubResearch, knowledgeStore: store, clock: FIXED_CLOCK,
  });
  gate('gap', 'fact researched', r.repaired === true && r.topic === 'valley flood', `topic=${r.topic}`);
  gate('gap', 'persisted to caller store', store.length === 1 && store[0].sentences.length >= 1, `added=${r.added}`);
  gate('gap', 'construction gap noted', !!(r.constructionGap && r.constructionGap.family === 'cause' && r.constructionGap.kind === 'why'),
    JSON.stringify(r.constructionGap && r.constructionGap.family));
  const sec = model[bridge.BRIDGE_SECTION];
  gate('gap', 'trigger logged', !!(sec && (sec.triggers || []).some(t => t.kind === 'grounding_gap')), '');
  // no topic: honest, gap still noted.
  const r2 = await bridge.repairGroundingGap('Why?', 'why', model, {
    researchFn: stubResearch, knowledgeStore: store, clock: FIXED_CLOCK,
  });
  gate('gap', 'topicless question: honest no-research', r2.repaired === false && r2.reason === 'no_topic' &&
    !!(r2.constructionGap && r2.constructionGap.family === 'cause'), `reason=${r2.reason}`);
}

// ---------------------------------------------------------------------------
// Phase 5: regressions (subprocesses, fresh state)
// ---------------------------------------------------------------------------
function runNode(args, timeoutMs) {
  try {
    const out = execFileSync('node', args, { cwd: ROOT, timeout: timeoutMs || 600000 }).toString();
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String((e.stdout || '') + (e.stderr || '')).slice(-1500) };
  }
}

function phaseRegressions() {
  console.log('\n=== phase 5: regressions ===');
  const d = runNode([path.join(ROOT, 'scripts', 'test_construction_discovery.js')]);
  const dm = /==== RESULT: (\d+) passed, (\d+) failed ====/.exec(d.out || '');
  gate('regression', 'discovery harness 59/59 (incl. pristine 131 + battery 46)',
    d.ok && dm && dm[1] === '59' && dm[2] === '0', dm ? `${dm[1]}/${dm[2]}` : (d.out || '').slice(-200));
  const g = runNode([path.join(ROOT, 'scripts', 'test_answer_grounding.js'), '--harness', '--battery']);
  // The grounding runner prints "VERDICT: all gates passed." for the harness
  // and itself asserts 131/131 internally (it exits nonzero on any mismatch,
  // and g.ok is true here), so either summary form counts.
  const harnessOk = /131\/131 gates passed/.test(g.out || '') || /VERDICT: all gates passed/.test(g.out || '');
  gate('regression', 'grounding 31/31 + harness 131/131 + battery 46/46',
    g.ok && /VERDICT: all grounding tests passed/.test(g.out || '') && harnessOk && /TOTAL: 46\/46/.test(g.out || ''),
    (g.out || '').split('\n').filter(l => /VERDICT|gates passed|TOTAL/.test(l)).join(' | ').slice(-200));
}

// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(path.join(process.env.HOME || '/tmp', 'workspace', 'scratch', 'lari-semantic-research'), { recursive: true });
  phaseMapper();
  await phaseWithheld();
  await phaseNoWaste();
  await phaseResearchFailure();
  await phaseGroundingGap();
  if (RUN_REGRESSIONS) phaseRegressions();
  else console.log('\n(phase 5 regressions skipped; rerun with --regressions)');

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  const crypto = require('crypto');
  const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  console.log(`${sha(path.join(ROOT, 'scripts', 'lari_semantic_research.js'))}  scripts/lari_semantic_research.js`);
  console.log(`${sha(path.join(ROOT, 'scripts', 'test_semantic_research.js'))}  scripts/test_semantic_research.js`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log('VERDICT: research bridge qualified — unknown truth now routes to research, gates, or honest UNKNOWN.');
  }
}

main().catch(e => { console.error('TEST ERROR:', e && e.stack || e); process.exitCode = 2; });
