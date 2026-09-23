#!/usr/bin/env node
/**
 * Measure creative refusals on IFEval prompts, before/after the fix.
 * Scratch research store + scratch model per prompt; live state untouched.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SCRATCH = path.join(process.env.HOME || '/root', 'workspace', 'scratch', 'creative-fix');
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.LARI_RESEARCH_STORE = path.join(SCRATCH, 'researched-knowledge.json');
if (!fs.existsSync(process.env.LARI_RESEARCH_STORE)) fs.writeFileSync(process.env.LARI_RESEARCH_STORE, '{}');

const ROOT = '/home/hatch/workspace/lari-github';
const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
const ccMod = require(path.join(ROOT, 'scripts', 'lari_creative_core.js'));
const BASE_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const INPUT = path.join(process.env.HOME || '/root', 'workspace', 'scratch', 'ifeval', 'input_data.jsonl');

const REFUSAL_RES = [
  /I cannot compose .*no generative language model/i,
  /I cannot do that one: a .* that is also valid code/i,
  /do not have enough grounded/i,
  /I will not fake one/i,
];

function freshModel(tag) {
  const dst = path.join(SCRATCH, `model-${tag}-${process.pid}.json`);
  const m = JSON.parse(fs.readFileSync(BASE_MODEL, 'utf8'));
  m.__lariSourcePath = dst;
  fs.writeFileSync(dst, JSON.stringify(m));
  return JSON.parse(fs.readFileSync(dst, 'utf8'));
}
function replyText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  return String(r.answer || r.text || r.reply || '');
}

(async () => {
  const onlyIdx = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
  const lines = fs.readFileSync(INPUT, 'utf8').trim().split('\n');
  const creative = [];
  lines.forEach((ln, i) => {
    const o = JSON.parse(ln);
    const p = o.prompt || '';
    if (ccMod.isCreativeRequest(p)) creative.push({ i, prompt: p });
  });
  console.log(`creative-detected prompts: ${creative.length} / ${lines.length}`);
  const targets = onlyIdx ? creative.filter(c => onlyIdx.includes(c.i)) : creative;
  console.log(`running: ${targets.length}`);

  const out = [];
  let n = 0;
  for (const c of targets) {
    n++;
    const model = freshModel('c' + c.i);
    let text = '';
    try {
      const p = runtime.sendMessageToLariAsync(model, c.prompt, { persistLearnedModel: false });
      const r = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60000))]);
      text = replyText(r);
    } catch (e) { text = 'ERROR: ' + e.message; }
    const refused = REFUSAL_RES.some(re => re.test(text));
    out.push({ i: c.i, refused, len: text.length, prompt: c.prompt.slice(0, 90), text: text.slice(0, 400) });
    if (n % 10 === 0) console.log(`  ${n}/${targets.length} refused-so-far=${out.filter(o => o.refused).length}`);
  }
  const refused = out.filter(o => o.refused);
  console.log(`\nRESULT: ${refused.length}/${out.length} refusals`);
  fs.writeFileSync(path.join(SCRATCH, 'measure-' + Date.now() + '.json'), JSON.stringify(out, null, 1));
  for (const r of refused.slice(0, 10)) console.log(`  #${r.i} :: ${r.prompt}`);
})().catch(e => { console.error(e); process.exit(1); });
