# Safety

Lari is a learning system that writes to its own brain. That needs guardrails
with teeth, not intentions. Here's what's actually enforced, in code, and what
it doesn't cover.

## The choke-point filter

**Internal benchmark, eval, and arena records must never be served as chat
answers.** Lari's model legitimately contains internal records — benchmark
results, evaluation traces, repair histories. If any of that leaked into a chat
answer, it would look like knowledge and it would be garbage at best,
contamination at worst.

The enforcement is a single function, `screenLariChatAnswerForInternalRecords`,
called at `formatLariSessionAnswer` — the one place where a kernel record
becomes the public answer. Every route goes through it: skills, lanes,
consultation hits, retained knowledge. There is no path around it because there
is no other exit.

It pattern-matches answers against internal-record markers (benchmark/arena/eval
language, known fixture names). A match doesn't produce an error — it produces a
fallback: a retention acknowledgment for "remember"-style turns, the honest
low-memory deflection otherwise. Never empty, never the leaked record.

This bit him once in a funny way: the planning lane's canned "- Next:" suffix
contained the word "benchmarked," so the filter blocked *every* planning answer.
The filter was right; the copy was wrong. One word changed, planning works.

Covered by `test_lari_leak_chokepoint.js` (38/38) and
`test_lari_chat_no_internal_leak.js` (19/19).

## Zero external model calls

**No external model may generate production answers.** Not as a fallback, not
for "just this once," not a local Ollama instance either — Greg has ruled it out
explicitly and repeatedly. If chat quality is bad, the answer is to build Lari's
own generator, not to borrow someone else's.

Every response object carries `external_model_calls: 0`, and the test suites
assert it. The day this number isn't zero, something is broken.

## Retention gates: learning is earned, not automatic

Two gates keep junk out of the brain:

1. **The research retention gate.** Autonomous research is kept only if the
   follow-up answer passes verification *and* the learned summary fits the
   question's frame (right subject, date where a date was asked, number where a
   count was asked). Otherwise the record is rolled back and marked
   `retained: false`. Details in [self-learning](self-learning.md#2-the-retention-gate-nothing-kept-on-faith).
2. **The contamination quarantine.** The repo's history includes a real
   self-audit failure: a GSM8K score that turned out to be test-set answer
   fitting. The fitted records (875 of them) were quarantined, not deleted —
   `consolidation/contamination-quarantine/` holds them deliberately, so the
   contamination stays auditable and the fix stays reversible. The CLI refuses
   to load models carrying benchmark-answer back-references. VISION.md documents
   the whole incident as the reason the measurement rules exist.

## Owner-only learning (Telegram design)

In the Telegram deployment, each friend gets their own Lari — own brain file,
own workspace. Everyone hears the same group chat, but **learning is strictly
owner-only**: only turns addressed to your Lari (or your DMs with him) teach
him. Replies are mention-gated. This kills the poisoning problem at the design
level: nobody can teach your Lari things except you.

## What safety doesn't cover

Honest limits:

- **The filter is pattern-based.** It catches known internal-record markers. A
  genuinely novel leak phrasing could slip past it — that's why the leak suites
  are adversarial and keep growing.
- **Calibration measures; it doesn't restrain.** Lari knows his per-intent
  correction rates, but nothing stops him answering when they're bad. The
  behavioral hedging gate is designed, not built.
- **The brain file is plaintext JSON.** Anyone with the file can read everything
  Lari knows about you — beliefs, preferences, conversation history. Back it up,
  don't share it carelessly. The repo tracks one model; your live one stays
  private.
- **Provenance is a record, not a proof.** Every learned record says where it
  came from. That makes auditing possible; it doesn't make the record true.
  The retention gate and verification loops are what make records trustworthy,
  and they're only as good as their oracles — which is why
  [testing](testing.md) is a separate doc.
