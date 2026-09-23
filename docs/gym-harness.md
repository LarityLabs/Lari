# Gym Harness — build note

Lari learns from environments now, not just text. The gym harness gives him
verifiable tasks with automatic rewards: propose policy **code**, run it
against a Gymnasium environment, keep it only if the measured mean reward
improves. No external model calls, no new pretrained models — the policies
are small deterministic procedures retained in his JSON model state, which
is exactly the program-synthesis thesis.

## Architecture: two loops

- **Inner loop (numeric, fast):** `gym_bridge.py` wraps Gymnasium envs. The
  induced policy is Python source defining `act(obs)`; `obs` is always a
  plain list of numbers (discrete spaces arrive as `[int]`, e.g. FrozenLake
  state 5 → `[5]`; Blackjack `(sum, dealer, ace)` → `[21.0, 10.0, 1.0]`).
  The policy runs **in-process** against the env — no English in the hot
  loop, no per-step IPC.
- **Outer loop (symbolic, Node):** `swarm_gym.js` owns the learning:
  seed parameter vectors → render to code → evaluate over K episodes →
  hill-climb (elitism + Gaussian/random mutations, bounded generations,
  early stop at a solved threshold) → fresh final evaluation on **unseen**
  seeds → persist.

**Sandboxing** reuses the existing bar from `teach.runCodeSandbox`
(`swarm_code_self_teach.js`): every evaluation spawns `gym_bridge.py` as a
fresh one-shot child (`spawnSync`, hard timeout, stdio captured, no network
use by the child). Induced policy source additionally executes with
restricted builtins (no imports, no I/O) inside that child.

**Text stays in the outer loop:** proposing policy families, choosing envs,
and explaining a retained policy in English when asked. Numbers stay in the
inner loop where precision matters.

## Files

- `gym_bridge.py` — Gymnasium wrapper, JSON-stdio protocol. One-shot mode
  (one JSON doc on stdin → one JSON doc on stdout; commands `envs`,
  `reset`, `step`, `evaluate`) plus `--serve` NDJSON mode for interactive
  `reset`/`step` sessions (`GymSession` in `swarm_gym.js`).
- `swarm_gym.js` — driver: `evaluatePolicy`, `inducePolicy` (hill-climb),
  `GymSession`, policy spaces, `retainGymPolicy`/`getGymPolicies`, and the
  code-gym adapter `runCodeGymTask`.
- Python interpreter: `LARI_GYM_PYTHON` env var, else
  `~/workspace/venvs/lari-gym/bin/python` (gymnasium 1.3.0 lives there).

## Policy storage

Mirrors `retainSolution` in `swarm_code_self_teach.js`:

```
model.lariCodeGeneration.gymPolicies[] = {
  policyId, env, language: 'python',
  code,            // the induced act(obs) source
  params,          // the parameter vector it was rendered from
  trainMean, trainStd,
  meanReward, stdReward, minReward, maxReward,  // fresh-eval numbers
  evalEpisodes, evalSeed,
  generations, totalEvals,
  source: 'gym-induction', learnedAt, retainedAt
}
```

Verified against a scratch copy of the model; the live model files were not
touched during development.

## How to add a new env

1. Register it in `ENV_REGISTRY` in `gym_bridge.py` (`max_steps`).
   Observation/action spaces must be numeric or discrete — the bridge
   normalizes every observation to a list of floats.
2. Add a policy space in `POLICY_SPACES` in `swarm_gym.js`:
   `seedParams` (or `seeds(rnd)`), `toCode(params)`, `mutate(params, rnd)`,
   `evalEpisodes`, `freshEvalEpisodes`, `solvedAt`.
3. Run: `node swarm_gym.js --env <EnvId> --generations N --popsize M --seed S`.

## Measured results (2026-09-23, gymnasium 1.3.0)

**CartPole-v1 — SOLVED.** Learned policy `gym-cartpole-v1-s7`:

```python
def act(obs):
    return 1 if (1.0*obs[2] + 0.5*obs[3] > 0.0) else 0
```

A linear threshold controller on pole angle + angular velocity, found in
the seed population; hill-climb confirmed no seed beat it. Fresh
evaluation: **mean 500.0 ± 0.0 over 100 episodes** (seeds 777000–777099,
max possible is 500/episode). Retained to scratch model state as
`gym-cartpole-v1-s7`.

**Blackjack-v1 — learned, mediocre (honest).** 10 generations, 77 evals:

```python
def act(obs):
    s = int(obs[0])
    t = 18 if int(obs[2]) else 16
    return 0 if s >= t else 1
```

Fresh evaluation: **mean −0.086 ± 0.95 over 1000 episodes**
(SE ≈ 0.03). It never reached the solved threshold (−0.02). The
threshold-only policy family is too coarse for near-optimal blackjack
(it cannot express hit-on-12-vs-weak-dealer etc.) — the harness works,
the policy family is the limit. Next step would be a richer family
(e.g. a small state→action table like FrozenLake's).

**FrozenLake-v1 (4×4, slippery) — learned, partial (honest).** Tabular
policy space, 15 generations, 176 evals. Best found:

```python
def act(obs):
    _T = {0: 3, 1: 3, 2: 2, 3: 3, 4: 1, 5: 1, 6: 0, 7: 1,
          8: 1, 9: 1, 10: 0, 11: 1, 12: 1, 13: 3, 14: 2, 15: 2}
    return _T.get(int(obs[0]), 2)
```

Fresh evaluation: **mean 0.18 ± 0.38 over 200 episodes** (train 0.23).
Random is ≈0.01, optimal deterministic is ≈0.83 — so it learned
something real (18× random) but plateaued far from optimal. Sparse 0/1
reward plus single-state mutations make the climb noisy and deceptive;
more episodes per eval only linearly reduces the noise. The natural
next step for this env class is planning, not more hill-climbing:
expose the transition model through the bridge and let Lari derive the
policy by dynamic programming instead of trial and error.

**Code gym** (local stand-in for SWE-gym — see below):
`py-fibonacci-10` → reward 1, passed first attempt via retained pattern
`pattern:py-fib-loop` through `runCodeSandbox` + `verifyAttempt`.

## SWE-gym verdict

SWE-gym (Pan et al., ICML 2025) is 2,438 real-world Python tasks from
GitHub issues with per-task **Docker images** (1 CPU / 2 GB sandbox each,
pre-installed per-repo dependencies). That is the right long-term code
gym, but it is too heavy for this first pass: gigabytes of Docker images
and a container orchestrator, before a single task runs. The local
stand-in is the existing `CODE_TASK_SEEDS` suite in
`swarm_code_self_teach.js`, wired here as gym-style tasks
(generate → sandbox → verify → 0/1 reward) via `runCodeGymTask`.
Graduating to real SWE-gym means: Docker on the Lari machine, pulling
the SWE-Gym images, and an adapter from its problem-statement/test
protocol to `swarm_gym.js` — a real but separate project.

## Known limits

- Discrete, low-dimensional environments only. No continuous control
  (no MuJoCo-style torque policies through synthesized if-statements),
  no pixel observations.
- Sample-inefficiency vs gradient RL: hill-climbing program space needs
  tens of evals × tens–hundreds of episodes per env. Fine for CartPole;
  each new env needs its episodes budget tuned.
- Policy families are hand-designed per env (the outer loop's job).
  A bad family caps the result (see Blackjack). Richer families —
  tables, small decision lists — are the lever, not more generations.
- Sparse rewards (FrozenLake's 0/1) make the climb noisy; more episodes
  per eval is the mitigation, at linear spawn cost (~1s per eval for
  interpreter startup; in-process episodes themselves are microseconds).
