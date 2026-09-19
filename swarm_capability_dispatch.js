'use strict';

/**
 * Explicit capability routes plus a retained diagnostic planner.
 *
 * The problem this exists to solve
 * -------------------------------
 * Measured 2026-07-31: benchmarks invoke 199 distinct runtime capabilities, and 151 of them are named
 * nowhere in the kernel's dispatch. They are built, benchmarked and unreachable by asking Lari
 * anything. A capability that works and cannot be reached is indistinguishable from one that does not
 * exist -- which is exactly how a whole synthesis lane sat unnoticed while its benchmark reported
 * failure.
 *
 * The generic planner is intentionally not called by production inference: benchmark-derived function
 * names are not executable learned capabilities. Canonical learned execution belongs to typed records
 * carrying verified `lariExecution` contracts in the unified kernel. The three explicit routes below
 * remain because they provide complete invocation arguments and narrow user-intent matches.
 *
 * Why a table and not a chain of `if`s in the kernel
 * -------------------------------------------------
 * There are 151 of these. Adding each by hand to a 31,681-line function is how the two parallel chat
 * implementations happened in the first place. A table is data: entries can be added, tested and
 * counted, and `npm run lari:capability-wiring` can check the list against what the kernel reaches.
 *
 * The rule every entry must satisfy
 * ---------------------------------
 * **Additive only.** An entry may claim a request the kernel would otherwise not have handled, and may
 * never take one the kernel already handles. Wiring `runLariChatCompletion` ahead of `runGeneralChat`
 * regressed grounded answering within one run, because the two lanes disagree about when to answer at
 * all. So dispatch runs where the kernel would otherwise fall through, and a capability that throws or
 * returns nothing hands the request straight back.
 *
 * Each entry declares its own `match`, which must be specific enough that an ordinary chat message
 * cannot trigger it by accident. A false match is worse than no route: it turns a conversation into a
 * side effect.
 */

/**
 * The table. `capability` is the runtime function name, kept as a string so a missing function is a
 * skipped route rather than a crash at load.
 */
const CAPABILITY_ROUTES = [
  {
    id: 'consolidate-memory',
    capability: 'consolidateMemory',
    // Explicit and imperative. "what do you remember" must NOT trigger a consolidation side effect.
    match: /\b(?:consolidate|compact|tidy up)\s+(?:your\s+)?(?:memory|memories)\b/i,
    describe: 'consolidate retained memory',
    invoke: (runtime, model) => runtime.consolidateMemory(model, {}),
    summarize: result => `I consolidated my memory. ${
      typeof result?.merged === 'number' ? `${result.merged} entries merged.` : 'Nothing needed merging.'}`
  },
  {
    id: 'capability-graph',
    capability: 'buildLariCapabilityGraph',
    match: /\b(?:what|which)\s+(?:can|are)\s+you\s+(?:do|capable of)\b|\byour\s+capabilit(?:y|ies)\b/i,
    describe: 'report the capability graph',
    invoke: (runtime, model) => runtime.buildLariCapabilityGraph(model, {}),
    summarize: (result) => {
      const nodes = Array.isArray(result?.nodes) ? result.nodes.length
        : Object.keys(result?.capabilities || {}).length;
      return nodes
        ? `My capability graph holds ${nodes} ${nodes === 1 ? 'entry' : 'entries'}.`
        : 'I could not build a capability graph from my current state.';
    }
  },
  {
    id: 'self-learning-agenda',
    capability: 'inferLariSelfLearningAgenda',
    match: /\bwhat\s+(?:should|do)\s+you\s+(?:learn|work on|study)\b|\byour\s+(?:learning\s+)?agenda\b/i,
    describe: 'report the inferred self-learning agenda',
    invoke: (runtime, model) => runtime.inferLariSelfLearningAgenda(model, {}),
    summarize: (result) => {
      const goals = result?.goals || result?.agenda || [];
      return Array.isArray(goals) && goals.length
        ? `I have ${goals.length} learning ${goals.length === 1 ? 'goal' : 'goals'} on my agenda.`
        : 'I have no learning goals recorded right now.';
    }
  }
];

/**
 * Selection by GOAL, using the router Lari already has.
 *
 * The table above is a keyword router: it makes the user name the capability. This is the thing that
 * was actually wanted -- the user states an outcome and `routeCompiledSkill` ranks every compiled
 * skill against it, so "consolidate my memory" reaches `consolidateMemory` because it scored highest,
 * not because a regex matched.
 *
 * The floor is the whole safety property. Without one the router always returns its best guess, and
 * measured on a live model that meant "hello how are you" routing to `runApprovedLearningJobs` -- an
 * ordinary greeting triggering a capability. A false match is worse than no route, because it turns a
 * conversation into a side effect.
 *
 * 0.6 sits between the two populations measured on the registered model: genuine goals scored ~0.79
 * and ordinary chat ~0.41. It is a stated constant rather than a tuned one, and
 * `npm run lari:test-capability-dispatch` measures both error rates against a fixed set so moving it
 * has to be justified by numbers rather than by a few examples looking right.
 */
const SELECTION_FLOOR = 0.6;

/**
 * Is this text asking Lari to DO something, or just talking to it?
 *
 * The score cannot answer this. Measured on the registered model, "what did we do yesterday" scored
 * 0.78 and the genuine goal "consolidate my memory" scored 0.787 -- the populations overlap, so no
 * threshold separates them and moving the floor only trades one error for the other.
 *
 * What does separate them is grammatical mood. A goal is an instruction: verb-initial, or an explicit
 * request wrapped around a verb. The false matches were all questions about state or the past --
 * "what did we do yesterday", "why did that test fail", "can you help me" -- which are conversation
 * even when their vocabulary overlaps a capability's.
 *
 * This is a structural check rather than a tuned one, which matters: a threshold can be nudged until a
 * demo passes, and a mood test either matches the shape or it does not. It will be wrong at the
 * edges -- "can you consolidate my memory" is a question that IS a request -- so the explicit-request
 * form is admitted and everything else interrogative is refused. Refusing a real goal costs a fallback
 * to chat; admitting a conversation runs a capability, so the asymmetry is deliberate.
 */
const INTERROGATIVE = /^\s*(?:what|why|when|where|who|which|how|did|does|do|is|are|was|were|should|would|will|has|have|am)\b/i;
const EXPLICIT_REQUEST = /^\s*(?:can you|could you|would you|please|i want you to|i need you to|go ahead and)\s+([a-z]+)/i;
const PAST_REFERENCE = /\b(?:yesterday|earlier|last (?:time|week|night)|we did|did we|used to)\b/i;

/**
 * A declarative names its subject; an imperative starts with the verb.
 *
 * Found on held-out phrases the fixed set never contained: "i am not sure this works" passed every
 * other check and routed to a capability, because "starts with a word" is not "starts with a verb".
 */
const SUBJECT_INITIAL = /^(?:i|we|you|they|he|she|it|that|this|there|my|our|the)\b/i;

/**
 * Verbs that ask for something without naming it.
 *
 * "can you help me" survived the mood test and routed to `buildLariModelCard` at 0.70. It is a genuine
 * request and it names no action, so the only honest response is to fall through to chat, which can ask
 * what the user wants. Picking a capability for an unspecified request is guessing with side effects.
 */
const VAGUE_VERBS = /^(?:help|assist|do|try|fix|handle|sort|deal)\b/i;

function looksLikeGoal(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  // Talking about what already happened is never an instruction.
  if (PAST_REFERENCE.test(trimmed)) return false;
  // "can you consolidate my memory" is a request wearing a question mark -- but only when it says what
  // to do. The verb it wraps has to name an action.
  const explicit = trimmed.match(EXPLICIT_REQUEST);
  if (explicit) return !VAGUE_VERBS.test(explicit[1]);
  if (VAGUE_VERBS.test(trimmed)) return false;
  if (INTERROGATIVE.test(trimmed)) return false;
  if (/\?\s*$/.test(trimmed)) return false;
  // A declarative names a subject; an imperative starts with the verb. Found on held-out phrases the
  // fixed set never contained: "i am not sure this works" passed the mood test and routed, because
  // "starts with a word" is not "starts with a verb".
  if (SUBJECT_INITIAL.test(trimmed)) return false;
  // Imperative: begins with a bare verb.
  return /^\s*[a-z]+(?:\s|$)/i.test(trimmed);
}

/**
 * Capabilities that may be invoked from a user request without confirmation.
 *
 * Selection reaches the right capability 9 times in 12, and its errors are near-neighbours. That is
 * tolerable when a wrong pick reports something unwanted, and unacceptable when it changes state --
 * `consolidateMemory` mutating the model because someone asked about training holdouts is a different
 * order of problem from a wrong report.
 *
 * So auto-invocation is restricted to capabilities MEASURED not to write. The classification comes from
 * `scripts/classify_lari_capability_side_effects.js`, which deep-copies a model, invokes the capability
 * and compares the serialized state -- never from what a name suggests. That distinction is not
 * academic: `buildLariCapabilityGraph` sounds like a report and grows the model by 913 KB.
 *
 * Of 128 registered capabilities: 41 measured read-only, 63 measured mutating, 24 threw and are treated
 * as unsafe because unproven is not safe.
 *
 * Loaded from disk so the allowlist is regenerated by measurement rather than edited by hand.
 */
let autoInvokable = null;
function loadAutoInvokable() {
  if (autoInvokable) return autoInvokable;
  try {
    const report = require('./holdouts/CAPABILITY_SIDE_EFFECTS.json');
    autoInvokable = new Set(report.autoInvokable || []);
  } catch (e) {
    autoInvokable = new Set();   // no classification means nothing is auto-invokable
  }
  return autoInvokable;
}

function selectByGoal(runtime, model, prompt, { floor = SELECTION_FLOOR, requireReadOnly = true } = {}) {
  // Mood first, and it is not negotiable by score. A very high similarity on a question is still a
  // question, and answering it by running a capability turns a conversation into a side effect.
  if (!looksLikeGoal(prompt)) return null;
  if (typeof runtime?.routeCompiledSkill !== 'function') return null;
  const text = String(prompt || '').trim();
  if (!text) return null;
  let routed = null;
  try { routed = runtime.routeCompiledSkill(model, text, {}); } catch (e) { return null; }
  const score = Number(routed?.score);
  const capability = routed?.skill?.capability || routed?.capability || null;
  if (!capability || !Number.isFinite(score) || score < floor) return null;
  // The capability has to be callable, or a high score is just a confident wrong answer.
  if (typeof runtime[capability] !== 'function') return null;
  // A wrong pick that only reports is a bad answer; a wrong pick that writes is a corrupted model.
  if (requireReadOnly && !loadAutoInvokable().has(capability)) return null;
  return { capability, score, skillId: routed?.skill?.id || null };
}

/** Routes whose capability actually exists on this runtime. */
function availableRoutes(runtime) {
  return CAPABILITY_ROUTES.filter(route => typeof runtime?.[route.capability] === 'function');
}

/**
 * Find the route for a prompt, or null.
 *
 * Exactly one route may claim a prompt. Two matches is an ambiguity the table author has to resolve,
 * and guessing between them would make dispatch order load-bearing and invisible.
 */
function selectRoute(runtime, prompt) {
  const text = String(prompt || '');
  if (!text.trim()) return null;
  const matches = availableRoutes(runtime).filter(route => route.match.test(text));
  if (matches.length !== 1) return null;
  return matches[0];
}

/**
 * Plan a capability for a goal: run it, or ask first.
 *
 * Restricting auto-invocation to capabilities measured not to write was safe and nearly useless --
 * goals routed fell from 7 of 8 to 1 of 8, because every request a user would actually make names a
 * capability that writes. Exclusion is the wrong mechanism.
 *
 * Confirmation is the right one, and it also disarms the accuracy problem. Selection reaches the right
 * capability 9 times in 12; a wrong pick that asks first is a question the user says no to, while a
 * wrong pick that acts is a corrupted model. So the same 9/12 is a liability when it acts and a
 * non-issue when it asks.
 *
 * Three outcomes, and the caller must handle all three:
 *
 *   `run`     read-only by measurement. Invoke it; there is nothing to undo.
 *   `confirm` mutating or unproven. Return what WOULD be done and why, and do not touch the model.
 *   `decline` not a goal, below the floor, or no capability. Fall through to chat.
 *
 * An unproven capability -- one that threw during classification -- is treated as mutating. Unproven is
 * not safe.
 */
function planCapability(runtime, model, prompt, options = {}) {
  const selected = selectByGoal(runtime, model, prompt, { ...options, requireReadOnly: false });
  if (!selected) return { action: 'decline', reason: 'no capability route for this request' };

  const readOnly = loadAutoInvokable().has(selected.capability);
  if (!readOnly) {
    return {
      action: 'confirm',
      capability: selected.capability,
      score: selected.score,
      // Said plainly, because the user is being asked to authorise a state change.
      prompt: `That looks like a request to run ${selected.capability}, which changes my state. `
        + 'Say yes and I will run it.',
      reason: 'capability writes to the model, or was not proven read-only'
    };
  }
  return {
    action: 'run',
    capability: selected.capability,
    score: selected.score,
    reason: 'capability measured read-only; nothing to undo'
  };
}

/** Affirmatives that may authorise a pending capability. Deliberately short and unambiguous. */
const AFFIRMATIVE = /^\s*(?:yes|yep|yeah|yes please|ok|okay|go ahead|do it|please do|confirm(?:ed)?|sure)\b[\s.!]*$/i;
const NEGATIVE = /^\s*(?:no|nope|don'?t|do not|cancel|stop|nevermind|never mind)\b/i;

/**
 * Resolve a pending confirmation against the user's next message.
 *
 * The half that makes confirmation real: without it, "yes" means nothing and every mutating capability
 * is permanently unreachable.
 *
 * Three rules, and all three are safety properties rather than conveniences:
 *
 *   1. **Bare affirmatives only.** "yes" authorises; "yes but change the file first" does not. A
 *      qualified answer is a new request, and reading it as consent authorises something the user did
 *      not say.
 *   2. **The pending capability is what runs.** Authorisation is for the capability that was named, not
 *      for whatever the follow-up text would now route to. Otherwise "yes" becomes a blank cheque that
 *      re-selects.
 *   3. **One use.** A resolved pending never survives to authorise a second action.
 *
 * Anything that is not a clear yes or no clears the pending state and is handled as an ordinary
 * message. Leaving it armed would let an unrelated "ok" three turns later run something.
 */
function resolveConfirmation(pending, message) {
  if (!pending || !pending.capability) return { resolution: 'none' };
  const text = String(message || '');
  if (NEGATIVE.test(text)) {
    return { resolution: 'declined', capability: pending.capability, clearPending: true };
  }
  if (!AFFIRMATIVE.test(text)) {
    // Not an answer to the question. Clear it rather than leaving it armed.
    return { resolution: 'superseded', capability: pending.capability, clearPending: true };
  }
  return {
    resolution: 'authorised',
    capability: pending.capability,
    clearPending: true,
    // Named explicitly so a caller cannot accidentally run something else.
    authorisedFor: pending.capability
  };
}

/**
 * Dispatch, or decline.
 *
 * `handled: false` is the common case and must stay cheap. A capability that throws is reported and
 * declined rather than surfaced, because an exception is not an answer.
 */
function dispatchCapability(runtime, model, prompt) {
  const route = selectRoute(runtime, prompt);
  if (!route) return { handled: false, reason: 'no capability route matched' };
  try {
    const result = route.invoke(runtime, model);
    if (result === null || result === undefined) {
      return { handled: false, reason: `${route.id} returned nothing`, routeId: route.id };
    }
    return {
      handled: true,
      routeId: route.id,
      capability: route.capability,
      text: route.summarize(result),
      result,
      externalModelCalls: 0
    };
  } catch (error) {
    return { handled: false, reason: `${route.id} threw: ${String(error.message || error)}`, routeId: route.id };
  }
}

module.exports = {
  CAPABILITY_ROUTES,
  SELECTION_FLOOR,
  availableRoutes,
  selectRoute,
  looksLikeGoal,
  selectByGoal,
  planCapability,
  resolveConfirmation,
  dispatchCapability
};
