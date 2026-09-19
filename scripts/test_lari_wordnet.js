/**
 * Tests for the native dictionary lane (WordNet define + wordMeanings enrichment).
 *
 * Run: node scripts/test_lari_wordnet.js
 */
'use strict';

const api = require('../swarm_model_runtime.js');
const wn = require('../swarm_wordnet_capability.js');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function freshModel() {
  const m = {};
  m.__lariSourcePath = null; // no checkpoint writes in tests
  return m;
}

(async () => {
  console.log('== wordnet module ==');
  check('dict loads', wn.isLoaded() === true);
  const goose = wn.define('goose');
  check('goose defined', goose.length > 0, String(goose.length));
  check('goose gloss mentions waterfowl/bird', /bird|waterfowl|web-footed/i.test(goose[0].gloss), goose[0] && goose[0].gloss.slice(0, 80));
  check('goose has hypernyms', goose[0].hypernyms.length > 0, JSON.stringify(goose[0].hypernyms));
  check('unknown word -> empty (honest)', wn.define('xyzzyplugh').length === 0);
  check('serendipity defined', wn.define('serendipity').length > 0);
  const enriched = wn.enrichContentWords('what is a goose doing near the river bank');
  check('enrichment finds goose', enriched.some(e => e.word === 'goose'), JSON.stringify(enriched.map(e => e.word)));

  console.log('== define lane ==');
  const d1 = await api.sendMessageToLariAsync(freshModel(), 'what is a goose', {});
  check('what is a goose -> answered_define', d1.action === 'answered_define', d1.action);
  check('goose answer has the definition', /web-footed/i.test(d1.answer || ''), (d1.answer || '').slice(0, 120));

  const d2 = await api.sendMessageToLariAsync(freshModel(), 'define serendipity', {});
  check('define serendipity -> answered_define', d2.action === 'answered_define', d2.action);
  check('serendipity answer has gloss', /good luck|accidental/i.test(d2.answer || ''), (d2.answer || '').slice(0, 120));

  const d3 = await api.sendMessageToLariAsync(freshModel(), 'what does quixotic mean?', {});
  check('what does quixotic mean -> answered_define', d3.action === 'answered_define', d3.action);

  const d4 = await api.sendMessageToLariAsync(freshModel(), "what's a river", {});
  check("what's a river -> answered_define", d4.action === 'answered_define', d4.action);

  console.log('== no hijacks ==');
  const n1 = await api.sendMessageToLariAsync(freshModel(), 'what is the capital of Ohio', {});
  check('capital-of-Ohio not hijacked by define', n1.action !== 'answered_define', n1.action);
  const n2 = await api.sendMessageToLariAsync(freshModel(), 'what time is it', {});
  check('time lane still wins its prompts', n2.action === 'answered_time', n2.action);
  const n3 = await api.sendMessageToLariAsync(freshModel(), 'what is 2+2', {});
  check('arithmetic still works', n3.action === 'answered_arithmetic', n3.action);
  const n4 = await api.sendMessageToLariAsync(freshModel(), 'what is a xyzzyplugh', {});
  check('unknown word falls through (no bluff)', n4.action !== 'answered_define', n4.action);
  const n5 = await api.sendMessageToLariAsync(freshModel(), 'tell me about geese', {});
  check('tell me about geese not treated as define', n5.action !== 'answered_define', n5.action);

  console.log('== wordMeanings enrichment ==');
  const e1 = await api.sendMessageToLariAsync(freshModel(), 'tell me about geese near the river', {});
  const wm = e1.languageUnderstanding && e1.languageUnderstanding.wordMeanings;
  check('wordMeanings attached to understanding', Array.isArray(wm) && wm.length > 0, JSON.stringify((wm || []).map(w => w.word)));
  check('goose meaning carried', (wm || []).some(w => w.word === 'goose' || w.word === 'geese'),
    JSON.stringify((wm || []).map(w => w.word)));

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failures.length) { console.log('Failures:', failures.join(', ')); process.exit(1); }
})().catch(e => { console.error('test error:', e); process.exit(1); });
