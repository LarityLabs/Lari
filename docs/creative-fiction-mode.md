# Creative fiction mode (2026-09-23)

Greg directive: "i dont want to refuse creative writting lol" — Lari must make a
genuine attempt at stories, poems, descriptions, roleplay, continuations, and
other creative requests instead of refusing them.

## What was wrong

`scripts/lari_creative_core.js` (rebuilt 2026-09-21) only filled creative
structures from grounded, mostly verbatim source sentences: it needed at least
two suitable pool sentences, fixed forms needed enough source sentences to fill
every line, and structural demand beyond the pool returned `null`. The runtime
turned that `null` into an explicit refusal ("I cannot compose …; I am a
deterministic system with no generative language model, so I will not fake
one."), and creative+code combos got a separate "impossible" refusal.

Measured baseline 2026-09-23: 6 of 186 detector-classified creative IFEval
prompts refused (indices 20, 74, 192, 354, 426, 497).

## What changed

**`scripts/lari_creative_core.js`** — fiction mode (`fiction: true`,
`forceFiction: true` after a grounded attempt already failed):

- Deterministic fiction pool: WordNet glosses for lowercase common-noun topic
  tokens (capitalized names like Sarah/Harry are never glossed, so a fictional
  Sarah gets no dictionary identity) plus template-composed sentences from a
  local noun/verb/adjective/adverb bank, seeded by FNV-1a hash of the prompt.
  No `Math.random` anywhere; same prompt → same output.
- Fiction topic extraction: the creative ask lives in the prompt's first
  sentence; later sentences are mechanical constraints. Prefers the "about X"
  phrase cut at relative pronouns, else the last noun phrase ("a new line of
  shoes" → "shoes"). Strips instruction scaffolding (markdown, sections,
  "at least", length/tone adjectives).
- Structural scaling: "200+ word poem" → ~34 lines; "N sections" becomes real
  markdown sections only when the prompt says how they are marked ("marked
  with SECTION X", "markdown headers") — otherwise ("highlight 6 sections")
  it means highlight spans and the form's own structure wins. Italics/bold
  demands wrap content lines in `*…*`. "Mention the name X only once" keeps
  the first occurrence, later ones become "they".
- Verb agreement fixed (`carry→carries`, `vanish→vanishes`, `cross→crosses`).
- Totality: fiction mode always returns text when a form was detected.

**`swarm_model_runtime.js`** (sync composer + async chat hook):

- Grounded attempt first (unchanged priority), then forced-fiction retry.
- The poem-family creative refusal gate is gone; the `mode='creative'`
  refusal text ("I cannot compose…", "no generative language model",
  "I will not fake one") no longer exists anywhere in the runtime.
- Creative+code "impossible" combos are attempted as fiction: the invention is
  genuine, the unsatisfiable code demand is dropped, never presented as
  executable code.

**`scripts/lari_chat_generator.js`** — same fiction fallback for the creative
candidate.

Detection widened slightly: `advertisement` (was only matching "ad "),
`pretend`/`roleplay`/`in character` → formless creative.

## Honesty constraints kept

- Grounded mode still fills only from verbatim grounded sentences.
- Fiction never asserts real-world claims as fact; it invents openly.
- No fake feelings, no em dashes in user-facing text.
- Factual questions are untouched: `detectCreativeForm('What is the capital
  of France?')` → null, no fiction attempt.

## Results (2026-09-23)

- Creative IFEval: **0 refusals** (195 detector-classified prompts, incl. 9
  newly detected via widened patterns; was 6/186 at baseline).
- New `scripts/test_lari_creative_fiction.js`: 27/27 (six ex-refusals with
  structural spot checks, 7 form probes, real-world-topic fiction check,
  factual-question non-interception, determinism, grounded-still-null).
- Regressions: chat battery 46/46, teaching retention 23/23, layer suites
  10/10 + 12/12 + 11/11 + 12/12 + 16/16, math lane and python-semantics lane
  smoke-tested (12*8=96, interpreter run gave 9).

## Honest quality note

Deterministic template verse sounds mechanical next to an LLM. Grounded
outputs read like dictionary definitions strung into the requested shape;
fiction outputs read like Mad-Libs poetry: grammatical, on-topic, and
structurally exact, but with no real wit, imagery, or narrative arc. Zero
refusals was the target and it is met; quality beyond "genuine attempt" is
not claimed.
