// Reactions to offers Co sent directly (Royce, 2026-09-18: "Replies to
// revealed offers needs to be done"). Every event or opening Co sends now
// goes out with its details, and a reveal was marked resolved the moment it
// went out, so "ooh I'll apply" or "not for me" was never recorded, and the
// repeat rule (harness/matchGate.ts repeatRule) had no outcome to go on.
//
// Each sent result is recorded here. For REACTION_WINDOW_HOURS it's waiting
// on a reaction: the message router (services/messageRouter.ts, kind
// "offer_reaction") decides whether their next text reacts to it, and the
// reaction is saved as a suggestion outcome (services/outcomes.ts) that the
// repeat rule reads: interested, declined, or already acted.
import pool from "../db/db.js";
import { recordSuggestionOutcome } from "./outcomes.js";
import type { TierMatch } from "./tieredRecommendation.js";

export const REACTION_WINDOW_HOURS = 48;
const MAX_WAITING = 3;

export type OfferReaction = "interested" | "not_interested" | "already_did_it";
export type PendingOfferReaction = { id: number; itemKey: string; itemName: string; kind: "event" | "opportunity"; url: string | null; sentAt: Date };

// The same keys the repeat rule looks outcomes up by.
export function offerItemKey(match: Pick<TierMatch, "name"> & { event_api_id?: string }): string {
  return match.event_api_id ? `event:${match.event_api_id}` : `name:${match.name.toLowerCase()}`;
}

export async function recordRevealedOffers(userId: string, matches: TierMatch[]): Promise<void> {
  for (const m of matches) {
    const key = offerItemKey(m as any);
    await pool
      .query(
        `INSERT INTO revealed_offers (user_id, item_key, item_name, kind, url)
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (SELECT 1 FROM revealed_offers WHERE user_id = $1 AND item_key = $2 AND sent_at > NOW() - INTERVAL '10 minutes')`,
        [userId, key, m.name, m.kind === "opportunity" ? "opportunity" : "event", "url" in m ? (m.url ?? null) : null],
      )
      .catch((err: any) => console.error("recordRevealedOffers failed (non-fatal):", err?.message ?? err));
  }
}

// Sent in the last REACTION_WINDOW_HOURS with no reaction yet, newest first.
export async function findPendingOfferReactions(userId: string): Promise<PendingOfferReaction[]> {
  const { rows } = await pool.query(
    `SELECT id, item_key, item_name, kind, url, sent_at FROM revealed_offers
     WHERE user_id = $1 AND reaction IS NULL AND sent_at > NOW() - ($2 || ' hours')::interval
     ORDER BY sent_at DESC LIMIT $3`,
    [userId, REACTION_WINDOW_HOURS, MAX_WAITING],
  );
  return rows.map((r: any) => ({ id: Number(r.id), itemKey: r.item_key, itemName: r.item_name, kind: r.kind, url: r.url, sentAt: new Date(r.sent_at) }));
}

export function outcomeForReaction(reaction: OfferReaction): "interested" | "declined" | "acted" {
  return reaction === "interested" ? "interested" : reaction === "not_interested" ? "declined" : "acted";
}

export async function recordOfferReaction(userId: string, pending: PendingOfferReaction, reaction: OfferReaction, message: string): Promise<void> {
  await pool.query(`UPDATE revealed_offers SET reaction = $2, reacted_at = NOW() WHERE id = $1`, [pending.id, reaction]);
  // The router records "already did it" only on an unambiguous read of their own words (services/messageRouter.ts).
  await recordSuggestionOutcome(userId, pending.kind, pending.itemKey, pending.itemName, outcomeForReaction(reaction), message.slice(0, 160), { provenance: "stated", quote: message.slice(0, 200) });
  // Their answer settles the offer's loop too (services/openLoops.ts settleOfferLoop, 2026-10-11).
  await import("./openLoops.js").then((L) => L.settleOfferLoop(userId, pending.itemName, reaction, message.slice(0, 160))).catch((err: any) => console.error("offerReactions: settling the offer loop failed (non-fatal):", err?.message ?? err));
}

// A reaction Co recorded with its own tool (noteReaction) or the catch-up read (reactionCatchup.ts), in the noteReaction words:
// the same two places the router's path writes, so a sent find answered any way is answered everywhere (2026-10-11, loop 53372:
// noteReaction wrote the outcome, and neither revealed_offers nor the loop heard about it, so the router still waited on it).
export const REVEAL_REACTION: Record<string, OfferReaction> = { interested: "interested", going: "already_did_it", went_liked: "already_did_it", went_disliked: "already_did_it", not_for_me: "not_interested" };
export async function settleSentOffer(userId: string, name: string, reaction: string, note: string | null): Promise<void> {
  const r = REVEAL_REACTION[reaction];
  if (r) await pool.query(`UPDATE revealed_offers SET reaction = $3, reacted_at = NOW() WHERE user_id = $1 AND lower(item_name) = lower($2) AND reaction IS NULL`, [userId, name, r]).catch((err: any) => console.error("offerReactions: marking the reveal answered failed (non-fatal):", err?.message ?? err));
  await import("./openLoops.js").then((L) => L.settleOfferLoop(userId, name, reaction, note)).catch((err: any) => console.error("offerReactions: settling the offer loop failed (non-fatal):", err?.message ?? err));
}

// What the reply should know, in plain words.
export function reactionFact(pending: PendingOfferReaction, reaction: OfferReaction): string {
  if (reaction === "interested") return `They just showed interest in "${pending.itemName}", which you sent them. Respond to that naturally; don't resend it.`;
  if (reaction === "not_interested") return `They just passed on "${pending.itemName}", which you sent them. Acknowledge lightly, no pressure, and don't push it again.`;
  return `They just said they already ${pending.kind === "opportunity" ? "applied or acted on" : "signed up for or went to"} "${pending.itemName}", which you sent them. Respond to that naturally.`;
}
