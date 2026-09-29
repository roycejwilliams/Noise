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
// Mo reads their next text itself (mo/teamAgent.ts) and chooses what to do
// with its tools (mo/abilities.ts); a text about something else goes to Co
// as usual and the item stays open. These texts are never logged as
// conversation, so they don't reach the approver's own threads.
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { plainDone, plainNo, plainYes, MO, suppressionKeys } from "./rules.js";
import { sendMoEmailReply, sendingBlocked } from "./outreach.js";
import { introNeeded, MO_RULES } from "./moVoice.js";
import { isMoPaused } from "./team.js";
import { redraftOutreach } from "./draft.js";
import { sendDm } from "./xApi.js";
import { runMoTeamTurn, type TeamPending } from "./teamAgent.js";

type Approver = { id: string; firstName: string | null; phone: string; pendingNo: number | null; pendingKind: string | null };
export type PendingKind = "review" | "question" | "manual";

export async function approvers(): Promise<Approver[]> {
  const { rows } = await pool.query(
    `SELECT id, first_name, phone_number, mo_pending_no, mo_pending_kind FROM users WHERE mo_approver = true AND archived_at IS NULL AND phone_number IS NOT NULL`,
  );
  return rows.map((r: any) => ({ id: r.id, firstName: r.first_name ?? null, phone: r.phone_number, pendingNo: r.mo_pending_no, pendingKind: r.mo_pending_kind }));
}

async function textTo(phone: string, content: string): Promise<boolean> {
  const { default: sendblue, sendingAs } = await import("../services/sendblue.js");
  // Recorded as Mo's, so a reply under it comes back to Mo.
  return sendingAs("mo", () => sendblue.messages.send({ number: phone, content, from_number: process.env.SENDBLUE_PHONE_NUMBER! }))
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
export const firstName = (p: { name: string | null; x_handle: string | null }) => (p.name ?? "").trim().split(/\s+/)[0] || (p.x_handle ? `@${p.x_handle}` : "them");

// The texts, in Mo's own voice (mo/moVoice.ts): first person, a teammate
// with a view, their exact quote, and one plain question. Mo shares Co's
// number and thread, so it says it's Mo when that isn't obvious (introNeeded).
// One sentence of Mo's reason, so a review stays short (Royce, 2026-09-24:
// "Mo explanations may be a little bit too long").
export function firstSentence(text: string, max = 180): string {
  const t = String(text ?? "").trim();
  const one = t.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? t;
  return one.length <= max ? one : `${one.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

// A review arrives the way Co's tier offers do (Royce, 2026-09-24: "copy the
// same format of how we do the tiers"): the link alone first so it shows a
// preview, then one short line on who and why, then what Mo would send, then
// one question. Separate texts, in order.
// intro: who's texting, only when that isn't obvious (moVoice.ts introNeeded).
export function reviewMessages(p: any, left: number, intro = ""): string[] {
  const where = p.source === "x" ? "on X" : "on LinkedIn";
  const link = p.post_url ?? p.linkedin_url ?? null;
  const send =
    p.source === "x"
      ? [
          p.draft_reply ? `Co replies to their post: "${p.draft_reply}"` : null,
          `Then I DM them: "${p.draft_dm}"`,
          p.dm_style === "curious" && p.draft_why ? `If they ask why: "${p.draft_why}"` : null,
        ]
      : [
          `LinkedIn can't be messaged, so I'd email them from Co if I find a public address: "${p.draft_dm}"`,
          p.dm_style === "curious" && p.draft_why ? `If they ask why: "${p.draft_why}"` : null,
        ];
  return [
    link,
    `${intro ? `${intro} ` : ""}${who(p)} ${where}${left > 1 ? `, 1 of ${left}` : ""}. They wrote: "${p.evidence_quote}" ${firstSentence(p.reason)}`,
    send.filter(Boolean).join("\n\n"),
    `Want me to go for it? Yes, no, or tell me what to change.`,
  ].filter((m): m is string => Boolean(m));
}

// The same review as one text (for replies like "here's the new version").
export function reviewText(p: any, left: number, intro = ""): string {
  return reviewMessages(p, left, intro).join("\n\n");
}

export function questionText(p: any, intro = ""): string {
  return `${intro ? `${intro} ` : ""}${who(p)} wrote back: "${String(p.pending_question ?? "").slice(0, 400)}"\n\nWhat should I say? I'll send your answer word for word.`;
}

// Mo's last text to them, and whether anything came after it.
export async function lastOutboundTo(userId: string): Promise<{ sender: string; sentAt: Date } | null> {
  const { rows } = await pool
    .query(`SELECT sender, sent_at FROM outbound_messages WHERE user_id = $1 ORDER BY sent_at DESC LIMIT 1`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  return rows[0] ? { sender: String(rows[0].sender ?? "co"), sentAt: new Date(rows[0].sent_at) } : null;
}


// What an approver should see next, most urgent first: a prospect waiting on
// an answer, then a note to send by hand, then someone new to review.
async function nextItemFor(): Promise<{ kind: PendingKind; p: any } | null> {
  const q = await pool.query(`SELECT * FROM mo_prospects WHERE status = 'question' ORDER BY updated_at LIMIT 1`);
  if (q.rows[0]) return { kind: "question", p: q.rows[0] };
  // Paused: someone waiting on an answer still comes through; nothing new.
  if (await isMoPaused()) return null;
  const r = await pool.query(`SELECT * FROM mo_prospects WHERE status = 'shortlisted' ORDER BY no LIMIT 1`);
  if (r.rows[0]) return { kind: "review", p: r.rows[0] };
  return null;
}

async function shortlistedCount(): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM mo_prospects WHERE status = 'shortlisted'`);
  return rows[0]?.n ?? 0;
}

async function present(a: Approver, item: { kind: PendingKind; p: any }): Promise<void> {
  let texts: string[];
  const intro = MO_RULES.intro(introNeeded(await lastOutboundTo(a.id)));
  if (item.kind === "review") texts = reviewMessages(item.p, await shortlistedCount(), intro);
  else if (item.kind === "question") texts = [questionText(item.p, intro)];
  else return; // nothing is ever handed to the team to send (2026-09-24)
  // In order, stopping at the first failure so they never arrive half-shown.
  let ok = true;
  for (const t of texts) if (!(ok = await textTo(a.phone, t))) break;
  if (ok) {
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
export async function clearItem(no: number): Promise<void> {
  await pool.query(`UPDATE users SET mo_pending_no = NULL, mo_pending_kind = NULL, mo_pending_at = NULL WHERE mo_pending_no = $1`, [no]);
}

// Returns the text to send back, or null when this message isn't for Mo
// (then it goes to Co as usual). Mo reads it and decides (mo/teamAgent.ts);
// code only decides whether Mo should read it at all, so an approver's
// everyday texts to Co don't wait on Mo.
export async function handleMoReply(userId: string, content: string, opts: { repliedTo?: string | null; handedOff?: boolean } = {}): Promise<string | null> {
  const { rows } = await pool.query(`SELECT mo_approver, first_name, mo_pending_no, mo_pending_kind, mo_pending_at FROM users WHERE id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  const me = rows[0];
  if (!me?.mo_approver) return null;
  const text = content.trim();
  if (!text) return null;

  let pending: TeamPending = null;
  if (me.mo_pending_no) {
    const { rows: pr } = await pool.query(`SELECT * FROM mo_prospects WHERE no = $1`, [me.mo_pending_no]);
    const p = pr[0];
    const kind = me.mo_pending_kind as PendingKind;
    const still = p && ((kind === "review" && p.status === "shortlisted") || (kind === "question" && p.status === "question"));
    if (still) pending = { kind: kind as "review" | "question", p };
    else {
      // Someone else already handled it (or it's a leftover "send this
      // note" item from before 2026-09-24, which went back into Mo's own
      // outreach).
      await pool.query(`UPDATE users SET mo_pending_no = NULL, mo_pending_kind = NULL, mo_pending_at = NULL WHERE id = $1`, [userId]);
      if (p && kind !== "manual" && (plainYes(text) || plainNo(text) || plainDone(text))) {
        await presentNext();
        return `Someone already took care of that one.`;
      }
    }
  }

  // They pressed Reply on Mo's own text, or Co handed it over: it's Mo's,
  // whatever it says (2026-09-28: "What's the message?" under Mo's Harneet
  // question went to Co).
  const forMo = Boolean(opts.repliedTo) || Boolean(opts.handedOff);
  // Called by name with @Mo (Royce, 2026-09-28: "I like @Mo"). Talking
  // about Mo ("Mo already does that") stays with Co, which can hand off.
  const mentionsMo = callsMo(text);
  if (!forMo && !pending && !mentionsMo) return null;
  // Once Co has texted them since Mo asked, their next text is most likely
  // for Co; Mo still reads it when it names Mo or the person.
  const coSpoke = pending && !forMo ? await coSpokeSince(userId, me.mo_pending_at) : false;
  if (!forMo && pending && coSpoke && !namesThisItem(text, pending.p)) return null;

  const { moAwareness } = await import("./teamAgent.js");
  const awareness = await moAwareness(userId, text, opts).catch(() => null);
  const turn = await runMoTeamTurn({ userId, approverFirst: me.first_name ?? null, text, pending, coSpoke, awareness });
  // Handed over or replied to directly: Mo answers, never silently passes back.
  if (forMo && turn.reply === null) return opts.handedOff ? null : `That one's really for Co, I'll let Co take it.`;
  return turn.reply;
}

// "@Mo" anywhere in the text calls Mo in.
export function callsMo(text: string): boolean {
  return /(^|[^\w@])@mo\b/i.test(text);
}

export function namesThisItem(text: string, p: { name: string | null; x_handle: string | null }): boolean {
  const first = (p.name ?? "").trim().split(/\s+/)[0]?.toLowerCase();
  const t = text.toLowerCase();
  return callsMo(t) || (Boolean(first) && first.length >= 2 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, "")}\\b`).test(t)) || (Boolean(p.x_handle) && t.includes(`@${p.x_handle!.toLowerCase()}`));
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

// ------------------------------------------------------------ what Mo's tools do

type Done = { ok: true; say: string } | { ok: false; error: string };

// A question from a prospect: the approver's text goes to them word for
// word, on the channel they wrote from (2026-09-25: email replies too).
export async function sendAnswer(p: any, text: string): Promise<Done> {
  const name = firstName(p);
  const byEmail = p.channel === "email";
  if (!byEmail && text.length > 1000) return { ok: false, error: "That's too long for a DM. Ask them to trim it down." };
  try {
    if (byEmail) await sendMoEmailReply(p, text);
    else await sendDm(p.x_user_id, text);
  } catch (err: any) {
    return { ok: false, error: `It didn't go through to ${name}, so nothing went out. ${byEmail ? "The email service" : "X"} said: ${String(err?.message ?? err).slice(0, 120)}` };
  }
  await pool.query(`UPDATE mo_prospects SET status = 'contacted', pending_question = NULL, updated_at = NOW() WHERE id = $1`, [p.id]);
  await clearItem(p.no);
  await presentNext();
  return { ok: true, say: `Sent to ${name}. I'll let you know if they write back.` };
}

// Royce, 2026-09-24: "me nor jacqueline will never send anything for you...
// you will be sending it on behalf of the organization." LinkedIn can't be
// messaged by software, so a LinkedIn-only person gets an email from Co when
// Mo can find a public address.
export async function approveProspect(p: any, userId: string): Promise<Done> {
  const name = firstName(p);
  const r = await pool.query(
    `UPDATE mo_prospects SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'shortlisted' RETURNING *`,
    [p.id, userId],
  );
  await clearItem(p.no);
  if (!r.rows[0]) return { ok: false, error: `Someone already took care of ${name}.` };
  let say =
    p.source === "linkedin"
      ? `On it. ${name}'s only on LinkedIn, which I can't message, so I'll email them from Co if I can find a public address, and tell you if I can't.`
      : `On it. Co replies to ${name}'s post first, then I DM them about ${MO.warmToDmDays} days later.`;
  const blocked = sendingBlocked();
  if (blocked) say += ` Heads up: ${blocked}`;
  await presentNext();
  return { ok: true, say };
}

export async function skipProspect(p: any): Promise<Done> {
  await pool.query(`UPDATE mo_prospects SET status = 'skipped', updated_at = NOW() WHERE id = $1 AND status = 'shortlisted'`, [p.id]);
  await suppress(p, "skipped by approver");
  await clearItem(p.no);
  await presentNext();
  return { ok: true, say: `Got it, I'll leave ${firstName(p)} alone. They won't come up again.` };
}

export async function changeDraft(p: any, instruction: string): Promise<Done> {
  const drafts = await redraftOutreach(p, instruction);
  if (!drafts.ok) return { ok: false, error: `That change couldn't be made inside our rules (${drafts.failed.join(", ")}). Ask them to put it another way.` };
  await pool.query(`UPDATE mo_prospects SET draft_reply = $2, draft_dm = $3, updated_at = NOW() WHERE id = $1`, [p.id, drafts.reply, drafts.dm]);
  const updated = { ...p, draft_reply: drafts.reply, draft_dm: drafts.dm };
  // Only what changed: the new wording and the same question.
  const [, , send, ask] = ["", ...reviewMessages(updated, 1)].slice(-4);
  return { ok: true, say: `Here's the new version.\n\n${send}\n\n${ask}` };
}

export async function recordApproval(userId: string, kind: PendingKind, no: number, reply: string): Promise<void> {
  await recordDecision({ layer: 5, decision: "mo.approval", userId, outcome: "act", action: kind, proposal: { no }, reason: reply.slice(0, 300) }).catch(() => {});
}
