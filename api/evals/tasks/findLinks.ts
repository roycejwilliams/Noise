// Replay of the 2026-10-31 2:01pm grants texts (Royce's, task #1103), zero tokens: the model is scripted to write what it wrote
// that afternoon, and the code has to hold the rules:
//   a find named in a task text goes with its own link in the same send, or it isn't named (the tease rule, PR #59), and
//   an offer to fill in, submit or apply for anything on their behalf never goes (OFFERS_WHAT_CO_CANT).
// That afternoon francisco san's caption was dropped (numbers its facts don't carry), and the Awesome Foundation caption and the
// closing still named it, the closing offering to "start the Francisco San form".
//   npx tsx evals/tasks/findLinks.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";

type Answer = { tool: string; input: any } | { text: string };
const script: Answer[] = [];
let redrafts = 0;
const asked: string[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  const body = typeof init?.body === "string" ? init.body : "";
  if (body.includes("Your first draft broke these")) { redrafts++; asked.push(body.match(/Your first draft broke these[^.]*?: (.*?)\. Write them all again/)?.[1] ?? ""); }
  const a = script.shift() ?? { text: "Nothing more." };
  const content = "tool" in a ? [{ type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2)}`, name: a.tool, input: a.input }] : [{ type: "text", text: a.text }];
  return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "scripted", content, stop_reason: "tool" in a ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const TT = await import("../../src/services/taskTurn.js");
const TM = await import("../../src/services/taskMessages.js");
const W = await import("../../src/services/taskWeb.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };

// The task's kept list that afternoon (co_tasks 1103 followup.found), as it was.
const AWESOME = { name: "Awesome Foundation San Francisco Chapter Grant", url: "https://www.awesomefoundation.org/en/chapters/sf", tier: 3, facts: ["grant amount: $1,000", "frequency: one microgrant per month"] };
const FSAN = { name: "francisco san", url: "https://franciscosan.org/", tier: 3, facts: ["grant size: grants can be anywhere from zero to nineteen thousand dollars. if your organisation is a 501(c)(3) then grants can exceed nineteen thousand", "scope: grantees can be for parties, pop-ups, puzzle hunts, art, races, (un)conferences, distribution of interesting objects or anything in or out between. the only req", "how to apply: fill out this form!"] };
const SFGOV = { name: "SF Open Funding Opportunity", url: "https://www.sf.gov/information--community-development-current-recently-closed-funding-opportunities", tier: 3, facts: ["opportunity opens: October 7, 2026"] };
// Royce's exact two texts, and the francisco san caption that failed ("numbers not in its facts: 19, 8").
const AWESOME_CAPTION = "A $1,000 monthly microgrant from the SF chapter, no application overhead. Smaller than your target but stackable with Francisco San, and they've got an LA chapter too if the dinners move there.";
const CLOSING = "Checked SF.gov's funding page too, those RFPs are for immigration legal services, not a fit. Want me to start the Francisco San form now, or hold until Sunday with Eli settles SF vs LA?";
const FSAN_BAD = "A whimsical-events fund granting $0 to $19k with no 501(c)(3) needed, right in your $5k-8k range.";
const FSAN_GOOD = "A fund for parties, pop-ups and unconferences in SF, grants up to nineteen thousand dollars, no 501(c)(3) needed.";
const captions = (c: { awesome?: string; fsan?: string; closing?: string | null }) => JSON.stringify({ captions: [...(c.awesome ? [{ n: 1, caption: c.awesome }] : []), ...(c.fsan ? [{ n: 2, caption: c.fsan }] : [])], closing: c.closing ?? null });
const tellThem = { tool: "tellThem", input: { what: "Awesome Foundation SF as a stackable $1k, alongside Francisco San; SF.gov was not a fit; ask whether to start the Francisco San form now or hold until Sunday", links: [AWESOME.url, FSAN.url] } };

const NOW = new Date("2026-10-31T21:00:30Z"); // 2:00pm Pacific
const task: any = {
  id: 1103, userId: "u", goal: "Research grants that fit Noise and Cue: early-stage, community-focused, dinner/convening format, Bay Area and LA", theirWords: "knowing what you know about our company, I would want you to go research and find that",
  steps: [{ text: "Compile the best fits and text Royce the details", done: false }], planNext: "Send the best fits", status: "open", wakes: 2, textsSent: 0, lastTextedAt: null,
  createdAt: "2026-10-31T16:41:55Z", deadline: null, finalCheckAt: null, finalTold: false, awaitingReply: false, theirReplyAt: null, kind: "work", source: "ask", window: null, notes: [],
};
const run = async (answers: Answer[], over: Record<string, unknown> = {}) => {
  const sent: string[][] = [];
  const notes: string[] = [];
  script.length = 0;
  script.push(...answers);
  redrafts = 0;
  asked.length = 0;
  const r = await TT.runTaskTurnWith(task, {
    person: { first_name: "Royce", phone_number: "+14155550100", city: "San Francisco" }, recent: "", zone: "America/Los_Angeles",
    note: async (t: string) => { notes.push(t); }, schedule: async () => null, scheduleAt: async () => null, close: async () => {},
    textsToday: async () => 0, markTexted: async () => {}, markFinalTold: async () => {},
    send: async (m: string[]) => { sent.push(m); return { sent: true }; },
    search: async () => [], web: async () => ({ kept: [], dropped: [], droppedDetails: [], note: "" }), readPage: async () => ({ ok: true, facts: [], text: "" }),
    now: () => NOW, sentSince: async () => [],
    onFile: async () => [AWESOME, FSAN, SFGOV],
    ...over,
  } as any);
  script.length = 0;
  return { r, sent, notes, all: sent.flat().join("\n"), redrafts, asked: [...asked] };
};
// Every text that names francisco san goes in a send that carries its link.
const namedWithLink = (sent: string[][]) => sent.every((m) => !m.some((x) => /francisco san/i.test(x)) || m.includes(FSAN.url));

// 1. The afternoon as it was, and the redraft writes the same thing again: nothing names francisco san without its link.
{
  const o = await run([tellThem, { text: captions({ awesome: AWESOME_CAPTION, fsan: FSAN_BAD, closing: CLOSING }) }, { text: captions({ awesome: AWESOME_CAPTION, fsan: FSAN_BAD, closing: CLOSING }) }]);
  check("Royce's first text never goes naming francisco san without its link", namedWithLink(o.sent), o.sent);
  check("Royce's second text (the form offer) is not sent as is", !o.sent.flat().includes(CLOSING), o.sent);
  check("one redraft was asked for, with what broke", o.redrafts === 1 && /francisco san: numbers not in its facts/.test(o.asked[0]) && /names francisco san/.test(o.asked[0]), o.asked);
}
// 2. The redraft fixes francisco san's caption: its link goes, the Awesome caption may name it, and the form offer is cut.
{
  const o = await run([tellThem, { text: captions({ awesome: AWESOME_CAPTION, fsan: FSAN_BAD, closing: CLOSING }) }, { text: captions({ awesome: AWESOME_CAPTION, fsan: FSAN_GOOD, closing: CLOSING }) }]);
  check("after the redraft, francisco san's link goes", o.all.includes(FSAN.url), o.sent);
  check("and the Awesome Foundation link with its caption", o.all.includes(AWESOME.url) && o.all.includes(AWESOME_CAPTION), o.sent);
  check("francisco san is only named in the send that carries its link", namedWithLink(o.sent), o.sent);
  check("the form offer never goes", !/start the francisco san form/i.test(o.all), o.sent);
  check("one send, link then caption", o.sent.length === 1 && o.sent[0][0].startsWith("https://") && !o.sent[0][1].startsWith("https://"), o.sent);
}
// 3. Passing case: both links are going, so naming francisco san in the Awesome caption is fine, and no redraft is spent.
{
  const closing = "Both are worth a look.";
  const o = await run([tellThem, { text: captions({ awesome: AWESOME_CAPTION, fsan: FSAN_GOOD, closing }) }]);
  check("with its link present, the text naming francisco san goes as written", o.sent.length === 1 && o.sent[0].includes(AWESOME_CAPTION) && o.sent[0].includes(FSAN.url) && o.sent[0].includes(closing), o.sent);
  check("no redraft when nothing broke", o.redrafts === 0, { redrafts: o.redrafts });
}
// 4. The link path only: Cue sends the Awesome link alone, and its caption names francisco san (on file, not in this send).
{
  const o = await run([{ tool: "tellThem", input: { what: "Awesome Foundation SF", links: [AWESOME.url] } }, { text: JSON.stringify({ captions: [{ n: 1, caption: AWESOME_CAPTION }], closing: null }) }, { text: JSON.stringify({ captions: [{ n: 1, caption: "A $1,000 monthly microgrant from the SF chapter, no application overhead." }], closing: null }) }]);
  check("a caption naming a kept find that isn't going is redrafted without the name", o.sent.length === 1 && namedWithLink(o.sent) && o.all.includes(AWESOME.url), o.sent);
}
// 5. A plain text (no links) naming francisco san, a question included, doesn't go; neither does its form offer.
{
  for (const [label, text] of [
    ["a plain question naming francisco san without its link", "Francisco San looks like the strongest fit so far, want the details?"],
    ["a plain text offering to start the Francisco San form", "Want me to start the Francisco San form now?"],
  ] as const) {
    const o = await run([{ tool: "tellThem", input: { what: label } }, { text }, { text }]);
    check(`${label} is not sent`, o.sent.length === 0, { sent: o.sent, did: o.r.did });
  }
  // The control: the same question without the find's name goes, so the name is what held it.
  const ok = "That one looks like the strongest fit so far, want the details?";
  const c = await run([{ tool: "tellThem", input: { what: "the same question, unnamed" } }, { text: ok }, { text: ok }]);
  check("the same plain question without the name still goes", c.sent.length === 1 && c.sent[0][0] === ok, c.sent);
}

// 6. Review of #335: a find whose link already went to them since the task started isn't a tease to name again, and ordinary
//    words that happen to match a generic find's name ("a run club grant") don't count as naming it.
{
  const RUN = { name: "Run Club", url: "https://lu.ma/runclub", tier: 2, facts: ["date: 2026-11-08"] };
  const sentFsan = async () => [{ at: new Date("2026-10-31T19:00:00Z"), text: FSAN.url, kind: "link" }];
  for (const [label, text, over, goes] of [
    ["naming francisco san after its link already went", "Francisco San is the one to do first; the Awesome Foundation one can wait.", { sentSince: sentFsan }, true],
    ["the same, before its link ever went", "Francisco San is the one to do first; the Awesome Foundation one can wait.", {}, false],
    ["\"a run club grant\" with a find called Run Club on file", "Nothing new on grants yet that beats what you have; a run club grant came up but it's tiny.", { onFile: async () => [AWESOME, FSAN, SFGOV, RUN] }, true],
  ] as const) {
    const o = await run([{ tool: "tellThem", input: { what: label } }, { text }, { text }], over as any);
    check(`${label}: ${goes ? "goes" : "held"}`, (o.sent.length === 1) === goes, { sent: o.sent, notes: o.notes });
  }
}
// 7. Root cause of the dropped caption: the member's own target backs a caption's numbers, as it does for a search find. Royce's
//    words on the call that started the task (post_call_follow_ups, 2026-10-31 9:42am). francisco san's caption that afternoon isn't
//    recorded, only why it failed ("numbers not in its facts: 19, 8"); FSAN_BAD fails the same way. The "8" was his own target; the
//    "19" ("$19k" against facts that spell out "nineteen thousand") still needs the redraft, numbersBacked unchanged.
{
  const ROYCE = "Yeah, I really wanna start with, like, six to eight people and then kind of gradually, uh, push it up through there. Um, so in order to fund it, since we have no funding, we're thinking about just applying for grants. I think that was a big emphasis of what we talked about yesterday. Um, and I feel like if we get a grant for at least, like, 5,000 or 8,000, that would kind of carry over for the last two months.";
  const facts = `${FSAN.name} ${FSAN.facts.join(" ")}`;
  check("before: Royce's target alone fails a caption (\"8\")", TM.captionOk("Grants from zero to nineteen thousand dollars, right in your $5k-8k range.", facts).why === "numbers not in its facts: 8");
  check("now: his own words back it", TM.captionOk("Grants from zero to nineteen thousand dollars, right in your $5k-8k range.", facts, ROYCE).ok);
  check("the afternoon's caption still fails only on \"19\"", TM.captionOk(FSAN_BAD, facts, ROYCE).why === "numbers not in its facts: 19", TM.captionOk(FSAN_BAD, facts, ROYCE));
  check("a number neither the find nor they said still fails", !TM.captionOk("Grants up to $25k, right in your $5k-8k range.", facts, ROYCE).ok);
  const cap = "Grants from zero to nineteen thousand dollars for parties and pop-ups, right in your $5k-8k range.";
  const o = await run([{ text: JSON.stringify({ done: false, quote: null }) }, tellThem, { text: captions({ awesome: AWESOME_CAPTION, fsan: cap, closing: null }) }], { recent: `[Oct 31 9:40am] User said: ${ROYCE}` });
  check("in a task turn, his words reach the caption check: francisco san's link goes first time", o.all.includes(FSAN.url) && o.all.includes(cap) && o.redrafts === 0, { sent: o.sent, notes: o.notes, redrafts: o.redrafts });
}

// Pure pieces.
check("the form offer is an offer Cue can't keep", W.OFFERS_WHAT_CO_CANT.test(CLOSING));
// The review's probes (#335): refusals that must be caught, and things Cue can do that must not be.
const cant = [
  "Want me to start the Francisco San form now?", "Should I submit it for you?", "I'll fill out the application tonight.", "Want me to apply for it?", "Want me to fill it in?",
  "I can complete the Block Party Fund application.", "Want me to send in the form?", "I'll apply on your behalf", "I'll file the application Friday", CLOSING,
  "Want me to start your application?", "Want me to fill out the Awesome Foundation form?", "Want me to call and check before Friday?",
];
check(`fill in / submit / apply offers are caught: ${cant.filter((t) => !W.OFFERS_WHAT_CO_CANT.test(t)).join(" | ") || "all"}`, cant.every((t) => W.OFFERS_WHAT_CO_CANT.test(t)));
const can = [
  "I can draft your answers", "Want me to outline the application?", "I'll apply the filter", "I'll apply that to your list tomorrow", "I'll submit that to the team as feedback",
  "I'll start a list of application deadlines for you by Friday", "Want me to start on a cover letter for the application?", "Want me to start a page for the application?",
  "I'll start tracking when applications open, and text you Monday", "Want me to start watching for when applications open?", "I can complete the deadline list for the applications tomorrow",
  "Want me to start a doc with your application answers?", "I'll file the grant notes under your Noise doc", "I'll start a one-pager you can paste into the application",
  "Want me to fill in the gaps in your pitch for the application?", "I'll send in a few more options tomorrow", "I'll start a shortlist of fellowships with open applications by Thursday",
  "Want me to put together the application materials?", "I'll file a reminder for the form deadline", "Should I start the research for your application this week?",
  "Want me to draft answers for the francisco san form?", "Want me to start drafting your application?", "Want me to write up answers for the application?", "The form takes ten minutes to fill out.",
  "You could start the form this weekend.", "Want me to keep an eye on when applications open?", "Want me to start a list of grants for LA?", "Want me to start the application answers?",
];
const wrong = can.filter((t) => W.OFFERS_WHAT_CO_CANT.test(t));
check(`what Cue can do isn't refused: ${wrong.join(" | ") || "none"}`, !wrong.length);
check("\"Francisco San\" names the find francisco san", TM.namedFinds(AWESOME_CAPTION, [FSAN]).length === 1);
check("\"San Francisco, San Mateo\" doesn't", TM.namedFinds("Two in San Francisco, San Mateo too.", [FSAN]).length === 0);
check("a name a sent item's own name holds is left alone", TM.namedFinds("The Awesome Foundation SF chapter.", [{ name: "Awesome Foundation" }], [AWESOME]).length === 0);
// The review's naming probe (#335): a realistic kept list of generic names, and task texts that don't name any of them as a find.
// Only a proper noun counts; what's left is place and week names written as proper nouns.
const generic = [
  "Awesome Foundation San Francisco Chapter Grant", "francisco san", "SF Open Funding Opportunity", "Community Arts Grant", "Small Business Grant Program", "The Awesome Foundation", "Bay Area Community Fund", "Los Angeles Arts Council", "Neighborhood Empowerment Network", "Kickstarter",
  "Run Club", "SF Run Club", "Builders who Run SF — 5M Run & BBQ at Angel Island", "A Jar of Pickles x Junbi Mountain View", "Founders Dinner", "Tech Week", "SF Climate Week", "Demo Day", "Happy Hour", "Book Club", "Coffee + Code", "Sunday Supper", "AI Happy Hour", "Women in Tech Brunch", "Hackathon", "A Night of Jazz", "Open Studio Night", "Startup Grind", "Supper Club", "Dinner Party", "San Francisco Tech Week", "Founders & Funders", "Pitch Night", "Climate Week", "The Social", "Creative Mornings", "Morning Run", "Community Dinner", "Writers Workshop",
  "The Commons", "The Battery", "The Interval", "The Laundry", "The Midway", "Ferry Building", "Golden Gate Park", "Dolores Park", "Mission Bay", "The Ramp",
].map((name) => ({ name }));
const ordinary = [
  "A $1,000 monthly microgrant from the SF chapter, no application overhead.", "Small and quick: a run club that meets Saturdays at 8am, then coffee.", "A founders dinner series in SoMa, ten seats, the host picks the table.",
  "Happy hour after the talks, on the rooftop.", "Want me to keep an eye out for more run clubs near you?", "Free, outdoors, and the demo day crowd tends to stay late.",
  "A small book club for founders, monthly, at a bookstore in the Mission.", "A Sunday supper series at a chef's home, twelve seats.", "It's a hackathon for climate tools, two days, teams of three.",
  "A night of jazz and natural wine at a small bar in North Beach.", "Their pitch night is open to anyone with a deck.", "A supper club format, so you'd sit with strangers.",
  "Grants go to community dinners and gatherings in the Bay Area.", "A good fit for your dinner party idea: they fund food and space.", "Social, low-key, and mostly first-timers.",
  "A writers workshop in a bookstore, six weeks.", "Funding for small business owners in SF, up to $10,000.", "Creative mornings style talks, 8:30am, coffee included.",
  "Open studio night at a ceramics co-op, BYO clay.", "The commons area has room for forty people.", "Monthly, rotating hosts, a community dinner every first Friday.",
  "A morning run then breakfast; they keep it under twenty people.", "Women in tech brunch, every other Sunday.", "Startup grind events tend to be big; this one is smaller.",
  "Coffee + code on Saturday mornings at a cafe in Hayes Valley.", "Want me to look for a few more in Los Angeles arts circles too?", "The Bay Area community fund backs neighborhood events.",
];
const hit = ordinary.filter((t) => TM.namedFinds(t, generic).length);
check(`ordinary words don't name a generic find (${hit.length}/${ordinary.length}): ${hit.join(" | ") || "none"}`, !hit.length);
const proper = ["Hosted during Tech Week, so expect a crowd of founders.", "The space is right by Golden Gate Park.", "Two blocks from Dolores Park, with a back patio."];
check("a generic find written as a proper noun still counts (the known limit)", proper.every((t) => TM.namedFinds(t, generic).length === 1));
const real = [AWESOME_CAPTION, "Want me to start the Francisco San form now?", "Francisco San looks like the strongest fit so far, want the details?", "The Founders Dinner at Zuni is Thursday.", "Also on the list: Dolores Run Club."];
const realFinds = [FSAN, { name: "Founders Dinner at Zuni" }, { name: "Dolores Run Club 🏃 #SFRuns" }];
check("Royce's real texts and real find names still count", real.every((t) => TM.namedFinds(t, realFinds).length === 1), real.map((t) => TM.namedFinds(t, realFinds)));
check("a one-word name never at a sentence start", TM.namedFinds("Kickstarter campaigns are slow.", [{ name: "Kickstarter" }]).length === 0 && TM.namedFinds("It also takes Kickstarter backers.", [{ name: "Kickstarter" }]).length === 1);

console.log(`find links: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
