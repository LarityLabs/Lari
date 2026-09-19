/**
 * swarm_exam.js — college-exam self-testing.
 *
 * Greg's idea: make Lari better at chat/knowledge by giving him real exams.
 * The loop is deliberately non-circular:
 *
 *   1. BUILD: research exam questions. The answer key comes from the sources,
 *      but each answer is kept only if a SECOND, independent research query
 *      confirms it (cross-source agreement). One source asking, another
 *      source answering — not the same text grading itself.
 *   2. SIT THE EXAM: Lari answers CLOSED-BOOK (answerFn gets no research).
 *      This tests what he actually retained, not what he can look up.
 *   3. GRADE: mechanical, against the verified key — never by the same
 *      process that answered. Factual questions: normalized match.
 *      Explanations: key-concept recall (does his answer contain the
 *      verified answer's key terms?). The score is reported, not asserted.
 *   4. STUDY: misses become learning goals carrying the verified answer as
 *      the oracle. studyMisses researches them (open-book), then re-tests
 *      closed-book. Pass -> goal closed, retained. Fail -> stays open.
 *
 * What this trains: knowledge + explaining things correctly and completely
 * (a real slice of "chat better"). What it doesn't: wit, tone, timing —
 * those still come from human corrections.
 */
'use strict';

const teach = require('./swarm_code_self_teach.js');

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were',
  'be', 'been', 'that', 'this', 'with', 'for', 'as', 'by', 'on', 'it', 'its',
  'which', 'from', 'at', 'have', 'has', 'had', 'they', 'them', 'their', 'will',
  'would', 'can', 'could', 'should', 'there', 'what', 'when', 'where', 'how'
]);

function keyTerms(text) {
  return [...new Set(
    normalize(text).split(' ').filter(w => w.length > 4 && !STOPWORDS.has(w))
  )];
}

/**
 * Extract Q/A pairs from tutorial/exam text. Handles:
 *   Q: ... / A: ...            Question: ... / Answer: ...
 *   1. What is ...?            Answer: ...
 */
function extractQAPairs(text) {
  const pairs = [];
  const lines = String(text || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    let qm = lines[i].match(/^(?:Q|Question)\s*:\s*(.+)$/i);
    let q = null;
    if (qm) {
      q = qm[1].trim();
      i++;
    } else if (/^\d+[.)]\s+.+\?\s*$/.test(lines[i])) {
      q = lines[i].replace(/^\d+[.)]\s+/, '').trim();
      i++;
    } else { i++; continue; }
    // Collect answer lines: "A:" / "Answer:" prefixed, or following lines
    // until a blank line or the next question.
    const ansLines = [];
    while (i < lines.length) {
      const am = lines[i].match(/^(?:A|Answer)\s*:\s*(.+)$/i);
      if (am) { ansLines.push(am[1].trim()); i++; break; }
      if (/^\s*$/.test(lines[i])) { i++; break; }
      if (/^(?:Q|Question)\s*:/i.test(lines[i]) || /^\d+[.)]\s+/.test(lines[i])) break;
      ansLines.push(lines[i].trim());
      i++;
    }
    const a = ansLines.join(' ').trim();
    if (q && a && q.length > 8 && a.length > 1 && !pairs.some(p => p.question === q)) {
      pairs.push({ question: q, answer: a });
    }
  }
  return pairs;
}

/**
 * Verify an answer against a SECOND independent research query.
 * Short answers: the normalized answer must appear in the new distillation.
 * Long answers: >=50% of key terms must appear.
 */
function verifyAnswerCrossSource(question, answer, runtimeApi, model, options = {}) {
  let text = '';
  try {
    const res = runtimeApi.runAutonomousKnowledgeAcquisition(model, question, {
      sourceProvider: options.sourceProvider, sources: options.sources || []
    });
    text = (res && res.distilled && (res.distilled.text || res.distilled.summary)) || '';
  } catch (_) { return { verified: false, reason: 'research_failed' }; }
  if (!text) return { verified: false, reason: 'no_text' };
  const normText = normalize(text);
  if (answer.length < 60) {
    const found = normText.includes(normalize(answer));
    return { verified: found, reason: found ? 'second_source_confirms' : 'not_confirmed' };
  }
  const terms = keyTerms(answer);
  if (!terms.length) return { verified: false, reason: 'no_key_terms' };
  const hits = terms.filter(t => normText.includes(t)).length;
  const recall = hits / terms.length;
  return { verified: recall >= 0.5, recall, reason: recall >= 0.5 ? 'second_source_confirms' : 'not_confirmed' };
}

function buildExam(model, subject, runtimeApi, options = {}) {
  const result = { subject, questions: [], startedAt: new Date().toISOString() };
  let text = '';
  try {
    const res = runtimeApi.runAutonomousKnowledgeAcquisition(
      model, `college ${subject} exam questions with answers`,
      { sourceProvider: options.sourceProvider, sources: options.sources || [] }
    );
    text = (res && res.distilled && (res.distilled.text || res.distilled.summary)) || '';
  } catch (e) {
    result.error = String((e && e.message) || e).slice(0, 120);
    return result;
  }
  const pairs = extractQAPairs(text).slice(0, options.maxQuestions || 10);
  for (const p of pairs) {
    const v = verifyAnswerCrossSource(p.question, p.answer, runtimeApi, model, options);
    if (v.verified) {
      result.questions.push({
        question: p.question,
        verifiedAnswer: p.answer,
        answerType: p.answer.length < 60 ? 'factual' : 'explanation',
        verification: v.reason
      });
    }
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

/**
 * Grade one closed-book answer against the verified key. Mechanical only.
 */
function gradeAnswer(question, responseText) {
  const expected = question.verifiedAnswer;
  const normResp = normalize(responseText);
  if (!normResp) return { pass: false, score: 0, detail: 'no_answer' };
  if (question.answerType === 'factual') {
    const normExp = normalize(expected);
    const pass = normResp.includes(normExp) || normExp.includes(normResp);
    return { pass, score: pass ? 1 : 0, detail: pass ? 'exact_match' : 'no_match' };
  }
  const terms = keyTerms(expected);
  if (!terms.length) return { pass: false, score: 0, detail: 'no_key_terms' };
  const hits = terms.filter(t => normResp.includes(t)).length;
  const recall = hits / terms.length;
  return { pass: recall >= 0.5, score: recall, detail: `concept_recall ${hits}/${terms.length}` };
}

function recordExamMiss(model, subject, question) {
  const cg = teach.ensureCodeGeneration(model);
  const taskId = `exam-miss-${normalize(question.question).slice(0, 40).replace(/\s+/g, '-')}`;
  if ((cg.learningGoals || []).some(g => g.taskId === taskId)) return taskId;
  cg.learningGoals.push({
    taskId,
    kind: 'exam-miss',
    subject,
    question: question.question,
    verifiedAnswer: question.verifiedAnswer,
    answerType: question.answerType,
    description: `exam miss [${subject}]: ${question.question}`,
    status: 'open',
    queuedAt: new Date().toISOString()
  });
  return taskId;
}

/**
 * Sit the exam closed-book. answerFn(question) -> string; it must NOT
 * research (in production, pass a research-disabled chat wrapper).
 * Misses become learning goals with the verified answer as oracle.
 */
function runExam(model, exam, answerFn, options = {}) {
  const result = {
    subject: exam.subject,
    total: exam.questions.length,
    correct: 0,
    scored: [],
    startedAt: new Date().toISOString()
  };
  for (const q of exam.questions) {
    let responseText = '';
    try { responseText = String(answerFn(q.question) || ''); }
    catch (e) { responseText = ''; }
    const grade = gradeAnswer(q, responseText);
    if (grade.pass) result.correct++;
    else recordExamMiss(model, exam.subject, q);
    result.scored.push({
      question: q.question,
      answerType: q.answerType,
      pass: grade.pass,
      score: Math.round(grade.score * 100) / 100,
      detail: grade.detail
    });
  }
  result.scorePct = result.total ? Math.round((result.correct / result.total) * 100) : 0;
  result.finishedAt = new Date().toISOString();
  return result;
}

/**
 * Study open misses (open-book research), then re-test closed-book.
 * Passing closes the goal; failing leaves it open. Nothing is asserted
 * learned without the retest passing.
 */
function studyMisses(model, runtimeApi, answerFn, options = {}) {
  const cg = teach.ensureCodeGeneration(model);
  const result = { studied: 0, closed: 0, stillOpen: 0, details: [] };
  const misses = (cg.learningGoals || []).filter(g => g.kind === 'exam-miss' && g.status === 'open');
  for (const miss of misses.slice(0, options.maxMisses || 10)) {
    result.studied++;
    // Open-book study: research the question; the runtime's acquisition
    // learns it into the model.
    try {
      if (runtimeApi && typeof runtimeApi.runAutonomousKnowledgeAcquisition === 'function') {
        runtimeApi.runAutonomousKnowledgeAcquisition(model, `explain: ${miss.question}`, {
          sourceProvider: options.sourceProvider, sources: options.sources || []
        });
      }
    } catch (_) {}
    // Closed-book retest.
    let responseText = '';
    try { responseText = String(answerFn(miss.question) || ''); } catch (_) {}
    const grade = gradeAnswer({ verifiedAnswer: miss.verifiedAnswer, answerType: miss.answerType }, responseText);
    if (grade.pass) {
      miss.status = 'complete';
      miss.completedAt = new Date().toISOString();
      miss.closedBy = 'exam-retest';
      result.closed++;
    } else {
      result.stillOpen++;
    }
    result.details.push({ question: miss.question, pass: grade.pass, detail: grade.detail });
  }
  return result;
}

module.exports = {
  buildExam,
  runExam,
  studyMisses,
  gradeAnswer,
  extractQAPairs,
  verifyAnswerCrossSource,
  keyTerms,
  normalize
};
