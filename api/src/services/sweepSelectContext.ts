// What Co's sweep selection (services/sweepSelect.ts) knows about a member.
// Shared by the replay (evals/sweepSelect/replay.ts) and the live/shadow run
// (services/sweepShadow.ts).
//
// Two reads, one shape:
//   - live (the shadow/picker run, `knowledge` passed): the member's facts come
//     from the shared layer (services/memberKnowledge.ts): identity and their
//     zone, goals with state (only active goals are the lens; done/stale are
//     history), what Co already gave them, what it is carrying, lessons,
//     corrections, taste, the person model, restraint and the recent
//     exchanges, all stripped inside the layer. Member rules come from
//     memberRules(k).
//   - as of a past moment (the replay, no `knowledge`): the layer reads now,
//     so a replay of a past day would see the future through it; the replay
//     keeps reading only records created before `now`.
// The picker's own records stay here either way (the layer doesn't have
// them): what Co sent first and whether they replied (S#), how they reacted
// to suggestions (O#) and discovery left this week, stripped like the texts.
import { isDidResult, isStated, UNCONFIRMED_RULE } from "./provenance.js";
import { DateTime } from "luxon";
import type { PastGoal, SelectContext } from "./sweepSelect.js";
import { memberKnowledge, memberRules, type Goal, type MemberKnowledge } from "./memberKnowledge.js";
import { wordsZone } from "./memberTime.js";
import { RECHECK_IDLE_REASON } from "./goalRecheck.js";

export type Q = (sql: string, args?: unknown[]) => Promise<any[]>;

// The picker reads 40 texts over 14 days (SELECT_LIMITS.texts).
export const PICKER_KNOWLEDGE = { exchanges: 40, exchangeDays: 14 } as const;
const LIMITS = { delivered: 25, carrying: 10, learned: 10, person: 1500, goalsPast: 10 } as const;

// The member's knowledge for a live picker run, or null when it can't be read stripped (the layer throws when the linked-name
// lookup fails: fails closed, so the picker then sees none of their facts rather than unstripped ones).
export async function loadKnowledge(userId: string, now: Date): Promise<MemberKnowledge | null> {
  return memberKnowledge(userId, { now, ...PICKER_KNOWLEDGE }).catch((err: any) => {
    console.error("picker: member knowledge unavailable (fails closed, no member facts):", err?.message ?? err);
    return null;
  });
}

// Their open asks (plus any ask a candidate serves, even if closed since, marked closed),
// numbered A1, A2..., and the map from ask_checkins.id to that number. The
// picker's own read: the backlog joins on ask_checkins.id, and a replay needs it as of `now`.
export async function loadAsks(q: Q, userId: string, now: Date, alsoIds: string[] = [], zone: string | null = null): Promise<{ asks: SelectContext["asks"]; idFor: Map<string, string> }> {
  const tz = wordsZone(zone);
  const all = await q(`SELECT id, ask_text, created_at, resolved_at FROM ask_checkins WHERE user_id = $1 ORDER BY created_at, id`, [userId]);
  const open = all.filter((a: any) => new Date(a.created_at) < now && (!a.resolved_at || new Date(a.resolved_at) > now));
  const extra = all.filter((a: any) => alsoIds.includes(String(a.id)) && !open.includes(a));
  const idFor = new Map<string, string>();
  const asks = [...open, ...extra].map((a: any, i: number) => {
    idFor.set(String(a.id), `A${i + 1}`);
    return { id: `A${i + 1}`, text: String(a.ask_text), since: DateTime.fromJSDate(new Date(a.created_at)).setZone(tz).toISODate()!, ...(open.includes(a) ? {} : { closed: true }) };
  });
  return { asks, idFor };
}

type MemberPart = Omit<SelectContext, "asks" | "pool" | "today" | "weekday">;
type Facts = Pick<MemberPart, "firstName" | "city" | "zone" | "goals" | "goalsTrimmed" | "goalsPast" | "texts" | "feeling" | "delivered" | "carrying" | "learned" | "person" | "rules" | "roomTaste">;

// Pure: the member's past goals for the picker, G1.., each with why it is past. A goal replaced by a newer one (goalEdges.ts writes
// 'replaced by a newer goal: "<newer>"') isn't listed: its direction goes on in the newer goal, which is in `goals` (Royce, 2026-10-13:
// Founder Fellows was rejected as matching "the accelerator goal he set aside" when that goal had only been replaced; kept hidden,
// Royce 2026-10-14). done, or set aside in their own words (they said so, or it was set in conversation), is theirs; a window that
// passed, no answer to a recheck, or a state nothing says who set is Co's bookkeeping ("lapsed"), which never carries a closed claim.
const REPLACED = /^replaced by a newer goal/;
const THEY_SAID = /^they said/;
export function pastGoals(goals: Pick<Goal, "text" | "state" | "reason" | "source">[], limit: number = LIMITS.goalsPast): PastGoal[] {
  return goals
    .filter((g) => g.state !== "active" && !REPLACED.test(g.reason ?? ""))
    .slice(0, limit)
    .map((g, i) => {
      const id = `G${i + 1}`;
      if (g.state === "done") return { id, text: g.text, state: "done" as const };
      const theirs = THEY_SAID.test(g.reason ?? "") || ((g.source === "member" || g.source === "co") && g.reason !== RECHECK_IDLE_REASON && !/^its window passed/.test(g.reason ?? ""));
      return theirs ? { id, text: g.text, state: "set_aside" as const } : { id, text: g.text, state: "lapsed" as const, why: g.reason ?? null };
    });
}

// Every active goal is the lens, newest first (Royce, 2026-10-14: "Yes on the cap... the guard's own check runs 'with all your active
// goals in view', which only holds if the cap is gone. Newest-first matters too, since the cap was cutting your newest goals"). The
// old cut of 6 dropped "apply to South Park Commons or Blueprint II" on 10-14. A safety ceiling far above any real member's count
// stays, and a cut is logged, never silent.
export const GOALS_CEILING = 30;
export function activeGoals(goals: (Pick<Goal, "text" | "state"> & { verifiedAt?: string | Date | null })[], ceiling: number = GOALS_CEILING): { goals: string[]; trimmed: number } {
  const at = (g: { verifiedAt?: string | Date | null }) => (g.verifiedAt ? Date.parse(String(g.verifiedAt instanceof Date ? g.verifiedAt.toISOString() : g.verifiedAt)) || 0 : 0);
  // Newest first; goals stamped the same moment keep the later-written first.
  const active = goals.map((g, i) => ({ g, i })).filter((x) => x.g.state === "active").sort((a, b) => at(b.g) - at(a.g) || b.i - a.i).map((x) => x.g.text);
  return { goals: active.slice(0, ceiling), trimmed: Math.max(0, active.length - ceiling) };
}

// Pure: the member's facts for the picker, from the shared layer. Only active goals are the lens; done and stale ones are
// history. Exchange stamps are in their zone. Nothing here strips: the layer already did.
export function factsFromKnowledge(k: MemberKnowledge): Facts {
  const zone = k.identity.timeZone;
  const stamp = (at: string, f: string) => DateTime.fromISO(at).setZone(zone).toFormat(f);
  const rules = memberRules(k);
  const learned = [
    // Only the corrected version exists (CO_GROUNDING): the old value isn't shown.
    ...k.corrections.map((c) => `Corrected ${c.field}: ${c.now ?? "(removed)"}`),
    ...k.lessons.map((l) => `Lesson: ${l.text}`),
    ...k.preferences.filter((p) => p.source !== "stated").map((p) => `Taste: ${p.text}`),
  ].slice(0, LIMITS.learned);
  const lens = activeGoals(k.goals);
  if (lens.trimmed) console.warn(`picker: ${lens.trimmed} active goal(s) over the ceiling of ${GOALS_CEILING} left out of the lens (oldest first)`);
  return {
    firstName: k.identity.firstName ?? "them",
    city: k.identity.city,
    zone,
    goals: lens.goals,
    ...(lens.trimmed ? { goalsTrimmed: lens.trimmed } : {}),
    goalsPast: pastGoals(k.goals),
    texts: k.exchanges
      .filter((e) => e.text.trim())
      .map((e, i) => ({ id: `T${i + 1}`, at: stamp(e.verifiedAt, "LLL d HH:mm"), from: e.from, text: e.text })),
    feeling: k.restraint?.feeling ?? null,
    delivered: k.delivered.slice(0, LIMITS.delivered).map((d, i) => ({ id: `D${i + 1}`, what: d.what, kind: d.kind, at: stamp(d.at, "LLL d"), reaction: d.reaction })),
    carrying: k.carrying.filter((c) => c.state !== "done" && !c.theyHaveIt).slice(0, LIMITS.carrying).map((c) => `${c.what} (${c.kind}${c.state === "due" ? ", due" : ""})`),
    learned,
    // What kind of room they've said they want (services/roomTaste.ts): its own section, ranked by, never buried in "learned".
    roomTaste: k.preferences.filter((p) => p.source === "stated").map((p) => p.text),
    person: k.person?.text ? k.person.text.slice(0, LIMITS.person) : null,
    // The member-level rules a picker acts on: grounding, other members' details, and this member's restraint.
    rules: [rules.grounding, rules.memberSafety, rules.restraint].filter(Boolean),
  };
}

// Everything else: recent texts, what Co sent first and whether they replied,
// how they reacted to suggestions, recent feelings, discovery left this week.
// opts.knowledge: the live read (see the header); null = the layer failed closed (no member facts). Left out: a replay as of `now`.
export async function loadMemberContext(q: Q, userId: string, now: Date, opts: { knowledge?: MemberKnowledge | null } = {}): Promise<MemberPart> {
  const live = "knowledge" in opts;
  // Their zone for every stamp: from the layer live; for a replay, their stored zone read through q (read only: memberZone may
  // write a derived zone). The fallback is memberTime.ts's, never a zone hard-coded here.
  const zone = live ? opts.knowledge?.identity.timeZone ?? wordsZone(null) : wordsZone((await q(`SELECT timezone FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => []))[0]?.timezone ?? null);
  // Another member's details stripped (2026-10-09 audit: the picker read raw texts). Fails closed: no strip, no texts.
  const safe = await import("./memberSafeMemories.js").then((m) => m.memberSafeLine(userId)).catch(() => null);
  const facts: Facts = live ? (opts.knowledge ? factsFromKnowledge(opts.knowledge) : { firstName: "them", city: null, zone, goals: [], texts: [], feeling: null }) : await factsAsOf(q, userId, now, zone, safe);
  const inbound = (await q(`SELECT created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User %' AND created_at < $2 AND created_at >= $2::timestamptz - INTERVAL '31 days'`, [userId, now])).map((r: any) => new Date(r.created_at).getTime());
  const sent = (await q(`SELECT sent_at, type, message FROM proactive_sends WHERE user_id = $1 AND sent_at < $2 AND sent_at >= $2::timestamptz - INTERVAL '30 days' ORDER BY sent_at`, [userId, now])).map((s: any, i: number) => {
    const t = new Date(s.sent_at).getTime();
    const replied = inbound.some((x: number) => x > t && x - t < 24 * 3_600_000 && x < now.getTime());
    // A match nudge's text names the other member: stripped like the texts (review of #118).
    return { id: `S${i + 1}`, at: DateTime.fromJSDate(new Date(s.sent_at)).setZone(zone).toFormat("LLL d"), what: `${s.type}: ${(safe ? safe(String(s.message ?? "")) ?? "" : "").replace(/\s+/g, " ")}`, reaction: replied ? "they replied within a day" : null };
  });
  const outcomes = (await q(`SELECT created_at, item_name, result, note, provenance FROM suggestion_outcomes WHERE user_id = $1 AND created_at < $2 ORDER BY created_at`, [userId, now])).map((o: any, i: number) => ({
    id: `O${i + 1}`,
    at: DateTime.fromJSDate(new Date(o.created_at)).setZone(zone).toFormat("LLL d"),
    item: safe ? safe(String(o.item_name)) ?? "another member" : "",
    // What they did, only as they stated it (services/provenance.ts).
    result: isDidResult(String(o.result)) && !isStated(o.provenance) ? `${o.result} (${UNCONFIRMED_RULE})` : String(o.result),
    note: o.note && safe ? safe(String(o.note)) : null,
    // They declined it, or said themselves that they did it: a record an "already known" reject may rest on. An unconfirmed result
    // may only drive a question, so it carries nothing.
    closes: String(o.result) === "declined" || (isDidResult(String(o.result)) && isStated(o.provenance)),
  }));
  const [{ n: discoverySent }] = await q(
    `SELECT COUNT(*)::int n FROM proactive_sends s JOIN proactive_candidates c ON c.id = s.candidate_id
     WHERE s.user_id = $1 AND s.sent_at < $2 AND s.sent_at >= $2::timestamptz - INTERVAL '7 days' AND (c.payload->>'fromProfile' = 'true' OR s.type = 'event_match_nudge')`,
    [userId, now],
  );
  return { ...facts, sent, outcomes, discoveryLeft: Math.max(0, 4 - Number(discoverySent ?? 0)) };
}

// The replay's read, as of `now`: only records created before it (the layer reads now, so it can't serve a past day).
async function factsAsOf(q: Q, userId: string, now: Date, zone: string, safe: ((s: string) => string | null) | null): Promise<Facts> {
  const [me] = await q(`SELECT u.first_name, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [userId]);
  const texts = (await q(`SELECT created_at, content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND created_at < $2 AND created_at >= $2::timestamptz - INTERVAL '14 days' ORDER BY created_at`, [userId, now])).map((t: any, i: number) => ({
    id: `T${i + 1}`,
    at: DateTime.fromJSDate(new Date(t.created_at)).setZone(zone).toFormat("LLL d HH:mm"),
    from: /^User/i.test(t.content) ? ("member" as const) : ("co" as const),
    text: safe ? (safe(String(t.content)) ?? "").replace(/^(User said|Co replied|User|Co):\s*/i, "") : "",
  })).filter((t: any) => t.text).map((t: any, i: number) => ({ ...t, id: `T${i + 1}` }));
  const feel = await q(`SELECT emotion, intensity, about FROM emotion_signals WHERE user_id = $1 AND created_at < $2 AND created_at >= $2::timestamptz - INTERVAL '3 days' AND COALESCE(target, 'life') = 'life' ORDER BY created_at DESC LIMIT 4`, [userId, now]).catch(() => [] as any[]);
  // Where they are headed: the lens every candidate is judged against alongside their asks (services/goalJourney.ts). No goal
  // states as of a past day exist, so the replay reads the goals on file.
  const [prof] = await q(`SELECT goals, intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const goals = (await import("./goalJourney.js")).goalTexts(prof?.intent, prof?.goals).slice(0, GOALS_CEILING);
  return {
    firstName: me?.first_name ?? "them",
    city: me?.city ?? null,
    zone,
    goals,
    texts,
    feeling: feel.length ? feel.map((f: any) => `${f.emotion} (${f.intensity})${f.about ? ` about ${f.about}` : ""}`).join("; ") : null,
  };
}

export function dayOf(now: Date, zone: string | null = null): { today: string; weekday: string } {
  const d = DateTime.fromJSDate(now).setZone(wordsZone(zone));
  return { today: d.toISODate()!, weekday: d.toFormat("cccc") };
}
