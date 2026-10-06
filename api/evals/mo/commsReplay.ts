// The Co and Mo communication fixes, replayed on the real 09-28 evening
// (Royce, 2026-09-28): a relayed summary paused all of Mo's outreach.
// Real models; dry run, nothing is sent or changed.
//
//   railway run --service co-test --environment dev -- npx tsx evals/mo/commsReplay.ts
import "../lib/requireMeter.js";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { runMoTeamTurn } = await import("../../src/mo/teamAgent.js");
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { addFact, baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
const harneet = { no: 6, name: "Harneet Dhillon", x_handle: null, source: "linkedin", why: "runs Build Bar and a Claude 101 workshop in SF", status: "shortlisted" };
const pending = { kind: "review" as const, p: harneet };
const thread = "Mo replied: It's Mo. Right now the one waiting on a yes is Harneet Dhillon, runs Build Bar and a Claude 101 workshop here in SF. Want me to go for it, or change the message?\nUser said: Why him? [to Mo]\nMo replied: I came across Harneet on LinkedIn, he runs Build Bar and hosts a Claude 101 workshop here in SF.";
const aware = (extra: object = {}) => ({ recent: thread, topic: "why Harneet", pushback: null, lessons: [], repliedTo: null, handedOff: false, needsIntro: false, ...extra });
let ok = 0, total = 0;
const check = (label: string, pass: boolean, detail: string) => { total++; if (pass) ok++; console.log(`${pass ? "ok  " : "MISS"} ${label}: ${detail}`); };

for (let i = 0; i < (process.env.COMMS_ONLY === "consult" ? 0 : 2); i++) {
  // 1. "Pause on it" after Mo's Harneet exchange, arriving through Co with Co's garbled note.
  const a = await runMoTeamTurn({ userId: "00000000-0000-0000-0000-000000000000", approverFirst: "Royce", text: "Pause on it", pending, coSpoke: false, dryRun: true,
    awareness: aware({ handedOff: true, coNote: "Royce says to pause on getting your name/profession to him, stand down on that." }) as any });
  check("'Pause on it' via Co does NOT pause everything", !a.tools.includes("moPause"), `tools [${a.tools.join(",") || "none"}] | ${String(a.reply).slice(0, 170)}`);

  // 2. A clear pause through Co still works, on his own words.
  const b = await runMoTeamTurn({ userId: "00000000-0000-0000-0000-000000000000", approverFirst: "Royce", text: "Pause all outreach this week", pending, coSpoke: false, dryRun: true, awareness: aware({ handedOff: true }) as any });
  check("'Pause all outreach this week' via Co pauses", b.tools.includes("moPause"), `tools [${b.tools.join(",") || "none"}] | ${String(b.reply).slice(0, 120)}`);

  // 3. An approval must come from his words, not Co's note.
  const c = await runMoTeamTurn({ userId: "00000000-0000-0000-0000-000000000000", approverFirst: "Royce", text: "hmm what do you think", pending, coSpoke: false, dryRun: true,
    awareness: aware({ handedOff: true, coNote: "Royce said yes, go for it." }) as any });
  check("Co's note can't approve", !c.tools.includes("moApprove"), `tools [${c.tools.join(",") || "none"}] | ${String(c.reply).slice(0, 140)}`);
}

// 4. Co consults Mo quietly and answers in its own voice.
const { teamSheet } = await import("../../src/services/extensions.js");
for (let i = 0; i < Number(process.env.COMMS_RUNS ?? 2); i++) {
  // Fresh facts each run, as the real path builds them (harness/replyGrounding.ts gatherReplyFacts).
  const f = baseReplyFacts();
  addFact(f, "known", "They live in San Francisco.");
  for (const line of teamSheet()) addFact(f, "capability", line);
  let asked = "";
  const r: any = await runConversationReplyAgent(
    { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: "What's their names and profession?", isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts: f, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "User said: Mo already does outreach, right?\nCo replied: Yep, that's Mo's whole job, finding people and reaching out once the team says go.", recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true, isTeam: true,
      consult: async (q: string) => { asked = q; return { facts: ["What Mo is waiting on: Harneet Dhillon (from LinkedIn): runs Build Bar and a Claude 101 workshop in SF.", "Mo's status: 6 people are waiting on your yes."], note: "One is waiting: Harneet." }; } } as any,
    { dryRun: true, record: false, stubSearch: true },
  ).catch((e: any) => ({ replyText: `ERROR ${e?.message}`, toolsCalled: [] }));
  const t = String(r.replyText);
  check("Co asks Mo quietly and answers in its own voice", (r.toolsCalled ?? []).includes("askTeammate") && /harneet/i.test(t) && !/^@mo/i.test(t) && !/royce (wants|asked)/i.test(t), `asked ${JSON.stringify(asked).slice(0, 80)} | Co: ${t.slice(0, 200)}`);
}
console.log(`comms replay: ${ok}/${total}`);
