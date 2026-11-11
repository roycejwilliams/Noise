// The trigger (Royce, 2026-10-15, the bounce): "When a high-fit perishable find lands on a want that has a window and a real gap (stated
// or calendar), Cue proposes once: one solved plan, not a list of options. Before any proposal pings, re-check the find is still alive
// and the gap still holds. Dead finds never ping. Silence is always better than a stale nudge." And the scope: "record the yes,
// execution is the next pass."
//
// What has to be true, all of it, or nothing is proposed:
//   - a want with a window that hasn't ended (services/wantWhen.ts: set in conversation, their words);
//   - a find for that want, dated inside the window, with a known start time (a find with no time can't be put in a gap);
//   - high fit: the morning picker's latest judgment of it is a send (or its tier's pick), and never a clash with the room they want;
//   - a real gap that the find fits whole: their calendar shows them free then (the only gap that may hold), or a time they stated
//     themselves covers it (proposed against, never held). Nothing inferred is ever a gap;
//   - nothing proposed for this want yet (once per want: proposed, accepted or declined, it doesn't come back; one that never went
//     because its find or gap died first doesn't count).
// Then one proposal is queued through the proactive harness (their hours and caps apply, like everything Cue starts). At send time it
// is checked again: the find re-read (sendCheck.ts checkBeforeSend: gone, sold out or past never pings) and the gap read again (busy
// now, or the stated time removed: silence). Their yes or no is recorded (answerProposal); nothing is booked or held anywhere.
//
// The promise (Royce, 2026-10-15): "Want me to keep an eye on it?", honest at every floor. A yes starts a watch (runBounceWatches) until
// the plan starts: the find re-read (still on), and the gap read again (their calendar still free, with the calendar grant; without
// it, the time they told Cue still theirs). If either changes, Cue tells them once; if it can't tell (a failed read), it says nothing
// and looks again. Nothing is held, booked or reserved, and Cue never says it is.
// Times are read in the zone the plan is in (Royce: "stated times are read in the zone the plan is in, not the member's home zone"):
// the find's own zone, else the want's place, else home.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { shadowKey } from "./sweepShadow.js";

export const BOUNCE = { defaultMinutes: 120, proposeWithinDays: 14, answerDays: 3 } as const;

export type Gap = { source: "calendar" | "stated"; day: string; from: string; to: string; quote: string | null };
export type BounceWant = { key: string; text: string; place: string | null; until: string; quote: string | null };
export type BounceFind = { askId: string; askText: string; match: any };
export type Judged = { key: string; verdict: string; tierPick?: number | null; taste?: string | null };
export type StatedTime = { weekday: string | null; date: string | null; from: string; to: string; quote: string };

// The picker's own key for a find (sweepShadow.ts shadowKey with its dateOf), so its judgment is found exactly.
const findKey = (m: any) => shadowKey(String(m?.name ?? ""), m?.event_date ? String(m.event_date).slice(0, 10) : m?.deadline ? String(m.deadline).slice(0, 10) : null);

// Pure: when a find starts and ends, in their time zone (a find with no start time has none).
export function findTimes(m: any, zone: string): { day: string; from: string; to: string; start: Date; end: Date } | null {
  const s = m?.details?.startAt;
  if (!s) return null;
  const start = DateTime.fromISO(String(s), { zone: "utc" }).setZone(zone);
  if (!start.isValid) return null;
  const e = m?.details?.endAt ? DateTime.fromISO(String(m.details.endAt), { zone: "utc" }).setZone(zone) : start.plus({ minutes: BOUNCE.defaultMinutes });
  const end = e.isValid && e > start ? e : start.plus({ minutes: BOUNCE.defaultMinutes });
  return { day: start.toISODate()!, from: start.toFormat("HH:mm"), to: end.toFormat("HH:mm"), start: start.toJSDate(), end: end.toJSDate() };
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
// Pure: the stated time that covers [from, to] on that day, if any.
export function statedCovering(times: StatedTime[], day: string, from: string, to: string): StatedTime | null {
  const wd = WEEKDAYS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7];
  return times.find((t) => (t.date ? t.date === day : t.weekday === wd) && t.from <= from && t.to >= to) ?? null;
}

export type ProposalPick = { want: BounceWant; find: BounceFind; gap: Gap; times: { day: string; from: string; to: string }; zone: string };

// Pure: the zone a find's times are read in: its own (Luma's event zone), else the zone given (the want's place, else home).
export function planZone(m: any, fallback: string): string {
  const z = m?.details?.timezone;
  return typeof z === "string" && DateTime.now().setZone(z).isValid ? z : fallback;
}

// Pure: the one proposal for one want, or null (silence). busyFree: whether their calendar shows them free over the find's span (null
// when there's no calendar, or it couldn't be read: then only a stated time can be a gap).
export function pickProposal(
  want: BounceWant,
  finds: BounceFind[],
  o: { today: string; zone: string; judged: Judged[]; stated: StatedTime[]; calendarFree: (start: Date, end: Date) => boolean | null; proposed: Set<string>; offered?: Set<string>; dropped?: Map<string, Set<string>> },
): ProposalPick | null {
  if (o.proposed.has(want.key) || want.until < o.today) return null;
  const judged = new Map(o.judged.map((j) => [j.key, j]));
  const fits = finds
    .map((f) => ({ f, z: planZone(f.match, o.zone), j: judged.get(findKey(f.match)) }))
    .map((x) => ({ ...x, t: findTimes(x.f.match, x.z) }))
    .filter((x) => x.t && x.t.day >= o.today && x.t.day <= want.until && x.t.start.getTime() > Date.now())
    // A find an earlier attempt for this want was dropped on (it died, or was held, before it went): never picked again for it, so a
    // dropped proposal can't come back every 15 minutes (review of the grants work).
    .filter((x) => !o.dropped?.get(want.key)?.has(`${String(x.f.match?.name ?? "").slice(0, 200)}|${x.t!.day}`))
    .filter((x) => x.j && (x.j.verdict === "send" || !!x.j.tierPick) && x.j.taste !== "clashes")
    // Already on its way to them, or sent, as a find (a morning find, a dispatch): never proposed again as a plan (review of #222).
    .filter((x) => !o.offered?.has(findKey(x.f.match)))
    .sort((a, b) => a.t!.start.getTime() - b.t!.start.getTime());
  for (const x of fits) {
    const t = x.t!;
    const cal = o.calendarFree(t.start, t.end);
    if (cal === true) return { want, find: x.f, gap: { source: "calendar", day: t.day, from: t.from, to: t.to, quote: null }, times: t, zone: x.z };
    if (cal === false) continue; // their calendar says they're busy then: never proposed over it
    // A time they stated is read in the plan's zone: "3:30 to 6" on a Chicago trip is 3:30 to 6 in Chicago.
    const s = statedCovering(o.stated, t.day, t.from, t.to);
    if (s) return { want, find: x.f, gap: { source: "stated", day: t.day, from: s.from, to: s.to, quote: s.quote }, times: t, zone: x.z };
  }
  return null;
}

// The calendar grant's moment (Royce, 2026-10-15): "the ask only fires when a plan actually needs it, enforced in code". Pure: a plan
// needs their calendar when a want with an open window has a high-fit find that would be proposed if their calendar showed them free,
// and isn't proposed without it (no calendar, and nothing they stated covers it). Anything else (no want with a window, nothing that
// fits, a stated time already covering it, already proposed) and the calendar isn't needed.
export function planNeedsCalendar(want: BounceWant, finds: BounceFind[], o: { today: string; zone: string; judged: Judged[]; stated: StatedTime[]; proposed: Set<string>; offered?: Set<string>; dropped?: Map<string, Set<string>> }): boolean {
  return pickProposal(want, finds, { ...o, calendarFree: () => null }) === null && pickProposal(want, finds, { ...o, calendarFree: () => true }) !== null;
}

// Whether any of their wants has a plan that needs their calendar now (read fresh; any failure is "no", so the ask never fires early).
export async function calendarMomentReached(userId: string, now = new Date()): Promise<boolean> {
  const { memberZone, localDay } = await import("./memberTime.js");
  const zone = (await memberZone(userId).catch(() => null)) ?? "America/Los_Angeles";
  const today = localDay(now, zone);
  const wants = await wantsWithWindows(userId, today);
  if (!wants.length) return false;
  const [judged, proposed, stated, offered, dropped] = await Promise.all([latestJudgments(userId), proposedWants(userId), import("./wantWhen.js").then((W) => W.freeTimesOf(userId, today)), offeredFinds(userId), droppedFinds(userId)]);
  for (const want of wants) if (planNeedsCalendar(want, await findsForWant(userId, want.key), { today, zone: await wantZone(want, zone), judged, stated, proposed, offered, dropped })) return true;
  return false;
}

// ---------------------------------------------------------------- the calendar offer (Royce, 2026-10-15)
// "Copy the Docs pattern: the first time a plan would be sharper with the calendar connected, Cue offers once, and respects a no."
// Once per member, ever: a row in calendar_offers, written when it's queued. A no (or no answer) is never asked again; a yes goes
// through calendarConnection, whose own check (calendarMomentReached) still has to pass. No link rides on the offer.
type Enqueue = (input: import("../harness/proactive.js").EnqueueInput) => Promise<unknown>;
const realEnqueue: Enqueue = async (input) => (await import("../harness/proactive.js")).enqueueCandidate(input);

export async function queueCalendarOffer(userId: string, want: BounceWant, finds: BounceFind[], zone: string, deps: { enqueue?: Enqueue; connected?: (userId: string) => Promise<unknown> } = {}): Promise<boolean> {
  const connected = deps.connected ?? (async (u: string) => (await import("./cueGrants.js")).calendarConnected(u));
  if (await connected(userId).catch(() => null)) return false;
  const { rows } = await pool.query(`INSERT INTO calendar_offers (user_id, want_key) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [userId, want.key]);
  if (!rows[0]) return false; // offered before: once, ever
  await (deps.enqueue ?? realEnqueue)({
    userId,
    type: "bounce_calendar_offer",
    targetKey: "calendar_offer",
    summary: `One offer to connect their calendar, for "${want.text.slice(0, 80)}"`,
    payload: { want, zone, findNames: finds.map((f) => String(f.match?.name ?? "")).filter(Boolean).slice(0, 2) },
    expiresAt: DateTime.fromISO(want.until, { zone }).endOf("day").toJSDate(),
  });
  return true;
}

// Pure: the offer's facts and task. Free/busy only, said plainly; one yes/no question; never a link, never pressure.
export function calendarOfferBrief(p: { want: BounceWant; findNames: string[] }): { facts: Record<string, string>; task: string } {
  return {
    facts: {
      what_they_told_you_they_want: p.want.text,
      ...(p.want.place ? { where_they_are: p.want.place } : {}),
      ...(p.findNames.length ? { something_that_fits_it: p.findNames[0] } : {}),
      what_connecting_does: "Cue would see only when they're busy or free (never what, where or with whom), never share it with anyone, never change their calendar, and could fit things like this into their real free time. They can disconnect any time.",
    },
    task: "Offer once, in two sentences at most: you could fit things for what they want into their real free time if they connect their calendar, and say plainly that you'd see only busy or free. End with one short yes/no question. Don't send or mention a link yet, don't push, and don't propose a time.",
  };
}

// ---------------------------------------------------------------- data and the run

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function wantsWithWindows(userId: string, today: string, db: Db = pool): Promise<BounceWant[]> {
  const { rows } = await db.query(`SELECT want_key, want_text, place, window_end, window_quote FROM want_places WHERE user_id = $1 AND window_end >= $2::date AND want_key NOT LIKE 'where:%'`, [userId, today]);
  const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  return rows.map((r: any) => ({ key: String(r.want_key), text: String(r.want_text ?? ""), place: r.place ?? null, until: day(r.window_end), quote: r.window_quote ?? null }));
}

// The finds waiting for this want: in its ask's backlog, or searched for it (a goal's finds carry searchedIn.key).
export async function findsForWant(userId: string, wantKey: string, db: Db = pool): Promise<BounceFind[]> {
  const askRow = wantKey.startsWith("ask:") ? wantKey.slice(4) : null;
  const { rows } = await db.query(`SELECT ask_id, items FROM event_backlogs WHERE user_id = $1`, [userId]);
  return rows.flatMap((r: any) =>
    (Array.isArray(r.items) ? r.items : [])
      .filter((it: any) => it?.match && (String(r.ask_id) === askRow || it.match?.searchedIn?.key === wantKey))
      .map((it: any) => ({ askId: String(r.ask_id), askText: String(it.askText ?? ""), match: it.match })),
  );
}

// The picker's latest read of their finds (sweep.select.shadow, the last few days).
export async function latestJudgments(userId: string, db: Db = pool): Promise<Judged[]> {
  const { rows } = await db.query(`SELECT proposal->'judgments' AS j FROM harness_decisions WHERE user_id = $1 AND decision = 'sweep.select.shadow' AND created_at > NOW() - INTERVAL '3 days' ORDER BY created_at DESC LIMIT 3`, [userId]);
  const seen = new Set<string>();
  const out: Judged[] = [];
  for (const r of rows) for (const j of Array.isArray(r.j) ? r.j : []) if (j?.key && !seen.has(j.key)) (seen.add(j.key), out.push({ key: String(j.key), verdict: String(j.verdict ?? ""), tierPick: j.tierPick ?? null, taste: j.taste ?? null }));
  return out;
}

// The finds already queued or sent to them as finds (proactive event_offer, the last two weeks), by the picker's key.
export async function offeredFinds(userId: string, db: Db = pool): Promise<Set<string>> {
  const { rows } = await db.query(
    `SELECT payload->'match' AS m FROM proactive_candidates WHERE user_id = $1 AND type = 'event_offer' AND status IN ('pending', 'sent') AND created_at > NOW() - INTERVAL '14 days'`,
    [userId],
  );
  return new Set(rows.map((r: any) => findKey(r.m)));
}

// Per want, the finds earlier attempts were dropped on ("name|day", plan.dropped).
export async function droppedFinds(userId: string, db: Db = pool): Promise<Map<string, Set<string>>> {
  const { rows } = await db.query(`SELECT want_key, plan->'dropped' AS d FROM bounce_proposals WHERE user_id = $1`, [userId]);
  return new Map(rows.map((r: any) => [String(r.want_key), new Set<string>(Array.isArray(r.d) ? r.d.map(String) : [])]));
}

export async function proposedWants(userId: string, db: Db = pool): Promise<Set<string>> {
  // A proposal that never went (its find died, or its gap went, before it was sent) doesn't count: nothing was proposed.
  const { rows } = await db.query(`SELECT want_key FROM bounce_proposals WHERE user_id = $1 AND status <> 'dropped'`, [userId]);
  return new Set(rows.map((r: any) => String(r.want_key)));
}

// The run (jobs/index.ts, every 15 minutes): every member with a want whose window is still open.
export async function runBounceTriggers(now = new Date()): Promise<number> {
  const { rows } = await pool.query(`SELECT DISTINCT user_id FROM want_places WHERE window_end >= (NOW() - INTERVAL '1 day')::date AND want_key NOT LIKE 'where:%'`);
  let queued = 0;
  for (const r of rows) queued += await bounceFor(String(r.user_id), now).catch((err: any) => (console.error(`bounce: ${r.user_id} failed (non-fatal):`, err?.message ?? err), 0));
  return queued;
}

export async function bounceFor(userId: string, now = new Date()): Promise<number> {
  const { memberZone, localDay } = await import("./memberTime.js");
  const zone = (await memberZone(userId).catch(() => null)) ?? "America/Los_Angeles";
  const today = localDay(now, zone);
  const wants = await wantsWithWindows(userId, today);
  if (!wants.length) return 0;
  const [judged, proposed, stated, offered, dropped] = await Promise.all([latestJudgments(userId), proposedWants(userId), import("./wantWhen.js").then((W) => W.freeTimesOf(userId, today)), offeredFinds(userId), droppedFinds(userId)]);
  // Their calendar (free/busy only), read once over the longest window; none, or a failed read, means no calendar gap.
  const last = wants.map((w) => w.until).sort().pop()!;
  const { calendarBusy, spanFree } = await import("./cueGrants.js");
  const busy = await calendarBusy(userId, now, new Date(Date.parse(`${last}T23:59:59Z`) + 86_400_000)).catch(() => null);
  const calendarFree = (s: Date, e: Date) => (busy ? spanFree(s, e, busy) : null);
  let queued = 0;
  for (const want of wants) {
    const wz = await wantZone(want, zone);
    const finds = await findsForWant(userId, want.key);
    const pick = pickProposal(want, finds, { today, zone: wz, judged, stated, calendarFree, proposed, offered, dropped });
    if (!pick) {
      // No gap to propose in, but their calendar would place it: the one calendar offer (once ever; a no is never asked again).
      if (!busy && planNeedsCalendar(want, finds, { today, zone: wz, judged, stated, proposed, offered, dropped })) await queueCalendarOffer(userId, want, finds, wz).catch(() => {});
      continue;
    }
    if (!(await queueProposal(userId, pick, pick.zone))) continue;
    proposed.add(want.key);
    queued++;
  }
  return queued;
}

// The zone a want's plans are in: its place's (a Chicago trip is in Chicago time), else home.
async function wantZone(want: BounceWant, home: string): Promise<string> {
  if (!want.place) return home;
  const { getTimezoneForCity } = await import("./geocoding.js");
  return (await getTimezoneForCity(want.place).catch(() => null)) ?? home;
}

// Queued, or false. Each attempt has its own target key (the proposal's created_at), so a proposal that was dropped before it went
// can be queued again: one key per want collided with the dropped attempt's candidate and was refused, leaving the want 'queued'
// forever and never proposed again (review of #222). A refusal puts the row back to 'dropped'. Once sent, it's once per want (the row).
export async function queueProposal(userId: string, p: ProposalPick, zone: string): Promise<boolean> {
  // The plan itself is kept with the proposal (plan), so a yes can be watched: the find, the gap, its times and their zone.
  const plan = { match: p.find.match, askText: p.find.askText, gap: p.gap, times: p.times, zone };
  const { rows } = await pool.query(
    `INSERT INTO bounce_proposals (user_id, want_key, find_name, find_day, gap_source, gap_from, gap_to, status, plan) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8::jsonb)
     ON CONFLICT (user_id, want_key) DO UPDATE SET find_name = EXCLUDED.find_name, find_day = EXCLUDED.find_day, gap_source = EXCLUDED.gap_source,
       gap_from = EXCLUDED.gap_from, gap_to = EXCLUDED.gap_to, plan = EXCLUDED.plan || jsonb_build_object('dropped', COALESCE(bounce_proposals.plan->'dropped', '[]'::jsonb)), status = 'queued', message = NULL, sent_at = NULL, answer_words = NULL, created_at = NOW()
       WHERE bounce_proposals.status = 'dropped'
     RETURNING id, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS attempt`,
    [userId, p.want.key, String(p.find.match?.name ?? "").slice(0, 200), p.times.day, p.gap.source, p.times.from, p.times.to, JSON.stringify(plan)],
  );
  if (!rows[0]) return false; // proposed already (sent, accepted or declined): once per want
  const { enqueueCandidate } = await import("../harness/proactive.js");
  const until = DateTime.fromISO(`${p.times.day}T${p.times.from}`, { zone }).toJSDate();
  const r = await enqueueCandidate({
    userId,
    type: "bounce_proposal",
    targetKey: `bounce:${p.want.key}:${rows[0].attempt}`,
    summary: `One plan for "${p.want.text.slice(0, 80)}": ${String(p.find.match?.name ?? "").slice(0, 80)}, ${p.times.day} ${p.times.from}`,
    payload: { proposalId: String(rows[0].id), askId: p.find.askId, askText: p.find.askText, want: p.want, match: p.find.match, gap: p.gap, times: p.times, zone },
    expiresAt: until,
  }).catch(() => ({ queued: false }));
  if (!r?.queued) {
    await pool.query(`UPDATE bounce_proposals SET status = 'dropped', plan = jsonb_set(COALESCE(plan, '{}'::jsonb), '{dropped}', COALESCE(plan->'dropped', '[]'::jsonb) || to_jsonb(find_name || '|' || COALESCE(find_day::text, ''))) WHERE id = $1 AND status = 'queued'`, [rows[0].id]).catch(() => {});
    return false;
  }
  return true;
}

// At send time: the gap read again. A calendar gap must still be free; a stated one must still be theirs (not removed). Else silence.
export async function gapStillHolds(userId: string, gap: Gap, times: { day: string; from: string; to: string }, zone: string): Promise<boolean> {
  if (gap.source === "calendar") {
    const { calendarBusy, spanFree } = await import("./cueGrants.js");
    const s = DateTime.fromISO(`${times.day}T${times.from}`, { zone }).toJSDate();
    const e = DateTime.fromISO(`${times.day}T${times.to}`, { zone }).toJSDate();
    const busy = await calendarBusy(userId, s, e).catch(() => null);
    return !!busy && spanFree(s, e, busy);
  }
  const W = await import("./wantWhen.js");
  const stated = await W.freeTimesOf(userId, times.day);
  return !!statedCovering(stated, times.day, times.from, times.to);
}

// Their answer to the proposal (answerProposal): recorded, nothing booked or held anywhere. A yes to "want me to keep an eye on it?"
// starts the watch (watch_until: when the plan starts, in its own zone); a no starts nothing. The latest one sent within answerDays.
export async function answerLatest(userId: string, yes: boolean, theirWords: string, db: Db = pool): Promise<{ id: string; find: string; day: string; from: string; watching: boolean; gapSource: string } | null> {
  const { rows } = await db.query(
    `UPDATE bounce_proposals SET status = $2, answered_at = NOW(), answer_words = $3 WHERE id = (
       SELECT id FROM bounce_proposals WHERE user_id = $1 AND status = 'proposed' AND sent_at > NOW() - make_interval(days => $4) ORDER BY sent_at DESC LIMIT 1)
     RETURNING id, find_name, find_day, gap_from, gap_source, plan`,
    [userId, yes ? "accepted" : "declined", theirWords.slice(0, 300), BOUNCE.answerDays],
  );
  const r = rows[0];
  if (!r) return null;
  const until = yes ? watchUntil(r.plan) : null;
  if (until) await db.query(`UPDATE bounce_proposals SET watch_until = $2, watch_ended_at = NULL, watch_outcome = NULL WHERE id = $1`, [r.id, until]);
  return { id: String(r.id), find: String(r.find_name), day: r.find_day instanceof Date ? r.find_day.toISOString().slice(0, 10) : String(r.find_day).slice(0, 10), from: String(r.gap_from).slice(0, 5), watching: !!until, gapSource: String(r.gap_source) };
}

// Pure: when the watch ends: when the plan starts, in its own zone (null when the plan's times weren't kept).
export function watchUntil(plan: any): Date | null {
  const t = plan?.times;
  if (!t?.day || !t?.from) return null;
  const d = DateTime.fromISO(`${t.day}T${t.from}`, { zone: plan.zone || "America/Los_Angeles" });
  return d.isValid ? d.toJSDate() : null;
}

// ---------------------------------------------------------------- the watch ("want me to keep an eye on it?")

export type WatchRead = "holds" | "changed" | "unknown";
// Pure: what the watch does with one look. Either changed: tell them once and stop. Anything unknown (a read that failed): say nothing,
// look again next time. Both hold: keep watching, silently.
export function watchStep(find: WatchRead, gap: WatchRead): "keep" | "tell" {
  return find === "changed" || gap === "changed" ? "tell" : "keep";
}

// The gap, read again for the watch: their calendar (free now, busy now, or can't tell), or the time they told Cue (still theirs or
// removed). A calendar they disconnected can't be watched: the watch ends quietly ("unwatchable").
// Pure: after their yes, whether their calendar still leaves the plan clear. Free/busy carries no event, so a busy block that is the
// plan's own span (they put it in their calendar, as people do after a yes) reads as theirs, not a clash (review of the grants work:
// the watch told them "your calendar now shows you busy then" about their own plan). Anything else over the span is a clash.
export const OWN_PLAN_SLACK_MS = 30 * 60_000;
export function planStillClear(from: Date, to: Date, busy: { start: string; end: string }[]): boolean {
  const over = busy.filter((b) => Date.parse(b.start) < to.getTime() && Date.parse(b.end) > from.getTime());
  return over.every((b) => Math.abs(Date.parse(b.start) - from.getTime()) <= OWN_PLAN_SLACK_MS && Math.abs(Date.parse(b.end) - to.getTime()) <= OWN_PLAN_SLACK_MS);
}

export async function gapNow(userId: string, gap: Gap, times: { day: string; from: string; to: string }, zone: string): Promise<WatchRead | "unwatchable"> {
  if (gap.source === "calendar") {
    const C = await import("./cueGrants.js");
    if (!(await C.calendarConnected(userId).catch(() => null))) return "unwatchable";
    const s = DateTime.fromISO(`${times.day}T${times.from}`, { zone }).toJSDate();
    const e = DateTime.fromISO(`${times.day}T${times.to}`, { zone }).toJSDate();
    const busy = await C.calendarBusy(userId, s, e).catch(() => null);
    return busy === null ? "unknown" : planStillClear(s, e, busy) ? "holds" : "changed";
  }
  const held = await gapStillHolds(userId, gap, times, zone).catch(() => null);
  return held === null ? "unknown" : held ? "holds" : "changed";
}

// The run (with the trigger, every 15 minutes): every accepted plan still ahead. Started: the watch ends quietly. Changed: one message
// (bounce_watch) says what changed, and the watch ends.
export async function runBounceWatches(now = new Date(), deps: { findNow?: (p: any, userId: string) => Promise<WatchRead>; gap?: typeof gapNow; enqueue?: Enqueue } = {}): Promise<number> {
  await pool.query(`UPDATE bounce_proposals SET watch_ended_at = NOW(), watch_outcome = 'started' WHERE status = 'accepted' AND watch_ended_at IS NULL AND watch_until IS NOT NULL AND watch_until <= $1`, [now]);
  const { rows } = await pool.query(`SELECT id, user_id, find_name, plan FROM bounce_proposals WHERE status = 'accepted' AND watch_ended_at IS NULL AND watch_until > $1`, [now]);
  let told = 0;
  for (const r of rows) {
    const plan = r.plan ?? {};
    const userId = String(r.user_id);
    const g = await (deps.gap ?? gapNow)(userId, plan.gap, plan.times, plan.zone).catch(() => "unknown" as const);
    if (g === "unwatchable") {
      await pool.query(`UPDATE bounce_proposals SET watch_ended_at = NOW(), watch_outcome = 'calendar_disconnected' WHERE id = $1`, [r.id]);
      continue;
    }
    const f = await (deps.findNow ?? findNow)(plan, userId).catch(() => "unknown" as const);
    if (watchStep(f, g) === "keep") continue;
    const what = f === "changed" ? "find_gone" : plan.gap?.source === "calendar" ? "calendar_busy" : "time_removed";
    const ended = await pool.query(`UPDATE bounce_proposals SET watch_ended_at = NOW(), watch_outcome = $2 WHERE id = $1 AND watch_ended_at IS NULL RETURNING id`, [r.id, what]);
    if (!ended.rows[0]) continue;
    await (deps.enqueue ?? realEnqueue)({
      userId,
      type: "bounce_watch",
      targetKey: `bounce_watch:${r.id}`,
      summary: `The plan they asked Cue to keep an eye on changed: ${String(r.find_name).slice(0, 80)} (${what})`,
      payload: { proposalId: String(r.id), what, plan },
      expiresAt: watchUntil(plan) ?? new Date(now.getTime() + 86_400_000),
    });
    told++;
  }
  return told;
}

// The find, read again for the watch (sendCheck's re-read, writing nothing): still on, gone, or can't tell.
async function findNow(plan: any, userId: string): Promise<WatchRead> {
  const { checkBeforeSend } = await import("./sendCheck.js");
  const r = await checkBeforeSend({ id: "watch", userId, payload: { match: { ...plan.match, checkedAt: undefined }, askText: plan.askText } }, plan.zone ?? null, undefined, { dryRun: true });
  return "ok" in r ? "holds" : "skip" in r && r.exited ? "changed" : "unknown";
}

// Pure: the message that the watched plan changed. Says what changed, plainly; no other options pushed, nothing held.
export function watchBrief(p: { what: string; plan: any }): { facts: Record<string, string>; task: string } {
  const t = p.plan?.times ?? {};
  const z = p.plan?.zone || "America/Los_Angeles";
  const when = t.day && t.from ? DateTime.fromISO(`${t.day}T${t.from}`, { zone: z }).toFormat("cccc h:mm a").replace(":00", "") : "";
  const changed = p.what === "find_gone" ? "it isn't happening as planned any more (sold out, cancelled or gone)" : p.what === "calendar_busy" ? "their calendar now shows them busy then" : "the free time they told you about is no longer on file";
  return {
    facts: { the_plan: String(p.plan?.match?.name ?? ""), ...(when ? { when } : {}), what_changed: changed },
    task: "You told them you'd keep an eye on this plan. Tell them, in one or two plain sentences, what changed. No apology spiral, no list of other options, nothing booked or held, no question unless one plainly helps.",
  };
}

// Pure: the plan's facts and the task the draft is held to (the proactive message test: a traceable reason, the work already done, a
// short close). The close is "want me to keep an eye on it?" at every floor (Royce, 2026-10-15): with the calendar grant Cue watches
// their calendar, without it the time they told Cue; nothing is ever held or booked.
export function proposalBrief(p: { want: BounceWant; match: any; gap: Gap; times: { day: string; from: string; to: string }; zone: string }): { facts: Record<string, string>; task: string } {
  const d = DateTime.fromISO(p.times.day, { zone: p.zone });
  const clock = (hhmm: string) => DateTime.fromISO(`${p.times.day}T${hhmm}`, { zone: p.zone }).toFormat("h:mm a").replace(":00", "").toLowerCase();
  const span = DateTime.fromISO(`${p.times.day}T${p.gap.to}`, { zone: p.zone }).diff(DateTime.fromISO(`${p.times.day}T${p.gap.from}`, { zone: p.zone }), "minutes").minutes;
  const det = p.match?.details ?? {};
  const facts: Record<string, string> = {
    what_they_told_you_they_want: p.want.text,
    ...(p.want.place ? { where_they_are: p.want.place } : {}),
    ...(p.want.quote ? { their_own_words_about_it: p.want.quote } : {}),
    the_day: `${d.toFormat("cccc, LLLL d")} (${p.times.day})`,
    their_free_time: `${clock(p.gap.from)} to ${clock(p.gap.to)}${span ? ` (${Math.round(span)} minutes)` : ""}, ${p.gap.source === "calendar" ? "free on their calendar" : `a time they told you they're free${p.gap.quote ? `: "${p.gap.quote}"` : ""}`}`,
    the_plan: String(p.match?.name ?? ""),
    starts: clock(p.times.from),
    ...(det.venue ? { where_it_is: String(det.venue) } : {}),
    ...(p.match?.whyItFits ? { why_it_fits_them: String(p.match.whyItFits) } : {}),
  };
  const close = "want me to keep an eye on it?";
  const task = `Propose one plan for their free time, as one solved thing, not options: say the free time and the day in a few words, then the plan and why it's theirs (only from the facts: what they told you, and why it fits), then end with the question "${close}" or very close to it. Two sentences at most. Keeping an eye on it means you'll check it's still on and that ${p.gap.source === "calendar" ? "their calendar stays free" : "the time they told you is still theirs"}, and tell them if that changes. Never say you'll hold, book, reserve or save anything. Reflect only what they told you, never how they seem. No list, no other options, no sign-off.`;
  return { facts, task };
}
