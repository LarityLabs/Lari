'use strict';

/**
 * Answer questions from executions Lari performed.
 *
 * The pantry was filled and the door was locked: 60 verified observations sat in `model.knowledge` and
 * no lane read them, so asking what a function does still returned the refusal. This is the consumption
 * half -- match a question against retained observations and realize them through the oracle that
 * already exists.
 *
 * Why this is the interesting lane
 * -------------------------------
 * Every other source of knowledge is second-hand. Retained research is faithful to a document that may
 * be wrong. These are first-hand: Lari ran the code and recorded what happened, twice, and stored the
 * exact expression so any claim can be re-executed and checked. A language model predicting what a
 * function returns is guessing well; this is reporting.
 *
 * The discipline, unchanged from `swarm_execution_claims.js`
 * ---------------------------------------------------------
 * Every claim is past tense about one named invocation. There is no claim type that quantifies over
 * inputs, and the summary states how many observations it rests on so a reader cannot mistake four
 * examples for a specification. Rule 12: observing `intword(1000)` says nothing about `intword(1001)`,
 * and there is no way here to express that it does.
 *
 * Refusal stays first-class. A question no observation matches returns `answered: false`, and the chat
 * path keeps its refusal -- which is correct, and better than reaching for a related-looking function.
 */

const realization = require('./swarm_claim_realization.js');
const execution = require('./swarm_execution_claims.js');

/** Canonical typed knowledge payloads, with legacy fallback only for pre-consolidation files. */
function knowledgePayloads(model) {
  if (Array.isArray(model?.lariLearnedRecords?.records)) {
    return model.lariLearnedRecords.records
      .filter(record => record?.status === 'active' && record?.type === 'knowledge' && record?.payload)
      .map(record => ({ ...record.payload, sourceLearnedRecordId: record.id }));
  }
  return Array.isArray(model?.knowledge) ? model.knowledge : [];
}

/** Retained execution observations, if any. */
function observationsOf(model) {
  return knowledgePayloads(model)
    .filter(entry => entry && entry.kind === 'execution_observation' && entry.expression);
}

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Observations whose subject the question names.
 *
 * Matched on the subject -- `humanize.intword` -- and on its bare function name, because people ask
 * "what does intword do" as often as they write the qualified path. Deliberately not fuzzy: a question
 * that names no observed callable matches nothing, rather than returning the nearest neighbour. The
 * capability router already showed what happens when similarity is allowed to stand in for reference.
 */
function matchObservations(model, question) {
  const asked = new Set(String(question || '').toLowerCase().match(WORD) || []);
  if (!asked.size) return [];
  const matched = observationsOf(model).filter((entry) => {
    const subject = String(entry.subject || '');
    const bare = subject.split('.').pop().toLowerCase();
    return asked.has(subject.toLowerCase()) || asked.has(bare);
  });
  // Group by subject so an answer is about one function rather than a scattering.
  if (!matched.length) return [];
  const bySubject = new Map();
  for (const entry of matched) {
    if (!bySubject.has(entry.subject)) bySubject.set(entry.subject, []);
    bySubject.get(entry.subject).push(entry);
  }
  const [, best] = [...bySubject.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return best;
}

/**
 * Answer from observations, or decline.
 *
 * The claims are built in exactly the shape `swarm_execution_claims.js` produces, so they are realized
 * by the same rules and checked by the same grounding oracle. Nothing new is trusted here.
 */
function answerFromObservations(model, question, { limit = 4 } = {}) {
  const matched = matchObservations(model, question).slice(0, limit);
  if (!matched.length) {
    return { answered: false, reason: 'no retained observation matches that question', claims: [] };
  }

  const claims = matched.map(entry => (entry.outcome === 'raised'
    ? { type: 'code_observed_raise', values: { expression: entry.expression, exception: entry.value } }
    : { type: 'code_observed_return', values: { expression: entry.expression, value: entry.value } }));
  // The scope claim is realized like any other, so proposition preservation forces it to be said.
  claims.push({ type: 'code_observation_scope', values: { observationCount: claims.length } });

  const rules = execution.EXECUTION_REALIZATION_RULES;
  const text = realization.realizeClaims(claims, rules);
  const grounding = realization.groundingViolations(text, claims);
  const dropped = realization.unrealizedClaims(text, claims, rules);
  if (!text || grounding.length || dropped.length) {
    return { answered: false, reason: 'answer failed its own checks', grounding, dropped, claims };
  }

  return {
    answered: true,
    text,
    claims,
    subject: matched[0].subject,
    learnedRecordIds: [...new Set(matched.map(entry => entry.sourceLearnedRecordId).filter(Boolean))],
    observationCount: matched.length,
    // Every claim traces to a stored expression, so the whole answer is re-runnable.
    expressions: matched.map(entry => entry.expression),
    externalModelCalls: 0
  };
}

/**
 * Lexical facts retained from Computational English.
 *
 * Deliberately a separate lane from observations, because the guarantees differ and must not be
 * blurred. An observation is first-hand -- Lari ran the code. A lexical fact is faithful to a curated
 * resource that Lari did not verify, and the realization says so rather than leaving a reader to assume
 * the stronger claim.
 */
const LEXICAL_RULES = {
  lexical_plural: {
    slots: ['subject', 'value'],
    say: c => `The plural of "${c.subject}" is "${c.value}".`
  },
  lexical_part_of_speech: {
    slots: ['subject', 'value'],
    say: c => `"${c.subject}" is recorded mainly as a ${c.value}.`
  },
  lexical_countability: {
    slots: ['subject', 'value'],
    say: c => `"${c.subject}" is recorded as ${c.value}.`
  },
  lexical_source: {
    slots: ['count'],
    say: c => `That is ${c.count} recorded ${Number(c.count) === 1 ? 'fact' : 'facts'} from Computational English, which I have not verified myself.`
  }
};

const RELATION_TO_CLAIM = {
  plural: 'lexical_plural',
  'part of speech': 'lexical_part_of_speech',
  countability: 'lexical_countability'
};

function lexicalFactsOf(model) {
  return knowledgePayloads(model)
    .filter(entry => entry && entry.kind === 'lexical_fact' && entry.subject);
}

/**
 * Answer a language question from retained lexical facts, or decline.
 *
 * Matched on the word being asked about. A question naming no retained word matches nothing rather
 * than reaching for a near neighbour -- the same rule the observation lane follows, for the same
 * reason.
 */
function answerFromLexicalFacts(model, question, { limit = 3 } = {}) {
  const lexicalQuestion = /\bplural(?:s)?\b|\bpart[- ]of[- ]speech\b|\b(?:countable|uncountable)\b|\bwhat (?:kind|type) of word\b|\bword\s+["'][^"']+["']/i.test(String(question || ''));
  if (!lexicalQuestion) return { answered: false, reason: 'question does not request lexical information', claims: [] };
  const asked = new Set(String(question || '').toLowerCase().match(WORD) || []);
  if (!asked.size) return { answered: false, reason: 'empty question', claims: [] };

  const facts = lexicalFactsOf(model).filter(fact => asked.has(String(fact.subject).toLowerCase()));
  if (!facts.length) return { answered: false, reason: 'no retained lexical fact matches that question', claims: [] };

  // Prefer the relation the question actually asks about, when it names one.
  const wantsPlural = /\bplural|\bplurals?\b/i.test(question);
  const ordered = wantsPlural
    ? [...facts].sort((a, b) => (a.relation === 'plural' ? -1 : 0) - (b.relation === 'plural' ? -1 : 0))
    : facts;

  const chosen = ordered.slice(0, limit);
  const claims = chosen
    .map(fact => ({ type: RELATION_TO_CLAIM[fact.relation], values: { subject: fact.subject, value: fact.value } }))
    .filter(claim => claim.type);
  if (!claims.length) return { answered: false, reason: 'no realizable relation among the matches', claims: [] };
  // Provenance is realized as a claim so preservation forces it to be said.
  claims.push({ type: 'lexical_source', values: { count: claims.length } });

  const text = realization.realizeClaims(claims, LEXICAL_RULES);
  const grounding = realization.groundingViolations(text, claims);
  const dropped = realization.unrealizedClaims(text, claims, LEXICAL_RULES);
  if (!text || grounding.length || dropped.length) {
    return { answered: false, reason: 'answer failed its own checks', grounding, dropped, claims };
  }
  return {
    answered: true,
    text,
    claims,
    subject: chosen[0].subject,
    learnedRecordIds: [...new Set(chosen.map(entry => entry.sourceLearnedRecordId).filter(Boolean))],
    source: 'computational-english',
    externalModelCalls: 0
  };
}

/** Try executions first -- first-hand beats curated -- then lexical facts. */
function answerFromKnowledge(model, question) {
  const observed = answerFromObservations(model, question);
  if (observed.answered) return { ...observed, lane: 'execution' };
  const lexical = answerFromLexicalFacts(model, question);
  if (lexical.answered) return { ...lexical, lane: 'lexical' };
  return { answered: false, reason: observed.reason, lane: null };
}

module.exports = {
  knowledgePayloads,
  observationsOf,
  matchObservations,
  answerFromObservations,
  lexicalFactsOf,
  answerFromLexicalFacts,
  answerFromKnowledge,
  LEXICAL_RULES
};
