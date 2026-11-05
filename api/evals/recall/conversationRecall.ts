// Source-backed conversation recall (services/conversationRecall.ts): the lookup over one member's own retained history.
// Layer 1: a fake database that runs the lookup's own SQL shapes over fixture rows, no model, zero tokens.
//   TZ=UTC npx tsx evals/recall/conversationRecall.ts
// Invented members: Jordan (candles, Pacific) and Priya (a different member whose rows share Jordan's topics).
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const R = await import("../../src/services/conversationRecall.js");
const W = await import("../../src/services/whatCoKnows.js");
const TW = await import("../../src/services/threadWindow.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) { failed++; console.log(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`); }
};

type Row = { id: string; user_id: string; memory_type: string; content: string; created_at: Date };
const JORDAN = "00000000-0000-4000-8000-00000000a001";
const PRIYA = "00000000-0000-4000-8000-00000000b002";
let seq = 0;
const rows: Row[] = [];
const add = (user_id: string, at: string, memory_type: string, content: string) => rows.push({ id: String(++seq).padStart(6, "0"), user_id, memory_type, content, created_at: new Date(at) });

// ---- the fake: the three query shapes the lookup runs, over the fixture, honouring the SQL's own user_id and kind filters.
const asked: { sql: string; args: unknown[] }[] = [];
const kindOk = (sql: string, r: Row): boolean => {
  const teammate = / \[to [A-Za-z]+\]$/.test(r.content);
  const textRow = r.memory_type === "text_exchange" && !r.content.startsWith("Co is looking:") && !teammate;
  const summary = r.memory_type === "text_exchange" && r.content.startsWith("[Call]");
  const transcript = r.memory_type === "call_transcript" && !r.content.startsWith("Co initiated call");
  if (sql.includes("content NOT LIKE '[Call]%')")) return textRow && !r.content.startsWith("[Call]");
  if (!sql.includes("content NOT LIKE 'Co is looking:%'")) return transcript || summary;
  return textRow || transcript;
};
const ilike = (c: string, p: string) => c.toLowerCase().includes(p.replace(/^%|%$/g, "").replace(/\\(.)/g, "$1").toLowerCase());
const db = {
  query: async (sql: string, args: unknown[]) => {
    asked.push({ sql, args });
    if (/MIN\(created_at\)/.test(sql)) {
      const mine = rows.filter((r) => r.user_id === args[0]);
      const min = (xs: Row[]) => (xs.length ? new Date(Math.min(...xs.map((x) => +x.created_at))) : null);
      return { rows: [{ texts: min(mine.filter((r) => r.memory_type === "text_exchange")), calls: min(mine.filter((r) => r.memory_type === "call_transcript" && !r.content.startsWith("Co initiated call"))) }] };
    }
    let mine = rows.filter((r) => r.user_id === args[0] && kindOk(sql, r));
    const ctx = sql.match(/\(created_at, id\) ([<>]) \(\$2::timestamptz, \$3\)/);
    if (ctx) {
      const at = args[1] as Date, id = String(args[2]);
      mine = mine.filter((r) => (ctx[1] === "<" ? +r.created_at < +at || (+r.created_at === +at && r.id < id) : +r.created_at > +at || (+r.created_at === +at && r.id > id)));
      mine.sort((a, b) => (ctx[1] === "<" ? +b.created_at - +a.created_at || b.id.localeCompare(a.id) : +a.created_at - +b.created_at || a.id.localeCompare(b.id)));
      return { rows: mine.slice(0, 2) };
    }
    const win = sql.match(/created_at >= \$(\d+) AND created_at <= \$(\d+)/);
    if (win) mine = mine.filter((r) => +r.created_at >= +(args[+win[1] - 1] as Date) && +r.created_at <= +(args[+win[2] - 1] as Date));
    const pats = (sql.match(/ILIKE ANY\(\$(\d+)::text\[\]\)/) ? (args[+sql.match(/ILIKE ANY\(\$(\d+)::text\[\]\)/)![1] - 1] as string[]) : null);
    const score = (r: Row) => (pats ? pats.filter((p) => ilike(r.content, p)).length : 0);
    if (pats) mine = mine.filter((r) => score(r) > 0);
    const lim = Number(sql.match(/LIMIT (\d+)/)?.[1] ?? 1000), off = Number(sql.match(/OFFSET (\d+)/)?.[1] ?? 0);
    if (/ORDER BY score DESC/.test(sql)) mine.sort((a, b) => score(b) - score(a) || +b.created_at - +a.created_at || b.id.localeCompare(a.id));
    else if (/ORDER BY created_at DESC/.test(sql)) mine.sort((a, b) => +b.created_at - +a.created_at || b.id.localeCompare(a.id));
    else mine.sort((a, b) => +a.created_at - +b.created_at || a.id.localeCompare(b.id));
    const total = mine.length;
    return { rows: mine.slice(off, off + lim).map((r) => ({ ...r, score: score(r), total })) };
  },
};

const removed: unknown[] = [];
let guardsBroken = false;
const NOW = new Date("2026-11-05T03:30:00Z"); // 7:30 pm on Nov 4 in Los Angeles; already Nov 5 in UTC
let zoneOf: string | null = "America/Los_Angeles";
const deps = (over: Partial<import("../../src/services/conversationRecall.js").RecallDeps> = {}): import("../../src/services/conversationRecall.js").RecallDeps => ({
  db, now: () => NOW, zone: async () => zoneOf,
  forgotten: async () => { if (guardsBroken) throw new Error("guard read failed"); return removed; },
  guard: (t, g) => W.guardText(t, g as any),
  fence: async () => ({ strip: (s: string) => (/\bPriya\b/.test(s) ? null : s) }), ...over,
});
const look = (u: string, i: import("../../src/services/conversationRecall.js").RecallInput, d = deps()) => R.recallConversation(u, i, d);
const okRes = (r: Awaited<ReturnType<typeof look>>) => (r.ok ? r : (() => { throw new Error("not ok: " + JSON.stringify(r)); })());

// ---- Jordan's record
// 1. a long thread: the glaze talk is early; 120 rows of other things come after. The reply window cannot reach it.
add(JORDAN, "2026-08-02T17:00:00Z", "text_exchange", "User said: I'm switching my candle jars to a matte ceramic glaze, the supplier in Tacoma quoted me $4 a jar");
add(JORDAN, "2026-08-02T17:01:00Z", "text_exchange", "Co replied: Matte ceramic, that's a real step up. Do you want the Tacoma quote kept somewhere?");
for (let i = 0; i < 120; i++) add(JORDAN, new Date(Date.parse("2026-09-01T16:00:00Z") + i * 3_600_000).toISOString(), "text_exchange", i % 2 ? `Co replied: filler reply ${i}` : `User said: filler note ${i} about the week`);
// 2. a change of mind: Berlin trip, then not going.
add(JORDAN, "2026-10-10T18:00:00Z", "text_exchange", "User said: I'm going to the Berlin trade fair in December, booking flights this week");
add(JORDAN, "2026-10-10T18:01:00Z", "text_exchange", "Co replied: Berlin in December, noted.");
add(JORDAN, "2026-10-24T18:00:00Z", "text_exchange", "User said: Scratch the Berlin trade fair, I'm not going anymore, the booth fee doubled");
// 3. two referents: Dana from the shop and Dana the dentist.
add(JORDAN, "2026-09-20T15:00:00Z", "text_exchange", "User said: Dana from the pottery shop might carry my candles");
add(JORDAN, "2026-10-02T15:00:00Z", "text_exchange", "User said: Dana my dentist says I need the crown redone");
// 4. member versus Cue authorship: Cue said the word "retainer"; Jordan did not.
add(JORDAN, "2026-10-15T15:00:00Z", "text_exchange", "Co replied: Want me to look for a lawyer on retainer for the lease question?");
add(JORDAN, "2026-10-15T15:05:00Z", "text_exchange", "User said: No, skip that. I'll handle the lease myself.");
// 5. quoted outside material and a pasted link.
add(JORDAN, "2026-10-18T15:00:00Z", "text_exchange", "User said: yes that one https://example.com/markets/saturday-fair [Replying to Cue's text: \"The Saturday makers fair has two open booths\" (event: Saturday makers fair)]");
add(JORDAN, "2026-10-19T15:00:00Z", "text_exchange", "User said: look at this [They also sent a photo. It shows: a flyer for a ceramics class]");
// 6. a call with a transcript and a summary note.
add(JORDAN, "2026-10-28T20:30:00Z", "call_transcript", "assistant: Hi Jordan, how's the week?\nuser: Long. My sister Maren is visiting and the studio lease renewal is stressing me out.\nassistant: The lease, tell me more.\nuser: They want eighteen percent more and I want to push back.");
add(JORDAN, "2026-10-28T20:41:00Z", "text_exchange", "[Call] Jordan called about the studio lease renewal (18% increase) and her sister Maren visiting.");
add(JORDAN, "2026-10-28T20:50:00Z", "call_transcript", "Co initiated call to Jordan — call_sid: CA123");
// 7. the timezone boundary: Nov 3 evening Pacific is Nov 4 UTC.
add(JORDAN, "2026-11-04T05:30:00Z", "text_exchange", "User said: late one, the kiln finished at 9:30pm and the first batch looks great");
add(JORDAN, "2026-11-03T23:00:00Z", "text_exchange", "User said: afternoon: the kiln delivery came");
add(JORDAN, "2026-11-04T09:00:00Z", "text_exchange", "User said: 1am: can't sleep, thinking about the kiln");
add(JORDAN, "2026-11-02T18:00:00Z", "text_exchange", "User said: Monday kiln test, nothing yet");
// 8. a removed subject and a line to a teammate and a hold line.
add(JORDAN, "2026-09-12T15:00:00Z", "text_exchange", "User said: my divorce mediation with Sam is on the 14th");
add(JORDAN, "2026-09-12T15:02:00Z", "text_exchange", "User said: ask Mo about the mediation thing [to Mo]");
add(JORDAN, "2026-09-12T15:03:00Z", "text_exchange", "Co is looking: mediation");
add(JORDAN, "2026-09-12T15:04:00Z", "text_exchange", "User said: lunch tomorrow with Alex");
// ---- Priya (another member), same topics
add(PRIYA, "2026-08-03T17:00:00Z", "text_exchange", "User said: I'm switching to a matte ceramic glaze for my mugs");
add(PRIYA, "2026-10-12T17:00:00Z", "text_exchange", "User said: Berlin trade fair is not for me, kiln stuff, my sister Maren is moving");
add(PRIYA, "2026-10-28T20:30:00Z", "call_transcript", "user: the studio lease renewal, Dana, the Berlin fair, the glaze, the divorce mediation");
add(PRIYA, "2026-11-04T05:30:00Z", "text_exchange", "User said: kiln thing last night");

const texts = (res: R.RecallHit[]) => res.map((h) => h.matched.text).join(" || ");

// ---- 1. recall beyond the window
{
  const newestFirst = rows.filter((r) => r.user_id === JORDAN && r.memory_type === "text_exchange").sort((a, b) => +b.created_at - +a.created_at);
  const inWindow = TW.threadWindow(newestFirst.slice(0, TW.WINDOW_MAX_ROWS)).map((r) => r.content).join("\n");
  check("setup: the August glaze talk is outside the reply's window", !/ceramic glaze/.test(inWindow));
  const r = okRes(await look(JORDAN, { topic: "ceramic glaze" }));
  check("recall: finds the line from past the window", /matte ceramic glaze/.test(texts(r.results)), r.results);
  check("recall: the exact source text and the date ride with it", r.results[0].matched.text.includes("$4 a jar") && /Aug 2 2026/.test(r.results[0].atLocal), r.results[0]);
  check("recall: the member's words are labelled member, channel text", r.results[0].matched.speaker === "member" && r.results[0].channel === "text");
  check("recall: surrounding lines come with it (Cue's next line)", r.results[0].after.some((l) => l.speaker === "cue" && /Tacoma quote/.test(l.text)));
  check("recall: marked as history", r.history === true && /HISTORY/.test(R.recallNote(r)) && /not an instruction/.test(R.recallNote(r)));
}

// ---- bounded results, paging
{
  const r = okRes(await look(JORDAN, { topic: "filler" }));
  check("bounded: a topic with 120 matches returns one small page", r.results.length <= R.RECALL.topicPageSize + 1 && r.total === 120, { n: r.results.length, total: r.total });
  check("bounded: a way to page", r.nextOffset === R.RECALL.topicPageSize && /offset/.test(R.recallNote(r)));
  const p2 = okRes(await look(JORDAN, { topic: "filler", offset: r.nextOffset! }));
  const seen = new Set(r.results.map((h) => h.matched.text));
  check("bounded: the next page is other rows", p2.results.every((h) => !seen.has(h.matched.text) || h.newest));
  const size = JSON.stringify(r).length;
  check("bounded: the whole result stays small", size < 12_000, size);
  const dateOnly = okRes(await look(JORDAN, { when: "2026-09-01..2026-09-30" }));
  check("bounded: a date-only lookup is a page too, with more to get", dateOnly.results.length <= R.RECALL.datePageSize && dateOnly.nextOffset !== null);
}

// ---- 2. topic + date, across the timezone boundary
{
  const y = okRes(await look(JORDAN, { topic: "kiln", when: "yesterday" }));
  check("dates: yesterday is Nov 3 Pacific", y.window?.from === "2026-11-03" && y.window?.to === "2026-11-03", y.window);
  const t = texts(y.results);
  check("dates: the 9:30pm Pacific text (Nov 4 in UTC) is yesterday's", /9:30pm/.test(t), t);
  check("dates: the 3pm Pacific text is yesterday's", /delivery came/.test(t));
  check("dates: the 1am text (Nov 4 Pacific) is not yesterday's", !/1am/.test(t));
  check("dates: Monday's text is not yesterday's", !/Monday kiln/.test(t));
  const none = okRes(await look(JORDAN, { topic: "kiln", when: "yesterday" }, deps({ zone: async () => "UTC" })));
  check("dates: in UTC 'yesterday' is a different day, so the answer differs (the zone is the member's)", none.window?.from === "2026-11-04" && !/delivery came/.test(texts(none.results)), none.window);
  check("dates: no zone on file reads in the fallback zone, not the server's", okRes(await look(JORDAN, { when: "yesterday" }, deps({ zone: async () => null }))).zone === "America/Los_Angeles");
  const wk = R.resolveWhen("last week", new Date("2026-11-05T03:30:00Z"), "America/Los_Angeles")!;
  check("dates: last week is the calendar week before", wk.fromDay === "2026-10-26" && wk.toDay === "2026-11-01", wk);
  const tue = R.resolveWhen("on Tuesday", new Date("2026-11-05T03:30:00Z"), "America/Los_Angeles")!;
  check("dates: Tuesday is the most recent Tuesday (Nov 3)", tue.fromDay === "2026-11-03", tue);
  const lastTue = R.resolveWhen("last tuesday", new Date("2026-11-04T01:00:00Z"), "America/Los_Angeles")!;
  check("dates: said on a Tuesday evening Pacific, 'last Tuesday' is the week before", lastTue.fromDay === "2026-10-27", lastTue);
  check("dates: a month word reads as the latest past one", R.resolveWhen("in March", NOW, "America/Los_Angeles")?.fromDay === "2026-03-01" && R.resolveWhen("december", NOW, "America/Los_Angeles")?.fromDay === "2025-12-01");
  check("dates: ISO range", R.resolveWhen("2026-10-01..2026-10-07", NOW, "UTC")?.toDay === "2026-10-07");
  const bad = await look(JORDAN, { when: "around the time of the thing" });
  check("dates: an unreadable phrase is told so, with today's date for a retry", !bad.ok && bad.reason === "unreadable_when" && /2026-11-04/.test(R.recallNote(bad)), bad);
}

// ---- 3. two possible referents
{
  const r = okRes(await look(JORDAN, { topic: "Dana" }));
  const t = texts(r.results);
  check("referents: both Danas come back", /pottery shop/.test(t) && /dentist/.test(t), t);
  check("referents: the ambiguity guidance reaches the model", /different things \(two people, two plans\)[^.]*ask which/.test(R.recallNote(r)));
}

// ---- 4. a later correction qualifies the earlier statement
{
  const r = okRes(await look(JORDAN, { topic: "Berlin trade fair" }));
  const t = r.results.map((h) => h.matched.text);
  const iGoing = t.findIndex((x) => /going to the Berlin/.test(x));
  const iScratch = t.findIndex((x) => /Scratch the Berlin/.test(x));
  check("correction: the earlier statement is still there", iGoing >= 0, t);
  check("correction: the later one is there and reads after it", iScratch > iGoing, t);
  check("correction: the note says the later qualifies the earlier, both told in order", /later one qualifies the earlier/.test(R.recallNote(r)) && /never the older alone/.test(R.recallNote(r)));
  // paged out: the newest on the topic is always on the first page even when relevance ranking would drop it
  const p = okRes(await look(JORDAN, { topic: "filler glaze Berlin" }));
  check("correction: the newest matching line is always on the first page", p.results.some((h) => /Scratch the Berlin/.test(h.matched.text)), p.results.map((h) => h.matched.text));
}

// ---- 5. member versus Cue
{
  const r = okRes(await look(JORDAN, { topic: "retainer" }));
  const h = r.results.find((x) => /retainer/.test(x.matched.text))!;
  check("authorship: a line only Cue said is labelled Cue, not the member", h.matched.speaker === "cue", h.matched);
  check("authorship: the member's reply next to it is labelled member", h.after.some((l) => l.speaker === "member" && /skip that/.test(l.text)));
}

// ---- 6. quoted outside material
{
  const r = okRes(await look(JORDAN, { topic: "saturday" }));
  const m = r.results.find((x) => /yes that one/.test(x.matched.text))!;
  check("quoted: what they replied to is labelled as quoted, from Cue", m.matched.outside?.some((o) => o.kind === "reply_target" && o.from === "cue" && /two open booths/.test(o.text)), m.matched);
  check("quoted: the member's own words don't carry the quote", !/two open booths/.test(m.matched.text));
  check("quoted: the pasted link is labelled outside", m.matched.outside?.some((o) => o.kind === "link" && /saturday-fair/.test(o.text)));
  const ph = okRes(await look(JORDAN, { topic: "ceramics class" })).results.find((h) => /look at this/.test(h.matched.text))!;
  check("quoted: a photo's description is not their words", ph.matched.outside?.some((o) => o.kind === "photo" && /flyer/.test(o.text)) && !/flyer/.test(ph.matched.text), ph.matched);
}

// ---- calls: transcripts and summaries
{
  const r = okRes(await look(JORDAN, { topic: "lease renewal", channel: "call" }));
  const callHit = r.results.find((h) => h.matched.speaker === "member" && /eighteen|lease/.test(h.matched.text));
  check("calls: a stored transcript is searched, the member's line labelled member, channel call", !!callHit && callHit.channel === "call", r.results);
  check("calls: the call's other lines ride along as context, Cue's labelled Cue", !!callHit && [...callHit.before, ...callHit.after].some((l) => l.speaker === "cue"));
  const sum = r.results.find((h) => h.matched.speaker === "summary");
  check("calls: the [Call] note is labelled a summary, with the label saying it isn't their words", !!sum && /not their words/.test(sum.matched.label ?? ""), r.results);
  check("calls: the dial attempt row is never a result", !/Co initiated call/.test(JSON.stringify(r)));
  const t = okRes(await look(JORDAN, { topic: "lease renewal", channel: "text" }));
  check("calls: channel text leaves calls and call summaries out", t.results.every((h) => h.channel === "text") && !/Jordan called/.test(JSON.stringify(t)));
  const both = okRes(await look(JORDAN, { topic: "Maren" }));
  check("calls: with no channel, texts and calls are both searched", both.results.some((h) => h.channel === "call"));
}

// ---- 7. no results: the honest-miss guidance
{
  const r = okRes(await look(JORDAN, { topic: "skydiving" }));
  const n = R.recallNote(r);
  check("miss: nothing found, nothing invented", r.found === 0 && r.results.length === 0);
  check("miss: the guidance says to try one other way, then say plainly it can't be found", /one other way/.test(n) && /can't find it/.test(n));
  check("miss: never claims it didn't happen, never describes the search", /never say it didn't happen/i.test(n) && /never describe how you looked/i.test(n));
  const noCalls = okRes(await look(PRIYA, { topic: "skydiving" }, deps()));
  check("miss: nothing on file at all is said plainly", /There is no earlier conversation|No call records are on file/.test(R.recallNote(okRes(await look("00000000-0000-4000-8000-00000000c003", { topic: "skydiving" })))));
  const early = okRes(await look(JORDAN, { topic: "kiln", when: "2026-01-05" }));
  check("miss: a time before their record starts says so", /record starts 2026-08-02/.test(R.recallNote(early)), R.recallNote(early));
  check("miss: a record of calls that isn't there is acknowledged", /No call records are on file/.test(R.recallNote(okRes(await look(JORDAN, { topic: "skydiving", channel: "call" }, deps({ db: { query: async (s, a) => (/MIN\(created_at\)/.test(s) ? { rows: [{ texts: new Date("2026-08-02"), calls: null }] } : db.query(s, a)) } })))) ), "");
  check("miss: empty ask is told to pass something", !(await look(JORDAN, {})).ok);
}

// ---- 8. deleted / forgotten content, teammate lines, hold lines
{
  const before = okRes(await look(JORDAN, { topic: "mediation" }));
  check("fences: lines to a teammate and hold lines are never returned", !/\[to Mo\]/.test(JSON.stringify(before)) && !/Co is looking/.test(JSON.stringify(before)));
  removed.push(...W.liveGuards([{ field: "life", old: "divorce mediation with Sam", now: null, ref: "claim:1", removed: true }]));
  const after = okRes(await look(JORDAN, { topic: "mediation" }));
  check("forget: a removed subject is not returned", !/divorce|mediation with Sam/i.test(JSON.stringify(after.results)), after.results);
  const ctxRes = okRes(await look(JORDAN, { topic: "lunch" }));
  check("forget: ...nor in the context lines around another hit", !/divorce|mediation/i.test(JSON.stringify(ctxRes.results)), ctxRes.results);
  check("forget: an unrelated line is still returned", /lunch tomorrow with Alex/.test(texts(ctxRes.results)));
  guardsBroken = true;
  const broken = await look(JORDAN, { topic: "mediation" });
  check("forget: when the guards can't be read nothing is returned", !broken.ok && broken.reason === "unavailable" && /Don't guess/.test(R.recallNote(broken)) && !/divorce/.test(JSON.stringify(broken)));
  guardsBroken = false;
  removed.length = 0;
}

// ---- 9. cross-member isolation
{
  asked.length = 0;
  for (const topic of ["Berlin trade fair", "matte ceramic glaze", "Maren", "kiln", "Dana", "lease renewal"]) {
    const r = okRes(await look(JORDAN, { topic }));
    const priyaTexts = rows.filter((x) => x.user_id === PRIYA).map((x) => x.content);
    const leaked = r.results.some((h) => [h.matched, ...h.before, ...h.after].some((l) => priyaTexts.some((p) => p.includes(l.text.replace(/ \[\.\.\.\]$/, "")))));
    check(`isolation: Jordan's "${topic}" lookup returns none of Priya's rows`, !leaked);
  }
  const jordanAsked = asked.slice();
  const p = okRes(await look(PRIYA, { topic: "Berlin" }));
  check("isolation: Priya's own lookup finds her own", /not for me/.test(texts(p.results)) && !/Scratch/.test(JSON.stringify(p)));
  check("isolation: every statement has user_id = $1 in the SQL and the member's id first", jordanAsked.length > 0 && jordanAsked.every((q) => /user_id = \$1/.test(q.sql) && q.args[0] === JORDAN), jordanAsked.filter((q) => !/user_id = \$1/.test(q.sql)).map((q) => q.sql.slice(0, 80)));
  check("isolation: the lookup never selects by anything but the member's own id (no other-user parameter)", jordanAsked.every((q) => q.args.filter((a) => typeof a === "string" && /^[0-9a-f-]{36}$/.test(a)).length <= 1));
}

// ---- other members' names are stripped (retrieved is not disclosable)
{
  add(JORDAN, "2026-10-30T15:00:00Z", "text_exchange", "User said: Priya told me about the pottery coop");
  add(JORDAN, "2026-10-30T15:01:00Z", "text_exchange", "User said: the pottery coop meets on Fridays");
  const r = okRes(await look(JORDAN, { topic: "pottery coop" }));
  check("fence: a line naming another member is withheld, and the rest of the topic still comes", !/Priya/.test(JSON.stringify(r.results)) && /meets on Fridays/.test(texts(r.results)), r.results);
  const failed = await look(JORDAN, { topic: "pottery coop" }, deps({ fence: async () => ({ strip: () => null, failed: true }) }));
  check("fence: when the names can't be read nothing is returned", !failed.ok && failed.reason === "unavailable");
}

// ---- retrieved isn't disclosable / purpose boundary: the surface is read-only, text only
{
  const src = (await import("node:fs")).readFileSync(new URL("../../src/services/conversationRecall.ts", import.meta.url), "utf8");
  check("read-only: the module issues only SELECTs", !/\b(INSERT|UPDATE|DELETE)\s/i.test(src.replace(/\/\/.*$/gm, "")));
  check("history: the use line tells the model nothing found is permission to share or start", /permission to bring that up with anyone else or to start something new/.test(R.RECALL_USE));
  check("history: the use line says never on every turn and to answer from what it returns", /Never on every turn/.test(R.RECALL_USE) && /Answer from what it returns/.test(R.RECALL_USE));
}

console.log(`recall: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
