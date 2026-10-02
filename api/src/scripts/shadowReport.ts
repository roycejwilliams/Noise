import "dotenv/config";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { renderShadowReport, runSweepShadow, shadowSections, shadowUserIds } from "../services/sweepShadow.js";

// The shadow week's internal report (services/sweepShadow.ts): each day, what
// the old rules queued and texted beside what Co would have sent, held and
// rejected, and why. Read-only. Not emailed (Royce, 2026-10-02).
//
//   npm run shadow                  the last 7 days
//   npm run shadow -- --days 3
//   npm run shadow -- --dry-run     run Co's selection on today's real pool and print it, writing nothing
const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
(async () => {
  const ids = (process.env.SWEEP_SHADOW_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const userIds = ids.length ? ids : await shadowUserIds({ ...process.env, SWEEP_SHADOW_USER_IDS: "" });
  if (args.includes("--dry-run")) {
    for (const id of userIds) {
      const r = await runSweepShadow(id, new Date(), { dryRun: true });
      if (!r) continue;
      const by = (v: string) => r.judgments.filter((j) => j.verdict === v);
      console.log(`${r.day}: pool ${r.pool.length}; send ${by("send").length}, hold ${by("hold").length}, reject ${by("reject").length}`);
      for (const j of r.judgments) console.log(`  ${j.verdict.padEnd(10)} ${j.name}${j.reason ? ` [${j.reason}]` : ""}: ${j.guard ? `guard: ${j.guard}` : j.why}${j.whyNow ? ` | now: ${j.whyNow}` : ""}`);
    }
  } else {
    const days = Number(arg("days") ?? 7);
    const today = DateTime.now().setZone("America/Los_Angeles");
    for (let i = days - 1; i >= 0; i--) console.log(renderShadowReport(await shadowSections(today.minus({ days: i }).toISODate()!, userIds)));
  }
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
