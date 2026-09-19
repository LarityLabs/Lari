"""Environment-only continuation; leaves the September 4 runtime freeze intact."""
import hashlib, json, os, pathlib, shutil, subprocess
from datetime import datetime, timezone
import pandas as pd
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'consolidation/frozen-fresh-transfer-20260904'
ENV=OUT/'python39'
def read(p): return json.loads(p.read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def dump(p,v):
    with p.open('x',encoding='utf-8') as f: json.dump(v,f,indent=2); f.write('\n')
def run(args,cwd,env,timeout=120):
    if args[0]=='python': args=[str(ENV/'python.exe'),*args[1:]]
    return subprocess.run(args,cwd=cwd,env=env,text=True,encoding='utf-8',errors='replace',capture_output=True,timeout=timeout)
def environment(work):
    return {**{k:v for k,v in os.environ.items() if k.upper() not in ['PATH','PYTHONHOME','PYTHONPATH']},'PATH':str(ENV)+';'+str(ENV/'Scripts')+';'+str(ENV/'Library/bin')+';'+os.environ['PATH'],
        'PYTHONPATH':str(work/'src')+';'+str(work),'PYTHONNOUSERSITE':'1','PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1'}
def main():
    freeze=read(OUT/'freeze-manifest.json')
    selected=read(OUT/'selection.json')['selectedIds']
    data=pd.read_parquet(ROOT/'consolidation/open-world-apprenticeship-20260901/swebench-verified-test.parquet',columns=['instance_id','problem_statement']).set_index('instance_id')
    rows=[]
    # The first run's module audit discovered the existing linked CE dependency
    # outside the runtime snapshot. Copy its exact bytes; do not change its code.
    ce_source=ROOT.parent/'computational-english'
    ce_target=OUT/'runtime/node_modules/computational-english'
    ce_target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copytree(ce_source,ce_target,ignore=shutil.ignore_patterns('.git','node_modules','__pycache__'))
    dependency_files=[{'path':p.relative_to(ce_target).as_posix(),'sha256':sha(p)} for p in ce_target.rglob('*') if p.is_file()]
    dump(OUT/'dependency-freeze-amendment.json',{'createdAt':datetime.now(timezone.utc).isoformat(),
        'source':str(ce_source),'files':dependency_files,'timing':'After selection and first executions; exact-byte packaging repair, not a before-selection dependency freeze.'})
    dump(OUT/'environment-amendment3.json',{'createdAt':datetime.now(timezone.utc).isoformat(),
        'reason':'Native historical dependency and source-import setup only; same tasks, frozen model and proposal code.',
        'pythonVersion':run([str(ENV/'python.exe'),'--version'],OUT,environment(OUT)).stdout,
        'packages':run([str(ENV/'python.exe'),'-m','pip','freeze'],OUT,environment(OUT)).stdout,
        'sourceImportPolicy':'Each checkout root and src precede installed packages in PYTHONPATH.',
        'priorReportHash':sha(OUT/'evaluation-report.json'),'runtimeFreezeHash':sha(OUT/'freeze-manifest.json')})
    for iid in selected:
        directory=OUT/iid; source=directory/'baseline'; task=read(directory/'task-commitment.json')
        row={'id':iid}; rows.append(row)
        try:
            # Use the original native oracle without changing test or source bytes.
            env=environment(source)
            module='requests' if iid.startswith('psf__') else ('pytest' if iid.startswith('pytest-') else 'sphinx')
            imported=run(['python','-c',f'import {module}; print({module}.__file__)'],source,env)
            row['moduleOrigin']=imported.stdout.strip(); row['moduleImportError']=imported.stderr[-2000:]
            if imported.returncode or str(source).lower() not in imported.stdout.lower():
                row['classification']='harness_blocked'; continue
            before=run(['python','-m','pytest','-q',*task['selectors']],source,env,90)
            output=before.stdout+before.stderr
            row['baseline']={'exitCode':before.returncode,'output':output[-8000:]}
            blocked=any(s in output.lower() for s in ['error collecting','modulenotfounderror','importerror','internalerror','connectionerror','proxyerror','connection refused','could not resolve','timed out'])
            row['classification']='unexpected_pass' if before.returncode==0 else ('behavioral_failure' if before.returncode==1 and ' failed' in output and not blocked else 'harness_blocked')
            print(iid+': '+row['classification'],flush=True)
            if row['classification']!='behavioral_failure': continue
            def execute(phase,ablate=None):
                work=directory/('environment3-'+phase)
                shutil.copytree(source,work,ignore=shutil.ignore_patterns('.git','__pycache__','.pytest_cache'))
                cfg={'id':iid,'workspace':str(work),'prompt':str(data.loc[iid].problem_statement),'selectors':task['selectors'],
                    'oracleFiles':list(task['oracleFiles']),'candidate':str(OUT/'candidate.json'),'candidateHash':freeze['candidateHash'],
                    'ablate':ablate,'result':str(directory/('environment3-'+phase+'-result.json'))}
                config=directory/('environment3-'+phase+'-config.json'); dump(config,cfg)
                proc=run(['node',str(OUT/'runtime/scripts/lari_frozen_transfer_worker.js'),str(config)],OUT/'runtime',environment(work),180)
                if not pathlib.Path(cfg['result']).exists(): return {'passed':False,'error':(proc.stdout+proc.stderr)[-6000:]}
                result=read(pathlib.Path(cfg['result']))
                if result['passed'] and task['passToPass']:
                    p=run(['python','-m','pytest','-q',*task['passToPass']],work,environment(work),90)
                    result['passToPass']={'passed':p.returncode==0,'output':(p.stdout+p.stderr)[-3000:]}
                return result
            row['transfer']=execute('transfer')
            if row['transfer']['passed']:
                row['reload']=execute('reload')
                rec=row['transfer'].get('recordId')
                row['ablation']=execute('ablation',rec) if rec else {'unavailable':'No record binding'}
        except Exception as error:
            row['error']=str(error); row.setdefault('classification','execution_blocked')
        finally:
            dump(directory/'environment3-result.json',row)
            print(iid+': recorded',flush=True)
    integrity=all(sha(OUT/'runtime'/f['path'])==f['sha256'] for f in freeze['files']) and sha(OUT/'candidate.json')==freeze['candidateHash']
    report={'createdAt':datetime.now(timezone.utc).isoformat(),'candidateHash':freeze['candidateHash'],'selected':len(selected),'rows':rows,
        'runnable':sum(r.get('classification')=='behavioral_failure' for r in rows),
        'repairPasses':sum(r.get('transfer',{}).get('passed',False) for r in rows),
        'runtimeAndCandidateUnchanged':integrity,'productionAndOriginalCandidateUnchanged':all(sha(p)==h for p,h in freeze['protected'].items()),
        'dependencySnapshotUnchanged':all(sha(ce_target/f['path'])==f['sha256'] for f in dependency_files),
        'promoted':False,'environmentAmendmentHash':sha(OUT/'environment-amendment3.json')}
    dump(OUT/'environment3-evaluation-report.json',report)
    print(json.dumps({k:v for k,v in report.items() if k!='rows'},indent=2))
if __name__=='__main__': main()
