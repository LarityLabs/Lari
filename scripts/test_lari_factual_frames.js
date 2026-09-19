// Proves the factual question-frame parser generalizes: person / event-date /
// quantity / attribute / office-holder questions research the clean SUBJECT,
// distill frame-appropriate sentences, and retain only records that satisfy
// the frame's requested role. Runs against an ISOLATED model copy
// (LARI_MODEL_PATH) so the canonical model file is untouched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PROD_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
// Temp model copies live under the workspace, not /tmp: /tmp is a 512MB tmpfs
// and a model copy plus checkpoint backups exceeds it.
const TEST_BASE = path.join(ROOT, '..', 'tmp');
fs.mkdirSync(TEST_BASE, { recursive: true });
const TEST_DIR = fs.mkdtempSync(path.join(TEST_BASE, 'lari-frame-test-'));
const TEST_MODEL = path.join(TEST_DIR, 'swarm-model.json');

fs.copyFileSync(PROD_MODEL, TEST_MODEL);
process.env.LARI_MODEL_PATH = TEST_MODEL;

const registry = require('./lari_model_registry.js');
const runtime = require('../swarm_model_runtime.js');
const tools = require('../swarm_external_tools.js');

const prodMd5Before = crypto.createHash('md5').update(fs.readFileSync(PROD_MODEL)).digest('hex');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const frameCases = [
  ['who was Albert Einstein', 'person', 'Albert Einstein', 'identity'],
  ['who is Marie Curie', 'person', 'Marie Curie', 'identity'],
  ['who is the president of France', 'office_holder', 'France', 'current'],
  ['who was the president of France in 1990', 'office_holder', 'France', 'historical'],
  ['what is the capital of Italy', 'attribute', 'Italy', 'value'],
  ['when did World War II end', 'event_date', 'World War II', 'date'],
  ['when did World War I end', 'event_date', 'World War I', 'date'],
  ['in what year did the Titanic sink', 'event_date', 'Titanic', 'year'],
  ['when was the Eiffel Tower built', 'event_date', 'Eiffel Tower', 'date'],
  ['how many legs does a spider have', 'quantity', 'spider', 'count'],
  ['how many legs do spiders have', 'quantity', 'spiders', 'count'],
  ['how many continents are there', 'quantity', 'continents', 'count'],
  ['how many planets are in the solar system', 'quantity', 'solar system', 'count'],
  ['what is photosynthesis', 'definition', 'photosynthesis', 'definition'],
  ['what was the Neo-Assyrian Empire', 'definition', 'Neo-Assyrian Empire', 'definition'],
  ['what did Greg eat for breakfast', 'unknown', null, null],
  ['tell me a joke', 'unknown', null, null]
];

function partA() {
  for (const [q, frame, subject, role] of frameCases) {
    const f = tools.parseFactualFrame(q);
    check(`parse "${q}"`, f.frame === frame && f.subject === subject && f.role === role,
      `got ${f.frame}|${f.subject}|${f.role}`);
  }
  // The Hans Albert Einstein regression: a summary ABOUT the son must not
  // satisfy a question about the father.
  const hansSummary = 'Hans Albert Einstein (May 14, 1904 – July 26, 1973) was a Swiss-American engineer, the second child and first son of Albert Einstein.';
  const albertSummary = 'Albert Einstein (14 March 1879 – 18 April 1955) was a German-born theoretical physicist. He developed the theory of relativity.';
  const frame = tools.parseFactualFrame('who was Albert Einstein');
  check('frame gate rejects Hans summary for Albert question',
    runtime.frameAnswerSatisfied(frame, hansSummary) === false, 'hans must fail');
  check('frame gate accepts correct Albert summary',
    runtime.frameAnswerSatisfied(frame, albertSummary) === true, 'albert must pass');
  const dateFrame = tools.parseFactualFrame('when did World War II end');
  check('frame gate rejects dateless summary', runtime.frameAnswerSatisfied(dateFrame, 'World War II was a global conflict.') === false);
  check('frame gate accepts dated summary', runtime.frameAnswerSatisfied(dateFrame, 'World War II ended in 1945.') === true);
  const qtyFrame = tools.parseFactualFrame('how many legs does a spider have');
  check('frame gate rejects numberless summary', runtime.frameAnswerSatisfied(qtyFrame, 'Spiders are arachnids.') === false);
  check('frame gate accepts number-word summary', runtime.frameAnswerSatisfied(qtyFrame, 'Spiders have eight legs.') === true);
  // Neo-Assyrian article-stripping: "The Neo-Assyrian Empire was ..." must match subject "Neo-Assyrian Empire".
  const neoFrame = tools.parseFactualFrame('what was the Neo-Assyrian Empire');
  check('definition subject strips leading article', neoFrame.subject === 'Neo-Assyrian Empire', neoFrame.subject);
}

async function learnedProbe(model, question, expectAnswer, expectTopic) {
  const before = (model.lariLearnedRecords?.records || []).length;
  const response = await runtime.sendMessageToLariAsync(model, question, {});
  const after = (model.lariLearnedRecords?.records || []).length;
  const answer = String(response.answer || '');
  const retained = response.autonomousResearch?.retained === true;
  const answerOk = expectAnswer.test(answer);
  let topicOk = true;
  let topicDetail = '';
  if (expectTopic) {
    const rec = (model.lariLearnedRecords.records || [])[0];
    const recTopic = String(rec?.payload?.topic || rec?.topic || '');
    topicOk = !!rec && recTopic.toLowerCase().includes(expectTopic.toLowerCase());
    topicDetail = rec ? recTopic : 'no record';
  }
  check(`"${question}" retained`, retained, `records ${before}->${after}`);
  check(`"${question}" answer matches`, answerOk, answer.slice(0, 90));
  if (expectTopic) check(`"${question}" record topic is "${expectTopic}"`, topicOk, topicDetail);
  return response;
}

async function partB() {
  const { model } = registry.loadLariModel({});
  const startCount = (model.lariLearnedRecords?.records || []).length;

  await learnedProbe(model, 'who was Marie Curie', /curie/i, 'Marie Curie');
  await learnedProbe(model, 'who was Isaac Newton', /newton/i, 'Isaac Newton');
  await learnedProbe(model, 'when did World War I end', /1918/, 'World War I');
  await learnedProbe(model, 'in what year did the Berlin Wall fall', /1989/, 'Berlin Wall');
  await learnedProbe(model, 'how many legs does a spider have', /eight|\b8\b/i, 'spider');
  await learnedProbe(model, 'how many planets are in the solar system', /eight|\b8\b/i, 'solar system');
  await learnedProbe(model, 'what is the capital of Italy', /rome/i, 'Italy');

  // The Einstein regression, live: must retain a record ABOUT Albert Einstein,
  // never one whose definitional subject is his son Hans.
  const before = (model.lariLearnedRecords?.records || []).length;
  const einstein = await runtime.sendMessageToLariAsync(model, 'who was Albert Einstein', {});
  const after = (model.lariLearnedRecords?.records || []).length;
  const recs = model.lariLearnedRecords.records || [];
  const hansKept = recs.slice(0, Math.max(0, after - before))
    .some(r => /^\s*hans albert einstein\b/i.test(String(r.payload?.summary || '')));
  check('Einstein: no Hans record retained', !hansKept);
  check('Einstein: answer is about the physicist', /relativity|theoretical physicist/i.test(String(einstein.answer || '')),
    String(einstein.answer || '').slice(0, 90));

  // Office-holder machinery via stub source (stable, no time-sensitive facts).
  const stubSources = [{
    title: 'Ruritania facts', url: 'https://example.test/ruritania', sourceType: 'test',
    text: 'Ruritania is a small fictional country. The president of Ruritania is Ada Lovelace-Smith. She took office in 2020.'
  }];
  const officeBefore = (model.lariLearnedRecords?.records || []).length;
  const office = await runtime.sendMessageToLariAsync(model, 'who is the president of Ruritania', {
    research: { sourceProvider: () => stubSources, sourceAdapter: 'knowledge.test_stub' }
  });
  const officeAfter = (model.lariLearnedRecords?.records || []).length;
  check('office-holder: retained', office.autonomousResearch?.retained === true, `records ${officeBefore}->${officeAfter}`);
  check('office-holder: answer names the holder', /ada lovelace-smith/i.test(String(office.answer || '')),
    String(office.answer || '').slice(0, 90));

  // Junk probe: nothing retained, counts unchanged.
  const junkBefore = (model.lariLearnedRecords?.records || []).length;
  await runtime.sendMessageToLariAsync(model, 'what did Greg eat for breakfast', {});
  const junkAfter = (model.lariLearnedRecords?.records || []).length;
  check('junk question retains nothing', junkAfter === junkBefore, `${junkBefore}->${junkAfter}`);

  // Reload recall: fresh load of the TEMP model answers Curie from memory.
  const { model: model2 } = registry.loadLariModel({});
  const recall = await runtime.sendMessageToLariAsync(model2, 'who was Marie Curie', {
    autoResearchOnUncertainty: false,
    groundedFactual: false
  });
  check('fresh load recalls Curie from memory', /curie/i.test(String(recall.answer || '')),
    String(recall.answer || '').slice(0, 80));
  check('no research on recall', !recall.autonomousResearch);

  // Canonical model untouched.
  const prodMd5After = crypto.createHash('md5').update(fs.readFileSync(PROD_MODEL)).digest('hex');
  check('canonical model file untouched', prodMd5After === prodMd5Before, prodMd5After.slice(0, 12));
  const endCount = (model.lariLearnedRecords?.records || []).length;
  console.log(`\ntemp model records: ${startCount} -> ${endCount} (expected +9: 8 retained live + 1 stub)`);
}

async function main() {
  partA();
  await partB();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
