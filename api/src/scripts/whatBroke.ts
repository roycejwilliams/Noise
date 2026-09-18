import "dotenv/config";
import pool from "../db/db.js";
import { renderDigest, renderReport, reviewEnabled, reviewWindow, storeFlags } from "../harness/devReview.js";

// "What broke since X" (harness/devReview.ts), for a session. Flags only.
//
//   npm run broke                          the last 24 hours
//   npm run broke -- --since 3d            the last 3 days (h / d)
//   npm run broke -- --since 2026-09-18T19:00Z [--until ...]
//   npm run broke -- --no-model            log and conversation checks only
//   npm run broke -- --digest              print the morning text instead
//   npm run broke -- --store               also save the flags (co-test only)
//
// On co-test: node dist/api/src/scripts/whatBroke.js --since 24h
function parseWhen(v: string | undefined, fallback: Date): Date {
  if (!v) return fallback;
  const rel = v.match(/^(\d+(?:\.\d+)?)(h|d)$/);
  if (rel) return new Date(Date.now() - Number(rel[1]) * (rel[2] === "h" ? 3_600_000 : 86_400_000));
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`can't read the time "${v}"`);
  return d;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const until = parseWhen(arg("until"), new Date());
  const since = parseWhen(arg("since"), new Date(until.getTime() - 86_400_000));
  const { flags, names } = await reviewWindow(since, until, { model: !args.includes("--no-model") });
  const label = arg("since") ? `since ${arg("since")}` : "last 24h";
  if (args.includes("--digest")) {
    console.log(renderDigest(flags, names, label).join("\n\n"));
  } else {
    const ids = [...new Set(flags.flatMap((f) => f.decisionIds))];
    const { rows } = ids.length ? await pool.query(`SELECT id, decision, action FROM harness_decisions WHERE id = ANY($1::bigint[])`, [ids]) : { rows: [] as any[] };
    const decisionNames = new Map<number, string>(rows.map((r: any) => [Number(r.id), `${r.decision}${r.action ? `:${r.action}` : ""}`]));
    console.log(`What broke ${label} (${since.toISOString()} to ${until.toISOString()}): ${flags.length} flags\n`);
    console.log(renderReport(flags, names, decisionNames));
  }
  if (args.includes("--store")) {
    console.log(reviewEnabled() ? `\nstored ${await storeFlags(flags)} new flags` : "\nnot stored: only on co-test with DEV_REVIEW=true");
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
