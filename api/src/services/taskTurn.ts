// Co working on one of its tasks by itself (services/coTasks.ts). When a task's
// check-in comes due, Co wakes up with the task, its steps and notes, and the
// recent conversation, and decides what to do: search, read a page, write down
// what it learned, text the member if there's something real, and when to look
// again, or close it. It's Co's plan; code guards the edges (coTasks.ts).
//
// What a task may tell them (2026-09-30): web results prove themselves first
// (services/taskWeb.ts), and a text is drafted only from verified fields, with
// every number in it backed by them.
import { awayFromClaims, awayHoldsTask, awayTaskNote, type AwayState } from "./away.js";
import { deliveryShapeProblems } from "./speakable.js";
import { CO_VOICE } from "./coVoice.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { checkDraft, draftAgain, draftProactive, localHourOk, sendExempt } from "../harness/proactive.js";
import { eventCandidates } from "./tieredRecommendation.js";
import { alreadyFoundOpenings } from "./eventSurfacingSweep.js";
import { capToFinal, isDoorLook, unspendWake } from "./coTasks.js";
import { closedOnTheirWord, closeTask, isExhausted, isFinalCheck, markFinalTold, markTexted, mayText, noteOnTask, scheduleTask, scheduleTaskAt, setTaskWindow, taskTextsToday, TASK_LIMITS, clampNextHours, type CoTask } from "./coTasks.js";
import { describeRead, excerptFact, readLink } from "./linkReader.js";
import { memberKnowledge, memberRules, restraintRule, type MemberKnowledge, type MemberRules, type Restraint } from "./memberKnowledge.js";
import { exchangeText } from "./followUps.js";
import { recordSentItems } from "./coFacts.js";
import { numbersBacked, OFFERS_WHAT_CO_CANT, placesBacked, taskWebSearch, verifiedFactLines, type TaskWebResult, type VerifiedResult } from "./taskWeb.js";
import { assembleMessages, captionOk, draftTaskMessages, namedFinds, orderByTier, type SendItem } from "./taskMessages.js";
import { promiseKeptBy, sendsSince, significant, wantsDocument, type Sent } from "./followThrough.js";
import { localStamp, memberZone, missesWindow, nextSendable, rescheduledWindow, sendableAt, windowLine, type CommitWindow } from "./memberTime.js";
import { toolUse } from "./capabilities.js";
import { WRITE_DOCUMENT_INPUT, type WriteDocumentInput } from "./documentSheet.js";
import type { GateCheck } from "../harness/core.js";
import { withMember } from "./llmUsage.js";

export const TASK_MODEL = MODELS.sonnet;

// What a task turn reads and writes. Real turns use the database and send
// texts; a dry turn (evals) keeps everything in memory and sends nothing.
export type TaskTurnDeps = {
  person: { first_name: string | null; phone_number: string; city: string | null };
  // Their thread, oldest first, each line stamped in their time (services/memberKnowledge.ts exchanges).
  recent: string;
  // The one model of them (services/personModel.ts, read through memberKnowledge).
  personModel?: string;
  // What else Co knows that the work should respect (taskKnowledge: what they already have, what else Co carries, their asks,
  // corrections, lessons, taste, what they've said that still holds, how they are), and the member-level rules (taskRules).
  knowledge?: string;
  rules?: string;
  zone: string | null;
  note: (text: string, stepDone: string | null) => Promise<void>;
  schedule: (inHours: number, plan: string) => Promise<string | null>;
  // theirWord: their own quoted words that closed it, when they did (a drop without it counts as missed: commitmentLog.ts).
  close: (status: "done" | "dropped" | "expired", outcome: string, theirWord?: string | null) => Promise<void>;
  textsToday: () => Promise<number>;
  // owed: a text the member is owed (owedText) goes out exempt; any other waits on the pacing every Co-started text does, and a
  // held one says when it's worth another look (retryAt).
  // key: a fixed send key (a slip text's, so it can only go once); otherwise each send gets its own.
  send: (messages: string[], o?: { owed: boolean; key?: string }) => Promise<{ sent: boolean; reason?: string; retryAt?: Date }>;
  // The slip exception's one read (goalOwnership.ts pieceNeededFor); a test stands in for it.
  pieceNeeded?: (piece: string, goalTitle: string, m: { date: string; words: string }) => Promise<{ needed: boolean; read: boolean }>;
  markTexted: () => Promise<void>;
  markFinalTold: () => Promise<void>;
  search: (what: string, when?: string | null) => Promise<{ name: string; url: string | null; date: string | null; tier?: number; details?: string[] }[]>;
  web: (what: string) => Promise<TaskWebResult>;
  readPage: (url: string) => Promise<{ ok: boolean; facts: string[]; text: string }>;
  now: () => Date;
  // What Co sent them since a time (texts, links, documents): a promise closes as done only on a matching send after it.
  sentSince?: (since: Date) => Promise<Sent[]>;
  // The document tool, texting's own (services/documentDelivery.ts sendDocumentForTask): grounded, inside their hours, recorded.
  writeDocument?: (input: WriteDocumentInput, o: { read: string }) => Promise<{ ok: true; title: string; via: string } | { ok: false; why: string; nextAt?: Date }>;
  // A commitment's window (services/memberTime.ts): the miss warning, sent once per window through the send path with quiet hours,
  // the window moved to the new time, and the next check set to when the deliverable can go out.
  warn?: (text: string, key: string) => Promise<{ sent: boolean; reason?: string }>;
  setWindow?: (w: CommitWindow) => Promise<void>;
  scheduleAt?: (at: Date, plan: string) => Promise<string | null>;
  // A wake whose only send was held for pacing gives its wake back (coTasks.ts unspendWake).
  unspendWake?: () => Promise<void>;
  draftWarning?: (facts: Record<string, string>, redo?: { draft: string; failed: string }) => Promise<string | null>;
  // What's already on file and verified for them (the sweep's finds, this task's earlier results): sendable like this turn's
  // own results (Royce, 2026-10-09: the run link was on file and the task said "the link wasn't working").
  onFile?: () => Promise<OnFile[]>;
  // Names Co's daily pick rejected for them (services/sweepShadow.ts): never sent by a task either.
  rejected?: () => Promise<string[]>;
  // An on-file find, read again before it's sent (Phase B, B5; services/sendCheck.ts recheckOnFile).
  recheckOnFile?: (f: OnFile) => Promise<{ ok: true; facts: string[]; checkedAt: string } | { ok: false; why: string; exited: boolean }>;
  // This turn's verified results, kept on the task for its next turn.
  saveFound?: (items: OnFile[]) => Promise<void>;
  // They said they're away from home (services/away.ts): a text carrying an event the task found waits until they're back.
  away?: AwayState | null;
};
// checkedAt: when its page was last read (Phase B, B5); a find with none is as old as when it was found.
export type OnFile = { name: string; url: string; tier: number; facts: string[]; checkedAt?: string | null };

// A promise is kept only by something sent AFTER it was made (2026-10-08: task 111 closed itself as done on a document sent the
// day before, on a different focus, and nothing went out after the call). Texts sent in this wake-up count; earlier sends never do.
// Pure: the other sends from the same call that ride a task.
export function alsoSaid(notes: { text: string }[]): string[] {
  return notes.map((n) => String(n?.text ?? "").match(/^Also said on the call: "([^"]+)"/)?.[1]).filter((x): x is string => !!x);
}

export async function promiseCloseCheck(task: Pick<CoTask, "goal" | "theirWords" | "createdAt" | "source"> & { notes?: { text: string }[] }, sentThisTurn: string[], deps: Pick<TaskTurnDeps, "sentSince" | "now">, docsThisTurn: string[] = []): Promise<{ ok: boolean; why: string }> {
  if (task.source !== "promise") return { ok: true, why: "not a promise" };
  const at = new Date(task.createdAt);
  // A few days back too, so the refusal can say plainly that an earlier send doesn't count.
  const sends: Sent[] = [
    ...((await deps.sentSince?.(new Date(at.getTime() - 3 * 24 * 3_600_000)).catch(() => [] as Sent[])) ?? []),
    ...sentThisTurn.map((t) => ({ at: deps.now(), text: t, kind: (/^\s*https?:\/\/\S+\s*$/.test(t) ? "link" : "text") as Sent["kind"], forThis: true })),
    // A document this wake-up sent (writeDocument) is a document send, the kind a promised doc or plan needs.
    ...docsThisTurn.map((title) => ({ at: deps.now(), text: `a document (PDF): ${title}`, kind: "document" as const, forThis: true })),
  ];
  const v = promiseKeptBy({ goal: task.goal, theirWords: task.theirWords, at }, sends);
  if (!v.kept) return { ok: v.kept, why: v.why };
  // A call's other sends that ride this task (callCommitments.ts "Also said on the call"): each one has to be kept too, or the
  // task stays open (review of #115: the doc went, the links never did, and the task closed itself).
  for (const extra of alsoSaid((task as any).notes ?? [])) {
    const e = promiseKeptBy({ goal: `Keep your word from the call: "${extra}"`, theirWords: task.theirWords, at }, sends);
    // Its own subject has to be in what went out: any link isn't the Tech Week list.
    const said = sends.filter((x) => x.at.getTime() > at.getTime() && x.kind !== "link").map((x) => x.text).join(" ");
    const subject = significant(extra.replace(/\b(?:i'?ll|i will|text|send|you|over|now|later|tonight|right|after|hang|share|forward|drop)\b/gi, " "));
    const onSubject = !subject.length || subject.some((w) => significant(said).includes(w));
    if (!e.kept || !onSubject) return { ok: false, why: `"${extra}" is part of this task and hasn't been sent${e.kept ? "" : `: ${e.why}`}` };
  }
  return { ok: true, why: v.why };
}

// The promised thing is a document (a doc, PDF, write-up, or a plan Co is writing): it goes through writeDocument, never a text.
export function documentPromiseLine(t: Pick<CoTask, "source" | "goal" | "theirWords">): string {
  if (t.source !== "promise" || !wantsDocument(t.goal, t.theirWords)) return "";
  return `\nWHAT YOU PROMISED IS A DOCUMENT. Send it with writeDocument (it arrives as a PDF), never as a text or a run of texts. Their points (the sections) only in their own words: what they want, their event, their constraints. Your plan, ideas and recommendations go in suggestions: that's most of a planning doc, and it's fine. Don't name a place, person, number or date they never said or you never read. Once it's sent, finish the task as done.`;
}

// Pure: a piece of a goal they handed Co (services/goalOwnership.ts): only this piece is Co's, and its delivery is the receipt.
export function goalPieceLine(t: Pick<CoTask, "followup">): string {
  const g = t.followup;
  if (g?.goalId == null || g?.checkin) return "";
  return `This is the piece of their goal "${String(g.goalTitle ?? "").slice(0, 160)}" that they handed you. Only this piece is yours: their other pieces stay theirs, and you never work, report on or ask about them here. When it lands, send it then (the thing itself, with its link or document), within the usual send rules; tie it back to their goal only where their own words show the connection. Never spend money, post anything publicly or contact anyone for them: if the piece needs that, hand that step back to them.\n`;
}

// Pure: what else Co knows about them, for a task turn (services/memberKnowledge.ts, already stripped of other members). This
// task's own entry is left out of what Co carries (it's the task itself). Each section left out when empty; every list capped.
export function taskKnowledge(k: Pick<MemberKnowledge, "delivered" | "carrying" | "asks" | "corrections" | "lessons" | "preferences" | "claims" | "restraint">, o: { taskId: number; zone: string | null }): string {
  const when = (at: string) => localStamp(at, o.zone);
  const r = k.restraint;
  const carrying = k.carrying.filter((c) => c.ref !== `task #${o.taskId}` && c.state !== "done").slice(0, 6);
  return [
    r?.feeling ? `How they are lately (from their own words): ${r.feeling}.` : null,
    k.delivered.length ? `What they already have from you (newest first; never send one again as new, and a promise isn't kept by an old send):\n${k.delivered.slice(0, 10).map((d) => `- ${d.what} (${d.kind}, ${when(d.at)})${d.url ? ` ${d.url}` : ""}${d.reaction ? ` — they reacted: ${d.reaction}` : ""}`).join("\n")}` : null,
    carrying.length ? `What else you're carrying for them (each has its own turn; context only, never worked or reported on here):\n${carrying.map((c) => `- ${c.what} (${c.kind}, ${c.state}${c.told ? ", they know" : ""})`).join("\n")}` : null,
    k.asks.length ? `What they've asked you to find or help with, still open (context only: each is its own work, never worked or reported on here):\n${k.asks.slice(0, 6).map((a) => `- ${a.text}`).join("\n")}` : null,
    k.corrections.length ? `What they corrected (only the corrected version exists; never bring back the old one):\n${k.corrections.slice(0, 5).map((c) => `- ${c.field}: was "${c.was}", now ${c.now == null ? "(removed)" : `"${c.now}"`}`).join("\n")}` : null,
    k.lessons.length ? `What you've learned working with them:\n${k.lessons.slice(0, 5).map((l) => `- ${l.text}`).join("\n")}` : null,
    k.preferences.length ? `Their taste (what kind of room they've said they want, then how your suggestions landed):\n${k.preferences.map((p) => `- ${p.text}`).join("\n")}` : null,
    k.claims.length ? `What they've told you that still holds:\n${k.claims.slice(0, 6).map((c) => `- ${c.text}${c.expiresOn ? ` (until ${c.expiresOn})` : ""}`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Pure: the member-level rules a task turn reads with (services/memberKnowledge.ts memberRules: the shared constants, plus
// restraint and quiet hours read from their state). The send gating is sendExempt's: a text they're owed goes exempt, any other
// waits on spacing, pace and kind backoff (owedText, issue #126).
// The restraint a task reads leaves out what belongs to Co's own unprompted sends, not to them: space_until is set exactly when
// Co hands work to a task (harness/proactive.ts payload first), hold_until only when the daily pick picks nothing, and the
// unanswered count is the proactive lanes' pause. Read here, any of them would tell the task to hold the very result it owes.
// What's about them stays: a safety hold, a hard time, frustration with Co, the kinds they let pass.
export function taskRestraint(r: Restraint | null): Restraint | null {
  return r ? { ...r, holdUntil: null, spaceUntil: null, unanswered: { ...r.unanswered, count: 0 } } : null;
}
export function taskRules(r: MemberRules, k?: Pick<MemberKnowledge, "restraint" | "identity">): string {
  const restraint = k ? restraintRule(taskRestraint(k.restraint), k.identity.zone) : r.restraint;
  return [r.grounding, r.memberSafety, r.discretion, r.deliveryShape, restraint, r.quietHours].filter(Boolean).join("\n\n");
}

export function taskTurnPrompt(o: { task: CoTask; firstName: string; now: string; zone: string | null; recent: string; final?: boolean; person?: string; onFile?: OnFile[]; knowledge?: string; rules?: string }): string {
  const t = o.task;
  const deadlineLine = `${t.deadline ? `\nTheir deadline: ${t.deadline}.` : ""}${t.window && !t.window.closedAt ? `\nYour window: ${windowLine(t.window)} An empty search is a result, and they hear it inside the window: if it won't be ready in time, don't text about that yourself, just schedule your next look; when it lands past the window they're told once, in one plain line, with the new time.` : ""}${documentPromiseLine(t)}`;
  const finalLine = o.final
    ? `\nTHIS IS YOUR LAST CHECK BEFORE THEIR DEADLINE. Do what you can now, then tellThem plainly where it stands, even if the answer is that nothing real turned up. Don't go quiet on a deadline. Keep the task open and schedule your next look unless they've said they don't need it; if you ask them something, their answer wakes it. Don't mark a step done that you didn't do (sending options you don't have isn't done).`
    : "";
  return `${CO_VOICE}

${t.source === "lookout" && t.lookoutOrigin === "member" ? `Right now you're keeping an eye out for ${o.firstName} because they asked you to, in their words: "${t.theirWords}". They're waiting to hear when something real turns up: look, and text when it does, with the thing itself, never a progress report and never "nothing yet". If it stops making sense (it happened, or they moved on), finish it quietly.\n\nWhat they asked you to watch for: "${t.goal}"` : t.source === "lookout" && isDoorLook(t) ? `Right now you're keeping an eye out for ${o.firstName} on your own, for what they told you they're after in their first conversation with you. You never promised them a time or a text, and there was no call: never say you told them, promised or said on a call that you would. Nobody is waiting on a message: look, and text only when something real turns up, offered lightly as something you came across for them, never a progress report and never "nothing yet". If it stops making sense (they found it, or moved on), finish it quietly.\n\nWhat you're looking for: "${t.goal.replace(/^First look for them:\s*/i, "")}"\nWhat they had said: "${t.theirWords}"`: t.source === "lookout" ? `Right now you're keeping an eye out for ${o.firstName}, as you told them on a call you would. Nobody is waiting on a message: look, and text only when something real turns up, never a progress report and never "nothing yet". If it stops making sense (it happened, or they moved on), finish it quietly.\n\nWhat you said you'd look out for: "${t.goal.replace(/^Keep an eye out, as promised on a call:\s*/i, "")}"\nWhat they had said just before: "${t.theirWords}"` : t.source === "promise" ? `Right now you're following through on something you told ${o.firstName} you would do. They're expecting it: do what you said and send it when it's done. If it isn't done yet, keep working and say nothing: no progress reports, no "no details yet", no "a few leads". Text before it's done only when you need something from them (ask for exactly that), or when it truly can't be done (say plainly what you couldn't find and what you'd do instead). Never hold their own thing back because you judge it not good enough yet.\n\nWhat you promised: "${t.goal}"\nWhat they had said when you promised: "${t.theirWords}"` : `Right now you're working in the background on something ${o.firstName} asked you to do. Nobody is waiting on this message; you're doing the work, then deciding what's next.\n\nTheir goal: "${t.goal}"\nTheir own words when they asked: "${t.theirWords}"`}
${goalPieceLine(t)}Steps: ${t.steps.length ? t.steps.map((s) => `${s.done ? "[done]" : "[ ]"} ${s.text}`).join("; ") : "(none written)"}
What you planned to do now: ${t.planNext ?? "(nothing written)"}${deadlineLine}${finalLine}${o.onFile?.length ? `\nAlready on file and verified for them (send any of these with tellThem, by their link; no need to find them again):\n${o.onFile.slice(0, 12).map((f) => `- ${f.name} (${f.url})${f.facts.length ? `: ${f.facts.slice(0, 3).join("; ")}` : ""} [${f.checkedAt ? `read ${f.checkedAt.slice(0, 10)}` : "found on an earlier day"}; its page is read again before it's sent]`).join("\n")}` : ""}
Your notes so far (oldest first):
${t.notes.map((n) => `- [${localStamp(n.at, o.zone)}] ${n.text}`).join("\n") || "- (none)"}
This is wake-up ${t.wakes} of at most ${TASK_LIMITS.maxWakes}. Now, their time: ${o.now}${o.zone ? ` (their time zone: ${o.zone})` : ""}.

${o.person ? `What you know about them (who they are, what's going on, what you've done, everything you're carrying for them):\n${o.person}\n\n` : ""}${o.knowledge ? `${o.knowledge}\n\n` : ""}${o.rules ? `Rules for them:\n${o.rules}\n\n` : ""}Your recent texts with them (oldest first, each stamped with its time, theirs; read their newest messages first, they may have answered you or changed their mind):
${o.recent || "(none)"}

Do the next real step with your tools (search for events and opportunities, webSearch for anything else such as venues, vendors, people or prices, readPage, writeDocument for a document you promised), and write down what you learned with note. When you finish a step, call note with stepDone set to that step's exact text. Only mark a step done when you actually did it; closing a task doesn't finish its steps.
Then decide:
- If they've said they don't need it anymore, found it themselves, or it's done: finish it (and tellThem only if a short close-out helps).
- Text only about this goal. Their other goals have their own tasks, so never start, promise or report work on another goal here.
- Text them (tellThem) only when there's something real to tell or a question only they can answer, never just to say you're still working on it. Only verified results can be told.
- Otherwise schedule your next look (scheduleNext): pick the time that makes sense for this (before a deadline, after a date they gave, a few days for things that change slowly), and write what you'll do then.
You must end with scheduleNext or finish. Never make up results: only what your tools returned.`;
}

type Found = { name: string; url: string | null; facts: string[]; tier: number; onFile?: boolean; checkedAt?: string | null; rechecked?: boolean };

// Their newest lines in the thread ("User said: …", or "[Thu Oct 9, 3pm PDT] User said: …" stamped), oldest first.
export function newestMemberLines(recent: string, n = 3): string[] {
  return recent.split("\n").map((l) => l.match(/^\s*(?:\[[^\]]*\]\s*)?User said:\s*(.+)$/i)?.[1]?.trim() ?? "").filter(Boolean).slice(-n);
}

// Did they say this goal is done (booked it, found it themselves, no longer
// need it)? A model read, held to their actual words: the quote must be in
// what they said (2026-10-01 next-live run: "we booked Wave" left the venue
// task open 3 of 4 times, and it texted about a different goal).
export function quoteIsTheirs(quote: string | null | undefined, lines: string[]): boolean {
  const q = (quote ?? "").trim().toLowerCase();
  return q.length >= 3 && lines.some((l) => l.toLowerCase().includes(q));
}
export async function memberSaysGoalDone(goal: string, recent: string): Promise<{ done: boolean; quote: string | null }> {
  const lines = newestMemberLines(recent);
  if (!lines.length) return { done: false, quote: null };
  const { text } = await generateText({
    model: anthropic(MODELS.haiku),
    maxOutputTokens: 200,
    experimental_telemetry: { isEnabled: true, functionId: "taskTurn.goalDone" },
    prompt: `Cue is working on this for a member: "${goal}".\nTheir newest messages, oldest first:\n${lines.map((l) => `- ${l}`).join("\n")}\n\nDid they say THIS goal is done, handled themselves (booked it, found it, sorted it), or no longer wanted? Only this goal: a different goal they mention doesn't count. Return ONLY JSON: {"done": true|false, "quote": "their exact words that say so, or null"}.`,
  });
  const m = text.match(/\{[\s\S]*\}/);
  let j: any = null;
  try { j = m ? JSON.parse(m[0]) : null; } catch {}
  const done = j?.done === true && quoteIsTheirs(j?.quote, lines);
  return { done, quote: done ? String(j.quote) : null };
}

// Pure: a send carries an event the task found (by its link, or its name in the words).
export function eventInSend(what: string, links: string[], events: { name: string; url: string | null }[]): boolean {
  const w = what.toLowerCase();
  return events.some((e) => (!!e.url && links.includes(e.url)) || (e.name.trim().length >= 6 && w.includes(e.name.trim().toLowerCase())));
}

export async function runTaskTurnWith(task: CoTask, deps: TaskTurnDeps): Promise<{ action: string; did: string[]; texts: string[]; final: boolean; warning?: string | null }> {
  const final = isFinalCheck(task, deps.now());
  // They already said it's done: close it before any work or text.
  const doneByThem = await memberSaysGoalDone(task.goal, deps.recent).catch(() => ({ done: false, quote: null as string | null }));
  if (doneByThem.done) {
    await deps.close("done", `They said so: "${(doneByThem.quote ?? "").slice(0, 200)}"`, doneByThem.quote);
    return { action: "finished", did: [`closed: they said "${(doneByThem.quote ?? "").slice(0, 120)}"`], texts: [], final };
  }
  const verified: VerifiedResult[] = [];
  const events: Found[] = [];
  const pageFacts: string[] = [];
  const texts: string[] = [];
  const docsSent: string[] = [];
  const did: string[] = [];
  let decided: "scheduled" | "finished" | null = null;
  // When the next check lands (Co's scheduleNext, or the default): the window check reads it after the turn.
  let nextAt: Date | null = null;
  // A send held for pacing (harness/proactive.ts coInitiated): the next look is no sooner than the hold, and the wake isn't spent.
  let heldUntil: Date | null = null;
  const linkOk = (l: string) => verified.some((v) => v.url === l) || events.some((e) => e.url === l);
  // The finds a text may not name without carrying the link: every find this task holds whose link hasn't already gone to them
  // since the task started (naming one they already have isn't a tease). Read once a turn.
  let sentBefore: string[] | null = null;
  const unsentFinds = async (): Promise<{ name: string; url: string }[]> => {
    sentBefore ??= ((await deps.sentSince?.(new Date(task.createdAt)).catch(() => [] as Sent[])) ?? []).map((x) => x.text);
    const bare = (u: string) => u.replace(/[)\].,;!?]+$/, "").replace(/\/+$/, "");
    const out = new Set([...sentBefore, ...texts].flatMap((t) => t.match(/https?:\/\/\S+/g) ?? []).map(bare));
    return ([...events, ...verified].filter((x) => !!x.url) as { name: string; url: string }[]).filter((f) => !out.has(bare(f.url)));
  };
  // Co's daily pick rejected these for them: a task never sends them either (Royce, 2026-10-09: Claude for Games came back as
  // "confirmed" after the pick rejected it as not his interest).
  const rejected = new Set(((await deps.rejected?.().catch(() => [] as string[])) ?? []).map((n) => n.toLowerCase().replace(/[^a-z0-9|:\u2014\u2013]+/g, " ").trim()).filter(Boolean));
  // The name's own words, without a city or venue prefix ("San Francisco | Claude for Games" -> "claude for games").
  // Only the item's own title: the full name, or what follows a "San Francisco |" style prefix, and only when it is 3+ words, so
  // a city, a series ("Tech Week") or a generic ("Run Club") never blocks everything that mentions it (review of #117).
  const rejectedCores = [...rejected].flatMap((r) => [r, r.split(/\s*[|:\u2014\u2013]\s*/).pop() ?? ""]).map((x) => nameKey(x)).filter((x) => x.split(" ").length >= 3);
  const namesRejected = (t: string) => { const k = nameKey(t); return rejectedCores.some((c) => k.includes(c)); };
  const isRejected = (name: string | null | undefined) => !!name && (rejected.has(nameKey(name)) || namesRejected(name));
  // On file and verified already: sendable this turn without being found again.
  for (const f of (await deps.onFile?.().catch(() => [] as OnFile[])) ?? []) {
    if (!f.url || isRejected(f.name) || events.some((e) => e.url === f.url)) continue;
    events.push({ name: f.name, url: f.url, facts: f.facts.slice(0, 5), tier: f.tier, onFile: true, checkedAt: f.checkedAt ?? null });
  }

  // A promise goes in one message with everything it promised (Royce, 2026-10-09, "close on the promise, not the attempt"):
  // a send that would leave part of it out waits until the missing piece is in hand.
  const wholeDelivery = async (messages: string[]): Promise<string | null> => {
    if (task.source !== "promise" || final) return null;
    const v = await promiseCloseCheck(task, messages, deps, docsSent).catch(() => ({ ok: true, why: "" }));
    return v.ok ? null : `Not sent: this is the one delivery for the promise, and it would leave part out (${v.why}). Get the missing piece (a link on file counts), then send it all together in one message.`;
  };
  const tell = async (what: string, links?: string[]) => {
        // One delivery, one line (services/speakable.ts): the document went with its own sentence. Nothing texts about it again.
        if (docsSent.length) return { ok: false, error: "The document already went out with its one line. Don't text about it: finish the task, or note anything else for later." };
        // Outside their hours nothing is held in memory to send later: Co waits for their morning.
        if (!localHourOk(deps.now(), deps.zone)) return { ok: false, error: "It's outside their hours (8am to 9pm their time). Note what you'd tell them and schedule your next look for their morning." };
        // A "nothing yet" text is a progress report, and progress reports never go (Royce, 2026-10-08): silence until there's
        // something real. Only the last check before their own deadline may say plainly that nothing turned up.
        if (!final && progressReport(what, [...events.map((e) => e.name), ...verified.map((v: any) => v.name ?? "")])) return { ok: false, error: "Not sent: that's a progress report (nothing yet). Say nothing until you have the thing itself; note it and schedule your next look." };
        // The task row was read at the start of the turn: a text already sent in this turn counts as texted (review of #115: four
        // tellThem calls in one promise turn all went out past the cap).
        // One delivery, one message (Royce, 2026-10-09): a promise is delivered once. After it, nothing else goes for it.
        // Delivered means kept: a question or an honest "can't" before then still goes (review of #117: tasks got stuck).
        if (task.source === "promise" && (await promiseCloseCheck(task, texts, deps, docsSent).catch(() => ({ ok: false }))).ok) return { ok: false, error: "Not sent: this promise was already delivered in one message. Nothing more goes for it; finish the task." };
        // Never a failure nobody checked (Royce, 2026-10-09: "the link wasn't working" was invented): leave it off and say nothing.
        if (inventedFailure(what)) return { ok: false, error: "Not sent: it says something is broken, failed or unavailable, and no check in your record says so. Leave that thing off and say nothing about it." };
        if (namesRejected(what)) return { ok: false, error: "Not sent: it names something Cue's daily pick rejected for them. Leave it off." };
        // Away (2026-10-11, tasks 164/165 kept looking for SF rooms while Jacqueline was traveling): an event it found, by its link or
        // its name, is tied to where they live and waits until they're back. Anything else (a role, a program) still goes.
        // Only a look-out Co started on its own word waits (awayHoldsTask): what they asked for, and owed deliveries, always go.
        if (deps.away && awayHoldsTask(task) && eventInSend(what, links ?? [], events)) return { ok: false, error: awayTaskNote(deps.away) };
        const asOfNow = texts.length ? { ...task, lastTextedAt: deps.now().toISOString() } : task;
        // A promise's delivery (its links) is the thing they're owed: the per-task gap after an unanswered question doesn't hold it
        // (review of #129). Anything else still waits on mayText.
        const delivering = task.source === "promise" && (links ?? []).some(linkOk);
        const allowed = delivering ? { ok: true, why: null } : mayText(asOfNow, await deps.textsToday(), deps.now());
        if (!allowed.ok) return { ok: false, error: `Not sent: ${allowed.why}. Note it and schedule the next look instead.` };
        // Owed (review of #129): the thing they asked for or were promised, whenever it lands, not only as the first text. A
        // promise stays owed until it's kept (promiseCloseCheck above stops it after); links for an ask are its delivery.
        // A look-out they asked for is a delivery every time: they asked for this text (Royce, 2026-10-09).
        const owed = task.source === "promise" || task.lookoutOrigin === "member" || owedText(asOfNow, deps.now());
        const held = (r: { reason?: string; retryAt?: Date }) => {
          if (r.retryAt && (!heldUntil || r.retryAt > heldUntil)) heldUntil = r.retryAt;
          return `Held, not sent: ${r.reason ?? "pacing"}. This is Cue starting a text, so it waits like every other one.${r.retryAt ? ` Your next look is set for ${r.retryAt.toISOString()}.` : ""} Note it; send the same thing then if it still holds.`;
        };
        const known = (links ?? []).filter(linkOk);
        // Only verified fields: web results that proved themselves, events from Co's
        // own gated search, and fields the page reader verified. Never raw page text.
        const facts = {
          what_they_asked_for: task.goal,
          their_words: task.theirWords,
          verified_results: verifiedFactLines(verified).join(" | ") || "(none)",
          events_found: events.map((e) => `${e.name}${e.url ? ` (${e.url})` : ""}${e.facts.length ? `: ${e.facts.join("; ")}` : ""}`).join(" | ") || "(none)",
          verified_page_facts: pageFacts.join(" | ") || "(none)",
        };
        // An on-file find is read again before it goes (Phase B, B5, 2026-10-10: on-file finds went out unchecked, with no time on
        // them): sold out, gone or past is left out (and exits, services/sendCheck.ts recheckOnFile); unreadable is left out of this
        // send; read is sent from what its page says now. With no reader at hand, its facts say how old they are.
        const leftOut: string[] = [];
        const leftOutUrls = new Set<string>();
        for (const url of known) {
          const ev = events.find((e) => e.url === url && e.onFile && !e.rechecked);
          if (!ev) continue;
          if (!deps.recheckOnFile) {
            ev.facts = [...ev.facts.filter((f) => !/not checked since/.test(f)), `on file from ${ev.checkedAt ? ev.checkedAt.slice(0, 10) : "an earlier day"}, not checked since`];
            ev.rechecked = true;
            continue;
          }
          const r = await deps.recheckOnFile({ name: ev.name, url, tier: ev.tier, facts: ev.facts, checkedAt: ev.checkedAt ?? null }).catch(() => ({ ok: false as const, why: "its page couldn't be read", exited: false }));
          if (r.ok) Object.assign(ev, { facts: r.facts, checkedAt: r.checkedAt, rechecked: true });
          else {
            leftOut.push(`${ev.name}: ${r.why}`);
            leftOutUrls.add(url);
          }
        }
        const sendable = known.filter((url) => !leftOutUrls.has(url));
        if (known.length && !sendable.length) return { ok: false, error: `Not sent: read again just now, ${leftOut.join("; ")}. Leave it off; say nothing about it unless they ask.` };
        if (leftOut.length) did.push(`left out after a re-read: ${leftOut.join("; ").slice(0, 160)}`);
        // Things to send: each link, then its own caption, in tier order, the way
        // search results arrive (services/taskMessages.ts). A closing line last.
        if (sendable.length) {
          const items: SendItem[] = orderByTier(
            sendable.map((url) => {
              const ev = events.find((e) => e.url === url);
              const v = verified.find((x) => x.url === url);
              return ev
                ? { url, name: ev.name, tier: ev.tier, facts: ev.facts }
                : { url, name: v!.name, tier: 3, facts: [...v!.facts, ...(v!.date ? [`a date its page mentions: ${v!.date}`] : []), ...(v!.deadline ? [`deadline: ${v!.deadline}`] : [])] };
            }),
          );
          const draft = (fix?: string) => draftTaskMessages({ firstName: deps.person.first_name || "them", goal: task.goal, items, what, context: [facts.verified_page_facts, `their deadline: ${task.deadline ?? "none"}`].join(" | "), fix }).catch(() => null);
          // Every find this task holds: one named in a caption or the closing goes with its own link in this send, or not at all
          // (the tease rule, PR #59; Royce 2026-10-31: "stackable with Francisco San" went out after francisco san's caption was dropped).
          const finds = await unsentFinds();
          // What they said themselves backs a caption's numbers and places too (their budget, their target), as for a search find.
          const theirs = [task.theirWords ?? "", ...newestMemberLines(deps.recent, 50)].join(" ");
          const vet = (d: { captions: Map<string, string>; closing: string | null }) => {
            const good: { url: string; caption: string; name: string }[] = [];
            const dropped: string[] = [];
            for (const it of items) {
              const cap = d.captions.get(it.url);
              const verdict = cap ? captionOk(cap, `${it.name} ${it.facts.join(" ")}`, theirs) : { ok: false, why: "no caption" };
              if (cap && verdict.ok) good.push({ url: it.url, caption: cap, name: it.name });
              else dropped.push(`${it.name}: ${verdict.why}`);
            }
            // Leaving one out can leave another naming it, so this runs until nothing changes.
            const unsent = () => finds.filter((f) => !good.some((g) => g.url === f.url));
            for (let i = good.findIndex((g) => namedFinds(g.caption, unsent(), good).length); i >= 0; i = good.findIndex((g) => namedFinds(g.caption, unsent(), good).length)) {
              dropped.push(`${good[i].name}: names ${namedFinds(good[i].caption, unsent(), good).join(", ")}, whose link isn't going`);
              good.splice(i, 1);
            }
            let closing = d.closing;
            if (closing && chases(closing, asOfNow, { final })) closing = null;
            if (closing) {
              const allFacts = Object.values(facts).join(" ");
              const bad = checkDraft(closing, { maxSentences: 2, maxChars: 280 }).some((c) => !c.pass) || !numbersBacked(closing, allFacts).ok || !placesBacked(closing, allFacts).ok || OFFERS_WHAT_CO_CANT.test(closing) || namedFinds(closing, unsent(), good).length > 0;
              if (bad) closing = null;
            }
            return { good, dropped, closing };
          };
          const first = await draft();
          if (!first) return { ok: false, error: "Couldn't write the captions. Note it and schedule the next look." };
          let v = vet(first);
          // One redraft with what broke, so a caption that slipped (a number, another find's name) doesn't cost its link.
          if (v.dropped.length) {
            const again = await draft(v.dropped.join("; "));
            const w = again ? vet(again) : null;
            if (w && w.good.length >= v.good.length) v = w;
          }
          const { good, dropped: droppedCaptions, closing } = v;
          if (!good.length) return { ok: false, error: `No caption held up (${droppedCaptions.join("; ")}). Note it and schedule the next look.` };
          const messages = assembleMessages(good, closing);
          const whole = await wholeDelivery(messages);
          if (whole) return { ok: false, error: whole };
          const sent = await deps.send(messages, { owed: owed || task.source !== "lookout" });
          if (!sent.sent) return { ok: false, error: sent.reason?.startsWith("held:") ? held(sent) : `Couldn't send: ${sent.reason ?? "unknown"}.` };
          await deps.markTexted();
          await deps.note(`Texted them ${good.length} thing(s): ${good.map((g) => items.find((i) => i.url === g.url)?.name).join(", ")}${closing ? `, then: ${closing.slice(0, 120)}` : ""}${droppedCaptions.length ? ` (left out: ${droppedCaptions.join("; ")})` : ""}`, null);
          texts.push(...messages);
          did.push(`texted them ${good.length} link(s), each with its caption`);
          return { ok: true, sent: messages.join(" / ") };
        }
        let text = await draftProactive({
          functionId: "taskTurn.tell",
          firstName: deps.person.first_name || "them",
          facts,
          task: `${task.source === "promise" ? "Hand them what you promised, the way a friend would: the thing itself, never how you got it (no \"from the call\", nothing confirmed, verified or left off)." : "Tell them where this stands, in your own voice."} What to get across (a guide to your intent, not a source: state only what's in CONFIRMED_FACTS): ${what}. Don't put links in the text; they go right after it. Never offer to call, book, reserve or contact anyone for them, or to fill in, submit or apply for anything for them: you can't. No sign-off.`,
          maxSentences: 4,
        }).catch(() => null);
        if (!text) return { ok: false, error: "Nothing worth sending came out of the verified facts. Note it and schedule the next look." };
        // Rule 1 of the delivery shape (services/speakable.ts): no "Got it" for an ask that isn't seconds old.
        const shapeChecks = (t: string) => deliveryShapeProblems(t, { askedAt: new Date(task.createdAt), sendAt: deps.now() }).map((reason) => ({ name: "delivery_shape", pass: false, reason }));
        let failed = [...checkDraft(text, { maxSentences: 4, maxChars: 480 }).filter((c) => !c.pass), ...shapeChecks(text)];
        // One redraft with what broke, in code, so a long first draft doesn't use up
        // Co's steps (2026-09-30: three verified caterers found, nothing sent).
        if (failed.length) {
          const again = await draftAgain({ draft: text, failed: failed.map((f) => f.reason ?? f.name).join("; ") }, () =>
            draftProactive({ functionId: "taskTurn.tell", firstName: deps.person.first_name || "them", facts, task: `Tell them where this stands in at most 3 short sentences. What to get across (a guide, not a source: state only what's in CONFIRMED_FACTS): ${what}. No links in the text. Never offer to call, book, reserve or contact anyone for them, or to fill in, submit or apply for anything for them. No sign-off.`, maxSentences: 3 }),
          ).catch(() => null);
          if (again) {
            text = again;
            failed = [...checkDraft(text, { maxSentences: 4, maxChars: 480 }).filter((c) => !c.pass), ...shapeChecks(text)];
          }
        }
        if (failed.length) return { ok: false, error: `The draft broke a rule (${failed.map((f) => f.name).join(", ")}). Note it and schedule the next look.` };
        const nums = numbersBacked(text, Object.values(facts).join(" "));
        if (!nums.ok) return { ok: false, error: `The draft had numbers no verified fact backs (${nums.missing.join(", ")}). Tell them only verified facts.` };
        const places = placesBacked(text, Object.values(facts).join(" "));
        if (!places.ok) return { ok: false, error: `The draft named places no verified fact backs (${places.missing.join(", ")}). Tell them only verified facts.` };
        const offer = text.match(OFFERS_WHAT_CO_CANT);
        if (offer) return { ok: false, error: `The draft offered something Cue can't do ("${offer[0]}"): Cue can't call, book or contact anyone for them, or fill in, submit or apply for anything. Suggest they do it, or ask what they'd like next.` };
        if (inventedFailure(text)) return { ok: false, error: "Not sent: the draft says something is broken, failed or unavailable, and no check in your record says so. Leave that thing off and say nothing about it." };
        if (namesRejected(text)) return { ok: false, error: "Not sent: the draft names something Cue's daily pick rejected for them. Leave it off." };
        // A plain text carries no links, so it never names a find: a question, or saying plainly what can't be done, may go, but one
        // that names something found (a question too: "Want me to start the Francisco San form?", Royce 2026-10-31) is a tease
        // without its answer (PR #59), and waits for the message that carries the link.
        const named = namedFinds(text, await unsentFinds());
        if (named.length) return { ok: false, error: `Not sent: it names ${named.slice(0, 2).join(", ")} without the link. A find goes as its link, then its caption: send it with tellThem and the links, or leave it unnamed.` };
        if (!final && progressReport(text, [...events.map((e) => e.name), ...verified.map((v: any) => v.name ?? "")])) return { ok: false, error: "Not sent: the draft is a progress report (nothing yet). Say nothing until you have the thing itself; note it and schedule your next look." };
        const chase = chases(text, asOfNow, { final });
        if (chase) return { ok: false, error: `Not sent: ${chase}. Wait for them; their reply wakes this task.` };
        const sent = await deps.send([text], { owed });
        if (!sent.sent) return { ok: false, error: sent.reason?.startsWith("held:") ? held(sent) : `Couldn't send: ${sent.reason ?? "unknown"}.` };
        await deps.markTexted();
        await deps.note(`Texted them: ${text.slice(0, 200)}`, null);
        texts.push(text);
        did.push("texted them");
        return { ok: true, sent: text };
  };

  const tools = {
    search: tool({
      description:
        "Look up events for this task: Noise's own events and the public feed, in the days you name, plus openings Cue's daily search already found. You get real events with their details, closest to what you asked first, and you judge which fit, because they're candidates, not answers. Put `when` in their words (\"this weekend\", \"Oct 10\") so the dates come out right. The feed is short (a few events a day), so when it's thin, use webSearch for the same thing.",
      inputSchema: z.object({ what: z.string(), when: z.string().optional() }),
      execute: async ({ what, when }) => {
        did.push(`search: ${what}${when ? `, ${when}` : ""}`);
        const items = await deps.search(what, when ?? null).catch(() => []);
        for (const i of items) if (!isRejected(i.name) && !events.some((e) => e.name === i.name)) events.push({ name: i.name, url: i.url, facts: [...(i.date ? [`date: ${i.date}`] : []), ...(i.details ?? []).slice(0, 4)], tier: i.tier ?? 2 });
        return items.length ? { found: items } : { found: [], note: "Nothing real came up." };
      },
    }),
    webSearch: tool({
      description: "Search the whole web for anything the task needs that isn't an event: venues, vendors, prices, people, how-tos, programs. One plain sentence of what to find. Every result is checked against its own page; only its listed facts are verified.",
      inputSchema: z.object({ what: z.string() }),
      execute: async ({ what }) => {
        if (did.filter((d) => d.startsWith("web:")).length >= 3) return { found: [], note: "That's the web searches for this wake-up. Work with what you have, note it, and schedule the next look." };
        did.push(`web: ${what}`);
        const r = await deps.web(what);
        for (const k of r.kept) if (!isRejected(k.name) && !verified.some((v) => v.url === k.url)) verified.push(k);
        return { found: r.kept.map((k) => ({ name: k.name, url: k.url, official: k.official, verifiedFacts: k.facts, date: k.date, deadline: k.deadline })), droppedBecause: r.dropped.map((d) => `${d.name}: ${d.why}`), note: r.note };
      },
    }),
    readPage: tool({
      description: "Read a web page (a link from the search, their words, or your notes) and get what it says.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        did.push(`read: ${url}`);
        const r = await deps.readPage(url).catch(() => ({ ok: false, facts: [] as string[], text: "" }));
        pageFacts.push(...r.facts);
        return { ok: r.ok, verifiedFacts: r.facts, pageText: r.text.slice(0, 2500) };
      },
    }),
    note: tool({
      description: "Write down what you learned or did, in one or two plain sentences. When you finished a step, set stepDone to that step's exact text.",
      inputSchema: z.object({ text: z.string(), stepDone: z.string().optional() }),
      execute: async ({ text, stepDone }) => {
        // The send step of a promise is done only when the send really happened after it (same check as closing it).
        if (stepDone && task.source === "promise" && /^\s*(?:send|write)\b/i.test(stepDone)) {
          const kept = await promiseCloseCheck(task, texts, deps, docsSent);
          if (!kept.ok) {
            await deps.note(text, null);
            did.push(`note: ${text.slice(0, 120)} [step not marked: nothing sent after the promise]`);
            return { ok: true, stepNotMarked: kept.why };
          }
        }
        await deps.note(text, stepDone ?? null);
        did.push(`note: ${text.slice(0, 120)}${stepDone ? ` [done: ${stepDone.slice(0, 60)}]` : ""}`);
        return { ok: true };
      },
    }),
    tellThem: tool({
      description: "Text them what you found or ask what only they can answer. Say what it should get across; it's written in your voice from verified results only.",
      inputSchema: z.object({ what: z.string().describe("What the text should get across, plainly."), links: z.array(z.string()).max(4).optional().describe("Links from verified results or on file to send with it. A promise goes in one message, so put every link it needs in this one call.") }),
      execute: async ({ what, links }) => tell(what, links),
    }),
    scheduleNext: tool({
      description: `When to work on this next, in hours from now (${TASK_LIMITS.minHours} to ${TASK_LIMITS.maxHours}), and what you'll do then.`,
      inputSchema: z.object({ inHours: z.number(), plan: z.string() }),
      execute: async ({ inHours, plan }) => {
        const at = await deps.schedule(inHours, plan);
        nextAt = at ? new Date(at) : new Date(deps.now().getTime() + clampNextHours(inHours) * 3_600_000);
        decided = "scheduled";
        did.push(`next in ${clampNextHours(inHours)}h: ${plan.slice(0, 100)}`);
        return { ok: !!at, nextCheckAt: at };
      },
    }),
    finish: tool({
      description: "Close the task: done, or they no longer need it. For a drop because they said so, put their exact words in theirWords; a drop without their word counts as a promise Cue didn't keep.",
      inputSchema: z.object({ outcome: z.string(), status: z.enum(["done", "dropped"]), theirWords: z.string().optional() }),
      execute: async ({ outcome, status, theirWords }) => {
        if (status === "done") {
          const kept = await promiseCloseCheck(task, texts, deps, docsSent);
          if (!kept.ok) {
            did.push(`finish refused: ${kept.why.slice(0, 100)}`);
            return { ok: false, error: `Not closed: ${kept.why}. Do what you said now and send it, or tellThem plainly where it stands, then scheduleNext. Close it as dropped only if they no longer want it.` };
          }
        }
        // Their word only when it's really in their newest lines (quoteIsTheirs), never Co's say-so.
        const theirWord = theirWords && quoteIsTheirs(theirWords, newestMemberLines(deps.recent, 6)) ? theirWords : null;
        await deps.close(status, outcome, theirWord);
        decided = "finished";
        did.push(`finished (${status}): ${outcome.slice(0, 100)}`);
        return { ok: true };
      },
    }),
    // Texting's own document tool (the same input and registry entry, agent/loopTools.ts writeDocument; the same pipeline,
    // services/documentDelivery.ts), so a promised plan or doc arrives as a document, never a wall of text.
    writeDocument: tool({
      description: toolUse("writeDocument"),
      inputSchema: WRITE_DOCUMENT_INPUT,
      execute: async (input) => {
        if (!deps.writeDocument) return { ok: false, error: "Documents can't be sent from here. Note it and schedule the next look." };
        if (docsSent.length) return { ok: false, error: "You already sent the document this wake-up." };
        // What Co read this wake-up can back a place or event in its own suggestions; never a claim about them.
        const read = [verifiedFactLines(verified).join("\n"), events.map((e) => `${e.name} ${e.facts.join(" ")}`).join("\n"), pageFacts.join("\n")].join("\n");
        const r = await deps.writeDocument(input, { read }).catch((err: any) => ({ ok: false as const, why: `it didn't go out (${String(err?.message ?? err).slice(0, 80)})` }));
        if (!r.ok) {
          did.push(`document not sent: ${r.why.slice(0, 140)}`);
          // Their quiet hours (9pm to 8am): the next look is their 8am, set here, not left to the model's arithmetic.
          const quietUntil = "nextAt" in r ? r.nextAt : undefined;
          // Held for pacing (a Co look-out's document): the same hold as a held text, and the wake given back.
          if (quietUntil && /^Not sent: held:/.test(r.why) && (!heldUntil || quietUntil > heldUntil)) heldUntil = quietUntil;
          if (quietUntil && deps.scheduleAt) {
            await deps.scheduleAt(quietUntil, /^Not sent: held:/.test(r.why) ? "Send the document now if it still holds: it was held for pacing." : "Send the document you promised: it was ready during their quiet hours.");
            nextAt = quietUntil;
            decided = "scheduled";
          }
          return { ok: false, error: r.why };
        }
        docsSent.push(r.title);
        did.push(`sent a document: ${r.title} (${r.via})`);
        await deps.note(`Sent them the document "${r.title}" (${r.via === "pdf_text" ? "a PDF in their thread" : r.via}).`, null);
        return { ok: true, note: "It's sent, with its one line. If it's what you promised, finish the task as done. Don't text about it or its contents: the delivery is complete." };
      },
    }),
  };

  try {
    await generateText({
      model: anthropic(TASK_MODEL),
      maxOutputTokens: 6000,
      providerOptions: { anthropic: { effort: "medium" } },
      experimental_telemetry: { isEnabled: true, functionId: "taskTurn.run" },
      tools,
      stopWhen: [stepCountIs(12), () => decided !== null],
      prompt: taskTurnPrompt({ task, firstName: deps.person.first_name || "them", now: localStamp(deps.now(), deps.zone), zone: deps.zone, recent: deps.recent, final, person: deps.personModel, knowledge: deps.knowledge, rules: deps.rules, onFile: events.filter((e) => e.onFile && e.url) as OnFile[] }),
    });
  } catch (err: any) {
    console.error("taskTurn failed (non-fatal):", err?.message ?? err);
  }
  // A promised document that went out keeps the promise: the commitment closes itself (task, window, open loop), even if Co
  // didn't say finish.
  if (decided !== "finished" && task.source === "promise" && docsSent.length) {
    const kept = await promiseCloseCheck(task, texts, deps, docsSent);
    if (kept.ok) {
      await deps.close("done", `Kept: sent the document "${docsSent[0].slice(0, 120)}".`);
      decided = "finished";
      did.push("finished (done): the promised document went out");
    }
  }
  // The last check before their deadline never goes quiet: if Co didn't tell them,
  // code does, from what's verified, even when that's "nothing real yet".
  if (final && !texts.length) {
    const r = await tell("Be straight about where this stands before their deadline: what you found that's real, or plainly that nothing real turned up yet, and what, if anything, you'll still do.");
    did.push(r.ok ? "final check: told them where it stands" : `final check: couldn't tell them (${"error" in r ? r.error : "unknown"})`);
  }
  if (final && texts.length) await deps.markFinalTold();
  // Co didn't decide: look again tomorrow rather than leave it hanging.
  if (!decided) {
    const at = await deps.schedule(24, task.planNext ?? "Pick up where I left off.");
    nextAt = at ? new Date(at) : new Date(deps.now().getTime() + 24 * 3_600_000);
  }
  // A last check that landed outside their hours couldn't tell them: it runs again at their next allowed hour, never 24 hours later
  // at the same blocked hour (review of the door, 2026-10-12: a zone learned after the check was set kept it blocked every day).
  if (final && !texts.length && !localHourOk(deps.now(), deps.zone) && deps.scheduleAt) {
    const open = nextSendable(deps.now(), deps.zone);
    await deps.scheduleAt(open, "Your last check landed outside their hours: tell them now where it stands.");
    nextAt = open;
    did.push(`final check: outside their hours, moved to ${localStamp(open, deps.zone)}`);
  }
  // Held: whatever the turn scheduled, the next look waits for the hold (review of #129: an hourly retry under a 24h pause ran a
  // task out of wakes undelivered), and a wake that could only be held doesn't count against the task.
  // set inside tell(), which TypeScript doesn't follow; never past the last check before their deadline (re-review of #129)
  const hold = heldUntil ? capToFinal(heldUntil as Date, task).at : null;
  if (hold && !texts.length && decided !== "finished") {
    if (!nextAt || nextAt < hold) {
      if (deps.scheduleAt) await deps.scheduleAt(hold, task.planNext ?? "A text was held for pacing: send it now if it still holds.");
      nextAt = hold;
    }
    await deps.unspendWake?.();
    did.push(`held for pacing; next look ${hold.toISOString()}`);
  }
  // The window (services/memberTime.ts): a turn that ends without the deliverable, whose next check would land past the last
  // moment Co can still tell them, tells them now, in one plain line with the new time. Event-driven: the end of this turn is the
  // trigger, never a poll.
  let warning: string | null = null;
  // Co texted them itself this turn and the next check still lands past the window: they've heard where it stands, so the window
  // moves (marked told) without a second line, and a later wake doesn't warn about the old one again.
  if (decided !== "finished" && texts.length && !docsSent.length && task.window && !task.window.closedAt && missesWindow(task.window, nextAt ?? new Date(deps.now().getTime() + 24 * 3_600_000), deps.now()) && !(task.window.warnedFor ?? []).includes(task.window.deadline)) {
    const re = rescheduledWindow(nextAt ?? new Date(deps.now().getTime() + 24 * 3_600_000), deps.now(), deps.zone, task.window);
    await deps.setWindow?.(re.window);
    did.push(`window: told in the turn's own text; moved to ${re.when}`);
    await logSlip(task, `told them in the task's own text; moved from ${task.window.words} to ${re.when}`, re.window.deadline);
  }
  // No "not yet" text when the window will be missed (Royce, 2026-10-08: progress reports are forbidden; silence until there's
  // something real, then one message). The window moves quietly to the next check, and the delivery, when it lands, says what
  // they asked for and when (services/speakable.ts deliveryLine).
  // One exception (Royce, 2026-10-13): a goal piece whose slip strands them before a dated moment they're counting on gets one text,
  // once per slip, through the paced task-update path (slipException below).
  const strandText = decided !== "finished" && !texts.length && !docsSent.length && task.window && !task.window.closedAt && missesWindow(task.window, nextAt ?? new Date(deps.now().getTime() + 24 * 3_600_000), deps.now())
    ? await slipException(task, nextAt ?? new Date(deps.now().getTime() + 24 * 3_600_000), deps).catch(() => null)
    : null;
  if (strandText) {
    warning = strandText;
    did.push(`window: slip would strand them before their moment; told them once: "${strandText.slice(0, 120)}"`);
  } else if (decided !== "finished" && !texts.length && !docsSent.length && task.window && !task.window.closedAt && missesWindow(task.window, nextAt ?? new Date(deps.now().getTime() + 24 * 3_600_000), deps.now())) {
    const re = rescheduledWindow(nextAt ?? new Date(deps.now().getTime() + 24 * 3_600_000), deps.now(), deps.zone, task.window);
    await deps.setWindow?.(re.window);
    if (deps.scheduleAt) await deps.scheduleAt(re.checkAt, `You told them ${task.window.words}; it moves to ${re.when}. Do the work and send it then: one message with the thing itself.`);
    did.push(`window: moved quietly to ${re.when}, no "not yet" text`);
    await logSlip(task, `moved quietly from ${task.window.words} to ${re.when}`, re.window.deadline);
  }
  // Found and checked this turn: stamped, so a later turn knows how old they are (Phase B, B5).
  const checkedAt = deps.now().toISOString();
  const found: OnFile[] = [...events.filter((e) => e.url && !e.onFile).map((e) => ({ name: e.name, url: e.url!, tier: e.tier ?? 2, facts: e.facts, checkedAt })), ...verified.map((v) => ({ name: v.name, url: v.url, tier: 3, facts: v.facts, checkedAt }))];
  if (found.length) await deps.saveFound?.(found).catch(() => {});
  return { action: decided ?? "defaulted_24h", did, texts, final, warning };
}

// The slip exception: a goal piece (services/goalOwnership.ts) whose new time lands after, or too close to, the dated moment they're
// counting on. Code decides it strands them (slipStrands); one Haiku read confirms the piece is needed for that moment (a failed read
// counts as needed). Then the existing miss line (warnIfWindowMissed: what isn't there yet and the new time, checked, once per window)
// goes through the paced task-update path, keyed to this slip so it can only go once, and its window moves. Returns the text, or null
// when it stays quiet (no moment, not stranded, not needed, already told, or held by pacing).
export async function slipException(task: CoTask, nextAt: Date, deps: TaskTurnDeps): Promise<string | null> {
  const moment = task.followup?.goalMoment;
  if (task.followup?.goalId == null || !moment || !task.window || task.window.closedAt) return null;
  if ((task.window.warnedFor ?? []).includes(task.window.deadline)) return null;
  const G = await import("./goalOwnership.js");
  const re = rescheduledWindow(nextAt, deps.now(), deps.zone, task.window);
  if (!G.slipStrands(new Date(re.window.deadline), moment, deps.zone, deps.now())) return null;
  const need = deps.pieceNeeded ? await deps.pieceNeeded(task.goal, String(task.followup?.goalTitle ?? ""), moment) : await G.pieceNeededFor(task.goal, String(task.followup?.goalTitle ?? ""), moment);
  if (!need.needed) return null;
  const key = `task:${task.id}:slip:${task.window.deadline}`;
  const r = await warnIfWindowMissed(task, task.window, nextAt, { ...deps, warn: async (text) => { const s = await deps.send([text], { owed: false, key }); return { sent: s.sent, reason: s.reason }; } });
  if (!r.sent || !r.text) return null;
  await logSlip(task, `stranded them before "${moment.words}" (${moment.date}): told them once, moved to ${re.when}${need.read ? "" : " (needed-read unavailable, counted as needed)"}`, re.window.deadline);
  return r.text;
}

// A commitment's window moved past its time: logged as a slip (services/commitmentLog.ts), never a text of its own. Only on a real
// wake (a dry turn has no user to log against).
async function logSlip(task: CoTask, why: string, newDeadline: string): Promise<void> {
  const L = await import("./commitmentLog.js");
  if (task.userId && L.isCommitment(task)) await L.logCommitment("slipped", { userId: task.userId, taskId: task.id, goalId: task.followup?.goalId ?? null, why, fireAt: newDeadline, what: task.goal, source: task.source ?? null });
}

// A text that only says the thing isn't there yet (2026-10-08, Royce's call: "No luck yet...", "Nothing solid for this weekend yet").
export const NOTHING_YET = /\b(?:no luck(?: yet| so far| on)?|nothing (?:solid|real|verified|good|worth \w+)?(?:\s+[\w']+){0,4}?\s+(?:yet|so far)|no (?:details|results|news|update|word) yet|haven'?t (?:found|got|turned up) (?:anything|it|them|much)(?: yet)?|still digging|(?:i'?ll|you'?ll|will) have (?:it|them|that) (?:for you |to you )?(?:by )?(?:tomorrow|in the morning|tonight|later|soon))\b/i;
// Pure: a text that delivers nothing and only says it isn't there yet. One that carries a link, or names something Co found, is
// a delivery even if it also says part of it is still to come (review of #115: "Found it: ... Still on it for Sunday").
export function progressReport(text: string, found: string[] = []): boolean {
  if (!NOTHING_YET.test(text)) return false;
  if (/https?:\/\/|\b[\w-]+\.(?:com|co|org|net|io|ma|me)\//i.test(text)) return false;
  const lower = text.toLowerCase();
  return !found.some((n) => n && n.length >= 4 && lower.includes(n.toLowerCase().slice(0, 24)));
}

const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Pure: is this task text one the member is owed? The first result of something they asked for or Co promised them, the last
// check before their own deadline, or an answer to them. Everything else a task sends (updates, follow-ups, anything from a
// lookout Co started itself) is Co-initiated, and waits on spacing, pace and backoff like every text Co sends first
// (issue #126; Royce, 2026-10-09: "only an owed delivery stays exempt").
export function owedText(t: Pick<CoTask, "lastTextedAt" | "theirReplyAt" | "source"> & Partial<Pick<CoTask, "finalCheckAt" | "finalTold">>, now: Date): boolean {
  if (t.source !== "lookout" && !t.lastTextedAt) return true;
  if (isFinalCheck(t, now)) return true;
  return awaitingThem(t) === false && !!t.theirReplyAt;
}
// Pure: Co's last task text has no reply from them yet.
export function awaitingThem(t: Pick<CoTask, "lastTextedAt" | "theirReplyAt">): boolean {
  if (!t.lastTextedAt) return false;
  return !t.theirReplyAt || new Date(t.theirReplyAt).getTime() <= new Date(t.lastTextedAt).getTime();
}
// Chasing (Royce, 2026-10-09: "no chasing"): bumping an unanswered text. Never sent, whatever else it says.
export const CHASE = /\b(?:circling back|circle back|bumping (?:this|it|that)|just (?:following|checking) (?:up|back|in)|following up (?:again|on (?:my|this|that|the) (?:last|earlier|previous|text|message|question))|checking (?:back )?in again|in case you missed|did you (?:get|see) my (?:last|earlier|previous)|any (?:thoughts|word|update) on (?:my|the) (?:last|earlier|previous))\b/i;
// Pure: why a task text would chase them, or null. A question while their answer to the last one is still pending re-asks it:
// their reply wakes the task, so the task waits for it instead.
export function chases(text: string, t: Pick<CoTask, "lastTextedAt" | "theirReplyAt">, o: { final?: boolean } = {}): string | null {
  if (CHASE.test(text)) return "it chases them for an answer";
  // The last check before their deadline may ask what they want next; that's where it stands, not a re-ask.
  if (!o.final && awaitingThem(t) && /\?/.test(text)) return "it asks again while your last text to them has no reply";
  return null;
}

// Pure: the restraint kind a task's Co-initiated text counts as. A look-out from Co's own promise sends finds; one they asked for
// sends deliveries, which never count toward backoff; other task updates have no kind.
export function lookoutKind(t: Pick<CoTask, "source" | "lookoutOrigin">): "find" | null {
  return t.source === "lookout" && t.lookoutOrigin !== "member" ? "find" : null;
}

export { FAILURE_CLAIM, inventedFailure } from "./speakable.js";
import { inventedFailure } from "./speakable.js";

// ---------------------------------------------------------------- the miss warning

// Pure: the thing Co promised, out of its own sentence ("I'll text you the options tonight" -> "the options").
export function promisedThing(goal: string): string {
  const s = goal.replace(/^(?:Keep your word from the call|Keep your promise):\s*/i, "").replace(/^"|"$/g, "");
  const m = s.match(/\b(?:text|send|put together|pull together|write up|draft|share|drop|shoot|forward|get|find|line up|dig up|have)\s+(?:you\s+|over\s+|them\s+)?(.+?)(?=\s+(?:to you|for you|over|tonight|today|tomorrow|this \w+|later|in (?:an?|one|the|\d+|a few)\b|by\b|right after|after\b|before\b|once\b|when\b|so\b|and (?:text|send)\b|on (?:mon|tue|wed|thu|fri|sat|sun))|[,.;!?]|$)/i);
  const t = (m?.[1] ?? "").trim();
  if (!t || /^(?:what|whatever|it|that|this|something)\b/i.test(t) || t.split(/\s+/).length > 9) return "it";
  return t.replace(/^(?:a few|some|a couple of|a couple|three|two|four|five)\s+/i, "the ");
}

const TIME_WORDS = /\b(?:in the morning|tomorrow|tonight|this (?:morning|afternoon|evening)|by \d{1,2}(?::\d\d)?\s?(?:am|pm)|\d{1,2}(?::\d\d)?\s?(?:am|pm)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon)\b/i;

// Pure: what a miss warning must be: one or two plain sentences that say what isn't there yet and the new time, in the voice
// standard (services/speakable.ts narration, harness/proactive.ts checkDraft). The usual "no promise of a later action" rule is
// the one exception, as for the after-call confirmation: this line IS the new promise, and the task keeps it.
// alsoNames: their own words for it ("private dining rooms" for Co's "the options"): naming it either way counts.
const NOT_A_THING = new Set(["your", "them", "those", "these", "some", "with", "from", "that", "this", "about", "after", "their", "there", "would", "could", "want", "find", "need", "something", "anything", "please", "maybe", "really", "just"]);
export function warningChecks(text: string, o: { thing: string; when: string; alsoNames?: string }): GateCheck[] {
  const base = checkDraft(text, { maxSentences: 2, maxChars: 220 }).filter((c) => !(c.name === "draft_forbidden" && /promise of a later action/.test(c.reason ?? "")));
  const lower = text.toLowerCase();
  const wordsOf = (s: string, min: number) => (s.toLowerCase().match(/[a-z][a-z'-]+/g) ?? []).filter((w) => w.length >= min && !NOT_A_THING.has(w));
  const thingWords = wordsOf(o.thing, 4);
  const namesIt = !thingWords.length || [...thingWords, ...wordsOf(o.alsoNames ?? "", 5)].some((w) => lower.includes(w.slice(0, 5)));
  return [
    ...base,
    { name: "warning_new_time", pass: lower.includes(o.when.toLowerCase()) || TIME_WORDS.test(text), reason: `doesn't say when they'll have it (${o.when})` },
    { name: "warning_names_it", pass: namesIt, reason: `doesn't say what isn't there yet (${o.thing})` },
    { name: "warning_no_question", pass: !/\?/.test(text), reason: "asks a question; the line tells them where it stands" },
    { name: "warning_no_preamble", pass: !/^\s*(?:(?:a )?quick |small |just an? )?(?:update|heads[- ]up|fyi|status)\b/i.test(text), reason: "opens on a status preamble (\"quick update\", \"heads up\"); say the thing" },
  ];
}

// Pure: the line in plain words when no draft holds up. Better than going quiet on a window.
export function fallbackWarning(thing: string, when: string, doc: boolean): string {
  const plural = /s$/i.test(thing) && !/\b(?:this|plan|brief|analysis)$/i.test(thing);
  const pron = thing === "it" ? "it" : plural ? "them" : "it";
  if (doc) return `${thing === "it" ? "The document" : thing[0].toUpperCase() + thing.slice(1)} isn't finished yet, I'll have it to you ${when}.`;
  return thing === "it" ? `No luck yet, I'll have it for you ${when}.` : `No luck on ${thing} yet, I'll have ${pron} for you ${when}.`;
}

export function warningTask(): string {
  return `You told them they'd have something by a time (window_words), and it won't be ready then. Text them one plain line, before that time passes: what they don't have yet and when they will (new_time, in those words). The shape, not the words: "No luck on the rooms yet, I'll have them for you in the morning." One or two short sentences. No preamble ("quick update", "heads up"). Never narrate your own process ("working on it", "still looking", "a few leads", "in progress", "nothing solid enough"), no apology, no question, no sign-off.`;
}

// Sends the warning when a turn ends without the deliverable and the next check would land past the warn-by (or the warn-by
// has passed). Once per window (the send key is the window's deadline, and the window remembers it was warned). Inside their
// hours only: past 8pm their time it moves the next check to their morning and warns then if it's still not done.
export async function warnIfWindowMissed(task: CoTask, w: CommitWindow, nextAt: Date, deps: TaskTurnDeps): Promise<{ sent: boolean; text?: string; what?: string }> {
  const now = deps.now();
  if (!missesWindow(w, nextAt, now)) return { sent: false };
  if ((w.warnedFor ?? []).includes(w.deadline)) return { sent: false, what: "window: already warned for this window" };
  // A window a warning just set ("in the morning"), reached before it opens (they replied at 9pm): the work is held to its
  // start, not warned about a second time.
  if (w.startsAt && now.getTime() < new Date(w.startsAt).getTime()) {
    if (deps.scheduleAt) await deps.scheduleAt(new Date(w.startsAt), `You told them ${w.words}: send it then, or say plainly what you found.`);
    return { sent: false, what: `window: held to its start, ${localStamp(w.startsAt, deps.zone)}` };
  }
  const kept = await promiseCloseCheck(task, [], deps);
  if (task.source === "promise" && kept.ok) return { sent: false, what: "window: already kept" };
  if (!sendableAt(now, deps.zone)) {
    const morning = nextSendable(now, deps.zone);
    if (deps.scheduleAt) await deps.scheduleAt(morning, "Their window passed outside their hours: do the work and send it, or tell them plainly where it stands and when they'll have it.");
    return { sent: false, what: `window: outside their hours, next check moved to ${localStamp(morning, deps.zone)}` };
  }
  const re = rescheduledWindow(nextAt, now, deps.zone, w);
  const thing = promisedThing(task.goal);
  const doc = wantsDocument(task.goal, task.theirWords);
  const facts = { what_you_promised: task.goal.replace(/^(?:Keep your word from the call|Keep your promise):\s*/i, ""), window_words: w.words, what_isnt_there_yet: thing, new_time: re.when, their_local_time: localStamp(now, deps.zone) };
  const bad = (t: string) => warningChecks(t, { thing, when: re.when, alsoNames: task.theirWords }).filter((c) => !c.pass);
  let text: string | null = null;
  const draft = deps.draftWarning ?? defaultDraftWarning(deps.person.first_name || "them");
  const first = await draft(facts).catch(() => null);
  if (first && !bad(first).length) text = first;
  else if (first) {
    const second = await draft(facts, { draft: first, failed: bad(first).map((c) => c.reason ?? c.name).join("; ") }).catch(() => null);
    if (second && !bad(second).length) text = second;
  }
  text ??= fallbackWarning(thing, re.when, doc);
  const r = deps.warn ? await deps.warn(text, `task:${task.id}:window:${w.deadline}`).catch((err: any) => ({ sent: false, reason: String(err?.message ?? err) })) : { sent: false, reason: "no send path" };
  if (!r.sent && r.reason !== "already sent") return { sent: false, what: `window: warning not sent (${r.reason ?? "unknown"})` };
  await deps.setWindow?.(re.window);
  if (deps.scheduleAt) await deps.scheduleAt(re.checkAt, `You told them ${re.when}: send it then, or say plainly what you found.`);
  await deps.note(`Told them it'll be ${re.when}: "${text.slice(0, 200)}"`, null);
  return { sent: r.sent, text: r.sent ? text : undefined, what: `window: told them it moves to ${re.when}` };
}

function defaultDraftWarning(firstName: string): NonNullable<TaskTurnDeps["draftWarning"]> {
  return (facts, redo) => {
    const run = () => draftProactive({ functionId: "taskTurn.windowWarning", firstName, facts, task: warningTask(), maxSentences: 2 });
    return redo ? draftAgain(redo, run) : run();
  };
}

// A real wake-up: the database, the web budget, and texts to their phone.
// opts.now: a pinned clock for a live check (evals/tasks/windowsLive.ts); the real time otherwise. It drives the turn's own
// sense of now, the window math and the hours checks of its sends.
// What's on file and verified for them: this task's own earlier results, then the sweep's finds (event backlogs, which passed
// its gate and page checks). Newest task results first; one entry per link.
async function onFileFor(userId: string, task: CoTask): Promise<OnFile[]> {
  // Only finds for asks still open (or goal finds), and never anything already past in their day (review of #117).
  const { ASK_STILL_OPEN, isPastEvent } = await import("./eventSurfacingSweep.js");
  const zone = await import("./memberTime.js").then((m) => m.memberZone(userId)).catch(() => null);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: zone ?? "America/Los_Angeles" });
  const pastFact = (f: OnFile) => f.facts.some((x) => { const d = x.match(/^date: (\d{4}-\d{2}-\d{2})/)?.[1]; return !!d && d < today; });
  const own: OnFile[] = (Array.isArray((task as any).followup?.found) ? (task as any).followup.found : []).filter((f: OnFile) => f?.url && !pastFact(f));
  const { rows } = await pool.query(`SELECT items FROM event_backlogs b WHERE b.user_id = $1 AND ${ASK_STILL_OPEN("b.ask_id")}`, [userId]).catch(() => ({ rows: [] as any[] }));
  const swept: OnFile[] = rows
    .flatMap((r: any) => (Array.isArray(r.items) ? r.items : []))
    // A held find (its date isn't known yet, services/workingSet.ts) is never sent as on file.
    .filter((it: any) => !it?.unread)
    .map((it: any) => it?.match)
    .filter((m: any) => m?.url && m?.name && !isPastEvent(m, zone))
    .map((m: any) => ({
      name: String(m.name),
      url: String(m.url),
      tier: Number(m.tier ?? 2),
      facts: [m.event_date ? `date: ${String(m.event_date).slice(0, 10)}` : null, m.details?.startAt ? `starts ${String(m.details.startAt).replace("T", " ").slice(0, 16)}` : null, m.details?.venue ?? m.city ?? null].filter(Boolean) as string[],
      checkedAt: typeof m.checkedAt === "string" && m.checkedAt ? m.checkedAt : null,
    }));
  const out: OnFile[] = [];
  for (const f of [...own, ...swept]) if (f?.url && !out.some((x) => x.url === f.url)) out.push(f);
  return out.slice(0, 20);
}

// Names Co's latest daily pick rejected for them (services/sweepShadow.ts; empty for anyone the picker doesn't run for). A reject the
// guard held for not citing the closed or known record it claimed is a hold, not listed here: the find is still live.
async function pickerRejected(userId: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT proposal FROM harness_decisions WHERE decision = 'sweep.select.shadow' AND user_id = $1 AND outcome = 'act' ORDER BY created_at DESC LIMIT 1`, [userId]).catch(() => ({ rows: [] as any[] }));
  const js = (rows[0]?.proposal?.judgments ?? []) as { name?: string; verdict?: string }[];
  return js.filter((j) => j.verdict === "reject" && j.name).map((j) => String(j.name));
}

// This turn's verified results, kept on a work task for its next turn (followup.found; a follow-up task's followup is its own).
async function saveTaskFound(userId: string, taskId: number, items: OnFile[]): Promise<void> {
  // Newest first, one per link, at most 15 (review of #117: the list grew without bound and lost its order).
  const { rows } = await pool.query(`SELECT followup->'found' AS found FROM co_tasks WHERE user_id = $1 AND id = $2 AND kind = 'work'`, [userId, taskId]);
  if (!rows.length) return;
  const merged: OnFile[] = [];
  for (const f of [...items, ...(Array.isArray(rows[0].found) ? rows[0].found : [])]) if (f?.url && !merged.some((x) => x.url === f.url)) merged.push(f);
  await pool.query(`UPDATE co_tasks SET followup = jsonb_set(COALESCE(followup, '{}'::jsonb), '{found}', $3::jsonb, true), updated_at = NOW() WHERE user_id = $1 AND id = $2 AND kind = 'work'`, [userId, taskId, JSON.stringify(merged.slice(0, 15))]);
}

// Every model call inside is this member's in llm_usage (services/llmUsage.ts withMember, cost per member 2026-10-23).
export async function runTaskTurn(...a: Parameters<typeof runTaskTurnInScope>): ReturnType<typeof runTaskTurnInScope> {
  return withMember(a[0].userId, () => runTaskTurnInScope(...a));
}
async function runTaskTurnInScope(task: CoTask, opts: { now?: () => Date; override?: Partial<TaskTurnDeps> } = {}): Promise<{ action: string; did?: string[]; warning?: string | null }> {
  const userId = task.userId;
  const clock = opts.now ?? (() => new Date());
  if (isExhausted(task, clock())) {
    await closeTask(userId, task.id, "expired", "Ran out of wake-ups or days.");
    await recordDecision({ layer: 7, decision: "task.wake", userId, outcome: "skip", action: "expired", proposal: { taskId: task.id } }).catch(() => {});
    return { action: "expired" };
  }
  const { rows: u } = await pool.query(`SELECT u.first_name, u.phone_number, u.sms_opted_out, u.archived_at, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [userId]);
  const person = u[0];
  if (!person || person.sms_opted_out || person.archived_at) {
    await closeTask(userId, task.id, "dropped", "Member opted out or archived.");
    return { action: "dropped" };
  }
  // What Co knows about them, one read (services/memberKnowledge.ts): their zone, the stamped thread, the person model, what they
  // already have, what else Co carries, asks, corrections, lessons, taste, claims, restraint. Another member's details are
  // stripped inside it, and it fails closed (no names read, no knowledge). Goals aren't read here: the task is the goal.
  // A rejection (the member-name read failed) means no member context this turn, never an unstripped fallback: the turn runs on
  // the task alone, its zone read on its own (services/memberTime.ts memberZone, the same source identity uses).
  const k = await memberKnowledge(userId, { now: clock(), exchanges: 14, exchangeDays: 30, include: ["exchanges", "person", "delivered", "carrying", "asks", "lessons", "corrections", "preferences", "claims", "restraint"] }).catch((err: any) => {
    console.error("taskTurn: member knowledge unavailable, going without member context (non-fatal):", err?.message ?? err);
    return null;
  });
  const zone = k ? k.identity.zone : await memberZone(userId).catch(() => null);
  const deps: TaskTurnDeps = {
    person,
    zone,
    recent: k ? exchangeText(k.exchanges, (at) => localStamp(at, zone)).slice(-3000) : "",
    personModel: k?.person?.text || undefined,
    knowledge: (k && taskKnowledge(k, { taskId: task.id, zone })) || undefined,
    rules: k ? taskRules(memberRules(k), k) : undefined,
    // Their live away claim, from the same read (services/away.ts).
    away: k ? awayFromClaims(k.claims, clock(), zone ?? undefined) : null,
    note: async (text, stepDone) => void (await noteOnTask(userId, task.id, text, stepDone)),
    schedule: async (h, plan) => (await scheduleTask(userId, task.id, h, plan))?.nextCheckAt ?? null,
    scheduleAt: async (at, plan) => (await scheduleTaskAt(userId, task.id, at, plan))?.nextCheckAt ?? null,
    // Completion closes its own loop: the task (and its window, coTasks.ts closeTask), then the open loop that mirrors it, now
    // rather than on the next 15-minute sync (services/openLoops.ts closes a task loop only on a direct read of the task).
    close: async (status, outcome, theirWord) => {
      // Their quoted word, carried to the close's outcome in the ledger (coTasks.ts closeTask reads it once).
      if (theirWord) closedOnTheirWord(userId, task.id, theirWord);
      await closeTask(userId, task.id, status, outcome);
      await import("./openLoops.js").then((m) => m.syncOpenLoops(userId)).catch((err: any) => console.error("taskTurn: loop sync after close failed (non-fatal):", err?.message ?? err));
    },
    setWindow: (w) => setTaskWindow(userId, task.id, w),
    // The miss warning: the existing send path, with quiet hours and the opt-out re-read (harness/proactive.ts sendExempt), its own
    // type so it never counts as the promised thing (services/followThrough.ts sendsSince) or uses up the task's text budget.
    warn: async (text, key) => {
      // Owed (review of #129): the new time for something Co committed to. Held, it would land after the time it's about.
      const r = await sendExempt({ userId, phoneNumber: person.phone_number, type: "task_window", targetKey: key, messages: [text], timezone: zone, respectHours: true, now: clock() });
      return { sent: r.sent, reason: r.reason };
    },
    writeDocument: async (input, { read }) => {
      const { sendDocumentForTask, realTaskDocDeps } = await import("./documentDelivery.js");
      // A Co look-out's document, PDF or Google Doc, is a Co-initiated find like its texts; a member look-out's is owed (Royce, 2026-10-09).
      const kind = lookoutKind(task);
      const r = await sendDocumentForTask(input, { userId, taskId: task.id, firstName: person.first_name ?? "", phone: person.phone_number, zone, taskTheirWords: task.theirWords, read, askedAt: task.createdAt ? new Date(task.createdAt) : null, ...(kind ? { coInitiated: { kind } } : {}) }, { ...realTaskDocDeps, now: clock });
      await recordDecision({ layer: 7, decision: "task.writeDocument", userId, outcome: r.ok ? "act" : "skip", action: r.ok ? r.title : "not_sent", reason: r.ok ? null : r.why.slice(0, 300), proposal: { taskId: task.id, via: r.ok ? r.via : null } }).catch(() => {});
      return r;
    },
    textsToday: () => taskTextsToday(userId),
    send: async (messages, o) => {
      // Only a text they're owed goes exempt. A look-out from Co's own promise sends finds, counted and held like sweep finds
      // (Royce, 2026-10-09: "without this, lookouts are a spam path around restraint"); one they asked for is owed, never kinded.
      const coInitiated = o?.owed ? undefined : { kind: lookoutKind(task) };
      // A slip text (slipException) has its own fixed key, so the same slip can only ever go once.
      const r = o?.key
        ? await sendExempt({ userId, phoneNumber: person.phone_number, type: "task_update", targetKey: o.key, messages, timezone: zone, respectHours: true, now: clock(), coInitiated })
        : await sendExempt({ userId, phoneNumber: person.phone_number, type: "task_update", targetKey: `task:${task.id}:${Date.now()}`, messages, timezone: zone, respectHours: true, now: clock(), coInitiated });
      const urls = messages.filter((m) => /^https?:\/\//.test(m));
      if (r.sent && urls.length) await recordSentItems(userId, urls.map((url) => ({ name: url, url })), "taskTurn").catch(() => {});
      return { sent: r.sent, reason: r.reason, retryAt: r.retryAt };
    },
    markTexted: () => markTexted(userId, task.id),
    unspendWake: () => unspendWake(userId, task.id),
    markFinalTold: () => markFinalTold(userId, task.id),
    // The same raw candidates Co's reply loop gets (agent/loopTools.ts), judged
    // by the task's own model, not the old pipeline's gates (2026-10-01).
    search: async (what, when) => {
      const [r, openings] = await Promise.all([
        eventCandidates(what, person.city ?? null, { when: when ?? null, userId, timezone: zone, limit: 6, source: "request" }),
        alreadyFoundOpenings(userId).catch(() => []),
      ]);
      const events = r.candidates.map(({ match, lines }) => ({ name: match.name, url: "url" in match ? (match.url ?? null) : null, date: (match as any).event_date ? String((match as any).event_date).slice(0, 10) : null, tier: match.tier, details: lines }));
      const found = openings.filter((m) => "url" in m && m.url).slice(0, 3).map((m) => ({ name: m.name, url: (m as any).url as string, date: null, tier: 3, details: [m.reason] }));
      return [...events, ...found];
    },
    web: (what) => taskWebSearch(userId, what, { city: person.city, zone, taskId: task.id, background: true }),
    readPage: async (url) => {
      const r = await readLink(url, { ownerUserId: userId }).catch(() => null);
      if (!r) return { ok: false, facts: [], text: "" };
      const ex = excerptFact(url, r);
      return { ok: r.status === "ok", facts: describeRead(url, r).facts, text: ex ?? "" };
    },
    now: clock,
    sentSince: (since) => sendsSince(userId, since),
    onFile: () => onFileFor(userId, task),
    recheckOnFile: async (f) => { const S = await import("./sendCheck.js"); return S.recheckOnFile(userId, f, zone, S.realSendCheckDeps); },
    rejected: () => pickerRejected(userId),
    saveFound: (items) => saveTaskFound(userId, task.id, items),
    ...opts.override,
  };
  const r = await runTaskTurnWith(task, deps);
  await recordDecision({ layer: 7, decision: "task.wake", userId, outcome: "act", action: r.action, proposal: { taskId: task.id, did: r.did, final: r.final, deadline: task.deadline, window: task.window ?? null, warning: r.warning ?? null } }).catch(() => {});
  return { action: r.action, did: r.did, warning: r.warning ?? null };
}

// Each task runs in its own member's scope (llm_usage.user_id), never the caller's: the wake after a reply runs this inside the texter's
// scope, and the due list holds other members' tasks too (review of #270).
export async function runDueTasks(deps: { claim?: () => Promise<CoTask[]>; runOne?: (t: CoTask) => Promise<void> } = {}): Promise<void> {
  const claim = deps.claim ?? (await import("./coTasks.js")).claimDueTasks;
  const runOne = deps.runOne ?? runDueTask;
  const { withTraceUser } = await import("./llmTraceText.js");
  // And under that member in our trace text (services/llmTraceText.ts).
  for (const t of await claim()) await withTraceUser(t.userId, () => withMember(t.userId, () => runOne(t)));
}

async function runDueTask(t: CoTask): Promise<void> {
  const L = await import("./commitmentLog.js");
  // A commitment's time came: logged as fired (services/commitmentLog.ts), whatever the turn then does.
  if (L.isCommitment(t)) await L.logCommitment("fired", { userId: t.userId, taskId: t.id, goalId: t.followup?.goalId ?? null, what: t.goal, source: t.source ?? null, why: `wake ${t.wakes}` });
  // A goal's check-in or reminder (services/goalOwnership.ts): real state first, then one text through the task-update path.
  if (t.kind === "work" && t.followup?.checkin) await import("./goalOwnership.js").then((g) => g.runGoalCheckin(t)).catch((err: any) => console.error("goal check-in failed (non-fatal):", err?.message ?? err));
  else if (t.kind === "followup") await import("./followUps.js").then((f) => f.runFollowUpTurn(t));
  else if (t.kind === "research_brief") await import("./researchBrief.js").then((r) => r.runResearchBriefTask(t)).catch((err: any) => console.error("research brief task failed (non-fatal):", err?.message ?? err));
  else await runTaskTurn(t);
}
