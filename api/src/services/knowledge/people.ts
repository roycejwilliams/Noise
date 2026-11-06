// The people section of the member picture (Cue Memory Spec step 4, 2026-11-06): the people this member has been put in touch with, or said they
// already know, seen from THEIR side only. Opt-in (memberKnowledge include: ["people"]); not rendered into any prompt yet (step 6).
//
// Royce's rulings, which are the contract of this file:
//   - Own side only. Every query is bound to the member's id ($1) and reads only that member's side of a record (their answer, their
//     outcome, their note). The other member's answer, asks, value lines, match reasons and what Cue knows about them are never read, so
//     they cannot come out.
//   - A name only after a double yes. A person's name shows when both members agreed to the intro (a co_pairs row with both yeses, an
//     intro sent, mutual event opt-ins), or the network intro is both_interested / introduced, or a member_connections row exists
//     (it is written only after both said yes). This is the introduced / both-interested part of NETWORK_NAMES_SQL and MEMBER_NAMES_SQL
//     (services/memberSafeMemories.ts), made stricter: those lists also name a person on THIS member's own yes alone, here a one-sided
//     yes stays nameless. Before a double yes the person is "someone you were matched with at <event>".
//   - Private knowledge is never permission to share it in an intro: nothing about the other person except the name and how this member
//     is connected to them is ever carried.
//   - Silence is not rejection. A suggestion nobody answered is "suggested, no answer yet", never a decline. "declined_by_you" is only
//     their own no. When the other side said no, the stage is "closed" and says nothing about whose it was.
//   - No hidden dossiers: a person is here only if this member knows of them (the ask reached them, they asked for the intro, an intro
//     went out, or they said they already know them).
//
// Guards: the same as the transitions section (services/memberKnowledge.ts): the member's removals and corrections (whatCoKnows
// guardText) over every word of theirs, a removed record dropped whole, the name strip over everything except a consented name, and
// fail closed (guards unread -> nothing). Read only; no model call.
import { createHash } from "node:crypto";
import pool from "../../db/db.js";
import type { Fact } from "../memberKnowledge.js";
import { nameFinder, namelessHistoryLine } from "../memberSafeMemories.js";
import type { ForgottenRow } from "../whatCoKnows.js";

// How this member is connected to the person.
export type PersonHow = "matched_at_event" | "intro_via_network" | "asked_for_intro" | "already_knew" | "connected";
// Where it stands, from their side.
export type PersonStage =
  | "suggested_no_answer" // Cue suggested them; no answer from this member. Never a decline.
  | "asked_for_intro" // this member asked for the intro; nothing made yet
  | "said_yes_no_answer_yet" // this member said yes; the other side hasn't answered (or the night ended first)
  | "declined_by_you" // this member's own no
  | "closed" // it didn't go forward and this says nothing about why or whose
  | "both_yes" // both agreed; the intro is on its way
  | "introduced"
  | "met"
  | "already_knew";
export type PersonOutcome = {
  // The day of THEIR latest word (their own evidence times); null when none carries a time. Never the pair's shared timestamps.
  on: string | null;
  // Their own words about it (co_pairs <side>_outcome_note), or null.
  quote: string | null;
  met: "yes" | "no" | null;
  useful: "yes" | "somewhat" | "no" | null;
  keptTalking: "yes" | "not_yet" | "no" | null;
};
export type Person = {
  // The forgetting ref where there is one ("pair:<id>:<side>", "knows:<id>"), else an opaque hash. Never a user id.
  id: string;
  how: PersonHow;
  stage: PersonStage;
  // The event name, for a match made at one (the member's own event).
  where: string | null;
  // The first name, ONLY after a double yes; null before. memberKnowledge's name strip leaves this one field alone.
  personName: string | null;
  // The line a reader may use as is: nameless, whatever the stage.
  description: string;
  outcome: PersonOutcome | null;
  // Derived from what they STATED about the meeting (useful yes -> yes, useful no -> no); null when they haven't said. Never from silence.
  moreLikeThem: "yes" | "no" | null;
  // Their own words that said they already know this person (kind already_knew), else null.
  quote: string | null;
};

// The section's size: as many as fit in this many characters, in-flight first then newest; the rest counted, never silently dropped.
export const PEOPLE_BUDGET_CHARS = 3000;
const CLIP = 300;

type Side = Partial<Record<"met" | "useful" | "kept_talking", { value?: string; at?: string; how?: string }>>;
export type RawPerson = {
  // The forget ref or an opaque id (see Person.id).
  id: string;
  kind: "pair" | "network" | "optin" | "connection" | "knows" | "request";
  at: Date;
  eventName: string | null;
  // The first name, given by the loader only on a double yes (and re-checked by the builder).
  firstName: string | null;
  doubleYes: boolean;
  // The other person's user id: used only to line up this member's own records of the same person. Never output.
  otherKey: string | null;
  // This member's own answer ("yes" / "no" / null), whether the ask reached them, whether they asked, the intro went out, and how it
  // ended if it did: "declined" (somebody's no, or a block after the ask; never says whose) or "expired" (the night ended unanswered).
  mine: "yes" | "no" | null;
  reached: boolean;
  memberAsked: boolean;
  introduced: boolean;
  ended: "declined" | "expired" | null;
  // Their side of the outcome record (co_pairs <side>_evidence / _outcome / _outcome_note), never the other side's.
  evidence: Side;
  outcome: string | null;
  note: string | null;
  // The network intro's pair record (co_pairs event_id 'network'): shown as a network intro, and it replaces the network_introductions row.
  viaNetwork: boolean;
  // knows: the words that said it.
  quote: string | null;
};

const rows = (q: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> }, sql: string, userId: string) => q.query(sql, [userId]).then((r) => r.rows as any[]);
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const dateOrNull = (x: unknown) => (x ? new Date(x as string) : null);
const empty = (): Omit<RawPerson, "id" | "kind" | "at" | "eventName" | "firstName" | "doubleYes" | "otherKey"> => ({ mine: null, reached: false, memberAsked: false, introduced: false, ended: null, evidence: {}, outcome: null, note: null, viaNetwork: false, quote: null });

// One member's people: every query takes the member's id as the bound $1, never in the text, and picks only THEIR side of a record.
// The other person's first name is selected only where the double yes is already true in the SQL itself.
export async function loadPeople(userId: string, q: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<RawPerson[]> {
  const [pairs, nets, optins, conns, knows, reqs] = await Promise.all([
    // co_pairs: their side. reached = the ask got to them (or they asked); the other side's answer is used only to say both yeses.
    rows(
      q,
      `WITH mine AS (
         SELECT p.*, CASE WHEN p.a_id = $1 THEN 'a' ELSE 'b' END AS side, CASE WHEN p.a_id = $1 THEN p.b_id ELSE p.a_id END AS other_id,
                CASE WHEN p.a_id = $1 THEN p.a_answer ELSE p.b_answer END AS my_answer,
                CASE WHEN p.a_id = $1 THEN p.a_answered_at ELSE p.b_answered_at END AS my_answered_at,
                -- The pair THEIR OWN by-name request created (same person, same event): it is shown as that request, never as a pair, until a double yes.
                EXISTS (SELECT 1 FROM intro_requests r WHERE r.user_id = $1 AND r.target_id = CASE WHEN p.a_id = $1 THEN p.b_id ELSE p.a_id END AND r.event_id IS NOT DISTINCT FROM p.event_id) AS from_my_request,
                CASE WHEN p.a_id = $1 THEN p.asked_a_at ELSE p.asked_b_at END AS my_asked_at,
                CASE WHEN p.a_id = $1 THEN p.a_evidence ELSE p.b_evidence END AS my_evidence,
                CASE WHEN p.a_id = $1 THEN p.a_outcome ELSE p.b_outcome END AS my_outcome,
                CASE WHEN p.a_id = $1 THEN p.a_outcome_note ELSE p.b_outcome_note END AS my_note,
                (p.intro_sent_at IS NOT NULL OR p.both_yes_at IS NOT NULL OR (p.a_answer = 'yes' AND p.b_answer = 'yes') OR p.state IN ('both_yes', 'intro_sent', 'met')) AS double_yes
         FROM co_pairs p WHERE p.a_id = $1 OR p.b_id = $1
       )
       SELECT m.id, m.side, m.other_id, m.origin, m.state, m.my_answer, m.my_answered_at, m.from_my_request, m.event_id, m.both_yes_at, m.my_asked_at, m.my_evidence, m.my_outcome, m.my_note, m.double_yes,
              m.intro_sent_at, m.declined_at, m.expired_at, m.created_at, c.event_name,
              CASE WHEN m.double_yes THEN u.first_name END AS first_name
       FROM mine m LEFT JOIN event_room_closures c ON c.event_id = m.event_id LEFT JOIN users u ON u.id = m.other_id
       WHERE m.double_yes OR (m.my_asked_at IS NOT NULL AND NOT m.from_my_request)
       ORDER BY m.created_at DESC`,
      userId,
    ),
    // network_introductions: their own interest time only. A row they never answered and that is not made yet isn't one they know of.
    rows(
      q,
      `WITH mine AS (
         SELECT n.status, n.created_at, n.introduced_at, CASE WHEN n.person_a_id = $1 THEN n.person_b_id ELSE n.person_a_id END AS other_id,
                CASE WHEN n.person_a_id = $1 THEN n.a_interested_at ELSE n.b_interested_at END AS my_interested_at,
                (n.status IN ('introduced', 'both_interested') OR (n.a_interested_at IS NOT NULL AND n.b_interested_at IS NOT NULL)) AS double_yes
         FROM network_introductions n WHERE n.person_a_id = $1 OR n.person_b_id = $1
       )
       SELECT m.other_id, m.status, m.created_at, m.introduced_at, m.my_interested_at, m.double_yes, CASE WHEN m.double_yes THEN u.first_name END AS first_name
       FROM mine m LEFT JOIN users u ON u.id = m.other_id
       WHERE m.double_yes OR m.my_interested_at IS NOT NULL
       ORDER BY COALESCE(m.introduced_at, m.my_interested_at, m.created_at) DESC`,
      userId,
    ),
    // event_guest_match_opt_ins older than co_pairs: only pairs that have no co_pairs row for that event. Their own answer; mutual interest is a double yes.
    rows(
      q,
      `SELECT o.event_id, o.candidate_id AS other_id, o.status, o.decided_at, c.event_name,
              EXISTS (SELECT 1 FROM event_guest_match_opt_ins r WHERE r.event_id = o.event_id AND r.person_id = o.candidate_id AND r.candidate_id = o.person_id AND r.status = 'interested' AND o.status = 'interested') AS double_yes,
              CASE WHEN o.status = 'interested' AND EXISTS (SELECT 1 FROM event_guest_match_opt_ins r WHERE r.event_id = o.event_id AND r.person_id = o.candidate_id AND r.candidate_id = o.person_id AND r.status = 'interested') THEN u.first_name END AS first_name
       FROM event_guest_match_opt_ins o LEFT JOIN event_room_closures c ON c.event_id = o.event_id LEFT JOIN users u ON u.id = o.candidate_id
       WHERE o.person_id = $1
         AND NOT EXISTS (SELECT 1 FROM co_pairs p WHERE p.event_id = o.event_id AND ((p.a_id = o.person_id AND p.b_id = o.candidate_id) OR (p.a_id = o.candidate_id AND p.b_id = o.person_id)))
       ORDER BY o.decided_at DESC`,
      userId,
    ),
    // member_connections is written only after both said yes. Left out when the intro is already a co_pairs / network row.
    rows(
      q,
      `SELECT x.created_at, x.other_id, u.first_name FROM (
         SELECT mc.created_at, CASE WHEN mc.person_a = $1 THEN mc.person_b ELSE mc.person_a END AS other_id FROM member_connections mc WHERE mc.person_a = $1 OR mc.person_b = $1
       ) x LEFT JOIN users u ON u.id = x.other_id
       WHERE NOT EXISTS (SELECT 1 FROM co_pairs p WHERE p.intro_sent_at IS NOT NULL AND ((p.a_id = $1 AND p.b_id = x.other_id) OR (p.a_id = x.other_id AND p.b_id = $1)))
         AND NOT EXISTS (SELECT 1 FROM network_introductions n WHERE n.status IN ('introduced', 'both_interested') AND ((n.person_a_id = $1 AND n.person_b_id = x.other_id) OR (n.person_a_id = x.other_id AND n.person_b_id = $1)))
       ORDER BY x.created_at DESC`,
      userId,
    ),
    // Someone they said they already know: their own words, their own row.
    rows(
      q,
      `SELECT id, happened_at, meta->>'quote' AS quote, meta->>'otherId' AS other_id FROM co_facts WHERE owner_user_id = $1 AND relation = 'already_knows' AND retired_at IS NULL ORDER BY happened_at DESC`,
      userId,
    ),
    // Intros they asked for by name: whether the person was found is never carried (found / not-found results don't leak), so no target and no name.
    rows(
      q,
      `SELECT r.id, r.asked_at, r.event_id, c.event_name FROM intro_requests r LEFT JOIN event_room_closures c ON c.event_id = r.event_id
       WHERE r.user_id = $1
         AND (r.target_id IS NULL OR (
           NOT EXISTS (SELECT 1 FROM co_pairs p WHERE p.event_id IS NOT DISTINCT FROM r.event_id AND ((p.a_id = $1 AND p.b_id = r.target_id) OR (p.a_id = r.target_id AND p.b_id = $1))
                         AND (p.intro_sent_at IS NOT NULL OR p.both_yes_at IS NOT NULL OR (p.a_answer = 'yes' AND p.b_answer = 'yes') OR p.state IN ('both_yes', 'intro_sent', 'met')))
           AND NOT EXISTS (SELECT 1 FROM network_introductions n WHERE n.status IN ('introduced', 'both_interested') AND ((n.person_a_id = $1 AND n.person_b_id = r.target_id) OR (n.person_a_id = r.target_id AND n.person_b_id = $1)))))
       ORDER BY r.asked_at DESC`,
      userId,
    ),
  ]);
  const out: RawPerson[] = [];
  for (const r of pairs) {
    const evidence: Side = r.my_evidence && typeof r.my_evidence === "object" ? r.my_evidence : {};
    const doubleYes = !!r.double_yes;
    // Only THEIR side's times until both agreed; the pair's updated_at, met_at and outcome_at are shared and move when the other side acts.
    const own = [r.my_asked_at, r.my_answered_at, ...Object.values(evidence).map((e) => e?.at), ...(doubleYes ? [r.both_yes_at, r.intro_sent_at] : [])].map(dateOrNull).filter((d): d is Date => !!d && !Number.isNaN(d.getTime()));
    const at = own.length ? new Date(Math.max(...own.map((d) => d.getTime()))) : new Date(r.created_at);
    out.push({
      ...empty(),
      id: `pair:${r.id}:${r.side === "a" ? "a" : "b"}`,
      kind: "pair",
      at,
      eventName: r.event_id === "network" ? null : r.event_name ?? null,
      firstName: doubleYes ? (r.first_name ?? null) : null,
      doubleYes,
      otherKey: r.other_id ? String(r.other_id) : null,
      mine: r.my_answer === "yes" || r.my_answer === "no" ? r.my_answer : null,
      reached: !!r.my_asked_at,
      memberAsked: false,
      introduced: doubleYes && !!r.intro_sent_at,
      ended: r.declined_at || r.state === "declined" || r.state === "blocked" ? "declined" : r.state === "expired" || r.expired_at ? "expired" : null,
      evidence,
      outcome: r.my_outcome ?? null,
      note: r.my_note ?? null,
      viaNetwork: r.event_id === "network",
    });
  }
  // A network intro made also has a co_pairs row (event_id 'network'): one person, one entry (the pair's, which carries the outcome).
  const viaPair = new Set(out.filter((p) => p.kind === "pair" && p.viaNetwork && p.otherKey).map((p) => p.otherKey!));
  for (const r of nets) {
    const other = String(r.other_id);
    if (viaPair.has(other)) continue;
    out.push({
      ...empty(),
      id: `net:${hash(`${userId}:${other}`)}`,
      kind: "network",
      at: new Date(r.double_yes ? (r.introduced_at ?? r.my_interested_at ?? r.created_at) : r.my_interested_at),
      eventName: null,
      firstName: r.double_yes ? (r.first_name ?? null) : null,
      doubleYes: !!r.double_yes,
      otherKey: other,
      mine: r.my_interested_at ? "yes" : null,
      reached: !!r.my_interested_at || !!r.double_yes,
      introduced: r.status === "introduced",
      ended: r.status === "declined" ? "declined" : null,
    });
  }
  for (const r of optins) {
    const other = String(r.other_id);
    out.push({
      ...empty(),
      id: `optin:${hash(`${userId}:${r.event_id}:${other}`)}`,
      kind: "optin",
      at: new Date(r.decided_at),
      eventName: r.event_name ?? null,
      firstName: r.double_yes ? (r.first_name ?? null) : null,
      doubleYes: !!r.double_yes,
      otherKey: other,
      mine: r.status === "interested" ? "yes" : r.status === "declined" ? "no" : null,
      reached: true,
    });
  }
  for (const r of conns) {
    const other = String(r.other_id);
    out.push({ ...empty(), id: `conn:${hash(`${userId}:${other}`)}`, kind: "connection", at: new Date(r.created_at), eventName: null, firstName: r.first_name ?? null, doubleYes: true, otherKey: other, introduced: true, reached: true });
  }
  for (const r of knows) {
    out.push({ ...empty(), id: `knows:${r.id}`, kind: "knows", at: new Date(r.happened_at), eventName: null, firstName: null, doubleYes: false, otherKey: r.other_id ? String(r.other_id) : null, quote: r.quote ? String(r.quote) : null });
  }
  for (const r of reqs) {
    out.push({ ...empty(), id: `ask:${String(r.id)}`, kind: "request", at: new Date(r.asked_at), eventName: null, firstName: null, doubleYes: false, otherKey: null, memberAsked: true, reached: true });
  }
  return out;
}

// ---------------------------------------------------------------- pure: the stage, the outcome, the nameless line

const day = (d: Date) => d.toISOString().slice(0, 10);
const clip = (x: string) => (x.length > CLIP ? x.slice(0, CLIP) : x);

// Pure: where this stands from their side. Silence is not rejection: only their own no is "declined_by_you".
export function stageOf(r: RawPerson): PersonStage {
  if (r.kind === "knows") return "already_knew";
  if (r.kind === "request") return "asked_for_intro";
  // Their own by-name request stays "asked" until both said yes, whether the person was found, asked, or said no (ruling #294).
  if (r.memberAsked && !r.doubleYes) return "asked_for_intro";
  if (r.mine === "no") return "declined_by_you";
  // Only THEIR own word that they met (the pair's met_at is set by either side's report).
  const metYes = r.evidence.met?.value === "yes";
  if (r.introduced) return metYes ? "met" : "introduced";
  if (r.doubleYes) return "both_yes";
  if (r.ended === "declined") return "closed";
  if (r.mine === "yes") return "said_yes_no_answer_yet";
  if (r.memberAsked) return "asked_for_intro";
  // An unanswered suggestion, including one the night ended on, is not a no.
  return "suggested_no_answer";
}

function howOf(r: RawPerson): PersonHow {
  if (r.kind === "pair" && r.viaNetwork) return r.memberAsked && !r.doubleYes ? "asked_for_intro" : "intro_via_network";
  if (r.kind === "pair" || r.kind === "optin") return r.memberAsked && !r.doubleYes ? "asked_for_intro" : "matched_at_event";
  if (r.kind === "network") return "intro_via_network";
  if (r.kind === "knows") return "already_knew";
  if (r.kind === "request") return "asked_for_intro";
  return "connected";
}

// Pure: the nameless line. The name, when it is shown, is its own field.
export function descriptionOf(how: PersonHow, where: string | null): string {
  const at = where ? ` at ${where}` : "";
  if (how === "matched_at_event") return `someone you were matched with${at}`;
  if (how === "intro_via_network") return "someone Cue suggested from the network";
  if (how === "asked_for_intro") return `someone you asked to be introduced to${at}`;
  if (how === "already_knew") return "someone you told me you already know";
  return "someone you were introduced to";
}

const oneOf = <T extends string>(v: unknown, set: readonly T[]): T | null => (typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null);

function outcomeOf(r: RawPerson, note: string | null): { outcome: PersonOutcome | null; more: "yes" | "no" | null } {
  const ev = r.evidence;
  const met = oneOf(ev.met?.value, ["yes", "no"] as const);
  const useful = oneOf(ev.useful?.value, ["yes", "somewhat", "no"] as const);
  const kept = oneOf(ev.kept_talking?.value, ["yes", "not_yet", "no"] as const);
  const times = [ev.met?.at, ev.useful?.at, ev.kept_talking?.at].flatMap((t) => (t && !Number.isNaN(new Date(t).getTime()) ? [new Date(t)] : []));
  const on = times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
  if (!met && !useful && !kept && !note) return { outcome: null, more: null };
  const usefulStated = ev.useful?.how === "stated" ? useful : r.outcome === "met_good" ? "yes" : r.outcome === "met_not_a_fit" ? "no" : null;
  return {
    outcome: { on: on ? day(on) : null, quote: note, met, useful, keptTalking: kept },
    more: usefulStated === "yes" ? "yes" : usefulStated === "no" ? "no" : null,
  };
}

// Pure: a sentence that names a member with no double yes becomes the details-free, nameless history line (the snapshot's policy,
// memberSnapshot.ts), not memberSafeMemories' "<Name>, another member, came up here", which would say the name out loud.
function nameless(text: string, find: (s: string) => string | null): string | null {
  const seen = new Set<string>();
  const out = text
    .split(/(?<=[.!?])\s+|;\s*/)
    .map((sentence) => {
      if (!find(sentence)) return sentence;
      const h = namelessHistoryLine(sentence);
      if (seen.has(h)) return "";
      seen.add(h);
      return h;
    })
    .filter((x) => x.trim())
    .join(" ");
  return out.trim() || null;
}

export type PeopleGuards = {
  // guardText over a string of theirs (whatCoKnows): null when the removed thing is all there is.
  g: (t: string) => string | null;
  removed: ForgottenRow[];
  // Every name of a member linked to this one (memberNamesStrict): stripped everywhere except a consented name.
  linked: string[];
};

// Pure: the section. Raw rows in, guarded and stripped, ranked and cut to the budget. A name is carried only when the row itself says
// double yes AND has a first name; everything else is nameless, and every free-text field is stripped of every linked name that
// has no double yes (a consented name in their own words is theirs and kept).
export function buildPeople(raw: RawPerson[], guards: PeopleGuards, budget: number = PEOPLE_BUDGET_CHARS): { items: Fact<Person>[]; omitted: number } {
  const lower = (s: string) => s.trim().toLowerCase();
  const consented = new Set(raw.filter((r) => r.doubleYes && r.firstName?.trim()).map((r) => lower(r.firstName!)));
  const strangers = [...new Set(guards.linked.map((n) => n.trim()).filter((n) => n.length >= 2 && !consented.has(lower(n))))];
  const find = nameFinder(strangers);
  const clean = (t: string | null | undefined): string | null => {
    if (!t || !t.trim()) return null;
    const kept = guards.g(t);
    if (kept === null || !kept.trim()) return null;
    return nameless(clip(kept.trim()), find);
  };
  // The first name of each consented person, by their user id, so "told me I already know them" can carry the name once there is a yes.
  const named = new Map(raw.filter((r) => r.doubleYes && r.firstName?.trim() && r.otherKey).map((r) => [r.otherKey!, r.firstName!.trim()]));
  const gone = (id: string) => guards.removed.some((x) => x.ref === id);
  const built = raw
    // A removed "knows:<id>" is that person gone whole. A removed "pair:<id>:<side>" is their outcome only (whatCoKnows clears it at its
    // source too): the connection itself stays, without the outcome.
    .filter((r) => !(r.kind === "knows" && gone(r.id)) && !Number.isNaN(r.at.getTime()))
    .flatMap((r0): { p: Fact<Person>; live: boolean; rank: number }[] => {
      const outcomeRemoved = gone(r0.id);
      const r: RawPerson = outcomeRemoved ? { ...r0, evidence: {}, note: null, outcome: null } : r0;
      const name = r.doubleYes && r.firstName?.trim() ? r.firstName.trim() : r.kind === "knows" && r.otherKey ? (named.get(r.otherKey) ?? null) : null;
      // A person they asked Cue to forget by name is gone whole.
      if (name && guards.g(name) !== name) return [];
      const how = howOf(r);
      const stage = stageOf(r);
      // Their own outcome words survive only through the guards; a removed outcome (pair:<id>:<side>) is gone, evidence and words.
      const note = r.kind === "pair" ? clean(r.note) : null;
      const { outcome, more } = r.kind === "pair" ? outcomeOf(r, note) : { outcome: null, more: null };
      const quote = r.kind === "knows" ? clean(r.quote) : null;
      const where = r.eventName ? clean(r.eventName) : null;
      const live = stage === "suggested_no_answer" || stage === "said_yes_no_answer_yet" || stage === "both_yes" || stage === "asked_for_intro";
      return [
        {
          live,
          rank: r.at.getTime(),
          p: { id: r.id, how, stage, where, personName: name, description: descriptionOf(how, where), outcome, moreLikeThem: more, quote, verifiedAt: r.at.toISOString() },
        },
      ];
    })
    .sort((a, b) => Number(b.live) - Number(a.live) || b.rank - a.rank);
  const items: Fact<Person>[] = [];
  let used = 0;
  for (const { p } of built) {
    const size = JSON.stringify(p).length;
    if (used + size > budget) continue;
    items.push(p);
    used += size;
  }
  return { items, omitted: built.length - items.length };
}
