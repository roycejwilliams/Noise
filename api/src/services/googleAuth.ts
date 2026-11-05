// Shared Google helpers for Cue's own grants (services/cueGrants.ts): the token key, the encryption at rest, PKCE, the callback address
// and revoking a token. The old combined Google connection (Gmail metadata, the gmail.metadata scope) is gone (Royce, 2026-11-04:
// Cue's general-assistant helpers are removed): no Gmail read, no connect link, no scope is asked for here. The calendar (free/busy)
// and Docs are their own grants on Cue's published project (services/cueGrants.ts).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// What every Google grant needs besides its own client: the token key and an https base for the callback.
export function tokenAndBaseReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(tokenKey(env) && baseUrl(env));
}

function baseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const b = env.API_URL?.replace(/\/+$/, "");
  return b && /^https:\/\//.test(b) ? b : null;
}

export function redirectUri(env: NodeJS.ProcessEnv = process.env): string {
  return env.GOOGLE_REDIRECT_URI || `${baseUrl(env)}/google/callback`;
}

// ------------------------------------------------------------ encryption

// GOOGLE_TOKEN_KEY: 32 random bytes, base64 (openssl rand -base64 32).
function tokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.GOOGLE_TOKEN_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function encryptToken(plain: string, key: Buffer | null = tokenKey()): string {
  if (!key) throw new Error("google: GOOGLE_TOKEN_KEY missing or not 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

export function decryptToken(sealed: string, key: Buffer | null = tokenKey()): string {
  if (!key) throw new Error("google: GOOGLE_TOKEN_KEY missing or not 32 bytes");
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("google: unreadable token");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

// ------------------------------------------------------------ PKCE and scopes

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
  });
}
