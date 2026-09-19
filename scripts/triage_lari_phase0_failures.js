// Triage the 85 failures by error signature, and emit the gate list for the passers.
const fs = require('fs');
const ROOT = 'C:/Users/goryg/.gemini/antigravity/scratch/html-agent-swarm';
const survey = JSON.parse(fs.readFileSync(`${ROOT}/holdouts/PHASE0_SURVEY.json`, 'utf8'));
const rows = Object.entries(survey.results);

const CATEGORIES = [
  ['missing-file-or-module', /Cannot find module|ENOENT|no such file/i],
  ['stale-api', /is not a function|undefined is not|Cannot read propert/i],
  ['assertion', /AssertionError|expected|assert/i],
  ['harness-invalid', /INVALID|Unsupported|must declare|requires at least/i],
  ['json-parse', /Unexpected token|JSON/i],
  ['python-or-tooling', /python|pytest|spawn|EPERM|EACCES/i]
];

const failures = rows.filter(([, r]) => r.outcome === 'fail');
const buckets = {};
for (const [file, r] of failures) {
  const tail = String(r.tail || '');
  const cat = (CATEGORIES.find(([, re]) => re.test(tail)) || ['uncategorised'])[0];
  (buckets[cat] = buckets[cat] || []).push({ file, entryPoint: r.entryPoint, tail: tail.slice(0, 90) });
}

console.log('=== 85 failures, by signature ===');
for (const [cat, list] of Object.entries(buckets).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${cat}: ${list.length}`);
  for (const x of list.slice(0, 3)) console.log(`    ${x.file}\n        ${x.tail}`);
  if (list.length > 3) console.log(`    ... and ${list.length - 3} more`);
}

// The gate list: everything that passed, so it cannot silently rot again.
const passing = rows.filter(([, r]) => r.outcome === 'pass').map(([f]) => f).sort();
fs.writeFileSync(`${ROOT}/holdouts/PHASE0_GATE_LIST.json`, JSON.stringify({
  schemaVersion: 1,
  kind: 'lari.phase0.gate-list',
  generatedAt: new Date().toISOString().slice(0, 10),
  why: 'Every benchmark observed passing in the Phase 0 survey. Gating these stops them rotting '
     + 'unnoticed, which is how 85 came to be broken with nobody knowing.',
  note: 'A passing benchmark whose entryPoint is runtime-internals proves a function works, not that '
      + 'the product does. The counts are kept apart deliberately.',
  count: passing.length,
  askLariCount: rows.filter(([, r]) => r.outcome === 'pass' && (r.entryPoint === 'asks-lari' || r.entryPoint === 'unified-kernel')).length,
  benchmarks: passing
}, null, 2) + '\n');
console.log(`\n=== gate list: ${passing.length} passing benchmarks -> holdouts/PHASE0_GATE_LIST.json`);
