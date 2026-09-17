import "dotenv/config";
import pool from "../db/db.js";
import { generateInviteCode } from "../services/inviteCodes.js";

// Manual code minting for V1 (Royce, 2026-09-17) — Co is referral-only, but
// there's no self-serve "generate my invite code" flow yet (a real product
// decision: who gets to mint codes, how many each, isn't made). Run by hand
// for now.
//
// Usage: npm run generate-invite-code -- [email_or_phone_of_referrer]
// With no argument, mints a founder-seeded code (created_by NULL).
async function main() {
  const [, , identifier] = process.argv;
  let createdBy: string | null = null;
  if (identifier) {
    const { rows } = await pool.query(
      `SELECT id, first_name FROM users WHERE phone_number = $1 OR LOWER(email) = LOWER($1)`,
      [identifier],
    );
    const user = rows[0];
    if (!user) {
      console.error(`[generateInviteCode] no user found for ${identifier}`);
      process.exit(1);
    }
    createdBy = user.id;
    console.log(`[generateInviteCode] minting a code attributed to ${user.first_name} (${user.id})`);
  } else {
    console.log("[generateInviteCode] minting a founder-seeded code (no referrer)");
  }
  const code = await generateInviteCode(createdBy);
  console.log(`[generateInviteCode] code: ${code}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[generateInviteCode] fatal error:", err?.message ?? err);
  process.exit(1);
});
