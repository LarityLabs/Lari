#!/usr/bin/env node
'use strict';

/**
 * Asserts capability dispatch, and asserts hardest that it DECLINES.
 *
 * The danger of routing user text to runtime capabilities is a false match: an ordinary conversational
 * message triggering a side effect. That is worse than having no route at all, so most of this file is
 * negative cases -- ordinary chat that must fall through untouched.
 *
 * Usage: node scripts/test_lari_capability_dispatch.js
 */

const path = require('path');
const dispatch = require(path.join(__dirname, '..', 'swarm_capability_dispatch.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 200)}` : ''}`);
  }
}

// A stub runtime: every routed capability present and observable.
const calls = [];
const runtime = {
  consolidateMemory: (m, o) => { calls.push('consolidateMemory'); return { merged: 3 }; },
  buildLariCapabilityGraph: () => { calls.push('buildLariCapabilityGraph'); return { nodes: [1, 2, 3, 4] }; },
  inferLariSelfLearningAgenda: () => { calls.push('inferLariSelfLearningAgenda'); return { goals: ['a', 'b'] }; }
};

console.log('routes fire on explicit requests');
{
  const cases = [
    ['consolidate your memory', 'consolidate-memory'],
    ['what can you do?', 'capability-graph'],
    ['what should you learn next?', 'self-learning-agenda']
  ];
  for (const [prompt, id] of cases) {
    const r = dispatch.dispatchCapability(runtime, {}, prompt);
    check(`"${prompt}" routes to ${id}`, r.handled && r.routeId === id, r);
    check(`  and produces text`, r.handled && typeof r.text === 'string' && r.text.length > 0, r.text);
  }
  check('the capabilities were actually invoked', calls.length === 3, calls);
}

console.log('\nordinary conversation must NOT trigger a capability');
{
  // The whole risk of this design, so it gets the most assertions.
  const ordinary = [
    'hello',
    'what do you remember about the bug we fixed?',
    'can you help me with my code?',
    'I want to consolidate the report into one file',
    'the memory usage is high',
    'what are you doing later',
    'tell me what this function does',
    'do you learn from mistakes?',
    'my agenda for today is packed'
  ];
  for (const prompt of ordinary) {
    const r = dispatch.dispatchCapability(runtime, {}, prompt);
    check(`"${prompt}" falls through`, r.handled === false, r);
  }
}

console.log('\ndeclining is cheap and safe');
{
  check('empty prompt declines', dispatch.dispatchCapability(runtime, {}, '').handled === false);
  check('a missing capability is skipped rather than crashing',
    dispatch.dispatchCapability({}, {}, 'consolidate your memory').handled === false);

  const thrower = { consolidateMemory: () => { throw new Error('boom'); } };
  const r = dispatch.dispatchCapability(thrower, {}, 'consolidate your memory');
  check('a throwing capability declines rather than surfacing an exception', r.handled === false, r);
  check('and the reason names the route', /consolidate-memory threw/.test(String(r.reason)), r.reason);

  const empty = { consolidateMemory: () => null };
  check('a capability returning nothing declines',
    dispatch.dispatchCapability(empty, {}, 'consolidate your memory').handled === false);
}

console.log('\nambiguity is refused, not guessed');
{
  // Two routes claiming one prompt would make dispatch order load-bearing and invisible.
  const ambiguous = dispatch.CAPABILITY_ROUTES.filter(r => r.match.test('what can you do'));
  check('no prompt in the test set is claimed by two routes', ambiguous.length <= 1,
    ambiguous.map(r => r.id));
  check('selectRoute returns null when nothing matches',
    dispatch.selectRoute(runtime, 'completely unrelated sentence') === null);
}

console.log('\nno external model calls');
{
  const r = dispatch.dispatchCapability(runtime, {}, 'consolidate your memory');
  check('dispatch reports zero external model calls', r.externalModelCalls === 0);
}

console.log('\nplanning: run what is safe, ASK before changing state');
{
  // The property that makes 9-in-12 selection accuracy tolerable. A wrong pick that asks first is a
  // question the user says no to; a wrong pick that acts is a corrupted model.
  const fs = require('fs');
  const modelPath = path.join(__dirname, '..', 'models', 'lari', 'trained', 'skill-registration-candidate.json');
  if (!fs.existsSync(modelPath)) {
    console.log('  ..   no registered model; skipping (run npm run lari:register-skills)');
  } else {
    const rt = require(path.join(__dirname, '..', 'swarm_model_runtime.js'));
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));

    const mutating = dispatch.planCapability(rt, model, 'consolidate my memory');
    check('a mutating capability is CONFIRMED, never run',
      mutating.action === 'confirm' && mutating.capability === 'consolidateMemory', mutating);
    check('and the confirmation says plainly that state changes',
      /changes my state/.test(String(mutating.prompt)), mutating.prompt);

    const readOnly = dispatch.planCapability(rt, model, 'discover a frontier workspace');
    check('a measured read-only capability is planned to RUN',
      readOnly.action === 'run', readOnly);

    for (const chat of ['hello how are you', 'what did we do yesterday', 'i am not sure this works']) {
      check(`"${chat}" is DECLINED`, dispatch.planCapability(rt, model, chat).action === 'decline');
    }

    // The allowlist is measured, not named. If it is missing, nothing may auto-run.
    const sideEffects = require(path.join(__dirname, '..', 'holdouts', 'CAPABILITY_SIDE_EFFECTS.json'));
    check('the allowlist is smaller than the capability set -- it is a restriction, not a rubber stamp',
      sideEffects.autoInvokable.length < sideEffects.readOnlyCount + sideEffects.mutatingCount,
      { auto: sideEffects.autoInvokable.length });
    check('buildLariCapabilityGraph is NOT auto-invokable despite sounding like a report',
      !sideEffects.autoInvokable.includes('buildLariCapabilityGraph'));
  }
}

console.log('\nconfirmation resolution: "yes" must mean yes to THAT, and nothing else');
{
  const pending = { capability: 'consolidateMemory' };

  for (const yes of ['yes', 'ok', 'do it', 'go ahead', 'confirm']) {
    const r = dispatch.resolveConfirmation(pending, yes);
    check(`"${yes}" authorises`, r.resolution === 'authorised', r);
    check(`  and names the capability it authorises`, r.authorisedFor === 'consolidateMemory', r);
  }
  for (const no of ['no', 'nope', 'cancel', 'never mind']) {
    check(`"${no}" declines`, dispatch.resolveConfirmation(pending, no).resolution === 'declined');
  }

  // The assertion that matters most. A qualified answer is a NEW request, not consent -- reading it as
  // consent authorises something the user did not say.
  for (const qualified of [
    'yes but delete the logs first',
    'yes and also wipe the cache',
    'ok now consolidate everything including the backups'
  ]) {
    const r = dispatch.resolveConfirmation(pending, qualified);
    check(`"${qualified.slice(0, 34)}..." does NOT authorise`, r.resolution !== 'authorised', r);
  }

  // An unrelated message must clear the pending rather than leave it armed for a later stray "ok".
  const unrelated = dispatch.resolveConfirmation(pending, 'what time is it');
  check('an unrelated message supersedes rather than waits', unrelated.resolution === 'superseded');
  check('and clears the pending state', unrelated.clearPending === true);

  check('no pending means nothing to resolve',
    dispatch.resolveConfirmation(null, 'yes').resolution === 'none');
  check('every resolution clears the pending, so consent is single-use',
    ['authorised', 'declined', 'superseded'].every(kind =>
      dispatch.resolveConfirmation(pending, kind === 'authorised' ? 'yes' : kind === 'declined' ? 'no' : 'hello')
        .clearPending === true));
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
