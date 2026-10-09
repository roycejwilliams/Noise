import { readFileSync } from "fs";
// Model-free checks for Co's sweep selection (services/sweepSelect.ts) and
// its replay scoring. No API calls, no database:
//   npx tsx evals/sweepSelect/rules.ts
import { guardVerdicts, holdDueDates, parseVerdicts, selectPrompt, selectSignature, SELECT_SYSTEM, type SelectContext } from "../../src/services/sweepSelect.js";
import { score } from "./score.js";
import { newSideFor } from "./grading.js";
import { buildShadowPool, describeMatch, renderShadowReport } from "../../src/services/sweepShadow.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

const ctx: SelectContext = {
  firstName: "Jordan",
  city: "San Francisco",
  today: "2026-10-02",
  weekday: "Friday",
  asks: [{ id: "A1", text: "Find 3 founder events this week", since: "2026-09-30" }],
  texts: [
    { id: "T1", at: "Sep 30 10:00", from: "member", text: "Find 3 founder events this week" },
    { id: "T2", at: "Sep 30 10:01", from: "co", text: "On it." },
  ],
  sent: [{ id: "S1", at: "Sep 29", what: "event_offer: Demo night", reaction: null }],
  outcomes: [],
  feeling: null,
  discoveryLeft: 4,
  pool: [
    { id: "C1", key: "pitch night|2026-10-02", name: "Pitch Night", date: "2026-10-02", tier: 2, kind: "answer", asks: ["A1"] },
    { id: "C2", key: "old mixer|2026-09-30", name: "Old Mixer", date: "2026-09-30", tier: 2, kind: "answer", asks: ["A1"] },
    { id: "C3", key: "street fair|", name: "Street Fair", date: null, tier: 3, kind: "discovery", asks: [] },
    { id: "C4", key: "yoga|2026-10-04", name: "Yoga", date: "2026-10-04", tier: 3, kind: "discovery", asks: [] },
  ],
};

check("the instructions say the bar, the three verdicts and the reason codes", /reply "wow"/.test(SELECT_SYSTEM) && /"hold"/.test(SELECT_SYSTEM) && /not_them/.test(SELECT_SYSTEM) && /Sending nothing today is a good answer/.test(SELECT_SYSTEM));
const prompt = selectPrompt(ctx);
check("the member prompt carries asks, texts, sends and the pool with ids", /A1 \(since 2026-09-30\)/.test(prompt) && /T1 Sep 30 10:00 They:/.test(prompt) && /S1 Sep 29: event_offer: Demo night → no reply/.test(prompt) && /C1 Pitch Night \(2026-10-02\); an event; answers A1/.test(prompt) && /C3 Street Fair; an opening \(program, place or opportunity\); from what they've shared/.test(prompt) && !/tier/i.test(prompt));
check("an ask isn't finished after one send, and thin isn't weak", /An ask isn't finished after one send/.test(SELECT_SYSTEM) && /thin isn't the same as weak/.test(SELECT_SYSTEM));
check("the instructions don't change per member (so they cache)", !SELECT_SYSTEM.includes("Jordan"));

const v = parseVerdicts('```json\n{"verdicts":[{"id":"C1","verdict":"send","whyMember":"asked T1","cites":["A1","T1"],"whyNow":"tonight","wow":true},{"id":"C3","verdict":"hold","why":"weekend","until":"2026-10-03"},{"id":"C4","verdict":"reject","reason":"bogus","why":"x"}]}\n```');
check("verdicts are read through a code fence; an unknown reason code becomes other", v?.length === 3 && v[0].verdict === "send" && v[1].verdict === "hold" && (v[2] as any).reason === "other");
check("unreadable output is null, not a guess", parseVerdicts("I'd send C1") === null && parseVerdicts('{"verdicts": "C1"}') === null);

const g = guardVerdicts(ctx, v!);
const by = (id: string) => g.find((j) => j.id === id)!;
check("a send citing what they asked, with why-now and wow, goes", by("C1").verdict === "send");
check("a hold keeps its date", by("C3").verdict === "hold" && by("C3").until === "2026-10-03");
check("every candidate gets a row; one with no verdict is logged as such", g.length === 4 && by("C2").verdict === "no_verdict");
const send = (id: string, o: Partial<{ cites: string[]; whyNow: string; wow: boolean; whyMember: string }> = {}) => ({ id, verdict: "send" as const, whyMember: "they asked", cites: ["A1"], whyNow: "this week", wow: true, ...o });
const one = (x: any) => guardVerdicts(ctx, [x]).find((j) => j.id === x.id)!;
check("a send citing a record that isn't there is rejected by the guard", one(send("C1", { cites: ["A9"] })).guard?.startsWith("cites a record that isn't there") === true);
check("a send citing only what Co said is rejected: it has to rest on them", one(send("C1", { cites: ["T2", "S1"] })).guard === "cites nothing they said or asked");
check("a send without why-now, or without wow, doesn't go", one(send("C1", { whyNow: "" })).verdict === "reject" && one(send("C1", { wow: false })).guard === "not a wow");
check("a past event never sends", one(send("C2")).guard === "already past");
const many = guardVerdicts({ ...ctx, pool: [...ctx.pool, { id: "C5", key: "c5|", name: "C5", date: null, tier: 1, kind: "answer", asks: ["A1"] }] }, [send("C1"), send("C3"), send("C4"), send("C5")]);
check("over the send limit, the rest are held in Co's order", many.filter((j) => j.verdict === "send").map((j) => j.id).join() === "C1,C3,C4" && many.find((j) => j.id === "C5")!.reason === "over_send_limit");

const sig = selectSignature(ctx);
check("same pool, asks and last text: same signature (skipped)", sig === selectSignature({ ...ctx, texts: [...ctx.texts, { id: "T3", at: "Oct 1", from: "co" as const, text: "Co again" }].slice(0, 2) }));
check("a new text from them changes it", sig !== selectSignature({ ...ctx, texts: [...ctx.texts, { id: "T3", at: "Oct 1 09:00", from: "member" as const, text: "hey" }] }));
check("a new candidate changes it", sig !== selectSignature({ ...ctx, pool: ctx.pool.slice(0, 3) }));
check("a hold whose date has come changes it, so a quiet day can't park it forever", sig !== selectSignature(ctx, ["2026-10-02"]) && sig === selectSignature(ctx, ["2026-10-09"]));
check("a candidate moving inside 3 days changes it", selectSignature({ ...ctx, today: "2026-09-25" }) !== selectSignature({ ...ctx, today: "2026-10-01" }));

// Scoring.
const day = (d: string, sends: string[], old: string[]): any => ({ day: d, now: "", pool: ctx.pool.map((p) => ({ ...p })), oldPick: old, judgments: ctx.pool.map((p) => ({ id: p.id, key: p.key, name: p.name, kind: p.kind, verdict: sends.includes(p.key) ? "send" : "reject", reason: "", why: "" })), signature: "", usage: {} });
const days = [day("2026-10-01", ["pitch night|2026-10-02"], ["yoga|2026-10-04"]), day("2026-10-02", [], ["street fair|"])];
const key = { "2026-10-01": newSideFor("2026-10-01"), "2026-10-02": newSideFor("2026-10-02") };
const s = score(days, key, { "2026-10-01": { items: { "pitch night|2026-10-02": "wow", "yoga|2026-10-04": "no" }, pref: key["2026-10-01"] }, "2026-10-02": { items: { "street fair|": "fine" }, pref: "neither", wanted: [] } }, [{ name: "Pitch Night", result: "acted" }, { name: "Kevin Hartz talk", result: "helped" }]);
check("marks are tallied to the right side through the key", s.tally.new.wow === 1 && s.tally.old.no === 1 && s.tally.old.fine === 1 && s.prefs.new === 1 && s.prefs.neither === 1);
check("the bar: more wow and fewer no, quiet days right, keeps what worked", s.pass.moreWowFewerNo && s.pass.quietDaysRight && s.pass.keepsWhatWorked && s.inPool === 1 && s.caught === 1);
const s2 = score(days, key, { "2026-10-02": { wanted: ["street fair|"] } }, []);
check("a quiet day where they'd have wanted something fails that part of the bar", !s2.pass.quietDaysRight && s2.silentMisses[0].wanted[0] === "Street Fair");

// The shadow pool (services/sweepShadow.ts).
{
  const askNo = new Map([["ask-1", "A1"], ["ask-2", "A2"]]);
  const raw = [
    { name: "Pitch Night", date: "2026-10-03", tier: 2, askId: "ask-1", fromProfile: false, reminder: false, details: null },
    { name: "Pitch  night!", date: "2026-10-03", tier: 2, askId: "ask-2", fromProfile: false, reminder: false, details: "Mission Robotics, 5:30pm" },
    { name: "Old Mixer", date: "2026-09-30", tier: 2, askId: "ask-1", fromProfile: false, reminder: false, details: null },
    { name: "Demo Night", date: "2026-10-05", tier: 2, askId: "ask-1", fromProfile: false, reminder: false, details: null },
    { name: "Demo Night", date: "2026-10-05", tier: 2, askId: "ask-1", fromProfile: false, reminder: true, details: null },
    { name: "Street Fair", date: null, tier: 3, askId: null, fromProfile: true, reminder: false, details: null },
  ];
  const sp = buildShadowPool(raw, "2026-10-02", askNo, new Set(["demo night"]));
  const pitch = sp.find((p) => p.name === "Pitch Night");
  check("the same thing from two asks is one candidate serving both, with the details either had", sp.filter((p) => /pitch/i.test(p.name)).length === 1 && pitch?.asks.join() === "A1,A2" && pitch?.details === "Mission Robotics, 5:30pm" && pitch?.kind === "answer");
  check("past things are dropped; a sent thing stays only as a reminder", !sp.some((p) => p.name === "Old Mixer") && sp.filter((p) => p.name === "Demo Night").length === 1);
  check("a profile find is discovery, ids are C1..", sp.find((p) => p.name === "Street Fair")?.kind === "discovery" && sp.map((p) => p.id).join() === "C1,C2,C3");
  const rep = renderShadowReport([{ name: "Jordan", day: "2026-10-02", skipped: null, oldQueued: ["Demo Night"], oldTexted: ["Found one: Demo Night"], pool: [{ id: "C1", name: "Pitch Night", date: "2026-10-03" }], judgments: [{ id: "C1", key: "k", name: "Pitch Night", kind: "answer", verdict: "send", reason: "clears_bar", why: "they asked for founder events", cites: ["A1"], whyNow: "tomorrow" }, { id: "C2", key: "k2", name: "Street Fair", kind: "discovery", verdict: "reject", reason: "weak_fit", why: "generic" }] }]);
  check("the report shows old queued and texted beside Co's sends with why-them and why-now, and rejects with reasons", /Old rules queued: Demo Night/.test(rep) && /Old rules texted: "Found one: Demo Night"/.test(rep) && /\+ Pitch Night \(2026-10-03\)\n\s+why them: they asked for founder events \[A1\]\n\s+why now: tomorrow/.test(rep) && /- Street Fair \[weak_fit\]: generic/.test(rep));
  check("a skipped day says why", /Co: skipped \(nothing changed since the last run\)/.test(renderShadowReport([{ name: "J", day: "d", skipped: "nothing changed since the last run", oldQueued: [], oldTexted: [], pool: [], judgments: [] }])));
}

// Review of #57 fixes.
{
  const body = '{"verdicts":[{"id":"C1","verdict":"reject","reason":"weak_fit","why":"uses {braces} in a string"}]}';
  check("verdicts survive notes with braces before or after the JSON", parseVerdicts(`{draft} thinking first\n${body}\nNote: {see above}`)?.length === 1 && parseVerdicts(`${body} and {"other": 1}`)?.[0].id === "C1");
  check("the first block with a verdicts list wins, not the first block", parseVerdicts(`{"plan": "x"}\n${body}`)?.length === 1);
  check("an undated hold comes due two days after the run; a dated one on its date", holdDueDates([{ verdict: "hold", until: null }, { verdict: "hold", until: "2026-10-15" }, { verdict: "send" }], "2026-10-02").join() === "2026-10-04,2026-10-15");
  const ev = describeMatch({ name: "Pitch Night", url: "https://lu.ma/x", details: { startAt: "2026-10-02T17:30:00-07:00", endAt: "2026-10-02T20:30:00-07:00", timezone: null, online: false, venue: "Mission Robotics", address: "1 Main St", city: "San Francisco", hosts: ["Tech Makers"], price: "Free", spotsRemaining: null, requiresApproval: true, soldOut: true, guestCount: 120, description: "Launch and pitch night." } });
  check("an event's own record reaches the prompt: sold out, time, venue, hosts, price, approval, description", !!ev && /^SOLD OUT/.test(ev) && /starts 2026-10-02 17:30, ends 20:30/.test(ev) && /Mission Robotics, 1 Main St, San Francisco/.test(ev) && /hosted by Tech Makers/.test(ev) && /Free/.test(ev) && /needs host approval/.test(ev) && /Launch and pitch night/.test(ev) && /\(lu\.ma\)/.test(ev));
  check("an opening's post text (match.opportunity) reaches it too, once; the finder's own why-it-fits doesn't", /Grants up to \$5k/.test(describeMatch({ kind: "opportunity", opportunity: { postText: "Grants up to $5k" }, whyItFits: "fits them" }) ?? "") && !/fits them/.test(describeMatch({ kind: "opportunity", opportunity: { postText: "x" }, whyItFits: "fits them" }) ?? "") && (describeMatch({ kind: "opportunity", opportunity: { postText: "Same text" }, evidence: "Same text" })?.match(/Same text/g) ?? []).length === 1);
  check("a stray unclosed brace before the JSON doesn't lose the day", parseVerdicts(`{ note ${body}`)?.length === 1);
  const again = buildShadowPool([{ name: "Demo Night", date: "2026-10-05", tier: 2, askId: null, fromProfile: true, reminder: false, again: true, details: null }], "2026-10-02", new Map(), new Set(["demo night"]));
  check("a month-later resurface of a sent thing stays, as in the live sweep", again.length === 1);
  const sh = readFileSync(new URL("../../src/services/sweepShadow.ts", import.meta.url), "utf8");
  check("a failed selection is logged as an error, never as the run tomorrow compares against", /if \(r\.error\) \{\s*if \(!opts\.dryRun\) await recordDecision\(\{[^}]*outcome: "skip", action: "error"/.test(sh) && /outcome = 'act' ORDER BY created_at DESC LIMIT 1/.test(sh) && /action IS DISTINCT FROM 'error'/.test(sh));
}

// The picker reads member facts from the shared layer (services/memberKnowledge.ts), live runs (PR 5 of the migration).
{
  const { factsFromKnowledge } = await import("../../src/services/sweepSelectContext.js");
  const at = (d: string) => `${d}T17:30:00.000Z`;
  const k: any = {
    userId: "u1",
    asOf: at("2026-10-02"),
    identity: { firstName: "Jordan", city: "New York", zone: "America/New_York", timeZone: "America/New_York", verifiedAt: at("2026-10-01") },
    goals: [
      { text: "Raise a pre-seed round", state: "active", reason: null, told: true, verifiedAt: at("2026-09-01") },
      { text: "Find a cofounder", state: "done", reason: "they closed it", told: true, verifiedAt: at("2026-09-20") },
      { text: "Learn pottery", state: "stale", reason: "marked set_aside", told: true, verifiedAt: at("2026-09-10") },
    ],
    asks: [],
    delivered: [{ what: "Founders Dinner", kind: "event", at: at("2026-09-28"), via: ["offer"], url: null, reaction: "said yes", verifiedAt: at("2026-09-28") }],
    carrying: [
      { what: "Shortlist of seed funds", kind: "task", state: "outstanding", told: true, theyHaveIt: false, dueAt: null, ref: "task #3", status: null, detail: null, verifiedAt: at("2026-10-01") },
      { what: "Pitch deck notes", kind: "document", state: "done", told: true, theyHaveIt: true, dueAt: null, ref: "doc #1", status: null, detail: null, verifiedAt: at("2026-09-30") },
    ],
    lessons: [{ text: "Prefers small rooms", verifiedAt: at("2026-09-15") }],
    corrections: [{ field: "city", was: "Oakland", now: "New York", verifiedAt: at("2026-09-12") }],
    preferences: [{ text: "Likes founder dinners", source: "taste", verifiedAt: at("2026-09-29") }],
    claims: [],
    restraint: { holdUntil: null, spaceUntil: null, safetyHold: false, needsCare: false, frustratedWithCo: false, feeling: "tired about fundraising (mild, from a text)", suppressedKinds: ["goal_checkin"], trialKinds: [], unanswered: { count: 0, lastInboundAt: null, lastSentAt: null, pausedUntil: null }, verifiedAt: at("2026-10-02") },
    exchanges: [
      { from: "member", text: "Any founder dinners this week?", call: false, verifiedAt: "2026-10-01T23:05:00.000Z" },
      { from: "co", text: "Looking now.", call: false, verifiedAt: "2026-10-01T23:06:00.000Z" },
    ],
    person: { text: "Who they are:\nA first-time founder.", verifiedAt: at("2026-10-02") },
  };
  const f = factsFromKnowledge(k);
  check("live: the zone is theirs (not a hard-coded Pacific), and text stamps are in it", f.zone === "America/New_York" && f.texts[0].at === "Oct 1 19:05" && f.texts[0].id === "T1" && f.texts[0].from === "member" && f.texts[1].id === "T2");
  check("live: only active goals are the lens; done and set-aside goals are history", f.goals!.join("|") === "Raise a pre-seed round" && f.goalsPast!.length === 2 && f.goalsPast!.some((g) => /Find a cofounder \(done\)/.test(g)) && f.goalsPast!.some((g) => /Learn pottery \(set aside\)/.test(g)));
  check("live: what they already have, what Co is carrying (not what they have), and what Co learned", f.delivered![0].what === "Founders Dinner" && f.carrying!.length === 1 && /Shortlist of seed funds \(task\)/.test(f.carrying![0]) && f.learned!.some((l) => /Corrected city: New York/.test(l)) && !f.learned!.some((l) => /Oakland/.test(l)) && f.learned!.some((l) => /Prefers small rooms/.test(l)) && f.learned!.some((l) => /Likes founder dinners/.test(l)));
  check("live: the feeling and the member rules (grounding, other members, restraint) come from the layer", f.feeling === "tired about fundraising (mild, from a text)" && f.rules!.length === 3 && f.rules!.some((r) => /^Restraint: .*goal_checkin/.test(r)) && f.rules!.some((r) => /^Other members:/.test(r)));
  const p = selectPrompt({ ...ctx, ...f, sent: ctx.sent, outcomes: ctx.outcomes, discoveryLeft: 4, asks: [...ctx.asks, { id: "A2", text: "a chess club", since: "2026-09-01", closed: true }] });
  check("the prompt carries the new sections, ids stable", /Today: Friday 2026-10-02 \(their time, America\/New_York\)/.test(p) && /T1 Oct 1 19:05 They: Any founder dinners/.test(p) && /S1 Sep 29/.test(p) && /A2 \(since 2026-09-01, closed since\)/.test(p) && /NOT the lens[\s\S]*Find a cofounder \(done\)/.test(p) && /What they already have from Co[^\n]*\n- Founders Dinner \(event, Sep 28\) → said yes/.test(p) && /already working on for them[^\n]*\n- Shortlist of seed funds/.test(p) && /Member rules[\s\S]*Restraint:/.test(p) && /Co's read of them:\nWho they are:/.test(p));
  check("the lens line still lists only active goals", /the LENS[^\n]*\n- Raise a pre-seed round\n\n/.test(p) && !/the LENS[^\n]*\n[^\n]*Find a cofounder/.test(p));
  const sh = readFileSync(new URL("../../src/services/sweepShadow.ts", import.meta.url), "utf8");
  check("the shadow run reads the layer once and never re-picks what they already have", /const knowledge = await loadKnowledge\(userId, now\)/.test(sh) && /\(knowledge\?\.delivered \?\? \[\]\)\.map\(\(d\) => d\.what\)/.test(sh) && /loadMemberContext\(q, userId, now, \{ knowledge \}\)/.test(sh) && /dayOf\(now, zone\)/.test(sh));
  check("a rejected member-knowledge read (name lookup failed) is caught and the picker goes without member facts, never unstripped ones", /memberKnowledge\(userId, \{ now, \.\.\.PICKER_KNOWLEDGE \}\)\.catch\([\s\S]{0,200}return null;/.test(readFileSync(new URL("../../src/services/sweepSelectContext.ts", import.meta.url), "utf8")));
  check("no hard-coded Pacific zone left in the picker's context", !/America\/Los_Angeles/.test(readFileSync(new URL("../../src/services/sweepSelectContext.ts", import.meta.url), "utf8")));
}

console.log(`sweep select rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
