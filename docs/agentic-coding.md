# Coding: what Small Lari does and doesn't do

Small Lari is a chatbot — chat, research, persistent learning. On coding, the
line is simple: **he answers coding questions, he doesn't build software.**

What that means in practice:

- **Yes:** explaining code, answering "how do I ..." questions, showing
  snippets, debugging a code block you paste into chat (he runs it, finds the
  issue, and only answers when the fix verifies).
- **No:** autonomous coding-goal work, multi-file project construction,
  background build/repair jobs, "things I build for you." The opportunistic
  coding-goal worker that used to run after coding turns was removed from the
  runtime in September 2026.

## The machinery in the repo

`swarm_code_agentic.js` comes from the research lineage and implements an
execution loop with five modes:

| Mode | What it does | Used by Small Lari chat? |
|---|---|---|
| **DEBUG** | Broken code + error → fixed code, fix verified by execution. Pattern repair first, bounded mutation (≤5 attempts) after. | **Yes** — pasted snippets only |
| **MULTI-FILE** | Tasks spanning modules and real imports. | No |
| **COMPOSE** | Combines retained, verified solutions into bigger programs. | No |
| **SELF-CURRICULUM** | Invents harder practice tasks from mastered ones. | No |
| **RESEARCH WHEN STUCK** | Researches an unknown concept, retries with the new knowledge. | No (as a coding mode) |

The policy the loop was built around still applies wherever it runs:
**attempt → execute → verify → retain**, and the rule from tutoring session 6:
**never claim code works unless it has actually been run and checked.**

Test suites: **23/23** on the agentic coding battery. That result is real and
stays in the repo's history — it just describes the module, not the chatbot.
Small Lari's verified claims are about conversation and learning, not building.

## The honest boundary (from tutoring session 6)

Greg found that tutoring installed coding *knowledge* but not coding
*behavior*: Lari could recite the four-step debugging method perfectly yet
dodge when asked to trace a broken loop in chat. Small Lari doesn't pretend
otherwise. He talks about code well, fixes pasted snippets with real
verification, and tells you plainly when something is beyond a chat answer.

## "Go learn X" still works

The autonomous topic learner (`swarm_code_learn.js` — "go learn Python") is
research machinery, not building machinery: it studies a topic, runs doc
examples to verify them, cross-checks implementations on fresh inputs, and
retains what verifies. That stays — research is one of the three things Small
Lari is for.
