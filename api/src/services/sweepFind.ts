// The daily sweep's finding, in Co's own loop (2026-10-01: "one way of finding
// things"). For one member's open ask, Co uses the same tools as its replies
// (event search with Co's events, the public feed and openings; verified web
// search; recent X posts; page reads) and keeps up to three things worth texting
// them about, each with its reason. No search brief, no relevance gate, no
// separate fit read: Co judges with the whole person in view. Code guards facts
// only, through the same gate as before (sold out, past, too far, the name and
// any date on the thing's own record).
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { getPersonSnapshot, renderSnapshot } from "../harness/personSnapshot.js";
import { gateMatches } from "../harness/matchGate.js";
import { eventCandidates, reserveXSearch, type TierMatch } from "./tieredRecommendation.js";
import { sealedTelemetry } from "./privateTurn.js";

export const SWEEP_BUDGET = { steps: 7, webQueries: 2, xSearches: 1, pageReads: 3, keep: 3 };

export type SweepCandidate = { userId: string; firstName: string; askText: string; fromProfile?: boolean; city: string | null; goals?: string[] | null };

export function sweepPrompt(c: SweepCandidate, o: { today: string; picture: string; feeling: string | null; shown: string[] }): string {
  return `You're Co, finding things worth texting ${c.firstName} about over the next couple of weeks. Nothing is sent now: what you keep goes into a queue, and Co texts at most one a day, so keep only what genuinely fits.

${c.fromProfile ? "They haven't asked for something specific; this is what they've shared they want" : "What they asked Co to keep an eye out for"}: "${c.askText}"
Where they are: ${c.city ?? "unknown"}. Today: ${o.today}.
What you know about them:
${o.picture || "(little known yet)"}${o.feeling ? `\nHow they've been: ${o.feeling} (this shapes how Co says it, never whether they hear about something)` : ""}
Already sent to them recently (don't keep these again): ${o.shown.length ? o.shown.slice(0, 15).join("; ") : "(nothing)"}

Search only for this one ask. Other things they're working on (in who they are) are context for judging fit, not things to look for in this sweep, because each ask gets its own sweep (2026-10-01: a founder-events sweep kept a venue from another ask).
Who a thing is for matters. Read each one for the group it speaks to (a hike club for women, a men's group, a moms' brunch) and say it in the audience field of keep. Never hold something back for who you assume they are: you only know what they have said in their own words, never from a name or a voice. A group-aimed thing fits them when what you know says they belong; when you don't know, you may still keep it if it fits strongly, and Co will say plainly who it's for so they can tell. Prefer an open event when two fit about equally.

Look with the tools: events first when it's something to go to, the web for programs, places and people, X for something just announced. Judge each result yourself against what they asked and who they are; results are candidates, not answers. Keep at most ${SWEEP_BUDGET.keep} with keep(), each with one plain sentence on why it fits them. Keeping nothing is fine when nothing fits. Stop when you're done.`;
}

export async function sweepFind(c: SweepCandidate, opts: { timezone?: string | null; feeling?: string | null; shown?: string[] } = {}): Promise<{ matches: TierMatch[]; did: string[] }> {
  const did: string[] = [];
  const found = new Map<string, TierMatch>();
  const kept: TierMatch[] = [];
  let webQueries = 0;
  let xSearches = 0;
  let reads = 0;
  // The one model of them (services/personModel.ts).
  const picture = await import("./personModel.js").then((m) => m.personModel(c.userId, { maxDid: 5 })).catch(() => renderSnapshot(null));
  const tools = {
    searchEvents: tool({
      description: "Co's own events, the public event feed, and openings Co already found, in the days you name. Put `when` in plain words (\"next two weeks\", \"this weekend\").",
      inputSchema: z.object({ what: z.string(), when: z.string().optional() }),
      execute: async ({ what, when }) => {
        did.push(`events: ${what}${when ? `, ${when}` : ""}`);
        const [r, openings] = await Promise.all([
          eventCandidates(what, c.city, { when: when ?? null, userId: c.userId, timezone: opts.timezone ?? null, limit: 8 }),
          import("./eventSurfacingSweep.js").then((m) => m.alreadyFoundOpenings(c.userId)).catch(() => [] as TierMatch[]),
        ]);
        for (const { match } of r.candidates) if ("url" in match && match.url) found.set(match.url, match);
        for (const m of openings) if ("url" in m && m.url) found.set(m.url, m);
        return {
          events: r.candidates.map(({ match, lines }) => ({ link: "url" in match ? match.url : null, details: lines })),
          openings: openings.slice(0, 4).map((m) => ({ link: (m as any).url, name: m.name, details: m.reason })),
          note: r.inWindow < 4 ? "The feed is thin here; webSearch may find more." : undefined,
        };
      },
    }),
    webSearch: tool({
      description: `Search the web; results come back checked against their own pages. Up to ${SWEEP_BUDGET.webQueries} short queries in all.`,
      inputSchema: z.object({ queries: z.array(z.string()).min(1).max(2) }),
      execute: async ({ queries }) => {
        const run = queries.slice(0, SWEEP_BUDGET.webQueries - webQueries);
        if (!run.length) return { ok: false, error: "No web searches left." };
        webQueries += run.length;
        did.push(...run.map((q) => `web: ${q}`));
        const { taskWebSearch } = await import("./taskWeb.js");
        const all = await Promise.all(run.map((q) => taskWebSearch(c.userId, q, { city: c.city, zone: opts.timezone ?? null, source: "sweep" }).catch(() => null)));
        const { checkVerified } = await import("./factCheck.js");
        const kept = (await checkVerified(all.flatMap((r) => r?.kept ?? [])).catch(() => ({ kept: all.flatMap((r) => r?.kept ?? []) }))).kept;
        for (const k of kept) {
          const facts = [...k.facts, ...(k.date ? [`date: ${k.date}`] : [])].join("; ");
          found.set(k.url, { tier: 3, kind: "opportunity", source: "web", name: k.name, url: k.url, reason: facts || k.name, evidence: `${k.name}. ${facts}`, ...(k.date ? { statedDates: { start: k.date } } : {}), ...(k.deadline ? { deadline: k.deadline } : {}) } as unknown as TierMatch);
        }
        if (all.every((r) => r && /^No web search right now/.test(r.note))) return { ok: false, error: "Web search budget is used up for today." };
        return { results: kept.map((k) => ({ link: k.url, name: k.name, facts: k.facts, date: k.date, deadline: k.deadline })) };
      },
    }),
    searchPosts: tool({
      description: "Recent X posts (last week) for something just announced. 2 to 4 keywords, OR for real synonyms; no city.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        if (xSearches >= SWEEP_BUDGET.xSearches) return { ok: false, error: "No X searches left." };
        xSearches++;
        const budget = await reserveXSearch(c.userId, "sweep", query);
        if (!budget.ok) return { ok: false, error: `X search unavailable (${budget.reason ?? "budget"}).` };
        did.push(`x: ${query}`);
        const { searchRecentPosts } = await import("./xSearch.js");
        const posts = await searchRecentPosts(query.slice(0, 120), 10).catch(() => []);
        for (const p of posts) found.set(p.url, { tier: 3, kind: "opportunity", source: "x", name: p.text.slice(0, 80), url: p.url, reason: p.text, evidence: p.text } as unknown as TierMatch);
        return { posts: posts.map((p) => ({ link: p.url, text: p.text.slice(0, 500) })) };
      },
    }),
    readPage: tool({
      description: "Read a page to confirm a detail.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        if (reads >= SWEEP_BUDGET.pageReads) return { ok: false, error: "No page reads left." };
        reads++;
        const { readPageText } = await import("./webOpportunitySearch.js");
        const text = await readPageText(url).catch(() => null);
        const m = found.get(url) as any;
        if (text && m && m.tier === 3) m.evidence = `${m.evidence ?? ""} ${text.slice(0, 3000)}`;
        return text ? { text: text.slice(0, 5000) } : { ok: false, error: "Couldn't read it." };
      },
    }),
    keep: tool({
      description: "Keep one thing for the queue: its link (from a result), the name of the thing as its record states it, and one plain sentence on why it fits them.",
      inputSchema: z.object({ link: z.string(), name: z.string().optional(), why: z.string(), audience: z.string().optional().describe("Only if the thing is aimed at a particular group (women, men, moms, a community): who, in a few words. Leave out when it is open to everyone.") }),
      execute: async ({ link, name, why, audience }) => {
        const m = found.get(link);
        if (!m) return { ok: false, error: "That link isn't one of your results." };
        if (kept.length >= SWEEP_BUDGET.keep) return { ok: false, error: "That's enough for this sweep." };
        kept.push({ ...m, ...(name && m.tier === 3 ? { name } : {}), whyItFits: why.trim(), fits: true, rightKind: true, ...(audience && audience.trim() ? { audience: audience.trim().slice(0, 60) } : {}) } as TierMatch);
        return { ok: true };
      },
    }),
  };
  try {
    await generateText({
      model: anthropic(MODELS.sonnet),
      maxOutputTokens: 4000,
      providerOptions: { anthropic: { effort: "low" } },
      tools,
      stopWhen: stepCountIs(SWEEP_BUDGET.steps),
      experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "sweep.find", metadata: { userId: c.userId } },
      prompt: sweepPrompt(c, { today: new Date().toISOString().slice(0, 10), picture, feeling: opts.feeling ?? null, shown: opts.shown ?? [] }),
    });
  } catch (err: any) {
    console.error("sweepFind: the loop failed (non-fatal):", err?.message ?? err);
  }
  // Facts only: sold out, past, too far, and a name/date the record actually states.
  const gated = await gateMatches(kept, { userId: c.userId, searchCity: c.city, checkRepeat: false, zone: opts.timezone ?? null }).catch(() => kept);
  await recordDecision({ layer: 5, decision: "sweep.find", userId: c.userId, outcome: gated.length ? "act" : "skip", action: `kept ${gated.length}`, proposal: { ask: c.askText.slice(0, 200), did, kept: kept.map((m) => m.name), passedGate: gated.map((m) => m.name) } }).catch(() => {});
  return { matches: gated, did };
}
