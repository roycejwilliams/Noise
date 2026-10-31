// An intro a member asks for by name (requestEventIntro), through the real tool and its own guard, in the fake world of
// evals/inroom/world.ts (the real guest-list lookup, double opt-in, direct ask and send, with a fake database and model). Zero tokens.
//   npx tsx evals/review/introTrace.ts
// 2026-10-28, Royce: "A last-name answer should continue the existing intro. Found/not-found results shouldn't leak through later
// memory or replies."
//   1. The documented two-step flow (first name, then lastName) reaches the request; the first step isn't counted as one. A
//      finished request still blocks a repeat for the same full name however it's written; a different Sarah is a different person.
//   2. What the asker's later turns can read is the same whether the person was found and asked, found and not reached, or not
//      found: the answer, the turn's facts, the guard's row, the lasting record, their memories, the names their lines are
//      stripped of, and the reply facts built from their memories.
import { W, reset, addMember, addEvent, ask } from "../inroom/world.js";

// Pinned to 18:00 UTC, as evals/inroom/flow.ts: a member with no time zone is texted 16:00-24:00 UTC, so the direct ask goes now.
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

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

const { default: pool } = await import("../../src/db/db.js");
// The guard's own reads of what it logged (once per person, per day) and the lasting record, over the world's query handler.
const world = (pool as any).query;
const cofacts: { owner: string; label: string }[] = [];
const ledgerRows: { relation: string; receipt: string }[] = [];
const proposalOf = (d: any) => (typeof d.proposal === "string" ? JSON.parse(d.proposal) : d.proposal) ?? {};
(pool as any).query = async (sql: string, p: any[] = []) => {
  const flat = sql.replace(/\s+/g, " ");
  if (/SELECT 1 FROM harness_decisions/.test(flat)) {
    // The guard's query, read the same way: the key it logged, or an older row's input.
    const key = (d: any) => { const pr = proposalOf(d); const i = pr.input ?? {}; return pr.person ?? (i.lastName ? `${String(i.personName ?? "").toLowerCase().split(" ")[0]} ${String(i.lastName).toLowerCase()}` : String(i.personName ?? "").toLowerCase()); };
    return { rows: W.decisions.filter((d) => d.decision === p[0] && d.user_id === p[1] && d.outcome === "act" && key(d) === p[2]).map(() => ({ x: 1 })) };
  }
  if (/COUNT\(\*\)::int AS n FROM harness_decisions/.test(flat)) return { rows: [{ n: W.decisions.filter((d) => d.decision === p[0] && d.user_id === p[1] && d.outcome === "act").length }] };
  // The action ledger's own rows (services/ledger.ts, object_key "L|...") are kept apart: tested in evals/ledger/dualWrite.ts.
  if (/INSERT INTO co_facts/i.test(flat) && String(p[3]).startsWith("L|")) { ledgerRows.push({ relation: String(p[1]), receipt: JSON.parse(String(p[7] ?? "{}")).receipt }); return { rows: [] }; }
  if (/INSERT INTO co_facts/i.test(flat)) { cofacts.push({ owner: p[0], label: String(p[3]) }); return { rows: [] }; }
  return world(sql, p);
};
(await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const MS = await import("../../src/services/memberSafeMemories.js");
const D = await import("../../src/services/deferredSends.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");
const worldSend = (sendblue as any).messages.send;

const log = console.log, err = console.error;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = err; } };
const settle = async (n: number) => { for (let i = 0; i < 200 && W.decisions.filter((d) => d.decision === "reply.requestEventIntro").length < n; i++) await new Promise((r) => setTimeout(r, 5)); };

type World = { jo: ReturnType<typeof addMember>; sarah: ReturnType<typeof addMember> };
const build = (): World => {
  reset();
  cofacts.length = 0;
  ledgerRows.length = 0;
  const jo = addMember({ first_name: "Jo", last_name: "Lee", intent: [ask("a cofounder for a climate startup")] });
  const sarah = addMember({ first_name: "Sarah", last_name: "Kim", intent: [ask("an engineer who has shipped hardware")] });
  addEvent({ api_id: "evt-trace", name: "Cue Night" }, [{ m: jo }, { m: sarah }]);
  W.checkinFollowups.push({ user_id: jo.id, event_api_id: "evt-trace", event_name: "Cue Night" });
  return { jo, sarah };
};
const turn = async (w: World, input: Record<string, string>, i: number) => {
  const facts: { kind: string; text: string }[] = [];
  const tools: any = createConversationTools({
    userId: w.jo.id, phoneNumber: w.jo.phone_number, resolvedContent: "yes please, I'd love an intro", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
    sendCoReply: async () => true, facts: { add: (kind: string, text: string) => facts.push({ kind, text }), text: () => "" },
  } as any).tools;
  const result = await quiet(() => tools.requestEventIntro.execute({ ...input, theirYes: "yes please", why: "they asked for the intro" }, { toolCallId: `t${i}`, messages: [] }));
  return { result, facts };
};
const guardRows = (w: World) => W.decisions.filter((d) => d.decision === "tool.requestEventIntro" && d.user_id === w.jo.id).map((d) => ({ outcome: d.outcome, action: d.action, person: proposalOf(d).person ?? null, input: proposalOf(d).input }));

// ------------------------------------------------------------ 1. the last name continues the intro
{
  const w = build();
  const first = await turn(w, { personName: "Sarah" }, 0);
  check("the first-name call asks for the last name, and the model reads exactly the note it read before (askedBack is the guard's, taken off)", first.result?.ok === true && /ask for the person's last name/.test(first.result?.note ?? "") && !("askedBack" in (first.result ?? {})), first.result);
  check("…logged as asked_back, not a request (outcome skip), and nothing goes in the lasting record", JSON.stringify(guardRows(w).map((r) => [r.outcome, r.action])) === JSON.stringify([["skip", "asked_back"]]) && cofacts.length === 0 && ledgerRows.every((r) => r.relation === "not_done" && r.receipt === "asked_back"), { rows: guardRows(w), cofacts, ledgerRows });
  const second = await turn(w, { personName: "Sarah", lastName: "Kim" }, 1);
  await settle(1);
  const askedSarah = W.sent.filter((s) => s.to === w.sarah.phone_number);
  check("their last-name answer continues the intro: no 'already requested', and Sarah gets the direct ask", second.result?.ok === true && !/already/i.test(JSON.stringify(second.result)) && askedSarah.length === 1, { second: second.result, sent: W.sent });
  check("…logged as the request under the full name, and recorded once as their ask", guardRows(w)[1]?.outcome === "act" && guardRows(w)[1]?.person === "sarah kim" && cofacts.filter((f) => /^took their ask for an intro to Sarah/.test(f.label)).length === 1, { rows: guardRows(w), cofacts });
  for (const [i, again] of [{ personName: "Sarah", lastName: "Kim" }, { personName: "Sarah Kim" }, { personName: "sarah", lastName: "KIM" }, { personName: "Sarah Kim", lastName: "Kim" }].entries()) {
    const r = await turn(w, again, 2 + i);
    check(`a finished request for Sarah Kim still blocks a repeat sent as ${JSON.stringify(again)}`, r.result?.ok === false && /Already requested for this person/.test(r.result?.error ?? ""), r.result);
  }
  const other = await turn(w, { personName: "Sarah", lastName: "Park" }, 9);
  check("a different Sarah is a different person: Sarah Park runs (and gets the one neutral answer)", other.result?.ok === true && /don't say whether you found them/.test(other.result?.note ?? ""), other.result);
  check("Sarah was asked once in all of that", W.sent.filter((s) => s.to === w.sarah.phone_number).length === 1, W.sent);
}
{
  // perDay counts requests only: three first-name steps leave the day's three requests untouched.
  const w = build();
  for (let i = 0; i < 3; i++) await turn(w, { personName: ["Ana", "Bea", "Cy"][i] }, i);
  const r = await turn(w, { personName: "Sarah", lastName: "Kim" }, 5);
  await settle(1);
  check("first-name steps don't use up the day's requests (perDay)", r.result?.ok === true && guardRows(w).filter((x) => x.outcome === "act").length === 1, { r: r.result, rows: guardRows(w) });
}
{
  // Rows logged before this change counted the first-name step as done ("Sarah", outcome act). They no longer block the first
  // step or the last-name answer.
  const w = build();
  W.decisions.push({ layer: 3, decision: "tool.requestEventIntro", user_id: w.jo.id, outcome: "act", action: "done", proposal: JSON.stringify({ ability: "event_intro", input: { personName: "Sarah" } }) });
  const a = await turn(w, { personName: "Sarah" }, 0);
  const b = await turn(w, { personName: "Sarah", lastName: "Kim" }, 1);
  await settle(1);
  check("an older first-name row blocks neither the first step nor the last-name answer", /last name/.test(a.result?.note ?? "") && b.result?.ok === true && W.sent.filter((s) => s.to === w.sarah.phone_number).length === 1, { a: a.result, b: b.result });
  const w2 = build();
  W.decisions.push({ layer: 3, decision: "tool.requestEventIntro", user_id: w2.jo.id, outcome: "act", action: "done", proposal: JSON.stringify({ ability: "event_intro", input: { personName: "Noor", lastName: "Haddad" } }) });
  const c = await turn(w2, { personName: "Noor Haddad" }, 2);
  check("an older full-name request (personName + lastName, no key logged) still blocks its repeat", c.result?.ok === false && /Already requested/.test(c.result?.error ?? ""), c.result);
}

// ------------------------------------------------------------ 2. found or not, the asker's later turns read the same
// What a later turn of Jo's can read: the tool's answer and facts, the guard's row, the lasting record, Jo's memories, the names
// Jo's lines are stripped of, the reply facts made from Jo's memories, and a line of Cue's that names Sarah as it would read back.
const trace = async (w: World, input: Record<string, string>) => {
  const t = await turn(w, input, 0);
  await settle(1);
  const mems = W.memoriesWritten.filter((m) => m.user_id === w.jo.id);
  const names = await MS.memberNamesStrict(w.jo.id);
  const line = "Co replied: Happy to. If Sarah is someone I know from that night, I'll check whether she's open to an intro too.";
  return {
    answer: t.result,
    facts: t.facts,
    guard: guardRows(w).map((r) => ({ ...r, input: { ...r.input, personName: "·", lastName: "·" }, person: r.person ? "·" : null })),
    cofacts: cofacts.filter((f) => f.owner === w.jo.id).map((f) => f.label.replace(/Sarah( \w+)?/, "·")),
    memories: mems.map((m) => `${m.memory_type}: ${m.content}`),
    names,
    introFacts: MS.introFacts(mems.map((m) => ({ content: m.content, memory_type: m.memory_type }))),
    cueLine: MS.safeMemory("text_exchange", line, names),
  };
};
const internal = () => W.decisions.filter((d) => d.decision === "reply.requestEventIntro").map((d) => `${d.outcome}/${d.action}`);
{
  const nf = build();
  const notFound = await trace(nf, { personName: "Sarah", lastName: "Park" });
  const notFoundInternal = internal();

  const f = build();
  const found = await trace(f, { personName: "Sarah", lastName: "Kim" });
  const foundAsked = W.sent.filter((s) => s.to === f.sarah.phone_number).length;
  const foundInternal = internal();
  const foundPair = W.pairs.find((p) => [p.a_id, p.b_id].includes(f.sarah.id));

  // Found, but the ask to Sarah doesn't go (the send fails): before, Jo got "The intro ask Cue said it would send Sarah didn't go
  // out" (deferredSends.ts noteIntroAskNotSent).
  const u = build();
  (sendblue as any).messages.send = async (body: any) => { if (body.number === u.sarah.phone_number) throw new Error("carrier rejected"); return worldSend(body); };
  const unreached = await quiet(() => trace(u, { personName: "Sarah", lastName: "Kim" }));
  (sendblue as any).messages.send = worldSend;
  const unreachedInternal = internal();
  const unreachedAsked = W.sent.filter((s) => s.to === u.sarah.phone_number).length;

  // The honest status is only in the internal row (not found is logged there, the ask's own send failure isn't: requestIntroToNamedGuest
  // has handed it on by then).
  check("the world really took three paths: not found, found and asked, found and not reached", JSON.stringify(notFoundInternal) === JSON.stringify(["skip/not_found"]) && foundAsked === 1 && JSON.stringify(foundInternal) === JSON.stringify(["act/requested"]) && unreachedInternal.length === 1 && unreachedAsked === 0 && foundPair?.origin === "member", { notFoundInternal, foundAsked, foundInternal, unreachedInternal, unreachedAsked });
  for (const k of Object.keys(notFound) as (keyof typeof notFound)[]) {
    check(`found and asked reads the same as not found to a later turn: ${k}`, JSON.stringify(found[k]) === JSON.stringify(notFound[k]), { found: found[k], notFound: notFound[k] });
    check(`found but not reached reads the same as not found to a later turn: ${k}`, JSON.stringify(unreached[k]) === JSON.stringify(notFound[k]), { unreached: unreached[k], notFound: notFound[k] });
  }
  check("…and none of it says Sarah is a member, was found, or said anything", !/another member|said yes to being introduced|didn't go out/.test(JSON.stringify(found) + JSON.stringify(unreached)), { found, unreached });

  // Once both say yes the intro is made, and only then does Jo's record name it: Sarah answers yes to the direct ask.
  build();
  const both = build();
  await trace(both, { personName: "Sarah", lastName: "Kim" });
  const H = await import("../../src/services/eventGuestMatchHandoff.js");
  await quiet(() => H.handleMatchNudgeReply("evt-trace", "Cue Night", "interested", { user_id: both.sarah.id, first_name: "Sarah", phone_number: both.sarah.phone_number!, email: both.sarah.email }, { user_id: both.jo.id, first_name: "Jo", phone_number: both.jo.phone_number!, email: both.jo.email }));
  const joMems = W.memoriesWritten.filter((m) => m.user_id === both.jo.id);
  const joNames = await MS.memberNamesStrict(both.jo.id);
  check("once both said yes the intro email goes, Jo's record says so, and Sarah's name is stripped from Jo's lines again", joMems.some((m) => m.memory_type === "event_intro_email_sent" && /Sarah/.test(m.content)) && MS.introFacts(joMems.map((m) => ({ content: m.content, memory_type: m.memory_type }))).some((x) => /intro email connecting/.test(x)) && joNames.includes("Sarah"), { joMems, joNames });
}
{
  // The note that an ask didn't go out still reaches an asker Cue told about the person itself (a pair Cue suggested).
  const w = build();
  W.pairs.push({ id: "p1", event_id: "evt-trace", a_id: [w.jo.id, w.sarah.id].sort()[0], b_id: [w.jo.id, w.sarah.id].sort()[1], origin: "co", state: "asked", created_at: new Date(), intro_sent_at: null });
  await quiet(() => D.afterHandlers.event_direct_ask({ eventId: "evt-trace", candidateId: w.sarah.id, askerId: w.jo.id }, "failed"));
  const coNote = W.memoriesWritten.filter((m) => m.user_id === w.jo.id && /didn't go out/.test(m.content)).length;
  W.pairs[0].origin = "member";
  W.memoriesWritten.length = 0;
  await quiet(() => D.afterHandlers.event_direct_ask({ eventId: "evt-trace", candidateId: w.sarah.id, askerId: w.jo.id }, "failed"));
  const memberNote = W.memoriesWritten.filter((m) => m.user_id === w.jo.id && /didn't go out/.test(m.content)).length;
  check("an ask that didn't go out is still noted for a pair Cue suggested, and never for one the member asked for by name", coNote === 1 && memberNote === 0, { coNote, memberNote });
}

// ------------------------------------------------------------ 3. one reading of a name (review of #294)
{
  const { personKey } = await import("../../src/agent/toolGuard.js");
  const H = await import("../../src/services/eventGuestMatchHandoff.js");
  check("the guard reads a hyphenated name the way the lookup does: 'Mary-Kate Olsen' and 'Mary-Kate' + 'Olsen' are one person, Mary-Ann another", personKey({ personName: "Mary-Kate Olsen" }) === personKey({ personName: "Mary-Kate", lastName: "Olsen" }) && personKey({ personName: "Mary-Kate", lastName: "Olsen" }) !== personKey({ personName: "Mary-Ann", lastName: "Olsen" }), [personKey({ personName: "Mary-Kate Olsen" }), personKey({ personName: "Mary-Kate", lastName: "Olsen" }), personKey({ personName: "Mary-Ann", lastName: "Olsen" })]);
  check("a curly apostrophe (an iPhone's default) is the same name as a straight one, to the guard", ["O’Brien", "O‘Brien", "Oʼ Brien".replace(" ", ""), "O′Brien", "O＇Brien", "O´Brien"].every((l) => personKey({ personName: "Liam", lastName: l }) === "liam o'brien"), ["O’Brien", "O′Brien", "O´Brien"].map((l) => personKey({ personName: "Liam", lastName: l })));
  // Through the real guard: Mary-Kate's finished request doesn't block Mary-Ann, and does block 'Mary-Kate Olsen'.
  const w = build();
  await turn(w, { personName: "Mary-Kate", lastName: "Olsen" }, 0);
  const kate = await turn(w, { personName: "Mary-Kate Olsen" }, 1);
  const ann = await turn(w, { personName: "Mary-Ann", lastName: "Olsen" }, 2);
  check("…and through the guard: Mary-Kate's request blocks 'Mary-Kate Olsen' and not Mary-Ann", /Already requested/.test(kate.result?.error ?? "") && ann.result?.ok === true, { kate: kate.result, ann: ann.result });
  // The lookup: a stored "O'Brien" is found when they type "O’Brien".
  reset();
  const asker = addMember({ first_name: "Jo", last_name: "Lee" });
  const liam = addMember({ first_name: "Liam", last_name: "O'Brien" });
  addEvent({ api_id: "evt-apos", name: "Cue Night" }, [{ m: asker }, { m: liam }]);
  W.checkinFollowups.push({ user_id: asker.id, event_api_id: "evt-apos", event_name: "Cue Night" });
  const curly = await quiet(() => H.resolveNamedEventGuest(asker.id, "Liam", "O’Brien"));
  const straight = await quiet(() => H.resolveNamedEventGuest(asker.id, "Liam O'Brien"));
  check("the guest-list lookup finds a stored O'Brien whether they type a curly or a straight apostrophe", "target" in curly && curly.target.user_id === liam.id && "target" in straight && straight.target.user_id === liam.id, { curly, straight });
}

// ------------------------------------------------------------ 4. a deploy waits for the ask (review of #294)
// The found path asks in the background after answering. A SIGTERM right after the answer waits for it (services/shutdown.ts track),
// so the ask and its internal row aren't cut off while the guard has already logged the request. Last: shutdown stays on.
{
  const w = build();
  const S = await import("../../src/services/shutdown.js");
  const t = await turn(w, { personName: "Sarah", lastName: "Kim" }, 0);
  const inFlight = S.inflightCount();
  await quiet(() => S.gracefulShutdown("SIGTERM", null, 5_000));
  const row = W.decisions.filter((d) => d.decision === "reply.requestEventIntro").map((d) => `${d.outcome}/${d.action}`);
  check("the background ask is tracked: shutdown waits for it, and the ask and its internal row are done before it ends", t.result?.ok === true && inFlight >= 1 && JSON.stringify(row) === JSON.stringify(["act/requested"]) && W.sent.filter((x) => x.to === w.sarah.phone_number).length === 1 && S.inflightCount() === 0, { inFlight, row, sent: W.sent });
}

console.log(`intro trace: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
