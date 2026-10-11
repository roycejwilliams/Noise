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

type Calls = { luma: string[]; page: string[]; facts: any[]; saved: any[]; defers: number[] };
const depsWith = (o: { luma?: EventDetails | null; page?: { text: string | null; gone: boolean }; factFails?: boolean } = {}): { deps: import("../../src/services/sendCheck.js").SendCheckDeps; calls: Calls } => {
  const calls: Calls = { luma: [], page: [], facts: [], saved: [], defers: [] };
  return {
    calls,
    deps: {
      luma: async (u) => { calls.luma.push(u); return o.luma === undefined ? details() : o.luma; },
      page: async (u) => { calls.page.push(u); return o.page ?? { text: null, gone: false }; },
      now: () => NOW,
      writeFact: async (e) => { if (o.factFails) throw new Error("db down"); calls.facts.push(e); },
      saveMatch: async (_id, m) => { calls.saved.push(m); },
      saveDefers: async (_id, n) => { calls.defers.push(n); },
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
  const stale = TC.sentDetailLines({ sent: [{ key: "event:evt-1", name: "Founders Supper Club", kind: "event", url: "https://lu.ma/supper", sentAt: new Date(NOW.getTime() - 4 * 86_400_000), reaction: null, details: details(), postText: null, checkedAt: "2026-10-06T16:00:00Z" }] }, 5, NOW);
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
  check("B1: under way with no end time exits", !s.ok && s.exit && /under way/.test(s.why));
  const fest = await S.recheckFind(lumaFind(), { now: NOW, zone: LA, deps: depsWith({ luma: details({ startAt: iso(-20), endAt: iso(30) }) }).deps });
  check("B1: a multi-day event that started but hasn't ended stays (its end time decides)", fest.ok, fest);
  const ended = await S.recheckFind(lumaFind(), { now: NOW, zone: LA, deps: depsWith({ luma: details({ startAt: iso(-5), endAt: iso(-1) }) }).deps });
  check("B1: one that's over exits", !ended.ok && ended.exit && /over/.test(ended.why));
  const slugCalls: string[] = [];
  const slug = await S.recheckFind(lumaFind({ url: "supper" }), { now: NOW, zone: LA, deps: { ...depsWith().deps, luma: async (u) => { slugCalls.push(u); return details(); } } });
  check("B1: a Co or public event with a Luma slug (not a full link) is read on Luma too", slug.ok && slug.verified && slugCalls[0] === "supper");
  const coNoUrl = await S.recheckFind(lumaFind({ tier: 1, kind: "co_event", url: undefined }), { now: NOW, zone: LA, deps: depsWith().deps });
  check("B1: a Co event with no link goes marked unverified", coNoUrl.ok && !coNoUrl.verified);
  const u = await S.recheckFind(lumaFind(), { now: NOW, zone: LA, deps: depsWith({ luma: null }).deps });
  check("B1: an unreadable event page is a miss, never an exit or a send", !u.ok && !u.exit);
}
{
  const r = await S.recheckFind(webFind(), { now: NOW, zone: LA, deps: depsWith({ page: { text: null, gone: true } }).deps });
  check("B1: a dead link (404/410) exits as cancelled", !r.ok && r.exit && r.state === "cancelled" && /dead link/.test(r.why), r);
  const long = "Lorem ipsum. ".repeat(200);
  const c1 = await S.recheckFind(webFind(), { now: NOW, zone: LA, deps: depsWith({ page: { text: `Harbor Fellowship 2026. The Harbor Fellowship has been cancelled this year. ${long} Applications close October 20, 2026.`, gone: false } }).deps });
  check("B1: 'has been cancelled' next to its name holds it (defer), never a permanent exit: words aren't certain", !c1.ok && !c1.exit && /cancel/.test(c1.why), c1);
  const c2 = await S.recheckFind(webFind(), { now: NOW, zone: LA, deps: depsWith({ page: { text: `Harbor Fellowship. Applications close October 20, 2026. ${long} Our unrelated gala sold out last spring.`, gone: false } }).deps });
  check("B1: 'sold out' far from its name on a long page is not about it (stays)", c2.ok, c2);
  const c3 = await S.recheckFind(webFind(), { now: NOW, zone: LA, deps: depsWith({ page: { text: `Harbor Fellowship. Applications now close November 3, 2026. ${long}`, gone: false } }).deps });
  check("B1: a date on file its page doesn't show is held (defer), not sent with the old date, never an exit", !c3.ok && !c3.exit && /isn't shown on its page/.test(c3.why), c3);
  const ok = await S.recheckFind(webFind(), { now: NOW, zone: LA, deps: depsWith({ page: { text: `Harbor Fellowship. Applications close October 20, 2026. Stipend $5,000. ${long}`, gone: false } }).deps });
  check("B1: a page that still holds: its text now in pageNow, stamped; the evidence it was found from is kept", ok.ok && ok.verified && /\$5,000/.test(String((ok.match as any).pageNow)) && (ok.match as any).evidence === webFind().evidence && (ok.match as any).checkedAt === NOW.toISOString(), ok);
  const x = await S.recheckFind({ tier: 3, kind: "opportunity", source: "x", name: "Demo night", url: "https://x.com/someone/status/1", reason: "demo night", opportunity: { postText: "Demo night, 30 spots" } } as any, { now: NOW, zone: LA, deps: depsWith().deps });
  check("B1: an X post with no event page goes as found, marked unverified (no read possible)", x.ok && !x.verified);
  const xl = await S.recheckFind({ tier: 3, kind: "opportunity", source: "x", name: "Demo night", url: "https://x.com/someone/status/1", reason: "demo night", opportunity: { postText: "Demo night https://lu.ma/demo" } } as any, { now: NOW, zone: LA, deps: depsWith({ luma: details({ soldOut: true }) }).deps });
  check("B1: an X post with a Luma page is checked on that page", !xl.ok && xl.exit);
}
// checkBeforeSend end to end, stub deps: a certain exit writes its fact; anything uncertain defers and writes nothing, however often.
{
  const { deps, calls } = depsWith({ luma: null });
  const c = cand(lumaFind());
  const r1 = await S.checkBeforeSend(c, LA, deps);
  const r2 = await S.checkBeforeSend(c, LA, deps);
  const r3 = await S.checkBeforeSend(c, LA, deps);
  check("B1 e2e: an unreadable page defers a few hours (counted), never with an exit fact", [r1, r2].every((r) => "defer" in r && r.defer.getTime() - NOW.getTime() === S.RECHECK_RETRY_HOURS * 3_600_000) && calls.defers.join() === "1,2" && calls.facts.length === 0, { r1, d: calls.defers });
  check(`B1 e2e: the defer cap: on try ${S.RECHECK_MAX_DEFERS} it stops deferring and is held (skip, held, not exited, no fact, a failed attempt)`, "skip" in r3 && r3.held === true && !r3.exited && r3.skip.includes(S.HELD_MARK) && W.isFailedAttempt(r3.skip) && calls.facts.length === 0, r3);
  const words = depsWith({ page: { text: "Harbor Fellowship\nThe Harbor Fellowship has been cancelled. Applications close October 20, 2026.", gone: false } });
  const rw = await S.checkBeforeSend(cand(webFind()), LA, words.deps);
  check("B1 e2e: a closing word on a web page defers with no fact (uncertain)", "defer" in rw && words.calls.facts.length === 0, rw);
  const dead = depsWith({ page: { text: null, gone: true } });
  const rd = await S.checkBeforeSend(cand(webFind()), LA, dead.deps);
  check("B1 e2e: a 404 exits: one scoped fact, then skip+exited (certain)", "skip" in rd && rd.exited && dead.calls.facts.length === 1 && dead.calls.facts[0].state === "cancelled" && W.isScoped(dead.calls.facts[0]), { rd, f: dead.calls.facts });
  const sold = depsWith({ luma: details({ soldOut: true }) });
  const dry = await S.checkBeforeSend(cand(lumaFind()), LA, sold.deps, { dryRun: true });
  const dry2 = await S.sendCheckDryRun.run(true, () => S.checkBeforeSend(cand(lumaFind()), LA, depsWith({ luma: details({ spotsRemaining: 4 }) }).deps));
  check("B1: a dry run reads but writes nothing (no exit fact, no saved record), by flag or by dispatch's scope", "skip" in dry && sold.calls.facts.length === 0 && sold.calls.saved.length === 0 && "ok" in dry2, { dry, f: sold.calls });
  check("B1: dispatch runs a dry run inside that scope, and a find's defer never extends its expiry", /if \(opts\.dryRun && !sendCheckDryRun\.getStore\(\)\) return sendCheckDryRun\.run\(true/.test(src("harness/proactive.ts")) && /LEAST\(expires_at, \$3\)/.test(src("harness/proactive.ts")));
}
// closedOnPage: none of these is about the find being closed (review of #138), so none holds it.
{
  const name = "Harbor Fellowship";
  const negatives: [string, string, string | null][] = [
    ["refund policy", "Harbor Fellowship info session. Full refund if the event is cancelled.", null],
    ["no refunds unless", "Harbor Fellowship dinner. No refunds unless cancelled by the host.", null],
    ["another sold-out event on a host page", "Harbor Fellowship\nApplications close October 20, 2026.\n\nPast events\nThe Winter Gala sold out in hours.", "2026-10-20"],
    ["a past session of a series", "Harbor Fellowship monthly salon. The Oct 2 session was cancelled; Nov 6 is open.", "2026-11-06"],
    ["last year's cohort", "Harbor Fellowship. 2025 cohort: applications closed. 2026 applications open now.", "2026-10-20"],
    ["a tier of it", "Harbor Fellowship dinner. VIP tier is sold out; general admission open.", null],
    ["an FAQ", "Harbor Fellowship FAQ. What if the event is at capacity? We'll add a second night.", null],
  ];
  for (const [label, page, onFile] of negatives) check(`closedOnPage: ${label} is not a closure`, S.closedOnPage(page, name, onFile) === null, S.closedOnPage(page, name, onFile));
  check("closedOnPage: a plain statement about it is caught (and still only holds it)", S.closedOnPage("Harbor Fellowship\nThe Harbor Fellowship has been cancelled for this year.", name, null) !== null);
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
  check("B1 hook: a sibling whose re-read exited it (or held it) is archived in the composer's prep, never left pending", /if \(\(prep\.exited \|\| prep\.held\) && !opts\.dryRun\) await dropCandidate\(registry, x, "skipped", prep\.skip\);/.test(pro));
  const regC = src("harness/proactiveRegistry.ts");
  check("B+C: the send-time re-read runs inside prepareOffer, so every find in a composed bundle is re-read (and the lone reminder too)", /export async function prepareOffer[\s\S]{0,700}checkBeforeSend\(c, person\.timezone\)[\s\S]{0,60}if \(!\("ok" in fresh\)\) return fresh;/.test(reg) && /const prep = await prepareOffer\(c, person\);[\s\S]{0,300}if \("defer" in prep\) return prep;/.test(reg));
  check("B+C: a lead whose re-read defers waits (never past its own expiry); a deferred sibling stays pending", /if \("defer" in prep\) \{\s*if \(x\.id === c\.id\) \{[\s\S]{0,300}LEAST\(expires_at, \$3\)/.test(pro));
  check("B4+C: the opening and closing are held to the whole set's records too", /const backedBy = i\.items\.map\(\(b\) => b\.item\.rules\.backedBy\)/.test(src("harness/bundleComposer.ts")) && /\.\.\.\(backedBy \? \{ backedBy \} : \{\}\)/.test(src("harness/bundleComposer.ts")));
  check("B4+C: caption prices and counts are backed by the record in composed captions too (revealItem rules)", /backedBy: captionRecord\(askText, match, \[\.\.\.dots, why\]\),/.test(src("agent/eventDiscoverySurfacing.ts")) && /checkDraft\(c, \{ \.\.\.b\.item\.rules/.test(src("harness/bundleComposer.ts")));
}

// ================================================================ B2: undated finds don't queue blind

{
  const undated = webFind({ deadline: undefined, form: "opening", evidence: "Rolling admissions." });
  check(`B2: an undated find waits ${S.UNDATED_QUEUE_DAYS} days in the queue, not 14`, ES.offerExpiresAt(undated, LA, NOW).getTime() - NOW.getTime() === S.UNDATED_QUEUE_DAYS * 86_400_000);
  check("B2: an undated find whose window ends goes back to the backlog; a dated one or a pick's last day doesn't", S.returnsOnExpiry({ match: undated }, LA) && !S.returnsOnExpiry({ match: lumaFind() }, LA) && !S.returnsOnExpiry({ match: undated, lastDay: "2026-10-11" }, LA));
  check("B2: a window that ended unsent is not a decision (it may be queued again) and not an exit", W.isFailedAttempt(`${S.WINDOW_ENDED}: undated, back to the backlog`) && !W.decidedByRows([{ skip_reason: `${S.WINDOW_ENDED}: undated` }]) && !/exitOnQueueExpiry|writeExitFact/.test(src("services/eventSurfacingSweep.ts").slice(src("services/eventSurfacingSweep.ts").indexOf("export async function onEventOfferDropped"), src("services/eventSurfacingSweep.ts").indexOf("export async function surfaceNewAsksNow"))));
  check("B2: the expiry hook marks the row and keeps it in the backlog; the sweep clears a failed attempt's row so it can land again", /onEventOfferDropped\(c\.userId, c\.payload as EventOfferPayload, status, c\.id, c\.targetKey, reason \?\? null\)/.test(src("harness/proactiveRegistry.ts")) && /returnsOnExpiry\(payload[\s\S]{0,700}return;/.test(src("services/eventSurfacingSweep.ts")) && /await reopenFailedAttempt\(candidate\.userId, targetKey\);/.test(src("services/eventSurfacingSweep.ts")));
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
  check("B3: times are marked in their facts but never cut from a reply ('It starts at 6pm Saturday', 'remind you at 5:30pm?')", A.staleCurrentClaims("Ok, it starts at 6pm Saturday.", old).length === 0 && A.staleCurrentClaims("Want me to remind you at 5:30pm?", old).length === 0);
  check("B3: a Luma read in enrichMatch is stamped (a fresh read is never called stale)", /if \(m\.details\) m\.checkedAt = new Date\(\)\.toISOString\(\);/.test(src("services/eventDetails.ts")));
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
  const liveQs = ["still spots?", "Any tickets left", "is it sold out", "what time does it start", "how much is it", "is it still on?", "when does the dinner start"];
  const notLive = ["thanks!", "sounds fun", "I'm free Saturday", "I'm still on the fence", "any chance you're around on Sunday", "I want to start running again", "that's a lot of tickets to sell", "I'm full from dinner"];
  check(`B3: live questions are recognised; everything else isn't (${[...liveQs.filter((q) => !A.asksLiveDetail(q)), ...notLive.filter(A.asksLiveDetail)].join(" | ") || "ok"})`, liveQs.every(A.asksLiveDetail) && !notLive.some(A.asksLiveDetail));
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

// ================================================================ re-review of #138: the bounds, with the queue and backlog faked in memory

{
  const pool: any = (await import("../../src/db/db.js")).default;
  const rows: any[] = [];
  const backlogs = new Map<string, any[]>();
  let nextId = 1;
  const run = async (sql: string, params: any[] = []): Promise<{ rows: any[] }> => {
    const q = sql.replace(/\s+/g, " ");
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(q)) return { rows: [] };
    if (/FROM co_profiles/.test(q)) return { rows: [] };
    if (/SELECT items FROM event_backlogs/.test(q)) return { rows: backlogs.has(`${params[0]}|${params[1]}`) ? [{ items: backlogs.get(`${params[0]}|${params[1]}`) }] : [] };
    if (/INSERT INTO event_backlogs/.test(q)) { backlogs.set(`${params[0]}|${params[1]}`, JSON.parse(params[2])); return { rows: [] }; }
    if (/SET skip_reason = \$2 WHERE id = \$1 AND status = 'expired'/.test(q)) { const r = rows.find((x) => x.id === params[0] && x.status === "expired"); if (r) r.skip_reason = params[1]; return { rows: [] }; }
    if (/SELECT COUNT\(\*\)::int AS n/.test(q)) return { rows: [{ n: rows.filter((r) => r.user_id === params[0] && (r.target_key === params[1] || r.target_key.startsWith(`${params[1]}#retired:`)) && String(r.skip_reason ?? "").startsWith(params[2])).length }] };
    if (/SELECT id, skip_reason FROM proactive_candidates WHERE user_id = \$1 AND target_key = \$2 AND status <> 'pending'/.test(q)) return { rows: rows.filter((r) => r.user_id === params[0] && r.target_key === params[1] && r.status !== "pending") };
    if (/SET target_key = target_key \|\| '#retired:'/.test(q)) { for (const r of rows) if (params[1].includes(r.id) && r.status !== "pending") r.target_key = `${r.target_key}#retired:${r.id}`; return { rows: [] }; }
    throw new Error(`fake db: unhandled ${q.slice(0, 80)}`);
  };
  const realQuery = pool.query, realConnect = pool.connect;
  pool.query = run;
  pool.connect = async () => ({ query: run, release: () => {} });
  try {
    const rolling = webFind({ deadline: undefined, form: "opening", name: "Rolling Studio Residency", evidence: "Rolling admissions." });
    const key = "event_offer:opportunity:rolling studio residency";
    backlogs.set("u1|a1", [{ askText: "residencies", match: rolling, source: "full" }]);
    const payload: any = { askId: "a1", askText: "residencies", fromProfile: false, match: rolling };
    const held = () => backlogs.get("u1|a1")!.find((i) => i.match.name === rolling.name)?.unread ?? null;
    const heldAfter: (string | null)[] = [];
    for (let cycle = 1; cycle <= 3; cycle++) {
      // queued, then its window ends unsent; dispatch marks it expired and calls the hook
      const id = nextId++;
      rows.push({ id, user_id: "u1", target_key: key, status: "expired", skip_reason: "expired" });
      await ES.onEventOfferDropped("u1", payload, "expired", id as any, key, null);
      heldAfter.push(held()?.why ?? null);
      // the next sweep or pick reopens it (retires the row) and queues it again
      if (!held()) await ES.reopenFailedAttempt("u1", key);
    }
    check(`cycle cap: expire, reopen, requeue returns it ${S.WINDOW_CYCLES_MAX - 1} times, then it's held as stalled (${heldAfter.join(",")})`, heldAfter[0] === null && heldAfter[1] === null && heldAfter[2] === "stalled", heldAfter);
    check("cycle cap: reopen retires rows (history kept, so the count survives), never deletes", rows.length === 3 && rows.filter((r) => r.target_key.includes("#retired:")).length === 2);
    check("cycle cap: a stalled find leaves the dispatch pool (not offerable)", !W.offerable(backlogs.get("u1|a1")![0]));
    // The defer cap's hold goes to the same place.
    const other = webFind({ name: "Harbor Fellowship" });
    backlogs.set("u1|a2", [{ askText: "fellowships", match: other, source: "full" }]);
    await ES.onEventOfferDropped("u1", { askId: "a2", askText: "fellowships", fromProfile: false, match: other }, "skipped", "9", "k", `send failed: ${S.HELD_MARK}: its page couldn't be read just now, on 3 tries`);
    check("defer cap: the held skip keeps the find in its backlog as stalled (not dropped)", backlogs.get("u1|a2")!.length === 1 && backlogs.get("u1|a2")![0].unread?.why === "stalled");
  } finally {
    pool.query = realQuery;
    pool.connect = realConnect;
  }
  // The daily prune: a stalled item is never classified back in; it accrues days and exits after UNREAD_DAYS, on a scoped fact.
  let classified = 0;
  const facts: any[] = [];
  let items: any[] = [{ askText: "residencies", match: webFind({ deadline: undefined, form: "opening", name: "Rolling Studio Residency" }), source: "full", unread: { days: [], why: "stalled", note: "held for daily re-reads: its queue window ended unsent 3 times" } }];
  const deps: any = {
    backlogs: async () => [{ ask_id: "a1", items }], merge: async (_u: string, _a: string, ch: any) => { items = W.applyChange(items, ch, F.exitKey); },
    classify: async (m: any) => { classified++; return { match: m, result: "opening" }; }, zone: async () => LA, key: F.exitKey, writeFact: async (e: any) => { facts.push(e); },
  };
  for (const day of ["2026-10-11", "2026-10-12", "2026-10-13"]) await W.pruneBacklogs("u1", day, deps);
  check(`stalled: never re-classified back in; out after ${W.UNREAD_DAYS} separate days on a scoped fact`, classified === 0 && items.length === 0 && facts.length === 1 && W.isScoped(facts[0]) && /couldn't be sent after repeated tries/.test(facts[0].reason), { classified, items, facts });
}

// Royce, 2026-10-11: a stalled find (a rolling opening nobody picked) is set aside, not gone: it may come back after
// RECOVER_AFTER_DAYS if a sweep finds it again, read fresh before any offer. Anything else that times out is still gone for good.
{
  const run = async (why: "stalled" | "undated") => {
    const facts: any[] = [];
    let items: any[] = [{ askText: "residencies", match: webFind({ deadline: undefined, form: "opening", name: "Rolling Studio Residency" }), source: "full", unread: { days: [], why, note: "held for daily re-reads" } }];
    const deps: any = {
      backlogs: async () => [{ ask_id: "a1", items }], merge: async (_u: string, _a: string, ch: any) => { items = W.applyChange(items, ch, F.exitKey); },
      classify: async (m: any) => ({ match: m, result: "undated" }), zone: async () => LA, key: F.exitKey, writeFact: async (e: any) => { facts.push(e); },
    };
    for (const day of ["2026-10-11", "2026-10-12", "2026-10-13"]) await W.pruneBacklogs("u1", day, deps);
    return facts;
  };
  const stalled = await run("stalled");
  check("set aside, not gone: a stalled find's fact is recoverable, and says 'Set aside for now'", stalled.length === 1 && stalled[0].recoverable === true && /^Set aside for now the find "Rolling Studio Residency"/.test(W.exitFactLabel(stalled[0])), stalled.map((f) => W.exitFactLabel(f)));
  const undated = await run("undated");
  check("an undated find that never got a date is still gone for good (not recoverable)", undated.length === 1 && !undated[0].recoverable);
  const src = (await import("node:fs")).readFileSync(new URL("../../src/services/workingSet.ts", import.meta.url), "utf8");
  check("a set-aside find blocks a re-queue only for RECOVER_AFTER_DAYS (7); an exit blocks for good", W.RECOVER_AFTER_DAYS === 7 && /AND NOT \(COALESCE\(meta->>'recoverable', ''\) = 'true' AND created_at < NOW\(\) - make_interval\(days => \$4\)\)/.test(src) && /recoverable: true/.test(src));
}

// Royce, 2026-10-11: "still spots?" is read live on any event page, not only Luma (its schema.org Event data, no model).
{
  const A = await import("../../src/services/asOf.js");
  const at = new Date("2026-10-11T19:00:00Z");
  const deps = {
    luma: async () => null, isLuma: (u: string) => /lu\.ma/.test(u),
    page: async (u: string) => (u.includes("eventbrite") ? { start: "Sat Oct 24, 7:00 PM", cost: "45 USD", soldOut: false } : u.includes("soldout") ? { soldOut: true } : null),
  };
  const items = [{ name: "Gallery Night", url: "https://www.eventbrite.com/e/gallery-night" }, { name: "Supper Club", url: "https://supper.example/soldout" }];
  const lines = await A.liveDetailFacts("are there still spots?", items, deps, at);
  check("a non-Luma event page is read live, from its own page", /Checked live just now \(2026-10-11 19:00 UTC\), "Gallery Night", from its own page: starts Sat Oct 24, 7:00 PM; price 45 USD \(the page doesn't say it's sold out\)\./.test(lines.join("\n")), lines);
  check("…and a sold-out one says so", /"Supper Club", from its own page: sold out\./.test(lines.join("\n")), lines);
  const none = await A.liveDetailFacts("still spots?", [{ name: "Pop-up", url: "https://popup.example/x" }], deps, at);
  check("a page with no event data stays as-of (never said as current)", /its page doesn't list spots, time or price in a form Co can confirm: anything on file about them is as of when it was found, never current\./.test(none.join("")), none);
  const noPage = await A.liveDetailFacts("still spots?", items, { luma: deps.luma, isLuma: deps.isLuma }, at);
  check("a caller without the page reader keeps Luma-only", noPage.length === 0);
  const rg = (await import("node:fs")).readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
  check("replies wire the page reader through safeFetch (every hop checked), no model", /page: livePageFacts/.test(rg) && /const r = await safeFetch\(url\);/.test(rg) && /structuredEvent\(r\.body\)/.test(rg));
}

// Re-review of #138: closing words about the find with no date on file, and one shared name word.
{
  check("closedOnPage: 'Applications for the Climate Fellowship 2026 are now closed' (no date on file) is caught", S.closedOnPage("Applications for the Climate Fellowship 2026 are now closed.", "Climate Fellowship 2026", null) !== null);
  check("closedOnPage: this year's closure is caught when the name has no year", S.closedOnPage("Applications for the Climate Fellowship are now closed for 2026.", "Climate Fellowship", null) !== null);
  check("closedOnPage: 'Past: Founders Breakfast NYC, Sold out' doesn't hold 'Founders Dinner SF'", S.closedOnPage("Upcoming\nFounders Dinner SF, Oct 14.\nPast: Founders Breakfast NYC. Sold out.", "Founders Dinner SF", null) === null);
  check("closedOnPage: one shared word isn't enough ('Founders Breakfast is sold out' vs 'Founders Dinner')", S.closedOnPage("The Founders Breakfast is sold out.", "Founders Dinner", null) === null && S.closedOnPage("The Founders Dinner is sold out.", "Founders Dinner", null) !== null);
}

console.log(`phase B verify at send: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
