'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const runtime = require('../swarm_model_runtime');
const tools = require('../swarm_external_tools');
const capability = require('../swarm_research_to_capability');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const active = path.join(root, 'models/lari/current/swarm-model.json');
const registry = path.join(root, 'models/lari/registry.json');
const fingerprint = () => ({ active: sha(fs.readFileSync(active)), registry: sha(fs.readFileSync(registry)) });
(async () => {
  const before = fingerprint(), model = JSON.parse(fs.readFileSync(active));
  const ids = new Set(model.lariLearnedRecords.records.map(r => r.id));
  const response = await runtime.runLariAutonomousRequest(model, 'Research Python floor division operator', {
    mode: 'research_learning', autoGrow: false, groundingTimeoutMs: 8000
  });
  const added = model.lariLearnedRecords.records.filter(r => !ids.has(r.id));
  const dir = path.join(root, 'consolidation', `live-research-lifecycle-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(model));
  const candidate = path.join(dir, `${sha(bytes)}.json`);
  fs.writeFileSync(candidate, bytes, { flag: 'wx' });
  const reloaded = JSON.parse(fs.readFileSync(candidate));
  const recall = runtime.searchKnowledge(reloaded, 'Python floor division operator', { limit: 5, minScore: 0 });
  const web = await tools.resolveResearchEvidence('Research Python floor division operator', { timeoutMs: 8000 });
  const extraction = capability.extractOperatorForConcept(web.sources, 'floor division');
  const report = {
    createdAt: new Date().toISOString(), before, after: fingerprint(),
    chat: { action: response.action, answer: response.answer, addedIds: added.map(r => r.id),
      retainedAfterReload: added.every(r => reloaded.lariLearnedRecords.records.some(x => x.id === r.id)),
      recallIds: recall.map(hit => hit.learnedRecordId || hit.item?.id || hit.id),
      evidenceUrls: response.factualGrounding?.evidence?.map(s => s.url) || [] },
    codingResearch: { operator: extraction.operator, support: extraction.support,
      evidenceUrls: web.sources.map(s => s.url), executableRepairTested: false },
    candidate: { path: candidate, sha256: sha(bytes), promoted: false },
    limitations: ['Development integration check, not a hidden holdout.', 'JSON retention and retrieval do not prove answer quality or executable repair.', 'Two documentation pages are from one publisher.']
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  if (JSON.stringify(report.before) !== JSON.stringify(report.after) || !added.length || extraction.operator !== ' // ') process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
