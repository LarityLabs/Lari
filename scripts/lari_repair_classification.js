#!/usr/bin/env node
'use strict';

/**
 * Separating repairs from patches that merely satisfy the oracle.
 *
 * Found 2026-07-29 while reading the curriculum-leap results. The blind set's SDL instance
 * `wcwidth-sdl-wcwidth_wcswidth_py-l306` was scored repaired in all three conditions -- seed, trained
 * and post-curriculum -- despite the seal stating that statement deletion is unreachable for every
 * condition because no repair family can express it.
 *
 * What actually happened: the mutation deleted `cluster_end = _scan_zwj_cluster_end(...)` at
 * _wcswidth.py:306. The winning candidate edited a *different* line, flipping the guard at :304 from
 * `last_measured_idx >= 0` to `< 0`. The deleted statement is still deleted, and the suite passes.
 *
 * That the suite cannot see this was verified directly rather than argued: applying only the guard
 * flip to *pristine* upstream, with no mutation present, leaves the suite green (1317 passed; the one
 * failure was `test_package_version`, a packaging artifact of the scratch copy). No test in the
 * project discriminates the guard's direction, so a patch that flips it is indistinguishable to the
 * oracle from one that repairs the defect.
 *
 * A correction, because the first version of this comment claimed more than the evidence supported.
 * It said the flip made the block "unreachable". Coverage says otherwise: line 306 executes
 * identically under pristine upstream, the mutant, the mutant plus the flip, and pristine plus the
 * flip. The block is entered in all four; the flip changes which iterations enter it, not whether.
 * The defensible claim is the narrower one -- an undiscriminated guard was changed and the seeded
 * defect was left in place -- and it is enough to justify the rule below without the stronger story.
 *
 * VISION.md forbids softening an oracle after seeing a result and explicitly permits strengthening one
 * that demonstrably admitted a wrong answer, provided the strengthening is disclosed. This is the
 * latter. It never turns a failure into a pass; it can only move a pass into a separate, weaker
 * category.
 *
 * ---
 *
 * The rule, and why it is this rule:
 *
 *   suspect  <=>  coveredByEngine === false  AND  restoresUpstreamExactly === false
 *
 * `coveredByEngine === false` means the seeded operator's class has no repair family, so the
 * vocabulary cannot express the inverse of the mutation. `restoresUpstreamExactly === false` means the
 * patch is not upstream's text. Together they are decisive: a defect the vocabulary cannot express,
 * "repaired" by a patch that is not the original code, cannot have been restored -- the edit must have
 * made the defect unobservable some other way.
 *
 * Both halves are load-bearing, and each one alone would be wrong:
 *
 *   - Out-of-range AND restoring is the *acquired-rule* case and must stay credited. All eight such
 *     repairs in this project's history are AOR instances fixed by `arithmetic-substitution` rules
 *     that growth proposed and verified, every one of them restoring upstream exactly. Those are the
 *     transfer result. Flagging them would delete the project's main finding.
 *   - In-range AND non-restoring is the *legitimate equivalent* case: `if last_vis <= -1:` for
 *     upstream's `== -1` is identical given `last_vis >= -1`. The family expressed the right class and
 *     found a variant. Flagging those would punish the engine for being right in an unexpected way.
 *
 * Applied to every result file in holdouts/results, the rule splits them exactly along that seam:
 * 8 out-of-range AOR repairs, all restoring, none flagged; 4 out-of-range SDL repairs (2 distinct
 * instances), none restoring, all flagged. There is no mixed case to adjudicate, which is the reason
 * to trust a mechanical rule here rather than a judgement call.
 *
 * Known limitation, stated rather than hidden: this catches branch-disabling only when the seeded
 * class is one the vocabulary cannot express. A guard flip that neutralises an in-range defect would
 * pass unflagged, and no signal available after the fact would separate it from a true equivalent.
 * Catching that needs the oracle to get stronger -- coverage of the defect line under the patched
 * suite is the obvious next instrument -- not this classifier to get cleverer.
 */

/** Operator classes for which the seeded defect is, by construction, a deletion of behaviour. */
const DELETION_OPERATORS = new Set(['SDL']);

/**
 * Classify one scored instance.
 *
 * Takes the fields the measurement path already records, so it can be applied retroactively to any
 * historical result file as well as to a live run.
 *
 * @param {object} result
 * @param {string} result.operator                   seeded mutation operator, e.g. 'SDL'
 * @param {boolean} result.coveredByEngine           does the seeded class have a repair family
 * @param {boolean} result.repaired                  did the patch pass the upstream suite
 * @param {boolean|null} result.restoresUpstreamExactly  is the patch upstream's text
 * @param {string|null} [result.family]              winning repair family, for the reason string
 * @returns {{ suspectEquivalent: boolean, suspectReason: string|null }}
 */
function classifyRepair(result) {
  if (!result || result.repaired !== true) {
    return { suspectEquivalent: false, suspectReason: null };
  }

  // Direct evidence, checked first because it is stronger than anything inferred.
  //
  // If the defect line is no longer executed by the tests that used to fail on it, the patch made the
  // defective code unreachable rather than correcting it. That is decisive and it does not depend on
  // whether the seeded class is in range, which is the gap the rule below cannot close: a guard flip
  // neutralising an in-range defect is indistinguishable from a legitimate equivalent variant by any
  // after-the-fact reasoning.
  //
  // `null` means coverage could not answer -- unavailable, or the patch shifted line numbers. It must
  // not be read as `false`. An instrument that cannot answer looking like one answering "no" has cost
  // this repository real results twice.
  if (result.defectLineCoveredAfterPatch === false) {
    return {
      suspectEquivalent: true,
      suspectReason: 'the defect line is no longer executed by the tests that failed on it, so the '
        + 'patch made the defective code unreachable rather than repairing it. The suite passes '
        + 'because the defect no longer runs.'
    };
  }

  if (result.coveredByEngine !== false) {
    return { suspectEquivalent: false, suspectReason: null };
  }
  if (result.restoresUpstreamExactly !== false) {
    // Out of range and restoring upstream: growth acquired a rule that expresses the class. Credited.
    return { suspectEquivalent: false, suspectReason: null };
  }

  const operator = String(result.operator || 'unknown');
  const family = result.family ? String(result.family) : 'an unrelated family';
  const deletion = DELETION_OPERATORS.has(operator);
  const suspectReason = `${operator} defect has no repair family, and the patch (${family}) `
    + `does not restore upstream, so it cannot have repaired the seeded defect`
    + (deletion ? '; a deleted statement is still deleted' : '')
    + '. The suite passes because the defect is no longer observable, not because it was fixed.';
  return { suspectEquivalent: true, suspectReason };
}

/**
 * Score a set two ways.
 *
 * `score` is preserved unchanged so the historical series stays comparable -- it is the number the
 * oracle produced, and rewriting it retroactively would break every prior result's meaning.
 * `repairScore` is the honest capability number: passes that survive classification.
 *
 * @param {Array<object>} results  scored instances (errored instances filtered out by the caller)
 */
function summarizeRepairs(results) {
  const scored = Array.isArray(results) ? results : [];
  const classified = scored.map(item => ({ ...item, ...classifyRepair(item) }));
  const repaired = classified.filter(item => item.repaired).length;
  const suspect = classified.filter(item => item.suspectEquivalent);
  return {
    classified,
    score: `${repaired}/${scored.length}`,
    repairScore: `${repaired - suspect.length}/${scored.length}`,
    suspectEquivalentRepairs: suspect.length,
    suspectEquivalentInstances: suspect.map(item => item.instance)
  };
}

module.exports = { classifyRepair, summarizeRepairs, DELETION_OPERATORS };
