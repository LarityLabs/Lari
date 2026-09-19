#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-20260830');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const ACTIVE_HASH = '172c07d0fb235720bfdcf11cfeb5d12bb2c8c2d9dd8c6264042cef1dbbec04f4';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const write = (name, value) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

function main() {
  if (shaFile(ACTIVE) !== ACTIVE_HASH) throw new Error('Active production hash changed before sealing.');
  if (fs.existsSync(OUT)) throw new Error('Domain-neurogenesis curriculum is already sealed.');
  fs.mkdirSync(OUT, { recursive: false });
  const createdAt = new Date().toISOString();
  const publicCurriculum = {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis.public-development',
    createdAt,
    parentHash: ACTIVE_HASH,
    rules: {
      hiddenDataAvailableToLearner: false,
      researchMayProposeButNotProve: true,
      canonicalRecordTypes: ['knowledge', 'procedure', 'repair', 'operator', 'generator', 'preference'],
      automaticProductionPromotion: false,
      rawPromptRetention: false
    },
    cases: [
      {
        id: 'generator.teaching_analogy', targetType: 'generator', capability: 'teaching analogy',
        failureClass: 'unsupported conversational construction',
        researchSources: [{ title: 'analogy teaching note', text: 'A grounded teaching analogy names the target, the familiar analogue, their shared relation, and the boundary where the analogy stops.' }],
        demonstrations: [
          {
            prompt: 'Teach cache invalidation using a library checkout. Shared relation: both track whether a resource is currently available. Boundary: software cache entries do not require a person to return a physical object.',
            claims: { topic: 'cache invalidation', analogue: 'a library checkout', shared: 'both track whether a resource is currently available', boundary: 'software cache entries do not require a person to return a physical object' },
            response: 'Think of cache invalidation like a library checkout: both track whether a resource is currently available. The analogy stops here: software cache entries do not require a person to return a physical object.'
          },
          {
            prompt: 'Teach transaction rollback using an undo history. Shared relation: both restore an earlier accepted state after an unwanted change. Boundary: a database rollback also preserves transactional consistency rules.',
            claims: { topic: 'transaction rollback', analogue: 'an undo history', shared: 'both restore an earlier accepted state after an unwanted change', boundary: 'a database rollback also preserves transactional consistency rules' },
            response: 'Think of transaction rollback like an undo history: both restore an earlier accepted state after an unwanted change. The analogy stops here: a database rollback also preserves transactional consistency rules.'
          }
        ]
      },
      {
        id: 'knowledge.source_backed_definition', targetType: 'knowledge', capability: 'source backed definition',
        failureClass: 'no retained proposition supports the question',
        source: { title: 'Aster Vale manual', url: 'local://aster-vale-manual', text: 'Aster Vale is a local graph toolkit.' },
        topic: 'Aster Vale'
      },
      {
        id: 'procedure.evidence_triage', targetType: 'procedure', capability: 'evidence triage',
        failureClass: 'no reusable workflow for uncertain evidence',
        successfulTraces: [['inspect', 'isolate', 'verify'], ['inspect', 'isolate', 'verify']]
      },
      {
        id: 'repair.reference_ambiguity', targetType: 'repair', capability: 'reference ambiguity repair',
        failureClass: 'ambiguous reference could alter the wrong target',
        procedure: ['detect_ambiguity', 'ask_for_referent', 'resume_with_confirmed_target']
      },
      {
        id: 'operator.researched_floor_division', targetType: 'operator', capability: 'researched floor division repair',
        failureClass: 'multiplication used where integer halving was required',
        researchSources: [
          { title: 'integer arithmetic guide', text: 'Use `//` instead of `*` when an integer value must be halved.' },
          { title: 'division repair note', text: 'Replace `*` with `//` for this integer-halving defect.' }
        ],
        brokenSource: 'def half(total):\n    return total * 2\n',
        expectedSource: 'def half(total):\n    return total // 2\n'
      },
      {
        id: 'preference.faithful_concision', targetType: 'preference', capability: 'faithful concise search report',
        failureClass: 'user correction requests a reusable expression change',
        userScope: 'sealed-user',
        claim: { type: 'search_cost', values: { verifications: 42, candidateCount: 188, budget: 640 } },
        correction: 'Took 42 tries out of 188, budget was 640.'
      }
    ]
  };
  const hidden = {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis.hidden-holdouts',
    createdAt,
    parentHash: ACTIVE_HASH,
    cases: [
      { id: 'generator.1', targetType: 'generator', prompt: 'Teach dependency injection using a tool cabinet. Shared relation: both provide a needed resource from outside the worker. Boundary: software dependencies can have lifecycles and interfaces.', expectedFamily: 'teaching_analogy', claims: ['dependency injection', 'a tool cabinet', 'both provide a needed resource from outside the worker', 'software dependencies can have lifecycles and interfaces'] },
      { id: 'generator.2', targetType: 'generator', prompt: 'Teach a message queue using a deli ticket line. Shared relation: both preserve work until a consumer is ready. Boundary: distributed queues must handle retries and duplicate delivery.', expectedFamily: 'teaching_analogy', claims: ['a message queue', 'a deli ticket line', 'both preserve work until a consumer is ready', 'distributed queues must handle retries and duplicate delivery'] },
      { id: 'generator.3', targetType: 'generator', prompt: 'Teach version control using a laboratory notebook. Shared relation: both preserve an ordered history of changes. Boundary: version control can merge changes from multiple authors.', expectedFamily: 'teaching_analogy', claims: ['version control', 'a laboratory notebook', 'both preserve an ordered history of changes', 'version control can merge changes from multiple authors'] },
      { id: 'knowledge.1', targetType: 'knowledge', prompt: 'What do you know about Aster Vale?', expected: ['Aster Vale', 'local graph toolkit'] },
      { id: 'knowledge.2', targetType: 'knowledge', prompt: 'Explain Aster Vale.', expected: ['Aster Vale', 'local graph toolkit'] },
      { id: 'knowledge.3', targetType: 'knowledge', prompt: 'Tell me about Aster Vale.', expected: ['Aster Vale', 'local graph toolkit'] },
      { id: 'procedure.1', targetType: 'procedure', input: { evidence: ['claim-a', 'claim-b'] }, expectedTrace: ['inspect', 'isolate', 'verify'] },
      { id: 'procedure.2', targetType: 'procedure', input: { evidence: ['conflict-a'] }, expectedTrace: ['inspect', 'isolate', 'verify'] },
      { id: 'procedure.3', targetType: 'procedure', input: { evidence: [] }, expectedTrace: ['inspect', 'isolate', 'verify'] },
      { id: 'repair.1', targetType: 'repair', ambiguity: true, expectedProcedure: ['detect_ambiguity', 'ask_for_referent', 'resume_with_confirmed_target'] },
      { id: 'repair.2', targetType: 'repair', ambiguity: true, expectedProcedure: ['detect_ambiguity', 'ask_for_referent', 'resume_with_confirmed_target'] },
      { id: 'repair.3', targetType: 'repair', ambiguity: true, expectedProcedure: ['detect_ambiguity', 'ask_for_referent', 'resume_with_confirmed_target'] },
      { id: 'operator.1', targetType: 'operator', brokenSource: 'def half(count):\n    return count * 2\n', expectedSource: 'def half(count):\n    return count // 2\n' },
      { id: 'operator.2', targetType: 'operator', brokenSource: 'def half(items):\n    return items * 2\n', expectedSource: 'def half(items):\n    return items // 2\n' },
      { id: 'operator.3', targetType: 'operator', brokenSource: 'def half(score):\n    return score * 2\n', expectedSource: 'def half(score):\n    return score // 2\n' },
      { id: 'preference.1', targetType: 'preference', claim: { type: 'search_cost', values: { verifications: 7, candidateCount: 31, budget: 90 } }, expected: 'Took 7 tries out of 31, budget was 90.' },
      { id: 'preference.2', targetType: 'preference', claim: { type: 'search_cost', values: { verifications: 11, candidateCount: 54, budget: 120 } }, expected: 'Took 11 tries out of 54, budget was 120.' },
      { id: 'preference.3', targetType: 'preference', claim: { type: 'search_cost', values: { verifications: 3, candidateCount: 19, budget: 50 } }, expected: 'Took 3 tries out of 19, budget was 50.' }
    ]
  };
  const publicBytes = Buffer.from(`${JSON.stringify(publicCurriculum, null, 2)}\n`);
  const hiddenBytes = Buffer.from(`${JSON.stringify(hidden, null, 2)}\n`);
  write('public-development.json', publicCurriculum);
  write('hidden-holdouts.json', hidden);
  write('sealed-index.json', {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis.seal',
    createdAt,
    parentHash: ACTIVE_HASH,
    publicDevelopment: { path: 'public-development.json', sha256: sha(publicBytes), cases: publicCurriculum.cases.length },
    hiddenHoldouts: { path: 'hidden-holdouts.json', sha256: sha(hiddenBytes), cases: hidden.cases.length, learnerReadable: false },
    requiredLifecycle: ['baseline_failure', 'gap', 'research_or_experiment', 'typed_candidate', 'visible_proof', 'hidden_transfer', 'semantic_faithfulness', 'reload', 'ablation', 'rollback'],
    productionMutationAllowed: false
  });
  process.stdout.write(`${JSON.stringify({ sealed: true, output: path.relative(ROOT, OUT).replace(/\\/g, '/'), publicHash: sha(publicBytes), hiddenHash: sha(hiddenBytes), publicCases: publicCurriculum.cases.length, hiddenCases: hidden.cases.length }, null, 2)}\n`);
}

main();
