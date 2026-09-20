# Glossary

**Operator** — A retained, reusable procedure: a rule, a repair, a response
pattern, a discourse move. Operators are the units of Lari's intelligence —
executable state, not text. They carry provenance and verification evidence.

**Taught fact** — Something you told Lari explicitly ("remember that"), stored
as a typed knowledge record with confidence 0.9. Newer teachings win over older
ones on the same topic. See [self-learning](self-learning.md#1-taught-facts-remember-that).

**Instruction pair** — A `{prompt, failedAnswer, correctedAnswer}` triple formed
when you correct Lari and the corrected answer is accepted. Three pairs in one
discourse cluster induce a general procedure. The fast path: a correction that
dictates the response ("just say 'anytime'") forms a pair immediately.

**Discourse miner** — The observer on every chat turn
(`swarm_discourse_miner.js`). Detects signals (correction, rephrase, approval,
neutral), builds instruction pairs, induces procedures and success operators,
and tracks per-intent correction rates. Pure observation — it can never break
chat.

**Consolidation** — The nightly job that distills raw conversation episodes
into durable beliefs (identity facts, preferences, directives, self-knowledge),
arbitrates contradictions by confidence × recency, caps at 100 beliefs per
scope, and merges idempotently. Superseded beliefs are kept, never deleted.

**Choke-point** — The single final gate every answer passes through
(`screenLariChatAnswerForInternalRecords`, enforced in
`formatLariSessionAnswer`). Internal benchmark/eval/arena records can never
become chat answers, no matter which route produced the text. See
[safety](safety.md).

**Lane** — A way of answering suited to an intent: `open_chat`, `small_talk`,
`self_identity`, `planning`, `code`, `greeting`, `preference`. Native lanes
(math, time, dictionary) are deterministic capabilities that learning can never
override. See [architecture](architecture.md#chat-lanes).

**Consultation** — The read side of learning. Before a lane falls back to a
canned answer, retained knowledge (instruction pairs, taught facts, preferences,
success operators) is consulted, newest and strongest first. When a taught fact
wins, the trace records `taught_fact_precedence`.

**Checkpoint** — Writing the in-memory model back to its file after a learning
turn: validated, timestamped backup first, atomic write, backups pruned to the
newest 5. Disable with `LARI_DISABLE_LEARN_CHECKPOINT=1`.

**Provenance** — The where-and-when attached to every learned record: creation
source, verification status, timestamps. The model file is inspectable —
provenance is what makes "what does he know and why" an answerable question.

**Retention gate** — The rule that research is kept only if the follow-up answer
passes verification and fits the question's frame. Failed acquisitions are
rolled back and marked `retained: false`. Junk doesn't accumulate.

**Calibration** — Per-intent correction-rate tracking. Above 5 turns and 20%
corrections, reported confidence scales down (`raw × max(0.5, 1 − rate ×
0.8)`). Currently measurement only — the behavioral hedging gate isn't built.

**The swarm is the model** — The thesis. Intelligence lives in the executable
retained state (operators, rules, memory, verifiers), not in pretrained
weights. The runtime, memory, and learned procedures *are* the model; the
boundary moves.
