// Is this worth my time, and how would I use it? (Royce, 2026-11-11). Synthetic pages and members only; zero tokens: every model read
// (the opportunity read and the composer) is a stub that returns a fixed answer.
//   npx tsx evals/opportunity/fit.ts            (add --print to see every final member-visible message)
//
// What layer 1 can prove: the record each find carries (facts held to the page, unknowns, benefits only on a fact), what the composer is
// told, and the code checks every caption passes before it can go (goal put on the thing, "apply now" without a checked way in, a
// roundup not said as one, a generic closing, presumed attendance). What it can't prove: what a real model writes from those
// instructions. The final messages below are the stub's text after the checks; they show what the checks let through or turn back.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const B = await import("../../src/harness/bundleComposer.js");
const E = await import("../../src/agent/eventDiscoverySurfacing.js");
const R = await import("../../src/services/opportunityRead.js");
const S = await import("../../src/services/sendCheck.js");
const SH = await import("../../src/services/sweepShadow.js");
const SEL = await import("../../src/services/sweepSelect.js");

let total = 0, failed = 0;
const PRINT = process.argv.includes("--print");
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 900)}` : ""}`); } };
const show = (title: string, messages: string[] | null, note = "") => { if (PRINT) console.log(`\n=== ${title}${note ? ` (${note})` : ""}\n${messages ? messages.map((m) => `  > ${m}`).join("\n") : "  (nothing sent)"}`); };
const stubModel = (answers: unknown[]) => {
  const prompts: string[] = [];
  return { prompts, model: async (p: string) => { prompts.push(p); const a = answers[Math.min(prompts.length - 1, answers.length - 1)]; return typeof a === "string" ? a : JSON.stringify(a); } };
};
const NOW = new Date("2026-11-11T16:00:00Z");
const ZONE = "America/Los_Angeles";

// An invented member: building a small voice product with one cofounder, looking for another engineer, and pushing the voice agent to
// sound more human. Their words, as the member block carries them.
const MEMBER = "WHAT YOU KNOW ABOUT THEM\n- building Lantern, a voice companion app, pre-seed\n- wants to find another engineer to work with on Lantern\n- wants the voice agent to sound more human (latency, turn-taking)\n- wants more friends in SF to talk tech with";
const ASK = "look for: small founder dinners SF; builders' salon San Francisco";
const cand = (id: string, match: any, pick: any = null) => ({ id, userId: "u", type: "event_offer", targetKey: `event_offer:${id}`, topicKey: id, summary: "", priority: 50, dueAt: NOW, expiresAt: null, payload: { askId: "profile", askText: ASK, fromProfile: true, match, picked: true, pick }, attempts: 0, createdAt: NOW }) as any;
const input = (items: any[], o: any = {}) => ({ firstName: "Jordan", items, set: null, leadWhy: null, memberBlock: MEMBER, feeling: null, thread: "", recent: "", threadLive: false, ...o }) as any;
const bundleItem = (id: string, match: any, pick: any = null) => ({ candidate: cand(id, match, pick), item: E.revealItem(ASK, true, match), pick, again: false });

// ---------------------------------------------------------------- the read: one record, held to the page
const DETAILED_PAGE =
  "Builders' Table · Event Page. Thu, Nov 19, 6:30 PM PT, Mission District, San Francisco. Free. " +
  "A small-group dinner for technical founders and early engineers working on voice and real-time AI. " +
  "Three tables of six; each table spends the first hour on short rounds where everyone shares what they're building and where they're stuck. " +
  "The host reviews each registration and picks a mix of people building, not investors. Registration is open; apply here with a short note. Please come ready to talk about your own project.";
const detailedRead = {
  facts: [
    { field: "audience", text: "technical founders and early engineers working on voice and real-time AI", quote: "for technical founders and early engineers working on voice and real-time AI" },
    { field: "format", text: "small-group dinner, three tables of six", quote: "Three tables of six" },
    { field: "happens", text: "first hour of short rounds where everyone shares what they're building and where they're stuck", quote: "everyone shares what they're building and where they're stuck" },
    { field: "selection", text: "host picks a mix of people building, not investors", quote: "picks a mix of people building, not investors" },
    { field: "requirements", text: "come ready to talk about your own project", quote: "come ready to talk about your own project" },
    { field: "host", text: "the host is a famous investor", quote: "hosted by a famous investor" },
  ],
  unknowns: ["whether anyone there is looking to join a startup"],
  benefits: [{ kind: "meet_collaborators", fact: 2 }, { kind: "learn_from_practitioners", fact: 0 }, { kind: "fundraising", fact: 5 }],
};
{
  const parsed = R.parseRead(JSON.stringify(detailedRead), DETAILED_PAGE)!;
  check("read: a fact whose quote isn't on the page is dropped (the invented 'famous investor' host)", !parsed.facts.some((f) => /investor/.test(f.text) && f.field === "host") && parsed.facts.length === 5, parsed.facts);
  check("read: a benefit resting on a dropped fact is dropped (no fundraising room)", parsed.benefits.map((b) => b.kind).join(",") === "meet_collaborators,learn_from_practitioners", parsed.benefits);
  check("read: unknowns kept", parsed.unknowns[0] === "whether anyone there is looking to join a startup");
  check("read: garbage is no read", R.parseRead("not json", DETAILED_PAGE) === null);
  const lines = R.renderRead("Builders' Table", { v: 1, url: "https://builders.example/table", source: "own_page", readAt: NOW.toISOString(), ...parsed });
  check("render: page facts, unknowns and supported benefits are kept apart, and audience is said as intended", lines.length === 3 && /never who will be there/.test(lines[0]) && /^Not stated, so unknown/.test(lines[1]) && /meeting people who might build or work with them/.test(lines[2]), lines);
  check("render: no benefit is a line that forbids naming one", /don't name a benefit its facts don't support/.test(R.renderRead("x", { v: 1, url: null, source: "own_page", readAt: "", facts: [], unknowns: [], benefits: [] }).join("\n")));
  check("prompt: the read asks for the intended audience, never attendees, and benefits only on a fact", /AS THE PAGE STATES IT \(an intended audience; never who will be there\)/.test(R.readPrompt("x", "y")) && /"founders" alone supports peer_founders, never meet_collaborators/.test(R.readPrompt("x", "y")));
  const sum = R.readSummary({ v: 1, url: null, source: "own_page", readAt: "", ...parsed });
  check("picker: the pool line leads with the format, audience and supported kinds", !!sum && /small-group dinner/.test(sum) && /supports: meet_collaborators, learn_from_practitioners/.test(sum!), sum);
  check("picker: the read rides first in a pool item's details (so the 320-char clip keeps it)", SH.describeMatch({ name: "x", read: { v: 1, url: null, source: "own_page", readAt: "", ...parsed }, opportunity: { postText: "long post" } })!.startsWith("small-group dinner"));
  check("picker: told to name the benefit kind, never put their goal on a thing ('15-20 founders' is no way to meet an engineer)", /Name which kind of benefit those details support/.test(SEL.SELECT_SYSTEM) && /"15-20 founders" says nothing about engineers/.test(SEL.SELECT_SYSTEM) && /whyNow never says to apply or register now unless its details show it's open and how/.test(SEL.SELECT_SYSTEM) && !/An adjacent lead can still be worth sending/.test(SEL.SELECT_SYSTEM));
}

// ---------------------------------------------------------------- the read is made once, at the send-time read, and reused
{
  const page = { text: DETAILED_PAGE, gone: false };
  const stub = stubModel([detailedRead]);
  const saved: any[] = [];
  const deps: any = { luma: async () => null, page: async () => page, now: () => NOW, saveMatch: async (_: string, m: any) => void saved.push(m), saveDefers: async () => {}, writeFact: async () => true, readModel: stub.model, sentNames: async () => [], discussedAmong: async () => new Set() };
  const match: any = { tier: 3, kind: "opportunity", name: "Builders' Table", url: "https://builders.example/table", source: "web", reason: "", statedDates: { start: "2026-11-19" } };
  const c = { id: "c1", userId: "u", payload: { match } };
  const r: any = await S.checkBeforeSend(c, ZONE, deps);
  check("send check: the read is made from the page just read and saved on the find", r.ok && r.match.read?.source === "own_page" && r.match.read.benefits.length === 2 && saved.length === 1 && saved[0].read, r);
  const again: any = await S.checkBeforeSend({ id: "c1", userId: "u", payload: { match: r.match } }, ZONE, deps);
  check("send check: within the fresh window the same read is reused, never a second model read", again.ok && stub.prompts.length === 1 && again.match.read === r.match.read);
  const failing: any = { ...deps, readModel: async () => { throw new Error("down"); } };
  const r2: any = await S.checkBeforeSend({ id: "c2", userId: "u", payload: { match: { ...match } } }, ZONE, failing);
  check("send check: a read that fails never holds the send; it leaves an unknown, never an invented line", r2.ok && r2.match.read.facts.length === 0 && /couldn't be read/.test(r2.match.read.unknowns[0]), r2.match?.read);
}

// ---------------------------------------------------------------- 1. a detailed page that supports a specific benefit
const READ_AT = "2026-11-11T15:58:00.000Z";
const detailed: any = {
  tier: 3, kind: "opportunity", name: "Builders' Table", url: "https://builders.example/table", source: "web", reason: "", statedDates: { start: "2026-11-19" },
  pageNow: DETAILED_PAGE, checkedAt: READ_AT,
  read: { v: 1, url: "https://builders.example/table", source: "own_page", readAt: READ_AT, ...R.parseRead(JSON.stringify(detailedRead), DETAILED_PAGE)! },
};
{
  const b = bundleItem("d1", detailed, { whyMember: "They want another engineer for Lantern; the table is technical founders sharing what they're building.", whyNow: "Registration is open." });
  check("item: a read own page with registration words is a checked way in", b.item.applyRoute === true && b.item.supports?.includes("meet_collaborators"));
  const caption = "Builders' Table, Thu Nov 19 in the Mission: the page describes small tables of technical founders and early engineers in voice AI, each sharing what they're building. That's room to talk through Lantern with people who'd get it. It doesn't say anyone is looking to join a startup, so treat it as starting conversations.";
  const stub = stubModel([{ opening: null, items: [{ n: 1, caption }], closing: null }]);
  const r: any = await B.composeBundle(input([b]), stub);
  check("1. detailed page: the composer gets the read (facts, unknowns, supported benefits) and the pick's why as a lead, not a fact", /what_it_is_read_at_send/.test(stub.prompts[0]) && /What its facts support, by kind/.test(stub.prompts[0]) && /Cue's daily pick's read \(a lead to check against its facts/.test(stub.prompts[0]));
  check("1. detailed page: the supported caption goes as written, link first, and no closing question", "messages" in r && JSON.stringify(r.messages) === JSON.stringify([detailed.url, caption]) && r.closing === null, r);
  show("1. detailed page that supports a specific benefit", r.messages);
}

// ---------------------------------------------------------------- 2. a thin page with a decisive unknown
{
  const THIN = "Founder Night · Thu Nov 12 5:30 PM · Location TBD. An intimate evening for 15-20 founders. No fee to attend; guests cover their own food and drinks. Registration subject to host approval.";
  const thin: any = { tier: 3, kind: "opportunity", name: "Founder Night", url: "https://founders.example/night", source: "web", reason: "", statedDates: { start: "2026-11-12" }, pageNow: THIN, checkedAt: READ_AT,
    read: { v: 1, url: "https://founders.example/night", source: "own_page", readAt: READ_AT, facts: [{ field: "size", text: "15-20 founders", quote: "An intimate evening for 15-20 founders" }, { field: "cost", text: "no fee; guests cover their own food", quote: "No fee to attend" }, { field: "registration", text: "host approves each registration", quote: "Registration subject to host approval" }], unknowns: ["who the founders are beyond 'founders'", "what happens there (seated, open mingling, talks)", "how guests are picked"], benefits: [{ kind: "peer_founders", because: "15-20 founders" }] } };
  const b = bundleItem("t1", thin, { whyMember: "They want another engineer; a small dinner is where that could happen.", whyNow: "worth applying while it's live" });
  // The reported caption, with the member's company invented.
  const BAD = "Founder dinner tomorrow night, Nov 12, 15-20 founders, no fee, host approval needed so worth applying now. Small and non-pitchy, the kind of room where you could meet an engineer for Lantern or just someone solid to build alongside.";
  const NARROW = "Founder Night, Thu Nov 12 at 5:30, location still TBD: a small evening for 15-20 founders, no fee, and the host approves each guest. The page doesn't say who the founders are or how the night runs, so it's a room of peers to meet, not a way to find an engineer.";
  const stub = stubModel([{ opening: null, items: [{ n: 1, caption: BAD }], closing: "Does this one interest you?" }, { opening: null, items: [{ n: 1, caption: NARROW }], closing: null }]);
  const r: any = await B.composeBundle(input([b]), stub);
  const told = stub.prompts[1] ?? "";
  check("2/3. founder language: 'meet an engineer' with no engineer on its record goes back with that said", /could meet or find "engineer"/.test(told), told.slice(-1200));
  check("2/3. founder language: 'worth applying now' with a page that only says 'host approval' goes back (no checked way in with a state that makes now matter)", /pushes them to apply or sign up now/.test(told) && b.item.applyRoute === false, { applyRoute: b.item.applyRoute });
  check("2/3. the generic closing goes back too", /the closing is a generic check/.test(told));
  check("2. thin page: what goes is the narrowed caption, link first, nothing tacked on", "messages" in r && JSON.stringify(r.messages) === JSON.stringify([thin.url, NARROW]), r);
  show("2. thin page, decisive unknown (before: the 8:01 caption)", [thin.url, BAD, "Does this one interest you?"], "turned back by the checks");
  show("2. thin page, decisive unknown (after)", r.messages);
}

// ---------------------------------------------------------------- 3. founder language that doesn't establish engineers (pure checks)
{
  const thinRecord = "Founder Night\nAn intimate evening for 15-20 founders. No fee. Registration subject to host approval.";
  check("3. 'meet an engineer' is pasted when only the member's words carry 'engineer'", B.goalPasted("the kind of room where you could meet an engineer for Lantern", thinRecord, MEMBER).includes("engineer"));
  check("3. 'meet engineers' stands when the page says engineers", B.goalPasted("you could meet engineers working on voice there", DETAILED_PAGE, MEMBER).length === 0);
  check("3. 'someone solid to build alongside' is generic, never flagged on its own", B.goalPasted("you could meet someone solid to build alongside", thinRecord, MEMBER).length === 0);
  check("3. their goal said back as the reason is caught", B.GOAL_RESTATED.test("That's the fit: you're hunting an engineer for Lantern") && !B.GOAL_RESTATED.test("The page describes engineers sharing their work."));
  check("3. urgency words caught; a plain 'host approves each guest' isn't", B.URGENT_APPLY.test("host approval needed so worth applying now") && B.URGENT_APPLY.test("register early while there's room") && !B.URGENT_APPLY.test("the host approves each guest"));
  check("3. generic closings caught; a real choice isn't", ["Does this one interest you?", "Do any of these interest you?", "Does that sound good?", "Thoughts?"].every((q) => B.GENERIC_CLOSING.test(q)) && !B.GENERIC_CLOSING.test("The Tuesday table or the Thursday walk, which fits your week better?"));
}

// ---------------------------------------------------------------- 4. a roundup
{
  const POST = "East Bay founder events this week:\n- a go-to-market evening, Wed\n- a small founder dinner, Thu\n- a games night, Fri";
  const roundup: any = { tier: 3, kind: "opportunity", name: "East Bay founder events this week", url: "https://harbornotes.example/blog/week", source: "web", reason: "", sendAsRoundup: true, foundInRoundup: "listed among several things", roundupUrl: "https://harbornotes.example/blog/week", opportunity: { postText: POST }, checkedAt: READ_AT };
  roundup.read = await R.readOpportunity(roundup, {}, NOW);
  check("4. roundup: its read carries nothing about any listed thing", roundup.read.source === "roundup" && roundup.read.facts.length === 0 && roundup.read.unknowns[0] === R.ROUNDUP_UNKNOWN);
  const b = bundleItem("r1", roundup);
  check("4. roundup: no checked way in", b.item.applyRoute === false);
  const AS_EVENT = "Small founder dinner Thursday in the East Bay, host approval needed.";
  const AS_LIST = "A write-up of three East Bay founder events this week: a go-to-market evening, a small dinner and a games night. It's a list; each one's details are only as the post gives them.";
  const stub = stubModel([{ opening: null, items: [{ n: 1, caption: AS_EVENT }], closing: null }, { opening: null, items: [{ n: 1, caption: AS_LIST }], closing: null }]);
  const r: any = await B.composeBundle(input([b]), stub);
  check("4. roundup: a caption that describes it as one event goes back", /must say it's a list/.test(stub.prompts[1] ?? ""));
  check("4. roundup: what goes says it's a list", "messages" in r && r.messages[1] === AS_LIST, r);
  show("4. a roundup", r.messages);
}

// ---------------------------------------------------------------- 5. a valid different benefit tied to an actual member need
{
  const PAGE = "Inference Night · Wed Nov 11, 5:30-8:30 PM · SF. Hosted by two open-source inference teams. Short talks and demos from engineers working on inference latency and serving tooling, then drinks. Free; registration open.";
  const m: any = { tier: 2, kind: "public_event", name: "Inference Night", url: "https://lu.ma/inference-night", event_api_id: "evt-x", event_date: "2026-11-11", reason: "", pageNow: undefined, checkedAt: READ_AT,
    details: { startAt: "2026-11-12T01:30:00.000Z", endAt: "2026-11-12T04:30:00.000Z", timezone: ZONE, online: false, venue: null, address: null, city: "San Francisco", hosts: ["Open Serve", "Fastpath"], price: "free", spotsRemaining: null, requiresApproval: false, soldOut: false, guestCount: null, description: PAGE, registration: "open" } };
  m.read = await R.readOpportunity(m, { model: async () => JSON.stringify({ facts: [{ field: "happens", text: "short talks and demos from engineers on inference latency and serving tooling", quote: "Short talks and demos from engineers working on inference latency and serving tooling" }], unknowns: ["whether there's open time to talk one-on-one"], benefits: [{ kind: "learn_from_practitioners", fact: 0 }] }) }, NOW);
  check("5. structured facts come from the event record (time, area, cost, registration, host); never a street address", m.read.source === "event_record" && ["when", "area", "cost", "registration", "host"].every((f) => m.read.facts.some((x: any) => x.field === f)) && !m.read.facts.some((x: any) => /\d+ \w+ (?:st|street|ave)\b/i.test(x.text)), m.read.facts);
  const b = bundleItem("i1", m);
  const CAP = "Inference Night tonight, 5:30-8:30 in SF, free: the page lists short talks and demos from engineers working on inference latency and serving tooling. That's a chance to learn how people are cutting response lag, which is the human-sounding voice work. It's talks first, so it's for learning, not hiring.";
  const r: any = await B.composeBundle(input([b]), stubModel([{ opening: null, items: [{ n: 1, caption: CAP }], closing: null }]));
  check("5. a learning benefit tied to a real current need (latency for the voice agent) goes, labelled as learning, not hiring", "messages" in r && r.messages[1] === CAP, r);
  show("5. valid different benefit tied to an actual need", r.messages);
}

// ---------------------------------------------------------------- 6. similar events
{
  const a: any = { tier: 2, kind: "public_event", name: "Founder Dinner SF", url: "https://lu.ma/fd-sf-12", event_api_id: "e1", event_date: "2026-11-12", reason: "", checkedAt: READ_AT, details: { startAt: "2026-11-13T02:00:00.000Z", endAt: null, timezone: ZONE, online: false, venue: null, address: null, city: "San Francisco", hosts: [], price: "free", spotsRemaining: null, requiresApproval: true, soldOut: false, guestCount: null, description: "A seated dinner for seed-stage founders." } };
  const bb: any = { ...a, name: "Founder Dinner SF (Series A)", url: "https://lu.ma/fd-sf-19", event_api_id: "e2", event_date: "2026-11-19", details: { ...a.details, startAt: "2026-11-20T02:00:00.000Z", description: "A seated dinner for Series A founders raising their next round." } };
  const items = [bundleItem("s1", a), bundleItem("s2", bb)];
  const c1 = "Founder Dinner SF, Thu Nov 12, free with host approval: billed for seed-stage founders, so peers at your stage rather than a hiring room.";
  const c2 = "Founder Dinner SF (Series A), Thu Nov 19: its page is aimed at Series A teams raising their next round, a room about raising.";
  const stub = stubModel([{ opening: "Two dinners with near-identical names, a week apart and for different stages.", items: [{ n: 1, caption: c1 }, { n: 2, caption: c2 }], closing: "Which stage of room do you want right now?" }]);
  const r: any = await B.composeBundle(input(items), stub);
  check("6. similar names: told to tell them apart by what, when and where", /tell them apart by what they are, when and where/.test(stub.prompts[0]));
  check("6. similar names: two distinct captions and a real-choice closing go", "messages" in r && r.messages.includes(c1) && r.messages.includes(c2) && r.closing === "Which stage of room do you want right now?", r);
  show("6. similar events", r.messages);
}

// ---------------------------------------------------------------- 7. unconfirmed attendance
{
  const m: any = { ...detailed };
  const b = bundleItem("u1", m);
  const PRESUMES = "Since you're going to Builders' Table on Nov 19, the page says each table shares what they're building, so bring a one-line Lantern update.";
  const PLAIN = "Builders' Table, Thu Nov 19: each table starts with short rounds of what everyone's building, so a one-line Lantern update would carry you if you go.";
  const stub = stubModel([{ opening: null, items: [{ n: 1, caption: PRESUMES }], closing: null }, { opening: null, items: [{ n: 1, caption: PLAIN }], closing: null }]);
  const r: any = await B.composeBundle(input([b], { thread: "Nov 10 09:12 They: I requested a spot at Builders' Table" }), stub);
  check("7. 'since you're going' when they only requested a spot goes back (registration is not attendance)", /presumes they're going/.test(stub.prompts[1] ?? ""), (stub.prompts[1] ?? "").slice(-600));
  check("7. what goes ties prep to the format and keeps 'if you go'", "messages" in r && r.messages[1] === PLAIN, r);
  show("7. unconfirmed attendance", r.messages);
}

console.log(`\nopportunity fit: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
