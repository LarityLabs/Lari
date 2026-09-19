#!/usr/bin/env node
'use strict';

/* Focused unit checks for the generic case-identity primitive.  This is not a
 * benchmark: it uses a tiny synthetic source solely to ensure that the
 * proposal/retention guards cannot silently widen into presentation edits. */

const assert = require('assert');
const repair = require('../swarm_mutation_repair.js');
const research = require('../swarm_research_to_capability.js');
const runtime = require('../swarm_model_runtime.js');

const issue = 'A duplicate term with a different case must remain distinct at the identity key.';
const source = [
  'def register(termtext, node_id):',
  '    registry.note_object("term", termtext.lower(), node_id)',
  '    return registry'
].join('\n');
const sources = { 'package/registry.py': source };
const candidates = repair.proposeCaseIdentityCandidates({
  issueText: issue,
  projectSources: sources,
  primaryRelative: 'package/registry.py'
});
assert.strictEqual(candidates.length, 1, 'explicit semantic case distinction should produce one bounded candidate');
assert.strictEqual(repair.proposeCaseIdentityCandidates({
  issueText: 'Parameter names are case-sensitive semantic identities and must remain distinct.',
  projectSources: sources,
  primaryRelative: 'package/registry.py'
}).length, 1, 'ordinary plural identity language must retain the same semantic trigger');
assert.deepStrictEqual(candidates[0].primitive, {
  kind: 'case-normalization-policy',
  matcher: 'semantic_identity_key',
  composition: 'preserve_case_distinction'
});
assert.ok(!candidates[0].patches[0].source.includes('.lower()'), 'candidate must remove only the identity-key normalizer');
assert.strictEqual(repair.proposeCaseIdentityCandidates({
  issueText: 'Normalize a display label to lowercase.',
  projectSources: sources,
  primaryRelative: 'package/registry.py'
}).length, 0, 'presentation normalization must not create a semantic-identity candidate');

const officialEvidence = [{
  title: 'Python standard library: string case methods',
  url: 'https://docs.python.org/3/library/stdtypes.html#string-methods',
  sourceType: 'official_library_reference',
  text: 'str.lower() Return a copy of the string with all cased characters converted to lowercase.'
}];
const proposal = research.extractCaseNormalizationProposal(officialEvidence, issue);
assert.strictEqual(proposal.proposed, true, 'official evidence plus semantic failure evidence should only propose the primitive');
assert.deepStrictEqual(proposal.primitive, candidates[0].primitive);
assert.strictEqual(research.extractCaseNormalizationProposal(officialEvidence, 'Convert this display to lowercase.').proposed, false, 'documentation alone cannot decide policy');
assert.strictEqual(research.extractCaseNormalizationProposal([{
  title: 'untrusted note', url: 'https://example.invalid/note', sourceType: 'blog', text: officialEvidence[0].text
}], issue).proposed, false, 'non-authoritative evidence cannot unlock the primitive');

const model = { lariLearnedRecords: { schemaVersion: 1, records: [] } };
const retained = runtime.retainLariSemanticMutationPrimitive(model, {
  primitive: proposal.primitive,
  modelHash: 'candidate-parent-hash',
  sourcePath: 'candidate-only-source',
  researchCitation: proposal.citation
});
assert.ok(retained, 'verified runtime retention must accept the typed primitive');
assert.deepStrictEqual(retained.payload.primitive, proposal.primitive);
assert.strictEqual(retained.provenance.creationSource, 'research_proposed_failure_induced_semantic_primitive_neurogenesis');
assert.deepStrictEqual(retained.provenance.researchSources, [{
  title: 'Python standard library: string case methods',
  url: 'https://docs.python.org/3/library/stdtypes.html#string-methods',
  sourceType: 'official_library_reference'
}]);
const retainedJson = JSON.stringify(retained);
assert.ok(!/package\/registry\.py|TERM2|sphinx/i.test(retainedJson), 'retained primitive must not carry task-specific source or expected-answer content');

process.stdout.write('case identity semantic primitive checks passed\n');
