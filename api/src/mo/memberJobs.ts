// Member-facing Mo: the scheduled work and the front desk's inbox. Every job is a no-op unless MO_ENABLED (the team's
// switch) AND MO_MEMBER_ENABLED are both "true": member-facing Mo is off by default, and real sends also wait on Co's X
// keys. Nothing here decides who may be contacted; mo/memberFlow.ts and mo/memberRules.ts do, at the moment of sending.
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { MO } from "./rules.js";
import { moEnabled, codeMessage } from "./outreach.js";
import { isDmClosed, sendDm, xWriteConfigured, type DmEvent } from "./xApi.js";
import { huntForMember, realHuntDeps, realIsHuntable, realOpenAsks } from "./memberHunt.js";
import { landReply, markJoined, moHoursLA, runMemberSends, teamCap, type CandidateRow, type SendDeps, type ReplyDeps } from "./memberFlow.js";

export function memberMoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MO_MEMBER_ENABLED === "true" && moEnabled(env);
}
// Real sends need Co's X account too (email isn't wired for member Mo yet).
export function memberMoCanSend(env: NodeJS.ProcessEnv = process.env): boolean {
  return memberMoEnabled(env) && xWriteConfigured(env);
}

async function clubPaused(): Promise<boolean> {
  const { isMoPaused } = await import("./team.js");
  return isMoPaused().catch(() => true);
}

export async function queueUpdate(userId: string, kind: "replied" | "declined" | "question" | "joined", candidateId: string): Promise<void> {
  const { enqueueCandidate } = await import("../harness/proactive.js");
  await enqueueCandidate({
    userId,
    type: "mo_member_update",
    targetKey: `mo_member_update:${candidateId}:${kind}`,
    topicKey: `mo_member:${candidateId}`,
    summary: `Mo: ${kind} for one of their people`,
    payload: { candidateId, kind },
    dueAt: new Date(),
    expiresAt: new Date(Date.now() + 3 * 86_400_000),
  }).catch((err: any) => console.error("mo member: update not queued (non-fatal):", err?.message ?? err));
}

async function queuePresentation(userId: string, batchId: string, voiceApproved: boolean): Promise<void> {
  const { enqueueCandidate } = await import("../harness/proactive.js");
  await enqueueCandidate({
    userId,
    type: voiceApproved ? "mo_member_batch" : "mo_member_voice",
    targetKey: `${voiceApproved ? "mo_member_batch" : "mo_member_voice"}:${batchId}`,
    topicKey: `mo_member:${batchId}`,
    summary: voiceApproved ? "Mo found people: pick who to reach out to" : "Mo needs the member's yes on how it introduces itself",
    payload: { batchId },
    dueAt: new Date(),
    expiresAt: new Date(Date.now() + 3 * 86_400_000),
  }).catch((err: any) => console.error("mo member: presentation not queued (non-fatal):", err?.message ?? err));
}
export { queuePresentation };

// Weekly: for each member who said yes to Mo and has no open batch, hunt from what Co remembers.
export async function runMemberHunts(): Promise<{ hunted: number; stored: number }> {
  if (!memberMoEnabled() || (await clubPaused())) return { hunted: 0, stored: 0 };
  const { rows } = await pool.query(
    `SELECT o.user_id, o.voice_approved_at FROM mo_member_optin o JOIN users u ON u.id = o.user_id
     WHERE o.status = 'yes' AND o.paused_at IS NULL AND u.archived_at IS NULL AND (o.hunt_last_at IS NULL OR o.hunt_last_at < NOW() - INTERVAL '7 days') LIMIT 10`,
  );
  const deps = await realHuntDeps();
  let stored = 0;
  for (const r of rows) {
    const res = await huntForMember(r.user_id, deps).catch((err: any) => ({ status: "skipped" as const, why: String(err?.message ?? err).slice(0, 160) }));
    // A hunt that found nobody still counts as this week's hunt: no retry storm.
    if (res.status === "none") await pool.query(`UPDATE mo_member_optin SET hunt_last_at = NOW() WHERE user_id = $1`, [r.user_id]);
    if (res.status === "stored" && res.batchId) {
      stored++;
      await queuePresentation(r.user_id, res.batchId, !!r.voice_approved_at);
    }
    await recordDecision({ layer: 5, decision: "mo.member.hunt", userId: r.user_id, outcome: res.status === "stored" ? "act" : "skip", action: res.status, proposal: { found: (res as any).found ?? 0 }, reason: (res as any).why ?? null });
  }
  return { hunted: rows.length, stored };
}

// Daily: members who haven't been asked yet and have an ask a person could answer get the one offer.
export async function runMemberOffers(): Promise<number> {
  if (!memberMoEnabled() || (await clubPaused())) return 0;
  const { enqueueCandidate } = await import("../harness/proactive.js");
  const { rows } = await pool.query(
    `SELECT u.id FROM users u LEFT JOIN mo_member_optin o ON o.user_id = u.id
     WHERE u.archived_at IS NULL AND u.sms_opted_out = false AND (o.user_id IS NULL OR o.asked_at IS NULL) AND (o.paused_at IS NULL)
       AND u.id IN (SELECT user_id FROM co_profiles WHERE intent IS NOT NULL AND jsonb_array_length(intent) > 0) LIMIT 20`,
  );
  let queued = 0;
  for (const r of rows) {
    const asks = await realOpenAsks(r.id);
    let ask: string | null = null;
    for (const a of asks) if (await realIsHuntable(a).catch(() => false)) { ask = a; break; }
    if (!ask) continue;
    const res = await enqueueCandidate({
      userId: r.id,
      type: "mo_member_offer",
      targetKey: "mo_member_offer",
      topicKey: "mo_member_offer",
      summary: "Offer: Mo can look outside the club for someone they asked about",
      payload: { need: ask.replace(/\s+/g, " ").slice(0, 100).replace(/[—–!]/g, "") },
      dueAt: new Date(),
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
    }).catch(() => ({ queued: false }));
    if (res.queued) queued++;
  }
  return queued;
}

export async function realSendDeps(): Promise<SendDeps> {
  return {
    now: new Date(),
    enabled: memberMoCanSend(),
    clubPaused: await clubPaused(),
    teamDailyCap: MO.dailyCap,
    localHour: moHoursLA,
    sendDm,
    isDmClosed,
    // Email isn't wired for member Mo yet: a person whose DMs are closed is closed, never emailed from here.
    sendEmail: async () => false,
    isSuppressed: async (keys) => {
      const { rows } = await pool.query(`SELECT 1 FROM mo_suppression WHERE key = ANY($1::text[]) LIMIT 1`, [keys]);
      return rows.length > 0;
    },
  };
}

// Hourly: approved people whose time has come, the one follow-up, the joined, and retention.
export async function runMemberOutreach(): Promise<{ sent: number; blocked: number; joined: number }> {
  if (!memberMoEnabled()) return { sent: 0, blocked: 0, joined: 0 };
  const res = await runMemberSends(await realSendDeps());
  const joined = await markJoined();
  for (const c of joined) await queueUpdate(c.user_id, "joined", c.id);
  // A stranger who never joined or replied is not kept past 90 days.
  await pool.query(`DELETE FROM mo_member_candidates WHERE status IN ('closed','skipped','declined','contacted','pending','blocked') AND created_at < NOW() - INTERVAL '90 days'`).catch(() => {});
  return { ...res, joined: joined.length };
}

export function realReplyDeps(send: (text: string) => Promise<unknown>): ReplyDeps {
  return {
    send,
    classify: async (text) => (await import("./outreach.js")).classifyReply(text),
    makeCode: async () => (await import("../services/inviteCodes.js")).generateInviteCode(null),
    codeMessage: (code) => codeMessage(code),
    suppress: async (keys, reason) => {
      for (const key of keys) await pool.query(`INSERT INTO mo_suppression (key, reason) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, reason]).catch(() => {});
    },
    tellMember: (userId, kind, candidateId) => queueUpdate(userId, kind, candidateId),
  };
}

// Called by the team Mo's DM inbox for a message from someone who isn't one of its own prospects: is it one of a
// member's people? Returns true when handled, so the team path skips it.
export async function handleMemberDm(e: DmEvent): Promise<boolean> {
  if (!memberMoEnabled()) return false;
  const { rows } = await pool.query(`SELECT * FROM mo_member_candidates WHERE x_user_id = $1 AND status IN ('contacted','replied','invited') ORDER BY contacted_at DESC LIMIT 1`, [e.senderId]);
  const c = rows[0] as CandidateRow | undefined;
  if (!c || (c.last_dm_event_id && BigInt(c.last_dm_event_id) >= BigInt(e.id))) return !!c;
  await pool.query(`UPDATE mo_member_candidates SET last_dm_event_id = $2 WHERE id = $1`, [c.id, e.id]);
  const action = await landReply(c, e.text, realReplyDeps((msg) => sendDm(e.senderId, msg)));
  await recordDecision({ layer: 5, decision: "mo.member.reply", userId: c.user_id, outcome: "act", action, proposal: { candidate: c.n } });
  return true;
}
