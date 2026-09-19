#!/usr/bin/env node
'use strict';
const crypto=require('crypto'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'consolidation','stage-5-sealed'),payloadPath=path.join(dir,'developmental-holdouts.json'),manifestPath=path.join(root,'consolidation','stage-5-developmental-holdout-manifest.json');
const expectedConcepts=['defaults','explicit','override','preserve false','preserve zero','coerce','clamp','bounds','disabled','precedence','idempotent'];
const cases=[
{id:'override-1',kind:'holdout',prompt:'Explain a reusable retry configuration resolver that starts from defaults, applies explicit overrides, preserves false and zero, and enforces safe bounds.'},
{id:'override-2',kind:'holdout',prompt:'How should a timeout policy combine default values with operator overrides, clamp invalid ranges, and make disabled behavior repeatable?'},
{id:'override-3',kind:'holdout',prompt:'Describe a worker-concurrency settings procedure where explicit override values beat defaults, numeric values are bounded, and zero is not mistaken for missing.'},
{id:'override-4',kind:'holdout',prompt:'Give the algorithm for resolving cache TTL configuration from defaults and overrides while validating bounds and proving a second resolution is unchanged.'},
{id:'override-5',kind:'holdout',prompt:'An upload-limit configuration supports defaults, an explicit disable flag, and per-user overrides. Specify deterministic precedence and range checks.'},
{id:'override-x1',kind:'cross-context',prompt:'For a feature rollout, explain how defaults and an explicit false override should resolve predictably without truthiness errors.'},
{id:'override-x2',kind:'cross-context',prompt:'For a sensor sampling interval, describe how operator overrides beat defaults, zero is preserved when valid, and out-of-range values are bounded.'}
].map(item=>({...item,expectedConcepts,minimumConceptHits:9}));
const h=value=>crypto.createHash('sha256').update(value).digest('hex'); if(fs.existsSync(payloadPath)||fs.existsSync(manifestPath))throw new Error('Override holdouts already sealed.'); fs.mkdirSync(dir,{recursive:true}); const sealedAt=new Date().toISOString(); const payload={schemaVersion:1,family:'bounded override resolution',sealedAt,cases}; fs.writeFileSync(payloadPath,`${JSON.stringify(payload,null,2)}\n`,{flag:'wx'}); const manifest={schemaVersion:1,stage:5,family:payload.family,sealedAt,sealedBeforeLearning:true,priorOccurrenceCount:0,holdoutCount:5,crossContextCount:2,cases:cases.map(item=>({id:item.id,kind:item.kind,sha256:h(JSON.stringify(item))})),sealedPayload:{path:'consolidation/stage-5-sealed/developmental-holdouts.json',sha256:h(fs.readFileSync(payloadPath))},learnerAccessPolicy:'Learner receives only the training failure and does not read this payload.'}; fs.writeFileSync(manifestPath,`${JSON.stringify(manifest,null,2)}\n`,{flag:'wx'}); console.log(JSON.stringify(manifest,null,2));
