// The partner readout, from preview to full (Royce, 2026-10-07, board item 3). services/partnerReadout.ts builds the readout and
// stays counts-only; this is everything after: a draft is built and frozen after each Co event, the team reviews it, and only on the
// team's yes does the host get anything, by a read-only link and, when the team gives an address, one email.
//
//   draft     built automatically 12 hours after the event ends (runReadoutDrafts, hourly); the team is emailed that it's ready.
//   approved  a person on the team said yes (src/scripts/partnerReadout.ts approve), with the host's address if it will be emailed.
//             The read-only link is made then: a random token, kept only as its hash, good for 30 days.
//   sent      the one email to the host, only from approved, only by a person (the same script). Nothing sends on a timer.
//   withdrawn the link stops working.
//
// The same bar as the member brief: nothing in it is invented. Every line is a fixed sentence around a count read from Co's own
// rows (no model writes any of it; the model only puts an ask in a fixed category). The stats are frozen at draft time, so what the
// team approves is exactly what the host sees. And before it is stored, the page is checked for any member's name, an email, a
// phone number or a link: a hit stores nothing.
import { createHash, randomBytes } from "node:crypto";
import pool from "../db/db.js";
import { describe, gatherStats, renderHtml, renderText, READOUT, type Stats } from "./partnerReadout.js";

export const READOUT_FLOW = { draftAfterEndMs: 12 * 3_600_000, draftWithinMs: 7 * 86_400_000, assumedLengthMs: 4 * 3_600_000, linkDays: 30 };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;

// ---------------------------------------------------------------- rules (pure)

// When an event's readout is due: it ended at least 12 hours ago (members' debriefs and follow-throughs are in) and not more than a week.
export function readoutDue(event: { start_at: string; end_at: string | null }, now: Date): boolean {
  const end = event.end_at ? new Date(event.end_at).getTime() : new Date(event.start_at).getTime() + READOUT_FLOW.assumedLengthMs;
  if (!Number.isFinite(end)) return false;
  const since = now.getTime() - end;
  return since >= READOUT_FLOW.draftAfterEndMs && since <= READOUT_FLOW.draftWithinMs;
}

// The last check before anything is stored: no member's name (first or last, three letters or more), no email, phone number or link
// anywhere in what the host reads. The event's own name is left out of the check (it's the host's, and on the page by design), and so
// are the readout's own fixed words (a member called Hope can't be leaked by a sentence the template always has).
// A dot ending a word goes ("Thanks, Ellis." folds to "thanks ellis": a name right before a period is caught, from #217's review); a
// dot inside a word stays, so an email address still reads as one.
const fold = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\d@.+]+/gu, " ").replace(/\.+(?= |$)/g, "").replace(/\s+/g, " ").trim()} `;
const SAMPLE: Stats = { eventName: "", registered: 30, arrived: 20, walkins: 3, briefs: 10, nudged: 10, interested: 5, intros: 4, debriefReplies: 9, metSomeone: 6, conversationsTold: 12, followThroughMembers: 4, askCount: 20, themes: { "Investors or funding": 4, "Hiring or talent": 4, "Cofounders or partners": 3, "Customers or clients": 3, "Advice or mentors": 3, "Community or friends": 3, "Venues or events": 3, "Something else": 3 } };
const TEMPLATE_WORDS = new Set(fold([renderText(SAMPLE), renderText({ ...SAMPLE, registered: 1 }), renderText({ ...SAMPLE, askCount: 0, intros: 1, interested: 1 })].join(" ")).trim().split(" "));
export function readoutLeak(text: string, eventName: string, memberNames: string[]): string | null {
  const rest = eventName ? text.split(eventName).join(" ") : text;
  const body = fold(rest);
  if (/@/.test(body)) return "an email address";
  if (/\+?\d[\d .()-]{8,}\d/.test(rest)) return "a phone number";
  if (/https?:|www\./i.test(rest)) return "a link";
  for (const n of memberNames) {
    const name = fold(n).trim();
    if (name.length < 3 || TEMPLATE_WORDS.has(name)) continue;
    if (body.includes(` ${name} `)) return `a member's name (${n.trim()})`;
  }
  return null;
}

// What may happen next, from where it stands. The host is never reached from a draft.
export function nextAllowed(r: { status: string; host_email: string | null; link_expires_at: Date | null }, now: Date): { approve: boolean; send: boolean; link: boolean } {
  const live = !!r.link_expires_at && new Date(r.link_expires_at).getTime() > now.getTime();
  return {
    approve: r.status === "draft",
    send: r.status === "approved" && !!r.host_email && EMAIL.test(r.host_email) && live,
    link: (r.status === "approved" || r.status === "sent") && live,
  };
}

// ---------------------------------------------------------------- data

export type ReadoutRow = { id: string; event_id: string; event_name: string; stats: Stats; text: string; html: string; status: string; created_at: Date; approved_at: Date | null; approved_by: string | null; host_email: string | null; link_expires_at: Date | null; sent_at: Date | null };

export async function readoutFor(eventId: string): Promise<ReadoutRow | null> {
  const { rows } = await pool.query(`SELECT * FROM partner_readouts WHERE event_id = $1`, [eventId]);
  return rows[0] ?? null;
}

async function memberNamesOf(): Promise<string[]> {
  const { rows } = await pool.query(`SELECT first_name, last_name FROM users`);
  return rows.flatMap((r: any) => [r.first_name, r.last_name]).filter((n: any) => typeof n === "string" && n.trim().length >= 3);
}

export type DraftDeps = { gather: (eventId: string, eventName: string) => Promise<Stats>; names: () => Promise<string[]> };
const realDraftDeps: DraftDeps = { gather: (id, name) => gatherStats(id, name), names: memberNamesOf };

// Build and freeze one draft. A room too small to read out gets none; a page that would leak anything stores nothing.
export async function draftReadout(eventId: string, eventName: string, deps: DraftDeps = realDraftDeps): Promise<{ status: "drafted" | "exists" | "too_small" | "leak"; why?: string }> {
  if (await readoutFor(eventId)) return { status: "exists" };
  const stats = await deps.gather(eventId, eventName);
  if (stats.registered < READOUT.minRoom) return { status: "too_small" };
  const text = renderText(stats);
  const html = renderHtml(stats);
  // The page is the same lines as the text inside a fixed template, so the text is what is checked.
  const leak = readoutLeak(text, eventName, await deps.names());
  if (leak) return { status: "leak", why: leak };
  const { rows } = await pool.query(
    `INSERT INTO partner_readouts (event_id, event_name, stats, text, html) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
    [eventId, eventName.slice(0, 200), JSON.stringify(stats), text, html],
  );
  return rows.length ? { status: "drafted" } : { status: "exists" };
}

// Hourly: each Co event that ended 12 hours to a week ago gets its draft, and the team hears it's ready (by the internal report
// email; the draft is counts only). Never sends anything to a host.
export async function runReadoutDrafts(now = new Date(), deps: DraftDeps & { notify?: (subject: string, text: string) => Promise<unknown>; events?: () => Promise<{ api_id: string; name: string; start_at: string; end_at: string | null }[]> } = realDraftDeps): Promise<number> {
  const presenceEvents = deps.events ?? (await import("./eventPresence.js")).presenceEvents;
  const notify = deps.notify ?? (async (subject: string, text: string) => (await import("./reportEmail.js")).sendReportEmail(subject, `<pre>${text.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]!)}</pre>`, text));
  let drafted = 0;
  for (const e of await presenceEvents()) {
    if (!readoutDue(e, now)) continue;
    const r = await draftReadout(e.api_id, e.name, deps).catch((err: any) => ({ status: "error" as const, why: String(err?.message ?? err).slice(0, 160) }));
    if (r.status === "drafted") {
      drafted++;
      const row = await readoutFor(e.api_id);
      await Promise.resolve(notify(`Readout drafted: ${e.name}`, `${row?.text ?? ""}\n\nNothing has gone to the host. To approve it: npx tsx src/scripts/partnerReadout.ts approve ${e.api_id} --by <your name> [--host <email>]`)).catch(() => {});
    } else if (r.status === "leak" || r.status === "error") {
      console.error(`partnerReadout: no draft for ${e.api_id} (${r.status}: ${r.why})`);
    }
  }
  return drafted;
}

// The team's yes. Only a draft can be approved; the link is made now and shown once (only its hash is kept).
export async function approveReadout(eventId: string, o: { by: string; hostEmail?: string | null; now?: Date }): Promise<{ ok: true; link: string } | { ok: false; why: string }> {
  const by = o.by.trim();
  if (by.length < 2) return { ok: false, why: "say who on the team is approving it" };
  const host = o.hostEmail?.trim() || null;
  if (host && !EMAIL.test(host)) return { ok: false, why: "that host address doesn't look like an email" };
  const base = (process.env.API_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) return { ok: false, why: "API_URL isn't set, so there's no link to give" };
  const token = randomBytes(24).toString("base64url");
  const expires = new Date((o.now ?? new Date()).getTime() + READOUT_FLOW.linkDays * 86_400_000);
  const { rows } = await pool.query(
    `UPDATE partner_readouts SET status = 'approved', approved_at = NOW(), approved_by = $2, host_email = $3, link_token_hash = $4, link_expires_at = $5
     WHERE event_id = $1 AND status = 'draft' RETURNING id`,
    [eventId, by.slice(0, 80), host, hash(token), expires],
  );
  if (!rows.length) return { ok: false, why: "there's no draft for that event to approve (it may already be approved, sent or withdrawn)" };
  const { recordDecision } = await import("../harness/core.js");
  await recordDecision({ layer: 6, decision: "readout.approve", userId: null, outcome: "act", action: "approved", proposal: { eventId, hostEmail: !!host } }).catch(() => {});
  return { ok: true, link: `${base}/readout/${token}` };
}

export type SendDeps = { email: (to: string, subject: string, html: string, text: string) => Promise<boolean> };
const realSendDeps: SendDeps = {
  email: async (to, subject, html, text) => {
    const { ALLOW_REAL_SENDS } = await import("../otpActions.js");
    if (!ALLOW_REAL_SENDS || !process.env.RESEND_API_KEY) {
      console.log(`[readout email, not sent] to ${to}: ${subject}`);
      return false;
    }
    const { Resend } = await import("resend");
    const { CO_EMAIL_FROM } = await import("./emailFrom.js");
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: CO_EMAIL_FROM, to: [to], subject, html, text });
    if (error) throw new Error(`Resend: ${error.message}`);
    return true;
  },
};

// The one email to the host: only an approved readout, to the address the team gave, with the frozen page. A person runs it.
export async function sendReadout(eventId: string, deps: SendDeps = realSendDeps, now = new Date()): Promise<{ ok: boolean; why?: string }> {
  const r = await readoutFor(eventId);
  if (!r) return { ok: false, why: "no readout for that event" };
  if (!nextAllowed(r, now).send) return { ok: false, why: r.status === "draft" ? "it hasn't been approved by the team" : r.status === "sent" ? "it was already sent" : !r.host_email ? "no host address was given when it was approved" : "it can't be sent from where it stands (withdrawn, or its link has expired)" };
  // Claimed first, so two runs can't send it twice.
  const claim = await pool.query(`UPDATE partner_readouts SET status = 'sent', sent_at = NOW() WHERE id = $1 AND status = 'approved' RETURNING id`, [r.id]);
  if (!claim.rows.length) return { ok: false, why: "it was sent by another run" };
  const sent = await deps.email(r.host_email!, describe(r.stats).headline, r.html, r.text).catch((err: any) => {
    console.error("partnerReadout: email failed:", err?.message ?? err);
    return false;
  });
  if (!sent) {
    await pool.query(`UPDATE partner_readouts SET status = 'approved', sent_at = NULL WHERE id = $1`, [r.id]);
    return { ok: false, why: "the email didn't go (nothing was sent; it's still approved)" };
  }
  return { ok: true };
}

export async function withdrawReadout(eventId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`UPDATE partner_readouts SET status = 'withdrawn', withdrawn_at = NOW(), link_token_hash = NULL WHERE event_id = $1 AND status <> 'withdrawn'`, [eventId]);
  return (rowCount ?? 0) > 0;
}

// The host's read-only view: by the link's token only, while the readout is approved or sent and the link is live.
export async function readoutByToken(token: string, now = new Date()): Promise<{ html: string; headline: string; lines: string[]; note: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const { rows } = await pool.query(`SELECT * FROM partner_readouts WHERE link_token_hash = $1`, [hash(token)]);
  const r = rows[0] as ReadoutRow | undefined;
  if (!r || !nextAllowed(r, now).link) return null;
  return { html: r.html, ...describe(r.stats) };
}
