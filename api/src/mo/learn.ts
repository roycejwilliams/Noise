// Mo learns from what happened after someone joined, not from the join
// itself (Royce, 2026-09-26). A yes to Mo's message is the weakest signal;
// what counts is whether they took to Co: talked with it, came to a Co
// event, said yes to meeting someone. The same idea as Co's outcome learning
// (services/outcomes.ts), for Mo's choices.
//
// Lessons are general ("people hosting their own small dinners"), never a
// name or a company, and they only shape Mo's own search plan and judging.
// The team only ever sees counts.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { sealedTelemetry } from "../services/privateTurn.js";

export type Took = "active" | "quiet" | "early";
export type JoinedOutcome = { no: number; took: Took; reason: string; quote: string; opener: string | null };

// Pure: how someone took to Co, from what they did.
export function tookToCo(o: { replies: number; events: number; introYes: number; daysSinceJoin: number }): Took {
  if (o.events > 0 || o.introYes > 0 || o.replies >= 5) return "active";
  if (o.daysSinceJoin >= 7 && o.replies <= 1) return "quiet";
  return "early";
}

export async function joinedOutcomes(): Promise<JoinedOutcome[]> {
  const { rows } = await pool
    .query(
      `SELECT sp.no, sp.reason, sp.evidence_quote, sp.opener,
              EXTRACT(EPOCH FROM (NOW() - sp.joined_at)) / 86400 AS days,
              (SELECT count(*) FROM co_memories m WHERE m.user_id = sp.joined_user_id AND m.memory_type = 'text_exchange' AND m.content LIKE 'User said:%')::int AS replies,
              (SELECT count(*) FROM event_presence e WHERE e.user_id = sp.joined_user_id AND e.arrived_at IS NOT NULL)::int AS events,
              (SELECT count(*) FROM event_guest_match_opt_ins o WHERE o.person_id = sp.joined_user_id AND o.status = 'interested')::int AS intro_yes
       FROM mo_prospects sp
       JOIN users u ON u.id = sp.joined_user_id
       WHERE sp.status = 'joined' AND u.archived_at IS NULL`,
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({
    no: r.no,
    took: tookToCo({ replies: r.replies, events: r.events, introYes: r.intro_yes, daysSinceJoin: Number(r.days) }),
    reason: String(r.reason ?? ""),
    quote: String(r.evidence_quote ?? ""),
    opener: r.opener ?? null,
  }));
}

// For the team: counts only.
export function outcomesLine(outcomes: { took: Took }[]): string | null {
  if (!outcomes.length) return null;
  const n = (t: Took) => outcomes.filter((o) => o.took === t).length;
  const [a, q, e] = [n("active"), n("quiet"), n("early")];
  const bits = [a ? `${a} ${a === 1 ? "has" : "have"} really taken to Co` : null, q ? `${q} went quiet` : null, e ? `${e} too early to tell` : null].filter(Boolean);
  return `Of the ${outcomes.length} who joined through me, ${bits.join(", ")}.`;
}

// What's worked, in general terms, from people who settled one way or the
// other. Needs at least one of each to compare. Cached for a week.
export async function moLessons(opts: { refresh?: boolean } = {}): Promise<string[]> {
  const { rows: c } = await pool.query(`SELECT value, updated_at FROM mo_settings WHERE key = 'lessons'`).catch(() => ({ rows: [] as any[] }));
  if (!opts.refresh && c[0] && Date.now() - new Date(c[0].updated_at).getTime() < 7 * 24 * 3_600_000) return (c[0].value as string[]) ?? [];
  const outcomes = await joinedOutcomes();
  const active = outcomes.filter((o) => o.took === "active");
  const quiet = outcomes.filter((o) => o.took === "quiet");
  let lessons: string[] = [];
  if (active.length && quiet.length) {
    try {
      const { text } = await generateText({
        model: anthropic(MODELS.haiku),
        experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "mo.lessons" },
        prompt: `You invite people to a private social club. Here's why you invited each person, and whether they took to the club after joining.

Took to it:
${active.map((o) => `- ${o.reason} (they posted: "${o.quote.slice(0, 160)}")`).join("\n")}

Joined, then went quiet:
${quiet.map((o) => `- ${o.reason} (they posted: "${o.quote.slice(0, 160)}")`).join("\n")}

Write at most 3 short lessons about which kinds of people and which signals in a post predict someone taking to the club. General terms only: no names, no handles, no companies, never more than three words in a row from any line above. If there's no real pattern, return fewer or none.

Return ONLY JSON: {"lessons": ["..."]}`,
      });
      lessons = (parseModelJson<{ lessons?: string[] }>(text).lessons ?? [])
        .filter((l) => typeof l === "string" && l.trim().length > 5)
        .map((l) => l.replace(/\s*[—–]\s*/g, ", ").trim().slice(0, 160))
        .slice(0, 3);
    } catch {
      return (c[0]?.value as string[]) ?? [];
    }
    // Nothing that names a member or a person Mo reached.
    const { queryLeaks } = await import("./find.js");
    const { rows: names } = await pool
      .query(`SELECT first_name AS n FROM users WHERE archived_at IS NULL UNION SELECT last_name FROM users WHERE archived_at IS NULL UNION SELECT split_part(name, ' ', 1) FROM mo_prospects UNION SELECT x_handle FROM mo_prospects`)
      .catch(() => ({ rows: [] as any[] }));
    const nameList = names.map((r: any) => r.n).filter((n: any) => typeof n === "string" && n.trim().length >= 3).map((n: string) => n.trim().toLowerCase());
    const source = outcomes.flatMap((o) => [o.reason, o.quote]);
    lessons = lessons.filter((l) => !queryLeaks(l, source, nameList));
  }
  await pool
    .query(
      `INSERT INTO mo_settings (key, value, updated_at) VALUES ('lessons', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(lessons)],
    )
    .catch(() => {});
  return lessons;
}
