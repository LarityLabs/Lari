// Quality sample harness: essay, story, haiku, determinism.
// Usage: node scripts/gen_quality_samples.js
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./lari_generative_core.js');

const researchPath = process.env.LARI_RESEARCH_JSON ||
  path.join(__dirname, '..', 'models', 'lari', 'current', 'researched-knowledge.json');
const raw = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
const byTopic = (re) => {
  const e = raw.find(x => re.test(x.topic));
  return e ? e.sentences : [];
};

function show(label, prompt, sentences) {
  const gen = core.generate({ prompt, sentences });
  console.log('='.repeat(70));
  console.log(label);
  console.log('prompt:', prompt);
  if (!gen) { console.log('RESULT: null (honest shortfall)'); return null; }
  console.log('verified:', gen.verified, '| qualityUsed:', gen.qualityUsed,
    '| words:', (gen.text || '').match(/\w+/g || []).length);
  console.log('discourse:', JSON.stringify(gen.qualityStats && gen.qualityStats.discourse));
  console.log('-'.repeat(70));
  console.log(gen.text);
  console.log();
  return gen.text;
}

const essaySent = byTopic(/sunni/i);
const essayPrompt = 'Write a 400-word essay about the differences between Sunni and Shia Muslims.';
const t1 = show('ESSAY', essayPrompt, essaySent);

// determinism: same prompt twice must be byte-identical
const t2 = core.generate({ prompt: essayPrompt, sentences: essaySent });
console.log('='.repeat(70));
console.log('DETERMINISM:', t1 === (t2 && t2.text) ? 'BYTE-IDENTICAL' : 'MISMATCH');

// story: use a topic with narrative-ish sentences if available, else hammock
const storySent = byTopic(/hammock/i);
show('STORY', 'Write a short original story about a hammock.', storySent);

// haiku: no ocean research exists in the store, so the honest input is an
// empty pool (topic words + generic fillers), not unrelated travel sentences
show('HAIKU', 'Write a haiku about the ocean.', []);
