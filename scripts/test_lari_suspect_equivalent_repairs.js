#!/usr/bin/env node
'use strict';

/**
 * Regression test for the repair classifier.
 *
 * NOT a capability gate. It runs no search and no oracle; it can only say that a scored result is
 * sorted into the right category. It must never be quoted as a repair score.
 *
 * What it protects, in order of how expensive the mistake would be:
 *
 *   1. That the acquired-rule repairs stay credited. Eight out-of-range AOR instances repaired by
 *      grown `arithmetic-substitution` rules are this project's main finding. A classifier that
 *      flagged those would delete the transfer result, and it would do it quietly, because the
 *      flagged count would simply look larger and more rigorous.
 *   2. That branch-disabling stays flagged. The case that forced the classifier is
 *      `wcwidth-sdl-wcwidth_wcswidth_py-l306`, scored repaired in all three curriculum-leap
 *      conditions by a guard flip at a different line from the seeded defect.
 *   3. That legitimate equivalents stay credited -- an in-range patch differing from upstream is the
 *      engine being right in an unexpected way, not a weak oracle.
 *
 * The last block replays every recorded result file and asserts the invariant holds across the whole
 * history rather than only on hand-written fixtures. That part can genuinely fail: if the rule is ever
 * loosened, a restoring repair will start showing up flagged and this will say so.
 *
 * Usage: node scripts/test_lari_suspect_equivalent_repairs.js
 */

const fs = require('fs');
const path = require('path');
const { classifyRepair, summarizeRepairs } = require(path.join(__dirname, 'lari_repair_classification.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

console.log('repair classification');

// 1. The case that forced this: SDL defect, guard flip on another line, suite green.
const guardFlip = {
  instance: 'wcwidth-sdl-wcwidth_wcswidth_py-l306',
  operator: 'SDL',
  coveredByEngine: false,
  repaired: true,
  restoresUpstreamExactly: false,
  family: 'comparison-boundary'
};
const flipped = classifyRepair(guardFlip);
check('branch-disabling SDL patch is flagged', flipped.suspectEquivalent === true);
check('flag carries a reason', typeof flipped.suspectReason === 'string' && flipped.suspectReason.length > 40);
check('reason names the deletion', /deleted statement is still deleted/.test(flipped.suspectReason || ''));

// 2. The acquired-rule repair. Out of range because AOR has no seed family, restoring because the
//    grown rule expressed the class exactly. This is the transfer result and must stay credited.
const acquired = {
  instance: 'wcwidth-aor-wcwidth_align_py-l161',
  operator: 'AOR',
  coveredByEngine: false,
  repaired: true,
  restoresUpstreamExactly: true,
  family: 'arithmetic-substitution'
};
check('acquired-rule repair is credited', classifyRepair(acquired).suspectEquivalent === false);

// 3. Legitimate equivalent: in range, differs from upstream, still a real repair.
const equivalent = {
  instance: 'wcwidth-ror-wcwidth_textwrap_py-l520',
  operator: 'ROR',
  coveredByEngine: true,
  repaired: true,
  restoresUpstreamExactly: false,
  family: 'comparison-boundary'
};
check('in-range equivalent is credited', classifyRepair(equivalent).suspectEquivalent === false);

// 3b. Coverage evidence, which is the case the rule above structurally cannot reach: an IN-RANGE
//     defect neutralised by disabling the branch that contains it. Nothing after the fact
//     distinguishes that from a legitimate equivalent -- only coverage does.
const inRangeGuardFlip = {
  instance: 'synthetic-ror-in-range-guard-flip',
  operator: 'ROR',
  coveredByEngine: true,
  repaired: true,
  restoresUpstreamExactly: false,
  family: 'comparison-boundary',
  defectLineCoveredAfterPatch: false
};
check('in-range branch-disabling is flagged by coverage',
  classifyRepair(inRangeGuardFlip).suspectEquivalent === true);
check('and the reason cites the defect line no longer running',
  /no longer executed/.test(classifyRepair(inRangeGuardFlip).suspectReason || ''));

check('a repair whose defect line still runs is credited',
  classifyRepair({ ...inRangeGuardFlip, defectLineCoveredAfterPatch: true }).suspectEquivalent === false);

// Coverage that could not answer must never read as coverage answering "no".
check('unavailable coverage does not flag an in-range repair',
  classifyRepair({ ...inRangeGuardFlip, defectLineCoveredAfterPatch: null }).suspectEquivalent === false);
check('unavailable coverage still leaves the out-of-range rule working',
  classifyRepair({ ...guardFlip, defectLineCoveredAfterPatch: null }).suspectEquivalent === true);

// 4. Nothing that failed can be suspect.
check('unrepaired instance is not flagged', classifyRepair({
  operator: 'SDL', coveredByEngine: false, repaired: false, restoresUpstreamExactly: null
}).suspectEquivalent === false);

// 5. The classifier must never change what passed the oracle, only how it is counted.
const summary = summarizeRepairs([guardFlip, acquired, equivalent,
  { instance: 'x', operator: 'SDL', coveredByEngine: false, repaired: false, restoresUpstreamExactly: null }]);
check('score preserves the oracle result', summary.score === '3/4', summary.score);
check('repairScore excludes the suspect', summary.repairScore === '2/4', summary.repairScore);
check('suspect instance is named', summary.suspectEquivalentInstances.length === 1
  && summary.suspectEquivalentInstances[0] === 'wcwidth-sdl-wcwidth_wcswidth_py-l306');

// 6. Replay the recorded history. Asserts the invariant on real data, not fixtures.
const resultsDir = path.join(__dirname, '..', 'holdouts', 'results');
if (fs.existsSync(resultsDir)) {
  const instances = [];
  for (const file of fs.readdirSync(resultsDir).filter(name => name.endsWith('.txt'))) {
    const text = fs.readFileSync(path.join(resultsDir, file), 'utf8');
    for (let i = 0; i < text.length;) {
      const start = text.indexOf('{', i);
      if (start < 0) break;
      let object = null;
      // Scan for the shortest balanced object starting here; recorded blocks are pretty-printed.
      for (let end = start + 1; end <= text.length; end += 1) {
        const slice = text.slice(start, end);
        if (slice.split('{').length !== slice.split('}').length) continue;
        try { object = JSON.parse(slice); } catch (_) { continue; }
        i = end;
        break;
      }
      if (object === null) { i = start + 1; continue; }
      if (object && typeof object === 'object' && 'instance' in object && 'repaired' in object) {
        instances.push({ file, ...object });
      }
    }
  }

  const flaggedHistory = instances.map(item => ({ ...item, ...classifyRepair(item) }))
    .filter(item => item.suspectEquivalent);
  const restoringFlagged = flaggedHistory.filter(item => item.restoresUpstreamExactly === true);
  const distinct = [...new Set(flaggedHistory.map(item => item.instance))];

  console.log(`  ..   replayed ${instances.length} recorded instances from ${resultsDir.replace(/\\/g, '/')}`);
  check('no repair that restores upstream is ever flagged', restoringFlagged.length === 0,
    restoringFlagged.map(item => `${item.file}:${item.instance}`).join(', '));
  check('every flagged repair is out of range', flaggedHistory.every(item => item.coveredByEngine === false));
  check('flagged history is the two known SDL instances', distinct.length <= 2
    && distinct.every(id => /-sdl-/.test(id)), distinct.join(', '));
} else {
  console.log('  ..   skipped history replay: holdouts/results not present');
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
