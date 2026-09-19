// Member invites (Royce, 2026-09-19). A member asks Co by text for an
// invite; Co replies with a link that opens a text to Co with the code and
// a greeting filled in ("Hi Co, Royce invited me. Code: …"), so the friend
// sends the first text themselves: Sendblue can't text a new number first.
//
//   - 5 per member. One only counts once the friend joins ("only count if
//     it's successful"), and unused ones never expire.
//   - A member can't have more open links than invites left, so links can't
//     be sprayed around and two friends can't both join on the last one.
//     Asking again with every slot already out re-sends an open link.
//   - When the friend finishes onboarding, Co texts the member a short note
//     (routes/sendblue.ts, INVITE_JOINED lines).
import pool from "../db/db.js";
import { generateInviteCode } from "./inviteCodes.js";

export const INVITES_PER_MEMBER = 5;

// Only a first-person ask about inviting someone to Co. Inviting a friend to
// an event, or "I got an invite to a party", is a normal message and must
// never land here (this takes over the whole turn).
const INVITE_WORD = /\binvit(?:e|es|ation|ations)\b/i;
const TO_CO = /\b(?:friends?|someone|somebody|people|person|buddy|homie|co-?workers?|colleagues?|partner|girlfriend|boyfriend|wife|husband|sister|brother|cousin|roommate|links?|codes?|left|bring|join)\b/i;
const ABOUT_AN_EVENT = /\b(?:events?|dinner|party|mixer|brunch|tonight|tomorrow|rsvp|luma|tickets?|guest ?list)\b/i;

// Pure: whether the text asks Co for an invite (or how many are left).
export function isInviteRequest(text: string): boolean {
  return INVITE_WORD.test(text) && TO_CO.test(text) && !ABOUT_AN_EVENT.test(text);
}

export type InviteDecision = { action: "none_left" } | { action: "mint" } | { action: "reuse"; code: string };

// Pure. joined = friends who got in on this member's codes; open = their
// unused codes, oldest first.
export function decideInvite(state: { joined: number; open: string[] }): InviteDecision {
  const left = invitesLeft(state.joined);
  if (left <= 0) return { action: "none_left" };
  if (state.open.length < left) return { action: "mint" };
  return { action: "reuse", code: state.open[0] };
}

export const invitesLeft = (joined: number) => Math.max(0, INVITES_PER_MEMBER - joined);

export type MemberInvite = { ok: true; code: string; left: number; reused: boolean } | { ok: false; left: 0 };

type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

async function stateFor(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT code, used_by FROM invite_codes WHERE created_by = $1 ORDER BY created_at, code`,
    [userId],
  );
  return {
    joined: rows.filter((r: any) => r.used_by).length,
    open: rows.filter((r: any) => !r.used_by).map((r: any) => r.code as string),
  };
}

// Gets the member a code to hand out: a new one, or an open one when every
// slot is already out. Locked per member, so two quick asks can't both mint
// past the limit.
export async function getMemberInvite(userId: string): Promise<MemberInvite> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`invites:${userId}`]);
    const state = await stateFor(client, userId);
    const decision = decideInvite(state);
    const left = invitesLeft(state.joined);
    if (decision.action === "none_left") {
      await client.query("COMMIT");
      return { ok: false, left: 0 };
    }
    const code = decision.action === "mint" ? await generateInviteCode(userId, client) : decision.code;
    await client.query("COMMIT");
    return { ok: true, code, left, reused: decision.action === "reuse" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function invitesLeftFor(userId: string): Promise<number> {
  return invitesLeft((await stateFor(pool, userId)).joined);
}

// The first text a friend sends, pre-filled by the link.
export function inviteGreeting(inviterFirstName: string | null, code: string): string {
  const name = inviterFirstName?.trim();
  return name ? `Hi Co, ${name} invited me. Code: ${code}` : `Hi Co, I was invited. Code: ${code}`;
}

// Opens Messages to Co with the greeting filled in. "?&body=" works on both
// iOS and Android.
export function smsInviteHref(coPhone: string, body: string): string {
  return `sms:${coPhone}?&body=${encodeURIComponent(body)}`;
}

// The link a member forwards: a web page (routes in server.ts) rather than a
// bare sms: link, which iMessage may not make tappable. Null when
// there's no public base URL configured.
export function inviteLink(code: string, baseUrl = process.env.API_URL): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/i/${code}`;
}

// Claims the "your friend joined" note for a newly onboarded user, once:
// returns who invited them, or null when nobody did or it was already sent.
export async function claimJoinNotice(newUserId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `UPDATE invite_codes SET inviter_notified_at = NOW()
     WHERE used_by = $1 AND created_by IS NOT NULL AND inviter_notified_at IS NULL
     RETURNING created_by`,
    [newUserId],
  );
  return rows[0]?.created_by ?? null;
}

// Who a redeemed code came from, for the friend's welcome.
export async function inviterFirstName(inviterId: string | null | undefined): Promise<string | null> {
  if (!inviterId) return null;
  const { rows } = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [inviterId]);
  return rows[0]?.first_name?.trim() || null;
}
