import { isTestHandle } from "./testNumbers.js";
// iMessage inline replies (Royce, 2026-09-28: "I think we should do inline
// replies", after Instinct answered a text threaded under it). Two sides:
//
// Reading: when a member long-presses one of Co's texts and replies to it,
// Sendblue's webhook carries reply_to.message_handle. Co looks that message
// up, so it knows exactly which text they meant instead of guessing from the
// wording ("that one", which of three sent events).
//
// Sending: Co threads its first text under theirs when it matters, the way
// Instinct and Boardy do: they replied inline themselves, or they've texted
// again since this message and Co's answer would otherwise read as an answer
// to the newer one. Sendblue never downgrades an inline reply: a refused one
// is simply not sent, so the caller resends it as a plain text.
// Needs a V2 Sendblue line and iMessage; SMS goes plain.

// text: the message they pressed Reply on. alsoInThread: the latest message
// in that thread when it's a different one. Sendblue's reply_to is the latest
// in the thread and thread_originator the one pressed (2026-09-28: Royce
// replied "I'm in" under the Grok Bot link; reply_to pointed at a later test
// text in the same thread, so Co asked which event he meant).
// what: the event a bare link was for, from Co's action record.
export type RepliedTo = { text: string; fromCo: boolean; what?: string | null; alsoInThread?: string | null };

const digits = (n: unknown) => String(n ?? "").replace(/\D/g, "").slice(-10);

// The message they replied to, only when it belongs to their own
// conversation with Co (never another member's thread).
export function targetFromMessage(m: any, memberPhone: string): RepliedTo | null {
  if (!m || typeof m.content !== "string" || !m.content.trim()) return null;
  const fromCo = m.is_outbound === true;
  const them = fromCo ? m.number ?? m.to_number : m.from_number ?? m.number;
  if (!digits(memberPhone) || digits(them) !== digits(memberPhone)) return null;
  return { text: m.content.trim().slice(0, 600), fromCo };
}

// Both handles from the webhook: the one they pressed wins, the latest in the
// thread rides along.
export async function repliedTo(body: any, memberPhone: string): Promise<RepliedTo | null> {
  const pressed = body?.thread_originator?.message_handle;
  const latest = body?.reply_to?.message_handle;
  const [a, b] = await Promise.all([lookUp(pressed ?? latest, memberPhone), pressed && latest && latest !== pressed ? lookUp(latest, memberPhone) : Promise.resolve(null)]);
  const main = a ?? b;
  if (!main) return null;
  return { ...main, alsoInThread: a && b && b.text !== a.text ? b.text : null };
}

async function lookUp(handle: unknown, memberPhone: string): Promise<RepliedTo | null> {
  if (typeof handle !== "string" || !handle) return null;
  // An ops text (the daily sweep's rollup, services/dailySweep.ts) isn't part of their conversation with Co: a reply under it carries
  // no target, so its words (other members' names) never enter their thread.
  {
    const { default: pool } = await import("../db/db.js");
    const { rows } = await pool.query(`SELECT 1 FROM outbound_messages WHERE message_handle = $1 AND sender = 'ops' LIMIT 1`, [handle]).catch(() => ({ rows: [] as any[] }));
    if (rows.length) return null;
  }
  // A test member's messages never went through Sendblue (services/testNumbers.ts):
  // Co's own send log has them.
  if (isTestHandle(handle)) {
    const { default: pool } = await import("../db/db.js");
    const { rows } = await pool
      .query(`SELECT ob.content FROM outbound_messages ob JOIN users u ON u.id = ob.user_id WHERE ob.message_handle = $1 AND u.phone_number = $2`, [handle, memberPhone])
      .catch(() => ({ rows: [] as any[] }));
    return rows[0] ? targetFromMessage({ content: rows[0].content, is_outbound: true, number: memberPhone }, memberPhone) : null;
  }
  if (!process.env.SENDBLUE_API_KEY || !process.env.SENDBLUE_SECRET_KEY) return null;
  // Straight to the API: services/sendblue.ts's wrapper only carries send.
  try {
    const res = await fetch(`https://api.sendblue.co/api/v2/messages/${encodeURIComponent(handle)}`, {
      headers: { "sb-api-key-id": process.env.SENDBLUE_API_KEY, "sb-api-secret-key": process.env.SENDBLUE_SECRET_KEY },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.error(`inlineReply: status lookup ${res.status} (non-fatal)`);
      return null;
    }
    const j: any = await res.json();
    return targetFromMessage(j?.data ?? j, memberPhone);
  } catch (err: any) {
    console.error("inlineReply: couldn't look up the replied-to message (non-fatal):", err?.message ?? err);
    return null;
  }
}

export function repliedToFact(r: RepliedTo): string {
  const what = r.what ? ` (that's the link Co sent for: ${r.what})` : "";
  const later = r.alsoInThread ? ` Later in that same thread: "${r.alsoInThread}".` : "";
  return r.fromCo
    ? `They pressed Reply on this earlier text from Co (iMessage inline reply), so their message is about it: "${r.text}"${what}.${later}`
    : `They pressed Reply on their own earlier text (iMessage inline reply), so their message is about it: "${r.text}".${later}`;
}

// A text that's just a link (Co sends event links on their own).
export function bareLink(text: string): string | null {
  const m = text.trim().match(/^(https?:\/\/\S+)$/);
  return m ? m[1] : null;
}

// Kept with their message in the conversation record, the way a photo is.
export function inlineNote(r: RepliedTo): string {
  const t = r.text.length > 200 ? `${r.text.slice(0, 200)}…` : r.text;
  const what = r.what ? ` (${r.what.slice(0, 160)})` : "";
  return r.fromCo ? `[Replying to Co's text: "${t}"${what}]` : `[Replying to their own earlier text: "${t}"]`;
}

// Whether Co's first text this turn should thread, and under what: their
// message when they replied inline or texted again since; otherwise, when
// this turn is about one thing Co sent (services/readTurn.ts about_sent), the
// message Co sent it in (Royce, 2026-09-28: threading keeps context with the
// thing it's about).
// After a wait this long, an answer comes back under the ask that started it
// (Royce, 2026-09-29, from Instinct: long tasks return threaded under the request).
export const SLOW_REPLY_MS = 20_000;

export function threadReason(o: { theyRepliedInline: boolean; newerTextSince: boolean; aboutSentHandle?: string | null; slowMs?: number; isGroup?: boolean }): "mirror" | "newer_text" | "about_sent" | "slow" | null {
  if (o.isGroup) return null;
  if (o.theyRepliedInline) return "mirror";
  if (o.newerTextSince) return "newer_text";
  if (o.aboutSentHandle) return "about_sent";
  if (o.slowMs !== undefined && o.slowMs >= SLOW_REPLY_MS) return "slow";
  return null;
}

// The message Co sent a thing in: its link on its own when there was one,
// else the text that named it. Only this member's messages.
export async function sentMessageHandle(userId: string, item: { name: string; url: string | null }): Promise<string | null> {
  const { default: pool } = await import("../db/db.js");
  const { rows } = await pool
    .query(
      `SELECT message_handle FROM outbound_messages
       WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '45 days'
         AND (($2::text IS NOT NULL AND content = $2) OR content ILIKE '%' || $3 || '%')
       ORDER BY (($2::text IS NOT NULL AND content = $2)) DESC, sent_at DESC LIMIT 1`,
      [userId, item.url, item.name.slice(0, 120)],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows[0]?.message_handle ?? null;
}
