// What Co can bring up on a call when it looks something up (Hume's
// surface_recommendation tool). A call can't wait on a search loop, so this
// uses no model at all: the same raw candidates Co's text loop gets (Co's own
// events, the public feed, openings Co's daily search already found) plus the
// shortlist from Co's working notes, for what they're after right now. The
// voice model judges what fits and says it in its own words (2026-10-01: this
// used to run the old reply pipeline and its model gates).
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { memberZoneOrFallback } from "./memberTime.js";
import { eventCandidates, type TierMatch } from "./tieredRecommendation.js";
import { alreadyFoundOpenings } from "./eventSurfacingSweep.js";
import { loadBrief } from "./searchIntent.js";
import { latestAskEntry } from "../harness/profileWrite.js";

export type VoiceItem = { name: string; details: string[]; link: string | null; starts?: string | null };
export type VoiceFinds =
  | { available: true; lookingFor: string; items: VoiceItem[]; note: string }
  | { available: false; reason: string };

// An event that has already started (or ended) is not offered on a call, and what is offered says WHEN in words relative to right
// now, so the voice model never has to work out "tonight" or "tomorrow" itself (2026-10-05: Co offered an event starting the next
// evening as "tonight", at 10pm, and the member took it as already gone).
export function whenFromNow(startAt: string | null | undefined, zone: string, now: Date): string | null {
  if (!startAt) return null;
  const start = DateTime.fromISO(startAt, { zone });
  if (!start.isValid) return null;
  const n = DateTime.fromJSDate(now).setZone(zone);
  const days = Math.round(start.startOf("day").diff(n.startOf("day"), "days").days);
  const label = days === 0 ? "today, " : days === 1 ? "tomorrow, " : "";
  const hours = start.diff(n, "hours").hours;
  const away = hours < 1 ? `in ${Math.max(1, Math.round(hours * 60))} minutes` : hours < 24 ? `in about ${Math.round(hours)} hours` : "";
  return `${label}${start.toFormat("cccc, LLLL d")} at ${start.toFormat("h:mm a")}${away ? `, ${away}` : ""}`;
}
export function stillAhead(startAt: string | null | undefined, endAt: string | null | undefined, now: Date): boolean {
  const t = now.getTime();
  const start = startAt ? new Date(startAt).getTime() : NaN;
  const end = endAt ? new Date(endAt).getTime() : NaN;
  if (Number.isFinite(end) && end <= t) return false;
  if (Number.isFinite(start) && start <= t) return false;
  return true;
}

export const VOICE_NOTE =
  "Candidates, not picks: mention only the one or two that genuinely fit what they want, describe each only from its details here, say what's unconfirmed, and offer to text them the link rather than reading it out. Say when an event is only as `starts` says (it is worded from right now): never call something \"tonight\" or \"today\" unless `starts` says today.";

export async function voiceFinds(userId: string, now: Date = new Date()): Promise<VoiceFinds> {
  const [brief, profile] = await Promise.all([
    loadBrief(userId).catch(() => null),
    pool.query(`SELECT city, intent FROM co_profiles WHERE user_id = $1`, [userId]).then((r) => r.rows[0] ?? null).catch(() => null),
  ]);
  const what = brief?.what?.trim() || latestAskEntry(profile?.intent)?.text?.trim() || "";
  if (!what) return { available: false, reason: "they haven't asked Cue to find anything yet" };
  const city = brief?.city ?? profile?.city ?? null;
  const [events, openings] = await Promise.all([
    // No Exa search on a call (services/lumaViaExa.ts): it takes about 6 seconds, and a call can't wait for it. The feed's events only.
    eventCandidates(what, city, { when: brief?.when ?? null, userId, limit: 5, viaExa: false }).catch(() => null),
    alreadyFoundOpenings(userId).catch(() => [] as TierMatch[]),
  ]);
  const zone = await memberZoneOrFallback(userId);
  const items: VoiceItem[] = [
    ...(brief?.shortlist ?? []).slice(0, 3).map((s) => ({ name: s.name, details: s.note ? [s.note] : [], link: s.url })),
    // Started or over: not offered. Times come back as words relative to now.
    ...(events?.candidates ?? [])
      .filter(({ match }) => stillAhead(match.details?.startAt, match.details?.endAt, now))
      .slice(0, 4)
      .map(({ match, lines }) => ({ name: match.name, details: lines.slice(0, 4), link: "url" in match ? (match.url ?? null) : null, starts: whenFromNow(match.details?.startAt, match.details?.timezone ?? zone, now) })),
    ...openings.filter((m) => "url" in m && m.url).slice(0, 2).map((m) => ({ name: m.name, details: [m.reason], link: (m as any).url as string })),
  ];
  if (!items.length) return { available: false, reason: `nothing real on file yet for "${what}"` };
  return { available: true, lookingFor: what, items, note: VOICE_NOTE };
}
