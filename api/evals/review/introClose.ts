// The one neutral close for an intro a member asks for by name (requestEventIntro), 7 days on, through the real tool, its guard,
// the real double opt-in and the real proactive gates, in the fake world of evals/inroom/world.ts. Zero tokens.
//   npx tsx evals/review/introClose.ts
// 2026-10-28, Royce: "give every unresolved request the same neutral closure after a consistent window, regardless of whether
// someone was found, declined or stayed silent. Don't expose the reason. Don't promise to keep looking unless the member asks."
//   1. The words: fixed, one line (option A, approved 2026-10-28), nothing about what happened, no offer to keep looking, passes the
//      proactive draft checks; the name is only ever the one the member wrote, else the no-name line.
//   2. Found and declined, found and silent, found and not reached, not found: the same request record a turn could read, the same
//      candidate due at the same moment, the same gate verdicts and the same text. Nothing is queued before 7 days. Both said yes
//      (the intro email went): no close. The intro email going after the close was queued: nothing goes.
//   3. Exactly once: the job run twice, a crash between queueing and marking, a close already sent.
//   4. Delivery is the normal proactive path: caps and pauses apply (not an "answer"), a hard day holds it (timing only, it stays
//      pending), it is never handed to a task (payload first), and sent or dropped, the request row is forgotten.
//   5. Review of #307: an intro made through network_introductions is never closed; a failed onSent leaves no row behind (the
//      hourly sweep) and still nothing goes twice; a safety hold delays it, never drops it.
//   6. Re-review: an archived member's requests are deleted instead of queued; a member who texted STOP keeps theirs.
import { W, reset, addMember, addEvent, ask, uuid } from "../inroom/world.js";

// Pinned to 18:00 UTC, as evals/review/introTrace.ts: a member with no time zone is texted 16:00-24:00 UTC, so the direct ask goes now.
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
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };

const DAY = 86_400_000;
const { default: pool } = await import("../../src/db/db.js");
const world = (pool as any).query;
const cofacts: { owner: string; label: string }[] = [];
const ledgerRows: { relation: string; receipt: string }[] = [];
// intro_requests (services/introRequestClose.ts), answered the way Postgres would.
const requests: any[] = [];
let failMarkOnce = false;
const proposalOf = (d: any) => (typeof d.proposal === "string" ? JSON.parse(d.proposal) : d.proposal) ?? {};
let failForgetOnce = false;
// Read the way the statement reads it: the event pair's intro email, and the network intro only when the statement asks about it.
const introduced = (r: any, flat: string) => {
  if (!r.target_id) return false;
  const [lo, hi] = [r.user_id, r.target_id].sort();
  return W.pairs.some((p) => p.a_id === lo && p.b_id === hi && p.intro_sent_at) ||
    (/FROM network_introductions n WHERE n\.person_a_id = LEAST\(r\.user_id, r\.target_id\) AND n\.person_b_id = GREATEST\(r\.user_id, r\.target_id\) AND \(n\.status = 'introduced' OR n\.introduced_at IS NOT NULL\)/.test(flat) &&
      W.networkIntros.some((n) => n.a === lo && n.b === hi && (n.status === "introduced" || n.introduced_at)));
};
const handler = async (sql: string, p: any[] = []) => {
  const flat = sql.replace(/\s+/g, " ");
  if (/INSERT INTO intro_requests/.test(flat)) {
    requests.push({ id: uuid(), user_id: p[0], name_said: p[1], event_id: p[2], target_id: p[3], asked_at: new Date(p[4]), close_due_at: new Date(p[5]), close_queued_at: null });
    return { rows: [] };
  }
  if (/FROM intro_requests r WHERE r\.close_due_at <= \$1 AND r\.close_queued_at IS NULL/.test(flat)) {
    return { rows: requests.filter((r) => +r.close_due_at <= +new Date(p[0]) && !r.close_queued_at).sort((a, b) => +a.close_due_at - +b.close_due_at).map((r) => ({ id: r.id, user_id: r.user_id, close_due_at: r.close_due_at, introduced: introduced(r, flat) })) };
  }
  if (/UPDATE intro_requests SET close_queued_at/.test(flat)) {
    if (failMarkOnce) { failMarkOnce = false; throw new Error("connection reset (a restart mid-run)"); }
    for (const r of requests) if (r.id === p[0] && !r.close_queued_at) r.close_queued_at = new Date(p[1]);
    return { rows: [] };
  }
  if (/SELECT r\.name_said, .* FROM intro_requests r WHERE r\.id = \$1/.test(flat)) return { rows: requests.filter((r) => r.id === p[0]).map((r) => ({ name_said: r.name_said, introduced: introduced(r, flat) })) };
  if (/DELETE FROM intro_requests r WHERE r\.close_queued_at IS NOT NULL AND r\.close_queued_at <= \$1 AND NOT EXISTS \(SELECT 1 FROM proactive_candidates c WHERE c\.user_id = r\.user_id AND c\.target_key = 'intro_close:' \|\| r\.id::text AND c\.status = 'pending'\)/.test(flat)) {
    for (let i = requests.length - 1; i >= 0; i--) {
      const r = requests[i];
      if (r.close_queued_at && +r.close_queued_at <= +new Date(p[0]) && !W.candidates.some((c) => c.user_id === r.user_id && c.target_key === `intro_close:${r.id}` && c.status === "pending")) requests.splice(i, 1);
    }
    return { rows: [] };
  }
  if (/^DELETE FROM intro_requests r USING users u WHERE u\.id = r\.user_id AND u\.archived_at IS NOT NULL$/.test(flat.trim())) {
    for (let i = requests.length - 1; i >= 0; i--) if (W.members.get(requests[i].user_id)?.archived_at) requests.splice(i, 1);
    return { rows: [] };
  }
  if (/DELETE FROM intro_requests WHERE id = \$1/.test(flat)) {
    if (failForgetOnce) { failForgetOnce = false; throw new Error("connection reset (onSent's delete)"); } const i = requests.findIndex((r) => r.id === p[0]); if (i >= 0) requests.splice(i, 1); return { rows: [] }; }
  if (/SELECT 1 FROM harness_decisions/.test(flat)) {
    const key = (d: any) => { const pr = proposalOf(d); const i = pr.input ?? {}; return pr.person ?? (i.lastName ? `${String(i.personName ?? "").toLowerCase().split(" ")[0]} ${String(i.lastName).toLowerCase()}` : String(i.personName ?? "").toLowerCase()); };
    return { rows: W.decisions.filter((d) => d.decision === p[0] && d.user_id === p[1] && d.outcome === "act" && key(d) === p[2]).map(() => ({ x: 1 })) };
  }
  if (/COUNT\(\*\)::int AS n FROM harness_decisions/.test(flat)) return { rows: [{ n: W.decisions.filter((d) => d.decision === p[0] && d.user_id === p[1] && d.outcome === "act").length }] };
  // The action ledger's own rows (services/ledger.ts, object_key "L|...") are kept apart: tested in evals/ledger/dualWrite.ts.
  if (/INSERT INTO co_facts/i.test(flat) && String(p[3]).startsWith("L|")) { ledgerRows.push({ relation: String(p[1]), receipt: JSON.parse(String(p[7] ?? "{}")).receipt }); return { rows: [] }; }
  if (/INSERT INTO co_facts/i.test(flat)) { cofacts.push({ owner: p[0], label: String(p[3]) }); return { rows: [] }; }
  return world(sql, p);
};
(pool as any).query = handler;
// enqueueCandidate's transaction: the world's client, with intro_requests and the rest answered the same way.
const worldConnect = (pool as any).connect;
(pool as any).connect = async () => { const c = await worldConnect(); const q = c.query; return { ...c, query: (sql: string, p?: any[]) => (/intro_requests/.test(sql) ? handler(sql, p) : q(sql, p)) }; };

(await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const IC = await import("../../src/services/introRequestClose.js");
const P = await import("../../src/harness/proactive.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const { PAYLOAD_FIRST_EXEMPT } = await import("../../src/harness/payloadFirst.js");
const { kindOf } = await import("../../src/services/kindRestraint.js");
const H = await import("../../src/services/eventGuestMatchHandoff.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");
const worldSend = (sendblue as any).messages.send;

const log = console.log, err = console.error;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = err; } };
const settle = async (n: number) => { for (let i = 0; i < 200 && W.decisions.filter((d) => d.decision === "reply.requestEventIntro").length < n; i++) await new Promise((r) => setTimeout(r, 5)); };

// ------------------------------------------------------------ 1. the words
{
  const line = IC.introCloseText("Sarah");
  const bare = IC.introCloseText("");
  check("the close is one fixed line naming the person by the name they gave", line === "The intro to Sarah you asked about didn't come together, so I've closed it." && bare === "The intro you asked about didn't come together, so I've closed it.", { line, bare });
  for (const t of [line, bare]) {
    check(`it says nothing about what happened: ${t}`, !/\b(found|member|declin|pass(ed)?|said no|never (heard|replied|answered)|not interested|busy|guest list|wasn't there|no one|nobody|couldn't (find|reach))\b/i.test(t), t);
    check(`it never offers to keep looking or try again: ${t}`, !/\b(keep|still|again|later|look(ing)?|watch|let you know|if (you|they)|anyone else|someone else)\b/i.test(t), t);
    check(`it passes the proactive draft checks: ${t}`, P.checkDraft(t, IC.INTRO_CLOSE_RULES).every((k) => k.pass), P.checkDraft(t, IC.INTRO_CLOSE_RULES).filter((k) => !k.pass));
  }
  check("the name is kept only when it is a word of theirs", IC.nameFromTheirWords("Sarah", ["I met sarah at the dinner"]) === "Sarah" && IC.nameFromTheirWords("sarah kim", ["Sarah's the one"]) === "Sarah" && IC.nameFromTheirWords("Sarah", ["the founder from the dinner"]) === "" && IC.nameFromTheirWords("Sara", ["I met Sarah"]) === "" && IC.nameFromTheirWords("", ["Sarah"]) === "", [IC.nameFromTheirWords("Sarah", ["I met sarah at the dinner"]), IC.nameFromTheirWords("sarah kim", ["Sarah's the one"])]);
  check("their lines are the Member lines of the exchange, never Cue's", JSON.stringify(IC.memberLinesOf("Member: hi Sarah\nCue: Sarah Kim?\nMember: yes")) === JSON.stringify(["hi Sarah", "yes"]));
  check("the name is their own word, first letter up, letters only", IC.nameSaid("sarah kim") === "Sarah" && IC.nameSaid("  Mary-Kate  Olsen") === "Mary-Kate" && IC.nameSaid("O’Brien!") === "O’Brien" && IC.nameSaid("") === "" && IC.nameSaid("??") === "", [IC.nameSaid("sarah kim"), IC.nameSaid("  Mary-Kate  Olsen"), IC.nameSaid("O’Brien!")]);
}

// ------------------------------------------------------------ 2. every outcome, the same close at the same moment
type World = { jo: ReturnType<typeof addMember>; sarah: ReturnType<typeof addMember> };
const build = (): World => {
  reset();
  cofacts.length = 0;
  ledgerRows.length = 0;
  requests.length = 0;
  const jo = addMember({ first_name: "Jo", last_name: "Lee", intent: [ask("a cofounder for a climate startup")] });
  const sarah = addMember({ first_name: "Sarah", last_name: "Kim", intent: [ask("an engineer who has shipped hardware")] });
  addEvent({ api_id: "evt-close", name: "Cue Night" }, [{ m: jo }, { m: sarah }]);
  W.checkinFollowups.push({ user_id: jo.id, event_api_id: "evt-close", event_name: "Cue Night" });
  return { jo, sarah };
};
// Jo named Sarah in her own earlier text; this message is the yes. recentExchange overrides it (a name Jo never wrote).
const SAID_SARAH = "Member: I met Sarah at Cue Night, could you connect us?\nCue: Happy to look into it. What's her last name?";
const turn = async (w: World, input: Record<string, string>, recentExchange: string = SAID_SARAH) => {
  const tools: any = createConversationTools({
    userId: w.jo.id, phoneNumber: w.jo.phone_number, resolvedContent: "yes please, I'd love an intro", recentExchange, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
    sendCoReply: async () => true, facts: { add: () => {}, text: () => "" },
  } as any).tools;
  const result = await quiet(() => tools.requestEventIntro.execute({ ...input, theirYes: "yes please", why: "they asked for the intro" }, { toolCallId: "t0", messages: [] }));
  await settle(1);
  return result;
};
const person = (w: World) => ({ user_id: w.sarah.id, first_name: "Sarah", phone_number: w.sarah.phone_number!, email: w.sarah.email });
const asker = (w: World) => ({ user_id: w.jo.id, first_name: "Jo", phone_number: w.jo.phone_number!, email: w.jo.email });
const pickState = (c: any, now: Date, extra: Record<string, unknown> = {}): any => ({ now, timezone: null, optedOut: false, candidates: [c], sends: [], lastInboundAt: new Date(now.getTime() - 2 * DAY), needsCare: false, joinedAt: new Date(now.getTime() - 60 * DAY), ...extra });
const asCandidate = (row: any): any => ({ id: "1", userId: row.user_id, type: row.type, targetKey: row.target_key, topicKey: row.topic_key, summary: row.summary, priority: P.TYPE_POLICY.intro_close.priority, dueAt: row.due_at, expiresAt: row.expires_at, payload: row.payload, attempts: 0, createdAt: row.due_at });

// One outcome: the ask, what happens on Sarah's side, then the job just before and just after 7 days, the gates at the due moment,
// and the text the send would carry. Everything compared is relative to the moment Jo asked; ids are normalized.
const run = async (outcome: "not_found" | "declined" | "silent" | "unreached" | "both_yes") => {
  const w = build();
  if (outcome === "unreached") (sendblue as any).messages.send = async (body: any) => { if (body.number === w.sarah.phone_number) throw new Error("carrier rejected"); return worldSend(body); };
  const t0 = Date.now();
  const answer = await turn(w, outcome === "not_found" ? { personName: "Sarah", lastName: "Park" } : { personName: "Sarah", lastName: "Kim" });
  const t1 = Date.now();
  // The moment of the ask, as recorded (the tool's own clock, inside the call).
  const askedAt = requests[0] ? +requests[0].asked_at : t0;
  (sendblue as any).messages.send = worldSend;
  if (outcome === "declined") await quiet(() => H.handleMatchNudgeReply("evt-close", "Cue Night", "not_interested", person(w), asker(w)));
  if (outcome === "both_yes") await quiet(() => H.handleMatchNudgeReply("evt-close", "Cue Night", "interested", person(w), asker(w)));
  const jos = () => W.memoriesWritten.filter((m) => m.user_id === w.jo.id).map((m) => `${m.memory_type}: ${m.content}`);
  const memoriesBefore = jos();
  const sentToJoBefore = W.sent.filter((s) => s.to === w.jo.phone_number).length;
  // What a turn could read of the request record: everything but the internal target (read only by the close check).
  const record = requests.map((r) => ({ user: r.user_id === w.jo.id, name_said: r.name_said, inTheCall: +r.asked_at >= t0 && +r.asked_at <= t1, due: +r.close_due_at - +r.asked_at }));
  const early = await quiet(() => IC.queueDueIntroCloses(new Date(askedAt + 7 * DAY - 60_000)));
  const earlyCandidates = W.candidates.length;
  const queued = await quiet(() => IC.queueDueIntroCloses(new Date(askedAt + 7 * DAY + 10 * 60_000)));
  const cands = W.candidates.filter((c) => c.user_id === w.jo.id);
  const norm = cands.map((c) => ({ type: c.type, key: String(c.target_key).replace(/[0-9a-f-]{36}$/, "<id>"), topic: String(c.topic_key).replace(/[0-9a-f-]{36}$/, "<id>"), summary: c.summary, payloadKeys: Object.keys(c.payload ?? {}), due: +c.due_at - askedAt, expires: c.expires_at, status: c.status }));
  const c = cands[0] ? asCandidate(cands[0]) : null;
  const dueAt = c ? c.dueAt : null;
  const gates = c ? { before: P.evaluateCandidates(pickState(c, new Date(dueAt.getTime() - 60_000))).perCandidate[0].checks.filter((k: any) => !k.pass).map((k: any) => k.name), at: P.evaluateCandidates(pickState(c, dueAt)).eligible.length } : null;
  const draft = c ? await proactiveRegistry.intro_close.draft(c, { userId: w.jo.id, firstName: "Jo", phoneNumber: w.jo.phone_number!, city: null, timezone: null }) : null;
  return { w, answer, record, early, earlyCandidates, queued, norm, c, gates, draft, memoriesBefore, memoriesAfter: jos(), sentToJoBefore, cofacts: cofacts.filter((f) => f.owner === w.jo.id).map((f) => f.label.replace(/Sarah( \w+)?/, "·")) };
};

{
  const notFound = await run("not_found");
  const declined = await run("declined");
  const declinedPair = W.pairs.find((p) => p.origin === "member");
  const silent = await run("silent");
  const silentAsked = W.sent.filter((s) => s.to === silent.w.sarah.phone_number).length;
  const unreached = await run("unreached");
  const unreachedAsked = W.sent.filter((s) => s.to === unreached.w.sarah.phone_number).length;
  const bothYes = await run("both_yes");
  const bothPair = W.pairs.find((p) => p.origin === "member");

  check("the world really took each path: not found (no pair), declined (the pair declined), silent (asked, no answer), not reached (the ask failed), both yes (intro email sent)",
    declinedPair?.state === "declined" && silentAsked === 1 && unreachedAsked === 0 && !!bothPair?.intro_sent_at,
    { declinedPair: declinedPair?.state, silentAsked, unreachedAsked, both: bothPair?.state });
  check("every request was recorded once, at the moment of the ask", [notFound, declined, silent, unreached, bothYes].every((o) => o.record.length === 1 && o.record[0].user && o.record[0].inTheCall), [notFound, declined, silent, unreached].map((o) => o.record));
  check("nothing is queued before 7 days, whatever happened", [notFound, declined, silent, unreached, bothYes].every((o) => o.early === 0 && o.earlyCandidates === 0), [notFound, declined, silent, unreached, bothYes].map((o) => o.early));
  check("at 7 days, one close is queued for each unresolved request", [notFound, declined, silent, unreached].every((o) => o.queued === 1 && o.norm.length === 1), [notFound, declined, silent, unreached].map((o) => o.norm));
  const text = "The intro to Sarah you asked about didn't come together, so I've closed it.";
  check("the close is the fixed line", !!notFound.draft && "messages" in notFound.draft && JSON.stringify(notFound.draft.messages) === JSON.stringify([text]), notFound.draft);
  check("it is due exactly 7 days after the ask, never expires, and isn't eligible a minute before (only the due check holds it)", notFound.norm[0]?.due === 7 * DAY && notFound.norm[0]?.expires === null && JSON.stringify(notFound.gates?.before) === JSON.stringify(["due"]) && notFound.gates?.at === 1, { norm: notFound.norm, gates: notFound.gates });
  for (const [label, o] of [["found and declined", declined], ["found and silent", silent], ["found and not reached", unreached]] as const) {
    for (const k of ["answer", "record", "norm", "gates", "draft", "memoriesBefore", "memoriesAfter", "cofacts", "sentToJoBefore"] as const) {
      check(`${label} reads the same as not found: ${k}`, JSON.stringify(o[k]) === JSON.stringify(notFound[k]), { [label]: o[k], notFound: notFound[k] });
    }
  }
  check("both said yes (the intro email went): no close, and the request is forgotten", bothYes.queued === 0 && bothYes.norm.length === 0 && requests.length === 0, { queued: bothYes.queued, requests });
}

// The intro email goes after the close was queued but before it's sent: nothing goes, and the request is forgotten.
{
  const w = build();
  const askedAt = Date.now();
  await turn(w, { personName: "Sarah", lastName: "Kim" });
  await quiet(() => IC.queueDueIntroCloses(new Date(askedAt + 7 * DAY + 60_000)));
  await quiet(() => H.handleMatchNudgeReply("evt-close", "Cue Night", "interested", person(w), asker(w)));
  const c = asCandidate(W.candidates[0]);
  const draft = await proactiveRegistry.intro_close.draft(c, { userId: w.jo.id, firstName: "Jo", phoneNumber: w.jo.phone_number!, city: null, timezone: null });
  check("an intro made after the close was queued: the close is skipped at send time", "skip" in draft && /intro was made/.test(draft.skip), draft);
  await proactiveRegistry.intro_close.onDropped!(c, "skipped", "the intro was made");
  check("…and dropped, the request row is forgotten", requests.length === 0, requests);
}

// A name Jo never wrote (Cue said it, or the model passed it on its own): the close names no one.
{
  const w = build();
  const askedAt = Date.now();
  await turn(w, { personName: "Sarah", lastName: "Kim" }, "Member: the founder I met at Cue Night, could you connect us?\nCue: Was that Sarah Kim?");
  check("a name only Cue said is never recorded as theirs", requests.length === 1 && requests[0].name_said === "", requests.map((r) => r.name_said));
  await quiet(() => IC.queueDueIntroCloses(new Date(askedAt + 7 * DAY + 60_000)));
  const c = asCandidate(W.candidates[0]);
  const draft = await proactiveRegistry.intro_close.draft(c, { userId: w.jo.id, firstName: "Jo", phoneNumber: w.jo.phone_number!, city: null, timezone: null });
  check("…and the close is the no-name line", "messages" in draft && JSON.stringify(draft.messages) === JSON.stringify(["The intro you asked about didn't come together, so I've closed it."]), draft);
}

// ------------------------------------------------------------ 3. exactly once
{
  const w = build();
  const askedAt = Date.now();
  await turn(w, { personName: "Sarah", lastName: "Park" });
  const at = new Date(askedAt + 7 * DAY + 60_000);
  await quiet(() => IC.queueDueIntroCloses(at));
  await quiet(() => IC.queueDueIntroCloses(at));
  check("the job run twice queues one close", W.candidates.filter((c) => c.type === "intro_close").length === 1, W.candidates);

  const w2 = build();
  await turn(w2, { personName: "Sarah", lastName: "Park" });
  failMarkOnce = true;
  await quiet(() => IC.queueDueIntroCloses(at));
  const afterCrash = { candidates: W.candidates.length, marked: !!requests[0]?.close_queued_at };
  await quiet(() => IC.queueDueIntroCloses(at));
  check("a crash between queueing and marking: the next run queues the same close again, harmlessly (still one), and marks it", afterCrash.candidates === 1 && !afterCrash.marked && W.candidates.length === 1 && !!requests[0]?.close_queued_at, { afterCrash, now: W.candidates.length });

  // Sent: the ledger has its key. Even if its row were somehow back to unqueued, it is never queued or sent again.
  W.candidates[0].status = "sent";
  W.proactiveSends.push({ user_id: w2.jo.id, type: "intro_close", target_key: W.candidates[0].target_key });
  requests[0].close_queued_at = null;
  await quiet(() => IC.queueDueIntroCloses(at));
  check("a close already sent is never queued again (the ledger's key)", W.candidates.length === 1 && W.candidates[0].status === "sent", W.candidates);
  await proactiveRegistry.intro_close.onSent!(asCandidate(W.candidates[0]), { userId: w2.jo.id, firstName: "Jo", phoneNumber: "", city: null, timezone: null }, []);
  check("sent, the request row is forgotten", requests.length === 0, requests);
}

// ------------------------------------------------------------ 4. the normal delivery path
{
  const w = build();
  const askedAt = Date.now();
  await turn(w, { personName: "Sarah", lastName: "Kim" });
  await quiet(() => IC.queueDueIntroCloses(new Date(askedAt + 7 * DAY + 60_000)));
  const c = asCandidate(W.candidates[0]);
  const now = new Date(c.dueAt.getTime() + 60_000);
  check("it is not an answer: the caps, the unanswered pause and the engagement pace apply", !P.isAnswering(c));
  check("no kind restraint stops it, and it is never handed to a task instead (payload first)", kindOf("intro_close", c.payload) === null && PAYLOAD_FIRST_EXEMPT.has("intro_close"));
  const hard = P.evaluateCandidates(pickState(c, now, { needsCare: true, moodHold: { state: "held", hold: true, heldHours: 2 } }));
  check("on a hard day it waits (emotional_timing), as timing only: no drop, the candidate stays pending", hard.eligible.length === 0 && hard.perCandidate[0].checks.some((k: any) => k.name === "emotional_timing" && !k.pass) && W.candidates[0].status === "pending", hard.perCandidate[0].checks.filter((k: any) => !k.pass));
  const okay = P.evaluateCandidates(pickState(c, now, { needsCare: true, moodHold: { state: "released_okay", hold: false, heldHours: 5 } }));
  check("…and goes once they're okay again", okay.eligible.length === 1, okay.perCandidate[0].checks.filter((k: any) => !k.pass));
  const paced = P.evaluateCandidates(pickState(c, now, { sends: [{ type: "companion", targetKey: "x", topicKey: null, sentAt: new Date(now.getTime() - 60 * 60_000), exempt: false }] }));
  check("spacing from another text Cue sent holds it, it doesn't drop it", paced.eligible.length === 0 && paced.perCandidate[0].checks.some((k: any) => !k.pass && /spacing|daily_cap/.test(k.name)), paced.perCandidate[0].checks.filter((k: any) => !k.pass));
  const night = P.evaluateCandidates({ ...pickState(c, new Date(new Date(now).setUTCHours(9, 0, 0, 0) + DAY)) });
  check("quiet hours hold it (a member with no zone, 09:00 UTC)", !night.userOk, night.userChecks);
}

// ------------------------------------------------------------ 5. review of #307: network intros, a failed onSent, the safety hold
{
  // An intro made the network way (network_introductions) is never "closed".
  const w = build();
  const askedAt = Date.now();
  await turn(w, { personName: "Sarah", lastName: "Kim" });
  const [lo, hi] = [w.jo.id, w.sarah.id].sort();
  W.networkIntros.push({ a: lo, b: hi, status: "introduced", introduced_at: new Date() } as any);
  const n = await quiet(() => IC.queueDueIntroCloses(new Date(askedAt + 7 * DAY + 60_000)));
  check("5. introduced through a network intro: no close, and the request is forgotten", n === 0 && !W.candidates.some((c) => c.type === "intro_close") && requests.length === 0, { n, requests });
}
{
  // The same, made after the close was queued: nothing goes at send time.
  const w = build();
  const askedAt = Date.now();
  await turn(w, { personName: "Sarah", lastName: "Kim" });
  await quiet(() => IC.queueDueIntroCloses(new Date(askedAt + 7 * DAY + 60_000)));
  const [lo, hi] = [w.jo.id, w.sarah.id].sort();
  W.networkIntros.push({ a: lo, b: hi, status: "introduced", introduced_at: new Date() } as any);
  const draft = await proactiveRegistry.intro_close.draft(asCandidate(W.candidates[0]), { userId: w.jo.id, firstName: "Jo", phoneNumber: w.jo.phone_number!, city: null, timezone: null });
  check("5. a network intro made after queueing: skipped at send time", "skip" in draft && /intro was made/.test(draft.skip), draft);
}
{
  // onSent's delete failed: the row isn't left forever, and nothing goes twice.
  const w = build();
  const askedAt = Date.now();
  await turn(w, { personName: "Sarah", lastName: "Park" });
  const at = new Date(askedAt + 7 * DAY + 60_000);
  await quiet(() => IC.queueDueIntroCloses(at));
  W.candidates[0].status = "sent";
  W.proactiveSends.push({ user_id: w.jo.id, type: "intro_close", target_key: W.candidates[0].target_key });
  failForgetOnce = true;
  await quiet(() => proactiveRegistry.intro_close.onSent!(asCandidate(W.candidates[0]), { userId: w.jo.id, firstName: "Jo", phoneNumber: "", city: null, timezone: null }, []).catch(() => {}));
  const stuck = requests.length;
  await quiet(() => IC.queueDueIntroCloses(new Date(at.getTime() + 30 * 60_000)));
  const withinHour = requests.length;
  await quiet(() => IC.queueDueIntroCloses(new Date(at.getTime() + 2 * 3600_000)));
  check("5. onSent failed: the row stays only until the next run past an hour, then goes", stuck === 1 && withinHour === 1 && requests.length === 0, { stuck, withinHour, left: requests.length });
  check("5. …and the close was never queued again (exactly once)", W.candidates.filter((c) => c.type === "intro_close").length === 1);
  // A close still pending is never swept.
  const w2 = build();
  const asked2 = Date.now();
  await turn(w2, { personName: "Sarah", lastName: "Park" });
  const at2 = new Date(asked2 + 7 * DAY + 60_000);
  await quiet(() => IC.queueDueIntroCloses(at2));
  await quiet(() => IC.queueDueIntroCloses(new Date(at2.getTime() + 3 * DAY)));
  check("5. a close still pending keeps its row", requests.length === 1 && W.candidates[0].status === "pending", requests);
}
{
  // A safety hold delays it, the same for every outcome, never drops it.
  const w = build();
  const askedAt = Date.now();
  await turn(w, { personName: "Sarah", lastName: "Park" });
  await quiet(() => IC.queueDueIntroCloses(new Date(askedAt + 7 * DAY + 60_000)));
  const c = asCandidate(W.candidates[0]);
  const now = new Date(c.dueAt.getTime() + 60_000);
  const held = P.evaluateCandidates(pickState(c, now, { safetyHold: true }));
  check("5. a safety hold holds it (delay only: it stays pending, never expires)", P.SAFETY_HOLD_ALSO.has("intro_close") && held.eligible.length === 0 && held.perCandidate[0].checks.some((k: any) => k.name === "safety_hold" && !k.pass) && W.candidates[0].status === "pending" && c.expiresAt === null, held.perCandidate[0].checks.filter((k: any) => !k.pass));
  check("5. …and goes once it lifts", P.evaluateCandidates(pickState(c, now)).eligible.length === 1);
}

// ------------------------------------------------------------ 6. re-review: an archived member's requests are deleted, a STOP member's kept
{
  const w = build();
  const askedAt = Date.now();
  await turn(w, { personName: "Sarah", lastName: "Park" });
  W.members.get(w.jo.id)!.archived_at = new Date().toISOString();
  const n = await quiet(() => IC.queueDueIntroCloses(new Date(askedAt + 7 * DAY + 60_000)));
  check("6. archived: no close is queued, and the request (the name they said, the target) is deleted", n === 0 && !W.candidates.some((c) => c.type === "intro_close") && requests.length === 0, { n, requests });
  const w2 = build();
  const asked2 = Date.now();
  await turn(w2, { personName: "Sarah", lastName: "Park" });
  W.members.get(w2.jo.id)!.sms_opted_out = true;
  const n2 = await quiet(() => IC.queueDueIntroCloses(new Date(asked2 + 7 * DAY + 60_000)));
  check("6. a member who texted STOP keeps theirs: queued, delayed by the send's own gates, never dropped", n2 === 1 && requests.length === 1 && W.candidates.some((c) => c.type === "intro_close" && c.status === "pending"), { n2, requests: requests.length });
}

console.log(`intro close: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
