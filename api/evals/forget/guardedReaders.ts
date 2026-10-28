// The readers that already go through the forget guards on co-test (whatCoKnows.ts guardText / guardRows / guardBlock /
// guardCallMessages / forgets / forgetInSnapshot), pinned: a removed fact never comes back from them, a kept fact still does.
// forget-delete-spec.md section 7.5; context-across-cue-plan.md 3b. Layer 1: fake database and injected loaders, zero tokens.
//   npx tsx evals/forget/guardedReaders.ts
// (The readers that had no guard are draft #255's evals/forget/readers.ts; the deck sources are #251's.)
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import { readFileSync } from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const W = await import("../../src/services/whatCoKnows.js");
const MK = await import("../../src/services/memberKnowledge.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const U = "00000000-0000-4000-8000-0000000e1118";
const NOW = new Date();
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const GONE = /custody|hearing/i;
const CANARY = /climate founders/i;
const REMOVAL = { field: "claim", old_value: "the custody hearing in May", new_value: null, item_ref: "claim:1a2b3c4d", removed: "true" };
const removed = () => W.liveGuards([{ field: "claim", old: REMOVAL.old_value, now: null, ref: REMOVAL.item_ref, removed: true }]);
let corrections: any[] = [REMOVAL];
const handle = async (sql: string, p: any[] = []) => {
  if (/FROM profile_corrections pc WHERE pc\.user_id = \$1/.test(sql)) return { rows: p[0] === U ? corrections : [] };
  if (/FROM member_claims WHERE user_id = \$1 ORDER BY said_on/.test(sql)) return { rows: [
    { id: "c1", text: "They have the custody hearing in May.", provenance: "user_said", kind: "deadline", quote: "custody hearing in May", said_on: "2026-10-10", confirmed_on: "2026-10-10", expires_on: null },
    { id: "c2", text: "They want to meet climate founders.", provenance: "user_said", kind: "plan", quote: "climate founders", said_on: "2026-10-10", confirmed_on: "2026-10-10", expires_on: null },
  ] };
  return { rows: [] };
};
(pool as any).query = handle;
(pool as any).connect = async () => ({ query: handle, release: () => {} });
const texts = [
  { content: "User said: The custody hearing is in May, so things are heavy.", at: ago(5) },
  { content: "User said: I really want to meet climate founders.", at: ago(4) },
  { content: "User said: please forget the custody hearing stuff", at: ago(3) },
];

// 1. guardRows: the reply's last 20 texts (routes/sendblue.ts), and every reader of raw co_memories rows that uses it
{
  const g = await W.guardRows(U, texts);
  check("guardRows: the text that says it is gone, the canary stays", !g.some((r) => GONE.test(r.content)) && g.some((r) => CANARY.test(r.content)));
  check("guardRows: their ask to forget keeps only that it was asked", g.some((r) => /asked Cue to forget something/.test(r.content)));
  corrections = [];
  check("guardRows, no removals: the same rows, untouched", (await W.guardRows(U, texts)) === texts);
  corrections = [REMOVAL];
  check("wiring: the reply's thread and memory search read through the guards", /W\.guardRows\(user\.id, chronological\)/.test(src("routes/sendblue.ts")) && /removedRows\.W\.guardText\(c, removedRows\.rows\)/.test(src("routes/sendblue.ts")));
}

// 2. memberKnowledge exchanges (calls' last two days, tasks, follow-ups, dispatch, the sweep)
{
  const base: any = { profile: async () => ({ firstName: "Ellis", city: "Oakland", goals: [], intent: [], updatedAt: ago(10) }), zone: async () => "America/Los_Angeles", linkedNames: async () => [] };
  const k = await MK.memberKnowledge(U, { now: NOW, include: ["exchanges"], exchanges: 10, exchangeDays: 3 }, { ...base, exchanges: async () => texts, forgotten: async () => removed() });
  const ex = JSON.stringify(k.exchanges);
  check("memberKnowledge exchanges: nothing says it, the canary stays", !GONE.test(ex) && CANARY.test(ex));
  const none = await MK.memberKnowledge(U, { now: NOW, include: ["exchanges"], exchanges: 10, exchangeDays: 3 }, { ...base, exchanges: async () => texts, forgotten: async () => [] });
  check("memberKnowledge exchanges, no removals: the fixture reaches the record", GONE.test(JSON.stringify(none.exchanges)));
  // 3. the claims backstop (a claim row still in the table is never read)
  const claims = await MK.realKnowledgeDeps.claims(U, NOW, "America/Los_Angeles");
  check("memberKnowledge claims: the removed claim isn't read even while its row is still there; the canary claim is", !claims.some((c) => GONE.test(c.text)) && claims.some((c) => CANARY.test(c.text)));
}

// 4. guardBlock: the call's recap (callContext.ts) and 5. guardCallMessages: every turn of a live call (routes/callLlm.ts)
{
  const recap = "Ellis lives in Oakland.\nHe has the custody hearing in May.\nHe wants climate founders.";
  const b = W.guardBlock(recap, removed());
  check("guardBlock (the call recap): the line that says it is gone, the rest kept", !GONE.test(b) && CANARY.test(b) && /Oakland/.test(b));
  check("wiring: the call recap goes through guardBlock", /W\.guardBlock\(String\(safeRecap\[0\]\), await W\.forgottenRows\(userId\)\)/.test(src("services/callContext.ts")));
  const msgs = W.guardCallMessages([{ role: "system", content: recap }, { role: "user", content: "the custody hearing again" }], removed());
  check("guardCallMessages: the call's instructions lose it; the turn being spoken is left as said", !GONE.test(String(msgs[0].content)) && CANARY.test(String(msgs[0].content)) && GONE.test(String(msgs[1].content)));
  check("wiring: the call brain applies guardCallMessages every turn", /guardCallMessages\(body\.messages, rows\)/.test(src("routes/callLlm.ts")));
}

// 6. forgetInSnapshot: the snapshot rebuild (personSnapshot.ts)
{
  const s = W.forgetInSnapshot({ work: "Designer", place: "Oakland", wantsNow: ["get through the custody hearing in May", "meet climate founders"], weighingOn: ["the custody hearing in May"], valuesInPeople: [] }, removed());
  check("forgetInSnapshot: lists lose it, the canary want stays, place and work untouched", !GONE.test(JSON.stringify(s)) && CANARY.test(s.wantsNow.join()) && s.place === "Oakland" && s.work === "Designer");
}

// 7. safety: a line with a crisis signal is never cut, whatever was removed
{
  const line = "User said: the custody hearing in May makes me want to kill myself";
  check("guardText: a safety line is kept whole", W.guardText(line, removed()) === line);
}

// ================================================================ emotion reads (context-sources review, 2026-10-27)
// emotion_signals had no forget guard on any reader: a removed fact came back in "scared about the custody hearing". Its words go;
// the feeling's labels stay (timing and tone still read the hard day). Nothing is deleted (spec row 24 waits on Royce).
{
  const E = await import("../../src/harness/emotion.js");
  const sig = (about: string, quote: string, h: number) => ({ source: "text", emotion: "scared", intensity: "high", valence: "negative", about, quote, created_at: ago(h), target: "life", basis: null });
  const sigs = [sig("the custody hearing in May", "the custody hearing is in May", 1), sig("meeting climate founders", "I really want to meet climate founders", 2)];
  const prev = (pool as any).query;
  const withSignals = async (sql: string, p: any[] = []) => (/FROM emotion_signals\s+WHERE user_id = \$1 AND created_at > NOW\(\) - INTERVAL '14 days'/.test(sql) ? { rows: sigs } : handle(sql, p));
  (pool as any).query = withSignals;
  const ctx = await E.getEmotionalContext(U, NOW);
  const shown = E.renderEmotionalContext(ctx, NOW);
  check("emotion: the removed fact's words never come back in the emotional context", !GONE.test(JSON.stringify(ctx)) && !GONE.test(shown));
  check("emotion: the feeling stays (struggling, high, scared): timing and tone still read the hard day", ctx.current?.emotion === "scared" && ctx.current?.intensity === "high" && !!ctx.needsCare);
  const guarded = await E.forgetGuardedSignals(U, sigs);
  check("emotion: words a removal doesn't touch stay; the touched ones go, labels kept", guarded[1].about === "meeting climate founders" && CANARY.test(String(guarded[1].quote)) && guarded[0].about === null && guarded[0].quote === null && guarded[0].emotion === "scared");
  // A failed guard read leaves out every word (fails closed), never the feeling.
  (pool as any).query = async (sql: string, p: any[] = []) => (/FROM profile_corrections/.test(sql) ? Promise.reject(new Error("db down")) : withSignals(sql, p));
  const blind = await E.getEmotionalContext(U, NOW);
  const blindRows = await E.forgetGuardedSignals(U, sigs);
  check("emotion: a failed guard read leaves out every word, keeps the feeling", !GONE.test(JSON.stringify(blind)) && blind.current?.emotion === "scared" && blindRows.every((r) => r.about === null && r.quote === null && r.emotion === "scared"));
  (pool as any).query = prev;
  // Heavy moments (review of #282): every "don't check in" reads the raw words first, so a removal can only take a check-in away.
  const H = await import("../../src/services/heavyMoment.js");
  const hs = (emotion: string, intensity: string, about: string | null, quote: string | null, h: number) => ({ source: "text", emotion, intensity, valence: "negative", about, quote, target: "life", basis: null, at: ago(h) });
  const runHeavy = async (sigsH: any[]) => {
    const inserts: any[] = [];
    (pool as any).query = async (sql: string, p: any[] = []) => {
      if (/FROM users u\s+JOIN co_profiles cp/.test(sql)) return { rows: [{ user_id: U, city: null }] };
      if (/FROM emotion_signals WHERE user_id = \$1 AND created_at > \$2 ORDER BY created_at/.test(sql)) return { rows: sigsH };
      if (/INSERT INTO proactive_candidates/.test(sql)) { inserts.push(p); return { rows: [{ id: 1 }] }; }
      return handle(sql, p);
    };
    const prevConnect = (pool as any).connect;
    (pool as any).connect = async () => ({ query: (pool as any).query, release: () => {} });
    await H.queueHeavyCheckins(NOW).catch(() => 0);
    (pool as any).query = prev;
    (pool as any).connect = prevConnect;
    return inserts;
  };
  const curly = await runHeavy([hs("stressed", "medium", "work deadlines", "deadlines are piling up", 6), hs("desperate", "high", "the custody hearing in May", "I can\u2019t go on like this, the custody hearing in May", 5)]);
  check("heavy: a removal never lets a self-harm episode through (curly apostrophe, removed fact in the same line)", curly.length === 0);
  const leadGone = await runHeavy([hs("stressed", "medium", "work deadlines", "deadlines are piling up", 6), hs("scared", "high", "the custody hearing in May", "the custody hearing is in May", 5)]);
  check("heavy: an episode whose lead lost its words to a removal queues nothing (nothing specific left to ask about)", leadGone.length === 0);
  const control = await runHeavy([hs("stressed", "medium", "work deadlines", "deadlines are piling up", 6), hs("overwhelmed", "high", "the product launch", "the launch is crushing me", 5)]);
  check("heavy: an episode a removal doesn't touch still queues, with its words", control.length === 1 && /the product launch/.test(JSON.stringify(control[0])), control);
  // Every reader that puts their words in a prompt or a report reads through it.
  check("emotion: heavy moments, the picker's replay and the team review read through the guard", /forgetGuardedSignals\(u\.user_id, sig\)/.test(src("services/heavyMoment.ts")) && /forgetGuardedSignals\(userId, feelRaw/.test(src("services/sweepSelectContext.ts")) && /forgetGuardedSignals\(userId, r\.rows\)/.test(src("harness/devReview.ts")));
}

console.log(`forget guarded readers: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
