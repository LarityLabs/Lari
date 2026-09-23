/**
 * swarm_gym_chat.js — the TEXT side of Lari's gym outer loop.
 *
 * Connects the chat runtime to the numeric gym harness:
 *   this module (text/symbolic) proposes envs and policy families from a
 *   chat message; swarm_gym.js (numeric) executes induction, evaluation,
 *   and demos. Nothing here does math beyond parsing and summarizing.
 *
 * Entry point: handleGymMessage(model, text, opts) -> Promise<{handled, reply}>
 *   Returns {handled:false} when the message is not gym-related, so the
 *   normal chat path keeps it.
 *
 * Commands (prefix /gym, or natural phrasing containing "gym"/"policy"):
 *   /gym list                      envs + policy families
 *   /gym demo <env>                short demo episodes via GymSession, score + trace
 *   /gym train <env> [family] [n]  run inducePolicy, retain to model, report
 *   /gym policies                  retained gym policies and their scores
 *   /gym propose <free text>       text -> env/family proposal, no execution
 *
 * Sandboxing is unchanged: every numeric call spawns gym_bridge.py as a
 * fresh one-shot child (or a short-lived --serve session for demos);
 * induced policy code runs with restricted builtins inside that child.
 */

'use strict';

const gym = require('./swarm_gym.js');

const ENV_ALIASES = [
  { env: 'CartPole-v1', keys: ['cartpole', 'cart pole', 'pole balanc', 'balancing pole'] },
  { env: 'Blackjack-v1', keys: ['blackjack', 'black jack', 'card game', 'twenty-one'] },
  { env: 'FrozenLake-v1', keys: ['frozenlake', 'frozen lake', 'frozen', 'slippery', 'ice lake'] },
  { env: 'Taxi-v3', keys: ['taxi'] }
];

function detectEnv(text) {
  const t = String(text || '').toLowerCase();
  for (const { env, keys } of ENV_ALIASES) {
    if (keys.some((k) => t.includes(k))) return env;
  }
  return null;
}

function defaultFamily(envId) {
  const space = gym.POLICY_SPACES[envId];
  if (!space) return null;
  return space.defaultFamily || 'default';
}

function detectFamily(envId, text) {
  const t = String(text || '').toLowerCase();
  const space = gym.POLICY_SPACES[envId];
  if (!space || !space.families) return defaultFamily(envId);
  const names = Object.keys(space.families);
  if (/\btable\b|tabular|state.action|full/.test(t)) {
    const hit = names.find((n) => n === 'table');
    if (hit) return hit;
  }
  if (/\bthreshold\b|simple|coarse/.test(t)) {
    const hit = names.find((n) => n === 'threshold');
    if (hit) return hit;
  }
  return defaultFamily(envId);
}

/**
 * The text-side proposal: free text -> {env, family, rationale}.
 * No execution happens here; the numeric loop runs later.
 */
function proposeFromText(text) {
  const env = detectEnv(text);
  if (!env) {
    return {
      env: null,
      family: null,
      rationale: 'no known environment mentioned',
      suggestion: 'Known envs: CartPole-v1, Blackjack-v1, FrozenLake-v1, Taxi-v3.'
    };
  }
  const family = detectFamily(env, text);
  const space = gym.POLICY_SPACES[env];
  const families = space.families ? Object.keys(space.families).join(', ') : 'default';
  return {
    env,
    family,
    rationale: `matched "${env}" from the message; family "${family}" (available: ${families})`,
    suggestion: null
  };
}

function parseGymIntent(text) {
  const t = String(text || '').trim();
  const m = t.match(/^\/gym\s+(\w+)\s*([\s\S]*)$/i);
  if (m) {
    const sub = m[1].toLowerCase();
    const rest = (m[2] || '').trim();
    if (!['list', 'demo', 'train', 'policies', 'propose', 'help'].includes(sub)) {
      return { cmd: 'unknown', sub, rest };
    }
    const env = detectEnv(rest) || detectEnv(sub === 'demo' || sub === 'train' ? rest : '');
    const family = env ? detectFamily(env, rest) : null;
    const gens = parseInt((rest.match(/\b(\d+)\s*(?:generations|gens|rounds)?\b/i) || [])[1], 10);
    return { cmd: sub === 'help' ? 'list' : sub, sub, rest, env, family, generations: isNaN(gens) ? undefined : gens };
  }
  // Conservative natural phrasing: requires the word gym or policy.
  if (!/\bgym\b|policy|policies/i.test(t)) return null;
  if (/\bdemo\b|watch|show me|play/i.test(t)) {
    const p = proposeFromText(t);
    return { cmd: 'demo', rest: t, env: p.env, family: p.family };
  }
  if (/\btrain\b|teach|induce|learn\b/i.test(t)) {
    const p = proposeFromText(t);
    return { cmd: 'train', rest: t, env: p.env, family: p.family };
  }
  if (/\bpropose\b|suggest/i.test(t)) {
    const p = proposeFromText(t);
    return { cmd: 'propose', rest: t, env: p.env, family: p.family };
  }
  return null;
}

function listEnvsText() {
  const lines = ['Gym environments I can practice in:'];
  for (const envId of Object.keys(gym.POLICY_SPACES)) {
    const space = gym.POLICY_SPACES[envId];
    const fams = space.families ? Object.keys(space.families).join(', ') : 'default';
    lines.push(`- ${envId} (families: ${fams})`);
  }
  lines.push('Try: /gym demo CartPole-v1  or  /gym train Blackjack-v1 table');
  return lines.join('\n');
}

/**
 * Pick the policy a demo runs: best retained policy for the env, else a
 * DP-derived policy when the env exposes a transition model, else a quick
 * induction (few generations). Returns {code, label}.
 */
function resolveDemoPolicy(model, envId, opts = {}) {
  const retained = gym.getGymPolicies(model).filter((p) => p.env === envId);
  if (retained.length) {
    retained.sort((a, b) => (b.meanReward || 0) - (a.meanReward || 0));
    const p = retained[0];
    return { code: p.code, label: `retained ${p.policyId} (fresh eval ${fmt(p.meanReward)} avg)` };
  }
  const tr = gym.getTransitions(envId);
  if (tr && tr.ok) {
    const dp = gym.derivePolicyDP(envId, { freshEpisodes: 200 });
    return { code: dp.code, label: `DP-derived just now (fresh eval ${fmt(dp.meanReward)} avg over ${dp.evalEpisodes} episodes)` };
  }
  const rec = gym.inducePolicy(envId, {
    family: defaultFamily(envId),
    generations: 3, popSize: 6,
    seed: opts.seed === undefined ? 1 : opts.seed
  });
  return { code: rec.code, label: `quick induction just now (fresh eval ${fmt(rec.meanReward)} avg over ${rec.evalEpisodes} episodes)` };
}

function fmt(x) {
  if (typeof x !== 'number' || !isFinite(x)) return String(x);
  return String(Math.round(x * 1000) / 1000);
}

function formatTrace(envId, trace) {
  if (!trace || !trace.length) return '(no trace recorded)';
  const lines = [];
  const show = trace.slice(0, 12);
  for (let i = 0; i < show.length; i++) {
    const [obs, action, reward] = show[i];
    lines.push(`step ${i}: obs=[${obs.map(fmt).join(', ')}] action=${action} reward=${fmt(reward)}`);
  }
  if (trace.length > show.length) lines.push(`... (${trace.length - show.length} more steps)`);
  return lines.join('\n');
}

async function cmdDemo(model, intent, opts = {}) {
  const proposal = intent.env ? { env: intent.env, family: intent.family } : proposeFromText(intent.rest);
  if (!proposal.env) {
    return 'Which environment? ' + (proposeFromText('').suggestion || '');
  }
  const { code, label } = resolveDemoPolicy(model, proposal.env, opts);
  const res = await gym.demoPolicy(proposal.env, code, {
    episodes: opts.demoEpisodes || 5,
    seed: opts.seed === undefined ? 42 : opts.seed
  });
  if (!res || !res.ok) {
    return `Demo failed on ${proposal.env}: ${res && res.error ? res.error : 'no response'}. The gym venv may be missing.`;
  }
  return [
    `Demo: ${proposal.env} with ${label}.`,
    `Score over ${res.episodes} episodes: mean ${fmt(res.mean)} (std ${fmt(res.std)}).`,
    'First episode trace:',
    formatTrace(proposal.env, res.trace)
  ].join('\n');
}

function cmdTrain(model, intent, opts = {}) {
  const proposal = intent.env ? { env: intent.env, family: intent.family } : proposeFromText(intent.rest);
  if (!proposal.env) {
    return 'Which environment should I train on? Known envs: CartPole-v1, Blackjack-v1, FrozenLake-v1, Taxi-v3.';
  }
  const generations = Math.max(1, Math.min(15, intent.generations || opts.generations || 6));
  const rec = gym.inducePolicy(proposal.env, {
    family: proposal.family,
    generations,
    popSize: 8,
    seed: opts.seed === undefined ? 1 : opts.seed
  });
  let retainedNote = '';
  if (opts.retain !== false) {
    const added = gym.retainGymPolicy(model, rec);
    retainedNote = added ? ' Retained to model state.' : ' Already retained (same policyId).';
  }
  return [
    `Trained ${proposal.env} with the "${rec.family}" family for ${rec.generations} generations (${rec.totalEvals} evals).`,
    `Train mean ${fmt(rec.trainMean)}, fresh eval on ${rec.evalEpisodes} unseen episodes: mean ${fmt(rec.meanReward)} (std ${fmt(rec.stdReward)}).`,
    'Policy code kept as retained state:',
    rec.code.trim()
  ].join('\n') + retainedNote;
}

function cmdPolicies(model) {
  const ps = gym.getGymPolicies(model);
  if (!ps.length) return 'No gym policies retained yet. Try /gym train CartPole-v1.';
  const lines = ['Retained gym policies:'];
  for (const p of ps) {
    lines.push(`- ${p.policyId} [${p.env}/${p.family || 'default'}]: fresh mean ${fmt(p.meanReward)} over ${p.evalEpisodes} episodes (learned ${p.learnedAt || '?'})`);
  }
  return lines.join('\n');
}

function cmdPropose(intent) {
  const p = intent.env ? { env: intent.env, family: intent.family, rationale: 'parsed from your command' } : proposeFromText(intent.rest);
  if (!p.env) return 'I could not match an environment. ' + (proposeFromText('').suggestion || '');
  return [
    `Proposal: train ${p.env} with the "${p.family}" family.`,
    `Rationale: ${p.rationale}.`,
    'The numeric loop would run: inducePolicy -> fresh-seed evaluation -> retain if it beats the bar.',
    'Say "/gym train" to run it, or "/gym demo" to watch the current best first.'
  ].join('\n');
}

/**
 * Main entry: route a chat message. Returns {handled, reply}.
 * opts: {retain, seed, generations, demoEpisodes}
 */
async function handleGymMessage(model, text, opts = {}) {
  const intent = parseGymIntent(text);
  if (!intent) return { handled: false, reply: null };
  try {
    switch (intent.cmd) {
      case 'list':
        return { handled: true, reply: listEnvsText() };
      case 'demo':
        return { handled: true, reply: await cmdDemo(model || {}, intent, opts) };
      case 'train':
        return { handled: true, reply: cmdTrain(model || {}, intent, opts) };
      case 'policies':
        return { handled: true, reply: cmdPolicies(model || {}) };
      case 'propose':
        return { handled: true, reply: cmdPropose(intent) };
      default:
        return { handled: true, reply: 'Gym commands: /gym list | /gym demo <env> | /gym train <env> [family] | /gym policies | /gym propose <text>' };
    }
  } catch (err) {
    return { handled: true, reply: `Gym command failed: ${String((err && err.message) || err).slice(0, 300)}` };
  }
}

module.exports = {
  handleGymMessage,
  parseGymIntent,
  proposeFromText,
  detectEnv,
  resolveDemoPolicy
};
