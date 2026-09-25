// Replies to Mo's outreach emails (Royce, 2026-09-25: "implement it to the
// best option"). Mo emails people whose X DMs are closed; their replies used
// to land in the hello@ inbox where nothing read them. Now each email's
// Reply-To is a signed per-prospect address on Resend's receiving domain
// (outreach.ts moReplyAddress). Resend posts `email.received` here, and the
// reply goes through the same reader and actions as a DM reply
// (outreach.ts handleProspectReply): clear words first, then Jev, then
// Claude. Only strangers' replies to Mo are read, never member mail.
//
// Needs MO_REPLY_DOMAIN (where replies go) and RESEND_WEBHOOK_SECRET (to
// check each post really came from Resend). Without the secret nothing is
// accepted.
import { Resend } from "resend";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { handleProspectReply, prospectFromReplyAddress, sendMoEmailReply } from "./outreach.js";

// Only the new words, not the quoted thread under them.
export function stripQuotedReply(text: string): string {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^on .{3,200} wrote:$/i.test(t)) break; // Gmail, Apple Mail
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break; // Outlook
    if (/^_{5,}$/.test(t)) break; // Outlook divider
    if (/^from:\s.+/i.test(t) && out.some((l) => l.trim())) break; // Outlook header block
    if (/^sent from my (iphone|ipad|android|phone)/i.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Out-of-office and other machine replies get no answer and change nothing.
export function isAutoReply(subject: string, headers: Record<string, string>): boolean {
  const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v ?? "").toLowerCase()]));
  if (h["auto-submitted"] && h["auto-submitted"] !== "no") return true;
  if (h["x-autoreply"] || h["x-autorespond"] || /auto_reply|auto-reply|bulk|junk|list/.test(h["precedence"] ?? "")) return true;
  return /\b(out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|away from (my|the) (desk|office)|on vacation|delivery status notification|undeliverable|mail delivery (failed|subsystem))\b/i.test(subject ?? "");
}

const bareAddress = (a: string) => (String(a).match(/<([^>]+)>/)?.[1] ?? String(a)).trim().toLowerCase();

type Outcome = { status: 200 | 400; action: string };

export async function handleInboundEmail(rawBody: string, headers: { id?: string; timestamp?: string; signature?: string }): Promise<Outcome> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret || !process.env.RESEND_API_KEY) return { status: 400, action: "not_configured" };
  const resend = new Resend(process.env.RESEND_API_KEY);
  let event: any;
  try {
    event = resend.webhooks.verify({
      payload: rawBody,
      headers: { id: headers.id ?? "", timestamp: headers.timestamp ?? "", signature: headers.signature ?? "" },
      webhookSecret: secret,
    });
  } catch {
    return { status: 400, action: "bad_signature" };
  }
  if (event?.type !== "email.received" || !event?.data?.email_id) return { status: 200, action: "ignored" };
  const data = event.data;

  // Once per email, however often Resend retries the post.
  const claim = await pool.query(`INSERT INTO mo_email_inbound (email_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING email_id`, [data.email_id]);
  if (!claim.rows[0]) return { status: 200, action: "duplicate" };

  const log = async (action: string, extra: Record<string, unknown> = {}) => {
    await recordDecision({ layer: 5, decision: "mo.reply", userId: null, outcome: action === "error" ? "skip" : "act", action, proposal: { channel: "email", ...extra } }).catch(() => {});
    return { status: 200 as const, action };
  };

  // Which prospect: the signed reply address first, then the sender.
  const recipients: string[] = [...(data.to ?? []), ...(data.cc ?? []), ...(data.received_for ? [].concat(data.received_for) : [])].map(bareAddress);
  const fromAddress = bareAddress(data.from ?? "");
  const byAddress = recipients.map(prospectFromReplyAddress).find(Boolean) ?? null;
  const { rows } = byAddress
    ? await pool.query(`SELECT * FROM mo_prospects WHERE id = $1`, [byAddress])
    : await pool.query(`SELECT * FROM mo_prospects WHERE lower(email) = $1 AND channel = 'email' ORDER BY updated_at DESC LIMIT 1`, [fromAddress]);
  const p = rows[0];
  if (!p) return log("unknown_sender");
  await pool.query(`UPDATE mo_email_inbound SET prospect_id = $2 WHERE email_id = $1`, [data.email_id, p.id]).catch(() => {});
  if (!["contacted", "question", "invited"].includes(p.status)) return log("not_waiting", { no: p.no, status: p.status });

  const full = await resend.emails.receiving.get(data.email_id).catch(() => null as any);
  const email = full?.data ?? null;
  if (!email) return log("error", { no: p.no, why: "couldn't fetch the email" });
  if (isAutoReply(email.subject ?? data.subject ?? "", email.headers ?? {})) return log("auto_reply", { no: p.no });

  const plain = email.text || String(email.html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  const text = stripQuotedReply(plain).slice(0, 2000);
  if (!text) return log("empty", { no: p.no });

  // Their message id, so Mo's answer lands in the same thread.
  const messageId = email.message_id ?? data.message_id ?? null;
  await pool.query(`UPDATE mo_prospects SET last_email_message_id = COALESCE($2, last_email_message_id), last_inbound_at = NOW(), updated_at = NOW() WHERE id = $1`, [p.id, messageId]);
  const prospect = { ...p, last_email_message_id: messageId ?? p.last_email_message_id, email: p.email ?? fromAddress };
  const action = await handleProspectReply(prospect, text, (msg) => sendMoEmailReply(prospect, msg));
  return log(action.startsWith("error") ? "error" : action, { no: p.no, text: text.slice(0, 300), ...(action.startsWith("error") ? { why: action } : {}) });
}
