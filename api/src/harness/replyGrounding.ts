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
import type { MemberKnowledge, MemberRules, Restraint } from "../services/memberKnowledge.js";
import { dateSpan, KINDS, renderLive, type Kind } from "../services/factLabels.js";
import { arcLine, LENS_RULE } from "../services/goalJourney.js";
import { isNewMember, steerDecision, steerInstruction, type ColdStartView, type SeedCount } from "../services/coldStart.js";
import { doorDecision, doorInstruction, doorOpen, type DoorView } from "../services/theDoor.js";
import { docOfferLines, type OfferKind } from "../services/documentOffer.js";
import { findSection } from "../services/deliveryReceipts.js";
import { driftLine } from "../services/receiptDrift.js";
import type { Doc } from "../services/documentSheet.js";
import type { EmotionalContext } from "./emotion.js";
import { attributedWithoutSource } from "./proactiveSpecifics.js";
import { loadMilestones, storyLines } from "../services/milestones.js";
import { ABILITIES, capabilitySheet } from "../services/capabilities.js";
import { kitLines } from "../services/memberKit.js";
import { situationFor, type Situation } from "../services/capabilities.js";
import { carryingBlock, sentDetailHints, sentDetailLines, type TurnContext } from "../services/turnContext.js";
import { switchedOff } from "../services/abilitySwitches.js";
import { textingStyleFor } from "../services/textingStyle.js";
import { tasteSummary } from "../services/outcomes.js";
import { TEAM_BUILDER_LINE, handoffFor, isTeamMember, teamSheet } from "../services/extensions.js";
import { ledgerFacts } from "../services/coFacts.js";
import { DEFAULT_ZONE, dateNote, itemDays, localToday, readDates, type Days } from "../services/dateGuard.js";
import { memberZone, validZone, wordsZone } from "../services/memberTime.js";
import { sourceOf } from "../services/messageFormat.js";
import { getPersonSnapshot, renderSnapshot } from "./personSnapshot.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { isInviteRequest } from "../services/invites.js";
import { cleanCoMessage } from "../services/sendblue.js";
import { CO_TEXT_CHANNEL, CO_VOICE } from "../services/coVoice.js";
import { recordDecision, type GateCheck } from "./core.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { checkNoEmotionLabel } from "./emotion.js";
import { narratesInternalState } from "../services/speakable.js";
import { arrivalDenial, recordSaysNothingReadable } from "../services/inboundFile.js";
import { enrichMatch, fetchLumaEventDetails, isLumaLink, missingEventDetails, renderEventDetails, type EventDetails, type OpportunityDetails } from "../services/eventDetails.js";
import { citesStaleAsCurrent, liveDetailFacts, renderDetailsAsOf, staleCurrentClaims } from "../services/asOf.js";
import { recentCallCorrections } from "./callGrounding.js";
import { repeatQuestionCheck, sameQuestion } from "./repeatAsk.js";
import { asksForLink, findLines, linkRequestInstruction, recentResearchFinds, relevantFinds } from "../services/researchFinds.js";
import { DISCRETION_GUIDE, apologyOnly, discreetFinal, isDiscreetTurn, isNeutralTurn } from "./discretion.js";
import { PROMISE_RE, STARTED_WORK, dropPromise, promiseFact, promiseSentence, promiseStays, trackPromise } from "../services/promises.js";

// Model policy (Royce, 2026-09-14): Sonnet 5 for anything with judgment or
// side effects; Haiku only for narrow, code-checked reads.
// Any other event page, read live for "still spots?" (Royce, 2026-10-11): through safeFetch (every hop checked), its schema.org Event
// data only, no model, so the reply waits seconds at most. Null when it can't be read.
async function livePageFacts(url: string): Promise<import("../services/asOf.js").LivePage> {
  const { safeFetch, structuredEvent, humanTime } = await import("../services/linkReader.js");
  const r = await safeFetch(url);
  if ("error" in r || r.status >= 400 || !/html/i.test(r.contentType)) return null;
  const f = structuredEvent(r.body);
  if (!f) return null;
  return { start: f.start ? humanTime(f.start.value, null) : undefined, cost: f.cost?.value, soldOut: f.sold_out?.value === "yes" };
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

export type Fact = { id: string; kind: FactKind; text: string };

// privateNames: the other member(s) a blocked turn is about, so a reply can't name them
// (harness/discretion.ts).
// artifactOffer: the one offer (a plan sheet, a venue brief, a stale document's fix) this reply was told it may make; recorded only
// if a text Co sends makes it (services/documentOffer.ts).
// goalSetAside: a goal Co set aside from context that they haven't heard about yet (services/goalEdges.ts); the reply may raise it.
// coldStart: set for a member with fewer than two findable interests on file (services/coldStart.ts): whether this reply was offered
// a steering question, and why or why not; recorded after the reply goes out (agent/conversationReply.ts).
// door: a new member's first read (services/theDoor.ts): whether this reply was offered the moment, and why or why not.
export type ReplyFacts = { facts: Fact[]; instructions: string[]; privateNames?: string[]; discretionDone?: boolean; artifactOffer?: { kind: OfferKind; topic: string } | null; goalSetAside?: GoalStateRow | null; coldStart?: ColdStartFacts | null; door?: DoorFacts | null };
export type ColdStartFacts = { offered: boolean; why: string; seeds: SeedCount; instruction: string | null };
export type DoorFacts = { offered: boolean; why: string; instruction: string | null };

// Pure: the first-read moment on this reply's facts (services/theDoor.ts doorDecision), with its instruction when it's on offer.
// Nothing at all once the door has closed for them (given, or no longer new).
export function addDoorMoment(rf: ReplyFacts, view: DoorView, o: { firstName?: string | null; emotional: EmotionalContext | null | undefined; otherQuestion?: string | null; now?: Date }): DoorFacts | null {
  const d = doorDecision({ view, now: o.now, heavy: heavyMoment(o.emotional), frustrated: !!o.emotional?.withCo?.frustrated, otherQuestion: o.otherQuestion ?? null });
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
  const d = steerDecision({ seeds: cs.seeds, heavy: heavyMoment(o.emotional), frustrated: !!o.emotional?.withCo?.frustrated, history: cs.history, lifetimeSteers: cs.lifetimeSteers, now: o.now ?? new Date(), otherQuestion: o.otherQuestion ?? null });
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
  rf.facts.push({ id: `F${rf.facts.length + 1}`, kind, text: t });
}

// A model-written read for drafting, never a source (FactKind "hint").
export function addHint(rf: ReplyFacts, text: string): void {
  addFact(rf, "hint", text);
}

export function addInstruction(rf: ReplyFacts, text: string): void {
  const t = text.trim();
  if (t && !rf.instructions.includes(t)) rf.instructions.push(t);
}

// What Co can do and the lines it doesn't cross: one registry
// (services/capabilities.ts), shared with the tools themselves.

// Facts that are true for every reply, before anything about this person.
export function baseReplyFacts(situation?: Situation): ReplyFacts {
  const rf = createReplyFacts();
  for (const c of capabilitySheet({ situation })) addFact(rf, "capability", c);
  // How Co keeps a confidence, so the model chooses a discreet line itself when
  // asked to speak for another member (harness/discretion.ts).
  addInstruction(rf, DISCRETION_GUIDE);
  return rf;
}

// Gathers the facts that don't depend on what happened earlier in this turn.
// Branch-specific facts (a link just sent, a call that failed) are added by
// routes/sendblue.ts as it acts.
// They're asking for a deck, slides or a presentation: a request word before the noun, so "my presentation went badly" or "she
// slides into DMs" isn't an ask.
export const DECK_ASK = /\b(make|build|put together|throw together|draft|design|create|need (a|some|new)|need(?= (slides|decks?|pitch deck)\b)|want (a|some)|would love (a|some)|would like (a|some)|can you|could you|help me with)\b[^.?!\n]{0,40}\b(pitch deck|deck|slides|presentation|slideshow)\b/i;
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
  opts: { pendingDescriptions?: string[]; context?: string; turn?: TurnContext } = {},
): Promise<ReplyFacts> {
  const t = opts.turn;
  const rf = baseReplyFacts(t ? situationFor({ kitFields: Object.keys(t.kit ?? {}).length, message: t.message ?? "", openTasks: t.tasks?.length ?? 0, eventToday: !!t.todayEvent, doorOpen: t.door ? doorOpen(t.door).open : false }) : undefined);
  for (const d of opts.pendingDescriptions ?? []) addFact(rf, "pending", `Waiting to hear back: ${d}`);
  // What Co knows about them from the one member-knowledge layer, with the member-level rules (addMemberKnowledge): their taste
  // (what's landed with them), what they corrected, restraint, quiet hours, delivery shape. Without the layer (no turn), taste is read
  // on its own as before.
  if (t?.knowledge !== undefined || t?.rules !== undefined) addMemberKnowledge(rf, t?.knowledge, t?.rules);
  else {
    const taste = await tasteSummary(userId).catch(() => null);
    if (taste) addFact(rf, "known", taste);
  }
  // "Do research on X" (Royce, 2026-10-11: Co offered a positioning line "from" Jeremy Toce without ever searching): search first,
  // and say nothing about X until it's back; nothing found is said plainly, with no lines built on it.
  // Only the member's own message: the rest of the context carries Co's lines too ("want me to look into it?"), so without a turn
  // it's the context's first line, which is their message.
  const theirMessage = String(opts.turn?.message ?? (opts.context ?? "").split("\n")[0]);
  if (RESEARCH_ASK.test(theirMessage)) addInstruction(rf, RESEARCH_RULE);
  // One question at most before a deck (Royce, 2026-10-11): once Co asked its one question about a deck they want, and no deck has
  // gone since, this reply builds it (replay: Co asked a second "what's the pitch about?" instead).
  const deckAsked = await import("../db/db.js")
    .then(({ default: pool }) =>
      pool.query(
        `SELECT 1 FROM co_memories m WHERE m.user_id = $1 AND m.memory_type = 'design_taste_asked' AND m.created_at > NOW() - INTERVAL '6 hours'
           AND NOT EXISTS (SELECT 1 FROM co_pages p WHERE p.owner_user_id = $1 AND COALESCE(p.data->>'kind', 'page') = 'deck' AND p.created_at > m.created_at)
         LIMIT 1`,
        [userId],
      ),
    )
    .then((r) => r.rows.length > 0)
    .catch(() => false);
  // The confirm-the-read line (services/designSystem.ts): Co read the look of an image of theirs and asked them to confirm it. Their
  // answer settles it, and the deck is built from it now.
  const readAsked = deckAsked
    ? await import("../services/designSystem.js").then((m) => m.loadDesignSystem(userId, "professional")).then((ds) => ds.pending.filter((p) => p.askedAt)).catch(() => [])
    : [];
  if (readAsked.length) {
    const { confirmLine, foldSignals } = await import("../services/designSystem.js");
    const line = confirmLine(foldSignals(readAsked.map((p) => ({ ...p, confirmed: true })), readAsked[0].context).tokens);
    addInstruction(rf, `You checked the look you read from their image with them ("${line}"). This message answers it: build the deck now with makeDeck, readConfirmed true if they agreed (false if they didn't, with taste for what they want), and a brief from everything they told you about the deck. No more questions first; anything you asked about the content that they didn't answer, write the deck without.`);
  } else if (deckAsked) addInstruction(rf, "You already asked your one question about the deck they want. If this message answers it or still wants the deck, build it now with makeDeck from what you have (pass a brief if you don't have slides): no more questions first. If they haven't said anything about the look, it's clean and minimal.");
  // They're asking for a deck and Co hasn't asked its one question yet: the deck tool decides whether a question is needed and asks
  // it, so Co doesn't stack its own first (replay: "what's it for?", then "what's it about?", then the look).
  else if (DECK_ASK.test(theirMessage)) addInstruction(rf, "If they're asking you to make a deck (not just talking about one), call makeDeck in this turn with what you have (pass a brief if you don't have slides); don't ask them anything yourself first. If something is missing, makeDeck asks the one question, covering the look and the content together.");
  // How they've told Co they like to be texted (services/textingStyle.ts).
  const style = await textingStyleFor(userId).catch(() => [] as string[]);
  if (style.length) addInstruction(rf, `How they've told you they like to be texted, follow it: ${style.join("; ")}.`);
  // The pages and decks Co made them that are still live (services/coPages/store.ts), so "reset my link" or "keep it" works on a
  // turn where the deck isn't in the recent texts (live run, 2026-10-11: Co said it had no deck on file while one was live).
  // Titles only, never links (a link goes out only through the tools).
  const live = await import("../services/coPages/store.js").then((m) => m.livePagesFor(userId)).catch(() => [] as { title: string; kind: string }[]);
  if (live.length) addFact(rf, "known", `Pages and decks you made them that are still live: ${live.slice(0, 8).map((p) => `the ${p.kind} "${p.title}"`).join("; ")}. When they ask to change one ("tighten the traction slide", "move dinner to 8"), open it (openArtifact) and change it from what's there; never ask them to paste or resend it.`);
  // A member an extension brought in (Mo's invitations): what it knew, to
  // ask about rather than state (services/extensions.ts, mo/handoff.ts).
  const handoff = await handoffFor(userId).catch(() => ({ known: [] as string[], instructions: [] as string[] }));
  for (const k of handoff.known) addFact(rf, "known", k);
  for (const line of handoff.instructions) addInstruction(rf, line);
  // The team only: Co's teammates and the team-only abilities, so Co never
  // pitches Mo's work back as a new idea (services/extensions.ts teamSheet).
  // Everyone else gets nothing about them.
  if (await isTeamMember(userId).catch(() => false)) {
    addInstruction(rf, TEAM_BUILDER_LINE);
    for (const line of teamSheet()) addFact(rf, "capability", line);
    // 2026-09-29: with earlier replies in the thread naming Mo beside a cofounder,
    // Co kept doing it (2 to 3 of 3 replays) until it was told plainly, per replay.
    addInstruction(rf, "Mo is software that Co runs, not a person. When they talk about their cofounder, equity, family, friends or their own life, never mention Mo, whatever an earlier reply in this conversation said.");
    for (const a of ABILITIES.filter((x) => x.teamOnly)) addFact(rf, "capability", a.can);
  }
  // Abilities switched off right now (services/abilitySwitches.ts).
  for (const id of (await switchedOff().catch(() => new Map<string, string>())).keys()) {
    addFact(rf, "capability", `Co's ${id.replace(/_/g, " ")} ability is switched off right now. If it comes up, say it isn't available at the moment.`);
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
  const [corrections, snapshot, sent, notes, scheduled, reveal, preference, callFailure, sendHeld] = await Promise.all([
    recentCallCorrections(userId),
    opts.turn ? Promise.resolve(opts.turn.snapshot) : getPersonSnapshot(userId).catch(() => null),
    recentlySent(userId),
    recentSearchNotes(userId, zone),
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
  if (preference === "text") addFact(rf, "known", "They told Co they'd rather text. Only bring up a call if they ask for one.");
  if (preference === "call") addFact(rf, "known", "They told Co they like talking on the phone. Offering a call when there's a lot to talk through is welcome.");
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
  await addOngoingSearchFacts(rf, userId, opts.turn?.asks);
  for (const correction of corrections) addFact(rf, "known", correction);
  // What Co knows about them, so "what do you know about me?" can be
  // answered from it (2026-09-15: the claim check had no copy of the person
  // summary and cut "designer by Friday" and "Series A" as unsupported).
  // A model-written summary of them: drafted from, never a source (2026-09-28).
  for (const line of renderSnapshot(snapshot).split("\n").filter(Boolean)) addHint(rf, `Co's summary of what they've told it: ${line}`);
  // What Co already sent them, and what its searches turned up, so "which
  // one?" and "are you actually searching?" are answerable (2026-09-16).
  for (const line of sent) addFact(rf, "did_before", line);
  for (const note of notes) addFact(rf, "did_before", note);
  // What Co's recent follow-ups were about, with the original send
  // (proactiveRegistry.ts debrief onSent). 2026-09-26: asked "you never sent
  // that", Co couldn't see a five-day-old send and agreed.
  const { rows: followups } = await pool
    .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'followup_context' AND created_at > NOW() - INTERVAL '4 days' ORDER BY created_at DESC LIMIT 3`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  for (const r of followups) addFact(rf, "did_before", String(r.content));
  // Co's own record of what it sent and did for them (services/coFacts.ts):
  // the last two weeks of sends, and anything older their message names.
  const ledger = opts.turn?.ledger ?? (await ledgerFacts(userId, opts.context ?? "").catch(() => ({ lines: [] as string[], named: [] as string[] })));
  // What's on file for what Co recently sent: times and places, and what isn't
  // (services/turnContext.ts), before Co ever says it doesn't have them.
  if (opts.turn) for (const line of sentDetailLines(opts.turn)) addFact(rf, "known", line);
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
  const story = opts.turn?.story ?? (opts.turn ? [] : await loadMilestones(userId).then((m) => storyLines(m, 4)).catch(() => [] as string[]));
  for (const line of story) addFact(rf, "known", line);
  // What Co told them lately, so it doesn't contradict itself and can ask how it went.
  for (const line of opts.turn?.advice ?? []) addFact(rf, "did_before", line);
  // On the way to a Co event today (services/preArrival.ts).
  const today = opts.turn ? opts.turn.todayEvent ?? null : await import("../services/eventPresence.js").then((e) => e.todayEventFor(userId)).catch(() => null);
  if (today) {
    addFact(rf, "known", `They're registered for Co's event "${today.name}" today, starting ${today.startAt}.`);
    addInstruction(rf, `If they say they're running late, can't make it, or aren't sure about "${today.name}", answer them normally and warmly, record it with updateGoing, never pressure them to come, and never offer to contact the host.`);
  }
  // Writing something up as a document (services/documentOffer.ts): an offer still waiting on its answer, or a moment Co may offer, once.
  // The same notice covers a plan sheet, a venue brief and a stale delivered document, at most one offer a reply, never in a heavy
  // moment (this message's feeling, recorded before the reply drafts).
  let docQuestion: string | null = null;
  {
    if (opts.turn?.docOffer) opts.turn.docOffer.moment = { heavyNow: heavyMoment(opts.turn.emotional), coLines: coLinesIn(opts.context) };
    const doc = docOfferLines(opts.turn?.docOffer, opts.turn?.message ?? "");
    if (doc.ask || doc.hint) docQuestion = "a document offer";
    if (doc.ask) addInstruction(rf, doc.ask);
    if (doc.pending) addFact(rf, "pending", doc.pending);
    if (doc.hint) addInstruction(rf, doc.hint);
    // Recorded once Co's text actually makes it (agent/conversationReply.ts), so it's never offered twice.
    if (doc.offer) rf.artifactOffer = doc.offer;
  }
  // A delivered document that no longer matches what's true (services/receiptDrift.ts): a fact, whether or not Co raises it.
  for (const d of opts.turn?.drift ?? []) addFact(rf, "known", driftLine(d));
  // One ordered view of everything Co is carrying for them (memberKnowledge.ts carryingOf, labelled by turnContext.ts carryFromKnowledge), and, when this message shares
  // words with a section of a document Co just delivered, a pointer to read it first. Both guidance, never a gate.
  {
    const carrying = carryingBlock(opts.turn?.carrying);
    if (carrying) addInstruction(rf, carrying);
    const docHint = docQuestionHint(opts.turn?.message ?? "", opts.turn?.recentDocs ?? []);
    if (docHint) addHint(rf, docHint);
  }
  // Co's own open tasks: real scheduled work, so saying when it'll get back to them is true.
  for (const line of opts.turn?.tasks ?? []) addFact(rf, "scheduled", line);
  // Their research briefs (services/coTasks.ts briefFactLines): one still running or held for their hours is scheduled; one that
  // finished or stopped is Co's record of what it did.
  for (const line of opts.turn?.briefs ?? []) addFact(rf, /^Co is putting together|hasn't reached them yet/.test(line) ? "scheduled" : "did_before", line);
  // Documents Co delivered (services/deliveryReceipts.ts): "Documents you've delivered", by doc number, what's outstanding first.
  // A PDF still to follow a text fallback is scheduled; everything else is what Co did. readDocument quotes from them.
  for (const line of opts.turn?.deliveries ?? []) addFact(rf, /^Outstanding:/.test(line) ? "scheduled" : "did_before", `Documents you've delivered: ${line}`);
  if (opts.turn) for (const hint of sentDetailHints(opts.turn)) addHint(rf, hint);
  // A goal Co set aside from context (its date passed, or newer words replaced it) is told, never silent (Royce, 2026-10-08): the
  // oldest one, as a hint the reply may take when it fits. Never in a hard moment, never as a list or an announcement.
  const aside = opts.turn?.goalSetAsides?.[0];
  if (aside) {
    rf.goalSetAside = aside;
    addHint(rf, `Co stopped looking for things for their goal "${aside.goal.slice(0, 140)}" (${aside.reason}). If it fits naturally in this reply and they aren't in a hard moment, ask in your own words whether they still want things for it; if they say yes, markGoal active, if it's over, markGoal done. Never as a list or an announcement.`);
  }
  // Cold start (services/coldStart.ts): fewer than two findable interests on file, so a reply may ask one easy question that lets them
  // name something Co could find. New members and existing ones alike, only in a natural exchange, never as outreach.
  if (opts.turn?.coldStart) addColdStartSteer(rf, opts.turn.coldStart, { emotional: opts.turn.emotional, otherQuestion: aside ? "a set-aside goal to ask about" : docQuestion });
  // Where they live, when nothing on file says (2026-10-12, the door rerun: "moved here" plus the club being in San Francisco
  // became "around SF" in a reply and "in SF" in a task). The drafter and the claim read both see it as unknown, never assumed.
  {
    const cityLine = unknownCityFact({ city: opts.turn?.knowledge?.identity.city ?? opts.turn?.profile?.city ?? null, joinedAt: opts.turn?.door?.joinedAt ?? null });
    if (opts.turn && cityLine) addFact(rf, "unknown", cityLine);
  }
  // The door (services/theDoor.ts): a new member's first read, once, when Co has heard enough to say it back.
  if (opts.turn?.door) addDoorMoment(rf, opts.turn.door, { firstName: opts.turn.knowledge?.identity.firstName ?? null, emotional: opts.turn.emotional, otherQuestion: aside ? "a set-aside goal to ask about" : docQuestion });
  for (const line of ledger.lines) addFact(rf, "did_before", line);
  // They're asking about something the record shows Co sent: the record
  // answers, whatever earlier messages said (2026-09-27: after two earlier
  // wrong denials in the thread, Co said "Still no, same as I said before").
  if (ledger.named.length) {
    addInstruction(rf, `What they're asking about is in Co's record as sent: ${ledger.named.join(" ")} Answer from that record. If an earlier message in this conversation said otherwise, say plainly that it was wrong.`);
  }

  if (!scheduled.rows.length) addFact(rf, "scheduled", "No calls are scheduled with them.");
  for (const row of scheduled.rows) {
    const local = DateTime.fromJSDate(new Date(row.scheduled_for)).setZone(row.timezone);
    addFact(rf, "scheduled", `A call is scheduled for ${local.toFormat("cccc, LLLL d 'at' h:mm a")} (${row.timezone}).`);
  }

  if (reveal.rows[0]) {
    try {
      const { match } = JSON.parse(reveal.rows[0].content) as { match: any };
      // Offers stored before details existed get them on demand.
      addEventFacts(rf, await enrichMatch(match), null, zone);
    } catch {
      // Malformed or pre-fix content shape; nothing reliable to add.
    }
  }
  return rf;
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
  for (const p of k.preferences) if (p.text.trim()) addFact(rf, "known", p.text);
  const corrections = k.corrections.filter((c) => c.field.trim() && (c.was.trim() || c.now?.trim()));
  if (corrections.length) {
    addFact(rf, "known", `What they corrected (only the new version is true; never bring back the old one): ${corrections.slice(0, 6).map((c) => `${c.field.replace(/_/g, " ")} was "${c.was.slice(0, 80)}", now ${c.now ? `"${c.now.slice(0, 80)}"` : "removed"}`).join("; ")}.`);
  }
}

// Pure: whether any restraint is on for them right now (otherwise its rule is only "nothing is on", and left out).
export function restraintOn(r: Restraint | null): boolean {
  return !!r && (r.safetyHold || !!r.holdUntil || !!r.spaceUntil || r.unanswered.count > 0 || r.suppressedKinds.length > 0 || r.needsCare || r.frustratedWithCo);
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

// Pure: a heavy moment in this message: they're struggling, or a strong hard feeling right now. No offers then (documentOffer.ts).
export function heavyMoment(e: EmotionalContext | null | undefined): boolean {
  if (!e) return false;
  return !!e.needsCare || (!!e.current && e.current.intensity === "high" && e.current.valence === "negative");
}
// Pure: Co's recent lines from the reply's context (their message, then Co's last few "Co replied:" lines).
export function coLinesIn(context: string | undefined): string[] {
  return String(context ?? "").split("\n").filter((l) => l.startsWith("Co replied:")).map((l) => l.replace(/^Co replied:\s*/, "").trim()).filter(Boolean);
}

// Pure: when their message shares words with a section of one of the last three documents Co delivered, a pointer to read it first
// (2026-10-08 review B6). A hint only: Co decides whether the message is about it.
const DOC_HINT_STOP = new Set("the and for with what about this that your you can does how why part section bit doc document plan pdf just like into from have has was were are is it's its there their they them when where which who will would could should also than then thanks thank okay ok yes yeah sure got".split(" "));
const hintWords = (t: string) => (t.toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9][a-z0-9']*/g) ?? []).filter((w) => w.length > 2 && !DOC_HINT_STOP.has(w));
export function docQuestionHint(message: string, docs: { id: number; title: string; doc: Doc }[]): string | null {
  const q = new Set(hintWords(message));
  if (!q.size) return null;
  let best: { id: number; heading: string; score: number } | null = null;
  for (const d of docs.slice(0, 3)) {
    const sec = findSection(d.doc, message);
    if (!sec) continue;
    const head = new Set(hintWords(sec.heading).filter((w) => q.has(w))).size;
    const body = new Set(hintWords(sec.text).filter((w) => q.has(w))).size;
    const score = head * 3 + body;
    if ((head >= 1 || body >= 2) && (!best || score > best.score)) best = { id: d.id, heading: sec.heading, score };
  }
  return best ? `This may be about doc #${best.id} (${best.heading} section): readDocument before answering.` : null;
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

async function recentSearchNotes(userId: string, zone: string | null): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'system' AND content LIKE '[search]%' AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 5`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  // Dated, so an earlier search is never taken as the answer to a new ask.
  return rows.map((r: any) => searchNoteLine(String(r.content), new Date(r.created_at), localToday(zone), zone));
}

export function searchNoteLine(content: string, at: Date, today: string, zone: string | null = DEFAULT_ZONE): string {
  const d = localToday(zone, at);
  return `${d === today ? "Earlier today" : `On ${DateTime.fromISO(d).toFormat("cccc, LLLL d")}`}, ${content.replace("[search] ", "")}${d === today ? "" : " That was an earlier search: a new ask needs a new one."}`;
}

// What Co has actually sent them lately, from every path (answers to their
// texts, the daily pick's offers, late results): each link with the message
// that went out right after it, in Co's own words, so its day and time are
// there too. Was the last 3 search results from 3 days, which dropped a
// Sunday event sent two days earlier; the claim check then called Co's true
// "Still that one at The Love Potion Library, 3-6pm" unsupported and sent
// "nothing on my end about it" instead (2026-09-18).
export const SENT_LOOKBACK_DAYS = 7;
const SENT_MAX = 10;

export function pairSentLinks(messages: { at: Date; text: string }[]): { at: Date; url: string; caption: string | null }[] {
  const sorted = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  const out: { at: Date; url: string; caption: string | null }[] = [];
  sorted.forEach((m, i) => {
    const url = m.text.trim();
    if (!/^https?:\/\/\S+$/.test(url)) return;
    const next = sorted[i + 1];
    const caption = next && !/^https?:\/\//.test(next.text.trim()) && next.at.getTime() - m.at.getTime() < 2 * 60 * 1000 ? next.text.trim() : null;
    out.push({ at: m.at, url, caption });
  });
  return out;
}

export async function recentlySent(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT created_at, content FROM co_memories
       WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'Co replied:%'
         AND created_at > NOW() - ($2 || ' days')::interval
       ORDER BY created_at DESC LIMIT 200`,
      [userId, SENT_LOOKBACK_DAYS],
    )
    .catch(() => ({ rows: [] as any[] }));
  const pairs = pairSentLinks(rows.map((r: any) => ({ at: new Date(r.created_at), text: String(r.content).replace(/^Co replied:\s*/, "") })));
  return pairs
    .slice(-SENT_MAX)
    .map((p) => `Co sent them ${DateTime.fromJSDate(p.at).toRelative()} (${DateTime.fromJSDate(p.at).toFormat("ccc LLL d")}): ${p.caption ? `"${p.caption}"` : "(no description on file)"} (link ${p.url})`);
}

// What Co is really still looking for, from open asks. Only these make
// "I'll keep looking and text you if something fits" true: the daily sweep
// searches each open ask and the daily pick can text about a result. With
// none open, nothing is being looked for and any such promise is false.
export async function addOngoingSearchFacts(rf: ReplyFacts, userId: string, asks?: { text: string; kind: "find" | "help" }[]): Promise<void> {
  if (rf.facts.some((f) => f.kind === "ongoing")) return;
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
  const help = asks.filter((a) => a.kind === "help" && a.text).slice(0, 3);
  const out: { kind: FactKind; text: string }[] = [];
  if (find.length) {
    out.push({ kind: "ongoing", text: `Co's daily search is looking for: ${find.map((a) => `"${a.text}"`).join("; ")}. If something real fits, Co may text them about it (at most one text a day). Co can't promise it will find anything, or when.` });
  } else {
    out.push({ kind: "unknown", text: "Co's daily search isn't looking for anything for them right now. Nothing will be looked for later unless they ask for something a search can find." });
  }
  if (help.length) {
    out.push({ kind: "known", text: `Also on file, but not something Co's search looks for: ${help.map((a) => `"${a.text}"`).join("; ")}. Co can talk it through with them now; nothing is being looked for or worked on in the background.` });
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
  addFact(rf, "known", `${label} Co told them about: "${match.name}"${match.event_date ? `, on ${match.event_date}` : ""}${match.deadline ? `, application deadline ${match.deadline}` : ""}${note}.`);
  addFact(rf, "known", match.url ? `Link for "${match.name}": ${match.url}` : `There is no link on file for "${match.name}".`);
  // The real record (event page or source post), so "tell me more" gets
  // real answers instead of "I don't have that".
  // Its volatile lines (start, price, spots, sold out) say when they were read: past a few hours, "not checked since" (Phase B, B3).
  if (match.details) for (const line of renderDetailsAsOf(match.name, match.details, match.checkedAt ?? null, new Date(), zone)) addFact(rf, "known", line);
  addFact(rf, "known", `Co found "${match.name}" through ${sourceOf(match)}. If they ask where it came from, say that.`);
  if (match.opportunity) addFact(rf, "known", `What the source post for "${match.name}" says: ${match.opportunity.postText}`);
  if (match.audience) addFact(rf, "known", `Who "${match.name}" is for, as Co judged it when it found it: ${match.audience}. If you describe the event, say that plainly; never say or imply what they are.`);
  if (match.whyItFits) addHint(rf, `Why "${match.name}" may fit them (a search's read, not a fact): ${match.whyItFits}`);
  if (match.kind !== "opportunity") {
    const missing = missingEventDetails(match.name, match.details);
    if (missing) addFact(rf, "unknown", missing);
  }
}

export function renderReplyFacts(rf: ReplyFacts): string {
  // Receipts (2026-09-25): what Co tried and didn't manage, marked so it's
  // never read as done.
  const facts = rf.facts.map((f) => `[${f.id}] ${f.kind === "not_done" ? `NOT DONE: ${f.text}` : f.kind === "hint" ? `YOUR READ, NOT A FACT (use for how you say it, never state it as fact): ${f.text}` : f.text}`).join("\n");
  const instr = rf.instructions.length ? `\n\nFor this reply:\n${rf.instructions.map((i) => `- ${i}`).join("\n")}` : "";
  return `What's true right now. These, plus what's actually in the conversation, are the only actions, plans, links, times, places, numbers, and things about other people you can mention. If a detail isn't here, you don't have it: say so plainly, and don't promise to get it later.
${facts}${instr}`;
}

// ---------------------------------------------------------------------------
// Gate

export type Claim = {
  text: string;
  type: "past_action" | "future_promise" | "time" | "place" | "link" | "other_person" | "member_life" | "count" | "capability" | "detail" | "prediction" | "offer" | "followup";
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
  return (text ?? "")
    .split("\n")
    // "User said:", a voice memo's transcript ("User sent a voice memo:"), and a
    // dated form ("User said on September 29, 2026:").
    .map((l) => l.match(/\bUser(?: said| sent a voice memo)?(?: on [^:]{1,40})?:\s*(.+)$/i)?.[1]?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
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
const CARRIED_WORK = /^(?:Co is working on task #|Co is putting together research brief #|Research brief #\d+ for them, .* is finished but hasn't reached them yet)/;
export function workBacksPromise(f: Fact): boolean {
  return (f.kind === "did_this_turn" && STARTED_WORK.test(f.text)) || (f.kind === "scheduled" && CARRIED_WORK.test(f.text));
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
  if (dangling) checks.push({ name: "no_link_offer_without_link", pass: false, reason: `offers a link Co doesn't have: "${dangling}"` });
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
    checks.push({ name: "no_capability_denial", pass: false, reason: "says Co can't call, which is false" });
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
    (src.sentThisTurn ?? []).some((m) => m === "[sent Co's contact card]" || /^https?:\/\//i.test(m.trim())) ||
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
      reason: "offers or claims a group text, which Co can't do. Introductions go out as one email to both people once both have said yes",
    });
  }
  // Per sentence, and Co has to be the one sending (2026-09-22: advice about
  // their own event, "have a few founders send invites", was read as Co
  // claiming a membership invite and the whole reply became invite copy).
  const namesAnInvite = (draft.match(SENTENCES) ?? [draft]).some(
    (s) =>
      INVITE_NOUN.test(s) &&
      INVITE_ACTION_VERB.test(s) &&
      (/\b(i|i'?m|i'?ve|i'?ll|me|co)\b/i.test(s) || /^\s*(sending|sent|adding|getting)\b/i.test(s) || /\bhere'?s (an|your|the) invit|\binvit\w* (is |'s )?on (its|it'?s) way/i.test(s)),
  );
  if (!inviteHandled && (namesAnInvite || (inviteAsk && INVITE_ACTION_VERB.test(draft)))) {
    checks.push({
      name: "no_invite_sent_claim",
      pass: false,
      reason: "says an invite is sent or on its way, but none went out this turn. Tell them to ask Co for an invite for their friend; don't offer, promise or claim one",
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
  const narrated = narratesInternalState(draft, { allow: (sentence) => nothingReadable && arrivalDenial(sentence) });
  if (narrated) checks.push({ name: "no_internal_narration", pass: false, reason: `narrates Co's own state instead of what they get (${narrated})` });
  // A stored spot count, time or price said as current when every fact behind it is marked stale (Phase B, B3, services/asOf.ts):
  // say it as of its read, or it's cut. The sentence is quoted so stripUnsupported cuts exactly it.
  for (const s of staleCurrentClaims(draft, rf.facts.filter((f) => f.kind !== "hint").map((f) => f.text))) {
    checks.push({ name: "no_stale_as_current", pass: false, reason: `detail: "${s.sentence}" (states a stored detail as current; it was last read earlier, so say when, or check it live)` });
  }
  return checks;
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

// Co saying something it tried did NOT happen ("You're right, it never sent, and that's on me", "that didn't go through"). Never
// something arriving to Co ("nothing's come through on my end"): that's the file record's to back (arrivalDenial).
export const ADMITS_NOT_DONE = /\b(never|nothing|didn'?t|did not|wasn'?t|was not|hasn'?t|has not|haven'?t|have not|couldn'?t|could not|not)\b[^.?!]{0,30}\b(sen[dt]|go(ne)? through|went( out| through)?|sav(e|ed)|happen(ed)?|made|ma[dk]e it|work(ed)?|deliver(ed)?|pass(ed)?|reach(ed)?|call(ed)?|book(ed)?)\b/i;
// Something on record (not a receipt that it failed) says Co sent or did a thing; then an admission is left to the model's read.
function doneOnRecord(facts: Fact[]): boolean {
  return facts.some((f) => f.kind !== "not_done" && f.kind !== "hint" && /\b(sent|delivered|texted|emailed|went out|saved|made them)\b/i.test(f.text) && !NEGATIVE_RECEIPT.test(f.text));
}

// An admission and nothing else: every clause either says an action didn't happen, or owns it ("that's on me", "sorry"). Any other
// clause ("but I drafted it", "though Ellis has your number now") sends the whole claim through the normal check (2026-10-12 review).
const OWNING = /^(?:(?:and|but|so|yes|yeah|honestly|ok(?:ay)?)\s+)*(?:that'?s on me|that was on me|sorry|i'?m sorry|you'?re right|my fault|my mistake|my bad)$/i;
export function onlyAdmits(text: string): boolean {
  const clauses = text.replace(/[’‘]/g, "'").split(/[,;.!?]+|\b(?:but|though|although|so|and)\b/i).map((c) => c.trim()).filter(Boolean);
  return clauses.some((c) => ADMITS_NOT_DONE.test(c)) && clauses.every((c) => ADMITS_NOT_DONE.test(c) || OWNING.test(c));
}

async function extractClaims(draft: string, rf: ReplyFacts, src: GroundingSources, model: string = LAYER3_MODELS.grounding): Promise<{ claims: Claim[]; latencyMs: number } | null> {
  const started = Date.now();
  const facts = rf.facts.filter((f) => f.kind !== "hint").map((f) => `[${f.id}] ${f.text}`).join("\n");
  const receipts = receiptsForCheck(rf);
  const { text } = await generateText({
    model: anthropic(model),
    maxOutputTokens: 2000,
    // Haiku takes no effort setting (it errors, 2026-09-27).
    ...(model === MODELS.haiku ? {} : { providerOptions: { anthropic: { effort: GROUNDING_EFFORT } } }),
    // A stalled call held one check for 318s in a test (2026-09-26); past
    // this the check counts as unavailable and the usual fallback runs.
    abortSignal: AbortSignal.timeout(GROUNDING_CALL_TIMEOUT_MS),
    experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.check" },
    prompt: `You check a text message Co is about to send, before it goes out. Find every claim in it that could be false, and say whether the sources below support it.

Claims to find (one type each):
- past_action: something Co says it did or sent ("I sent you the link", "I scheduled it", "I emailed you both"), including a yes or no to whether it did ("Still no", "Yep, I did") and passing something along ("noted for the team", "that goes straight to the team", "I passed it on")
- future_promise: something Co says it will do later ("I'll send it when I have it", "I'll keep an eye out", "I'll call you then"), or is already doing in the background ("I'm working the sponsor search"), or telling them to ask again later as if something will have changed
- time, place, count, detail: a specific about an event, program, or plan: start time, date, address, neighborhood, headcount, format, host, price; a count includes how many things Co found, sent, or searched ("those two were the results"). Saying two events clash, or that it's "one or the other", is a time claim. Saying Co doesn't have a detail ("no start time listed", "I don't have the address") is a detail claim.
- link: a link, or "it's in the link above"
- member_life: something about the member's own life as they've told Co: the people in it, named the way they described them ("your mentor Lena", "your brother", "Ravi, your mentor"), their preferences ("crowded mixers drain you"), their history, their work and projects by name ("your startup ZEBRA-VAULT-941"), where they live
- other_person: someone outside the member's own life, or what any person said, wants, feels, did or will do beyond what the member told Co ("she mentioned she'd like to meet you", "Lena would love to help"), or who specifically will be somewhere, or that the people there are theirs ("that's your crowd", "go find the llama_index people", "your cofounder will be there")
- capability: what Co can or can't do ("I can search for X", "I can't call"); every "I can…" is one
- offer: suggesting an event or opportunity as something for them to go to or do ("Mahjong After Dark is Saturday", "worth grabbing a spot at X")
- followup: asking how something went or whether they went, or saying it happened ("how was the demo day?")
- prediction: what Co says will or won't happen in the world, or how likely it is ("it'll probably sell out", "nothing else is coming this week")

Never claims (don't list these):
- The member's own words and choices from this conversation, restated or built on ("you already called the daytonaio night your pick", "since you said you're in"). The member is never "another person".
- Opinions, feelings, questions (an offer asked as a question, "Want me to look now?", is a question), encouragement, and how Co will talk ("I'll keep it short").
- Saying yes to what they just asked ("Happy to.", "Sure.", "Glad to help.", "Let's do it."): that's agreeing, not a capability. Inviting them to send or share something ("Send it over", "Walk me through the key slides") is a request, not a claim.
- What Co's own draft, prompt, plan or advice should do for them ("That should give you clean, reusable drafts"): that's advice about Co's own work, not a prediction about the world.
- Advice and possibilities: general know-how about how things usually go ("personal invites beat a mass email"); what kind of people events like this tend to draw; where this could take them ("could be a good place to find the dependable builder people you're after"); a plan or schedule Co proposes for them; a conclusion reasoned from the sources ("if Oct 10 is under 30 days out, the permit may not clear").

Precedence, when a sentence fits both: a named venue, event, person, date, price, number, rule, fee or deadline that isn't in the sources is a claim even inside advice. Saying specific people will be there, or that they're the member's people, is other_person even when phrased loosely. A person the member told Co about, said back as who they are to the member ("your mentor Lena reviews your pitch on Fridays", if they said so), is member_life; what that person thinks, says, wants or will do now is other_person. A possibility about the kind of person or outcome the member wants is advice.

Support: a claim is supported only if a FACT below states it, or the real texts in the conversation show it. What Co did or didn't do (past_action, including "I never sent that") needs a FACT: Co's own earlier words aren't evidence of what it did, and if a FACT shows Co sent it, "never sent" is unsupported; passing something to the team needs a FACT that it was saved. Saying Co did NOT do something ("it never sent, and that's on me", "that didn't go through") is supported when no FACT shows it happened; mark it supported with no factId. A FACT listed under DONE THIS TURN is something that really happened this turn, what Co's own tools did in this turn (a receipt): it supports the same action said in other words ("passed it along to the team" from "Saved for the team"), and a description of something just sent supports what that FACT says it contains. A future_promise needs a FACT that it will actually happen (a scheduled call, a pending item, an open task, or the next step in Co's working notes for them); an open task Co is working on for them supports promising to keep working that goal (keep looking, chase a price or a quote, report back before its deadline). A capability needs a capability FACT covering that exact thing. A prediction needs a FACT stating that outcome; guessing from what was or wasn't found is never support. "I don't have X" is supported only when no FACT, and nothing they've told Co before, gives X; when nothing does, mark it supported with no factId or quote, since an absence has nothing to cite. Them having just mentioned X in this message doesn't make "I don't have anything on file about X" false. A clash needs FACTS giving both start times, overlapping. Dates decide offers and follow-ups: an offer needs a FACT showing it's still ahead or today, never one marked "already over" or "outside the dates they asked about"; a followup needs a FACT showing it's already over, never one marked "coming up". A number must match its source exactly. Their own texts in this conversation are a source for their own life and plans, said back in Co's words with everyday inferences: where they moved from (which never says where they live now unless they said that too), their work, a plan they named and its day ("today's meeting" backs "later today" for it, never "tonight"); quote their words. What they've told Co before (their own words, below) can support member_life; what Co knows about them can support a detail about the member themself; neither supports a claim about an event, a count, a link, or another person outside their own life, and someone who's another member of Co is never part of their own life. Never count something as supported because it's plausible.

FACTS:
${facts}
${receipts ? `\nDONE THIS TURN (what Co's own tools really did in this turn; each is also a FACT above, cite its id):\n${receipts}\n` : ""}
Conversation so far:
${src.recentConversation || "(none)"}
${src.sentThisTurn?.length ? `\nCo already sent this turn:\n${src.sentThisTurn.join("\n")}\n` : ""}${src.contextSummary ? `\nWhat Co knows about them:\n${src.contextSummary}\n` : ""}${theirOwnWords(src.recentMemories) ? `\nWhat they've told Co before (their own words from older conversations):\n${theirOwnWords(src.recentMemories)}\n` : ""}
They just said: "${src.message}"

Message Co is about to send:
"${draft}"

Return ONLY JSON: {"claims": [{"text": "exact words from the message", "type": "...", "supported": true|false, "factId": "F3" or null, "quote": "exact words copied from the conversation or what Co knows that support it" or null}]}. Supported claims need a factId or a quote. Return {"claims": []} if there are none.`,
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

// A model's "supported" only counts if its citation checks out in code.
export function claimChecks(claims: Claim[], rf: ReplyFacts, src: GroundingSources): GateCheck[] {
  // A hint (model-written read) is never support, even when cited.
  const factIds = new Set(rf.facts.filter((f) => f.kind !== "hint").map((f) => f.id));
  const hintIds = new Set(rf.facts.filter((f) => f.kind === "hint").map((f) => f.id));
  const nothingReadable = recordSaysNothingReadable(rf.facts);
  const savedForTeamThisTurn = rf.facts.some((f) => f.kind === "did_this_turn" && /^Saved for the team:/.test(f.text));
  return claims.map((c) => {
    const sources = sourceText(rf, src, c.type);
    let pass = c.supported;
    let reason = `${c.type}: "${c.text}"`;
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
    if (c.type === "past_action" && onlyAdmits(c.text) && (!doneOnRecord(rf.facts) || pass)) {
      return { name: `claim_${c.type}`, pass: true, reason: `${reason} (an admission it didn't happen${pass ? "" : ", and nothing on record says it did"})` };
    }
    if (!pass && c.type === "past_action" && savedForTeamThisTurn && TEAM_PASS.test(c.text) && !TEAM_PASS_PLUS.test(c.text)) {
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
    if (pass && c.type === "past_action" && !(c.factId && factIds.has(c.factId))) {
      pass = false;
      reason += " (what Co did has to come from a fact, not from the conversation)";
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
      const quoteOk = !!c.quote && norm(c.quote).length >= 6 && sources.includes(norm(c.quote));
      if (!factOk && !quoteOk) {
        pass = false;
        reason += " (cited support not found)";
      }
    }
    return { name: `claim_${c.type}`, pass, reason };
  });
}

async function redraft(draft: string, failed: GateCheck[], rf: ReplyFacts, src: GroundingSources, earlierTry: string | null = null): Promise<string | null> {
  const tail = src.recentConversation.split("\n").slice(-14).join("\n");
  const { text } = await generateText({
    model: anthropic(LAYER3_MODELS.redraft),
    maxOutputTokens: 1000,
    providerOptions: { anthropic: { effort: GROUNDING_EFFORT } },
    abortSignal: AbortSignal.timeout(GROUNDING_CALL_TIMEOUT_MS),
    experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.redraft" },
    prompt: `${CO_VOICE}

${CO_TEXT_CHANNEL}

${renderReplyFacts(rf)}

Recent conversation:
${tail || "(none)"}
${src.sentThisTurn?.length ? `\nYou already sent this turn:\n${src.sentThisTurn.join("\n")}\n` : ""}${theirOwnWords(src.recentMemories) ? `\nWhat they've told you before (their own words about their own life):\n${theirOwnWords(src.recentMemories)}\n` : ""}
They just said: "${src.message}"

Your draft reply:
"${draft}"

These parts of the draft aren't supported by the facts or the conversation:
${failed.map((f) => `- ${f.reason ?? f.name}`).join("\n")}
${earlierTry ? `\nAn earlier rewrite also had unsupported parts (listed above too): "${earlierTry}"\nThis time, answer what they just asked first, in words the facts above actually support, even if the honest answer is short.\n` : ""}
Deleting the unsupported parts left too little to answer them, so write the smallest true reply instead. Keep every supported sentence of the draft word for word. Where a flagged part can be corrected from a FACT (the real time, what was actually sent), correct it with the FACT's own words. When the FACTS say where something of theirs stands (a search, a task, your working notes, what you sent), and what's left doesn't answer them, answer with that state: what's found, what's unconfirmed, the next move. That is the answer, never a remark about what you can't measure, describe or nail down (2026-10-01: "how proactive are you?" became a disclaimer while their venue search's status sat in the facts). Otherwise say once, plainly, the one thing you don't have. Never add a new recommendation or change which option the draft recommends, never add an event, person, place, number, date or link that isn't in the draft or the FACTS (people and details from what they've told you before about their own life may stay or be used), never say you don't have something that what they've told you before gives, and never add anything about how they're feeling or what they're going through. No promises, no "let me look" or "one sec". If they want something found and a FACT shows work under way for it, say what you're doing about it now, from that FACT; never offer it back to them as a question. Match the draft's capitalization style. Same length or shorter. Return ONLY the message.`,
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

async function recheck(draft: string, rewrite: string, failed: GateCheck[], rf: ReplyFacts, src: GroundingSources): Promise<{ checks: GateCheck[]; modelOk: boolean; ms: number }> {
  // GROUNDING_FULL_RECHECK only exists so evals/grounding can compare the old full re-read.
  if (process.env.GROUNDING_FULL_RECHECK) return onlyCuts(draft, rewrite) ? { checks: [...codeChecks(rewrite, rf, src), { name: "claim_read", pass: true, reason: "only cuts" }], modelOk: true, ms: 0 } : check(rewrite, rf, src);
  const code = codeChecks(rewrite, rf, src);
  const changed = sentencesToRecheck(draft, rewrite, failed);
  if (!changed.length) return { checks: [...code, { name: "claim_read", pass: true, reason: "the rewrite only kept or cut already-checked words" }], modelOk: true, ms: 0 };
  const r = await check(changed.join(" "), rf, src, RECHECK_MODEL);
  return { checks: [...code, ...r.checks.filter((c) => c.name.startsWith("claim"))], modelOk: r.modelOk, ms: r.ms };
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
  const keep = sentences.filter((s) => {
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
  return keep.join("").trim();
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
function enoughLeft(text: string, draft = ""): boolean {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (draft.includes("?") && !text.includes("?") && words < 14) return false;
  return words >= 4;
}

export type GroundingResult = {
  final: string;
  // cut: the unsupported sentences were deleted and the rest went out as drafted.
  outcome: "as_drafted" | "cut" | "redrafted" | "stripped" | "unchecked";
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

// The honest "I don't have that" in Co's own words, stating nothing else.
// What replaces a reply stripped down to almost nothing.
export function afterStrip(o: { enough: boolean; inviteCut: boolean; sentThisTurn: string[] }): "invite" | "cut" | "nothing" | "honest" {
  if (o.inviteCut) return "invite";
  if (o.enough) return "cut";
  return o.sentThisTurn.some((m) => m.trim()) ? "nothing" : "honest";
}

async function honestNoAnswer(message: string): Promise<string | null> {
  const { lineInVoice } = await import("../services/voiceLine.js");
  const r = await lineInVoice({
    purpose: "Say plainly, in one short line, that you don't have a solid answer to what they just asked, without guessing, apologizing at length, or promising to find out later.",
    facts: [`They asked: "${message.slice(0, 200)}"`, "Co doesn't have a confirmed answer to it right now."],
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
export function deniesWhatTheyToldCo(failed: GateCheck[], src: GroundingSources): boolean {
  return !!(src.recentMemories?.trim() || src.contextSummary?.trim()) && failed.some((c) => /^claim_(detail|member_life)$/.test(c.name) && CO_DENIES_HAVING.test(c.reason ?? ""));
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
  /\b(i|co)\s+(always\s+|usually\s+|automatically\s+|already\s+)?(keep|track|watch|save|store|remember|pass|share|check|search|look|flag|log|note|monitor|follow|remind|send)(s|ed|ing)?\b/i,
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
];

export function needsClaimCheck(draft: string): boolean {
  return CLAIM_SHAPED.some((re) => re.test(draft));
}

// One retry before giving up on a claim-shaped draft (2026-09-17 code
// review): a single bad JSON response or a transient failure used to send
// the draft "unchecked," with only the cheap regex checks behind it.
async function check(draft: string, rf: ReplyFacts, src: GroundingSources, model?: string): Promise<{ checks: GateCheck[]; modelOk: boolean; ms: number }> {
  const code = codeChecks(draft, rf, src);
  if (!needsClaimCheck(draft)) return { checks: [...code, { name: "claim_read", pass: true, reason: "nothing claim-shaped, model read skipped" }], modelOk: true, ms: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const extracted = await extractClaims(draft, rf, src, model);
      if (extracted) return { checks: [...code, ...claimChecks(extracted.claims, rf, src)], modelOk: true, ms: extracted.latencyMs };
      console.error(`replyGrounding: claim check returned unusable JSON on attempt ${attempt}${attempt === 1 ? ", retrying once" : ""}`);
    } catch (err: any) {
      console.error(`replyGrounding: claim check failed on attempt ${attempt}${attempt === 1 ? ", retrying once" : " (non-fatal, giving up)"}:`, err?.message ?? err);
    }
  }
  return { checks: code, modelOk: false, ms: 0 };
}

// The claim read alone, for another speaker's reply (Mo's, mo/teamAgent.ts):
// only the claim checks, none of Co's own code checks.
export async function claimChecksOnly(draft: string, rf: ReplyFacts, src: GroundingSources, opts: { force?: boolean } = {}): Promise<GateCheck[]> {
  if (!opts.force && !needsClaimCheck(draft)) return [];
  const extracted = await extractClaims(draft, rf, src).catch(() => null);
  return extracted ? claimChecks(extracted.claims, rf, src) : [];
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
    const tracked = await trackPromise({ userId: opts.userId, reply: draft, theirMessage: src.message, privateNames: rf.privateNames, discreet: isDiscreetTurn(rf.instructions), startedThisTurn }).catch((err: any) => ({ ok: false as const, why: String(err?.message ?? err).slice(0, 120) }));
    if (tracked.ok) {
      addFact(rf, "did_this_turn", promiseFact(tracked.task));
      promiseTaskId = tracked.task.id;
    }
    recordDecision({ layer: 3, decision: "promise.tracked", userId: opts.userId, outcome: tracked.ok ? "act" : "skip", action: tracked.ok ? `task:${tracked.task.id}` : tracked.why, proposal: { sentence: tracked.ok ? tracked.sentence : promiseSentence(draft) } }).catch(() => {});
  }
  const first = await check(draft, rf, src);
  const firstCheckMs = Date.now() - started;
  const stages: NonNullable<GroundingResult["stages"]> = {};
  let result: GroundingResult;
  const failed1 = first.checks.filter((c) => !c.pass);
  // A claim-shaped draft whose claim read failed twice is treated as a
  // failed check, not sent as "unchecked" on code checks alone (2026-09-17
  // code review) — it goes through the same redraft-then-strip path below.
  const effectiveFailed1 = claimReadUnavailable(draft, first) ? [...failed1, CLAIM_READ_FAILED_CHECK] : failed1;

  if (!effectiveFailed1.length) {
    result = { final: draft, outcome: "as_drafted", checks: first.checks, latencyMs: Date.now() - started, firstCheckMs, stages };
  } else {
    // 1. Delete what's unsupported (2026-09-28, remove-only). What's left was
    // already checked, so it needs no second model read; code checks still run.
    // The same allowance the narration check made (a true "it hasn't come through", services/inboundFile.ts).
    const allowArrival = { allow: (sentence: string) => recordSaysNothingReadable(rf.facts) && arrivalDenial(sentence) };
    let cut = stripUnsupported(draft, effectiveFailed1, allowArrival);
    const cutCode = codeChecks(cut, rf, src).filter((c) => !c.pass);
    if (cutCode.length) cut = stripUnsupported(cut, cutCode, allowArrival);
    const inviteCut = effectiveFailed1.some((c) => c.name === "no_invite_sent_claim") && !rf.facts.some((f) => /invites are used/i.test(f.text));
    // What's left must not be only an apology (2026-10-03: "Sorry for the false
    // start." was all that remained of a reply about someone else).
    if (enoughLeft(cut, draft) && !apologyOnly(cut) && !inviteCut && !deniesWhatTheyToldCo(effectiveFailed1, src)) {
      result = { final: cut, outcome: "cut", checks: first.checks, latencyMs: Date.now() - started, firstCheckMs, stages };
    } else {
      // 2. Too little left: one model rewrite, kept only if it adds nothing.
      let kept: { text: string; checks: GateCheck[] } | null = null;
      const t0 = Date.now();
      try {
        const rewrite = await redraft(draft, effectiveFailed1, rf, src);
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
      if (kept) {
        result = { final: kept.text, outcome: "redrafted", checks: [...first.checks, ...kept.checks.map((c) => ({ ...c, name: `redraft.${c.name}` }))], latencyMs: Date.now() - started, firstCheckMs, stages };
      } else {
        // 3. The cut, or the minimal honest line. The invite line only helps
        // when an invite claim was what came out (2026-09-20 code review).
        const enough = cut.split(/\s+/).filter(Boolean).length >= 3;
        // Something already went out this turn (finds, a link): what's left of
        // the closing line is dropped rather than replaced with "I don't have
        // an answer", which contradicted the finds just sent (2026-10-01
        // next-live run: a find went out, then "Nothing confirmed on that yet").
        const after = afterStrip({ enough, inviteCut, sentThisTurn: src.sentThisTurn ?? [] });
        // Co says it in its own words, claiming nothing (2026-09-28: the one
        // fixed line read as a script); the fixed line is the fallback.
        const honest = after === "honest" ? await honestNoAnswer(src.message).catch(() => null) : null;
        const final = after === "invite" ? [enough && !/invite/i.test(cut) ? cut : "", INVITE_FALLBACK].filter(Boolean).join(" ") : after === "cut" ? cut : after === "nothing" ? "" : honest ?? MINIMAL_FALLBACK;
        result = { final, outcome: "stripped", checks: first.checks, latencyMs: Date.now() - started, firstCheckMs, stages };
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

  // Promises and "I can"s held back, as their own typed row (services/guardDrops.ts): counted, no text.
  const overpromised = result.outcome !== "as_drafted" ? result.checks.filter((c) => !c.pass && /^claim_(future_promise|capability)$/.test(c.name)) : [];
  if (opts.record !== false && overpromised.length) {
    const { recordGuardDrop } = await import("../services/guardDrops.js");
    recordGuardDrop({ guard: "overpromise", where: "reply.grounding", userId: opts.userId ?? null, count: overpromised.length, reason: `${result.outcome}: ${[...new Set(overpromised.map((c) => c.name.replace(/^claim_/, "")))].join(", ")}` });
  }
  if (opts.record !== false) {
    await recordDecision({
      layer: 3,
      decision: "reply.grounding",
      userId: opts.userId ?? null,
      outcome: "act",
      action: result.outcome,
      proposal: { draft, final: result.final },
      checks: result.checks,
      confidence: result.outcome === "unchecked" ? "low" : null,
      reason: result.checks.filter((c) => !c.pass).map((c) => c.reason ?? c.name).join("; ") || null,
    });
  }
  return result;
}
