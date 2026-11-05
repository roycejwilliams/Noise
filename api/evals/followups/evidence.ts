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
type Row = { id: string; user_id: string; ask_text: string; tier: number; match_name: string; match: any; created_at: Date; send_at: Date; harness_status: string | null; drop_reason: string | null };
const world = { rof: [] as Row[], outcomes: [] as { item_key: string; result: string; provenance: string | null; created_at: Date }[], reactions: [] as string[], queued: [] as any[], presence: false, walkin: false, nextId: 1 };
const reset = () => Object.assign(world, { rof: [], outcomes: [], reactions: [], queued: [], presence: false, walkin: false, nextId: 1 });
const keyOf = (r: Row) => [r.match.event_api_id ? `event:${r.match.event_api_id}` : null, `name:${r.match_name.toLowerCase()}`];
// The arm's key rule (recommendationOutcome.ts armOutcomeFollowUp): a name arms a row with no event id, or the one row of that name that has one.
const armKeys = (r: Row) => {
  const sameName = world.rof.filter((x) => x.user_id === r.user_id && x.match_name.toLowerCase() === r.match_name.toLowerCase() && x.match.event_api_id).length;
  return [r.match.event_api_id ? `event:${r.match.event_api_id}` : null, ...(!r.match.event_api_id || sameName === 1 ? [`name:${r.match_name.toLowerCase()}`] : [])];
};
const handle = async (sql: string, p: any[] = []) => {
  if (/INSERT INTO recommendation_outcome_followups/.test(sql)) {
    const m = JSON.parse(p[4]);
    if (world.rof.some((r) => r.user_id === p[0] && ((m.event_api_id && r.match.event_api_id === m.event_api_id) || (r.match_name.toLowerCase() === String(p[3]).toLowerCase() && (!r.match.event_api_id || !m.event_api_id))))) return { rows: [], rowCount: 0 };
    const sendAt = p[5] ? new Date(`${p[5]}T00:00:00Z`) : new Date(Date.now() + p[6] * 86_400_000);
    world.rof.push({ id: `rof-${world.nextId++}`, user_id: p[0], ask_text: p[1], tier: p[2], match_name: p[3], match: m, created_at: new Date(), send_at: p[5] ? new Date(sendAt.getTime() + 35 * 3_600_000) : sendAt, harness_status: "awaiting_evidence", drop_reason: null });
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE recommendation_outcome_followups SET ask_text/.test(sql)) return { rows: [], rowCount: 0 };
  if (/UPDATE recommendation_outcome_followups\s+(?:rof\s+)?SET harness_status = NULL/.test(sql)) {
    let n = 0;
    for (const r of world.rof) if (r.user_id === p[0] && r.harness_status === "awaiting_evidence" && armKeys(r).includes(p[1])) {
      r.harness_status = null; n++;
      if (!(r.match.form === "event" || ["co_event", "public_event"].includes(r.match.kind) || r.match.event_date || r.match.details?.startAt)) r.send_at = new Date(Date.now() + p[2] * 86_400_000);
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
  if (/SELECT id, match, created_at FROM recommendation_outcome_followups WHERE harness_status = 'awaiting_evidence'/.test(sql)) return { rows: world.rof.filter((r) => r.harness_status === "awaiting_evidence" && r.id > String(p[0])).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 500) };
  if (/UPDATE recommendation_outcome_followups SET harness_status = \$2 WHERE id = \$1/.test(sql)) { const r = world.rof.find((x) => x.id === p[0]); if (r) r.harness_status = p[1]; return { rows: [], rowCount: 1 }; }
  if (/FROM recommendation_outcome_followups rof\s+JOIN users/.test(sql)) return { rows: world.rof.filter((r) => r.harness_status === null && r.send_at.getTime() <= Date.now() + 2 * 86_400_000).map((r) => ({ ...r, city: null })) };
  if (/SELECT id, match FROM recommendation_outcome_followups WHERE id = ANY/.test(sql)) return { rows: world.rof.filter((r) => (p[0] as string[]).includes(r.id)) };
  if (/SELECT match->>'url' AS url, match_name FROM recommendation_outcome_followups/.test(sql)) return { rows: world.rof.filter((r) => (p[0] as string[]).includes(r.id)).map((r) => ({ url: r.match.url ?? null, match_name: r.match_name })) };
  if (/FROM co_memories l WHERE l.user_id/.test(sql)) return { rows: [{ created_at: new Date(Date.now() - 4 * 86_400_000), caption: "this one looks right for you" }] };
  if (/INSERT INTO suggestion_outcomes/.test(sql)) { world.outcomes.push({ item_key: p[2], result: p[4], provenance: p[6], created_at: new Date() }); return { rows: [] }; }
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
  if (/asking whether it did/.test(prompt)) return presumptuous ? "How'd sending the deck go on Friday?" : "Did the deck get sent on Friday?";
  if (/ask how it's going or where it landed/.test(prompt)) return presumptuous ? "How was the pitch?" : /whether it happened/.test(prompt) ? "Did the pitch happen?" : "How's the pitch coming along?";
  if (/look into or apply/.test(prompt)) return presumptuous ? "How was it, who did you meet?" : "Did you get a chance to look at the Fellowship?";
  return "SKIP";
});

// ---------------------------------------------------------------- finds and helpers
// The member's day, not the UTC date: between 00:00 UTC and LA midnight a UTC "yesterday" is still today for them (the fallback zone).
const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() - 86_400_000));
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
// The purpose boundary (Royce 2026-11-04, #392): a program or opening is surfaced once and never followed up, so it isn't even parked.
check("job: never parked, nothing queued", world.rof.length === 0 && (await dueRows()).length === 0, world.rof);
await O.recordSuggestionOutcome(u, "opportunity", "event:evt-prog", "Open Fellowship", "acted", "i'm applying", { provenance: "stated", quote: "i'm applying" });
check("job: 'i'm applying' arms nothing", world.rof.length === 0 && (await dueRows()).length === 0, world.rof);
{
  // An opening follow-up queued before the boundary still never asks "how was it".
  const legacy = { eventApiId: "evt-prog", eventName: "Open Fellowship", form: "opening", eventDate: null, outcomeFollowupIds: [], checkinFollowupIds: [], walkinCheckinIds: [], askText: "fellowships" };
  const d = await draft(legacy);
  check("job (queued before the boundary): never 'how was it'", kind(d) !== "event" && !/Ask how "/.test(d.prompts[0] ?? ""), { k: kind(d), p: d.prompts[0]?.slice(-300) });
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
  check("went after going: the row is closed and a debrief queued earlier doesn't re-ask it", world.rof[0].harness_status === "dropped" && /already told/.test(world.rof[0].drop_reason ?? "") && kind(d3) === "skip" && /already told/.test(d3.r.skip) && d3.prompts.length === 0, { s: world.rof[0].harness_status, d3: d3.r });
}
reset();
await R.scheduleOutcomeFollowUp(u, "founder events", eventFind() as any);
await O.recordSuggestionOutcome(u, "event", "event:evt-ft", "Founder Table", "helped", "went", { provenance: "stated", quote: "I went, it was great" });
check("stated 'went, loved it': the row is closed, not armed (the outcome is already known)", world.rof[0].harness_status === "dropped" && /already told/.test(world.rof[0].drop_reason ?? ""), world.rof[0]);
{
  const q = await dueRows();
  check("stated 'went, loved it': nothing is queued, so no debrief re-asks it", q.length === 0, q);
}
// Cue's own read, never stated: not evidence they went
reset();
await R.scheduleOutcomeFollowUp(u, "founder events", eventFind() as any);
await O.recordSuggestionOutcome(u, "event", "event:evt-ft", "Founder Table", "helped", "inferred");
{
  CF.setDoorDepsForTests({ ours: async () => false });
  const q = await dueRows();
  check("Cue's own read of 'went' (not stated) is not evidence: nothing is sent", q.length === 0 && world.rof[0].harness_status === "dropped");
}

// ================================================================ 5. registered: door tracked / untracked
const regPayload = (extra: any = {}) => ({ eventApiId: "evt-noise", eventName: "Noise Dinner", eventDate: yesterday, outcomeFollowupIds: [], checkinFollowupIds: ["chk-1"], walkinCheckinIds: [], askText: null, ...extra });
reset();
CF.setDoorDepsForTests({ ours: async () => true, guestList: async () => [{ api_id: "g1", email: "someone@example.com", phone: null, name: "S", approval_status: "approved", registered_at: null, checked_in_at: "2026-11-03T20:00:00Z" } as any, { api_id: "g2", email: "jordan@example.com", phone: null, name: "J", approval_status: "approved", registered_at: null, checked_in_at: null } as any] });
{
  const d = await draft(regPayload());
  check("registered, door tracked (others scanned), they weren't: the no-show flow's, no debrief", kind(d) === "skip" && /no-show flow/.test(d.r.skip) && d.prompts.length === 0, d.r);
}
// "I went" overrides a tracked door with no scan: the member's own word is evidence, the debrief goes.
{
  CF.setDoorDepsForTests({ ours: async () => true, guestList: async () => [{ api_id: "g1", email: "someone@example.com", phone: null, name: "S", approval_status: "approved", registered_at: null, checked_in_at: "2026-11-03T20:00:00Z" } as any, { api_id: "g2", email: "jordan@example.com", phone: null, name: "J", approval_status: "approved", registered_at: null, checked_in_at: null } as any] });
  await O.recordSuggestionOutcome(u, "event", "event:evt-noise", "Noise Dinner", "helped", "went", { provenance: "stated", quote: "I went, loved it" });
  const d = await draft(regPayload());
  check("said they went, door tracked and no scan: the debrief, not the no-show flow's skip", kind(d) === "debrief", { k: kind(d), r: d.r });
  world.outcomes.length = 0;
  // An old "I went" to a same-name event (a recurring dinner) is not evidence they went to this one.
  const old = new Date(Date.now() - 60 * 86_400_000);
  world.outcomes.push({ item_key: "name:noise dinner", result: "helped", provenance: "stated", created_at: old });
  const d2 = await draft(regPayload());
  check("old same-name 'went' (name key), tracked door, not scanned: no debrief", kind(d2) === "skip" && /no-show flow/.test(d2.r.skip) && d2.prompts.length === 0, { k: kind(d2), r: d2.r });
  world.outcomes.length = 0;
  world.outcomes.push({ item_key: "event:evt-noise", result: "helped", provenance: "stated", created_at: old });
  const d3 = await draft(regPayload());
  check("an old 'went' written before this event started is ignored too", kind(d3) === "skip" && d3.prompts.length === 0, { k: kind(d3), r: d3.r });
  world.outcomes.length = 0;
  // ...and the stated-only skip: a recommendation-only debrief with only an old same-name 'went' has no evidence at all
  world.outcomes.push({ item_key: "name:noise dinner", result: "helped", provenance: "stated", created_at: old });
  const d4 = await draft(regPayload({ checkinFollowupIds: [], outcomeFollowupIds: [] }));
  check("old same-name 'went', no registration: not evidence, nothing sent", kind(d4) === "skip" && d4.prompts.length === 0, { k: kind(d4), r: d4.r });
  world.outcomes.length = 0;
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

// ================================================================ 6b. parked rows expire; a recurring name never arms an old row
{
  const day = (n: number) => new Date(Date.now() + n * 86_400_000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  check("pure: an event is kept to 3 days past its date, then expires", !R.parkedRowExpired({ match: { form: "event", event_date: ymd(day(-2)) }, created_at: day(-10) }) && R.parkedRowExpired({ match: { form: "event", event_date: ymd(day(-5)) }, created_at: day(-10) }));
  check("pure: an upcoming event never expires", !R.parkedRowExpired({ match: { form: "event", event_date: ymd(day(30)) }, created_at: day(-100) }));
  check("pure: an opening expires at 30 days parked, not before", !R.parkedRowExpired({ match: jobFind(), created_at: day(-29) }) && R.parkedRowExpired({ match: jobFind(), created_at: day(-31) }));
  reset();
  await R.scheduleOutcomeFollowUp(u, "founder events", eventFind({ event_date: ymd(day(-6)) }) as any);
  // Openings are no longer parked (#392); rows parked before that still expire, so they're placed directly.
  const legacyOpening = (name: string, created: Date) => world.rof.push({ id: `rof-${world.nextId++}`, user_id: u, ask_text: "fellowships", tier: 3, match_name: name, match: jobFind({ name }), created_at: created, send_at: day(5), harness_status: "awaiting_evidence", drop_reason: null });
  legacyOpening("Open Fellowship", new Date());
  legacyOpening("Old Program", day(-40));
  await dueRows();
  check("expiry: the old event and the 40-day opening are dropped with a reason; the fresh opening stays parked", world.rof[0].harness_status === "dropped" && world.rof[2].harness_status === "dropped" && world.rof[1].harness_status === "awaiting_evidence" && /before it expired/.test(world.rof[0].drop_reason ?? ""), world.rof.map((r) => [r.harness_status, r.drop_reason]));
  // Expired rows beyond the first page are still reached
  reset();
  for (let i = 0; i < 620; i++) world.rof.push({ id: `rof-${String(1000 + i)}`, user_id: u, ask_text: "", tier: 2, match_name: `Ev ${i}`, match: { form: "event", event_date: ymd(day(i < 600 ? 30 : -9)) }, created_at: new Date(), send_at: new Date(), harness_status: "awaiting_evidence", drop_reason: null });
  const n = await R.expireParkedFollowUps();
  check("expiry: 20 expired rows after the first 500 are reached", n === 20 && world.rof.filter((r) => r.harness_status === "dropped").length === 20, n);
  // A recurring same-name event: the new date is its own parked row, and "I'm going" under the new event id arms only that one
  reset();
  await R.scheduleOutcomeFollowUp(u, "founder events", eventFind({ event_api_id: "evt-old", event_date: ymd(day(-2)) }) as any);
  await R.scheduleOutcomeFollowUp(u, "founder events", eventFind({ event_api_id: "evt-new", event_date: ymd(day(6)) }) as any);
  check("recurring name: the new event id is its own parked row", world.rof.length === 2, world.rof.length);
  await O.recordSuggestionOutcome(u, "event", "event:evt-new", "Founder Table", "acted", "going", { provenance: "stated", quote: "I'm going" });
  check("recurring name: 'going' on the new event arms only the new row", world.rof.find((r) => r.match.event_api_id === "evt-new")!.harness_status === null && world.rof.find((r) => r.match.event_api_id === "evt-old")!.harness_status === "awaiting_evidence");
  await O.recordSuggestionOutcome(u, "event", "name:founder table", "Founder Table", "acted", "going", { provenance: "stated", quote: "I'm going" });
  check("recurring name: a bare name key is ambiguous, so it arms no old row", world.rof.find((r) => r.match.event_api_id === "evt-old")!.harness_status === "awaiting_evidence");
  const src2 = (await import("node:fs")).readFileSync(new URL("../../src/services/recommendationOutcome.ts", import.meta.url), "utf8");
  check("arm: its event test considers details.startAt like followUpDate", /match #>> '\{details,startAt\}' IS NOT NULL/.test(src2));
}

// ================================================================ 7. text: a dated plan of theirs is intent, not evidence
{
  const W = await import("../../src/agent/windowFollowUp.js");
  const CC = await import("../../src/agent/companionCheckin.js");
  const plan: any = { kind: "commitment", label: "Friday", asked: "send the deck", sent: [], dates: "Friday, October 30" };
  prompts = []; presumptuous = false;
  const a: any = await W.draftWindowFollowUp("Jordan", plan);
  check("text dated plan, intent only: the neutral question, asked as such", a?.text === "Did the deck get sent on Friday?" && /asking whether it did/.test(prompts[0] ?? "") && !/asking how it went/.test(prompts[0] ?? ""), { a, p: (prompts[0] ?? "").slice(-300) });
  presumptuous = true;
  const b: any = await W.draftWindowFollowUp("Jordan", plan);
  check("text dated plan: a 'how'd it go' draft is refused", b === null, b);
  const thread = { text: "pitching at Friday's demo day", quote: "I pitch on Friday", dueDate: "2026-10-30", feeling: null };
  presumptuous = false;
  const c: any = await CC.draftCompanionCheckin("Jordan", "", thread, null);
  check("companion thread with a date: asks whether it happened", /whether it happened/.test(prompts[prompts.length - 1] ?? "") && c?.text === "Did the pitch happen?", { c, p: (prompts[prompts.length - 1] ?? "").slice(-500) });
  presumptuous = true;
  const d: any = await CC.draftCompanionCheckin("Jordan", "", thread, null);
  check("companion thread with a date: a 'how was it' draft is refused", d === null, d);
  presumptuous = false;
  const e: any = await CC.draftCompanionCheckin("Jordan", "", { ...thread, dueDate: null }, null);
  check("companion thread with no date: unchanged (how it's going)", e?.text === "How's the pitch coming along?", e);
}

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
