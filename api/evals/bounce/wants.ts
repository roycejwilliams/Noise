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
    check("a place or window not in their words isn't kept, and Cue is told so", writes.length === 0 && /isn't kept/.test(g?.note ?? ""), g);
    check("... and with no place, Cue says it looks near home (or asks)", /near their home \(Sacramento\)/.test(g?.note ?? "") && /or ask where/.test(g?.note ?? ""));
  } finally {
    (pool as any).query = real;
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
