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
check("localTunnel: only 127.0.0.1/localhost on the expected port", A.localTunnel("postgres://a:b@127.0.0.1:55441/railway", 55441) && A.localTunnel("postgres://a:b@localhost:55441/railway", 55441) && !A.localTunnel("postgres://a:b@127.0.0.1:55432/railway", 55441) && !A.localTunnel("postgres://a:b@db.railway.internal:5432/railway", 55441) && !A.localTunnel("postgres://a:b@203.0.113.9:55441/railway", 55441));
check("matching is normalized on both sides (case, punctuation, spacing, JSON escapes) and the removed text loses Cue's lead-ins", /regexp_replace\(lower\(regexp_replace\(x, '\\\\\[nrt\]', ' ', 'g'\)\), '\[\^a-z0-9\]\+', ' ', 'g'\)/.test(A.NORM("x")) && /my read\|looking out for\|not for you/.test(src) && /position\(' ' \|\| r\.p \|\| ' ' IN ' ' \|\| \$\{NORM\(text\)\} \|\| ' '\)/.test(src));
const selects = [...src.matchAll(/SELECT \$\{GROUP\} AS g, ([\s\S]*?)\s+FROM/g)].map((m) => m[1]);
check("selects only counts and the member group (no text column leaves SQL)", selects.length === 4 && selects.every((x) => !/\bt\.|\bpc\.(old_value|quote)\b(?![^()]*\))|content|text\b/.test(x.replace(/count\(\*\)(\s+FILTER \(WHERE [^\n]*?\)(?=::int))?|count\(DISTINCT [a-z.]+\)/g, ""))));
check("every store's table, owner and columns are plain identifiers", A.STORES.every((s) => [s.table, s.owner, ...s.cols].every((x) => /^[a-z_][a-z0-9_]*$/.test(x))));
check("covers the spec's text stores (co_memories, claims, threads, loops, tasks, goals, facts, edges both sides, docs, pages, finds, emotion, logs)", ["co_memories", "member_claims", "member_threads", "open_loops", "co_tasks", "co_goals", "co_facts", "document_deliveries", "co_pages", "research_finds", "emotion_signals", "harness_decisions"].every((t) => A.STORES.some((s) => s.table === t)) && A.STORES.some((s) => s.owner === "candidate_id") && A.STORES.some((s) => s.owner === "person_id" && s.table === "relevance_edges"));

// Run it against a fake database: what it asks, what it prints.
const fake = new URL("./fakePg.mjs", import.meta.url).href;
const run = (args: string[], env: Record<string, string>) => spawnSync("npx", ["tsx", "--import", fake, path, ...args], { env: { ...process.env, DATABASE_URL: "postgres://x:y@localhost:55441/railway", ...env }, encoding: "utf8" });
const ID = "7000000000000000001";
const ok = run(["--confirm-db", "railway", "--expect-system-id", ID], { FAKE_DB: "railway" });
check("runs: prints host, database, server id, READ ONLY, dev markers, exact-phrase label, and the store counts by group", ok.status === 0 && /host localhost:55441/.test(ok.stdout) && /database railway, system 7000000000000000001/.test(ok.stdout) && /transaction: READ ONLY; dev markers/.test(ok.stdout) && /exact-phrase matches after normalizing/.test(ok.stdout) && /member_claims\s+3\/1 \| 1\/1 \| 0\/0/.test(ok.stdout));
check("a store's database error prints its class only, never its text", /co_memories: texts[^\n]*error \(class 22P02\)/.test(ok.stdout) && !/custody|invalid input/i.test(ok.stdout));
const otherServer = run(["--confirm-db", "railway", "--expect-system-id", ID], { FAKE_DB: "railway", FAKE_SYSID: "7999999999999999999" });
check("refuses another server with the same database name (system identifier pinned), before any member read", otherServer.status !== 0 && /refusing: server 7999999999999999999 is not the expected dev server/.test(otherServer.stderr) && !/BEGIN/.test((otherServer.stdout.match(/ASKED (.*)/) ?? ["", ""])[1]));
const noTest = run(["--confirm-db", "railway", "--expect-system-id", ID], { FAKE_DB: "railway", FAKE_TEST_MEMBERS: "0" });
check("refuses a server with no 555-01xx test members (not dev/co-test), before any store read", noTest.status !== 0 && /refusing: no 555-01xx test members/.test(noTest.stderr) && !/WITH removed/.test((noTest.stdout.match(/ASKED (.*)/) ?? ["", ""])[1]));
const remote = spawnSync("npx", ["tsx", "--import", fake, path, "--confirm-db", "railway", "--expect-system-id", ID], { env: { ...process.env, DATABASE_URL: "postgres://x:y@db.example.net:5432/railway", FAKE_DB: "railway" }, encoding: "utf8" });
check("refuses anything but a local tunnel on the expected port, before connecting", remote.status !== 0 && /refusing: not a local tunnel on port 55441/.test(remote.stderr) && !/ASKED \[".+/.test(remote.stdout));
const noId = run(["--confirm-db", "railway"], { FAKE_DB: "railway" });
check("refuses without --expect-system-id", noId.status !== 0 && /--expect-system-id/.test(noId.stderr));
const printed = run(["--print-id"], { FAKE_DB: "railway" });
check("--print-id reads only the server identifier and exits", printed.status === 0 && /system identifier: 7000000000000000001/.test(printed.stdout) && (() => { const m = printed.stdout.match(/ASKED (.*)/); const a: string[] = m ? JSON.parse(m[1]) : []; return a.length >= 1 && /^SELECT system_identi/.test(a[0]) && a.slice(1).every((x) => x === "ROLLBACK"); })());
check("stores whose table isn't there are n/a, not an error", /co_goals\s+n\/a/.test(ok.stdout));
check("what it asked: only SELECT/WITH/BEGIN READ ONLY/SET/SAVEPOINT/RELEASE/ROLLBACK, and BEGIN READ ONLY before any store read", (() => { const m = ok.stdout.match(/ASKED (.*)/); if (!m) return false; const asked: string[] = JSON.parse(m[1]); const b = asked.indexOf("BEGIN READ ONLY"); return b > 0 && asked.every((k) => /^(SELECT|WITH|BEGIN READ ONLY|SET|SAVEPOINT|RELEASE|ROLLBACK)\b/i.test(k)) && asked.findIndex((k) => /^WITH/.test(k)) > b; })());
const wrong = run(["--confirm-db", "railway", "--expect-system-id", ID], { FAKE_DB: "production_db" });
check("refuses when connected to a database other than --confirm-db, before any store read", wrong.status !== 0 && /refusing: connected to "production_db"/.test(wrong.stderr) && !/JOIN member_claims/.test(wrong.stdout) && !/BEGIN/.test((wrong.stdout.match(/ASKED (.*)/) ?? ["", ""])[1]));
const none = run([], { FAKE_DB: "railway" });
check("refuses without --confirm-db", none.status !== 0 && /--confirm-db/.test(none.stderr));
const prod = run(["--confirm-db", "railway", "--expect-system-id", ID], { FAKE_DB: "railway", RAILWAY_ENVIRONMENT_NAME: "production" });
check("refuses on production", prod.status !== 0 && /refusing: production/.test(prod.stderr));

console.log(`forget residue audit: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
