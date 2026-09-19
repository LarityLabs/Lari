#!/usr/bin/env node
'use strict';

/**
 * A corpus of edited English, assembled from what is already on the machine.
 *
 * The grammar-rule lane needs text that is *edited* -- reviewed by more than one person, corrected
 * before publication -- because the whole method rests on treating "this never appears here" as
 * evidence that a construction is ungrammatical. Raw web text would break that: it contains the
 * errors the rules are supposed to catch.
 *
 * Python's standard library is a good local source and an unusual one. Its docstrings are prose,
 * written and reviewed by hundreds of contributors over three decades, and they are on disk already,
 * so nothing is downloaded and no external service sees anything. The register is narrow -- technical
 * documentation, imperative mood, few questions -- and that limitation is recorded with the corpus
 * rather than discovered later.
 *
 * Deliberately NOT used: this repository's own markdown. It is ~1.7 MB of edited English, but it has
 * one author, and inducing rules about English from the writing of the person the rules will be
 * applied for is circular.
 *
 * Usage: node scripts/build_lari_english_corpus.js [--source <dir>] [--out <file>] [--max-mb 12]
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const options = { source: 'C:\\Python313\\Lib', out: null, maxMb: 12, mode: 'python' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') { options.source = argv[i + 1]; i += 1; }
    else if (argv[i] === '--out') { options.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--max-mb') { options.maxMb = Number(argv[i + 1]); i += 1; }
    else if (argv[i] === '--mode') { options.mode = argv[i + 1]; i += 1; }
  }
  return options;
}

/**
 * Plain-prose extraction, for whole books rather than source files.
 *
 * The python-mode filter above rejects anything ending in '?' or containing quotation marks, which is
 * correct for docstrings and exactly wrong here. Interrogatives and dialogue are the reason these
 * books were fetched: v2 retained "a plural 'do' is not followed by a plural determiner" -- flagging
 * "Do these tests pass?" -- because 197k sentences of technical documentation contained almost no
 * questions, and absence in a corpus is indistinguishable from ungrammaticality.
 */
function proseSentences(text) {
  const start = text.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i);
  const end = text.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  const body = text.slice(start >= 0 ? text.indexOf('\n', start) + 1 : 0, end >= 0 ? end : text.length);

  // Rejoin hard-wrapped lines into paragraphs before splitting on sentence enders.
  const paragraphs = body.split(/\n\s*\n/);
  const kept = [];
  for (const paragraph of paragraphs) {
    const flat = paragraph.replace(/\s*\n\s*/g, ' ').trim();
    if (flat.length < 30) continue;
    if (/^[A-Z\s.,'-]+$/.test(flat)) continue;                    // chapter headings, all-caps
    if (/^(CHAPTER|VOLUME|BOOK|PART|Contents)\b/i.test(flat)) continue;
    for (const raw of flat.split(/(?<=[.?!])["']?\s+(?=[A-Z"'])/)) {
      const line = raw.trim();
      if (line.length < 25 || line.length > 300) continue;
      if (!/[.?!]["']?$/.test(line)) continue;
      if ((line.match(/\s+/g) || []).length < 4) continue;
      const letters = (line.match(/[A-Za-z ]/g) || []).length / line.length;
      if (letters < 0.82) continue;                                // looser: prose carries punctuation
      if (/\d/.test(line)) continue;
      kept.push(line);
    }
  }
  return kept;
}

/** Walk a tree for .py files, skipping test trees whose prose is mostly fixtures and assertions. */
function pythonFiles(root, limit = 4000) {
  const found = [];
  const stack = [root];
  while (stack.length && found.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^(test|tests|__pycache__|site-packages|idle_test)$/i.test(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        found.push(full);
      }
    }
  }
  return found;
}

/**
 * Pull prose out of a Python source file: triple-quoted docstrings and full-line `#` comments.
 *
 * Inline comments after code are skipped -- they are usually fragments ("# fallthrough") rather than
 * sentences, and fragments would pollute a corpus whose entire purpose is showing which word
 * sequences well-formed English permits.
 */
function extractProse(source) {
  const chunks = [];
  const docstring = /(?:"""|''')([\s\S]*?)(?:"""|''')/g;
  let match;
  while ((match = docstring.exec(source)) !== null) chunks.push(match[1]);
  for (const line of source.split(/\r?\n/)) {
    const comment = line.match(/^\s*#\s?(.*)$/);
    if (comment && comment[1].trim().length > 0) chunks.push(comment[1]);
  }
  return chunks.join('\n');
}

/**
 * Keep sentence-like lines and drop everything that only looks like prose.
 *
 * Code samples inside docstrings are the main contaminant: `>>> foo(bar)` is not English and would
 * teach the induction nonsense about which word pairs occur.
 */
function sentences(text) {
  const kept = [];
  for (const raw of String(text).split(/\n/)) {
    const line = raw.trim();
    if (line.length < 25 || line.length > 400) continue;
    if (/^(>>>|\.\.\.|\$|#!|:param|:return|:rtype|@|\||\+--)/.test(line)) continue;
    if (/[{}<>\\]|::|__|\(\)|=>|\S+\(/.test(line)) continue;      // code-ish
    const letters = (line.match(/[A-Za-z ]/g) || []).length / line.length;
    if (letters < 0.88) continue;
    if (!/\s/.test(line)) continue;
    if ((line.match(/\s+/g) || []).length < 4) continue;
    kept.push(line);
  }
  return kept;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const out = options.out || path.join(__dirname, '..', 'benchmarks', 'fixtures', 'english-corpus.txt');
  if (!fs.existsSync(options.source)) {
    process.stderr.write(`source not found: ${options.source}\n`);
    process.exit(2);
  }

  const prose = options.mode === 'prose';
  const files = prose
    ? fs.readdirSync(options.source).filter(name => name.endsWith('.txt'))
      .map(name => path.join(options.source, name))
    : pythonFiles(options.source);
  const lines = [];
  let bytes = 0;
  const cap = options.maxMb * 1024 * 1024;
  for (const file of files) {
    if (bytes >= cap) break;
    let source = '';
    try { source = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of (prose ? proseSentences(source) : sentences(extractProse(source)))) {
      lines.push(line);
      bytes += line.length + 1;
      if (bytes >= cap) break;
    }
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  const words = lines.join(' ').split(/\s+/).filter(Boolean).length;
  console.log(JSON.stringify({
    source: options.source,
    filesScanned: files.length,
    sentences: lines.length,
    words,
    bytes,
    out: path.relative(path.join(__dirname, '..'), out).replace(/\\/g, '/'),
    register: prose
      ? 'literary and expository prose; narrative, dialogue and interrogatives present'
      : 'technical documentation; narrow register, few questions, imperative-heavy',
    excluded: "this repository's own markdown (single author, circular)"
  }, null, 2));
}

main();
