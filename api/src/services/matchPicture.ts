// What matching reads of a member (Cue Memory Spec step 11, part 1, 2026-11-06): the guarded member picture, never raw co_memories rows.
// Matching is where two members' contexts meet, so the raw rows (which bypass the removal and forget guards and the name strip) are
// gone from these paths. Everything here comes through services/memberKnowledge.ts, section by section.
//
// Royce's rulings, which are the contract of this file:
//   - Private knowledge is never permission to share in an intro. What this returns feeds two things only: the member's OWN scoring
//     context (their active goals) and the denylist that checks intro text (privateTexts: words that must not show up in a line the
//     other member reads). It is never an input to any text a second member reads, and a private section never becomes intro wording.
//   - Each side's private knowledge stays private: one call per member, bound to that member's id; nothing of the other side is read.
//   - Forgotten or removed content cannot inform a match: it is already out of the picture.
//   - Silence is not rejection and quiet members rank lower, never out: nothing here reads activity (matchGate.quietAmong still does).
// Read only; no model call.
import { memberKnowledge, type MemberKnowledge, type KnowledgeSection, type KnowledgeDeps } from "./memberKnowledge.js";

// The sections matching needs: goals (their direction), asks, preferences, limits, learned (lessons, corrections), transitions (what
// they are in the middle of), people (their own words about people they know) and exchanges (what they said lately, for the denylist).
export const MATCH_SECTIONS: readonly KnowledgeSection[] = ["goals", "asks", "preferences", "limits", "learned", "transitions", "people", "exchanges"];
// The denylist looks further back than a conversation window does: an old private remark is still not for the other member's ears.
export const MATCH_EXCHANGES = { exchanges: 100, exchangeDays: 120 } as const;

export type MatchPicture = {
  // Their active goals as written, current direction only (done/set-aside goals are history).
  goals: string[];
  // Every word of theirs a line the OTHER member reads must not quote, until they agree to share it (the consented asks are separate).
  privateTexts: string[];
  // The picture could not be read whole (the guards were unread): privateTexts holds more, never less, and goals holds none from history.
  unread: boolean;
};

const clean = (xs: (string | null | undefined)[]) => [...new Set(xs.map((x) => String(x ?? "").trim()).filter(Boolean))];

// Pure: a picture into what matching uses. Their own lines only (Cue's words are not their private matter), no raw rows.
export function matchPictureOf(k: MemberKnowledge): MatchPicture {
  const goals = k.goals.filter((g) => g.state === "active" && g.onFile).map((g) => g.text);
  const privateTexts = clean([
    ...k.goals.map((g) => g.text),
    ...k.asks.map((a) => a.text),
    ...k.preferences.map((p) => p.text),
    ...(k.limits?.avoid ?? []),
    ...(k.learnedLessons ?? []).map((l) => l.text),
    ...(k.learnedCorrections ?? []).flatMap((c) => [c.now, c.was, c.theirWords]),
    ...(k.learnedLimits?.avoid ?? []).map((a) => a.text),
    ...(k.learnedLimits?.rules ?? []).map((r) => r.text),
    ...(k.transitions ?? []).flatMap((t) => [t.text, t.quote]),
    ...(k.people ?? []).flatMap((p) => [p.quote, p.outcome?.quote]),
    ...k.exchanges.filter((e) => e.from === "member").map((e) => e.text),
  ]);
  return { goals, privateTexts, unread: !!k.guardsUnread || !!k.learnedUnread || !!k.peopleUnread };
}

export async function matchPicture(userId: string, deps: Partial<KnowledgeDeps> = {}): Promise<MatchPicture> {
  return matchPictureOf(await memberKnowledge(userId, { include: MATCH_SECTIONS, ...MATCH_EXCHANGES }, deps));
}
