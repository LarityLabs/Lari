#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const root = path.resolve(__dirname, '..');
const candidatePath = path.join(root, 'consolidation', 'stage-4-developmental-candidate.json');
const sealedPath = path.join(root, 'consolidation', 'stage-4-sealed', 'developmental-holdouts.json');
const outputPath = path.join(root, 'consolidation', 'stage-5-divergence-trace.json');
const expectedHash = 'c56719e1c21c997ddc18dca49ed90a3bde2e280ac42f106bb07b4608853d4b0f';
const sha = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
if (fs.existsSync(outputPath)) throw new Error('Stage 5 divergence trace already exists.');
if (sha(candidatePath) !== expectedHash) throw new Error('Rejected Stage 4 diagnostic candidate hash mismatch.');
const model = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const sealed = JSON.parse(fs.readFileSync(sealedPath, 'utf8'));
const cases = sealed.cases.filter(item => item.kind === 'holdout').map(testCase => {
  const working = clone(model);
  const response = runtime.sendMessageToLari(working, testCase.prompt, {
    modelHash: expectedHash, autoGrow: false,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, capabilityGraph: { minScore: 0 }, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
  const canonicalRoute = response.capabilityGraphRoute || null;
  const selectedSkill = canonicalRoute?.sourceKind === 'compiled_skill'
    ? working.compiledSkills.find(skill => skill.id === canonicalRoute.sourceSkillId)
    : null;
  const chatResult = response.action === 'chat'
    ? runtime.runGeneralChat(clone(model), testCase.prompt, { minMemoryScore: 0, minRouteScore: 0 })
    : null;
  const independentChatRoute = response.action === 'chat'
    ? runtime.routeCompiledSkill(clone(model), testCase.prompt, { minScore: 0, includeCompetingRoutes: true })
    : null;
  const finalRouteSkillId = chatResult?.route?.skillId || null;
  const selectedTemplate = selectedSkill?.answerTemplate || null;
  const output = String(response.answer || '');
  const selectedProcedureExecuted = Boolean(selectedSkill) && (
    finalRouteSkillId === selectedSkill.id
    || (selectedTemplate && output.includes(selectedTemplate))
  );
  const unrelatedShadow = /product|frontier_arena_repair_product/i.test(selectedSkill?.id || '')
    && !/product|app|build|workspace/i.test(testCase.prompt);
  const classification = unrelatedShadow
    ? 'unrelated capability shadow'
    : selectedProcedureExecuted
      ? null
      : finalRouteSkillId && finalRouteSkillId !== selectedSkill?.id
        ? 'selected procedure not invoked'
        : 'answer formatter replaced execution output';
  return {
    id: testCase.id,
    prompt: testCase.prompt,
    promptSha256: crypto.createHash('sha256').update(testCase.prompt).digest('hex'),
    selectedCapabilityId: canonicalRoute?.capabilityId || null,
    sourceSkillId: canonicalRoute?.sourceSkillId || null,
    learnedRecordId: canonicalRoute?.learnedRecordId || null,
    selectedExecutableProcedure: selectedSkill ? {
      skillId: selectedSkill.id,
      procedure: selectedSkill.procedure || [],
      answerTemplate: selectedSkill.answerTemplate || null,
      contractPresent: Boolean(selectedSkill.lariExecution)
    } : null,
    answerSynthesisPath: ['runLariUnifiedTaskKernel', 'runGeneralChat', 'routeCompiledSkill', 'synthesizeGeneralChatAnswer'],
    independentChatRoute: independentChatRoute ? {
      skillId: independentChatRoute.skill.id,
      learnedRecordId: independentChatRoute.learnedRecordId || null,
      score: independentChatRoute.score
    } : null,
    fallbackPath: response.action === 'chat' && finalRouteSkillId !== selectedSkill?.id ? 'independent general-chat compiled-skill route' : null,
    finalOutputSource: finalRouteSkillId ? `runGeneralChat:${finalRouteSkillId}` : response.action || null,
    finalRouteSkillId,
    selectedProcedureExecuted,
    executionSkippedAt: selectedProcedureExecuted ? null : 'runLariUnifiedTaskKernel branches only answer-repair skills; other selected compiled skills fall through to runGeneralChat',
    classification,
    passed: selectedProcedureExecuted && !classification
  };
});
const trace = {
  schemaVersion: 1,
  stage: 5,
  createdAt: new Date().toISOString(),
  diagnosticCandidateHash: expectedHash,
  diagnosticUseOnly: true,
  preciseBoundary: 'runLariUnifiedTaskKernel computes capabilityRoute, but only invokes routed compiled skills matching answer-repair naming. General chat then calls routeCompiledSkill independently, making the graph selection advisory.',
  classifications: ['selected procedure not invoked', 'selected procedure invoked but result discarded', 'fallback overrode valid execution', 'answer formatter replaced execution output', 'route family mismatch', 'incompatible procedure contract', 'confidence threshold error', 'unrelated capability shadow'],
  cases,
  summary: {
    caseCount: cases.length,
    selectedProcedureExecuted: cases.filter(item => item.selectedProcedureExecuted).length,
    selectedProcedureNotInvoked: cases.filter(item => item.classification === 'selected procedure not invoked').length,
    unrelatedCapabilityShadow: cases.filter(item => item.classification === 'unrelated capability shadow').length
  }
};
fs.writeFileSync(outputPath, `${JSON.stringify(trace, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(trace.summary, null, 2)}\n`);
