#!/usr/bin/env node
'use strict';

/**
 * Why has statement-insertion never repaired anything?
 *
 * The family is 0 for 60 in the recorded priors, and statement deletion is the largest uncovered
 * defect class in this engine -- roughly 30% of every sealed instance. The family's own header states
 * the two assumptions it rests on, measured at the time it was written:
 *
 *   1. REDUNDANCY -- the deleted statement appears verbatim elsewhere in the same file, claimed at
 *      13 of 20 SDL instances.
 *   2. NAME EVIDENCE -- a deletion leaves a name unbound and the failure text says which, so a donor
 *      assigning that name can be ranked first.
 *
 * If (1) is false the correct candidate is never generated and no amount of ranking helps. If (2) is
 * false the candidate is generated but sits somewhere in a pool of hundreds and never gets verified
 * inside the budget. The fixes are completely different, so this measures which it is before anything
 * is built. Instrument before optimising -- one sealed run found the real bottleneck in an hour after a
 * day of planning against the wrong constraint.
 *
 * Reads sealed manifests and pristine sources only. Runs nothing, mutates nothing, scores nothing.
 *
 * Usage: node scripts/diagnose_lari_sdl_assumptions.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOLDOUTS = path.join(ROOT, 'holdouts');

function findManifests(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findManifests(full, found);
    else if (entry.name === 'manifest.json') found.push(full);
  }
  return found;
}

const rows = [];
for (const file of findManifests(HOLDOUTS)) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const repo = manifest.repo && manifest.repo.path;
  if (!repo || !fs.existsSync(repo)) continue;

  for (const instance of manifest.instances || []) {
    if (instance.operator !== 'SDL') continue;
    const target = path.join(repo, instance.targetFile);
    if (!fs.existsSync(target)) continue;

    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
    const deleted = String(lines[instance.line - 1] || '').trim();
    if (!deleted) continue;

    // Assumption 1: is the deleted statement present elsewhere in the same file?
    const elsewhereInFile = lines
      .filter((line, i) => i !== instance.line - 1 && line.trim() === deleted).length;

    // A weaker form: does any other statement assign the same name?
    const assigned = (deleted.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*=[^=]/) || [])[1] || null;
    const sameNameAssigned = assigned
      ? lines.filter((line, i) => i !== instance.line - 1
          && new RegExp(`^\\s*${assigned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=[^=]`).test(line)).length
      : 0;

    // Assumption 2: does the recorded failure name an unbound name?
    const failure = String(instance.failureTail || '');
    const namesUnbound = [
      ...failure.matchAll(/NameError:\s+(?:local variable|name)\s+'([A-Za-z_]\w*)'/g),
      ...failure.matchAll(/UnboundLocalError:.*?'([A-Za-z_]\w*)'/g)
    ].map(m => m[1]);

    // A3, the proposed replacement signal: is the name the deleted statement binds READ later in the
    // same enclosing block? A deleted loop assignment does not raise NameError -- the name is still
    // bound from the previous iteration, so the failure is a wrong value rather than an unbound name.
    // But the name is still read below the hole, and that is visible without running anything.
    let readBelow = false;
    let readBelowDistance = null;
    if (assigned) {
      const bare = assigned.split('.')[0];
      const indentOf = s => (s.match(/^\s*/) || [''])[0].length;
      const holeIndent = indentOf(lines[instance.line - 1] || '');
      for (let i = instance.line; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        // Leaving the enclosing block ends the window.
        if (indentOf(line) < holeIndent && !/^\s*(?:\)|\]|\})/.test(line)) break;
        const usePattern = new RegExp(`(?<![\\w.])${bare.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?![\\w])`);
        const isAssignmentToIt = new RegExp(`^\\s*${bare.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*=[^=]`).test(line);
        if (usePattern.test(line) && !isAssignmentToIt) {
          readBelow = true;
          readBelowDistance = i - (instance.line - 1);
          break;
        }
      }
    }

    rows.push({
      readBelow,
      readBelowDistance,
      set: path.basename(path.dirname(file)),
      instance: `${instance.targetFile}:${instance.line}`,
      deleted: deleted.slice(0, 60),
      isAssignment: Boolean(assigned),
      verbatimElsewhere: elsewhereInFile > 0,
      sameNameAssignedElsewhere: sameNameAssigned > 0,
      failureNamesUnbound: namesUnbound.length > 0,
      unboundMatchesDeleted: assigned ? namesUnbound.includes(assigned.split('.')[0]) : false
    });
  }
}

if (!rows.length) {
  console.log('No SDL instances found in any manifest whose repository is present.');
  process.exit(0);
}

console.log(`SDL instances found: ${rows.length}\n`);
for (const r of rows) {
  console.log(`${r.set} ${r.instance}`);
  console.log(`   deleted: ${r.deleted}`);
  console.log(`   assignment=${r.isAssignment}  verbatimElsewhere=${r.verbatimElsewhere}`
    + `  sameNameElsewhere=${r.sameNameAssignedElsewhere}`
    + `  failureNamesUnbound=${r.failureNamesUnbound}  unboundMatchesDeleted=${r.unboundMatchesDeleted}`);
}

const pct = (n) => `${n}/${rows.length} (${Math.round((100 * n) / rows.length)}%)`;
console.log('\n=== assumptions, measured ===');
console.log(`  deleted statement is an assignment        : ${pct(rows.filter(r => r.isAssignment).length)}`);
console.log(`  A1 present VERBATIM elsewhere in the file : ${pct(rows.filter(r => r.verbatimElsewhere).length)}`);
console.log(`     (weaker) same name assigned elsewhere  : ${pct(rows.filter(r => r.sameNameAssignedElsewhere).length)}`);
console.log(`  A2 failure names an unbound name          : ${pct(rows.filter(r => r.failureNamesUnbound).length)}`);
console.log(`     and it matches the deleted assignment  : ${pct(rows.filter(r => r.unboundMatchesDeleted).length)}`);
console.log(`  A3 bound name is READ below the hole      : ${pct(rows.filter(r => r.readBelow).length)}`);
const both = rows.filter(r => r.readBelow && r.verbatimElsewhere).length;
console.log(`     A1 and A3 together (reachable + rankable): ${pct(both)}`);
const dists = rows.filter(r => r.readBelowDistance !== null).map(r => r.readBelowDistance);
if (dists.length) {
  console.log(`     distance to first read: median ${dists.sort((a, b) => a - b)[Math.floor(dists.length / 2)]}`
    + ` lines, max ${Math.max(...dists)}`);
}
console.log('\nReading: A1 low means the correct candidate is never generated and ranking cannot help.');
console.log('         A1 high but A2 low means it is generated and never reached inside the budget.');
