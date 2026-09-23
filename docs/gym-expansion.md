# Gym Expansion — build note (2026-09-23)

Track 2 of the gym harness work (branch main, HEAD fac6280). Follow-up to
`docs/gym-harness.md`. Everything below is measured from runs executed
today on this machine (gymnasium 1.3.0, venv `~/workspace/venvs/lari-gym`).
No external model calls, no new pretrained models, sandboxing unchanged
(one-shot bridge child, restricted builtins for induced code).

## What was added

**Richer policy families**
- `gym_bridge.py`: new `transitions` command exposing `env.unwrapped.P`
  for discrete envs (states, action count, full P dict).
- `swarm_gym.js`:
  - Policy spaces now support **families**: `Blackjack-v1` has
    `threshold` (the old coarse family, still the default) and `table`
    (full 360-cell state->action table over
    (player_sum 4..21) x (dealer 1..10) x (usable_ace), seeded with a
    basic-strategy table plus random tables). `inducePolicy(env, {family})`
    picks the family; CLI: `--env Blackjack-v1 --family table`.
  - `derivePolicyDP(envId)`: value iteration over the bridge-exposed
    transition model, rendered through the env's tabular `toCode` so the
    DP policy is the same code format the hill-climb produces
    (apples-to-apples scores). CLI: `--dp FrozenLake-v1`.
  - `demoPolicy(envId, code)`: short demo batch through a live
    `GymSession` (bridge `demo` command: per-step trace of episode 1 plus
    mean/std over N episodes, all in the policy sandbox).

**More practice domains**
- `gym_data/mbpp_local.jsonl`: 24 MBPP-style problems (function signature
  `solve`, hidden arg/expected tests, injected only at verification time).
- `swarm_code_tasks.js`: runs Lari's real code-task loop per problem
  (`generateCandidates` -> `runCodeSandbox` -> hidden-test harness,
  reward 1/0). The loop needed function-defining candidates, so
  `swarm_code_self_teach.js` gained 16 `py-fn-*` CODE_PATTERNS (return-value
  versions of the existing stdout patterns: fibonacci, factorial,
  palindrome, prime, reverse, sum/max/sort list, vowels, gcd, add,
  count-even, square, length, is-even, abs-diff).
- `gym_data/math_local.jsonl`: 24 problems with exact checkable answers.
- `swarm_math_tasks.js`: deterministic program-synthesis math loop:
  template-match question -> generate Python computation -> sandbox ->
  exact numeric comparison (tol 1e-6). 14 templates.

**Runtime wiring (thin)**
- `swarm_gym_chat.js`: the TEXT side of the outer loop. Parses chat
  messages (`/gym list|demo|train|policies|propose` plus conservative
  natural phrasing), proposes env + policy family from text, and calls the
  numeric loop (`inducePolicy`, `derivePolicyDP`, `demoPolicy`).
  `handleGymMessage(model, text)` returns `{handled, reply}`; non-gym
  messages return `{handled:false}` untouched.
- `lari-telegram/bridge.js`: 8-line guarded hook in `chatWithLari` — only
  `/gym`-prefixed messages route to the gym chat module; any error falls
  through to normal chat. Demo policy resolution: best retained policy,
  else DP when the env exposes transitions, else a quick 3-generation
  induction. Verified live: `/gym list`, `/gym propose`, `/gym policies`,
  `/gym demo cartpole` (retained policy, 5 episodes, mean 500, step trace),
  `/gym demo frozen lake` (DP fallback, mean 1 over 5 episodes).

## Measured numbers

**Blackjack-v1 — table family does NOT clear the threshold baseline.**
Fresh-seed evals, 10000 episodes each (SE ~0.0096), distinct seeds:
- hill-climb threshold (re-run, 10 gens): **-0.0574 ± 0.95**
- hill-climb table (12 gens, 97 evals): **-0.0609 ± 0.96**
- pure basic-strategy table seed, no climb: **-0.0373 ± 0.96**
- documented baseline from the harness note: -0.086 ± 0.95 / 1000 eps
  (the re-run threshold policy at -0.057 is consistent with it within
  noise; the old -0.086 run was a slightly worse seed draw).

Plain verdict: the family was not the blocker. The table family scored
no better than the threshold family, and the 12-generation climb
finished *worse* than its own basic-strategy seed: train +0.01 vs fresh
-0.06. The blocker is **noise-dominated hill-climbing**: per-episode
std ~0.95 means a 500-episode train eval has SE ~0.043, comparable to
the entire plausible skill gap in blackjack, so the climb selects on
noise and overfits the train seed. Fixing this needs variance reduction
(common random numbers across candidates, many more train episodes) or
a fundamentally different learner, not a bigger table.

**FrozenLake-v1 — DP crushes hill-climbing.** Fresh seeds:
- hill-climb tabular (from harness note): **0.18 ± 0.38 / 200 eps**
- DP (value iteration over exposed P, gamma 0.99), fresh eval:
  **0.737 ± 0.44 / 1000 eps** (seed 777000), vs ~0.83 optimal and ~0.01
  random. One transition-model query, zero generations, same tabular
  code format. Planning beats trial-and-error on this env class, as
  predicted in the harness note.

**Code gym (MBPP-local, 24 problems): 16/24 = 66.7%.** All 16 covered
classes pass on the first function-defining pattern (first or second
candidate). Honest failures (8): two-sum, anagram, fizzbuzz-list,
celsius, flatten, second-largest, merge-sorted, valid-parens — no
matching pattern, so zero or wrong candidates. Notably the new
`py-fn-max-list` initially overgeneralized to "second largest" (returned
max); guarded with a negative lookahead so it now honestly reports no
coverage instead of a wrong answer. Existing `CODE_TASK_SEEDS` python
tasks still 10/10 pass (no regression from the new patterns).

**Math gym (24 problems): 21/24 = 87.5%.** Template coverage handles
arithmetic, linear equations, percents, sqrt, gcd/lcm, mean, factorial,
division-as-decimal, hypotenuse, sum-of-primes, 2x2 systems, quadratics.
Honest failures (3): the three word problems (train distance, discount
price, workers/widgets) — no template, multi-step reasoning the
template set cannot do.

**CartPole-v1**: unchanged from the harness note, still solved
(500.0 ± 0.0 / 100 episodes). Not re-run; nothing in this track touched
its family.

## What failed and why

1. Blackjack table family: no gain over threshold (-0.061 vs -0.057,
   both ±0.96). Cause: reward noise >> skill signal; hill-climbing
   without variance reduction overfits train-seed noise. The early
   experiment also tripped a lax `solvedAt` threshold and stopped after
   1 generation — fixed (`solvedAt: 0.1`, never early-stops) before the
   full 12-generation run.
2. Harness bug found and fixed: JSON `true`/`false` in hidden tests is
   not valid Python; the embedded test dict now uses a JSON->Python
   literal serializer.
3. Math template gap: "Solve for x: 2x = 50" (no constant term) missed
   the linear regex; generalized to optional constant.
4. Code-gym boundary is pattern coverage, 8/24 uncovered by design to
   show where the loop stops. The loop cannot yet synthesize genuinely
   novel multi-step algorithms; each new class needs a hand-written
   pattern, which is the real lever and the real limit.

## Limits

- DP only works where the env exposes a small discrete P (FrozenLake);
  it is model-based planning, not learning from experience — keep the
  label honest.
- Blackjack stays mediocre under every family tried; the next lever is
  variance reduction in the evaluator, not family size.
- Code/math gyms measure template/pattern coverage as much as learning;
  they are practice domains with automatic verifiers, not evidence of
  generalization.
- The `/gym` chat hook is Telegram-bridge only and text-matches
  conservatively; the browser runtime (index.html) cannot spawn the
  bridge, so gym commands only work where Node can reach the venv.
- Verified against scratch model state only; no live model files were
  touched. Nothing pushed.

## Files changed

- `gym_bridge.py` — `transitions` + `demo` commands
- `swarm_gym.js` — policy families, `derivePolicyDP`, `demoPolicy`,
  `--family`/`--dp` CLI
- `swarm_code_self_teach.js` — 16 `py-fn-*` function-defining patterns
- `swarm_code_tasks.js` — NEW: MBPP-local runner
- `swarm_math_tasks.js` — NEW: math gym runner
- `swarm_gym_chat.js` — NEW: text-side router + demo/train commands
- `gym_data/mbpp_local.jsonl`, `gym_data/math_local.jsonl` — NEW
- `lari-telegram/bridge.js` — guarded `/gym` hook in chatWithLari
- `docs/gym-expansion.md` — this note
