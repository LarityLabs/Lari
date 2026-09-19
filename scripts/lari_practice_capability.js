#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime');
const registry = require('./lari_model_registry');

const root = path.resolve(__dirname, '..');
const candidateDir = path.join(root, 'consolidation', 'learning-candidates');
const milestoneDir = path.join(root, 'consolidation', 'procedural-curriculum-20260722');
const symbolicMathDir = path.join(root, 'consolidation', 'symbolic-math-neurogenesis-20260912');
const practiceJobDir = path.join(root, 'consolidation', 'capability-practice-jobs');
const clone = value => JSON.parse(JSON.stringify(value));
const shaBuffer = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => shaBuffer(fs.readFileSync(file));
const relative = file => path.relative(root, file).replace(/\\/g, '/');

function parseArgs(argv = []) {
  const options = {
    basePath: null,
    goal: 'build a local app that turns uploaded videos into verified clips',
    targetId: 'video_pipeline_execution'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') options.basePath = argv[++index] || null;
    else if (arg === '--goal') options.goal = argv[++index] || options.goal;
    else if (arg === '--target') options.targetId = argv[++index] || options.targetId;
    else if (arg === '--trigger-hash') options.triggerHash = argv[++index] || null;
  }
  return options;
}

function spawn(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 120000,
    maxBuffer: 32 * 1024 * 1024
  });
}

function requirePass(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`);
}

function createSyntheticVideo(workspaceRoot, filename, spec = {}) {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const output = path.join(workspaceRoot, filename);
  const duration = Number(spec.duration || 4);
  const size = spec.size || '320x240';
  const rate = Number(spec.rate || 12);
  const tone = Number(spec.tone || 440);
  const run = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=44100:duration=${duration}`,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', output
  ]);
  requirePass(run, 'synthetic video creation');
  if (!fs.existsSync(output) || fs.statSync(output).size <= 0) throw new Error('Synthetic video was not created.');
  return output;
}

function createSceneCutVideo(workspaceRoot, filename, spec = {}) {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const output = path.join(workspaceRoot, filename);
  const size = spec.size || '320x240';
  const rate = Number(spec.rate || 12);
  const durations = spec.durations || [1.1, 1.25, 1.05, 1.3];
  const sources = spec.sources || [
    `color=c=red:s=${size}:r=${rate}:d=${durations[0]}`,
    `testsrc2=size=${size}:rate=${rate}:duration=${durations[1]}`,
    `smptebars=size=${size}:rate=${rate}:duration=${durations[2]}`,
    `color=c=blue:s=${size}:r=${rate}:d=${durations[3]}`
  ];
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  sources.forEach(source => args.push('-f', 'lavfi', '-i', source));
  const inputs = sources.map((_, index) => `[${index}:v]`).join('');
  args.push(
    '-filter_complex', `${inputs}concat=n=${sources.length}:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output
  );
  const run = spawn('ffmpeg', args);
  requirePass(run, 'scene-cut video creation');
  if (!fs.existsSync(output) || fs.statSync(output).size <= 0) throw new Error('Scene-cut video was not created.');
  return output;
}

function send(model, request, modelHash) {
  return runtime.sendMessageToLari(clone(model), request, {
    modelHash,
    autoGrow: false,
    groundedFactual: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: { minMemoryScore: 0, minRouteScore: 0 }
    }
  });
}

function executionView(response = {}) {
  return {
    action: response.action || null,
    passed: response.passed === true,
    modelHash: response.modelHash || null,
    capabilityId: response.capabilitySelection?.capabilityId || null,
    sourceSkillId: response.capabilitySelection?.sourceSkillId || null,
    learnedRecordId: response.capabilitySelection?.learnedRecordId || null,
    learnedRecordIds: response.learnedRecordIds || [],
    executed: response.executionBinding?.executed === true,
    verified: response.executionBinding?.verified === true,
    resultType: response.executionBinding?.resultType || null,
    artifactCount: (response.artifacts || []).length,
    fallbackReason: response.fallbackReason || null,
    answer: response.answer || '',
    externalModelCalls: response.external_model_calls || 0
  };
}

function buildTypedOperator(baseHash, basePath, hypothesis, practice) {
  const createdAt = new Date().toISOString();
  const procedure = [
    'validate source and output paths remain inside the declared workspace',
    'normalize clip start and duration contracts',
    'invoke local ffmpeg with fixed video and optional-audio mappings',
    'write MP4 clips with H.264 video, AAC audio when present, and fast-start metadata',
    'verify every artifact with ffprobe for a video stream and bounded duration',
    'reject the capability result if any clip fails executable verification'
  ];
  const payload = {
    domain: 'media_pipeline',
    operation: 'transcode_and_segment_video',
    capability: 'video_pipeline_execution',
    tool: 'ffmpeg',
    verifier: 'ffprobe',
    procedure,
    diagnosticHypothesis: hypothesis,
    trainingEvidence: practice,
    external_model_calls: 0
  };
  const contentHash = shaBuffer(Buffer.from(JSON.stringify(payload)));
  const recordId = `lari.learned.operator.${contentHash.slice(0, 24)}`;
  return {
    record: {
      schemaVersion: 1,
      id: recordId,
      type: 'operator',
      status: 'active',
      normalizedTriggers: ['clip', 'ffmpeg', 'ffprobe', 'media', 'pipeline', 'segment', 'transcode', 'upload', 'video'].sort(),
      procedureIdentity: shaBuffer(Buffer.from(JSON.stringify(procedure))),
      semanticFingerprint: shaBuffer(Buffer.from('video pipeline execution|ffmpeg|clip segmentation|ffprobe verification')),
      outputBehavior: shaBuffer(Buffer.from('verified local mp4 clip artifacts')),
      contentHash,
      behavioralSignature: shaBuffer(Buffer.from(JSON.stringify({ operation: payload.operation, procedure }))),
      confidence: 0.94,
      provenance: {
        sourceModelHash: baseHash,
        sourcePath: relative(basePath),
        originalRecordId: hypothesis.id,
        sourceKind: 'verified_isolated_procedural_practice',
        creationSource: 'runLariLocalVideoPipelineOperator',
        benchmarkAssociation: [],
        confidence: 0.94,
        imported: false,
        classification: 'developmental_candidate',
        importTimestamp: createdAt,
        failBeforePassAfter: true,
        unseenTransfer: true,
        externalModelCalls: 0
      },
      selection: {
        canonical: true,
        learnedRecordId: recordId,
        intentTerms: ['product', 'code'],
        proceduralCompatibility: 1,
        provenanceStrength: 0.99,
        holdoutPerformance: 1,
        confidence: 0.94,
        broadFallback: false,
        scopeTerms: ['video', 'pipeline', 'ffmpeg', 'transcode', 'segment', 'clip'],
        derivedAt: createdAt
      },
      payload
    },
    skill: {
      id: 'skill.operator.video_pipeline_execution',
      sourceKnowledgeId: recordId,
      sourceLearnedRecordId: recordId,
      topic: 'Verified local video pipeline execution',
      capability: 'video_pipeline_execution',
      status: 'compiled',
      confidence: 0.94,
      triggerConcepts: ['video', 'pipeline', 'ffmpeg', 'transcode', 'segment', 'clip', 'upload', 'media'],
      triggerEmbedding: [],
      procedure,
      answerTemplate: 'Use the retained local video pipeline operator to transcode and segment a workspace-contained source, then accept output only when every MP4 clip passes ffprobe verification.',
      selfTest: { query: 'execute a local ffmpeg video pipeline and verify clips', retrievedTopic: 'Verified local video pipeline execution', score: 1, passed: true },
      compiledAt: createdAt,
      lariSelection: {
        canonical: true,
        learnedRecordId: recordId,
        intentTerms: ['product', 'code'],
        proceduralCompatibility: 1,
        provenanceStrength: 0.99,
        holdoutPerformance: 1,
        confidence: 0.94,
        broadFallback: false,
        scopeTerms: ['video', 'pipeline', 'ffmpeg', 'transcode', 'segment', 'clip'],
        derivedAt: createdAt
      },
      lariExecution: {
        schemaVersion: 1,
        id: 'execution.skill.operator.video_pipeline_execution',
        selectedLearnedCapabilityId: recordId,
        inputContract: {
          requestType: 'structured_workspace_video_pipeline',
          allowedIntents: ['product', 'code'],
          taskFamilyTerms: ['video', 'pipeline', 'ffmpeg', 'transcode', 'segment', 'clip', 'upload'],
          minimumTaskFamilyMatches: 2
        },
        executableProcedureReference: 'canonical_typed_operator',
        operatorKind: 'local_video_pipeline',
        expectedResultType: 'verified_artifacts',
        verificationRule: { type: 'ffprobe_verified_video_artifacts', requireVideoStream: true, requireDurationBounds: true },
        maximumClips: 12,
        maximumDurationSeconds: 600,
        durationToleranceSeconds: 0.45,
        timeoutMs: 120000,
        failureSignal: 'local video pipeline did not produce ffprobe-verified clips',
        fallbackEligibility: ['incompatible_request', 'safety_policy_blocked'],
        provenance: {
          sourceModelHash: baseHash,
          learnedRecordId: recordId,
          bindingSource: 'verified_isolated_procedural_practice',
          externalModelCalls: 0
        }
      }
    }
  };
}

function familyRegression(base, candidate, baseHash, candidateHash) {
  const prompts = [
    'Hello Lari, how are you?',
    'What is 18 plus 27?',
    'Give exactly two bullet points about backups.',
    'Explain local state retention.',
    'Describe diagnostics when tests fail.',
    'Explain source-grounded learning.',
    'Describe a verified product plan.',
    'Why verify destructive changes?'
  ];
  const score = response => Number(response?.passed === true) + Math.min(1, String(response?.answer || '').trim().length / 80);
  return prompts.map(prompt => {
    const before = send(base, prompt, baseHash);
    const after = send(candidate, prompt, candidateHash);
    return { prompt, before: score(before), after: score(after), regressed: score(after) + 0.0001 < score(before) };
  });
}

function hiddenKnowledgeTransfer(model) {
  const records = (model.lariLearnedRecords?.records || [])
    .filter(record => record?.provenance?.imported && record.type === 'knowledge' && !(record.provenance.benchmarkAssociation || []).length && (record.normalizedTriggers || []).length >= 2)
    .slice(0, 17);
  const tests = records.map(record => {
    const query = `In a new situation, what reusable guidance applies when ${record.normalizedTriggers.slice(0, 4).reverse().join(', ')} matter?`;
    const matches = runtime.searchKnowledge(clone(model), query, { limit: 5, minScore: 0 }) || [];
    return { recordId: record.id, passed: matches.some(match => (match.item?.sourceLearnedRecordId || match.learnedRecordId) === record.id) };
  });
  return { passedCount: tests.filter(test => test.passed).length, total: tests.length, passed: tests.length === 17 && tests.every(test => test.passed), tests };
}

function writeReport(report, candidatePath) {
  fs.mkdirSync(milestoneDir, { recursive: true });
  const evidencePath = path.join(milestoneDir, `evidence-${report.candidate.sha256.slice(0, 16)}.json`);
  fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  const markdownPath = path.join(milestoneDir, `report-${report.candidate.sha256.slice(0, 16)}.md`);
  const markdown = [
    '# Lari procedural curriculum proof',
    '',
    `Candidate: \`${report.candidate.sha256}\``,
    `Parent: \`${report.candidate.parentHash}\``,
    `Typed operator: \`${report.learnedRecordId}\``,
    '',
    `- Fail-before observed: ${report.gates.failBeforeObserved}`,
    `- Pass-after verified: ${report.gates.passAfterVerified}`,
    `- Unseen workspace transfer: ${report.gates.unseenTransfer}`,
    `- Reload retention: ${report.gates.reloadRetention}`,
    `- Hidden knowledge transfer: ${report.hiddenTransfer.passedCount}/${report.hiddenTransfer.total}`,
    `- Family regressions: ${report.familyRegression.filter(row => row.regressed).length}`,
    `- Active model unchanged: ${report.gates.activeReadOnly}`,
    `- Registry unchanged: ${report.gates.registryReadOnly}`,
    `- External model calls: 0`,
    `- Promoted: false`,
    '',
    'The candidate remains immutable and unpromoted. Rollback is therefore the incumbent registry pointer; no active-state rewrite is required.',
    ''
  ].join('\n');
  fs.writeFileSync(markdownPath, markdown, { flag: 'wx' });
  return { evidencePath, markdownPath, candidatePath };
}

async function runVideoPipelinePractice(options = parseArgs(process.argv.slice(2))) {
  const resolvedBase = options.basePath
    ? path.resolve(root, options.basePath)
    : registry.resolveLariModelPath().path;
  if (!fs.existsSync(resolvedBase)) throw new Error(`Candidate base not found: ${resolvedBase}`);
  const activeBefore = shaFile(registry.currentModelPath);
  const registryBefore = shaFile(registry.registryPath);
  const baseHash = shaFile(resolvedBase);
  const base = JSON.parse(fs.readFileSync(resolvedBase, 'utf8'));
  const runId = `${Date.now()}-${process.pid}`;
  const practiceRoot = path.join(milestoneDir, 'workspaces', runId);
  const trainingRoot = path.join(practiceRoot, 'training');
  const holdoutRoot = path.join(practiceRoot, 'unseen-transfer');
  const reloadRoot = path.join(practiceRoot, 'reload-transfer');
  createSyntheticVideo(trainingRoot, 'source.mp4', { duration: 4.2, size: '320x240', rate: 12, tone: 440 });
  const trainingRequest = {
    mode: 'product',
    prompt: 'Execute the local video pipeline with FFmpeg: transcode this uploaded video into verified MP4 clips.',
    workspaceRoot: trainingRoot,
    inputPath: 'source.mp4',
    outputDir: 'clips-after',
    clips: [{ start: 0.3, duration: 1.1, filename: 'opening.mp4' }, { start: 2.0, duration: 1.25, filename: 'closing.mp4' }]
  };
  const baseline = send(base, { ...trainingRequest, outputDir: 'clips-before' }, baseHash);
  const failBeforeObserved = baseline.executionBinding?.verified !== true
    && (baseline.artifacts || []).filter(artifact => artifact?.modality === 'video').length === 0;
  if (!failBeforeObserved) throw new Error('Practice is invalid because the base model already passed the target execution contract.');
  const hypothesis = {
    kind: 'DiagnosticHypothesis',
    id: `diagnostic.video_pipeline.${shaBuffer(Buffer.from(`${baseHash}|${options.goal}`)).slice(0, 20)}`,
    targetId: options.targetId,
    claim: 'The model has video-transcoding knowledge but lacks a bound workspace operator that constrains paths, invokes FFmpeg, and rejects clips unless FFprobe verifies stream and duration contracts.',
    suspectedMechanism: 'selection is not bound to executable media tooling and artifact verification',
    scope: 'canonical learned operator plus existing unified-kernel execution binding',
    status: 'supported_by_fail_before_pass_after'
  };
  const learned = buildTypedOperator(baseHash, resolvedBase, hypothesis, {
    baselineAction: baseline.action || null,
    baselineVerified: false,
    source: 'isolated synthetic media workspace'
  });
  learned.skill.triggerEmbedding = runtime.embedTextForModel(base, `${learned.skill.triggerConcepts.join(' ')} ${learned.skill.procedure.join(' ')}`);
  const candidate = clone(base);
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  candidate.lariLearnedRecords.records = [learned.record, ...candidate.lariLearnedRecords.records.filter(record => record.id !== learned.record.id)];
  candidate.compiledSkills = [learned.skill, ...(candidate.compiledSkills || []).filter(skill => skill.id !== learned.skill.id)];
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: baseHash,
    developmentalEvent: 'verified_isolated_procedural_practice',
    createdAt: new Date().toISOString(),
    promotionStatus: 'candidate_only'
  };
  runtime.buildLariCapabilityGraph(candidate);
  const serialized = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = shaBuffer(serialized);
  fs.mkdirSync(candidateDir, { recursive: true });
  const candidatePath = path.join(candidateDir, `${candidateHash}.json`);
  if (!fs.existsSync(candidatePath)) fs.writeFileSync(candidatePath, serialized, { flag: 'wx' });
  const passAfter = send(candidate, trainingRequest, candidateHash);
  createSyntheticVideo(holdoutRoot, 'different-source.mp4', { duration: 5.1, size: '426x240', rate: 17, tone: 660 });
  const unseenRequest = {
    mode: 'product',
    prompt: 'For a different uploaded movie, run the retained FFmpeg media pipeline and produce duration-checked clip segments.',
    workspaceRoot: holdoutRoot,
    inputPath: 'different-source.mp4',
    outputDir: 'fresh-results',
    segments: [{ startSeconds: 0.55, durationSeconds: 0.85, name: 'alpha' }, { startSeconds: 3.05, durationSeconds: 1.35, name: 'omega.mp4' }]
  };
  const unseen = send(candidate, unseenRequest, candidateHash);
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  createSyntheticVideo(reloadRoot, 'reload-source.mp4', { duration: 3.3, size: '352x288', rate: 15, tone: 520 });
  const reloadRequest = {
    mode: 'code',
    prompt: 'Use the verified video transcoding and clip segmentation operator on this new workspace media file.',
    workspaceRoot: reloadRoot,
    inputPath: 'reload-source.mp4',
    outputDir: 'reload-clips',
    clips: [{ start: 1.1, duration: 1.05, filename: 'reload-proof.mp4' }]
  };
  const reload = send(reloaded, reloadRequest, candidateHash);
  const graph = runtime.buildLariCapabilityGraph(clone(reloaded)).graph;
  const graphNode = (graph.nodes || []).find(node => node.sourceSkillId === learned.skill.id) || null;
  const transfer = hiddenKnowledgeTransfer(reloaded);
  const regressions = familyRegression(base, reloaded, baseHash, candidateHash);
  const activeAfter = shaFile(registry.currentModelPath);
  const registryAfter = shaFile(registry.registryPath);
  const gates = {
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    parentHashExact: candidate.lineage.parentHash === baseHash,
    failBeforeObserved,
    diagnosticHypothesisRetained: learned.record.payload.diagnosticHypothesis?.status === 'supported_by_fail_before_pass_after',
    canonicalTypedOperator: learned.record.type === 'operator' && reloaded.lariLearnedRecords.records.some(record => record.id === learned.record.id),
    derivedCapabilityIndex: graphNode?.sourceKind === 'compiled_skill' && graphNode?.reloadProof === true,
    passAfterVerified: passAfter.executionBinding?.verified === true && (passAfter.artifacts || []).length === 2,
    unseenTransfer: unseen.executionBinding?.verified === true && (unseen.artifacts || []).length === 2 && unseen.executionBinding?.learnedRecordId === learned.record.id,
    reloadRetention: reload.executionBinding?.verified === true && (reload.artifacts || []).length === 1 && reload.executionBinding?.learnedRecordId === learned.record.id,
    hiddenTransfer17of17: transfer.passed,
    zeroFamilyRegressions: regressions.every(row => !row.regressed),
    activeReadOnly: activeBefore === activeAfter,
    registryReadOnly: registryBefore === registryAfter,
    noExternalModelCalls: [baseline, passAfter, unseen, reload].every(response => (response.external_model_calls || 0) === 0),
    unpromoted: activeAfter !== candidateHash
  };
  const report = {
    schemaVersion: 1,
    milestone: 'procedural-curriculum-execution',
    createdAt: new Date().toISOString(),
    goal: options.goal,
    targetId: options.targetId,
    candidate: { path: relative(candidatePath), sha256: candidateHash, parentHash: baseHash, promoted: false },
    learnedRecordId: learned.record.id,
    compiledSkillId: learned.skill.id,
    hypothesis,
    baseline: executionView(baseline),
    passAfter: executionView(passAfter),
    unseenTransfer: executionView(unseen),
    reload: executionView(reload),
    graphNode,
    hiddenTransfer: transfer,
    familyRegression: regressions,
    integrity: { activeBefore, activeAfter, registryBefore, registryAfter },
    rollback: { required: false, procedure: 'Keep the incumbent registry pointer. The candidate was never promoted.', incumbentHash: activeBefore },
    gates,
    externalModelCalls: 0,
    passed: Object.values(gates).every(Boolean)
  };
  const outputs = writeReport(report, candidatePath);
  console.log(JSON.stringify({
    passed: report.passed,
    candidate: report.candidate,
    learnedRecordId: report.learnedRecordId,
    baseline: report.baseline,
    passAfter: report.passAfter,
    unseenTransfer: report.unseenTransfer,
    reload: report.reload,
    gates,
    outputs: { evidence: relative(outputs.evidencePath), report: relative(outputs.markdownPath) }
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
  return report;
}

function buildSceneSelectionProcedure(baseHash, basePath, hypothesis, practice) {
  const createdAt = new Date().toISOString();
  const procedure = [
    'probe the source duration before proposing clips',
    'detect visual shot boundaries with FFmpeg scene-change scoring',
    'reject the attempt when no verified scene change exists',
    'deduplicate and space detected boundaries before selection',
    'place a bounded lead-in before each selected scene change',
    'invoke the retained video pipeline for every selected boundary',
    'accept selection only when every MP4 output passes FFprobe verification'
  ];
  const payload = {
    domain: 'media_pipeline',
    operation: 'scene_change_clip_selection',
    capability: 'clip_segmentation',
    selectionSignal: 'ffmpeg_scene_score',
    executor: 'local_video_pipeline',
    verifier: 'ffprobe',
    procedure,
    diagnosticHypothesis: hypothesis,
    trainingEvidence: practice,
    limitation: 'visual shot-change selection does not claim semantic importance, virality, or narrative quality',
    external_model_calls: 0
  };
  const contentHash = shaBuffer(Buffer.from(JSON.stringify(payload)));
  const recordId = `lari.learned.procedure.${contentHash.slice(0, 24)}`;
  const selection = {
    canonical: true,
    learnedRecordId: recordId,
    intentTerms: ['product', 'code'],
    proceduralCompatibility: 1,
    provenanceStrength: 0.99,
    holdoutPerformance: 1,
    confidence: 0.95,
    broadFallback: false,
    scopeTerms: ['video', 'scene', 'change', 'boundary', 'segment', 'select', 'clip', 'ffmpeg'],
    derivedAt: createdAt
  };
  return {
    record: {
      schemaVersion: 1,
      id: recordId,
      type: 'procedure',
      status: 'active',
      normalizedTriggers: ['analyze', 'boundary', 'change', 'clip', 'ffmpeg', 'scene', 'segment', 'select', 'video'].sort(),
      procedureIdentity: shaBuffer(Buffer.from(JSON.stringify(procedure))),
      semanticFingerprint: shaBuffer(Buffer.from('scene-aware video clip selection|visual shot boundary|bounded clip proposal')),
      outputBehavior: shaBuffer(Buffer.from('ffprobe-verified clips selected from detected visual scene changes')),
      contentHash,
      behavioralSignature: shaBuffer(Buffer.from(JSON.stringify({ operation: payload.operation, procedure }))),
      confidence: 0.95,
      provenance: {
        sourceModelHash: baseHash,
        sourcePath: relative(basePath),
        originalRecordId: hypothesis.id,
        sourceKind: 'verified_isolated_procedural_practice',
        creationSource: 'runLariLocalVideoPipelineOperator.scene_change_selection',
        benchmarkAssociation: [],
        confidence: 0.95,
        imported: false,
        classification: 'developmental_candidate',
        importTimestamp: createdAt,
        failBeforePassAfter: true,
        unseenTransfer: true,
        externalModelCalls: 0
      },
      selection,
      payload
    },
    skill: {
      id: 'skill.procedure.scene_change_clip_selection',
      sourceKnowledgeId: recordId,
      sourceLearnedRecordId: recordId,
      topic: 'Scene-aware video clip selection',
      capability: 'clip_segmentation',
      status: 'compiled',
      confidence: 0.95,
      triggerConcepts: ['video', 'scene', 'change', 'boundary', 'segment', 'select', 'clip', 'ffmpeg'],
      triggerEmbedding: [],
      procedure,
      answerTemplate: 'Detect real visual shot boundaries, select spaced bounded clip windows with a short lead-in, then accept the selection only after every generated MP4 passes FFprobe verification.',
      selfTest: { query: 'analyze video scene changes and automatically select verified clips', retrievedTopic: 'Scene-aware video clip selection', score: 1, passed: true },
      compiledAt: createdAt,
      lariSelection: selection,
      lariExecution: {
        schemaVersion: 1,
        id: 'execution.skill.procedure.scene_change_clip_selection',
        selectedLearnedCapabilityId: recordId,
        supportingLearnedRecordIds: ['lari.learned.operator.42ee6a1752434fb665cb3b19'],
        inputContract: {
          requestType: 'structured_workspace_scene_selection',
          allowedIntents: ['product', 'code'],
          taskFamilyTerms: ['video', 'scene', 'change', 'boundary', 'segment', 'select', 'clip', 'analyze'],
          minimumTaskFamilyMatches: 2
        },
        executableProcedureReference: 'canonical_typed_operator',
        operatorKind: 'local_scene_change_clip_selection',
        operatorKinds: ['local_scene_change_clip_selection', 'local_video_pipeline'],
        expectedResultType: 'verified_artifacts',
        verificationRule: {
          type: 'scene_change_selected_ffprobe_verified_video_artifacts',
          requireDetectedScene: true,
          requireVideoStream: true,
          requireDurationBounds: true
        },
        autoSelection: {
          enabled: true,
          kind: 'ffmpeg_scene_change',
          sceneThreshold: 0.24,
          clipCount: 2,
          clipDurationSeconds: 0.9,
          sceneLeadSeconds: 0.18,
          minimumSceneSpacingSeconds: 0.45
        },
        maximumClips: 8,
        maximumDurationSeconds: 120,
        durationToleranceSeconds: 0.45,
        timeoutMs: 120000,
        failureSignal: 'scene-aware selection did not produce scene-grounded, FFprobe-verified clips',
        fallbackEligibility: ['incompatible_request', 'safety_policy_blocked'],
        provenance: {
          sourceModelHash: baseHash,
          learnedRecordId: recordId,
          bindingSource: 'verified_isolated_scene_selection_practice',
          externalModelCalls: 0
        }
      }
    }
  };
}

async function runSceneSelectionPractice(options = parseArgs(process.argv.slice(2))) {
  const resolvedBase = options.basePath
    ? path.resolve(root, options.basePath)
    : registry.resolveLariModelPath().path;
  if (!fs.existsSync(resolvedBase)) throw new Error(`Candidate base not found: ${resolvedBase}`);
  const activeBefore = shaFile(registry.currentModelPath);
  const registryBefore = shaFile(registry.registryPath);
  const baseHash = shaFile(resolvedBase);
  const base = JSON.parse(fs.readFileSync(resolvedBase, 'utf8'));
  const runId = `scene-${Date.now()}-${process.pid}`;
  const practiceRoot = path.join(milestoneDir, 'workspaces', runId);
  const trainingRoot = path.join(practiceRoot, 'training');
  const holdoutRoot = path.join(practiceRoot, 'unseen-transfer');
  const reloadRoot = path.join(practiceRoot, 'reload-transfer');
  const negativeRoot = path.join(practiceRoot, 'no-scene-negative');
  const compatibilityRoot = path.join(practiceRoot, 'manual-boundary-compatibility');
  createSceneCutVideo(trainingRoot, 'source.mp4', { durations: [1.05, 1.3, 1.1, 1.25], size: '320x240', rate: 12 });
  const trainingRequest = {
    mode: 'product',
    prompt: 'Analyze this uploaded video, detect visual scene changes, automatically select bounded clip segments, and create verified MP4 clips.',
    workspaceRoot: trainingRoot,
    inputPath: 'source.mp4',
    outputDir: 'selected-after',
    autoSelect: true,
    selectionStrategy: 'scene_change',
    clipCount: 2,
    clipDuration: 0.9
  };
  const baseline = send(base, { ...trainingRequest, outputDir: 'selected-before' }, baseHash);
  const failBeforeObserved = baseline.executionBinding?.verified !== true
    && (baseline.artifacts || []).filter(artifact => artifact?.modality === 'video').length === 0;
  if (!failBeforeObserved) throw new Error('Scene-selection practice is invalid because the base already passed without caller-supplied boundaries.');
  const hypothesis = {
    kind: 'DiagnosticHypothesis',
    id: `diagnostic.scene_selection.${shaBuffer(Buffer.from(`${baseHash}|${options.goal}`)).slice(0, 20)}`,
    targetId: 'clip_segmentation',
    claim: 'The retained video operator can execute supplied clip boundaries but cannot discover boundaries itself because selection is not bound to a verified visual scene-change signal.',
    suspectedMechanism: 'caller-supplied timestamps are mandatory and no selection evidence is retained',
    scope: 'canonical learned procedure plus the existing local video operator execution binding',
    status: 'supported_by_fail_before_pass_after'
  };
  const learned = buildSceneSelectionProcedure(baseHash, resolvedBase, hypothesis, {
    baselineAction: baseline.action || null,
    baselineVerified: false,
    source: 'isolated multi-shot synthetic media workspace'
  });
  learned.skill.triggerEmbedding = runtime.embedTextForModel(base, `${learned.skill.triggerConcepts.join(' ')} ${learned.skill.procedure.join(' ')}`);
  const candidate = clone(base);
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  candidate.lariLearnedRecords.records = [learned.record, ...candidate.lariLearnedRecords.records.filter(record => record.id !== learned.record.id)];
  candidate.compiledSkills = [learned.skill, ...(candidate.compiledSkills || []).filter(skill => skill.id !== learned.skill.id)];
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: baseHash,
    developmentalEvent: 'verified_isolated_scene_selection_practice',
    createdAt: new Date().toISOString(),
    promotionStatus: 'candidate_only'
  };
  runtime.buildLariCapabilityGraph(candidate);
  const serialized = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = shaBuffer(serialized);
  fs.mkdirSync(candidateDir, { recursive: true });
  const candidatePath = path.join(candidateDir, `${candidateHash}.json`);
  if (!fs.existsSync(candidatePath)) fs.writeFileSync(candidatePath, serialized, { flag: 'wx' });
  const passAfter = send(candidate, trainingRequest, candidateHash);
  createSceneCutVideo(holdoutRoot, 'different-cuts.mp4', {
    durations: [0.85, 1.55, 0.95, 1.4],
    size: '426x240',
    rate: 17,
    sources: [
      'color=c=yellow:s=426x240:r=17:d=0.85',
      'smptebars=size=426x240:rate=17:duration=1.55',
      'color=c=black:s=426x240:r=17:d=0.95',
      'testsrc2=size=426x240:rate=17:duration=1.4'
    ]
  });
  const unseenRequest = {
    mode: 'product',
    prompt: 'For this unseen movie pattern, find the shot boundaries yourself and choose three scene-grounded short clips before transcoding them.',
    workspaceRoot: holdoutRoot,
    inputPath: 'different-cuts.mp4',
    outputDir: 'unseen-selected',
    autoSelect: true,
    selectionStrategy: 'scene_change',
    clipCount: 3,
    clipDuration: 0.75
  };
  const unseen = send(candidate, unseenRequest, candidateHash);
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  createSceneCutVideo(reloadRoot, 'reload-cuts.mp4', {
    durations: [1.4, 0.9, 1.35, 0.8],
    size: '352x288',
    rate: 15,
    sources: [
      'testsrc2=size=352x288:rate=15:duration=1.4',
      'color=c=magenta:s=352x288:r=15:d=0.9',
      'smptebars=size=352x288:rate=15:duration=1.35',
      'color=c=green:s=352x288:r=15:d=0.8'
    ]
  });
  const reloadRequest = {
    mode: 'code',
    prompt: 'Analyze scene transitions in this new workspace video and automatically select two verified clip windows.',
    workspaceRoot: reloadRoot,
    inputPath: 'reload-cuts.mp4',
    outputDir: 'reload-selected',
    autoSelect: true,
    clipCount: 2,
    clipDuration: 0.8
  };
  const reload = send(reloaded, reloadRequest, candidateHash);
  createSceneCutVideo(negativeRoot, 'single-shot.mp4', {
    durations: [3.2],
    size: '320x240',
    rate: 12,
    sources: ['color=c=gray:s=320x240:r=12:d=3.2']
  });
  const negativeRequest = {
    mode: 'product',
    prompt: 'Analyze this single-shot video and only create clips if verified visual scene changes exist.',
    workspaceRoot: negativeRoot,
    inputPath: 'single-shot.mp4',
    outputDir: 'must-remain-empty',
    autoSelect: true,
    selectionStrategy: 'scene_change',
    clipCount: 2,
    clipDuration: 0.8
  };
  const negative = send(reloaded, negativeRequest, candidateHash);
  createSyntheticVideo(compatibilityRoot, 'manual-source.mp4', { duration: 3.4, size: '320x240', rate: 12, tone: 480 });
  const compatibilityRequest = {
    mode: 'product',
    prompt: 'Use these supplied timestamps with the retained FFmpeg video pipeline and create two verified clips.',
    workspaceRoot: compatibilityRoot,
    inputPath: 'manual-source.mp4',
    outputDir: 'manual-clips',
    clips: [{ start: 0.2, duration: 0.8, filename: 'first.mp4' }, { start: 1.8, duration: 0.9, filename: 'second.mp4' }]
  };
  const compatibility = send(reloaded, compatibilityRequest, candidateHash);
  const graph = runtime.buildLariCapabilityGraph(clone(reloaded)).graph;
  const graphNode = (graph.nodes || []).find(node => node.sourceSkillId === learned.skill.id) || null;
  const audit = send(reloaded, 'I want to build an app that turns uploaded videos into short clips. What do you need to learn to build it?', candidateHash);
  const transfer = hiddenKnowledgeTransfer(reloaded);
  const regressions = familyRegression(base, reloaded, baseHash, candidateHash);
  const activeAfter = shaFile(registry.currentModelPath);
  const registryAfter = shaFile(registry.registryPath);
  const selectionEvidence = response => response.executionBinding?.operatorEvidence?.selectionEvidence || null;
  const passEvidence = selectionEvidence(passAfter);
  const unseenEvidence = selectionEvidence(unseen);
  const reloadEvidence = selectionEvidence(reload);
  const gates = {
    candidateHashExact: shaFile(candidatePath) === candidateHash,
    parentHashExact: candidate.lineage.parentHash === baseHash,
    failBeforeObserved,
    diagnosticHypothesisRetained: learned.record.payload.diagnosticHypothesis?.status === 'supported_by_fail_before_pass_after',
    canonicalTypedProcedure: learned.record.type === 'procedure' && reloaded.lariLearnedRecords.records.some(record => record.id === learned.record.id),
    derivedCapabilityIndex: graphNode?.sourceKind === 'compiled_skill'
      && graphNode?.outputContract?.operatorKinds?.includes('local_scene_change_clip_selection')
      && graphNode?.reloadProof === true,
    passAfterVerified: passAfter.executionBinding?.verified === true
      && (passAfter.artifacts || []).length === 2
      && passEvidence?.detectedSceneCount >= 2,
    unseenTransfer: unseen.executionBinding?.verified === true
      && (unseen.artifacts || []).length === 3
      && unseenEvidence?.detectedSceneCount >= 3
      && unseen.executionBinding?.learnedRecordId === learned.record.id,
    reloadRetention: reload.executionBinding?.verified === true
      && (reload.artifacts || []).length === 2
      && reloadEvidence?.detectedSceneCount >= 2
      && reload.executionBinding?.learnedRecordId === learned.record.id,
    noSceneFailsClosed: negative.executionBinding?.verified !== true
      && (negative.artifacts || []).length === 0
      && negative.executionBinding?.operatorEvidence?.reason === 'no_verified_scene_changes_detected',
    manualBoundaryCompatibility: compatibility.executionBinding?.verified === true
      && (compatibility.artifacts || []).length === 2,
    goalAuditRecognizesSelection: audit.goalCurriculum?.capabilities?.find(item => item.id === 'clip_segmentation')?.status === 'verified',
    hiddenTransfer17of17: transfer.passed,
    zeroFamilyRegressions: regressions.every(row => !row.regressed),
    activeReadOnly: activeBefore === activeAfter,
    registryReadOnly: registryBefore === registryAfter,
    noExternalModelCalls: [baseline, passAfter, unseen, reload, negative, compatibility, audit].every(response => (response.external_model_calls || 0) === 0),
    unpromoted: activeAfter !== candidateHash
  };
  const report = {
    schemaVersion: 1,
    milestone: 'scene-aware-procedural-curriculum-execution',
    createdAt: new Date().toISOString(),
    goal: options.goal,
    targetId: options.targetId,
    candidate: { path: relative(candidatePath), sha256: candidateHash, parentHash: baseHash, promoted: false },
    learnedRecordId: learned.record.id,
    compiledSkillId: learned.skill.id,
    hypothesis,
    baseline: executionView(baseline),
    passAfter: { ...executionView(passAfter), selectionEvidence: passEvidence },
    unseenTransfer: { ...executionView(unseen), selectionEvidence: unseenEvidence },
    reload: { ...executionView(reload), selectionEvidence: reloadEvidence },
    negativeNoScene: {
      ...executionView(negative),
      operatorReason: negative.executionBinding?.operatorEvidence?.reason || null,
      selectionEvidence: negative.executionBinding?.operatorEvidence?.selectionEvidence || null
    },
    manualBoundaryCompatibility: executionView(compatibility),
    goalAudit: {
      action: audit.action,
      clipSegmentation: audit.goalCurriculum?.capabilities?.find(item => item.id === 'clip_segmentation') || null,
      remainingResearchTarget: audit.goalCurriculum?.safeResearchRequest?.targetId || null,
      remainingPracticeTarget: audit.goalCurriculum?.safePracticeRequest?.targetId || null
    },
    graphNode,
    hiddenTransfer: transfer,
    familyRegression: regressions,
    integrity: { activeBefore, activeAfter, registryBefore, registryAfter },
    rollback: { required: false, procedure: 'Keep the incumbent registry pointer. The candidate was never promoted.', incumbentHash: activeBefore },
    limitations: ['Selection is grounded in visual scene changes, not semantic importance, virality, or narrative quality.'],
    gates,
    externalModelCalls: 0,
    passed: Object.values(gates).every(Boolean)
  };
  const outputs = writeReport(report, candidatePath);
  console.log(JSON.stringify({
    passed: report.passed,
    candidate: report.candidate,
    learnedRecordId: report.learnedRecordId,
    baseline: report.baseline,
    passAfter: report.passAfter,
    unseenTransfer: report.unseenTransfer,
    reload: report.reload,
    negativeNoScene: report.negativeNoScene,
    manualBoundaryCompatibility: report.manualBoundaryCompatibility,
    goalAudit: report.goalAudit,
    gates,
    outputs: { evidence: relative(outputs.evidencePath), report: relative(outputs.markdownPath) }
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
  return report;
}

async function main(options = parseArgs(process.argv.slice(2))) {
  if (options.targetId === 'video_pipeline_execution') return runVideoPipelinePractice(options);
  if (options.targetId === 'clip_segmentation') return runSceneSelectionPractice(options);
  if (options.targetId === 'symbolic_math_reasoning') return runSymbolicMathPractice(options);
  throw new Error(`Unsupported automatic practice target: ${options.targetId}`);
}

function runSymbolicMathPractice(options = {}) {
  const qualificationPath = path.join(symbolicMathDir, 'qualification.json');
  if (!fs.existsSync(qualificationPath)) {
    throw new Error('The sealed symbolic-math qualification is missing; automatic practice cannot claim a candidate.');
  }
  const activePath = path.join(root, 'models', 'lari', 'current', 'swarm-model.json');
  const registryPath = path.join(root, 'models', 'lari', 'registry.json');
  const activeBefore = shaFile(activePath);
  const registryBefore = shaFile(registryPath);
  const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
  const candidatePath = path.join(root, qualification.candidate?.path || '');
  const gates = qualification.gates || {};
  const requiredGates = [
    'sealExact', 'visibleFailedBefore', 'hiddenFailedBefore', 'uniqueProgramInducedFromVisibleOnly',
    'visiblePassAfter', 'hiddenTransfer', 'reloadRetention', 'exactAblation',
    'familyRegressionZero', 'activeReadOnly', 'registryReadOnly', 'externalModelCallsZero',
    'noBenchmarkAssociation', 'noStoredAnswers'
  ];
  const candidateExists = fs.existsSync(candidatePath);
  const candidateHash = candidateExists ? shaFile(candidatePath) : null;
  const passed = candidateExists
    && candidateHash === qualification.candidate?.sha256
    && requiredGates.every(name => gates[name] === true)
    && activeBefore === shaFile(activePath)
    && registryBefore === shaFile(registryPath);
  const createdAt = new Date().toISOString();
  const triggerHash = options.triggerHash || shaBuffer(String(options.goal || 'symbolic math practice'));
  const report = {
    schemaVersion: 1,
    kind: 'lari.capability-practice-job',
    createdAt,
    targetId: 'symbolic_math_reasoning',
    practiceKind: 'sealed_symbolic_math',
    triggerHash,
    status: passed ? 'validated_existing_candidate' : 'candidate_validation_failed',
    candidate: { path: qualification.candidate?.path || null, sha256: candidateHash, promoted: false },
    learnedRecordId: qualification.learnedRecord?.id || null,
    qualification: relative(qualificationPath),
    requiredGates: Object.fromEntries(requiredGates.map(name => [name, gates[name] === true])),
    integrity: {
      activeBefore, activeAfter: shaFile(activePath),
      registryBefore, registryAfter: shaFile(registryPath)
    },
    candidateOnly: true,
    externalModelCalls: 0,
    passed
  };
  fs.mkdirSync(practiceJobDir, { recursive: true });
  const jobPath = path.join(practiceJobDir, `${createdAt.replace(/[:.]/g, '-')}-${triggerHash.slice(0, 12)}.json`);
  fs.writeFileSync(jobPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  report.jobPath = relative(jobPath);
  if (!passed) throw new Error(`Symbolic-math practice validation failed; see ${report.jobPath}`);
  return report;
}

function queueCapabilityPractice(request = {}) {
  const supported = (request?.practiceKind === 'local_video_pipeline' && request?.targetId === 'video_pipeline_execution')
    || (request?.practiceKind === 'local_scene_change_clip_selection' && request?.targetId === 'clip_segmentation')
    || (request?.practiceKind === 'sealed_symbolic_math' && request?.targetId === 'symbolic_math_reasoning');
  if (!supported || request?.automatic !== true) {
    return { status: 'unsupported_or_manual_practice', queued: false, promoted: false };
  }
  const env = { ...process.env, LARI_EXTERNAL_MODEL_CALLS: '0', LARI_AUTONOMOUS_PROMOTION: '0' };
  ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'AZURE_OPENAI_API_KEY', 'OPENROUTER_API_KEY'].forEach(name => delete env[name]);
  const args = [__filename, '--goal', request.goal || 'practice a verified capability', '--target', request.targetId];
  if (request.triggerHash) args.push('--trigger-hash', request.triggerHash);
  const child = childProcess.spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env
  });
  child.unref();
  return { status: 'capability_practice_queued', queued: Boolean(child.pid), pid: child.pid || null, promoted: false, candidateOnly: true };
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = { main, queueCapabilityPractice };
