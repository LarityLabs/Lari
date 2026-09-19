/**
 * Tests for "go learn X": autonomous topic learning.
 * Lari researches a curriculum, verifies doc examples, cross-checks new
 * implementations on fresh inputs, and retains everything with provenance.
 * No human writes exercises or answer keys.
 *
 * Run: node scripts/test_lari_code_learn.js
 */
'use strict';

const learn = require('../swarm_code_learn.js');
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

const TOC_TEXT = `Python tutorial table of contents:
1. Lists - creating and using lists
2. Loops - for and while loops`;

const LISTS_TEXT = `Python lists hold ordered items. To sort one:

>>> sorted([3, 1, 2])
[1, 2, 3]

A bubble sort implementation:

\`\`\`python
def bubble_sort(data):
    data = list(data)
    for i in range(len(data)):
        for j in range(i + 1, len(data)):
            if data[j] < data[i]:
                data[i], data[j] = data[j], data[i]
    return data
\`\`\`
`;

const LOOPS_TEXT = `Python loops repeat actions:

>>> [x * 2 for x in range(3)]
[0, 2, 4]

>>> total = 0
>>> for i in range(4):
...     total += i
>>> total
6
`;

function mockLearnApi() {
  return {
    runAutonomousKnowledgeAcquisition(model, query, options) {
      let text = '';
      if (/table of contents/i.test(query)) text = TOC_TEXT;
      else if (/lists/i.test(query)) text = LISTS_TEXT;
      else if (/loops/i.test(query)) text = LOOPS_TEXT;
      return {
        id: 'knowledgeAcquisition.mock',
        timestamp: new Date().toISOString(),
        query,
        action: 'learned_from_research',
        distilled: { summary: text.slice(0, 160), text, topic: query, sourceCount: 1 },
        learned: null
      };
    }
  };
}

console.log('== parseTopicList ==');
{
  const topics = learn.parseTopicList(TOC_TEXT);
  check('numbered list parsed', topics.length === 2 && topics[0] === 'Lists' && topics[1] === 'Loops',
    JSON.stringify(topics));
  check('bullets parsed', JSON.stringify(learn.parseTopicList('- Variables\n* Functions')) === '["Variables","Functions"]');
}

console.log('== extractDocExamples ==');
{
  const exs = learn.extractDocExamples(LOOPS_TEXT, 'python');
  check('doctest examples extracted', exs.length === 2, JSON.stringify(exs.map(e => e.code)));
  check('continuation lines joined', exs.some(e => e.code.includes('total += i')));
  const listsExs = learn.extractDocExamples(LISTS_TEXT, 'python');
  check('REPL echo wrapped in print()', listsExs.length === 1 && listsExs[0].code.startsWith('print('),
    listsExs[0] && listsExs[0].code);
}

console.log('== learnTopic end to end: go learn Python ==');
{
  const model = freshModel();
  const r = learn.learnTopic(model, 'python', mockLearnApi(), { maxTopics: 5, maxExamplesPerTopic: 5 });
  check('curriculum came from research', r.curriculumSource === 'research', r.curriculumSource);
  check('2 topics planned', r.topicsPlanned === 2, String(r.topicsPlanned));
  check('both topics completed', r.topicsCompleted === 2, JSON.stringify(r.topics));

  const cg = teach.ensureCodeGeneration(model);
  check('doc examples verified and retained', cg.workedExamples.length === 3,
    JSON.stringify(cg.workedExamples.map(e => e.code.slice(0, 40))));
  check('examples marked doc-example', cg.workedExamples.every(e => e.verifiedBy === 'doc-example'));

  const bubble = cg.learnedImplementations.find(i => i.code.includes('bubble_sort'));
  check('bubble_sort learned via cross-check', !!bubble && bubble.verifiedBy === 'cross-check',
    bubble && bubble.verifiedBy);
  check('cross-check evidence recorded', !!bubble && bubble.evidence && bubble.evidence.agreements === bubble.evidence.attempts &&
    bubble.evidence.attempts > 0, JSON.stringify(bubble && bubble.evidence));

  const goals = cg.learningGoals.filter(g => g.kind === 'learn-topic');
  check('topic goals complete', goals.length === 2 && goals.every(g => g.status === 'complete'));
  check('topic notes retained (the when/where)', goals.every(g => typeof g.notes === 'string' && g.notes.length > 0));
}

console.log('== resumability: second run does no duplicate work ==');
{
  const model = freshModel();
  const api = mockLearnApi();
  learn.learnTopic(model, 'python', api, { maxTopics: 5 });
  const before = teach.ensureCodeGeneration(model).learningGoals.length;
  const r2 = learn.learnTopic(model, 'python', api, { maxTopics: 5 });
  const after = teach.ensureCodeGeneration(model).learningGoals.length;
  check('no duplicate goals', before === after, `${before} vs ${after}`);
  check('completed topics skipped', r2.topics.length === 0 && r2.topicsCompleted === 0,
    JSON.stringify(r2.topics));
  check('curriculum source is existing', r2.curriculumSource === 'existing');
}

console.log('== cross-check rejects a wrong implementation ==');
{
  const model = freshModel();
  const wrongImpl = 'def reverse_sort(data):\n    return sorted(data, reverse=True)\n';
  const cc = learn.crossCheckImplementation('print(sorted([3, 1, 2]))', wrongImpl, 'python');
  check('wrong implementation fails cross-check', cc.checked === true && cc.passed === false,
    JSON.stringify(cc));
}

console.log('== doctestToScript ==');
{
  check('bare expression wrapped', learn.doctestToScript('sorted([3, 1, 2])') === 'print(sorted([3, 1, 2]))');
  check('print() left alone', learn.doctestToScript('print(42)') === 'print(42)');
  check('assignment left alone', learn.doctestToScript('x = 5') === 'x = 5');
}

console.log('== chat trigger regex ==');
{
  const re = /^(?:go\s+)?learn\s+(python|javascript|js|golang|go)\b/i;
  check('"go learn go" triggers go', (re.exec('go learn go') || [])[1] === 'go');
  check('"learn golang" triggers golang', (re.exec('learn golang') || [])[1] === 'golang');
  check('"go learn python" still python', (re.exec('go learn python') || [])[1] === 'python');
  check('"learn javascript" works', (re.exec('learn javascript') || [])[1] === 'javascript');
}

const GO_TOC_TEXT = `Go tutorial table of contents:
1. Slices - flexible views into arrays
2. Goroutines - lightweight concurrency`;

const GO_SLICES_TEXT = `Go slices are flexible views into arrays. Sort one:

\`\`\`go
package main

import (
\t"fmt"
\t"sort"
)

func main() {
\tnums := []int{3, 1, 2}
\tsort.Ints(nums)
\tfmt.Println(nums)
}
// Output: [1 2 3]
\`\`\`

Bubble sort from scratch:

\`\`\`go
package main

import "fmt"

func bubbleSort(data []int) []int {
\tnums := make([]int, len(data))
\tcopy(nums, data)
\tfor i := 0; i < len(nums); i++ {
\t\tfor j := i + 1; j < len(nums); j++ {
\t\t\tif nums[j] < nums[i] {
\t\t\t\tnums[i], nums[j] = nums[j], nums[i]
\t\t\t}
\t\t}
\t}
\treturn nums
}

func main() {
\tfmt.Println(bubbleSort([]int{5, 3, 8, 1}))
}
// Output: [1 3 5 8]
\`\`\`
`;

const GO_ROUTINES_TEXT = `Goroutines run functions concurrently:

\`\`\`go
package main

import (
\t"fmt"
\t"sync"
)

func main() {
\tvar wg sync.WaitGroup
\tresults := make([]int, 3)
\tfor i := 0; i < 3; i++ {
\t\twg.Add(1)
\t\tgo func(n int) {
\t\t\tdefer wg.Done()
\t\t\tresults[n] = n * 2
\t\t}(i)
\t}
\twg.Wait()
\tfmt.Println(results)
}
// Output: [0 2 4]
\`\`\`
`;

function mockGoApi() {
  return {
    runAutonomousKnowledgeAcquisition(model, query, options) {
      let text = '';
      if (/table of contents/i.test(query)) text = GO_TOC_TEXT;
      else if (/slices/i.test(query)) text = GO_SLICES_TEXT;
      else if (/goroutines/i.test(query)) text = GO_ROUTINES_TEXT;
      return {
        id: 'knowledgeAcquisition.mock',
        timestamp: new Date().toISOString(),
        query,
        action: 'learned_from_research',
        distilled: { summary: text.slice(0, 160), text, topic: query, sourceCount: 1 },
        learned: null
      };
    }
  };
}

console.log('== learnTopic end to end: go learn Go ==');
{
  const model = freshModel();
  const r = learn.learnTopic(model, 'go learn go', mockGoApi(), {
    maxTopics: 5, maxExamplesPerTopic: 5, timeoutMs: 30000
  });
  check('language detected as go', r.language === 'go', r.language);
  check('go curriculum from research', r.curriculumSource === 'research', r.curriculumSource);
  check('2 go topics planned', r.topicsPlanned === 2, String(r.topicsPlanned));
  check('go topics completed', r.topicsCompleted === 2, JSON.stringify(r.topics));

  const cg = teach.ensureCodeGeneration(model);
  const goExamples = cg.workedExamples.filter(e => e.language === 'go');
  check('go doc examples verified (// Output: comments)', goExamples.length >= 2,
    JSON.stringify(goExamples.map(e => e.expectedOutput)));
  const bubble = cg.learnedImplementations.find(i => i.code.includes('bubbleSort'));
  check('go bubbleSort learned via substitution cross-check',
    !!bubble && bubble.verifiedBy === 'cross-check' && bubble.evidence.strategy === 'substitution',
    JSON.stringify(bubble && { v: bubble.verifiedBy, e: bubble.evidence }));
}

console.log('== cross-check rejects a wrong Go implementation ==');
{
  const ex = 'package main\nimport "fmt"\nfunc main() {\n\tnums := []int{3, 1, 2}\n\tfmt.Println(nums)\n}\n';
  const wrong = 'package main\nimport "fmt"\nfunc rev(a []int) []int {\n\tn := len(a)\n\tout := make([]int, n)\n\tfor i, v := range a {\n\t\tout[n-1-i] = v\n\t}\n\treturn out\n}\nfunc main() {\n\tfmt.Println(rev([]int{3, 1, 2}))\n}\n';
  const cc = learn.crossCheckImplementation(ex, wrong, 'go', { timeoutMs: 30000 });
  check('wrong go implementation fails cross-check', cc.checked === true && cc.passed === false,
    JSON.stringify(cc));
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failures.length) { console.log('Failures:', failures.join(', ')); process.exit(1); }
