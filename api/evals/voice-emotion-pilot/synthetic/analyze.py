import os as _o
D='data' if _o.environ.get('ROUND','1')=='1' else 'data'+_o.environ['ROUND']
import json,re,wave,array,math,collections,statistics as st
S=json.load(open(D+'/scenarios.json')); FEEL=['calm','happy','sad','angry','anxious']
FAM={'happy':['excit','happy','proud','relie','grate','joy','thrill','hope','elat','glad','ecsta','overjoy'],
 'sad':['sad','grie','discour','lonel','down','hurt','disappoint','heartbr','tired','exhaust','mourn','loss','bereav','sorrow','low'],
 'angry':['frustr','anger','angry','annoy','irrit','fed up','resent','betray','furious','upset'],
 'anxious':['anxi','nerv','stress','worr','overwhel','scare','afraid','uneas','tense','apprehen','pressure','unsettl']}
def fam(e):
    if not e: return 'calm'
    e=e.lower()
    for f,ks in FAM.items():
        if any(k in e for k in ks): return f
    return 'other:'+e
R={s['id']:json.load(open(f"{D}/reads/{s['id']}.json")) for s in S}
rows=[]
for s in S:
    r=R[s['id']]
    rows.append({**s,'co':fam(r['co_text'].get('emotion')),'co_raw':r['co_text'].get('emotion'),'gt':r['gem_text']['feeling'],'ga':r['gem_audio']['feeling'],'ga_conf':r['gem_audio']['confidence'],'why':r['gem_audio']['why'],'heard':r['gem_audio']['transcript']})
# leak check
TAGW=re.compile(r'\[|\b(calm|excited|sad|angry|nervous|laughs?|sighs?|shouting|stammers?)\b',re.I)
leak=[r['id'] for r in rows if any(m.group(0).lower() not in r['text'].lower() for m in TAGW.finditer(r['heard']))]
print('TAG LEAK (tag words heard but not in script):',len(leak),leak[:6])
# acoustic check
def feats(p):
    w=wave.open(p); a=array.array('h',w.readframes(w.getnframes())); sr=w.getframerate()
    fr=int(sr*0.03); rms=[math.sqrt(sum(x*x for x in a[i:i+fr])/fr)+1e-9 for i in range(0,len(a)-fr,fr)]
    db=[20*math.log10(x) for x in rms]; top=max(db)
    voiced=[d for d in db if d>top-30]
    return len(a)/sr, st.mean(voiced), st.pstdev(voiced), 1-len(voiced)/len(db)
print('\nACOUSTIC CHECK by acted tone (masked lines only, same words across tones):')
print(f"{'tone':8}{'words/sec':>10}{'loudness dB':>13}{'loudness var':>14}{'pause %':>9}")
for t in FEEL:
    fs=[];
    for r in rows:
        if r['tone']==t and r['kind'].startswith('masked'):
            d,m,v,p=feats(f"{D}/audio/{r['id']}.wav"); fs.append((len(r['text'].split())/d,m,v,p))
    print(f"{t:8}"+"".join(f"{st.mean(x[i] for x in fs):>{w}.{2 if i==0 else 1}f}" for i,w in [(0,10),(1,13),(2,14)])+f"{st.mean(x[3] for x in fs)*100:>8.0f}%")
def acc(rs,k): return sum(r[k]==r['tone'] for r in rs)/len(rs) if rs else float('nan')
print('\nACCURACY vs acted feeling (n per row):')
print(f"{'condition':34}{'n':>4}{'Co text read':>14}{'Gemini words':>14}{'Gemini audio':>14}")
groups=[('Calm words, feeling only in voice - short','masked_short',lambda r:r['tone']!='calm'),
 ('Calm words, feeling only in voice - long','masked_long',lambda r:r['tone']!='calm'),
 ('Calm words, calm voice (false alarms)','masked',lambda r:r['tone']=='calm'),
 ('Cheerful words, unhappy voice','incongruent',lambda r:True),
 ('Words and voice agree (emotional)','congruent',lambda r:r['tone']!='calm'),
 ('Words and voice agree (calm)','congruent',lambda r:r['tone']=='calm')]
for name,kind,f in groups:
    rs=[r for r in rows if r['kind'].startswith(kind) and f(r)]
    print(f"{name:34}{len(rs):>4}"+"".join(f"{acc(rs,k):>14.0%}" for k in ('co','gt','ga')))
print(f"{'ALL':34}{len(rows):>4}"+"".join(f"{acc(rows,k):>14.0%}" for k in ('co','gt','ga')))
print('\nGEMINI AUDIO confusion, feeling only in voice (rows=acted, cols=heard):')
rs=[r for r in rows if r['kind'].startswith('masked')]
print(' '*9+''.join(f'{f:>9}' for f in FEEL))
for t in FEEL: print(f'{t:9}'+''.join(f"{sum(1 for r in rs if r['tone']==t and r['ga']==f):>9}" for f in FEEL))
print('\nby voice (Gemini audio, feeling only in voice, non-calm):')
for v in ['roger','sarah','chris','jessica']:
    x=[r for r in rows if r['voice']==v and r['kind'].startswith('masked') and r['tone']!='calm']; print(' ',v,f"{acc(x,'ga'):.0%}")
print('\nCo text-read labels that did not map:',collections.Counter(r['co'] for r in rows if r['co'].startswith('other')))
json.dump(rows,open(D+'/results.json','w'),indent=1)
