// The simulation tool never runs against a real member (services/testNumbers.ts simulationBlockedReason). Layer 1.
//   npx tsx evals/testmember/simGuard.ts
import fs from "node:fs";
const T = await import("../../src/services/testNumbers.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const dev = { NODE_ENV: "development" } as any;
check("a test member's number (555-01xx, any area code, any format) may be simulated", ["+14155550100", "+1 (415) 555-0142", "4155550199", "+12125550101"].every((n) => T.simulationBlockedReason(n, dev) === null));
check("a real-looking number is refused, whoever it belongs to", ["+15045799728", "+14155550200", "+14155551234", "+16509101762", "+14155540100"].every((n) => /not a test member/.test(String(T.simulationBlockedReason(n, dev)))));
check("nothing, or a non-string, is refused", /not a test member/.test(String(T.simulationBlockedReason(undefined, dev))) && /not a test member/.test(String(T.simulationBlockedReason(4155550100, dev))));
check("on production even a test-shaped number is refused", T.simulationBlockedReason("+14155550100", { RAILWAY_ENVIRONMENT_NAME: "production" } as any) !== null);
check("the refusal never prints the whole number", !String(T.simulationBlockedReason("+15045799728", dev)).includes("15045799728"));
const s = fs.readFileSync(new URL("../../src/scripts/simulateInboundText.ts", import.meta.url), "utf8");
check("the tool checks the number before it sends anything", /simulationBlockedReason\(phone\)/.test(s) && s.indexOf("simulationBlockedReason(phone)") < s.indexOf("await fetch("));
check("and exits non-zero when refused (an if on the refusal, then exit 1, before the fetch)", /if \(blocked\) \{\s*console\.error\([^;]*;\s*process\.exit\(1\);\s*\}/.test(s.slice(s.indexOf("simulationBlockedReason(phone)"), s.indexOf("await fetch("))));
console.log(`simulation guard: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
