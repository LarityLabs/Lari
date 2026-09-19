#!/usr/bin/env node
'use strict';
const crypto=require('crypto'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'consolidation','sealed-cumulative-apprenticeship-20260913');
const TASKS=path.join(OUT,'tasks.json'),SEAL=path.join(OUT,'seal.json');
const CANDIDATE=path.join(ROOT,'consolidation','one-hour-apprenticeship-sprint-20260913','candidates','11bdeeacf3a605cf5959d8ddc6cc980848c98e2ad1025c0034c7c55e7d16cb77.json');
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
if(fs.existsSync(SEAL))throw new Error('Refusing to overwrite immutable seal.');
const tasks=JSON.parse(fs.readFileSync(TASKS,'utf8'));
if(sha(CANDIDATE)!==tasks.startingCandidateSha256)throw new Error('Starting candidate hash mismatch.');
const runtimeFiles=['swarm_model_runtime.js','swarm_domain_neurogenesis.js','swarm_external_tools.js'];
const publicTasks=tasks.tasks.map(({visible,hidden,...task})=>task);
const hiddenCommitments=tasks.tasks.map(task=>({id:task.id,visibleSha256:crypto.createHash('sha256').update(JSON.stringify(task.visible??null)).digest('hex'),hiddenSha256:crypto.createHash('sha256').update(JSON.stringify(task.hidden??null)).digest('hex')}));
const seal={schemaVersion:1,kind:'lari.sealed-cumulative-apprenticeship.seal',createdAt:new Date().toISOString(),startingCandidate:{path:path.relative(ROOT,CANDIDATE).replace(/\\/g,'/'),sha256:sha(CANDIDATE)},tasks:{path:path.relative(ROOT,TASKS).replace(/\\/g,'/'),sha256:sha(TASKS),count:tasks.tasks.length,publicTasks,hiddenCommitments},runtime:Object.fromEntries(runtimeFiles.map(file=>[file,sha(path.join(ROOT,file))])),rules:['No runtime modification after sealing.','Learning sees visible tests only.','Hidden variants run discovery-disabled.','Reload and cumulative replay follow every coding acquisition.','No production or registry writes.','No external model calls.']};
fs.writeFileSync(SEAL,`${JSON.stringify(seal,null,2)}\n`,{flag:'wx'});
console.log(JSON.stringify({sealed:true,sealSha256:sha(SEAL),startingCandidate:seal.startingCandidate.sha256,taskCount:tasks.tasks.length,runtime:seal.runtime},null,2));
