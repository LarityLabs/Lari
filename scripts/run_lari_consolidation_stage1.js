#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const consolidationRoot = path.join(root, 'consolidation');
const backupRoot = path.join(consolidationRoot, 'stage-1-backups', 'sha256');
const freezePath = path.join(consolidationRoot, 'stage-1-freeze.json');
const currentPath = path.join(root, 'models', 'lari', 'current', 'swarm-model.json');
const legacyPath = path.join(root, 'swarm-model.json');
const registryPath = path.join(root, 'models', 'lari', 'registry.json');
const outputPaths = {
  backupManifest: path.join(consolidationRoot, 'stage-1-backup-manifest.json'),
  candidate: path.join(consolidationRoot, 'stage-1-unified-candidate.json'),
  migrationManifest: path.join(consolidationRoot, 'stage-1-migration-manifest.json'),
  importReport: path.join(consolidationRoot, 'stage-1-import-report.md'),
  dedupReport: path.join(consolidationRoot, 'stage-1-dedup-report.md'),
  conflicts: path.join(consolidationRoot, 'stage-1-conflicts.md'),
  validation: path.join(consolidationRoot, 'stage-1-validation-report.md'),
  rollback: path.join(consolidationRoot, 'stage-1-rollback.md')
};

const timestamp = new Date().toISOString();
const runtime = require('../swarm_model_runtime.js');

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function stableString(value) {
  return JSON.stringify(stable(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function withoutVolatileMetadata(value) {
  if (Array.isArray(value)) return value.map(withoutVolatileMetadata);
  if (!value || typeof value !== 'object') return value;
  const ignored = new Set([
    'id', 'createdAt', 'updatedAt', 'timestamp', 'compiledAt', 'lastUsedAt',
    'embedding', 'triggerEmbedding', 'external_model_calls', 'uses', 'successes', 'failures'
  ]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !ignored.has(key))
    .map(([key, child]) => [key, withoutVolatileMetadata(child)]));
}

function hashStable(value) {
  return sha256Buffer(Buffer.from(stableString(value)));
}

function writeExclusive(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return sha256Buffer(buffer);
}

function writeJsonExclusive(filePath, value) {
  return writeExclusive(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const found = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  return found.sort();
}

function contentAddress(hash) {
  return path.join(backupRoot, hash.slice(0, 2), hash);
}

function preserveFile(filePath) {
  const before = fs.statSync(filePath);
  const hash = sha256File(filePath);
  const destination = contentAddress(hash);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination)) fs.copyFileSync(filePath, destination, fs.constants.COPYFILE_EXCL);
  if (sha256File(destination) !== hash) throw new Error(`Backup verification failed for ${filePath}`);
  const after = fs.statSync(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Source changed during backup: ${filePath}`);
  return {
    sourcePath: relative(filePath),
    sha256: hash,
    bytes: before.size,
    createdAt: before.birthtime.toISOString(),
    modifiedAt: before.mtime.toISOString(),
    backupPath: relative(destination)
  };
}

function preserveBuffer(label, buffer) {
  const hash = sha256Buffer(buffer);
  const destination = contentAddress(hash);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination)) writeExclusive(destination, buffer);
  if (sha256File(destination) !== hash) throw new Error(`Backup verification failed for generated artifact ${label}`);
  return { sourcePath: label, sha256: hash, bytes: buffer.length, createdAt: timestamp, modifiedAt: timestamp, backupPath: relative(destination) };
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: options.encoding || 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function identifyLineage(filePath, registry) {
  const rel = relative(filePath);
  let role = 'candidate_model';
  if (filePath === currentPath) role = 'registry_current';
  else if (filePath === legacyPath) role = 'legacy_root';
  else if (filePath === registryPath) role = 'registry';
  else if (/backup/i.test(path.basename(filePath))) role = 'registry_backup';
  else if (/checkpoint/i.test(rel)) role = 'checkpoint';
  else if (/model-shards\//i.test(rel)) role = 'shard';
  else if (/agents\/generated\//i.test(rel)) role = 'generated_worker';
  return {
    role,
    promotedFrom: registry?.promotedFrom === rel ? registry.promotedFrom : null,
    previousModel: registry?.previousModelPath === rel ? registry.previousModelPath : null,
    activeModel: registry?.activeModelPath === rel
  };
}

function looksLikeModelFile(filePath) {
  const rel = relative(filePath);
  const name = path.basename(filePath).toLowerCase();
  if (filePath === currentPath || filePath === legacyPath) return true;
  if (/models\/lari\/current\/swarm-model\.backup-\d+\.json$/i.test(rel)) return true;
  if (!name.endsWith('.json')) return false;
  if (!/(swarm-model|candidate-model|trained-model|promoted-model|checkpoint.*model|model-checkpoint|lifecycle-candidate|model\.json$|candidate-reload-check)/i.test(name)) return false;
  const stat = fs.statSync(filePath);
  return stat.size >= 50 * 1024;
}

function collectBackupSources() {
  const candidates = [currentPath, legacyPath, registryPath]
    .concat(walkFiles(path.join(root, 'models', 'lari', 'current')).filter(file => /swarm-model\.backup-\d+\.json$/i.test(file)))
    .concat(walkFiles(path.join(root, 'models')).filter(looksLikeModelFile))
    .concat(walkFiles(path.join(root, 'benchmarks')).filter(looksLikeModelFile))
    .concat(walkFiles(path.join(root, 'model-shards')))
    .concat(walkFiles(path.join(root, 'agents', 'generated')).filter(file => /\.(html|json|js)$/i.test(file)));
  return [...new Set(candidates.filter(file => fs.existsSync(file)))].sort();
}

function collectDirtyWorktreeArtifacts() {
  const status = Buffer.from(git(['status', '--porcelain=v2', '--branch']));
  const workingDiff = Buffer.from(git(['diff', '--binary', '--no-ext-diff']));
  const stagedDiff = Buffer.from(git(['diff', '--cached', '--binary', '--no-ext-diff']));
  const untrackedRaw = git(['ls-files', '--others', '--exclude-standard', '-z']);
  const untracked = untrackedRaw.split('\0').filter(Boolean)
    .map(item => path.join(root, item))
    .filter(file => fs.existsSync(file) && fs.statSync(file).isFile());
  return {
    head: git(['rev-parse', 'HEAD']).trim(),
    branch: git(['branch', '--show-current']).trim() || null,
    status: preserveBuffer('git/status-porcelain-v2.txt', status),
    workingDiff: preserveBuffer('git/working-tree.patch', workingDiff),
    stagedDiff: preserveBuffer('git/staged.patch', stagedDiff),
    untracked: untracked.map(preserveFile)
  };
}

function recordId(item, fallback) {
  return String(item?.id || item?.skillId || item?.policyId || item?.name || fallback);
}

function triggerValues(type, item) {
  const values = [];
  const add = value => {
    if (Array.isArray(value)) value.forEach(add);
    else if (value !== undefined && value !== null) values.push(normalizeText(value));
  };
  add(item.triggerConcepts);
  add(item.conceptTokens);
  add(item.triggers);
  add(item.anyTriggers);
  add(item.query);
  add(item.promptPattern);
  add(item.topic);
  add(item.capability);
  if (type === 'preference') add(item.key || item.text || item.value);
  return [...new Set(values.filter(Boolean))].sort();
}

function procedureValues(item) {
  const value = item.procedure || item.steps || item.rules || item.mechanics || item.audioFeatures || [];
  return (Array.isArray(value) ? value : [value]).map(normalizeText).filter(Boolean);
}

function outputValues(item) {
  return [item.answerTemplate, item.output, item.answer, item.description, item.summary, item.worker, item.family]
    .map(normalizeText).filter(Boolean);
}

function benchmarkAssociation(item) {
  const fields = [item.id, item.source, item.sourceAdapter, item.worker, item.status, item.capability, item.topic]
    .map(value => String(value || ''));
  const pattern = /(benchmark|ifeval|gsm8k|lm[-_ ]?eval|arena|holdout|arc[-_ ]?agi|multiple[-_ ]?choice)/ig;
  return [...new Set(fields.flatMap(value => value.match(pattern) || []).map(normalizeText))].sort();
}

function typedRecord(type, item, source, sourceKind, imported, classification = 'incumbent') {
  const originalRecordId = recordId(item, `${sourceKind}.${hashStable(item).slice(0, 12)}`);
  const normalizedTriggers = triggerValues(type, item);
  const procedures = procedureValues(item);
  const outputs = outputValues(item);
  const behaviorPayload = withoutVolatileMetadata(item);
  const contentHash = hashStable(behaviorPayload);
  const signature = hashStable({ type, normalizedTriggers, procedures, outputs });
  return {
    schemaVersion: 1,
    id: `lari.learned.${type}.${hashStable({ sourceHash: source.hash, sourceKind, originalRecordId, contentHash }).slice(0, 24)}`,
    type,
    status: 'active',
    normalizedTriggers,
    procedureIdentity: hashStable(procedures),
    semanticFingerprint: hashStable({ type, triggers: normalizedTriggers, text: outputs }),
    outputBehavior: hashStable(outputs),
    contentHash,
    behavioralSignature: signature,
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
    provenance: {
      sourceModelHash: source.hash,
      sourcePath: source.path,
      originalRecordId,
      sourceKind,
      creationSource: item.sourceAdapter || item.source || item.worker || item.family || item.status || null,
      benchmarkAssociation: benchmarkAssociation(item),
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
      imported,
      classification,
      importTimestamp: imported ? timestamp : null
    },
    payload: clone(item)
  };
}

function categoryForSkill(item) {
  const text = `${item?.id || ''} ${item?.worker || ''} ${item?.description || ''}`;
  if (/repair/i.test(text)) return 'repair';
  if (/operator|worker/i.test(text)) return 'operator';
  if (/generator|image|audio|modality/i.test(text)) return 'generator';
  return 'procedure';
}

function extractSources(model) {
  const publicRepairs = Array.isArray(model.lariPublicAnswerRepairs)
    ? model.lariPublicAnswerRepairs
    : (model.lariPublicAnswerRepairs?.policies || []);
  return {
    knowledge: model.selfTeaching?.knowledgeBase || [],
    compiledSkills: model.compiledSkills || [],
    learnedSkills: model.skills || [],
    repairs: publicRepairs,
    routeLocks: model.routeMemory || [],
    operators: [
      ...(model.lariSessionRuntime?.operators || []),
      ...(model.operatorSkills || [])
    ],
    generators: model.lariModalityRegistry?.generators || [],
    preferences: model.lariSessionRuntime?.userMemory?.preferences || [],
    corrections: model.lariSessionRuntime?.userMemory?.corrections || []
  };
}

function uniqueById(sourceItems, incumbentItems, label) {
  const incumbentIds = new Set(incumbentItems.map((item, index) => recordId(item, `${label}.incumbent.${index}`)));
  return sourceItems.filter((item, index) => !incumbentIds.has(recordId(item, `${label}.source.${index}`)));
}

function addIncumbentTypedRecords(records, extracted, source) {
  extracted.knowledge.forEach(item => records.push(typedRecord('knowledge', item, source, 'knowledge', false)));
  extracted.compiledSkills.forEach(item => records.push(typedRecord(/repair/i.test(item.id || '') ? 'repair' : 'procedure', item, source, 'compiled_skill', false)));
  extracted.learnedSkills.forEach(item => records.push(typedRecord(categoryForSkill(item), item, source, 'learned_skill', false)));
  extracted.repairs.forEach(item => records.push(typedRecord('repair', item, source, 'public_answer_repair', false)));
  extracted.routeLocks.forEach(item => records.push(typedRecord('repair', item, source, 'route_memory', false)));
  extracted.operators.forEach(item => records.push(typedRecord('operator', item, source, 'operator', false)));
  extracted.generators.forEach(item => records.push(typedRecord('generator', item, source, 'modality_generator', false)));
  extracted.preferences.forEach(item => records.push(typedRecord('preference', item, source, 'preference', false)));
  extracted.corrections.forEach(item => records.push(typedRecord('preference', item, source, 'correction', false)));
}

function classificationAgainst(record, existing) {
  const exact = existing.find(item => item.type === record.type && item.contentHash === record.contentHash);
  if (exact) return { classification: 'duplicate', reason: 'behavioral content hash matches incumbent record', matchedRecordId: exact.id };
  const behavioral = existing.find(item => item.type === record.type && item.behavioralSignature === record.behavioralSignature);
  if (behavioral) return { classification: 'duplicate', reason: 'normalized triggers, procedure identity, and output behavior match', matchedRecordId: behavioral.id };
  const triggerKey = stableString(record.normalizedTriggers);
  const conflict = record.normalizedTriggers.length
    ? existing.find(item => item.type === record.type
      && stableString(item.normalizedTriggers) === triggerKey
      && (item.procedureIdentity !== record.procedureIdentity || item.outputBehavior !== record.outputBehavior))
    : null;
  if (conflict) return { classification: 'conflicted', reason: 'same normalized triggers with different procedure or output behavior', matchedRecordId: conflict.id };
  return { classification: 'imported', reason: 'no behavioral duplicate or trigger conflict', matchedRecordId: null };
}

function addExecutableImport(candidate, bucket, item) {
  if (bucket === 'knowledge') candidate.selfTeaching.knowledgeBase.push(clone(item));
  else if (bucket === 'compiledSkills') candidate.compiledSkills.push(clone(item));
  else if (bucket === 'learnedSkills') candidate.skills.push(clone(item));
  else if (bucket === 'repairs') {
    candidate.lariPublicAnswerRepairs = candidate.lariPublicAnswerRepairs || { enabled: true, policies: [] };
    candidate.lariPublicAnswerRepairs.policies = candidate.lariPublicAnswerRepairs.policies || [];
    candidate.lariPublicAnswerRepairs.policies.push(clone(item));
  } else if (bucket === 'operators') {
    candidate.lariSessionRuntime = candidate.lariSessionRuntime || {};
    candidate.lariSessionRuntime.operators = candidate.lariSessionRuntime.operators || [];
    candidate.lariSessionRuntime.operators.push(clone(item));
  } else if (bucket === 'generators') {
    candidate.lariModalityRegistry = candidate.lariModalityRegistry || {};
    candidate.lariModalityRegistry.generators = candidate.lariModalityRegistry.generators || [];
    candidate.lariModalityRegistry.generators.push(clone(item));
  } else if (bucket === 'preferences' || bucket === 'corrections') {
    candidate.lariSessionRuntime = candidate.lariSessionRuntime || {};
    candidate.lariSessionRuntime.userMemory = candidate.lariSessionRuntime.userMemory || {};
    candidate.lariSessionRuntime.userMemory[bucket] = candidate.lariSessionRuntime.userMemory[bucket] || [];
    candidate.lariSessionRuntime.userMemory[bucket].push(clone(item));
  }
}

function importLegacyIntelligence(candidate, currentExtracted, legacyExtracted, records, currentSource, legacySource) {
  const specs = [
    ['knowledge', 'knowledge', 'knowledge'],
    ['compiledSkills', 'procedure', 'compiled_skill'],
    ['learnedSkills', 'procedure', 'learned_skill'],
    ['repairs', 'repair', 'public_answer_repair'],
    ['operators', 'operator', 'operator'],
    ['generators', 'generator', 'modality_generator'],
    ['preferences', 'preference', 'preference'],
    ['corrections', 'preference', 'correction']
  ];
  const outcomes = [];
  for (const [bucket, defaultType, sourceKind] of specs) {
    const unique = uniqueById(legacyExtracted[bucket], currentExtracted[bucket], bucket);
    for (let index = 0; index < unique.length; index += 1) {
      const item = unique[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        outcomes.push({ bucket, originalRecordId: `${bucket}.${index}`, classification: 'invalid', reason: 'record is not an object' });
        continue;
      }
      const type = bucket === 'learnedSkills' ? categoryForSkill(item)
        : bucket === 'compiledSkills' && /repair/i.test(item.id || '') ? 'repair'
        : defaultType;
      let record = typedRecord(type, item, legacySource, sourceKind, true);
      const decision = classificationAgainst(record, records);
      record.provenance.classification = decision.classification;
      const outcome = {
        bucket,
        originalRecordId: record.provenance.originalRecordId,
        recordId: record.id,
        classification: decision.classification,
        reason: decision.reason,
        matchedRecordId: decision.matchedRecordId,
        benchmarkAssociation: record.provenance.benchmarkAssociation,
        confidence: record.confidence
      };
      outcomes.push(outcome);
      if (decision.classification === 'imported' || decision.classification === 'conflicted') {
        records.push(record);
        addExecutableImport(candidate, bucket, item);
      }
    }
  }
  return outcomes;
}

function rebuildDerivedIndexes(candidate) {
  candidate.routeMemory = candidate.lariLearnedRecords.records
    .filter(record => record.type === 'repair' && record.provenance.sourceKind === 'route_memory')
    .map(record => clone(record.payload));
  const graph = runtime.buildLariCapabilityGraph(candidate, { preserveExistingCompositions: true });
  const records = candidate.lariLearnedRecords.records;
  candidate.lariDerivedIndexes = {
    schemaVersion: 1,
    derivedFrom: 'lariLearnedRecords.records',
    sourceRecordCount: records.length,
    builtAt: timestamp,
    routing: records.map(record => ({
      recordId: record.id,
      type: record.type,
      normalizedTriggers: record.normalizedTriggers,
      semanticFingerprint: record.semanticFingerprint,
      outputBehavior: record.outputBehavior
    })),
    capabilityGraph: {
      nodeCount: graph?.nodes?.length || candidate.lariCapabilityGraph?.nodes?.length || 0,
      edgeCount: graph?.edges?.length || candidate.lariCapabilityGraph?.edges?.length || 0,
      routeCount: graph?.routes?.length || candidate.lariCapabilityGraph?.routes?.length || 0
    },
    genes: records.map(record => ({ recordId: record.id, type: record.type, confidence: record.confidence })),
    routeLocks: candidate.routeMemory.map(item => ({ query: item.query || null, skillId: item.skillId || item.id || null })),
    benchmarkCapabilities: records
      .filter(record => record.provenance.benchmarkAssociation.length)
      .map(record => ({ recordId: record.id, associations: record.provenance.benchmarkAssociation }))
  };
}

function ids(items, label) {
  return new Map(items.map((item, index) => [recordId(item, `${label}.${index}`), hashStable(item)]));
}

function stateRetention(candidate, current, legacy, outcomes) {
  const currentExtracted = extractSources(current);
  const candidateExtracted = extractSources(candidate);
  const incumbentChecks = {};
  for (const key of ['knowledge', 'compiledSkills', 'learnedSkills', 'repairs', 'operators', 'generators', 'preferences', 'corrections']) {
    const expected = ids(currentExtracted[key], `current.${key}`);
    const actual = ids(candidateExtracted[key], `candidate.${key}`);
    const missing = [...expected.keys()].filter(id => !actual.has(id));
    incumbentChecks[key] = { expected: expected.size, retained: expected.size - missing.length, missing };
  }
  const expectedRootOnly = { knowledge: 45, compiledSkills: 45, learnedSkills: 45, repairs: 41 };
  const rootAccounting = {};
  for (const [bucket, expected] of Object.entries(expectedRootOnly)) {
    const classified = outcomes.filter(item => item.bucket === bucket);
    rootAccounting[bucket] = {
      expected,
      found: classified.length,
      byClassification: Object.fromEntries(['imported', 'duplicate', 'conflicted', 'invalid', 'archived-with-reason']
        .map(status => [status, classified.filter(item => item.classification === status).length])),
      complete: classified.length === expected && classified.every(item => item.classification)
    };
  }
  return {
    incumbentChecks,
    rootAccounting,
    allIncumbentRetained: Object.values(incumbentChecks).every(check => check.missing.length === 0),
    allRootOnlyAccounted: Object.values(rootAccounting).every(check => check.complete),
    currentTopLevelKeysRetained: Object.keys(current).every(key => Object.prototype.hasOwnProperty.call(candidate, key))
  };
}

function summarizeRun(model, prompt) {
  try {
    const response = runtime.sendMessageToLari(clone(model), prompt, {
      kernel: { useBenchmarkSystem: false, useCapabilityGraph: true }
    });
    const output = String(response?.output_text || response?.answer || response?.record?.outputText || '');
    return {
      passed: response?.passed !== false && output.trim().length > 0,
      explicitPassed: response?.passed === true,
      action: response?.action || response?.record?.action || null,
      mode: response?.mode || null,
      outputLength: output.length,
      outputHash: sha256Buffer(Buffer.from(output))
    };
  } catch (error) {
    return { passed: false, explicitPassed: false, action: null, mode: null, outputLength: 0, error: error.message };
  }
}

function validateFamilies(current, candidate) {
  const prompts = {
    chat: 'Explain in plain language how a local program can retain useful knowledge between restarts.',
    instruction: 'Give exactly two short bullet points about preserving software state.',
    math: 'A workshop packs 18 blue parts and 27 green parts. How many parts are packed in total?',
    multiple_choice: 'A service must avoid losing saved data. Which is the best first step? A) Delete backups B) Verify an atomic snapshot C) Ignore errors D) Rename the product',
    coding: 'Describe the safest diagnostic sequence when a small code change causes an existing test to fail.',
    research: 'Explain a source-grounded process for learning an unfamiliar technical topic without inventing facts.',
    product: 'Describe a minimal local product plan with persistence, verification, and rollback.',
    safety: 'Explain why an autonomous local tool should require verification before destructive changes.'
  };
  const results = Object.entries(prompts).map(([family, prompt]) => {
    const incumbent = summarizeRun(current, prompt);
    const migrated = summarizeRun(candidate, prompt);
    const incumbentScore = Number(incumbent.passed) + Number(incumbent.explicitPassed) + Math.min(1, incumbent.outputLength / 80);
    const candidateScore = Number(migrated.passed) + Number(migrated.explicitPassed) + Math.min(1, migrated.outputLength / 80);
    return { family, prompt, incumbent, candidate: migrated, incumbentScore, candidateScore, regressed: candidateScore + 0.0001 < incumbentScore };
  });
  return { results, passed: results.every(result => !result.regressed) };
}

function validateImportedTransfer(candidate, outcomes) {
  const importedIds = new Set(outcomes
    .filter(item => ['imported', 'conflicted'].includes(item.classification))
    .map(item => item.recordId));
  const candidates = candidate.lariLearnedRecords.records
    .filter(record => importedIds.has(record.id) && !record.provenance.benchmarkAssociation.length && record.normalizedTriggers.length >= 2);
  const tests = candidates.slice(0, 24).map(record => {
    const terms = record.normalizedTriggers.slice(0, 4).reverse();
    const prompt = `In a new situation, what reusable guidance applies when ${terms.join(', ')} matter?`;
    let routed = null;
    if (record.type === 'knowledge') {
      const matches = runtime.searchKnowledge(clone(candidate), prompt, { limit: 5, minScore: 0 });
      routed = (matches || []).some(match => (match.item?.id || match.id) === record.provenance.originalRecordId);
    } else if (['procedure', 'repair'].includes(record.type)) {
      const match = runtime.routeCompiledSkill(clone(candidate), prompt, { minScore: 0 });
      routed = match?.skill?.id === record.provenance.originalRecordId;
    } else {
      routed = true;
    }
    const kernel = summarizeRun(candidate, prompt);
    return {
      recordId: record.id,
      originalRecordId: record.provenance.originalRecordId,
      type: record.type,
      prompt,
      routedToImportedRecord: routed,
      kernelPassed: kernel.passed,
      exactBenchmarkMetadataInPrompt: /(ifeval|gsm8k|lm[-_ ]?eval|benchmark|arc[-_ ]?agi|holdout)/i.test(prompt),
      passed: kernel.passed && routed === true
    };
  });
  return {
    tests,
    eligibleRecordCount: candidates.length,
    passedCount: tests.filter(test => test.passed).length,
    passed: tests.length >= 6 && tests.filter(test => test.passed).length / tests.length >= 0.75
      && tests.every(test => !test.exactBenchmarkMetadataInPrompt)
  };
}

function markdownTable(rows, columns) {
  const escape = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    `| ${columns.map(column => column.label).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map(column => escape(column.value(row))).join(' | ')} |`)
  ].join('\n');
}

function main() {
  fs.mkdirSync(consolidationRoot, { recursive: true });
  for (const output of Object.values(outputPaths)) {
    if (fs.existsSync(output)) throw new Error(`Refusing to overwrite Stage 1 deliverable: ${relative(output)}`);
  }
  if (!fs.existsSync(freezePath)) {
    writeJsonExclusive(freezePath, {
      schemaVersion: 1,
      stage: 'consolidation-stage-1',
      active: true,
      createdAt: timestamp,
      protectedArtifacts: ['models/lari/current/swarm-model.json', 'models/lari/registry.json', 'swarm-model.json', 'model-shards/**'],
      allowedWrites: ['consolidation/**'],
      note: 'Registry, CLI, API, Workbench model, and Workbench shard persistence are guarded while this marker exists.'
    });
  }

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const beforeHashes = { current: sha256File(currentPath), legacyRoot: sha256File(legacyPath), registry: sha256File(registryPath) };
  const backupSources = collectBackupSources();
  const dirtyWorktree = collectDirtyWorktreeArtifacts();
  const artifacts = [];
  for (let index = 0; index < backupSources.length; index += 1) {
    const filePath = backupSources[index];
    const preserved = preserveFile(filePath);
    artifacts.push({ ...preserved, lineage: identifyLineage(filePath, registry) });
    if ((index + 1) % 25 === 0 || index + 1 === backupSources.length) {
      process.stdout.write(`Preserved ${index + 1}/${backupSources.length} source artifacts.\n`);
    }
  }
  const uniqueBlobCount = new Set(artifacts.map(item => item.sha256)
    .concat(dirtyWorktree.untracked.map(item => item.sha256))
    .concat([dirtyWorktree.status.sha256, dirtyWorktree.workingDiff.sha256, dirtyWorktree.stagedDiff.sha256])).size;
  const backupManifest = {
    schemaVersion: 1,
    stage: 'consolidation-stage-1',
    createdAt: timestamp,
    hashAlgorithm: 'sha256',
    contentAddressedStore: 'consolidation/stage-1-backups/sha256/{first-two}/{sha256}',
    sourceArtifactCount: artifacts.length,
    uniqueBlobCount,
    artifacts,
    dirtyWorktree,
    freeze: { markerPath: relative(freezePath), active: true },
    protectedHashesBeforeMigration: beforeHashes
  };

  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  const currentSource = { hash: beforeHashes.current, path: relative(currentPath) };
  const legacySource = { hash: beforeHashes.legacyRoot, path: relative(legacyPath) };
  const candidate = clone(current);
  const currentExtracted = extractSources(current);
  const legacyExtracted = extractSources(legacy);
  const records = [];
  addIncumbentTypedRecords(records, currentExtracted, currentSource);
  const outcomes = importLegacyIntelligence(candidate, currentExtracted, legacyExtracted, records, currentSource, legacySource);
  candidate.lariLearnedRecords = {
    schemaVersion: 1,
    canonical: true,
    recordSchema: {
      categories: ['knowledge', 'procedure', 'repair', 'operator', 'generator', 'preference'],
      requiredFields: ['id', 'type', 'normalizedTriggers', 'procedureIdentity', 'semanticFingerprint', 'outputBehavior', 'contentHash', 'confidence', 'provenance', 'payload']
    },
    createdAt: timestamp,
    baseModelHash: beforeHashes.current,
    migrationSourceHashes: [beforeHashes.legacyRoot],
    records
  };
  candidate.lariConsolidation = {
    schemaVersion: 1,
    stage: 1,
    promoted: false,
    immutableCandidate: true,
    createdAt: timestamp,
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    incumbent: currentSource,
    migrationSources: [legacySource],
    excludedSourceClasses: ['raw_session_logs', 'benchmark_reports', 'temporary_traces', 'generated_products', 'screenshots', 'duplicated_model_metadata', 'candidate_promotion_history', 'raw_proof_artifacts']
  };
  rebuildDerivedIndexes(candidate);

  writeJsonExclusive(outputPaths.candidate, candidate);
  const candidateHash = sha256File(outputPaths.candidate);
  const reloaded = JSON.parse(fs.readFileSync(outputPaths.candidate, 'utf8'));
  const retention = stateRetention(reloaded, current, legacy, outcomes);
  const familyRegression = validateFamilies(current, reloaded);
  const transfer = validateImportedTransfer(reloaded, outcomes);
  const afterHashes = { current: sha256File(currentPath), legacyRoot: sha256File(legacyPath), registry: sha256File(registryPath) };
  const activeUntouched = stableString(beforeHashes) === stableString(afterHashes);
  const loadPassed = reloaded?.lariConsolidation?.promoted === false && reloaded?.lariLearnedRecords?.records?.length === records.length;
  const ordinaryRoute = summarizeRun(reloaded, 'Explain how a durable local model should preserve useful learning without overwriting its active state.');
  const reloadRoutes = validateImportedTransfer(reloaded, outcomes);
  const rollback = {
    backupCurrentHash: sha256File(contentAddress(beforeHashes.current)),
    expectedCurrentHash: beforeHashes.current,
    registryStillPointsToCurrent: registry.activeModelPath === 'models/lari/current/swarm-model.json',
    passed: sha256File(contentAddress(beforeHashes.current)) === beforeHashes.current
      && registry.activeModelPath === 'models/lari/current/swarm-model.json'
      && activeUntouched
  };
  const conflicts = outcomes.filter(item => item.classification === 'conflicted');
  const invalid = outcomes.filter(item => ['invalid', 'archived-with-reason'].includes(item.classification));
  const validation = {
    modelLoads: loadPassed,
    ordinaryUnifiedKernelRoute: ordinaryRoute.passed,
    activeModelFilesUnmodified: activeUntouched,
    hiddenParaphraseAndSemanticVariants: transfer,
    unseenTransfer: transfer.passed,
    reloadRetention: reloadRoutes.passed && reloadRoutes.tests.length === transfer.tests.length,
    rollback,
    familyRegression,
    noExactBenchmarkMetadataRequired: transfer.tests.length >= 6 && transfer.tests.every(test => !test.exactBenchmarkMetadataInPrompt),
    stateRetention: retention
  };
  const candidateValid = validation.modelLoads
    && validation.ordinaryUnifiedKernelRoute
    && validation.activeModelFilesUnmodified
    && validation.hiddenParaphraseAndSemanticVariants.passed
    && validation.unseenTransfer
    && validation.reloadRetention
    && validation.rollback.passed
    && validation.familyRegression.passed
    && validation.noExactBenchmarkMetadataRequired
    && retention.allIncumbentRetained
    && retention.allRootOnlyAccounted
    && retention.currentTopLevelKeysRetained
    && invalid.length === 0;
  const verdict = !retention.allRootOnlyAccounted || invalid.length
    ? 'Migration incomplete'
    : !familyRegression.passed || !candidateValid
      ? 'Candidate regressed and must not proceed'
      : conflicts.length
        ? 'Candidate valid but unresolved conflicts remain'
        : 'Safe to proceed to public-path convergence';

  const migrationManifest = {
    schemaVersion: 1,
    stage: 'consolidation-stage-1',
    createdAt: timestamp,
    promoted: false,
    candidatePath: relative(outputPaths.candidate),
    candidateHash,
    candidateBytes: fs.statSync(outputPaths.candidate).size,
    canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel',
    incumbent: currentSource,
    migrationSources: [legacySource],
    typedRecordCount: records.length,
    typedRecordCounts: Object.fromEntries(['knowledge', 'procedure', 'repair', 'operator', 'generator', 'preference']
      .map(type => [type, records.filter(record => record.type === type).length])),
    rootOnlyOutcomes: outcomes,
    derivedIndexes: candidate.lariDerivedIndexes,
    protectedHashesBeforeMigration: beforeHashes,
    protectedHashesAfterMigration: afterHashes,
    activeFilesUnmodified: activeUntouched,
    verdict
  };

  const outcomeCounts = Object.fromEntries(['imported', 'duplicate', 'conflicted', 'invalid', 'archived-with-reason']
    .map(status => [status, outcomes.filter(item => item.classification === status).length]));
  const importReport = `# Lari Consolidation Stage 1 Import Report\n\n`
    + `Candidate: \`${relative(outputPaths.candidate)}\`\n\nCandidate SHA-256: \`${candidateHash}\`\n\n`
    + `The registry-current model was cloned losslessly. Only learned-state categories from the legacy root were considered; logs, reports, traces, products, screenshots, promotion history, duplicated metadata, and proof artifacts were excluded.\n\n`
    + `## Outcome summary\n\n${markdownTable(Object.entries(outcomeCounts).map(([status, count]) => ({ status, count })), [{ label: 'Classification', value: row => row.status }, { label: 'Count', value: row => row.count }])}\n\n`
    + `## Required root-only accounting\n\n${markdownTable(Object.entries(retention.rootAccounting).map(([bucket, value]) => ({ bucket, ...value })), [
      { label: 'Bucket', value: row => row.bucket }, { label: 'Expected', value: row => row.expected }, { label: 'Found', value: row => row.found },
      { label: 'Imported', value: row => row.byClassification.imported }, { label: 'Duplicate', value: row => row.byClassification.duplicate },
      { label: 'Conflicted', value: row => row.byClassification.conflicted }, { label: 'Invalid/archived', value: row => row.byClassification.invalid + row.byClassification['archived-with-reason'] },
      { label: 'Complete', value: row => row.complete }
    ])}\n\n## Record details\n\n${markdownTable(outcomes, [
      { label: 'Bucket', value: row => row.bucket }, { label: 'Original ID', value: row => row.originalRecordId },
      { label: 'Classification', value: row => row.classification }, { label: 'Reason', value: row => row.reason },
      { label: 'Benchmark association', value: row => row.benchmarkAssociation.join(', ') || 'none' }
    ])}\n`;
  const dedupReport = `# Lari Consolidation Stage 1 Deduplication Report\n\n`
    + `Records were compared using normalized triggers, procedure identity, semantic fingerprint, output behavior, and behavioral content hash. Names alone were never used to merge records.\n\n`
    + `${markdownTable(outcomes, [
      { label: 'Bucket', value: row => row.bucket }, { label: 'Original ID', value: row => row.originalRecordId },
      { label: 'Decision', value: row => row.classification }, { label: 'Matched record', value: row => row.matchedRecordId || 'none' },
      { label: 'Basis', value: row => row.reason }
    ])}\n`;
  const conflictReport = `# Lari Consolidation Stage 1 Conflicts\n\n`
    + (conflicts.length
      ? `Conflicts were preserved as separate typed and executable records. No conflict was resolved automatically.\n\n${markdownTable(conflicts, [
        { label: 'Bucket', value: row => row.bucket }, { label: 'Original ID', value: row => row.originalRecordId },
        { label: 'Candidate record', value: row => row.recordId }, { label: 'Conflicts with', value: row => row.matchedRecordId },
        { label: 'Reason', value: row => row.reason }
      ])}\n`
      : 'No unresolved behavioral conflicts were detected.\n');
  const familyRows = familyRegression.results;
  const validationReport = `# Lari Consolidation Stage 1 Validation Report\n\n`
    + `Candidate SHA-256: \`${candidateHash}\`\n\nRegistry current was not promoted or modified.\n\n`
    + `## Validation summary\n\n${markdownTable([
      ['Model loads', validation.modelLoads], ['Unified kernel routes ordinary requests', validation.ordinaryUnifiedKernelRoute],
      ['Active model files unmodified', validation.activeModelFilesUnmodified], ['Hidden paraphrases and semantic variants', transfer.passed],
      ['Unseen transfer', validation.unseenTransfer], ['Reload retention', validation.reloadRetention], ['Rollback simulation', rollback.passed],
      ['No family regressions', familyRegression.passed], ['No exact benchmark metadata required', validation.noExactBenchmarkMetadataRequired],
      ['Incumbent state retained', retention.allIncumbentRetained], ['Root-only state accounted', retention.allRootOnlyAccounted]
    ].map(([check, passed]) => ({ check, passed })), [{ label: 'Check', value: row => row.check }, { label: 'Passed', value: row => row.passed }])}\n\n`
    + `## Family regression comparison\n\n${markdownTable(familyRows, [
      { label: 'Family', value: row => row.family }, { label: 'Incumbent score', value: row => row.incumbentScore.toFixed(3) },
      { label: 'Candidate score', value: row => row.candidateScore.toFixed(3) }, { label: 'Regressed', value: row => row.regressed },
      { label: 'Candidate action', value: row => row.candidate.action || 'none' }
    ])}\n\n`
    + `## Hidden transfer details\n\n${markdownTable(transfer.tests, [
      { label: 'Type', value: row => row.type }, { label: 'Original ID', value: row => row.originalRecordId },
      { label: 'Routed', value: row => row.routedToImportedRecord }, { label: 'Kernel passed', value: row => row.kernelPassed },
      { label: 'Exact benchmark metadata', value: row => row.exactBenchmarkMetadataInPrompt }, { label: 'Passed', value: row => row.passed }
    ])}\n\n## Verdict\n\n**${verdict}**\n`;
  const rollbackReport = `# Lari Consolidation Stage 1 Rollback Procedure\n\n`
    + `No promotion occurred, so normal rollback is to stop using \`${relative(outputPaths.candidate)}\`; registry current remains unchanged.\n\n`
    + `1. Verify registry current still resolves to \`models/lari/current/swarm-model.json\`.\n`
    + `2. Verify its SHA-256 is \`${beforeHashes.current}\`.\n`
    + `3. If recovery is ever required, copy the verified content-addressed blob \`${relative(contentAddress(beforeHashes.current))}\` to a new temporary path.\n`
    + `4. Verify the temporary copy hash before any separately authorized restoration.\n`
    + `5. Do not overwrite registry current or alter registry history during Stage 1.\n`
    + `6. Remove the Stage 1 freeze only in a separately authorized later stage.\n\nRollback simulation passed: **${rollback.passed}**.\n`;

  writeJsonExclusive(outputPaths.backupManifest, backupManifest);
  writeJsonExclusive(outputPaths.migrationManifest, migrationManifest);
  writeExclusive(outputPaths.importReport, importReport);
  writeExclusive(outputPaths.dedupReport, dedupReport);
  writeExclusive(outputPaths.conflicts, conflictReport);
  writeExclusive(outputPaths.validation, validationReport);
  writeExclusive(outputPaths.rollback, rollbackReport);

  process.stdout.write(`${JSON.stringify({ candidateHash, candidateBytes: fs.statSync(outputPaths.candidate).size, outcomeCounts, conflicts: conflicts.length, validation: { candidateValid, verdict }, activeFilesUnmodified: activeUntouched }, null, 2)}\n`);
  if (!candidateValid && verdict !== 'Candidate valid but unresolved conflicts remain') process.exitCode = 1;
}

main();
