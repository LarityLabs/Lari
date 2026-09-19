// Write a small, committable record of what each preserved model knows.
//
// The models themselves are 32 MB each and are derived state, so they stay out of git. What must not
// be lost is the inventory: which rules were learned, and what the priors were measured over. Without
// this, "the trained model has honest priors" is a claim with nothing behind it.
const fs = require('fs');
const path = require('path');
const runtime = require('C:/Users/goryg/.gemini/antigravity/scratch/html-agent-swarm/swarm_model_runtime.js');

const dir = process.argv[2];
const out = process.argv[3];

const describe = (file) => {
  const model = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const vocab = runtime.lariMutationVocabulary(model) || {};
  // A rule is an array like [" + ", " - "], not an object. Reading `.description` off it yielded null
  // for all 77 rules while the counts stayed correct, so the first inventory looked right and recorded
  // nothing. Render arrays as "from -> to" and keep an object's own label if it ever has one.
  const describe = rule => {
    if (Array.isArray(rule)) return rule.map(part => (String(part).trim() || '(nothing)')).join(' -> ');
    return rule.description || rule.id || JSON.stringify(rule);
  };
  const families = {};
  for (const [family, entry] of Object.entries(vocab)) {
    families[family] = (entry.rules || []).map(describe);
  }
  const priors = {};
  for (const record of (model.lariLearnedRecords?.records || [])) {
    if (!String(record?.id || '').startsWith('lari.learned.operator.mutation_search.')) continue;
    const p = record.payload || {};
    priors[p.family || record.id] = {
      attempts: p.attempts,
      successes: p.successes,
      rate: p.attempts ? Number((p.successes / p.attempts).toFixed(5)) : null,
      mutationsTracked: Object.keys(p.mutations || {}).length,
    };
  }
  const ruleCount = Object.values(families).reduce((n, r) => n + r.length, 0);
  const attempts = Object.values(priors).reduce((n, p) => n + (p.attempts || 0), 0);
  return {
    file,
    bytes: fs.statSync(path.join(dir, file)).size,
    sha256: require('crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex'),
    familyCount: Object.keys(families).length,
    ruleCount,
    priorAttemptsTotal: attempts,
    families,
    priors,
  };
};

const models = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== path.basename(out)).sort();
const inventory = {
  schemaVersion: 1,
  kind: 'lari.trained-model.inventory',
  writtenAt: new Date().toISOString().slice(0, 10),
  why: 'These models were produced by the growth curriculum and existed only under %TEMP%, where a '
     + 'cleanup would have destroyed them. In a project whose thesis is that the state is the model, '
     + 'the learned state is the asset. The blobs are gitignored (32 MB each, derived); this inventory '
     + 'is committed so the claims about them remain checkable.',
  models: models.map(describe),
};

// A learned rule is one the seed does not have. Compute it rather than asserting it.
const seed = inventory.models.find(m => /seed/.test(m.file));
if (seed) {
  const seedSet = new Set(Object.entries(seed.families).flatMap(([f, rs]) => rs.map(r => `${f} | ${r}`)));
  for (const m of inventory.models) {
    if (m === seed) continue;
    m.learnedBeyondSeed = Object.entries(m.families)
      .flatMap(([f, rs]) => rs.map(r => `${f} | ${r}`))
      .filter(k => !seedSet.has(k))
      .sort();
  }
}

fs.writeFileSync(out, JSON.stringify(inventory, null, 2) + '\n');
console.log(`wrote ${out}`);
for (const m of inventory.models) {
  console.log(`  ${m.file.padEnd(32)} families=${m.familyCount} rules=${m.ruleCount} `
    + `learned=${m.learnedBeyondSeed ? m.learnedBeyondSeed.length : 0} priorAttempts=${m.priorAttemptsTotal}`);
}
