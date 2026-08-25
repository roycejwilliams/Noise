import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { createConversationTools, type SendCoReply } from "./conversationTools.js";
import { writeMemory } from "../services/memory.js";

export type ConversationReplyInput = {
  userId: string;
  phoneNumber: string;
  firstName: string;
  resolvedContent: string;
  isVoice: boolean;
  imageForVision: { data: Buffer; mediaType: string } | null;
  hasPendingOffer: boolean;
  recentOfferBurstActive: boolean;
  callAction: string;
  isThinProfileFirstMessage: boolean;
  missingTopic: string | null;
  missingTopicDescription: string | null;
  momentContext: string;
  toneContext: string;
  styleHint: string;
  recentConversation: string;
  recentMemories: string;
  sendCoReply: SendCoReply;
};

// Co Loop Stage 1, agentized: replaces the hardcoded shouldOfferCall/
// usingTopicNudge branching and the separate post-hoc callOfferCheck
// verification call (sendblue.ts) with one tool-calling loop that decides
// AND records what it did — a tool call is the explicit signal now, instead
// of inferring intent from free text after the fact. Does NOT own whether to
// place a real call (that stays deterministic in sendblue.ts, gated purely
// on explicit classifier output) — only the secondary gesture + reply.
export async function runConversationReplyAgent(
  input: ConversationReplyInput,
  opts: { dryRun?: boolean } = {},
): Promise<{ sent: boolean; offered: boolean; replyText: string }> {
  const { tools, state } = createConversationTools({
    userId: input.userId,
    phoneNumber: input.phoneNumber,
    resolvedContent: input.resolvedContent,
    isVoice: input.isVoice,
    hasPendingOffer: input.hasPendingOffer,
    recentOfferBurstActive: input.recentOfferBurstActive,
    dryRun: opts.dryRun ?? false,
    sendCoReply: input.sendCoReply,
  });

  const callOfferEligible =
    !input.hasPendingOffer &&
    !input.recentOfferBurstActive &&
    (input.callAction === "would_benefit" || input.isThinProfileFirstMessage);

  const system = `You are Co, an exclusive life concierge, replying by iMessage to ${input.firstName}.

${input.momentContext}
${input.toneContext}
${input.styleHint}

Recent conversation, in order (this is the actual thread — follow it; don't jump to older topics from "other context" below unless they bring it up again):
${input.recentConversation || "(this is the start of the conversation)"}

Other context that might be relevant, but may be from a different time or topic — use only if it actually applies to what they just said:
${input.recentMemories}

${input.imageForVision ? "They just sent the attached photo." : `They just said: "${input.resolvedContent}"`}

Decide what to do, then act using your tools:
- Always respond genuinely to what they said first. Warm, specific, brief — 2 sentences max, no em dashes, no exclamation points.${input.imageForVision ? " React to what's actually in the photo." : " Use their context to make it personal."}
- You have room for AT MOST ONE secondary, optional gesture folded into the same reply — never both, and never let a gesture replace actually responding. Options, in case either fits:
${callOfferEligible ? (input.isThinProfileFirstMessage ? `  - This is the first real thing they've shared and nothing is known about them yet. After responding, you may offer a quick, low-pressure call as a warm way to actually get to know them — a real conversation gets Co further than texting back and forth. Keep it brief and secondary. Do not place any call, just make the gesture — if you use it, call offerCall after sendReply.` : `  - What they just shared could genuinely benefit from a real conversation by voice. If it still feels right after genuinely responding, you may offer a call as a warm gesture, not a logistics question — like "I'm here if you ever want to actually talk this through," not "are you free today or tomorrow." Do not place any call, just make the gesture — if you use it, call offerCall after sendReply.`) : `  - A call offer is NOT available this turn (one is already pending, or was offered too recently) — do not mention, suggest, or ask about a phone call in your reply at all, in any wording, even indirectly. Just respond genuinely to what they said.`}
${input.missingTopic ? `  - Co doesn't yet have a good sense of ${input.missingTopicDescription}. If it fits naturally after responding, you can work in one brief, genuine question toward that — never force it, skip it if nothing natural comes up. If you use it, call markTopicAsked with topic "${input.missingTopic}" after sendReply.` : ""}
- Call sendReply exactly once with your final message. Then call offerCall and/or markTopicAsked only if you actually used those gestures in the message you sent.`;

  const userText = input.imageForVision ? "Respond to what they just sent." : "Respond to what they just said.";

  await generateText({
    model: anthropic("claude-haiku-4-5-20251001"),
    system,
    tools,
    stopWhen: stepCountIs(5),
    experimental_telemetry: { isEnabled: true, functionId: "agent.conversationReply" },
    ...(input.imageForVision
      ? {
          messages: [
            {
              role: "user" as const,
              content: [
                { type: "image" as const, image: input.imageForVision.data, mediaType: input.imageForVision.mediaType },
                { type: "text" as const, text: userText },
              ],
            },
          ],
        }
      : { prompt: userText }),
  });

  // Unlike a plain generateText completion (which always returns text), a
  // tool-calling loop can finish without ever invoking sendReply — the
  // model runs out of its step budget mid-reasoning, or just answers in
  // plain text instead of using the tool. Silently sending nothing back is
  // a real regression versus the old code, which always produced something
  // to send, so this guarantees a reply goes out either way.
  if (!state.sent) {
    console.error(
      `conversationReply: agent completed without calling sendReply for user ${input.userId} — sending fallback`,
    );
    const fallback = "Hey, sorry, got a bit tangled up on my end. What's on your mind?";
    if (opts.dryRun) {
      console.log(`[conversationReply dryRun] fallback would send to ${input.userId}: "${fallback}"`);
    } else {
      await input.sendCoReply({ phone: input.phoneNumber, message: fallback, asVoice: input.isVoice });
      await writeMemory(input.userId, "text_exchange", `Co replied: ${fallback}`);
    }
    state.sent = true;
    state.lastReplyText = fallback;
  }

  return { sent: state.sent, offered: state.offered, replyText: state.lastReplyText };
}
