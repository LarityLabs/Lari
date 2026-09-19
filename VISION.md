# Lari — vision, identity, and what not to do

Read this before changing anything. `LARI_WORKING_CONTEXT.md` tells you the current state and the working rules;
this tells you what Lari *is*, why it is built this way, and which actions would quietly destroy it.

Most of the damage available here is not a crash. It is a number that looks better than it is, a
capability that looks real and is not, or months of work discarded by a single command. All three have
already happened once.

---

## 1. What Lari is

**Local Autonomous Recursive Intelligence.** A local-first model whose durable intelligence lives in
executable, inspectable state — retained operators, verified rules, typed memory, provenance — rather
than in pretrained weights.

The thesis (`LARI_PAPER.md` §1) is that **the swarm is the model**: the runtime, memory, verifiers and
learned procedures are not a wrapper around intelligence, they *are* the model. The boundary moves.

**The paper is the product.** A verified repair tool without self-growth competes with existing
automated-program-repair tools and loses. The self-growing part is the entire differentiator. If a
change makes Lari better at repair but removes its ability to grow, it is a bad change even if the
number goes up.

**What has actually been demonstrated** (2026-07-26): given a defect class its vocabulary could not
express, Lari proposed a generic substitution rule, verified it against 1317 assertions it does not
control, retained it, and thereby repaired defects it previously could not — `0/5` with growth disabled
against `5/5` with it enabled, same set, same budget. That is capability *acquired*, not selected. It
is the first result in this project that could not have been produced by a lookup table.

---

## 2. What success looks like

In order of how much each would matter:

1. **Rules learned on one codebase measurably improve repair on another**, with no learning during the
   test. ✅ **Shown once, 2026-07-27**, on blind set `transfer-460719`: baseline `5/8`, transfer `6/8`,
   the delta being an AOR defect the seed vocabulary cannot express, repaired by a rule grown on
   inflection, at candidate 1 of 188. It is n=1 — an existence proof about the mechanism, not a rate.
   The next question is whether it holds across repositories and defect classes, which needs sets
   where more than one instance is eligible.
2. **A blind sealed score moves after a curriculum** with nothing keyed to those repositories.
3. **Capability compounds**: a compression step that promotes shared structure across retained rules
   into new primitives, so the vocabulary grows in power and not only in length.
4. **Lari talks in its own voice** — a generator built from Lari's own executable state, grounded in
   retained claims, with fluency and taste learned from its user.

**What success does not look like:** a high number on a set built to be passed, a benchmark suite that
cannot fail, or a capability table that reads better than the evidence supports.

---

## 3. Identity constraints — these are not negotiable

**Do not route Lari's answers through another model.** Not Ollama, not Qwen, not Llama, not an API.
This is the one thing the owner has ruled out explicitly and repeatedly. Ollama may exist only as
external training pressure or a competitor benchmark, never in the answer path. If chat quality is bad,
the answer is to build Lari's own generator, not to borrow someone else's.

**Building Lari's own text generator is wanted, not forbidden.** The objection is to Lari being a
wrapper, not to Lari being able to speak. A generator made of Lari's own executable state — semantic
claims, discourse operators, realization rules learned by verified proposal — is squarely in scope and
is the most interesting unbuilt thing here.

**Model state holds procedures, never answers.** A retained artifact must be a *rule* (`% → //`), never
a *location* (`line 47 of clip.py becomes X`). The first generalises to any file; the second is a
memorised answer keyed to one case, and is exactly what invalidated this project's GSM8K score.
`storesTestAnswers: false` is a claim you assert in a test, not a label you attach.

---

## 4. What not to do

### Measurement

- **Do not re-run a set you diagnosed against to get a better number.** Once you inspect a set's
  failures and change the system in response, that set is a dev set forever. Its recorded score stands.
  Generate a new seed — it is one command.
- **Do not regenerate sets until the composition flatters the engine.** That is fishing. The seals
  record `regeneratedUntilCompositionWasFavourable: false` because it matters.
- **Do not quote a declared targeted experiment as a capability score.** The `5/5` growth result comes
  from a set built specifically from a class the seed vocabulary could not express. It proves the
  mechanism; it says nothing about general capability. The blind record is `0/6, 0/6, 2/6, 1/6`.
- **Do not add a repair family, rule, or heuristic to make a specific sealed set pass.** That is the
  GSM8K failure with better manners.
- **Do not cite `lari:truth`, `lari:smoke`, or `lari:soak` as capability.** They ask questions whose
  answers are hardcoded string literals; they cannot fail for capability reasons.
- **Do not report a number without its caveat.** The caveat is part of the number. Every serious
  distortion in this repo's history came from a true statement losing its qualifier on the way into a
  summary.
- **Do not soften an oracle after seeing a result.** Strengthening one that demonstrably admitted a
  wrong answer is allowed and must be disclosed; weakening one is never allowed.

### Destructive actions

- **Never run `git checkout`, `reset --hard`, or `clean` in the main repo without checking `git status`
  first.** This repository once carried ~9,000 uncommitted lines in a single file; one careless command
  would have destroyed months of work.
- **Never write to `models/lari/current/swarm-model.json` during an experiment.** Copy it. Every
  measurement script verifies the active model is unchanged, and that check exists because it is easy
  to get wrong.
- **Never commit `*.backup-*` model snapshots.** They contain the quarantined contamination. The
  `.gitignore` pattern was wrong once and let one through.
- **Never `git add -A` without looking at what is staged.** `consolidation/` is 19 GB and was
  unignored; an embedded ARC-AGI clone would have produced a repository nobody could clone.
- **Do not delete the quarantine.** `consolidation/contamination-quarantine/` holds the 875 fitted
  records deliberately, so the contamination stays auditable and the fix stays reversible.

### Engineering

- **Do not build a capability without naming its automatic oracle first.** Where this repo had a
  verifier it grew real operators; where it had none, the loop filled the vacuum with the answer key
  and canned strings. That is not a discipline failure, it is what a growth loop *must* do when
  "verify" has nothing to call.
- **Do not trust a benchmark that has never failed.** If no possible outcome would have shown you were
  wrong, it is decoration.
- **Do not copy hardened infrastructure — share it.** The runaway-timeout and orphaned-process bug had
  to be fixed twice, in two files, because the fixed runner was duplicated.
- **Do not infer failing test ids from a filename.** Take them from the baseline run. Guessing produced
  three separate false diagnoses in one session.
- **Do not assume a slow run is working.** Three separate infrastructure defects here only appeared
  under real load and were invisible to review. Check CPU before reporting progress: one run was
  reported as advancing for three hours while a single candidate spun on 12,522 seconds of CPU.
- **An oracle that errors must never look like an oracle that rejects.** Two separate faults have now
  made the verifier answer "no" for correct code — a UTF-8 pipe fault that scored `0/87` on non-ASCII
  files, and a stale bytecode cache that did it *intermittently*, because almost every mutation here
  preserves file size and Python keys `.pyc` staleness on (mtime, size). The intermittent one is worse:
  a consistent fault leaves a clean zero in the log, a flaky one sprinkles false rejections through
  every run in proportion to how fast the search goes. Errors are counted separately now and a run
  that judges nothing stops. **Verify the oracle accepts known-good source before trusting a score.**
- **Check what a fault can do, not just what it did.** A false rejection costs a repair; a false
  acceptance poisons the retained vocabulary. Rules retained under a false-rejection fault are still
  sound, because each was verified by a real pass — worth knowing before discarding a trained model.
- **Do not spend an hour measuring what an instrument can answer in a minute.** A rerun that would
  have "answered" the transfer question was, on inspection, guaranteed to reproduce its previous score
  exactly: the budget had been exhausted, and reordering an exhausted list changes nothing. Ask what
  result the run *could* produce before starting it. `scripts/probe_lari_search_reachability.js` answers
  reachability for about 1/80th of the cost of a measurement, and every search fix on 2026-07-27 came
  from it rather than from a run.
- **A parameter tuned on a set is part of that set's burn.** `PRIOR_BUDGET_SHARE` and
  `REGION_MAJOR_PRIORS` were chosen by sweeping the burned dev sets. That is the correct place to tune
  and the wrong place to report, so the sweep is disclosed in the source next to the constants.
- **When a setting suits only the set built to be passed, it does not get a vote.** Whole-pool prior
  ordering reached 3/5 on the AOR-restricted set and cost an instance on the unrestricted ones. Totals
  across both would have endorsed it.

---

## 5. How to behave when something looks good

The failure mode this project is most vulnerable to is not laziness. It is **motivated interpretation**
— reading an ambiguous result in the direction you were hoping for.

The habits that have caught real errors here, all worth keeping:

- **Seal a prediction before measuring**, including what result would count as failure. Predictions in
  this project have been wrong more often than right, and every wrong one was informative.
- **When a number is surprisingly good, check the mechanism before believing it.** A `4/4` was once
  `3/4` semantically, because one oracle was too weak to reject a wrong patch.
- **When a number is surprisingly bad, check the harness before concluding.** A `0/5` was a discarded
  priors bug, not a transfer failure — the correct candidate was generated and never reached.
- **Report your own mistakes in the commit message.** This repo's history contains the author storing
  gold answers hours after writing the guard against it, and pointing a verifier at the wrong tests
  three times. That record is worth more than a clean-looking log.

---

## 6. The honest position

Lari today is a **local, inspectable, verified code-repair system with real learning and unusually good
provenance**, whose repair works under good fault localization and is partial without it. It does not
have a text generator. Its "computer management" is largely simulated. It has no official SWE-bench
score.

It also has something genuinely rare: a growth loop that acquires capability its source never
contained, and a measurement culture that can tell its own author he is wrong.

"Local Autonomous Recursive Intelligence" is an honest target and a good name. It is not yet a
description. The gap between the two is the roadmap — and it closes by moving measurements, never by
moving language.
