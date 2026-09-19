#!/usr/bin/env node
'use strict';

/**
 * Which benchmark-invoked runtime functions are named in public-kernel source, and which are not?
 *
 * The goal is a unified model: everything Lari can do, reachable through the one chat entry point.
 * Today 228 of 303 benchmarks reach past that entry point and invoke runtime internals directly, so
 * the functions are proven to exist, but neither user reachability nor useful behavior is thereby
 * proven. This turns that static gap into an investigation list, not a capability catalogue.
 *
 * Method, and its limits
 * ----------------------
 * For every benchmark that does not call `sendMessageToLari`, extract the runtime API functions it
 * calls. Then check whether the kernel's dispatch surface mentions each one. A function the kernel
 * never names may still sit behind a higher-level function, so absence requires a dynamic trace before
 * any reachability conclusion.
 *
 * This is a static approximation and it is stated as one. A name appearing in the kernel is evidence
 * of a possible route, not proof the route is reachable for a given prompt, and a name absent from the
 * kernel says only that the function is not directly named there. **No row is capability evidence.**
 *
 * Usage: node scripts/audit_lari_capability_wiring.js [--json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BENCH = path.join(ROOT, 'benchmarks');
const RUNTIME = path.join(ROOT, 'swarm_model_runtime.js');

const runtimeText = fs.readFileSync(RUNTIME, 'utf8');

// The capability surface, taken from what benchmarks actually call rather than from how the runtime
// happens to export things.
//
// The first version read `api.<name> =` assignments and found 62 functions covering only 64 of 303
// benchmarks. The other 222 were invisible, because most of the surface is not assigned that way --
// they call `runtime.ingestKnowledge`, `runtime.compileSkills`, `runtime.routeCompiledSkill` and so on,
// and none of those matched. Measuring the exporter rather than the consumer left 73% of the
// benchmarks out of the worklist, which is the kind of blind spot that gets reported as a small number
// and believed.
//
// Reading the call sites makes the set complete for direct benchmark runtime calls. It does not turn
// those calls into model capabilities.
function capabilityNamesFromBenchmarks(files, dir) {
  const names = new Map();
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of text.matchAll(/\b(?:runtime|SwarmModelRuntime|api)\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
      if (!names.has(m[1])) names.set(m[1], new Set());
      names.get(m[1]).add(file);
    }
  }
  return names;
}

/**
 * The kernel's dispatch surface: the body of runLariUnifiedTaskKernel and the capability executor.
 * A capability reachable by asking has to be named somewhere in here.
 */
function sliceBetween(text, startPattern, maxChars) {
  const i = text.search(startPattern);
  return i < 0 ? '' : text.slice(i, i + maxChars);
}
const kernelSurface = [
  sliceBetween(runtimeText, /function runLariUnifiedTaskKernel/, 120000),
  sliceBetween(runtimeText, /function executeLariSelectedLearnedCapability/, 60000),
  sliceBetween(runtimeText, /function sendMessageToLari/, 40000)
].join('\n');

const benchmarks = fs.readdirSync(BENCH).filter(f => f.startsWith('run_') && f.endsWith('.js'));
const internalsOnly = benchmarks.filter(f => !/sendMessageToLari/.test(fs.readFileSync(path.join(BENCH, f), 'utf8')));
const usage = capabilityNamesFromBenchmarks(internalsOnly, BENCH);
const apiNames = new Set(usage.keys());

const rows = [...usage.entries()]
  .map(([name, files]) => ({
    name,
    count: files.size,
    askable: new RegExp(`\\b${name}\\b`).test(kernelSurface)
  }))
  .sort((a, b) => (a.askable === b.askable ? b.count - a.count : (a.askable ? 1 : -1)));

// How many of the bypassing benchmarks does this worklist actually speak for? Reported, because the
// previous version covered 64 of 303 and did not say so.
const covered = new Set();
for (const files of usage.values()) for (const f of files) covered.add(f);

const unwired = rows.filter(r => !r.askable);
const wired = rows.filter(r => r.askable);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    schemaVersion: 1,
    kind: 'lari.capability-wiring',
    apiSurface: apiNames.size,
    exercisedByInternalsBenchmarks: rows.length,
    reachableFromChat: wired.length,
    notReachableFromChat: unwired.length,
    caveat: 'Static approximation only. A benchmark-invoked runtime function is not a model capability. '
      + 'A name in the kernel is evidence of a possible direct reference, not proof of public reachability; '
      + 'absence does not account for calls behind higher-level functions.',
    unwired: unwired.map(r => ({ capability: r.name, benchmarksUsingIt: r.count })),
    wired: wired.map(r => r.name)
  }, null, 2));
  process.exit(0);
}

console.log(`benchmarks bypassing the chat door : ${internalsOnly.length} of ${benchmarks.length}`);
console.log(`  ... this worklist speaks for     : ${covered.size} of them`);
console.log(`distinct runtime functions invoked  : ${apiNames.size}`);
console.log(`  directly named in kernel source   : ${wired.length}`);
console.log(`  not directly named in kernel      : ${unwired.length}`);
console.log('\nTop functions not directly named in the kernel, by benchmark call-site count.');
console.log('These require dynamic public-surface investigation; they are not capability claims:\n');
for (const r of unwired.slice(0, 30)) {
  console.log(`  ${String(r.count).padStart(3)} benchmark(s)   ${r.name}`);
}
console.log('\nStatic approximation only -- no row is evidence of a user capability.');
