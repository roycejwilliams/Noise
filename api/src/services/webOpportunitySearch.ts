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

// The ask decides what shape of thing counts (2026-09-18: this prompt was
// written for one event-grant ask and told the model to reject accelerators,
// even for someone asking for accelerators). The shape check stays: a real
// thing of the wrong kind for THIS ask is the same as nothing.
//
// The sweep runs in the background, so it gets a longer budget; the live
// reply path keeps the short cap (its whole search has 45 seconds). Live
// sweeps timed out at 20s every time (2026-09-18).
export async function searchWebForOpportunity(
  askText: string,
  city: string | null,
  profile: string | null | undefined,
  todayStr: string,
  opts: { source?: "sweep" | "request" } = {},
): Promise<WebOpportunityResult> {
  const sweep = opts.source === "sweep";
  try {
    const { text: raw } = await generateText({
      model: anthropic(WEB_SEARCH_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "webOpportunitySearch.searchWebForOpportunity" },
      // webSearch_20250305, not _20260209: the newer version never returned
      // (every call hung until the timeout, 2026-09-18); this one answers in
      // seconds.
      tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: sweep ? 3 : 2 }) },
      stopWhen: stepCountIs(sweep ? 4 : 3),
      timeout: sweep ? 90_000 : 20_000,
      prompt: `Someone wants: "${askText}"${city ? ` (based in ${city})` : ""}
${profile ? `\nWho they are right now (for their stage and situation; their ask decides the topic):\n${profile}\n` : ""}
Today's date: ${todayStr}

Search the real web for ONE genuinely concrete, currently open thing that fits exactly what they asked for. Depending on the ask that could be an accelerator or fellowship taking applications, an investor or fund actively backing their stage, a grant, a sponsorship or credit program, a city or nonprofit program, a pitch or demo slot, or something else they could act on now. Read the actual page; don't guess from a title or a snippet.

Critical: a real program existing isn't the same as it fitting their ask. Match the SHAPE of what they asked for. If they asked for money to put on an event, cloud credits and equity accelerators don't fit, and a company's "sponsor OUR event" page is the wrong direction. If they asked for accelerators or fellowships, an accelerator with open applications is exactly right. If they asked for investors, a fund that's actively writing checks at their stage fits; a generic listicle doesn't. If everything you find is real but the wrong shape for this ask, that's the same as finding nothing: say so rather than stretch it.

Reject anything whose own page shows it's closed, expired, or from a past cycle relative to today's date, or that only fits an eligibility bar they clearly don't meet. Prefer things in or open to ${city ?? "their area"} when location matters.

If you find a real, current, well-matched fit: give its category (a short word or two: "accelerator", "fellowship", "investor", "grant", "sponsorship", "credit_program", "city_program", "other"), and write "reason" the way you'd tell a friend over text: one short, casual sentence with the one concrete detail that proves it's real (a dollar amount, deadline, or eligibility line from the real page).

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
