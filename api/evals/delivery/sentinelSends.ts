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
for (const body of ["SKIP", "skip", "Skip.", "**SKIP**", "\"SKIP\"", "SKIP: nothing specific to say", "SKIP - no reason", "SKIP (no news)", "**SKIP**: nothing to add", "", "   ", "\n\t", "\u200B", "NONE", "None.", "null", "undefined", "[object Object]", "N/A", "N/A.", "{}"]) {
  check(`placeholder: ${JSON.stringify(body)}`, B.sentinelRule(body) !== null, B.sentinelRule(body));
}
// Review of #265 (2026-10-19): real advice that starts "Skip" and a reason is a text; only SKIP in capitals is the model's skip.
for (const body of ["Skip the line at Tartine tonight?", "None of these fit? I can look again.", "Nothing much on Friday. Want me to look at Saturday?", "Null hypothesis night at the Exploratorium, Thursday.", "Ok", "Yes!", "Skip: the 7pm is sold out, the 9pm still has room.", "Skip - it's a bargain-bin crowd.", "Skip (honestly) and go to Thursday's instead.", "skip: the line's an hour long", "Skip \u2014 it moved to next week."]) {
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
  const err = await realSend({ number: TEST, content: "SKIP", from_number: "+10000000000" }).then(() => null, (e: any) => e);
  check("4e. ... its refusal carries a stable code, not just a message", err?.code === B.SENTINEL_REFUSAL && B.SENTINEL_REFUSAL === "sentinel_body", err?.code);
  const SB = await import("../../src/services/sendblue.js");
  check("4f. the inline reply gives up on it (the send layer refused it), like the breaker and the meta-commentary guard", SB.refusedBySendLayer(err) && SB.refusedBySendLayer(new Error("sendblue: send breaker open for ...0123, refusing to send")) && SB.refusedBySendLayer(new Error("sendblue: outbound content looked like leaked model meta-commentary, refusing to send: x")));
  check("4g. ... but not on Sendblue refusing the inline reply itself (that one goes again plain)", !SB.refusedBySendLayer(Object.assign(new Error("reply_to not supported on this line"), { status: 400 })) && !SB.refusedBySendLayer(null));
  const route = src("routes/sendblue.ts");
  const inlineCatch = route.slice(route.indexOf("await sendblue.messages.send({ ...body, reply_to:"), route.indexOf("inlineRefused.add(phone);"));
  check("4h. sendCoReply's inline catch gives up on a send-layer refusal before it turns inline replies off or retries plain", /if \(refusedBySendLayer\(err\)\) \{\n\s+console\.error\(`sendCoReply failed for \$\{phone\}:`, err\?\.message \?\? err\);\n\s+return false;\n\s+\}/.test(inlineCatch));
  check("4d. the guard runs before the meta-commentary check and the number check", src("services/sendblue.ts").indexOf("const placeholder = sentinelRule(content") < src("services/sendblue.ts").indexOf("if (content && isLeakedMetaCommentary(content))"));
}

// ================================================================ 5. a placeholder draft is dropped, not re-drafted every tick (review of #265)
{
  const c: any = { id: "c1", type: "companion" };
  const e1: any = { id: "e1", type: "event_offer" };
  const e2: any = { id: "e2", type: "event_offer" };
  check("5a. the placeholder is traced to whose draft it came from", P.placeholderCandidate(0, c, ["SKIP"], []) === c && P.placeholderCandidate(1, c, ["Hi."], [{ candidate: e1, messages: ["SKIP"] }]) === e1 && P.placeholderCandidate(2, c, ["Hi."], [{ candidate: e1, messages: ["One."] }, { candidate: e2, messages: ["SKIP"] }]) === e2);
  reset();
  const m = addMember({ first_name: "Noor" });
  const now = new Date();
  const cand: any = { id: "c9", userId: m.id, type: "companion", targetKey: "companion:week", topicKey: "companion:week", summary: "", priority: 50, dueAt: now, expiresAt: null, payload: {}, attempts: 0, createdAt: now };
  const person: any = { userId: m.id, firstName: "Noor", phoneNumber: m.phone_number, timezone: "America/Los_Angeles" };
  const r: any = await P.sendWithLedgerForTests(cand, person, ["SKIP"]);
  check("5b. sendWithLedger names the candidate whose draft was the placeholder", r.sent === false && r.placeholderOf?.id === "c9", r);
  // The drop itself: skipped with the reason, logged with ids only.
  const { default: pool } = await import("../../src/db/db.js");
  const real = (pool as any).query;
  const updates: any[][] = [];
  (pool as any).query = async (sql: string, p: any[] = []) => (/^\s*UPDATE proactive_candidates SET status = \$2, skip_reason = \$3/.test(sql) ? (updates.push(p), { rows: [], rowCount: 1 }) : real(sql, p));
  const dropped: string[] = [];
  const reg: any = { companion: { onDropped: async (x: any, status: string, why: string) => void dropped.push(`${x.id}:${status}:${why}`) } };
  await P.dropPlaceholder(reg, m.id, cand);
  (pool as any).query = real;
  check("5c. the candidate is skipped for good with the reason sentinel_body", updates.some((u) => u[0] === "c9" && u[1] === "skipped" && u[2] === "sentinel_body") && dropped.includes("c9:skipped:sentinel_body"), updates);
  const log = W.decisions.find((d) => d.decision === "proactive.sentinelBody.dropped");
  check("5d. ... logged with ids only (the candidate's id and kind, no words)", !!log && log.reason === "sentinel_body" && JSON.stringify(typeof log.proposal === "string" ? JSON.parse(log.proposal) : log.proposal) === JSON.stringify({ candidateId: "c9", kind: "companion" }), log);
  check("5e. the dispatch drops it when the send refused a placeholder (no re-draft next tick)", /if \(result\.placeholderOf\) await dropPlaceholder\(registry, userId, result\.placeholderOf\);/.test(src("harness/proactive.ts")));
}

// ================================================================ 6. a placeholder draft is the model's SKIP (review of #265)
// generate() reads every placeholder with the same rule (sentinelRule), so "**SKIP**" or "N/A" is the registry's "model chose SKIP"
// and gets its handling (with #261: one capped mood wait, never a cancel), not the send layer's placeholder drop.
{
  const { default: pool } = await import("../../src/db/db.js");
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const real = (pool as any).query;
  for (const draft of ["**SKIP**", "N/A", "SKIP: nothing specific"]) {
    const writes: { sql: string; params: any[] }[] = [];
    const cand = { id: "c-ph", user_id: "ph-u", type: "companion", target_key: "companion:ph", topic_key: "companion:ph", summary: "check-in", priority: 50, due_at: new Date(Date.now() - 60_000), expires_at: null, payload: {}, attempts: 0, created_at: new Date(Date.now() - 3_600_000) };
    (pool as any).query = async (sql: string, params: any[] = []) => {
      const q = String(sql).trim();
      if (/\bINSERT INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE FROM\b/i.test(q)) { writes.push({ sql: q.slice(0, 120), params }); return { rows: [], rowCount: 1 }; }
      if (/FROM users u LEFT JOIN co_profiles/i.test(q)) return { rows: [{ first_name: "Noor", phone_number: "+14155550199", sms_opted_out: false, city: "Honolulu" }] };
      if (/FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending'/i.test(q)) return { rows: [cand] };
      return { rows: [], rowCount: 0 };
    };
    const sentBefore = W.sent.length;
    const log = console.log, err = console.error;
    console.log = () => {};
    console.error = () => {};
    P.setProactiveModelForTests((async () => draft) as any);
    let threw: string | null = null;
    try { await P.dispatchForUser(proactiveRegistry, "ph-u", { ignorePacing: true }); } catch (e: any) { threw = String(e?.message ?? e); }
    P.setProactiveModelForTests(null);
    console.log = log;
    console.error = err;
    (pool as any).query = real;
    const said = JSON.stringify(writes.map((w) => w.params));
    check(`6. a draft of ${JSON.stringify(draft)} is the model's SKIP: nothing sent, logged as "model chose SKIP", never as a placeholder`, !threw && W.sent.length === sentBefore && /model chose SKIP/.test(said) && !/sentinel|placeholder/i.test(said) && !writes.some((w) => /proactive_sends/.test(w.sql)), { threw, writes: writes.map((w) => `${w.sql} ${JSON.stringify(w.params).slice(0, 160)}`) });
  }
}

console.log(`\nsentinel sends: ${results.total - results.failed}/${results.total} passed`);
process.exit(results.failed ? 1 : 0);
