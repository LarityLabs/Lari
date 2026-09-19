'use strict';

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function contains(answer, phrase) {
  const normalizedAnswer = normalize(answer);
  const normalizedPhrase = normalize(phrase);
  if (normalizedAnswer.includes(normalizedPhrase)) return true;
  const root = token => token
    .replace(/(?:ability|ibility|ality|icity|ation|ition|ment|ness|ship)$/g, '')
    .replace(/(?:istic|ical|ous|ive)$/g, '')
    .replace(/(?:ing|ed|es|s)$/g, '');
  const answerRoots = new Set(normalizedAnswer.split(/\s+/).map(root).filter(Boolean));
  const phraseRoots = normalizedPhrase.split(/\s+/).map(root).filter(Boolean);
  return phraseRoots.length > 0 && phraseRoots.every(token => answerRoots.has(token));
}

function verifySemanticAnswer(answer, contract = {}) {
  const text = String(answer || '').trim();
  const claims = (contract.claims || []).map(claim => {
    const all = (claim.all || []).every(term => contains(text, term));
    const any = !(claim.any || []).length || claim.any.some(term => contains(text, term));
    return { id: claim.id, passed: all && any };
  });
  const relations = (contract.relations || []).map(relation => {
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
    const passed = sentences.some(sentence => contains(sentence, relation.left)
      && contains(sentence, relation.right)
      && (relation.cues || []).some(cue => contains(sentence, cue)));
    return { id: relation.id, passed };
  });
  const forbidden = (contract.forbidden || []).filter(term => contains(text, term));
  const passed = text.length > 0 && claims.every(item => item.passed) && relations.every(item => item.passed) && forbidden.length === 0;
  return { passed, claims, relations, forbidden, answerSha256: require('crypto').createHash('sha256').update(text).digest('hex') };
}

module.exports = { verifySemanticAnswer };
