#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime');
const tools = require('../swarm_external_tools');
const registry = require('./lari_model_registry');

const root = path.resolve(__dirname, '..');
const candidateDir = path.join(root, 'consolidation', 'learning-candidates');
const reportPath = process.env.LARI_LEARNING_REPORT_PATH
  ? path.resolve(process.env.LARI_LEARNING_REPORT_PATH)
  : path.join(root, 'benchmarks', 'latest-lari-failure-driven-learning-report.json');
const shaBuffer = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => shaBuffer(fs.readFileSync(file));
const clone = value => JSON.parse(JSON.stringify(value));

function researchTerms(value = '') {
  const stop = new Set(['about', 'answer', 'arrive', 'does', 'explain', 'faster', 'from', 'have', 'helps', 'into', 'lari', 'local', 'model', 'process', 'request', 'should', 'that', 'the', 'them', 'they', 'this', 'what', 'when', 'where', 'which', 'why', 'with', 'workers', 'would']);
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter(term => term.length > 3 && !stop.has(term));
}

function assertResearchEvidenceRelevant(query, evidence = {}) {
  const queryTerms = researchTerms(query);
  if (!queryTerms.length) return;
  const sourceText = (evidence.sources || []).map(source => `${source.title || ''} ${source.text || ''}`).join(' ').toLowerCase();
  const matched = queryTerms.filter(term => sourceText.includes(term));
  // One distinctive concept must survive retrieval.  This prevents a generic
  // search fallback from teaching Lari an unrelated article simply because it
  // returned with a superficially plausible confidence score.
  if (!matched.length) {
    throw new Error(`Research evidence is unrelated to the requested capability; expected one of: ${queryTerms.join(', ')}`);
  }
}

function forbiddenStatePaths(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const forbidden = new Set(['prompt', 'query', 'trace', 'path', 'workspacePath', 'session', 'turns']);
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = prefix ? `${prefix}.${key}` : key;
    return [
      ...(forbidden.has(key) ? [childPath] : []),
      ...forbiddenStatePaths(child, childPath)
    ];
  });
}

function atomicReport(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function view(model, prompt, hash) {
  const response = runtime.sendMessageToLari(clone(model), prompt, {
    modelHash: hash,
    autoGrow: false,
    kernel: {
      useBenchmarkSystem: false,
      useCapabilityGraph: true,
      capabilityGraph: { minScore: 0 },
      chat: {
        minMemoryScore: 0,
        minRouteScore: 0,
        retainedKnowledgeMinScore: 0.24,
        retainedKnowledgeAnswerScore: 0.28
      }
    }
  });
  return {
    answer: response.answer,
    action: response.action,
    learnedRecordIds: response.learnedRecordIds || [],
    source: response.publicAnswerSource
      || response.trace?.find(item => item.phase === 'chat')?.publicAnswerSource
      || null,
    retained: response.trace?.find(item => item.phase === 'chat')?.retainedKnowledge
      || response.brainDecision?.retainedKnowledge
      || null
  };
}

function readSuppliedEvidence() {
  const raw = String(process.env.LARI_LEARNING_EVIDENCE_JSON || '').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('LARI_LEARNING_EVIDENCE_JSON must be a JSON array.');
  return parsed
    .map((item, index) => ({
      title: String(item.title || `Retrieved source ${index + 1}`),
      url: String(item.url || ''),
      sourceType: String(item.sourceType || 'retrieved_reference'),
      text: String(item.text || item.summary || ''),
      trust: Number(item.trust ?? item.confidence ?? 0.78),
      updatedAt: item.updatedAt || item.observedAt || null
    }))
    .filter(item => item.text.trim().length > 0 && item.url.trim().length > 0);
}

function requestedEvidenceRoles(query = '') {
  const text = String(query || '').toLowerCase();
  return [
    { id: 'definition', requested: /\b(?:define|what is|what are)\b/.test(text), cue: /\b(?:is|are|means|refers to|consists of|converts?|changes?|transforms?)\b/i },
    { id: 'process', requested: /\b(?:how it works|how .* works|process|steps?|sequence)\b/.test(text), cue: /\b(?:first|then|next|after|before|finally|stage|step|reaction|cycle|converts?|splits?|captures?|uses?)\b/i },
    { id: 'cause_or_significance', requested: /\b(?:why|matters?|importance|effect|cause)\b/.test(text), cue: /\b(?:because|causes?|leads? to|results? in|responsible for|supports?|provides?|enables?|allows?|important|essential|oxygen|energy)\b/i },
    { id: 'comparison', requested: /\b(?:compare|comparison|difference|versus|vs\.)\b/.test(text), cue: /\b(?:whereas|unlike|compared with|compared to|differs? from|in contrast|rather than)\b/i },
    { id: 'quantity', requested: /\b(?:how many|how much|amount|number|scale|rate|percentage|percent)\b/.test(text), cue: /\b\d+(?:\.\d+)?\s*(?:%|percent|times?|seconds?|minutes?|hours?|meters?|kilometers?)?\b/i },
    { id: 'hypothesis', requested: /\b(?:hypothesis|theory|uncertain|competing explanation)\b/.test(text), cue: /\b(?:hypothesis|theory|evidence.+suggests|may|might|could|researchers propose)\b/i }
  ].filter(role => role.requested);
}

function queryFocusTerms(query = '', topicTerms = []) {
  // The question's focus: content words nearest the interrogative that are
  // NOT topic words. For "what is the capital of X" this is "capital" --
  // the thing the question actually asks about. Topic words ("assyria")
  // are already counted separately; including them here would let generic
  // topic sentences outrank sentences that answer the question.
  const stop = new Set(('what,which,who,whom,whose,when,where,why,how,is,are,was,were,be,been,being,do,does,did,have,has,had,will,would,should,could,can,the,a,an,of,to,in,on,for,and,or,by,from,with,about,as,at,that,this,these,those,it,its,define,definition,explain,tell,me,us,research,learn,study,lookup').split(','));
  const terms = [...new Set((String(query || '').toLowerCase().match(/[a-z][a-z'-]*/g) || [])
    .filter(term => term.length > 3 && !stop.has(term)))];
  // Only the FIRST non-topic content word is the question's focus. Later
  // ones ("ancient" in "capital of the ancient empire") are usually
  // topic-adjacent noise that would let generic sentences outrank the
  // sentence that actually answers the question.
  const focus = terms
    .filter(term => !topicTerms.some(topicTerm => topicTerm.includes(term) || term.includes(topicTerm)))
    .slice(0, 1);
  return focus;
}

function targetedRoleSources(topic = '', fullText = '', sourceUrl = '', roles = [], query = '') {
  const topicTerms = String(topic).toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 3);
  const focusTerms = queryFocusTerms(query, topicTerms);
  const sentences = String(fullText || '')
    .split(/(?<=[.!?])\s+|[\r\n]+/)
    .map(sentence => sentence.replace(/\s+/g, ' ').trim())
    .filter(sentence => sentence.length >= 30 && sentence.length <= 520);
  return roles.map(role => {
    const ranked = sentences.map((sentence, index) => {
      const lower = sentence.toLowerCase();
      const topicHits = topicTerms.filter(term => lower.includes(term)).length;
      const cueHits = role.cue.test(sentence) ? 1 : 0;
      const focusHits = focusTerms.filter(term => lower.includes(term)).length;
      const headingPenalty = /^=+|references|external links|bibliography/i.test(sentence) ? 1 : 0;
      // A single-term focus ("capital") is a boost, never a requirement:
      // it lifts the sentence that answers the question above generic
      // topic sentences without starving other roles of evidence.
      return { sentence, index, score: topicHits * 4 + cueHits * 6 + focusHits * 12 - headingPenalty * 20 };
    }).filter(item => item && item.score >= 10)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 4);
    if (!ranked.length) return null;
    return {
      title: `${topic} — targeted ${role.id} evidence`,
      url: sourceUrl,
      sourceType: `encyclopedia_targeted_${role.id}`,
      text: ranked.map(item => item.sentence).join(' '),
      trust: 0.82,
      updatedAt: new Date().toISOString(),
      evidenceRole: role.id
    };
  }).filter(Boolean);
}

async function resolveEvidence(query) {
  const supplied = readSuppliedEvidence();
  if (supplied.length) {
    return {
      topic: supplied[0].title || query,
      sources: supplied,
      reusedPublicAnswerEvidence: true
    };
  }
  let knowledge;
  try {
    knowledge = await tools.resolveResearchEvidence(query, { timeoutMs: 10000 });
  } catch (firstError) {
    const response = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Lari-Research-Learning/1.0' }
    });
    if (!response.ok) throw firstError;
    const search = await response.json();
    const title = search?.query?.search?.[0]?.title;
    if (!title) throw firstError;
    knowledge = await tools.resolveResearchEvidence(title, { timeoutMs: 10000 });
  }
  const result = {
    topic: knowledge.topic,
    sources: (knowledge.sources || [{
      title: knowledge.topic,
      url: knowledge.sourceUrl,
      sourceType: knowledge.sourceType || 'encyclopedia_reference',
      text: knowledge.summary,
      trust: knowledge.confidence || 0.78,
      updatedAt: knowledge.observedAt || null
    }]).filter(source => source?.url && source?.text),
    reusedPublicAnswerEvidence: false
  };
  const roles = requestedEvidenceRoles(query);
  if (roles.length) {
    try {
      const full = await tools.resolveKnowledge(result.topic, { timeoutMs: 12000, fullExtract: true });
      const roleSources = targetedRoleSources(full.topic || result.topic, full.summary, full.sourceUrl, roles, query);
      result.sources = [...result.sources, ...roleSources]
        .filter((source, index, all) => all.findIndex(item => item.sourceType === source.sourceType && item.text === source.text) === index)
        .slice(0, 12);
      result.requestedEvidenceRoles = roles.map(role => role.id);
      result.resolvedEvidenceRoles = roleSources.map(source => source.evidenceRole);
    } catch (_) {
      result.requestedEvidenceRoles = roles.map(role => role.id);
      result.resolvedEvidenceRoles = [];
    }
  }
  return result;
}

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) throw new Error('Usage: npm run lari:learn -- "What should Lari research and learn?"');

  const loaded = registry.loadLariModel();
  const activePath = loaded.resolved.path;
  const activeHash = shaFile(activePath);
  const registryHash = shaFile(registry.registryPath);
  const base = loaded.model;
  const before = view(base, query, activeHash);
  const evidence = await resolveEvidence(query);
  assertResearchEvidenceRelevant(query, evidence);
  const disposableWorkingModel = clone(base);
  const learnRun = runtime.runAutonomousKnowledgeAcquisition(disposableWorkingModel, query, {
    force: true,
    topic: evidence.topic,
    sources: evidence.sources,
    sourceAdapter: evidence.reusedPublicAnswerEvidence
      ? 'knowledge.public_answer_evidence'
      : 'knowledge.wikipedia_summary',
    sourceScoring: { minSourceScore: 0.25 },
    // An explicit research acquisition is new scoped knowledge. A generic
    // conversational response program must not shadow it as a "duplicate".
    forceNewClaimRecord: true,
    compile: { threshold: 0.5, limit: 420 },
    consolidate: { maxMemories: 40, maxBridges: 32 }
  });
  if (learnRun.action !== 'learned_from_sources' || !learnRun.learned) {
    throw new Error(`Learning failed: ${learnRun.action}`);
  }

  const learned = learnRun.learned;
  const acceptedTrust = evidence.sources.length
    ? evidence.sources.reduce((sum, source) => sum + Number(source.trust || 0), 0) / evidence.sources.length
    : 0;
  learned.confidence = Number(Math.max(
    Number(learned.confidence || 0),
    Math.min(0.82, acceptedTrust * 0.8)
  ).toFixed(4));
  learned.sources = learnRun.distilled?.sources || evidence.sources.map(source => ({
    title: source.title,
    url: source.url,
    sourceType: source.sourceType
  }));
  const payloadText = JSON.stringify({
    topic: learned.topic,
    summary: learned.summary,
    procedure: learned.procedure,
    sources: learned.sources
  });
  const recordHash = shaBuffer(Buffer.from(payloadText));
  const candidate = clone(base);
  candidate.lariLearnedRecords = candidate.lariLearnedRecords || { schemaVersion: 1, records: [] };
  const typed = {
    schemaVersion: 1,
    id: `lari.learned.knowledge.${recordHash.slice(0, 24)}`,
    type: 'knowledge',
    status: 'active',
    normalizedTriggers: [...new Set([
      learned.topic,
      ...(learned.conceptTokens || [])
    ].flatMap(value => String(value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)))].sort(),
    procedureIdentity: shaBuffer(Buffer.from(JSON.stringify(learned.procedure || []))),
    semanticFingerprint: shaBuffer(Buffer.from(`${learned.topic}|${learned.summary}`)),
    outputBehavior: shaBuffer(Buffer.from(learned.summary || '')),
    contentHash: recordHash,
    behavioralSignature: shaBuffer(Buffer.from(`${learned.summary}|${JSON.stringify(learned.procedure || [])}`)),
    confidence: learned.confidence,
    provenance: {
      sourceModelHash: activeHash,
      sourcePath: loaded.resolved.relativePath,
      originalRecordId: learned.id,
      sourceKind: 'knowledge',
      creationSource: 'failure_driven_authoritative_research',
      benchmarkAssociation: [],
      confidence: learned.confidence,
      imported: false,
      classification: 'developmental_candidate',
      importTimestamp: new Date().toISOString(),
      sources: learned.sources,
      reusedPublicAnswerEvidence: evidence.reusedPublicAnswerEvidence
    },
    payload: {
      ...learned,
      domain: 'general_chat',
      operation: 'compose_chat_response',
      intents: ['chat'],
      minTriggerMatches: 2
    }
  };
  const existingTyped = candidate.lariLearnedRecords.records.find(record => record.id === typed.id) || null;
  const canonicalTyped = existingTyped || typed;
  candidate.lariLearnedRecords.records = [
    canonicalTyped,
    ...candidate.lariLearnedRecords.records.filter(record => record.id !== canonicalTyped.id)
  ];
  // The incumbent still contains a legacy compiled policy that predates the
  // canonical typed-record ledger.  A candidate must not silently discard it
  // merely to satisfy strict projection rebuilding.  Bind each such skill to
  // a lossless, candidate-local procedure record and retain the original skill
  // unchanged; promotion remains gated by the normal validation suite.
  const legacyBindings = [];
  const typedById = new Set(candidate.lariLearnedRecords.records.map(record => record.id));
  candidate.compiledSkills = (candidate.compiledSkills || []).map(skill => {
    if (skill?.sourceLearnedRecordId && typedById.has(skill.sourceLearnedRecordId)) return skill;
    const sourceIdentity = JSON.stringify({
      id: skill?.id || null,
      capability: skill?.capability || null,
      topic: skill?.topic || null,
      triggerConcepts: skill?.triggerConcepts || [],
      procedure: skill?.procedure || [],
      answerTemplate: skill?.answerTemplate || null
    });
    const bindingToken = shaBuffer(Buffer.from(sourceIdentity)).slice(0, 24);
    const bindingId = `lari.learned.procedure.legacy_compiled_binding.${bindingToken}`;
    let binding = candidate.lariLearnedRecords.records.find(record => record.id === bindingId);
    if (!binding) {
      const now = new Date().toISOString();
      binding = {
        schemaVersion: 1,
        id: bindingId,
        type: 'procedure',
        status: 'active',
        normalizedTriggers: [...new Set((skill?.triggerConcepts || [skill?.capability, skill?.topic])
          .flatMap(value => String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)))].sort(),
        procedureIdentity: `legacy-compiled-skill:${bindingToken}`,
        semanticFingerprint: `legacy-compiled-skill:${bindingToken}`,
        outputBehavior: String(skill?.answerTemplate || skill?.topic || 'legacy compiled skill'),
        contentHash: `legacy-compiled-skill:${bindingToken}`,
        behavioralSignature: `legacy-compiled-skill:${bindingToken}`,
        confidence: Number(skill?.confidence || 0.5),
        provenance: {
          sourceModelHash: activeHash,
          sourcePath: loaded.resolved.relativePath,
          originalRecordId: skill?.id || null,
          sourceKind: 'legacy_compiled_skill',
          creationSource: 'candidate_projection_binding_migration',
          benchmarkAssociation: [],
          confidence: Number(skill?.confidence || 0.5),
          imported: true,
          classification: 'candidate_only_legacy_binding',
          importTimestamp: now,
          storesPromptText: false,
          storesExpectedAnswers: false
        },
        payload: {
          domain: 'workspace_coding',
          operation: 'legacy_compiled_skill_binding',
          title: skill?.topic || skill?.capability || skill?.id || 'legacy compiled skill',
          summary: skill?.answerTemplate || skill?.topic || '',
          procedure: Array.isArray(skill?.procedure) ? skill.procedure : [],
          legacyCompiledSkillId: skill?.id || null,
          verification: 'preserve_existing_compiled_skill_behavior'
        }
      };
      candidate.lariLearnedRecords.records.push(binding);
      typedById.add(bindingId);
    }
    legacyBindings.push({ compiledSkillId: skill?.id || null, learnedRecordId: bindingId });
    return { ...skill, sourceLearnedRecordId: bindingId };
  });
  runtime.refreshLariKnowledgeProjections(candidate, { strict: true });
  if (!candidate.compiledSkills.some(skill => skill.sourceLearnedRecordId === canonicalTyped.id)) {
    const projectionCompiler = clone(base);
    projectionCompiler.lariLearnedRecords = {
      schemaVersion: candidate.lariLearnedRecords.schemaVersion || 1,
      records: [canonicalTyped]
    };
    projectionCompiler.compiledSkills = [];
    runtime.compileSkills(projectionCompiler, { threshold: 0.5, limit: 1 });
    const learnedSkillProjection = projectionCompiler.compiledSkills
      .find(skill => skill.sourceLearnedRecordId === canonicalTyped.id);
    if (learnedSkillProjection) {
      candidate.compiledSkills = [
        learnedSkillProjection,
        ...candidate.compiledSkills.filter(skill => skill.id !== learnedSkillProjection.id)
      ];
    }
  }
  const projections = runtime.refreshLariKnowledgeProjections(candidate, { strict: true });
  candidate.lineage = {
    ...(candidate.lineage || {}),
    parentHash: activeHash,
    developmentalEvent: 'failure_driven_authoritative_research',
    candidateOnlyMigrations: legacyBindings,
    createdAt: new Date().toISOString()
  };

  const variants = [
    `Explain ${evidence.topic} in plain language.`,
    `What should I understand about ${evidence.topic}?`,
    `Why is ${evidence.topic} noteworthy?`
  ];
  const after = variants.map(prompt => ({ prompt, ...view(candidate, prompt, activeHash) }));
  const summaryTerms = String(learned.summary).toLowerCase().match(/[a-z]{5,}/g) || [];
  const transfer = after.map(item => ({
    ...item,
    passed: item.learnedRecordIds.includes(canonicalTyped.id)
      && item.source === 'verified_retained_knowledge'
      && summaryTerms.some(term => String(item.answer).toLowerCase().includes(term))
      && !/^I don[’']t have a reliable answer/.test(item.answer)
  }));
  const allowedTopLevelChanges = new Set(['lariLearnedRecords', 'selfTeaching', 'compiledSkills', 'lineage']);
  const changedTopLevelKeys = [...new Set([...Object.keys(base), ...Object.keys(candidate)])]
    .filter(key => JSON.stringify(base[key]) !== JSON.stringify(candidate[key]));
  const baseSelfTeachingMetadata = { ...(base.selfTeaching || {}) };
  const candidateSelfTeachingMetadata = { ...(candidate.selfTeaching || {}) };
  delete baseSelfTeachingMetadata.knowledgeBase;
  delete candidateSelfTeachingMetadata.knowledgeBase;
  const stateIntegrity = {
    changedTopLevelKeys,
    onlyCanonicalStateChanged: changedTopLevelKeys.every(key => allowedTopLevelChanges.has(key)),
    selfTeachingMetadataUnchanged: JSON.stringify(baseSelfTeachingMetadata) === JSON.stringify(candidateSelfTeachingMetadata),
    forbiddenTypedRecordStatePaths: forbiddenStatePaths(canonicalTyped)
  };
  stateIntegrity.passed = stateIntegrity.onlyCanonicalStateChanged
    && stateIntegrity.selfTeachingMetadataUnchanged
    && stateIntegrity.forbiddenTypedRecordStatePaths.length === 0;

  const serialized = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const candidateHash = shaBuffer(serialized);
  const candidatePath = path.join(candidateDir, `${candidateHash}.json`);
  if (!fs.existsSync(candidatePath)) {
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(candidatePath, serialized, { flag: 'wx' });
  }
  const reloaded = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const reload = view(reloaded, variants[1], candidateHash);
  const integrity = {
    activeBefore: activeHash,
    activeAfter: shaFile(activePath),
    registryBefore: registryHash,
    registryAfter: shaFile(registry.registryPath)
  };
  const report = {
    schemaVersion: 1,
    benchmark: 'lari-failure-driven-research-learning',
    createdAt: new Date().toISOString(),
    query,
    before,
    evidence: {
      reusedPublicAnswerEvidence: evidence.reusedPublicAnswerEvidence,
      requestedRoles: evidence.requestedEvidenceRoles || [],
      resolvedRoles: evidence.resolvedEvidenceRoles || [],
      sources: evidence.sources.map(source => ({ title: source.title, url: source.url, type: source.sourceType }))
    },
    learned: {
      id: learned.id,
      typedRecordId: canonicalTyped.id,
      topic: learned.topic,
      confidence: learned.confidence,
      compiled: candidate.compiledSkills.some(skill => skill.sourceLearnedRecordId === canonicalTyped.id),
      deduplicatedExistingTypedRecord: Boolean(existingTyped)
    },
    projections,
    stateIntegrity,
    candidate: {
      path: path.relative(root, candidatePath).replace(/\\/g, '/'),
      sha256: candidateHash,
      parentHash: activeHash,
      promoted: false
    },
    transfer,
    reload: {
      ...reload,
      passed: reload.learnedRecordIds.includes(canonicalTyped.id)
        && reload.source === 'verified_retained_knowledge'
        && !/^I don[’']t have a reliable answer/.test(reload.answer)
    },
    integrity: {
      ...integrity,
      activeUnchanged: integrity.activeBefore === integrity.activeAfter,
      registryUnchanged: integrity.registryBefore === integrity.registryAfter
    }
  };
  report.passed = transfer.every(item => item.passed)
    && report.reload.passed
    && report.stateIntegrity.passed
    && report.integrity.activeUnchanged
    && report.integrity.registryUnchanged;
  atomicReport(reportPath, report);
  console.log(JSON.stringify({
    passed: report.passed,
    before: before.answer,
    candidate: report.candidate,
    learned: report.learned,
    reusedPublicAnswerEvidence: report.evidence.reusedPublicAnswerEvidence,
    transfer: transfer.map(item => ({ prompt: item.prompt, passed: item.passed, source: item.source })),
    reload: report.reload.passed,
    integrity: report.integrity
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = { main, readSuppliedEvidence, resolveEvidence };
