// A registration's outcome in the member picture and the debrief (services/eventRegistration/followThrough.ts): a plan, never attendance;
// pending shows as pending, not going; the reason stays with its event and says whose words it is; nothing reaches the cross-member
// match. Layer 1: pure reads and a fake store. Zero tokens, no database.
//   npx tsx evals/registration/followThrough.ts
import fs from "node:fs";
const F = await import("../../src/services/eventRegistration/followThrough.js");
const EV = await import("../../src/services/knowledge/events.js");
const PE = await import("../../src/services/knowledge/pictureEntries.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const form: any = { url: "https://luma.com/founders-dinner", eventName: "Founders Dinner", when: "Fri Nov 20, 6:00 PM", startAt: "2026-11-21T02:00:00.000Z", zone: "America/Los_Angeles", action: "register", tickets: [], priceText: "Free", gate: "none", readAt: "x",
  fields: [{ id: "name", label: "Name", kind: "name", required: true }, { id: "why", label: "Why do you want to attend?", kind: "open_question", required: true }] };
const rec = (status: string, why?: { value: string; source: "member" | "draft_approved" }) => ({ status: status as any, eventName: "Founders Dinner", form, answers: why ? { why } : {} });

const reg = F.planRowFor(rec("registered", { value: "I'm building a battery startup and want to meet climate investors.", source: "member" }));
check("registered: a plan with the event's local date and their reason as their words", reg?.status === "registered" && reg.date === "2026-11-20" && reg.reasonSource === "their_words" && /battery startup/.test(reg.reason ?? ""), reg);
check("approved draft: kept apart from their own words", F.planRowFor(rec("pending_approval", { value: "To meet climate investors.", source: "draft_approved" }))?.reasonSource === "approved_draft");
check("already registered counts as registered", F.planRowFor(rec("already_registered"))?.status === "registered");
check("failed, blocked, uncertain: no plan", ["failed", "blocked", "uncertain", "withdrawn", "awaiting_yes"].every((s) => F.planRowFor(rec(s)) === null));

// The picture: through the plan record the events section already reads.
const NOW = new Date("2026-11-10T18:00:00Z");
const rawWith = (status: "registered" | "pending_approval" | "waitlisted", reason: string | null, reasonSource: "their_words" | "approved_draft" | null) => ({
  ...EV.noEvents(),
  plans: [{ id: "p1", name: "Founders Dinner", date: "2026-11-20", provenance: "stated", quote: null, at: new Date("2026-11-09T19:00:00Z"), registration: { status, reason, reasonSource } }],
});
const knowledge = (items: any[]): any => ({ userId: "u", asOf: NOW.toISOString(), identity: { firstName: "Jordan", city: "Oakland", zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: NOW.toISOString() }, goals: [], asks: [], delivered: [], carrying: [], lessons: [], corrections: [], preferences: [], claims: [], restraint: null, exchanges: [], person: null, limits: null, transitions: [], learnedLessons: [], learnedCorrections: [], learnedLimits: { avoid: [], rules: [], availability: null }, events: items, people: [] });
const lines = (raw: any) => PE.pictureEntries(knowledge(EV.eventsOf(raw, { now: NOW, timeZone: "America/Los_Angeles" }).items)).entries.filter((e) => e.section === "events");

const r1 = lines(rawWith("registered", "I'm building a battery startup and want to meet climate investors.", "their_words"));
check("confirmed registration shows as a plan", r1.length === 1 && r1[0].kind === "plan" && /^A plan to go to "Founders Dinner", 2026-11-20 \(registered through Cue\)/.test(r1[0].text), r1);
check("registered never becomes attended", !r1.some((e) => e.kind === "attended" || /Attended/.test(e.text)));
check("their reason stays with this event, marked as their words", /their reason for this event: "I'm building a battery startup/.test(r1[0].text), r1[0].text);
const r2 = lines(rawWith("pending_approval", "To meet climate investors.", "approved_draft"));
check("pending shows as pending, not going", r2.length === 1 && /pending the host's approval; not confirmed/.test(r2[0].text) && !/A plan to go to/.test(r2[0].text), r2);
check("an approved draft is marked as Cue's draft they approved", /a reason they approved for this event \(Cue's draft\)/.test(r2[0].text), r2[0].text);
const r3 = lines(rawWith("waitlisted", null, null));
check("waitlisted shows as not confirmed", /^On the waitlist for "Founders Dinner".*not confirmed/.test(r3[0]?.text ?? ""), r3);
// A removal reaches the reason too (the same guards as their quotes).
const guarded = EV.guardEvents(rawWith("registered", "battery startup secret", "their_words") as any, { g: (t) => (/secret/.test(t) ? null : t), gone: () => false });
check("a removed reason is cut by the same guards as their words", guarded.plans[0].registration?.reason === null);
check("a plan row read back carries its registration", EV.planRegistration({ registration_status: "pending_approval", reason: "x", reason_source: "approved_draft" })?.status === "pending_approval" && EV.planRegistration({ registration_status: null }) === null);

// Not shared, not promoted.
check("the plan row is written with no embedding (the cross-member overlap match needs one)", !/embedding/.test(src("services/eventRegistration/followThrough.ts").split("INSERT INTO planned_event_mentions")[1].split("`,")[0]));
check("the cross-member match still requires an embedding match", /1 - \(embedding <=> \$5::vector\) >= \$6/.test(src("services/eventMatching.ts")));
check("the reason is never written as a goal or an ask", !/co_goals|saveAsk|member_claims/.test(src("services/eventRegistration/followThrough.ts")));
check("a confirmed registration feeds the existing debrief as intent (acted), pending and waitlisted don't", /row\.status === "registered" && rec\.itemKey/.test(src("services/eventRegistration/followThrough.ts")));

// The write, on a fake store: once per registration, updated as it moves.
{
  const said: { sql: string; a: any[] }[] = [];
  const q = { query: async (sql: string, a: any[] = []) => { said.push({ sql, a }); return { rows: [] }; } };
  const r = { ...rec("pending_approval", { value: "To meet climate investors.", source: "draft_approved" }), id: "00000000-0000-4000-8000-00000000r001", userId: "u", eventKey: "luma:founders-dinner", eventUrl: form.url, itemKey: null, scope: null, scopeHash: null, drafts: [], askedAt: null, askKind: null, askText: null, attempts: 1, submitStartedAt: null, outcome: null, updatedAt: NOW } as any;
  await F.recordRegistrationPlan("u", r, q);
  check("plan write: one upsert keyed on the registration, stated, with its status", said.length === 1 && /ON CONFLICT \(registration_id\)/.test(said[0].sql) && said[0].a[4] === "pending_approval" && said[0].a[2] === "2026-11-20", said);
}

// Forget an event's answer: it leaves the registration's answers and the plan's reason; the status stays.
{
  const W = await import("../../src/services/whatCoKnows.js");
  const RG = await import("../../src/services/eventRegistration/registration.js");
  const raw: any = { profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [],
    signups: W.signupsOf([{ id: "00000000-0000-4000-8000-0000000000b2", event_name: "Founders Dinner", form, answers: { why: { value: "To meet climate investors.", source: "member" } } }], RG.FACTUAL_KINDS) };
  const item = W.knownItems(raw).find((i) => i.group === "signupAnswers")!;
  const said: { sql: string; a: any[] }[] = [];
  const db: any = { query: async (sql: string, a: any[]) => { said.push({ sql, a }); return { rows: [], rowCount: 1 }; } };
  await W.applyOne(db, "u", raw, item, "remove", null, "forget why I wanted to go");
  check("forget an event's answer: off the registration and off the plan's reason, status untouched", said.some((x) => /answers = answers - \$3/.test(x.sql)) && said.some((x) => /UPDATE planned_event_mentions SET reason = NULL, reason_source = NULL/.test(x.sql)) && !said.some((x) => /registration_status|SET status/.test(x.sql)), said);
}
// Every other reader of the plan record: pending or waitlisted is never "going".
{
  const TL = await import("../../src/services/timeline.js");
  const CR = await import("../../src/services/callReason.js");
  check("timeline: pending reads as not confirmed, never 'going'", /host hasn't approved them yet: not confirmed/.test(TL.planTimelineWhat({ event_name_raw: "Founders Dinner", provenance: "stated", registration_status: "pending_approval" })) && !/they said they're going/.test(TL.planTimelineWhat({ event_name_raw: "Founders Dinner", provenance: "stated", registration_status: "pending_approval" })));
  check("timeline: waitlisted reads as not confirmed", /on the waitlist: not confirmed/.test(TL.planTimelineWhat({ event_name_raw: "Pitch Night", provenance: "stated", registration_status: "waitlisted" })));
  check("timeline: a registered plan and a plain stated plan still read as going", /they said they're going/.test(TL.planTimelineWhat({ event_name_raw: "Demo Night", provenance: "stated", registration_status: "registered" })) && /they said they're going/.test(TL.planTimelineWhat({ event_name_raw: "Demo Night", provenance: "stated" })));
  check("timeline and call reason read the registration status", /provenance, registration_status FROM planned_event_mentions/.test(src("services/timeline.ts")) && /provenance, registration_status FROM planned_event_mentions/.test(src("services/callReason.ts")));
  const base: any = { now: new Date("2026-11-18T18:00:00Z"), zone: "America/Los_Angeles", kind: null, nudges: [], threads: [], claims: [], milestones: [], coWork: [], recentReasonKeys: [] };
  const say = (registration?: string) => JSON.stringify(CR.callReasonFor({ ...base, plans: [{ name: "Founders Dinner", date: "2026-11-20", stated: true, ...(registration ? { registration } : {}) }] }));
  check("call reason: a pending or waitlisted plan is never a 'they said they're going' reason", !/Founders Dinner/.test(say("pending_approval")) && !/Founders Dinner/.test(say("waitlisted")) && /they said they're going/.test(say("registered")), { pending: say("pending_approval").slice(0, 300), registered: say("registered").slice(0, 300) });
}
console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
