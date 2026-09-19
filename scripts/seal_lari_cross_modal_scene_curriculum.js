#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const OUT = path.join(ROOT, 'consolidation', 'cross-modal-scene-20260906');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

if (fs.existsSync(OUT)) throw new Error(`Refusing to overwrite sealed curriculum: ${rel(OUT)}`);
const createdAt = new Date().toISOString();
const parentHash = shaFile(ACTIVE);
fs.mkdirSync(OUT, { recursive: false });

const scene = {
  entities: [
    { id: 'hero', kind: 'character', role: 'subject' },
    { id: 'moon', kind: 'celestial', role: 'light' },
    { id: 'water', kind: 'environment', role: 'motion' }
  ],
  relations: [
    { type: 'illuminates', from: 'moon', to: 'hero' },
    { type: 'reflects', from: 'water', to: 'moon' },
    { type: 'centers', from: 'hero', to: 'water' }
  ],
  imageElements: ['character', 'moon', 'stars', 'waves', 'rubberhose'],
  audioFeatures: ['melody', 'bass', 'percussion', 'harmony', 'loop'],
  mood: 'dark reflective night',
  timing: { durationSeconds: 2.4 }
};
const publicDevelopment = {
  schemaVersion: 1,
  kind: 'lari.cross-modal-scene.public-development',
  createdAt,
  parentHash,
  rules: {
    target: 'one typed scene program shared by existing image and audio executors',
    existingSceneRecordMustBeAbsentBeforeLearning: true,
    rawPromptRetention: false,
    automaticProductionPromotion: false,
    externalModelCallsAllowed: false
  },
  capability: 'shared cross-modal scene semantics',
  failureClass: 'no retained typed record binds the same entities, relations, mood, and timing to image and audio output',
  sceneDemonstrations: [
    { id: 'ordered_scene', scene },
    { id: 'reordered_scene', scene: { ...scene, entities: [...scene.entities].reverse(), relations: [...scene.relations].reverse(), imageElements: [...scene.imageElements].reverse(), audioFeatures: [...scene.audioFeatures].reverse() } }
  ]
};
const hiddenHoldouts = {
  schemaVersion: 1,
  kind: 'lari.cross-modal-scene.hidden-holdouts',
  createdAt,
  parentHash,
  cases: [
    {
      id: 'paraphrase_ocean_night',
      request: {
        title: 'Night over water',
        prompt: 'A quiet night scene with a central traveler under moonlight over moving water.',
        requiredLanes: ['image', 'audio'],
        requiredImageElements: scene.imageElements,
        requiredAudioFeatures: scene.audioFeatures,
        durationSeconds: scene.timing.durationSeconds,
        minBytes: 1000
      }
    },
    {
      id: 'paraphrase_reflective_scene',
      request: {
        title: 'Reflective crossing',
        prompt: 'Render a dark reflective crossing: the hero is lit by the moon and the waves carry a looping theme.',
        requiredLanes: ['image', 'audio'],
        requiredImageElements: scene.imageElements,
        requiredAudioFeatures: scene.audioFeatures,
        durationSeconds: scene.timing.durationSeconds,
        minBytes: 1000
      }
    },
    {
      id: 'paraphrase_minimal_prompt',
      request: {
        title: 'Shared scene variant',
        prompt: 'Make the same shared scene in a new presentation.',
        requiredLanes: ['image', 'audio'],
        requiredImageElements: scene.imageElements,
        requiredAudioFeatures: scene.audioFeatures,
        durationSeconds: scene.timing.durationSeconds,
        minBytes: 1000
      }
    }
  ]
};
const publicBytes = Buffer.from(`${JSON.stringify(publicDevelopment, null, 2)}\n`);
const hiddenBytes = Buffer.from(`${JSON.stringify(hiddenHoldouts, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'public-development.json'), publicBytes, { flag: 'wx' });
fs.writeFileSync(path.join(OUT, 'hidden-holdouts.json'), hiddenBytes, { flag: 'wx' });
write(path.join(OUT, 'sealed-index.json'), {
  schemaVersion: 1,
  kind: 'lari.cross-modal-scene.seal',
  createdAt,
  parentHash,
  publicDevelopment: { path: 'public-development.json', sha256: sha(publicBytes), cases: publicDevelopment.sceneDemonstrations.length },
  hiddenHoldouts: { path: 'hidden-holdouts.json', sha256: sha(hiddenBytes), cases: hiddenHoldouts.cases.length, learnerReadable: false },
  requiredLifecycle: ['baseline_failure', 'typed_scene_candidate', 'image_binding', 'audio_binding', 'hidden_transfer', 'reload', 'exact_record_ablation', 'family_regression'],
  productionMutationAllowed: false
});
console.log(JSON.stringify({ sealed: true, output: rel(OUT), parentHash, publicHash: sha(publicBytes), hiddenHash: sha(hiddenBytes) }, null, 2));
