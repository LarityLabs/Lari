#!/usr/bin/env node
'use strict';

/**
 * Fill the pantry with English: retain verified lexical facts Lari can answer from.
 *
 * Computational English holds 142,650 lexemes, 37 rules each scored on independent treebanks, and
 * inflectional paradigms drawn from human annotation. Lari has been consuming exactly none of it as
 * *knowledge* -- only as grammar for composing sentences. So Lari can now phrase things well and still
 * cannot answer "what is the plural of child", which it has the data to answer exactly.
 *
 * What a lexical fact is, and what it is not
 * -----------------------------------------
 * These are **faithful to CE**, not true by observation. That is a weaker guarantee than an execution
 * claim -- Lari ran the code for those; here it is repeating a curated resource -- and every entry
 * carries a `meaning` field saying so, in the same way retained research does. CE's own limits travel
 * with the fact: a paradigm it does not hold is absent rather than false, and absence is never stored
 * as evidence of impossibility (rule 12).
 *
 * Only facts CE actually attests are retained:
 *
 *   - an inflection is retained only if CE returns a form for it
 *   - a part-of-speech distribution is retained only where CE observed the word
 *   - countability is retained only in the positive direction, because CE reports `null` for unknown
 *     and reading that as "uncountable" produced 244,226 false claims once already
 *
 * CE remains data rather than a model, so this does not touch the VISION.md section 3 constraint.
 *
 * Usage:
 *   node scripts/fill_lari_knowledge_from_ce.js --model <path> [--apply] [--limit 400]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let ce = null;
try { ce = require('computational-english'); } catch (e) { ce = null; }

function parseArgs(argv) {
  const args = { model: null, apply: false, limit: 400 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--model') args.model = path.resolve(argv[++i]);
    else if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.model) throw new Error('--model is required');
  return args;
}

/**
 * The words to retain facts about.
 *
 * Ordinary vocabulary, chosen for coverage of the shapes that matter -- regular and irregular plurals,
 * ambiguous part-of-speech, mass nouns -- rather than for words that make the output look good.
 */
const VOCABULARY = [
  'child', 'person', 'book', 'dog', 'goose', 'mouse', 'woman', 'man', 'tooth', 'foot',
  'rule', 'family', 'city', 'story', 'box', 'church', 'knife', 'leaf', 'wife', 'half',
  'water', 'information', 'advice', 'furniture', 'music', 'rice', 'money', 'news',
  'run', 'walk', 'write', 'read', 'build', 'break', 'speak', 'take', 'give', 'know',
  'fast', 'quick', 'happy', 'large', 'small', 'good', 'bad', 'early', 'late', 'hard'
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply) {
    throw new Error('LARI_CANONICAL_LEARNED_RECORD_GATE: this legacy top-level knowledge writer is retired. Import facts through a non-promoted typed-record candidate instead.');
  }
  if (!ce) {
    console.error('computational-english is not installed. Nothing to retain.');
    process.exit(1);
  }

  const model = JSON.parse(fs.readFileSync(args.model, 'utf8'));
  model.knowledge = Array.isArray(model.knowledge) ? model.knowledge : [];
  const seen = new Set(model.knowledge.map(entry => `${entry.kind}|${entry.subject}|${entry.relation}`));

  const retained = [];
  const skipped = { unknownWord: 0, noParadigm: 0, duplicate: 0, unattested: 0 };

  const push = (subject, relation, value, detail) => {
    const key = `lexical_fact|${subject}|${relation}`;
    if (seen.has(key)) { skipped.duplicate += 1; return; }
    seen.add(key);
    retained.push({
      schemaVersion: 1,
      kind: 'lexical_fact',
      subject,
      relation,
      value: String(value),
      source: 'computational-english',
      ...detail,
      retainedAt: new Date().toISOString(),
      // Weaker than an execution claim, and said so on every entry.
      meaning: 'faithful to Computational English, a curated resource; not verified by observation'
    });
  };

  for (const word of VOCABULARY) {
    if (retained.length >= args.limit) break;
    const entry = ce.word(word);
    if (!entry) { skipped.unknownWord += 1; continue; }

    // Plural, only where CE attests a form.
    const plurals = ce.inflect(word, 'N;PL').map(form => form.form).filter(Boolean);
    if (plurals.length) push(word, 'plural', plurals[0], { alternatives: plurals.slice(1, 3) });
    else skipped.noParadigm += 1;

    // Dominant part of speech, only where observed.
    const pos = entry.pos && Object.entries(entry.pos).sort((a, b) => b[1] - a[1])[0];
    if (pos && pos[1] > 0) push(word, 'part of speech', pos[0], { share: Number(pos[1].toFixed(3)) });

    // Countability, positive direction only. CE returns null for unknown, and reading null as
    // "uncountable" is the inference that produced 244,226 false claims in about a second.
    const countable = entry.countability && entry.countability.countable;
    if (countable === true) push(word, 'countability', 'countable', {});
    else if (countable === null) skipped.unattested += 1;
  }

  console.log(`vocabulary probed : ${VOCABULARY.length}`);
  console.log(`facts retained    : ${retained.length}`);
  console.log(`skipped           : unknownWord=${skipped.unknownWord} noParadigm=${skipped.noParadigm} `
    + `unattested=${skipped.unattested} duplicate=${skipped.duplicate}`);
  console.log('\nsample:');
  for (const fact of retained.slice(0, 10)) {
    console.log(`   ${fact.subject} — ${fact.relation} — ${fact.value}`);
  }

  if (!args.apply) { console.log('\nDry run. Re-run with --apply to write the model.'); return; }
  model.knowledge = [...model.knowledge, ...retained];
  fs.writeFileSync(args.model, `${JSON.stringify(model, null, 2)}\n`);
  console.log(`\nwrote ${retained.length} fact(s). model.knowledge: ${model.knowledge.length}`);
}

try { main(); } catch (error) { console.error(String(error.message || error)); process.exit(1); }
