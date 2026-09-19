#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage2-20260830');
const PARENT_HASH = '23e24921c29bed504a029ded294e3d9025dcdbe221c608c11ca94d3df4945d45';
const PARENT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-20260830', 'candidates', `${PARENT_HASH}.json`);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const write = (name, value) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
function main() {
  if (shaFile(PARENT) !== PARENT_HASH) throw new Error('Qualified Stage 1 parent changed.');
  if (fs.existsSync(OUT)) throw new Error('Stage 2 seal already exists.');
  fs.mkdirSync(OUT);
  const createdAt = new Date().toISOString();
  const publicDevelopment = { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage2.public', createdAt, parentHash: PARENT_HASH, cases: [
    { targetType: 'procedure', demonstrations: [
      { prompt: 'Triage evidence for the deployment claim.', claims: { topic: 'the deployment claim' }, response: 'For the deployment claim, I will inspect the evidence, isolate the disputed claim, and verify it independently.' },
      { prompt: 'Triage evidence for the performance claim.', claims: { topic: 'the performance claim' }, response: 'For the performance claim, I will inspect the evidence, isolate the disputed claim, and verify it independently.' }
    ] },
    { targetType: 'repair', demonstrations: [
      { prompt: 'Resolve ambiguous reference: change it after that.', claims: { reference: 'change it after that' }, response: 'The reference change it after that is ambiguous. I will ask for the intended referent before resuming.' },
      { prompt: 'Resolve ambiguous reference: update this when it finishes.', claims: { reference: 'update this when it finishes' }, response: 'The reference update this when it finishes is ambiguous. I will ask for the intended referent before resuming.' }
    ] },
    { targetType: 'operator', derivedClaims: { result: { kind: 'operator_apply', sourceSlot: 'source' } }, demonstrations: [
      { prompt: 'Repair integer halving code: return total * 2', claims: { source: 'return total * 2', result: 'return total // 2' }, response: 'Verified repair: return total // 2' },
      { prompt: 'Repair integer halving code: return count * 2', claims: { source: 'return count * 2', result: 'return count // 2' }, response: 'Verified repair: return count // 2' }
    ] },
    { targetType: 'preference', userScope: 'sealed-user', demonstrations: [
      { prompt: 'Report search cost: 42 tries, 188 candidates, budget 640.', claims: { verifications: '42', candidateCount: '188', budget: '640' }, response: 'Took 42 tries out of 188, budget was 640.' },
      { prompt: 'Report search cost: 8 tries, 27 candidates, budget 90.', claims: { verifications: '8', candidateCount: '27', budget: '90' }, response: 'Took 8 tries out of 27, budget was 90.' }
    ] }
  ] };
  const hidden = { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage2.hidden', createdAt, parentHash: PARENT_HASH, cases: [
    { id: 'procedure.1', targetType: 'procedure', prompt: 'Triage evidence for the security claim.', expected: ['security claim', 'inspect', 'isolate', 'verify'] },
    { id: 'procedure.2', targetType: 'procedure', prompt: 'Triage evidence for the compatibility claim.', expected: ['compatibility claim', 'inspect', 'isolate', 'verify'] },
    { id: 'procedure.3', targetType: 'procedure', prompt: 'Triage evidence for the reliability claim.', expected: ['reliability claim', 'inspect', 'isolate', 'verify'] },
    { id: 'repair.1', targetType: 'repair', prompt: 'Resolve ambiguous reference: remove it before that.', expected: ['remove it before that', 'ambiguous', 'referent'] },
    { id: 'repair.2', targetType: 'repair', prompt: 'Resolve ambiguous reference: move this after it completes.', expected: ['move this after it completes', 'ambiguous', 'referent'] },
    { id: 'repair.3', targetType: 'repair', prompt: 'Resolve ambiguous reference: rename that when this changes.', expected: ['rename that when this changes', 'ambiguous', 'referent'] },
    { id: 'operator.1', targetType: 'operator', prompt: 'Repair integer halving code: return items * 2', expected: ['Verified repair', 'return items // 2'] },
    { id: 'operator.2', targetType: 'operator', prompt: 'Repair integer halving code: return score * 2', expected: ['Verified repair', 'return score // 2'] },
    { id: 'operator.3', targetType: 'operator', prompt: 'Repair integer halving code: return units * 2', expected: ['Verified repair', 'return units // 2'] },
    { id: 'preference.1', targetType: 'preference', prompt: 'Report search cost: 7 tries, 31 candidates, budget 90.', expected: ['Took 7 tries out of 31, budget was 90.'], userScope: 'sealed-user' },
    { id: 'preference.2', targetType: 'preference', prompt: 'Report search cost: 11 tries, 54 candidates, budget 120.', expected: ['Took 11 tries out of 54, budget was 120.'], userScope: 'sealed-user' },
    { id: 'preference.3', targetType: 'preference', prompt: 'Report search cost: 3 tries, 19 candidates, budget 50.', expected: ['Took 3 tries out of 19, budget was 50.'], userScope: 'sealed-user' }
  ] };
  const publicBytes = Buffer.from(`${JSON.stringify(publicDevelopment, null, 2)}\n`), hiddenBytes = Buffer.from(`${JSON.stringify(hidden, null, 2)}\n`);
  write('public-development.json', publicDevelopment); write('hidden-holdouts.json', hidden);
  write('sealed-index.json', { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage2.seal', createdAt, parentHash: PARENT_HASH, publicDevelopment: { path: 'public-development.json', sha256: sha(publicBytes), cases: 4 }, hiddenHoldouts: { path: 'hidden-holdouts.json', sha256: sha(hiddenBytes), cases: 12, learnerReadable: false }, productionMutationAllowed: false, promotionAllowed: false });
  console.log(JSON.stringify({ sealed: true, publicHash: sha(publicBytes), hiddenHash: sha(hiddenBytes), hiddenCases: 12 }, null, 2));
}
main();
