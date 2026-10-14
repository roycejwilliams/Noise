// Cold start (Royce, 2026-10-08). A brand-new member has no goals and no asks on file, so every sweep finds nothing and their first
// week feels dead. The first conversations seed the discovery engine:
//
//   1. Seeds. A "findable interest" is something the daily sweeps can go and find: a scene they want to be in, a kind of event,
//      people they want to meet, a community, a program. Counted from what's on file (countSeeds, pure):
//        - each active goal (co_profiles.goals, active goal entries in co_profiles.intent, their long-term direction) that isn't
//          Co's own task (goalEdges.ts isCoTaskGoal), isn't done or stale (goal_states), and that the last goal sweep didn't pass
//          as having no findable side (the latest goal_sweep.plan's `passed`). A goal no sweep has read yet counts until one does;
//        - each open find ask (ask_checkins kind 'find', not Co's own promise), once even when it restates a goal;
//        - what they enjoy (activity_preferences) counts as ONE seed however many there are: tastes give the sweep something to go
//          on but aren't a direction, so a member with only tastes still gets one more question.
//      Seeded = at least SEED_TARGET (2) seeds. Once seeded Co stops steering and the profile grows on its own.
//   2. Steering. While unseeded, a reply may ask ONE easy question that lets them name something findable (replyGrounding.ts
//      addColdStartSteer). Co decides whether and how; code only decides when the question is on offer (steerDecision, pure):
//      never in a heavy moment or while they're frustrated with Co, never two replies in a row (the last steered reply is
//      recorded), at most STEER_PER_WEEK a week, and never when the reply already has another question to ask (a call offer, a
//      set-aside goal, a document offer). The instruction names the questions already asked so none is asked again, and tells Co
//      to save what they name with saveAsk, which is the same path every ask takes (profileExtraction.ts persistCapturedIntent).
//      Every reply to an unseeded member is recorded (coldstart.reply: steered / offered_not_taken / rested + why).
//   3. Sweeps from day one. A new member (joined in the last NEW_MEMBER_DAYS) gets a goal sweep as soon as their seeds change
//      (goalSweep.ts), not 20 hours later; a find ask is searched by the next hourly ask sweep. A sweep that comes back empty for a
//      new member is a FLAGGED MISS (sweep.cold_start_miss, with their seeds, the queries tried and why), never a silent pass; the
//      monitor (harness/monitor.ts cold_start_miss) puts it in front of the team. Nothing is ever sent to the member for a miss.
//   4. Backfill. Existing members with fewer than two seeds get the same steering in their next natural exchange, never a blast.
//
// Every read is scoped to one member (user_id = $1).
import { createHash } from "crypto";
import pool from "../db/db.js";
import { isCoCommitment } from "./askKind.js";
import { goalHash, isCoTaskGoal, restates, type GoalStateRow } from "./goalEdges.js";

export const COLD_START = {
  // Seeds to stop steering at (the target is 2 to 3; the third comes on its own).
  seedTarget: 2,
  // A member is new for this many days after joining (users.created_at): their empty sweeps are flagged misses.
  newMemberDays: 7,
  // Steering questions on offer at most this many times a rolling week.
  steerPerWeek: 3,
  // And at most this many ever (Royce, 2026-10-08): "If 5 natural tries never produce a findable interest, stop asking and record
  // that. Some people just won't seed, and polling them forever kills the club feeling."
  steerLifetime: 5,
  // How far back steering history is read.
  historyDays: 14,
} as const;

export type Seed = { text: string; from: "goal" | "direction" | "ask" | "enjoys" };
export type SeedCount = { n: number; seeded: boolean; seeds: Seed[]; notFindable: string[] };
export type SeedInput = {
  goals: string[];
  direction?: string | null;
  findAsks: string[];
  enjoys?: string[] | null;
  // goal_states by goal hash: done and stale goals don't count.
  states?: Map<string, Pick<GoalStateRow, "state">>;
  // The latest goal sweep's reading: goals it passed as having no findable side.
  passedByLastPlan?: string[];
};

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

// Pure: the findable interests on file.
export function countSeeds(i: SeedInput): SeedCount {
  const seeds: Seed[] = [];
  const notFindable: string[] = [];
  const passed = new Set((i.passedByLastPlan ?? []).map((g) => clean(g).toLowerCase()));
  const goalList: { text: string; from: "goal" | "direction" }[] = [
    ...i.goals.map((g) => ({ text: clean(g), from: "goal" as const })),
    ...(clean(i.direction) ? [{ text: clean(i.direction), from: "direction" as const }] : []),
  ];
  const seen = new Set<string>();
  for (const g of goalList) {
    if (!g.text || seen.has(g.text.toLowerCase())) continue;
    seen.add(g.text.toLowerCase());
    const st = i.states?.get(goalHash(g.text))?.state;
    if (st === "done" || st === "stale") continue;
    if (isCoTaskGoal(g.text) || passed.has(g.text.toLowerCase())) {
      notFindable.push(g.text);
      continue;
    }
    seeds.push(g);
  }
  for (const a of i.findAsks.map(clean)) {
    if (!a || isCoCommitment(a) || isCoTaskGoal(a)) continue;
    if (seeds.some((s) => s.text.toLowerCase() === a.toLowerCase() || restates(a, s.text) || restates(s.text, a))) continue;
    seeds.push({ text: a, from: "ask" });
  }
  const enjoys = (i.enjoys ?? []).map(clean).filter(Boolean);
  if (enjoys.length) seeds.push({ text: enjoys.slice(0, 4).join(", "), from: "enjoys" });
  return { n: seeds.length, seeded: seeds.length >= COLD_START.seedTarget, seeds, notFindable };
}

export type SteerAction = "steered" | "offered_not_taken" | "rested";
export type SteerRecord = { action: SteerAction; at: Date; question: string | null };
export type SteerDecision = { steer: boolean; why: string };

// Pure: whether this reply may carry a steering question. History is newest first.
export function steerDecision(o: { seeds: SeedCount; heavy: boolean; frustrated?: boolean; history: SteerRecord[]; now: Date; otherQuestion?: string | null; lifetimeSteers?: number }): SteerDecision {
  if (o.seeds.seeded) return { steer: false, why: `seeded (${o.seeds.n} findable interests on file)` };
  if ((o.lifetimeSteers ?? 0) >= COLD_START.steerLifetime) return { steer: false, why: `stopped asking: ${COLD_START.steerLifetime} natural tries never brought a findable interest` };
  if (o.heavy) return { steer: false, why: "a heavy moment" };
  if (o.frustrated) return { steer: false, why: "frustrated with Cue right now" };
  if (o.otherQuestion) return { steer: false, why: `this reply already has a question to ask (${o.otherQuestion})` };
  if (o.history[0]?.action === "steered") return { steer: false, why: "the last reply steered" };
  const weekAgo = o.now.getTime() - 7 * 86_400_000;
  const thisWeek = o.history.filter((h) => h.action === "steered" && h.at.getTime() > weekAgo).length;
  if (thisWeek >= COLD_START.steerPerWeek) return { steer: false, why: `${thisWeek} steering questions this week already` };
  return { steer: true, why: o.seeds.n ? "one findable interest on file" : "no findable interests on file" };
}

// Pure: the instruction the reply gets while it may steer. Written the way Co should text (no dashes, plain sentences), and with no
// quoted bad question (evals/texting: Co copies the phrasing it's shown, even when told not to use it).
export function steerInstruction(seeds: SeedCount, asked: string[]): string {
  const have = seeds.n === 0
    ? "Cue has nothing on file yet that its daily search can look for on their behalf"
    : `Cue has only one thing on file its daily search can look for on their behalf (${seeds.seeds[0].text.slice(0, 120)})`;
  const already = asked.length
    ? ` You already asked them: ${asked.slice(0, 4).map((q) => `"${q.slice(0, 160)}"`).join("; ")}. Never ask any of these again, in any wording; if they answered, work from the answer.`
    : "";
  return `${have}. If it grows naturally out of what they just said, you may ask ONE easy question that lets them name something you could find for them: a scene or kind of room they'd like to be in, a kind of event, people they'd want to meet, or something they're exploring. It follows their topic: build it from the specific thing they just told you, in your own words, never a stock question (no examples are given on purpose: Cue copies the wording it's shown, 2026-10-08); never jump to a new subject. One question at most in this reply, and only when you aren't asking them anything else. Never a list of questions, never a general question about their interests or hobbies like a form would ask, and never mention a profile, a search setup or that you're collecting anything. If their message needs a real answer or is about something else, just answer it and leave this for another time. When they name something you could find (now or earlier in this conversation), save it with saveAsk in their words so the daily search starts from it, and don't ask about it again.${already}`;
}

// Pure: what a sent reply did with the steering it was offered. Any question in a reply that was offered steering counts as a
// steer (the safe direction: it only ever means fewer questions).
export function steerOutcome(sent: string, offered: boolean, questionsIn: (t: string) => string[]): { action: SteerAction; question: string | null; questions: number } {
  const qs = questionsIn(sent);
  if (!offered) return { action: "rested", question: null, questions: qs.length };
  return qs.length ? { action: "steered", question: qs.join(" ").slice(0, 300), questions: qs.length } : { action: "offered_not_taken", question: null, questions: 0 };
}

// Pure: joined in the last NEW_MEMBER_DAYS.
export function isNewMember(joinedAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!joinedAt) return false;
  const t = new Date(joinedAt).getTime();
  return Number.isFinite(t) && now.getTime() - t < COLD_START.newMemberDays * 86_400_000 && now.getTime() >= t;
}

export type ColdStartSweep = {
  userId: string;
  joinedAt: Date | string | null;
  now: Date;
  // "goal" (the goal sweep) or the ask's id; what it searched for.
  sweep: "goal" | "ask";
  searched: string | null;
  found: boolean;
  why: string;
  // What the sweep tried (sweepFind's did: "events: …", "web: …", "x: …"), and what came back but wasn't offerable.
  tried?: string[];
  turnedAway?: string[];
  seeds?: Seed[];
};

// Pure: the decision a new member's sweep records: a miss when it found nothing, a hit when it did. Null for an established member:
// their empty sweep is a normal pass.
export function coldStartRecord(s: ColdStartSweep): { layer: 5; decision: string; userId: string; outcome: "act" | "skip"; action: string; reason: string | null; proposal: Record<string, unknown> } | null {
  if (!isNewMember(s.joinedAt, s.now)) return null;
  const days = Math.floor((s.now.getTime() - new Date(s.joinedAt!).getTime()) / 86_400_000);
  return {
    layer: 5 as const,
    decision: s.found ? "sweep.cold_start_hit" : "sweep.cold_start_miss",
    userId: s.userId,
    outcome: s.found ? "act" : "skip",
    action: s.found ? "found" : "miss",
    reason: s.found ? null : s.why,
    proposal: { sweep: s.sweep, daysSinceJoined: days, searched: (s.searched ?? "").slice(0, 300), seeds: (s.seeds ?? []).map((x) => ({ text: x.text.slice(0, 160), from: x.from })), tried: (s.tried ?? []).slice(0, 12), turnedAway: (s.turnedAway ?? []).slice(0, 8) },
  };
}

// Pure: a fingerprint of what the goal sweep reads (goals, direction, what they enjoy), so a new member's sweep reruns as soon as it
// changes instead of waiting out the 20 hours.
export function seedSignature(o: { goals: string[]; direction?: string | null; enjoys?: string[] | null }): string {
  const parts = [...o.goals.map((g) => `g:${clean(g).toLowerCase()}`), clean(o.direction) ? `d:${clean(o.direction).toLowerCase()}` : "", ...(o.enjoys ?? []).map((e) => `e:${clean(e).toLowerCase()}`)].filter(Boolean).sort();
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

// ---------- reads (one member each)

export type ColdStartView = { seeds: SeedCount; history: SteerRecord[]; joinedAt: Date | null; lifetimeSteers?: number };

const goalTexts = (profile: any): string[] => {
  const intents = Array.isArray(profile?.intent) ? profile.intent : [];
  return [...(profile?.goals ?? []), ...intents.filter((e: any) => e?.kind === "goal" && e?.status === "active" && typeof e?.text === "string").map((e: any) => e.text)];
};

// Pure: the goals a logged goal-sweep plan passed as having no findable side. A plan whose model answer couldn't be read passed
// everything for that reason only, so it says nothing about what's findable.
export function passedInPlan(row: { reason?: string | null; proposal?: any } | null | undefined): string[] {
  if (!row || /couldn't be read/.test(String(row.reason ?? ""))) return [];
  const passed = row.proposal?.passed;
  return Array.isArray(passed) ? passed.filter((p: any) => !/couldn't be read/.test(String(p?.why ?? ""))).map((p: any) => String(p?.goal ?? "")).filter(Boolean) : [];
}

// The latest goal sweep's passed goals (no findable side), from its logged plan.
async function lastPlanPassed(userId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT reason, proposal FROM harness_decisions WHERE user_id = $1 AND decision = 'goal_sweep.plan' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return passedInPlan(rows[0]);
}

export async function loadSeeds(userId: string, o: { profile?: any; findAsks?: string[] } = {}): Promise<SeedCount> {
  const profile = o.profile !== undefined ? o.profile : (await pool.query(`SELECT goals, intent, long_term_direction, activity_preferences FROM co_profiles WHERE user_id = $1`, [userId])).rows[0] ?? null;
  const findAsks = o.findAsks ?? (await pool.query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL AND kind = 'find'`, [userId])).rows.map((r: any) => String(r.ask_text ?? ""));
  const [states, passed] = await Promise.all([
    import("./goalEdges.js").then((g) => g.goalStates(userId)).catch(() => new Map<string, GoalStateRow>()),
    lastPlanPassed(userId).catch(() => [] as string[]),
  ]);
  return countSeeds({ goals: goalTexts(profile), direction: profile?.long_term_direction ?? null, findAsks, enjoys: profile?.activity_preferences ?? [], states, passedByLastPlan: passed });
}

export async function steerHistory(userId: string): Promise<SteerRecord[]> {
  const { rows } = await pool.query(
    `SELECT action, proposal, created_at FROM harness_decisions WHERE user_id = $1 AND decision = 'coldstart.reply' AND created_at > NOW() - make_interval(days => $2)
     ORDER BY created_at DESC LIMIT 30`,
    [userId, COLD_START.historyDays],
  );
  return rows.map((r: any) => ({ action: r.action as SteerAction, at: new Date(r.created_at), question: r.proposal?.question ?? null }));
}

// For the reply (services/turnContext.ts): what's on file, and what steering has happened.
export async function loadColdStart(userId: string, o: { profile?: any; asks?: { text: string; kind: "find" | "help" }[] } = {}): Promise<ColdStartView> {
  const [seeds, history, joined, lifetime] = await Promise.all([
    loadSeeds(userId, { profile: o.profile, findAsks: o.asks?.filter((a) => a.kind === "find").map((a) => a.text) }),
    steerHistory(userId).catch(() => [] as SteerRecord[]),
    pool.query(`SELECT created_at FROM users WHERE id = $1`, [userId]).then((r) => (r.rows[0]?.created_at ? new Date(r.rows[0].created_at) : null)).catch(() => null),
    // Every steering question ever asked (the lifetime cap), and whether giving up is already on record.
    pool
      .query(`SELECT count(*) FILTER (WHERE decision = 'coldstart.reply' AND action = 'steered')::int AS n, count(*) FILTER (WHERE decision = 'coldstart.gave_up')::int AS gave FROM harness_decisions WHERE user_id = $1 AND decision IN ('coldstart.reply', 'coldstart.gave_up')`, [userId])
      .then((r) => ({ n: Number(r.rows[0]?.n ?? 0), gave: Number(r.rows[0]?.gave ?? 0) > 0 }))
      .catch(() => ({ n: 0, gave: false })),
  ]);
  // The fifth try came and went with nothing findable: stop asking, and record it once.
  if (!seeds.seeded && lifetime.n >= COLD_START.steerLifetime && !lifetime.gave) {
    await import("../harness/core.js")
      .then((c) => c.recordDecision({ layer: 3, decision: "coldstart.gave_up", userId, outcome: "skip", action: "stopped_asking", reason: `${lifetime.n} natural tries never brought a findable interest`, proposal: { seeds: seeds.n, asked: history.filter((h) => h.action === "steered" && h.question).map((h) => h.question).slice(0, 5) } }))
      .catch(() => {});
  }
  return { seeds, history, joinedAt: joined, lifetimeSteers: lifetime.n };
}

// After a reply to an unseeded member went out: what it did with the steering (bookkeeping, never a gate on the text).
export async function recordSteer(userId: string, o: { offered: boolean; why: string; sent: string; seeds: SeedCount; questionsIn: (t: string) => string[] }): Promise<void> {
  const out = steerOutcome(o.sent, o.offered, o.questionsIn);
  const { recordDecision } = await import("../harness/core.js");
  await recordDecision({
    layer: 3,
    decision: "coldstart.reply",
    userId,
    outcome: out.action === "steered" ? "act" : "skip",
    action: out.action,
    reason: out.action === "rested" ? o.why : null,
    proposal: { seeds: o.seeds.n, question: out.question, questions: out.questions },
  });
}

// A sweep for one member just finished: recorded as a cold-start hit or miss when they're new; nothing for anyone else.
export async function noteColdStartSweep(s: Omit<ColdStartSweep, "joinedAt" | "now" | "seeds"> & { now?: Date }): Promise<void> {
  const { rows } = await pool.query(`SELECT created_at FROM users WHERE id = $1`, [s.userId]);
  const joinedAt = rows[0]?.created_at ?? null;
  const now = s.now ?? new Date();
  if (!isNewMember(joinedAt, now)) return;
  const seeds = s.found ? [] : (await loadSeeds(s.userId).catch(() => null))?.seeds ?? [];
  const rec = coldStartRecord({ ...s, joinedAt, now, seeds });
  if (!rec) return;
  // One miss a day per member is the signal; an hourly re-search that finds nothing again isn't a new one (review, 2026-10-08).
  if (rec.decision === "sweep.cold_start_miss") {
    const again = await pool
      .query(`SELECT 1 FROM harness_decisions WHERE user_id = $1 AND decision = 'sweep.cold_start_miss' AND created_at > $2 LIMIT 1`, [s.userId, new Date(now.getTime() - 24 * 3_600_000)])
      .catch(() => ({ rows: [] as any[] }));
    if (again.rows.length) return;
  }
  const { recordDecision } = await import("../harness/core.js");
  await recordDecision(rec);
}
