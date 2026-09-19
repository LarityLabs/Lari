#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tools = require('../swarm_external_tools.js');
const runtime = require('../swarm_model_runtime.js');

const root = path.resolve(__dirname, '..');
const candidatePath = path.join(root, 'consolidation', 'learning-candidates', 'eb1472a0000de793fa798e0ca60cc6fd5fac8025142d284be149e31689d79dc1.json');

async function main() {
  assert.strictEqual(tools.extractLearningTopic('How a Bloom filter works and why it can return false positives'), 'Bloom filter');
  let requestedUrl = '';
  const knowledge = await tools.resolveKnowledge('Bloom filter', {
    fetch: async url => {
      requestedUrl = String(url);
      return { ok: true, json: async () => ({ query: { pages: [{ title: 'Bloom filter', extract: 'A Bloom filter is a probabilistic data structure.' }] } }) };
    }
  });
  assert(requestedUrl.includes('/w/api.php?action=query&prop=extracts'));
  assert.strictEqual(knowledge.topic, 'Bloom filter');
  assert(fs.existsSync(candidatePath));
  const model = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const recordId = 'lari.learned.knowledge.e0a3f6aeba76a4e3b38e450a';
  const prompts = [
    'Explain Bloom filter in plain language.',
    'What should I understand about Bloom filter?',
    'Why is Bloom filter noteworthy?',
    'Describe Bloom filter for someone encountering it for the first time.',
    'State the central idea behind Bloom filter.'
  ];
  const rows = prompts.map(prompt => runtime.sendMessageToLari(JSON.parse(JSON.stringify(model)), prompt, {
    modelHash: 'eb1472a0000de793fa798e0ca60cc6fd5fac8025142d284be149e31689d79dc1',
    autoGrow: false,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  })).map(response => ({
    selected: (response.learnedRecordIds || []).includes(recordId),
    grounded: response.publicAnswerSource === 'verified_retained_knowledge',
    answered: String(response.answer || '').includes('Bloom')
  }));
  assert(rows.every(row => row.selected && row.grounded && row.answered));

  const structuralCases = [
    { id: 'cause-effect', topic: 'rain shadow', pattern: 'cause_effect', text: 'A rain shadow forms because a mountain forces moist air upward, causing rain on one side and leaving drier air on the other side.' },
    { id: 'ordered-process', topic: 'polymerase chain reaction', pattern: 'process_sequence', text: 'The polymerase chain reaction starts by heating DNA to separate its strands, then cools so primers can attach, and finally extends new DNA copies.' },
    { id: 'comparison', topic: 'RAM and storage', pattern: 'comparison', text: 'RAM holds information temporarily for active work, whereas storage keeps information after power is turned off.' },
    { id: 'quantity', topic: 'speed of light', pattern: 'quantitative_relation', text: 'Light in a vacuum travels at about 299792 kilometers per second.' },
    { id: 'hypothesis', topic: 'asteroid extinction hypothesis', pattern: 'competing_hypothesis', text: 'Evidence suggests that a large asteroid impact was a leading cause of the end-Cretaceous mass extinction.' },
    { id: 'definition', topic: 'sonar', pattern: 'definition', text: 'Sonar is a technique that uses transmitted sound and returning echoes to detect or locate objects.' }
  ];
  const expansion = structuralCases.map(test => {
    const isolated = JSON.parse(fs.readFileSync(path.join(root, 'models', 'lari', 'current', 'swarm-model.json'), 'utf8'));
    const query = `Explain ${test.topic} to a beginner using one analogy and one tiny example.`;
    const acquisition = runtime.runAutonomousKnowledgeAcquisition(isolated, query, {
      force: true,
      forceNewClaimRecord: true,
      topic: test.topic,
      sources: [{ title: test.topic, url: `https://example.test/${test.id}`, sourceType: 'test_reference', text: test.text, trust: 0.95 }],
      sourceScoring: { minSourceScore: 0.1 },
      compile: { threshold: 0.5, limit: 420 }
    });
    const recordId = acquisition.learned?.sourceLearnedRecordId || acquisition.learned?.lariTypedRecordId;
    const record = (isolated.lariLearnedRecords?.records || []).find(item => item.id === recordId);
    const response = runtime.sendMessageToLari(isolated, query, {
      modelHash: 'isolated-structural-learning',
      autoGrow: false,
      kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
    });
    const trace = response.semanticClaimTrace || response.result?.semanticClaimTrace || [];
    const passed = acquisition.action === 'learned_from_sources'
      && record?.payload?.responsePlan?.realization?.semanticPattern === test.pattern
      && (response.learnedRecordIds || []).includes(recordId)
      && response.publicAnswerSource === 'verified_retained_knowledge'
      && trace.length >= 3
      && trace.every(item => item.sourceRecordId === recordId && (item.grounding?.citations || []).length > 0)
      && /Analogy:/i.test(response.answer)
      && /Tiny example:/i.test(response.answer);
    return { id: test.id, pattern: record?.payload?.responsePlan?.realization?.semanticPattern || null, recordId, answer: response.answer, passed };
  });
  assert(expansion.every(row => row.passed), JSON.stringify(expansion.filter(row => !row.passed), null, 2));

  const compositionCases = [
    {
      id: 'definition-process-cause-comparison',
      topic: 'distributed cache',
      request: 'define it, describe how it works, explain why it matters, and compare it with a local cache',
      expected: ['definition', 'process_sequence', 'cause_effect', 'comparison'],
      text: 'A distributed cache is a shared store that keeps reusable data near multiple application workers. A distributed cache first checks for a stored value, then returns it or asks the original data source and stores the result. A distributed cache reduces delay because repeated requests can reuse nearby data. Unlike a local cache owned by one worker, a distributed cache can be shared by several workers.'
    },
    {
      id: 'definition-hypothesis-quantity',
      topic: 'vaccine trial',
      request: 'define it, describe the leading hypothesis and uncertainty, and state the number of participants',
      expected: ['definition', 'competing_hypothesis', 'quantitative_relation'],
      text: 'A vaccine trial is a controlled study used to evaluate a vaccine. Evidence from the vaccine trial suggests the candidate may reduce symptomatic illness, but the hypothesis must be tested against a comparison group. The vaccine trial enrolled 800 participants.'
    }
  ];
  const compositions = compositionCases.map(test => {
    const isolated = JSON.parse(fs.readFileSync(path.join(root, 'models', 'lari', 'current', 'swarm-model.json'), 'utf8'));
    const query = `Explain ${test.topic} to a beginner: ${test.request} using one analogy and one tiny example.`;
    const acquisition = runtime.runAutonomousKnowledgeAcquisition(isolated, query, {
      force: true,
      forceNewClaimRecord: true,
      topic: test.topic,
      sources: [{ title: test.topic, url: `https://example.test/composition-${test.id}`, sourceType: 'test_reference', text: test.text, trust: 0.95 }],
      sourceScoring: { minSourceScore: 0.1 },
      compile: { threshold: 0.5, limit: 420 },
      distill: { claimProgram: { maxSemanticComponents: 4 } }
    });
    const recordId = acquisition.learned?.sourceLearnedRecordId || acquisition.learned?.lariTypedRecordId;
    const record = (isolated.lariLearnedRecords?.records || []).find(item => item.id === recordId);
    const components = record?.payload?.responsePlan?.realization?.semanticComposition || [];
    const response = runtime.sendMessageToLari(isolated, query, {
      modelHash: 'isolated-semantic-composition', autoGrow: false,
      kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
    });
    const trace = response.semanticClaimTrace || response.result?.semanticClaimTrace || [];
    const selectedPatterns = components.map(component => component.pattern);
    const ordered = trace.every((item, index) => index === 0 || Number(item.componentOrder) >= Number(trace[index - 1].componentOrder));
    const ablated = JSON.parse(JSON.stringify(isolated));
    const ablatedRecord = ablated.lariLearnedRecords.records.find(item => item.id === recordId);
    const removedClaimId = components.at(-1)?.groundingClaimId;
    ablatedRecord.payload.responsePlan.sections = ablatedRecord.payload.responsePlan.sections.filter(section => section.id !== removedClaimId);
    const ablatedResponse = runtime.sendMessageToLari(ablated, query, {
      modelHash: 'isolated-semantic-composition-ablation', autoGrow: false,
      kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
    });
    const passed = test.expected.every(pattern => selectedPatterns.includes(pattern))
      && trace.length >= components.length
      && new Set(trace.map(item => item.semanticPattern)).size === components.length
      && trace.every(item => (item.grounding?.citations || []).length > 0)
      && ordered
      && (response.learnedRecordIds || []).includes(recordId)
      && !(ablatedResponse.learnedRecordIds || []).includes(recordId);
    return { id: test.id, recordId, selectedPatterns, tracePatterns: [...new Set(trace.map(item => item.semanticPattern))], ordered, removedClaimId, ablationRejectedRecord: !(ablatedResponse.learnedRecordIds || []).includes(recordId), answer: response.answer, passed };
  });
  assert(compositions.every(row => row.passed), JSON.stringify(compositions.filter(row => !row.passed), null, 2));
  console.log(JSON.stringify({ passed: true, actionApiContract: true, naturalTopicExtraction: true, semanticVariants: `${rows.length}/${rows.length}`, structuralExpansion: `${expansion.filter(row => row.passed).length}/${expansion.length}`, patterns: expansion.map(row => row.pattern), semanticComposition: `${compositions.filter(row => row.passed).length}/${compositions.length}`, componentAblation: compositions.every(row => row.ablationRejectedRecord), narrowKnowledgeWins: true }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
