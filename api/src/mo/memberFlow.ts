// Member-facing Mo, the state machine (spec: "Member-facing Mo: the club reaches out for you").
//
//   opt-in -> hunt -> voice -> batch -> approach -> reply (front desk) -> invite -> joined -> intro (both yes)
//
// Nothing here talks to a stranger on its own authority: every send goes through sendContact(), which re-checks every
// rule in mo/memberRules.ts at the moment of sending and writes the receipt FIRST. Reading a member's rows is always by
// their own user id. The team's mo_prospects are never read for a member and member rows are never shown to the team
// beyond counts.
import pool from "../db/db.js";
import { DateTime } from "luxon";
import { recordDecision } from "../harness/core.js";
import { MO, suppressionKeys, clearStop, clearYes } from "./rules.js";
import { MEMBER_MO, approachProblem, contactVerdict, shouldAutoPause, type ContactState } from "./memberRules.js";

export type Found = { xUserId: string | null; handle: string | null; name: string | null; email?: string | null; source: string; postText: string; quote: string; why: string };
export type CandidateRow = {
  id: string; batch_id: string; user_id: string; n: number; x_user_id: string | null; x_handle: string | null; name: string | null; email: string | null; source: string;
  post_text: string | null; evidence_quote: string; why: string; status: string; approved_at: Date | null; approved_quote: string | null; contacted_at: Date | null;
  channel: string | null; followed_up_at: Date | null; replied_at: Date | null; invite_code: string | null; joined_user_id: string | null; last_dm_event_id?: string | null;
};

const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
const first = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0] ?? "";
export const personLabel = (c: { name: string | null; x_handle: string | null }) => (c.name?.trim() ? first(c.name) : c.x_handle ? `@${c.x_handle}` : "this person");

// ---------------------------------------------------------------- opt-in and stop

export async function optInRow(userId: string): Promise<any | null> {
  const { rows } = await q(`SELECT * FROM mo_member_optin WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  return rows[0] ?? null;
}

export async function noteOptInAsked(userId: string): Promise<void> {
  await q(`INSERT INTO mo_member_optin (user_id, asked_at) VALUES ($1, NOW()) ON CONFLICT (user_id) DO UPDATE SET asked_at = COALESCE(mo_member_optin.asked_at, NOW())`, [userId]);
}

// Their yes or no to Mo at all. A no is final until they say otherwise, and cancels everything not yet sent.
export async function recordOptIn(userId: string, answer: "yes" | "no", quote: string): Promise<{ ok: boolean }> {
  const row = await optInRow(userId);
  if (!row?.asked_at) return { ok: false }; // there was no question to answer
  await q(`UPDATE mo_member_optin SET status = $2, answered_at = NOW(), quote = $3, paused_at = CASE WHEN $2 = 'yes' THEN NULL ELSE paused_at END WHERE user_id = $1`, [userId, answer, quote.slice(0, 200)]);
  if (answer === "no") await cancelOpen(userId);
  await recordDecision({ layer: 6, decision: "mo.member.optin", userId, outcome: "act", action: answer, proposal: {} }).catch(() => {});
  return { ok: true };
}

// "Stop": nothing more goes out for them, and what is queued is cancelled. Always honored, whatever else is open.
export async function stopMo(userId: string, quote: string): Promise<void> {
  await q(`INSERT INTO mo_member_optin (user_id, paused_at, quote) VALUES ($1, NOW(), $2) ON CONFLICT (user_id) DO UPDATE SET paused_at = NOW(), quote = $2`, [userId, quote.slice(0, 200)]);
  await cancelOpen(userId);
  await recordDecision({ layer: 6, decision: "mo.member.stop", userId, outcome: "act", action: "stopped", proposal: {} }).catch(() => {});
}

async function cancelOpen(userId: string): Promise<void> {
  await q(`UPDATE mo_member_candidates SET status = 'skipped' WHERE user_id = $1 AND status IN ('pending', 'approved')`, [userId]);
  await q(`UPDATE mo_member_batches SET status = 'cancelled' WHERE user_id = $1 AND status IN ('open', 'approved')`, [userId]);
}

// ---------------------------------------------------------------- hunt storage

export async function openBatch(userId: string): Promise<{ id: string; need_text: string; ask_text: string; status: string; expires_at: Date; presented_at: Date | null } | null> {
  const { rows } = await q(`SELECT id, need_text, ask_text, status, expires_at, presented_at FROM mo_member_batches WHERE user_id = $1 AND status IN ('open', 'approved') AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`, [userId]).catch(() => ({ rows: [] as any[] }));
  return rows[0] ?? null;
}

export function huntAllowed(o: { optIn: "yes" | "no" | null; paused: boolean; lastHuntAt: Date | null; openBatch: boolean; now: Date }): { ok: boolean; why: string | null } {
  if (o.optIn !== "yes") return { ok: false, why: "the member hasn't said yes to Mo" };
  if (o.paused) return { ok: false, why: "the member told Mo to stop" };
  if (o.openBatch) return { ok: false, why: "a batch is already open" };
  if (o.lastHuntAt && (o.now.getTime() - o.lastHuntAt.getTime()) / 86400_000 < 7 / MEMBER_MO.huntsPerMemberPerWeek) return { ok: false, why: "already hunted this week" };
  return { ok: true, why: null };
}

// At most 3 people, each backed by a quote of their own; the batch expires unsent after 3 days.
export async function storeBatch(userId: string, askText: string, needText: string, found: Found[], now = new Date()): Promise<string | null> {
  const people = found.slice(0, MEMBER_MO.perBatch);
  if (!people.length) return null;
  const { rows } = await q(
    `INSERT INTO mo_member_batches (user_id, ask_text, need_text, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, askText.slice(0, 400), needText.slice(0, 200), new Date(now.getTime() + MEMBER_MO.batchLifeDays * 86400_000)],
  );
  const batchId = rows[0].id as string;
  let n = 1;
  for (const f of people) {
    await q(
      `INSERT INTO mo_member_candidates (batch_id, user_id, n, x_user_id, x_handle, name, email, source, post_text, evidence_quote, why) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [batchId, userId, n++, f.xUserId, f.handle, f.name, f.email ?? null, f.source, f.postText.slice(0, 600), f.quote.slice(0, 300), f.why.slice(0, 240)],
    );
  }
  await q(`UPDATE mo_member_optin SET hunt_last_at = NOW() WHERE user_id = $1`, [userId]);
  return batchId;
}

export async function candidatesOf(batchId: string, userId: string): Promise<CandidateRow[]> {
  const { rows } = await q(`SELECT * FROM mo_member_candidates WHERE batch_id = $1 AND user_id = $2 ORDER BY n`, [batchId, userId]);
  return rows;
}

// ---------------------------------------------------------------- voice

// The message a stranger gets, built in code from the member's approved voice and one line on why this person. The
// member approves the voice once and sees each person's exact message in the batch, so what is sent is what they saw.
export const DEFAULT_VOICE = "Hi, I'm Mo. I help Co, a small private club in San Francisco. {member} is looking for {need}, and what you posted made me think of you.";
export function memberRef(named: boolean, firstName: string): string {
  // {member} always starts a sentence in the voice templates (code-made; the member approves or declines them whole).
  return named && firstName.trim() ? firstName.trim() : "A member of the club";
}
export function composeApproach(voice: string, o: { named: boolean; memberFirstName: string; need: string; why: string }): string {
  const lead = voice.split("{member}").join(memberRef(o.named, o.memberFirstName)).split("{need}").join(o.need.replace(/[.!?]+$/, ""));
  return `${lead}\n\n${o.why.replace(/[.!?]+$/, "")}.\n\nIf it's not for you, no worries, I won't write again. Would you like an invite?`;
}

export async function saveVoice(userId: string, voiceText: string, named: boolean): Promise<void> {
  // A new wording is a new question: the old yes does not carry over.
  await q(`UPDATE mo_member_optin SET voice_text = $2, voice_named = $3, voice_approved_at = NULL, voice_quote = NULL WHERE user_id = $1`, [userId, voiceText.slice(0, 400), named]);
}
export async function approveVoice(userId: string, quote: string): Promise<boolean> {
  const { rowCount } = await q(`UPDATE mo_member_optin SET voice_approved_at = NOW(), voice_quote = $2 WHERE user_id = $1 AND voice_text IS NOT NULL AND status = 'yes' AND paused_at IS NULL`, [userId, quote.slice(0, 200)]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------- the batch the member sees, and their picks

export function batchMessages(o: { need: string; people: { n: number; label: string; why: string; quote: string; text: string }[] }): string[] {
  const out = [`I found ${o.people.length === 1 ? "someone" : `${o.people.length} people`} who might help with ${o.need}. Nothing goes out until you pick.`];
  for (const p of o.people) out.push(`${p.n}. ${p.label}: ${p.why}\nThey wrote: "${p.quote}"\nWhat I'd send:\n${p.text}`);
  out.push("Which should I reach out to? Reply with the numbers, or none.");
  return out;
}

export async function approvePicks(userId: string, picks: number[], quote: string): Promise<{ approved: number; skipped: number } | { none: true } | null> {
  const batch = await openBatch(userId);
  if (!batch || batch.status !== "open") return null;
  const optIn = await optInRow(userId);
  if (!optIn?.voice_approved_at) return null;
  if (!picks.length) {
    await q(`UPDATE mo_member_candidates SET status = 'skipped' WHERE batch_id = $1 AND user_id = $2 AND status = 'pending'`, [batch.id, userId]);
    await q(`UPDATE mo_member_batches SET status = 'cancelled' WHERE id = $1`, [batch.id]);
    return { none: true };
  }
  const a = await q(`UPDATE mo_member_candidates SET status = 'approved', approved_at = NOW(), approved_quote = $3 WHERE batch_id = $1 AND user_id = $2 AND status = 'pending' AND n = ANY($4::int[])`, [batch.id, userId, quote.slice(0, 200), picks]);
  const s = await q(`UPDATE mo_member_candidates SET status = 'skipped' WHERE batch_id = $1 AND user_id = $2 AND status = 'pending'`, [batch.id, userId]);
  await q(`UPDATE mo_member_batches SET status = 'approved', approved_at = NOW() WHERE id = $1`, [batch.id]);
  await recordDecision({ layer: 6, decision: "mo.member.batch", userId, outcome: "act", action: "approved", proposal: { approved: a.rowCount, skipped: s.rowCount } }).catch(() => {});
  return { approved: a.rowCount ?? 0, skipped: s.rowCount ?? 0 };
}

// ---------------------------------------------------------------- sending (the only door out)

export type SendDeps = {
  now: Date;
  enabled: boolean;
  clubPaused: boolean;
  teamDailyCap: number;
  localHour: (now: Date) => number;
  sendDm: (xUserId: string, text: string) => Promise<void>;
  isDmClosed: (err: unknown) => boolean;
  sendEmail: (c: CandidateRow, text: string, followUp: boolean) => Promise<boolean>;
  isSuppressed: (keys: string[]) => Promise<boolean>;
};

async function gatherState(c: CandidateRow, step: "approach" | "follow_up", d: SendDeps): Promise<{ state: ContactState & { localHour: number }; text: string; memberFirst: string; named: boolean; others: string[] }> {
  const [optIn, batch, member, week, today, teamToday, last, others] = await Promise.all([
    optInRow(c.user_id),
    q(`SELECT status, expires_at, need_text FROM mo_member_batches WHERE id = $1`, [c.batch_id]).then((r) => r.rows[0]),
    q(`SELECT first_name FROM users WHERE id = $1`, [c.user_id]).then((r) => r.rows[0]),
    q(`SELECT COUNT(*)::int AS n FROM mo_contact_receipts WHERE user_id = $1 AND outcome = 'sent' AND kind IN ('approach','follow_up') AND created_at > NOW() - INTERVAL '7 days'`, [c.user_id]).then((r) => r.rows[0].n as number),
    q(`SELECT COUNT(*)::int AS n FROM mo_contact_receipts WHERE outcome = 'sent' AND kind IN ('approach','follow_up') AND created_at > NOW() - INTERVAL '24 hours'`).then((r) => r.rows[0].n as number),
    q(`SELECT COUNT(*)::int AS n FROM mo_prospects WHERE contacted_at > NOW() - INTERVAL '24 hours' OR followed_up_at > NOW() - INTERVAL '24 hours'`).then((r) => r.rows[0].n as number).catch(() => 0),
    q(
      `SELECT GREATEST(
         (SELECT MAX(contacted_at) FROM mo_member_candidates WHERE id <> $3 AND ((x_user_id IS NOT NULL AND x_user_id = $1) OR (email IS NOT NULL AND email = $2))),
         (SELECT MAX(contacted_at) FROM mo_prospects WHERE (x_user_id IS NOT NULL AND x_user_id = $1) OR (email IS NOT NULL AND email = $2))
       ) AS at`,
      [c.x_user_id, c.email, c.id],
    ).then((r) => (r.rows[0]?.at ? new Date(r.rows[0].at) : null)).catch(() => null),
    q(`SELECT first_name FROM users WHERE id <> $1 AND first_name <> ''`, [c.user_id]).then((r) => r.rows.map((x: any) => String(x.first_name))).catch(() => [] as string[]),
  ]);
  const named = !!optIn?.voice_named;
  const memberFirst = first(member?.first_name);
  const text = composeApproach(optIn?.voice_text ?? DEFAULT_VOICE, { named, memberFirstName: memberFirst, need: batch?.need_text ?? "", why: c.why });
  const problem = approachProblem(text, { memberFirstName: memberFirst, memberMayBeNamed: named, otherMemberFirstNames: others });
  // The last five people contacted for this member, and whether they said no: too many no's pauses the member's hunt.
  const recent = await q(`SELECT status FROM mo_member_candidates WHERE user_id = $1 AND contacted_at IS NOT NULL ORDER BY contacted_at DESC LIMIT $2`, [c.user_id, MEMBER_MO.autoPauseWindow]).then((r) => r.rows.map((x: any) => ({ bad: x.status === "declined" }))).catch(() => [] as { bad: boolean }[]);
  const keys = suppressionKeys({ x_user_id: c.x_user_id, email: c.email });
  const suppressed = keys.length ? await d.isSuppressed(keys) : false;
  const state: ContactState & { localHour: number } = {
    step, now: d.now, enabled: d.enabled, clubPaused: d.clubPaused,
    optIn: optIn?.status ?? null, memberPaused: !!optIn?.paused_at,
    autoPaused: shouldAutoPause(recent),
    voiceApproved: !!optIn?.voice_approved_at && !!optIn?.voice_text,
    candidateStatus: c.status, approvedAt: c.approved_at, batchExpiresAt: batch?.expires_at ? new Date(batch.expires_at) : null, batchStatus: batch?.status ?? "missing",
    memberSentThisWeek: week, clubSentToday: today + teamToday, teamDailyCap: d.teamDailyCap,
    strangerLastContactedAt: last, suppressed, contactedAt: c.contacted_at, followedUpAt: c.followed_up_at, repliedAt: c.replied_at, approachTextOk: problem === null,
    localHour: d.localHour(d.now),
  };
  return { state, text, memberFirst, named, others };
}

const toKey = (c: CandidateRow) => (c.x_user_id ? `x:${c.x_user_id}` : c.email ? `email:${c.email.toLowerCase()}` : "none");

// One contact, or none. The receipt exists before anything is sent, and says exactly what was sent, to whom, on whose
// yes, and what the limits stood at.
export async function sendContact(c: CandidateRow, step: "approach" | "follow_up", d: SendDeps): Promise<{ action: string; reason?: string }> {
  const { state, text } = await gatherState(c, step, d);
  const verdict = contactVerdict(state);
  const caps = { week: state.memberSentThisWeek, perWeek: MEMBER_MO.perMemberPerWeek, today: state.clubSentToday, perDay: Math.min(MEMBER_MO.clubPerDay, state.teamDailyCap) };
  const kind = step === "approach" ? "approach" : "follow_up";
  const body = step === "approach" ? text : "Following up once, in case this got buried. If it's not for you, no worries at all.";
  if (!verdict.ok) {
    await q(`INSERT INTO mo_contact_receipts (user_id, batch_id, candidate_id, kind, channel, to_key, text, member_yes_quote, caps, outcome, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'blocked',$10)`, [c.user_id, c.batch_id, c.id, kind, c.x_user_id ? "dm" : c.email ? "email" : null, toKey(c), body, c.approved_quote, JSON.stringify(caps), verdict.why]);
    return { action: "blocked", reason: verdict.why ?? undefined };
  }
  const { rows } = await q(`INSERT INTO mo_contact_receipts (user_id, batch_id, candidate_id, kind, channel, to_key, text, member_yes_quote, caps, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING id`, [c.user_id, c.batch_id, c.id, kind, c.x_user_id ? "dm" : "email", toKey(c), body, c.approved_quote, JSON.stringify(caps)]);
  const receiptId = rows[0].id as number;
  const done = async (outcome: "sent" | "failed", reason: string | null, channel: string | null) => {
    await q(`UPDATE mo_contact_receipts SET outcome = $2, reason = $3, channel = COALESCE($4, channel) WHERE id = $1`, [receiptId, outcome, reason, channel]);
  };
  try {
    let channel: string | null = null;
    if (c.x_user_id) {
      try {
        await d.sendDm(c.x_user_id, body);
        channel = "dm";
      } catch (err) {
        if (!d.isDmClosed(err)) throw err;
      }
    }
    if (!channel) {
      if (c.email && (await d.sendEmail(c, body, step === "follow_up"))) channel = "email";
      else {
        await done("failed", "no way to reach them: DMs closed and no email", null);
        await q(`UPDATE mo_member_candidates SET status = 'closed' WHERE id = $1`, [c.id]);
        return { action: "unreachable" };
      }
    }
    await done("sent", null, channel);
    if (step === "approach") await q(`UPDATE mo_member_candidates SET status = 'contacted', contacted_at = NOW(), channel = $2 WHERE id = $1`, [c.id, channel]);
    else await q(`UPDATE mo_member_candidates SET followed_up_at = NOW() WHERE id = $1`, [c.id]);
    await recordDecision({ layer: 5, decision: "mo.member.contact", userId: c.user_id, outcome: "act", action: `${kind}:${channel}`, proposal: { candidate: c.n, receipt: receiptId } }).catch(() => {});
    return { action: `${kind}_sent` };
  } catch (err: any) {
    await done("failed", String(err?.message ?? err).slice(0, 200), null);
    return { action: "failed", reason: String(err?.message ?? err).slice(0, 200) };
  }
}

// Hourly: the approved people whose time has come, and the one follow-up. Returns what happened.
export async function runMemberSends(d: SendDeps): Promise<{ sent: number; blocked: number }> {
  let sent = 0;
  let blocked = 0;
  const { rows } = await q(
    `SELECT c.* FROM mo_member_candidates c JOIN mo_member_batches b ON b.id = c.batch_id
     WHERE (c.status = 'approved' AND b.status = 'approved')
        OR (c.status = 'contacted' AND c.followed_up_at IS NULL AND c.replied_at IS NULL AND c.contacted_at < NOW() - make_interval(days => $1))
     ORDER BY c.approved_at NULLS LAST, c.created_at LIMIT 30`,
    [MEMBER_MO.followUpAfterDays],
  );
  for (const c of rows as CandidateRow[]) {
    const r = await sendContact(c, c.status === "approved" ? "approach" : "follow_up", d);
    if (r.action.endsWith("_sent")) sent++;
    else if (r.action === "blocked") blocked++;
  }
  // A contacted person who never answered a follow-up is closed after a week more.
  await q(`UPDATE mo_member_candidates SET status = 'closed' WHERE status = 'contacted' AND followed_up_at IS NOT NULL AND replied_at IS NULL AND followed_up_at < NOW() - make_interval(days => $1)`, [MEMBER_MO.closeAfterFollowUpDays]);
  await q(`UPDATE mo_member_batches SET status = 'expired' WHERE status IN ('open') AND expires_at <= NOW()`);
  await q(`UPDATE mo_member_candidates SET status = 'skipped' WHERE status = 'pending' AND batch_id IN (SELECT id FROM mo_member_batches WHERE status = 'expired')`);
  return { sent, blocked };
}

// ---------------------------------------------------------------- a stranger replies: the front desk

export type ReplyDeps = {
  send: (text: string) => Promise<unknown>;
  classify: (text: string) => Promise<"yes" | "no" | "question">;
  makeCode: () => Promise<string>;
  codeMessage: (code: string) => string;
  suppress: (keys: string[], reason: string) => Promise<void>;
  tellMember: (userId: string, kind: "replied" | "declined" | "question", candidateId: string) => Promise<void>;
};

// The front desk: a reply is read (a clear stop wins in code, before any model), the person is answered or let go, and
// the member hears only their own thread. A question is answered by Co in the club's voice only after it joins; until
// then it is held, because Mo does not discuss the member or the club beyond what the approved message said.
export async function landReply(c: CandidateRow, text: string, d: ReplyDeps): Promise<string> {
  await q(`UPDATE mo_member_candidates SET replied_at = COALESCE(replied_at, NOW()) WHERE id = $1`, [c.id]);
  const kind = clearStop(text) ? "no" : clearYes(text) ? "yes" : await d.classify(text);
  const record = async (outcome: "sent" | "blocked", reason: string | null, out: string) =>
    q(`INSERT INTO mo_contact_receipts (user_id, batch_id, candidate_id, kind, channel, to_key, text, outcome, reason) VALUES ($1,$2,$3,'reply',$4,$5,$6,$7,$8)`, [c.user_id, c.batch_id, c.id, c.channel, toKey(c), out, outcome, reason]);
  if (kind === "no") {
    await d.suppress(suppressionKeys({ x_user_id: c.x_user_id, email: c.email }), "declined");
    await q(`UPDATE mo_member_candidates SET status = 'declined' WHERE id = $1`, [c.id]);
    const out = "Understood. I won't reach out again. Good luck with everything.";
    await Promise.resolve(d.send(out)).catch(() => {});
    await record("sent", "declined", out);
    await d.tellMember(c.user_id, "declined", c.id);
    return "declined";
  }
  if (kind === "yes" && !c.invite_code) {
    const code = await d.makeCode();
    const out = d.codeMessage(code);
    await d.send(out);
    await q(`UPDATE mo_member_candidates SET status = 'invited', invite_code = $2 WHERE id = $1`, [c.id, code]);
    await record("sent", null, out);
    await d.tellMember(c.user_id, "replied", c.id);
    return "invited";
  }
  // A question, or a second message: held for a person, never answered with anything about the member.
  await q(`UPDATE mo_member_candidates SET status = CASE WHEN status = 'contacted' THEN 'replied' ELSE status END WHERE id = $1`, [c.id]);
  await record("blocked", "a question: held, nothing about the member or the club is said before they join", "");
  await d.tellMember(c.user_id, "question", c.id);
  return "held";
}

// ---------------------------------------------------------------- joined, and the intro (both say yes)

export async function markJoined(): Promise<CandidateRow[]> {
  const { rows } = await q(
    `UPDATE mo_member_candidates c SET status = 'joined', joined_user_id = ic.used_by, joined_at = NOW()
     FROM invite_codes ic WHERE ic.code = c.invite_code AND ic.used_by IS NOT NULL AND c.status IN ('invited', 'replied', 'contacted') RETURNING c.*`,
  ).catch(() => ({ rows: [] as any[] }));
  return rows;
}

// The member's yes to being introduced to the person who joined. Their side only: the other person is asked on their
// own through the existing network intro, and the email goes out only when both have said yes.
export async function recordIntroYes(userId: string, candidateId: string, quote: string): Promise<{ ok: boolean; why?: string }> {
  const { rows } = await q(`SELECT * FROM mo_member_candidates WHERE id = $1 AND user_id = $2 AND status = 'joined' AND joined_user_id IS NOT NULL`, [candidateId, userId]);
  const c = rows[0] as CandidateRow | undefined;
  if (!c) return { ok: false, why: "that person hasn't joined yet" };
  const [aId, bId] = userId < c.joined_user_id! ? [userId, c.joined_user_id!] : [c.joined_user_id!, userId];
  const col = userId === aId ? "a_interested_at" : "b_interested_at";
  const status = userId === aId ? "a_interested" : "b_interested";
  await q(
    `INSERT INTO network_introductions (person_a_id, person_b_id, status, match_reason, ${col}) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (person_a_id, person_b_id) DO UPDATE SET ${col} = COALESCE(network_introductions.${col}, NOW())`,
    [aId, bId, status, c.why.slice(0, 240)],
  );
  await q(`UPDATE mo_member_candidates SET intro_quote = $2, intro_at = NOW() WHERE id = $1`, [c.id, quote.slice(0, 200)]);
  await q(`INSERT INTO mo_contact_receipts (user_id, batch_id, candidate_id, kind, text, member_yes_quote, outcome) VALUES ($1,$2,$3,'intro','intro yes recorded for the member''s side',$4,'sent')`, [userId, c.batch_id, c.id, quote.slice(0, 200)]);
  await recordDecision({ layer: 6, decision: "mo.member.intro_yes", userId, outcome: "act", action: "member_side", proposal: { candidate: c.n } }).catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------- the member's own receipts

export async function myReceipts(userId: string, limit = 10): Promise<{ at: Date; kind: string; who: string; channel: string | null; outcome: string; text: string }[]> {
  const { rows } = await q(
    `SELECT r.created_at, r.kind, r.channel, r.outcome, r.text, c.name, c.x_handle FROM mo_contact_receipts r LEFT JOIN mo_member_candidates c ON c.id = r.candidate_id
     WHERE r.user_id = $1 AND r.outcome <> 'pending' ORDER BY r.created_at DESC LIMIT $2`,
    [userId, limit],
  ).catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({ at: r.created_at, kind: r.kind, who: personLabel({ name: r.name, x_handle: r.x_handle }), channel: r.channel, outcome: r.outcome, text: String(r.text ?? "").slice(0, 400) }));
}

export const moHoursLA = (now: Date): number => DateTime.fromJSDate(now).setZone("America/Los_Angeles").hour;
export const teamCap = () => MO.dailyCap;
