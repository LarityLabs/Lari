#!/usr/bin/env node
'use strict';

/**
 * What can Lari actually do? Generated from measurements, never from recollection.
 *
 * This exists because the hand-written standing table in `LARI_WORKING_CONTEXT.md` was wrong in both directions
 * within two days -- it understated capability ("computer management: largely simulated") badly enough
 * that a session told the owner Lari could not use tools, and the correction that followed overstated
 * it ("253 benchmarks invoke Lari") badly enough to imply the product worked when 17 of 303 went
 * through the front door.
 *
 * The distinction that matters, and that prose kept losing:
 *
 *   REACHABLE   a benchmark asks Lari and it works. This is the product.
 *   BUILT       a benchmark calls the function and it works. This is the codebase.
 *   BROKEN      a benchmark runs and reports failure.
 *   UNKNOWN     never measured, or measured only by a timeout.
 *
 * A BUILT capability is not a product capability. They are never summed.
 *
 * Usage: node scripts/report_lari_capability_standing.js [--json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (e) { return null; } };

const survey = read('holdouts/PHASE0_SURVEY.json');
const wiring = read('holdouts/CAPABILITY_WIRING.json');

if (!survey) {
  console.error('No Phase 0 survey. Run: npm run lari:phase0');
  process.exit(1);
}

const results = Object.entries(survey.results || {});
const isFrontDoor = r => r.entryPoint === 'asks-lari' || r.entryPoint === 'unified-kernel';

const frontDoor = results.filter(([, r]) => isFrontDoor(r));
const internals = results.filter(([, r]) => !isFrontDoor(r) && r.entryPoint !== 'no-runtime');

const bucket = (list, outcome) => list.filter(([, r]) => r.outcome === outcome);

const standing = {
  measuredAt: survey.startedAt ? survey.startedAt.slice(0, 10) : 'unknown',
  reachableByAsking: {
    passing: bucket(frontDoor, 'pass').length,
    failing: bucket(frontDoor, 'fail').length,
    unknownTimeout: bucket(frontDoor, 'timeout').length,
    total: frontDoor.length,
    meaning: 'A benchmark asked Lari and it worked. THIS IS THE PRODUCT.'
  },
  builtButNotReachable: {
    passing: bucket(internals, 'pass').length,
    failing: bucket(internals, 'fail').length,
    unknownTimeout: bucket(internals, 'timeout').length,
    total: internals.length,
    meaning: 'A benchmark called the function directly and it worked. This is the CODEBASE, not the '
      + 'product. Never added to the number above.'
  },
  wiringWorklist: wiring ? {
    distinctCapabilities: wiring.exercisedByInternalsBenchmarks,
    reachableFromChat: wiring.reachableFromChat,
    notReachable: wiring.notReachableFromChat,
    caveat: wiring.caveat
  } : null,
  verifiedThisSession: [
    'Transfer: seed vocabulary 0/13 eligible instances, self-grown vocabulary 9/13, on a repository '
      + 'never seen before, with learning disabled. All 9 credited to rules Lari invented; all 9 '
      + 'restore upstream exactly. Sealed prediction, matched instance sets.',
    'Primitive promotion: 73 rules to one primitive, 526 to 221 symbols, nothing verified lost, '
      + '435 untried pairings proposed including the * -> // the transfer run proved was missing.',
    'Claims from execution: Lari states what code did because it ran it, twice, and refuses when the '
      + 'two runs disagree.',
    'Preference firewall: 500 downvotes on declining does not make an unsupported question answerable.'
  ],
  knownNotWorking: [
    'coordinated_multifile: ordinaryDiscoveryPassed false and verified false -- the multi-file repair '
      + 'itself does not work. Real missing capability, not missing plumbing.',
    'linux_operator_ablation: fails without emitting gate output; undiagnosed.',
    'runLariChatCompletion: reachable in principle, but wiring it regressed grounded_factual. The two '
      + 'chat lanes disagree about when to answer. See holdouts/CHAT_LANE_WIRING.md.',
    'time-travel curriculum: six real bugs mined and sealed, blocked on an allowlist rejecting the '
      + 'repair_failure record type. No score exists. See holdouts/time-travel-humanize/STATUS.md.'
  ],
  honestSummary: null
};

const r = standing.reachableByAsking;
const b = standing.builtButNotReachable;
standing.honestSummary =
  `Of ${r.total} benchmarks that ask Lari, ${r.passing} pass. Of ${b.total} that call functions `
  + `directly, ${b.passing} pass. The first number is the product; the second is the codebase. The gap `
  + `between them${wiring ? ` -- ${wiring.notReachableFromChat} capabilities with no route from chat --` : ''}`
  + ' is the work.';

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(standing, null, 2));
  process.exit(0);
}

console.log('# What Lari can and cannot do\n');
console.log(`Measured ${standing.measuredAt}. Generated from the Phase 0 survey and wiring audit.\n`);
console.log('## Reachable by asking Lari  (THE PRODUCT)');
console.log(`   pass ${r.passing}   fail ${r.failing}   unknown ${r.unknownTimeout}   of ${r.total}\n`);
console.log('## Built, but not reachable by asking  (THE CODEBASE)');
console.log(`   pass ${b.passing}   fail ${b.failing}   unknown ${b.unknownTimeout}   of ${b.total}`);
console.log('   These are NOT product capabilities and are never added to the number above.\n');
if (standing.wiringWorklist) {
  const w = standing.wiringWorklist;
  console.log('## The gap');
  console.log(`   ${w.distinctCapabilities} distinct capabilities, ${w.reachableFromChat} reachable, `
    + `${w.notReachable} not.\n`);
}
console.log('## Verified working this session');
for (const line of standing.verifiedThisSession) console.log(`   - ${line}`);
console.log('\n## Known NOT working');
for (const line of standing.knownNotWorking) console.log(`   - ${line}`);
console.log(`\n${standing.honestSummary}`);
