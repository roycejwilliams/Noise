import "dotenv/config";
import crypto from "crypto";
import pool from "../db/db.js";
import { generateEmbedding } from "../services/embeddings.js";

// Reusable test tool (Royce, 2026-09-05) — appends a fresh stated ask to a
// real test guest's co_profiles.intent, mirroring profileExtraction.ts's
// captureIntent exact upsert shape (same append-not-overwrite convention,
// same field shape). Lets different ask variations get tried against the
// same real Luma guest-list scoring pass (see triggerEventScoring.ts)
// without waiting on a live call/text round-trip and a real LLM extraction
// for each one.
//
// Usage: tsx src/scripts/setStatedAsk.ts <email_or_phone> "<ask text>" [seeking|offering]
async function main() {
  const [, , identifier, askText, type] = process.argv;
  if (!identifier || !askText) {
    console.error('Usage: tsx src/scripts/setStatedAsk.ts <email_or_phone> "<ask text>" [seeking|offering]');
    process.exit(1);
  }
  const askType = type === "offering" ? "offering" : "seeking";

  const { rows } = await pool.query(
    `SELECT id, first_name FROM users WHERE phone_number = $1 OR LOWER(email) = LOWER($1)`,
    [identifier],
  );
  const user = rows[0];
  if (!user) {
    console.error(`[setStatedAsk] no user found for ${identifier}`);
    process.exit(1);
  }

  const embedding = await generateEmbedding(askText).catch(() => null);
  const newIntent = {
    id: crypto.randomUUID(),
    text: askText,
    type: askType,
    status: "active",
    embedding,
    created_at: new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO co_profiles (user_id, intent, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       intent = COALESCE(co_profiles.intent, '[]'::jsonb) || EXCLUDED.intent,
       updated_at = NOW()`,
    [user.id, JSON.stringify([newIntent])],
  );

  console.log(`[setStatedAsk] set ${askType} ask for ${user.first_name} (${user.id}): "${askText}"`);
  await pool.end();
}

main().catch((err) => {
  console.error("[setStatedAsk] failed:", err);
  process.exit(1);
});
