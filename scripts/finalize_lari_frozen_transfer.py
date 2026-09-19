"""Summarize preserved frozen-transfer evidence without changing model or runtime."""
from datetime import datetime, timezone
from resume_lari_frozen_transfer_environment import OUT, read, dump, sha

def main():
    previous=read(OUT/'environment3-evaluation-report.json')
    rows=previous['rows']
    for row in rows:
        if row['id']=='pytest-dev__pytest-6197':
            row['classification']='behavioral_failure'
            row['transfer']=read(OUT/row['id']/'adjudicated-transfer-result.json')
    freeze=read(OUT/'freeze-manifest.json')
    dependency=read(OUT/'dependency-freeze-amendment.json')
    root=OUT/'runtime/node_modules/computational-english'
    integrity={
        'runtimeUnchanged':all(sha(OUT/'runtime'/f['path'])==f['sha256'] for f in freeze['files']),
        'candidateUnchanged':sha(OUT/'candidate.json')==freeze['candidateHash'],
        'protectedUnchanged':all(sha(p)==h for p,h in freeze['protected'].items()),
        'dependencySnapshotUnchanged':all(sha(root/f['path'])==f['sha256'] for f in dependency['files']),
        'allOraclesUnchanged':all(r.get('transfer',{}).get('oracleUnchanged') is True for r in rows),
        'allLoadedModulesWithinSnapshot':all(r.get('transfer',{}).get('loadedModules') and all(str(OUT/'runtime') in p for p in r['transfer']['loadedModules']) for r in rows)
    }
    count=sum(r.get('transfer',{}).get('passed',False) for r in rows)
    report={'createdAt':datetime.now(timezone.utc).isoformat(),'candidateHash':freeze['candidateHash'],
        'selected':len(rows),'runnable':sum(r['classification']=='behavioral_failure' for r in rows),'repairPasses':count,
        'passed':count==len(rows) and all(integrity.values()),'evaluationComplete':True,'promoted':False,
        'integrity':integrity,'rows':rows,
        'interpretation':'Fixed fresh local-corpus sample; runtime and candidate were not tuned against outcomes. Dependency packaging was completed after selection.',
        'unrunGates':'Cold reload, successful-repair ablation and pass-to-pass qualification are conditional on a successful repair; none executed if repairPasses is zero.',
        'sources':{'originalFreeze':sha(OUT/'freeze-manifest.json'),'dependencyAmendment':sha(OUT/'dependency-freeze-amendment.json'),
        'environmentReport':sha(OUT/'environment3-evaluation-report.json'),'classificationAdjudication':sha(OUT/'pytest-dev__pytest-6197/classification-adjudication.json')}}
    dump(OUT/'final-evaluation-report.json',report)
    table='\n'.join('| '+r['id']+' | '+str(r.get('transfer',{}).get('action','execution error'))+' | '+('Pass' if r.get('transfer',{}).get('passed') else 'Fail')+' |' for r in rows)
    text=f'''# Frozen fresh repository evaluation

Candidate: `{freeze['candidateHash']}`. Unpromoted.

Result: **{count}/{len(rows)} native repository failures repaired**. All six IDs were chosen by a predeclared hash ordering after local exposure screening. No selected task was replaced. The candidate and frozen Lari runtime code were not tuned against these outcomes.

| Task | Public response action | Repair result |
|---|---|---|
{table}

The runtime produced clarification responses on two issues. Other responses reported incomplete coding work. These observations show a gap between the earlier development-assisted repair demonstrations and reliable reuse on this fresh sample. They do not measure what Lari could learn with discovery enabled; this experiment explicitly disabled discovery to test the existing candidate.

## Integrity and protocol limits

Integrity checks: `{integrity}`.

The initial Python 3.13 environment did not execute the historical suites correctly. The same tasks were repeated using isolated Python 3.9, compatible test dependencies, checkout-specific import paths, and upstream-generated pytest version metadata. Native oracles were preserved; no substitute tests or gold source patches were used. One pytest self-test was adjudicated as a genuine behavioral failure because its nested collection error had fooled the evaluator's initial text classifier.

The first runtime package resolved Computational English from a linked source directory. Its exact bytes were subsequently copied into the snapshot and hashed. Consequently, the entire dependency closure was **not** frozen before selection. The final run audits loaded JavaScript modules against the snapshot. This is an environment-amended fixed-candidate evaluation, not a perfectly sealed independent benchmark or official SWE-bench score. Local exposure checks cannot establish absence from every prior human or assistant context. Network access was available to native tests.

No repair succeeded, so successful-repair reload, ablation, and pass-to-pass gates were not reached. They are unproven for this sample, not passed.

## Next development decision

Keep this candidate unpromoted. First investigate why complete repository issue requests can terminate in a pronoun-clarification response before useful repair execution. Separately, inspect the diagnostic and search limits on the remaining failures. Any fixes should use this now-exposed sample as development evidence and require a different frozen sample for the next transfer claim.

Evidence: `final-evaluation-report.json`, `freeze-manifest.json`, `selection.json`, `dependency-freeze-amendment.json`, and per-task result files. Earlier attempts remain preserved.
'''
    with (OUT/'REPORT.md').open('x',encoding='utf-8') as f: f.write(text)
    print({'repairPasses':count,'selected':len(rows),'integrity':integrity,'report':str(OUT/'REPORT.md')})
if __name__=='__main__': main()
