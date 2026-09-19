"""Adjudicate a native pytest self-test whose expected nested error fooled classification."""
import json, pathlib, shutil
import pandas as pd
from resume_lari_frozen_transfer_environment import ROOT, OUT, read, dump, sha, run, environment

def main():
    iid='pytest-dev__pytest-6197'
    directory=OUT/iid
    original=read(directory/'environment3-result.json')
    # Outer pytest completed two failed assertions. The collection error appears
    # inside captured output of the tested pytest child, not evaluator collection.
    assert original['baseline']['exitCode']==1
    assert '2 failed' in original['baseline']['output']
    dump(directory/'classification-adjudication.json',{'originalClassification':original['classification'],
        'classification':'behavioral_failure','reason':'Two outer native assertion failures; nested pytest collection error is the defect under test, not an evaluator setup error.',
        'originalResultHash':sha(directory/'environment3-result.json'),'runtimeChanged':False})
    task=read(directory/'task-commitment.json'); freeze=read(OUT/'freeze-manifest.json')
    source=directory/'baseline'; work=directory/'adjudicated-transfer'
    shutil.copytree(source,work,ignore=shutil.ignore_patterns('.git','__pycache__','.pytest_cache'))
    data=pd.read_parquet(ROOT/'consolidation/open-world-apprenticeship-20260901/swebench-verified-test.parquet',columns=['instance_id','problem_statement']).set_index('instance_id')
    config={'id':iid,'workspace':str(work),'prompt':str(data.loc[iid].problem_statement),'selectors':task['selectors'],
        'oracleFiles':list(task['oracleFiles']),'candidate':str(OUT/'candidate.json'),'candidateHash':freeze['candidateHash'],
        'result':str(directory/'adjudicated-transfer-result.json')}
    cfg=directory/'adjudicated-config.json'; dump(cfg,config)
    result=run(['node',str(OUT/'runtime/scripts/lari_frozen_transfer_worker.js'),str(cfg)],OUT/'runtime',environment(work),180)
    if not pathlib.Path(config['result']).exists(): dump(pathlib.Path(config['result']),{'passed':False,'executionError':(result.stdout+result.stderr)[-5000:]})
    print(json.dumps(read(pathlib.Path(config['result'])),indent=2))
if __name__=='__main__': main()
