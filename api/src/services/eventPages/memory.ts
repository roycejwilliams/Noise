// Every event-page action as signal for Co's memory (Royce, spec 8: "who RSVP'd, who commented, what they asked ... store it in
// the same place the rest of member memory lives").
//
// Where: co_facts (services/coFacts.ts), as a MEMBER fact (subject 'member') owned by the member who acted, visibility 'owner'.
// Why there and not co_memories:
//   - co_facts is the member record with an owner and a visibility on every row. 'owner' means: only ever used in that
//     member's own conversation, never told to anyone else. That's exactly this data.
//   - harness/introConsent.ts already checks every text drafted ABOUT a member against that member's owner-only facts
//     (privateFactLeak / ownerOnlyFacts), so a comment or question written here is automatically guarded from reaching another
//     member's conversation through an intro, with no new code on that path.
//   - co_memories text_exchange rows are the text thread itself: a page comment written there would read as a text they sent
//     (it would reset the unanswered-texts pause, and the reply model would think they texted it).
//   - a fact has retired_at, so a changed RSVP or a retracted reaction retires its old fact instead of contradicting it.
// Readers: services/memberKnowledge.ts reads them as the `pageActivity` section (owner-scoped, user_id = $1 like every section),
// and a text reply shows them as known facts (harness/replyGrounding.ts addMemberKnowledge via pageActivityLines below).
import pool from "../../db/db.js";
import { recordFactChecked, type CoFact } from "../coFacts.js";

export type ActionKind = "rsvp" | "reaction" | "comment" | "question";
export const FACT_RELATION: Record<ActionKind, string> = {
  rsvp: "event_page_rsvp",
  reaction: "event_page_reaction",
  comment: "event_page_comment",
  question: "event_page_question",
};
export const FACT_SOURCE = "event_page";

const RSVP_WORDS: Record<string, string> = { going: "going", maybe: "a maybe", cant: "can't make it" };

// Pure: the fact one action becomes. RSVP and reactions are engagement and taste; comments and questions are their own words,
// kept word for word (already stripped of markup and capped by actions.ts).
export function factFor(a: { userId: string; pageId: string; actionId: string | number; kind: ActionKind; value: string; title: string; at: Date }): CoFact {
  const title = a.title.trim().slice(0, 120) || "an event";
  const label =
    a.kind === "rsvp"
      ? `RSVP'd ${RSVP_WORDS[a.value] ?? a.value} on Co's event page for "${title}"`
      : a.kind === "reaction"
        ? `Reacted ${a.value} to Co's event page for "${title}"`
        : a.kind === "comment"
          ? `Commented on Co's event page for "${title}": "${a.value}"`
          : `Asked Co on the event page for "${title}": "${a.value}"`;
  return {
    ownerUserId: a.userId,
    subject: "member",
    relation: FACT_RELATION[a.kind],
    label,
    url: null,
    visibility: "owner",
    source: FACT_SOURCE,
    happenedAt: a.at,
    meta: { pageId: a.pageId, actionId: String(a.actionId), kind: a.kind, value: a.value, title, signal: a.kind === "rsvp" || a.kind === "reaction" ? "engagement" : "own_words" },
  };
}

export type MemoryDeps = {
  write: (f: CoFact) => Promise<void>;
  // Retires the member's facts for these actions (a changed RSVP, a removed reaction, a withdrawn comment). Owner-scoped.
  retire: (userId: string, actionIds: string[]) => Promise<void>;
};

export const realMemoryDeps: MemoryDeps = {
  write: recordFactChecked,
  retire: async (userId, actionIds) => {
    if (!actionIds.length) return;
    await pool.query(
      `UPDATE co_facts SET retired_at = NOW() WHERE owner_user_id = $1 AND source = $2 AND retired_at IS NULL AND meta->>'actionId' = ANY($3::text[])`,
      [userId, FACT_SOURCE, actionIds],
    );
  },
};

// ---------------------------------------------------------------- the reader (memberKnowledge's pageActivity section)

export type PageActivity = { from: "member"; kind: ActionKind; page: string; text: string };
export type RawPageActivity = { kind: ActionKind; title: string; value: string; at: Date };

// One member's own page activity, newest first. Scoped to the owner: never another member's rows.
export async function loadPageActivity(userId: string): Promise<RawPageActivity[]> {
  const { rows } = await pool.query(
    `SELECT meta->>'kind' AS kind, meta->>'title' AS title, meta->>'value' AS value, happened_at FROM co_facts
     WHERE owner_user_id = $1 AND subject = 'member' AND source = $2 AND retired_at IS NULL AND happened_at > NOW() - INTERVAL '60 days'
     ORDER BY happened_at DESC LIMIT 20`,
    [userId, FACT_SOURCE],
  );
  return rows
    .filter((r: any) => ["rsvp", "reaction", "comment", "question"].includes(r.kind))
    .map((r: any) => ({ kind: r.kind as ActionKind, title: String(r.title ?? ""), value: String(r.value ?? ""), at: new Date(r.happened_at) }));
}

// Pure: as the knowledge section's entries. `text` is their own words (comments, questions) or their choice (RSVP, reaction).
export function pageActivityOf(rows: RawPageActivity[]): (PageActivity & { verifiedAt: string })[] {
  return rows.filter((r) => r.value.trim()).map((r) => ({ from: "member" as const, kind: r.kind, page: r.title, text: r.value, verifiedAt: r.at.toISOString() }));
}

// Pure: what a text reply is told (known facts about this member, from their own actions only).
export function pageActivityLines(items: { kind: ActionKind; page: string; text: string; verifiedAt: string }[]): string[] {
  const day = (iso: string) => iso.slice(0, 10);
  return items.slice(0, 8).map((a) => {
    const page = `Co's event page for "${a.page}"`;
    if (a.kind === "rsvp") return `On ${page} they RSVP'd ${RSVP_WORDS[a.text] ?? a.text} (${day(a.verifiedAt)}).`;
    if (a.kind === "reaction") return `On ${page} they reacted ${a.text} (${day(a.verifiedAt)}).`;
    if (a.kind === "comment") return `On ${page} they commented (${day(a.verifiedAt)}), their words: "${a.text}".`;
    return `On ${page} they asked Co (${day(a.verifiedAt)}), their words: "${a.text}". Co answers them in this thread; if it hasn't yet, answer it.`;
  });
}
