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
import pool from "../db/db.js";
import { memberKnowledge, type MemberKnowledge, type KnowledgeSection, type KnowledgeDeps } from "./memberKnowledge.js";
import { notToTeammate } from "./teamLines.js";

type Q = { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> };

// The sections matching needs: goals (their direction), asks, preferences, learned (lessons, corrections, and their limits and rules: the
// one read of limits, so it is not read twice), transitions (what they are in the middle of), people (their own words about people they
// know) and exchanges (what they said lately, for the denylist).
export const MATCH_SECTIONS: readonly KnowledgeSection[] = ["goals", "asks", "preferences", "learned", "transitions", "people", "exchanges"];
// The denylist looks further back than a conversation window does: an old private remark is still not for the other member's ears.
export const MATCH_EXCHANGES = { exchanges: 100, exchangeDays: 120 } as const;

export type MatchPicture = {
  // Their active goals as written, current direction only (done/set-aside goals are history).
  goals: string[];
  // Every word of theirs a line the OTHER member reads must not quote, until they agree to share it (the consented asks are separate).
  privateTexts: string[];
  // The picture could not be read whole (the guards, learned or people were unread): sections are missing, so the value gate treats this as a failed read.
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

// What the picture's windowed exchanges do not hold, for the DENYLIST only (never a prompt, never a line): what they said on calls (the
// "[Call]" summary lines are text_exchange rows labelled from Cue, so the exchanges section drops them; the call transcript, which is
// where the first-hour intake lives, whole: both sides, because when the member was vague Cue's own line often names the private detail),
// and their own check-in, outcome, correction and recap rows. No day window. Never capped: call transcripts, call summaries, outcome and
// correction rows. Call-attempt markers ("Co initiated call...") are left out in SQL. Only the high-volume types (check_in, recap) are capped
// (CHATTY_CAP), and when they are, the newest go first, not the oldest. Read through the forget guards (whatCoKnows.guardRows): what they
// had Cue forget is out, and the rows' own words are checked, not summarised.
export const OWN_ROW_TYPES = ["call_transcript", "event_checkin_outcome", "recommendation_outcome", "call_correction"] as const;
export const CHATTY_TYPES = ["check_in", "recap"] as const;
export const CHATTY_CAP = 300;
export async function ownRows(userId: string, q: Q = pool): Promise<string[]> {
  const { rows } = await q.query(
    `(SELECT content, memory_type FROM co_memories
      WHERE user_id = $1 AND content NOT LIKE 'Co initiated call%'
        AND ((memory_type = 'text_exchange' AND content LIKE '[Call]%' AND ${notToTeammate()}) OR memory_type IN (${OWN_ROW_TYPES.map((t) => `'${t}'`).join(", ")})))
     UNION ALL
     (SELECT content, memory_type FROM co_memories
      WHERE user_id = $1 AND content NOT LIKE 'Co initiated call%' AND memory_type IN (${CHATTY_TYPES.map((t) => `'${t}'`).join(", ")})
      ORDER BY created_at ASC LIMIT ${CHATTY_CAP})`,
    [userId],
  );
  const { guardRows } = await import("./whatCoKnows.js");
  const guarded = await guardRows(userId, rows.map((r: any) => ({ content: String(r.content ?? ""), type: String(r.memory_type) })), q);
  return clean(guarded.map((r) => r.content.replace(/^\s*\[Call\]\s*/, "")));
}

// Any failure rejects: a denylist that could not be read is not an empty one (the value gate fails closed on it).
export async function matchPicture(userId: string, deps: Partial<KnowledgeDeps> = {}, q: Q = pool): Promise<MatchPicture> {
  const [k, own] = await Promise.all([memberKnowledge(userId, { include: MATCH_SECTIONS, ...MATCH_EXCHANGES }, deps), ownRows(userId, q)]);
  const p = matchPictureOf(k);
  return { ...p, privateTexts: clean([...p.privateTexts, ...own]) };
}
