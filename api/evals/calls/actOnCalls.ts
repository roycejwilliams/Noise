// Cue acts during calls (Royce, 2026-10-29: "on certain things Cue should follow up immediately with the action over the phone").
// Layer 1: the model, the tools, the texts and the database are all stubbed; zero tokens, no network.
//   npx tsx evals/calls/actOnCalls.ts
// What it holds:
//   1. the call allow-list is enforced in code: quick and certain tools run now, decks/docs/pages after, intros and paid things never
//   2. "just sent it" is said only after the send came back done; "sending it now" never; a failed or slow send is owed
//   3. a slow tool falls back inside its own timeout instead of holding the call
//   4. what's owed goes out the moment the call ends (the actual link), and nothing done on the call is done again after it, by a
//      promise task or in the reflection text; the audit holds "I sent it" to what the tools really did
//   5. each proxy turn writes its latency as a decision (numbers and tool names, no words), and ElevenLabs' own per-turn numbers too
//   6. a voice-read stop still takes the voice lines out of the next turn on a proxy call, even when its write is slow
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const { z } = await import("zod");
const { tool: aiTool } = await import("ai");
const P = await import("../../src/services/callLlmProxy.js");
const CT = await import("../../src/services/callTools.js");
const CAP = await import("../../src/services/capabilities.js");
const L = await import("../../src/services/callLedger.js");
const FT = await import("../../src/services/callFollowThrough.js");
const CC = await import("../../src/services/callCommitments.js");
const G = await import("../../src/harness/callGrounding.js");
const LAT = await import("../../src/services/callLatency.js");
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
(await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const text = (s: string, index = 0) => [
  { type: "content_block_start", index, content_block: { type: "text" } },
  ...(s.match(/.{1,6}/gs) ?? []).map((t) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index },
];
const tool = (id: string, name: string, args: string, index = 1) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name } },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args } },
  { type: "content_block_stop", index },
];
const scripted = (replies: any[][]) => { const reqs: any[] = []; let n = 0; return { reqs, stream: (r: any) => { reqs.push(JSON.parse(JSON.stringify(r))); const ev = replies[Math.min(n++, replies.length - 1)]; return (async function* () { for (const e of ev) yield e; })(); } }; };
const body = () => ({
  model: "x",
  stream: true,
  messages: [
    { role: "system", content: "You are Cue, on a call with Jordan.\n# What Cue has found for them\n- Rooftop Jazz Night | starts tomorrow 7pm | link on file (offer to text it)" },
    { role: "assistant", content: "Hey Jordan, it's Cue." },
    { role: "user", content: "Can you text me that jazz thing?" },
  ],
});
const go = async (deps: any) => { const out: any[] = []; const spoken: string[] = []; const dropped: string[] = []; for await (const c of P.runCallLlm(body() as any, { onSpoken: (s: string) => spoken.push(s), onDropped: (s: string, w: string) => dropped.push(`${s} | ${w}`), ...deps })) out.push(c); return { spoken, dropped, content: out.map((c) => c.choices[0].delta.content ?? "").join("") }; };
const member = { phone: "+14155550123", firstName: "Jordan", city: "San Francisco", tasks: [], loops: null } as any;
const JAZZ = { name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", caption: "Rooftop Jazz Night, tomorrow 7pm" };

// ---------------------------------------------------------------- 1. the allow-list, in code
{
  const names = new Set(CT.CALL_TOOL_NAMES);
  const want = Object.keys(CAP.CALL_RUN).filter((t) => CAP.ABILITIES.some((a) => a.tool === t && a.onCall));
  check("1. the call's tools are exactly the allow-list (registry onCall entries on CALL_RUN)", names.size === want.length && want.every((t) => names.has(t)), { names: [...names], want });
  check("1. every onCall registry tool has a call rule, and nothing on a call lacks one", CAP.ABILITIES.filter((a) => a.onCall && a.tool).every((a) => !!CAP.CALL_RUN[a.tool!]) && [...names].every((t) => !!CAP.callRunFor(t)));
  const never = CAP.ABILITIES.filter((a) => a.confirm === "affects_another_member" || a.confirm === "costs_money").map((a) => a.tool!).filter(Boolean);
  check("1. nothing that needs another member's yes or costs money is on a call", never.length > 0 && never.every((t) => !names.has(t)), never);
  check("1. intros, invites, web research, page reads, email drafts and Pinterest reads stay off calls", ["requestEventIntro", "sendInvite", "webSearch", "searchPosts", "readPage", "draftEmail", "emailPlan", "readInspo", "shareFinds", "sendReply"].every((t) => !names.has(t)));
  check("1. sending what's on file, saving an event they're into, starting a search or a task, saving an ask: now", ["shareLink", "resendLink", "noteReaction", "searchEvents", "startTask", "saveAsk", "updateTask"].every((t) => CAP.callRunFor(t)?.run === "now"));
  check("1. decks, pages and documents: after (started on the call, made and texted after)", ["makeDeck", "updateDeck", "makePage", "updatePage", "writeDocument"].every((t) => CAP.callRunFor(t)?.run === "after"));
  check("1. sends get 3-5 seconds, saves and starts 3", ["shareLink", "resendLink", "resetLink"].every((t) => { const r: any = CAP.callRunFor(t); return r.ms >= 3000 && r.ms <= 5000; }) && ["saveAsk", "startTask", "updateNotes"].every((t) => (CAP.callRunFor(t) as any).ms === 3000));
  // A tool handed in that isn't on the list is never offered or run, whatever the model asks for.
  let ran = 0;
  const raw = { webSearch: aiTool({ description: "w", inputSchema: z.object({ q: z.string() }), execute: async () => { ran++; return { ok: true }; } }), updateNotes: aiTool({ description: "n", inputSchema: z.object({ what: z.string().optional() }), execute: async () => ({ ok: true }) }) };
  const set = CT.buildCallTools({ userId: "u-allow", callKey: "u-allow:t", turnWords: "hi", callWords: "hi", lastCoLine: null, member, dryRun: true, tools: raw });
  const r: any = await set.run("webSearch", { q: "venues" }, "x1");
  check("1. off-list tools are neither offered nor run on a call", !set.names.has("webSearch") && !set.defs.some((d) => d.name === "webSearch") && r?.ok === false && ran === 0, r);
  check("1. the call's shareLink is described for calls (by name, never a link read out)", set.defs.find((d) => d.name === "shareLink")?.description === CAP.toolUse("shareLink", "call") && /never read a link out/.test(CAP.toolUse("shareLink", "call")));
  check("1. the guide says it as principle (no quoted line for the words while a tool runs)", /say a few natural words of your own/.test(CT.CALL_TOOLS_GUIDE) && !/\("On it\."\)/.test(CT.CALL_TOOLS_GUIDE) && /Say you did something only after the tool comes back done/.test(CT.CALL_TOOLS_GUIDE));
}

// ---------------------------------------------------------------- 2. honest speech
{
  // A fake send toolset: shareLink texts them (texts), calendarConnection texts only on connect, updateNotes never.
  const fake = (result: unknown | ((name: string, input: any) => Promise<unknown>), names = ["shareLink", "calendarConnection", "updateNotes"]) => ({
    defs: names.map((n) => ({ name: n, description: n, input_schema: { type: "object", properties: {} } })),
    names: new Set(names),
    note: CT.CALL_TOOLS_GUIDE,
    texts: CT.textsThem,
    run: async (name: string, input: any) => (typeof result === "function" ? (result as any)(name, input) : result),
  });
  const JAZZ_OK = { ok: true, delivered: true, items: [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", delivered: true }] };
  const JAZZ_FAIL = { ok: false, owedAfterCall: true, note: "It didn't send on the call.", items: [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", delivered: false }] };
  const JAZZ_SLOW = { ok: false, stillRunning: true, owedAfterCall: true, note: "Not back yet.", items: [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", delivered: false }] };
  const send = '{"what":["Rooftop Jazz Night"]}';
  // F2: every phrasing, held after a failed and a timed-out send, said after a successful one.
  const phrasings = ["Texted it.", "Sent it over.", "Sent it to you.", "Link's in your texts.", "I put it in your texts.", "I popped it in your texts.", "You should have it now.", "Check your texts.", "Okay, that's sent.", "That's on its way to you.", "Just shot it over.", "You've got it.", "Just sent it, it's in your texts.", "I just texted you the link."];
  const leaks: string[] = [], lost: string[] = [];
  for (const line of phrasings) {
    for (const [label, result] of [["failed", JAZZ_FAIL], ["timed out", JAZZ_SLOW]] as const) {
      const up = scripted([[...text("One sec."), ...tool("f", "shareLink", send)], text(line), text("I'll text it to you right after we hang up.")]);
      const r = await go({ stream: up.stream, tools: fake(result) });
      if (r.content.includes(line)) leaks.push(`${label}: ${line}`);
    }
    const ok = scripted([[...text("One sec."), ...tool("s", "shareLink", send)], text(line)]);
    const r = await go({ stream: ok.stream, tools: fake(JAZZ_OK) });
    if (!r.content.includes(line)) lost.push(line);
  }
  check(`2. F2: every send-claim phrasing is held after a failed or timed-out send (${leaks.join(" | ") || "none leaked"})`, !leaks.length, leaks);
  check(`2. F2: and said after a send that came back done (${lost.join(" | ") || "none lost"})`, !lost.length, lost);
  check("2. F2: honest lines stay: future, conditional, earlier sends, someone else's send, questions, ordinary 'got it'", ["I'll text it to you right after we hang up.", "It'll be in your texts in a few minutes.", "I texted you the link yesterday.", "The deck you sent me looks great.", "Did it come through?", "Got it.", "Check your texts later for the link.", "It's on its way to being a great weekend.", "I haven't sent it yet."].every((l) => P.stripSendClaim(l) === l), ["I'll text it to you right after we hang up.", "It'll be in your texts in a few minutes.", "I texted you the link yesterday.", "The deck you sent me looks great.", "Did it come through?", "Got it.", "Check your texts later for the link.", "It's on its way to being a great weekend.", "I haven't sent it yet."].filter((l) => P.stripSendClaim(l) !== l));
  check("2. F2: a claim clause after an honest one is still a claim", P.stripSendClaim("Sent it, let me know if it doesn't come through.") === null);
  // F3: only a tool that really texted counts, item by item.
  const status = scripted([[...text("Let me check."), ...tool("c", "calendarConnection", '{"action":"status"}')], text("Sent it.")]);
  const st = await go({ stream: status.stream, tools: fake({ ok: true, connected: true }) });
  check("2. F3: a calendar status check texts nothing, so \"Sent it\" stays held", !/Sent it/.test(st.content), st);
  const notes = scripted([[...text("Noting that."), ...tool("n", "updateNotes", '{"what":"jazz"}')], text("Sent it over.")]);
  const nt = await go({ stream: notes.stream, tools: fake({ ok: true }) });
  check("2. F3: a note that came back done doesn't make a send true", !/Sent it over/.test(nt.content), nt);
  const two = scripted([[...text("One sec."), ...tool("t", "shareLink", '{"what":["Rooftop Jazz Night","Founders Breakfast"]}')], text("I've texted you both."), text("The jazz one is in your texts; I'll send the breakfast one right after we hang up.")]);
  const tw = await go({ stream: two.stream, tools: fake({ ok: true, delivered: true, items: [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", delivered: true }, { name: "Founders Breakfast", url: "https://lu.ma/fb", delivered: false }] }) });
  check("2. F3: \"I've texted you both\" after one of two went is held; the true line is said", !/both/.test(tw.content) && /jazz one is in your texts/.test(tw.content), tw);
  const wrong = scripted([[...text("One sec."), ...tool("w", "shareLink", '{"what":["Rooftop Jazz Night","Founders Breakfast"]}')], text("Just sent you Founders Breakfast."), text("The jazz one went; the breakfast one comes right after we hang up.")]);
  const wr = await go({ stream: wrong.stream, tools: fake({ ok: true, delivered: true, items: [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", delivered: true }, { name: "Founders Breakfast", url: "https://lu.ma/fb", delivered: false }] }) });
  check("2. F3: a claim naming the item that didn't go is held", !/Just sent you Founders Breakfast/.test(wr.content), wr);
  check("2. F3: the call's send rule: shareLink texts; calendar only on connect; notes never", CT.textsThem("shareLink", {}) && CT.textsThem("calendarConnection", { action: "connect" }) && !CT.textsThem("calendarConnection", { action: "status" }) && !CT.textsThem("calendarConnection", { action: "disconnect" }) && !CT.textsThem("updateNotes", {}) && !CT.textsThem("makeDeck", {}));
  // F4: "texting it to you now" goes out the moment the send starts (true then), not after it, and never without a send.
  const slowOk = () => new Promise((res) => setTimeout(() => res(JAZZ_OK), 250));
  const inflight = scripted([[...text("Texting it to you now."), ...tool("i", "shareLink", send)], text("There, it's in your texts.")]);
  let firstAudioMs = -1;
  const t0 = Date.now();
  const out: string[] = [];
  for await (const c of P.runCallLlm(body() as any, { stream: inflight.stream, tools: fake(() => slowOk()) as any })) { const t = c.choices[0].delta.content as string | undefined; if (t && firstAudioMs < 0) firstAudioMs = Date.now() - t0; if (t) out.push(t); }
  const all = out.join("");
  console.log(`probe: first audio ${firstAudioMs}ms with the in-flight line (the send itself takes 250ms)`);
  check(`2. F4: an in-flight "texting it to you now" is said while the send runs (first words at ${firstAudioMs}ms, send takes 250ms)`, /Texting it to you now/.test(all) && firstAudioMs >= 0 && firstAudioMs < 150 && /it's in your texts/.test(all), { firstAudioMs, all });
  const noSend = scripted([text("Texting it to you now.")]);
  const ns = await go({ stream: noSend.stream, tools: fake(JAZZ_OK) });
  check("2. F4: with no send called, \"texting it now\" is never said", !/Texting it/.test(ns.content), ns);
  const failAfterNow = scripted([[...text("Texting it to you now."), ...tool("x", "shareLink", send)], text("Anything else on your mind?"), text("That didn't go through, so I'll text it to you right after we hang up.")]);
  const fa = await go({ stream: failAfterNow.stream, tools: fake(JAZZ_FAIL) });
  check("2. F4: the send they heard was going fails: the next words say it comes right after the call, never \"sent\"", /Texting it to you now/.test(fa.content) && fa.content.includes(P.FAILED_SEND_LINE) && !/\bsent\b/i.test(fa.content), fa);
  const slowFail = scripted([[...text("Texting it to you now."), ...tool("y", "shareLink", send)], text("I'll text it to you right after the call.")]);
  const sf = await go({ stream: slowFail.stream, tools: fake(JAZZ_SLOW) });
  check("2. F4: timed out after the in-flight line: it says right after the call, with no retry needed", /right after the call/.test(sf.content) && slowFail.reqs.length === 2, { sf, reqs: slowFail.reqs.length });
  // A save that came back done may be called done; one that didn't may not.
  const saved = scripted([[...text("Got it."), ...tool("s5", "updateNotes", "{}")], text("Saved it.")]);
  const e = await go({ stream: saved.stream, tools: fake({ ok: true }) });
  const unsaved = scripted([[...text("Got it."), ...tool("s6", "updateNotes", "{}")], text("I've saved it.")]);
  const f = await go({ stream: unsaved.stream, tools: fake({ ok: false, stillRunning: true }) });
  check("2. \"saved\" only after a tool came back done", /Saved it\./.test(e.content) && !/saved it/i.test(f.content), { e: e.content, f: f.content });
  // F10: a held claim has its own decision reason, never an unsourced offer.
  const fl = await go({ stream: scripted([[...text("One sec."), ...tool("z", "shareLink", send)], text("Sent it over."), text("I'll text it right after we hang up.")]).stream, tools: fake(JAZZ_FAIL) });
  check("2. F10: a held claim is reported as a claim (call.claim_held), not an unsourced offer", fl.dropped.some((d) => /Sent it over\. \| claim held: /.test(d)) && /decision: claim \? "call\.claim_held" : "call\.offer_unsourced"/.test(src("routes/callLlm.ts")), fl.dropped);
}

// ---------------------------------------------------------------- 2b. the real call shareLink: link then caption, owed when it doesn't go
{
  CT._resetCallMemoryForTest();
  const sent: string[] = [];
  const owed: any[] = [];
  const done: any[] = [];
  const build = (key: string, send: (t: string) => Promise<boolean>, msFor?: (n: string) => number | undefined) =>
    CT.buildCallTools({ userId: "u-send", callKey: key, turnWords: "can you text me the jazz thing", callWords: "can you text me the jazz thing", lastCoLine: "There's Rooftop Jazz Night tomorrow at 7.", member, dryRun: true, tools: {}, onFile: [JAZZ, { name: "Founders Breakfast", url: "https://lu.ma/fb", caption: "Founders Breakfast" }], sendText: send, msFor, owe: async (items, why, t) => { owed.push({ items, why, t }); }, done: async (t, kind, input, urls) => { done.push({ t, kind, urls }); } });
  const okSet = build("u-send:a", async (t) => (sent.push(t), true));
  const r1: any = await okSet.run("shareLink", { what: ["rooftop jazz night"] }, "a1");
  check("2b. on file by name: its link goes as its own text, then its caption", r1?.ok === true && r1.delivered === true && sent[0] === JAZZ.url && sent[1] === JAZZ.caption, { r1, sent });
  check("2b. done is recorded with the link it carried", done.some((x) => x.t === "shareLink" && x.urls.includes(JAZZ.url)), done);
  const r2: any = await okSet.run("shareLink", { what: ["the gala on Saturday"] }, "a2");
  check("2b. something not on file: nothing sent, nothing owed, and Cue isn't to promise it", r2?.ok === false && /isn't on file/.test(r2.error) && sent.length === 2 && owed.length === 0, r2);
  const optedOut = CT.buildCallTools({ userId: "u-send", callKey: "u-send:o", turnWords: "text me the jazz thing", callWords: "text me the jazz thing", lastCoLine: null, member: { ...member, noTexts: true }, dryRun: true, tools: {}, onFile: [JAZZ], sendText: async (t) => (sent.push(t), true), owe: async (items) => { owed.push(items); } });
  const r2b: any = await optedOut.run("shareLink", { what: ["Rooftop Jazz Night"] }, "o1");
  check("2b. opted out of texts: nothing is texted from the call and nothing is owed after it", r2b?.ok === false && sent.length === 2 && owed.length === 0 && /turned texts off/.test(r2b.error), r2b);
  // The send fails: owed right after the call, and the model is told to say so.
  const failSet = build("u-send:b", async () => false);
  const r3: any = await failSet.run("shareLink", { what: ["Rooftop Jazz Night"] }, "b1");
  check("2b. a failed send is owed after the call (the actual link), and the model hears not to say it went", r3?.ok === false && r3.owedAfterCall === true && owed[0]?.why === "failed" && owed[0]?.items[0]?.url === JAZZ.url && /right after the call/.test(r3.note), { r3, owed });
  check("2b. and every later turn of the call knows it's owed", CT.owedOnCall("u-send:b").some((o) => o.url === JAZZ.url) && /Owed right after the call: Rooftop Jazz Night/.test(build("u-send:b", async () => true).note));
  // The send is slow: the tool falls back inside its own timeout, owed; when it lands late it's done and no longer owed.
  owed.length = 0; done.length = 0;
  const slowSet = build("u-send:c", (t) => new Promise((res) => setTimeout(() => (sent.push(t), res(true)), 150)), () => 30);
  const t0 = Date.now();
  const r4: any = await slowSet.run("shareLink", { what: ["Rooftop Jazz Night"] }, "c1");
  check("2b. a slow send doesn't hold the call: back inside its own timeout, not confirmed, owed", Date.now() - t0 < 120 && r4?.ok === false && r4.stillRunning === true && r4.owedAfterCall === true && owed[0]?.why === "timeout", { ms: Date.now() - t0, r4, owed });
  await wait(400);
  check("2b. the late send lands: recorded done, and no longer owed on the call", done.some((x) => x.urls.includes(JAZZ.url)) && !CT.owedOnCall("u-send:c").length, { done, owed: CT.owedOnCall("u-send:c") });
  // Through the proxy, a slow tool: the turn's words come back in time and say nothing went.
  const up = scripted([[...text("One sec."), ...tool("p1", "shareLink", '{"what":["Rooftop Jazz Night"]}')], text("Just sent it."), text("I'll text it to you right after we hang up.")]);
  const slow2 = build("u-send:d", () => new Promise((res) => setTimeout(() => res(true), 200)), () => 30);
  const t1 = Date.now();
  const r5 = await go({ stream: up.stream, tools: slow2 });
  check("2b. through the proxy: a slow send keeps the call moving and never says it went", Date.now() - t1 < 180 && !/Just sent it/.test(r5.content) && /right after we hang up/.test(r5.content), { ms: Date.now() - t1, r5 });
  await wait(250);
}

// ---------------------------------------------------------------- 3. timeouts for every quick tool; decks and docs in the background
{
  CT._resetCallMemoryForTest();
  let landed = false;
  const raw = { saveAsk: aiTool({ description: "s", inputSchema: z.object({ what: z.string() }), execute: async () => { await wait(120); landed = true; return { ok: true }; } }) };
  const set = CT.buildCallTools({ userId: "u-to", callKey: "u-to:t", turnWords: "keep an eye out for jazz", callWords: "keep an eye out for jazz", lastCoLine: null, member, dryRun: true, tools: raw, msFor: () => 25 });
  const t0 = Date.now();
  const r: any = await set.run("saveAsk", { what: "jazz nights" }, "x");
  check("3. a quick tool past its own timeout comes back not confirmed (no stall), and keeps going on its own", Date.now() - t0 < 100 && r?.stillRunning === true && r?.ok === false && !/owed/i.test(JSON.stringify(r)), r);
  await wait(200);
  check("3. ...and its write still lands", landed);
  const route = src("services/callTools.ts");
  check("3. decks, pages and documents carry on in the background past a short wait, never holding the call", /plan\.run === "after" && !i\.dryRun/.test(route) && /const quick = await within\(work, plan\.waitMs\)/.test(route) && (CAP.callRunFor("makeDeck") as any).waitMs <= 3500);
}

// ---------------------------------------------------------------- 4. right after the call: the owed link goes, nothing done twice
{
  const start = new Date("2026-10-29T18:00:00Z");
  const end = new Date("2026-10-29T18:12:00Z");
  const owedRow = { decision: "call.owed_after_call", action: "shareLink", proposal: { items: [{ name: JAZZ.caption, url: JAZZ.url }], why: "failed", taskId: 7 }, created_at: new Date("2026-10-29T18:05:00Z") };
  const doneRow = { decision: "call.done_on_call", action: "shareLink", proposal: { kind: "send", labels: [`the link ${"https://lu.ma/fb"}`], urls: ["https://lu.ma/fb"] }, created_at: new Date("2026-10-29T18:03:00Z") };
  const coveredRow = { decision: "call.turn_acted", action: "covered", proposal: { said: ["I'll text you the breakfast link."] }, created_at: new Date("2026-10-29T18:03:00Z") };
  const ledger = L.ledgerFromRows([owedRow, doneRow, coveredRow]);
  check("4. the ledger: what was done, what's owed, and the lines a tool already kept", ledger.done.length === 1 && ledger.owed[0]?.items[0]?.url === JAZZ.url && ledger.covered[0] === "I'll text you the breakfast link.");
  const lateRow = { decision: "call.done_on_call", action: "shareLink", proposal: { kind: "send", labels: ["x"], urls: [JAZZ.url] }, created_at: new Date("2026-10-29T18:06:00Z") };
  check("4. the ledger keeps the owed row (with its task) whatever the order; the after-call step settles it on whether the link landed", L.ledgerFromRows([owedRow, lateRow]).owed[0]?.taskId === 7 && L.ledgerFromRows([lateRow, owedRow]).done[0]?.urls[0] === JAZZ.url);

  type Sent = { at: Date; text: string; kind: "text" | "link" | "document" };
  const run = async (o: { sends?: Sent[]; reachable?: boolean; commitments?: any[]; ledger?: any } = {}) => {
    const delivered: any[] = [], closed: number[] = [], ran: number[] = [], tracked: any[] = [], recs: any[] = [];
    const went: Sent[] = [...(o.sends ?? [])];
    const r = await FT.followThroughOnCallEnd({ userId: "u-ft", transcript: "assistant: hi\nuser: text me the jazz thing", startedAt: start, endedAt: end }, {
      now: () => new Date(end.getTime() + 5_000),
      track: async (_u, _t, x) => { tracked.push(x); },
      ledger: async () => o.ledger ?? ledger,
      sends: async () => went,
      deliver: async ({ item, key }) => { delivered.push({ item, key }); went.push({ at: new Date(end.getTime() + 4_000), text: item.url, kind: "link" }, { at: new Date(end.getTime() + 4_500), text: item.name, kind: "text" }); return { sent: true }; },
      close: async (_u, id) => { closed.push(id); },
      commitments: async () => o.commitments ?? [],
      person: async () => ({ firstName: "Jordan", phone: "+14155550123", zone: "America/Los_Angeles", reachable: o.reachable ?? true }),
      draft: async () => null,
      send: async () => ({ sent: false }),
      runTask: async (_u, c) => { ran.push(c.taskId); return { ran: true }; },
      hold: async () => {},
      record: (async (d: any) => { recs.push(d); }) as any,
    });
    await r.work;
    return { r, delivered, closed, ran, tracked, recs };
  };
  const a = await run();
  check("4. the owed link goes the moment the call ends: the actual link, once per call and link", a.delivered.length === 1 && a.delivered[0].item.url === JAZZ.url && a.delivered[0].item.name === JAZZ.caption && /^call_owed:/.test(a.delivered[0].key) && a.r.owedSent?.includes(JAZZ.url), a);
  check("4. the transcript read skips what a tool already kept on the call", a.tracked[0]?.skip?.includes("I'll text you the breakfast link."), a.tracked);
  const b = await run({ sends: [{ at: new Date("2026-10-29T18:07:00Z"), text: JAZZ.url, kind: "link" }] });
  check("4. a late send that already landed isn't sent again", b.delivered.length === 0 && b.recs.some((x) => x.decision === "call.owed_delivery" && x.action === "already_sent"), b.recs);
  const c = await run({ reachable: false });
  check("4. opted out or archived: nothing is sent", c.delivered.length === 0 && c.recs.some((x) => x.action === "unreachable"));
  // The owed promise task (opened when the send failed) is kept by the delivery and closed, never worked again; another promise runs.
  const owedTask = { taskId: 7, sentence: "x", wakes: 0, goal: `${CC.COMMIT_PREFIX}text them the link to ${JAZZ.caption}`, theirWords: "can you text me the jazz thing", createdAt: "2026-10-29T18:05:01Z" };
  const other = { taskId: 8, sentence: "y", wakes: 0, goal: `${CC.COMMIT_PREFIX}"I'll put together the venue shortlist tonight."`, theirWords: "can you find venues", createdAt: "2026-10-29T18:09:00Z" };
  const d = await run({ commitments: [owedTask, other] });
  check("4. the promise for the owed link is closed as kept (not run again); the other promise still runs", d.closed.includes(7) && !d.ran.includes(7) && d.ran.includes(8) && d.r.keptOnCall?.includes(7), d);
  // Item 2: nothing but an owed link's own task is ever closed here: the reviewer's phrasings stay open and run, even with a jazz send.
  const jazzWent: Sent[] = [{ at: new Date("2026-10-29T18:04:00Z"), text: "the link to Rooftop Jazz Night (https://lu.ma/rooftop-jazz)", kind: "link" }];
  const openGoals = ["find them jazz nights in December", "send them a couple of jazz options this week", "keep looking for jazz nights", "let them know if other jazz shows pop up", "find more jazz things like this"];
  const stays = await run({ sends: jazzWent, ledger: { done: [], owed: [], covered: [] }, commitments: openGoals.map((g, n) => ({ taskId: 20 + n, sentence: g, wakes: 0, goal: `${CC.COMMIT_PREFIX}${g}`, theirWords: "any jazz stuff", createdAt: "2026-10-29T18:00:30Z" })) });
  check("4. item 2: no call promise is closed by a send that shares its words; every one still runs", stays.closed.length === 0 && openGoals.every((_g, n) => stays.ran.includes(20 + n)), stays);
  check("4. item 2: the old closing is gone", !("keptByWhatWent" in FT));
  // Item 6: the send landed before the owed row was even written (a slow send that finished on the call): no second send, task closed.
  const raceLedger = L.ledgerFromRows([{ decision: "call.done_on_call", action: "shareLink", proposal: { kind: "send", labels: ["x"], urls: [JAZZ.url], names: ["Rooftop Jazz Night"] }, created_at: new Date("2026-10-29T18:04:59Z") }, owedRow]);
  const race = await run({ ledger: raceLedger, commitments: [owedTask] });
  check("4. item 6: a send that landed before its owed row is never sent again, and its task closes", race.delivered.length === 0 && race.closed.includes(7) && !race.ran.includes(7), race);
  const raceText = await run({ ledger: L.ledgerFromRows([owedRow]), sends: [{ at: new Date("2026-10-29T18:04:30Z"), text: JAZZ.url, kind: "link" }], commitments: [owedTask] });
  check("4. item 6: landed any time since the call started counts (a text that went before the owed row)", raceText.delivered.length === 0 && raceText.closed.includes(7), raceText);
  const noTask = await run({ ledger: L.ledgerFromRows([{ ...owedRow, proposal: { ...owedRow.proposal, taskId: null } }]), commitments: [owedTask] });
  check("4. item 2: a promise not tied to an owed row is never closed here", !noTask.closed.length && noTask.ran.includes(7), noTask);
  check("4. settledOwedTasks: only tasks whose every link landed", FT.settledOwedTasks([{ taskId: 1, items: [{ url: "a" }, { url: "b" }] }, { taskId: 2, items: [{ url: "a" }] }, { taskId: null, items: [{ url: "a" }] }], (u) => u === "a").join() === "2");
  check("4. commitments a tool kept aren't reopened from the transcript", CC.commitmentsNotCovered(["I'll text you the breakfast link.", "I'll send you the venue list tonight."], ["I'll text you the breakfast link."]).join("|") === "I'll send you the venue list tonight.");
  // The reflection text: what was done on the call is in its facts as never-again, and the draft reads the ledger.
  const pc = src("jobs/postCallFollowUp.ts");
  check("4. the reflection gets what was done on (and right after) the call, as never to mention, resend or offer again", /done_on_the_call_already_never_mention_resend_or_offer_again: doneOnCall\.length \? doneOnCall : null/.test(pc) && /readCallLedger\(userId/.test(pc) && /decision = 'call\.owed_delivery' AND action = 'sent'/.test(pc));
  check("4. the ledger's done lines are Cue's own labels", L.doneLines(ledger)[0] === "the link https://lu.ma/fb" && L.doneLabels("saveAsk", { what: "jazz nights" })[0] === "saved an ask to keep looking for: jazz nights");
  // F5: the done list names the actual item (the call shareLink's names beside its links).
  const BF = { name: "Founders Breakfast", url: "https://lu.ma/fb" };
  const labels = L.doneLabels("shareLink", { urls: [BF.url], names: [BF.name] });
  check("4. F5: a call send's done label names the item and its link", labels[0] === `the link to ${BF.name} (${BF.url})`, labels);
  const named = L.ledgerFromRows([{ decision: "call.done_on_call", action: "shareLink", proposal: { kind: "send", labels, urls: [BF.url], names: [BF.name] }, created_at: new Date() }]);
  const doneSend = L.doneItems(named);
  check("4. F5: done items carry the send's kind, names and links (for the audit and the reflection)", doneSend[0]?.kind === "send" && doneSend[0].names[0] === BF.name && doneSend[0].urls[0] === BF.url && L.doneLines(named)[0].includes(BF.name));
  // F6: the audit excuses only a claim that names what was done, and a send claim only by a send.
  const claim = { quote: "I just texted you the Founders Breakfast link.", type: "invented_fact" as const, what: "", specifics: ["Founders Breakfast"] };
  const plan = (c: any, done: any[]) => G.planCallAudit([c], `assistant: ${c.quote}`, { knownBefore: "", records: "", tasks: [], doneOnCall: done });
  const withDone = plan(claim, doneSend);
  check("4. the audit: \"I just texted you\" a tool really did is done, not a correction", withDone.corrections.length === 0 && withDone.refused.some((r) => /done on the call/.test(r.why)), withDone);
  check("4. the audit keeps the honest check: the same claim with nothing done on the call is a correction", plan(claim, []).corrections.length === 1);
  // The jazz-brunch probe: only a saveAsk was done; "I texted you the jazz brunch link" shares its words but nothing texted them.
  const saveOnly = [{ kind: "start", label: "saved an ask to keep looking for: jazz brunch", names: [], urls: [] }];
  const brunch = { quote: "I just texted you the jazz brunch link.", type: "invented_fact" as const, what: "", specifics: ["jazz brunch"] };
  check("4. F6: a send claim isn't excused by a save on the same subject (the jazz-brunch probe)", plan(brunch, saveOnly).corrections.length === 1);
  const oneWord = { quote: "I just texted you the Founders Dinner link.", type: "invented_fact" as const, what: "", specifics: ["Founders Dinner"] };
  check("4. F6: one shared word with a real send doesn't excuse a claim about something else", plan(oneWord, doneSend).corrections.length === 1);
  check("4. F6: a claim of saving that matches a save is excused", plan({ quote: "I've saved the jazz brunch ask.", type: "invented_fact" as const, what: "", specifics: [] }, saveOnly).corrections.length === 0);
  check("4. F6: a bare \"just sent it\" is excused only by exactly one send", plan({ quote: "Just sent it.", type: "invented_fact" as const, what: "", specifics: [] }, doneSend).corrections.length === 0 && plan({ quote: "Just sent it.", type: "invented_fact" as const, what: "", specifics: [] }, saveOnly).corrections.length === 1);
  const promised = G.planCallAudit([{ quote: "I'll text you the Founders Breakfast link.", type: "promise_keepable", what: "text them the Founders Breakfast link" }], "user: send me the breakfast\nassistant: I'll text you the Founders Breakfast link.", { knownBefore: "", records: "", tasks: [], doneOnCall: doneSend });
  check("4. a promise the call already kept opens nothing", promised.promises.length === 0 && promised.refused.length === 1, promised);
  const notKept = G.planCallAudit([{ quote: "I'll text you the jazz brunch link.", type: "promise_keepable", what: "text them the jazz brunch link" }], "user: send me the jazz brunch\nassistant: I'll text you the jazz brunch link.", { knownBefore: "", records: "", tasks: [], doneOnCall: saveOnly });
  check("4. F6: a promise to text something isn't covered by a save on it", notKept.promises.length === 1, notKept);
  check("4. the audit prompt lists what was done on the call", /What Cue did DURING the call with its own tools[\s\S]*- the link to Founders Breakfast/.test(G.callAuditPrompt("assistant: hi", "", undefined, doneSend)));
  // F8: a commitment is covered only by a tool done that turn for the same thing.
  const jazzSent = { name: "shareLink", input: { what: ["Rooftop Jazz Night"] }, result: { ok: true, delivered: true, items: [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", delivered: true }] } };
  const noteDone = { name: "updateNotes", input: { what: "jazz" }, result: { ok: true } };
  check("4. F8: \"I'll text you the jazz link\" is covered by the jazz send this turn", CC.commitmentKeptBy("I'll text you the jazz link.", "", [jazzSent]));
  check("4. F8: ...not by a note that came back done", !CC.commitmentKeptBy("I'll text you the jazz link.", "", [noteDone]));
  check("4. F8: ...and not by a send of something else", !CC.commitmentKeptBy("I'll text you the breakfast link.", "", [jazzSent]));
  check("4. F8: a write-up is covered only by the thing made for it", !CC.commitmentKeptBy("I'll put together the partner plan.", "", [noteDone, jazzSent]) && CC.commitmentKeptBy("I'll put together the partner plan.", "", [{ name: "writeDocument", input: { title: "Partner plan" }, result: { ok: true, pending: true } }]));
  check("4. F8: the route covers each commitment on its own (uncovered ones still open)", /commitmentKeptBy\(s, coBefore, doneThisTurn\)/.test(src("routes/callLlm.ts")) && /commitments\.filter\(\(x\) => !covered\.includes\(x\)\)\) await trackCallCommitment/.test(src("routes/callLlm.ts")));
  const co = src("routes/co.ts");
  check("4. the post-call audit reads the call's ledger", /readCallLedger\(user_id[\s\S]{0,200}doneItems[\s\S]{0,160}await auditCall\(user_id, cleanTranscript, knownBeforeCall, \{ doneOnCall \}\)/.test(co));
}

// ---------------------------------------------------------------- 5. latency: one decision per proxy turn, numbers only
{
  const pool = (await import("../../src/db/db.js")).default as any;
  const realQuery = pool.query.bind(pool);
  const rows: any[] = [];
  pool.query = async (sql: string, params: any[] = []) => {
    if (/INSERT INTO harness_decisions/.test(sql)) { rows.push({ decision: params[1], action: params[4], proposal: JSON.parse(params[5] ?? "null") }); return { rows: [] }; }
    if (/SELECT phone_number, first_name, sms_opted_out, archived_at FROM users/.test(sql)) return { rows: [{ phone_number: "+14155550123", first_name: "Jordan" }] };
    return { rows: [] };
  };
  const savedEnv = { ...process.env };
  Object.assign(process.env, { CALL_LLM_PROXY_SECRET: "proxy-secret", ELEVENLABS_TOOL_SECRET: "tool-secret" });
  const EL = await import("../../src/services/elevenLabsCalls.js");
  const { createCallLlmRouter } = await import("../../src/routes/callLlm.js");
  const U = "31313131-1111-2222-3333-444444444444";
  const events = [{ type: "message_start", message: { id: "m", usage: { input_tokens: 0, output_tokens: 0 } } }, ...text("Sure thing, that works."), { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }];
  const router = createCallLlmRouter((() => (async function* () { for (const e of events) yield e as any; })()) as any);
  const secretWords = "my sister Mara is moving to Lisbon";
  const post = () => new Promise<void>((resolve) => {
    const res: any = { statusCode: 200, headersSent: false, status(c: number) { this.statusCode = c; return this; }, json() { resolve(); return this; }, set() { return this; }, flushHeaders() {}, write() { return true; }, end() { resolve(); } };
    const req: any = { method: "POST", url: "/", headers: { authorization: "Bearer proxy-secret" }, body: { model: "x", stream: true, messages: [{ role: "system", content: "You are Cue." }, { role: "assistant", content: "Hi Jordan." }, { role: "user", content: secretWords }], elevenlabs_extra_body: { user_id: U, call_token: EL.issueCallToken(U) } } };
    (router as any).handle(req, res, () => resolve());
  });
  const quiet = console.log, quietErr = console.error; console.log = () => {}; console.error = () => {};
  await post();
  await wait(50);
  console.log = quiet; console.error = quietErr;
  const lat = rows.find((r) => r.decision === "call.turn_latency");
  check("5. each proxy turn writes call.turn_latency: time to first token and first sentence, the turn, the tools", !!lat && lat.action === "proxy" && typeof lat.proposal.firstTokenMs === "number" && typeof lat.proposal.firstSentenceMs === "number" && typeof lat.proposal.totalMs === "number" && Array.isArray(lat.proposal.tools), rows.map((r) => r.decision));
  check("5. ...and no member words in it", !!lat && !JSON.stringify(lat).includes("Mara") && !JSON.stringify(lat).includes("Lisbon"), lat);
  pool.query = realQuery;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  const m = LAT.elTurnMetrics([
    { role: "agent", message: "Hi", conversation_turn_metrics: { metrics: { convai_llm_service_ttfb: { elapsed_time: 0.42 }, convai_tts_service_ttfb: { elapsed_time: 0.21 } } } },
    { role: "user", message: "hey" },
    { role: "agent", message: "Sure", conversation_turn_metrics: { metrics: { convai_llm_service_ttfb: { elapsed_time: 1.1 } } } },
    { role: "agent", message: "Ok" },
  ]);
  check("5. ElevenLabs' own per-turn numbers (direct or proxy): read by name, in ms, summarized", m.turns === 3 && m.byKey.convai_llm_service_ttfb?.n === 2 && m.byKey.convai_llm_service_ttfb.medianMs === 420 && m.byKey.convai_llm_service_ttfb.maxMs === 1100 && m.byKey.convai_tts_service_ttfb?.medianMs === 210 && !JSON.stringify(m).includes("Sure"), m);
  check("5. the post-call webhook records them for every call", /decision: "call\.el_turn_metrics"/.test(src("routes/co.ts")));
}

// ---------------------------------------------------------------- 6. consent: a voice-read stop strips the next turn, even when slow
{
  CT._resetCallMemoryForTest();
  let stopped = false;
  const raw = { voiceRead: aiTool({ description: "v", inputSchema: z.object({ answer: z.string(), theirWords: z.string() }), execute: async () => { await wait(100); stopped = true; return { ok: true, say: "x" }; } }) };
  const set = CT.buildCallTools({ userId: "u-vr", callKey: "u-vr:t", turnWords: "stop listening to how I sound", callWords: "stop listening to how I sound", lastCoLine: null, member, dryRun: true, tools: raw, msFor: () => 20 });
  const r: any = await set.run("voiceRead", { answer: "stop", theirWords: "stop listening to how I sound" }, "v1");
  check("6. a stop whose write is still going at its timeout still turns the voice lines off for the rest of the call", r?.stillRunning === true && CT.callVoiceReadOff("u-vr:t") && CT.buildCallTools({ userId: "u-vr", callKey: "u-vr:t", turnWords: "anyway", callWords: "anyway", lastCoLine: null, member, dryRun: true, tools: {} }).note.includes((await import("../../src/services/voiceReadConsent.js")).VOICE_READ_OFF_ON_CALL_NOTE), r);
  await wait(150);
  check("6. ...and the stop itself lands", stopped);
  const route = src("routes/callLlm.ts");
  check("6. the endpoint still strips the voice lines once the call's flag is set, before the model sees the turn", /callVoiceReadOff\(callKey\)\) body\.messages = \(await import\("\.\.\/services\/voiceReadConsent\.js"\)\)\.stripVoiceReadLines\(body\.messages\)/.test(route));
  const VR = await import("../../src/services/voiceReadConsent.js");
  const stripped = JSON.stringify(VR.stripVoiceReadLines([{ role: "system", content: `Notes. ${VR.VOICE_READ_CALL_RULE} More.` }]));
  check("6. the strip takes the rule out and keeps the rest", !stripped.includes(VR.VOICE_READ_CALL_RULE) && /Notes\./.test(stripped) && /More\./.test(stripped));
  check("6. safety and crisis lines are untouched by the claim guard", P.stripSendClaim("If you're not safe right now, call 988.") === "If you're not safe right now, call 988.");
}

// ---------------------------------------------------------------- 7. round-2 review cases (the reviewer's probes, as layer 1)
{
  const C = await import("../../src/services/callClaims.js");
  // The reviewer's whole claim list: held after a failed send, and the honest lines never held.
  const failedState = { ...C.emptyClaimState(), undelivered: ["Rooftop Jazz Night"], sendContext: true };
  const mustHold = ["Texted it.", "Sent it over.", "Link's in your texts.", "You should have it now.", "Check your texts.", "That's on its way to you.", "Just shot it over.", "You've got it.", "Okay, sent.", "Done, it's in your texts.", "I sent you the link.", "Texted you the jazz link.", "It's on your phone now.", "Should be in your messages.", "I just texted that over.", "Got it over to you.", "I've sent both.", "It's done.", "All set.", "There you go.", "Sent you the Rooftop Jazz Night link.", "Popped it into your texts.", "Just dropped it in your texts.", "It went through.", "That should be there now.", "You'll see it in your texts now.", "Look for it in your texts.", "It's waiting in your texts.", "Your link's there.", "I've sent that link your way.", "I shared it with you.", "Messaged it to you.", "Sending that now, done.", "Okay — it's sent!", "that's gone through to you", "Hit send on it.", "Link sent.", "It's in your inbox.", "You should be getting it any second.", "It should be there.", "Should've landed.", "Check your phone.", "Text's out.", "Sent!", "Just sent.", "It's over to you now.", "Check your messages, it's there.", "I fired that off to you.", "Sent. Let me know if it doesn't come through.", "you've got the link now", "It's on its way.", "Shot you the link."];
  const mustPass = ["Did you get the text I sent?", "I haven't sent it yet.", "I'll text it to you right after the call.", "I'll send it once we hang up.", "You sent me the deck yesterday.", "The deck you sent was great.", "I texted you that yesterday.", "Want me to text it to you?", "I can send it over if you like.", "I'm going to text it after we hang up.", "Did that come through?", "What they sent you looks great.", "You texted me about the jazz night.", "Not sent yet, I'll send it after the call.", "Your friend sent you that?", "If you want, I'll shoot it over after.", "It's a rooftop thing on Saturday.", "Check the weather before you go.", "I'll get it over to you after the call.", "Someone sent me that last week."];
  const leak = mustHold.filter((x) => !C.claimHeld(x, failedState) || P.stripSendClaim(x, { state: failedState }) !== null);
  const falseHold = mustPass.filter((x) => !!C.claimHeld(x, failedState) || P.stripSendClaim(x, { state: failedState }) !== x);
  check(`7. item 1: the reviewer's ${mustHold.length} claims are all held after a failed send (${leak.join(" | ") || "none leak"})`, !leak.length, leak);
  check(`7. item 1: the ${mustPass.length} honest lines are never held (${falseHold.join(" | ") || "none held"})`, !falseHold.length, falseHold);
  // Item 1: a bare yes to Cue's offer, and no send at all: arrival lines are held (send context from Cue's own line).
  const offerBody = (last: string) => ({ model: "x", stream: true, messages: [{ role: "system", content: "You are Cue, on a call with Jordan." }, { role: "assistant", content: "Want me to text you the link to Rooftop Jazz Night?" }, { role: "user", content: last }] });
  const sendFake = (result: any) => ({ defs: ["shareLink", "updateNotes"].map((n) => ({ name: n, description: n, input_schema: { type: "object", properties: {} } })), names: new Set(["shareLink", "updateNotes"]), note: CT.CALL_TOOLS_GUIDE, texts: CT.textsThem, run: async (n: string, i: any) => (typeof result === "function" ? result(n, i) : result) });
  const run1 = async (b: any, up: any, tools: any) => { const out: any[] = []; for await (const c of P.runCallLlm(b, { stream: up.stream, tools })) out.push(c); return out.map((c) => c.choices[0].delta.content ?? "").join(""); };
  const arrivals = ["You should have it now.", "Check your texts.", "You've got it.", "It's on its way.", "There you go.", "It went through.", "It should be there.", "That should be there now.", "Should've landed.", "Your link's there.", "I shared it with you.", "Text's out.", "Hit send on it."];
  const spokenNoSend: string[] = [];
  for (const yes of ["Yes please.", "Sure.", "Yeah, do it."]) for (const line of arrivals) { const out = await run1(offerBody(yes), scripted([text(line), text("Got it.")]), sendFake({ ok: true })); if (out.includes(line)) spokenNoSend.push(`${yes} -> ${line}`); }
  check(`7. item 1: after a bare "Yes please" / "Sure" / "Yeah, do it" with no send, no arrival line is spoken (${spokenNoSend.join(" | ") || "none"})`, !spokenNoSend.length, spokenNoSend);
  const spokenFailed: string[] = [];
  for (const line of arrivals) { const out = await run1(offerBody("Yes please."), scripted([[...text("One sec."), ...tool("f", "shareLink", '{"what":["Rooftop Jazz Night"]}')], text(line), text("I'll text it to you right after we hang up.")]), sendFake({ ok: false, owedAfterCall: true, items: [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", delivered: false }] })); if (out.includes(line)) spokenFailed.push(line); }
  check(`7. item 1: the new phrasings are held after a failed send (${spokenFailed.join(" | ") || "none"})`, !spokenFailed.length, spokenFailed);
  // Item 3: one of two went (jazz); a claim naming the other in part is held; one naming only jazz is said.
  const HALF = { ok: true, delivered: true, items: [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", delivered: true }, { name: "Gallery Opening", url: "https://lu.ma/gallery", delivered: false }] };
  const half: string[] = [];
  for (const line of ["Sent you the gallery one.", "Just texted you the gallery link.", "The gallery link's in your texts."]) { const out = await run1(offerBody("Text me both."), scripted([[...text("One sec."), ...tool("t", "shareLink", '{"what":["Rooftop Jazz Night","Gallery Opening"]}')], text(line), text("Okay.")]), sendFake(HALF)); if (out.includes(line)) half.push(line); }
  const jazzOut = await run1(offerBody("Text me both."), scripted([[...text("One sec."), ...tool("t", "shareLink", '{"what":["Rooftop Jazz Night","Gallery Opening"]}')], text("Sent you the jazz one.")]), sendFake(HALF));
  check(`7. item 3: a claim naming the item that didn't go, in part, is held (${half.join(" | ") || "none said"}); the one that went is said`, !half.length && /Sent you the jazz one/.test(jazzOut), { half, jazzOut });
  const doneJazz = [{ kind: "send", label: "the link to Rooftop Jazz Night (https://lu.ma/rooftop-jazz)", names: ["Rooftop Jazz Night"], urls: ["https://lu.ma/rooftop-jazz"] }];
  check("7. item 3: the audit excuses \"I just sent you the jazz link\" (its word is one sent item's), not \"the rooftop bar list\" or \"the Night Market link\"", G.doneOnCallVerdict("I just sent you the jazz link.", doneJazz).done && !G.doneOnCallVerdict("I texted you the rooftop bar list.", doneJazz).done && !G.doneOnCallVerdict("I just sent you the Night Market link.", doneJazz).done);
  // Item 4: after the in-flight line and a failed send, the approved line comes first, before the model's own question.
  const FAIL = { ok: false, owedAfterCall: true, items: [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", delivered: false }] };
  const q = scripted([[...text("Texting it to you now."), ...tool("i", "shareLink", '{"what":["Rooftop Jazz Night"]}')], text("So what else is on this week?")]);
  const qo = await run1(offerBody("Yes please."), q, sendFake(FAIL));
  check("7. item 4: the fixed after-call line is spoken, before the trailing question, in the approved words", qo.indexOf(P.FAILED_SEND_LINE) > 0 && qo.indexOf(P.FAILED_SEND_LINE) < qo.indexOf("So what else") && P.FAILED_SEND_LINE === "That didn't go through, so I'll text it to you right after the call." && !/—/.test(P.FAILED_SEND_LINE), qo);
  const sentAfter = await run1(offerBody("Yes please."), scripted([[...text("Texting it to you now."), ...tool("i", "shareLink", '{"what":["Rooftop Jazz Night"]}')], text("Sent!")]), sendFake(FAIL));
  check("7. item 4: when the model's next words claim it went, they're held and the fixed line still stands", sentAfter.includes(P.FAILED_SEND_LINE) && !/Sent!/.test(sentAfter), sentAfter);
  const throws = await run1(offerBody("Yes please."), scripted([[...text("Texting it to you now."), ...tool("i", "shareLink", '{"what":["Rooftop Jazz Night"]}')], text("Okay.")]), sendFake(async () => { throw new Error("boom"); }));
  check("7. item 4: a send that throws gets the line too", throws.includes(P.FAILED_SEND_LINE), throws);
  let n = 0;
  const dies = { reqs: [] as any[], stream: (_r: any) => { n++; return (async function* () { if (n === 1) { for (const e of [...text("Texting it to you now."), ...tool("i", "shareLink", '{"what":["Rooftop Jazz Night"]}')]) yield e as any; } else { yield* (text("Part") as any[]); throw new Error("upstream 529"); } })(); } };
  const got: string[] = [];
  try { for await (const c of P.runCallLlm(offerBody("Yes please.") as any, { stream: dies.stream, tools: sendFake(FAIL) as any })) got.push(c.choices[0].delta.content as string ?? ""); } catch { /* the endpoint closes the stream with what was said */ }
  check("7. item 4: the model failing after the send still leaves the line said (it goes before the next request)", got.join("").includes(P.FAILED_SEND_LINE), got.join(""));
  check("7. item 4: once said, the model is told so (no repeat)", q.reqs[1]?.messages.at(-1).content.some((b: any) => b.type === "text" && b.text.includes(P.FAILED_SEND_LINE)));
  // Item 5: a commitment that names something no tool ran for stays open.
  const jazzSend = [{ name: "shareLink", input: { what: ["Rooftop Jazz Night"] }, result: { ok: true, delivered: true, items: [{ name: "Rooftop Jazz Night", url: "https://lu.ma/rooftop-jazz", delivered: true }] } }];
  const covered: [string, string | undefined, boolean][] = [["I'll text you the jazz link.", undefined, true], ["I'll send you the gallery opening right after the call, that one's Friday.", "Want the gallery opening too?", false], ["I'll send that brunch one too.", undefined, false], ["I'll text you the brunch spot after, it's a good one.", undefined, false], ["I'll send it right after.", "Want the gallery opening too?", false], ["I'll send it right after.", "Want the jazz one?", true], ["I'll send you the gallery opening and the jazz one.", undefined, false]];
  const wrong5 = covered.filter(([x, before, want]) => CC.commitmentKeptBy(x, before, jazzSend) !== want).map(([x]) => x);
  check(`7. item 5: a commitment is covered only by a send of the thing it names (${wrong5.join(" | ") || "all right"})`, !wrong5.length, wrong5);
  // Item 7: resendLink, resetLink and shareArtifact rows name what they texted, like shareLink.
  const lbl = L.doneLabels("resendLink", { urls: ["https://cue.page/d/abc"], names: ["their deck \"Northlight pitch\""] });
  check("7. item 7: other call sends' done rows name the item and its link", lbl[0] === 'the link to their deck "Northlight pitch" (https://cue.page/d/abc)', lbl);
  check("7. item 7: a leading \"Done,\" trimmed is reported as a held claim", /claim held: a \\"Done\\" before anything was done/.test(src("services/callLlmProxy.ts")));
}

console.log(`act on calls: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
process.exit(0);
