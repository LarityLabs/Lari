# Native Python-semantics lane (2026-09-23)

## Why

The three-track build (2026-09-23) converged on one finding: Lari's learning
machinery (research→persist, practice→verify, ordered study) works, but the
**answering/serving layer is the binding constraint**. The curriculum walk
proved it: 527 sourced sentences persisted across 15 topics, yet units 2–3
failed because program-trace questions never reach an answerer that can run
code — a while-loop trace was answered `-5`, deterministically and
confidently wrong, by the arithmetic quantity-guessing path.

## What it does

`swarm_model_runtime.js` gained a native lane, in the same style as the math
lane:

- **Detection** (`isLariPythonSemanticsPrompt`): fires only when the prompt
  names Python AND shows a fenced code block, an execution-oriented verb with
  code-like tokens, a described program ("a python while loop starts x at
  0..."), or a which-keyword/which-function language-fact question.
- **Extraction** (`extractPythonSemanticsCode`): fenced blocks verbatim, else
  conservative template synthesis for described programs (while/for loops,
  string indexing, string length). Returns null rather than guessing.
- **Language facts** (`LARI_PYTHON_LANGUAGE_FACTS`): a small deterministic
  table for unambiguous Python facts (`if` starts a conditional branch, `len`
  returns string length, ...). Stable language-definition facts, never
  synthesized.
- **Execution**: user or synthesized code runs through the existing
  `teach.runCodeSandbox('python', ...)` (temp dir, 8s hard timeout, captured
  stdio), additionally filtered by `isPythonSemanticsCodeSafe` (no imports,
  no I/O, no dunders, ≤40 lines). The answer is the **actual interpreter
  stdout** — never a guess.
- **Honest failure**: no extractable code, unsafe code, or failed execution
  → a stated gap (`python_semantics_failed`), not a fabricated output.

## Placement and guardrails

- The lane sits **after** `retainedKnowledgeRoute` in the kernel chain, so a
  taught fact still wins (teaching-loss guard), and **before** the math lane,
  so "python while loop ..." questions stop falling into arithmetic guessing.
- `formatLariSessionAnswer` now treats `native_python_semantics` as a
  grounded answer that outranks canned intent strings (same as
  `native_math_reasoning`) — previously the "I handled the coding task
  locally" canned string overwrote real interpreter output.

## Measured results (2026-09-23, scratch model state)

- Curriculum re-quiz (exact U2+U3 prompts): **11/11** (before: 7/11 —
  u2q5/u2q6/u3q4/u3q5 all failed; after: all four pass via
  `answered_python_semantics`).
- Chat battery: **46/46 (100%)**.
- Teaching retention: **23/23 (100%)**.
- Layer suites: 10/10, 12/12, 11/11, 12/12, 16/16; tutoring 12/12;
  code-lane 11/11; consultation-paraphrase 16/16.
- Unsafe code (`import os`) is rejected and reported honestly.

## Known limits

- Described-program synthesis is template-based; programs outside the
  templates fall through honestly rather than being attempted.
- The language-fact table is intentionally small — ambiguous mappings
  (e.g. "which keyword starts a loop") are left unanswered, not guessed.
- Terse prompts ("answer with just the number") get the bare value;
  otherwise the answer is prefixed with "I ran it in Python. Output:".
