#!/usr/bin/env node
'use strict';

/**
 * Oracle for phrasings Lari learns by research.
 *
 * NOT a capability gate: fixed synthetic sources, checked properties. It cannot fail for capability
 * reasons and says nothing about how well Lari writes.
 *
 * What it pins is that this is learning rather than authoring. The phrasings come from prose the
 * generator did not write, a phrasing is retained only when independent sources attest it, what is
 * kept is a rule with citations rather than fitted parameters, and grounding still decides what may
 * be said regardless of how well attested the way of saying it is.
 */

const path = require('path');
const phrasing = require(path.join(__dirname, '..', 'swarm_phrasing_acquisition.js'));
const realization = require(path.join(__dirname, '..', 'swarm_claim_realization.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// Two independent sources that share a construction, and one that does not.
const sources = [
  { title: 'source A', accepted: true, text: 'The parser reads a total of 42 records from disk. It writes the report.name file when finished.' },
  { title: 'source B', accepted: true, text: 'A scanner collected a total of 91 samples overnight. Results land in the audit.log file when complete.' },
  { title: 'source C', accepted: true, text: 'Nothing here shares any construction with the others at all whatsoever.' }
];

console.log('phrasing acquisition');

const attested = phrasing.attestedPhrasings(sources, { minSources: 2, frame: 4 });
check('it learns constructions from prose it did not write', attested.length > 0, `${attested.length}`);
check('every retained construction is attested by at least two sources',
  attested.every(entry => entry.attestations >= 2), JSON.stringify(attested.map(a => a.attestations)));
check('a construction only one source uses is not attested',
  !attested.some(entry => /whatsoever/.test(entry.shape)));
check('constructions carry a typed slot rather than the original value',
  attested.every(entry => /\{NUMBER\}|\{NAME\}/.test(entry.shape)), JSON.stringify(attested.slice(0, 2)));
check('the values from the sources are not carried into the shape',
  !attested.some(entry => /\b42\b|\b91\b/.test(entry.shape)), JSON.stringify(attested.slice(0, 3)));

// Retention: a rule with citations, surviving serialization.
const model = {};
attested.forEach(entry => phrasing.retainPhrasingRule(model, entry, { relation: 'quantity' }));
const reloaded = JSON.parse(JSON.stringify(model));
const held = phrasing.retainedPhrasings(reloaded);
check('phrasings survive reload', held.length === attested.length, `${held.length} of ${attested.length}`);
check('each retained phrasing names the sources that attested it',
  held.every(entry => entry.sources.length >= 2), JSON.stringify(held.map(h => h.sources)));
check('what is retained is a rule, not fitted parameters',
  !reloaded.lariLanguageModels
  && reloaded.lariLearnedRecords.records.every(record => record.payload.operation === 'attested_phrasing_shape'));
check('retention records how it was verified',
  reloaded.lariLearnedRecords.records.every(record => record.payload.verification === 'multi_source_agreement'));
check('no expected value is stored',
  reloaded.lariLearnedRecords.records.every(record => record.provenance.storesTestAnswers === false));

// Grounding still governs: an attested shape decides how, the claim decides whether.
const claim = { type: 'count', values: { total: 7 } };
const numeric = held.find(entry => entry.types.includes('NUMBER'));
if (numeric) {
  const filled = phrasing.fillShape(numeric, ['7']);
  check('an attested shape realizes a claim it never saw', Boolean(filled) && /7/.test(filled), String(filled));
  check('and the realization is grounded',
    filled ? realization.groundingViolations(filled, [claim]).length === 0 : false, String(filled));
  const smuggled = phrasing.fillShape(numeric, ['999']);
  check('grounding rejects a value the claim does not license',
    smuggled ? realization.groundingViolations(smuggled, [claim]).length > 0 : false, String(smuggled));
} else {
  check('a numeric construction was learned', false, 'no NUMBER-slot phrasing attested');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
