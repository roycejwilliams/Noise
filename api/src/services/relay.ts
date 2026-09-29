// Co passing a message between members (Royce, 2026-09-28: "What if I had you
// talk to other people's Co?", "following up on something you've promised
// with others in the network"). Built guards-first around the standing rule:
// one member's information never reaches another's conversation without
// their clear yes. Off unless CO_RELAY=on.
//
//   - Only people they're already connected to through Co: introduced by
//     email after both said yes, or two team members. Never found by
//     searching the membership, and a name Co can't reach gets the same
//     answer whether or not that person is a member.
//   - Consent in: only the sender's own words go out, labeled as theirs, with
//     nothing added about them.
//   - Consent out: nothing comes back unless the recipient asks Co to send it,
//     in their own words (the same tool, from their side).
//   - One relay per pair per day, one person per relay (never a group text),
//     STOP and local hours respected (it's a direct_ask exempt send), every
//     step logged.
//   - "Follow up on what I promised Sam" is a reminder to them at a set time;
//     Co never contacts anyone on its own.
import { notToTeammate } from "./teamLines.js";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { writeMemory } from "./memory.js";

export function relayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CO_RELAY === "on";
}

export const RELAY_PER_PAIR_PER_DAY = 1;

// ---------------------------------------------------------------- pure rules

const squash = (t: string) =>
  t
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Consent in: what goes out has to be their own words, from what they texted.
export function isOwnWords(message: string, ownTexts: string[]): boolean {
  const m = squash(message);
  if (m.split(" ").length < 2 || m.length < 8) return false;
  return ownTexts.some((t) => squash(t).includes(m));
}

export type Connection = { userId: string; firstName: string; source: "introduced" | "team" };

// A name they used, matched only against their own connections.
export function matchConnection(name: string, connections: Connection[]): { ok: true; person: Connection } | { ok: false; reason: "not_reachable" | "ambiguous"; names?: string[] } {
  const want = squash(name).split(" ")[0] ?? "";
  if (!want) return { ok: false, reason: "not_reachable" };
  const hits = connections.filter((c) => squash(c.firstName).split(" ")[0] === want);
  if (hits.length === 1) return { ok: true, person: hits[0] };
  if (hits.length > 1) return { ok: false, reason: "ambiguous", names: hits.map((h) => h.firstName) };
  return { ok: false, reason: "not_reachable" };
}

// The one answer for anyone Co can't reach: the same whether or not they're a
// member, so it never tells anyone who's in Co.
export const NOT_REACHABLE =
  "Co can only pass messages to people they're already connected to through Co (introduced after both said yes). It can't reach this person, and must not say whether they're a member.";

export function relayText(fromFirstName: string, message: string): string {
  return `${fromFirstName} asked me to pass this along: "${message.trim()}"\n\nIf you want me to send anything back, just tell me what to say.`;
}

// ---------------------------------------------------------------- storage

export async function connectionsFor(userId: string): Promise<Connection[]> {
  const { rows } = await pool
    .query(
      `WITH mine AS (
         SELECT CASE WHEN person_a_id = $1 THEN person_b_id ELSE person_a_id END AS other, 'introduced' AS source
           FROM network_introductions WHERE status = 'introduced' AND (person_a_id = $1 OR person_b_id = $1)
         UNION
         SELECT CASE WHEN person_a = $1 THEN person_b ELSE person_a END, source
           FROM member_connections WHERE person_a = $1 OR person_b = $1
         UNION
         SELECT u2.id, 'team' FROM users u1 JOIN users u2 ON u2.mo_approver AND u2.id <> u1.id
           WHERE u1.id = $1 AND u1.mo_approver
       )
       SELECT DISTINCT ON (u.id) u.id, u.first_name, mine.source FROM mine JOIN users u ON u.id = mine.other
       WHERE u.first_name IS NOT NULL AND COALESCE(u.sms_opted_out, false) = false AND u.archived_at IS NULL`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({ userId: r.id, firstName: r.first_name, source: r.source === "team" ? "team" : "introduced" }));
}

// Recorded wherever an introduction email goes out after both said yes.
export async function recordConnection(a: string, b: string, source: string): Promise<void> {
  if (!a || !b || a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  await pool
    .query(`INSERT INTO member_connections (person_a, person_b, source) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [x, y, source])
    .catch(() => {});
}

async function relaysToday(from: string, to: string): Promise<number> {
  const { rows } = await pool
    .query(`SELECT count(*)::int AS n FROM member_relays WHERE from_user = $1 AND to_user = $2 AND status = 'sent' AND created_at > NOW() - INTERVAL '24 hours'`, [from, to])
    .catch(() => ({ rows: [{ n: RELAY_PER_PAIR_PER_DAY }] as any[] }));
  return Number(rows[0]?.n ?? RELAY_PER_PAIR_PER_DAY);
}

async function ownRecentTexts(userId: string, current: string): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} AND created_at > NOW() - INTERVAL '2 hours' ORDER BY created_at DESC LIMIT 6`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return [current, ...rows.map((r: any) => String(r.content).replace(/^User said:\s*/, "").replace(/\s*\[Replying to[\s\S]*$/, ""))];
}

// ---------------------------------------------------------------- the relay

export type RelayResult = { ok: true; to: string; note: string } | { ok: false; error: string; reason: string };

export async function relayMessage(opts: { fromUserId: string; fromFirstName: string; to: string; message: string; currentText: string }): Promise<RelayResult> {
  const log = (outcome: "act" | "skip", action: string, extra: Record<string, unknown> = {}) =>
    recordDecision({ layer: 3, decision: "relay.send", userId: opts.fromUserId, outcome, action, proposal: { to: opts.to, ...extra } }).catch(() => {});
  if (!relayEnabled()) {
    await log("skip", "off");
    return { ok: false, reason: "off", error: "Passing messages to other members isn't switched on yet. Say so plainly; don't offer it." };
  }
  if (!isOwnWords(opts.message, await ownRecentTexts(opts.fromUserId, opts.currentText))) {
    await log("skip", "not_their_words");
    return { ok: false, reason: "not_their_words", error: "Only their own words can be passed along. Ask them exactly what they want sent, then pass that." };
  }
  const found = matchConnection(opts.to, await connectionsFor(opts.fromUserId));
  if (!found.ok) {
    await log("skip", found.reason);
    return found.reason === "ambiguous"
      ? { ok: false, reason: "ambiguous", error: `More than one person they're connected to goes by that name (${found.names!.join(", ")}). Ask which one.` }
      : { ok: false, reason: "not_reachable", error: NOT_REACHABLE };
  }
  const to = found.person;
  if ((await relaysToday(opts.fromUserId, to.userId)) >= RELAY_PER_PAIR_PER_DAY) {
    await log("skip", "rate_limited", { toUser: to.userId });
    return { ok: false, reason: "rate_limited", error: `Co already passed a message to ${to.firstName} for them today. It can pass another tomorrow.` };
  }
  const { rows: phoneRows } = await pool.query(`SELECT u.phone_number, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [to.userId]);
  const phone = phoneRows[0]?.phone_number;
  if (!phone) {
    await log("skip", "no_phone", { toUser: to.userId });
    return { ok: false, reason: "not_reachable", error: NOT_REACHABLE };
  }
  const text = relayText(opts.fromFirstName, opts.message);
  const { rows: ins } = await pool.query(
    `INSERT INTO member_relays (from_user, to_user, message, status) VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [opts.fromUserId, to.userId, opts.message.slice(0, 1000)],
  );
  const id = ins[0].id;
  // One person, one message: never a group text. STOP and local hours apply.
  const { sendExemptWhenAllowed } = await import("../harness/proactive.js");
  const { getTimezoneForCity } = await import("./geocoding.js");
  const zone = phoneRows[0]?.city ? await getTimezoneForCity(phoneRows[0].city).catch(() => null) : null;
  const r = await sendExemptWhenAllowed({ userId: to.userId, phoneNumber: phone, type: "direct_ask", targetKey: `relay:${id}`, messages: [text], timezone: zone });
  const status = r.sent ? "sent" : r.queued ? "queued" : "failed";
  await pool.query(`UPDATE member_relays SET status = $2 WHERE id = $1`, [id, status === "queued" ? "sent" : status]).catch(() => {});
  if (status !== "failed") await writeMemory(to.userId, "text_exchange", `Co replied: ${text}`).catch(() => {});
  await log(status === "failed" ? "skip" : "act", status, { toUser: to.userId, relayId: id });
  if (status === "failed") return { ok: false, reason: "failed", error: `The message to ${to.firstName} didn't go through. Say so plainly.` };
  return { ok: true, to: to.firstName, note: status === "queued" ? `Queued for ${to.firstName}'s morning (it's outside their hours now).` : `Sent to ${to.firstName}.` };
}

// What each side's Co knows about relays, as facts. The sender only ever
// learns what the recipient chose to send back.
export async function relayFacts(userId: string): Promise<string[]> {
  if (!relayEnabled()) return [];
  const { rows } = await pool
    .query(
      `SELECT r.from_user, r.to_user, r.message, r.created_at, uf.first_name AS from_name, ut.first_name AS to_name
       FROM member_relays r JOIN users uf ON uf.id = r.from_user JOIN users ut ON ut.id = r.to_user
       WHERE (r.from_user = $1 OR r.to_user = $1) AND r.status = 'sent' AND r.created_at > NOW() - INTERVAL '7 days'
       ORDER BY r.created_at`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  const day = (d: Date) => DateTime.fromJSDate(d).toFormat("cccc, LLL d");
  const out: string[] = [];
  for (const r of rows) {
    if (r.to_user === userId) {
      out.push(`${r.from_name} asked Co to pass this along to them on ${day(r.created_at)}: "${r.message}". Co sends nothing back to ${r.from_name} unless they explicitly ask it to, in their own words.`);
    } else {
      const back = rows.find((x: any) => x.from_user === r.to_user && x.to_user === userId && x.created_at > r.created_at);
      out.push(
        back
          ? `Co passed their message to ${r.to_name} on ${day(r.created_at)} ("${r.message}"), and ${r.to_name} asked Co to send back: "${back.message}".`
          : `Co passed their message to ${r.to_name} on ${day(r.created_at)} ("${r.message}"). ${r.to_name} hasn't sent anything back through Co, and Co knows nothing else about their reply.`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- reminders

export async function addReminder(userId: string, what: string, when: string, zone: string | null): Promise<{ ok: true; at: string } | { ok: false; error: string }> {
  const at = DateTime.fromISO(when, { zone: zone ?? "America/Los_Angeles" });
  if (!at.isValid || at < DateTime.now().plus({ minutes: 5 }) || at > DateTime.now().plus({ days: 60 })) {
    return { ok: false, error: "Ask them when they want the reminder (a day and time within the next two months)." };
  }
  await pool.query(`INSERT INTO member_reminders (user_id, what, due_at) VALUES ($1, $2, $3)`, [userId, what.slice(0, 500), at.toJSDate()]);
  await recordDecision({ layer: 3, decision: "relay.reminder", userId, outcome: "act", action: "set", proposal: { what, at: at.toISO() } }).catch(() => {});
  return { ok: true, at: at.toFormat("cccc, LLLL d 'at' h:mm a") };
}

// Due reminders, sent to the member who asked (never anyone else).
export async function sendDueReminders(): Promise<number> {
  const { rows } = await pool
    .query(
      `SELECT r.id, r.user_id, r.what, u.phone_number, cp.city FROM member_reminders r JOIN users u ON u.id = r.user_id
       LEFT JOIN co_profiles cp ON cp.user_id = r.user_id
       WHERE r.sent_at IS NULL AND r.due_at <= NOW() AND r.due_at > NOW() - INTERVAL '2 days' LIMIT 20`,
    )
    .catch(() => ({ rows: [] as any[] }));
  const { sendExemptWhenAllowed } = await import("../harness/proactive.js");
  const { getTimezoneForCity } = await import("./geocoding.js");
  let n = 0;
  for (const r of rows) {
    const claimed = await pool.query(`UPDATE member_reminders SET sent_at = NOW() WHERE id = $1 AND sent_at IS NULL RETURNING id`, [r.id]).catch(() => ({ rows: [] as any[] }));
    if (!claimed.rows[0] || !r.phone_number) continue;
    const zone = r.city ? await getTimezoneForCity(r.city).catch(() => null) : null;
    const text = `Reminder you asked for: ${r.what}`;
    const s = await sendExemptWhenAllowed({ userId: r.user_id, phoneNumber: r.phone_number, type: "direct_ask", targetKey: `reminder:${r.id}`, messages: [text], timezone: zone });
    if (s.sent || s.queued) {
      await writeMemory(r.user_id, "text_exchange", `Co replied: ${text}`).catch(() => {});
      n++;
    }
  }
  return n;
}
