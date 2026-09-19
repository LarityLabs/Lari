#!/usr/bin/env node
'use strict';

/**
 * Pulling teachable structure out of a grammar textbook.
 *
 * The first attempt at this lane hardcoded word classes and brute-forced all 64 pairs, which meant no
 * textbook was involved anywhere. That was the wrong shape: a corpus can tell you whether a rule
 * holds, but it cannot tell you which rule to consider, and enumerating every combination is a
 * confession that nothing suggested one.
 *
 * The premise going in was that grammar texts are full of marked correct/incorrect pairs. For
 * Kittredge that is simply false -- 2 instances of "Wrong:" in 724 KB. It is a descriptive grammar,
 * not a usage corrector. What it does have, in volume, is better:
 *
 *   +14.+ +A verb is a word which can assert something...+     <- numbered, delimited rule statement
 *
 *     The wind _blows_.                                        <- example, focus word in italics
 *     The horses _ran_.
 *
 * The italics are the reason this is worth more than error pairs. They mark *which word the rule is
 * about*. Version 1's mutation operator had no such information, so it swapped a complementizer
 * ("note that these methods" -> "note those these methods"), manufactured a category error, and the
 * induction retained a false constraint on the strength of it. Mutating only the marked token cannot
 * make that mistake: the grammarian has already said which word carries the rule.
 *
 * So each lesson yields:
 *   - a rule statement (identifiable, not yet understandable -- kept for provenance and for a human)
 *   - example sentences asserted grammatical on the authority of the author
 *   - the exact token each example is illustrating
 *
 * The examples are also a second register. The verification corpus is technical documentation, where
 * "both these" appears zero times in 330k tokens and therefore looked forbidden. "Near the church
 * stood an elm" is not from that world, and a lane whose weakness is narrow register should not be
 * fed one narrow register.
 *
 * Usage: node scripts/extract_lari_grammar_lessons.js --text <file> [--json <out>]
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const options = { text: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--text') { options.text = argv[i + 1]; i += 1; }
    else if (argv[i] === '--json') { options.json = argv[i + 1]; i += 1; }
  }
  return options;
}

/** Strip Gutenberg's licence header and footer so boilerplate is not mined as grammar. */
function stripBoilerplate(text) {
  const start = text.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i);
  const end = text.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  return text.slice(start >= 0 ? text.indexOf('\n', start) + 1 : 0, end >= 0 ? end : text.length);
}

/**
 * A rule statement: `+N.+` section number, then bold `+...+` spans carrying the rule.
 *
 * Kittredge bolds the statement itself and leaves discussion in plain text, so the bold spans are the
 * claim and the rest is commentary.
 */
const SECTION = /^\+(\d+)\.\+\s*(.*)$/;

/** An example line: indented, ends like a sentence, and contains at least one _italic_ span. */
const ITALIC = /_([^_]+)_/g;

function extractLessons(raw) {
  const text = stripBoilerplate(raw);
  const lines = text.split(/\r?\n/);
  const lessons = [];
  let current = null;
  let pendingStatement = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const section = line.match(SECTION);

    if (section) {
      if (current && current.examples.length) lessons.push(current);
      current = { section: Number(section[1]), statement: '', examples: [] };
      pendingStatement = [];
      // The statement may run over several lines; collect bold spans until a blank line.
      let j = i;
      let buffer = section[2];
      while (j + 1 < lines.length && lines[j + 1].trim() !== '') {
        j += 1;
        buffer += ' ' + lines[j];
      }
      const bold = buffer.match(/\+([^+]+)\+/g) || [];
      pendingStatement = bold.map(span => span.replace(/^\+|\+$/g, '').trim());
      current.statement = pendingStatement.join(' ').replace(/\s+/g, ' ').trim()
        || buffer.replace(/[+_]/g, '').replace(/\s+/g, ' ').trim();
      continue;
    }

    if (!current) continue;

    const trimmed = line.trim();
    if (!/^\s{2,}\S/.test(line)) continue;                 // examples are indented
    if (trimmed.length < 8 || trimmed.length > 200) continue;
    if (!/[.?!]$/.test(trimmed)) continue;                 // whole sentences only
    if (/^\+|\[\d+\]|^[A-Z][A-Z\s]+$/.test(trimmed)) continue;

    const focuses = [];
    let match;
    ITALIC.lastIndex = 0;
    while ((match = ITALIC.exec(trimmed)) !== null) {
      const token = match[1].trim();
      if (/^[A-Za-z][A-Za-z' -]*$/.test(token)) focuses.push(token);
    }
    if (focuses.length === 0) continue;

    const sentence = trimmed.replace(/[_+]/g, '');
    if (/\d/.test(sentence)) continue;
    current.examples.push({ sentence, focus: focuses });
  }
  if (current && current.examples.length) lessons.push(current);
  return lessons;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.text) { process.stderr.write('--text is required\n'); process.exit(2); }
  const raw = fs.readFileSync(options.text, 'utf8');
  const lessons = extractLessons(raw);

  const exampleCount = lessons.reduce((sum, lesson) => sum + lesson.examples.length, 0);
  const focusCount = lessons.reduce((sum, lesson) =>
    sum + lesson.examples.reduce((inner, example) => inner + example.focus.length, 0), 0);

  console.log(JSON.stringify({
    source: path.basename(options.text),
    lessons: lessons.length,
    examples: exampleCount,
    markedFocusTokens: focusCount,
    medianExamplesPerLesson: (() => {
      const counts = lessons.map(l => l.examples.length).sort((a, b) => a - b);
      return counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    })()
  }, null, 2));

  console.log('\nsample lessons:');
  for (const lesson of lessons.slice(2, 5)) {
    console.log(`\n  [${lesson.section}] ${lesson.statement.slice(0, 100)}`);
    for (const example of lesson.examples.slice(0, 3)) {
      console.log(`      "${example.sentence}"   focus: ${example.focus.join(', ')}`);
    }
  }

  if (options.json) {
    fs.mkdirSync(path.dirname(path.resolve(options.json)), { recursive: true });
    fs.writeFileSync(options.json, JSON.stringify({ source: options.text, lessons }, null, 2), 'utf8');
    console.log(`\nwritten to ${options.json}`);
  }
}

main();
