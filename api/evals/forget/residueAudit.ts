// The forgetting residue audit script (src/scripts/forgetResidueAudit.ts) is read-only and prints counts only.
// Layer 1: a fake pg client, no database, zero tokens.   npx tsx evals/forget/residueAudit.ts
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const path = new URL("../../src/scripts/forgetResidueAudit.ts", import.meta.url).pathname;
const src = readFileSync(path, "utf8");
const A = await import("../../src/scripts/forgetResidueAudit.js");

// Every SQL string in the script: no write, no DDL, no temp table.
const sqlish = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("\n");
check("no INSERT / UPDATE / DELETE / TRUNCATE / CREATE / DROP / ALTER / GRANT / COPY anywhere in its SQL", !/\b(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM|TRUNCATE|CREATE\s|DROP\s|ALTER\s|GRANT\s|COPY\s)/i.test(sqlish));
check("reads inside BEGIN READ ONLY, checks transaction_read_only, ends with ROLLBACK", /client\.query\("BEGIN READ ONLY"\)/.test(src) && /transaction_read_only/.test(src) && /ROLLBACK/.test(src) && !/"COMMIT"/.test(src));
check("refuses production and needs --confirm-db matched against current_database()", /refusing: production/.test(src) && /current_database\(\)/.test(src) && /--confirm-db/.test(src));
const selects = [...src.matchAll(/SELECT \$\{GROUP\} AS g, ([\s\S]*?)\s+FROM/g)].map((m) => m[1]);
check("selects only counts and the member group (no text column leaves SQL)", selects.length === 4 && selects.every((x) => !/\bt\.|\bpc\.(old_value|quote)\b(?![^()]*\))|content|text\b/.test(x.replace(/count\(\*\)(\s+FILTER \(WHERE [^\n]*?\)(?=::int))?|count\(DISTINCT [a-z.]+\)/g, ""))));
check("every store's table, owner and columns are plain identifiers", A.STORES.every((s) => [s.table, s.owner, ...s.cols].every((x) => /^[a-z_][a-z0-9_]*$/.test(x))));
check("covers the spec's text stores (co_memories, claims, threads, loops, tasks, goals, facts, edges both sides, docs, pages, finds, emotion, logs)", ["co_memories", "member_claims", "member_threads", "open_loops", "co_tasks", "co_goals", "co_facts", "document_deliveries", "co_pages", "research_finds", "emotion_signals", "harness_decisions"].every((t) => A.STORES.some((s) => s.table === t)) && A.STORES.some((s) => s.owner === "candidate_id") && A.STORES.some((s) => s.owner === "person_id" && s.table === "relevance_edges"));

// Run it against a fake database: what it asks, what it prints.
const fake = new URL("./fakePg.mjs", import.meta.url).href;
const run = (args: string[], env: Record<string, string>) => spawnSync("npx", ["tsx", "--import", fake, path, ...args], { env: { ...process.env, DATABASE_URL: "postgres://x:y@localhost:55441/railway", ...env }, encoding: "utf8" });
const ok = run(["--confirm-db", "railway"], { FAKE_DB: "railway" });
check("runs: prints host, database, READ ONLY, and the store counts by group", ok.status === 0 && /host localhost:55441/.test(ok.stdout) && /database railway/.test(ok.stdout) && /transaction: READ ONLY/.test(ok.stdout) && /member_claims\s+3\/1 \| 1\/1 \| 0\/0/.test(ok.stdout));
check("stores whose table isn't there are n/a, not an error", /co_goals\s+n\/a/.test(ok.stdout));
check("what it asked: only SELECT/WITH/BEGIN READ ONLY/SET/SAVEPOINT/RELEASE/ROLLBACK, and BEGIN READ ONLY before any store read", (() => { const m = ok.stdout.match(/ASKED (.*)/); if (!m) return false; const asked: string[] = JSON.parse(m[1]); const b = asked.indexOf("BEGIN READ ONLY"); return b > 0 && asked.every((k) => /^(SELECT|WITH|BEGIN READ ONLY|SET|SAVEPOINT|RELEASE|ROLLBACK)\b/i.test(k)) && asked.findIndex((k) => /^WITH/.test(k)) > b; })());
const wrong = run(["--confirm-db", "railway"], { FAKE_DB: "production_db" });
check("refuses when connected to a database other than --confirm-db, before any store read", wrong.status !== 0 && /refusing: connected to "production_db"/.test(wrong.stderr) && !/JOIN member_claims/.test(wrong.stdout) && !/BEGIN/.test((wrong.stdout.match(/ASKED (.*)/) ?? ["", ""])[1]));
const none = run([], { FAKE_DB: "railway" });
check("refuses without --confirm-db", none.status !== 0 && /--confirm-db/.test(none.stderr));
const prod = run(["--confirm-db", "railway"], { FAKE_DB: "railway", RAILWAY_ENVIRONMENT_NAME: "production" });
check("refuses on production", prod.status !== 0 && /refusing: production/.test(prod.stderr));

console.log(`forget residue audit: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
