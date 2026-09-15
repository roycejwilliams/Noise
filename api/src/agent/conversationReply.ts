import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { createConversationTools, type SendCoReply } from "./conversationTools.js";
import { writeMemory } from "../services/memory.js";
import pool from "../db/db.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";
import { groundReply, LAYER3_MODELS, renderReplyFacts, type GroundingResult, type ReplyFacts } from "../harness/replyGrounding.js";
import { capitalizeSentences, textsInLowercase, userLinesFrom } from "../services/textStyle.js";

// Co's most recent message in the thread, so a short reply can be read
// against the question it's answering. In the full prompt that question sits
// far above "They just said" and was getting lost (confirmed live,
// 2026-09-10: "Before the event and at check-in", an answer to Co's own
// question, got "Go ahead.").
function lastCoLineBeforeLatestUser(recentConversation: string): string | null {
  const lines = recentConversation.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("Co replied: ")) continue;
    const parts = [lines[i].slice("Co replied: ".length)];
    for (let j = i + 1; j < lines.length && !/^(User said|User sent|Co replied|\[)/.test(lines[j]); j++) parts.push(lines[j]);
    const text = parts.join(" ").trim();
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }
  return null;
}

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
  // Layer 3 harness (harness/replyGrounding.ts): everything that's actually
  // true this turn (what Co did, what's pending, scheduled calls, real event
  // fields and known gaps) plus this turn's instructions (clarify, repeat,
  // call failure, how to answer an outcome, ...). Replaces the ~15 separate
  // context strings this used to take.
  facts: ReplyFacts;
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

// How long an unanswered call offer stays "open" before Co treats it as
// abandoned. Referenced by sendblue.ts's pending-offer lookup — same
// reasoning as eventSurfacingSweep.ts's EVENT_OFFER_EXPIRY_DAYS. Gap closed
// 2026-09-04 (Royce): previously there was no expiry at all, so a call offer
// from 2026-08-27 was still "pending" over a week later and got matched
// against an unrelated "For sure" reply on 2026-09-04, triggering an
// unwanted real outbound call.
export const CALL_OFFER_EXPIRY_DAYS = 7;

// Re-checks the actual sent text for whether it's a call offer, rather than
// trusting the model to have self-declared it via a tool call. Restored
// after a real conversation showed the model calling offerCall right after a
// reply that never mentioned a call at all — a false positive that set
// call_offer_pending and, combined with a pre-existing classifier gap, led
// to two unwanted real outbound calls. Same question and gating the deleted
// offerCall tool / original callOfferCheck used.
async function verifyAndRecordCallOffer(
  input: Pick<ConversationReplyInput, "userId" | "resolvedContent" | "hasPendingOffer" | "recentOfferBurstActive" | "callAction">,
  replyText: string,
  dryRun: boolean,
): Promise<boolean> {
  if (input.hasPendingOffer || input.recentOfferBurstActive || !replyText) return false;
  // "asks_about_calling" replies restate Co's own standing number so the
  // USER can call CO — they never mean Co is proposing to call THEM, so this
  // must never register as a pending call offer. Root cause of a real
  // 2026-09-07 incident: this got tagged pending anyway, sat unresolved for
  // 14+ hours, and an unrelated later "sure" (accepting a recommendation)
  // got misread as accepting it, placing a real unwanted outbound call.
  if (input.callAction === "asks_about_calling") return false;
  try {
    const { text: rawCheck } = await generateText({
      model: anthropic(LAYER3_MODELS.narrow),
      experimental_telemetry: { isEnabled: true, functionId: "agent.conversationReply.callOfferCheck" },
      prompt: `Does this text message actually offer that CO will call THEM — Co proposing to place an outbound call to the person, not just telling them how they can call Co themselves — in any wording, even indirectly (e.g. "I'm here if you want to talk this through")? Not just related to talking or listening in general — specifically Co offering to call them.

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
      model: anthropic(LAYER3_MODELS.narrow),
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
  opts: { dryRun?: boolean; record?: boolean } = {},
): Promise<{ sent: boolean; offered: boolean; replyText: string; grounding: GroundingResult[] }> {
  const grounding: GroundingResult[] = [];
  const { tools, state } = createConversationTools({
    userId: input.userId,
    phoneNumber: input.phoneNumber,
    resolvedContent: input.resolvedContent,
    isVoice: input.isVoice,
    hasPendingOffer: input.hasPendingOffer,
    recentOfferBurstActive: input.recentOfferBurstActive,
    dryRun: opts.dryRun ?? false,
    sendCoReply: input.sendCoReply,
    gate: async (draft, sentThisTurn) => {
      const result = await groundReply(
        draft,
        input.facts,
        {
          message: input.resolvedContent,
          recentConversation: input.recentConversation,
          contextSummary: input.contextSummary,
          recentMemories: input.recentMemories,
          sentThisTurn,
        },
        { userId: input.userId, record: opts.record !== false && !opts.dryRun },
      );
      grounding.push(result);
      return textsInLowercase(userLinesFrom(input.recentConversation, input.resolvedContent))
        ? result.final
        : capitalizeSentences(result.final);
    },
  });

  const callOfferEligible =
    !input.hasPendingOffer &&
    !input.recentOfferBurstActive &&
    (input.callAction === "would_benefit" || input.isThinProfileFirstMessage);

  const lastCoMessage = lastCoLineBeforeLatestUser(input.recentConversation);

  const system = `${CO_VOICE}
${input.personaPrompt ? `
Below is the guide you use on live phone calls. Over text, keep its listening principles, but not its call structure, phases, or pacing. If anything in it describes who you are differently from the above, the above wins.

${input.personaPrompt}
` : ""}
You are replying by iMessage to ${input.firstName}, picking up wherever this conversation actually is. ${CO_TEXT_CHANNEL}

${input.firstName} is texting you — you already have their number, never ask them for it.

What you already know about ${input.firstName} from before. Use it to understand them and to get details right. Only bring something up from here when it's directly relevant to what they just said, and don't repeat a detail you've already mentioned in this conversation:
${input.contextSummary || "(nothing on file yet — this is effectively a first real conversation with them)"}

${renderReplyFacts(input.facts)}

${input.toneContext}
${input.seekingModeContext}
${input.styleHint}
${input.isFirstContact ? `\nThis is the very start of your first real conversation with ${input.firstName} — they just finished the intro sequence (greeting, what Co is, saving your contact, verification). What they just said may be nothing more than a greeting, not real content to react to.${input.contextSummary ? ` You already have real context on them (see "What you already know" above, from onboarding or a prior touchpoint) — lead with it. Your first line should pick up from something specific and real in it, the same way you would open a call, not a generic greeting that ignores what you already have.` : ""} If it IS something real, pick up from it genuinely. If it's just a greeting or blank, don't react to it as if it were substantive — instead open the real conversation yourself${input.contextSummary ? ", grounded in what you already know about them" : ""}, warm, unhurried, inviting the real version of their life, not a status update.\n` : ""}
Recent conversation, in order (this is the actual thread — follow it; don't jump to older topics from "other context" below unless they bring it up again):
${input.recentConversation || "(this is the start of the conversation)"}

What Co knows from past conversations that's genuinely relevant to what they just said — already checked for relevance before being handed to you, so treat it with the same weight as this thread, not as optional trivia:
${input.recentMemories || "(nothing from past conversations applies to what they just said)"}

${lastCoMessage ? `Your last message to them was: "${lastCoMessage}"\n` : ""}${input.imageForVision ? "They just sent the attached photo." : `They just said: "${input.resolvedContent}"`}${lastCoMessage ? `\nIf what they just said is a short answer, read it as an answer to your last message first.` : ""}

Ground everything ONLY in "What's true right now" above, the information above, and what has actually been said in this conversation — never state or imply a specific personal detail, preference, or fact about them that isn't listed above or wasn't actually said in this thread. This includes real venues and businesses: never name a specific one unless it's given to you above as something you actually found — if you don't have a real one, describe what you'd look for, don't guess a plausible-sounding name.

This same discipline applies to your OWN past actions, not just facts about them — if they ask what you sent, said, or meant by something earlier, look at what you actually sent in "Recent conversation" above and answer from that, accurately. Never invent an excuse for something you supposedly did wrong (a "broken link," an "accidental" send, etc.) unless the conversation above actually shows that happening — a real link or message you can see in that thread was real and intentional, not a mistake. If you genuinely can't tell what they're referring to from what's above, say so plainly and ask, rather than fabricating a plausible-sounding explanation.

The same goes for the future: never promise to do something later ("I'll send the link once I have it", "I'll be in touch", "I'll track that down") unless the context above tells you it's actually going to happen. Nothing follows up on a promise you make on your own. If you don't have something, say so plainly and say what you can do right now. Don't bring back a promise or a missing item from earlier in the thread unless they ask about it.

Decide what to do, then act using your tools:
- Always respond genuinely to what they said first. Match the weight of your reply to theirs: a short or simple message earns a short, simple reply — often just a sentence. Something long, layered, or emotionally loaded earns real room to actually respond to it, not a one-liner that brushes past what they just shared — but "real room" still means a hard cap of 2 short paragraphs, never 3+. This is still a text message, not an essay. That cap is total, not per-thing — it applies no matter how many items are listed under "For this reply" (a recommendation, an event update, venue results, an answer about calling, anything else you're also working in this turn); if several are active, pick the single most important one to actually develop and reduce the rest to a fragment or drop them for a later turn, never give each one its own full-length treatment in the same reply. If you're also folding in the secondary gesture below this turn, that's the moment to lean SHORTER on the emotional response, not longer — 1-2 sentences acknowledging what they shared, then the gesture, never both at full length in the same reply. Even when matching a short exchange's brevity, don't let it go purely reactive — if the conversation is genuinely stalling, keep giving it somewhere to go: a question, an observation, a related thought. Never rely on a question mark as the only tool for that, and never force it onto an exchange that's naturally winding down or already has real momentum. Separately — when they state something concrete about what they want or who they're looking for, that's worth deepening with a specific follow-up question even if the conversation already has momentum; just validating it back leaves it vague when one more question would actually sharpen it. Vary how each reply opens — don't default to restating what they said as "That [noun phrase], ..." every time; sometimes just respond directly without that framing. No em dashes. Match their capitalization register, the same way you'd naturally pick up on anyone's texting style — someone who writes in relaxed all-lowercase gets a reply in that same relaxed register, someone who writes in normal capitalized sentences gets that back. Base this ONLY on the "User said:" lines in the conversation above — never on your own past "Co replied:" lines, even ones that show up lowercase or inconsistent; a past reply of yours in the wrong register is a mistake to correct, not a style to keep matching. Don't let a shift into deeper conversation, or a run of your own prior replies, pull you into a different capitalization style than the one they're actually using right now. If their own recent texting is genuinely mixed or unclear, default to normal capitalized sentences rather than picking up whatever style happens to appear most recently in the thread.${input.imageForVision ? " React to what's actually in the photo." : ""}
- You have room for AT MOST ONE secondary, optional gesture folded into the same reply — never both, and never let a gesture replace actually responding. Options, in case either fits:
${callOfferEligible ? (input.isThinProfileFirstMessage ? `  - This is the first real thing they've shared and nothing is known about them yet — this is a good moment for a quick, low-pressure call, a real conversation gets Co further than texting back and forth. After responding, offer one. Keep it brief and secondary. Do not place any call, just make the gesture. Only skip it if it would genuinely feel forced or tone-deaf right after this specific reply — being eligible means you should default to offering, not treat it as merely optional.` : `  - What they just shared could genuinely benefit from a real conversation by voice — this is a good moment to offer one. After genuinely responding — briefly, even if what they shared was heavy; this is exactly the case where the response stays short so there's real room left for the offer itself — offer a call as a warm gesture, not a logistics question — like "I'm here if you'd ever want to hop on a call and actually talk it through," not "are you free today or tomorrow." The offer has to actually name a call or talking by phone somewhere in it — a vague "I'm here if you want to talk" doesn't clearly read as a call offer to them any more than it would to anyone else, so don't rely on that alone. Do not place any call, just make the gesture. Only skip it if it would genuinely feel forced or tone-deaf right after this specific reply — being eligible means you should default to offering, not treat it as merely optional.`) : `  - A call offer is NOT available this turn (one is already pending, or was offered too recently) — do not mention, suggest, or ask about a phone call in your reply at all, in any wording, even indirectly. Just respond genuinely to what they said.`}
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
    model: anthropic(LAYER3_MODELS.reply),
    system,
    tools,
    // 6, not 5 — a genuine second sendReply call now needs an extra
    // call/result round trip the single-reply design didn't. (Briefly
    // raised to 12 for a multi-message recommendation sequence the agent
    // used to own — that sending is now deterministic in sendblue.ts
    // instead, so this reverted back to 6.)
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

  return { sent: state.sent, offered, replyText: state.lastReplyText, grounding };
}
