/**
 * swarm_gym.js — Lari's gym harness (Node side).
 *
 * Outer loop (text/symbolic, Node): propose policy parameters, hill-climb.
 * Inner loop (numeric, Python): gym_bridge.py runs Gymnasium envs; the policy
 * is induced CODE (e.g. `if obs[2] > 0.08: return 1`) executed against raw
 * numeric observation vectors. No English in the hot loop.
 *
 * Sandboxing: every evaluation spawns gym_bridge.py as a fresh one-shot
 * child process (spawnSync + hard timeout + captured stdio), the same bar as
 * teach.runCodeSandbox. Induced policy source runs inside that child with
 * restricted builtins (no imports, no I/O).
 *
 * Persistence follows swarm_code_self_teach.js patterns:
 *   model.lariCodeGeneration.gymPolicies[] = {
 *     policyId, env, language:'python', code, params,
 *     meanReward, stdReward, evalEpisodes, evalSeed,
 *     generations, source:'gym-induction', learnedAt
 *   }
 *
 * CLI:
 *   node swarm_gym.js --list-envs
 *   node swarm_gym.js --env CartPole-v1 [--generations 10 --popsize 8 --seed 1]
 *   node swarm_gym.js --env CartPole-v1 --retain /path/to/model.json
 *   node swarm_gym.js --codegym py-fibonacci-10
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Bridge plumbing
// ---------------------------------------------------------------------------

function gymPython() {
  if (process.env.LARI_GYM_PYTHON) return process.env.LARI_GYM_PYTHON;
  const venv = path.join(os.homedir(), 'workspace', 'venvs', 'lari-gym', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return 'python3';
}

const BRIDGE = path.join(__dirname, 'gym_bridge.py');

function bridgeOnce(request, timeoutMs = 120000) {
  const run = spawnSync(gymPython(), [BRIDGE], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  if (run.error) {
    return { ok: false, error: 'bridge spawn failed: ' + String((run.error && run.error.message) || run.error) };
  }
  const out = String(run.stdout || '').trim();
  if (!out) {
    return { ok: false, error: 'bridge empty output; stderr: ' + String(run.stderr || '').slice(0, 300) };
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    return { ok: false, error: 'bridge bad JSON: ' + out.slice(0, 300) };
  }
}

function listEnvs() {
  return bridgeOnce({ cmd: 'envs' });
}

function evaluatePolicy(envId, policyCode, opts = {}) {
  const res = bridgeOnce({
    cmd: 'evaluate',
    env: envId,
    policy: policyCode,
    episodes: opts.episodes || 30,
    max_steps: opts.maxSteps,
    seed: opts.seed || 0
  }, opts.timeoutMs || 180000);
  return res;
}

/**
 * Interactive session: long-lived bridge child over NDJSON (--serve).
 * For outer-loop inspection / demos: reset() then step(action) in a loop.
 */
class GymSession {
  constructor(envId, seed = 0) {
    this.envId = envId;
    this.seed = seed;
    this.child = null;
    this.buffer = '';
    this.pending = [];
  }
  start() {
    this.child = spawn(gymPython(), [BRIDGE, '--serve'], { windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const waiter = this.pending.shift();
        if (waiter) {
          try { waiter.resolve(JSON.parse(line)); }
          catch (e) { waiter.reject(e); }
        }
      }
    });
    this.child.on('error', (err) => {
      while (this.pending.length) this.pending.shift().reject(err);
    });
  }
  send(req) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(req) + '\n');
    });
  }
  reset(seed) {
    return this.send({ cmd: 'reset', env: this.envId, seed: seed === undefined ? this.seed : seed });
  }
  step(action) {
    return this.send({ cmd: 'step', action });
  }
  close() {
    if (this.child) { try { this.child.kill(); } catch (_) {} this.child = null; }
  }
}

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function fmtNum(x) {
  if (!isFinite(x)) return '0.0';
  const r = Math.round(x * 1e6) / 1e6;
  return String(r).includes('.') ? String(r) : String(r) + '.0';
}

// ---------------------------------------------------------------------------
// Policy spaces: params -> code, seeds, mutation. One per env.
// ---------------------------------------------------------------------------

const POLICY_SPACES = {
  // CartPole-v1 obs: [cart_pos, cart_vel, pole_angle, pole_vel].
  // Linear threshold controller on angle + angular velocity.
  'CartPole-v1': {
    evalEpisodes: 30,
    freshEvalEpisodes: 100,
    solvedAt: 475,
    seedParams: [[1, 0, 0], [1, 0.5, 0], [1, 1, 0], [0.5, 1, 0]],
    toCode([c2, c3, t]) {
      return `def act(obs):\n    return 1 if (${fmtNum(c2)}*obs[2] + ${fmtNum(c3)}*obs[3] > ${fmtNum(t)}) else 0\n`;
    },
    mutate(p, rnd) {
      const q = p.slice();
      const i = Math.floor(rnd() * 3);
      const scale = i === 2 ? 0.05 : 0.25;
      q[i] += gauss(rnd) * scale;
      return q;
    }
  },
  // FrozenLake-v1: obs arrives as [state] (0..15 on the 4x4 map).
  // Tabular policy: dict state->action plus a default action.
  'FrozenLake-v1': {
    evalEpisodes: 100,
    freshEvalEpisodes: 200,
    solvedAt: 0.7,
    seedParams: null, // built in seeds()
    seeds(rnd) {
      const mk = (fn) => ({ table: Array.from({ length: 16 }, (_, s) => fn(s)), def: 0 });
      const out = [mk(() => 2), mk(() => 1), mk(() => 0), mk(() => 3)];
      for (let k = 0; k < 4; k++) out.push(mk(() => Math.floor(rnd() * 4)));
      return out;
    },
    toCode({ table, def }) {
      const entries = table.map((a, s) => `${s}: ${a}`).join(', ');
      return `def act(obs):\n    _T = {${entries}}\n    return _T.get(int(obs[0]), ${def})\n`;
    },
    mutate(p, rnd) {
      const q = { table: p.table.slice(), def: p.def };
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) q.table[Math.floor(rnd() * 16)] = Math.floor(rnd() * 4);
      if (rnd() < 0.2) q.def = Math.floor(rnd() * 4);
      return q;
    }
  },
  // Blackjack-v1 obs: [player_sum, dealer_card, usable_ace].
  // Stand threshold, split by usable ace.
  'Blackjack-v1': {
    evalEpisodes: 300,
    freshEvalEpisodes: 1000,
    solvedAt: -0.02,
    seedParams: [[20, 19], [19, 18], [17, 17], [21, 20], [18, 18]],
    toCode([tNoAce, tAce]) {
      const a = Math.round(tNoAce), b = Math.round(tAce);
      return `def act(obs):\n    s = int(obs[0])\n    t = ${b} if int(obs[2]) else ${a}\n    return 0 if s >= t else 1\n`;
    },
    mutate(p, rnd) {
      const q = p.slice();
      const i = Math.floor(rnd() * 2);
      q[i] = Math.max(12, Math.min(21, Math.round(q[i] + (rnd() < 0.5 ? -1 : 1))));
      return q;
    }
  }
};

function spaceSeeds(envId, rnd) {
  const space = POLICY_SPACES[envId];
  if (!space) throw new Error('no policy space for env: ' + envId);
  if (space.seeds) return space.seeds(rnd);
  return space.seedParams.map((p) => (Array.isArray(p) ? p.slice() : JSON.parse(JSON.stringify(p))));
}

function paramsKey(p) {
  return JSON.stringify(p);
}

// ---------------------------------------------------------------------------
// Induction: hill-climb over policy params, gym as verifier.
// ---------------------------------------------------------------------------

function inducePolicy(envId, opts = {}) {
  const space = POLICY_SPACES[envId];
  if (!space) throw new Error('no policy space for env: ' + envId);
  const generations = opts.generations || 10;
  const popSize = opts.popSize || 8;
  const seed = opts.seed === undefined ? 1 : opts.seed;
  const trainSeed = opts.trainSeed === undefined ? 1000 : opts.trainSeed;
  const rnd = mulberry32(seed);
  const cache = new Map();

  function scoreOf(params, episodes) {
    const key = envId + '|' + paramsKey(params) + '|' + episodes;
    if (cache.has(key)) return cache.get(key);
    const code = space.toCode(params);
    const res = evaluatePolicy(envId, code, { episodes, seed: trainSeed });
    const s = res && res.ok
      ? { ok: true, mean: res.mean, std: res.std, code }
      : { ok: false, mean: -Infinity, std: 0, code, error: (res && res.error) || 'eval failed' };
    cache.set(key, s);
    return s;
  }

  let population = spaceSeeds(envId, rnd);
  let best = null; // {params, mean, std, code}
  let evals = 0;
  const history = [];

  for (let gen = 0; gen < generations; gen++) {
    let genBest = null;
    for (const params of population) {
      const s = scoreOf(params, space.evalEpisodes);
      evals++;
      if (!s.ok) continue;
      if (!genBest || s.mean > genBest.mean) genBest = { params, mean: s.mean, std: s.std, code: s.code };
    }
    if (genBest && (!best || genBest.mean > best.mean)) best = genBest;
    history.push({ gen, bestMean: best ? best.mean : null, evals });
    if (best && best.mean >= space.solvedAt) break; // solved: stop early
    if (!best) break;
    const next = [best.params];
    while (next.length < popSize) next.push(space.mutate(best.params, rnd));
    population = next;
  }

  if (!best) throw new Error('induction failed: no scorable policy for ' + envId);

  // Fresh final evaluation on unseen seeds: the honest number.
  const freshSeed = (opts.freshSeed === undefined ? 777000 : opts.freshSeed);
  const fresh = evaluatePolicy(envId, best.code, {
    episodes: space.freshEvalEpisodes, seed: freshSeed, timeoutMs: 300000
  });
  if (!fresh.ok) throw new Error('fresh evaluation failed: ' + fresh.error);

  return {
    policyId: 'gym-' + envId.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-s' + seed,
    env: envId,
    language: 'python',
    code: best.code,
    params: best.params,
    trainMean: best.mean,
    trainStd: best.std,
    meanReward: fresh.mean,
    stdReward: fresh.std,
    minReward: fresh.min,
    maxReward: fresh.max,
    evalEpisodes: fresh.episodes,
    evalSeed: freshSeed,
    generations: history.length,
    totalEvals: evals,
    source: 'gym-induction',
    learnedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Persistence (mirrors retainSolution in swarm_code_self_teach.js)
// ---------------------------------------------------------------------------

function ensureGymPolicies(model) {
  model.lariCodeGeneration = model.lariCodeGeneration || {};
  const cg = model.lariCodeGeneration;
  if (!Array.isArray(cg.gymPolicies)) cg.gymPolicies = [];
  return cg;
}

function getGymPolicies(model) {
  try {
    const cg = model && model.lariCodeGeneration;
    return (cg && Array.isArray(cg.gymPolicies)) ? cg.gymPolicies : [];
  } catch (_) { return []; }
}

function retainGymPolicy(model, record) {
  const cg = ensureGymPolicies(model);
  if (cg.gymPolicies.some((p) => p.policyId === record.policyId)) return false;
  cg.gymPolicies.push(Object.assign({}, record, { retainedAt: new Date().toISOString() }));
  return true;
}

// ---------------------------------------------------------------------------
// Code gym: existing CODE_TASK_SEEDS as verifiable code tasks.
// (SWE-gym proper needs per-task Docker images; too heavy for a first pass.
//  These seeds are Lari's local code gym: generate -> sandbox -> verify.)
// ---------------------------------------------------------------------------

function runCodeGymTask(model, taskId, opts = {}) {
  const teach = require('./swarm_code_self_teach.js');
  const task = teach.CODE_TASK_SEEDS.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: 'unknown code task: ' + taskId };
  const maxCandidates = opts.maxCandidates || 6;
  const candidates = teach.generateCandidates(model, task).slice(0, maxCandidates);
  const attempts = [];
  for (const cand of candidates) {
    const run = teach.runCodeSandbox(task.language, cand.code, { timeoutMs: 10000 });
    const ver = teach.verifyAttempt(task, run);
    attempts.push({ source: cand.source, passed: !!ver.passed, reason: ver.reason });
    if (ver.passed) break;
  }
  return {
    ok: true,
    taskId,
    reward: attempts.some((a) => a.passed) ? 1 : 0,
    attempts: attempts.length,
    results: attempts
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log('usage: node swarm_gym.js [--list-envs]');
  console.log('       node swarm_gym.js --env <EnvId> [--generations N --popsize N --seed N]');
  console.log('       node swarm_gym.js --env <EnvId> --retain <model.json>');
  console.log('       node swarm_gym.js --codegym <taskId>');
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
  };
  if (args.includes('--list-envs')) {
    console.log(JSON.stringify(listEnvs(), null, 2));
    return;
  }
  if (args.includes('--codegym')) {
    const taskId = get('--codegym');
    const model = {};
    const res = runCodeGymTask(model, taskId);
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  const envId = get('--env');
  if (!envId) { printUsage(); process.exit(2); }
  const record = inducePolicy(envId, {
    generations: parseInt(get('--generations', '10'), 10),
    popSize: parseInt(get('--popsize', '8'), 10),
    seed: parseInt(get('--seed', '1'), 10)
  });
  console.log(JSON.stringify(record, null, 2));
  const retainPath = get('--retain');
  if (retainPath) {
    const model = JSON.parse(fs.readFileSync(retainPath, 'utf8'));
    const added = retainGymPolicy(model, record);
    fs.writeFileSync(retainPath, JSON.stringify(model, null, 2));
    console.error(`retained=${added} -> ${retainPath}`);
  }
}

if (require.main === module) main();

module.exports = {
  bridgeOnce,
  listEnvs,
  evaluatePolicy,
  GymSession,
  POLICY_SPACES,
  inducePolicy,
  getGymPolicies,
  retainGymPolicy,
  runCodeGymTask
};
