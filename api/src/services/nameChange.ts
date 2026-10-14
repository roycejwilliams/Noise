// Telling members the new name, once (Royce, 2026-10-14: "Tell existing members once, in Cue's voice: a single light 'I'm going by
// Cue now' message per member, tracked so it never sends twice").
//
// Fixed wording, like the membership notice: it says one thing and has to say exactly that. It goes through the normal proactive
// path (harness/proactive.ts), so hours, opt-out, the conversation hold, the safety hold, struggling, pacing and a quiet member's
// taper all apply, and an archived account never gets it (archiving skips everything queued, and it is never queued for one).
// It never adds a second text: when another paced text goes first, the line rides in that one (like a stopped-looking note,
// services/askRetire.ts) and is ledgered with it; on its own it is the lowest priority, so it waits for a day nothing else goes.
// Either way one ledger row (proactive_sends, unique per member and NAME_CHANGE_KEY, claimed inside the send lock) means once.
import pool from "../db/db.js";
import { CO_ALIAS_UNTIL } from "./agentName.js";

export const NAME_CHANGE_KEY = "name_change:cue";
// Riding in another text (laneMoves.ts carryLaneNotes adds the final period, after what that text says or before its question).
export const NAME_CHANGE_RIDE = "Quick one: I'm going by Cue now. Same me, new name";
// Its own text.
export const NAME_CHANGE_TEXT = `${NAME_CHANGE_RIDE}.`;
// After the alias ends, "I'm going by Cue now" is old news: what hasn't gone by then never goes.
export const NAME_CHANGE_EXPIRES = new Date(`${CO_ALIAS_UNTIL}T23:59:59-08:00`);

// Pure: whether the line has already been said in a text going out (so a second one never carries it).
export function carriesNameChange(text: string): boolean {
  return /\bgoing by Cue now\b/i.test(text);
}

// Who should hear it: members who knew it as Co. The first time this runs fixes the cutoff (the earliest queued notice), so a
// member who joins after the rename, and only ever heard "Cue", is never told about a name they never knew. A member with no
// phone, an archived account, an opted-out member, or one who never finished joining is left out.
export async function queueNameChange(now: Date = new Date()): Promise<number> {
  const { enqueueCandidate } = await import("../harness/proactive.js");
  const { rows: first } = await pool.query(`SELECT MIN(created_at) AS at FROM proactive_candidates WHERE type = 'name_change'`);
  const cutoff: Date = first[0]?.at ? new Date(first[0].at) : now;
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
      WHERE u.created_at < $1 AND u.archived_at IS NULL AND COALESCE(u.sms_opted_out, false) = false
        AND u.phone_number IS NOT NULL AND u.identity_captured = true
        AND NOT EXISTS (SELECT 1 FROM proactive_sends s WHERE s.user_id = u.id AND s.target_key = $2)
        AND NOT EXISTS (SELECT 1 FROM proactive_candidates c WHERE c.user_id = u.id AND c.target_key = $2)`,
    [cutoff, NAME_CHANGE_KEY],
  );
  let queued = 0;
  for (const r of rows) {
    const q = await enqueueCandidate({
      userId: r.id,
      type: "name_change",
      targetKey: NAME_CHANGE_KEY,
      summary: "Tell them, once, that it goes by Cue now",
      payload: {},
      dueAt: now,
      expiresAt: NAME_CHANGE_EXPIRES,
    }).catch((err: any) => {
      console.error("nameChange: queueing failed (non-fatal):", err?.message ?? err);
      return { queued: false };
    });
    if (q.queued) queued++;
  }
  return queued;
}
