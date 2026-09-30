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
import { loadMilestones, storyLines } from "../services/milestones.js";
import { ABILITIES, capabilitySheet } from "../services/capabilities.js";
import { kitLines } from "../services/memberKit.js";
import { sentDetailHints, sentDetailLines, type TurnContext } from "../services/turnContext.js";
import { switchedOff } from "../services/abilitySwitches.js";
import { textingStyleFor } from "../services/textingStyle.js";
import { tasteSummary } from "../services/outcomes.js";
import { handoffFor, isTeamMember, teamSheet } from "../services/extensions.js";
import { ledgerFacts } from "../services/coFacts.js";
import { DEFAULT_ZONE, dateNote, itemDays, localToday, readDates, type Days } from "../services/dateGuard.js";
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
import { enrichMatch, missingEventDetails, renderEventDetails, type EventDetails, type OpportunityDetails } from "../services/eventDetails.js";
import { recentCallCorrections } from "./callGrounding.js";

// Model policy (Royce, 2026-09-14): Sonnet 5 for anything with judgment or
// side effects; Haiku only for narrow, code-checked reads.
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

export type ReplyFacts = { facts: Fact[]; instructions: string[] };

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
export function baseReplyFacts(): ReplyFacts {
  const rf = createReplyFacts();
  for (const c of capabilitySheet()) addFact(rf, "capability", c);
  return rf;
}

// Gathers the facts that don't depend on what happened earlier in this turn.
// Branch-specific facts (a link just sent, a call that failed) are added by
// routes/sendblue.ts as it acts.
export async function gatherReplyFacts(
  userId: string,
  // context: their message and Co's last few lines, so older things they
  // name can be looked up in Co's record (services/coFacts.ts).
  // turn: the one picture of this turn (services/turnContext.ts). When given,
  // the snapshot, the record, open asks and what Co sent come from it instead
  // of separate loads.
  opts: { pendingDescriptions?: string[]; context?: string; turn?: TurnContext } = {},
): Promise<ReplyFacts> {
  const rf = baseReplyFacts();
  for (const d of opts.pendingDescriptions ?? []) addFact(rf, "pending", `Waiting to hear back: ${d}`);
  // What's landed with them (services/outcomes.ts tasteSummary).
  const taste = await tasteSummary(userId).catch(() => null);
  if (taste) addFact(rf, "known", taste);
  // How they've told Co they like to be texted (services/textingStyle.ts).
  const style = await textingStyleFor(userId).catch(() => [] as string[]);
  if (style.length) addInstruction(rf, `How they've told you they like to be texted, follow it: ${style.join("; ")}.`);
  // A member an extension brought in (Mo's invitations): what it knew, to
  // ask about rather than state (services/extensions.ts, mo/handoff.ts).
  const handoff = await handoffFor(userId).catch(() => ({ known: [] as string[], instructions: [] as string[] }));
  for (const k of handoff.known) addFact(rf, "known", k);
  for (const line of handoff.instructions) addInstruction(rf, line);
  // The team only: Co's teammates and the team-only abilities, so Co never
  // pitches Mo's work back as a new idea (services/extensions.ts teamSheet).
  // Everyone else gets nothing about them.
  if (await isTeamMember(userId).catch(() => false)) {
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
  // Every source is a separate read, so they run together: in series this
  // was six round trips before the reply could even start drafting.
  const [corrections, snapshot, sent, notes, scheduled, reveal, preference, callFailure, sendHeld] = await Promise.all([
    recentCallCorrections(userId),
    opts.turn ? Promise.resolve(opts.turn.snapshot) : getPersonSnapshot(userId).catch(() => null),
    recentlySent(userId),
    recentSearchNotes(userId),
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
    // Why a recent call failed (services/mediaStreamBridge.ts noteCallFailure).
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
  addFact(rf, "known", `Today is ${DateTime.now().setZone("America/Los_Angeles").toFormat("cccc, LLLL d, yyyy")} (Pacific time).`);
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
  // What Co has for doing things on their behalf, and what it doesn't (services/memberKit.ts).
  if (opts.turn?.kit) {
    for (const line of kitLines(opts.turn.kit)) addFact(rf, "known", line);
    // 2026-09-29: on a real thread Co repeated an earlier wrong answer ("just that you want help
    // applying to X") 3 of 3 times instead of the details on file.
    addInstruction(rf, "The details on file listed above are all you have for doing things on their behalf. If they ask what you have on them, answer from that list, even if an earlier reply in this conversation said otherwise, and say plainly if that earlier reply was wrong.");
  }
  // Where they've been with Co, from the record (services/milestones.ts): the
  // arc Co can look back on, in their own words.
  const story = opts.turn?.story ?? (opts.turn ? [] : await loadMilestones(userId).then((m) => storyLines(m, 4)).catch(() => [] as string[]));
  for (const line of story) addFact(rf, "known", line);
  // What Co told them lately, so it doesn't contradict itself and can ask how it went.
  for (const line of opts.turn?.advice ?? []) addFact(rf, "did_before", line);
  // On the way to a Co event today (services/preArrival.ts).
  const today = await import("../services/eventPresence.js").then((e) => e.todayEventFor(userId)).catch(() => null);
  if (today) {
    addFact(rf, "known", `They're registered for Co's event "${today.name}" today, starting ${today.startAt}.`);
    addInstruction(rf, `If they say they're running late, can't make it, or aren't sure about "${today.name}", answer them normally and warmly, record it with updateGoing, never pressure them to come, and never offer to contact the host.`);
  }
  // Co's own open tasks: real scheduled work, so saying when it'll get back to them is true.
  for (const line of opts.turn?.tasks ?? []) addFact(rf, "scheduled", line);
  if (opts.turn) for (const hint of sentDetailHints(opts.turn)) addHint(rf, hint);
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
      addEventFacts(rf, await enrichMatch(match));
    } catch {
      // Malformed or pre-fix content shape; nothing reliable to add.
    }
  }
  return rf;
}

// What a search did, written down so the next message can still say it
// honestly (2026-09-16: a search was dropped mid-turn when a newer message
// arrived, and the answer was lost with it).
export async function recordSearchNote(userId: string, note: string): Promise<void> {
  await pool
    .query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', $2)`, [userId, `[search] ${note}`])
    .catch((err: any) => console.error("recordSearchNote failed (non-fatal):", err?.message ?? err));
}

// The router's read that they want something found, passed to Co as
// guidance (2026-09-26: "Anything happening this weekend?" was read right by
// the router, and Co answered from results two days old). Co still decides.
export const FRESH_SEARCH_INSTRUCTION =
  "They're asking you to find something. Run a fresh search with searchNow, even if you sent something similar before, unless they're only asking about something specific you already sent.";

// Counts in words at the front of a search note (2026-09-26): Co read a
// note listing four misfits and said "those two were the results", and the
// claim check passed it because the note never said how many there were.
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function recentSearchNotes(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT content, created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'system' AND content LIKE '[search]%' AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 5`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  // Dated, so an earlier search is never taken as the answer to a new ask.
  return rows.map((r: any) => searchNoteLine(String(r.content), new Date(r.created_at), localToday()));
}

export function searchNoteLine(content: string, at: Date, today: string): string {
  const d = DateTime.fromJSDate(at).setZone(DEFAULT_ZONE).toISODate()!;
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
  match: { name: string; event_date?: string; deadline?: string; url?: string; kind?: string; details?: EventDetails; opportunity?: OpportunityDetails; whyItFits?: string; statedDates?: { start: string; end?: string | null } },
  asked?: Days | null,
): void {
  const label = match.kind === "opportunity" ? "Opportunity" : "Event";
  // Whether it's still ahead, against today (services/dateGuard.ts).
  const note = dateNote(readDates(itemDays(match), localToday(), asked));
  addFact(rf, "known", `${label} Co told them about: "${match.name}"${match.event_date ? `, on ${match.event_date}` : ""}${match.deadline ? `, application deadline ${match.deadline}` : ""}${note}.`);
  addFact(rf, "known", match.url ? `Link for "${match.name}": ${match.url}` : `There is no link on file for "${match.name}".`);
  // The real record (event page or source post), so "tell me more" gets
  // real answers instead of "I don't have that".
  if (match.details) for (const line of renderEventDetails(match.name, match.details)) addFact(rf, "known", line);
  addFact(rf, "known", `Co found "${match.name}" through ${sourceOf(match)}. If they ask where it came from, say that.`);
  if (match.opportunity) addFact(rf, "known", `What the source post for "${match.name}" says: ${match.opportunity.postText}`);
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
  type: "past_action" | "future_promise" | "time" | "place" | "link" | "other_person" | "count" | "capability" | "detail" | "prediction" | "offer" | "followup";
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
const WORLD_CLAIMS = new Set(["time", "place", "link", "count", "offer", "followup", "prediction", "other_person"]);
function sourceText(rf: ReplyFacts, src: GroundingSources, claimType?: string): string {
  const realFacts = rf.facts.filter((f) => f.kind !== "hint").map((f) => f.text).join("\n");
  const summaries = claimType && WORLD_CLAIMS.has(claimType) ? [] : [src.contextSummary ?? "", src.recentMemories ?? ""];
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
  const lookout = text.match(/\b(keep (my|an|our) eyes? (open|out|peeled)|keep (watching|looking|an eye out)|be on the lookout|watch(ing)? for (one|it|something|that)|text you (the second|the moment|right when|as soon as))\b/i);
  if (lookout) {
    const sentence = text.split(/(?<=[.!?])\s+/).find((x) => x.includes(lookout[0])) ?? "";
    if (/\b(if you want|want me to|should i|would you like)\b/i.test(sentence) && !/\b(i'?ll|i will)\b/i.test(sentence)) return null;
    return lookout;
  }
  return null;
}

// Phrasings that forecast whether something will turn up, sell out, or happen.
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
  // Follow-up promises nothing in the code keeps: no job texts them when a
  // link turns up or when the other person answers (an intro goes out by
  // email, not a text from Co).
  const found = followupPromiseMatch(draft);
  // A promise to keep looking is only true while an ask is open (the sweep
  // really does search it), and never with a timing commitment.
  const ongoing = rf.facts.some((f) => f.kind === "ongoing");
  const timingCommitment = /\b(the second|the moment|right when|as soon as|right away|immediately|tonight|tomorrow|today|this week)\b/i.test(draft);
  const lookingOnly = found && /keep (looking|watching|an eye|my eyes|eyes)|on the lookout|watch(ing)? for|if (something|anything|one) (real )?(turns up|comes up|fits|shows up)/i.test(found[0] + " " + draft);
  // Co's own task is real scheduled work (services/coTasks.ts): a follow-up it
  // describes is kept, and the claim check still needs it to cite that task.
  const tasked = rf.facts.some((f) => (f.kind === "scheduled" && /^Co is working on task #/.test(f.text)) || (f.kind === "did_this_turn" && /^Started task/.test(f.text)));
  if (found && !tasked && !(ongoing && lookingOnly && !timingCommitment)) {
    checks.push({ name: "no_followup_promise", pass: false, reason: `promises a follow-up nothing will do: "${found[0]}"` });
  }
  if (!emotionLabel.pass) checks.push(emotionLabel);
  return checks;
}

function extractJson(text: string): any {
  try {
    return parseModelJson(text);
  } catch {
    return null;
  }
}

async function extractClaims(draft: string, rf: ReplyFacts, src: GroundingSources, model: string = LAYER3_MODELS.grounding): Promise<{ claims: Claim[]; latencyMs: number } | null> {
  const started = Date.now();
  const facts = rf.facts.filter((f) => f.kind !== "hint").map((f) => `[${f.id}] ${f.text}`).join("\n");
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
- other_person: what another person said, wants, feels, or did ("she mentioned she'd like to meet you"), or who specifically will be somewhere, or that the people there are theirs ("that's your crowd", "go find the llama_index people", "your cofounder will be there")
- capability: what Co can or can't do ("I can search for X", "I can't call"); every "I can…" is one
- offer: suggesting an event or opportunity as something for them to go to or do ("Mahjong After Dark is Saturday", "worth grabbing a spot at X")
- followup: asking how something went or whether they went, or saying it happened ("how was the demo day?")
- prediction: what Co says will or won't happen in the world, or how likely it is ("it'll probably sell out", "nothing else is coming this week")

Never claims (don't list these):
- The member's own words and choices from this conversation, restated or built on ("you already called the daytonaio night your pick", "since you said you're in"). The member is never "another person".
- Opinions, feelings, questions (an offer asked as a question, "Want me to look now?", is a question), encouragement, and how Co will talk ("I'll keep it short").
- Advice and possibilities: general know-how about how things usually go ("personal invites beat a mass email"); what kind of people events like this tend to draw; where this could take them ("could be a good place to find the dependable builder people you're after"); a plan or schedule Co proposes for them; a conclusion reasoned from the sources ("if Oct 10 is under 30 days out, the permit may not clear").

Precedence, when a sentence fits both: a named venue, event, person, date, price, number, rule, fee or deadline that isn't in the sources is a claim even inside advice. Saying specific people will be there, or that they're the member's people, is other_person even when phrased loosely. A possibility about the kind of person or outcome the member wants is advice.

Support: a claim is supported only if a FACT below states it, or the real texts in the conversation show it. What Co did or didn't do (past_action, including "I never sent that") needs a FACT: Co's own earlier words aren't evidence of what it did, and if a FACT shows Co sent it, "never sent" is unsupported; passing something to the team needs a FACT that it was saved. A future_promise needs a FACT that it will actually happen (a scheduled call, a pending item). A capability needs a capability FACT covering that exact thing. A prediction needs a FACT stating that outcome; guessing from what was or wasn't found is never support. "I don't have X" is supported only when no FACT gives X. A clash needs FACTS giving both start times, overlapping. Dates decide offers and follow-ups: an offer needs a FACT showing it's still ahead or today, never one marked "already over" or "outside the dates they asked about"; a followup needs a FACT showing it's already over, never one marked "coming up". A number must match its source exactly. The summary of what Co knows about them can support a detail about the member themself, never a claim about an event, a count, a link, or another person. Never count something as supported because it's plausible.

FACTS:
${facts}

Conversation so far:
${src.recentConversation || "(none)"}
${src.sentThisTurn?.length ? `\nCo already sent this turn:\n${src.sentThisTurn.join("\n")}\n` : ""}${src.contextSummary ? `\nWhat Co knows about them:\n${src.contextSummary}\n` : ""}
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

// A model's "supported" only counts if its citation checks out in code.
function claimChecks(claims: Claim[], rf: ReplyFacts, src: GroundingSources): GateCheck[] {
  // A hint (model-written read) is never support, even when cited.
  const factIds = new Set(rf.facts.filter((f) => f.kind !== "hint").map((f) => f.id));
  const hintIds = new Set(rf.facts.filter((f) => f.kind === "hint").map((f) => f.id));
  return claims.map((c) => {
    const sources = sourceText(rf, src, c.type);
    let pass = c.supported;
    let reason = `${c.type}: "${c.text}"`;
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
    if (pass && c.factId && hintIds.has(c.factId) && !(c.quote && norm(c.quote).length >= 6 && sources.includes(norm(c.quote)))) {
      pass = false;
      reason += " (that came from a model's read, which is a hint, not a source)";
    }
    if (pass) {
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
${src.sentThisTurn?.length ? `\nYou already sent this turn:\n${src.sentThisTurn.join("\n")}\n` : ""}
They just said: "${src.message}"

Your draft reply:
"${draft}"

These parts of the draft aren't supported by the facts or the conversation:
${failed.map((f) => `- ${f.reason ?? f.name}`).join("\n")}
${earlierTry ? `\nAn earlier rewrite also had unsupported parts (listed above too): "${earlierTry}"\nThis time, answer what they just asked first, in words the facts above actually support, even if the honest answer is short.\n` : ""}
Deleting the unsupported parts left too little to answer them, so write the smallest honest reply instead. Keep every supported sentence of the draft word for word. Where a flagged part can be corrected from a FACT (the real time, what was actually sent), correct it with the FACT's own words; otherwise say once, plainly, the one thing you don't have ("I don't have the start time"), or what's actually true about something you did ("Honestly, that one didn't get passed to the team."). Never add a new recommendation or change which option the draft recommends, never add an event, person, place, number, date or link that isn't in the draft or the FACTS, and never add anything about how they're feeling or what they're going through. No promises, no "let me look" or "one sec"; if they want something found, you may offer it as a question ("Want me to look?"). Match the draft's capitalization style. Same length or shorter. Return ONLY the message.`,
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

const CROWD = /\b(that'?s|those are|they'?re|it'?s|full of|room of|go find) (all )?(your|his|her|their) (crowd|people|tribe|kind of people)\b|\bgo find the [\w@.'’-]+ (people|folks|crowd)\b/i;
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

// Last resort: drop the sentences that carry an unsupported claim.
export function stripUnsupported(draft: string, failed: GateCheck[]): string {
  const sentences = draft.match(SENTENCES_SP) ?? [draft];
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
    if (failed.some((f) => f.name === "no_prediction") && predictionMatch(s)) return false;
    if (failed.some((f) => f.name === "no_capability_denial") && (callDenial(s) || /\b(can(no|')?t|unable to|this is (just )?text)\b.{0,40}\bcalls?\b/i.test(s))) return false;
    if (failed.some((f) => f.name === "no_invite_sent_claim") && INVITE_ACTION_VERB.test(s)) return false;
    if (failed.some((f) => f.name === "no_group_chat_claim") && claimsGroupChat(s)) return false;
    if (failed.some((f) => f.name === "link_on_file") && /https?:\/\//i.test(s)) return false;
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
    let cut = stripUnsupported(draft, effectiveFailed1);
    const cutCode = codeChecks(cut, rf, src).filter((c) => !c.pass);
    if (cutCode.length) cut = stripUnsupported(cut, cutCode);
    const inviteCut = effectiveFailed1.some((c) => c.name === "no_invite_sent_claim") && !rf.facts.some((f) => /invites are used/i.test(f.text));
    if (enoughLeft(cut, draft) && !inviteCut) {
      result = { final: cut, outcome: "cut", checks: first.checks, latencyMs: Date.now() - started, firstCheckMs, stages };
    } else {
      // 2. Too little left: one model rewrite, kept only if it adds nothing.
      let kept: { text: string; checks: GateCheck[] } | null = null;
      const t0 = Date.now();
      try {
        const rewrite = await redraft(draft, effectiveFailed1, rf, src);
        stages.redraftMs = Date.now() - t0;
        const cleaned = rewrite ? cleanCoMessage(rewrite) : null;
        const allowed = rf.facts.filter((f) => f.kind !== "hint").map((f) => f.text).join("\n");
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
        // Co says it in its own words, claiming nothing (2026-09-28: the one
        // fixed line read as a script); the fixed line is the fallback.
        const honest = enough || inviteCut ? null : await honestNoAnswer(src.message).catch(() => null);
        const final = inviteCut ? [enough && !/invite/i.test(cut) ? cut : "", INVITE_FALLBACK].filter(Boolean).join(" ") : enough ? cut : honest ?? MINIMAL_FALLBACK;
        result = { final, outcome: "stripped", checks: first.checks, latencyMs: Date.now() - started, firstCheckMs, stages };
      }
    }
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
