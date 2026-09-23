# Curriculum Walk — Track 3 Build Note (2026-09-23)

First-slice proof of a CURRICULUM loop for Lari: ordered units, prerequisites
first, per-unit verification with checkable answers, advance only on pass.

## Syllabus chosen and why

**MIT OCW 6.0001, Introduction to Computer Science and Programming in Python
(Fall 2016)** — topic order taken from the real syllabus page, fetched live
2026-09-23 from
`https://ocw.mit.edu/courses/6-0001-introduction-to-computer-science-and-programming-in-python-fall-2016/pages/syllabus/`.
The calendar gives the faithful ordered unit list (12 sessions); the first
three are this slice:

| Session | Topic |
|---|---|
| 1 | What is computation? |
| 2 | Branching and Iteration |
| 3 | String Manipulation, Guess and Check, Approximations, Bisection |

Why 6.0001 over an OpenStax math text: Session 1 (expressions, operators,
precedence) maps directly onto the one answering capability Lari has that is
deterministically checkable today (the native math lane, "what is X? answer
with just the number"). A math text would have been equally plausible, but
6.0001 was the recommended pick and its unit 1 is the best fit for a real
end-to-end pass.

Problem sets are authored (in-repo, `scripts/lari_curriculum.js`) in the
course's finger-exercise style with exact known keys. The OCW syllabus itself
notes quizzes/finger exercises are not published on OCW, so faithful-but-
authored problem sets were the only option; every key is a literal value, not
a judgment call.

## Walker design

Two new files:

- `scripts/lari_curriculum.js` — orchestrator. Per unit:
  1. **Study**: research each topic anchor via the existing
     `scripts/lari_research.js` (`researchTopic`, Wikipedia MediaWiki API,
     deterministic distillation, zero external model calls). Distilled
     sentences merge into a SCRATCH researched-knowledge store with the same
     dedup/prepend/cap-60 semantics as the runtime's own
     `addLariResearchedKnowledge`. The store accumulates across units, so
     prerequisite material stays available (prerequisites-first ordering is
     real, not cosmetic).
  2. **Verify**: spawn a fresh child process (`lari_curriculum_quiz.js`) with
     `LARI_RESEARCH_STORE` pointing at the scratch store, so the runtime loads
     the studied material at init. Each unit gets a fresh scratch copy of the
     live model (`__lariSourcePath` → scratch); the live model is only ever
     read, never written. Questions are asked in order; answers are graded
     deterministically in the child — exact-match numeric (extracted number
     vs key) or exact-match single word. Lari never grades his own answers.
  3. **Advance**: pass threshold 75%. On fail, re-study ONCE with refined
     queries (anchor + "tutorial example"), re-verify. On second fail, the gap
     is logged honestly and the walker moves on.
- `scripts/lari_curriculum_quiz.js` — child quiz runner (fresh runtime load,
  per-question timeout 60s, JSON results).

Bound: first 3 units only (`--units N`, default 3). No push; one local commit.

## Measured results (executed 2026-09-23, run log in
`~/workspace/scratch/lari-curriculum/run-2026-09-23T04-44-00-570Z/`)

| Unit | Study material persisted | Quiz 1 | Re-study + Quiz 2 | Verdict |
|---|---|---|---|---|
| U1 What is computation? (8 Q) | 110 sentences, 3 sources | **8/8 (100%)** | — | **passed** |
| U2 Branching and Iteration (6 Q) | 230 sentences, 3 sources | 4/6 (66.7%) | 4/6 (66.7%) | **failed** (gap logged, advanced) |
| U3 String Manip., Guess and Check (5 Q) | 187 sentences, 7 sources | 3/5 (60%) | 3/5 (60%) | **failed** (gap logged, advanced) |

Scratch store totals: 15 topic entries, 527 sentences, all sourced
(Wikipedia). Live model and live researched-knowledge store untouched
(md5 of `models/lari/current/swarm-model.json` identical before/after).

## Failure handling log

Every failure got exactly the prescribed treatment: one re-study with
refined queries, one re-quiz, then an honest gap entry. Details:

- **u2q5** (trace a while loop: x=0, +1 while x<4; expected 4): both
  attempts answered `-5` via the "we compute the requested quantity"
  path. Deterministic, confident, wrong. Re-study (230 sentences on
  for/while/conditionals, incl. "tutorial example" refinements) changed
  nothing — the studied material never reaches the answering path for
  program-trace questions.
- **u2q6** (which keyword starts a conditional branch; expected "if"):
  attempt 1 → vague fallback ("That is a bit vague for me..."); attempt 2
  → different fallback. Concept MC questions do not consult researched
  knowledge.
- **u3q4** (which function returns a string's length; expected "len"):
  both attempts misrouted to an identity/recap lane ("Yo, back again. Greg
  has published books on Amazon..."). Not a knowledge gap — a routing
  failure.
- **u3q5** (first character of "hello"; expected "h"): both attempts
  misrouted to a code-review lane ("When you review something I wrote,
  check correctness first..."). Routing failure again.

The numeric questions in U2/U3 (unrolled-loop arithmetic, bisection
midpoints) all passed — but they were answered by the native math lane, not
by the studied unit content. They verify arithmetic, not iteration/strings.

## Limits and what a full-curriculum run would need

1. **The verify layer is the bottleneck, not the study layer.** Study →
   persist works end to end (527 sourced sentences into a scratch store,
   loaded by the runtime, zero external model calls). What fails is
   *answering*: only pure-arithmetic "what is X?" questions are
   deterministically answerable today. Everything else misroutes (race-
   condition definitions, Go-channel advice, Deep Thought hallucinations
   on `//`/`%`, identity-recap non-sequiturs) or vague-fallbacks.
2. **Attribution gap.** U1's 8/8 pass cannot be attributed to the study
   phase — the native math lane predates it. A real curriculum needs
   verification that distinguishes "already could" from "just learned";
   with today's answerer, novel unit content is exactly the content that
   can't be checked.
3. **Re-study is currently inert.** The refined-query pass added real
   sentences (e.g., +60 on U2 attempt 2) and moved zero scores. Re-study
   only helps if the answerer can consume the material.
4. **What a full run needs**: (a) an answerer that can do program-trace
   and concept questions deterministically — the most promising lever is
   a native Python-semantics lane (evaluate/trace small programs with the
   local interpreter and report the result, same pattern as the math
   lane) rather than more research; (b) routing fixes for the observed
   misroutes (the `print(`/code-question → race-condition/Go-advice
   misfires, `//`/`%` → Deep Thought hallucination); (c) parallel problem-
   set forms so re-study re-verifies on unseen items; (d) a mastery gate
   per unit (e.g., 2 consecutive passes) before the current single-pass
   advance.

Bottom line: the loop machinery is proven (ordered study → persist →
checkable verify → advance-on-pass → honest gap log). The curriculum it
can actually *teach* today is exactly one unit deep: arithmetic
expressions. Everything past that is blocked on the answering capability,
not the learning loop.
