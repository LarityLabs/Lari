# How Lari learns

This is the part that matters. Lari doesn't get smarter by downloading a bigger
model — he can't, that's the whole point of the project. He gets smarter the way
you'd expect something to get smarter: **someone talks to him, corrects him, teaches
him things, and what survives verification stays.**

There are five learning mechanisms, and they all feed the same brain
(`models/lari/current/swarm-model.json`):

1. **Taught facts** — you tell him something, he keeps it.
2. **The retention gate** — nothing is kept unless it proves itself.
3. **Instruction pairs** — corrections become reusable procedures.
4. **The discourse miner** — every conversation is quietly observed for signals.
5. **Nightly consolidation** — the day's episodes distill into durable beliefs.

Plus the machinery that keeps it honest: **calibration** (he tracks how often he's
wrong, per topic) and **checkpointing** (the brain is written to disk after learning).

```
you say something
      │
      ▼
┌─────────────┐
│ chat turn    │──► taught fact? ──► extract ──► retention gate ──► retained
│              │
│              ├──► correction? ──► failure→recovery pair ──► 3 in a cluster
│              │                                          ──► induce procedure
│              │
│              ├──► uncorrected ×3? ──► success operator
│              │
│              └──► turn logged as an episode
└─────────────┘
      │
      ▼ (nightly)
┌─────────────┐
│ consolidation │──► episodes ──► beliefs (contradictions arbitrated)
└─────────────┘
      │
      ▼ (every learning turn)
┌─────────────┐
│ checkpoint  │──► brain written to disk, backup kept, old backups pruned
└─────────────┘
```

## 1. Taught facts: "remember that"

The simplest loop. You say:

> "the thesis is the swarm is the model. remember that"

and later ask "what is the thesis" and get back "The thesis is the swarm is the
model." That's it. That's the demo that works.

Under the hood: the chat turn is scanned for an explicit teaching ("remember
that" / "remember this," fact before or after the phrase). The fact is extracted —
topic plus summary — and stored as a typed knowledge record (`kind:
'taught_fact'`, confidence 0.9). Explicit user statements start confident. Storage
is idempotent: re-teaching the identical fact updates it in place; a reworded
teaching of the same topic adds a new record and the newer one wins at read time.

At answer time, the [consultation layer](architecture.md#the-consultation-layer)
checks taught facts *before* falling back to canned answers. So "when I say thanks
just say 'anytime'" is honored on the next "thanks" — taught once, served forever,
and it survives a full restart and reload. That's the pinned regression test:
`thanks → anytime` must hold through a reload, every time.

What doesn't count as a teaching: "remember that" alone with no fact, questions,
or fragments under three words. Those are ignored, not stored.

## 2. The retention gate: nothing kept on faith

This is what separates Lari's learning from a notebook that writes down
everything. When Lari goes and researches something on his own (autonomous
research), the learned record is **not kept automatically**. It's kept only if it
demonstrably answers the question:

- The follow-up answer built from the new knowledge must **pass** its own
  verification gate.
- The learned summary must satisfy the question's **frame role** — a definition
  question needs the right subject (this caught a real bug: a confident record
  about Einstein that was actually about his son Hans), a date question needs a
  date, a count question needs a number.

If either check fails, the acquisition is **rolled back** — the model is restored
from a snapshot taken before learning, the record is marked `retained: false`,
and the trace says why (`followup_answer_still_failing` or
`frame_role_not_satisfied`). Research that doesn't help must not accumulate.

Early junk probes proved the gate works: questions about breakfast, Narnia, and
WWII aircraft produced records that failed follow-up and were discarded, not
kept. The model doesn't fill up with trivia.

## 3. Instruction pairs: corrections become procedures

When you correct Lari, he doesn't just fix that one answer — he learns the
*pattern* of the fix.

The miner watches every turn. A correction marks the previous turn as failed.
When the next answer is accepted (no further correction), the triple becomes a
**training pair**: `{prompt, failedAnswer, correctedAnswer}`.

There's also a fast path: if your correction literally dictates the right
response ("just say 'anytime'"), the pair forms immediately without waiting.

Pairs are clustered by discourse goal. **Three pairs in one cluster triggers
induction**: a general procedure is synthesized from the failures and stored as a
reusable operator. The induced procedure is then verified — at least 2 of 3
training prompts must route through it — or it doesn't stick.

Separately, **success exemplars**: every uncorrected turn is evidence that a
stimulus → response shape works. Three uncorrected repetitions of the same shape
induces a **discourse operator** — a reusable way of responding. A correction
resets the exemplar for that stimulus, so bad habits can't entrench.

Real example from the logs: Greg taught "when I say thanks just say anytime."
One correction, one pair, and the behavior was retained through a restart. The
session-6 transcript shows pairs going 5 → 6 and success exemplars 72 → 101 over
34 turns of tutoring.

## 4. The discourse miner: every turn is observed

`swarm_discourse_miner.js` runs on every chat turn. It's pure observation — it can
never break chat (it's wrapped so failures are silent). For each turn it detects
one signal:

| Signal | What triggers it |
|---|---|
| `correction` | Explicit correction phrasing, a bare "naw," or a leading rejection ("naw man, that wasn't an answer") |
| `rephrase` | You rephrase your previous question (content-word overlap ≥ 0.55) — an implicit correction |
| `approval` | Approval phrasing |
| `neutral` | Everything else |

It also maintains **per-intent calibration**: for each intent (chat lane), it
tracks turns vs. corrections. Once an intent has 5+ turns and a correction rate
above 20%, reported confidence is scaled down:

```
calibrated = raw × max(0.5, 1 − rate × 0.8)
```

So if Lari gets corrected on 50% of planning answers, his reported confidence on
planning drops to 0.6×. The raw confidence is untouched — calibration is a
measurement laid over it, and it becomes self-knowledge: consolidation turns
calibration stats into beliefs Lari can report ("what do you know about
yourself" includes his own correction rates).

Honest note: calibration currently only *measures*. The designed next step — Lari
actually answering more carefully when his correction rate is high — is not built
yet.

## 5. Nightly consolidation: episodes become beliefs

Raw conversation turns are footage; beliefs are the distilled memory. Once a
night, `scripts/run_lari_consolidation.js` walks each user's model and:

1. **Distills episodes into beliefs** — identity facts, preferences, directives,
   topic familiarity, and self-knowledge from calibration stats. Extractive, not
   generative: it pulls what's there, it doesn't invent.
2. **Arbitrates contradictions** — if a new belief contradicts an active one,
   higher **confidence × recency** wins. The loser is *superseded, never
   deleted* — the history stays auditable. Recency is measured by when the
   episode was observed, not when the belief row was written.
3. **Caps at 100** — the 100 most confident active beliefs per scope survive;
   the rest are pruned.
4. **Idempotent merges** — belief IDs are hashes of (type, subject, predicate,
   object), so re-running consolidation on the same episodes changes nothing.

Each user's model gets a backup first (last 7 consolidation backups kept), and the
write is atomic. On Greg's setup this runs nightly via a scheduled job.

## 6. Checkpointing: the brain hits disk

Learning that evaporates when the process exits isn't learning. After any chat
turn that learns something, the model is checkpointed back to its file:

- **Validated first** (a corrupt model is never written), **timestamped backup**
  taken before overwriting, **atomic write** so a crash can't leave a half-file.
- Backups are pruned to the **newest 5** (`LARI_CHECKPOINT_BACKUPS` overrides) —
  this exists because ~30MB backups once filled a 512MB tmpfs twice.
- Checkpointing wraps only the outermost turn, skips turns where nothing was
  learned, and can be disabled with `LARI_DISABLE_LEARN_CHECKPOINT=1`.

## 7. Tutoring sessions: Greg teaches him directly

The most direct loop: Greg sits down and teaches Lari things in plain chat, like
a tutor with a student. Session 6 (September 19, 2026) is the documented one —
34 turns on the live model, teaching coding knowledge:

- The four-step debugging method (reproduce → isolate → fix → verify)
- Review order: correctness → edge cases → readability
- Plan before building non-trivial work
- Never claim unverified code works
- Race conditions, unclosed Go channels hanging, off-by-one errors

Result: **7/7 teachings retained and served on retest**, zero internal leaks
across 34 turns. The model grew (taught facts 12 → 19, success exemplars 72 →
101). The transcript is the proof — it's in the repo's session files, turn by
turn, including the failures.

Because the failures are the interesting part:

- **The code lane swallowed teachings.** Inputs containing words like
  bug/fix/verify routed to a canned code-lane reply *before* extraction ran, so
  teachings on those turns were never stored. Identical facts taught without the
  trigger words stuck 3/3; with them, 0/3. Fixed the same day: extraction now
  fires for code-lane turns too.
- **Consultation was paraphrase-brittle.** A stored fact failed a paraphrased
  retest but passed with one shared word. Fixed with a second-pass soft matcher
  (token/stem/synonym/bigram overlap) that respects the anti-bullying rule —
  one fact must not match every question that mentions Greg.
- **The constraint lane emitted filler.** "Calm words provide useful practical
  detail." — literal nonsense, plus a mangled echo that dropped the word
  "checked." Root-caused to a parser bug (conversational negatives treated as
  forbidden words) and fixed.

## What's honest and what's not here

**Real:** taught facts persist and are served; corrections induce reusable
procedures; uncorrected repetitions induce response operators; junk research is
discarded by the retention gate; nightly consolidation distills beliefs with
contradiction arbitration; per-intent correction rates are measured and reported;
checkpoints are atomic with pruned backups.

**Lossy:** learning drops things. Five distinct teaching-loss layers were found
and fixed in September 2026 (extraction missing paths, instruction wrappers
poisoning stored facts, weak evidence outranking strong facts, lane routing
beating taught knowledge, pairs failing to form). There may be a sixth.

**Knowledge, not behavior.** Tutoring installs coding *knowledge* — Lari can now
recite the debugging method. It did not make him *apply* it: he still can't trace
a buggy loop or defend an opinion in chat. The doing lives in the
[agentic coding loop](agentic-coding.md), which is genuinely strong and genuinely
not wired into chat yet. That wiring is the next build, not a tutoring session.

**Not built:** the behavioral hedging gate (answering more carefully when
correction rate is high). Designed, measured for, not implemented.
