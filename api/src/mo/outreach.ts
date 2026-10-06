// Mo, steps 5–7: everything after a person approves. The warm-up reply
// to their post, the DM a couple of days later (or the email, or a LinkedIn
// note sent by hand), one follow-up, reading their replies, the code on a
// yes, and the do-not-contact list on a no. Only ever for approved prospects,
// under a daily cap, during daytime hours.
import { proactivePaused } from "../services/proactivePause.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { createHmac, timingSafeEqual } from "crypto";
import { DateTime } from "luxon";
import { Resend } from "resend";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { generateInviteCode } from "../services/inviteCodes.js";
import { inviteLink } from "../services/invites.js";
import { readPageText, reserveWebSearch } from "../services/webOpportunitySearch.js";
import { parseModelJson } from "../services/modelJson.js";
import { clearStop, clearYes, nextOutreachStep, MO, suppressionKeys } from "./rules.js";
import { isDmClosed, likePost, recentDmEvents, replyToPost, sendDm, xWriteConfigured } from "./xApi.js";
import { presentNext, suppressProspect, textApprovers } from "./review.js";
import { readReplyWithJev } from "./jev.js";
import { causeOf, getHealth, inBackoff, nextHealth, setHealth, type Cause } from "./health.js";
import { moEmail } from "../services/emailDesign.js";

export function moEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MO_ENABLED === "true";
}
export function emailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  // The opt-out link is signed, so there has to be a secret to sign it with.
  return Boolean(env.RESEND_API_KEY && env.MO_FROM_EMAIL && env.MO_POSTAL_ADDRESS && env.API_URL && (env.MO_UNSUBSCRIBE_SECRET || env.JWT_SECRET));
}

// Replies to Mo's emails come back to Mo (mo/emailReplies.ts).
export function emailRepliesConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.MO_REPLY_DOMAIN && env.RESEND_WEBHOOK_SECRET);
}

// Why nothing can go out yet, in plain words, or null when it can.
export function sendingBlocked(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!moEnabled(env)) return "Mo is switched off, so nothing goes out yet.";
  if (proactivePaused(env)) return "Outreach is paused, so nothing goes out until it is lifted.";
  if (!xWriteConfigured(env)) return "Co's X account isn't connected yet, so nothing goes out until it is.";
  return null;
}

// What can actually go out right now, in plain words, for the team.
export function sendingStatus(env: NodeJS.ProcessEnv = process.env): string {
  const x = xWriteConfigured(env);
  const email = emailConfigured(env);
  // Mo's own words, first person (mo/moVoice.ts).
  if (!moEnabled(env)) return "I'm switched off right now (MO_ENABLED isn't true), so nothing goes out.";
  if (!x && !email) return "Co's X keys and the outreach email settings aren't set yet, so nothing goes out until they are.";
  if (!x) return "Co's X keys aren't set, so no replies or DMs go out yet. Email works when I find a published address.";
  if (!email) return "X replies and DMs go out. Email isn't set up, so people with closed DMs get marked unreachable.";
  if (!emailRepliesConfigured(env)) return "X replies, DMs and email are all set up. Replies to my emails still go to the hello@ inbox, since MO_REPLY_DOMAIN or RESEND_WEBHOOK_SECRET isn't set.";
  return "X replies, DMs and email are all set up, and I read replies to my emails.";
}

const coNumber = () => process.env.SENDBLUE_PHONE_NUMBER ?? "Co's number";

// On a yes (Royce, 2026-09-22: "send them an invite code and a link"): the
// invite page (routes/invitePage.ts, /i/<code>) opens a text to Co with the
// code already filled in. The code is spelled out too, in case the link
// doesn't open. Without a public base URL, the number instead.
export function codeMessage(code: string, link: string | null = inviteLink(code)): string {
  return link
    ? `Glad you're in. Here's your invite: ${link}\n\nIt opens a text to Co with your code (${code}) already filled in. Send it and we'll start there.`
    : `Glad you're in. Your invite code is ${code}. Text it to Co at ${coNumber()} and we'll start there.`;
}

// Daytime in the club's city.
export function moHours(now: Date): boolean {
  const h = DateTime.fromJSDate(now).setZone("America/Los_Angeles").hour;
  return h >= 10 && h < 18;
}

async function sentToday(column: "warmed_at" | "contacted_at" | "followed_up_at"): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM mo_prospects WHERE ${column} > NOW() - INTERVAL '24 hours'`);
  return rows[0]?.n ?? 0;
}

async function isSuppressed(p: any): Promise<boolean> {
  const keys = suppressionKeys(p);
  if (!keys.length) return false;
  const { rows } = await pool.query(`SELECT 1 FROM mo_suppression WHERE key = ANY($1::text[]) LIMIT 1`, [keys]);
  return Boolean(rows[0]);
}

export function unsubscribeToken(prospectId: string): string {
  const secret = process.env.MO_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("mo: no secret to sign opt-out links");
  return createHmac("sha256", secret).update(`mo-unsub:${prospectId}`).digest("hex").slice(0, 32);
}

export function tokenMatches(prospectId: string, token: string): boolean {
  let expected: string;
  try {
    expected = unsubscribeToken(prospectId);
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

// A public work email, only if it's actually on a page of theirs.
async function findEmail(p: any): Promise<string | null> {
  const budget = await reserveWebSearch(null, "sweep", `mo email: ${p.name ?? p.x_handle}`);
  if (!budget.ok) return null;
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 2 }) },
    stopWhen: stepCountIs(3),
    timeout: 60_000,
    experimental_telemetry: { isEnabled: true, functionId: "mo.findEmail" },
    prompt: `Find a public work email for ${p.name ?? ""}${p.x_handle ? ` (@${p.x_handle} on X)` : ""}${p.bio ? `, bio: "${String(p.bio).slice(0, 160)}"` : ""}, published on their own website or their company's site (not a data broker or directory). Return ONLY JSON: {"email": "..." or null, "url": "the page it's on" or null}`,
  });
  const r = parseModelJson<{ email?: string | null; url?: string | null }>(text);
  if (!r.email || !r.url || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(r.email)) return null;
  const page = await readPageText(r.url);
  return page && page.toLowerCase().includes(r.email.toLowerCase()) ? r.email.toLowerCase() : null;
}

// Where replies to Mo's emails go (2026-09-25). With MO_REPLY_DOMAIN set to
// the account's Resend receiving domain (<id>.resend.app, or a custom one
// with Resend's MX records), each prospect gets their own signed address,
// so a reply maps back to them even from another inbox. Resend posts it to
// /mo/email/inbound (mo/emailReplies.ts), and Mo reads it the same way it
// reads a DM reply. Without it, replies go to the hello@ inbox as before and
// nothing reads them.
export function moReplyAddress(prospectId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const domain = env.MO_REPLY_DOMAIN?.trim().toLowerCase();
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  let sig: string;
  try {
    sig = unsubscribeToken(prospectId).slice(0, 12);
  } catch {
    return null;
  }
  return `reply-${prospectId}-${sig}@${domain}`;
}

// The prospect a reply address belongs to, or null when it's not one of
// Mo's or the signature doesn't match.
export function prospectFromReplyAddress(address: string): string | null {
  const m = String(address).toLowerCase().match(/reply-([0-9a-f-]{36})-([0-9a-f]{12})@/);
  if (!m) return null;
  let expected: string;
  try {
    expected = unsubscribeToken(m[1]).slice(0, 12);
  } catch {
    return null;
  }
  const a = Buffer.from(m[2]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? m[1] : null;
}


// Mo answering an email reply, in the same thread.
export async function sendMoEmailReply(p: any, text: string): Promise<void> {
  if (!emailConfigured() || !p.email) throw new Error("email isn't set up");
  const unsub = `${process.env.API_URL}/mo/unsubscribe?p=${p.id}&t=${unsubscribeToken(p.id)}`;
  const subject = String(p.draft_email_subject ?? "Co");
  const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
    from: process.env.MO_FROM_EMAIL!,
    to: [p.email],
    replyTo: moReplyAddress(p.id) ?? "hello@copatible.com",
    subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
    html: moEmail({ preview: text.slice(0, 120), paragraphs: text.split(/\n{2,}/), invite: null, unsubscribeUrl: unsub, postalAddress: String(process.env.MO_POSTAL_ADDRESS ?? "") }),
    headers: {
      "List-Unsubscribe": `<${unsub}>`,
      ...(p.last_email_message_id ? { "In-Reply-To": p.last_email_message_id, References: p.last_email_message_id } : {}),
    },
  });
  if (error) throw new Error(error.message);
}

async function sendMoEmail(p: any, followUp: boolean): Promise<boolean> {
  if (!emailConfigured() || !p.email || !process.env.SENDBLUE_PHONE_NUMBER) return false;
  const code = p.invite_code ?? (await generateInviteCode(null));
  const unsub = `${process.env.API_URL}/mo/unsubscribe?p=${p.id}&t=${unsubscribeToken(p.id)}`;
  // The button texts Co (Royce, 2026-09-25): a sentence asking them to text
  // a number, left in older drafts, is dropped. The number only shows when
  // there's no invite link for the button.
  const link = inviteLink(code);
  let body = String(p.draft_email_body ?? "")
    .replace(/[^.!?\n]*\{\{PHONE\}\}[^.!?\n]*[.!?]?/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .split("{{CODE}}")
    .join(code);
  if (!link) body = `${body.replace(/\n+Mo\s*$/, "")}\n\nText your code to Co at ${coNumber()}.\n\nMo`;
  const lead = followUp ? "Following up once, in case this got buried.\n\n" : "";
  // Mo's letterhead (services/emailDesign.ts moEmail).
  const paragraphs = (lead + body).split(/\n{2,}/);
  const html = moEmail({
    preview: paragraphs[0]?.slice(0, 120) ?? "",
    paragraphs,
    invite: link ? { href: link } : null,
    unsubscribeUrl: unsub,
    postalAddress: String(process.env.MO_POSTAL_ADDRESS ?? ""),
  });
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: process.env.MO_FROM_EMAIL!,
    to: [p.email],
    replyTo: moReplyAddress(p.id) ?? "hello@copatible.com",
    subject: followUp ? `Re: ${p.draft_email_subject}` : p.draft_email_subject,
    html,
    headers: { "List-Unsubscribe": `<${unsub}>` },
  });
  if (error) throw new Error(error.message);
  if (!p.invite_code) await pool.query(`UPDATE mo_prospects SET invite_code = $2 WHERE id = $1`, [p.id, code]);
  return true;
}

async function warm(p: any): Promise<string> {
  if (!xWriteConfigured()) return "x_keys_missing";
  let replyId: string | null = null;
  if (p.draft_reply && p.post_id) replyId = await replyToPost(p.post_id, p.draft_reply);
  if (p.post_id) await likePost(p.post_id).catch(() => {});
  await pool.query(`UPDATE mo_prospects SET status = 'warmed', warmed_at = NOW(), warm_reply_id = $2, updated_at = NOW() WHERE id = $1`, [p.id, replyId]);
  return "warmed";
}

async function contact(p: any): Promise<string> {
  if (p.x_user_id && xWriteConfigured()) {
    try {
      await sendDm(p.x_user_id, p.draft_dm);
      await pool.query(`UPDATE mo_prospects SET status = 'contacted', channel = 'dm', contacted_at = NOW(), updated_at = NOW() WHERE id = $1`, [p.id]);
      return "dm_sent";
    } catch (err) {
      if (!isDmClosed(err)) throw err;
    }
  }
  // DMs closed: their own published email, if there is one.
  const email = p.email ?? (await findEmail(p).catch(() => null));
  if (email && !(await isSuppressed({ email }))) {
    await pool.query(`UPDATE mo_prospects SET email = $2 WHERE id = $1`, [p.id, email]);
    if (await sendMoEmail({ ...p, email }, false)) {
      await pool.query(`UPDATE mo_prospects SET status = 'contacted', channel = 'email', contacted_at = NOW(), updated_at = NOW() WHERE id = $1`, [p.id]);
      return "email_sent";
    }
  }
  await pool.query(`UPDATE mo_prospects SET status = 'unreachable', updated_at = NOW() WHERE id = $1`, [p.id]);
  return email ? "email_not_configured" : "unreachable";
}

async function followUp(p: any): Promise<string> {
  if (p.channel === "dm") {
    await sendDm(p.x_user_id, "Following up once in case this got buried. If an invite isn't for you, no worries at all.");
  } else if (p.channel === "email") {
    if (!(await sendMoEmail(p, true))) return "email_not_configured";
  } else return "no_follow_up_for_channel";
  await pool.query(`UPDATE mo_prospects SET followed_up_at = NOW(), updated_at = NOW() WHERE id = $1`, [p.id]);
  return "followed_up";
}

// Hourly, daytime only.
export async function runMoOutreach(now = new Date()): Promise<void> {
  if (!moEnabled() || proactivePaused() || !moHours(now)) return;
  // Joined: their code was used. Usually caught the moment it's redeemed
  // (services/inviteCodes.ts); this is the backup. Either way the team hears.
  const { rows: joined } = await pool.query(
    `UPDATE mo_prospects sp SET status = 'joined', joined_at = NOW(), joined_user_id = ic.used_by, updated_at = NOW() FROM invite_codes ic
     WHERE ic.code = sp.invite_code AND ic.used_by IS NOT NULL AND sp.status <> 'joined' RETURNING sp.*`,
  );
  const { tellTeamAboutJoins, isMoPaused } = await import("./team.js");
  await tellTeamAboutJoins(joined);
  if (await isMoPaused()) return;
  // Failing run after run: hold off for a few hours instead of retrying and
  // texting every hour (mo/health.ts).
  const health = await getHealth("outreach_health");
  if (inBackoff(health, now)) return;
  const { rows } = await pool.query(
    `SELECT * FROM mo_prospects WHERE status IN ('approved', 'warmed', 'contacted') ORDER BY approved_at NULLS LAST, no LIMIT 50`,
  );
  const report: string[] = [];
  const failures: { cause: Cause; who: string }[] = [];
  let sendsOk = 0;
  let warmedToday = await sentToday("warmed_at");
  let outboundToday = (await sentToday("contacted_at")) + (await sentToday("followed_up_at"));
  for (const p of rows) {
    const step = nextOutreachStep(
      {
        status: p.status,
        hasPost: Boolean(p.post_id),
        channel: p.channel,
        warmedAt: p.warmed_at,
        contactedAt: p.contacted_at,
        followedUpAt: p.followed_up_at,
        lastInboundAt: p.last_inbound_at,
      },
      now,
    );
    if (!step) continue;
    if (step !== "close_silent" && (await isSuppressed(p))) {
      await pool.query(`UPDATE mo_prospects SET status = 'closed', updated_at = NOW() WHERE id = $1`, [p.id]);
      continue;
    }
    if (step === "warm" && warmedToday >= MO.dailyCap) continue;
    if ((step === "contact" || step === "follow_up") && outboundToday >= MO.dailyCap) continue;
    let action: string;
    try {
      if (step === "warm") action = await warm(p);
      else if (step === "contact") action = await contact(p);
      else if (step === "follow_up") action = await followUp(p);
      else {
        await pool.query(`UPDATE mo_prospects SET status = 'closed', updated_at = NOW() WHERE id = $1`, [p.id]);
        await suppressProspect(p, "no reply after a follow-up");
        action = "closed_silent";
      }
    } catch (err: any) {
      action = `error: ${String(err?.message ?? err).slice(0, 200)}`;
    }
    const who = p.name ? p.name.trim().split(/\s+/)[0] : p.x_handle ? `@${p.x_handle}` : "someone";
    const line: Record<string, string> = {
      warmed: `replied publicly to ${who}'s post`,
      dm_sent: `DMed ${who}`,
      email_sent: `emailed ${who} (their DMs are closed)`,
      followed_up: `followed up once with ${who}`,
      closed_silent: `closed ${who} (no reply after the follow-up)`,
      unreachable: `couldn't reach ${who}: DMs closed and no published email`,
      email_not_configured: `couldn't reach ${who}: DMs closed and email isn't set up`,
    };
    if (line[action]) report.push(line[action][0].toUpperCase() + line[action].slice(1));
    else if (action.startsWith("error")) failures.push({ cause: causeOf(action), who });
    if (action === "warmed") warmedToday++;
    if (["dm_sent", "email_sent", "followed_up"].includes(action)) outboundToday++;
    if (["warmed", "dm_sent", "email_sent", "followed_up"].includes(action)) sendsOk++;
    await recordDecision({
      layer: 5,
      decision: "mo.outreach",
      userId: null,
      outcome: action.startsWith("error") || action.includes("missing") || action.includes("not_configured") ? "skip" : "act",
      action,
      proposal: { no: p.no, step, channel: p.channel },
    });
  }
  // Only what was recorded as actually happening.
  // Failures are told once, grouped by cause, and again when they clear
  // (mo/health.ts); the rest of the run reads as before.
  const outcome = nextHealth(health, { ok: sendsOk, failed: failures }, now, { kind: "sending" });
  await setHealth("outreach_health", outcome.health);
  if (outcome.message) report.push(outcome.message.replace(/\.$/, ""));
  if (report.length) await textApprovers(`Mo update:\n${report.join(".\n")}.`);
}

export async function classifyReply(text: string): Promise<"yes" | "no" | "question"> {
  if (clearStop(text)) return "no";
  if (clearYes(text)) return "yes";
  // Jev next (mo/jev.ts); only a clear answer is used, anything else goes to Claude.
  const jev = await readReplyWithJev(text);
  await recordDecision({ layer: 5, decision: "mo.jev.reply", userId: null, outcome: jev.verdict ? "act" : "skip", action: jev.verdict ?? (jev.p ? "unsure" : "unavailable"), proposal: { p: jev.p } });
  if (jev.verdict) return jev.verdict;
  const { text: out } = await generateText({
    model: anthropic(MODELS.haiku),
    experimental_telemetry: { isEnabled: true, functionId: "mo.classifyReply" },
    prompt: `Co invited someone to a private club by DM and asked if they'd like an invite. Their reply: "${text.slice(0, 500)}"\n\nAnswer with one word: yes (they want the invite), no (they don't, or want to be left alone), or question (anything else, including questions).`,
  });
  const w = out.trim().toLowerCase();
  return w.startsWith("yes") ? "yes" : w.startsWith("no") ? "no" : "question";
}

// Every 15 minutes: replies in Co's X DMs from people Mo contacted.
export async function runMoInbox(): Promise<void> {
  if (!moEnabled() || !xWriteConfigured()) return;
  let readFailure: string | null = null;
  const events = await recentDmEvents().catch((err: any) => {
    console.error("mo: reading DMs failed:", err?.message ?? err);
    readFailure = String(err?.message ?? err);
    return [];
  });
  // A reader that fails says so after two runs in a row (it used to say
  // nothing), and says when it's back (mo/health.ts).
  {
    const inboxHealth = await getHealth("inbox_health");
    const outcome = nextHealth(inboxHealth, readFailure ? { ok: 0, failed: [{ cause: causeOf(readFailure), who: "replies" }] } : { ok: 1, failed: [] }, new Date(), { kind: "replies", notifyAfterRuns: 2, backoffRuns: 99 });
    if (outcome.health.cause !== inboxHealth.cause || outcome.health.runs !== inboxHealth.runs || outcome.health.notifiedAt !== inboxHealth.notifiedAt) await setHealth("inbox_health", outcome.health);
    if (outcome.message) await textApprovers(outcome.message);
  }
  const coId = process.env.X_MO_USER_ID;
  const inbound = events.filter((e) => e.senderId !== coId).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  for (const e of inbound) {
    const { rows } = await pool.query(
      `SELECT * FROM mo_prospects WHERE x_user_id = $1 AND status IN ('contacted', 'question', 'invited')`,
      [e.senderId],
    );
    const p = rows[0];
    if (!p || (p.last_dm_event_id && BigInt(p.last_dm_event_id) >= BigInt(e.id))) continue;
    await pool.query(`UPDATE mo_prospects SET last_dm_event_id = $2, last_inbound_at = NOW(), updated_at = NOW() WHERE id = $1`, [p.id, e.id]);
    const action = await handleProspectReply(p, e.text, (msg) => sendDm(p.x_user_id, msg));
    await recordDecision({ layer: 5, decision: "mo.reply", userId: null, outcome: action.startsWith("error") ? "skip" : "act", action, proposal: { no: p.no, channel: "dm", text: e.text.slice(0, 300) } });
  }
}

// One reply from a prospect, by DM or email: read it (clear words, then Jev,
// then Claude), then act. A no ends it, a yes gets the invite, anything
// else goes to a free approver. `send` answers on the channel it came in on.
export async function handleProspectReply(p: any, text: string, send: (msg: string) => Promise<unknown>): Promise<string> {
  // Their own words, kept so Co can pick up from them if they join
  // (services/extensions.ts handoff). Only ever shown in their own thread.
  await pool
    .query(`UPDATE mo_prospects SET their_words = (their_words || jsonb_build_array(jsonb_build_object('at', NOW(), 'text', $2::text))) WHERE id = $1`, [p.id, text.slice(0, 500)])
    .catch(() => {});
  const kind = p.status === "invited" && !clearStop(text) ? "question" : await classifyReply(text);
  let action: string = kind;
  try {
    if (kind === "no") {
      await suppressProspect(p, "declined");
      await pool.query(`UPDATE mo_prospects SET status = 'declined', updated_at = NOW() WHERE id = $1`, [p.id]);
      await Promise.resolve(send("Understood. I won't reach out again. Good luck with everything.")).catch(() => {});
    } else if (kind === "yes" && p.status !== "invited") {
      const code = p.invite_code ?? (await generateInviteCode(null));
      // "Want to know why?" got a yes: the why Mo drafted, then the invite.
      await send(p.dm_style === "curious" && p.draft_why ? `${p.draft_why}\n\n${codeMessage(code)}` : codeMessage(code));
      await pool.query(`UPDATE mo_prospects SET status = 'invited', invite_code = $2, updated_at = NOW() WHERE id = $1`, [p.id, code]);
      action = "code_sent";
    } else {
      await pool.query(`UPDATE mo_prospects SET status = 'question', pending_question = $2, updated_at = NOW() WHERE id = $1`, [p.id, text.slice(0, 500)]);
      // Goes to a free approver as a plain question (review.ts).
      await presentNext();
      action = "asked_approver";
    }
  } catch (err: any) {
    action = `error: ${String(err?.message ?? err).slice(0, 200)}`;
  }
  return action;
}

// GET /mo/unsubscribe?p=<id>&t=<token>
export async function unsubscribe(prospectId: string, token: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(prospectId) || !tokenMatches(prospectId, token)) return false;
  const { rows } = await pool.query(`UPDATE mo_prospects SET status = 'declined', updated_at = NOW() WHERE id = $1 RETURNING *`, [prospectId]).catch(() => ({ rows: [] as any[] }));
  if (!rows[0]) return false;
  await suppressProspect(rows[0], "unsubscribed");
  await recordDecision({ layer: 5, decision: "mo.reply", userId: null, outcome: "act", action: "unsubscribed", proposal: { no: rows[0].no } });
  return true;
}
