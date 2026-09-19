'use strict';

/**
 * Answering questions about Lari, from Lari's own state.
 *
 * The product surface described in the paper is "prompt in, answer out", and the thing standing in
 * the way is not reasoning -- it is that questions about Lari are answered by retrieving third-person
 * procedural boilerplate. Asked why some Python tests fail, the live model replies "Lari should
 * inspect and read the Ruby project"; asked what it learned today, it replies "When Lari does not know
 * a domain, he should gather sources". Both are retrieved text about Lari rather than answers from
 * Lari, and the second is false besides: it had learned three new substitution rules that day and the
 * state recording them was sitting unused.
 *
 * This reads that state and realizes it, under the grounding oracle in swarm_claim_realization.js.
 * Every number in an answer comes from the model file. Nothing is retrieved, nothing is templated over
 * a topic it does not have, and when there is no state to answer from it says so -- which the live
 * model already does well and must not lose.
 *
 * Deliberately narrow. This answers questions about Lari's own capability and history. It is not a
 * chat generator and does not pretend to general knowledge; asked who won a football match it has
 * nothing and should decline.
 */

const path = require('path');
const realization = require(path.join(__dirname, 'swarm_claim_realization.js'));

/** Topics this lane can speak to, and the phrasings that signal them. */
const TOPICS = {
  learned: [/what (have|did) you learn/i, /what.*learned (today|recently|so far)/i, /have you learned/i, /what'?s new/i],
  vocabulary: [/what (rules|vocabulary)/i, /what can you (repair|fix)/i, /which defects/i, /what kinds? of bugs?/i],
  experience: [/how (good|well) are you/i, /how often/i, /success rate/i, /how much have you/i, /track record/i],
  method: [/how do you (repair|fix|work)/i, /what.*your (method|process|approach)/i, /how does.*repair work/i],
  identity: [
    /\bwhat(?:'s| is) your name\b/i, /\btell me your name\b/i, /\bdo you have a name\b/i, /\bwhat should i call you\b/i,
    /\bwho (?:made|built|created|developed|designed) you\b/i, /\byour (?:creator|maker|builder|developer)\b/i, /\bwho'?s your (?:creator|maker|builder)\b/i,
    /\bwhat can you do\b/i, /\bwhat do you do\b/i, /\byour (?:capabilit|abilit)/i,
    /^\s*(?:who|what) are you\s*[?!.]*\s*$/i, /\btell me about yourself\b/i, /\babout yourself\b/i,
    /\bintroduce yourself\b/i, /\bdescribe yourself\b/i, /\bwho is lari\b/i, /\bwhat is lari\b/i
  ]
};

/** Which slice of identity a question asks for. Narrower kinds win. */
function classifyIdentityKind(question) {
  const text = String(question || '');
  if (/\bwhat(?:'s| is) your name\b/i.test(text) || /\btell me your name\b/i.test(text)
    || /\bdo you have a name\b/i.test(text) || /\bwhat should i call you\b/i.test(text)) return 'name';
  if (/\bwho (?:made|built|created|developed|designed) you\b/i.test(text)
    || /\byour (?:creator|maker|builder|developer)\b/i.test(text)
    || /\bwho'?s your (?:creator|maker|builder)\b/i.test(text)) return 'creator';
  if (/\bwhat can you do\b/i.test(text) || /\bwhat do you do\b/i.test(text)
    || /\byour (?:capabilit|abilit)/i.test(text)) return 'capabilities';
  return 'about';
}

/**
 * Identity facts, read from retained learned knowledge records first.
 * The seed script (scripts/seed_lari_identity.js) stores them via the normal
 * ingestKnowledge path; the constants below are the developer-authored
 * fallback so identity never goes unanswered when the records are absent.
 */
function readIdentityFacts(model) {
  const records = (model?.lariLearnedRecords?.records || []).filter(record =>
    record?.type === 'knowledge'
    && record?.status === 'active'
    && typeof record?.payload?.topic === 'string'
    && record.payload.topic.indexOf('Lari self-identity:') === 0);
  const fact = key => {
    const record = records.find(item => item?.payload?.topic === `Lari self-identity: ${key}`);
    const summary = String(record?.payload?.summary || '').trim();
    return summary || null;
  };
  return {
    name: fact('name') || 'Lari, pronounced "Larry" (he/him)',
    what: fact('what') || 'a local personal AI model built from the HTML swarm runtime',
    creator: fact('creator') || 'built by Greg Betti',
    capabilities: fact('capabilities') || 'I can chat, learn, use memory, and work on local files when you link a workspace.'
  };
}

function classify(question) {
  const text = String(question || '');
  for (const [topic, patterns] of Object.entries(TOPICS)) {
    if (patterns.some(pattern => pattern.test(text))) return topic;
  }
  return null;
}

/** Rules Lari holds that its source never contained. */
function grownRules(model, mutationRepair, runtime) {
  const vocabulary = runtime.lariMutationVocabulary(model) || {};
  const seed = mutationRepair.DEFAULT_VOCABULARY;
  const grown = [];
  for (const [family, entry] of Object.entries(vocabulary)) {
    const seeded = new Set((seed[family]?.rules || []).map(rule => rule.join('=>')));
    for (const rule of entry.rules || []) {
      if (seeded.has(rule.join('=>'))) continue;
      grown.push({ family, rule: rule.map(part => String(part).trim() || '(nothing)').join(' -> ') });
    }
  }
  return grown;
}

/**
 * Turn model state into claims for a topic.
 *
 * Selection lives here, so what an answer may contain is decided by what the state holds rather than
 * by how a sentence is phrased. A topic with no supporting state yields no claims, and no claims means
 * no answer rather than a plausible one.
 */
function atomizeSelfKnowledge(model, topic, { mutationRepair, runtime, question = '' } = {}) {
  const claims = [];
  const vocabulary = runtime.lariMutationVocabulary(model) || {};
  const priors = runtime.lariMutationFamilyPriors(model) || {};
  const grown = grownRules(model, mutationRepair, runtime);

  const families = Object.keys(vocabulary).length;
  const ruleCount = Object.values(vocabulary).reduce((sum, entry) => sum + (entry.rules?.length || 0), 0);

  if (topic === 'learned') {
    if (!grown.length) return [];
    claims.push({ type: 'self_grown_count', values: { grownCount: grown.length } });
    for (const item of grown.slice(0, 6)) {
      claims.push({ type: 'self_grown_rule', values: { rule: item.rule, family: item.family } });
    }
    return claims;
  }

  if (topic === 'vocabulary') {
    if (!families) return [];
    claims.push({ type: 'self_vocabulary', values: { families, ruleCount } });
    if (grown.length) claims.push({ type: 'self_grown_count', values: { grownCount: grown.length } });
    return claims;
  }

  if (topic === 'experience') {
    const observed = Object.entries(priors)
      .filter(([key, value]) => !key.includes(':') && Number(value.attempts) > 0)
      .sort((left, right) => Number(right[1].attempts) - Number(left[1].attempts));
    if (!observed.length) return [];
    const attempts = observed.reduce((sum, [, value]) => sum + Number(value.attempts), 0);
    const successes = observed.reduce((sum, [, value]) => sum + Number(value.successes), 0);
    claims.push({ type: 'self_experience', values: { attempts, successes } });
    const best = observed
      .filter(([, value]) => Number(value.successes) > 0)
      .sort((left, right) => (right[1].successes / right[1].attempts) - (left[1].successes / left[1].attempts))[0];
    if (best) {
      claims.push({
        type: 'self_best_family',
        values: { family: best[0], successes: best[1].successes, attempts: best[1].attempts }
      });
    }
    return claims;
  }

  if (topic === 'method') {
    if (!families) return [];
    claims.push({ type: 'self_method', values: { families } });
    return claims;
  }

  if (topic === 'identity') {
    const facts = readIdentityFacts(model);
    const kind = classifyIdentityKind(question);
    if (kind === 'name') {
      claims.push({ type: 'self_identity_name', values: { name: facts.name } });
    } else if (kind === 'creator') {
      claims.push({ type: 'self_identity_creator', values: { creator: facts.creator } });
    } else if (kind === 'capabilities') {
      claims.push({ type: 'self_identity_capabilities', values: { capabilities: facts.capabilities } });
    } else {
      claims.push({ type: 'self_identity_about', values: { name: facts.name, what: facts.what, creator: facts.creator } });
    }
    return claims;
  }

  return [];
}

const SELF_REALIZATION_RULES = {
  ...realization.DEFAULT_REALIZATION_RULES,
  self_grown_count: {
    slots: ['grownCount'],
    say: c => `I have learned ${c.grownCount} repair ${Number(c.grownCount) === 1 ? 'rule' : 'rules'} that were not in my original vocabulary.`
  },
  self_grown_rule: {
    slots: ['rule', 'family'],
    say: c => `One of them rewrites ${c.rule}, which I keep in my ${c.family} family.`
  },
  self_vocabulary: {
    slots: ['families', 'ruleCount'],
    say: c => `I repair defects using ${c.ruleCount} substitution rules across ${c.families} families.`
  },
  self_experience: {
    slots: ['attempts', 'successes'],
    say: c => `Across the repairs I have recorded, I tried ${c.attempts} candidates and ${c.successes} of them passed the project's own tests.`
  },
  self_best_family: {
    slots: ['family', 'successes', 'attempts'],
    say: c => `My most reliable family is ${c.family}, which has worked ${c.successes} times out of ${c.attempts} attempts.`
  },
  self_method: {
    slots: ['families'],
    say: c => `I localize the fault to the lines the failing tests execute, generate candidate patches from my ${c.families} repair families, and keep only a patch that makes the project's own suite pass.`
  },
  self_identity_name: {
    slots: ['name'],
    say: c => `My name is ${c.name}.`
  },
  self_identity_creator: {
    slots: ['creator'],
    say: c => `I was ${c.creator}.`
  },
  self_identity_capabilities: {
    slots: ['capabilities'],
    say: c => `${c.capabilities}`
  },
  self_identity_about: {
    slots: ['name', 'what', 'creator'],
    say: c => {
      const whatWithCreator = String(c.what).replace(/^a local personal AI model\b/, `a local personal AI model ${c.creator}`);
      return `I'm ${c.name} — ${whatWithCreator}.`;
    }
  }
};

/**
 * Answer a question about Lari from Lari's state, or decline.
 *
 * `answered: false` is a first-class outcome. The live model's honest refusal is better than any
 * retrieved paragraph, and this must never replace a refusal with something merely plausible.
 */
function answerAboutSelf(model, question, dependencies = {}) {
  const mutationRepair = dependencies.mutationRepair || require(path.join(__dirname, 'swarm_mutation_repair.js'));
  const runtime = dependencies.runtime || require(path.join(__dirname, 'swarm_model_runtime.js'));

  const topic = classify(question);
  if (!topic) return { answered: false, reason: 'not a question about my own capability', topic: null };

  const claims = atomizeSelfKnowledge(model, topic, { mutationRepair, runtime, question });
  if (!claims.length) return { answered: false, reason: 'no retained state supports an answer', topic };

  const text = realization.realizeClaims(claims, SELF_REALIZATION_RULES);
  const grounding = realization.groundingViolations(text, claims);
  const dropped = realization.unrealizedClaims(text, claims, SELF_REALIZATION_RULES);
  if (grounding.length || dropped.length) {
    // Refusing beats emitting something the oracle rejects. A generator that ships its own rejects is
    // how a growth loop starts believing its wishes.
    return { answered: false, reason: 'realization failed its own grounding check', topic, grounding, dropped };
  }

  return { answered: true, topic, text, claims, grounding: [], dropped: [], externalModelCalls: 0 };
}

module.exports = {
  TOPICS,
  classify,
  atomizeSelfKnowledge,
  SELF_REALIZATION_RULES,
  answerAboutSelf
};
