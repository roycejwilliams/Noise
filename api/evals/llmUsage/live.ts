// Live check of the cost log and prompt caching on Co's real reply path
// (dry run: nothing is sent, nothing is written). Two texts in a row from the
// same made-up member, the second 20 seconds after the first, like a real
// back-and-forth. Prints one line per request to Claude.
//
//   railway run --service co-test --environment dev -- npx tsx evals/llmUsage/live.ts
import "dotenv/config";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { usageFromSpan, type UsageRow } from "../../src/services/llmUsage.js";

const rows: UsageRow[] = [];
new NodeSDK({
  spanProcessors: [
    {
      onStart() {},
      onEnd(span: ReadableSpan) {
        const r = usageFromSpan(span.name, span.attributes as Record<string, unknown>, span.spanContext().traceId);
        if (r) rows.push(r);
      },
      async forceFlush() {},
      async shutdown() {},
    } as any,
  ],
}).start();

const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
const { renderCoPersonaPrompt } = await import("../../src/services/coPersona.js");
const { baseReplyFacts } = await import("../../src/harness/replyGrounding.js");

const contextSummary = "Jordan is a product designer in San Francisco, new to the city since June, looking for people who build things and a regular running group.";
const personaPrompt = await renderCoPersonaPrompt("Jordan", contextSummary);
console.log(`call guide loaded: ${personaPrompt ? personaPrompt.length + " chars" : "no"}`);

async function reply(message: string, recentConversation: string) {
  const before = rows.length;
  const out = await runConversationReplyAgent(
    {
      userId: "00000000-0000-0000-0000-000000000000",
      phoneNumber: "+10000000000",
      firstName: "Jordan",
      resolvedContent: message,
      isVoice: false,
      imageForVision: null,
      hasPendingOffer: true,
      recentOfferBurstActive: false,
      callAction: "none",
      isThinProfileFirstMessage: false,
      isFirstContact: false,
      missingTopic: null,
      missingTopicDescription: null,
      facts: baseReplyFacts(),
      toneContext: "",
      seekingModeContext: "",
      styleHint: "",
      recentConversation,
      recentMemories: "",
      contextSummary,
      personaPrompt,
      sendCoReply: async () => true,
    },
    { dryRun: true, record: false },
  );
  await new Promise((r) => setTimeout(r, 1500)); // let the spans end
  const mine = rows.slice(before);
  console.log(`\n"${message}" -> "${out.replyText.slice(0, 80)}..."`);
  for (const r of mine) {
    console.log(`  ${r.functionId.padEnd(34)} ${r.model.padEnd(26)} uncached ${String(r.inputUncached).padStart(6)}  write ${String(r.cacheWrite).padStart(6)}  read ${String(r.cacheRead).padStart(6)}  out ${String(r.output).padStart(5)}  $${r.costUsd?.toFixed(5)}`);
  }
  return mine;
}

const a = await reply("had a rough week honestly. work is fine but I still don't really know anyone here", "");
await new Promise((r) => setTimeout(r, 20_000));
const b = await reply(
  "yeah maybe. I used to run a lot back home",
  `User said: had a rough week honestly. work is fine but I still don't really know anyone here\nCo replied: ${"(reply above)"}`,
);
const loop = (rs: UsageRow[]) => rs.filter((r) => r.functionId === "agent.conversationReply");
const la = loop(a), lb = loop(b);
console.log(`\nreply loop steps: ${la.length} then ${lb.length}`);
console.log(`later steps read from cache: ${la.slice(1).every((r) => r.cacheRead > 0) && lb.slice(1).every((r) => r.cacheRead > 0)}`);
console.log(`second text reused the first's slow-changing part: ${(lb[0]?.cacheRead ?? 0) > 0} (${lb[0]?.cacheRead ?? 0} tokens)`);
process.exit(0);
