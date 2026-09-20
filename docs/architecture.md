# Architecture

One file is the kernel: **`swarm_model_runtime.js`** (~39,000 lines). Chat,
learning, skills, and verification loops all live there. Around it sit capability
modules the kernel loads — the discourse miner (`swarm_discourse_miner.js`), the
agentic coding loop (`swarm_code_agentic.js`), the WordNet dictionary
(`swarm_wordnet_capability.js`), and others. The kernel orchestrates; the modules
do the specialized work.

## The request flow

Every chat turn goes through the same pipeline:

```
message
  │
  ▼
classify intent ──► route to lane ──► consult retained knowledge
  │                                        │
  │                     (taught facts, instruction pairs, preferences,
  │                      success operators — newest first, strong beats weak)
  │
  ▼
compose answer (lane template + consulted knowledge + native lanes)
  │
  ▼
choke-point screen ──► final gate: no internal records ever become answers
  │
  ▼
answer (+ the discourse miner observes the turn, learning happens,
        checkpoint fires if anything was learned)
```

Three rules hold across the whole flow:

1. **Consulted knowledge outranks canned answers.** A retained taught fact beats
   the lane's default template. A completed instruction pair beats a generic
   reply. This is the [consultation layer](#the-consultation-layer) — it's what
   makes teaching work at answer time, not just at storage time.
2. **Native lanes are never hijacked.** Math, time, and dictionary questions are
   answered by dedicated native capabilities, and no learning or consultation
   path is allowed to override them.
3. **The choke-point filter is the last thing that touches an answer.**
   [Safety](safety.md) has the details.

## Chat lanes

The classifier (`classifyLariUnifiedTaskIntent`) assigns each message an intent,
and each intent gets a lane — a way of answering suited to that kind of message:

| Lane | Handles | Example |
|---|---|---|
| `open_chat` | Open-ended conversation | "what's on your mind" |
| `small_talk` | Greetings, phatic chat | "hey whats up" |
| `self_identity` | Questions about Lari himself | "what does LARI stand for", "who created you" |
| `planning` | "Plan X for me" requests | "plan my vegetable garden" |
| `code` | Coding tasks | "fix this function" |
| `greeting` | Hellos | "hey" |
| `preference` | Stated preferences | "I like concise answers" |

Answers come from stable self-knowledge when no retained record matches — Lari
knows he's Lari, he/him, Local Autonomous Recursive Intelligence, built by Greg
— and from honest deflections when nothing matches at all. Vague requests get one
clarifying question, not a lecture.

Lanes are routing, not cages: a taught fact can beat inappropriate lane routing.
If you taught Lari the thesis and ask about it in a way that classifies oddly,
the taught fact still wins. (This was a real bug once — lane precedence over
taught knowledge — and it's fixed.)

## Native lanes

Three capabilities are wired as **native** — deterministic, local, no learning
involved, no bluffing:

- **Math** (`native_math_reasoning`). "whats 12 * 8" goes straight to the math
  lane and comes back 96. No retrieval, no guessing.
- **Time** (`isLariTimePrompt`). Date/time questions answered from the clock.
- **Dictionary** (`isLariDefinePrompt`, backed by Princeton WordNet via
  `swarm_wordnet_capability.js`). Every chat turn enriches content words with
  definitions; unknown words fall through to honest "I don't know" — he never
  bluffs a definition. Factual questions are excluded from dictionary handling
  so research keeps them.

Native lanes answer through their own routes. The consultation layer explicitly
cannot override them — a taught fact about arithmetic will never beat the
calculator.

## The consultation layer

This is the read side of [learning](self-learning.md). When a lane is about to
fall back to a canned answer, the kernel first asks: *do I have retained
knowledge that answers this better?* Consult order:

1. **Instruction pairs** — a completed correction pair for this kind of prompt.
2. **Taught facts** — explicit "remember that" teachings (exact match first,
   then a soft second pass: token/stem/WordNet-synonym/bigram overlap, with
   subject tokens excluded so one fact can't bully every question).
3. **Preferences and success operators** — how you like answers, and response
   shapes that worked before uncorrected.

Strong evidence beats weak: an explicit teaching outranks a fuzzy match, and a
newer record outranks an older one on the same topic. When a taught fact wins,
the trace records the phase as `taught_fact_precedence` — you can see exactly
why the answer changed.

The planning lane consults too: a retained fact about requested steps outranks
the generic plan template. (And the template's "- Next:" suffix no longer trips
the leak filter — it once contained the word "benchmarked.")

## What's in the model file

The model file isn't weights. It's a JSON document of executable state:

- **`lariLearnedRecords`** — taught facts, research acquisitions, instruction
  pairs, each with provenance (where it came from, when, verification status).
- **Discourse miner state** — turn log (capped at 200), failure→recovery pairs,
  induced procedures, success exemplars, per-intent calibration bins.
- **`lariConsolidatedBeliefs`** — durable beliefs from nightly consolidation.
- **Skills and operators** — retained procedures with verification evidence.
- **Learned discourse operators** — reusable response patterns.

Everything learned carries provenance. Nothing is a black box — you can open the
file and read what he knows and where it came from. That's the thesis made
concrete: the swarm is the model because the model *is* the retained swarm.
