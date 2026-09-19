#!/usr/bin/env node
'use strict';

/**
 * Asserts the research-claim lane, including that each of its oracles can FAIL.
 *
 * "A verifier that cannot fail is decoration" -- swarm_claim_realization.js says so about its own
 * checks, and the same standard applies here. Every oracle below is tested adversarially: a corrupted
 * claim must be rejected, a recited answer must be rejected, a keyword must be rejected. A suite that
 * only shows the happy path would pass just as well against a function that returns `ok: true`.
 *
 * The failure this lane exists to prevent is already in the live model: `skill.grammatical_conjugation`
 * holds three sentences of pasted encyclopedia prose as its answer. Test 3 is the one that would have
 * caught it.
 *
 * Usage: node scripts/test_lari_research_claims.js
 */

const path = require('path');
const research = require(path.join(__dirname, '..', 'swarm_research_claims.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 220)}` : ''}`);
  }
}

// A source with several extractable propositions. Written here rather than fetched, so the test is
// deterministic and does not depend on the network or on a page staying the same.
const SOURCE = [
  'Ada Lovelace is a mathematician remembered for her work on the Analytical Engine.',
  'The Analytical Engine was designed in 1837 by Charles Babbage.',
  'Jupiter has 95 moons according to the current count.',
  'The Analytical Engine is in London.'
].join(' ');
const META = { source: 'https://example.org/analytical-engine', title: 'The Analytical Engine' };

console.log('extraction produces typed propositions, not sentences');
{
  const claims = research.atomizeSource(SOURCE, META);
  check('found at least three claims', claims.length >= 3, claims.length);
  check('every claim has a type and slots',
    claims.every(c => c.type && Object.keys(c.values).length >= 2), claims.map(c => c.type));
  check('no claim value is a whole sentence',
    claims.every(c => Object.values(c.values).every(v => String(v).split(/\s+/).length <= 5)),
    claims.flatMap(c => Object.values(c.values)));
  check('each claim carries the span it came from',
    claims.every(c => SOURCE.includes(c.span)));
  const year = claims.find(c => c.type === 'fact_event_year');
  check('extracted the year as a slot, not as prose', year && year.values.year === '1837', year && year.values);

  // Truncation is invisible to every oracle: a clipped name is still a substring of the source, still
  // fills its slots and still is not recitation. These assert the claim is as complete as the source
  // supports, which is the only way that class of defect gets caught.
  const def = claims.find(c => c.type === 'fact_definition');
  check('a two-word name is captured whole, not clipped to its last word',
    def && def.values.term === 'Ada Lovelace', def && def.values);
  const located = claims.find(c => c.type === 'fact_location');
  check('a name with an article is captured whole',
    located && located.values.subject === 'The Analytical Engine', located && located.values);
  check('the category does not run on into the rest of the clause',
    def && def.values.category.split(/\s+/).length <= 2, def && def.values.category);
}

console.log('\noracle 1: faithfulness, and it can fail');
{
  const claims = research.atomizeSource(SOURCE, META);
  check('a genuine claim is faithful',
    research.faithfulnessViolations(claims[0], SOURCE).length === 0);
  // Adversarial: corrupt one slot to something the source never said.
  const corrupted = { ...claims[0], values: { ...claims[0].values, term: 'Grace Hopper' } };
  const v = research.faithfulnessViolations(corrupted, SOURCE);
  check('a corrupted claim is caught', v.length > 0, v);
  check('the violation names the offending slot and value',
    v[0] && v[0].slot === 'term' && v[0].value === 'Grace Hopper', v[0]);
}

console.log('\noracle 2: anti-recitation, and it can fail');
{
  // This is the check that refuses the conjugation-skill failure mode.
  const recited = 'Ada Lovelace is a mathematician remembered for her work on the Analytical Engine.';
  const v = research.recitationViolations(recited, SOURCE);
  check('pasting a source sentence is caught as recitation', v.length > 0, v);
  const built = 'Ada Lovelace falls under mathematician.';
  check('a phrase built from slots is not recitation',
    research.recitationViolations(built, SOURCE).length === 0,
    research.recitationViolations(built, SOURCE));
  check('short overlaps are allowed, or nothing could ever be said',
    research.recitationViolations('Jupiter moons number 95.', SOURCE).length === 0);
}

console.log('\noracle 3: extraction, and it can fail');
{
  check('a one-slot claim is rejected as a keyword',
    research.extractionViolations({ type: 'x', values: { term: 'Jupiter' } }).length > 0);
  check('a claim repeating one value in two slots is rejected',
    research.extractionViolations({ type: 'x', values: { a: 'Jupiter', b: 'jupiter' } }).length > 0);
  check('a genuine two-slot claim passes',
    research.extractionViolations({ type: 'x', values: { a: 'Jupiter', b: '95' } }).length === 0);
}

console.log('\nretention: only verified claims, and only with a source');
{
  const model = {};
  const noSource = research.retainResearchClaims(model, SOURCE, {});
  check('retention without a source is refused', noSource.retained.length === 0, noSource.rejected);
  check('and nothing was written to the model', !Array.isArray(model.knowledge) || model.knowledge.length === 0);

  const result = research.retainResearchClaims(model, SOURCE, META);
  check('verified claims are retained', result.retained.length >= 3, result.retained.length);
  check('every retained entry carries its source', model.knowledge.every(k => k.source === META.source));
  check('every retained entry carries the span it came from',
    model.knowledge.every(k => SOURCE.includes(k.span)));
  check('every retained entry states what its verification means',
    model.knowledge.every(k => /NOT independently verified/.test(k.verificationMeaning)));

  // Rule 2: no expected values. A retained claim is a proposition with a source, not an answer key.
  check('no retained entry carries a minedFrom back-reference',
    !JSON.stringify(model.knowledge).includes('minedFrom'));

  const before = model.knowledge.length;
  research.retainResearchClaims(model, SOURCE, META);
  check('researching the same source twice does not duplicate', model.knowledge.length === before,
    { before, after: model.knowledge.length });
}

console.log('\nsurvives a reload -- state, not session memory');
{
  const model = {};
  research.retainResearchClaims(model, SOURCE, META);
  const reloaded = JSON.parse(JSON.stringify(model));
  const answer = research.answerFromResearch(reloaded, 'What was the Analytical Engine designed in?');
  check('a claim retained before the round trip still answers after it', answer.answered, answer.reason);
  check('the answer carries the year from state', answer.answered && answer.text.includes('1837'), answer.text);
}

console.log('\nanswering: attributed, grounded, and able to decline');
{
  const model = {};
  research.retainResearchClaims(model, SOURCE, META);

  const good = research.answerFromResearch(model, 'Tell me about the Analytical Engine');
  check('answers from retained state', good.answered, good.reason);
  check('cites the source', good.answered && good.sources.includes(META.source), good.sources);
  check('the answer is grounded', good.answered && good.grounding.length === 0, good.grounding);
  check('the answer does not recite the source', good.answered && good.recitation.length === 0, good.recitation);
  check('the answer discloses it is unverified',
    good.answered && /not verified it independently/.test(good.text), good.text);
  check('no external model calls', good.externalModelCalls === 0);

  const decline = research.answerFromResearch(model, 'Who won the football match last night?');
  check('declines when no retained claim supports an answer', decline.answered === false, decline);
  check('and says why', typeof decline.reason === 'string' && decline.reason.length > 0);

  const empty = research.answerFromResearch({}, 'Tell me about the Analytical Engine');
  check('declines against an empty store rather than throwing', empty.answered === false);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
