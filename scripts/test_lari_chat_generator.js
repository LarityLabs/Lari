#!/usr/bin/env node
/**
 * Demo + assertions for Lari chat generator v2 (generate-score-select).
 *
 * Exercises the live wired path (sendMessageToLariAsync, flag default on)
 * across one multi-turn conversation and asserts:
 *  1. "my name is Greg" -> later "what is my name" answers Greg (v2 memory
 *     candidate wins; the trace says so).
 *  2. A factual question on a topic with no grounded knowledge triggers one
 *     live research attempt and answers from the researched sentences, with
 *     the trace recording it.
 *  3. A greeting is handled without the old vague fallback.
 *  4. Replies across turns read like one consistent personality (voice
 *     scores clustered, none purple).
 *
 * The research store file is backed up before the run and restored after.
 * Exit 0 on all assertions passing, 1 otherwise.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const BASE_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const STORE = path.join(ROOT, 'models', 'lari', 'current', 'researched-knowledge.json');
const BACKUP = STORE + '.v2demo-bak';
// Hermetic STORE: back up and clear BEFORE requiring the runtime, because the
// runtime loads researched knowledge into memory at require time. The research
// tests expect live research to trigger, which requires an empty store.
if (fs.existsSync(STORE)) fs.copyFileSync(STORE, BACKUP);
fs.writeFileSync(STORE, '[]');

const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
const voice = require('./lari_voice_profile.js');

const SCRATCH = path.join(process.env.HOME || '/root', 'workspace', 'scratch', 'lari-chat-v2-demo');
fs.mkdirSync(SCRATCH, { recursive: true });

const TURN_TIMEOUT_MS = 120000;

function freshModel(tag) {
  const dst = path.join(SCRATCH, `model-${tag}-${process.pid}-${Date.now()}.json`);
  const m = JSON.parse(fs.readFileSync(BASE_MODEL, 'utf8'));
  m.__lariSourcePath = dst;
  fs.writeFileSync(dst, JSON.stringify(m));
  return JSON.parse(fs.readFileSync(dst, 'utf8'));
}

// Seed durable beliefs in the exact shape consolidateUserMemory produces,
// simulating what the nightly consolidation would have distilled from
// earlier sessions. Read-only for the generator under test.
function seedBeliefs(model, beliefs) {
  const now = new Date().toISOString();
  model.lariConsolidatedBeliefs = {
    version: 1,
    updatedAt: now,
    beliefs: beliefs.map((b, i) => ({
      id: b.id || `belief.seed.${i}`,
      type: b.type,
      subject: b.subject || 'user',
      predicate: b.predicate,
      object: b.object,
      text: b.text || `the user's ${b.predicate} is ${b.object}`,
      confidence: b.confidence || 0.85,
      scope: 'default',
      provenance: ['seeded-test'],
      createdAt: now,
      observedAt: now,
      status: 'active',
      supersededBy: null
    }))
  };
  return model;
}

function replyText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  return String(r.answer || r.text || r.reply || '').trim();
}

async function turn(model, text) {
  const p = runtime.sendMessageToLariAsync(model, text, {});
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), TURN_TIMEOUT_MS));
  const r = await Promise.race([p, timeout]);
  return { reply: replyText(r), raw: r };
}

function phase(trace, name) {
  if (!trace || !Array.isArray(trace.phases)) return null;
  return trace.phases.find(p => p.phase === name) || null;
}

const failures = [];
function check(name, cond, note) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' -- ' + note}`);
  if (!cond) failures.push(name);
}

(async () => {
  console.log('store backed up (hermetic empty store for test)');

  const model = freshModel('v2demo');
  const transcript = [];

  async function say(m, text, quiet) {
    const { reply, raw } = await turn(m, text);
    const v2 = raw && raw.chatV2 ? raw.chatV2 : null;
    const speak = phase(v2, 'speak');
    const gather = phase(v2, 'gather');
    const genScore = phase(v2, 'generate_score');
    transcript.push({ text, reply, v2, action: raw && raw.action });
    if (!quiet) {
      console.log(`\n> ${text}`);
      console.log(`< ${reply}`);
    }
    if (v2) {
      if (!quiet) {
        console.log(`  [v2] action=${raw.action} winner=${speak ? speak.winner : 'n/a'}`);
        if (gather) console.log(`  [v2 gather] facts=${JSON.stringify(gather.personalFacts)} durable=${JSON.stringify(gather.durableFacts)} researched=${JSON.stringify(gather.researchedTopics)} researchRan=${JSON.stringify(gather.researchRan)}`);
        if (genScore) console.log(`  [v2 candidates] ${genScore.candidates.map(c => `${c.strategy}:${c.total}${c.factSource ? '(' + c.factSource + ')' : ''}`).join(' ')}`);
      }
    } else if (!quiet) {
      console.log(`  [old path] action=${raw && raw.action}`);
    }
    return { reply, raw, v2, speak, gather, genScore };
  }

  function memCandidate(gs) {
    return gs && gs.candidates.find(c => c.strategy === 'memory');
  }

  console.log('\n== v2 demo conversation ==');
  const t1 = await say(model, 'my name is Greg');
  const t2 = await say(model, 'what is my name');
  const t3 = await say(model, 'what is vibe coding');
  const t4 = await say(model, 'hey');
  const t5 = await say(model, 'thanks');
  const t6 = await say(model, 'are you a boy or a girl');

  console.log('\n== assertions ==');
  check('name statement acknowledged (no vague fallback)',
    t1.reply.length > 3 && !/that is a bit vague for me/i.test(t1.reply) && /greg/i.test(t1.reply),
    t1.reply.slice(0, 80));
  check('name recall answers Greg', /greg/i.test(t2.reply), t2.reply.slice(0, 80));
  const memCand = memCandidate(t2.genScore);
  check('memory candidate present and viable in recall trace',
    !!(memCand && memCand.total > 0.5),
    JSON.stringify(t2.genScore && t2.genScore.candidates));
  check('vibe coding answer mentions vibe coding', /vibe coding/i.test(t3.reply), t3.reply.slice(0, 80));
  check('vibe coding answer is substantive', t3.reply.length > 60, `${t3.reply.length} chars`);
  check('vibe coding grounded in researched knowledge',
    t3.gather && t3.gather.researchedTopics.some(t => /vibe coding/i.test(t)),
    JSON.stringify(t3.gather && t3.gather.researchedTopics));
  check('vibe coding triggered live research',
    t3.gather && t3.gather.researchRan && t3.gather.researchRan.added > 0,
    JSON.stringify(t3.gather && t3.gather.researchRan));
  check('greeting has no vague fallback',
    t4.reply.length > 3 && !/that is a bit vague for me/i.test(t4.reply),
    t4.reply.slice(0, 80));
  check('identity answer is he/him', /\b(he|him|boy|male|dude)\b/i.test(t6.reply) && !/\bshe\b/i.test(t6.reply),
    t6.reply.slice(0, 80));
  check('hey triggers no research',
    !!(t4.gather && t4.gather.researchRan === null),
    JSON.stringify(t4.gather && t4.gather.researchRan));
  check('thanks triggers no research',
    !!(t5.gather && t5.gather.researchRan === null),
    JSON.stringify(t5.gather && t5.gather.researchRan));

  // ---- (b) knowledge-need research on an open_chat intent ----
  console.log('\n== knowledge-need research (open_chat intent) ==');
  const t7 = await say(model, 'tell me about fusion power');
  check('fusion power triggered live research (intent did not gate it)',
    t7.gather && t7.gather.researchRan && t7.gather.researchRan.added > 0,
    JSON.stringify(t7.gather && t7.gather.researchRan));
  check('fusion power answer is substantive and grounded',
    t7.reply.length > 80 && /fusion/i.test(t7.reply) && !/that is a bit vague for me/i.test(t7.reply),
    t7.reply.slice(0, 100));

  // ---- misfire probes: these must NOT trigger v2 research ----
  console.log('\n== misfire probes (must not research) ==');
  const p1 = await say(model, 'explain yourself');
  check('explain yourself triggers no research',
    !p1.v2 || !!(p1.gather && p1.gather.researchRan === null),
    p1.v2 ? JSON.stringify(p1.gather && p1.gather.researchRan) : 'old path');
  const p2 = await say(model, 'can you see my screen right now');
  console.log(`  [probe] can you see my screen right now -> ${p2.v2 ? 'v2' : 'old path'}: ${p2.reply.slice(0, 70)}`);
  check('can you see my screen stays on old path (not knowledge-seeking)',
    !p2.v2 || !!(p2.gather && p2.gather.researchRan === null),
    p2.v2 ? 'v2 engaged' : 'old path');

  // ---- (a1) durable memory: fact stated early, buried under 16 fillers ----
  console.log('\n== durable memory: stated fact buried under 16 fillers ==');
  const modelB = seedBeliefs(freshModel('v2durable'), [
    { type: 'identity', predicate: 'favorite food', object: 'tacos' }
  ]);
  await say(modelB, 'my favorite food is tacos', true);
  const fillers = ['hey', 'lol', 'nice', 'thanks', 'ok', 'haha', 'cool', 'damn',
    'got it', 'fr', 'sweet', 'dope', 'lol', 'nice', 'yo', 'sup'];
  for (const f of fillers) await say(modelB, f, true);
  console.log(`  ... ${fillers.length} filler turns done`);
  const tB = await say(modelB, 'what is my favorite food');
  const memB = memCandidate(tB.genScore);
  check('buried fact recalled after 16 fillers', /taco/i.test(tB.reply), tB.reply.slice(0, 80));
  check('durable memory candidate present, viable, sourced durable',
    !!(memB && memB.total > 0.5 && memB.factSource === 'durable'),
    JSON.stringify(tB.genScore && tB.genScore.candidates));

  // ---- (a2) airtight: durable belief ONLY, never stated this session ----
  // The old lane's episodic session memory spans 40+ turns, so filler-burial
  // alone cannot isolate the durable mechanism. A belief never stated in
  // this session can only be recalled via the durable path.
  console.log('\n== durable memory: belief-only (never stated in session) ==');
  const modelC = seedBeliefs(freshModel('v2durable-only'), [
    { type: 'identity', predicate: 'favorite food', object: 'tacos' }
  ]);
  await say(modelC, 'hey', true);
  await say(modelC, 'lol', true);
  await say(modelC, 'thanks', true);
  const tC = await say(modelC, 'what is my favorite food');
  const memC = memCandidate(tC.genScore);
  check('belief-only fact recalled (old lane cannot know it)', /taco/i.test(tC.reply), tC.reply.slice(0, 80));
  check('durable memory candidate WINS the belief-only recall',
    !!(tC.speak && tC.speak.winner === 'memory' && memC && memC.factSource === 'durable'),
    `winner=${tC.speak && tC.speak.winner} ${JSON.stringify(tC.genScore && tC.genScore.candidates)}`);

  const replies = [t1.reply, t2.reply, t3.reply, t4.reply, t5.reply, t6.reply, t7.reply, tB.reply, tC.reply];
  const vscores = replies.map(r => voice.voiceScore(r).score);
  console.log(`\nvoice scores: ${vscores.map(s => s.toFixed(2)).join(' ')}`);
  const spread = Math.max(...vscores) - Math.min(...vscores);
  check('voice scores all above 0.35', vscores.every(s => s > 0.35), vscores.map(s => s.toFixed(2)).join(' '));
  check('voice is consistent (spread < 0.5)', spread < 0.5, `spread=${spread.toFixed(2)}`);
  check('no em dashes in replies', replies.every(r => !r.includes('\u2014')), 'found em dash');

  fs.copyFileSync(BACKUP, STORE);
  fs.unlinkSync(BACKUP);
  console.log('\nstore restored');

  console.log(failures.length ? `\nRESULT: FAIL (${failures.length})` : '\nRESULT: ALL PASS');
  process.exit(failures.length ? 1 : 0);
})().catch(e => {
  try { fs.copyFileSync(BACKUP, STORE); fs.unlinkSync(BACKUP); } catch (_) {}
  console.error('demo error:', e);
  process.exit(2);
});
