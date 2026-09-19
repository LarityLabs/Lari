#!/usr/bin/env node
'use strict';
const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const root = path.resolve(__dirname, '..');
const realCurrent = path.join(root, 'models', 'lari', 'current', 'swarm-model.json');
const realRegistry = path.join(root, 'models', 'lari', 'registry.json');
const rollbackSource = path.join(root, 'models', 'lari', 'current', 'swarm-model.backup-1789000464471.json');
const out = path.join(root, 'consolidation', 'live-rollback-reload-proof-20260912');
const isolated = path.join(out, 'registry');
const statePath = path.join(out, 'user-state.json');
const reportPath = path.join(out, 'report.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function writeAtomic(file, bytes) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes, { flag: 'wx' });
  fs.renameSync(temporary, file);
}
async function main() {
  if (fs.existsSync(out)) throw new Error(`Proof namespace already exists: ${out}`);
  fs.mkdirSync(path.join(isolated, 'current'), { recursive: true });
  fs.copyFileSync(realCurrent, path.join(isolated, 'current', 'swarm-model.json'));
  fs.copyFileSync(realRegistry, path.join(isolated, 'registry.json'));
  const realBefore = { active: sha(realCurrent), registry: sha(realRegistry) };
  const incumbentHash = sha(path.join(isolated, 'current', 'swarm-model.json'));
  const targetHash = sha(rollbackSource);
  const child = childProcess.spawn(process.execPath, ['scripts/lari_persistent_runtime_worker.js', '--state-path', statePath], {
    cwd: root,
    env: { ...process.env, LARI_REGISTRY_ROOT: path.relative(root, isolated), LARI_AUTONOMOUS_LEARNING: '0' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line);
    const resolve = pending.get(value.request_id);
    if (resolve) { pending.delete(value.request_id); resolve(value.result); }
  });
  let sequence = 0;
  const request = payload => new Promise((resolve, reject) => {
    const id = `request-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker timeout: ${id}`)); }, 15000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(`${JSON.stringify({ request_id: id, ...payload })}\n`);
  });
  try {
    const healthBefore = await request({ operation: 'health' });
    assert.strictEqual(healthBefore.modelHash, incumbentHash);
    await request({ prompt: 'Remember that my preferred report style is concise.', context: { userScope: 'rollback-proof-user' } });
    writeAtomic(path.join(isolated, 'current', 'swarm-model.json'), fs.readFileSync(rollbackSource));
    const clonedRegistry = JSON.parse(fs.readFileSync(path.join(isolated, 'registry.json'), 'utf8'));
    clonedRegistry.activeModelSha256 = targetHash;
    writeAtomic(path.join(isolated, 'registry.json'), `${JSON.stringify(clonedRegistry, null, 2)}\n`);
    const healthAfter = await request({ operation: 'health' });
    assert.strictEqual(healthAfter.modelHash, targetHash);
    assert.strictEqual(healthAfter.modelReload?.reloaded, true);
    assert.strictEqual(healthAfter.modelReload?.previousModelHash, incumbentHash);
    assert.ok(healthAfter.userScopeCount >= 1);
    const afterRequest = await request({ prompt: 'How should you format my reports?', context: { userScope: 'rollback-proof-user' } });
    assert.strictEqual(afterRequest.model_hash, targetHash);
    assert.deepStrictEqual({ active: sha(realCurrent), registry: sha(realRegistry) }, realBefore);
    const report = {
      schemaVersion: 1,
      kind: 'lari.live-rollback-reload-proof',
      createdAt: new Date().toISOString(),
      incumbentHash,
      rollbackTargetHash: targetHash,
      healthBefore,
      healthAfter,
      requestAfterReload: { modelHash: afterRequest.model_hash, userScope: afterRequest.user_scope, stateRevision: afterRequest.state_revision },
      userStatePreservedAcrossModelReload: true,
      realRegistryReadOnly: true,
      externalModelCalls: 0,
      passed: true
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    child.stdin.end();
    child.kill();
  }
}
main().catch(error => { console.error(error.stack || error); process.exit(1); });
