// Never assume a member went (Royce, permanent rule, 2026-11-04). A follow-up about a find needs evidence: "how was it / who did you
// meet" only with evidence they went (a Luma door scan at Noise's own event, their own word, an arrival Cue saw); only evidence they
// meant to go (they said so, or registered) gets the neutral "did you end up going?"; no intent signal, or a no: nothing is sent.
// Layer 1: the real scheduling (park, arm, drop, enqueue) and the real debrief draft on a fake store and a fake model. Zero tokens, no
// DB, nothing sent.
//   npx tsx evals/followups/evidence.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.FOLLOWUPS_BY_CO = "off";
const { default: pool } = await import("../../src/db/db.js");
const R = await import("../../src/services/recommendationOutcome.js");
const O = await import("../../src/services/outcomes.js");
const CF = await import("../../src/services/eventCheckinFollowUp.js");
const P = await import("../../src/harness/proactive.js");
const { proactiveRegistry: registry } = await import("../../src/harness/proactiveRegistry.js");
const { followUpEvidence } = await import("../../src/services/followUpEvidence.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

// ---------------------------------------------------------------- the fake store
const u = "00000000-0000-4000-8000-0000000000e1";
type Row = { id: string; user_id: string; ask_text: string; tier: number; match_name: string; match: any; send_at: Date; harness_status: string | null; drop_reason: string | null };
const world = { rof: [] as Row[], outcomes: [] as { item_key: string; result: string; provenance: string | null }[], reactions: [] as string[], queued: [] as any[], presence: false, walkin: false, nextId: 1 };
const reset = () => Object.assign(world, { rof: [], outcomes: [], reactions: [], queued: [], presence: false, walkin: false, nextId: 1 });
const keyOf = (r: Row) => [r.match.event_api_id ? `event:${r.match.event_api_id}` : null, `name:${r.match_name.toLowerCase()}`];
const handle = async (sql: string, p: any[] = []) => {
  if (/INSERT INTO recommendation_outcome_followups/.test(sql)) {
    const m = JSON.parse(p[4]);
    if (world.rof.some((r) => r.user_id === p[0] && ((m.event_api_id && r.match.event_api_id === m.event_api_id) || r.match_name.toLowerCase() === String(p[3]).toLowerCase()))) return { rows: [], rowCount: 0 };
    const sendAt = p[5] ? new Date(`${p[5]}T00:00:00Z`) : new Date(Date.now() + p[6] * 86_400_000);
    world.rof.push({ id: `rof-${world.nextId++}`, user_id: p[0], ask_text: p[1], tier: p[2], match_name: p[3], match: m, send_at: p[5] ? new Date(sendAt.getTime() + 35 * 3_600_000) : sendAt, harness_status: "awaiting_evidence", drop_reason: null });
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE recommendation_outcome_followups SET ask_text/.test(sql)) return { rows: [], rowCount: 0 };
  if (/UPDATE recommendation_outcome_followups\s+SET harness_status = NULL/.test(sql)) {
    let n = 0;
    for (const r of world.rof) if (r.user_id === p[0] && r.harness_status === "awaiting_evidence" && keyOf(r).includes(p[1])) {
      r.harness_status = null; n++;
      if (!(r.match.form === "event" || ["co_event", "public_event"].includes(r.match.kind) || r.match.event_date)) r.send_at = new Date(Date.now() + p[2] * 86_400_000);
    }
    return { rows: [], rowCount: n };
  }
  if (/UPDATE recommendation_outcome_followups SET harness_status = 'dropped', drop_reason = \$3/.test(sql)) {
    let n = 0;
    for (const r of world.rof) if (r.user_id === p[0] && ["", "awaiting_evidence", "queued"].includes(r.harness_status ?? "") && keyOf(r).includes(p[1])) { r.harness_status = "dropped"; r.drop_reason = p[2]; n++; }
    return { rows: [], rowCount: n };
  }
  if (/UPDATE recommendation_outcome_followups SET harness_status = 'dropped', drop_reason = \$2 WHERE id = ANY/.test(sql)) {
    for (const r of world.rof) if ((p[0] as string[]).includes(r.id)) { r.harness_status = "dropped"; r.drop_reason = p[1]; }
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE recommendation_outcome_followups SET harness_status = \$2 WHERE id = \$1/.test(sql)) { const r = world.rof.find((x) => x.id === p[0]); if (r) r.harness_status = p[1]; return { rows: [], rowCount: 1 }; }
  if (/FROM recommendation_outcome_followups rof\s+JOIN users/.test(sql)) return { rows: world.rof.filter((r) => r.harness_status === null && r.send_at.getTime() <= Date.now() + 2 * 86_400_000).map((r) => ({ ...r, city: null })) };
  if (/SELECT id, match FROM recommendation_outcome_followups WHERE id = ANY/.test(sql)) return { rows: world.rof.filter((r) => (p[0] as string[]).includes(r.id)) };
  if (/SELECT match->>'url' AS url, match_name FROM recommendation_outcome_followups/.test(sql)) return { rows: world.rof.filter((r) => (p[0] as string[]).includes(r.id)).map((r) => ({ url: r.match.url ?? null, match_name: r.match_name })) };
  if (/FROM co_memories l WHERE l.user_id/.test(sql)) return { rows: [{ created_at: new Date(Date.now() - 4 * 86_400_000), caption: "this one looks right for you" }] };
  if (/INSERT INTO suggestion_outcomes/.test(sql)) { world.outcomes.push({ item_key: p[2], result: p[4], provenance: p[6] }); return { rows: [] }; }
  if (/UPDATE suggestion_outcomes SET provenance/.test(sql)) return { rows: [] };
  if (/FROM suggestion_outcomes WHERE user_id = \$1 AND item_key = ANY/.test(sql)) return { rows: world.outcomes.filter((o) => (p[1] as string[]).includes(o.item_key)) };
  if (/FROM revealed_offers WHERE user_id = \$1 AND item_key = ANY/.test(sql)) return { rows: world.reactions.map((reaction) => ({ reaction })) };
  if (/FROM users u LEFT JOIN event_presence/.test(sql)) return { rows: [{ email: "jordan@example.com", phone_number: "+14155550101", not_going_at: null, noshow_asked_at: null }] };
  if (/SELECT email, phone_number FROM users/.test(sql)) return { rows: [{ email: "jordan@example.com", phone_number: "+14155550101" }] };
  if (/arrived_at IS NOT NULL/.test(sql)) return { rows: world.presence ? [{ x: 1 }] : [] };
  if (/event_walkin_checkins/.test(sql)) return { rows: world.walkin ? [{ x: 1 }] : [] };
  return { rows: [] };
};
(pool as any).query = handle;
(pool as any).connect = async () => ({
  query: async (sql: string, p: any[] = []) => {
    if (/INSERT INTO proactive_candidates/.test(sql)) { world.queued.push({ type: p[1], targetKey: p[2], summary: p[4], payload: JSON.parse(p[5]) }); return { rows: [{ id: "c1" }] }; }
    return { rows: [] };
  },
  release: () => {},
});

// ---------------------------------------------------------------- the fake model: what Cue would say, by the task it was given
let prompts: string[] = [];
let presumptuous = false;
P.setProactiveModelForTests(async (prompt: string) => {
  prompts.push(prompt);
  if (/Ask how "/.test(prompt)) return "How was Founder Table? Who did you meet?";
  if (/whether they ended up making it/.test(prompt)) return presumptuous ? "How was Founder Table last night?" : "Did you end up going to Founder Table?";
  if (/look into or apply/.test(prompt)) return presumptuous ? "How was it, who did you meet?" : "Did you get a chance to look at the Fellowship?";
  return "SKIP";
});

// ---------------------------------------------------------------- finds and helpers
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const eventFind = (over: any = {}) => ({ tier: 2, kind: "public_event", name: "Founder Table", event_api_id: "evt-ft", url: "https://lu.ma/ft", event_date: yesterday, reason: "r", ...over });
const jobFind = (over: any = {}) => ({ tier: 3, kind: "opportunity", form: "opening", name: "Open Fellowship", url: "https://example.com/fellowship", deadline: "2026-12-01", statedDates: { start: yesterday, end: yesterday }, category: "accelerator", ...over });
const person = { userId: u, firstName: "Jordan", phoneNumber: "+14155550101" } as any;
const cand = (payload: any) => ({ id: "c1", userId: u, type: "debrief", targetKey: `debrief:${payload.eventApiId ?? payload.eventName}`, topicKey: null, summary: "", priority: 50, attempts: 0, dueAt: new Date(), expiresAt: new Date(Date.now() + 72 * 3_600_000), createdAt: new Date(), payload }) as any;
const dueRows = async () => { await R.enqueueDueOutcomeFollowUps(); return world.queued.slice(); };
const draft = async (payload: any) => { prompts = []; const r: any = await registry.debrief.draft(cand(payload), person); return { r, prompts: prompts.slice() }; };
const payloadFor = (q: any) => q.payload;
const kind = (d: { r: any; prompts: string[] }) => ("skip" in d.r ? "skip" : "defer" in d.r ? "defer" : /Ask how "/.test(d.prompts[0] ?? "") ? "debrief" : /whether they ended up making it/.test(d.prompts[0] ?? "") ? "neutral" : /look into or apply/.test(d.prompts[0] ?? "") ? "opening" : "other");

// ================================================================ 0. the pure evidence
{
  const e = followUpEvidence;
  check("pure: nothing at all is none", e({ rows: [] }).level === "none");
  check("pure: a yes to hearing more (interested) is not intent", e({ rows: [{ result: "interested", provenance: "stated" }] }).level === "none");
  check("pure: a stated going is intent", e({ rows: [{ result: "acted", provenance: "stated" }] }).level === "intent");
  check("pure: registered is intent", e({ rows: [], registered: true }).level === "intent");
  check("pure: stated went is attended; unstated never", e({ rows: [{ result: "helped", provenance: "stated" }] }).level === "attended" && e({ rows: [{ result: "helped", provenance: null }] }).level === "none");
  check("pure: the door wins over a no", e({ rows: [{ result: "declined" }], came: true }).level === "attended");
  check("pure: a no beats registering", e({ rows: [{ result: "declined" }], registered: true }).declined === true);
  check("pure: a 'not interested' reaction is a no", e({ rows: [], reactions: ["not_interested"] }).declined === true);
}

// ================================================================ 1. a find sent, no reply
reset();
await R.scheduleOutcomeFollowUp(u, "founder events", eventFind() as any);
check("sent, no reply: the find is parked, not scheduled", world.rof.length === 1 && world.rof[0].harness_status === "awaiting_evidence", world.rof);
check("sent, no reply: nothing is queued", (await dueRows()).length === 0);
// A Founder Table replay: a debrief for a find with no intent signal (queued by the old code) sends nothing.
{
  CF.setDoorDepsForTests({ ours: async () => false });
  const d = await draft({ eventApiId: "evt-ft", eventName: "Founder Table", eventDate: yesterday, outcomeFollowupIds: [world.rof[0].id], checkinFollowupIds: [], walkinCheckinIds: [], askText: "founder events" });
  check("Founder Table replay (sent, no intent): nothing is sent and no model is asked", kind(d) === "skip" && d.prompts.length === 0, d.r);
  check("replay: the follow-up is dropped with a recorded reason", world.rof[0].harness_status === "dropped" && /no sign/.test(world.rof[0].drop_reason ?? ""), world.rof[0]);
}

// ================================================================ 2. declined
reset();
await R.scheduleOutcomeFollowUp(u, "founder events", eventFind() as any);
await O.recordSuggestionOutcome(u, "event", "event:evt-ft", "Founder Table", "interested", "yes", { provenance: "stated", quote: "yes" });
check("a yes to hearing more arms nothing", world.rof[0].harness_status === "awaiting_evidence");
await O.recordSuggestionOutcome(u, "event", "event:evt-ft", "Founder Table", "declined", "not for me", { provenance: "stated", quote: "not for me" });
check("declined: the follow-up is dropped, reason kept", world.rof[0].harness_status === "dropped" && /isn't for them/.test(world.rof[0].drop_reason ?? ""), world.rof[0]);
check("declined: nothing queued", (await dueRows()).length === 0);

// ================================================================ 3. a job listing or program never gets "how was it"
reset();
check("job: its stated window is not an event's date", R.followUpDate(jobFind()) === null && R.followUpDate({ statedDates: { start: yesterday, end: null } }) === null);
check("event: a real event's own date anchors it; a classified event's stated dates count", R.followUpDate(eventFind()) === yesterday && R.followUpDate({ form: "event", statedDates: { start: "2026-10-05", end: "2026-10-11" } }) === "2026-10-11");
await R.scheduleOutcomeFollowUp(u, "fellowships", jobFind({ event_api_id: "evt-prog" }) as any);
check("job: sent, no reply: parked, nothing queued", world.rof[0].harness_status === "awaiting_evidence" && (await dueRows()).length === 0);
await O.recordSuggestionOutcome(u, "opportunity", "event:evt-prog", "Open Fellowship", "acted", "i'm applying", { provenance: "stated", quote: "i'm applying" });
check("job: they said they're applying: armed on the fixed delay, not on its window", world.rof[0].harness_status === null && world.rof[0].send_at.getTime() > Date.now() + 4 * 86_400_000, world.rof[0]);
world.rof[0].send_at = new Date(Date.now() - 1000);
{
  const q = await dueRows();
  check("job: queued as an opening with no event date", q.length === 1 && payloadFor(q[0]).form === "opening" && !payloadFor(q[0]).eventDate, q);
  const d = await draft(payloadFor(q[0]));
  check("job: asks whether they got to it, never 'how was it'", kind(d) === "opening" && !/Ask how "/.test(d.prompts[0]), d.prompts[0]?.slice(-400));
  presumptuous = true;
  const d2 = await draft(payloadFor(q[0]));
  check("job: a 'how was it, who did you meet' draft is refused", kind(d2) === "skip" && /assumes they went/.test(d2.r.skip), d2.r);
  presumptuous = false;
}

// ================================================================ 4. "I'm going" -> only the neutral question; "I went" -> the debrief
reset();
await R.scheduleOutcomeFollowUp(u, "founder events", eventFind() as any);
await O.recordSuggestionOutcome(u, "event", "event:evt-ft", "Founder Table", "acted", "going", { provenance: "stated", quote: "I'm going" });
check("going: the parked follow-up is armed", world.rof[0].harness_status === null);
{
  const q = await dueRows();
  check("going: queued as an event with its own date", q.length === 1 && payloadFor(q[0]).form === "event" && payloadFor(q[0]).eventDate === yesterday, q);
  const d = await draft(payloadFor(q[0]));
  check("going: only the neutral 'did you end up going?'", kind(d) === "neutral" && d.r.text === "Did you end up going to Founder Table?", { k: kind(d), r: d.r });
  presumptuous = true;
  const d2 = await draft(payloadFor(q[0]));
  check("going: a 'how was it' draft is refused", kind(d2) === "skip", d2.r);
  presumptuous = false;
  // ...and then they say they went
  await O.recordSuggestionOutcome(u, "event", "event:evt-ft", "Founder Table", "helped", "went", { provenance: "stated", quote: "I went, it was great" });
  const d3 = await draft(payloadFor(q[0]));
  check("went: the debrief ('how was it')", kind(d3) === "debrief" && /How was Founder Table/.test(d3.r.text), { k: kind(d3), r: d3.r });
}
reset();
await R.scheduleOutcomeFollowUp(u, "founder events", eventFind() as any);
await O.recordSuggestionOutcome(u, "event", "event:evt-ft", "Founder Table", "helped", "went", { provenance: "stated", quote: "I went, it was great" });
check("went (first word on it): armed", world.rof[0].harness_status === null);
{
  const q = await dueRows();
  const d = await draft(payloadFor(q[0]));
  check("went: the debrief is sent", kind(d) === "debrief", { k: kind(d), r: d.r });
}
// Cue's own read, never stated: not evidence they went
reset();
await R.scheduleOutcomeFollowUp(u, "founder events", eventFind() as any);
await O.recordSuggestionOutcome(u, "event", "event:evt-ft", "Founder Table", "helped", "inferred");
{
  CF.setDoorDepsForTests({ ours: async () => false });
  const q = await dueRows();
  check("Cue's own read of 'went' (not stated) is not evidence: nothing is sent", q.length === 1 && kind(await draft(payloadFor(q[0]))) === "skip" && world.rof[0].harness_status === "dropped");
}

// ================================================================ 5. registered: door tracked / untracked
const regPayload = (extra: any = {}) => ({ eventApiId: "evt-noise", eventName: "Noise Dinner", eventDate: yesterday, outcomeFollowupIds: [], checkinFollowupIds: ["chk-1"], walkinCheckinIds: [], askText: null, ...extra });
reset();
CF.setDoorDepsForTests({ ours: async () => true, guestList: async () => [{ api_id: "g1", email: "someone@example.com", phone: null, name: "S", approval_status: "approved", registered_at: null, checked_in_at: "2026-11-03T20:00:00Z" } as any, { api_id: "g2", email: "jordan@example.com", phone: null, name: "J", approval_status: "approved", registered_at: null, checked_in_at: null } as any] });
{
  const d = await draft(regPayload());
  check("registered, door tracked (others scanned), they weren't: the no-show flow's, no debrief", kind(d) === "skip" && /no-show flow/.test(d.r.skip) && d.prompts.length === 0, d.r);
}
CF.setDoorDepsForTests({ ours: async () => true, guestList: async () => [{ api_id: "g2", email: "jordan@example.com", phone: null, name: "J", approval_status: "approved", registered_at: null, checked_in_at: null } as any] });
{
  const d = await draft(regPayload());
  check("registered, door untracked (nobody scanned): only the neutral question, never 'how was it'", kind(d) === "neutral", { k: kind(d), r: d.r });
}
CF.setDoorDepsForTests({ ours: async () => true, guestList: async () => [{ api_id: "g2", email: "jordan@example.com", phone: null, name: "J", approval_status: "approved", registered_at: null, checked_in_at: "2026-11-03T20:05:00Z" } as any] });
{
  const d = await draft(regPayload());
  check("scanned at the door: the debrief", kind(d) === "debrief", { k: kind(d), r: d.r });
}
CF.setDoorDepsForTests({ ours: async () => true, guestList: async () => { throw new Error("luma 503"); } });
{
  const d = await draft(regPayload());
  check("door list unreadable: waits, never sends on a guess", kind(d) === "defer", d.r);
}
CF.setDoorDepsForTests({ ours: async () => false });
{
  const d = await draft(regPayload());
  check("someone else's event, registered only: the neutral question (no door exists)", kind(d) === "neutral", { k: kind(d), r: d.r });
  world.presence = true;
  const d2 = await draft(regPayload());
  check("an arrival Cue saw: the debrief", kind(d2) === "debrief", { k: kind(d2), r: d2.r });
}

// ================================================================ 6. a call: the reason Cue calls on, and the opening it writes
{
  const CR = await import("../../src/services/callReason.js");
  const CO = await import("../../src/services/callOpening.js");
  const now = new Date("2026-11-04T18:00:00Z");
  const base: any = { now, zone: "UTC", kind: "scheduled_call", nudges: [], coWork: [], recentReasonKeys: [], threads: [{ id: "7", status: "open", kind: "thread", closedQuote: null, text: "the Founder Table dinner", dueDate: "2026-11-03", openedAt: "2026-10-30T10:00:00Z", lastTouchedAt: "2026-10-30T10:00:00Z", openedQuote: "I'm heading to the Founder Table dinner Monday", nextStep: "follow_up", feeling: null }], claims: [], milestones: [], plans: [] };
  let res: any = null;
  try { res = CR.callReasonFor(base); } catch (e: any) { res = { error: e?.message }; }
  const r = res?.reason ?? null;
  check("call: a plan of theirs that just passed is a reason to ask whether it happened", r?.kind === "how_it_went" && /nothing says it happened/.test(r.text) && /ask whether it did/.test(r.text), res);
  const guide = CO.outboundOpeningGuide(r ?? { kind: "how_it_went", text: "x", key: "k", at: null } as any);
  check("call: the opening guide asks whether it happened, never takes for granted that they went", /whether it ended up happening, never taking for granted that they went/.test(guide) && !/\(how it went,/.test(guide), guide.slice(0, 300));
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
