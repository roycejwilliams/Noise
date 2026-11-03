// The bounce, part 3 (Royce, 2026-10-15): the trigger. A high-fit find with a known time, inside a want's window, in a real gap (their
// calendar free, or a time they stated), proposed once as one plan; read again before it pings (dead finds and lost gaps are silence);
// their yes or no recorded, nothing booked. Zero tokens: the database is a stub.
//   npx tsx evals/bounce/trigger.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";
import { DateTime } from "luxon";

const B = await import("../../src/services/bounce.js");
const { shadowKey } = await import("../../src/services/sweepShadow.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

const zone = "America/Chicago";
const today = DateTime.now().setZone(zone).toISODate()!;
const day = DateTime.now().setZone(zone).plus({ days: 3 }).toISODate()!;
const weekday = DateTime.fromISO(day).toFormat("cccc").toLowerCase();
const at = (d: string, hhmm: string, mins = 90) => {
  const s = DateTime.fromISO(`${d}T${hhmm}`, { zone });
  return { startAt: s.toUTC().toISO(), endAt: s.plus({ minutes: mins }).toUTC().toISO() };
};
const find = (name: string, d: string, hhmm: string | null, extra: any = {}) => ({ askId: "a1", askText: "something good", match: { tier: 2, kind: "public_event", name, event_date: d, url: `https://lu.ma/${name.replace(/\W/g, "")}`, reason: "x", details: hhmm ? { ...at(d, hhmm), venue: "Two blocks from the Palmer House" } : {}, whyItFits: "small, quiet, art they said they love", ...extra } });
const judged = (f: any, verdict = "send", o: any = {}) => ({ key: shadowKey(f.match.name, f.match.event_date), verdict, ...o });
const want = { key: "ask:a1", text: "something good to do in Chicago", place: "Chicago", until: DateTime.fromISO(day).plus({ days: 1 }).toISODate()!, quote: "I'm in Chicago til Friday" };
const base = (o: Partial<Parameters<typeof B.pickProposal>[2]> = {}) => ({ today, zone, judged: [] as any[], stated: [] as any[], calendarFree: () => null as boolean | null, proposed: new Set<string>(), ...o });
const gallery = find("Small gallery opening", day, "16:00");
const stated = [{ weekday: null, date: null, from: "15:30", to: "18:00", quote: "" }].map((s) => ({ ...s, weekday }));

// ---------------------------------------------------------------- when it proposes, and when it stays silent
check("a find's time in their zone", B.findTimes(gallery.match, zone)?.from === "16:00" && B.findTimes(gallery.match, zone)?.to === "17:30" && B.findTimes(gallery.match, zone)?.day === day);
{
  const p = B.pickProposal(want, [gallery], base({ judged: [judged(gallery)], calendarFree: () => true }));
  check("calendar free + high fit + inside the window: one plan, held on the calendar", p?.gap.source === "calendar" && p.find.match.name === "Small gallery opening");
}
{
  const p = B.pickProposal(want, [gallery], base({ judged: [judged(gallery)], stated: [{ ...stated[0], quote: `${weekday} 3:30 to 6 is my dead spot` }] }));
  check("no calendar, but a time they stated covers it: one plan, proposed (never held)", p?.gap.source === "stated" && /dead spot/.test(p.gap.quote ?? ""));
}
check("their calendar busy then: silence, even when a stated time covers it", B.pickProposal(want, [gallery], base({ judged: [judged(gallery)], calendarFree: () => false, stated })) === null);
check("no calendar and nothing they stated: silence (an inferred gap is never a gap)", B.pickProposal(want, [gallery], base({ judged: [judged(gallery)] })) === null);
check("a stated time that doesn't cover the whole thing: silence", B.pickProposal(want, [gallery], base({ judged: [judged(gallery)], stated: [{ ...stated[0], to: "17:00" }] })) === null);
check("not high fit (held, never judged, or clashing with the room they want): silence", B.pickProposal(want, [gallery], base({ judged: [judged(gallery, "hold")], calendarFree: () => true })) === null && B.pickProposal(want, [gallery], base({ calendarFree: () => true })) === null && B.pickProposal(want, [gallery], base({ judged: [judged(gallery, "send", { taste: "clashes" })], calendarFree: () => true })) === null);
check("its tier's morning pick counts as high fit", B.pickProposal(want, [gallery], base({ judged: [judged(gallery, "hold", { tierPick: 2 })], calendarFree: () => true }))?.gap.source === "calendar");
{
  const late = find("After the window", DateTime.fromISO(want.until).plus({ days: 2 }).toISODate()!, "16:00");
  check("a find after the window: silence", B.pickProposal(want, [late], base({ judged: [judged(late)], calendarFree: () => true })) === null);
  const noTime = find("No time on it", day, null);
  check("a find with no start time can't be put in a gap: silence", B.pickProposal(want, [noTime], base({ judged: [judged(noTime)], calendarFree: () => true })) === null);
}
check("proposed once per want: a want already proposed is silent", B.pickProposal(want, [gallery], base({ judged: [judged(gallery)], calendarFree: () => true, proposed: new Set(["ask:a1"]) })) === null);
check("a window that already ended: silence", B.pickProposal({ ...want, until: DateTime.fromISO(today).minus({ days: 1 }).toISODate()! }, [gallery], base({ judged: [judged(gallery)], calendarFree: () => true })) === null);
{
  const later = find("A later walk", day, "17:00");
  const p = B.pickProposal(want, [later, gallery], base({ judged: [judged(gallery), judged(later)], calendarFree: () => true }));
  check("one solved plan, never a list: the first that fits, alone", p?.find.match.name === "Small gallery opening");
}

// ---------------------------------------------------------------- the plan's words
{
  const cal = B.proposalBrief({ want, match: gallery.match, gap: { source: "calendar", day, from: "16:00", to: "17:30", quote: null }, times: { day, from: "16:00", to: "17:30" }, zone });
  const st = B.proposalBrief({ want, match: gallery.match, gap: { source: "stated", day, from: "15:30", to: "18:00", quote: "Tuesday 3:30 to 6 is my dead spot" }, times: { day, from: "16:00", to: "17:30" }, zone });
  check("a calendar gap closes on 'want me to keep an eye on it?' (Royce, 2026-10-15), never a hold", /want me to keep an eye on it\?/.test(cal.task) && /free on their calendar/.test(cal.facts.their_free_time) && !/hold it\?/.test(cal.task));
  check("a stated time the same, watched against what they told Cue, never held or booked", /want me to keep an eye on it\?/.test(st.task) && /Never say you'll hold, book, reserve or save anything/.test(st.task) && /a time they told you they're free/.test(st.facts.their_free_time));
  check("the proactive message test: a traceable reason (their words), the work done (the plan), a short close", cal.facts.their_own_words_about_it === "I'm in Chicago til Friday" && /one solved thing, not options/.test(cal.task) && /Two sentences at most/.test(cal.task));
  check("reflect what's told, never how they seem", /Reflect only what they told you, never how they seem/.test(cal.task));
  check("the free time is said plainly (the day, the span in minutes)", /90 minutes/.test(cal.facts.their_free_time) && cal.facts.the_day.includes(day));
}

// ---------------------------------------------------------------- read again before it pings
{
  const reg = src("harness/proactiveRegistry.ts");
  const draft = reg.slice(reg.indexOf("bounce_proposal: {"), reg.indexOf("network_tease: {"));
  const i1 = draft.indexOf("checkBeforeSend("), i2 = draft.indexOf("gapStillHolds("), i3 = draft.indexOf("draftProactive(");
  check("before it pings: the find is re-read, then the gap, then the plan is written", i1 > 0 && i2 > i1 && i3 > i2);
  check("a dead find never pings (its exit kept), a lost gap is silence", /if \("skip" in found\) return \{ \.\.\.skip\(`the find: \$\{found\.skip\}`\), \.\.\.\(found\.exited/.test(draft) && /return skip\("the gap no longer holds"\)/.test(draft));
}
{
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  let freeRows: any[] = [];
  (pool as any).query = async (q: string) => (/FROM member_free_times/.test(q) ? { rows: freeRows } : { rows: [] });
  try {
    freeRows = [{ id: "1", weekday, on_date: null, start_time: "15:30:00", end_time: "18:00:00", quote: "dead spot" }];
    const holds = await B.gapStillHolds("u", { source: "stated", day, from: "15:30", to: "18:00", quote: null }, { day, from: "16:00", to: "17:30" }, zone);
    freeRows = [];
    const gone = await B.gapStillHolds("u", { source: "stated", day, from: "15:30", to: "18:00", quote: null }, { day, from: "16:00", to: "17:30" }, zone);
    const noCal = await B.gapStillHolds("u", { source: "calendar", day, from: "16:00", to: "17:30", quote: null }, { day, from: "16:00", to: "17:30" }, zone);
    check("a stated time still theirs holds; one they removed doesn't", holds && !gone);
    check("a calendar gap that can't be read again (disconnected, or the read failed) doesn't hold", !noCal);
  } finally {
    (pool as any).query = real;
  }
}

// ---------------------------------------------------------------- once, and the answer recorded (nothing booked)
{
  const b = src("services/bounce.ts");
  check("a proposal that never went (find or gap died first) doesn't use up the want", /status <> 'dropped'/.test(b) && /WHERE bounce_proposals\.status = 'dropped'/.test(b));
  check("the answer binds to the latest proposal sent, only within a few days", /status = 'proposed' AND sent_at > NOW\(\) - make_interval\(days => \$4\)/.test(b) && B.BOUNCE.answerDays === 3);
  const answer = b.slice(b.indexOf("export async function answerLatest"), b.indexOf("\n// Pure: when the watch ends"));
  check("a yes is recorded and starts a watch, nothing booked or held anywhere", answer.length > 200 && !/sendblue|calendar|enqueueCandidate|INSERT INTO/i.test(answer));
  const tools = src("agent/conversationTools.ts");
  const t = tools.slice(tools.indexOf("answerProposal: tool"), tools.indexOf("noteFreeTime: tool"));
  check("their answer must be in their own words, and Cue never says it's booked", /theirQuote\(ctx\.resolvedContent, recentOf\(ctx\), theirWords\)/.test(t) && /don't claim anything is booked or held/.test(t));
  check("a no gets no apology and no other options", /no apology, no other options/.test(t));
  check("it goes through the proactive harness (their hours and caps), and runs every 15 minutes", /type: "bounce_proposal"/.test(b) && /bounce_proposal: \{ priority: 85 \}/.test(src("harness/proactive.ts")) && /B\.runBounceTriggers\(\)/.test(src("jobs/index.ts")));
}

// ---------------------------------------------------------------- the calendar ask: only when a plan needs it (Royce, 2026-10-15)
{
  const o = { today, zone, judged: [judged(gallery)], stated: [] as any[], proposed: new Set<string>() };
  check("a plan that only their calendar could place needs it", B.planNeedsCalendar(want, [gallery], o));
  check("a time they stated already covers it: the calendar isn't needed", !B.planNeedsCalendar(want, [gallery], { ...o, stated: [{ ...stated[0], quote: "dead spot" }] }));
  check("nothing high-fit to plan: the calendar isn't needed", !B.planNeedsCalendar(want, [gallery], { ...o, judged: [judged(gallery, "hold")] }) && !B.planNeedsCalendar(want, [], o));
  check("a want already proposed, or a window that ended: not needed", !B.planNeedsCalendar(want, [gallery], { ...o, proposed: new Set(["ask:a1"]) }) && !B.planNeedsCalendar({ ...want, until: DateTime.fromISO(today).minus({ days: 1 }).toISODate()! }, [gallery], o));
  const noTime = find("No time on it", day, null);
  check("a find with no start time can't use a calendar: not needed", !B.planNeedsCalendar(want, [noTime], { ...o, judged: [judged(noTime)] }));

  const { googleTools } = await import("../../src/services/googleTools.js");
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  const links: string[] = [];
  const sent: string[] = [];
  const notDone: string[] = [];
  (pool as any).query = async (q: string) => (/INSERT INTO google_oauth_states/.test(q) && links.push(q), /FROM users WHERE id = \$1 AND invite_verified = true AND archived_at IS NULL/.test(q) ? { rows: [{ x: 1 }] } : { rows: [], rowCount: 1 });
  const envWas = { id: process.env.GOOGLE_CUE_CLIENT_ID, sec: process.env.GOOGLE_CUE_CLIENT_SECRET, key: process.env.GOOGLE_TOKEN_KEY, url: process.env.API_URL };
  Object.assign(process.env, { GOOGLE_CUE_CLIENT_ID: "c", GOOGLE_CUE_CLIENT_SECRET: "s", GOOGLE_TOKEN_KEY: Buffer.alloc(32, 3).toString("base64"), API_URL: "https://api.example.test" });
  try {
    const ctx = { userId: "u1", phoneNumber: "+15550100001", dryRun: false, sendCoReply: async (m: any) => { sent.push(m.message); return true; } };
    const early = await (googleTools(ctx, (t) => notDone.push(t), { calendarMoment: async () => false }).calendarConnection as any).execute({ action: "connect" }, {});
    check("asked before a plan needs it (even when they ask): no link made or sent, and Cue is told not to offer it", early.ok === false && links.length === 0 && sent.length === 0 && /Don't send a link or offer it now/.test(early.error) && /no plan needs their calendar/.test(notDone.at(-1) ?? ""));
    const now = await (googleTools(ctx, (t) => notDone.push(t), { calendarMoment: async () => true }).calendarConnection as any).execute({ action: "connect" }, {});
    check("once a plan needs it: the one-time link goes, as its own text", now.ok === true && links.length === 1 && sent.length === 1 && /\/google\/connect\//.test(sent[0]));
    const st = await (googleTools(ctx, () => {}, { calendarMoment: async () => false }).calendarConnection as any).execute({ action: "status" }, {});
    check("status and disconnect are never held back by the moment", st.ok === true);
  } finally {
    (pool as any).query = real;
    for (const [k, v] of [["GOOGLE_CUE_CLIENT_ID", envWas.id], ["GOOGLE_CUE_CLIENT_SECRET", envWas.sec], ["GOOGLE_TOKEN_KEY", envWas.key], ["API_URL", envWas.url]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  check("the real check reads the same pieces the trigger does, and any failure is 'not yet'", /export async function calendarMomentReached/.test(src("services/bounce.ts")) && /\.calendarMomentReached\(u\)\)\)\(ctx\.userId\)\.catch\(\(\) => false\)/.test(src("services/googleTools.ts")));
}

// ---------------------------------------------------------------- review of #222 and the grants work
{
  const o = { today, zone, judged: [] as any[], stated: [] as any[], calendarFree: () => true, proposed: new Set<string>() };
  const gallery = find("Gallery night", day, "18:00");
  const want = { key: "ask:a1", text: "something good to do", place: "Chicago", until: DateTime.fromISO(day).plus({ days: 2 }).toISODate()!, quote: null };
  const j = [judged(gallery)];
  const second = find("Jazz at the Green Mill", day, "20:00");
  const dropped = new Map([["ask:a1", new Set([`Gallery night|${day}`])]]);
  check("a find a dropped attempt was for is never picked again for that want (no 15-minute requeue loop); another find can be",
    B.pickProposal(want, [gallery], { ...o, judged: j, dropped }) === null && B.pickProposal(want, [gallery, second], { ...o, judged: [...j, judged(second)], dropped })?.find.match.name === "Jazz at the Green Mill");
  const bs = src("services/bounce.ts"), reg = src("harness/proactiveRegistry.ts");
  check("both drop paths remember the find on the want, and a re-queue keeps that list",
    /status = 'dropped', answer_words = \$2, plan = jsonb_set\(COALESCE\(plan, '\{\}'::jsonb\), '\{dropped\}'/.test(reg) && /status = 'dropped', plan = jsonb_set\(/.test(bs) && /plan = EXCLUDED\.plan \|\| jsonb_build_object\('dropped', COALESCE\(bounce_proposals\.plan->'dropped', '\[\]'::jsonb\)\)/.test(bs));
  check("a find already sent or queued as a find is never proposed again as a plan (no double ping)", !!B.pickProposal(want, [gallery], { ...o, judged: j }) && B.pickProposal(want, [gallery], { ...o, judged: j, offered: new Set([shadowKey("Gallery night", day)]) }) === null);
  const b = src("services/bounce.ts");
  check("each proposal attempt has its own key, and a refused enqueue puts the row back to 'dropped' (a dropped proposal never kills its want)",
    /targetKey: `bounce:\$\{p\.want\.key\}:\$\{rows\[0\]\.attempt\}`/.test(b) && /if \(!r\?\.queued\) \{\s*await pool\.query\(`UPDATE bounce_proposals SET status = 'dropped', plan = jsonb_set\(/.test(b) && /if \(!\(await queueProposal\(userId, pick, pick\.zone\)\)\) continue;/.test(b));

  // Behavior, through the real enqueue: a first attempt dropped before it went, then queued again, gets its own key the harness takes.
  const { default: pool } = await import("../../src/db/db.js");
  const realQuery = (pool as any).query, realConnect = (pool as any).connect;
  let attempt = 1000;
  let status = "dropped";
  const candidates = new Map<string, string>();
  const stub = async (q: string, p: any[] = []) => {
    if (/INSERT INTO bounce_proposals/.test(q)) return status === "dropped" ? ((status = "queued"), { rows: [{ id: "7", attempt: ++attempt }] }) : { rows: [] };
    if (/UPDATE bounce_proposals SET status = 'dropped'/.test(q)) return (status = "dropped"), { rows: [] };
    if (/FROM proactive_candidates WHERE user_id = \$1 AND target_key = \$2 FOR UPDATE/.test(q)) {
      const st = candidates.get(p[1]);
      return { rows: st ? [{ id: 1, status: st, payload: {}, expires_at: null }] : [] };
    }
    if (/INSERT INTO proactive_candidates/.test(q)) return candidates.set(p[2], "pending"), { rows: [{ id: 2 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  (pool as any).query = stub;
  (pool as any).connect = async () => ({ query: stub, release: () => {} });
  try {
    const pick = { want, find: gallery as any, gap: { source: "stated", day, from: "17:00", to: "21:00", quote: "free Thursday 5 to 9" }, times: { day, from: "18:00", to: "20:00", start: new Date(), end: new Date() }, zone } as any;
    const first = await B.queueProposal("u1", pick, zone);
    const firstKey = [...candidates.keys()][0];
    candidates.set(firstKey, "skipped"); // it was dropped before it went (its find died): the harness marks the candidate done
    status = "dropped";
    const again = await B.queueProposal("u1", pick, zone);
    check("a want whose proposal was dropped before it went can be proposed again, under a new key (the want isn't used up)", first && again && candidates.size === 2 && [...candidates.values()].filter((v) => v === "pending").length === 1 && status === "queued", { first, again, candidates: [...candidates.entries()], status });
    // And when the harness refuses it anyway, the row goes back to 'dropped' instead of sitting 'queued' forever.
    status = "dropped";
    candidates.clear();
    attempt = 2000;
    candidates.set("bounce:ask:a1:2001", "sent");
    const refused = await B.queueProposal("u1", pick, zone);
    check("... and a refused enqueue leaves the row 'dropped', never stuck 'queued'", refused === false && status === "dropped", { refused, status });
  } finally {
    (pool as any).query = realQuery;
    (pool as any).connect = realConnect;
  }
}
{
  const s = new Date("2026-10-17T23:00:00Z"), e = new Date("2026-10-18T01:00:00Z");
  check("watch: their own plan put in their calendar (the plan's own span) still reads as clear", B.planStillClear(s, e, [{ start: "2026-10-17T23:00:00Z", end: "2026-10-18T01:00:00Z" }]) && B.planStillClear(s, e, [{ start: "2026-10-17T22:45:00Z", end: "2026-10-18T01:15:00Z" }]));
  check("watch: something else over the plan is a clash", !B.planStillClear(s, e, [{ start: "2026-10-17T23:50:00Z", end: "2026-10-18T00:20:00Z" }]) && !B.planStillClear(s, e, [{ start: "2026-10-17T20:00:00Z", end: "2026-10-18T03:00:00Z" }]) && B.planStillClear(s, e, []));
  check("watch: the calendar re-read uses that rule", /planStillClear\(s, e, busy\) \? "holds" : "changed"/.test(src("services/bounce.ts")));
}

console.log(`bounce trigger: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
