#!/usr/bin/env node
'use strict';

/**
 * Fill the generator's pantry: turn observed executions into retained claims Lari can talk about.
 *
 * The generator works. `claims -> composed English -> grounding oracle` runs end to end, and Lari can
 * say exactly as much as it can ground. Today it grounds itself and nothing else, so it answers
 * questions about its own repair method and declines everything else. That is not a missing generator;
 * it is a generator with nothing to say.
 *
 * Execution is the source to fill it from first, and the reason is the one that makes Lari different:
 * **Lari can run the code.** A claim generated from an observed run cannot be unfaithful to that run.
 * Retained research is faithful to a source that may itself be wrong; an execution claim is faithful to
 * what actually happened on this machine.
 *
 * What this does
 * --------------
 * Probes a repository's public callables with simple inputs, keeps only the observations that are
 * stable across two runs, and retains them as knowledge on the model. Afterwards Lari can answer
 * questions about that library from executions it performed rather than from text it read.
 *
 * The refusals, which are the point
 * ---------------------------------
 *   - an observation that differs between two runs is discarded (`intcomma(object())` embeds a memory
 *     address and would be false the moment it was stored)
 *   - a call the harness could not run at all yields nothing -- that is a fact about the machine, not
 *     about the code
 *   - every retained entry records the exact expression and what it returned, so any claim can be
 *     re-executed and checked
 *
 * Nothing here quantifies over inputs. Rule 12: observing `intword(1000)` says nothing about
 * `intword(1001)`, and the claim types carry no universal form to express it even if someone wanted to.
 *
 * Usage:
 *   node scripts/fill_lari_knowledge_from_repo.js --repo <dir> --module <name> --model <path> [--apply]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const execution = require(path.join(ROOT, 'swarm_execution_claims.js'));

function parseArgs(argv) {
  const args = { repo: null, module: null, model: null, apply: false, limit: 40 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') args.repo = path.resolve(argv[++i]);
    else if (argv[i] === '--module') args.module = argv[++i];
    else if (argv[i] === '--model') args.model = path.resolve(argv[++i]);
    else if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  for (const required of ['repo', 'module', 'model']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

/** Public callables of the module, asked of the interpreter rather than guessed from source. */
function publicCallables(repo, moduleName) {
  const probe = [
    'import json, inspect, sys',
    'sys.path.insert(0, "src"); sys.path.insert(0, ".")',
    `import ${moduleName} as m`,
    'names = [n for n in dir(m) if not n.startswith("_") and callable(getattr(m, n, None))]',
    'out = []',
    'for n in names:',
    '    try:',
    '        sig = inspect.signature(getattr(m, n))',
    '        required = [p for p in sig.parameters.values() if p.default is p.empty',
    '                    and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]',
    '        out.append({"name": n, "required": len(required)})',
    '    except Exception:',
    '        pass',
    'print(json.dumps(out))'
  ].join('\n');
  const run = spawnSync('python', ['-c', probe], { cwd: repo, encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (run.status !== 0) return [];
  try { return JSON.parse(String(run.stdout).trim().split(/\r?\n/).pop()); } catch (e) { return []; }
}

/** Inputs chosen to be ordinary, not to make anything look good. */
const ARGUMENTS_BY_ARITY = {
  1: ['0', '1', '1000', '1000000', "''", '[]', 'None'],
  2: ['1000, 2', "'a', 'b'"]
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply) {
    throw new Error('LARI_CANONICAL_LEARNED_RECORD_GATE: this legacy top-level knowledge writer is retired. Import observations through a non-promoted typed-record candidate instead.');
  }
  const callables = publicCallables(args.repo, args.module);
  if (!callables.length) {
    console.error(`No public callables found for ${args.module} in ${args.repo}`);
    process.exit(1);
  }

  const model = JSON.parse(fs.readFileSync(args.model, 'utf8'));
  model.knowledge = Array.isArray(model.knowledge) ? model.knowledge : [];
  const seen = new Set(model.knowledge.map(entry => entry.expression));

  const retained = [];
  const rejected = { unstable: 0, unusable: 0, duplicate: 0 };

  for (const callable of callables) {
    if (retained.length >= args.limit) break;
    const inputs = ARGUMENTS_BY_ARITY[callable.required] || ARGUMENTS_BY_ARITY[1];
    for (const input of inputs) {
      if (retained.length >= args.limit) break;
      const expression = `${args.module}.${callable.name}(${input})`;
      if (seen.has(expression)) { rejected.duplicate += 1; continue; }

      const observed = execution.observeAndClaim({
        repo: args.repo, imports: `import ${args.module}`, expression
      });
      if (!observed.observed) {
        if (/not deterministic/.test(String(observed.reason))) rejected.unstable += 1;
        else rejected.unusable += 1;
        continue;
      }
      seen.add(expression);
      retained.push({
        schemaVersion: 1,
        kind: 'execution_observation',
        subject: `${args.module}.${callable.name}`,
        expression,
        outcome: observed.outcome,
        value: observed.value,
        observedAt: new Date().toISOString(),
        verifiedBy: ['determinism', 'execution-provenance'],
        // Stated on every entry so no consumer can read this as a universal.
        meaning: 'one observed invocation on this machine; says nothing about other inputs'
      });
    }
  }

  console.log(`module            : ${args.module}`);
  console.log(`public callables  : ${callables.length}`);
  console.log(`observations kept : ${retained.length}`);
  console.log(`rejected          : unstable=${rejected.unstable} unusable=${rejected.unusable} duplicate=${rejected.duplicate}`);
  console.log('\nsample:');
  for (const entry of retained.slice(0, 8)) {
    console.log(`   ${entry.expression}  ->  ${entry.outcome} ${entry.value}`);
  }

  if (!args.apply) { console.log('\nDry run. Re-run with --apply to write the model.'); return; }
  model.knowledge = [...model.knowledge, ...retained];
  fs.writeFileSync(args.model, `${JSON.stringify(model, null, 2)}\n`);
  console.log(`\nwrote ${retained.length} observation(s) -> ${path.relative(ROOT, args.model)}`);
  console.log(`model.knowledge: ${model.knowledge.length}`);
}

try { main(); } catch (error) { console.error(String(error.message || error)); process.exit(1); }
