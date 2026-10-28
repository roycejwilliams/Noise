// co-test's database health route (2026-10-28: after the password rotation the live copy answered /health while every text failed with
// "password authentication failed"). Layer 1, zero tokens: the route opens a fresh client (a pooled one can outlive a changed password),
// is capped, and stays off /health, which Railway's deploy check uses.
//   npx tsx evals/review/healthDb.ts
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../../../co-test/src/server.ts", import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
check("/health stays a plain ok (Railway's deploy check)", /app\.get\("\/health", \(_req, res\) => res\.status\(200\)\.send\("ok"\)\);/.test(src));
check("/health/db opens a fresh client with the pool's settings, capped at 5s", /app\.get\("\/health\/db"/.test(src) && /new PgClient\(\{ connectionString: process\.env\.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000 \}\)/.test(src));
check("one check at a time, reused for 5s and capped at 5s overall (review of #297)", /if \(dbCheck && Date\.now\(\) - dbCheck\.at < 5000\) return dbCheck\.ok;/.test(src) && /Promise\.race\(\[run, new Promise<boolean>\(\(r\) => setTimeout\(\(\) => r\(false\), 5000\)/.test(src) && /client\.on\("error", \(\) => \{\}\)/.test(src));
check("it answers 503 when the database can't be reached, and never caches", /res\.status\(ok \? 200 : 503\)\.set\("Cache-Control", "no-store"\)/.test(src));
console.log(`health db: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
