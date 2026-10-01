// Live, paid: semantic-memory retrieval, relevance selection and grounded reply
// use, against a session-local temp copy of co_memories (2026-10-01 baseline).
// Nothing is written to real tables (temp table, rolled back; the shared pool
// refuses writes and counts the attempts) and nothing is sent (dryRun). Needs
// ANTHROPIC_API_KEY, OPENAI_API_KEY and a dev DATABASE_URL. About $1-2.
//
//   cd api && npx tsx evals/memory/semanticLive.ts > semantic-memory-results.local.log 2>&1
//
// Fixes from the brief's draft (2026-10-01 review):
//  1. correction: the stale Austin memory ('old') is a reject, so selecting it fails the case.
//  2. decoy-owner: "must" uses word boundaries, so "know" no longer counts as "no".
//  3. Write guard covers pool.connect() clients too, allows read-only WITH queries and transaction
//     control, and counts every blocked write (SEM_CLEANUP blockedWrites) instead of declaring 0.
//  4. Facts carry today's date and the current time, worded as production adds them
//     (replyGrounding.gatherReplyFacts, timeline.renderTimeline with an unknown time zone).
import '../testEnv.js';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { DateTime } from 'luxon';
const out = console.log.bind(console);
const nativeFetch=globalThis.fetch; const usageTasks:Promise<void>[]=[];const usage:any[]=[];
globalThis.fetch=async (...args:any[])=>{
 const response=await (nativeFetch as any)(...args);
 const url=String(args[0]?.url||args[0]);
 if(url.includes('api.openai.com')||url.includes('api.anthropic.com')){
  const clone=response.clone();
  usageTasks.push((async()=>{
   const body=await clone.text();let model='unknown';let input=0,output=0,cacheRead=0,cacheWrite=0;
   for(const line of body.trim().startsWith('{')?[body]:body.split('\n')){try{const j=JSON.parse(line.startsWith('data: ')?line.slice(6):line); const x=j.message||j;model=x.model||model; const u=x.usage||j.usage;if(u){input=Math.max(input,u.input_tokens||u.prompt_tokens||0);output=Math.max(output,u.output_tokens||0);cacheRead=Math.max(cacheRead,u.cache_read_input_tokens||0);cacheWrite=Math.max(cacheWrite,u.cache_creation_input_tokens||0);}}catch{}}
   usage.push({provider:url.includes('openai')?'openai':'anthropic',model,status:response.status,input,output,cacheRead,cacheWrite});
  })().catch(()=>{}));
 }
 return response;
};
console.log = () => {};
console.error = () => {};
const { generateEmbeddings, generateEmbedding } = await import('../../src/services/embeddings.js');
const { filterRelevantMemories, runConversationReplyAgent } = await import('../../src/agent/conversationReply.js');
const G = await import('../../src/harness/replyGrounding.js');
const { renderTimeline } = await import('../../src/services/timeline.js');
const productionPool = (await import('../../src/db/db.js')).default;
// Only reads reach the real database. Transaction control is allowed (it changes nothing by itself);
// anything that could write is refused and counted.
let blockedWrites = 0;
// Only statements starting SELECT/WITH get through, so this only has to catch what can write from
// inside one: data-modifying CTEs, SELECT INTO, row locks and sequence changes.
const WRITE = /\b(INSERT|UPDATE|DELETE|MERGE|INTO|NEXTVAL|SETVAL)\b|\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE|KEY\s+SHARE)\b/i;
const isAllowed = (sql: string) => {
  const s = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, ' ').trim();
  if (/^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(s)) return true;
  return /^(SELECT|WITH)\b/i.test(s) && !WRITE.test(s);
};
const guard = (query: any) => (...args: any[]) => {
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
  if (!isAllowed(sql || '')) { blockedWrites++; return Promise.reject(new Error('Test forbids production writes')); }
  return query(...args);
};
(productionPool as any).query = guard(productionPool.query.bind(productionPool));
const rawConnect = productionPool.connect.bind(productionPool) as any;
(productionPool as any).connect = (cb?: any) => {
  const wrap = (client: any) => { if (client && !client.__guarded) { client.query = guard(client.query.bind(client)); client.__guarded = true; } return client; };
  if (typeof cb === 'function') return rawConnect((err: any, client: any, done: any) => cb(err, wrap(client), done));
  return rawConnect().then(wrap);
};
const sql = `SELECT content FROM co_memories
               WHERE user_id = $1 AND content_embedding IS NOT NULL AND memory_type != 'intent'
               ORDER BY content_embedding <=> $2::vector
               LIMIT 5`;
const normalized = (s:string) => s.replace(/\s+/g,' ').trim();
if (!normalized(readFileSync(new URL('../../src/routes/sendblue.ts', import.meta.url),'utf8')).includes(normalized(sql))) throw new Error('Production retrieval SQL changed');
const A='d6e9a9ea-81fe-4c66-a7a9-6af110010001', B='d6e9a9ea-81fe-4c66-a7a9-6af110010002', EMPTY='d6e9a9ea-81fe-4c66-a7a9-6af110010003';
const fixtures = [
 ['taste',A,'text_exchange','User said: Crowded mixers drain me. I connect best at small dinner tables with six or eight people and thoughtful conversation.'],
 ['person',A,'text_exchange','User said: My mentor Lena reviews my hardware startup pitch every Friday. She is the person I call when I get stuck.'],
 ['decoy',A,'text_exchange','User said: My brother loves loud crowded networking mixers, but those are not my thing.'],
 ['stale',A,'recommendation','Co proposed meeting a ceramic artist at 3pm on September 3, 2025. The user never accepted that proposal.'],
 ['old',A,'text_exchange','User said on January 5, 2025: I live in Austin and want to meet founders there.'],
 ['new',A,'text_exchange','User said on September 29, 2026: I moved from Austin to Portland. Portland is my home now and I want founder dinners here.'],
 ['intent',A,'intent','User secret intent marker: ORANGE-VAULT-827. I want an orange vault business partner.'],
 ['other',B,'text_exchange','User said: My mentor is Ravi and my confidential startup is called ZEBRA-VAULT-941. I live in Miami.'],
 ['other-taste',B,'text_exchange','User said: I want loud networking mixers with 500 people and no sit-down dinner.'],
] as const;
const cases = [
 {id:'paraphrase',user:A,message:'What kind of gathering actually fits how I like to connect?',retrieve:['taste'],select:['taste'],reject:['other','other-taste','intent'],must:/small|dinner|six|eight/i,not:/ZEBRA|Ravi|500/i},
 {id:'relationship',user:A,message:'Who do I usually turn to when my startup pitch has me stuck?',retrieve:['person'],select:['person'],reject:['other','intent'],must:/Lena/i,not:/Ravi|ZEBRA/i},
 {id:'decoy-owner',user:A,message:'Would a loud packed networking mixer suit me personally?',retrieve:['taste','decoy'],select:['taste'],reject:['other-taste','intent'],must:/\bnot\b|\bno\b|small|dinner|drain/i,not:/you love loud|you prefer loud|500/i},
 {id:'stale-context',user:A,message:'I am thinking of a quiet founder dinner next week. What format suits me?',retrieve:['taste'],select:['taste'],reject:['stale','intent'],must:/small|dinner|six|eight/i,not:/3pm|ceramic|September 3/i},
 {id:'correction',user:A,message:'Where should I look locally for founder dinners now?',recent:'User: I moved from Austin to Portland this week. Portland is home now.\nCo: Got it, Portland.',retrieve:['new'],select:['new'],reject:['old','other','intent'],must:/Portland/i,not:/in Austin|Austin is your home|Miami/i},
 {id:'intent-exclusion',user:A,message:'Do you remember anything about my orange vault business partner?',retrieve:[],select:[],reject:['intent','other'],not:/ORANGE-VAULT-827|ZEBRA-VAULT-941/i},
 {id:'cross-user',user:B,message:'Who is my mentor and what is my startup called?',retrieve:['other'],select:['other'],reject:['person','taste','intent'],must:/Ravi/i,must2:/ZEBRA-VAULT-941/i,not:/Lena|hardware startup|Portland/i},
 {id:'empty-user',user:EMPTY,message:'Who is my mentor and what is my startup called?',retrieve:[],select:[],reject:fixtures.map(x=>x[0]),not:/Lena|Ravi|ZEBRA|hardware|Portland|Miami/i},
];
const p = new Pool({connectionString:process.env.DATABASE_URL,max:1});
const c=await p.connect(); let failures=0, count=0;
const watchdog=setTimeout(()=>process.exit(2),25*60*1000);
try {
 await c.query('BEGIN');
 await c.query("SET LOCAL statement_timeout = '5s'");
 await c.query('CREATE TEMP TABLE co_memories ON COMMIT DROP AS SELECT user_id,memory_type,content,content_embedding,created_at FROM public.co_memories WHERE false');
 const vectors=await generateEmbeddings(fixtures.map(x=>x[3]));
 if(vectors.length!==fixtures.length||vectors.some(v=>v.length!==1536)) throw new Error('Wrong vector dimensions');
 for(let i=0;i<fixtures.length;i++){
  const f=fixtures[i];
  await c.query('INSERT INTO pg_temp.co_memories (user_id,memory_type,content,content_embedding,created_at) VALUES ($1,$2,$3,$4::vector,NOW())',[f[1],f[2],f[3],`[${vectors[i].join(',')}]`]);
 }
 out('SEM_SETUP '+JSON.stringify({fixtures:fixtures.length,dimensions:1536,temp:true,productionSqlVerified:true}));
 for(const t of cases) for(let run=1;run<=2;run++){
  const q=await generateEmbedding(t.message);
  const rows=await c.query(sql,[t.user,`[${q.join(',')}]`]);
  const candidates=rows.rows.map(x=>x.content);
  const ids=candidates.map(s=>fixtures.find(f=>f[3]===s)?.[0]);
  const selected=await filterRelevantMemories(t.message,candidates);
  const selectedIds=fixtures.filter(f=>selected.includes(f[3])).map(f=>f[0]);
  const retrievalMiss=t.retrieve.filter(x=>!ids.includes(x));
  const retrievalLeaks=ids.filter(x=>fixtures.find(f=>f[0]===x)?.[1]!==t.user || x==='intent');
  const selectionMiss=t.select.filter(x=>!selectedIds.includes(x));
  const selectionLeaks=t.reject.filter(x=>selectedIds.includes(x));
  const facts=G.baseReplyFacts();
  // Synthetic members have no city, so production shows Pacific time and says the zone is unknown.
  const now=DateTime.now().setZone('America/Los_Angeles');
  G.addFact(facts,'known',`Today is ${now.toFormat('cccc, LLLL d, yyyy')} (Pacific time).`);
  G.addFact(facts,'known',renderTimeline(now,[],false));
  const r=await runConversationReplyAgent({ackSent:null,userId:t.user,phoneNumber:'+10000000000',firstName:'Avery',resolvedContent:t.message,isVoice:false,imageForVision:null,hasPendingOffer:false,recentOfferBurstActive:false,callAction:'none',isThinProfileFirstMessage:false,isFirstContact:false,missingTopic:null,missingTopicDescription:null,facts,toneContext:'',seekingModeContext:'',styleHint:'',recentConversation:t.recent||'',recentMemories:selected,contextSummary:'',personaPrompt:null,sendCoReply:async()=>{throw new Error('No delivery allowed');}}, {dryRun:true,record:false,stubSearch:true});
  const text=r.replyText||'';
  const replyMiss=[t.must&&!t.must.test(text)?'missing expected detail':null,t.must2&&!t.must2.test(text)?'missing expected marker':null,t.not?.test(text)?'forbidden detail':null,!text?'empty reply':null].filter(Boolean);
  const ok=!retrievalMiss.length&&!retrievalLeaks.length&&!selectionMiss.length&&!selectionLeaks.length&&!replyMiss.length;
  if(!ok) failures++; count++;
  out('SEM_CASE '+JSON.stringify({id:t.id,run,ok,candidates:ids,selected:selectedIds,retrievalMiss,retrievalLeaks,selectionMiss,selectionLeaks,replyMiss,text,tools:r.toolsCalled,blockedWritesSoFar:blockedWrites,grounding:r.grounding.map((g:any)=>({outcome:g.outcome,failed:(g.checks||[]).filter((x:any)=>!x.pass).map((x:any)=>x.name)}))}));
 }
} catch(e:any) { failures++;out('SEM_ERROR '+JSON.stringify({name:e?.name||'Error',code:/^[A-Z0-9_]{1,20}$/.test(e?.code||'')?e.code:undefined,status:e?.status,stage:'test failed; no secret details logged'})); }
finally {
 await c.query('ROLLBACK');
 const gone=await c.query("SELECT to_regclass('pg_temp.co_memories') AS table_name");
 out('SEM_CLEANUP '+JSON.stringify({rolledBack:true,tempTableGone:gone.rows[0].table_name===null,blockedWrites,note:'blockedWrites counts refused write attempts through the shared pool; refused writes never reached the database'}));
 c.release();await p.end();await productionPool.end();
}
clearTimeout(watchdog);await Promise.all(usageTasks);out('SEM_USAGE '+JSON.stringify(usage));
out('SEM_RESULT '+JSON.stringify({count,failures}));
process.exit(0);
