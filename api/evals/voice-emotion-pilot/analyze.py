import json,os,collections,statistics as st
D=json.load(open('lines.json')); lines=D['lines']
FAM={'Anger/frustration':['Anger','Contempt','Disgust'],
 'Anxiety/distress':['Anxiety','Fear','Distress','Horror'],
 'Sadness/low':['Sadness','Disappointment','Pain','Tiredness'],
 'Joy/excitement':['Joy','Amusement','Excitement','Ecstasy','Triumph'],
 'Warmth/connection':['Love','Adoration','Admiration','Sympathy','Romance'],
 'Calm/content':['Calmness','Contentment','Relief'],
 'Interest/thinking':['Interest','Concentration','Contemplation','Realization','Determination'],
 'Confusion/awkward':['Confusion','Doubt','Awkwardness','Embarrassment']}
for l in lines:
    g=json.load(open(f"out/{os.path.basename(l['clip'])[:-4]}.json"))['scores']
    l['gem']=g
    l['hf']={f:max(l['hume'][k] for k in ks) for f,ks in FAM.items()}
    l['gf']={f:max(g.get(k,0) for k in ks) for f,ks in FAM.items()}
def rank(v):
    o=sorted(range(len(v)),key=lambda i:v[i]); r=[0]*len(v); i=0
    while i<len(o):
        j=i
        while j+1<len(o) and v[o[j+1]]==v[o[i]]: j+=1
        for k in range(i,j+1): r[o[k]]=(i+j)/2
        i=j+1
    return r
def sp(a,b):
    if len(a)<3 or len(set(a))<2 or len(set(b))<2: return None
    ra,rb=rank(a),rank(b); ma,mb=st.mean(ra),st.mean(rb)
    n=sum((x-ma)*(y-mb) for x,y in zip(ra,rb)); d=(sum((x-ma)**2 for x in ra)*sum((y-mb)**2 for y in rb))**.5
    return n/d if d else None
calls=collections.defaultdict(list)
for l in lines: calls[l['call']].append(l)
print(f'{len(lines)} lines, {len(calls)} calls\n')
print(f"{'family':20}{'all lines':>10}{'within-call avg':>17}{'top-3 hit':>11}{'chance':>8}")
rows=[]
for f in FAM:
    allr=sp([l['hf'][f] for l in lines],[l['gf'][f] for l in lines])
    per=[];hit=0;tot=0;ch=0
    for c,ls in calls.items():
        r=sp([l['hf'][f] for l in ls],[l['gf'][f] for l in ls])
        if r is not None: per.append(r)
        k=min(3,len(ls)); ht=set(sorted(range(len(ls)),key=lambda i:-ls[i]['hf'][f])[:k]); gt=set(sorted(range(len(ls)),key=lambda i:-ls[i]['gf'][f])[:k])
        hit+=len(ht&gt); tot+=k; ch+=k*k/len(ls)
    print(f"{f:20}{allr:>10.2f}{(st.mean(per) if per else float('nan')):>17.2f}{hit/tot:>11.2f}{ch/tot:>8.2f}")
# dominant family agreement
agree=sum(1 for l in lines if max(FAM,key=lambda f:l['hf'][f])==max(FAM,key=lambda f:l['gf'][f]))
print(f"\ntop family per line matches: {agree}/{len(lines)} = {agree/len(lines):.0%} (chance ~{1/len(FAM):.0%})")
# raw 48-label per-line profile correlation
pr=[sp([l['hume'][k] for k in D['labels']],[l['gem'][k] for k in D['labels']]) for l in lines]
pr=[x for x in pr if x is not None]; print(f"per-line 48-label profile correlation: median {st.median(pr):.2f}")
# score scale
print('mean top Hume score %.2f vs top Gemini %.2f'%(st.mean(max(l['hume'].values()) for l in lines),st.mean(max(l['gem'].values()) for l in lines)))
# disagreements: biggest rank gaps within percentile of all lines per family
dis=[]
for f in ['Anger/frustration','Anxiety/distress','Sadness/low','Joy/excitement','Confusion/awkward']:
    rh=rank([l['hf'][f] for l in lines]); rg=rank([l['gf'][f] for l in lines]); n=len(lines)
    for l,a,b in zip(lines,rh,rg):
        dis.append((abs(a-b)/n,f,a/n,b/n,l))
dis.sort(key=lambda x:-x[0]); seen=set(); picks=[]
for g,f,a,b,l in dis:
    key=(l['call'],l['begin_ms'])
    if key in seen: continue
    seen.add(key); picks.append((f,a,b,l))
    if len(picks)==8: break
print('\nDISAGREEMENTS (percentile of 216 lines, 1.0 = strongest):')
for f,a,b,l in picks:
    m=l['begin_ms']//1000
    print(f"- {l['call']} @ {m//60}:{m%60:02d} [{f}] Hume {a:.2f} vs Gemini {b:.2f} | {l['clip']} | \"{l['text'][:110]}\"")
json.dump([{'call':l['call'],'begin_ms':l['begin_ms'],'clip':l['clip'],'family':f,'hume_pct':a,'gemini_pct':b,'text':l['text']} for f,a,b,l in picks],open('disagreements.json','w'),indent=1)
