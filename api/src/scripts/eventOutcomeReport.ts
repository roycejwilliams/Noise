import "dotenv/config";

// TEAM-ONLY. Never sent to a member or a host, never on a page: it reads every pair at every event (counts only, but across members).
//
// Match outcomes per event (Royce, 2026-11-02: "both accepted" isn't enough; did they meet, was it useful, would they keep talking).
// Read-only and free: one read-only session, no model, nothing written. The number to run after an event:
//
//   npx tsx src/scripts/eventOutcomeReport.ts            every event with a pair on record, newest first
//   npx tsx src/scripts/eventOutcomeReport.ts <eventId>  one event
//
// Per event: intros offered (an ask reached at least one side), accepted by both, intro sent, met (yes / no / unknown, and how many
// of the yeses were said rather than inferred), useful as each side said it (each person counted on their own), and kept talking.
// Unknown is its own column, never folded into a no. No names, no ids of members, no words: counts only.
import type { SideEvidence } from "../services/roomMatching.js";

// to_jsonb(p): reads the evidence columns when they exist and an empty record when they don't yet (a database the migration hasn't
// reached), so the count still runs.
export const MATCH_OUTCOMES_SQL = `
  SELECT p.event_id,
         COALESCE(c.event_name, t.name) AS event_name,
         MIN(p.created_at) AS first_at,
         json_agg(json_build_object(
           'offered', (p.asked_a_at IS NOT NULL OR p.asked_b_at IS NOT NULL),
           'both_yes', p.both_yes_at IS NOT NULL,
           'intro_sent', p.intro_sent_at IS NOT NULL,
           'origin', p.origin,
           'a', COALESCE(to_jsonb(p) -> 'a_evidence', '{}'::jsonb),
           'b', COALESCE(to_jsonb(p) -> 'b_evidence', '{}'::jsonb),
           'a_outcome', p.a_outcome, 'b_outcome', p.b_outcome, 'met_at', p.met_at IS NOT NULL
         )) AS pairs
  FROM co_pairs p
  LEFT JOIN event_room_closures c ON c.event_id = p.event_id
  LEFT JOIN co_test_events t ON t.api_id = p.event_id
  WHERE ($1::text IS NULL OR p.event_id = $1)
  GROUP BY p.event_id, COALESCE(c.event_name, t.name)
  ORDER BY MIN(p.created_at) DESC`;

export type PairIn = { offered: boolean; both_yes: boolean; intro_sent: boolean; origin: string; a: SideEvidence; b: SideEvidence; a_outcome: string | null; b_outcome: string | null; met_at: boolean };
export type EventSummary = {
  pairs: number;
  offered: number;
  bothYes: number;
  introSent: number;
  met: { yes: number; no: number; unknown: number; yesStated: number };
  useful: { yes: number; somewhat: number; no: number; unknown: number };
  keptTalking: { yes: number; no: number; unknown: number };
  // Answers on the older columns only (before the outcome record existed): shown, never counted above.
  legacyOnly: number;
};

// Pure: the counts for one event. Met, useful and kept talking are counted over the pairs whose intro went (both said yes and the
// email went); useful counts each side on its own (2 per pair).
export function summarizeEvent(pairs: PairIn[], outcomeOf: (a: SideEvidence, b: SideEvidence) => { met: string; usefulA: string; usefulB: string; keptTalking: string }): EventSummary {
  const s: EventSummary = { pairs: pairs.length, offered: 0, bothYes: 0, introSent: 0, met: { yes: 0, no: 0, unknown: 0, yesStated: 0 }, useful: { yes: 0, somewhat: 0, no: 0, unknown: 0 }, keptTalking: { yes: 0, no: 0, unknown: 0 }, legacyOnly: 0 };
  for (const p of pairs) {
    if (p.offered) s.offered++;
    if (p.both_yes) s.bothYes++;
    if (!p.intro_sent) continue;
    s.introSent++;
    const a = p.a ?? {}, b = p.b ?? {};
    const o = outcomeOf(a, b);
    s.met[o.met as "yes" | "no" | "unknown"]++;
    if (o.met === "yes" && [a, b].some((x) => x.met?.value === "yes" && x.met.how === "stated")) s.met.yesStated++;
    for (const u of [o.usefulA, o.usefulB]) s.useful[(u in s.useful ? u : "unknown") as keyof EventSummary["useful"]]++;
    s.keptTalking[o.keptTalking as "yes" | "no" | "unknown"]++;
    if (!Object.keys(a).length && !Object.keys(b).length && (p.a_outcome || p.b_outcome || p.met_at)) s.legacyOnly++;
  }
  return s;
}

export function formatSummary(eventId: string, name: string | null, s: EventSummary): string {
  return [
    `${name ?? "(no name on file)"}  [${eventId}]`,
    `  pairs on record ${s.pairs} | intros offered ${s.offered} | accepted by both ${s.bothYes} | intro sent ${s.introSent}`,
    `  met:          yes ${s.met.yes} (said ${s.met.yesStated}, inferred ${s.met.yes - s.met.yesStated}) | no ${s.met.no} | unknown ${s.met.unknown}`,
    `  useful (each side): yes ${s.useful.yes} | somewhat ${s.useful.somewhat} | no ${s.useful.no} | unknown ${s.useful.unknown}`,
    `  kept talking: yes ${s.keptTalking.yes} | no / not yet ${s.keptTalking.no} | unknown ${s.keptTalking.unknown}`,
    ...(s.legacyOnly ? [`  (${s.legacyOnly} sent pair(s) have an answer only on the older columns, from before the outcome record)`] : []),
  ].join("\n");
}

async function main() {
  const { default: pool } = await import("../db/db.js");
  const { pairOutcome } = await import("../services/roomMatching.js");
  const client = await pool.connect();
  try {
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const { rows } = await client.query(MATCH_OUTCOMES_SQL, [process.argv[2] ?? null]);
    if (!rows.length) console.log("No pairs on record.");
    let all: PairIn[] = [];
    for (const r of rows) {
      const pairs = r.pairs as PairIn[];
      all = all.concat(pairs);
      console.log(formatSummary(String(r.event_id), r.event_name ?? null, summarizeEvent(pairs, pairOutcome)) + "\n");
    }
    if (rows.length > 1) console.log(formatSummary("all events", "TOTAL", summarizeEvent(all, pairOutcome)));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && /eventOutcomeReport\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("eventOutcomeReport failed:", err?.message ?? err);
    process.exit(1);
  });
}
