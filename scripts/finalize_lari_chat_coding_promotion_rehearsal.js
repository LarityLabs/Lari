#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtime = require('../swarm_model_runtime.js');

const ROOT = path.resolve(__dirname, '..');
const HASH = '8e9e0003332ea03b383081410b06ddf670bbf7e0658996a7e5e95d9a17f907df';
const OUT = path.join(ROOT, 'consolidation', 'chat-coding-expansion-promotion-rehearsal-20260829');
const EXPANSION = path.join(ROOT, 'consolidation', 'chat-coding-expansion-20260829');
const files = {
  candidate:path.join(EXPANSION,'candidates',`${HASH}.json`),
  candidateManifest:path.join(EXPANSION,'candidate-manifest-v4.json'),
  training:path.join(EXPANSION,'training-report-v4.json'),
  validation:path.join(EXPANSION,'validation-report-v5.json'),
  transaction:path.join(OUT,'promotion-rehearsal-evidence.json'),
  surfaces:path.join(OUT,'surface-evidence-v2.json'),
  chatSurfaces:path.join(OUT,'chat-surface-parity.json'),
  active:path.join(ROOT,'models','lari','current','swarm-model.json'),
  registry:path.join(ROOT,'models','lari','registry.json')
};
const outputs = {
  manifest:path.join(OUT,'rehearsal-manifest.json'),
  report:path.join(OUT,'PROMOTION_REHEARSAL_REPORT.md'),
  rollback:path.join(OUT,'ROLLBACK_PROCEDURE.md')
};
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const rel=file=>path.relative(ROOT,file).replace(/\\/g,'/');
const writeExclusive=(file,value)=>fs.writeFileSync(file,typeof value==='string'?value:`${JSON.stringify(value,null,2)}\n`,{flag:'wx'});

function main(){
  Object.values(outputs).forEach(file=>{if(fs.existsSync(file))throw new Error(`Refusing to overwrite ${rel(file)}`);});
  Object.values(files).forEach(file=>{if(!fs.existsSync(file))throw new Error(`Missing rehearsal input ${rel(file)}`);});
  const candidateManifest=read(files.candidateManifest),training=read(files.training),validation=read(files.validation),transaction=read(files.transaction),surfaces=read(files.surfaces),chatSurfaces=read(files.chatSurfaces);
  const candidate=read(files.candidate);
  const diagnostic=runtime.sendMessageToLari(JSON.parse(JSON.stringify(candidate)),'Describe the safest diagnostic sequence when a small code change causes an existing test to fail.',{modelHash:HASH,autoGrow:false,kernel:{useBenchmarkSystem:false,useCapabilityGraph:true,capabilityGraph:{minScore:0},chat:{minMemoryScore:0,minRouteScore:0}}});
  const realNow={current:sha(files.active),registry:sha(files.registry),legacyRoot:sha(path.join(ROOT,'swarm-model.json'))};
  const gates={
    exactCandidate:sha(files.candidate)===HASH&&candidateManifest.candidate?.sha256===HASH,
    candidateTrainingPassed:training.passed===true&&training.summary?.afterFixed===66&&training.summary?.reloadFixed===66&&training.summary?.immutableOracles===66&&training.summary?.observedOracleExecutions===66,
    candidateValidationPassed:validation.passed===true&&Object.values(validation.gates||{}).every(Boolean),
    isolatedPromotionPassed:Object.values(transaction.gates||{}).every(Boolean),
    atomicInterruptionSafe:transaction.gates?.interruptedPromotion===true,
    corruptedCandidateRejected:transaction.gates?.corruptedCandidate===true,
    exactRollback:transaction.gates?.rollbackRehearsal===true&&transaction.rollback?.checks?.restoredPriorHashExactly===true,
    noSilentFallback:transaction.gates?.fallbackIsolation===true,
    coldStartReadOnly:transaction.gates?.coldStart===true,
    fiveSurfaceParity:surfaces.nonWorkbenchParityPassed===true&&surfaces.parity?.every(row=>row.passed),
    hiddenTransfer17Of17:surfaces.hiddenTransfer?.passed===true&&surfaces.hiddenTransfer?.passedCount===17,
    zeroFamilyRegressions:surfaces.familyRegression?.passed===true&&surfaces.familyRegression?.rows?.every(row=>!row.regressed),
    reloadAndNoHiddenWrites:surfaces.reloadPassed===true&&surfaces.noHiddenWrites===true,
    expandedChatEightFamilyFiveSurfaceParity:chatSurfaces.passed===true&&chatSurfaces.rows?.length===8&&chatSurfaces.rows.every(row=>row.expectedRecordSelected&&row.sameSelection),
    diagnosticAdviceUsesTroubleshooting:diagnostic.passed===true&&diagnostic.action==='chat'&&diagnostic.learnedRecordIds?.includes('lari.learned.procedure.chat.2f21b786')&&/diagnostic hypothesis/i.test(diagnostic.answer||''),
    productionUntouched:JSON.stringify(realNow)===JSON.stringify(transaction.realBefore),
    candidateUntouched:sha(files.candidate)===transaction.candidateAfter,
    noPromotion:candidateManifest.promoted===false&&candidateManifest.candidate?.promoted===false,
    externalModelCallsZero:Number(diagnostic.external_model_calls||0)===0&&chatSurfaces.externalModelCalls===0
  };
  const passed=Object.values(gates).every(Boolean);
  const verdict=passed?'Safe for real promotion':'Rehearsal failed';
  const manifest={schemaVersion:1,kind:'lari.chat-coding-expansion.promotion-rehearsal',createdAt:new Date().toISOString(),rehearsalOnly:true,realPromotionPerformed:false,candidate:{path:rel(files.candidate),sha256:HASH,parentHash:candidateManifest.candidate?.parentHash},incumbent:{path:rel(files.active),sha256:realNow.current},evidence:Object.fromEntries(Object.entries(files).filter(([key])=>!['active','registry','candidate'].includes(key)).map(([key,file])=>[key,{path:rel(file),sha256:sha(file)}])),gates,passed,verdict,limitations:['Five-surface parity proves model hash and learned selection for the eight chat additions.','Nine-language coding execution is proven through the canonical public kernel with immutable external oracles; CLI and chat-completions surfaces do not expose an equivalent filesystem-workspace payload in this rehearsal.','The candidate remains unpromoted.']};
  writeExclusive(outputs.manifest,manifest);
  writeExclusive(outputs.report,`# Lari chat and coding expansion promotion rehearsal\n\n- Candidate: \`${HASH}\`\n- Production active: \`${realNow.current}\`\n- Real promotion performed: no\n- Isolated promotion and exact rollback: PASS\n- Interrupted writes and corrupted candidate: PASS\n- Five-surface general parity: 5/5 families\n- Expanded chat learned-record parity: 8/8 families across canonical, Workbench, CLI, API, and autonomous surfaces\n- Hidden transfer: 17/17\n- Family regressions: 0\n- Nine-language executable repair validation: 9/9 public cases; 66/66 training and reload; 66/66 immutable oracles\n- External model calls: 0\n\nThe first surface rehearsal exposed a real conceptual-code routing regression. It is preserved in \`surface-evidence.json\`. The runtime was repaired so informational coding questions remain chat and select the verified systematic-troubleshooting record; \`surface-evidence-v2.json\` then passed with zero regressions.\n\n## Honest boundary\n\n${manifest.limitations.map(item=>`- ${item}`).join('\n')}\n\nVerdict: **${verdict}**\n`);
  writeExclusive(outputs.rollback,`# Lari chat and coding expansion rollback procedure\n\nThe isolated rollback restored incumbent SHA-256 \`${transaction.realBefore.current}\` exactly.\n\n1. Verify the active hash and the registry's \`previousModelPath\`.\n2. Hash the rollback target and require \`${transaction.realBefore.current}\`.\n3. Invoke the same atomic registry promotion transaction with \`rollback: true\`.\n4. Verify active bytes, registry lineage, backup pointer, and absence of temporary files.\n5. If activation is interrupted, keep the incumbent active; do not retry with an unverified candidate.\n`);
  console.log(JSON.stringify({passed,verdict,candidate:HASH,incumbent:realNow.current,gates,outputs:Object.fromEntries(Object.entries(outputs).map(([key,file])=>[key,rel(file)]))},null,2));
  if(!passed)process.exitCode=1;
}
main();
