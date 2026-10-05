// A stalled model call can't hold a reply for minutes (2026-09-26). Makes
// chosen calls hang (REPLY_TEST_STALL_CALL) and checks: stalled before
// anything went out, the fallback line goes out; stalled after a reply went
// out, the turn ends with what was sent and nothing else.
//
//   REPLY_TEST_STALL_CALL=1,2 REPLY_CALL_TIMEOUT_MS=15000 railway run --service co-test --environment dev -- npx tsx evals/reply/stall.ts
//   REPLY_TEST_STALL_CALL=2,3 REPLY_CALL_TIMEOUT_MS=15000 railway run --service co-test --environment dev -- npx tsx evals/reply/stall.ts
process.env.SENDBLUE_API_API_KEY ||= "x"; process.env.SENDBLUE_API_API_SECRET ||= "x";
const keepAlive = setInterval(() => {}, 1000);
const { setSwitchesForTest } = await import("../../src/services/abilitySwitches.js"); setSwitchesForTest({});
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const logs: string[] = [];
const orig = console.log; console.log = (...a: any[]) => { logs.push(a.join(" ")); };
const origErr = console.error; console.error = (...a: any[]) => { logs.push("ERR " + a.join(" ")); };
const sends: string[] = [];
const t0 = Date.now();
let threw: string | null = null;
const r: any = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: "hey how's it going", isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: baseReplyFacts(), toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "", recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async (p: any) => { sends.push(p.message); return true; } } as any, { dryRun: true, record: false, stubSearch: true }).catch((e: any) => { threw = String(e?.message ?? e); return null; });
console.log = orig; console.error = origErr;
const sent = logs.filter((l) => /would reply to|fallback would send/.test(l));
console.log(`stall=${process.env.REPLY_TEST_STALL_CALL} cap=${process.env.REPLY_CALL_TIMEOUT_MS}ms took ${((Date.now() - t0) / 1000).toFixed(1)}s threw=${threw ?? "no"}`);
console.log(`  timeout logged: ${logs.find((l) => /timed out/.test(l))?.replace(/^ERR /, "").slice(0, 150) ?? "none"}`);
console.log(`  what went out: ${sent.map((l) => l.replace(/^\[conversationReply dryRun\] /, "")).join(" || ").slice(0, 250) || "nothing"}`);
clearInterval(keepAlive);
