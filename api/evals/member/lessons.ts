// Model-free checks for the lessons part of the member picture (Cue Memory Spec step 5, 2026-11-06): lessons, corrections and limits by
// relevance, each dated and linked to its source (services/knowledge/lessons.ts, read through services/memberKnowledge.ts). No database, no model.
//   npx tsx evals/member/lessons.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const MK = await import("../../src/services/memberKnowledge.js");
const L = await import("../../src/services/knowledge/lessons.js");
type Deps = import("../../src/services/memberKnowledge.js").KnowledgeDeps;
type Raw = import("../../src/services/knowledge/lessons.js").RawPicture;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const d = (s: string) => new Date(s);
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const lesson = (id: string, text: string, at: string) => ({ id, text, at: d(at) });
const corr = (id: string, o: Partial<Raw["corrections"][number]> = {}) => ({ id, field: "city", itemRef: "profile:city", was: "Oakland", now: "Berkeley", quote: "I moved to Berkeley", at: d("2026-10-01T10:00:00Z"), ...o });
const raw = (lessons: Raw["lessons"], corrections: Raw["corrections"] = []): Raw => ({ lessons, lessonsTotal: lessons.length, corrections, correctionsTotal: corrections.length });
const LIMITS = { avoid: ["crypto events"], availability: null as string | null, at: d("2026-11-01T00:00:00Z") };
const base = (r: Raw, removed: { old: string; ref: string; field?: string }[] = [], limits: any = LIMITS): Partial<Deps> => ({
  profile: async () => ({ firstName: "Jordan", city: null, goals: null, intent: null, updatedAt: null }),
  zone: async () => null,
  linkedNames: async () => ["Maya"],
  picture: async () => r,
  limits: async () => limits,
  forgotten: async () => removed.map((x) => ({ field: x.field ?? "x", old: x.old, now: null, ref: x.ref, removed: true })),
});
const read = (r: Raw, removed: { old: string; ref: string }[] = [], deps: Partial<Deps> = {}, picture?: { budget?: number; about?: string }, limits?: any) =>
  MK.memberKnowledge("u1", { include: ["picture"], ...(picture ? { picture } : {}) }, { ...base(r, removed, limits), ...deps });

// ---------------------------------------------------------------- no silent drop of older lessons
const twelve = Array.from({ length: 12 }, (_, i) => lesson(`l${i}`, `lesson number ${i} about topic${i} and style${i}`, `2025-${String(1 + i).padStart(2, "0")}-05T10:00:00Z`));
const k = await read(raw(twelve));
check("12 lessons, a year old and more: all returned (no count cutoff, no age cutoff)", k.picture!.lessons.length === 12 && k.picture!.lessonsOmitted === 0);
check("the oldest one (Jan 2025) is there", k.picture!.lessons.some((l) => l.id === "l0"));
check("newest first", k.picture!.lessons[0].id === "l11" && k.picture!.lessons[11].id === "l0");
check("each carries its date", k.picture!.lessons.every((l) => /^\d{4}-\d\d-\d\dT/.test(l.verifiedAt)) && k.picture!.lessons.find((l) => l.id === "l0")!.verifiedAt.startsWith("2025-01-05"));

// ---------------------------------------------------------------- the source link, only when stored
const l3 = k.picture!.lessons.find((l) => l.id === "l3")!;
check("a lesson links to the co_memories row it was saved as", l3.source.memoryId === "l3");
check("the exchange it came from isn't stored, and it says so rather than inventing one", l3.source.exchange === "not stored" && !/exchange_id|exchangeId/.test(JSON.stringify(l3)));
check("a correction carries its own row id and their words", (await read(raw([], [corr("c1")]))).picture!.corrections[0].id === "c1");

// ---------------------------------------------------------------- a newer lesson qualifies an older one, never erases it
const q = await read(raw([lesson("old", "keep the texts short when they are busy with the launch", "2026-08-01T10:00:00Z"), lesson("new", "keep texts short when they are busy, but more detail on weekends", "2026-10-01T10:00:00Z"), lesson("other", "never joke about their sister", "2026-09-01T10:00:00Z")]));
const byId = (id: string) => q.picture!.lessons.find((l) => l.id === id)!;
check("both are shown", !!byId("old") && !!byId("new"));
check("the older one points at the newer", byId("old").qualifiedBy === "new" && byId("new").qualifiedBy === null && byId("other").qualifiedBy === null);
check("an unrelated lesson is left alone", byId("other").qualifiedBy === null);
const tight = await read(raw([lesson("old", "keep the texts short when they are busy with the launch", "2026-08-01T10:00:00Z"), lesson("new", "keep texts short when they are busy, but more detail on weekends", "2026-10-01T10:00:00Z"), lesson("other", "never joke about their sister", "2026-09-01T10:00:00Z")]), [], {}, { budget: 0 });
check("budget 0: nothing returned and all 3 counted", tight.picture!.lessons.length === 0 && tight.picture!.lessonsOmitted === 3);
const three = [lesson("old", "keep the texts short when they are busy with the launch", "2026-08-01T10:00:00Z"), lesson("new", "keep texts short when they are busy, but more detail on weekends", "2026-10-01T10:00:00Z"), lesson("other", "never joke about their sister", "2026-09-01T10:00:00Z")];
const sz = (id: string) => JSON.stringify(q.picture!.lessons.find((l) => l.id === id)).length;
const part = await read(raw(three), [], {}, { budget: sz("new") + sz("other") });
check("when the budget is tight, the qualified older one is the one left out, and counted", part.picture!.lessons.map((l) => l.id).sort().join() === "new,other" && part.picture!.lessonsOmitted === 1);

// ---------------------------------------------------------------- the budget holds, counts what's left out
const big = Array.from({ length: 60 }, (_, i) => lesson(`b${i}`, `lesson ${i} ${"word".repeat(40)} unique${i}x${i * 7}`, `2026-0${1 + (i % 9)}-10T10:00:00Z`));
const kb = await read(raw(big), [], {}, { budget: 3000 });
const size = JSON.stringify(kb.picture!.lessons).length + JSON.stringify(kb.picture!.corrections).length;
check("the size stays within the budget", size <= 3000 + 2 * kb.picture!.lessons.length);
check("what didn't fit is counted, not dropped silently", kb.picture!.lessonsOmitted === 60 - kb.picture!.lessons.length && kb.picture!.lessonsOmitted > 0);
check("the default budget is a number of characters, not a count of lessons", L.PICTURE_BUDGET_CHARS > 0 && !/slice\(0, *6\)|LIMIT 6/.test(src("services/knowledge/lessons.ts")));
const bound = raw(twelve.slice(0, 2));
bound.lessonsTotal = 700;
check("rows beyond the read bound are counted too", (await read(bound)).picture!.lessonsOmitted === 698);
const aboutRead = await read(raw([lesson("a", `${"filler ".repeat(30)}about concerts`, "2026-10-02T10:00:00Z"), lesson("b", `${"padding ".repeat(30)}about hiking trips`, "2026-10-03T10:00:00Z")]), [], {}, { budget: JSON.stringify({ id: "a", text: "x".repeat(260), source: { memoryId: "a", exchange: "not stored" }, qualifiedBy: null, verifiedAt: "2026-10-02T10:00:00.000Z" }).length + L.LESSONS_RESERVE_CHARS * 0 + 40, about: "plan hiking trips" });
check("with room for one, the one that fits the decision wins over the newer", aboutRead.picture!.lessons.length === 1 && aboutRead.picture!.lessons[0].id === "b");

// ---------------------------------------------------------------- corrections: a budget, no window, a later one qualifies
const cs = await read(raw([], [corr("c1", { at: d("2025-03-01T10:00:00Z"), was: "Oakland", now: "Berkeley" }), corr("c2", { at: d("2026-10-20T10:00:00Z"), was: "Berkeley", now: "Boston", quote: "now I'm in Boston" }), corr("c3", { field: "work", itemRef: "profile:work", was: "Stripe", now: "Ramp", at: d("2024-01-01T10:00:00Z"), quote: "at Ramp now" })]));
check("a 90-day window no longer applies: a 2025 and a 2024 correction are returned", cs.picture!.corrections.length === 3);
check("newest first", cs.picture!.corrections.map((c) => c.id).join() === "c2,c1,c3");
check("the later correction qualifies the earlier: both shown, the earlier points at the later", cs.picture!.corrections.find((c) => c.id === "c1")!.qualifiedBy === "c2" && cs.picture!.corrections.find((c) => c.id === "c2")!.qualifiedBy === null && cs.picture!.corrections.find((c) => c.id === "c1")!.now === "Berkeley");
check("an unrelated correction isn't qualified", cs.picture!.corrections.find((c) => c.id === "c3")!.qualifiedBy === null);
const chain = await read(raw([], [corr("x1", { itemRef: "", field: "plan", was: "A", now: "B", at: d("2026-01-01T10:00:00Z") }), corr("x2", { itemRef: "", field: "plan", was: "B", now: "C", at: d("2026-02-01T10:00:00Z") })]));
check("a later correction whose was is the earlier one's now qualifies it (no item ref needed)", chain.picture!.corrections.find((c) => c.id === "x1")!.qualifiedBy === "x2");
const first = await read(raw([lesson("L1", `lesson ${"y".repeat(250)}`, "2026-10-01T10:00:00Z")], Array.from({ length: 30 }, (_, i) => corr(`k${i}`, { itemRef: `i${i}`, field: `f${i}`, was: `was ${i} ${"z".repeat(200)}`, now: `now ${i}`, at: d(`2026-09-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00Z`) }))), [], {}, { budget: 4000 });
check("corrections go first in the budget, but the lessons keep their reserve", first.picture!.corrections.length > 0 && first.picture!.lessons.length === 1);
check("corrections left out are counted", first.picture!.correctionsOmitted === 30 - first.picture!.corrections.length && first.picture!.correctionsOmitted > 0);

// ---------------------------------------------------------------- limits: each item's own date, else undated
const lim = await read(raw([]), [], {}, undefined, { ...LIMITS, rules: [{ id: "r1", area: "contact", channel: "any", covers: "all", rule: {}, basis: "explicit", type: "standing", words: ["no texts before 10am"], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: "UTC", state: "active", setAt: "2026-09-15T08:00:00.000Z" }] });
check("an avoid item has no stored date: marked undated, no date given", lim.picture!.limits.avoid[0].text === "crypto events" && lim.picture!.limits.avoid[0].dated === false && lim.picture!.limits.avoid[0].verifiedAt === null);
check("co_profiles.updated_at is not used as an item's date", !JSON.stringify(lim.picture!.limits).includes("2026-11-01"));
check("a rule carries its own setAt", lim.picture!.limits.rules[0].dated === true && lim.picture!.limits.rules[0].verifiedAt === "2026-09-15T08:00:00.000Z" && lim.picture!.limits.rules[0].text === "no texts before 10am");
check("limits are never cut by the budget", (await read(raw([]), [], {}, { budget: 0 })).picture!.limits.avoid.length === 1);

// ---------------------------------------------------------------- forgotten content isn't returned
const fg = await read(raw([lesson("la", "never mention the divorce proceedings when they talk about weekends", "2026-10-01T10:00:00Z"), lesson("lb", "short texts when they are busy", "2026-10-02T10:00:00Z")], [corr("ca", { field: "family", itemRef: "claim:1", was: "the divorce proceedings", now: "separated", quote: "we separated" }), corr("cb")]), [{ old: "divorce proceedings", ref: "claim:divorce" }, { old: "crypto events", ref: "avoid:abc12345" }], {}, undefined, { ...LIMITS, avoid: ["crypto events", "mixers"] });
check("a lesson that says a removed thing is gone whole", fg.picture!.lessons.map((l) => l.id).join() === "lb");
check("a correction that says a removed thing is gone, an unrelated one stays", fg.picture!.corrections.map((c) => c.id).join() === "cb");
check("a removed avoid item is gone, the rest stays", fg.picture!.limits.avoid.map((a) => a.text).join() === "mixers");
check("nothing of the removed thing appears anywhere in the result", !/divorce|crypto/i.test(JSON.stringify(fg.picture)));
check("a correction on a removed item (same item ref) is gone", (await read(raw([], [corr("cr", { itemRef: "claim:7", was: "a thing", now: "other" })]), [{ old: "a thing", ref: "claim:7" }])).picture!.corrections.length === 0);
let ranLoader = false;
const failedGuards = await MK.memberKnowledge("u1", { include: ["picture"] }, { ...base(raw(twelve, [corr("c1")])), forgotten: async () => { throw new Error("db down"); }, picture: async () => { ranLoader = true; return raw(twelve); } });
check("fails closed: guards unread gives nothing, not an unguarded list", failedGuards.picture!.lessons.length === 0 && failedGuards.picture!.corrections.length === 0 && failedGuards.picture!.limits.avoid.length === 0 && failedGuards.guardsUnread === true);
const noGuards = await MK.memberKnowledge("u1", { include: ["picture"] }, { ...base(raw(twelve)), forgotten: undefined });
check("fails closed: no guards wired gives nothing", noGuards.picture!.lessons.length === 0);
const lost = await MK.memberKnowledge("u1", { include: ["picture"] }, { ...base(raw(twelve)), picture: async () => { throw new Error("db down"); } });
check("a failed lessons read is said unread, never an empty picture passed off as whole", lost.picture!.unread === true);
const lostLim = await MK.memberKnowledge("u1", { include: ["picture"] }, { ...base(raw(twelve)), limits: async () => { throw new Error("db down"); } });
check("a failed limits read is said unread too", lostLim.picture!.unread === true);

// ---------------------------------------------------------------- isolation
const leak = await read(raw([lesson("m", "keep it light when Maya's Stripe job comes up", "2026-10-01T10:00:00Z")], [corr("mc", { was: "Maya works at Stripe", now: "Maya left Stripe", quote: "Maya left Stripe" })]));
check("another member's name is stripped from lessons and corrections (the strip runs over the whole result)", !/Stripe|job/.test(JSON.stringify(leak.picture!.lessons)) && !/Stripe/.test(JSON.stringify([leak.picture!.corrections[0].was, leak.picture!.corrections[0].now])));
const seen: { sql: string; args: unknown[] }[] = [];
await L.loadPictureRaw("user-aaa", { query: async (sql, args) => (seen.push({ sql, args }), { rows: [] }) });
check("two queries, both bound to the member's id as $1, never in the SQL text", seen.length === 2 && seen.every((s) => s.args[0] === "user-aaa" && /user_id = \$1/.test(s.sql) && !s.sql.includes("user-aaa")));
check("the lessons query reads only co_lesson rows of that member", /FROM co_memories WHERE user_id = \$1 AND memory_type = 'co_lesson'/.test(seen[0].sql));
check("the corrections query never reads a removal", /removed'\) IS DISTINCT FROM 'true'/.test(seen[1].sql));

// ---------------------------------------------------------------- the prompts are unchanged
check("opt-in only: not in the default sections", !(MK.KNOWLEDGE_SECTIONS as readonly string[]).includes("picture") && (MK.OPT_IN_SECTIONS as readonly string[]).includes("picture"));
let ran = false;
const none = await MK.memberKnowledge("u1", { include: ["lessons"] }, { ...base(raw(twelve)), lessons: async () => [], picture: async () => { ran = true; return raw(twelve); } });
check("without opting in, the loader never runs and the picture is absent", !ran && none.picture === undefined);
const mk = src("services/memberKnowledge.ts");
check("the default lessons read keeps its newest-6 for the prompt path", /memory_type = 'co_lesson' ORDER BY created_at DESC LIMIT 6/.test(mk));
check("the default corrections read keeps its 8 rows / 90 days", /limit: 8, days: 90/.test(mk));

console.log(`member lessons: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
