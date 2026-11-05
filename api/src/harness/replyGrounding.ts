import { workVerdict } from "./scope.js";
// Layer 3 harness: grounding for the conversational reply (Royce,
// 2026-09-14). Co kept inventing things about its own actions and the world
// ("This is text, I can't actually call", "I'll get you the link as soon as
// I have it", a 6:30pm start and "15-20 founders" for an event with neither
// on file, "I accidentally sent a broken link"). The reply prompt already
// said not to; prompts alone didn't hold.
//
//   gather  — ReplyFacts: one structured list of what's actually true this
//             turn (actions taken, pending items, scheduled calls, known
//             event fields and known gaps), built in code
//   propose — the reply agent drafts a message
//   gate    — groundReply: code checks links/phones/times/call claims, and a
//             Sonnet 5 read extracts every claim about actions, promises,
//             times, places, links, counts, and other people, each of which
//             must cite a fact or quote the thread (code verifies the cite).
//             Unsupported -> one redraft -> still unsupported -> the failing
//             sentences are dropped. The reply is never blocked.
//   record  — recordDecision(layer 3, "reply.grounding")
//   eval    — evals/reply/run.ts
import type { GoalStateRow } from "../services/goalEdges.js";
import { unsureQuote } from "../services/goalRecheck.js";
import type { MemberKnowledge, MemberRules, Restraint } from "../services/memberKnowledge.js";
import { dateSpan, KINDS, renderLive, type Kind } from "../services/factLabels.js";
import { arcLine, LENS_RULE } from "../services/goalJourney.js";
import { isNewMember, steerDecision, steerInstruction, type ColdStartView, type SeedCount } from "../services/coldStart.js";
import { doorDecision, doorInstruction, doorOpen, type DoorView } from "../services/theDoor.js";
import type { EmotionalContext } from "./emotion.js";
import { GENTLE_AFTER_HARD, MOOD_HOLD_CAP_HOURS, OKAY_AFTER_HOURS, moodHold, noteMoodHold, type MoodHold } from "../services/moodHold.js";
import { attributedWithoutSource } from "./proactiveSpecifics.js";
import { capabilitySheet, perTurnSheet } from "../services/capabilities.js";
import type { ReplySnapshot, SnapEntry } from "../services/memberSnapshot.js";
import { voiceReadPrereqs } from "../services/voiceRead.js";
import { kitLines } from "../services/memberKit.js";
import { situationFor, type Situation } from "../services/capabilities.js";
import { answerFromRecordNote, carryingBlock, isSameFind, sentDetailHints, sentDetailLines, type TurnContext } from "../services/turnContext.js";
import { ASKS_ABOUT_FIND } from "../services/exchangeRecord.js";
import { switchedOff } from "../services/abilitySwitches.js";
import { textingStyleFor } from "../services/textingStyle.js";
import { TEAM_BUILDER_LINE, isTeamMember } from "../services/extensions.js";
import { NO_COVERAGE, type SearchCoverage } from "../services/searchCoverage.js";
import { ROW_START } from "../services/sourceFence.js";
import { CHECKIN_RULE, CHECKIN_RULE_AT_NIGHT, LATE_NIGHT_CARE, lateNight, deadAir, keepsEverySentence, workClaimsNameThread, deadAirLine, memberWorldFact, namesRunningItem, parseWorldRedraft, runningItems, sentenceKey as threadKey, threadCandidates, threadReadPrompt, WORLD_FACT, worldLineAllowed, type MemberWorld } from "../services/memberWorld.js";
import { SAFETY_INSTRUCTION } from "../services/safetyText.js";
import { DEFAULT_ZONE, dateNote, itemDays, localToday, readDates, type Days } from "../services/dateGuard.js";
import { memberZone, validZone, wordsZone } from "../services/memberTime.js";
import { sourceOf } from "../services/messageFormat.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { isInviteRequest } from "../services/invites.js";
import { cleanCoMessage } from "../services/sendblue.js";
import { CO_TEXT_CHANNEL, CO_VOICE, MAKER_DECLINE_RULE } from "../services/coVoice.js";
import { recordDecision, type GateCheck } from "./core.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { checkNoEmotionLabel } from "./emotion.js";
import { narratesInternalState } from "../services/speakable.js";
import { arrivalDenial, recordSaysNothingReadable } from "../services/inboundFile.js";
import { failureInView, isFailureFact, isFailureReportFact, reportFactBacks } from "../services/turnFailure.js";
import { enrichMatch, fetchLumaEventDetails, isLumaLink, missingEventDetails, renderEventDetails, type EventDetails, type OpportunityDetails } from "../services/eventDetails.js";
import { citesStaleAsCurrent, liveDetailFacts, renderDetailsAsOf, staleCurrentClaims } from "../services/asOf.js";
import { recentCallCorrections } from "./callGrounding.js";
import { repeatQuestionCheck, sameQuestion } from "./repeatAsk.js";
import { asksForLink, findLines, linkRequestInstruction, recentResearchFinds, relevantFinds } from "../services/researchFinds.js";
import { textStockSentence } from "./stockLines.js";
import { DISCRETION_GUIDE, apologyOnly, discreetFinal, isDiscreetTurn, isNeutralTurn } from "./discretion.js";
import { PROMISE_RE, STARTED_WORK, dropPromise, promiseFact, promiseSentence, promiseStays, trackPromise } from "../services/promises.js";

// Model policy (Royce, 2026-09-14): Sonnet 5 for anything with judgment or
// side effects; Haiku only for narrow, code-checked reads.
// Any other event page, read live for "still spots?" (Royce, 2026-10-11): through safeFetch (every hop checked), its schema.org Event
// data only, no model, so the reply waits seconds at most. Null when it can't be read.
async function livePageFacts(url: string): Promise<import("../services/asOf.js").LivePage> {
  const { safeFetch, structuredEvent, settleRead, timeFact } = await import("../services/linkReader.js");
  const r = await safeFetch(url);
  if ("error" in r || r.status >= 400 || !/html/i.test(r.contentType)) return null;
  const f = structuredEvent(r.body);
  if (!f) return null;
  // Its time in the event's own zone (linkReader.ts settleRead: one zone rule, #298); a zone assumed from its city is said with the city
  // it's assumed from, and a time whose zone can't be established isn't said at all (timeFact, Royce 2026-10-28).
  await settleRead(f, r.body, r.finalUrl);
  const t = f.start ? timeFact(f.start.value, f.timezone, f.name?.value ?? "it") : null;
  return { start: t?.said ? `${t.said}${t.note ? ` (${t.note.replace(/\.$/, "")})` : ""}` : undefined, ...(t && !t.said && t.note ? { timeNote: t.note.replace(/\.$/, "") } : {}), cost: f.cost?.value, soldOut: f.sold_out?.value === "yes" };
}

export const LAYER3_MODELS = {
  // REPLY_EVAL_MODEL only exists so evals/reply can compare models.
  reply: process.env.REPLY_EVAL_MODEL || MODELS.sonnet,
  grounding: MODELS.sonnet,
  redraft: MODELS.sonnet,
  narrow: MODELS.haiku,
} as const;

// Effort for the grounding check and redraft. The check is extraction plus a
// supported/unsupported read, so low effort keeps latency down.
const GROUNDING_EFFORT = "low";
export const GROUNDING_CALL_TIMEOUT_MS = 20_000;

export type FactKind =
  | "did_this_turn" // something Co actually did during this turn
  | "did_before" // something Co really did on an earlier turn (what it sent)
  | "pending" // something Co asked and is still waiting on
  | "scheduled" // a real scheduled call
  | "known" // a real field Co has (event name, date, link, recommendation)
  | "unknown" // a detail Co explicitly does not have
  | "capability" // what Co can and can't do
  | "ongoing" // a search that really keeps running for them (an open ask)
  | "not_done" // something Co tried this turn that did NOT happen (a receipt)
  // Model-written reads (a search's reason, a fit explanation, a connection,
  // a summary): Co may draft from them, but they never support a claim
  // (2026-09-28: a search's "this is their people" became "that's your crowd").
  | "hint";

// snap: an entry of the member's snapshot (services/memberSnapshot.ts), under its own id ("L4711", "Pcity"). The fact check reads it
// like any fact; the reply reads it in its cached prefix, so it's never rendered into the reply's tail (renderReplyFacts tail).
// Its value is the entry's provenance (said, seen, did, inferred).
export type Fact = { id: string; kind: FactKind; text: string; snap?: "said" | "seen" | "did" | "inferred" };

// privateNames: the other member(s) a blocked turn is about, so a reply can't name them
// (harness/discretion.ts).
// goalSetAside: a goal Co set aside from context that they haven't heard about yet (services/goalEdges.ts); the reply may raise it.
// coldStart: set for a member with fewer than two findable interests on file (services/coldStart.ts): whether this reply was offered
// a steering question, and why or why not; recorded after the reply goes out (agent/conversationReply.ts).
// door: a new member's first read (services/theDoor.ts): whether this reply was offered the moment, and why or why not.
// retireAsk: the find ask this reply may ask about (services/askRetire.ts); stopNote: the one stopped-looking line code carries in it.
// world: the member's world this turn (services/memberWorld.ts): what the check-in rule draws on, and what the reply check reads to
// keep a backed world line and to end dead air with a true one.
// moment: what they're doing in this message, from the turn's moment read (services/connectDots.ts readMoment: "sharing", "feedback",
// ...). The reply check reads it to tell a cut that left a sharing reply flat (repairShareCut); never rendered into a prompt.
// changedBy: the tools that changed a setting or a record this turn (any not in services/capabilities.ts CHANGES_NOTHING, recorded by the guard).
// snapshot: the member's pinned snapshot and the lines added since (a text reply): the judge calls send the pinned text as their own
// cached block (judgeSystem) and list "Since then" after it.
// prefRules: how they asked Cue to reply and what not to bring up (services/memberPreferences.ts, applied rules only), for the reply
// check's rule read (services/prefTopics.ts judgeReplyRules).
export type ReplyFacts = { snapshot?: { prefix: string; since: string[] } | null; changedBy?: string[]; prefRules?: import("../services/memberPreferences.js").ReplyRules | null; moment?: string | null; shareRetried?: boolean; claimCites?: Map<string, { pass: boolean; failureFact: boolean }>; retireAsk?: import("../services/askRetire.js").RetireRow | null; stopNote?: import("../services/askRetire.js").StopNote | null; facts: Fact[]; instructions: string[]; privateNames?: string[]; discretionDone?: boolean; goalSetAside?: GoalStateRow | null; coldStart?: ColdStartFacts | null; door?: DoorFacts | null; admitted?: Set<string>; world?: MemberWorld | null; thread?: ThreadReads; exchange?: import("../services/exchangeRecord.js").ExchangeRecord | null; turnScope?: import("./scope.js").ScopeVerdict | null; turnShare?: import("./scope.js").MessageKind | null };
// What the thread read decided this turn (judgeThreadReports): each sentence asked about, by key, and whether it reports where their
// thread stands; plus each read, for the log.
// pending: sentences a read is out for right now, so two reads running together never ask the same sentence twice.
export type ThreadReads = { judged: Map<string, boolean>; pending: Map<string, Promise<void>>; reads: { sentences: string[]; reports: number[] | null; ms: number }[] };
export type ColdStartFacts = { offered: boolean; why: string; seeds: SeedCount; instruction: string | null };
export type DoorFacts = { offered: boolean; why: string; instruction: string | null };

// Pure: the first-read moment on this reply's facts (services/theDoor.ts doorDecision), with its instruction when it's on offer.
// Nothing at all once the door has closed for them (given, or no longer new).
export function addDoorMoment(rf: ReplyFacts, view: DoorView, o: { firstName?: string | null; emotional: EmotionalContext | null | undefined; otherQuestion?: string | null; now?: Date }): DoorFacts | null {
  const d = doorDecision({ view, now: o.now, heavy: heavyHold(o.emotional, o.now ?? new Date()).hold, frustrated: frustrationHold(o.emotional, view.joinedAt, o.now ?? new Date()).hold, otherQuestion: o.otherQuestion ?? null });
  if (!d.offer && !doorOpen(view, o.now).open) return null;
  const instruction = d.offer ? doorInstruction(o.firstName) : null;
  if (instruction) addInstruction(rf, instruction);
  rf.door = { offered: d.offer, why: d.why, instruction };
  return rf.door;
}

// Pure: for a new member with no city on file, the line that keeps the club's city from becoming theirs. A city they named in their
// own texts still counts ("I'm in Oakland, find me a run club" uses Oakland); nothing for anyone else.
export function unknownCityFact(o: { city?: string | null; joinedAt?: Date | null; now?: Date }): string | null {
  if (String(o.city ?? "").trim() || !isNewMember(o.joinedAt ?? null, o.now ?? new Date())) return null;
  return "No city on file for them. Use only a city they named in their own texts; the club's city isn't theirs.";
}

// Pure: take the moment back off a reply that turned out to have something else to offer (a call), before it drafts.
export function withdrawDoorMoment(rf: ReplyFacts, why: string): void {
  const d = rf.door;
  if (!d?.offered) return;
  rf.instructions = rf.instructions.filter((i) => i !== d.instruction);
  rf.door = { offered: false, why, instruction: null };
}

// Pure: the cold-start state on this reply's facts, with the steering instruction when it's on offer (services/coldStart.ts
// steerDecision: never in a heavy moment or while frustrated with Co, never two replies in a row, never beside another question).
// Nothing at all for a seeded member: steering stops once two findable interests are on file.
export function addColdStartSteer(rf: ReplyFacts, cs: ColdStartView, o: { emotional: EmotionalContext | null | undefined; otherQuestion?: string | null; now?: Date }): ColdStartFacts | null {
  if (cs.seeds.seeded) return null;
  const d = steerDecision({ seeds: cs.seeds, heavy: heavyHold(o.emotional, o.now ?? new Date()).hold, frustrated: frustrationHold(o.emotional, steerOwedSince(cs), o.now ?? new Date()).hold, history: cs.history, lifetimeSteers: cs.lifetimeSteers, now: o.now ?? new Date(), otherQuestion: o.otherQuestion ?? null });
  const asked = cs.history.filter((h) => h.action === "steered" && h.question).map((h) => h.question!);
  const instruction = d.steer ? steerInstruction(cs.seeds, asked) : null;
  if (instruction) addInstruction(rf, instruction);
  rf.coldStart = { offered: d.steer, why: d.why, seeds: cs.seeds, instruction };
  return rf.coldStart;
}

// Pure: take the steering back off a reply that turned out to have another question to ask (a call offer), before it drafts.
export function withdrawColdStartSteer(rf: ReplyFacts, why: string): void {
  const cs = rf.coldStart;
  if (!cs?.offered) return;
  rf.instructions = rf.instructions.filter((i) => i !== cs.instruction);
  rf.coldStart = { ...cs, offered: false, why, instruction: null };
}

export function createReplyFacts(): ReplyFacts {
  return { facts: [], instructions: [] };
}

export function addFact(rf: ReplyFacts, kind: FactKind, text: string): void {
  const t = text.trim();
  if (!t || rf.facts.some((f) => f.text === t)) return;
  rf.facts.push({ id: `F${rf.facts.filter((f) => !f.snap).length + 1}`, kind, text: t });
}

// A model-written read for drafting, never a source (FactKind "hint").
export function addHint(rf: ReplyFacts, text: string): void {
  addFact(rf, "hint", text);
}

export function addInstruction(rf: ReplyFacts, text: string): void {
  const t = text.trim();
  if (t && !rf.instructions.includes(t)) rf.instructions.push(t);
}

// Pure: the member's snapshot entries as this reply's facts, for the fact check (snap: never in the reply's tail). What each can back,
// from the entry's own provenance, section, kind and receipt: Cue's read (inferred) and an act of Cue's that didn't happen (a
// not_done act, or a receipt other than done) back nothing (hints); an open item in their world is scheduled work, a closed one what
// Cue did; Cue's acts are what it did; what Cue can do is a capability; the rest (their words, what Cue saw) is known.
export function addSnapshotFacts(rf: ReplyFacts, entries: SnapEntry[]): void {
  for (const e of entries) {
    if (rf.facts.some((f) => f.id === e.id)) continue;
    const didnt = e.section === "ledger" && (e.kind === "not_done" || !!e.receipt);
    const kind: FactKind = e.prov === "inferred" || didnt ? "hint" : e.section === "can" ? "capability" : e.section === "world" ? (e.open ? "scheduled" : "did_before") : e.section === "ledger" ? "did_before" : "known";
    rf.facts.push({ id: e.id, kind, text: `${e.date ? `${e.date}: ` : ""}${e.text}`, snap: e.prov });
  }
}

// The judge calls (the fact check, the redraft, the thread repair, the share rewrite) on a text reply: the member's pinned snapshot as
// their own cached system block, the same bytes the reply sends, so it's read from cache after the first call. Nothing without one.
export function judgeSystem(rf: Pick<ReplyFacts, "snapshot">): { system?: { role: "system"; content: string; providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }[] } {
  return rf.snapshot ? { system: [{ role: "system", content: rf.snapshot.prefix, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }] } : {};
}
const SNAPSHOT_NOTE = "Cue's snapshot of them above is also among the facts: cite any of its lines by its [id]. A line marked inferred is Cue's own read and backs nothing; an act with a receipt (not done, limited, needs yes) didn't happen.";
const sinceBlock = (rf: Pick<ReplyFacts, "snapshot">) => (rf.snapshot?.since.length ? `\nSince then (added after Cue's snapshot above; cite by [id]):\n${rf.snapshot.since.join("\n")}` : "");
// The facts a judge call reads in its prompt: with the snapshot cached above, only this turn's facts and "Since then".
export function renderJudgeFacts(rf: ReplyFacts): string {
  return rf.snapshot ? `${SNAPSHOT_NOTE}\n${renderReplyFacts(rf, { tail: true })}${sinceBlock(rf)}` : renderReplyFacts(rf);
}

// Facts that are true for every reply, before anything about this person. What Cue can do: with the member's snapshot, its section 6
// (identical for every member, cited by entry id) plus this turn's per-turn lines; without one (a read that failed or was fenced, or a
// caller with none), the whole sheet, in the tail.
export function baseReplyFacts(situation?: Situation, snapshot?: Pick<ReplySnapshot, "entries" | "prefix" | "since"> | null, team = false): ReplyFacts {
  const rf = createReplyFacts();
  if (snapshot) {
    addSnapshotFacts(rf, snapshot.entries);
    rf.snapshot = { prefix: snapshot.prefix, since: snapshot.since };
  }
  for (const c of snapshot ? (situation ? perTurnSheet(situation) : []) : capabilitySheet({ team, situation })) addFact(rf, "capability", c);
  // How Co keeps a confidence, so the model chooses a discreet line itself when
  // asked to speak for another member (harness/discretion.ts).
  addInstruction(rf, DISCRETION_GUIDE);
  return rf;
}

// Gathers the facts that don't depend on what happened earlier in this turn.
// Branch-specific facts (a link just sent, a call that failed) are added by
// routes/sendblue.ts as it acts.
// They're asking for a deck, slides, a document, a page or a PDF: a request word before the noun, so "my presentation went badly" or
// "she slides into DMs" isn't an ask. Cue doesn't make these (the maker layer was removed): MAKER_DECLINE_RULE tells it so.
export const MAKER_ASK = /\b(make|build|put together|throw together|write|draft|design|create|need (a|some|new)|need(?= (slides|decks?|pitch deck)\b)|want (a|some)|would love (a|some)|would like (a|some)|can you|could you|help me with|send me)\b[^.?!\n]{0,40}\b(pitch deck|deck|slides|presentation|slideshow|document|doc|pdf|one-?pager|write-?up|web ?page|landing page|private page|google doc)\b/i;

// They asked Co to research, look up or look into someone or something.
export const RESEARCH_ASK = /\b(do (some )?research|research (on|into)|look (up|into)|dig (into|up)|find out (about|who|what)|check out who)\b/i;
export const RESEARCH_RULE =
  "They asked you to research something. Search the web for it first (webSearch), in this turn, before you say or suggest anything about it. Use only what the search actually found. If it found nothing solid, say that plainly, and offer no lines, positioning or claims built on it.";

export async function gatherReplyFacts(
  userId: string,
  // context: their message and Co's last few lines, so older things they
  // name can be looked up in Co's record (services/coFacts.ts).
  // turn: the one picture of this turn (services/turnContext.ts). When given,
  // the snapshot, the record, open asks and what Co sent come from it instead
  // of separate loads.
  // snapshot: the member's snapshot (services/memberSnapshot.ts replySnapshot). What Cue knows about them comes from it, read whole
  // in the reply's cached prefix; this builds only what's per turn. Null when it couldn't be read: the turn runs on its tail and rules.
  opts: { pendingDescriptions?: string[]; context?: string; turn?: TurnContext; walkinDue?: boolean; snapshot?: ReplySnapshot | null } = {},
): Promise<ReplyFacts> {
  const t = opts.turn;
  const team = await isTeamMember(userId).catch(() => false);
  const rf = baseReplyFacts(situationFor({ kitFields: Object.keys(t?.kit ?? {}).length, message: t?.message ?? "", openTasks: t?.tasks?.length ?? 0, eventToday: !!t?.todayEvent, doorOpen: t?.door ? doorOpen(t.door).open : false, walkinDue: !!opts.walkinDue, voiceRead: voiceReadPrereqs(), waiting: !!t?.waiting?.length }), opts.snapshot, team);
  for (const d of opts.pendingDescriptions ?? []) addFact(rf, "pending", `Waiting to hear back: ${d}`);
  // The member-level rules from the one member-knowledge layer (addMemberKnowledge): restraint, quiet hours, delivery shape. What
  // they told Cue, corrected and liked is in the snapshot.
  addMemberKnowledge(rf, t?.knowledge, t?.rules);
  // "Do research on X" (Royce, 2026-10-11: Co offered a positioning line "from" Jeremy Toce without ever searching): search first,
  // and say nothing about X until it's back; nothing found is said plainly, with no lines built on it.
  // Only the member's own message: the rest of the context carries Co's lines too ("want me to look into it?"), so without a turn
  // it's the context's first line, which is their message.
  const theirMessage = String(opts.turn?.message ?? (opts.context ?? "").split("\n")[0]);
  if (RESEARCH_ASK.test(theirMessage)) addInstruction(rf, RESEARCH_RULE);
  // They ask for a deck, doc, page or PDF: Cue doesn't make those; the decline is guidance in its own words (services/coVoice.ts).
  if (MAKER_ASK.test(theirMessage)) addInstruction(rf, MAKER_DECLINE_RULE);
  // How they've told Co they like to be texted (services/textingStyle.ts).
  const style = await textingStyleFor(userId).catch(() => [] as string[]);
  if (style.length) addInstruction(rf, `How they've told you they like to be texted, follow it: ${style.join("; ")}.`);
  // The team only: that they build Co (their team-only abilities are in the sheet). Everyone else gets nothing about them.
  if (team) addInstruction(rf, TEAM_BUILDER_LINE);
  // Abilities switched off right now (services/abilitySwitches.ts).
  for (const id of (await switchedOff().catch(() => new Map<string, string>())).keys()) {
    addFact(rf, "capability", `Cue's ${id.replace(/_/g, " ")} ability is switched off right now. If it comes up, say it isn't available at the moment.`);
  }
  // What Co researched, with its links, for "send it" (services/researchFinds.ts).
  const allFinds = await recentResearchFinds(userId).catch(() => []);
  const message = t?.message ?? "";
  const finds = relevantFinds(allFinds, message, (opts.context ?? "").slice(-600), asksForLink(message));
  for (const line of findLines(finds)) addFact(rf, "known", line);
  const linkAsk = linkRequestInstruction(message, finds.length > 0 || /https?:\/\//.test(opts.context ?? ""));
  if (linkAsk) addInstruction(rf, linkAsk);
  // Every source is a separate read, so they run together: in series this
  // was six round trips before the reply could even start drafting.
  // Their zone (services/memberTime.ts): "today" in the date notes is their day.
  const zone = await memberZone(userId);
  const [corrections, scheduled, reveal, preference, callFailure, sendHeld] = await Promise.all([
    recentCallCorrections(userId),
    pool
      .query(
        `SELECT scheduled_for, timezone FROM scheduled_calls WHERE user_id = $1 AND status = 'pending' AND scheduled_for > NOW() ORDER BY scheduled_for LIMIT 3`,
        [userId],
      )
      .catch(() => ({ rows: [] as any[] })),
    // Most recent event/opportunity Co told them about, resolved or not:
    // "what time does it start" can come days after the yes.
    pool
      .query(
        `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'event_offer_pending' AND created_at > NOW() - INTERVAL '3 days' ORDER BY created_at DESC LIMIT 1`,
        [userId],
      )
      .catch(() => ({ rows: [] as any[] })),
    // Whether they said they'd rather text or talk (asked at onboarding).
    pool.query(`SELECT contact_preference FROM users WHERE id = $1`, [userId]).then((r) => r.rows[0]?.contact_preference ?? null).catch(() => null),
    // Why a recent call failed (services/elevenLabsCalls.ts noteCallFailure).
    pool
      .query(
        `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_failure' AND created_at > NOW() - INTERVAL '2 hours' ORDER BY created_at DESC LIMIT 1`,
        [userId],
      )
      .then((r) => (r.rows[0]?.content as string | undefined) ?? null)
      .catch(() => null),
    // Texts held by the send breaker (services/sendblue.ts reportSendBreaker).
    pool
      .query(
        `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'send_held' AND created_at > NOW() - INTERVAL '3 hours' ORDER BY created_at DESC LIMIT 1`,
        [userId],
      )
      .then((r) => (r.rows[0]?.content as string | undefined) ?? null)
      .catch(() => null),
  ]);
  // Today's date, so "Oct 10 is 18 days out" can be worked out instead of
  // guessed (2026-09-22: a reply said "if today's around the 23rd" on the
  // 22nd, and the fact check had nothing to check it against).
  // In their zone (services/memberTime.ts), never always Pacific: "today" for a member in New York turns over three hours earlier.
  addFact(rf, "known", todayFact(zone));
  if (preference === "text") addFact(rf, "known", "They told Cue they'd rather text. Only bring up a call if they ask for one.");
  if (preference === "call") addFact(rf, "known", "They told Cue they like talking on the phone. Offering a call when there's a lot to talk through is welcome.");
  // The rules they set (services/memberPreferences.ts): what's in force, and whether any path applies it, so the reply never says a rule
  // is applied when it isn't; the one ask for a vague "less". A failed read adds nothing.
  {
    const P = await import("../services/memberPreferences.js");
    const prefs = await P.activePreferences(userId).catch(() => [] as import("../services/memberPreferences.js").Preference[]);
    // Their search area, so a where-to-search rule is said applied only while the area really is its place (a failed read: not applied).
    const area = prefs.some((p) => p.area === "search_area") ? await import("../services/searchArea.js").then((A) => A.areaCtxOf(userId)).catch(() => ({})) : {};
    const pf = P.replyPreferenceFacts(prefs, new Date(), area);
    for (const line of pf.known) addFact(rf, "known", line);
    for (const line of pf.instructions) addInstruction(rf, line);
    // How to reply and what not to raise, for the reply check's rule read (judgeReplyRules).
    rf.prefRules = pf.rules.style.length || pf.rules.avoid.length ? pf.rules : null;
    // A rule they set in this message that a path now applies is a change made this turn: a reply saying so ("searching SF from now on")
    // stands on it (codeChecks no_unbacked_change), as it does on a tool's change.
    for (const p of pf.appliedNow) (rf.changedBy ??= []).push(p.area === "search_area" ? "setSearchArea" : "memberPreference");
    // Marked asked only once this reply is actually sent (routes/sendblue.ts confirmLessAsked).
    P.noteLessAsk(userId, pf.askIds);
  }
  if (callFailure) {
    addFact(rf, "did_before", callFailure);
    addInstruction(rf, "If calls come up, say plainly the problem is on your side, not their phone. Don't guess at more detail than that, and don't promise when it'll be fixed.");
  }
  // 2026-09-24: asked "you have a rate limit set on text I see," Co said
  // "No rate limit, just me actually searching." It had no idea its texts
  // were held, so it made up a reason.
  if (sendHeld) {
    addFact(rf, "did_before", sendHeld);
    addInstruction(rf, "If they ask why you went quiet, didn't answer, or mention a limit, say plainly that a limit on your side paused your texts for a while and it wasn't them. Never deny it or give another reason. If something they asked in that time never got an answer, answer it now.");
  }
  // The daily search's own fact names only what the floor really searches (find asks, read with its filter), help asks beside it.
  // Read first from what the floor really searches (find asks with its filter, a held search as nothing), help asks beside it; the
  // call after it then adds nothing (it adds only when no search fact is there yet).
  if (opts.turn?.searching) {
    const searchedAsks = [...opts.turn.searching.asks.map((text) => ({ text, kind: "find" as const })), ...(opts.turn.searching.hidden ? [{ text: "one more thing they asked for", kind: "find" as const }] : []), ...(opts.turn.asks ?? []).filter((a) => a.kind === "help")];
    for (const f of ongoingFactsFor(searchedAsks)) addFact(rf, f.kind, f.text);
  }
  await addOngoingSearchFacts(rf, userId, opts.turn?.asks);
  for (const correction of corrections) addFact(rf, "known", correction);
  // What Cue sent, searched and did for them is the snapshot's ledger (section 5); what their message names from it is said below.
  // Without a snapshot (its read failed or was fenced), the turn's own ledger lines stand in, so a true "I sent you X" isn't cut.
  if (!opts.snapshot) for (const line of opts.turn?.ledger?.lines ?? []) addFact(rf, "did_before", line);
  // Intros Cue made and the members it suggested, from its own records (co_memories: not on the ledger yet; they move there with the
  // ledger cutover, step 8). Details-free and through the guards.
  for (const line of await introRecordFacts(userId).catch(() => [] as string[])) addFact(rf, "did_before", line);
  // What's on file for what Co recently sent: times and places, and what isn't
  // (services/turnContext.ts), before Co ever says it doesn't have them.
  if (opts.turn) {
    for (const line of sentDetailLines(opts.turn, 5, new Date(), { zone, also: opts.turn.referents ?? [] })) addFact(rf, "known", line);
    // The find they ask about is resolved: its stored facts are the answer (the same note a call gets).
    const asking = (opts.turn.referents ?? []).length && ASKS_ABOUT_FIND.test(opts.turn.message ?? "");
    const note = asking ? answerFromRecordNote(opts.turn.referents ?? []) : null;
    if (note) addInstruction(rf, note);
  }
  // A live question ("still spots?", "what time?", "how much?"): the Luma pages of what Co sent them lately, read now, so the answer
  // is today's (Phase B, B3, services/asOf.ts). Only this member's own sends. Everything else stored stays labelled as of its read.
  if (opts.turn) {
    const recentSends = opts.turn.sent.filter((x) => Date.now() - x.sentAt.getTime() < 14 * 86_400_000).map((x) => ({ name: x.name, url: x.url }));
    const live = await liveDetailFacts(opts.turn.message ?? "", recentSends, { luma: (u) => fetchLumaEventDetails(u, { maxAgeMs: 5 * 60_000 }), isLuma: isLumaLink, page: livePageFacts }).catch(() => [] as string[]);
    for (const line of live) addFact(rf, "known", line);
  }
  // What Co has for doing things on their behalf, and what it doesn't (services/memberKit.ts).
  // (A "details on file" instruction added for one incident was removed 2026-09-30:
  // the replay showed it changed nothing; the summary fix did the work.)
  if (opts.turn?.kit) for (const line of kitLines(opts.turn.kit)) addFact(rf, "known", line);
  // Where they've been with Co, from the record (services/milestones.ts): the
  // arc Co can look back on, in their own words.
  for (const line of opts.turn?.story ?? []) addFact(rf, "known", line);
  // What Co advised them lately (services/advice.ts), so it doesn't contradict itself and can ask how it went.
  for (const line of opts.turn?.advice ?? []) addFact(rf, "did_before", line);
  // On the way to a Co event today (services/preArrival.ts).
  const today = opts.turn ? opts.turn.todayEvent ?? null : await import("../services/eventPresence.js").then((e) => e.todayEventFor(userId)).catch(() => null);
  if (today) {
    addFact(rf, "known", `They're registered for Noise's event "${today.name}" today, starting ${today.startAt}.`);
    addInstruction(rf, `If they say they're running late, can't make it, or aren't sure about "${today.name}", answer them normally and warmly, record it with updateGoing, never pressure them to come, and never offer to contact the host.`);
  }
  // One ordered view of everything Co is carrying for them (memberKnowledge.ts carryingOf, labelled by turnContext.ts carryFromKnowledge), and, when this message shares
  // words with a section of a document Co just delivered, a pointer to read it first. Both guidance, never a gate.
  {
    const carrying = carryingBlock(opts.turn?.carrying);
    if (carrying) addInstruction(rf, carrying);
  }
  // Co's own open tasks: real scheduled work, so saying when it'll get back to them is true.
  for (const line of opts.turn?.tasks ?? []) addFact(rf, "scheduled", line);
  // Goals they handed Co (services/goalOwnership.ts): a split waiting on their pick is known; an active goal's check-in is scheduled.
  for (const g of opts.turn?.goals ?? []) addFact(rf, g.kind, g.text);
  // Their research briefs (services/coTasks.ts briefFactLines): one still running or held for their hours is scheduled; one that
  // finished or stopped is Co's record of what it did.
  for (const line of opts.turn?.briefs ?? []) addFact(rf, /^(?:Co|Cue) is putting together|hasn't reached them yet/.test(line) ? "scheduled" : "did_before", line);
  // What is actually running for them, read from task state every turn (2026-10-12, item 3): only this backs saying Co is working on
  // something; with nothing running, Co says so.
  if (opts.turn) addFact(rf, "known", runningWorkLine(opts.turn.tasks ?? [], opts.turn.briefs ?? [], opts.turn.searching));
  // Their world in one line, and the check-in rule (services/memberWorld.ts, Royce 2026-10-14): every text turn, so a check-in or a
  // casual opener has their real world to draw on. Co decides whether the message is one.
  if (opts.turn?.world) addMemberWorld(rf, opts.turn.world);
  // Their message may be about something Co is already doing (services/statusCheck.ts, Royce 2026-10-13): the candidate and where it
  // stands; Co decides whether it's a status check. Co's own words; this fact backs them.
  if (opts.turn?.statusCheck) {
    addFact(rf, "known", opts.turn.statusCheck.fact);
    addInstruction(rf, (await import("../services/statusCheck.js")).CANDIDATE_RULE);
  }
  // What's ahead from Co, as scheduled (services/whatsAhead.ts): check-ins, follow-ups, tasks, the daily search and queued finds.
  if (opts.turn?.ahead) addFact(rf, "scheduled", opts.turn.ahead);
  if (opts.turn) for (const hint of sentDetailHints(opts.turn)) addHint(rf, hint);
  // A goal Co set aside from context (its date passed, or newer words replaced it) is told, never silent (Royce, 2026-10-08): the
  // oldest one, as a hint the reply may take when it fits. Never in a hard moment, never as a list or an announcement.
  // The goal recheck (services/goalRecheck.ts, 2026-10-13) rides the same hint: a searched goal with nothing from them in two weeks is
  // asked about once ("ask"); one already asked is only read, so their answer lands ("asked").
  const asides = opts.turn?.goalSetAsides ?? [];
  const aside = asides.find((a) => a.recheck !== "asked");
  if (aside) {
    rf.goalSetAside = aside;
    // Unsure whether it went with something they just dropped (services/goalRecheck.ts markUnsure): the same one question, about that.
    const dropped = aside.recheck === "ask" ? unsureQuote(aside.reason) : null;
    if (dropped) addHint(rf, `When they said "${dropped.slice(0, 160)}", it wasn't clear whether their goal "${aside.goal.slice(0, 140)}" goes with it, so it's still on file. If it fits naturally in this reply and they aren't in a hard moment, ask once, in your own words and naming it plainly, whether that's still on; if yes, markGoal active, if it's off too, markGoal stale. Never as a list or an announcement, and never an offer.`);
    else if (aside.recheck === "ask") addHint(rf, `Their goal "${aside.goal.slice(0, 140)}" has had nothing new from them in a while. If it fits naturally in this reply and they aren't in a hard moment, ask once, in your own words and naming it plainly, whether they still want things for it; if they say yes, markGoal active, if it's over, markGoal done. Never as a list or an announcement, never an offer to keep looking, and never say how long it's been.`);
    else addHint(rf, `Cue stopped looking for things for their goal "${aside.goal.slice(0, 140)}" (${aside.reason}). If it fits naturally in this reply and they aren't in a hard moment, ask in your own words whether they still want things for it; if they say yes, markGoal active, if it's over, markGoal done. Never as a list or an announcement.`);
  }
  for (const a of asides.filter((x) => x.recheck === "asked")) addHint(rf, `You asked them whether they still want things for their goal "${a.goal.slice(0, 140)}". If this message answers that, markGoal active for a yes or done if it's over. Don't ask it again.`);
  // Ask retirement (services/askRetire.ts, 2026-10-13): one question a turn, and a goal's comes first, so the ask's only when no goal
  // question was handed over. Code reads their answer (a yes keeps it, a no stops it); the reply just takes it in.
  const retireAsk = aside ? null : opts.turn?.retire?.ask ?? null;
  if (retireAsk) {
    rf.retireAsk = retireAsk;
    addHint(rf, `You've been looking for "${retireAsk.text.slice(0, 140)}" for them, and it reads more like a plan of theirs than something to find. If it fits naturally in this reply and they aren't in a hard moment, ask once, in your own words and naming it plainly, whether they still want you looking for it. Never as a list or an announcement, never an offer, and never say how long it's been.`);
  }
  for (const a of opts.turn?.retire?.asked ?? []) addHint(rf, `You asked them whether they still want you looking for "${a.text.slice(0, 140)}". If this message answers that, take the answer in naturally; don't ask it again.`);
  // The one stopped-looking line (services/askRetire.ts): code adds it to the reply word for word; don't say it again yourself. A hard
  // day makes it wait, read from this message's feeling (the turn's read is replaced with it before this runs): it goes once they're
  // okay again, at the latest at the cap, and it's never dropped for it (services/moodHold.ts, Royce 2026-10-18). Logged once, ids only.
  const noteMood = opts.turn?.stopNote ? moodHold(opts.turn.emotional, { now: new Date(), lastInboundAt: new Date() }) : null;
  if (opts.turn?.stopNote && noteMood) noteMoodHold("stop_note_hold", opts.turn.stopNote.kind, `${userId}:${opts.turn.stopNote.kind}:${opts.turn.stopNote.key}`, noteMood);
  if (opts.turn?.stopNote && !noteMood?.hold) {
    rf.stopNote = opts.turn.stopNote;
    addHint(rf, `Code adds this line to your reply, once: "${opts.turn.stopNote.line}." Don't repeat it or contradict it.`);
  }
  // Cold start (services/coldStart.ts): fewer than two findable interests on file, so a reply may ask one easy question that lets them
  // name something Co could find. New members and existing ones alike, only in a natural exchange, never as outreach.
  if (opts.turn?.coldStart) addColdStartSteer(rf, opts.turn.coldStart, { emotional: opts.turn.emotional, otherQuestion: aside ? "a set-aside goal to ask about" : null });
  // Where they live, when nothing on file says (2026-10-12, the door rerun: "moved here" plus the club being in San Francisco
  // became "around SF" in a reply and "in SF" in a task). The drafter and the claim read both see it as unknown, never assumed.
  {
    const cityLine = unknownCityFact({ city: opts.turn?.knowledge?.identity.city ?? opts.turn?.profile?.city ?? null, joinedAt: opts.turn?.door?.joinedAt ?? null });
    if (opts.turn && cityLine) addFact(rf, "unknown", cityLine);
  }
  // The door (services/theDoor.ts): a new member's first read, once, when Co has heard enough to say it back.
  if (opts.turn?.door) addDoorMoment(rf, opts.turn.door, { firstName: opts.turn.knowledge?.identity.firstName ?? null, emotional: opts.turn.emotional, otherQuestion: aside ? "a set-aside goal to ask about" : null });
  // A heavy moment holds these back for a later reply, never cancels them (heavyHold): each hold and release logged once, rule and kind.
  if (opts.turn) {
    const heavy = heavyHold(opts.turn.emotional, new Date());
    if (rf.door) noteMoodHold("heavy_offer_hold", "door", `${userId}:door`, heavy);
    if (rf.coldStart) noteMoodHold("heavy_offer_hold", "cold_start", `${userId}:cold_start`, heavy);
    // Frustration with Cue holds the door and the question the same way (frustrationHold): logged once, rule and kind.
    const now = new Date();
    if (rf.door && opts.turn.door) noteMoodHold("frustration_hold", "door", `${userId}:door`, frustrationHold(opts.turn.emotional, opts.turn.door.joinedAt, now));
    if (rf.coldStart && opts.turn.coldStart) noteMoodHold("frustration_hold", "cold_start", `${userId}:cold_start`, frustrationHold(opts.turn.emotional, steerOwedSince(opts.turn.coldStart), now));
    // Released (they're okay again, or the cap): what waited goes gently (model-facing tone guidance, never a line of its own).
    if ((heavy.state === "released_okay" || heavy.state === "released_cap") && (rf.door?.offered || rf.coldStart?.offered)) addInstruction(rf, GENTLE_AFTER_HARD);
  }
  // They're asking about something the record shows Co sent: the record
  // answers, whatever earlier messages said (2026-09-27: after two earlier
  // wrong denials in the thread, Co said "Still no, same as I said before").
  const named = opts.turn?.ledger?.named ?? [];
  if (named.length) {
    addInstruction(rf, `What they're asking about is in Cue's record as sent: ${named.join(" ")} Answer from that record. If an earlier message in this conversation said otherwise, say plainly that it was wrong.`);
  }

  if (!scheduled.rows.length) addFact(rf, "scheduled", "No calls are scheduled with them.");
  for (const row of scheduled.rows) {
    const local = DateTime.fromJSDate(new Date(row.scheduled_for)).setZone(row.timezone);
    addFact(rf, "scheduled", `A call is scheduled for ${local.toFormat("cccc, LLLL d 'at' h:mm a")} (${row.timezone}).`);
  }

  if (reveal.rows[0]) {
    try {
      const { match } = JSON.parse(reveal.rows[0].content) as { match: any };
      // Offers stored before details existed get them on demand. Not repeated when it is the find they asked about: its facts are above.
      if (!(opts.turn?.referents ?? []).some((r) => isSameFind(r, match))) addEventFacts(rf, await enrichMatch(match), null, zone);
    } catch {
      // Malformed or pre-fix content shape; nothing reliable to add.
    }
  }
  return rf;
}

// Cue's intro records for them, the latest few, each reduced to the other person's first name, the event and the date: nothing about
// that person beyond their name (the stored row can carry the match's reason, which describes them). A row whose shape isn't one of
// these, or that named no one to them, is left out. Through the removal guards (whatCoKnows.ts guardText).
async function introRecordFacts(userId: string): Promise<string[]> {
  const W = await import("../services/whatCoKnows.js");
  const [rows, removed] = await Promise.all([
    pool
      .query(
        `SELECT m.content, m.memory_type, m.created_at, u.first_name FROM co_memories m JOIN users u ON u.id = m.user_id
         WHERE m.user_id = $1 AND m.memory_type IN ('event_intro_email_sent', 'event_guest_match_nudge', 'recommendation')
           AND m.id IN (
             (SELECT id FROM co_memories WHERE user_id = $1 AND memory_type IN ('event_intro_email_sent', 'event_guest_match_nudge') ORDER BY created_at DESC LIMIT 20)
             UNION ALL
             (SELECT id FROM co_memories WHERE user_id = $1 AND memory_type = 'recommendation' ORDER BY created_at DESC LIMIT 10))
         ORDER BY m.created_at DESC`,
        [userId],
      )
      .then((r) => r.rows as { content: string; memory_type: string; created_at: Date; first_name: string | null }[]),
    W.forgottenRows(userId).then((r) => r.filter((x) => x.removed)),
  ]);
  return rows.flatMap((r) => introRecordLines(r.memory_type, String(r.content ?? ""), new Date(r.created_at), r.first_name)).map((l) => (removed.length ? W.guardText(l, removed) : l)).filter((l): l is string => !!l);
}

// Pure: one intro record as the lines a reply may cite: who (first name only), the event, the date.
const FIRST = "([\\p{Lu}][\\p{L}'’-]{0,30})";
export function introRecordLines(type: string, content: string, at: Date, ownFirstName: string | null): string[] {
  const day = Number.isNaN(at.getTime()) ? "" : ` (${at.toISOString().slice(0, 10)})`;
  if (type === "recommendation") return [...content.matchAll(/\[Tier 0\]\s*([^:|]+?)\s*:/g)].map((m) => m[1].trim()).filter((n) => new RegExp(`^${FIRST}$`, "u").test(n)).map((n) => `Cue's record${day}: Cue suggested ${n}, another member, to them as someone worth meeting.`);
  if (type === "event_guest_match_nudge") {
    const m = content.match(new RegExp(`^Told \\S+ that ${FIRST} also got to "([^"]{1,120})"`, "u"));
    return m ? [`Cue's record${day}: Cue told them ${m[1]}, another member, also got to "${m[2]}" and is worth meeting.`] : [];
  }
  if (type === "event_intro_email_sent") {
    // An intro to a member with no email goes by text (services/introByText.ts, 2026-11-03): "intro by text", "intro by email and text".
    const m = content.match(new RegExp(`^Sent an? (?:network )?intro (?:email|by text|by email and text) connecting ${FIRST} and ${FIRST}`, "u"));
    const how = /^Sent an? (?:network )?intro by text /.test(content) ? "intro by text" : /^Sent an? (?:network )?intro by email and text /.test(content) ? "intro by email and text" : "intro email";
    if (!m) return [];
    const other = ownFirstName && m[1] === ownFirstName ? m[2] : ownFirstName && m[2] === ownFirstName ? m[1] : null;
    if (!other) return [];
    const event = content.match(/ ahead of "([^"]{1,120})"\.?$/)?.[1];
    return [`Cue's record${day}: Cue sent one ${how} connecting them with ${other}, another member${event ? `, ahead of "${event}"` : ""}.`];
  }
  return [];
}

// Pure: their world on this reply's facts (services/memberWorld.ts): one fact line, the check-in rule, and the world itself for the
// reply check. The fact is "known": the claim read cites it like any other.
export function addMemberWorld(rf: ReplyFacts, world: MemberWorld): void {
  addFact(rf, "known", memberWorldFact(world));
  const night = lateNight(world.clock);
  addInstruction(rf, night ? CHECKIN_RULE_AT_NIGHT : CHECKIN_RULE);
  if (night) addInstruction(rf, LATE_NIGHT_CARE);
  rf.world = world;
}

// ---------------------------------------------------------------- member knowledge on a text reply (services/memberKnowledge.ts)

// Pure: the member-level rules and the knowledge a reply reads as facts, from the one layer. Discretion (deduped against the base
// facts' copy, the same constant), delivery shape, restraint (only when something is on: a hold, a pause, a muted kind, a hard time)
// and quiet hours in their zone; what they've corrected (only the new version exists); their taste. Grounding and member safety are
// the same constants in Co's shared core (agent/conversationReply.ts CO_CORE), so they aren't said twice. Text-channel rules (length,
// mirroring, reactions) stay with the reply prompt.
export function addMemberKnowledge(rf: ReplyFacts, k: MemberKnowledge | null | undefined, rules: MemberRules | null | undefined): void {
  if (rules) {
    addInstruction(rf, rules.discretion);
    addInstruction(rf, rules.deliveryShape);
    if (restraintOn(k?.restraint ?? null)) addInstruction(rf, rules.restraint);
    addInstruction(rf, `${rules.quietHours} A follow-up or a delivery you set up lands outside those hours, never inside them.`);
  }
  if (!k) return;
  // What they had removed is never named here (services/whatCoKnows.ts); the older texts in the thread may still say it.
  if (k.removedCount) addInstruction(rf, "They've asked you to forget some things they told you, and those are gone from what you know. If an earlier message in this conversation says something they asked you to forget, leave it out: never bring it up, use it or hint at it.");
}

// Pure: whether any restraint is on for them right now (otherwise its rule is only "nothing is on", and left out).
export function restraintOn(r: Restraint | null): boolean {
  return !!r && (r.safetyHold || !!r.holdUntil || !!r.spaceUntil || r.unanswered.count > 0 || r.suppressedKinds.length > 0 || r.needsCare || r.frustratedWithCo); // mood: whether the restraint rule text is shown (wording)
}

// Pure: where they're headed, from goals WITH their state: only active goals are direction (a goal they closed, or one Co set aside,
// is history, never current). The arc is the goals they closed, from their goal entries (goalJourney.ts arcLine).
export function goalLens(k: MemberKnowledge | null | undefined, intent: unknown): { texts: string[]; arc: string | null; rule: string } | null {
  if (!k) return null;
  return { texts: k.goals.filter((g) => g.state === "active" && g.text.trim()).map((g) => g.text), arc: arcLine(intent), rule: LENS_RULE };
}

// Pure: what they've told Co that still holds, rendered the way a reply reads claims (factLabels.ts renderLive), from member knowledge
// (stripped, their quotes kept). Each claim's day is the last day it was said or confirmed.
export function heldClaimsFrom(k: MemberKnowledge | null | undefined, now: Date = new Date()): ReturnType<typeof renderLive> | null {
  if (!k) return null;
  const zone = k.identity.timeZone;
  return renderLive(k.claims.filter((c) => c.text.trim()).map((c) => ({ text: c.text, provenance: c.provenance, kind: c.kind, quote: c.quote, saidOn: c.verifiedAt.slice(0, 10), confirmedOn: c.verifiedAt.slice(0, 10), expiresOn: c.expiresOn })), now, zone);
}

// Pure: when their message names a date or a stretch of time, what they've told Co that is dated around it, as one fact Co checks
// the date against (2026-10-12 intelligence audit: Co planned a Nov 14 dinner while she flies to Toronto that day, and a "first week
// of November" lunch while he's in Paris; both were in the claims, in a long list, unchecked). Facts only: Co decides what a clash
// means and whether to say it. null when the message names no date or nothing held is dated near it.
export function dateConflictFact(message: string, k: Pick<MemberKnowledge, "claims" | "identity"> | null | undefined, now: Date = new Date()): string | null {
  if (!k || !message.trim()) return null;
  const zone = wordsZone(k.identity.timeZone);
  const today = DateTime.fromJSDate(now).setZone(zone).toISODate()!;
  const asked = dateSpan(message, today, zone);
  if (!asked) return null;
  const from = DateTime.fromISO(asked.start, { zone }).minus({ days: 1 }).toISODate()!;
  const to = DateTime.fromISO(asked.end, { zone }).plus({ days: 1 }).toISODate()!;
  const fmt = (d: string) => DateTime.fromISO(d, { zone }).toFormat("ccc LLL d, yyyy");
  const near = k.claims.flatMap((c) => {
    // Only what is still going on (an ephemeral claim inside its lifetime): who they are (a city, a role) is never a date to check.
    if (!c.text.trim() || KINDS[c.kind as Kind]?.lifetime !== "ephemeral" || (c.expiresOn && c.expiresOn <= today)) return [];
    const s = dateSpan(`${c.text} ${c.quote ?? ""}`, c.saidOn.slice(0, 10), zone);
    if (!s || s.end < from || s.start > to) return [];
    const when = s.start === s.end ? fmt(s.start) : `${fmt(s.start)} to ${fmt(s.end)}`;
    return [`${c.text} (${when}; ${c.provenance === "user_said" ? "they said it" : "your read, not their words"})`];
  });
  if (!near.length) return null;
  const span = asked.start === asked.end ? fmt(asked.start) : `${fmt(asked.start)} to ${fmt(asked.end)}`;
  return `Date check: their message is about ${span}. What they've told you that is dated around then: ${near.slice(0, 5).join("; ")}. Before you plan, suggest or agree to anything for that date, check it against these: if one clashes (they're away, busy or traveling then), say so plainly and ask, rather than planning around it.`;
}

// Pure: today's date in the member's own zone, naming the zone (the fallback zone, said as such, when theirs isn't known).
export function todayFact(zone: string | null | undefined, now: Date = new Date()): string {
  const z = validZone(zone);
  return `Today is ${DateTime.fromJSDate(now).setZone(wordsZone(z)).toFormat("cccc, LLLL d, yyyy")} (their local time, ${z ?? `${wordsZone(null)}; their own zone isn't known`}).`;
}

// Pure: a heavy moment in this message: they're struggling, or a strong hard feeling right now.
export function heavyMoment(e: EmotionalContext | null | undefined): boolean { // mood: the read; decisions take it only through heavyHold
  if (!e) return false;
  return !!e.needsCare || (!!e.current && e.current.intensity === "high" && e.current.valence === "negative"); // mood: the read; decisions take it only through heavyHold
}
// Pure: whether a heavy moment holds an offer back this reply (the door, the cold-start question, a document offer): timing only, never
// cancelled (Royce, 2026-10-19: "feelings change timing and tone, never cancel"). Each stays owed and comes up in a later reply once
// they're okay again or the hard stretch reaches the cap (services/moodHold.ts, read on this message, which is them texting now); what
// goes then is drafted with the feeling block as tone. A strong hard call moment without a hard day holds while it is their current
// feeling (48 hours at most, emotion.ts current).
export function heavyHold(e: EmotionalContext | null | undefined, now: Date): MoodHold {
  if (!heavyMoment(e)) return { state: "none", hold: false, heldHours: null }; // mood: the capped hold itself
  const m = moodHold(e, { now, lastInboundAt: now });
  return m.state === "none" ? { state: "held", hold: true, heldHours: null } : m;
}
// Pure: whether frustration with Cue holds the door or the cold-start question back this reply: timing only, one capped wait per item
// (Royce, 2026-10-19: "feelings change timing and tone, never cancel"). The wait is measured from the first frustration read since the
// item was owed (owedSince), so a later stretch of frustration never starts a second one; it ends early once they're okay (this message,
// them texting now, comes 6h or more after the last frustration read, or the read clears), and at MOOD_HOLD_CAP_HOURS after it began
// even if they're still frustrated. A read without times (an older state) holds as before.
export function frustrationHold(e: EmotionalContext | null | undefined, owedSince: Date | null, now: Date): MoodHold {
  const w = e?.withCo; // mood: the capped hold itself
  if (!w?.frustrated) return { state: "none", hold: false, heldHours: null }; // mood: the capped hold itself
  const since = (w.reads ?? []).filter((t) => !owedSince || t.getTime() >= owedSince.getTime()).reduce<Date | null>((m, t) => (!m || t < m ? t : m), null);
  const heldHours = since ? Math.max(0, (now.getTime() - since.getTime()) / 3_600_000) : null;
  if (w.at && now.getTime() - w.at.getTime() >= OKAY_AFTER_HOURS * 3_600_000) return { state: "released_okay", hold: false, heldHours };
  if (heldHours !== null && heldHours >= MOOD_HOLD_CAP_HOURS) return { state: "released_cap", hold: false, heldHours };
  return { state: "held", hold: true, heldHours };
}
// Pure: since when the cold-start question has been owed: their last steer record (any outcome), or when they joined.
export function steerOwedSince(cs: Pick<ColdStartView, "history" | "joinedAt">): Date | null {
  const last = cs.history.reduce<Date | null>((m, h) => (!m || h.at > m ? h.at : m), null);
  return last ?? cs.joinedAt ?? null;
}
// Pure: Co's recent lines from the reply's context (their message, then Co's last few "Co replied:" lines).
export function coLinesIn(context: string | undefined): string[] {
  return String(context ?? "").split("\n").filter((l) => l.startsWith("Co replied:")).map((l) => l.replace(/^Co replied:\s*/, "").trim()).filter(Boolean);
}

// What a search did, written down so the next message can still say it
// honestly (2026-09-16: a search was dropped mid-turn when a newer message
// arrived, and the answer was lost with it).
export async function recordSearchNote(userId: string, note: string): Promise<void> {
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', $2)`, [userId, `[search] ${note}`])
    .catch((err: any) => console.error("recordSearchNote failed (non-fatal):", err?.message ?? err));
}

// Counts in words at the front of a search note (2026-09-26): Co read a
// note listing four misfits and said "those two were the results", and the
// claim check passed it because the note never said how many there were.
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function searchNoteLine(content: string, at: Date, today: string, zone: string | null = DEFAULT_ZONE): string {
  const d = localToday(zone, at);
  return `${d === today ? "Earlier today" : `On ${DateTime.fromISO(d).toFormat("cccc, LLLL d")}`}, ${content.replace("[search] ", "")}${d === today ? "" : " That was an earlier search: a new ask needs a new one."}`;
}

// What Co is really still looking for, from open asks. Only these make
// "I'll keep looking and text you if something fits" true: the daily sweep
// searches each open ask and the daily pick can text about a result. With
// none open, nothing is being looked for and any such promise is false.
const NOT_SEARCHING = "Cue's daily search isn't looking for anything for them right now.";
export async function addOngoingSearchFacts(rf: ReplyFacts, userId: string, asks?: { text: string; kind: "find" | "help" }[]): Promise<void> {
  if (rf.facts.some((f) => f.kind === "ongoing" || (f.kind === "unknown" && f.text.startsWith(NOT_SEARCHING)))) return;
  const open =
    asks ??
    (await pool
      .query(`SELECT ask_text, kind FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY last_mentioned_at DESC NULLS LAST, created_at DESC LIMIT 12`, [userId])
      .then((r) => r.rows.map((x: any) => ({ text: String(x.ask_text ?? ""), kind: x.kind === "help" ? ("help" as const) : ("find" as const) })))
      .catch(() => [] as { text: string; kind: "find" | "help" }[]));
  for (const f of ongoingFactsFor(open)) addFact(rf, f.kind, f.text);
}

// Pure: only asks the daily search really looks for (kind 'find', the same
// filter the sweep uses) are "ongoing". A help ask (sponsors, advice) is
// kept, not searched (2026-09-26: "I'll keep digging on that daily" about
// sponsors passed the check because every open ask was called searched).
export function ongoingFactsFor(asks: { text: string; kind: "find" | "help" }[]): { kind: FactKind; text: string }[] {
  // All of them (2026-09-26: with seven open and three listed, "I'll keep an
  // eye out" for the fourth was called unsupported).
  const find = asks.filter((a) => a.kind === "find" && a.text).slice(0, 8);
  const help = asks.filter((a) => a.kind === "help" && a.text).slice(0, 8);
  const out: { kind: FactKind; text: string }[] = [];
  if (find.length) {
    out.push({ kind: "ongoing", text: `Cue's daily search is looking for: ${find.map((a) => `"${a.text}"`).join("; ")}. If something real fits, Cue may text them about it (at most one text a day). Cue can't promise it will find anything, or when.` });
  } else {
    out.push({ kind: "unknown", text: `${NOT_SEARCHING} Nothing will be looked for later unless they ask for something a search can find.` });
  }
  if (help.length) {
    out.push({ kind: "known", text: `Also on file, but not something Cue's search looks for: ${help.map((a) => `"${a.text}"`).join("; ")}. Cue can talk it through with them now; nothing is being looked for or worked on in the background.` });
  }
  return out;
}

// Real fields only, plus the gaps stated as gaps so "I don't have that" is
// itself grounded.
export function addEventFacts(
  rf: ReplyFacts,
  match: { name: string; event_date?: string; deadline?: string; url?: string; kind?: string; details?: EventDetails; opportunity?: OpportunityDetails; whyItFits?: string; audience?: string; statedDates?: { start: string; end?: string | null }; checkedAt?: string },
  asked?: Days | null,
  zone: string | null = DEFAULT_ZONE,
): void {
  const label = match.kind === "opportunity" ? "Opportunity" : "Event";
  // Whether it's still ahead, against today (services/dateGuard.ts).
  const note = dateNote(readDates(itemDays(match, zone), localToday(zone), asked));
  addFact(rf, "known", `${label} Cue told them about: "${match.name}"${match.event_date ? `, on ${match.event_date}` : ""}${match.deadline ? `, application deadline ${match.deadline}` : ""}${note}.`);
  addFact(rf, "known", match.url ? `Link for "${match.name}": ${match.url}` : `There is no link on file for "${match.name}".`);
  // The real record (event page or source post), so "tell me more" gets
  // real answers instead of "I don't have that".
  // Its volatile lines (start, price, spots, sold out) say when they were read: past a few hours, "not checked since" (Phase B, B3).
  if (match.details) for (const line of renderDetailsAsOf(match.name, match.details, match.checkedAt ?? null, new Date(), zone)) addFact(rf, "known", line);
  addFact(rf, "known", `Cue found "${match.name}" through ${sourceOf(match)}. If they ask where it came from, say that.`);
  if (match.opportunity) addFact(rf, "known", `What the source post for "${match.name}" says: ${match.opportunity.postText}`);
  if (match.audience) addFact(rf, "known", `Who "${match.name}" is for, as Cue judged it when it found it: ${match.audience}. If you describe the event, say that plainly; never say or imply what they are.`);
  if (match.whyItFits) addHint(rf, `Why "${match.name}" may fit them (a search's read, not a fact): ${match.whyItFits}`);
  if (match.kind !== "opportunity") {
    const missing = missingEventDetails(match.name, match.details);
    if (missing) addFact(rf, "unknown", missing);
  }
}

// tail: the reply's own tail, which leaves out the snapshot's entries (the reply reads those in its cached prefix). Every other reader
// (the redraft, the share rewrite, the tools) gets them all.
export function renderReplyFacts(rf: ReplyFacts, o: { tail?: boolean } = {}): string {
  // Receipts (2026-09-25): what Co tried and didn't manage, marked so it's
  // never read as done.
  const facts = (o.tail ? rf.facts.filter((f) => !f.snap) : rf.facts).map((f) => `[${f.id}] ${f.kind === "not_done" ? `NOT DONE: ${f.text}` : f.kind === "hint" ? `YOUR READ, NOT A FACT (use for how you say it, never state it as fact): ${f.text}` : f.text}`).join("\n");
  const instr = rf.instructions.length ? `\n\nFor this reply:\n${rf.instructions.map((i) => `- ${i}`).join("\n")}` : "";
  return `What's true right now. These, plus what's actually in the conversation, are the only actions, plans, links, times, places, numbers, and things about other people you can mention. If a detail isn't here, you don't have it: say so plainly, and don't promise to get it later.
${facts}${instr}`;
}

// ---------------------------------------------------------------------------
// Gate

export type Claim = {
  text: string;
  type: "past_action" | "future_promise" | "work_status" | "time" | "place" | "link" | "other_person" | "member_life" | "count" | "capability" | "detail" | "prediction" | "offer" | "followup";
  supported: boolean;
  factId: string | null;
  quote: string | null;
};

export type GroundingSources = {
  message: string;
  recentConversation: string;
  contextSummary?: string;
  recentMemories?: string;
  // Messages Co already sent earlier in this same turn.
  sentThisTurn?: string[];
  // The ones that answered them: sentThisTurn without the holding line ("Let me look" answers nothing). Whether a stripped reply
  // can be dropped as already answered reads these (10-17: the holding line made it "nothing", and the member got the fallback).
  answeredThisTurn?: string[];
  // This turn's search found things that haven't gone out, and the reply can still redraft (agent/conversationTools.ts sendReply):
  // a reply cut to almost nothing is left empty, so the redraft goes through those finds, never the honest "not sure" line (review
  // of the finds batch, 2026-10-17: with only the holding line sent, that line went out while finds waited). Read when the strip
  // decides (afterStrip), since the check's own redrafts can outlast the window (review of #228).
  findsWaiting?: boolean | (() => boolean);
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// What a quoted support may come from: facts (never hints) and the real
// texts. The summary of them (contextSummary) and older memories are
// model-built, so they can back a detail about the member but never a claim
// about the world: an event's time or place, a count, a link, an offer, a
// follow-up, a prediction, or another person (2026-09-28).
// The member's own life is not the world (Royce, 2026-10-01): the people they
// told Co about, as they described them ("your mentor Lena"), their
// preferences and their history are member_life, which only facts and their
// own words (their texts, their "User said:" lines in memories) can back, never
// Co's summary or Co-written memories (#49 review). other_person stays a
// world claim: people outside their own life, and what anyone says, wants,
// feels, did or will do beyond what the member told Co. Before this, a mentor
// Co remembered was cut and Co said "I don't have that on file"
// (evals/memory/semanticLive.ts, relationship and cross-user).
export const WORLD_CLAIMS = new Set(["time", "place", "link", "count", "offer", "followup", "prediction", "other_person"]);

// Only the member's own words from their memories and the thread: the
// "User said:" lines. Memories also hold what Co wrote (intros, matches,
// recommendations), which can carry another member's details, so those never
// back anything (2026-10-01 review of #49: "Maya's building grid storage",
// quoted from a Co-written intro memory, passed as member_life).
export function theirOwnWords(text: string | undefined): string {
  // A text of theirs in paragraphs is one row across several lines; the lines after its first are their words too (2026-11-02: two
  // pieces of feedback sat in the later paragraphs of one text, so a claim quoting them found no support and was cut). Their text ends
  // at the next row of any kind (sourceFence.ts ROW_START): a call's follow-up, an old "Mo replied:" row, a "[Call]" note or a gap
  // marker is never theirs (the #49 rule).
  const out: string[] = [];
  let theirs = false;
  for (const l of (text ?? "").split("\n")) {
    const m = l.match(THEIR_LINE);
    if (m) {
      theirs = true;
      if (m[1].trim()) out.push(m[1].trim());
    } else if (ROW_START.test(l)) theirs = false;
    else if (theirs && l.trim()) out.push(l.trim());
  }
  return out.join("\n");
}

// "User said:", a voice memo's transcript ("User sent a voice memo:"), and a dated form ("User said on September 29, 2026:").
const THEIR_LINE = /\bUser(?: said| sent a voice memo)?(?: on [^:]{1,40})?:\s*(.*)$/i;

// Cue's own lines in the sources: its replies in the thread and what it already sent this turn.
export function cueOwnLines(src: GroundingSources): string {
  const own = (src.recentConversation ?? "").split("\n").filter((l) => /^(?:Co|Cue) replied:/.test(l));
  return norm([...own, ...(src.sentThisTurn ?? [])].join("\n"));
}
export function sourceText(rf: ReplyFacts, src: GroundingSources, claimType?: string): string {
  const realFacts = rf.facts.filter((f) => f.kind !== "hint").map((f) => f.text).join("\n");
  const memories = theirOwnWords(src.recentMemories);
  // Their life is backed by what they themselves said (facts, their texts,
  // their own lines in memories), never by Co's summary or Co's words.
  if (claimType === "member_life") return norm([realFacts, theirOwnWords(src.recentConversation), memories, src.message].join("\n"));
  const summaries = claimType && WORLD_CLAIMS.has(claimType) ? [] : [src.contextSummary ?? "", memories];
  return norm([realFacts, src.recentConversation, ...summaries, src.message, ...(src.sentThisTurn ?? [])].join("\n"));
}

// "2pm", "2:00 PM", "14:00" -> "14:00"
function clockTimes(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])/gi)) {
    let h = Number(m[1]) % 12;
    if (/^p/i.test(m[3])) h += 12;
    out.push(`${String(h).padStart(2, "0")}:${m[2] ?? "00"}`);
  }
  return out;
}

// A follow-up promise with nothing behind it, or null. A promise to keep
// looking is only true while an ask is open (the sweep really does search it),
// and never with a timing commitment. Co's own task is real scheduled work
// (services/coTasks.ts): a follow-up it describes is kept, and the claim check
// still needs it to cite that task.
export function unbackedFollowup(draft: string, rf: ReplyFacts): RegExpMatchArray | null {
  const found = followupPromiseMatch(draft);
  if (!found) return null;
  const ongoing = rf.facts.some((f) => f.kind === "ongoing");
  const timingCommitment = /\b(the second|the moment|right when|as soon as|right away|immediately|tonight|tomorrow|today|this week)\b/i.test(draft);
  const lookingOnly = /keep (looking|watching|an eye|my eyes|eyes)|on the lookout|watch(ing)? for|if (something|anything|one) (real )?(turns up|comes up|fits|shows up)/i.test(found[0] + " " + draft);
  const tasked = rf.facts.some((f) => workBacksPromise(f));
  return !tasked && !(ongoing && lookingOnly && !timingCommitment) ? found : null;
}

// Real work behind a follow-up: an open task or research brief Co is carrying, or one started this turn (a task, a promise task, or
// a research brief: researchBrief's fact said "Started researching a venue brief" and its "I'll text you the brief" was cut and then
// opened as a second, duplicate promise task, 2026-10-08 review F1).
const CARRIED_WORK = /^(?:(?:Co|Cue) is working on task #|(?:Co|Cue) is putting together research brief #|Research brief #\d+ for them, .* is finished but hasn't reached them yet)/;
export function workBacksPromise(f: Fact): boolean {
  return (f.kind === "did_this_turn" && STARTED_WORK.test(f.text)) || (f.kind === "scheduled" && CARRIED_WORK.test(f.text));
}

// Pure: the one line of what is running for them now, read from real state every turn (Royce, 2026-10-13: "The grounding rule reads
// real current state, not a hardcoded list"): open tasks (work, look-outs, promises), research briefs running or held, and what Co's
// daily search covers (services/searchCoverage.ts: every open find ask, look-outs included, and the goals the last daily run
// searched, unless their sweep is held). "Nothing is running" only when none of these is: a false status denial is the same failure
// as a false status claim (the 2026-10-13 "Nothing's running on that right now" while their look-out was being searched daily).
export const NOTHING_RUNNING_REASON = "nothing is running for it: no open task, research brief, look-out or daily search";
const NOTHING_RUNNING = /^Nothing is running for them right now:/;
const SEARCH_HELD = "Cue's daily search is paused for them right now, so nothing they asked for is being searched.";
// An ask saved this turn (agent/conversationTools.ts saveAsk): the daily search takes it from the next morning, which the
// running-work line, read before the reply, can't know yet (review of the 10-13 fixes).
const SAVED_THIS_TURN = /^(?:Co|Cue)'s daily search is now looking for/;
const savedAskThisTurn = (rf: Pick<ReplyFacts, "facts">) => rf.facts.some((f) => f.kind === "ongoing" && SAVED_THIS_TURN.test(f.text));
const searchHeld = (rf: Pick<ReplyFacts, "facts">) => rf.facts.some((f) => f.kind === "known" && f.text.includes(SEARCH_HELD));
const RUNNING_LIST = /^What is actually running for them right now/;
const SAYS_NOT_RUNNING = /\b(?:nothing|not|no|isn't|aren't|haven't|hasn't|n't)\b/i;
export function runningWorkLine(tasks: string[], briefs: string[], searching: SearchCoverage = NO_COVERAGE): string {
  const hidden = searching.hidden ? [`${searching.hidden} more piece${searching.hidden === 1 ? "" : "s"} of work or search Cue has going for them (details not shown here)`] : [];
  // The same items the member-world read lists as running (services/memberWorld.ts runningItems), so the two never disagree.
  const running = runningItems(tasks, briefs, searching).map((r) => r.label);
  running.push(...hidden);
  // Never the hold's reason (a safety hold, an opt-out): only that it's paused, which Co doesn't explain.
  const held = searching.held.length ? ` ${SEARCH_HELD} Don't explain why or name a reason.` : "";
  if (!running.length) return `Nothing is running for them right now: no open task, research brief, look-out or daily search.${held} Anything else they asked for is saved, not being worked on. If they ask how something is going, say plainly that nothing is running on it and offer to start it now; never say Cue is digging into, working on, looking into or searching for it.`;
  return `What is actually running for them right now (only these can be described as being worked on or searched for): ${running.join("; ")}.${held} When they ask what Cue is doing or searching for, describe these plainly, in their terms. Anything else they asked about is saved, not being worked on: if they ask about that one, say nothing is running on it and offer to start it.`;
}
// Pure: does the turn's running-work line say nothing at all is running? Only then is the canned line literally true.
export function nothingRunsAt(rf: Pick<ReplyFacts, "facts">): boolean {
  if (savedAskThisTurn(rf) && !searchHeld(rf)) return false;
  return rf.facts.some((f) => f.kind === "known" && NOTHING_RUNNING.test(f.text));
}

// Pure: "nothing's running on that, it's just saved on my end" is the true status when the turn's running-work line says nothing
// runs (item 3, live check: the narration rule cut it for "on my end", leaving only the offer). Never a claim that work is running.
// Work started this turn (a task or research) means something is running now: neither the allowance nor the line applies.
const startedThisTurn = (rf: Pick<ReplyFacts, "facts">) => rf.facts.some((f) => f.kind === "did_this_turn" && STARTED_WORK.test(f.text));
// A search Cue ran in this turn, from the receipt its own tool wrote (agent/loopTools.ts: webSearch, searchEvents). It backs saying
// what Cue just did ("I looked just now and found nothing that works"), never that a search is still running.
export const SEARCHED_THIS_TURN = /^(?:Searched the web just now \(|Looked up events for "[^"]*"[^:]* just now:)/;
const searchedThisTurn = (rf: Pick<ReplyFacts, "facts">) => rf.facts.some((f) => f.kind === "did_this_turn" && SEARCHED_THIS_TURN.test(f.text));
// A search claim is backed by this turn's receipt only when Cue's own wording says it as done (an allowlist: review of 4e042fdb found
// "I’m looking now", "Working on it", "Give me a minute" slipping past a list of ongoing words), and nothing in it says the work goes on.
const SAYS_DONE = /\b(?:looked|searched|checked|dug|tried|went through|had a look|ran a search|did a search)\b/i;
const SAYS_ONGOING = /\b(?:still|keep(?:s|ing)?|ongoing|currently|in the background|will|going to|on it|give me|a (?:minute|sec(?:ond)?|moment)|more soon|soon|hang tight|stand by|tonight|tomorrow|later|back to you|another (?:pass|look|try|round)|more to come|next)\b|\b(?:look|search|digg?|check|hunt|find|try)ing\b|\bI'(?:ll|m)\b|\bI am\b/i;
export const saysSearchDone = (claim: string): boolean => { const t = claim.replace(/[’‘]/g, "'"); return SAYS_DONE.test(t) && !SAYS_ONGOING.test(t); };
export function honestNothingRunning(rf: Pick<ReplyFacts, "facts">, sentence: string): boolean {
  return !startedThisTurn(rf) && nothingRunsAt(rf) && /\bnothing(?:'s| is)\s+(?:actually\s+|actively\s+|really\s+)?(?:running|being worked|in motion)\b/i.test(sentence) && !/\b(?:still|digging|working on|looking into|searching)\b/i.test(sentence);
}

// The honest line that replaces a cut "still working on it" (item 3): said once, never on top of one that already says it.
export const NOTHING_RUNNING_LINE = "Nothing's running on that right now. Want me to start on it?";
// Royce, 2026-10-13: the line fires only when it is literally true (the running-work line says nothing at all is running: no task,
// brief, look-out or daily search), and it never adds a second offer. Whether what's left already offers or asks anything is read
// whatever its wording (offersAlready): the old word list missed "Want me to turn it back on?" and the offer went out twice.
export async function withNothingRunningLine(final: string, failed: GateCheck[], rf?: Pick<ReplyFacts, "facts">, offers: (text: string) => Promise<boolean> = offersAlready): Promise<string> {
  if (!failed.some((c) => c.name === "claim_work_status")) return final;
  // Cue searched in this turn: "nothing's running" would deny it (the receipt is what Cue did, the line would contradict it).
  if (!rf || !nothingRunsAt(rf) || startedThisTurn(rf) || searchedThisTurn(rf)) return final;
  if (/\bnothing(?:'s| is)\s+(?:actively\s+)?(?:running|being worked|in motion)\b/i.test(final)) return final;
  const [honest] = NOTHING_RUNNING_LINE.split(". ");
  // What's left already offers or asks something: the honest part goes first, and no second offer.
  if (final.trim() && (await offers(final))) return `${honest}. ${final.trim()}`;
  return [final.trim(), NOTHING_RUNNING_LINE].filter(Boolean).join(final.includes("\n\n") ? "\n\n" : " ");
}

// Does this reply already offer to do something or ask them anything, in any wording? Any question already asks; otherwise one short
// read. When the read fails it counts as yes: a missing offer costs less than a second one.
export async function offersAlready(text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  try {
    const { text: out } = await generateText({
      model: anthropic(MODELS.haiku),
      maxOutputTokens: 10,
      abortSignal: AbortSignal.timeout(3000),
      experimental_telemetry: { isEnabled: true, functionId: "offersAlready" },
      prompt: `A text a companion is about to send:\n"""${t.slice(0, 800)}"""\n\nDoes it already offer to do something for them, or ask them to decide or answer anything, in any wording ("I can start it if you like", "say the word and I'll look", "let me know if you want it back on")? Answer only yes or no.`,
    });
    return !/^\s*no\b/i.test(out);
  } catch {
    return true;
  }
}

// Deterministic checks that don't need a model.
// Promises of a later action Co makes on its own. Offers to use a real tool
// ("I can save it if you want", "want me to look?") aren't promises.
export function followupPromiseMatch(text: string): RegExpMatchArray | null {
  const promise = text.match(
    // "If one turns up, I'll text you" (conditional first) is the same promise.
    /\b(?:if|when|once|as soon as)\b[^.?!]{0,80}\b(?:i'?ll|i will)\s+(?:text|send|ping|message|let)\s+you\b|\b(i'?ll|i will|let me|will)\s+(keep (an eye out|watching|looking|searching|checking)|flag (it|that|one)|circle back|follow up|get back to you|let you know|text you (when|once|as soon|the moment|if)|track (it|that|one) down|find out|look into|reach out to|send (it|one|the link) (when|once|as soon)|send (it|one|them|that) your way|pass (it|one|that) along|ping you|be in touch)\b/i,
  );
  if (promise) return promise;
  const later = text.match(/\b(i'?ll|i will)\b[^.?!]{0,60}\b(let you know|get back to you|follow up|circle back|report back|keep you posted|update you)\b/i);
  if (later) return later;
  // Phrasings the lists above missed (2026-10-03: "I'll flag the second someone turns up", "I'll come back the moment"; services/promises.ts).
  const concrete = text.match(PROMISE_RE);
  if (concrete) return concrete;
  const lookout = text.match(/\b(keep (my|an|our) eyes? (open|out|peeled)|keep (watching|looking|an eye out)|be on the lookout|watch(ing)? for (one|it|something|that)|text you (the second|the moment|right when|as soon as))\b/i);
  if (lookout) {
    const sentence = text.split(/(?<=[.!?])\s+/).find((x) => x.includes(lookout[0])) ?? "";
    if (/\b(if you want|want me to|should i|would you like)\b/i.test(sentence) && !/\b(i'?ll|i will)\b/i.test(sentence)) return null;
    return lookout;
  }
  return null;
}

// Phrasings that forecast whether something will turn up, sell out, or happen.
// Promising a result Co can't guarantee, as opposed to an action it will take
// (Royce, 2026-09-30: "I'll get you real options before Friday", said before any
// search had found one). "I'll look at indoor spots and text you Thursday" is fine.
export function resultPromiseMatch(text: string): RegExpMatchArray | null {
  return (
    text.match(/\b(?:i'?ll|i will|i'?m going to|going to)\b[^.!?\n]{0,60}?\b(?:get|have|find|land|line up|pull together|bring|hand|round up)\s+you\s+(?:[a-z]+\s+){0,5}?(?:options?|venues?|choices|picks|spots|caterers?|djs?|leads|matches|people|results|places)\b/i) ??
    text.match(/\byou'?ll have (?:[a-z]+\s+){0,4}?(?:options?|venues?|choices|picks|spots|leads|matches)\b/i) ??
    text.match(/\b(?:i'?ll|i will)\b[^.!?\n]{0,30}?\b(?:dig up|find|pull together|line up|round up|get)\s+(?:a couple of|some|two|three|a few)\s+(?:[a-z]+\s+){0,3}?(?:options|venues|choices|picks|spots|caterers|djs|leads)\b/i)
  );
}

export function predictionMatch(text: string): RegExpMatchArray | null {
  return text.match(
    /\b(?:is|are)(?:n'?t| not) (?:going to|gonna|likely to) (?:materialize|turn up|show up|come up|pop up|happen|open up)\b|\bwon'?t (?:materialize|turn up|show up|come up|pop up|open up)\b|\b(?:probably|likely) (?:won'?t|will not|isn'?t going to|is going to|will) (?:be|turn up|show up|come up|pop up|sell out|fill up|happen|open)\b|\bi don'?t (?:think|expect|see) (?:a|another|any|anything|something|one|more|a separate)\b[^.?!]{0,40}\b(?:going to|gonna|will|turn up|show up|come up|pop up|materialize|happen)\b|\b(?:is|are) going to (?:sell out|fill up)\b|\b(?:probably|likely) (?:sell|fill) (?:out|up)\b|\b(?:it|this|that|they)'?ll (?:probably |likely )?(?:sell out|fill up)\b|\bnothing (?:else )?(?:is|'s) (?:going to|gonna) (?:come|turn|show|pop)\b/i,
  );
}

// Co offering, promising or claiming a group text/chat. Co can't start one
// (Sendblue can only reply to a number that has already texted in), and
// group chats were taken out of the product on 2026-09-20. An honest "I can't
// do a group text" is fine, so a denial anywhere near the words clears it.
const GROUP_CHAT_WORDS = /\bgroup\s*(?:text|chat|thread|message|imessage)s?\b/i;
const GROUP_CHAT_DENIAL = /\b(?:can'?t|cannot|can not|don'?t|do not|won'?t|never|not able|unable|no way|doesn'?t|isn'?t|not something)\b[^.?!]{0,60}\bgroup\b|\bgroup\b[^.?!]{0,60}\b(?:isn'?t|is not|not something|off the table|not an option)\b/i;
export function claimsGroupChat(text: string): boolean {
  return GROUP_CHAT_WORDS.test(text) && !GROUP_CHAT_DENIAL.test(text);
}

// Co saying it's sending, adding, or getting someone an INVITE, now or soon.
// The verb alone isn't enough: "I'll send the details once I have them" about
// a dress code was being stripped and answered with invite copy (2026-09-20
// code review), so the sentence has to name the invite itself.
const INVITE_NOUN = /\b(invite|invites|invitation|invite code|invite link)\b/i;
const INVITE_ACTION_VERB =
  /\b(sending|sent|i'?ll (send|add|invite|get)|i can (add|invite|do that|get)|adding (her|him|them)|let'?s get|getting (her|him|them|you)|here'?s (an|your|the)|on (its|it'?s) way)\b/i;


// "Here you go", "here it is", "just sent it": words that only make sense
// right after handing something over. Pointing back at something sent on an
// earlier turn ("already sent it above", "the link I sent you a few minutes
// ago") isn't a handover; that's checked by the claim reader against what
// was really sent (2026-09-26: two true replies were rewritten).
export function claimsHandingOver(draft: string): boolean {
  return /\b(here you go|there you go|here it is|here'?s (my|the|your) (card|contact|number|link|info)|just sent (it|that|you|over)|sending (it|that) (now|over)|attached)\b/i.test(draft);
}

// Co offering to send a link (2026-10-03: "send it" twice and nothing to send).
// An offer needs a link on file somewhere in what Co has this turn: its facts,
// the thread, what it already sent.
export const LINK_OFFER = /\b(?:want|like)\s+(?:me\s+to|the|a)\s+(?:send|share|text|drop)\b[^.?!]{0,30}\b(?:link|site|website|page)\b|\b(?:i(?:'|\u2019)ll|i\s+will|i\s+can|let\s+me)\s+(?:send|share|text|drop)\s+(?:you\s+)?(?:the|a|their|its)\s+(?:link|site|website|page)\b/i;
export function offersLinkWithoutOne(draft: string, available: string): string | null {
  // Co makes invite links itself (the invite tool), so offering one needs no link on file.
  if (/\binvite\b/i.test(draft)) return null;
  const m = draft.match(LINK_OFFER);
  return m && !/https?:\/\//i.test(`${available}\n${draft}`) ? m[0] : null;
}

// One small read for the sentences that name their thread (services/memberWorld.ts threadCandidates), batched per reply, each sentence
// asked once a turn: does it state where the thread stands, rather than advice, a plan or what they told Co? Only a clear yes cuts
// (codeChecks no_thread_report); a read that fails or doesn't parse keeps every sentence, and the claim check still guards facts.
export type ThreadJudge = (prompt: string) => Promise<string>;
const THREAD_READ_TIMEOUT_MS = 6_000;
const haikuThreadJudge: ThreadJudge = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 60, abortSignal: AbortSignal.timeout(THREAD_READ_TIMEOUT_MS), experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.thread_read" }, prompt })).text;
export async function judgeThreadReports(draft: string, rf: ReplyFacts, src: Pick<GroundingSources, "message">, judge: ThreadJudge = haikuThreadJudge): Promise<void> {
  const name = rf.world?.thread?.name;
  if (!name) return;
  const T: ThreadReads = (rf.thread ??= { judged: new Map(), pending: new Map(), reads: [] });
  const candidates = [...new Set(threadCandidates(rf.world, draft))].filter((s) => !T.judged.has(threadKey(s)));
  const waits = candidates.map((s) => T.pending.get(threadKey(s))).filter((p): p is Promise<void> => !!p);
  const ask = candidates.filter((s) => !T.pending.has(threadKey(s)));
  if (!ask.length) {
    await Promise.all(waits);
    return;
  }
  const read = (async () => {
    const t0 = Date.now();
    let reports: number[] | null = null;
    try {
      const out = parseModelJson<{ reports?: unknown }>(await judge(threadReadPrompt(name, src.message, ask, rf.world?.theirWords ?? [])));
      if (Array.isArray(out?.reports)) reports = out.reports.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= ask.length);
    } catch {
      reports = null;
    }
    ask.forEach((s, i) => T.judged.set(threadKey(s), !!reports?.includes(i + 1)));
    T.reads.push({ sentences: ask, reports, ms: Date.now() - t0 });
  })();
  for (const s of ask) T.pending.set(threadKey(s), read);
  await Promise.all([read, ...waits]).finally(() => ask.forEach((s) => T.pending.delete(threadKey(s))));
}

export function codeChecks(draft: string, rf: ReplyFacts, src: GroundingSources): GateCheck[] {
  const emotionLabel = checkNoEmotionLabel(draft);
  const checks: GateCheck[] = [];
  // Links and times come only from real facts and texts, never hints or summaries.
  const sources = sourceText(rf, src, "link");
  const rawSources = [rf.facts.filter((f) => f.kind !== "hint").map((f) => f.text).join("\n"), src.recentConversation, src.message, ...(src.sentThisTurn ?? [])].join("\n");
  const phoneSources = [rawSources, src.contextSummary ?? "", src.recentMemories ?? ""].join("\n");

  for (const url of draft.match(/https?:\/\/[^\s)]+/gi) ?? []) {
    const u = url.replace(/[.,!?]+$/, "");
    checks.push({ name: "link_on_file", pass: sources.includes(norm(u)), reason: `link ${u}` });
  }
  const dangling = offersLinkWithoutOne(draft, rawSources);
  if (dangling) checks.push({ name: "no_link_offer_without_link", pass: false, reason: `offers a link Cue doesn't have: "${dangling}"` });
  const again = repeatQuestionCheck(draft, src.recentConversation);
  if (!again.pass) checks.push(again as GateCheck);
  for (const phone of draft.match(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g) ?? []) {
    const digits = phone.replace(/\D/g, "");
    checks.push({ name: "phone_on_file", pass: phoneSources.replace(/\D/g, "").includes(digits), reason: `phone number ${phone}` });
  }
  const knownTimes = new Set(clockTimes(rawSources));
  for (const t of clockTimes(draft)) {
    checks.push({ name: "time_on_file", pass: knownTimes.has(t), reason: `time ${t}` });
  }
  // Who's in a room Co doesn't run is unknowable (2026-09-28: "go find the
  // llama_index people, that's your crowd"); only a guest-list fact backs it.
  if (crowdClaim(draft) && !rf.facts.some((f) => f.kind !== "hint" && /\b(guest list|who'?s going|attending|RSVP'?d|registered guests)\b/i.test(f.text))) {
    checks.push({ name: "no_crowd_claim", pass: false, reason: "says who'll be at an event or that they're their people, with no guest list on file" });
  }
  // A clash needs both start times (2026-09-28: "same night, so it's one or
  // the other" with only the Grok Bot time known).
  if (clashClaim(draft) && new Set(clockTimes(rf.facts.filter((f) => f.kind !== "hint" && /\bstarts?\b/i.test(f.text)).map((f) => f.text).join("\n"))).size < 2) {
    checks.push({ name: "no_unknown_clash", pass: false, reason: "says two events clash without both start times" });
  }
  if (/\b((calling|ringing|dialing) you (right )?now|i'?m (calling|ringing|dialing) you|still (calling|ringing|dialing) you)\b/i.test(draft)) {
    checks.push({ name: "no_call_placed_claim", pass: false, reason: "says a call is happening, but this reply never places one" });
  }
  // "You've been prepping X" / "you told me X" must trace to something THEY said recently (this message, the recent thread's user lines,
  // a live claim they made) or a fact this reply was given: never to Co's own earlier texts, and never to an old memory whose moment
  // has passed (2026-10-06, "What's Friday?": Co defended "the pitch you've been prepping" from its own earlier message).
  {
    const theirs = [theirOwnWords(src.recentConversation), src.message].filter(Boolean).join("\n");
    // Capability notes describe what Co can do ("can't find investors"), not what the member said: they back nothing here.
    const given = rf.facts.filter((f) => f.kind !== "hint" && f.kind !== "capability").map((f) => f.text).join("\n");
    const bad = attributedWithoutSource(draft, { their_own_words_recently: theirs, facts_given: given });
    if (bad.length) checks.push({ name: "no_unsourced_attribution", pass: false, reason: `states back as theirs something they did not say lately: "${bad[0].text}". If they ask what you meant, say where it came from (what they said, and when) or that you have nothing from them on it; never defend your own earlier text as the source` });
  }
  if (callDenial(draft)) {
    checks.push({ name: "no_capability_denial", pass: false, reason: "says Cue can't call, which is false" });
  }
  // An invite said to be sent or on its way when this turn's invite step
  // didn't send one (2026-09-19: "send my friend a code" drafted "Sending
  // that now, one sec."). Only the invite step (services/invites.ts) sends
  // invites, and it adds "texted them an invite link" to the facts when it does.
  // Only when the turn is really about a Co invite. "What's the dress code?"
  // and "should I join that founders group?" are not (2026-09-20 code review:
  // both were being rewritten into invite copy). A plain ask counts, and so
  // does invite/code wording aimed at a specific person.
  const aboutSomeoneElse = /\b(friend|sister|brother|coworker|co-worker|colleague|partner|wife|husband|someone|somebody|buddy|roommate|cousin)\b/i.test(src.message);
  const inviteWording = /\binvit|\bcodes?\b|\bwants? in\b/i.test(src.message);
  const inviteAsk = isInviteRequest(src.message) || (inviteWording && aboutSomeoneElse);
  // Already handled this turn: a link went out, the count was given, or they
  // were told there are none left. Any of those means no claim to police.
  // What happened this turn, not what Co can do (2026-09-26: a capability
  // line mentioning "how many invites they have left" counted as handled).
  const inviteHandled = rf.facts.some((f) => f.kind !== "capability" && /texted them an invite link|how many invites they have left|invites are used/i.test(f.text));
  // Handing something over when nothing went out this turn (2026-09-24,
  // real incident: "Here you go, Jacqueline. Save it so I'm easy to find."
  // with no contact card sent). A card or a link sent by the reply's own
  // tools counts, and so does anything the turn itself sent first (a search
  // result's link, an intro email), which it records as a "Sent ..." fact.
  // Co's own reply texts don't.
  const handedOver =
    (src.sentThisTurn ?? []).some((m) => m === "[sent Cue's contact card]" || /^https?:\/\//i.test(m.trim())) ||
    rf.facts.some((f) => f.kind === "did_this_turn" && /\bsent\b/i.test(f.text));
  // A link inside the reply is itself the handover (link_on_file checks it).
  const refusedHandover = rf.facts.some((f) => f.kind === "not_done" && /\b(card|link)\b/i.test(f.text));
  if ((!handedOver || refusedHandover) && !/https?:\/\//i.test(draft) && claimsHandingOver(draft)) {
    checks.push({ name: "no_handover_claim", pass: false, reason: "says something was sent or handed over, but nothing was sent this turn" });
  }
  if (claimsGroupChat(draft)) {
    checks.push({
      name: "no_group_chat_claim",
      pass: false,
      reason: "offers or claims a group text, which Cue can't do. Introductions go out as one email to both people once both have said yes",
    });
  }
  // Per sentence, and Co has to be the one sending (2026-09-22: advice about
  // their own event, "have a few founders send invites", was read as Co
  // claiming a membership invite and the whole reply became invite copy).
  const namesAnInvite = (draft.match(SENTENCES) ?? [draft]).some(
    (s) =>
      INVITE_NOUN.test(s) &&
      INVITE_ACTION_VERB.test(s) &&
      (/\b(i|i'?m|i'?ve|i'?ll|me|co|cue)\b/i.test(s) || /^\s*(sending|sent|adding|getting)\b/i.test(s) || /\bhere'?s (an|your|the) invit|\binvit\w* (is |'s )?on (its|it'?s) way/i.test(s)),
  );
  if (!inviteHandled && (namesAnInvite || (inviteAsk && INVITE_ACTION_VERB.test(draft)))) {
    checks.push({
      name: "no_invite_sent_claim",
      pass: false,
      reason: "says an invite is sent or on its way, but none went out this turn. Tell them to ask Cue for an invite for their friend; don't offer, promise or claim one",
    });
  }
  // Forecasts about what will or won't turn up, which Co can't know
  // (2026-09-16: "I don't think a separate one is going to materialize by
  // Saturday"). Co says what it found and whether it's still looking instead.
  const prediction = predictionMatch(draft);
  if (prediction) checks.push({ name: "no_prediction", pass: false, reason: `predicts what will happen: "${prediction[0]}"` });
  const promisedResult = resultPromiseMatch(draft);
  if (promisedResult) checks.push({ name: "no_result_promise", pass: false, reason: `promises a result, not an action: "${promisedResult[0]}"` });
  // Follow-up promises nothing in the code keeps: no job texts them when a
  // link turns up or when the other person answers (an intro goes out by
  // email, not a text from Co).
  const found = unbackedFollowup(draft, rf);
  if (found) {
    checks.push({ name: "no_followup_promise", pass: false, reason: `promises a follow-up nothing will do: "${found[0]}"` });
  }
  if (!emotionLabel.pass) checks.push(emotionLabel);
  // Co's own state said aloud ("still digging", "hit a limit on my end", "working on it"): the same rule calls and proactive texts
  // are held to (services/speakable.ts). Cut like any failed check, redrafted when too little is left (2026-10-08 review F11).
  // "It hasn't come through on my end" is about the file they sent, not Co's machinery: allowed when their file record says nothing
  // readable arrived (services/inboundFile.ts, 2026-10-10 rows 10405/10410), the same fact that backs it in claimChecks below.
  const nothingReadable = recordSaysNothingReadable(rf.facts);
  // A line about their world that names an item on file isn't machinery (services/memberWorld.ts worldLineAllowed, Royce 2026-10-14);
  // the claim read below still holds it to the facts.
  const narrated = narratesInternalState(draft, { allow: (sentence) => (nothingReadable && arrivalDenial(sentence)) || admittedSentence(rf, sentence) || honestNothingRunning(rf, sentence) || worldLineAllowed(rf.world, sentence) || failureBackedSentence(rf, sentence) });
  if (narrated) checks.push({ name: "no_internal_narration", pass: false, reason: `narrates Cue's own state instead of what they get (${narrated})` });
  // Their thread is asked about, never reported (Royce, 2026-10-14): Co has no record of where it stands. Only a sentence the thread
  // read said reports its status is cut (judgeThreadReports, run before this); a read that failed or never ran keeps it. Quoted, so
  // stripUnsupported cuts exactly that sentence.
  for (const s of threadCandidates(rf.world, draft)) {
    if (rf.thread?.judged.get(threadKey(s)) === true) checks.push({ name: "no_thread_report", pass: false, reason: `thread_report: "${s}" (says where their thread stands; only they know, so ask)` });
  }
  // A stored spot count, time or price said as current when every fact behind it is marked stale (Phase B, B3, services/asOf.ts):
  // say it as of its read, or it's cut. The sentence is quoted so stripUnsupported cuts exactly it.
  for (const s of staleCurrentClaims(draft, rf.facts.filter((f) => f.kind !== "hint").map((f) => f.text))) {
    checks.push({ name: "no_stale_as_current", pass: false, reason: `detail: "${s.sentence}" (states a stored detail as current; it was last read earlier, so say when, or check it live)` });
  }
  // A change said as made, or something Cue says it does from now on, needs a tool that changed something this turn (2026-10-31:
  // "Got it, switching to SF from here on out." went out with only a note for the team behind it). Quoted, so stripUnsupported cuts
  // exactly that sentence; with a real receipt the claim read still holds the sentence to what that receipt says.
  // Something it keeps doing "from now on" may also stand on work already running for them (the daily search of an open ask); a
  // change needs this turn's receipt.
  const changed = lastingChangeThisTurn(rf);
  const running = changed || rf.facts.some((f) => f.kind === "ongoing" || f.kind === "scheduled");
  for (const c of changeClaims(draft)) {
    if (c.kind === "change" ? changed : running) continue;
    checks.push({ name: "no_unbacked_change", pass: false, reason: `change: "${c.sentence}" (says Cue changed something or does it from now on, but nothing was changed this turn: say plainly it isn't changed)` });
  }
  return checks;
}

// Cue saying it changed how it works for them, or what it does from now on, in its own voice (regex over Cue's draft only, never their
// message). A change is one of:
//   - Cue the one making it: "I've moved your searches to SF", "I'll move the dinner to Thursday" ("let me" is talk, not a change:
//     "Let me switch over to your calendar question");
//   - a change onto something of theirs: "Switched your searches over to SF", "Let me move your searches to SF";
//   - a change said as lasting: "Got it, switching to SF from here on out." (the 10-31 reply), "Your searches move to SF from now on".
//   - "we" making it, onto something of theirs or said as lasting: Cue speaks as "I", so its "we" is Cue ("We moved your searches to SF
//     from now on"). Only with "your" or the marker: "we" alone may be them and someone else.
// A bare switch on its own is advice or pointing ("Swap it to this: ...", "switching to the Friday one: <link>"), never a change.
// "From now on" with Cue as the one doing it ("From now on I'll keep it short") is something Cue says it does from now on.
// Not advice to them ("going forward, it might help to..."), not their own move ("Moving to SF is huge").
const GOING_FORWARD = /\b(?:from (?:here|now) on(?: out)?|going forward|moving forward|for now on|from this point(?: on)?|from today on|starting (?:now|today|tomorrow))\b/i;
const CUE_ACTS = /\b(?:i|i'?ve|i have|i'?m|i am|i'?ll|i will|i just|cue)\b/i;
// The verbs of a change, and a clause that is advice or someone else's doing ("it might help to change your pitch to...", "you could
// move it to Thursday"), never Cue's. "Moving forward" is a marker, not a move.
const CHANGE_VERB = String.raw`(?:switch(?:es|ed|ing)?|swap(?:s|ped|ping)?|chang(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|mov(?:e|es|ed|ing)(?!\s+(?:on|forward)\b)|shift(?:s|ed|ing)?|set(?:s|ting)?(?!\s+(?:you\s+)?up\b)|redirect(?:s|ed|ing)?)\b(?!\s+gears)`;
const NOT_CUES = String.raw`(?<!\b(?:to|could|might|should|would|can|you|you'll|you'd|you're|they|we)\s)`;
// Onto something of theirs: "Let me move your searches to SF", "Switched your searches over to SF" (not "switch over to your question").
const CHANGE_YOURS = new RegExp(String.raw`${NOT_CUES}\b${CHANGE_VERB}\s+(?:over\s+)?your\b[^.?!]{0,40}?\b(?:to|over|for)\b`, "i");
// Said as lasting, with the "from now on" kin in the sentence: "switching to SF from here on out", "Your searches move to SF from now on".
const CHANGE_ONTO = new RegExp(String.raw`${NOT_CUES}\b${CHANGE_VERB}[^.?!]{0,40}?\b(?:to|over)\b`, "i");
const CUE_CHANGES = /\b(?:i|i'?ve|i have|i'?m|i am|i'?ll|i will|i just|cue(?:'s| is| has| will)?)\s+(?:just\s+|now\s+|already\s+|go(?:ing)? to\s+|gonna\s+)?(?:switch(?:ed|ing)?|swap(?:ped|ping)?|chang(?:e|ed|ing)|updat(?:e|ed|ing)|mov(?:e|ed|ing)(?!\s+on\b)|shift(?:ed|ing)?|set(?:ting)?(?!\s+(?:you\s+)?up\b)|redirect(?:ed|ing)?)\b(?!\s+gears)[^.?!]{0,40}?\b(?:to|over)\b/i;
const WE_CHANGE = String.raw`\bwe(?:'ve|'ll|'re|\s+have|\s+will|\s+are)?\s+(?:just\s+|now\s+|already\s+|go(?:ing)?\s+to\s+|gonna\s+)?${CHANGE_VERB}`;
const WE_CHANGES_YOURS = new RegExp(String.raw`${WE_CHANGE}[^.?!]{0,40}?\byour\b`, "i");
const WE_CHANGES = new RegExp(WE_CHANGE, "i");
// change: a change said as made or being made. forward: something Cue says it does from now on.
export function changeClaims(draft: string): { sentence: string; kind: "change" | "forward" }[] {
  return (draft.match(SENTENCES) ?? [])
    .map((x) => x.trim())
    .filter((x) => x && !/\?\s*["')\]]*$/.test(x))
    .flatMap((x): { sentence: string; kind: "change" | "forward" }[] =>
      CUE_CHANGES.test(x) || CHANGE_YOURS.test(x) || WE_CHANGES_YOURS.test(x) || ((CHANGE_ONTO.test(x) || WE_CHANGES.test(x)) && GOING_FORWARD.test(x)) ? [{ sentence: x, kind: "change" }] : GOING_FORWARD.test(x) && CUE_ACTS.test(x) ? [{ sentence: x, kind: "forward" }] : [],
    );
}
// A tool that changes a setting or a record went through this turn (any tool not in services/capabilities.ts CHANGES_NOTHING, recorded
// by the guard). A search, a send or a note for the team changed nothing, so it backs no change.
export function lastingChangeThisTurn(rf: Pick<ReplyFacts, "changedBy">): boolean {
  return (rf.changedBy?.length ?? 0) > 0;
}

function extractJson(text: string): any {
  try {
    return parseModelJson(text);
  } catch {
    return null;
  }
}

// This turn's receipts, listed again for the claim check so a paraphrase of what a tool just did is read as backed (2026-10-12
// audit: "passed along to the team" was cut 1s after saveFeedbackForTeam saved it).
// Only what happened: a receipt saying something didn't (no call scheduled, a failed send) is never listed here, so it can't back a
// claim that it did (2026-10-12 review).
export function receiptsForCheck(rf: ReplyFacts): string {
  return rf.facts.filter((f) => f.kind === "did_this_turn" && !NEGATIVE_RECEIPT.test(f.text)).map((f) => `[${f.id}] ${f.text}`).join("\n");
}
// A failure is its own kind (not_done). Only a did_this_turn receipt that leads with the failure is one too ("No call was scheduled",
// "Trying X failed", "...didn't send"); a word inside a real receipt ("it isn't listed anywhere", "Nothing was sent to a@b.com" on a
// draft) never makes it negative (2026-10-12 review).
export const NEGATIVE_RECEIPT = /^\s*No\b|^\s*Trying\b.*\bfailed\b|\bdidn'?t send\b/i;

// Something on record (not a receipt that it failed) says Co sent or did a thing; then an admission is left to the model's read.
function doneOnRecord(facts: Fact[]): boolean {
  return facts.some((f) => f.kind !== "not_done" && f.kind !== "hint" && /\b(sent|delivered|texted|emailed|went out|saved|made them)\b/i.test(f.text) && !NEGATIVE_RECEIPT.test(f.text));
}

// An admission and nothing else is a judgment about meaning, so a small model reads it (2026-10-12 review: clause regexes let
// "I never sent it because Jordan already has your number" through). The cheap pre-filter: only a claim with a negation or an
// ownership word is ever asked about. Fails closed: no answer means the claim gets the normal check.
export const MAY_ADMIT = /\b(never|nothing|not|no|didn'?t|did not|wasn'?t|was not|hasn'?t|has not|haven'?t|have not|couldn'?t|could not|isn'?t|won'?t|can'?t|cannot|sorry|my fault|my mistake|my bad|on me)\b/i;
export type AdmissionJudge = (prompt: string) => Promise<string>;
// A one-word read: well under the claim check's cap, so it can't stall a reply.
const ADMISSION_TIMEOUT_MS = 8_000;
const haikuAdmission: AdmissionJudge = async (prompt) =>
  // Sized for the answer; Haiku 5.x's thinking room is added at the fetch layer (thinkingRoom.ts).
  (await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 40, abortSignal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS), experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.admission" }, prompt })).text;
// Pure: the question.
export function admissionPrompt(claim: string): string {
  return `Cue, a texting companion, is about to send this line:
"${claim}"

Does this line assert anything that happened or is true (an action, a state, or a fact about anyone, including Cue or another person) beyond Cue admitting that something did NOT happen (including that it tried and couldn't: "I couldn't reach them"), or owning a mistake ("that's on me", "sorry", "you're right")? A reason or an aside that states a fact ("because Jordan already has your number", "since Ellis got it first") counts as asserting something. Saying something was flagged, reported, logged or passed on (to the team or anyone) is asserting an action, never only an admission.

Return ONLY JSON: {"onlyAdmission": true} if the line only admits something didn't happen and/or owns it, else {"onlyAdmission": false}.`;
}
// Pure: the question for a line that cites what failed (services/turnFailure.ts). The admission question above counts a reason or a
// stated fact as asserting something, which cut the instructed dial-failure line ("…and asking again right now won't help") and a plain
// cause ("The phone service I call through turned it down"). This one asks only what the failure fact can back: the failure, its cause,
// and what it means for them, and never anything Cue did about it.
export function failureLinePrompt(claim: string): string {
  return `Cue, a texting companion, is about to send this line about a failure on its own side (a call that didn't go through, or an answer that broke):
"${claim}"

Does this line only describe the failure, its cause, or what it means for them (for example that asking again right now won't help, or that it's nothing they did), without saying Cue did something about it (flagged, reported, logged, fixed, escalated or passed it on, to the team or anyone)?

Return ONLY JSON: {"onlyDescribes": true} if it only describes the failure, its cause or what it means for them, else {"onlyDescribes": false}.`;
}
const failureLineCache = new Map<string, boolean>();
export async function judgeFailureLine(claim: string, judge: AdmissionJudge = haikuAdmission): Promise<boolean | null> {
  const key = claim.trim();
  if (failureLineCache.has(key)) return failureLineCache.get(key)!;
  try {
    const out = parseModelJson<{ onlyDescribes?: unknown }>(await judge(failureLinePrompt(key)));
    if (typeof out?.onlyDescribes !== "boolean") return null;
    if (failureLineCache.size > 500) failureLineCache.clear();
    failureLineCache.set(key, out.onlyDescribes);
    return out.onlyDescribes;
  } catch {
    return null;
  }
}
const admissionCache = new Map<string, boolean>();
export async function judgeAdmission(claim: string, judge: AdmissionJudge = haikuAdmission): Promise<boolean | null> {
  const key = claim.trim();
  if (admissionCache.has(key)) return admissionCache.get(key)!;
  try {
    const out = parseModelJson<{ onlyAdmission?: unknown }>(await judge(admissionPrompt(key)));
    if (typeof out?.onlyAdmission !== "boolean") return null;
    if (admissionCache.size > 500) admissionCache.clear();
    admissionCache.set(key, out.onlyAdmission);
    return out.onlyAdmission;
  } catch {
    return null;
  }
}
// A sentence the narration rule would cut that is only an honest admission ("The doc isn't made yet"), judged the same way and
// kept, unless the record says the thing was done (2026-10-12 documents run: the true line was cut and its follow-on read orphaned).
const sentenceKey = (s: string) => s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
export function admittedSentence(rf: ReplyFacts, sentence: string): boolean {
  return !!rf.admitted?.has(sentenceKey(sentence));
}
export async function admitNarratedSentences(draft: string, rf: ReplyFacts, judge?: AdmissionJudge): Promise<void> {
  if (doneOnRecord(rf.facts)) return;
  const sentences = draft.replace(/[’‘]/g, "'").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const asks = sentences.filter((s) => MAY_ADMIT.test(s) && narratesInternalState(s));
  await Promise.all(asks.map(async (s) => {
    if ((await judgeAdmission(s, judge)) === true) (rf.admitted ??= new Set()).add(sentenceKey(s));
  }));
}

// The past_action claims that might be admissions, judged; only a true answer is in the map.
// facts: this turn's facts. A claim of any type citing a fact about what failed (services/turnFailure.ts) is always judged: it stands on
// that fact only as an admission of the failure (claimChecks), whatever type the reader gave it.
export async function admissionsFor(claims: Claim[], judge?: AdmissionJudge, facts: Fact[] = []): Promise<Map<string, boolean>> {
  const citesWhatFailed = (c: Claim) => !!c.factId && facts.some((f) => f.id === c.factId && isFailureFact(f));
  // A claim citing what failed gets the failure-line question; the rest, the admission question.
  const failureLines = [...new Set(claims.filter(citesWhatFailed).map((c) => c.text))];
  const asks = [...new Set(claims.filter((c) => !citesWhatFailed(c) && (c.type === "past_action" || c.type === "detail") && MAY_ADMIT.test(c.text)).map((c) => c.text))].filter((t) => !failureLines.includes(t));
  const out = new Map<string, boolean>();
  await Promise.all([
    ...asks.map(async (t) => { if ((await judgeAdmission(t, judge)) === true) out.set(t, true); }),
    ...failureLines.map(async (t) => { if ((await judgeFailureLine(t, judge)) === true) out.set(t, true); }),
  ]);
  return out;
}

async function extractClaims(draft: string, rf: ReplyFacts, src: GroundingSources, model: string = LAYER3_MODELS.grounding): Promise<{ claims: Claim[]; latencyMs: number } | null> {
  const started = Date.now();
  // With the snapshot cached above (judgeSystem), its entries aren't listed again: only this turn's facts and "Since then".
  const facts = `${rf.snapshot ? `${SNAPSHOT_NOTE}\n` : ""}${rf.facts.filter((f) => f.kind !== "hint" && !(rf.snapshot && f.snap)).map((f) => `[${f.id}] ${f.text}`).join("\n")}${sinceBlock(rf)}`;
  const receipts = receiptsForCheck(rf);
  // Held to the claims shape at the API (services/structuredJudge.ts); every citation is still checked in code (claimChecks).
  const { judgeJson, CLAIMS_SCHEMA } = await import("../services/structuredJudge.js");
  const { text } = await judgeJson(CLAIMS_SCHEMA, {
    ...judgeSystem(rf),
    model: anthropic(model),
    maxOutputTokens: 2000,
    // Haiku takes no effort setting (it errors, 2026-09-27).
    ...(model === MODELS.haiku ? {} : { providerOptions: { anthropic: { effort: GROUNDING_EFFORT } } }),
    // A stalled call held one check for 318s in a test (2026-09-26); past
    // this the check counts as unavailable and the usual fallback runs.
    abortSignal: AbortSignal.timeout(GROUNDING_CALL_TIMEOUT_MS),
    experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.check" },
    prompt: `You check a text message Cue is about to send, before it goes out. Find every claim in it that could be false, and say whether the sources below support it.

Claims to find (one type each):
- past_action: something Cue says it did or sent ("I sent you the link", "I scheduled it", "I emailed you both"), including a yes or no to whether it did ("Still no", "Yep, I did") and passing something along ("noted for the team", "that goes straight to the team", "I passed it on")
- future_promise: something Cue says it will do later ("I'll send it when I have it", "I'll keep an eye out", "I'll call you then"), or telling them to ask again later as if something will have changed
- work_status: what Cue says it is doing now, still working on, or is already doing in the background ("I'm working the sponsor search", "digging into Jeremy", "still working the intro search", "looking into it", "searching for that now"), or that nothing is running on something
- time, place, count, detail: a specific about an event, program, or plan: start time, date, address, neighborhood, headcount, format, host, price; a count includes how many things Cue found, sent, or searched ("those two were the results"). Saying two events clash, or that it's "one or the other", is a time claim. Saying Cue doesn't have a detail ("no start time listed", "I don't have the address") is a detail claim.
- link: a link, or "it's in the link above"
- member_life: something about the member's own life as they've told Cue: the people in it, named the way they described them ("your mentor Lena", "your brother", "Ravi, your mentor"), their preferences ("crowded mixers drain you"), their history, their work and projects by name ("your startup ZEBRA-VAULT-941"), where they live
- other_person: someone outside the member's own life, or what any person said, wants, feels, did or will do beyond what the member told Cue ("she mentioned she'd like to meet you", "Lena would love to help"), or who specifically will be somewhere, or that the people there are theirs ("that's your crowd", "go find the llama_index people", "your cofounder will be there")
- capability: what Cue can or can't do ("I can search for X", "I can't call"); every "I can…" is one
- offer: suggesting an event or opportunity as something for them to go to or do ("Mahjong After Dark is Saturday", "worth grabbing a spot at X")
- followup: asking how something went or whether they went, or saying it happened ("how was the demo day?")
- prediction: what Cue says will or won't happen in the world, or how likely it is ("it'll probably sell out", "nothing else is coming this week")

Never claims (don't list these):
- The member's own words and choices from this conversation, restated or built on ("you already called the daytonaio night your pick", "since you said you're in"). The member is never "another person".
- Opinions, feelings, questions (an offer asked as a question, "Want me to look now?", is a question), encouragement, and how Cue will talk ("I'll keep it short").
- Warmth: wishing them well, congratulating them, or reacting to what they just told you ("glad you're back", "hope the week back is kind to you"), and a question about what they shared. When a wish, reaction or question carries a specific about their life they haven't told Cue (an activity, a place, a plan, a date, a person, a reason), list only that specific, as member_life.
- Saying yes to what they just asked ("Happy to.", "Sure.", "Glad to help.", "Let's do it."): that's agreeing, not a capability. Inviting them to send or share something ("Send it over", "Walk me through the key slides") is a request, not a claim.
- What Cue's own draft, prompt, plan or advice should do for them ("That should give you clean, reusable drafts"): that's advice about Cue's own work, not a prediction about the world.
- Advice and possibilities: general know-how about how things usually go ("personal invites beat a mass email"); what kind of people events like this tend to draw; where this could take them ("could be a good place to find the dependable builder people you're after"); a plan or schedule Cue proposes for them; a conclusion reasoned from the sources ("if Oct 10 is under 30 days out, the permit may not clear").

Precedence, when a sentence fits both: a named venue, event, person, date, price, number, rule, fee or deadline that isn't in the sources is a claim even inside advice. Saying specific people will be there, or that they're the member's people, is other_person even when phrased loosely. A person the member told Cue about, said back as who they are to the member ("your mentor Lena reviews your pitch on Fridays", if they said so), is member_life; what that person thinks, says, wants or will do now is other_person. A possibility about the kind of person or outcome the member wants is advice.

Support: a claim is supported only if a FACT below states it, or the real texts in the conversation show it. What Cue did or didn't do (past_action, including "I never sent that") needs a FACT: Cue's own earlier words aren't evidence of what it did, and if a FACT shows Cue sent it, "never sent" is unsupported; passing something to the team needs a FACT that it was saved. Saying Cue did NOT do something ("it never sent, and that's on me", "that didn't go through") is supported when no FACT shows it happened; mark it supported with no factId. Owning a mistake in something Cue sent ("that link shouldn't have gone out dead") is supported by Cue's own sent line in the conversation: quote that line. Their report of what Cue did never supports a claim that Cue did it. A FACT listed under DONE THIS TURN is something that really happened this turn, what Cue's own tools did in this turn (a receipt): it supports the same action said in other words ("passed it along to the team" from "Saved for the team"), and a description of something just sent supports what that FACT says it contains. An offer Cue makes in this reply, framed as something it can do if they say yes ("I can text you a nudge on the 27th", "I can sketch name directions"), is supported by a capability FACT that says Cue offered it in this reply; cite that FACT. A promise said as already set ("I'll text you on the 27th") is not an offer and needs a FACT that it will actually happen. A future_promise needs a FACT that it will actually happen (a scheduled call, a pending item, an open task, or the next step in Cue's working notes for them); an open task Cue is working on for them supports promising to keep working that goal (keep looking, chase a price or a quote, report back before its deadline). A work_status claim needs a FACT naming that exact work as running now: an open task, a research brief being put together, a look-out, or Cue's daily search for something the running-work FACT lists under it; an open ask that line doesn't list, or Cue's working notes, are not work running on it. When the FACTS say nothing is running for it, a claim that it is running is unsupported, and when the running-work FACT lists it, a claim that nothing is running on it is unsupported too. A capability needs a capability FACT covering that exact thing. A prediction needs a FACT stating that outcome; guessing from what was or wasn't found is never support. "I don't have X" is supported only when no FACT, and nothing they've told Cue before, gives X; when nothing does, mark it supported with no factId or quote, since an absence has nothing to cite. Them having just mentioned X in this message doesn't make "I don't have anything on file about X" false. A clash needs FACTS giving both start times, overlapping. Dates decide offers and follow-ups: an offer needs a FACT showing it's still ahead or today, never one marked "already over" or "outside the dates they asked about"; a followup needs a FACT showing it's already over, never one marked "coming up". A number must match its source exactly. A claim about where something stands must match the stage its source gives: suggested, planned, set up (access given, a sample handed over, an intro sent), under way, and done are different, so "I gave her a sample" never backs "she's trying it" or "she liked it", and "we might run a test" never backs "you're testing it". Their own texts in this conversation are a source for their own life and plans, said back in Cue's words with everyday inferences: where they moved from (which never says where they live now unless they said that too), their work, a plan they named and its day ("today's meeting" backs "later today" for it, never "tonight"); quote their words. What they've told Cue before (their own words, below) can support member_life; what Cue knows about them can support a detail about the member themself; neither supports a claim about an event, a count, a link, or another person outside their own life, and someone who's another member of Noise is never part of their own life. Never count something as supported because it's plausible.

FACTS:
${facts}
${receipts ? `\nDONE THIS TURN (what Cue's own tools really did in this turn; each is also a FACT above, cite its id):\n${receipts}\n` : ""}
Conversation so far:
${src.recentConversation || "(none)"}
${src.sentThisTurn?.length ? `\nCue already sent this turn:\n${src.sentThisTurn.join("\n")}\n` : ""}${src.contextSummary ? `\nWhat Cue knows about them:\n${src.contextSummary}\n` : ""}${theirOwnWords(src.recentMemories) ? `\nWhat they've told Cue before (their own words from older conversations):\n${theirOwnWords(src.recentMemories)}\n` : ""}
They just said: "${src.message}"

Message Cue is about to send:
"${draft}"

Return ONLY JSON: {"claims": [{"text": "exact words from the message", "type": "...", "supported": true|false, "factId": "F3" or null, "quote": "exact words copied from the conversation or what Cue knows that support it" or null}]}. Supported claims need a factId or a quote. Return {"claims": []} if there are none.`,
  });
  const json = extractJson(text);
  if (!json || !Array.isArray(json.claims)) return null;
  const claims: Claim[] = json.claims
    .filter((c: any) => c && typeof c.text === "string")
    .map((c: any) => ({
      text: c.text,
      type: c.type ?? "detail",
      supported: c.supported === true,
      factId: typeof c.factId === "string" ? c.factId : null,
      quote: typeof c.quote === "string" && c.quote.trim() ? c.quote : null,
    }));
  return { claims, latencyMs: Date.now() - started };
}

// Co saying it passed something to the team ("Noted, and passed along to the team", "flagged it for the team", "the team has it").
export const TEAM_PASS = /\b(pass(ed|ing)?|sen[dt]|shar(ed|ing)|flagg(ed|ing)|forward(ed|ing)|not(ed|ing)|sav(ed|ing)|log(ged|ging)|g(o|oes|one) (straight )?)\b[^.?!]{0,30}\b(to|for|with) the team\b|\bthe team (has|got|will see) (it|that|this)\b/i;

// More than the pass-along ("and they'll fix it by Friday"): a promise, a day or a fix still needs its own source.
export const TEAM_PASS_PLUS = /\b(will|won'?t|going to|gonna|fix(es|ed|ing)?|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|soon|by \w+)\b|\w['’]ll\b|\d/i;

// Owning a mistake in what Cue sent has its own read (re-review of #310: widening the general admission read to it taught that read a
// line assuming an action was only an admission, and "Sorry, I booked Nopa for 8 and it didn't stick" passed with an empty thread). It
// runs only once Cue's own sent line is found in the thread, and sees that line: the sent-line requirement can't be skipped.
export type OwnershipJudge = (prompt: string) => Promise<string>;
const haikuOwnership: OwnershipJudge = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 40, abortSignal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS), experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.ownership" }, prompt })).text;
export function ownershipPrompt(claim: string, sentLine: string): string {
  return `Earlier, Cue, a texting companion, actually sent this:
"${sentLine}"

Now Cue is about to send this line:
"${claim}"

Does the line only own a mistake in that thing Cue sent, without asserting any other action Cue took (booking, sending, saving, arranging, or anything else) or any other fact?

Return ONLY JSON: {"onlyOwns": true} or {"onlyOwns": false}.`;
}
// Pure: the sent line a claim's quote comes from, or null.
export function sentLineFor(c: Pick<Claim, "quote">, src: Pick<GroundingSources, "recentConversation">): string | null {
  if (!c.quote || norm(c.quote).length < 6) return null;
  const q = norm(c.quote);
  return coLinesIn(src.recentConversation).find((l) => norm(l).includes(q)) ?? null;
}
// On a feedback turn only: each past action whose quote is Cue's own sent line, read for whether it only owns a mistake in that send.
export async function ownershipReadsFor(claims: Claim[], rf: Pick<ReplyFacts, "moment">, src: Pick<GroundingSources, "recentConversation">, judge: OwnershipJudge = haikuOwnership): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (rf.moment !== "feedback") return out;
  await Promise.all(claims.filter((c) => c.type === "past_action").map(async (c) => {
    const line = sentLineFor(c, src);
    if (!line) return;
    try {
      const j = parseModelJson<{ onlyOwns?: unknown }>(await judge(ownershipPrompt(c.text.trim(), line)));
      if (j?.onlyOwns === true) out.set(c.text, true);
    } catch {
      // unread: not owned
    }
  }));
  return out;
}

// Pure: on a feedback turn, a past action that only owns a mistake in what Cue sent (the admission read says so), backed by Cue's own sent
// line in the thread (review of #310: their report alone backed "I booked the table at Nopa for 8", and an earlier confabulated
// "Done, I've booked Nopa" backed a repeat). Never their report alone, never a line that asserts something was done.
export function ownsWhatItSent(c: Pick<Claim, "text" | "quote">, rf: Pick<ReplyFacts, "moment">, src: Pick<GroundingSources, "recentConversation">, ownership: Map<string, boolean>): boolean {
  return rf.moment === "feedback" && !!sentLineFor(c, src) && ownership.get(c.text) === true;
}
// Pure: the claim cites the world line, quoting its thread part.
export function citesTheirThread(c: Pick<Claim, "factId" | "quote">, rf: Pick<ReplyFacts, "facts" | "world">): boolean {
  const thread = rf.world?.thread?.fact;
  const cited = rf.facts.find((f) => f.id === c.factId);
  if (!thread || !cited || !WORLD_FACT.test(cited.text) || !c.quote || norm(c.quote).length < 6) return false;
  const q = norm(c.quote).replace(/[.\s]+$/, "");
  const t = norm(thread).replace(/[.\s]+$/, "");
  return t.includes(q) || q.includes(t);
}

// A model's "supported" only counts if its citation checks out in code.
export function claimChecks(claims: Claim[], rf: ReplyFacts, src: GroundingSources, admissions: Map<string, boolean> = new Map(), ownership: Map<string, boolean> = new Map()): GateCheck[] {
  // A hint (model-written read) is never support, even when cited.
  const factIds = new Set(rf.facts.filter((f) => f.kind !== "hint").map((f) => f.id));
  const hintIds = new Set(rf.facts.filter((f) => f.kind === "hint").map((f) => f.id));
  const nothingReadable = recordSaysNothingReadable(rf.facts);
  const isFeedbackReceipt = (f: Fact | undefined) => !!f && f.kind === "did_this_turn" && /^Saved for the team:/.test(f.text);
  const savedForTeamThisTurn = rf.facts.some(isFeedbackReceipt);
  // A failure of Cue's own is in the facts, and no report of it is on record (services/turnFailure.ts). Then nothing about the team
  // is taken on a feedback receipt: the 2026-10-28 "What happened?" turn saved his question as feedback, and that receipt backed "I've
  // flagged it". Claims about the failure are judged against the failure's own fact, which says whether a report is on record.
  const failure = failureInView(rf.facts);
  const failureUnreported = failure.inView && !failure.onRecord;
  const checks = claims.map((c) => {
    const sources = sourceText(rf, src, c.type);
    let pass = c.supported;
    let reason = `${c.type}: "${c.text}"`;
    const citedFact = rf.facts.find((f) => f.id === c.factId);
    if (pass && failureUnreported && isFeedbackReceipt(citedFact)) {
      return { name: `claim_${c.type}`, pass: false, reason: `${reason} (a saved feedback note isn't a report of Cue's failure, and no report of that is on record)` };
    }
    // A note saved for the team never backs a change, or something Cue does from now on (2026-10-31: "Saved for the team: ... switch his
    // searches to SF going forward" sat behind "switching to SF from here on out", and nothing had changed). Passing it along still
    // stands; passing it along "so your searches switch to SF going forward" doesn't (review of #336).
    if (pass && isFeedbackReceipt(citedFact) && (changeClaims(c.text).length > 0 || GOING_FORWARD.test(c.text))) {
      return { name: `claim_${c.type}`, pass: false, reason: `${reason} (a note saved for the team backs only saying it went to the team, never that Cue changed or will do anything)` };
    }
    // A report status that says there's no report, or that it couldn't be checked, is about an absence: it backs nothing.
    if (pass && citedFact && isFailureReportFact(citedFact) && !reportFactBacks(citedFact)) {
      return { name: `claim_${c.type}`, pass: false, reason: `${reason} (that fact says no report of Cue's failure is on record, or that it couldn't be checked; it supports nothing)` };
    }
    // What failed backs saying that it failed, nothing Cue did about it: a claim of any type resting on it stands only when the admission
    // judge reads the claim as only admitting the failure (4th review: "The team has it." typed as detail got through) ("It didn't go through on my end"), never "I've flagged it" (that needs the report
    // status). The judge reads meaning; this only guards which fact can back which.
    if (pass && citedFact && isFailureFact(citedFact) && admissions.get(c.text) !== true) {
      return { name: `claim_${c.type}`, pass: false, reason: `${reason} (what failed backs only saying it failed; anything Cue did about it needs its own fact)` };
    }
    // Agreeing to help is not a capability claim (row 10393, 2026-10-10: "Happy to." was cut as one, and the reply that asked her to
    // send the deck became "I don't have a solid read on your deck"). Only the bare yes: "Happy to search X" is still a capability.
    if (!pass && c.type === "capability" && WILLING.test(c.text.trim())) {
      pass = true;
      reason += " (agreeing to what they asked, not a capability)";
      return { name: `claim_${c.type}`, pass, reason };
    }
    // Passing it to the team, right after saveFeedbackForTeam saved it this turn: the receipt is the fact, whatever the model cited
    // (2026-10-12 audit, row 10175). Never the other way: no receipt, no pass.
    // An honest admission it didn't happen is never cut as a false past action (2026-10-12 four-artifact test: "it never sent, and
    // that's on me" was cut while the doc truly never sent). Nothing on record says it happened: kept. Something does: the model's
    // read decides, without needing a fact to cite for an absence.
    // A failure of Cue's own in the facts counts as something on record: an admission about it stands on that fact, not on an absence.
    if ((c.type === "past_action" || c.type === "detail") && admissions.get(c.text) === true && ((!doneOnRecord(rf.facts) && !failure.inView) || pass)) {
      return { name: `claim_${c.type}`, pass: true, reason: `${reason} (an admission it didn't happen${pass ? "" : ", and nothing on record says it did"})` };
    }
    if (!pass && c.type === "past_action" && savedForTeamThisTurn && !failureUnreported && TEAM_PASS.test(c.text) && !TEAM_PASS_PLUS.test(c.text)) {
      pass = true;
      reason += " (saved for the team this turn)";
      return { name: `claim_${c.type}`, pass, reason };
    }
    // "It hasn't come through on my end": true when their file record says nothing readable arrived (services/inboundFile.ts),
    // whatever the model cited. Never the other way: "it came through" still needs a fact.
    if (!pass && nothingReadable && arrivalDenial(c.text)) {
      pass = true;
      reason += " (their file record shows nothing readable arrived)";
      return { name: `claim_${c.type}`, pass, reason };
    }
    // Co's own work said as running ("digging into X", "still working the intro search") stands only on work that is running:
    // an open task, a research brief, a look-out or the daily search the running-work line lists (2026-10-12, item 3; 2026-10-13:
    // the daily search of their open asks is running work since the 9am floor, #181).
    if (pass && c.type === "work_status") {
      const cited = rf.facts.find((f) => f.id === c.factId);
      // The running-work line itself backs what it says: a listed item as running, or "nothing is running" as nothing. The daily
      // search's own fact backs it too, while the running-work line says something is running (it lists the same asks, held or not).
      const fromState = !!cited && cited.kind === "known" && (RUNNING_LIST.test(cited.text) || (NOTHING_RUNNING.test(cited.text) && SAYS_NOT_RUNNING.test(c.text)));
      // A held search backs nothing; an ask saved this turn backs itself (nothingRunsAt is false then).
      const fromSearch = !!cited && cited.kind === "ongoing" && /^(?:Co|Cue)'s daily search is (?:now )?looking for/.test(cited.text) && !nothingRunsAt(rf) && !searchHeld(rf);
      // Their world line (services/memberWorld.ts) lists the same running items: it backs work said as running only when the claim names
      // one of them (two or more shared meaning words), and "nothing is running" when it lists none.
      const fromWorld = !!cited && cited.kind === "known" && WORLD_FACT.test(cited.text) && !!rf.world && (rf.world.running.length > 0 ? !!namesRunningItem(rf.world, c.text) : SAYS_NOT_RUNNING.test(c.text));
      // A search done this turn, said as done: its receipt backs it (it says what Cue did, not that anything is running).
      const fromReceipt = !!cited && cited.kind === "did_this_turn" && SEARCHED_THIS_TURN.test(cited.text) && saysSearchDone(c.text);
      if (!cited || (!workBacksPromise(cited) && !fromState && !fromSearch && !fromWorld && !fromReceipt)) {
        pass = false;
        reason += nothingRunsAt(rf) ? ` (${NOTHING_RUNNING_REASON})` : " (that work isn't among what the running-work line lists for them)";
      }
    }
    // An offer Co makes in this reply (goal ownership, 2026-10-13) is a capability claim backed by its offer fact (goalOwnership.ts
    // offerFactLines, kind "capability"): the reader's claim type says offer vs. promise, never a phrasing pattern. A promise said as set
    // ("I'll text you on the 27th") is a future_promise, and an offer fact is never a scheduled one, so it fails just below.
    if (pass && c.type === "future_promise") {
      const cited = rf.facts.find((f) => f.id === c.factId);
      if (!cited || !["ongoing", "scheduled", "did_this_turn"].includes(cited.kind)) {
        pass = false;
        reason += " (a future action needs a real scheduled call or an open search behind it)";
      }
    }
    // What Co did is only backed by the record, never by Co's own earlier
    // words in the thread (2026-09-27: an earlier false "I never sent it"
    // was quoted as support for saying it again).
    // Owning a mistake in what Cue sent, on a feedback turn (Royce, 2026-10-28: "that link shouldn't have gone out dead" was cut, and what
    // went out neither owned nor fixed it): Cue's own sent line backs it in place of a fact. Every check below still runs.
    const owned = pass && c.type === "past_action" && ownsWhatItSent(c, rf, src, ownership);
    if (owned) reason += " (owning a mistake in what Cue sent, backed by Cue's sent line)";
    if (pass && c.type === "past_action" && !owned && !(c.factId && factIds.has(c.factId))) {
      pass = false;
      reason += " (what Cue did has to come from a fact, not from the conversation)";
    }
    // A receipt says it didn't happen, so it can't back a claim that it did.
    if (pass && c.type !== "capability" && rf.facts.find((f) => f.id === c.factId)?.kind === "not_done") {
      pass = false;
      reason += " (that was tried this turn and did NOT happen)";
    }
    // The circular case (Phase B, B3, 2026-10-10): a stored detail checked against itself. A fact marked stale never backs the same
    // detail said as current; only a live read does, or the claim saying "as of" (services/asOf.ts).
    if (pass && citesStaleAsCurrent(c.text, rf.facts.find((f) => f.id === c.factId)?.text)) {
      pass = false;
      reason += " (that detail is from an earlier read, not checked since: say it as of then, or check it live)";
    }
    // Their thread is theirs to tell (services/memberWorld.ts: "ask, never report"): the world line's thread part never backs saying where
    // it stands (2026-10-28 re-record: "Still nothing from the venue yet" passed citing it, caught only by the thread check). Asking about
    // it is a followup, and stays.
    if (pass && c.type !== "followup" && !/\?\s*["')\]]*$/.test(c.text.trim()) && citesTheirThread(c, rf)) {
      pass = false;
      reason += " (their thread is theirs to tell: the world line never backs saying where it stands)";
    }
    if (pass && c.factId && hintIds.has(c.factId) && !(c.quote && norm(c.quote).length >= 6 && sources.includes(norm(c.quote)))) {
      pass = false;
      reason += " (that came from a model's read, which is a hint, not a source)";
    }
    // A true "I don't have that" has nothing to cite: the reader saw every
    // source and found nothing (2026-10-01: once denials were checked, true
    // ones were cut for "cited support not found").
    const absence = (c.type === "detail" || c.type === "member_life") && CO_DENIES_HAVING.test(c.text);
    if (pass && !absence) {
      const factOk = !!c.factId && factIds.has(c.factId);
      // While a failure is in view and no report of it is on record, Cue's own earlier lines ("I've flagged it…") back nothing: a quote
      // found in them doesn't count (5th review: a quote of its own line let a repeat through).
      const quoteOk = !!c.quote && norm(c.quote).length >= 6 && sources.includes(norm(c.quote)) && !(failureUnreported && cueOwnLines(src).includes(norm(c.quote)));
      if (!factOk && !quoteOk) {
        pass = false;
        reason += " (cited support not found)";
      }
    }
    return { name: `claim_${c.type}`, pass, reason };
  });
  // What each claim was found to rest on, for the machinery-talk check (failureBackedSentence): kept across a recheck's partial read.
  rf.claimCites ??= new Map();
  // Rests on the failure: it cites the "what failed" fact or a status saying a report is on record, or the admission judge passed it
  // while a failure is in view (the claim reader may mark "that didn't go through" supported with no fact to cite).
  claims.forEach((c, i) =>
    rf.claimCites!.set(sentenceKey(c.text).replace(/[.!?]+$/, ""), {
      pass: checks[i].pass,
      // An on-record status counts too: the status guard above keeps a "no report" citation from ever passing.
      failureFact: checks[i].pass && (!!rf.facts.find((f) => f.id === c.factId && (isFailureFact(f) || reportFactBacks(f))) || (failure.inView && admissions.get(c.text) === true)),
    }),
  );
  return checks;
}

// A sentence whose claims all stand on a fact about Cue's own failure ("It didn't go through on my end", citing that fact) is a true
// account of what failed, not machinery talk; it's never cut as such. Only when the claim read found claims in it and every one cites
// that fact.
export function failureBackedSentence(rf: ReplyFacts, sentence: string): boolean {
  if (!rf.claimCites?.size) return false;
  const s = sentenceKey(sentence).replace(/[.!?]+$/, "");
  // A claim inside the sentence, or the sentence as most of one claim (a bare "On my end." inside a longer claim isn't).
  const inIt = [...rf.claimCites].filter(([t]) => t.length > 0 && (s.includes(t) || (t.includes(s) && s.length >= t.length * 0.6)));
  return inIt.length > 0 && inIt.every(([, v]) => v.failureFact);
}

// The redraft's extra line when the cut left dead air (deadAir): Co decides whether their message was a check-in.
export const WORLD_REDRAFT_NOTE = "What's left of the draft is a few words of presence, and their world (\"Their world right now\" in the facts) has a true line. First decide whether their message was a check-in or a casual opener with no ask. If it was, the smallest true reply is that presence plus the one item their world leads with (when their world has only their thread, that item is a question asking them about it, never where it stands), in your own words and their register (late at night, soft and open first), never your own machinery (\"nothing new on my end\"); it may run one short line longer than the draft. If it wasn't (a goodnight, a hard moment, a question, anything else), write the smallest true reply as below and bring in nothing from their world. Return ONLY JSON: {\"checkin\": true or false, \"reply\": \"the message\"}.";
// Dead air late at night their time (re-review of #310): the redraft is told care only, and code adds nothing from their world after it
// (deadAirLine). Daytime keeps WORLD_REDRAFT_NOTE.
export const WORLD_REDRAFT_NOTE_AT_NIGHT = "What's left of the draft is a few words of presence, and it's late at night for them. Write the smallest true reply as care only: open on them, gently, the way you would at this hour, and bring in nothing from their world, no opportunity, nudge or thing to act on. Return ONLY JSON: {\"checkin\": true or false, \"reply\": \"the message\"}.";
// The redraft's extra line when the narration rule cut a supported answer (narrationCutSupported).
export const NARRATION_REDRAFT_NOTE = "A sentence that answered them was cut only because it talked about your own side or machinery. Say that same answer again without that part, keeping its meaning and any condition it had, in the draft's own words where you can.";
// Pure: the narration rule (no_internal_narration) failed, and a sentence the cut removed carried a claim the claim read supported.
export function narrationCutSupported(o: { draft: string; cut: string; checks: GateCheck[] }): boolean {
  if (!o.checks.some((c) => c.name === "no_internal_narration" && !c.pass)) return false;
  const kept = norm(o.cut);
  const removed = (o.draft.match(SENTENCES) ?? []).map((x) => x.trim()).filter((x) => x && !kept.includes(norm(x).replace(/[.!?]+$/, "")));
  const supported = o.checks.filter((c) => c.pass && /^claim_/.test(c.name)).map((c) => claimWords(c)).filter((w): w is string => !!w && w.trim().length >= 6);
  return removed.some((sentence) => supported.some((w) => norm(sentence).includes(norm(w).replace(/[.!?]+$/, ""))));
}
async function redraft(draft: string, failed: GateCheck[], rf: ReplyFacts, src: GroundingSources, earlierTry: string | null = null, note: string | null = null, json = false): Promise<string | null> {
  const tail = src.recentConversation.split("\n").slice(-14).join("\n");
  const { text } = await generateText({
    model: anthropic(LAYER3_MODELS.redraft),
    maxOutputTokens: 1000,
    providerOptions: { anthropic: { effort: GROUNDING_EFFORT } },
    abortSignal: AbortSignal.timeout(GROUNDING_CALL_TIMEOUT_MS),
    experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.redraft" },
    ...judgeSystem(rf),
    prompt: `${CO_VOICE}

${CO_TEXT_CHANNEL}

${renderJudgeFacts(rf)}

Recent conversation:
${tail || "(none)"}
${src.sentThisTurn?.length ? `\nYou already sent this turn:\n${src.sentThisTurn.join("\n")}\n` : ""}${theirOwnWords(src.recentMemories) ? `\nWhat they've told you before (their own words about their own life):\n${theirOwnWords(src.recentMemories)}\n` : ""}
They just said: "${src.message}"

Your draft reply:
"${draft}"

These parts of the draft aren't supported by the facts or the conversation:
${failed.map((f) => `- ${f.reason ?? f.name}`).join("\n")}
${earlierTry ? `\nAn earlier rewrite also had unsupported parts (listed above too): "${earlierTry}"\nThis time, answer what they just asked first, in words the facts above actually support, even if the honest answer is short.\n` : ""}${note ? `\n${note}\n` : ""}
Deleting the unsupported parts left too little to answer them, so write the smallest true reply instead. Keep every supported sentence of the draft word for word. Where a flagged part can be corrected from a FACT (the real time, what was actually sent), correct it with the FACT's own words. When the FACTS say where something of theirs stands (a search, a task, your working notes, what you sent), and what's left doesn't answer them, answer with that state: what's found, what's unconfirmed, the next move. That is the answer, never a remark about what you can't measure, describe or nail down (2026-10-01: "how proactive are you?" became a disclaimer while their venue search's status sat in the facts). Otherwise say once, plainly, the one thing you don't have. Never add a new recommendation or change which option the draft recommends, never add an event, person, place, number, date or link that isn't in the draft or the FACTS (people and details from what they've told you before about their own life may stay or be used), never say you don't have something that what they've told you before gives, and never add anything about how they're feeling or what they're going through. No promises, no "let me look" or "one sec". If they want something found and a FACT shows work under way for it, say what you're doing about it now, from that FACT; never offer it back to them as a question. Match the draft's capitalization style. ${json ? "At most one short line longer than the draft. Return ONLY the JSON." : note ? "At most one short line longer than the draft. Return ONLY the message." : "Same length or shorter. Return ONLY the message."}`,
  });
  const out = text.trim().replace(/^"|"$/g, "");
  return out || null;
}

// True when every sentence of the rewrite appears word for word, in the
// same order within itself, in the draft: it only removed things. A sentence
// with a word dropped from its middle ("did not send" to "did send") doesn't
// count, so a cut can't flip a meaning.
export function onlyCuts(draft: string, rewrite: string): boolean {
  const flat = (t: string) => ` ${t.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const whole = flat(draft);
  const parts = (rewrite.match(/[^.!?\n]+/g) ?? []).map(flat).filter((p) => p.trim().length > 0);
  return parts.length > 0 && flat(rewrite).length < whole.length && parts.every((p) => whole.includes(p));
}

// Re-reads only what the rewrite changed (2026-09-26): sentences that are
// new, plus any kept sentence carrying a claim that already failed. What
// passed the first read stays passed, so the second read is shorter and
// doesn't re-flag claims the first one cleared (on last week's real drafts
// the full re-read failed 26 of 40 rewrites, each costing another ~5s
// rewrite). Code checks still run on the whole text.
export function sentencesToRecheck(draft: string, rewrite: string, failed: GateCheck[]): string[] {
  const flat = (t: string) => ` ${t.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const whole = flat(draft);
  const bad = failed.map((f) => flat((f.reason ?? "").replace(/^[a-z_]+: "|"(\s*\([^)]*\))?$/g, "")).trim()).filter((q) => q.length > 3);
  return (rewrite.match(SENTENCES_SP) ?? [rewrite])
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !whole.includes(flat(x)) || bad.some((q) => flat(x).includes(` ${q} `) || flat(x).includes(q)));
}

// The model for the reads after a rewrite. GROUNDING_RECHECK_MODEL only
// exists so evals/grounding can compare (2026-09-27).
const RECHECK_MODEL = process.env.GROUNDING_RECHECK_MODEL === "haiku" ? MODELS.haiku : LAYER3_MODELS.grounding;

// Pure: the model for a recheck's claim read. Claim-shaped changes always get the full read (Sonnet); the forced read of claim-free
// changes (the share rewrite) is the cheap one (re-review of #310: claim-heavy rewrites had gone to Haiku).
export function recheckModel(changed: string, opts: { force?: boolean; model?: string } = {}): string {
  return opts.force && opts.model && !needsClaimCheck(changed) ? opts.model : RECHECK_MODEL;
}
// force: the claim read runs on what changed even when nothing in it looks claim-shaped; claim-free changes on the given model.
async function recheck(draft: string, rewrite: string, failed: GateCheck[], rf: ReplyFacts, src: GroundingSources, opts: { force?: boolean; model?: string } = {}): Promise<{ checks: GateCheck[]; modelOk: boolean; ms: number }> {
  // The thread read of the whole rewrite and the claim read of what changed start together; the code checks run once both settle.
  const changed = sentencesToRecheck(draft, rewrite, failed);
  const [, r] = await Promise.all([judgeThreadReports(rewrite, rf, src), changed.length ? check(changed.join(" "), rf, src, recheckModel(changed.join(" "), opts), opts.force) : Promise.resolve(null)]);
  const code = codeChecks(rewrite, rf, src);
  if (!r) return { checks: [...code, { name: "claim_read", pass: true, reason: "the rewrite only kept or cut already-checked words" }], modelOk: true, ms: 0 };
  const forcedRead: GateCheck[] = opts.force && r.modelOk ? [{ name: "claim_read", pass: true, reason: "forced read of what the rewrite changed" }] : [];
  return { checks: [...code, ...r.checks.filter((c) => c.name.startsWith("claim")), ...forcedRead], modelOk: r.modelOk, ms: r.ms };
}

const CROWD = /\b(that'?s|those are|they'?re|it'?s|full of|room of|go find) (all )?(your|his|her|their) (crowd|people|tribe|kind of people)\b|\bgo find the [\w@.'’-]+ (people|folks|crowd)\b|\b(exactly|precisely) (the|your) (room|crowd|people)\b|\broom full of (exactly )?(who|the people) you\b/i;
export function crowdClaim(text: string): boolean {
  return CROWD.test(text);
}
const CLASH = /\b(one or the other|can'?t (do|make|hit) both|have to pick one|pick one or|same (night|time)[^.!?]{0,40}\b(so|pick|choose|only one))\b/i;
// Co reads its facts labeled [F1], [F2]…; a label never reaches the member
// (2026-09-28: "I actually do this more than that made it sound, F20 says so").
export function stripFactIds(text: string): string {
  return text
    .replace(/,?\s*\b(?:per|see|as in|according to)\s+\[?F\d{1,3}\]?,?/gi, "")
    .replace(/,?\s*\[?\bF\d{1,3}\]?\s+says so/g, "")
    .replace(/\s*[\[(]F\d{1,3}[\])]/g, "")
    .replace(/\s+([.,:;!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s*,\s*/, "")
    .trim()
    .replace(/^([a-z])/, (c) => c.toUpperCase());
}

// Saying Co can't call, in any wording: "I can't call", "no calls", "no phone
// calls", "can't make calls" (2026-09-28: "I can't act for you, no calls, no
// bookings" got through). Calling other people for them is a real limit and
// passes: "can't call people for you", "no calls to sponsors".
export function callDenial(text: string): boolean {
  const denies =
    /\bI\s*(can(no|')?t|can not|am unable to|'?m unable to|don'?t|do not)\s+(actually\s+)?(make|place|do)?\s*(a\s+|phone\s+)*calls?\b|\bthis is (just )?(a )?text\b|\bno (phone |voice )?calls\b|\b(can(no|')?t|unable to) (make |place |do )?(phone )?calls\b/i;
  const others = /\b(calls?|call)\s+(to |for |on behalf of )?(other people|others|people for|sponsors?|venues?|anyone (else|for you)|them for you|on your behalf|for you)\b/i;
  return text.split(/(?<=[.!?\n])\s+/).some((s) => denies.test(s) && !others.test(s));
}

export function clashClaim(text: string): boolean {
  return CLASH.test(text);
}

// Sentences, where a period inside a word is not an end: "from-royce.com",
// "3.5", "e.g.com" (2026-09-29: the cut split at the dot in a domain and
// joined the pieces back as "from-royce.If a recruiter…").
const SENTENCES = /(?:[^.!?\n]|[.!?](?=[^\s.!?]))+[.!?]*/g;
const SENTENCES_SP = /(?:[^.!?\n]|[.!?](?=[^\s.!?]))+[.!?]*\s*/g;

// Bare agreement, the whole claim: "Happy to.", "Sure, glad to help.", "Absolutely, let's do it." (never "Happy to search for X").
// The agreeing words are required (review of #140: every part was optional, so "", "." and "Sure." matched); "on it" and "count me
// in" are left out, since they can promise work.
export const WILLING = /^(?:(?:yes|yeah|yep|sure|absolutely|of course|definitely|for sure)[,.!]?\s*)?(?:(?:i'?m |i am |i'?d be |i would be )?(?:happy|glad|keen) to(?: help)?|(?:i'?d )?love to(?: help)?|let'?s do (?:it|this))[.!]?$/i;

// The raw words of a failed claim, from its reason (`type: "words" (why)`).
function claimWords(f: GateCheck): string | null {
  if (!/^claim_/.test(f.name)) return null;
  return (f.reason ?? "").match(/^[a-z_]+: "([\s\S]*?)"(?:\s*\([^)]*\))*$/)?.[1] ?? null;
}

// Pure: a sentence with an unsupported claim as its LAST clause, joined by "and" / "so" / "then" or a comma, keeps the clause
// before it when that clause is a sentence on its own (4+ words) and carries no failed claim itself. Anything else is left whole,
// for the sentence-level cut. Remove-only: the kept part is the draft's own words, in order.
export function cutTrailingClaims(sentence: string, failed: GateCheck[]): string {
  const flat = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'");
  let out = sentence;
  for (const f of failed) {
    const words = claimWords(f);
    if (!words || words.trim().length < 6) continue;
    const s = flat(out);
    const at = s.lastIndexOf(flat(words.trim()).replace(/[.!?]+$/, ""));
    if (at <= 0) continue;
    const after = out.slice(at + words.trim().replace(/[.!?]+$/, "").length);
    if (!/^[\s.!?"')\]]*$/.test(after)) continue;
    const head = out.slice(0, at).replace(/\s+$/, "");
    const m = head.match(/^([\s\S]*?)(?:,\s*(?:and|so|then)?|\s+(?:and|so|then))$/i);
    if (!m) continue;
    const kept = m[1].replace(/[,;:\s]+$/, "");
    if (kept.split(/\s+/).filter(Boolean).length < 4) continue;
    // A head that announces a count or a list ("I found two options for you, the Rosewood supper.") would promise what was cut.
    if (/\b(?:\d+|two|three|four|five|six|a few|a couple(?: of)?|several|some)\s+(?:\w+\s+)?(?:options?|picks?|places?|events?|ideas?|spots?|ones?|things?|choices?|venues?|rooms?)\b|:\s*$/i.test(kept)) continue;
    // A head that only sets up the cut part ("If you send it, I'll read it tonight") would dangle: left whole.
    if (/^\W*(?:if|when|once|as soon as|after|before|because|since|unless|while|until)\b/i.test(kept)) continue;
    if (failed.some((g) => g !== f && claimWords(g) && flat(kept).includes(flat(claimWords(g)!.trim()).replace(/[.!?]+$/, "")))) continue;
    const end = /\?\s*$/.test(out) ? "?" : ".";
    const trail = out.match(/\s*$/)?.[0] ?? "";
    out = `${kept}${end}${trail}`;
  }
  return out;
}

// Last resort: drop the sentences that carry an unsupported claim.
export function stripUnsupported(draft: string, failed: GateCheck[], opts: { allow?: (sentence: string) => boolean } = {}): string {
  // A sentence whose unsupported claim is only its last clause keeps the rest (row 10393, 2026-10-10: "Send over the deck or walk me
  // through the key slides and I'll give you a real read." lost the invitation with the promise). See cutTrailingClaim.
  const sentences = (draft.match(SENTENCES_SP) ?? [draft]).map((s) => cutTrailingClaims(s, failed));
  // Strips the leading `type: "` and the trailing `"`, plus ANY trailing
  // parenthetical claimChecks appended after it — not just literally
  // " (cited support not found)" (2026-09-17 code review: a future_promise
  // failure's real suffix is " (a future action needs a real scheduled call
  // or an open search behind it)", which the old literal-only pattern left
  // in place, so the quoted text never matched a sentence below and an
  // unsupported promise could go out marked "stripped" while still present).
  const bad = failed.map((f) => norm((f.reason ?? "").replace(/^[a-z_]+: "|"(\s*\([^)]*\))?$/g, "").replace(/^(link|phone number|time) /, "")));
  const kept = sentences.map((s) => {
    const ns = norm(s);
    if (failed.some((f) => f.name === "no_call_placed_claim") && /(calling|ringing|dialing) you|i'?m (calling|ringing|dialing)/i.test(s)) return false;
    if (failed.some((f) => f.name === "no_crowd_claim") && crowdClaim(s)) return false;
    if (failed.some((f) => f.name === "no_unknown_clash") && clashClaim(s)) return false;
    if (failed.some((f) => f.name === "no_emotion_label") && !checkNoEmotionLabel(s).pass) return false;
    if (failed.some((f) => f.name === "no_followup_promise") && followupPromiseMatch(s)) return false;
    if (failed.some((f) => f.name === "no_internal_narration") && narratesInternalState(s, opts)) return false;
    if (failed.some((f) => f.name === "no_prediction") && predictionMatch(s)) return false;
    if (failed.some((f) => f.name === "no_result_promise") && resultPromiseMatch(s)) return false;
    if (failed.some((f) => f.name === "no_capability_denial") && (callDenial(s) || /\b(can(no|')?t|unable to|this is (just )?text)\b.{0,40}\bcalls?\b/i.test(s))) return false;
    if (failed.some((f) => f.name === "no_invite_sent_claim") && INVITE_ACTION_VERB.test(s)) return false;
    if (failed.some((f) => f.name === "no_group_chat_claim") && claimsGroupChat(s)) return false;
    if (failed.some((f) => f.name === "link_on_file") && /https?:\/\//i.test(s)) return false;
    if (failed.some((f) => f.name === "no_link_offer_without_link") && LINK_OFFER.test(s)) return false;
    if (failed.some((f) => f.name === "no_repeat_question" && sameQuestion(s, f.reason?.match(/"(.+)"$/)?.[1] ?? ""))) return false;
    if (failed.some((f) => f.name === "phone_on_file") && /\d{3}[\s.-]?\d{4}/.test(s)) return false;
    if (failed.some((f) => f.name === "time_on_file") && clockTimes(s).length) return false;
    // The claim read itself never came back (2026-09-17 code review): drop
    // any sentence that could carry a checkable claim, since nothing
    // verified it either way — same shape test needsClaimCheck uses to
    // decide whether a whole draft needs the model read.
    if (failed.some((f) => f.name === "claim_read_failed") && needsClaimCheck(s)) return false;
    return !bad.some((b) => b.length >= 6 && (ns.includes(b) || b.includes(ns.replace(/[.!?]+$/, ""))));
  });
  // A sentence that leans on the one just cut goes with it ("The doc isn't made yet. What would unblock it is..." 2026-10-12): it
  // would read orphaned.
  // Only one that clearly points back at it, never a question or a caring line, and never when that would leave nothing.
  const withDependents = [...kept];
  for (let i = 1; i < sentences.length; i++) if (!withDependents[i - 1] && withDependents[i] && leansOnPrevious(sentences[i])) withDependents[i] = false;
  const out = sentences.filter((_, i) => withDependents[i]).join("").trim();
  return out || sentences.filter((_, i) => kept[i]).join("").trim();
}
export const LEANS_ON_PREVIOUS = /^\s*(?:what would (?:unblock|fix|change|speed up|help with) (?:it|that|this)|once (?:it|that|this)(?:'s|’s| is| goes| lands)|until (?:it|that|this)\b|the rest\b|otherwise\b)/i;
export function leansOnPrevious(sentence: string): boolean {
  return !/\?\s*["')\]]*\s*$/.test(sentence) && LEANS_ON_PREVIOUS.test(sentence);
}

// A model rewrite is only kept if code confirms it adds nothing new
// (2026-09-28, Royce: "Rewrites only remove"): a rewrite flipped Co's pick
// from daytonaio to Grok and brought up his burnout. New sentences may only
// say what's missing or correct from a FACT: no new recommendation, no
// feelings, and no name, number, date, link or handle that isn't already in
// the draft or the facts.
const FEELING_WORDS = /\b(feel|feels|feeling|felt|burn(ed|t)? ?out|burnout|exhaust\w*|tired|stress\w*|overwhelm\w*|anxi\w*|lonely|sad|upset|frustrat\w*|struggl\w*|a break\b|taking a break|worth (is )?tied|hard (week|day|time)|leaning (toward|towards))\b/i;
const RECOMMENDS = /\b(i'?d (pick|go with|choose|stick with|go for|lean)|go with|stick with|you should|i recommend|i'?d recommend|pick (this|that|the)|choose (this|that|the)|worth (going|it|a look|grabbing)|skip (this|that|it))\b/i;
const MONTHS_DAYS = /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;
function specifics(sentence: string): string[] {
  const out: string[] = [];
  for (const m of sentence.match(/https?:\/\/\S+|@\w+|\d[\d:/.,]*/g) ?? []) out.push(m.toLowerCase().replace(/[.,]+$/, ""));
  for (const m of sentence.match(MONTHS_DAYS) ?? []) out.push(m.toLowerCase());
  // Capitalized words not starting the sentence: names of people, places, events.
  const words = sentence.trim().split(/\s+/);
  words.slice(1).forEach((w) => {
    const clean = w.replace(/[^A-Za-z'’-]/g, "");
    if (/^[A-Z][a-z]/.test(clean) && clean !== "I" && !/^I['’]/.test(clean)) out.push(clean.toLowerCase());
  });
  return out;
}
export function rewriteAddsNothing(draft: string, rewrite: string, allowed: string): { ok: boolean; why: string | null } {
  const flat = (t: string) => ` ${t.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  // No longer than the draft, plus room for one short honest line when the
  // draft was all claim ("Agreed, noted that too." -> "Honestly, that one
  // didn't get passed to the team.").
  if (rewrite.length > draft.length + 60) return { ok: false, why: "longer than the draft" };
  if (!checkNoEmotionLabel(rewrite).pass) return { ok: false, why: "names their feelings" };
  const whole = flat(draft);
  const known = `${draft}\n${allowed}`.toLowerCase();
  const fresh = (rewrite.match(SENTENCES) ?? []).map((x) => x.trim()).filter((x) => x && !whole.includes(flat(x)));
  for (const sentence of fresh) {
    if (FEELING_WORDS.test(sentence)) return { ok: false, why: `adds something about how they feel: "${sentence}"` };
    if (RECOMMENDS.test(sentence)) return { ok: false, why: `adds or changes a recommendation: "${sentence}"` };
    const added = specifics(sentence).filter((t) => !known.includes(t));
    if (added.length) return { ok: false, why: `adds ${added.join(", ")} that isn't in the draft or the facts` };
  }
  return { ok: true, why: null };
}

// Enough left after cutting to still answer them.
// A draft that asked something and lost its question to the cut is a stub
// ("Got it, a job at X."), not an answer: it goes to the rewrite instead.
// A question that only points back at something ("Want me to set that?", "Should I do it?"): once what it pointed at is cut, it
// means nothing on its own, so a cut that leaves only that goes to the redraft (2026-10-13: "Want me to set that?" went out alone).
export const DANGLING_QUESTION = /^\s*(?:(?:so|and|ok(?:ay)?),?\s+)?(?:want me to|do you want me to|should i|shall i|sound good|does that work|cool if i|ok if i|want that)\b[^.?!]*\?\s*["')\]]*\s*$/i;
export function danglingQuestion(text: string): boolean {
  const t = text.trim();
  const sentences = t.match(/[^.!?]+[.!?]*/g) ?? [];
  return sentences.length === 1 && DANGLING_QUESTION.test(t) && /\b(?:that|it|this|one|those|them)\b/i.test(t) && t.split(/\s+/).length <= 9;
}
function enoughLeft(text: string, draft = ""): boolean {
  if (danglingQuestion(text) && !danglingQuestion(draft)) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (draft.includes("?") && !text.includes("?") && words < 14) return false;
  return words >= 4;
}

export type GroundingResult = {
  final: string;
  // cut: the unsupported sentences were deleted and the rest went out as drafted.
  outcome: "as_drafted" | "cut" | "redrafted" | "stripped" | "unchecked";
  // Stripped all the way to the honest "not sure" line (its own words, or the fixed fallback): the member got no help this turn
  // (harness/failureCount.ts counts it). Never set for a cut that still answered, the invite, dead-air or nothing-running lines.
  notSure?: boolean;
  checks: GateCheck[];
  // Total grounding time for this message (checks + any redraft).
  latencyMs: number;
  // Just the first check: the added latency on a reply that passes as drafted.
  firstCheckMs: number;
  // Each later stage, when it ran (2026-09-26, to see where rewrites spend time).
  stages?: { redraftMs?: number; secondCheckMs?: number; retryMs?: number };
};

// Claims nothing, and reads like a person (2026-09-18: "I don't have that, so
// I'd rather not guess." answered "is it noted to the team?").
const MINIMAL_FALLBACK = "Honestly, I'm not sure on that one.";
// Dead air late at night when the care redraft can't be kept (Copy, approved 2026-10-29 under Royce's delegation for this batch).
export const NIGHT_CARE_LINE = "You're up late. Everything ok?";

// The honest "I don't have that" in Co's own words, stating nothing else.
// What replaces a reply stripped down to almost nothing.
export function afterStrip(o: { enough: boolean; inviteCut: boolean; sentThisTurn: string[]; findsWaiting?: boolean | (() => boolean) }): "invite" | "cut" | "nothing" | "honest" {
  if (o.inviteCut) return "invite";
  if (o.enough) return "cut";
  // Read now, after the check's own redrafts: past the redraft window an empty reply could only end on the fallback line.
  if (typeof o.findsWaiting === "function" ? o.findsWaiting() : o.findsWaiting) return "nothing";
  return o.sentThisTurn.some((m) => m.trim()) ? "nothing" : "honest";
}

// What's ahead from Co (services/whatsAhead.ts aheadLine): the honest line never says nothing is planned while it lists something
// (2026-10-13: "Nothing confirmed on my end for this week" with a Friday check-in on the ledger).
const AHEAD_LINE = /^What's ahead for them from (?:Co|Cue), as scheduled now:/;
async function honestNoAnswer(message: string, ahead: string | null = null): Promise<string | null> {
  const { lineInVoice } = await import("../services/voiceLine.js");
  const r = await lineInVoice({
    purpose: ahead
      ? "Say plainly, in one or two short lines, what you can stand behind: if what they asked is about what's coming up or what's ahead, name what is scheduled from the facts in plain words; otherwise say you don't have a solid answer to it. No guessing, no long apology, no promise to find out later."
      : "Say plainly, in one short line, that you don't have a solid answer to what they just asked, without guessing, apologizing at length, or promising to find out later.",
    facts: [`They asked: "${message.slice(0, 200)}"`, ...(ahead ? ["Beyond what is scheduled, Cue doesn't have a confirmed answer to it right now.", ahead] : ["Cue doesn't have a confirmed answer to it right now."])],
    examples: [],
    fallback: MINIMAL_FALLBACK,
  });
  return r.written ? r.text : null;
}
// When an invite claim had to come out: what's true instead, so the reply
// still helps (2026-09-19). Asking with "invite" and "friend" goes through
// the invite step (services/invites.ts isInviteRequest).
const INVITE_FALLBACK = "Invites go through me. Ask me for an invite for your friend, and you'll get a link to forward.";

// Cheap pre-filter for the model claim read. Plain conversational replies
// ("That sounds hard. What's been the toughest part?") have nothing to
// verify, and the Sonnet read added ~2s p50 to every reply. Anything that
// could carry a checkable claim still gets read: numbers, times and dates,
// links or contact details, a proper name mid-sentence, Co describing its own
// actions or plans, or someone else's words or intent.
// Co itself saying it doesn't have something ("I don't have that on file",
// "nothing saved", "first I'm hearing of it"). First person and negated only:
// "the organizers don't have a time", "Lena is on file" and "their first time
// hosting" are claims about the world that still need a source (2026-10-01
// review of #49).
export const CO_DENIES_HAVING = /\b(?:i|we)\s+(?:do not|don'?t|haven'?t|have not|never)\s+(?:(?:actually|really|currently|even|yet)\s+)?(?:have|got|saved|heard)\b|\bnothing (?:saved|stored|on file)\b|\bnot on file\b|\bno record\b|\bfirst (?:i'?m hearing|i(?:'ve| have)? heard)\b/i;
// What sends a reply to the claim read: a denial, or anything about "on file".
// Not "don't know" or "first time", which are everyday companion lines
// ("I don't know, what do you think?") with nothing to verify.
const CLAIMS_ON_FILE = /\bon file\b/i;

// A false "I don't have that" can't just be cut: what's
// left ("Want to fill me in?") still doesn't answer them. It goes to the
// redraft, which sees their own words and the facts and says the true thing
// (2026-10-01, semanticLive cross-user). That includes a wrong "I don't have
// the start time" when a FACT gives it.
// What they told Cue: a snapshot entry in their own words (said; never the sheet, Cue's acts or its reads), or the summary and
// memories a caller passed.
export function deniesWhatTheyToldCo(failed: GateCheck[], src: GroundingSources, rf?: Pick<ReplyFacts, "facts">): boolean {
  return !!(rf?.facts.some((f) => f.snap === "said") || src.recentMemories?.trim() || src.contextSummary?.trim()) && failed.some((c) => /^claim_(detail|member_life)$/.test(c.name) && CO_DENIES_HAVING.test(c.reason ?? ""));
}

const CLAIM_SHAPED = [
  /\d/,
  /https?:\/\/|www\.|@/i,
  /\b(today|tonight|tomorrow|yesterday|week|weekend|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|noon|midnight)\b/i,
  /\b(i'?ll|i will|i'?ve|i have|i just|i already|i can'?t|i cannot|i'?m (going|calling|sending|booking|looking|checking)|let me|we'?ll|will be)\b/i,
  /\b(sent|shared|booked|scheduled|called|calling|texted|emailed|introduced|intro|registered|signed up|added|found|reached out|confirmed|link|address|located|starts|ends|event|call)\b/i,
  /\b(said|says|mentioned|told|asked|wants|wanted|would like|is going|are going|attending|opted|agreed|interested)\b/i,
  /[a-z,]\s+[A-Z][a-z]{2,}/,
  // Forecasts ("probably won't", "I don't think another one will turn up").
  /\b(probably|likely|unlikely|i don'?t think|i doubt|won'?t|going to|gonna|bet)\b/i,
  // Claiming a retry/resend happened (2026-09-17, real incident: "Trying
  // again, should come through as a separate contact card" went out
  // unchecked — a real action claim with none of the words above in it).
  /\b(trying again|try again|resend(ing)?|re-send(ing)?|should (come through|arrive|land)|sending (it|that|this) again)\b/i,
  // "Tried again just now and it didn't go through" (2026-10-01: a blocked
  // call that was never placed, unchecked because "tried" wasn't caught).
  /\b(tried|attempted|(didn'?t|not|isn'?t|wasn'?t|won'?t) (go|going|get|getting) through|couldn'?t (reach|get through|connect))\b/i,
  // Passing something along (2026-09-18: "feedback like that goes straight to
  // the team" went out unchecked when nothing had been saved).
  /\b(the team|noted|logged|forwarded|flagged|passed (it|that|this) (on|along)|pass(es|ing)? (it|that|this) (on|along)|goes (straight )?to)\b/i,
  // Anything Co says about how it works or what it does, in any tense: the
  // root of its false claims about itself has been a check that never read
  // them (2026-09-18), not missing facts.
  /\b(i|co|cue)\s+(always\s+|usually\s+|automatically\s+|already\s+)?(keep|track|watch|save|store|remember|pass|share|check|search|look|flag|log|note|monitor|follow|remind|send)(s|ed|ing)?\b/i,
  /\b(on my (list|radar)|my (daily )?search(es)?|i'?m (keeping|tracking|watching|saving|following))\b/i,
  // Co describing a search it ran, or a count spelled out (2026-09-25:
  // "Already ran that search, those two were the results" went out
  // unchecked, with no digit and no "I" in it, when the search had 4).
  /\b(ran|searched|searching|search|results?|came up|turned up|pulled (up|from))\b/i,
  /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)\b/i,
  // Saying Co doesn't have something (2026-10-01, evals/memory/semanticLive.ts
  // cross-user: "I don't have anything like that on file, no mentor or
  // startup name saved" went out unchecked while their memories named both).
  CO_DENIES_HAVING,
  CLAIMS_ON_FILE,
  // Co saying what it did to an artifact, or what one contains (2026-10-12 documents run: "I left the example section open... I put
  // the frame and the closing ask in" went out unchecked about a document that didn't exist).
  /\b(?:i|i'?ve|i have|i just|i already)\s+(?:just\s+|already\s+)?(?:left|put|kept|added|included|built|wrote|written|set up|made|drafted|filled in|laid out|structured|organized|framed)\b/i,
  /\b(?:the|your|this|that|my)\s+(?:doc|document|deck|page|pdf|draft|brief|sheet|plan|slides?|outline|proposal|one-pager|section|template)\b[^.?!]{0,50}\b(?:has|have|includes?|covers?|contains?|opens? with|ends? with|lays out|walks through|starts with|leads with|closes with|is (?:built|set up|structured))\b/i,
  /\b(?:it|each slide|every section|the first|the last)\s+(?:covers|includes|contains|opens with|ends with|lays out|walks through)\b/i,
  // Cue saying it changed something, or what it does from now on (2026-10-31: "Got it, switching to SF from here on out." skipped
  // the read: no digit, no "I", and SF isn't Title Case).
  /\b(?:switch(?:ed|ing)?|swap(?:ped|ping)?)\b|\b(?:from (?:here|now) on|going forward|moving forward|for now on|from this point)\b/i,
  // Where something stands, or what someone else is doing (2026-11-02: a member had handed someone something to try, and "right now
  // you've got him trying it" went out unread: no digit, no name, no "I"). On 686 reply turns over 30 days on dev these match 68, and
  // 7 of those (1.0% of all turns) weren't read before.
  /\b(?:right now|so far|at this point|as it stands|where (?:it|things|this) stands)\b/i,
  /\b(?:he|she)(?:['’]s|\s+is|\s+isn['’]t|\s+has|\s+hasn['’]t|\s+was|\s+wasn['’]t|\s+did|\s+didn['’]t|\s+already|\s+still)\b|\byou(?:['’]ve|\s+have)\s+got\s+(?:him|her|them)\b/i,
];

export function needsClaimCheck(draft: string): boolean {
  return CLAIM_SHAPED.some((re) => re.test(draft));
}
// One retry before giving up on a claim-shaped draft (2026-09-17 code
// review): a single bad JSON response or a transient failure used to send
// the draft "unchecked," with only the cheap regex checks behind it.
async function check(draft: string, rf: ReplyFacts, src: GroundingSources, model?: string, force = false): Promise<{ checks: GateCheck[]; modelOk: boolean; ms: number }> {
  // The admission read, the thread read and the claim read start together (review, 2026-10-14: the thread read ran first and held the
  // claim read back a whole Haiku round trip); the code checks read the first two's answers, so they run once all have settled.
  const pre = Promise.all([admitNarratedSentences(draft, rf), judgeThreadReports(draft, rf, src)]);
  // Their own rules for replies (member preferences PR C): one small read, only when they have such rules. A sentence raising a subject
  // they asked Cue not to bring up is cut like an unsupported claim; a clear style break is flagged (logged, never a cut: style isn't
  // guaranteed in code). A read that fails flags nothing.
  const ruleRead: Promise<GateCheck[]> = rf.prefRules ? import("../services/prefTopics.js").then((T) => T.judgeReplyRules(draft, rf.prefRules!, src.message, undefined, src.recentConversation.split("\n").slice(-8).join("\n"))).catch(() => []) : Promise.resolve([]);
  // With a failure of Cue's own in the facts, a line about it ("It didn't go through on my end") is read for claims even when it isn't
  // claim-shaped, so it can stand on that fact instead of being cut as machinery talk unread.
  if (!force && !needsClaimCheck(draft) && !(failureInView(rf.facts).inView && narratesInternalState(draft))) {
    const [, rules] = await Promise.all([pre, ruleRead]);
    return { checks: [...codeChecks(draft, rf, src), ...rules, { name: "claim_read", pass: true, reason: "nothing claim-shaped, model read skipped" }], modelOk: true, ms: 0 };
  }
  const claimed = (async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const extracted = await extractClaims(draft, rf, src, model);
        if (extracted) {
          const [admissions, ownership] = await Promise.all([admissionsFor(extracted.claims, undefined, rf.facts), ownershipReadsFor(extracted.claims, rf, src)]);
          return { checks: claimChecks(extracted.claims, rf, src, admissions, ownership), ms: extracted.latencyMs };
        }
        console.error(`replyGrounding: claim check returned unusable JSON on attempt ${attempt}${attempt === 1 ? ", retrying once" : ""}`);
      } catch (err: any) {
        console.error(`replyGrounding: claim check failed on attempt ${attempt}${attempt === 1 ? ", retrying once" : " (non-fatal, giving up)"}:`, err?.message ?? err);
      }
    }
    return null;
  })();
  const [, claims, rules] = await Promise.all([pre, claimed, ruleRead]);
  const code = [...codeChecks(draft, rf, src), ...rules];
  return claims ? { checks: [...code, ...claims.checks], modelOk: true, ms: claims.ms } : { checks: code, modelOk: false, ms: 0 };
}

// The claim read alone (the grounding evals use it): only the claim checks, none of Co's own code checks.
export async function claimChecksOnly(draft: string, rf: ReplyFacts, src: GroundingSources, opts: { force?: boolean } = {}): Promise<GateCheck[]> {
  if (!opts.force && !needsClaimCheck(draft)) return [];
  const extracted = await extractClaims(draft, rf, src).catch(() => null);
  return extracted ? claimChecks(extracted.claims, rf, src, await admissionsFor(extracted.claims, undefined, rf.facts), await ownershipReadsFor(extracted.claims, rf, src)) : [];
}

// True when the claim read never came back for a draft that's claim-shaped
// (a number, a link, a name, an action, a promise, ...) — code checks alone
// aren't enough to trust it, so this is treated as a failed check rather
// than silently shipped "unchecked" (2026-09-17 code review).
function claimReadUnavailable(draft: string, result: { modelOk: boolean }): boolean {
  return !result.modelOk && needsClaimCheck(draft);
}
const CLAIM_READ_FAILED_CHECK: GateCheck = {
  name: "claim_read_failed",
  pass: false,
  reason: "the claim check couldn't run twice; treating the draft as unverified",
};

// The binding guard for one reply (services/promiseBinding.ts). Never opens a task on a turn that kept a confidence or for a sentence
// that names another member (the same lines trackPromise holds). Fail-safe: if the guard itself breaks, each timed-promise-shaped
// sentence with no promise tracked this turn is treated as unbound.
async function bindThisReply(draft: string, rf: ReplyFacts, src: GroundingSources, userId: string): Promise<{ checks: GateCheck[]; opened: { id: number; sentence: string }[]; pulled: import("../services/promiseBinding.js").Pulled[]; deferred: string[] }> {
  const B = await import("../services/promiseBinding.js");
  const discreet = isDiscreetTurn(rf.instructions);
  const names = (rf.privateNames ?? []).filter(Boolean);
  const namesMember = (s: string) => names.some((n) => new RegExp(`\\b${n.split(/[^\w]+/).filter(Boolean).join("[-\\s]?")}\\b`, "i").test(s));
  try {
    const deps = await B.realBindDeps(userId, src.message, workVerdict(rf.turnScope));
    // A call promise with no scheduled call goes to the claim read (it sees scheduled-call facts); cut below if that read didn't run.
    deps.deferCallsToClaimRead = true;
    const open = deps.openPromise;
    deps.openPromise = (o) => (discreet || namesMember(o.sentence) ? Promise.resolve({ ok: false as const, why: discreet ? "a turn that kept a confidence" : "it names a member it can't" }) : open(o));
    const r = await B.bindPromises(draft, deps);
    for (const v of r.verdicts) {
      if (!v.bound) continue;
      if (v.how === "opened") addFact(rf, "did_this_turn", `Started task #${v.entry}: Keep your promise: "${v.sentence.slice(0, 170)}". It's on Cue's schedule to fire by the time it says.`);
      if (v.how === "pulled") addFact(rf, "scheduled", `Cue moved task #${v.entry} so it fires in time for what it told them: "${v.sentence.slice(0, 170)}".`);
    }
    if (r.verdicts.length) recordDecision({ layer: 3, decision: "promise.binding", userId, outcome: r.checks.length ? "skip" : "act", action: r.read ? "read" : "unread", proposal: { verdicts: r.verdicts } }).catch(() => {});
    return { checks: r.checks, opened: r.opened, pulled: r.pulled, deferred: r.deferred };
  } catch (err: any) {
    console.error("replyGrounding: promise binding failed (fail-safe, unbound promises cut):", err?.message ?? err);
    const tracked = rf.facts.some((f) => f.kind === "did_this_turn" && STARTED_WORK.test(f.text));
    const checks = tracked ? [] : B.timedPromiseShaped(draft).map((s) => ({ name: "claim_future_promise", pass: false, reason: `future_promise: "${s}" (the promise check couldn't run, so nothing vouches that it's scheduled)` }));
    return { checks, opened: [], pulled: [], deferred: [] };
  }
}

// Pure: dead air on this turn (services/memberWorld.ts deadAir), after every path that says something truer has had its turn: the
// nothing-running line (a cut work claim with nothing running), a false "I don't have that" (the redraft corrects it), an invite cut
// (the invite line), a safety turn, a discreet turn. The honest no-answer keeps an empty or near-empty cut (deadAir needs 3+ words).
// Pure: the nothing-running line (#190) applies: a cut work claim while nothing runs, about Co's own work. Never when the cut sentence
// named the member's own thread (services/memberWorld.ts cutNamesThread): it's theirs, so "want me to start on it?" would offer to take
// over something only they own (case 30, 2026-10-14). #190 is unchanged for Co's own work.
export function nothingRunningLineApplies(o: { draft: string; cut: string; failed: GateCheck[]; rf: ReplyFacts }): boolean {
  const workClaims = o.failed.filter((c) => c.name === "claim_work_status");
  return workClaims.length > 0 && nothingRunsAt(o.rf) && !startedThisTurn(o.rf) && !searchedThisTurn(o.rf) && !workClaimsNameThread(o.rf.world, workClaims.map((c) => claimWords(c) ?? ""));
}
// Pure: a turn no redraft of these two kinds runs on (dead air, a cut thread report): a safety turn, a discreet turn, an invite cut.
export function redraftHeldBack(rf: ReplyFacts, failed: GateCheck[]): boolean {
  return rf.instructions.includes(SAFETY_INSTRUCTION) || isDiscreetTurn(rf.instructions) || failed.some((c) => c.name === "no_invite_sent_claim");
}
// Pure: a cut thread report gets one redraft, whatever is left (case 30, 2026-10-14: cutting "Nothing yet from the Hayes Valley
// place." left "I'll be glad to hear it the second you do.", its "it" pointing at nothing). One Sonnet call, only on such a cut.
export function threadRedraftAt(o: { failed: GateCheck[]; rf: ReplyFacts }): boolean {
  return o.failed.some((c) => c.name === "no_thread_report") && !redraftHeldBack(o.rf, o.failed);
}
// When enough is left after a thread report was cut, the one redraft only repairs: every remaining sentence stays, and only words that
// pointed back at the cut one change (keepsEverySentence checks it in code). The smallest-true-reply redraft is only for too little left.
export const THREAD_REPAIR_NOTE = "A sentence saying where their own thread stands was cut: only they know that. Keep every remaining sentence exactly as it is, in the same order, and change only words that refer back to the cut sentence (a dangling \"it\" or \"that\") so each stands on its own. Add nothing and drop nothing.";
async function repairAfterThreadCut(cut: string, rf: ReplyFacts, src: GroundingSources): Promise<string | null> {
  const { text } = await generateText({
    model: anthropic(LAYER3_MODELS.redraft),
    maxOutputTokens: 1000,
    providerOptions: { anthropic: { effort: GROUNDING_EFFORT } },
    abortSignal: AbortSignal.timeout(GROUNDING_CALL_TIMEOUT_MS),
    experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.thread_repair" },
    ...judgeSystem(rf),
    prompt: `${CO_TEXT_CHANNEL}

${renderJudgeFacts(rf)}

They just said: "${src.message}"

Your reply, after a line was cut:
"${cut}"

${THREAD_REPAIR_NOTE} Return ONLY the message.`,
  });
  const out = text.trim().replace(/^"|"$/g, "");
  return out || null;
}
export const THREAD_REDRAFT_NOTE = "A sentence saying where their own thread stands was cut: only they know that. Don't say where it stands; ask about it, or leave it out, and make sure nothing left points back at what was cut.";
export function deadAirAt(o: { draft: string; cut: string; failed: GateCheck[]; rf: ReplyFacts; src: GroundingSources }): boolean {
  if (redraftHeldBack(o.rf, o.failed)) return false;
  if (deniesWhatTheyToldCo(o.failed, o.src, o.rf)) return false;
  if (nothingRunningLineApplies(o)) return false;
  return deadAir({ draft: o.draft, cut: o.cut, world: o.rf.world, failed: o.failed, sentThisTurn: o.src.answeredThisTurn ?? o.src.sentThisTurn });
}

// A cut that leaves a reply to something they shared flat (Royce, 2026-10-28). He wrote "I'm just getting back from my birthday/vacation.
// I'm honestly feeling hopeful and recharged"; the draft's closing line invented "the gym today", the check rightly cut it, and what went
// out was "That's a good place to come back from.": true, and generic enough to fit anyone. Removing an invented detail is right; sending
// a reply that no longer engages is not. So when they're sharing something (or telling Cue how it's coming across) and the cut took the
// part that engaged with them, Cue gets one rewrite from supported context, checked again like any rewrite. Never a second rewrite.
// Signals, all already on hand: the turn's moment read (rf.moment), how much of the draft the cut took, whether a question to them
// survived, and whether what's left still carries any of their own words. Those only decide whether to ask; the rewrite call itself
// decides first whether what's left still responds to them (a short warm line that fits them is a complete reply, Royce 2026-10-28:
// "respect when the moment is complete"), the way the dead-air redraft decides check-in (WORLD_REDRAFT_NOTE). One Sonnet call, plus
// the usual recheck when the rewrite is claim-shaped, only on such a cut.
export const SHARE_MOMENTS = new Set(["sharing", "feedback"]);
// The share rewrite's forced claim read (recheck, force): Haiku, the one extra call that path makes.
export const SHARE_RECHECK_MODEL = MODELS.haiku;
// Everyday words that say nothing about what they shared ("honestly", "getting", "about"), so carrying one isn't engaging with them.
const EVERYDAY = new Set("about after again also always another around because before being better could doing every going getting gonna honestly maybe might never other really since something still their there these thing things think those though today tomorrow tonight wanna where which while would yeah yesterday".split(" "));
const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;
// Pure: their own content words (5+ letters, not everyday filler), for telling whether what's left still touches what they said.
export function theirContentWords(message: string): Set<string> {
  return new Set((message.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z][a-z']+/g) ?? []).map((w) => w.replace(/'s$|'/g, "")).filter((w) => w.length >= 5 && !EVERYDAY.has(w)));
}
export function echoesThem(text: string, message: string): boolean {
  const theirs = theirContentWords(message);
  return [...theirContentWords(text)].some((w) => theirs.has(w));
}
// Pure: whether a cut on a sharing (or feedback) turn may have left a stub, so the one rewrite call is asked. Not merely short: the cut
// took at least a third of the draft, no question to them survived, and nothing left carries their own words. The rewrite call still
// decides whether what's left already fits them.
export function shareCutStub(o: { moment: string | null | undefined; draft: string; cut: string; message: string }): boolean {
  if (!o.moment || !SHARE_MOMENTS.has(o.moment)) return false;
  const cut = o.cut.trim();
  const draft = o.draft.trim();
  if (!cut || cut === draft || cut.includes("?")) return false;
  if (wordCount(cut) > (wordCount(draft) * 2) / 3) return false;
  return !echoesThem(cut, o.message);
}

// The removed claims' own words, for the rewrite to steer clear of and for code to hold it to.
export function removedClaims(failed: GateCheck[]): string[] {
  return failed.map((f) => claimWords(f) ?? (f.reason ?? "").match(/"([^"]{6,})"/)?.[1] ?? null).filter((x): x is string => !!x && x.trim().length >= 6);
}

// Questions (Royce, 2026-10-28): as many as it takes to understand, when they're one continuous thought. Whether they follow one thread
// is the model's call, from the guidance (Cue decides; code guards facts); a word-overlap rule rejected real follow-ups ("What made
// this one land? Was it the people or the place?"). Code holds only the questionnaire line: more than three in one message.
export const QUESTIONNAIRE_AT = 4;
export function questionCount(text: string): number {
  return (text.match(SENTENCES) ?? []).map((x) => x.trim()).filter((x) => /\?["')\]]*$/.test(x)).length;
}

// On a feedback turn the rewrite may offer to fix what Cue got wrong in what it sent: redo or replace that one thing, asked as a
// question (Royce, 2026-10-28). Never a new recommendation or an unrelated offer.
const REDO = /\b(?:another|a new|a working|a better|again|instead|replace|resend|re-send|redo|fix|correct(?:ed)?|the right one|updated)\b/i;
const OFFER = /^\W*(?:(?:so|and|or),?\s+)?(?:want me to|should i|do you want me to|i can|i could|happy to|shall i)\b/i;
// An offer to do something for them, asked: a share rewrite adds none, except the one fix on a feedback turn.
const OFFER_ASK = /\b(?:want me to|do you want me to|should i|shall i)\b/i;
export function offersToFixIt(sentence: string): boolean {
  return /\?["')\]]*$/.test(sentence.trim()) && OFFER.test(sentence) && REDO.test(sentence);
}

export function shareRewritePrompt(o: { facts: string; tail: string; theirWords: string; message: string; draft: string; removed: string[]; cut: string; offerKeep: boolean; feedback?: boolean }): string {
  const cutPart = o.removed.length
    ? `\nThe reply check took out these parts, because nothing they've said and none of the facts above support them. Don't say them again, in any wording:\n${o.removed.map((r) => `- "${r}"`).join("\n")}\n\nWhat's left: "${o.cut || "(nothing)"}"\n`
    : "";
  const decide = o.offerKeep
    ? `First decide whether what's left still responds to what they actually said, in a way that wouldn't fit just anyone. A short warm line that fits them is a complete reply; it doesn't need a question. If it does, return {"engages": true, "reply": ""}.\n\nIf it doesn't, write the reply again`
    : `Write the reply again`;
  return `${CO_VOICE}

${CO_TEXT_CHANNEL}

${o.facts}

Recent conversation:
${o.tail || "(none)"}
${o.theirWords ? `\nWhat they've told you before (their own words about their own life):\n${o.theirWords}\n` : ""}
They just said: "${o.message}"

Your draft reply:
"${o.draft}"
${cutPart}
They were telling you something that matters to them, or how you're coming across, so the reply has to respond to that. ${decide} from their words and the facts above only. Keep what the draft was doing and its warmth. Respond to what they shared and what it means to them: a specific reaction, a small observation or opinion of your own, or questions that follow one thread when there's something worth understanding; never unrelated ones, never one they've already answered. Use what they've already told you rather than asking it again, and don't repeat their words back to them. ${o.feedback ? "If something you sent was wrong, say so in a few plain words and you may offer to fix that one thing (redo or replace it); no other offer or recommendation. Don't otherwise talk about your earlier reply: don't quote it or repeat its words, don't compare this reply with it, and don't describe your own tone or how you came across. " : ""}Wishing them well or reacting to their news needs no source; any activity, plan, date, place, person, history or reason you mention must be in their words or the facts, and when you don't know it, leave it out. Don't guess why they feel what they feel. No advice or plan unless they asked for one. Their register, at most one short line longer than the draft. Return ONLY JSON: {"engages": false, "reply": "the message"}.`;
}

export function parseShareRewrite(text: string | null | undefined): { engages: boolean; reply: string } | null {
  let j: { engages?: unknown; reply?: unknown } | null = null;
  try {
    j = parseModelJson<{ engages?: unknown; reply?: unknown }>(String(text ?? ""));
  } catch {
    return null;
  }
  return typeof j?.engages === "boolean" ? { engages: j.engages, reply: typeof j.reply === "string" ? j.reply.trim() : "" } : null;
}

// Pure: the code guard on the share rewrite (the share-turn form of rewriteAddsNothing). The removed claims stay out; any name, number,
// day or link is from what's left, the facts or their words (never from the cut sentences); a feeling word only as they said it; no new
// recommendation (on a feedback turn, an offer to fix what Cue sent is allowed); no questionnaire; it doesn't say their words
// back to them; no feelings named back at them.
export function shareRewriteAddsNothing(o: { rewrite: string; draft: string; cut: string; removed: string[]; allowed: string; message: string; feedback?: boolean }): { ok: boolean; why: string | null } {
  const flat = (t: string) => ` ${t.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const r = o.rewrite.trim();
  if (!r) return { ok: false, why: "empty" };
  if (r.length > o.draft.length + 60) return { ok: false, why: "longer than the draft" };
  if (questionCount(r) >= QUESTIONNAIRE_AT) return { ok: false, why: "a questionnaire" };
  if (!checkNoEmotionLabel(r).pass) return { ok: false, why: "names their feelings" };
  const fr = flat(r);
  const back = o.removed.find((x) => fr.includes(flat(x)));
  if (back) return { ok: false, why: `says a removed claim again: "${back}"` };
  const known = `${o.cut}\n${o.allowed}\n${o.message}`.toLowerCase();
  const said = o.message.toLowerCase();
  const kept = flat(o.cut);
  let fixOffers = 0;
  for (const sentence of (r.match(SENTENCES) ?? []).map((x) => x.trim()).filter((x) => x && !kept.includes(flat(x)))) {
    const feelings = sentence.match(new RegExp(FEELING_WORDS.source, "gi")) ?? [];
    const notTheirs = feelings.filter((w) => !said.includes(w.toLowerCase()));
    if (notTheirs.length) return { ok: false, why: `adds something about how they feel: "${sentence}"` };
    const fixOffer = !!o.feedback && offersToFixIt(sentence) && ++fixOffers === 1;
    if (RECOMMENDS.test(sentence) && !fixOffer) return { ok: false, why: `adds a recommendation: "${sentence}"` };
    if (OFFER_ASK.test(sentence) && !fixOffer) return { ok: false, why: `adds an offer: "${sentence}"` };
    const added = specifics(sentence).filter((t) => !known.includes(t));
    if (added.length) return { ok: false, why: `adds ${added.join(", ")} that isn't in what's left, the facts or their words` };
  }
  return { ok: true, why: null };
}

export type ShareRepair = { final: string | null; how: "kept" | "rewrite" | "rewrite_trimmed" | "none"; checks: GateCheck[]; why: string };
export type ShareRepairDeps = {
  // The one rewrite call: its raw answer, or null.
  write: () => Promise<string | null>;
  // The usual re-read of a rewrite (recheck): code checks on the whole, the claim read on what changed.
  recheck: (rewrite: string) => Promise<{ checks: GateCheck[]; modelOk: boolean }>;
  // Code checks alone, for a trimmed rewrite (no model call).
  codeFails: (text: string) => GateCheck[];
};
// The bounded repair, with its model calls injected (the layer-1 tests drive it with fakes). At most one rewrite and one recheck: a
// rewrite that fails the recheck keeps only its sentences that passed (no new call), when that still says something; otherwise the
// caller sends what it had. Never a second rewrite, never a loop.
// offerKeep: the call may answer that what's left already fits them. Only when what's left carries their own words (Royce, 2026-10-28:
// live, the call kept "That's a good place to come back from." as fitting); with none of their words it has to write the reply, and an
// "it fits" answer is not taken.
export async function repairShareCut(o: { draft: string; cut: string; failed: GateCheck[]; message: string; allowed: string; offerKeep: boolean; feedback?: boolean }, deps: ShareRepairDeps): Promise<ShareRepair> {
  let raw: string | null = null;
  try {
    raw = await deps.write();
  } catch (err: any) {
    return { final: null, how: "none", checks: [], why: `the rewrite call failed: ${String(err?.message ?? err).slice(0, 120)}` };
  }
  const parsed = parseShareRewrite(raw);
  if (!parsed) return { final: null, how: "none", checks: [], why: "the rewrite didn't come back in shape" };
  if (parsed.engages && o.offerKeep) return o.cut.trim() ? { final: o.cut, how: "kept", checks: [], why: "what's left still responds to them" } : { final: null, how: "none", checks: [], why: "nothing left to keep" };
  if (!parsed.reply) return { final: null, how: "none", checks: [], why: parsed.engages ? "answered that it fits, which wasn't on offer (none of their words left)" : "no rewrite came back" };
  const rewrite = cleanCoMessage(parsed.reply);
  const removed = removedClaims(o.failed);
  const guard = shareRewriteAddsNothing({ rewrite, draft: o.draft, cut: o.cut, removed, allowed: o.allowed, message: o.message, feedback: o.feedback });
  if (!guard.ok) return { final: null, how: "none", checks: [], why: `rewrite rejected: ${guard.why}` };
  const r = await deps.recheck(rewrite);
  // The share rewrite's read is forced, so a read that didn't come back is a failed read whatever the rewrite looks like.
  const failed2 = !r.modelOk ? [...r.checks.filter((c) => !c.pass), CLAIM_READ_FAILED_CHECK] : r.checks.filter((c) => !c.pass);
  if (!failed2.length) return { final: rewrite, how: "rewrite", checks: r.checks, why: "rewrite passed the recheck" };
  // Still unsupported somewhere: keep only the rewrite's sentences that passed, if that still says something and passes the code checks.
  const trimmed = stripUnsupported(rewrite, failed2).trim();
  const trimmedOk = !!trimmed && trimmed !== rewrite.trim() && wordCount(trimmed) >= 3 && !danglingQuestion(trimmed) && !apologyOnly(trimmed) && !deps.codeFails(trimmed).length && !removed.some((x) => norm(trimmed).includes(norm(x)));
  if (trimmedOk) return { final: trimmed, how: "rewrite_trimmed", checks: r.checks, why: "the rewrite's unsupported part was cut; the rest passed" };
  return { final: null, how: "none", checks: r.checks, why: "the rewrite failed the recheck too" };
}

export async function groundReply(
  rawDraft: string,
  rf: ReplyFacts,
  src: GroundingSources,
  opts: { userId?: string | null; record?: boolean } = {},
): Promise<GroundingResult> {
  const started = Date.now();
  const draft = cleanCoMessage(stripFactIds(rawDraft));
  // A concrete promise with nothing behind it becomes a task Co owns, so it is
  // true and gets kept (services/promises.ts). Only on a real send, never in an eval.
  let promiseTaskId: number | null = null;
  if (opts.userId && opts.record !== false && unbackedFollowup(draft, rf)) {
    // This turn's own receipts go with it, so work this turn already started is never opened again as a promise task.
    const startedThisTurn = rf.facts.filter((f) => f.kind === "did_this_turn").map((f) => f.text);
    const tracked = await trackPromise({ userId: opts.userId, reply: draft, theirMessage: src.message, privateNames: rf.privateNames, discreet: isDiscreetTurn(rf.instructions), startedThisTurn, scope: workVerdict(rf.turnScope) }).catch((err: any) => ({ ok: false as const, why: String(err?.message ?? err).slice(0, 120) }));
    if (tracked.ok) {
      addFact(rf, "did_this_turn", promiseFact(tracked.task));
      promiseTaskId = tracked.task.id;
    }
    recordDecision({ layer: 3, decision: "promise.tracked", userId: opts.userId, outcome: tracked.ok ? "act" : "skip", action: tracked.ok ? `task:${tracked.task.id}` : tracked.why, proposal: { sentence: tracked.ok ? tracked.sentence : promiseSentence(draft) } }).catch(() => {});
  }
  // A promise with a time binds to the ledger, or it isn't said (services/promiseBinding.ts, 2026-10-13): a Haiku read finds each
  // timed promise, code checks an entry fires by then, binds it when it can, and fails the rest as unsupported future promises.
  const binding = opts.userId && opts.record !== false ? await bindThisReply(draft, rf, src, opts.userId) : { checks: [] as GateCheck[], opened: [] as { id: number; sentence: string }[], pulled: [] as import("../services/promiseBinding.js").Pulled[], deferred: [] as string[] };
  const checked = await check(draft, rf, src);
  // A call promise left to the claim read stands only if that read actually ran (review: never exempt by the read's label alone).
  const unvouchedCalls: GateCheck[] = checked.modelOk ? [] : binding.deferred.map((s) => ({ name: "claim_future_promise", pass: false, reason: `future_promise: "${s}" (no scheduled call fires by then, and the claim check couldn't run)` }));
  const extra = [...binding.checks, ...unvouchedCalls];
  const first = extra.length ? { ...checked, checks: [...checked.checks, ...extra] } : checked;
  const firstCheckMs = Date.now() - started;
  const stages: NonNullable<GroundingResult["stages"]> = {};
  let result: GroundingResult;
  // A style flag (prefTopics.ts PREF_STYLE) is logged with the reply, never cut or rewritten for: style can't be guaranteed in code.
  const failed1 = first.checks.filter((c) => !c.pass && c.name !== "pref_style");
  // A claim-shaped draft whose claim read failed twice is treated as a
  // failed check, not sent as "unchecked" on code checks alone (2026-09-17
  // code review) — it goes through the same redraft-then-strip path below.
  const effectiveFailed1 = claimReadUnavailable(draft, first) ? [...failed1, CLAIM_READ_FAILED_CHECK] : failed1;

  // The one share rewrite (repairShareCut), for a sharing or feedback turn: after a cut that left a stub or too little. Never more than one
  // a reply.
  const shareMoment = !!rf.moment && SHARE_MOMENTS.has(rf.moment);
  const runShare = async (o: { cut: string; failed: GateCheck[]; offerKeep: boolean }): Promise<ShareRepair> => {
    const t0 = Date.now();
    const allowed = [...rf.facts.filter((f) => f.kind !== "hint").map((f) => f.text), theirOwnWords(src.recentMemories), theirOwnWords(src.recentConversation)].join("\n");
    const feedback = rf.moment === "feedback";
    const r = await repairShareCut(
      { draft, cut: o.cut, failed: o.failed, message: src.message, allowed, offerKeep: o.offerKeep, feedback },
      {
        write: async () =>
          (
            await generateText({
              model: anthropic(LAYER3_MODELS.redraft),
              maxOutputTokens: 1000,
              providerOptions: { anthropic: { effort: GROUNDING_EFFORT } },
              abortSignal: AbortSignal.timeout(GROUNDING_CALL_TIMEOUT_MS),
              experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.share_rewrite" },
              ...judgeSystem(rf),
              prompt: shareRewritePrompt({ facts: renderJudgeFacts(rf), tail: src.recentConversation.split("\n").slice(-14).join("\n"), theirWords: theirOwnWords(src.recentMemories), message: src.message, draft, removed: removedClaims(o.failed), cut: o.cut, offerKeep: o.offerKeep, feedback }),
            })
          ).text,
        recheck: async (rewrite) => {
          const t1 = Date.now();
          // Forced, on Haiku (review of #310): a rewrite's new sentence can carry an invented detail nothing claim-shaped points at ("A trip
          // with your sister is a good reset."), so what it changed is always read. One Haiku call, only on this path.
          const rc = await recheck(draft, rewrite, o.failed, rf, src, { force: true, model: SHARE_RECHECK_MODEL });
          stages.secondCheckMs = Date.now() - t1;
          return rc;
        },
        codeFails: (text) => codeChecks(text, rf, src).filter((c) => !c.pass),
      },
    );
    stages.redraftMs = Date.now() - t0;
    return r;
  };
  const shareChecks = (r: ShareRepair, why: string): GateCheck[] => [...r.checks.map((c) => ({ ...c, name: `redraft.${c.name}` })), { name: "share_repair", pass: true, reason: `${why}; ${r.how}: ${r.why}` }];

  if (!effectiveFailed1.length) {
    result = { final: draft, outcome: "as_drafted", checks: first.checks, latencyMs: Date.now() - started, firstCheckMs, stages };
  } else {
    // 1. Delete what's unsupported (2026-09-28, remove-only). What's left was
    // already checked, so it needs no second model read; code checks still run.
    // The same allowance the narration check made (a true "it hasn't come through", services/inboundFile.ts).
    const allowArrival = { allow: (sentence: string) => (recordSaysNothingReadable(rf.facts) && arrivalDenial(sentence)) || admittedSentence(rf, sentence) || honestNothingRunning(rf, sentence) || worldLineAllowed(rf.world, sentence) || failureBackedSentence(rf, sentence) };
    let cut = stripUnsupported(draft, effectiveFailed1, allowArrival);
    const cutCode = codeChecks(cut, rf, src).filter((c) => !c.pass);
    if (cutCode.length) cut = stripUnsupported(cut, cutCode, allowArrival);
    const inviteCut = effectiveFailed1.some((c) => c.name === "no_invite_sent_claim") && !rf.facts.some((f) => /invites are used/i.test(f.text));
    // Dead air (Royce, 2026-10-14: "Good to hear from you." was all that went out at 12:04am, with a question of Co's waiting on him):
    // the cut left a few words of presence while their world has a true line. The draft is retried with the facts; if that can't be
    // kept, the true line is said from their world (services/memberWorld.ts worldLine), the way #190 grounds the nothing-running line.
    const silent = deadAirAt({ draft, cut, failed: effectiveFailed1, rf, src });
    // A cut thread report always gets the one redraft (threadRedraftAt); its rewrite is rechecked like any other, thread read
    // included, and if that fails too the cut goes out: never a second redraft.
    const threadCut = threadRedraftAt({ failed: effectiveFailed1, rf });
    // What's left must not be only an apology (2026-10-03: "Sorry for the false
    // start." was all that remained of a reply about someone else).
    // The narration rule cut a sentence that carried a claim the claim read supported (live re-record of #310, whats-ahead: "Thursday
    // morning I'll check in on where the branding work landed, that's the one thing on the calendar from my end." went, and only the
    // question after it was sent): cut too far, so the one redraft says that answer without the machinery talk, rechecked. If it can't
    // be kept, the cut goes, as before. Never a trim by code: a clause cut from a sentence can change what it means.
    const lostSupported = narrationCutSupported({ draft, cut, checks: first.checks });
    const cutStands = enoughLeft(cut, draft) && !apologyOnly(cut) && !inviteCut && !deniesWhatTheyToldCo(effectiveFailed1, src, rf) && !silent && !lostSupported;
    // A sharing (or feedback) turn whose cut left too little, or left a stub (shareCutStub), gets the one share rewrite (repairShareCut)
    // instead of the smallest-true-reply redraft. Every other path that says something truer keeps its turn: a safety or discreet turn,
    // a cut thread report, dead air, an invite, a false "I don't have that", the nothing-running line.
    const shareTurn = shareMoment && !redraftHeldBack(rf, effectiveFailed1) && !threadCut && !silent && !inviteCut && !deniesWhatTheyToldCo(effectiveFailed1, src, rf) && !nothingRunningLineApplies({ draft, cut, failed: effectiveFailed1, rf });
    const stub = shareCutStub({ moment: rf.moment, draft, cut, message: src.message });
    if (cutStands && !threadCut && shareTurn && stub) {
      // The cut left a stub (none of their words left, so the call must write the reply): one rewrite, rechecked; what's left goes out if
      // it can't be kept.
      const r = await runShare({ cut, failed: effectiveFailed1, offerKeep: false });
      result = { final: r.final ?? cut, outcome: r.how === "rewrite" || r.how === "rewrite_trimmed" ? "redrafted" : "cut", checks: [...first.checks, ...shareChecks(r, "the cut left a stub")], latencyMs: Date.now() - started, firstCheckMs, stages };
    } else if (cutStands && !threadCut) {
      result = { final: nothingRunningLineApplies({ draft, cut, failed: effectiveFailed1, rf }) ? await withNothingRunningLine(cut, effectiveFailed1, rf) : cut, outcome: "cut", checks: first.checks, latencyMs: Date.now() - started, firstCheckMs, stages };
    } else if (cutStands) {
      // A thread report was cut and enough is left: one repair that keeps every remaining sentence (keepsEverySentence), rechecked
      // like any rewrite; anything else, the cut goes out. Never a second try.
      const t0 = Date.now();
      let repaired: string | null = null;
      try {
        const raw = await repairAfterThreadCut(cut, rf, src);
        stages.redraftMs = Date.now() - t0;
        const cleaned = raw ? cleanCoMessage(raw) : null;
        const allowed = [...rf.facts.filter((f) => f.kind !== "hint").map((f) => f.text), theirOwnWords(src.recentMemories)].join("\n");
        // What was cut away: the draft's sentences that aren't in what's left (the repair may only borrow their words).
        const cutAway = (draft.match(SENTENCES) ?? []).map((x) => x.trim()).filter((x) => x && !cut.includes(x)).join(" ");
        if (cleaned && cleaned.trim() !== cut.trim() && keepsEverySentence(cut, cleaned, cutAway) && rewriteAddsNothing(draft, cleaned, allowed).ok) {
          const t1 = Date.now();
          const r = await recheck(cut, cleaned, effectiveFailed1, rf, src);
          stages.secondCheckMs = Date.now() - t1;
          const failed2 = claimReadUnavailable(cleaned, r) ? [...r.checks.filter((c) => !c.pass), CLAIM_READ_FAILED_CHECK] : r.checks.filter((c) => !c.pass);
          if (!failed2.length) repaired = cleaned;
        } else if (cleaned && cleaned.trim() !== cut.trim()) console.error("replyGrounding: thread repair changed more than the words pointing back, sending the cut");
      } catch (err: any) {
        console.error("replyGrounding: thread repair failed (non-fatal, sending the cut):", err?.message ?? err);
      }
      const base = repaired ?? cut;
      result = { final: nothingRunningLineApplies({ draft, cut, failed: effectiveFailed1, rf }) ? await withNothingRunningLine(base, effectiveFailed1, rf) : base, outcome: repaired ? "redrafted" : "cut", checks: first.checks, latencyMs: Date.now() - started, firstCheckMs, stages };
    } else {
      // 2. Too little left: one model rewrite, kept only if it adds nothing.
      let kept: { text: string; checks: GateCheck[] } | null = null;
      let checkin: boolean | null = null;
      // A sharing turn cut to too little: the share rewrite is its one rewrite (repairShareCut), never this redraft as well.
      // It may answer that what's left already fits them only when what's left carries their own words.
      const share = shareTurn ? await runShare({ cut, failed: effectiveFailed1, offerKeep: !!cut.trim() && echoesThem(cut, src.message) }) : null;
      if (share?.final) kept = { text: share.final, checks: share.checks };
      const t0 = Date.now();
      if (!share) try {
        // The same redraft path: the dead-air note (and its {checkin, reply} answer) when that's the reason, the thread note when a
        // thread report was cut, both when both.
        const night = !!rf.world && lateNight(rf.world.clock);
        const note = [silent ? (night ? WORLD_REDRAFT_NOTE_AT_NIGHT : WORLD_REDRAFT_NOTE) : null, threadCut ? THREAD_REDRAFT_NOTE : null, lostSupported ? NARRATION_REDRAFT_NOTE : null].filter(Boolean).join("\n");
        const raw = await redraft(draft, effectiveFailed1, rf, src, null, note || null, silent);
        // On dead air the redraft says whether their message was a check-in (Co decides); a reply that isn't that shape isn't used.
        const parsed = silent ? parseWorldRedraft(raw) : null;
        if (parsed) checkin = parsed.checkin;
        const rewrite = silent ? parsed?.reply || null : raw;
        stages.redraftMs = Date.now() - t0;
        const cleaned = rewrite ? cleanCoMessage(rewrite) : null;
        // Their own words from memories may come into the rewrite (never
        // Co-written memories); the recheck still holds each detail to its source.
        const allowed = [...rf.facts.filter((f) => f.kind !== "hint").map((f) => f.text), theirOwnWords(src.recentMemories)].join("\n");
        const guard = cleaned ? rewriteAddsNothing(draft, cleaned, allowed) : { ok: false, why: "no rewrite" };
        if (cleaned && guard.ok) {
          const t1 = Date.now();
          const r = await recheck(draft, cleaned, effectiveFailed1, rf, src);
          stages.secondCheckMs = Date.now() - t1;
          const failed2 = claimReadUnavailable(cleaned, r) ? [...r.checks.filter((c) => !c.pass), CLAIM_READ_FAILED_CHECK] : r.checks.filter((c) => !c.pass);
          if (!failed2.length) kept = { text: cleaned, checks: r.checks };
        } else if (cleaned) {
          console.error(`replyGrounding: rewrite rejected (${guard.why}), cutting instead`);
        }
      } catch (err: any) {
        console.error("replyGrounding: redraft failed (non-fatal, cutting instead):", err?.message ?? err);
      }
      if (kept && share) {
        result = { final: kept.text, outcome: share.how === "kept" ? "cut" : "redrafted", checks: [...first.checks, ...shareChecks(share, "the cut left too little")], latencyMs: Date.now() - started, firstCheckMs, stages };
      } else if (kept) {
        result = { final: kept.text, outcome: "redrafted", checks: [...first.checks, ...kept.checks.map((c) => ({ ...c, name: `redraft.${c.name}` }))], latencyMs: Date.now() - started, firstCheckMs, stages };
      } else {
        // 3. The cut, or the minimal honest line. The invite line only helps
        // when an invite claim was what came out (2026-09-20 code review).
        const enough = cut.split(/\s+/).filter(Boolean).length >= 3 && !(danglingQuestion(cut) && !danglingQuestion(draft));
        // Something already went out this turn (finds, a link): what's left of
        // the closing line is dropped rather than replaced with "I don't have
        // an answer", which contradicted the finds just sent (2026-10-01
        // next-live run: a find went out, then "Nothing confirmed on that yet").
        const after = afterStrip({ enough, inviteCut, sentThisTurn: src.answeredThisTurn ?? src.sentThisTurn ?? [], findsWaiting: src.findsWaiting });
        // Co says it in its own words, claiming nothing (2026-09-28: the one
        // fixed line read as a script); the fixed line is the fallback.
        // A sharing or feedback turn cut to almost nothing (prompt sweep 2026-10-29: no fixed warm line; "Glad you told me." was the stock
        // formula the stock filter exists to stop). Something that already answered them this turn ends it ("nothing", above). Otherwise
        // what's left of the cut, when it carries something: never a question that only pointed at what was cut, never a single word. When
        // nothing carries, the honest line in Cue's own words, the least bad of what's left: it claims nothing and is never a stock phrase.
        const cutCarries = !!cut.trim() && !danglingQuestion(cut) && wordCount(cut) > 1;
        const shareEnd = !!share && after === "honest" && cutCarries ? cut.trim() : null;
        // Nothing carried and nothing has answered them yet: once a turn, an empty result, so the send tool's own contract has Cue say it
        // again plainly with the whole turn in view, checked again (Royce, 2026-10-17: a redraft, never the fallback line). A second fully
        // cut pass in the same turn falls to the honest line below, so it never loops.
        const shareRetry = !!share && after === "honest" && !shareEnd && !rf.shareRetried;
        if (shareRetry) rf.shareRetried = true;
        const honestRaw = after === "honest" && !shareEnd && !shareRetry ? await honestNoAnswer(src.message, rf.facts.find((f) => f.kind === "scheduled" && AHEAD_LINE.test(f.text))?.text ?? null).catch(() => null) : null;
        const honest = honestRaw && (!share || !textStockSentence(honestRaw)) ? honestRaw : null;
        const final = after === "invite" ? [enough && !/invite/i.test(cut) ? cut : "", INVITE_FALLBACK].filter(Boolean).join(" ") : after === "cut" ? cut : after === "nothing" || shareRetry ? "" : shareEnd ?? honest ?? MINIMAL_FALLBACK;
        // A cut "still working on it" ends on the honest line instead (item 3), never on a bare "not sure".
        const workCut = after !== "nothing" && nothingRunningLineApplies({ draft, cut, failed: effectiveFailed1, rf });
        // Dead air with a true line in their world: what's left, then that line, never "not sure" or nothing.
        // Code acts only on Co's own answer: the lead when the redraft said check-in; otherwise at most what the cut sentence named.
        const world = silent && after === "cut" ? deadAirLine({ checkin, world: rf.world, draft, cut }) : null;
        // Dead air late at night their time, and the care redraft wasn't kept (it threw, came back out of shape, or failed its checks): the
        // fixed care line, never the presence-only cut (third review of #310: "Good to hear from you." alone at 12:04am is the 2026-10-14
        // incident line). No line from their world at that hour (deadAirLine).
        // Only for a check-in or casual opener (focused review of #310: "my dad's in the hospital" and "ok thanks, night" got it): the redraft
        // said check-in, or its read never came back and the turn's moment is small talk. Never when it said not a check-in, never on a sharing
        // or feedback moment, never on the invite path: the cut goes there.
        const checkinTurn = checkin === true || (checkin === null && rf.moment === "small_talk");
        const nightCare = silent && after !== "invite" && checkinTurn && !!rf.world && lateNight(rf.world.clock) ? NIGHT_CARE_LINE : null;
        const out = nightCare ?? (world ? [cut.trim(), world].filter(Boolean).join(" ") : workCut ? await withNothingRunningLine(after === "cut" ? cut : "", effectiveFailed1, rf) : final);
        result = { final: out, outcome: "stripped", notSure: !world && !workCut && after === "honest" && !shareEnd && !nightCare && !shareRetry, checks: nightCare ? [...first.checks, { name: "night_care", pass: true, reason: "dead air late at night, the care redraft wasn't kept: the fixed care line" }] : world ? [...first.checks, { name: "world_line", pass: true, reason: `dead air after the cut (check-in: ${checkin === null ? "unread" : checkin}); said from their world: "${world}"` }] : share ? [...first.checks, ...shareChecks(share, "the cut left too little")] : first.checks, latencyMs: Date.now() - started, firstCheckMs, stages };
      }
    }
  }

  // A turn where a privacy or consent block tripped (the gate says so in its
  // instruction): whatever Co wrote must be discreet, or an approved line goes
  // out instead. Never an apology for nothing, a false start, a fragment or the
  // machinery's words (harness/discretion.ts).
  if (isDiscreetTurn(rf.instructions)) {
    // The first reply must be an approved line (links or a card sent earlier in the turn don't
    // count as a reply); a later reply on the same turn only has to be free of the rest.
    const d = discreetFinal(result.final, src.message, rf.privateNames ?? [], !rf.discretionDone, isNeutralTurn(rf.instructions));
    if (d.final.trim()) rf.discretionDone = true;
    if (d.replaced) {
      result = {
        ...result,
        final: d.final,
        outcome: "stripped",
        notSure: false,
        checks: [...result.checks, { name: "discretion", pass: false, reason: `the reply to a privacy block ${d.problems.join("; ")}; an approved line was used` }],
      };
    }
  }

  // The promise that opened a task has to be in the text that actually goes out
  // (cut, redrafted, or swapped for a discreet line means it was never made).
  if (promiseTaskId !== null && opts.userId && !promiseStays(result.final)) {
    await dropPromise(opts.userId, promiseTaskId);
    recordDecision({ layer: 3, decision: "promise.dropped", userId: opts.userId, outcome: "skip", action: `task:${promiseTaskId}`, reason: "the promise was not in the final text" }).catch(() => {});
  }

  // An entry the binding pulled earlier for a sentence that was then cut goes back to when it was (review item 11).
  for (const p of binding.pulled) {
    if (opts.userId && !norm(result.final).includes(norm(p.sentence).replace(/[.!?]+$/, ""))) {
      const T = await import("../services/coTasks.js");
      await T.scheduleTaskAt(opts.userId, p.id, new Date(p.previous), p.plan ?? "").catch(() => null);
    }
  }
  // A promise task the binding opened has to be in the text that goes out too.
  for (const o of binding.opened) {
    if (opts.userId && !norm(result.final).includes(norm(o.sentence).replace(/[.!?]+$/, ""))) {
      await dropPromise(opts.userId, o.id);
      recordDecision({ layer: 3, decision: "promise.dropped", userId: opts.userId, outcome: "skip", action: `task:${o.id}`, reason: "the bound promise was not in the final text" }).catch(() => {});
    }
  }

  // Promises and "I can"s held back, as their own typed row (services/guardDrops.ts): counted, no text.
  const overpromised = result.outcome !== "as_drafted" ? result.checks.filter((c) => !c.pass && /^claim_(future_promise|capability)$/.test(c.name)) : [];
  if (opts.record !== false && overpromised.length) {
    const { recordGuardDrop } = await import("../services/guardDrops.js");
    recordGuardDrop({ guard: "overpromise", where: "reply.grounding", userId: opts.userId ?? null, count: overpromised.length, reason: `${result.outcome}: ${[...new Set(overpromised.map((c) => c.name.replace(/^claim_/, "")))].join(", ")}` });
  }
  // The thread reads this reply made (judgeThreadReports), logged on their own.
  if (opts.record !== false && rf.thread?.reads.length) {
    const reads = rf.thread.reads.splice(0);
    recordDecision({ layer: 3, decision: "reply.thread_read", userId: opts.userId ?? null, outcome: reads.some((r) => r.reports?.length) ? "act" : "skip", action: reads.some((r) => r.reports === null) ? "read_failed" : "read", proposal: { reads } }).catch(() => {});
  }
  if (opts.record !== false) {
    await recordDecision({
      layer: 3,
      decision: "reply.grounding",
      userId: opts.userId ?? null,
      outcome: "act",
      action: result.outcome,
      // alreadyAnswered: something that answered them had gone out this turn, so an empty final is the deliberate end (nothing more
      // to add), not a member left without an answer (harness/failureCount.ts; Royce, 2026-10-17).
      proposal: { draft, final: result.final, notSure: result.notSure === true, alreadyAnswered: (src.answeredThisTurn ?? src.sentThisTurn ?? []).some((m) => m.trim().length > 0) },
      checks: result.checks,
      confidence: result.outcome === "unchecked" ? "low" : null,
      reason: result.checks.filter((c) => !c.pass).map((c) => c.reason ?? c.name).join("; ") || null,
    });
  }
  return result;
}
