import os as _o
D='data' if _o.environ.get('ROUND','1')=='1' else 'data'+_o.environ['ROUND']
import json,os,urllib.request,ssl,wave,concurrent.futures as cf
from scenarios import scenarios
CTX=ssl.create_default_context(cafile='/etc/ssl/cert.pem')
KEY=[l.split('=',1)[1].strip() for l in open('/Users/roycewilliams/copatible/api/.env') if l.startswith('ELEVENLABS_API_KEY=')][0]
os.makedirs(D+'/audio',exist_ok=True)
S=scenarios(); json.dump(S,open(D+'/scenarios.json','w'),indent=1)
def gen(s):
    p=f"{D}/audio/{s['id']}.wav"
    if os.path.exists(p): return None
    body={'text':s['say'],'model_id':'eleven_v3','voice_settings':{'stability':0.0}}
    for a in range(3):
        try:
            r=urllib.request.urlopen(urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{s['voice_id']}?output_format=pcm_16000",json.dumps(body).encode(),{'xi-api-key':KEY,'Content-Type':'application/json'}),timeout=120,context=CTX)
            pcm=r.read(); w=wave.open(p,'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm); w.close(); return None
        except Exception as e:
            err=e.read().decode()[:300] if hasattr(e,'read') else str(e)
    return s['id']+': '+err
import sys
n=int(sys.argv[1]) if len(sys.argv)>1 else len(S)
with cf.ThreadPoolExecutor(3) as ex: fails=[f for f in ex.map(gen,S[:n]) if f]
print(len(S),'scenarios; generated',n,'; failed',len(fails)); [print(f) for f in fails[:5]]
print('chars',sum(len(s['say']) for s in S[:n]))
