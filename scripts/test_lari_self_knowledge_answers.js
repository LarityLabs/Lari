#!/usr/bin/env node
'use strict';

/**
 * The oracle for answers Lari gives about itself.
 *
 * NOT a capability gate: it builds model states by hand and checks properties of what comes back. It
 * cannot fail for capability reasons.
 *
 * What it protects. The chat path used to answer questions about Lari by retrieving third-person
 * prose about Lari. Asked why some Python tests were failing it returned "Lari should inspect and read
 * the Ruby project" -- wrong language, and advice rather than an answer. Asked what it had learned it
 * returned "When Lari does not know a domain, he should gather sources", which was false: it had
 * learned five substitution rules and the records were sitting unread.
 *
 * The properties that matter are that answers come from state, that every number in them is real, and
 * that no state means no answer. The last one is the one worth guarding hardest: the honest refusal
 * this model already gives is better than any plausible paragraph, and a self-knowledge lane is
 * exactly the kind of thing that would start inventing to seem helpful.
 *
 * Usage: node scripts/test_lari_self_knowledge_answers.js
 */

const path = require('path');
const selfKnowledge = require(path.join(__dirname, '..', 'swarm_self_knowledge.js'));
const mutationRepair = require(path.join(__dirname, '..', 'swarm_mutation_repair.js'));
const runtime = require(path.join(__dirname, '..', 'swarm_model_runtime.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

/** A model that has learned exactly one rule and recorded exactly one search. */
function modelWith({ rules = [], searches = [] } = {}) {
  const records = [];
  for (const [family, rule] of rules) {
    records.push({
      type: 'operator', status: 'active',
      payload: { operation: 'mutation_vocabulary_rule', family, rule }
    });
  }
  for (const [family, attempts, successes] of searches) {
    records.push({
      type: 'operator', status: 'active',
      payload: { operation: 'mutation_search_statistics', family, attempts, successes, mutations: {} }
    });
  }
  return { lariLearnedRecords: { schemaVersion: 1, records } };
}

const deps = { mutationRepair, runtime };
console.log('self-knowledge answers');

const taught = modelWith({
  rules: [['arithmetic-substitution', [' + ', ' * ']]],
  searches: [['arithmetic-substitution', 40, 6], ['numeric-constant', 900, 0]]
});

const learned = selfKnowledge.answerAboutSelf(taught, 'what did you learn today', deps);
check('it answers what it learned', learned.answered === true, JSON.stringify(learned));
check('it names the rule it actually holds', /\+ -> \*/.test(learned.text), learned.text);
check('it does not claim rules it does not have', !/-> \//.test(learned.text), learned.text);

const experience = selfKnowledge.answerAboutSelf(taught, 'how good are you at repairing code', deps);
check('it reports its record', experience.answered === true);
check('the numbers are the ones in the model', /940/.test(experience.text) && /6/.test(experience.text),
  experience.text);
check('it names its strongest family from the data',
  /arithmetic-substitution/.test(experience.text), experience.text);

// The property that matters most: no state, no answer.
const untaught = modelWith({});
const nothingLearned = selfKnowledge.answerAboutSelf(untaught, 'what did you learn today', deps);
check('a model that has learned nothing says nothing', nothingLearned.answered === false,
  JSON.stringify(nothingLearned));

const offTopic = selfKnowledge.answerAboutSelf(taught, 'who won the 2022 world cup', deps);
check('it declines questions that are not about itself', offTopic.answered === false, JSON.stringify(offTopic));

const alsoOffTopic = selfKnowledge.answerAboutSelf(taught, 'what is a monad in category theory', deps);
check('it declines general knowledge', alsoOffTopic.answered === false);

// Grounding, on the lane's own output.
const realization = require(path.join(__dirname, '..', 'swarm_claim_realization.js'));
check('its answers are grounded in the claims it built',
  realization.groundingViolations(learned.text, learned.claims).length === 0);
check('it says every claim it selected',
  realization.unrealizedClaims(learned.text, learned.claims, selfKnowledge.SELF_REALIZATION_RULES).length === 0);
check('it calls no external model', learned.externalModelCalls === 0);

// And through the real product surface, which is where the canned strings used to win.
const reply = runtime.sendMessageToLari(taught, 'what did you learn today');
check('the chat surface returns the grounded answer, not a canned one',
  String(reply?.answer || '').includes('not in my original vocabulary'),
  String(reply?.answer || '').slice(0, 160));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
