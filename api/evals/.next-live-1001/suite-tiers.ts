// Suite 7: recommendation tiers (tieredRecommendation TierMatch: 1 Co event,
// 2 public event, 3 opening) and outcome feedback. Tier 0 is only the intro
// discriminator in follow-ups, never a recommendation tier. No membership-tier
// ladder exists in the inspected code, so none is claimed.
import "../lib/requireMeter.js";
import { H } from "./boot.js";
import { member, rows, ck, ID, PHONE, NAME, type Case } from "./fixtures.js";

// Local (Pacific) evening n days from today, as UTC ISO.
const localDay = (n: number, hour = 19) => { const d = new Date(); const base = new Date(d.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })); base.setDate(base.getDate() + n); base.setHours(hour, 0, 0, 0); return new Date(base.getTime() + (d.getTime() - new Date(d.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })).getTime())).toISOString(); };
function feeds(own: any[], pub: any[]) {
  H.respond = (t, path) => {
    if (t !== "luma") return null;
    if (path.startsWith("/v1/calendars/events/list")) return { status: 200, body: { entries: own.map((e) => ({ event: { id: e.id, name: e.name, start_at: e.start, end_at: null, url: `https://lu.ma/${e.id}`, timezone: "America/Los_Angeles", geo_address_json: { city: "San Francisco" } } })), has_more: false } };
    if (path.startsWith("/discover/get-paginated-events")) return { status: 200, body: { entries: pub.map((e) => ({ event: { api_id: e.id, name: e.name, start_at: e.start, url: e.id, geo_address_info: { city: "San Francisco" } } })), has_more: false } };
    return { status: 200, body: { entries: [], has_more: false } };
  };
}
const idOf = (c: any) => (c.match as any).event_api_id ?? null;

export const tiers: Case[] = [
  {
    suite: "tiers", id: "tier-shapes", runs1: true,
    replaced: ["Luma calendar + discover: fixtures"],
    run: async () => {
      await member("A");
      feeds([{ id: "evt-own-t", name: "Co Founders Supper", start: localDay(1) }], [{ id: "pub-t", name: "Founder Dinner: Climate Builders", start: localDay(2) }]);
      const { eventCandidates } = await import("../../src/services/tieredRecommendation.js");
      const r = await eventCandidates("founder dinner", "San Francisco", { when: "next 7 days", userId: ID.A, timezone: "America/Los_Angeles", limit: 8 });
      const t1 = r.candidates.find((c: any) => c.match.tier === 1)?.match as any, t2 = r.candidates.find((c: any) => c.match.tier === 2)?.match as any;
      // Tier 3, as the loop builds it (agent/loopTools.ts webSearch): no event id, dates only if stated.
      const t3 = { tier: 3, kind: "opportunity", source: "web", name: "Climate Fellowship", url: "https://fellowship.invalid", reason: "deadline: 2026-10-20", statedDates: { start: "2026-10-20" } } as any;
      return {
        checks: [
          ck("Tier 1: co_event with event_api_id and event_date", t1?.kind === "co_event" && t1.event_api_id === "evt-own-t" && /^\d{4}-\d{2}-\d{2}/.test(String(t1.event_date)), t1),
          ck("Tier 2: public_event with event_api_id, event_date and url", t2?.kind === "public_event" && t2.event_api_id === "pub-t" && !!t2.event_date && /^https?:\/\//.test(t2.url ?? ""), t2),
          ck("Tier 3: an opportunity with no event id or invented deadline", t3.kind === "opportunity" && !("event_api_id" in t3) && !t3.deadline),
        ],
        observed: { candidates: r.candidates.map((c: any) => c.match), turnedAway: r.turnedAway, window: r.window },
      };
    },
  },
  {
    suite: "tiers", id: "tier-co-feed-dedupe", mode: "model-free", runs1: true,
    replaced: ["Luma calendar + discover: fixtures"],
    run: async () => {
      await member("A");
      feeds([{ id: "evt-dup", name: "Co Founders Supper", start: localDay(1) }], [{ id: "evt-dup", name: "Co Founders Supper", start: localDay(1) }, { id: "pub-look", name: "Co Founders Supper", start: localDay(1) }]);
      const { eventCandidates } = await import("../../src/services/tieredRecommendation.js");
      const r = await eventCandidates("founders supper", "San Francisco", { when: "next 7 days", userId: ID.A, timezone: "America/Los_Angeles", limit: 8 });
      const ids = r.candidates.map(idOf);
      return {
        checks: [
          ck("the shared id appears once, as Co's own event", ids.filter((x: string) => x === "evt-dup").length === 1 && r.candidates.find((c: any) => idOf(c) === "evt-dup")?.match.tier === 1, r.candidates.map((c: any) => [idOf(c), c.match.tier])),
          ck("a lookalike with a different id stays its own event", ids.includes("pub-look"), ids),
        ],
        observed: { turnedAway: r.turnedAway },
      };
    },
  },
  {
    suite: "tiers", id: "tier-source-fit", runs1: true,
    replaced: ["Luma feeds: fixtures; web search live; page reads blocked"],
    run: async () => {
      await member("A", { profile: { goals: ["meet other climate founders"] } });
      feeds([{ id: "evt-knit", name: "Co Knitting Circle", start: localDay(1) }], [{ id: "pub-climate", name: "Climate Founders Dinner", start: localDay(2) }]);
      const G = await import("../../src/harness/replyGrounding.js");
      const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
      const { LOOP_GUIDE } = await import("../../src/agent/loop.js");
      const facts = G.baseReplyFacts();
      G.addFact(facts, "known", "They live in San Francisco.");
      G.addInstruction(facts, LOOP_GUIDE);
      const r: any = await runConversationReplyAgent({ ackSent: null, userId: ID.A, phoneNumber: PHONE.A, firstName: NAME.A, resolvedContent: "anything this week where I'd meet other climate founders?", isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "", recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true } as any, { dryRun: true, record: false, stubSearch: false });
      const text = String(r.replyText ?? "");
      return {
        checks: [
          ck("the fitting public dinner is offered over Co's own off-topic event", /Climate Founders Dinner/i.test(text) && !/Knitting/i.test(text), text),
          ck("no claim of exclusivity it can't back", !/exclusive|invite-only|members only/i.test(text) || /Co/i.test(text), text),
        ],
        texts: { reply: text },
        observed: { tools: r.toolsCalled, receipts: facts.facts.filter((f: any) => f.kind === "did_this_turn").map((f: any) => f.text) },
      };
    },
  },
  {
    suite: "tiers", id: "tier-outcome-date", mode: "model-free", runs1: true,
    run: async () => {
      await member("A");
      const R = await import("../../src/services/recommendationOutcome.js");
      await R.scheduleOutcomeFollowUp(ID.A, "dinners", { tier: 1, kind: "co_event", name: "Co Supper", event_api_id: "e1", event_date: "2026-10-10" } as any);
      await R.scheduleOutcomeFollowUp(ID.A, "dinners", { tier: 2, kind: "public_event", name: "Public Dinner", event_api_id: "e2", event_date: "2026-10-12", url: "https://lu.ma/e2" } as any);
      await R.scheduleOutcomeFollowUp(ID.A, "fellowships", { tier: 3, kind: "opportunity", name: "Demo Week", url: "https://x.invalid", statedDates: { start: "2026-10-14", end: "2026-10-16" } } as any);
      await R.scheduleOutcomeFollowUp(ID.A, "fellowships", { tier: 3, kind: "opportunity", name: "Open Fellowship", url: "https://y.invalid" } as any);
      await R.scheduleOutcomeFollowUp(ID.A, "dinners", { tier: 2, kind: "public_event", name: "Undated Dinner", event_api_id: "e3", url: "https://lu.ma/e3" } as any);
      await R.scheduleOutcomeFollowUp(ID.A, "dinners", { tier: 1, kind: "co_event", name: "co supper", event_api_id: "e1", event_date: "2026-10-10" } as any);
      const f = await rows(`SELECT match_name, tier, send_at, (send_at - NOW()) AS from_now FROM recommendation_outcome_followups WHERE user_id = $1 ORDER BY match_name`, [ID.A]);
      const at = (n: string) => f.find((r: any) => r.match_name === n);
      const iso = (r: any) => r && new Date(r.send_at).toISOString();
      const nowMs = (await rows(`SELECT NOW() AS n`))[0].n;
      return {
        checks: [
          ck("Tier 1: the day after the event, 11:00", iso(at("Co Supper"))?.startsWith("2026-10-11T"), at("Co Supper")),
          ck("Tier 2: the day after the event", iso(at("Public Dinner"))?.startsWith("2026-10-13T"), at("Public Dinner")),
          ck("Tier 3 with stated dates: the day after the last day", iso(at("Demo Week"))?.startsWith("2026-10-17T"), at("Demo Week")),
          ck("undated Tier 3: 5 days out", !!at("Open Fellowship") && Math.round((new Date(at("Open Fellowship").send_at).getTime() - new Date(nowMs).getTime()) / 86_400_000) === 5, at("Open Fellowship")),
          ck("Tier 1/2 without a usable date: nothing scheduled", !at("Undated Dinner"), f),
          ck("the same event again (any name case): one follow-up", f.filter((r: any) => /co supper/i.test(r.match_name)).length === 1, f),
        ],
        observed: { note: "send_at = date + 1 day 11 hours in the database session's time zone (not the member's).", rows: f },
      };
    },
  },
  {
    suite: "tiers", id: "tier-bias-isolation", mode: "model-free", runs1: true,
    run: async () => {
      await member("A"); await member("B"); await member("C");
      const R = await import("../../src/services/recommendationOutcome.js");
      const empty = await R.getTierBias(ID.C);
      await R.recordOutcome(ID.A, "f1", 1, "named_positive");
      await R.recordOutcome(ID.A, "f2", 1, "named_positive");
      await R.recordOutcome(ID.A, "f3", 2, "named_critical");
      await R.recordOutcome(ID.A, "f4", 3, "not_mentioned");
      await R.recordOutcome(ID.A, "f5", 3, "unrelated");
      await R.recordOutcome(ID.A, "f6", 0, "named_positive"); // an intro follow-up
      await R.recordOutcome(ID.B, "f7", 2, "named_positive");
      const F = await import("../../src/services/eventCheckinFollowUp.js");
      await F.recordEventCheckinOutcome(ID.A, "f8", "evt-x", "named_critical" as any);
      const a = await R.getTierBias(ID.A), b = await R.getTierBias(ID.B);
      return {
        checks: [
          ck("starts at zero for everyone", JSON.stringify(empty) === JSON.stringify({ 1: 0, 2: 0, 3: 0 }), empty),
          ck("only named outcomes move their own tier", a[1] === 2 && a[2] === -1 && a[3] === 0, a),
          ck("intro (tier 0) and event check-in outcomes don't touch tier bias", !("0" in a) && a[2] === -1, a),
          ck("another member's outcomes don't leak in", b[2] === 1 && b[1] === 0 && a[2] === -1, { a, b }),
        ],
      };
    },
  },
  {
    suite: "tiers", id: "tier-three-repeat", mode: "model-free", runs1: true,
    run: async () => {
      await member("A");
      const M = await import("../../src/harness/matchGate.js");
      const now = new Date("2026-10-02T18:00:00Z"), today = "2026-10-02";
      const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
      const opp = (date: string | null) => ({ isEvent: false, date, shortNotice: false });
      const r = (h: any, m = opp("2026-10-20")) => M.repeatRule({ answered: false, outcome: null, ...h }, m, today, now).action;
      const repeat = {
        never: r({ shownAt: [] }),
        recent: r({ shownAt: [ago(2)] }),
        old: r({ shownAt: [ago(M.RESURFACE_AFTER_DAYS + 1)] }),
        twice: r({ shownAt: [ago(20), ago(M.RESURFACE_AFTER_DAYS + 1)] }),
        declined: r({ shownAt: [ago(20)], outcome: "declined" }),
        interestedSoon: r({ shownAt: [ago(20)], outcome: "interested" }, opp("2026-10-04")),
        past: r({ shownAt: [ago(20)] }, opp("2026-09-30")),
        sameDayRecords: M.countShowings([ago(10), new Date(ago(10).getTime() + 3600_000)]).length,
      };
      // History lookup by name: an exact rename-in-case matches; a slight rename doesn't.
      const { generateEmbedding } = await import("../../src/services/embeddings.js");
      await rows(`INSERT INTO tier3_offered_opportunities (user_id, name, embedding) VALUES ($1, 'Climate Fellowship', $2::vector)`, [ID.A, `[${(await generateEmbedding("Climate Fellowship")).join(",")}]`]);
      const same = await M.offerHistory(ID.A, { tier: 3, kind: "opportunity", name: "climate fellowship", url: "u", reason: "" } as any);
      const renamed = await M.offerHistory(ID.A, { tier: 3, kind: "opportunity", name: "Climate Fellowship 2026", url: "u", reason: "" } as any);
      return {
        checks: [
          ck("never shown: new", repeat.never === "new"),
          ck(`shown 2 days ago, unanswered: held until ${M.RESURFACE_AFTER_DAYS} days`, repeat.recent === "blocked"),
          ck("shown long ago, never answered, still open: may resurface once", repeat.old === "resurface"),
          ck("already came back once: no more", repeat.twice === "blocked"),
          ck("declined: never again", repeat.declined === "blocked"),
          ck(`interested with a deadline ${M.OPPORTUNITY_REMINDER_DAYS ?? "few"} days out: one reminder`, repeat.interestedSoon === "remind"),
          ck("past its date: blocked", repeat.past === "blocked"),
          ck("several records the same day are one showing", repeat.sameDayRecords === 1),
          ck("the same opening in another case is recognized", same.shownAt.length >= 1, same),
        ],
        observed: { repeat, renamedOpeningSeenBefore: renamed.shownAt.length >= 1, note: "A slight rename ('Climate Fellowship 2026') is matched by exact lower-case name only." },
      };
    },
  },
  {
    suite: "tiers", id: "tier-best-per-source", mode: "model-free", runs1: true,
    run: async () => {
      const SR = await import("../../src/services/searchRules.js");
      const SW = await import("../../src/services/eventSurfacingSweep.js");
      const ms = [1, 1, 1, 1, 2, 2, 3].map((tier, i) => ({ tier, name: `m${i}` }));
      const order = SR.triesInOrder(ms, 5).map((m) => m.tier);
      const items = ms.map((m) => ({ match: m }));
      const inter = SW.interleaveByTier(items, 1).map((x) => x.match.tier);
      return {
        checks: [
          ck("first of each tier leads, then the rest, capped", JSON.stringify(order.slice(0, 3)) === JSON.stringify([1, 2, 3]) && order.length === 5, order),
          ck("interleaving after a Tier 1 send doesn't lead with Tier 1", inter[0] !== 1, inter),
        ],
        observed: { order, interleaved: inter, note: "Reply-loop finds aren't ordered by this helper; it serves the task/voice/sweep pipeline." },
      };
    },
  },
];
