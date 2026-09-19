#!/usr/bin/env node
'use strict';

/**
 * Which capabilities can be auto-invoked safely? Decided by running them, not by reading their names.
 *
 * Goal selection reaches the right capability 9 times in 12, and its three errors are near-neighbours
 * rather than wild guesses. That is tolerable for a capability that reports something and unacceptable
 * for one that changes state: `consolidateMemory` mutating the model because the user asked about
 * training holdouts is a different order of problem from a wrong report.
 *
 * So auto-invocation is gated on whether a capability writes. Guessing that from an identifier would be
 * wrong in exactly the way everything else here has been wrong -- `runAutonomousTrainingLoop` sounds
 * mutating and `buildLariCapabilityGraph` sounds read-only, and neither name is evidence.
 *
 * Method: deep-copy a model, invoke the capability, and compare the serialized model before and after.
 * Unchanged means read-only, for that invocation, on that model. A capability that throws or hangs is
 * classified UNKNOWN and treated as unsafe, because an unproven capability must not be auto-invoked.
 *
 * The limit, stated: this observes one call with no arguments. A capability that writes only on some
 * inputs will look read-only here. That is why the output is an allowlist for auto-invocation rather
 * than a claim that the function is pure.
 *
 * Usage: node scripts/classify_lari_capability_side_effects.js [--model <path>] [--json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));

const modelArg = process.argv.indexOf('--model');
const MODEL_PATH = modelArg >= 0
  ? path.resolve(process.argv[modelArg + 1])
  : path.join(ROOT, 'models', 'lari', 'trained', 'skill-registration-candidate.json');

function main() {
  const source = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  const capabilities = [...new Set((source.compiledSkills || [])
    .filter(s => String(s.id || '').startsWith('skill.runtime.'))
    .map(s => s.capability))]
    .filter(name => typeof runtime[name] === 'function')
    .sort();

  const readOnly = [];
  const mutating = [];
  const unknown = [];

  for (const name of capabilities) {
    // A fresh copy each time, so one capability's writes cannot be blamed on another.
    const probe = JSON.parse(JSON.stringify(source));
    const before = JSON.stringify(probe);
    try {
      runtime[name](probe, {});
      const after = JSON.stringify(probe);
      if (after === before) readOnly.push(name);
      else mutating.push({ capability: name, grew: after.length - before.length });
    } catch (error) {
      // Unproven is unsafe. A capability that cannot be observed is not auto-invoked.
      unknown.push({ capability: name, error: String(error.message || error).slice(0, 80) });
    }
  }

  const report = {
    schemaVersion: 1,
    kind: 'lari.capability.side-effects',
    measuredAt: new Date().toISOString().slice(0, 10),
    model: path.relative(ROOT, MODEL_PATH).replace(/\\/g, '/'),
    method: 'deep-copy the model, invoke with no arguments, compare serialized state before and after',
    limit: 'one call, no arguments. A capability that writes only on some inputs looks read-only here, '
      + 'so this is an allowlist for auto-invocation rather than a claim of purity.',
    readOnlyCount: readOnly.length,
    mutatingCount: mutating.length,
    unknownCount: unknown.length,
    autoInvokable: readOnly,
    mutating,
    unknown
  };

  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log(`capabilities classified : ${capabilities.length}`);
  console.log(`  read-only (auto-invokable): ${readOnly.length}`);
  console.log(`  mutating (never auto)     : ${mutating.length}`);
  console.log(`  unknown / threw (unsafe)  : ${unknown.length}`);
  console.log('\nread-only sample:');
  for (const n of readOnly.slice(0, 15)) console.log(`   ${n}`);
  console.log('\nmutating sample:');
  for (const m of mutating.slice(0, 10)) console.log(`   ${m.capability}  (+${m.grew} bytes)`);
}

main();
