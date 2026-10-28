// A calendar follower who isn't a member is never written into the server log (2026-10-28 board review: routes/luma.ts logged their
// email in plain text, and the whole payload when its email field was missing). Layer 1, zero tokens: the log lines in the source.
//   npx tsx evals/review/lumaLogPrivacy.ts
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../../src/routes/luma.ts", import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail)}` : ""}`); } };
const logs = src.match(/console\.(log|error|warn)\([^;]*\);/g) ?? [];
const leaky = logs.filter((l) => /\$\{email\}|JSON\.stringify\(data\)|\bemail\b\s*[,)]/.test(l));
check("no log line in the Luma route carries a follower's email or the raw payload", leaky.length === 0, leaky);
check("a payload with no email logs only its field names", /payload has no email field; its keys:", Object\.keys\(data \?\? \{\}\)\.join\(", "\)/.test(src));
// The same rule for phone numbers in the logs the review found (2026-10-28): call status, mark-read, text login.
const others = ["routes/co.ts", "services/sendblue.ts", "services/textLogin.ts"].map((f) => [f, readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8")] as const);
const phoneLogs = others.flatMap(([f, t]) => (t.match(/console\.(log|error|warn)\([^;]*\);/g) ?? []).filter((l) => /\$\{(To|From|number|phoneNumber|phone)\}|req\.body\)/.test(l)).map((l) => `${f}: ${l.slice(0, 120)}`));
check("no log line in those files prints a phone number or a raw request body", phoneLogs.length === 0, phoneLogs);
check("an unrecognized Luma type logs only its field names", /received unrecognized type "\$\{type\}"; its keys/.test(src) && !/JSON\.stringify\(payload\)/.test(src));
console.log(`luma log privacy: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
