// Everything Co says aloud on a call is grounded, and a fact they give for an open task is written down (Royce, 2026-10-08:
// "Anything Co says aloud on a call (names, places, numbers) passes the same real-finds-only check as text. The studio name miss
// on the live call is the reproduction case. Unknown stays unknown, said as 'I'm not sure.'").
// Layer 1: a fake model stream, fake tools behind the real guard; zero tokens, no network.
//   npx tsx evals/calls/spokenGrounding.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const P = await import("../../src/services/callLlmProxy.js");
const G = await import("../../src/services/offerGuard.js");
const CT = await import("../../src/services/callTools.js");
const E = await import("../../src/services/elevenLabsCalls.js");
const S = await import("../../src/services/speakable.js");
const SW = await import("../../src/services/abilitySwitches.js");
const { z } = await import("zod");
const { tool: aiTool } = await import("ai");
SW.setSwitchesForTest({});
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

// The live call's second half (evals/calls/callToolsLive.ts), with its real prompt: the test member, a planning-doc task open.
const base = fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const system = E.promptForElevenLabs(base).replace(/\{\{first_name\}\}/g, "Jordan").replace("{{context_summary}}", "Jordan is a founder in San Francisco who runs a small design community. New to Cue.").replace(/\{\{[a-z_]+\}\}/g, "");
const ELLIS = "Also, note that the studio is called Ellis Works and the date's not locked yet, so keep that open on your side.";
const tasks = [{ id: 119, goal: "Planning doc for the November partner dinner with a design studio" }];
const records = CT.callRecords({ tasks, loops: null }, []);
const body = (their = ELLIS, extra: any[] = []) => ({
  model: "co", stream: true,
  messages: [
    { role: "system", content: system },
    { role: "assistant", content: "Hey Jordan, it's Cue again." },
    { role: "user", content: "Hey Cue. Following up on the partner dinner." },
    { role: "assistant", content: "Good, I'm on it. What's on your mind?" },
    ...extra,
    { role: "user", content: their },
  ],
});
const src = (b = body(), toolResults = "") => P.callSources(b as any, records, toolResults);

// ---- (a) the check, sentence by sentence
{
  const s = src();
  check("Ellis Works: the member's own name, said back, passes", G.spokenProblem("Got it, Ellis Works, and the date stays open.", s) === null, G.spokenProblem("Got it, Ellis Works, and the date stays open.", s));
  check("Cue's own open task backs keeping the doc moving", G.spokenProblem("I'll keep the planning doc moving with that in mind.", s) === null, G.spokenProblem("I'll keep the planning doc moving with that in mind.", s));
  const venues = G.spokenProblem("I'll text you what I find on venues.", s);
  check("the live call's unasked promise ('what I find on venues') is caught as a promise nobody asked for", venues?.kind === "promise" && venues.missing.includes("venues"), venues);
  check("...even though the prompt's own examples mention venues (a promise stands on what was asked, not the instructions)", /venue/i.test(system));
  const studio = G.spokenProblem("Got it, Brightline Studio it is.", s);
  check("an unbacked studio name is caught", studio?.kind === "name" && studio.missing.some((m) => /Brightline/.test(m)), studio);
  check("an unbacked number is caught", G.spokenProblem("So about 80 people then.", s)?.kind === "number");
  check("a number has to be a whole one on record: the 20 inside a year, or a number in the prompt's own examples, backs nothing", G.spokenProblem("Is it still on November 20th?", src(body("It's set for 2026, sometime in November."))) ?.kind === "number" && /\b30\b/.test(system) && G.spokenProblem("So 30 people then.", s)?.kind === "number");
  check("their written-out number backs the digit (\"about sixty\" backs 60)", G.spokenProblem("60 is a good size for a talk.", src(body("We're expecting about sixty people."))) === null);
  check("only the context block counts as what Cue knows, not the guides that follow it without a heading", !/COACHING/.test(G.knownSections(system)) && /# What you know about Jordan/.test(G.knownSections(system)) && /# Right now/.test(G.knownSections(system)));
  check("an unbacked clock time places an event and is held, as before", G.spokenProblem("Let's say the walkthrough is at 3:45pm.", s)?.kind === "event");
  const asked = src(body("Can you look into venues near the studio for the dinner? It's Ellis Works."));
  check("the same venue promise passes when they asked for venues on the call", G.spokenProblem("I'll text you what I find on venues.", asked) === null, G.spokenProblem("I'll text you what I find on venues.", asked));
  const tooled = src(body(), '{"ok":true,"taskId":120,"goal":"Shortlist venues for the partner dinner"}');
  check("or when a tool started that work this turn", G.spokenProblem("I'll text you what I find on venues.", tooled) === null);
  check("an offer or a question is not a promise", !G.promisesLaterWork("Want me to look into venues?") && !G.promisesLaterWork("Should I text you a few venues?"));
  check("formats and everyday apps aren't treated as unknown names", G.spokenProblem("I'll put it in a Google Doc and send the PDF.", src(body("Can you send me the doc as a PDF?"))) === null, G.spokenProblem("I'll put it in a Google Doc and send the PDF.", src(body("Can you send me the doc as a PDF?"))));
  // The hot path: sources once per turn, a scan per sentence. No model.
  const t0 = performance.now();
  for (let k = 0; k < 200; k++) G.spokenProblem("Got it, Ellis Works, and the date stays open.", s);
  const per = (performance.now() - t0) / 200;
  // Bounds catch an order-of-magnitude regression, not a slow CI runner (2026-10-08: a busy runner measured 11ms for ~0.7ms work).
  check(`a sentence is checked in about a millisecond or less (${per.toFixed(3)}ms)`, per < 5);
  const t1 = performance.now();
  for (let k = 0; k < 20; k++) src();
  check(`a turn's sources are prepared in tens of milliseconds at most (${((performance.now() - t1) / 20).toFixed(2)}ms)`, (performance.now() - t1) / 20 < 60);
  check("the check is pure: no model and no database in offerGuard's spoken check", !/generateText|anthropic\(|pool\.query/.test(fs.readFileSync(new URL("../../src/services/offerGuard.ts", import.meta.url), "utf8")));
}

// ---- (a) through the endpoint: what reaches the voice
const text = (s: string, index = 0) => [
  { type: "content_block_start", index, content_block: { type: "text" } },
  ...(s.match(/.{1,6}/gs) ?? []).map((t) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index },
];
const toolEv = (id: string, name: string, args: string, index = 1) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args } },
  { type: "content_block_stop", index },
];
const scripted = (replies: any[][]) => { const reqs: any[] = []; let n = 0; return { reqs, stream: (r: any) => { reqs.push(JSON.parse(JSON.stringify(r))); const ev = replies[Math.min(n++, replies.length - 1)]; return (async function* () { for (const e of ev) yield e; })(); } }; };
const go = async (b: any, deps: any) => { const out: any[] = []; const spoken: string[] = [], dropped: string[] = []; for await (const c of P.runCallLlm(b, { onSpoken: (s: string) => spoken.push(s), onDropped: (s: string, w: string) => dropped.push(`${s} | ${w}`), ...deps })) out.push(c); return { spoken, dropped, content: out.map((c) => c.choices[0].delta.content ?? "").join("") }; };
{
  const live = await go(body(), { stream: scripted([text("Got it, Ellis Works, and the date stays open. I'll keep the planning doc moving with that in mind. I'll text you what I find on venues.")]).stream, tools: { defs: [], names: new Set(), note: CT.callToolsNote({ tasks, loops: null }, []), records, run: async () => ({ ok: true }) } });
  check("the live turn: 'Got it, Ellis Works' and the planning doc line reach the voice", /Got it, Ellis Works, and the date stays open\./.test(live.content) && /planning doc moving/.test(live.content), live.content);
  check("the live turn: the unasked venue promise doesn't", !/venues/i.test(live.content) && live.dropped.some((d) => /venues/.test(d) && /nobody asked for/.test(d)), live);
  // 2026-10-08 (Royce: "the model controls the response, no scripted lines"): a held line is never replaced with one written for Co.
  // Co answers again, once, in its own words, told what it couldn't back and, if they asked for it, to say it doesn't know.
  const unk = scripted([text("It's Harbor Lane Studio. They're great for dinners."), text("I don't have the studio's name on file, and I'd rather not guess.")]);
  const unknown = await go(body("What's the studio called again? I forgot."), { stream: unk.stream });
  check("unknown stays unknown: the unbacked name never reaches the voice; Cue says it doesn't know, in its own words", !/Harbor Lane/.test(unknown.content) && /don't have the studio's name/.test(unknown.content) && !/I'm not sure of the name\./.test(unknown.content), unknown);
  check("the retry tells Cue what it couldn't back and to say it doesn't know (they asked)", unk.reqs.length === 2 && JSON.stringify(unk.reqs[1].system).includes("names what nothing backs") && JSON.stringify(unk.reqs[1].system).includes("say plainly that you don't know it"));
  const tw = scripted([text("Maybe Harbor Lane Studio. Or Brightline Loft."), text("Maybe Harbor Lane again."), text("x")]);
  const twice = await go(body("Who else could host?"), { stream: tw.stream });
  check("one retry per turn, never a loop; if the retry is held too, one plain line, never silence", tw.reqs.length === 2 && !/Brightline|Harbor/.test(twice.content) && twice.content.trim().length > 0, twice.content);
  const nm = scripted([text("You said 85."), text("I don't have the number you gave me, so tell me again?")]);
  const num = await go(body("How many people did I say?"), { stream: nm.stream });
  check("an unbacked number never reaches the voice; Cue says so in its own words", !/85/.test(num.content) && /don't have the number/.test(num.content), num.content);
  const only = await go(body(), { stream: scripted([text("I'll text you what I find on venues.")]).stream });
  check("a turn that was only an unasked promise says a plain 'Got it.', never a new promise in its place", only.content.trim() === G.HELD_LINE && only.spoken.join(" ") === G.HELD_LINE, only);
  const ev = await go(body("Anything happening this week?"), { stream: scripted([text("There's a mixer at Foundry Hall on Friday.")]).stream });
  check("an unbacked event offer is still held with the safe line (unchanged)", ev.content.trim() === G.SAFE_LINE, ev.content);
  const backed = await go(body("We're doing about 60 people at Ellis Works."), { stream: scripted([text("Sixty at Ellis Works works well. 60 is a good size for a talk.")]).stream });
  check("backed names and numbers pass untouched", /Ellis Works works well\. 60 is a good size/.test(backed.content) && !backed.dropped.length, backed);
  // A tool result this turn backs what follows it.
  const up = scripted([[...text("On it."), ...toolEv("t1", "startTask", '{"goal":"Shortlist venues"}')], text("Started. I'll text you what I find on venues.")]);
  const withTool = await go(body("Yes, please look into venues for it."), { stream: up.stream, tools: { defs: [{ name: "startTask", description: "s", input_schema: { type: "object", properties: {} } }], names: new Set(["startTask"]), note: CT.callToolsNote({ tasks, loops: null }, []), records, run: async () => ({ ok: true, taskId: 120, goal: "Shortlist venues for the partner dinner" }) } });
  check("a promise about work a tool just started (and they asked for) is said", /what I find on venues/.test(withTool.content), withTool);
}

// ---- (b) a fact they give for an open task is written down
{
  check("the call guide says: a name, date, place or constraint for an open task goes on it with updateTask, this turn", /belongs to one of your open tasks \(a name, a date, a place, a number, a constraint/.test(CT.CALL_TOOLS_GUIDE) && /updateTask in this same turn/.test(CT.CALL_TOOLS_GUIDE) && /writes nothing down/.test(CT.CALL_TOOLS_GUIDE));
  check("and: unknown stays unknown, no unasked promises", /say you're not sure/.test(CT.CALL_TOOLS_GUIDE) && /never promise work they didn't ask for/.test(CT.CALL_TOOLS_GUIDE));
  check("the specifics in their words: Ellis Works", CT.specificsTheyGave(ELLIS).includes("Ellis Works"), CT.specificsTheyGave(ELLIS));
  const note = CT.taskFactNote(ELLIS, tasks);
  check("this turn's tools note makes the write expected: their specific, updateTask, now", !!note && /"Ellis Works"/.test(note) && /updateTask in this turn/.test(note), note);
  check("no open task, or nothing specific in their words: no note", CT.taskFactNote(ELLIS, []) === null && CT.taskFactNote("Sounds good, thanks.", tasks) === null);
  // The note rides after their words, past the cache breakpoint: the cached system block is the same with or without it.
  const up = scripted([text("Got it.")]);
  await go(body(), { stream: up.stream, tools: { defs: [], names: new Set(), note: CT.callToolsNote({ tasks, loops: null }, []), records, turnNote: note, run: async () => ({ ok: true }) } });
  const up2 = scripted([text("Got it.")]);
  await go(body(), { stream: up2.stream, tools: { defs: [], names: new Set(), note: CT.callToolsNote({ tasks, loops: null }, []), records, run: async () => ({ ok: true }) } });
  const last = up.reqs[0].messages[up.reqs[0].messages.length - 1];
  check("the note is the last block of their message, after the cached one", last.role === "user" && last.content[last.content.length - 1].text === note && last.content[last.content.length - 2].cache_control?.type === "ephemeral", last);
  check("the system block (cached) is unchanged by it", up.reqs[0].system[0].text === up2.reqs[0].system[0].text);

  // The backstop, through the real guard with a fake updateTask.
  const member = { phone: "", firstName: "Jordan", city: "San Francisco", tasks, loops: null };
  const writes: any[] = [];
  const raw = () => ({ updateTask: aiTool({ description: "update", inputSchema: z.object({ taskId: z.number(), note: z.string() }), execute: async (i: any) => { writes.push(i); return { ok: true }; } }) });
  const build = (turnWords = ELLIS) => CT.buildCallTools({ userId: "u-ellis", callKey: `u-ellis:${Math.random()}`, turnWords, callWords: turnWords, lastCoLine: null, member, dryRun: true, tools: raw() });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  // The live case: Co said "Got it, Ellis Works" and called no tool.
  await go(body(), { stream: scripted([text("Got it, Ellis Works, and the date stays open.")]).stream, tools: build() });
  await settle();
  check("Cue said the name back and wrote nothing: their own words go on task #119", writes.length === 1 && writes[0].taskId === 119 && writes[0].note === `On the call they said: "${ELLIS}"`, writes);
  check("the backstop records only the member's words, never Cue's", !/Got it|stays open/.test(writes[0]?.note ?? ""));
  writes.length = 0;
  // Co wrote it itself: no second write.
  const up3 = scripted([[...text("Got it."), ...toolEv("u1", "updateTask", '{"taskId":119,"note":"The studio is Ellis Works; the date is not locked."}')], text("Ellis Works is on the plan.")]);
  await go(body(), { stream: up3.stream, tools: build() });
  await settle();
  check("when Cue calls updateTask itself, the backstop does nothing more (one write, Cue's)", writes.length === 1 && /Ellis Works/.test(writes[0].note) && !/On the call they said/.test(writes[0].note), writes);
  writes.length = 0;
  // Co didn't take it up (said nothing about it): Co decides, nothing is written for it.
  await go(body(), { stream: scripted([text("Good. How's the rest of your week?")]).stream, tools: build() });
  await settle();
  check("Cue didn't say the specific back: nothing is written (guard the fact, not the intent)", writes.length === 0, writes);
  // Two open tasks, their words belong to neither by any shared word: nothing is written.
  const two = [{ id: 1, goal: "Find a photographer for the launch" }, { id: 2, goal: "Sponsor list for October" }];
  check("with several open tasks and no clear one, the backstop picks none", CT.taskFactBackstop({ turnWords: ELLIS, spoken: ["Got it, Ellis Works."], ran: [], tasks: two }) === null);
  check("with several, the one their words share a word with is picked", CT.taskFactBackstop({ turnWords: "The photographer is Noor Haddad.", spoken: ["Noor Haddad, got it."], ran: [], tasks: two })?.taskId === 1);
  check("a name the task already has isn't written again", CT.taskFactBackstop({ turnWords: "It's the design studio dinner.", spoken: ["The design studio dinner, got it."], ran: [], tasks }) === null);
}

// ---- the spoken line rules still hold on the replacement lines
for (const l of [G.UNSURE_NAME, G.UNSURE_NUMBER, G.HELD_LINE]) check(`"${l}" is speakable and narrates nothing`, S.speakable(l) === l && S.narratesInternalState(l) === null);

// ---- 2026-10-08 live call: "Should I keep sending PDFs for now?" was replaced with "I'm not sure of the name."
{
  const s2 = src();
  check("a plural of an everyday word is backed ('PDFs')", G.spokenProblem("Should I keep sending PDFs for now?", s2) === null, G.spokenProblem("Should I keep sending PDFs for now?", s2));
  check("a plural of a backed name is backed", G.spokenProblem("I'll keep the Google Docs for you.", s2) === null);
  const proxy = fs.readFileSync(new URL("../../src/services/callLlmProxy.ts", import.meta.url), "utf8");
  check("no line is written for Cue: the proxy never substitutes a sentence for a held one", !/UNSURE_NAME|UNSURE_NUMBER/.test(proxy.replace(/^import .*$/m, "")) && /Answer them again, in your own words, without it/.test(proxy));
}
console.log(`spokenGrounding: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
