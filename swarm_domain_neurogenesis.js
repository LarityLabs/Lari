'use strict';

// One developmental lifecycle for Lari's existing canonical record types. This module is not a
// router or a store: it turns an observed gap plus evidence into records for lariLearnedRecords.
// Research may propose; only the supplied domain oracle may close the gap.
const crypto = require('crypto');
const feedback = require('./swarm_preference_feedback.js');
const realization = require('./swarm_claim_realization.js');

const TYPES = new Set(['knowledge', 'procedure', 'repair', 'operator', 'generator', 'preference']);
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const normalize = value => String(value || '').trim().replace(/\s+/g, ' ');
const tokens = value => [...new Set(String(value || '').toLowerCase().match(/[a-z0-9_.-]+/g) || [])];
const GAP_CLASSES = new Set(['knowledge_missing', 'selection_failure', 'execution_failure', 'expressiveness_gap', 'environment_failure', 'authority_unavailable', 'resource_exhausted', 'unclassified_failure']);

function classifyCapabilityFailure(evidence = {}) {
  let classification = 'unclassified_failure', reason = 'the evidence does not isolate one failure layer';
  if (evidence.authorityDenied === true) {
    classification = 'authority_unavailable'; reason = 'the required action exceeds the granted authority';
  } else if (evidence.environmentFailure === true || evidence.runnerUnavailable === true) {
    classification = 'environment_failure'; reason = 'the declared verifier or execution environment is unavailable';
  } else if (evidence.resourceExhausted === true || evidence.budgetExhausted === true || evidence.deadlineExhausted === true) {
    classification = 'resource_exhausted'; reason = 'the bounded execution budget ended before a semantic verdict';
  } else if (evidence.compatibleCapabilityAvailable === true && evidence.capabilityExecuted !== true) {
    classification = 'selection_failure'; reason = 'a compatible retained capability existed but was not executed';
  } else if (evidence.compositionExhausted === true
    && Number(evidence.attemptedCompositionCount || 0) > 0
    && Number(evidence.independentExampleCount || evidence.examples?.length || evidence.primitiveExamples?.length || 0) >= 2
    && evidence.existingCompositionPassed !== true) {
    classification = 'expressiveness_gap'; reason = 'existing primitive compositions were executed and none expressed the observed relation';
  } else if (evidence.missingKnowledge === true) {
    classification = 'knowledge_missing'; reason = 'the task requires a sourced claim absent from retained knowledge';
  } else if (evidence.capabilityExecuted === true && evidence.executionPassed !== true) {
    classification = 'execution_failure'; reason = 'a selected compatible capability executed but did not satisfy its verifier';
  }
  return {
    schemaVersion: 1,
    kind: 'CapabilityGapDiagnosis',
    classification,
    reason,
    evidence: {
      attemptedCompositionCount: Number(evidence.attemptedCompositionCount || 0),
      independentExampleCount: Number(evidence.independentExampleCount || evidence.examples?.length || evidence.primitiveExamples?.length || 0),
      existingCompositionPassed: evidence.existingCompositionPassed === true,
      executableFailureObserved: evidence.executableFailureObserved === true
    },
    confidence: classification === 'unclassified_failure' ? 0.25 : 0.9,
    persistedInModel: false
  };
}

function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function executeDeclarativePrimitive(program, input) {
  if (program?.schemaVersion !== 1 || program?.kind !== 'lari.declarative_primitive_program' || !Array.isArray(program.steps)) {
    return { passed: false, reason: 'invalid declarative primitive program' };
  }
  if (valueType(input) !== program.inputType) return { passed: false, reason: `expected ${program.inputType} input` };
  let value = clone(input);
  try {
    for (const step of program.steps) {
      if (step.op === 'trim' && typeof value === 'string') value = value.trim();
      else if (step.op === 'collapse_whitespace' && typeof value === 'string') value = value.replace(/\s+/g, ' ');
      else if (step.op === 'lowercase' && typeof value === 'string') value = value.toLowerCase();
      else if (step.op === 'uppercase' && typeof value === 'string') value = value.toUpperCase();
      else if (step.op === 'reverse' && typeof value === 'string') value = [...value].reverse().join('');
      else if (step.op === 'reverse' && Array.isArray(value)) value = [...value].reverse();
      else if (step.op === 'prefix' && typeof value === 'string' && typeof step.value === 'string') value = step.value + value;
      else if (step.op === 'suffix' && typeof value === 'string' && typeof step.value === 'string') value += step.value;
      else if (step.op === 'replace_literal' && typeof value === 'string' && typeof step.from === 'string' && step.from && typeof step.to === 'string') value = value.split(step.from).join(step.to);
      else if (step.op === 'affine' && typeof value === 'number' && Number.isFinite(step.scale) && Number.isFinite(step.offset)) value = (value * step.scale) + step.offset;
      else if (step.op === 'stable_unique' && Array.isArray(value)) value = value.filter((item, index, rows) => rows.findIndex(other => JSON.stringify(other) === JSON.stringify(item)) === index);
      else if (step.op === 'sort_ascending' && Array.isArray(value)) value = [...value].sort((a, b) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
      else if (step.op === 'sort_descending' && Array.isArray(value)) value = [...value].sort((a, b) => typeof a === 'number' && typeof b === 'number' ? b - a : String(b).localeCompare(String(a)));
      else return { passed: false, reason: `unsupported primitive step ${step.op}` };
    }
  } catch (error) {
    return { passed: false, reason: error.message };
  }
  return { passed: true, value, externalModelCalls: 0 };
}

function inferAffixes(examples) {
  const prefix = [], suffix = [];
  for (const { input, output } of examples) {
    if (output.endsWith(input)) prefix.push(output.slice(0, output.length - input.length));
    if (output.startsWith(input)) suffix.push(output.slice(input.length));
  }
  const steps = [];
  if (prefix.length === examples.length && new Set(prefix).size === 1 && prefix[0]) steps.push({ op: 'prefix', value: prefix[0] });
  if (suffix.length === examples.length && new Set(suffix).size === 1 && suffix[0]) steps.push({ op: 'suffix', value: suffix[0] });
  return steps;
}

function primitiveStepVocabulary(examples, inputType) {
  if (inputType === 'number') {
    const distinct = examples.find((row, index) => examples.some((other, otherIndex) => otherIndex !== index && other.input !== row.input));
    if (!distinct) return [];
    const other = examples.find(row => row.input !== distinct.input);
    const scale = (other.output - distinct.output) / (other.input - distinct.input);
    const offset = distinct.output - (distinct.input * scale);
    return Number.isFinite(scale) && Number.isFinite(offset) ? [{ op: 'affine', scale, offset }] : [];
  }
  if (inputType === 'array') return [{ op: 'stable_unique' }, { op: 'sort_ascending' }, { op: 'sort_descending' }, { op: 'reverse' }];
  if (inputType !== 'string') return [];
  const atomicTransforms = [
    value => value.trim(),
    value => value.toLowerCase(),
    value => value.toUpperCase(),
    value => value.replace(/\s+/g, ' '),
    value => [...value].reverse().join('')
  ];
  const transforms = [value => value];
  let frontier = [value => value];
  // Affix inference must observe the same bounded compositional space as the
  // program search. Generate transformations mechanically instead of keeping
  // a hand-written list of favored two-step combinations.
  for (let depth = 1; depth <= 3; depth += 1) {
    frontier = frontier.flatMap(prior => atomicTransforms.map(next => value => next(prior(value))));
    transforms.push(...frontier);
  }
  const inferredAffixes = [...inferAffixes(examples)];
  for (const transform of transforms) {
    const normalizedExamples = examples.map(row => ({ input: transform(row.input), output: row.output }));
    inferredAffixes.push(...inferAffixes(normalizedExamples));
  }
  const vocabulary = [{ op: 'trim' }, { op: 'collapse_whitespace' }, { op: 'lowercase' }, { op: 'uppercase' }, { op: 'reverse' }, ...inferredAffixes];
  const literalPairCounts = new Map();
  for (const { input, output } of examples) {
    if (input === output) continue;
    const prefixLength = [...input].findIndex((char, index) => char !== output[index]);
    if (prefixLength < 0) continue;
    const inputTail = input.slice(prefixLength), outputTail = output.slice(prefixLength);
    const commonSuffix = [...inputTail].reverse().findIndex((char, index) => char !== [...outputTail].reverse()[index]);
    const suffixLength = commonSuffix < 0 ? 0 : commonSuffix;
    const from = input.slice(prefixLength, input.length - suffixLength || undefined);
    const to = output.slice(prefixLength, output.length - suffixLength || undefined);
    if (from) {
      const key = JSON.stringify([from, to]);
      literalPairCounts.set(key, { count: Number(literalPairCounts.get(key)?.count || 0) + 1, step: { op: 'replace_literal', from, to } });
    }
  }
  // A literal rewrite observed once is an example lookup, not a learned rule.
  const supportedLiteralPairs = [...literalPairCounts.values()].filter(item => item.count >= 2).map(item => item.step);
  return [...new Map([...vocabulary, ...supportedLiteralPairs].map(step => [JSON.stringify(step), step])).values()];
}

function synthesizeDeclarativePrimitive(evidence = {}) {
  const examples = (evidence.examples || []).map(row => ({ input: clone(row.input), output: clone(row.output) }));
  const diagnosis = classifyCapabilityFailure({ ...evidence, examples, independentExampleCount: examples.length });
  if (diagnosis.classification !== 'expressiveness_gap') return { learned: false, reason: `primitive synthesis requires an expressiveness_gap, received ${diagnosis.classification}`, diagnosis };
  if (examples.length < 3) return { learned: false, reason: 'three independent typed examples are required', diagnosis };
  const inputTypes = new Set(examples.map(row => valueType(row.input))), outputTypes = new Set(examples.map(row => valueType(row.output)));
  if (inputTypes.size !== 1 || outputTypes.size !== 1 || [...inputTypes][0] !== [...outputTypes][0]) return { learned: false, reason: 'examples require one stable input/output type', diagnosis };
  const inputType = [...inputTypes][0], vocabulary = primitiveStepVocabulary(examples, inputType);
  const candidates = [];
  const add = steps => {
    const program = { schemaVersion: 1, kind: 'lari.declarative_primitive_program', inputType, outputType: inputType, steps: clone(steps) };
    if (examples.every(row => { const result = executeDeclarativePrimitive(program, row.input); return result.passed && JSON.stringify(result.value) === JSON.stringify(row.output); })) candidates.push(program);
  };
  let attemptedCandidateCount = 0;
  const enumerate = (prefix, remainingDepth) => {
    if (prefix.length) {
      attemptedCandidateCount += 1;
      add(prefix);
    }
    if (!remainingDepth) return;
    for (const step of vocabulary) enumerate([...prefix, step], remainingDepth - 1);
  };
  // Constraint relaxation is explicit and bounded: prove that shorter programs
  // fail before allowing one additional composition level.
  // Relax depth only inside a bounded evidence-backed search.  The old hard
  // ceiling of three made otherwise representable four-step programs look
  // like missing primitives.
  enumerate([], Math.min(5, Math.max(1, Number(evidence.maxCompositionDepth || 5))));
  const unique = [...new Map(candidates.map(program => [sha(program), program])).values()]
    .sort((a, b) => a.steps.length - b.steps.length || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!unique.length) return { learned: false, reason: 'bounded declarative synthesis exhausted without a verified program', diagnosis, attemptedCandidateCount };
  const program = unique[0];
  program.programSha256 = sha({ inputType: program.inputType, outputType: program.outputType, steps: program.steps });
  program.acquiredFrom = 'typed_examples_after_verified_composition_exhaustion';
  return { learned: true, program, diagnosis, attemptedCandidateCount, verifiedCandidateCount: unique.length };
}

function stateMachineProgram(delimiter, quote, escape, trimFields = false) {
  const transitions = {
    plain: {
      delimiter: { action: 'emit', next: 'plain' },
      quote: { action: 'skip', next: 'quoted' },
      escape: { action: 'skip', next: 'escape_plain' },
      other: { action: 'append', next: 'plain' }
    },
    quoted: {
      delimiter: { action: 'append', next: 'quoted' },
      quote: { action: 'skip', next: 'plain' },
      escape: { action: 'skip', next: 'escape_quoted' },
      other: { action: 'append', next: 'quoted' }
    },
    escape_plain: {
      delimiter: { action: 'append', next: 'plain' },
      quote: { action: 'append', next: 'plain' },
      escape: { action: 'append', next: 'plain' },
      other: { action: 'append', next: 'plain' }
    },
    escape_quoted: {
      delimiter: { action: 'append', next: 'quoted' },
      quote: { action: 'append', next: 'quoted' },
      escape: { action: 'append', next: 'quoted' },
      other: { action: 'append', next: 'quoted' }
    }
  };
  return {
    schemaVersion: 1,
    kind: 'lari.state_machine_primitive',
    inputType: 'string',
    outputType: 'array',
    alphabet: { delimiter, quote, escape },
    initialState: 'plain',
    acceptingStates: ['plain'],
    transitions,
    finalization: 'emit_buffer',
    trimFields: trimFields === true
  };
}

function executeStateMachinePrimitive(program, input) {
  if (program?.schemaVersion !== 1
    || program?.kind !== 'lari.state_machine_primitive'
    || typeof input !== 'string'
    || !program.transitions
    || (!program.alphabet && !program.charClasses)) return { passed: false, reason: 'invalid state-machine primitive' };
  const predicateMatches = (predicate, char) => {
    if (predicate.test === 'exact') return char === predicate.value;
    if (predicate.test === 'digit') return /^[0-9]$/.test(char);
    if (predicate.test === 'uppercase') return /^[A-Z]$/.test(char);
    if (predicate.test === 'lowercase') return /^[a-z]$/.test(char);
    if (predicate.test === 'whitespace') return /^\s$/.test(char);
    if (predicate.test === 'letter') return /^[A-Za-z]$/.test(char);
    if (predicate.test === 'alphanumeric') return /^[A-Za-z0-9]$/.test(char);
    return false;
  };
  const classify = program.charClasses?.kind === 'learned_predicates'
    ? char => program.charClasses.predicates.find(predicate => predicateMatches(predicate, char))?.name || 'other'
    : program.charClasses?.kind === 'exact_chars_plus_other'
      ? char => program.charClasses.exact?.[char] || 'other'
      : char => char === program.alphabet.escape
      ? 'escape'
      : char === program.alphabet.quote
        ? 'quote'
        : char === program.alphabet.delimiter
          ? 'delimiter'
          : 'other';
  let state = program.initialState;
  let buffer = '';
  const values = [];
  const stack = [];
  const emit = () => {
    values.push(program.trimFields ? buffer.trim() : buffer);
    buffer = '';
  };
  for (const char of input) {
    const className = classify(char);
    const stackCondition = stack.length ? 'nonempty' : 'empty';
    const transition = program.transitions?.[state]?.[`${className}@${stackCondition}`]
      || program.transitions?.[state]?.[className];
    if (!transition || !['append', 'append_lowercase', 'append_uppercase', 'append_toggle_case', 'append_literal', 'emit', 'skip'].includes(transition.action) || !program.transitions[transition.next]) {
      return { passed: false, reason: `invalid transition from ${state}` };
    }
    if (transition.action === 'append') buffer += char;
    else if (transition.action === 'append_lowercase') buffer += char.toLowerCase();
    else if (transition.action === 'append_uppercase') buffer += char.toUpperCase();
    else if (transition.action === 'append_toggle_case') buffer += /^[A-Z]$/.test(char) ? char.toLowerCase() : /^[a-z]$/.test(char) ? char.toUpperCase() : char;
    else if (transition.action === 'append_literal') buffer += String(transition.value || '');
    else if (transition.action === 'emit') emit();
    if (transition.stackAction === 'push') stack.push(char);
    else if (transition.stackAction === 'pop') {
      if (!stack.length) return { passed: false, reason: 'stack underflow' };
      stack.pop();
    } else if (transition.stackAction && transition.stackAction !== 'none') {
      return { passed: false, reason: `invalid stack action ${transition.stackAction}` };
    }
    state = transition.next;
  }
  if (!(program.acceptingStates || []).includes(state)) return { passed: false, reason: `non-accepting final state ${state}` };
  if (program.memory?.requireEmptyAtAccept === true && stack.length) return { passed: false, reason: 'non-empty stack at final state' };
  if (program.finalization === 'emit_buffer') emit();
  else if (program.finalization !== 'return_buffer') return { passed: false, reason: 'unsupported state-machine finalization' };
  return { passed: true, value: program.finalization === 'return_buffer' ? buffer : values, finalState: state, finalStackDepth: stack.length, externalModelCalls: 0 };
}

function finiteStateExamplePrefixCompatible(outputType, buffer, values, expected) {
  if (outputType === 'string') return typeof expected === 'string' && expected.startsWith(buffer);
  if (!Array.isArray(expected) || values.length > expected.length) return false;
  if (values.some((value, index) => value !== expected[index])) return false;
  return values.length < expected.length && String(expected[values.length]).startsWith(buffer);
}

function synthesizeFiniteStateTransducerPrimitive(evidence = {}) {
  const examples = (evidence.examples || evidence.finiteStateExamples || []).map(row => ({ input: clone(row.input), output: clone(row.output) }));
  const diagnosis = classifyCapabilityFailure({ ...evidence, examples, independentExampleCount: examples.length });
  if (diagnosis.classification !== 'expressiveness_gap') return { learned: false, reason: `finite-state synthesis requires an expressiveness_gap, received ${diagnosis.classification}`, diagnosis };
  const outputType = examples.length && examples.every(row => typeof row.output === 'string')
    ? 'string'
    : examples.length && examples.every(row => Array.isArray(row.output) && row.output.every(value => typeof value === 'string'))
      ? 'array'
      : null;
  if (examples.length < 3 || examples.some(row => typeof row.input !== 'string') || !outputType) {
    return { learned: false, reason: 'three consistently typed string transduction examples are required', diagnosis };
  }
  const exactChars = [...new Set(examples.flatMap(row => [...row.input].filter(char => /[^A-Za-z0-9 ]/.test(char))))].sort();
  if (!exactChars.length || exactChars.length > Number(evidence.maxExactCharacterClasses || 6)) {
    return { learned: false, reason: 'one to six non-alphanumeric character classes are required', diagnosis };
  }
  const classNames = exactChars.map((_, index) => `symbol_${index}`);
  const exact = Object.fromEntries(exactChars.map((char, index) => [char, classNames[index]]));
  const classify = char => exact[char] || 'other';
  const maxStates = Math.min(5, Math.max(1, Number(evidence.maxStateCount || 4)));
  const maxSearchNodes = Math.min(2000000, Math.max(1000, Number(evidence.maxSearchNodes || 250000)));
  let attemptedCandidateCount = 0;
  let searchNodes = 0;

  const tryStateCount = stateCount => {
    const stateNames = Array.from({ length: stateCount }, (_, index) => `s${index}`);
    const transitionMap = new Map();
    const rows = examples.map(row => ({ ...row, index: 0, state: 's0', buffer: '', values: [] }));
    const actions = outputType === 'array' ? ['append', 'skip', 'emit'] : ['append', 'skip'];
    const transitionChoices = (state, maxStateSeen) => {
      const highestReachable = Math.min(stateCount - 1, maxStateSeen + 1);
      const nextStates = stateNames.slice(0, highestReachable + 1);
      const choices = [];
      for (const action of actions) for (const next of nextStates) choices.push({ action, next });
      return choices;
    };
    const apply = (row, transition, char) => {
      const next = { ...row, values: [...row.values], index: row.index + 1, state: transition.next };
      if (transition.action === 'append') next.buffer += char;
      else if (transition.action === 'emit') {
        next.values.push(next.buffer);
        next.buffer = '';
      }
      return next;
    };
    const complete = row => {
      if (row.index !== row.input.length || row.state !== 's0') return false;
      const actual = outputType === 'array' ? [...row.values, row.buffer] : row.buffer;
      return JSON.stringify(actual) === JSON.stringify(row.output);
    };
    const search = (currentRows, rowIndex = 0, maxStateSeen = 0) => {
      searchNodes += 1;
      if (searchNodes > maxSearchNodes) return null;
      let selected = rowIndex;
      while (selected < currentRows.length && currentRows[selected].index === currentRows[selected].input.length) {
        if (!complete(currentRows[selected])) return null;
        selected += 1;
      }
      if (selected >= currentRows.length) return new Map(transitionMap);
      const row = currentRows[selected];
      const char = row.input[row.index];
      const className = classify(char);
      const key = `${row.state}\u0000${className}`;
      const assigned = transitionMap.get(key);
      const choices = assigned ? [assigned] : transitionChoices(row.state, maxStateSeen);
      for (const transition of choices) {
        attemptedCandidateCount += assigned ? 0 : 1;
        const nextRow = apply(row, transition, char);
        if (!finiteStateExamplePrefixCompatible(outputType, nextRow.buffer, nextRow.values, row.output)) continue;
        const nextRows = [...currentRows];
        nextRows[selected] = nextRow;
        if (!assigned) transitionMap.set(key, transition);
        const nextStateIndex = Number(transition.next.slice(1));
        const result = search(nextRows, selected, Math.max(maxStateSeen, nextStateIndex));
        if (result) return result;
        if (!assigned) transitionMap.delete(key);
      }
      return null;
    };
    const learned = search(rows);
    if (!learned) return null;
    const transitions = {};
    for (const state of stateNames) {
      transitions[state] = {};
      for (const className of [...classNames, 'other']) {
        const learnedTransition = learned.get(`${state}\u0000${className}`);
        const otherTransition = learned.get(`${state}\u0000other`);
        transitions[state][className] = clone(learnedTransition || otherTransition || { action: 'append', next: state });
      }
    }
    const program = {
      schemaVersion: 1,
      kind: 'lari.state_machine_primitive',
      representationFamily: 'induced_finite_state_transducer',
      inputType: 'string', outputType,
      charClasses: { kind: 'exact_chars_plus_other', exact },
      initialState: 's0', acceptingStates: ['s0'], transitions,
      finalization: outputType === 'array' ? 'emit_buffer' : 'return_buffer',
      stateCount
    };
    const verified = examples.every(row => {
      const result = executeStateMachinePrimitive(program, row.input);
      return result.passed && JSON.stringify(result.value) === JSON.stringify(row.output);
    });
    return verified ? program : null;
  };

  let program = null;
  for (let stateCount = 1; stateCount <= maxStates && !program && searchNodes <= maxSearchNodes; stateCount += 1) {
    program = tryStateCount(stateCount);
  }
  if (!program) return { learned: false, reason: searchNodes > maxSearchNodes ? 'finite-state induction search budget exhausted' : 'no verified finite-state transducer was found', diagnosis, attemptedCandidateCount, searchNodes };
  program.programSha256 = sha({ outputType: program.outputType, charClasses: program.charClasses, transitions: program.transitions, acceptingStates: program.acceptingStates, finalization: program.finalization });
  program.acquiredFrom = 'typed_examples_after_verified_representation_gap';
  return { learned: true, program, diagnosis, attemptedCandidateCount, verifiedCandidateCount: 1, searchNodes };
}

function learnedPredicateClasses(examples = []) {
  const inputs = examples.map(row => String(row.input || '')).join('');
  const predicates = [...new Set([...inputs].filter(char => /[^A-Za-z0-9\s]/.test(char)))].sort()
    .map((value, index) => ({ name: `symbol_${index}`, test: 'exact', value }));
  if (/[0-9]/.test(inputs)) predicates.push({ name: 'digit', test: 'digit' });
  if (/[A-Z]/.test(inputs)) predicates.push({ name: 'uppercase', test: 'uppercase' });
  if (/[a-z]/.test(inputs)) predicates.push({ name: 'lowercase', test: 'lowercase' });
  if (/\s/.test(inputs)) predicates.push({ name: 'whitespace', test: 'whitespace' });
  return predicates;
}

function synthesizeSymbolicTransducerPrimitive(evidence = {}, memoryKind = 'none') {
  const examples = (evidence.examples || evidence.symbolicStateExamples || evidence.pushdownExamples || []).map(row => ({ input: clone(row.input), output: clone(row.output) }));
  const diagnosis = classifyCapabilityFailure({ ...evidence, examples, independentExampleCount: examples.length });
  if (diagnosis.classification !== 'expressiveness_gap') return { learned: false, reason: `symbolic transducer synthesis requires an expressiveness_gap, received ${diagnosis.classification}`, diagnosis };
  if (examples.length < 3 || examples.some(row => typeof row.input !== 'string' || typeof row.output !== 'string')) {
    return { learned: false, reason: 'three typed string-to-string examples are required', diagnosis };
  }
  const predicates = learnedPredicateClasses(examples);
  if (!predicates.length || predicates.length > Number(evidence.maxPredicateClasses || 9)) {
    return { learned: false, reason: 'one to nine learned predicate classes are required', diagnosis };
  }
  const classify = char => {
    for (const predicate of predicates) {
      if (predicate.test === 'exact' && char === predicate.value) return predicate.name;
      if (predicate.test === 'digit' && /^[0-9]$/.test(char)) return predicate.name;
      if (predicate.test === 'uppercase' && /^[A-Z]$/.test(char)) return predicate.name;
      if (predicate.test === 'lowercase' && /^[a-z]$/.test(char)) return predicate.name;
      if (predicate.test === 'whitespace' && /^\s$/.test(char)) return predicate.name;
    }
    return 'other';
  };
  const literalCandidates = [...new Set(examples.flatMap(row => [...row.output].filter(char => !row.input.includes(char))))].slice(0, 4);
  const maxStates = memoryKind === 'stack'
    ? Math.min(3, Math.max(1, Number(evidence.maxStateCount || 2)))
    : Math.min(5, Math.max(1, Number(evidence.maxStateCount || 4)));
  const maxSearchNodes = Math.min(3000000, Math.max(1000, Number(evidence.maxSearchNodes || 500000)));
  let attemptedCandidateCount = 0;
  let searchNodes = 0;

  const tryStateCount = stateCount => {
    const stateNames = Array.from({ length: stateCount }, (_, index) => `s${index}`);
    const transitionMap = new Map();
    const rows = examples.map(row => ({ ...row, index: 0, state: 's0', buffer: '', stack: [] }));
    const alignedExamples = examples.filter(row => row.input.length === row.output.length);
    const supportsLowercase = alignedExamples.length === examples.length && examples.every(row => [...row.input].every((char, index) => row.output[index] === char.toLowerCase()));
    const supportsUppercase = alignedExamples.length === examples.length && examples.every(row => [...row.input].every((char, index) => row.output[index] === char.toUpperCase()));
    const supportsToggleCase = alignedExamples.length === examples.length && examples.every(row => [...row.input].every((char, index) => {
      const expected = /^[A-Z]$/.test(char) ? char.toLowerCase() : /^[a-z]$/.test(char) ? char.toUpperCase() : char;
      return row.output[index] === expected;
    }));
    const mappingActions = [
      ...(supportsLowercase ? [{ action: 'append_lowercase' }] : []),
      ...(supportsUppercase ? [{ action: 'append_uppercase' }] : []),
      ...(supportsToggleCase ? [{ action: 'append_toggle_case' }] : [])
    ];
    const actions = [{ action: 'append' }, { action: 'skip' }, ...mappingActions, ...literalCandidates.map(value => ({ action: 'append_literal', value }))];
    const transitionChoices = (row, className, maxStateSeen) => {
      const highestReachable = Math.min(stateCount - 1, maxStateSeen + 1);
      const nextStates = stateNames.slice(0, highestReachable + 1);
      const stackActions = memoryKind === 'stack'
        ? ['none', ...(className.startsWith('symbol_') ? ['push'] : []), ...(row.stack.length ? ['pop'] : [])]
        : ['none'];
      const choices = [];
      for (const action of actions) for (const next of nextStates) for (const stackAction of stackActions) choices.push({ ...action, next, stackAction });
      return choices;
    };
    const apply = (row, transition, char) => {
      const next = { ...row, stack: [...row.stack], index: row.index + 1, state: transition.next };
      if (transition.action === 'append') next.buffer += char;
      else if (transition.action === 'append_lowercase') next.buffer += char.toLowerCase();
      else if (transition.action === 'append_uppercase') next.buffer += char.toUpperCase();
      else if (transition.action === 'append_toggle_case') next.buffer += /^[A-Z]$/.test(char) ? char.toLowerCase() : /^[a-z]$/.test(char) ? char.toUpperCase() : char;
      else if (transition.action === 'append_literal') next.buffer += transition.value;
      if (transition.stackAction === 'push') next.stack.push(char);
      else if (transition.stackAction === 'pop') next.stack.pop();
      return next;
    };
    const complete = row => row.index === row.input.length
      && (memoryKind !== 'stack' || row.stack.length === 0)
      && row.buffer === row.output;
    const search = (currentRows, rowIndex = 0, maxStateSeen = 0) => {
      searchNodes += 1;
      if (searchNodes > maxSearchNodes) return null;
      let selected = rowIndex;
      while (selected < currentRows.length && currentRows[selected].index === currentRows[selected].input.length) {
        if (!complete(currentRows[selected])) return null;
        selected += 1;
      }
      if (selected >= currentRows.length) return new Map(transitionMap);
      const row = currentRows[selected];
      const char = row.input[row.index];
      const className = classify(char);
      const stackCondition = memoryKind === 'stack' ? (row.stack.length ? 'nonempty' : 'empty') : 'none';
      const key = `${row.state}\u0000${className}\u0000${stackCondition}`;
      const assigned = transitionMap.get(key);
      const choices = assigned ? [assigned] : transitionChoices(row, className, maxStateSeen);
      for (const transition of choices) {
        attemptedCandidateCount += assigned ? 0 : 1;
        const nextRow = apply(row, transition, char);
        if (!row.output.startsWith(nextRow.buffer)) continue;
        const nextRows = [...currentRows];
        nextRows[selected] = nextRow;
        if (!assigned) transitionMap.set(key, transition);
        const nextStateIndex = Number(transition.next.slice(1));
        const result = search(nextRows, selected, Math.max(maxStateSeen, nextStateIndex));
        if (result) return result;
        if (!assigned) transitionMap.delete(key);
      }
      return null;
    };
    const learned = search(rows);
    if (!learned) return null;
    const classNames = [...predicates.map(predicate => predicate.name), 'other'];
    const conditions = memoryKind === 'stack' ? ['empty', 'nonempty'] : ['none'];
    const transitions = {};
    for (const state of stateNames) {
      transitions[state] = {};
      for (const condition of conditions) for (const className of classNames) {
        const key = `${state}\u0000${className}\u0000${condition}`;
        const fallback = learned.get(`${state}\u0000other\u0000${condition}`)
          || { action: condition === 'nonempty' ? 'skip' : 'append', next: state, stackAction: 'none' };
        transitions[state][memoryKind === 'stack' ? `${className}@${condition}` : className] = clone(learned.get(key) || fallback);
      }
    }
    const program = {
      schemaVersion: 1, kind: 'lari.state_machine_primitive',
      representationFamily: memoryKind === 'stack' ? 'induced_symbolic_pushdown_transducer' : 'induced_symbolic_finite_state_transducer',
      inputType: 'string', outputType: 'string',
      charClasses: { kind: 'learned_predicates', predicates },
      initialState: 's0', acceptingStates: stateNames, transitions,
      finalization: 'return_buffer', stateCount,
      ...(memoryKind === 'stack' ? { memory: { kind: 'stack', requireEmptyAtAccept: true } } : {})
    };
    const verified = examples.every(row => {
      const result = executeStateMachinePrimitive(program, row.input);
      return result.passed && result.value === row.output;
    });
    return verified ? program : null;
  };

  let program = null;
  for (let stateCount = 1; stateCount <= maxStates && !program && searchNodes <= maxSearchNodes; stateCount += 1) program = tryStateCount(stateCount);
  if (!program) return { learned: false, reason: searchNodes > maxSearchNodes ? 'symbolic transducer search budget exhausted' : 'no verified symbolic transducer was found', diagnosis, attemptedCandidateCount, searchNodes };
  program.programSha256 = sha({ representationFamily: program.representationFamily, charClasses: program.charClasses, transitions: program.transitions, memory: program.memory || null });
  program.acquiredFrom = memoryKind === 'stack'
    ? 'typed_examples_after_finite_state_representation_exhaustion'
    : 'typed_examples_after_exact_character_class_exhaustion';
  return { learned: true, program, diagnosis, attemptedCandidateCount, verifiedCandidateCount: 1, searchNodes };
}

function synthesizeSymbolicFiniteStateTransducerPrimitive(evidence = {}) {
  return synthesizeSymbolicTransducerPrimitive(evidence, 'none');
}

function synthesizeSymbolicPushdownTransducerPrimitive(evidence = {}) {
  return synthesizeSymbolicTransducerPrimitive(evidence, 'stack');
}

function executeTextNormalizationPrimitive(program, input) {
  if (program?.op !== 'case_boundary_separator' || typeof input !== 'string') {
    return { passed: false, reason: 'invalid text-normalization primitive' };
  }
  const separator = program.separator === '-' ? '-' : '_';
  let value = input;
  if (program.acronymBoundary !== false) value = value.replace(/([A-Z]+)([A-Z][a-z])/g, `$1${separator}$2`);
  value = value.replace(/([a-z0-9])([A-Z])/g, `$1${separator}$2`);
  if (program.lowercase !== false) value = value.toLowerCase();
  return { passed: true, value, externalModelCalls: 0 };
}

function synthesizeStateMachinePrimitive(evidence = {}) {
  const examples = (evidence.examples || evidence.stateMachineExamples || []).map(row => ({ input: clone(row.input), output: clone(row.output) }));
  const diagnosis = classifyCapabilityFailure({ ...evidence, examples, independentExampleCount: examples.length });
  if (diagnosis.classification !== 'expressiveness_gap') return { learned: false, reason: `state-machine synthesis requires an expressiveness_gap, received ${diagnosis.classification}`, diagnosis };
  if (examples.length < 3 || examples.some(row => typeof row.input !== 'string' || !Array.isArray(row.output) || row.output.some(value => typeof value !== 'string'))) {
    return { learned: false, reason: 'three typed string-to-string-array examples are required', diagnosis };
  }
  const symbols = [...new Set(examples.flatMap(row => [...row.input].filter(char => /[^A-Za-z0-9\s]/.test(char))))];
  const delimiterCandidates = symbols.filter(symbol => examples.some(row => row.input.includes(symbol) && row.output.length > 1));
  const quoteCandidates = symbols;
  const escapeCandidates = symbols;
  let attemptedCandidateCount = 0;
  const verified = [];
  for (const delimiter of delimiterCandidates) {
    for (const quote of quoteCandidates) {
      for (const escape of escapeCandidates) {
        if (new Set([delimiter, quote, escape]).size !== 3) continue;
        for (const trimFields of [false, true]) {
          attemptedCandidateCount += 1;
          const program = stateMachineProgram(delimiter, quote, escape, trimFields);
          if (examples.every(row => {
            const result = executeStateMachinePrimitive(program, row.input);
            return result.passed && JSON.stringify(result.value) === JSON.stringify(row.output);
          })) verified.push(program);
        }
      }
    }
  }
  if (!verified.length) return { learned: false, reason: 'bounded transition-table synthesis exhausted without a verified machine', diagnosis, attemptedCandidateCount };
  const program = verified.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))[0];
  program.programSha256 = sha({ alphabet: program.alphabet, transitions: program.transitions, trimFields: program.trimFields });
  program.acquiredFrom = 'typed_examples_after_atomic_vocabulary_exhaustion';
  return { learned: true, program, diagnosis, attemptedCandidateCount, verifiedCandidateCount: verified.length };
}

function store(model) {
  model.lariLearnedRecords = model.lariLearnedRecords || { schemaVersion: 1, records: [] };
  model.lariLearnedRecords.records = model.lariLearnedRecords.records || [];
  return model.lariLearnedRecords.records;
}

function createGap(model, details = {}) {
  const recordType = TYPES.has(details.targetType) ? details.targetType : null;
  if (!recordType) throw new Error(`Unsupported neurogenesis target type: ${details.targetType}`);
  const diagnosis = details.diagnosis?.kind === 'CapabilityGapDiagnosis'
    ? clone(details.diagnosis)
    : classifyCapabilityFailure(details.failureEvidence || {});
  const fingerprint = sha({ targetType: recordType, capability: details.capability, failureClass: details.failureClass }).slice(0, 20);
  const existing = store(model).find(record => record.id === `lari.learned.repair.capability_gap.${fingerprint}`);
  if (existing) return existing;
  const record = {
    schemaVersion: 1,
    id: `lari.learned.repair.capability_gap.${fingerprint}`,
    type: 'repair',
    status: 'open',
    normalizedTriggers: tokens(`${details.capability} ${details.failureClass}`),
    procedureIdentity: `capability-gap:${recordType}:${fingerprint}`,
    semanticFingerprint: sha(details.failureClass || details.capability || fingerprint),
    outputBehavior: 'developmental_gap',
    contentHash: sha(details),
    behavioralSignature: `gap:${recordType}:${fingerprint}`,
    confidence: 1,
    provenance: {
      sourceModelHash: details.sourceModelHash || null,
      sourcePath: details.sourcePath || null,
      originalRecordId: null,
      sourceKind: 'ordinary_inference_failure',
      creationSource: 'lari_domain_neurogenesis',
      benchmarkAssociation: [],
      confidence: 1,
      imported: false,
      classification: 'developmental_gap',
      importTimestamp: details.createdAt || new Date().toISOString(),
      storesPromptText: false,
      storesExpectedAnswers: false
    },
    payload: {
      operation: 'capability_gap',
      targetType: recordType,
      capability: normalize(details.capability),
      failureClass: normalize(details.failureClass),
      failureCategory: GAP_CLASSES.has(diagnosis.classification) ? diagnosis.classification : 'unclassified_failure',
      failureEvidenceFingerprint: sha(diagnosis.evidence || {}),
      occurrences: Number(details.occurrences || 1),
      researchAllowed: details.researchAllowed !== false,
      closureRule: 'verified_candidate_hidden_transfer_reload_ablation',
      createdAt: details.createdAt || new Date().toISOString()
    }
  };
  store(model).unshift(record);
  return record;
}

function abstractText(text, claims) {
  let shape = normalize(text);
  const entries = Object.entries(claims || {}).sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [slot, value] of entries) {
    const needle = normalize(value);
    if (!needle || !shape.toLowerCase().includes(needle.toLowerCase())) continue;
    shape = shape.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), `{${slot}}`);
  }
  return shape;
}

function regexFromShape(shape, slots) {
  let source = String(shape).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const slot of slots) source = source.replace(`\\{${slot}\\}`, `(?<${slot}>.+?)`);
  return `^\\s*${source.replace(/\\ /g, '\\s+')}[.?!]?\\s*$`;
}

// A dynamic generator may learn a structured labelled input language from its
// demonstrations.  This is deliberately generic: it learns the labels and
// claim schema from the examples rather than installing a route for a named
// conversational family.  The parser is only a way to recover typed claims;
// the retained generator still supplies the response program and must clear
// the existing faithfulness/transfer/ablation lifecycle.
function labelBeforeClaim(prompt, value) {
  const source = String(prompt || '');
  const needle = normalize(value);
  if (!needle) return null;
  const index = source.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return null;
  const before = source.slice(0, index);
  const segmentStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  const prefix = before.slice(segmentStart).trim();
  const match = /^(.*?)\s*:\s*$/.exec(prefix);
  return match ? normalize(match[1]).toLowerCase() : null;
}

function synthesizeLabelledFrameParser(demos = [], slots = []) {
  if (!demos.length || !slots.length) return null;
  const labelAliases = Object.fromEntries(slots.map(slot => [slot, []]));
  for (const demo of demos) {
    for (const slot of slots) {
      const label = labelBeforeClaim(demo.prompt, demo.claims?.[slot]);
      if (!label) return null;
      labelAliases[slot].push(label);
    }
  }
  for (const slot of slots) labelAliases[slot] = [...new Set(labelAliases[slot])].sort();
  const owners = new Map();
  for (const [slot, labels] of Object.entries(labelAliases)) {
    if (!labels.length) return null;
    for (const label of labels) {
      if (owners.has(label) && owners.get(label) !== slot) return null;
      owners.set(label, slot);
    }
  }
  return { schemaVersion: 1, kind: 'lari.labelled_claim_frame', slots: [...slots], labelAliases };
}

function commonTokenPrefix(rows = []) {
  if (!rows.length) return [];
  const tokenRows = rows.map(value => normalize(value).toLowerCase().match(/[a-z0-9'-]+/g) || []);
  const shortest = Math.min(...tokenRows.map(tokens => tokens.length));
  const prefix = [];
  for (let index = 0; index < shortest; index += 1) {
    if (!tokenRows.every(tokens => tokens[index] === tokenRows[0][index])) break;
    prefix.push(tokenRows[0][index]);
  }
  return prefix;
}

function synthesizeSemanticScopeOperatorFromFailures(evidence = {}) {
  const traces = evidence.semanticFailureTraces || [];
  if (traces.length < 6) return { learned: false, reason: 'six semantic failure contrasts are required' };
  const normalized = [];
  for (const trace of traces) {
    const base = normalize(trace.basePrompt).replace(/[.!?]+$/, '');
    const scoped = normalize(trace.scopedPrompt).replace(/[.!?]+$/, '');
    if (!base || !scoped.toLowerCase().startsWith(base.toLowerCase()) || trace.baselineDroppedScope !== true) {
      return { learned: false, reason: 'every trace must pair one base instruction with a scope-dropping contrast' };
    }
    const tail = scoped.slice(base.length).trim();
    if (!tail || typeof trace.executeWhenConditionTrue !== 'boolean' || typeof trace.executeWhenConditionFalse !== 'boolean'
      || trace.executeWhenConditionTrue === trace.executeWhenConditionFalse) {
      return { learned: false, reason: 'every contrast needs a nonempty surface delta and a discriminating execution truth table' };
    }
    normalized.push({ tail, truthKey: `${trace.executeWhenConditionTrue}:${trace.executeWhenConditionFalse}` });
  }
  const groups = Object.groupBy(normalized, trace => trace.truthKey);
  if (!groups['true:false'] || !groups['false:true'] || groups['true:false'].length < 3 || groups['false:true'].length < 3) {
    return { learned: false, reason: 'contrasts must independently establish necessary and exception behavior' };
  }
  const relationForTruth = { 'true:false': 'necessary_condition', 'false:true': 'exception_condition' };
  const relations = {};
  for (const [truthKey, rows] of Object.entries(groups)) {
    const prefix = commonTokenPrefix(rows.map(row => row.tail));
    if (!prefix.length || rows.some(row => (normalize(row.tail).match(/[a-z0-9'-]+/gi) || []).length <= prefix.length)) {
      return { learned: false, reason: 'the failure contrasts do not isolate a reusable marker from varying conditions' };
    }
    const marker = prefix.join(' ');
    if (relations[marker] && relations[marker] !== relationForTruth[truthKey]) return { learned: false, reason: 'one marker has conflicting behavioral evidence' };
    relations[marker] = relationForTruth[truthKey];
  }
  if (Object.keys(relations).length < 2) return { learned: false, reason: 'at least two independently induced markers are required' };
  return { learned: true, program: { schemaVersion: 1, kind: 'lari.semantic_scope_operator', operation: 'bind_postposed_condition_scope', markers: Object.keys(relations).sort(), relations, scope: 'nearest_preceding_instruction', ambiguityPolicy: 'preserve_or_refuse', acquiredFrom: 'paired_meaning_loss_failures_and_execution_truth_tables' } };
}

function commonTokens(rows = []) {
  if (!rows.length) return [];
  const tokenRows = rows.map(value => new Set(normalize(value).toLowerCase().match(/[a-z0-9'-]+/g) || []));
  return [...tokenRows[0]].filter(token => tokenRows.every(row => row.has(token)));
}

function synthesizeReferentialSelectionOperatorFromFailures(evidence = {}) {
  const traces = evidence.referentialFailureTraces || [];
  if (traces.length < 6) return { learned: false, reason: 'six referential failure contrasts are required' };
  const normalized = [];
  for (const trace of traces) {
    const base = normalize(trace.basePrompt).replace(/[.!?]+$/, '');
    const referential = normalize(trace.referentialPrompt).replace(/[.!?]+$/, '');
    const entities = (trace.entities || []).map(normalize).filter(Boolean);
    const selectedIndex = entities.findIndex(entity => entity.toLowerCase() === normalize(trace.expectedEntity).toLowerCase());
    if (!base || !referential.toLowerCase().startsWith(base.toLowerCase()) || entities.length !== 2
      || selectedIndex < 0 || trace.baselineUnresolved !== true) {
      return { learned: false, reason: 'every trace must add one unresolved ordered reference to a two-entity base prompt' };
    }
    const tail = referential.slice(base.length).trim();
    if (!tail) return { learned: false, reason: 'every contrast needs a nonempty referential surface delta' };
    normalized.push({ tail, selectedIndex });
  }
  const groups = Object.groupBy(normalized, trace => String(trace.selectedIndex));
  if (!groups['0'] || !groups['1'] || groups['0'].length < 3 || groups['1'].length < 3) {
    return { learned: false, reason: 'contrasts must independently establish first and second antecedent behavior' };
  }
  const globalCommon = new Set(commonTokens(normalized.map(row => row.tail)));
  const selections = {};
  for (const [index, rows] of Object.entries(groups)) {
    const distinctive = commonTokens(rows.map(row => row.tail)).filter(token => !globalCommon.has(token));
    if (distinctive.length !== 1) return { learned: false, reason: 'failure contrasts do not isolate one reusable referential marker per behavior' };
    const marker = distinctive[0];
    if (selections[marker] !== undefined && selections[marker] !== Number(index)) return { learned: false, reason: 'one marker has conflicting selection behavior' };
    selections[marker] = Number(index);
  }
  if (Object.keys(selections).length !== 2) return { learned: false, reason: 'two independently induced selection markers are required' };
  return { learned: true, program: { schemaVersion: 1, kind: 'lari.referential_selection_operator', operation: 'resolve_ordered_pair_reference', selections, relation: 'ordered_referent', candidateSource: 'explicit_ordered_entities', minimumCandidates: 2, ambiguityPolicy: 'preserve_or_refuse', acquiredFrom: 'paired_unresolved_reference_failures_and_selected_antecedent_feedback' } };
}

function synthesizeRecursiveCompositionProgram(evidence = {}) {
  const traces = evidence.successfulCompositions || [];
  if (traces.length < 2) return { learned: false, reason: 'two successful composition traces are required' };
  const normalized = traces.map(trace => ({
    families: [...new Set((trace.families || []).map(normalize).filter(Boolean))],
    verified: trace.verified === true,
    grounded: trace.grounded === true
  }));
  if (normalized.some(trace => trace.families.length < 2 || !trace.verified || !trace.grounded)) {
    return { learned: false, reason: 'every composition trace must contain two grounded verified families' };
  }
  const distinctSequences = new Set(normalized.map(trace => trace.families.join('>')));
  const allowedFamilies = [...new Set(normalized.flatMap(trace => trace.families))].sort();
  if (distinctSequences.size < 2 || allowedFamilies.length < 3) {
    return { learned: false, reason: 'composition evidence must span two sequences and three families' };
  }
  return {
    learned: true,
    program: {
      schemaVersion: 1,
      kind: 'recap.recursive_composition_program',
      family: 'recursive_composition',
      operation: 'compose_verified_discourse',
      allowedFamilies,
      minComponents: 2,
      maxComponents: Math.max(...normalized.map(trace => trace.families.length)),
      minimumDistinctFamilies: 2,
      joiner: '\n\n',
      selectionSemantics: ['explicit_user_order', 'verified_component', 'narrower_semantic_scope', 'provenance', 'confidence'],
      acquiredFrom: 'multiple_grounded_verified_composition_traces'
    }
  };
}

function synthesizeGeneratorProgram(evidence = {}) {
  if (Array.isArray(evidence.successfulCompositions)) return synthesizeRecursiveCompositionProgram(evidence);
  const demos = evidence.demonstrations || [];
  if (demos.length < 2) return { learned: false, reason: 'two demonstrations are required' };
  const slots = Object.keys(demos[0].claims || {});
  if (slots.length < 2 || demos.some(demo => JSON.stringify(Object.keys(demo.claims || {})) !== JSON.stringify(slots))) {
    return { learned: false, reason: 'demonstrations must share a typed claim schema' };
  }
  const promptShapes = demos.map(demo => abstractText(demo.prompt, demo.claims));
  const responseShapes = demos.map(demo => abstractText(demo.response, demo.claims));
  if (new Set(responseShapes.map(shape => shape.toLowerCase())).size !== 1) return { learned: false, reason: 'response construction did not generalize' };
  const family = normalize(evidence.capability).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const uniqueShapes = [...new Set(promptShapes.map(shape => normalize(shape)))];
  const matchers = uniqueShapes.map(shape => ({ source: regexFromShape(shape, slots), flags: 'i', slots }));
  const frameParser = synthesizeLabelledFrameParser(demos, slots);
  if (uniqueShapes.length > 1 && !frameParser) {
    return { learned: false, reason: 'multiple prompt constructions require one shared labelled claim frame' };
  }
  const program = {
    schemaVersion: 1,
    kind: 'recap.dynamic_generator_program',
    family,
    matcher: matchers[0],
    matchers,
    ...(frameParser ? { frameParser } : {}),
    responsePattern: responseShapes[0],
    requiredClaims: slots,
    relations: clone(evidence.relations || []),
    confidenceSlots: clone(evidence.confidenceSlots || {}),
    acquiredFrom: 'multiple_demonstrations_and_research_proposal'
  };
  return { learned: true, program };
}

// A shared cross-modal scene is a typed semantic binding, not another
// modality model. The existing SVG and WAV executors remain responsible for
// rendering; this program only retains the entities, relations, style, and
// timing they must agree on. Demonstrations are normalized into the reusable
// scene schema and are never copied into the record.
function synthesizeMultimodalSceneProgram(evidence = {}) {
  const demonstrations = evidence.sceneDemonstrations || [];
  if (demonstrations.length < 2) return { learned: false, reason: 'two typed scene demonstrations are required' };
  const normalizeList = values => [...new Set((values || []).map(value => normalize(value).toLowerCase()).filter(Boolean))].sort();
  const normalizeEntities = values => (values || [])
    .map(entity => ({ id: normalize(entity.id), kind: normalize(entity.kind).toLowerCase(), role: normalize(entity.role).toLowerCase() }))
    .filter(entity => entity.id && entity.kind)
    .sort((a, b) => a.id.localeCompare(b.id));
  const first = demonstrations[0].scene || {};
  const canonical = {
    entities: normalizeEntities(first.entities),
    relations: (first.relations || []).map(relation => ({
      type: normalize(relation.type).toLowerCase(),
      from: normalize(relation.from),
      to: normalize(relation.to)
    })).filter(relation => relation.type && relation.from && relation.to)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    imageElements: normalizeList(first.imageElements),
    audioFeatures: normalizeList(first.audioFeatures),
    mood: normalize(first.mood).toLowerCase(),
    timing: { durationSeconds: Number(first.timing?.durationSeconds || 0) }
  };
  if (!canonical.entities.length || !canonical.relations.length || !canonical.imageElements.length
    || !canonical.audioFeatures.length || !canonical.mood || canonical.timing.durationSeconds <= 0) {
    return { learned: false, reason: 'scene demonstrations need entities, relations, image elements, audio features, mood, and positive timing' };
  }
  const entityIds = new Set(canonical.entities.map(entity => entity.id));
  if (canonical.relations.some(relation => !entityIds.has(relation.from) || !entityIds.has(relation.to))) {
    return { learned: false, reason: 'scene relations must resolve to typed entities' };
  }
  for (const demonstration of demonstrations.slice(1)) {
    const scene = demonstration.scene || {};
    const comparable = {
      entities: normalizeEntities(scene.entities),
      relations: (scene.relations || []).map(relation => ({
        type: normalize(relation.type).toLowerCase(),
        from: normalize(relation.from),
        to: normalize(relation.to)
      })).filter(relation => relation.type && relation.from && relation.to)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      imageElements: normalizeList(scene.imageElements),
      audioFeatures: normalizeList(scene.audioFeatures),
      mood: normalize(scene.mood).toLowerCase(),
      timing: { durationSeconds: Number(scene.timing?.durationSeconds || 0) }
    };
    if (JSON.stringify(comparable) !== JSON.stringify(canonical)) {
      return { learned: false, reason: 'scene demonstrations do not preserve one shared typed semantic program' };
    }
  }
  return {
    learned: true,
    program: {
      schemaVersion: 1,
      kind: 'lari.multimodal.scene_program',
      entities: canonical.entities,
      relations: canonical.relations,
      imageElements: canonical.imageElements,
      audioFeatures: canonical.audioFeatures,
      mood: canonical.mood,
      timing: canonical.timing,
      acquiredFrom: 'multiple_typed_cross_modal_demonstrations',
      verification: 'cross_modal_entity_relation_timing_reload_ablation'
    }
  };
}

function synthesizeInteractionProgram(evidence = {}) {
  const demos = evidence.demonstrations || [];
  if (demos.length < 2) return { learned: false, reason: 'two interaction demonstrations are required' };
  const slots = Object.keys(demos[0].claims || {});
  if (!slots.length || demos.some(demo => JSON.stringify(Object.keys(demo.claims || {})) !== JSON.stringify(slots))) return { learned: false, reason: 'interaction demonstrations need one shared claim schema' };
  const promptShapes = demos.map(demo => abstractText(demo.prompt, demo.claims));
  const responseShapes = demos.map(demo => abstractText(demo.response, demo.claims));
  if (new Set(promptShapes.map(shape => shape.toLowerCase())).size !== 1) return { learned: false, reason: 'interaction prompt did not generalize' };
  if (new Set(responseShapes.map(shape => shape.toLowerCase())).size !== 1) return { learned: false, reason: 'interaction response did not generalize' };
  const promptSlots = slots.filter(slot => promptShapes[0].includes(`{${slot}}`));
  const requiredClaims = slots.filter(slot => responseShapes[0].includes(`{${slot}}`));
  return {
    learned: true,
    program: {
      schemaVersion: 1,
      kind: 'lari.canonical_record_interaction',
      matcher: { source: regexFromShape(promptShapes[0], promptSlots), flags: 'i', slots: promptSlots },
      responsePattern: responseShapes[0],
      requiredClaims,
      derivedClaims: clone(evidence.derivedClaims || {}),
      userScope: evidence.userScope || null,
      acquiredFrom: 'multiple_demonstrations'
    }
  };
}

function commonProcedure(traces = []) {
  if (traces.length < 2 || traces.some(trace => !Array.isArray(trace) || !trace.length)) return [];
  return traces[0].filter((step, index) => traces.every(trace => trace[index] === step));
}

function diagnoseOperatorFailure(details = {}) {
  const source = String(details.source || ''), failureText = String(details.failureText || ''), task = String(details.task || '');
  const combined = `${task} ${failureText} ${source}`.toLowerCase();
  const concepts = [
    { concept: 'power', pattern: /\b(?:power|exponent|raised to)\b/ },
    { concept: 'floor division', pattern: /\b(?:floor division|integer quotient)\b/ },
    { concept: 'modulo', pattern: /\b(?:modulo|remainder)\b/ }
  ];
  const semantic = concepts.find(item => item.pattern.test(combined));
  const expression = /\breturn\s+([^\r\n#]+)/.exec(source)?.[1]?.trim() || '';
  const observed = ['**', '//', '>=', '<=', '==', '!=', '*', '/', '%', '+', '-'].find(operator => expression.includes(operator)) || null;
  if (!semantic || !observed || !failureText.trim()) return { diagnosed: false, reason: 'insufficient semantic or executable failure evidence' };
  const claimFingerprint = sha({ concept: semantic.concept, observed, failureClass: normalize(failureText).slice(0, 240) });
  return {
    diagnosed: true,
    hypothesis: {
      schemaVersion: 1,
      kind: 'DiagnosticHypothesis',
      id: `lari.diagnostic.operator.${claimFingerprint.slice(0, 20)}`,
      hypothesisKind: 'semantic_operator_mismatch',
      claim: `The observed ${observed} operator does not implement the requested ${semantic.concept} semantics.`,
      basis: 'fail-before execution plus the function and test semantic vocabulary',
      observedOperator: normalizeTokenForRule(observed),
      intendedConcept: semantic.concept,
      claimFingerprint,
      status: 'provisional_until_fail_before_pass_after',
      retainInModel: false
    }
  };
}

function normalizeTokenForRule(token) {
  return /^(?:>=|<=|==|!=|<|>)$/.test(token) ? token : ` ${String(token).trim()} `;
}

function typedRecord(targetType, capability, payload, context = {}) {
  const contentHash = sha(payload);
  const id = `lari.learned.${targetType}.neurogenesis.${contentHash.slice(0, 20)}`;
  return {
    schemaVersion: 1,
    id,
    type: targetType,
    status: 'active',
    normalizedTriggers: tokens(`${capability} ${(payload.triggers || []).join(' ')}`),
    procedureIdentity: `domain-neurogenesis:${targetType}:${normalize(capability)}`,
    semanticFingerprint: sha({ targetType, capability, semantics: payload.semantics || payload.claim || payload.procedure || payload.generatorProgram }),
    outputBehavior: payload.operation || payload.output || capability,
    contentHash,
    behavioralSignature: `neurogenesis:${targetType}:${contentHash.slice(0, 16)}`,
    confidence: Number(context.confidence || 0.85),
    provenance: {
      sourceModelHash: context.sourceModelHash || null,
      sourcePath: context.sourcePath || null,
      originalRecordId: context.gapId || null,
      sourceKind: 'failure_driven_neurogenesis',
      creationSource: 'lari_domain_neurogenesis',
      benchmarkAssociation: [],
      confidence: Number(context.confidence || 0.85),
      imported: false,
      classification: 'developmental_candidate',
      importTimestamp: context.createdAt || new Date().toISOString(),
      researchSources: (context.researchSources || []).map(source => source.title || source.url).filter(Boolean),
      researchIsProposalOnly: true,
      storesPromptText: false,
      storesExpectedAnswers: false
    },
    payload
  };
}

function proposeCandidate(model, gap, evidence = {}, context = {}) {
  if (!gap || gap.status !== 'open' || gap.payload?.operation !== 'capability_gap') return { learned: false, reason: 'an open capability gap is required' };
  const targetType = gap.payload.targetType;
  let payload = null;
  if (targetType === 'generator') {
    const synthesis = evidence.interactionDemonstrations
      ? synthesizeInteractionProgram({
        demonstrations: evidence.interactionDemonstrations,
        derivedClaims: evidence.derivedClaims,
        userScope: evidence.userScope
      })
      : evidence.multimodalScene
        ? synthesizeMultimodalSceneProgram(evidence)
        : synthesizeGeneratorProgram({ ...evidence, capability: gap.payload.capability });
    if (!synthesis.learned) return synthesis;
    payload = evidence.interactionDemonstrations
      ? {
        domain: evidence.domain || 'general',
        operation: 'canonical_record_interaction',
        interactionProgram: synthesis.program,
        verification: 'ordinary_request_hidden_transfer_reload_exact_dependency_ablation'
      }
      : evidence.multimodalScene
      ? {
        domain: 'multimodal',
        operation: 'multimodal.scene_semantic_binding',
        sceneProgram: synthesis.program,
        verification: 'cross_modal_entity_relation_timing_reload_ablation'
      }
      : {
        domain: 'executable_language',
        operation: synthesis.program.kind === 'recap.recursive_composition_program'
          ? 'recap.compose.recursive_verified'
          : `recap.dynamic.${synthesis.program.family}`,
        generatorProgram: synthesis.program,
        verification: 'semantic_faithfulness_hidden_transfer_reload_ablation'
      };
  } else if (targetType === 'procedure') {
    const procedure = commonProcedure(evidence.successfulTraces || []);
    if (!procedure.length) return { learned: false, reason: 'no shared successful procedure was found' };
    payload = { domain: evidence.domain || 'general', operation: `procedure.${normalize(gap.payload.capability).replace(/\s+/g, '_')}`, procedure, verification: 'execution_hidden_transfer_reload_ablation' };
  } else if (targetType === 'knowledge') {
    if (!evidence.claim || !evidence.source) return { learned: false, reason: 'a sourced typed claim is required' };
    payload = { domain: 'research', operation: 'source_backed_claim', topic: evidence.topic, subject: evidence.subject || evidence.topic, summary: evidence.summary, claim: clone(evidence.claim), meaning: 'faithful to cited evidence; not independently verified as true', source: evidence.source, verification: 'source_faithfulness_hidden_query_reload_ablation' };
  } else if (targetType === 'operator') {
    if (evidence.pushdownExamples || evidence.symbolicStateExamples) {
      const pushdown = Boolean(evidence.pushdownExamples);
      const examples = pushdown ? evidence.pushdownExamples : evidence.symbolicStateExamples;
      const synthesis = pushdown
        ? synthesizeSymbolicPushdownTransducerPrimitive({ ...evidence, examples })
        : synthesizeSymbolicFiniteStateTransducerPrimitive({ ...evidence, examples });
      if (!synthesis.learned) return synthesis;
      if (evidence.executableProof !== true) return { learned: false, reason: 'an induced symbolic transducer requires independent executable proof', diagnosis: synthesis.diagnosis };
      payload = {
        domain: evidence.domain || 'general', operation: 'state_machine_primitive', operatorAst: synthesis.program,
        acquisitionRoute: pushdown
          ? 'failure_classified_finite_state_exhausted_symbolic_stack_transducer_induced_independently_verified'
          : 'failure_classified_exact_classes_exhausted_symbolic_predicate_transducer_induced_independently_verified',
        synthesis: {
          attemptedCandidateCount: synthesis.attemptedCandidateCount, verifiedCandidateCount: synthesis.verifiedCandidateCount,
          searchNodes: synthesis.searchNodes, failureCategory: synthesis.diagnosis.classification
        },
        verification: 'independent_examples_representation_transfer_reload_exact_ablation'
      };
    } else if (evidence.finiteStateExamples) {
      const synthesis = synthesizeFiniteStateTransducerPrimitive({ ...evidence, examples: evidence.finiteStateExamples });
      if (!synthesis.learned) return synthesis;
      if (evidence.executableProof !== true) return { learned: false, reason: 'an induced finite-state transducer requires independent executable proof', diagnosis: synthesis.diagnosis };
      payload = {
        domain: evidence.domain || 'general',
        operation: 'state_machine_primitive',
        operatorAst: synthesis.program,
        acquisitionRoute: 'failure_classified_representation_gap_finite_state_transducer_induced_independently_verified',
        synthesis: {
          attemptedCandidateCount: synthesis.attemptedCandidateCount,
          verifiedCandidateCount: synthesis.verifiedCandidateCount,
          searchNodes: synthesis.searchNodes,
          failureCategory: synthesis.diagnosis.classification
        },
        verification: 'independent_examples_new_behavior_family_hidden_transfer_reload_exact_ablation'
      };
    } else if (evidence.stateMachineExamples) {
      const synthesis = synthesizeStateMachinePrimitive({ ...evidence, examples: evidence.stateMachineExamples });
      if (!synthesis.learned) return synthesis;
      if (evidence.executableProof !== true) return { learned: false, reason: 'a synthesized state machine requires independent executable proof', diagnosis: synthesis.diagnosis };
      payload = {
        domain: evidence.domain || 'general',
        operation: 'state_machine_primitive',
        operatorAst: synthesis.program,
        acquisitionRoute: 'failure_classified_atomic_vocabulary_exhausted_transition_table_synthesized_independently_verified',
        synthesis: {
          attemptedCandidateCount: synthesis.attemptedCandidateCount,
          verifiedCandidateCount: synthesis.verifiedCandidateCount,
          failureCategory: synthesis.diagnosis.classification
        },
        verification: 'independent_examples_cross_domain_hidden_transfer_reload_exact_ablation'
      };
    } else if (evidence.primitiveExamples) {
      const synthesis = synthesizeDeclarativePrimitive({ ...evidence, examples: evidence.primitiveExamples });
      if (!synthesis.learned) return synthesis;
      if (evidence.executableProof !== true) return { learned: false, reason: 'a synthesized primitive requires independent executable proof', diagnosis: synthesis.diagnosis };
      payload = {
        domain: evidence.domain || 'general',
        operation: 'declarative_primitive_program',
        primitiveAst: synthesis.program,
        acquisitionRoute: 'failure_classified_composition_exhausted_typed_examples_independently_verified',
        synthesis: {
          attemptedCandidateCount: synthesis.attemptedCandidateCount,
          verifiedCandidateCount: synthesis.verifiedCandidateCount,
          failureCategory: synthesis.diagnosis.classification
        },
        verification: 'independent_examples_hidden_transfer_reload_exact_ablation'
      };
    } else if (evidence.referentialFailureTraces) {
      const synthesis = synthesizeReferentialSelectionOperatorFromFailures(evidence);
      if (!synthesis.learned) return synthesis;
      payload = { domain: 'language_understanding', operation: 'language.semantic_relation_operator', family: evidence.family || 'induced-referential-selection', operatorAst: synthesis.program, acquisitionRoute: 'failure_contrasts_behavioral_induction_independently_verified', citedSources: [], verification: 'unresolved_before_hidden_cross_domain_transfer_reload_ablation' };
    } else if (evidence.semanticFailureTraces) {
      const synthesis = synthesizeSemanticScopeOperatorFromFailures(evidence);
      if (!synthesis.learned) return synthesis;
      payload = { domain: 'language_understanding', operation: 'language.semantic_scope_operator', family: evidence.family || 'induced-semantic-scope', operatorAst: synthesis.program, acquisitionRoute: 'failure_contrasts_behavioral_induction_independently_verified', citedSources: [], verification: 'meaning_loss_before_hidden_cross_domain_transfer_reload_ablation' };
    } else if (evidence.semanticOperatorAst) {
      if (evidence.executableProof !== true
        || evidence.semanticOperatorAst.kind !== 'lari.semantic_scope_operator'
        || !Array.isArray(evidence.semanticOperatorAst.markers)
        || evidence.semanticOperatorAst.markers.length < 2) {
        return { learned: false, reason: 'a semantic operator requires a typed AST and independent executable proof' };
      }
      payload = { domain: 'language_understanding', operation: 'language.semantic_scope_operator', family: evidence.family || 'learned-semantic-scope', operatorAst: clone(evidence.semanticOperatorAst), acquisitionRoute: 'failure_diagnosed_composition_exhausted_independently_verified', citedSources: (evidence.sources || []).map(source => source.title || source.url).filter(Boolean), verification: 'meaning_loss_before_hidden_cross_domain_transfer_reload_ablation' };
    } else {
      if (!evidence.rule || !Array.isArray(evidence.rule) || evidence.rule.length !== 2 || evidence.executableProof !== true) return { learned: false, reason: 'a research-proposed rule requires executable proof' };
      payload = { domain: evidence.domain || 'code', operation: 'mutation_vocabulary_rule', family: evidence.family || 'researched-substitution', rule: clone(evidence.rule), acquisitionRoute: 'research_proposed_test_verified', citedSources: (evidence.sources || []).map(source => source.title || source.url).filter(Boolean), verification: 'fail_before_pass_after_hidden_transfer_reload_ablation' };
    }
  } else if (targetType === 'preference') {
    const phrasing = feedback.correctionToPhrasing(evidence.correction, evidence.claim, realization);
    if (!phrasing.accepted) return { learned: false, reason: phrasing.reason, details: phrasing };
    payload = { domain: 'user_expression', operation: 'faithful_phrasing_preference', userScope: evidence.userScope || 'default', claimType: evidence.claim.type, shape: phrasing.shape, verification: 'grounding_preservation_user_scope_reload_ablation' };
  } else if (targetType === 'repair') {
    if (!evidence.failureClass || !evidence.procedure) return { learned: false, reason: 'repair evidence is incomplete' };
    payload = { domain: evidence.domain || 'general', operation: 'verified_repair', failureClass: evidence.failureClass, procedure: clone(evidence.procedure), verification: 'failure_reproduction_hidden_transfer_reload_ablation' };
  }
  const record = typedRecord(targetType, gap.payload.capability, payload, { ...context, gapId: gap.id, researchSources: evidence.researchSources || evidence.sources || [] });
  return { learned: true, record };
}

function retainVerifiedCandidate(model, gap, proposal, proof = {}) {
  if (!proposal?.learned || !proposal.record) return { retained: false, reason: 'no synthesized candidate' };
  const gates = ['visible', 'hiddenTransfer', 'semanticFaithfulness', 'reload', 'ablation', 'regressions', 'externalModelCallsZero'];
  const failed = gates.filter(gate => gate === 'regressions' ? Number(proof[gate]) !== 0 : proof[gate] !== true);
  if (failed.length) return { retained: false, reason: `verification failed: ${failed.join(', ')}` };
  store(model).unshift(proposal.record);
  gap.status = 'closed';
  gap.payload.closedBy = { recordId: proposal.record.id, verification: gates, closedAt: proof.closedAt || new Date().toISOString() };
  return { retained: true, record: proposal.record, gapId: gap.id };
}

function executeProcedure(record, context = {}, actions = {}) {
  if (record?.type !== 'procedure' || !Array.isArray(record.payload?.procedure)) return { passed: false, reason: 'not an executable procedure' };
  const trace = [];
  let state = clone(context);
  for (const step of record.payload.procedure) {
    if (typeof actions[step] !== 'function') return { passed: false, reason: `missing action ${step}`, trace };
    state = actions[step](state);
    trace.push(step);
  }
  return { passed: true, state, trace, recordId: record.id, externalModelCalls: 0 };
}

function executeInteractionProgram(model, message = '', options = {}) {
  const candidates = (model?.lariLearnedRecords?.records || []).filter(record => record?.status === 'active'
    && record?.payload?.interactionProgram?.kind === 'lari.canonical_record_interaction');
  for (const record of candidates) {
    const program = record.payload.interactionProgram;
    if (program.userScope && program.userScope !== (options.userScope || 'default')) continue;
    let match = null;
    try { match = new RegExp(program.matcher.source, program.matcher.flags || 'i').exec(String(message || '').trim()); } catch { continue; }
    if (!match?.groups) continue;
    const claims = Object.fromEntries(program.matcher.slots.map(slot => [slot, normalize(match.groups[slot])]).filter(([, value]) => value));
    const dependencyRecordIds = [];
    for (const [slot, derivation] of Object.entries(program.derivedClaims || {})) {
      if (derivation.kind === 'operator_apply') {
        const source = claims[derivation.sourceSlot];
        const rule = record.payload.rule;
        if (!source || !Array.isArray(rule) || rule.length !== 2) return null;
        claims[slot] = String(source).replace(rule[0], rule[1]);
      } else if (derivation.kind === 'primitive_apply') {
        const source = claims[derivation.sourceSlot];
        const primitive = (model?.lariLearnedRecords?.records || []).find(candidate => candidate?.id === derivation.primitiveId
          && candidate?.status === 'active'
          && candidate?.type === 'operator'
          && candidate?.payload?.operation === 'declarative_primitive_program');
        if (source === undefined || !primitive) return null;
        let typedSource = source;
        if (primitive.payload.primitiveAst?.inputType === 'number' && typeof source === 'string' && source.trim() !== '') typedSource = Number(source);
        else if (primitive.payload.primitiveAst?.inputType === 'array' && typeof source === 'string') {
          try { typedSource = JSON.parse(source); } catch {
            typedSource = source.split(',').map(value => normalize(value)).filter(Boolean);
            if (!typedSource.length) return null;
          }
        }
        const executed = executeDeclarativePrimitive(primitive.payload.primitiveAst, typedSource);
        if (!executed.passed) return null;
        claims[slot] = executed.value;
        dependencyRecordIds.push(primitive.id);
      }
    }
    if (!program.requiredClaims.every(slot => Object.prototype.hasOwnProperty.call(claims, slot)
      && claims[slot] !== null && claims[slot] !== undefined && String(claims[slot]).length > 0)) continue;
    const answer = String(program.responsePattern).replace(/\{([A-Za-z]+)\}/g, (_all, slot) => (
      Object.prototype.hasOwnProperty.call(claims, slot) ? String(claims[slot]) : ''
    )).replace(/\s+/g, ' ').trim();
    const normalizedAnswer = answer.toLowerCase();
    const droppedClaims = program.requiredClaims.filter(slot => !normalizedAnswer.includes(String(claims[slot]).toLowerCase()));
    if (droppedClaims.length || /\{[A-Za-z]+\}/.test(answer)) return null;
    return {
      answer,
      recordId: record.id,
      recordType: record.type,
      claims,
      executionTrace: record.type === 'procedure' || record.type === 'repair' ? clone(record.payload.procedure || []) : [],
      verification: { claimCoverage: true, grounded: true, droppedClaims: [], passed: true },
      learnedRecordIds: [record.id, ...dependencyRecordIds],
      publicAnswerSource: 'canonical_learned_record_execution',
      external_model_calls: 0
    };
  }
  return null;
}

module.exports = {
  TYPES,
  GAP_CLASSES,
  classifyCapabilityFailure,
  createGap,
  abstractText,
  synthesizeLabelledFrameParser,
  synthesizeGeneratorProgram,
  synthesizeMultimodalSceneProgram,
  synthesizeRecursiveCompositionProgram,
  synthesizeInteractionProgram,
  synthesizeSemanticScopeOperatorFromFailures,
  synthesizeReferentialSelectionOperatorFromFailures,
  commonProcedure,
  diagnoseOperatorFailure,
  synthesizeDeclarativePrimitive,
  executeDeclarativePrimitive,
  synthesizeStateMachinePrimitive,
  synthesizeFiniteStateTransducerPrimitive,
  synthesizeSymbolicFiniteStateTransducerPrimitive,
  synthesizeSymbolicPushdownTransducerPrimitive,
  executeStateMachinePrimitive,
  executeTextNormalizationPrimitive,
  proposeCandidate,
  retainVerifiedCandidate,
  executeProcedure,
  executeInteractionProgram
};
