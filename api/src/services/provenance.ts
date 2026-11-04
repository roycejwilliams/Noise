// What a member did or will do is theirs to say (Royce, 2026-10-12, item 2): "Royce is going" was recorded from word overlap ("what
// can we bring to the launch party" matched "Chargebotic Launch + Pitch Night"), became a "went" milestone, and a check-in asked how
// it was. Attendance, participation and anything else about what a member did or will do needs their own explicit statement: an
// RSVP, an "I'm going", a yes. Each such row carries its provenance: "stated" with their words, or "inferred". An inferred row (and
// any row written before provenance existed) is unconfirmed: it may only drive a question ("Did you end up going to X?"), never a
// statement, a milestone, or a "how was X?".
export type Provenance = "stated" | "inferred";

// Outcomes that say what the member did: went, signed up, applied, or went and it helped or didn't (services/outcomes.ts).
export const DID_RESULTS = ["acted", "helped", "didnt_help"] as const;
export const isDidResult = (result: string): boolean => (DID_RESULTS as readonly string[]).includes(result);

// Pure: only an explicit "stated" counts. Unknown (NULL, a row from before provenance) reads as inferred.
export const isStated = (provenance: unknown): boolean => provenance === "stated";

import { isReactionGuard } from "./reactionsIn.js";
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Pure: the quote is copied from their own message (a short "yes" counts: a yes to Co's offer is a confirmation).
export function quoteIsTheirs(quote: unknown, theirText: string, userId?: string | null): boolean {
  // A tapback's text quotes Cue's own words ("Liked “…”"), never theirs (services/reactionsIn.ts).
  if (isReactionGuard(theirText, userId)) return false;
  const q = norm(quote);
  return q.length >= 2 && ` ${norm(theirText)} `.includes(` ${q} `);
}

// The one rule every reader hands Co with an unconfirmed item.
export const UNCONFIRMED_RULE = "not confirmed by them: you may only ask whether they went or are going, never say or assume it, and never ask how it was";
