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
  "Cue can only pass messages to people they're already connected to through Cue (introduced after both said yes). It can't reach this person, and must not say whether they're a member.";

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
    .query(`SELECT count(*)::int AS n FROM member_relays WHERE from_user = $1 AND to_user = $2 AND status IN ('sent', 'queued') AND created_at > NOW() - INTERVAL '24 hours'`, [from, to])
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

export type RelayResult = { ok: true; to: string; note: string; queued: boolean } | { ok: false; error: string; reason: string };

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
    return { ok: false, reason: "rate_limited", error: `Cue already passed a message to ${to.firstName} for them today. It can pass another tomorrow.` };
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
  const { memberZone } = await import("./memberTime.js");
  // Their stored zone (memberTime.ts memberZone, the one source of truth): never a fresh lookup of a bare city (2026-10-29 place audit).
  const zone = await memberZone(to.userId);
  // Its status, sent_at and the recipient's "Co replied:" line are written only once it actually reaches them
  // (relayDelivered, and sendExempt's own text_exchange write): queued for their morning, it reads as queued.
  const r = await sendExemptWhenAllowed({ userId: to.userId, phoneNumber: phone, type: "direct_ask", targetKey: `relay:${id}`, messages: [text], timezone: zone, after: { kind: "relay", payload: { relayId: id } } });
  const status = r.sent ? "sent" : r.queued ? "queued" : "failed";
  if (status === "queued") await pool.query(`UPDATE member_relays SET status = 'queued' WHERE id = $1 AND status = 'pending'`, [id]).catch(() => {});
  await log(status === "failed" ? "skip" : "act", status, { toUser: to.userId, relayId: id });
  if (status === "failed") return { ok: false, reason: "failed", error: `The message to ${to.firstName} didn't go through. Say so plainly.` };
  return {
    ok: true,
    to: to.firstName,
    queued: status === "queued",
    note: status === "queued" ? `Queued for ${to.firstName}'s morning (it's outside their hours now); it hasn't reached them yet.` : `Sent to ${to.firstName}.`,
  };
}

// The relay's record once its send is settled (services/deferredSends.ts runs it, now or in the morning).
export async function relayDelivered(relayId: number, outcome: "sent" | "skipped" | "failed"): Promise<void> {
  if (outcome === "sent") {
    await pool.query(`UPDATE member_relays SET status = 'sent', sent_at = COALESCE(sent_at, NOW()) WHERE id = $1`, [relayId]);
  } else {
    await pool.query(`UPDATE member_relays SET status = $2 WHERE id = $1 AND status IN ('pending', 'queued')`, [relayId, outcome]);
  }
}

// What each side's Co knows about relays, as facts. The sender only ever
// learns what the recipient chose to send back.
export async function relayFacts(userId: string): Promise<string[]> {
  if (!relayEnabled()) return [];
  const { rows } = await pool
    .query(
      `SELECT r.from_user, r.to_user, r.message, r.status, COALESCE(r.sent_at, r.created_at) AS created_at, uf.first_name AS from_name, ut.first_name AS to_name
       FROM member_relays r JOIN users uf ON uf.id = r.from_user JOIN users ut ON ut.id = r.to_user
       WHERE (r.from_user = $1 OR r.to_user = $1) AND r.status IN ('sent', 'queued') AND r.created_at > NOW() - INTERVAL '7 days'
       ORDER BY r.created_at`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  const day = (d: Date) => DateTime.fromJSDate(d).toFormat("cccc, LLL d");
  const out: string[] = [];
  for (const r of rows) {
    // Queued for the recipient's morning: the sender hears it's waiting; the recipient's Co knows nothing until it reaches them.
    if (r.status === "queued") {
      if (r.from_user === userId) out.push(`Cue has queued their message to ${r.to_name} ("${r.message}") for ${r.to_name}'s morning, since it was outside ${r.to_name}'s hours. It has NOT reached ${r.to_name} yet.`);
      continue;
    }
    if (r.to_user === userId) {
      out.push(`${r.from_name} asked Cue to pass this along to them on ${day(r.created_at)}: "${r.message}". Cue sends nothing back to ${r.from_name} unless they explicitly ask it to, in their own words.`);
    } else {
      const back = rows.find((x: any) => x.status === "sent" && x.from_user === r.to_user && x.to_user === userId && x.created_at > r.created_at);
      out.push(
        back
          ? `Cue passed their message to ${r.to_name} on ${day(r.created_at)} ("${r.message}"), and ${r.to_name} asked Cue to send back: "${back.message}".`
          : `Cue passed their message to ${r.to_name} on ${day(r.created_at)} ("${r.message}"). ${r.to_name} hasn't sent anything back through Cue, and Cue knows nothing else about their reply.`,
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

// Due reminders, sent to the member who asked (never anyone else). queued_at claims one so the 5-minute cron never picks
// it up twice; sent_at and the "Co replied:" line are written only once it actually goes out (reminderDelivered, and
// sendExempt's own text_exchange write), which at night is their 8am (services/deferredSends.ts).
// A failed send gives its claim back with a time to try again (reminderDelivered, REMINDER_RETRY): closure audit 11-02, reminder 2
// failed once (401) and stayed claimed, so it never went. Never past two days late.
export async function sendDueReminders(): Promise<number> {
  const due = (retry: boolean) =>
    pool.query(
      `SELECT r.id, r.user_id, r.what, u.phone_number, cp.city FROM member_reminders r JOIN users u ON u.id = r.user_id
       LEFT JOIN co_profiles cp ON cp.user_id = r.user_id
       WHERE r.sent_at IS NULL AND r.queued_at IS NULL AND r.due_at <= NOW() AND r.due_at > NOW() - INTERVAL '2 days'${retry ? `
         AND (r.retry_at IS NULL OR r.retry_at <= NOW())` : ""} LIMIT 20`,
    );
  // The retry column missing (its migration didn't run) must never stop every reminder: the old read, said loudly (review of #352).
  const { rows } = await due(true)
    .catch((err: any) => {
      console.error(`relay: REMINDERS: the retry-aware read failed (${String(err?.message ?? err).slice(0, 120)}); sending due reminders without retries. Check the member_reminders retry_at migration.`);
      recordDecision({ layer: 3, decision: "relay.reminder", userId: null, outcome: "skip", action: "retry_read_failed", reason: String(err?.message ?? err).slice(0, 200) }).catch(() => {});
      return due(false);
    })
    .catch(() => ({ rows: [] as any[] }));
  const { sendExemptWhenAllowed } = await import("../harness/proactive.js");
  const { memberZone } = await import("./memberTime.js");
  let n = 0;
  for (const r of rows) {
    if (!r.phone_number) continue;
    const claimed = await pool.query(`UPDATE member_reminders SET queued_at = NOW() WHERE id = $1 AND sent_at IS NULL AND queued_at IS NULL RETURNING id`, [r.id]).catch(() => ({ rows: [] as any[] }));
    if (!claimed.rows[0]) continue;
    const zone = await memberZone(r.user_id);
    const s = await sendExemptWhenAllowed({ userId: r.user_id, phoneNumber: r.phone_number, type: "direct_ask", targetKey: `reminder:${r.id}`, messages: [reminderText(r.what)], timezone: zone, after: { kind: "reminder", payload: { reminderId: r.id } } });
    // Its key is already on the send ledger: an earlier try went out (proactive_sends is written only when the text was accepted), so
    // it's recorded as sent, never sent twice.
    if (s.reason === "already sent") await reminderDelivered(Number(r.id), "sent");
    if (s.sent || s.queued) n++;
  }
  return n;
}

// Pure: a send failure that happened before anything reached Sendblue's delivery: Sendblue refused it (4xx: bad credentials, a bad
// number, a rate limit), our own send layer refused it, outreach is paused, or it was never queued. Safe to try again. Anything else (a
// timeout, a 5xx, a dropped connection, no reason) may have gone, and is checked first (reminderDelivered).
export function failedBeforeDelivery(reason: string | null | undefined): boolean {
  const r = String(reason ?? "").trim();
  return /^4\d\d\b/.test(r) || /^sendblue: /.test(r) || /proactive outreach is paused|send failed before anything delivered|^queue failed|^already (?:failed|skipped)/.test(r);
}

// A failed reminder send tries again, spaced out: 5 minutes, then 20, 80, 320; after the fifth failure it stays claimed and isn't
// tried again (a send error that lasts hours is not fixed by trying more). Never inside their quiet hours: a try that would land
// there waits for their morning, so a night doesn't use up the tries.
export const REMINDER_RETRY = { maxAttempts: 5, firstMs: 5 * 60_000, factor: 4 };
// Pure: when a reminder that has now failed `failures` times is tried again, or null when it isn't.
export function reminderRetryAt(failures: number, now: Date, zone: string | null, ok: (at: Date, zone: string | null) => boolean, nextOpen: (at: Date, zone: string | null) => Date): Date | null {
  if (failures < 1 || failures >= REMINDER_RETRY.maxAttempts) return null;
  const at = new Date(now.getTime() + REMINDER_RETRY.firstMs * REMINDER_RETRY.factor ** (failures - 1));
  return ok(at, zone) ? at : nextOpen(at, zone);
}

export const reminderText = (what: string) => `Reminder you asked for: ${what}`;

// The reminder's record once its send is settled: sent_at only when it went. Skipped (they opted out, or are archived) keeps the
// claim, so it stops there. Failed gives the claim back with its next try (reminderRetryAt), or keeps it after the last.
// A failure that may have gone (failedBeforeDelivery false) is checked before any retry: our own outbound record, then Sendblue's. Went:
// recorded as sent. Didn't: retried. Can't tell: left claimed, never retried, and logged loudly (never a second text by guess).
export async function reminderDelivered(reminderId: number, outcome: "sent" | "skipped" | "failed", reason?: string): Promise<void> {
  if (outcome === "failed" && !failedBeforeDelivery(reason)) {
    const went = await reminderWentAnyway(reminderId).catch(() => null);
    if (went === true) outcome = "sent";
    else if (went === null) {
      console.error(`relay: REMINDER ${reminderId} send failed (${String(reason ?? "no reason").slice(0, 120)}) and it can't be told whether it went: not retried.`);
      await recordDecision({ layer: 3, decision: "relay.reminder", userId: null, outcome: "skip", action: "failed_unverified", reason: String(reason ?? "").slice(0, 200), proposal: { reminderId } }).catch(() => {});
      return;
    }
  }
  if (outcome === "sent") await pool.query(`UPDATE member_reminders SET sent_at = COALESCE(sent_at, NOW()) WHERE id = $1`, [reminderId]);
  let retryAt: Date | null = null;
  if (outcome === "failed") {
    const { rows } = await pool
      .query(`UPDATE member_reminders SET attempts = attempts + 1 WHERE id = $1 AND sent_at IS NULL RETURNING user_id, attempts`, [reminderId])
      .catch(() => ({ rows: [] as any[] }));
    if (rows[0]) {
      const [{ memberZone }, { localHourOk, nextLocalHour, RULES }] = await Promise.all([import("./memberTime.js"), import("../harness/proactive.js")]);
      const zone = await memberZone(String(rows[0].user_id)).catch(() => null);
      retryAt = reminderRetryAt(Number(rows[0].attempts), new Date(), zone, (at, z) => localHourOk(at, z), (at, z) => nextLocalHour(at, z, RULES.startHour));
      if (retryAt) await pool.query(`UPDATE member_reminders SET queued_at = NULL, retry_at = $2 WHERE id = $1 AND sent_at IS NULL`, [reminderId, retryAt]).catch(() => {});
    } else console.error(`relay: REMINDER ${reminderId} failed and its retry couldn't be set (check the member_reminders attempts/retry_at migration).`);
  }
  await recordDecision({ layer: 3, decision: "relay.reminder", userId: null, outcome: outcome === "sent" ? "act" : "skip", action: outcome, proposal: { reminderId, ...(outcome === "failed" ? { retryAt: retryAt?.toISOString() ?? null } : {}) } }).catch(() => {});
}

// Whether a reminder whose send threw went out anyway: true (in our outbound record, or in Sendblue's), false (Sendblue's record says it
// didn't), null (couldn't be read). Only since its claim, and only its own words to its own member.
async function reminderWentAnyway(reminderId: number): Promise<boolean | null> {
  const { rows } = await pool.query(
    `SELECT r.user_id, r.what, r.queued_at, u.phone_number FROM member_reminders r JOIN users u ON u.id = r.user_id WHERE r.id = $1`,
    [reminderId],
  );
  const r = rows[0];
  if (!r?.phone_number) return null;
  const since = new Date(new Date(r.queued_at ?? Date.now()).getTime() - 60_000);
  const S = await import("./sendblue.js");
  const text = S.cleanCoMessage(reminderText(String(r.what ?? "")));
  const ours = await pool.query(`SELECT 1 FROM outbound_messages WHERE user_id = $1 AND sender = 'co' AND sent_at > $2 AND content = $3 LIMIT 1`, [r.user_id, since, text]);
  if (ours.rows.length) return true;
  return S.outboundSentSince({ number: String(r.phone_number), since, content: text });
}

// Reminders that came due outside their hours and are waiting for their morning: Co knows they haven't gone yet.
export async function reminderFacts(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT r.what, r.due_at FROM member_reminders r
       JOIN deferred_sends d ON d.user_id = r.user_id AND d.target_key = 'reminder:' || r.id AND d.status IN ('queued', 'sending')
       WHERE r.user_id = $1 AND r.sent_at IS NULL AND r.queued_at IS NOT NULL ORDER BY r.due_at`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => `The reminder they asked for ("${r.what}") came due outside their hours. It's queued for their morning and has NOT been sent yet.`);
}
