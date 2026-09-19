'use strict';

// Lari-native meaning-to-language realization. This is deliberately not a
// chatbot wrapper: it consumes typed propositions, uses Computational English
// to order clause roles, and refuses output that cannot be traced back to the
// supplied meaning graph.
const crypto = require('crypto');
// Greg's computational-english package lives on his PC (node_modules carries a
// dangling symlink to it in partial copies). Prefer the real package whenever
// it resolves; otherwise fall back to the embedded minimal clause composer
// below, which implements the same compose('clause', ...) contract. The
// fallback is deliberately narrow -- it assembles SVO clauses and runs the
// structural checks, nothing more. Swap in the real package by restoring the
// symlink; no code change needed.
let ce = null;
try { ce = require('computational-english'); } catch (_) { ce = null; }

function fallbackCompose(kind, parts = {}) {
  if (kind !== 'clause') return { error: 'unsupported_composition_kind' };
  const order = ['nsubj', 'HEAD', 'obj', 'advmod'].filter(role => parts[role]);
  const checks = [
    { name: 'head_present', satisfied: Boolean(parts.HEAD) },
    { name: 'subject_before_head', satisfied: !parts.nsubj || order.indexOf('nsubj') < order.indexOf('HEAD') },
    { name: 'no_empty_parts', satisfied: order.every(role => String(parts[role]).trim().length > 0) }
  ];
  if (checks.some(check => check.satisfied === false)) return { error: 'composition_checks_failed', checks };
  const text = order.map(role => String(parts[role]).trim()).join(' ');
  return { text, order, checks, orderEvidence: { source: 'lari.native.fallback', order } };
}
const composeClause = (parts) => ce ? ce.compose('clause', parts) : fallbackCompose('clause', parts);

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').replace(/[.!?]+$/g, '');
const capitalize = value => value ? value[0].toUpperCase() + value.slice(1) : value;

function defaultState() {
  return {
    schemaVersion: 1,
    kind: 'lari.native_language_generator',
    discourseChoices: {
      purpose: [{ marker: 'so that', weight: 1 }],
      concessive: [{ marker: 'although', weight: 1 }],
      temporal_precedence: [{ marker: 'before', weight: 1 }],
      cause: [{ marker: 'because', weight: 1 }],
      contrast: [{ marker: 'but', weight: 1 }],
      elaboration: [{ marker: 'and', weight: 1 }]
    },
    training: { abstractExampleCount: 0, rawOutputsRetained: false },
    external_model_calls: 0
  };
}

function trainState(examples = [], seed = defaultState()) {
  const state = JSON.parse(JSON.stringify(seed));
  for (const example of examples) {
    if (!example?.relationType || !example?.marker || !Array.isArray(example?.roles) || example.roles.length !== 2) continue;
    const choices = state.discourseChoices[example.relationType] ||= [];
    const existing = choices.find(item => item.marker === example.marker);
    if (existing) existing.weight += 1;
    else choices.push({ marker: String(example.marker), weight: 1 });
    state.training.abstractExampleCount += 1;
  }
  for (const choices of Object.values(state.discourseChoices)) choices.sort((a, b) => b.weight - a.weight || a.marker.localeCompare(b.marker));
  state.contentHash = hash({ discourseChoices: state.discourseChoices, training: state.training });
  return state;
}

function clauseFromRoles(roles = {}) {
  const parts = {};
  for (const [role, value] of Object.entries(roles)) {
    if (!value) continue;
    if (role === 'verb' || role === 'predicate') parts.HEAD = normalize(value);
    else if (['subject', 'agent'].includes(role)) parts.nsubj = normalize(value);
    else if (['object', 'patient', 'topic'].includes(role)) parts.obj = normalize(value);
    else if (role === 'modifier') parts.advmod = normalize(value);
  }
  if (!parts.HEAD) return null;
  const result = composeClause(parts);
  if (!result?.text || result.error || (result.checks || []).some(check => check.satisfied === false)) return null;
  return { text: result.text, grammarEvidence: { order: result.order, checks: result.checks || [], orderEvidence: result.orderEvidence || null } };
}

function groundedText(value) {
  if (typeof value === 'string') return normalize(value);
  if (value?.text) return normalize(value.text);
  if (value?.verb || value?.predicate) return clauseFromRoles(value)?.text || null;
  return null;
}

function verify(plan = {}, answer = '') {
  const normalizedAnswer = normalize(answer).toLowerCase();
  const groundedClaims = (plan.relations || []).flatMap(relation => Object.values(relation.roles || {}).map(groundedText)).filter(Boolean);
  const droppedClaims = groundedClaims.filter(claim => !normalizedAnswer.includes(normalize(claim).toLowerCase()));
  const unsupportedPlaceholders = String(answer).match(/\{[^}]+\}/g) || [];
  return {
    groundedClaimCount: groundedClaims.length,
    droppedClaims,
    unsupportedClaimCount: unsupportedPlaceholders.length,
    passed: groundedClaims.length > 0 && droppedClaims.length === 0 && unsupportedPlaceholders.length === 0
  };
}

function realize(plan = {}, state = defaultState()) {
  const sentences = [];
  const trace = [];
  for (const relation of plan.relations || []) {
    const roleEntries = Object.entries(relation.roles || {});
    if (roleEntries.length !== 2) return null;
    const left = groundedText(roleEntries[0][1]);
    const right = groundedText(roleEntries[1][1]);
    if (!left || !right) return null;
    const marker = relation.marker || state.discourseChoices?.[relation.type]?.[0]?.marker;
    if (!marker) return null;
    const surface = relation.surfaceOrder === 'marker_left_then_right'
      ? `${capitalize(marker)} ${left}, ${right}.`
      : `${capitalize(left)} ${marker} ${right}.`;
    sentences.push(surface);
    trace.push({ relationType: relation.type, marker, groundedRoles: roleEntries.map(([role]) => role), generatorStateHash: state.contentHash || hash(state) });
  }
  const answer = sentences.join(' ');
  const verification = verify(plan, answer);
  return verification.passed ? { answer, trace, verification, generatorStateHash: state.contentHash || hash(state), external_model_calls: 0 } : null;
}

module.exports = { defaultState, trainState, clauseFromRoles, verify, realize };
