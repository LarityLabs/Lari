#!/usr/bin/env node
'use strict';
const crypto=require('crypto'),fs=require('fs'),path=require('path');
const language=require('../swarm_language_understanding.js');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'consolidation','referential-relation-autogenesis-20260901');
const BASE=path.join(ROOT,'consolidation','semantic-ast-autogenesis-20260831','qualified-candidates','9023ab7e28b4ba934ccaa930da146358fe14f4f1ea56a09f857e33f77083efbb.json');
const files={traces:path.join(OUT,'behavioral-failure-traces.json'),hidden:path.join(OUT,'hidden-holdouts.json'),baseline:path.join(OUT,'baseline-evidence.json'),seal:path.join(OUT,'sealed-index.json')};
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),shaFile=f=>sha(fs.readFileSync(f)),write=(f,v)=>fs.writeFileSync(f,`${JSON.stringify(v,null,2)}\n`,{flag:'wx'});
function evaluate(model,item){const result=language.analyze(item.prompt,{enableLearningBinding:true,learnedRecords:model.lariLearnedRecords?.records||[]});const relation=(result.semantics.semanticRelations||[]).find(value=>value.type==='ordered_referent');return{id:item.id,passed:relation?.antecedentText===item.expectedEntity,relation:relation||null,operatorIds:result.learnedSemanticOperatorIds||[]};}
function main(){if(fs.existsSync(OUT))throw new Error('Refusing to overwrite sealed referential experiment.');fs.mkdirSync(OUT,{recursive:true});const base=JSON.parse(fs.readFileSync(BASE,'utf8'));
  const traces=[
    {id:'dev.code.former',basePrompt:'Compare parser.js and cache.js; modify',referentialPrompt:'Compare parser.js and cache.js; modify the former target.',entities:['parser.js','cache.js'],expectedEntity:'parser.js',baselineUnresolved:true},
    {id:'dev.research.former',basePrompt:'Contrast "field study" and "lab study"; summarize',referentialPrompt:'Contrast "field study" and "lab study"; summarize the former approach.',entities:['field study','lab study'],expectedEntity:'field study',baselineUnresolved:true},
    {id:'dev.plan.former',basePrompt:'Evaluate "fast rollout" and "safe rollout"; choose',referentialPrompt:'Evaluate "fast rollout" and "safe rollout"; choose the former option.',entities:['fast rollout','safe rollout'],expectedEntity:'fast rollout',baselineUnresolved:true},
    {id:'dev.code.latter',basePrompt:'Inspect api.py and worker.py; patch',referentialPrompt:'Inspect api.py and worker.py; patch the latter target.',entities:['api.py','worker.py'],expectedEntity:'worker.py',baselineUnresolved:true},
    {id:'dev.chat.latter',basePrompt:'Discuss "brief answer" and "detailed answer"; use',referentialPrompt:'Discuss "brief answer" and "detailed answer"; use the latter style.',entities:['brief answer','detailed answer'],expectedEntity:'detailed answer',baselineUnresolved:true},
    {id:'dev.ops.latter',basePrompt:'Compare "blue deployment" and "green deployment"; activate',referentialPrompt:'Compare "blue deployment" and "green deployment"; activate the latter option.',entities:['blue deployment','green deployment'],expectedEntity:'green deployment',baselineUnresolved:true}
  ];
  const hidden=[
    {id:'hidden.code.former',domain:'code',prompt:'Review config.ts and loader.ts; update the former module.',entities:['config.ts','loader.ts'],expectedEntity:'config.ts'},
    {id:'hidden.code.latter',domain:'code',prompt:'Inspect schema.py and migrate.py; test the latter file.',entities:['schema.py','migrate.py'],expectedEntity:'migrate.py'},
    {id:'hidden.research.former',domain:'research',prompt:'Compare "observational evidence" and "experimental evidence"; explain the former method.',entities:['observational evidence','experimental evidence'],expectedEntity:'observational evidence'},
    {id:'hidden.chat.latter',domain:'chat',prompt:'Consider "technical explanation" and "plain explanation"; write the latter version.',entities:['technical explanation','plain explanation'],expectedEntity:'plain explanation'},
    {id:'hidden.operations.former',domain:'operations',prompt:'Assess "primary region" and "backup region"; restore the former environment.',entities:['primary region','backup region'],expectedEntity:'primary region'},
    {id:'hidden.learning.latter',domain:'learning',prompt:'Study "worked example" and "abstract rule"; retain the latter concept.',entities:['worked example','abstract rule'],expectedEntity:'abstract rule'},
    {id:'hidden.product.former',domain:'product',prompt:'Evaluate "desktop workflow" and "cloud workflow"; prototype the former experience.',entities:['desktop workflow','cloud workflow'],expectedEntity:'desktop workflow'},
    {id:'hidden.safety.latter',domain:'safety',prompt:'Compare "automatic deletion" and "reviewed deletion"; require the latter policy.',entities:['automatic deletion','reviewed deletion'],expectedEntity:'reviewed deletion'}
  ];
  write(files.traces,{schemaVersion:1,kind:'lari.referential_relation.behavioral_failures',createdAt:new Date().toISOString(),baseHash:shaFile(BASE),traces});
  write(files.hidden,{schemaVersion:1,kind:'lari.referential_relation.hidden_holdouts',createdAt:new Date().toISOString(),cases:hidden});
  const baselineRows=hidden.map(item=>evaluate(base,item));write(files.baseline,{schemaVersion:1,kind:'lari.referential_relation.baseline',createdAt:new Date().toISOString(),baseHash:shaFile(BASE),rows:baselineRows,gates:{currentPrimitiveLanguageCannotExpress:baselineRows.every(row=>!row.passed),compositionSpaceExhausted:!(base.lariLearnedRecords?.records||[]).some(record=>record.payload?.operatorAst?.kind==='lari.referential_selection_operator')}});
  const seal={schemaVersion:1,kind:'lari.referential_relation.seal',createdAt:new Date().toISOString(),base:{path:path.relative(ROOT,BASE).replace(/\\/g,'/'),sha256:shaFile(BASE)},traces:{path:path.relative(ROOT,files.traces).replace(/\\/g,'/'),sha256:shaFile(files.traces)},hidden:{path:path.relative(ROOT,files.hidden).replace(/\\/g,'/'),sha256:shaFile(files.hidden)},baseline:{path:path.relative(ROOT,files.baseline).replace(/\\/g,'/'),sha256:shaFile(files.baseline)}};write(files.seal,seal);Object.values(files).forEach(f=>fs.chmodSync(f,0o444));console.log(JSON.stringify({sealed:true,baseHash:seal.base.sha256,baselineFailures:`${baselineRows.filter(row=>!row.passed).length}/${baselineRows.length}`,compositionSpaceExhausted:true,files:Object.fromEntries(Object.entries(files).map(([k,f])=>[k,path.relative(ROOT,f).replace(/\\/g,'/')]))},null,2));
}
main();
