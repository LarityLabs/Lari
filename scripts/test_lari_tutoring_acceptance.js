#!/usr/bin/env node
'use strict';
// Final acceptance battery: replay the exact session-5 failures as scripted
// teach -> retest on a scratch model. All must pass.
const runtime = require('../swarm_model_runtime.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
async function ask(model, prompt) {
  const r = await runtime.sendMessageToLariAsync(model, { prompt }, { userScope: 'accept' });
  return { answer: String(r.answer || ''), action: r.action || (r.record && r.record.action) };
}
const LEAK = /public model API|head.to.head|h2h|GSM8K|baseline fixture|arena/i;

async function main() {
  const m = {};

  // 1. Singularity wrapper (session-5 T26/T28): wrapper must be stripped, fact served
  await ask(m, 'Lari is short for Singularity. remember that');
  await ask(m, 'naw man. Lari is short for Singularity. when I ask what the name means, say that. remember that');
  let r = await ask(m, 'what does the name Lari mean');
  check('singularity: answer contains Singularity', /singularity/i.test(r.answer), r.answer.slice(0, 100));
  check('singularity: wrapper NOT served verbatim', !/when I ask what the name means, say that/i.test(r.answer));

  // 2. Thesis via repaired-skill path + define lane (T8/T30/T36)
  await ask(m, 'the thesis is the swarm is the model. remember that');
  r = await ask(m, 'what is the thesis');
  check('thesis: answer contains swarm is the model', /swarm is the model/i.test(r.answer), `action=${r.action} :: ${r.answer.slice(0, 110)}`);
  check('thesis: not the dictionary definition', !/unproved statement put forward as a premise/i.test(r.answer));
  check('thesis: no internal-record leak', !LEAK.test(r.answer));

  // 3. Greg-questions relevance (T54/T56/T57/T58)
  await ask(m, 'yo, back again. Greg has published books on Amazon, including one called The Fracktal Verse Theory of Everything. remember that');
  await ask(m, 'Greg makes Fortnite content with his crew. remember that');
  await ask(m, 'Greg is building a home server on an old Dell Latitude. remember that');
  r = await ask(m, 'what books has Greg published');
  check('books: serves the books fact', /fracktal verse/i.test(r.answer), r.answer.slice(0, 110));
  check('books: not the home-server fact', !/dell latitude/i.test(r.answer));
  r = await ask(m, 'does Greg play fortnite');
  check('fortnite: serves the fortnite fact', /fortnite/i.test(r.answer), r.answer.slice(0, 110));

  // 4. Unrecognized-intent directive (D2: T18/T21)
  await ask(m, "when I ask if we're good just say 'all good man'");
  r = await ask(m, 'are we good');
  check("directive: 'are we good' -> 'all good man'", /^all good man\.?$/i.test(r.answer.trim()), r.answer.slice(0, 60));

  // 5. Why-built hallucination guard (T25/T29/T43)
  r = await ask(m, 'why did I build you');
  check('why-built: no stitched directive fragments', !/just say/i.test(r.answer), r.answer.slice(0, 110));

  // 6. Pinned regression: thanks -> anytime (survives this whole session)
  await ask(m, "when I say thanks just say 'anytime'");
  r = await ask(m, 'thanks');
  check("pinned: 'thanks' -> 'anytime'", /^anytime\.?$/i.test(r.answer.trim()), r.answer.slice(0, 60));

  // 7. Native lanes untouched
  r = await ask(m, 'what time is it');
  check('time lane intact', /\d{1,2}:\d{2}/.test(r.answer), r.answer.slice(0, 60));

  console.log(`\nACCEPTANCE: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
