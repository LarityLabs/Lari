'use strict';

const assert = require('assert');
const { proposePrefixDomainCandidates } = require('../swarm_mutation_repair');

// Regression: a large number of irrelevant None comparisons must not evict the
// localized annotation predicate from a bounded proposal pool.
const annotationSource = 'def convert(annotation, value):\n    if annotation is not Signature.empty:\n        return value.to(annotation)\n    return value\n';
const crowded = { 'src/contracts.py': annotationSource };
for (let i = 0; i < 80; i++) crowded[`src/noise_${i}.py`] = 'if value is None:\n    pass\n';
crowded['tests/test_contracts.py'] = 'if annotation is not Signature.empty:\n    pass\n';
const annotation = proposePrefixDomainCandidates({
  issueText: 'A None return annotation should omit conversion.',
  projectSources: crowded,
  primaryRelative: 'src/contracts.py',
  limit: 8
});
assert(annotation.some(row => row.patches.some(patch => patch.path === 'src/contracts.py'
  && patch.source.includes('not in (Signature.empty, None)'))), 'Localized sentinel proposal was crowded out.');
assert(annotation.every(row => row.patches.every(patch => !patch.path.startsWith('tests/'))));

// Regression: display-case issue labels should expose lowercase parser tokens,
// and relevant member/site pairs should precede unrelated configuration literals.
const source = 'def classify(parts):\n    if parts[0] == "widget":\n        return True\n    return False\n';
const fields = proposePrefixDomainCandidates({
  issueText: 'The field is missing.\nWidgets:\n    A value.\n',
  projectSources: { 'src/fields.py': source },
  primaryRelative: 'src/fields.py',
  limit: 8
});
assert(fields.some(row => row.inferredMember === 'widgets'), 'Lowercase field variant missing.');
assert(fields.every(row => row.primitive.kind === 'predicate-domain-set-edit'));
console.log(JSON.stringify({ passed: true, checks: ['localized-target-budget', 'test-source-exclusion', 'field-label-case', 'typed-primitive-binding'] }));
