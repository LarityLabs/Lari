#!/usr/bin/env node
'use strict';

/**
 * Does goal selection reach the RIGHT capability, not merely a capability?
 *
 * The gate is measured elsewhere (`lari:goal-selection`) and answers "is this a goal at all". This
 * answers the separate question the gate cannot: given that it is a goal, is the capability chosen the
 * one that serves it. Observed while building the gate: "run the tests" is correctly identified as a
 * goal and then routes to `runLariSelfLearningAgendaExecutor`, which is a wrong answer delivered
 * confidently.
 *
 * A gate that correctly identifies goals and then runs the wrong capability is worse than no gate, so
 * this has to be a number before selection is switched on.
 *
 * Each case names the capability the request should reach. Where more than one capability would
 * genuinely serve the request, all acceptable ones are listed -- scoring a defensible choice as wrong
 * would make the number pessimistic and the diagnosis useless.
 *
 * Usage: node scripts/measure_lari_selection_quality.js [--model <path>]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
const dispatch = require(path.join(ROOT, 'swarm_capability_dispatch.js'));

const modelArg = process.argv.indexOf('--model');
const MODEL_PATH = modelArg >= 0
  ? path.resolve(process.argv[modelArg + 1])
  : path.join(ROOT, 'models', 'lari', 'trained', 'skill-registration-candidate.json');

const CASES = [
  { goal: 'consolidate my memory', expect: ['consolidateMemory'] },
  { goal: 'evaluate general intelligence', expect: ['evaluateGeneralIntelligence'] },
  { goal: 'run an autonomous training loop', expect: ['runAutonomousTrainingLoop'] },
  { goal: 'score the training holdouts', expect: ['scoreTrainingHoldouts'] },
  { goal: 'promote a compiled skill to an agent', expect: ['promoteCompiledSkillToAgent'] },
  { goal: 'infer your self learning agenda', expect: ['inferLariSelfLearningAgenda'] },
  { goal: 'run a personal model experience', expect: ['runLariPersonalModelExperience'] },
  { goal: 'register a modality lane', expect: ['registerLariModalityLane'] },
  { goal: 'build a capability graph', expect: ['buildLariCapabilityGraph'] },
  { goal: 'evaluate agent fitness', expect: ['evaluateAgentFitness'] },
  { goal: 'synthesize a modality generator', expect: ['synthesizeLariModalityGenerator'] },
  { goal: 'route a task graph skill', expect: ['routeTaskGraphSkill'] }
];

function main() {
  const model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  let correct = 0;
  let missed = 0;
  const wrong = [];

  for (const testCase of CASES) {
    const selected = dispatch.selectByGoal(runtime, model, testCase.goal);
    if (!selected) { missed += 1; wrong.push({ ...testCase, got: '(fell through to chat)' }); continue; }
    if (testCase.expect.includes(selected.capability)) correct += 1;
    else wrong.push({ ...testCase, got: `${selected.capability} (${selected.score.toFixed(2)})` });
  }

  console.log(`model            : ${path.relative(ROOT, MODEL_PATH)}`);
  console.log(`skills           : ${(model.compiledSkills || []).length}`);
  console.log(`correct capability: ${correct}/${CASES.length}`);
  console.log(`fell through      : ${missed}/${CASES.length}`);
  console.log(`wrong capability  : ${CASES.length - correct - missed}/${CASES.length}`);
  if (wrong.length) {
    console.log('\nnot reaching the expected capability:');
    for (const w of wrong) console.log(`   ${w.goal}\n      expected ${w.expect.join(' | ')}\n      got      ${w.got}`);
  }
  process.exit(0);
}

main();
