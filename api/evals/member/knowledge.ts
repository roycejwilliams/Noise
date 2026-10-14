// Model-free checks for the member-knowledge layer (services/memberKnowledge.ts, 2026-10-09): one assembler, every fact stamped
// with when it was last verified, and another member's details stripped inside it. Every loader is injected: no database, no model.
//   npx tsx evals/member/knowledge.ts
import { readFileSync } from "fs";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const MK = await import("../../src/services/memberKnowledge.js");
const { memberKnowledge, memberRules, restraintOf, KNOWLEDGE_SECTIONS } = MK;
const { DISCRETION_GUIDE } = await import("../../src/harness/discretion.js");
const { CO_GROUNDING, CO_MEMBER_SAFETY } = await import("../../src/services/coCore.js");
const { DELIVERY_SHAPE_RULE, ACK_FRESH_MS } = await import("../../src/services/speakable.js");
const { goalHash } = await import("../../src/services/goalEdges.js");
const { historyLine } = await import("../../src/services/memberSafeMemories.js");
const { unansweredPauseFor } = await import("../../src/harness/proactive.js");
type Deps = import("../../src/services/memberKnowledge.js").KnowledgeDeps;
type Receipt = import("../../src/services/deliveryReceipts.js").Receipt;
type CoTask = import("../../src/services/coTasks.js").CoTask;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- fixtures: one member, Jordan, linked with Maya
const NOW = new Date("2026-10-09T18:00:00Z"); // 2pm in New York
const H = 3_600_000;
const ago = (h: number) => new Date(NOW.getTime() - h * H);
const LINKED = "Maya";
// Maya's details: these words may never leave the layer except in Jordan's own words.
const HER_DETAILS = ["Stripe", "Austin"];

const receipt = (o: Partial<Receipt> & { id: number; docKey: string; title: string; version: number; deliveredAt: Date }): Receipt => ({
  userId: "u1",
  kind: "plan",
  doc: { title: o.title, sections: [] } as any,
  contentHash: `h${o.id}`,
  channel: "pdf_text",
  status: "delivered",
  line: null,
  link: null,
  taskId: null,
  source: "test",
  changeNote: null,
  error: null,
  attempts: 0,
  nextRetryAt: null,
  ...o,
});
const task = (o: Partial<CoTask> & { id: number; goal: string }): CoTask => ({
  userId: "u1",
  theirWords: "",
  steps: [],
  planNext: null,
  nextCheckAt: null,
  status: "open",
  wakes: 0,
  notes: [],
  textsSent: 0,
  lastTextedAt: null,
  createdAt: ago(48).toISOString(),
  deadline: null,
  finalCheckAt: null,
  finalTold: false,
  awaitingReply: false,
  theirReplyAt: null,
  kind: "work",
  source: "ask",
  window: null,
  ...o,
});

const calls: string[] = [];
let exchangeArgs: { limit: number; days: number } | null = null;
const deps = (): Deps => ({
  profile: async () => (calls.push("profile"), {
    firstName: "Jordan",
    city: "Oakland",
    goals: ["raise a seed round"],
    intent: [
      { kind: "goal", text: "find a cofounder", status: "resolved", created_at: ago(900).toISOString(), resolved_at: ago(200).toISOString() },
      { kind: "goal", text: "run a marathon", status: "active", created_at: ago(300).toISOString() },
      { kind: "ask", text: "find a climbing gym", status: "active", created_at: ago(30).toISOString() },
    ],
    updatedAt: ago(10),
  }),
  zone: async () => (calls.push("zone"), "America/New_York"),
  linkedNames: async () => (calls.push("linkedNames"), [LINKED]),
  goalStates: async () => (calls.push("goalStates"), [
    { goalHash: goalHash("raise a seed round"), goal: "raise a seed round", state: "stale", reason: "not mentioned in 60 days", source: "context", changedAt: ago(5), toldAt: null, hints: 0 },
    { goalHash: goalHash("learn piano"), goal: "learn piano", state: "done", reason: "they said they finished", source: "member", changedAt: ago(400), toldAt: ago(400), hints: 0 },
  ]),
  asks: async () => (calls.push("asks"), [{ id: "a1", text: "find a climbing gym", kind: "find", createdAt: ago(30), lastMentionedAt: ago(3) }]),
  receipts: async () => (calls.push("receipts"), [
    receipt({ id: 11, docKey: "pitch plan", title: "Pitch Plan", version: 1, deliveredAt: ago(30) }),
    receipt({ id: 12, docKey: "pitch plan", title: "Pitch Plan", version: 2, deliveredAt: ago(20) }),
  ]),
  ledgerSent: async () => (calls.push("ledgerSent"), [
    { label: "a document (PDF): Pitch Plan", url: null, kind: null, at: ago(20) },
    { label: "Founder Dinner", url: "https://lu.ma/founder-dinner", kind: "event", at: ago(26) },
    { label: "Dinner with Maya at Zuni. Maya just left Stripe for Austin.", url: null, kind: "event", at: ago(50) },
  ]),
  offers: async () => (calls.push("offers"), [
    { key: "event:fd", name: "Founder Dinner", kind: "event", url: "http://www.lu.ma/founder-dinner/", sentAt: ago(24), reaction: "Loved", details: null, postText: null },
    { key: "name:ai fellowship", name: "AI Fellowship", kind: "opportunity", url: null, sentAt: ago(60), reaction: null, details: null, postText: null },
  ]),
  tasks: async () => (calls.push("tasks"), [
    task({ id: 7, goal: "find a climbing gym near Oakland", nextCheckAt: ago(1).toISOString() }),
    task({ id: 8, goal: "Keep your promise: send the investor list", source: "promise" }),
    task({ id: 9, goal: "set up coffee with Maya, who is moving to Austin", deadline: "2026-10-20" }),
  ]),
  briefs: async () => (calls.push("briefs"), [{ id: 4, goal: "venues for a team offsite", theirWords: "", status: "done", createdAt: ago(80).toISOString(), closedAt: ago(40).toISOString(), outcome: null, held: null }]),
  loops: async () => (calls.push("loops"), [
    { id: 31, title: "Maya's intro follow-up", status: "waiting_on_them", dueDate: null, source: "member", detail: "Maya is moving to Austin and leaving Stripe", changedAt: ago(6), lastConfirmedAt: ago(4) },
    { id: 32, title: "task loop", status: "open", dueDate: null, source: "task", detail: null, changedAt: ago(6), lastConfirmedAt: null },
  ]),
  promiseResults: async () => (calls.push("promiseResults"), [
    { at: ago(15), content: 'Looked into "the pitch plan doc" after the call. Not sent yet.' },
    { at: ago(14), content: 'Looked into "an intro email draft for the accelerator" after the call. Not sent yet.' },
    { at: ago(13), content: 'Looked into "the investor list" after the call. Not sent yet.' },
  ]),
  lessons: async () => (calls.push("lessons"), [{ text: "Don't text before 9am.", at: ago(100) }]),
  corrections: async () => (calls.push("corrections"), [{ field: "city", old_value: "San Francisco", new_value: "Oakland", corrected_at: ago(200) }]),
  taste: async () => (calls.push("taste"), { text: "From what they've told Cue about things it sent, they went to or liked: Founder Dinner.", at: ago(12) }),
  claims: async () => (calls.push("claims"), [
    { text: "Training for the Oakland marathon", provenance: "user_said", kind: "plan", quote: "Maya says I should run Austin too", saidOn: "2026-10-01", confirmedOn: "2026-10-05", expiresOn: "2026-10-12" },
    { text: "Meeting Maya, who is leaving Stripe, on Friday.", provenance: "co_inferred", kind: "meeting", quote: null, saidOn: "2026-10-07", confirmedOn: "2026-10-07", expiresOn: "2026-10-10" },
  ]),
  restraint: async () => (calls.push("restraint"), {
    holdUntil: ago(2), // past: not on
    spaceUntil: new Date(NOW.getTime() + 5 * H),
    safetyHold: false,
    emotional: { needsCare: true, withCo: { frustrated: false, about: null, count: 0 }, current: { source: "text", emotion: "stressed", intensity: "medium", valence: "negative", about: "Maya leaving Stripe", quote: null, at: ago(2) } },
    suppressed: ["goal_nudge"],
    trial: [],
    lastInboundAt: ago(40),
    unansweredSends: [ago(30), ago(20)],
  }),
  exchanges: async (_u, o) => (calls.push("exchanges"), (exchangeArgs = o), [
    { content: "Co replied: Maya is leaving Stripe for Austin, so worth catching her before.", at: ago(41) },
    { content: "User said: Maya told me she's moving to Austin, crazy", at: ago(40) },
    { content: "[Call] Talked about the marathon and the pitch plan.", at: ago(35) },
    { content: "Cue message failed to deliver", at: ago(34) },
  ]),
  person: async () => (calls.push("person"), "Who they are:\nJordan is training for a marathon.\nMaya, who left Stripe, is someone Cue matched them with."),
});

const k = await memberKnowledge("u1", { now: NOW, exchanges: 5, exchangeDays: 3 }, deps());
// ---------------------------------------------------------------- goals: done/stale are marked, never current
const goal = (t: string) => k.goals.find((g) => g.text === t);
check("goals: a closed entry is done", goal("find a cofounder")?.state === "done");
check("goals: a goal_states stale row marks a profile goal stale", goal("raise a seed round")?.state === "stale" && goal("raise a seed round")?.reason === "not mentioned in 60 days" && goal("raise a seed round")?.told === false);
check("goals: a stored done goal no longer on file still shows, as done", goal("learn piano")?.state === "done");
check("goals: only the live one is active (an ask is never a goal)", JSON.stringify(k.goals.filter((g) => g.state === "active").map((g) => g.text)) === JSON.stringify(["run a marathon"]));
check("goals: active first", k.goals[0].state === "active");

// ---------------------------------------------------------------- identity and zone
check("zone: from memberZone (the injected one)", k.identity.zone === "America/New_York" && k.identity.timeZone === "America/New_York");
check("identity: name and city", k.identity.firstName === "Jordan" && k.identity.city === "Oakland");
check("zone: the real loader is memberZone, never the city lookup", /zone: \(userId\) => memberZone\(userId\)/.test(src("services/memberKnowledge.ts")) && !/getTimezoneForCity/.test(src("services/memberKnowledge.ts")));
{
  const unknown = await memberKnowledge("u1", { now: NOW, include: [] }, { ...deps(), zone: async () => null });
  check("zone: none known keeps null, and time is measured in the fallback", unknown.identity.zone === null && unknown.identity.timeZone === "America/Los_Angeles");
}

// ---------------------------------------------------------------- asks
check("asks: open asks with id, kind and last mention", k.asks.length === 1 && k.asks[0].id === "a1" && k.asks[0].kind === "find" && k.asks[0].verifiedAt === ago(3).toISOString());

// ---------------------------------------------------------------- delivered: merged and deduped
const dv = (w: string) => k.delivered.filter((d) => d.what.includes(w));
check("delivered: one entry per thing across receipts, ledger and offers", k.delivered.length === 4);
check("delivered: a document's versions and its ledger line are one entry", dv("Pitch Plan").length === 1 && dv("Pitch Plan")[0].via.includes("receipt") && dv("Pitch Plan")[0].via.includes("ledger") && dv("Pitch Plan")[0].kind === "document");
check("delivered: the newest version's time", dv("Pitch Plan")[0].at === ago(20).toISOString());
check("delivered: same URL (scheme, www, trailing slash) is the same thing; the reaction carries over", dv("Founder Dinner").length === 1 && dv("Founder Dinner")[0].via.join(",") === "ledger,offer" && dv("Founder Dinner")[0].reaction === "Loved" && dv("Founder Dinner")[0].at === ago(24).toISOString());
check("delivered: newest first", k.delivered.every((d, i) => i === 0 || k.delivered[i - 1].at >= d.at));

// ---------------------------------------------------------------- carrying: one list
const cr = (pred: (c: (typeof k.carrying)[number]) => boolean) => k.carrying.filter(pred);
check("carrying: a work task, due (its check is past), not told", cr((c) => c.ref === "task #7").length === 1 && cr((c) => c.ref === "task #7")[0].state === "due" && cr((c) => c.ref === "task #7")[0].told === false);
check("carrying: a promise task is told, its prefix gone", cr((c) => c.ref === "task #8")[0]?.kind === "promise" && cr((c) => c.ref === "task #8")[0]?.told === true && cr((c) => c.ref === "task #8")[0]?.what === "send the investor list");
check("carrying: the document, once, newest version, they have it", cr((c) => c.kind === "document").length === 1 && cr((c) => c.kind === "document")[0].ref === "doc #12" && cr((c) => c.kind === "document")[0].theyHaveIt);
check("carrying: a call promise a delivery covers is done and theirs", cr((c) => c.kind === "promise" && c.what === "the pitch plan doc")[0]?.state === "done" && cr((c) => c.what === "the pitch plan doc")[0]?.theyHaveIt === true);
check("carrying: an open call promise is outstanding and told", cr((c) => c.what === "an intro email draft for the accelerator")[0]?.state === "outstanding" && cr((c) => c.what === "an intro email draft for the accelerator")[0]?.told === true && !cr((c) => c.what === "an intro email draft for the accelerator")[0]?.theyHaveIt);
check("carrying: a call promise that is also a task shows once", cr((c) => /investor list/.test(c.what)).length === 1);
check("carrying: a non-task loop with its status; task loops are the tasks", cr((c) => c.ref === "loop 31")[0]?.status === "waiting_on_them" && !cr((c) => c.ref === "loop 32").length);
check("carrying: a finished brief is done", cr((c) => c.ref === "brief #4")[0]?.state === "done");
check("carrying: due, then outstanding, then done", k.carrying.map((c) => ({ due: 0, outstanding: 1, done: 2 })[c.state]).every((r, i, a) => i === 0 || a[i - 1] <= r));

// ---------------------------------------------------------------- lessons, corrections, preferences, claims, exchanges
check("lessons: with their time", k.lessons[0]?.text === "Don't text before 9am." && k.lessons[0]?.verifiedAt === ago(100).toISOString());
check("corrections: was and now", k.corrections[0]?.field === "city" && k.corrections[0]?.was === "San Francisco" && k.corrections[0]?.now === "Oakland");
check("preferences: the taste summary, stamped", k.preferences[0]?.source === "taste" && k.preferences[0]?.verifiedAt === ago(12).toISOString());
check("claims: stamped with when they last confirmed it", k.claims[0]?.verifiedAt === new Date("2026-10-05").toISOString() && k.claims[0]?.provenance === "user_said");
check("exchanges: oldest first, member and Cue apart, a call summary marked, a non-exchange dropped", k.exchanges.length === 3 && k.exchanges[0].from === "co" && k.exchanges[1].from === "member" && k.exchanges[2].call === true);
check("exchanges: the window is passed through", exchangeArgs?.limit === 5 && exchangeArgs?.days === 3);

// ---------------------------------------------------------------- stripping: every text field
type Found = { path: string; text: string };
const strings = (v: unknown, path = "", own = false): Found[] => {
  if (typeof v === "string") return own ? [] : [{ path, text: v }];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    const member = (v as any).from === "member";
    return Object.entries(v).flatMap(([key, x]) => strings(x, `${path}.${key}`, (member && key === "text") || key === "quote"));
  }
  return [];
};
const all = strings(k);
const leaks = all.filter((s) => HER_DETAILS.some((w) => s.text.includes(w)));
check(`strip: none of ${LINKED}'s details anywhere but their own words${leaks.length ? ` (${leaks.map((l) => l.path).join(", ")})` : ""}`, leaks.length === 0);
const okLines = new Set([historyLine("introduced", LINKED), historyLine("matched", LINKED), historyLine("x", LINKED)]);
// What's left of a string once its history lines are taken out never names them.
const named = all.filter((s) => s.text.includes(LINKED));
const raw = named.filter((s) => [...okLines].reduce((t, l) => t.split(l).join(""), s.text).includes(LINKED));
check(`strip: every Co-written mention of ${LINKED} is a history line${raw.length ? ` (${raw.map((r) => `${r.path}: ${r.text}`).join(" | ")})` : ""}`, raw.length === 0);
check("strip: reached the exchanges, carrying, loops, delivered, claims, restraint and person", ["exchanges", "carrying", "delivered", "claims", "restraint", "person"].every((s) => named.some((n) => n.path.startsWith(`.${s}`))));
check("strip: their own words are kept as they said them", k.exchanges.some((e) => e.from === "member" && e.text === "Maya told me she's moving to Austin, crazy") && k.claims[0].quote === "Maya says I should run Austin too");
{
  const none = await memberKnowledge("u1", { now: NOW }, { ...deps(), linkedNames: async () => [] });
  check("strip: with no linked members nothing is rewritten", none.exchanges[0].text === "Maya is leaving Stripe for Austin, so worth catching her before.");
}
check("strip: the only return of the assembler is the stripped object", (src("services/memberKnowledge.ts").match(/^  return stripDeep\(k, strip\);$/gm) ?? []).length === 1);

// ---------------------------------------------------------------- every fact has verifiedAt
const isIso = (s: unknown) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s as string).toISOString() === s;
const facts = [k.identity, ...k.goals, ...k.asks, ...k.delivered, ...k.carrying, ...k.lessons, ...k.corrections, ...k.preferences, ...k.claims, ...k.exchanges, k.restraint, k.person];
check("verifiedAt: every fact carries an ISO time", facts.every((f) => f && isIso((f as any).verifiedAt)));
check("verifiedAt: from the source row (a loop's last confirmation, a goal state's change)", cr((c) => c.ref === "loop 31")[0]?.verifiedAt === ago(4).toISOString() && goal("raise a seed round")?.verifiedAt === ago(5).toISOString());
check("every section is in the result", KNOWLEDGE_SECTIONS.every((s) => s in k));

// ---------------------------------------------------------------- restraint
check("restraint: a past hold is off, space ahead is on", k.restraint?.holdUntil === null && k.restraint?.spaceUntil === new Date(NOW.getTime() + 5 * H).toISOString());
check("restraint: care, muted kinds and the unanswered count", k.restraint?.needsCare === true && k.restraint?.suppressedKinds.join() === "goal_nudge" && k.restraint?.unanswered.count === 2);
for (const n of [1, 2, 3, 4, 5]) {
  const last = new Date(NOW.getTime() - H);
  const r = restraintOf({ holdUntil: null, spaceUntil: null, safetyHold: false, emotional: null, suppressed: [], trial: [], lastInboundAt: null, unansweredSends: Array.from({ length: n }, () => last) }, NOW);
  check(`restraint: the unanswered count after ${n}, no pause date (the gate's, per lane)`, r.unanswered.count === n && !("pausedUntil" in r.unanswered));
}

// ---------------------------------------------------------------- include narrows the loads
{
  calls.length = 0;
  const only = await memberKnowledge("u1", { now: NOW, include: ["asks"] }, deps());
  const loaded = new Set(calls);
  check("include: only the asked-for section's loaders run (plus identity, zone and names)", [...loaded].every((c) => ["profile", "zone", "linkedNames", "asks"].includes(c)));
  check("include: other sections come back empty", only.asks.length === 1 && only.goals.length === 0 && only.carrying.length === 0 && only.restraint === null && only.person === null);
}
{
  const broken = await memberKnowledge("u1", { now: NOW }, { ...deps(), receipts: async () => { throw new Error("db down"); } });
  check("a failed read is an empty part, never a throw", broken.delivered.length === 4 && broken.delivered.every((d) => !d.via.includes("receipt")) && broken.asks.length === 1);
}

// ---------------------------------------------------------------- memberRules: the shared constants
const rules = memberRules(k);
check("rules: discretion is DISCRETION_GUIDE itself", rules.discretion === DISCRETION_GUIDE);
check("rules: grounding is CO_GROUNDING itself", rules.grounding === CO_GROUNDING);
check("rules: member safety is CO_MEMBER_SAFETY itself", rules.memberSafety === CO_MEMBER_SAFETY);
check("rules: delivery shape is DELIVERY_SHAPE_RULE, with the same freshness the code checks", rules.deliveryShape === DELIVERY_SHAPE_RULE && DELIVERY_SHAPE_RULE.includes(`${ACK_FRESH_MS / 60_000} minutes`));
check("rules: quiet hours are 8am to 9pm in their zone, with where now sits", /before 8am or from 9pm their time \(America\/New_York\)/.test(rules.quietHours) && /It's 2:00pm there now\.$/.test(rules.quietHours));
{
  const late = memberRules({ ...k, asOf: new Date("2026-10-10T03:30:00Z").toISOString() });
  check("rules: 11:30pm their time is inside quiet hours", /11:30pm there now, inside their quiet hours/.test(late.quietHours));
}
check("rules: restraint is read from their state", /space/.test(rules.restraint) && /goal_nudge/.test(rules.restraint) && /hard time/.test(rules.restraint) && !rules.restraint.includes("Cue starts nothing on its own until"));
check("rules: no restraint read, no restraint rule", memberRules({ ...k, restraint: null }).restraint === "");

// Fails closed (PR #118): a failed name read rejects the whole call; nothing unstripped comes back.
{
  const rejected = await MK.memberKnowledge("u-fail", {}, { linkedNames: async () => { throw new Error("db down"); } } as any).then(() => false).catch(() => true);
  check("a failed name read rejects memberKnowledge instead of returning unstripped facts", rejected);
}
// Review of #119.
{
  // An unsent call promise isn't dropped because another promise naming a deliverable was sent (no "Oct 8:" prefix before).
  const items = MK.carryingOf({ tasks: [], briefs: [], receipts: [], loops: [], ledger: [], zone: "America/Los_Angeles", now: new Date("2026-10-09T18:00:00Z"),
    promises: [
      { at: new Date("2026-10-08T23:00:00Z"), content: 'Cue said on the call it would send "the dinner spot document for Friday" and sent it.' },
      { at: new Date("2026-10-08T23:01:00Z"), content: 'Looked into "the investor update outline document" after the call, as Cue said it would, and found nothing good enough to send yet.' },
    ] } as any);
  check(`an unsent call promise stays outstanding next to a sent one (${items.map((i: any) => `${i.state}: ${i.what}`).join(" | ")})`, items.some((i: any) => /investor update outline/.test(i.what) && i.state === "outstanding"));
  // Their voice memos and Co's hold texts are exchanges too.
  check("a member's voice memo is their exchange", MK.exchangeOf({ content: "User sent a voice memo: running late, sorry", at: new Date() })?.from === "member");
  check("Cue's own 'Co is looking:' line is Cue's exchange", MK.exchangeOf({ content: "Co is looking: a caterer for the open house", at: new Date() })?.from === "co");
  // The restraint rule states the count, never an invented pause date.
  const rr = MK.restraintRule({ holdUntil: null, spaceUntil: null, safetyHold: false, needsCare: false, frustratedWithCo: false, feeling: null, suppressedKinds: [], trialKinds: [], unanswered: { count: 4, lastInboundAt: null, lastSentAt: new Date().toISOString() }, verifiedAt: new Date().toISOString() } as any, "America/Los_Angeles");
  check(`the restraint rule gives the unanswered count, no pause date ("${rr.slice(0, 120)}")`, /4 of Cue's own texts/.test(rr) && !/pause runs to/.test(rr));
}
check("a failed-send note is not an exchange", MK.exchangeOf({ content: "Cue message failed to deliver: 30001 — Unknown", at: new Date() }) === null);
console.log(`member knowledge: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
