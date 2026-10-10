// The working set and the find tiers (Royce, 2026-10-09). Zero tokens: pages, models and the store are stubbed.
//   Lifecycle: (a) an exited item is never swept, picked or re-judged; (b) every exit writes a scoped fact before archiving; (c) only
//   live items are in the working set; (d) restating an old ask opens a fresh one; (e) gone members get zero sweeps; (f) the report shows
//   per-member working-set size and search spend; (g) no new state store: exits write through the existing fact record.
//   Tiers: (a) a web event carries its date from capture; (b) a past event exits on its date; (c) an undated backlog item is
//   classified and dated or exited; (d) a failed draft re-enters; (e) Co's pitch follows the classification; (f) the founders dinner
//   (a failed Oct 6 draft) can be queued again.
//   npx tsx evals/lifecycle/workingSet.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const W = await import("../../src/services/workingSet.js");
const F = await import("../../src/services/findForm.js");
const Q = await import("../../src/services/sweepQuery.js");
const PW = await import("../../src/harness/profileWrite.js");
const ES = await import("../../src/services/eventSurfacingSweep.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const TODAY = "2026-10-09";

// A backlog world: two asks, items as they really sat on 10-09.
const ev = (name: string, o: any = {}) => ({ askText: o.askText ?? "events this weekend", match: { tier: o.tier ?? 3, kind: o.kind ?? "opportunity", source: "web", name, url: `https://x/${encodeURIComponent(name)}`, ...o.m } });
function world(lists: { ask_id: string; items: any[] }[], o: { classify?: (m: any) => any; failFact?: (e: any) => boolean } = {}) {
  const log: string[] = [];
  const facts: any[] = [];
  const store = new Map(lists.map((l) => [l.ask_id, l.items]));
  const deps: any = {
    backlogs: async () => [...store.entries()].map(([ask_id, items]) => ({ ask_id, items })),
    merge: async (_u: string, askId: string, change: any) => { log.push(`save ${askId}`); store.set(askId, W.applyChange(store.get(askId) ?? [], change, deps.key)); },
    classify: async (m: any) => (o.classify ? o.classify(m) : { match: m, result: "unknown" }),
    zone: async () => "America/Los_Angeles",
    key: (m: any) => F.exitKey(m),
    writeFact: async (e: any) => { log.push(`fact ${e.label}`); if (o.failFact?.(e)) throw new Error("db down"); facts.push(e); },
  };
  return { deps, log, facts, store };
}

// ---------------------------------------------------------------- tiers (a): a web event carries its date from capture
{
  const page = "Fleet Week Air Show. Saturday, October 10 and Sunday, October 11, 2026. Blue Angels over the Bay.";
  const c = await F.classifyFind({ tier: 3, kind: "opportunity", name: "San Francisco Fleet Week Air Show", url: "https://fleetweeksf.org/air-show/", reason: "" } as any, TODAY, {
    page: async () => page,
    model: async () => '{"form":"event","date":"2026-10-10","end":"2026-10-11","deadline":null}',
  });
  check("tiers (a): a web-found event is classified at capture and carries its dates", c.result === "dated_event" && (c.match as any).statedDates?.start === "2026-10-10" && (c.match as any).statedDates?.end === "2026-10-11" && (c.match as any).form === "event", c);
  check("a date the page doesn't state is never carried (the model's guess is dropped)", F.readClassification('{"form":"event","date":"2026-10-12","end":null,"deadline":null}', page)?.date === null);
  check("a date written several ways on the page is found (Oct 10, 10/10, October 10)", ["Oct 10", "10/10", "October 10th", "2026-10-10"].every((p) => F.readClassification('{"form":"event","date":"2026-10-10"}', `Join us ${p}`)?.date === "2026-10-10"));
  const op = await F.classifyFind({ tier: 3, kind: "opportunity", name: "Solo Founders Program", url: "https://sfp", reason: "" } as any, TODAY, { page: async () => "Applications close November 1. Rolling admissions.", model: async () => '{"form":"opening","date":null,"end":null,"deadline":"2026-11-01"}' });
  check("an opening carries its deadline", op.result === "opening" && (op.match as any).deadline === "2026-11-01" && F.formOf(op.match as any) === "opening");
  const undated = await F.classifyFind({ tier: 3, kind: "opportunity", name: "Sound Bath", url: "https://sb", reason: "" } as any, TODAY, { page: async () => "A sound bath meditation in the park. Bring a mat.", model: async () => '{"form":"event","date":null}' });
  check("an event whose page gives no date is undated (it exits rather than lingering)", undated.result === "undated");
  check("a page that can't be read is unknown (retried later, never exited on a fetch failure)", (await F.classifyFind({ tier: 3, kind: "opportunity", name: "X", url: "https://x", reason: "" } as any, TODAY, { page: async () => null, model: async () => "" })).result === "unknown");
  check("capture classifies new finds before they reach the backlog", /const found = await settleNewFinds\(candidate\.userId, rawFound,/.test(src("services/eventSurfacingSweep.ts")));
}

// ---------------------------------------------------------------- tiers (b): a past event exits on its date
{
  check("isPastEvent reads a web event's stated dates (they used to be ignored)", ES.isPastEvent({ tier: 3, kind: "opportunity", name: "Hardly Strictly Bluegrass 2026", statedDates: { start: "2026-10-03" } } as any, "America/Los_Angeles", new Date("2026-10-09T18:00:00Z")));
  check("a festival isn't past until its last day", !ES.isPastEvent({ tier: 3, kind: "opportunity", name: "Fleet Week", statedDates: { start: "2026-10-08", end: "2026-10-11" } } as any, "America/Los_Angeles", new Date("2026-10-09T18:00:00Z")));
  const w = world([
    { ask_id: "a1", items: [ev("Hardly Strictly Bluegrass 2026", { m: { statedDates: { start: "2026-10-03" }, form: "event" } }), ev("Mahjong Party", { tier: 2, kind: "public_event", m: { event_date: "2026-10-13" } })] },
    { ask_id: "a2", items: [ev("Hardly Strictly Bluegrass 2026", { m: { statedDates: { start: "2026-10-03" }, form: "event" } })] },
  ]);
  const r = await W.pruneBacklogs("u", TODAY, w.deps);
  check("tiers (b): a past event exits on its date, out of every backlog", r.exited === 1 && !w.store.get("a1")!.some((i: any) => /Hardly/.test(i.match.name)) && !w.store.get("a2")!.length, { r, store: [...w.store.entries()] });
  check("a future event stays", w.store.get("a1")!.some((i: any) => i.match.name === "Mahjong Party"));
  check("its fact says why and how far it reaches", /date \(2026-10-03\) passed/.test(w.facts[0]?.reason ?? "") && /this event/.test(w.facts[0]?.scope ?? ""), w.facts[0]);
}

// ---------------------------------------------------------------- tiers (c): undated backlog items are classified and dated, or exit
{
  const w = world([{ ask_id: "a1", items: [ev("Fleet Fest"), ev("Sound Bath Meditation"), ev("Unreadable Page")] }], {
    classify: (m: any) => m.name === "Fleet Fest" ? { match: { ...m, form: "event", statedDates: { start: "2026-10-10", end: "2026-10-11" } }, result: "dated_event" } : m.name === "Sound Bath Meditation" ? { match: { ...m, form: "event" }, result: "undated" } : { match: m, result: "unknown" },
  });
  const r = await W.pruneBacklogs("u", TODAY, w.deps);
  const names = w.store.get("a1")!.map((i: any) => i.match.name);
  check("tiers (c): an undated item is classified and kept with its date", names.includes("Fleet Fest") && w.store.get("a1")!.find((i: any) => i.match.name === "Fleet Fest").match.statedDates.start === "2026-10-10");
  // Review of #133: one read never exits; held (never offered) and read again once a day, out after 3 separate days.
  const sound = w.store.get("a1")!.find((i: any) => i.match.name === "Sound Bath Meditation");
  check("an event whose page has no date is held, not exited, on its first read", !!sound && sound.unread?.why === "undated" && sound.unread.days.join() === TODAY && !w.facts.some((f) => f.label === "Sound Bath Meditation"), sound);
  check("one whose page couldn't be read is held too", w.store.get("a1")!.find((i: any) => i.match.name === "Unreadable Page")?.unread?.why === "unknown" && r.exited === 0);
  check("a held item is never offered", !W.offerable(sound) && W.offerable(w.store.get("a1")!.find((i: any) => i.match.name === "Fleet Fest")));
  const sameDay = world([{ ask_id: "a1", items: [{ ...ev("Sound Bath"), unread: { days: [TODAY], why: "undated" } }] }], { classify: (m: any) => { throw new Error("read again the same day"); } });
  await W.pruneBacklogs("u", TODAY, sameDay.deps);
  check("it's read at most once a day (three passes in one day aren't three days)", sameDay.store.get("a1")!.length === 1 && sameDay.store.get("a1")![0].unread.days.length === 1);
  const third = world([{ ask_id: "a1", items: [{ ...ev("Sound Bath"), unread: { days: ["2026-10-07", "2026-10-08"], why: "undated" } }] }], { classify: (m: any) => ({ match: { ...m, form: "event" }, result: "undated" }) });
  await W.pruneBacklogs("u", TODAY, third.deps);
  check("on its third separate day without a date it exits, saying so", !third.store.get("a1")!.length && /didn't say when it is on 3 separate days/.test(third.facts[0]?.reason ?? ""), third.facts);
  const later = world([{ ask_id: "a1", items: [{ ...ev("Sound Bath"), unread: { days: ["2026-10-08"], why: "unknown" } }] }], { classify: (m: any) => ({ match: { ...m, form: "event", statedDates: { start: "2026-10-18" } }, result: "dated_event" }) });
  await W.pruneBacklogs("u", TODAY, later.deps);
  check("a held item whose page later gives a date is kept, no longer held", later.store.get("a1")!.length === 1 && !later.store.get("a1")![0].unread && later.store.get("a1")![0].match.statedDates.start === "2026-10-18");
  check("the picker prunes before it builds its pool, and a daily pass prunes everyone", /W\.pruneBacklogs\(userId, today, realPruneDeps\)/.test(src("services/sweepShadow.ts")) && /cron\.schedule\("30 7 \* \* \*"[\s\S]{0,300}pruneAllWorkingSets/.test(src("jobs/index.ts")));
}

// ---------------------------------------------------------------- lifecycle (b): the fact first, scoped, or the item stays
{
  const w = world([{ ask_id: "a1", items: [ev("Castro Street Fair", { m: { statedDates: { start: "2026-10-04" }, form: "event" } })] }]);
  await W.pruneBacklogs("u", TODAY, w.deps);
  check("(b) the exit's fact is written before the backlog is saved without it", w.log.indexOf("fact Castro Street Fair") > -1 && w.log.indexOf("fact Castro Street Fair") < w.log.findIndex((l) => l.startsWith("save a1")), w.log);
  const down = world([{ ask_id: "a1", items: [ev("Castro Street Fair", { m: { statedDates: { start: "2026-10-04" }, form: "event" } })] }], { failFact: () => true });
  await W.pruneBacklogs("u", TODAY, down.deps);
  check("a fact that can't be written keeps the item live", down.store.get("a1")!.length === 1);
  let threw = false;
  try { await W.writeExitFact({ userId: "u", kind: "find", itemKey: "k", label: "x", state: "rejected", reason: "no", scope: "" }); } catch { threw = true; }
  check("an exit without its own reason and scope is refused", threw);
  const label = W.exitFactLabel({ kind: "find", label: "Tech Parents & Founders mixer", state: "rejected", reason: "Co's daily pick: an investor mixer tied to Tech Week, which reads as performative to him", scope: "this find, for: events this weekend; nothing broader about what they like" });
  check("the fact carries the reason and the scope, never just a verdict", /Set aside the find "Tech Parents & Founders mixer": Co's daily pick: an investor mixer/.test(label) && /Scope: this find, for: events this weekend; nothing broader/.test(label), label);
  check("an ask exits fact first, then the one close (askKind.ts closeAsk)", (() => { const s = src("services/workingSet.ts"); const f = s.slice(s.indexOf("export async function exitAsk")); return f.indexOf("writeExitFact") < f.indexOf("closeAsk(") && /if \(!ok\) return false;/.test(f); })());
  check("a date-expired ask writes its fact before it closes", (() => { const s = src("services/askExpiry.ts"); return s.indexOf("writeExitFact") > -1 && s.indexOf("writeExitFact") < s.indexOf("UPDATE ask_checkins SET resolved_at = NOW(), expired_at = NOW()"); })());
  check("a goal set aside or done writes its fact first, once (only on a real change)", /if \(state !== "active" && prior !== state\) \{[\s\S]{0,300}writeExitFact[\s\S]{0,400}if \(!ok\) return false;\s*\}\s*await writeGoalState[\s\S]{0,80}return true;/.test(src("services/goalEdges.ts")));
}

// ---------------------------------------------------------------- lifecycle (a): exited means inert
{
  const w = world([
    { ask_id: "a1", items: [ev("San Francisco Fleet Week Air Show"), ev("Mahjong Party", { tier: 2, kind: "public_event", m: { event_date: "2026-10-13" } })] },
    { ask_id: "a2", items: [ev("San Francisco Fleet Week Air Show")] },
  ]);
  const n = await W.exitRejectedFinds("u", [{ key: F.exitKey(ev("San Francisco Fleet Week Air Show").match), name: "San Francisco Fleet Week Air Show", why: "an air show doesn't fit his stated wish to avoid performative events", askText: "events this weekend" }], w.deps);
  check("(a) a find the picker rejected leaves every backlog, queued or not", n === 1 && !w.store.get("a1")!.some((i: any) => /Fleet/.test(i.match.name)) && !w.store.get("a2")!.length);
  check("its fact keeps the picker's reason and is scoped to the find and the ask", w.facts[0]?.state === "rejected" && /air show doesn't fit/.test(w.facts[0].reason) && /this find, for: events this weekend; nothing broader/.test(w.facts[0].scope), w.facts[0]);
  const ess = src("services/eventSurfacingSweep.ts");
  check("an exited find found again by a sweep stays out (never re-queued)", /exitedFindKeys\(userId, items\.map\(\(i\) => exitKey\(i\.match\)\)\)/.test(ess) && /if \(exited\.has\(exitKey\(it\.match\)\)\) continue;/.test(ess) && /exitedFindKeys\(userId, \[exitKey\(item\.match\)\]\)/.test(ess));
  check("every picker reject runs the exit, not only queued rows", /\.filter\(\(j\) => j\.verdict === "reject"\)[\s\S]{0,800}exitRejectedFinds/.test(src("services/sweepShadow.ts")));
}

// ---------------------------------------------------------------- lifecycle (c): only live items count
{
  check("(c) an open ask is live; a closed one carries its exit state", W.askLifeState({ resolved_at: null }) === "live" && W.askLifeState({ resolved_at: "x", closed_reason: "expired" }) === "expired" && W.askLifeState({ resolved_at: "x", closed_reason: "member_gone" }) === "cancelled" && W.askLifeState({ resolved_at: "x", closed_reason: "nothing_found" }) === "expired");
  check("a waiting find is live, a sent one fulfilled, a picker reject rejected, a stale one expired", W.candidateLifeState({ status: "pending" }) === "live" && W.candidateLifeState({ status: "sent" }) === "fulfilled" && W.candidateLifeState({ status: "skipped", skip_reason: "Co's daily pick: reject, …" }) === "rejected" && W.candidateLifeState({ status: "skipped", skip_reason: "stale: passed" }) === "expired");
  check("every state is one of the six", ["live", "fulfilled", "expired", "rejected", "superseded", "cancelled"].join() === W.LIFE_STATES.join());
  // Backoff, then out.
  const now = new Date("2026-10-09T15:00:00Z");
  check("an ask that came back empty 3 times backs off to every 3 days", !W.askSearchDue({ empty_runs: 3, last_attempted_at: new Date("2026-10-08T15:00:00Z") }, now) && W.askSearchDue({ empty_runs: 3, last_attempted_at: new Date("2026-10-06T14:00:00Z") }, now) && W.askSearchDue({ empty_runs: 2, last_attempted_at: new Date("2026-10-09T08:00:00Z") }, now));
  check("after 6 empty runs it exits as searched, nothing found", W.askExhausted({ empty_runs: 6 }) && !W.askExhausted({ empty_runs: 5 }) && /closedReason: "nothing_found", reason: `searched \$\{t\.empty_runs\} times, nothing found`/.test(src("jobs/index.ts")));
  check("each run counts its empty runs (a find resets them)", /UPDATE ask_checkins SET empty_runs = CASE WHEN \$2 THEN 0 ELSE empty_runs \+ 1 END/.test(src("services/eventSurfacingSweep.ts")));
  // Person asks and action requests.
  check("a person to meet goes to intros, never the search", /Answer "person" if it's asking for one particular kind of person/.test(src("services/askKind.ts")) && /if \(row\.kind === "person"\) \{[\s\S]{0,400}attemptNetworkSurfacing/.test(src("jobs/index.ts")));
  check("an action request (email, call, book) is help, never a find ask", /Answer "help" too when it asks Co to take an action for them \(email, call, text, book/.test(src("services/askKind.ts")));
  check("open find asks read under the old prompt are read once more", /COALESCE\(kind_version, 1\) < \$2/.test(src("services/askKind.ts")));
  // Identity in queries.
  check("a search never assumes who they are", Q.assumedIdentity("men's circle vulnerability sharing San Francisco", "seeking a room/gathering where they can drop their guard").join() === "men's");
  check("a group word they used themselves is fine", Q.assumedIdentity("women's hiking group SF", "looking for a women's hiking group").length === 0);
  check("the sweep's ledger refuses an assumed-identity query", Q.queryProblems("men's circle vulnerability sharing", { terms: [], source: "web", theirWords: "a room where I can drop my guard" }).some((p) => /assumes who they are/.test(p)) && /new QueryLedger\(memberTerms\([\s\S]{0,120}\), c\.askText, record\.avoid\)/.test(src("services/sweepFind.ts")));
  // An urgent find triggers a pick run.
  const ten = new Date("2026-10-09T17:30:00Z"); // 10:30am Pacific
  check("a find ending before the next scheduled pick (tomorrow 10am) triggers a pick run", ES.endsBeforeNextPick({ statedDates: { start: "2026-10-09" }, form: "event" } as any, "America/Los_Angeles", ten) && !ES.endsBeforeNextPick({ statedDates: { start: "2026-10-12" }, form: "event" } as any, "America/Los_Angeles", ten));
  check("…through a bounded urgent run (at most 3 extra a day, members the picker serves)", /if \(found\.some\(\(f\) => endsBeforeNextPick\(f\.match, zone\)\)\)/.test(src("services/eventSurfacingSweep.ts")) && /URGENT_PICK_RUNS_PER_DAY = 3/.test(src("services/sweepShadow.ts")) && /export async function rerunPickerForUrgentFind[\s\S]{0,200}shadowUserIds/.test(src("services/sweepShadow.ts")));
}

// ---------------------------------------------------------------- lifecycle (d): restating an old ask opens a fresh one
{
  const d = PW.decideAskWrite({ text: "Find a DJ in SF for Oct 10 around $500", embedding: null }, []);
  check("(d) a restated ask that has exited (not among the open asks) opens new", d.action === "open_new");
  check("the comparison only reads open asks, so an exited one is never revived", /SELECT ask_id, ask_text FROM ask_checkins WHERE user_id = \$1 AND resolved_at IS NULL/.test(src("services/profileExtraction.ts")));
}

// ---------------------------------------------------------------- lifecycle (e): gone members get zero sweeps
{
  const jobs = src("jobs/index.ts");
  check("(e) the ask sweep reads only live members", /AND u\.archived_at IS NULL AND COALESCE\(u\.sms_opted_out, false\) = false/.test(jobs));
  check("their open asks close (cancelled, with a fact), and their backlog and waiting texts too", /WHERE ac\.resolved_at IS NULL AND \(u\.archived_at IS NOT NULL OR COALESCE\(u\.sms_opted_out, false\)\)/.test(src("services/workingSet.ts")) && /state: "cancelled", reason: why/.test(src("services/workingSet.ts")));
  check("the goal sweep already skipped them", /u\.sms_opted_out = false AND u\.phone_number IS NOT NULL AND u\.archived_at IS NULL/.test(src("services/goalSweep.ts")));
}

// ---------------------------------------------------------------- lifecycle (f): the report
{
  const lines = W.workingSetLines([{ userId: "u1", name: "Royce", asks: 7, goals: 12, finds: 2, backlog: 34, sweeps24h: 6, web24h: 30, x24h: 4 }, { userId: "u2", name: "Jordan", asks: 0, goals: 0, finds: 0, backlog: 0, sweeps24h: 20, web24h: 19, x24h: 0 }]);
  check("(f) the report shows each member's working set and search spend", lines.length === 3 && /Royce: 7 asks, 12 goals, 2 finds waiting, 34 in backlog \| 6 sweeps, 30 web \+ 4 X searches/.test(lines[1]) && /Jordan: .* 20 sweeps, 19 web/.test(lines[2]), lines);
  check("it's in the daily report", /W\.workingSetLines\(await W\.workingSetRows\(\)/.test(src("harness/devReview.ts")));
}

// ---------------------------------------------------------------- lifecycle (g): no new state store
{
  const ws = src("services/workingSet.ts");
  check("(g) exits write through the existing fact record (coFacts recordFactChecked, co_facts)", /recordFactChecked\(\{/.test(ws) && /relation = \$2/.test(ws) && !/CREATE TABLE/.test(ws) && !/CREATE TABLE/.test(src("services/findForm.ts")));
  check("the only schema change is two columns on the ask rows that already exist", /ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS empty_runs INT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS kind_version/.test(src("db/migrations.ts")));
  check("states are read from the rows that already hold the items (closed_reason, status), never a second copy", /closed_reason/.test(ws) && /status === "pending"/.test(ws));
  check("the PR template asks every state-writing change how it exits", /how it leaves the working set/.test(fs.readFileSync(new URL("../../../.github/pull_request_template.md", import.meta.url), "utf8")));
}

// ---------------------------------------------------------------- tiers (d)/(f): a failed draft re-enters
{
  check("tiers (d): a failed draft is not a decision; it re-enters the working set", W.isFailedAttempt("draft failed checks: draft_length: 507 chars (max 300)") && W.candidateLifeState({ status: "skipped", skip_reason: "draft failed checks: draft_length" }) === "live");
  check("failed attempts alone don't decide a thing; a sent row, a reject or a stale skip does", !W.decidedByRows([{ skip_reason: "draft failed checks: draft_length: 507 chars (max 300)" }]) && W.decidedByRows([{ skip_reason: null }]) && W.decidedByRows([{ skip_reason: "Co's daily pick: reject" }]) && W.decidedByRows([{ skip_reason: "draft failed checks" }, { skip_reason: "stale: x" }]));
  const ess = src("services/eventSurfacingSweep.ts");
  check("tiers (f): the founders dinner's failed Oct 6 row is cleared so the pick lands (the queue's one-row-per-thing insert used to do nothing)", /await reopenFailedAttempt\(userId, offerTargetKey\(item\)\);\s*const \{ queued \} = await enqueueCandidate/.test(ess) && /if \(!failed\.length \|\| failed\.length !== rows\.length\) return false;/.test(ess));
}

// ---------------------------------------------------------------- tiers (e): the pitch follows the classification
{
  const now = new Date("2026-10-07T18:00:00Z"); // a Wednesday
  check("tiers (e): an event is pitched with its day", F.formLabel({ kind: "opportunity", form: "event", statedDates: { start: "2026-10-10" } }, "America/Los_Angeles", now) === "an event on Saturday");
  check("an opening with a deadline is pitched with it", F.formLabel({ kind: "opportunity", form: "opening", deadline: "2026-10-09" }, "America/Los_Angeles", now) === "an opening, applications close Friday");
  check("a rolling opening says so", F.formLabel({ kind: "opportunity", form: "opening" }, "America/Los_Angeles", now) === "an opening you can apply to or join now");
  check("a Co event and a public event keep their names, with the day", F.formLabel({ kind: "co_event", event_date: "2026-10-08" }, "America/Los_Angeles", now) === "a Co event tomorrow" && F.formLabel({ kind: "public_event", event_date: "2026-10-20" }, "America/Los_Angeles", now) === "an event on Oct 20");
  check("never the generic \"a real opportunity\"", !/a real opportunity"\s*;?\s*$/m.test(src("agent/eventDiscoverySurfacing.ts").replace(/\/\/.*$/gm, "")) && /return formLabel\(match, zone\);/.test(src("agent/eventDiscoverySurfacing.ts")) && !/\(a real opportunity Co pointed/.test(src("harness/proactiveRegistry.ts")));
}

// ---------------------------------------------------------------- review of #133: the 14 findings
{
  // 1. Dates in the member's zone.
  check("#1 a 7pm Pacific timestamp is that day for a Pacific member, not the next UTC day", F.dayIn("2026-10-10T02:00:00Z", "America/Los_Angeles") === "2026-10-09" && F.dayIn("2026-10-10T02:00:00Z", "Europe/London") === "2026-10-10" && F.dayIn("2026-10-09", "Asia/Tokyo") === "2026-10-09");
  check("#1 an event's date and end read in their zone", F.eventDateOf({ details: { startAt: "2026-10-10T02:00:00Z" } }, "America/Los_Angeles") === "2026-10-09" && F.lifeEndOf({ kind: "public_event", details: { startAt: "2026-10-10T02:00:00Z" } }, "America/Los_Angeles") === "2026-10-09");
  // 2. Dates parsed as whole tokens.
  const on = (t: string) => [...F.datesOnPage(t, 2026)];
  check("#2 every common way a page writes a date is read", ["Oct 06", "10/06/2026", "06 Oct 2026", "6th of October", "October 6th, 2026", "06.10.2026", "2026-10-06"].every((t) => on(t).includes("2026-10-06")) && on("Sept 12").includes("2026-09-12"), ["Oct 06", "10/06/2026", "06 Oct 2026", "06.10.2026"].map(on));
  check("#2 a phone number or a stray substring is never a date", !on("Call 415-10-12 or 10-12-2026x").includes("2026-10-12") && !on("Room 110/122").length && on("Doors 10/12").join() === "2026-10-12");
  check("#2 an undated item leaves only after repeated failed reads on separate days", W.UNREAD_DAYS === 3);
  // 3. A deadline means opening.
  check("#3 a find with a deadline is an opening even when it also carries a start date", F.formOf({ kind: "opportunity", deadline: "2026-10-05", statedDates: { start: "2026-11-01" } } as any) === "opening" && F.lifeEndOf({ kind: "opportunity", deadline: "2026-10-05", statedDates: { start: "2026-11-01" } }) === "2026-10-05");
  // 4. Web finds exit by name plus date (or link).
  const weekly = (d: string) => F.exitKey({ kind: "opportunity", name: "SF Chess Night", statedDates: { start: d } });
  check("#4 a weekly find that exits once can come back next week", weekly("2026-10-09") !== weekly("2026-10-16") && weekly("2026-10-09") === F.exitKey({ kind: "opportunity", name: "sf chess night ", statedDates: { start: "2026-10-09" } }));
  check("#4 an undated find is keyed by its link; a Co event by its id", F.exitKey({ name: "A", url: "https://A.com/x" }) === "opportunity:a|https://a.com/x" && F.exitKey({ event_api_id: "evt_1", name: "Dinner" }) === "event:evt_1");
  // 5. A failed search isn't an empty run.
  const ess = src("services/eventSurfacingSweep.ts");
  const sf = src("services/sweepFind.ts");
  check("#5 empty runs count only when a search really ran", /&& trace\.searched\) \{\s*await pool\.query\(`UPDATE ask_checkins SET empty_runs/.test(ess) && (sf.match(/searched = true/g) ?? []).length === 3);
  // 6. Person asks are in the people graph and Mo's gaps.
  check("#6 person asks count in peopleGraph and Mo's network gaps", /kind IN \('find', 'person'\)/.test(src("services/peopleGraph.ts")) && (src("mo/team.ts").match(/kind IN \('find', 'person'\)/g) ?? []).length === 2);
  // 7. A goal change that didn't happen is never reported.
  const lt = src("agent/loopTools.ts");
  check("#7 markGoal reports an error when the goal didn't change", /const changed = await G\.setGoalState\([\s\S]{0,200}\.catch\(\(\) => false\);\s*if \(!changed\) return \{ ok: false, error: "The goal couldn't be marked just now; nothing changed\. Don't tell them it was\." \};/.test(lt));
  check("#7 a short reason gets a scoped default, the member's words kept", /const why = reason\?\.trim\(\) && reason\.trim\(\)\.length >= 6 \? reason\.trim\(\) : reason\?\.trim\(\) \? `\$\{base\} \(\$\{reason\.trim\(\)\}\)` : base;/.test(src("services/goalEdges.ts")));
  // 8. Concurrent saves don't drop each other's finds.
  const before = [ev("A"), ev("B")];
  const midRun = [...before, ev("C added by a sweep mid-run")];
  const merged = W.applyChange(midRun, { remove: new Set([F.exitKey(ev("A").match)]), replace: new Map([[F.exitKey(ev("B").match), { ...ev("B"), unread: { days: [TODAY], why: "unknown" } }]]) }, F.exitKey);
  check("#8 a prune merges into the current row: a find added mid-run survives", merged.length === 2 && merged.some((i: any) => /^C /.test(i.match.name)) && merged.find((i: any) => i.match.name === "B")?.unread?.why === "unknown", merged.map((i: any) => i.match.name));
  check("#8 the merge locks the row it changes", /SELECT items FROM event_backlogs[\s\S]{0,200}FOR UPDATE/.test(src("services/sweepShadow.ts")));
  // 9. Exit facts: member-safe reasons, kept out of the reply ledger.
  check("#9 a picker reject's reason goes through the member-safe filter", /why: memberSafeWhy\(String\(j\.why \?\? j\.reason \?\? ""\)\)/.test(src("services/sweepShadow.ts")));
  check("#9 exit facts stay out of what replies read", /relation <> 'exited'/.test(src("services/coFacts.ts")) && /relation <> 'exited'/.test(src("services/followThrough.ts")));
  // 10. A send error is a failed attempt.
  check("#10 a send error is a failed attempt, not a decision", W.isFailedAttempt("send error: 502") && !W.decidedByRows([{ skip_reason: "send error: 502" }]));
  // 11. "3 passes" means 3 days (the hold tests above run it).
  check("#11 an unread item is read at most once a day", /days\.includes\(today\)/.test(src("services/workingSet.ts")));
  // 12. Identity: whole words, venues allowed.
  check("#12 'men's' is caught even when they said 'mentor'", Q.assumedIdentity("men's founder circle SF", "looking for a mentor").includes("men's"));
  check("#12 a venue or a phrase that isn't about people passes", !Q.assumedIdentity("events at the Women's Building SF", "events this weekend").length && !Q.assumedIdentity("black tie gala SF", "a gala").length && !Q.assumedIdentity("senior engineer meetup", "meetups").length);
  check("#12 an identity they said themselves passes", !Q.assumedIdentity("women's founder dinner", "I'm a woman founder, any women's dinners").length && Q.assumedIdentity("Black founders mixer", "founder mixers").length === 1);
  // 13. Classification capped per sweep, the sweep's page reused.
  check("#13 at most a few new finds are read per sweep; the rest are held, not dropped", ES.CLASSIFY_PER_SWEEP === 3 && /if \(!known && reads >= CLASSIFY_PER_SWEEP\) \{\s*out\.push\(\{ \.\.\.it, unread: \{ days: \[\], why: "unknown" \} \}\);/.test(ess));
  let fetched = 0;
  const reused = await F.classifyFind({ tier: 3, kind: "opportunity", name: "Ramen Pop-up", url: "https://r", evidence: "Ramen pop-up on Oct 14. ".repeat(30), reason: "" } as any, TODAY, { page: async () => { fetched++; return ""; }, model: async () => '{"form":"event","date":"2026-10-14"}' });
  check("#13 the page the sweep already read is used, not fetched again", fetched === 0 && reused.result === "dated_event");
  // 14. Restating an ask resets its empty runs.
  check("#14 restating an open ask resets its empty-run count", /last_mentioned_at = NOW\(\), empty_runs = 0/.test(src("services/profileExtraction.ts")));
  // The held items stay out of every offer path.
  check("held items are never offered: picker pool, queue, task finds", /!it\?\.unread/.test(src("services/sweepShadow.ts")) && /item\.unread/.test(ess) && /!it\?\.unread/.test(src("services/taskTurn.ts")));
}

// ---------------------------------------------------------------- re-review of #133
{
  const on = (t: string) => [...F.datesOnPage(t, 2026)];
  check("a range in one month puts every day on the page, so a festival's last day is kept", ["Oct 6-8", "October 6 – 8, 2026", "Oct 6 to 8"].every((t) => on(t).includes("2026-10-08") && on(t).includes("2026-10-07")) && F.readClassification('{"form":"event","date":"2026-10-06","end":"2026-10-08"}', "Hardly Strictly, Oct 6-8")?.end === "2026-10-08");
  check("a rating, a measure, a price or a version isn't a date", !on("4/5 stars").length && !on("3/4 cup flour").length && !on("$10/12").length && !on("version 1.2.2026").length && !on("v1.2.2026").length && on("Doors 10/12").join() === "2026-10-12");
  check("a timestamp with a space, or with no offset, keeps its written date", F.dayIn("2026-10-10 19:00", "America/Los_Angeles") === "2026-10-10" && F.dayIn("2026-10-10T02:00:00", "America/Los_Angeles") === "2026-10-10");
  check("Title Case doesn't hide an identity term; a real place still passes", ["Black Women In Tech Summit", "Gay Bar Crawl", "Queer Film Fest", "Men's Circle Vulnerability", "Christian Fellowship"].every((q) => Q.assumedIdentity(q, "tech events").length > 0) && !Q.assumedIdentity("Asian Art Museum late night", "events").length && !Q.assumedIdentity("talk at the Women's Building", "talks").length && !Q.assumedIdentity("Veterans Memorial Building gala", "galas").length);
  check("lgbtq+ they said matches lgbtq+ in the query", !Q.assumedIdentity("LGBTQ+ mixer SF", "any lgbtq+ events").length);
  const ess = src("services/eventSurfacingSweep.ts");
  check("a find exited under its classified key stays out when found again raw", /if \(k !== exitKey\(it\.match\) && \(exited\.has\(k\)/.test(ess));
  check("short notice is judged in their zone", /function isShortNotice\(match: TierMatch, zone: string \| null = null\): boolean \{\s*const date = relevantDate\(match, zone\);/.test(ess));
  check("every sweep write to the backlog merges under the row lock", !/async function saveBacklog\(/.test(ess) && (ess.match(/saveBacklogMerged\(/g) ?? []).length === 3 && /FOR UPDATE/.test(ess));
  const k = F.exitKey;
  const read = [ev("A"), ev("B"), ev("C")];
  const now = [ev("A"), { ...ev("C"), unread: { days: ["2026-10-08", TODAY], why: "unknown" } }, ev("D picked elsewhere")];
  const next = [ev("A"), ev("B"), { ...ev("C"), unread: { days: ["2026-10-08"], why: "unknown" } }, ev("E new")];
  const m = W.mergeSweepSave(read, next, now, k).map((i: any) => i.match.name);
  check("the sweep's save keeps others' removals and adds, and the read days since", m.join() === "A,C,E new,D picked elsewhere" && W.mergeSweepSave(read, next, now, k).find((i: any) => i.match.name === "C").unread.days.length === 2, m);
  const dup = W.applyChange([ev("A"), ev("A")], { remove: new Set(), replace: new Map([[k(ev("A").match), { ...ev("A"), unread: { days: [TODAY], why: "unknown" } }]]) }, k);
  check("two items under one key are replaced once, not copied", dup.length === 1);
  const sf = src("services/sweepFind.ts");
  check("an ask whose queries are refused or that searches nothing still counts its run; an outage doesn't", /searched: searched \|\| !blocked/.test(sf) && (sf.match(/blocked = true;/g) ?? []).length === 5);
  check("a goal set aside only when the change really happened", /const changed = await deps\.setState\([\s\S]{0,120}\.catch\(\(\) => false\);\s*if \(changed !== false\) \{\s*setAside\.push/.test(src("services/goalEdges.ts")));
}

console.log(`working set + tiers: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
