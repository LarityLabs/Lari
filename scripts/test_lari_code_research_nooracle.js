/**
 * Tests for the oracle-free research loop wiring:
 * researched code for a goal with NO human oracle is verified by differential
 * agreement with independent local derivations and by property checks —
 * never by trusting the research, never by bluffing.
 *
 * Run: node scripts/test_lari_code_research_nooracle.js
 */
'use strict';

const agentic = require('../swarm_code_agentic.js');
const teach = require('../swarm_code_self_teach.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function freshModel() {
  return { lariCodeGeneration: { solutions: [], practiceLog: [], learningGoals: [] } };
}

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

function openGoal(model, taskId, description, language) {
  const cg = teach.ensureCodeGeneration(model);
  const goal = {
    taskId, description, language: language || 'python',
    concepts: [], status: 'open', queuedAt: new Date().toISOString()
    // NOTE: no expectedOutput — this is the oracle-less case that used to be skipped.
  };
  cg.learningGoals.push(goal);
  return goal;
}

// Research returns fib(20) implemented DIFFERENTLY from the built-in pattern
// (list-based vs the pattern's a,b swap) — genuinely independent derivation.
const RESEARCH_FIB20 = `
The first 20 Fibonacci numbers can be generated iteratively. Python program:

\`\`\`python
fibs = [0, 1]
for i in range(2, 20):
    fibs.append(fibs[-1] + fibs[-2])
for f in fibs:
    print(f)
\`\`\`
`;

const RESEARCH_SORT = `
To sort numbers ascending in Python, use the built-in sorted():

\`\`\`python
for x in sorted([5, 3, 8, 1]):
    print(x)
\`\`\`
`;

// Genuinely new concept: no pattern, no retained solution, no property.
const RESEARCH_TRIANGULAR7 = `
Triangular numbers are n*(n+1)/2. First 7:

\`\`\`python
for n in range(1, 8):
    print(n * (n + 1) // 2)
\`\`\`
`;

// Wrong code: starts 1,1 instead of 0,1 — must be REJECTED, not trusted.
const RESEARCH_FIB_WRONG = `
Fibonacci numbers:

\`\`\`python
a, b = 1, 1
for _ in range(10):
    print(a)
    a, b = b, a + b
\`\`\`
`;

console.log('== 1. Research closes an oracle-less goal via differential agreement ==');
{
  const model = freshModel();
  const goal = openGoal(model, 'goal-fib20', 'print the first 20 fibonacci numbers, one per line');
  const summary = agentic.workOpenCodingGoals(model, mockResearchApi(RESEARCH_FIB20));
  check('oracle-less goal was worked (not skipped)', summary.worked === 1,
    JSON.stringify(summary.details));
  check('goal closed', summary.closed === 1 && goal.status === 'complete',
    JSON.stringify({ status: goal.status, details: summary.details }));
  check('verified by differential tier (not oracle, not blind trust)',
    goal.verifiedBy === 'differential', goal.verifiedBy);
  check('agreement recorded across independent families',
    Array.isArray(goal.agreement) && goal.agreement.length >= 1, JSON.stringify(goal.agreement));
  const sol = teach.getRetainedSolutions(model).find(s => s.taskId === 'goal-fib20');
  check('solution retained with provenance', !!sol && sol.verifiedBy === 'differential');
  check('derived oracle stored', !!sol && typeof sol.derivedOracle === 'string' &&
    sol.derivedOracle.split('\n').length === 20, (sol && sol.derivedOracle || '').slice(0, 40));
  const expected20 = '0\n1\n1\n2\n3\n5\n8\n13\n21\n34\n55\n89\n144\n233\n377\n610\n987\n1597\n2584\n4181';
  check('derived oracle is actually correct', sol && sol.derivedOracle === expected20);
}

console.log('== 2. Properties tier: no local derivation, concept property confirms ==');
{
  const model = freshModel();
  // No sort pattern exists in the library — differential cannot fire.
  const goal = openGoal(model, 'goal-sort', 'sort the numbers 5, 3, 8, 1 ascending and print each on its own line');
  const summary = agentic.workOpenCodingGoals(model, mockResearchApi(RESEARCH_SORT));
  check('goal closed via properties tier', summary.closed === 1 && goal.verifiedBy === 'properties',
    JSON.stringify({ status: goal.status, verifiedBy: goal.verifiedBy, details: summary.details }));
  const sol = teach.getRetainedSolutions(model).find(s => s.taskId === 'goal-sort');
  check('solution retained', !!sol);
  check('output correct', sol && sol.derivedOracle === '1\n3\n5\n8');
}

console.log('== 3. Honest weak tier: genuinely new concept stays open ==');
{
  const model = freshModel();
  const goal = openGoal(model, 'goal-tri7', 'print the first 7 triangular numbers, one per line');
  const summary = agentic.workOpenCodingGoals(model, mockResearchApi(RESEARCH_TRIANGULAR7));
  check('goal worked but NOT closed', summary.worked === 1 && summary.closed === 0 && goal.status === 'open',
    JSON.stringify({ status: goal.status, details: summary.details }));
  check('no phantom solution retained',
    !teach.getRetainedSolutions(model).some(s => s.taskId === 'goal-tri7'));
  check('runnable code kept as unverified lead (not lost, not trusted)',
    typeof goal.unverifiedLead === 'string' && goal.unverifiedLead.includes('n * (n + 1)'));
  check('lead labeled honestly', /no independent derivation/i.test(goal.unverifiedLeadNote || ''));
}

console.log('== 4. Wrong researched code is rejected, not trusted ==');
{
  const model = freshModel();
  const goal = openGoal(model, 'goal-fibwrong', 'print the first 10 fibonacci numbers, one per line');
  const summary = agentic.workOpenCodingGoals(model, mockResearchApi(RESEARCH_FIB_WRONG));
  check('wrong code not accepted', summary.closed === 0 && goal.status === 'open',
    JSON.stringify({ status: goal.status, details: summary.details }));
  check('nothing retained for the wrong code',
    !teach.getRetainedSolutions(model).some(s => s.taskId === 'goal-fibwrong'));
}

console.log('== 5. verifyCodeNoOracle unit checks ==');
{
  const model = freshModel();
  const crashing = agentic.verifyCodeNoOracle(model,
    { id: 'u1', language: 'python', description: 'print hello' }, 'raise ValueError("boom")');
  check('crashing code rejected at generic tier', crashing.verified === false &&
    crashing.reason === 'generic_properties_failed');

  const hanging = agentic.verifyCodeNoOracle(model,
    { id: 'u2', language: 'python', description: 'print hello' }, 'while True:\n    pass',
    { timeoutMs: 2000 });
  check('hanging code rejected', hanging.verified === false);
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failures.length) { console.log('Failures:', failures.join(', ')); process.exit(1); }
