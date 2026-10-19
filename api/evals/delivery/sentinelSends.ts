// No path sends a placeholder (2026-10-19, found by the room simulation): a draft that came back as "SKIP", empty or whitespace (or
// another "nothing to send" word) is refused at the send layer, logged with its rule and the kind of text (services/sentinelBody.ts;
// harness/proactive.ts sendWithLedger and sendExempt; services/sendblue.ts, the one wrapper every message passes through).
// Zero tokens: the model, the database and Sendblue are stubbed (the in-room fake world), nothing is sent.
//   npx tsx evals/delivery/sentinelSends.ts
import { readFileSync } from "fs";

// The real send wrapper, kept before the fake world replaces it (evals/inroom/world.ts stands in for Sendblue's send).
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
const { default: sendblue } = await import("../../src/services/sendblue.js");
const realSend = sendblue.messages.send;
const { W, reset, addMember, addEvent, ask, check, results } = await import("../inroom/world.js");

// The clock is pinned to 18:00 UTC (as evals/inroom/flow.ts): inside local hours, so a direct ask goes now.
{
  const RealDate = Date;
  const pinned = new RealDate();
  pinned.setUTCHours(18, 0, 0, 0);
  const offset = pinned.getTime() - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...a: any[]) {
      super(...((a.length ? a : [RealDate.now() + offset]) as [any]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  (globalThis as any).Date = PinnedDate;
}

const B = await import("../../src/services/sentinelBody.js");
const P = await import("../../src/harness/proactive.js");
const D = await import("../../src/services/deferredSends.js");
const S = await import("../../src/services/eventScoring.js");
const H = await import("../../src/services/eventGuestMatchHandoff.js");
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ================================================================ 1. what a placeholder is (pure)
for (const body of ["SKIP", "skip", "Skip.", "**SKIP**", "\"SKIP\"", "SKIP: nothing specific to say", "SKIP - no reason", "", "   ", "\n\t", "\u200B", "NONE", "null", "undefined", "[object Object]", "N/A", "{}"]) {
  check(`placeholder: ${JSON.stringify(body)}`, B.sentinelRule(body) !== null, B.sentinelRule(body));
}
for (const body of ["Skip the line at Tartine tonight?", "None of these fit? I can look again.", "Nothing much on Friday. Want me to look at Saturday?", "Null hypothesis night at the Exploratorium, Thursday.", "Ok", "Yes!"]) {
  check(`a real text: ${JSON.stringify(body)}`, B.sentinelRule(body) === null, B.sentinelRule(body));
}
check("not a string, or no messages at all: refused", B.sentinelRule(undefined) === "not text" && B.sentinelRule(null) === "not text" && B.sentinelIn([])?.rule === "no messages");
check("a send with one placeholder among real messages is refused, naming which", B.sentinelIn(["https://lu.ma/x", "SKIP"])?.index === 1 && B.sentinelIn(["One.", "Two."]) === null);

// ================================================================ 2. the direct ask (the room sim's path): the draft says SKIP
{
  reset();
  const jordan = addMember({ first_name: "Jordan", intent: [ask("a seed investor for a climate hardware startup")] });
  const ellis = addMember({ first_name: "Ellis", intent: [ask("climate hardware founders to back at seed", "offering")] });
  addEvent({ api_id: "evt-skip", name: "Cue Supper" }, [{ m: jordan }, { m: ellis }]);
  W.scorer = (askText, cand) => ({ score: /seed investor/.test(askText) && cand.first_name === "Ellis" ? 85 : 0, share: true });
  W.scoringDebounce.clear();
  await S.scoreGuestListForEvent("evt-skip");
  await new Promise((r) => setTimeout(r, 30));
  // The direct ask's draft comes back as the model's SKIP.
  const worldFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const body = String(init?.body ?? "");
    if (/api\.anthropic\.com/.test(String(url instanceof URL ? url.href : url)) && /who's also going, said they'd like to be introduced/.test(body)) {
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: "SKIP" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return worldFetch(url, init);
  }) as typeof fetch;
  try {
    const asM = (m: any) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number!, email: m.email });
    const before = W.sent.filter((s) => s.to === ellis.phone_number).length;
    await H.handleMatchNudgeReply("evt-skip", "Cue Supper", "interested", asM(jordan), asM(ellis));
    await new Promise((r) => setTimeout(r, 30));
    const toEllis = W.sent.filter((s) => s.to === ellis.phone_number);
    check("2a. Jordan's yes, the direct ask to Ellis drafted as SKIP: nothing is texted to Ellis", toEllis.length === before && !W.sent.some((s) => /^\W*skip\W*$/i.test(String(s.content ?? ""))), toEllis);
    const logged = W.decisions.find((d) => d.decision === "proactive.sentinelBody");
    check("2b. ... it's logged with the rule and the kind of text (direct_ask)", !!logged && logged.action === "direct_ask" && /placeholder "SKIP"/.test(String(logged.reason)), W.decisions.filter((d) => /sentinel/.test(d.decision)));
    check("2c. ... and no ledger row was claimed for it", !W.proactiveSends.some((s) => s.type === "direct_ask"));
  } finally {
    globalThis.fetch = worldFetch;
  }
}

// ================================================================ 3. the other send paths
{
  reset();
  const m = addMember({ first_name: "Noor" });
  const now = new Date();
  const cand: any = { id: "c1", userId: m.id, type: "companion", targetKey: "companion:week", topicKey: "companion:week", summary: "", priority: 50, dueAt: now, expiresAt: null, payload: {}, attempts: 0, createdAt: now };
  const person: any = { userId: m.id, firstName: "Noor", phoneNumber: m.phone_number, timezone: "America/Los_Angeles" };
  const r1: any = await P.sendWithLedgerForTests(cand, person, ["  "]);
  check("3a. a paced text (sendWithLedger) whose draft is whitespace: refused as a failed check, nothing claimed or sent", r1.sent === false && r1.failed?.[0]?.name === "sentinel_body" && W.sent.length === 0 && W.proactiveSends.length === 0, r1);
  const r2: any = await P.sendWithLedgerForTests(cand, person, ["A good one for Saturday."], {}, [{ candidate: { ...cand, id: "c2", type: "event_offer" }, messages: ["SKIP"] }]);
  check("3b. ... a riding offer whose text is SKIP refuses the whole send", r2.sent === false && r2.failed?.[0]?.name === "sentinel_body" && W.sent.length === 0, r2);
  const r3 = await P.sendExempt({ userId: m.id, phoneNumber: m.phone_number!, type: "task_update" as any, targetKey: "task:1", messages: ["Here's the shortlist.", "SKIP"] });
  check("3c. an exempt text (sendExempt) with a SKIP second message: refused, said why, nothing sent", r3.sent === false && /^sentinel body: message 2 is placeholder/.test(r3.reason ?? "") && W.sent.length === 0, r3);
  check("3d. ... logged with its kind", W.decisions.some((d) => d.decision === "proactive.sentinelBody" && d.action === "task_update"));
  check("3e. a held text refused this way is skipped, never retried (deferred sends)", D.outcomeOf({ sent: false, reason: "sentinel body: message 1 is empty" }, false) === "skipped");
}

// ================================================================ 4. the one wrapper every message passes through
{
  const TEST = "+14155550123"; // test range (services/testNumbers.ts): never really sent
  const refused = async (body: any) => realSend(body).then(() => false, (e: any) => /not a text, refusing to send/.test(String(e?.message)));
  check("4a. the wrapper refuses SKIP, empty and whitespace from any path", (await refused({ number: TEST, content: "SKIP", from_number: "+10000000000" })) && (await refused({ number: TEST, content: "", from_number: "+10000000000" })) && (await refused({ number: TEST, content: "   ", from_number: "+10000000000" })));
  const ok = await realSend({ number: TEST, content: "", media_url: "https://example.com/card.vcf", from_number: "+10000000000" } as any).then(() => true, (e: any) => String(e?.message));
  check("4b. ... a media-only send (a card, a voice note) may have no words", ok === true, ok);
  const real = await realSend({ number: TEST, content: "Skip the line at Tartine tonight?", from_number: "+10000000000" } as any).then(() => true, (e: any) => String(e?.message));
  check("4c. ... and a real text that starts with 'Skip' goes", real === true, real);
  check("4d. the guard runs before the meta-commentary check and the number check", src("services/sendblue.ts").indexOf("const placeholder = sentinelRule(content") < src("services/sendblue.ts").indexOf("if (content && isLeakedMetaCommentary(content))"));
}

console.log(`\nsentinel sends: ${results.total - results.failed}/${results.total} passed`);
process.exit(results.failed ? 1 : 0);
