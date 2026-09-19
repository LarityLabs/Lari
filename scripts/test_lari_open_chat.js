#!/usr/bin/env node
'use strict';
// Open-chat routing/generation tests.
//
// Fail-before (2026-09-19 tutoring session): "hey whats up",
// "what does LARI stand for", and "check the thing for me" all collapsed onto
// the identical canned low-memory fallback because classifyChatIntent had no
// compound-greeting or self-identity patterns and synthesizeGeneralChatAnswer
// had no open_chat/self_identity branch. Pass-after: each gets a real,
// intent-appropriate answer, and no two of them share the canned fallback.
//
// Run: node scripts/test_lari_open_chat.js
const runtime = require('../swarm_model_runtime.js');

let passed = 0; let failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const CANNED = /I do not have enough local memory to answer that strongly yet/i;

async function ask(model, prompt) {
  const response = await runtime.sendMessageToLariAsync(model, { prompt }, {
    userScope: 'default',
    autoGrow: false,
    operator: false,
    kernel: { useBenchmarkSystem: false }
  });
  return String(response.answer || '');
}

async function main() {
  // --- intent classification ---
  check('classify: "hey whats up" -> small_talk',
    runtime.classifyChatIntent('hey whats up') === 'small_talk');
  check('classify: "yo whats up" -> small_talk',
    runtime.classifyChatIntent('yo whats up') === 'small_talk');
  check('classify: "whats up" -> small_talk',
    runtime.classifyChatIntent('whats up') === 'small_talk');
  check('classify: "what does LARI stand for" -> self_identity',
    runtime.classifyChatIntent('what does LARI stand for') === 'self_identity');
  check('classify: "who are you" -> self_identity',
    runtime.classifyChatIntent('who are you') === 'self_identity');
  check('classify: "who created you" -> self_identity',
    runtime.classifyChatIntent('who created you') === 'self_identity');
  check('classify: "check the thing for me" -> open_chat',
    runtime.classifyChatIntent('check the thing for me') === 'open_chat');
  // Negatives: longer/specific messages must not be swallowed.
  check('classify: "what are you working on" stays open_chat',
    runtime.classifyChatIntent('what are you working on') === 'open_chat');
  check('classify: "who are you talking about" stays open_chat',
    runtime.classifyChatIntent('who are you talking about') === 'open_chat');
  check('classify: "whats up with the server" stays open_chat',
    runtime.classifyChatIntent('whats up with the server') === 'open_chat');

  // --- end-to-end answers (fresh in-memory model) ---
  const model = {};

  const whatsUp = await ask(model, 'hey whats up');
  check('answer: "hey whats up" is not the canned fallback', !CANNED.test(whatsUp), whatsUp.slice(0, 80));
  check('answer: "hey whats up" reads like small talk', /vibing|on your mind|what is up/i.test(whatsUp), whatsUp.slice(0, 80));

  const acronym = await ask(model, 'what does LARI stand for');
  check('answer: acronym is not the canned fallback', !CANNED.test(acronym), acronym.slice(0, 80));
  check('answer: acronym expands LARI', /Local Autonomous Recursive Intelligence/i.test(acronym), acronym.slice(0, 80));

  const vague = await ask(model, 'check the thing for me');
  check('answer: vague request is not the canned fallback', !CANNED.test(vague), vague.slice(0, 80));
  check('answer: vague request gets one clarification question', /\?/.test(vague) && /which thing|what/i.test(vague), vague.slice(0, 80));

  const bluntNo = await ask(model, 'naw man, that wasnt an answer');
  check('answer: blunt correction is acknowledged, not deflected',
    !CANNED.test(bluntNo) && /fair|missed|after/i.test(bluntNo), bluntNo.slice(0, 80));

  const math = await ask(model, 'whats 12 * 8');
  check('answer: "whats 12 * 8" reaches the math lane', !CANNED.test(math) && /96/.test(math), math.slice(0, 80));

  // The previously-broken answers must now differ from each other.
  const distinct = new Set([whatsUp, acronym, vague, bluntNo]).size === 4;
  check('answers are distinct across the previously-broken prompts', distinct);

  // --- neighboring intents still intact ---
  const greeting = await ask(model, 'hey');
  check('regression: greeting intact', !CANNED.test(greeting) && /yo\.|i am here|i am local|what is good/i.test(greeting), greeting.slice(0, 60));
  const joke = await ask(model, 'tell me a joke');
  check('regression: joke intact', !CANNED.test(joke) && joke.length > 10, joke.slice(0, 60));
  const howAreYou = await ask(model, 'how are you');
  check('regression: small_talk intact', !CANNED.test(howAreYou), howAreYou.slice(0, 60));

  // --- fuzzy phatic layer (2026-09-19): every tutoring-session miss that is
  // a short casual turn now routes small_talk with a natural varied reply,
  // never the canned dodge. ---
  const FUZZY_PHRASES = ['hey again', 'good', 'alright man', 'ok bye', 'lol nice',
    'youre welcome', 'good talk', 'im back', 'chillin', 'nothing', 'nevermind',
    'sure', 'wait', 'no updates', 'psych im still here'];
  for (const phrase of FUZZY_PHRASES) {
    check(`fuzzy classify: "${phrase}" -> small_talk`,
      runtime.classifyChatIntent(phrase) === 'small_talk');
  }
  // Near-miss variants (extra word) still clear the 0.5 Jaccard threshold.
  for (const phrase of ['ok bye then', 'chillin man', 'hey again man', 'nothing much']) {
    check(`fuzzy classify: "${phrase}" -> small_talk`,
      runtime.classifyChatIntent(phrase) === 'small_talk');
  }
  // Content questions stay out: "are you a he" scores 0.4 against the
  // "you are welcome" prototype, below the 0.5 threshold.
  check('fuzzy: "are you a he" stays open_chat (below threshold)',
    runtime.classifyChatIntent('are you a he') === 'open_chat');
  check('fuzzy: "what are you working on" stays open_chat',
    runtime.classifyChatIntent('what are you working on') === 'open_chat');

  const fuzzyModel = {};
  const DODGE = /not sure what you are after|did not quite catch|a bit vague for me|what were you actually after|enough local memory/i;
  for (const phrase of FUZZY_PHRASES) {
    const a = await ask(fuzzyModel, phrase);
    check(`fuzzy answer: "${phrase}" is natural small talk, never the dodge`,
      a.length > 2 && !CANNED.test(a) && !DODGE.test(a), a.slice(0, 70));
  }

  // Phrases the anchored patterns already handled keep their intents and
  // answers exactly.
  const SAME = [['hey', 'greeting'], ['yo', 'greeting'], ['sup', 'greeting'],
    ['whats up', 'small_talk'], ['thanks', 'thanks'], ['sweet', 'reaction_hype'],
    ['bye', 'goodbye'], ['later', 'goodbye'], ['see ya', 'goodbye'],
    ['lol', 'reaction_laugh'], ['ok', 'reaction_ack']];
  for (const [phrase, want] of SAME) {
    check(`fuzzy no-override: "${phrase}" still -> ${want}`,
      runtime.classifyChatIntent(phrase) === want);
  }
  const sameModel = {};
  for (const [phrase] of SAME) {
    const a = await ask(sameModel, phrase);
    check(`fuzzy no-override answer: "${phrase}" not dodged`, !CANNED.test(a) && a.length > 1, a.slice(0, 50));
  }
  // Anchored small-talk answers are not hijacked by the fuzzy reply layer.
  const whatsGood = await ask({}, 'whats good');
  check('fuzzy no-hijack: "whats good" keeps its anchored answer',
    /same old/i.test(whatsGood), whatsGood.slice(0, 60));

  // --- recap-skip behavior intact: small talk never routes through the
  // recap executable-language path. ---
  async function askFull(m, prompt) {
    return runtime.sendMessageToLariAsync(m, { prompt }, {
      userScope: 'default', autoGrow: false, operator: false,
      kernel: { useBenchmarkSystem: false }
    });
  }
  for (const phrase of ['hey again', 'ok bye', 'nevermind', 'good night']) {
    const resp = await askFull({}, phrase);
    check(`recap-skip: "${phrase}" does not use recap path`,
      resp.publicAnswerSource !== 'recap_executable_language'
      && !(resp.recapLearnedRecordIds || []).length);
  }

  // --- response variety: two consecutive vague/deflection answers are never
  // the identical canned line. ---
  const varietyModel = {};
  const v1 = await ask(varietyModel, 'check the thing for me');
  const v2 = await ask(varietyModel, 'check the thing for me');
  check('variety: repeated vague request gets different phrasing', v1 !== v2, `${v1.slice(0, 40)} || ${v2.slice(0, 40)}`);
  check('variety: vague phrasing still asks a clarification', /\?/.test(v2) && /which thing|what/i.test(v2), v2.slice(0, 60));
  const d1 = await ask(varietyModel, 'brb');
  const d2 = await ask(varietyModel, 'brb');
  check('variety: repeated deflection is never identical', d1 !== d2 && !CANNED.test(d2), `${d1.slice(0, 40)} || ${d2.slice(0, 40)}`);
  const b1 = await ask(varietyModel, 'naw man that wasnt an answer');
  const b2 = await ask(varietyModel, 'naw man that wasnt an answer');
  check('variety: repeated blunt correction gets varied acknowledgment',
    b1 !== b2 && /fair|missed|after|bad|again/i.test(b2), `${b1.slice(0, 40)} || ${b2.slice(0, 40)}`);

  // --- recap/catch-up callback: episode topics exclude phatic filler so the
  // greeting catch-up reads like a natural summary ("nevermind and thing"
  // must never surface as a topic again). Drives the real finalization path
  // with a stale (>6h) injected draft. ---
  const recapModel = {};
  const staleAt = new Date(Date.now() - 7 * 3600000).toISOString();
  recapModel.userModel = {
    conversationContext: {
      default: {
        episodeDraft: [
          { message: 'nevermind', intent: 'open_chat', timestamp: staleAt },
          { message: 'check the thing for me', intent: 'open_chat', timestamp: staleAt },
          { message: 'what is the capital of france', intent: 'explanation', timestamp: staleAt },
          { message: 'the dell server setup is going well', intent: 'open_chat', timestamp: staleAt },
          { message: 'tell me about the france trip planning', intent: 'planning', timestamp: staleAt }
        ]
      }
    }
  };
  await ask(recapModel, 'hey');
  const epScopes = recapModel.userModel.episodicMemories || {};
  const episodes = Object.values(epScopes).flat();
  check('recap: stale episode finalized', episodes.length > 0);
  const epTopics = (episodes[0] && episodes[0].topics) || [];
  check('recap: topics exclude phatic filler',
    !epTopics.includes('nevermind') && !epTopics.includes('thing') && !epTopics.includes('well'),
    epTopics.join(', '));
  check('recap: topics keep real content',
    epTopics.includes('france') || epTopics.includes('capital') || epTopics.includes('server'),
    epTopics.join(', '));
  check('recap: summary reads like a natural summary',
    /discussed/i.test(episodes[0].summary) && !/nevermind/i.test(episodes[0].summary),
    String(episodes[0].summary).slice(0, 90));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('failures:', failures.join(', ')); process.exit(1); }
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
