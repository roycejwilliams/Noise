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

// What the loop has seen this turn: every link a tool returned, with the facts
// that came with it, and every page it read.
type Found = { name: string; url: string; facts: string; match: TierMatch | null; blocked: string | null };
export type LoopState = { started: number; found: Map<string, Found>; pages: Map<string, string>; holdSent: boolean; shared: string[]; webQueries: number };

export function newLoopState(): LoopState {
  return { started: Date.now(), found: new Map(), pages: new Map(), holdSent: false, shared: [], webQueries: 0 };
}

const HOLD_PREFIX = "Co is looking:"; // the same record line routes/sendblue.ts writes for a hold text
const emailsIn = (text: string) => [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))];

// A caption may only carry numbers, places and claims its own facts back.
export function captionProblems(caption: string, facts: string, theirs: string): string[] {
  return [
    ...numbersBacked(caption, `${facts} ${theirs}`).missing.map((n) => `"${n}" isn't in its facts`),
    ...placesBacked(caption, `${facts} ${theirs}`).missing.map((p) => `"${p}" isn't in its facts`),
    ...unbackedClaims(caption, facts).map((c) => `"${c}" isn't something its page says`),
  ];
}

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
    await writeMemory(ctx.userId, "text_exchange", record);
    state.sentMessages.push(text);
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
  const theirWords = () => `${ctx.resolvedContent} ${ctx.turn?.message ?? ""}`;
  // Probes and dry runs never spend on searches (ctx.stubSearch).
  const STUB = { ok: true, note: "Test run: nothing was searched. Say you looked and nothing solid came up yet." };

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
        if (ctx.stubSearch) return { ...STUB, events: [] };
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
      }),
      execute: async ({ queries, sites, whileLooking }) => {
        if (ctx.stubSearch) return { ...STUB, results: [] };
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
        for (const k of r.kept) {
          const facts = [...k.facts, ...(k.date ? [`date: ${k.date}`] : [])].join("; ");
          const match = { tier: 3, kind: "opportunity", source: "web", name: k.name, url: k.url, reason: facts || k.name, evidence: `${k.name}. ${facts}`, ...(k.date ? { statedDates: { start: k.date } } : {}) } as unknown as TierMatch;
          loop.found.set(k.url, { name: k.name, url: k.url, facts, match, blocked: null });
          ctx.facts?.add("known", `Found just now on the web: "${k.name}", link ${k.url}. ${facts}`);
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
          await new Promise((r) => setTimeout(r, ctx.dryRun ? 0 : 1500));
          await say(it.caption.trim(), `Co replied: ${it.caption.trim()}`);
          loop.shared.push(it.link);
          sent.push(f.name);
          state.sent = true;
          ctx.facts?.add("did_this_turn", `Sent "${f.name}" (${it.link}) with the caption: "${it.caption.trim()}"`);
          if (f.match && !ctx.dryRun) await recordRecommendationsSent(ctx.userId, [f.match]).catch(() => {});
        }
        if (sent.length) await remember({ shortlist: [...(notes?.shortlist ?? []), ...items.filter((i) => loop.shared.includes(i.link)).map((i) => ({ name: loop.found.get(i.link)?.name ?? i.link, url: i.link, note: i.caption.slice(0, 200) }))].slice(-8) });
        if (!ctx.dryRun) await recordDecision({ layer: 3, decision: "loop.shareFinds", userId: ctx.userId, outcome: sent.length ? "act" : "skip", action: `sent ${sent.length}`, proposal: { sent, refused, seconds: Math.round((Date.now() - loop.started) / 1000) } }).catch(() => {});
        if (refused.length) notDone(`Not sent: ${refused.join(" | ")}`);
        return { ok: sent.length > 0, sent, refused, note: sent.length ? "Sent, each link then its caption. Don't repeat them in your reply; add only what's left to say." : "Nothing sent." };
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
