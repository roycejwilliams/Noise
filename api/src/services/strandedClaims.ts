// Claims a restart or crash left behind (2026-09-24). Two sends mark their
// row before sending, so two runs never both text the same person: the
// day-of arrival ask (event_presence) and the in-room match nudge
// (event_guest_match_nudges). If the server dies between the mark and the
// send, the row says "done" with nothing delivered, and that member is
// never asked. Both now carry a pending flag, cleared once the text is out;
// this frees any still pending after STRANDED_AFTER so a later run retries.
// Graceful shutdown (services/shutdown.ts) makes this rare; this covers
// crashes and jobs longer than the grace period.
import pool from "../db/db.js";

export const STRANDED_AFTER_MINUTES = 10; // a real send finishes in well under a minute

export function strandedArrivalAsksSql(): string {
  return `UPDATE event_presence SET asked_at = NULL, ask_pending = false
          WHERE ask_pending AND asked_at < NOW() - INTERVAL '${STRANDED_AFTER_MINUTES} minutes'
          RETURNING event_api_id, user_id`;
}

export function strandedMatchNudgesSql(): string {
  return `DELETE FROM event_guest_match_nudges
          WHERE pending AND sent_at < NOW() - INTERVAL '${STRANDED_AFTER_MINUTES} minutes'
          RETURNING event_id, person_id`;
}

export async function releaseStrandedClaims(): Promise<{ arrivalAsks: number; matchNudges: number }> {
  const asks = await pool.query(strandedArrivalAsksSql()).catch((err: any) => {
    console.error("strandedClaims: arrival asks sweep failed (non-fatal):", err?.message ?? err);
    return { rows: [] as any[] };
  });
  const nudges = await pool.query(strandedMatchNudgesSql()).catch((err: any) => {
    console.error("strandedClaims: match nudges sweep failed (non-fatal):", err?.message ?? err);
    return { rows: [] as any[] };
  });
  const out = { arrivalAsks: asks.rows.length, matchNudges: nudges.rows.length };
  if (out.arrivalAsks || out.matchNudges) {
    console.log(`strandedClaims: freed ${out.arrivalAsks} arrival ask(s) and ${out.matchNudges} match nudge(s) that never sent; they'll retry`);
  }
  return out;
}
