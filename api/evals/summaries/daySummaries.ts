// Rolling daily summaries of older conversation (services/daySummaries.ts). Layer 1: a fake database over fixture rows and a stubbed
// model, zero tokens. Invented members: Jordan (the member) and Priya (another member whose rows and name must never reach Jordan).
//   TZ=UTC npx tsx evals/summaries/daySummaries.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const D = await import("../../src/services/daySummaries.js");
const W = await import("../../src/services/whatCoKnows.js");
const fs = await import("node:fs");
const path = await import("node:path");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) { failed++; console.log(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`); }
};

type Row = { id: string; user_id: string; memory_type: string; content: string; created_at: Date };
type Sum = { id: string; user_id: string; day: string; zone: string | null; summary: string; status: string; source_ids: string[]; source_stamp: string; model: string };
const JORDAN = "00000000-0000-4000-8000-00000000a001";
const PRIYA = "00000000-0000-4000-8000-00000000b002";
let seq = 0;
const rows: Row[] = [];
const sums: Sum[] = [];
const asked: { sql: string; args: unknown[] }[] = [];
let sumSeq = 0;
const corrections: any[] = [];
const add = (user_id: string, at: string, memory_type: string, content: string) => { rows.push({ id: `row-${String(++seq).padStart(4, "0")}`, user_id, memory_type, content, created_at: new Date(at) }); return rows[rows.length - 1].id; };
const longText = (s: string) => `${s} ${"and we talked it over for a while, ".repeat(9)}`;

const db = {
  query: async (sql: string, args: unknown[] = []) => {
    asked.push({ sql, args });
    const u = args[0] as string;
    if (/FROM users u\s+WHERE u\.archived_at/.test(sql)) {
      const ids = [...new Set(rows.filter((r) => +r.created_at >= +(args[0] as Date) && +r.created_at < +(args[1] as Date)).map((r) => r.user_id))];
      const have = (id: string) => sums.filter((x) => x.user_id === id).length;
      return { rows: ids.sort((a, b) => have(a) - have(b) || a.localeCompare(b)).map((user_id) => ({ user_id })) };
    }
    if (/FROM profile_corrections/.test(sql)) return { rows: corrections.filter(() => true) };
    if (/status FROM member_day_summaries WHERE user_id = \$1 AND status <> 'removed'$/.test(sql.trim())) return { rows: sums.filter((x) => x.user_id === u && x.status !== "removed") };
    if (/^SELECT 1 FROM member_day_summaries/.test(sql.trim())) return { rows: sums.filter((s) => s.user_id === u).slice(0, 1).map(() => ({ "?column?": 1 })) };
    if (/SELECT to_char\(day, 'YYYY-MM-DD'\) AS day FROM member_day_summaries WHERE user_id = \$1$/.test(sql.trim())) return { rows: sums.filter((s) => s.user_id === u).map((s) => ({ day: s.day })) };
    if (/FROM member_day_summaries\s+WHERE user_id = \$1 AND status = 'ok' AND day < \$2::date/.test(sql)) {
      const out = sums.filter((s) => s.user_id === u && s.status === "ok" && s.day < (args[1] as string)).sort((a, b) => b.day.localeCompare(a.day)).slice(0, Number(args[2]));
      return { rows: out };
    }
    if (/INSERT INTO member_day_summaries/.test(sql)) {
      const [user_id, day, zone, summary, status, source_ids, source_stamp, model] = args as [string, string, string | null, string, string, string[], string, string];
      if (!sums.some((s) => s.user_id === user_id && s.day === day)) sums.push({ id: `sum-${++sumSeq}`, user_id, day, zone, summary, status, source_ids, source_stamp, model });
      return { rows: [] };
    }
    if (/DELETE FROM member_day_summaries/.test(sql)) {
      const ids = args[1] as string[];
      for (let i = sums.length - 1; i >= 0; i--) if (sums[i].user_id === u && ids.includes(sums[i].id)) sums.splice(i, 1);
      return { rows: [] };
    }
    if (/FROM co_memories WHERE user_id = \$1 AND id = ANY/.test(sql)) return { rows: rows.filter((r) => r.user_id === u && (args[1] as string[]).includes(r.id)) };
    if (/FROM co_memories\s+WHERE user_id = \$1 AND memory_type IN/.test(sql)) {
      return { rows: rows.filter((r) => r.user_id === u && +r.created_at >= +(args[1] as Date) && +r.created_at < +(args[2] as Date) && !/ \[to [A-Za-z]+\]$/.test(r.content)).sort((a, b) => +a.created_at - +b.created_at) };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  },
};

// Jordan: Nov 1 and Nov 2 (old enough), Nov 4 (yesterday: too new), a day with almost nothing, a teammate line.
const NOW = new Date("2026-11-06T18:00:00Z");
const ZONE = "America/Los_Angeles";
const d1a = add(JORDAN, "2026-11-01T17:00:00Z", "text_exchange", longText("User said: the studio lease renewal is stressing me out, they want eighteen percent more"));
const d1b = add(JORDAN, "2026-11-01T17:01:00Z", "text_exchange", longText("Co replied: Eighteen percent is steep. Do you want to push back in writing?"));
const d1c = add(JORDAN, "2026-11-01T22:00:00Z", "call_transcript", `assistant: Hi Jordan, how did it go?\nuser: ${longText("I sent the counter offer to the landlord, my sister Maren is visiting")}\nassistant: Good.`);
const d2a = add(JORDAN, "2026-11-02T18:00:00Z", "text_exchange", longText("User said: the kiln delivery came today and I am thrilled"));
add(JORDAN, "2026-11-02T18:05:00Z", "text_exchange", "User said: ask Mo about the invoice and the long delivery schedule for the studio, again and again and again [to Mo]");
add(JORDAN, "2026-11-03T18:00:00Z", "text_exchange", "User said: ok");
add(JORDAN, "2026-11-06T01:00:00Z", "text_exchange", longText("User said: yesterday evening text, too new to summarize"));
add(JORDAN, "2026-11-02T19:00:00Z", "call_transcript", "Co initiated call to Jordan - call_sid: CA1");
// Priya: other member, same days.
add(PRIYA, "2026-11-01T17:00:00Z", "text_exchange", longText("User said: PRIYA-ONLY the divorce mediation is on the 14th"));
add(PRIYA, "2026-11-02T17:00:00Z", "text_exchange", longText("User said: PRIYA-ONLY the glaze recipe"));

const seen: { userId: string; day: string; text: string }[] = [];
let modelCalls = 0;
const strip = (s: string) => (/\bPriya\b/.test(s) ? null : s.replace(/\bDana\b/g, "someone"));
let guards: W.ForgottenRow[] | null = [];
let fenceFailed = false;
const mkDeps = (over: Partial<import("../../src/services/daySummaries.js").JobDeps> = {}): import("../../src/services/daySummaries.js").JobDeps => ({
  db, now: NOW,
  summarize: async (userId, i) => { modelCalls++; seen.push({ userId, ...i }); return `They were dealing with the lease renewal and a delivery on ${i.day} [${userId.slice(-4)}]. Cue offered to help them reply "in writing".`; },
  fenceFor: async () => ({ strip, failed: fenceFailed }),
  guardsFor: async () => guards,
  zoneFor: async () => ZONE,
  ...over,
});

// ---- 1. the job writes one dated, linked summary per old day
{
  const res = await D.runDaySummaries(mkDeps());
  const mine = sums.filter((s) => s.user_id === JORDAN);
  check("job: one summary for each old day with enough conversation (Nov 1 and Nov 2)", mine.map((s) => s.day).sort().join() === "2026-11-01,2026-11-02" && res.written === 2 + sums.filter((s) => s.user_id === PRIYA).length, { res, days: mine.map((s) => s.day) });
  const s1 = mine.find((s) => s.day === "2026-11-01")!;
  check("link: the summary lists the source row ids it was built from", [d1a, d1b, d1c].every((id) => s1.source_ids.includes(id)) && s1.source_ids.length === 3 && !s1.source_ids.includes(d2a), s1.source_ids);
  check("link: a stamp is stored with it", /^[0-9a-f]{16}$/.test(s1.source_stamp));
  check("quote: no quotation marks survive into a stored summary", sums.every((s) => !/["“”]/.test(s.summary)), sums.map((s) => s.summary));
  check("too new: yesterday (Nov 5 Pacific) is not summarized", !mine.some((s) => s.day >= "2026-11-04"));
  check("too little: a day of one short text gets no summary and no model call", !mine.some((s) => s.day === "2026-11-03") && !seen.some((x) => x.day === "2026-11-03"));
  check("teammate and placed-call lines are not in the model's input", seen.every((x) => !/invoice|Co initiated call/.test(x.text)));
  check("input labels who spoke, and calls are labelled as calls", /User said \(on a call\):/.test(seen.find((x) => x.day === "2026-11-01")!.text) && /Co replied:/.test(seen.find((x) => x.day === "2026-11-01")!.text));
}

// ---- 2. never re-summarized
{
  const before = modelCalls;
  const again = await D.runDaySummaries(mkDeps());
  check("never twice: a second run makes no model call and writes nothing", modelCalls === before && again.written === 0 && again.days === 0, again);
  await D.runDaySummaries(mkDeps({ db: { query: async (sql: string, a?: unknown[]) => (/SELECT to_char\(day/.test(sql) ? { rows: [] } : db.query(sql, a)) } }));
  check("never twice: even if the existing-days read missed, the insert keeps the first one (ON CONFLICT DO NOTHING)", sums.filter((s) => s.user_id === JORDAN).length === 2 && /ON CONFLICT \(user_id, day\) DO NOTHING/.test(asked.find((q) => /INSERT INTO member_day_summaries/.test(q.sql))!.sql));
}

// ---- 3. isolation
{
  check("isolation: another member's rows never reach Jordan's model input", seen.filter((x) => x.userId === JORDAN).every((x) => !/PRIYA-ONLY/.test(x.text)));
  check("isolation: each member's summary is built from that member's rows only", sums.filter((s) => s.user_id === JORDAN).every((s) => s.source_ids.every((id) => rows.find((r) => r.id === id)?.user_id === JORDAN)) && sums.filter((s) => s.user_id === PRIYA).every((s) => s.source_ids.every((id) => rows.find((r) => r.id === id)?.user_id === PRIYA)));
  check("isolation: every read of rows or summaries is scoped to one user id", asked.filter((q) => /FROM co_memories|FROM member_day_summaries/.test(q.sql) && !/FROM users u/.test(q.sql)).every((q) => /user_id = \$1/.test(q.sql)));
  const named = await D.runDaySummaries(mkDeps({ summarize: async () => "They talked about a plan with Priya and a trip.", db: { query: async (sql: string, a?: unknown[]) => (/SELECT to_char\(day/.test(sql) ? { rows: [] } : /ON CONFLICT/.test(sql) ? { rows: [] } : db.query(sql, a)) } }));
  check("name strip: a written summary that names another member is not stored", named.written === 0 && !sums.some((s) => /Priya/.test(s.summary)), named);
  check("name strip: input lines go through the fence too", D.dayInputs([{ id: "x", memory_type: "text_exchange", content: longText("User said: Dana called and so did Priya"), created_at: new Date("2026-10-01T10:00:00Z") }], ZONE, [], strip).length === 0);
  check("name strip: the other member's name stripped line by line, others kept", D.cleanSummary("Dana helped.", strip) === "someone helped." && D.cleanSummary("Priya helped.", strip) === null);
  const failedFence = (fenceFailed = true, await D.runDaySummaries(mkDeps({ summarize: async () => { throw new Error("must not be called"); } })));
  fenceFailed = false;
  check("name strip: when the names cannot be read nothing is summarized", failedFence.written === 0 && failedFence.skipped >= 1, failedFence);
  const noGuards = await D.runDaySummaries(mkDeps({ guardsFor: async () => null, summarize: async () => { throw new Error("must not be called"); } }));
  check("guards unread: nothing is summarized when the removal guards cannot be read", noGuards.written === 0);
}

// ---- 4. the block: labelled as summaries, budget, window
{
  const block = D.summaryBlock(sums.filter((s) => s.user_id === JORDAN).map((s) => ({ day: s.day, summary: s.summary, sources: s.source_ids.length })), NOW, ZONE);
  check("label: the block says these are Cue's own summaries, not their words, never a quote", /Earlier, in summary/.test(block) && /not their words/.test(block) && /never a quote/.test(block), block);
  check("label: each line carries its date and says it is a summary of N lines", /- Sun Nov 1 \(summary of 3 lines\):/.test(block) && /- Mon Nov 2 \(summary of 1 line\):/.test(block), block);
  check("label: oldest first", block.indexOf("Nov 1") < block.indexOf("Nov 2"));
  const many = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, summary: "x".repeat(900), sources: 4 }));
  const big = D.summaryBlock(many, NOW, ZONE);
  check("budget: at most recentN summaries and the character budget holds", big.split("\n").length - 1 <= D.SUMMARY.recentN && big.length <= D.SUMMARY.blockChars, { lines: big.split("\n").length, len: big.length });
  check("budget: the most recent are the ones kept", big.includes("Oct 30") && !big.includes("Oct 1 "), big.slice(0, 200));
  check("budget: a long summary is cut to the line budget", big.split("\n").slice(1).every((l) => l.length < D.SUMMARY.lineChars + 80));
  check("budget: no summaries, no block", D.summaryBlock([], NOW, ZONE) === "");
  // the read: only days before the thread window's oldest line
  const g = W.liveGuards([]);
  const all = await D.earlierSummaryBlock(JORDAN, { strip, guards: g, zone: ZONE, now: NOW }, db);
  const onlyNov1 = await D.earlierSummaryBlock(JORDAN, { strip, guards: g, zone: ZONE, now: NOW, windowOldest: new Date("2026-11-02T18:00:00Z") }, db);
  check("window: a day the thread window already shows in full is not summarized on top of it", /Nov 1/.test(all) && /Nov 2/.test(all) && /Nov 1/.test(onlyNov1) && !/Nov 2/.test(onlyNov1), { all, onlyNov1 });
  const other = await D.earlierSummaryBlock(PRIYA, { strip, guards: g, zone: ZONE, now: NOW }, db);
  const jordanBlock = await D.earlierSummaryBlock(JORDAN, { strip, guards: g, zone: ZONE, now: NOW }, db);
  check("isolation: Priya's block holds only her own summaries and Jordan's only his", /\[b002\]/.test(other) && !/\[a001\]/.test(other) && /\[a001\]/.test(jordanBlock) && !/\[b002\]/.test(jordanBlock), { other, jordanBlock });
  check("fail closed: unreadable guards or names give no block", (await D.earlierSummaryBlock(JORDAN, { strip, guards: null, zone: ZONE }, db)) === "" && (await D.earlierSummaryBlock(JORDAN, { strip, fenceFailed: true, guards, zone: ZONE }, db)) === "");
  const none = [] as string[];
  const empty = await D.earlierSummaryFor("00000000-0000-4000-8000-0000000000ff", {}, { query: async (sql: string) => { none.push(sql); return { rows: [] }; } });
  check("cost: a member with no summaries costs one cheap read and nothing else", empty === "" && none.length === 1);
}
let guards_: W.ForgottenRow[] = [];

// ---- 5. forgetting: a removed or corrected or deleted source invalidates its summary
{
  const s1 = sums.find((s) => s.user_id === JORDAN && s.day === "2026-11-01")!;
  const src = rows.filter((r) => s1.source_ids.includes(r.id));
  check("forget: with nothing removed the stored stamp still holds", D.stillStands(s1, src, []));
  const removedG = W.liveGuards([{ field: "life", old: "counter offer to the landlord", now: null, ref: "claim:1", removed: true }]);
  check("forget: a removed line changes the stamp, so the summary no longer stands", !D.stillStands(s1, src, removedG));
  const shown = await D.earlierSummaryBlock(JORDAN, { strip, guards: removedG, zone: ZONE, now: NOW }, db);
  check("forget: the summary built on it is not shown", !/Nov 1/.test(shown) && /Nov 2/.test(shown), shown);
  await new Promise((r) => setTimeout(r, 5));
  check("forget: and it is deleted (free), so its text does not sit in storage", !sums.some((s) => s.id === s1.id));
  seen.length = 0;
  const res = await D.runDaySummaries(mkDeps({ guardsFor: async () => removedG }));
  const redo = sums.find((s) => s.user_id === JORDAN && s.day === "2026-11-01");
  check("forget: the day is summarized once more, from the guarded lines only", res.written === 1 && !!redo && seen.length === 1 && !/counter offer/.test(seen[0].text) && /lease renewal|eighteen/.test(seen[0].text), { res, text: seen[0]?.text.slice(0, 200) });
  check("forget: the new summary stands under the same guards", !!redo && D.stillStands(redo, rows.filter((r) => redo.source_ids.includes(r.id)), removedG));
  // a correction
  const corr = W.liveGuards([{ field: "life", old: "eighteen percent", now: "twelve percent", ref: "claim:2", removed: false }]);
  const s2 = sums.find((s) => s.user_id === JORDAN && s.day === "2026-11-01")!;
  check("correct: a correction made later changes the stamp as well", !D.stillStands(s2, rows.filter((r) => s2.source_ids.includes(r.id)), corr));
  // a deleted source row
  const s3 = sums.find((s) => s.user_id === JORDAN && s.day === "2026-11-02")!;
  check("delete: a source row that no longer exists ends the summary", !D.stillStands(s3, rows.filter((r) => s3.source_ids.includes(r.id) && r.id !== d2a), []));
  // a summary text that itself says a removed thing is withheld even with the stamp unchanged
  const own = await D.earlierSummaryBlock(JORDAN, { strip, guards: W.liveGuards([{ field: "life", old: "dealing with the lease renewal and a delivery", now: null, ref: "claim:3", removed: true }]), zone: ZONE, now: NOW }, db);
  check("forget: a summary whose own text says a removed thing does not come back", !/lease renewal and a delivery/.test(own), own);
  // everything removed: nothing is left to summarize, and no model call is made for it
  const allGone = W.liveGuards([{ field: "life", old: "kiln delivery came today", now: null, ref: "claim:4", removed: true }]);
  const kiln = rows.filter((r) => r.id === d2a);
  check("forget: a day whose only line was removed has no input, so no model call", D.dayInputs(kiln, ZONE, allGone, strip).length === 0 && D.dayInputs(kiln, ZONE, [], strip).length === 1);
}

// ---- 6. not scheduled, no repeat spend
{
  const src = (f: string) => fs.readFileSync(path.join(new URL("../..", import.meta.url).pathname, f), "utf8");
  const strip_ = (t: string) => t.replace(/\/\/.*$/gm, "");
  check("off: jobs/index.ts and jobs/cron.ts never mention the summary job", !/daySummar|runDaySummaries/i.test(strip_(src("src/jobs/index.ts")) + strip_(src("src/jobs/cron.ts"))));
  const callers: string[] = [];
  const walk = (dir: string) => { for (const e of fs.readdirSync(path.join(new URL("../..", import.meta.url).pathname, dir), { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name) && /runDaySummaries(Job)?\(/.test(strip_(src(p))) && !p.endsWith("services/daySummaries.ts")) callers.push(p); } };
  walk("src");
  check("off: nothing in src calls the job (only the module that defines it)", callers.length === 0, callers);
  check("off: no env switch gates it (it is unscheduled, not toggled)", !/process\.env/.test(strip_(src("src/services/daySummaries.ts"))));
  check("cheap: the only model is Haiku", /MODELS\.haiku/.test(src("src/services/daySummaries.ts")) && !/MODELS\.sonnet/.test(src("src/services/daySummaries.ts")));
  check("bounded: a run is capped per run and per day of input", D.SUMMARY.maxDaysPerRun <= 100 && D.SUMMARY.maxInputChars <= 15_000 && D.SUMMARY.maxOutputTokens <= 400);
  const capped = await D.runDaySummaries(mkDeps({ maxDays: 1 }));
  check("bounded: maxDays stops a run", capped.days <= 1);
}

// ---- 7. both mediums see the block, outside the thread (behaviour: what each prompt is built to show)
{
  const RP = await import("../../src/agent/conversationReply.js");
  const block = "Earlier, in summary. x\n- Sun Nov 1 (summary of 3 lines): y";
  const withIt = RP.threadSection({ recentConversation: "User said: hi\nCo replied: hello", earlierSummary: block });
  check("reply: the summary block comes before the recent thread, and the thread text itself is untouched", withIt.indexOf("Earlier, in summary") === 0 && withIt.indexOf("Earlier, in summary") < withIt.indexOf("Recent conversation, in order") && withIt.endsWith("User said: hi\nCo replied: hello"), withIt);
  check("reply: without summaries the section is exactly the old one", RP.threadSection({ recentConversation: "User said: hi" }) === "Recent conversation, in order. This is the actual thread, so follow it. Don't jump to older topics below unless they bring them up again.\nUser said: hi");
  check("reply: an empty thread still says it is the start", /start of the conversation/.test(RP.threadSection({ recentConversation: "", earlierSummary: block })));
  const CC = await import("../../src/services/callContext.js");
  const sum = CC.assembleCallSummary({ lessons: [], sentLines: [], threads: [], base: "Who they are.", thread: "Your recent texts with them, oldest first:\nUser said: hi", earlier: block });
  check("call: the same block sits before the recent texts, labelled", sum.indexOf("Earlier, in summary") > 0 && sum.indexOf("Earlier, in summary") < sum.indexOf("Your recent texts with them"));
  check("call: without it the summary is as before", !/Earlier, in summary/.test(CC.assembleCallSummary({ lessons: [], sentLines: [], threads: [], base: "Who they are.", thread: "t" })));
  // the cutoff time uses the same rows (and the same long-text marker) as the thread the call shows
  const huge = "word ".repeat(2000);
  const ex = (text: string, from: "member" | "co", at: string) => ({ text, from, verifiedAt: at, call: false }) as any;
  const exs = [ex("old line", "member", "2026-11-01T10:00:00Z"), ex("Cue's answer", "co", "2026-11-01T10:01:00Z"), ex(huge, "member", "2026-11-02T10:00:00Z"), ex("last", "member", "2026-11-03T10:00:00Z")];
  const rowsOf = CC.callThreadRows(exs);
  check("call: a text too long for the window is the marker in the rows, as in the thread, and rows carry their time", rowsOf.some((r) => /a long text of theirs/.test(r.content)) && rowsOf.every((r) => !!r.at) && CC.callThread(exs).split("\n").length === rowsOf.length + 1);
}

// ---- 8. grounding: the prompt carries the house rules
{
  const P = D.SUMMARY_PROMPT;
  check("prompt: each thing only as far along as they said it is", /planned is not started, started is not done/.test(P));
  check("prompt: attendance is never stated, intent stays intent", /Never state that they went to, attended or did something unless they said they did/.test(P) && /intent/.test(P));
  check("prompt: silence or a missing reply is not a fact", /Silence or a missing reply is not a fact/.test(P));
  check("prompt: feelings only as they said them, in their own words; no 'how they seemed'", /only how they said they felt, in their own words, and only if they said it/.test(P) && !/seemed/i.test(P));
  check("prompt: no quotes, no invention, who did what", /Never quote them/.test(P) && /Never invent/.test(P) && /Say who did what/.test(P));
  check("prompt: no old house name in it", !/\bCo\b/.test(P));
}

// ---- 9. forgetting across ALL stored days (the read loads only the newest), and straight after a removal
const LONG = "00000000-0000-4000-8000-00000000d003";
const longIds: string[] = [];
let THINGS: string[] = [];
const lineWords = (d: number) => [d - 1, d + 7, d + 13, d + 19, d + 25].map((i) => THINGS[i % 30]).join(" ");
{
  THINGS = "kiln saffron lantern harbor quartz meadow copper velvet orchid anchor ember willow marble thistle cobalt juniper pewter sorrel tundra fennel garnet basalt cypress indigo walnut ribbon topaz bramble clover mistral".split(" ");
  for (let d = 1; d <= 30; d++) longIds.push(add(LONG, `2026-10-${String(d).padStart(2, "0")}T18:00:00Z`, "text_exchange", longText(`User said: ${lineWords(d)}`)));
  await D.runDaySummaries(mkDeps({ maxDays: 400 }));
  const mine = sums.filter((x) => x.user_id === LONG);
  check("30 days: thirty summaries are stored for the member", mine.length === 30 && mine.every((x) => x.status === "ok"), mine.length);
  const oldest = mine.find((x) => x.day === "2026-10-01")!;
  const oldestId = oldest.id;
  const loaded = (await db.query(`SELECT id::text AS id FROM member_day_summaries WHERE user_id = $1 AND status = 'ok' AND day < $2::date ORDER BY day DESC LIMIT $3`, [LONG, "9999-12-31", D.SUMMARY.recentN * 2])).rows;
  check("30 days: the oldest is far past the 14 the read path loads", !loaded.some((x: any) => x.id === oldestId));
  const gone = W.liveGuards([{ field: "life", old: lineWords(1), now: null, ref: "claim:9", removed: true }]);
  seen.length = 0;
  const callsBefore = modelCalls;
  const res = await D.runDaySummaries(mkDeps({ maxDays: 400, guardsFor: async () => gone }));
  const after = sums.filter((x) => x.user_id === LONG);
  const oldestNow = after.find((x) => x.day === "2026-10-01");
  check("30 days: after a line is removed from the oldest day, the job deletes that stored row", res.pruned >= 1 && !after.some((x) => x.id === oldestId), res);
  check("30 days: the day is gone (nothing left to say) or regenerated from the guarded lines only", !oldestNow || (oldestNow.id !== oldestId && !seen.some((x) => x.day === "2026-10-01" && new RegExp(THINGS[0]).test(x.text))), { oldestNow, seen: seen.map((x) => x.day) });
  check("30 days: the other twenty-nine are untouched and no other day is summarized again", after.filter((x) => x.day !== "2026-10-01").length === 29 && modelCalls - callsBefore === seen.length && seen.every((x) => x.day === "2026-10-01"), { calls: modelCalls - callsBefore, seen: seen.map((x) => x.day) });
  // straight after a removal: no job, no read
  const d2 = sums.find((x) => x.user_id === LONG && x.day === "2026-10-13")!;
  corrections.push({ field: "life", old_value: lineWords(13), new_value: null, item_ref: "claim:5", removed: true });
  const n = await D.pruneAfterChange(LONG, db);
  check("removal: straight after it, the summary built on the removed line is deleted (no waiting for the next read)", n >= 1 && !sums.some((x) => x.id === d2.id) && sums.filter((x) => x.user_id === LONG).length >= 27, n);
  corrections.length = 0;
  check("removal: another member's summaries are not touched", sums.filter((x) => x.user_id === JORDAN).length === 2);
  check("removal: unreadable guards delete nothing", (await D.pruneStale(db, LONG, null)) === 0);
}

// ---- 10. no repeat spend: an empty or blanked result is recorded with its stamp
{
  const B = "00000000-0000-4000-8000-00000000e004";
  const bid = add(B, "2026-10-10T18:00:00Z", "text_exchange", longText("User said: the supplier invoice and the kiln schedule for the week"));
  let calls = 0;
  const empty = (over: any = {}) => mkDeps({ summarize: async (u) => { if (u !== B) return "They sorted a few errands."; calls++; return "   "; }, ...over });
  const r1 = await D.runDaySummaries(empty());
  const rec = sums.find((x) => x.user_id === B);
  check("blank: an empty answer is recorded as blank with its stamp and sources", r1.blank === 1 && !!rec && rec.status === "blank" && rec.summary === "" && rec.source_ids.includes(bid) && /^[0-9a-f]{16}$/.test(rec.source_stamp), { r1, rec });
  const r2 = await D.runDaySummaries(empty());
  check("blank: the same stamp is never paid for again", calls === 1 && sums.filter((x) => x.user_id === B).length === 1 && r2.members >= 1, { calls, r2 });
  check("blank: it is never shown", (await D.earlierSummaryBlock(B, { strip, guards: [], zone: ZONE, now: NOW }, db)) === "");
  check("blank: a note the name strip blanks is recorded as blank too (cleanSummary gives null, so the same path)", D.cleanSummary("A note about Priya.", strip) === null);
  // a threw call is not recorded (nothing came back to pay for)
  const T = "00000000-0000-4000-8000-00000000f005";
  add(T, "2026-10-11T18:00:00Z", "text_exchange", longText("User said: the florist and the table rental"));
  const thrown = await D.runDaySummaries(mkDeps({ summarize: async (u) => { if (u === T) throw new Error("refused"); return "They sorted a few errands."; } }));
  check("blank: a request that threw leaves no record, so it can be tried again", thrown.failed >= 1 && !sums.some((x) => x.user_id === T));
  // the stamp changes (a source line is removed later): one new try, then it stands again
  const g = W.liveGuards([{ field: "life", old: "supplier invoice and the kiln schedule", now: "vendor invoice", ref: "claim:b", removed: false }]);
  const r3 = await D.runDaySummaries(empty({ guardsFor: async () => g }));
  check("blank: when the day's stamp changes the record is dropped and the day tried once more", r3.pruned >= 1 && calls === 2, { r3, calls });
  const r4 = await D.runDaySummaries(empty({ guardsFor: async () => g }));
  check("blank: and not again at the new stamp", calls === 2 && r4.pruned === 0, { calls, r4 });
}

// ---- 11. whole local days, DST, and a fair share
{
  const win = D.runWindow(new Date("2026-11-08T20:00:00Z"), ZONE, 10);
  const z = (d: Date) => DateTimeOf(d);
  const DateTimeOf = (d: Date) => new Date(d.toLocaleString("en-US", { timeZone: ZONE }));
  const localFrom = z(win.from), localTo = z(win.to);
  check("window: the oldest day is whole (starts at local midnight)", localFrom.getHours() === 0 && localFrom.getMinutes() === 0 && localFrom.getDate() === 29, localFrom);
  check("window: it ends at a local midnight after the last summarizable day", localTo.getHours() === 0 && win.last === "2026-11-06" && localTo.getDate() === 7, { localTo, last: win.last });
  const spring = D.runWindow(new Date("2026-03-15T20:00:00Z"), ZONE, 7);
  check("window: across the March clock change the start is still local midnight", z(spring.from).getHours() === 0 && z(spring.from).getDate() === 8, z(spring.from));
  check("window: the dayOf of a late-evening Pacific text is that Pacific day", D.dayOf("2026-11-06T06:30:00Z", ZONE) === "2026-11-05");
  // fair share: three members, a budget of three days, one day each, the member with the fewest summaries first
  const F: string[] = ["00000000-0000-4000-8000-0000000f1001", "00000000-0000-4000-8000-0000000f1002", "00000000-0000-4000-8000-0000000f1003"];
  for (const m of F) for (let d = 12; d <= 20; d++) add(m, `2026-10-${d}T18:00:00Z`, "text_exchange", longText(`User said: fair-share fixture ${m.slice(-2)} day ${d}`));
  sums.splice(0, sums.length, ...sums.filter((x) => !F.includes(x.user_id)));
  const gotBy: Record<string, number> = {};
  const r = await D.runDaySummaries(mkDeps({ maxDays: 3, summarize: async (u) => { gotBy[u] = (gotBy[u] ?? 0) + 1; return "They sorted errands."; } }));
  check("fair share: one member's backlog does not use the run's whole budget", F.every((m) => (gotBy[m] ?? 0) <= 1) && r.days <= 3, gotBy);
}

console.log(`day summaries: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
