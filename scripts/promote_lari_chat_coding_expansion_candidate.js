#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

delete process.env.LARI_REGISTRY_ROOT;
delete process.env.LARI_MODEL_PATH;
process.env.LARI_ALLOW_REAL_PROMOTION = '1';
process.env.LARI_DISABLE_MODEL_FALLBACKS = '1';
process.env.LARI_ALLOW_LEGACY_ROOT_MODEL = '0';

const registry = require('./lari_model_registry.js');
const runtime = require('../swarm_model_runtime.js');
const ROOT = path.resolve(__dirname, '..');
const CANDIDATE_HASH = '8e9e0003332ea03b383081410b06ddf670bbf7e0658996a7e5e95d9a17f907df';
const INCUMBENT_HASH = '824ee16a5c6eb9aece485f79a61e8e4a6772b5d31e07156a67482f9da85d9d4c';
const REGISTRY_HASH = 'ec63b3266ff03e7a32aa3d714c5ac1d75da67bd0186731e260552bb4e71c82e2';
const CANDIDATE = path.join(ROOT, 'consolidation', 'chat-coding-expansion-20260829', 'candidates', `${CANDIDATE_HASH}.json`);
const REHEARSAL = path.join(ROOT, 'consolidation', 'chat-coding-expansion-promotion-rehearsal-20260829', 'rehearsal-manifest.json');
const VALIDATION = path.join(ROOT, 'consolidation', 'chat-coding-expansion-20260829', 'validation-report-v5.json');
const CHAT_PARITY = path.join(ROOT, 'consolidation', 'chat-coding-expansion-promotion-rehearsal-20260829', 'chat-surface-parity.json');
const OUT = path.join(ROOT, 'consolidation', 'chat-coding-expansion-production-promotion-20260829');
const PREFLIGHT = path.join(OUT, 'preflight-manifest.json');
const MANIFEST = path.join(OUT, 'production-promotion-manifest.json');
const FAILURE = path.join(OUT, 'production-promotion-failure.json');
const ACTIVE_BACKUP = path.join(OUT, 'backups', `sha256-${INCUMBENT_HASH}.json`);
const REGISTRY_BACKUP = path.join(OUT, 'backups', `registry-sha256-${REGISTRY_HASH}.json`);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const assert = (value, message) => { if (!value) throw new Error(message); };
function writeExclusive(file, value) { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, `${JSON.stringify(value,null,2)}\n`, { flag:'wx' }); }
function preserve(file, backup, expected) { fs.mkdirSync(path.dirname(backup), { recursive:true }); if(!fs.existsSync(backup))fs.writeFileSync(backup,fs.readFileSync(file),{flag:'wx'}); assert(sha(backup)===expected,`Backup mismatch: ${rel(backup)}`); return {path:rel(backup),sha256:expected,bytes:fs.statSync(backup).size}; }
function state(){return {active:sha(registry.currentModelPath),registry:sha(registry.registryPath)};}
function context(){return {modelHash:CANDIDATE_HASH,autoGrow:false,kernel:{useBenchmarkSystem:false,useCapabilityGraph:true,capabilityGraph:{minScore:0},chat:{minMemoryScore:0,minRouteScore:0}}};}
function rollback(error){
  let result=null;
  if(fs.existsSync(ACTIVE_BACKUP)&&sha(registry.currentModelPath)===CANDIDATE_HASH){
    const rolled=registry.promoteLariModel(ACTIVE_BACKUP,{transaction:'automatic-rollback-chat-coding-expansion',rollback:true,rollbackTargetHash:INCUMBENT_HASH,rolledBackFromHash:CANDIDATE_HASH,externalModelCalls:0});
    result={activeHash:sha(registry.currentModelPath),exact:sha(registry.currentModelPath)===INCUMBENT_HASH,promotedAt:rolled.promotedAt};
  }
  if(!fs.existsSync(FAILURE))writeExclusive(FAILURE,{schemaVersion:1,createdAt:new Date().toISOString(),error:{message:error.message,stack:error.stack},rollback:result});
  return result;
}

function main(){
  assert(registry.registryRoot===registry.defaultRegistryRoot,'Promotion did not resolve production registry.');
  assert(!fs.existsSync(MANIFEST)&&!fs.existsSync(FAILURE),'Promotion output already exists.');
  [CANDIDATE,REHEARSAL,VALIDATION,CHAT_PARITY,registry.currentModelPath,registry.registryPath].forEach(file=>assert(fs.existsSync(file),`Missing ${rel(file)}`));
  assert(sha(CANDIDATE)===CANDIDATE_HASH,'Candidate hash mismatch.');
  assert(sha(registry.currentModelPath)===INCUMBENT_HASH,'Incumbent hash changed.');
  assert(sha(registry.registryPath)===REGISTRY_HASH,'Registry hash changed.');
  const rehearsal=read(REHEARSAL),validation=read(VALIDATION),chatParity=read(CHAT_PARITY);
  const preflightGates={exactCandidate:rehearsal.candidate?.sha256===CANDIDATE_HASH,rehearsalPassed:rehearsal.passed===true&&Object.values(rehearsal.gates||{}).every(Boolean),candidateValidationPassed:validation.passed===true&&Object.values(validation.gates||{}).every(Boolean),chatFiveSurfaceParity:chatParity.passed===true&&chatParity.rows?.length===8&&chatParity.rows.every(row=>row.sameSelection&&row.expectedRecordSelected),codingNineLanguageProof:validation.gates?.publicNineLanguageFailureLearning===true&&validation.gates?.publicOraclesUnchanged===true,externalModelCallsZero:validation.gates?.externalModelCallsZero===true&&chatParity.gates?.externalModelCallsZero===true};
  assert(Object.values(preflightGates).every(Boolean),`Preflight failed: ${JSON.stringify(preflightGates)}`);
  const backups={active:preserve(registry.currentModelPath,ACTIVE_BACKUP,INCUMBENT_HASH),registry:preserve(registry.registryPath,REGISTRY_BACKUP,REGISTRY_HASH)};
  const gitStatus=execFileSync('git',['status','--porcelain=v1','-z'],{cwd:ROOT,encoding:'utf8',windowsHide:true});
  writeExclusive(PREFLIGHT,{schemaVersion:1,kind:'lari.chat-coding-expansion.production-preflight',createdAt:new Date().toISOString(),candidate:{path:rel(CANDIDATE),sha256:CANDIDATE_HASH,bytes:fs.statSync(CANDIDATE).size},incumbent:{path:rel(registry.currentModelPath),sha256:INCUMBENT_HASH},registry:{path:rel(registry.registryPath),sha256:REGISTRY_HASH},backups,evidence:[REHEARSAL,VALIDATION,CHAT_PARITY].map(file=>({path:rel(file),sha256:sha(file)})),dirtyWorktree:{dirty:gitStatus.length>0,entries:gitStatus.split('\0').filter(Boolean).length,sha256:crypto.createHash('sha256').update(gitStatus).digest('hex')},gates:preflightGates,passed:true});
  try{
    const promoted=registry.promoteLariModel(CANDIDATE,{stage:'chat-coding-expansion-production-promotion',transaction:'hash-locked-real-production-promotion',candidateHash:CANDIDATE_HASH,candidateProvenance:rel(CANDIDATE),developmentalParentHash:'7d3b16aabeca3848d3e7b668667311ae85f2e1e99a3ec6b65ede850e08715c0a',productionIncumbentHash:INCUMBENT_HASH,preflightManifest:rel(PREFLIGHT),preflightManifestHash:sha(PREFLIGHT),rehearsalManifest:rel(REHEARSAL),rehearsalManifestHash:sha(REHEARSAL),canonicalRuntime:'sendMessageToLari -> runLariUnifiedTaskKernel',ordinaryInferenceReadOnly:true,fallbackDiscoveryDisabled:true,externalModelCalls:0});
    const afterPromotion=state();
    const rollbackPath=path.resolve(ROOT,promoted.previousModelPath);
    const beforeInference=state();
    const loaded=registry.loadLariModel();
    const chat=runtime.sendMessageToLari(clone(loaded.model),'Explain this unfamiliar mechanism at three levels with one concrete example.',context());
    const diagnostic=runtime.sendMessageToLari(clone(loaded.model),'Describe the safest diagnostic sequence when a small code change causes an existing test to fail.',context());
    const afterInference=state();
    const resolved=registry.resolveLariModelPath(),candidates=registry.listLariModelCandidates();
    const gates={exactCandidateActivated:afterPromotion.active===CANDIDATE_HASH,registryManifestExact:read(registry.registryPath).activeModelSha256===CANDIDATE_HASH,exactRollbackTarget:fs.existsSync(rollbackPath)&&sha(rollbackPath)===INCUMBENT_HASH,contentAddressedBackupsExact:sha(ACTIVE_BACKUP)===INCUMBENT_HASH&&sha(REGISTRY_BACKUP)===REGISTRY_HASH,lineageIncumbentExact:promoted.metadata?.productionIncumbentHash===INCUMBENT_HASH,candidateProvenanceExact:promoted.metadata?.candidateProvenance===rel(CANDIDATE),registryOnly:resolved.source==='registry'&&candidates.length===1&&candidates[0].id==='canonical-current',chatRecordActive:chat.passed===true&&chat.modelHash===CANDIDATE_HASH&&chat.learnedRecordIds?.includes('lari.learned.procedure.chat.expansion.explanation_ladder'),diagnosticRoutingFixed:diagnostic.passed===true&&diagnostic.action==='chat'&&diagnostic.learnedRecordIds?.includes('lari.learned.procedure.chat.2f21b786'),immediateInferenceReadOnly:JSON.stringify(beforeInference)===JSON.stringify(afterInference),externalModelCallsZero:Number(chat.external_model_calls||0)===0&&Number(diagnostic.external_model_calls||0)===0};
    assert(Object.values(gates).every(Boolean),`Immediate validation failed: ${JSON.stringify(gates)}`);
    const manifest={schemaVersion:1,kind:'lari.chat-coding-expansion.production-promotion',createdAt:new Date().toISOString(),passed:true,candidate:{path:rel(CANDIDATE),sha256:CANDIDATE_HASH},incumbent:{sha256:INCUMBENT_HASH,registrySha256:REGISTRY_HASH},promoted:{activePath:rel(registry.currentModelPath),activeSha256:afterPromotion.active,registryPath:rel(registry.registryPath),registrySha256:afterPromotion.registry,promotedAt:promoted.promotedAt},rollback:{registryBackupPath:rel(rollbackPath),registryBackupSha256:sha(rollbackPath),contentAddressedBackups:backups},inference:{chatRecordIds:chat.learnedRecordIds,diagnosticRecordIds:diagnostic.learnedRecordIds,modelHash:chat.modelHash,readOnly:gates.immediateInferenceReadOnly},gates,status:'promotion_succeeded',externalModelCalls:0};
    writeExclusive(MANIFEST,manifest);console.log(JSON.stringify(manifest,null,2));
  }catch(error){const result=rollback(error);if(result)assert(result.exact,'Automatic rollback was not exact.');throw error;}
}
main();
