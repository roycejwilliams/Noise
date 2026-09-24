# Length and openers on the cases that truly call for a short reply
# (wantsShort, from tagShort.ts), plus the depth cases for contrast.
import json, re, sys
c = json.load(open('evals/texting/cases.local.json'))['cases']
echo = re.compile(r"^(That('s| is)\b|Got it[,.]|Fair[,.]|So (you|the)\b|Sounds like|Yeah, (the|that|no)\b|Right[,.])", re.I)
def sents(t): return len([x for x in re.split(r'(?<=[.!?])\s+', t.strip()) if x])
print(f"{'':16} {'SHORT: median words':>20} {'<=2 sentences':>14} {'echo opener':>12} {'DEPTH: median words':>20}")
for n in sys.argv[1:]:
    rs = {r['id']: r['reply'] for r in (json.load(open(f'evals/texting/results/{n}.local.json')) if n != 'actual' else [{'id': i, 'reply': x['reply']} for i, x in enumerate(c)])}
    sh = [rs[i] for i, x in enumerate(c) if x.get('wantsShort') and i in rs]
    dp = [rs[i] for i, x in enumerate(c) if not x.get('wantsShort') and i in rs]
    sw = sorted(len(r.split()) for r in sh); dw = sorted(len(r.split()) for r in dp)
    print(f"{n:16} {sw[len(sw)//2]:>20} {f'{sum(1 for r in sh if sents(r)<=2)}/{len(sh)}':>14} {f'{sum(1 for r in sh if echo.search(r.strip()))}/{len(sh)}':>12} {dw[len(dw)//2]:>20}")
