'use strict';

// A deliberately bounded execution adapter for Computational English.  CE is evidence, morphology,
// and phrase composition -- not a parser or a second model.  These operators therefore refuse inputs
// whose structure they cannot verify instead of pretending to understand arbitrary prose.
const ce = require('computational-english');

const NUMBER_WORDS = new Map([
  ['a', 1], ['an', 1], ['one', 1], ['single', 1],
  ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10]
]);

function dominantNumber(info) {
  const counts = info?.formFeatures?.Number;
  if (!counts) return null;
  return Number(counts.Plur || 0) > Number(counts.Sing || 0) ? 'plural' : 'singular';
}

function capitalizeSentence(text) {
  const trimmed = String(text || '').trim().replace(/[.!?]+$/, '');
  return trimmed ? `${trimmed[0].toUpperCase()}${trimmed.slice(1)}.` : '';
}

function nounForm(lemma, number) {
  const forms = ce.inflect(lemma, number === 'plural' ? 'N;PL' : 'N;SG');
  if (forms.length) return forms[0].form;
  if (number === 'singular' && ce.word(lemma)) return lemma;
  return null;
}

function repairDemonstrativeAgreement(prompt) {
  const clause = String(prompt || '').split(':').slice(1).join(':').trim();
  if (!clause) return { executed: false, verified: false, reason: 'missing_edit_clause' };
  const tokens = clause.match(/[A-Za-z][A-Za-z'-]*|[^\sA-Za-z]+/g) || [];
  const detIndex = tokens.findIndex(token => /^(?:this|that|these|those)$/i.test(token));
  if (detIndex < 0) return { executed: false, verified: false, reason: 'unsupported_without_demonstrative' };
  const determiner = tokens[detIndex].toLowerCase();
  const requiredNumber = /^(?:these|those)$/.test(determiner) ? 'plural' : 'singular';
  let nounIndex = -1;
  for (let index = detIndex + 1; index < tokens.length; index += 1) {
    if (!/^[A-Za-z]/.test(tokens[index])) continue;
    const info = ce.word(tokens[index]);
    const finiteVerb = info?.formFeatures?.VerbForm?.Fin || info?.formFeatures?.Tense?.Past;
    if (finiteVerb && nounIndex >= 0) break;
    if (dominantNumber(info)) nounIndex = index;
  }
  if (nounIndex < 0) return { executed: false, verified: false, reason: 'no_evidenced_head_noun' };
  const original = tokens[nounIndex];
  const info = ce.word(original);
  const actualNumber = dominantNumber(info);
  if (!info?.lemma || !actualNumber) return { executed: false, verified: false, reason: 'head_number_unavailable' };
  const replacement = actualNumber === requiredNumber ? original.toLowerCase() : nounForm(info.lemma, requiredNumber);
  if (!replacement) return { executed: false, verified: false, reason: 'required_inflection_unavailable' };
  const composed = ce.compose('noun-phrase', { det: determiner, HEAD: info.lemma }, {
    features: { HEAD: requiredNumber === 'plural' ? 'N;PL' : 'N;SG' }
  });
  const agreement = (composed.checks || []).find(check => check.rule === 'det-noun-number');
  if (!agreement?.satisfied) return { executed: true, verified: false, reason: 'ce_agreement_check_failed', composed };
  tokens[nounIndex] = replacement;
  const result = capitalizeSentence(tokens.join(' ').replace(/\s+([,.;!?])/g, '$1'));
  return {
    executed: true,
    verified: true,
    result,
    operation: 'english_demonstrative_number_agreement_repair',
    evidence: {
      headLemma: info.lemma,
      observedNumber: actualNumber,
      requiredNumber,
      selectedForm: replacement,
      rule: agreement
    },
    external_model_calls: 0
  };
}

function realizeCountedEvent(prompt) {
  const text = String(prompt || '').trim();
  const match = text.match(/\b(?:that|saying)\s+(?:a\s+)?(an|one|single|two|three|four|five|six|seven|eight|nine|ten)\s+([a-z][a-z'-]*)\s+([a-z][a-z'-]*)[.!?]?\s*$/i)
    || text.match(/\b(?:that|saying)\s+(a)\s+([a-z][a-z'-]*)\s+([a-z][a-z'-]*)[.!?]?\s*$/i);
  if (!match) return { executed: false, verified: false, reason: 'unsupported_counted_event_shape' };
  const count = NUMBER_WORDS.get(match[1].toLowerCase());
  const nounInfo = ce.word(match[2]);
  const verbInfo = ce.word(match[3]);
  if (!count || !nounInfo?.lemma) return { executed: false, verified: false, reason: 'count_or_noun_not_evidenced' };
  if (!verbInfo) return { executed: false, verified: false, reason: 'event_word_not_evidenced' };
  const requiredNumber = count === 1 ? 'singular' : 'plural';
  const selectedNoun = nounForm(nounInfo.lemma, requiredNumber);
  if (!selectedNoun) return { executed: false, verified: false, reason: 'required_inflection_unavailable' };
  const countWord = count === 1 ? 'one' : match[1].toLowerCase();
  const result = capitalizeSentence(`${countWord} ${selectedNoun} ${match[3].toLowerCase()}`);
  const selectedInfo = ce.word(selectedNoun);
  if (dominantNumber(selectedInfo) !== requiredNumber) {
    return { executed: true, verified: false, reason: 'realized_noun_number_not_verified' };
  }
  return {
    executed: true,
    verified: true,
    result,
    operation: 'english_counted_event_realization',
    evidence: {
      count,
      headLemma: nounInfo.lemma,
      requiredNumber,
      selectedForm: selectedNoun,
      eventLemma: verbInfo.lemma,
      coverage: ce.coverage()
    },
    external_model_calls: 0
  };
}

function execute(kind, prompt) {
  if (kind === 'english_demonstrative_number_agreement_repair') return repairDemonstrativeAgreement(prompt);
  if (kind === 'english_counted_event_realization') return realizeCountedEvent(prompt);
  return { executed: false, verified: false, reason: 'unsupported_english_operator' };
}

module.exports = { execute, repairDemonstrativeAgreement, realizeCountedEvent };
