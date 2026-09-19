#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const operation = process.argv[2];
const candidatePath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const registry = require('./lari_model_registry.js');
const candidateProvenance = process.env.LARI_REHEARSAL_CANDIDATE_PROVENANCE
  || (candidatePath ? path.relative(registry.root, candidatePath).replace(/\\/g, '/') : null);

function sha256(filePath) {
  return filePath && fs.existsSync(filePath)
    ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    : null;
}

function state() {
  return {
    currentHash: sha256(registry.currentModelPath),
    registryHash: sha256(registry.registryPath),
    currentPath: registry.currentModelPath,
    registryPath: registry.registryPath,
    registry: registry.readLariModelRegistry(),
    temporaryFiles: fs.existsSync(path.dirname(registry.currentModelPath))
      ? fs.readdirSync(path.dirname(registry.currentModelPath)).filter(name => name.endsWith('.tmp'))
      : []
  };
}

async function main() {
  const before = state();
  if (operation === 'promote') {
    const promoted = registry.promoteLariModel(candidatePath, {
      reason: 'Consolidation Stage 3 isolated promotion rehearsal',
      candidateSha256: sha256(candidatePath),
      candidateProvenance,
      rehearsal: true
    });
    return { operation, before, promoted, after: state() };
  }
  if (operation === 'rollback') {
    const promoted = registry.promoteLariModel(candidatePath, {
      reason: 'Consolidation Stage 3 rollback setup',
      candidateSha256: sha256(candidatePath),
      candidateProvenance,
      rehearsal: true
    });
    const rollbackTarget = path.resolve(registry.root, promoted.previousModelPath);
    const rollbackTargetHash = sha256(rollbackTarget);
    const rolledBack = registry.promoteLariModel(rollbackTarget, {
      reason: 'Consolidation Stage 3 exact rollback rehearsal',
      rollback: true,
      rollbackTarget: promoted.previousModelPath,
      rollbackTargetSha256: rollbackTargetHash,
      rehearsal: true
    });
    return { operation, before, promoted, rollbackTarget, rollbackTargetHash, rolledBack, after: state() };
  }
  if (operation === 'interrupt-current' || operation === 'interrupt-registry') {
    process.env.LARI_ATOMIC_WRITE_FAIL_BEFORE_RENAME = operation === 'interrupt-current' ? 'swarm-model.json' : 'registry.json';
    let error = null;
    try {
      registry.promoteLariModel(candidatePath, { reason: `Stage 3 ${operation}`, rehearsal: true });
    } catch (caught) {
      error = { message: caught.message, code: caught.code || null };
    }
    return { operation, before, error, after: state() };
  }
  if (operation === 'corrupt') {
    let error = null;
    try {
      registry.promoteLariModel(candidatePath, { reason: 'Stage 3 corrupt-candidate rejection', rehearsal: true });
    } catch (caught) {
      error = { message: caught.message, code: caught.code || null };
    }
    return { operation, before, error, after: state() };
  }
  if (operation === 'resolve') {
    const loaded = registry.loadLariModel();
    return {
      operation,
      before,
      resolved: loaded.resolved,
      modelId: loaded.model.modelId,
      candidateList: registry.listLariModelCandidates().map(item => ({ id: item.id, exists: item.exists, relativePath: item.relativePath })),
      after: state()
    };
  }
  if (operation === 'inference' || operation === 'autonomous') {
    const runtime = require('../swarm_model_runtime.js');
    const loaded = registry.loadLariModel();
    const modelHash = sha256(loaded.resolved.path);
    const prompt = process.argv.slice(3).join(' ') || 'For a chat request, classify family and select the verified reusable procedure.';
    const context = {
      modelHash,
      autoGrow: false,
      userScope: process.env.LARI_USER_SCOPE || process.env.LARI_USER || 'local.default',
      kernel: {
        useBenchmarkSystem: false,
        useCapabilityGraph: true,
        capabilityGraph: { minScore: 0 },
        chat: { minMemoryScore: 0, minRouteScore: 0 }
      }
    };
    const response = operation === 'autonomous'
      ? await runtime.runLariAutonomousRequest(loaded.model, prompt, { mode: 'chat', modelHash, userScope: context.userScope })
      : runtime.sendMessageToLari(loaded.model, prompt, context);
    return {
      operation,
      before,
      resolved: loaded.resolved,
      selection: response.capabilitySelection || null,
      learnedRecordIds: response.learnedRecordIds || [],
      modelHash: response.modelHash || modelHash,
      answer: response.answer || response.output_text || '',
      action: response.action || null,
      publicAnswerSource: response.publicAnswerSource || null,
      passed: response.passed === true,
      external_model_calls: Number(response.external_model_calls || 0),
      after: state()
    };
  }
  throw new Error(`Unknown Stage 3 worker operation: ${operation}`);
}

main().then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(error => {
  process.stdout.write(`${JSON.stringify({ operation, fatal: { message: error.message, stack: error.stack } })}\n`);
  process.exit(1);
});
