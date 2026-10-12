// Member assets (Royce, 2026-10-11): "Members can text Co material for their artifacts: pictures, logos, inspo images, files. Co
// stores these as member assets and places them where relevant - in decks now, and the same asset store should serve every artifact
// type later. Assets follow the same owner-only rules as the artifacts they appear in."
//
// Every photo a member texts is kept here as "their image #N" (routes/sendblue.ts), already in a format a browser shows (HEIC is
// converted to JPEG by services/imageRead.ts readableImage). Files (PDF, PowerPoint, Word) stay in memberFiles.ts. The rules:
//   - one member's only: an artifact can place an asset only when the asset's owner is the artifact's owner (store.ts checks it on
//     every write);
//   - never served on its own: only at /d/<artifact>/a/<asset>, and only while that artifact is live and places it (routes/coPage.ts),
//     so taking a deck down or its expiry takes its images with it;
//   - the id is 18 random bytes like a page's, never listed;
//   - unused for 90 days and on no live page or deck, the bytes are wiped (jobs/index.ts); they can delete them any time
//     (agent/artifactTools.ts deleteImages).
import { createHash, randomBytes } from "crypto";
import pool from "../db/db.js";

export const ASSET_ID = /^[A-Za-z0-9_-]{24}$/;
export const ASSET_LIMITS = { bytes: 6 * 1024 * 1024, list: 20, unusedDays: 90 } as const;
const TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type AssetDb = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
let db: AssetDb = pool;
// Tests swap in a stub; nothing else should.
export function useAssetDb(d: AssetDb | null): void {
  db = d ?? pool;
}

export type MemberAsset = { id: string; n: number; mediaType: string; description: string | null; at: Date };

// Keeps one image for them. The same image sent again is the same asset (same number).
export async function keepAsset(userId: string, data: Buffer, mediaType: string, description: string | null): Promise<{ ok: true; id: string; n: number; isNew: boolean } | { ok: false; why: string }> {
  if (!TYPES.has(mediaType)) return { ok: false, why: "not an image a page can show" };
  if (data.length > ASSET_LIMITS.bytes) return { ok: false, why: "too large" };
  const sha = createHash("sha256").update(data).digest("hex");
  const same = await db.query(`SELECT id, n FROM member_assets WHERE owner_user_id = $1 AND sha256 = $2 AND wiped_at IS NULL LIMIT 1`, [userId, sha]);
  if (same.rows[0]) return { ok: true, id: String(same.rows[0].id), n: Number(same.rows[0].n), isNew: false };
  const id = randomBytes(18).toString("base64url");
  // Two photos in one go arrive as two webhooks at once: both can read the same MAX(n). The (owner, n) unique key refuses the second,
  // which tries again with the next number (review of the decks PR).
  for (let attempt = 0; ; attempt++) {
    try {
      const { rows } = await db.query(
        `INSERT INTO member_assets (id, owner_user_id, n, media_type, bytes, description, sha256)
         VALUES ($1, $2, (SELECT COALESCE(MAX(n), 0) + 1 FROM member_assets WHERE owner_user_id = $2), $3, $4, $5, $6) RETURNING n`,
        [id, userId, mediaType, data, description ? description.slice(0, 400) : null, sha],
      );
      return { ok: true, id, n: Number(rows[0].n), isNew: true };
    } catch (err: any) {
      if (err?.code !== "23505" || attempt >= 4) throw err;
      // The same photo arrived twice at once (concurrency audit, 2026-10-12): one live copy per owner (member_assets_one_live_copy),
      // and the second gets the first one's number.
      if (err?.constraint === "member_assets_one_live_copy") {
        const first = await db.query(`SELECT id, n FROM member_assets WHERE owner_user_id = $1 AND sha256 = $2 AND wiped_at IS NULL AND n > 0 LIMIT 1`, [userId, sha]);
        if (first.rows[0]) return { ok: true, id: String(first.rows[0].id), n: Number(first.rows[0].n), isNew: false };
      }
    }
  }
}

// Their images, newest first: numbers and what each shows (never the bytes).
export async function listAssets(userId: string): Promise<MemberAsset[]> {
  const { rows } = await db.query(
    `SELECT id, n, media_type, description, created_at FROM member_assets WHERE owner_user_id = $1 AND wiped_at IS NULL AND n > 0 ORDER BY created_at DESC LIMIT $2`,
    [userId, ASSET_LIMITS.list],
  );
  return rows.map((r) => ({ id: String(r.id), n: Number(r.n), mediaType: String(r.media_type), description: r.description ? String(r.description) : null, at: new Date(r.created_at) }));
}

// The number they know each of these ids by, theirs and still here. A cleaned-up copy (a logo the design system cleaned, stored as -n)
// is shown by its original's number, so an edit that passes it back keeps the copy (agent/deckTools.ts). Founder's review, 2026-10-12:
// copies mapped to nothing and a deck edit dropped its logo.
export async function assetNumbers(userId: string, ids: (string | null | undefined)[]): Promise<Map<string, number>> {
  const want = [...new Set(ids.filter((i): i is string => !!i && ASSET_ID.test(i)))];
  if (!want.length) return new Map();
  const { rows } = await db.query(`SELECT id, n FROM member_assets WHERE owner_user_id = $1 AND id = ANY($2::text[]) AND wiped_at IS NULL`, [userId, want]);
  return new Map(rows.map((r) => [String(r.id), Math.abs(Number(r.n))]));
}

// Which of these ids are theirs and still here. An artifact may place only these.
export async function ownedAssetIds(userId: string, ids: string[]): Promise<Set<string>> {
  const want = [...new Set(ids.filter((i) => ASSET_ID.test(i)))];
  if (!want.length) return new Set();
  const { rows } = await db.query(`SELECT id FROM member_assets WHERE owner_user_id = $1 AND id = ANY($2::text[]) AND wiped_at IS NULL`, [userId, want]);
  return new Set(rows.map((r) => String(r.id)));
}

// Placed in an artifact just now: counts as use, so it isn't wiped while it's in use.
export async function touchAssets(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.query(`UPDATE member_assets SET last_used_at = NOW() WHERE id = ANY($1::text[])`, [ids]);
}

// For the artifact route only: the bytes, when the asset is this owner's.
export async function loadAssetFor(ownerUserId: string, id: string): Promise<{ data: Buffer; mediaType: string } | null> {
  if (!ASSET_ID.test(id)) return null;
  const { rows } = await db.query(`SELECT bytes, media_type FROM member_assets WHERE id = $1 AND owner_user_id = $2 AND wiped_at IS NULL AND bytes IS NOT NULL`, [id, ownerUserId]);
  const r = rows[0];
  return r && TYPES.has(String(r.media_type)) ? { data: Buffer.from(r.bytes), mediaType: String(r.media_type) } : null;
}

// Never an image a live page or deck of theirs places (review of the decks PR: a kept deck's logo would have gone at 90 days).
export async function wipeUnusedAssets(): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE member_assets a SET bytes = NULL, wiped_at = NOW()
     WHERE a.wiped_at IS NULL AND a.last_used_at < NOW() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM co_pages p WHERE p.owner_user_id = a.owner_user_id AND p.taken_down_at IS NULL AND p.expires_at > NOW() AND p.data::text LIKE '%' || a.id || '%')`,
    [ASSET_LIMITS.unusedDays],
  );
  return rowCount ?? 0;
}

// "Delete the photos I sent you": their own images, the bytes gone now (the number stays retired). numbers null = all of them. A
// page or deck that placed one shows it no more.
export async function deleteAssets(userId: string, numbers: number[] | null): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE member_assets SET bytes = NULL, description = NULL, wiped_at = NOW() WHERE owner_user_id = $1 AND wiped_at IS NULL AND ($2::int[] IS NULL OR n = ANY($2::int[]) OR -n = ANY($2::int[]))`,
    [userId, numbers && numbers.length ? numbers : null],
  );
  return rowCount ?? 0;
}

// A cleaned-up copy Co made of one of their images (a logo cut to its content, services/designRead.ts trimImage). It's theirs like the
// original but never one of their numbered images: it's kept as number -N for their image #N, so it's never listed, offered or
// counted, and deleting #N deletes it too (deleteAssets). The same copy again is the same asset.
export async function keepDerivedAsset(userId: string, fromN: number, data: Buffer, mediaType: string): Promise<string | null> {
  if (!TYPES.has(mediaType) || data.length > ASSET_LIMITS.bytes || !(fromN > 0)) return null;
  const sha = createHash("sha256").update(data).digest("hex");
  const { rows } = await db.query(`SELECT id, sha256, wiped_at FROM member_assets WHERE owner_user_id = $1 AND n = $2`, [userId, -fromN]);
  // Their image #N never changes, so neither does its copy: a live one is reused as it is (a deck placing it keeps working).
  if (rows[0] && !rows[0].wiped_at) return String(rows[0].id);
  const id = randomBytes(18).toString("base64url");
  if (rows[0]) {
    await db.query(`UPDATE member_assets SET id = $3, bytes = $4, media_type = $5, sha256 = $6, wiped_at = NULL, created_at = NOW(), last_used_at = NOW(), description = $7 WHERE owner_user_id = $1 AND n = $2`, [userId, -fromN, id, data, mediaType, sha, `A cleaned-up copy of their image #${fromN}`]);
  } else {
    await db.query(`INSERT INTO member_assets (id, owner_user_id, n, media_type, bytes, description, sha256) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, userId, -fromN, mediaType, data, `A cleaned-up copy of their image #${fromN}`, sha]);
  }
  return id;
}
// The cleaned-up copy of their image #N, if Co made one and it's still there.
export async function derivedAssetId(userId: string, fromN: number): Promise<string | null> {
  const { rows } = await db.query(`SELECT id FROM member_assets WHERE owner_user_id = $1 AND n = $2 AND wiped_at IS NULL`, [userId, -fromN]);
  return rows[0] ? String(rows[0].id) : null;
}
