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
  isFirstContact: boolean;
  missingTopic: string | null;
  missingTopicDescription: string | null;
  momentContext: string;
  recommendationContext: string;
  eventOfferContext: string;
  venueContext: string;
  callFeatureQuestionContext: string;
  scheduleCallContext: string;
  toneContext: string;
  seekingModeContext: string;
  styleHint: string;
  recentConversation: string;
  recentMemories: string;
  // Same buildContextSummary() output baked into personaPrompt's
  // {{context_summary}} slot (see coPersona.ts) — but that slot only gets
  // read by the model as an instruction for OPENING a call ("Phase 1 —
  // Rapport... open by picking up from something specific"). Over text, the
  // system prompt below tells the model to disregard the call's phase
  // structure, which left this genuinely unclear to be weighted the same
  // way on turn 40 of an ongoing thread. Surfaced again here, explicitly and
  // unconditionally, so what Co already knows about this person carries the
  // same weight as something they just said in this conversation — not
  // background trivia contingent on a call-opening instruction that no
  // longer applies.
  contextSummary: string;
  // The actual live Hume EVI system prompt (see coPersona.ts), rendered with
  // this person's context — same entity whether talking by voice or text.
  // Null only if the Hume config fetch itself failed; falls back to a
  // thinner default in the system prompt below rather than blocking the
  // reply on it.
  personaPrompt: string | null;
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

// Resolves whether each topically-retrieved memory actually applies to what
// was just said, before it's handed to the reply agent as foreground
// context — see the Step 5 comment in sendblue.ts for the bug this guards
// against: vector similarity search has no sense of recency or real
// relevance, and unfiltered this produced a reply referencing an unrelated
// "3pm" proposal from a different conversation entirely. Cheap/fast model,
// same tradeoff as verifyAndRecordCallOffer below: a yes/no-shaped
// classification, not a creative task. Fails closed (drops the memories)
// rather than open, since passing through unverified content is exactly
// the failure mode this exists to prevent.
export async function filterRelevantMemories(resolvedContent: string, candidates: string[]): Promise<string> {
  if (!candidates.length) return "";
  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "agent.conversationReply.filterRelevantMemories" },
      prompt: `A user just said: "${resolvedContent}"

Here are memories retrieved by topic similarity — they may or may not actually be about what the user just said (similarity search has no sense of recency or real relevance):
${candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Return ONLY the numbers of the memories that are genuinely relevant to what the user just said, comma-separated (e.g. "1,3"). Return "none" if none of them actually apply.`,
    });
    const trimmed = text.trim().toLowerCase();
    if (trimmed.startsWith("none")) return "";
    const indices = trimmed
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length);
    return indices.map((i) => candidates[i]).join("\n");
  } catch (err: any) {
    console.error(
      "conversationReply: filterRelevantMemories failed (non-fatal, dropping retrieved memories this turn):",
      err?.message ?? err,
    );
    return "";
  }
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

  const system = `${input.personaPrompt ?? "You are Co, an exclusive life concierge."}

You are having this specific exchange over text message, not a phone call — the phase structure and pacing above describe a live call; over text, just be genuinely Co: the same listening style, the same voice, the same principles, picking up wherever this conversation actually is, replying by iMessage to ${input.firstName}.

${input.firstName} is texting you — you already have their number, never ask them for it.

What you already know about ${input.firstName} from before — treat this the same as something they just told you in this conversation, not as optional background to bring up only if convenient:
${input.contextSummary || "(nothing on file yet — this is effectively a first real conversation with them)"}

${input.momentContext}
${input.recommendationContext}${input.eventOfferContext}${input.venueContext}${input.callFeatureQuestionContext}${input.scheduleCallContext}
${input.toneContext}
${input.seekingModeContext}
${input.styleHint}
${input.isFirstContact ? `\nThis is the very start of your first real conversation with ${input.firstName} — they just finished the intro sequence (greeting, what CoPatible is, saving your contact, verification). What they just said may be nothing more than a greeting, not real content to react to.${input.contextSummary ? ` You already have real context on them (see "What you already know" above, from onboarding or a prior touchpoint) — lead with it. Your first line should pick up from something specific and real in it, the same way you would open a call, not a generic greeting that ignores what you already have.` : ""} If it IS something real, pick up from it genuinely. If it's just a greeting or blank, don't react to it as if it were substantive — instead open the real conversation yourself${input.contextSummary ? ", grounded in what you already know about them" : ""}, warm, unhurried, inviting the real version of their life, not a status update.\n` : ""}
Recent conversation, in order (this is the actual thread — follow it; don't jump to older topics from "other context" below unless they bring it up again):
${input.recentConversation || "(this is the start of the conversation)"}

What Co knows from past conversations that's genuinely relevant to what they just said — already checked for relevance before being handed to you, so treat it with the same weight as this thread, not as optional trivia:
${input.recentMemories || "(nothing from past conversations applies to what they just said)"}

${input.imageForVision ? "They just sent the attached photo." : `They just said: "${input.resolvedContent}"`}

Ground everything ONLY in the information above and what has actually been said in this conversation — never state or imply a specific personal detail, preference, or fact about them that isn't listed above or wasn't actually said in this thread. This includes real venues and businesses: never name a specific one unless it's given to you above as something you actually found — if you don't have a real one, describe what you'd look for, don't guess a plausible-sounding name.

Decide what to do, then act using your tools:
- Always respond genuinely to what they said first. Match the weight of your reply to theirs: a short or simple message earns a short, simple reply — often just a sentence. Something long, layered, or emotionally loaded earns real room to actually respond to it, not a one-liner that brushes past what they just shared. Either way this is still a text message, not an essay — a few sentences at most, never a wall of text. Even when matching a short exchange's brevity, don't let it go purely reactive — if the conversation is genuinely stalling, keep giving it somewhere to go: a question, an observation, a related thought. Never rely on a question mark as the only tool for that, and never force it onto an exchange that's naturally winding down or already has real momentum. Separately — when they state something concrete about what they want or who they're looking for, that's worth deepening with a specific follow-up question even if the conversation already has momentum; just validating it back leaves it vague when one more question would actually sharpen it. Vary how each reply opens — don't default to restating what they said as "That [noun phrase], ..." every time; sometimes just respond directly without that framing. No em dashes, no exclamation points.${input.imageForVision ? " React to what's actually in the photo." : " Use their context to make it personal."}
- You have room for AT MOST ONE secondary, optional gesture folded into the same reply — never both, and never let a gesture replace actually responding. Options, in case either fits:
${callOfferEligible ? (input.isThinProfileFirstMessage ? `  - This is the first real thing they've shared and nothing is known about them yet — this is a good moment for a quick, low-pressure call, a real conversation gets Co further than texting back and forth. After responding, offer one. Keep it brief and secondary. Do not place any call, just make the gesture. Only skip it if it would genuinely feel forced or tone-deaf right after this specific reply — being eligible means you should default to offering, not treat it as merely optional.` : `  - What they just shared could genuinely benefit from a real conversation by voice — this is a good moment to offer one. After genuinely responding, offer a call as a warm gesture, not a logistics question — like "I'm here if you'd ever want to hop on a call and actually talk it through," not "are you free today or tomorrow." The offer has to actually name a call or talking by phone somewhere in it — a vague "I'm here if you want to talk" doesn't clearly read as a call offer to them any more than it would to anyone else, so don't rely on that alone. Do not place any call, just make the gesture. Only skip it if it would genuinely feel forced or tone-deaf right after this specific reply — being eligible means you should default to offering, not treat it as merely optional.`) : `  - A call offer is NOT available this turn (one is already pending, or was offered too recently) — do not mention, suggest, or ask about a phone call in your reply at all, in any wording, even indirectly. Just respond genuinely to what they said.`}
${input.missingTopic ? `  - Co doesn't yet have a good sense of ${input.missingTopicDescription}. If it fits naturally after responding, you can work in one brief, genuine question toward that — never force it, skip it if nothing natural comes up. If you use it, call markTopicAsked with topic "${input.missingTopic}" after sendReply.` : ""}
- Call sendReply once with your reply.${input.isVoice ? "" : " Only call it a second time if you genuinely have a second, separate thought that reads more naturally as its own text sent right after — never to split one continuous thought into shorter pieces."} Then call markTopicAsked only if you actually used that gesture in the message you sent.`;

  const userText = input.imageForVision ? "Respond to what they just sent." : "Respond to what they just said.";

  await generateText({
    // Sonnet, not Haiku — dry-run testing showed Haiku missing the
    // offerCall follow-up call ~2/5 times even when the reply text clearly
    // gestured toward a call, which breaks call_offer_pending tracking (a
    // later "yes" gets misread as unrelated). This is a correctness/
    // state-consistency issue, not just phrasing quality, so it justifies
    // the latency/cost tradeoff.
    model: anthropic("claude-sonnet-4-6"),
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
