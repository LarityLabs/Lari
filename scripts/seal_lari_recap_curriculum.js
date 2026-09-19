#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'recap-minimal-20260830');
const SEAL = path.join(OUT, 'sealed-curriculum.json');
const PARENT_HASH = '6b0099f28d6c4d879fc5ea3b8d43994d8df199ef5a8e5cd68ee6592bec36369b';
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const curriculum = {
  schemaVersion: 1,
  kind: 'lari.recap-minimal.sealed-curriculum',
  sealedAt: new Date().toISOString(),
  parentHash: PARENT_HASH,
  thesis: 'Executable language generation must be composed from canonical typed learned records, with claim grounding, causal ablation, persistence, and no external model calls.',
  scope: {
    provenLane: 'bounded causal explanation with explicit effect, cause, evidence, and next action',
    excludedClaims: ['unrestricted natural-language generation', 'token prediction', 'general prose mastery', 'external model inference']
  },
  train: [
    {
      id: 'queue_shutdown',
      prompt: 'Explain why the worker stopped: the queue closed before the final write. Evidence shows the shutdown event precedes the last persistence event. Next: keep the queue open until pending writes finish.',
      claims: ['the worker stopped', 'the queue closed before the final write', 'the shutdown event precedes the last persistence event', 'keep the queue open until pending writes finish']
    }
  ],
  hidden: [
    {
      id: 'cache_stale',
      prompt: 'Please explain why the cache stayed stale: invalidation ran before the transaction committed. The evidence indicates the refresh log has the old version number. Next action: trigger invalidation after commit.',
      claims: ['the cache stayed stale', 'invalidation ran before the transaction committed', 'the refresh log has the old version number', 'trigger invalidation after commit']
    },
    {
      id: 'audio_gap',
      prompt: 'Explain why playback contains a gap: the second buffer arrived after the first buffer drained. Logs show a 140 millisecond interval with no queued samples. Recommend: prebuffer the next segment before starting playback.',
      claims: ['playback contains a gap', 'the second buffer arrived after the first buffer drained', 'a 140 millisecond interval with no queued samples', 'prebuffer the next segment before starting playback']
    },
    {
      id: 'uncertain_lock',
      prompt: 'Explain why the request stalled: lock inversion may have blocked both workers. Evidence shows each worker waited for the lock held by the other. Next: enforce one lock acquisition order.',
      claims: ['the request stalled', 'lock inversion may have blocked both workers', 'each worker waited for the lock held by the other', 'enforce one lock acquisition order']
    },
    {
      id: 'schema_loss',
      prompt: 'Explain why the migrated row lost its label: the serializer omitted the renamed field. Evidence is: the pre-migration object has display_name while the written row has neither display_name nor label. Next: map display_name to label before serialization.',
      claims: ['the migrated row lost its label', 'the serializer omitted the renamed field', 'the pre-migration object has display_name while the written row has neither display_name nor label', 'map display_name to label before serialization']
    },
    {
      id: 'render_flicker',
      prompt: 'Explain why the panel flickers: two render passes publish conflicting visibility state. The logs indicate visible and hidden commits in the same frame. Next action: coalesce visibility updates before commit.',
      claims: ['the panel flickers', 'two render passes publish conflicting visibility state', 'visible and hidden commits in the same frame', 'coalesce visibility updates before commit']
    }
  ],
  requiredOperations: [
    'recap.meaning.causal_evidence_action',
    'recap.discourse.answer_support_action',
    'recap.clause.causal',
    'recap.clause.evidence',
    'recap.clause.next_action',
    'recap.repair.claim_coverage'
  ],
  gates: [
    'baseline does not claim RECAP execution',
    'train and hidden semantic variants preserve every supplied claim',
    'zero unsupported claims',
    'every required typed record is causally necessary',
    'reload retention',
    'same candidate hash and learned-record IDs across public surfaces',
    'zero active model mutation',
    'zero external model calls',
    'existing chat and coding qualification remain intact'
  ]
};

if (fs.existsSync(SEAL)) throw new Error('RECAP curriculum is already sealed.');
if (sha(fs.readFileSync(ACTIVE)) !== PARENT_HASH) throw new Error('Unexpected active model hash; refusing to seal against the wrong parent.');
fs.mkdirSync(OUT, { recursive: true });
const bytes = Buffer.from(`${JSON.stringify(curriculum, null, 2)}\n`);
fs.writeFileSync(SEAL, bytes, { flag: 'wx' });
console.log(JSON.stringify({ path: path.relative(ROOT, SEAL).replace(/\\/g, '/'), sha256: sha(bytes), parentHash: PARENT_HASH }, null, 2));

