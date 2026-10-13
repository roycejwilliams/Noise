// Why Co is calling (Royce, 2026-10-08, after a 10-call eval: 4 of 9 outbound calls opened on Co's own homework, "the PDF
// went out this morning, wanted to make sure it landed"). The rule: an outbound call Co starts on its own needs a real reason,
// and the reason comes from the member's life: something they said, celebrated, worried about, or have coming up. If the only
// thing Co has is its own deliverable, the call isn't placed: silence beats a homework call. The opening line is about their
// moment, never Co's homework.
//
//   callReasonFor(state)       pure: every candidate reason from their own record, each kept or excluded with why, and the one
//                              the call is about (or null)
//   loadCallReasonState(...)   the reads, reusing what already holds their state: the member-state detectors
//                              (memberStateNudges.ts: deadlines on things they said yes to, a goal gone quiet, their own
//                              commitments coming due), their open threads (harness/memberThreads.ts, with the feeling they had),
//                              what they said lately (member_claims: plans, worries, moods, through memberKnowledge), what they closed or went to
//                              (member_milestones), and plans they mentioned (planned_event_mentions)
//   holdCallReason / heldCallReason / callReasonVariable
//                              the chosen reason, held for the call from the gate (harness/callGate.ts) to the opening writer
//                              (callOpening.ts) and the call's dynamic variables ({{call_reason}})
//
// Never a reason: Co's own work. Anything that is Co's deliverable, promise or task (askKind.ts isCoCommitment, goalEdges.ts
// isCoTaskGoal), anything matching a doc Co delivered (document_deliveries) or a task Co carries (co_tasks), and anything that
// reads as Co's homework (CO_HOMEWORK below). An intro is never a call reason either: the opening is heard by whoever picks up,
// it may never speak for another member (callOpening.ts), and the intro nudge already goes by text.
//
// Member-requested calls (they texted "call me", scheduled one, pressed call) never need this: the reason is theirs.
import { WENT_CONFIRMED_SQL } from "./milestones.js";
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { isCoCommitment } from "./askKind.js";
import { isCoTaskGoal } from "./goalEdges.js";
import { overlap, type MemberThread } from "../harness/memberThreads.js";
import type { Claim } from "./factLabels.js";
import type { NudgeEntry } from "./memberStateNudges.js";
import type { CallAuthKind } from "../harness/callGate.js";
import type { MemberKnowledge } from "./memberKnowledge.js";

// ---------------------------------------------------------------- which calls need one

// Calls Co starts on its own. Everything else was asked for by the member (router_decision only places a call on their
// explicit "call me" or their yes to Co's call offer, services/messageRouter.ts; scheduled_call is a time they picked;
// user_initiated is them pressing call).
export const CO_INITIATED: ReadonlySet<CallAuthKind> = new Set<CallAuthKind>(["checkin_cadence", "auto_intake"]);
export function needsMemberReason(kind: CallAuthKind | null): boolean {
  return !!kind && CO_INITIATED.has(kind);
}

// ---------------------------------------------------------------- what Co's homework sounds like

// Sensitive topics (moved here from callOpening.ts so the reason and the opening share one list): a real reason to call, never
// something the first line says out loud (whoever picks up hears it).
export const SENSITIVE =
  /\b(?:biops\w*|diagnos\w*|cancer|surgery|hospital\w*|chemo\w*|therap\w*|pregnan\w*|miscarr\w*|passed away|funeral|grie\w+|died|death|divorc\w*|breakup|break-up|lawsuit|lawyer|attorney|bankrupt\w*|debt|eviction|rehab|diagnosed|medical|illness)\b/i;

const DELIVERABLE = String.raw`(?:pdf|doc|docs|document|brief|briefing|write-?up|one-?pager|plan|draft|shortlist|list|summary|research|notes|options|recap|deck|email|link|file|sheet|report)`;

// What Co makes for members (never their own deck, plan or email).
const CO_MADE = String.raw`(?:pdf|brief|briefing|write-?up|one-?pager|shortlist|summary|research|notes|options|recap|doc|document)`;

// A line (an opening, or a candidate reason) that is about Co's own work being done or delivered.
const CO_HOMEWORK: RegExp[] = [
  // "wanted to make sure it landed", "check that everything came through", "see if the doc got to you"
  /\b(?:make sure|check(?:ing)?|see|confirm)\s+(?:if |whether |that )?(?:it|that|this|the \w+|everything|my \w+)(?: all)?\s+(?:landed|came through|come through|got (?:to you|through|there)|arrived|reached you|went through)\b/i,
  /\b(?:landed|came through|come through|got there)\s+(?:ok|okay|alright|all right|safely|for you|on your end)\b/i,
  // "the PDF went out this morning", "the plan is in your inbox", "the brief was sent" (never "my email went out": theirs)
  new RegExp(String.raw`(?<!\b(?:my|our|his|her|their)\s+(?:\w+\s+){0,2})\b${DELIVERABLE}\b[^.?!]{0,40}\b(?:went out|go out to you|was sent|got sent|has been sent|is in your inbox|in your inbox|hit your inbox|sent over|sent out|was delivered|got delivered)\b`, "i"),
  // "the brief is ready", "the summary is still coming": only what Co makes (their plan or deck being done is their news)
  new RegExp(String.raw`(?<!\b(?:my|our|his|her|their)\s+(?:\w+\s+){0,2})\b${CO_MADE}\b[^.?!]{0,30}\b(?:is ready|is done|is finished|is (?:still )?(?:coming|on its way|in the works))\b`, "i"),
  // Co as the one who sent or made it: "I sent you", "I emailed over", "the plan I put together", "what I sent"
  /\b(?:i|co|we)(?:'ve| have)?\s+(?:just\s+|already\s+)?(?:sent|emailed|texted|shared|dropped|forwarded|delivered|passed along)\s+(?:you|over|along|it|that|this|the|your|a|an)\b/i,
  new RegExp(String.raw`\b(?:the|that|this|my|your)\s+(?:\w+\s+){0,3}${DELIVERABLE}\s+(?:i|co|we)\s+(?:sent|put together|pulled together|drafted|wrote|made|shared|owe|promised)\b`, "i"),
  /\bwhat i sent\b|\b(?:i|we) (?:put|pulled) together for you\b/i,
  // "did you get / see / have a chance to read the doc"
  new RegExp(String.raw`\bdid you (?:get|see|receive|open|read|check out|have a (?:chance|minute|moment) to (?:look|read|go through|review))\b[^.?!]{0,40}\b(?:${DELIVERABLE}|what i sent)\b`, "i"),
  // Co's owed work as the topic: "I still owe you that plan", "following up on the brief"
  /\bi (?:still )?owe you\b/i,
  new RegExp(String.raw`\bfollow(?:ing)?[ -]up on (?:the|that|my|your)\s+(?:\w+\s+){0,3}${DELIVERABLE}\b`, "i"),
  // Delivery receipts as a topic
  /\b(?:delivery|delivered|receipt)\b.*\b(?:co|plan|doc|pdf|brief)\b|\bplan delivered\b/i,
];

// Pure: true when the line is about Co's homework (a deliverable sent, owed, or in progress). With what the line was written from
// (`known`), a plan, deck or email "still coming" or "ready" is Co's homework when that record says Co owes, promised or sent it.
const STATE_OF = new RegExp(String.raw`\b(${DELIVERABLE})\b[^.?!]{0,30}\b(?:is ready|is done|is finished|is (?:still )?(?:coming|on its way|in the works))\b`, "i");
export function leadsWithCoHomework(line: string, known = ""): boolean {
  const t = String(line ?? "");
  if (CO_HOMEWORK.some((re) => re.test(t))) return true;
  const m = t.match(STATE_OF);
  if (!m || !known) return false;
  const noun = m[1].toLowerCase().replace(/s$/, "");
  return new RegExp(String.raw`\b(?:co owes|i owe|promised|co (?:sent|drafted|delivered|wrote)|not sent yet|still owe)\b[^.]{0,160}\b${noun}s?\b`, "i").test(known);
}

// Pure: why a candidate reason is Co's own work, or null. `theirsByConstruction`: a commitment they made in their own words
// ("I'll send them the deck Friday", member_threads kind commitment) is theirs; the ask guards would read its "I'll send" as Co's.
const CO_SUBJECT = /\bco(?:'s)?\s+(?:is|was|will|'ll|has|had|would|said|promised|putting|drafting|making|finding|sending|researching)\b|\bfrom co\b|\bco's\s+(?:plan|doc|document|research|brief|draft|list|options|shortlist|notes)\b/i;
const WAITING_ON_CO_WORK = /\b(?:waiting (?:on|for)|excited (?:to get|for)|looking forward to (?:getting|the))\b[^.]{0,60}\b(?:plan|doc(?:ument)?|pdf|research|brief|draft|options|shortlist|list|write-?up|outline|notes)\b/i;
export function coWorkWhy(text: string, coWork: string[], theirsByConstruction = false): string | null {
  const t = String(text ?? "").trim();
  if (!t) return "empty";
  if (!theirsByConstruction && isCoCommitment(t)) return "Co's own commitment (askKind isCoCommitment)";
  if (!theirsByConstruction && isCoTaskGoal(t)) return "Co's own task (goalEdges isCoTaskGoal)";
  if (leadsWithCoHomework(t)) return "reads as Co's homework (a deliverable sent, owed or in progress)";
  // Co as the subject, or waiting on something Co makes (review of #110: "waiting on the dinner plan Co is putting together" and
  // "excited to get the research on coworking spaces" were reasons to call).
  if (CO_SUBJECT.test(t)) return "about Co's own work (Co is the subject)";
  if (WAITING_ON_CO_WORK.test(t)) return "waiting on something Co makes (a plan, research, a doc)";
  // The same thing as a doc Co delivered or a task Co carries: Co's work, even when worded as theirs.
  const words = t.split(/\s+/).filter((w) => w.length > 3).length;
  if (words >= 2) {
    const hit = coWork.find((w) => w.split(/\s+/).filter((x) => x.length > 3).length >= 2 && overlap(t, w) >= 0.6);
    if (hit) return `matches Co's own deliverable or task: "${hit.slice(0, 80)}"`;
  }
  return null;
}

// ---------------------------------------------------------------- the reasons

export type CallReasonKind =
  | "their_commitment" // something they said they'd do, due now
  | "how_it_went" // a dated thing of theirs that just happened
  | "deadline" // something they said yes to, close
  | "coming_up" // a plan, meeting or event of theirs in the next days
  | "worry" // something they said they're worried or unsettled about
  | "celebration" // something they finished, or went to, lately
  | "open_thread" // an open thread in their life (with how they felt)
  | "goal_quiet" // a goal of theirs gone quiet
  | "intake" // a brand-new member's first call: getting to know them
  | "member_asked"; // they asked for this call (not gated; held so the call knows)

export type CallReason = {
  kind: CallReasonKind;
  // Stable per moment (a re-check of the same thing gets the same key).
  key: string;
  // Their moment, in plain words. What the opening and the call are about.
  text: string;
  // When it is or was (YYYY-MM-DD or ISO), or null.
  at: string | null;
  // Their own words for it, when on file.
  theirWords?: string | null;
  // How they felt when they said it (from the emotion signals), for the call; never said in the first line.
  feeling?: string | null;
  // A topic the first line never names (health, loss, money trouble...): the call can raise it once they're on.
  sensitive?: boolean;
};
export type Considered = { kind: CallReasonKind; key: string; text: string; kept: boolean; why?: string };
export type CallReasonResult = { reason: CallReason | null; considered: Considered[] };

export type CallReasonState = {
  now: Date;
  zone: string | null;
  kind: CallAuthKind;
  // memberStateNudges detectAll on their snapshot.
  nudges: NudgeEntry[];
  threads: MemberThread[];
  // Live claims (expiry already applied).
  claims: Claim[];
  milestones: { key: string; kind: string; text: string; happenedAt: string }[];
  plans: { name: string; date: string }[];
  // Co's own work: delivered doc titles and Co task goals, to exclude.
  coWork: string[];
  // Reason keys the last calls Co placed were about (not the same reason twice running).
  recentReasonKeys: string[];
};

export const CALL_REASON = {
  // A nudge counts when its own time is this close (the text version may still be hours out).
  nudgeWithinHours: 48,
  comingUpDays: 7,
  justHappenedDays: 3,
  celebrateWithinDays: 10,
  threadWithinDays: 21,
  ttlMs: 5 * 60 * 1000,
};
const DAY = 86_400_000;
const HOUR = 3_600_000;

const hash = (s: string) => createHash("sha1").update(s.trim().toLowerCase()).digest("hex").slice(0, 12);
const localDay = (d: Date, zone: string | null) => DateTime.fromJSDate(d).setZone(zone || "America/Los_Angeles").toISODate()!;
const daysBetween = (from: string, to: string) => Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days);
const relDay = (day: string, today: string) => {
  const n = daysBetween(today, day);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 0 ? `in ${n} days` : `${-n} days ago`;
};

// Order: the most immediate thing in their life first.
const PRIORITY: Record<CallReasonKind, number> = {
  their_commitment: 1,
  how_it_went: 2,
  deadline: 3,
  coming_up: 4,
  worry: 5,
  celebration: 6,
  open_thread: 7,
  goal_quiet: 8,
  intake: 0,
  member_asked: 0,
};

// Pure: every candidate from their own record, each kept or excluded (with why), and the one the call is about.
export function callReasonFor(s: CallReasonState): CallReasonResult {
  if (s.kind === "auto_intake") {
    const reason: CallReason = { kind: "intake", key: "intake", text: "their first conversation with Co: getting to know them, their life and what they're after", at: null };
    return { reason, considered: [{ kind: "intake", key: "intake", text: reason.text, kept: true }] };
  }
  const today = localDay(s.now, s.zone);
  const cands: CallReason[] = [];

  // The member-state detectors (the same triggers as the text nudges), intros left out (see the header).
  for (const n of s.nudges) {
    if (n.type === "intro_nudge") continue;
    if (n.dueAt.getTime() - s.now.getTime() > CALL_REASON.nudgeWithinHours * HOUR || n.expiresAt.getTime() <= s.now.getTime()) continue;
    const f = n.facts;
    if (n.type === "commitment_nudge") {
      cands.push({ kind: "their_commitment", key: n.entryKey, text: `they said they'd ${String(f.what_they_said_they_would_do ?? "")}, due ${String(f.when_relative_to_today ?? "")} (${String(f.the_due_date ?? "")})`, at: String(f.the_due_date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null, theirWords: (f.their_own_words as string) ?? null });
    } else if (n.type === "deadline_nudge") {
      const date = String(f.the_event_date ?? f.the_deadline_date ?? "");
      cands.push({ kind: "deadline", key: n.entryKey, text: `${String(f.the_thing ?? "")}, which they said yes to, is ${f.the_event_date ? "on" : "due"} ${date} (${String(f.when_relative_to_today ?? "")})`, at: date.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null, theirWords: (f.what_they_said_when_co_sent_it as string) ?? null });
    } else if (n.type === "goal_nudge") {
      cands.push({ kind: "goal_quiet", key: n.entryKey, text: `their goal, gone quiet a while: ${String(f.the_goal_in_their_words ?? "")}`, at: null });
    }
  }

  // Their open threads: a dated one just past (how did it go), one coming up, or a recent one with how they felt.
  for (const t of s.threads) {
    if (t.status !== "open" && t.status !== "waiting") continue;
    if (t.nextStep === "remember" && !t.dueDate) continue;
    const key = `thread:${t.id}`;
    if (t.dueDate) {
      const d = daysBetween(today, t.dueDate);
      if (d < 0 && d >= -CALL_REASON.justHappenedDays) {
        cands.push({ kind: "how_it_went", key, text: `${t.text} (it was ${relDay(t.dueDate, today)}, ${t.dueDate})`, at: t.dueDate, theirWords: t.openedQuote, feeling: t.feeling });
        continue;
      }
      if (d >= 0 && d <= CALL_REASON.comingUpDays) {
        cands.push({ kind: t.kind === "commitment" ? "their_commitment" : "coming_up", key, text: `${t.text} (${relDay(t.dueDate, today)}, ${t.dueDate})`, at: t.dueDate, theirWords: t.openedQuote, feeling: t.feeling });
        continue;
      }
    }
    const age = s.now.getTime() - new Date(t.lastTouchedAt || t.openedAt).getTime();
    if (age <= CALL_REASON.threadWithinDays * DAY && t.nextStep !== "remember") {
      cands.push({ kind: t.feeling && /worr|anxi|stress|nerv|uneas|overwhelm|sad|frustrat|afraid|scared|tense/i.test(t.feeling) ? "worry" : "open_thread", key, text: t.text, at: t.openedAt.slice(0, 10), theirWords: t.openedQuote, feeling: t.feeling });
    }
  }

  // What they said lately (their own words only; Co's inferences never start a call).
  for (const c of s.claims) {
    if (c.provenance !== "user_said") continue;
    const key = `claim:${c.kind}:${hash(c.text)}`;
    if (c.kind === "worry" || (c.kind === "mood" && /worr|anxi|stress|nerv|uneas|overwhelm|down|sad|frustrat|tense|rough/i.test(c.text))) {
      cands.push({ kind: "worry", key, text: c.text, at: c.saidOn, theirWords: c.quote });
    } else if (c.kind === "mood" && /excit|thrill|proud|happy|celebrat|stoked|great news|won|landed|closed|got (?:the|in|accepted)/i.test(c.text)) {
      cands.push({ kind: "celebration", key, text: c.text, at: c.saidOn, theirWords: c.quote });
    } else if (c.kind === "plan" || c.kind === "meeting" || c.kind === "deadline" || c.kind === "pending_decision") {
      cands.push({ kind: "coming_up", key, text: c.text, at: c.expiresOn ? DateTime.fromISO(c.expiresOn).minus({ days: 1 }).toISODate() : c.saidOn, theirWords: c.quote });
    }
  }

  // What they finished or went to lately.
  for (const m of s.milestones) {
    if (m.kind !== "thread_done" && m.kind !== "went") continue;
    if (s.now.getTime() - new Date(m.happenedAt).getTime() > CALL_REASON.celebrateWithinDays * DAY) continue;
    cands.push({ kind: "celebration", key: `milestone:${m.key}`, text: m.text, at: m.happenedAt.slice(0, 10) });
  }

  // Plans they mentioned, in the next days.
  for (const p of s.plans) {
    const d = daysBetween(today, p.date);
    if (d < 0 || d > CALL_REASON.comingUpDays) continue;
    cands.push({ kind: "coming_up", key: `plan:${hash(p.name)}:${p.date}`, text: `${p.name} (${relDay(p.date, today)}, ${p.date}; they mentioned it)`, at: p.date });
  }

  const considered: Considered[] = [];
  const kept: CallReason[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    const why =
      coWorkWhy(c.text, s.coWork, c.kind === "their_commitment") ??
      (c.theirWords && leadsWithCoHomework(c.theirWords) ? "their words are about Co's homework, not their life" : null) ??
      (s.recentReasonKeys.includes(c.key) ? "the last call Co placed was about this" : null);
    if (why) {
      considered.push({ kind: c.kind, key: c.key, text: c.text.slice(0, 160), kept: false, why });
      continue;
    }
    const r = { ...c, sensitive: SENSITIVE.test(`${c.text} ${c.theirWords ?? ""}`) };
    kept.push(r);
    considered.push({ kind: c.kind, key: c.key, text: c.text.slice(0, 160), kept: true });
  }
  // Most immediate first; a moment the first line can say out loud before one it can't.
  kept.sort((a, b) => Number(!!a.sensitive) - Number(!!b.sensitive) || PRIORITY[a.kind] - PRIORITY[b.kind] || String(b.at ?? "").localeCompare(String(a.at ?? "")));
  return { reason: kept[0] ?? null, considered };
}

// Held for the member-asked kinds, so the call knows the reason is theirs.
export function memberAskedReason(kind: CallAuthKind): CallReason {
  const text =
    kind === "scheduled_call"
      ? "they asked Co to call them at this time"
      : kind === "user_initiated"
        ? "they asked for this call (they pressed call)"
        : "they asked Co to call them (by text, just now)";
  return { kind: "member_asked", key: `asked:${kind}`, text, at: null };
}

// One line about the reason, for the call brain ({{call_reason}}) and the opening writer.
export function renderCallReason(r: CallReason | null): string {
  if (!r) return "";
  if (r.kind === "member_asked") return `They asked for this call: ${r.text}. Let them lead; it's their call.`;
  if (r.kind === "intake") return "This is their first conversation with Co: Co called to get to know them, their life and what they're after. Nothing of Co's to report.";
  const words = r.theirWords ? ` They said: "${r.theirWords.slice(0, 160)}".` : "";
  const felt = r.feeling ? ` (how they felt when they said it: ${r.feeling}; never name it to them)` : "";
  const quiet = r.sensitive ? " It's personal: don't name it in the first line (whoever picks up hears it); let them bring it up, or ask gently once they're on." : "";
  return `Co called because of something in their life: ${r.text}${felt}.${words}${quiet} Lead with them, never with Co's own work.`;
}

// ---------------------------------------------------------------- held from the gate to the call

const held = new Map<string, { at: number; result: CallReasonResult; kind: CallAuthKind | null }>();
export function holdCallReason(userId: string, kind: CallAuthKind | null, result: CallReasonResult, now = Date.now()): void {
  held.set(userId, { at: now, result, kind });
}
export function heldCallReason(userId: string, now = Date.now()): { result: CallReasonResult; kind: CallAuthKind | null } | null {
  const h = held.get(userId);
  if (!h || now - h.at >= CALL_REASON.ttlMs) return null;
  return { result: h.result, kind: h.kind };
}
// The {{call_reason}} dynamic variable: outbound only, "" when nothing is held (inbound: they called Co).
export function callReasonVariable(userId: string, direction: "inbound" | "outbound", now = Date.now()): string {
  if (direction !== "outbound") return "";
  return renderCallReason(heldCallReason(userId, now)?.result.reason ?? null);
}

// ---------------------------------------------------------------- the reads

// Pure: the layer's held claims as the Claim shape callReasonFor reads. saidOn is the day the claim was last confirmed or said
// (verifiedAt): the layer keeps the newer of the two, and a reason's day only orders reasons, it's never said.
export function claimsFromKnowledge(k: Pick<MemberKnowledge, "claims">): Claim[] {
  return k.claims.map((c) => ({ text: c.text, provenance: c.provenance, kind: c.kind, quote: c.quote, saidOn: c.verifiedAt.slice(0, 10), confirmedOn: c.verifiedAt.slice(0, 10), expiresOn: c.expiresOn }));
}

// Pure: Co's own work to exclude, from the layer: every document Co delivered (receipts and Co's ledger), what it carries for them
// (open tasks, briefs, look-outs, what it promised on a call), plus the recent task goals read here (closed ones too).
export function coWorkFromKnowledge(k: Pick<MemberKnowledge, "delivered" | "carrying">, recentTaskGoals: string[] = []): string[] {
  const docs = k.delivered.filter((d) => d.kind === "document").map((d) => d.what);
  const carried = k.carrying.filter((c) => c.kind !== "loop" && c.kind !== "document").map((c) => c.what);
  return [...new Set([...docs, ...carried, ...recentTaskGoals].map((x) => String(x ?? "").trim()).filter(Boolean))];
}

export async function loadCallReasonState(userId: string, kind: CallAuthKind, now = new Date()): Promise<CallReasonState> {
  const { default: pool } = await import("../db/db.js");
  const { memberKnowledge } = await import("./memberKnowledge.js");
  const { loadSnapshot, detectAll } = await import("./memberStateNudges.js");
  const { listThreads } = await import("../harness/memberThreads.js");
  // Their claims, zone, and Co's delivered and carried work from the one member-knowledge layer (services/memberKnowledge.ts),
  // stamped and member-stripped inside. It throws only when the names to strip can't be read: then this throws, and the gate's read
  // fails closed (no reason, no Co-started call).
  const k = await memberKnowledge(userId, { now, include: ["claims", "delivered", "carrying"] });
  const zone = k.identity.zone;
  const today = localDay(now, zone);
  const q = (sql: string, args: unknown[]) => pool.query(sql, args).then((r: any) => r.rows as any[]).catch(() => [] as any[]);
  const [nudges, threads, milestones, plans, tasks, recent] = await Promise.all([
    loadSnapshot(userId, now).then(detectAll).catch(() => [] as NudgeEntry[]),
    listThreads(userId).catch(() => [] as MemberThread[]),
    // A "went" moment only on their stated going (services/milestones.ts WENT_CONFIRMED_SQL, 2026-10-12).
    q(`SELECT key, kind, text, happened_at FROM member_milestones m WHERE user_id = $1 AND kind IN ('thread_done', 'went') AND ${WENT_CONFIRMED_SQL} AND happened_at > $2 ORDER BY happened_at DESC LIMIT 5`, [userId, new Date(now.getTime() - CALL_REASON.celebrateWithinDays * DAY)]),
    q(`SELECT event_name_raw, event_date FROM planned_event_mentions WHERE user_id = $1 AND event_date >= $2::date AND event_date <= $3::date ORDER BY event_date LIMIT 5`, [userId, today, DateTime.fromISO(today).plus({ days: CALL_REASON.comingUpDays }).toISODate()]),
    // Co's tasks of the last 60 days, closed ones too (the layer carries only the open ones): a member thread that is one of them is
    // still Co's work.
    q(`SELECT goal FROM co_tasks WHERE user_id = $1 AND created_at > NOW() - INTERVAL '60 days' ORDER BY created_at DESC LIMIT 20`, [userId]),
    q(
      `SELECT proposal->'evidence'->'callReason'->'reason'->>'key' AS key FROM harness_decisions
       WHERE user_id = $1 AND layer = 8 AND decision = 'call.gate' AND action = 'place_call' AND proposal->'evidence'->'callReason'->'reason' IS NOT NULL
       ORDER BY created_at DESC LIMIT 2`,
      [userId],
    ),
  ]);
  return {
    now,
    zone,
    kind,
    nudges,
    threads,
    claims: claimsFromKnowledge(k),
    milestones: milestones.map((m: any) => ({ key: String(m.key), kind: String(m.kind), text: String(m.text), happenedAt: new Date(m.happened_at).toISOString() })),
    plans: plans
      .filter((p: any) => p.event_date)
      .map((p: any) => ({ name: String(p.event_name_raw), date: p.event_date instanceof Date ? DateTime.fromJSDate(p.event_date, { zone: "utc" }).toISODate()! : String(p.event_date).slice(0, 10) })),
    coWork: coWorkFromKnowledge(k, tasks.map((t: any) => String(t.goal ?? ""))),
    recentReasonKeys: recent.map((r: any) => String(r.key ?? "")).filter(Boolean),
  };
}

// The gate's read: the reason for a call Co starts itself, and the held reason for any call. Fails closed: a read that throws
// is "no reason" for a Co-started call (the next cadence slot re-checks).
export async function callReasonForCall(userId: string, kind: CallAuthKind | null, now = new Date()): Promise<CallReasonResult> {
  if (!kind || !needsMemberReason(kind)) {
    const result: CallReasonResult = { reason: kind ? memberAskedReason(kind) : null, considered: [] };
    holdCallReason(userId, kind, result, now.getTime());
    return result;
  }
  let result: CallReasonResult;
  try {
    result = callReasonFor(await loadCallReasonState(userId, kind, now));
  } catch (err: any) {
    result = { reason: null, considered: [{ kind: "open_thread", key: "read_failed", text: `the read failed: ${String(err?.message ?? err).slice(0, 120)}`, kept: false, why: "read failed" }] };
  }
  holdCallReason(userId, kind, result, now.getTime());
  return result;
}
