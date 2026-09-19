"""Freeze runtime/candidate, sample unseen local IDs, then execute without tuning."""
import hashlib, json, os, pathlib, shutil, subprocess, sys
from datetime import datetime, timezone
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'consolidation/frozen-fresh-transfer-20260904'
CANDIDATE = ROOT / 'consolidation/predicate-domain-transfer-20260902/combined-candidates/4431bedf49ed7a5c73c6b7e95fbe41a8abd981d761e63214f482d238fa9ae92f.json'
DATASET = ROOT / 'consolidation/open-world-apprenticeship-20260901/swebench-verified-test.parquet'
REPOS = ['psf/requests', 'pytest-dev/pytest', 'sphinx-doc/sphinx']
SEED = 'lari-frozen-fresh-transfer-20260904-v1'

def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def dump(p, value):
    with pathlib.Path(p).open('x', encoding='utf-8') as f: json.dump(value,f,indent=2); f.write('\n')
def run(args,cwd=ROOT,timeout=180):
    return subprocess.run(args,cwd=cwd,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=timeout,env={**os.environ,'PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1'})
def require(args,cwd=ROOT):
    r=run(args,cwd)
    if r.returncode: raise RuntimeError((r.stdout+r.stderr)[-2500:])
    return r
def baseline(workspace,selectors):
    r=run(['python','-m','pytest','-q',*selectors],workspace,90)
    text=r.stdout+r.stderr
    blocked=any(x in text.lower() for x in ['error collecting','modulenotfounderror','importerror','internalerror','unrecognized arguments','syntaxerror'])
    cls='unexpected_pass' if r.returncode==0 else ('behavioral_failure' if r.returncode==1 and ' failed' in text and not blocked else 'harness_blocked')
    return {'classification':cls,'exitCode':r.returncode,'output':text[-6000:]}

def main():
    OUT.mkdir()  # Fail closed on rerun; all artifacts are append-only.
    frozen=OUT/'runtime'; frozen.mkdir()
    files=list(ROOT.glob('*.js'))+list(ROOT.glob('*.json'))+list(ROOT.glob('*.html'))+list(ROOT.glob('*.py'))
    for directory in ['scripts','lib','src']:
        if (ROOT/directory).exists(): files.extend(p for p in (ROOT/directory).rglob('*') if p.is_file() and p.suffix in ['.js','.json','.py','.html','.ts'])
    commitments=[]
    for source in sorted(set(files)):
        relative=source.relative_to(ROOT); target=frozen/relative
        target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(source,target)
        commitments.append({'path':relative.as_posix(),'sha256':sha(target),'size':target.stat().st_size})
    frozen_candidate=OUT/'candidate.json'; shutil.copy2(CANDIDATE,frozen_candidate)
    assert sha(frozen_candidate)==CANDIDATE.stem
    protected=[ROOT/'models/lari/current/swarm-model.json',ROOT/'models/lari/registry.json',CANDIDATE]
    before={str(p):sha(p) for p in protected}
    (OUT/'dirty-worktree.patch').write_bytes(subprocess.check_output(['git','diff','--binary'],cwd=ROOT))
    (OUT/'dirty-worktree-status.txt').write_text(require(['git','status','--porcelain']).stdout,encoding='utf-8')
    freeze={'createdAt':datetime.now(timezone.utc).isoformat(),'candidateHash':sha(frozen_candidate),'files':commitments,
        'datasetSha256':sha(DATASET),'protected':before,'selection':{'seed':SEED,'repos':REPOS,'perRepo':2},
        'protocol':{'tuningAfterSelection':False,'budget':32,'taskTimeoutSeconds':180,'replaceBlockedTasks':False,
        'nativeTestsOnly':True,'discovery':False,'successfulRepairsRequireColdReloadAndExactAblation':True},
        'environment':{'python':sys.version,'node':require(['node','--version']).stdout.strip(),
        'pythonPackages':require(['python','-m','pip','freeze']).stdout,'dependencyIsolation':'Shared installed environment; not hermetic or network sandboxed.'}}
    dump(OUT/'freeze-manifest.json',freeze)
    print('Runtime and candidate frozen before task selection.',flush=True)

    # Read ID/repository columns only. Exclude IDs mentioned anywhere in accessible
    # local text evidence, including ignored models and past consolidation results.
    metadata=pd.read_parquet(DATASET,columns=['instance_id','repo'])
    scan=run(['rg','--no-ignore','-o','--no-filename',r'[A-Za-z0-9_-]+__[A-Za-z0-9_-]+-\d+',
        '-g','*.json','-g','*.jsonl','-g','*.md','-g','*.js','-g','*.txt',
        '-g','!**/node_modules/**','-g','!**/.git/**','-g','!**/mirrors/**','-g','!**/workspaces/**',
        '-g','!consolidation/frozen-fresh-transfer-20260904/**','.'],timeout=180)
    if scan.returncode not in (0,1): raise RuntimeError('Freshness scan failed: '+scan.stderr[-2000:])
    seen=set(scan.stdout.splitlines())
    selected=[]
    for repo in REPOS:
        eligible=[str(x) for x in metadata[metadata.repo==repo].instance_id if str(x) not in seen]
        eligible.sort(key=lambda x:hashlib.sha256((SEED+x).encode()).hexdigest())
        selected.extend(eligible[:2])
    dump(OUT/'selection.json',{'selectedIds':selected,'excludedSeenIds':sorted(seen),'rule':'First two SHA256(seed + ID) per repo after local-text exclusion','limitations':'Local corpus scan cannot prove absence from all past human or assistant exposure.'})
    print('Selected: '+', '.join(selected),flush=True)
    # Do not read gold patch column, even for hashing. Native test patches are
    # loaded only by this evaluator and applied before any model inference.
    data=pd.read_parquet(DATASET,columns=['instance_id','repo','base_commit','problem_statement','test_patch','FAIL_TO_PASS','PASS_TO_PASS']).set_index('instance_id')
    results=[]
    for iid in selected:
        item=data.loc[iid]; row={'id':iid,'repo':str(item.repo)}; results.append(row)
        taskdir=OUT/iid; taskdir.mkdir(); workspace=taskdir/'baseline'
        try:
            slug=str(item.repo).replace('/','__')+'.git'
            mirrors=[ROOT/'consolidation/open-world-apprenticeship-20260901/mirrors'/slug,ROOT/'consolidation/predicate-domain-transfer-20260902/mirrors'/slug]
            mirror=next(p for p in mirrors if p.exists())
            require(['git','clone','--shared','--no-checkout',str(mirror),str(workspace)])
            require(['git','checkout','--detach',str(item.base_commit)],workspace)
            patch=taskdir/'test.patch'; patch.write_text(str(item.test_patch),encoding='utf-8')
            require(['git','apply','--whitespace=nowarn',str(patch)],workspace)
            selectors=json.loads(item.FAIL_TO_PASS); p2p=json.loads(item.PASS_TO_PASS)
            oracle_files=[x.split('::')[0] for x in selectors if (workspace/x.split('::')[0]).is_file()]
            oracle_files=list(set(oracle_files+[line[6:] for line in str(item.test_patch).splitlines() if line.startswith('+++ b/') and (workspace/line[6:]).is_file()]))
            row['baseline']=baseline(workspace,selectors)
            print(iid+': '+row['baseline']['classification'],flush=True)
            dump(taskdir/'task-commitment.json',{'id':iid,'commit':str(item.base_commit),'testPatchHash':sha(patch),'selectors':selectors,'passToPass':p2p,'oracleFiles':{p:sha(workspace/p) for p in oracle_files}})
            if row['baseline']['classification']=='behavioral_failure':
                def execute(phase,ablate=None):
                    dest=taskdir/phase
                    shutil.copytree(workspace,dest,ignore=shutil.ignore_patterns('.git','__pycache__','.pytest_cache'))
                    cfg={'id':iid,'workspace':str(dest),'prompt':str(item.problem_statement),'selectors':selectors,'oracleFiles':oracle_files,
                        'candidate':str(frozen_candidate),'candidateHash':sha(frozen_candidate),'ablate':ablate,'result':str(taskdir/(phase+'-result.json'))}
                    config=taskdir/(phase+'-config.json'); dump(config,cfg)
                    r=run(['node',str(frozen/'scripts/lari_frozen_transfer_worker.js'),str(config)],frozen,180)
                    if not pathlib.Path(cfg['result']).exists(): return {'passed':False,'error':(r.stdout+r.stderr)[-5000:],'exitCode':r.returncode}
                    result=json.loads(pathlib.Path(cfg['result']).read_text(encoding='utf-8'))
                    if result['passed'] and p2p: result['passToPass']=baseline(dest,p2p)
                    return result
                row['transfer']=execute('transfer')
                if row['transfer']['passed']:
                    row['reload']=execute('reload')
                    record=row['transfer'].get('recordId')
                    row['ablation']=execute('ablation',record) if record else {'passed':False,'unavailable':'No exact record binding'}
            dump(taskdir/'result.json',row)
        except Exception as error:
            row['error']=str(error); dump(taskdir/'error.json',{'error':str(error)})
            print(iid+': '+str(error)[:200],flush=True)
    unchanged=all(sha(frozen/f['path'])==f['sha256'] for f in commitments) and sha(frozen_candidate)==freeze['candidateHash']
    protected_unchanged=all(sha(p)==h for p,h in before.items())
    report={'createdAt':datetime.now(timezone.utc).isoformat(),'freezeManifestHash':sha(OUT/'freeze-manifest.json'),
        'candidateHash':freeze['candidateHash'],'selected':len(selected),'requested':6,'rows':results,
        'runnable':sum(r.get('baseline',{}).get('classification')=='behavioral_failure' for r in results),
        'repairPasses':sum(r.get('transfer',{}).get('passed',False) for r in results),'runtimeAndCandidateUnchanged':unchanged,
        'productionAndOriginalCandidateUnchanged':protected_unchanged,'promoted':False,
        'limitations':['Native historical harnesses only; blocked environments are not model failures.','Local exposure scan is bounded to this workspace.','Process isolation and byte hashes, not an OS-enforced secrecy or network sandbox.','This is a fixed transfer evaluation, not an official SWE-bench score.']}
    dump(OUT/'evaluation-report.json',report)
    print(json.dumps({k:v for k,v in report.items() if k!='rows'},indent=2),flush=True)

if __name__=='__main__': main()
