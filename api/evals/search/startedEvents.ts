// A reply never offers an event that already started, or one starting too soon to get to (Royce, 2026-10-17: "Replies drop events
// that have already started, with a lead-time check on top of the day check. ... Angel Island was offered after it started, that's
// the case."). On 10-17 at 10:18 Pacific Cue texted "Builders who Run SF, the 5M run and BBQ at Angel Island, is today": it started
// at 9:30. The day check passed it ("happening today"). Zero tokens, no database, nothing sent.
//   npx tsx evals/search/startedEvents.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import { readFileSync } from "fs";
const G = await import("../../src/harness/matchGate.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};

const ZONE = "America/Los_Angeles";
const NOW = new Date("2026-10-17T17:18:00Z"); // 10:18 Pacific, when it went out
// The real events from that morning's SF search (Luma's own start times).
const ANGEL = { tier: 2, kind: "public_event", event_api_id: "evt-angel", event_date: "2026-10-17", startAt: "2026-10-17T16:30:00.000Z", name: "Builders who Run SF — 5M Run & BBQ at Angel Island", url: "https://lu.ma/m0oexu2k", reason: "A public event.", city: "San Francisco" } as any;
const FESTIVAL = { tier: 2, kind: "public_event", event_api_id: "evt-fest", event_date: "2026-10-17", startAt: "2026-10-17T21:00:00.000Z", name: "Festival of the Irrational by Caterina Fake", url: "https://lu.ma/tlgd6iqr", reason: "A public event.", city: "San Francisco" } as any;
const SOON = { ...FESTIVAL, event_api_id: "evt-soon", name: "A talk starting in 30 minutes", url: "https://lu.ma/soon", startAt: new Date(NOW.getTime() + 30 * 60_000).toISOString() };
const facts = (o: Partial<import("../../src/harness/matchGate.js").MatchFacts> = {}) => ({ searchCity: null, distanceMiles: null, alreadyOffered: false, now: NOW, zone: ZONE, ...o }) as any;

// ---------------------------------------------------------------- the start itself
check("Angel Island at 10:18: already started (9:30 AM)", G.startProblem(ANGEL.startAt, NOW, 60, ZONE) === "it already started (9:30 AM)", G.startProblem(ANGEL.startAt, NOW, 60, ZONE));
check("30 minutes out, with the hour's lead: too soon to get there", /starts at 10:48 AM, under 60 minutes from now/.test(G.startProblem(SOON.startAt, NOW, G.START_LEAD_MINUTES, ZONE) ?? ""));
check("2pm the same day is fine", G.startProblem(FESTIVAL.startAt, NOW, 60, ZONE) === null);
check("no lead given (the sweep): started is still a no, soon is not", G.startProblem(ANGEL.startAt, NOW, null, ZONE) !== null && G.startProblem(SOON.startAt, NOW, null, ZONE) === null);
check("no start on record: nothing to say (the day check decides)", G.startProblem(null, NOW, 60, ZONE) === null && G.startProblem("not a date", NOW, 60, ZONE) === null);
check("the lead is an hour", G.START_LEAD_MINUTES === 60);

// ---------------------------------------------------------------- on top of the day check
check("the day check alone passed it (the 10-17 gap): today, no start known", G.checkTiming({ ...ANGEL, startAt: undefined }, facts()).pass === true);
check("with its start: refused, saying why", G.checkTiming(ANGEL, facts()).pass === false && /already started/.test(G.checkTiming(ANGEL, facts()).reason ?? ""));
check("the start from its page details counts too", G.checkTiming({ ...ANGEL, startAt: undefined, details: { startAt: ANGEL.startAt } }, facts()).pass === false);
check("too soon only where the caller asks for the lead", G.checkTiming(SOON, facts({ leadMinutes: 60 })).pass === false && G.checkTiming(SOON, facts()).pass === true);
{
  const out: any[] = [];
  const kept = await G.gateMatches([ANGEL, FESTIVAL, SOON], { userId: null, searchCity: null, now: NOW, zone: ZONE, leadMinutes: G.START_LEAD_MINUTES, gatedOut: out });
  check("the reply's search keeps the 2pm festival and turns the run and the 30-minute talk away, with the reasons", kept.map((m) => m.name).join() === FESTIVAL.name && out.length === 2 && out.every((o) => o.reasons.some((r: string) => /already started|too soon/.test(r))), { kept: kept.map((m) => m.name), out });
}
{
  const src = readFileSync(new URL("../../src/services/tieredRecommendation.ts", import.meta.url), "utf8");
  check("the reply's search reads each page first, then the gate judges the start with the page's end and online flag, and logs a late one as turned away (pinned in the source)", /startAt: e\.start_at,/.test(src) && /\.\.\.\(details\?\.startAt \? \{ startAt: details\.startAt \} : \{\}\), details \} as TierMatch;/.test(src) && /const gated = await (?:src\.gate|gateMatches)\(read, \{ userId: opts\.userId \?\? null, searchCity: city, checkRepeat: true, gatedOut: turnedAway, .*leadMinutes: START_LEAD_MINUTES \}\);/.test(src));
}

// ---------------------------------------------------------------- and again as it goes out
{
  const L = await import("../../src/agent/loopTools.js");
  const ctx = { userId: "u", phoneNumber: "+14155550101", resolvedContent: "Anything you have for me in SF?", isVoice: false, dryRun: true, sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any;
  const loop = L.newLoopState(Date.now());
  const tools = L.loopTools(ctx, { sent: false, sentMessages: [] }, loop, () => {}) as any;
  // Found while it was still ahead; it started before it was sent (now, by the real clock, both are long past).
  for (const m of [ANGEL]) loop.found.set(m.url, { name: m.name, url: m.url, facts: "Saturday 9:30 AM, Angel Island.", match: m, blocked: null });
  const r = await tools.shareFinds.execute({ items: [{ link: ANGEL.url, caption: "A 5M run with builders, then BBQ on Angel Island." }] }, { toolCallId: "a", messages: [] });
  check("a find that has started is refused as it goes, with why, and nothing is shared", !loop.shared.includes(ANGEL.url) && /already started/.test(JSON.stringify(r)), r);
}

// ================================================================ everywhere else Cue offers an event (Royce, 2026-10-17: "Add a
// lead-time check wherever Cue offers an event, reply path first"). The rule is one pure function (services/eventStart.ts).
const E = await import("../../src/services/eventStart.js");
const S = await import("../../src/services/sendCheck.js");
const ES = await import("../../src/services/eventSurfacingSweep.js");
const PS = await import("../../src/services/planSheet.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();
const page = (o: any = {}) => ({ startAt: ANGEL.startAt, endAt: "2026-10-17T20:00:00.000Z", timezone: ZONE, online: false, venue: "Angel Island", address: null, city: "San Francisco", hosts: [], price: null, spotsRemaining: null, requiresApproval: false, soldOut: false, guestCount: null, description: null, ...o });
const deps = (d: any) => {
  const facts: any[] = [];
  return { facts, deps: { luma: async () => d, page: async () => ({ text: null, gone: false }), now: () => NOW, writeFact: async (e: any) => { facts.push(e); }, saveMatch: async () => {}, saveDefers: async () => {} } as any };
};
const queued = (m: any) => ({ id: "c1", userId: "u1", payload: { askId: "a1", askText: "something outdoors this weekend", fromProfile: false, match: m } });

// ---------------------------------------------------------------- the one rule
check("one rule: a same-day event that started is a no, whatever its end (the run ends at 1pm)", E.eventStartProblem({ startAt: ANGEL.startAt, endAt: "2026-10-17T20:00:00.000Z" }, NOW, 60, ZONE) === "it already started (9:30 AM)");
check("an event that runs a day or more (a festival) is still on until it ends: started yesterday is fine, ended is a no", E.eventStartProblem({ startAt: "2026-10-16T17:00:00.000Z", endAt: "2026-10-19T03:00:00.000Z" }, NOW, 60, ZONE) === null && /already ended/.test(E.eventStartProblem({ startAt: "2026-10-14T17:00:00.000Z", endAt: "2026-10-16T03:00:00.000Z" }, NOW, 60, ZONE) ?? ""));
check("an opening has no start: never refused by this", E.matchStartProblem({ tier: 3, kind: "opportunity", name: "Grant", url: "https://x", reason: "r", deadline: "2026-10-17" } as any, NOW, 60, ZONE) === null);
check("the gate re-exports the same rule", G.startProblem === E.startProblem && G.START_LEAD_MINUTES === E.START_LEAD_MINUTES);

// ---------------------------------------------------------------- the queue's own window (the sweep and the 9am picks)
check("a queued offer expires an hour before its start, not at it", ES.offerExpiresAt({ ...FESTIVAL, details: page({ startAt: FESTIVAL.startAt, endAt: null }) }, ZONE, NOW).toISOString() === "2026-10-17T20:00:00.000Z", ES.offerExpiresAt({ ...FESTIVAL, details: page({ startAt: FESTIVAL.startAt, endAt: null }) }, ZONE, NOW).toISOString());
check("...from the feed's start when its page wasn't read", ES.offerExpiresAt(FESTIVAL, ZONE, NOW).toISOString() === "2026-10-17T20:00:00.000Z", ES.offerExpiresAt(FESTIVAL, ZONE, NOW).toISOString());
check("too late to queue: the run (started) and the talk (30 minutes out); the 2pm festival is fine", ES.tooLateToOffer(ANGEL, ZONE, NOW) && ES.tooLateToOffer(SOON, ZONE, NOW) && !ES.tooLateToOffer(FESTIVAL, ZONE, NOW));
{
  const sweep = src("services/eventSurfacingSweep.ts");
  check("the 9am pick refuses it before and after its page is read (pinned)", /if \(isPastEvent\(o\.match, zone\) \|\| tooLateToOffer\(o\.match, zone\)\) return "past";/.test(sweep) && /\/\/ Its page's start, read just now, decides too[^\n]*\n  if \(tooLateToOffer\(match, zone\)\) return "past";/.test(sweep));
  check("the sweep never queues it, and drops it from the front of a backlog (pinned)", /if \(tooLateToOffer\(match, zone\)\) \{\n\s+skipped\.push/.test(sweep) && /isPastEvent\(rest\[0\]\.match, zone\) \|\| tooLateToOffer\(rest\[0\]\.match, zone\)/.test(sweep));
  check("the sweep's fact gate asks for the lead (pinned)", /gatedOut, leadMinutes: START_LEAD_MINUTES \}(\)|;)/.test(src("services/sweepFind.ts")));
}

// ---------------------------------------------------------------- at send: every proactive offer (bundle, reveal, reminder, bounce)
{
  // Read 10 minutes ago, when it was still ahead; it has started since. No second read, still refused, and it exits on its fact.
  const fresh = { ...ANGEL, details: page(), checkedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() };
  const { deps: d1, facts } = deps(page());
  const r = await S.checkBeforeSend(queued(fresh), ZONE, d1);
  check("a waiting offer read minutes ago that has since started: not sent, it exits on its fact", "skip" in r && r.exited === true && /already started/.test(r.skip) && facts.length === 1 && facts[0].state === "expired", { r, facts });
  const dry = await S.checkBeforeSend(queued(fresh), ZONE, deps(page()).deps, { dryRun: true });
  check("...a dry run says so and writes nothing", "skip" in dry && /already started/.test(dry.skip));
}
{
  // An older record: its page, read now, says it starts in 30 minutes.
  const { deps: d2 } = deps(page({ startAt: at(30), endAt: at(150) }));
  const r = await S.checkBeforeSend(queued({ ...SOON, details: page({ startAt: at(30), endAt: at(150) }), checkedAt: "2026-10-16T17:00:00.000Z" }), ZONE, d2);
  check("its page read at send says 30 minutes from now: too soon, it exits", "skip" in r && r.exited === true && /too soon/.test(r.skip), r);
}
{
  // The feed had 9:30; the page says it moved to 2pm.
  const { deps: d3 } = deps(page({ startAt: FESTIVAL.startAt, endAt: "2026-10-17T23:00:00.000Z" }));
  const r = await S.checkBeforeSend(queued({ ...ANGEL, details: page(), checkedAt: "2026-10-16T17:00:00.000Z" }), ZONE, d3);
  check("a start the page moved later goes by the page: sent", "ok" in r, r);
}
{
  const { deps: d4 } = deps(page({ startAt: "2026-10-16T17:00:00.000Z", endAt: "2026-10-19T03:00:00.000Z" }));
  const r = await S.checkBeforeSend(queued({ ...FESTIVAL, details: page({ startAt: "2026-10-16T17:00:00.000Z", endAt: "2026-10-19T03:00:00.000Z" }), checkedAt: "2026-10-16T17:00:00.000Z" }), ZONE, d4);
  check("a three-day festival on its second day still goes (the earlier rule: it runs to its end)", "ok" in r, r);
}
{
  const ours = { tier: 1, kind: "co_event", event_api_id: "evt-ours", event_date: "2026-10-17", startAt: ANGEL.startAt, name: "A Noise dinner", reason: "A Noise event." } as any;
  const { deps: d5 } = deps(null);
  const r = await S.checkBeforeSend(queued(ours), ZONE, d5);
  check("a Noise event with no page to read: its start on record decides", "skip" in r && /already started/.test(r.skip), r);
}
{
  const p = src("harness/proactiveRegistry.ts");
  check("the bundle, the single reveal and the bounce all go through checkBeforeSend (pinned)", /async function prepareOffer[\s\S]{0,600}checkBeforeSend\(c, person\.timezone\)/.test(p) && /bounce_proposal:[\s\S]{0,500}checkBeforeSend\(/.test(p) && /S\.checkBeforeSend\(c, about\.timezone/.test(src("harness/proactive.ts")));
}

// ---------------------------------------------------------------- a task's on-file find
{
  const f = { name: "A talk starting in 30 minutes", url: "https://lu.ma/soon", tier: 2, facts: ["date: 2026-10-17"], checkedAt: "2026-10-16T17:00:00.000Z" };
  const { deps: d6 } = deps(page({ startAt: at(30), endAt: at(120) }));
  const r = await S.recheckOnFile("u1", f, ZONE, d6);
  check("a task's on-file event starting in 30 minutes is left out of what it sends", r.ok === false && /too soon/.test((r as any).why), r);
}

// ---------------------------------------------------------------- a tease they said yes to
{
  const sb = src("routes/sendblue.ts");
  check("a yes to a tease after it started (or inside the hour) gets 'too late', never the name or the link (pinned)", /const lateBy = relevantDate && relevantDate < todayStr \? null : matchStartProblem\(match, new Date\(\), START_LEAD_MINUTES, revealZone\);/.test(sb) && /const isStale = \(relevantDate && relevantDate < todayStr\) \|\| !!lateBy;/.test(sb) && /if \(lateBy\) \{[\s\S]{0,600}Never reveal the name/.test(sb));
}

// ---------------------------------------------------------------- calls
check("a call's events come from the reply's own search (so the lead applies), started ones filtered again (pinned)", /eventCandidates\(what, city, \{ when: brief\?\.when \?\? null, userId, limit: 5(, viaExa: false)? \}\)/.test(src("services/voiceFinds.ts")) && /\.filter\(\(\{ match \}\) => stillAhead\(/.test(src("services/voiceFinds.ts")));

// ---------------------------------------------------------------- Noise's own event announcements
{
  const an = src("services/coEventAnnouncement.ts");
  check("a Noise event isn't announced once it started or inside the hour, at creation or when a held one goes (pinned)", /if \(!event \|\| eventStartProblem\(\{ startAt: event\.start_at, endAt: event\.end_at \}, new Date\(\), START_LEAD_MINUTES\) !== null\)/.test(an) && /const late = eventStartProblem\(\{ startAt: event\.start_at, endAt: event\.end_at \}, new Date\(\), START_LEAD_MINUTES\);\n\s+if \(late \|\| r\.opted_out\)/.test(an));
}

// ---------------------------------------------------------------- a plan's event steps
{
  const LINK = "https://lu.ma/soon";
  const rec = (startAt: string) => (l: string): any => (l === LINK ? { name: "A talk", hasRecord: true, startAt, endAt: null, timezone: ZONE, venue: "The Battery", address: "717 Battery St" } : null);
  const input = { title: "Today", note: "A plan.", steps: [{ link: LINK, what: "A talk" }] } as any;
  const probs = (startAt: string) => PS.planProblems(input, PS.resolvePlan(input, ZONE, rec(startAt)), { facts: "The Battery, 717 Battery St", theirs: "", now: NOW, recordFor: rec(startAt) });
  check("a plan can't put on an event starting in 30 minutes (the hour's grace is for their own steps)", probs(at(30)).some((p) => /can't go on a plan \(it starts at/.test(p)), probs(at(30)));
  check("...or one that started 20 minutes ago", probs(at(-20)).some((p) => /can't go on a plan \(it already started/.test(p)), probs(at(-20)));
  check("...and one three hours out is fine", !probs(at(180)).some((p) => /can't go on a plan/.test(p)), probs(at(180)));
}

// ---------------------------------------------------------------- online: 15 minutes, in person: 60 (Royce, 2026-10-17)
{
  const ONLINE = { ...SOON, event_api_id: "evt-online", name: "A webinar", url: "https://lu.ma/webinar", online: true, startAt: at(30) };
  check("Royce: an online event 30 minutes out can still be offered (15 minutes is enough to join)", E.matchStartProblem(ONLINE as any, NOW, E.START_LEAD_MINUTES, ZONE) === null && E.ONLINE_LEAD_MINUTES === 15);
  check("... one 10 minutes out can't", /under 15 minutes from now/.test(E.matchStartProblem({ ...ONLINE, startAt: at(10) } as any, NOW, E.START_LEAD_MINUTES, ZONE) ?? ""));
  check("... online from its page details counts too", E.matchStartProblem({ ...ONLINE, online: undefined, details: { online: true, startAt: at(30) } } as any, NOW, E.START_LEAD_MINUTES, ZONE) === null);
  check("... the same 30 minutes in person is still too soon (60)", /under 60 minutes from now/.test(E.matchStartProblem({ ...ONLINE, online: false } as any, NOW, E.START_LEAD_MINUTES, ZONE) ?? ""));
  check("... started is started, online or not", /already started/.test(E.matchStartProblem({ ...ONLINE, startAt: at(-5) } as any, NOW, E.START_LEAD_MINUTES, ZONE) ?? ""));
  const exp = ES.offerExpiresAt({ ...ONLINE, startAt: at(120) } as any, ZONE, NOW).getTime();
  check("... a queued online offer expires 15 minutes before it, an in-person one 60", exp === new Date(at(105)).getTime() && ES.offerExpiresAt({ ...ONLINE, online: false, startAt: at(120) } as any, ZONE, NOW).getTime() === new Date(at(60)).getTime());
}
// ---------------------------------------------------------------- the review of #229 (2026-10-17)
{
  // Must-fix: the reply path judged the start from the feed alone (no end, no online). Its rule, once the page is read:
  const FEST = { startAt: at(-240), endAt: at(3 * 24 * 60), online: false };
  check("review 1: a festival that started this morning and runs 3 days stays offerable once its page gives the end", E.eventStartProblem(FEST, NOW, E.START_LEAD_MINUTES, ZONE) === null && /already started/.test(E.eventStartProblem({ startAt: FEST.startAt, endAt: null }, NOW, E.START_LEAD_MINUTES, ZONE) ?? ""));
  check("review 2: an online event 30 minutes out passes once its page says online (15, not 60)", E.eventStartProblem({ startAt: at(30), endAt: at(90), online: true }, NOW, E.START_LEAD_MINUTES, ZONE) === null);
  // Should-fix 3: day 2 of a festival isn't expired from the queue on arrival.
  const fest = { ...FESTIVAL, startAt: at(-24 * 60), details: page({ startAt: at(-24 * 60), endAt: at(2 * 24 * 60) }) };
  check("review 3: a queued multi-day event lives until it ends", ES.offerExpiresAt(fest as any, ZONE, NOW).toISOString() === at(2 * 24 * 60) && !ES.tooLateToOffer(fest as any, ZONE, NOW));
  // Should-fix 4: a web or X find whose page is a Luma event that started is refused at send.
  const web = { tier: 3, kind: "opportunity", name: "Builders who Run SF", url: "https://lu.ma/m0oexu2k", reason: "A run then BBQ.", evidence: "Builders who Run SF https://lu.ma/m0oexu2k" };
  const { deps: d4 } = deps(page());
  const r4 = await S.checkBeforeSend(queued(web), ZONE, d4);
  check("review 4: a web find whose page is a Luma event that started is refused as it goes, with why", "skip" in r4 && /already started/.test((r4 as any).skip), r4);
  const xpost = { ...web, url: "https://x.com/someone/status/1", evidence: "run club! https://lu.ma/m0oexu2k see you there" };
  const r5 = await S.checkBeforeSend(queued(xpost), ZONE, deps(page()).deps);
  check("... and an X post linking it", "skip" in r5 && /already started/.test((r5 as any).skip), r5);
}
console.log(`started events: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
