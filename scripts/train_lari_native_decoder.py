#!/usr/bin/env python3
"""Train Lari's native decoder from scratch, with no pretrained weights.

The hidden split is deliberately never opened here. A candidate may be useful
for development after passing validation probes, but still needs a separately
executed sealed evaluation before promotion.
"""
import argparse, collections, gzip, hashlib, json, math, os, random, re, time
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

SPECIAL = ["<pad>", "<bos>", "<sep>", "<eos>", "<unk>"]
PAD, BOS, SEP, EOS, UNK = range(len(SPECIAL))
TOKEN_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?|[0-9]+(?:\.[0-9]+)?|[^\w\s]", re.UNICODE)
NO_SPACE_BEFORE, NO_SPACE_AFTER = set(".,!?;:%)]}"), set("([{")

def tokens(text): return TOKEN_RE.findall(str(text).lower())

def build_vocab(path, size):
    counts = collections.Counter()
    with gzip.open(path, "rt", encoding="utf8") as handle:
        for line in handle:
            record = json.loads(line)
            for turn in record["turns"][:2]: counts.update(tokens(turn["text"]))
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    vocab = SPECIAL + [token for token, _ in ordered[:max(0, size-len(SPECIAL))]]
    return vocab, {token:index for index,token in enumerate(vocab)}

def encode(text, token_to_id): return [token_to_id.get(token, UNK) for token in tokens(text)]

def decode(ids, vocab):
    pieces=[]
    for token_id in ids:
        if token_id >= len(vocab) or token_id < len(SPECIAL): continue
        token=vocab[token_id]
        if not pieces or token in NO_SPACE_BEFORE or pieces[-1] in NO_SPACE_AFTER: pieces.append(token)
        else: pieces.extend([" ",token])
    text="".join(pieces).strip()
    return text[:1].upper()+text[1:] if text else text

class Conversations(Dataset):
    def __init__(self,path,max_len,token_to_id):
        self.items=[]
        with gzip.open(path,"rt",encoding="utf8") as handle:
            for line in handle:
                record=json.loads(line)
                user=encode(record["turns"][0]["text"],token_to_id)
                assistant=encode(record["turns"][1]["text"],token_to_id)
                room=max_len-3; user=user[-min(len(user),max(12,room//3)):]; assistant=assistant[:room-len(user)]
                ids=[BOS]+user+[SEP]+assistant+[EOS]; self.items.append((ids,1+len(user)))
    def __len__(self): return len(self.items)
    def __getitem__(self,index): return self.items[index]

def collate(batch):
    width=max(len(item[0]) for item in batch)
    inputs=torch.full((len(batch),width-1),PAD,dtype=torch.long); targets=torch.full_like(inputs,-100)
    for row,(ids,separator) in enumerate(batch):
        tensor=torch.tensor(ids); inputs[row,:len(ids)-1]=tensor[:-1]; targets[row,:len(ids)-1]=tensor[1:]; targets[row,:separator]=-100
    return inputs,targets

class Decoder(nn.Module):
    def __init__(self,vocab_size,d=192,layers=4,heads=6,ff=768,max_len=192):
        super().__init__(); self.max_len=max_len; self.tok=nn.Embedding(vocab_size,d); self.pos=nn.Embedding(max_len,d)
        block=nn.TransformerEncoderLayer(d,heads,ff,dropout=.1,batch_first=True,norm_first=True,activation="gelu")
        self.blocks=nn.TransformerEncoder(block,layers); self.norm=nn.LayerNorm(d); self.head=nn.Linear(d,vocab_size,bias=False); self.head.weight=self.tok.weight
    def forward(self,inputs):
        width=inputs.size(1); state=self.tok(inputs)+self.pos(torch.arange(width,device=inputs.device))
        causal=torch.triu(torch.ones(width,width,device=inputs.device,dtype=torch.bool),1)
        return self.head(self.norm(self.blocks(state,mask=causal,src_key_padding_mask=inputs.eq(PAD))))

def evaluate(model,loader,vocab_size,limit=100):
    model.eval(); total=0.; count=0
    with torch.no_grad():
        for inputs,targets in loader:
            loss=nn.functional.cross_entropy(model(inputs).reshape(-1,vocab_size),targets.reshape(-1),ignore_index=-100)
            total+=loss.item(); count+=1
            if count>=limit: break
    return total/max(1,count)

def generate(model,prompt,token_to_id,vocab,max_new=120,temperature=.7,top_k=40):
    model.eval(); ids=[BOS]+encode(prompt,token_to_id)[-64:]+[SEP]; generated=[]
    with torch.no_grad():
        for _ in range(max_new):
            logits=model(torch.tensor([ids[-model.max_len:]]))[0,-1]/temperature; logits[[PAD,BOS,SEP,UNK]]=-float("inf")
            for recent in generated[-24:]: logits[recent]-=.65
            values,indexes=torch.topk(logits,min(top_k,logits.numel())); next_id=int(indexes[torch.multinomial(torch.softmax(values,0),1)])
            if next_id==EOS: break
            ids.append(next_id); generated.append(next_id)
    return decode(generated,vocab)

PROBES=[
 ("Can we talk through a difficult decision?",{"option","consider","decision","trade","choice"}),
 ("Explain why testing matters in simple language.",{"test","error","problem","work","check"}),
 ("I feel stuck and need a practical next step.",{"step","start","try","first","help"}),
]
def assess_sample(prompt,output,expected):
    words=re.findall(r"[a-z]+",output.lower()); unique=len(set(words))/max(1,len(words)); dominant=max((words.count(w) for w in set(words)),default=0)/max(1,len(words))
    checks={"minimumWords":len(words)>=12,"lexicalDiversity":unique>=.35,"noDominantRepetition":dominant<=.22,"promptRelevance":bool(set(words)&expected),"noUnknownArtifacts":"<unk>" not in output and "\ufffd" not in output}
    return {"prompt":prompt,"output":output,"checks":checks,"passed":all(checks.values())}

def atomic_json(path,payload):
    temp=path+".tmp"
    with open(temp,"w",encoding="utf8") as handle: json.dump(payload,handle,indent=2)
    os.replace(temp,path)

def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--data",required=True); parser.add_argument("--out",required=True); parser.add_argument("--epochs",type=int,default=3); parser.add_argument("--max-len",type=int,default=192); parser.add_argument("--batch",type=int,default=32); parser.add_argument("--vocab-size",type=int,default=12000); parser.add_argument("--learning-rate",type=float,default=6e-4); args=parser.parse_args()
    os.makedirs(args.out,exist_ok=True); torch.manual_seed(1337); random.seed(1337); torch.set_num_threads(min(8,os.cpu_count() or 1))
    train_path=os.path.join(args.data,"train.jsonl.gz"); validation_path=os.path.join(args.data,"validation.jsonl.gz")
    vocab,token_to_id=build_vocab(train_path,args.vocab_size); train=Conversations(train_path,args.max_len,token_to_id); validation=Conversations(validation_path,args.max_len,token_to_id)
    train_loader=DataLoader(train,batch_size=args.batch,shuffle=True,collate_fn=collate); validation_loader=DataLoader(validation,batch_size=args.batch,shuffle=False,collate_fn=collate)
    config={"vocabSize":len(vocab),"d":192,"layers":4,"heads":6,"ff":768,"maxLen":args.max_len}; model=Decoder(len(vocab),max_len=args.max_len)
    optimizer=torch.optim.AdamW(model.parameters(),lr=args.learning_rate,weight_decay=.01); total_steps=args.epochs*len(train_loader); scheduler=torch.optim.lr_scheduler.CosineAnnealingLR(optimizer,T_max=total_steps,eta_min=args.learning_rate/10)
    started=time.time(); before=evaluate(model,validation_loader,len(vocab),40); steps=0; epoch_losses=[]
    for epoch in range(args.epochs):
        model.train(); running=0.; batches=0
        for inputs,targets in train_loader:
            optimizer.zero_grad(set_to_none=True); loss=nn.functional.cross_entropy(model(inputs).reshape(-1,len(vocab)),targets.reshape(-1),ignore_index=-100); loss.backward(); nn.utils.clip_grad_norm_(model.parameters(),1.); optimizer.step(); scheduler.step(); steps+=1; batches+=1; running+=loss.item()
            if steps%100==0: print(json.dumps({"step":steps,"totalSteps":total_steps,"loss":round(loss.item(),4),"elapsedSeconds":round(time.time()-started,1)}),flush=True)
        epoch_loss=running/max(1,batches); epoch_losses.append(epoch_loss)
        torch.save({"model":model.state_dict(),"optimizer":optimizer.state_dict(),"epoch":epoch+1,"step":steps,"config":config,"vocab":vocab},os.path.join(args.out,"checkpoint-latest.pt")); print(json.dumps({"epoch":epoch+1,"meanTrainLoss":epoch_loss}),flush=True)
    after=evaluate(model,validation_loader,len(vocab),100); artifact=os.path.join(args.out,"lari-native-decoder-v2.pt")
    torch.save({"model":model.state_dict(),"config":config,"vocab":vocab,"training":{"trainPairs":len(train),"validationPairs":len(validation),"epochs":args.epochs,"steps":steps,"seed":1337,"assistantOnlyLoss":True,"externalModelCalls":0}},artifact)
    samples=[assess_sample(prompt,generate(model,prompt,token_to_id,vocab),expected) for prompt,expected in PROBES]
    loss_gate=after<before and after<6.; generation_gate=all(sample["passed"] for sample in samples)
    report={"schemaVersion":2,"kind":"lari.native-decoder.training","createdAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"checkpoint":artifact,"checkpointSha256":hashlib.sha256(open(artifact,"rb").read()).hexdigest(),"parameters":sum(p.numel() for p in model.parameters()),"vocabSize":len(vocab),"trainPairs":len(train),"validationPairs":len(validation),"hiddenOpened":False,"validationLossBefore":before,"validationLossAfter":after,"validationPerplexityAfter":math.exp(min(20,after)),"epochTrainLosses":epoch_losses,"steps":steps,"elapsedSeconds":time.time()-started,"samples":samples,"externalModelCalls":0,"lossGatePassed":loss_gate,"generationGatePassed":generation_gate,"developmentQualified":loss_gate and generation_gate,"promotionQualified":False,"promotionBlocker":"Requires a separately executed sealed hidden evaluation, reload proof, and regression proof."}
    atomic_json(os.path.join(args.out,"training-report.json"),report); print(json.dumps(report,indent=2))
if __name__=="__main__": main()
