// Mo, steps 1–3: find people on X (and LinkedIn through web search
// only), keep the ones with a specific post that fits, and draft what Co
// would say. Nothing is sent here; everything waits for a person's approval
// (mo/review.ts).
//
// Leak rule (standing): the searches and reasons use what members want in
// general terms ("design co-builders"), never who wants it. Drafts are
// checked for member names in code (rules.ts namesAMember).
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { recordDecision, type GateCheck } from "../harness/core.js";
import { reserveXSearch } from "../services/tieredRecommendation.js";
import { reserveWebSearch } from "../services/webOpportunitySearch.js";
import { listCalendarEvents } from "../services/luma.js";
import { searchPostsWithAuthors, type MoPost } from "./xApi.js";
import { MO, inCity, locationInCity, neutralPronouns, placeOk, quoteIsTheirs, suppressionKeys } from "./rules.js";
import { draftOutreach, OPENER_IDS, type DmStyle, type OpenerId } from "./draft.js";
import { screenPosts } from "./jev.js";
import { sealedTelemetry } from "../services/privateTurn.js";

type Wants = { wants: string[]; event: string | null };

// What the club is looking for right now, in general terms.
async function clubWants(): Promise<Wants> {
  const { rows } = await pool.query(
    `SELECT a.ask_text FROM ask_checkins a JOIN users u ON u.id = a.user_id
     WHERE a.resolved_at IS NULL AND u.archived_at IS NULL AND a.created_at > NOW() - INTERVAL '45 days'
     ORDER BY a.created_at DESC LIMIT 30`,
  );
  const events = await listCalendarEvents().catch(() => []);
  const next = events
    .filter((e: any) => e.start_at && new Date(e.start_at) > new Date())
    .sort((a: any, b: any) => (a.start_at < b.start_at ? -1 : 1))[0] as any;
  return {
    wants: rows.map((r: any) => String(r.ask_text).slice(0, 160)),
    event: next
      ? `${next.name} on ${DateTime.fromISO(String(next.start_at)).setZone("America/Los_Angeles").toFormat("cccc, LLLL d")}${next.city ? ` in ${next.city}` : ""}`
      : null,
  };
}

type Queries = { x: string[]; linkedin: string | null; themes: string[] };

// Searches leave Co, so a query can't carry a member's words verbatim (any
// run of 5+ words from one of their asks) or a member's name.
let memberNameCache: string[] = [];
async function loadMemberNames(): Promise<void> {
  const { rows } = await pool.query(`SELECT first_name, last_name FROM users WHERE archived_at IS NULL`).catch(() => ({ rows: [] as any[] }));
  memberNameCache = rows.flatMap((r: any) => [r.first_name, r.last_name]).filter((n: any) => typeof n === "string" && n.trim().length >= 3).map((n: string) => n.trim().toLowerCase());
}
export function queryLeaks(q: string, asks: string[], names: string[]): boolean {
  const lq = ` ${q.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ")} `;
  if (names.some((n) => lq.includes(` ${n} `))) return true;
  for (const a of asks) {
    const words = a.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    for (let i = 0; i + 5 <= words.length; i++) if (lq.includes(` ${words.slice(i, i + 5).join(" ")} `)) return true;
  }
  return false;
}
function queryIsSafe(q: string, w: Wants): boolean {
  return !queryLeaks(q, w.wants, memberNameCache);
}

async function planQueries(w: Wants): Promise<Queries> {
  // What Co says the network is short on, in general terms, and what the
  // team asked Mo to look for (mo/team.ts). Members' own asks only feed the
  // leak check below, never the search plan.
  // Who the next Co event's guests would most want to meet comes first
  // (mo/team.ts roomNeeds, 2026-09-26), then what worked before (mo/learn.ts).
  const { networkGaps, activeFocus, roomNeeds } = await import("./team.js");
  const { moLessons } = await import("./learn.js");
  const [gaps, focus, room, lessons] = await Promise.all([
    networkGaps().catch(() => []),
    activeFocus().catch(() => []),
    roomNeeds().catch(() => null),
    moLessons().catch(() => [] as string[]),
  ]);
  const { text } = await generateText({
    model: anthropic(MODELS.haiku),
    experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "mo.planQueries" },
    prompt: `Co is a private, invite-only club for founders and builders in ${MO.city}. Plan searches for people worth inviting.

What the network is short on right now (from Co, general terms):
${gaps.map((g) => `- ${g.gap} (${g.members} members)`).join("\n") || "- (nothing open; use founders, designers and engineers building early-stage products)"}
${room ? `\nWho the guests already coming to ${room.event} would most want to meet (put these ahead of the network's gaps):\n${room.gaps.map((g) => `- ${g.gap} (${g.members})`).join("\n")}\n` : ""}
${focus.length ? `\nThe team asked you to look for (put these first):\n${focus.map((f) => `- ${f}`).join("\n")}\n` : ""}
${lessons.length ? `\nWhat's worked with people you invited before (lean this way):\n${lessons.map((l) => `- ${l}`).join("\n")}\n` : ""}
${w.event ? `\nNext Co event: ${w.event}` : ""}

Write 3 X recent-search queries that find people posting about doing these things themselves in ${MO.city} (use X operators, e.g. ("building" OR "shipping") ("SF" OR "San Francisco") design), 1 web search query for public LinkedIn profiles starting with site:linkedin.com/in, and the 3 themes (a few words each) the searches are for.

Return ONLY JSON: {"x": ["..."], "linkedin": "site:linkedin.com/in ...", "themes": ["..."]}`,
  });
  const p = parseModelJson<Partial<Queries>>(text);
  return {
    x: (p.x ?? []).filter((q) => typeof q === "string" && q.length < 400 && queryIsSafe(q, w)).slice(0, 3),
    linkedin: typeof p.linkedin === "string" && p.linkedin.startsWith("site:linkedin.com/in") && queryIsSafe(p.linkedin, w) ? p.linkedin.slice(0, 300) : null,
    themes: (p.themes ?? []).filter((t) => typeof t === "string").slice(0, 3),
  };
}

// Whichever DM style has gone to fewer prospects, so both get a fair test.
// The least-used opener so far, so each gets a fair share (draft.ts OPENERS).
async function nextOpener(): Promise<OpenerId> {
  const { rows } = await pool
    .query(`SELECT opener, count(*)::int AS n FROM mo_prospects WHERE opener IS NOT NULL GROUP BY opener`)
    .catch(() => ({ rows: [] as any[] }));
  const count = (o: OpenerId) => rows.find((r: any) => r.opener === o)?.n ?? 0;
  return [...OPENER_IDS].sort((a, b) => count(a) - count(b))[0];
}

async function nextDmStyle(): Promise<DmStyle> {
  const { rows } = await pool
    .query(`SELECT dm_style, count(*)::int AS n FROM mo_prospects WHERE dm_style IS NOT NULL GROUP BY dm_style`)
    .catch(() => ({ rows: [] as any[] }));
  const count = (s: DmStyle) => rows.find((r: any) => r.dm_style === s)?.n ?? 0;
  return count("curious") < count("intro") ? "curious" : "intro";
}

type Judged = { index: number; fit: boolean; reason: string; quote: string; inCity?: boolean };

export async function judge(posts: MoPost[], themes: string[], event: string | null): Promise<Judged[]> {
  if (!posts.length) return [];
  const { moLessons } = await import("./learn.js");
  const lessons = await moLessons().catch(() => [] as string[]);
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    providerOptions: { anthropic: { effort: "low" } },
    experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "mo.judge" },
    prompt: `Co is a private, invite-only club in ${MO.city} for people who build things and show up for others. You're deciding who is genuinely worth a personal invitation.

What the club is looking for: ${themes.join("; ") || "founders, designers, engineers building early products"}
${event ? `Next Co event: ${event}` : ""}
${lessons.length ? `What's predicted people taking to the club before: ${lessons.join("; ")}` : ""}

Posts (one per person):
${posts.map((p, i) => `[${i}] @${p.author.username} (${p.author.name}; location: ${p.author.location ?? "none"}; bio: ${(p.author.description ?? "").slice(0, 160)})\n${p.text.slice(0, 500)}`).join("\n\n")}

Keep only people whose own post shows they're doing something specific that fits (building, hosting, looking for collaborators), not promoters, recruiters, bots, threads of generic advice, or companies. For each person, give "reason": one plain sentence on why they'd fit, in terms of what THEY posted (no names of anyone else; refer to them by name or "they", never "he" or "she"); "quote": 4 to 20 words copied exactly from their post that show it; and "inCity": true only if they, or the thing they're doing, are actually in ${MO.city} (a passing mention like "after my trip to SF" doesn't count).

Return ONLY JSON: {"people": [{"index": 0, "fit": true, "reason": "...", "quote": "...", "inCity": true}]}`,
  });
  return (parseModelJson<{ people?: Judged[] }>(text).people ?? []).filter((j) => j && typeof j.index === "number");
}

async function alreadyKnown(keys: string[], xUserId: string | null, linkedinUrl: string | null): Promise<boolean> {
  const [supp, prospect] = await Promise.all([
    keys.length ? pool.query(`SELECT 1 FROM mo_suppression WHERE key = ANY($1::text[]) LIMIT 1`, [keys]) : Promise.resolve({ rows: [] as any[] }),
    pool.query(`SELECT 1 FROM mo_prospects WHERE (x_user_id IS NOT NULL AND x_user_id = $1) OR (linkedin_url IS NOT NULL AND linkedin_url = $2) LIMIT 1`, [xUserId, linkedinUrl]),
  ]);
  return Boolean(supp.rows[0] || prospect.rows[0]);
}

// LinkedIn through web search only: what the results page shows. No login,
// no profile scraping. People found here are contacted by hand.
type LinkedinPerson = { name: string; headline: string; snippet: string; location: string; url: string; reason: string; quote: string };
async function linkedinCandidates(query: string, themes: string[]): Promise<LinkedinPerson[]> {
  const budget = await reserveWebSearch(null, "sweep", query);
  if (!budget.ok) return [];
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 2 }) },
    stopWhen: stepCountIs(3),
    timeout: 60_000,
    experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "mo.linkedin" },
    prompt: `Run this web search: ${query}

From the search results only (don't open or log into LinkedIn), list up to 4 people in ${MO.city} whose headline or snippet shows they fit: ${themes.join("; ")}. For each: "name", "headline" (as shown), "snippet" (the result's text as shown, copied exactly), "location" (as shown, or ""), "url" (their linkedin.com/in/ link as shown), "reason" (one plain sentence; their name or "they", never "he" or "she"), and "quote" (4 to 20 words copied exactly from the headline or snippet).

Return ONLY JSON: {"people": [...]}`,
  });
  const people = parseModelJson<{ people?: any[] }>(text).people ?? [];
  return people
    .filter((p) => p && typeof p.url === "string" && /^https:\/\/([a-z]+\.)?linkedin\.com\/in\//i.test(p.url) && typeof p.headline === "string")
    .map((p) => ({
      name: String(p.name ?? "").slice(0, 80),
      headline: String(p.headline).slice(0, 240),
      snippet: String(p.snippet ?? "").slice(0, 600),
      location: String(p.location ?? "").slice(0, 80),
      url: p.url.replace(/\/+$/, ""),
      reason: neutralPronouns(String(p.reason ?? "").slice(0, 240)),
      quote: String(p.quote ?? ""),
    }));
}

export async function runMoFind(): Promise<{ shortlisted: number }> {
  // Paused by the team ("Mo, pause"): no new searches (mo/team.ts).
  const { isMoPaused } = await import("./team.js");
  if (await isMoPaused()) return { shortlisted: 0 };
  const checks: GateCheck[] = [];
  const w = await clubWants();
  await loadMemberNames();
  const q = await planQueries(w);
  let shortlisted = 0;

  // X
  const byAuthor = new Map<string, MoPost>();
  for (const query of q.x) {
    const budget = await reserveXSearch(null, "sweep", `mo: ${query}`);
    if (!budget.ok) {
      checks.push({ name: "x_budget", pass: false, reason: budget.reason ?? "over budget" });
      break;
    }
    const posts = await searchPostsWithAuthors(query, 25).catch((err: any) => {
      checks.push({ name: "x_search", pass: false, reason: String(err?.message ?? err).slice(0, 200) });
      return [];
    });
    for (const p of posts) if (!byAuthor.has(p.author.id)) byAuthor.set(p.author.id, p);
  }
  const inSf = [...byAuthor.values()].filter((p) => inCity(p.author.location, p.text)).slice(0, 80);
  checks.push({ name: "x_candidates_in_city", pass: true, reason: `${inSf.length} of ${byAuthor.size}` });
  // Jev drops the clear no's first (mo/jev.ts), so Claude reads only the
  // plausible ones; without Jev, Claude reads the first 25 as before.
  const screened = await screenPosts(inSf);
  if (screened.jevUsed) checks.push({ name: "jev_screen", pass: true, reason: `kept ${screened.keep.length} of ${inSf.length} in ${screened.ms}ms` });
  const posts = screened.keep.slice(0, 25);
  const judged = await judge(posts, q.themes, w.event).catch(() => [] as Judged[]);
  for (const j of judged) {
    if (shortlisted >= MO.shortlistPerRun) break;
    const p = posts[j.index];
    if (!p || !j.fit) continue;
    if (!quoteIsTheirs(j.quote, p.text)) {
      checks.push({ name: "quote_is_theirs", pass: false, reason: `@${p.author.username}: "${j.quote.slice(0, 60)}"` });
      continue;
    }
    if (!placeOk(p.author.location, j.inCity)) {
      checks.push({ name: "in_city", pass: false, reason: `@${p.author.username}: location "${p.author.location ?? "none"}", judge inCity=${j.inCity}` });
      continue;
    }
    if (await alreadyKnown(suppressionKeys({ x_user_id: p.author.id }), p.author.id, null)) continue;
    j.reason = neutralPronouns(j.reason);
    const style = await nextDmStyle();
    const opener = await nextOpener();
    const drafts = await draftOutreach({ name: p.author.name, handle: p.author.username, postText: p.text, reason: j.reason, event: w.event, source: "x", style, opener });
    if (!drafts.ok) {
      checks.push({ name: "drafts_pass", pass: false, reason: `@${p.author.username}: ${drafts.failed.join(", ")}` });
      continue;
    }
    await pool.query(
      `INSERT INTO mo_prospects (source, x_user_id, x_handle, name, bio, location, post_id, post_url, post_text, reason, evidence_quote, draft_reply, draft_dm, draft_email_subject, draft_email_body, dm_style, draft_why, opener, invited_for)
       VALUES ('x', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) ON CONFLICT DO NOTHING`,
      [p.author.id, p.author.username, p.author.name, p.author.description, p.author.location, p.id, p.url, p.text, j.reason, j.quote, drafts.reply, drafts.dm, drafts.emailSubject, drafts.emailBody, style, drafts.why, opener, w.event],
    );
    shortlisted++;
  }

  // LinkedIn (web search results only)
  if (q.linkedin && shortlisted < MO.shortlistPerRun) {
    const people = await linkedinCandidates(q.linkedin, q.themes).catch(() => []);
    for (const li of people) {
      if (shortlisted >= MO.shortlistPerRun) break;
      // The quote must come from what the result showed (headline or
      // snippet); the place from the result's own location or text.
      const shown = `${li.headline} ${li.snippet}`;
      if (!quoteIsTheirs(li.quote, shown) || !(locationInCity(li.location) || (!li.location && inCity(null, shown)))) {
        checks.push({ name: "linkedin_grounded", pass: false, reason: li.url });
        continue;
      }
      if (await alreadyKnown(suppressionKeys({ linkedin_url: li.url }), null, li.url)) continue;
      const style = await nextDmStyle();
      const opener = await nextOpener();
      const drafts = await draftOutreach({ name: li.name, handle: null, postText: shown, reason: li.reason, event: w.event, source: "linkedin", style, opener });
      if (!drafts.ok) continue;
      await pool.query(
        // post_text keeps what the result actually showed (headline and
        // snippet), not the headline alone: the drafts were checked against
        // both, so a later redraft (an approver's edit) needs both too
        // (2026-09-24: "Build Bar" came from the snippet and a redraft was
        // rejected as inventing it).
        `INSERT INTO mo_prospects (source, name, linkedin_url, headline, post_text, reason, evidence_quote, draft_dm, draft_email_subject, draft_email_body, channel, dm_style, draft_why, opener, invited_for)
         VALUES ('linkedin', $1, $2, $3, $11, $4, $5, $6, $7, $8, NULL, $9, $10, $12, $13) ON CONFLICT DO NOTHING`,
        [li.name, li.url, li.headline, li.reason, li.quote, drafts.dm, drafts.emailSubject, drafts.emailBody, style, drafts.why, shown, opener, w.event],
      );
      shortlisted++;
    }
  }

  await recordDecision({
    layer: 5,
    decision: "mo.find",
    userId: null,
    outcome: shortlisted ? "act" : "skip",
    action: `shortlisted ${shortlisted}`,
    proposal: { themes: q.themes, xQueries: q.x, linkedin: q.linkedin, event: w.event },
    checks,
  });
  return { shortlisted };
}
