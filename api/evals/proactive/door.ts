// One door (harness/door.ts, notification grouping PR A, Royce 2026-11-02): everything Cue sends on its own goes through the daily pick,
// which gathers for GATHER_MINUTES, ranks matching first (requested and within hours > a possible intro > requested results > a find >
// a check-in) and drops what expired. Layer 1: zero tokens, no database (an in-memory store), no outside calls.
//   npx tsx evals/proactive/door.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
delete process.env.PROACTIVE_PAUSED_TYPES;
import { readFileSync } from "fs";
const PR = await import("../../src/harness/proactive.js");
const DR = await import("../../src/harness/door.js");
const G = await import("../../src/harness/notifyGate.js");
const PF = await import("../../src/harness/payloadFirst.js");
const A = await import("../../src/harness/attention.js");
const { DateTime } = await import("luxon");
const CG = await import("../../src/harness/callGate.js");
const D = await import("../../src/services/deferredSends.js");
const RB = await import("../../src/services/researchBrief.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const { default: pool } = await import("../../src/db/db.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");
// No model call from this file, under the runner or run alone (#361 follow-up: staleWatch.tell's voice line went to a live model and
// only failed on the placeholder key): the voice line is written by a fake, and memory embeddings answer with a zero vector.
const VL = await import("../../src/services/voiceLine.js");
const EMB = await import("../../src/services/embeddings.js");
const lineAsks: string[] = [];
VL.setLineWriterForTests(async (ask) => { lineAsks.push(ask.purpose); return null; });
EMB.setEmbeddingsClientForTests({ embeddings: { create: async (b: any) => ({ data: (Array.isArray(b.input) ? b.input : [b.input]).map((_: unknown, index: number) => ({ index, embedding: new Array(1536).fill(0) })) }) } } as any);
type Candidate = import("../../src/harness/proactive.js").Candidate;
type SendRecord = import("../../src/harness/proactive.js").SendRecord;
type Preference = import("../../src/services/memberPreferences.js").Preference;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const SRC = new URL("../../src/", import.meta.url).pathname;
const src = (f: string) => readFileSync(SRC + f, "utf8");

// ---------------------------------------------------------------- an in-memory store (only what these paths read and write)
const db = { sends: [] as any[], candidates: [] as any[], decisions: [] as any[], outbox: [] as { to: string; content: string }[], inbound: new Map<string, Date>(), calls: [] as any[], tasks: [] as any[], sql: [] as { sql: string; a: any[] }[], paused: false, dispatched: [] as string[] };
const run = async (raw: string, a: any[] = []) => {
  const sql = raw.replace(/\s+/g, " ").trim();
  db.sql.push({ sql, a });
  if (/FROM matching_pauses/.test(sql)) return { rows: db.paused ? [{ scope: "all", reason: "" }] : [] };
  if (/^SELECT \* FROM co_tasks WHERE user_id = \$1 AND id = \$2/.test(sql)) return { rows: db.tasks.filter((t) => t.user_id === a[0] && Number(t.id) === Number(a[1])) };
  if (/^SELECT DISTINCT user_id FROM proactive_candidates WHERE status = 'pending' AND due_at <= NOW\(\)/.test(sql)) {
    const ids = [...new Set(db.candidates.filter((c) => c.status === "pending" && new Date(c.due_at).getTime() <= Date.now()).map((c) => c.user_id))];
    db.dispatched.push(...ids);
    return { rows: ids.map((user_id) => ({ user_id })) };
  }
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
  if (/sms_opted_out/.test(sql) && /FROM users/.test(sql)) return { rows: [{ opted_out: false }] };
  if (/^SELECT MAX\(created_at\) AS at FROM co_memories/.test(sql)) return { rows: [{ at: db.inbound.get(a[0]) ?? null }] };
  if (/^INSERT INTO harness_decisions/.test(sql)) {
    db.decisions.push({ layer: a[0], decision: a[1], user_id: a[2], outcome: a[3], action: a[4], proposal: a[5] ? JSON.parse(a[5]) : null, reason: a[8] });
    return { rows: [{ id: String(db.decisions.length), created_at: new Date() }] };
  }
  // A Cue call counts only when its dial went (the dial's own "Co initiated call" record right after the gate's place_call).
  if (/FROM harness_decisions d WHERE d\.user_id = \$1 AND d\.decision = 'call\.gate' AND d\.action = 'place_call' AND d\.reason = ANY/.test(sql) && /Co initiated call/.test(sql)) return { rows: db.calls.filter((c) => c.user_id === a[0] && a[1].includes(c.reason) && c.dialed !== false) };
  if (/^SELECT id, status, payload, expires_at FROM proactive_candidates WHERE user_id = \$1 AND target_key = \$2 FOR UPDATE/.test(sql)) return { rows: db.candidates.filter((c) => c.user_id === a[0] && c.target_key === a[1]) };
  if (/^SELECT status FROM proactive_candidates WHERE user_id = \$1 AND target_key = \$2/.test(sql)) return { rows: db.candidates.filter((c) => c.user_id === a[0] && c.target_key === a[1]) };
  if (/^SELECT 1 FROM proactive_sends WHERE user_id = \$1 AND target_key = \$2/.test(sql)) return { rows: db.sends.filter((s) => s.user_id === a[0] && s.target_key === a[1]) };
  if (/^INSERT INTO proactive_candidates/.test(sql)) {
    if (db.candidates.some((c) => c.user_id === a[0] && c.target_key === a[2])) return { rows: [] };
    db.candidates.push({ id: db.candidates.length + 1, user_id: a[0], type: a[1], target_key: a[2], topic_key: a[3], summary: a[4], payload: JSON.parse(a[5]), due_at: a[6], expires_at: a[7], priority: a[8], status: "pending" });
    return { rows: [{ id: db.candidates.length }] };
  }
  if (/^INSERT INTO proactive_sends/.test(sql)) {
    if (db.sends.some((s) => s.user_id === a[0] && s.target_key === a[2])) return { rows: [] };
    db.sends.push({ user_id: a[0], type: a[1], target_key: a[2], sent_at: new Date(), exempt: true, notify_class: a[a.length - 1] });
    return { rows: [{ id: db.sends.length }] };
  }
  if (/^SELECT type, target_key, topic_key, sent_at, exempt FROM proactive_sends/.test(sql)) return { rows: /DISTINCT ON/.test(sql) ? [] : db.sends.filter((s) => s.user_id === a[0]).map((s) => ({ ...s, topic_key: s.target_key })) };
  if (/^UPDATE proactive_candidates SET status = 'expired'/.test(sql)) {
    const now = Date.now();
    const out = db.candidates.filter((c) => c.status === "pending" && c.expires_at && new Date(c.expires_at).getTime() <= now);
    for (const c of out) c.status = "expired";
    return { rows: out.map((c) => ({ ...c, created_at: new Date(0), attempts: 0 })) };
  }
  if (/stamped_at/.test(sql)) return { rows: [{ stamped_at: null, co_reply_at: null, running: false }] };
  return { rows: [] };
};
(pool as any).query = (s: string, a?: any[]) => run(s, a);
(pool as any).connect = async () => ({ query: (s: string, a?: any[]) => run(s, a), release: () => {} });
(sendblue as any).messages.send = async (b: any) => {
  db.outbox.push({ to: b.number, content: b.content });
  return { message_handle: `fake-${db.outbox.length}` };
};
const reset = () => { db.sends = []; db.candidates = []; db.decisions = []; db.outbox = []; db.inbound.clear(); db.calls = []; db.tasks = []; db.sql = []; db.paused = false; db.dispatched = []; };

const ZONE = "America/Los_Angeles";
// 2026-11-02 is a Monday, the day after daylight time ended: Pacific is UTC-8.
const pt = (iso: string) => new Date(`${iso}-08:00`);
const HOUR = 3_600_000;
const MIN = 60_000;
const ELI = "86f965f1-0000-4000-8000-000000000001";
const PHONE = "+15035550133";
const hhmm = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(d);

let seq = 0;
const cand = (type: string, over: Partial<Candidate> & { arrives?: Date } = {}): Candidate & { arrives: Date } => {
  const id = over.id ?? String(++seq);
  const created = over.createdAt ?? over.arrives ?? new Date(0);
  return { id, userId: ELI, type: type as any, targetKey: `${type}:${id}`, topicKey: `${type}:${id}`, summary: `${type} ${id}`, priority: PR.TYPE_POLICY[type as keyof typeof PR.TYPE_POLICY]?.priority ?? 50, dueAt: created, expiresAt: null, payload: {}, attempts: 0, createdAt: created, arrives: created, ...over } as any;
};
const doorText = (cls: "requested" | "unsolicited" | "checkin", over: Partial<Candidate> & { arrives?: Date } = {}, extra: any = {}) =>
  cand("task_update", { ...over, payload: { door: true, messages: ["https://lu.ma/9gbayglh", "A founder and builder room this Friday."], cls, writtenAt: (over.arrives ?? new Date(0)).toISOString(), ...extra } });

// ---------------------------------------------------------------- the dispatch, step by step, on a clock (the pure decisions it makes)
// Each tick: expire what's past its valid-until (logged by id), evaluate (every gate the pick reads, the member's own rules too), then
// the door's plan (gather, or the highest band), the pick (Cue's own pick falls back to code when it can't run: codePick), the lead, the
// finds that ride with it (one per tier, the day's find cap), and the ledger rows the send writes. Nothing here is a copy of the
// dispatch's rules: it calls the same exported functions, in the same order.
// PR B (harness/attention.ts), when b is given: the thread read (its model answer stubbed from b.reads, through the real prompt and
// parser), the attention checks inside evaluateCandidates, the lead's riders by thread, and what the send covers (foldPlan), in the
// dispatch's order. Without b, the pick as PR A left it (the "before").
type Sim = { sends: { at: Date; lead: Candidate; riding: Candidate[] }[]; expired: string[]; gathered: Date[]; ledger: (SendRecord & { cls: string })[]; folded: { id: string; into: string; at: Date; why?: string }[]; held: Map<string, Set<string>>; reads: number };
type BOpts = { threads: { id: string; text: string }[]; reads: Record<string, string | null> };
type SimOpts = { candidates: (Candidate & { arrives: Date })[]; from: Date; to: Date; inbound?: Date[]; lastInboundAt?: Date | null; joinedAt?: Date | null; prefs?: (now: Date) => Preference[]; tickMinutes?: number[]; needsCare?: boolean };
function simulate(o: SimOpts): Sim {
  const sim: Sim = { sends: [], expired: [], gathered: [], ledger: [], folded: [], held: new Map(), reads: 0 };
  const pending = new Map<string, Candidate & { arrives: Date }>();
  // The dispatch cron's minutes (jobs/index.ts).
  const minutes = o.tickMinutes ?? [10, 25, 40, 55];
  for (let t = o.from.getTime(); t <= o.to.getTime(); t += MIN) {
    const now = new Date(t);
    if (!minutes.includes(now.getUTCMinutes())) continue;
    for (const c of o.candidates) if (c.arrives.getTime() <= t && !pending.has(c.id) && !sim.sends.some((s) => [s.lead, ...s.riding].some((x) => x.id === c.id)) && !sim.expired.includes(c.id)) pending.set(c.id, c);
    for (const c of [...pending.values()]) if (c.expiresAt && c.expiresAt.getTime() <= t) { pending.delete(c.id); sim.expired.push(c.id); }
    const lastIn = [o.lastInboundAt ?? null, ...(o.inbound ?? []).filter((d) => d.getTime() <= t)].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const sent = G.countedRows(sim.ledger.map((r) => ({ sentAt: r.sentAt, type: r.type, cls: r.cls })));
    const state = { now, timezone: ZONE, optedOut: false, candidates: [...pending.values()], sends: sim.ledger, lastInboundAt: lastIn, joinedAt: o.joinedAt ?? null, memberRules: o.prefs ? { prefs: o.prefs(now), sent } : null };
    const ev = PR.evaluateCandidates(state as any);
    if (!ev.userOk || !ev.eligible.length) continue;
    const plan = PR.doorPlan(ev.eligible, now);
    if (plan.kind === "gather") { sim.gathered.push(now); continue; }
    const urgent = PR.expiringFind(plan.pool, { now, zone: ZONE, sends: sim.ledger });
    const chosen = urgent ? urgent.pick : PR.codePick(plan.pool);
    if (!chosen) continue;
    const lastDay = urgent ? null : PR.lastDayFirst(chosen, plan.pool, { now, zone: ZONE });
    const lead = PR.leadPick(lastDay?.pick ?? chosen, plan.pool);
    const riding = lead.type === "event_offer" ? PR.capBundle(lead, PR.pickSiblingOffers(lead, ev.eligible), PR.DAILY_FIND_CAP).sibs : [];
    const morning = PR.morningFind(lead, now, ZONE);
    sim.ledger.push({ type: lead.type, targetKey: lead.targetKey, topicKey: lead.topicKey, sentAt: now, exempt: PR.sendIsExempt(lead, riding) || morning, cls: G.candidateClass(lead.type, PR.isAnswering(lead), lead.payload) });
    for (const r of riding) sim.ledger.push({ type: r.type, targetKey: r.targetKey, topicKey: r.topicKey, sentAt: now, exempt: true, cls: G.RIDING });
    for (const x of [lead, ...riding]) pending.delete(x.id);
    sim.sends.push({ at: now, lead, riding });
  }
  return sim;
}
async function simulateB(o: SimOpts & { b: BOpts }): Promise<Sim> {
  const sim: Sim = { sends: [], expired: [], gathered: [], ledger: [], folded: [], held: new Map(), reads: 0 };
  const pending = new Map<string, Candidate & { arrives: Date }>();
  const minutes = o.tickMinutes ?? [10, 25, 40, 55];
  const sentItems: { at: Date; c: Candidate }[] = [];
  let lastAsked: { at: Date; asked: boolean } | null = null;
  const all = o.candidates.map((c) => ({ ...c, payload: JSON.parse(JSON.stringify(c.payload ?? {})) }));
  for (let t = o.from.getTime(); t <= o.to.getTime(); t += MIN) {
    const now = new Date(t);
    if (!minutes.includes(now.getUTCMinutes())) continue;
    for (const c of all) if (c.arrives.getTime() <= t && !pending.has(c.id) && !sentItems.some((s) => s.c.id === c.id) && !sim.expired.includes(c.id) && !sim.folded.some((f) => f.id === c.id)) pending.set(c.id, c);
    for (const c of [...pending.values()]) if (c.expiresAt && c.expiresAt.getTime() <= t) { pending.delete(c.id); sim.expired.push(c.id); }
    const inbound = [o.lastInboundAt ?? null, ...(o.inbound ?? [])].filter((d): d is Date => !!d && d.getTime() <= t);
    const lastIn = [...inbound].sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const sent = G.countedRows(sim.ledger.map((r) => ({ sentAt: r.sentAt, type: r.type, cls: r.cls })));
    const dayStart = DateTime.fromJSDate(now).setZone(ZONE).startOf("day").toJSDate().getTime();
    const attention = { sent, inbound, sentToday: sentItems.filter((s) => s.at.getTime() >= dayStart).map((s) => s.c), lastAsked };
    const cands = [...pending.values()];
    // The dispatch's thread read: only when due, through the real prompt and parser; the model's answer is the fixture's.
    const due = A.threadReadDue({ pending: cands, sentToday: attention.sentToday, openThreads: o.b.threads.length }) as Candidate[];
    if (due.length) {
      sim.reads++;
      await A.readThreads({ userId: ELI, items: due, threads: o.b.threads, write: false, generate: async (prompt) => JSON.stringify({ items: due.map((c, i) => { const id = o.b.reads[c.id]; const n = o.b.threads.findIndex((x) => x.id === id); return { n: i + 1, thread: id === undefined ? "unanswered" : n >= 0 && prompt.includes(`T${n + 1}.`) ? `T${n + 1}` : null }; }) }) });
    }
    const state = { now, timezone: ZONE, optedOut: false, candidates: cands, sends: sim.ledger, lastInboundAt: lastIn, joinedAt: o.joinedAt ?? null, needsCare: o.needsCare ?? false, memberRules: { prefs: o.prefs ? o.prefs(now) : [], sent }, attention };
    const ev = PR.evaluateCandidates(state as any);
    for (const p of ev.perCandidate) for (const k of p.checks.filter((x) => !x.pass)) { if (!sim.held.has(p.candidate.id)) sim.held.set(p.candidate.id, new Set()); sim.held.get(p.candidate.id)!.add(k.name); }
    if (!ev.userOk || !ev.eligible.length) continue;
    const plan = PR.doorPlan(ev.eligible, now);
    if (plan.kind === "gather") { sim.gathered.push(now); continue; }
    const urgent = PR.expiringFind(plan.pool, { now, zone: ZONE, sends: sim.ledger });
    const chosen = urgent ? urgent.pick : PR.codePick(plan.pool);
    if (!chosen) continue;
    const lastDay = urgent ? null : PR.lastDayFirst(chosen, plan.pool, { now, zone: ZONE });
    const lead = PR.leadPick(lastDay?.pick ?? chosen, plan.pool);
    const riding = lead.type === "event_offer" ? PR.capBundle(lead, A.threadRiders(lead, PR.pickSiblingOffers(lead, ev.eligible)).riders, PR.DAILY_FIND_CAP).sibs : [];
    const morning = PR.morningFind(lead, now, ZONE);
    sim.ledger.push({ type: lead.type, targetKey: lead.targetKey, topicKey: lead.topicKey, sentAt: now, exempt: PR.sendIsExempt(lead, riding) || morning, cls: G.candidateClass(lead.type, PR.isAnswering(lead), lead.payload) });
    for (const r of riding) sim.ledger.push({ type: r.type, targetKey: r.targetKey, topicKey: r.topicKey, sentAt: now, exempt: true, cls: G.RIDING });
    for (const x of [lead, ...riding]) { pending.delete(x.id); sentItems.push({ at: now, c: x }); }
    // A composed find bundle closes with the interest question; a door text goes as written.
    lastAsked = { at: now, asked: lead.type === "event_offer" };
    for (const f of A.foldPlan({ included: [lead, ...riding], pending: [...pending.values()], classOf: (x) => G.candidateClass(x.type as any, PR.isAnswering(x as Candidate), x.payload) })) {
      pending.delete(f.candidate.id);
      sim.folded.push({ id: f.candidate.id, into: lead.id, at: now, why: f.why });
    }
    sim.sends.push({ at: now, lead, riding });
  }
  return sim;
}
const describe = (s: Sim) => s.sends.map((x) => `${hhmm(x.at)} ${[x.lead, ...x.riding].map((c) => c.type).join("+")}`).join(", ") || "(none)";

// ================================================================ 1. Eli's 11-02, replayed (dev, member 86f965f1, Pacific)
// Before (proactive_sends on dev, read 11-02): 8:02 event_offer (an ask's find, exempt), 8:15 task_update (task 1108's results, sent
// on its own through sendExempt), 9:10 event_offer (a 9am morning pick, sent around the caps), 12:15 event_offer (a profile pick),
// 3:30 companion. Five messages; at 9:11 he wrote "For now only message me once per day".
// The candidate set as it stood that day (proactive_candidates on dev): 856 the companion reflection (queued 11-01 6pm, good until
// 11-05), 857 the ask's find (8:00, good until 11-22), task 1108's result (8:15, a delivery he asked for on his call), 859 the morning
// pick (9:10, payload.morningDay, the Luma meetup Nov 4) and 860 the second profile pick (9:10, good until 11-05). The voice-read ask
// (850) and the post-call text (853) were held out of the pick all day (a parked type and a held recap): left out here as there.
const eliSet = () => [
  cand("companion", { id: "856", arrives: pt("2026-11-01T18:00:00"), expiresAt: pt("2026-11-05T18:00:00") }),
  cand("event_offer", { id: "857", arrives: pt("2026-11-02T08:00:00"), expiresAt: pt("2026-11-22T23:59:00"), payload: { askId: "ask-eli", askText: "people to build the social agent with", fromProfile: false, picked: true, match: { tier: 3, name: "AATB 2026 Community Collaboration Summit" } } }),
  doorText("requested", { id: "task1108", arrives: pt("2026-11-02T08:15:10"), expiresAt: DR.doorValidUntil("requested", pt("2026-11-02T08:15:10"), ZONE) }, { taskId: 1108 }),
  cand("event_offer", { id: "859", arrives: pt("2026-11-02T09:10:00"), expiresAt: pt("2026-11-04T15:00:00"), payload: { askId: "profile", fromProfile: true, picked: true, morningDay: "2026-11-02", match: { tier: 2, name: "Personal AI Agents Meetup #2" } } }),
  cand("event_offer", { id: "860", arrives: pt("2026-11-02T09:10:00"), expiresAt: pt("2026-11-05T09:10:00"), payload: { askId: "profile", fromProfile: true, picked: true, match: { tier: 3, name: "Build IRL" } } }),
];
const ONCE_A_DAY = (now: Date): Preference[] => now.getTime() >= pt("2026-11-02T09:11:00").getTime() ? [{ id: "eli-1", area: "contact", channel: "all", covers: "all", rule: { maxPerDay: 1 }, basis: "explicit", type: "standing", words: ["For now only message me once per day"], source: { via: "text", ref: null }, startsAt: pt("2026-11-02T09:11:00").toISOString(), expiresAt: null, zone: ZONE, state: "active", setAt: pt("2026-11-02T09:11:00").toISOString() } as any] : [];
const eliDay = { from: pt("2026-11-02T07:50:00"), to: pt("2026-11-02T21:00:00"), lastInboundAt: pt("2026-11-01T14:47:00"), inbound: [pt("2026-11-02T09:11:00")], joinedAt: pt("2026-11-01T13:59:00") };
{
  const withRule = simulate({ candidates: eliSet(), ...eliDay, prefs: ONCE_A_DAY });
  const morning = withRule.sends.filter((s) => s.at.getTime() < pt("2026-11-02T12:00:00").getTime());
  console.log(`  Eli 11-02, his once-a-day rule from 9:11: ${describe(withRule)}`);
  check("Eli: one composed send in the morning window", morning.length === 1 && morning[0].at.getTime() > pt("2026-11-02T08:15:00").getTime() && morning[0].at.getTime() <= pt("2026-11-02T08:40:00").getTime());
  check("Eli: nothing at 8:15 (the task's results wait at the door) and nothing at 9:10 (the morning picks wait their turn)", !withRule.sends.some((s) => ["8:15", "9:10", "08:15", "09:10"].includes(hhmm(s.at))));
  check("Eli: the morning send gathered first (8:10 waited for what else was coming)", withRule.gathered.some((g) => hhmm(g) === "08:10"));
  check("Eli: with his rule in force, that one send is the whole day", withRule.sends.length === 1);
  check("Eli: the morning send leads with what he asked for (requested results), not a find", G.candidateClass(morning[0].lead.type, PR.isAnswering(morning[0].lead), morning[0].lead.payload) === "requested");
  const noRule = simulate({ candidates: eliSet(), ...eliDay });
  console.log(`  Eli 11-02, no rule: ${describe(noRule)}`);
  check("Eli, no rule: still one send in the morning window and nothing at 8:15 or 9:10", noRule.sends.filter((s) => s.at.getTime() < pt("2026-11-02T11:00:00").getTime()).length === 1 && !noRule.sends.some((s) => ["08:15", "09:10"].includes(hhmm(s.at))));
  check("Eli, no rule: no two sends inside 3 hours, and fewer than the five he got", noRule.sends.length < 5 && noRule.sends.every((s, i) => i === 0 || s.at.getTime() - noRule.sends[i - 1].at.getTime() >= 3 * HOUR));
  check("Eli, no rule: the waiting finds ride together in one later message (one per tier)", noRule.sends.some((s) => s.lead.type === "event_offer" && s.riding.length >= 1));
}

// ================================================================ 1b. Eli's 11-02 with PR B (harness/attention.ts), no rule of his
// His open threads that day (member_threads on dev, Cue's own one-line summaries) and the 9am pick's ids as they stood: 856 is the
// companion check-in on the partners-and-organizers thread (its own threadId), 857 the ask's find (ask id only), task 1108's results
// (task id only), 859 and 860 profile finds. The ids don't connect them, so the one thread read runs; its model answer is stubbed here
// with what that read would most plausibly say (every item is about finding partners and organizers for the agent). Unverified live.
const ELI_THREADS = [
  { id: "t-partners", text: "Finding a technical partner and community organizers to help build and grow the agent" },
  { id: "t-cohost", text: "Trying to co-host an agent-powered matchmaking event with organizers" },
  { id: "t-icp", text: "Still working out the initial customer profile for the agent" },
];
const eliSetB = () => eliSet().map((c) => (c.id === "856" ? { ...c, payload: { ...c.payload, threadId: "t-partners" }, summary: "Weekly reflection: check in on finding a technical partner and community organizers" } : c.id === "task1108" ? { ...c, summary: "Results of work they asked for: find potential co-builders to work on the social agent with" } : c));
const ELI_READS = { "857": "t-partners", task1108: "t-partners", "859": "t-partners", "860": "t-partners" };
{
  const before = simulate({ candidates: eliSet(), ...eliDay });
  const after = await simulateB({ candidates: eliSetB(), ...eliDay, b: { threads: ELI_THREADS, reads: ELI_READS } });
  const day = (s: Sim) => s.sends.filter((x) => hhmm(x.at) < "21:00" && x.at.getTime() < pt("2026-11-03T00:00:00").getTime());
  console.log(`  Eli 11-02, no rule, before B (PR A): ${describe(before)}`);
  console.log(`  Eli 11-02, no rule, after B: ${describe(after)}; folded: ${after.folded.map((f) => `${f.id} into ${f.into} at ${hhmm(f.at)}`).join(", ") || "none"}; waiting: ${["859", "860"].map((id) => `${id} (${[...(after.held.get(id) ?? [])].join("+")})`).join(", ")}`);
  check("B, Eli no rule: before B it was three messages (PR A's replay)", day(before).length === 3);
  // Review of #367: a requested find is never covered by another message's finds. 857 (the find for his own ask) waits and goes as
  // itself, so the honest count is two: what he asked for at 8:25, his ask's find at 11:25. Nothing Cue started on its own goes.
  check("B, Eli no rule: after B, two messages on 11-02 (was three), both things he asked for", day(after).length === 2 && day(after).every((x) => G.candidateClass(x.lead.type, PR.isAnswering(x.lead), x.lead.payload) === "requested"));
  check("B, Eli no rule: the first is what he asked for on his call (task 1108's results), at 8:25", after.sends[0]?.lead.id === "task1108" && hhmm(after.sends[0].at) === "08:25");
  check("B, Eli no rule: the ask's find (requested) is delivered as itself, never folded or lost", after.sends.some((x) => x.lead.id === "857") && !after.folded.some((f) => f.id === "857"));
  check("B, Eli no rule: the check-in about the same thread is covered by the 8:25 message (folded), never a third message", after.folded.some((f) => f.id === "856" && f.into === "task1108"));
  check("B, Eli no rule: the 9:10 profile finds on the thread that already had its message wait for another day (thread_today), not dropped", ["859", "860"].every((id) => after.held.get(id)?.has("thread_today") && !after.folded.some((f) => f.id === id)));
  check("B, Eli no rule: the thread read ran (the ids didn't settle it) and only when there was something to group", after.reads >= 1);
  // The same day with the read answering differently: 860 on the co-hosting thread instead. Still one message (another thread waits).
  const other = await simulateB({ candidates: eliSetB(), ...eliDay, b: { threads: ELI_THREADS, reads: { ...ELI_READS, "860": "t-cohost" } } });
  check("B, Eli no rule: with 860 read onto another thread, still two (a different thing Cue started waits for another day)", day(other).length === 2 && !day(other).some((x) => ["859", "860"].includes(x.lead.id)));
  // The read failing (no answer for any item): the ids alone group nothing across asks, tasks and threads. Said, not hidden: two.
  const unread = await simulateB({ candidates: eliSetB(), ...eliDay, b: { threads: ELI_THREADS, reads: {} } });
  console.log(`  Eli 11-02, no rule, after B with the thread read failing: ${describe(unread)}`);
  check("B, Eli no rule: with the thread read failing, the same two (the check-in, on another key, waits for another day)", day(unread).length === 2 && day(unread).some((x) => x.lead.id === "857") && !day(unread).some((x) => x.lead.id === "856"));
  // His own once-a-day rule from 9:11 still holds under B (his rule wins; the day is the same one message).
  const ruled = await simulateB({ candidates: eliSetB(), ...eliDay, prefs: ONCE_A_DAY, b: { threads: ELI_THREADS, reads: ELI_READS } });
  check("B, Eli with his once-a-day rule: one message", day(ruled).length === 1);
}

// ================================================================ 1c. a hard day: what expires while it's held is dropped as expired, never sent late (review of #367)
{
  const t0 = pt("2026-11-03T09:00:00");
  const ends = pt("2026-11-03T18:00:00");
  const s = await simulateB({ candidates: [cand("event_offer", { id: "hd-1", arrives: t0, expiresAt: ends, payload: { askId: "profile", fromProfile: true, picked: true, match: { tier: 2 } } }), cand("companion", { id: "hd-2", arrives: t0, expiresAt: pt("2026-11-06T09:00:00"), payload: { threadId: "t-x" } })], from: pt("2026-11-03T08:55:00"), to: pt("2026-11-04T12:00:00"), lastInboundAt: pt("2026-11-03T08:00:00"), joinedAt: pt("2026-10-01T10:00:00"), needsCare: true, b: { threads: [], reads: {} } });
  check("B, hard day: a find Cue started that ends during the hold is dropped as expired, never sent late", s.expired.includes("hd-1") && !s.sends.some((x) => [x.lead, ...x.riding].some((c) => c.id === "hd-1")) && !!s.held.get("hd-1")?.has("hard_day"));
  check("B, hard day: companionship still went", s.sends.some((x) => x.lead.id === "hd-2"));
}

// ================================================================ 2. a burst of three sources inside the window is one send
{
  const at = pt("2026-11-03T10:00:00");
  const burst = [
    doorText("requested", { id: "b-task", arrives: at, expiresAt: DR.doorValidUntil("requested", at, ZONE) }),
    cand("event_offer", { id: "b-find", arrives: new Date(at.getTime() + 4 * MIN), expiresAt: pt("2026-11-10T20:00:00"), payload: { askId: "profile", fromProfile: true, picked: true, match: { tier: 2 } } }),
    cand("companion", { id: "b-check", arrives: new Date(at.getTime() + 9 * MIN), expiresAt: pt("2026-11-06T10:00:00") }),
  ];
  const s = simulate({ candidates: burst, from: pt("2026-11-03T09:50:00"), to: pt("2026-11-03T12:00:00"), lastInboundAt: pt("2026-11-03T07:00:00"), joinedAt: pt("2026-10-01T10:00:00") });
  console.log(`  burst of three (10:00, 10:04, 10:09): ${describe(s)}`);
  check("burst: one send for three sources inside the gathering window", s.sends.length === 1);
  check("burst: it waited the window (gathered at 10:10, sent at 10:25)", s.gathered.some((g) => hhmm(g) === "10:10") && hhmm(s.sends[0].at) === "10:25");
  check("burst: the delivery they asked for leads (requested results over a find over a check-in)", s.sends[0].lead.id === "b-task");
  check("gather: the window is a constant of about 20-30 minutes, not an env switch", DR.GATHER_MINUTES >= 20 && DR.GATHER_MINUTES <= 30 && !/process\.env/.test(src("harness/door.ts")));
  check("gather: the dispatch runs every 15 minutes, so a ready item goes 20-35 minutes after it arrived", /cron\.schedule\("10,25,40,55 \* \* \* \*", runDispatch\)/.test(src("jobs/index.ts")));
  check("gather: something already waiting past the window goes at once", DR.gatherUntil([{ id: "x", createdAt: pt("2026-11-03T08:00:00"), dueAt: pt("2026-11-03T08:00:00"), expiresAt: null, payload: {} }], pt("2026-11-03T11:00:00")) === null);
  check("gather: a safety follow-up never waits", DR.gatherUntil([{ id: "x", createdAt: at, dueAt: at, expiresAt: null, payload: { safetyFollowUp: true } }], at) === null);
  check("gather: something that would expire inside the window never waits", DR.gatherUntil([{ id: "x", createdAt: at, dueAt: at, expiresAt: new Date(at.getTime() + 25 * MIN), payload: {} }], at) === null);
  check("gather: the dispatch waits before anything is read or drafted, and says so once per window", /const plan = doorPlan\(ev\.eligible, state\.now, \{ ignorePacing: opts\.ignorePacing \}\);\n  if \(plan\.kind === "gather"\) \{[\s\S]{0,200}recordSkipOnce\(userId, `gather:\$\{plan\.until\.toISOString\(\)\}`/.test(src("harness/proactive.ts")) && src("harness/proactive.ts").indexOf("const plan = doorPlan(") < src("harness/proactive.ts").indexOf("const known = await MK.memberKnowledge("));
}

// ================================================================ 3. priority: matching first
{
  const now = pt("2026-11-03T12:00:00");
  const band = (c: Candidate) => PR.bandOfCandidate(c, now);
  const soonFind = cand("event_offer", { expiresAt: new Date(now.getTime() + 3 * HOUR), payload: { askId: "ask-1", fromProfile: false } });
  const intro = cand("network_tease", { payload: { askId: "ask-1" } });
  const asked = cand("event_offer", { expiresAt: pt("2026-11-20T12:00:00"), payload: { askId: "ask-1", fromProfile: false } });
  const find = cand("event_offer", { expiresAt: pt("2026-11-20T12:00:00"), payload: { askId: "profile", fromProfile: true, picked: true } });
  const checkin = cand("companion");
  const introAsk = cand("direct_ask", { payload: { door: true, cls: "unsolicited", intro: true, messages: ["x"] } });
  const safety = cand("companion", { payload: { safetyFollowUp: true } });
  check("bands: requested and within hours > a possible intro > requested results > a find > a check-in", band(soonFind) > band(intro) && band(intro) > band(asked) && band(asked) > band(find) && band(find) > band(checkin));
  check("bands: an intro ask to the other side ranks as a possible intro", band(introAsk) === DR.BAND.intro);
  check("bands: a safety follow-up is above everything", band(safety) === DR.BAND.safety);
  check("bands: a short-notice find Cue found itself stays a find (it isn't something they asked for)", band(cand("event_offer", { priority: 95, expiresAt: new Date(now.getTime() + 2 * HOUR), payload: { askId: "profile", fromProfile: true } })) === DR.BAND.find);
  const plan = PR.doorPlan([find, intro, checkin].map((c) => ({ ...c, createdAt: pt("2026-11-03T08:00:00"), dueAt: pt("2026-11-03T08:00:00") })), now);
  check("pick: only the highest band reaches the pick (an intro over a find; matching first)", plan.kind === "pick" && plan.pool.length === 1 && plan.pool[0].type === "network_tease");
  check("pick: the ranking extends the picker's own (Cue's pick and code priority still decide within the band), no second ranker", /const banded = topBand\(quiet, \(x\) => bandOfCandidate\(x, state\.now\)\);\n  const pickable = banded\.items;/.test(src("harness/proactive.ts")) && /choosePick\(pickable,/.test(src("harness/proactive.ts")));
}

// ================================================================ 4. expiry: dropped and logged by id, never sent late or in a burst
{
  reset();
  const at = pt("2026-11-03T10:00:00");
  // Queued yesterday evening, held overnight (their hours), its event's start passed at 7:30 before their morning opened.
  const offer = cand("event_offer", { id: "e-1", arrives: pt("2026-11-02T21:30:00"), expiresAt: pt("2026-11-03T07:30:00"), payload: { askId: "profile", fromProfile: true, picked: true, match: { tier: 2 } } });
  const s = simulate({ candidates: [offer], from: pt("2026-11-02T21:30:00"), to: pt("2026-11-03T12:00:00"), lastInboundAt: pt("2026-11-02T07:00:00"), joinedAt: pt("2026-10-01T10:00:00") });
  check("expiry: an event offer past its valid-until is dropped, never sent", s.sends.length === 0 && s.expired.includes("e-1"));
  check("expiry: the gate itself refuses it (not_expired)", PR.candidateChecks(offer, { now: at, sends: [], lastInboundAt: null }).some((c) => c.name === "not_expired" && !c.pass));
  // The dispatch's sweep: each expired row logged by id, and its drop step told.
  db.candidates.push({ id: 41, user_id: ELI, type: "event_offer", target_key: "event_offer:gone", topic_key: "event_offer:gone", summary: "s", payload: { askId: "profile" }, due_at: new Date(0), expires_at: new Date(Date.now() - HOUR), priority: 60, status: "pending" });
  db.candidates.push({ id: 42, user_id: ELI, type: "task_update", target_key: "task:7:1", topic_key: "task:7:1", summary: "s", payload: { door: true, messages: ["x"], cls: "requested", taskId: 7 }, due_at: new Date(0), expires_at: new Date(Date.now() - HOUR), priority: 50, status: "pending" });
  const dropped: string[] = [];
  const reg = { ...proactiveRegistry, event_offer: { ...proactiveRegistry.event_offer, onDropped: async (c: Candidate, status: string) => void dropped.push(`${c.id}:${status}`) }, task_update: { ...proactiveRegistry.task_update, onDropped: async (c: Candidate, status: string) => void dropped.push(`${c.id}:${status}`) } } as any;
  await PR.runProactiveDispatch(reg);
  const logged = db.decisions.filter((d) => d.decision === "proactive.expired");
  check("expiry: the dispatch logs each expired candidate by id (event offer and a door text)", logged.some((d) => d.proposal?.candidate === "41") && logged.some((d) => d.proposal?.candidate === "42"));
  check("expiry: the log carries ids, type and target only (never the text)", logged.every((d) => !JSON.stringify(d).includes('"messages"')));
  check("expiry: each one's drop step runs (a task hears its text never went)", dropped.includes("41:expired") && dropped.includes("42:expired"));
  check("expiry: nothing went out for them", db.outbox.length === 0);
  check("expiry, the real entry point (runProactiveDispatch, the cron's): the rows are expired before any member is dispatched, so the dispatch is never handed them", db.candidates.filter((c) => [41, 42].includes(c.id)).every((c) => c.status === "expired") && !db.dispatched.includes(ELI));
  check("expiry: a door text's drop is noted on its task, never silent", /The text queued for them never went/.test(src("harness/proactiveRegistry.ts")));
  check("valid-until: requested results end at a 14-day backstop at most; an intro ask through tomorrow; a find to the end of its day; a check-in two days", DR.doorValidUntil("requested", at, ZONE).getTime() === at.getTime() + DR.REQUESTED_BACKSTOP_DAYS * 86_400_000 && DR.REQUESTED_BACKSTOP_DAYS === 14 && DR.doorValidUntil("intro", at, ZONE)!.getTime() === pt("2026-11-04T23:59:59.999").getTime() && DR.doorValidUntil("unsolicited", at, ZONE)!.getTime() === pt("2026-11-03T23:59:59.999").getTime() && DR.doorValidUntil("checkin", at, ZONE)!.getTime() === at.getTime() + 48 * HOUR);
  check("valid-until: requested work ends when the thing is moot (an event's own start)", DR.doorValidUntil("requested", at, ZONE, pt("2026-11-03T18:00:00"))!.getTime() === pt("2026-11-03T18:00:00").getTime());
  const unsol = (written: Date) => ({ ...doorText("unsolicited", { arrives: written }, { writtenAt: written.toISOString() }), createdAt: written });
  const req = (written: Date) => ({ ...doorText("requested", { arrives: written }, { writtenAt: written.toISOString() }), createdAt: written });
  check("re-read: a door text Cue started is read again a day after it was written (24h from writtenAt, not a zone's midnight)", PR.needsRelevanceCheck(unsol(pt("2026-11-02T08:00:00")), pt("2026-11-03T09:00:00")) && !PR.needsRelevanceCheck(unsol(pt("2026-11-02T23:00:00")), pt("2026-11-03T09:00:00")));
  check("re-read: requested work is never re-read (a re-read could drop it), however long it waited", !PR.needsRelevanceCheck(req(pt("2026-11-01T08:00:00")), pt("2026-11-04T09:00:00")));
  // Requested work held by a "none this week" rule: still there days later, and it goes the morning the rule allows.
  {
    const noneUntil = pt("2026-11-05T00:00:00");
    const weekRule = (now: Date): Preference[] => [{ id: "w", area: "contact", channel: "all", covers: "all", rule: { none: true }, basis: "explicit", type: "standing", words: ["nothing this week"], source: { via: "text", ref: null }, startsAt: null, expiresAt: noneUntil.toISOString(), zone: ZONE, state: "active", setAt: pt("2026-11-01T08:00:00").toISOString() } as any].filter((p) => now.getTime() < Date.parse(p.expiresAt));
    const t0 = pt("2026-11-02T10:00:00");
    const s3 = simulate({ candidates: [doorText("requested", { id: "r-1", arrives: t0, expiresAt: DR.doorValidUntil("requested", t0, ZONE) })], from: pt("2026-11-02T09:55:00"), to: pt("2026-11-05T12:00:00"), lastInboundAt: pt("2026-11-02T07:00:00"), joinedAt: pt("2026-10-01T10:00:00"), prefs: weekRule });
    check("requested held by their rule for days: never expires, arrives the morning the rule lifts", s3.expired.length === 0 && s3.sends.length === 1 && s3.sends[0].lead.id === "r-1" && s3.sends[0].at.getTime() >= noneUntil.getTime() && s3.sends[0].at.getTime() < pt("2026-11-05T09:00:00").getTime());
  }
  // Held by the member's rule: it stays a candidate and comes back through the pick (never a burst): the next day, one send.
  const held = [doorText("requested", { id: "h-1", arrives: pt("2026-11-02T10:00:00"), expiresAt: DR.doorValidUntil("requested", pt("2026-11-02T10:00:00"), ZONE) }), cand("event_offer", { id: "h-2", arrives: pt("2026-11-02T10:00:00"), expiresAt: pt("2026-11-09T10:00:00"), payload: { askId: "profile", fromProfile: true, picked: true, match: { tier: 2 } } }), cand("companion", { id: "h-3", arrives: pt("2026-11-02T10:00:00"), expiresAt: pt("2026-11-06T10:00:00") })];
  const already = pt("2026-11-02T08:30:00");
  const rule = (now: Date): Preference[] => [{ id: "r", area: "contact", channel: "all", covers: "all", rule: { maxPerDay: 1 }, basis: "explicit", type: "standing", words: ["once a day"], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: ZONE, state: "active", setAt: pt("2026-11-01T08:00:00").toISOString() } as any].filter(() => now.getTime() > 0);
  const s2 = simulate({ candidates: [cand("companion", { id: "h-0", arrives: pt("2026-11-02T08:00:00") }), ...held], from: pt("2026-11-02T08:00:00"), to: pt("2026-11-03T21:00:00"), lastInboundAt: pt("2026-11-02T07:00:00"), joinedAt: pt("2026-10-01T10:00:00"), prefs: rule });
  void already;
  const day3 = s2.sends.filter((x) => hhmm(x.at) && x.at.getTime() >= pt("2026-11-03T00:00:00").getTime());
  console.log(`  held by a once-a-day rule over two days: ${describe(s2)}`);
  check("held work: what their rule held comes back through the pick the next morning as one send, not a burst", day3.length === 1 && s2.sends.filter((x) => x.at.getTime() < pt("2026-11-03T00:00:00").getTime()).length === 1);
  check("held work: released deferred rows the door takes go back through the pick (an intro ask, a task's results, an announcement)", D.doorTakesRow({ type: "direct_ask", after_kind: "network_intro_ask", target_key: "network_direct_ask:a:b" }) && D.doorTakesRow({ type: "task_update", after_kind: null, target_key: "task:1:2" }) && D.doorTakesRow({ type: "co_event", after_kind: null, target_key: "co_event:x" }));
  check("held work: what's tied to a time still goes when due (a reminder they set, a call reminder, a window warning, a relay)", !D.doorTakesRow({ type: "direct_ask", after_kind: "reminder", target_key: "reminder:1" }) && !D.doorTakesRow({ type: "call_reminder", after_kind: null, target_key: "call_reminder:1" }) && !D.doorTakesRow({ type: "task_window", after_kind: null, target_key: "w" }) && !D.doorTakesRow({ type: "direct_ask", after_kind: "relay", target_key: "relay:1" }));
}

// ================================================================ 5. a requested brief still arrives, through the door
{
  reset();
  const now = new Date();
  // The research brief's line, the morning after they asked: not an answer to their latest message, so it enters the door as requested.
  db.inbound.set(ELI, new Date(now.getTime() - 20 * HOUR));
  const r = await PR.sendExempt({ userId: ELI, phoneNumber: PHONE, type: "task_update", targetKey: "research_brief:77", messages: ["The venue brief: three rooms that fit 40 on the 14th."], timezone: ZONE, respectHours: true, answers: { askedAt: new Date(now.getTime() - 21 * HOUR) }, door: { summary: "The research brief they asked for", validUntil: DR.doorValidUntil("requested", now, ZONE) } });
  const row = db.candidates.find((c) => c.target_key === "research_brief:77");
  check("brief: a requested brief waits at the door (queued, not sent this minute)", r.sent === false && r.door === true && r.queued === true && db.outbox.length === 0);
  check("brief: as a candidate under its own type and key, requested, with its words as written", !!row && row.type === "task_update" && row.payload.door === true && row.payload.cls === "requested" && row.payload.messages[0].startsWith("The venue brief"));
  check("brief: a queued line is not told: the task stays open until the pick sends it", RB.briefLineOutcome({ sent: false, door: true, queued: true }, 0) === "queued" && /if \(next === "queued"\) \{[\s\S]{0,400}holdBriefLine\([\s\S]{0,400}return;/.test(src("services/researchBrief.ts")));
  check("brief: the line carries its task and how to close it when it goes", /taskId: task\.id,\s*close: \{ status, outcome \}/.test(src("services/researchBrief.ts")));
  const asCand: Candidate = { id: "b", userId: ELI, type: "task_update", targetKey: row.target_key, topicKey: row.target_key, summary: row.summary, priority: row.priority, dueAt: new Date(row.due_at), expiresAt: row.expires_at ? new Date(row.expires_at) : null, payload: row.payload, attempts: 0, createdAt: new Date(row.due_at) };
  const draft = await proactiveRegistry.task_update.draft(asCand, { userId: ELI, firstName: "Eli", phoneNumber: PHONE, city: "San Francisco", timezone: ZONE });
  check("brief: the pick sends it exactly as written (no second draft, no model)", "messages" in draft && draft.messages.join("|") === row.payload.messages.join("|"));
  // It arrives: in a day with a find and a check-in also waiting, the brief is what goes, and it's requested, uncapped by the lanes.
  const t0 = pt("2026-11-03T09:00:00");
  const s = simulate({ candidates: [{ ...asCand, arrives: t0, createdAt: t0, dueAt: t0, expiresAt: DR.doorValidUntil("requested", t0, ZONE) }, cand("event_offer", { id: "f", arrives: t0, expiresAt: pt("2026-11-10T09:00:00"), payload: { askId: "profile", fromProfile: true, picked: true, match: { tier: 2 } } }), cand("companion", { id: "k", arrives: t0 })], from: pt("2026-11-03T08:50:00"), to: pt("2026-11-03T10:00:00"), lastInboundAt: pt("2026-11-02T12:00:00"), joinedAt: pt("2026-10-01T10:00:00") });
  check("brief: it arrives, first, through the pick", s.sends.length === 1 && s.sends[0].lead.id === "b");
  check("brief: a requested door text skips the lanes' quota like any answer (never starved by caps), and keeps the spacing", PR.isAnswering(asCand) && PR.sendIsExempt(asCand, []));
  check("brief: the event brief (the day before a Co event) is a requested candidate in the pick", G.candidateClass("event_brief", false) === "requested" && PR.bandOfCandidate(cand("event_brief", { expiresAt: pt("2026-11-10T18:00:00") }), pt("2026-11-09T10:00:00")) === DR.BAND.requested);
  check("brief: the research brief's lines pass a door spec", /type: "task_update", targetKey: `research_brief:\$\{task\.id\}`[\s\S]{0,400}\.\.\.\(door \? \{ door \} : \{\}\) \}\)/.test(src("services/researchBrief.ts")));
}

// ================================================================ 6. a notice within a few hours still goes immediately; a reply is never delayed
{
  reset();
  const now = new Date();
  const soon = await PR.sendExempt({ userId: ELI, phoneNumber: PHONE, type: "event_change", targetKey: "stale:x:moved", messages: ["Heads up: the meetup moved to 7."], timezone: ZONE, soonAt: new Date(now.getTime() + 2 * HOUR), door: { summary: "a heads-up", validUntil: DR.doorValidUntil("requested", now, ZONE) } });
  check("notice: about something within hours, it bypasses the door and goes now", soon.sent === true && !soon.door && db.outbox.some((m) => m.content.includes("moved to 7")) && !db.candidates.length);
  check("notice: and still passes the member's own rule first (sendExempt's gate, inside the lock)", /const rule = await memberRuleGate\(client, \{ userId: opts\.userId, now, cls, channel: "text", soonAt: opts\.soonAt \?\? null(?:, throughTeamHold: isRelayKey\(opts\.targetKey\))? \}\);/.test(src("harness/proactive.ts")));
  check("route: R2 notices, safety, a reply, a delivery answering their latest message and a time-sensitive one bypass", [
    DR.doorRoute({ cls: "requested", now, soonAt: new Date(now.getTime() + HOUR) }),
    DR.doorRoute({ cls: "checkin", now, safety: true }),
    DR.doorRoute({ cls: "reply", now }),
    DR.doorRoute({ cls: "requested", now, answersLast: true }),
    DR.doorRoute({ cls: "requested", now, timeSensitive: true }),
  ].every((r) => r.door === false));
  check("route: everything else waits at the door (a result from yesterday's ask, Cue's own find, a check-in)", [DR.doorRoute({ cls: "requested", now }), DR.doorRoute({ cls: "unsolicited", now }), DR.doorRoute({ cls: "checkin", now }), DR.doorRoute({ cls: "requested", now, soonAt: new Date(now.getTime() + 3 * 86_400_000) })].every((r) => r.door === true));
  // A delivery answering their latest message (they asked minutes ago) is their conversation: it never waits at the door.
  reset();
  db.inbound.set(ELI, new Date(now.getTime() - 5 * MIN));
  const answer = await PR.sendExempt({ userId: ELI, phoneNumber: PHONE, type: "task_update", targetKey: "task:9:1", messages: ["Found two rooms."], timezone: ZONE, answers: { askedAt: new Date(now.getTime() - 4 * MIN) }, door: { summary: "results", validUntil: DR.doorValidUntil("requested", now, ZONE) } });
  check("reply: a result answering their latest message is never delayed (no door, no gathering)", answer.sent === true && !answer.door && !db.candidates.length);
  check("reply: the member's rules never hold or count a reply", G.memberRuleCheck([ONCE_A_DAY(pt("2026-11-02T10:00:00"))[0]], { now: pt("2026-11-02T10:00:00"), cls: "reply", channel: "text", sent: [{ at: pt("2026-11-02T08:20:00"), cls: "requested", channel: "text" }] }).pass === true);
  check("reply: the reply path never touches the door or the pick", !/enterDoor|enqueueCandidate|doorPlan/.test(src("routes/sendblue.ts").split("\n").filter((l) => /sendReply|replyTo|reply_to/.test(l)).join("\n")) && !/door/.test(src("harness/notifyGate.ts").split("export function memberRuleCheck")[1].split("\n").slice(0, 3).join("\n")));
  check("reply: a slip text (a time about to be missed) goes now, not at the door", /const door = o\?\.key \? undefined : \{/.test(src("services/taskTurn.ts")));
}

// ================================================================ 7. calls Cue starts count toward the same budget (GPT-Live)
{
  reset();
  const now = pt("2026-11-03T15:00:00");
  const textAt = pt("2026-11-03T13:30:00");
  const callState = (pickerBudget: any): any => ({ callStatus: null, callStatusUpdatedAt: null, optedOut: false, subscriptionActive: true, requireSubscription: false, localHourOk: true, lastCallAt: null, evidence: { scheduledCallDue: true, recentInboundText: true, routerPlaceCallDecision: true, cadenceSet: true, autoIntakeEligible: true }, memberRule: null, pickerBudget });
  const afterText = PR.callBudgetCheck({ now, sends: [{ type: "event_offer", targetKey: "event_offer:1", topicKey: null, sentAt: textAt, exempt: false }] });
  check("calls: a check-in call Cue starts waits the spacing after a text Cue sent first", !CG.decideCall(callState(afterText), { kind: "checkin_cadence" }, now).allowed && CG.decideCall(callState(afterText), { kind: "checkin_cadence" }, now).checks.some((c) => c.name === "picker_spacing" && !c.pass));
  check("calls: so does an intake call", !CG.decideCall(callState(afterText), { kind: "auto_intake" }, now).allowed);
  check("calls: a call they booked or asked for now is theirs (not held by the pick's spacing)", CG.decideCall(callState(afterText), { kind: "scheduled_call" }, now).allowed && CG.decideCall(callState(afterText), { kind: "user_initiated" }, now).allowed);
  check("calls: past the spacing, the call goes", CG.decideCall(callState(PR.callBudgetCheck({ now: new Date(textAt.getTime() + 3 * HOUR + MIN), sends: [{ type: "event_offer", targetKey: "event_offer:1", topicKey: null, sentAt: textAt, exempt: false }] })), { kind: "checkin_cadence" }, now).allowed);
  check("calls: the gate reads the pick's own ledger for it (one budget)", /pickerBudget: kind && CUE_STARTED_CALLS\.has\(kind\) \? await import\("\.\/proactive\.js"\)\.then\(async \(P\) => P\.callBudgetCheck\(\{ now, sends: await P\.pickerSends\(userId\) \}\)\)/.test(src("harness/callGate.ts")));
  // The other way: a call Cue placed is in the ledger the pick reads, and a text Cue starts waits after it.
  db.calls.push({ id: 5, user_id: ELI, reason: "checkin_cadence", created_at: pt("2026-11-03T14:00:00") }, { id: 6, user_id: ELI, reason: "user_initiated", created_at: pt("2026-11-03T14:30:00") }, { id: 7, user_id: ELI, reason: "auto_intake", created_at: pt("2026-11-03T14:10:00"), dialed: false });
  const calls = await PR.cueCallsForTests(pool as any, ELI);
  check("calls: a call Cue started and dialed is read into the ledger (one they asked for isn't, a refused dial isn't)", calls.length === 1 && calls[0].type === PR.CUE_CALL_TYPE && calls[0].exempt === true && calls[0].targetKey === "call:5");
  check("calls: only dials that went count (the gate's place_call joined to the dial's own record)", /AND EXISTS \(SELECT 1 FROM co_memories m WHERE m\.user_id = d\.user_id AND m\.memory_type = 'call_transcript' AND m\.content LIKE 'Co initiated call%'/.test(src("harness/proactive.ts")) && /INSERT INTO co_memories \(user_id, memory_type, content\) VALUES \(\$1, 'call_transcript', \$2\)/.test(src("services/callTrigger.ts")));
  const ev = PR.evaluateCandidates({ now, timezone: ZONE, optedOut: false, candidates: [cand("companion", { id: "c" }), cand("event_offer", { id: "f", payload: { askId: "profile", fromProfile: true } }), cand("post_call", { id: "p" })], sends: calls, lastInboundAt: pt("2026-11-03T14:40:00"), joinedAt: pt("2026-10-01T10:00:00") } as any);
  const held = (id: string) => ev.perCandidate.find((p) => p.candidate.id === id)!.checks.some((c) => c.name === "call_spacing" && !c.pass);
  check("calls: a check-in or a find Cue starts waits the spacing after a call Cue placed", held("c") && held("f"));
  check("calls: the text after the call (it answers them) never waits on it", !held("p"));
  check("calls: a call never counts against a lane's caps or the unanswered pause (exempt), and only spaces", PR.userLevelChecks({ now, timezone: ZONE, optedOut: false, sends: calls, lastInboundAt: null } as any, { lane: "other" }).every((c) => c.name === "call_spacing" || c.pass));
  check("calls: GPT-Live is the only call path, and every dial goes through this gate", /Every call runs on GPT-Live/.test(src("services/callTrigger.ts")) && /const gateResult = decideCall\(callState, auth, new Date\(\)\);/.test(src("services/callTrigger.ts")));
}

// ================================================================ 8. every converted path, and the gates kept
{
  check("paths: task results pass a door spec (Cue's own look-out finds as finds, asked-for work as requested)", /door: \{ summary: `\$\{coInitiated \? "A find Cue's own look-out turned up" : "Results of work they asked for"\}/.test(src("services/taskTurn.ts").replace(/const door = o\?\.key \? undefined : /, "door: ")));
  check("paths: a goal's check-in passes a door spec (a reminder they set doesn't)", /const door = reminder \? undefined : \{ summary: `A check-in on their goal/.test(src("services/goalOwnership.ts")));
  check("paths: Cue's own event announcement passes one, its record written when the pick sends it", /queueIfHeld: true,\n      door,/.test(src("services/coEventAnnouncement.ts")) && /co_event_announce: async/.test(src("services/deferredSends.ts")));
  check("paths: a heads-up about something they were interested in passes one", /door: \{ summary: `A heads-up: something they were interested in changed/.test(src("services/staleWatch.ts")));
  check("paths: an intro ask to the other side passes one, ranked as an intro, the pair read again before it goes", /door: \{ summary: "An intro ask: someone Cue knows would like to meet them"[\s\S]{0,200}intro: true \}/.test(src("services/networkIntroNudge.ts")) && /networkAskStale\(String\(p\.candidateId/.test(src("harness/proactiveRegistry.ts")));
  check("paths: what the door takes is ledgered under its own type and key (every reader of the ledger unchanged)", DR.DOOR_TYPES.every((t) => t in proactiveRegistry && t in PR.TYPE_POLICY));
  check("gates: opt-out, hours, the member's rule, safety and the caps run on a door text exactly as on any pick (sendWithLedger)", /const cls = candidateClass\(c\.type, answering, c\.payload\);/.test(src("harness/proactive.ts")) && /\.\.\.candidateChecks\(c, \{ now, sends, lastInboundAt, joinedAt,/.test(src("harness/proactive.ts")));
  check("gates: a Cue look-out's find at the door keeps its restraint kind (the backoff still holds it)", (await import("../../src/services/kindRestraint.js")).kindOf("task_update", { door: true, restraintKind: "find" }) === "find" && (await import("../../src/services/kindRestraint.js")).kindOf("task_update", {}) === null);
  check("gates: a door text Cue started (not asked for) is counted against the lane's caps", !PR.isAnswering(doorText("unsolicited")) && !PR.sendIsExempt(doorText("unsolicited"), []));
  check("gates: a door text goes as written (no tidying, no second check, no hand-off to a task)", /const asWritten = isDoorType\(c\.type\);/.test(src("harness/proactive.ts")) && DR.DOOR_TYPES.every((t) => (PF.PAYLOAD_FIRST_EXEMPT as Set<string>).has(t)));
  check("gates: a door text's class rides with it (a goal check-in is a check-in for 'no check-ins')", G.candidateClass("task_update", false, { door: true, cls: "checkin" }) === "checkin" && G.candidateClass("task_update", false, {}) === "requested");
  check("gates: a task's waiting text counts as its own (never written a second time)", /status = 'pending' AND starts_with\(target_key, \$2\)/.test(src("services/followThrough.ts")));
}

// ================================================================ 9. review of #361: never silent, texted only when sent, pauses wait
{
  reset();
  const person = { userId: ELI, firstName: "Eli", phoneNumber: PHONE, city: "San Francisco", timezone: ZONE };
  const taskRow = (status: string) => ({ id: 9, user_id: ELI, goal: "venue brief", their_words: "find me a room", steps: [], plan_next: null, next_check_at: null, status, wakes: 1, notes: [], texts_sent: 0, last_texted_at: null, created_at: new Date(), kind: "research_brief", followup: {}, source: "ask" });
  const doorCand = (payload: any): Candidate => ({ id: "d", userId: ELI, type: "task_update", targetKey: "research_brief:9", topicKey: "research_brief:9", summary: "s", priority: 50, dueAt: new Date(), expiresAt: null, payload: { door: true, messages: ["The brief came to three rooms."], cls: "requested", writtenAt: new Date().toISOString(), ...payload }, attempts: 0, createdAt: new Date() });
  // A dropped door text on a task that is already closed (a goal check-in closes its task when it hands the text over).
  db.tasks.push(taskRow("done"));
  await proactiveRegistry.task_update.onDropped!(doorCand({ taskId: 9 }), "expired", "its event passed");
  const noted = db.sql.find((q) => /^UPDATE co_tasks SET steps = \$3::jsonb, notes = \$4::jsonb/.test(q.sql));
  check("dropped: the note lands on the task even after it closed, so nothing later says it went", !!noted && JSON.parse(noted.a[3]).some((n: any) => /The text queued for them never went, so they were never told \(expired: its event passed\)/.test(n.text)));
  check("dropped: nothing was marked texted", !db.sql.some((q) => /texts_sent = texts_sent \+ 1/.test(q.sql)));
  // A brief's line kept its task open: dropped, the task closes as not told; sent, it closes with its own outcome and is marked texted.
  reset();
  db.tasks.push(taskRow("open"));
  await proactiveRegistry.task_update.onDropped!(doorCand({ taskId: 9, close: { status: "done", outcome: "no brief: nothing fit" } }), "expired");
  const closedAs = db.sql.find((q) => /^UPDATE co_tasks SET status = \$3, outcome = \$4/.test(q.sql));
  check("dropped: a brief kept open for its line closes as dropped, saying it never told them", !!closedAs && closedAs.a[2] === "dropped" && /never told them/.test(closedAs.a[3]));
  reset();
  db.tasks.push(taskRow("open"));
  await proactiveRegistry.task_update.onSent!(doorCand({ taskId: 9, close: { status: "done", outcome: "no brief: nothing fit" }, awaitingReply: false }), person, ["The brief came to three rooms."]);
  const marked = db.sql.find((q) => /^UPDATE co_tasks SET texts_sent = texts_sent \+ 1, last_texted_at = NOW\(\), awaiting_reply = \$3/.test(q.sql));
  const closedDone = db.sql.find((q) => /^UPDATE co_tasks SET status = \$3, outcome = \$4/.test(q.sql));
  check("sent: the task is marked texted only now (when the pick sent it), with whether it asked them something", !!marked && marked.a[2] === false);
  check("sent: the brief's task closes with its own outcome once its line went", !!closedDone && closedDone.a[2] === "done" && closedDone.a[3] === "no brief: nothing fit");
  check("queue time never marks texted (task results and goal check-ins)", /if \(sent\.sent\) await deps\.markTexted\(\);/.test(src("services/taskTurn.ts")) && !/\n\s+await deps\.markTexted\(\);/.test(src("services/taskTurn.ts")) && /if \(!queued\) await pool\.query\(`UPDATE co_tasks SET texts_sent = texts_sent \+ 1/.test(src("services/goalOwnership.ts")));
  // The matching pause holds an intro ask at the door (moved out, never dropped): the asker is never told it failed.
  reset();
  db.paused = true;
  const ask: Candidate = { id: "i", userId: ELI, type: "direct_ask", targetKey: "network_direct_ask:a:b", topicKey: "network_direct_ask:a:b", summary: "s", priority: 50, dueAt: new Date(), expiresAt: DR.doorValidUntil("intro", new Date(), ZONE), payload: { door: true, intro: true, messages: ["Someone I know would like to meet you."], cls: "unsolicited", after: { kind: "network_intro_ask", payload: { candidateId: "a", askerId: "b" } }, writtenAt: new Date().toISOString() }, attempts: 0, createdAt: new Date() };
  const paused = await proactiveRegistry.direct_ask.draft(ask, person);
  check("pause: an intro ask while matching is paused waits (a defer, never a skip)", "defer" in paused && paused.defer.getTime() > Date.now());
  check("pause: the deferral moves the door text's valid-until with it (never shortened, never lapsed by a pause)", /WHEN type IN \('task_update', 'co_event', 'event_change', 'direct_ask'\) THEN \$4::timestamptz/.test(src("harness/proactive.ts")));
  // The safety and soon bypasses fire.
  reset();
  const safe = await PR.sendExempt({ userId: ELI, phoneNumber: PHONE, type: "task_update", targetKey: "task:safe:1", messages: ["Checking you're okay."], timezone: ZONE, door: { summary: "s", validUntil: null, safety: true } });
  check("bypass: a safety message never waits at the door", safe.sent === true && !safe.door && !db.candidates.length);
  const SW = await import("../../src/services/staleWatch.js");
  const row = { user_id: ELI, item_key: "luma:x", item_name: "Personal AI Agents Meetup", url: "https://lu.ma/x", phone_number: PHONE, first_name: "Eli", city: null };
  reset();
  await SW.tell(row, { kind: "moved", detail: "it now starts at 7pm", startAt: new Date(Date.now() + 2 * HOUR).toISOString() });
  check("bypass: a heads-up about something within hours (tonight) goes now, never at the door", !db.candidates.length && (db.outbox.length === 1 || db.sql.some((q) => /^INSERT INTO deferred_sends/.test(q.sql))));
  reset();
  const later = new Date(Date.now() + 3 * 86_400_000);
  await SW.tell(row, { kind: "sold_out", detail: "it's sold out now", startAt: later.toISOString() });
  const hc = db.candidates.find((c) => c.target_key === "stale:luma:x:sold_out");
  check("door: a heads-up about something days out waits at the door, good until it starts (moot after)", !!hc && new Date(hc.expires_at).getTime() === later.getTime() && db.outbox.length === 0);
  check("staleWatch: the voice line is the test's fake (no model call), and the stock line goes when it writes nothing", lineAsks.length === 2 && db.candidates.some((c) => /Heads up on Personal AI Agents Meetup/.test(JSON.stringify(c))));
  check("staleWatch reads the thing's start from its page (verified only)", SW.staleChange({ status: "ok", fields: { start: { value: "2026-11-04T16:00:00-08:00", verified: true } } } as any, { status: "ok", fields: { start: { value: "2026-11-04T19:00:00-08:00", verified: true } } } as any)?.startAt === "2026-11-04T19:00:00-08:00");
  // An announcement the door already decided is given up, never redrafted.
  check("announcement: one the door didn't take is given up cleanly, and any door row for it keeps it from being drafted again", /if \(!\(result as \{ queued\?: boolean \}\)\.queued\) await pool\.query\(`UPDATE co_event_announcements SET gave_up_at = NOW\(\)/.test(src("services/coEventAnnouncement.ts")) && /AND NOT EXISTS \(SELECT 1 FROM proactive_candidates pc WHERE pc\.user_id = a\.user_id AND pc\.target_key = 'co_event:' \|\| a\.event_api_id\)\)?/.test(src("services/coEventAnnouncement.ts")));
}

// ================================================================ 10. round 2: requested work never goes out late; a pause never expires an ask
{
  const now = pt("2026-11-03T10:00:00");
  check("dated: the earliest dated thing in a text caps it (the end of that day), past days ignored", DR.earliestDated(["date: 2026-11-07", "a date its page mentions: 2026-11-05", "deadline: 2026-11-01", "no date here"], now, ZONE)!.getTime() === pt("2026-11-05T23:59:59.999").getTime() && DR.earliestDated(["nothing dated"], now, ZONE) === null);
  check("dated: a requested result is capped at its earliest dated thing", DR.doorValidUntil("requested", now, ZONE, DR.earliestDated(["date: 2026-11-05"], now, ZONE)).getTime() === pt("2026-11-05T23:59:59.999").getTime());
  check("dated: task results pass their items' dates as the cap", /const endsAt = earliestDated\(good\.flatMap\(\(g\) => items\.find\(\(i\) => i\.url === g\.url\)\?\.facts \?\? \[\]\), deps\.now\(\), deps\.zone\);\n\s+const sent = await deps\.send\(messages, \{ owed: owed \|\| task\.source !== "lookout", endsAt \}\);/.test(src("services/taskTurn.ts")) && /doorValidUntil\(coInitiated \? "unsolicited" : "requested", clock\(\), zone, o\?\.endsAt \?\? null\)/.test(src("services/taskTurn.ts")));
  const t0 = pt("2026-11-02T10:00:00");
  const longNone = (n: Date): Preference[] => [{ id: "n", area: "contact", channel: "all", covers: "all", rule: { none: true }, basis: "explicit", type: "standing", words: ["nothing for a while"], source: { via: "text", ref: null }, startsAt: null, expiresAt: pt("2026-11-23T00:00:00").toISOString(), zone: ZONE, state: "active", setAt: pt("2026-11-01T08:00:00").toISOString() } as any].filter((p) => n.getTime() < Date.parse(p.expiresAt));
  const dated = doorText("requested", { id: "dated", arrives: t0, expiresAt: DR.doorValidUntil("requested", t0, ZONE, DR.earliestDated(["date: 2026-11-06"], t0, ZONE)) });
  const undated = doorText("requested", { id: "undated", arrives: t0, expiresAt: DR.doorValidUntil("requested", t0, ZONE) });
  const s4 = simulate({ candidates: [dated, undated], from: pt("2026-11-02T09:55:00"), to: pt("2026-11-24T12:00:00"), lastInboundAt: pt("2026-11-02T07:00:00"), joinedAt: pt("2026-10-01T10:00:00"), prefs: longNone });
  check("late: held three weeks, neither result goes out late: the dated one ends at its date, the undated at the 14-day backstop", s4.sends.length === 0 && s4.expired.includes("dated") && s4.expired.includes("undated"));
  check("late: the backstop is a real expiry (the dispatch sweep drops and logs it, and the task is noted as never told)", !!undated.expiresAt && undated.expiresAt.getTime() === t0.getTime() + 14 * 86_400_000 && /never went, so they were never told/.test(src("harness/proactiveRegistry.ts")));
  check("brief: a line that ended at the door is never told, and the brief stops looking", RB.briefLineOutcome({ sent: false, door: true, queued: false, reason: PR.DOOR_ENDED }, 1) === "untold" && RB.briefLineOutcome({ sent: false, door: true, queued: false, reason: "already sent" }, 1) === "told");
  reset();
  db.candidates.push({ id: 70, user_id: ELI, type: "task_update", target_key: "research_brief:70", topic_key: "research_brief:70", summary: "s", payload: { door: true, messages: ["x"], cls: "requested" }, due_at: new Date(0), expires_at: new Date(0), priority: 50, status: "expired" });
  const again = await PR.sendExempt({ userId: ELI, phoneNumber: PHONE, type: "task_update", targetKey: "research_brief:70", messages: ["x"], timezone: ZONE, door: { summary: "s", validUntil: DR.doorValidUntil("requested", new Date(), ZONE) } });
  check("brief: handing over a line that already ended says so (not 'already sent')", again.door === true && again.queued === false && again.reason === PR.DOOR_ENDED && db.outbox.length === 0);
  check("brief: the task kept open for its line closes when the line ends (next_check_at cleared), so the 12h look stops", /closeTask\(c\.userId, Number\(p\.taskId\), "dropped"/.test(src("harness/proactiveRegistry.ts")) && /next_check_at = NULL/.test(src("services/coTasks.ts")));
  let at = pt("2026-11-03T10:00:00");
  let exp: Date | null = DR.doorValidUntil("intro", at, ZONE);
  let lapsed = false;
  for (let i = 0; i < 3 * 48; i++) {
    const deferTo = new Date(at.getTime() + 30 * MIN);
    exp = DR.deferredDoorExpiry(exp, deferTo);
    at = deferTo;
    if (!exp || exp.getTime() <= at.getTime()) lapsed = true;
  }
  check("pause: through a three-day matching pause, the deferred intro ask never expires (its valid-until stays ahead of each defer)", !lapsed && !!exp && exp.getTime() > pt("2026-11-06T10:00:00").getTime());
  check("pause: the dispatch's defer writes that valid-until for a door text", /THEN \$4::timestamptz WHEN type IN \('event_offer', 'pre_arrival'\)/.test(src("harness/proactive.ts")) && /deferredDoorExpiry\(c\.expiresAt, draft\.defer\)/.test(src("harness/proactive.ts")));
}

console.log(`\none door: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
