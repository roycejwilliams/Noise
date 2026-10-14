// One find per tier, every morning (Royce, 2026-10-14: "we are suppose to send one find per tier, but one not being available
// shouldn't stop things from being sent out"). The 9am floor's picker run sends the best find of each tier that has any; fit and taste
// decide WHICH find in a tier goes, never WHETHER the tier sends; a find is held back only for a reason code can verify. Zero tokens:
// the picker's verdicts are fixed strings, the claim check is a stub that answers by rule.
//   npx tsx evals/sweepSelect/tierPicks.ts
import { readFileSync } from "fs";
import { checkClaims, guardVerdicts, heldBackFor, holdDueDates, MORNING_NOTE, parseVerdicts, selectPrompt, SELECT_SYSTEM, tierPicks, type ClaimJudge, type Judgment, type PoolItem, type SelectContext } from "../../src/services/sweepSelect.js";
import { judgeSweepItem } from "../../src/brain/index.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};

// The claim check's stub: their words rule a thing out when the record says "not giant mixers" and the thing is a large community; a
// record is about a find when it names it; a timing question is yes when the find says "closed"; a why claims a record when it says so.
const judgeCalls: string[] = [];
const stub = (o: { fail?: boolean } = {}): ClaimJudge => async (prompt) => {
  judgeCalls.push(prompt);
  if (o.fail) throw new Error("down");
  const answers: { id: string; yes: boolean }[] = [];
  for (const m of prompt.matchAll(/^(U\d+): this thing: ([^\n]*)\n\s+the record: ([^\n]*)$/gm)) answers.push({ id: m[1], yes: /giant mixers/i.test(m[3]) && /largest community|400\+|hundreds/i.test(m[2]) });
  for (const m of prompt.matchAll(/^(R\d+): this thing: ([^\n]*)\n\s+the record: ([^\n]*)$/gm)) answers.push({ id: m[1], yes: m[3].toLowerCase().includes(m[2].split(" (")[0].split(":")[0].toLowerCase()) });
  for (const m of prompt.matchAll(/^(L\d+): ([^\n]*)$/gm)) answers.push({ id: m[1], yes: /applications closed|already over/i.test(m[2]) });
  for (const m of prompt.matchAll(/^(W\d+): "([^\n]*)"$/gm)) answers.push({ id: m[1], yes: /\b(closed|done|set aside|already)\b/i.test(m[2]) });
  return { text: JSON.stringify({ answers }), input: 300, output: 20 };
};

const TODAY = "2026-10-15";
const item = (id: string, name: string, tier: number, o: Partial<PoolItem> = {}): PoolItem => ({ id, key: `${name.toLowerCase()}|`, name, date: null, tier, kind: "discovery", asks: [], ...o });
const base = (pool: PoolItem[], o: Partial<SelectContext> = {}): SelectContext => ({
  firstName: "Jordan",
  city: "San Francisco",
  today: TODAY,
  weekday: "Thursday",
  asks: [{ id: "A1", text: "small founder dinners, not giant mixers", since: "2026-10-12" }],
  texts: [
    { id: "T1", at: "Oct 12 09:21", from: "member", text: "A small group who actually see each other. Dinners, a hike crew, not giant mixers with name tags" },
    { id: "T2", at: "Oct 12 09:22", from: "co", text: "Got it." },
  ],
  sent: [{ id: "S1", at: "Oct 13", what: "event_offer: Found one: Founders Supper Club, Thursday dinners", reaction: null }],
  outcomes: [],
  feeling: null,
  discoveryLeft: 4,
  pool,
  morning: true,
  ...o,
});
const run = async (c: SelectContext, verdicts: unknown[], judge: ClaimJudge = stub()) => {
  const checked = await checkClaims(c, guardVerdicts(c, parseVerdicts(JSON.stringify({ verdicts }))!), judge);
  return c.morning ? tierPicks(c, checked.judgments) : checked.judgments;
};
const sends = (js: Judgment[]) => js.filter((j) => j.verdict === "send").map((j) => j.id).sort().join(",");
const rej = (id: string, reason: string, why = "only loosely related", extra: Record<string, unknown> = {}) => ({ id, verdict: "reject", reason, why, ...extra });
const send = (id: string, extra: Record<string, unknown> = {}) => ({ id, verdict: "send", whyMember: "they asked for small dinners", cites: ["A1"], whyNow: "this week", wow: true, lastDay: null, ...extra });

// ---------------------------------------------------------------- the rule
{
  const pool = [item("C1", "Co Supper Club", 1), item("C2", "Climate Founders Hike", 2), item("C3", "Founder Residency", 3)];
  const all = await run(base(pool), [send("C1"), rej("C2", "weak_fit"), rej("C3", "not_them", "not their scene")]);
  check("three tiers with one find each: all three go, whatever the wow bar said of two of them", sends(all) === "C1,C2,C3" && all.filter((j) => j.tierPick).length === 3, all);
  check("a find the picker didn't send goes as the tier's pick, with the guard saying so", all.find((j) => j.id === "C2")!.reason === "tier_pick" && /the best of its tier this morning \(Co said weak_fit, not a reason to hold it back\)/.test(all.find((j) => j.id === "C2")!.guard ?? ""));
  const noTier3 = await run(base(pool.slice(0, 2)), [send("C1"), rej("C2", "weak_fit")]);
  check("tier 3 empty: tiers 1 and 2 still go", sends(noTier3) === "C1,C2");
  const two = await run(base([item("C1", "Founder Dinner East", 2, { kind: "discovery" }), item("C2", "Founder Dinner West", 2)]), [{ ...send("C1"), rank: 2 }, { ...send("C2"), rank: 1 }]);
  check("two finds in one tier: only one goes, the picker's rank 1; the other waits in the backlog", sends(two) === "C2" && two.find((j) => j.id === "C1")!.verdict === "hold" && two.find((j) => j.id === "C1")!.reason === "tier_taken" && judgeSweepItem(two.find((j) => j.id === "C1")! as any).drop === false, two);
  const asksFirst = await run(base([item("C1", "Goal Find", 2, { kind: "discovery" }), item("C2", "Asked-For Dinner", 2, { kind: "answer", asks: ["A1"] })]), [{ ...send("C1"), rank: 1 }, { ...rej("C2", "weak_fit"), rank: 2 }]);
  check("what they asked for goes first within a tier, ahead of a goal find the picker ranked higher", sends(asksFirst) === "C2", asksFirst);
  const weak = await run(base([item("C1", "Climate Founders Hike", 2)]), [rej("C1", "weak_fit", "only loosely related, not a wow")]);
  check("a weak_fit with no cite never holds a tier back", sends(weak) === "C1");
  const notWow = await run(base([item("C1", "Climate Founders Hike", 2)]), [{ ...send("C1"), wow: false }]);
  check("a 'not a wow' send (refused by the send guard) still goes as its tier's find", sends(notWow) === "C1");
}

// ---------------------------------------------------------------- held back only for a real reason, then the next best goes
{
  const pool = [item("C1", "Founders Supper Club", 2), item("C2", "Climate Founders Hike", 2)];
  const known = await run(base(pool), [{ ...rej("C1", "already_known", "Co sent this exact supper club on Oct 13", { cites: ["S1"] }), rank: 1 }, { ...rej("C2", "weak_fit"), rank: 2 }]);
  check("the tier's best held back for a real reason (already sent, cite names it): the next best goes", sends(known) === "C2" && known.find((j) => j.id === "C1")!.verdict === "reject" && heldBackFor(known.find((j) => j.id === "C1")!) !== null, known);
  const uncited = await run(base(pool), [{ ...rej("C1", "already_known", "they already have it"), rank: 1 }, { ...rej("C2", "weak_fit"), rank: 2 }]);
  check("an uncited already_known holds nothing back: the tier's best still goes", sends(uncited) === "C1", uncited);
  const past = await run(base([item("C1", "Last Week Mixer", 2, { date: "2026-10-10" }), item("C2", "Climate Founders Hike", 2)]), [{ ...send("C1"), rank: 1 }, { ...rej("C2", "weak_fit"), rank: 2 }]);
  check("a past find (the send guard's own date check) is held back; the next best goes", sends(past) === "C2");
  const lateYes = await run(base([item("C1", "Spring Cohort", 3, { details: "applications closed Oct 1" }), item("C2", "Winter Cohort", 3)]), [{ ...rej("C1", "too_late", "applications closed"), rank: 1 }, { ...rej("C2", "weak_fit"), rank: 2 }]);
  const lateNo = await run(base([item("C1", "Spring Cohort", 3, { details: "applications open to Nov 1" }), item("C2", "Winter Cohort", 3)]), [{ ...rej("C1", "too_late", "too far out"), rank: 1 }, { ...rej("C2", "weak_fit"), rank: 2 }]);
  check("too_late holds a find back only when the claim check confirms it from the find's own date and details", sends(lateYes) === "C2" && lateYes.find((j) => j.id === "C1")!.late === true && sends(lateNo) === "C1", { lateYes, lateNo });
  const every = await run(base([item("C1", "Founders Supper Club", 2)]), [rej("C1", "already_known", "Co sent it Oct 13", { cites: ["S1"] })]);
  check("a tier stays empty only when every find in it has a real reason against it", sends(every) === "");
  const failRead = await run(base([item("C1", "Big Climate Community", 3, { details: "our largest community, 400+ members" })]), [rej("C1", "ruled_out", "she said not giant mixers", { cites: ["A1"] })], stub({ fail: true }));
  // Royce, 2026-10-14: "A failed check buys a hold, never a send". Held for the morning (never exited), the tier sends nothing else here.
  check("a claim check that fails holds the find for the morning: not sent, not exited, flagged", sends(failRead) === "" && failRead[0].verdict === "hold" && failRead[0].checkFailed === true, failRead);
}

// ---------------------------------------------------------------- their own words
{
  // Noor (10-14, renamed Rina): one tier-3 find, a community that "has grown into our largest community"; her ask and text say "not
  // giant mixers". The picker said weak_fit then; with ruled_out citing her words, the claim check confirms, and nothing else is in the tier.
  const RINA = base([item("C1", "Climate Tech Cities (local chapters)", 3, { kind: "answer", asks: ["A1"], details: "started as an 8-person dinner, has grown into our largest community of climate founders, funders and talent" })], { firstName: "Rina", asks: [{ id: "A1", text: "seeking a small, tight-knit group of climate founders or operators for dinners and a hike crew, not big mixers", since: "2026-10-12" }], texts: [{ id: "T16", at: "Oct 12 09:21", from: "member", text: "Mostly I want a small group of climate founders or operators who actually see each other. Dinners, a hike crew, not giant mixers with name tags" }] });
  const rinaRuled = await run(RINA, [rej("C1", "ruled_out", "she said not giant mixers; this is their largest community", { cites: ["T16"] })]);
  check("Rina's mixer is held back by her own words when the claim check confirms them (her only tier-3 find: the tier is empty)", sends(rinaRuled) === "" && rinaRuled[0].verdict === "reject" && heldBackFor(rinaRuled[0]) !== null, rinaRuled);
  const rinaWeak = await run(RINA, [rej("C1", "weak_fit", "the big-group dynamic she doesn't want")]);
  check("as the picker actually judged it on 10-14 (weak_fit, no cite), it now goes", sends(rinaWeak) === "C1");
  const rinaOther = await run({ ...RINA, texts: [{ id: "T16", at: "Oct 12 09:21", from: "member", text: "I run product at a small climate startup" }] }, [rej("C1", "ruled_out", "not for her", { cites: ["T16"] })]);
  check("ruled_out citing words that don't rule it out holds nothing back", sends(rinaOther) === "C1");
  const rinaCo = await run(RINA, [rej("C1", "ruled_out", "Co said so", { cites: ["S1"] })]);
  check("ruled_out must cite their own words (an ask or a text of theirs); citing Co's send holds nothing back", sends(rinaCo) === "C1" && rinaCo[0].guard !== undefined);
  // Drake (10-14, renamed Marcus): a transactional law workshop; he's a criminal-law student attorney applying to firms. Nothing he
  // said rules it out, so it goes; a ruled_out citing his "applying to law firms" text is read as not ruling it out.
  const MARCUS = base([item("C1", "BCLT Transactional Law Skills Workshop with Freshfields", 3, { date: "2026-10-21", details: "a skills workshop for law students with Freshfields lawyers, Berkeley" })], { firstName: "Marcus", asks: [{ id: "A1", text: "seeking help drafting a pleading for dismissal for their client's case", since: "2026-10-12" }], texts: [{ id: "T15", at: "Oct 12 21:33", from: "member", text: "Job applications, I'm a third year law student applying to law firms. I also am a student attorney with a client who has a hearing on Friday in criminal court" }] });
  const marcusWeak = await run(MARCUS, [rej("C1", "weak_fit", "transactional law doesn't match his criminal-law practice area")]);
  const marcusRuled = await run(MARCUS, [rej("C1", "ruled_out", "his practice is criminal law", { cites: ["T15"] })]);
  check("Marcus's workshop goes: a practice-area weak_fit isn't a reason, and his own words don't rule it out", sends(marcusWeak) === "C1" && sends(marcusRuled) === "C1", { marcusWeak, marcusRuled });
}

// ---------------------------------------------------------------- what the morning reads, and what stays as it was
{
  const pool = [item("C1", "Co Supper Club", 1), item("C2", "Climate Founders Hike", 2)];
  const hourly = await run({ ...base(pool), morning: false }, [send("C1"), rej("C2", "weak_fit")]);
  check("the hourly picker sends on the wow bar as before, no tier picks; its weak_fit waits in the backlog instead of exiting", sends(hourly) === "C1" && hourly.find((j) => j.id === "C2")!.reason === "fit_only" && !hourly.some((j) => j.tierPick));
  const p = selectPrompt(base(pool));
  check("the morning prompt says one find per kind, rank within a kind, forThem, and what alone holds one back", p.includes(MORNING_NOTE) && /"rank"/.test(MORNING_NOTE) && /"forThem"/.test(MORNING_NOTE) && /never empties a kind/.test(MORNING_NOTE) && !selectPrompt({ ...base(pool), morning: false }).includes("MORNING SEND"));
  check("the system prompt stays the same for every run (cached) and knows ruled_out", !SELECT_SYSTEM.includes("MORNING SEND") && /ruled_out \(their own words rule out this thing or this kind of thing/.test(SELECT_SYSTEM));
  const v = parseVerdicts('{"verdicts":[{"id":"C2","verdict":"reject","reason":"weak_fit","why":"meh","rank":1,"forThem":"a hike crew of climate founders, small"}]}')!;
  check("the picker's rank and forThem are read", (v[0] as any).rank === 1 && (v[0] as any).forThem === "a hike crew of climate founders, small");
  const withFor = tierPicks(base(pool), guardVerdicts(base(pool), [send("C1") as any, v[0]]));
  const c2 = withFor.find((j) => j.id === "C2")!;
  check("a tier pick the picker didn't send carries its forThem line as its why, and no made-up why-now", c2.verdict === "send" && c2.why === "a hike crew of climate founders, small" && c2.whyNow === "");
  const taken = tierPicks(base([item("C1", "A", 2), item("C2", "B", 2)]), guardVerdicts(base([item("C1", "A", 2), item("C2", "B", 2)]), [send("C1") as any, send("C2") as any]));
  check("a tier's runner-up waits in the backlog and buys no picker run of its own (the next morning runs anyway)", taken.find((j) => j.id === "C2")!.reason === "tier_taken" && holdDueDates(taken, TODAY).length === 0);
  check("one judgment per candidate, at most one send per tier, at most three sends", (() => { const js = tierPicks(base([item("C1", "A", 1), item("C2", "B", 1), item("C3", "C", 2), item("C4", "D", 3), item("C5", "E", 0)]), guardVerdicts(base([item("C1", "A", 1), item("C2", "B", 1), item("C3", "C", 2), item("C4", "D", 3), item("C5", "E", 0)]), ["C1", "C2", "C3", "C4", "C5"].map((id) => send(id) as any))); return js.filter((j) => j.verdict === "send").length === 3 && js.length === 5; })());
  check("an untiered find counts as an opening (tier 3), so it never stacks a fourth send", (() => { const js = tierPicks(base([item("C4", "D", 3), item("C5", "E", 0)]), guardVerdicts(base([item("C4", "D", 3), item("C5", "E", 0)]), [send("C4") as any, send("C5") as any])); return js.filter((j) => j.verdict === "send").length === 1; })());
}

// ---------------------------------------------------------------- only a verified reason takes a find out, hourly runs included
{
  const SH = await import("../../src/services/sweepShadow.js");
  const { selectSignature, carryGuardedRuns } = await import("../../src/services/sweepSelect.js");
  const keyed = (p: PoolItem) => ({ ...p, key: SH.shadowKey(p.name, p.date) });
  const pool = [item("C1", "Founders Supper Club", 2), item("C2", "Climate Founders Hike", 2, { details: "applications closed last week" }), item("C3", "Big Climate Community", 3, { details: "our largest community, 400+ members" }), item("C4", "Last Week Mixer", 2, { date: "2026-10-10" })].map(keyed);
  const hourly = { ...base(pool), morning: false };
  const backlog = pool.map((p) => ({ askId: "profile", askText: "x", fromProfile: true, match: { name: p.name, ...(p.date ? { event_date: p.date } : {}) } }));
  const exits = (js: Judgment[]) => SH.rejectedFindsOf(js, backlog as any).map((e) => e.name).sort().join(" | ");
  for (const code of ["not_them", "weak_fit", "covered", "other"]) {
    const js = await run(hourly, [rej("C1", code, "not the room they want", code === "covered" ? { cites: ["C9"] } : {})]);
    check(`hourly: a ${code} reject without a verified reason waits in the backlog, never exits`, js[0].verdict === "hold" && exits(js) === "", js[0]);
  }
  const lateNo = await run(hourly, [rej("C1", "too_late", "too far out")]);
  check("hourly: an unconfirmed too_late waits too", lateNo[0].reason === "fit_only" && exits(lateNo) === "");
  const verified = await run(hourly, [
    rej("C1", "already_known", "Co sent this exact supper club on Oct 13", { cites: ["S1"] }),
    rej("C2", "too_late", "applications closed"),
    rej("C3", "ruled_out", "she said not giant mixers", { cites: ["A1"] }),
    send("C4"),
  ]);
  check("hourly: verified reasons still exit (already sent with a cite about it, confirmed too late, ruled out by their words, past)", exits(verified) === "Big Climate Community | Climate Founders Hike | Founders Supper Club | Last Week Mixer", verified.map((j) => `${j.id}:${j.verdict}/${j.reason}`));
  // No loop: the same fit-only reject every run never buys a run of its own; a quiet day after it is skipped.
  let last: { day: string; signature: string; judgments: Judgment[] } | null = null;
  const ran: string[] = [];
  for (let d = 0; d < 6; d++) {
    const dday = new Date(Date.parse(`${TODAY}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
    const c = { ...hourly, today: dday, pool: [item("C1", "Founders Supper Club", 2)] };
    const sig = selectSignature(c, last ? holdDueDates(last.judgments, last.day) : []);
    if (last && last.signature === sig) continue;
    const js = carryGuardedRuns(await run(c, [rej("C1", "weak_fit", "meh")]), last?.judgments ?? []);
    ran.push(`${dday}:${js[0].reason}`);
    last = { day: dday, signature: sig, judgments: js };
  }
  check("a fit-only hold can't loop: one run, then quiet days are skipped until something changes", ran.length === 1 && ran[0].endsWith(":fit_only"), ran);
}

// ---------------------------------------------------------------- a send-set timer never stops the floor's goal search
{
  const P = await import("../../src/harness/proactive.js");
  const NOW = new Date("2026-10-15T16:00:00Z");
  const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const sendAt = (h: number) => ({ type: "event_offer", targetKey: `t${h}`, topicKey: null, sentAt: ago(h), exempt: false });
  const st0 = { now: NOW, timezone: "America/Los_Angeles", optedOut: false, lastInboundAt: ago(2), sends: [] as any[], needsCare: false, safetyHold: false, undeliveredYes: false, suppressedKinds: [] as any[] };
  const st = (o: any = {}) => ({ state: { ...st0, ...o }, holdUntil: null, spaceUntil: null });
  const quiet = st({ lastInboundAt: ago(24 * 20), sends: [sendAt(30), sendAt(80), sendAt(130), sendAt(160)] });
  const timers = P.sweepBlockedBy(quiet, "goal");
  check("a member under the send timers (weekly cap, engagement pace, unanswered pause): the hourly goal sweep waits, the 9am floor's goal search runs", timers.some((x) => ["weekly_cap", "engagement_pace", "unanswered_pause"].includes(x)) && P.sweepBlockedBy(quiet, "floor_goal").length === 0, { goal: timers, floor: P.sweepBlockedBy(quiet, "floor_goal") });
  const find = { id: "f", userId: "u", type: "event_offer", targetKey: "t", topicKey: "t", summary: "x", priority: 50, dueAt: NOW, expiresAt: null, payload: { askId: "profile", fromProfile: true, match: { name: "x", tier: 2 } }, attempts: 0, createdAt: NOW } as any;
  const ev = P.evaluateCandidates({ ...quiet.state, candidates: [find] } as any);
  check("and nothing is sent for them by the ordinary send step: the find waits in the pool (the timers gate the send)", !ev.eligible.some((c: any) => c.id === "f"), ev.eligible.map((c: any) => c.id));
  check("what isn't a timer still stops the floor's goal search: opted out, a safety hold, kind restraint", P.sweepBlockedBy(st({ safetyHold: true }), "floor_goal").includes("safety_hold") && P.sweepBlockedBy(st({ suppressedKinds: ["find"] }), "floor_goal").includes("kind_restraint") && P.sweepBlockedBy(st({ optedOut: true }), "floor_goal").includes("not_opted_out"));
  check("pin: the floor's goal blockers hold no send-set timer", !P.SWEEP_BLOCKERS.floor_goal.some((x) => P.SEND_TIMERS.includes(x)));
  const ds = readFileSync(new URL("../../src/services/dailySweep.ts", import.meta.url), "utf8");
  check("pin: the floor reads the floor_goal gate for its goal search, never the hourly goal gate", /sweepHold\(userId, "floor_goal", now\)/.test(ds) && !/sweepHold\(userId, "goal"/.test(ds));
  // Silence is the morning's guardrail (dailySweep.ts morningPace): two ignored mornings, every other day; a week, paused.
  const { morningPace } = await import("../../src/services/dailySweep.js");
  const m = (d: string) => new Date(`${d}T16:30:00Z`);
  check("silence pacing applies to the morning send: two unanswered mornings, every other day; a week, paused; a reply resets", !morningPace({ now: m("2026-10-15"), zone: "America/Los_Angeles", lastReplyAt: m("2026-10-10"), morningSends: [m("2026-10-13"), m("2026-10-14")] }).send && !morningPace({ now: m("2026-10-15"), zone: "America/Los_Angeles", lastReplyAt: m("2026-10-01"), morningSends: [m("2026-10-08"), m("2026-10-10"), m("2026-10-12")] }).send && morningPace({ now: m("2026-10-15"), zone: "America/Los_Angeles", lastReplyAt: m("2026-10-14T20:00:00".slice(0, 10)), morningSends: [m("2026-10-13")] }).send);
  check("pin: the pace is read before anything is marked a morning find, and a paced morning marks nothing", (() => { const f = ds.slice(ds.indexOf("async function sendMorningFinds")); return f.indexOf("morningPace(") > 0 && f.indexOf("morningPace(") < f.indexOf("jsonb_build_object('morningDay'") && /if \(!pace\.send\) \{[\s\S]{0,250}return;/.test(f); })());
}

// ---------------------------------------------------------------- a tier pick that fails to queue: the next best in its tier, same morning
{
  const SH = await import("../../src/services/sweepShadow.js");
  const pool = [item("C1", "First Choice", 2), item("C2", "Second Choice", 2), item("C3", "Third Choice", 2), item("C4", "Opening", 3)];
  const pv = (vs: unknown[]) => parseVerdicts(JSON.stringify({ verdicts: vs }))!;
  const js = tierPicks(base(pool), guardVerdicts(base(pool), pv([{ ...send("C1"), rank: 1 }, { ...rej("C2", "weak_fit"), rank: 2 }, { ...rej("C3", "weak_fit"), rank: 3 }, send("C4")])));
  const pick = js.find((j) => j.id === "C1")!;
  check("the tier pick carries the rest of its tier, in order", JSON.stringify(pick.tierAlternates) === JSON.stringify(["C2", "C3"]));
  const report = { live: true, chosen: ["First Choice", "Opening"], queued: ["Opening"], notQueued: [{ name: "First Choice", why: "already decided" }], error: null } as any;
  const tried: string[] = [];
  await SH.fillTiers(js, report, async (j) => { tried.push(j.name); return j.name === "Second Choice" ? "already exists" : "queued"; });
  check("it tries the next best, then the next, until one queues; that one is the tier's send now", tried.join(",") === "Second Choice,Third Choice" && js.find((j) => j.id === "C3")!.verdict === "send" && js.find((j) => j.id === "C3")!.tierPick === 2 && report.queued.includes("Third Choice"), { tried, js: js.map((j) => `${j.id}:${j.verdict}`) });
  check("every one that didn't queue is logged", report.notQueued.some((n: any) => n.name === "First Choice") && report.notQueued.some((n: any) => n.name === "Second Choice" && /tier fallback for "First Choice": already exists/.test(n.why)));
  const report2 = { live: true, chosen: ["First Choice"], queued: [], notQueued: [{ name: "First Choice", why: "past" }], error: null } as any;
  const js2 = tierPicks(base(pool), guardVerdicts(base(pool), pv([{ ...send("C1"), rank: 1 }, { ...rej("C2", "weak_fit"), rank: 2 }, { ...rej("C3", "weak_fit"), rank: 3 }])));
  await SH.fillTiers(js2, report2, async () => "already decided");
  check("down the whole tier and no further: all refused, each logged, the tier sends nothing", report2.notQueued.length === 3 && !report2.queued.length && js2.filter((j) => j.verdict === "send").length === 1);
}

// ---------------------------------------------------------------- pins: where it runs
{
  const sh = readFileSync(new URL("../../src/services/sweepShadow.ts", import.meta.url), "utf8");
  const ss = readFileSync(new URL("../../src/services/sweepSelect.ts", import.meta.url), "utf8");
  check("pin: only the 9am floor's picker run is a morning run (hourly, goal, call and new-ask runs unchanged)", /runSweepShadow\(userId, new Date\(\), \{ trigger: "after_sweep", \.\.\.\(after === "daily" \? \{ morning: true \} : \{\}\) \}\)/.test(sh));
  check("pin: a morning run is never skipped as unchanged (the morning send is every day)", /last\?\.proposal\?\.signature === signature && !opts\.dryRun && !opts\.morning/.test(sh));
  check("pin: the tier pick runs after the guard and the claim check", /const checked = await checkClaims\(c, guardVerdicts\(c, verdicts\), opts\.judge\);\s*\/\/[^\n]*\n\s*if \(c\.morning\) checked\.judgments = tierPicks\(c, checked\.judgments\);/.test(ss));
  const ds = readFileSync(new URL("../../src/services/dailySweep.ts", import.meta.url), "utf8");
  check("pin: the morning send still marks only this run's picks and skips pacing on its own day only", /payload->>'picked' = 'true'\s+AND \(created_at >= \$3 OR \(payload->>'pickedAt'\)::timestamptz >= \$3\)/.test(ds) && /S\.runPickerAfterSweep\(userId, "daily"\)/.test(ds));
  const px = readFileSync(new URL("../../src/harness/proactive.ts", import.meta.url), "utf8");
  check("pin: MAX_PICKED_TOGETHER is 3, one per tier", /export const MAX_PICKED_TOGETHER = 3;/.test(px) && /const taken = new Set\(\[pickTier\(primary\)\]\);/.test(px));
}

console.log(`one find per tier: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
