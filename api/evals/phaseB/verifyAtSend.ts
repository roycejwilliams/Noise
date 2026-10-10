// Phase B, verify at send (Royce, 2026-10-10). Zero tokens: every page read, every fact write and the model are stubbed.
//   The work order's tests: a find that sells out between capture and send does not go out claiming spots; a "still spots?" reply
//   carries a live check or an as-of; caption prices match the page. Plus each item: B1 the re-read before any find sends (sold out,
//   cancelled, full, dead link, changed date, stale counts) exiting through the working set; B2 undated finds don't queue 14 days
//   blind; B3 replies never state stored spots/times/prices as current (and the fact check isn't circular); B4 caption prices and
//   counts code-checked; B5 a task's on-file finds re-read or labelled; B6 stillRelevant reads the source and runs for goal finds.
//   npx tsx evals/phaseB/verifyAtSend.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";

// The model, scripted (only the task replay below reaches it).
type Answer = { tool: string; input: any } | { text: string };
const script: Answer[] = [];
let modelCalls = 0;
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  modelCalls++;
  const a = script.shift() ?? { text: "Nothing more." };
  const content = "tool" in a ? [{ type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2)}`, name: a.tool, input: a.input }] : [{ type: "text", text: a.text }];
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "scripted", content, stop_reason: "tool" in a ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const S = await import("../../src/services/sendCheck.js");
const A = await import("../../src/services/asOf.js");
const W = await import("../../src/services/workingSet.js");
const F = await import("../../src/services/findForm.js");
const ES = await import("../../src/services/eventSurfacingSweep.js");
const P = await import("../../src/harness/proactive.js");
const RG = await import("../../src/harness/replyGrounding.js");
const TC = await import("../../src/services/turnContext.js");
const EDS = await import("../../src/agent/eventDiscoverySurfacing.js");
const LT = await import("../../src/agent/loopTools.js");
const TM = await import("../../src/services/taskMessages.js");
const TT = await import("../../src/services/taskTurn.js");
type EventDetails = import("../../src/services/eventDetails.js").EventDetails;

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const NOW = new Date("2026-10-10T17:00:00Z"); // 10am Pacific, Saturday
const LA = "America/Los_Angeles";
const iso = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

const details = (o: Partial<EventDetails> = {}): EventDetails => ({ startAt: "2026-10-14T01:00:00.000Z", endAt: null, timezone: LA, online: false, venue: "Shack15", address: "1 Ferry Building, San Francisco", city: "San Francisco", hosts: ["Ellis"], price: "25 USD", spotsRemaining: 12, requiresApproval: false, soldOut: false, guestCount: 40, description: "Founders dinner.", ...o });
// Captured Oct 6 with 12 spots left; the event is Monday Oct 13, 6pm Pacific.
const lumaFind = (o: any = {}): any => ({ tier: 2, kind: "public_event", event_api_id: "evt-1", event_date: "2026-10-13", name: "Founders Supper Club", url: "https://lu.ma/supper", reason: "founders dinner", whyItFits: "a small founders dinner", details: details(), ...o });
const webFind = (o: any = {}): any => ({ tier: 3, kind: "opportunity", source: "web", name: "Harbor Fellowship", url: "https://harbor.example.org/apply", reason: "a fellowship for climate founders", deadline: "2026-10-20", form: "opening", evidence: "Harbor Fellowship. Applications close October 20, 2026.", ...o });

type Calls = { luma: string[]; page: string[]; facts: any[]; saved: any[]; misses: number[] };
const depsWith = (o: { luma?: EventDetails | null; page?: { text: string | null; gone: boolean }; factFails?: boolean } = {}): { deps: import("../../src/services/sendCheck.js").SendCheckDeps; calls: Calls } => {
  const calls: Calls = { luma: [], page: [], facts: [], saved: [], misses: [] };
  return {
    calls,
    deps: {
      luma: async (u) => { calls.luma.push(u); return o.luma === undefined ? details() : o.luma; },
      page: async (u) => { calls.page.push(u); return o.page ?? { text: null, gone: false }; },
      now: () => NOW,
      writeFact: async (e) => { if (o.factFails) throw new Error("db down"); calls.facts.push(e); },
      saveMatch: async (_id, m) => { calls.saved.push(m); },
      saveMisses: async (_id, n) => { calls.misses.push(n); },
    },
  };
};
const cand = (match: any, extra: any = {}) => ({ id: "c1", userId: "u1", payload: { askId: "a1", askText: "founder dinners this week", fromProfile: false, match, ...extra } });

// ================================================================ the work order's three tests

// 1. Sold out between capture and send: it doesn't go out claiming spots, and it exits on its fact.
{
  const { deps, calls } = depsWith({ luma: details({ soldOut: true, spotsRemaining: 0 }) });
  const c = cand(lumaFind());
  const r = await S.checkBeforeSend(c, LA, deps);
  check("WORK ORDER: a find that sold out since capture does not go out (skip, exited)", "skip" in r && r.exited === true && /sold out/.test(r.skip), r);
  check("...it exits through the working set: one fact, kind find, scoped, keyed so a sweep never re-queues it", calls.facts.length === 1 && calls.facts[0].kind === "find" && W.isScoped(calls.facts[0]) && calls.facts[0].itemKey === F.exitKey(lumaFind()) && /nothing about what they like/.test(calls.facts[0].scope) && /founder dinners/.test(calls.facts[0].scope), calls.facts);
  check("...the fact's label never says more than happened", /^Closed the find "Founders Supper Club": sold out/.test(W.exitFactLabel(calls.facts[0])), W.exitFactLabel(calls.facts[0]));
}
// Spots went 12 -> 3: what goes out is drafted from the page as it is now, and a caption still saying 12 fails its check.
{
  const { deps, calls } = depsWith({ luma: details({ spotsRemaining: 3 }) });
  const c = cand(lumaFind());
  const r = await S.checkBeforeSend(c, LA, deps);
  const m = c.payload.match;
  check("WORK ORDER: spots that changed since capture are the page's now (3, not 12), stamped and saved on the row", "ok" in r && m.details.spotsRemaining === 3 && m.checkedAt === NOW.toISOString() && calls.saved.length === 1, { r, m });
  const record = EDS.captionRecord("founder dinners this week", m);
  check("...a caption still claiming 12 spots fails; one saying 3 passes", !S.captionNumbersBacked("Founders Supper Club Monday, only 12 spots left.", record).ok && S.captionNumbersBacked("Founders Supper Club Monday, 3 spots left.", record).ok);
}
// 2. "Still spots?": a live check, or an as-of. Never the stored count as current.
{
  const stale = TC.sentDetailLines({ sent: [{ key: "event:evt-1", name: "Founders Supper Club", kind: "event", url: "https://lu.ma/supper", sentAt: new Date(NOW.getTime() - 4 * 86_400_000), reaction: null, details: details(), postText: null, checkedAt: "2026-10-06T16:00:00Z" }] });
  check("the stored details for a send 4 days old say 'not checked since' on spots, price and time", stale.length === 1 && /12 spots left \(as of [^)]*not checked since/.test(stale[0]) && /Tickets are 25 USD \(as of/.test(stale[0]) && /starts [^.]*\(as of/.test(stale[0]), stale);
  const asStored = "Yes, still 12 spots left.";
  check("WORK ORDER: a 'still spots?' reply stating the stored count as current is caught", A.staleCurrentClaims(asStored, stale).length === 1);
  check("...one that says as of when passes", A.staleCurrentClaims("As of Monday there were 12 spots left; it may have moved.", stale).length === 0);
  const live = await A.liveDetailFacts("still spots for the supper club?", [{ name: "Founders Supper Club", url: "https://lu.ma/supper" }], { luma: async () => details({ spotsRemaining: 12 }), isLuma: (u) => /lu\.ma/.test(u) }, NOW);
  check("WORK ORDER: with a live read in the facts, the same count passes (the live fact backs it)", live.length === 1 && /^Checked live just now/.test(live[0]) && !A.isStaleFact(live[0]) && A.staleCurrentClaims(asStored, [...stale, live[0]]).length === 0, live);
  // Through the reply's own code checks, and cut by stripUnsupported.
  const rf = RG.createReplyFacts();
  for (const l of stale) RG.addFact(rf, "known", l);
  const checks = RG.codeChecks(asStored, rf, { message: "still spots?", recentConversation: "" });
  const bad = checks.filter((c: any) => !c.pass && c.name === "no_stale_as_current");
  check("...the reply's code check fails it (no_stale_as_current) and the cut removes exactly that sentence", bad.length === 1 && RG.stripUnsupported(`${asStored} Want the link again?`, bad) === "Want the link again?", { bad, cut: RG.stripUnsupported(`${asStored} Want the link again?`, bad) });
}
// 3. Caption prices match the page.
{
  const record = EDS.captionRecord("dinners", lumaFind());
  check("WORK ORDER: a caption price that matches its page passes ($25 = 25 USD)", S.captionNumbersBacked("Founders Supper Club, $25, Monday.", record).ok);
  check("...one that doesn't fails ($30, or 'free')", !S.captionNumbersBacked("Founders Supper Club, $30, Monday.", record).ok && !S.captionNumbersBacked("Founders Supper Club Monday, and it's free.", record).ok);
  const rules = { maxChars: 300, backedBy: record };
  check("...and the proactive draft check runs it (draft_numbers_backed)", P.checkDraft("Founders Supper Club Monday, $30 a seat.", rules).some((c: any) => c.name === "draft_numbers_backed" && !c.pass) && P.checkDraft("Founders Supper Club Monday, $25 a seat.", rules).every((c: any) => c.name !== "draft_numbers_backed" || c.pass));
}

// ================================================================ B1: the re-read

{
  const r = await S.recheckFind(lumaFind({ event_date: "2026-10-08", details: details({ startAt: "2026-10-09T01:00:00Z" }) }), { now: NOW, zone: LA, deps: depsWith().deps });
  check("B1: past already: exits on its date without reading anything", !r.ok && r.exit && /date \(2026-10-08\) passed/.test(r.why), r);
}
{
  const { deps, calls } = depsWith({ luma: details({ startAt: "2026-10-15T01:00:00Z" }) });
  const r = await S.recheckFind(lumaFind(), { now: NOW, zone: LA, deps });
  check("B1: a moved start is taken (event_date follows, in the event's zone) and named as a change", r.ok && (r.match as any).event_date === "2026-10-14" && r.changed.some((x) => /start moved/.test(x)) && calls.luma.length === 1, r);
}
{
  const r = await S.recheckFind(lumaFind(), { now: NOW, zone: LA, deps: depsWith({ luma: details({ spotsRemaining: 0, soldOut: false }) }).deps });
  check("B1: full (no spots left) exits", !r.ok && r.exit && /no spots left/.test(r.why));
  const s = await S.recheckFind(lumaFind(), { now: NOW, zone: LA, deps: depsWith({ luma: details({ startAt: iso(-1) }) }).deps });
  check("B1: already started exits", !s.ok && s.exit && /already started/.test(s.why));
  const u = await S.recheckFind(lumaFind(), { now: NOW, zone: LA, deps: depsWith({ luma: null }).deps });
  check("B1: an unreadable event page is a miss, never an exit or a send", !u.ok && !u.exit);
}
{
  const r = await S.recheckFind(webFind(), { now: NOW, zone: LA, deps: depsWith({ page: { text: null, gone: true } }).deps });
  check("B1: a dead link (404/410) exits as cancelled", !r.ok && r.exit && r.state === "cancelled" && /dead link/.test(r.why), r);
  const long = "Lorem ipsum. ".repeat(200);
  const c1 = await S.recheckFind(webFind(), { now: NOW, zone: LA, deps: depsWith({ page: { text: `Harbor Fellowship 2026. The Harbor Fellowship has been cancelled this year. ${long} Applications close October 20, 2026.`, gone: false } }).deps });
  check("B1: 'cancelled' next to its name exits as cancelled", !c1.ok && c1.exit && c1.state === "cancelled", c1);
  const c2 = await S.recheckFind(webFind(), { now: NOW, zone: LA, deps: depsWith({ page: { text: `Harbor Fellowship. Applications close October 20, 2026. ${long} Our unrelated gala sold out last spring.`, gone: false } }).deps });
  check("B1: 'sold out' far from its name on a long page is not about it (stays)", c2.ok, c2);
  const c3 = await S.recheckFind(webFind(), { now: NOW, zone: LA, deps: depsWith({ page: { text: `Harbor Fellowship. Applications now close November 3, 2026. ${long}`, gone: false } }).deps });
  check("B1: a date on file its page no longer states is held (a miss), not sent with the old date", !c3.ok && !c3.exit && /isn't on its page/.test(c3.why), c3);
  const ok = await S.recheckFind(webFind(), { now: NOW, zone: LA, deps: depsWith({ page: { text: `Harbor Fellowship. Applications close October 20, 2026. Stipend $5,000. ${long}`, gone: false } }).deps });
  check("B1: a page that still holds is the new record (its text now, stamped)", ok.ok && ok.verified && /\$5,000/.test(String((ok.match as any).evidence)) && (ok.match as any).checkedAt === NOW.toISOString(), ok);
  const x = await S.recheckFind({ tier: 3, kind: "opportunity", source: "x", name: "Demo night", url: "https://x.com/someone/status/1", reason: "demo night", opportunity: { postText: "Demo night, 30 spots" } } as any, { now: NOW, zone: LA, deps: depsWith().deps });
  check("B1: an X post with no event page goes as found, marked unverified (no read possible)", x.ok && !x.verified);
  const xl = await S.recheckFind({ tier: 3, kind: "opportunity", source: "x", name: "Demo night", url: "https://x.com/someone/status/1", reason: "demo night", opportunity: { postText: "Demo night https://lu.ma/demo" } } as any, { now: NOW, zone: LA, deps: depsWith({ luma: details({ soldOut: true }) }).deps });
  check("B1: an X post with a Luma page is checked on that page", !xl.ok && xl.exit);
}
// checkBeforeSend: misses, fact failures, fresh reads.
{
  const { deps, calls } = depsWith({ luma: null });
  const c = cand(lumaFind());
  const r1 = await S.checkBeforeSend(c, LA, deps);
  check("B1: an unreadable page defers a few hours and counts the try", "defer" in r1 && calls.misses[0] === 1 && r1.defer.getTime() - NOW.getTime() === S.RECHECK_RETRY_HOURS * 3_600_000, r1);
  c.payload.recheckMisses = S.RECHECK_MAX_MISSES - 1;
  const r3 = await S.checkBeforeSend(c, LA, deps);
  check(`B1: after ${S.RECHECK_MAX_MISSES} unread tries it exits on that fact (never sent unchecked)`, "skip" in r3 && r3.exited && calls.facts.length === 1 && /couldn't be read/.test(calls.facts[0].reason), { r3, f: calls.facts });
}
{
  const { deps, calls } = depsWith({ luma: details({ soldOut: true }), factFails: true });
  const r = await S.checkBeforeSend(cand(lumaFind()), LA, deps);
  check("B1: when the exit fact can't be written, the find stays live (defer), the fact always first", "defer" in r && calls.facts.length === 0, r);
}
{
  const { deps, calls } = depsWith();
  const r = await S.checkBeforeSend(cand(lumaFind({ checkedAt: iso(-0.2) })), LA, deps);
  check("B1: read minutes ago (stillRelevant ran first): no second read", "ok" in r && calls.luma.length === 0);
}
// The hooks are thin, and in the right places.
{
  const reg = src("harness/proactiveRegistry.ts");
  const at = reg.indexOf("checkBeforeSend(c, person.timezone)");
  check("B1 hook: the event_offer draft re-reads before the date check and drafting", at > 0 && at < reg.indexOf("offerable(readDates(itemDays(p.match") && /if \(!\("ok" in fresh\)\) return fresh;/.test(reg));
  const pro = src("harness/proactive.ts");
  check("B1 hook: a sibling whose re-read exited it is archived in dispatch (one line), never left pending", /if \("skip" in d && \(d as \{ exited\?: boolean \}\)\.exited && !opts\.dryRun\) await dropCandidate\(registry, sib, "skipped", d\.skip\);/.test(pro));
}

// ================================================================ B2: undated finds don't queue blind

{
  const undated = webFind({ deadline: undefined, form: "opening", evidence: "Rolling admissions." });
  check(`B2: an undated find waits ${S.UNDATED_QUEUE_DAYS} days in the queue, not 14`, ES.offerExpiresAt(undated, LA, NOW).getTime() - NOW.getTime() === S.UNDATED_QUEUE_DAYS * 86_400_000);
  const facts: any[] = [];
  const ok = await S.exitOnQueueExpiry("u1", { match: undated, askText: "climate fellowships" }, LA, { writeFact: async (e) => { facts.push(e); } });
  check("B2: when its window runs out it exits on a scoped fact (no silent drop)", ok && facts.length === 1 && W.isScoped(facts[0]) && /no date/.test(facts[0].reason) && facts[0].state === "expired", facts);
  check("B2: a dated one's reason is its time; a pick's is its last useful day", /its time \(2026-10-13\)/.test(S.queueExpiryReason({ match: lumaFind() }, LA)) && /last useful day \(2026-10-11\)/.test(S.queueExpiryReason({ match: lumaFind(), lastDay: "2026-10-11" }, LA)));
  check("B2: the queue's expiry hook passes its status through to that exit", /onEventOfferDropped\(c\.userId, c\.payload as EventOfferPayload, status\)/.test(src("harness/proactiveRegistry.ts")) && /if \(status === "expired"\)[\s\S]{0,200}exitOnQueueExpiry/.test(src("services/eventSurfacingSweep.ts")));
}

// ================================================================ B3: as-of, live, and the check that isn't circular

{
  const fresh = A.renderDetailsAsOf("Founders Supper Club", details(), iso(-1), NOW);
  const old = A.renderDetailsAsOf("Founders Supper Club", details(), iso(-30), NOW, LA);
  const none = A.renderDetailsAsOf("Founders Supper Club", details(), null, NOW);
  check("B3: a fresh read carries no mark; a 30-hour-old one marks only the volatile lines; none at all is 'an earlier day'", !fresh.some(A.isStaleFact) && old.filter(A.isStaleFact).length === 4 && !old.find((l) => /Hosted by/.test(l))!.includes("not checked") && none.some((l) => /an earlier day/.test(l)), { old, none });
  const rf = RG.createReplyFacts();
  RG.addEventFacts(rf, lumaFind(), null, LA);
  check("B3: the reply's event facts (the offer they said yes to) carry the mark too", rf.facts.some((f: any) => /12 spots left \(as of an earlier day, not checked since/.test(f.text)));
  check("B3: a time stated as current from a stale fact is caught; from a fresh one, passes", A.staleCurrentClaims("It starts at 6pm.", old).length === 1 && A.staleCurrentClaims("It starts at 6pm.", fresh).length === 0, A.staleCurrentClaims("It starts at 6pm.", old));
  check("B3: a detail no fact states is left to the other checks (no double flag)", A.staleCurrentClaims("There are 80 seats.", old).length === 0);
  check("B3: 'not sold out' and 'still spots' read as availability claims", A.volatileTokens("It's not sold out, still a few spots.").includes("avail"));
  // The claim read's citation: a stale fact never backs the same detail said as current.
  const rf2 = RG.createReplyFacts();
  RG.addFact(rf2, "known", old.find((l) => /spots left/.test(l))!);
  const fid = rf2.facts[rf2.facts.length - 1].id;
  const cc = RG.claimChecks([{ text: "still 12 spots left", type: "count", supported: true, factId: fid, quote: null }], rf2, { message: "still spots?", recentConversation: "" });
  const ccAsOf = RG.claimChecks([{ text: "as of Monday there were 12 spots left", type: "count", supported: true, factId: fid, quote: null }], rf2, { message: "still spots?", recentConversation: "" });
  check("B3: the circular case: the claim read citing the stale fact for 'still 12 spots' fails; with 'as of' it passes", !cc[0].pass && /earlier read/.test(cc[0].reason!) && ccAsOf[0].pass, { cc, ccAsOf });
  const RF = await import("../../src/services/researchFinds.js");
  const oldFind = RF.findLines([{ name: "Harbor Fellowship", url: "https://harbor.example.org", facts: "12 spots left, $40", at: "2026-10-01T16:00:00Z" }], NOW)[0];
  const newFind = RF.findLines([{ name: "Harbor Fellowship", url: "https://harbor.example.org", facts: "12 spots left, $40", at: iso(-1) }], NOW)[0];
  check("B3: a research find kept 9 days says what its page said as of then; one from this hour doesn't", A.isStaleFact(oldFind) && !A.isStaleFact(newFind) && /have its link/.test(oldFind) && A.staleCurrentClaims("Still 12 spots left.", [oldFind]).length === 1, oldFind);
  check("B3: linkReader's own '(as of …, may have changed)' counts as the same mark", A.isStaleFact("start: Monday at 6:00 PM PDT (as of 2026-10-06 16:00 UTC, may have changed)"));
  // The live read only happens on a live question, and only for Luma pages, at most LIVE_READS_MAX.
  let reads = 0;
  const luma = async () => { reads++; return details(); };
  const none2 = await A.liveDetailFacts("thanks, that sounds fun", [{ name: "A", url: "https://lu.ma/a" }], { luma, isLuma: () => true }, NOW);
  const many = await A.liveDetailFacts("what time does it start?", [{ name: "A", url: "https://lu.ma/a" }, { name: "B", url: "https://lu.ma/b" }, { name: "C", url: "https://lu.ma/c" }, { name: "D", url: "https://site.example/d" }], { luma, isLuma: (u) => /lu\.ma/.test(u) }, NOW);
  check(`B3: no live question, no read; a live one reads at most ${A.LIVE_READS_MAX} Luma pages`, none2.length === 0 && many.length === A.LIVE_READS_MAX && reads === A.LIVE_READS_MAX);
  const failedRead = await A.liveDetailFacts("is it sold out?", [{ name: "A", url: "https://lu.ma/a" }], { luma: async () => null, isLuma: () => true }, NOW);
  check("B3: a live read that fails says the stored details are as of when found, never current", failedRead.length === 1 && /never current/.test(failedRead[0]));
  check("B3: live questions are recognised; small talk isn't", ["still spots?", "Any tickets left", "is it sold out", "what time does it start", "how much is it"].every(A.asksLiveDetail) && !["thanks!", "sounds fun", "I'm free Saturday"].some(A.asksLiveDetail));
  check("B3: the reply gathers live facts only from this member's own sends (opts.turn.sent)", /liveDetailFacts\(opts\.turn\.message \?\? "", recentSends/.test(src("harness/replyGrounding.ts")) && /const recentSends = opts\.turn\.sent\./.test(src("harness/replyGrounding.ts")));
}

// ================================================================ B4: captions

{
  const record = EDS.captionRecord("founder dinners under $40", lumaFind());
  check("B4: their own number backs a caption (their $40 budget)", S.captionNumbersBacked("Founders Supper Club fits your $40 budget.", record).ok);
  check("B4: a count not on its page fails (50 founders), one that is passes (40 people registered)", !S.captionNumbersBacked("50 founders are going.", record).ok && S.captionNumbersBacked("40 people registered so far.", record).ok);
  const noSpots = EDS.captionRecord("dinners", lumaFind({ details: details({ spotsRemaining: null, guestCount: null }) }));
  check("B4: scarcity with no spots count on its page fails ('only a few spots', 'selling fast')", !S.captionNumbersBacked("Only a few spots left.", noSpots).ok && !S.captionNumbersBacked("It's selling fast.", noSpots).ok && S.captionNumbersBacked("Only a few spots left.", record).ok);
  check("B4: 'sold out' in a caption needs its page to say so", !S.captionNumbersBacked("The early tickets sold out.", record).ok);
  check("B4: the reply loop's caption check carries it too (scarcity)", LT.captionProblems("Only a few spots left, worth a look.", "Founders Supper Club Monday", "").some((p: string) => /a few spots/.test(p)));
  check("B4: a task's captions too", !TM.captionOk("Selling fast, Monday at Shack15.", "Founders Supper Club Monday Shack15").ok);
  check("B4: the reveal's rules carry its record (backedBy)", /backedBy: captionRecord\(askText, match, \[\.\.\.dots, why\]\)/.test(src("agent/eventDiscoverySurfacing.ts")));
}

// ================================================================ B5: a task's on-file find

{
  const onFile = { name: "Founders Supper Club", url: "https://lu.ma/supper", tier: 2, facts: ["date: 2026-10-13", "starts 2026-10-14 01:00"], checkedAt: "2026-10-06T16:00:00Z" };
  const sold = depsWith({ luma: details({ soldOut: true }) });
  const r = await S.recheckOnFile("u1", onFile, LA, sold.deps);
  check("B5: a sold-out on-file find is left out and exits on its fact", !r.ok && r.exited && sold.calls.facts.length === 1 && W.isScoped(sold.calls.facts[0]), r);
  const open = depsWith({ luma: details({ spotsRemaining: 5 }) });
  const r2 = await S.recheckOnFile("u1", onFile, LA, open.deps);
  check("B5: a live one goes with what its page says now, stamped (5 spots, checked …)", r2.ok && r2.facts.includes("5 spots left") && r2.facts.some((f) => /^checked 2026-10-10 17:00 UTC$/.test(f)), r2);
  const fresh = depsWith();
  const r3 = await S.recheckOnFile("u1", { ...onFile, checkedAt: iso(-0.1) }, LA, fresh.deps);
  check("B5: read minutes ago: not read again", r3.ok && fresh.calls.luma.length === 0);
  const x = await S.recheckOnFile("u1", { name: "Demo night", url: "https://x.com/a/status/1", tier: 3, facts: ["30 spots"], checkedAt: null }, LA, depsWith().deps);
  check("B5: a source that can't be read again goes with its age on it", x.ok && x.facts.some((f) => /an earlier day, not checked since/.test(f)), x);
}
// The task replay: an on-file find that sold out since it was found never goes out; the live one does, from its page now.
{
  const SOLD = { name: "Founders Supper Club", url: "https://lu.ma/supper", tier: 2, facts: ["date: 2026-10-13", "starts 2026-10-14 01:00", "12 spots left"], checkedAt: "2026-10-06T16:00:00Z" };
  const OPEN = { name: "Long Lead Time Hardware Happy Hour", url: "https://lu.ma/longlead", tier: 2, facts: ["date: 2026-10-12", "starts 2026-10-13 01:00", "San Francisco"], checkedAt: "2026-10-06T16:00:00Z" };
  const sent: string[][] = [];
  const rechecked: string[] = [];
  const task: any = { id: 9, userId: "u1", goal: "Find founder events in San Francisco this week", theirWords: "anything for founders this week?", steps: [], planNext: "Send what's on file", status: "open", wakes: 3, textsSent: 0, lastTextedAt: null, createdAt: "2026-10-10T16:00:00Z", deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null, kind: "work", source: "ask", window: null, notes: [] };
  const deps: any = {
    person: { first_name: "Jordan", phone_number: "+14155550100", city: "San Francisco" }, recent: "", zone: LA,
    note: async () => {}, schedule: async () => null, scheduleAt: async () => null, close: async () => {}, textsToday: async () => 0, markTexted: async () => {}, markFinalTold: async () => {},
    send: async (m: string[]) => { sent.push(m); return { sent: true }; },
    search: async () => [], web: async () => ({ kept: [], dropped: [], droppedDetails: [], note: "" }), readPage: async () => ({ ok: true, facts: [], text: "" }),
    now: () => NOW, sentSince: async () => [], onFile: async () => [SOLD, OPEN], rejected: async () => [],
    recheckOnFile: async (f: any) => { rechecked.push(f.url); return S.recheckOnFile("u1", f, LA, depsWith({ luma: f.url === SOLD.url ? details({ soldOut: true }) : details({ startAt: "2026-10-13T01:00:00Z", spotsRemaining: 30 }) }).deps); },
  };
  script.push(
    { tool: "tellThem", input: { what: "Two founder events this week", links: [SOLD.url, OPEN.url] } },
    { text: JSON.stringify({ captions: [{ n: 1, caption: "A hardware happy hour on Monday in San Francisco." }], closing: null }) },
    { tool: "scheduleNext", input: { inHours: 24, plan: "look again" } },
  );
  const tr = await TT.runTaskTurnWith(task, deps);
  if (process.env.DEBUG_B5) console.log(JSON.stringify(tr));
  script.length = 0;
  const all = sent.flat().join("\n");
  check("B5 replay: both on-file finds were read again before the send", rechecked.length === 2 && rechecked.includes(SOLD.url), rechecked);
  check("B5 replay: the sold-out one never goes out; the live one does", !all.includes(SOLD.url) && all.includes(OPEN.url), sent);
}

// ================================================================ B6: stillRelevant reads the source, for goal finds too

{
  const goalFind: any = { id: "g1", userId: "u1", type: "event_offer", targetKey: "x", topicKey: "x", summary: "An event Co noticed for them", priority: 60, dueAt: NOW, expiresAt: null, attempts: 0, createdAt: new Date(NOW.getTime() - 72 * 3_600_000), payload: { askId: "profile", askText: "where they're headed", fromProfile: true, match: lumaFind() } };
  check("B6: a goal find waiting over a day gets the relevance re-check (it never did)", P.needsRelevanceCheck(goalFind, NOW));
  const before = modelCalls;
  const sold = depsWith({ luma: details({ soldOut: true }) });
  const r = await P.stillRelevant(goalFind, { recentConversation: "", now: NOW, timezone: LA, checkDeps: sold.deps });
  check("B6: sold out on its page settles it in code (not relevant), with its exit fact, and no model read", !!r && !r.relevant && /sold out/.test(r.why) && sold.calls.facts.length === 1 && modelCalls === before, { r, calls: modelCalls - before });
  const unread = await P.stillRelevant({ ...goalFind, payload: { ...goalFind.payload, match: lumaFind() } }, { recentConversation: "", now: NOW, timezone: LA, checkDeps: depsWith({ luma: null }).deps });
  check("B6: a page that can't be read now holds it (null), never sends it unread", unread === null);
  const m = { ...lumaFind(), checkedAt: iso(-0.1), details: details({ spotsRemaining: 7 }) };
  check("B6: what its page says now is a line the model reads", /read just now: .*7 spots left/.test(S.sourceLine(m, NOW) ?? ""), S.sourceLine(m, NOW));
  check("B6: the prompt carries it", /\$\{source \? `\\n\$\{source\}\\n` : ""\}/.test(src("harness/proactive.ts")));
}

console.log(`phase B verify at send: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
