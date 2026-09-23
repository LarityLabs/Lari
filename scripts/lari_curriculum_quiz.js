#!/usr/bin/env node
/**
 * Curriculum quiz runner (child process).
 *
 * Usage:
 *   LARI_RESEARCH_STORE=<scratch-store.json> node scripts/lari_curriculum_quiz.js \
 *     <scratch-model.json> <questions.json> <results-out.json>
 *
 * Loads the runtime FRESH (so the researched-knowledge store in
 * LARI_RESEARCH_STORE is picked up at init), asks each question in order
 * against the scratch model, and writes per-question results.
 *
 * Question format (JSON array): { id, prompt, type: 'number'|'word', answer }
 * Result format: [{ id, prompt, expected, raw, extracted, pass, ms, error }]
 *
 * Never touches the live model: the model file is the scratch copy passed in.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));

const TURN_TIMEOUT_MS = 60000;

function replyText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  return String(r.answer || r.text || r.reply || '').trim();
}

function extractNumber(text) {
  const m = String(text || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function extractWord(text) {
  const t = String(text || '').toLowerCase();
  const quoted = t.match(/['"]([a-z])['"]/);
  if (quoted) return quoted[1];
  const m = t.match(/\b([a-z]{1,12})\b/);
  return m ? m[1] : '';
}

function numbersEqual(a, b) {
  if (a === null || b === null || Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) < 1e-9;
}

async function turn(model, text) {
  const p = runtime.sendMessageToLariAsync(model, text, {});
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), TURN_TIMEOUT_MS));
  const r = await Promise.race([p, timeout]);
  return replyText(r);
}

(async () => {
  const [modelPath, questionsPath, outPath] = process.argv.slice(2);
  if (!modelPath || !questionsPath || !outPath) {
    console.error('usage: node scripts/lari_curriculum_quiz.js <scratch-model.json> <questions.json> <results-out.json>');
    process.exit(2);
  }
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
  const results = [];
  for (const q of questions) {
    const started = Date.now();
    let raw = '', extracted = null, pass = false, error = null;
    try {
      raw = await turn(model, q.prompt);
      if (q.type === 'number') {
        extracted = extractNumber(raw);
        pass = numbersEqual(extracted, Number(q.answer));
      } else {
        extracted = extractWord(raw);
        pass = extracted === String(q.answer).toLowerCase();
      }
    } catch (e) {
      error = e.message;
    }
    results.push({
      id: q.id, prompt: q.prompt, type: q.type,
      expected: q.answer, raw: raw.slice(0, 300),
      extracted, pass, ms: Date.now() - started, error
    });
  }
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  const nPass = results.filter(r => r.pass).length;
  console.log(JSON.stringify({ total: results.length, passed: nPass }));
})().catch(e => { console.error('quiz fatal:', e.message); process.exit(1); });
