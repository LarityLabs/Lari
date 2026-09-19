/**
 * Tests for nightly memory consolidation: belief extraction, contradiction
 * arbitration, idempotency, calibration-derived self-knowledge.
 *
 * Run: node scripts/test_lari_consolidation.js
 */
'use strict';

const miner = require('../swarm_discourse_miner.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function ep(id, summary, topics = [], importance = 0.7, daysAgo = 1) {
  return {
    id, summary, topics, importance, turnCount: 3,
    timestamp: new Date(Date.now() - daysAgo * 86400000).toISOString()
  };
}

function consolidate(model, episodes, scope = 'default') {
  return miner.consolidateUserMemory(model, scope, {
    getEpisodes: () => episodes
  });
}

// --- extraction ---
{
  const model = {};
  const episodes = [
    ep('e1', 'Discussed setup: remember that my deploy key is on the Dell. Also my timezone is America/New_York.', ['setup'], 0.8),
    ep('e2', 'Discussed movies: I really love old horror movies. I never watch reality TV.', ['movies'], 0.6),
    ep('e3', 'Discussed work: I work as a night shift nurse.', ['work'], 0.7)
  ];
  const report = consolidate(model, episodes);
  check('beliefs extracted', report.newBeliefs >= 4, JSON.stringify(report.newBeliefs));
  const texts = miner.getTopBeliefs(model, 'default', 20).map(b => b.text);
  check('directive captured', texts.some(t => /deploy key/i.test(t)), texts.join(' | '));
  check('identity captured', texts.some(t => /timezone/i.test(t)), texts.join(' | '));
  check('preference captured', texts.some(t => /horror/i.test(t)), texts.join(' | '));
  check('behavioral captured', texts.some(t => /never.*reality/i.test(t)), texts.join(' | '));
  check('provenance recorded', miner.getBeliefs(model).beliefs.every(b => (b.provenance || []).length > 0));
}

// --- contradiction arbitration: newer + confident wins, loser superseded ---
{
  const model = {};
  const oldEp = [ep('e1', 'Discussed setup: my timezone is America/Chicago.', ['setup'], 0.7, 20)];
  consolidate(model, oldEp);
  const newEp = [ep('e2', 'Discussed travel: my timezone is America/New_York now.', ['travel'], 0.7, 1)];
  const report = miner.consolidateUserMemory(model, 'default', { getEpisodes: () => newEp });
  check('contradiction superseded one belief', report.superseded === 1, JSON.stringify(report));
  const beliefs = miner.getBeliefs(model).beliefs;
  const active = beliefs.filter(b => b.status === 'active' && b.predicate === 'timezone');
  check('newer belief is the active one', active.length === 1 && /new_york/i.test(active[0].object), JSON.stringify(active.map(a => a.object)));
  const dead = beliefs.find(b => b.status === 'superseded');
  check('loser kept for audit with supersededBy', dead && dead.supersededBy === active[0].id, JSON.stringify(dead && dead.status));
}

// --- idempotency: second run merges, does not duplicate ---
{
  const model = {};
  const episodes = [ep('e1', 'Discussed setup: remember that my deploy key is on the Dell.', ['setup'], 0.8)];
  const r1 = consolidate(model, episodes);
  const r2 = consolidate(model, episodes);
  const active = miner.getBeliefs(model).beliefs.filter(b => b.status === 'active');
  check('no duplicate beliefs on re-run', active.length === r1.newBeliefs, `${active.length} vs ${r1.newBeliefs}`);
  check('re-run merges instead', r2.merged >= 1 && r2.newBeliefs === 0, JSON.stringify({ merged: r2.merged, new: r2.newBeliefs }));
}

// --- topic familiarity ---
{
  const model = {};
  const episodes = [
    ep('e1', 'Discussed fortnite: played with the crew.', ['fortnite'], 0.6),
    ep('e2', 'Discussed fortnite: new season dropped.', ['fortnite'], 0.6),
    ep('e3', 'Discussed fortnite: clipped a win.', ['fortnite'], 0.6)
  ];
  consolidate(model, episodes);
  const fam = miner.getTopBeliefs(model, 'default', 20).find(b => b.type === 'familiarity');
  check('recurring topic becomes familiarity belief', !!fam && /fortnite/i.test(fam.object), JSON.stringify(fam));
}

// --- calibration -> self-knowledge ---
{
  const model = {};
  const b = { discourseGoalOf: () => null, classifyIntent: (p) => 'explanation', getEpisodes: () => [] };
  for (let i = 0; i < 6; i++) {
    miner.noteTurn(model, { userMessage: `q${i}`, lariAnswer: 'a', intent: 'explanation' }, b);
    miner.noteTurn(model, { userMessage: 'not what I meant', lariAnswer: 'b', intent: 'explanation' }, b);
    miner.noteTurn(model, { userMessage: 'next', lariAnswer: 'c', intent: 'explanation' }, b);
  }
  const report = miner.consolidateUserMemory(model, 'default', { getEpisodes: () => [] });
  check('calibration belief distilled', report.calibrationBeliefs >= 1, JSON.stringify(report.calibrationBeliefs));
  const self = miner.getTopBeliefs(model, 'default', 20).find(x => x.type === 'self_knowledge');
  check('self-knowledge text is honest', !!self && /corrected/i.test(self.text), self && self.text);
}

// --- trivia never becomes a belief; cap respected ---
{
  const model = {};
  const episodes = [];
  for (let i = 0; i < 40; i++) {
    episodes.push(ep(`e${i}`, `Discussed thing${i}: remember that fact number ${i} about topic${i}.`, [`topic${i}`], 0.9));
  }
  consolidate(model, episodes);
  const active = miner.getBeliefs(model).beliefs.filter(x => x.status === 'active');
  check('belief store capped', active.length <= 100, active.length);
}

console.log(`\n${passed} passed, ${failed} failed${failures.length ? ' — ' + failures.join(', ') : ''}`);
process.exit(failed ? 1 : 0);
