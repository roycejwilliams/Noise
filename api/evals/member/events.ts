// Model-free checks for the events section of the member picture (Cue Memory Spec step 3, 2026-11-06): services/knowledge/events.ts, read
// through services/memberKnowledge.ts (include: ["events"]). No database, no model.
//   npx tsx evals/member/events.ts
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const MK = await import("../../src/services/memberKnowledge.js");
const EV = await import("../../src/services/knowledge/events.js");
type Deps = import("../../src/services/memberKnowledge.js").KnowledgeDeps;
type Raw = import("../../src/services/knowledge/events.js").RawEvents;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const root = new URL("../../src/", import.meta.url).pathname;
const src = (p: string) => readFileSync(join(root, p), "utf8");
const d = (iso: string) => new Date(iso);
const NOW = d("2026-11-06T12:00:00Z");

const raw = (o: Partial<Raw> = {}): Raw => ({ ...EV.noEvents(), ...o });
const info = (eventId: string, name: string, startAt: string) => ({ eventId, name, startAt: d(startAt) });
const pres = (eventId: string, o: Partial<Raw["presence"][0]> = {}): Raw["presence"][0] => ({ eventId, arrivedAt: null, arrivedVia: null, notGoingAt: null, metAt: null, metQuote: null, noshowOutcome: null, ...o });
const plan = (id: string, name: string, date: string | null, o: Partial<Raw["plans"][0]> = {}): Raw["plans"][0] => ({ id, name, date, provenance: "stated", quote: `I'm going to ${name}`, at: d("2026-10-30T10:00:00Z"), ...o });
const out = (key: string, name: string, result: string, o: Partial<Raw["outcomes"][0]> = {}): Raw["outcomes"][0] => ({ key, name, result, provenance: "stated", quote: null, at: d("2026-10-31T10:00:00Z"), ...o });
const build = (r: Raw, budget?: number) => EV.eventsOf(r, { now: NOW, budget });

// ---------------------------------------------------------------- attendance only with evidence
const a1 = build(raw({ info: [info("e1", "Founders Dinner", "2026-10-20T18:00:00Z")], presence: [pres("e1", { arrivedAt: d("2026-10-20T18:20:00Z"), arrivedVia: "door" })] })).items[0];
check("a door check-in is attendance, seen, with its source and date", a1.attendance?.state === "attended" && a1.attendance.via === "door" && a1.attendance.prov === "seen" && a1.attendance.source === "event_presence" && a1.attendance.on === "2026-10-20T18:20:00.000Z");
const a2 = build(raw({ info: [info("e2", "Text Arrival Night", "2026-10-21T18:00:00Z")], presence: [pres("e2", { arrivedAt: d("2026-10-21T18:05:00Z"), arrivedVia: "text" })] })).items[0];
check("an arrival they texted is attendance, said", a2.attendance?.prov === "said" && a2.attendance.via === "text");
const planOnly = build(raw({ info: [info("e3", "Maker Night", "2026-11-12T18:00:00Z")], offers: [{ eventId: "e3", name: "Maker Night", date: "2026-11-12", at: d("2026-11-01T10:00:00Z") }], plans: [plan("p3", "Maker Night", "2026-11-12")], outcomes: [out("event:e3", "Maker Night", "acted"), out("event:e3", "Maker Night", "interested", { provenance: null })] })).items[0];
check("a plan, an offer, an acted and an interested are never attendance", planOnly.attendance === null && planOnly.plan !== null && planOnly.offered?.prov === "did" && planOnly.outcomes.length === 2);
const said = build(raw({ info: [info("e4", "Supper Club", "2026-10-25T18:00:00Z")], outcomes: [out("event:e4", "Supper Club", "helped", { quote: "went last night, it was great", at: d("2026-10-26T09:00:00Z") })] })).items[0];
check("their own stated words after the event started are attendance (said)", said.attendance?.state === "attended" && said.attendance.prov === "said" && said.attendance.words === "went last night, it was great");
const before = build(raw({ info: [info("e5", "Supper Club", "2026-10-25T18:00:00Z")], outcomes: [out("event:e5", "Supper Club", "helped", { at: d("2026-10-24T09:00:00Z") })] })).items[0];
check("a went-result dated before the event started is not attendance", before.attendance === null);
const inferred = build(raw({ info: [info("e6", "Supper Club", "2026-10-25T18:00:00Z")], outcomes: [out("event:e6", "Supper Club", "helped", { provenance: null, at: d("2026-10-26T09:00:00Z") })] })).items[0];
check("a went-result Cue only inferred is not attendance", inferred.attendance === null && inferred.outcomes[0].prov === "inferred");
const metEarly = build(raw({ info: [info("e7", "Mixer", "2026-10-25T18:00:00Z")], presence: [pres("e7", { metAt: d("2026-10-25T12:00:00Z"), metQuote: "met someone" })] }));
check("a met-someone note from before the event started is not attendance (and is not kept)", metEarly.items.every((x) => x.attendance === null));
const noStart = build(raw({ presence: [pres("e8", { metAt: d("2026-10-25T21:00:00Z"), metQuote: "met someone great" })] }));
check("with no start time to compare against, their words can't prove attendance", noStart.items.every((x) => x.attendance === null));
const nogo = build(raw({ info: [info("e9", "Panel", "2026-11-20T18:00:00Z")], presence: [pres("e9", { notGoingAt: d("2026-11-02T10:00:00Z") })] })).items[0];
check("a no is kept as not_going (said), not attendance", nogo.attendance?.state === "not_going" && nogo.attendance.prov === "said");
const came = build(raw({ info: [info("e10", "Salon", "2026-10-22T18:00:00Z")], presence: [pres("e10", { noshowOutcome: "came" })] })).items[0];
check("the no-show flow's came (settled only on evidence) is attendance, seen", came.attendance?.state === "attended" && came.attendance.prov === "seen");
const saidNo = build(raw({ info: [info("e11", "Salon", "2026-10-22T18:00:00Z")], presence: [pres("e11", { noshowOutcome: "said_no" })] }));
check("no-answer or said_no outcomes alone are never attendance", saidNo.items.every((x) => x.attendance?.state !== "attended"));

// ---------------------------------------------------------------- a passed plan with no evidence drops
const past = build(raw({ plans: [plan("p1", "Old Mixer", "2026-10-01")], offers: [{ eventId: "o1", name: "Old Offer", date: "2026-10-02", at: d("2026-09-28T10:00:00Z") }], info: [info("o1", "Old Offer", "2026-10-02T18:00:00Z")] }));
check("a plan whose date passed with no evidence drops", past.items.length === 0);
check("a passed offer alone drops too, and neither is treated as attended", past.items.every((x) => x.attendance === null));
const upcoming = build(raw({ plans: [plan("p2", "Next Week Mixer", "2026-11-09")]})).items;
check("a plan still ahead stays", upcoming.length === 1 && upcoming[0].when === "upcoming" && upcoming[0].plan?.prov === "said");
check("today counts as ahead", build(raw({ plans: [plan("p2", "Tonight", "2026-11-06")] })).items.length === 1);
const merged = build(raw({ info: [info("m1", "Founders Dinner", "2026-10-20T18:00:00Z")], plans: [plan("pm", "Founders Dinner", "2026-10-20")], presence: [pres("m1", { arrivedAt: d("2026-10-20T18:20:00Z"), arrivedVia: "door" })] }));
check("a passed plan on an event they did attend is kept, merged by exact name and date", merged.items.length === 1 && merged.items[0].plan !== null && merged.items[0].attendance?.state === "attended");
const mismatch = build(raw({ info: [info("m2", "Founders Dinner", "2026-10-20T18:00:00Z")], plans: [plan("pm2", "Founders Dinner", "2026-12-01")], presence: [pres("m2", { arrivedAt: d("2026-10-20T18:20:00Z"), arrivedVia: "door" })] }));
check("a plan with a different date is not merged into that attended event", mismatch.items.length === 2 && mismatch.items.filter((x) => x.attendance).length === 1);
const undated = build(raw({ plans: [plan("u1", "Some Meetup", null, { at: d("2026-10-30T10:00:00Z") }), plan("u2", "Ancient Meetup", null, { at: d("2026-08-01T10:00:00Z") })] }));
check("an undated plan stays while fresh and goes when old", undated.items.map((x) => x.name).join() === "Some Meetup" && undated.items[0].when === "undated");
const inferredPlan = build(raw({ plans: [plan("i1", "Maybe Event", "2026-11-10", { provenance: null, quote: null })] })).items[0];
check("a plan Cue only inferred reads as inferred, with no words", inferredPlan.plan?.prov === "inferred" && inferredPlan.plan.words === null);

// ---------------------------------------------------------------- outcomes carry their quote; every value has source, date, provenance
const oc = build(raw({ info: [info("q1", "Supper Club", "2026-10-25T18:00:00Z")], presence: [pres("q1", { arrivedAt: d("2026-10-25T18:10:00Z"), arrivedVia: "door" })], outcomes: [out("event:q1", "Supper Club", "helped", { quote: "it was exactly the room I needed" })] })).items[0];
check("an outcome carries its result, date, provenance and their quote", oc.outcomes[0].result === "helped" && oc.outcomes[0].words === "it was exactly the room I needed" && oc.outcomes[0].prov === "said" && oc.outcomes[0].source === "suggestion_outcomes" && !!oc.outcomes[0].on);
const everything = build(raw({ info: [info("z", "Z Night", "2026-10-25T18:00:00Z")], plans: [plan("pz", "Z Night", "2026-10-25")], offers: [{ eventId: "z", name: "Z Night", date: "2026-10-25", at: d("2026-10-20T10:00:00Z") }], presence: [pres("z", { arrivedAt: d("2026-10-25T18:10:00Z"), arrivedVia: "location", metAt: d("2026-10-25T22:00:00Z"), metQuote: "met a founder" })], outcomes: [out("event:z", "Z Night", "helped", { quote: "good night" })], followThroughs: [{ eventId: "z", people: 2, at: d("2026-10-26T10:00:00Z") }] })).items[0];
const vals = [everything.plan, everything.offered, everything.attendance, everything.met, everything.followedUp, ...everything.outcomes];
check("every value carries a source, a date and a provenance in the snapshot's vocabulary", vals.every((v) => !!v && !!v.source && !!v.on && ["said", "seen", "did", "inferred"].includes((v as any).prov)));
check("every item is stamped verifiedAt", !!everything.verifiedAt && everything.verifiedAt > "2026-10-26");
check("who they met: their side only (their words and that they met someone), plus a follow-up as a count", everything.met?.words === "met a founder" && everything.followedUp?.people === 2 && !/people_?names|names/.test(JSON.stringify(Object.keys(everything.followedUp!))));
const many = Array.from({ length: 12 }, (_, i) => out("event:w", "W", "helped", { provenance: null, at: d(`2026-10-${10 + i}T10:00:00Z`), quote: `n${i}` }));
const capped = build(raw({ info: [info("w", "W", "2026-10-01T10:00:00Z")], presence: [pres("w", { arrivedAt: d("2026-10-01T10:30:00Z"), arrivedVia: "door" })], outcomes: many })).items[0];
check("outcomes per event are capped to the newest, the rest counted", capped.outcomes.length === EV.OUTCOMES_PER_EVENT && capped.outcomesOmitted === 12 - EV.OUTCOMES_PER_EVENT && capped.outcomes[0].words === "n11");

// ---------------------------------------------------------------- ordering and budget
const rank = build(raw({
  info: [info("a1", "Attended Old", "2026-09-01T18:00:00Z"), info("a2", "Attended New", "2026-10-28T18:00:00Z"), info("u1", "Soon", "2026-11-07T18:00:00Z"), info("u2", "Later", "2026-12-07T18:00:00Z")],
  presence: [pres("a1", { arrivedAt: d("2026-09-01T18:10:00Z"), arrivedVia: "door" }), pres("a2", { arrivedAt: d("2026-10-28T18:10:00Z"), arrivedVia: "door" })],
  offers: [{ eventId: "u2", name: "Later", date: "2026-12-07", at: d("2026-11-01T10:00:00Z") }, { eventId: "u1", name: "Soon", date: "2026-11-07", at: d("2026-11-01T10:00:00Z") }],
})).items.map((x) => x.name).join();
check("upcoming first (soonest), then attended newest first", rank === "Soon,Later,Attended New,Attended Old");
check("attended events have no window: a months-old one stays", rank.includes("Attended Old"));
const filler = Array.from({ length: 40 }, (_, i) => ({ eventId: `f${i}`, name: `Filler event number ${i} ${"x".repeat(80)}`, date: `2026-12-${String(1 + (i % 28)).padStart(2, "0")}`, at: d("2026-11-01T10:00:00Z") }));
const tight = build(raw({ offers: filler }), 1500);
check("the character budget holds", JSON.stringify(tight.items).length <= 1500 && tight.items.length < 40);
check("what the budget leaves out is counted", tight.omitted === 40 - tight.items.length && tight.omitted > 0);
const big = build(raw({ info: [info("big", "Big", "2026-12-01T10:00:00Z")], plans: [plan("pb", "Big", "2026-12-01", { quote: "q".repeat(5000) })], outcomes: Array.from({ length: 30 }, (_, i) => out("event:big", "Big", "interested", { quote: "w".repeat(5000), at: d(`2026-11-0${1 + (i % 5)}T1${i % 10}:00:00Z`) })) , offers: filler.slice(0, 3) }));
check("a heavy event can't blow the default budget", JSON.stringify(big.items).length <= EV.EVENTS_BUDGET_CHARS);
check("the budget is a character budget in code", /EVENTS_BUDGET_CHARS = \d+/.test(src("services/knowledge/events.ts")));

// ---------------------------------------------------------------- through memberKnowledge: opt-in, guards, strip
const base = (r: Raw, removed: { old: string; ref: string }[] = []): Partial<Deps> => ({
  profile: async () => ({ firstName: "Jordan", city: null, goals: null, intent: null, updatedAt: null }),
  zone: async () => null,
  linkedNames: async () => ["Maya"],
  events: async () => r,
  forgotten: async () => removed.map((x) => ({ field: "event", old: x.old, now: null, ref: x.ref, removed: true })),
});
const read = (r: Raw, removed: { old: string; ref: string }[] = [], deps: Partial<Deps> = {}) => MK.memberKnowledge("u1", { include: ["events"], now: NOW }, { ...base(r, removed), ...deps });
const dinner = raw({ info: [info("e1", "Founders Dinner", "2026-10-20T18:00:00Z")], presence: [pres("e1", { arrivedAt: d("2026-10-20T18:20:00Z"), arrivedVia: "door", metAt: d("2026-10-20T21:00:00Z"), metQuote: "I met Maya and we got on" })], outcomes: [out("event:e1", "Founders Dinner", "helped", { quote: "Maya was great, we're meeting Friday" })] });
const k = await read(dinner);
check("the section is returned through memberKnowledge", k.events!.length === 1 && k.events![0].name === "Founders Dinner" && k.events![0].attendance?.state === "attended");
check("another member's name never appears, in their met words or their quote", !/Maya/.test(JSON.stringify(k.events)) && k.events![0].met !== null);
check("without opting in, the section is empty and its loader never runs", await (async () => { let ran = false; const kk = await MK.memberKnowledge("u1", { include: [], now: NOW }, { ...base(dinner), events: async () => { ran = true; return dinner; } }); return !ran && kk.events!.length === 0; })());
check("the default read does not include it", !(MK.KNOWLEDGE_SECTIONS as readonly string[]).includes("events") && (MK.OPT_IN_SECTIONS as readonly string[]).includes("events"));
const rem = await read(raw({ ...dinner, info: [...dinner.info, info("e2", "Forgotten Night", "2026-10-21T18:00:00Z")], presence: [...dinner.presence, pres("e2", { arrivedAt: d("2026-10-21T18:10:00Z"), arrivedVia: "door" })] }), [{ old: "Forgotten Night", ref: "event:e2" }]);
check("a removed event is not returned, by its ref", rem.events!.map((x) => x.id).join() === "e1" && !JSON.stringify(rem).includes("Forgotten"));
const remName = await read(raw({ plans: [plan("p9", "the divorce lawyers meetup", "2026-11-12"), plan("p10", "Pottery Night", "2026-11-12")] }), [{ old: "divorce lawyers", ref: "snapshot:x" }]);
check("an event whose name says a removed thing is dropped", remName.events!.map((x) => x.name).join() === "Pottery Night");
const remWords = await read(raw({ info: [info("e3", "Salon", "2026-10-22T18:00:00Z")], presence: [pres("e3", { arrivedAt: d("2026-10-22T18:10:00Z"), arrivedVia: "door", metAt: d("2026-10-22T21:00:00Z"), metQuote: "met a recruiter about the layoff at Acme" })], outcomes: [out("event:e3", "Salon", "helped", { quote: "talked about the layoff at Acme the whole time" })] }), [{ old: "the layoff at Acme", ref: "snapshot:y" }]);
check("forgotten words are cut from their quotes", !/layoff/.test(JSON.stringify(remWords.events)));
const unread = await read(dinner, [], { forgotten: async () => { throw new Error("db down"); } });
check("fails closed when the guards can't be read", unread.events!.length === 0 && unread.guardsUnread === true);
const noGuard = await MK.memberKnowledge("u1", { include: ["events"], now: NOW }, { ...base(dinner), forgotten: undefined });
check("fails closed when there is no guard read at all", noGuard.events!.length === 0);
check("the loader's failure gives an empty section, not a throw", (await read(dinner, [], { events: async () => { throw new Error("x"); } })).events!.length === 0);
const omit = await read(raw({ offers: filler }));
check("omitted events are counted on the knowledge object", (omit.eventsOmitted ?? 0) > 0 && omit.events!.length + omit.eventsOmitted! === 40);

// ---------------------------------------------------------------- the loader: every query bound to the member, only theirs
const seen: { sql: string; args: unknown[] }[] = [];
const db = {
  query: async (sql: string, args: unknown[]) => {
    seen.push({ sql, args });
    if (/FROM event_presence/.test(sql)) return { rows: [{ event_api_id: "e1", arrived_at: "2026-10-20T18:20:00Z", arrived_via: "door", not_going_at: null, met_someone_at: null, met_quote: null, noshow_outcome: null }] };
    return { rows: [] };
  },
};
const loaded = await EV.loadEvents("user-aaa", db);
check("the loader returns the presence row", loaded.presence.length === 1 && loaded.presence[0].eventId === "e1");
const own = seen.filter((q) => !/ANY\(\$1::text\[\]\)/.test(q.sql));
check("every member query is bound to the member's id as $1, never in the text", own.length >= 5 && own.every((q) => q.args[0] === "user-aaa" && /user_id = \$1/.test(q.sql) && !q.sql.includes("user-aaa")));
check("the name lookups are by event id only (no member column), parameterised", seen.filter((q) => /ANY\(\$1::text\[\]\)/.test(q.sql)).every((q) => Array.isArray(q.args[0]) && !q.sql.includes("e1")));
check("the loader reads only the sources it names, read-only", seen.every((q) => /^\s*SELECT/.test(q.sql)) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(src("services/knowledge/events.ts").replace(/\/\/[^\n]*/g, "")));
check("sent offers are only event offers that were sent", seen.some((q) => /type = 'event_offer' AND status = 'sent'/.test(q.sql)));
check("outcomes read only event outcomes (no intros, so no other member)", seen.some((q) => /FROM suggestion_outcomes WHERE user_id = \$1 AND kind = 'event'/.test(q.sql)));

// cross-member isolation as behaviour: a fake database that holds two members and applies the user filter
const rowsFor = { mine: "user-aaa", theirs: "user-bbb" };
const fake = (sql: string, args: unknown[]) => {
  const uid = args[0];
  if (/FROM event_presence/.test(sql)) return uid === rowsFor.mine ? [{ event_api_id: "m1", arrived_at: "2026-10-20T18:00:00Z", arrived_via: "door", not_going_at: null, met_someone_at: null, met_quote: null, noshow_outcome: null }] : [{ event_api_id: "t1", arrived_at: "2026-10-20T18:00:00Z", arrived_via: "door", not_going_at: null, met_someone_at: null, met_quote: null, noshow_outcome: null }];
  if (/FROM planned_event_mentions/.test(sql)) return uid === rowsFor.mine ? [{ id: "pm", event_name_raw: "My Plan", event_date: "2026-11-20", provenance: "stated", quote: "mine", created_at: "2026-11-01T00:00:00Z" }] : [{ id: "pt", event_name_raw: "THEIR PLAN", event_date: "2026-11-20", provenance: "stated", quote: "theirs", created_at: "2026-11-01T00:00:00Z" }];
  if (/FROM luma_event_snapshots/.test(sql)) return (args[0] as string[]).map((id) => ({ event_id: id, name: id === "m1" ? "My Dinner" : "THEIR DINNER", start_at: "2026-10-20T17:00:00Z" }));
  return [];
};
const iso = { query: async (sql: string, args: unknown[]) => ({ rows: fake(sql, args) }) };
const mineSec = await MK.memberKnowledge(rowsFor.mine, { include: ["events"], now: NOW }, { ...base(raw()), events: (u: string) => EV.loadEvents(u, iso) });
const theirSec = await MK.memberKnowledge(rowsFor.theirs, { include: ["events"], now: NOW }, { ...base(raw()), events: (u: string) => EV.loadEvents(u, iso) });
check("end to end: my section holds only my events", mineSec.events!.map((x) => x.name).sort().join() === "My Dinner,My Plan" && !/THEIR/.test(JSON.stringify(mineSec)));
check("end to end: another member's section holds only theirs", theirSec.events!.map((x) => x.name).sort().join() === "THEIR DINNER,THEIR PLAN" && !/My (Dinner|Plan)/.test(JSON.stringify(theirSec)));

// ---------------------------------------------------------------- not rendered into any prompt yet
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
const readers = walk(root).filter((f) => !f.endsWith("services/memberKnowledge.ts") && !f.includes("services/knowledge/") && /\.events\b[^\n]*(?:knowledge|picture|\bk\b)|include:\s*\[[^\]]*"events"/.test(readFileSync(f, "utf8")));
check("no other source file opts into or reads the events section (nothing renders it)", readers.length === 0);
check("the snapshot render does not read it", !/\.events\b|eventsOmitted|"events"/.test(src("services/memberSnapshot.ts")));
check("the knowledge module is imported only by memberKnowledge", walk(root).filter((f) => !f.includes("services/knowledge/") && /knowledge\/events\.js/.test(readFileSync(f, "utf8"))).map((f) => f.split("/").pop()).join() === "memberKnowledge.ts");

console.log(`member events: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
