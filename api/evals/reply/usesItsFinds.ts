// A reply uses what its own search found (Royce, 2026-10-17, standing direction: "Every find Cue sends, in a reply or on its own,
// goes out as its link, then a one-line caption. Never prose that names a find without its link."). From the 10-17 SF turn: the
// search found real SF events; the reply said "Weekend's thin…", the fact check emptied it, the send step called the holding line
// "Let me look" the answer, the agent wrote "(no further message needed)", and the member got the fallback. Zero tokens: the send
// step runs with a stub fact check and nothing is sent.
//   npx tsx evals/reply/usesItsFinds.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import { readFileSync } from "fs";
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const FG = await import("../../src/agent/findGuards.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};

const FINDS = [
  { name: "Builders who Run SF — 5M Run & BBQ at Angel Island", url: "https://lu.ma/builders-run-sf" },
  { name: "PlanetScale Movie Night: You Can See Everything", url: "https://lu.ma/planetscale-movie" },
  { name: "MITAI Conference 2026: Age of Agency", url: "https://lu.ma/mitai-2026" },
  { name: "Festival of the Irrational by Caterina Fake", url: "https://lu.ma/irrational" },
];
// The send step with this turn's finds planted, a fact check that returns gate(draft), and the holding line already sent.
// The meaning read is injected (never a model call here): `read` answers it, and `reads` counts what it was asked.
type Read = (draft: string, finds: { name: string }[]) => Promise<{ named: number[]; saysNothing: boolean } | null>;
const NO_USE: Read = async () => ({ named: [], saysNothing: false });
const turn = (gate: (d: string, findsWaiting?: () => boolean) => string = (d) => d, o: { held?: boolean; shared?: string[]; read?: Read; finds?: { name: string; url: string; source?: string }[]; redraftLeft?: () => boolean } = {}) => {
  const sends: string[] = [];
  const reads: { draft: string; finds: string[] }[] = [];
  const gates: { sent: string[]; answered?: string[]; findsWaiting?: boolean }[] = [];
  const read = o.read ?? NO_USE;
  const t = createConversationTools({
    userId: "u", phoneNumber: "+14155550101", resolvedContent: "Anything you have for me in SF?", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true,
    sendCoReply: async ({ message }: any) => (sends.push(message), true), facts: { add: () => {}, text: () => "" },
    // findsWaiting is recorded as the check reads it when it starts; the stub gets the live read, as the real check does.
    gate: async (d: string, sent: string[], answered?: string[], findsWaiting?: () => boolean) => (gates.push({ sent, answered, findsWaiting: findsWaiting?.() }), gate(d, findsWaiting)),
    findUseRead: async (d: string, f: { name: string }[]) => (reads.push({ draft: d, finds: f.map((x) => x.name) }), read(d, f)),
    redraftLeft: o.redraftLeft,
  } as any) as any;
  const loop = t.loop();
  for (const f of o.finds ?? FINDS) loop.found.set(f.url, { ...f, facts: "", match: { tier: (f as any).source === "x" ? 3 : 2, name: f.name, url: f.url, source: (f as any).source } as any, blocked: null });
  for (const u of o.shared ?? []) loop.shared.push(u);
  if (o.held !== false) {
    t.state.sentMessages.push("Let me look");
    t.state.holdLines.push("Let me look");
  }
  // Each send here follows a tool's result (a search), as a later send in a real turn must (agent/conversationTools.ts wrapSendsForOneReply
  // holds a second text with nothing new since the reply).
  const send = (message: string, toolCallId = "x") => ((t.state.workSinceSend = true), t.tools.sendReply.execute({ message }, { toolCallId, messages: [] }));
  return { send, state: t.state, sends, reads, gates };
};

// ---------------------------------------------------------------- 3. ignored results: "thin" right after the finds
{
  const t = turn();
  const r = await t.send("Weekend's thin on the founder/builder side right now. The one still open is The SF Table dinner at Poesia on Nov 2.");
  check("a reply that says it's thin while this turn's finds wait isn't sent: one redraft, through shareFinds", r.ok === false && /says there's little or nothing/.test(r.error) && /shareFinds/.test(r.error) && /lu\.ma\/builders-run-sf/.test(r.error), r);
  const again = await t.send("Weekend's thin on the founder side right now.");
  check("... once a turn: the second try goes on to the fact check like any reply (never a loop)", again.ok !== false || !/says there's little or nothing/.test(again.error ?? ""), again);
}
// ---------------------------------------------------------------- 1. a find named in prose without its link
{
  const t = turn();
  const r = await t.send("On the SF question, Builders who Run SF, the 5M run and BBQ at Angel Island, is today if you want something low key.");
  check("a reply naming a find without its link isn't sent: one redraft, its link then a caption via shareFinds", r.ok === false && /without its link/.test(r.error) && /its link, then a one-line caption/.test(r.error), r);
  const linked = turn(undefined, { shared: ["https://lu.ma/builders-run-sf"] });
  const ok = await linked.send("That run's a nice low-key one if you're up for it.");
  check("... a find already sent with shareFinds may be talked about after", ok.ok !== false, ok);
  const plain = turn();
  const fine = await plain.send("Glad you asked. Here's what I'd pick, two lines coming.");
  check("... and a reply that names no find isn't touched", fine.ok !== false, fine);
}
// ---------------------------------------------------------------- 2. the fact check cut everything
{
  const t = turn(() => "");
  const r = await t.send("Small table, $22, that's probably your best bet.");
  check("everything cut, only the holding line sent: never 'what you already sent is the answer' (the 10-17 fallback)", r.ok === false && !/already sent this turn is the answer/.test(r.error ?? "") && /still waiting/.test(r.error) && /shareFinds/.test(r.error), r);
  const meta = turn();
  const m = await meta.send("(no further message needed)");
  check("a note to itself is never the reply while nothing has answered them", m.ok === false && /note to yourself/.test(m.error), m);
  const done = turn(() => "", { held: false, shared: FINDS.map((f) => f.url) });
  done.state.sentMessages.push("https://lu.ma/builders-run-sf");
  const d = await done.send("Hope one of those fits.");
  check("... and when the finds already went (real answers), an emptied closing line is still fine to drop", d.ok === true && /already sent this turn is the answer/.test(d.note ?? ""), d);
}
// ---------------------------------------------------------------- the pure reads
{
  const f = FINDS.map((x) => ({ ...x, facts: "", match: {} as any, blocked: null }));
  check("names a find by its name or two of its own words; not by 'SF' or 'night' alone", FG.namesFind("the Builders who Run SF thing", f[0]) && FG.namesFind("that Angel Island run and BBQ", f[0]) && !FG.namesFind("a fun night in SF", f[1]) && !FG.namesFind("Hope your week is good", f[2]));
  check("'thin', 'nothing much', 'no luck' read as saying there's nothing; 'Nothing's wrong' and plain talk don't", ["Weekend's thin on the founder side right now.", "Nothing much this weekend.", "No luck so far.", "Pretty quiet out there."].every((x) => FG.NOTHING_SAID.test(x)) && !["Nothing's wrong, all good.", "Here are a few.", "Quiet is good sometimes, how are you?"].some((x) => FG.NOTHING_SAID.test(x)));
  check("only this turn's own finds count (never one carried in, or turned away)", FG.turnFinds([{ name: "A", url: "https://a.example", facts: "", match: {} as any, blocked: null, stored: true }, { name: "B", url: "https://b.example", facts: "", match: {} as any, blocked: "sold out" }, { name: "C", url: "https://c.example", facts: "", match: {} as any, blocked: null }] as any).map((x) => x.name).join() === "C");
}
{
  const L = await import("../../src/agent/loopTools.js");
  check("the line while a search runs answers them in Cue's own voice, reacting to what they asked or how they put it, different every time; optional, first search only, never filler, not a bare label and never a generic status line ('let me look')", /give one short line in your own voice that answers them the way a person would, never a status/.test(L.WHILE_LOOKING) && /React to what they asked or how they put it \(their mood, a word they chose, the occasion\), warm, playful or wry as fits them and the moment, and different every time/.test(L.WHILE_LOOKING) && /Optional, and only on your first search/.test(L.WHILE_LOOKING) && /Leave it empty when the answer will be quick or a line wouldn't help; it is never required and never filler/.test(L.WHILE_LOOKING) && /Not a bare label/.test(L.WHILE_LOOKING) && /let me look/.test(L.WHILE_LOOKING) && /never one you've sent them before/.test(L.WHILE_LOOKING) && (readFileSync(new URL("../../src/agent/loopTools.ts", import.meta.url), "utf8").match(/whileLooking: z\.string\(\)\.optional\(\)\.describe\(WHILE_LOOKING\)/g) ?? []).length === 3);
  // Royce, 2026-11-09: the old anchor ("Looking at what's on in SF this week.") made the model copy "Looking for...". It's gone, and
  // no example of the kind of line opens on "Looking".
  const examples = [...L.WHILE_LOOKING.matchAll(/gets "([^"]+)"/g)].map((m) => m[1]);
  check("the anchor example is gone; 3-4 example lines from different moments, none opening on 'Looking'", !/Looking at what's on in SF this week/.test(L.WHILE_LOOKING) && examples.length >= 3 && examples.length <= 4 && examples.every((x) => !/^\s*looking\b/i.test(x)) && new Set(examples.map((x) => x.split(" ")[0])).size === examples.length, examples);
  check("the new rules: never 'Looking for'/'Looking at', never just their request said back, never knowledge Cue doesn't have", /Never open with "Looking for" or "Looking at", and never just say their request back to them/.test(L.WHILE_LOOKING) && /never knowledge you don't have \("I know just the place"\)/.test(L.WHILE_LOOKING));
}
{
  // 2026-11-06 live test: "Co is looking: founder dinners before an investor meeting, good instinct".
  const L = await import("../../src/agent/loopTools.js");
  check("the progress-line guidance forbids praise, a recap, machinery and anything implying a result", /never just say their request back to them\. No praise, no tools or machinery, never anything that implies you've found something/.test(L.WHILE_LOOKING) && !/friend who's into it/.test(L.WHILE_LOOKING));
  const C = await import("../../src/services/capabilities.js");
  const use = C.toolUse("shareFinds");
  check("the caption guidance covers a find that isn't the form they asked for ('not a dinner, but...')", /isn't the form they asked for/.test(use) && /not a dinner, but/.test(use));
}
// ---------------------------------------------------------------- the holding line: never a stock opener (golden 55, 2026-10-17)
{
  const L = await import("../../src/agent/loopTools.js");
  const mk = () => {
    const t = createConversationTools({
      userId: "u", phoneNumber: "+14155550101", resolvedContent: "Anything you have for me in SF?", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, stubSearch: true,
      stubEvents: [{ name: FINDS[0].name, url: FINDS[0].url, lines: ["Saturday 9:30am."] }],
      sendCoReply: async () => true, facts: { add: () => {}, text: () => "" },
    } as any) as any;
    return t;
  };
  const t1 = mk();
  const first = await t1.tools.searchEvents.execute({ what: "things to do in SF", whileLooking: "Let me see what's good this week." }, { toolCallId: "a", messages: [] });
  check("a stock holding line ('Let me see…') is refused once, before anything is searched", first.ok === false && /generic status line/.test(first.error) && t1.state.holdLines.length === 0 && t1.loop().found.size === 0, first);
  const second = await t1.tools.searchEvents.execute({ what: "things to do in SF", whileLooking: "Let me look." }, { toolCallId: "b", messages: [] });
  check("... a second stock line is never sent, and the search goes on without it", second.ok === true && t1.state.holdLines.length === 0 && t1.loop().found.size === 1, second);
  const t2 = mk();
  const own = await t2.tools.searchEvents.execute({ what: "things to do in SF", whileLooking: "Ooh, a free Saturday in SF, pulling the good ones." }, { toolCallId: "c", messages: [] });
  check("a line that reacts to what they asked goes out as the holding line", own.ok === true && t2.state.holdLines[0] === "Ooh, a free Saturday in SF, pulling the good ones.");
  // Royce, 2026-11-09: his wine-night ask. The line he got reads as a status restating it; the line he wanted reacts, in Cue's voice.
  const wine = "Can you find me a wine night in SF this week where I can whine down and chill";
  const mkWine = () => createConversationTools({
    userId: "u", phoneNumber: "+14155550101", resolvedContent: wine, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, stubSearch: true,
    stubEvents: [{ name: FINDS[0].name, url: FINDS[0].url, lines: ["Saturday 9:30am."] }],
    sendCoReply: async () => true, facts: { add: () => {}, text: () => "" },
  } as any) as any;
  const good = "A wine night sounds right. Let me find you somewhere quiet.";
  const t3 = mkWine();
  const went = await t3.tools.searchEvents.execute({ what: "wine night", city: "SF", whileLooking: good }, { toolCallId: "w1", messages: [] });
  check("11-09: a line in Cue's own voice that reacts to the wine-night ask goes out as the holding line", L.holdProblem(good, wine) === null && went.ok === true && t3.state.holdLines[0] === good, { problem: L.holdProblem(good, wine), went, held: t3.state.holdLines });
  const bad = "Looking for a low key wine night in SF.";
  const t4 = mkWine();
  const refused = await t4.tools.searchEvents.execute({ what: "wine night", city: "SF", whileLooking: bad }, { toolCallId: "w2", messages: [] });
  check("11-09: \"Looking for a low key wine night in SF.\" is refused as a status that says their request back, before anything is searched", /says their request back/.test(L.holdProblem(bad, wine) ?? "") && refused.ok === false && /says their request back/.test(refused.error) && /never opening on "Looking for" or "Looking at"/.test(refused.error) && t4.state.holdLines.length === 0 && t4.loop().found.size === 0, refused);
  // #440 review: a restatement needs more than three words of meaning, so the three-word "Wine night in SF this week" now goes.
  check("11-09: a line only made of their own words is a restatement, whatever its opener; one with words of its own isn't", L.restatesThem("A wine night in SF to chill.", wine) && L.holdProblem("Wine night in SF this week", wine) === null && !L.restatesThem(good, wine) && L.holdProblem("Whine down, I see what you did there.", wine) === null);
  // #440 review: a short warm line (under three words of meaning) is never a restatement.
  check("#440 review: short warm lines go: 'Jazz tonight, yes please.', 'Hikes!', 'Quiet dinner with your parents, on it.'", L.holdProblem("Jazz tonight, yes please.", "jazz tonight?") === null && L.holdProblem("Hikes!", "any hikes this weekend") === null && L.holdProblem("Quiet dinner with your parents, on it.", "a quiet dinner with my parents") === null, [L.holdProblem("Jazz tonight, yes please.", "jazz tonight?"), L.holdProblem("Hikes!", "any hikes this weekend"), L.holdProblem("Quiet dinner with your parents, on it.", "a quiet dinner with my parents")]);
  check("#440 review: the opener and the full restatement are still refused", /says their request back/.test(L.holdProblem("Looking for a low key wine night in SF.", wine) ?? "") && /only says their request back/.test(L.holdProblem("A wine night in SF to chill.", wine) ?? ""));
  check("11-09: a generic status is still refused on the wine-night ask", ["Let me look.", "One sec, checking", "On it", "Give me a minute"].every((x) => /generic status line/.test(L.holdProblem(x, wine) ?? "")));
  check("11-09: 'Looking for'/'Looking at' is refused even when it names their thing; 'Looking forward' isn't an opener", ["Looking at founder dinners in SF for Saturday", "Ok, looking for a wine bar in SF", "Looking for somewhere quiet to whine down"].every((x) => L.LOOKING_OPENER.test(x) && L.stockLine(x, wine)) && !L.LOOKING_OPENER.test("Looking forward to this one"));
  check("stock openers read as stock; lines that react don't", ["Let me look", "Let me see what's good this week.", "On it", "One sec, checking", "Give me a minute"].every((x) => L.STOCK_HOLD.test(x)) && !["Ooh, SF on a Saturday, digging in", "A low-key night sounds right, pulling a few", "Love that, founder dinners this week coming up"].some((x) => L.STOCK_HOLD.test(x)));
}
// ---------------------------------------------------------------- meaning, not words (Royce, 2026-10-17: "the guards match words,
// not meaning"). Each phrasing below was missed by the words alone (measured on the guards as they were). The meaning read catches
// them here only because the injected read says so: whether the real Haiku read says so is measured live, not here
// (~/cue-worktrees/live/find-use-live.mts, reported in the proof).
const LOOSE_NOTHING = [
  "Not a lot going on this weekend.",
  "Honestly the weekend's looking a little light.",
  "Doesn't look like much is happening.",
  "Not seeing anything that's really you this week.",
  "The pickings are slim.",
  "Kind of a dead weekend for founder stuff.",
  "Nothing jumping out at me.",
];
const LOOSE_NAMED: [string, number][] = [
  ["The run club thing on Saturday looks good.", 1],
  ["Caterina's festival is a good one.", 4],
  ["There's a Nathan Fielder screening Saturday.", 2],
  ["The AI conference down in Mountain View is big.", 3],
  ["The Saturday morning run with food after is a nice one.", 1],
];
{
  const f = FINDS.map((x) => ({ ...x, facts: "", match: {} as any, blocked: null }));
  check("the words alone miss every loose 'nothing' phrasing below but one (this is why the read exists)", LOOSE_NOTHING.filter((x) => FG.NOTHING_SAID.test(x)).length <= 1, LOOSE_NOTHING.filter((x) => FG.NOTHING_SAID.test(x)));
  check("... and miss every loosely named find below", LOOSE_NAMED.every(([x, i]) => !FG.namesFind(x, f[i - 1])), LOOSE_NAMED.filter(([x, i]) => FG.namesFind(x, f[i - 1])));
  for (const line of LOOSE_NOTHING) {
    const t = turn(undefined, { read: async () => ({ named: [], saysNothing: true }) });
    const r = await t.send(line);
    check(`"${line}": the read says it's saying there's nothing, so it isn't sent while finds wait`, r.ok === false && /says there's little or nothing/.test(r.error), r);
  }
  for (const [line, i] of LOOSE_NAMED) {
    const t = turn(undefined, { read: async () => ({ named: [i], saysNothing: false }) });
    const r = await t.send(line);
    check(`"${line}": the read says it names find ${i}, so it goes back for the link`, r.ok === false && /without its link/.test(r.error) && t.reads[0]?.finds.length === 4, r);
  }
  const q = turn(undefined, { read: async () => ({ named: [], saysNothing: false }) });
  const qr = await q.send("Quiet night in, or are you up for something out?");
  check("a question the read says names nothing and says nothing goes out as written", qr.ok === true && !qr.error, qr);
  const fail = turn(undefined, { read: async () => null });
  const fr = await fail.send("Not a lot going on this weekend.");
  check("a read that fails decides nothing: the draft goes on as the words left it (never the fallback line)", fr.ok === true, fr);
  const words = turn(undefined, { read: async () => ({ named: [], saysNothing: true }) });
  await words.send("Weekend's thin right now.");
  check("the words catch it first: no read is spent", words.reads.length === 0);
  const after = turn(undefined, { shared: [FINDS[1].url], read: async () => ({ named: [], saysNothing: true }) });
  const ar = await after.send("Not a lot else going on this weekend.");
  check("once a find went out, no read is spent and 'nothing else' goes out", ar.ok !== false && after.reads.length === 0, ar);
  const linked = turn(undefined, { read: async () => ({ named: [1], saysNothing: false }) });
  await linked.send("This one: https://lu.ma/builders-run-sf is the pick.");
  check("a draft carrying a find's link spends no read", linked.reads.length === 0);
}
// ---------------------------------------------------------------- the review of this change (2026-10-17)
{
  // 1. No redraft can follow: sent as written, never the fallback.
  const plain = turn();
  const p = await plain.send("Builders who Run SF, the 5M run and BBQ at Angel Island, is today if you want something low key.", "plain-text-reply");
  check("review 1: the plain text sent after the loop ended goes out even naming a find (no redraft could follow)", p.ok === true, p);
  const late = turn(undefined, { redraftLeft: () => false });
  const l = await late.send("Weekend's thin on the founder side right now.");
  check("review 1: on the last step or in the last seconds, the same", l.ok === true, l);
  // 3. Some finds went out: an honest "nothing else fits" is a filter, never pushed for more.
  const two = turn(undefined, { shared: [FINDS[0].url, FINDS[1].url] });
  const t3 = await two.send("Nothing on Saturday night that fits besides the movie, the rest is daytime.");
  check("review 3: after finds went out, 'nothing else fits' goes out", t3.ok !== false, t3);
  // 4. X posts: a post's name is its own prose.
  const POST = { name: "people building AI agents this week, who wants to jam at the Mission", url: "https://x.com/someone/status/1", source: "x" };
  const x = turn(undefined, { finds: [POST], read: async () => ({ named: [1], saysNothing: false }) });
  const xr = await x.send("Happy to keep an eye out for people building AI agents this week.");
  check("review 4: talk on an X post's subject isn't 'naming' it (words or read)", xr.ok !== false, xr);
  const f = { name: "Founder Dinner Series | San Francisco Startup Community", url: "https://example.org/dinners", facts: "", match: {} as any, blocked: null };
  check("review 4: a web result's site suffix ('| San Francisco Startup Community') isn't its name", !FG.namesFind("Startup community dinners are a good way in.", f) && FG.namesFind("The Founder Dinner Series is the one.", f));
  // Should fix: the fact check knows a holding line isn't an answer.
  const g = turn();
  await g.send("Here's what I found for you, sending two now.");
  check("review 5: the fact check gets what answered them apart from what went (the holding line is in one, not the other)", g.gates[0]?.sent.includes("Let me look") && Array.isArray(g.gates[0]?.answered) && !g.gates[0]!.answered!.includes("Let me look"), g.gates);
  const RG = readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
  check("review 5: a stripped reply is dropped as already answered only by what answered them (pinned in the source)", /afterStrip\(\{ enough, inviteCut, sentThisTurn: src\.answeredThisTurn \?\? src\.sentThisTurn/.test(RG) && /sentThisTurn: o\.src\.answeredThisTurn \?\? o\.src\.sentThisTurn/.test(RG));
}
{
  // 2. On a call the line is never sent, so it's never asked for again.
  const t = createConversationTools({
    userId: "u", phoneNumber: "+14155550101", resolvedContent: "Anything in SF?", isVoice: true, onCall: true, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, stubSearch: true,
    stubEvents: [{ name: FINDS[0].name, url: FINDS[0].url, lines: ["Saturday 9:30am."] }],
    sendCoReply: async () => false, facts: { add: () => {}, text: () => "" },
  } as any) as any;
  const r = await t.tools.searchEvents.execute({ what: "things to do in SF", whileLooking: "Let me look." }, { toolCallId: "a", messages: [] });
  check("review 2: on a call a stock line costs no round: the search runs", r.ok === true && t.loop().found.size === 1, r);
}
// ---------------------------------------------------------------- the stock list: what it does and doesn't cover
{
  const L = await import("../../src/agent/loopTools.js");
  const STOCK = ["Let me look", "Lemme check", "Let me take a look", "Let me dig in", "Let me poke around", "I'll look into it", "Let's see", "Looking now", "Searching", "Digging in", "On it", "Working on it", "One moment", "Give me a sec", "Gimme a sec", "Hang tight", "Bear with me", "Be right back", "brb", "Back in a bit", "Ok, let me look", "Sure, one sec", "Got it, checking"];
  const NOT = ["Looking forward to this one, pulling a few", "Ooh, SF on a Saturday, digging in", "A low-key night sounds right", "Founder dinners this week, coming up", "Okay, SF in October is the best"];
  check("the stock list reads every stock opener above as stock", STOCK.every((x) => L.STOCK_HOLD.test(x)), STOCK.filter((x) => !L.STOCK_HOLD.test(x)));
  check("... and never a line that reacts (even one that ends 'digging in', or starts 'Okay,')", !NOT.some((x) => L.STOCK_HOLD.test(x)), NOT.filter((x) => L.STOCK_HOLD.test(x)));
  // Not covered, and said so: generic lines that don't open with a stock phrase. The rule is openers only.
  const SLIPS = ["Good question, give me a minute", "Pulling a few now", "Scanning the week"];
  check("known gaps (openers only): these generic lines aren't caught, on purpose of the rule's shape", SLIPS.every((x) => !L.STOCK_HOLD.test(x)));
}
// ---------------------------------------------------------------- the second review (2026-10-17)
{
  const RG = await import("../../src/harness/replyGrounding.js");
  // Must-fix: only the holding line went and the check cut everything. The real check's own decision (afterStrip) returned "honest",
  // so the honest "not sure" line went out while finds waited, and the emptied redraft never ran.
  check("review 2 must-fix: cut to almost nothing with finds waiting, the check leaves it empty (for the redraft), never the honest line", RG.afterStrip({ enough: false, inviteCut: false, sentThisTurn: [], findsWaiting: true }) === "nothing" && RG.afterStrip({ enough: false, inviteCut: false, sentThisTurn: [] }) === "honest" && RG.afterStrip({ enough: true, inviteCut: false, sentThisTurn: [], findsWaiting: true }) === "cut");
  const w = turn();
  await w.send("Here's a thought for the weekend, nothing booked yet.");
  check("... and the send step tells the check when finds are waiting", w.gates[0]?.findsWaiting === true, w.gates);
  const none = turn(undefined, { shared: FINDS.map((f) => f.url) });
  await none.send("Hope one of those fits.");
  check("... not once every find went out", none.gates[0]?.findsWaiting === false, none.gates);
  const plainW = turn();
  await plainW.send("A short plain-text reply with nothing in it.", "plain-text-reply");
  check("... and not when no redraft can follow (the honest line is right then)", plainW.gates[0]?.findsWaiting === false, plainW.gates);
  const nudged = turn(() => "");
  const n1 = await nudged.send("Weekend's thin on the founder side right now.");
  const n2 = await nudged.send("Something else, still nothing linked.");
  check("... nor after the turn's one finds redraft was spent", n1.ok === false && nudged.gates.length >= 1 && nudged.gates[nudged.gates.length - 1].findsWaiting === false, { n1, n2, gates: nudged.gates });
  // Should-fix 1 (second review): not once a send. Third review: two a turn, so a clean first send can't use it up.
  const many = turn(undefined, { read: async () => ({ named: [], saysNothing: false }) });
  await many.send("Glad you asked, more in a sec.");
  await many.send("And one more thought for you.");
  await many.send("And a third, still nothing linked.");
  check("review 2 + 3: the meaning read runs at most twice a turn, however many sends", many.reads.length === 2, many.reads);
  const second = turn(undefined, { read: async (d) => ({ named: [], saysNothing: /not a lot going on/i.test(d) }) });
  const s1 = await second.send("Love that you're up for something this weekend.");
  const s2 = await second.send("Not a lot going on in SF this weekend though.");
  check("review 3: a clean first send doesn't use up the read: the second, saying there's nothing, is read and goes back", s1.ok !== false && s2.ok === false && /says there's little or nothing/.test(s2.error ?? "") && second.reads.length === 2, { s1, s2, reads: second.reads });
}
// ---------------------------------------------------------------- the review of #228 (2026-10-17): the window, after the check
{
  // The check can strip, redraft and recheck (several model calls) past the redraft window. It chose "nothing" from a read taken
  // before it ran, the send step asked for a redraft that could no longer happen, and the member got the fallback line. The stub
  // models the real check's last decision (afterStrip): empty while finds wait and a redraft can follow, its honest line otherwise.
  const HONEST = "Honestly, I'm not sure on that one.";
  let open = true;
  const slow = turn((_d, waiting) => ((open = false), waiting?.() ? "" : HONEST), { redraftLeft: () => open });
  const r = await slow.send("Small table, $22, that's probably your best bet.");
  check("#228 review: the check outlasts the redraft window with finds waiting: the honest line goes, never the redraft note (and so never the fallback)", r.ok === true && !/still waiting|shareFinds/.test(r.error ?? "") && slow.state.sent === true && slow.state.sentMessages.at(-1) === HONEST && !slow.state.findsNudged, { r, sent: slow.state.sentMessages });
  check("... the window was open when the check started (finds were waiting then)", slow.gates[0]?.findsWaiting === true, slow.gates);
  const still = turn((_d, waiting) => (waiting?.() ? "" : HONEST), { redraftLeft: () => true });
  const s = await still.send("Small table, $22, that's probably your best bet.");
  check("... and with the window still open after the check, the one redraft still goes through the finds", s.ok === false && /still waiting/.test(s.error) && /shareFinds/.test(s.error), s);
  const RG = await import("../../src/harness/replyGrounding.js");
  check("... the real check reads the window when it decides: closed by then, its honest line; open, empty for the redraft", RG.afterStrip({ enough: false, inviteCut: false, sentThisTurn: [], findsWaiting: () => false }) === "honest" && RG.afterStrip({ enough: false, inviteCut: false, sentThisTurn: [], findsWaiting: () => true }) === "nothing");
}
{
  // Should-fix 2: a stock opener that names something of theirs reacts to them.
  const L = await import("../../src/agent/loopTools.js");
  const ask = "Anything you have for me in SF? Founder stuff this Saturday, maybe the Angel Island run";
  // 11-09: two of the reviewer's six now fail on purpose: "Looking at founder dinners in SF for Saturday" opens on "Looking at", and
  // "Yes, looking good for Saturday in SF" is only their own words said back (LOOKING_OPENER, restatesThem).
  const REACTS = ["Let me see if the Angel Island run still has spots", "Digging into SF founder events this weekend", "Hold on, Saturday's actually stacked", "I'll find you something low key for Saturday"];
  // #440 review: "Yes, looking good for Saturday in SF" has two words of meaning (saturday, sf), too short to be a restatement: it goes.
  check("11-09: the opener still fails; the short one now goes (#440 review)", /opens on "Looking for" or "Looking at"/.test(L.holdProblem("Looking at founder dinners in SF for Saturday", ask) ?? "") && L.holdProblem("Yes, looking good for Saturday in SF", ask) === null);
  const STOCK = ["Let me look", "Let me see what's good this week.", "On it", "One sec, checking", "Give me a minute", "Ok, let me look", "Searching now", "Let me find you something good"];
  check("review 2: a stock opener naming something from their words isn't stock (four of the reviewer's six)", REACTS.every((x) => !L.stockLine(x, ask)), REACTS.filter((x) => L.stockLine(x, ask)));
  check("... one naming nothing of theirs still is", STOCK.every((x) => L.stockLine(x, ask)), STOCK.filter((x) => !L.stockLine(x, ask)));
  // Third review: generic lines that only echo filler from their text ("going on", "out there", "happening").
  const FILLER: [string, string][] = [["Let me see what's going on", "What's going on this week?"], ["Let me look out there", "Anything good out there?"], ["Let me see what's happening", "anything happening tonight?"]];
  check("review 3: a stock line sharing only filler with their text is still stock", FILLER.every(([x, t]) => L.stockLine(x, t)), FILLER.filter(([x, t]) => !L.stockLine(x, t)));
}
check("the standing direction is in Cue's core voice, word for word", readFileSync(new URL("../../src/services/coVoice.ts", import.meta.url), "utf8").includes("Every find Cue sends, in a reply or on its own, goes out as its link, then a one-line caption. Never prose that names a find without its link."));

console.log(`reply uses its finds: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
