/**
 * swarm_code_learn.js — "go learn X": autonomous topic learning.
 *
 * Telling Lari "go learn Python" should make him actually learn it: figure
 * out what the topics are, study each one, verify the examples, acquire new
 * implementations, and retain everything with provenance. No human writes
 * exercises or answer keys.
 *
 * How each topic is learned (all machine-checkable, no human oracle):
 *   1. Research the topic; distill tutorial text.
 *   2. Extract doc examples (doctest-style `>>>` and `# Output:` comments).
 *      Run each; keep it only if the code really produces the doc's stated
 *      output. This builds a TRUSTED example library — and catches bad docs.
 *   3. Cross-check new implementations: when research shows a function
 *      (e.g. bubble_sort) and a trusted example covers the same input shape,
 *      run both on perturbed inputs. Agreement on fresh inputs means the
 *      implementation generalizes — not memorized, learned.
 *   4. Remaining research code goes through the oracle-free verifier
 *      (differential agreement / property checks).
 *   5. Topic notes (the "when/where to use it") are retained from the
 *      distilled research alongside the verified code.
 *
 * Bounds: maxTopics, maxExamplesPerTopic. Resumable: completed topic goals
 * are skipped on rerun.
 */
'use strict';

const teach = require('./swarm_code_self_teach.js');
const agentic = require('./swarm_code_agentic.js');

function normalizeOutput(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim().replace(/\n+$/, '');
}

function ensureLearnState(model) {
  const cg = teach.ensureCodeGeneration(model);
  cg.workedExamples = cg.workedExamples || [];
  cg.learnedImplementations = cg.learnedImplementations || [];
  return cg;
}

// ---------------------------------------------------------------------------
// Curriculum: what should be learned?
// ---------------------------------------------------------------------------

const FALLBACK_TOPICS = {
  python: [
    'Variables and data types', 'Strings', 'Lists', 'Dictionaries',
    'Conditionals', 'Loops', 'Functions', 'File I/O', 'Classes',
    'Exceptions', 'Modules'
  ],
  javascript: [
    'Variables and data types', 'Strings', 'Arrays', 'Objects',
    'Conditionals', 'Loops', 'Functions', 'Callbacks and promises',
    'Classes', 'Modules', 'Error handling'
  ],
  go: [
    'Variables and types', 'Slices and maps', 'Loops', 'Functions',
    'Structs', 'Pointers', 'Interfaces', 'Goroutines', 'Channels',
    'Error handling', 'Packages and modules'
  ]
};

function langDisplayName(language) {
  return language === 'javascript' ? 'JavaScript' : language === 'go' ? 'Go' : 'Python';
}

/**
 * Parse a topic list out of tutorial text (numbered or bulleted lists).
 */
function parseTopicList(text) {
  const topics = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/);
    if (!m) continue;
    // "Lists - creating and using lists" -> "Lists"
    const topic = m[1].split(/\s+[-–—:]\s+/)[0].trim();
    if (topic && topic.length >= 2 && topic.length < 60 && !topics.includes(topic)) {
      topics.push(topic);
    }
  }
  return topics;
}

function buildTopicCurriculum(model, language, runtimeApi, options = {}) {
  const cg = ensureLearnState(model);
  const langName = langDisplayName(language);
  let topics = [];
  let source = 'research';
  try {
    if (runtimeApi && typeof runtimeApi.runAutonomousKnowledgeAcquisition === 'function') {
      const res = runtimeApi.runAutonomousKnowledgeAcquisition(
        model, `${langName} programming tutorial table of contents`,
        { sourceProvider: options.sourceProvider, sources: options.sources || [] }
      );
      const text = (res && res.distilled && (res.distilled.text || res.distilled.summary)) || '';
      topics = parseTopicList(text);
    }
  } catch (_) {}
  if (!topics.length) {
    topics = (FALLBACK_TOPICS[language] || FALLBACK_TOPICS.python).slice();
    source = 'fallback';
  }
  const maxTopics = options.maxTopics || topics.length;
  let created = 0;
  for (const topic of topics.slice(0, maxTopics)) {
    const taskId = `learn-${language}-${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if ((cg.learningGoals || []).some(g => g.taskId === taskId)) continue;
    cg.learningGoals.push({
      taskId,
      kind: 'learn-topic',
      topic,
      language,
      description: `learn ${langName} topic: ${topic}`,
      concepts: [topic.toLowerCase()],
      status: 'open',
      curriculumSource: source,
      queuedAt: new Date().toISOString()
    });
    created++;
  }
  return { topics: topics.slice(0, maxTopics), created, source };
}

// ---------------------------------------------------------------------------
// Doc examples: (code, expectedOutput) pairs from tutorial text.
// ---------------------------------------------------------------------------

/**
 * REPL expressions echo their value; scripts do not. Wrap a bare trailing
 * expression in print() so doctest examples run as scripts.
 */
function doctestToScript(code) {
  const lines = String(code).split('\n');
  let lastIdx = lines.length - 1;
  while (lastIdx > 0 && lines[lastIdx].trim() === '') lastIdx--;
  const last = lines[lastIdx].trim();
  if (/^(print|import|from|def |class |for |while |if |with |try|except|return|assert|raise)\b/.test(last)) return code;
  if (/=[^=]/.test(last) && !/==/.test(last)) return code; // assignment, no echo
  lines[lastIdx] = `print(${lines[lastIdx]})`;
  return lines.join('\n');
}

function extractDocExamples(text, language) {
  const examples = [];
  const lines = String(text || '').split('\n');
  let setup = []; // prior doctest lines with no output (state the examples build on)
  let i = 0;
  while (i < lines.length) {
    const cm = lines[i].match(/^>>>\s?(.*)$/);
    if (!cm) { i++; continue; }
    const codeLines = [cm[1]];
    i++;
    while (i < lines.length && /^\.\.\.\s?(.*)$/.test(lines[i])) {
      codeLines.push(lines[i].replace(/^\.\.\.\s?/, ''));
      i++;
    }
    const outLines = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^>>>/.test(lines[i])) {
      outLines.push(lines[i]);
      i++;
    }
    const rawCode = codeLines.join('\n').trim();
    const expected = outLines.join('\n').trim();
    if (!rawCode) continue;
    if (expected) {
      const fullCode = doctestToScript([...setup, rawCode].join('\n'));
      if (!examples.some(e => e.code === fullCode)) {
        examples.push({ code: fullCode, expectedOutput: expected, style: 'doctest' });
      }
    } else {
      setup.push(rawCode); // state for later examples
    }
  }
  // `# Output: X` / `// Output: X` / `# => X` comments inside fenced blocks.
  for (const block of agentic.extractCodeBlocks(text, language)) {
    const codePart = [];
    let expected = null;
    for (const bl of block.split('\n')) {
      const om = bl.match(/(?:#|\/\/)\s*(?:output|=>|prints?|result)\s*:\s*(.+)$/i);
      if (om) expected = om[1].trim();
      else codePart.push(bl);
    }
    const code = codePart.join('\n').trim();
    if (expected && code && !examples.some(e => e.code === code)) {
      examples.push({ code, expectedOutput: expected, style: 'output-comment' });
    }
  }
  return examples;
}

// ---------------------------------------------------------------------------
// Cross-check: does a researched implementation generalize?
// ---------------------------------------------------------------------------

/**
 * Find perturbable input literals: python `[3, 1, 2]`, go `[]int{3, 1, 2}`.
 */
function extractInputLiterals(code, language) {
  const inputs = [];
  const re = language === 'go' ? /\[\]int\{([0-9,\s]+)\}/g : /\[([0-9,\s]+)\]/g;
  for (const m of String(code).matchAll(re)) {
    const nums = m[1].split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number);
    if (nums.length >= 2 && !inputs.some(x => x.text === m[0])) {
      inputs.push({ text: m[0], nums });
    }
  }
  return inputs;
}

function extractFunctionName(code, language) {
  const m = language === 'python'
    ? String(code).match(/def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    : language === 'go'
    ? String(code).match(/func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    : String(code).match(/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  return m ? m[1] : null;
}

function perturbInput(nums, variant) {
  return nums.map((n, idx) => n + ((variant + idx) % 3) * 2 + 1);
}

function freshInputText(fresh, language) {
  return language === 'go' ? `[]int{${fresh.join(', ')}}` : `[${fresh.join(', ')}]`;
}

/**
 * Cross-check a researched implementation against trusted example code on
 * FRESH inputs (perturbed from the example's). Agreement means the
 * implementation generalizes — learned, not memorized.
 *
 * Strategy A (substitution): both sides are runnable programs; substitute the
 * fresh input into each and compare outputs. Strategy B (function call):
 * append a call of the researched function on the fresh input (python/js).
 */
function crossCheckImplementation(exampleCode, implCode, language, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const maxVariants = options.maxVariants || 3;
  const inputs = extractInputLiterals(exampleCode, language);

  if (inputs.length) {
    const implInputs = extractInputLiterals(implCode, language);
    if (implInputs.length) {
      let agreements = 0;
      let attempts = 0;
      for (const input of inputs.slice(0, 2)) {
        for (let v = 0; v < maxVariants; v++) {
          const freshText = freshInputText(perturbInput(input.nums, v), language);
          const oracleProg = language === 'python'
            ? doctestToScript(String(exampleCode).split(input.text).join(freshText))
            : String(exampleCode).split(input.text).join(freshText);
          const oracleRun = teach.runCodeSandbox(language, oracleProg, { timeoutMs });
          const oracleOut = normalizeOutput(oracleRun.stdout);
          if (!oracleRun.ok || !oracleOut) continue;
          const testProg = String(implCode).split(implInputs[0].text).join(freshText);
          const testRun = teach.runCodeSandbox(language, testProg, { timeoutMs });
          attempts++;
          if (testRun.ok && normalizeOutput(testRun.stdout) === oracleOut) agreements++;
        }
        if (attempts >= maxVariants) break;
      }
      return {
        checked: attempts > 0,
        agreements,
        attempts,
        passed: attempts > 0 && agreements === attempts,
        strategy: 'substitution'
      };
    }
  }

  // Strategy B: researched function applied to fresh inputs.
  const funcName = extractFunctionName(implCode, language);
  if (!funcName) return { checked: false, reason: 'no_function_def' };
  if (!inputs.length) return { checked: false, reason: 'no_list_input' };
  if (language !== 'python' && language !== 'javascript') {
    return { checked: false, reason: 'no_call_strategy' };
  }
  let agreements = 0;
  let attempts = 0;
  for (const input of inputs.slice(0, 2)) {
    for (let v = 0; v < maxVariants; v++) {
      const freshText = freshInputText(perturbInput(input.nums, v), language);
      const oracleProg = doctestToScript(String(exampleCode).split(input.text).join(freshText));
      const oracleRun = teach.runCodeSandbox(language, oracleProg, { timeoutMs });
      const oracleOut = normalizeOutput(oracleRun.stdout);
      if (!oracleRun.ok || !oracleOut) continue;
      const callLine = language === 'python'
        ? `\nprint(${funcName}(${freshText}))`
        : `\nconsole.log(${funcName}(${freshText}));`;
      const testRun = teach.runCodeSandbox(language, implCode + callLine, { timeoutMs });
      attempts++;
      if (testRun.ok && normalizeOutput(testRun.stdout) === oracleOut) agreements++;
    }
    if (attempts >= maxVariants) break;
  }
  return {
    checked: attempts > 0,
    agreements,
    attempts,
    passed: attempts > 0 && agreements === attempts,
    strategy: 'function-call'
  };
}

// ---------------------------------------------------------------------------
// Per-topic learning loop.
// ---------------------------------------------------------------------------

function retainWorkedExample(model, goal, example) {
  const cg = ensureLearnState(model);
  const id = `example-${goal.taskId}-${cg.workedExamples.length}`;
  if (!cg.workedExamples.some(e => e.code === example.code)) {
    cg.workedExamples.push({
      id,
      topic: goal.topic,
      language: goal.language,
      code: example.code,
      expectedOutput: example.expectedOutput,
      style: example.style,
      verifiedBy: 'doc-example',
      verifiedAt: new Date().toISOString()
    });
  }
  return id;
}

function retainImplementation(model, goal, code, verifiedBy, evidence) {
  const cg = ensureLearnState(model);
  const id = `impl-${goal.taskId}-${cg.learnedImplementations.length}`;
  if (!cg.learnedImplementations.some(e => e.code === code)) {
    cg.learnedImplementations.push({
      id,
      topic: goal.topic,
      language: goal.language,
      code,
      verifiedBy,
      evidence: evidence || null,
      verifiedAt: new Date().toISOString()
    });
  }
  return id;
}

function learnTopicGoal(model, goal, runtimeApi, options = {}) {
  const result = {
    topic: goal.topic,
    completed: false,
    examplesVerified: 0,
    implementationsLearned: 0,
    notes: null
  };
  const maxExamples = options.maxExamplesPerTopic || 5;
  const timeoutMs = options.timeoutMs || 10000;

  // 1. Research the topic.
  let text = '';
  try {
    if (runtimeApi && typeof runtimeApi.runAutonomousKnowledgeAcquisition === 'function') {
      const langName = langDisplayName(goal.language);
      const res = runtimeApi.runAutonomousKnowledgeAcquisition(
        model, `${langName} ${goal.topic} tutorial with examples`,
        { sourceProvider: options.sourceProvider, sources: options.sources || [] }
      );
      text = (res && res.distilled && (res.distilled.text || res.distilled.summary)) || '';
      const summary = (res && res.distilled && res.distilled.summary) || '';
      if (summary || text) {
        // The "when/where to use it" — retained alongside the code.
        goal.notes = normalizeOutput(summary || text).slice(0, 600);
        result.notes = goal.notes;
      }
    }
  } catch (e) {
    result.researchError = String((e && e.message) || e).slice(0, 120);
  }
  if (!text) {
    result.completed = false;
    return result;
  }

  // 2. Verify doc examples -> trusted library.
  const trusted = [];
  for (const ex of extractDocExamples(text, goal.language).slice(0, maxExamples)) {
    let run;
    try { run = teach.runCodeSandbox(goal.language, ex.code, { timeoutMs }); } catch (_) { continue; }
    if (run.ok && normalizeOutput(run.stdout) === normalizeOutput(ex.expectedOutput)) {
      trusted.push(ex);
      retainWorkedExample(model, goal, ex);
      result.examplesVerified++;
    }
  }

  // 3. Cross-check researched implementations against trusted examples
  //    on fresh inputs. Collect candidate blocks (dedup, skip pure examples).
  const blocks = [];
  for (const b of agentic.extractCodeBlocks(text, goal.language)) {
    if (!blocks.includes(b) && !trusted.some(t => t.code === b)) blocks.push(b);
  }
  const trustedCodes = new Set(trusted.map(t => t.code));
  for (const block of blocks.slice(0, options.maxImplBlocks || 6)) {
    let crossChecked = false;
    for (const ex of trusted) {
      const cc = crossCheckImplementation(ex.code, block, goal.language, options);
      if (!cc.checked) continue;
      crossChecked = true;
      if (cc.passed) {
        retainImplementation(model, goal, block, 'cross-check', {
          agreements: cc.agreements, attempts: cc.attempts, strategy: cc.strategy
        });
        result.implementationsLearned++;
      }
      break; // one trusted example per block is enough
    }
    if (crossChecked || trustedCodes.has(block)) continue;
    // 4. Remaining blocks: oracle-free verification (differential/properties).
    try {
      const v = agentic.verifyCodeNoOracle(
        model,
        { id: goal.taskId, language: goal.language, description: `${goal.topic} example`, tags: [goal.topic] },
        block, options
      );
      if (v.verified) {
        retainImplementation(model, goal, block, v.tier, v.agreement || null);
        result.implementationsLearned++;
      }
    } catch (_) {}
  }

  goal.examplesVerified = (goal.examplesVerified || 0) + result.examplesVerified;
  goal.implementationsLearned = (goal.implementationsLearned || 0) + result.implementationsLearned;
  if (result.examplesVerified > 0 || result.implementationsLearned > 0) {
    goal.status = 'complete';
    goal.completedAt = new Date().toISOString();
    goal.verificationLevel = 'verified';
    result.completed = true;
  } else if (goal.notes) {
    // Studied but nothing machine-verifiable came out of it. Honest label.
    goal.status = 'complete';
    goal.completedAt = new Date().toISOString();
    goal.verificationLevel = 'studied';
    result.completed = true;
    result.studiedOnly = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Driver: "go learn X".
// ---------------------------------------------------------------------------

function learnTopic(model, languageOrRequest, runtimeApi, options = {}) {
  const requested = typeof languageOrRequest === 'string'
    ? languageOrRequest.trim().split(/\s+/).pop().toLowerCase()
    : String((languageOrRequest && languageOrRequest.language) || 'python').toLowerCase();
  const language = /^(javascript|js|node)$/.test(requested) ? 'javascript'
    : /^(go|golang)$/.test(requested) ? 'go'
    : 'python';
  const result = {
    language,
    topicsPlanned: 0,
    topicsCompleted: 0,
    topics: [],
    startedAt: new Date().toISOString()
  };
  const cg = ensureLearnState(model);

  // Curriculum (idempotent — never duplicates existing goals).
  const existing = (cg.learningGoals || []).filter(g => g.kind === 'learn-topic' && g.language === language);
  if (!existing.length) {
    const cur = buildTopicCurriculum(model, language, runtimeApi, options);
    result.curriculumSource = cur.source;
    result.topicsPlanned = cur.topics.length;
  } else {
    result.topicsPlanned = existing.length;
    result.curriculumSource = 'existing';
  }

  const goals = (cg.learningGoals || [])
    .filter(g => g.kind === 'learn-topic' && g.language === language && g.status === 'open')
    .slice(0, options.maxTopics || 5);
  for (const goal of goals) {
    let r;
    try {
      r = learnTopicGoal(model, goal, runtimeApi, options);
    } catch (e) {
      r = { topic: goal.topic, completed: false, error: String((e && e.message) || e).slice(0, 120) };
    }
    result.topics.push(r);
    if (r.completed) result.topicsCompleted++;
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

module.exports = {
  learnTopic,
  learnTopicGoal,
  buildTopicCurriculum,
  parseTopicList,
  extractDocExamples,
  doctestToScript,
  crossCheckImplementation,
  ensureLearnState
};
