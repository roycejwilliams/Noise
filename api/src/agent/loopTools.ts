// The tools of Co's own loop (agent/loop.ts). Co chooses and chains them; code
// guards only facts: a link was really found, a fact is on its page, an email
// address was really seen, the turn's budget, and nothing is sent to anyone
// but the member (an email is a tap-to-send link they send themselves).
import { z } from "zod";
import { tool } from "ai";
import { toolUse } from "../services/capabilities.js";
import { writeMemory } from "../services/memory.js";
import { recordDecision } from "../harness/core.js";
import { recordRecommendationsSent } from "../services/recommendation.js";
import { eventCandidates, type TierMatch } from "../services/tieredRecommendation.js";
import { loadBrief, saveBrief, type SearchIntent } from "../services/searchIntent.js";
import { numbersBacked, placesBacked, unbackedClaims } from "../services/taskWeb.js";
import { LOOP_BUDGET } from "./loop.js";
import { stripUngroundedIdentity } from "../services/identityGuard.js";
import type { ConversationToolContext } from "./conversationTools.js";
import pool from "../db/db.js";
import sendblue from "../services/sendblue.js";
import { resolvePlan, planProblems, type EventRecord } from "../services/planSheet.js";

// What the loop has seen this turn: every link a tool returned, with the facts
// that came with it, and every page it read.
type Found = { name: string; url: string; facts: string; match: TierMatch | null; blocked: string | null };
export type LoopState = { started: number; found: Map<string, Found>; pages: Map<string, string>; holdSent: boolean; shared: string[]; webQueries: number };

// started: when their text arrived, so the time budget counts the turn's prep
// too (2026-10-01 code review); now when not known.
export function newLoopState(started = Date.now()): LoopState {
  return { started, found: new Map(), pages: new Map(), holdSent: false, shared: [], webQueries: 0 };
}

const HOLD_PREFIX = "Co is looking:"; // the same record line routes/sendblue.ts writes for a hold text
const emailsIn = (text: string) => [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))];

// A caption may only carry numbers, places and claims its own facts back.
// What the member did ("you already looked at their residency") comes from
// their own words, never from Co having sent it (2026-10-01: Co sent it, asked
// if they'd looked, and later told them they had).
const THEY_DID = /\byou(?:'ve| have)?\s+(?:already\s+)?(looked (?:at|into)|checked (?:out|it)|applied|signed up|registered|went|been to|visited|seen|read)\b/i;
export function theyDidUnbacked(caption: string, theirs: string): string | null {
  const m = caption.match(THEY_DID);
  if (!m) return null;
  const root = m[1].split(" ")[0].replace(/ed$|en$/, "").replace(/^went$/, "go");
  return new RegExp(`\\bI(?:'ve| have)?\\s+(?:already\\s+)?\\w*\\s*${root}`, "i").test(theirs) ? null : m[0];
}
export function captionProblems(caption: string, facts: string, theirs: string): string[] {
  const did = theyDidUnbacked(caption, theirs);
  return [
    ...numbersBacked(caption, `${facts} ${theirs}`).missing.map((n) => `"${n}" isn't in its facts`),
    ...placesBacked(caption, `${facts} ${theirs}`).missing.map((p) => `"${p}" isn't in its facts`),
    ...unbackedClaims(caption, facts).map((c) => `"${c}" isn't something its page says`),
    ...(did ? [`"${did}" isn't something they told you they did`] : []),
  ];
}

// They asked for it by email, in their own words: "email it to me", "send it to my email", "put it on my
// calendar", "in my inbox". Not "I'll email the host", "don't email me", "my email changed", or the caption of
// a photo of an email.
const EMAIL_REQUEST = /\be-?mail (?:it|this|that|me|the plan|the pdf|the sheet)\b|\bmail (?:it|this|that|me the|the plan|the pdf) (?:to me|over)?\b|\bsend (?:it|this|that|me the plan|the plan|the pdf)(?: over)? (?:to|by|via|through) (?:my )?(?:e-?mail|inbox|gmail|outlook|icloud)\b|\b(?:to|in|into|on|at) my (?:e-?mail|inbox|gmail|outlook|icloud)\b|\b(?:add|put|drop|send)(?: it| this| the plan| these| them)? (?:to|on|in|into) my calendar\b|\bon my calendar\b|\bcalendar (?:invites?|holds?|events?)\b|\bby e-?mail\b|\bvia e-?mail\b|\be-?mails? please\b/i;
const EMAIL_REFUSAL = /\b(?:don'?t|do not|no need to|never|please don'?t|stop) (?:e-?mail|mail)\b|\bI(?:'ll| will)? e-?mail (?:the|them|him|her|my)\b|\bI(?:'ve)? e-?mailed\b|\bmy e-?mail (?:changed|is|was|address)\b/i;
export function EMAIL_ASK_TEST(text: string): boolean {
  const own = text.replace(/\[[^\]]*\]/g, " ");
  return EMAIL_REQUEST.test(own) && !EMAIL_REFUSAL.test(own);
}
export const EMAIL_ASK = { test: EMAIL_ASK_TEST };

// They asked for a Google Doc (or for it in their Drive), in their own words.
export const GOOGLE_DOC_ASK = /\bgoogle\s*docs?\b|\bgoogle\s*drive\b|\bgdocs?\b|\b(?:in|to) (?:my )?(?:google )?drive\b/i;

export function mailtoLink(to: string, subject: string, body: string): string {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function loopTools(
  ctx: ConversationToolContext,
  state: { sent: boolean; sentMessages: string[] },
  loop: LoopState,
  notDone: (what: string) => void,
) {
  const outOfTime = () => (Date.now() - loop.started) / 1000 > LOOP_BUDGET.seconds;
  const OUT_OF_TIME = { ok: false, error: "Out of time for this turn: share what you have and answer them; say what you'd check next." };
  const say = async (text: string, record: string) => {
    if (ctx.dryRun) {
      console.log(`[conversationReply dryRun] would send to ${ctx.userId}: ${text.slice(0, 160)}`);
      state.sentMessages.push(text);
      return true;
    }
    const ok = await ctx.sendCoReply({ phone: ctx.phoneNumber, message: text, asVoice: false });
    if (ok === false) return false;
    // Delivered is delivered: the log write failing doesn't unsend it (2026-10-01 code review).
    state.sentMessages.push(text);
    await writeMemory(ctx.userId, "text_exchange", record).catch((err: any) => console.error("loopTools: logging a sent text failed (it did send):", err?.message ?? err));
    return true;
  };
  const hold = async (line?: string) => {
    if (!line?.trim() || loop.holdSent || state.sent) return;
    loop.holdSent = true;
    if (await say(line.trim(), `${HOLD_PREFIX} ${line.trim()}`)) ctx.facts?.add("did_this_turn", `Told them "${line.trim()}" while looking.`);
  };
  // Code saves the basics whenever a search runs, so the next text picks up
  // even if Co never updates its notes (Royce, 2026-10-01).
  const remember = async (patch: Partial<SearchIntent>) => {
    if (ctx.dryRun) return;
    const prev = (await loadBrief(ctx.userId).catch(() => null)) ?? ({ kind: "event", what: "", city: null, area: null, when: null, budget: null, headcount: null, vibe: null, summary: "", queries: [], sites: [], ask: null } as SearchIntent);
    const tried = [...new Set([...(prev.tried ?? []), ...(patch.tried ?? [])])].slice(-12);
    await saveBrief(ctx.userId, { ...prev, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null && v !== "")), tried } as SearchIntent);
  };
  // The log of a text that already went out; its failure never makes a delivered text look unsent.
  const logDeliveredPlan = (content: string) => writeMemory(ctx.userId, "text_exchange", content).catch((err: any) => console.error("loopTools: logging a sent plan failed (it did send):", err?.message ?? err));
  const theirWords = () => `${ctx.resolvedContent} ${ctx.turn?.message ?? ""}`;
  // Probes and dry runs never spend on searches (ctx.stubSearch).
  const STUB = { ok: true, note: "Test run: nothing was searched. Say you looked and nothing solid came up yet." };
  // A receipt for every search, empty or not, so "I looked and nothing turned
  // up" is backed (2026-10-01: with no record, the fact check cut it).
  const receipt = (what: string) => ctx.facts?.add("did_this_turn", what);

  return {
    searchEvents: tool({
      description: toolUse("searchEvents"),
      inputSchema: z.object({
        what: z.string().describe("What kind of event, in a few words."),
        when: z.string().optional().describe("The time in their own words: \"this weekend\", \"Friday night\", \"Oct 10\"."),
        city: z.string().optional().describe("The city, when they named one; their own city otherwise."),
        whileLooking: z.string().optional().describe("Only on your first search, if it'll take a moment: a few words to them, in your own voice."),
      }),
      execute: async ({ what, when, city, whileLooking }) => {
        if (ctx.stubSearch) {
          receipt(`Looked up events for "${what}"${when ? `, ${when}` : ""} just now: nothing came back.`);
          return { ...STUB, events: [] };
        }
        if (outOfTime()) return OUT_OF_TIME;
        await hold(whileLooking);
        const [r, earlier] = await Promise.all([
          eventCandidates(what, city ?? ctx.turn?.profile?.city ?? null, { when: when ?? null, userId: ctx.userId, limit: 8 }),
          // Openings Co's daily search already found and checked for them (the
          // old reply search offered these too): programs, grants, open calls.
          import("../services/eventSurfacingSweep.js").then((m) => m.alreadyFoundOpenings(ctx.userId)).catch(() => [] as TierMatch[]),
        ]);
        await remember({ what, when: when ?? undefined, city: city ?? undefined, tried: [`events: ${what}${when ? `, ${when}` : ""}`] });
        if (r.outOfRange) return { ok: true, events: [], note: `Nothing searched: ${r.outOfRange}. Say so.` };
        const events = r.candidates.map(({ match, lines }) => {
          const url = "url" in match ? (match.url ?? "") : "";
          // Sold out on its own page: a fact, so it can't be shared (it's still listed for Co to mention).
          const soldOut = (match as any).details?.soldOut === true ? "sold out" : null;
          if (url) loop.found.set(url, { name: match.name, url, facts: lines.join(" "), match, blocked: soldOut });
          return { name: match.name, link: url || null, ownEvent: match.tier === 1, details: lines };
        });
        for (const g of r.turnedAway) if (g.url) loop.found.set(g.url, { name: g.name, url: g.url, facts: "", match: null, blocked: g.reasons.join(", ") });
        for (const e of events) ctx.facts?.add("known", `Found just now: "${e.name}"${e.link ? `, link ${e.link}` : ""}. ${e.details.join(" ")}`);
        receipt(`Looked up events for "${what}"${when ? `, ${when}` : ""} just now: ${events.length} came back${r.turnedAway.length ? `, ${r.turnedAway.length} turned away (${r.turnedAway.map((g) => `${g.name}: ${g.reasons.join(", ")}`).join("; ").slice(0, 200)})` : ""}.`);
        const openings = earlier.filter((m) => "url" in m && m.url).slice(0, 4).map((m) => {
          const facts = `${m.reason} ${(m as any).evidence ?? ""}`.trim().slice(0, 600);
          loop.found.set((m as any).url, { name: m.name, url: (m as any).url, facts, match: m, blocked: null });
          ctx.facts?.add("known", `Found earlier by Co's daily search: "${m.name}", link ${(m as any).url}. ${facts}`);
          return { name: m.name, link: (m as any).url, details: facts };
        });
        return {
          ok: true,
          window: r.window,
          events,
          turnedAway: r.turnedAway.map((g) => `${g.name}: ${g.reasons.join(", ")}`),
          openingsFoundEarlier: openings,
          note: `${r.inWindow} events in the feed for ${r.window ?? "the next two weeks"} nearby; the ${events.length} closest to what you asked are above.${r.inWindow < 4 ? " The feed is thin here: try webSearch for the same thing." : ""}`,
        };
      },
    }),

    webSearch: tool({
      description: toolUse("webSearch"),
      inputSchema: z.object({
        queries: z.array(z.string()).min(1).max(3).describe("1 to 3 short searches, 3 to 7 words each, each a different angle; they run at the same time."),
        sites: z.array(z.string()).optional().describe("Sites where this kind of thing is listed, e.g. peerspace.com, thebash.com, lu.ma."),
        whileLooking: z.string().optional().describe("Only on your first search, if it'll take a moment: a few words to them, in your own voice."),
        theirs: z
          .object({ what: z.string().optional(), city: z.string().optional(), area: z.string().optional(), when: z.string().optional(), headcount: z.number().optional(), budget: z.number().optional(), hours: z.number().optional() })
          .optional()
          .describe("What they've asked for so far (what, place, date, headcount, budget in dollars, hours): saved to your working notes, so the next text picks up from here."),
      }),
      execute: async ({ queries, sites, whileLooking, theirs }) => {
        // Their constraints go into the notes with the search (2026-10-01 next-live run:
        // turn one's 120 people, $3k and 4 hours were lost in 2 of 4 runs when no updateNotes followed).
        const saved = Object.fromEntries(Object.entries(theirs ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));
        if (Object.keys(saved).length && !ctx.stubSearch) await remember(saved as Partial<SearchIntent>);
        if (ctx.stubSearch) {
          receipt(`Searched the web just now (${queries.map((q) => `"${q}"`).join(", ")}): nothing held up on its own page.`);
          return { ...STUB, results: [] };
        }
        if (outOfTime()) return OUT_OF_TIME;
        const left = LOOP_BUDGET.webSearches - loop.webQueries;
        if (left <= 0) return { ok: false, error: "No web searches left this turn: work with what you have, or read a page you already found." };
        const run = [...new Set(queries.map((q) => q.trim().slice(0, 90)).filter(Boolean))].slice(0, left);
        loop.webQueries += run.length;
        await hold(whileLooking);
        const { taskWebSearch } = await import("../services/taskWeb.js");
        const city = ctx.turn?.profile?.city ?? null;
        const siteList = (sites ?? []).filter((s) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)).slice(0, 4);
        const all = await Promise.all(run.map((q) => taskWebSearch(ctx.userId, q, { city, sites: siteList, source: "request", log: !ctx.dryRun }).catch(() => ({ kept: [], dropped: [], droppedDetails: [], note: "failed" }))));
        // The shared daily web search budget is spent: say so plainly rather than
        // "nothing yet" (2026-10-01: a day of testing used all 60, and Co gave up vaguely).
        if (all.every((x) => /^No web search right now/.test(x.note))) {
          notDone("Web search wasn't available: today's shared web search budget is used up.");
          return { ok: false, error: "Web search is used up for today. Tell them plainly you can't search the web again until tomorrow, offer to pick it up then (saveAsk), and use searchEvents or what you already found if it helps." };
        }
        await remember({ tried: run.map((q) => `web: ${q}`) });
        const seenUrls = new Set<string>();
        // Jev reads each fact against its passage (services/factCheck.ts); a "no" is dropped.
        const { checkVerified } = await import("../services/factCheck.js");
        const read = await checkVerified(all.flatMap((x) => x.kept).filter((k) => !seenUrls.has(k.url) && seenUrls.add(k.url))).catch(() => ({ kept: all.flatMap((x) => x.kept), droppedFacts: [] as string[] }));
        // Budget and headcount from the notes, and the total for their night, worked out in code.
        const notes = await loadBrief(ctx.userId).catch(() => null);
        const { fitsConstraints, priceEstimate } = await import("../services/searchIntent.js");
        // A name alone isn't something to send (2026-09-30: "DJ Busy B" with nothing about it).
        const empty = read.kept.filter((k) => !k.facts.length);
        // Listings on sites that block reading can't be checked, so they never come back as finds.
        const { cantCheck } = await import("../services/taskWeb.js");
        const blocked = siteList.filter(cantCheck);
        const withNotes = read.kept.filter((k) => k.facts.length).map((k) => {
          const fit = notes ? fitsConstraints(k.facts, { budget: notes.budget ?? null, headcount: notes.headcount ?? null, hours: notes.hours ?? null }) : { ok: true, why: null };
          const estimate = priceEstimate(k.facts, notes?.hours ?? null);
          return { ...k, facts: [...k.facts, ...(estimate ? [estimate] : []), ...(fit.tight ? [fit.tight] : []), ...(!fit.ok && fit.why ? [`note: ${fit.why}`] : [])] };
        });
        const r = {
          kept: withNotes,
          dropped: [
            ...all.flatMap((x) => x.dropped),
            ...read.droppedFacts.map((d) => ({ name: d, url: "", why: "the second reader said its page doesn't say that" })),
            ...empty.map((k) => ({ name: k.name, url: k.url, why: "nothing about it on its page" })),
            ...(blocked.length ? [{ name: `${blocked.join(", ")} listings`, url: "", why: "those sites block reading, so their listings can't be checked; look for places' own pages" }] : []),
          ],
          note: all.map((x) => x.note).find((n) => /checked/.test(n)) ?? all[0]?.note ?? "" };
        receipt(`Searched the web just now (${run.map((q) => `"${q}"`).join(", ")}): ${r.kept.length} held up on their own pages${r.dropped.length ? `, ${r.dropped.length} didn't` : ""}.`);
        for (const k of r.kept) {
          const facts = [...k.facts, ...(k.date ? [`date: ${k.date}`] : [])].join("; ");
          const match = { tier: 3, kind: "opportunity", source: "web", name: k.name, url: k.url, reason: facts || k.name, evidence: `${k.name}. ${facts}`, ...(k.date ? { statedDates: { start: k.date } } : {}) } as unknown as TierMatch;
          loop.found.set(k.url, { name: k.name, url: k.url, facts, match, blocked: null });
          ctx.facts?.add("known", `Found just now on the web: "${k.name}", link ${k.url}. ${facts}`);
        }
        // On file at research time, not only for this turn: the next turn's "send
        // it" needs the link (services/researchFinds.ts; 2026-10-03, Pitch Protocol).
        if (!ctx.dryRun && r.kept.length) {
          const { recordResearchFinds } = await import("../services/researchFinds.js");
          await recordResearchFinds(ctx.userId, r.kept.map((k) => ({ name: k.name, url: k.url, facts: k.facts.slice(0, 4).join("; ") }))).catch(() => 0);
        }
        return {
          ok: true,
          results: r.kept.map((k) => ({ name: k.name, link: k.url, facts: k.facts, date: k.date, ownSite: k.official })),
          dropped: r.dropped.map((d) => `${d.name}: ${d.why}`),
          note: r.note,
        };
      },
    }),

    searchPosts: tool({
      description: toolUse("searchPosts"),
      inputSchema: z.object({
        query: z.string().describe("2 to 4 distinctive keywords, OR for real synonyms; no city, no year they didn't say."),
        whileLooking: z.string().optional().describe("Only on your first search, if it'll take a moment: a few words to them, in your own voice."),
      }),
      execute: async ({ query, whileLooking }) => {
        if (ctx.stubSearch) return { ...STUB, posts: [] };
        if (outOfTime()) return OUT_OF_TIME;
        const q = query.trim().slice(0, 120);
        // The same daily X budget as the sweep, from the share kept for live asks.
        const { reserveXSearch } = await import("../services/tieredRecommendation.js");
        const budget = await reserveXSearch(ctx.userId, "request", q);
        if (!budget.ok) return { ok: false, error: `X search isn't available right now (${budget.reason ?? "daily budget"}); use webSearch instead.` };
        await hold(whileLooking);
        const { searchRecentPosts } = await import("../services/xSearch.js");
        const posts = await searchRecentPosts(q, 10).catch(() => null);
        await remember({ tried: [`x: ${q}`] });
        if (!posts) return { ok: false, error: "X search failed this time; use webSearch instead." };
        for (const p of posts) {
          const match = { tier: 3, kind: "opportunity", source: "x", name: p.text.slice(0, 80), url: p.url, reason: p.text, evidence: p.text } as unknown as TierMatch;
          loop.found.set(p.url, { name: p.text.slice(0, 80), url: p.url, facts: p.text, match, blocked: null });
        }
        return { ok: true, posts: posts.map((p) => ({ link: p.url, text: p.text.slice(0, 500) })), note: posts.length ? "Posts from the last week, as written. Judge them yourself; share only one whose own text backs what you'd say." : "No recent posts for that. Try other keywords or webSearch." };
      },
    }),

    readPage: tool({
      description: toolUse("readPage"),
      inputSchema: z.object({ url: z.string().describe("The page to read.") }),
      execute: async ({ url }) => {
        if (ctx.stubSearch) return { ok: false, error: "Test run: pages aren't read. Don't describe it." };
        if (outOfTime()) return OUT_OF_TIME;
        const { readPageText } = await import("../services/webOpportunitySearch.js");
        const text = await readPageText(url).catch(() => null);
        if (!text) {
          notDone(`Couldn't read ${url}.`);
          return { ok: false, error: "That page couldn't be read. Don't describe it from memory; try another page or say you couldn't check it." };
        }
        loop.pages.set(url, text);
        const known = loop.found.get(url);
        if (known) known.facts = `${known.facts} ${text.slice(0, 4000)}`;
        else loop.found.set(url, { name: url, url, facts: text.slice(0, 4000), match: null, blocked: null });
        ctx.facts?.add("known", `From the page ${url}: ${text.replace(/\s+/g, " ").slice(0, 1500)}`);
        return { ok: true, text: text.replace(/[ \t]+/g, " ").slice(0, 6000), emails: emailsIn(text).slice(0, 5) };
      },
    }),

    shareFinds: tool({
      description: toolUse("shareFinds"),
      inputSchema: z.object({
        items: z
          .array(z.object({ link: z.string(), caption: z.string().describe("One or two short sentences: what it is and why it fits them, from its facts; say what's unconfirmed.") }))
          .min(1)
          .max(3),
      }),
      execute: async ({ items }) => {
        const notes = await loadBrief(ctx.userId).catch(() => null);
        const sent: string[] = [];
        const refused: string[] = [];
        const uncaptioned: string[] = [];
        for (const it of items) {
          const f = loop.found.get(it.link) ?? (notes?.shortlist ?? []).map((s) => ({ name: s.name, url: s.url, facts: s.note ?? "", match: null, blocked: null }) as Found).find((s) => s.url === it.link);
          if (!f) {
            refused.push(`${it.link}: not something you found this turn or have in your notes`);
            continue;
          }
          if (f.blocked) {
            refused.push(`${f.name}: ${f.blocked}`);
            continue;
          }
          if (loop.shared.includes(it.link)) continue;
          const problems = captionProblems(it.caption, `${f.name} ${f.facts}`, `${theirWords()} ${notes ? JSON.stringify({ city: notes.city, when: notes.when, headcount: notes.headcount, budget: notes.budget }) : ""}`);
          if (problems.length) {
            refused.push(`${f.name}: caption says more than its facts (${problems.join("; ")}); rewrite it from its facts`);
            continue;
          }
          // Says who they are only from what they've told Co (services/identityGuard.ts).
          const known = `${theirWords()} ${JSON.stringify({ goals: ctx.turn?.profile?.goals ?? null, city: ctx.turn?.profile?.city ?? null })} ${f.name} ${f.facts}`;
          if ((stripUngroundedIdentity(it.caption, known) ?? "").trim() !== it.caption.trim()) {
            refused.push(`${f.name}: the caption says who they are beyond what they've told you; rewrite it without that`);
            continue;
          }
          // The first find after a "looking" line threads under their text, as results always have.
          if (!sent.length && loop.holdSent) ctx.threadNext?.();
          if (!(await say(it.link, `Co replied: ${it.link}`))) {
            notDone(`The link ${it.link} didn't send.`);
            continue;
          }
          // The link went out, so it's shared whatever happens to its caption.
          loop.shared.push(it.link);
          sent.push(f.name);
          state.sent = true;
          await new Promise((r) => setTimeout(r, ctx.dryRun ? 0 : 1500));
          // The caption is its own receipt (2026-10-01 code review: a failed
          // caption was recorded as sent). One retry of just the caption; if it
          // still fails, the fact says the link went alone, so Co's reply can
          // carry what the caption would have.
          const caption = it.caption.trim();
          const captioned = (await say(caption, `Co replied: ${caption}`)) || (await say(caption, `Co replied: ${caption}`));
          if (captioned) {
            ctx.facts?.add("did_this_turn", `Sent "${f.name}" (${it.link}) with the caption: "${caption}"`);
          } else {
            uncaptioned.push(f.name);
            ctx.facts?.add("did_this_turn", `Sent the link for "${f.name}" (${it.link}), but its caption didn't send`);
            notDone(`The caption for ${f.name} didn't send; only its link went.`);
          }
          if (f.match && !ctx.dryRun) await recordRecommendationsSent(ctx.userId, [f.match]).catch(() => {});
        }
        if (sent.length) await remember({ shortlist: [...(notes?.shortlist ?? []), ...items.filter((i) => loop.shared.includes(i.link)).map((i) => ({ name: loop.found.get(i.link)?.name ?? i.link, url: i.link, note: i.caption.slice(0, 200) }))].slice(-8) });
        if (!ctx.dryRun) await recordDecision({ layer: 3, decision: "loop.shareFinds", userId: ctx.userId, outcome: sent.length ? "act" : "skip", action: `sent ${sent.length}`, proposal: { sent, refused, seconds: Math.round((Date.now() - loop.started) / 1000) } }).catch(() => {});
        if (refused.length) notDone(`Not sent: ${refused.join(" | ")}`);
        return {
          ok: sent.length > 0,
          sent,
          refused,
          ...(uncaptioned.length ? { uncaptioned } : {}),
          note: !sent.length
            ? "Nothing sent."
            : uncaptioned.length
              ? `Sent. The caption didn't go out for ${uncaptioned.join(", ")}: only the link did, so say what it is in your reply. The rest went with their captions; don't repeat those.`
              : "Sent, each link then its caption. Don't repeat them in your reply; add only what's left to say.",
        };
      },
    }),

    draftEmail: tool({
      description: toolUse("draftEmail"),
      inputSchema: z.object({
        to: z.string().optional().describe("The address, if the place has one you've seen. Leave it out for a marketplace listing that has its own contact form."),
        subject: z.string(),
        body: z.string(),
      }),
      execute: async ({ to, subject, body }) => {
        const notes = await loadBrief(ctx.userId).catch(() => null);
        // A marketplace listing (Tagvenue, Peerspace, The Bash) is reached through
        // its own contact form: the draft is for them to paste there.
        // The draft itself goes out as its own text, so they always have it to
        // copy (2026-10-01: Co said "I wrote the note" and never showed it).
        const draftText = `${subject.trim() ? `Subject: ${subject.trim()}\n\n` : ""}${body.trim()}`;
        if (!to?.trim()) {
          if (!(await say(draftText, `Co replied: ${draftText}`))) return { ok: false, error: "The draft didn't send. Say so." };
          ctx.facts?.add("did_this_turn", `Sent them a draft message to paste into the listing's own contact form: "${draftText.slice(0, 400)}"`);
          await remember({ next: "message drafted for the listing's contact form; waiting for them to send it" });
          return { ok: true, note: "The draft went out as its own text. Say in a line where to paste it (the listing's contact form); don't repeat the draft." };
        }
        const addr = to.trim().toLowerCase();
        const seen = [...loop.pages.values()].some((t) => t.toLowerCase().includes(addr)) || theirWords().toLowerCase().includes(addr) || (notes?.contacts ?? []).some((c) => c.email.toLowerCase() === addr) || (ctx.turn?.ledger ? JSON.stringify(ctx.turn.ledger).toLowerCase().includes(addr) : false);
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(addr) || !seen) {
          notDone(`No email drafted to ${to}: that address wasn't on a page read this turn, in their texts, or in the notes.`);
          return { ok: false, error: "That address isn't one you've seen. Read the place's own page (readPage) for a contact address and try again; if it's a marketplace listing with its own contact form, draft without an address so they can paste it there." };
        }
        const link = mailtoLink(addr, subject.trim(), body.trim());
        if (!(await say(`To: ${addr}\n${draftText}`, `Co replied: To: ${addr}\n${draftText}`))) return { ok: false, error: "The draft didn't send. Say so." };
        await new Promise((r) => setTimeout(r, ctx.dryRun ? 0 : 1200));
        await say(link, `Co replied: ${link}`);
        ctx.facts?.add("did_this_turn", `Sent them a draft email to ${addr} ("${subject.trim()}") and a tap-to-send link that opens it in their own mail app. Nothing was sent to ${addr}.`);
        await remember({ contacts: [...(notes?.contacts ?? []).filter((c) => c.email !== addr), { name: addr.split("@")[1] ?? addr, email: addr }].slice(-6), next: `email drafted to ${addr}; waiting for them to send it` });
        return { ok: true, note: "The draft and its tap-to-send link went out as their own texts. Say in a line that tapping the link opens it in their mail app ready to send; don't repeat the draft." };
      },
    }),

    // A plan, emailed (services/planSheet.ts, planEmail.ts): a one-page sheet and calendar holds, to
    // the member's own email on their account. Co writes the plan; code fills event steps from their own
    // records and holds everything else to what was read this turn or said, and the address is never Co's to choose.
    emailPlan: tool({
      description: toolUse("emailPlan"),
      inputSchema: z.object({
        title: z.string().describe("A short title for the plan, in Co's voice, using only words they said or you read: no place, name or number you didn't read."),
        note: z.string().describe("One or two plain sentences for the top of the sheet and the email, in your voice."),
        steps: z
          .array(
            z.object({
              link: z.string().optional().describe("The link of an event you found this turn; its time, place and address come from its own record."),
              when: z.string().optional().describe("Their local time, 2026-10-11T16:30."),
              until: z.string().optional(),
              what: z.string(),
              where: z.string().optional(),
              address: z.string().optional(),
              detail: z.string().optional(),
            }),
          )
          .min(1)
          .max(8),
        notes: z.array(z.string()).max(4).optional().describe("Things worth knowing, one short line each."),
        sendBy: z.enum(["text", "email", "both"]).optional().describe("Leave this out: the PDF goes in this conversation, by text. Only when they ask for it by email (or both) in their own words do you set email or both; the email also carries a calendar hold for each time."),
      }),
      execute: async (input) => {
        const { rows } = await pool.query(`SELECT email, first_name FROM users WHERE id = $1`, [ctx.userId]).catch(() => ({ rows: [] as any[] }));
        const raw = String(rows[0]?.email ?? "").trim();
        const email = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(raw) ? raw : "";
        // By default the plan is a text: the PDF in this conversation. It goes to their email only when they
        // ask for that in their own words this turn (code checks the words, not Co's say-so); with no email on
        // file, an email request becomes a text and Co says so.
        const askedForEmail = EMAIL_ASK.test(theirWords());
        const asked = (input.sendBy === "email" || input.sendBy === "both") && !askedForEmail ? "text" : (input.sendBy ?? "text");
        const byEmail = (asked === "email" || asked === "both") && !!email;
        const byText = asked === "text" || asked === "both" || (asked === "email" && !email);
        const noEmailFallback = (asked === "email" || asked === "both") && !email;
        const downgraded = (input.sendBy === "email" || input.sendBy === "both") && !askedForEmail;
        const city = ctx.turn?.profile?.city ?? null;
        const zone = (city ? await import("../services/geocoding.js").then((g) => g.getTimezoneForCity(city)).catch(() => null) : null) ?? "America/Los_Angeles";
        const recordFor = (link: string): EventRecord | null => {
          const f = loop.found.get(link);
          if (!f) return null;
          const d = f.match && "details" in f.match ? (f.match as any).details : null;
          // Only an event with its own page record can fill a step; a web result or a post can't.
          return { name: f.match?.name ?? f.name, hasRecord: !!d, blocked: f.blocked ?? null, startAt: d?.startAt ?? null, endAt: d?.endAt ?? null, timezone: d?.timezone ?? null, venue: d?.venue ?? null, address: d?.address ?? null };
        };
        const brief = await loadBrief(ctx.userId).catch(() => null);
        const facts = [...loop.pages.values(), ...[...loop.found.values()].map((f) => `${f.name} ${f.facts}`), brief ? JSON.stringify(brief) : ""].join("\n");
        const plan = resolvePlan(input, zone, recordFor);
        const problems = planProblems(input, plan, { facts, theirs: theirWords(), now: new Date(), recordFor });
        if (problems.length) {
          notDone(`No plan emailed: ${problems.slice(0, 3).join("; ")}.`);
          return { ok: false, error: `Not sent: ${problems.slice(0, 5).join(" | ")}. Fix these and try again, or say what you couldn't confirm.` };
        }
        const way = byEmail && byText ? "by email and by text" : byEmail ? "by email" : "by text";
        if (ctx.dryRun) {
          ctx.facts?.add("did_this_turn", `Sent them a plan, "${plan.title}", as a one-page sheet ${way}.`);
          return { ok: true, note: "Test run: nothing was sent." };
        }
        const { buildPlanFiles, sendPlanEmail } = await import("../services/planEmail.js");
        const firstName = String(rows[0]?.first_name ?? ctx.firstName ?? "");
        const files = await buildPlanFiles(plan, { firstName, seed: `${ctx.userId.slice(0, 8)}-${Date.now().toString(36)}` });
        if (!files) {
          notDone("No plan sent: the sheet couldn't be made right now.");
          return { ok: false, error: "The sheet couldn't be made right now. Say so plainly and give them the plan in a text instead." };
        }
        const went: string[] = [];
        if (byEmail) {
          const sent = await sendPlanEmail({ to: email, files });
          if (sent.ok) {
            went.push("email");
            // Logged like a text, so a replayed turn sees it went out and doesn't send it twice.
            await logDeliveredPlan(`Co replied: [emailed a plan: ${plan.title}]`);
          }
          else notDone(`The plan email didn't go out: ${sent.why}.`);
        }
        if (byText) {
          const { cachePlanFile } = await import("../services/planFile.js");
          try {
            await sendblue.messages.send({ number: ctx.phoneNumber, content: plan.title, media_url: cachePlanFile(files.pdf), from_number: process.env.SENDBLUE_PHONE_NUMBER! });
            await logDeliveredPlan(`Co replied: [sent a plan: ${plan.title}]`);
            state.sentMessages.push(`[sent a plan: ${plan.title}]`);
            went.push("text");
          } catch (err: any) {
            notDone("The plan PDF didn't send by text.");
          }
        }
        if (!went.length) return { ok: false, error: "The plan didn't go out. Say so plainly and offer the plan as a text message instead." };
        await recordDecision({ layer: 3, decision: "loop.emailPlan", userId: ctx.userId, outcome: "act", action: plan.title, proposal: { steps: plan.steps.length, via: went, calendar: went.includes("email") && files.calendar } }).catch(() => {});
        const gone = went.length === 2 ? "by email and by text" : went[0] === "email" ? "by email" : "by text";
        ctx.facts?.add("did_this_turn", `Sent them a plan, "${plan.title}", as a one-page sheet ${gone}${went.includes("email") && files.calendar ? ", with a calendar hold for each time in the email" : ""}.`);
        await remember({ next: `plan sent: ${plan.title}` });
        return {
          ok: true,
          via: went,
          note: `${went.includes("text") ? "The PDF is in this conversation. " : ""}${went.includes("email") ? `It's in their email${files.calendar ? ", with a calendar hold for each time" : ""}. ` : ""}${noEmailFallback ? "They have no email on file, so it went by text: say so, in a few words. " : ""}${downgraded ? "They hadn't asked for email, so it went by text; if they want it by email too, they can say so. " : ""}${went.length < (byEmail && byText ? 2 : 1) ? "One of the two didn't go out: say which. " : ""}Say in one line where it is; don't list the steps again.`,
        };
      },
    }),

    // A document (services/documentSheet.ts, documentDelivery.ts): a titled page Co writes from what they said, as a PDF in this
    // conversation. Phase 1; a Google Docs step slots into DELIVERERS later. Needs their own yes (the registry's `confirm`).
    writeDocument: tool({
      description: toolUse("writeDocument"),
      inputSchema: z.object({
        title: z.string().describe("A short title, in plain words they would recognize."),
        note: z.string().optional().describe("One line under the title: what this is, in your voice."),
        sections: z
          .array(
            z.object({
              heading: z.string().optional(),
              paragraphs: z.array(z.string()).max(6).optional(),
              bullets: z.array(z.string()).max(10).optional(),
            }),
          )
          .min(1)
          .max(10)
          .describe("Each a heading, a sentence or two of framing, then the points as short bullets: scannable, not dense paragraphs. ONLY what they said, in their words; your own ideas go in suggestions, never here."),
        suggestions: z.array(z.string()).max(5).optional().describe("Anything of your own: an idea, an option, a recommendation. It appears on the page marked as Co's suggestions, apart from their points. Leave it out when you have none."),
        kind: z.enum(["venue_brief", "partnership_plan", "readout", "other"]).optional().describe("What it is for: venue_brief (for a venue or space around an event), partnership_plan (working with a partner, sponsor or host), readout (what came of an event, for a host or partner), or other (anything else: their goals, a plan for themselves, a summary). Leave it out for other."),
        saveTo: z.enum(["pdf", "google_doc", "both"]).optional().describe("Leave this out: it comes as a PDF in this conversation. Only when they ask for a Google Doc in their own words set google_doc (or both, if they want the PDF too)."),
      }),
      execute: async (input) => {
        const { resolveDocument, documentProblems } = await import("../services/documentSheet.js");
        const { deliverDocument, docTargets, loadTheirWords } = await import("../services/documentDelivery.js");
        const { recordDocumentWritten } = await import("../services/documentOffer.js");
        const doc = resolveDocument(input);
        // Their record is their words: two weeks of their texts and calls, and this message. What Co read this turn can back only
        // an event or place in Co's own marked suggestions, never a claim about them.
        const theirs = [await loadTheirWords(ctx.userId).catch(() => ""), theirWords()].join("\n");
        const read = [...loop.pages.values(), ...[...loop.found.values()].map((f) => `${f.name} ${f.facts}`)].join("\n");
        const source = { theirs, read };
        const problems = documentProblems(doc, source);
        if (problems.length) {
          notDone(`No document sent: ${problems.slice(0, 3).join("; ")}.`);
          return { ok: false, error: `Not sent: ${problems.slice(0, 5).join(" | ")}. Fix these and try again once, or tell them plainly what you couldn't back and give them the points in a text.` };
        }
        if (ctx.dryRun) {
          ctx.facts?.add("did_this_turn", `Sent them a document, "${doc.title}", as a PDF in this conversation.`);
          return { ok: true, note: "Test run: nothing was sent." };
        }
        const { rows } = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [ctx.userId]).catch(() => ({ rows: [] as any[] }));
        const city = ctx.turn?.profile?.city ?? null;
        const zone = city ? await import("../services/geocoding.js").then((g) => g.getTimezoneForCity(city)).catch(() => null) : null;
        const to = { userId: ctx.userId, firstName: String(rows[0]?.first_name ?? ctx.firstName ?? ""), phone: ctx.phoneNumber, zone };
        // A Google Doc only when they asked for one in their own words (code checks the words, not Co's say-so), and only for a shared
        // working artifact (venue brief, partnership plan, readout) for a member of the Google test pair; otherwise the PDF.
        // Not connected (or Docs not allowed): the PDF goes instead, and Co offers to connect Google.
        const { targets, googleRefused } = docTargets({ userId: ctx.userId, kind: doc.kind, saveTo: input.saveTo, askedForGoogle: GOOGLE_DOC_ASK.test(theirWords()) });
        const results: Awaited<ReturnType<typeof deliverDocument>>[] = [];
        let googleMissing = false;
        for (const target of targets) {
          const r = await deliverDocument(doc, to, target);
          results.push(r);
          if (!r.ok && target === "google_docs" && (r.notConnected || r.notAllowed)) {
            googleMissing = !!r.notConnected;
            if (!targets.includes("pdf_text")) results.push(await deliverDocument(doc, to, "pdf_text"));
          }
        }
        const sentOk = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
        if (!sentOk.length) {
          const why = results.map((r) => (r.ok ? "" : r.why)).filter(Boolean).join("; ");
          notDone(`No document sent: ${why}.`);
          return { ok: false, error: `${why}. Say so plainly and give them the points in a text instead.` };
        }
        const sent = { ok: true as const, via: sentOk.map((r) => r.via).join("+"), link: sentOk.find((r) => r.link)?.link ?? null };
        await logDeliveredPlan(`Co replied: [sent a document: ${doc.title}]`);
        state.sentMessages.push(`[sent a document: ${doc.title}]`);
        await recordDocumentWritten(ctx.userId, doc.title).catch(() => {});
        await recordDecision({ layer: 3, decision: "loop.writeDocument", userId: ctx.userId, outcome: "act", action: doc.title, proposal: { sections: doc.sections.length, via: sent.via } }).catch(() => {});
        const asPdf = sentOk.some((r) => r.via === "pdf_text");
        const asDoc = sentOk.some((r) => r.via === "google_docs");
        const sharedLink = sentOk.some((r) => r.via === "google_docs" && r.shared);
        ctx.facts?.add("did_this_turn", `Sent them a document, "${doc.title}" (${doc.sections.length} sections)${asDoc ? `, as a Google Doc in their own Drive (link texted: ${sent.link}; ${sharedLink ? "anyone with the link can open and edit it" : "only they can open it"})` : ""}${asDoc && asPdf ? " and" : ""}${asPdf ? " as a PDF in this conversation" : ""}.`);
        await remember({ next: `document sent: ${doc.title}` });
        return {
          ok: true,
          via: sent.via,
          note: `${asDoc ? `The Google Doc is in their Drive and its link is in this conversation; ${sharedLink ? "anyone with the link can open and edit it, and the text told them so" : "only they can open it for now, and the text told them so"}. ` : ""}${googleRefused === "kind" ? "They asked for a Google Doc, but a Google Doc is only for a venue brief, partnership plan or readout, so this went as a PDF: say so in a line. " : googleRefused === "not_yet" ? "They asked for a Google Doc, but Google Docs aren't open to them yet, so it went as a PDF: say so in a line, without promising when. " : ""}${asPdf ? "The PDF is in this conversation. " : ""}${googleMissing ? "Their Google isn't connected with Docs allowed, so it went as a PDF: say so in a line and offer to send the link to connect Google (googleConnection). " : ""}Say in one line what it covers and that you'll change anything they want; don't repeat its contents.`,
        };
      },
    }),

    // A document from a PDF they sent (services/memberFiles.ts, board item 4). Drafted in its own call from their file and their words,
    // so the file's contents never enter this conversation: Co doesn't see them, and every record of it here says only "their file #n"
    // (no title, no words of it), so nothing from a file reaches their memory, their profile, or anything another member's matching reads.
    writeFromFile: tool({
      description: toolUse("writeFromFile"),
      inputSchema: z.object({
        file: z.number().int().positive().optional().describe("The file's number (#2 is 2) when they name one; leave it out for their newest."),
        kind: z.enum(["venue_brief", "partnership_plan", "readout", "other"]).optional().describe("What it is for: venue_brief, partnership_plan, readout, or other (anything for themselves)."),
        want: z.string().describe("What they asked for, in a few of their own words."),
        saveTo: z.enum(["pdf", "google_doc", "both"]).optional().describe("Leave this out for a PDF in this conversation. Only when they ask for a Google Doc in their own words: google_doc (or both)."),
      }),
      execute: async (input) => {
        const F = await import("../services/memberFiles.js");
        const { resolveDocument, documentProblems } = await import("../services/documentSheet.js");
        const { docTargets, loadTheirWords } = await import("../services/documentDelivery.js");
        const deliverDocument = F.fileSteps.deliver;
        // Only this member's own file, by their own number.
        const file = await F.fileText(ctx.userId, input.file ?? null);
        if (!file) {
          const have = await F.filesOnFile(ctx.userId).catch(() => []);
          return { ok: false, error: have.length ? `No file #${input.file} on file for them; their files are ${have.map((f) => `#${f.n} (sent ${f.sentOn})`).join(", ")}. Ask which one.` : "They have no file on file with you. Tell them to text you the PDF first." };
        }
        const theirs = [await loadTheirWords(ctx.userId).catch(() => ""), theirWords()].join("\n");
        if (ctx.dryRun) {
          ctx.facts?.add("did_this_turn", `Sent them a document made from their file #${file.n}.`);
          return { ok: true, note: "Test run: nothing was drafted or sent." };
        }
        const draft = await F.fileSteps.draft({ fileText: file.text, theirWords: theirs, kind: input.kind ?? "other", want: input.want });
        if (!draft) return { ok: false, error: "The document couldn't be drafted right now. Say so plainly and offer to try again." };
        const doc = resolveDocument(draft);
        // Rule 4: the same grounding as writeDocument, with their file as part of their own record. Nothing of either is shown to Co.
        const problems = documentProblems(doc, { theirs: `${theirs}\n${file.text}` });
        if (problems.length) {
          notDone(`No document sent from their file #${file.n}: it didn't hold to their file and words.`);
          return { ok: false, error: "The draft leaned on things that weren't in their file or their words, so it wasn't sent. Say you couldn't make it hold to what they gave you, and ask what they want it to cover." };
        }
        const { rows } = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [ctx.userId]).catch(() => ({ rows: [] as any[] }));
        const to = { userId: ctx.userId, firstName: String(rows[0]?.first_name ?? ctx.firstName ?? ""), phone: ctx.phoneNumber, zone: null };
        const { targets, googleRefused } = docTargets({ userId: ctx.userId, kind: doc.kind, saveTo: input.saveTo, askedForGoogle: GOOGLE_DOC_ASK.test(theirWords()) });
        const results: Awaited<ReturnType<typeof deliverDocument>>[] = [];
        for (const target of targets) {
          const r = await deliverDocument(doc, to, target);
          results.push(r);
          if (!r.ok && target === "google_docs" && (r.notConnected || r.notAllowed) && !targets.includes("pdf_text")) results.push(await deliverDocument(doc, to, "pdf_text"));
        }
        const sentOk = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
        if (!sentOk.length) {
          notDone(`No document sent from their file #${file.n}.`);
          return { ok: false, error: "It didn't send. Say so plainly and offer to try again." };
        }
        const via = sentOk.map((r) => r.via).join("+");
        const line = `[sent a document made from their file #${file.n}]`;
        await logDeliveredPlan(`Co replied: ${line}`);
        state.sentMessages.push(line);
        await recordDecision({ layer: 3, decision: "loop.writeFromFile", userId: ctx.userId, outcome: "act", action: `file #${file.n}`, proposal: { via, kind: doc.kind } }).catch(() => {});
        ctx.facts?.add("did_this_turn", `Sent them a document made from their file #${file.n}${sentOk.some((r) => r.via === "google_docs") ? ", as a Google Doc in their own Drive" : ""}${sentOk.some((r) => r.via === "pdf_text") ? ", as a PDF in this conversation" : ""}.`);
        await remember({ next: `document sent from their file #${file.n}` });
        return {
          ok: true,
          via,
          note: `It's sent. ${googleRefused === "kind" ? "A Google Doc is only for a venue brief, partnership plan or readout, so it went as a PDF: say so in a line. " : googleRefused === "not_yet" ? "Google Docs aren't open to them yet, so it went as a PDF: say so in a line. " : ""}Say in one line that it's there and you'll change anything they want. You haven't seen what it says, so don't describe it.`,
        };
      },
    }),

    // Their files, gone on their ask (services/memberFiles.ts): code checks their words asked for it, not Co's say-so.
    deleteMyFiles: tool({
      description: toolUse("deleteMyFiles"),
      inputSchema: z.object({ file: z.number().int().positive().optional().describe("The file's number when they name one; leave it out to delete all of them.") }),
      execute: async (input) => {
        const F = await import("../services/memberFiles.js");
        if (!F.DELETE_ASK.test(theirWords())) return { ok: false, error: "Not done: they haven't asked to delete their files in this message. Only delete when they ask." };
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was deleted." };
        const n = await F.deleteFiles(ctx.userId, input.file ?? null);
        await recordDecision({ layer: 3, decision: "loop.deleteMyFiles", userId: ctx.userId, outcome: "act", action: input.file ? `file #${input.file}` : "all", proposal: { deleted: n } }).catch(() => {});
        ctx.facts?.add("did_this_turn", n ? `Deleted ${n === 1 ? "one of their files" : `${n} of their files`}${input.file ? ` (#${input.file})` : ""}; ${n === 1 ? "it's" : "they're"} gone.` : "Looked for their files to delete and found none.");
        return { ok: true, deleted: n, note: n ? "Say plainly what was deleted and that it's gone." : "There was nothing to delete: say so." };
      },
    }),

    // The offer (services/documentOffer.ts): code re-checks the moment and records that Co offered, so it is never offered twice;
    // Co writes the offer itself, in its own words.
    offerDocument: tool({
      description: toolUse("offerDocument"),
      inputSchema: z.object({}),
      execute: async () => {
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was recorded. Make the offer in your own words." };
        const { loadOfferState, documentOfferDue, recordOffer } = await import("../services/documentOffer.js");
        const due = documentOfferDue(await loadOfferState(ctx.userId));
        if (!due.due) return { ok: false, error: `Don't offer a document now: ${due.why}.` };
        await recordOffer(ctx.userId, due.topic);
        ctx.facts?.add("did_this_turn", `Offered to write up "${due.topic}" as a document; waiting on their answer.`);
        return { ok: true, topic: due.topic, note: "Recorded. Now make the offer in your reply, in your own words, as one light line about this. Don't write the document until they say yes." };
      },
    }),

    updateNotes: tool({
      description: toolUse("updateNotes"),
      inputSchema: z.object({
        what: z.string().optional(),
        city: z.string().optional(),
        area: z.string().optional(),
        when: z.string().optional(),
        headcount: z.number().optional(),
        budget: z.number().optional(),
        hours: z.number().optional(),
        picked: z.string().optional().describe("What they chose, by name."),
        next: z.string().optional().describe("What's next, in a few words."),
      }),
      execute: async (patch) => {
        await remember(patch as Partial<SearchIntent>);
        return { ok: true };
      },
    }),

    // Where one of their open loops stands (services/openLoops.ts): Co's word
    // wins over what code derives, and a loop Co closes stays closed. Named by
    // its id; a title only lands when exactly one loop fits it.
    updateLoop: tool({
      description: toolUse("updateLoop"),
      inputSchema: z.object({
        loopId: z.number().int().optional().describe("The loop's id, the N in [loop N] in what you're carrying for them. Leave it out only for a new loop."),
        loop: z.string().describe("The loop's name as you're carrying it, or a new one in a few words."),
        status: z.enum(["open", "waiting_on_reply", "unconfirmed", "decision_needed", "done", "dropped"]),
        detail: z.string().optional().describe("What it's waiting on or what's unconfirmed, in a few words."),
      }),
      execute: async ({ loopId, loop, status, detail }) => {
        if (ctx.dryRun) return { ok: true, note: "Recorded (test run)." };
        const { setLoopStatus } = await import("../services/openLoops.js");
        const r = await setLoopStatus(ctx.userId, { id: loopId ?? null, title: loop }, status, detail?.trim().slice(0, 240) ?? null).catch(() => ({ ok: false as const, error: "Couldn't record that. Don't say you did." }));
        return r.ok ? { ok: true, note: `"${r.title}" is now ${status.replace(/_/g, " ")}.` } : { ok: false, error: r.error };
      },
    }),
  };
}

// The notes, as Co reads them at the start of a turn.
export function describeNotes(b: SearchIntent | null): string | null {
  if (!b) return null;
  const parts = [
    b.what && `looking for: ${b.what}`,
    (b.area || b.city) && `where: ${[b.area, b.city].filter(Boolean).join(", ")}`,
    b.when && `when: ${b.when}`,
    b.headcount && `headcount: ${b.headcount}`,
    b.budget && `budget: under $${b.budget}`,
    b.hours && `hours: ${b.hours}`,
    b.shortlist?.length && `shortlist: ${b.shortlist.map((s) => `${s.name} (${s.url})`).join("; ")}`,
    b.picked && `they picked: ${b.picked}`,
    b.contacts?.length && `contacts: ${b.contacts.map((c) => c.email).join(", ")}`,
    b.tried?.length && `already tried: ${b.tried.slice(-6).join("; ")}`,
    b.next && `next: ${b.next}`,
  ].filter(Boolean);
  return parts.length ? `Your working notes for what you're finding for them (from earlier texts): ${parts.join(". ")}.` : null;
}
