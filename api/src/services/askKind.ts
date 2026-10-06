// Living asks (Royce, 2026-09-26: "How can I make Co more adaptable?" …
// "Do all."). Not every ask is something a search can find. "Find me a
// founder meetup" is; "plan out the event" and "what can we offer sponsors"
// are asks for Co's help, and searching them every morning took slots from
// the asks that matter and brought back noise. Each ask is marked once:
// "find" asks are searched, "help" asks aren't, and Co checks in on both.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { sealedTelemetry } from "./privateTurn.js";

export type AskKind = "find" | "help";

export async function classifyAsk(text: string): Promise<AskKind> {
  try {
    const { text: out } = await Promise.race([
      generateText({
        model: anthropic(MODELS.haiku),
        maxOutputTokens: 10,
        experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "askKind.classify" },
        prompt: `Someone asked Co for this: "${text.slice(0, 300)}"

Answer "find" if Co could meet it by finding something out in the world: an event, a group or community (including researching which ones exist), people to meet or befriend (even when it's worded as wanting to connect with a kind of person), a program or an opportunity.

Answer "help" only if it's asking Co to work something out with them: advice, deciding, planning, writing, organizing, figuring out what to offer. Finding sponsors or investors by name is "help": Co's search can't find those.

Answer with one word: find or help.`,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
    ]);
    return out.trim().toLowerCase().startsWith("help") ? "help" : "find";
  } catch {
    // When unsure, keep searching it, as before.
    return "find";
  }
}

// Marks open asks that haven't been classified yet (older asks, or one whose
// check timed out). Run before each morning sweep.
export async function classifyOpenAsks(limit = 25): Promise<number> {
  const { rows } = await pool.query(`SELECT id, ask_text FROM ask_checkins WHERE resolved_at IS NULL AND kind_checked_at IS NULL LIMIT $1`, [limit]);
  for (const r of rows) {
    const kind = await classifyAsk(r.ask_text);
    await pool.query(`UPDATE ask_checkins SET kind = $2, kind_checked_at = NOW() WHERE id = $1`, [r.id, kind]).catch(() => {});
  }
  return rows.length;
}

// One way to close an ask, in both places it lives (2026-09-26: closing only
// touched ask_checkins, so co_profiles.intent still listed expired asks as
// active; "what are you looking out for me" and live searches kept using
// them). Closes the check-in row, marks the intent entry resolved, and
// retires any open matches for it.
export async function closeAsk(userId: string, askId: string, reason: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE ask_checkins SET resolved_at = COALESCE(resolved_at, NOW()) WHERE user_id = $1 AND ask_id = $2`,
    [userId, askId],
  );
  await markIntentResolved(userId, [askId]);
  await pool
    .query(
      `UPDATE relevance_edges SET status = 'retired', retired_at = NOW(), retired_reason = $3 WHERE person_id = $1 AND ask_id = $2 AND status = 'open'`,
      [userId, askId, reason.slice(0, 200)],
    )
    .catch(() => {});
  return (rowCount ?? 0) > 0;
}

export async function markIntentResolved(userId: string, askIds: string[]): Promise<number> {
  if (!askIds.length) return 0;
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const intent = Array.isArray(rows[0]?.intent) ? rows[0].intent : null;
  if (!intent) return 0;
  let changed = 0;
  const next = intent.map((e: any) => {
    if (e && askIds.includes(e.id) && e.status === "active") {
      changed++;
      return { ...e, status: "resolved", resolved_at: new Date().toISOString() };
    }
    return e;
  });
  if (changed) await pool.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(next)]);
  return changed;
}

// Brings profiles back in step with asks already closed (expired, resolved,
// or closed by hand before closeAsk existed). Run before each sweep.
export async function syncClosedAsks(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT ac.user_id, array_agg(ac.ask_id) AS ids
     FROM ask_checkins ac JOIN co_profiles cp ON cp.user_id = ac.user_id
     WHERE ac.resolved_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(cp.intent, '[]'::jsonb)) e WHERE e->>'id' = ac.ask_id AND e->>'status' = 'active')
     GROUP BY ac.user_id`,
  );
  let n = 0;
  for (const r of rows) n += await markIntentResolved(r.user_id, r.ids);
  return n;
}
