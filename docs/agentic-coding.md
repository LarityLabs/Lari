# Agentic coding

Lari's coding ability lives in `swarm_code_agentic.js` — a separate execution
loop from chat, and the strongest thing in the repo. The policy for everything
it does:

**attempt → execute → verify → retain.**

And the rule Greg drilled into him in tutoring session 6: **never claim code
works unless it has actually been run and checked.** The loop enforces it
mechanically — verification isn't a promise, it's a test run.

## The five modes

| Mode | What it does |
|---|---|
| **DEBUG** | Takes broken code plus its error, fixes it, verifies the fix. Pattern-based repair first, then bounded mutation repair (≤5 attempts). |
| **MULTI-FILE** | Tasks spanning modules and real imports — not single scripts. |
| **COMPOSE** | Combines retained, verified solutions into bigger programs. |
| **SELF-CURRICULUM** | Invents harder practice tasks from ones already mastered. |
| **RESEARCH WHEN STUCK** | Hits an unknown concept, researches it, retries with the new knowledge. |

DEBUG is the workhorse. For wrong-output or logic errors it tries **verified
mutation repair**: small systematic mutations (off-by-one range fixes,
constant tweaks, operator swaps), each candidate actually executed against the
failing case. A fix counts only if the code runs and the failure is gone.

## What "verified" means here

- Every repair is checked against assertions the loop doesn't control.
- Test suites: **23/23** on the agentic coding battery.
- Retained solutions carry provenance — what fixed it, what verified it.
- The loop records failures as well as successes; the gap log is how
  SELF-CURRICULUM picks the next practice target.

This is also where the project's strongest honest claim comes from (see
[VISION.md](../VISION.md)): given a defect class its vocabulary couldn't
express, Lari proposed a generic substitution rule, verified it against 1317
assertions it didn't control, retained it, and repaired defects it previously
couldn't — 0/5 with growth disabled vs 5/5 with it enabled. Capability
*acquired*, not selected.

## The honest boundary

Here's the thing Greg found in tutoring session 6: **the execution loop is not
wired into chat.** In chat, Lari can recite the four-step debugging method
perfectly — reproduce, isolate, fix, verify — because Greg taught it to him.
But show him a broken loop in chat and ask him to trace it, and he dodges,
deflects, or emits filler. Tutoring installed coding *knowledge*; the *doing*
lives in the agentic modules, and the chat layer can't borrow that competence
yet.

So: Lari is genuinely good at agentic coding *as a module* (23/23, real
execution, real verification), and genuinely weak at coding *in conversation*.
Both are true. The next build is the bridge — detecting real coding tasks in
chat, routing them into the execution/verification machinery, and returning
plans, artifacts, and test evidence instead of words about code. That's a build,
not a tutoring session.

Until then: if you want Lari to actually fix code, use the agentic loop
directly. If you want him to talk about coding, chat works — just don't mistake
the talk for the doing.
