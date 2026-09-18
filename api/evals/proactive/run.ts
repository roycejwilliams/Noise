// Layer 7 proactive harness eval (src/harness/proactive.ts). Every change to
// the pick gates, output checks, or proactive draft prompts must pass this
// with zero hard failures before it ships.
//
//   npx tsx evals/proactive/run.ts                       code-only: gates + output checks
//   npx tsx evals/proactive/run.ts --live [--only d01]   also drafts with the model
//   npx tsx evals/proactive/run.ts --live --draft-model claude-sonnet-4-6   compare a model
//
// Suites:
//   scenarios  timelines of candidates and replies, simulated every 15 min
//              through the real gate code. Hard failure: a simulated send
//              that breaks a rule, checked by an independent checker below,
//              or a scenario expectation that doesn't hold.
//   history    real co-test proactive history (cases.local.json, gitignored)
//              replayed through the same simulator. Reports how many of the
//              historical sends broke a rule, and fails if the harness would.
//   drafts     output checks on known-bad and known-good texts (several are
//              real texts Co sent before this harness). Hard failure: a
//              known-bad text passes.
//   live       (--live) the real draft functions on synthetic facts. Hard
//              failure: a draft that passes the production checks but still
//              breaks a rule the eval can see (invented day/time, a name it
//              was told to withhold, another person's intent).
import "dotenv/config";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { DateTime } from "luxon";
import { runEval, type CaseScore } from "../lib.js";
import {
  RULES,
  laneOf,
  TYPE_POLICY,
  checkDraft,
  codePick,
  evaluateCandidates,
  type Candidate,
  type OutputRules,
  type ProactiveType,
  type SendRecord,
} from "../../src/harness/proactive.js";
import { gate } from "../../src/harness/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const live = args.includes("--live");
const only = arg("only")?.split(",");
const draftModel = arg("draft-model");
if (draftModel) process.env.PROACTIVE_EVAL_DRAFT_MODEL = draftModel;

// ---------------- simulator

type Arrival = {
  at: string;
  type: ProactiveType;
  target: string;
  topic?: string;
  dueInMinutes?: number;
  expiresInHours?: number;
};

type Scenario = {
  id: string;
  source?: "real" | "synthetic";
  about: string;
  timezone: string | null;
  start: string;
  end: string;
  arrivals: Arrival[];
  inbound?: string[];
  // Transactional sends that happened; they must not count toward caps.
  exemptSends?: { at: string; type: string; target: string }[];
  // Replies come a fixed number of minutes after each simulated send.
  replyAfterMinutes?: number;
  // Struggling in the last day for the whole scenario (emotion loop).
  needsCare?: boolean;
  expect?: {
    sends?: number;
    maxSends?: number;
    minSends?: number;
    firstType?: ProactiveType;
    noSendBefore?: string;
    neverTypes?: ProactiveType[];
  };
  // history only: what actually went out before the harness
  historicalSends?: { at: string; type: string; target: string; topic?: string }[];
};

type SimSend = { at: Date; type: ProactiveType; target: string; topic: string };

function simulate(sc: Scenario): SimSend[] {
  const start = new Date(sc.start).getTime();
  const end = new Date(sc.end).getTime();
  const sends: SimSend[] = [];
  const ledger: SendRecord[] = (sc.exemptSends ?? []).map((e) => ({ type: e.type, targetKey: e.target, topicKey: e.target, sentAt: new Date(e.at), exempt: true }));
  const inbound = (sc.inbound ?? []).map((t) => new Date(t).getTime());
  const decided = new Set<string>();
  const arrivals = sc.arrivals.map((a, i) => ({ ...a, idx: i, atMs: new Date(a.at).getTime() }));

  for (let t = start; t <= end; t += 15 * 60 * 1000) {
    const now = new Date(t);
    const replies = [...inbound, ...(sc.replyAfterMinutes !== undefined ? sends.map((s) => s.at.getTime() + sc.replyAfterMinutes! * 60000) : [])].filter((x) => x <= t);
    const lastInboundAt = replies.length ? new Date(Math.max(...replies)) : null;

    // Pending = arrived, not decided. Re-arrivals of a target that is still
    // pending merge (same as enqueueCandidate); decided targets never requeue.
    const pending = new Map<string, Candidate>();
    for (const a of arrivals) {
      if (a.atMs > t || decided.has(a.target)) continue;
      if (pending.has(a.target)) continue;
      const due = new Date(a.atMs + (a.dueInMinutes ?? 0) * 60000);
      const expiresAt = new Date(a.atMs + (a.expiresInHours ?? 72) * 3600000);
      pending.set(a.target, {
        id: String(a.idx),
        userId: "u",
        type: a.type,
        targetKey: a.target,
        topicKey: a.topic ?? a.target,
        summary: a.target,
        priority: TYPE_POLICY[a.type].priority,
        dueAt: due,
        expiresAt,
        payload: {},
        attempts: 0,
        createdAt: new Date(a.atMs),
      });
    }
    for (const c of pending.values()) {
      if (c.expiresAt && c.expiresAt.getTime() <= t) {
        decided.add(c.targetKey);
        pending.delete(c.targetKey);
      }
    }
    const ev = evaluateCandidates({ now, timezone: sc.timezone, optedOut: false, candidates: [...pending.values()], sends: ledger, lastInboundAt, needsCare: sc.needsCare });
    const pick = codePick(ev.eligible);
    if (!pick) continue;
    sends.push({ at: now, type: pick.type, target: pick.targetKey, topic: pick.topicKey });
    ledger.push({ type: pick.type, targetKey: pick.targetKey, topicKey: pick.topicKey, sentAt: now, exempt: false });
    decided.add(pick.targetKey);
  }
  return sends;
}

// Independent rule check: written separately from the gate code so a bug in
// one shows up as a disagreement here.
function violations(sends: { at: Date; type: string; target: string; topic?: string }[], timezone: string | null, inboundTimes: number[]): string[] {
  const out: string[] = [];
  const sorted = [...sends].sort((a, b) => a.at.getTime() - b.at.getTime());
  const zone = timezone ?? "America/Los_Angeles";
  const replyBetween = (from: number, to: number) => inboundTimes.some((x) => x > from && x <= to);
  const seenTargets = new Set<string>();
  sorted.forEach((s, i) => {
    const local = DateTime.fromJSDate(s.at).setZone(zone);
    if (timezone) {
      if (local.hour < RULES.startHour || local.hour >= RULES.endHour) out.push(`${s.type} at ${local.toFormat("ccc HH:mm")} local`);
    } else if (s.at.getUTCHours() < 16) {
      out.push(`${s.type} at ${s.at.toISOString().slice(11, 16)} UTC with no time zone`);
    }
    if (seenTargets.has(s.target)) out.push(`duplicate ${s.target} at ${s.at.toISOString()}`);
    seenTargets.add(s.target);
    const lane = laneOf(s.type);
    const inLane = (o: (typeof sorted)[number]) => laneOf(o.type) === lane;
    const dayCap = lane === "room" ? RULES.roomMaxPerLocalDay : RULES.maxPerLocalDay;
    const weekCap = lane === "room" ? RULES.roomMaxPer7Days : RULES.maxPer7Days;
    const sameDay = sorted.filter((o, j) => j < i && inLane(o) && DateTime.fromJSDate(o.at).setZone(zone).hasSame(local, "day"));
    if (sameDay.length >= dayCap) out.push(`2nd ${lane}-lane text on ${local.toISODate()} (${s.type})`);
    const week = sorted.filter((o, j) => j < i && inLane(o) && s.at.getTime() - o.at.getTime() < 7 * 86400000);
    if (week.length >= weekCap) out.push(`${week.length + 1}th ${lane}-lane text in 7 days at ${s.at.toISOString()}`);
    // One-way pause: room-lane sends are paused only by room-lane sends; the
    // other lane is paused by anything unanswered.
    const prev = sorted.slice(0, i).filter((o) => (lane === "room" ? inLane(o) : true)).pop();
    if (prev && s.at.getTime() - prev.at.getTime() < RULES.unansweredPauseHours * 3600000 && !replyBetween(prev.at.getTime(), s.at.getTime())) {
      out.push(`${s.type} at ${s.at.toISOString()} while ${prev.type} from ${prev.at.toISOString()} was unanswered`);
    }
  });
  return out;
}

function scoreScenario(sc: Scenario, sends: SimSend[]): CaseScore {
  const replyTimes = [
    ...(sc.inbound ?? []).map((t) => new Date(t).getTime()),
    ...(sc.replyAfterMinutes !== undefined ? sends.map((s) => s.at.getTime() + sc.replyAfterMinutes! * 60000) : []),
  ];
  const hard = violations(sends, sc.timezone, replyTimes);
  const e = sc.expect ?? {};
  if (e.sends !== undefined && sends.length !== e.sends) hard.push(`expected ${e.sends} sends, got ${sends.length}: ${sends.map((s) => s.type).join(", ")}`);
  if (e.maxSends !== undefined && sends.length > e.maxSends) hard.push(`expected at most ${e.maxSends} sends, got ${sends.length}`);
  if (e.firstType && sends[0]?.type !== e.firstType) hard.push(`expected first send ${e.firstType}, got ${sends[0]?.type ?? "none"}`);
  if (e.noSendBefore && sends.some((s) => s.at < new Date(e.noSendBefore!))) hard.push(`sent before ${e.noSendBefore}`);
  for (const t of e.neverTypes ?? []) if (sends.some((s) => s.type === t)) hard.push(`sent ${t}, which should have been blocked`);
  const soft = e.minSends !== undefined ? [{ name: "delivers_expected_minimum", ok: sends.length >= e.minSends }] : [];
  return { hard, soft };
}

// ---------------- drafts (checks only)

type DraftCase = {
  id: string;
  source?: "real" | "synthetic";
  about: string;
  text: string;
  rules: Omit<OutputRules, "forbidden">;
  shouldPass: boolean;
};

// ---------------- live drafting

type LiveCase = {
  id: string;
  source?: "synthetic";
  kind: "event_tease" | "event_reveal" | "ask_solicitation" | "calendar_follow" | "companion" | "ask_checkin" | "post_call" | "debrief" | "network_tease" | "window_followup";
  input: any;
  // How they've been feeling, as the daily pick would render it.
  feeling?: string;
  // Eval-only checks on top of production checks.
  expectSkip?: boolean;
  mustNotMention?: string[];
  noInventedTime?: boolean;
};

const TIME_WORDS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow|this weekend|\d{1,2}(:\d{2})?\s?(am|pm))\b/i;
const OTHER_PERSON_INTENT = /\b(wants to meet you|would love to meet you|mentioned (you|they'?d like)|asked about you|is excited to meet)\b/i;

async function runLive(c: LiveCase): Promise<{ text: string | null; rules?: OutputRules; allowedTime?: string }> {
  const first = "Maya";
  switch (c.kind) {
    case "event_tease": {
      const { draftEventTease } = await import("../../src/agent/eventDiscoverySurfacing.js");
      const r = await draftEventTease({ firstName: first }, c.input.askText, c.input.fromProfile ?? false, c.input.match);
      return { text: r?.text ?? null, rules: r?.rules };
    }
    case "event_reveal": {
      const { draftEventReveal } = await import("../../src/agent/eventDiscoverySurfacing.js");
      const r = await draftEventReveal({ firstName: first }, c.input.askText, false, c.input.match);
      return { text: r?.text ?? null, rules: r?.rules, allowedTime: c.input.match.event_date };
    }
    case "ask_solicitation": {
      const { draftAskSolicitation } = await import("../../src/agent/eventAskSolicitation.js");
      const { draftWithFeeling } = await import("../../src/harness/proactive.js");
      const r = c.feeling ? await draftWithFeeling(c.feeling, () => draftAskSolicitation(first, c.input.eventName)) : await draftAskSolicitation(first, c.input.eventName);
      return { text: r?.text ?? null, rules: r?.rules };
    }
    case "calendar_follow": {
      const { draftCalendarFollow } = await import("../../src/agent/calendarFollowReachOut.js");
      const r = await draftCalendarFollow(first);
      return { text: r?.text ?? null, rules: r?.rules };
    }
    case "companion": {
      const { draftCompanionCheckin } = await import("../../src/agent/companionCheckin.js");
      const r = await draftCompanionCheckin(first, c.input.recap);
      return { text: r?.text ?? null, rules: r?.rules };
    }
    case "ask_checkin": {
      const { draftAskCheckin } = await import("../../src/agent/askCheckin.js");
      const r = await draftAskCheckin(first, c.input);
      return { text: r?.text ?? null, rules: r?.rules };
    }
    case "post_call": {
      const { draftPostCallText } = await import("../../src/jobs/postCallFollowUp.js");
      const r = await draftPostCallText(first, c.input.transcript, c.input.contextSummary ?? "");
      return { text: r?.text ?? null, rules: r?.rules };
    }
    case "debrief": {
      const { draftDebriefText } = await import("../../src/harness/proactiveRegistry.js");
      const r = await draftDebriefText(first, c.input.payload, c.input.people);
      return "skip" in r ? { text: null } : { text: r.text, rules: r.rules };
    }
    case "window_followup": {
      const { draftWindowFollowUp } = await import("../../src/agent/windowFollowUp.js");
      const r = await draftWindowFollowUp(first, c.input);
      return { text: r?.text ?? null, rules: r?.rules };
    }
    case "network_tease": {
      const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
      const cand = { payload: { askId: "a", candidate: c.input.candidate } } as any;
      const r = await proactiveRegistry.network_tease.draft(cand, { userId: "u", firstName: first, phoneNumber: "", city: null, timezone: null });
      return "skip" in r ? { text: null } : { text: r.text, rules: r.rules };
    }
  }
}

function scoreLive(c: LiveCase, r: { text: string | null; rules?: OutputRules; allowedTime?: string }): CaseScore {
  const hard: string[] = [];
  const soft: { name: string; ok: boolean }[] = [];
  if (c.expectSkip) {
    soft.push({ name: "skips_when_nothing_specific", ok: r.text === null });
    if (r.text && r.rules && gate(checkDraft(r.text, r.rules)).ok && /\b(thinking (of|about) you|checking in)\b/i.test(r.text)) {
      hard.push(`generic check-in passed the gate: "${r.text}"`);
    }
    return { hard, soft };
  }
  soft.push({ name: "drafted_not_skipped", ok: r.text !== null });
  if (!r.text || !r.rules) return { hard, soft };
  const failed = gate(checkDraft(r.text, r.rules)).failed;
  soft.push({ name: "passes_production_checks", ok: failed.length === 0 });
  if (failed.length) {
    console.log(`  [${c.id}] blocked by checks (${failed.map((f) => f.reason ?? f.name).join("; ")}): "${r.text}"`);
    return { hard, soft };
  }
  const lower = r.text.toLowerCase();
  for (const n of c.mustNotMention ?? []) if (lower.includes(n.toLowerCase())) hard.push(`mentions "${n}": "${r.text}"`);
  if (OTHER_PERSON_INTENT.test(r.text)) hard.push(`claims another person's intent: "${r.text}"`);
  const time = r.text.match(TIME_WORDS)?.[0];
  if (c.noInventedTime && time) hard.push(`invented timing "${time}": "${r.text}"`);
  console.log(`  [${c.id}] ${r.text}`);
  return { hard, soft };
}

// ---------------- main

function readJson<T>(file: string): T | null {
  return existsSync(join(here, file)) ? (JSON.parse(readFileSync(join(here, file), "utf8")) as T) : null;
}

async function main() {
  const synthetic = readJson<{ scenarios: Scenario[]; drafts: DraftCase[]; live: LiveCase[] }>("cases.synthetic.json")!;
  const local = readJson<{ history: Scenario[]; drafts?: DraftCase[] }>("cases.local.json");
  let hard = 0;

  const scenarios = synthetic.scenarios.map((s) => ({ ...s, source: "synthetic" as const }));
  hard += (await runEval({ name: "scenarios", dir: join(here, "scenarios"), cases: scenarios, only, run: async (s) => simulate(s), score: scoreScenario })).hard;

  if (local?.history?.length) {
    let histViolations = 0;
    let histSends = 0;
    let simSends = 0;
    const r = await runEval({
      name: "history (co-test replay)",
      dir: join(here, "history"),
      cases: local.history.map((s) => ({ ...s, source: "real" as const })),
      only,
      run: async (s) => simulate(s),
      score: (s, sends) => {
        const before = (s.historicalSends ?? []).map((h) => ({ ...h, at: new Date(h.at) }));
        const v = violations(before, s.timezone, (s.inbound ?? []).map((t) => new Date(t).getTime()));
        histViolations += v.length;
        histSends += before.length;
        simSends += sends.length;
        console.log(`  ${s.id}: before ${before.length} proactive sends with ${v.length} rule breaks; harness ${sends.length} sends`);
        for (const x of v.slice(0, 6)) console.log(`    before: ${x}`);
        return scoreScenario(s, sends);
      },
    });
    console.log(`  history totals: before ${histSends} sends / ${histViolations} rule breaks; harness ${simSends} sends`);
    hard += r.hard;
  } else {
    console.log("\nhistory: no cases.local.json, skipped");
  }

  const drafts = [...synthetic.drafts.map((d) => ({ ...d, source: "synthetic" as const })), ...(local?.drafts ?? []).map((d) => ({ ...d, source: "real" as const }))];
  hard += (
    await runEval({
      name: "draft checks",
      dir: join(here, "drafts"),
      cases: drafts,
      only,
      run: async (d) => gate(checkDraft(d.text, d.rules)),
      score: (d, g) => {
        if (!d.shouldPass && g.ok) return { hard: [`known-bad text passed: "${d.text}"`], soft: [] };
        return { hard: [], soft: [{ name: d.shouldPass ? "good_text_passes" : "bad_text_blocked", ok: d.shouldPass ? g.ok : !g.ok }] };
      },
    })
  ).hard;

  if (live) {
    hard += (
      await runEval({
        name: `live drafts (${process.env.PROACTIVE_EVAL_DRAFT_MODEL || "claude-sonnet-5"})`,
        dir: join(here, "live"),
        cases: synthetic.live,
        only,
        concurrency: 4,
        run: runLive,
        score: scoreLive,
      })
    ).hard;
  }

  console.log(`\nTOTAL hard failures: ${hard}`);
  process.exit(hard ? 1 : 0);
}

main();
