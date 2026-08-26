import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { createConversationTools, deliverReply } from "./conversationTools.js";
import pool from "../../../api/src/db/db.js";

export type ConversationReplyInput = {
  userId: string;
  phoneNumber: string;
  firstName: string;
  content: string;
  hasPendingOffer: boolean;
  recentOfferBurstActive: boolean;
  callAction: string;
  isThinProfileFirstMessage: boolean;
  personaPrompt: string | null;
  profileContext: string | null;
  missingTopicsContext: string;
  recentConversation: string;
  isFirstContact: boolean;
  recommendationContext: string;
  venueContext: string;
  callFeatureQuestionContext: string;
  scheduleCallContext: string;
  closingContext: string;
  seekingModeContext: string;
  toneContext: string;
  styleHint: string;
};

// Re-checks the actual sent text for whether it's a call offer, rather than
// trusting the model to have self-declared it via a tool call. Restored
// after a real conversation showed the model calling offerCall right after a
// reply that never mentioned a call at all — a false positive that set
// call_offer_pending and, combined with a pre-existing classifier gap, led
// to two unwanted real outbound calls. Same question and gating the deleted
// offerCall tool / original callOfferCheck used.
async function verifyAndRecordCallOffer(
  input: Pick<ConversationReplyInput, "userId" | "content" | "hasPendingOffer" | "recentOfferBurstActive">,
  replyText: string,
  dryRun: boolean,
): Promise<boolean> {
  if (input.hasPendingOffer || input.recentOfferBurstActive || !replyText) return false;
  try {
    const { text: rawCheck } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "co-test.agent.conversationReply.callOfferCheck" },
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
      `User described: ${input.content} | Co offered: ${replyText}`,
    ])
    .catch((err: any) => console.error("conversationReply: call_offer_pending memory write failed (non-fatal):", err?.message ?? err));
  return true;
}

// Co Loop Stage 1, agentized — co-test's version of api/src/agent/conversationReply.ts,
// same shape (generateText + tools + stopWhen), extended with this file's
// extra context blocks (recommendation, schedule-call, closing, seeking-mode)
// that prod's harness doesn't have. Does NOT own whether to place a real
// call, or the scheduleCallContext commitment itself (both stay deterministic
// in webhooks.ts) — only the secondary call-offer gesture + reply content.
export async function runConversationReplyAgent(
  input: ConversationReplyInput,
  opts: { dryRun?: boolean } = {},
): Promise<{ sent: boolean; offered: boolean; replyText: string }> {
  const { tools, state } = createConversationTools({
    userId: input.userId,
    phoneNumber: input.phoneNumber,
    content: input.content,
    hasPendingOffer: input.hasPendingOffer,
    recentOfferBurstActive: input.recentOfferBurstActive,
    dryRun: opts.dryRun ?? false,
  });

  const callOfferEligible =
    !input.hasPendingOffer &&
    !input.recentOfferBurstActive &&
    (input.callAction === "would_benefit" || input.isThinProfileFirstMessage);

  const callOfferInstruction = callOfferEligible
    ? input.isThinProfileFirstMessage
      ? `This is the first real thing they've shared and nothing is known about them yet — this is a good moment for a quick, low-pressure call, a real conversation gets Co further than texting back and forth. After responding, offer one. Keep it brief and secondary. Do not place any call, just make the gesture. Only skip it if it would genuinely feel forced or tone-deaf right after this specific reply — being eligible means you should default to offering, not treat it as merely optional.`
      : `What they just shared could genuinely benefit from a real conversation by voice — this is a good moment to offer one. After genuinely responding — and after leading with anything concrete you have to offer below (a real recommendation), if any — offer a call as a warm gesture, not a logistics question — like "I'm here if you'd ever want to hop on a call and actually talk it through," not "are you free today or tomorrow." The offer has to actually name a call or talking by phone somewhere in it — a vague "I'm here if you want to talk" doesn't clearly read as a call offer to them any more than it would to anyone else, so don't rely on that alone. Do not place any call, just make the gesture. Only skip it if it would genuinely feel forced or tone-deaf right after this specific reply — being eligible means you should default to offering, not treat it as merely optional.`
    : `A call offer is NOT available this turn (one is already pending, or was offered too recently) — do not mention, suggest, or ask about a phone call in your reply at all, in any wording, even indirectly. Just respond genuinely to what they said.`;

  const system = `${input.personaPrompt ?? "You are Co, an exclusive life concierge."}

You are having this specific exchange over text message, not a phone call — the phase structure and pacing above describe a live call; over text, just be genuinely Co: the same listening style, the same voice, the same principles, picking up wherever this conversation actually is.

${input.firstName} is texting you — you already have their number, never ask them for it.

You reaching this point means no call is being placed right now — if a call were actually being triggered this turn, a separate confirmation message handles that instead of this reply. Never say or imply "calling now," "calling you", or that you're dialing/have dialed them this turn. If a scheduled call exists, it's covered below — talk about it as scheduled for later, not as happening now.

What you already know about ${input.firstName} from a prior call:
${input.profileContext || "(nothing on file yet from a call — this is effectively a first conversation)"}
${input.missingTopicsContext}
Recent text conversation, in order:
${input.recentConversation || "(start of the text conversation)"}

${input.firstName} just said: "${input.content}"
${input.isFirstContact ? `\nThis is the very start of your first real conversation with ${input.firstName} — they just finished the intro sequence above (greeting, what CoPatible is, saving your contact, verification). What they just said may be nothing more than a greeting from tapping "message Co to start," not real content to react to. If it IS something real, pick up from it genuinely. If it's just a greeting or blank, don't react to it as if it were substantive — instead open the real conversation yourself, the same way you would at the start of a call: warm, unhurried, inviting the real version of their life, not a status update.\n` : ""}${input.recommendationContext}${input.venueContext}${input.callFeatureQuestionContext}${input.scheduleCallContext}${input.closingContext}${input.toneContext}${input.seekingModeContext}
${input.styleHint}
Ground everything ONLY in the information above and what has actually been said in this conversation — never state or imply a specific personal detail, preference, or fact about them that isn't listed above or wasn't actually said in this thread. This includes real venues and businesses: never name a specific one unless it's given to you above as something you actually found — if you don't have a real one, describe what you'd look for, don't guess a plausible-sounding name. If you don't have something, ask rather than assume.

Decide what to do, then act using your tools:
- Always respond genuinely to what they said first. Match the weight of your reply to theirs: a short or simple message earns a short, simple reply — often just a sentence. Something long, layered, or emotionally loaded earns real room to actually respond to it, not a one-liner that brushes past what they just shared. Either way this is a text-message-length turn, not a call-length response — a few sentences at most, never a wall of text. Even when matching a short exchange's brevity, don't let it go purely reactive — if the conversation is genuinely stalling, keep giving it somewhere to go: a question, an observation, a related thought. Never rely on a question mark as the only tool for that, and never force it onto an exchange that's naturally winding down or already has real momentum. No exclamation points, no em dashes. If you're relaying a real find (a name, a reason, a link), give it the room it actually needs rather than cutting it short.
- You have room for AT MOST ONE secondary, optional gesture folded into the same reply — never let it replace actually responding. ${callOfferInstruction}
- Call sendReply once with your reply. Only call it a second time if you genuinely have a second, separate thought that reads more naturally as its own text sent right after — never to split one continuous thought into shorter pieces.`;

  await generateText({
    // Sonnet, not Haiku (unlike prod's version) — dry-run testing showed
    // Haiku missing the offerCall follow-up call ~2/5 times even when the
    // reply text clearly gestured toward a call, which breaks
    // call_offer_pending tracking (a later "yes" gets misread as unrelated).
    // This is a correctness/state-consistency issue, not just phrasing
    // quality, so it justifies the latency/cost tradeoff.
    model: anthropic("claude-sonnet-4-6"),
    system,
    prompt: "Respond to what they just said.",
    tools,
    // 6, not 5 — a genuine second sendReply call now needs an extra
    // call/result round trip the single-reply design didn't.
    stopWhen: stepCountIs(6),
    experimental_telemetry: { isEnabled: true, functionId: "co-test.agent.conversationReply" },
  });

  if (!state.sent) {
    console.error(
      `conversationReply: agent completed without calling sendReply for user ${input.userId} — sending fallback`,
    );
    const fallback = "Hey, sorry, got a bit tangled up on my end. What's on your mind?";
    await deliverReply(
      {
        userId: input.userId,
        phoneNumber: input.phoneNumber,
        content: input.content,
        hasPendingOffer: input.hasPendingOffer,
        recentOfferBurstActive: input.recentOfferBurstActive,
        dryRun: opts.dryRun ?? false,
      },
      fallback,
    );
    state.sent = true;
    state.lastReplyText = fallback;
  }

  const offered = await verifyAndRecordCallOffer(input, state.lastReplyText, opts.dryRun ?? false);

  return { sent: state.sent, offered, replyText: state.lastReplyText };
}
