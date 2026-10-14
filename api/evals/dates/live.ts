// Before/after for the date guard on real cases (2026-09-26): the same turn
// with the facts Co used to get and with the dated facts it gets now, each
// through the real reply and claim check. Dry run.
//
//   railway run --service co-test --environment dev -- npx tsx evals/dates/live.ts [runs]
import "../lib/requireMeter.js";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { setSwitchesForTest } = await import("../../src/services/abilitySwitches.js");
setSwitchesForTest({});
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { addFact, addInstruction, baseReplyFacts, groundReply, searchNoteLine } = await import("../../src/harness/replyGrounding.js");
const { LOOP_GUIDE } = await import("../../src/agent/loop.js");
const { ledgerLine } = await import("../../src/services/coFacts.js");

type Scenario = { name: string; today: string; todayIso: string; message: string; recent: string; before: string[]; after: string[]; wantsSearch?: boolean; bad: (reply: string, tools: string[]) => string | null };
const mahjongSend = { relation: "sent", label: "Mahjong After Dark", url: "https://lu.ma/mahjongafterdark", at: new Date("2026-09-24T23:00:00Z"), when: "2026-09-26" };
const agentfi = { relation: "sent", label: "AgentFi demo day at The Avalon", url: "https://x.com/i/status/2099242239721406895", at: new Date("2026-09-21T16:25:00Z"), when: "2026-10-07" };
const oldNote = `Cue searched for "Anything good this weekend?" and sent: "Mahjong After Dark" from its Luma event page.`;
const S: Scenario[] = [
  {
    name: "past event offered (Sunday, Mahjong was Saturday)",
    today: "Sunday, September 27, 2026", todayIso: "2026-09-27",
    message: "Anything happening tonight?",
    recent: "User said: Anything happening this weekend?\nCo replied: Still just Mahjong After Dark from what I sent earlier.",
    before: [`On 2026-09-24 Cue sent them "Mahjong After Dark" (https://lu.ma/mahjongafterdark).`, oldNote],
    after: [ledgerLine(mahjongSend as any, "2026-09-27"), searchNoteLine(`[search] ${oldNote}`, new Date("2026-09-24T23:00:00Z"), "2026-09-27")],
    wantsSearch: true,
    bad: (r) => (/mahjong/i.test(r) && !/(was|over|last night|yesterday|passed|already)/i.test(r) ? "offered Mahjong as if it's still ahead" : null),
  },
  {
    name: "follow-up before the event (Sep 27, AgentFi is Oct 7)",
    today: "Sunday, September 27, 2026", todayIso: "2026-09-27",
    message: "Back from a crazy week. What's up?",
    recent: "Co replied: AgentFi demo day at The Avalon, Oct 7, right in your tech week window. Want it on your radar?",
    before: [`On 2026-09-21 Cue sent them "AgentFi demo day at The Avalon" (https://x.com/i/status/2099242239721406895).`],
    after: [ledgerLine(agentfi as any, "2026-09-27")],
    bad: (r) => (/agentfi|demo day/i.test(r) && /(how (was|did)|did you (go|make it)|how'?d it go|went)/i.test(r) ? "asked how it went before it happened" : null),
  },
  {
    name: "old results answering a new ask (Saturday, new ask)",
    today: "Saturday, September 26, 2026", todayIso: "2026-09-26",
    message: "got anything else this weekend?",
    recent: "Co replied: Mahjong After Dark this Saturday in SF, casual, live DJ.",
    before: [`On 2026-09-24 Cue sent them "Mahjong After Dark" (https://lu.ma/mahjongafterdark).`, oldNote],
    after: [ledgerLine(mahjongSend as any, "2026-09-26"), searchNoteLine(`[search] ${oldNote}`, new Date("2026-09-24T23:00:00Z"), "2026-09-26")],
    wantsSearch: true,
    bad: (_r, tools) => (tools.includes("searchEvents") || tools.includes("webSearch") ? null : "answered from the earlier search without searching"),
  },
];
const runs = Number(process.argv[2] ?? 3);
for (const sc of S) {
  for (const phase of ["before", "after"] as const) {
    let ok = 0;
    const notes: string[] = [];
    for (let i = 0; i < runs; i++) {
      const rf = baseReplyFacts();
      addFact(rf, "known", `Today is ${sc.today} (Pacific time).`);
      addFact(rf, "known", "They live in San Francisco.");
      for (const f of sc[phase]) addFact(rf, "did_before", f);
      if (sc.wantsSearch) addInstruction(rf, LOOP_GUIDE);
      const r: any = await runConversationReplyAgent({ userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: sc.message, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: rf, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: sc.recent, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true } as any, { dryRun: true, record: false, stubSearch: true }).catch((e: any) => ({ replyText: `ERROR ${e?.message}`, toolsCalled: [] }));
      const g: any = await groundReply(String(r.replyText ?? ""), rf, { message: sc.message, recentConversation: sc.recent }, { record: false }).catch(() => ({ final: r.replyText }));
      const problem = sc.bad(String(g.final), r.toolsCalled ?? []);
      if (!problem) ok++;
      else notes.push(`${problem}: "${String(g.final).slice(0, 120)}"`);
    }
    console.log(`${phase.padEnd(6)} ${ok}/${runs}  ${sc.name}${notes.length ? `\n         ${notes.join("\n         ")}` : ""}`);
  }
}
