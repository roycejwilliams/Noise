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

export type FactKind =
  | "did_this_turn" // something Co actually did during this turn
  | "did_before" // something Co really did on an earlier turn (what it sent)
  | "pending" // something Co asked and is still waiting on
  | "scheduled" // a real scheduled call
  | "known" // a real field Co has (event name, date, link, recommendation)
  | "unknown" // a detail Co explicitly does not have
  | "capability" // what Co can and can't do
  | "ongoing"; // a search that really keeps running for them (an open ask)

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

export function addInstruction(rf: ReplyFacts, text: string): void {
  const t = text.trim();
  if (t && !rf.instructions.includes(t)) rf.instructions.push(t);
}

const STANDING_CAPABILITIES = [
  `Co can call them right now when they ask ("call me"), and can schedule a call for a specific later time. Calling is real and working.`,
  `They can also call Co from this same number. You are not given the digits, so never write a phone number.`,
  `Co can't go chase down a specific link, detail, or answer later: if it isn't here, it won't show up.`,
  `Co can send its contact card (so they can save Co) with the sendContactCard tool when they ask for it or want to save Co.`,
  `Co never starts a group text or adds anyone to one, and never joins one. Sendblue can only reply to a number that has already texted in, so Co can't start a thread with two people. Introductions go out as one email to both people, and only after both have said yes. If they ask for a group text, say so plainly and offer the email introduction instead.`,
  `Members can invite friends to Co: 5 invites each, and one only counts once the friend joins. When they ask for an invite (or how a friend can get in), Co's invite step texts them a link to forward. Never write an invite link or code yourself, and never say an invite was sent unless it's listed as sent this turn. If they ask how it works, tell them to just ask you for an invite for their friend, and don't offer or promise to send one yourself.`,
  `Co can search right now (searchNow), save something they want found (people, events, a community, an opportunity) so the daily search keeps looking (saveAsk; it can't dig up a missing detail about something already sent), and send a link that's on file (shareLink). Co can't book, buy, register them for events, email or call other people for them, or post anywhere. If they ask for something Co can't do, say so plainly and say what Co can do instead.`,
];

// Facts that are true for every reply, before anything about this person.
export function baseReplyFacts(): ReplyFacts {
  const rf = createReplyFacts();
  for (const c of STANDING_CAPABILITIES) addFact(rf, "capability", c);
  return rf;
}

// Gathers the facts that don't depend on what happened earlier in this turn.
// Branch-specific facts (a link just sent, a call that failed) are added by
// routes/sendblue.ts as it acts.
export async function gatherReplyFacts(
  userId: string,
  opts: { pendingDescriptions?: string[] } = {},
): Promise<ReplyFacts> {
  const rf = baseReplyFacts();
  for (const d of opts.pendingDescriptions ?? []) addFact(rf, "pending", `Waiting to hear back: ${d}`);
  // Every source is a separate read, so they run together: in series this
  // was six round trips before the reply could even start drafting.
  const [corrections, snapshot, sent, notes, scheduled, reveal, preference, callFailure] = await Promise.all([
    recentCallCorrections(userId),
    getPersonSnapshot(userId).catch(() => null),
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
  await addOngoingSearchFacts(rf, userId);
  for (const correction of corrections) addFact(rf, "known", correction);
  // What Co knows about them, so "what do you know about me?" can be
  // answered from it (2026-09-15: the claim check had no copy of the person
  // summary and cut "designer by Friday" and "Series A" as unsupported).
  for (const line of renderSnapshot(snapshot).split("\n").filter(Boolean)) addFact(rf, "known", `What they've told Co: ${line}`);
  // What Co already sent them, and what its searches turned up, so "which
  // one?" and "are you actually searching?" are answerable (2026-09-16).
  for (const line of sent) addFact(rf, "did_before", line);
  for (const note of notes) addFact(rf, "did_before", note);

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

async function recentSearchNotes(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'system' AND content LIKE '[search]%' AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 5`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => String(r.content).replace("[search] ", ""));
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
export async function addOngoingSearchFacts(rf: ReplyFacts, userId: string): Promise<void> {
  const { rows } = await pool
    .query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 3`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  const asks = rows.map((r: any) => String(r.ask_text)).filter(Boolean);
  if (rf.facts.some((f) => f.kind === "ongoing")) return;
  if (asks.length) {
    addFact(
      rf,
      "ongoing",
      `Co's daily search is looking for: ${asks.map((a) => `"${a}"`).join("; ")}. If something real fits, Co may text them about it (at most one text a day). Co can't promise it will find anything, or when.`,
    );
  } else {
    addFact(rf, "unknown", "Co isn't searching for anything for them right now. Nothing will be looked for later unless they ask for something specific.");
  }
}

// Real fields only, plus the gaps stated as gaps so "I don't have that" is
// itself grounded.
export function addEventFacts(
  rf: ReplyFacts,
  match: { name: string; event_date?: string; deadline?: string; url?: string; kind?: string; details?: EventDetails; opportunity?: OpportunityDetails; whyItFits?: string },
): void {
  const label = match.kind === "opportunity" ? "Opportunity" : "Event";
  addFact(rf, "known", `${label} Co told them about: "${match.name}"${match.event_date ? `, on ${match.event_date}` : ""}${match.deadline ? `, application deadline ${match.deadline}` : ""}.`);
  addFact(rf, "known", match.url ? `Link for "${match.name}": ${match.url}` : `There is no link on file for "${match.name}".`);
  // The real record (event page or source post), so "tell me more" gets
  // real answers instead of "I don't have that".
  if (match.details) for (const line of renderEventDetails(match.name, match.details)) addFact(rf, "known", line);
  addFact(rf, "known", `Co found "${match.name}" through ${sourceOf(match)}. If they ask where it came from, say that.`);
  if (match.opportunity) addFact(rf, "known", `What the source post for "${match.name}" says: ${match.opportunity.postText}`);
  if (match.whyItFits) addFact(rf, "known", `Why "${match.name}" fits them: ${match.whyItFits}`);
  if (match.kind !== "opportunity") {
    const missing = missingEventDetails(match.name, match.details);
    if (missing) addFact(rf, "unknown", missing);
  }
}

export function renderReplyFacts(rf: ReplyFacts): string {
  const facts = rf.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  const instr = rf.instructions.length ? `\n\nFor this reply:\n${rf.instructions.map((i) => `- ${i}`).join("\n")}` : "";
  return `What's true right now. These, plus what's actually in the conversation, are the only actions, plans, links, times, places, numbers, and things about other people you can mention. If a detail isn't here, you don't have it: say so plainly, and don't promise to get it later.
${facts}${instr}`;
}

// ---------------------------------------------------------------------------
// Gate

export type Claim = {
  text: string;
  type: "past_action" | "future_promise" | "time" | "place" | "link" | "other_person" | "count" | "capability" | "detail" | "prediction";
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

function sourceText(rf: ReplyFacts, src: GroundingSources): string {
  return norm(
    [rf.facts.map((f) => f.text).join("\n"), src.recentConversation, src.contextSummary ?? "", src.recentMemories ?? "", src.message, ...(src.sentThisTurn ?? [])].join("\n"),
  );
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


export function codeChecks(draft: string, rf: ReplyFacts, src: GroundingSources): GateCheck[] {
  const emotionLabel = checkNoEmotionLabel(draft);
  const checks: GateCheck[] = [];
  const sources = sourceText(rf, src);
  const rawSources = [rf.facts.map((f) => f.text).join("\n"), src.recentConversation, src.contextSummary ?? "", src.recentMemories ?? "", src.message, ...(src.sentThisTurn ?? [])].join("\n");

  for (const url of draft.match(/https?:\/\/[^\s)]+/gi) ?? []) {
    const u = url.replace(/[.,!?]+$/, "");
    checks.push({ name: "link_on_file", pass: sources.includes(norm(u)), reason: `link ${u}` });
  }
  for (const phone of draft.match(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g) ?? []) {
    const digits = phone.replace(/\D/g, "");
    checks.push({ name: "phone_on_file", pass: rawSources.replace(/\D/g, "").includes(digits), reason: `phone number ${phone}` });
  }
  const knownTimes = new Set(clockTimes(rawSources));
  for (const t of clockTimes(draft)) {
    checks.push({ name: "time_on_file", pass: knownTimes.has(t), reason: `time ${t}` });
  }
  if (/\b((calling|ringing|dialing) you (right )?now|i'?m (calling|ringing|dialing) you|still (calling|ringing|dialing) you)\b/i.test(draft)) {
    checks.push({ name: "no_call_placed_claim", pass: false, reason: "says a call is happening, but this reply never places one" });
  }
  if (/\bI\s*(can(no|')?t|can not|am unable to|'?m unable to|don'?t|do not)\s+(actually\s+)?(make|place|do)?\s*(a\s+|phone\s+)*calls?\b|\bthis is (just )?(a )?text\b/i.test(draft)) {
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
  const inviteHandled = rf.facts.some((f) => /texted them an invite link|how many invites they have left|invites are used/i.test(f.text));
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
  const namesAnInvite = (draft.match(/[^.!?\n]+[.!?]*/g) ?? [draft]).some(
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
  if (found && !(ongoing && lookingOnly && !timingCommitment)) {
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

async function extractClaims(draft: string, rf: ReplyFacts, src: GroundingSources): Promise<{ claims: Claim[]; latencyMs: number } | null> {
  const started = Date.now();
  const facts = rf.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  const { text } = await generateText({
    model: anthropic(LAYER3_MODELS.grounding),
    maxOutputTokens: 2000,
    providerOptions: { anthropic: { effort: GROUNDING_EFFORT } },
    experimental_telemetry: { isEnabled: true, functionId: "reply.grounding.check" },
    prompt: `You check a text message Co is about to send, before it goes out. Find every claim in it that could be false, and say whether the sources below support it.

Claims to find:
- past_action: something Co says it did or sent ("I sent you the link", "I scheduled it", "I emailed you both"), including passing something along ("noted for the team", "that goes straight to the team", "I passed it on"): supported only if a FACT says it was saved for the team
- future_promise: something Co says it will do later ("I'll send it when I have it", "I'll keep an eye out", "I'll call you then")
- time, place, count, detail: a start time, date, address, neighborhood, headcount, format, host, price, or other specific about an event, program, or plan
- link: a link or an "it's in the link above"
- other_person: what another person said, wants, feels, or did ("she mentioned she'd like to meet you")
- capability: what Co can or can't do ("I can't call", "I don't have access to your calendar")
- prediction: what Co says will or won't happen in the world, or how likely it is, that Co has no way to know ("I don't think another one will turn up by Saturday", "it'll probably sell out", "nothing else is coming this week")

Don't list: opinions, feelings, questions, general encouragement, restating what they told Co, or how Co will talk in this conversation ("I'll keep it short", "switching back to normal caps", "let's keep going over text"). Also don't list general know-how and advice about how things usually go or what tends to work ("block parties live or die on people finding the spot", "a reminder a few days out helps turnout", "personal invites beat a mass email"): that's advice, not a claim about a specific event, person, or outcome (2026-09-22: flagging it as a prediction stripped the specifics out of Co's advice and left it generic). It still counts as a claim when it names a real venue, event, person, date, price, or number that isn't in the sources. Likewise a conclusion reasoned from the sources is advice, not a prediction: "if Oct 10 is less than 30 days out, the permit may not clear in time", when the sources give the 30-day rule and the date (2026-09-22: that reasoning about a member's own screenshot was being cut).

A claim is supported only if a FACT below states it, or the conversation shows it. A future_promise is supported only if a FACT says it will actually happen (a scheduled call, a pending item). A prediction is supported only if a FACT states that outcome itself; guessing from what was or wasn't found is never support. "I don't have X" is supported when X is not in the sources. Never count something as supported because it's plausible.

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
  const sources = sourceText(rf, src);
  const factIds = new Set(rf.facts.map((f) => f.id));
  return claims.map((c) => {
    let pass = c.supported;
    let reason = `${c.type}: "${c.text}"`;
    if (pass && c.type === "future_promise") {
      const cited = rf.facts.find((f) => f.id === c.factId);
      if (!cited || !["ongoing", "scheduled", "did_this_turn"].includes(cited.kind)) {
        pass = false;
        reason += " (a future action needs a real scheduled call or an open search behind it)";
      }
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

async function redraft(draft: string, failed: GateCheck[], rf: ReplyFacts, src: GroundingSources): Promise<string | null> {
  const tail = src.recentConversation.split("\n").slice(-14).join("\n");
  const { text } = await generateText({
    model: anthropic(LAYER3_MODELS.redraft),
    maxOutputTokens: 1000,
    providerOptions: { anthropic: { effort: GROUNDING_EFFORT } },
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

Rewrite the draft so it still responds to what they said, keeping everything that's supported. Fix or remove each unsupported part. If you don't have something they asked for, say it once, plainly, naming exactly what you don't have ("I don't have the start time"), then what you can do now if anything. If an unsupported part was about something you did (sent, saved, passed along, noted), say what's actually true the way a person would in a text ("Honestly, that one didn't get passed to the team."), never a system-sounding line like "I don't have that", and without promising anything in its place. Don't hedge, don't point them at a link instead, and don't promise to get it later. Match the draft's capitalization style. Same length or shorter. Return ONLY the message.`,
  });
  const out = text.trim().replace(/^"|"$/g, "");
  return out || null;
}

// Last resort: drop the sentences that carry an unsupported claim.
export function stripUnsupported(draft: string, failed: GateCheck[]): string {
  const sentences = draft.match(/[^.!?\n]+[.!?]*\s*/g) ?? [draft];
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
    if (failed.some((f) => f.name === "no_emotion_label") && !checkNoEmotionLabel(s).pass) return false;
    if (failed.some((f) => f.name === "no_followup_promise") && followupPromiseMatch(s)) return false;
    if (failed.some((f) => f.name === "no_prediction") && predictionMatch(s)) return false;
    if (failed.some((f) => f.name === "no_capability_denial") && /\b(can(no|')?t|unable to|this is (just )?text)\b/i.test(s)) return false;
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

export type GroundingResult = {
  final: string;
  outcome: "as_drafted" | "redrafted" | "stripped" | "unchecked";
  checks: GateCheck[];
  // Total grounding time for this message (checks + any redraft).
  latencyMs: number;
  // Just the first check: the added latency on a reply that passes as drafted.
  firstCheckMs: number;
};

// Claims nothing, and reads like a person (2026-09-18: "I don't have that, so
// I'd rather not guess." answered "is it noted to the team?").
const MINIMAL_FALLBACK = "Honestly, I'm not sure on that one.";
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
];

export function needsClaimCheck(draft: string): boolean {
  return CLAIM_SHAPED.some((re) => re.test(draft));
}

// One retry before giving up on a claim-shaped draft (2026-09-17 code
// review): a single bad JSON response or a transient failure used to send
// the draft "unchecked," with only the cheap regex checks behind it.
async function check(draft: string, rf: ReplyFacts, src: GroundingSources): Promise<{ checks: GateCheck[]; modelOk: boolean; ms: number }> {
  const code = codeChecks(draft, rf, src);
  if (!needsClaimCheck(draft)) return { checks: [...code, { name: "claim_read", pass: true, reason: "nothing claim-shaped, model read skipped" }], modelOk: true, ms: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const extracted = await extractClaims(draft, rf, src);
      if (extracted) return { checks: [...code, ...claimChecks(extracted.claims, rf, src)], modelOk: true, ms: extracted.latencyMs };
      console.error(`replyGrounding: claim check returned unusable JSON on attempt ${attempt}${attempt === 1 ? ", retrying once" : ""}`);
    } catch (err: any) {
      console.error(`replyGrounding: claim check failed on attempt ${attempt}${attempt === 1 ? ", retrying once" : " (non-fatal, giving up)"}:`, err?.message ?? err);
    }
  }
  return { checks: code, modelOk: false, ms: 0 };
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
  const draft = cleanCoMessage(rawDraft);
  const first = await check(draft, rf, src);
  const firstCheckMs = Date.now() - started;
  let result: GroundingResult;
  const failed1 = first.checks.filter((c) => !c.pass);
  // A claim-shaped draft whose claim read failed twice is treated as a
  // failed check, not sent as "unchecked" on code checks alone (2026-09-17
  // code review) — it goes through the same redraft-then-strip path below.
  const effectiveFailed1 = claimReadUnavailable(draft, first) ? [...failed1, CLAIM_READ_FAILED_CHECK] : failed1;

  if (!effectiveFailed1.length) {
    result = { final: draft, outcome: "as_drafted", checks: first.checks, latencyMs: Date.now() - started, firstCheckMs };
  } else {
    let second: { checks: GateCheck[]; modelOk: boolean } | null = null;
    let rewritten: string | null = null;
    try {
      rewritten = await redraft(draft, effectiveFailed1, rf, src);
      if (rewritten) {
        rewritten = cleanCoMessage(rewritten);
        second = await check(rewritten, rf, src);
      }
    } catch (err: any) {
      console.error("replyGrounding: redraft failed (non-fatal, stripping instead):", err?.message ?? err);
    }
    const secondFailed = second
      ? claimReadUnavailable(rewritten ?? "", second)
        ? [...second.checks.filter((c) => !c.pass), CLAIM_READ_FAILED_CHECK]
        : second.checks.filter((c) => !c.pass)
      : null;
    if (rewritten && second && secondFailed && !secondFailed.length) {
      result = { final: rewritten, outcome: "redrafted", checks: [...first.checks, ...second.checks.map((c) => ({ ...c, name: `redraft.${c.name}` }))], latencyMs: Date.now() - started, firstCheckMs };
    } else {
      // The redraft can fail its OWN check too (2026-09-17 code review: a
      // "checked already" past-action claim got redrafted into an
      // unsupported "let me check... one sec" future promise instead of
      // being fixed). That used to mean stripping only the redraft,
      // discarding the original draft's other, still-good sentences
      // entirely — a real, grounded detail sitting right there in the
      // original never got a chance because the redraft replaced it with a
      // single bad sentence that then stripped to nothing. Strip BOTH
      // candidates and keep whichever actually has real content left; only
      // the minimal fallback if neither does.
      // Strip with what EITHER check caught (2026-09-23): the redraft's check
      // flagged "Nothing's changed on my end that I'd call an upgrade", the
      // first check had missed it, and the original draft still carried it,
      // so stripping the original by the first check's failures alone sent
      // it anyway. The two checks read the same kind of text; a claim one of
      // them rejects is out of both.
      const allFailed = [...effectiveFailed1, ...(secondFailed ?? [])];
      const strippedOriginal = stripUnsupported(draft, allFailed);
      const strippedRedraft = rewritten && second ? stripUnsupported(rewritten, allFailed) : "";
      const originalWords = strippedOriginal.split(/\s+/).filter(Boolean).length;
      const redraftWords = strippedRedraft.split(/\s+/).filter(Boolean).length;
      // Prefer whichever survives with more real content; the original
      // draft had the reply agent's full context, so ties favor it.
      const stripped = redraftWords > originalWords ? strippedRedraft : strippedOriginal;
      result = {
        // The invite line only helps when the invite claim is what was cut
        // from the text that actually survived — and never when they've just
        // been told they have none left (2026-09-20 code review).
        final: (() => {
          const keptRedraft = redraftWords > originalWords;
          const failedForKept = allFailed;
          void keptRedraft;
          const enough = stripped.split(/\s+/).filter(Boolean).length >= 3;
          if (failedForKept.some((c) => c.name === "no_invite_sent_claim") && !rf.facts.some((f) => /invites are used/i.test(f.text))) {
            return [enough && !/invite/i.test(stripped) ? stripped : "", INVITE_FALLBACK].filter(Boolean).join(" ");
          }
          return enough ? stripped : MINIMAL_FALLBACK;
        })(),
        outcome: "stripped",
        checks: [...first.checks, ...(second?.checks ?? []).map((c) => ({ ...c, name: `redraft.${c.name}` }))],
        latencyMs: Date.now() - started,
        firstCheckMs,
      };
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
