// Model-free checks for the guards around Co's tools (agent/toolGuard.ts,
// 2026-09-25): switches, limits, their yes, receipts, drift signals.
//
//   npx tsx evals/capabilities/guards.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.CO_VCARD_URL ||= "https://example.com/co.vcf";
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const { yesIsTheirs } = await import("../../src/agent/toolGuard.js");
// The read of their answer (services/theirYes.ts) is a model call: stubbed to yes here, so these checks are about the guards.
(await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));
const { setSwitchesForTest } = await import("../../src/services/abilitySwitches.js");
const { SIGNALS } = await import("../../src/harness/monitor.js");
const { ABILITIES, LIMITS } = await import("../../src/services/capabilities.js");

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const quiet = console.log;
const make = (message: string) => {
  const facts: { kind: string; text: string }[] = [];
  const t = createConversationTools({
    userId: "u", phoneNumber: "+10000000000", resolvedContent: message, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true,
    sendCoReply: async () => true, facts: { add: (kind: string, text: string) => facts.push({ kind, text }), text: () => "" },
  } as any);
  return { tools: t.tools as any, facts };
};
console.log = () => {};

// Switch per ability
setSwitchesForTest({ contact_card: "testing" });
{
  const { tools, facts } = make("send me your card");
  const r = await tools.sendContactCard.execute({ theirWords: "send me your card" }, {});
  check("a switched-off ability refuses", r.ok === false && /switched off/.test(r.error));
  check("…and leaves a NOT DONE receipt", facts.some((f) => f.kind === "not_done" && /switched off/.test(f.text)));
}
setSwitchesForTest({});

// Limits per turn
{
  const { tools, facts } = make("send me your card");
  const first = await tools.sendContactCard.execute({ theirWords: "send me your card" }, {});
  const second = await tools.sendContactCard.execute({ theirWords: "send me your card" }, {});
  check("the first card goes out", first.ok === true);
  check("a second card in the same turn is refused", second.ok === false && /Already done this turn/.test(second.error));
  check("…with a receipt", facts.some((f) => f.kind === "not_done" && /already ran/.test(f.text)));
}

// Their yes before anything that affects another member
{
  const { tools, facts } = make("I met Ellis at the rooftop thing, she was great");
  const r = await tools.requestEventIntro.execute({ personName: "Ellis", theirYes: "yes please connect us" }, {});
  check("an intro without their yes in this message is refused", r.ok === false && /Quote only the words in their message that say yes/.test(r.error));
  check("…and recorded as not done yet", facts.some((f) => f.kind === "not_done" && /quoted yes isn.t in their message/.test(f.text)));
}
{
  const { tools } = make("yes, connect me with Ellis");
  const r = await tools.requestEventIntro.execute({ personName: "Ellis", theirYes: "yes, connect me with Ellis" }, {});
  check("with their own yes, the intro step runs", r.ok !== false);
}
check("their yes has to be in their message", yesIsTheirs("Yes please!", "yes please! connect us") && !yesIsTheirs("sure", "maybe later") && !yesIsTheirs("", "yes"));

// Schemas: Co says why, gives their yes where needed, can ask to resend a missing card
{
  const { tools } = make("");
  const shape = (n: string) => Object.keys(tools[n].inputSchema.shape ?? {});
  check("every guarded tool asks why", ["sendContactCard", "searchEvents", "webSearch", "readPage", "shareFinds", "draftEmail", "shareLink", "saveAsk", "steerAwayFrom", "listSentOffers", "listOpenAsks", "requestEventIntro"].every((n) => shape(n).includes("why")));
  check("the intro tool needs their yes", shape("requestEventIntro").includes("theirYes"));
  check("the card can be resent when it didn't arrive", shape("sendContactCard").includes("resendBecauseMissing"));
  check("replies aren't wrapped", !shape("sendReply").includes("why"));
}

// Registry: hard limits and confirmation are declared, not implied
check("the card is limited to one a day, plus a resend if missing", JSON.stringify(ABILITIES.find((a) => a.id === "contact_card")!.limits) === JSON.stringify({ perTurn: 1, perDay: 1, resendIfMissing: true }));
check("searches are capped per turn (Cue's own loop: agent/loop.ts LOOP_BUDGET)", ABILITIES.find((a) => a.id === "web_search")!.limits!.perTurn === 3 && ABILITIES.find((a) => a.id === "search_events")!.limits!.perTurn === 3 && ABILITIES.find((a) => a.id === "read_page")!.limits!.perTurn === 6);
check("intros: never twice for the same person, and need a yes", !!ABILITIES.find((a) => a.id === "event_intro")!.limits!.oncePerPerson && ABILITIES.find((a) => a.id === "event_intro")!.confirm === "affects_another_member");
check("Cue knows the confirm-first rule", LIMITS.some((l) => /needs their clear yes first/.test(l)));

// Drift signals
const keys = SIGNALS.map((s: any) => s.key);
check("the monitor watches NOT DONE receipts", keys.includes("tool_not_done"));
check("the monitor watches limit refusals", keys.includes("tool_limited"));
check("the monitor watches each tool's use", ABILITIES.filter((a) => a.tool && !["sendReply", "markTopicAsked"].includes(a.tool)).every((a) => keys.includes(`tool_use_${a.tool}`)));
check("the old card-veto signal is gone", !keys.includes("card_misfire"));

// Lines Co writes itself (services/voiceLine.ts) keep to what they were given.
{
  const { lineKeepsRules } = await import("../../src/services/voiceLine.js");
  const ask = { facts: ["Noor joined Cue on their invite.", "They have 3 invites left; one only counts once someone joins."], mustInclude: ["Noor"] };
  check("a line that keeps to the facts is used", lineKeepsRules("Noor's in on your invite. You've got 3 left.", ask));
  check("a number it wasn't given is refused", !lineKeepsRules("Noor's in. You've got 4 left.", ask));
  check("a missing name is refused", !lineKeepsRules("Your friend's in. Good taste.", ask));
  check("a dash is refused", !lineKeepsRules("Noor's in — good taste.", ask));
  check("a link or placeholder is refused", !lineKeepsRules("Noor's in: https://x.co {name}", ask));
  check("an empty line is refused", !lineKeepsRules("  ", ask));
  const sb = (await import("fs")).readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  // The automatic first call offer is gone (Royce, 2026-11-02, onboarding ruling 3): the welcome and friend-joined lines remain.
  check("the welcome and friend-joined lines are written by Cue, and no automatic call offer is", (sb.match(/await lineInVoice\(\{/g) ?? []).length === 2 && !/purpose: "Right after they gave their name and email: offer a quick five-minute call/.test(sb));
  check("the invite-code gate lines stay fixed", /pickLine\(GATE_ASK\)/.test(sb) && /pickLine\(WRONG_CODE\)/.test(sb));
}

// Proactive: Co chooses only when there's a real choice, and never "nothing".
{
  const { choosePick } = await import("../../src/harness/proactive.js");
  const one = await choosePick([{ id: "c1", userId: "u", type: "event_offer", targetKey: "a", topicKey: "a", summary: "x", priority: 1, dueAt: new Date(), expiresAt: null, payload: {}, attempts: 0, createdAt: new Date() } as any], { recentConversation: "", feeling: "" });
  check("one eligible message: code picks it, no model call", one.source === "code" && one.pick?.id === "c1");
  const none = await choosePick([], { recentConversation: "", feeling: "" });
  check("nothing eligible: nothing picked", none.pick === null);
  const src = (await import("fs")).readFileSync(new URL("../../src/harness/proactive.ts", import.meta.url), "utf8");
  check("a pick that isn't eligible falls back to priority", /const pick = eligible\.find\(\(c\) => c\.id === String\(parsed\?\.id/.test(src) && /const fallback = proposePick\(eligible\)/.test(src));
}

console.log = quiet;
console.log(`tool guard rules: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
