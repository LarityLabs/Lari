#!/usr/bin/env node
'use strict';

/**
 * RETIRED diagnostic: benchmark call-site names must not be registered as compiled skills.
 *
 * The distinction this serves
 * --------------------------
 * A keyword router maps phrases to functions and makes the user name the capability. Selection maps a
 * *goal* to a capability: the user says "fix the failing test" and the router ranks capabilities
 * against that request. Lari already has the selection machinery -- `routeCompiledSkill` picks a skill,
 * `executeLariSelectedLearnedCapability` runs it -- and 67 compiled skills to choose from. What it
 * lacks is the 151 measured runtime capabilities being *in* that set, so the router has nothing to
 * select them by.
 *
 * Every descriptor is derived from evidence, never from a function name
 * --------------------------------------------------------------------
 * A skill descriptor is a claim about what a capability does. Written by hand from identifiers they
 * would overstate reach -- the direction every wrong claim in this repository has gone. So:
 *
 *   - the capability set comes from `CAPABILITY_WIRING.json`, which records what benchmarks call
 *   - `confidence` is the measured pass rate of the benchmarks that invoke it, from `PHASE0_SURVEY.json`
 *   - a capability whose invoking benchmarks all FAIL is not registered at all
 *   - `evidence` on each skill names the benchmarks, so any claim is checkable
 *
 * A descriptor with no passing benchmark behind it is a hypothesis, not a skill, and this refuses to
 * write one. That refusal is the point: registering all 151 regardless would hand the router a
 * catalogue of things that do not work.
 *
 * Usage:
 *   node scripts/register_lari_runtime_skills.js --model <path> [--apply] [--limit N]
 * Without --apply it reports what it would register and writes nothing.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

function parseArgs(argv) {
  const args = { model: null, apply: false, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--model') args.model = path.resolve(argv[++i]);
    else if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.model) throw new Error('--model is required');
  return args;
}

/** Split an identifier into the words a router can match on. */
function conceptsFrom(name) {
  return String(name)
    .replace(/^run|^build|^infer|^evaluate|^score|^promote|^consolidate|^synthesize|^register/, m => m)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/Lari/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && w !== 'run');
}

/** A readable goal phrase, used as the trigger text and the procedure's first step. */
function goalPhrase(name) {
  const words = conceptsFrom(name);
  return words.join(' ');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const error = new Error(`LARI_CAPABILITY_INTEGRITY_GATE: refused ${args.apply ? 'write' : 'dry-run'} registration of benchmark call-site metadata as compiled skills. A capability needs a canonical typed record plus a verified lariExecution contract before it may enter a model candidate.`);
  error.code = 'LARI_CAPABILITY_INTEGRITY_GATE';
  throw error;
  const wiring = read('holdouts/CAPABILITY_WIRING.json');
  const survey = read('holdouts/PHASE0_SURVEY.json');
  const model = JSON.parse(fs.readFileSync(args.model, 'utf8'));

  // Which benchmarks invoke each capability, and did they pass?
  const BENCH = path.join(ROOT, 'benchmarks');
  const files = fs.readdirSync(BENCH).filter(f => f.startsWith('run_') && f.endsWith('.js'));
  const invokers = new Map();
  for (const file of files) {
    const text = fs.readFileSync(path.join(BENCH, file), 'utf8');
    for (const m of text.matchAll(/\b(?:runtime|SwarmModelRuntime|api)\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
      if (!invokers.has(m[1])) invokers.set(m[1], []);
      invokers.get(m[1]).push(file);
    }
  }

  const existing = new Set((model.compiledSkills || []).map(s => s.capability));
  const candidates = (wiring.unwired || []).map(u => u.capability);

  const registered = [];
  const refused = [];

  for (const capability of candidates) {
    if (args.limit && registered.length >= args.limit) break;
    if (existing.has(capability)) { refused.push({ capability, why: 'already a compiled skill' }); continue; }

    const benchmarks = [...new Set(invokers.get(capability) || [])];
    const outcomes = benchmarks.map(b => (survey.results[b] || {}).outcome).filter(Boolean);
    const passing = outcomes.filter(o => o === 'pass').length;

    // The refusal that makes this honest: no passing benchmark, no skill.
    if (!outcomes.length) { refused.push({ capability, why: 'no benchmark outcome recorded' }); continue; }
    if (passing === 0) {
      refused.push({ capability, why: `all ${outcomes.length} invoking benchmark(s) fail; a hypothesis, not a skill` });
      continue;
    }

    const concepts = conceptsFrom(capability);
    if (concepts.length < 2) { refused.push({ capability, why: 'name yields too few trigger concepts' }); continue; }

    // The embedding is what the router actually scores against.
    //
    // The first version omitted it, and 128 correctly-registered skills were unselectable: every
    // pre-existing skill carries a triggerEmbedding vector, so one without scored zero and lost to
    // anything -- "run a swarm mission" routed to grammatical_conjugation.
    //
    // Generated with the runtime's own `embedTextForModel`, the same routine `compileSkills` uses at
    // line 535, rather than a second implementation. A parallel embedder would drift from the router
    // that consumes it, which is how this repository ended up with two chat lanes that disagree.
    // Trigger text comes from the capability name, and the attempt to enrich it FAILED.
    //
    // Adding vocabulary from the benchmark filenames that invoke each capability looked obviously
    // right -- this file's own design note argued descriptors should come from evidence rather than
    // identifiers, and near-neighbours were beating the correct answer. Measured: selection quality
    // went from 9/12 to 4/12. "consolidate my memory" stopped reaching `consolidateMemory` at all.
    //
    // Benchmark names are written to describe a test, not the capability, and they share heavy
    // boilerplate -- training, cycle, growth, transfer, eval. Pouring that into the trigger buries the
    // one distinguishing word under a dozen generic ones.
    //
    // Evidence belongs in `confidence`, where it is a measured pass rate and means something. It does
    // not belong in the matching text. Reverted, and recorded so it is not "improved" this way again.
    const triggerText = `${goalPhrase(capability)} ${concepts.join(' ')}`;
    const triggerEmbedding = runtime.embedTextForModel(model, triggerText);

    registered.push({
      triggerEmbedding,
      id: `skill.runtime.${capability}`,
      sourceKnowledgeId: `runtimeCapability.${capability}`,
      topic: goalPhrase(capability),
      capability,
      status: 'compiled',
      // Measured, not asserted: the share of invoking benchmarks that pass.
      confidence: Number((passing / outcomes.length).toFixed(4)),
      triggerConcepts: concepts,
      procedure: [`invoke the runtime capability ${capability}`, 'verify against its own benchmark evidence'],
      answerTemplate: `I can ${goalPhrase(capability)} by running my ${capability} capability.`,
      selfTest: { query: goalPhrase(capability), expectCapability: capability },
      compiledAt: new Date().toISOString(),
      // Provenance, so every claim this skill makes is checkable.
      evidence: {
        invokingBenchmarks: benchmarks,
        passing,
        total: outcomes.length,
        meaning: 'confidence is the measured pass rate of the benchmarks that invoke this capability, '
          + 'not an estimate of how well it serves a user goal'
      }
    });
  }

  console.log(`candidates            : ${candidates.length}`);
  console.log(`would register        : ${registered.length}`);
  console.log(`refused               : ${refused.length}`);
  const byReason = {};
  for (const r of refused) byReason[r.why.replace(/\d+/g, 'N')] = (byReason[r.why.replace(/\d+/g, 'N')] || 0) + 1;
  for (const [why, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(3)}  ${why}`);
  }
  console.log('\ntop registrations by measured confidence:');
  for (const s of [...registered].sort((a, b) => b.confidence - a.confidence).slice(0, 12)) {
    console.log(`   ${s.confidence.toFixed(2)}  ${s.capability}  (${s.evidence.passing}/${s.evidence.total} benchmarks)`);
  }

  if (!args.apply) { console.log('\nDry run. Re-run with --apply to write the model.'); return; }

  model.compiledSkills = [...(model.compiledSkills || []), ...registered];
  fs.writeFileSync(args.model, `${JSON.stringify(model, null, 2)}\n`);
  console.log(`\nwrote ${registered.length} skill(s) -> ${args.model}`);
  console.log(`compiledSkills: ${model.compiledSkills.length}`);
}

try { main(); } catch (error) { console.error(String(error.message || error)); process.exit(1); }
