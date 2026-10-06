// Replays real turns (evals/replay/cases.ts) through Co's reply path: the turn
// reader, the reply agent with its tools, and the fact check, the way a real
// text runs. Searches are stubbed (nothing spent on the web, nothing sent).
// Run it every time the prompt or the loop changes; it fails on any miss.
// About $0.04 a case.
//
//   railway run npx tsx evals/replay/run.ts          # all cases
//   ONLY=proactive railway run npx tsx evals/replay/run.ts
import "../lib/requireMeter.js";
import "dotenv/config";
import "../testEnv.js";
import { writeFileSync } from "node:fs";
const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const G = await import("../../src/harness/replyGrounding.js");
const R = await import("../../src/services/readTurn.js");
const { LOOP_GUIDE } = await import("../../src/agent/loop.js");
const { CASES } = await import("./cases.js");
const quiet = console.log;
console.log = (...a: any[]) => { if (!/dryRun\]/.test(String(a[0]))) quiet(...a); };

const only = process.env.ONLY;
const runs = Number(process.env.RUNS ?? 1);
const results: any[] = [];
let failed = 0;
for (const c of CASES.filter((x) => !only || x.id.includes(only))) {
  for (let n = 0; n < runs; n++) {
    const facts = G.baseReplyFacts();
    // What every real reply knows from their profile.
    G.addFact(facts, "known", "They live in San Francisco.");
    for (const [kind, text] of c.facts) G.addFact(facts, kind as any, text);
    if (c.note) G.addInstruction(facts, c.note);
    // As production does: the read decides; its notes go in the way sendblue.ts adds them.
    const read: any = await R.readTurn({ message: c.message, recentConversation: c.recent, openItems: [] }, null, null).catch(() => null);
    if (read?.aboutCo) G.addInstruction(facts, R.ABOUT_CO_INSTRUCTION);
    if (read?.router?.wantsRecommendation) G.addInstruction(facts, LOOP_GUIDE);
    const note = R.feedbackInstruction(read?.feedback ?? []);
    if (note) G.addInstruction(facts, note);
    const r: any = await runConversationReplyAgent(
      { ackSent: c.ackSent ?? null, userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Royce", resolvedContent: c.message, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: c.recent, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true },
      { dryRun: true, record: false, stubSearch: true },
    ).catch((e: any) => ({ replyText: `ERROR ${e?.message}`, toolsCalled: [] }));
    const text = String(r.replyText ?? "");
    const tools: string[] = r.toolsCalled ?? [];
    const misses = [
      ...(c.must ?? []).filter((re) => !re.test(text)).map((re) => `missing ${re}`),
      ...(c.mustNot ?? []).filter((re) => re.test(text)).map((re) => `says ${re}`),
      ...(c.toolsMust && !c.toolsMust.some((t) => tools.includes(t)) ? [`didn't use ${c.toolsMust.join(" or ")}`] : []),
      ...(c.toolsMustNot ?? []).filter((t) => tools.includes(t)).map((t) => `used ${t}`),
      ...(c.ackNot ?? []).filter((e) => read?.ack && read.ack.replace(/\uFE0F/g, "") === e.replace(/\uFE0F/g, "")).map((e) => `reacted ${e}`),
      ...(c.ackSomething && !read?.ack ? ["no reaction where one fits"] : []),
      ...(c.move && ![c.move].flat().includes(r.move) ? [`move ${r.move ?? "none"}, wanted ${[c.move].flat().join(" or ")}`] : []),
    ];
    if (misses.length) failed++;
    // What the fact check did to each message (cut, redrafted, stripped) and why.
    const checked = (r.grounding ?? []).filter((g: any) => g.outcome && g.outcome !== "as_drafted" && g.outcome !== "unchecked").map((g: any) => `${g.outcome}: ${(g.checks ?? []).filter((x: any) => !x.pass).map((x: any) => x.reason ?? x.name).join(" | ").slice(0, 300)}`);
    results.push({ id: c.id, ok: !misses.length, misses, tools, move: r.move ?? null, text, checked });
    quiet(`${misses.length ? "FAIL" : "ok  "} ${c.id}${misses.length ? `  (${misses.join("; ")})` : ""}\n     move=${r.move ?? "none"} tools=${JSON.stringify(tools)} reaction=${read?.ack ?? "none"}\n     ${text.replace(/\n+/g, " / ").slice(0, 300)}${checked.length ? `\n     fact check: ${checked.join(" || ")}` : ""}`);
  }
}
writeFileSync(new URL("./last.local.json", import.meta.url), JSON.stringify(results, null, 2));
quiet(`\nreplay: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
