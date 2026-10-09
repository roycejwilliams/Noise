// What Co's sweep selection (services/sweepSelect.ts) knows about a member,
// read as of a moment: only records created before `now`, so a replay of a
// past day can't see the future and the live shadow sees what it would today.
// Shared by the replay (evals/sweepSelect/replay.ts) and the shadow run
// (services/sweepShadow.ts).
import { DateTime } from "luxon";
import type { SelectContext } from "./sweepSelect.js";

export type Q = (sql: string, args?: unknown[]) => Promise<any[]>;
const ZONE = "America/Los_Angeles";

// Their open asks (plus any ask a candidate serves, even if closed since),
// numbered A1, A2..., and the map from ask_checkins.id to that number.
export async function loadAsks(q: Q, userId: string, now: Date, alsoIds: string[] = []): Promise<{ asks: SelectContext["asks"]; idFor: Map<string, string> }> {
  const all = await q(`SELECT id, ask_text, created_at, resolved_at FROM ask_checkins WHERE user_id = $1 ORDER BY created_at, id`, [userId]);
  const open = all.filter((a: any) => new Date(a.created_at) < now && (!a.resolved_at || new Date(a.resolved_at) > now));
  const extra = all.filter((a: any) => alsoIds.includes(String(a.id)) && !open.includes(a));
  const idFor = new Map<string, string>();
  const asks = [...open, ...extra].map((a: any, i: number) => {
    idFor.set(String(a.id), `A${i + 1}`);
    return { id: `A${i + 1}`, text: String(a.ask_text), since: DateTime.fromJSDate(new Date(a.created_at)).setZone(ZONE).toISODate()! };
  });
  return { asks, idFor };
}

// Everything else: recent texts, what Co sent first and whether they replied,
// how they reacted to suggestions, recent feelings, discovery left this week.
export async function loadMemberContext(q: Q, userId: string, now: Date): Promise<Omit<SelectContext, "asks" | "pool" | "today" | "weekday">> {
  const [me] = await q(`SELECT u.first_name, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [userId]);
  // Another member's details stripped (2026-10-09 audit: the picker read raw texts). Fails closed: no strip, no texts.
  const safe = await import("./memberSafeMemories.js").then((m) => m.memberSafeLine(userId)).catch(() => null);
  const texts = (await q(`SELECT created_at, content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND created_at < $2 AND created_at >= $2::timestamptz - INTERVAL '14 days' ORDER BY created_at`, [userId, now])).map((t: any, i: number) => ({
    id: `T${i + 1}`,
    at: DateTime.fromJSDate(new Date(t.created_at)).setZone(ZONE).toFormat("LLL d HH:mm"),
    from: /^User/i.test(t.content) ? ("member" as const) : ("co" as const),
    text: safe ? (safe(String(t.content)) ?? "").replace(/^(User said|Co replied|User|Co):\s*/i, "") : "",
  })).filter((t: any) => t.text).map((t: any, i: number) => ({ ...t, id: `T${i + 1}` }));
  const inbound = (await q(`SELECT created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User %' AND created_at < $2 AND created_at >= $2::timestamptz - INTERVAL '31 days'`, [userId, now])).map((r: any) => new Date(r.created_at).getTime());
  const sent = (await q(`SELECT sent_at, type, message FROM proactive_sends WHERE user_id = $1 AND sent_at < $2 AND sent_at >= $2::timestamptz - INTERVAL '30 days' ORDER BY sent_at`, [userId, now])).map((s: any, i: number) => {
    const t = new Date(s.sent_at).getTime();
    const replied = inbound.some((x: number) => x > t && x - t < 24 * 3_600_000 && x < now.getTime());
    // A match nudge's text names the other member: stripped like the texts (review of #118).
    return { id: `S${i + 1}`, at: DateTime.fromJSDate(new Date(s.sent_at)).setZone(ZONE).toFormat("LLL d"), what: `${s.type}: ${(safe ? safe(String(s.message ?? "")) ?? "" : "").replace(/\s+/g, " ")}`, reaction: replied ? "they replied within a day" : null };
  });
  const outcomes = (await q(`SELECT created_at, item_name, result, note FROM suggestion_outcomes WHERE user_id = $1 AND created_at < $2 ORDER BY created_at`, [userId, now])).map((o: any, i: number) => ({
    id: `O${i + 1}`,
    at: DateTime.fromJSDate(new Date(o.created_at)).setZone(ZONE).toFormat("LLL d"),
    item: safe ? safe(String(o.item_name)) ?? "another member" : "",
    result: String(o.result),
    note: o.note && safe ? safe(String(o.note)) : null,
  }));
  const feel = await q(`SELECT emotion, intensity, about FROM emotion_signals WHERE user_id = $1 AND created_at < $2 AND created_at >= $2::timestamptz - INTERVAL '3 days' AND COALESCE(target, 'life') = 'life' ORDER BY created_at DESC LIMIT 4`, [userId, now]).catch(() => [] as any[]);
  // Where they are headed: the lens every candidate is judged against alongside their asks (services/goalJourney.ts).
  const [prof] = await q(`SELECT goals, intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const goals = (await import("./goalJourney.js")).goalTexts(prof?.intent, prof?.goals).slice(0, 6);
  const [{ n: discoverySent }] = await q(
    `SELECT COUNT(*)::int n FROM proactive_sends s JOIN proactive_candidates c ON c.id = s.candidate_id
     WHERE s.user_id = $1 AND s.sent_at < $2 AND s.sent_at >= $2::timestamptz - INTERVAL '7 days' AND (c.payload->>'fromProfile' = 'true' OR s.type = 'event_match_nudge')`,
    [userId, now],
  );
  return {
    firstName: me?.first_name ?? "them",
    city: me?.city ?? null,
    goals,
    texts,
    sent,
    outcomes,
    feeling: feel.length ? feel.map((f: any) => `${f.emotion} (${f.intensity})${f.about ? ` about ${f.about}` : ""}`).join("; ") : null,
    discoveryLeft: Math.max(0, 4 - Number(discoverySent ?? 0)),
  };
}

export function dayOf(now: Date, zone = ZONE): { today: string; weekday: string } {
  const d = DateTime.fromJSDate(now).setZone(zone);
  return { today: d.toISODate()!, weekday: d.toFormat("cccc") };
}
