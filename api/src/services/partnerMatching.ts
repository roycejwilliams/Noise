// Guests in matching at a partner night (Royce, 2026-10-14: "Matching must include guest profiles; today non-members are
// dropped before scoring"). The partner-room spec's step 3 starts here: who in the room is worth whom.
//
// A Co event's room is eventScoring.inRoomPool: Luma guests and walk-ins who are members, joined through co_profiles, so a
// non-member never reaches the scorer. A partner night has no Luma list and most of its room are guests, so its room is read
// here instead:
//   - members who checked in with the night's code (event_walkin_checkins, the walk-in path P2 gives a member) and arrived,
//     not left, not "not going": the same walk-in rule as inRoomPool. Arriving is the night's door-only code in the check-in
//     window (partnerGuests.arrivesBy, Royce's ruling on #213); they're matched on their own member profile;
//   - guests (services/partnerGuests.ts) who arrived (the door code), aren't resolved, and said what they do or who they hope to meet. A
//     guest's profile is only their own intake words, scoped to the night: what they do as an offering, who they hope to meet
//     as a seeking ask. They gave those words to be matched tonight, so both count as shareable for this night's matching.
//
// Then the same gates as every in-room match:
//   - the scorer (matching.roomFrame and scoreAgainstRoomFrame), on matchableIntent (shareable asks only);
//   - the bar (eventScoring.MATCH_NUDGE_MIN_SCORE): a thin room never lowers it, and below it nothing is suggested;
//   - a share reason the scorer drew from the candidate's own shareable words, or nothing;
//   - the pair record (roomMatching.pairBlockReason): a pair either side declined anywhere, or already introduced, never again;
//   - the value-line gate: one line per side, each read seeing only the other person's shareable words, judged by Co and
//     checked by code (roomMatching's own pure checks). Partner nights use no names in it at all, on either side: "no name
//     until both say yes" (spec step 3).
//
// What it produces: co_pairs rows for the night, 'suggested' with value lines when a friend would make the intro, 'blocked'
// when not. NOTHING IS SENT. Asking either person, and the names and numbers after both say yes, ride on the strict double
// opt-in track (P4), sequenced after it lands. No code here texts or emails anyone, and the decision log carries counts and
// verdicts only, never anyone's words (it isn't forgotten at close; partnerGuests.resolveGuests wipes the lines on the pairs).
import { createHash } from "node:crypto";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { roomPhase } from "../harness/introConsent.js";
import type { ScorableGuest } from "./eventScoring.js";
import type { ValueSide } from "./roomMatching.js";

export const PARTNER_MATCH = {
  // A pass runs only when the room changed, and not more often than this.
  minGapMinutes: 10,
  // Someone whose read failed (the scorer, or a value read) is tried again on this many later passes, then left until they change:
  // a read that keeps failing would otherwise re-score them every pass until close (review of #216).
  maxRetries: 2,
  // In a value line a partner night names nobody, on either side.
  noName: "this person",
} as const;

export type GuestWords = { user_id: string; who: string | null; work: string | null; hoping: string | null };

// ---------------------------------------------------------------- rules (pure)

// A guest as the scorer sees them: only their own intake words. "who" (often their name) is not in it: a name never reaches
// a scorer, a line or another person before both say yes.
export function guestScorable(g: GuestWords): ScorableGuest {
  const intent = [
    ...(g.hoping?.trim() ? [{ id: `guest-hoping-${g.user_id}`, text: g.hoping.trim(), type: "seeking", status: "active", shareable: true }] : []),
    ...(g.work?.trim() ? [{ id: `guest-work-${g.user_id}`, text: g.work.trim(), type: "offering", status: "active", shareable: true }] : []),
  ];
  return { user_id: g.user_id, first_name: "", phone_number: "", email: "", city: null, goals: [], blockers: [], activity_preferences: [], intent };
}

// A guest's side of the value gate: what they shared (their two answers), nothing else, and their "who" as private, so no
// line for anyone else can carry it.
export function guestValueSide(g: GuestWords): ValueSide {
  const ownAsks = [
    ...(g.hoping?.trim() ? [{ text: g.hoping.trim(), type: "seeking", shareable: true }] : []),
    ...(g.work?.trim() ? [{ text: g.work.trim(), type: "offering", shareable: true }] : []),
  ];
  return { userId: g.user_id, firstName: PARTNER_MATCH.noName, ownAsks, goals: [], pastOutcomes: [], shared: ownAsks.map((a) => a.text), privateAsks: [], privateTexts: g.who?.trim() ? [g.who.trim()] : [] };
}

// One person as the matcher sees them, hashed: who they are and what they shared. A changed hash is someone new to score.
export function personSignature(p: ScorableGuest): string {
  return createHash("sha256").update(`${p.user_id}:${JSON.stringify(Array.isArray(p.intent) ? (p.intent as any[]).map((i) => [i?.type, i?.text, i?.shareable, i?.status]) : [])}`).digest("hex").slice(0, 32);
}

// What the room is, for "has it changed since the last pass": everyone in it and what each said, hashed.
export function roomSignature(room: ScorableGuest[]): string {
  return createHash("sha256").update(room.map(personSignature).sort().join("\n")).digest("hex");
}

// Who needs scoring this pass: anyone new or changed since the last one. Each pass scores the changed people against the whole
// room and everyone else against the changed people only, so a pass costs what changed, not the whole room again.
export function changedPeople(room: ScorableGuest[], seen: Record<string, string> | null | undefined): Set<string> {
  return new Set(room.filter((p) => seen?.[p.user_id] !== personSignature(p)).map((p) => p.user_id));
}

// Whether a pass is due: the room is open (not before, not its last half hour, not over), and it changed since the last pass,
// which was long enough ago.
export function passDue(o: { phase: string; signature: string; last: { signature: string; ran_at: Date } | null; now: Date }): { due: boolean; why: string } {
  if (o.phase !== "open") return { due: false, why: `the room is ${o.phase}` };
  if (o.last && o.last.signature === o.signature) return { due: false, why: "the room hasn't changed" };
  if (o.last && o.now.getTime() - new Date(o.last.ran_at).getTime() < PARTNER_MATCH.minGapMinutes * 60_000) return { due: false, why: "a pass ran a few minutes ago" };
  return { due: true, why: o.last ? "the room changed" : "the first pass" };
}

// ---------------------------------------------------------------- data

// The room at a partner night right now: members who checked in and arrived, and guests who arrived with something to match on.
export async function partnerRoom(eventId: string): Promise<{ members: ScorableGuest[]; guests: GuestWords[] }> {
  const { mergeWalkinsIntoGuestPool } = await import("./eventWalkinCheckin.js");
  const walkins = await mergeWalkinsIntoGuestPool(eventId);
  const ids = walkins.map((w) => w.user_id);
  const presence = ids.length
    ? (await pool.query(`SELECT user_id, arrived_at, left_at, not_going_at FROM event_presence WHERE event_api_id = $1 AND user_id = ANY($2::uuid[])`, [eventId, ids])).rows
    : [];
  const here = new Set(presence.filter((r: any) => r.arrived_at && !r.left_at && !r.not_going_at).map((r: any) => String(r.user_id)));
  const { rows: guests } = await pool.query(
    `SELECT g.user_id, g.who, g.work, g.hoping FROM partner_guests g JOIN users u ON u.id = g.user_id
     WHERE g.event_api_id = $1 AND g.arrived_at IS NOT NULL AND g.resolved_at IS NULL AND (g.hoping IS NOT NULL OR g.work IS NOT NULL)
       AND coalesce(u.sms_opted_out, false) = false AND u.archived_at IS NULL`,
    [eventId],
  );
  // Someone who is both (a guest who joined during the night and then checked in as a member) is counted once, as a member.
  const memberIds = new Set([...here]);
  return { members: walkins.filter((w) => here.has(w.user_id)), guests: guests.filter((g: GuestWords) => !memberIds.has(g.user_id)) };
}

export type PassDeps = {
  now?: Date;
  room?: typeof partnerRoom;
  score?: (frameOwner: ScorableGuest, others: ScorableGuest[]) => Promise<{ candidate: ScorableGuest; score: number; shareReason?: string }[]>;
  judge?: (eventName: string, reader: ValueSide, other: ValueSide) => Promise<{ line: string; verdict: "strong" | "weak"; why: string } | null | "failed">;
  memberSide?: (userId: string) => Promise<ValueSide>;
};

const realScore: NonNullable<PassDeps["score"]> = async (person, others) => {
  const { roomFrame, scoreAgainstRoomFrame } = await import("./matching.js");
  const frame = await roomFrame(person.intent);
  if (!frame) return [];
  return scoreAgainstRoomFrame(frame, others);
};

const realJudge: NonNullable<PassDeps["judge"]> = async (eventName, reader, other) => {
  if (!other.shared.length) return null;
  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { MODELS } = await import("../models.js");
  const { sideLinePrompt, parseSideJudgment } = await import("./roomMatching.js");
  try {
    const r = await generateText({
      model: anthropic(MODELS.sonnet),
      experimental_telemetry: { isEnabled: true, functionId: "partnerMatching.valueLine", recordInputs: false, recordOutputs: false },
      prompt: sideLinePrompt(eventName, reader, { firstName: other.firstName, shared: other.shared, kinds: other.ownAsks.map((x) => x.type) }),
    });
    const j = parseSideJudgment(r.text);
    return j ? { ...j, line: j.line.replace(/\s*[—–]\s*|\s+-\s+/g, ", ").replace(/!/g, ".").trim() } : "failed";
  } catch {
    return "failed";
  }
};

export type PassResult = { eventId: string; ran: boolean; why: string; room: number; guests: number; suggested: number; blocked: number; belowBar: number };

// One matching pass for one partner night. Scores everyone in the room against everyone else, and runs the value gate on each
// pair above the bar that the pair record allows. Writes co_pairs; sends nothing.
export async function runPartnerMatchPass(eventId: string, deps: PassDeps = {}): Promise<PassResult> {
  const now = deps.now ?? new Date();
  const out: PassResult = { eventId, ran: false, why: "", room: 0, guests: 0, suggested: 0, blocked: 0, belowBar: 0 };
  const { partnerEvent } = await import("./partners.js");
  const found = await partnerEvent(eventId);
  if (!found) return { ...out, why: "not a partner night" };
  const RM = await import("./roomMatching.js");
  const phase = roomPhase(found.event, now, found.event.closed_at);
  const paused = await RM.matchingPause(eventId);
  if (paused) return { ...out, why: paused };
  const { members, guests } = await (deps.room ?? partnerRoom)(eventId);
  const room: ScorableGuest[] = [...members.map((m) => ({ ...m, intent: RM.matchableIntent(m.intent) })), ...guests.map(guestScorable)];
  out.room = room.length;
  out.guests = guests.length;
  const signature = roomSignature(room);
  const { rows: lastRows } = await pool.query(`SELECT signature, ran_at, seen FROM partner_match_passes WHERE event_api_id = $1`, [eventId]);
  const due = passDue({ phase, signature, last: lastRows[0] ?? null, now });
  if (!due.due) return { ...out, why: due.why };
  if (room.length < 2) return { ...out, why: "fewer than two people to match" };
  const changed = changedPeople(room, lastRows[0]?.seen ?? null);
  await pool.query(
    `INSERT INTO partner_match_passes (event_api_id, signature, ran_at, seen) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (event_api_id) DO UPDATE SET signature = EXCLUDED.signature, ran_at = EXCLUDED.ran_at, seen = EXCLUDED.seen`,
    [eventId, signature, now, JSON.stringify(Object.fromEntries(room.map((p) => [p.user_id, personSignature(p)])))],
  );
  out.ran = true;
  out.why = due.why;

  const { MATCH_NUDGE_MIN_SCORE } = await import("./eventScoring.js");
  const guestById = new Map(guests.map((g) => [g.user_id, g]));
  const sideCache = new Map<string, ValueSide>();
  const sideOf = async (id: string): Promise<ValueSide> => {
    if (!sideCache.has(id)) {
      const g = guestById.get(id);
      const side = g ? guestValueSide(g) : { ...(await (deps.memberSide ?? RM.gatherValueSide)(id)), firstName: PARTNER_MATCH.noName };
      sideCache.set(id, side);
    }
    return sideCache.get(id)!;
  };
  const judged = new Set<string>();
  // Whoever a read failed for this pass: left out of the record below, so the next pass reads them again instead of finding "the room
  // hasn't changed" (review of #216: one transient error lost that pair for the rest of the night).
  const failed = new Set<string>();
  for (const person of room) {
    const others = room.filter((o) => o.user_id !== person.user_id && (changed.has(person.user_id) || changed.has(o.user_id)));
    if (!others.length) continue;
    const scored = await (deps.score ?? realScore)(person, others).catch(() => {
      failed.add(person.user_id);
      return [];
    });
    for (const s of scored) {
      const other = s.candidate.user_id;
      const key = [person.user_id, other].sort().join(":");
      if (judged.has(key)) continue;
      // The bar and a share reason from their own words: below it, nothing is suggested (a thin room never lowers it).
      if (s.score < MATCH_NUDGE_MIN_SCORE || !s.shareReason) {
        out.belowBar++;
        continue;
      }
      judged.add(key);
      const block = RM.pairBlockReason(await RM.pairRows(person.user_id, other), eventId, person.user_id, other);
      if (block) continue;
      const verdict = await valuePair(eventId, found.event.name, await sideOf(person.user_id), await sideOf(other), deps).catch(() => "failed" as const);
      if (verdict === "strong") out.suggested++;
      else if (verdict === "weak") out.blocked++;
      else {
        failed.add(person.user_id);
        failed.add(other);
      }
    }
  }
  if (failed.size) {
    // The record written above said everyone was read. Rewrite it without whoever failed (and with a signature that isn't the room's,
    // so the next pass is due), counting each person's failures; once they're out of retries they're recorded as read.
    const before: Record<string, number> = (lastRows[0]?.seen?.__retries as Record<string, number> | undefined) ?? {};
    const retries: Record<string, number> = { ...before };
    for (const id of failed) retries[id] = (before[id] ?? 0) + 1;
    const retry = new Set([...failed].filter((id) => retries[id] <= PARTNER_MATCH.maxRetries));
    const seen = { ...Object.fromEntries(room.filter((p) => !retry.has(p.user_id)).map((p) => [p.user_id, personSignature(p)])), __retries: retries };
    await pool
      .query(`UPDATE partner_match_passes SET signature = $2, seen = $3::jsonb WHERE event_api_id = $1`, [eventId, retry.size ? `retry:${signature}` : signature, JSON.stringify(seen)])
      .catch((err: any) => console.error("partnerMatching: marking the pass for a retry failed (non-fatal):", err?.message ?? err));
  }
  await recordDecision({ layer: 6, decision: "partner.matchPass", userId: null, outcome: "act", action: "pass", proposal: { ...out } }).catch(() => {});
  return out;
}

// The value gate for one pair at a partner night: the same pure checks as roomMatching.valueGate, with the guest's side read
// from their intake words and no names. Stores the verdict and lines on the pair; logs only the verdict.
async function valuePair(eventId: string, eventName: string, x: ValueSide, y: ValueSide, deps: PassDeps): Promise<"strong" | "weak" | "failed"> {
  const RM = await import("./roomMatching.js");
  const { a, b } = RM.orderPair(x.userId, y.userId);
  const [sa, sb] = a === x.userId ? [x, y] : [y, x];
  await RM.notePairSuggested(eventId, a, b, "co");
  const existing = await RM.pairRow(eventId, a, b);
  if (existing?.value_verdict) return existing.value_verdict === "strong" ? "strong" : "weak";
  const judge = deps.judge ?? realJudge;
  const [ra, rb] = await Promise.all([judge(eventName, sa, sb), judge(eventName, sb, sa)]);
  if (ra === "failed" || rb === "failed") {
    await recordDecision({ layer: 6, decision: "partner.valueLines", userId: null, outcome: "skip", action: "read_failed", proposal: { eventId } }).catch(() => {});
    return "failed";
  }
  const judgment = RM.combineSides(ra, rb);
  const { SENSITIVE } = await import("../harness/matchGate.js");
  const result = RM.checkValueLines(judgment, sa, sb, SENSITIVE, [eventName]);
  const failed = result.checks.filter((c) => !c.pass).map((c) => c.name);
  const ok = result.ok && !!judgment;
  const lineA = judgment ? (judgment.judged.first ? judgment.forFirst : RM.WITHHELD) : null;
  const lineB = judgment ? (judgment.judged.second ? judgment.forSecond : RM.WITHHELD) : null;
  await pool.query(
    `UPDATE co_pairs SET value_line_a = $4, value_line_b = $5, value_verdict = $6, value_why = $7, value_judged_at = NOW(),
       state = CASE WHEN $8 THEN state WHEN state = 'suggested' THEN 'blocked' ELSE state END, blocked_reason = CASE WHEN $8 THEN NULL ELSE $9 END, updated_at = NOW()
     WHERE event_id = $1 AND a_id = $2 AND b_id = $3`,
    [eventId, a, b, lineA, lineB, ok ? "strong" : "weak", judgment?.why ?? null, ok, failed.join(", ") || "no judgment"],
  );
  // Verdict and which checks failed, by name: never a line, a why or anyone's words.
  await recordDecision({ layer: 6, decision: "partner.valueLines", userId: null, outcome: ok ? "act" : "skip", action: ok ? "strong" : "weak", proposal: { eventId, failed } }).catch(() => {});
  return ok ? "strong" : "weak";
}

// Every 5 minutes with the room-close job (jobs/index.ts): a pass for each partner night whose room is open and changed.
export async function runPartnerMatchPasses(now = new Date()): Promise<PassResult[]> {
  const { rows } = await pool.query(
    `SELECT api_id FROM partner_events WHERE closed_at IS NULL AND intake_opened_at IS NOT NULL AND start_at <= $1 AND start_at > $1 - INTERVAL '1 day'`,
    [now],
  );
  const out: PassResult[] = [];
  for (const r of rows) out.push(await runPartnerMatchPass(r.api_id, { now }).catch((err: any) => ({ eventId: r.api_id, ran: false, why: `failed: ${String(err?.message ?? err).slice(0, 120)}`, room: 0, guests: 0, suggested: 0, blocked: 0, belowBar: 0 })));
  return out;
}
