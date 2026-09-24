// Model-free checks for the live call state the coverage tool reads
// (services/liveCall.ts), 2026-09-23: 9s and 19s tool answers on a real call,
// Claude ~1s of that. No network.
//
//   npx tsx evals/calls/liveCoverage.ts
import { readFileSync } from "fs";
import { addLine, endLiveCall, getLiveCall, noteChatId, startLiveCall } from "../../src/services/liveCall.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

startLiveCall("u1", "Knows: building Co, Oct 10 event");
noteChatId("u1", "chat-a");
addLine("u1", "assistant", "Hey Royce, how's the branding?");
addLine("u1", "user", "Still a struggle.");
addLine("u1", "user", "   ");
const live = getLiveCall("u1", "chat-a");
check("lines kept in order, same format as Hume's transcript", live?.lines.join("\n") === "assistant: Hey Royce, how's the branding?\nuser: Still a struggle.");
check("blank lines are skipped", live?.lines.length === 2);
check("the summary from call start is reused", live?.contextSummary === "Knows: building Co, Oct 10 event");
check("a different chat never gets this call's transcript", getLiveCall("u1", "chat-b") === null);
check("another member never gets it", getLiveCall("u2", "chat-a") === null);
endLiveCall("u1");
check("still there right after hang-up (a late tool call)", getLiveCall("u1") !== null);

const bridge = src("services/mediaStreamBridge.ts");
check("bridge: starts the live state with the summary it already built", /startLiveCall\(userId, contextSummary\);/.test(bridge));
check("bridge: records both sides, skipping interim partials", /if \(!\(m as any\)\.interim\) addLine\(handle\.userId, "user", text\);/.test(bridge) && /addLine\(handle\.userId, "assistant", text\);/.test(bridge));
check("bridge: notes the chat id and ends the live state on close", /noteChatId\(handle\.userId, chatId\)/.test(bridge) && /endLiveCall\(handle\.userId\);/.test(bridge));
const co = src("routes/co.ts");
check("coverage: uses the live transcript, falls back to Hume", /live\?\.lines\.length \? Promise\.resolve\(live\.lines\.join\("\\n"\)\) : fetchHumeCallData\(chatId\)/.test(co));
check("coverage: transcript and summary fetched together, not one after the other", /const \[transcript, priorContext\] = await Promise\.all\(\[/.test(co));
check("coverage: every answer logs where the time went", /decision: "call\.coverage"/.test(co) && /prepMs: t1 - t0, modelMs: t2 - t1/.test(co));

console.log(`live coverage rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
