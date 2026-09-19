#!/usr/bin/env node
'use strict';

/**
 * Tests the CLOSED research loop:
 *   unknown task → fails → research goal → closeResearchLoop →
 *   research yields code → verified → retained as solution + learned pattern →
 *   retry passes, and a sibling task generalizes.
 *
 * Also tests the honest path: research with no usable code leaves the goal open.
 */

const agentic = require('../swarm_code_agentic.js');
const teach = require('../swarm_code_self_teach.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

const TRIANGULAR_8 = '1\n3\n6\n10\n15\n21\n28\n36';
const TRIANGULAR_5 = '1\n3\n6\n10\n15';

const triangularTask = {
  id: 'py-triangular-8',
  language: 'python',
  description: 'print the first 8 triangular numbers, one per line',
  tags: ['math', 'sequence'],
  verify: { type: 'stdout', expected: TRIANGULAR_8 }
};

// Mock research API: simulates what the runtime's knowledge-acquisition loop
// returns after studying the concept (sources pluggable in production).
function mockResearchApi(distilledText) {
  return {
    runAutonomousKnowledgeAcquisition(model, query, options) {
      return {
        id: 'knowledgeAcquisition.mock',
        timestamp: new Date().toISOString(),
        query,
        action: 'learned_from_research',
        distilled: { summary: distilledText, text: distilledText, topic: query, sourceCount: 1 },
        learned: null
      };
    }
  };
}

const RESEARCH_WITH_CODE = `
Triangular numbers are the sums 1, 1+2, 1+2+3, ... The nth triangular number
is n*(n+1)/2. Here is a Python program printing the first 8:

\`\`\`python
for i in range(1, 9):
    print(i * (i + 1) // 2)
\`\`\`

This runs in O(n) time.
`;

console.log('=== closed loop: unknown concept learned from research ===');
const model = { lariCodeGeneration: { solutions: [], learningGoals: [] } };
teach.runCodingSelfTeachCycle(model); // master the seeds first

// 1. The task fails: no pattern knows "triangular".
const first = teach.selfTeachCodingTask(model, triangularTask);
check('unknown task fails honestly', first.passed === false, JSON.stringify(first.verification));

// 2. Failure becomes a research goal.
const stuck = agentic.researchWhenStuck(model, triangularTask, first.verification || { reason: 'no_candidates' }, null);
check('research goal queued', stuck.goal && stuck.goal.taskId === 'py-triangular-8');

// 3. Close the loop with research that yields working code.
const closed = agentic.closeResearchLoop(model, triangularTask,
  mockResearchApi(RESEARCH_WITH_CODE), {});
check('loop closed', closed.closed === true, JSON.stringify(closed.attempts.slice(-3)));
check('closed via research', /research/.test(closed.strategy || ''), closed.strategy);
check('goal marked complete',
  model.lariCodeGeneration.learningGoals.find(g => g.taskId === 'py-triangular-8').status === 'complete');
check('solution retained',
  teach.getRetainedSolutions(model).some(s => s.taskId === 'py-triangular-8'));
check('learned pattern stored',
  teach.getLearnedPatterns(model).some(p => p.id === 'learned-py-triangular-8'));
check('pattern generalized to template',
  teach.getLearnedPatterns(model).some(p => p.template && /__LARI_N\d+__/.test(p.template)));

// 4. Retry now passes — from the retained solution.
const retry = teach.selfTeachCodingTask(model, triangularTask);
check('retry passes', retry.passed === true, JSON.stringify(retry.verification));

// 5. Sibling task generalizes: "first 5" instantiates the template.
const sibling = {
  id: 'py-triangular-5',
  language: 'python',
  description: 'print the first 5 triangular numbers, one per line',
  tags: ['math', 'sequence'],
  verify: { type: 'stdout', expected: TRIANGULAR_5 }
};
const candidates = teach.generateCandidates(model, sibling);
const learnedCandidates = candidates.filter(c => c.source.startsWith('learned:'));
check('learned pattern matches sibling', learnedCandidates.length > 0,
  `candidates: ${candidates.map(c => c.source).join(',')}`);
let siblingPassed = false;
for (const c of learnedCandidates) {
  const run = teach.runCodeSandbox('python', c.code, { timeoutMs: 10000 });
  const v = teach.verifyAttempt(sibling, run);
  if (v.passed) { siblingPassed = true; break; }
}
check('sibling task verifies from learned pattern', siblingPassed);

console.log('=== honest path: research with no usable code ===');
const model2 = { lariCodeGeneration: { solutions: [], learningGoals: [] } };
teach.runCodingSelfTeachCycle(model2);
const task2 = {
  id: 'py-hypergraph-9',
  language: 'python',
  description: 'print the first 9 hypergraph zeta values, one per line',
  tags: ['math'],
  verify: { type: 'stdout', expected: 'nope' }
};
teach.selfTeachCodingTask(model2, task2);
agentic.researchWhenStuck(model2, task2, { reason: 'no_candidates' }, null);
const open = agentic.closeResearchLoop(model2, task2,
  mockResearchApi('Hypergraph zeta values are a fictional concept. No code exists.'), {});
check('loop stays honestly open', open.closed === false);
check('goal still open',
  model2.lariCodeGeneration.learningGoals.find(g => g.taskId === 'py-hypergraph-9').status === 'open');
check('no phantom solution retained',
  !teach.getRetainedSolutions(model2).some(s => s.taskId === 'py-hypergraph-9'));
check('no phantom pattern learned',
  !teach.getLearnedPatterns(model2).some(p => p.id === 'learned-py-hypergraph-9'));

console.log('=== workOpenCodingGoals batch driver ===');
const model3 = { lariCodeGeneration: { solutions: [], learningGoals: [] } };
teach.runCodingSelfTeachCycle(model3);
teach.selfTeachCodingTask(model3, triangularTask); // fails, records goal with oracle
const openBefore = model3.lariCodeGeneration.learningGoals.filter(g => g.status === 'open');
check('goal recorded with oracle', openBefore.length > 0 && !!openBefore[0].expectedOutput,
  JSON.stringify(openBefore.map(g => ({ id: g.taskId, hasOracle: !!g.expectedOutput }))));
const batch = agentic.workOpenCodingGoals(model3, mockResearchApi(RESEARCH_WITH_CODE), { maxGoals: 2 });
check('batch closed the goal', batch.closed === 1, JSON.stringify(batch.details));
check('retry passes after batch', teach.selfTeachCodingTask(model3, triangularTask).passed === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
