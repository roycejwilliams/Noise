// The call fix (Royce, 2026-10-08, after a 10-call eval: 4 of 9 outbound calls opened with Co's homework, 5 of 10 asked two
// questions in a turn, and em dashes reached the voice on the direct path). Zero tokens:
//   1. one item, said once: the promise, the open loop and the recap about the same deliverable collapse into one line; what they
//      already have is marked "they have it" and kept out of "where things stand"
//   2. the voice-only endpoint: a dash becomes a full stop, a turn ends at its first question, nothing is held back or added
//   npx tsx evals/calls/contextAndVoice.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const CC = await import("../../src/services/callContext.js");
const P = await import("../../src/services/callLlmProxy.js");
const E = await import("../../src/services/elevenLabsCalls.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const day = () => "Oct 8";

// ---- 1. the context: one item once; what they have, apart
{
  const lines = [
    { text: "Oct 7: Promised on the call: draft and text a plan on Cue's post-event presence. Sent.", from: "promise" as const, sent: true },
    { text: "Oct 7: Promised on the call: text the drafted planning document. Not sent yet.", from: "promise" as const, sent: false },
    { text: "Keep your word from the call: the plan for how Cue keeps its presence after the Sequin AI November event: in progress (document finalized, send blocked until hours resume)", from: "loop" as const },
    { text: "Find a caterer for the November open house: searching, 2 options so far", from: "loop" as const },
  ];
  const r = CC.collapseCarried(lines, [{ title: "Cue Presence Plan: After the Sequin AI November Event", at: new Date("2026-10-08T16:00:00Z") }], day);
  check("a sent deliverable leaves 'where things stand' (promise, its loop and the not-sent line all go)", !r.open.some((l) => /presence|planning document/i.test(l.text)), r.open);
  check("...and appears once, as something they have, with when", r.theyHaveIt.length === 1 && /Cue Presence Plan/.test(r.theyHaveIt[0]) && /sent Oct 8/.test(r.theyHaveIt[0]), r.theyHaveIt);
  check("an open, different item stays where things stand", r.open.length === 1 && /caterer/.test(r.open[0].text));
  check("a recap or thread sentence about what they have is covered (dropped from the context)", r.covered("Royce discussed the finished post-event presence doc, which will be sent to Royce's texts the next morning.") && !r.covered("Royce is stressed about what's next after building Cue."));
  // Review of #110: never drop what Co still owes, or the member's own life.
  const owed = CC.collapseCarried([
    { text: "Oct 5: Promised on the call: send the restaurant shortlist. Sent.", from: "promise" as const, sent: true },
    { text: "Oct 5: Promised on the call: draft the investor update email outline. Not sent yet.", from: "promise" as const, sent: false },
  ], [], day);
  check("a different deliverable promised the same day stays open (the same-call rule is only for rewordings)", owed.open.some((l) => /investor update/.test(l.text)), owed.open);
  const place = CC.collapseCarried([{ text: "find a pitch coach in San Francisco: research started", from: "loop" as const }], [{ title: "San Francisco dinner options for Friday", at: new Date() }], day);
  check("a shared place name never matches two different things", place.open.length === 1);
  const own = CC.collapseCarried([], [{ title: "Investor meeting prep brief", at: new Date() }, { title: "SF dinner options", at: new Date() }], day);
  check("the member's own deck and plans are never removed from threads or recap", !own.covered("Their pitch deck for the investor meeting on Thursday is nearly done.") && !own.covered("putting together a plan for their mom's birthday dinner in San Francisco Friday."));
  const dup = CC.collapseCarried([
    { text: "Oct 9: Promised on the call: send three private dining options near Hayes Valley. Not sent yet.", from: "promise" as const, sent: false },
    { text: "Keep your word: send three private dining options near Hayes Valley for the 20th: searching, 1 option verified", from: "loop" as const },
  ], [], day);
  check("an open promise and its loop collapse into one line (the more specific)", dup.open.length === 1 && /1 option verified/.test(dup.open[0].text), dup.open);
  const summary = CC.assembleCallSummary({ haveIt: r.theyHaveIt.join("\n"), now: "- Find a caterer: searching", lastCalls: null, settled: null, lessons: [], sentLines: [], threads: [], base: "Who they are:\nruns a studio" });
  check("'they have it' sits after what's current, marked never a reason to call or an opener; raised only if changed, asked, or it answers what they just said (#114)", summary.indexOf("Where things stand now") < summary.indexOf("They already have these") && /never a reason to call or an opener/.test(summary) && /changed since they last heard about it, they ask, or it directly answers what they just said/.test(summary), summary);
  check("the call prompt says the same", /never why you called and never how you open/.test(E.CALL_GUIDE));
  check("the builder uses it: receipts and sent promises collapse; threads, recap and last calls drop what's covered", /collapseCarried\(/.test(src("services/callContext.ts")) && /!carried\.covered\(t\.text\)/.test(src("services/callContext.ts")) && /!carried\.covered\(s\)/.test(src("services/callContext.ts")) && /filter\(\(x\) => !carried\.covered\(x\)\)/.test(src("services/callContext.ts")));
}

// ---- 1b. the call reads the one member-knowledge layer (services/memberKnowledge.ts, PR 4)
{
  const MK = await import("../../src/services/memberKnowledge.js");
  const asOf = "2026-10-09T18:00:00.000Z";
  const hoursAgo = (h: number) => new Date(Date.parse(asOf) - h * 3_600_000).toISOString();
  const k: any = {
    userId: "u", asOf, identity: { firstName: "Jordan", city: "SF", zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: asOf },
    goals: [
      { text: "raise a seed round", state: "active", reason: null, told: true, verifiedAt: asOf },
      { text: "land the first paying customer", state: "done", reason: "they closed it", told: true, verifiedAt: asOf },
      { text: "move to Austin", state: "stale", reason: null, told: true, verifiedAt: asOf },
    ],
    asks: [1, 2, 3, 4, 5].map((i) => ({ id: String(i), text: `ask ${i}`, kind: "find", verifiedAt: asOf })),
    corrections: [{ field: "goals", was: "first paying customer", now: "Series A", verifiedAt: hoursAgo(30) }],
    exchanges: [
      { from: "member", text: "old news from last week", call: false, verifiedAt: hoursAgo(120) },
      { from: "co", text: "Here's the plan", call: false, verifiedAt: hoursAgo(10) },
      { from: "co", text: "Jordan talked about Series A", call: true, verifiedAt: hoursAgo(5) },
      { from: "member", text: "we closed the Series A", call: false, verifiedAt: hoursAgo(2) },
    ],
    delivered: [{ what: "Cue Presence Plan: After the Sequin AI November Event", kind: "document", at: "2026-10-08T16:00:00.000Z", via: ["receipt"], url: null, reaction: null, verifiedAt: "2026-10-08T16:00:00.000Z" }, { what: "Oakland Join-Up", kind: "event", at: asOf, via: ["offer"], url: null, reaction: null, verifiedAt: asOf }],
    carrying: [
      { what: "draft and text a plan on Cue's post-event presence", kind: "promise", state: "done", told: true, theyHaveIt: true, dueAt: null, ref: null, status: null, detail: null, verifiedAt: "2026-10-07T20:00:00.000Z" },
      { what: "send the restaurant shortlist", kind: "promise", state: "done", told: true, theyHaveIt: true, dueAt: null, ref: null, status: null, detail: null, verifiedAt: "2026-10-06T20:00:00.000Z" },
      { what: "find a pitch coach", kind: "promise", state: "outstanding", told: true, theyHaveIt: false, dueAt: null, ref: null, status: null, detail: null, verifiedAt: "2026-10-08T20:00:00.000Z" },
      { what: "Plan the partner event", kind: "task", state: "outstanding", told: true, theyHaveIt: false, dueAt: null, ref: "task #7", status: null, detail: null, verifiedAt: asOf },
    ],
    lessons: [], preferences: [], claims: [], person: null, restraint: null,
  };
  const parts = CC.partsFromKnowledge(k);
  check("calls read goals with state: a done or stale goal is never direction (the known gap)", parts.goals.length === 1 && parts.goals[0] === "raise a seed round", parts.goals);
  check("their own words are the last 48 hours (their lines and call summaries), oldest first; older lines aren't", parts.ownWords.length === 2 && /^\[Call\]/.test(parts.ownWords[0]) && parts.ownWords[1] === "- we closed the Series A", parts.ownWords);
  check("recent texts newest first, in the stored shapes; open asks at most four", parts.recentTexts[0] === "User said: we closed the Series A" && parts.recentTexts.includes("Co replied: Here's the plan") && parts.openAsks.length === 4);
  check("corrections become the rows the settled/retired rules read", parts.corrections[0].old_value === "first paying customer" && parts.corrections[0].new_value === "Series A" && !!CC.retiredBy("figuring out the first paying customer", parts.corrections));
  const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
  const { promises, delivered } = CC.callCarriedInputs(k, day);
  check("only documents are what they have (an event Cue offered isn't)", delivered.length === 1 && /Cue Presence Plan/.test(delivered[0].title));
  const covered = promises.find((p) => /post-event presence/.test(p.text));
  const sent = promises.find((p) => /restaurant shortlist/.test(p.text));
  const open = promises.find((p) => /pitch coach/.test(p.text));
  check("a handled promise a delivery covers stays unsent (the delivery is what they have, said once); one that went is 'Sent.'; an open one isn't", covered?.sent === false && sent?.sent === true && /Sent\.$/.test(sent.text) && open?.sent === false && /Not sent yet\.$/.test(open.text), promises);
  const carried = CC.collapseCarried(promises, delivered, day);
  check("...and collapse as before: only the open promise is where things stand; the delivered plan once, as theirs", carried.open.length === 1 && /pitch coach/.test(carried.open[0].text) && carried.theyHaveIt.filter((l) => /Presence Plan/.test(l)).length === 1, carried);
  check("a task Cue carries is never one of the call's promises", !promises.some((p) => /partner event/.test(p.text)));
  const late = { ...k, asOf: "2026-10-10T06:30:00.000Z", restraint: MK.restraintOf({ holdUntil: null, spaceUntil: null, safetyHold: false, emotional: null, suppressed: ["event_offer"] as any, trial: [], lastInboundAt: null, unansweredSends: [] }, new Date("2026-10-10T06:30:00.000Z")) };
  const block = CC.callRulesBlock(MK.memberRules(late)) ?? "";
  check("the member rules ride on the call: quiet hours in their zone (inside them now) and restraint, from memberRules(k)", /Quiet hours/.test(block) && /inside their quiet hours/.test(block) && /event_offer/.test(block) && block.includes(MK.memberRules(late).restraint), block);
  const prompt = E.promptForElevenLabs("You are Cue.");
  const rules = MK.memberRules(k);
  check("the agent's prompt carries the same shared rules memberRules returns (discretion, grounding, member safety), not copies", prompt.includes(rules.discretion) && prompt.includes(rules.grounding) && prompt.includes(rules.memberSafety));
  check("the builder reads the layer once and keeps the call-only parts (last calls, threads, capacity, finds)", /loadContextParts\(userId, CALL_KNOWLEDGE, \{\}, knowledge\)/.test(src("services/callContext.ts")) && /offers: \(\) => sentItems/.test(src("services/callContext.ts")) && !/assembleContext\(/.test(src("services/callContext.ts")) && !/FROM document_deliveries|pgReceipts|memory_type = 'promise_result'/.test(src("services/callContext.ts")) && /k\.carrying\.filter\(\(c\) => c\.ref\?\.startsWith\("task #"\)\)/.test(src("services/callContext.ts")));
}

// ---- 2. the voice-only endpoint
{
  const text = (s: string) => {
    const evs: any[] = [{ type: "message_start" }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }];
    for (const piece of s.match(/.{1,12}/gs) ?? []) evs.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
    evs.push({ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" });
    return evs;
  };
  let seenReq: any = null;
  const spy = (events: any[]) => (r: any) => { seenReq = r; return (async function* () { for (const e of events) yield e; })(); };
  const body = { model: "x", stream: true, messages: [{ role: "system", content: "You are Cue. # What you know about Jordan\nnothing" }, { role: "user", content: "my mentor died this week" }], tools: [{ type: "function", function: { name: "end_call", parameters: {} } }] } as any;
  const run = async (reply: string, deps: any = {}) => {
    let out = "";
    for await (const c of P.runCallLlm(body, { stream: spy(text(reply)), voiceOnly: true, ...deps })) out += (c.choices[0].delta as any).content ?? "";
    return out.trim();
  };
  const dashed = await run("[softly] Losing someone who believed in you early on — that's its own kind of grief. Take your time.");
  check(`voice-only: an em dash never reaches the voice ("${dashed}")`, !/[—–]/.test(dashed) && /early on\. That's its own kind of grief\./.test(dashed));
  // Review of #110: only a second QUESTION is dropped; statements after the question stay (answers aren't cut).
  const two = await run("A month in, new city, new job. What's the work like day to day? I'm curious what drew you to climate. What made you pick it?");
  check(`voice-only: a second question is dropped, the statement after the first stays ("${two}")`, /day to day\?/.test(two) && /curious what drew you to climate\./.test(two) && !/pick it/.test(two));
  const echo = await run("The dinner? It's Friday at seven, at Nopa.");
  check(`voice-only: an echo question never cuts the answer ("${echo}")`, /Friday at seven/.test(echo));
  const rhet = await run("Honestly? I think you should go. What's holding you back?");
  check(`voice-only: a one-word rhetorical question isn't the turn's question ("${rhet}")`, /What's holding you back\?/.test(rhet));
  // Royce's ruling (2026-11-07): decided by meaning, not by the opener. A follow-on the model reads as asking for the same answer is the
  // turn's question and is said (services/questionRead.ts); one asking for a different answer is a second question and is held.
  const twoQ = await run("What kind of messages are you getting? Like, people wanting to come, or something else?", { sameQuestion: async () => true });
  check(`voice-only: a follow-on read as the same question is said ("${twoQ}")`, /messages are you getting\?/.test(twoQ) && /people wanting to come, or something else\?/.test(twoQ));
  const otherQ = await run("What kind of messages are you getting? Like, who's sending most of them?", { sameQuestion: async () => false });
  check(`voice-only: never two different questions in one turn, whatever the opener ("${otherQ}")`, (otherQ.match(/\?/g) ?? []).length === 1 && !/who's sending/.test(otherQ));
  const noRead = await run("What kind of messages are you getting? Like, people wanting to come, or something else?");
  check(`voice-only: with no read, still one question ("${noRead}")`, (noRead.match(/\?/g) ?? []).length === 1);
  const safety = await run("Are you safe right now? If you're not, call or text 988, any time. I'm staying right here with you.");
  const lifeline = await run("Are you safe right now? If not, please reach out to the crisis lifeline by calling nine eight eight. Is someone with you tonight?");
  check(`voice-only: a safety turn has no question limit and keeps every help line ("${lifeline}")`, /nine eight eight/.test(lifeline) && /someone with you tonight\?/.test(lifeline));
  check(`voice-only: a safety line after the question is never cut ("${safety}")`, /988/.test(safety) && /Are you safe right now\?/.test(safety));
  {
    const { SAFETY_TURN } = await import("../../src/services/callLlmProxy.js");
    const notSafety = ["it all felt a little... safe? Like I wasn't pushing myself", "we played it safe with the menu", "safe to say it went well", "no harm in asking", "the money is safe in savings", "I can't wait for Saturday", "it ended up fine", "I can't do this Friday", "I can't do this weekend", "I'm cutting back on drinking", "we're cutting the guest list", "my allergy pills", "that's not okay with me, the price", "I'm ending things with Sam", "we'll end it with dessert", "did you miss me?", "my feet are killing me", "my startup is killing me", "my mom would kill me", "my weekend disappeared", "get home safe", "drive safe", "stay safe", "is it safe to go there at night?", "I don't want to be here for the speeches", "I can't keep going to these mixers", "you're safe to skip it", "I'm safe on time", "is there a safe place to park?", "it's a safe bet they'll come", "the caterer is a safe pick", "we're safe on budget", "that's a safe choice for the menu"];
    const safety = ["I'm safe tonight, just tired", "I don't feel safe at home", "sometimes I wonder if anyone would notice if I disappeared", "I've thought about hurting myself", "everyone would be better off without me", "I feel unsafe", "I don't feel safe", "I didn't feel safe", "I wouldn't feel safe going home", "I haven't felt safe in weeks", "he might harm me", "I could harm someone", "Are you somewhere safe?", "Do you have somewhere safe to go tonight?", "Can you get somewhere safe?", "I don't want to be here anymore", "I want to die", "I can't do this anymore", "no one would care if I was gone", "I'm not okay", "thinking of ending things", "I've been cutting", "I took a bunch of pills", "I don't want to live", "I'm going to end my life", "nobody would miss me", "there's no way out", "Are you thinking about ending your life?", "I wish I was dead", "I'm a burden", "I keep having dark thoughts", "my partner hit me", "he'll harm the kids", "I just want to end it", "I want to disappear", "I'd rather not be here", "I do not feel safe", "I don't really feel safe", "I can't keep myself safe", "I don't think I can stay safe tonight", "Will you be safe tonight?", "Do you think I'll be safe?", "I don't know if I'll make it through the night", "I wrote a goodbye note", "I just want to sleep forever", "I'm scared of what I might do to myself", "I bought a gun"];
    check(`a bare "safe" never lifts the question limit (2026-10-08 new_member call): ${notSafety.filter((x) => SAFETY_TURN.test(x)).join(" | ") || "none"}`, notSafety.every((x) => !SAFETY_TURN.test(x)));
    check(`real safety talk still lifts it: missed ${safety.filter((x) => !SAFETY_TURN.test(x)).join(" | ") || "none"}`, safety.every((x) => SAFETY_TURN.test(x)));
    const { safetyCall } = await import("../../src/services/callLlmProxy.js");
    const call = (msgs: [string, string][]) => safetyCall({ messages: msgs.map(([role, content]) => ({ role, content })) });
    check("a safety call stays one: an earlier \"I don't feel safe\" lifts the limit on a later turn the pattern alone would miss", call([["user", "I don't feel safe"], ["assistant", "Are you safe right now?"], ["user", "I guess, it's just a lot"]]));
    check("Cue's own help line earlier in the call makes it a safety call", call([["user", "it's been heavy"], ["assistant", "You can call or text 988, any time."], ["user", "yeah"]]));
    check("an iPhone's curly apostrophe reads the same on a call (review of #283)", call([["user", "I don\u2019t want to live anymore"], ["assistant", "I\u2019m here."], ["user", "yeah"]]) && call([["user", "I can\u2019t go on"]]));
    check("an ordinary call is not a safety call", !call([["user", "we played it safe with the menu"], ["assistant", "Smart. What's the headcount?"], ["user", "about forty, drive safe tonight"]]));
  }
  const stock = await run("Don't worry about the time. And I hear you. Feeling invisible in a full room is its own kind of tired. When did it start?");
  check(`voice: a sentence that's only a stock phrase isn't said, the rest is ("${stock}")`, !/hear you/i.test(stock) && /invisible in a full room/.test(stock) && /When did it start\?/.test(stock));
  const stockLead = await run("[softly] I hear you. Going through the motions while nobody sees you wears you down.");
  check(`voice: a stock phrase leading a reply is dropped too ("${stockLead}")`, !/hear you/i.test(stockLead) && /Going through the motions/.test(stockLead));
  const stockSpecific = await run("I hear you, and the part about Sam leaving the studio is the piece I'd sit with.");
  check(`voice: a sentence that goes on to say something specific is kept whole ("${stockSpecific}")`, /I hear you, and the part about Sam/.test(stockSpecific));
  const stockOnly = await run("I hear you.");
  check(`voice: a reply that's only a stock phrase is still said, never silence ("${stockOnly}")`, /I hear you\./.test(stockOnly));
  const stockQ = await run("Ugh. What's actually going on with you?");
  check(`voice: a stock-phrased question is never dropped, it may be the turn's only one ("${stockQ}")`, /going on with you\?/.test(stockQ));
  const stockNo = await run("I hear you, but no. That one I'd skip.");
  check(`voice: a stock phrase with anything else in the sentence is kept ("${stockNo}")`, /I hear you, but no\./.test(stockNo));
  {
    // "I hear you." then end_call: said before the hang-up, never silence (review of #112).
    const evs = text("I hear you.").filter((e: any) => e.type !== "message_delta" && e.type !== "message_stop");
    evs.push({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "end_call" } }, { type: "content_block_stop", index: 1 }, { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" });
    const order: string[] = [];
    for await (const c of P.runCallLlm({ ...body, messages: [body.messages[0], { role: "user", content: "ok, I have to go. bye" }] }, { stream: spy(evs), voiceOnly: true })) {
      const d: any = c.choices[0].delta;
      if (d.content) order.push(`say:${d.content.trim()}`);
      if (d.tool_calls?.[0]?.function?.name) order.push(`tool:${d.tool_calls[0].function.name}`);
    }
    check(`voice: a stock-only reply before end_call is said first, not a silent hang-up (${order.join(" | ")})`, order[0] === "say:I hear you." && order.includes("tool:end_call"));
  }
  {
    // Co never hangs up first (Royce, #113): end_call passes only after their goodbye, or their reply to Co's goodbye.
    const ending = (reply: string) => {
      const evs = text(reply).filter((e: any) => e.type !== "message_delta" && e.type !== "message_stop");
      evs.push({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "end_call" } }, { type: "content_block_stop", index: 1 }, { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" });
      return evs;
    };
    const ends = async (messages: any[], reply: string) => {
      let ended = false, said = "";
      for await (const c of P.runCallLlm({ ...body, messages }, { stream: spy(ending(reply)), voiceOnly: true })) {
        const d: any = c.choices[0].delta;
        if (d.tool_calls?.[0]?.function?.name === "end_call") ended = true;
        said += d.content ?? "";
      }
      return { ended, said: said.trim() };
    };
    const sys = { role: "system", content: "You are Cue." };
    const held = await ends([sys, { role: "user", content: "Get me some solid options and we can go from there." }], "Talk soon, Jordan. Take care.");
    check(`Cue's own goodbye is said, but the call stays open until theirs ("${held.said}", ended ${held.ended})`, !held.ended && /Talk soon/.test(held.said));
    const thanks = await ends([sys, { role: "user", content: "Thanks for calling. And for listening." }], "Of course. Take care of yourself this week.");
    check("\"thanks for calling\" isn't their goodbye yet: the call stays open", !thanks.ended);
    const theirBye = await ends([sys, { role: "user", content: "Alright, I should probably get going. Talk soon!" }], "Talk soon, Jordan.");
    check("after their goodbye, end_call goes through", theirBye.ended);
    const afterCo = await ends([sys, { role: "user", content: "Okay, I have to go, bye" }, { role: "assistant", content: "Take care, Jordan." }, { role: "user", content: "you too" }], "");
    check("their reply to Cue's goodbye (answering their own goodbye) lets the call end", afterCo.ended);
    const guessed = await ends([sys, { role: "user", content: "anyway" }, { role: "assistant", content: "Take care, Jordan." }, { role: "user", content: "you too" }], "");
    check("a goodbye Cue guessed at plus any reply does not end the call (Royce, 2026-11-04)", !guessed.ended);
    const looseCo = await ends([sys, { role: "user", content: "alright, I should go, talk soon" }, { role: "assistant", content: "Enjoy tonight, bye!" }, { role: "user", content: "you too" }], "Night.");
    check("a goodbye in Cue's own words (\"Enjoy tonight, bye!\") then their reply ends the call, never dead air", looseCo.ended);
    {
      // A bare end_call mid-call is held too, and Co answers them instead: the second model call is the answer (never dead air).
      const calls: any[] = [];
      const first = ending("").filter((e: any) => !(e.type === "content_block_delta"));
      const answer = text("So which caterer felt closest?");
      const stream = (r: any) => { calls.push(r); const evs = calls.length === 1 ? first : answer; return (async function* () { for (const e of evs) yield e; })(); };
      let ended = false, said = "";
      for await (const c of P.runCallLlm({ ...body, messages: [sys, { role: "user", content: "ok, I need to think about the caterers" }] }, { stream, voiceOnly: true })) {
        const d: any = c.choices[0].delta;
        if (d.tool_calls?.[0]?.function?.name === "end_call") ended = true;
        said += d.content ?? "";
      }
      check(`a bare end_call before their goodbye is held, and Cue answers instead ("${said.trim()}")`, !ended && /which caterer/.test(said) && calls.length === 2 && /haven't said goodbye/.test(JSON.stringify(calls[1].system)));
    }
    const { memberClosed } = P as any;
    const closes = ["Later!", "I'm off, thanks Cue", "gotta jet", "Night!", "Peace.", "Cheers, Cue.", "ttyl", "That's it for now.", "ok bye", "Nope, later!", "No that's all, thanks", "Nah I'm good, night", "All good, cheers"];
    const opens = ["I'll go with the first one.", "I need to go to Paris next week for work.", "better go with the cheaper one", "Let you go ahead and book it.", "Thanks for calling. And for listening.", "I'm off work tomorrow so I could do lunch.", "Later this week works.", "I'm good with the second option, what do you think about the photographer though?", "Thanks.", "No, that's not what I meant."];
    check(`their closings are heard: missed ${closes.filter((x) => !memberClosed(x)).join(" | ") || "none"}`, closes.every((x) => memberClosed(x)));
    check(`mid-thought words never lift the hold: ${opens.filter((x) => memberClosed(x)).join(" | ") || "none"}`, opens.every((x) => !memberClosed(x)));
  }
  {
    // An inbound call's first reply ends at its question to them: they lead (2026-10-08 call eval, casual_hello).
    const inb = { ...body, messages: [{ role: "system", content: "You are Cue. This call is inbound." }, { role: "assistant", content: "Hey Jordan, it's Cue." }, { role: "user", content: "hey Cue, what's up" }] };
    let said = "";
    for await (const c of P.runCallLlm(inb, { stream: spy(text("Good, glad you called. What's on your mind? You've got the open house coming up in a few weeks.")), voiceOnly: true })) said += (c.choices[0].delta as any).content ?? "";
    check(`inbound first reply: nothing after its question to them ("${said.trim()}")`, /What's on your mind\?$/.test(said.trim()) && !/open house/.test(said));
    const asked = { ...inb, messages: [inb.messages[0], inb.messages[1], { role: "user", content: "hey, did you find a caterer?" }] };
    let answer = "";
    for await (const c of P.runCallLlm(asked, { stream: spy(text("Did I find a caterer for the open house? Yes, two good ones in Nopa.")), voiceOnly: true })) answer += (c.choices[0].delta as any).content ?? "";
    check(`inbound first reply to their own question keeps the answer ("${answer.trim()}")`, /two good ones in Nopa/.test(answer));
    const { asksCo } = P as any;
    check("a greeting's own question isn't asking Cue something; a real question is", !asksCo("hey Cue, what's up?") && !asksCo("Hey! How's it going? How are you doing?") && asksCo("hey, did you find a caterer?") && asksCo("what's up, when is the open house again?") && asksCo("hey what's up with the caterer") && asksCo("hey when's the open house again") && !asksCo("yo what's up Cue?") && !asksCo("hey Cue, what's up"));
    let later = "";
    const inb2 = { ...inb, messages: [...inb.messages, { role: "assistant", content: "What's on your mind?" }, { role: "user", content: "the caterer" }] };
    for await (const c of P.runCallLlm(inb2, { stream: spy(text("Which one? The Nopa folks were good.")), voiceOnly: true })) later += (c.choices[0].delta as any).content ?? "";
    check(`later turns keep statements after a question ("${later.trim()}")`, /Nopa folks/.test(later));
  }
  {
    // Review of #114: "today (Oct 8):" / "yesterday (Oct 7):" labels still collapse a same-day promise the receipt covers.
    const C = await import("../../src/services/callContext.js");
    for (const label of ["Oct 7", "today (Oct 8)", "yesterday (Oct 7)"]) {
      const day = label.match(/[A-Z][a-z]{2} \d{1,2}/)![0];
      const r = (C as any).collapseCarried([{ text: `${label}: Promised on the call: text the drafted planning document. Not sent yet.`, from: "promise" }], [{ title: "Planning document", at: new Date() }], () => day);
      check(`a same-day promise the receipt covers collapses with a "${label}" label`, r.open.length === 0, r);
    }
  }
  {
    // Royce's call, 2026-10-08: "Done, I'll send that over now." and nothing went out. Since 2026-10-29 Cue can send on a call, but a
    // send said as it happens ("I'll send that over now") is never true in the turn's words: dropped whole, the rest stays.
    const done = await run("Done, I'll send that over now. That one feels right for where you're at.");
    check(`a send said as it happens is dropped with its "Done,"; the rest stays ("${done}")`, /^That one feels right for where you're at\./.test(done) && !/\bDone\b/.test(done) && !/send that over/.test(done));
    const sent = await run("I just sent it to you. It's the run on Saturday.");
    check(`a sentence claiming a send is dropped ("${sent}")`, !/sent it/.test(sent) && /run on Saturday/.test(sent));
    const truth = await run("I'll text it to you right after we hang up.");
    check("the truth (after we hang up) stays", /right after we hang up/.test(truth));
    const { countsAsQuestion, insistsAfterPushback } = P as any;
    check("a short real question counts as the turn's one; an interjection or echo doesn't", countsAsQuestion("What changed?") && countsAsQuestion("Why not?") && countsAsQuestion("Did you?") && !countsAsQuestion("Honestly?") && !countsAsQuestion("Right?") && !countsAsQuestion("The dinner?"));
    const twoShort = await run("That's a big send. What changed? Did something just feel different or did you figure out a move?");
    check(`"What changed?" then another question: the second is dropped ("${twoShort}")`, /What changed\?$/.test(twoShort));
    check("after they say they didn't say it, Cue never insists they did", insistsAfterPushback("Um, actually I don't think I mentioned the dinner party thing", "You did actually say that, back when we talked through the open house plan.") && !insistsAfterPushback("yeah that's right", "You did actually say that."));
    const pushed = { ...body, messages: [{ role: "system", content: "You are Cue." }, { role: "user", content: "I don't think I mentioned the dinner party thing, but yeah." }] };
    let said = "";
    for await (const c of P.runCallLlm(pushed, { stream: spy(text("You did actually say that, back when we talked. Intimate it is, then.")), voiceOnly: true })) said += (c.choices[0].delta as any).content ?? "";
    check(`the insisting sentence is dropped, the rest is said ("${said.trim()}")`, !/You did/.test(said) && /Intimate it is/.test(said));
  }
  const named = await run("Your mentor Richard sounds like he was rare. What did he see in you?");
  check("voice-only: nothing is held back for an unbacked name (no fact check in this mode)", /Richard/.test(named));
  check("voice-only: no tools and no turn notes are added to the request", (seenReq?.tools ?? []).every((t: any) => t.name === "end_call") && !/This turn: they told you how they are/.test(JSON.stringify(seenReq?.system ?? "")));
  check("the endpoint takes the mode from the agent's header and skips Cue's tools in it", /req\.headers\["x-co-mode"\]/.test(src("routes/callLlm.ts")) && /userId && !voiceOnly && process\.env\.CALL_TOOLS/.test(src("routes/callLlm.ts")));
  const cfg: any = E.buildAgentConfig({ name: "t", prompt: "p", voiceId: "v", apiUrl: "https://x.test", proxy: { url: "https://x.test/co/el/llm", secretId: "s", voiceOnly: true } });
  check("the agent sends the voice-only header to the endpoint", cfg.conversation_config.agent.prompt.custom_llm.request_headers?.["x-co-mode"] === "voice");
  check("the push script sets it with ELEVENLABS_LLM_PROXY=voice", /ELEVENLABS_LLM_PROXY === "voice"/.test(src("scripts/pushElevenLabsAgent.ts")));
}

console.log(`call context + voice: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
