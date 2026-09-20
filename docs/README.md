# Lari docs

Lari is Greg's local-first AI. **Local Autonomous Recursive Intelligence** — he's a he,
pronounced "Larry," and the name also stands in for "Singularity."

The thesis: **the swarm is the model.** Lari's intelligence lives in executable retained
state — learned operators, verified rules, typed memory, provenance — not in pretrained
weights. There are zero external model calls in production paths. The model file
(`models/lari/current/swarm-model.json`) **is** the brain; the repo tracks exactly one
current copy.

**Not ready for public beta.** These docs describe what Lari actually does, what he's
proven to do, and where the honest gaps are. If a claim here doesn't have a test or a
transcript behind it, it says so.

## The docs

- [Self-learning](self-learning.md) — the flagship. How Lari learns from conversation:
  taught facts, the retention gate, instruction pairs, the discourse miner, nightly
  consolidation, calibration, checkpointing, and the tutoring sessions where Greg
  teaches him directly. Read this first.
- [Architecture](architecture.md) — the kernel, the request flow, chat lanes, native
  lanes (math, time, dictionary), and the consultation layer that lets taught
  knowledge beat canned answers.
- [Safety](safety.md) — the choke-point filter, the zero-external-calls rule,
  retention gates, owner-only learning, and the contamination quarantine.
- [Agentic coding](agentic-coding.md) — the five-mode coding loop (debug, multi-file,
  compose, self-curriculum, research-when-stuck), the attempt → execute → verify →
  retain policy, and the honest boundary: it's not wired into chat yet.
- [Running Lari](running.md) — Workbench, Telegram bot, CLI adapter, env vars, and
  model backup discipline.
- [Testing](testing.md) — what each suite proves, the fail-before-proof discipline,
  and why a passing count is not evidence.
- [Glossary](glossary.md) — the vocabulary: operator, taught fact, instruction pair,
  discourse miner, consolidation, choke-point, lane, consultation, checkpoint,
  provenance.

Start with [VISION.md](../VISION.md) if you want the philosophy and the rules for
not breaking things. Start with [self-learning](self-learning.md) if you want the
part that's actually a big deal.
