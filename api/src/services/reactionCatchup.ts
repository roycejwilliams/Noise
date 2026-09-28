// A reaction Co didn't record (2026-09-28). Co records how something it sent
// landed with its noteReaction tool, but now and then it replies warmly and
// skips the tool ("going to the rooftop evening thursday" → "Have fun up
// there", nothing recorded; about 1 in 18 in the capability probe). After the
// reply, off the reply's path: if their message names something Co sent them
// and Co didn't record a reaction, a quick read decides whether they were
// reacting to it, and records it the same way the tool does.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { recordSuggestionOutcome } from "./outcomes.js";

export type Reaction = "interested" | "going" | "went_liked" | "went_disliked" | "not_for_me";
// How each reaction is stored (shared with conversationTools.ts noteReaction).
export const REACTION_RESULT = { interested: "interested", going: "acted", went_liked: "helped", went_disliked: "didnt_help", not_for_me: "declined" } as const;

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "your", "event", "night", "thing", "about", "into", "going"]);

// Everything Co sent them in the last 45 days that a reaction can be about:
// what their own searches turned up (recommendation_offered) and what Co
// offered first (revealed_offers), each under the key its own path records
// outcomes with, so a reaction lands on the same item however it's caught
// (2026-09-28: Co's tool couldn't find the daytonaio offer Co had sent first).
export type SentItem = { name: string; key: string; kind: "event" | "opportunity" };

export async function sentItems(userId: string): Promise<SentItem[]> {
  const [recs, offers] = await Promise.all([
    pool
      .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'recommendation_offered' AND created_at > NOW() - INTERVAL '45 days' ORDER BY created_at DESC LIMIT 60`, [userId])
      .then((r) => r.rows)
      .catch(() => [] as any[]),
    pool
      .query(`SELECT item_key, item_name, kind FROM revealed_offers WHERE user_id = $1 AND sent_at > NOW() - INTERVAL '45 days' ORDER BY sent_at DESC LIMIT 60`, [userId])
      .then((r) => r.rows)
      .catch(() => [] as any[]),
  ]);
  const out: SentItem[] = [];
  const seen = new Set<string>();
  for (const r of recs) {
    let x: any = null;
    try {
      x = JSON.parse(r.content);
    } catch {}
    if (!x?.name) continue;
    const item: SentItem = { name: x.name, key: x.event_api_id ? `event:${x.event_api_id}` : `opportunity:${norm(x.name)}`, kind: x.event_api_id ? "event" : "opportunity" };
    if (!seen.has(norm(item.name))) (seen.add(norm(item.name)), out.push(item));
  }
  for (const r of offers) {
    if (!r.item_name || seen.has(norm(r.item_name))) continue;
    seen.add(norm(r.item_name));
    out.push({ name: r.item_name, key: r.item_key, kind: r.kind === "event" ? "event" : "opportunity" });
  }
  return out;
}

// Pure: which sent things their message names, by a whole distinctive word.
export function sentNamedIn<T extends { name: string }>(message: string, sent: T[]): T[] {
  const words = new Set(norm(message).split(" ").filter((w) => w.length >= 4 && !STOP.has(w)));
  if (!words.size) return [];
  return sent.filter((s) => norm(s.name).split(" ").some((w) => words.has(w)));
}

// The model's read: which named send they're reacting to, and how, or null.
export async function readReaction<T extends { name: string }>(message: string, named: T[], repliedToCo: string | null = null): Promise<{ match: T; reaction: Reaction } | null> {
  let read: { item?: number | null; reaction?: string } = {};
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      experimental_telemetry: { isEnabled: true, functionId: "reactionCatchup" },
      prompt: `A member texted: "${message.slice(0, 400)}"${repliedToCo ? `\n(They sent it as a reply to this text from Co: "${repliedToCo.slice(0, 400)}")` : ""}

Things Co sent them earlier:
${named.map((n, i) => `${i}. ${n.name}`).join("\n")}

Are they telling Co how one of these landed? "interested" (want to go or look into it), "going" (they're going or signed up), "went_liked" (they went and liked it), "went_disliked" (they went and didn't), "not_for_me" (they're passing on it). Only when the message clearly says so; a question about it (where, when, how to get there) is "none".

Return ONLY JSON: {"item": <number or null>, "reaction": "interested" | "going" | "went_liked" | "went_disliked" | "not_for_me" | "none"}`,
    });
    read = parseModelJson(text);
  } catch {
    return null;
  }
  const match = typeof read.item === "number" ? named[read.item] : undefined;
  if (!match || !read.reaction || !(read.reaction in REACTION_RESULT)) return null;
  return { match, reaction: read.reaction as Reaction };
}

export async function catchUpReaction(userId: string, message: string, toolsCalled: string[], repliedToCo: string | null = null): Promise<void> {
  if (!message.trim() || toolsCalled.includes("noteReaction")) return;
  const sent = await sentItems(userId);
  // A reply threaded under one of Co's texts names what that text named.
  const named = sentNamedIn(repliedToCo ? `${message} ${repliedToCo}` : message, sent).slice(0, 5);
  if (!named.length) return;
  const read = await readReaction(message, named, repliedToCo);
  if (!read) return;
  const { match, reaction } = read;
  await recordSuggestionOutcome(userId, match.kind, match.key, match.name, REACTION_RESULT[reaction], message.slice(0, 160));
  const { recordDecision } = await import("../harness/core.js");
  await recordDecision({ layer: 6, decision: "reaction.catchup", userId, outcome: "act", action: reaction, proposal: { item: match.name, message: message.slice(0, 200) } }).catch(() => {});
  const { recordFact } = await import("./coFacts.js");
  await recordFact({ ownerUserId: userId, subject: "co", relation: "did", label: `noted how "${match.name}" landed: ${reaction}`, visibility: "owner", source: "reaction.catchup" });
}
