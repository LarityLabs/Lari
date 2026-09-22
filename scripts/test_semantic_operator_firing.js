#!/usr/bin/env node
/**
 * Per-record firing test for the 23 merged semantic operators.
 *
 * For each active record in model.learned_semantic_operators, sends a probe
 * sentence built from THAT record's own markers + surface order (novel
 * vocabulary, no borrowed words) through the real chat path
 * (sendMessageToLariAsync) on a scratch model copy, and checks whether the
 * response's semanticOperator fired with the target record's id.
 *
 * Honest outcomes per record:
 *   FIRED      - winner operatorId === target record id
 *   SHADOWED   - some operator fired, but a different record won
 *   SILENT     - no operator fired at all
 *
 * Never mutates the live model (scratch copy) and never touches the live
 * research store (probes are plain statements, no research triggered).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
const BASE_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const SCRATCH = path.join(process.env.HOME || '/root', 'workspace', 'scratch', 'lari-operator-firing');
fs.mkdirSync(SCRATCH, { recursive: true });

const TURN_TIMEOUT_MS = 60000;

// Probe per record id suffix: [probe sentence, why it should fire this record]
const PROBES = {
  'cause.ad0aa57e': ['Because the glacier calved, the fjord echoed.', 'because marker_first'],
  'contrast.74e687d2': ['Although the kiln was cold, the glaze set.', 'although marker_first'],
  'condition.31962536': ['If the kiln cools slowly, the glaze will harden.', 'if marker_first'],
  'cause.c7b49745': ['The fjord echoed because the glacier calved.', 'because marker_mid'],
  'contrast.745fcf8f': ['The kiln was cold but the glaze set.', 'but marker_mid'],
  'contrast.a0a5ed91': ['While the storm raged, the lighthouse held.', 'while marker_first concessive'],
  'counterfactual.11528949': ['If the kiln had cooled faster, the glaze would have cracked.', 'if marker_first counterfactual'],
  'counterfactual.7127d928': ['The glaze would have cracked if the kiln had cooled faster.', 'if marker_mid counterfactual'],
  'condition.766abbed': ['The glaze will crack unless the kiln cools slowly.', 'unless marker_mid'],
  'purpose.ed1bae51': ['To seal the glaze, the potter raised the heat.', 'to marker_first'],
  'purpose.4f539685': ['In order to seal the glaze, the potter raised the heat.', 'in order to marker_first'],
  'purpose.07fb8fb8': ['The potter raised the heat to seal the glaze.', 'to marker_mid'],
  'purpose.36603372': ['The potter raised the heat in order to seal the glaze.', 'in order to marker_mid'],
  'purpose.7899e455': ['The potter raised the heat so that the glaze would seal.', 'so that marker_mid'],
  'concession.c639ddd2': ['Despite the cold kiln, the glaze set.', 'despite marker_first'],
  'concession.716c7bb5': ['The glaze set despite the cold kiln.', 'despite marker_mid'],
  'disc_than.522380c1': ['The glaze is glossier than the raw clay.', 'than marker_mid'],
  'disc_admittedly.6cd64cf3': ['Admittedly the glaze ran hot, the finish still gleamed.', 'admittedly marker_first'],
  'disc_after.2c03ce6c': ['After the firing, the glaze gleamed.', 'after marker_first'],
  'disc_before.df6f5681': ['Before the firing, the clay looked dull.', 'before marker_first'],
  'disc_prevented.5d474cb7': ['The damper prevented a flare-up in the kiln.', 'prevented marker_mid'],
  'disc_hence.2467aaa3': ['Hence the kiln cooled fast, the glaze crackled.', 'hence marker_first'],
  'disc_nevertheless.8912aad6': ['Nevertheless the kiln overheated, the glaze held.', 'nevertheless marker_first'],
};

function freshModel() {
  const dst = path.join(SCRATCH, `model-${process.pid}-${Date.now()}.json`);
  const m = JSON.parse(fs.readFileSync(BASE_MODEL, 'utf8'));
  m.__lariSourcePath = dst;
  fs.writeFileSync(dst, JSON.stringify(m));
  return JSON.parse(fs.readFileSync(dst, 'utf8'));
}

async function turn(model, text) {
  const p = runtime.sendMessageToLariAsync(model, text, {});
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), TURN_TIMEOUT_MS));
  return Promise.race([p, timeout]);
}

const suffixOf = (id) => String(id).split('.').slice(-2).join('.');

(async () => {
  const model = freshModel();
  const section = model.learned_semantic_operators;
  const entries = (Array.isArray(section.entries) ? section.entries : Object.values(section.entries || {}))
    .filter(r => r && r.status === 'active');
  console.log(`active operator records: ${entries.length}`);

  let fired = 0, shadowed = 0, silent = 0, missing = 0;
  const rows = [];
  for (const rec of entries) {
    const suf = suffixOf(rec.id);
    const probe = PROBES[suf];
    if (!probe) { missing++; rows.push({ suf, outcome: 'NO-PROBE', detail: 'no probe defined' }); continue; }
    let outcome = 'SILENT', detail = 'no operator fired';
    try {
      const r = await turn(model, probe[0]);
      const op = r && (r.semanticOperator || (r.semanticInduction && r.semanticInduction.fired)) || null;
      if (op && op.operatorId) {
        if (op.operatorId === rec.id) { outcome = 'FIRED'; fired++; }
        else { outcome = 'SHADOWED'; shadowed++; }
        detail = `${op.relation} via ${suffixOf(op.operatorId)} marker=${op.marker}`;
      } else { silent++; }
    } catch (e) { outcome = 'ERROR'; detail = e.message; }
    rows.push({ suf, probe: probe[0], outcome, detail });
    console.log(`[${outcome}] ${suf} :: ${detail}`);
  }

  console.log('--------------------------------------------------------------');
  console.log(`FIRED ${fired}/${entries.length}  SHADOWED ${shadowed}  SILENT ${silent}  NO-PROBE ${missing}`);
  const rels = new Set(rows.filter(r => r.outcome === 'FIRED').map(r => r.suf.split('.')[0]));
  console.log(`relations with >=1 firing record: ${[...rels].join(', ')}`);
  if (fired + shadowed + silent + missing !== entries.length) process.exitCode = 1;
})().catch(e => { console.error('firing test error:', e); process.exit(2); });
