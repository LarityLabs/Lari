// Are the benchmarks testing ONE Lari, or 303 separate things?
const fs = require('fs');
const path = require('path');
const ROOT = 'C:/Users/goryg/.gemini/antigravity/scratch/html-agent-swarm';
const dir = path.join(ROOT, 'benchmarks');
const files = fs.readdirSync(dir).filter(f => f.startsWith('run_') && f.endsWith('.js'));

let message = 0, kernel = 0, realModel = 0, helperOnly = 0, neither = 0;
for (const f of files) {
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  const m = /sendMessageToLari/.test(t);
  const k = /runLariUnifiedTaskKernel/.test(t);
  const r = /models[\/\\]lari[\/\\]current|swarm-model\.json|activeModelPath|lari_model_registry/.test(t);
  const runtime = /swarm_model_runtime|SwarmModelRuntime/.test(t);
  if (m) message += 1;
  if (k) kernel += 1;
  if (r) realModel += 1;
  if (!m && !k && runtime) helperOnly += 1;
  if (!m && !k && !runtime) neither += 1;
}
console.log('benchmarks total            :', files.length);
console.log('call sendMessageToLari      :', message, '  <- the single chat/task entry point');
console.log('call the unified kernel     :', kernel);
console.log('touch the real model file   :', realModel);
console.log('require runtime but neither :', helperOnly);
console.log('do not touch the runtime    :', neither);
