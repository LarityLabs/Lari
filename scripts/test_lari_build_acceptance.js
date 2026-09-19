#!/usr/bin/env node
'use strict';

/**
 * Oracle for building rather than repairing.
 *
 * NOT a capability gate: a throwaway workspace and a tiny acceptance script.
 *
 * Building is where a system is most tempted to lie to itself, because "it works" is judged by
 * something the builder could, in principle, write. So the properties asserted here are mostly
 * refusals: a task that asks for nothing is refused, a check that cannot run is refused, and a
 * candidate is accepted only when the requester's own command exits zero. Lari never reads the check
 * to work out what would satisfy it -- it learns one bit, pass or fail.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const build = require(path.join(__dirname, '..', 'swarm_build_acceptance.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`); }
}

function workspace(acceptance) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-build-'));
  fs.writeFileSync(path.join(root, 'check.py'), acceptance, 'utf8');
  return root;
}

const ACCEPTANCE = [
  'import sys',
  "sys.path.insert(0, '.')",
  'from app import total_width',
  'assert total_width([]) == 0',
  "assert total_width(['ab', 'c']) == 3",
  "print('accepted')"
].join('\n');

const task = {
  name: 'total_width',
  spec: 'a function total_width(items) returning the summed length of the items',
  entry: 'app.py',
  acceptance: 'python check.py'
};
const project = {
  'existing.py': 'def helper(items):\n    total = 0\n    for it in items:\n        total += len(it)\n    return total\n'
};

console.log('build acceptance');

(async () => {
  const root = workspace(ACCEPTANCE);
  const prepared = build.prepareBuild(root, task);
  check('a stub fails the acceptance check before anything is built', prepared.ready === true, JSON.stringify(prepared.reason));

  const built = await build.buildUntilAccepted(root, task, { projectSources: project, limit: 120 });
  check('an implementation is produced', built.built === true, JSON.stringify(built.reason));
  check('the accepted code defines what was asked for',
    built.built && /def total_width\(/.test(built.implementation), String(built.implementation).slice(0, 120));
  check('acceptance is what decided it',
    build.runAcceptance(root, task).passed === true);
  check('no external model was called', built.externalModelCalls === 0);

  // A task whose check already passes asks for nothing, and building against it would record a
  // success that means nothing.
  const empty = workspace("print('accepted')");
  const emptyPrepared = build.prepareBuild(empty, { ...task, acceptance: 'python check.py' });
  check('a task that asks for nothing is refused', emptyPrepared.ready === false, JSON.stringify(emptyPrepared.reason));

  // A check that cannot run would make every candidate look like a failure.
  const broken = workspace('raise SystemExit(0)');
  const brokenPrepared = build.prepareBuild(broken, { ...task, acceptance: 'python definitely-not-here.py' });
  check('a check that cannot execute is refused', brokenPrepared.ready === false, JSON.stringify(brokenPrepared.reason));

  // Nothing to build from means nothing is claimed. No partial credit, no plausible stub left behind.
  const barren = workspace(ACCEPTANCE);
  const nothing = await build.buildUntilAccepted(barren, task, { projectSources: {}, limit: 40 });
  check('with no ingredients available, nothing is claimed', nothing.built === false, JSON.stringify(nothing.reason));
  check('and the workspace is left at the stub rather than half-written',
    /Not implemented/.test(fs.readFileSync(path.join(barren, 'app.py'), 'utf8')));

  for (const dir of [root, empty, broken, barren]) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* temp */ }
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
