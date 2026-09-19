#!/usr/bin/env node
'use strict';

/**
 * Oracle for the failure-to-curiosity bridge.
 *
 * NOT a capability gate: synthetic failure records, checked properties.
 *
 * What it protects is the honesty of the loop rather than its cleverness. Lari raising its own
 * learning goals from its own failures is the point; a goal closing because something was *read*
 * rather than *verified* would be the vacuum-filling that put gold answers in model state once
 * before. So the assertions that matter most here are the ones about closing.
 */

const path = require('path');
const gaps = require(path.join(__dirname, '..', 'swarm_repair_gap_curiosity.js'));
const runtime = require(path.join(__dirname, '..', 'swarm_model_runtime.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

function modelWithFailures() {
  return { lariLearnedRecords: { schemaVersion: 1, records: [
    { type: 'repair_failure', status: 'open', id: 'f1', payload: { target: 'a/x.py', failureClass: 'AssertionError: assert N == N', familyCounts: { 'comparison-boundary': 412, 'numeric-constant': 228 }, occurrences: 3 } },
    { type: 'repair_failure', status: 'open', id: 'f2', payload: { target: 'a/y.py', failureClass: 'AssertionError: assert N == N', familyCounts: { 'numeric-constant': 310 }, occurrences: 2 } },
    { type: 'repair_failure', status: 'open', id: 'f3', payload: { target: 'b/z.py', failureClass: 'TypeError: unsupported operand', familyCounts: { 'arithmetic-substitution': 64 }, occurrences: 1 } }
  ] } };
}

console.log('repair gap curiosity');

const model = modelWithFailures();
const summary = gaps.summarizeRepairGaps(model);
check('it groups failures into gaps', summary.length === 2, JSON.stringify(summary.map(g => g.failureClass)));
check('a class recurring across files ranks first',
  summary[0].occurrences === 5 && summary[0].distinctTargets === 2, JSON.stringify(summary[0]));
check('it records that the vocabulary was exhausted',
  summary[0].familiesExhausted === 2 && summary[0].vocabularyLooksInsufficient === true);

const planned = gaps.planRepairGapCuriosity(model, { runtime, minOccurrences: 2 });
check('it raises a learning goal from its own failures', planned.raised.length === 1, JSON.stringify(planned.raised.length));
check('recurrence drives priority', planned.raised[0].goal.priority > 0.5, String(planned.raised[0].goal.priority));
check('the goal is about a technique, not a file',
  !/\.py/.test(planned.raised[0].goal.topic), planned.raised[0].goal.topic);
check('a one-off failure does not become a goal',
  !planned.raised.some(entry => /TypeError/.test(entry.goal.topic)));
check('the goal lands in the curiosity queue the research lane reads',
  (model.curiosity?.queue || []).some(goal => goal.kind === 'repair_gap'));

// Raising twice must not duplicate: a standing gap is one goal, however often it recurs.
const again = gaps.planRepairGapCuriosity(model, { runtime, minOccurrences: 2 });
check('the same gap is not queued twice', again.raised.length === 0);

// The assertions that matter: only a verified repair closes anything.
const closed = gaps.closeRepairGapsOnVerifiedRepair(model, { failureClass: 'AssertionError: assert N == N', family: 'numeric-constant' });
check('a verified repair closes the failures it explains', closed.length === 2, JSON.stringify(closed));
check('and closes the goal that was raised for them',
  (model.curiosity.queue.find(goal => goal.kind === 'repair_gap') || {}).status === 'closed_by_verified_repair');
check('closure records that tests, not reading, did it',
  model.lariLearnedRecords.records.find(r => r.id === 'f1').payload.closedBy.verification === 'executable_tests');
check('unrelated failures stay open', gaps.openRepairFailures(model).length === 1);

const untouched = modelWithFailures();
check('nothing closes without a verified repair',
  gaps.closeRepairGapsOnVerifiedRepair(untouched, {}).length === 0
  && gaps.openRepairFailures(untouched).length === 3);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
