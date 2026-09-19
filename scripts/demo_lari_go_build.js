/**
 * Demo: "go learn Go, then build something challenging."
 *
 * Phase 1 — learn: learnTopic('go') with tutorial research.
 * Phase 2 — build: a concurrent TCP port scanner (goroutines, channels,
 *   WaitGroup). Research returns two candidates; each faces an acceptance
 *   test: a live listener on 127.0.0.1:18123 must be found, and a 50-port
 *   sweep must finish fast enough to prove real concurrency.
 *   Pass -> retained as the built project. Fail -> rejected, nothing kept.
 *
 * Run: node scripts/demo_lari_go_build.js
 */
'use strict';

const net = require('net');
const learn = require('../swarm_code_learn.js');
const teach = require('../swarm_code_self_teach.js');
const agentic = require('../swarm_code_agentic.js');

function freshModel() {
  return { lariCodeGeneration: { solutions: [], practiceLog: [], learningGoals: [] } };
}

// --- Mock research: Go tutorial ------------------------------------------------
const GO_TOC = `Go tutorial table of contents:
1. Slices - flexible views into arrays
2. Goroutines - lightweight concurrency`;

const GO_SLICES = `Sort a slice:

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
`;

const GO_ROUTINES = `Goroutines run concurrently:

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

function mockLearnApi() {
  return {
    runAutonomousKnowledgeAcquisition(model, query) {
      let text = '';
      if (/table of contents/i.test(query)) text = GO_TOC;
      else if (/slices/i.test(query)) text = GO_SLICES;
      else if (/goroutines/i.test(query)) text = GO_ROUTINES;
      return {
        id: 'knowledgeAcquisition.mock', timestamp: new Date().toISOString(), query,
        action: 'learned_from_research',
        distilled: { summary: text.slice(0, 160), text, topic: query, sourceCount: 1 },
        learned: null
      };
    }
  };
}

// --- Mock research: port scanner candidates ------------------------------------
const BUGGY_SCANNER = `A concurrent port scanner (has a bug — see if you can spot it):

\`\`\`go
package main

import (
\t"fmt"
\t"net"
\t"os"
\t"strconv"
\t"sync"
\t"time"
)

func scanPort(host string, port int, timeout time.Duration) bool {
\tconn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), timeout)
\tif err != nil {
\t\treturn false
\t}
\tconn.Close()
\treturn true
}

func main() {
\thost := os.Args[1]
\tstart, _ := strconv.Atoi(os.Args[2])
\tend, _ := strconv.Atoi(os.Args[3])
\tjobs := make(chan int)
\tresults := make(chan int)
\tvar wg sync.WaitGroup
\tfor w := 0; w < 10; w++ {
\t\twg.Add(1)
\t\tgo func() {
\t\t\tdefer wg.Done()
\t\t\tfor port := range jobs {
\t\t\t\tif scanPort(host, port, 100*time.Millisecond) {
\t\t\t\t\tresults <- port
\t\t\t\t}
\t\t\t}
\t\t}()
\t}
\tgo func() {
\t\tfor p := start; p <= end; p++ {
\t\t\tjobs <- p
\t\t}
\t\tclose(jobs)
\t}()
\tfor port := range results {
\t\tfmt.Printf("open: %d\\n", port)
\t}
}
\`\`\`
`;

const GOOD_SCANNER = `Fixed version — the results channel gets closed after workers finish:

\`\`\`go
package main

import (
\t"fmt"
\t"net"
\t"os"
\t"strconv"
\t"sync"
\t"time"
)

func scanPort(host string, port int, timeout time.Duration) bool {
\tconn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), timeout)
\tif err != nil {
\t\treturn false
\t}
\tconn.Close()
\treturn true
}

func main() {
\thost := os.Args[1]
\tstart, _ := strconv.Atoi(os.Args[2])
\tend, _ := strconv.Atoi(os.Args[3])
\tjobs := make(chan int)
\tresults := make(chan int)
\tvar wg sync.WaitGroup
\tfor w := 0; w < 10; w++ {
\t\twg.Add(1)
\t\tgo func() {
\t\t\tdefer wg.Done()
\t\t\tfor port := range jobs {
\t\t\t\tif scanPort(host, port, 100*time.Millisecond) {
\t\t\t\t\tresults <- port
\t\t\t\t}
\t\t\t}
\t\t}()
\t}
\tgo func() {
\t\tfor p := start; p <= end; p++ {
\t\t\tjobs <- p
\t\t}
\t\tclose(jobs)
\t}()
\tgo func() {
\t\twg.Wait()
\t\tclose(results)
\t}()
\tfor port := range results {
\t\tfmt.Printf("open: %d\\n", port)
\t}
}
\`\`\`
`;

function mockBuildApi() {
  return {
    runAutonomousKnowledgeAcquisition(model, query) {
      const text = BUGGY_SCANNER + '\n' + GOOD_SCANNER;
      return {
        id: 'knowledgeAcquisition.mock', timestamp: new Date().toISOString(), query,
        action: 'learned_from_research',
        distilled: { summary: text.slice(0, 160), text, topic: query, sourceCount: 2 },
        learned: null
      };
    }
  };
}

// --- Acceptance test ------------------------------------------------------------
const TEST_PORT = 18123;

function startListener() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(sock => sock.end());
    server.on('error', reject);
    server.listen(TEST_PORT, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Acceptance test for a scanner candidate:
 *  1. Must report the live listener port as open.
 *  2. A 50-port sweep (all closed, 100ms dial timeout) must finish in <4s —
 *     sequential would take ~5s, so this proves real concurrency.
 */
function acceptanceTest(code) {
  const t0 = Date.now();
  const found = teach.runCodeSandbox('go', code, {
    timeoutMs: 15000, args: ['127.0.0.1', String(TEST_PORT - 3), String(TEST_PORT + 3)]
  });
  if (found.timedOut) {
    return { pass: false, reason: 'timed out (hangs — classic unclosed results channel)' };
  }
  if (!found.ok) {
    return { pass: false, reason: `crashed: ${String(found.stderr).split('\n')[0].slice(0, 100)}` };
  }
  if (!String(found.stdout).includes(String(TEST_PORT))) {
    return { pass: false, reason: `missed the open port ${TEST_PORT}; got: ${JSON.stringify(found.stdout.slice(0, 60))}` };
  }
  const t1 = Date.now();
  const sweep = teach.runCodeSandbox('go', code, {
    timeoutMs: 15000, args: ['127.0.0.1', '18200', '18249']
  });
  const sweepMs = Date.now() - t1;
  if (sweep.timedOut || !sweep.ok) {
    return { pass: false, reason: 'sweep hung or crashed' };
  }
  if (sweepMs > 4000) {
    return { pass: false, reason: `50-port sweep took ${sweepMs}ms — not concurrent` };
  }
  return { pass: true, findMs: t1 - t0, sweepMs };
}

// --- The run ----------------------------------------------------------------------
(async () => {
  const model = freshModel();

  console.log('=== Phase 1: go learn Go ===');
  const learned = learn.learnTopic(model, 'go', mockLearnApi(), {
    maxTopics: 5, maxExamplesPerTopic: 5, timeoutMs: 30000
  });
  for (const t of learned.topics) {
    console.log(`  topic "${t.topic}": ${t.completed ? 'learned' : 'FAILED'} ` +
      `(examples verified: ${t.examplesVerified}, implementations: ${t.implementationsLearned})`);
  }

  console.log('\n=== Phase 2: build a concurrent port scanner ===');
  const res = mockBuildApi().runAutonomousKnowledgeAcquisition(model, 'Go concurrent port scanner');
  const candidates = agentic.extractCodeBlocks(res.distilled.text, 'go');
  console.log(`  research returned ${candidates.length} candidate implementations`);

  const server = await startListener();
  console.log(`  test listener live on 127.0.0.1:${TEST_PORT}`);
  let built = null;
  for (let i = 0; i < candidates.length; i++) {
    const verdict = acceptanceTest(candidates[i]);
    if (verdict.pass) {
      console.log(`  candidate ${i + 1}: PASS — found :${TEST_PORT} in ${verdict.findMs}ms, ` +
        `50-port sweep in ${verdict.sweepMs}ms (concurrent)`);
      built = { code: candidates[i], verdict };
      break;
    }
    console.log(`  candidate ${i + 1}: REJECTED — ${verdict.reason}`);
  }
  server.close();

  if (built) {
    const cg = teach.ensureCodeGeneration(model);
    cg.learnedImplementations.push({
      id: 'build-port-scanner',
      topic: 'project: concurrent port scanner',
      language: 'go',
      code: built.code,
      verifiedBy: 'acceptance-test',
      evidence: { foundPort: TEST_PORT, sweepMs: built.verdict.sweepMs },
      verifiedAt: new Date().toISOString()
    });
    console.log('\n  RESULT: scanner built, verified, and retained as a project.');
    console.log(`  model now holds ${cg.workedExamples.length} worked examples, ` +
      `${cg.learnedImplementations.length} implementations.`);
  } else {
    console.log('\n  RESULT: no candidate passed. Nothing retained — no bluffing.');
    process.exit(1);
  }
})().catch(e => { console.error('demo failed:', e); process.exit(1); });
