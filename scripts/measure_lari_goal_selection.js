// Measure goal-selection against a fixed set. Both error types, reported once, no tuning.
const fs = require('fs');
const rt = require('C:/Users/goryg/.gemini/antigravity/scratch/html-agent-swarm/swarm_model_runtime.js');
const dispatch = require('C:/Users/goryg/.gemini/antigravity/scratch/html-agent-swarm/swarm_capability_dispatch.js');
const model = JSON.parse(fs.readFileSync(
  'C:/Users/goryg/.gemini/antigravity/scratch/html-agent-swarm/models/lari/trained/skill-registration-candidate.json', 'utf8'));

// Goals that SHOULD reach a capability (any sensible one -- we score "routed at all").
const GOALS = [
  'consolidate my memory',
  'build a graph of your capabilities',
  'evaluate general intelligence',
  'run an autonomous training loop',
  'score the training holdouts',
  'promote a compiled skill to an agent',
  'infer your self learning agenda',
  'run a personal model experience'
];

// Ordinary conversation that must NOT reach a capability.
const CHAT = [
  'hello how are you',
  'what is the weather',
  'thanks for that',
  'can you help me',
  'what did we do yesterday',
  'that looks wrong to me',
  'tell me a bit about yourself',
  'ok cool',
  'why did that test fail',
  'i think we should try something else'
];

let routed = 0, missed = [];
for (const g of GOALS) {
  const s = dispatch.selectByGoal(rt, model, g);
  if (s) routed += 1; else missed.push(g);
}
let falseMatches = [];
for (const c of CHAT) {
  const s = dispatch.selectByGoal(rt, model, c);
  if (s) falseMatches.push(`${c}  ->  ${s.capability} (${s.score.toFixed(2)})`);
}

console.log(`floor = ${dispatch.SELECTION_FLOOR ?? 0.6}`);
console.log(`goals routed        : ${routed}/${GOALS.length}`);
console.log(`chat false matches  : ${falseMatches.length}/${CHAT.length}   <- must be 0`);
if (missed.length) { console.log('\nmissed goals:'); for (const m of missed) console.log('   ' + m); }
if (falseMatches.length) { console.log('\nFALSE MATCHES:'); for (const f of falseMatches) console.log('   ' + f); }
