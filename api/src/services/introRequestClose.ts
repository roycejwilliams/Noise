// One neutral close for an intro a member asked for by name (Royce, 2026-10-28): "give every unresolved request the same neutral
// closure after a consistent window, regardless of whether someone was found, declined or stayed silent. Don't expose the reason.
// Don't promise to keep looking unless the member asks." The window is 7 days (his suggestion, taken).
//
// requestEventIntro (agent/conversationTools.ts) records each request here with one insert, the same moment and the same way whether
// the person was found or not. Seven days later, a request with no intro email to both of them gets one closing line, queued as a
// proactive candidate (harness/proactive.ts): the same quiet hours, caps, spacing, conversation hold and hard-day hold as any text
// Cue starts, which move when it goes and never whether it goes. The line is fixed words in code, never drafted by a model, and the
// same for every outcome: found and declined, found and silent, found and not reached, not found. If the intro email goes first,
// nothing is sent; if it goes later, it goes as it always did.
//
// What a later turn can read is the same for every outcome: the candidate's type, key, summary and payload, the ledger row, the
// "Co replied" line and the co_fact of what Cue texted. The one place that differs is this table's target_id (null when nobody
// single was found), read only by the close check below; no turn, export or knowledge read touches this table. Forget by default:
// the row is deleted once the close went, was dropped, or the intro was made.
import pool from "../db/db.js";
import type { Candidate, DraftResult, EnqueueInput } from "../harness/proactive.js";

export const INTRO_CLOSE_DAYS = 7;
export const INTRO_CLOSE_KEY_PREFIX = "intro_close:";
// Team-facing, the same for every request (the pick and the decision log read it; never sent).
export const INTRO_CLOSE_SUMMARY = "Close an intro they asked for a week ago, in the same words whatever happened";

// ---------------------------------------------------------------- the words (Copy: option A, approved by Royce 2026-10-28)

// The name as they said it: the first word, letters only, first letter up. Their own word, never one from the guest list, so it
// reads the same whoever is or isn't on it. Empty when nothing usable was given.
export function nameSaid(personName: unknown): string {
  const first = String(personName ?? "").trim().split(/\s+/)[0] ?? "";
  const clean = first.normalize("NFC").replace(/[^\p{L}'’-]/gu, "").slice(0, 30);
  return clean ? clean[0].toLocaleUpperCase() + clean.slice(1) : "";
}

// The name only ever as the member gave it (Royce, 2026-10-28): kept when it is a word of theirs, in this message or in their own
// lines of the recent exchange; a name they never wrote (one Cue said, one from the guest list, the model's own guess) gives the
// no-name line. Their spelling, first letter up; "Sarah's" counts as "Sarah".
export function nameFromTheirWords(personName: unknown, theirLines: readonly (string | null | undefined)[]): string {
  const name = nameSaid(personName);
  if (!name) return "";
  const key = name.toLocaleLowerCase();
  const said = theirLines.some((l) =>
    (String(l ?? "").normalize("NFC").match(/[\p{L}'’-]+/gu) ?? []).some((w) => w.replace(/['’]s$/iu, "").replace(/^['’-]+|['’-]+$/gu, "").toLocaleLowerCase() === key),
  );
  return said ? name : "";
}
// Their own lines in a recent exchange ("Member: ..."), the format agent/conversationReply.ts hands the tools.
export function memberLinesOf(exchange: string | null | undefined): string[] {
  return String(exchange ?? "").split("\n").filter((l) => l.startsWith("Member: ")).map((l) => l.slice("Member: ".length));
}

// The closing line (option A, approved 2026-10-28, word for word). Never says whether the person was found, asked, declined or silent, and never offers to keep looking.
export function introCloseText(name: string): string {
  return name ? `The intro to ${name} you asked about didn't come together, so I've closed it.` : "The intro you asked about didn't come together, so I've closed it.";
}

// Proactive output rules for it (harness/proactive.ts checkDraft): one short line, no link.
export const INTRO_CLOSE_RULES = { maxChars: 140, maxSentences: 2, allowUrl: false } as const;

// ---------------------------------------------------------------- pure

export type IntroRequestRow = { id: string; user_id: string; close_due_at: Date; introduced: boolean };

// What the close job does with a due request: the intro was made (nothing to close; the row goes), or the one close is queued.
// Found, declined, silent, not reached and not found are all "close", with the same candidate.
export function closeStep(r: IntroRequestRow): { kind: "introduced" } | { kind: "close"; candidate: EnqueueInput } {
  if (r.introduced) return { kind: "introduced" };
  return {
    kind: "close",
    candidate: {
      userId: r.user_id,
      type: "intro_close",
      targetKey: `${INTRO_CLOSE_KEY_PREFIX}${r.id}`,
      summary: INTRO_CLOSE_SUMMARY,
      payload: { requestId: r.id },
      // Its due time is the request's own (asked + 7 days), not when the job got to it, so every outcome is due at the same moment.
      dueAt: new Date(r.close_due_at),
      expiresAt: null,
    },
  };
}

// ---------------------------------------------------------------- the record

// One insert per request, made before requestEventIntro answers, the same for every outcome. target is set only when exactly one
// guest by that full name was found (it is what the close check reads to see whether the intro email went); null otherwise.
export async function recordIntroRequest(userId: string, personName: string, target: { eventId: string; targetId: string } | null, now: Date = new Date()): Promise<void> {
  await pool.query(
    `INSERT INTO intro_requests (user_id, name_said, event_id, target_id, asked_at, close_due_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, nameSaid(personName), target?.eventId ?? null, target?.targetId ?? null, now, new Date(now.getTime() + INTRO_CLOSE_DAYS * 86_400_000)],
  );
}

// Whether they were introduced: the event pair's intro email went (co_pairs.intro_sent_at, at any event), or the network intro was
// made (network_introductions, introduced). An intro already made is never "closed".
const INTRODUCED_SQL = `(r.target_id IS NOT NULL AND (EXISTS (SELECT 1 FROM co_pairs p WHERE p.a_id = LEAST(r.user_id, r.target_id) AND p.b_id = GREATEST(r.user_id, r.target_id) AND p.intro_sent_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM network_introductions n WHERE n.person_a_id = LEAST(r.user_id, r.target_id) AND n.person_b_id = GREATEST(r.user_id, r.target_id) AND (n.status = 'introduced' OR n.introduced_at IS NOT NULL))))`;
// A close queued over an hour ago whose candidate is no longer pending (sent, skipped or expired) was handled: its row should be gone.
// When onSent or onDropped failed to delete it, the job does, so no row outlives its close. Exactly once still holds: the row is
// only deleted once its candidate can't go again, and a sent key is never queued again.
export const INTRO_CLOSE_SWEEP_SQL = `DELETE FROM intro_requests r WHERE r.close_queued_at IS NOT NULL AND r.close_queued_at <= $1
  AND NOT EXISTS (SELECT 1 FROM proactive_candidates c WHERE c.user_id = r.user_id AND c.target_key = '${INTRO_CLOSE_KEY_PREFIX}' || r.id::text AND c.status = 'pending')`;

// Hourly (jobs/index.ts): every request past its 7 days that hasn't been handled. Exactly once per request, across restarts: the
// candidate's key is the request's id (enqueueCandidate is idempotent per key, and a key already sent is never queued again), and
// the row is marked queued only after the candidate is in, so a crash in between queues the same candidate again, harmlessly.
export async function queueDueIntroCloses(now: Date = new Date(), enqueue?: (c: EnqueueInput) => Promise<{ queued: boolean }>): Promise<number> {
  const add = enqueue ?? (await import("../harness/proactive.js")).enqueueCandidate;
  await pool.query(INTRO_CLOSE_SWEEP_SQL, [new Date(now.getTime() - 3600_000)]).catch((err: any) => console.error("introRequestClose: sweeping handled requests failed (non-fatal):", err?.message ?? err));
  const { rows } = await pool.query(
    `SELECT r.id, r.user_id, r.close_due_at, ${INTRODUCED_SQL} AS introduced FROM intro_requests r
     WHERE r.close_due_at <= $1 AND r.close_queued_at IS NULL ORDER BY r.close_due_at LIMIT 200`,
    [now],
  );
  let queued = 0;
  for (const r of rows as IntroRequestRow[]) {
    const step = closeStep(r);
    try {
      if (step.kind === "introduced") {
        await forgetIntroRequest(r.id);
        continue;
      }
      await add(step.candidate);
      await pool.query(`UPDATE intro_requests SET close_queued_at = $2 WHERE id = $1 AND close_queued_at IS NULL`, [r.id, now]);
      queued++;
    } catch (err: any) {
      console.error(`introRequestClose: ${r.id} (non-fatal, the next run tries again):`, err?.message ?? err);
    }
  }
  return queued;
}

// The candidate's text, read at send time (harness/proactiveRegistry.ts intro_close). The intro email went since it was queued:
// nothing goes. The row is gone (already closed or forgotten): nothing goes.
export async function draftIntroClose(c: Pick<Candidate, "payload">): Promise<DraftResult> {
  const id = String((c.payload as { requestId?: string } | null)?.requestId ?? "");
  if (!id) return { skip: "no request on it" };
  const { rows } = await pool.query(`SELECT r.name_said, ${INTRODUCED_SQL} AS introduced FROM intro_requests r WHERE r.id = $1`, [id]);
  if (!rows[0]) return { skip: "the request is no longer on file" };
  if (rows[0].introduced) return { skip: "the intro was made" };
  const text = introCloseText(String(rows[0].name_said ?? ""));
  return { messages: [text], text, rules: { ...INTRO_CLOSE_RULES } };
}

// Forget by default: once the close went, was dropped, or the intro was made, the request row goes.
export async function forgetIntroRequest(id: string): Promise<void> {
  if (!id) return;
  await pool.query(`DELETE FROM intro_requests WHERE id = $1`, [id]);
}
