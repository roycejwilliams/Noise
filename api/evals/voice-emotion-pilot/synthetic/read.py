import os as _o
D='data' if _o.environ.get('ROUND','1')=='1' else 'data'+_o.environ['ROUND']
import json,os,base64,urllib.request,ssl,re,concurrent.futures as cf
from scenarios import CONTEXT
CTX=ssl.create_default_context(cafile='/etc/ssl/cert.pem')
ENV={l.split('=',1)[0]:l.split('=',1)[1].strip() for l in open('/Users/roycewilliams/copatible/api/.env') if '=' in l and not l.startswith('#')}
GK,AK=ENV['CO_GEMINI_KEY'],ENV['ANTHROPIC_API_KEY']
S=json.load(open(D+'/scenarios.json')); os.makedirs(D+'/reads',exist_ok=True)
FEEL=['calm','happy','sad','angry','anxious']
ASK=("How is this person feeling? Choose one: calm (neutral, no strong feeling), happy (happy/excited), sad (sad/down), "
     "angry (angry/frustrated), anxious (anxious/stressed). Give your confidence 0-1 and a few words on why.")
def post(url,body,hdr):
    for a in range(3):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(url,json.dumps(body).encode(),{**hdr,'Content-Type':'application/json'}),timeout=120,context=CTX))
        except Exception as e: err=e.read().decode()[:300] if hasattr(e,'read') else str(e)
    raise RuntimeError(err)
def gemini(parts,schema):
    j=post('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
        {'contents':[{'parts':parts}],'generationConfig':{'responseMimeType':'application/json','responseSchema':schema,'temperature':0}},{'x-goog-api-key':GK})
    return json.loads(j['candidates'][0]['content']['parts'][-1]['text'])
BASE={'feeling':{'type':'STRING','enum':FEEL},'confidence':{'type':'NUMBER'},'why':{'type':'STRING'}}
def gem_audio(s):
    a=base64.b64encode(open(f"{D}/audio/{s['id']}.wav",'rb').read()).decode()
    sch={'type':'OBJECT','properties':{**BASE,'transcript':{'type':'STRING'}},'required':['feeling','confidence','why','transcript']}
    return gemini([{'text':f"This is someone answering Co, who asked: \"{CONTEXT[4:]}\". Listen to their answer. Judge from both what they say and how they sound. {ASK} Also write the exact words they said."},{'inlineData':{'mimeType':'audio/wav','data':a}}],sch)
def gem_text(s):
    sch={'type':'OBJECT','properties':BASE,'required':['feeling','confidence','why']}
    return gemini([{'text':f"Co asked: \"{CONTEXT[4:]}\"\nThey texted back: \"{s['text']}\"\n{ASK}"}],sch)
def co_text(s):
    prompt=f'''Read the latest text someone sent Co, with the conversation before it for context.

Recent conversation, in order:
{CONTEXT}

Latest message: "{s['text']}"

Does the latest message carry a real feeling Co should respond to (for example stressed, anxious, discouraged, lonely, frustrated, excited, proud, relieved)? Use the conversation to read it correctly: "fine" after bad news isn't fine. Ignore plain logistics, greetings, and tone you aren't confident about; most messages have none. "about" uses only what they actually said, never an assumed circumstance.

"target" is who the feeling is about: "co" when it's about Co itself (what Co found or didn't find, Co's suggestions, replies, speed, or mistakes, like "you keep finding nothing" or "that's not what I asked"), otherwise "life" (their work, people, plans, health, anything else).

Return ONLY JSON: {{"emotion": "one or two words" or null, "intensity": "low" | "medium" | "high", "valence": "negative" | "positive" | "mixed", "about": "what the feeling is about, in a few words, or null", "target": "co" | "life"}}'''
    j=post('https://api.anthropic.com/v1/messages',{'model':'claude-haiku-4-5-20251001','max_tokens':300,'messages':[{'role':'user','content':prompt}]},{'x-api-key':AK,'anthropic-version':'2023-06-01'})
    t=j['content'][0]['text']; m=re.search(r'\{.*\}',t,re.S); return json.loads(m.group(0))
def run(s):
    p=f"{D}/reads/{s['id']}.json"
    if os.path.exists(p): return None
    try:
        r={'gem_audio':gem_audio(s),'gem_text':gem_text(s),'co_text':co_text(s)}
        json.dump(r,open(p,'w'),indent=1)
    except Exception as e: return s['id']+': '+str(e)[:200]
with cf.ThreadPoolExecutor(4) as ex: fails=[f for f in ex.map(run,S) if f]
print('failed',len(fails)); [print(f) for f in fails[:5]]
