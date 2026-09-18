// Emotion loop eval (src/harness/emotion.ts).
//
//   npx tsx evals/emotion/run.ts           code-only: Hume moments, the shared
//                                          context, the struggling hold, the
//                                          no-labeling check
//   npx tsx evals/emotion/run.ts --live    also: text emotion reads (Haiku)
//                                          and replies that reason from feeling
//
// Hard: a label reaches the person ("you sound stressed"), a promotional
// proactive text is eligible while they're struggling, a clear feeling is
// missed or a neutral text gets one, a struggling person gets pitched in a
// reply. Soft: moments, context, and tone quality.
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { loadCases, runEval, type CaseScore, type EvalCase } from "../lib.js";
import {
  checkNoEmotionLabel,
  humeMoments,
  readTextEmotion,
  roomPreferenceFromFeelings,
  summarizeSignals,
  type EmotionSignal,
  type HumeUtterance,
} from "../../src/harness/emotion.js";
import { candidateChecks, type Candidate } from "../../src/harness/proactive.js";
import { MODELS } from "../../src/models.js";
import { runConversationReplyAgent } from "../../src/agent/conversationReply.js";
import { baseReplyFacts } from "../../src/harness/replyGrounding.js";

type Case = EvalCase & Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live");
const NOW = new Date("2026-09-15T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

function signals(rows: any[]): EmotionSignal[] {
  return rows.map((r) => ({ source: r.source, emotion: r.emotion, intensity: r.intensity, valence: r.valence, about: r.about ?? null, quote: r.quote ?? null, at: hoursAgo(r.hoursAgo), target: r.target ?? null }));
}

async function run(c: Case): Promise<any> {
  switch (c.kind) {
    case "hume":
      return humeMoments(c.utterances as HumeUtterance[]);
    case "context":
      return summarizeSignals(signals(c.signals), NOW);
    case "label":
      return checkNoEmotionLabel(c.draft);
    case "hold": {
      const cand: Candidate = {
        id: "1", userId: "u", type: c.type, targetKey: "t", topicKey: "t", summary: "", payload: {}, priority: 0,
        dueAt: NOW, expiresAt: null, attempts: 0, createdAt: NOW,
      } as any;
      return candidateChecks(cand, { now: NOW, sends: [], lastInboundAt: null, needsCare: c.needsCare });
    }
    case "text":
      return readTextEmotion(c.message, c.recentConversation ?? "", "eval.emotion.text");
    case "reply": {
      // The real reply agent, dry run, with the case's feeling as the
      // emotional context block production builds.
      const out = await runConversationReplyAgent(
        {
          userId: "00000000-0000-0000-0000-000000000000",
          phoneNumber: "+10000000000",
          firstName: "Sam",
          resolvedContent: c.message,
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
          toneContext: c.feeling,
          seekingModeContext: "",
          styleHint: "",
          recentConversation: c.recentConversation,
          recentMemories: "",
          contextSummary: c.contextSummary ?? "",
          personaPrompt: null,
          sendCoReply: async () => {},
        },
        { dryRun: true, record: false },
      );
      return out.replyText;
    }
  }
}

async function judgeReply(c: Case, reply: string): Promise<{ pitches: boolean; toneFits: boolean }> {
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    providerOptions: { anthropic: { effort: "low" } },
    prompt: `Someone texted: "${c.message}". What's known about how they feel: ${c.feeling}\nCo replied: "${reply}"\n\nReturn ONLY JSON: {"pitches": true if the reply suggests an event, opportunity, intro, or plan, "toneFits": true if the reply's tone fits how they feel (steady and present when they're struggling, warm and matching when it's good news)}`,
  });
  const p = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  return { pitches: !!p.pitches, toneFits: !!p.toneFits };
}

function score(c: Case, r: any): CaseScore {
  const hard: string[] = [];
  const soft: { name: string; ok: boolean }[] = [];
  switch (c.kind) {
    case "hume": {
      const got = (r as any[]).map((m) => m.emotion);
      if (c.expectEmpty && got.length) hard.push(`moments from neutral call: ${got.join(",")}`);
      for (const e of c.expectIncludes ?? []) soft.push({ name: `moment ${e}`, ok: got.includes(e) });
      if (c.expectMax !== undefined && got.length > c.expectMax) hard.push(`too many moments: ${got.length}`);
      break;
    }
    case "context":
      if (c.expectNeedsCare !== undefined && r.needsCare !== c.expectNeedsCare) hard.push(`needsCare ${r.needsCare}, expected ${c.expectNeedsCare}`);
      if (c.expectCurrent !== undefined) soft.push({ name: "current", ok: (r.current?.emotion ?? null) === c.expectCurrent });
      if (c.expectRecurring !== undefined) soft.push({ name: "recurring", ok: r.recurring.length === c.expectRecurring });
      if (c.expectFrustratedWithCo !== undefined && r.withCo.frustrated !== c.expectFrustratedWithCo) hard.push(`withCo.frustrated ${r.withCo.frustrated}, expected ${c.expectFrustratedWithCo}`);
      if (c.expectRoom !== undefined) {
        const room = roomPreferenceFromFeelings(r);
        if (c.expectRoom === null ? room !== null : !room?.includes(c.expectRoom)) hard.push(`room preference "${room}", expected ${c.expectRoom === null ? "none" : `to include "${c.expectRoom}"`}`);
      }
      break;
    case "label":
      if (c.expectBlocked && r.pass) hard.push(`label not caught: ${c.draft}`);
      if (!c.expectBlocked && !r.pass) soft.push({ name: "false block", ok: false });
      else soft.push({ name: "label check", ok: true });
      break;
    case "hold": {
      const held = r.some((k: any) => k.name === "emotional_timing" && !k.pass);
      if (held !== c.expectHeld) hard.push(`${c.type} held=${held} (needsCare ${c.needsCare})`);
      break;
    }
    case "text":
      if (c.expectNone && r) hard.push(`read "${r.emotion}" from a neutral text`);
      if (!c.expectNone && !r) hard.push("missed a clear feeling");
      if (!c.expectNone && r) soft.push({ name: "valence", ok: r.valence === c.expectValence });
      break;
    case "reply": {
      if (!checkNoEmotionLabel(r.reply).pass) hard.push(`named the feeling: ${r.reply}`);
      if (c.expectNoPitch && r.judged.pitches) hard.push(`pitched while struggling: ${r.reply}`);
      if (c.forbidden && new RegExp(c.forbidden, "i").test(r.reply)) hard.push(`assumed something they didn't say: ${r.reply}`);
      soft.push({ name: "tone fits feeling", ok: r.judged.toneFits });
      break;
    }
  }
  return { hard, soft };
}

const cases = loadCases<Case>(here).filter((c) => (live ? ["text", "reply"].includes(c.kind) : !["text", "reply"].includes(c.kind)));
await runEval<Case, any>({
  name: live ? "emotion (live)" : "emotion (code)",
  dir: here,
  cases,
  concurrency: live ? 4 : 16,
  run: async (c) => {
    const r = await run(c);
    if (c.kind === "reply") return { reply: r, judged: await judgeReply(c, r) };
    return r;
  },
  score,
});
