// The bounce, Royce's fixes (2026-10-15): "Want me to keep an eye on it?" is honest at every floor and a yes starts the watching;
// stated times are read in the zone the plan is in; the calendar is offered once, the first time a plan would be sharper with it.
// Zero tokens: the database, Google and the queue are stubs.
//   npx tsx evals/bounce/watch.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.GOOGLE_TOKEN_KEY = Buffer.alloc(32, 5).toString("base64");
import { readFileSync } from "fs";
import { DateTime } from "luxon";

const B = await import("../../src/services/bounce.js");
const { shadowKey } = await import("../../src/services/sweepShadow.js");
const { default: pool } = await import("../../src/db/db.js");
const realQuery = (pool as any).query;
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

const HOME = "America/Los_Angeles";
const CHI = "America/Chicago";
const today = DateTime.now().setZone(HOME).toISODate()!;
const day = DateTime.now().setZone(CHI).plus({ days: 3 }).toISODate()!;
const weekday = DateTime.fromISO(day).toFormat("cccc").toLowerCase();
const want = { key: "ask:a1", text: "something to clear my head between meetings", place: "Chicago", until: DateTime.fromISO(day).plus({ days: 1 }).toISODate()!, quote: "I'm in Chicago til Friday" };
const findAt = (name: string, hhmm: string, zone: string, withZone: boolean, mins = 90) => {
  const s = DateTime.fromISO(`${day}T${hhmm}`, { zone });
  return { askId: "a1", askText: "x", match: { tier: 2, kind: "public_event", name, event_date: day, url: `https://lu.ma/${name.replace(/\W/g, "")}`, reason: "x", whyItFits: "quiet, art", details: { startAt: s.toUTC().toISO(), endAt: s.plus({ minutes: mins }).toUTC().toISO(), venue: "near the hotel", ...(withZone ? { timezone: zone } : {}) } } };
};
const judged = (f: any) => ({ key: shadowKey(f.match.name, f.match.event_date), verdict: "send" });
// "3:30 to 6" for the Chicago trip, in their words.
const stated = [{ weekday, date: null, from: "15:30", to: "18:00", quote: `${weekday} 3:30 to 6 is my dead spot` }];
const o = (zone: string, f: any) => ({ today, zone, judged: [judged(f)], stated, calendarFree: () => null as boolean | null, proposed: new Set<string>() });

// ---------------------------------------------------------------- 2. the zone the plan is in
{
  const gallery = findAt("Small gallery opening", "16:00", CHI, true);
  const p = B.pickProposal(want, [gallery], o(HOME, gallery));
  check("a Chicago find at 4pm Chicago, stated '3:30 to 6': proposed, read in Chicago time (not home's 2pm)", p?.gap.source === "stated" && p.times.from === "16:00" && p.zone === CHI, p);
  const late = findAt("Late set", "19:00", CHI, true);
  check("7pm Chicago is 5pm at home: inside '3:30 to 6' only if read in the wrong zone, so never proposed", B.pickProposal(want, [late], o(HOME, late)) === null);
  const noZone = findAt("Small gallery opening", "16:00", CHI, false);
  check("a find with no zone of its own is read in the want's place's zone (what bounceFor passes for a Chicago want)", B.pickProposal(want, [noZone], o(CHI, noZone))?.times.from === "16:00");
  check("... and the same find read in the home zone would have missed it (the bug this closes)", B.pickProposal(want, [noZone], o(HOME, noZone)) === null);
  check("the find's own zone wins over the one passed in", B.planZone({ details: { timezone: CHI } }, HOME) === CHI && B.planZone({ details: {} }, HOME) === HOME && B.planZone({ details: { timezone: "Not/AZone" } }, HOME) === HOME);
  const brief = B.proposalBrief({ want, match: gallery.match, gap: p!.gap, times: p!.times, zone: p!.zone });
  check("the message says the plan's local time (4 pm), and the free time as they said it (3:30 to 6 pm)", brief.facts.starts === "4 pm" && /^3:30 pm to 6 pm/.test(brief.facts.their_free_time), brief.facts);
  check("the watch ends when the plan starts in Chicago, not at home", B.watchUntil({ times: p!.times, zone: p!.zone })?.toISOString() === DateTime.fromISO(`${day}T16:00`, { zone: CHI }).toUTC().toISO({ suppressMilliseconds: true })?.replace("Z", ".000Z"));
  check("the run reads each want in its place's zone, and queues with the plan's zone", /const wz = await wantZone\(want, zone\)/.test(src("services/bounce.ts")) && /await queueProposal\(userId, pick, pick\.zone\)/.test(src("services/bounce.ts")) && /getTimezoneForCity\(want\.place\)/.test(src("services/bounce.ts")));
}

// ---------------------------------------------------------------- 1. "want me to keep an eye on it?", honest at every floor
{
  const g = findAt("Small gallery opening", "16:00", CHI, true);
  const times = { day, from: "16:00", to: "17:30" };
  const cal = B.proposalBrief({ want, match: g.match, gap: { source: "calendar", day, from: "16:00", to: "17:30", quote: null }, times, zone: CHI });
  const st = B.proposalBrief({ want, match: g.match, gap: { source: "stated", day, from: "15:30", to: "18:00", quote: "dead spot" }, times, zone: CHI });
  check("both floors end on 'want me to keep an eye on it?'; 'hold it' is gone", /"want me to keep an eye on it\?"/.test(cal.task) && /"want me to keep an eye on it\?"/.test(st.task) && !/hold it\?/.test(cal.task + st.task));
  check("the promise says what's watched at each floor: their calendar, or the time they told Cue", /their calendar stays free/.test(cal.task) && /the time they told you is still theirs/.test(st.task));
  check("never hold, book, reserve or save, at either floor", /Never say you'll hold, book, reserve or save anything/.test(cal.task) && /Never say you'll hold, book, reserve or save anything/.test(st.task));
  check("what Cue says it can do no longer claims it holds a time", !/holds a time/.test(src("services/capabilities.ts")) && /Co never holds, books or reserves a time/.test(src("services/capabilities.ts")));

  // A yes starts the watching; a no starts nothing.
  const plan = { match: g.match, askText: "x", gap: { source: "stated", day, from: "15:30", to: "18:00", quote: "dead spot" }, times, zone: CHI };
  for (const yes of [true, false]) {
    const qs: { q: string; a: any[] }[] = [];
    const db = { query: async (q: string, a: any[] = []) => (qs.push({ q, a }), /UPDATE bounce_proposals SET status = \$2/.test(q) ? { rows: [{ id: "7", find_name: g.match.name, find_day: day, gap_from: "15:30:00", gap_source: "stated", plan }] } : { rows: [], rowCount: 1 }) };
    const r = await B.answerLatest("u1", yes, yes ? "yes keep an eye on it" : "no thanks", db);
    const watch = qs.find((x) => /SET watch_until = \$2/.test(x.q));
    if (yes) check("their yes starts the watch, until the plan starts", r?.watching === true && !!watch && (watch.a[1] as Date).getTime() === DateTime.fromISO(`${day}T16:00`, { zone: CHI }).toMillis());
    else check("their no starts nothing", r?.watching === false && !watch);
  }
  const t = src("agent/conversationTools.ts");
  const ans = t.slice(t.indexOf("answerProposal: tool"), t.indexOf("noteFreeTime: tool"));
  check("after a yes Cue says it's keeping an eye on it only when the watch actually started, never that anything's held", /r\.watching \?/.test(ans) && /You're keeping an eye on it until it starts/.test(ans) && /can't be watched; don't say you're keeping an eye on it/.test(ans) && /Nothing is booked or held/.test(ans));

  // The watch itself.
  check("a look: either changed tells them; unknown says nothing and looks again", B.watchStep("changed", "holds") === "tell" && B.watchStep("holds", "changed") === "tell" && B.watchStep("holds", "holds") === "keep" && B.watchStep("unknown", "holds") === "keep" && B.watchStep("holds", "unknown") === "keep");
  const run = async (rowsFor: any[], f: B.WatchRead, gap: B.WatchRead | "unwatchable") => {
    const qs: { q: string; a: any[] }[] = [];
    const queued: any[] = [];
    (pool as any).query = async (q: string, a: any[] = []) => {
      qs.push({ q, a });
      if (/SELECT id, user_id, find_name, plan FROM bounce_proposals WHERE status = 'accepted'/.test(q)) return { rows: rowsFor };
      if (/watch_outcome = \$2 WHERE id = \$1 AND watch_ended_at IS NULL RETURNING id/.test(q)) return { rows: [{ id: a[0] }] };
      return { rows: [], rowCount: 1 };
    };
    try {
      const n = await B.runBounceWatches(new Date(), { findNow: async () => f, gap: async () => gap as any, enqueue: async (x) => (queued.push(x), {}) });
      return { n, qs, queued };
    } finally {
      (pool as any).query = realQuery;
    }
  };
  const row = { id: "7", user_id: "u1", find_name: g.match.name, plan: { ...plan, gap: { source: "calendar", day, from: "16:00", to: "17:30", quote: null } } };
  const fine = await run([row], "holds", "holds");
  check("still on and still free: nothing sent, still watching", fine.n === 0 && fine.queued.length === 0 && !fine.qs.some((x) => /watch_outcome = \$2/.test(x.q)));
  const gone = await run([row], "changed", "holds");
  check("the find died: one message saying so, and the watch ends", gone.n === 1 && gone.queued[0]?.type === "bounce_watch" && gone.queued[0].payload.what === "find_gone" && gone.queued[0].targetKey === "bounce_watch:7");
  const busy = await run([row], "holds", "changed");
  check("their calendar went busy then: one message saying so", busy.queued[0]?.payload.what === "calendar_busy");
  const removed = await run([{ ...row, plan }], "holds", "changed");
  check("without a calendar, the time they told Cue was removed: one message saying so", removed.queued[0]?.payload.what === "time_removed");
  const blind = await run([row], "unknown", "unknown");
  check("a read that failed: silence, and it looks again (no false alarm)", blind.n === 0 && blind.queued.length === 0);
  const off = await run([row], "holds", "unwatchable");
  check("they disconnected their calendar: the watch ends quietly", off.queued.length === 0 && off.qs.some((x) => /watch_outcome = 'calendar_disconnected'/.test(x.q)));
  check("once the plan starts, the watch ends quietly", fine.qs.some((x) => /watch_outcome = 'started' WHERE status = 'accepted' AND watch_ended_at IS NULL AND watch_until IS NOT NULL AND watch_until <= \$1/.test(x.q)));
  check("the watch runs with the trigger, every 15 minutes", /B\.runBounceWatches\(\)/.test(src("jobs/index.ts")));
  const wb = B.watchBrief({ what: "calendar_busy", plan: row.plan });
  check("the change message says what changed, plainly, and holds nothing", /their calendar now shows them busy then/.test(wb.facts.what_changed) && /nothing booked or held/.test(wb.task) && /You told them you'd keep an eye on this plan/.test(wb.task));
  const reg = src("harness/proactiveRegistry.ts");
  check("the change message never goes after the plan has started", /bounce_watch: \{[\s\S]{0,400}if \(until && until\.getTime\(\) <= Date\.now\(\)\) return skip\("the plan has started"\)/.test(reg));
  check("the watch's find check writes nothing (a dry re-read)", /checkBeforeSend\([\s\S]{0,200}\{ dryRun: true \}\)/.test(src("services/bounce.ts")));
}

// ---------------------------------------------------------------- 3. the calendar offer: once, the first time a plan would be sharper
{
  const g = findAt("Small gallery opening", "16:00", CHI, true);
  const offered = new Set<string>();
  (pool as any).query = async (q: string, a: any[] = []) => {
    // Only the exact once-ever insert keeps a second one out; any other form of it "inserts" again (review: the stub used to do the
    // ON CONFLICT itself, so changing it in the product passed).
    if (/INSERT INTO calendar_offers \(user_id, want_key\) VALUES \(\$1, \$2\) ON CONFLICT \(user_id\) DO NOTHING RETURNING user_id/.test(q)) return offered.has(a[0]) ? { rows: [] } : (offered.add(a[0]), { rows: [{ user_id: a[0] }] });
    if (/INSERT INTO calendar_offers/.test(q)) return { rows: [{ user_id: a[0] }] };
    return { rows: [], rowCount: 1 };
  };
  try {
    const queued: any[] = [];
    const enqueue = async (x: any) => (queued.push(x), {});
    const first = await B.queueCalendarOffer("u1", want, [g], CHI, { enqueue, connected: async () => null });
    check("the first time a plan would be sharper with their calendar: one offer queued", first && queued.length === 1 && queued[0].type === "bounce_calendar_offer");
    const again = await B.queueCalendarOffer("u1", { ...want, key: "ask:a2" }, [g], CHI, { enqueue, connected: async () => null });
    check("never a second time, for any want (a no, or no answer, is respected)", !again && queued.length === 1);
    const conn = await B.queueCalendarOffer("u2", want, [g], CHI, { enqueue, connected: async () => ({ since: "2026-10-15" }) });
    check("already connected: no offer", !conn && queued.length === 1 && !offered.has("u2"));
  } finally {
    (pool as any).query = realQuery;
  }
  const b = B.calendarOfferBrief({ want, findNames: [g.match.name] });
  check("the offer: free/busy only said plainly, one yes/no question, no link, no time proposed", /only when they're busy or free/.test(b.facts.what_connecting_does) && /one short yes\/no question/.test(b.task) && /Don't send or mention a link yet/.test(b.task) && /don't propose a time/.test(b.task));
  const bs = src("services/bounce.ts");
  check("it fires only when a plan needs the calendar and no calendar was read", /if \(!busy && planNeedsCalendar\(want, finds, \{ today, zone: wz, judged, stated, proposed, offered, dropped \}\)\) await queueCalendarOffer/.test(bs));
  const reg = src("harness/proactiveRegistry.ts");
  check("at send time: skipped if they've connected since, or no plan needs it any more", /bounce_calendar_offer: \{[\s\S]{0,500}they've connected their calendar since[\s\S]{0,300}calendarMomentReached\(c\.userId\)/.test(reg));
  check("their yes goes through the calendar tool, whose own check still has to pass (the link only then)", /calendarMomentReached\(u\)\)\)\(ctx\.userId\)/.test(src("services/googleTools.ts")));
  check("the offer table is once per member, ever", /CREATE TABLE IF NOT EXISTS calendar_offers \(user_id UUID PRIMARY KEY/.test(src("db/migrations.ts")));
}

console.log(`bounce watch: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
