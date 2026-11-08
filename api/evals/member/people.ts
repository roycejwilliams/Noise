// Model-free checks for the people section of the member picture (Cue Memory Spec step 4, 2026-11-06): services/knowledge/people.ts, read
// through services/memberKnowledge.ts. No database, no model.
//   npx tsx evals/member/people.ts
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const MK = await import("../../src/services/memberKnowledge.js");
const P = await import("../../src/services/knowledge/people.js");
type Deps = import("../../src/services/memberKnowledge.js").KnowledgeDeps;
type Raw = import("../../src/services/knowledge/people.js").RawPerson;

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

const raw = (o: Partial<Raw> & { id: string }): Raw => ({
  kind: "pair",
  at: d("2026-10-20T20:00:00Z"),
  eventName: "Founders Supper",
  firstName: null,
  doubleYes: false,
  otherKey: "other-1",
  mine: null,
  reached: true,
  memberAsked: false,
  introduced: false,
  ended: null,
  evidence: {},
  outcome: null,
  note: null,
  viaNetwork: false,
  quote: null,
  ...o,
});
const base = (people: Raw[], removed: { old: string; ref: string }[] = [], linked: string[] = ["Maya", "Priya"]): Partial<Deps> => ({
  profile: async () => ({ firstName: "Jordan", city: null, goals: null, intent: null, updatedAt: null }),
  zone: async () => null,
  linkedNames: async () => linked,
  people: async () => people,
  forgotten: async () => removed.map((r) => ({ field: "x", old: r.old, now: null, ref: r.ref, removed: true })),
});
const read = (people: Raw[], removed: { old: string; ref: string }[] = [], deps: Partial<Deps> = {}, linked?: string[]) => MK.memberKnowledge("u1", { include: ["people"] }, { ...base(people, removed, linked), ...deps });

// The follow-on policy (memberSafeMemories.stripAfterNames) reaches the free text here too: what follows a stranger's name goes with it.
const lk = P.buildPeople([raw({ id: "n1", firstName: "Priya", doubleYes: false, note: "Priya is a founder. She is moving to Austin to raise a fund with her brother." }), raw({ id: "n2", firstName: "Priya", doubleYes: false, note: "I already know Priya. She is going through a divorce and moving to Austin." })], { g: (t) => t, removed: [], linked: ["Priya"] }).items;
check("a stranger's follow-on sentences are stripped from the free text, not only the sentence with the name", !/Austin|fund|brother|divorce/.test(JSON.stringify(lk)));

// ---------------------------------------------------------------- a name only after a double yes
const both = raw({ id: "pair:1:a", firstName: "Maya", doubleYes: true, mine: "yes", introduced: true, otherKey: "m" });
const oneSided = raw({ id: "pair:2:a", firstName: "Priya", doubleYes: false, mine: "yes", otherKey: "p" });
const k1 = await read([both, oneSided]);
const byId = (k: Awaited<ReturnType<typeof read>>, id: string) => k.people!.find((x) => x.id === id)!;
check("a double yes carries the name, through the final strip", byId(k1, "pair:1:a").personName === "Maya");
check("a one-sided yes stays nameless even if a name was handed in", byId(k1, "pair:2:a").personName === null && !JSON.stringify(byId(k1, "pair:2:a")).includes("Priya"));
check("a one-sided yes reads 'said yes, no answer yet', not a name", byId(k1, "pair:2:a").stage === "said_yes_no_answer_yet" && /someone you were matched with at Founders Supper/.test(byId(k1, "pair:2:a").description));
check("a loader that hands in a name without a double yes still gets no name (the builder re-checks)", P.buildPeople([raw({ id: "x", firstName: "Priya", doubleYes: false })], { g: (t) => t, removed: [], linked: ["Priya"] }).items[0].personName === null);
check("the description is nameless even after a double yes", !/Maya/.test(byId(k1, "pair:1:a").description));
const net = [
  raw({ id: "net:a", kind: "network", eventName: null, firstName: "Maya", doubleYes: true, mine: "yes", otherKey: "m", introduced: false }),
  raw({ id: "net:b", kind: "network", eventName: null, firstName: "Priya", doubleYes: false, mine: "yes", otherKey: "p" }),
  raw({ id: "net:c", kind: "network", eventName: null, firstName: "Maya", doubleYes: true, mine: "yes", otherKey: "q", introduced: true }),
];
const kn = await read(net);
check("network: both_interested / introduced are named; a one-sided yes is not", byId(kn, "net:a").personName === "Maya" && byId(kn, "net:c").personName === "Maya" && byId(kn, "net:b").personName === null);
check("network: both interested but not made is 'both_yes', made is 'introduced'", byId(kn, "net:a").stage === "both_yes" && byId(kn, "net:c").stage === "introduced");
const knownNamed = await read([raw({ id: "pair:9:a", firstName: "Maya", doubleYes: true, otherKey: "m", introduced: true }), raw({ id: "knows:5", kind: "knows", eventName: null, otherKey: "m", quote: "Maya and I used to work together" }), raw({ id: "knows:6", kind: "knows", eventName: null, otherKey: "p", quote: "Priya is my neighbour" })]);
check("someone they said they know is named only when a double yes exists for that same person", byId(knownNamed, "knows:5").personName === "Maya" && byId(knownNamed, "knows:6").personName === null);
check("their own words about someone not yet consented are stripped of that name; a consented name in them is theirs", !/Priya/.test(JSON.stringify(byId(knownNamed, "knows:6"))) && /Maya/.test(byId(knownNamed, "knows:5").quote ?? ""));
const mixed = await read([raw({ id: "pair:3:a", firstName: "Maya", doubleYes: true, otherKey: "m", introduced: true, note: "Maya was great; Priya was there too" })]);
check("a consented person's outcome words keep her name and strip another linked member's", /Maya/.test(mixed.people![0].outcome?.quote ?? "") && !/Priya/.test(JSON.stringify(mixed.people)));
check("no other user id or key leaves the section", !JSON.stringify(k1).includes("other-1") && !JSON.stringify(knownNamed).includes('"otherKey"'));

// ---------------------------------------------------------------- stages: silence is not rejection
const st = (o: Partial<Raw>) => P.stageOf(raw({ id: "s", ...o }));
check("asked, no answer: suggested, no answer yet", st({ mine: null }) === "suggested_no_answer");
check("the night ended on an unanswered ask: still 'suggested, no answer', never declined", st({ mine: null, ended: "expired" }) === "suggested_no_answer");
check("their own yes, then the night ended: said yes, no answer yet", st({ mine: "yes", ended: "expired" }) === "said_yes_no_answer_yet");
check("their own no is declined_by_you", st({ mine: "no", ended: "declined" }) === "declined_by_you");
check("the other side's no is 'closed', not 'declined', and says nothing about whose", st({ mine: "yes", ended: "declined" }) === "closed" && st({ mine: null, ended: "declined" }) === "closed");
check("an intro they asked for by name, nothing made yet", st({ mine: null, memberAsked: true }) === "asked_for_intro");
check("introduced, then met (their own word or the record)", st({ doubleYes: true, introduced: true }) === "introduced" && st({ doubleYes: true, introduced: true, evidence: { met: { value: "yes", how: "stated" } } }) === "met" && st({ doubleYes: true, introduced: true, evidence: { met: { value: "no", how: "stated" } } }) === "introduced");
const stages = (await read([raw({ id: "a", mine: null, ended: "expired" }), raw({ id: "b", mine: "no", ended: "declined" }), raw({ id: "c", mine: "yes", ended: "declined" })])).people!;
check("end to end: no stage is called declined unless it was their own no", stages.filter((p) => p.stage === "declined_by_you").map((p) => p.id).join() === "b" && stages.find((p) => p.id === "a")!.stage === "suggested_no_answer");
check("the source never maps a stage from the other side's answer (the loader only selects their own)", !/their_answer|other_answer/.test(src("services/knowledge/people.ts")));

// ---------------------------------------------------------------- outcome in their words, with its date; more like them
const withOutcome = raw({ id: "pair:7:a", firstName: "Maya", doubleYes: true, introduced: true, otherKey: "m", note: "we talked for an hour about moving", evidence: { met: { value: "yes", how: "stated", at: "2026-10-22T10:00:00Z" }, useful: { value: "yes", how: "stated", at: "2026-10-23T09:00:00Z" }, kept_talking: { value: "not_yet", how: "stated", at: "2026-10-22T10:00:00Z" } } });
const ko = (await read([withOutcome])).people![0];
check("the outcome carries their words and its date", ko.outcome?.quote === "we talked for an hour about moving" && ko.outcome?.on === "2026-10-23" && ko.outcome?.met === "yes" && ko.outcome?.useful === "yes" && ko.outcome?.keptTalking === "not_yet");
check("moreLikeThem comes from what they stated", ko.moreLikeThem === "yes");
check("no stated rating: moreLikeThem unknown, never guessed", (await read([raw({ id: "n", doubleYes: true, introduced: true, evidence: { met: { value: "yes", how: "inferred", at: "2026-10-22T10:00:00Z" } } })])).people![0].moreLikeThem === null);
check("a not-a-fit meeting reads as not more like them", (await read([raw({ id: "n2", doubleYes: true, introduced: true, evidence: { useful: { value: "no", how: "stated", at: "2026-10-22T10:00:00Z" } } })])).people![0].moreLikeThem === "no");
check("the pair with no outcome has none", (await read([both])).people![0].outcome === null);
check("every item is stamped verifiedAt", k1.people!.every((p) => !!p.verifiedAt));

// ---------------------------------------------------------------- forgotten content is not returned; fails closed
const rk = await read([withOutcome, raw({ id: "knows:8", kind: "knows", eventName: null, otherKey: null, quote: "I know the Hendersons from church" })], [{ old: "the Hendersons from church", ref: "knows:8" }]);
check("a removed 'already know' is gone whole", rk.people!.every((p) => p.id !== "knows:8") && !JSON.stringify(rk).includes("Henderson"));
const ro = await read([withOutcome], [{ old: "we talked for an hour about moving", ref: "pair:7:a" }]);
check("a removed outcome is gone (words, evidence, stage 'met'); the introduction itself stays", ro.people![0].outcome === null && ro.people![0].moreLikeThem === null && !JSON.stringify(ro).includes("moving") && ro.people![0].stage === "introduced");
const rt = await read([raw({ id: "pair:11:a", firstName: "Maya", doubleYes: true, introduced: true, otherKey: "m", note: "she told me about the divorce with Pat, and was kind" })], [{ old: "the divorce with Pat", ref: "snapshot:weighingOn:1" }]);
check("their words saying a removed thing are guarded like any other of their words", !/divorce/.test(JSON.stringify(rt)));
const rn = P.buildPeople([both, oneSided], { g: (t) => (t === "Maya" ? null : t), removed: [], linked: ["Maya", "Priya"] });
check("a person whose name the guards remove is gone whole", rn.items.every((p) => p.personName !== "Maya") && rn.items.length === 1);
const unread = await read([both], [], { forgotten: async () => { throw new Error("db down"); } });
check("fails closed when the guards can't be read", unread.people!.length === 0 && unread.guardsUnread === true);
const noGuard = await MK.memberKnowledge("u1", { include: ["people"] }, { ...base([both]), forgotten: undefined });
check("fails closed when there is no guard read at all", noGuard.people!.length === 0);
check("a failed loader gives an empty section, not a throw", (await read([], [], { people: async () => { throw new Error("x"); } })).people!.length === 0);
await MK.memberKnowledge("u1", { include: ["people"] }, { ...base([both]), linkedNames: async () => { throw new Error("names down"); } }).then(() => check("a failed name read rejects, as for every section", false), () => check("a failed name read rejects, as for every section", true));

// ---------------------------------------------------------------- opt-in; the budget holds
check("opt-in: not in the default sections, loader never runs unless asked", !(MK.KNOWLEDGE_SECTIONS as readonly string[]).includes("people") && (MK.OPT_IN_SECTIONS as readonly string[]).includes("people") && await (async () => { let ran = false; const kk = await MK.memberKnowledge("u1", { include: [] }, { ...base([both]), people: async () => { ran = true; return [both]; } }); return !ran && kk.people!.length === 0; })());
const many = Array.from({ length: 60 }, (_, i) => raw({ id: `pair:${100 + i}:a`, at: d(`2026-10-${String(1 + (i % 28)).padStart(2, "0")}T12:00:00Z`), note: "n".repeat(250), doubleYes: true, introduced: true, firstName: "Maya", evidence: { useful: { value: "yes", how: "stated", at: "2026-10-05T10:00:00Z" } } }));
const g0 = { g: (t: string) => t, removed: [], linked: ["Maya"] };
const small = P.buildPeople(many, g0, 2000);
check("the budget bounds the section and what it leaves out is counted", JSON.stringify(small.items).length <= 2000 && small.omitted === many.length - small.items.length && small.omitted > 0);
check("the default budget holds, and nothing is silently dropped", JSON.stringify(P.buildPeople(many, g0).items).length <= P.PEOPLE_BUDGET_CHARS && P.buildPeople(many, g0).items.length + P.buildPeople(many, g0).omitted === many.length);
const inflightFirst = P.buildPeople([raw({ id: "old-live", at: d("2026-09-01T00:00:00Z"), mine: null }), raw({ id: "new-done", at: d("2026-10-30T00:00:00Z"), doubleYes: true, introduced: true, firstName: "Maya" })], g0);
check("in-flight first, then newest", inflightFirst.items.map((p) => p.id).join() === "old-live,new-done");
check("a size that fits nothing returns none and counts them all", P.buildPeople(many.slice(0, 3), g0, 10).items.length === 0 && P.buildPeople(many.slice(0, 3), g0, 10).omitted === 3);

// ---------------------------------------------------------------- the loader: own side only, tested as behaviour on a fake that answers per member
type FakeRow = Record<string, unknown>;
const tables: Record<string, Record<string, Record<string, FakeRow[]>>> = {};
const fake = (byUser: Record<string, Partial<Record<"pairs" | "nets" | "optins" | "conns" | "knows" | "reqs", FakeRow[]>>>) => ({
  query: async (sql: string, args: unknown[]) => {
    const u = String(args[0]);
    const t = byUser[u] ?? {};
    if (/FROM co_pairs p WHERE p\.a_id = \$1 OR p\.b_id = \$1/.test(sql)) return { rows: t.pairs ?? [] };
    if (/FROM member_connections mc/.test(sql)) return { rows: t.conns ?? [] };
    if (/FROM intro_requests r/.test(sql)) return { rows: t.reqs ?? [] };
    if (/FROM event_guest_match_opt_ins o/.test(sql)) return { rows: t.optins ?? [] };
    if (/FROM co_facts/.test(sql)) return { rows: t.knows ?? [] };
    if (/FROM network_introductions n WHERE n\.person_a_id = \$1 OR n\.person_b_id = \$1/.test(sql)) return { rows: t.nets ?? [] };
    throw new Error("unexpected query");
  },
});
const A = "user-aaa", B = "user-bbb";
const pairRow = (id: number, side: "a" | "b", o: FakeRow = {}): FakeRow => ({ id, side, other_id: "someone", origin: "co", event_id: "e1", state: "asked", my_answer: null, my_answered_at: null, from_my_request: false, both_yes_at: null, my_asked_at: "2026-10-20T20:00:00Z", my_evidence: {}, my_outcome: null, my_note: null, double_yes: false, intro_sent_at: null, declined_at: null, expired_at: null, created_at: "2026-10-20T19:00:00Z", event_name: "Founders Supper", first_name: null, ...o });
const db = fake({
  [A]: {
    pairs: [pairRow(1, "a", { double_yes: true, first_name: "Maya", intro_sent_at: "2026-10-21T00:00:00Z", my_note: "A's own note", value_line_a: "SECRET-VALUE-LINE-A", b_outcome_note: "SECRET-OTHER-SIDE-NOTE", b_evidence: { met: { value: "no" } } }), pairRow(2, "a", { state: "expired", expired_at: "2026-10-20T23:00:00Z" })],
    nets: [{ other_id: "n1", status: "both_interested", created_at: "2026-10-01T00:00:00Z", introduced_at: null, my_interested_at: "2026-10-02T00:00:00Z", double_yes: true, first_name: "Noor", match_reason: "SECRET-MATCH-REASON" }],
    knows: [{ id: 5, happened_at: "2026-10-03T00:00:00Z", quote: "I know Sam from school", other_id: null }],
    reqs: [{ id: "0a1b2c3d-0000-0000-0000-000000000001", asked_at: "2026-10-04T00:00:00Z", event_id: "e1", event_name: null, name_said: "SECRET-NAME-SAID", target_id: "target-user" }],
  },
  [B]: { pairs: [pairRow(3, "b", { my_note: "B's own note", event_name: "Other Night" })] },
});
const la = await P.loadPeople(A, db);
const lb = await P.loadPeople(B, db);
check("the loader gives each member only their own rows", la.length === 5 && lb.length === 1 && lb[0].note === "B's own note" && !JSON.stringify(lb).includes("A's own note") && !JSON.stringify(la).includes("B's own note"));
check("the other side's columns, value lines, match reasons and the name they said never come out", !/SECRET/.test(JSON.stringify(la)) && !/SECRET/.test(JSON.stringify(await read(la))));
const sa = await MK.memberKnowledge(A, { include: ["people"] }, { ...base([]), people: (u: string) => P.loadPeople(u, db) });
const sb = await MK.memberKnowledge(B, { include: ["people"] }, { ...base([]), people: (u: string) => P.loadPeople(u, db) });
check("end to end: B's section holds nothing of A's, A's nothing of B's", sb.people!.length === 1 && !/Founders|Maya|Noor|Sam/.test(JSON.stringify(sb.people)) && !/Other Night|B's own/.test(JSON.stringify(sa.people)));
check("end to end: A's section is the named double-yes people, the nameless rest", sa.people!.find((p) => p.id === "pair:1:a")?.personName === "Maya" && sa.people!.find((p) => p.id.startsWith("net:"))?.personName === "Noor" && sa.people!.find((p) => p.id === "pair:2:a")?.stage === "suggested_no_answer" && sa.people!.find((p) => p.id === "knows:5")?.personName === null);
check("an intro they asked for by name carries neither the name nor whether the person was found", /asked/.test(JSON.stringify(sa.people!.find((p) => p.id.startsWith("ask:")))) && !JSON.stringify(sa.people).includes("target"));
const seen: { sql: string; args: unknown[] }[] = [];
await P.loadPeople("user-aaa", { query: async (sql, args) => (seen.push({ sql, args }), { rows: [] }) });
check("six queries, each bound to the member's id as $1 and never in the SQL text", seen.length === 6 && seen.every((q) => q.args.length === 1 && q.args[0] === "user-aaa" && !q.sql.includes("user-aaa") && /\$1/.test(q.sql)));
check("no query selects another member's side, value lines, reasons or the name a member said", seen.every((q) => !/value_line|match_reason|name_said|a_outcome_note AS|SELECT[^;]*b_answer AS/.test(q.sql) && !/SELECT\s+\*\s+FROM\s+(co_pairs|network_introductions)/.test(q.sql)));
check("a name is selected only inside a double-yes condition in the SQL itself", /CASE WHEN m\.double_yes THEN u\.first_name END/.test(seen[0].sql) && /CASE WHEN m\.double_yes THEN u\.first_name END/.test(seen[1].sql) && /member_connections is written only after both said yes/.test(src("services/knowledge/people.ts")));
check("a person is read only if this member knows of them (the ask reached them, or a double yes; their own request is its own entry)", /WHERE m\.double_yes OR \(m\.my_asked_at IS NOT NULL AND NOT m\.from_my_request\)/.test(seen[0].sql) && /WHERE m\.double_yes OR m\.my_interested_at IS NOT NULL/.test(seen[1].sql));


// ---------------------------------------------------------------- review of #405: asks, found/not-found, the other side's report, dedupe, unread
{
  const C = "user-ccc", D = "user-ddd";
  // D asked for C by name: the pair is origin 'member', but C made no request and Cue hasn't asked C.
  const target = pairRow(20, "b", { origin: "member", other_id: D, my_asked_at: null, event_name: "Founders Supper" });
  const asker = pairRow(21, "a", { origin: "member", other_id: C, my_asked_at: null });
  const dbx = fake({ [C]: { pairs: [{ ...target }] }, [D]: { pairs: [{ ...asker }] } });
  const rc = await P.loadPeople(C, dbx);
  check("the side that didn't ask isn't told the other asked: the pair's origin is never read as their ask", rc.length === 1 && rc[0].memberAsked === false && P.stageOf(rc[0]) === "suggested_no_answer" && !/asked/.test(P.descriptionOf(rc[0].viaNetwork ? "intro_via_network" : "matched_at_event", null)));
  check("the target of someone else's request has no entry until Cue asks them or a double yes (their pair is not read as their request)", /WHERE m\.double_yes OR \(m\.my_asked_at IS NOT NULL AND NOT m\.from_my_request\)/.test(seen[0].sql));
  const mkReq = (id: string, event: string | null) => ({ id, asked_at: "2026-10-21T09:00:00Z", event_id: event, event_name: event ? "Founders Supper" : null });
  const nobuild = (rs: Raw[]) => P.buildPeople(rs, { g: (t) => t, removed: [], linked: [] }).items;
  // The SQL hides the pair a request created (the loader gets no pair row for it, found or not); entries come only from intro_requests.
  const reqSets: Record<string, ReturnType<typeof mkReq>[]> = {
    "one request": [mkReq("11111111-0000-0000-0000-000000000001", "e1")],
    "two events": [mkReq("11111111-0000-0000-0000-000000000002", "e1"), mkReq("11111111-0000-0000-0000-000000000003", "e2")],
    "twice at one event": [mkReq("11111111-0000-0000-0000-000000000004", "e1"), mkReq("11111111-0000-0000-0000-000000000005", "e1")],
  };
  let same = true;
  for (const [, reqs] of Object.entries(reqSets)) {
    const notFound = nobuild(await P.loadPeople(D, fake({ [D]: { reqs } })));
    // found: the same requests; the pairs they created are not returned (hidden in SQL), so nothing else can show
    const found = nobuild(await P.loadPeople(D, fake({ [D]: { reqs, pairs: [] } })));
    same = same && found.length === reqs.length && notFound.length === reqs.length && found.every((p, i) => p.id === `ask:${reqs[i].id}` && p.id === notFound[i].id && p.stage === "asked_for_intro" && p.personName === null && p.description === notFound[i].description);
  }
  check("found and not-found requests give the same number of entries and the same ids, even at two events or twice at one", same);
  check("every entry's id is its own request's id, never a pair's", Object.values(reqSets).flat().every((r) => nobuild([raw({ id: `ask:${r.id}`, kind: "request", memberAsked: true })])[0].id === `ask:${r.id}`));
  check("the SQL hides only the pair the member's own request created (same person AND same event), until a double yes", /EXISTS \(SELECT 1 FROM intro_requests r WHERE r\.user_id = \$1 AND r\.target_id = CASE WHEN p\.a_id = \$1 THEN p\.b_id ELSE p\.a_id END AND r\.event_id IS NOT DISTINCT FROM p\.event_id\) AS from_my_request/.test(seen[0].sql) && /WHERE m\.double_yes OR \(m\.my_asked_at IS NOT NULL AND NOT m\.from_my_request\)/.test(seen[0].sql) && !/my_request_at/.test(seen[0].sql));
  check("a request leaves the list only when its own event's pair, or a network intro, is a double yes", /p\.event_id IS NOT DISTINCT FROM r\.event_id/.test(seen[5].sql));
  // a later, separate pair with the same person (another event) shows under its own rules, including their own no
  const later = pairRow(70, "a", { event_id: "e9", my_answer: "no", state: "declined", declined_at: "2026-11-01T00:00:00Z", other_id: C });
  const shown = nobuild(await P.loadPeople(D, fake({ [D]: { reqs: reqSets["one request"], pairs: [later] } })));
  check("a later separate pair with the same person still shows (their own no is declined_by_you), next to the request", shown.length === 2 && shown.some((p) => p.stage === "declined_by_you" && p.id.startsWith("pair:")) && shown.some((p) => p.id.startsWith("ask:")));
  check("after a double yes the asker's pair reads normally, named", (() => { const r = P.buildPeople([raw({ id: "pair:40:a", memberAsked: true, doubleYes: true, introduced: true, firstName: "Maya", otherKey: "m" })], { g: (t) => t, removed: [], linked: [] }).items[0]; return r.stage === "introduced" && r.personName === "Maya"; })());
  // B's "we met" must not move A's stage: met_at / outcome_at are shared and aren't read.
  const metByOther = pairRow(50, "a", { double_yes: true, intro_sent_at: "2026-10-21T00:00:00Z", first_name: "Maya", met_at: "2026-10-22T00:00:00Z", outcome_at: "2026-10-22T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", my_evidence: {} });
  const rm = (await P.loadPeople(A, fake({ [A]: { pairs: [metByOther] } })))[0];
  check("the other side's 'we met' doesn't change this side's stage, outcome or time", P.stageOf(rm) === "introduced" && !("metAt" in rm) && !("outcomeAt" in rm) && rm.at.toISOString() === "2026-10-21T00:00:00.000Z" && P.buildPeople([rm], { g: (t) => t, removed: [], linked: [] }).items[0].outcome === null);
  const ownMet = (await P.loadPeople(A, fake({ [A]: { pairs: [{ ...metByOther, my_evidence: { met: { value: "yes", how: "stated", at: "2026-10-23T00:00:00Z" } } }] } })))[0];
  check("their own 'met' does", P.stageOf(ownMet) === "met" && ownMet.at.toISOString() === "2026-10-23T00:00:00.000Z");
  check("an outcome with no time of its own has no date, not the pair's", P.buildPeople([raw({ id: "n", doubleYes: true, introduced: true, note: "good", firstName: "Maya" })], { g: (t) => t, removed: [], linked: [] }).items[0].outcome?.on === null);
  // network intro: the co_pairs row (event_id 'network') and the network_introductions row are one person
  const netPair = pairRow(60, "a", { event_id: "network", double_yes: true, intro_sent_at: "2026-10-21T00:00:00Z", other_id: "n1", first_name: "Noor", event_name: null });
  const netRow = { other_id: "n1", status: "introduced", created_at: "2026-10-01T00:00:00Z", introduced_at: "2026-10-21T00:00:00Z", my_interested_at: "2026-10-02T00:00:00Z", double_yes: true, first_name: "Noor" };
  const dn = await P.loadPeople(A, fake({ [A]: { pairs: [netPair], nets: [netRow] } }));
  check("a network intro with both a pair row and a network row shows once", dn.length === 1 && dn[0].kind === "pair");
  const dnp = P.buildPeople(dn, { g: (t) => t, removed: [], linked: [] }).items[0];
  check("and reads as a network intro, named, without an event", dnp.how === "intro_via_network" && dnp.personName === "Noor" && dnp.where === null);
  check("a network row with no pair row stays", (await P.loadPeople(A, fake({ [A]: { nets: [netRow] } }))).length === 1);
  // unread vs none
  const un = await MK.memberKnowledge("u1", { include: ["people"] }, { ...base([]), people: async () => { throw new Error("x"); } });
  const none = await read([]);
  const gu = await read([both], [], { forgotten: async () => { throw new Error("down"); } });
  check("a failed read is told apart from none (peopleUnread)", un.peopleUnread === true && un.people!.length === 0 && none.peopleUnread === undefined && none.people!.length === 0 && gu.peopleUnread === true && k1.peopleUnread === undefined);
}

// ---------------------------------------------------------------- not rendered into any prompt yet; the diff to memberKnowledge stays small
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
const readers = walk(root).filter((f) => !f.endsWith("services/memberKnowledge.ts") && !f.endsWith("services/matchPicture.ts") && !f.endsWith("services/knowledge/people.ts") && !/services\/(memberSnapshot|callContext)\.ts$|services\/knowledge\/pictureEntries\.ts$|agent\/conversationReply\.ts$/.test(f) && (/include:[^\]\n]*"people"|buildPeople|loadPeople|knowledge\/people/.test(readFileSync(f, "utf8")) || (/memberKnowledge/.test(readFileSync(f, "utf8")) && /\b(?:k|knowledge|mk|picture)\.people\b|\.people\b\s*(?:\?\.|\.|\[)/.test(readFileSync(f, "utf8")))));
check("no source file reads the people section but the two renderers (step 6: the snapshot and the call context, through pictureEntries)", readers.length === 0);
check("the snapshot renders it only through pictureEntries (it asks for it, and never reads .people itself)", /"people"/.test(src("services/memberSnapshot.ts")) && !/\.people\b/.test(src("services/memberSnapshot.ts")));
check("the loader lives in its own file; memberKnowledge only registers the section", !/FROM co_pairs|FROM network_introductions/.test(src("services/memberKnowledge.ts")));
check("no model call in the section", !/generateText|anthropic|openai/i.test(src("services/knowledge/people.ts").replace(/^\/\/.*$/gm, "")));

console.log(`member people: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
