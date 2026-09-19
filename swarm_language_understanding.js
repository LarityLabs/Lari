'use strict';

// Bounded, auditable language analysis for Lari.  This module produces temporary inference objects;
// durable intelligence remains in canonical typed learned records.  Computational English supplies
// lexical evidence, while this layer supplies only explicitly supported structural relations.
const ce = require('computational-english');
const domainNeurogenesis = require('./swarm_domain_neurogenesis.js');
const nativeLanguageGenerator = require('./swarm_native_language_generator.js');

const ACTIONS = new Set(['inspect', 'explain', 'describe', 'outline', 'tell', 'read', 'review', 'edit', 'modify', 'change', 'update', 'patch', 'fix', 'run', 'rerun', 'test', 'restore', 'summarize', 'create', 'write', 'delete', 'touch']);
const MUTATIONS = new Set(['edit', 'modify', 'change', 'update', 'patch', 'fix', 'restore', 'create', 'write', 'delete', 'touch']);
const INSPECTIONS = new Set(['inspect', 'explain', 'describe', 'outline', 'tell', 'read', 'review', 'summarize']);
const PATH_PATTERN = /\b(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:js|mjs|cjs|ts|tsx|py|go|rb|java|rs|cs|json|md|html|css|toml|ya?ml)\b/gi;

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function semanticOperatorRecords(context = {}) {
  return (context.learnedRecords || []).filter(record => record?.type === 'operator'
    && record?.status === 'active'
    && ['language.semantic_scope_operator', 'language.semantic_relation_operator', 'state_machine_primitive'].includes(record?.payload?.operation)
    && ['lari.semantic_scope_operator', 'lari.semantic_relation_operator', 'lari.referential_selection_operator', 'lari.state_machine_primitive'].includes(record?.payload?.operatorAst?.kind));
}

function normalizeClause(value) {
  return String(value || '').trim().replace(/^[,;\s]+|[,;.!?\s]+$/g, '');
}

// Execute learned binary discourse relations. The relation vocabulary and its
// surface markers live in typed model records; this parser is deliberately a
// generic interpreter for those records, not a list of benchmark prompts.
function learnedRelationSegments(text, ast = {}) {
  const source = String(text || '').trim();
  const rows = [];
  const clauses = [...new Map([source, ...source.split(/(?<=[.!?])\s+/)].map(value => [normalizeClause(value).toLowerCase(), normalizeClause(value)]).filter(([key]) => key)).values()];
  for (const marker of ast.markers || []) for (const clause of clauses) {
    if (new RegExp(`\\b(?:word|phrase|term|conjunction)\\s+["“']?${escapeRegex(marker)}["”']?\\b`, 'i').test(clause)) continue;
    const escaped = escapeRegex(marker);
    let match = null;
    if (ast.surfaceOrder === 'marker_left_then_right') {
      match = new RegExp(`^\\s*${escaped}\\s+(.+?)[,;]\\s*(.+?)[.!?]?\\s*$`, 'i').exec(clause);
    } else {
      match = new RegExp(`^\\s*(.+?)\\s+${escaped}\\s+(.+?)[.!?]?\\s*$`, 'i').exec(clause);
    }
    if (!match) continue;
    const left = normalizeClause(match[1]);
    const right = normalizeClause(match[2]);
    if (!left || !right) continue;
    const predicateLike = value => (String(value).toLowerCase().match(/[a-z][a-z'-]*/g) || []).some(token => {
      if (/^(?:am|is|are|was|were|be|been|being|can|could|will|would|shall|should|may|might|must|do|does|did|have|has|had)$/.test(token)) return true;
      const info = ce.word(token);
      return Number(info?.pos?.VERB || 0) >= 0.2 || (info?.posFromParadigm || []).includes('VERB') || Boolean(info?.formFeatures?.VerbForm);
    });
    if (!predicateLike(left) || !predicateLike(right)) continue;
    const roleNames = Array.isArray(ast.roles) && ast.roles.length === 2 ? ast.roles : ['left', 'right'];
    rows.push({ marker: String(marker).toLowerCase(), relationType: ast.relationType, roles: { [roleNames[0]]: left, [roleNames[1]]: right } });
  }
  return rows;
}

function buildInterpretationHypotheses(text, operatorRecords = []) {
  const hypotheses = [];
  for (const record of operatorRecords) {
    const ast = record?.payload?.operatorAst;
    if (ast?.kind !== 'lari.semantic_relation_operator') continue;
    for (const segment of learnedRelationSegments(text, ast)) {
      const markerSpecificity = Math.max(...(ast.markers || []).map(marker => String(marker).split(/\s+/).length), 1);
      hypotheses.push({
        hypothesisId: `semantic.${record.id}.${hypotheses.length}`,
        operatorRecordId: record.id,
        relationType: segment.relationType,
        marker: segment.marker,
        roles: segment.roles,
        confidence: Number((Number(record.confidence || 0.7) * 0.8 + Math.min(1, markerSpecificity / 3) * 0.2).toFixed(6)),
        evidence: { explicitMarker: segment.marker, completeRoleBinding: Object.values(segment.roles).every(Boolean) }
      });
    }
  }
  return hypotheses.sort((a, b) => b.confidence - a.confidence || a.operatorRecordId.localeCompare(b.operatorRecordId));
}

function verifySemanticFaithfulness(graph = {}, realization = '') {
  const output = String(realization || '').toLowerCase();
  const relations = graph.relations || graph.semanticRelations || [];
  const claims = relations.flatMap(relation => Object.values(relation.roles || {})).filter(Boolean);
  const droppedClaims = claims.filter(claim => !output.includes(String(claim).toLowerCase()));
  const malformedRelations = relations.filter(relation => !relation?.type || Object.keys(relation.roles || {}).length !== 2);
  const unsupportedClaimCount = output && claims.length
    ? output.split(/(?<=[.!?])\s+/).filter(sentence => !claims.some(claim => sentence.includes(String(claim).toLowerCase()))).length
    : 0;
  return {
    claimCoverage: droppedClaims.length === 0,
    relationFaithfulness: malformedRelations.length === 0,
    droppedClaims,
    malformedRelations,
    unsupportedClaimCount,
    passed: droppedClaims.length === 0 && malformedRelations.length === 0 && unsupportedClaimCount === 0
  };
}

function realizeSemanticRelationGraph(graph = {}) {
  // Learned discourse operators are trained into the generator state, so a
  // relation type Lari acquired from corrections renders with its learned
  // marker. Falls back to the default state when nothing was learned.
  const native = nativeLanguageGenerator.realize(graph, generatorStateWithLearnedOperators(graph.generatorState || null));
  if (native) return { ...native, verification: verifySemanticFaithfulness(graph, native.answer) };
  const relation = (graph.relations || graph.semanticRelations || [])[0];
  if (!relation || Object.keys(relation.roles || {}).length !== 2) return null;
  const values = Object.values(relation.roles);
  const marker = relation.marker || ({ purpose: 'so that', concessive: 'although', temporal_precedence: 'before' }[relation.type]);
  if (!marker) return null;
  const answer = relation.surfaceOrder === 'marker_left_then_right'
    ? `${marker[0].toUpperCase()}${marker.slice(1)} ${values[0]}, ${values[1]}.`
    : `${values[0]} ${marker} ${values[1]}.`;
  return { answer, verification: verifySemanticFaithfulness({ relations: [relation] }, answer) };
}

function nativeRealizationSucceeded(result) {
  return Boolean(result && result.trace && result.verification && result.verification.passed === true);
}

// Cause/effect claims the engine already split into cause-first sentences get
// rendered as one genuine causal discourse relation: "effect because cause."
// Returns null unless the rendering verifies -- the caller keeps its template.
function realizeCauseEffectClaim(claimText = '') {
  const sentences = String(claimText || '')
    .split(/(?<=[.!?])\s+/)
    .map(part => part.trim().replace(/^(?:cause and effect)\s*:\s*/i, '').replace(/[.!?]+$/g, ''))
    .filter(part => part.length > 12);
  if (sentences.length < 2) return null;
  const lowerFirst = value => value ? value[0].toLowerCase() + value.slice(1) : value;
  const graph = {
    relations: [{
      type: 'cause',
      roles: { effect: sentences.slice(1).join(' '), cause: lowerFirst(sentences[0]) }
    }]
  };
  const result = realizeSemanticRelationGraph(graph);
  return nativeRealizationSucceeded(result) ? result : null;
}

// The fixed meaning behind the engine's canned identity/status answer.
// Rendered natively so the front door speaks through the generator;
// the canned string stays as the fallback.
function realizeIdentityClaim() {
  const graph = {
    relations: [
      { type: 'elaboration', roles: { who: 'I am Lari', where: 'I run locally' } },
      {
        type: 'elaboration',
        roles: {
          tracking: 'I track this session',
          policy: 'I use my learned policies when a task matches something I know'
        }
      }
    ]
  };
  const result = realizeSemanticRelationGraph(graph);
  return nativeRealizationSucceeded(result) ? result : null;
}

// ---------------------------------------------------------------------------
// Discourse-operator learning loop (experimental, 2026-09-19).
//
// Lari learns to talk the way it learns to repair: a failed rendering gets
// corrected, corrections accumulate per relation signature, two matching
// examples induce a typed operator record (via induceSemanticRelationOperator),
// the record is retained in a file-backed store, and the generator's marker
// preferences are re-trained from retained records. Zero parameters; the
// records are tiny and model-shaped so promotion later is trivial.
// ---------------------------------------------------------------------------
const DISCOURSE_STORE_FILENAME = 'learned_discourse_operators.json';

function discourseStorePath() {
  try {
    const path = require('path');
    return path.join(__dirname, DISCOURSE_STORE_FILENAME);
  } catch (_) { return null; }
}

function loadDiscourseStore() {
  const storePath = discourseStorePath();
  const empty = { schemaVersion: 1, entries: [], pending: {} };
  if (!storePath) return empty;
  try {
    const fs = require('fs');
    if (!fs.existsSync(storePath)) return empty;
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    // Backward compatible with the first experiment format (bare array).
    if (Array.isArray(parsed)) return { ...empty, entries: parsed };
    return {
      schemaVersion: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {}
    };
  } catch (_) { return empty; }
}

function saveDiscourseStore(store) {
  const storePath = discourseStorePath();
  if (!storePath) return false;
  try {
    const fs = require('fs');
    const temporary = `${storePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { flag: 'w' });
    fs.renameSync(temporary, storePath);
    return true;
  } catch (_) { return false; }
}

function loadDiscourseOperatorEntries() {
  return loadDiscourseStore().entries;
}

function saveDiscourseOperatorEntries(entries) {
  const store = loadDiscourseStore();
  store.entries = entries;
  return saveDiscourseStore(store);
}

// Pending corrections live in the file-backed store (not just memory) so two
// corrections given in separate processes still meet and induce.
function discourseCorrectionSignature(example) {
  const roles = Array.isArray(example.roles) ? example.roles : [];
  return [
    String(example.relationType || '').toLowerCase(),
    roles.map(role => String(role).toLowerCase()).join('|'),
    String(example.surfaceOrder || 'left_marker_right').toLowerCase()
  ].join('::');
}

function validDiscourseCorrection(example = {}) {
  if (!example.relationType || !example.marker) return false;
  if (!Array.isArray(example.roles) || example.roles.length !== 2) return false;
  if (!example.text || String(example.text).trim().length < 8) return false;
  return true;
}

function recordDiscourseCorrection(example = {}, options = {}) {
  if (!validDiscourseCorrection(example)) {
    return { induced: false, record: null, pending: 0, reason: 'invalid_correction_example' };
  }
  const signature = discourseCorrectionSignature(example);
  const store = loadDiscourseStore();
  const pending = store.pending[signature] || [];
  pending.push({
    text: String(example.text),
    relationType: String(example.relationType).toLowerCase(),
    marker: String(example.marker).toLowerCase(),
    roles: [String(example.roles[0]), String(example.roles[1])],
    surfaceOrder: String(example.surfaceOrder || 'left_marker_right')
  });
  if (pending.length < 2) {
    store.pending[signature] = pending;
    saveDiscourseStore(store);
    return { induced: false, record: null, pending: pending.length, reason: 'need_one_more_matching_example' };
  }
  const induced = induceSemanticRelationOperator(pending.slice(0, 2), options);
  delete store.pending[signature];
  if (!induced || induced.learned !== true) {
    saveDiscourseStore(store);
    return { induced: false, record: null, pending: 0, reason: induced?.reason || 'induction_failed' };
  }
  const markerCounts = {};
  for (const item of pending.slice(0, 2)) {
    markerCounts[item.marker] = (markerCounts[item.marker] || 0) + 1;
  }
  const entries = store.entries;
  const existing = entries.find(entry => entry?.record?.id === induced.record.id);
  const entry = existing || { record: induced.record, markerCounts: {}, exampleCount: 0, inducedAt: new Date().toISOString() };
  for (const [marker, count] of Object.entries(markerCounts)) {
    entry.markerCounts[marker] = (entry.markerCounts[marker] || 0) + count;
  }
  entry.exampleCount += pending.slice(0, 2).length;
  if (!existing) entries.push(entry);
  saveDiscourseStore(store);
  return { induced: true, record: induced.record, pending: 0, entry };
}

// Expand retained entries back into weighted training examples for the generator.
function discourseTrainingExamples(entries = loadDiscourseOperatorEntries()) {
  const examples = [];
  for (const entry of entries) {
    const ast = entry?.record?.payload?.operatorAst || {};
    if (!ast.relationType || !Array.isArray(ast.roles) || ast.roles.length !== 2) continue;
    for (const [marker, count] of Object.entries(entry.markerCounts || {})) {
      for (let i = 0; i < Number(count) || 0; i++) {
        examples.push({ relationType: ast.relationType, marker, roles: ast.roles });
      }
    }
  }
  return examples;
}

// Generator state with Lari's learned discourse preferences trained in.
// Learned markers outrank seed markers by observed weight, so a correction
// the user actually gave beats the default.
function generatorStateWithLearnedOperators(baseState) {
  const seed = baseState || nativeLanguageGenerator.defaultState();
  try {
    const examples = discourseTrainingExamples();
    if (!examples.length) return seed;
    return nativeLanguageGenerator.trainState(examples, seed);
  } catch (_) { return seed; }
}

// Render through the generator with learned discourse operators active.
// Same refusal contract as realizeSemanticRelationGraph.
function realizeWithDiscourseLearning(graph = {}) {
  const state = generatorStateWithLearnedOperators(graph.generatorState || null);
  return realizeSemanticRelationGraph({ ...graph, generatorState: state });
}

const CORRECTION_MARKER_TYPES = {
  but: 'contrast', yet: 'contrast', while: 'contrast', whereas: 'contrast',
  although: 'concessive', though: 'concessive',
  because: 'cause', 'so that': 'purpose', unless: 'condition'
};
const CORRECTION_STOPWORDS = new Set(('a,an,the,and,or,but,of,to,in,on,for,with,that,this,these,those,is,are,was,were,be,been,it,its,as,at,by,from,have,has,had,will,would,should,could,not,no,yes,i,you,we,they,he,she,do,does,did,so,if,then,than,too,very,just').split(','));

function contentTokens(value) {
  return (String(value || '').toLowerCase().match(/[a-z][a-z'-]*/g) || [])
    .filter(token => token.length > 3 && !CORRECTION_STOPWORDS.has(token));
}

// Heuristic: the user's reply re-says Lari's answer but joins the clauses
// with a discourse marker. Returns a correction *candidate* -- the caller
// confirms before recording. Never treated as ground truth on its own.
function detectCorrectionCandidate(lariAnswer, userReply) {
  const reply = String(userReply || '');
  const markers = Object.keys(CORRECTION_MARKER_TYPES).sort((a, b) => b.length - a.length);
  const hit = markers.find(marker => new RegExp(`^\\s*(.+?)\\s+${marker.replace(/ /g, '\\s+')}\\s+(.+?)[.!?]?\\s*$`, 'i').exec(reply));
  if (!hit) return null;
  const parts = new RegExp(`^\\s*(.+?)\\s+${hit.replace(/ /g, '\\s+')}\\s+(.+?)[.!?]?\\s*$`, 'i').exec(reply);
  const left = (parts?.[1] || '').trim();
  const right = (parts?.[2] || '').trim();
  if (left.length < 4 || right.length < 4) return null;
  const answerTokens = new Set(contentTokens(lariAnswer));
  const shared = contentTokens(`${left} ${right}`).filter(token => answerTokens.has(token));
  if (new Set(shared).size < 2) return null;
  return {
    relationType: CORRECTION_MARKER_TYPES[hit],
    marker: hit,
    roles: ['left', 'right'],
    text: reply.trim(),
    sharedContentTokens: [...new Set(shared)],
    candidate: true
  };
}

function induceSemanticRelationOperator(examples = [], options = {}) {  const valid = examples.filter(example => example?.text && example?.relationType && example?.marker && Array.isArray(example?.roles) && example.roles.length === 2);
  if (valid.length < 2) return { learned: false, reason: 'at_least_two_corrected_examples_required' };
  const relationTypes = unique(valid.map(example => example.relationType));
  const roleSignatures = unique(valid.map(example => example.roles.join('|')));
  const orders = unique(valid.map(example => example.surfaceOrder || 'left_marker_right'));
  if (relationTypes.length !== 1 || roleSignatures.length !== 1 || orders.length !== 1) return { learned: false, reason: 'examples_do_not_share_one_typed_relation' };
  const markers = unique(valid.map(example => String(example.marker).toLowerCase()));
  const relationType = relationTypes[0];
  const identity = require('crypto').createHash('sha256').update(JSON.stringify({ relationType, roles: valid[0].roles, markers, order: orders[0] })).digest('hex').slice(0, 20);
  return {
    learned: true,
    record: {
      id: options.id || `lari.learned.operator.language.semantic_relation.${identity}`,
      type: 'operator', status: 'active', confidence: Number(options.confidence || 0.9),
      normalizedTriggers: markers,
      payload: { operation: 'language.semantic_relation_operator', operatorAst: { kind: 'lari.semantic_relation_operator', relationType, roles: valid[0].roles, markers, surfaceOrder: orders[0] }, induction: { exampleCount: valid.length, source: 'corrected_semantic_failures' } },
      provenance: { creationSource: 'failure_induced_semantic_relation_neurogenesis', sourceModelHash: options.sourceModelHash || null, sourcePath: options.sourcePath || null, importedAt: new Date().toISOString(), benchmarkAssociation: [] }
    }
  };
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function scopedSegments(text, markers = []) {
  const source = String(text || '').trim();
  const normalizedMarkers = unique(markers.map(value => String(value).trim().toLowerCase())).sort((a, b) => b.length - a.length);
  if (!normalizedMarkers.length) return [];
  const allowed = new Set(normalizedMarkers);
  const matches = [];
  const markerPattern = new RegExp(`\\b(${normalizedMarkers.map(escapeRegex).join('|')})\\b`, 'gi');
  let match;
  while ((match = markerPattern.exec(source))) {
    const marker = match[1].toLowerCase();
    if (!allowed.has(marker)) continue;
    const before = source.slice(0, match.index);
    // A bare period may belong to a file path (for example, parser.js), so only explicit
    // clause separators are safe left-scope boundaries here.
    const boundary = Math.max(before.lastIndexOf(';'), before.lastIndexOf(', but'));
    const actionText = before.slice(boundary + 1).replace(/^\s*(?:but|and|then)\s+/i, '').trim().replace(/,$/, '');
    const tail = source.slice(match.index + match[0].length).trim();
    const end = tail.search(/(?:\s*,\s*but\b|\s*;|[.!?]\s*$)/i);
    const conditionText = (end >= 0 ? tail.slice(0, end) : tail).trim().replace(/[,.!?]+$/, '');
    if (!actionText || !conditionText) continue;
    matches.push({ marker, actionText, conditionText });
  }
  return matches;
}

function orderedEntityMentions(text) {
  const source = String(text || '');
  const matches = [];
  for (const match of source.matchAll(new RegExp(PATH_PATTERN.source, 'gi'))) matches.push({ index: match.index, text: match[0] });
  for (const match of source.matchAll(/["“]([^"”]{2,80})["”]/g)) matches.push({ index: match.index, text: match[1].trim() });
  matches.sort((a, b) => a.index - b.index);
  const seen = new Set();
  return matches.filter(item => {
    const key = item.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(item => item.text);
}

function referentialSegments(text, ast = {}) {
  const source = String(text || '');
  const markers = Object.keys(ast.selections || {}).sort((a, b) => b.length - a.length);
  if (!markers.length) return [];
  const pattern = new RegExp(`\\b(${markers.map(escapeRegex).join('|')})\\b`, 'gi');
  const rows = [];
  let match;
  while ((match = pattern.exec(source))) {
    const marker = match[1].toLowerCase();
    const candidates = orderedEntityMentions(source.slice(0, match.index));
    const selectedIndex = Number(ast.selections?.[marker]);
    if (candidates.length < Number(ast.minimumCandidates || 2) || !Number.isInteger(selectedIndex) || !candidates[selectedIndex]) continue;
    rows.push({ marker, candidates, selectedIndex, antecedentText: candidates[selectedIndex] });
  }
  return rows;
}

function applyLearnedSemanticOperators(text, syntax, semantics, context = {}) {
  const applied = [];
  const relations = [];
  let primaryActionText = null;
  const operatorRecords = semanticOperatorRecords(context);
  const textTransform = String(text || '').match(/\b(?:apply|transform|normalize|strip|remove|replace)\b[^\r\n]*?\b(?:text|string)\s*:\s*(?:`([\s\S]*?)`|([^\r\n]+))\s*$/i);
  const intentTokens = new Set((textTransform ? String(text).slice(0, String(text).lastIndexOf(':')) : String(text)).toLowerCase().match(/[a-z][a-z0-9_-]+/g) || []);
  const stateMachineRoutingStopwords = new Set(['finite-state', 'string', 'transduction', 'remove', 'strip', 'transform', 'normalize', 'apply', 'from', 'text', 'while', 'preserving', 'preserve', 'all', 'outside']);
  const intentDistinctTokens = [...intentTokens].filter(token => !stateMachineRoutingStopwords.has(token));
  const genericStateMachines = operatorRecords.filter(record => record.payload.operatorAst?.kind === 'lari.state_machine_primitive'
    && record.payload.operatorAst?.outputType === 'string');
  const selectedGenericStateMachine = genericStateMachines.map(record => {
    const score = (record.normalizedTriggers || []).filter(token => {
      const normalized = String(token).toLowerCase();
      return !stateMachineRoutingStopwords.has(normalized) && intentTokens.has(normalized);
    }).length;
    return { record, score, intentCoverage: intentDistinctTokens.length ? score / intentDistinctTokens.length : 0 };
  }).sort((left, right) => right.intentCoverage - left.intentCoverage || right.score - left.score || Number(right.record.confidence || 0) - Number(left.record.confidence || 0))[0];
  for (const record of operatorRecords) {
    const ast = record.payload.operatorAst;
    if (ast.kind === 'lari.semantic_relation_operator') {
      const segments = learnedRelationSegments(text, ast);
      for (const segment of segments) relations.push({
        type: segment.relationType, marker: segment.marker, roles: segment.roles,
        surfaceOrder: ast.surfaceOrder || 'left_marker_right', operatorRecordId: record.id
      });
      if (segments.length) applied.push(record.id);
      continue;
    }
    if (ast.kind === 'lari.state_machine_primitive') {
      const explicit = String(text || '').match(/\b(?:structured\s+)?fields?\s*:\s*`?([^\r\n`]+)`?\s*$/i);
      const genericSelected = ast.outputType === 'string'
        && selectedGenericStateMachine?.record?.id === record.id
        && selectedGenericStateMachine.score > 0
        && selectedGenericStateMachine.intentCoverage >= 0.5;
      const stateMachineInput = context.stateMachineInput !== undefined
        ? String(context.stateMachineInput)
        : ast.outputType === 'string' && genericSelected
          ? (textTransform?.[1] ?? textTransform?.[2])
          : ast.outputType === 'array'
            ? explicit?.[1]?.trim()
            : undefined;
      if (stateMachineInput !== undefined) {
        const execution = domainNeurogenesis.executeStateMachinePrimitive(ast, stateMachineInput);
        if (execution.passed) {
          relations.push(ast.outputType === 'string'
            ? {
              type: 'learned_text_transduction', sourceText: stateMachineInput,
              transformedText: execution.value, finalState: execution.finalState,
              operatorRecordId: record.id
            }
            : {
              type: 'structured_segments', sourceText: stateMachineInput,
              segmentTexts: execution.value, finalState: execution.finalState,
              operatorRecordId: record.id
            });
          applied.push(record.id);
        }
      }
      continue;
    }
    if (ast.kind === 'lari.referential_selection_operator') {
      const segments = referentialSegments(text, ast);
      for (const segment of segments) {
        relations.push({
          type: 'ordered_referent', marker: segment.marker,
          antecedentText: segment.antecedentText, candidateTexts: segment.candidates,
          selectedIndex: segment.selectedIndex, operatorRecordId: record.id
        });
      }
      if (segments.length) applied.push(record.id);
      continue;
    }
    const segments = scopedSegments(text, ast.markers || []);
    if (!segments.length) continue;
    for (const segment of segments) {
      const relationType = ast.relations?.[segment.marker] || null;
      if (!relationType) continue;
      relations.push({
        type: relationType,
        marker: segment.marker,
        actionText: segment.actionText,
        conditionText: segment.conditionText,
        actionTargets: extractPaths(segment.actionText),
        conditionTargets: extractPaths(segment.conditionText),
        operatorRecordId: record.id
      });
      primaryActionText ||= segment.actionText;
      if (!semantics.conditions.includes(segment.conditionText)) semantics.conditions.push(segment.conditionText);
    }
    applied.push(record.id);
  }
  semantics.semanticRelations = [...(semantics.semanticRelations || []), ...relations];
  semantics.scopeCoverage = relations.length ? {
    preserved: true,
    relationCount: relations.length,
    markers: unique(relations.map(item => item.marker)),
    operatorRecordIds: unique(applied)
  } : null;
  return { appliedRecordIds: unique(applied), relations, primaryActionText };
}

function lexicalEvidence(token) {
  const surface = String(token || '').toLowerCase();
  if (!/^[a-z][a-z'-]*$/.test(surface)) return null;
  const info = ce.word(surface);
  if (!info) return { surface, known: false };
  const pos = Object.entries(info.pos || {}).sort((a, b) => b[1] - a[1])[0]?.[0]
    || info.posFromParadigm?.[0] || null;
  return { surface, known: true, lemma: info.lemma, pos, number: info.formFeatures?.Number || null };
}

function splitClauses(text) {
  const paths = [];
  const protectedText = String(text || '').replace(PATH_PATTERN, match => {
    const index = paths.push(match) - 1;
    return `LARIPATH${index}TOKEN`;
  });
  return protectedText
    .replace(/\b(and\s+then|after\s+that|then)\b/gi, ' ; $1 ')
    .replace(/\bbut\b/gi, ' ; but ')
    .split(/\s*[.;]\s*/)
    .map(value => value.replace(/LARIPATH(\d+)TOKEN/g, (_, index) => paths[Number(index)]).trim())
    .filter(Boolean);
}

function extractPaths(text) { return unique(String(text || '').match(PATH_PATTERN) || []); }

function actionFromClause(clause) {
  const words = String(clause || '').toLowerCase().match(/[a-z][a-z'-]*/g) || [];
  const action = words.find(word => ACTIONS.has(word)) || null;
  return action === 'rerun' ? 'run' : action;
}

function priorEntities(turns = []) {
  const entities = [];
  for (const turn of turns.slice(0, 8)) {
    const message = String(turn?.message || turn?.prompt || '');
    for (const target of extractPaths(message)) entities.push({ target, sourceTurnId: turn.id || null });
  }
  return entities;
}

function parseSyntax(text) {
  const clauses = splitClauses(text);
  const nodes = [];
  const edges = [];
  let priorActionId = null;
  clauses.forEach((raw, index) => {
    const clause = raw.replace(/^(?:and\s+then|after\s+that|then|first|but)\s*,?\s*/i, '').trim();
    const conditional = clause.match(/^if\s+(.+?),\s*(.+)$/i);
    if (conditional) {
      const conditionId = `condition.${index}`;
      nodes.push({ id: conditionId, type: 'condition', text: conditional[1], polarity: 'positive', lexicalEvidence: conditional[1].match(/[A-Za-z][A-Za-z'-]*/g)?.map(lexicalEvidence).filter(Boolean) || [] });
      const action = actionFromClause(conditional[2]);
      const actionId = `action.${index}`;
      nodes.push({ id: actionId, type: 'action', action, text: conditional[2], targets: extractPaths(conditional[2]), polarity: /\b(?:do not|don't|never)\b/i.test(conditional[2]) ? 'negative' : 'positive', order: index });
      edges.push({ from: conditionId, to: actionId, type: 'condition_for' });
      if (priorActionId) edges.push({ from: priorActionId, to: actionId, type: 'precedes' });
      priorActionId = actionId;
      return;
    }
    const action = actionFromClause(clause);
    const id = `action.${index}`;
    nodes.push({ id, type: 'action', action, text: clause, targets: extractPaths(clause), polarity: /\b(?:do not|don't|never|without)\b/i.test(clause) ? 'negative' : 'positive', order: index });
    if (priorActionId) edges.push({ from: priorActionId, to: id, type: 'precedes' });
    priorActionId = id;
  });
  return { schemaVersion: 1, type: 'lari.syntax_graph', clauses, nodes, edges };
}

function interpretSemantics(text, syntax) {
  const lower = String(text || '').toLowerCase();
  const paths = extractPaths(text);
  const positiveActions = syntax.nodes.filter(node => node.type === 'action' && node.polarity === 'positive' && node.action);
  const orderedActions = positiveActions.map(node => node.action);
  const mutatingActions = positiveActions.filter(node => MUTATIONS.has(node.action));
  const preserveState = /\b(?:do not|don't|never)\s+(?:modify|change|edit|touch)\s+(?:anything|any files?|the repository|the repo)\b/i.test(text)
    || /\bwithout\s+(?:changing|modifying|editing)\s+(?:anything|any files?)\b/i.test(text)
    || /\bdo not edit the repository\b/i.test(text);
  const forbiddenTargets = unique([
    ...[...String(text).matchAll(/\b(?:do not|don't|never)\s+(?:touch|modify|edit|change|patch)\s+((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)\b/gi)].map(match => match[1]),
    ...[...String(text).matchAll(/\bleave\s+((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)\s+unchanged\b/gi)].map(match => match[1])
  ]);
  const mutationTargets = unique(mutatingActions.flatMap(node => node.targets));
  const contradictoryTargets = mutationTargets.filter(target => forbiddenTargets.some(forbidden => forbidden.toLowerCase() === target.toLowerCase()));
  const conditions = syntax.nodes.filter(node => node.type === 'condition').map(node => node.text);
  const rollbackRequired = positiveActions.some(node => node.action === 'restore')
    && conditions.some(condition => /\b(?:fail|fails|failed|failure)\b/i.test(condition));
  const verificationRequired = orderedActions.some(action => action === 'run' || action === 'test')
    || /\b(?:run|rerun)\s+(?:the\s+)?tests?|test suite|verify|verification\b/i.test(text);
  const codeDomain = paths.length > 0
    || /\b(?:code|repository|repo|test suite|build|api server|worker|function|class|module|package-lock|pytest|jest|test runner)\b/i.test(text)
    || /\b(?:failing test|failed test|test failure|stack trace|test output)\b/i.test(text)
    || /\b(?:run|rerun|fix|repair|debug)\s+(?:the\s+)?tests?\b/i.test(text);
  const codeProgressDisclosure = /\b(?:finally|already|just)\s+(?:fixed|solved|repaired)\s+it\b/i.test(text)
    && !/\?\s*$/.test(String(text));
  const informationalCodeRequest = codeDomain
    && (codeProgressDisclosure
      || /^\s*(?:please\s+)?(?:describe|explain|outline|summarize|separate|distinguish|state|tell me|what|how|why|walk me through|interpret|review|give me .*review|ask|show|use an analogy)\b/i.test(text))
    && paths.length === 0;
  const explanation = preserveState && (orderedActions.some(action => INSPECTIONS.has(action)) || /\b(?:explain|tell me|what does|why)\b/i.test(text));
  const subintentOverride = codeDomain && !informationalCodeRequest
    ? (explanation ? 'code.explain' : mutatingActions.length ? 'code.fix' : verificationRequired ? 'code.test' : 'code.explain')
    : null;
  return {
    schemaVersion: 1,
    type: 'lari.semantic_task',
    speechAct: /\?$/.test(String(text).trim()) ? 'question' : 'directive',
    domain: codeDomain ? 'code' : 'general',
    intentOverride: informationalCodeRequest ? 'chat' : codeDomain ? 'code' : null,
    subintentOverride,
    orderedActions,
    targets: paths,
    constraints: { preserveState, forbiddenTargets, contradictoryTargets },
    conditions,
    verificationRequired,
    rollbackRequired,
    mutationAllowed: !preserveState && contradictoryTargets.length === 0,
    routingTerms: unique([codeDomain ? 'code' : null, informationalCodeRequest ? 'explanation' : null, subintentOverride, ...orderedActions, verificationRequired ? 'verification' : null, rollbackRequired ? 'rollback' : null])
  };
}

function interpretDiscourseSemantics(text) {
  const source = String(text || '').trim();
  const lower = source.toLowerCase();
  const explicitAmbiguity = /\b(?:ambiguous|ambiguity|unclear|could mean|interpretation|two meanings|more than one meaning)\b/i.test(source);
  const uncertainty = /\b(?:unsure|uncertain|conflicted|not sure|do not know|don['’]?t know)\b/i.test(source);
  const term = source.match(/(?:word|term|phrase)\s+["“']?([A-Za-z][A-Za-z0-9_-]*)/i)?.[1]
    || source.match(/\bwhat\s+["“']?([A-Za-z][A-Za-z0-9_-]*)["”']?\s+means?\b/i)?.[1]
    || source.match(/\b(?:meaning of|mean by)\s+["“']?([A-Za-z][A-Za-z0-9_-]*)/i)?.[1]
    || null;
  const termEvidence = term ? lexicalEvidence(term) : null;
  const requestedClarification = /\b(?:clarify|which (?:meaning|interpretation)|what .* mean|help me understand)\b/i.test(source);
  const conversationalGoal = explicitAmbiguity ? 'clarify_meaning'
    : uncertainty && /\b(?:want|choose|direction|goal|next|decision)\b/i.test(lower) ? 'elicit_goal'
      : null;
  return {
    schemaVersion: 1,
    type: 'lari.discourse_semantics',
    speechAct: /\?s*$/.test(source) ? 'question' : /\b(?:help|clarify|explain|tell|show|give|write|make)\b/i.test(source) ? 'directive' : 'statement',
    conversationalGoal,
    ambiguity: { explicit: explicitAmbiguity, term, termEvidence, requestedClarification },
    uncertainty: { explicit: uncertainty },
    semanticFeatures: unique([explicitAmbiguity ? 'explicit_lexical_ambiguity' : null, requestedClarification ? 'clarification_requested' : null, uncertainty ? 'speaker_uncertainty' : null, conversationalGoal])
  };
}

function extractLearningSemantics(text) {
  const source = String(text || '').trim();
  if (/\b(?:i prefer|my (?:preferred|favorite)|remember (?:that )?i prefer|remember preference)\b/i.test(source)) {
    return { requested: false, category: 'preference', claimTreatment: 'durable_user_preference' };
  }
  // A sentence can discuss research or learning without requesting that Lari
  // perform either action. Keep metalinguistic explanations in chat; only an
  // imperative learning request should enter the evidence-acquisition lane.
  const describesLearning = /^\s*(?:describe|explain|outline|summarize|how|why|what)\b/i.test(source);
  if (describesLearning) return null;
  const procedural = source.match(/\b(?:learn|teach yourself)\s+how to\s+(.+?)(?=\s+before\s+|\s+so\s+(?:that\s+)?(?:you|lari)\s+can\s+|\s*;|\s*,?\s+and\s+(?:prove|verify|retain|remember|keep)\b|[.!?]\s*$|$)/i);
  const research = source.match(/\b(?:research|study|learn about)\s+(.+?)(?=\s+so\s+(?:that\s+)?(?:you|lari)\s+can\s+|\s*;|\s*,?\s+and\s+(?:retain|remember|keep|verify)\b|[.!?]\s*$|$)/i);
  const factual = source.match(/\blearn\s+(whether\s+.+?)(?=\s*;|\s*,?\s+and\s+(?:verify|retain|remember|keep)\b|[.!?]\s*$|$)/i);
  const match = procedural || research || factual;
  if (!match) return null;
  const target = match[1].trim().replace(/[,.]+$/g, '');
  const purposeMatch = source.match(/\bso\s+(?:that\s+)?(?:you|lari)\s+can\s+(.+?)(?=\s*,?\s+and\s+(?:retain|remember|keep|prove|verify)\b|[.;!?]|$)/i)
    || source.match(/\bbefore\s+(.+?)(?=\s*;|\s*,?\s+and\s+(?:retain|remember|keep|prove|verify|require)\b|[.!?]|$)/i);
  const purpose = purposeMatch ? purposeMatch[1].trim().replace(/[,.]+$/g, '') : null;
  const executionRequired = Boolean(procedural);
  const unseenTransfer = /\b(?:unseen|fresh|new)\s+(?:transfer\s+)?(?:test|case|task|repo|repository|workspace)\b/i.test(source);
  const reloadRetention = /\b(?:after|across|survive|through)\s+reload\b|\breload retention\b/i.test(source);
  const evidenceRequired = /\b(?:verified|verify|verification|evidence|source|sources|facts?)\b/i.test(source) || !executionRequired;
  return {
    schemaVersion: 1,
    type: 'lari.conversational_learning_task',
    requested: true,
    category: executionRequired ? 'procedure' : 'knowledge',
    mode: executionRequired ? 'practice' : 'research',
    target,
    purpose,
    researchQuery: target,
    durableRequested: /\b(?:retain|remember|keep|learn)\b/i.test(source),
    evidenceRequired,
    executionRequired,
    successCriteria: { unseenTransfer, reloadRetention, sourceVerification: evidenceRequired },
    claimTreatment: factual ? 'hypothesis_requires_evidence' : executionRequired ? 'candidate_procedure_requires_execution' : 'research_target_requires_evidence',
    promotionAllowed: false
  };
}

function applyPragmatics(text, semantics, context = {}) {
  const correction = String(text || '').match(/^\s*(?:no[,;]?\s*)?(?:i\s+meant|what\s+i\s+meant\s+was)\s+(.+)$/i);
  const previous = priorEntities(context.turns || []);
  const distinctPrevious = [...new Map(previous.map(item => [item.target.toLowerCase(), item])).values()];
  const currentPaths = semantics.targets;
  const retentionAnaphor = semantics.learning?.requested
    && /\b(?:retain(?:ing)?|remember(?:ing)?|keep(?:ing)?)\s+(?:only\s+)?it\b/i.test(text);
  const referentialComponentContext = semantics.domain === 'code'
    || /\b(?:inspect|modify|edit|delete|rename|file|component|module|worker|server)\b/i.test(text)
    || /\bmove\s+(?:the\s+|this\s+|that\s+)?(?:file|component|module)\b/i.test(text);
  const resolvedPastDisclosure = /\b(?:finally|already|just)\s+(?:fixed|solved|repaired)\s+it\b/i.test(text);
  const hasAnaphor = !retentionAnaphor
    && !resolvedPastDisclosure
    && referentialComponentContext
    && /\b(?:it|that file|this file|that one|this one)\b/i.test(text);
  const latestWasCorrection = /^\s*(?:no[,;]?\s*)?(?:i\s+meant|what\s+i\s+meant\s+was)\b/i.test(String(context.turns?.[0]?.message || ''));
  const resolvedReferent = hasAnaphor && currentPaths.length === 0
    ? (latestWasCorrection && previous[0] ? previous[0] : distinctPrevious.length === 1 ? distinctPrevious[0] : null)
    : null;
  const unresolvedReferent = hasAnaphor && currentPaths.length === 0 && !resolvedReferent;
  if (resolvedReferent) {
    semantics.targets = unique([...semantics.targets, resolvedReferent.target]);
    semantics.domain = 'code';
    semantics.intentOverride = 'code';
    semantics.subintentOverride = semantics.constraints.preserveState ? 'code.explain' : (semantics.subintentOverride || 'code.explain');
    semantics.routingTerms = unique(['code', semantics.subintentOverride, ...semantics.routingTerms]);
  }
  const contradictions = semantics.constraints.contradictoryTargets;
  const requiresClarification = contradictions.length > 0 || unresolvedReferent;
  const clarificationQuestion = contradictions.length
    ? `You asked me to change ${contradictions[0]} and also not modify it. Which instruction should I follow?`
    : unresolvedReferent ? 'I cannot identify what “it” refers to from the current conversation. Which file or component do you mean?' : null;
  return {
    schemaVersion: 1,
    type: 'lari.pragmatic_context',
    explicitCorrection: correction ? correction[1].trim() : null,
    priorEntityCount: distinctPrevious.length,
    resolvedReferent,
    unresolvedReferent,
    requiresClarification,
    clarificationQuestion,
    preferenceAffectsTruth: false,
    preferenceAffectsPermission: false
  };
}

function analyze(text, context = {}) {
  const syntax = parseSyntax(text);
  const semantics = interpretSemantics(text, syntax);
  semantics.discourse = interpretDiscourseSemantics(text);
  const semanticOperatorApplication = applyLearnedSemanticOperators(text, syntax, semantics, context);
  const interpretationHypotheses = buildInterpretationHypotheses(text, semanticOperatorRecords(context));
  semantics.interpretation = {
    hypotheses: interpretationHypotheses,
    selectedHypothesisId: interpretationHypotheses[0]?.hypothesisId || null,
    ambiguous: interpretationHypotheses.length > 1 && interpretationHypotheses[0].confidence === interpretationHypotheses[1].confidence
  };
  const learningText = semanticOperatorApplication.primaryActionText || text;
  const learning = context.enableLearningBinding === true ? extractLearningSemantics(learningText) : null;
  if (learning) {
    semantics.learning = learning;
    if (learning.requested) {
      semantics.domain = 'learning';
      semantics.intentOverride = 'research';
      semantics.subintentOverride = 'research.learn_new_domain';
      semantics.routingTerms = unique(['research', 'learning', learning.mode, ...String(learning.target || '').toLowerCase().split(/\s+/)]);
      semantics.mutationAllowed = false;
    }
  }
  const pragmatics = applyPragmatics(text, semantics, context);
  // Explicit grammar correction and sentence realization already belong to narrower qualified CE
  // capabilities.  Defer instead of stealing those requests because a noun happens to look like an
  // action word (for example, "test" in a sentence being corrected).
  const specializedLanguageRequest = /\b(?:fix|correct|repair|edit|rewrite)\b[\s\S]{0,70}\b(?:grammar|agreement|sentence|wording|phrase)\b/i.test(text)
    || /\b(?:write|state|give|compose)\b[\s\S]{0,50}\b(?:sentence|plainly|explaining|saying)\b/i.test(text);
  const supported = !specializedLanguageRequest
    && (learning?.requested || syntax.nodes.some(node => node.action) || semantics.targets.length > 0 || semantics.conditions.length > 0);
  if (!supported) semantics.routingTerms = [];
  const confidence = supported ? (pragmatics.requiresClarification ? 0.62 : 0.88) : 0.25;
  return {
    schemaVersion: 1,
    type: 'lari.language_understanding',
    supported,
    confidence,
    syntax,
    semantics,
    pragmatics,
    learnedSemanticOperatorIds: semanticOperatorApplication.appliedRecordIds,
    limitations: ['open-ended learned relation vocabulary with bounded current coverage', 'no unrestricted sentence parsing', 'no world-knowledge inference'],
    external_model_calls: 0
  };
}

module.exports = { analyze, parseSyntax, interpretSemantics, interpretDiscourseSemantics, applyPragmatics, extractLearningSemantics, applyLearnedSemanticOperators, learnedRelationSegments, buildInterpretationHypotheses, verifySemanticFaithfulness, realizeSemanticRelationGraph, realizeCauseEffectClaim, realizeIdentityClaim, induceSemanticRelationOperator, recordDiscourseCorrection, loadDiscourseOperatorEntries, discourseTrainingExamples, generatorStateWithLearnedOperators, realizeWithDiscourseLearning, detectCorrectionCandidate };
