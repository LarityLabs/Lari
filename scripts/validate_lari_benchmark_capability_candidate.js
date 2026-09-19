#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const runtime = require('../swarm_model_runtime.js');
const registry = require('./lari_model_registry.js');

const ROOT = path.resolve(__dirname, '..');
const IMPORT = JSON.parse(fs.readFileSync(path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'benchmark-capability-import-report.json')));
const MATRIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'BENCHMARK_CAPABILITY_MATRIX.json')));
const CANDIDATE = path.join(ROOT, IMPORT.candidate.path);
const REPORT = path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'benchmark-capability-validation.json');
const TMP = path.join(ROOT, 'consolidation', 'repository-audit-20260827', 'validation-workspaces');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function write(root, file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, 'utf8');
}

function context(hash, extra = {}) {
  const { kernel: extraKernel = {}, ...rest } = extra;
  return {
    modelHash: hash,
    autoGrow: false,
    groundedFactual: false,
    ...rest,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 },
      ...extraKernel
    }
  };
}

function view(response = {}) {
  const lari = response.lari || response.chat_completion?.lari || {};
  const body = response.response || response;
  const selection = body.capabilitySelection || body.capability_selection || lari.capability_selection || null;
  const binding = body.executionBinding || body.execution_binding || lari.execution_binding || null;
  return {
    answer: body.answer || body.output_text || response.choices?.[0]?.message?.content || response.chat_completion?.choices?.[0]?.message?.content || '',
    action: body.action || lari.action || null,
    modelHash: body.modelHash || body.model_hash || response.model_hash || lari.model_hash || null,
    skillId: selection?.sourceSkillId || selection?.source_skill_id || null,
    learnedRecordId: selection?.learnedRecordId || selection?.learned_record_id || null,
    executionVerified: binding?.verified === true,
    externalModelCalls: body.external_model_calls ?? response.external_model_calls ?? 0
  };
}

function runCase(base, hash, id, request, extraContext = {}, verify = () => true) {
  const model = clone(base);
  const response = runtime.sendMessageToLari(model, request, context(hash, extraContext));
  const result = view(response);
  const expectedSkillId = `skill.capability.${id}`;
  return {
    id,
    request: typeof request === 'string' ? request : request.prompt,
    selectedSkillId: result.skillId,
    learnedRecordId: result.learnedRecordId,
    action: result.action,
    executionVerified: result.executionVerified,
    passed: result.skillId === expectedSkillId && result.executionVerified && verify({ response, model, result }),
    answer: result.answer,
    externalModelCalls: result.externalModelCalls
  };
}

function setupRepair(root, name, options = {}) {
  const dir = path.join(root, name);
  const functionName = options.functionName || 'updateQuota';
  const sourceFile = options.sourceFile || 'src/quota.js';
  const modulePath = `../${sourceFile.replace(/^src\//, 'src/')}`.replace('../src/', '../src/');
  write(dir, sourceFile, `function ${functionName}(used, requested, minimum, maximum) {\n  return used + requested;\n}\nmodule.exports = { ${functionName} };\n`);
  write(dir, 'tests/test.js', `const { ${functionName} } = require(${JSON.stringify(modulePath)});\nfor (const [used,requested,min,max,want] of [[5,2,0,10,7],[9,5,0,10,10],[1,-5,0,10,0]]) if (${functionName}(used,requested,min,max)!==want) throw new Error("bounded value escaped limits");\n`);
  return { dir, sourceFile };
}

function runRepairCase(base, hash, id, name, prompt) {
  const fixture = setupRepair(TMP, name);
  const request = { prompt, workspaceRoot: fixture.dir, testPath: 'tests/test.js', expressionTarget: fixture.sourceFile };
  return runCase(base, hash, id, request, {}, ({ response }) => response.passed === true);
}

function setupNovelBinaryRepair(root, name, options = {}) {
  const dir = path.join(root, name);
  const functionName = options.functionName || 'remainingQuota';
  const sourceFile = options.sourceFile || 'src/remaining.js';
  const modulePath = `../${sourceFile}`;
  write(dir, sourceFile, `function ${functionName}(total, used) {\n  return total + used;\n}\nmodule.exports = { ${functionName} };\n`);
  write(dir, 'tests/test.js', `const { ${functionName} } = require(${JSON.stringify(modulePath)});\nfor (const [total,used,want] of [[10,3,7],[5,2,3],[2,5,-3]]) if (${functionName}(total,used)!==want) throw new Error("remaining value is wrong");\n`);
  return { dir, sourceFile };
}

function runDevelopmentalTransfer(base, hash) {
  const researchModel = clone(base);
  const researchBefore = (researchModel.lariLearnedRecords?.records || []).length;
  const researchLearn = runtime.sendMessageToLari(researchModel, 'Research and learn digest validation from sources.', context(hash, {
    kernel: { research: { sources: [{ title: 'Digest validation', url: 'https://example.test/digests', text: 'A trusted expected digest can be compared with a locally computed digest to detect changed content.', sourceType: 'official_docs', trust: 0.9 }] } }
  }));
  const researchReload = clone(researchModel);
  const researchReuse = runtime.sendMessageToLari(researchReload, 'What did you learn about digest validation?', context(hash));
  const learnedKnowledgeId = (researchReuse.learnedRecordIds || []).find(id => /^lari\.learned\.knowledge\./.test(id)) || null;

  const preferenceModel = clone(base);
  const userScope = 'capability-transfer-user';
  runtime.sendMessageToLari(preferenceModel, 'Remember that I prefer concise technical answers.', context(hash, { userScope }));
  const preferenceReload = clone(preferenceModel);
  const retainedPreferences = runtime.canonicalLariPreferenceRecords(preferenceReload, { userScope });

  const repairModel = clone(base);
  const operatorIdsBefore = new Set((repairModel.lariLearnedRecords?.records || [])
    .filter(record => record?.type === 'operator' && record?.payload?.domain === 'workspace_coding' && record?.payload?.operation === 'replace_return_expression')
    .map(record => record.id));
  const learningFixture = setupNovelBinaryRepair(TMP, 'transfer-learning-source');
  const learningResponse = runtime.sendMessageToLari(repairModel, {
    prompt: 'Learn from this code failure, patch the remaining quota calculation, run the tests, and retain the verified repair.',
    workspaceRoot: learningFixture.dir,
    testPath: 'tests/test.js',
    expressionTarget: learningFixture.sourceFile
  }, context(hash));
  const learnedOperatorIds = (repairModel.lariLearnedRecords?.records || [])
    .filter(record => record?.type === 'operator' && record?.payload?.domain === 'workspace_coding' && record?.payload?.operation === 'replace_return_expression' && !operatorIdsBefore.has(record.id))
    .map(record => record.id);
  const repairReload = clone(repairModel);
  const transferFixture = setupNovelBinaryRepair(TMP, 'transfer-unseen-reload', { functionName: 'availableCapacity', sourceFile: 'src/capacity.js' });
  const transferResponse = runtime.sendMessageToLari(repairReload, {
    prompt: 'Patch the available capacity calculation in this fresh workspace and verify the tests.',
    workspaceRoot: transferFixture.dir,
    testPath: 'tests/test.js',
    expressionTarget: transferFixture.sourceFile
  }, context(hash, {
    kernel: {
      failureLearning: {
        allowExpressionOperatorDiscovery: false,
        allowSemanticOperatorDiscovery: false
      }
    }
  }));
  const retainedOperatorSelection = (transferResponse.trace || [])
    .map(item => item?.frontierFallback?.expressionRepair || item?.expressionRepair || null)
    .find(repair => repair?.mode === 'retained_operator') || null;
  const retainedOperatorUsed = Boolean(retainedOperatorSelection)
    && learnedOperatorIds.includes(retainedOperatorSelection.learnedRecordId);
  const transferTest = spawnSync(process.execPath, ['tests/test.js'], { cwd: transferFixture.dir, encoding: 'utf8', windowsHide: true });

  const checks = {
    researchCreatedTypedKnowledge: researchLearn.action === 'learned_from_sources'
      && (researchModel.lariLearnedRecords?.records || []).length > researchBefore,
    researchReusedAfterReload: researchReuse.action === 'answer_from_retained_research'
      && researchReuse.passed === true
      && /trusted expected digest/i.test(researchReuse.answer)
      && Boolean(learnedKnowledgeId),
    preferenceSurvivedReload: retainedPreferences.some(record => /concise technical answers/i.test(record.payload?.value || '')),
    failureLearningCreatedOperator: learningResponse.passed === true && learnedOperatorIds.length > 0,
    failureRepairTransferredAfterReloadWithoutDiscovery: transferResponse.passed === true
      && transferTest.status === 0
      && retainedOperatorUsed,
    externalModelCallsRemainZero: researchLearn.external_model_calls === 0
      && researchReuse.external_model_calls === 0
      && learningResponse.external_model_calls === 0
      && transferResponse.external_model_calls === 0
  };
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
    research: { learnedKnowledgeId, action: researchReuse.action, answer: researchReuse.answer },
    preference: { userScope, retainedRecordIds: retainedPreferences.map(record => record.id) },
    failureLearning: {
      learnedOperatorIds,
      learningAction: learningResponse.action,
      transferAction: transferResponse.action,
      retainedOperatorUsed,
      retainedOperatorMode: retainedOperatorSelection?.mode || null,
      retainedOperatorId: retainedOperatorSelection?.learnedRecordId || null,
      transferTestExitCode: transferTest.status,
      transferAnswer: transferResponse.answer
    }
  };
}

function setupVideo() {
  const dir = path.join(TMP, 'video');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'source.mp4');
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2', '-pix_fmt', 'yuv420p', source], {
    cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120000
  });
  if (made.status !== 0) throw new Error(`Could not create local video fixture: ${made.stderr || made.error?.message}`);
  return dir;
}

function cli(candidate, prompt) {
  const run = spawnSync(process.execPath, ['scripts/lari_ask.js', '--debug', '--model-path', candidate, prompt], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout);
  const marker = run.stdout.lastIndexOf('\n---\n');
  const metadata = JSON.parse(run.stdout.slice(marker + 5));
  return view({ response: { ...metadata, answer: run.stdout.slice(0, marker).trim() } });
}

async function waitFor(url, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before becoming ready: ${url}`);
    try { if ((await fetch(url)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function post(url, payload) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${url}: ${JSON.stringify(body)}`);
  return body;
}

async function surfaceParity(base, hash) {
  const prompt = 'Calculate 18 plus 27.';
  const direct = view(runtime.sendMessageToLari(clone(base), prompt, context(hash)));
  const autonomous = view(await runtime.runLariAutonomousRequest(clone(base), prompt, context(hash)));
  const cliResult = cli(CANDIDATE, prompt);
  const env = {
    ...process.env,
    LARI_MODEL_PATH: CANDIDATE,
    LARI_DISABLE_MODEL_FALLBACKS: '1',
    LARI_ALLOW_LEGACY_ROOT_MODEL: '0',
    LARI_NO_BROWSER: '1',
    LARI_WORKSPACE_PORT: '8942',
    LARI_RUNTIME_STATE_PATH: path.join(TMP, 'runtime-state.json')
  };
  const api = spawn('python', ['scripts/lari_openai_server.py', '--host', '127.0.0.1', '--port', '8941', '--model-path', CANDIDATE], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const workbench = spawn('python', ['start_workspace.py'], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let openaiApi;
  let workbenchApi;
  try {
    await Promise.all([
      waitFor('http://127.0.0.1:8941/health', api),
      waitFor('http://127.0.0.1:8942/index.html', workbench)
    ]);
    openaiApi = view(await post('http://127.0.0.1:8941/v1/chat/completions', {
      model: 'lari', messages: [{ role: 'user', content: prompt }], include_diagnostics: true
    }));
    workbenchApi = view(await post('http://127.0.0.1:8942/api/lari/chat', {
      prompt, includeDiagnostics: true, userScope: 'benchmark-capability-validation'
    }));
  } finally {
    api.kill();
    workbench.kill();
  }
  const surfaces = { direct, cli: cliResult, openaiApi, workbench: workbenchApi, autonomous };
  const comparable = item => ({ answer: item.answer, modelHash: item.modelHash, skillId: item.skillId, learnedRecordId: item.learnedRecordId, executionVerified: item.executionVerified });
  const expected = JSON.stringify(comparable(direct));
  return {
    prompt,
    surfaces,
    passed: Object.values(surfaces).every(item => JSON.stringify(comparable(item)) === expected)
      && Object.values(surfaces).every(item => item.externalModelCalls === 0)
  };
}

async function main() {
  reset(TMP);
  const candidateHash = shaFile(CANDIDATE);
  if (candidateHash !== IMPORT.candidate.sha256) throw new Error('Capability candidate hash does not match its manifest.');
  const activeBefore = shaFile(registry.currentModelPath);
  const registryBefore = shaFile(registry.registryPath);
  const candidateBefore = candidateHash;
  const base = JSON.parse(fs.readFileSync(CANDIDATE, 'utf8'));
  registry.assertNoStoredBenchmarkAnswers(base, IMPORT.candidate.path);
  registry.assertNoUnboundBenchmarkRuntimeSkills(base, IMPORT.candidate.path);

  const cases = [];
  cases.push(runCase(base, candidateHash, 'conversation', 'Explain why local verification matters.'));
  cases.push(runCase(base, candidateHash, 'instruction_following', 'Give exactly two bullet points about backups.', {}, ({ result }) => result.answer.split('\n').length === 2));
  cases.push(runCase(base, candidateHash, 'math_reasoning', 'Calculate 18 plus 27.', {}, ({ result }) => /45/.test(result.answer)));
  cases.push(runCase(base, candidateHash, 'multiple_choice_reasoning', 'Which protects data? A) Delete it B) Atomic backup C) Ignore errors D) Rename it', {}, ({ result }) => /^B\)/.test(result.answer)));
  cases.push(runCase(base, candidateHash, 'research_learning', 'Research and learn checksum verification from sources.', {
    kernel: { research: { sources: [{ title: 'Checksum verification', url: 'https://example.test/checksums', text: 'Checksums identify changed bytes. Verify a checksum against a trusted expected digest before accepting an artifact.', sourceType: 'validation_source', trust: 0.9 }] } }
  }, ({ response, model }) => response.action === 'learned_from_sources' && (model.lariLearnedRecords?.records || []).length > (base.lariLearnedRecords?.records || []).length));
  cases.push(runCase(base, candidateHash, 'personalization_memory', 'Remember that I prefer concise answers.', {}, ({ model }) => (model.lariLearnedRecords?.records || []).some(record => record.type === 'preference')));
  cases.push(runRepairCase(base, candidateHash, 'workspace_coding', 'coding', 'Patch the bounded quota calculation in this workspace and run the tests.'));
  cases.push(runCase(base, candidateHash, 'project_building', { prompt: 'Build a verified local app project with image and audio.', requiredLanes: ['image', 'audio'], requiredMechanics: [], minBytes: 1000 }));
  cases.push(runCase(base, candidateHash, 'image_generation', 'Generate an image of a moon and stars.', {}, ({ response }) => response.artifacts?.length === 1));
  cases.push(runCase(base, candidateHash, 'audio_generation', 'Generate a short audio melody loop.', {}, ({ response }) => response.artifacts?.length === 1));
  const videoRoot = setupVideo();
  cases.push(runCase(base, candidateHash, 'video_editing', {
    prompt: 'Trim this video into a verified scene clip.', workspaceRoot: videoRoot, inputPath: 'source.mp4', outputDir: 'clips', clips: [{ start: 0.2, duration: 0.8, filename: 'clip-1.mp4' }]
  }, {}, ({ response }) => response.artifacts?.length === 1 && fs.existsSync(path.join(videoRoot, 'clips', 'clip-1.mp4'))));
  cases.push(runCase(base, candidateHash, 'multimodal_product', { prompt: 'Build a multimodal experience with image and audio.', requiredLanes: ['image', 'audio'], requiredMechanics: [], minBytes: 1000 }));
  cases.push(runRepairCase(base, candidateHash, 'tool_operator_execution', 'tool', 'Use a local operator to patch the bounded quota code and verify the tests.'));
  cases.push(runRepairCase(base, candidateHash, 'failure_learning', 'failure', 'Learn from this code failure, patch the bounded quota function, run the tests, retain the repair, and transfer the lesson.'));
  cases.push(runCase(base, candidateHash, 'capability_composition', 'Compose the narrowest verified capabilities for this task.', {}, ({ result }) => /capability graph/.test(result.answer)));
  cases.push(runCase(base, candidateHash, 'autonomous_execution', 'Autonomously execute this task: calculate 12 plus 30 and verify it.', {}, ({ result }) => /42/.test(result.answer)));
  cases.push(runCase(base, candidateHash, 'model_growth', 'Research model growth to improve weaknesses.', {}, ({ result }) => /model-growth cycle/.test(result.answer)));
  cases.push(runCase(base, candidateHash, 'model_lifecycle', 'Explain safe model promotion and rollback.', {}, ({ result }) => /hash|rollback/.test(result.answer)));

  // Fresh phrasings are deliberately separate from the primary examples and from benchmark prompts.
  // They prove selection by semantic intent instead of filename, exact-prompt, or memorized-answer locks.
  const semanticVariants = [];
  semanticVariants.push(runCase(base, candidateHash, 'conversation', 'Why is checking a result useful before claiming success?'));
  semanticVariants.push(runCase(base, candidateHash, 'instruction_following', 'Write exactly three lowercase bullet points about snapshots.', {}, ({ result }) => {
    const lines = result.answer.split('\n').filter(Boolean);
    return lines.length === 3 && lines.every(line => /^- /.test(line) && line === line.toLowerCase());
  }));
  semanticVariants.push(runCase(base, candidateHash, 'math_reasoning', 'Compute 14 times 3.', {}, ({ result }) => /42/.test(result.answer)));
  semanticVariants.push(runCase(base, candidateHash, 'multiple_choice_reasoning', 'Which choice keeps a file safe during replacement? A) Partial write B) Atomic backup C) Ignore errors D) Delete both copies', {}, ({ result }) => /^B\)/.test(result.answer)));
  semanticVariants.push(runCase(base, candidateHash, 'research_learning', 'Study digest validation and retain what the evidence supports.', {
    kernel: { research: { sources: [{ title: 'Digest validation', url: 'https://example.test/digests', text: 'A trusted expected digest can be compared with a locally computed digest to detect changed content.', sourceType: 'validation_source', trust: 0.9 }] } }
  }, ({ response, model }) => response.action === 'learned_from_sources' && (model.lariLearnedRecords?.records || []).some(record => record.type === 'knowledge' && /digest/i.test(record.payload?.topic || ''))));
  semanticVariants.push(runCase(base, candidateHash, 'personalization_memory', 'Please remember that I prefer technical details before examples.', {}, ({ model }) => (model.lariLearnedRecords?.records || []).some(record => record.type === 'preference')));
  semanticVariants.push(runRepairCase(base, candidateHash, 'workspace_coding', 'coding-variant', 'Repair the bounded inventory calculation in this workspace and verify its test.'));
  semanticVariants.push(runCase(base, candidateHash, 'project_building', { prompt: 'Create a checked local app project containing a visual and a sound.', requiredLanes: ['image', 'audio'], requiredMechanics: [], minBytes: 1000 }));
  semanticVariants.push(runCase(base, candidateHash, 'image_generation', 'Draw a local SVG picture of stars over water.', {}, ({ response }) => response.artifacts?.length === 1));
  semanticVariants.push(runCase(base, candidateHash, 'audio_generation', 'Create a short WAV music loop with a melody.', {}, ({ response }) => response.artifacts?.length === 1));
  semanticVariants.push(runCase(base, candidateHash, 'video_editing', {
    prompt: 'Extract a bounded verified clip from this movie.', workspaceRoot: videoRoot, inputPath: 'source.mp4', outputDir: 'variant-clips', clips: [{ start: 0.1, duration: 0.6, filename: 'excerpt.mp4' }]
  }, {}, ({ response }) => response.artifacts?.length === 1 && fs.existsSync(path.join(videoRoot, 'variant-clips', 'excerpt.mp4'))));
  semanticVariants.push(runCase(base, candidateHash, 'multimodal_product', { prompt: 'Compose a local experience using both sound and a visual.', requiredLanes: ['image', 'audio'], requiredMechanics: [], minBytes: 1000 }));
  semanticVariants.push(runRepairCase(base, candidateHash, 'tool_operator_execution', 'tool-variant', 'Have the local operator repair the bounded inventory code and prove the test passes.'));
  semanticVariants.push(runRepairCase(base, candidateHash, 'failure_learning', 'failure-variant', 'Learn from the failed bounded inventory calculation, retain the verified fix, and transfer the repair lesson.'));
  semanticVariants.push(runCase(base, candidateHash, 'capability_composition', 'Use the capability graph to compose the most specific compatible skills.', {}, ({ result }) => /capability graph/.test(result.answer)));
  semanticVariants.push(runCase(base, candidateHash, 'autonomous_execution', 'Autonomously execute and verify this task: calculate 13 plus 29.', {}, ({ result }) => /42/.test(result.answer)));
  semanticVariants.push(runCase(base, candidateHash, 'model_growth', 'Research how to grow the model by improving the weakest verified area.', {}, ({ result }) => /model-growth cycle/.test(result.answer)));
  semanticVariants.push(runCase(base, candidateHash, 'model_lifecycle', 'How should an immutable candidate be promoted with a safe rollback?', {}, ({ result }) => /hash|rollback/.test(result.answer)));

  const developmentalTransfer = runDevelopmentalTransfer(base, candidateHash);
  const parity = await surfaceParity(base, candidateHash);
  const reload = JSON.parse(fs.readFileSync(CANDIDATE, 'utf8'));
  const reloadCases = [
    runCase(reload, candidateHash, 'instruction_following', 'Give exactly two bullet points about backups.'),
    runCase(reload, candidateHash, 'math_reasoning', 'Calculate 18 plus 27.'),
    runCase(reload, candidateHash, 'image_generation', 'Generate an image of a moon and stars.')
  ];
  const gates = {
    all303BenchmarksMapped: MATRIX.summary.benchmarkCount === 303 && MATRIX.summary.unmapped === 0,
    all18CapabilityFamiliesStored: MATRIX.summary.capabilityFamilyCount === 18
      && MATRIX.capabilityFamilies.every(family => base.lariLearnedRecords.records.some(record => record.id === family.learnedRecordId)),
    derivedIndexOnlyContainsCanonicalFamilies: base.compiledSkills.length === 18
      && base.compiledSkills.every(skill => /^skill\.capability\./.test(skill.id) && skill.lariExecution),
    all18SelectAndExecute: cases.length === 18 && cases.every(item => item.passed),
    all18SemanticVariantsSelectAndExecute: semanticVariants.length === 18 && semanticVariants.every(item => item.passed),
    failureResearchPreferenceLearnReloadTransfer: developmentalTransfer.passed,
    sameHashPublicSurfaceParity: parity.passed,
    reloadRetention: reloadCases.every(item => item.passed),
    noBenchmarkAnswersOrNameRouting: base.lariBenchmarkCapabilityConsolidation?.benchmarkAnswersStored === false
      && base.lariBenchmarkCapabilityConsolidation?.benchmarkNamesUsedForRouting === false,
    noExternalModelCalls: cases.every(item => item.externalModelCalls === 0),
    activeModelReadOnly: shaFile(registry.currentModelPath) === activeBefore,
    registryReadOnly: shaFile(registry.registryPath) === registryBefore,
    candidateReadOnly: shaFile(CANDIDATE) === candidateBefore
  };
  const report = {
    schemaVersion: 1,
    kind: 'lari.benchmark-capability-validation',
    createdAt: new Date().toISOString(),
    candidateHash,
    matrixSummary: MATRIX.summary,
    cases,
    semanticVariants,
    developmentalTransfer,
    parity,
    reloadCases,
    gates,
    passed: Object.values(gates).every(Boolean),
    promoted: false,
    externalModelCalls: 0
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ candidateHash, passedCapabilities: cases.filter(item => item.passed).length, totalCapabilities: cases.length, failed: cases.filter(item => !item.passed).map(item => ({ id: item.id, selected: item.selectedSkillId, action: item.action })), parity: parity.passed, gates, passed: report.passed }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exit(1);
});
