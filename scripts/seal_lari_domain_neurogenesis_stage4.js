#!/usr/bin/env node
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage4-20260830');
const PARENT_HASH = 'f7514dcba7aab9adabb5c36b834c64d405c10a4e1202169f92b2b891b449fa9e';
const PARENT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage3b-20260830', 'candidates', `${PARENT_HASH}.json`);
const sha = value => crypto.createHash('sha256').update(value).digest('hex'), shaFile = file => sha(fs.readFileSync(file));
const write = (name, value) => { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); fs.writeFileSync(path.join(OUT, name), bytes, { flag: 'wx' }); return { path: name, sha256: sha(bytes) }; };
function main() {
  if (fs.existsSync(OUT)) throw new Error('Stage 4 seal already exists.');
  if (shaFile(PARENT) !== PARENT_HASH) throw new Error('Stage 3 parent changed.');
  fs.mkdirSync(OUT, { recursive: false }); const createdAt = new Date().toISOString();
  const publicDevelopment = { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage4.public-development', createdAt, parentHash: PARENT_HASH, task: 'Repair the Python power_value function so it implements exponentiation and prove it with execution.', language: 'python', source: 'def power_value(base, exponent):\n    return base * exponent\n', tests: 'assert power_value(2, 5) == 32\nassert power_value(3, 4) == 81\nassert power_value(10, 0) == 1\n', researchPolicy: { queryTemplate: 'Research Python {concept} operator using authoritative documentation', onlineGroundedResearchRequired: true, minimumAuthoritativeSources: 2, userSuppliedSourcesAllowed: false, sourceProviderAllowed: false, externalModelCallsAllowed: false }, retentionPolicy: 'fail_before_pass_after_hidden_transfer_reload_ablation' };
  const hidden = { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage4.hidden-holdouts', createdAt, parentHash: PARENT_HASH, cases: [
    { id: 'repo.1', source: 'def raise_value(seed, steps):\n    return seed * steps\n', tests: 'assert raise_value(5, 3) == 125\nassert raise_value(2, 8) == 256\n' },
    { id: 'repo.2', source: 'def compute_growth(factor, generation):\n    result = factor * generation\n    return result\n', tests: 'assert compute_growth(4, 3) == 64\nassert compute_growth(7, 2) == 49\n' },
    { id: 'repo.3', source: 'def inverse_power(base, exponent):\n    return base * exponent\n', tests: 'assert inverse_power(4, -2) == 0.0625\nassert inverse_power(2, -3) == 0.125\n' },
    { id: 'repo.4', source: 'def square_measure(measure):\n    return measure * 2\n', tests: 'assert square_measure(9) == 81\nassert square_measure(12) == 144\n' }
  ] };
  const publicFile = write('public-development.json', publicDevelopment), hiddenFile = write('hidden-holdouts.json', hidden);
  write('sealed-index.json', { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage4.seal', createdAt, parentHash: PARENT_HASH, publicDevelopment: { ...publicFile, learnerReadable: true }, hiddenHoldouts: { ...hiddenFile, cases: hidden.cases.length, learnerReadable: false }, productionMutationAllowed: false, promotionAllowed: false });
  console.log(JSON.stringify({ passed: true, output: path.relative(ROOT, OUT).replace(/\\/g, '/'), parentHash: PARENT_HASH, publicHash: publicFile.sha256, hiddenHash: hiddenFile.sha256 }, null, 2));
}
main();
