#!/usr/bin/env node
'use strict';
// Lari discourse-operator learning loop demo (experimental, 2026-09-19).
//
// Lari learns to talk the way it learns to repair: a missing discourse
// relation is corrected twice, the corrections induce a typed operator
// record, the record is retained, and the generator's marker preferences
// are re-trained from it. Zero parameters; records are tiny.
//
// Rerunnable: the experiment store is cleared at start.
const fs = require('fs');
const path = require('path');

const storePath = path.join(__dirname, '..', 'learned_discourse_operators.json');
if (fs.existsSync(storePath)) fs.unlinkSync(storePath);

const lu = require('../swarm_language_understanding.js');

let failures = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!condition) failures++;
}

console.log('=== 1. The gap: no "condition/unless" operator ===');
const novelCondition = () => lu.realizeWithDiscourseLearning({
  relations: [{ type: 'condition', roles: { plan: 'They launch', obstacle: 'the wind rises' } }]
});
check('refuses without an operator', novelCondition() === null);

console.log('=== 2. Two corrections ===');
const r1 = lu.recordDiscourseCorrection({
  relationType: 'condition', marker: 'unless', roles: ['plan', 'obstacle'],
  text: 'We will go unless it rains.'
});
check('first correction waits', !r1.induced && r1.reason === 'need_one_more_matching_example');
const r2 = lu.recordDiscourseCorrection({
  relationType: 'condition', marker: 'unless', roles: ['plan', 'obstacle'],
  text: 'She stays unless she hears news.'
});
check('second correction induces', r2.induced === true, r2.record?.id || '');

console.log('=== 3. Novel rendering (content never seen in training) ===');
const rendered = novelCondition();
check('renders novel claim', Boolean(rendered), rendered?.answer || '');
check('verification passed', Boolean(rendered?.verification?.passed));
check('trace cites learned marker', rendered?.trace?.[0]?.marker === 'unless');

console.log('=== 4. Preference shift: "yet" outranks seed "but" ===');
const contrastRender = () => lu.realizeWithDiscourseLearning({
  relations: [{ type: 'contrast', roles: { left: 'The road is long', right: 'the company is good' } }]
}).answer;
const before = contrastRender();
lu.recordDiscourseCorrection({ relationType: 'contrast', marker: 'yet', roles: ['left', 'right'], text: 'The soup is hot, yet the salad is cold.' });
lu.recordDiscourseCorrection({ relationType: 'contrast', marker: 'yet', roles: ['left', 'right'], text: 'The task is dull, yet the pay is fair.' });
const after = contrastRender();
check('seed preferred "but"', /but/.test(before), before);
check('two corrections shift to "yet"', /yet/.test(after), after);

console.log('=== 5. Input side: the learned record parses, too ===');
const entries = lu.loadDiscourseOperatorEntries();
const condAst = entries.find(e => e.record.payload.operatorAst.relationType === 'condition').record.payload.operatorAst;
const segments = lu.learnedRelationSegments('They launch unless the wind rises.', condAst);
check('parses novel unless-sentence', segments.length === 1 && segments[0].roles.plan === 'They launch', JSON.stringify(segments[0]?.roles || ''));

console.log('=== 6. Negative controls ===');
const single = lu.recordDiscourseCorrection({ relationType: 'purpose', marker: 'so that', roles: ['a', 'b'], text: 'He runs so that he stays fit.' });
check('one example does not induce', !single.induced);
const invalid = lu.recordDiscourseCorrection({ relationType: 'x', marker: '', roles: ['a'], text: 'hi' });
check('invalid example refused', !invalid.induced && invalid.reason === 'invalid_correction_example');
const dup = lu.recordDiscourseCorrection({ relationType: 'condition', marker: 'unless', roles: ['plan', 'obstacle'], text: 'We will go unless it rains.' });
check('repeating a taught relation starts a fresh count', !dup.induced && dup.pending === 1);

console.log('=== 7. Retention ===');
check('store holds 2 operator records', entries.length === 2, entries.map(e => e.record.payload.operatorAst.relationType).join(','));
check('records are model-shaped', entries.every(e => e.record.id.startsWith('lari.learned.operator.language.semantic_relation.')));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
