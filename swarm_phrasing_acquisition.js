'use strict';

/**
 * Learning how to say things the same way Lari learns everything else: research, agreement, retention.
 *
 * The question this answers is "why can't Lari just research and learn to talk", and the answer is
 * that it can -- the machinery already exists and was only ever pointed at facts. `scoreEvidenceSources`
 * decides which sources are worth believing, `extractEvidenceClaims` pulls assertions out of them, and
 * `analyzeSourceAgreement` accepts a claim only when independent sources agree and flags it when they
 * contradict. That is a research loop with an automatic oracle. Nothing about it requires the thing
 * being learned to be a fact.
 *
 * So this points the same loop at *usage*. Instead of "what is true", it asks "how is this relation
 * expressed", reads real prose written by other people, abstracts the sentences that express it, and
 * retains a phrasing only when more than one accepted source attests it. Attestation is the oracle:
 * a phrasing earns its place by being how people actually write, not by sounding right to whoever
 * implemented the generator.
 *
 * Why this and not a language model
 * ---------------------------------
 * A trained n-gram was tried first and removed. Its parameters are a weight file -- small, local and
 * inspectable, but still fitted counts, and this project's thesis puts durable intelligence in
 * retained operators, verified rules, typed memory and provenance, none of which a count table is.
 * Worse, the only corpus available to it was either documentation written *about* Lari or the
 * generator's own output, so it learned a distribution over someone else's phrasings and could not
 * escape them.
 *
 * What is retained here is a rule with citations: the shape of a sentence, the relation it expresses,
 * and which sources attested it. That is the same artifact type as a repair rule -- generic, verified,
 * inspectable, revocable -- and it survives reload for the same reasons.
 *
 * Grounding still governs. An attested phrasing decides *how* something is said; whether it may be
 * said at all is decided by the claim graph, and a sentence whose numbers or identifiers are not
 * licensed is rejected however well attested its shape.
 */

/** Sentences, kept whole, from prose that may be markdown or reStructuredText. */
function sentencesOf(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')          // code blocks are not prose
    .replace(/^[>|#*=-]{2,}.*$/gm, ' ')       // rules, headings, table borders
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 20 && /[a-z]/.test(sentence));
}

/**
 * Abstract a sentence into a phrasing shape.
 *
 * Numbers and dotted or hyphenated identifiers become typed placeholders, so what remains is the way
 * the sentence is built rather than what it happened to be about. A shape with no placeholder carries
 * no content and is not a phrasing worth learning.
 */
function shapeOf(sentence) {
  const types = [];
  const shape = String(sentence)
    .split(' ')
    .map(token => {
      const bare = token.replace(/^[("']+|[)"',;:.]+$/g, '');
      if (/^\d+(?:\.\d+)?$/.test(bare)) { types.push('NUMBER'); return token.replace(bare, '{NUMBER}'); }
      if (/^[A-Za-z_][\w]*(?:[._-][\w]+)+$/.test(bare)) { types.push('NAME'); return token.replace(bare, '{NAME}'); }
      return token;
    })
    .join(' ');
  return types.length ? { shape, types } : null;
}

/**
 * Phrasings attested by more than one accepted source.
 *
 * `minSources` is the whole oracle. One source is an anecdote; agreement across independent sources is
 * what the research lane already treats as sufficient to believe a fact, and it is the same standard
 * applied to a way of speaking. Shapes are compared after normalising whitespace and case so that two
 * sources writing the same construction differently still count as agreeing.
 */
function attestedPhrasings(sources = [], { minSources = 2, maxShapes = 40, frame = 4 } = {}) {
  const accepted = sources.filter(source => source && source.accepted !== false && source.text);
  const byShape = new Map();

  // Constructions, not whole sentences.
  //
  // Requiring two sources to produce the same abstracted *sentence* attests nothing: independent
  // authors never write an identical sentence, and the first version of this returned zero phrasings
  // from three real documents. What does recur across sources is the construction around a slot --
  // "a total of {NUMBER}", "the {NAME} of the" -- which is the unit people actually share. Short
  // windows containing at least one placeholder are extracted instead, so agreement is measured over
  // something two documents can genuinely agree on.
  for (const source of accepted) {
    const seenHere = new Set();
    for (const sentence of sentencesOf(source.text)) {
      const abstracted = shapeOf(sentence);
      if (!abstracted) continue;
      const tokens = abstracted.shape.split(' ');
      for (let start = 0; start + frame <= tokens.length; start += 1) {
        const window = tokens.slice(start, start + frame);
        const types = window.filter(token => /\{NUMBER\}|\{NAME\}/.test(token))
          .map(token => (/\{NUMBER\}/.test(token) ? 'NUMBER' : 'NAME'));
        if (!types.length) continue;
        const shape = window.join(' ');
        const key = shape.toLowerCase();
        if (seenHere.has(key)) continue;      // one source cannot attest itself twice
        seenHere.add(key);
        const found = byShape.get(key) || { shape, types, sources: [], examples: [] };
        found.sources.push(source.title || source.url || 'untitled source');
        if (found.examples.length < 2) found.examples.push(sentence.slice(0, 120));
        byShape.set(key, found);
      }
    }
  }

  return [...byShape.values()]
    .filter(entry => new Set(entry.sources).size >= minSources)
    .map(entry => ({ ...entry, attestations: new Set(entry.sources).size }))
    .sort((left, right) => right.attestations - left.attestations)
    .slice(0, maxShapes);
}

/** Fill an attested shape with a claim's values. Returns null when the shape does not fit. */
function fillShape(entry, values) {
  const numbers = values.filter(value => /^\d+(?:\.\d+)?$/.test(String(value))).map(String);
  const names = values.filter(value => !/^\d+(?:\.\d+)?$/.test(String(value))).map(String);
  let numberAt = 0;
  let nameAt = 0;
  let failed = false;
  const filled = entry.shape.replace(/\{NUMBER\}|\{NAME\}/g, token => {
    if (token === '{NUMBER}') {
      if (numberAt >= numbers.length) { failed = true; return token; }
      return numbers[numberAt++];
    }
    if (nameAt >= names.length) { failed = true; return token; }
    return names[nameAt++];
  });
  if (failed || numberAt !== numbers.length || nameAt !== names.length) return null;
  return filled;
}

/**
 * Retain an attested phrasing as a typed rule with its citations.
 *
 * The same artifact shape as a retained repair rule: generic, inspectable, revocable, and carrying
 * where it came from. `storesTestAnswers` is false and true here -- a phrasing shape is a statement
 * about language, not about any answer.
 */
function retainPhrasingRule(model, entry, { relation = 'general', modelHash = null } = {}) {
  if (!model || !entry?.shape) return null;
  model.lariLearnedRecords = model.lariLearnedRecords || { schemaVersion: 1, records: [] };
  model.lariLearnedRecords.records = model.lariLearnedRecords.records || [];

  const token = Buffer.from(entry.shape).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 24).toLowerCase();
  const identity = `lari.learned.phrasing.${relation}.${token}`;
  const existing = model.lariLearnedRecords.records.find(record => record?.id === identity) || null;
  const now = new Date().toISOString();

  const record = {
    schemaVersion: 1,
    id: identity,
    type: 'operator',
    status: 'active',
    normalizedTriggers: ['language', 'phrasing', relation],
    procedureIdentity: `phrasing:${relation}:${token}`,
    semanticFingerprint: `phrasing:${token}`,
    outputBehavior: 'attested_phrasing_shape',
    contentHash: `phrasing:${token}`,
    behavioralSignature: `phrasing:${token}`,
    confidence: Math.min(0.9, 0.4 + (0.1 * entry.attestations)),
    provenance: {
      sourceModelHash: modelHash,
      sourcePath: null,
      originalRecordId: `frontier.phrasing.${token}`,
      sourceKind: 'operator',
      creationSource: 'attested_phrasing_acquisition',
      benchmarkAssociation: [],
      confidence: Math.min(0.9, 0.4 + (0.1 * entry.attestations)),
      imported: false,
      classification: 'developmental_candidate',
      importTimestamp: existing?.provenance?.importTimestamp || now,
      storesSourceCode: false,
      storesTestAnswers: false
    },
    payload: {
      domain: 'language',
      operation: 'attested_phrasing_shape',
      relation,
      shape: entry.shape,
      slotTypes: entry.types,
      attestations: entry.attestations,
      attestedBy: [...new Set(entry.sources)].slice(0, 8),
      verification: 'multi_source_agreement',
      lastAttestedAt: now
    }
  };

  model.lariLearnedRecords.records = [
    record,
    ...model.lariLearnedRecords.records.filter(item => item?.id !== identity)
  ];
  return record;
}

/** Phrasings Lari has retained, newest first. */
function retainedPhrasings(model, { relation = null } = {}) {
  return (model?.lariLearnedRecords?.records || [])
    .filter(record => record?.type === 'operator'
      && record?.status === 'active'
      && record?.payload?.operation === 'attested_phrasing_shape'
      && (!relation || record.payload.relation === relation))
    .map(record => ({
      shape: record.payload.shape,
      types: record.payload.slotTypes,
      attestations: record.payload.attestations,
      sources: record.payload.attestedBy,
      relation: record.payload.relation
    }));
}

module.exports = {
  sentencesOf,
  shapeOf,
  attestedPhrasings,
  fillShape,
  retainPhrasingRule,
  retainedPhrasings
};
