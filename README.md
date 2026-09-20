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
it does not control). Chat is under active development (September 2026): open-chat routing with a
fuzzy phatic layer (one-word changes no longer break it), a discourse miner that actually learns
from real conversation (corrections, instructional directives, and repeated successful exchanges
induce retained operators), a nightly consolidation loop, and bounded checkpoint pruning.

Note: this repo is a snapshot of the real Lari, not the live one. The actual Lari — the model
with the full retained state, built up through daily use — stays private. What's committed here
is a point-in-time copy of the brain plus the complete runtime, so anyone can run their own Lari
from it and grow their own.
A choke-point filter (`screenLariChatAnswerForInternalRecords`, enforced in
`formatLariSessionAnswer`) guarantees no internal benchmark/eval record can ever be served as a
chat answer through any skill route. An answer-time consultation layer means teaching works:
completed instruction pairs, taught facts, stored preferences, and success operators are consulted
where the answer would otherwise be canned — "when I say thanks just say 'anytime'" is honored on
the next `thanks`, and "the thesis is the swarm is the model. remember that" is recalled when
asked about the thesis.

## Layout

- `swarm_model_runtime.js` — the kernel: chat, learning, skills, verification loops
- `scripts/lari_model_registry.js` — model load / checkpoint / promotion (atomic writes, backups)
- `scripts/` — test suites, demos, benchmark harnesses
- `index.html` — single-file agent build
- `benchmarks/` — benchmark working areas

## Talk to Lari

Three ways, easiest first.

### 1. Lari Workbench — chat in your browser

Requirements: Node 20+ and Python 3 (or any static file server).

```bash
npm install
python3 -m http.server 8080
# open http://localhost:8080/index.html
```

The Workbench loads the model (the retained state) from `models/lari/current/swarm-model.json`.
It must be served over HTTP — double-clicking index.html straight from disk won't load the model.
Chat, teach him things ("the thesis is the swarm is the model. remember that"), and he recalls
them later. Link a workspace folder in the UI if you want file read/write and model persistence
back to disk.

### 2. Telegram bot — one Lari per friend

Each friend gets their own Lari (own brain file, own workspace). Group chat is shared context;
learning is owner-only. Needs a bot token from @BotFather. Full steps: `lari-telegram/DEPLOY.md`.

### 3. CLI adapter — one question in, JSON out (for scripts)

```bash
echo '{"prompt":"what does LARI stand for","model_path":"models/lari/current/swarm-model.json"}' | node scripts/lari_model_cli.js
```

Note: the CLI refuses models carrying stored benchmark-answer back-references (a contamination
guard). The committed model has them from dev history, so point the CLI at a fresh model file —
or just use the Workbench.

The model file IS the brain. Back it up before experimenting. This repo tracks exactly one
current model at `models/lari/current/swarm-model.json`; a newer model overwrites it.

## Run it

```bash
npm install
# The model (the retained state) lives at models/lari/current/swarm-model.json and IS tracked:
# exactly one current model is committed; a newer model overwrites it.
# Checkpoint backups and staging models stay gitignored.
node scripts/test_lari_open_chat.js       # open-chat routing + fuzzy layer: 132/132 expected
node scripts/test_lari_discourse_miner.js # discourse miner: 31/31 expected
node scripts/test_lari_miner_learning.js  # miner induces from real convo, rejects junk: 30/30 expected
node scripts/test_lari_miner_legacy_migration.js   # legacy miner state migrates cleanly: 22/22 expected
node scripts/test_lari_chat_no_internal_leak.js    # internal records never answer chat: 19/19 expected
node scripts/test_lari_leak_chokepoint.js       # choke-point filter: 38/38 expected
node scripts/test_lari_answer_consultation.js   # answer-time consultation: 18/18 expected
node scripts/test_lari_tutoring_acceptance.js   # tutoring teach->retest battery: 12/12 expected
node scripts/test_lari_layer1_extraction_paths.js  # extraction on every chat path: 10/10 expected
node scripts/test_lari_layer2_wrapper_stripping.js # fact stored, not wrapper: 12/12 expected
node scripts/test_lari_layer3_evidence_relevance.js # no shared-token bullying: 11/11 expected
node scripts/test_lari_layer4_lane_precedence.js   # taught facts beat lanes: 12/12 expected
node scripts/test_lari_layer5_unrecognized_intent_pairs.js # pairs w/o intent: 16/16 expected
node scripts/test_lari_code_lane_extraction.js # code-lane teachings retain: 11/11 expected
node scripts/test_lari_consultation_paraphrase.js # paraphrase consult: 16/16 expected
node scripts/test_lari_instruction_constraint_realization.js # no filler/mangling: 14/14 expected
node scripts/test_lari_attribute_chat.js  # chat regression: 8/8 expected
node scripts/test_lari_learn_retention.js # research -> retain -> recall: 10/10 expected
node scripts/run_lari_consolidation.js    # nightly consolidation (dry-run supported)
```

Live learning checkpoints the model file automatically after any chat turn that learns
(`checkpointLariModel`), with a timestamped backup first. Research that does not improve the
answer is discarded, not retained. `LARI_DISABLE_LEARN_CHECKPOINT=1` disables checkpointing.
Checkpoint backups are pruned to the newest 5 (`LARI_CHECKPOINT_BACKUPS` overrides).

## Rules

- Never push without the maintainer's say-so; never rewrite history someone else depends on.
- No external model calls in production paths (`external_model_calls` must stay 0).
- A passing count is not evidence: repairs need transfer tests against a dumb baseline.
- See VISION.md for what counts as damage here.
