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

// Pure pieces.
check("the form offer is an offer Cue can't keep", W.OFFERS_WHAT_CO_CANT.test(CLOSING));
const cant = ["Should I submit it for you?", "I'll fill out the application tonight.", "Want me to apply for it?", "Want me to fill it in?", "I can complete the Block Party Fund application.", "Want me to call and check before Friday?"];
check(`fill in / submit / apply offers are caught: ${cant.filter((t) => !W.OFFERS_WHAT_CO_CANT.test(t)).join(" | ") || "all"}`, cant.every((t) => W.OFFERS_WHAT_CO_CANT.test(t)));
const can = ["Want me to draft answers for the francisco san form?", "Want me to start drafting your application?", "Want me to write up answers for the application?", "The form takes ten minutes to fill out.", "You could start the form this weekend.", "Want me to keep an eye on when applications open?", "Want me to start a list of grants for LA?"];
check(`drafting for them and plain mentions aren't refused: ${can.filter((t) => W.OFFERS_WHAT_CO_CANT.test(t)).join(" | ") || "none"}`, can.every((t) => !W.OFFERS_WHAT_CO_CANT.test(t)));
check("\"Francisco San\" names the find francisco san", TM.namedFinds(AWESOME_CAPTION, [FSAN]).length === 1);
check("\"San Francisco, San Mateo\" doesn't", TM.namedFinds("Two in San Francisco, San Mateo too.", [FSAN]).length === 0);
check("a name a sent item's own name holds is left alone", TM.namedFinds("The Awesome Foundation SF chapter.", [{ name: "Awesome Foundation" }], [AWESOME]).length === 0);

console.log(`find links: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
