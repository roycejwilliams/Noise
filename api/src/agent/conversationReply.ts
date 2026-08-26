import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { createConversationTools, type SendCoReply } from "./conversationTools.js";
import { writeMemory } from "../services/memory.js";
import pool from "../db/db.js";

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

// Re-checks the actual sent text for whether it's a call offer, rather than
// trusting the model to have self-declared it via a tool call. Restored
// after a real conversation showed the model calling offerCall right after a
// reply that never mentioned a call at all — a false positive that set
// call_offer_pending and, combined with a pre-existing classifier gap, led
// to two unwanted real outbound calls. Same question and gating the deleted
// offerCall tool / original callOfferCheck used.
async function verifyAndRecordCallOffer(
  input: Pick<ConversationReplyInput, "userId" | "resolvedContent" | "hasPendingOffer" | "recentOfferBurstActive">,
  replyText: string,
  dryRun: boolean,
): Promise<boolean> {
  if (input.hasPendingOffer || input.recentOfferBurstActive || !replyText) return false;
  try {
    const { text: rawCheck } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "agent.conversationReply.callOfferCheck" },
      prompt: `Does this text message actually offer, invite, or gesture toward a phone call — in any wording, even indirectly (e.g. "I'm here if you want to talk this through")? Not just related to talking or listening in general — specifically about a phone call.

Message: "${replyText}"

Return ONLY "yes" or "no".`,
    });
    if (!rawCheck.trim().toLowerCase().startsWith("yes")) return false;
  } catch (err: any) {
    console.error("conversationReply: call-offer verification failed (non-fatal, not recording a pending offer):", err?.message ?? err);
    return false;
  }
  if (dryRun) {
    console.log(`[conversationReply dryRun] would record call_offer_pending for ${input.userId}`);
    return true;
  }
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'call_offer_pending', $2)`, [
      input.userId,
      `User described: ${input.resolvedContent} | Co offered: ${replyText}`,
    ])
    .catch((err: any) => console.error("conversationReply: call_offer_pending memory write failed (non-fatal):", err?.message ?? err));
  return true;
}

// Co Loop Stage 1, agentized: replaces the hardcoded shouldOfferCall/
// usingTopicNudge branching with a tool-calling loop that decides the reply
// and topic-nudge gesture. Whether a call offer went out is NOT
// self-declared by the model (see verifyAndRecordCallOffer above) — it's
// verified against the actual sent text afterward. Does NOT own whether to
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
- Always respond genuinely to what they said first. Match the weight of your reply to theirs: a short or simple message earns a short, simple reply — often just a sentence. Something long, layered, or emotionally loaded earns real room to actually respond to it, not a one-liner that brushes past what they just shared. Either way this is still a text message, not an essay — a few sentences at most, never a wall of text. Even when matching a short exchange's brevity, don't let it go purely reactive — if the conversation is genuinely stalling, keep giving it somewhere to go: a question, an observation, a related thought. Never rely on a question mark as the only tool for that, and never force it onto an exchange that's naturally winding down or already has real momentum. No em dashes, no exclamation points.${input.imageForVision ? " React to what's actually in the photo." : " Use their context to make it personal."}
- You have room for AT MOST ONE secondary, optional gesture folded into the same reply — never both, and never let a gesture replace actually responding. Options, in case either fits:
${callOfferEligible ? (input.isThinProfileFirstMessage ? `  - This is the first real thing they've shared and nothing is known about them yet — this is a good moment for a quick, low-pressure call, a real conversation gets Co further than texting back and forth. After responding, offer one. Keep it brief and secondary. Do not place any call, just make the gesture. Only skip it if it would genuinely feel forced or tone-deaf right after this specific reply — being eligible means you should default to offering, not treat it as merely optional.` : `  - What they just shared could genuinely benefit from a real conversation by voice — this is a good moment to offer one. After genuinely responding, offer a call as a warm gesture, not a logistics question — like "I'm here if you'd ever want to hop on a call and actually talk it through," not "are you free today or tomorrow." The offer has to actually name a call or talking by phone somewhere in it — a vague "I'm here if you want to talk" doesn't clearly read as a call offer to them any more than it would to anyone else, so don't rely on that alone. Do not place any call, just make the gesture. Only skip it if it would genuinely feel forced or tone-deaf right after this specific reply — being eligible means you should default to offering, not treat it as merely optional.`) : `  - A call offer is NOT available this turn (one is already pending, or was offered too recently) — do not mention, suggest, or ask about a phone call in your reply at all, in any wording, even indirectly. Just respond genuinely to what they said.`}
${input.missingTopic ? `  - Co doesn't yet have a good sense of ${input.missingTopicDescription}. If it fits naturally after responding, you can work in one brief, genuine question toward that — never force it, skip it if nothing natural comes up. If you use it, call markTopicAsked with topic "${input.missingTopic}" after sendReply.` : ""}
- Call sendReply once with your reply.${input.isVoice ? "" : " Only call it a second time if you genuinely have a second, separate thought that reads more naturally as its own text sent right after — never to split one continuous thought into shorter pieces."} Then call markTopicAsked only if you actually used that gesture in the message you sent.`;

  const userText = input.imageForVision ? "Respond to what they just sent." : "Respond to what they just said.";

  await generateText({
    model: anthropic("claude-haiku-4-5-20251001"),
    system,
    tools,
    // 6, not 5 — a genuine second sendReply call now needs an extra
    // call/result round trip the single-reply design didn't.
    stopWhen: stepCountIs(6),
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

  const offered = await verifyAndRecordCallOffer(input, state.lastReplyText, opts.dryRun ?? false);

  return { sent: state.sent, offered, replyText: state.lastReplyText };
}
