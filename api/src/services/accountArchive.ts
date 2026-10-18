// Setting an account aside so its person can start over (Royce, 2026-09-19:
// "don't delete the test data just the user accounts"). Deleting a user row
// cascades to every message, decision and log tied to it, and co-test has no
// backups, so an account is never deleted to start over. Instead:
//   - its phone, email and username move to archived_* columns, and the row
//     gets placeholders (all three are required, and email/username unique),
//     so the next text from that number starts a brand-new account;
//   - it's opted out of texts, its open asks are closed and anything queued is
//     skipped, so nothing ever tries to text the placeholder;
//   - sign-in sessions are cleared.
// Nothing is deleted, except their model prompt/answer text (llm_trace_text, a 14-day debugging copy).
//
// Shared (moved from co-test/, 2026-09-22) for the membership lapse job, which is gone (2026-10-14: quiet members are never
// archived on a clock). co-test's tester reset still uses it through a re-export.
import pool from "../db/db.js";

export async function archiveAccount(userId: string): Promise<{ archived: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tag = userId.replace(/-/g, "").slice(0, 12);
    const r = await client.query(
      `UPDATE users SET
         archived_at = NOW(), archived_phone = phone_number, archived_email = email,
         phone_number = $2, email = $3, username = $4,
         sms_opted_out = true, login_session_token = NULL, login_session_expiry = NULL
       WHERE id = $1 AND archived_at IS NULL`,
      [userId, `arch-${tag}`, `archived-${tag}@co.invalid`, `archived_${tag}`],
    );
    if (!r.rowCount) {
      await client.query("ROLLBACK");
      return { archived: false };
    }
    await client.query(`UPDATE ask_checkins SET resolved_at = NOW(), closed_reason = COALESCE(closed_reason, 'archived') WHERE user_id = $1 AND resolved_at IS NULL`, [userId]);
    await client.query(
      `UPDATE proactive_candidates SET status = 'skipped', skip_reason = 'account archived', decided_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND status = 'pending'`,
      [userId],
    );
    await client.query("COMMIT");
    // Their model prompt/answer text goes too (services/llmTraceText.ts). After the commit, best-effort: never undoes the archive.
    await import("./llmTraceText.js").then((T) => T.forgetTraceText(userId, "archived")).catch(() => 0);
    return { archived: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
