// Suite 6: search through the real loop tools (agent/loopTools.ts) and event
// candidates (tieredRecommendation.eventCandidates). Luma calendar and discover
// feed are fixtures at the HTTP boundary in fixture-live cases. Module caches
// (calendar, discover) have no reset, so run each search case in its own process.
import "../lib/requireMeter.js";
import { H } from "./boot.js";
import { DateTime } from "luxon";
import { DBC, settle } from "./db.js";
import { member, rows, ck, PHONE, ID, NAME, type Case } from "./fixtures.js";

// Pacific evening n days from today (Luxon), so "this week" fixtures land inside the week.
const day = (n: number, h = 19) => DateTime.now().setZone("America/Los_Angeles").plus({ days: n }).set({ hour: h, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()!;
function feeds(own: any[], pub: any[]) {
  H.respond = (t, path) => {
    if (t !== "luma") return null;
    if (path.startsWith("/v1/calendars/events/list")) return { status: 200, body: { entries: own.map((e) => ({ event: { id: e.id, name: e.name, start_at: e.start, end_at: e.end ?? null, url: `https://lu.ma/${e.slug}`, timezone: "America/Los_Angeles", geo_address_json: { city: e.city } } })), has_more: false } };
    if (path.startsWith("/discover/get-paginated-events")) return { status: 200, body: { entries: pub.map((e) => ({ event: { api_id: e.id, name: e.name, start_at: e.start, url: e.slug, geo_address_info: { city: e.city } } })), has_more: false } };
    return { status: 200, body: { entries: [], has_more: false } };
  };
}
async function geo() {
  await rows(`INSERT INTO geocode_cache (query, lat, lng, timezone) VALUES ('New York', 40.7128, -74.006, 'America/New_York'), ('Oakland', 37.8044, -122.2712, 'America/Los_Angeles') ON CONFLICT DO NOTHING`);
}
async function agent(message: string, o: { dry?: boolean; recent?: string } = {}) {
  const G = await import("../../src/harness/replyGrounding.js");
  const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
  const { LOOP_GUIDE } = await import("../../src/agent/loop.js");
  const facts = G.baseReplyFacts();
  G.addFact(facts, "known", "They live in San Francisco.");
  G.addInstruction(facts, LOOP_GUIDE);
  const sent: string[] = [];
  const r: any = await runConversationReplyAgent(
    { ackSent: null, userId: ID.A, phoneNumber: PHONE.A, firstName: NAME.A, resolvedContent: message, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: o.recent ?? "", recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async (p: any) => { sent.push(p.message); return true; } } as any,
    { dryRun: o.dry ?? true, record: false, stubSearch: false },
  );
  return { text: String(r.replyText ?? ""), sent, tools: r.toolsCalled ?? [], receipts: facts.facts.filter((f: any) => f.kind === "did_this_turn" || f.kind === "not_done").map((f: any) => f.text), grounding: (r.grounding ?? []).map((g: any) => ({ outcome: g.outcome, failed: (g.checks ?? []).filter((c: any) => !c.pass).map((c: any) => c.reason ?? c.name) })) };
}
function looseTools() {
  return import("../../src/agent/loopTools.js").then(async (LT) => {
    const facts: [string, string][] = [];
    const notDone: string[] = [];
    const ctx: any = { userId: ID.A, phoneNumber: PHONE.A, dryRun: true, stubSearch: false, sendCoReply: async () => true, facts: { add: (k: string, t: string) => facts.push([k, t]) }, turn: { profile: { city: "San Francisco" } } };
    return { LT, facts, notDone, make: (started = Date.now()) => { const loop = LT.newLoopState(started); return { loop, tools: LT.loopTools(ctx, { sent: false, sentMessages: [] }, loop, (w: string) => notDone.push(w)) as any }; } };
  });
}

export const search: Case[] = [
  {
    suite: "search", id: "search-event-fit",
    replaced: ["Luma calendar + discover feed: fixtures at the HTTP boundary"],
    run: async () => {
      await member("A"); await geo();
      feeds(
        [{ id: "evt-own-1", name: "Co Founders Supper", start: day(1), end: day(1, 22), slug: "co-supper", city: "San Francisco" }],
        [
          { id: "pub-dinner", name: "Small Founder Dinner: Climate Builders", start: day(2), slug: "climate-dinner", city: "San Francisco" },
          { id: "pub-nyc", name: "NYC Founder Dinner", start: day(2), slug: "nyc-dinner", city: "New York" },
          { id: "pub-past", name: "Founder Dinner (last week)", start: day(-6), slug: "old-dinner", city: "San Francisco" },
          { id: "evt-own-1", name: "Co Founders Supper", start: day(1), slug: "co-supper", city: "San Francisco" },
        ],
      );
      const { eventCandidates } = await import("../../src/services/tieredRecommendation.js");
      const r = await eventCandidates("small founder dinner", "San Francisco", { when: "this week", userId: ID.A, timezone: "America/Los_Angeles", limit: 8 });
      const ids = r.candidates.map((c: any) => (c.match as any).event_api_id ?? c.match.name);
      const own = r.candidates.find((c: any) => (c.match as any).event_api_id === "evt-own-1");
      const reply = await agent("any small founder dinners in SF this week?");
      return {
        checks: [
          ck("Co's own event comes back as Tier 1 (co_event) with its id and date", !!own && own.match.tier === 1 && (own.match as any).kind === "co_event" && !!(own.match as any).event_date, own?.match),
          ck("the same id from the public feed isn't added again", ids.filter((x: string) => x === "evt-own-1").length === 1, ids),
          ck("the fitting public dinner is a Tier 2 candidate with its id", r.candidates.some((c: any) => (c.match as any).event_api_id === "pub-dinner" && c.match.tier === 2), ids),
          ck("past and distant-city events are left out", !ids.includes("pub-past") && !ids.includes("pub-nyc"), ids),
          ck("the reply searched events and names something real from the feed", reply.tools.includes("searchEvents") && /Supper|Climate Builders|Founder Dinner/i.test(reply.text + reply.sent.join(" ")), { tools: reply.tools, text: reply.text }),
        ],
        texts: { reply: reply.text, sentDuringTurn: reply.sent },
        observed: { candidates: r.candidates.map((c: any) => ({ id: (c.match as any).event_api_id, tier: c.match.tier, name: c.match.name, lines: c.lines })), turnedAway: r.turnedAway, receipts: reply.receipts, grounding: reply.grounding },
      };
    },
  },
  {
    suite: "search", id: "search-empty-fallback", mode: "fixture-live",
    replaced: ["Luma feeds: empty fixtures. Web search is the real Anthropic server tool (live); page reads blocked"],
    run: async () => {
      await member("A");
      feeds([], []);
      const reply = await agent("anything for founders in SF this week? dinners, small meetups, whatever");
      const searched = reply.tools.filter((t: string) => /search/i.test(t));
      return {
        checks: [
          ck("it searched (receipts record what ran)", searched.length >= 1 && reply.receipts.some((r: string) => /Searched|search/i.test(r)), { tools: reply.tools, receipts: reply.receipts }),
          ck("no claim it didn't search after a real receipt", !/(didn'?t|haven'?t|couldn'?t) (search|look)/i.test(reply.text), reply.text),
          ck("no find named that no tool returned", !reply.tools.includes("shareFinds") || reply.receipts.some((r: string) => /held up|found/i.test(r)), { tools: reply.tools }),
        ],
        texts: { reply: reply.text, sent: reply.sent },
        observed: { receipts: reply.receipts, grounding: reply.grounding, blockedPageReads: H.unexpectedNet.filter((n) => n.caseId === H.caseId).length },
      };
    },
    allowRefusals: false,
  },
  {
    suite: "search", id: "search-web-verified", mode: "model-free", runs1: true,
    run: async () => {
      const TW = await import("../../src/services/taskWeb.js");
      const LT = await import("../../src/agent/loopTools.js");
      const now = new Date();
      const page = "Wave Gallery. Private events in the Mission. Capacity: 120 standing, 60 seated. Evening buyout $1,800 for four hours. Bookings open for October.";
      const ok = TW.verifyResult({ name: "Wave Gallery", url: "https://wave.invalid/events", details: [{ label: "capacity", value: "120 standing" }, { label: "price", value: "$1,800 for four hours" }, { label: "capacity", value: "300 standing" }] } as any, page, { now, official: true });
      const nameless = TW.verifyResult({ name: "Mystery Loft", url: "https://wave.invalid/events", details: [] } as any, page, { now, official: true });
      const gone = TW.verifyResult({ name: "Old Hall", url: "https://oldhall.invalid", details: [] } as any, "Old Hall is permanently closed. Thanks for 20 years.", { now, official: true });
      const expired = TW.verifyResult({ name: "Climate Fellowship", url: "https://fellowship.invalid", details: [], deadline: "2026-01-15" } as any, "Climate Fellowship applications for 2026.", { now, official: true });
      const caption = LT.captionProblems("Holds 300 and costs $900, available Oct 10.", "capacity: 120 standing; price: $1,800 for four hours", "");
      return {
        checks: [
          ck("supported facts kept, the unsupported capacity dropped", !!ok.kept && ok.kept.facts.some((f) => /120 standing/.test(f)) && ok.kept.facts.some((f) => /1,800/.test(f)) && !ok.kept.facts.some((f) => /300/.test(f)) && ok.droppedDetails.some((d) => /300/.test(d.detail)), ok),
          ck("a name not on the page is dropped", !nameless.kept, nameless.dropped),
          ck("a closed place is dropped with the page's words", !gone.kept && /permanently closed/i.test(gone.dropped?.why ?? ""), gone.dropped),
          ck("an opportunity past its deadline is dropped", !expired.kept, expired.dropped),
          ck("blocked listing hosts can't be checked", TW.cantCheck("www.yelp.com") && TW.cantCheck("gigsalad.com") && !TW.cantCheck("peerspace.com")),
          ck("a caption's unsupported capacity, price and availability are caught", caption.length >= 2, caption),
        ],
        observed: { secondReader: "checkVerified (Jev, Haiku fallback) runs only in live webSearch; exercised in search-source-live" },
      };
    },
  },
  {
    suite: "search", id: "search-refine-notes",
    replaced: ["Luma feeds: empty fixtures; sends captured; web search live"],
    run: async () => {
      await member("A"); await geo();
      feeds([], []);
      const t1 = await agent("I need a venue in SF for 120 people on Oct 10, budget around $3k, about 4 hours", { dry: false });
      await settle();
      const b1 = (await rows(`SELECT brief FROM search_briefs WHERE user_id = $1`, [ID.A]))[0]?.brief;
      const recent = `User said: I need a venue in SF for 120 people on Oct 10, budget around $3k, about 4 hours\nCo replied: ${t1.text}`;
      const t2 = await agent("actually make it 80 people and Oakland works better", { dry: false, recent });
      await settle();
      const b2 = (await rows(`SELECT brief FROM search_briefs WHERE user_id = $1`, [ID.A]))[0]?.brief;
      const all = (t2.text + " " + t2.sent.join(" "));
      return {
        checks: [
          ck("first turn saved its notes (headcount, budget, hours, date)", b1 && b1.headcount === 120 && Number(b1.budget) >= 2500 && b1.hours === 4, b1),
          ck("the change refines the same notes: 80 people, Oakland", b2 && b2.headcount === 80 && /oakland/i.test(`${b2.city ?? ""} ${b2.area ?? ""}`), b2),
          ck("the old 120 isn't silently kept", b2?.headcount !== 120 && !/\b120\b/.test(all), { b2, all }),
          ck("a total is called an estimate unless a page states a final price", !/total (is|will be) \$|final price/i.test(all) || /estimate|about|roughly|around/i.test(all), all),
        ],
        texts: { turn1: t1.text, turn1Sent: t1.sent, turn2: t2.text, turn2Sent: t2.sent },
        observed: { b1, b2, tools1: t1.tools, tools2: t2.tools },
      };
    },
  },
  {
    suite: "search", id: "search-budgets-timeout", mode: "model-free", runs1: true,
    run: async () => {
      await member("A");
      const W = await import("../../src/services/webOpportunitySearch.js");
      const TW = await import("../../src/services/taskWeb.js");
      // The shared daily budget, pre-spent in the TEMP log only.
      await rows(`INSERT INTO web_search_log (user_id, source, query) SELECT $1, 'sweep', 'seed ' || g FROM generate_series(1, 400) g`, [ID.A]);
      const before = H.providerRequests.anthropic;
      const res = await W.reserveWebSearch(ID.A, "request", "venue");
      const tw = await TW.taskWebSearch(ID.A, "venue for 80 in Oakland", { source: "request" });
      const { make } = await looseTools();
      const s1 = make();
      const r1 = await s1.tools.webSearch.execute({ queries: ["venue oakland", "venue oakland", " venue oakland "] });
      const afterDup = s1.loop.webQueries;
      const r2 = await s1.tools.webSearch.execute({ queries: ["a b c", "d e f", "g h i"] });
      const r3 = await s1.tools.webSearch.execute({ queries: ["j k l", "m n o"] });
      const r4 = await s1.tools.webSearch.execute({ queries: ["p q r"] });
      // Reservation itself fails.
      await rows(`DELETE FROM web_search_log`);
      DBC.faults = [/FROM web_search_log WHERE created_at > NOW\(\) - INTERVAL '1 day'/];
      const failRes = await W.reserveWebSearch(ID.A, "request", "x");
      DBC.faults = [];
      // Over time.
      const late = make(Date.now() - 76_000);
      const r5 = await late.tools.webSearch.execute({ queries: ["late one"] });
      const providerCalls = H.providerRequests.anthropic - before;
      return {
        checks: [
          ck("an exhausted budget refuses, with a reason", !res.ok && !!res.reason, res),
          ck("taskWebSearch says so plainly and calls no provider", /^No web search right now/.test(tw.note) && tw.kept.length === 0, tw.note),
          ck("duplicate queries count once", afterDup === 1, { afterDup }),
          ck(`at most the turn's web budget, then a plain refusal`, s1.loop.webQueries <= 4 && r4?.ok === false && /No web searches left/i.test(r4?.error ?? ""), { webQueries: s1.loop.webQueries, r4 }),
          ck("budget-exhausted tool result tells Co to say so, not 'nothing found'", r1?.ok === false && /used up/i.test(r1?.error ?? ""), r1),
          ck("a failed reservation means no search", !failRes.ok && /couldn't be checked/.test(failRes.reason ?? ""), failRes),
          ck("past 75 seconds: no new search", r5?.ok === false && /Out of time/i.test(r5?.error ?? ""), r5),
          ck("zero provider calls in this case", providerCalls === 0, { providerCalls }),
        ],
        observed: { r2, r3, limits: "LOOP_BUDGET.webSearches is enforced by the webSearch tool; eventSearches/pageReads checked separately (see report)" },
      };
    },
  },
  {
    suite: "search", id: "search-source-live", mode: "source-live", runs1: true,
    run: async () => {
      await member("A");
      H.sourceLive = true;
      H.respond = null;
      try {
        const { fetchPublicEvents } = await import("../../src/services/lumaDiscovery.js");
        const feed = await fetchPublicEvents(20, null, new Date(Date.now() + 7 * 86_400_000)).catch((e: any) => ({ error: String(e?.message ?? e) }));
        const TW = await import("../../src/services/taskWeb.js");
        const web = await TW.taskWebSearch(ID.A, "founder dinner San Francisco October 2026", { city: "San Francisco", source: "request", skipBudget: false });
        const { checkVerified } = await import("../../src/services/factCheck.js");
        const second = await checkVerified(web.kept).catch((e: any) => ({ error: String(e?.message ?? e) }));
        await settle();
        return {
          checks: [
            ck("the public feed answered (or the error is recorded)", Array.isArray(feed) || !!(feed as any).error, feed),
            ck("every kept web result is a real URL with page facts", web.kept.every((k) => /^https?:\/\//.test(k.url) && k.facts.length > 0), web.kept),
            ck("the budget was reserved in the TEMP log", (await rows(`SELECT count(*)::int AS n FROM web_search_log`))[0].n >= 1),
          ],
          observed: {
            feed: Array.isArray(feed) ? feed.slice(0, 8).map((e) => ({ name: e.name, start: e.start_at, url: e.url })) : feed,
            web: { kept: web.kept.map((k) => ({ name: k.name, url: k.url, facts: k.facts, excerpts: (k.excerpts ?? []).map((x) => x.slice(0, 300)) })), dropped: web.dropped.slice(0, 8), note: web.note },
            secondReader: second,
            urlsRead: H.sourceUrls.slice(0, 40),
          },
        };
      } finally {
        H.sourceLive = false;
      }
    },
  },
];
