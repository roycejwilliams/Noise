import json,base64,urllib.request,sys,os,time,ssl,concurrent.futures as cf
CTX=ssl.create_default_context(cafile='/etc/ssl/cert.pem')
KEY=[l.split('=',1)[1].strip() for l in open('/Users/roycewilliams/copatible/api/.env') if l.startswith('CO_GEMINI_KEY=')][0]
MODEL='gemini-3.8-flash'
D=json.load(open('lines.json')); L=D['labels']
SCHEMA={'type':'OBJECT','properties':{k:{'type':'NUMBER'} for k in L},'required':L}
PROMPT=("Listen to this short clip of a person speaking. Judge the emotion in their VOICE (tone, pitch, pacing, energy), not just the words. "
 "For each emotion label, give a score from 0 to 1 for how strongly it is expressed in how they sound. Most labels should be near 0; "
 "only a few are normally high. Return every label.")
def score(line):
    out=f"out/{os.path.basename(line['clip'])[:-4]}.json"
    if os.path.exists(out): return out,None
    audio=base64.b64encode(open(line['clip'],'rb').read()).decode()
    body={'contents':[{'parts':[{'text':PROMPT},{'inlineData':{'mimeType':'audio/wav','data':audio}}]}],
          'generationConfig':{'responseMimeType':'application/json','responseSchema':SCHEMA,'temperature':0}}
    for a in range(4):
        try:
            r=urllib.request.urlopen(urllib.request.Request(f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent',json.dumps(body).encode(),{'x-goog-api-key':KEY,'Content-Type':'application/json'}),timeout=120,context=CTX)
            j=json.load(r); txt=j['candidates'][0]['content']['parts'][-1]['text']
            json.dump({'scores':json.loads(txt),'usage':j.get('usageMetadata')},open(out,'w')); return out,j.get('usageMetadata')
        except Exception as e:
            err=str(e)[:200]
            if hasattr(e,'read'):
                try: err=e.read().decode()[:300]
                except: pass
            time.sleep(3*(a+1))
    return out,'FAILED '+err
if __name__=='__main__':
    os.makedirs('out',exist_ok=True)
    n=int(sys.argv[1]) if len(sys.argv)>1 else len(D['lines'])
    lines=D['lines'][:n]
    with cf.ThreadPoolExecutor(4) as ex:
        res=list(ex.map(score,lines))
    fails=[r for r in res if isinstance(r[1],str)]
    print('done',len(res),'failed',len(fails)); 
    for f in fails[:3]: print(f)
    print('sample usage',next((r[1] for r in res if isinstance(r[1],dict)),None))
