// Proves live learning is retained: research once -> checkpoint to disk ->
// fresh load answers from memory without re-researching.
// Uses a COPY of the model (LARI_MODEL_PATH) so the production file is untouched.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PROD_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-checkpoint-test-'));
const TEST_MODEL = path.join(TEST_DIR, 'swarm-model.json');

fs.copyFileSync(PROD_MODEL, TEST_MODEL);
process.env.LARI_MODEL_PATH = TEST_MODEL;

const registry = require('./lari_model_registry.js');
const runtime = require('../swarm_model_runtime.js');

const SOURCES = [
  { title: 'Zorpblatt facts', url: 'https://example.test/zorpblatt', sourceType: 'test', text: 'A zorpblatt is a small fictional creature used in software testing examples. The zorpblatt is known for its bright blue spots and its habit of hiding in log files.' },
  { title: 'More zorpblatt', url: 'https://example.test/zorpblatt-2', sourceType: 'test', text: 'Zorpblatts are fictional test creatures. A zorpblatt has bright blue spots. Testers use the zorpblatt as a placeholder example.' }
];

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };

  // 1. Load, confirm the test topic is unknown.
  const loaded = registry.loadLariModel({});
  const model = loaded.model;
  const before = (model.lariLearnedRecords?.records || []).length;
  const probe = await runtime.sendMessageToLariAsync(model, 'what is a zorpblatt', {
    autoResearchOnUncertainty: false,
    groundedFactual: false
  });
  check('unknown topic is not answered from memory', !/blue spots/i.test(String(probe.answer || '')),
    `answer="${String(probe.answer || '').slice(0, 60)}"`);

  // 2. Ask with stub research sources -> should learn AND checkpoint to disk.
  const mtimeBefore = fs.statSync(TEST_MODEL).mtimeMs;
  const learned = await runtime.sendMessageToLariAsync(model, 'what is a zorpblatt', {
    research: { sourceProvider: () => SOURCES, sourceAdapter: 'knowledge.test_stub' }
  });
  const after = (model.lariLearnedRecords?.records || []).length;
  check('research learned a record in-process', after > before, `${before} -> ${after}`);
  check('checkpoint path reported on response', !!learned.learnedModelCheckpoint, learned.learnedModelCheckpoint || 'none');
  const mtimeAfter = fs.statSync(TEST_MODEL).mtimeMs;
  check('model file was rewritten', mtimeAfter > mtimeBefore);
  const backups = fs.readdirSync(TEST_DIR).filter(f => f.startsWith('swarm-model.backup-'));
  check('timestamped backup created', backups.length === 1, backups[0] || 'none');
  const onDisk = JSON.parse(fs.readFileSync(TEST_MODEL, 'utf8'));
  const diskRecords = (onDisk.lariLearnedRecords?.records || []).length;
  check('record persisted on disk', diskRecords === after, `${diskRecords} on disk vs ${after} in memory`);
  const newRec = (onDisk.lariLearnedRecords.records || []).find(r => /zorpblatt/i.test(JSON.stringify(r)));
  check('persisted record is about the learned topic', !!newRec, newRec ? newRec.id : 'not found');

  // 3. Fresh load from disk (simulates a new process) -> answers from memory, no research.
  const loaded2 = registry.loadLariModel({});
  const model2 = loaded2.model;
  const mtime2Before = fs.statSync(TEST_MODEL).mtimeMs;
  const recall = await runtime.sendMessageToLariAsync(model2, 'what is a zorpblatt', {
    autoResearchOnUncertainty: false,
    groundedFactual: false
  });
  check('fresh load answers from retained memory', /fictional creature/i.test(String(recall.answer || '')),
    `answer="${String(recall.answer || '').slice(0, 80)}"`);
  check('no research triggered on recall', !recall.autonomousResearch, recall.autonomousResearch ? 'research ran' : 'memory only');
  const mtime2After = fs.statSync(TEST_MODEL).mtimeMs;
  check('no spurious rewrite when nothing learned', mtime2After === mtime2Before && !recall.learnedModelCheckpoint);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
