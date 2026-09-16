import "dotenv/config";
import pool from "../db/db.js";

// What test users have reported to Co (services/issueReports.ts).
//
//   npm run issues               open reports, newest first
//   npm run issues -- --all      every report
//   npm run issues -- --since 7  only the last N days
async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const sinceIdx = args.indexOf("--since");
  const days = sinceIdx === -1 ? null : Number(args[sinceIdx + 1]);
  const { rows } = await pool.query(
    `SELECT r.id, r.created_at, r.category, r.severity, r.status, r.summary, r.message, u.first_name
     FROM user_reported_issues r LEFT JOIN users u ON u.id = r.user_id
     WHERE ($1::boolean OR r.status = 'open') AND ($2::int IS NULL OR r.created_at > NOW() - ($2::int || ' days')::interval)
     ORDER BY r.created_at DESC`,
    [all, Number.isFinite(days) ? days : null],
  );
  if (!rows.length) {
    console.log("No reported issues.");
  } else {
    for (const r of rows) {
      console.log(`#${r.id} ${new Date(r.created_at).toISOString().slice(0, 16)} ${r.first_name ?? "?"} [${r.category}, ${r.severity}${r.status !== "open" ? `, ${r.status}` : ""}]`);
      console.log(`   ${r.summary}`);
      console.log(`   they said: "${String(r.message).slice(0, 200)}"`);
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error("listIssues failed:", err);
  process.exit(1);
});
