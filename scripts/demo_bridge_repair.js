#!/usr/bin/env node
// demo_bridge_repair.js — one clean end-to-end narrative: discovery hits
// UNKNOWN truth, the bridge researches, distills, qualifies, and the new
// operator answers on unseen vocabulary. Deterministic; research stubbed.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const bridge = require(path.join(ROOT, 'scripts', 'lari_semantic_research.js'));
const sem = require(path.join(ROOT, 'scripts', 'lari_semantic_induction.js'));
const disc = require(path.join(ROOT, 'scripts', 'lari_construction_discovery.js'));

const PAIRS = [
  ['the bridge', 'collapsed'], ['the server', 'overheated'], ['the crew', 'departed'],
  ['the engine', 'stalled'], ['the river', 'overflowed'], ['the committee', 'adjourned'],
  ['the tower', 'swayed'], ['the valve', 'burst'], ['the forest', 'burned'],
  ['the orchard', 'froze'], ['the tunnel', 'caved'], ['the beacon', 'dimmed'],
];
function corpus() {
  const dialogues = [];
  let k = 0;
  for (let d = 0; d < 4; d++) {
    const turns = [];
    for (let i = 0; i < 3; i++) {
      const a = PAIRS[k % PAIRS.length], b = PAIRS[(k + 5) % PAIRS.length]; k++;
      turns.push({ speaker: 'user', text: `Admittedly ${a[0]} ${a[1]}, ${b[0]} ${b[1]}.` });
      turns.push({ speaker: 'user', text: 'The weather stayed mild that week.' });
    }
    dialogues.push({ id: d, turns });
  }
  return dialogues;
}

// Stubbed research: stands in for scripts/lari_research.js (Wikipedia path).
async function researchStub(q) {
  return {
    sentences: [
      "The discourse marker 'admittedly' concedes a point while asserting a contrasting claim; both the conceded point and the main claim are presented as true.",
    ],
    sources: ['https://en.wikipedia.org/wiki/Concession_(grammar)'],
  };
}

async function main() {
  const model = {};
  const res = disc.discoverFromDialogues(corpus());
  const cand = res.candidates.find(c => (c.markers || [])[0] === 'admittedly');
  console.log('1. discovery status:', cand.status, '(evidence withheld -> truth UNKNOWN)');

  const r = await bridge.repairUnknownTruth(cand, model, {
    researchFn: researchStub, clock: () => '2026-09-22T12:00:00.000Z', seed: 777,
  });
  console.log('2. research question:', r.questions[0]);
  console.log('3. distilled:', JSON.stringify(r.distilled.truth), 'via pattern', r.distilled.pattern);
  console.log('   source sentence:', r.distilled.sentence.slice(0, 90) + '...');
  console.log('4. gates:', r.qual.gates.map(g => `${g.name}=${g.ok ? 'PASS' : 'FAIL'}`).join(' | '));

  const f = sem.matchOperators('Admittedly the dam cracked, the valley flooded.', r.qual.model);
  console.log('5. unseen vocabulary fires:', f ? `${f.relation} roles=${JSON.stringify(f.roles)}` : 'null');

  const prov = r.qual.record.provenance.truthSource;
  console.log('6. provenance on record:', `pattern=${prov.pattern}`, `| article=${prov.article}`);
  console.log('7. verdict:', r.ok && r.qual.qualified ? 'REPAIRED — operator qualified' : 'FAILED');
}

main().catch(e => { console.error(e); process.exit(2); });
