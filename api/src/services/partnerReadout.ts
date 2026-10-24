// The partner readout (Royce, 2026-10-05, November event set, item 3). One private note for the event's host after a
// Co event: how the room went, in aggregate. It says how many came, how many real conversations members told Co
// about, what the crowd was looking for (by category), and what landed.
//
// What it will not say:
//   - Anything one member told Co. No names, no emails, no phone numbers, no quotes, no one's ask in their words.
//     The only text about the crowd is a count per FIXED category (investors, hiring, ...), never free text.
//   - Anything small enough to point at a person. A count under 3 is shown as "a few", and a category with fewer
//     than 3 people is folded into "other".
//   - Anything about who talked to whom. "Which matches landed" is a count, never a pair.
// It has NO send path: sending it to the event host is paused (Royce, 2026-10-05). It is built on request and shown
// first, by src/scripts/partnerReadout.ts, which only previews.
import { isOpenAsk } from "../harness/profileWrite.js";
import pool from "../db/db.js";
import { escapeHtml, quietEmail } from "./emailDesign.js";
import { NO_MEMBER } from "./llmUsage.js";

// minRoom: a readout for fewer members than this would let the host work out who is behind any number.
// minOfferCoverage: "thin on" is a claim that nobody there offered something, so it needs Cue to know what most of the room can
// offer; below this share of members with a known offer it says nothing (silence over false signal, Royce 2026-10-14).
export const READOUT = { smallCell: 3, minForThemes: 8, minRoom: 6, minPeopleForConversations: 3, minOfferCoverage: 0.8 };

export const THEMES = ["Investors or funding", "Hiring or talent", "Cofounders or partners", "Customers or clients", "Advice or mentors", "Community or friends", "Venues or events", "Something else"] as const;
export type Theme = (typeof THEMES)[number];

// ---------------------------------------------------------------- rules (pure)

// A count that could point at a person is not shown as a number.
export function cell(n: number): string {
  return n <= 0 ? "none" : n < READOUT.smallCell ? "a few" : String(n);
}

// A headcount the host could subtract from the guest list: under 10 is only "fewer than 10"; otherwise rounded to 5.
export function approx(n: number): string {
  return n < 10 ? "fewer than 10" : `about ${Math.round(n / 5) * 5}`;
}

// Themes: counts per fixed category; one under the cell size is folded into "something else".
export function foldThemes(counts: Partial<Record<Theme, number>>): { theme: Theme; n: number }[] {
  const out = new Map<Theme, number>();
  let other = counts["Something else"] ?? 0;
  for (const t of THEMES) {
    if (t === "Something else") continue;
    const n = counts[t] ?? 0;
    if (n >= READOUT.smallCell) out.set(t, n);
    else other += n;
  }
  const rows = [...out.entries()].map(([theme, n]) => ({ theme, n })).sort((a, b) => b.n - a.n);
  if (other >= READOUT.smallCell) rows.push({ theme: "Something else", n: other });
  // A pattern that names nearly everyone's category tells the host each person's category: never shown.
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  if (rows.length < 2 || rows.some((r) => r.n >= total - 1)) return [];
  return rows;
}

// What the room was thin on (Royce, 2026-10-14: "Sparse rooms: never lower the bar, never force a match. Members get silence; the
// shortfall goes to the host read as what the room is thin on ('thin on investors', 'nobody offering design')"). A category is thin
// when at least READOUT.smallCell members looked for it and nobody in the room offered it. Categories only, never a member, never a
// count small enough to point at someone; "Something else" is never named. The member is the customer and the host is the channel:
// this is room-level signal, nothing more.
// It is only said when Cue knows what most of the room can offer (offerBacked below). On 2026-10-14 dev held 101 stated "looking
// for" asks against 2 stated offers: read from stated offers alone, nearly every category anyone asked for would have read as thin,
// investors standing in the room or not. Royce: "when Cue can't back a claim, it says nothing. Silence over false signal."
export function thinOn(sought: Partial<Record<Theme, number>>, offered: Partial<Record<Theme, number>>): Theme[] {
  return THEMES.filter((t) => t !== "Something else" && (sought[t] ?? 0) >= READOUT.smallCell && (offered[t] ?? 0) === 0);
}

// Whether "nobody offered it" is backed: Cue knows at least one thing each of most of the room can offer.
export function offerBacked(offerKnown: number, offerPool: number): boolean {
  return offerPool > 0 && offerKnown / offerPool >= READOUT.minOfferCoverage;
}

export type Stats = {
  eventName: string;
  registered: number;
  arrived: number;
  walkins: number;
  briefs: number;
  nudged: number;
  interested: number;
  intros: number;
  debriefReplies: number;
  metSomeone: number;
  conversationsTold: number;
  followThroughMembers: number;
  themes: Partial<Record<Theme, number>>;
  askCount: number;
  // What members can offer, by the same fixed categories (people per category): read only to find what the room was thin on.
  // offerKnown of offerPool members have at least one known offer (a stated offer, or one Cue's people graph holds for them).
  offerThemes?: Partial<Record<Theme, number>>;
  offerKnown?: number;
  offerPool?: number;
};

export function describe(s: Stats): { headline: string; lines: string[]; note: string } {
  const note = "This is the room in aggregate. It carries nothing any member told Cue, and nothing about who talked to whom. Small counts are shown as a few, and headcounts are rounded.";
  if (s.registered < READOUT.minRoom) {
    return { headline: `How ${s.eventName} went`, lines: ["This room was too small to read out without pointing at individual members, so there is no readout for it."], note };
  }
  const lines: string[] = [];
  lines.push(`${approx(s.registered)} members were registered and ${approx(s.arrived)} arrived through Cue${s.walkins ? `, plus ${cell(s.walkins)} who checked in at the door` : ""}.`);
  if (s.nudged) lines.push(`Cue pointed ${cell(s.nudged)} members to someone to meet, and ${cell(s.interested)} said they wanted the connection.`);
  if (s.debriefReplies) lines.push(`Of the members who told Cue how it went, ${cell(s.metSomeone)} said they met someone worth knowing${s.followThroughMembers >= READOUT.minPeopleForConversations ? `, and ${cell(s.conversationsTold)} people were named across what members told Cue` : ""}.`);
  if (s.intros) lines.push(`${cell(s.intros)} introductions went out after both people said yes.`);
  const themes = s.askCount >= READOUT.minForThemes ? foldThemes(s.themes) : [];
  if (themes.length) lines.push(`What the room was looking for, by category: ${themes.map((t) => `${t.theme.toLowerCase()} (${t.n})`).join(", ")}.`);
  else lines.push(`Too few members shared what they were looking for to show a pattern without pointing at anyone.`);
  // Only a category the themes line itself may show (foldThemes): when the pattern would point at nearly everyone, "thin on" would
  // say the same thing the line above just held back (review of #208).
  const shown = new Set(themes.map((t) => t.theme));
  const thin = s.askCount >= READOUT.minForThemes && offerBacked(s.offerKnown ?? 0, s.offerPool ?? 0) ? thinOn(s.themes, s.offerThemes ?? {}).filter((t) => shown.has(t)) : [];
  if (thin.length) lines.push(`The room was thin on: ${thin.map((t) => t.toLowerCase()).join(", ")}. Several members looked for it and nobody there offered it.`);
  return { headline: `How ${s.eventName} went`, lines, note };
}

export function renderHtml(s: Stats): string {
  const d = describe(s);
  return quietEmail({ preview: `${d.headline}: the room, in aggregate`, headline: escapeHtml(d.headline), lines: d.lines.map(escapeHtml), note: escapeHtml(d.note), signOff: true });
}

export function renderText(s: Stats): string {
  const d = describe(s);
  return [d.headline, "", ...d.lines, "", d.note].join("\n");
}

// ---------------------------------------------------------------- data: counts only

async function count(sql: string, params: unknown[]): Promise<number> {
  // A failed read throws: a readout with silent zeros would look confident and be wrong.
  const { rows } = await pool.query(sql, params);
  return Number(rows[0]?.n ?? 0);
}

export type Side = "seeks" | "offers";

export async function classifyAsks(asks: string[], classify: (ask: string, side?: Side) => Promise<Theme>, side: Side = "seeks"): Promise<Partial<Record<Theme, number>>> {
  const out: Partial<Record<Theme, number>> = {};
  for (const a of asks) {
    const t = await classify(a, side).catch(() => "Something else" as Theme);
    const theme: Theme = (THEMES as readonly string[]).includes(t) ? t : "Something else";
    out[theme] = (out[theme] ?? 0) + 1;
  }
  return out;
}

// One ask, one fixed label. The model sees the ask and returns a label from the list; nothing it says is kept.
export async function themeOfAsk(ask: string, side: Side = "seeks"): Promise<Theme> {
  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { MODELS } = await import("../models.js");
  const { text } = await generateText({
    model: anthropic(MODELS.haiku),
    // Not about one member: a room-level theme for the host read.
    experimental_telemetry: { isEnabled: true, functionId: "agent.partnerReadout.theme", recordInputs: false, recordOutputs: false, metadata: NO_MEMBER },
    prompt: `Label what this person ${side === "offers" ? "can offer others" : "is looking for"} with exactly one of: ${THEMES.join(" | ")}.\n\n"${ask.slice(0, 400)}"\n\nReturn ONLY the label.`,
  });
  const t = text.trim().replace(/^["']|["'.]+$/g, "");
  return ((THEMES as readonly string[]).includes(t) ? t : "Something else") as Theme;
}

export async function gatherStats(eventId: string, eventName: string, classify: (ask: string, side?: Side) => Promise<Theme> = themeOfAsk, membersOf?: (eventId: string) => Promise<{ user_id: string }[]>): Promise<Stats> {
  const { eventMembers } = await import("./eventPresence.js");
  const members = await (membersOf ?? eventMembers)(eventId);
  const ids = members.map((m) => m.user_id);
  const [arrived, walkins, briefs, nudged, interested, intros, debriefReplies, metSomeone, conversationsTold, followThroughMembers] = await Promise.all([
    count(`SELECT COUNT(*)::int AS n FROM event_presence WHERE event_api_id = $1 AND arrived_at IS NOT NULL AND user_id = ANY($2::uuid[])`, [eventId, ids]),
    count(`SELECT COUNT(*)::int AS n FROM event_walkin_checkins WHERE event_api_id = $1`, [eventId]),
    count(`SELECT COUNT(*)::int AS n FROM event_briefs WHERE event_id = $1`, [eventId]),
    count(`SELECT COUNT(*)::int AS n FROM event_guest_match_nudges WHERE event_id = $1 AND pending = false`, [eventId]),
    count(`SELECT COUNT(DISTINCT person_id)::int AS n FROM event_guest_match_opt_ins WHERE event_id = $1 AND status = 'interested'`, [eventId]),
    // Introductions: pairs where both people said yes at this event (by event id, not by name).
    count(`SELECT (COUNT(*) / 2)::int AS n FROM event_guest_match_opt_ins a JOIN event_guest_match_opt_ins b ON b.event_id = a.event_id AND b.person_id = a.candidate_id AND b.candidate_id = a.person_id WHERE a.event_id = $1 AND a.status = 'interested' AND b.status = 'interested'`, [eventId]),
    count(`SELECT COUNT(*)::int AS n FROM co_memories WHERE memory_type = 'event_checkin_outcome' AND CASE WHEN content LIKE '{%' THEN content::jsonb ->> 'eventApiId' END = $1`, [eventId]),
    count(`SELECT COUNT(*)::int AS n FROM co_memories WHERE memory_type = 'event_checkin_outcome' AND CASE WHEN content LIKE '{%' THEN content::jsonb ->> 'eventApiId' END = $1 AND CASE WHEN content LIKE '{%' THEN content::jsonb ->> 'outcome' END = 'named_positive'`, [eventId]),
    count(`SELECT COALESCE(SUM(people_count), 0)::int AS n FROM event_follow_throughs WHERE event_id = $1`, [eventId]),
    count(`SELECT COUNT(*)::int AS n FROM event_follow_throughs WHERE event_id = $1`, [eventId]),
  ]);
  // What the room was looking for: each attendee's own ask, read only to put it in a fixed category.
  let asks: string[] = [];
  // What each attendee can offer: their stated offer and the offers Cue's people graph holds for them (co_facts 'offers',
  // services/peopleGraph.ts), read only to put each in a fixed category.
  const offersBy = new Map<string, string[]>();
  if (ids.length) {
    const [{ rows }, graph] = await Promise.all([
      pool.query(`SELECT user_id, intent FROM co_profiles WHERE user_id = ANY($1::uuid[])`, [ids]),
      pool.query(`SELECT owner_user_id, object_label FROM co_facts WHERE owner_user_id = ANY($1::uuid[]) AND relation = 'offers' AND retired_at IS NULL`, [ids]),
    ]);
    const addOffer = (id: string, text: string) => offersBy.set(id, [...(offersBy.get(id) ?? []), text].slice(0, 3));
    for (const r of rows) {
      const intent = Array.isArray(r.intent) ? r.intent : [];
      const open = intent.filter((i: any) => isOpenAsk(i) && i?.type === "seeking"); // an ask, never a goal
      if (open.length) asks.push(String(open[open.length - 1].text));
      const offering = intent.filter((i: any) => isOpenAsk(i) && i?.type === "offering");
      if (offering.length && r.user_id) addOffer(String(r.user_id), String(offering[offering.length - 1].text));
    }
    for (const g of graph.rows) if (g.owner_user_id && g.object_label) addOffer(String(g.owner_user_id), String(g.object_label));
  }
  const themes = asks.length >= READOUT.minForThemes ? await classifyAsks(asks, classify) : {};
  // People per offered category (one person offering two investor things counts once). Only labelled when the line could be said.
  const offerKnown = offersBy.size;
  const offerThemes: Partial<Record<Theme, number>> = {};
  if (asks.length >= READOUT.minForThemes && offerBacked(offerKnown, ids.length)) {
    for (const texts of offersBy.values()) {
      const mine = new Set(Object.keys(await classifyAsks(texts, classify, "offers")) as Theme[]);
      for (const t of mine) offerThemes[t] = (offerThemes[t] ?? 0) + 1;
    }
  }
  return { eventName, registered: members.length, arrived, walkins, briefs, nudged, interested, intros, debriefReplies, metSomeone, conversationsTold, followThroughMembers, themes, askCount: asks.length, offerThemes, offerKnown, offerPool: ids.length };
}
