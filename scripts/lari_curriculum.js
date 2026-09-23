#!/usr/bin/env node
/**
 * Lari curriculum walker — ordered-units learning loop proof.
 *
 * Ordered units (prerequisites first). Per unit:
 *   STUDY    research each topic anchor via scripts/lari_research.js
 *            (Wikipedia, zero external model calls) -> persist distilled
 *            sentences into a SCRATCH researched-knowledge store.
 *   VERIFY   fresh child process loads the runtime with the scratch store,
 *            asks the unit's problem set (checkable answers only: exact-match
 *            numeric or single-word, graded deterministically in
 *            lari_curriculum_quiz.js — Lari never grades himself).
 *   ADVANCE  only on pass (>= 75%). On fail: re-study ONCE with refined
 *            queries, re-verify. On second fail: log the gap honestly, move on.
 *
 * Bounds: first N units only (default 3). Scratch model + scratch research
 * store only; the live model and live researched-knowledge.json are never
 * written. The live model file is only ever READ (copied to scratch).
 *
 * Usage: node scripts/lari_curriculum.js [--units N]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const research = require(path.join(ROOT, 'scripts', 'lari_research.js'));

const BASE_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const QUIZ_SCRIPT = path.join(__dirname, 'lari_curriculum_quiz.js');
const SCRATCH = path.join(os.homedir(), 'workspace', 'scratch', 'lari-curriculum');
const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = path.join(SCRATCH, `run-${RUN_TS}`);
fs.mkdirSync(RUN_DIR, { recursive: true });
const STORE_PATH = path.join(RUN_DIR, 'researched-knowledge.scratch.json');

const PASS_PCT = 0.75;

// ---------------------------------------------------------------- syllabus -
// Faithful topic order from the MIT OCW 6.0001 Fall 2016 syllabus page
// (fetched 2026-09-23 from ocw.mit.edu). Problem sets are authored in the
// finger-exercise style of the course, with exact known keys.
const SYLLABUS = {
  name: 'MIT OCW 6.0001 Introduction to Computer Science and Programming in Python (Fall 2016)',
  source: 'https://ocw.mit.edu/courses/6-0001-introduction-to-computer-science-and-programming-in-python-fall-2016/pages/syllabus/',
  units: [
    {
      id: 'u1', session: 1, title: 'What is computation?',
      topics: 'expressions, values, types, operators, precedence',
      anchors: [
        'order of operations arithmetic',
        'Python programming language operators',
        'exponentiation mathematics'
      ],
      questions: [
        { id: 'u1q1', prompt: 'what is 3 + 4 * 2? answer with just the number', type: 'number', answer: 11 },
        { id: 'u1q2', prompt: 'what is (6 + 2) * 3? answer with just the number', type: 'number', answer: 24 },
        { id: 'u1q3', prompt: 'what is 2 ** 3? answer with just the number', type: 'number', answer: 8 },
        { id: 'u1q4', prompt: 'what is 2.5 * 4? answer with just the number', type: 'number', answer: 10 },
        { id: 'u1q5', prompt: 'what is 100 - 37? answer with just the number', type: 'number', answer: 63 },
        { id: 'u1q6', prompt: 'what is 9 - 17? answer with just the number', type: 'number', answer: -8 },
        { id: 'u1q7', prompt: 'what is 2 * (3 + 4) - 5? answer with just the number', type: 'number', answer: 9 },
        { id: 'u1q8', prompt: 'what is 3 + 4 * 2 - 1? answer with just the number', type: 'number', answer: 10 }
      ]
    },
    {
      id: 'u2', session: 2, title: 'Branching and Iteration',
      topics: 'if/elif/else, while loops, for loops, range',
      anchors: [
        'Python for loop',
        'while loop programming',
        'conditional statement computer programming'
      ],
      questions: [
        { id: 'u2q1', prompt: 'what is 1 + 2 + 3 + 4 + 5? answer with just the number', type: 'number', answer: 15 },
        { id: 'u2q2', prompt: 'what is 2 + 2 + 2 + 2? answer with just the number', type: 'number', answer: 8 },
        { id: 'u2q3', prompt: 'what is 7 * 6? answer with just the number', type: 'number', answer: 42 },
        { id: 'u2q4', prompt: 'what is 20 - 3 - 3 - 3? answer with just the number', type: 'number', answer: 11 },
        { id: 'u2q5', prompt: 'a python while loop starts x at 0 and adds 1 each pass while x is less than 4. after the loop, what is x? answer with just the number', type: 'number', answer: 4 },
        { id: 'u2q6', prompt: 'in python, which keyword starts a conditional branch? reply with the word only', type: 'word', answer: 'if' }
      ]
    },
    {
      id: 'u3', session: 3, title: 'String Manipulation, Guess and Check',
      topics: 'strings, indexing, slicing, guess-and-check, bisection',
      anchors: [
        'Python string operations',
        'bisection method',
        'guess and check algorithm'
      ],
      questions: [
        { id: 'u3q1', prompt: 'what is (0 + 100) / 2? answer with just the number', type: 'number', answer: 50 },
        { id: 'u3q2', prompt: 'what is 7 * 7? answer with just the number', type: 'number', answer: 49 },
        { id: 'u3q3', prompt: 'what is 50 / 2? answer with just the number', type: 'number', answer: 25 },
        { id: 'u3q4', prompt: 'in python, which function returns the length of a string? reply with the word only', type: 'word', answer: 'len' },
        { id: 'u3q5', prompt: 'in python, what is the first character of the string hello? reply with the character only', type: 'word', answer: 'h' }
      ]
    }
  ]
};

// ------------------------------------------------------------------ helpers -
function freshModel(tag) {
  const dst = path.join(RUN_DIR, `model-${tag}.json`);
  const m = JSON.parse(fs.readFileSync(BASE_MODEL, 'utf8'));
  m.__lariSourcePath = dst;
  fs.writeFileSync(dst, JSON.stringify(m));
  return dst;
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

function saveStore(entries) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2));
}

// Same merge semantics as the runtime's addLariResearchedKnowledge:
// dedup by topic, prepend fresh sentences, cap at 60, union sources.
function mergeIntoStore(entries, topic, sentences, sources) {
  const cleanTopic = String(topic || '').trim();
  const cleanSentences = [...new Set((sentences || [])
    .map(s => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(s => s.length >= 25 && s.length <= 500))].slice(0, 40);
  if (!cleanTopic || !cleanSentences.length) return 0;
  let entry = entries.find(e => String(e.topic || '').toLowerCase() === cleanTopic.toLowerCase());
  if (!entry) {
    entry = { topic: cleanTopic, sentences: [], sources: [], researchedAt: '' };
    entries.push(entry);
  }
  const known = new Set(entry.sentences || []);
  let added = 0;
  const fresh = [];
  for (const s of cleanSentences) {
    if (!known.has(s)) { fresh.push(s); known.add(s); added += 1; }
  }
  entry.sentences = [...fresh, ...(entry.sentences || [])].slice(0, 60);
  for (const src of (sources || [])) {
    if (src && !entry.sources.includes(src)) entry.sources.push(src);
  }
  entry.researchedAt = new Date().toISOString();
  return added;
}

async function study(unit, attempt, log) {
  const entries = loadStore();
  const anchors = attempt === 1
    ? unit.anchors
    : unit.anchors.map(a => `${a} tutorial example`);
  log.studyAttempts.push({ attempt, anchors });
  for (const anchor of anchors) {
    try {
      const res = await research.researchTopic(anchor);
      const added = mergeIntoStore(entries, res.topic || anchor, res.sentences, res.sources);
      log.sentencesAdded += added;
      for (const s of res.sources) if (!log.sources.includes(s)) log.sources.push(s);
      log.studyAttempts[log.studyAttempts.length - 1].detail =
        (log.studyAttempts[log.studyAttempts.length - 1].detail || '') +
        `[${anchor}: ${res.sentences.length} distilled, ${added} new] `;
    } catch (e) {
      log.studyAttempts[log.studyAttempts.length - 1].detail =
        (log.studyAttempts[log.studyAttempts.length - 1].detail || '') +
        `[${anchor}: RESEARCH ERROR ${e.message}] `;
    }
  }
  saveStore(entries);
}

function quiz(unit, modelPath) {
  const qPath = path.join(RUN_DIR, `questions-${unit.id}.json`);
  const outPath = path.join(RUN_DIR, `results-${unit.id}.json`);
  fs.writeFileSync(qPath, JSON.stringify(unit.questions, null, 2));
  const env = { ...process.env, LARI_RESEARCH_STORE: STORE_PATH };
  const out = execFileSync('node', [QUIZ_SCRIPT, modelPath, qPath, outPath], {
    env, timeout: 1000 * 60 * 12, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  const summary = JSON.parse(out.trim().split('\n').pop());
  const results = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  return { summary, results };
}

// --------------------------------------------------------------------- main -
(async () => {
  const argIdx = process.argv.indexOf('--units');
  const nUnits = argIdx >= 0 ? Math.max(1, parseInt(process.argv[argIdx + 1], 10) || 3) : 3;
  const units = SYLLABUS.units.slice(0, nUnits);

  const runLog = {
    syllabus: SYLLABUS.name,
    syllabusSource: SYLLABUS.source,
    startedAt: new Date().toISOString(),
    passThreshold: PASS_PCT,
    units: []
  };

  for (const unit of units) {
    const log = {
      id: unit.id, session: unit.session, title: unit.title, topics: unit.topics,
      studyAttempts: [], sentencesAdded: 0, sources: [],
      quizzes: [], verdict: 'not-run', gap: null
    };
    console.log(`\n=== ${unit.id.toUpperCase()} (session ${unit.session}): ${unit.title} ===`);

    const modelPath = freshModel(unit.id);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      console.log(`-- study attempt ${attempt}`);
      await study(unit, attempt, log);
      console.log(`-- quiz attempt ${attempt} (${unit.questions.length} questions)`);
      const { summary, results } = quiz(unit, modelPath);
      log.quizzes.push({ attempt, passed: summary.passed, total: summary.total, results });
      const pct = summary.passed / summary.total;
      console.log(`   score: ${summary.passed}/${summary.total} (${(pct * 100).toFixed(1)}%)`);
      for (const r of results) {
        console.log(`   [${r.pass ? 'PASS' : 'FAIL'}] ${r.id}: expected=${r.expected} extracted=${r.extracted}${r.error ? ' ERROR=' + r.error : ''}`);
        if (!r.pass) console.log(`        raw: ${JSON.stringify((r.raw || '').slice(0, 160))}`);
      }
      if (pct >= PASS_PCT) {
        log.verdict = attempt === 1 ? 'passed' : 'passed-after-restudy';
        break;
      }
      if (attempt === 1) {
        console.log('   below threshold — re-studying once with refined queries');
      }
    }

    if (log.verdict === 'not-run' || !log.verdict.startsWith('passed')) {
      const last = log.quizzes[log.quizzes.length - 1];
      const failed = last.results.filter(r => !r.pass).map(r => r.id);
      log.verdict = 'failed';
      log.gap = `Still ${last.passed}/${last.total} after re-study. Failed items: ${failed.join(', ')}. ` +
        `Study material (${log.sentencesAdded} sentences, ${log.sources.length} sources) did not ` +
        `translate into checkable answers for this unit's concepts. Advancing anyway per honest-gap policy.`;
      console.log(`   GAP LOGGED: ${log.gap}`);
    } else {
      console.log(`   verdict: ${log.verdict} — advancing`);
    }
    runLog.units.push(log);
  }

  runLog.finishedAt = new Date().toISOString();
  const logPath = path.join(RUN_DIR, 'run-log.json');
  fs.writeFileSync(logPath, JSON.stringify(runLog, null, 2));

  console.log('\n================ SUMMARY ================');
  for (const u of runLog.units) {
    const last = u.quizzes[u.quizzes.length - 1];
    console.log(`${u.id} "${u.title}": ${last.passed}/${last.total} -> ${u.verdict}`);
  }
  console.log(`run log: ${logPath}`);
  console.log(`scratch store: ${STORE_PATH}`);
})().catch(e => { console.error('walker fatal:', e); process.exit(1); });
