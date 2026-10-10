// Who is looking at an event page (Royce, spec 7: "Viewing is open to anyone with the link; interacting is members only").
//
// Co texts each member their own link: /e/<page id>?m=<token>. The token is sealed, not just signed: AES-256-GCM over the
// member's id and an expiry, with the page id as associated data, under a key derived (HMAC-SHA256) from the server's existing
// JWT_SECRET_KEY. So:
//   - the URL never carries a phone number or a readable user id (the id is encrypted inside the token);
//   - a token opens one page only (a different page id fails the GCM check) for one member, and expires;
//   - it's stateless (like services/elevenLabsCalls.ts call tokens), and verified server-side on every action.
// Opening the link sets the same token as an httpOnly cookie scoped to /e/<page id>, so the actions under it carry it and no
// other page sees it. No token, a bad one, or a member who's since been archived: view only, with the members line.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import pool from "../../db/db.js";

export const TOKEN_VERSION = 1;
// Default life of a link: three weeks. Callers pass the event's end plus a few days when they know it.
export const DEFAULT_TOKEN_TTL_MS = 21 * 86_400_000;
export const COOKIE_NAME = "co_ep";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function keyFrom(secret: string | undefined | null): Buffer | null {
  if (!secret) return null;
  return createHmac("sha256", secret).update("co-event-page-link-v1").digest();
}
export function tokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  return keyFrom(env.JWT_SECRET_KEY);
}

const pageAad = (pageId: string) => Buffer.from(`event-page:${pageId}`, "utf8");

// [version 1][user id 16][expires, unix seconds 4] sealed; the token is iv(12) + tag(16) + body(21), base64url (66 chars).
export function issueMemberToken(pageId: string, userId: string, o: { expiresAt?: Date; now?: Date; key?: Buffer | null } = {}): string {
  const key = o.key === undefined ? tokenKey() : o.key;
  if (!key) throw new Error("event pages: no server secret to seal member links");
  if (!UUID.test(userId)) throw new Error("event pages: a member token needs a member id");
  if (!pageId) throw new Error("event pages: a member token needs a page");
  const now = o.now ?? new Date();
  const exp = Math.floor((o.expiresAt ?? new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS)).getTime() / 1000);
  const body = Buffer.alloc(21);
  body.writeUInt8(TOKEN_VERSION, 0);
  Buffer.from(userId.replace(/-/g, ""), "hex").copy(body, 1);
  body.writeUInt32BE(exp >>> 0, 17);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(pageAad(pageId));
  const sealed = Buffer.concat([c.update(body), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), sealed]).toString("base64url");
}

export type TokenClaim = { userId: string; expiresAt: Date };

// The member a token names, for this page, if it's genuine and unexpired; otherwise null. Never throws.
export function verifyMemberToken(token: unknown, pageId: string, o: { now?: Date; key?: Buffer | null } = {}): TokenClaim | null {
  try {
    const key = o.key === undefined ? tokenKey() : o.key;
    if (!key || typeof token !== "string" || !pageId || token.length > 200) return null;
    const raw = Buffer.from(token, "base64url");
    if (raw.length !== 12 + 16 + 21) return null;
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAAD(pageAad(pageId));
    d.setAuthTag(raw.subarray(12, 28));
    const body = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
    if (body.readUInt8(0) !== TOKEN_VERSION) return null;
    const hex = body.subarray(1, 17).toString("hex");
    const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const expiresAt = new Date(body.readUInt32BE(17) * 1000);
    if (expiresAt.getTime() <= (o.now ?? new Date()).getTime()) return null;
    return { userId, expiresAt };
  } catch {
    return null;
  }
}

// The link Co texts one member for one page.
export function memberEventLink(pageId: string, userId: string, o: { expiresAt?: Date; baseUrl?: string } = {}): string | null {
  const base = (o.baseUrl ?? process.env.API_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return null;
  let token: string;
  try {
    token = issueMemberToken(pageId, userId, { expiresAt: o.expiresAt });
  } catch {
    return null;
  }
  return `${base}/e/${encodeURIComponent(pageId)}?m=${token}`;
}

export const pagePath = (pageId: string) => `/e/${encodeURIComponent(pageId)}`;

// A member still in the club (an archived account's links stop working, whatever the token says).
export async function isActiveMember(userId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE id = $1 AND archived_at IS NULL`, [userId]);
  return rows.length > 0;
}

export type IdentityDeps = { isActiveMember: (userId: string) => Promise<boolean>; key?: Buffer | null; now?: () => Date };
export const realIdentityDeps: IdentityDeps = { isActiveMember };

// The token on this request for this page: ?m= first (the link Co texted), then the page's cookie.
function tokenOn(req: Request): { token: string | null; fromLink: boolean } {
  const q = typeof req.query?.m === "string" ? req.query.m : null;
  if (q) return { token: q, fromLink: true };
  const c = (req as any).cookies?.[COOKIE_NAME];
  return { token: typeof c === "string" ? c : null, fromLink: false };
}

// The member behind this request for this page, or null (view only). Verified on every call; a token from the link becomes the
// page's httpOnly cookie, scoped to this page's path.
export async function memberOnRequest(req: Request, res: Response | null, pageId: string, deps: IdentityDeps = realIdentityDeps): Promise<TokenClaim | null> {
  const { token, fromLink } = tokenOn(req);
  if (!token) return null;
  const now = deps.now?.() ?? new Date();
  const claim = verifyMemberToken(token, pageId, { now, key: deps.key });
  if (!claim) return null;
  const member = await deps.isActiveMember(claim.userId).catch(() => false);
  if (!member) return null;
  if (fromLink && res) {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production" || /^https:/.test(process.env.API_URL ?? ""),
      sameSite: "lax",
      path: pagePath(pageId),
      maxAge: Math.max(0, claim.expiresAt.getTime() - now.getTime()),
    });
  }
  return claim;
}
