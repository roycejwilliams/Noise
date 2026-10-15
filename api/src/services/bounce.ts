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
// now, or the stated time removed: silence). Their yes or no is recorded (answerProposal); nothing is booked or held anywhere yet.
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

export type ProposalPick = { want: BounceWant; find: BounceFind; gap: Gap; times: { day: string; from: string; to: string } };

// Pure: the one proposal for one want, or null (silence). busyFree: whether their calendar shows them free over the find's span (null
// when there's no calendar, or it couldn't be read: then only a stated time can be a gap).
export function pickProposal(
  want: BounceWant,
  finds: BounceFind[],
  o: { today: string; zone: string; judged: Judged[]; stated: StatedTime[]; calendarFree: (start: Date, end: Date) => boolean | null; proposed: Set<string> },
): ProposalPick | null {
  if (o.proposed.has(want.key) || want.until < o.today) return null;
  const judged = new Map(o.judged.map((j) => [j.key, j]));
  const fits = finds
    .map((f) => ({ f, t: findTimes(f.match, o.zone), j: judged.get(findKey(f.match)) }))
    .filter((x) => x.t && x.t.day >= o.today && x.t.day <= want.until && x.t.start.getTime() > Date.now())
    .filter((x) => x.j && (x.j.verdict === "send" || !!x.j.tierPick) && x.j.taste !== "clashes")
    .sort((a, b) => a.t!.start.getTime() - b.t!.start.getTime());
  for (const x of fits) {
    const t = x.t!;
    const cal = o.calendarFree(t.start, t.end);
    if (cal === true) return { want, find: x.f, gap: { source: "calendar", day: t.day, from: t.from, to: t.to, quote: null }, times: t };
    if (cal === false) continue; // their calendar says they're busy then: never proposed over it
    const s = statedCovering(o.stated, t.day, t.from, t.to);
    if (s) return { want, find: x.f, gap: { source: "stated", day: t.day, from: s.from, to: s.to, quote: s.quote }, times: t };
  }
  return null;
}

// ---------------------------------------------------------------- data and the run

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function wantsWithWindows(userId: string, today: string, db: Db = pool): Promise<BounceWant[]> {
  const { rows } = await db.query(`SELECT want_key, want_text, place, window_end, window_quote FROM want_places WHERE user_id = $1 AND window_end >= $2::date`, [userId, today]);
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

export async function proposedWants(userId: string, db: Db = pool): Promise<Set<string>> {
  // A proposal that never went (its find died, or its gap went, before it was sent) doesn't count: nothing was proposed.
  const { rows } = await db.query(`SELECT want_key FROM bounce_proposals WHERE user_id = $1 AND status <> 'dropped'`, [userId]);
  return new Set(rows.map((r: any) => String(r.want_key)));
}

// The run (jobs/index.ts, every 15 minutes): every member with a want whose window is still open.
export async function runBounceTriggers(now = new Date()): Promise<number> {
  const { rows } = await pool.query(`SELECT DISTINCT user_id FROM want_places WHERE window_end >= (NOW() - INTERVAL '1 day')::date`);
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
  const [judged, proposed, stated] = await Promise.all([latestJudgments(userId), proposedWants(userId), import("./wantWhen.js").then((W) => W.freeTimesOf(userId, today))]);
  // Their calendar (free/busy only), read once over the longest window; none, or a failed read, means no calendar gap.
  const last = wants.map((w) => w.until).sort().pop()!;
  const { calendarBusy, spanFree } = await import("./calendarGrant.js");
  const busy = await calendarBusy(userId, now, new Date(Date.parse(`${last}T23:59:59Z`) + 86_400_000)).catch(() => null);
  const calendarFree = (s: Date, e: Date) => (busy ? spanFree(s, e, busy) : null);
  let queued = 0;
  for (const want of wants) {
    const pick = pickProposal(want, await findsForWant(userId, want.key), { today, zone, judged, stated, calendarFree, proposed });
    if (!pick) continue;
    await queueProposal(userId, pick, zone);
    proposed.add(want.key);
    queued++;
  }
  return queued;
}

async function queueProposal(userId: string, p: ProposalPick, zone: string): Promise<void> {
  const { rows } = await pool.query(
    `INSERT INTO bounce_proposals (user_id, want_key, find_name, find_day, gap_source, gap_from, gap_to, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
     ON CONFLICT (user_id, want_key) DO UPDATE SET find_name = EXCLUDED.find_name, find_day = EXCLUDED.find_day, gap_source = EXCLUDED.gap_source,
       gap_from = EXCLUDED.gap_from, gap_to = EXCLUDED.gap_to, status = 'queued', message = NULL, sent_at = NULL, answer_words = NULL, created_at = NOW()
       WHERE bounce_proposals.status = 'dropped'
     RETURNING id`,
    [userId, p.want.key, String(p.find.match?.name ?? "").slice(0, 200), p.times.day, p.gap.source, p.times.from, p.times.to],
  );
  if (!rows[0]) return; // proposed already (sent, accepted or declined): once per want
  const { enqueueCandidate } = await import("../harness/proactive.js");
  const until = DateTime.fromISO(`${p.times.day}T${p.times.from}`, { zone }).toJSDate();
  await enqueueCandidate({
    userId,
    type: "bounce_proposal",
    targetKey: `bounce:${p.want.key}`,
    summary: `One plan for "${p.want.text.slice(0, 80)}": ${String(p.find.match?.name ?? "").slice(0, 80)}, ${p.times.day} ${p.times.from}`,
    payload: { proposalId: String(rows[0].id), askId: p.find.askId, askText: p.find.askText, want: p.want, match: p.find.match, gap: p.gap, times: p.times, zone },
    expiresAt: until,
  });
}

// At send time: the gap read again. A calendar gap must still be free; a stated one must still be theirs (not removed). Else silence.
export async function gapStillHolds(userId: string, gap: Gap, times: { day: string; from: string; to: string }, zone: string): Promise<boolean> {
  if (gap.source === "calendar") {
    const { calendarBusy, spanFree } = await import("./calendarGrant.js");
    const s = DateTime.fromISO(`${times.day}T${times.from}`, { zone }).toJSDate();
    const e = DateTime.fromISO(`${times.day}T${times.to}`, { zone }).toJSDate();
    const busy = await calendarBusy(userId, s, e).catch(() => null);
    return !!busy && spanFree(s, e, busy);
  }
  const W = await import("./wantWhen.js");
  const stated = await W.freeTimesOf(userId, times.day);
  return !!statedCovering(stated, times.day, times.from, times.to);
}

// Their answer to the proposal (answerProposal): recorded, nothing booked or held anywhere (the bounce: "record the yes, execution is
// the next pass"). The latest one sent to them within BOUNCE.answerDays.
export async function answerLatest(userId: string, yes: boolean, theirWords: string, db: Db = pool): Promise<{ id: string; find: string; day: string; from: string } | null> {
  const { rows } = await db.query(
    `UPDATE bounce_proposals SET status = $2, answered_at = NOW(), answer_words = $3 WHERE id = (
       SELECT id FROM bounce_proposals WHERE user_id = $1 AND status = 'proposed' AND sent_at > NOW() - make_interval(days => $4) ORDER BY sent_at DESC LIMIT 1)
     RETURNING id, find_name, find_day, gap_from`,
    [userId, yes ? "accepted" : "declined", theirWords.slice(0, 300), BOUNCE.answerDays],
  );
  const r = rows[0];
  return r ? { id: String(r.id), find: String(r.find_name), day: r.find_day instanceof Date ? r.find_day.toISOString().slice(0, 10) : String(r.find_day).slice(0, 10), from: String(r.gap_from).slice(0, 5) } : null;
}

// Pure: the plan's facts and the task the draft is held to (Royce: one solved plan, "You've got 90 minutes Tuesday. Small gallery two
// blocks from your hotel, want me to hold it?"; the proactive message test: a traceable reason, the work already done, a one-word close).
// Only a calendar gap may be offered as held; a stated time is only ever suggested.
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
  const close = p.gap.source === "calendar" ? "want me to hold it?" : "want to go?";
  const task = `Propose one plan for their free time, as one solved thing, not options: say the free time and the day in a few words, then the plan and why it's theirs (only from the facts: what they told you, and why it fits), then end with the one-word question "${close}" or very close to it. Two sentences at most. ${p.gap.source === "calendar" ? "You may offer to hold the time on their behalf; nothing is booked yet." : "Never say you'll hold or book anything: it's a time they told you they're free, so you only suggest it."} Reflect only what they told you, never how they seem. No list, no other options, no sign-off.`;
  return { facts, task };
}
