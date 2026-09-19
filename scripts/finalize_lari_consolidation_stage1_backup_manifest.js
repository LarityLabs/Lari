#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const consolidation = path.join(root, 'consolidation');
const manifestPath = path.join(consolidation, 'stage-1-backup-manifest.json');
const backupRoot = path.join(consolidation, 'stage-1-backups', 'sha256');
const addedPaths = [
  'benchmarks/tmp-lari-adaptive-competitor-curriculum/adaptive-curriculum-model.json',
  'benchmarks/tmp-lari-adaptive-curriculum-promotion-gate/candidate-reload-check.json',
  'benchmarks/tmp-lari-math-autonomous-mining-loop/best-lari-model.json',
  'benchmarks/tmp-lari-public-adapter/lm-eval-ifeval-full-model.json',
  'benchmarks/tmp-lari-research-learning-marathon/lari-research-learning-marathon-model.json'
];

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count = 0;
    do {
      count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count) hash.update(buffer.subarray(0, count));
    } while (count);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function preserve(relativePath) {
  const source = path.join(root, relativePath);
  const stat = fs.statSync(source);
  const hash = sha256File(source);
  const destination = path.join(backupRoot, hash.slice(0, 2), hash);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination)) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (sha256File(destination) !== hash) throw new Error(`Backup verification failed for ${relativePath}`);
  return {
    sourcePath: relativePath,
    sha256: hash,
    bytes: stat.size,
    createdAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
    backupPath: relative(destination),
    lineage: {
      role: /checkpoint/i.test(relativePath) ? 'checkpoint' : 'candidate_model',
      promotedFrom: null,
      previousModel: null,
      activeModel: false
    }
  };
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const existing = new Set(manifest.artifacts.map(item => item.sourcePath));
  const additions = addedPaths.filter(item => !existing.has(item)).map(preserve);
  if (additions.length !== addedPaths.length) throw new Error('Expected all five missed model artifacts to be absent from the initial manifest.');
  const attempt = path.join(consolidation, 'stage-1-attempts', 'backup-manifest-initial.json');
  if (fs.existsSync(attempt)) throw new Error(`Refusing to overwrite preserved manifest: ${attempt}`);
  fs.mkdirSync(path.dirname(attempt), { recursive: true });
  fs.renameSync(manifestPath, attempt);
  const artifacts = [...manifest.artifacts, ...additions].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  const dirtyHashes = manifest.dirtyWorktree.untracked.map(item => item.sha256)
    .concat([manifest.dirtyWorktree.status.sha256, manifest.dirtyWorktree.workingDiff.sha256, manifest.dirtyWorktree.stagedDiff.sha256]);
  const revised = {
    ...manifest,
    manifestRevision: 2,
    revisionReason: 'Added five historical model artifacts found by structural completeness scan; reports and proof bundles remain excluded.',
    revisedAt: new Date().toISOString(),
    sourceArtifactCount: artifacts.length,
    uniqueBlobCount: new Set(artifacts.map(item => item.sha256).concat(dirtyHashes)).size,
    artifacts
  };
  const fd = fs.openSync(manifestPath, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(revised, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  process.stdout.write(`${JSON.stringify({ added: additions.map(item => item.sourcePath), sourceArtifactCount: revised.sourceArtifactCount, uniqueBlobCount: revised.uniqueBlobCount }, null, 2)}\n`);
}

main();
