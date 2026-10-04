import json,os,subprocess,wave
H='/Users/roycewilliams/copatible-backups/hume-2026-10-03/'
S=[s for s in json.load(open('/tmp/set27.json')) if s['cls'] in ('Royce','Test account')]
data=[];labels=None
for s in S:
    cid=s['chat']
    wav=f'wav/{cid}.wav'
    if not os.path.exists(wav):
        subprocess.run(['afconvert','-f','WAVE','-d','LEI16@16000','-c','1',H+f'audio/{cid}.audio',wav],check=True)
    w=wave.open(wav); sr=w.getframerate(); n=w.getnframes()
    for e in json.load(open(H+f'events/{cid}.json')):
        if e['type']!='USER_MESSAGE': continue
        try: m=json.loads(e['metadata']); ef=json.loads(e['emotion_features'])
        except: continue
        for i,sg in enumerate(m.get('segments',[])):
            txt=sg.get('content') or ''
            if len(txt.split())<3 or len(sg.get('scores') or [])!=48: continue
            b,en=sg['time']['begin_ms'],sg['time']['end_ms']
            labels=labels or list(ef.keys())
            clip=f'clips/{cid[:8]}_{b}.wav'
            w.setpos(int(b/1000*sr)); fr=w.readframes(min(int((en-b)/1000*sr),n-int(b/1000*sr)))
            o=wave.open(clip,'wb'); o.setnchannels(1); o.setsampwidth(2); o.setframerate(sr); o.writeframes(fr); o.close()
            data.append({'call':cid[:8],'who':s['cls'],'begin_ms':b,'end_ms':en,'clip':clip,'text':txt,'hume':dict(zip(labels,sg['scores']))})
json.dump({'labels':labels,'lines':data},open('lines.json','w'))
print(len(S),'calls',len(data),'lines; total clip seconds',round(sum((d['end_ms']-d['begin_ms'])/1000 for d in data)))
print(labels)
