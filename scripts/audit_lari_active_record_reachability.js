#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'consolidation', 'active-record-reachability-20260912-attempt2');
const jsonPath = path.join(outDir, 'report.json');
const mdPath = path.join(outDir, 'report.md');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const activePath = registry.currentModelPath;
const registryPath = registry.registryPath;
function idsFromRun(run) {
  const ids = new Set(run.record?.languageUnderstandingRecordIds || []);
  for (const item of run.record?.trace || []) {
    for (const key of ['learnedRecordId', 'recordId', 'operatorId', 'generatorId', 'sourceLearnedRecordId']) if (item?.[key]) ids.add(item[key]);
    for (const id of item?.learnedRecordIds || []) ids.add(id);
  }
  for (const id of run.result?.recapLearnedRecordIds || []) ids.add(id);
  for (const id of run.result?.learnedRecordIds || []) ids.add(id);
  if (run.result?.learnedChatProcedureId) ids.add(run.result.learnedChatProcedureId);
  return [...ids];
}
function signature(run) {
  return JSON.stringify({
    action: run.record?.action || null,
    passed: run.record?.passed === true,
    output: run.record?.outputText || run.result?.answer || '',
    capability: run.record?.capabilityGraphRoute?.capabilityId || null,
    ids: idsFromRun(run)
  });
}
function promptFor(record) {
  const triggers = (record.normalizedTriggers || []).filter(Boolean).slice(0, 10);
  if (record.payload?.interactionProgram?.matcher?.source) {
    const pattern = record.payload.interactionProgram.responsePattern || '';
    return `Use this learned capability in an ordinary request involving ${triggers.join(', ')}. Expected response shape: ${pattern}`;
  }
  return `Handle an ordinary request where these concepts matter: ${triggers.join(', ')}.`;
}
function benchmarkScaffolding(record) {
  const text = [
    record.procedureIdentity,
    record.outputBehavior,
    record.behavioralSignature,
    record.provenance?.creationSource,
    JSON.stringify(record.payload || {}),
    JSON.stringify(record.procedure || [])
  ].filter(Boolean).join(' ').toLowerCase();
  return (record.provenance?.benchmarkAssociation || []).length > 0
    || /holdout validator|satisfy.{0,40}validator|benchmark(?:_|\s)(?:answer|family|prompt|score)|gsm8k|ifeval|swe-bench/.test(text);
}
function staticDependencies(model, id) {
  return {
    compiledSkillIds: (model.compiledSkills || []).filter(x => x.sourceLearnedRecordId === id).map(x => x.id),
    graphNodeIds: (model.lariCapabilityGraph?.nodes || []).filter(x => x.sourceLearnedRecordId === id || x.learnedRecordId === id || x.sourceSkillId === id).map(x => x.id),
    geneIds: (model.lariCapabilityGenome?.genes || []).filter(x => x.sourceLearnedRecordId === id || x.learnedRecordId === id).map(x => x.id),
    mathPolicyIds: (model.lariMathReasoning?.policies || []).filter(x => x.sourceLearnedRecordId === id || x.learnedRecordId === id).map(x => x.id),
    modalityGeneratorIds: [...(model.lariModalityRegistry?.generators || []), ...(model.lariModalityRegistry?.promoted || [])]
      .filter(x => x.sourceLearnedRecordId === id || x.learnedRecordId === id).map(x => x.id)
  };
}
function run(model, prompt) {
  return runtime.runLariUnifiedTaskKernel(model, { prompt }, {
    useBenchmarkSystem: false,
    useCapabilityGraph: true,
    capabilityGraph: { minScore: 0 },
    chat: { minMemoryScore: 0, minRouteScore: 0 },
    userScope: 'reachability-audit'
  });
}
function main() {
  if (fs.existsSync(outDir)) throw new Error(`Audit output already exists: ${outDir}`);
  const before = { active: sha(activePath), registry: sha(registryPath) };
  const model = registry.loadLariModel().model;
  const records = (model.lariLearnedRecords?.records || []).filter(x => x.status === 'active');
  const rows = [];
  for (const record of records) {
    const prompt = promptFor(record);
    const baseline = run(model, prompt);
    const observedIds = idsFromRun(baseline);
    const selected = observedIds.includes(record.id);
    let ablationChanged = null;
    if (selected) {
      const originalRecords = model.lariLearnedRecords.records;
      const originalCompiled = model.compiledSkills;
      model.lariLearnedRecords.records = originalRecords.filter(x => x.id !== record.id);
      model.compiledSkills = originalCompiled.filter(x => x.sourceLearnedRecordId !== record.id);
      const ablated = run(model, prompt);
      ablationChanged = signature(ablated) !== signature(baseline);
      model.lariLearnedRecords.records = originalRecords;
      model.compiledSkills = originalCompiled;
    }
    const dependencies = staticDependencies(model, record.id);
    const projected = Object.values(dependencies).some(values => values.length > 0);
    const scaffold = benchmarkScaffolding(record);
    const historical = ['closed', 'quarantined'].includes(record.status)
      || /history|report|product_instance/.test(String(record.outputBehavior || ''));
    const classification = scaffold ? 'benchmark_scaffolding_review'
      : selected && ablationChanged ? 'dynamically_reachable_causal'
      : selected ? 'dynamically_reachable_but_projection_masks_ablation'
      : projected ? 'projected_not_reached_by_record_trigger_probe'
      : historical ? 'history_or_product'
      : 'not_reached_by_record_trigger_probe';
    rows.push({
      id: record.id, type: record.type, confidence: record.confidence ?? null,
      creationSource: record.provenance?.creationSource || null,
      benchmarkAssociation: record.provenance?.benchmarkAssociation || [],
      promptHash: crypto.createHash('sha256').update(prompt).digest('hex'),
      selected, ablationChanged, projected, dependencies, classification,
      observed: {
        action: baseline.record?.action || null,
        passed: baseline.record?.passed === true,
        capabilityId: baseline.record?.capabilityGraphRoute?.capabilityId || null,
        learnedRecordIds: observedIds
      }
    });
  }
  const counts = rows.reduce((acc, row) => { acc[row.classification] = (acc[row.classification] || 0) + 1; return acc; }, {});
  const after = { active: sha(activePath), registry: sha(registryPath) };
  const report = {
    schemaVersion: 1,
    kind: 'lari.active-record-reachability-ablation-audit',
    createdAt: new Date().toISOString(),
    activeHash: before.active,
    activeRecordCount: records.length,
    probedRecordCount: rows.length,
    selectedCount: rows.filter(x => x.selected).length,
    causalAblationCount: rows.filter(x => x.ablationChanged === true).length,
    benchmarkScaffoldingReviewCount: rows.filter(x => x.classification === 'benchmark_scaffolding_review').length,
    counts,
    methodologyLimitations: [
      'Trigger-derived prompts are diagnostic probes, not proof of broad generalization.',
      'Ablation removes the canonical record and its compiled-skill projection; other legacy projections may still mask causality.',
      'Records not selected by this probe may still be reachable through another request shape.',
      'Benchmark association triggers review rather than automatic invalidation.'
    ],
    integrity: { before, after, readOnly: JSON.stringify(before) === JSON.stringify(after) },
    externalModelCalls: 0,
    rows
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  const markdown = `# Lari active-record reachability and ablation audit\n\n`
    + `Active hash: \`${report.activeHash}\`  \nActive records probed: ${report.activeRecordCount}  \nDynamically observed: ${report.selectedCount}  \nCausal under exact record plus compiled projection ablation: ${report.causalAblationCount}  \nBenchmark-scaffolding review: ${report.benchmarkScaffoldingReviewCount}  \nProduction files read-only: ${report.integrity.readOnly}\n\n`
    + `## Classification counts\n\n${Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([key,value])=>`- ${key}: ${value}`).join('\n')}\n\n`
    + `## Interpretation\n\nA record existing inside the active hash is not evidence that ordinary requests can select and execute it. See \`report.json\` for every record, its projections, observed route, and ablation result. The probe limitations in the JSON report are part of the result.\n`;
  fs.writeFileSync(mdPath, markdown, { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.integrity.readOnly && rows.length === records.length, activeHash: report.activeHash, activeRecords: records.length, selected: report.selectedCount, causal: report.causalAblationCount, benchmarkReview: report.benchmarkScaffoldingReviewCount, counts, outputs: [path.relative(root,jsonPath), path.relative(root,mdPath)] }, null, 2));
}
main();
