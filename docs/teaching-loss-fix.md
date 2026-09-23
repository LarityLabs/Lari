# Teaching-loss fix (2026-09-23)

## What this was

The five diagnosed teaching-loss layers (session 5, 2026-09-19) were closed
that week and the acceptance battery passed 12/12. But two lanes added
*after* the fixes silently re-opened the leak: the architecture
self-knowledge hook and the topic-misroute guard (both 2026-09-22) run in
`sendMessageToLariAsyncInner` **after** the first pass and overwrite answers
the teaching pipeline already grounded in retained state. A later lane
beating taught knowledge is the teaching-loss pattern all over again.

## The diagnosis, confirmed vs inferred

All five original layers were confirmed in docs/self-learning.md and in
`scripts/test_lari_layer{1..5}_*.js`. Running those suites on HEAD showed
three regressions, all confirmed by direct debugging (not inferred):

1. **Architecture hook drops strong taught facts (layer-4 regression).**
   Teach "lari is short for singularity", ask "what does the name lari
   mean": the Layer-4 precedence branch found the fact, but
   `answerArchitectureQuestion` matched the KB entry "what is lari" by
   token overlap and overwrote the answer with the canned identity text.
   The same hook overwrote the in-kernel self-identity merge for
   "so who are you", losing the pinned he/him + Larry line.
   (acceptance 11/12, layer-4 10/12 on HEAD.)
2. **Architecture hook drops code-lane teachings (layer-1 regression).**
   Teach the debugging-steps fact on a code-lane turn, ask "what are the
   steps for debugging": `retained_knowledge_precedence` served the fact,
   then the hook matched "debugging" by affix and overwrote it with the
   canned agentic-coding blurb. (code-lane suite 10/11 on HEAD.)
3. **Topic-misroute guard nukes paraphrased taught facts (layer-3/R8
   regression).** Session-6 R8: "what are the four steps for handling
   problems" — the soft-matcher consultation served the taught fact, but
   the guard's keyword check (`keyTerms.length >= 2 && !mentionsSubject`)
   mistook a paraphrase (zero shared tokens *by design*) for a misroute,
   replaced the answer with a shortfall, and the research-retry path
   answered from a Brown University web page. (paraphrase suite 15/16.)

Also found: `test_lari_layer1_extraction_paths.js` section 5 still asserted
the pre-fix behavior ("code-lane turns store nothing"), contradicting the
later fix (commit 332b19e), its own sibling suite
`test_lari_code_lane_extraction.js`, and docs/self-learning.md. Stale test,
not a code bug.

## What changed

- `swarm_model_runtime.js`: new `firstPassAnswerIsRetained(model,
  response, message)` guard (never throws). It returns true when the
  first-pass answer is already grounded in retained state: explicit
  precedence actions (`taught_fact_precedence`,
  `answer_from_retained_research`, `answer_with_repaired_skill`,
  `session_context_memory`, ...), retained trace phases, a
  `verified_retained_knowledge` public answer source, the self_identity
  in-kernel merge, or an answer whose text matches a retained taught-fact
  summary / instruction-pair response. The architecture hook and the
  topic-misroute guard in `sendMessageToLariAsyncInner` now skip when it
  returns true. Non-retained answers behave exactly as before.
- `scripts/test_lari_layer1_extraction_paths.js`: section 5 updated to the
  intended behavior (code-lane teachings are extracted and stored).
- `scripts/test_lari_teaching_retention.js` (new): end-to-end retention
  battery, N=23 (19 facts + 4 procedures), covering all five layers.

## Before/after numbers

Retention battery methodology: fresh scratch model (never the live file);
phase 1 asks every retest prompt *before* teaching and aborts if the model
already knows any item (all 23 were novel both runs); phase 2 teaches all
items once through `sendMessageToLariAsync`; phase 3 retests. "Survived" =
retest answer carries the expected content (keyword / exact-match per
item, same judging style as the existing suites).

| run | stored | survived | notes |
|---|---|---|---|
| before fix (HEAD, unmodified) | 23/23 | **21/23 (91%)** | lost: `singularity` (arch hook), `four-steps` (misroute guard) |
| after fix | 23/23 | **23/23 (100%)** | both recovered; extraction was never the problem |

Both losses were LOST@serve, not LOST@extract: extraction is 23/23 in both
runs. The ~4/10 baseline from the original diagnosis is long closed; this
build closes the two regressions that had re-opened serving-side loss.

Suite results after the fix: layer1 10/10, layer2 12/12, layer3 11/11,
layer4 12/12, layer5 16/16, tutoring acceptance 12/12,
code-lane extraction 11/11, consultation paraphrase 16/16, chat battery
46/46 (100%), self-knowledge answers green. No external model calls in any
run; live model file never touched (scratch models only).

## Remaining limits (honest)

- The architecture hook's matching is crude (affix + token-subset); the
  guard approach fixes the symptom (overwriting retained answers) but the
  hook can still misfire on non-retained questions. A proper fix would rank
  KB entries instead of first-match.
- `test_lari_learn_retention.js` fails identically with and without this
  change: the registry's contamination guard refuses the repo's model
  snapshot (875 stored benchmark-answer back-references). Pre-existing,
  unrelated to teaching loss.
- `test_lari_instruction_constraint_realization.js` has one failing check
  (sentence-count shaping returning off-topic content) — a realization
  issue, not a retention issue; out of scope here.
- Directive pair formation still doesn't cover every phrasing ("when I ask
  if the coast is clear" extracts a stimulus the consult doesn't match;
  "goodnight" is owned by the goodbye lane). Not part of the diagnosed
  five; left as is.
- Retention was measured on a fresh model with 23 items in one session;
  long-horizon retention (consolidation pruning, 100-belief cap, checkpoint
  restores over days) is not covered by this battery.
