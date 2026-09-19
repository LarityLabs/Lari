'use strict';

// RECAP is a small, allowlisted executor. Its linguistic decisions live in active canonical typed
// generator records; this file only parses supported constructions, fills their AST templates, and
// rejects outputs that cannot be traced to an input slot, retained knowledge, or a generator record.
const FAMILIES = {
  causal_explanation: [
    'recap.meaning.causal_evidence_action', 'recap.discourse.answer_support_action',
    'recap.clause.causal', 'recap.clause.evidence', 'recap.clause.next_action',
    'recap.repair.claim_coverage'
  ],
  practical_planning: [
    'recap.meaning.practical_plan', 'recap.discourse.plan_overview_steps',
    'recap.clause.plan_opening', 'recap.clause.plan_steps', 'recap.repair.plan_grounding'
  ],
  balanced_comparison: [
    'recap.meaning.balanced_comparison', 'recap.discourse.comparison_tradeoff_experiment',
    'recap.clause.comparison_frame', 'recap.clause.comparison_tradeoff',
    'recap.clause.comparison_experiment', 'recap.repair.comparison_grounding'
  ],
  requirements_clarification: [
    'recap.meaning.requirements_clarification', 'recap.discourse.acknowledge_then_question',
    'recap.clause.clarification_acknowledgement', 'recap.clause.clarification_questions',
    'recap.repair.clarification_grounding'
  ],
  correction_repair: [
    'recap.meaning.correction_repair', 'recap.discourse.correction_then_commitment',
    'recap.clause.correction_acknowledgement', 'recap.clause.correction_commitment',
    'recap.repair.correction_grounding'
  ],
  structured_thinking: [
    'recap.meaning.context_goal_constraint', 'recap.discourse.context_goal_constraint_action',
    'recap.clause.thinking_context', 'recap.clause.thinking_tension',
    'recap.clause.thinking_action', 'recap.repair.thinking_grounding'
  ],
  retained_knowledge_explanation: [
    'recap.meaning.retained_knowledge', 'recap.discourse.knowledge_answer_boundary',
    'recap.clause.knowledge_summary', 'recap.clause.knowledge_boundary',
    'recap.repair.knowledge_grounding'
  ]
};
const REQUIRED = FAMILIES.causal_explanation;
const ALL_OPERATIONS = [...new Set(Object.values(FAMILIES).flat())];
const STOP = new Set(['a', 'an', 'and', 'are', 'about', 'can', 'could', 'do', 'does', 'for', 'how', 'i', 'is', 'it', 'me', 'of', 'or', 'please', 'should', 'the', 'this', 'to', 'what', 'why', 'you']);

function records(model, family = null) {
  const dynamic = (model?.lariLearnedRecords?.records || []).filter(record => record?.type === 'generator'
    && record?.status === 'active' && record?.payload?.domain === 'executable_language'
    && record?.payload?.generatorProgram?.kind === 'recap.dynamic_generator_program');
  if (family && !FAMILIES[family]) return dynamic.filter(record => record.payload.generatorProgram.family === family);
  const allowed = new Set(family ? (FAMILIES[family] || []) : ALL_OPERATIONS);
  return (model?.lariLearnedRecords?.records || []).filter(record => record?.type === 'generator'
    && record?.status === 'active' && record?.payload?.domain === 'executable_language'
    && allowed.has(record?.payload?.operation)).concat(family ? [] : dynamic);
}

function compositionRecords(model) {
  return (model?.lariLearnedRecords?.records || []).filter(record => record?.type === 'generator'
    && record?.status === 'active'
    && record?.payload?.domain === 'executable_language'
    && record?.payload?.generatorProgram?.kind === 'recap.recursive_composition_program');
}

function requiredOperations(model, family) {
  if (FAMILIES[family]) return FAMILIES[family];
  return records(model, family).map(record => record.payload.operation);
}

function normalizeFragment(value = '') {
  return String(value).trim().replace(/^[\s:,-]+|[\s.?!]+$/g, '').replace(/\s+/g, ' ');
}

function capitalize(value = '') {
  const text = normalizeFragment(value);
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

function tokens(value = '') {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9_.-]+/g) || [])]
    .filter(token => token.length > 1 && !STOP.has(token))
    .map(token => {
      if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
      if (token.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(token)) return token.slice(0, -2);
      if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
      return token;
    });
}

function causalParse(text) {
  const head = /^\s*(?:please\s+)?explain\s+why\s+(.+?)\s*:\s*(.+?)[.!]\s+([\s\S]+)$/i.exec(text);
  if (!head) return null;
  const tail = /^\s*(?:the\s+)?(?:evidence|logs?)\s+(?:(?:is|are)\s*[:,-]?\s*|(?:shows?|indicates?)\s*[:,-]?\s*)(.+?)[.!]\s*(?:next(?:\s+action)?|suggest|recommend)\s*[:,-]?\s*(.+?)[.!]?\s*$/i.exec(head[3]);
  if (!tail) return null;
  return { family: 'causal_explanation', communicativeGoal: 'causal_explanation', claims: {
    effect: normalizeFragment(head[1]), cause: normalizeFragment(head[2]),
    evidence: normalizeFragment(tail[1]), nextAction: normalizeFragment(tail[2])
  }, relations: [{ type: 'cause', from: 'cause', to: 'effect' }, { type: 'supports', from: 'evidence', to: 'cause' }], confidence: { causalLink: /\b(?:may|might|possibly|uncertain)\b/i.test(head[2]) ? 0.62 : 0.9 } };
}

function planningParse(text) {
  const match = /^\s*(?:(?:please\s+)?help me\s+)?(?:make a plan (?:for|to)|plan (?:for|how to|to))\s+(.+?)[.?!]?\s*$/i.exec(text);
  return match ? { family: 'practical_planning', communicativeGoal: 'practical_plan', claims: { goal: normalizeFragment(match[1]) }, relations: [] } : null;
}

function comparisonParse(text) {
  const match = /^\s*(?:help me (?:compare|decide between)|compare)\s+(.+?)\s+(?:versus|vs\.?|and)\s+(.+?)[.?!]?\s*$/i.exec(text)
    || /^\s*should i\s+(.+?)\s+or\s+(.+?)[?!.]?\s*$/i.exec(text);
  return match ? { family: 'balanced_comparison', communicativeGoal: 'balanced_comparison', claims: { optionA: normalizeFragment(match[1]), optionB: normalizeFragment(match[2]) }, relations: [{ type: 'contrasts', from: 'optionA', to: 'optionB' }] } : null;
}

function clarificationParse(text) {
  const match = /^\s*(?:what do you need to know|what should you ask me|ask me what you need to know)\s+(?:before|to)\s+(?:you\s+)?(?:build|create|make|help me with)\s+(.+?)[?!.]?\s*$/i.exec(text);
  return match ? { family: 'requirements_clarification', communicativeGoal: 'requirements_clarification', claims: { goal: normalizeFragment(match[1]) }, relations: [] } : null;
}

function correctionParse(text) {
  const match = /^\s*(?:no[,—-]?\s*)?(?:i (?:said|meant)|what i mean is)\s+(.+?)[,;]\s*(?:not|instead of)\s+(.+?)[.?!]?\s*$/i.exec(text);
  return match ? { family: 'correction_repair', communicativeGoal: 'correction_repair', claims: { intended: normalizeFragment(match[1]), rejected: normalizeFragment(match[2]) }, relations: [{ type: 'replaces', from: 'intended', to: 'rejected' }] } : null;
}

function structuredThinkingParse(text) {
  const match = /^\s*(?:help me think through|think through)\s+(.+?)[.!]\s*context\s*:\s*(.+?)[.!]\s*goal\s*:\s*(.+?)[.!]\s*constraint\s*:\s*(.+?)[.!]?\s*$/i.exec(text);
  return match ? { family: 'structured_thinking', communicativeGoal: 'structured_thinking', claims: { topic: normalizeFragment(match[1]), context: normalizeFragment(match[2]), goal: normalizeFragment(match[3]), constraint: normalizeFragment(match[4]) }, relations: [{ type: 'constrains', from: 'constraint', to: 'goal' }] } : null;
}

function findRetainedKnowledge(model, topic) {
  const query = tokens(topic);
  if (!query.length) return null;
  return (model?.lariLearnedRecords?.records || []).filter(record => record?.type === 'knowledge'
      && record?.status === 'active'
      && record?.payload?.summary
      && !(record?.provenance?.benchmarkAssociation || []).length)
    .map(record => {
      const candidateTokens = new Set([...(record.normalizedTriggers || []).flatMap(tokens), ...tokens(record.payload.topic || ''), ...tokens(record.payload.subject || ''), ...tokens(record.payload.summary || '')]);
      const matches = query.filter(token => candidateTokens.has(token));
      return { record, matches, score: matches.length / query.length };
    }).filter(item => item.matches.length >= Math.min(2, query.length) && item.score >= 0.5
      // Subject agreement: a record about "West Germany" must not answer a
      // question about "Germany". Token overlap is one-directional; require
      // the record's subject to agree with the question's subject as a whole.
      // Same rule as knowledgeSubjectAgrees in swarm_model_runtime.js -- keep
      // the two implementations in sync.
      && retainedSubjectAgrees(item.record, topic))
    .sort((a, b) => b.score - a.score || Number(b.record.confidence || 0) - Number(a.record.confidence || 0) || a.record.id.localeCompare(b.record.id))[0] || null;
}

// Subject agreement for retained factual knowledge. Mirrors
// knowledgeSubjectAgrees in swarm_model_runtime.js: the attribute/focus term
// ("capital") is removed from both sides, then subjects must agree -- exactly
// when both sides name the same attribute, by containment otherwise. Empty
// signatures pass through.
function retainedAttributeHead(text) {
  const match = String(text || '').toLowerCase().match(/\b([a-z]{4,})\s+of\b/);
  return match ? match[1] : null;
}

function retainedSubjectSignature(text, attributeHead) {
  return tokens(text).filter(token => token.length > 3 && token !== attributeHead).sort().join(' ');
}

function retainedSubjectAgrees(record, topic) {
  const recordTopic = record?.payload?.topic || record?.payload?.subject || '';
  const recordAttr = retainedAttributeHead(recordTopic);
  const topicAttr = retainedAttributeHead(topic);
  const recordSig = retainedSubjectSignature(recordTopic, recordAttr);
  const topicSig = retainedSubjectSignature(topic, topicAttr);
  if (!recordSig || !topicSig) return true;
  if (recordAttr && topicAttr && recordAttr === topicAttr) return recordSig === topicSig;
  const recordTerms = recordSig.split(' ');
  const topicTerms = new Set(topicSig.split(' '));
  return recordTerms.every(term => topicTerms.has(term));
}

function knowledgeParse(model, text) {
  const match = /^\s*(?:please\s+)?(?:explain|what (?:is|do you know about)|tell me about)\s+(.+?)[?!.]?\s*$/i.exec(text);
  if (!match) return null;
  const topic = normalizeFragment(match[1]);
  const topicTokens = tokens(topic);
  // Identity is resolved by Lari's self-knowledge path. A generic retained fact
  // about the word "you", or a benchmark repair mentioning Lari, must not shadow it.
  if (topicTokens.includes('lari') || topicTokens.some(token => ['you', 'yourself', 'identity'].includes(token))) return null;
  const knowledge = findRetainedKnowledge(model, topic);
  if (!knowledge) return null;
  return { family: 'retained_knowledge_explanation', communicativeGoal: 'retained_knowledge_explanation', claims: {
    topic, summary: normalizeFragment(knowledge.record.payload.summary),
    boundary: normalizeFragment(knowledge.record.payload.meaning || 'this is retained evidence, not a universal claim')
  }, relations: [{ type: 'supports', from: knowledge.record.id, to: 'summary' }], retainedKnowledgeRecordId: knowledge.record.id, confidence: { knowledge: Number(knowledge.record.confidence || 0) } };
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function normalizedLabel(value) { return normalizeFragment(value).toLowerCase().replace(/\s+/g, ' '); }

// Generic support for a learned labelled semantic frame.  The labels themselves
// are data inside a retained generator program; this parser does not know
// about any particular task family or response.  It permits an induced
// program to accept reordered, punctuation-varied inputs while still requiring
// every typed claim before realization can proceed.
function parseLabelledClaimFrame(text, frame = {}) {
  if (frame?.kind !== 'lari.labelled_claim_frame' || !Array.isArray(frame.slots)) return null;
  const aliases = Object.entries(frame.labelAliases || {})
    .flatMap(([slot, values]) => (values || []).map(value => ({ slot, label: normalizedLabel(value) })))
    .filter(item => item.label);
  if (!aliases.length || aliases.some(item => !frame.slots.includes(item.slot))) return null;
  const labelOwners = new Map();
  for (const item of aliases) {
    if (labelOwners.has(item.label) && labelOwners.get(item.label) !== item.slot) return null;
    labelOwners.set(item.label, item.slot);
  }
  const labels = [...labelOwners.keys()].sort((left, right) => right.length - left.length);
  const pattern = new RegExp(`(?:^|[.;\\n]\\s*)(${labels.map(escapeRegex).join('|')})\\s*:\\s*`, 'gi');
  const markers = [];
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    markers.push({ index: match.index, end: pattern.lastIndex, label: normalizedLabel(match[1]) });
  }
  if (!markers.length) return null;
  const claims = {};
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const slot = labelOwners.get(marker.label);
    if (!slot || claims[slot]) return null;
    const end = markers[index + 1]?.index ?? String(text || '').length;
    const value = normalizeFragment(String(text || '').slice(marker.end, end));
    if (!value) return null;
    claims[slot] = value;
  }
  return frame.slots.every(slot => claims[slot]) ? claims : null;
}

function dynamicParseCandidates(model, text) {
  const candidates = records(model).filter(record => record?.payload?.generatorProgram?.kind === 'recap.dynamic_generator_program');
  const matches = [];
  for (const record of candidates) {
    const program = record.payload.generatorProgram;
    let claims = parseLabelledClaimFrame(text, program.frameParser);
    if (!claims) {
      const matchers = Array.isArray(program.matchers) && program.matchers.length
        ? program.matchers
        : [program.matcher];
      for (const matcher of matchers) {
        if (!matcher?.source || !Array.isArray(matcher.slots)) continue;
        let match = null;
        try { match = new RegExp(matcher.source, matcher.flags || 'i').exec(text); } catch { continue; }
        if (!match?.groups) continue;
        const candidateClaims = Object.fromEntries(matcher.slots.map(slot => [slot, normalizeFragment(match.groups[slot])]).filter(([, value]) => value));
        if (Object.keys(candidateClaims).length === matcher.slots.length) {
          claims = candidateClaims;
          break;
        }
      }
    }
    if (!claims || !program.requiredClaims?.every(slot => claims[slot])) continue;
    matches.push({
      family: program.family,
      communicativeGoal: program.family,
      claims,
      relations: program.relations || [],
      confidence: program.confidenceSlots || {},
      dynamicGeneratorRecordId: record.id,
      sourceRecordConfidence: Number(record.confidence || 0)
    });
  }
  return matches;
}

function atomicCandidates(model, text) {
  const candidates = [
    causalParse(text), structuredThinkingParse(text), clarificationParse(text), correctionParse(text),
    comparisonParse(text), planningParse(text), knowledgeParse(model, text), ...dynamicParseCandidates(model, text)
  ].filter(candidate => candidate && Object.values(candidate.claims || {}).every(Boolean));
  return candidates.map((candidate, index) => ({
    schemaVersion: 3,
    kind: 'recap.meaning_graph',
    candidateId: `meaning.${candidate.family}.${index}`,
    sourceText: text,
    ...candidate
  }));
}

function candidateScore(graph) {
  const claimCount = Object.keys(graph.claims || {}).length;
  const relationCount = (graph.relations || []).length;
  const confidence = Object.values(graph.confidence || {}).filter(Number.isFinite);
  const confidenceMean = confidence.length ? confidence.reduce((sum, value) => sum + value, 0) / confidence.length : 0.82;
  const provenance = graph.dynamicGeneratorRecordId ? Number(graph.sourceRecordConfidence || 0.8) : 0.9;
  const componentBonus = (graph.components || []).length * 0.03;
  return Number((confidenceMean * 0.38 + provenance * 0.34 + Math.min(1, claimCount / 4) * 0.18
    + Math.min(1, relationCount / 2) * 0.07 + componentBonus).toFixed(6));
}

function compositionSegments(text) {
  return String(text || '')
    .replace(/([.?!])\s+(?:and\s+)?then\s+/gi, '$1; then ')
    .split(/\s*(?:;\s*(?:and\s+)?then\s+|;\s+|\s+and\s+then\s+)\s*/i)
    .map(segment => segment.trim().replace(/^then\s+/i, ''))
    .filter(Boolean);
}

function parseCandidates(message = '', model = null, options = {}) {
  const text = String(message || '').trim();
  if (!text) return [];
  const depth = Number(options.depth || 0);
  const candidates = atomicCandidates(model, text);
  if (depth < 3) {
    const segments = compositionSegments(text);
    for (const record of compositionRecords(model)) {
      const program = record.payload.generatorProgram;
      if (segments.length < Number(program.minComponents || 2) || segments.length > Number(program.maxComponents || 4)) continue;
      const componentFields = segments.map(segment => parseCandidates(segment, model, { depth: depth + 1 }));
      if (componentFields.some(field => !field.length)) continue;
      const components = componentFields.map(field => field[0]);
      const families = components.map(component => component.family);
      const allowed = new Set(program.allowedFamilies || []);
      if (allowed.size && families.some(family => !allowed.has(family))) continue;
      const minimumDistinct = Number(program.minimumDistinctFamilies || 2);
      if (new Set(families).size < minimumDistinct) continue;
      candidates.push({
        schemaVersion: 3,
        kind: 'recap.meaning_graph',
        candidateId: `meaning.recursive_composition.${record.id}`,
        family: 'recursive_composition',
        communicativeGoal: 'composed_discourse',
        sourceText: text,
        claims: Object.fromEntries(components.flatMap((component, componentIndex) => Object.entries(component.claims || {})
          .map(([slot, value]) => [`component${componentIndex + 1}.${slot}`, value]))),
        relations: components.slice(1).map((_component, index) => ({ type: 'precedes', from: `component${index + 1}`, to: `component${index + 2}` })),
        components,
        compositionRecordId: record.id,
        sourceRecordConfidence: Number(record.confidence || 0),
        compositionProgram: program
      });
    }
  }
  return candidates.map(candidate => ({ ...candidate, selectionScore: candidateScore(candidate) }))
    .sort((a, b) => b.selectionScore - a.selectionScore || a.candidateId.localeCompare(b.candidateId));
}

function parse(message = '', model = null) {
  const candidates = parseCandidates(message, model);
  if (!candidates.length) return null;
  const selected = candidates[0];
  return {
    ...selected,
    candidateField: {
      candidateCount: candidates.length,
      ambiguityPreserved: candidates.length > 1,
      selectedCandidateId: selected.candidateId,
      alternatives: candidates.map(candidate => ({
        candidateId: candidate.candidateId,
        family: candidate.family,
        selectionScore: candidate.selectionScore,
        componentFamilies: (candidate.components || []).map(component => component.family)
      }))
    }
  };
}

function fill(pattern, values) {
  return String(pattern || '').replace(/\{([A-Za-z]+)\}/g, (_all, name) => Object.prototype.hasOwnProperty.call(values, name) ? values[name] : '');
}

function realizeGraph(model, graph) {
  if (graph.family === 'recursive_composition') {
    const record = compositionRecords(model).find(item => item.id === graph.compositionRecordId);
    const program = record?.payload?.generatorProgram;
    if (!record || !program || !Array.isArray(graph.components) || graph.components.length < 2) return null;
    const realized = graph.components.map(component => realizeGraph(model, component));
    if (realized.some(result => !result?.verification?.passed)) return null;
    const answer = realized.map(result => result.answer).join(program.joiner || '\n\n').trim();
    const learnedRecordIds = [...new Set([record.id, ...realized.flatMap(result => result.learnedRecordIds || [])])];
    const sentenceTrace = realized.flatMap((result, componentIndex) => (result.sentenceTrace || []).map(sentence => ({
      ...sentence,
      composition: { recordId: record.id, componentIndex, family: graph.components[componentIndex].family }
    })));
    const verification = {
      componentCoverage: realized.length === graph.components.length,
      componentFaithfulness: realized.every(result => result.verification.passed),
      orderPreserved: sentenceTrace.every((sentence, index) => index === 0
        || sentence.composition.componentIndex >= sentenceTrace[index - 1].composition.componentIndex),
      unsupportedClaimCount: realized.reduce((sum, result) => sum + Number(result.verification.unsupportedClaimCount || 0), 0),
      passed: true
    };
    verification.passed = verification.componentCoverage && verification.componentFaithfulness
      && verification.orderPreserved && verification.unsupportedClaimCount === 0;
    if (!verification.passed) return null;
    return {
      answer,
      meaningGraph: graph,
      discourseProgram: program,
      sentenceTrace,
      verification,
      learnedRecordIds,
      family: graph.family,
      componentFamilies: graph.components.map(component => component.family),
      publicAnswerSource: 'recap_executable_language',
      external_model_calls: 0
    };
  }
  if (graph.dynamicGeneratorRecordId) {
    const record = records(model, graph.family).find(item => item.id === graph.dynamicGeneratorRecordId);
    const program = record?.payload?.generatorProgram;
    if (!program || !program.requiredClaims?.every(slot => graph.claims[slot])) return null;
    const answer = fill(program.responsePattern, graph.claims).replace(/\s+/g, ' ').trim();
    const normalizedAnswer = normalizeFragment(answer).toLowerCase();
    const droppedClaims = program.requiredClaims.filter(slot => !normalizedAnswer.includes(normalizeFragment(graph.claims[slot]).toLowerCase()));
    // Relations are executable semantic structure, not decorative metadata. A
    // learned generator may use any relation vocabulary, but each edge must be
    // typed and both endpoints must resolve to the claims recovered by the
    // parser. This keeps candidate induction generic while preventing a
    // malformed relation graph from being accepted as faithful output.
    const malformedRelations = (graph.relations || []).filter(relation => !relation
      || typeof relation.type !== 'string'
      || !relation.type.trim()
      || typeof relation.from !== 'string'
      || typeof relation.to !== 'string'
      || !graph.claims[relation.from]
      || !graph.claims[relation.to]);
    const unresolvedPlaceholders = answer.match(/\{[A-Za-z]+\}/g) || [];
    const contradictionCount = (graph.relations || []).filter(relation => relation.type === 'contradicts'
      && normalizeFragment(graph.claims[relation.from]).toLowerCase() === normalizeFragment(graph.claims[relation.to]).toLowerCase()).length;
    const verification = {
      claimCoverage: droppedClaims.length === 0,
      sentenceGrounding: unresolvedPlaceholders.length === 0,
      relationFaithfulness: malformedRelations.length === 0,
      confidencePreserved: true,
      droppedClaims,
      malformedRelations,
      unsupportedClaimCount: unresolvedPlaceholders.length,
      contradictionCount,
      passed: droppedClaims.length === 0 && malformedRelations.length === 0 && unresolvedPlaceholders.length === 0 && contradictionCount === 0
    };
    if (!verification.passed) return null;
    return {
      answer,
      meaningGraph: graph,
      discourseProgram: program,
      sentenceTrace: [{ text: answer, origin: record.id, operation: record.payload.operation, grounding: { inputSlots: program.requiredClaims, recordLiteral: true } }],
      verification,
      learnedRecordIds: [record.id],
      family: graph.family,
      publicAnswerSource: 'recap_executable_language',
      external_model_calls: 0
    };
  }
  const required = FAMILIES[graph.family] || [];
  const available = records(model, graph.family);
  const byOperation = Object.fromEntries(available.map(record => [record.payload.operation, record]));
  if (!required.length || !required.every(operation => byOperation[operation])) return null;
  const familyRecords = required.map(operation => byOperation[operation]);
  const discourse = familyRecords.find(record => record.payload.generatorAst?.kind === 'ordered_clauses');
  const repair = familyRecords.find(record => /grounding|claim_coverage/.test(record.payload.generatorAst?.kind || ''));
  if (!discourse || !repair || !Array.isArray(discourse.payload.generatorAst.sequence)) return null;
  const values = Object.fromEntries(Object.entries(graph.claims).map(([key, value]) => [key, ['goal', 'topic', 'effect', 'optionA'].includes(key) ? capitalize(value) : normalizeFragment(value)]));
  const sentences = discourse.payload.generatorAst.sequence.map(operation => {
    const record = byOperation[operation];
    if (!record || record.payload.generatorAst?.kind !== 'template') return null;
    return { text: fill(record.payload.generatorAst.pattern, values).replace(/\s+/g, ' ').trim(), origin: record.id, operation, grounding: { inputSlots: record.payload.generatorAst.inputSlots || [], recordLiteral: true } };
  });
  if (sentences.some(sentence => !sentence?.text || /\{[A-Za-z]+\}/.test(sentence.text))) return null;
  const answer = sentences.map(item => item.text).join(' ');
  const normalizedAnswer = normalizeFragment(answer).toLowerCase();
  const requiredClaims = (repair.payload.generatorAst.requiredClaims || Object.keys(graph.claims)).map(String);
  const covered = requiredClaims.every(key => graph.claims[key] && normalizedAnswer.includes(normalizeFragment(graph.claims[key]).toLowerCase()));
  const allowedSlots = new Set(Object.keys(graph.claims));
  const grounded = sentences.every(sentence => sentence.grounding.inputSlots.every(slot => allowedSlots.has(slot)));
  if (!covered || !grounded) return null;
  return {
    answer, meaningGraph: graph, discourseProgram: discourse.payload.generatorAst, sentenceTrace: sentences,
    verification: { claimCoverage: covered, sentenceGrounding: grounded, unsupportedClaimCount: 0, passed: true },
    learnedRecordIds: [...familyRecords.map(record => record.id), graph.retainedKnowledgeRecordId].filter(Boolean),
    family: graph.family, publicAnswerSource: 'recap_executable_language', external_model_calls: 0
  };
}

function realize(model, message = '') {
  const graph = parse(message, model);
  if (!graph) return null;
  const result = realizeGraph(model, graph);
  if (!result) return null;
  return { ...result, candidateField: graph.candidateField };
}

module.exports = {
  REQUIRED, FAMILIES, ALL_OPERATIONS, records, compositionRecords, requiredOperations,
  compositionSegments, parseCandidates, candidateScore, parse, realizeGraph, realize
};
