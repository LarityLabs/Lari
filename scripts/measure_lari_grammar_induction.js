#!/usr/bin/env node
'use strict';

/**
 * Run the grammar induction against the sealed prediction in
 * holdouts/grammar-induction-v1/prediction.json.
 *
 * Usage: node scripts/measure_lari_grammar_induction.js [--corpus <file>] [--json <out>]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const language = require(path.join(ROOT, 'swarm_language_rules.js'));

function parseArgs(argv) {
  const options = {
    corpus: path.join(ROOT, 'benchmarks', 'fixtures', 'english-corpus.txt'),
    lessons: null,
    ratio: false,
    json: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--corpus') { options.corpus = argv[i + 1]; i += 1; }
    else if (argv[i] === '--lessons') { options.lessons = argv[i + 1]; i += 1; }
    else if (argv[i] === '--ratio') { options.ratio = true; }
    else if (argv[i] === '--json') { options.json = argv[i + 1]; i += 1; }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sentences = fs.readFileSync(options.corpus, 'utf8').split(/\r?\n/).filter(Boolean);

  // Textbook examples are authored grammatical English in a register the documentation corpus does
  // not contain. v1's false constraint survived precisely because its counterexample never appeared.
  let textbookExamples = [];
  if (options.lessons) {
    const lessons = JSON.parse(fs.readFileSync(options.lessons, 'utf8')).lessons || [];
    textbookExamples = lessons.flatMap(lesson => lesson.examples.map(example => example.sentence));
    console.log(`textbook examples added to clean corpus: ${textbookExamples.length}\n`);
  }

  const result = language.induceConstraints([...sentences, ...textbookExamples], {
    useRatioOracle: options.ratio
  });

  console.log(JSON.stringify({ corpus: result.corpus, thresholds: result.thresholds }, null, 2));
  console.log(`\nproposed ${result.proposed} candidate constraints, retained ${result.retained.length}\n`);

  console.log('RETAINED');
  for (const item of result.retained) {
    console.log(`  ${item.id.padEnd(20)} clean/M ${String(item.cleanPerMillion).padStart(7)}  `
      + `fires on mutants ${String(item.attributableFirings).padStart(5)}   e.g. "${item.examples[0]}"`);
  }

  const attested = result.rejected.filter(item => item.rejectedBecause === 'attested in edited English')
    .sort((a, b) => b.cleanOccurrences - a.cleanOccurrences);
  console.log('\nREJECTED -- attested in edited English (top 10 by frequency)');
  for (const item of attested.slice(0, 10)) {
    console.log(`  ${item.id.padEnd(20)} clean ${String(item.cleanOccurrences).padStart(5)}  `
      + `clean/M ${String(item.cleanPerMillion).padStart(8)}   e.g. "${item.examples[0]}"`);
  }

  const vacuous = result.rejected.filter(item => item.rejectedBecause !== 'attested in edited English');
  console.log(`\nREJECTED -- vacuous (never fires even on seeded defects): ${vacuous.length}`);
  console.log(`  ${vacuous.slice(0, 8).map(item => item.id).join(', ')}${vacuous.length > 8 ? ', ...' : ''}`);

  if (options.json) {
    fs.writeFileSync(options.json, JSON.stringify(result, null, 2), 'utf8');
    console.log(`\nfull result written to ${options.json}`);
  }
}

main();
