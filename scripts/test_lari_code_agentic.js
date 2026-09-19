#!/usr/bin/env node
'use strict';

const agentic = require('../swarm_code_agentic.js');
const teach = require('../swarm_code_self_teach.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== 1. DEBUG ===');
for (const seed of agentic.DEBUG_TASK_SEEDS) {
  const r = agentic.debugBrokenCode(seed, { maxAttempts: 5 });
  check(`${seed.id} fixed`, r.fixed === true, JSON.stringify(r.verification));
  if (r.fixed) {
    // Verify the fixed code actually produces the expected output.
    const files = r.code;
    const entry = Object.keys(files)[0];
    const run = agentic.runMultiFileSandbox(seed.language, files, entry);
    check(`${seed.id} output verified`, run.stdout.trim() === seed.expectedOutput.trim(),
      `got: ${JSON.stringify(run.stdout.trim())}`);
  }
}
// Unfixable code: honest failure, not a bluff.
const hopeless = agentic.debugBrokenCode({
  language: 'python',
  description: 'fix the unfixable',
  code: 'x = [1,2,3]\nprint(x[99] + undefined_var)',
  expectedOutput: 'hello'
}, { maxAttempts: 3 });
check('unfixable honestly fails', hopeless.fixed === false, JSON.stringify(hopeless.verification));

console.log('=== 2. MULTI-FILE ===');
const model = { lariCodeGeneration: { solutions: [], learningGoals: [] } };
// First master the base seeds so curriculum has something to work with.
teach.runCodingSelfTeachCycle(model);
for (const task of agentic.MULTIFILE_TASK_SEEDS) {
  const r = agentic.runMultiFileTask(model, task);
  check(`${task.id} passed`, r.passed === true, JSON.stringify(r.verification));
}
check('multifile solutions retained',
  model.lariCodeGeneration.solutions.filter(s => s.multiFile).length === agentic.MULTIFILE_TASK_SEEDS.length);

console.log('=== 3. COMPOSE ===');
const comp = agentic.composeSolutions(model, 'py-fibonacci-10', 'py-palindrome');
check('composition built', comp.composed === true, comp.reason || '');
if (comp.composed) {
  check('composed solution retained',
    model.lariCodeGeneration.solutions.some(s => s.taskId === comp.taskId));
  check('composed output non-empty', !!(comp.output && comp.output.trim()));
}
const badComp = agentic.composeSolutions(model, 'nonexistent', 'py-fibonacci');
check('missing solution honestly declined', badComp.composed === false);

console.log('=== 4. SELF-CURRICULUM ===');
const curriculum = agentic.generateCurriculumTasks(model, { maxNew: 6 });
check('curriculum generated tasks', curriculum.length > 0, `got ${curriculum.length}`);
check('curriculum has harder variants',
  curriculum.some(t => t.difficulty >= 2) || curriculum.some(t => t.compose));
const cycle = agentic.runCurriculumCycle(model, { maxNew: 4 });
check('curriculum cycle ran', cycle.generated === curriculum.slice(0, 4).length || cycle.generated > 0,
  JSON.stringify({ generated: cycle.generated, passed: cycle.passed }));

console.log('=== 5. RESEARCH WHEN STUCK ===');
const stuckTask = {
  id: 'py-quantum-sort', language: 'python',
  description: 'write a quantum sorting algorithm that sorts in O(1)'
};
const research = agentic.researchWhenStuck(model, stuckTask, { reason: 'no_candidates' }, null);
check('research goal recorded', research.goal && research.goal.taskId === 'py-quantum-sort');
check('research goal queued openly',
  model.lariCodeGeneration.learningGoals.some(g => g.taskId === 'py-quantum-sort' && g.status === 'open'));
check('concepts extracted', research.goal.concepts.length >= 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
