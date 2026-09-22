// A live reply that names one specific event ("What's going on at AfroTech?", "What about
// Figcon this year?") gets one web lookup for that event's own page (Royce, 2026-09-21).
//
// The web search is otherwise the sweep's, not a live reply's: it was the slowest and flakiest
// part of a reply (2026-09-18). This is the narrow exception. It runs only when the public
// Luma search already found nothing, only for an ask that names one event, once, with a time
// cap and the same web budget the sweep uses. What it finds goes through the same gate as
// every web result: the page is read here and checked against the reason, and a date already
// past is turned away.
import { generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { eventLookupFromModel, isTicketingHost, namedEventFromModel } from "./searchRules.js";
import { looksOfficial, pageExcerpt, readPageText, reserveWebSearch } from "./webOpportunitySearch.js";
import { checkGrounding } from "../harness/matchGate.js";
import type { TierMatch } from "./tieredRecommendation.js";

const LOOKUP_TIMEOUT_MS = 15_000;

export type NamedEventResult = { match: (TierMatch & { tier: 3 }) | null; name: string | null; blocked: string | null; rejected: string | null };

const NOTHING: NamedEventResult = { match: null, name: null, blocked: null, rejected: null };

async function extractNamedEvent(askText: string): Promise<string | null> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      experimental_telemetry: { isEnabled: true, functionId: "namedEventLookup.extract" },
      timeout: 6_000,
      prompt: `Does this message ask about ONE specific, named event, conference, festival or week (for example "AfroTech", "Figma Config", "SXSW", "SF Tech Week")? A kind of event ("a founder mixer", "hackathons", "a fireside chat") is not a named event.

Message: "${askText}"

Return the name exactly as they wrote it. Return ONLY JSON: {"name": "AfroTech"} or {"name": null}`,
    });
    return namedEventFromModel(parseModelJson(text), askText);
  } catch {
    return null;
  }
}

export async function lookupNamedEvent(
  askText: string,
  city: string | null,
  todayStr: string,
  opts: { userId: string | null; source: "sweep" | "request" },
): Promise<NamedEventResult> {
  const name = await extractNamedEvent(askText);
  if (!name) return NOTHING;
  const budget = await reserveWebSearch(opts.userId, opts.source, `named event: ${name}`);
  if (!budget.ok) return { ...NOTHING, name, blocked: budget.reason ?? "web search budget" };
  try {
    const { text: raw } = await generateText({
      model: anthropic(MODELS.sonnet),
      experimental_telemetry: { isEnabled: true, functionId: "namedEventLookup.search" },
      // Same tool version the opportunity search uses; the newer one hung (2026-09-18).
      tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 2 }) },
      stopWhen: stepCountIs(3),
      timeout: LOOKUP_TIMEOUT_MS,
      prompt: `Someone asked: "${askText}"${city ? ` (they're based in ${city})` : ""}
Today's date: ${todayStr}

They named "${name}" (it may be shorthand, an abbreviation or loosely spelled, like "figcon" for Figma's Config). Find that event's own official page for its next edition (or the one happening now): the organizer's own site, or its own ticketing page. Not a news story, blog, or listicle.

If it exists, say in "reason" what it is and where it is in one plain sentence, from what the page says. Put NO numbers or dates in "reason"; give the dates in "start" and "end" (YYYY-MM-DD, or null if the page doesn't state them). If you can't find it, or its latest edition is already over, return {"found": false}.

Return ONLY valid JSON: {"found": true, "name": "...", "url": "the page you actually read", "reason": "...", "start": "YYYY-MM-DD" or null, "end": "YYYY-MM-DD" or null} or {"found": false}`,
    });
    const found = eventLookupFromModel(parseModelJson(raw));
    if (!found) return { ...NOTHING, name, rejected: "the web lookup found no official page" };
    if (!looksOfficial(found.url, found.name) && !isTicketingHost(found.url)) {
      return { ...NOTHING, name, rejected: `not the event's own page: ${found.url}` };
    }
    const page = await readPageText(found.url);
    const dates = found.start ? `${found.start}${found.end && found.end !== found.start ? ` to ${found.end}` : ""}` : null;
    const match: TierMatch & { tier: 3 } = {
      tier: 3,
      kind: "opportunity",
      source: "web",
      name: found.name,
      url: found.url,
      reason: found.reason,
      category: "event",
      ...(found.start ? { statedDates: { start: found.start, end: found.end } } : {}),
      ...(page ? { evidence: page, opportunity: { postText: `${pageExcerpt(page, { name: found.name, reason: found.reason })}${dates ? ` Dates found: ${dates}.` : ""}` } } : {}),
    };
    // The same page check every web result gets; an unreadable page can't back a claim.
    const grounded = checkGrounding(match, { searchCity: null, distanceMiles: null, alreadyOffered: false, now: new Date(), evidence: match.evidence ?? null });
    if (!grounded.pass) return { ...NOTHING, name, rejected: grounded.reason ?? "the page doesn't back the result" };
    return { match, name, blocked: null, rejected: null };
  } catch (err: any) {
    console.error("namedEventLookup: lookup failed (non-fatal):", err?.message ?? err);
    return { ...NOTHING, name, rejected: "the web lookup failed or timed out" };
  }
}
