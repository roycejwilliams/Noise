// Mo, step 4: a person approves, in plain conversation (Royce,
// 2026-09-22: "make the replies to mo a lot simpler, it shouldn't use any
// abbreviated code").
//
// Approvers (users.mo_approver) get one thing at a time by text, and
// answer the way they'd answer a person:
//   - someone Mo found:        "yes", "no", or what to change ("make the DM shorter")
//   - a question from a prospect: their next text is the answer, sent as written
//   - a LinkedIn-only person:     "sent" once they've sent the note themselves
// Each approver has at most one open item (users.mo_pending_no/kind).
// Their next text is read against it first; a text about something else
// goes to Co as usual and the item stays open. These texts are never logged
// as conversation, so they don't reach the approver's own threads.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { generateInviteCode } from "../services/inviteCodes.js";
import { parseModelJson } from "../services/modelJson.js";
import { plainDone, plainNo, plainYes, MO, suppressionKeys } from "./rules.js";
import { codeMessage, sendingStatus, sendingBlocked } from "./outreach.js";
import { redraftOutreach } from "./draft.js";
import { sendDm } from "./xApi.js";

type Approver = { id: string; phone: string; pendingNo: number | null; pendingKind: string | null };
export type PendingKind = "review" | "question" | "manual";

export async function approvers(): Promise<Approver[]> {
  const { rows } = await pool.query(
    `SELECT id, phone_number, mo_pending_no, mo_pending_kind FROM users WHERE mo_approver = true AND archived_at IS NULL AND phone_number IS NOT NULL`,
  );
  return rows.map((r: any) => ({ id: r.id, phone: r.phone_number, pendingNo: r.mo_pending_no, pendingKind: r.mo_pending_kind }));
}

async function textTo(phone: string, content: string): Promise<boolean> {
  const { default: sendblue } = await import("../services/sendblue.js");
  return sendblue.messages
    .send({ number: phone, content, from_number: process.env.SENDBLUE_PHONE_NUMBER! })
    .then(() => true)
    .catch((err: any) => {
      console.error("mo: texting an approver failed:", err?.message ?? err);
      return false;
    });
}

export async function textApprovers(content: string): Promise<number> {
  let sent = 0;
  for (const a of await approvers()) if (await textTo(a.phone, content)) sent++;
  return sent;
}

// How a prospect is named to the team: their name and where they are.
export function who(p: { name: string | null; x_handle: string | null; source: string }): string {
  if (p.source === "x") return p.name ? `${p.name} (@${p.x_handle})` : `@${p.x_handle}`;
  return p.name ?? "someone on LinkedIn";
}
const firstName = (p: { name: string | null; x_handle: string | null }) => (p.name ?? "").trim().split(/\s+/)[0] || (p.x_handle ? `@${p.x_handle}` : "them");

// The texts. Plain words, their exact quote, and one clear question.
export function reviewText(p: any, left: number): string {
  const lines = [
    `Mo found someone${left > 1 ? ` (${left} to look at)` : ""}: ${who(p)}${p.source === "x" ? " on X" : " on LinkedIn"}.`,
    "",
    `They wrote: "${p.evidence_quote}"`,
    p.post_url ?? p.linkedin_url ?? "",
    "",
    `Why they'd fit: ${p.reason}`,
    "",
    p.source === "x" && p.draft_reply ? `Co would reply to their post: "${p.draft_reply}"` : null,
    p.source === "x" ? `Then DM them: "${p.draft_dm}"` : `The note you'd send them on LinkedIn: "${p.draft_dm}"`,
    "",
    `Should Co reach out? Reply yes, no, or tell me what to change.`,
  ];
  return lines.filter((l) => l !== null).join("\n").replace(/\n{3,}/g, "\n\n");
}

export function questionText(p: any): string {
  return `${who(p)} replied to Co's DM: "${String(p.pending_question ?? "").slice(0, 400)}"\n\nWhat should Co say back? Your next text goes to them as written.`;
}

export function manualText(p: any, code: string): string {
  return `${who(p)} is only on LinkedIn, so this one's yours to send: ${p.linkedin_url}\n\nThe message:\n${p.draft_dm}\n\n${codeMessage(code).replace(/^Glad you're in\. /, "If you'd like one: ")}\n\nText me "sent" once it's out.`;
}

// What an approver should see next, most urgent first: a prospect waiting on
// an answer, then a note to send by hand, then someone new to review.
async function nextItemFor(): Promise<{ kind: PendingKind; p: any } | null> {
  const q = await pool.query(`SELECT * FROM mo_prospects WHERE status = 'question' ORDER BY updated_at LIMIT 1`);
  if (q.rows[0]) return { kind: "question", p: q.rows[0] };
  const m = await pool.query(`SELECT * FROM mo_prospects WHERE status = 'manual_pending' ORDER BY updated_at LIMIT 1`);
  if (m.rows[0]) return { kind: "manual", p: m.rows[0] };
  const r = await pool.query(`SELECT * FROM mo_prospects WHERE status = 'shortlisted' ORDER BY no LIMIT 1`);
  if (r.rows[0]) return { kind: "review", p: r.rows[0] };
  return null;
}

async function shortlistedCount(): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM mo_prospects WHERE status = 'shortlisted'`);
  return rows[0]?.n ?? 0;
}

async function present(a: Approver, item: { kind: PendingKind; p: any }): Promise<void> {
  let text: string;
  if (item.kind === "review") text = reviewText(item.p, await shortlistedCount());
  else if (item.kind === "question") text = questionText(item.p);
  else text = manualText(item.p, item.p.invite_code);
  if (await textTo(a.phone, text)) {
    await pool.query(`UPDATE users SET mo_pending_no = $2, mo_pending_kind = $3, mo_pending_at = NOW() WHERE id = $1`, [a.id, item.p.no, item.kind]);
    await pool.query(`UPDATE mo_prospects SET digest_sent_at = COALESCE(digest_sent_at, NOW()) WHERE no = $1`, [item.p.no]);
  }
}

// Gives every approver with nothing open the next thing to look at. Called
// each morning, after every answer, and when a prospect asks a question.
export async function presentNext(): Promise<void> {
  const item = await nextItemFor();
  if (!item) return;
  for (const a of await approvers()) if (!a.pendingNo) await present(a, item);
}

// Morning: only when something is waiting.
export async function sendMoDigest(): Promise<void> {
  const before = (await approvers()).filter((a) => !a.pendingNo).length;
  await presentNext();
  await recordDecision({ layer: 5, decision: "mo.digest", userId: null, outcome: before ? "act" : "skip", action: `${before} approver(s) free, ${await shortlistedCount()} waiting` });
}

async function suppress(p: any, reason: string): Promise<void> {
  for (const key of suppressionKeys(p)) {
    await pool.query(`INSERT INTO mo_suppression (key, reason) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, reason]);
  }
}
export { suppress as suppressProspect };

// An item is done: nobody should still be asked about it.
async function clearItem(no: number): Promise<void> {
  await pool.query(`UPDATE users SET mo_pending_no = NULL, mo_pending_kind = NULL, mo_pending_at = NULL WHERE mo_pending_no = $1`, [no]);
}

// Is this text an answer to what Mo asked, or about something else?
async function readAnswer(kind: PendingKind, p: any, text: string): Promise<{ intent: "answer" | "change" | "other"; instruction?: string }> {
  const { text: out } = await generateText({
    model: anthropic(MODELS.haiku),
    experimental_telemetry: { isEnabled: true, functionId: "mo.readAnswer" },
    prompt:
      kind === "review"
        ? `Co asked a teammate: "Should Co reach out to ${who(p)}? Reply yes, no, or tell me what to change." Their reply: "${text.slice(0, 500)}"\n\nIf they're asking for a change to the message or the public reply, return {"intent": "change", "instruction": "the change, in their words"}. If the reply is about something else entirely, return {"intent": "other"}. Return ONLY JSON.`
        : `Co asked a teammate: "${who(p)} replied to Co's DM. What should Co say back? Your next text goes to them as written." Their reply: "${text.slice(0, 500)}"\n\nIs this their answer for ${who(p)} (a message meant for that person), or about something else? Return ONLY JSON: {"intent": "answer"} or {"intent": "other"}.`,
  });
  const r = parseModelJson<{ intent?: string; instruction?: string }>(out);
  if (r.intent === "change" && typeof r.instruction === "string" && r.instruction.trim()) return { intent: "change", instruction: r.instruction.trim() };
  if (r.intent === "answer") return { intent: "answer" };
  return { intent: "other" };
}

// Returns the text to send back, or null when this message isn't for Mo
// (then it goes to Co as usual).
export async function handleMoReply(userId: string, content: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT mo_approver, mo_pending_no, mo_pending_kind, mo_pending_at FROM users WHERE id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  const me = rows[0];
  if (!me?.mo_approver) return null;
  const text = content.trim();

  // "What did Mo find?" and the like: where things stand.
  if (!me.mo_pending_no && /\bmo\b/i.test(text)) {
    const waiting = await shortlistedCount();
    if (!waiting) return `Mo has nobody waiting for you right now. ${sendingStatus()}`;
    // The next person arrives as its own text; nothing else to say.
    await presentNext();
    return "";
  }
  if (!me.mo_pending_no) return null;

  const { rows: pr } = await pool.query(`SELECT * FROM mo_prospects WHERE no = $1`, [me.mo_pending_no]);
  const p = pr[0];
  const kind = me.mo_pending_kind as PendingKind;
  const still = p && ((kind === "review" && p.status === "shortlisted") || (kind === "question" && p.status === "question") || (kind === "manual" && p.status === "manual_pending"));
  if (!still) {
    // Someone else already handled it.
    await pool.query(`UPDATE users SET mo_pending_no = NULL, mo_pending_kind = NULL, mo_pending_at = NULL WHERE id = $1`, [userId]);
    if (plainYes(text) || plainNo(text) || plainDone(text)) {
      await presentNext();
      return `That one's already been handled.`;
    }
    return null;
  }

  // Once Co has texted them since Mo asked, a short "yes" is probably for Co,
  // so it only counts for Mo when it names the person or Mo.
  if (await coSpokeSince(userId, me.mo_pending_at) && !namesThisItem(text, p)) return null;
  const reply = await answer(userId, kind, p, text);
  if (reply === null) return null;
  await recordDecision({ layer: 5, decision: "mo.approval", userId, outcome: "act", action: kind, proposal: { no: p.no }, reason: reply.slice(0, 300) });
  return reply;
}

export function namesThisItem(text: string, p: { name: string | null; x_handle: string | null }): boolean {
  const first = (p.name ?? "").trim().split(/\s+/)[0]?.toLowerCase();
  const t = text.toLowerCase();
  return /\bmo\b/.test(t) || (Boolean(first) && first.length >= 2 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, "")}\\b`).test(t)) || (Boolean(p.x_handle) && t.includes(`@${p.x_handle!.toLowerCase()}`));
}

async function coSpokeSince(userId: string, since: Date | null): Promise<boolean> {
  if (!since) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'Co replied:%' AND created_at > $2
     UNION ALL SELECT 1 FROM proactive_sends WHERE user_id = $1 AND sent_at > $2 LIMIT 1`,
    [userId, since],
  );
  return rows.length > 0;
}

async function answer(userId: string, kind: PendingKind, p: any, text: string): Promise<string | null> {
  const name = firstName(p);

  if (kind === "manual") {
    if (!plainDone(text)) return null;
    await pool.query(`UPDATE mo_prospects SET status = 'contacted', channel = 'manual', contacted_at = NOW(), updated_at = NOW() WHERE id = $1`, [p.id]);
    await clearItem(p.no);
    await presentNext();
    return `Got it, ${name}'s note is marked as sent.`;
  }

  if (kind === "question") {
    const r = await readAnswer("question", p, text);
    if (r.intent !== "answer") return null;
    if (text.length > 1000) return "That's too long for a DM. Could you shorten it?";
    try {
      await sendDm(p.x_user_id, text);
    } catch (err: any) {
      return `That didn't go through to ${name}, so nothing was sent. X said: ${String(err?.message ?? err).slice(0, 120)}`;
    }
    await pool.query(`UPDATE mo_prospects SET status = 'contacted', pending_question = NULL, updated_at = NOW() WHERE id = $1`, [p.id]);
    await clearItem(p.no);
    await presentNext();
    return `Sent to ${name}.`;
  }

  // review
  if (plainYes(text)) {
    const r = await pool.query(
      `UPDATE mo_prospects SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'shortlisted' RETURNING *`,
      [p.id, userId],
    );
    await clearItem(p.no);
    let msg: string;
    if (r.rows[0] && p.source === "linkedin") {
      const code = await generateInviteCode(null);
      await pool.query(`UPDATE mo_prospects SET invite_code = $2, status = 'manual_pending', updated_at = NOW() WHERE id = $1`, [p.id, code]);
      msg = `Great. Since ${name} is only on LinkedIn, I'll send you the note to post next.`;
    } else {
      msg = `Great. Co will reply to ${name}'s post first, then DM them about ${MO.warmToDmDays} days later.`;
      const blocked = sendingBlocked();
      if (blocked) msg += ` Heads up: ${blocked}`;
    }
    await presentNext();
    return msg;
  }
  if (plainNo(text)) {
    await pool.query(`UPDATE mo_prospects SET status = 'skipped', updated_at = NOW() WHERE id = $1 AND status = 'shortlisted'`, [p.id]);
    await suppress(p, "skipped by approver");
    await clearItem(p.no);
    await presentNext();
    return `Okay, Mo won't reach out to ${name}, and they won't come up again.`;
  }
  const r = await readAnswer("review", p, text);
  if (r.intent !== "change") return null;
  const drafts = await redraftOutreach(p, r.instruction!);
  if (!drafts.ok) return `I couldn't make that change and keep it within the rules (${drafts.failed.join(", ")}). Could you put it another way?`;
  await pool.query(`UPDATE mo_prospects SET draft_reply = $2, draft_dm = $3, updated_at = NOW() WHERE id = $1`, [p.id, drafts.reply, drafts.dm]);
  const updated = { ...p, draft_reply: drafts.reply, draft_dm: drafts.dm };
  return `${reviewText(updated, 1).replace(/^Mo found someone[^\n]*\n\n/, "Here's the new version.\n\n")}`;
}
