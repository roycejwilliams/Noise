// Phase C, assemble (Royce, 2026-10-10). Zero tokens: the composer's model is stubbed.
//   The work order's test: a 3-item bundle is one model output, each find standing alone (its link, then its own description, never
//   grouped, Royce 2026-10-13), Co's closing line tied back to knowing them, and the closing question fitting the set. Plus C1 one composer (no stitching), C2 the closing comes from the composed thought (no stock
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
  // Royce, 2026-10-13: each find stands alone, its link then its own description, never grouped; then Co's closing line (tied back
  // to knowing them); then one closing question. Nothing comes before the first find's link.
  check("each find stands alone, in order: its link, then its own description; then Co's closing line; then the one question", JSON.stringify(r.messages) === JSON.stringify(["https://lu.ma/supper", good.items[0].caption, "https://lu.ma/walk", good.items[1].caption, "https://lu.ma/studio", good.items[2].caption, good.opening, good.closing]), r.messages);
  check("never grouped: nothing before the first link, and no description names another find", r.messages[0] === "https://lu.ma/supper" && good.items.every((it, k) => finds.every((f, q) => q === k || !it.caption.includes(f.name))) && r.messages.indexOf(good.opening) > r.messages.lastIndexOf(good.items[2].caption), r.messages);
  const p = s.prompts[0];
  check("the prompt asks for standalone finds and Co's own closing line, with its guardrail", finds.every((f) => p.includes(f.name)) && /THING 1 \(it leads\)/.test(p) && /THING 3/.test(p) && /No opening line/.test(p) && /Each caption describes its own thing only/.test(p) && /Never mention, compare with or group it with the other things/.test(p) && /After the last thing, end with your own line/.test(p) && /never invent a feeling or a situation, and never name what someone is unless they told you/.test(p) && !/Every caption knows the others/.test(p) && !/An opening line: one short sentence on why these, together/.test(p));
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
  check("they ride on the queued find (payload.pick), with the set only when the pick sent more than one", /pick: \{ whyMember: q\.whyMember, whyNow: q\.whyNow, set: plan\.queue\.length > 1 && set \? memberSafeWhy\(set, ids\) : null, \.\.\.\(plan\.queue\.length > 1 && set \? \{ setKeys: setKeys\(\) \} : \{\}\), \.\.\.\(q\.tierNext \? \{ tierPick: true, tierNext: q\.tierNext \} : \{\}\) \}/.test(src("services/sweepShadow.ts")) && /\.\.\.\(o\.pick \? \{ pick: o\.pick \} : \{\}\)/.test(src("services/eventSurfacingSweep.ts")));
}

// ---------------------------------------------------------------- C1: one composer in dispatch, no stitching
{
  const ps = src("harness/proactive.ts");
  check("C1: every find bundle (not a lone reminder) goes through the composer; each find is made ready before anything is written", /const bundled = c\.type === "event_offer" && !\(c\.payload as \{ reminder\?: boolean \}\)\.reminder;/.test(ps) && /await prepareOffer\(x, person\)/.test(ps) && /await B\.composeBundle\(\{/.test(ps));
  check("no code stitching: what goes out is what the composer wrote, and each find is ledgered with its own link and caption", /const outgoing = draft\.messages;/.test(ps) && /composed \? composed\.perItem\.slice\(1\) : \[\]/.test(ps) && !/outgoing = \[\.\.\.draft\.messages, \.\.\.extras\.flatMap/.test(ps));
  check("captions are no longer told they stand alone: the composer's prompt is one message with several things, not 'one message, one reason'", !/One message, one reason/.test(B.composePrompt(input())));
}

// ---------------------------------------------------------------- review of #135
{
  const prof = (name: string, url: string) => E.revealItem("where they're headed: meeting founders", true, m(name, url, "small and unhurried"));
  const pi = [prof("Founder Supper Club", "https://lu.ma/supper"), prof("Quiet Builders Walk", "https://lu.ma/walk")].map((item, i) => ({ candidate: cand(`p${i}`, {}, null), item, pick: null, again: false }));
  const d = { opening: "Since you're a founder, I was thinking about you and these two you asked for.", items: [{ n: 1, caption: "Founder Supper Club on Oct 24, a small table." }, { n: 2, caption: "Quiet Builders Walk on Oct 24, a slow loop." }], closing: "As a founder, which one you asked about fits?", connects: null };
  const c = B.checkComposed(d as any, input({ items: pi }) as any);
  check("review #1: the opening and closing are held to the captions' guards (identity, 'thinking about you', 'you asked')", c.problems.some((x) => x.at === "opening") && c.problems.some((x) => x.at === "closing"), c.problems);
  check("review #2: choosePick's free text never reaches the composer; only the code's own expiring-find reason does", /leadWhy: picked\.source === "code" \? picked\.reason : null,/.test(src("harness/proactive.ts")));
  const keyed = (keys: string[], set: string) => items.map((b, i) => ({ ...b, candidate: { ...b.candidate, targetKey: keys[i], payload: { ...b.candidate.payload, pick: { whyMember: "", whyNow: "", set, setKeys: ["k1", "k2", "k3"] } } } }));
  check("review #3: the set line only for a bundle of exactly the finds the pick chose together", B.setFor(keyed(["k1", "k2", "k3"], "s")) === "s" && B.setFor(keyed(["k1", "k2", "kX"], "s")) === null && B.setFor(keyed(["k1", "k2", "k3"], "s").slice(0, 2)) === null && B.setFor(keyed(["k1"], "s").slice(0, 1)) === null);
  const skip2 = { ...good, items: [good.items[0], { n: 2, skip: "no" }, good.items[2]] };
  const two = { opening: "Two small rooms, neither of them a stage.", items: [good.items[0], { n: 2, caption: good.items[2].caption }], closing: "Either one your speed?" };
  const sk = stub([skip2, two]);
  await B.composeBundle(input(), sk.deps);
  check("review #3: once the composer takes a find out, the set line is dropped (it described a different set)", /THE DAY'S SET/.test(sk.prompts[0]) && !/THE DAY'S SET/.test(sk.prompts[1]));
  const now = new Date("2026-10-10T18:00:00Z");
  check("review #4: waits are capped and never run past a find's expiry", B.mayWait([{ waits: 0, expiresAt: null }], now) && !B.mayWait([{ waits: B.MAX_WAITS, expiresAt: null }], now) && !B.mayWait([{ waits: 0, expiresAt: new Date(now.getTime() + 30 * 60_000) }], now));
  const nw = stub([{ wait: "mid-conversation" }, { ...good, connects: "acknowledged their week first" }]);
  const rnw: any = await B.composeBundle(input({ threadLive: true, mayWait: false }), nw.deps);
  check("review #4: when it can't wait, a live thread is acknowledged instead, never waited on again", "messages" in rnw && /can't wait any longer/.test(nw.prompts[0]) && /this can't wait any longer: write it/.test(nw.prompts[1]));
  check("review #4: a wait moves the whole bundle and counts it", /WHERE id = ANY\(\$1::bigint\[\]\) AND status = 'pending'`, \[items\.map\(\(b\) => b\.candidate\.id\), at\]\)/.test(src("harness/proactive.ts")) && /jsonb_set\(payload, '\{waits\}'/.test(src("harness/proactive.ts")));
  check("review #5: shared logistics (a day, a time, free entry) aren't a repeated reason", !B.sameReason("Jazz at Pier 23 on Saturday evening, free entry and a live quartet.", "Gallery Night on Saturday evening, free entry, wine and new work.", "Jazz at Pier 23", "Gallery Night") && B.sameReason("Founder Supper Club, a small room where you can drop your guard with other founders.", "Quiet Builders Walk, a small room where you can drop your guard with other founders.", "Founder Supper Club", "Quiet Builders Walk"));
  check("review #6: a failed composition is logged as a failed draft, so the proactive_blocked monitor counts it", /`draft failed checks: composer: \$\{res\.fail\}`/.test(src("harness/proactive.ts")) && /reason LIKE 'draft failed checks%'/.test(src("harness/monitor.ts")) && /name: "composer_checks"/.test(src("harness/proactive.ts")));
  const offer = B.checkComposed({ ...good, closing: "Want me to save you a spot at one?" } as any, input() as any);
  check("review #7: a closing that offers to do something is refused (it asks which, or whether any)", offer.problems.some((x) => x.at === "closing" && /offers to do something/.test(x.why)));
  const pr = B.composePrompt(input());
  check("review #8: the prompt names CONFIRMED_FACTS and says member rules are never a reason to skip", /THE THINGS \(CONFIRMED_FACTS for each/.test(pr) && /The member rules further down are never a reason to skip; fit is/.test(pr));
  check("review #9: the composer's call is bounded (timeout and output cap)", /maxOutputTokens: 4000, providerOptions: \{ anthropic: \{ effort: "medium" \} \}, abortSignal: AbortSignal\.timeout\(45_000\)/.test(src("harness/bundleComposer.ts")));
  check("review #10: a dry run writes nothing on the new path", /if \(!opts\.dryRun\) await dropCandidate\(registry, c, "skipped", prep\.skip\);/.test(src("harness/proactive.ts")) && /if \(!opts\.dryRun\) \{\s*for \(const a of failedBundleActions\(res, c\.attempts\)\)/.test(src("harness/proactive.ts")));
}

console.log(`phase C, assemble: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
