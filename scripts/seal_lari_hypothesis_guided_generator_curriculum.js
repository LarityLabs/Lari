#!/usr/bin/env node
'use strict';

// Seals one narrow developmental experiment: learn a discourse generator that
// faithfully explains an observation through two supplied competing hypotheses
// and a supplied discriminating check.  This is deliberately not an open-ended
// reasoning claim—the oracle can assess claim/relation preservation, not truth.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const OUT = path.join(ROOT, 'consolidation', 'hypothesis-guided-generator-20260906');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

function write(name, value) {
  fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function main() {
  if (fs.existsSync(OUT)) throw new Error(`Refusing to overwrite sealed curriculum: ${rel(OUT)}`);
  const createdAt = new Date().toISOString();
  const parentHash = shaFile(ACTIVE);
  fs.mkdirSync(OUT, { recursive: false });

  const publicDevelopment = {
    schemaVersion: 1,
    kind: 'lari.hypothesis-guided-generator.public-development',
    createdAt,
    parentHash,
    rules: {
      target: 'structured competing-hypothesis discourse only',
      existingGeneratorMustFailBeforeLearning: true,
      hiddenHoldoutsAvailableToLearner: false,
      rawPromptRetention: false,
      expectedAnswerRetention: false,
      automaticProductionPromotion: false,
      externalModelCallsAllowed: false
    },
    capability: 'competing hypothesis discourse',
    failureClass: 'no retained generator realizes a supplied observation, alternatives, and discriminating check as one faithful analysis',
    relations: [
      { type: 'competes_with', from: 'hypothesisA', to: 'hypothesisB' },
      { type: 'explains', from: 'hypothesisA', to: 'observation' },
      { type: 'explains', from: 'hypothesisB', to: 'observation' },
      { type: 'discriminated_by', from: 'test', to: 'hypothesisA' },
      { type: 'discriminated_by', from: 'test', to: 'hypothesisB' }
    ],
    demonstrations: [
      {
        prompt: 'Observation: requests fail only when the worker pool closes. Hypothesis A: the worker exits before draining the queue. Hypothesis B: the caller sends an invalid request. Discriminating check: replay a valid request while keeping the pool open.',
        claims: {
          observation: 'requests fail only when the worker pool closes',
          hypothesisA: 'the worker exits before draining the queue',
          hypothesisB: 'the caller sends an invalid request',
          test: 'replay a valid request while keeping the pool open'
        },
        response: 'The observation is requests fail only when the worker pool closes. Two competing hypotheses are the worker exits before draining the queue and the caller sends an invalid request. Run replay a valid request while keeping the pool open because it distinguishes the hypotheses.'
      },
      {
        prompt: 'Hypothesis B: cache data was written after the response. Discriminating check: compare a request trace before and after moving the write. Observation: clients see stale data after a successful update. Hypothesis A: invalidation ran before the write committed.',
        claims: {
          observation: 'clients see stale data after a successful update',
          hypothesisA: 'invalidation ran before the write committed',
          hypothesisB: 'cache data was written after the response',
          test: 'compare a request trace before and after moving the write'
        },
        response: 'The observation is clients see stale data after a successful update. Two competing hypotheses are invalidation ran before the write committed and cache data was written after the response. Run compare a request trace before and after moving the write because it distinguishes the hypotheses.'
      },
      {
        prompt: 'Discriminating check: run the same job with a bounded input and inspect the peak allocation. Hypothesis A: a retained buffer grows with every job. Observation: memory use rises after each completed job. Hypothesis B: the input itself is larger on later jobs.',
        claims: {
          observation: 'memory use rises after each completed job',
          hypothesisA: 'a retained buffer grows with every job',
          hypothesisB: 'the input itself is larger on later jobs',
          test: 'run the same job with a bounded input and inspect the peak allocation'
        },
        response: 'The observation is memory use rises after each completed job. Two competing hypotheses are a retained buffer grows with every job and the input itself is larger on later jobs. Run run the same job with a bounded input and inspect the peak allocation because it distinguishes the hypotheses.'
      }
    ]
  };

  const hiddenHoldouts = {
    schemaVersion: 1,
    kind: 'lari.hypothesis-guided-generator.hidden-holdouts',
    createdAt,
    parentHash,
    cases: [
      {
        id: 'reordered_connection_failure',
        prompt: 'Hypothesis B: the service rejects the client credentials; Observation: connections fail only after a certificate rotation; Discriminating check: retry with the prior certificate in an isolated staging environment; Hypothesis A: the new certificate chain is incomplete.',
        claims: {
          observation: 'connections fail only after a certificate rotation',
          hypothesisA: 'the new certificate chain is incomplete',
          hypothesisB: 'the service rejects the client credentials',
          test: 'retry with the prior certificate in an isolated staging environment'
        }
      },
      {
        id: 'line_broken_delivery',
        prompt: 'Observation: messages are delivered twice after a worker restart.\nHypothesis A: acknowledgement state is committed after the process exits.\nDiscriminating check: stop the worker between receipt and acknowledgement, then inspect the durable offset.\nHypothesis B: two consumers share the same subscription.',
        claims: {
          observation: 'messages are delivered twice after a worker restart',
          hypothesisA: 'acknowledgement state is committed after the process exits',
          hypothesisB: 'two consumers share the same subscription',
          test: 'stop the worker between receipt and acknowledgement, then inspect the durable offset'
        }
      },
      {
        id: 'punctuation_varied_rendering',
        prompt: 'Observation: a report omits the final row after pagination. Hypothesis B: the renderer discards a partial page. Hypothesis A: the query cursor advances before the final result is emitted. Discriminating check: compare cursor values and rendered row counts on a one-page boundary.',
        claims: {
          observation: 'a report omits the final row after pagination',
          hypothesisA: 'the query cursor advances before the final result is emitted',
          hypothesisB: 'the renderer discards a partial page',
          test: 'compare cursor values and rendered row counts on a one-page boundary'
        }
      }
    ]
  };

  const publicBytes = Buffer.from(`${JSON.stringify(publicDevelopment, null, 2)}\n`);
  const hiddenBytes = Buffer.from(`${JSON.stringify(hiddenHoldouts, null, 2)}\n`);
  write('public-development.json', publicDevelopment);
  write('hidden-holdouts.json', hiddenHoldouts);
  write('sealed-index.json', {
    schemaVersion: 1,
    kind: 'lari.hypothesis-guided-generator.seal',
    createdAt,
    parentHash,
    publicDevelopment: { path: 'public-development.json', sha256: sha(publicBytes), cases: publicDevelopment.demonstrations.length },
    hiddenHoldouts: { path: 'hidden-holdouts.json', sha256: sha(hiddenBytes), cases: hiddenHoldouts.cases.length, learnerReadable: false },
    requiredLifecycle: ['baseline_failure', 'typed_competing_hypotheses', 'candidate_generator', 'semantic_faithfulness', 'hidden_transfer', 'reload', 'exact_ablation', 'family_regression', 'rollback_rehearsal'],
    productionMutationAllowed: false
  });
  process.stdout.write(`${JSON.stringify({
    sealed: true,
    output: rel(OUT),
    parentHash,
    publicHash: sha(publicBytes),
    hiddenHash: sha(hiddenBytes)
  }, null, 2)}\n`);
}

main();
