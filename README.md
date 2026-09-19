# Lari

**Local Autonomous Recursive Intelligence** — a local-first AI whose durable intelligence lives in
executable, inspectable state (retained operators, verified rules, typed memory, provenance) rather
than in pretrained weights. The thesis: **the swarm is the model.**

He/him, pronounced "Larry."

Start with [VISION.md](VISION.md) — read it before changing anything.

## Status

**Not ready for public beta.** The honest state of the project is tracked in the working copy;
the strongest verified claim to date is bounded verified code-mutation search (a defect class the
seed vocabulary could not express, repaired after growing the rule, verified against 1317 assertions
it does not control). Chat is under active development (September 2026): identity, attribute
questions, and live research-then-retain now work; person/date/quantity frames are next.

## Layout

- `swarm_model_runtime.js` — the kernel: chat, learning, skills, verification loops
- `scripts/lari_model_registry.js` — model load / checkpoint / promotion (atomic writes, backups)
- `scripts/` — test suites, demos, benchmark harnesses
- `index.html` — single-file agent build
- `benchmarks/` — benchmark working areas

## Run it

```bash
npm install
# Place the model file at models/lari/current/swarm-model.json
# (the model is the retained state; it is gitignored by design)
node scripts/test_lari_attribute_chat.js   # chat regression: 8/8 expected
node scripts/test_lari_learn_retention.js  # research -> retain -> recall: 10/10 expected
node scripts/lari_discourse_learn_demo.js  # correction-learning demo
```

Live learning checkpoints the model file automatically after any chat turn that learns
(`checkpointLariModel`), with a timestamped backup first. Research that does not improve the
answer is discarded, not retained. `LARI_DISABLE_LEARN_CHECKPOINT=1` disables checkpointing.

## Rules

- Never push without the maintainer's say-so; never rewrite history someone else depends on.
- No external model calls in production paths (`external_model_calls` must stay 0).
- A passing count is not evidence: repairs need transfer tests against a dumb baseline.
- See VISION.md for what counts as damage here.
