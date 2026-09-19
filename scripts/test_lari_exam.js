/**
 * Tests for swarm_exam.js — the college-exam self-testing loop.
 * Mock research; no real network.
 *
 * Run: node scripts/test_lari_exam.js
 */
'use strict';

const exam = require('../swarm_exam.js');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const EXAM_TEXT = `Biology 101 practice exam:

Q: What organelle is known as the powerhouse of the cell?
A: mitochondria

Q: What process do plants use to convert sunlight into energy?
A: photosynthesis

Q: Which blood cells carry oxygen?
A: red blood cells
`;

// Second-source confirmations, keyed by question substring.
const SECOND_SOURCES = {
  'powerhouse of the cell': 'The mitochondria is often called the powerhouse of the cell because it produces ATP.',
  'convert sunlight into energy': 'Photosynthesis allows plants to convert sunlight into chemical energy.',
  'carry oxygen': 'White blood cells fight infection and are part of the immune system.'
};

function mockApi() {
  return {
    runAutonomousKnowledgeAcquisition(model, query) {
      let text = '';
      if (/exam questions/i.test(query)) text = EXAM_TEXT;
      else {
        for (const [key, val] of Object.entries(SECOND_SOURCES)) {
          if (query.includes(key)) { text = val; break; }
        }
      }
      return {
        id: 'knowledgeAcquisition.mock', timestamp: new Date().toISOString(), query,
        action: 'learned_from_research',
        distilled: { summary: text.slice(0, 160), text, topic: query, sourceCount: 1 },
        learned: null
      };
    }
  };
}

function freshModel() {
  return { lariCodeGeneration: { solutions: [], practiceLog: [], learningGoals: [] } };
}

console.log('== Q/A extraction ==');
const pairs = exam.extractQAPairs(EXAM_TEXT);
check('extracts 3 pairs', pairs.length === 3, `got ${pairs.length}`);
check('first pair correct', pairs[0] && pairs[0].question.includes('powerhouse') && pairs[0].answer === 'mitochondria',
  JSON.stringify(pairs[0]));
const numbered = exam.extractQAPairs('1. What is H2O?\nAnswer: water\n\n2. Boiling point of water?\nAnswer: 100 degrees Celsius\n');
check('numbered format works', numbered.length === 2 && numbered[0].answer === 'water', JSON.stringify(numbered));

console.log('== exam build: cross-source answer verification ==');
const api = mockApi();
const model = freshModel();
const built = exam.buildExam(model, 'biology 101', api);
check('keeps the 2 confirmed questions', built.questions.length === 2, `got ${built.questions.length}`);
check('drops the unconfirmed answer', !built.questions.some(q => q.question.includes('carry oxygen')));
check('all kept answers marked verified', built.questions.every(q => q.verifiedAnswer && q.answerType === 'factual'));

console.log('== closed-book exam + mechanical grading ==');
const knowledge = {
  'powerhouse of the cell': 'mitochondria',
  'convert sunlight into energy': 'respiration' // wrong — will become a miss
};
const answerFn = (q) => {
  for (const [key, val] of Object.entries(knowledge)) if (q.includes(key)) return val;
  return '';
};
const result = exam.runExam(model, built, answerFn);
check('scores 1/2', result.correct === 1 && result.total === 2, JSON.stringify({ c: result.correct, t: result.total }));
check('scorePct 50', result.scorePct === 50);
const goals = model.lariCodeGeneration.learningGoals;
check('miss becomes a learning goal', goals.length === 1 && goals[0].kind === 'exam-miss',
  JSON.stringify(goals.map(g => g.kind)));
check('miss carries the verified answer as oracle', goals[0] && goals[0].verifiedAnswer === 'photosynthesis');
check('no duplicate goals on re-run', (() => { exam.runExam(model, built, answerFn); return goals.length === 1; })());

console.log('== study misses, then retest ==');
// Studying works: the stub "learns" photosynthesis now.
knowledge['convert sunlight into energy'] = 'photosynthesis is the process plants use to convert sunlight into energy';
const study = exam.studyMisses(model, api, answerFn);
check('studied the miss', study.studied === 1);
check('retest passes, goal closed', study.closed === 1 && goals[0].status === 'complete',
  JSON.stringify({ closed: study.closed, status: goals[0].status }));

console.log('== explanation grading: concept recall ==');
const longQ = {
  question: 'Explain photosynthesis.',
  verifiedAnswer: 'Photosynthesis is the process by which green plants convert sunlight, water and carbon dioxide into glucose and oxygen using chlorophyll.',
  answerType: 'explanation'
};
const good = exam.gradeAnswer(longQ, 'Plants use chlorophyll to convert sunlight and water and carbon dioxide into glucose, releasing oxygen.');
check('good explanation passes', good.pass === true, JSON.stringify(good));
const bad = exam.gradeAnswer(longQ, 'Plants are green and they grow in soil.');
check('bad explanation fails', bad.pass === false, JSON.stringify(bad));
const empty = exam.gradeAnswer(longQ, '');
check('empty answer fails', empty.pass === false);

console.log(`\n${passed} passed, ${failed} failed.`);
if (failures.length) { console.log('Failures:', failures.join(', ')); process.exit(1); }
