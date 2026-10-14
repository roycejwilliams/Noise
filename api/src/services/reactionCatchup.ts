// A reaction Co didn't record (2026-09-28). Co records how something it sent
// landed with its noteReaction tool, but now and then it replies warmly and
// skips the tool ("going to the rooftop evening thursday" → "Have fun up
// there", nothing recorded; about 1 in 18 in the capability probe). After the
// reply, off the reply's path: when Co didn't record a reaction, a quick read
// of what Co sent lately decides whether they explicitly said how one landed,
// with their words, and records only that, the same way the tool does
// (2026-10-12: never from word overlap; services/provenance.ts).
import { anthropic } from "@ai-sdk/anthropic";
import { loadSentItems, type SentItem } from "./turnContext.js";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { recordSuggestionOutcome } from "./outcomes.js";
import { quoteIsTheirs } from "./provenance.js";

export type Reaction = "interested" | "going" | "went_liked" | "went_disliked" | "not_for_me";
// How each reaction is stored (shared with conversationTools.ts noteReaction).
export const REACTION_RESULT = { interested: "interested", going: "acted", went_liked: "helped", went_disliked: "didnt_help", not_for_me: "declined" } as const;

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "your", "event", "night", "thing", "about", "into", "going"]);

// Everything Co sent them that a reaction can be about, from the one list
// the whole turn reads (services/turnContext.ts loadSentItems): search results
// and offers Co sent first, under the key the router's reaction path uses, so
// a reaction lands on the same item however it's caught (2026-09-28: Co's
// tool couldn't find the daytonaio offer Co had sent first).
export type { SentItem } from "./turnContext.js";

export async function sentItems(userId: string): Promise<SentItem[]> {
  return loadSentItems(userId);
}

// Pure: which sent things their message names, by a whole distinctive word.
export function sentNamedIn<T extends { name: string }>(message: string, sent: T[]): T[] {
  const words = new Set(norm(message).split(" ").filter((w) => w.length >= 4 && !STOP.has(w)));
  if (!words.size) return [];
  return sent.filter((s) => norm(s.name).split(" ").some((w) => words.has(w)));
}

// The model's read (2026-10-12, item 2): which send they're reacting to, how, and whether they SAID it, with their words. Matching a
// reply to an offer is this judgment, never word overlap: "what can we bring to the launch party" shares "launch" with "Chargebotic
// Launch + Pitch Night" and says nothing about going to it. Only an explicit statement (an RSVP, "I'm going", "signed up", "went",
// a yes to Co's offer of it) is a reaction; the quote must be copied from their message (services/provenance.ts quoteIsTheirs).
export type ReactionRead<T> = { match: T; reaction: Reaction; quote: string };
export async function readReaction<T extends { name: string }>(message: string, named: T[], repliedToCo: string | null = null): Promise<ReactionRead<T> | null> {
  let read: { item?: number | null; reaction?: string; explicit?: boolean; quote?: string | null } = {};
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      experimental_telemetry: { isEnabled: true, functionId: "reactionCatchup" },
      prompt: `A member texted: "${message.slice(0, 400)}"${repliedToCo ? `\n(They sent it as a reply to this text from Cue: "${repliedToCo.slice(0, 400)}")` : ""}

Things Cue sent them earlier:
${named.map((n, i) => `${i}. ${n.name}`).join("\n")}

Are they EXPLICITLY telling Cue how one of these landed? "interested" (they say they want to go or look into it), "going" (they say they're going, RSVPed or signed up), "went_liked" (they say they went and liked it), "went_disliked" (they say they went and didn't), "not_for_me" (they say they're passing on it).
Only their own explicit words count: an RSVP, "I'm going", "signed up", "I went", "not for me", or a plain yes to Cue offering that exact thing. Everything else is "none": a question about it or about any event (what to bring, where, when, how to get there), an event of their own that only shares a word with one of these, a plan that doesn't name it, or anything you would have to infer. When unsure, "none".

Return ONLY JSON: {"item": <number or null>, "reaction": "interested" | "going" | "went_liked" | "went_disliked" | "not_for_me" | "none", "explicit": true | false, "quote": "their exact words that say it, copied from their message" or null}`,
    });
    read = parseModelJson(text);
  } catch {
    return null;
  }
  return reactionFromRead(read, named, message);
}

// Pure: the code's half of the read. A reaction stands only when the model called it explicit and its quote is in their message.
export function reactionFromRead<T>(read: { item?: number | null; reaction?: string; explicit?: boolean; quote?: string | null }, named: T[], message: string): ReactionRead<T> | null {
  const match = typeof read.item === "number" ? named[read.item] : undefined;
  if (!match || !read.reaction || !(read.reaction in REACTION_RESULT)) return null;
  if (read.explicit !== true || !quoteIsTheirs(read.quote, message)) return null;
  return { match, reaction: read.reaction as Reaction, quote: String(read.quote).trim().slice(0, 200) };
}

// The most this read is shown: what Co sent lately, the ones their message names first (an ordering, never the decision).
export const CATCHUP_MAX_ITEMS = 8;
export function catchupCandidates<T extends { name: string }>(text: string, sent: T[]): T[] {
  const named = sentNamedIn(text, sent);
  return [...named, ...sent.filter((s) => !named.includes(s))].slice(0, CATCHUP_MAX_ITEMS);
}

// sent: the turn's list when the caller has it (services/turnContext.ts).
export async function catchUpReaction(userId: string, message: string, toolsCalled: string[], repliedToCo: string | null = null, sentList?: SentItem[]): Promise<void> {
  if (!message.trim() || toolsCalled.includes("noteReaction")) return;
  const sent = sentList ?? (await sentItems(userId));
  // A reply threaded under one of Co's texts names what that text named.
  const named = catchupCandidates(repliedToCo ? `${message} ${repliedToCo}` : message, sent);
  if (!named.length) return;
  const read = await readReaction(message, named, repliedToCo);
  const { recordDecision } = await import("../harness/core.js");
  if (!read) {
    await recordDecision({ layer: 6, decision: "reaction.catchup", userId, outcome: "skip", action: "not_explicit", proposal: { message: message.slice(0, 200), candidates: named.length } }).catch(() => {});
    return;
  }
  const { match, reaction, quote } = read;
  await recordSuggestionOutcome(userId, match.kind, match.key, match.name, REACTION_RESULT[reaction], message.slice(0, 160), { provenance: "stated", quote });
  // The same settling noteReaction does (services/offerReactions.ts settleSentOffer).
  await import("./offerReactions.js").then((O) => O.settleSentOffer(userId, match.name, reaction, message.slice(0, 160))).catch(() => {});
  await recordDecision({ layer: 6, decision: "reaction.catchup", userId, outcome: "act", action: reaction, proposal: { item: match.name, message: message.slice(0, 200), quote } }).catch(() => {});
  const { recordFact } = await import("./coFacts.js");
  await recordFact({ ownerUserId: userId, subject: "co", relation: "did", label: `noted how "${match.name}" landed: ${reaction} (their words: "${quote.slice(0, 120)}")`, visibility: "owner", source: "reaction.catchup", meta: { provenance: "stated", quote } });
}
