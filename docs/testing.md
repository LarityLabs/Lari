# Testing

The repo's rule, from the README: **a passing count is not evidence.** Repairs
need transfer tests against a dumb baseline. Every suite below is run with
`node scripts/<name>.js` and states its expected count up front — if the count
doesn't match, something regressed.

## The suites

| Suite | Proves | Expected |
|---|---|---|
| `test_lari_open_chat.js` | Open-chat routing + the fuzzy phatic layer (one-word changes don't break it) | 132/132 |
| `test_lari_leak_chokepoint.js` | The choke-point filter blocks internal records on every route | 38/38 |
| `test_lari_chat_no_internal_leak.js` | Internal records never become chat answers | 19/19 |
| `test_lari_answer_consultation.js` | Retained knowledge is consulted at answer time | 18/18 |
| `test_lari_discourse_miner.js` | Miner signals, pairing, induction | 31/31 |
| `test_lari_miner_learning.js` | Miner induces from real conversation, rejects junk | 30/30 |
| `test_lari_miner_legacy_migration.js` | Legacy miner state migrates cleanly | 22/22 |
| `test_lari_tutoring_acceptance.js` | Teach → retest battery (the permanent tutoring contract) | 12/12 |
| `test_lari_layer1_extraction_paths.js` | Taught-fact extraction fires on every chat path | 10/10 |
| `test_lari_layer2_wrapper_stripping.js` | The fact is stored, not the instruction wrapper | 12/12 |
| `test_lari_layer3_evidence_relevance.js` | No shared-token bullying (one fact can't match every question) | 11/11 |
| `test_lari_layer4_lane_precedence.js` | Taught facts beat inappropriate lane routing | 12/12 |
| `test_lari_layer5_unrecognized_intent_pairs.js` | Instruction pairs form for unrecognized prompts | 16/16 |
| `test_lari_code_lane_extraction.js` | Teachings on code-lane turns are retained | 11/11 |
| `test_lari_consultation_paraphrase.js` | Paraphrased questions find the right facts; bullying still blocked | 16/16 |
| `test_lari_instruction_constraint_realization.js` | No filler, no mangled echoes | 14/14 |
| `test_lari_attribute_chat.js` | Chat regressions | 8/8 |
| `test_lari_learn_retention.js` | Research → retain → recall; junk discarded | 10/10 |
| `test_lari_wordnet.js` | Dictionary capability | 20/20 |
| `test_lari_exam.js` | Exam self-testing loop | 16/16 |
| `test_lari_time.js` | Native time lane | 12/12 |
| `test_lari_code_agentic.js` | Agentic coding loop | 23/23 |
| `scripts/run_lari_consolidation.js` | Nightly consolidation (dry-run supported) | — |
| `lari-telegram/test/test_bridge.js` | Telegram bridge | 19/19 |

## Fail-before proof

New tests are written against a **pristine clone** first: the test must fail
there, for the right reason, before the fix lands. A test that passes before
and after proves nothing. The session-6 fixes each shipped with fail-before
evidence (4/11, 5/16, 4/14 on pristine — the intended failures, nothing else).

## Measurement honesty

This project has been burned by its own numbers before — a GSM8K score that was
really test-set answer fitting, quarantined 2026-07-25. The rules that came out
of it live in [VISION.md](../VISION.md) §4 and they're worth repeating:

- Don't re-run a set you diagnosed against to get a better number. Once you
  inspect failures and change the system, that set is a dev set forever.
- Don't report a number without its caveat. The caveat is part of the number.
- Don't trust a benchmark that has never failed. If no possible outcome would
  have shown you were wrong, it's decoration.
- An oracle that errors must never look like an oracle that rejects. Verify the
  oracle accepts known-good input before trusting a score.
- Report your own mistakes in the commit message.

The tutoring acceptance battery (`test_lari_tutoring_acceptance.js`, 12/12) is
the permanent contract: the concrete examples that once failed — "what does the
name Lari mean" → "Lari is short for Singularity," "are we good" → "all good
man," "thanks" → "anytime" — must keep passing, through reloads, forever.
