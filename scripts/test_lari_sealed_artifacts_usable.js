#!/usr/bin/env node
'use strict';

/**
 * Are this project's sealed artifacts still usable, or do they only look usable?
 *
 * Two defects in one session shared a shape: an artifact that validated, reported healthy numbers, and
 * carried nothing you could act on.
 *
 *   - Every sealed manifest recorded a repository path under %TEMP%. They named a commit, so they read
 *     as reproducible, and one directory cleanup would have made every sealed result in this project's
 *     history unverifiable. Nothing failed. Nothing would have failed until the evidence was needed.
 *   - INVENTORY.json recorded null for all 77 rules, because a vocabulary rule is an array and the
 *     builder read `.description` off it. Counts, families, prior denominators and sha256s were all
 *     correct, so the file passed every eye it met while recording no rules at all.
 *
 * Neither is a logic bug and neither was visible in review. Both are the same failure: nobody asserted
 * that the artifact could still do its job. That is rule 11 -- a green suite is not a correct system --
 * pointed at evidence rather than at code.
 *
 * A manifest whose repository has vanished is not a smaller problem than a failing test. It is a
 * sealed result that can no longer be checked, which in a project whose entire argument is "you can
 * check this" is the worst thing in the list.
 *
 * Usage: node scripts/test_lari_sealed_artifacts_usable.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOLDOUTS = path.join(ROOT, 'holdouts');
const INVENTORY = path.join(ROOT, 'models', 'lari', 'trained', 'INVENTORY.json');

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 240)}` : ''}`);
  }
}

function findManifests(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findManifests(full, found);
    else if (entry.name === 'manifest.json') found.push(full);
  }
  return found;
}

console.log('sealed manifests point at repositories that still exist');
{
  const manifests = findManifests(HOLDOUTS);
  check('there are sealed manifests to check', manifests.length > 0, manifests.length);

  for (const file of manifests) {
    const name = path.basename(path.dirname(file));
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const repo = manifest.repo || {};
    if (!repo.path) continue; // Acceptance-style manifests carry no repository.

    // A path under a temp directory is a live grenade even while it resolves.
    check(`${name}: repository path is not a temp directory`,
      !/[\\/](?:Temp|tmp|TEMP)[\\/]/.test(repo.path), repo.path);
    check(`${name}: repository path resolves`, fs.existsSync(repo.path), repo.path);

    if (repo.commit && fs.existsSync(repo.path)) {
      let head = null;
      try {
        head = execFileSync('git', ['-C', repo.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch (e) { /* reported by the assertion below */ }
      // A path resolving to the WRONG code is worse than one that does not resolve: the set would run
      // and produce a number against something that was never measured.
      check(`${name}: checkout is at the commit the manifest names`,
        head === repo.commit, { expected: repo.commit, found: head });
    }
  }
}

console.log('\nthe trained-model inventory records what it claims to record');
{
  if (!fs.existsSync(INVENTORY)) {
    console.log('  ..   no INVENTORY.json; skipping');
  } else {
    const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
    check('the inventory lists models', Array.isArray(inventory.models) && inventory.models.length > 0);

    for (const model of inventory.models) {
      const rules = Object.values(model.families || {}).flat();
      check(`${model.file}: rule count matches the listed rules`,
        rules.length === model.ruleCount, { listed: rules.length, counted: model.ruleCount });
      // The defect exactly: every count right, every rule null.
      check(`${model.file}: no rule is null`,
        rules.every(r => typeof r === 'string' && r.length > 0),
        rules.filter(r => !r).length);
      check(`${model.file}: records a sha256`, /^[0-9a-f]{64}$/.test(String(model.sha256)));
      if (Array.isArray(model.learnedBeyondSeed)) {
        check(`${model.file}: learned rules are named, not just counted`,
          model.learnedBeyondSeed.every(r => typeof r === 'string' && !/null/.test(r)),
          model.learnedBeyondSeed.slice(0, 3));
      }
    }

    // The blobs are gitignored on purpose. If one is present it must match its recorded hash, because
    // an inventory describing a file that has since changed is worse than no inventory.
    const crypto = require('crypto');
    for (const model of inventory.models) {
      const blob = path.join(path.dirname(INVENTORY), model.file);
      if (!fs.existsSync(blob)) {
        console.log(`  ..   ${model.file} is not present locally (gitignored); hash not checked`);
        continue;
      }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(blob)).digest('hex');
      check(`${model.file}: on-disk file matches its recorded sha256`, actual === model.sha256);
    }
  }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
