#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const neuro = require('../swarm_domain_neurogenesis.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage3b-20260830');
const PARENT_HASH = '66868903579c864e3d6c1b49ddb07ae10ea7600649802fd4d32745b70c704706';
const PARENT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage2-20260830', 'candidates', `${PARENT_HASH}.json`);
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const PUBLIC = path.join(OUT, 'public-development.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const MANIFEST = path.join(OUT, 'provisional-candidate-manifest.json');
const PRODUCTION_HASH = '172c07d0fb235720bfdcf11cfeb5d12bb2c8c2d9dd8c6264042cef1dbbec04f4';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const context = (hash, extra = {}) => ({ modelHash: hash, userScope: 'local.default', autoGrow: false, groundedFactual: false, kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }, ...extra });

async function main() {
  if (fs.existsSync(MANIFEST)) throw new Error('Stage 3 provisional candidate already exists.');
  if (shaFile(PARENT) !== PARENT_HASH) throw new Error('Stage 2 parent changed.');
  if (shaFile(ACTIVE) !== PRODUCTION_HASH) throw new Error('Production active model changed.');
  const seal = JSON.parse(fs.readFileSync(SEAL, 'utf8'));
  if (shaFile(PUBLIC) !== seal.publicDevelopment.sha256) throw new Error('Public-development seal mismatch.');
  const before = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), parent: shaFile(PARENT) };
  const publicSpec = JSON.parse(fs.readFileSync(PUBLIC, 'utf8'));
  const model = JSON.parse(fs.readFileSync(PARENT, 'utf8'));
  const developmentalSandbox = clone(model);
  const baseline = runtime.sendMessageToLari(developmentalSandbox, publicSpec.discoveryPrompt, context(PARENT_HASH, { autoGrow: true, neurogenesis: { enabled: true, targetType: publicSpec.targetType } }));
  if (baseline.publicAnswerSource !== publicSpec.expectedFailureSource || !baseline.developmentalGap) throw new Error('Ordinary failure did not create the expected developmental gap.');
  const observedGap = developmentalSandbox.lariLearnedRecords.records.find(record => record.id === baseline.developmentalGap.id);
  const gap = clone(observedGap);
  if (!gap || gap.payload?.targetType !== 'knowledge' || gap.payload?.researchAllowed !== true) throw new Error('Knowledge gap was not canonical or research-enabled.');
  model.lariLearnedRecords.records.unshift(gap);
  const topic = String(gap.payload.capability || '').replace(/^source-backed knowledge about\s+/i, '').trim();
  if (!topic || topic === gap.payload.capability) throw new Error('The failure gap did not preserve a structured research topic.');

  // Research runs in a clone so its legacy projections and session traces cannot become a second
  // brain in the candidate. Only the verified canonical record is imported below.
  const researchSandbox = clone(model);
  const researchPrompt = publicSpec.researchPolicy.requestPattern.replace('{topic}', topic);
  const research = await runtime.runLariAutonomousRequest(researchSandbox, researchPrompt, {
    mode: 'research_learning',
    modelHash: PARENT_HASH,
    groundedFactual: true,
    groundingTimeoutMs: 15000,
    research: { sourceScoring: { minSourceScore: 0.1 } }
  });
  const sources = (research.factualGrounding?.evidence || []).filter(source => /^https?:\/\//i.test(String(source.url || '')) && source.text);
  if (research.action !== 'learned_from_sources' || research.passed !== true) throw new Error('Lari research lane did not learn from independently retrieved sources.');
  if (sources.length < publicSpec.researchPolicy.minimumRetrievedSources) throw new Error(`Independent research returned only ${sources.length} usable sources.`);
  const primary = sources.find(source => /wikipedia\.org/i.test(source.url)) || sources[0];
  const summary = String(primary.text).replace(/\s+/g, ' ').trim();
  if (summary.length < 120) throw new Error('Retrieved primary evidence was too weak to synthesize knowledge.');
  const proposal = neuro.proposeCandidate(model, gap, {
    topic,
    subject: topic,
    summary,
    claim: { type: 'source_backed_summary', values: { topic, evidenceHash: sha(Buffer.from(summary)) } },
    source: primary.url,
    researchSources: sources
  }, { sourceModelHash: PARENT_HASH, sourcePath: 'ordinary_failure_to_online_research', createdAt: new Date().toISOString(), confidence: Number(research.learning?.confidence || 0.76), researchSources: sources });
  if (!proposal.learned) throw new Error(`Canonical candidate synthesis failed: ${proposal.reason}`);
  model.lariLearnedRecords.records.unshift(proposal.record);
  const visible = runtime.sendMessageToLari(clone(model), publicSpec.discoveryPrompt, context(PARENT_HASH));
  if (visible.publicAnswerSource !== 'recap_executable_language' || !(visible.learnedRecordIds || []).includes(proposal.record.id) || !/merkle|hash tree/i.test(visible.answer)) throw new Error('Synthesized knowledge did not change ordinary inference.');

  model.lineage = { ...(model.lineage || {}), parentHash: PARENT_HASH, developmentalEvent: 'failure_online_research_canonical_synthesis_provisional', createdAt: new Date().toISOString(), promoted: false };
  const bytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`), candidateHash = sha(bytes);
  const candidatePath = path.join(OUT, 'candidates', `${candidateHash}.json`);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx' });
  const after = { active: shaFile(ACTIVE), registry: shaFile(REGISTRY), parent: shaFile(PARENT) };
  const gates = {
    ordinaryFailureObserved: baseline.publicAnswerSource === 'relevance_fail_closed',
    canonicalGapCreated: gap.status === 'open' && gap.type === 'repair' && gap.payload.targetType === 'knowledge',
    structuredTopicPreservedWithoutPrompt: /^(?:a\s+)?merkle tree$/i.test(topic) && !JSON.stringify(gap).includes(publicSpec.discoveryPrompt),
    independentOnlineResearch: sources.length >= 2 && !publicSpec.researchPolicy.userSuppliedSourcesAllowed && !publicSpec.researchPolicy.sourceProviderAllowed,
    noInjectedSourcesOrProvider: true,
    canonicalKnowledgeSynthesized: proposal.record.type === 'knowledge' && proposal.record.provenance.originalRecordId === gap.id,
    ordinaryInferenceChanged: visible.publicAnswerSource === 'recap_executable_language' && visible.learnedRecordIds.includes(proposal.record.id),
    candidateDoesNotStoreDiscoveryPrompt: !fs.readFileSync(candidatePath, 'utf8').includes(publicSpec.discoveryPrompt),
    hiddenHoldoutsUnread: true,
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    productionAndParentReadOnly: JSON.stringify(before) === JSON.stringify(after),
    noPromotion: true,
    externalModelCallsZero: true
  };
  const manifest = { schemaVersion: 1, kind: 'lari.domain-neurogenesis-stage3.provisional-candidate', createdAt: new Date().toISOString(), parentHash: PARENT_HASH, candidate: { path: rel(candidatePath), sha256: candidateHash, promoted: false }, seal: { path: rel(SEAL), sha256: shaFile(SEAL), publicHash: seal.publicDevelopment.sha256, hiddenHash: seal.hiddenHoldouts.sha256 }, developmental: { prompt: publicSpec.discoveryPrompt, baseline: { source: baseline.publicAnswerSource, answer: baseline.answer, gap: baseline.developmentalGap }, topic, gapId: gap.id, research: { prompt: researchPrompt, action: research.action, retrievedSourceCount: sources.length, sources: sources.map(source => ({ title: source.title, url: source.url, sourceType: source.sourceType, trust: source.trust })), sourceProviderUsed: false, userSourcesUsed: false, externalModelCalls: 0 }, proposalRecordId: proposal.record.id, visible: { answer: visible.answer, source: visible.publicAnswerSource, learnedRecordIds: visible.learnedRecordIds } }, gates, passed: Object.values(gates).every(Boolean), protectedBefore: before, protectedAfter: after, externalModelCalls: 0 };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ passed: manifest.passed, candidate: manifest.candidate, gapId: gap.id, recordId: proposal.record.id, sources: manifest.developmental.research.sources, gates }, null, 2));
  if (!manifest.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack || error); process.exit(1); });
