'use strict';

const assert = require('assert');
const { projectLearningLifecycle } = require('./lari_learning_lifecycle.js');

const cases = [
  [{}, 'observed'],
  [{ autonomousLearning: { queued: true, status: 'candidate_learning_queued', risk: 'low' } }, 'queued'],
  [{ autonomousLearning: { researching: true, status: 'researching' } }, 'researching'],
  [{ autonomousPractice: { queued: true, status: 'practicing' } }, 'practicing'],
  [{ autonomousLearning: { verified: true } }, 'verified'],
  [{ autonomousLearning: { promoted: true, rollbackPath: 'verified-backup.json' } }, 'promoted'],
  [{ autonomousLearning: { status: 'quarantined', risk: 'high' } }, 'quarantined']
];

for (const [input, expected] of cases) {
  assert.strictEqual(projectLearningLifecycle(input).stage, expected);
}
assert.strictEqual(projectLearningLifecycle(cases[5][0]).rollbackAvailable, true);
assert.strictEqual(projectLearningLifecycle(cases[6][0]).quarantined, true);

process.stdout.write(`${JSON.stringify({ passed: true, stages: cases.map(([, stage]) => stage), persistenceLayerAdded: false })}\n`);
