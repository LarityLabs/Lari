// Merge qualified semantic-operator records from scratch test state into the live model.
// Approved by Greg 2026-09-22: merge only what works and improves the model.
// - Only records with status === 'active' (all passed the 7-gate protocol).
// - Deduped by record id.
// - Live model backed up before write.
// - entries written as an ARRAY (canonical form per lari_semantic_induction.js ensureSection).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const SCRATCH = '/home/hatch/workspace/scratch';

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function entriesOf(section) {
  if (!section || !section.entries) return [];
  return Array.isArray(section.entries) ? section.entries : Object.values(section.entries);
}

const sources = [
  path.join(SCRATCH, 'lari-semantic-induction', 'model-shared-10036-1790079656240.json'),
  ...['than', 'admittedly', 'after', 'before', 'prevented'].map(n =>
    path.join(SCRATCH, 'lari-construction-discovery', `cold-disc_${n}.json`)),
  ...['admittedly', 'hence', 'nevertheless', 'prevented'].map(n =>
    path.join(SCRATCH, 'lari-semantic-research', `cold-disc_${n}.json`)),
];

const seen = new Map();
for (const src of sources) {
  if (!fs.existsSync(src)) { console.log('MISSING (skipped):', src); continue; }
  const model = readJson(src);
  const recs = entriesOf(model.learned_semantic_operators).filter(r => r && r.status === 'active' && r.id);
  for (const r of recs) {
    if (!seen.has(r.id)) seen.set(r.id, { record: r, from: path.basename(src) });
  }
  console.log(`collected ${recs.length} active from ${path.basename(src)}`);
}

const records = [...seen.values()];
console.log(`\nunique active records: ${records.length}`);
for (const { record, from } of records) {
  const rel = record.payload && record.payload.operatorAst ? record.payload.operatorAst.relation : '?';
  console.log(`  - ${record.id}  relation=${rel}  from=${from}`);
}

// Backup live model
const live = readJson(LIVE);
const backupPath = LIVE + `.backup-merge-${Date.now()}.json`;
fs.writeFileSync(backupPath, JSON.stringify(live, null, 1));
console.log('\nlive model backed up to:', path.basename(backupPath));

// Build / merge section (canonical array form)
if (!live.learned_semantic_operators || typeof live.learned_semantic_operators !== 'object') {
  live.learned_semantic_operators = { schemaVersion: 1, entries: [], pending: {}, quarantined: [], stats: {} };
}
const section = live.learned_semantic_operators;
if (!Array.isArray(section.entries)) section.entries = [];
const existingIds = new Set(section.entries.filter(e => e && e.id).map(e => e.id));
let added = 0;
for (const { record } of records) {
  if (existingIds.has(record.id)) continue;
  section.entries.push(record);
  existingIds.add(record.id);
  added++;
}
section.schemaVersion = 1;
fs.writeFileSync(LIVE, JSON.stringify(live, null, 1));
console.log(`merged ${added} new records into live model (total entries: ${section.entries.length})`);
console.log('DONE');
