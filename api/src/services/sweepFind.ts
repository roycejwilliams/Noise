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
import { gateMatches, type GatedOut } from "../harness/matchGate.js";
import { eventCandidates, reserveXSearch, type TierMatch } from "./tieredRecommendation.js";
import { memberTerms, QueryLedger, SWEEP_QUERY_RULES } from "./sweepQuery.js";

export const SWEEP_BUDGET = { steps: 7, webQueries: 2, xSearches: 1, pageReads: 3, keep: 3 };

// X in the sweep (2026-10-07). After the old Tier 3 pipeline went (6f1530b),
// X was one optional tool and the model wrote literal queries ("Peerspace NoPa
// venue"): 10 of 17 searches came back empty, the rest spam, and nothing from X
// was kept after 2026-09-28. This puts back what the old pipeline's query step
// knew (proposeOpportunityQuery): search X once for the asks X covers, written
// the way such posts are written, with OR for the words people post with. Co
// still decides; this is guidance, not a rule in code.
export const SWEEP_X_GUIDANCE = `X is where programs and gatherings are announced first. When the ask is one X covers (a program, cohort, accelerator, fellowship, residency or grant taking applications; an open call or a speaking or demo slot; founder or builder gatherings; investors or people looking for exactly what they want), search X once in this sweep. Write the query the way those posts are written, not the way they asked: the kind of thing, with OR for the real words people post with, grouped in parentheses, for example (accelerator OR cohort OR fellowship) (applications open OR now accepting OR apply). Keep it broad: two groups, the kind of thing and how it's announced, and a third only for a stage or field posts would carry (pre-seed, AI, fintech); never four. Their niche words make it come back empty; you judge the 20 posts that come back. Leave out their city and any year they didn't say, because posts rarely name either and those words make you miss them. Don't use X for venues, vendors, services or plain things to do; posts don't list those. And don't spend it on something that isn't a thing to find at all (a plan or draft Co owes them, a status, a deal they're working on): skip X for that sweep.`;

// Every place Co can look, named in the brief (2026-10-08: sweeps ended without
// ever looking at Co's own events for an event-shaped ask). Guidance, not a
// forced call: Co still picks the tools.
export const SWEEP_TIERS = `Where you can look, in order: (1) Co's own events and (2) the public event feed and openings Co already found, both through searchEvents; (3) the web (webSearch) and X (searchPosts) for programs, places and people. When the ask is something to go to or join (an event, a dinner, a meetup, a class, a community gathering), look at searchEvents before you finish, even if you expect it thin: Co's own events come first when they fit.`;

// What Co looked at and passed over, for the log (sweep.find), so "why did
// nothing from X go out" can be answered from the record.
export const SWEEP_PASS_TOOL =
  "Note what you looked at closely and decided against, each with its link and a few words on why (wrong kind, already past, spam or promotion, not for them, too far). Call it once, alongside your keeps, when you're done. Nothing is sent; it's how Co's choices are reviewed.";
export const PASSED_OVER_CAP = 10;

// query: the search that brought it back (the tuning log: which phrasings produce keeps, 2026-10-08).
export type LookedAt = { source: "x" | "web" | "events"; name: string; url: string; query?: string };
export type PassedOver = LookedAt & { why: string };

// Everything looked at but not kept, X first then web then events, with Co's
// reason when it gave one, else the gate's, else "not kept". Pure.
export function passedOver(lookedAt: LookedAt[], keptUrls: Set<string>, reasons: Map<string, string>, cap = PASSED_OVER_CAP): PassedOver[] {
  const order = { x: 0, web: 1, events: 2 } as const;
  const seen = new Set<string>();
  return lookedAt
    .filter((l) => !keptUrls.has(l.url) && !seen.has(l.url) && seen.add(l.url))
    .sort((a, b) => order[a.source] - order[b.source] || Number(reasons.has(b.url)) - Number(reasons.has(a.url)))
    .slice(0, cap)
    .map((l) => ({ source: l.source, name: l.name.slice(0, 80), url: l.url, why: (reasons.get(l.url) ?? "not kept").slice(0, 120), ...(l.query ? { query: l.query } : {}) }));
}

// An X search that failed, said by kind and status only (never the response
// body or a token), for the log and for Co.
export function xFailure(err: unknown): { kind: "not_configured" | "auth" | "rate_limited" | "server" | "error"; status: number | null } {
  const msg = String((err as any)?.message ?? err ?? "");
  if (/not configured/i.test(msg)) return { kind: "not_configured", status: null };
  const m = msg.match(/\((\d{3})\)/);
  const status = m ? Number(m[1]) : null;
  if (status === 401 || status === 403) return { kind: "auth", status };
  if (status === 429) return { kind: "rate_limited", status };
  if (status !== null && status >= 500) return { kind: "server", status };
  return { kind: "error", status };
}

// What Co is told when X failed: not "no posts", which reads as "nothing out there".
export function xFailedNote(f: ReturnType<typeof xFailure>): string {
  const why = f.kind === "rate_limited" ? "X is rate limiting us right now" : f.kind === "auth" || f.kind === "not_configured" ? "Co's X access isn't working right now" : "X didn't answer";
  return `The X search failed (${why}), so there are no posts to judge. This says nothing about whether posts exist. Use webSearch for this ask instead.`;
}

export const SWEEP_X_TOOL =
  "Recent X posts (the last 7 days), for what's announced there first: programs and cohorts taking applications, open calls, fellowships, residencies, grants, founder or builder gatherings, investors or people looking for what they want. One search a sweep. Write it the way such posts are written, broad: two or three OR-grouped sets of synonyms in parentheses, e.g. (accelerator OR cohort OR fellowship) (applications open OR now accepting OR apply by). No niche words, no city, no year, no venue or vendor names. Each post comes with its own links expanded; when a post points to the program's own page, keep that link rather than the post.";

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

Look with the tools: events first when it's something to go to, the web for programs, places and people. ${SWEEP_TIERS} ${SWEEP_X_GUIDANCE}
${SWEEP_QUERY_RULES}
Judge each result yourself against what they asked and who they are; results are candidates, not answers. Everything you keep goes to a member of a private club, so it has to be real and worth their time: a named thing with a way in (who runs it, how to apply or join), never a token or coin promotion, a giveaway, engagement bait or a bare headline. Keep at most ${SWEEP_BUDGET.keep} with keep(), each with one plain sentence on why it fits them. Keeping nothing is fine when nothing fits. When you're done, note in skip() the results you looked at and passed on, each with a few words on why, in the same step as your keeps. Then stop.`;
}

export async function sweepFind(c: SweepCandidate, opts: { timezone?: string | null; feeling?: string | null; shown?: string[] } = {}): Promise<{ matches: TierMatch[]; did: string[] }> {
  const did: string[] = [];
  const found = new Map<string, TierMatch>();
  const kept: TierMatch[] = [];
  let webQueries = 0;
  let xSearches = 0;
  let xPosts = 0;
  let reads = 0;
  // What Co looked at (for the log), its reasons for passing, and any X failure.
  const lookedAt: LookedAt[] = [];
  const passReasons = new Map<string, string>();
  let xError: ReturnType<typeof xFailure> | null = null;
  // Every query, run or refused (sweepQuery.ts): the member never in it, simple, phrased for its source; logged with its outcomes.
  const ledger = new QueryLedger(memberTerms({ firstName: c.firstName, goals: c.goals ?? [], except: c.askText }), c.askText);
  // A page kept in place of the post that pointed to it: the post counts as kept too.
  const postOf = new Map<string, string>();
  // The one model of them (services/personModel.ts).
  const picture = await import("./personModel.js").then((m) => m.personModel(c.userId, { maxDid: 5 })).catch(() => renderSnapshot(null));
  const tools = {
    searchEvents: tool({
      description: "Co's own events, the public event feed, and openings Co already found, in the days you name. Put `when` in plain words (\"next two weeks\", \"this weekend\").",
      inputSchema: z.object({ what: z.string(), when: z.string().optional() }),
      execute: async ({ what, when }) => {
        const bad = ledger.check("events", what);
        if (bad.length) return { ok: false, error: ledger.refusal(what, bad) };
        did.push(`events: ${what}${when ? `, ${when}` : ""}`);
        const [r, openings] = await Promise.all([
          eventCandidates(what, c.city, { when: when ?? null, userId: c.userId, timezone: opts.timezone ?? null, limit: 8 }),
          import("./eventSurfacingSweep.js").then((m) => m.alreadyFoundOpenings(c.userId)).catch(() => [] as TierMatch[]),
        ]);
        for (const { match } of r.candidates) if ("url" in match && match.url) {
          found.set(match.url, match);
          lookedAt.push({ source: "events", name: match.name, url: match.url, query: what });
        }
        ledger.ran("events", what, r.candidates.length);
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
      execute: async ({ queries: asks }) => {
        const refusals: string[] = [];
        const good = asks.filter((q) => {
          const bad = ledger.check("web", q);
          if (bad.length) refusals.push(ledger.refusal(q, bad));
          return !bad.length;
        });
        if (!good.length) return { ok: false, error: refusals.join(" ") };
        const run = good.slice(0, SWEEP_BUDGET.webQueries - webQueries);
        if (!run.length) return { ok: false, error: "No web searches left." };
        webQueries += run.length;
        did.push(...run.map((q) => `web: ${q}`));
        const { taskWebSearch } = await import("./taskWeb.js");
        const all = await Promise.all(run.map((q) => taskWebSearch(c.userId, q, { city: c.city, zone: opts.timezone ?? null, source: "sweep" }).catch(() => null)));
        const { checkVerified } = await import("./factCheck.js");
        const kept = (await checkVerified(all.flatMap((r) => r?.kept ?? [])).catch(() => ({ kept: all.flatMap((r) => r?.kept ?? []) }))).kept;
        run.forEach((q, i) => ledger.ran("web", q, all[i]?.kept?.length ?? 0));
        const queryOf = new Map<string, string>();
        run.forEach((q, i) => { for (const k of all[i]?.kept ?? []) if (!queryOf.has(k.url)) queryOf.set(k.url, q); });
        for (const k of kept) {
          const facts = [...k.facts, ...(k.date ? [`date: ${k.date}`] : [])].join("; ");
          lookedAt.push({ source: "web", name: k.name, url: k.url, query: queryOf.get(k.url) });
          found.set(k.url, { tier: 3, kind: "opportunity", source: "web", name: k.name, url: k.url, reason: facts || k.name, evidence: `${k.name}. ${facts}`, ...(k.date ? { statedDates: { start: k.date } } : {}), ...(k.deadline ? { deadline: k.deadline } : {}) } as unknown as TierMatch);
        }
        if (all.every((r) => r && /^No web search right now/.test(r.note))) return { ok: false, error: "Web search budget is used up for today." };
        return { results: kept.map((k) => ({ link: k.url, name: k.name, facts: k.facts, date: k.date, deadline: k.deadline })), ...(refusals.length ? { note: refusals.join(" ") } : {}) };
      },
    }),
    searchPosts: tool({
      description: SWEEP_X_TOOL,
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        if (xSearches >= SWEEP_BUDGET.xSearches) return { ok: false, error: "No X searches left." };
        const q = query.trim().slice(0, 200);
        const bad = ledger.check("x", q);
        if (bad.length) return { ok: false, error: ledger.refusal(q, bad) };
        xSearches++;
        const budget = await reserveXSearch(c.userId, "sweep", q);
        if (!budget.ok) return { ok: false, error: `X search unavailable (${budget.reason ?? "budget"}).` };
        did.push(`x: ${q}`);
        const { searchRecentPosts, X_SEARCH_RESULTS } = await import("./xSearch.js");
        let posts: Awaited<ReturnType<typeof searchRecentPosts>>;
        try {
          posts = await searchRecentPosts(q, X_SEARCH_RESULTS);
        } catch (err) {
          // Logged by kind and status, never swallowed into "no posts" (2026-10-08).
          xError = xFailure(err);
          console.error(`sweepFind: X search failed (${xError.kind}${xError.status ? `, status ${xError.status}` : ""}) for user ${c.userId}`);
          return { ok: false, error: xFailedNote(xError) };
        }
        xPosts += posts.length;
        ledger.ran("x", q, posts.length);
        for (const p of posts) {
          lookedAt.push({ source: "x", name: `${p.author ? `@${p.author}: ` : ""}${p.text.slice(0, 60)}`, url: p.url, query: q });
          const post = { tier: 3, kind: "opportunity", source: "x", name: p.text.slice(0, 80), url: p.url, reason: p.text, evidence: p.text } as unknown as TierMatch;
          found.set(p.url, post);
          // The page a post points to can be kept in its place, with the post as
          // its evidence. It's a web page to the gate (only x.com/i/status links
          // pass as posts), found through X.
          for (const l of p.links) {
            if (!postOf.has(l)) postOf.set(l, p.url);
            if (!found.has(l)) found.set(l, { ...post, source: "web", via: "x", url: l } as unknown as TierMatch);
          }
        }
        return {
          posts: posts.map((p) => ({ link: p.url, by: p.author ? `@${p.author}` : undefined, text: p.text.slice(0, 600), links: p.links.length ? p.links : undefined })),
          note: posts.length ? undefined : "No posts for that this week.",
        };
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
    skip: tool({
      description: SWEEP_PASS_TOOL,
      inputSchema: z.object({ passed: z.array(z.object({ link: z.string(), why: z.string() })).max(20) }),
      execute: async ({ passed }) => {
        for (const p of passed.slice(0, 20)) if (p.link && p.why?.trim()) passReasons.set(p.link, p.why.trim());
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
      experimental_telemetry: { isEnabled: true, functionId: "sweep.find", metadata: { userId: c.userId } },
      prompt: sweepPrompt(c, { today: new Date().toISOString().slice(0, 10), picture, feeling: opts.feeling ?? null, shown: opts.shown ?? [] }),
    });
  } catch (err: any) {
    console.error("sweepFind: the loop failed (non-fatal):", err?.message ?? err);
  }
  // Facts only: sold out, past, too far, and a name/date the record actually states.
  const gatedOut: GatedOut[] = [];
  const gated = await gateMatches(kept, { userId: c.userId, searchCity: c.city, checkRepeat: false, zone: opts.timezone ?? null, gatedOut }).catch(() => kept);
  // Kept but stopped by the fact gate: the gate's reason, unless Co gave one.
  for (const g of gatedOut) if (g.url && !passReasons.has(g.url)) passReasons.set(g.url, `kept, then the fact gate: ${g.reasons.join("; ")}`);
  const keptUrls = new Set(gated.flatMap((m) => ("url" in m && m.url ? [String(m.url), postOf.get(String(m.url)) ?? ""] : [])).filter(Boolean));
  const passed = passedOver(lookedAt, keptUrls, passReasons);
  // Each query beside what became of its results, and each keep with the query that found it (the tuning log, sweepQuery.ts).
  const { queries, keptBy } = ledger.finish(lookedAt, keptUrls, gated.map((m) => ({ name: m.name, url: "url" in m && m.url ? String(m.url) : "" })), postOf);
  const tried = { events: did.some((d) => d.startsWith("events: ")), web: did.some((d) => d.startsWith("web: ")), x: did.some((d) => d.startsWith("x: ")) };
  await recordDecision({ layer: 5, decision: "sweep.find", userId: c.userId, outcome: gated.length ? "act" : "skip", action: `kept ${gated.length}`, proposal: { ask: c.askText.slice(0, 200), did, tried, kept: kept.map((m) => m.name), passedGate: gated.map((m) => m.name), xPosts, xKept: gated.filter((m) => (m as any).source === "x" || (m as any).via === "x").length, ...(xError ? { xError } : {}), lookedAt: { x: lookedAt.filter((l) => l.source === "x").length, web: lookedAt.filter((l) => l.source === "web").length, events: lookedAt.filter((l) => l.source === "events").length }, passedOver: passed, queries, keptBy } }).catch(() => {});
  return { matches: gated, did };
}
