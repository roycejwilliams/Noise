# Stitches round-2 acted clips into pretend calls for the voice-flag probe:
# five caller moments per call, each with the flag it should (or shouldn't) raise.
import json,wave,os
D='data2'; os.makedirs(D+'/calls',exist_ok=True)
S={s['id']:s for s in json.load(open(D+'/scenarios.json'))}
CO=["Hey, it's Co. How's the week going?","Got it. And how are things otherwise?","Mm. What's next for you?","How did that land?","Anything else on your mind?"]
PLANS={'A':[('maskedshort_sad','sigh'),('congruent_sad',None),('maskedlong_calm',None),('incongruent1_angry','sarcasm'),('maskedlong_happy','laugh')],
       'B':[('maskedshort_happy','laugh'),('congruent_angry',None),('maskedshort_calm',None),('incongruent0_sad','forced_cheer'),('maskedlong_sad','sigh')]}
GAP=1.5
for v in ['roger','sarah','chris','jessica']:
    for name,plan in PLANS.items():
        frames=b'';t=0.0;turns=[];expect=[]
        for i,(k,cue) in enumerate(plan):
            s=S[f'{v}_{k}']; w=wave.open(f"{D}/audio/{s['id']}.wav"); sr=w.getframerate(); fr=w.readframes(w.getnframes())
            turns.append({'role':'agent','message':CO[i],'time_in_call_secs':round(t,1)}); t+=GAP*0.5
            turns.append({'role':'user','message':s['text'],'time_in_call_secs':round(t,1)})
            expect.append({'id':s['id'],'quote':s['text'],'cue':cue,'tone':s['tone'],'kind':s['kind']})
            frames+=b'\x00\x00'*int(sr*GAP*0.5)+fr+b'\x00\x00'*int(sr*GAP*0.5); t+=len(fr)/2/sr+GAP*0.5
        o=wave.open(f"{D}/calls/{v}_{name}.wav",'wb'); o.setnchannels(1); o.setsampwidth(2); o.setframerate(16000); o.writeframes(frames); o.close()
        json.dump({'turns':turns,'expect':expect},open(f"{D}/calls/{v}_{name}.json",'w'),indent=1)
print(len(os.listdir(D+'/calls'))//2,'calls')
