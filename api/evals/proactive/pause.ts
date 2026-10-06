// The proactive pause (harness/proactive.ts proactivePaused). Layer 1.   npx tsx evals/proactive/pause.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const P = await import("../../src/harness/proactive.js");
const { default: pool } = await import("../../src/db/db.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const src = fs.readFileSync(new URL("../../src/harness/proactive.ts", import.meta.url), "utf8");

check("paused only when PROACTIVE_PAUSED is exactly 'true'", P.proactivePaused({ PROACTIVE_PAUSED: "true" } as any) && !P.proactivePaused({} as any) && !P.proactivePaused({ PROACTIVE_PAUSED: "false" } as any) && !P.proactivePaused({ PROACTIVE_PAUSED: "1" } as any));
let touched = 0;
(pool as any).query = async () => { touched++; return { rows: [] }; };
(pool as any).connect = async () => { touched++; throw new Error("must not connect while paused"); };
process.env.PROACTIVE_PAUSED = "true";
await P.runProactiveDispatch({} as any);
check("paused: the dispatcher does nothing at all (no query: nothing expires or drops, nothing is sent)", touched === 0);
const r = await P.sendExempt({ userId: "u", type: "task_update", targetKey: "k", messages: ["hi"] } as any);
check("paused: the exempt door (task updates, reminders, event changes) is shut too, without touching the database", r.sent === false && /paused/.test(String(r.reason)) && touched === 0);
delete process.env.PROACTIVE_PAUSED;
touched = 0;
await P.runProactiveDispatch({} as any).catch(() => {});
check("not paused: the dispatcher reads its queue as before", touched > 0);
check("the switch sits at the top of both doors, before any lock or insert", /export async function runProactiveDispatch\(registry: ProactiveRegistry\): Promise<void> \{\n  if \(proactivePaused\(\)\) return;/.test(src) && /if \(proactivePaused\(\)\) return \{ sent: false, reason: "proactive outreach is paused" \};\n  \/\/ Monitoring visibility/.test(src));
console.log(`proactive pause: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
