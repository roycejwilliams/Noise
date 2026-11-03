// Dry run of one update announcement (services/announcements.ts): how many members it would be queued for right now, how many are
// left out and why, and whether the one-a-month limit allows it. Counts only: no ids, names, numbers or words. Reads only, on the dev
// server through a local tunnel: BEGIN READ ONLY (checked), always rolled back (scripts/ledgerDb.ts).
//
//   DATABASE_URL=postgres://...@127.0.0.1:55432/railway npx tsx src/scripts/announcementDryRun.ts --confirm-db railway [--key announcement:update-2026-11]
import { announcementByKey, audienceCutoff, exclusionOf, expiryOf, monthlyLimit, UPDATE_1102_KEY, type AudienceRow, type Exclusion } from "../services/announcements.js";
import { arg, openDevDb } from "./ledgerDb.js";

async function main() {
  const args = process.argv.slice(2);
  const key = arg(args, "--key") ?? UPDATE_1102_KEY;
  const a = announcementByKey(key);
  if (!a) throw new Error(`no announcement ${key}`);
  const now = new Date();
  const db = await openDevDb(args, { readOnly: true });
  try {
    const cutoff = await audienceCutoff(a, now, db);
    const { rows: first } = await db.query(`SELECT MIN(created_at) AS at FROM proactive_candidates WHERE target_key = $1`, [a.key]);
    const ends = expiryOf(a, first[0]?.at ? new Date(first[0].at) : null, now);
    const block = await monthlyLimit(db, a, now);
    // Every member, unfiltered, with the queue's own columns: the same rule (exclusionOf) decides who is in and why the rest aren't.
    const { rows } = await db.query(
      `SELECT u.id, u.created_at, u.archived_at, u.sms_opted_out, (u.phone_number IS NOT NULL) AS has_phone, u.invite_verified,
              u.phone_number, COALESCE((to_jsonb(u)->>'is_simulated')::boolean, false) AS simulated,
              EXISTS (SELECT 1 FROM proactive_sends s WHERE s.user_id = u.id AND s.target_key = $1) AS told,
              EXISTS (SELECT 1 FROM proactive_candidates c WHERE c.user_id = u.id AND c.target_key = $1) AS queued
         FROM users u`,
      [a.key],
    );
    const out: Record<Exclusion | "would_get_it", number> = { would_get_it: 0, joined_after: 0, archived: 0, opted_out: 0, no_phone: 0, test_number: 0, unfinished: 0, told: 0, queued: 0 };
    for (const r of rows as AudienceRow[]) {
      const why = cutoff ? exclusionOf(r, cutoff) : "joined_after";
      out[why ?? "would_get_it"]++;
    }
    console.log(`announcement ${a.key} (approved: ${a.approved})`);
    console.log(`  members read: ${rows.length}; joined before: ${cutoff?.toISOString() ?? "(no cutoff yet)"}; would end: ${ends.toISOString()}`);
    console.log(`  would get it: ${out.would_get_it}`);
    console.log(`  excluded: ${(Object.keys(out) as (keyof typeof out)[]).filter((k) => k !== "would_get_it").map((k) => `${k} ${out[k]}`).join(", ")}`);
    console.log(`  monthly limit: ${block ?? "allows it (no other announcement went to a member this month or waits to)"}`);
    if (!a.approved || block || ends.getTime() <= now.getTime()) console.log("  => the queue job would queue nothing today");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
