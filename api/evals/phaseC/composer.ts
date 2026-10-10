// Phase C, assemble (Royce, 2026-10-10). Zero tokens: the composer's model is stubbed.
//   The work order's test: a 3-item bundle is one model output where every caption knows the others, the reason doesn't repeat, and
//   the closing question fits the set. Plus C1 one composer (no stitching), C2 the closing comes from the composed thought (no stock
//   fallback), C3 the pick's per-item why and its set view feed it, C4 quality control inside (the bundle never changes shape after a
//   part is written), C5 the thread (a find never lands on top of a live, unrelated conversation).
//   npx tsx evals/phaseC/composer.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const B = await import("../../src/harness/bundleComposer.js");
const E = await import("../../src/agent/eventDiscoverySurfacing.js");
const S = await import("../../src/services/sweepSelect.js");
const SH = await import("../../src/services/sweepShadow.js");
const { OFFER_FOLLOWUP_MANY } = await import("../../src/services/offerFollowUp.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 900)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// Three finds the pick chose together.
const m = (name: string, url: string, why: string, date = "2026-10-24") => ({ tier: 1, kind: "public_event", name, url, event_date: date, whyItFits: why, reason: why }) as any;
const cand = (id: string, match: any, pick: any) => ({ id, userId: "u", type: "event_offer", targetKey: `event_offer:${id}`, topicKey: id, summary: "", priority: 50, dueAt: new Date(), expiresAt: null, payload: { askId: "a1", askText: "small founder gatherings", fromProfile: false, match, picked: true, pick }, attempts: 0, createdAt: new Date() }) as any;
const finds = [
  m("Founder Supper Club", "https://lu.ma/supper", "eight founders around one table, no talks"),
  m("Quiet Builders Walk", "https://lu.ma/walk", "a slow walk through the Presidio with other builders"),
  m("Studio Night at Gray Area", "https://lu.ma/studio", "an open studio where people make things side by side"),
];
const items = finds.map((f, i) => ({
  candidate: cand(`c${i + 1}`, f, { whyMember: `why member ${i + 1}`, whyNow: `why now ${i + 1}`, set: "three small rooms where nobody performs" }),
  item: E.revealItem("small founder gatherings", false, f),
  pick: { whyMember: `why member ${i + 1}`, whyNow: `why now ${i + 1}` },
  again: false,
}));
const input = (o: any = {}) => ({ firstName: "Jordan", items, set: "three small rooms where nobody performs", leadWhy: "it fills first", memberBlock: "WHAT YOU KNOW ABOUT THEM\n- wants a room where they can drop their guard", feeling: null, thread: "Oct 10 09:12 They: long week, glad it's Friday", recent: "User said: long week", threadLive: false, ...o });
const good = {
  opening: "Three small rooms, none of them a stage.",
  items: [
    { n: 1, caption: "Founder Supper Club on Oct 24: eight founders around one table, no talks." },
    { n: 2, caption: "Quiet Builders Walk on Oct 24 is a slow Presidio loop, easy to talk while moving." },
    { n: 3, caption: "Studio Night at Gray Area on Oct 24, people making things side by side." },
  ],
  closing: "Which of the three feels most like your speed?",
};
const stub = (answers: any[]) => {
  const prompts: string[] = [];
  return { prompts, deps: { model: async (p: string) => { prompts.push(p); const a = answers[Math.min(prompts.length - 1, answers.length - 1)]; return typeof a === "string" ? a : JSON.stringify(a); } } };
};

// ---------------------------------------------------------------- the work order's test
{
  const s = stub([good]);
  const r: any = await B.composeBundle(input(), s.deps);
  check("test: a 3-item bundle is ONE model output (one call writes the opening, every caption and the closing)", s.prompts.length === 1 && r.calls === 1 && "messages" in r, r);
  check("it goes out as one thought, in order: opening, then each link and caption, then the closing", JSON.stringify(r.messages) === JSON.stringify([good.opening, "https://lu.ma/supper", good.items[0].caption, "https://lu.ma/walk", good.items[1].caption, "https://lu.ma/studio", good.items[2].caption, good.closing]), r.messages);
  const p = s.prompts[0];
  check("test: every caption knows the others: all three things, their facts and the rule, in the one prompt", finds.every((f) => p.includes(f.name)) && /Every caption knows the others: never give the same reason twice/.test(p) && /THING 1 \(it leads\)/.test(p) && /THING 3/.test(p));
  const same = { ...good, items: [{ n: 1, caption: "Founder Supper Club on Oct 24, a small room where you can drop your guard with other founders." }, { n: 2, caption: "Quiet Builders Walk on Oct 24, a small room where you can drop your guard with other founders." }, good.items[2]] };
  const s2 = stub([same, good]);
  const r2: any = await B.composeBundle(input(), s2.deps);
  check("test: the reason doesn't repeat: two captions with the same reason go back as one bundle, told which", s2.prompts.length === 2 && /captions 1 and 2 give the same reason/.test(s2.prompts[1]) && r2.messages?.includes(good.items[1].caption), s2.prompts[1]?.slice(-700));
  check("test: the closing question fits the set: it's the composer's own, written after the captions, about these three", r.closing === good.closing && /one closing question that comes out of what you just said about this set/.test(p));
}

{
  const weekly = { ...good, opening: "Three small rooms this week, none of them a stage." };
  const s = stub([weekly, good]);
  await B.composeBundle(input(), s.deps);
  check("the opening is held to the facts too ('this week' for things two weeks out goes back)", s.prompts.length === 2 && /the opening states something the things' facts don't back/.test(s.prompts[1]));
}

// ---------------------------------------------------------------- C2: no stock closing
{
  const stock = { ...good, closing: OFFER_FOLLOWUP_MANY[0] };
  const s = stub([stock, stock, stock]);
  const r: any = await B.composeBundle(input(), s.deps);
  check("C2: a stock line is refused as the closing, and never stood in for one: a closing that won't hold up is left out", /stock line/.test(s.prompts[1] ?? "") && r.closing === null && !r.messages.some((x: string) => OFFER_FOLLOWUP_MANY.includes(x)) && r.notes.some((n: string) => /closing left out/.test(n)), r);
  check("the old closing path is gone from dispatch (lineInVoice over the names, the stock pool as fallback)", !/lineInVoice|offerFollowUp\(/.test(src("harness/proactive.ts")));
}

// ---------------------------------------------------------------- C4: quality control inside, the shape never changes after writing
{
  const skip2 = { ...good, items: [good.items[0], { n: 2, skip: "it's a hike and they said no long walks" }, good.items[2]] };
  const two = { opening: "Two small rooms, neither of them a stage.", items: [good.items[0], { n: 2, caption: good.items[2].caption }], closing: "Either one your speed?" };
  const s = stub([skip2, two]);
  const r: any = await B.composeBundle(input(), s.deps);
  check("C4: a find the composer passes on is taken out and the rest composed again (every caption written for the set that goes)", s.prompts.length === 2 && !s.prompts[1].includes("Quiet Builders Walk") && r.included.length === 2 && r.dropped[0]?.item.item.name === "Quiet Builders Walk" && r.messages.length === 6, r);
  const longCap = "Quiet Builders Walk on Oct 24 " + "goes on and on ".repeat(30);
  const bad2 = { ...good, items: [good.items[0], { n: 2, caption: longCap }, good.items[2]] };
  const s3 = stub([bad2, bad2, two]);
  const r3: any = await B.composeBundle(input(), s3.deps);
  check("a sibling whose caption still fails after a redraft is taken out and the rest composed once more, never sent half-fixed", s3.prompts.length === 3 && !s3.prompts[2].includes("Quiet Builders Walk") && r3.included?.length === 2, { calls: s3.prompts.length, r3 });
  const leadSkip = { ...good, items: [{ n: 1, skip: "sold out" }, good.items[1], good.items[2]] };
  const r4: any = await B.composeBundle(input(), stub([leadSkip]).deps);
  check("a lead the composer passes on fails the bundle (nothing goes without what it leads with)", r4.fail && r4.leadSkipped === true);
  const r5: any = await B.composeBundle(input(), stub(["not json", "still not", "nope"]).deps);
  check("at most three model calls, then the day's text is given up (logged), never a stitched fallback", r5.fail && r5.calls === 3);
  check("captions are checked by code: names, length, identity, unbacked dates, no question, no link", /checkDraft\(c, \{ \.\.\.b\.item\.rules/.test(src("harness/bundleComposer.ts")) && /unbackedSpecifics\(c, b\.item\.facts\)/.test(src("harness/bundleComposer.ts")) && /stripUngroundedIdentity\(c, b\.item\.grounding\)/.test(src("harness/bundleComposer.ts")));
  const unbacked = { ...good, items: [{ n: 1, caption: "Founder Supper Club on Oct 30: eight founders around one table." }, good.items[1], good.items[2]] };
  const s6 = stub([unbacked, good]);
  await B.composeBundle(input(), s6.deps);
  check("a caption stating a date its facts don't back goes back to the composer", s6.prompts.length === 2 && /thing 1's caption says/.test(s6.prompts[1]), s6.prompts[1]?.slice(-500));
}

// ---------------------------------------------------------------- C5: the thread
{
  const p = B.composePrompt(input());
  check("C5: the composer sees the thread and the record", /THE THREAD[\s\S]*long week, glad it's Friday/.test(p) && /drop their guard/.test(p));
  const r: any = await B.composeBundle(input({ threadLive: true }), stub([{ wait: "they're mid-conversation about their cofounder" }]).deps);
  check("a live conversation about something else: the composer waits (dispatch defers the find an hour)", r.wait === "they're mid-conversation about their cofounder");
  const s = stub([{ wait: "hm" }, good]);
  const r2: any = await B.composeBundle(input({ threadLive: false }), s.deps);
  check("no live thread (a fact in code): there's nothing to wait on, so it writes the message", "messages" in r2 && /no live conversation to wait on/.test(s.prompts[1]));
  const s3 = stub([good, { ...good, connects: "they asked for small rooms just now" }]);
  const r3: any = await B.composeBundle(input({ threadLive: true }), s3.deps);
  check("live and going ahead: it must say how this follows from the thread", s3.prompts.length === 2 && /say in "connects"/.test(s3.prompts[1]) && "messages" in r3);
  const ps = src("harness/proactive.ts");
  check("dispatch reads 'live' from the record's last inbound, and defers the lead an hour on a wait", /const live = !!state\.lastInboundAt && state\.now\.getTime\(\) - state\.lastInboundAt\.getTime\(\) < B\.LIVE_MINUTES \* 60_000;/.test(ps) && /if \("wait" in res\) \{[\s\S]{0,400}UPDATE proactive_candidates SET due_at = \$2/.test(ps));
}

// ---------------------------------------------------------------- C3: the pick's why and its set view feed the composer
{
  const p = B.composePrompt(input());
  check("C3: each find carries the pick's why-member and why-now, apart, and the day's set is in", /why Co's daily pick chose it for them: why member 2\nwhy now: why now 2/.test(p) && /THE DAY'S SET \(what Co's pick saw in these together\)\nthree small rooms where nobody performs/.test(p) && /WHY THE FIRST ONE LEADS\nit fills first/.test(p));
  check("the picker is asked for its view of the set, and it's read", /add "set": one line on why these go together today/.test(src("services/sweepSelect.ts")) && S.parseSet('{"set":"two quiet rooms","verdicts":[]}') === "two quiet rooms" && S.parseSet('{"verdicts":[]}') === null);
  const plan = SH.planPicks([{ key: SH.shadowKey("X", null), verdict: "send", why: "they asked for small rooms (A2)", whyNow: "it's this Friday", name: "X", lastDay: null }] as any, [{ askId: "a1", askText: "x", fromProfile: false, match: { name: "X" } }] as any, []);
  check("the pick's why-member and why-now stay apart (member-safe), not flattened into one bullet", plan.queue.length === 1 && (plan.queue[0].whyMember === "they asked for small rooms" && plan.queue[0].whyNow === "it's this Friday"), plan.queue);
  check("they ride on the queued find (payload.pick), with the set only when the pick sent more than one", /pick: \{ whyMember: q\.whyMember, whyNow: q\.whyNow, set: plan\.queue\.length > 1 && set \? memberSafeWhy\(set\) : null \}/.test(src("services/sweepShadow.ts")) && /\.\.\.\(o\.pick \? \{ pick: o\.pick \} : \{\}\)/.test(src("services/eventSurfacingSweep.ts")));
}

// ---------------------------------------------------------------- C1: one composer in dispatch, no stitching
{
  const ps = src("harness/proactive.ts");
  check("C1: every find bundle (not a lone reminder) goes through the composer; each find is made ready before anything is written", /const bundled = c\.type === "event_offer" && !\(c\.payload as \{ reminder\?: boolean \}\)\.reminder;/.test(ps) && /await prepareOffer\(x, person\)/.test(ps) && /await B\.composeBundle\(\{/.test(ps));
  check("no code stitching: what goes out is what the composer wrote, and each find is ledgered with its own link and caption", /const outgoing = draft\.messages;/.test(ps) && /composed \? composed\.perItem\.slice\(1\) : \[\]/.test(ps) && !/outgoing = \[\.\.\.draft\.messages, \.\.\.extras\.flatMap/.test(ps));
  check("captions are no longer told they stand alone: the composer's prompt is one message with several things, not 'one message, one reason'", !/One message, one reason/.test(B.composePrompt(input())));
}

console.log(`phase C, assemble: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
