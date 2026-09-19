#!/usr/bin/env python3
"""Create privacy-reduced, tree-separated Lari conversation corpora from OASST2."""
import argparse, gzip, hashlib, json, os, re, shutil, tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone

SALT = 'lari-oasst2-v1'
BAD_LABELS = ('spam','pii','not_appropriate','hate_speech','sexual_content','fails_task')

def digest(value): return hashlib.sha256(value.encode('utf-8')).hexdigest()
def label(row, name): return float((row.get('labels') or {}).get(name, {}).get('value') or 0)
def scrub(text):
    text = str(text or '').replace('\x00','').strip()
    text = re.sub(r'(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', '[email removed]', text)
    text = re.sub(r'(?<!\w)(?:\+?\d[\d .()\-]{7,}\d)(?!\w)', '[phone removed]', text)
    text = re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', '[ip removed]', text)
    return re.sub(r'[ \t]+',' ',text)

def accepted(row, counts):
    checks = [
      ('not_english', row.get('lang') != 'en'), ('deleted', bool(row.get('deleted'))),
      ('synthetic', bool(row.get('synthetic'))), ('review_failed', row.get('review_result') is not True),
      ('wrong_state', row.get('tree_state') != 'ready_for_export'),
      ('unsafe_label', any(label(row,k) > .25 for k in BAD_LABELS)),
      ('toxic', label(row,'toxicity') > .35 or float((row.get('detoxify') or {}).get('toxicity') or 0) > .35),
      ('low_quality', row.get('role') == 'assistant' and label(row,'quality') < .5),
      ('low_helpfulness', row.get('role') == 'assistant' and (row.get('labels') or {}).get('helpfulness',{}).get('count',0) > 0 and label(row,'helpfulness') < .5),
      ('bad_length', not (2 <= len(str(row.get('text') or '').strip()) <= 10000))]
    for reason, failed in checks:
        if failed: counts[reason] += 1; return False
    return True

def split_for(tree_id):
    bucket = int(digest(SALT + tree_id)[:8],16) % 100
    return 'train' if bucket < 80 else 'validation' if bucket < 90 else 'hidden'

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--source',required=True); ap.add_argument('--output',required=True); args=ap.parse_args()
    if os.path.exists(args.output): raise SystemExit(f'Output already exists: {args.output}')
    parent=os.path.dirname(args.output); os.makedirs(parent,exist_ok=True); tmp=tempfile.mkdtemp(prefix='.oasst2-prep-',dir=parent)
    counts=Counter(); rows={}; children=defaultdict(list); tree_splits={}; source_sha=hashlib.sha256()
    try:
      with open(args.source,'rb') as raw:
        while True:
          chunk=raw.read(1024*1024)
          if not chunk: break
          source_sha.update(chunk)
      with gzip.open(args.source,'rt',encoding='utf-8') as handle:
        for line in handle:
          counts['source_rows'] += 1
          try: row=json.loads(line)
          except Exception: counts['invalid_json'] += 1; continue
          if not accepted(row,counts): continue
          text=scrub(row.get('text'))
          if not text: counts['empty_after_scrub'] += 1; continue
          mid=row['message_id']; tree=row['message_tree_id']; parent_id=row.get('parent_id')
          rows[mid]={'message_id':mid,'parent_id':parent_id,'tree_id':tree,'role':row['role'],'text':text,'rank':row.get('rank'),'quality':label(row,'quality'),'helpfulness':label(row,'helpfulness')}
          if parent_id: children[parent_id].append(mid)
          tree_splits[tree]=split_for(tree); counts['accepted_messages'] += 1
      outputs={}; handles={}
      for split in ('train','validation','hidden'):
        p=os.path.join(tmp,f'{split}.jsonl.gz'); outputs[split]=p; handles[split]=gzip.open(p,'wt',encoding='utf-8')
      fingerprints=set(); split_counts=Counter(); tree_seen={s:set() for s in outputs}
      for mid,row in rows.items():
        if row['role']!='assistant' or not row['parent_id']: continue
        parent_row=rows.get(row['parent_id'])
        if not parent_row or parent_row['role']!='prompter' or parent_row['tree_id']!=row['tree_id']:
          counts['missing_or_invalid_parent'] += 1; continue
        fp=digest(re.sub(r'\s+',' ',parent_row['text'].lower())+'\n'+re.sub(r'\s+',' ',row['text'].lower()))
        if fp in fingerprints: counts['duplicate_pairs'] += 1; continue
        fingerprints.add(fp); split=tree_splits[row['tree_id']]; tree_seen[split].add(row['tree_id'])
        record={'schemaVersion':1,'kind':'lari.conversation_pair','pairId':digest(SALT+mid)[:24],
          'treeId':digest(SALT+row['tree_id'])[:24],'split':split,
          'turns':[{'role':'user','text':parent_row['text']},{'role':'assistant','text':row['text']}],
          'quality':{'rank':row['rank'],'quality':row['quality'],'helpfulness':row['helpfulness']},
          'provenance':{'dataset':'OpenAssistant/oasst2','license':'Apache-2.0','sourceMessageIdsRetained':False,'userIdsRetained':False,'timestampsRetained':False}}
        handles[split].write(json.dumps(record,ensure_ascii=False,separators=(',',':'))+'\n'); split_counts[split]+=1
      for h in handles.values(): h.close()
      files=[]
      for split,p in outputs.items():
        with open(p,'rb') as f: data=f.read()
        files.append({'split':split,'file':os.path.basename(p),'pairs':split_counts[split],'trees':len(tree_seen[split]),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
      manifest={'schemaVersion':1,'kind':'lari.oasst2.filtered-corpus','createdAt':datetime.now(timezone.utc).isoformat(),
        'source':{'path':args.source,'sha256':source_sha.hexdigest(),'dataset':'OpenAssistant/oasst2','license':'Apache-2.0'},
        'policy':{'language':'en','humanOnly':True,'reviewResult':True,'deleted':False,'maxUnsafeLabel':.25,'maxToxicity':.35,'minAssistantQuality':.5,'minAssistantHelpfulnessWhenRated':.5,'treeLevelSplit':'80/10/10 deterministic SHA-256','piiRedaction':['email','phone','IP'],'rawIdentifiersRetained':False,'rawUserIdsRetained':False,'timestampsRetained':False},
        'counts':dict(counts),'files':files,'gates':{'nonEmptyAllSplits':all(x['pairs']>0 for x in files),'treeDisjoint':not(tree_seen['train']&tree_seen['validation'] or tree_seen['train']&tree_seen['hidden'] or tree_seen['validation']&tree_seen['hidden']),'pairDeduplicated':True,'sourceHashRecorded':True,'privacyFieldsRemoved':True}}
      manifest['passed']=all(manifest['gates'].values())
      with open(os.path.join(tmp,'manifest.json'),'w',encoding='utf-8') as f: json.dump(manifest,f,indent=2)
      os.replace(tmp,args.output); print(json.dumps({'output':args.output,'files':files,'counts':dict(counts),'gates':manifest['gates'],'passed':manifest['passed']},indent=2))
    except Exception:
      shutil.rmtree(tmp,ignore_errors=True); raise
if __name__=='__main__': main()
