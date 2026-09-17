// Co is referral-only (2026-09-17, Royce: "we're trying to grow so large
// that we make a secret network" — density and fit matter more than open
// signup volume, so who joins is tied to who's already in). A brand-new
// phone number is asked for a code before intake starts
// (services/identity.ts's placeholder row, routes/sendblue.ts's gate).
//
// Deliberately separate from routes/referrals.ts's existing referral
// system — that one is a member spending a credit to recommend a specific
// person by name/reason (a human-to-human intro Co makes on their behalf).
// This is a code a new person types in themselves to unlock signup. No
// self-serve code generation yet (V1: scripts/generateInviteCode.ts, run
// by hand) — that's a real product decision (who gets to mint codes, how
// many) not made yet, not something to guess at here.
import { randomBytes } from "crypto";
import pool from "../db/db.js";
import type { PoolClient } from "pg";

// Excludes visually ambiguous characters (0/O, 1/I/L) since this gets
// typed back over SMS, not pasted from a link.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function generateInviteCode(createdBy: string | null): Promise<string> {
  // Collision odds at 8 chars over a 32-symbol alphabet are astronomically
  // low, but retry-on-conflict costs nothing and means never having to
  // think about it again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = randomBytes(CODE_LENGTH);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    try {
      await pool.query(`INSERT INTO invite_codes (code, created_by) VALUES ($1, $2)`, [code, createdBy]);
      return code;
    } catch (err: any) {
      if (err?.code === "23505") continue; // code collision, retry
      throw err;
    }
  }
  throw new Error("generateInviteCode: couldn't generate a unique code after 5 attempts");
}

export type RedeemResult = { ok: boolean; reason?: "not_found" | "already_used"; createdBy?: string | null };

// Row-locked so two people racing to redeem the exact same code (or the
// same person double-submitting) can't both succeed — same FOR UPDATE
// pattern as routes/referrals.ts's existing credit-spend check.
export async function redeemInviteCode(rawCode: string, userId: string): Promise<RedeemResult> {
  const code = normalizeInviteCode(rawCode);
  if (!code) return { ok: false, reason: "not_found" };
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT created_by, used_by FROM invite_codes WHERE code = $1 FOR UPDATE`, [code]);
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (row.used_by) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_used" };
    }
    await client.query(`UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE code = $2`, [userId, code]);
    await client.query("COMMIT");
    return { ok: true, createdBy: row.created_by ?? null };
  } catch (err: any) {
    await client?.query("ROLLBACK").catch(() => {});
    console.error("redeemInviteCode: failed (non-fatal, treated as not found):", err?.message ?? err);
    return { ok: false, reason: "not_found" };
  } finally {
    client?.release();
  }
}
