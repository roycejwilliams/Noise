// Goals in the sweep (Royce, 2026-10-08). The goal sweep searched a member's goals word for word, and a goal that is a work plan or
// one of Co's own tasks ("maintain Co's presence after the November event", "have Co draft planning docs with Sequin AI") became a
// search for "post-event community engagement strategy", which finds nothing worth a text. The rules, the same as for asks
// (askKind.ts isCoCommitment), plus a lifecycle:
//   1. Goals stay on file unchanged: who they are and what they want, and the history of where they've been.
//   2. The sweep never searches a goal verbatim. Each goal gets its findable edge (events, programs, open calls, communities,
//      people); a work plan or Co task gets only that edge ("SF AI and founder gatherings around November"), and a goal with no
//      findable edge is passed, with the reason logged.
//   3. Co's own tasks are caught in code; the model judges the rest and writes the edges; code drops any edge that restates a goal.
//      Find requests already saved from a work or Co-task goal are marked retire-due, and retire through the same ask-once flow as a
//      quiet goal, after the goal's own recheck (services/askRetire.ts, Royce 2026-10-13): never a silent kind change.
//   4. Lifecycle: every goal is active, done or stale (goal_states; no row = active). Each run re-reads the current goals and derives
//      the searches from scratch, never cached. A goal goes stale when its date or window passes, or when their newer words supersede
//      it (a profile correction, or a newer goal on file that replaces it); it's done when they or Co close it. Stale and done goals
//      stop generating searches and stay on file. A goal Co set aside from context (not in a conversation) is told to them in the next
//      natural exchange ("still want things for X?"), never silently (told_at; the reply's hint in harness/replyGrounding.ts).
// Every read and write is scoped to one member (user_id).
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { isCoCommitment } from "./askKind.js";
import { retiredBy } from "./callContext.js";
import { memberTerms, queryProblems } from "./sweepQuery.js";
import { avoidHits } from "./memberLimits.js";
import { recordAnthropicUsage } from "./llmUsage.js";
import { classifyScope } from "../harness/scope.js";

// What goal planning reads from the member record (Phase A4, 2026-10-10 audit: it saw goal text and city only, so it planned searches
// for a room they'd said they don't want, for kinds they'd ruled out, and for things an open ask was already searching).
export type PlanRecord = { person: string; statedTaste: string[]; avoid: string[]; openAsks: string[] };
export const PLAN_RECORD_LIMITS = { person: 700, asks: 6 } as const;

export type GoalKind = "findable" | "work" | "co_task";
export type GoalState = "active" | "done" | "stale";
// explicit: the kind came from a model answer that was read (or Co's own task in code), not the fallback when it couldn't be read.
// placeBound: what helps the goal happens near where they live (true) or anywhere (false); null when the read didn't say. While they're
// away, the 9am floor skips place-bound goals and keeps searching the rest (Royce, 2026-10-14: "Place-bound goals ... pause; portable
// goals ... keep running"); unknown counts as portable, so searching goes on.
export type GoalEdge = { goal: string; kind: GoalKind; edges: string[]; why: string; until: string | null; supersededBy: string | null; explicit?: boolean; placeBound?: boolean | null };
// lastSignalAt / recheckAskedAt: the goal recheck's clock (services/goalRecheck.ts). recheck: set only on a row handed to the reply as
// the recheck question ("ask": raise it; "asked": it went out, read their answer).
export type GoalStateRow = { goalHash: string; goal: string; state: GoalState; reason: string; source: "context" | "member" | "co"; changedAt: Date; toldAt: Date | null; hints: number; lastSignalAt?: Date | null; recheckAskedAt?: Date | null; recheck?: "ask" | "asked" };
export type Correction = { field: string; old_value: string | null; new_value: string | null; corrected_at: string | Date };

// maxTokens: room for every goal's answer (2026-10-09: 17 goals ran past 900 tokens, the answer was cut off mid-list, and every goal
// read as "couldn't be read this time"); about 150 tokens a goal, so 4000 holds 25. The timeout grows with it.
export const EDGE_LIMITS = { perGoal: 2, chars: 140, timeoutMs: 30000, maxTokens: 4000 } as const;
// A goal set aside from context is offered to the reply until it's raised (review of #107: a cap let it go silent for good). The count
// is kept for the record; a hint is a suggestion the reply takes only when it fits.
export const TELL_MAX_HINTS = Infinity;

// ---------- pure

// Co's own task, in code: the asks guard, plus a goal that hands Co the work ("have Co draft…", "maintain Co's presence…").
const CO_TASK = /\b(?:have|has|get|let|ask(?:ing)?|want(?:s)?)\s+(?:co|cue)\s+(?:to\s+)?\w+|\b(?:co|cue)(?:'s)?\s+(?:to\s+)?(?:draft|write|send|prepare|put together|plan|build|keep|maintain)\b|\bmaintain(?:ing)?\s+(?:co|cue)'?s\b/i;
export function isCoTaskGoal(text: string): boolean {
  return isCoCommitment(text) || CO_TASK.test(text ?? "");
}

const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2);
// An edge that is the goal restated (most of its words are the goal's) is not a findable edge: dropped in code.
export function restates(edge: string, goal: string): boolean {
  const e = words(edge), g = new Set(words(goal));
  // Nothing to compare (a goal like "AI" or "5k"): never a match (review of #107: it matched everything).
  if (!e.length || !g.size) return edge.trim().toLowerCase() === goal.trim().toLowerCase() && !!edge.trim();
  return e.filter((w) => g.has(w)).length / e.length >= 0.75 || edge.trim().toLowerCase() === goal.trim().toLowerCase();
}

// A goal whose one recheck went unanswered for this long is searched weekly, not daily: less contact and less spend, never dropped
// (Royce, 2026-11-04). It keeps its own day of the week, so the searches spread out; any signal clears recheck_asked_at and the daily
// search is back (services/goalRecheck.ts).
export const QUIET_GOAL_DAYS = 7;
export function restingToday(row: Pick<GoalStateRow, "recheckAskedAt"> | null | undefined, hash: string, now: Date): boolean {
  const asked = row?.recheckAskedAt;
  if (!asked || now.getTime() - asked.getTime() < QUIET_GOAL_DAYS * 86_400_000) return false;
  return (Math.floor(now.getTime() / 86_400_000) + parseInt(hash.slice(0, 6), 16)) % 7 !== 0;
}

export function goalHash(goal: string): string {
  return createHash("sha1").update(goal.trim().toLowerCase()).digest("hex").slice(0, 20);
}

export function edgePrompt(goals: string[], o: { city: string | null; today: string; record?: PlanRecord | null }): string {
  const r = o.record;
  return `A member of a private club in ${o.city ?? "San Francisco"} has these goals on file, oldest first (today is ${o.today}):
${goals.map((g, i) => `${i + 1}. ${g}`).join("\n")}
${r?.person ? `\nWho they are (Cue's record): ${r.person.slice(0, PLAN_RECORD_LIMITS.person)}\n` : ""}${r?.statedTaste.length ? `\nThe kind of room they've told Cue they want, in their words: ${r.statedTaste.map((t) => `"${t}"`).join("; ")}. Write edges for that kind of room; never one for the kind they said they don't want.\n` : ""}${r?.avoid.length ? `\nThey told Cue to stop suggesting: ${r.avoid.map((a) => `"${a}"`).join(", ")}. Never an edge for one of those.\n` : ""}${r?.openAsks.length ? `\nTheir open asks already have their own searches; don't write an edge that repeats one: ${r.openAsks.slice(0, PLAN_RECORD_LIMITS.asks).map((a) => `"${a}"`).join("; ")}.\n` : ""}

Cue searches the world each day for things worth texting them about, all in service of meeting the right people: events and gatherings, communities, people worth meeting, and now and then a fellowship, accelerator or cohort as a community to join (surfaced once, never tracked by application cycle or deadline). Cue never searches for funding or investors, grants to apply for, job postings or job boards, errands, shopping or travel. For each goal:
- kind: "findable" if the goal itself is something like that to look for; "work" if it's their own work plan (partnering, pitching, building, launching, raising); "co_task" if it's something Cue itself is doing for them (drafting, sending, planning, keeping something going).
- edges: up to ${EDGE_LIMITS.perGoal} short searches for the FINDABLE side of the goal (a goal about taxes, errands, shopping, travel, funding or investors, or job postings has none; a job change gets people and rooms: recruiting events, job fairs and communities in the field), things that would actually help it along, named the way a good researcher would search for the thing itself, in a few words ("SF AI founder events November", "consumer AI pre-seed open calls", "founder wellness community SF"). Never a name (theirs, their company, partners or people), never a description of them, never the goal reworded, never a strategy, a how-to or advice. A work plan or Cue task gets only its findable side; if it has none, give no edges.
- until: the last day it can still matter (YYYY-MM-DD) when the goal is tied to a date or window ("the November launch" -> its last day in November); null when it has none.
- superseded_by: the number of a LATER goal in this list that replaces it (a changed plan, a cancelled date), else null.
- place_bound: true when what would help it happens near where they live (events, local groups and places in their city); false when it can be done from anywhere (online communities, programs and cohorts, learning, anything remote).
- why: one short reason, especially when there are no edges.

Answer only with JSON: [{"n": 1, "kind": "...", "edges": ["..."], "until": null, "superseded_by": null, "place_bound": false, "why": "..."}, ...]`;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// Pure: the model's answer, checked in code. Co tasks are Co tasks whatever the model said; restated edges are dropped; a date must
// be a real date; a goal can only be superseded by a later goal in the list.
// today: a stated window already over before the goal could matter is a model slip unless the goal names a month or date (review of #107).
// direction: the index of their long-term direction in the list (appended last), which never supersedes a goal.
// How the model's answer read: "full" (one whole JSON list), "cut_off" (the list never closed or didn't parse, so only the
// complete goal objects in it were kept), "failed" (nothing usable: no answer, a timeout, no complete goal).
export type EdgeRead = "full" | "cut_off" | "failed";

// Pure: the goal objects in the model's answer. A whole list parses as is; a list cut off mid-answer keeps every goal object that
// closed (2026-10-09: one cut-off goal used to throw away all 17).
export function readEdgeAnswer(raw: string): { arr: any[]; read: EdgeRead } {
  const start = raw.indexOf("[");
  if (start < 0) return { arr: [], read: "failed" };
  const whole = raw.slice(start).match(/^\[[\s\S]*\]/);
  if (whole) {
    try {
      const arr = JSON.parse(whole[0]);
      if (Array.isArray(arr)) return { arr, read: "full" };
    } catch {
      // falls through to the salvage
    }
  }
  const arr: any[] = [];
  let depth = 0, from = -1, inString = false, escaped = false;
  for (let i = start + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) from = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && from >= 0) {
        try {
          arr.push(JSON.parse(raw.slice(from, i + 1)));
        } catch {
          // a malformed object is skipped; the goals after it still count
        }
        from = -1;
      }
    }
  }
  return { arr, read: arr.length ? "cut_off" : "failed" };
}

export function parseEdges(goals: string[], raw: string, firstName?: string | null, o: { today?: string; direction?: number | null; avoid?: string[] } = {}): GoalEdge[] {
  const { arr } = readEdgeAnswer(raw);
  const found = goals.map((_, i) => arr.find((x) => Number(x?.n) === i + 1));
  const rows = found.map((r) => r ?? {});
  // The member never goes into a search (services/sweepQuery.ts): an edge naming them, their company or partners is dropped. Their
  // own work is in the goals that aren't findable; a name in a findable goal (a neighborhood, a program) is the thing being found.
  const terms = memberTerms({ firstName, goals: goals.filter((g, i) => isCoTaskGoal(g) || String(rows[i].kind ?? "") !== "findable") });
  return goals.map((goal, i) => {
    const r = rows[i];
    const k = String(r.kind ?? "");
    const kind: GoalKind = isCoTaskGoal(goal) ? "co_task" : k === "findable" || k === "co_task" ? (k as GoalKind) : "work";
    const explicit = isCoTaskGoal(goal) || (!!arr.length && (k === "findable" || k === "co_task" || k === "work"));
    // The purpose boundary (harness/scope.ts): a goal that is an errand, shopping, travel, admin, a funding or investor search or a job
    // watch has no findable side, and no edge that reads as one is kept, however the model wrote it. The goal stays on file.
    const outside = classifyScope(goal).scope === "out";
    const edges = (Array.isArray(r.edges) && !outside ? r.edges : [])
      .map((e: unknown) => String(e ?? "").replace(/\s+/g, " ").trim().slice(0, EDGE_LIMITS.chars))
      .filter((e: string) => classifyScope(e).scope !== "out")
      // A kind they ruled out is never searched (services/memberLimits.ts; Phase A2), however the model wrote it.
      .filter((e: string) => e && !goals.some((g) => restates(e, g)) && !queryProblems(e, { terms, source: "events" }).length && !avoidHits(e, o.avoid ?? []).length)
      .slice(0, EDGE_LIMITS.perGoal);
    const named = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}\/\d{1,2}|\d{4}-\d{2}|this (?:week|weekend|month)|tonight|tomorrow)\b/i.test(goal);
    let until = typeof r.until === "string" && ISO.test(r.until) && DateTime.fromISO(r.until).isValid ? r.until : null;
    if (until && o.today && until < o.today && !named) until = null;
    const by = Number(r.superseded_by);
    const supersededBy = Number.isInteger(by) && by > i + 1 && by <= goals.length && by - 1 !== o.direction ? goals[by - 1] : null;
    // A goal the answer never reached (a cut-off read) is unread, not "no findable side".
    const why = outside ? "outside what Cue searches for (remembered only)" : !found[i] && !isCoTaskGoal(goal) ? "couldn't be read this time" : String(r.why ?? "").trim().slice(0, 200) || (edges.length ? "" : "no findable side");
    const placeBound = r.place_bound === true ? true : r.place_bound === false ? false : null;
    return { goal, kind, edges, why, until, supersededBy, explicit, placeBound };
  });
}

// Pure: what a goal is now, from this run's reading. Done stays done; a passed window or newer words make it stale; else active.
// A goal they (or Co, with them) said is still on wins over anything older (review of #107: markGoal active didn't stick): corrections
// before it don't count, a window that had already passed when they said it doesn't, and neither does a newer goal on file then.
export function lifecycle(e: GoalEdge, o: { today: string; corrections: Correction[]; prior: GoalStateRow | null; retired: (goal: string, c: Correction[], lastSaid?: Date | string | null) => Correction | null }): { state: GoalState; reason: string } {
  if (o.prior?.state === "done") return { state: "done", reason: o.prior.reason };
  if (o.prior?.state === "stale" && o.prior.source !== "context") return { state: "stale", reason: o.prior.reason };
  const reaffirmed = o.prior?.state === "active" && o.prior.source !== "context" ? o.prior.changedAt : null;
  const reaffirmedDay = reaffirmed ? DateTime.fromJSDate(reaffirmed).toISODate()! : null;
  if (e.until && e.until < o.today && !(reaffirmedDay && e.until < reaffirmedDay)) return { state: "stale", reason: `its window passed (${e.until})` };
  const c = o.retired(e.goal, o.corrections, reaffirmed);
  if (c) return { state: "stale", reason: `they said since: "${String(c.new_value ?? "that's no longer the plan").slice(0, 120)}"` };
  if (e.supersededBy && !reaffirmed) return { state: "stale", reason: `replaced by a newer goal: "${e.supersededBy.slice(0, 120)}"` };
  return { state: "active", reason: "" };
}

// What the sweep is told to look for: the active goals' edges, never a goal's own words, plus what they enjoy. Null: nothing to search.
export function edgeSearchText(edges: GoalEdge[], extra: { enjoys?: string[] | null; specifics?: string[] | null } = {}): string | null {
  const looks = [...new Set(edges.flatMap((e) => e.edges))];
  if (!looks.length && !extra.enjoys?.length) return null;
  const parts = [
    looks.length ? `look for: ${looks.join("; ")}` : null,
    extra.enjoys?.length ? `enjoys: ${extra.enjoys.join(", ")}` : null,
    extra.specifics?.length ? `specifics: ${extra.specifics.join(", ")}` : null,
  ].filter(Boolean);
  return parts.join(". ").slice(0, 600);
}

// ---------- the run

export type GoalPlan = { searchText: string | null; active: GoalEdge[]; passed: { goal: string; why: string }[]; setAside: { goal: string; state: GoalState; reason: string }[]; retiredAsks: number; read?: EdgeRead | "reused" | null };

// ---------- A plan stays current until their goals change (Royce, 2026-10-14: "a plan stays current until goals change ... no timer
// may gate whether a member's goals get searched. Not a cooldown, not a sweep schedule, not a plan age. A send can never reduce what
// Co knows"). Each plan records the goals it was read from (goalsSig: their active goals as written, a goal idled or retired drops
// out, so it counts as a change) and when the model read them (builtAt). Same goals: the plan is used however old. Changed goals, no
// plan, or a read older than PLAN_BACKSTOP_DAYS: it is read again. The backstop only ever rebuilds, never skips.
export const PLAN_BACKSTOP_DAYS = 7;

// Pure: the goals a plan reads, the same list everywhere: their goals and long-term direction, each once, minus any whose state isn't
// active (done, idle or set aside).
export function liveGoals(goals: string[], direction: string | null | undefined, states: ReadonlyMap<string, Pick<GoalStateRow, "state">>): string[] {
  const uniq = [...new Set([...goals, ...(direction ? [direction] : [])].map((g) => g.trim()).filter(Boolean))];
  return uniq.filter((g) => {
    const s = states.get(goalHash(g));
    return !s || s.state === "active";
  });
}

// Pure: the fingerprint of the goals a plan was read from. Order and spacing don't count; any edit, addition, removal or idle does.
export function goalsSignature(live: string[]): string {
  return createHash("sha1").update([...new Set(live.map((g) => g.trim().toLowerCase().replace(/\s+/g, " ")))].sort().join("\n")).digest("hex").slice(0, 16);
}

// What a stored plan says about itself (goal_sweep.plan's proposal). A plan from before 2026-10-14 has no goalsSig: it reads as changed.
export type StoredPlan = { goalsSig?: string | null; builtAt?: string | Date | null; derived?: GoalEdge[] | null; at: string | Date };
// Pure: may this plan be used for these goals now, and why.
export function planCurrent(stored: StoredPlan | null, sig: string, now: Date): { reuse: boolean; why: "no_plan" | "goals_changed" | "backstop" | "same_goals" } {
  if (!stored) return { reuse: false, why: "no_plan" };
  if (!stored.goalsSig || stored.goalsSig !== sig) return { reuse: false, why: "goals_changed" };
  const built = new Date(String(stored.builtAt ?? stored.at)).getTime();
  if (!Number.isFinite(built) || now.getTime() - built > PLAN_BACKSTOP_DAYS * 86_400_000) return { reuse: false, why: "backstop" };
  return { reuse: true, why: "same_goals" };
}

// The model's read of their live goals: each one's kind and findable edges, nothing written. Shared by the hourly plan and the 9am build.
export async function readGoalEdges(live: string[], o: { city: string | null; today: string; firstName?: string | null; direction?: string | null; record?: PlanRecord | null }, model: GoalDeps["model"]): Promise<{ derived: GoalEdge[]; read: EdgeRead | null; readCount: number }> {
  const raw = live.length ? await model(edgePrompt(live, { city: o.city, today: o.today, record: o.record ?? null })).catch(() => "") : "";
  const answer = readEdgeAnswer(raw);
  const readCount = live.length ? new Set(answer.arr.map((x) => Number(x?.n)).filter((n) => n >= 1 && n <= live.length)).size : 0;
  // Every goal came back, only the list's closing bracket didn't: that's a whole read.
  // A closed list that leaves goals out didn't read them all either (review of #128): that's a cut-off read, flagged.
  const read: EdgeRead | null = !live.length ? null : readCount === live.length && answer.read !== "failed" ? "full" : answer.read === "full" && readCount < live.length ? "cut_off" : answer.read;
  const dir = o.direction ? live.indexOf(o.direction.trim()) : -1;
  return { derived: parseEdges(live, raw, o.firstName, { today: o.today, direction: dir >= 0 ? dir : null, avoid: o.record?.avoid ?? [] }), read, readCount };
}

// The 9am floor's own plan (services/dailySweep.ts): only the search list, read fresh when their goals changed, there's no plan, or the
// last read is past the backstop. No lifecycle: no goal state is written, no ask is retired, no recheck; that housekeeping stays with
// the hourly goal sweep. A goal whose stated window has passed isn't searched (it is only passed over here; the hourly sweep sets it
// aside). Written as goal_sweep.plan (builtBy "floor"), so later runs reuse it.
export async function buildFloorPlan(userId: string, live: string[], o: { city: string | null; zone: string | null; now: Date; firstName?: string | null; direction?: string | null; record?: PlanRecord | null; why: string }, deps: Pick<GoalDeps, "model" | "log">): Promise<{ proposal: Record<string, unknown>; read: EdgeRead | null }> {
  const today = DateTime.fromJSDate(o.now).setZone(o.zone && DateTime.now().setZone(o.zone).isValid ? o.zone : "America/Los_Angeles").toISODate()!;
  const { derived, read, readCount } = await readGoalEdges(live, { city: o.city, today, firstName: o.firstName, direction: o.direction, record: o.record }, deps.model);
  const active: GoalEdge[] = [], passed: { goal: string; why: string }[] = [];
  for (const e of derived) {
    if (e.until && e.until < today) passed.push({ goal: e.goal, why: `its window passed (${e.until}); the hourly sweep sets it aside` });
    else if (e.edges.length) active.push(e);
    else passed.push({ goal: e.goal, why: `${e.kind}: ${e.why || "no findable side"}` });
  }
  const failed = read === "failed" || read === "cut_off";
  const proposal = { read, goalsRead: readCount, goalsLive: live.length, searching: active.length > 0, edges: active.map((e) => ({ goal: e.goal, kind: e.kind, edges: e.edges, placeBound: e.placeBound ?? null })), passed, setAside: [], retiredAsks: 0, goalsSig: goalsSignature(live), builtAt: o.now.toISOString(), builtBy: "floor", rebuiltBecause: o.why, derived };
  await deps.log({ userId, action: read === "failed" ? "read_failed" : read === "cut_off" ? "read_cut_off" : "built_at_9am", reason: failed ? (read === "failed" ? "the goals couldn't be read this time" : `the answer was cut off: ${readCount} of ${live.length} goals read`) : `built at 9am: ${o.why.replace(/_/g, " ")}`, proposal, ...(failed ? { failed: true } : {}) }).catch(() => {});
  return { proposal, read };
}

export type GoalDeps = {
  model: (prompt: string) => Promise<string>;
  states: (userId: string) => Promise<Map<string, GoalStateRow>>;
  setState: (userId: string, goal: string, state: GoalState, reason: string, source: GoalStateRow["source"]) => Promise<unknown>;
  corrections: (userId: string) => Promise<Correction[]>;
  retired: (goal: string, c: Correction[], lastSaid?: Date | string | null) => Correction | null;
  // intent: a lookout is never retired from a goal (lane moves, 2026-10-13); only their own words or a confirmed move change its lane.
  // id: ask_checkins.id, a UUID (2026-10-13: it was read with Number(), NaN, so no retirement ever landed).
  findAsks: (userId: string) => Promise<{ id: string | number; text: string; intent?: string | null }[]>;
  // Marks the ask retire-due, tied to the goals it restates (services/askRetire.ts flagRetire); it retires through the ask-once flow,
  // never here.
  helpAsk: (userId: string, id: string | number, intent?: string | null, goals?: string[]) => Promise<void>;
  // After a whole read: retire-due marks the plan no longer makes, on asks not yet asked, are cleared (re-evaluated every plan).
  keepRetireFlags?: (userId: string, ids: string[]) => Promise<void>;
  // failed: the read didn't come back whole (logged as a skip, never as a success).
  log: (d: { userId: string; action: string; proposal: Record<string, unknown>; reason?: string | null; failed?: boolean }) => Promise<void>;
};

// One member's goals for this sweep: read fresh, derived fresh, the lifecycle applied, set-asides recorded, goal-derived find
// requests retired. Returns what to search (or null with the reasons each goal was passed).
// direction: their long-term direction, read as a goal but never superseding one (review of #107).
// seedSig: a fingerprint of what this run read (services/coldStart.ts seedSignature), logged so a new member's sweep reruns only when
// their seeds change (services/goalSweep.ts goalSweepRuns).
// stored: their latest plan (goal_sweep.plan). When it was read from these same goals inside the backstop and kept its reading
// (derived), that reading is used again: no model call, the lifecycle below still runs on it against today (a window that passed still
// sets its goal aside). Otherwise the goals are read fresh.
export async function planGoalSweep(userId: string, goals: string[], o: { city: string | null; zone: string | null; now: Date; enjoys?: string[] | null; specifics?: string[] | null; firstName?: string | null; direction?: string | null; seedSig?: string; record?: PlanRecord | null; stored?: StoredPlan | null }, deps: GoalDeps): Promise<GoalPlan> {
  const today = DateTime.fromJSDate(o.now).setZone(o.zone && DateTime.now().setZone(o.zone).isValid ? o.zone : "America/Los_Angeles").toISODate()!;
  const states = await deps.states(userId).catch(() => new Map<string, GoalStateRow>());
  // Done or stale goals stay on file and out of the search; only active ones are read and derived.
  const live = liveGoals(goals, o.direction, states);
  const goalsSig = goalsSignature(live);
  const current = planCurrent(o.stored ?? null, goalsSig, o.now);
  const reuse = current.reuse && Array.isArray(o.stored?.derived) && o.stored!.derived!.length > 0;
  const fresh = reuse ? null : await readGoalEdges(live, { city: o.city, today, firstName: o.firstName, direction: o.direction, record: o.record ?? null }, deps.model);
  const derived: GoalEdge[] = reuse ? o.stored!.derived! : fresh!.derived;
  const readCount = reuse ? live.length : fresh!.readCount;
  const read: EdgeRead | "reused" | null = reuse ? "reused" : fresh!.read;
  const builtAt = reuse ? String(o.stored!.builtAt ?? o.stored!.at) : o.now.toISOString();
  const corrections = await deps.corrections(userId).catch(() => [] as Correction[]);
  const active: GoalEdge[] = [], passed: { goal: string; why: string }[] = [], setAside: GoalPlan["setAside"] = [];
  for (const e of derived) {
    const life = lifecycle(e, { today, corrections, prior: states.get(goalHash(e.goal)) ?? null, retired: deps.retired });
    if (life.state !== "active") {
      // Set aside only when the change really happened (re-review of #133): a failed fact write leaves the goal and its asks live.
      const changed = await deps.setState(userId, e.goal, life.state, life.reason, "context").catch(() => false);
      if (changed !== false) {
        setAside.push({ goal: e.goal, state: life.state, reason: life.reason });
        continue;
      }
    }
    if (e.edges.length) active.push(e);
    else passed.push({ goal: e.goal, why: `${e.kind}: ${e.why || "no findable side"}` });
  }
  // Find requests saved from a goal that isn't findable (or from a goal set aside) stop being searched.
  // Only on an answer that was read, or Co's own task in code: a model timeout never switches off a real find request (review of #107).
  const notFindable = [...derived.filter((e) => e.kind !== "findable" && e.explicit).map((e) => e.goal), ...setAside.map((s) => s.goal)];
  // retiredAsks counts the asks marked retire-due this run (they retire later, through services/askRetire.ts).
  let retiredAsks = 0;
  const flagged: string[] = [];
  if (notFindable.length) {
    for (const a of await deps.findAsks(userId).catch(() => [])) {
      if (a.intent === "lookout") continue;
      const tied = notFindable.filter((g) => restates(a.text, g) || restates(g, a.text));
      if (!(isCoTaskGoal(a.text) || tied.length)) continue;
      await deps.helpAsk(userId, a.id, a.intent ?? null, tied).catch(() => {});
      flagged.push(String(a.id));
      retiredAsks++;
    }
  }
  if (read === "full" || read === "reused") await deps.keepRetireFlags?.(userId, flagged).catch(() => {});
  // Goals whose recheck went unanswered are searched weekly (restingToday); the plan below still records them as active.
  const resting = active.filter((e) => restingToday(states.get(goalHash(e.goal)), goalHash(e.goal), o.now));
  const onTurn = resting.length ? active.filter((e) => !resting.includes(e)) : active;
  const searchText = edgeSearchText(onTurn, { enjoys: o.enjoys, specifics: o.specifics });
  // A read that didn't come back whole logs as a failure, whatever it still searches (Royce, 2026-10-09: "no silent success"). A
  // cut-off read still searches the goals it did read; a failed one searches only what they enjoy, if anything.
  const readFailed = read === "failed" || read === "cut_off";
  await deps
    .log({
      userId,
      action: read === "failed" ? "read_failed" : read === "cut_off" ? "read_cut_off" : searchText ? "searching_edges" : "passed",
      reason: read === "failed"
        ? "the goals couldn't be read this time"
        : read === "cut_off"
          ? `the answer was cut off: ${readCount} of ${live.length} goals read`
          : searchText ? null : passed.length || setAside.length ? "no active goal with a findable side" : "no active goals",
      proposal: { read, goalsRead: readCount, goalsLive: live.length, searching: !!searchText, edges: active.map((e) => ({ goal: e.goal, kind: e.kind, edges: e.edges, placeBound: e.placeBound ?? null })), passed, setAside, retiredAsks, ...(o.seedSig ? { seedSig: o.seedSig } : {}), goalsSig, builtAt, builtBy: "hourly", ...(reuse ? { reusedBecause: current.why } : { readBecause: current.why }), derived },
      ...(readFailed ? { failed: true } : {}),
    })
    .catch(() => {});
  return { searchText, active: onTurn, passed, setAside, retiredAsks, read };
}

// ---------- real deps

export const fromStateRow = (r: any): GoalStateRow => ({ goalHash: String(r.goal_hash), goal: String(r.goal_text), state: r.state, reason: String(r.reason ?? ""), source: r.source, changedAt: new Date(r.changed_at), toldAt: r.told_at ? new Date(r.told_at) : null, hints: Number(r.hints ?? 0), lastSignalAt: r.last_signal_at ? new Date(r.last_signal_at) : null, recheckAskedAt: r.recheck_asked_at ? new Date(r.recheck_asked_at) : null });

export async function goalStates(userId: string): Promise<Map<string, GoalStateRow>> {
  const { rows } = await pool.query(`SELECT * FROM goal_states WHERE user_id = $1`, [userId]);
  return new Map(rows.map((r: any) => [String(r.goal_hash), fromStateRow(r)]));
}

// A context set-aside waits to be told (told_at NULL); one Co or the member made in conversation is already said.
// A goal leaving the working set (done, or set aside as stale) writes its fact first (services/workingSet.ts), with the reason it
// left and its scope; going back to active writes none.
// Returns whether it changed (review of #133: a tool reported "marked done" when the fact write had failed and nothing changed). A short
// or empty reason gets a scoped default, so "done" never throws.
// told: the member already heard about it (the goal recheck's idle: they were asked), so a context set-aside isn't raised again.
export async function setGoalState(userId: string, goal: string, state: GoalState, reason: string, source: GoalStateRow["source"], o: { told?: boolean } = {}): Promise<boolean> {
  const prior = await pool.query(`SELECT state FROM goal_states WHERE user_id = $1 AND goal_hash = $2`, [userId, goalHash(goal)]).then((r) => r.rows[0]?.state ?? "active").catch(() => "active");
  if (state !== "active" && prior !== state) {
    const { writeExitFact } = await import("./workingSet.js");
    const base = state === "done" ? "they said it's done" : "set aside";
    const why = reason?.trim() && reason.trim().length >= 6 ? reason.trim() : reason?.trim() ? `${base} (${reason.trim()})` : base;
    const ok = await writeExitFact({ userId, kind: "goal", itemKey: `goal:${goalHash(goal)}`, label: goal, state: state === "done" ? "fulfilled" : "expired", reason: why, scope: "this goal only; saying it again makes it current" }).catch(() => false);
    if (!ok) return false;
  }
  await writeGoalState(userId, goal, state, reason, source, !!o.told);
  return true;
}
async function writeGoalState(userId: string, goal: string, state: GoalState, reason: string, source: GoalStateRow["source"], told = false): Promise<void> {
  await pool.query(
    `INSERT INTO goal_states (user_id, goal_hash, goal_text, state, reason, source, changed_at, told_at, hints)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), COALESCE(CASE WHEN $7::boolean THEN NOW() END, CASE WHEN $6 = 'context' AND $4 <> 'active' THEN NULL ELSE NOW() END), 0)
     ON CONFLICT (user_id, goal_hash) DO UPDATE SET goal_text = EXCLUDED.goal_text, state = EXCLUDED.state, reason = EXCLUDED.reason, source = EXCLUDED.source,
       changed_at = NOW(), told_at = EXCLUDED.told_at, hints = 0
     WHERE goal_states.state IS DISTINCT FROM EXCLUDED.state OR goal_states.source IS DISTINCT FROM EXCLUDED.source`,
    [userId, goalHash(goal), goal.slice(0, 500), state, reason.slice(0, 300), source, told],
  );
}

// The set-asides they haven't heard about yet, for the reply's hint.
// A goal idled by the recheck (services/goalRecheck.ts) was already asked about: it gets the one stopped-looking note instead
// (services/askRetire.ts), never this question.
export async function untoldSetAsides(userId: string): Promise<GoalStateRow[]> {
  const { rows } = await pool.query(`SELECT * FROM goal_states WHERE user_id = $1 AND state <> 'active' AND source = 'context' AND told_at IS NULL AND reason IS DISTINCT FROM $2 ORDER BY changed_at`, [userId, "no answer to the recheck"]);
  return rows.map(fromStateRow);
}

// Pure: whether a sent reply raised the set-aside goal: at least three of its meaning words, or half of them when it has fewer, and
// a question about it (review of #107: two shared words marked a different goal told). markGoal marks it told too.
export function raisedGoal(sent: string, goal: string): boolean {
  const g = new Set(words(goal).filter((w) => w.length > 3));
  if (!g.size) return false;
  const shared = new Set(words(sent).filter((w) => g.has(w))).size;
  return shared >= Math.min(3, Math.ceil(g.size / 2)) && /\?/.test(sent);
}

// After a reply went out: told when it raised the goal; else one more hint used. A recheck question (services/goalRecheck.ts) counts
// as asked only when a Haiku read of the sent text says it asked whether they still want it (judgeRecheckAsked: after the send, fails
// closed) and nothing moved the goal's clock since the turn started (turnStartedAt); else one more hint used. A recheck already asked
// is only read, never counted. judge: tests stub the read.
export async function noteGoalHints(userId: string, rows: GoalStateRow[], sent: string, o: { turnStartedAt?: Date | null; judge?: import("./goalRecheck.js").RecheckJudge } = {}): Promise<void> {
  for (const r of rows) {
    if (r.recheck) {
      if (r.recheck !== "ask") continue;
      const R = await import("./goalRecheck.js");
      if ((await R.judgeRecheckAsked(r.goal, sent, o.judge)).asked) await R.markRecheckAsked(userId, r.goalHash, r.goal, "reply", { signalBefore: o.turnStartedAt ?? r.lastSignalAt ?? null });
      else await R.noteRecheckHint(userId, r.goalHash);
      continue;
    }
    if (raisedGoal(sent, r.goal)) await pool.query(`UPDATE goal_states SET told_at = NOW() WHERE user_id = $1 AND goal_hash = $2`, [userId, r.goalHash]);
    else await pool.query(`UPDATE goal_states SET hints = hints + 1 WHERE user_id = $1 AND goal_hash = $2`, [userId, r.goalHash]);
  }
}

export const realGoalDeps: GoalDeps = {
  // Haiku 5.5 thinks by default and the ai-sdk drops "thinking disabled" (2026-10-07), so the SDK is called directly.
  model: async (prompt) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), EDGE_LIMITS.timeoutMs);
    try {
      const r: any = await new Anthropic().messages.create({ model: MODELS.haiku, max_tokens: EDGE_LIMITS.maxTokens, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] } as any, { signal: ctl.signal });
      recordAnthropicUsage("goal.edges", r.model ?? MODELS.haiku, r.usage);
      return (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    } finally {
      clearTimeout(t);
    }
  },
  states: goalStates,
  setState: setGoalState,
  // The record's one corrections reader (services/memberKnowledge.ts), all of them: a goal an old correction retired stays retired.
  corrections: async (userId) => (await (await import("./memberKnowledge.js")).realKnowledgeDeps.corrections(userId, { limit: 40, days: null })) as Correction[],
  // The same check that retires a corrected thread in the call context (services/callContext.ts).
  retired: (goal, c, lastSaid) => retiredBy(goal, c as any, lastSaid ?? undefined) as Correction | null,
  findAsks: async (userId) => (await pool.query(`SELECT id, ask_text, intent FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL AND kind = 'find' AND intent IS DISTINCT FROM 'lookout'`, [userId])).rows.map((r: any) => ({ id: String(r.id), text: String(r.ask_text ?? ""), intent: r.intent ?? null })),
  // Retire-due, never an immediate kind change: the ask is asked about once, after its goal's recheck, and only then set to help
  // through laneMoves.ts setAskKind (services/askRetire.ts).
  helpAsk: async (userId, id, intent, goals) => {
    const { flagRetire } = await import("./askRetire.js");
    await flagRetire(userId, String(id), intent ?? null, goals ?? []);
  },
  keepRetireFlags: async (userId, ids) => {
    const { keepRetireFlags } = await import("./askRetire.js");
    await keepRetireFlags(userId, ids);
  },
  log: async (d) => {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 7, decision: "goal_sweep.plan", userId: d.userId, outcome: d.action === "passed" || d.failed ? "skip" : "act", action: d.action, reason: d.reason ?? null, proposal: d.proposal });
  },
};
