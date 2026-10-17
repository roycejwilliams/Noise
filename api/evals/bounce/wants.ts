// The bounce, part 1 (Royce, 2026-10-15): wants from conversation. A window on a want ("I'm in Chicago til Friday" sets the place AND
// the window), stated free time as knowledge (proposed against, never held), both only from their own words, visible and removable,
// recorded on a call after they've been heard, and a want with no place says it looks near home. Zero tokens: the database is a stub.
//   npx tsx evals/bounce/wants.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const WW = await import("../../src/services/wantWhen.js");
const T = await import("../../src/agent/conversationTools.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

// ---------------------------------------------------------------- their words, only theirs
check("a quote copied from their message is theirs", T.theirQuote("ugh this trip, I'm in Chicago til Friday and slammed", null, "I'm in Chicago til Friday") === "I'm in Chicago til Friday");
check("on a call, their lines in the last turns count; Co's never do", T.theirQuote("yeah", "Member: I'm in Chicago til Friday\nCo: you're in Chicago til Friday?", "in Chicago til Friday") === "in Chicago til Friday" && T.theirQuote("yeah", "Co: so you're free Tuesday 4 to 5:30", "free Tuesday 4 to 5:30") === null);
check("a paraphrase that isn't in their words is nothing", T.theirQuote("I'm slammed this week", null, "free Tuesday 4 to 5:30") === null && T.theirQuote("x", null, "") === null);

// ---------------------------------------------------------------- windows (today: Thursday 2026-10-15)
const today = "2026-10-15";
check("'til Friday' sets the window to this Friday", WW.windowBacked("2026-10-16", "I'm in Chicago til Friday", today) === "2026-10-16");
check("a day their words don't say is no window ('til Friday' isn't Saturday)", WW.windowBacked("2026-10-17", "I'm in Chicago til Friday", today) === null);
check("a date in their words: 'through the 20th', 'until Oct 30', 'til 10/22'", WW.windowBacked("2026-10-20", "here through the 20th", today) === "2026-10-20" && WW.windowBacked("2026-10-30", "until Oct 30", today) === "2026-10-30" && WW.windowBacked("2026-10-22", "til 10/22", today) === "2026-10-22");
check("'tomorrow' and 'tonight'", WW.windowBacked("2026-10-16", "flying out tomorrow", today) === "2026-10-16" && WW.windowBacked("2026-10-15", "only here tonight", today) === "2026-10-15");
check("a past day, or one far off, is no window", WW.windowBacked("2026-10-14", "til Wednesday", today) === null && WW.windowBacked("2027-01-20", "until Jan 20", today) === null);

// ---------------------------------------------------------------- stated free time
check("'Tuesday 4 to 5:30 is my dead spot' is a weekly free time", JSON.stringify(WW.freeTimeBacked({ weekday: "tuesday", from: "16:00", to: "17:30" }, "Tuesday 4 to 5:30 is my dead spot", today)) === JSON.stringify({ weekday: "tuesday", date: null, from: "16:00", to: "17:30" }));
check("times their words don't say are no free time", WW.freeTimeBacked({ weekday: "tuesday", from: "15:00", to: "17:30" }, "Tuesday 4 to 5:30 is my dead spot", today) === null);
check("vague time is never a gap ('Tuesday afternoons are quiet')", WW.freeTimeBacked({ weekday: "tuesday", from: "13:00", to: "17:00" }, "Tuesday afternoons are quiet", today) === null);
check("a day their words don't say is no free time", WW.freeTimeBacked({ weekday: "wednesday", from: "16:00", to: "17:30" }, "Tuesday 4 to 5:30 is my dead spot", today) === null);
check("a one-time free time on a date they said ('free Oct 20 from 2 to 4')", WW.freeTimeBacked({ date: "2026-10-20", from: "14:00", to: "16:00" }, "I'm free Oct 20 from 2 to 4", today)?.date === "2026-10-20");
check("a span that isn't one (backwards, or all day) is no gap", WW.freeTimeBacked({ weekday: "tuesday", from: "17:30", to: "16:00" }, "Tuesday 4 to 5:30", today) === null && WW.freeTimeBacked({ weekday: "tuesday", from: "04:00", to: "23:30" }, "Tuesday 4 to 11:30", today) === null);
check("said back plainly", WW.describeFreeTime({ weekday: "tuesday", date: null, from: "16:00", to: "17:30" }) === "Tuesdays, 4pm to 5:30pm");
check("a weekly free time falls on that weekday; a dated one on its date", WW.freeOn({ weekday: "tuesday", date: null, from: "16:00", to: "17:30" }, "2026-10-20") && !WW.freeOn({ weekday: "tuesday", date: null, from: "16:00", to: "17:30" }, "2026-10-21") && WW.freeOn({ weekday: null, date: "2026-10-20", from: "14:00", to: "16:00" }, "2026-10-20"));

// ---------------------------------------------------------------- saving the want with its place and window (the database is a stub)
{
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  // The want's place read is a model call: answered here with "no place", so this block never reaches the network.
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => /anthropic\.com/.test(String(url))
    ? new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } })
    : fetchBefore(url, init)) as typeof fetch;
  const writes: { sql: string; args: any[] }[] = [];
  let stored: any = null;
  (pool as any).query = async (q: string, args: any[] = []) => {
    if (/FROM ask_checkins WHERE user_id = \$1 AND resolved_at IS NULL AND ask_text = \$2/.test(q)) return { rows: [{ id: "a1" }] };
    if (/SELECT city FROM co_profiles/.test(q)) return { rows: [{ city: "Sacramento" }] };
    if (/INSERT INTO want_places/.test(q)) {
      writes.push({ sql: q, args });
      stored = { place: args[3], source: args[4] };
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT want_key, place, source, quote, noted_at FROM want_places/.test(q)) return { rows: stored ? [{ want_key: "ask:a1", place: stored.place, source: stored.source, quote: null, noted_at: null }] : [] };
    return { rows: [] };
  };
  try {
    const { localDay } = await import("../../src/services/memberTime.js");
    const now = localDay(new Date(), null);
    const tomorrow = new Date(Date.parse(`${now}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const ctx = { userId: "u", resolvedContent: "this trip is brutal. I'm in Chicago til tomorrow and I just need one good thing", recentExchange: null, lastCoMessage: null };
    const w = await T.wantWhereFromWords(ctx, "something good to do", { place: "Chicago", until: tomorrow, theirWords: "I'm in Chicago til tomorrow" });
    check("'I'm in Chicago til tomorrow' saves the want with its place AND its window", writes.length === 1 && writes[0].args[3] === "Chicago" && writes[0].args[7] === tomorrow && /in Chicago/.test(w?.fact ?? "") && /until/.test(w?.fact ?? ""), { writes: writes.map((x) => x.args), w });
    writes.length = 0;
    stored = null;
    const g = await T.wantWhereFromWords(ctx, "something good to do", { place: "Detroit", until: tomorrow, theirWords: "I'm in Detroit til tomorrow" });
    // (The want's own words are still read for a place: that read may store "no place", never Detroit or a window.)
    check("a place or window not in their words isn't kept, and Cue is told so", !writes.some((x) => x.args[3] || x.args[7]) && /isn't kept/.test(g?.note ?? ""), { g, writes: writes.map((x) => x.args) });
    check("... and with no place, Cue says it looks near home (or asks)", /near their home \(Sacramento\)/.test(g?.note ?? "") && /or ask where/.test(g?.note ?? ""));
  } finally {
    (pool as any).query = real;
    globalThis.fetch = fetchBefore;
  }
}

// ---------------------------------------------------------------- visible and removable
{
  const K = await import("../../src/services/whatCoKnows.js");
  const items = K.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], places: [{ key: "ask:a1", want: "something good to do", place: "Chicago", until: "2026-10-16" }], freeTimes: [{ id: "7", text: "Tuesdays, 4pm to 5:30pm", quote: "Tuesday 4 to 5:30 is my dead spot" }] });
  const win = items.find((i) => i.ref === "window:ask:a1");
  const free = items.find((i) => i.ref === "free:7");
  check("what Cue knows shows the want's window and their free time, with their words", !!win && /until 2026-10-16/.test(win.text) && !!free && /Tuesdays, 4pm to 5:30pm/.test(free.text) && free.theirWords === "Tuesday 4 to 5:30 is my dead spot");
  check("both can be removed (a new one is said again, not reworded)", win!.canCorrect === false && free!.canCorrect === false);
  const sqls: string[] = [];
  const db = { query: async (sql: string) => (sqls.push(sql), { rows: [], rowCount: 1 }) };
  const a = await K.applyOne(db, "u", {} as any, free!, "remove", null, "forget the Tuesday thing");
  const b = await K.applyOne(db, "u", {} as any, win!, "remove", null, "I'm staying longer");
  check("removing a free time takes it out of what's proposed against; removing a window keeps the want", "now" in a && a.now === null && /UPDATE member_free_times SET removed_at = NOW\(\)/.test(sqls[0]) && "now" in b && /SET window_start = NULL, window_end = NULL/.test(sqls[1]));
}

// ---------------------------------------------------------------- review of #220: a window never hides the want's place
{
  const P = await import("../../src/services/wantPlace.js");
  const want = { key: "ask:a1", text: "a dinner spot in Chicago", createdAt: new Date() };
  let reads = 0;
  const saved: any[] = [];
  const deps = (row: any) => ({ since: async () => null, row: async () => row, told: async () => [], model: async () => (reads++, '{"place":"Chicago","quote":"in Chicago"}'), save: async (_u: string, _w: any, p: any) => void saved.push(p), log: async () => {} });
  const got = await P.placeFor("u", want, deps({ key: "ask:a1", place: null, source: "unread", quote: null, notedAt: null }) as any);
  check("a row made only by a window ('unread') still gets its place read from the want's words", reads === 1 && got.place === "Chicago" && got.source === "their_words" && saved.length === 1, { got, reads });
  reads = 0;
  const kept = await P.placeFor("u", want, deps({ key: "ask:a1", place: null, source: "none", quote: null, notedAt: null }) as any);
  check("... while a real read ('none') is kept, never read twice", reads === 0 && kept.source === "none");
  const wp = src("services/wantPlace.ts");
  check("the read's save fills in an 'unread' row and never overwrites a real one", /ON CONFLICT \(user_id, want_key\) DO UPDATE SET place = EXCLUDED\.place[\s\S]{0,200}WHERE want_places\.source = 'unread'/.test(wp));
  check("a window saved with no place is 'unread', never 'none'", /w\.place \? "their_words" : "unread"/.test(src("services/wantWhen.ts")));
  check("the source check allows 'unread'", /want_places_source_check CHECK \(source IN \([^)]*'unread'\)\)/.test(src("db/migrations.ts")));

  // The tool, with no place passed: the want's own words are read, so it never says "near home" when they named a city.
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  const realFetch = globalThis.fetch;
  (pool as any).query = async (q: string) => {
    if (/FROM ask_checkins WHERE user_id = \$1 AND resolved_at IS NULL AND ask_text = \$2/.test(q)) return { rows: [{ id: "a1" }] };
    if (/SELECT city FROM co_profiles/.test(q)) return { rows: [{ city: "Sacramento" }] };
    return { rows: [], rowCount: 1 };
  };
  // The place read is a model call: answered here, canned and free.
  globalThis.fetch = (async (url: any, init?: any) => /anthropic\.com/.test(String(url))
    ? new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: '{"place":"Chicago","quote":"in Chicago"}' }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } })
    : realFetch(url, init)) as typeof fetch;
  try {
    const ctx = { userId: "u", resolvedContent: "find me a dinner spot in Chicago, I'm there til Friday", recentExchange: null, lastCoMessage: null };
    const r = await T.wantWhereFromWords(ctx, "a dinner spot in Chicago", { place: null, until: null, theirWords: null } as any);
    check("a want whose own words name the place: Cue is told it's for there, and never 'near home'", /It's for Chicago, from their words/.test(r?.note ?? "") && !/near their home/.test(r?.note ?? "") && /in Chicago/.test(r?.fact ?? ""), r);
  } finally {
    (pool as any).query = real;
    globalThis.fetch = realFetch;
  }
}
{
  const K = await import("../../src/services/whatCoKnows.js");
  const many = Array.from({ length: 9 }, (_, i) => ({ key: `ask:p${i}`, want: `want ${i}`, place: `City ${i}`, source: "their_words" }));
  const items = K.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [],
    places: [...many, { key: "ask:w", want: "something good to do", place: null, source: "unread", until: "2026-10-16" }], freeTimes: [{ id: "7", text: "Tuesdays, 4pm to 5:30pm", quote: "Tuesday 4 to 5:30" }] });
  const where = items.filter((i: any) => i.group === "where");
  const at = (ref: string) => where.findIndex((i: any) => i.ref === ref);
  check("windows and free times come before places, so the group's cap never hides them", at("window:ask:w") >= 0 && at("free:7") >= 0 && at("window:ask:w") < at("place:ask:p0") && at("free:7") < at("place:ask:p0"), where.map((i: any) => i.ref));
  check("an 'unread' row shows its window but no place line", at("place:ask:w") === -1);
  const k = src("services/whatCoKnows.ts");
  check("an ended window is gone from what Cue knows (the want stays)", /const ended = !!until && until < yesterday;/.test(k) && /until: ended \? null : until/.test(k));
  check("removing a free time takes their words with it (removed = raw lines deleted)", /UPDATE member_free_times SET removed_at = NOW\(\), quote = '' WHERE/.test(k));
}
check("an exchange that starts mid-line ('…<tail>') never counts as their words", T.theirQuote("ok", "…free Tuesday 4 to 5:30 works for me\nMember: sounds good", "free Tuesday 4 to 5:30") === null && T.theirQuote("ok", "Member: free Tuesday 4 to 5:30\nCo: noted", "free Tuesday 4 to 5:30") === "free Tuesday 4 to 5:30");
{
  const today = "2026-10-15";
  check("a weekday is a whole word: 'wedding' isn't Wednesday, 'fridge' isn't Friday", WW.freeTimeBacked({ weekday: "wednesday", from: "16:00", to: "17:30" }, "the wedding is 4 to 5:30", today) === null && WW.freeTimeBacked({ weekday: "friday", from: "16:00", to: "17:30" }, "fridge guy comes 4 to 5:30", today) === null);
  check("... and short forms still count ('Tues', 'Thurs', 'Fri.')", WW.freeTimeBacked({ weekday: "tuesday", from: "16:00", to: "17:30" }, "Tues 4 to 5:30", today)?.weekday === "tuesday" && WW.freeTimeBacked({ weekday: "thursday", from: "16:00", to: "17:30" }, "Thurs 4-5:30", today)?.weekday === "thursday" && WW.freeTimeBacked({ weekday: "friday", from: "16:00", to: "17:30" }, "Fri. 4 to 5:30", today)?.weekday === "friday");
  check("an am/pm they said has to agree ('4am' never backs 16:00)", WW.freeTimeBacked({ weekday: "tuesday", from: "16:00", to: "17:30" }, "Tuesday 4am to 5:30am", today) === null && WW.freeTimeBacked({ weekday: "tuesday", from: "16:00", to: "17:30" }, "Tuesday 4pm to 5:30pm", today)?.from === "16:00" && WW.freeTimeBacked({ weekday: "tuesday", from: "09:00", to: "10:30" }, "Tuesday 9am to 10:30am", today)?.from === "09:00");
  check("an impossible time is no free time (25:00, 16:75)", WW.freeTimeBacked({ weekday: "tuesday", from: "16:00", to: "25:00" }, "Tuesday 16 to 25", today) === null && WW.freeTimeBacked({ weekday: "tuesday", from: "16:00", to: "16:75" }, "Tuesday 16 to 16:75", today) === null);
  const qs: string[] = [];
  const dbSame = { query: async (sql: string) => (qs.push(sql), /^\s*SELECT id FROM member_free_times/.test(sql) ? { rows: [{ id: "7" }] } : { rows: [{ id: "8" }] }) };
  const id = await WW.saveFreeTime(dbSame, "u", { weekday: "tuesday", date: null, from: "16:00", to: "17:30" }, "Tuesday 4 to 5:30");
  check("the same free time said twice is kept once", id === "7" && !qs.some((q) => /INSERT INTO member_free_times/.test(q)), qs);
}

// ---------------------------------------------------------------- the window ends (Royce, 2026-10-16)
{
  const P = await import("../../src/services/wantPlace.js");
  const want = { key: "ask:a1", text: "something good to do", createdAt: new Date() };
  const rows: Record<string, any> = { live: { key: "ask:a1", place: "Chicago", source: "their_words", quote: "I'm in Chicago til Friday", notedAt: new Date(), windowEnd: "2026-10-16" } };
  let ended = 0;
  const deps = (today: string | Error) => ({
    since: async () => null, told: async () => [], model: async () => "{}", save: async () => {}, log: async () => {},
    row: async () => rows.live,
    today: async () => { if (today instanceof Error) throw today; return today; },
    endWindow: async () => { ended++; rows.live = { key: "ask:a1", place: null, source: "none", quote: null, notedAt: rows.live.notedAt, windowEnd: null }; },
  });
  const friday = await P.placeFor("u", want, deps("2026-10-16") as any);
  check("on their last day, the window's place is still searched", friday.place === "Chicago" && ended === 0);
  const saturday = await P.placeFor("u", want, deps("2026-10-17") as any);
  check("'in Chicago til Friday': on Saturday (their day) Chicago is no longer searched, home stands in", ended === 1 && saturday.place === null && saturday.source === "none", saturday);
  rows.live = { key: "ask:a1", place: "Chicago", source: "their_words", quote: "x", notedAt: null, windowEnd: "2026-10-16" };
  ended = 0;
  const unknown = await P.placeFor("u", want, deps(new Error("no zone")) as any);
  check("a day that can't be read leaves the window as it is", ended === 0 && unknown.place === "Chicago");

  const sqls: { sql: string; args: unknown[] }[] = [];
  const db = { query: async (sql: string, args: unknown[] = []) => (sqls.push({ sql, args }), { rows: [], rowCount: 2 }) };
  await WW.endWindow(db, "u", "ask:a1");
  const n = await WW.endPastWindows(db);
  const end = sqls[0].sql;
  check("ending a window deletes its words and dates, and a place read from what they said (their words or told); a corrected place stays",
    /window_start = NULL, window_end = NULL, window_quote = NULL/.test(end) && /place = CASE WHEN source IN \('their_words', 'told'\) THEN NULL ELSE place END/.test(end) && /quote = CASE WHEN source IN \('their_words', 'told'\) THEN NULL ELSE quote END/.test(end) && !/'corrected'/.test(end) && !/DELETE/.test(end));
  check("the hourly backstop ends every window past on any clock", n === 2 && /window_end < CURRENT_DATE - 1/.test(sqls[1].sql) && /endPastWindows\(\)/.test(src("jobs/index.ts")));
  const K = await import("../../src/services/whatCoKnows.js");
  check("what Cue knows never shows a bare 'Chicago' once the window's over", /ended && \(r\.source === "their_words" \|\| r\.source === "told"\) \? null/.test(src("services/whatCoKnows.ts")));
  void K;
}
{
  const today = "2026-10-15"; // a Thursday
  check("'til Fri' and 'til Sun' are windows too", WW.windowBacked("2026-10-16", "here til Fri", today) === "2026-10-16" && WW.windowBacked("2026-10-18", "in town until Sun", today) === "2026-10-18");
  check("'I sat around 4 to 5:30' isn't Saturday, 'the sun is out 4 to 5:30' isn't Sunday", WW.freeTimeBacked({ weekday: "saturday", from: "16:00", to: "17:30" }, "I sat around 4 to 5:30", today) === null && WW.freeTimeBacked({ weekday: "sunday", from: "16:00", to: "17:30" }, "the sun is out 4 to 5:30", today) === null);
  check("... while 'Sat 4-5:30' still is", WW.freeTimeBacked({ weekday: "saturday", from: "16:00", to: "17:30" }, "Sat 4-5:30 works", today)?.weekday === "saturday");
  const qs: { sql: string; args: unknown[] }[] = [];
  await WW.saveWantWhere({ query: async (sql: string, args: unknown[] = []) => (qs.push({ sql, args }), { rows: [] }) }, "u", "ask:a1", "something good", { place: null, placeQuote: null, windowStart: null, windowEnd: "2026-10-16", windowQuote: "til Friday" });
  check("a window saved with no place doesn't use up the once-only 'where your finds come from' line", /CASE WHEN \$4::text IS NOT NULL THEN NOW\(\) END/.test(qs[0].sql) && /noted_at = COALESCE\(want_places\.noted_at, EXCLUDED\.noted_at\)/.test(qs[0].sql) && qs[0].args[3] === null);
}

// ---------------------------------------------------------------- on a call: heard first, then the want
{
  const caps = src("services/capabilities.ts");
  const entry = (id: string) => caps.slice(caps.indexOf(`id: "${id}"`), caps.indexOf('\n    id: "', caps.indexOf(`id: "${id}"`) + 10));
  const save = entry("save_ask");
  const free = entry("free_time");
  check("saving a want and noting free time both work on a call", /onCall: true/.test(save) && /onCall: true/.test(free));
  check("hear them first: the want is saved after what they feel is answered, never in the same breath", /hear them first/.test(save) && /never in the same breath/.test(save) && /Hear them first/.test(free));
  check("never a guessed gap: Cue may ask instead", /never a gap you work out/.test(free) && /you may ask instead/.test(free));
  const mig = src("db/migrations.ts");
  check("a free time is a weekday or a date, never both, and their words are kept with it", /CHECK \(\(weekday IS NULL\) <> \(on_date IS NULL\)\)/.test(mig) && /quote TEXT NOT NULL/.test(mig));
}

console.log(`bounce wants: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
