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
import { checkGrounding } from "../harness/matchGate.js";

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

// The page's own text, read here rather than trusted from the model's answer:
// the gate checks the name, numbers, deadline, and places against it, the way
// an X result is checked against its post. The gate gets the whole page
// (2026-09-18: the Awesome Foundation's "$1000" sat past an 8,000-character
// cut, below a list of past grantees, and the result was rejected); Co's
// drafting prompts get a short excerpt around what the result claims.
const PAGE_TEXT_LIMIT = 60_000;
const EXCERPT_LIMIT = 2500;

// Readable sentences a page keeps in its script data rather than its HTML
// (2026-09-18: NFX's "$500K - $2M SAFE" only exists in the page's Next.js
// data, so the gate rejected a true reason). Only string values that read
// like text: letters and spaces, not code or ids.
function scriptText(html: string): string {
  const out: string[] = [];
  for (const [, body] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const [, str] of body.matchAll(/"((?:[^"\\]|\\.){12,400})"/g)) {
      const t = str.replace(/\\[nrt]/g, " ").replace(/\\(["\\/])/g, "$1").replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      if (/[a-z]{3,} [a-z]{2,}/i.test(t) && !/[{};=<>]|function|https?:|\.(js|css|png|svg)\b/.test(t)) out.push(t);
    }
  }
  return [...new Set(out)].join(". ");
}

export function htmlToText(html: string): string {
  const fromScripts = scriptText(html);
  return (html
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    + (fromScripts ? ` ${fromScripts}` : ""))
    .replace(/\s+/g, " ")
    .trim();
}

export async function readPageText(url: string): Promise<string | null> {
  try {
    const u = new URL(url);
    // Public https pages only; never a local or bare-IP address.
    if (u.protocol !== "https:" || u.hostname === "localhost" || /^[\d.]+$|:/.test(u.hostname)) return null;
    const res = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; Co)" }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
    if (!res.ok || !/text\/(html|plain)/.test(res.headers.get("content-type") ?? "")) return null;
    const text = htmlToText(await res.text());
    return text ? text.slice(0, PAGE_TEXT_LIMIT) : null;
  } catch {
    return null;
  }
}

// The opening of the page plus the passages around the result's name,
// amounts, and deadline, so Co drafts from the parts that back the result.
export function pageExcerpt(text: string, claims: { name: string; reason: string; deadline?: string | null }): string {
  if (text.length <= EXCERPT_LIMIT) return text;
  const lower = text.toLowerCase();
  const needles = [
    ...(claims.reason.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, "")),
    ...claims.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
  ];
  if (claims.deadline) {
    const month = new Date(`${claims.deadline}T12:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
    needles.push(month);
  }
  const spans: [number, number][] = [[0, 600]];
  for (const needle of needles) {
    const at = lower.indexOf(needle.toLowerCase());
    if (at > 600) spans.push([Math.max(0, at - 250), at + 250]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged.map(([a, b]) => text.slice(a, b).trim()).join(" … ").slice(0, EXCERPT_LIMIT);
}

// Words that say what kind of thing it is, not whose it is.
const GENERIC_NAME_WORDS = new Set(["the", "and", "for", "program", "programs", "accelerator", "fellowship", "fund", "grant", "grants", "foundation", "batch", "winter", "summer", "spring", "fall", "cohort", "applications", "application", "startup", "startups", "founder", "founders", "venture", "ventures", "capital", "city", "san", "francisco", "chapter", "global", "community", "challenge"]);

// Whether a link is the program's own site: its domain carries the program's
// name ("ycombinator.com" for "Y Combinator"), or it's a government site. A
// blog about the program ("zyner.io/blog/yc-application-deadline") isn't.
export function looksOfficial(url: string, name: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  if (/\.gov$/.test(host)) return true;
  const labels = host.split(".").slice(0, -1).filter((l) => l.length >= 3);
  const compactName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (labels.some((l) => compactName.includes(l.replace(/-/g, "")))) return true;
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC_NAME_WORDS.has(w));
  return words.some((w) => host.replace(/[.-]/g, "").includes(w));
}

// The reason and deadline again, from the page's own text only.
async function rewriteFromPage(match: TierMatch & { tier: 3 }, timeout: number): Promise<{ reason: string; deadline: string | null } | null> {
  try {
    const { text: raw } = await generateText({
      model: anthropic(MODELS.haiku),
      experimental_telemetry: { isEnabled: true, functionId: "webOpportunitySearch.rewriteFromPage" },
      timeout,
      prompt: `Here is the text of the page for "${match.name}":

${match.evidence!.slice(0, 15_000)}

This one-line reason was written for it, but it includes details the page doesn't say:
"${match.reason}"

Rewrite it as one short, casual sentence, the way you'd tell a friend over text, using ONLY what this page says. Keep one concrete detail (an amount, deadline, or eligibility line) only if this page states it, written the same way the page writes it. Give the application deadline only if this page states one.

Return ONLY valid JSON: {"reason": "...", "deadline": "YYYY-MM-DD" or null}`,
    });
    const parsed = parseModelJson<{ reason?: string; deadline?: string | null }>(raw);
    if (typeof parsed?.reason !== "string" || !parsed.reason.trim()) return null;
    return { reason: parsed.reason.trim(), deadline: typeof parsed.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline) ? parsed.deadline : null };
  } catch {
    return null;
  }
}

// One quick search for the program's own page, used when the result came
// from a blog or listicle. Null when it can't find one.
async function findOfficialPage(name: string, timeout: number): Promise<string | null> {
  try {
    const { text: raw } = await generateText({
      model: anthropic(WEB_SEARCH_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "webOpportunitySearch.findOfficialPage" },
      tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 1 }) },
      stopWhen: stepCountIs(2),
      timeout,
      prompt: `Find the official website page for "${name}" (the program's or organization's own site, ideally its apply or program page, not a blog, news story, or directory about it).

Return ONLY valid JSON: {"url": "https://..."} or {"url": null} if you can't find its own site.`,
    });
    const parsed = parseModelJson<{ url?: string | null }>(raw);
    return typeof parsed?.url === "string" && /^https:\/\//.test(parsed.url) ? parsed.url : null;
  } catch {
    return null;
  }
}

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

If you find a real, current, well-matched fit: give its category (a short word or two: "accelerator", "fellowship", "investor", "grant", "sponsorship", "credit_program", "city_program", "other"), and write "reason" the way you'd tell a friend over text: one short, casual sentence with the one concrete detail that proves it's real (a dollar amount, deadline, or eligibility line). That detail, the name, and any deadline must be stated on the exact page you return as "url", not on another page or a search snippet: that page's text is checked, and anything it doesn't say gets the whole result thrown out. Return the program's or fund's own official page, not a blog or listicle about it, whenever the official page states those details.

Return ONLY valid JSON, nothing else: {"found": true, "name": "...", "url": "the real page URL you actually read", "category": "...", "reason": "...", "deadline": "YYYY-MM-DD" or null} or {"found": false}`,
    });
    const parsed = parseModelJson<{ found?: boolean; name?: string; url?: string; category?: string; reason?: string; deadline?: string | null }>(raw);
    if (!parsed?.found || typeof parsed.name !== "string" || typeof parsed.url !== "string") return null;
    const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "Found via a real web search.";
    const deadline = typeof parsed.deadline === "string" ? parsed.deadline : null;
    const build = (url: string, pageText: string | null): TierMatch & { tier: 3 } => ({
      tier: 3,
      kind: "opportunity",
      source: "web",
      name: parsed.name!,
      url,
      // An unreadable page still goes to the gate, which turns it away with a
      // reason the trace shows.
      ...(pageText ? { evidence: pageText, opportunity: { postText: pageExcerpt(pageText, { name: parsed.name!, reason, deadline }) } } : {}),
      reason,
      category: typeof parsed.category === "string" ? parsed.category.trim().toLowerCase().slice(0, 40) : null,
      ...(deadline ? { deadline } : {}),
    });
    const grounded = (m: TierMatch & { tier: 3 }) =>
      checkGrounding(m, { searchCity: null, distanceMiles: null, alreadyOffered: false, now: new Date(), evidence: m.evidence ?? null }).pass;
    const found = build(parsed.url, await readPageText(parsed.url));
    // A blog about the program is a worse link to hand someone than the
    // program's own page (2026-09-18: YC went out as a zyner.io blog post).
    // Prefer the official page; keep what was found when it can't be had.
    let official: (TierMatch & { tier: 3 }) | null = null;
    if (!looksOfficial(parsed.url, parsed.name)) {
      const officialUrl = await findOfficialPage(parsed.name, sweep ? 30_000 : 12_000);
      if (officialUrl && officialUrl !== parsed.url && looksOfficial(officialUrl, parsed.name)) {
        official = build(officialUrl, await readPageText(officialUrl));
      }
    }
    const ordered = [official, found].filter((m): m is TierMatch & { tier: 3 } => m != null);
    const ok = ordered.find(grounded);
    if (ok) return ok;
    // The model quoted something from another site (2026-09-18: "$500k" for
    // YC, whose apply page never says it). Rewrite the reason once from the
    // page alone rather than lose a real, open program over one detail.
    for (const m of ordered) {
      if (!m.evidence) continue;
      const fixed = await rewriteFromPage(m, sweep ? 20_000 : 8_000);
      if (fixed) {
        const again = { ...m, reason: fixed.reason, ...(fixed.deadline ? { deadline: fixed.deadline } : {}) } as TierMatch & { tier: 3 };
        if (!fixed.deadline) delete (again as { deadline?: string }).deadline;
        if (again.evidence) again.opportunity = { postText: pageExcerpt(again.evidence, { name: again.name, reason: again.reason, deadline: fixed.deadline }) };
        if (grounded(again)) return again;
      }
      break;
    }
    return found;
  } catch (err: any) {
    console.error("webOpportunitySearch: searchWebForOpportunity failed (non-fatal):", err?.message ?? err);
    return null;
  }
}
