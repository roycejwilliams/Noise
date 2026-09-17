// Tier 3's second source: the general web, not just X (2026-09-17, Royce:
// "can we ultimately fold something like that into Co?" after a live web
// search found a real, currently-open SF community-event grant that X's
// recent-search structurally could never surface).
//
// X search only sees posts from the last 7 days — a real fit for "someone
// just announced applications are open," a bad fit for the evergreen
// program pages most grants, corporate credit programs, and city programs
// actually live on (nobody re-posts "the SF Parks Alliance grant exists"
// every week). This runs a genuine web search, via Anthropic's own
// server-side web-search tool (Claude searches, reads real pages, and
// answers grounded in what it actually found — same mechanism used to find
// that real example live).
//
// Deliberately a fallback, not a replacement: tried only when X's search
// (tryTier3 in tieredRecommendation.ts) already found nothing, so this
// doesn't double the cost of every single Tier 3 search. Separate budget
// from X's (web_search_log, its own daily cap) since it's a different API
// with its own cost.
import { generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import type { PoolClient } from "pg";
import { xSearchBudget } from "./searchRules.js";
import { parseModelJson } from "./modelJson.js";
import { MODELS } from "../models.js";
import type { TierMatch } from "./tieredRecommendation.js";

// Judgment call (does this real, current thing actually fit, or is it just
// a real thing that exists), not narrow extraction — same policy reasoning
// as the relevance judge: Sonnet 5, not Haiku.
const WEB_SEARCH_MODEL = MODELS.sonnet;

const WEB_SEARCH_DAILY_CAP = Number(process.env.WEB_SEARCH_DAILY_CAP ?? 60);
const WEB_SEARCH_REQUEST_RESERVE = Number(process.env.WEB_SEARCH_REQUEST_RESERVE ?? 15);

// Same count-then-insert-under-one-advisory-lock pattern as reserveXSearch
// in tieredRecommendation.ts, against its own table so the two budgets never
// share a cap. Fails closed on any error — no web search if the budget
// can't be checked.
export async function reserveWebSearch(userId: string | null, source: "sweep" | "request", query: string): Promise<{ ok: boolean; reason: string | null }> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('web_search_budget'))");
    const { rows } = await client.query(`SELECT COUNT(*)::int AS today FROM web_search_log WHERE created_at > NOW() - INTERVAL '1 day'`);
    const decision = xSearchBudget(Number(rows[0]?.today ?? 0), source, WEB_SEARCH_DAILY_CAP, WEB_SEARCH_REQUEST_RESERVE);
    if (!decision.ok) {
      await client.query("ROLLBACK");
      return decision;
    }
    await client.query(`INSERT INTO web_search_log (user_id, source, query) VALUES ($1, $2, $3)`, [userId, source, query]);
    await client.query("COMMIT");
    return decision;
  } catch (err: any) {
    await client?.query("ROLLBACK").catch(() => {});
    console.error("webOpportunitySearch: budget check failed (no web search):", err?.message ?? err);
    return { ok: false, reason: `the web search budget couldn't be checked (${err?.message ?? "error"}), so no web search` };
  } finally {
    client?.release();
  }
}

export type WebOpportunityResult = (TierMatch & { tier: 3 }) | null;

// The exact mistake caught live doing this by hand (2026-09-17): AWS
// Activate and Google for Startups are real, but they're cloud/tool
// credits, not cash for an event; a16z speedrun and Techstars are real
// accelerators, not something you apply to just to fund one event;
// Techstars "sponsor an event" is the reverse direction (them asking
// companies to sponsor Techstars). The prompt below says this explicitly
// so the model doesn't make the same category-mismatch call a first pass
// through this content made.
export async function searchWebForOpportunity(
  askText: string,
  city: string | null,
  profile: string | null | undefined,
  todayStr: string,
): Promise<WebOpportunityResult> {
  try {
    const { text: raw } = await generateText({
      model: anthropic(WEB_SEARCH_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "webOpportunitySearch.searchWebForOpportunity" },
      tools: { web_search: anthropic.tools.webSearch_20260209({ maxUses: 3 }) },
      stopWhen: stepCountIs(4),
      prompt: `Someone wants: "${askText}"${city ? ` (based in ${city})` : ""}
${profile ? `\nWho they are right now:\n${profile}\n` : ""}
Today's date: ${todayStr}

Search the real web for ONE genuinely concrete, currently-open thing that fits what they actually asked for — a grant, a corporate community/event credit or sponsorship program, a city or nonprofit program, or a similar real, applicable opportunity. Read the actual page, don't guess from a title or a summary snippet.

Critical: a real program existing isn't the same as it fitting what they asked. Reject anything that's real but the wrong SHAPE of thing — cloud/software credits (AWS Activate, Google for Startups, etc.) are not cash for an event; an equity-based accelerator (a16z, Techstars, Y Combinator) is not something you apply to just to fund one event; a company's "sponsor OUR event" page is the opposite direction from funding someone else's event. If everything you find is a real thing that doesn't actually fit the ask's shape, that's the same as finding nothing — say so, don't stretch a mismatch to look like an answer.

Also reject anything whose own page shows it's closed, expired, or from a past cycle relative to today's date, or that only fits an eligibility bar they clearly don't meet (e.g. a program only for nonprofits, when they're not one).

If you find a real, current, well-matched fit: give its category (a short word or two: "grant", "sponsorship", "credit_program", "city_program", "other"), and write "reason" the way you'd tell a friend over text — one short, casual sentence, plainly, with the one concrete detail that proves it's real (an actual dollar amount, deadline, or eligibility line from the real page), not analyst language.

Return ONLY valid JSON, nothing else: {"found": true, "name": "...", "url": "the real page URL you actually read", "category": "...", "reason": "...", "deadline": "YYYY-MM-DD" or null} or {"found": false}`,
    });
    const parsed = parseModelJson<{ found?: boolean; name?: string; url?: string; category?: string; reason?: string; deadline?: string | null }>(raw);
    if (!parsed?.found || typeof parsed.name !== "string" || typeof parsed.url !== "string") return null;
    return {
      tier: 3,
      kind: "opportunity",
      name: parsed.name,
      url: parsed.url,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "Found via a real web search.",
      category: typeof parsed.category === "string" ? parsed.category.trim().toLowerCase().slice(0, 40) : null,
      ...(typeof parsed.deadline === "string" ? { deadline: parsed.deadline } : {}),
    };
  } catch (err: any) {
    console.error("webOpportunitySearch: searchWebForOpportunity failed (non-fatal):", err?.message ?? err);
    return null;
  }
}
