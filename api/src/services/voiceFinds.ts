// What Co can bring up on a call when it looks something up (Hume's
// surface_recommendation tool). A call can't wait on a search loop, so this
// uses no model at all: the same raw candidates Co's text loop gets (Co's own
// events, the public feed, openings Co's daily search already found) plus the
// shortlist from Co's working notes, for what they're after right now. The
// voice model judges what fits and says it in its own words (2026-10-01: this
// used to run the old reply pipeline and its model gates).
import pool from "../db/db.js";
import { eventCandidates, type TierMatch } from "./tieredRecommendation.js";
import { alreadyFoundOpenings } from "./eventSurfacingSweep.js";
import { loadBrief } from "./searchIntent.js";
import { latestAskEntry } from "../harness/profileWrite.js";

export type VoiceFinds =
  | { available: true; lookingFor: string; items: { name: string; details: string[]; link: string | null }[]; note: string }
  | { available: false; reason: string };

export const VOICE_NOTE =
  "Candidates, not picks: mention only the one or two that genuinely fit what they want, describe each only from its details here, say what's unconfirmed, and offer to text them the link rather than reading it out.";

export async function voiceFinds(userId: string): Promise<VoiceFinds> {
  const [brief, profile] = await Promise.all([
    loadBrief(userId).catch(() => null),
    pool.query(`SELECT city, intent FROM co_profiles WHERE user_id = $1`, [userId]).then((r) => r.rows[0] ?? null).catch(() => null),
  ]);
  const what = brief?.what?.trim() || latestAskEntry(profile?.intent)?.text?.trim() || "";
  if (!what) return { available: false, reason: "they haven't asked Co to find anything yet" };
  const city = brief?.city ?? profile?.city ?? null;
  const [events, openings] = await Promise.all([
    eventCandidates(what, city, { when: brief?.when ?? null, userId, limit: 5 }).catch(() => null),
    alreadyFoundOpenings(userId).catch(() => [] as TierMatch[]),
  ]);
  const items = [
    ...(brief?.shortlist ?? []).slice(0, 3).map((s) => ({ name: s.name, details: s.note ? [s.note] : [], link: s.url })),
    ...(events?.candidates ?? []).slice(0, 4).map(({ match, lines }) => ({ name: match.name, details: lines.slice(0, 4), link: "url" in match ? (match.url ?? null) : null })),
    ...openings.filter((m) => "url" in m && m.url).slice(0, 2).map((m) => ({ name: m.name, details: [m.reason], link: (m as any).url as string })),
  ];
  if (!items.length) return { available: false, reason: `nothing real on file yet for "${what}"` };
  return { available: true, lookingFor: what, items, note: VOICE_NOTE };
}
