// Grounding for calls (Royce, 2026-09-15: "Calls themselves aren't grounded.
// On a Hume call, Co's words go straight to the person").
//
// Hume speaks as it generates, so a call can't be gated sentence by sentence
// the way a text is (that would need routing the call's language model
// through our server). What this does instead, right after every call:
//
//   audit    — a Sonnet read of everything Co said, against what Co actually
//              had going into the call (the context summary, its standing
//              capabilities, open asks) and what the person said on the call
//   act      — a promise Co can keep ("I'll look for designers after we hang
//              up") is kept: it becomes a saved ask so the search really
//              runs. A claim or promise Co can't back is recorded as a
//              correction, tied to the call (services/callKey.ts). The call's
//              own follow-up text carries it once (jobs/postCallFollowUp.ts,
//              Royce 2026-10-29: "Once Cue gets the transcript it needs to
//              analyze what it said previously and correct itself"), and it is
//              marked delivered; one that didn't ride (the follow-up skipped,
//              held past its life or cancelled) stays a fact for the next text
//              reply so Co corrects it plainly if it comes up
//   record   — call.grounding in the decision log; monitoring alerts on
//              spikes (harness/monitor.ts)
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { captureIntentForTurn } from "../services/profileExtraction.js";
import { writeMemory } from "../services/memory.js";
import { recordDecision, type GateCheck } from "./core.js";
import { callKey } from "../services/callKey.js";
import { ABILITIES, LIMITS } from "../services/capabilities.js";
import { memberRecordText, overlap, sameCallCommitment, sameCommitment, significant, specificsIn, specificsOnRecord } from "../services/followThrough.js";
import { wordsAreTheirs } from "../services/coTasks.js";
import type { MemberKnowledge } from "../services/memberKnowledge.js";
import { plainCorrected } from "../services/memberKnowledge.js";
import { DateTime } from "luxon";
import { claimKind, itemWords, namesItem } from "../services/callClaims.js";
import { foundLines, type DoneItem, type FoundOnCall } from "../services/callLedger.js";

export type CallClaim = {
  quote: string;
  type: "promise_keepable" | "promise_unkeepable" | "invented_fact" | "capability" | "ok";
  what: string; // for keepable promises: what to look for; otherwise a short note
  // capability: the registry line that covers the claim, if one does, and the can't line it breaks (2026-10-08)
  ability?: string | null;
  limit?: string | null;
  // promise_keepable: the member's own words on the call that asked for it, or null when Co offered it on its own
  asked_quote?: string | null;
  // invented_fact: the exact names, places, times or numbers that had no source
  specifics?: string[] | null;
  // Set by code, never by the audit: a sentence the call's offer source check flagged (services/offerGuard.ts unsourcedInCall).
  source?: "offer_source";
};

// What Co can truthfully promise or claim on a call, beyond the registry: a call is spoken, so these are the call's own limits.
// 2026-10-08: the old line said Co can't know "people's intentions it wasn't given", with nothing about Co's own events, and
// the audit read "I can learn who's coming, who each person is trying to meet" (Co's in-room guest-list matching, its core
// product) as a false capability claim. The registry (services/capabilities.ts) is now the source; these only add to it.
export const CALL_CAPABILITIES = `Cue can: look for events, communities, opportunities, and people after a call and text them if something real fits (never a guaranteed result or time); take on work over days that they asked for and text what it finds; call them back if they ask; text them.
Cue can't: promise when something will be found or a guaranteed result, or know a detail it wasn't given (a time, a place, what someone outside its own events wants). At Noise's own events it does know the guest list and what each guest told Cue they're looking for.`;
const CALL_ONLY_LIMITS = [
  "On a call, Cue can't promise when something will be found, or a guaranteed result.",
  "Cue can't know a detail it wasn't given (a time, a place, what someone outside its own events wants). At Noise's own events it does know the guest list and what each guest told Cue they're looking for.",
];

// The registry, as the audit reads it: what Co can do by id, and what it can't by number (team-only abilities left out).
export function auditRegistry(): { abilities: { id: string; can: string }[]; limits: string[] } {
  return {
    abilities: ABILITIES.filter((a) => !a.teamOnly).map((a) => ({ id: a.id, can: a.can })),
    limits: [...LIMITS, ...CALL_ONLY_LIMITS],
  };
}

// What Co had going into the call, for the audit, from the shared member-knowledge layer (services/memberKnowledge.ts, PR 7 of the
// migration): the same goals with state, open asks, delivered items, corrections and claims every other path reads, so a call is
// fact-checked against the same truth a text is. The call picture (services/callContext.ts buildCallKnowledge) still adds what the
// layer doesn't carry: the page details on file for what was sent, Co's ledger lines, and its impressions (last calls, recap,
// threads). Facts back a specific; impressions only help read the call.
export const AUDIT_SECTIONS = ["goals", "asks", "delivered", "corrections", "claims"] as const;

// Pure: claims a correction hasn't overturned. Enduring claims never expire, so "Lives in Denver" outlives a Denver -> Austin
// correction unless it's dropped here: any claim holding a corrected-away value (case-insensitive) is gone.
export function uncorrectedClaims<C extends { text: string; quote?: string | null }>(claims: C[], corrections: { was: string }[]): C[] {
  // Whole words or phrases only: an "SF" correction must never drop "Is transferring teams".
  const was = corrections
    .map((c) => c.was.trim())
    .filter((w) => w.length >= 2)
    .map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu"));
  if (!was.length) return claims;
  return claims.filter((c) => {
    const t = `${c.text} ${c.quote ?? ""}`;
    return !was.some((w) => w.test(t));
  });
}

// Pure: the day a claim was said, as the member's local date it already is ("2026-10-05" -> "Oct 5"), never shifted through UTC.
export const saidDay = (saidOn: string): string => {
  const d = DateTime.fromISO(String(saidOn).slice(0, 10), { zone: "utc" });
  return d.isValid ? d.toFormat("LLL d") : String(saidOn);
};
const ASK_LINE = /^They've asked (?:Co|Cue) for \(their words\): /;
export function knownBeforeFrom(
  k: Pick<MemberKnowledge, "goals" | "asks" | "delivered" | "corrections" | "claims" | "identity"> | null,
  picture: { facts: string; impressions: string },
): { facts: string; impressions: string } {
  if (!k) return { facts: picture.facts, impressions: picture.impressions };
  const day = (at: string) => DateTime.fromISO(at).setZone(k.identity.timeZone).toFormat("LLL d");
  // Asks come from the layer now; the picture's copy of the same rows is dropped so each ask is listed once.
  // A claim holding a value they corrected away is never on record (enduring claims never expire on their own).
  const claims = uncorrectedClaims(k.claims, k.corrections);
  const pictureFacts = picture.facts.split("\n").filter((l) => l.trim() && !ASK_LINE.test(l));
  const facts = [
    ...pictureFacts,
    ...k.asks.slice(0, 8).map((a) => `They've asked Cue for (their words): "${a.text}"`),
    ...k.delivered.slice(0, 12).map((d) => `Cue sent them ${d.kind === "document" ? "the document " : ""}"${d.what}"${d.url ? ` (${d.url})` : ""} on ${day(d.at)}.`),
    // The corrected version only: an old value is never "on record" (it's the one thing that must still be caught if Co said it).
    ...k.corrections.map((c) => {
      const v = plainCorrected(c.now);
      if (!c.now) return `They corrected their ${c.field}; what Cue had no longer holds.`;
      return v.settled ? `They corrected their ${c.field} to "${v.text}", and that goal is ${v.settled === "done" ? "done" : "set aside"} now (history, not current).` : `They corrected their ${c.field}: it's "${c.now}" now.`;
    }),
    ...claims.filter((c) => c.provenance === "user_said").map((c) => `They said (${saidDay(c.saidOn)}): ${c.text}${c.quote ? ` ("${c.quote}")` : ""}`),
  ];
  const goals = k.goals.length
    ? `Their goals in Cue's notes (only active ones are where they're headed; done or stale ones are history):\n${k.goals.map((g) => `- ${g.text} (${g.state})`).join("\n")}`
    : null;
  const inferred = claims.filter((c) => c.provenance === "co_inferred").map((c) => `- ${c.text}`);
  const impressions = [picture.impressions, goals, inferred.length ? `Cue's own read of them (never something they said):\n${inferred.join("\n")}` : null].filter((x): x is string => !!x && !!x.trim());
  return { facts: facts.join("\n"), impressions: impressions.join("\n\n") };
}

// impressions (2026-09-28, the facts-vs-hints rule on the text side,
// replyGrounding.ts addHint): summaries and read-outs Co's own models wrote
// going into the call. They help read the call, but they're never proof of a
// specific time, place, count, or what another person said, wants or did.
export function callAuditPrompt(transcript: string, knownBefore: string, impressions?: string, doneOnCall: (string | DoneItem)[] = [], foundOnCall: FoundOnCall[] = []): string {
  const reg = auditRegistry();
  return `Audit what Cue said on a phone call. Cue can only claim things it actually knew and only promise things it can actually do.

What Cue can do (its capability registry, by id; this is the truth about Cue, whatever any other line says):
${reg.abilities.map((a) => `[${a.id}] ${a.can}`).join("\n")}

What Cue can't do (by number):
${reg.limits.map((l, i) => `L${i + 1} ${l}`).join("\n")}

In short, on a call:
${CALL_CAPABILITIES}

What Cue knew going into the call (facts):
${knownBefore || "(nothing)"}

What Cue did DURING the call with its own tools (each came back done, so it's true; services/callLedger.ts):
${doneOnCall.length ? doneOnCall.map((d) => `- ${typeof d === "string" ? d : d.label}`).join("\n") : "(nothing)"}
A line where Cue says it did something on the call (sent, texted, saved, set up, started) is "ok" only when it's in this list; when it isn't, it's "invented_fact" (put what it claimed in "specifics"). What's in this list is done: never a promise to keep.
${foundOnCall.length ? `
What Cue's searches found DURING the call (real listings; services/callLedger.ts). Cue naming one of these, or saying its day, time or place as listed here, is "ok", never "invented_fact":
${foundLines(foundOnCall).map((l) => `- ${l}`).join("\n")}
` : ""}${impressions?.trim() ? `
Cue's own impressions going in (summaries its models wrote). Use these to understand the call, never as proof: a specific time, place, count, link, or what another person said, wants or did that only an impression backs is "invented_fact". What the person themself said in these recent texts is fine to rely on.
${impressions.slice(0, 6000)}
` : ""}
Call transcript ("assistant" is Cue):
${transcript.slice(-12000)}

List every statement by Cue ("assistant" lines only) that is a promise of a future action, a specific fact about an event, a person, or a place, or a claim about what Cue can do. For each:
- "promise_keepable": a promise to look for something, keep an eye out, or do work, after the call, and text what it finds, with no guaranteed result or time. Casual ones count the same: "you'll hear from me", "I'm on it", "I'll keep an ear out for the right moment", "leave it with me". Put what to do in "what", specific enough to act on from the call (what to look for, for what, by when if said). In "asked_quote", copy the person's exact words from a "user" line that asked for it (a request, or their yes to Cue's offer together with what it answered); null only when Cue offered it on its own and they never asked.
- "promise_unkeepable": any other promise (a time, a guaranteed result, booking, contacting someone for them).
- "invented_fact": a specific fact not in what Cue knew or what the person said on the call. In "specifics", list the exact names, places, times or numbers that had no source.
- "capability": a claim about what Cue can or can't do that the registry above contradicts. In "limit", the number of the can't line it breaks ("L3"). If a registry line says Cue does it, it is "ok", not "capability"; put that line's id in "ability".
- "ok": supported by the facts Cue knew, what the person said, or the registry. Leave these out of the list: only the other types are used.

Return ONLY JSON: {"claims": [{"quote": "Cue's exact words", "type": "...", "what": "...", "ability": "id or null", "limit": "L# or null", "asked_quote": "their exact words or null", "specifics": []}]}`;
}

export function callAuditChecks(claims: CallClaim[]): GateCheck[] {
  return claims
    .filter((c) => c.type !== "ok")
    .map((c) => ({
      name: `call_${c.type}`,
      pass: c.type === "promise_keepable",
      reason: `"${c.quote.slice(0, 140)}"${c.what ? ` (${c.what.slice(0, 100)})` : ""}`,
    }));
}

// Fixed 2026-09-17: every keepable promise got saved as `user: ${what}` via
// captureIntentForTurn regardless of who actually raised it — a promise Co
// volunteered on its own ("I'll look into events for you while we're at it")
// became a saved ask the person never made. Only save it as their ask when
// their own words on the call actually asked for something like it.
const GROUNDING_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "for", "with", "on", "at",
  "their", "his", "her", "my", "more", "other", "if", "something", "real",
  "fits", "after", "we", "hang", "up", "you", "your", "it", "that", "this",
]);
function significantWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !GROUNDING_STOPWORDS.has(w));
}

// Exported for evals — whether the person's own lines on this call actually
// asked for something like `what`, by simple word overlap (same tool
// mergeProfileList's nearDuplicate uses elsewhere, just checked against the
// transcript instead of another list item).
export function personAskedForThis(transcript: string, what: string): boolean {
  const userLines = transcript
    .split("\n")
    .filter((l) => /^user:/i.test(l.trim()))
    .map((l) => l.replace(/^user:\s*/i, ""))
    .join(" ")
    .toLowerCase();
  if (!userLines.trim()) return false;
  const words = significantWords(what);
  if (!words.length) return false;
  const hits = words.filter((w) => userLines.includes(w)).length;
  return hits / words.length >= 0.34;
}

// Runs the same search a member's own ask gets, keyed as Co's promise so the
// offer never says they asked for it (fromProfile). Records what came of it,
// so the post-call text can say plainly when nothing turned up.
export async function keepCallPromise(userId: string, what: string, transcript?: string): Promise<"queued" | "nothing"> {
  const { rows } = await pool.query(
    `SELECT u.first_name, u.phone_number, cp.city, cp.goals, cp.activity_preferences
     FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const p = rows[0];
  if (!p?.phone_number) return "nothing";
  const { attemptEventSurfacing, PROMISE_ASK_PREFIX } = await import("../services/eventSurfacingSweep.js");
  const key = what.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  const { queued, fed } = await attemptEventSurfacing({
    askId: `${PROMISE_ASK_PREFIX}${key}`,
    userId,
    firstName: p.first_name,
    phoneNumber: p.phone_number,
    askText: what,
    fromProfile: true,
    city: p.city ?? null,
    goals: p.goals ?? null,
    activityPreferences: p.activity_preferences ?? null,
    cooldownCleared: true,
  });
  // A find fed to the pool gets the picker now, not at the next sweep (review, 2026-10-13: "a find from noon never waits until tomorrow").
  if (fed) await import("../services/sweepShadow.js").then((S) => S.runPickerAfterSweep(userId, "call")).catch((err: any) => console.error("picker after a call promise failed (non-fatal):", err?.message ?? err));
  const result = queued || fed
    ? `Looked into "${what}" after the call, as Cue said it would, and found something; ${fed ? "Cue's daily pick decides whether it goes out" : "it's queued to send"}.`
    : `Looked into "${what}" after the call, as Cue said it would, and found nothing good enough to send yet.`;
  await writeMemory(userId, "promise_result", result).catch(() => null);
  // Tied to this call, so this call's after-call text is the one that
  // reports it (services/callKey.ts).
  if (transcript) {
    await pool
      .query(`INSERT INTO call_promise_results (user_id, call_key, content) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [userId, callKey(transcript), result])
      .catch((err: any) => console.error("callGrounding: promise result write failed (non-fatal):", err?.message ?? err));
    // Only the after-call text reads these, within two days: older rows go.
    pool.query(`DELETE FROM call_promise_results WHERE created_at < NOW() - INTERVAL '14 days'`).catch(() => {});
  }
  return queued || fed ? "queued" : "nothing";
}

// ---- what the audit's verdicts are held to before anything is saved (2026-10-08 call review)

const userLinesOf = (transcript: string) =>
  transcript.split("\n").filter((l) => /^\s*user\s*:/i.test(l)).map((l) => l.replace(/^\s*user\s*:\s*/i, ""));

// Pure: a capability "correction" is saved only when the registry backs it: it names a real can't line it breaks, and no
// registry line says Co does it (by the id the audit gave, or by the claim's own words matching an ability more closely than
// any limit). A correction feeds every later call and text, so a false one teaches Co to deny what it really does.
export function capabilityCorrectionVerdict(c: Pick<CallClaim, "quote" | "what" | "ability" | "limit">, reg = auditRegistry()): { save: boolean; why: string } {
  const named = typeof c.ability === "string" ? reg.abilities.find((a) => a.id === c.ability!.trim()) : undefined;
  if (named) return { save: false, why: `the registry has it: [${named.id}]` };
  const words = significant(c.quote).length;
  if (words >= 3) {
    const best = reg.abilities.map((a) => ({ id: a.id, o: overlap(c.quote, a.can) })).sort((x, y) => y.o - x.o)[0];
    const worstLimit = Math.max(0, ...reg.limits.map((l) => overlap(c.quote, l)));
    if (best && best.o >= 0.5 && best.o > worstLimit) return { save: false, why: `the registry has it: [${best.id}] matches what Cue said` };
  }
  const n = Number(String(c.limit ?? "").match(/^\s*L?(\d+)\s*$/i)?.[1] ?? NaN);
  if (!Number.isInteger(n) || n < 1 || n > reg.limits.length) return { save: false, why: "it names no can't line in the registry that it breaks" };
  // The line it cites has to be about what Co said: a limit that shares nothing with the claim or its note isn't the one it breaks.
  if (overlap(`${c.quote} ${c.what ?? ""}`, reg.limits[n - 1]) === 0) return { save: false, why: `the can't line it cites (L${n}) isn't about what Cue said` };
  return { save: true, why: `breaks L${n}: ${reg.limits[n - 1].slice(0, 120)}` };
}

// Pure: an "invented" fact whose every unsourced specific is in the member's own texts or Co's records wasn't invented.
// Sources on the call are the member's own lines and what Co knew going in; Co having said it earlier on the call is not one.
export function inventedFactVerdict(c: Pick<CallClaim, "quote" | "specifics">, transcript: string, knownBefore: string, records: string): { save: boolean; why: string; onRecord: string[] } {
  const flagged = Array.isArray(c.specifics) && c.specifics.some((x) => typeof x === "string" && x.trim()) ? c.specifics.filter((x): x is string => typeof x === "string") : specificsIn(c.quote);
  const r = specificsOnRecord(flagged, `${userLinesOf(transcript).join("\n")}\n${knownBefore}`, records);
  if (r.backed) return { save: false, why: `on record in their texts or Cue's records: ${r.onRecord.join(", ")}`, onRecord: r.onRecord };
  return { save: true, why: r.unbacked.length ? `no source for: ${r.unbacked.join(", ")}` : "kept as the audit judged it", onRecord: r.onRecord };
}

// Pure: the member's own words that asked for a promise. The audit's quote counts only when it is really in their lines; else
// the user turn just before Co's promise (or the one before that) when it asks Co for something.
const ASKING = /\b(?:can you|could you|would you|will you|i (?:actually |really )?(?:want|need|would love|'d love|'d like) (?:you|for you|co|cue)|i want (?:co|cue)|please|go ahead|take (?:the )?lead|start (?:planning|drafting|putting)|send me|text me|put together|draft)\b/i;
export function askedQuoteFor(c: Pick<CallClaim, "quote" | "asked_quote">, transcript: string): string | null {
  const theirs = userLinesOf(transcript);
  const q = typeof c.asked_quote === "string" ? c.asked_quote.trim() : "";
  if (q && wordsAreTheirs(q, theirs.join("\n"))) return q;
  const lines = transcript.split("\n");
  const key = c.quote.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
  const at = lines.findIndex((l) => /^\s*assistant\s*:/i.test(l) && l.toLowerCase().replace(/\s+/g, " ").includes(key));
  if (at < 0) return null;
  let seen = 0;
  for (let i = at - 1; i >= 0 && seen < 2; i--) {
    if (!/^\s*user\s*:/i.test(lines[i])) continue;
    seen++;
    const line = lines[i].replace(/^\s*user\s*:\s*/i, "").trim();
    if (ASKING.test(line)) return line;
  }
  return null;
}

export type OpenCallTask = { id: number; goal: string; theirWords: string; createdAt: string };
export type PlannedPromise = { what: string; quotes: string[]; asked: string | null; coveredBy: number | null };
export type AuditPlan = {
  corrections: CallClaim[];
  refused: { quote: string; type: CallClaim["type"]; why: string }[];
  promises: PlannedPromise[];
};

// Pure: what the audit's claims become. Same-call promises that are one commitment (the same words of theirs, or the same
// thing said again) are one promise; a promise an open task from this call already carries is that task's, not a new search.
// Pure: within one call, two promises about the same subject: they share two words that say what it is (caterer, photographer),
// not the words every promise on the call shares (look, text, options, the event's name and month). One plan said three ways
// came back as a task, an ask and a thread when the wording drifted (2026-10-08, #113).
const GENERIC = new Set(["look", "find", "search", "text", "send", "option", "thing", "worth", "turn", "come", "keep", "eye", "watch", "open", "hous", "event", "week", "day", "next", "few", "good", "qualiti", "price", "range", "feel", "jordan", "real", "someth", "anyth", "over", "dinner", "parti", "night", "januari", "februari", "march", "april", "may", "june", "juli", "august", "septemb", "octob", "novemb", "decemb"]);
export function sameSubject(a: string, b: string): boolean {
  const A = significant(a).filter((w) => !GENERIC.has(w) && w.length > 3);
  const B = new Set(significant(b).filter((w) => !GENERIC.has(w) && w.length > 3));
  return A.filter((w) => B.has(w)).length >= 2;
}

// Cue saying it did something (sent, texted, saved, set up, started), as done.
const DID_CLAIM = /\b(?:i(?:'ve| have)?\s+(?:just\s+|already\s+)?(?:sent|texted|shared|saved|added|set\s+(?:it|that|this|you)\s+up|started|dropped|noted|put)\b|(?:just|already)\s+(?:sent|texted|saved)\b|it'?s\s+(?:in your texts|been sent|saved|set up)\b)/i;
// Pure: a claim of having done something that a tool really did on this call (services/callLedger.ts): kept as said, never a
// correction. The claim has to name what was done (its link, its name, or most of its own words; one shared word is not enough),
// and a "texted / sent / in your texts" claim has to match something that really texted them. A bare "just sent it" matches only
// when exactly one such thing was done. No match stays the audit's (the "said it did" check).
const toItem = (d: string | DoneItem): DoneItem => (typeof d === "string" ? { kind: "", label: d, names: [], urls: [] } : d);
// The words every claim of doing shares: never what makes it about one item.
const CLAIM_WORDS = new Set(significant("just already sent texted text texts shot dropped popped put shared saved added set started noted link links your you it that this them those over the a to in on up for now check got done way all both thing things stuff place spot one ones".replace(/\s+/g, " ")));
function distinctive(x: string): string[] {
  return significant(x).filter((w) => !CLAIM_WORDS.has(w) && !GENERIC.has(w));
}
function claimNames(quote: string, d: DoneItem): boolean {
  if (d.urls.some((u) => quote.includes(u))) return true;
  if (d.names.some((n) => namesItem(quote, n))) return true;
  const label = distinctive(d.label);
  const said = new Set(distinctive(quote));
  const shared = label.filter((w) => said.has(w)).length;
  return shared >= 2 || (label.length > 0 && label.length <= 2 && shared === label.length);
}
// Pure: the one done item a claim's own word belongs to ("the jazz link" when only Rooftop Jazz Night has "jazz"): every distinctive
// word the claim shares with the done items points at that same single item, and at least one does.
// A word the claim has that no done item has ("the rooftop bar list") means it's about something else: no match.
function uniqueWordMatch(quote: string, pool: DoneItem[]): DoneItem | undefined {
  const said = itemWords(quote);
  const owners = said.map((w) => pool.filter((d) => itemWords(`${d.label} ${d.names.join(" ")}`).includes(w)));
  if (!owners.length || owners.some((o) => o.length !== 1)) return undefined;
  const first = owners[0][0];
  return owners.every((o) => o[0] === first) ? first : undefined;
}
export function doneOnCallVerdict(quote: string, doneOnCall: (string | DoneItem)[]): { done: boolean; why: string } {
  const q = quote.replace(/[’‘]/g, "'");
  if (!doneOnCall.length || !DID_CLAIM.test(q)) return { done: false, why: "" };
  const items = doneOnCall.map(toItem);
  const kind = claimKind(q, true);
  const sendClaim = kind === "sent" || kind === "location" || kind === "arrival" || /\b(?:sent|texted|shot|messaged)\b/i.test(q);
  const pool = sendClaim ? items.filter((d) => d.kind === "send") : items;
  const hit = pool.find((d) => claimNames(q, d)) ?? uniqueWordMatch(q, pool) ?? (pool.length === 1 && !distinctive(q).length ? pool[0] : undefined);
  return hit ? { done: true, why: `done on the call: ${hit.label.slice(0, 140)}` } : { done: false, why: "" };
}
// Pure: a promise that something Cue did on this call already covers: about the same thing by its name or words, and a promise to
// text something is covered only by something that texted them.
export function promiseDoneOnCall(p: { what: string; quotes: string[] }, doneOnCall: (string | DoneItem)[]): string | null {
  const text = `${p.what} ${p.quotes.join(" ")}`;
  const sendPromise = /\b(?:text|send|link|share|shoot|forward)\w*\b/i.test(text);
  const pool = doneOnCall.map(toItem).filter((d) => !sendPromise || d.kind === "send");
  return (pool.find((d) => claimNames(text, d) || sameSubject(p.what, d.label)) ?? (sendPromise ? uniqueWordMatch(p.what, pool) : undefined))?.label ?? null;
}

// A sentence the call's offer source check flagged (services/offerGuard.ts unsourcedInCall): an event, place or time it named that
// nothing the call was given backs.
export type OfferFlag = { sentence: string; names: string[] };

// Pure: the offer source check's flags, as corrections. A sentence the audit already listed is the audit's (once, whatever it
// judged); the rest are held to the same record check an invented fact is (their texts and Cue's records can back a name the call's
// own context didn't carry), so a real find is never "taken back".
const plainWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const sameSentence = (quote: string, f: OfferFlag) => {
  const Q = plainWords(quote), S = plainWords(f.sentence);
  if (!Q || !S) return false;
  if (Q.includes(S) || S.includes(Q)) return true;
  // The audit quoted it its own way: the same sentence when it carries every name the check flagged.
  const names = (f.names ?? []).map((n) => plainWords(String(n))).filter(Boolean);
  return names.length > 0 && names.every((n) => Q.includes(n));
};
export function offerSourceCorrections(flags: OfferFlag[], audited: Pick<CallClaim, "quote">[], transcript: string, knownBefore: string, records: string, done: (string | DoneItem)[] = [], found: FoundOnCall[] = []): { corrections: CallClaim[]; refused: AuditPlan["refused"] } {
  const corrections: CallClaim[] = [];
  const refused: AuditPlan["refused"] = [];
  for (const f of flags) {
    if (!f || typeof f.sentence !== "string" || !f.sentence.trim()) continue;
    if ([...audited, ...corrections].some((c) => sameSentence(c.quote, f))) continue;
    const names = (Array.isArray(f.names) ? f.names : []).filter((x): x is string => typeof x === "string" && !!x.trim());
    const c: CallClaim = { quote: f.sentence.trim().slice(0, 240), type: "invented_fact", what: `named ${names.join(", ") || "something"} with nothing behind it`, specifics: names, source: "offer_source" };
    // The check can't see what Cue's tools did or found mid-call: a name that's in the done list was real.
    const covered = correctionDoneOnCall(c, done, found);
    if (covered) {
      refused.push({ quote: c.quote, type: c.type, why: `offer source check: ${covered}` });
      continue;
    }
    const v = inventedFactVerdict(c, transcript, knownBefore, records);
    v.save ? corrections.push(c) : refused.push({ quote: c.quote, type: c.type, why: `offer source check: ${v.why}` });
  }
  return { corrections, refused };
}

// Pure: a done line as the check reads it. #320's send labels name the item and its link ("the link to <name> (<url>)", a deck's
// 'the link to their deck "<title>" (<url>)', a name or a link with parentheses of its own), a nameless one is "the link <url>", and an
// owed link that went right after the call is "sent the link <url> right after the call". Any other line is matched by its words only.
export function doneItemFromLine(line: string): DoneItem {
  const send = line.match(/\bthe link to\s+(?:their\s+\w+\s+)?["“]?(.+?)["”]?\s*\((https?:\/\/\S+?)\)\s*$/i);
  if (send) return { kind: "send", label: line, names: [send[1].trim()], urls: [send[2]] };
  const bare = line.match(/\b(?:sent\s+)?the link\s+(https?:\/\/\S+)/i);
  if (bare) return { kind: "send", label: line, names: [], urls: [bare[1].replace(/[).,;]+$/, "")] };
  return { kind: "", label: line, names: [], urls: [] };
}

// Words that never make a correction about one particular thing: days, months, times of day, places a city-wide claim names, and
// the kinds of event every listing shares ("mixer", "dinner", "night"). Whole words only.
const NOT_DISTINCT = new Set(
  `the a an and or of at in on for with to from by its it's your you my our their this that these those first last next new
  monday tuesday wednesday thursday friday saturday sunday mondays tuesdays wednesdays thursdays fridays saturdays sundays
  january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec
  today tonight tomorrow weekend week morning afternoon evening night nights noon midnight am pm
  san francisco sf oakland berkeley bay area la los angeles nyc new york brooklyn manhattan austin chicago seattle boston denver miami london city downtown
  mixer mixers dinner dinners supper brunch lunch breakfast party parties social club meetup meetups event events show shows gathering festival fest market
  happy hour session sessions talk talks panel workshop launch night's live music thing things one place spot`.split(/\s+/).filter(Boolean),
);
function findWords(s: string): string[] {
  return [...new Set(String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "").replace(/'s$/, "")))]
    .filter((w) => w.length >= 2 && !NOT_DISTINCT.has(w) && !/^\d+(?:am|pm)?$/.test(w));
}
// The kinds of event a name can carry: never what names it, but a different kind is a different thing ("Founders Dinner" is not the
// "Founders Breakfast" that was sent, #320's F6).
const EVENT_KINDS = new Set("mixer mixers dinner dinners supper brunch lunch breakfast party parties social meetup meetups gathering festival fest market happy hour session sessions talk talks panel workshop launch night nights".split(" "));
const kindsIn = (s: string) => new Set(String(s ?? "").toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/).filter((w) => EVENT_KINDS.has(w)));
const plainUrl = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/)\].,;]+$/, "");
// Pure: the correction names this thing: most of its distinctive words are in what Cue said (or in one specific the audit flagged),
// about 60% or more, whole words. A thing with no distinctive word ("Mixer", "San Francisco Startup Mixer" minus the city and kind)
// is never named by words alone; a day, a time, a city or a kind of event never counts.
function namesThing(said: string, specifics: string[], name: string): boolean {
  const want = findWords(name);
  if (!want.length) return false;
  const theirKinds = kindsIn(name);
  const saidKinds = kindsIn(`${said} ${specifics.join(" ")}`);
  if (theirKinds.size && saidKinds.size && ![...saidKinds].some((k) => theirKinds.has(k))) return false;
  const covers = (text: string) => {
    const have = new Set(findWords(text));
    return want.filter((w) => have.has(w)).length / want.length >= 0.6;
  };
  return covers(said) || specifics.some(covers);
}
// Pure: the days and times a correction states, as plain tokens ("friday", "8pm"), to hold against what a find lists.
function whenTokens(text: string): string[] {
  const t = String(text ?? "").toLowerCase();
  const days = [...t.matchAll(/\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b/g)].map((m) => `${m[1]}day`);
  const times = [...t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/g)].map((m) => `${m[1]}${m[2] && m[2] !== "00" ? `:${m[2]}` : ""}${m[3]}m`);
  return [...new Set([...days, ...times])];
}

// Pure: why a correction is about something Cue really did or found on the call, or null (joint review F1, 2026-10-29; round 2).
// A claim of having done it that the done list backs (doneOnCallVerdict); a correction that names a sent item or a find from a search
// on the call by its link (with or without its scheme) or by most of its distinctive words (namesThing). A find whose listing has a
// day or time excuses only a correction whose days and times are all in it: "Rooftop Jazz Night is Saturday" when it is listed for
// Friday is a real mistake, still corrected. Never "correct" something Cue actually did or found; never excuse an invented thing on
// one shared word.
export function correctionDoneOnCall(c: { quote: string; specifics?: string[] | null }, done: (string | DoneItem)[], found: FoundOnCall[] = []): string | null {
  if (!done.length && !found.length) return null;
  const items = done.map((x) => (typeof x === "string" ? doneItemFromLine(x) : x.names.length || x.urls.length ? x : { ...doneItemFromLine(x.label), kind: x.kind || doneItemFromLine(x.label).kind }));
  const v = doneOnCallVerdict(c.quote, items);
  if (v.done) return v.why;
  const specifics = (Array.isArray(c.specifics) ? c.specifics : []).filter((x): x is string => typeof x === "string" && !!x.trim());
  const said = `${c.quote} ${specifics.join(" ")}`;
  const flat = plainUrl(said);
  const links = (url: string) => !!url && flat.includes(plainUrl(url));
  for (const d of items) if (d.urls.some(links) || d.names.some((n) => namesThing(c.quote, specifics, n))) return `done on the call: ${d.label.slice(0, 140)}`;
  for (const f of found) {
    if (!links(f.url) && !namesThing(c.quote, specifics, f.name)) continue;
    const listed = `${f.when ?? ""} ${f.venue ?? ""}`;
    const stated = whenTokens(said);
    if (f.when && stated.length) {
      const have = new Set(whenTokens(listed.replace(/(\d{1,2}):00\s*([AP])M/gi, "$1$2M")));
      if (stated.some((t) => !have.has(t))) continue; // a day or time it isn't listed for: a real mistake about a real find
    }
    return `found on the call: ${f.name.slice(0, 140)}`;
  }
  return null;
}

export function planCallAudit(claims: CallClaim[], transcript: string, ctx: { knownBefore: string; records: string; tasks: OpenCallTask[]; doneOnCall?: (string | DoneItem)[]; foundOnCall?: FoundOnCall[]; offerFlags?: OfferFlag[] }): AuditPlan {
  const reg = auditRegistry();
  const corrections: CallClaim[] = [];
  const refused: AuditPlan["refused"] = [];
  const done = ctx.doneOnCall ?? [];
  for (const c of claims) {
    const d = c.type === "invented_fact" || c.type === "capability" || c.type === "promise_unkeepable" ? doneOnCallVerdict(c.quote, done) : { done: false, why: "" };
    if (d.done) {
      refused.push({ quote: c.quote, type: c.type, why: d.why });
      continue;
    }
    // Never a correction about something Cue's tools sent or its searches found on the call (by its name or link).
    const covered = c.type === "invented_fact" || c.type === "capability" || c.type === "promise_unkeepable" ? correctionDoneOnCall(c, done, ctx.foundOnCall ?? []) : null;
    if (covered) {
      refused.push({ quote: c.quote, type: c.type, why: covered });
      continue;
    }
    if (c.type === "capability") {
      const v = capabilityCorrectionVerdict(c, reg);
      v.save ? corrections.push(c) : refused.push({ quote: c.quote, type: c.type, why: v.why });
    } else if (c.type === "invented_fact") {
      const v = inventedFactVerdict(c, transcript, ctx.knownBefore, ctx.records);
      v.save ? corrections.push(c) : refused.push({ quote: c.quote, type: c.type, why: v.why });
    } else if (c.type === "promise_unkeepable") corrections.push(c);
  }
  if (ctx.offerFlags?.length) {
    const o = offerSourceCorrections(ctx.offerFlags, claims, transcript, ctx.knownBefore, ctx.records, done, ctx.foundOnCall ?? []);
    corrections.push(...o.corrections);
    refused.push(...o.refused);
  }
  const groups: { what: string; quotes: string[]; asked: string | null }[] = [];
  for (const c of claims.filter((x) => x.type === "promise_keepable" && x.what)) {
    // Already done with a tool on the call: nothing to keep, nothing opens.
    const doneBy = promiseDoneOnCall({ what: c.what, quotes: [c.quote] }, done);
    if (doneBy) {
      refused.push({ quote: c.quote, type: c.type, why: `done on the call: ${doneBy.slice(0, 140)}` });
      continue;
    }
    const asked = askedQuoteFor(c, transcript);
    // One call, so the looser same-call bar (followThrough.ts sameCallCommitment): one plan said three ways is one promise
    // (2026-10-08, #113: the caterer/photographer commitment came back as a task, an ask and a second thread).
    const g = groups.find((x) => (asked && x.asked && sameCommitment({ theirWords: asked }, { theirWords: x.asked })) || sameCallCommitment({ goal: c.what }, { goal: x.what }) || sameSubject(c.what, x.what) || overlap(`${c.what} ${c.quote}`, `${x.what} ${x.quotes.join(" ")}`) >= 0.5);
    if (g) {
      g.quotes.push(c.quote);
      g.asked = g.asked ?? asked;
    } else groups.push({ what: c.what, quotes: [c.quote], asked });
  }
  const promises = groups.map((g) => {
    const t = ctx.tasks.find((t) => sameCallCommitment({ goal: g.what, theirWords: g.asked }, t) || sameSubject(g.what, t.goal) || g.quotes.some((q) => sameCommitment({ goal: q }, t)));
    return { ...g, coveredBy: t ? t.id : null };
  });
  return { corrections, refused, promises };
}

// Open work tasks opened in the last few hours: the ones a call's promises may already be carried by.
async function recentOpenTasks(userId: string): Promise<OpenCallTask[]> {
  const { openTasks } = await import("../services/coTasks.js");
  const since = Date.now() - 3 * 3_600_000;
  return (await openTasks(userId)).filter((t) => new Date(t.createdAt).getTime() > since).map((t) => ({ id: t.id, goal: t.goal, theirWords: t.theirWords, createdAt: t.createdAt }));
}

// Pure: the task a promise Co made on its own becomes. Its words are Co's, so the task says so; their last line rides along.
// Its own prefix: "Keep your word from the call: " is a send due right after the call (callCommitments.ts), checked within the hour.
export const PROMISE_THREAD_PREFIX = "Keep an eye out, as promised on a call: ";
export function promiseThreadTask(p: Pick<PlannedPromise, "what" | "quotes">, theirBefore: string) {
  return {
    goal: `${PROMISE_THREAD_PREFIX}${p.what.trim().replace(/\.$/, "")}`.slice(0, 200),
    theirWords: theirBefore.trim() ? theirBefore.trim().slice(0, 400) : "(said on a call)",
    steps: [{ text: "Look for it the way you'd look for their own ask, and text only when something real turns up" }],
    firstPlan: `You said on a call: "${p.quotes[0]?.slice(0, 160) ?? p.what}". Keep it: look now, and keep looking over the next days. Text only when you have something real.`,
    inHours: 6,
    source: "lookout" as const,
    // Co's own promise: its finds count toward backoff like sweep finds (Royce, 2026-10-09).
    lookoutOrigin: "co" as const,
  };
}

// Pure: a look-out that names another member of Co (by the names linked to this member) is never opened.
export function namesAMember(what: string, names: string[]): boolean {
  return names.some((n) => n && new RegExp(`\\b${n.split(/[^\w]+/).filter(Boolean).join("[-\\s]?")}\\b`, "i").test(what));
}

// Pure: what the member said just before Co made the promise (the "user" line before the first "assistant" line that carries
// its words), never their last line of the call, which is usually a goodbye (review of #113).
export function theirLineBefore(transcript: string, quote: string): string {
  const lines = transcript.split("\n");
  const probe = quote.trim().slice(0, 50).toLowerCase();
  const at = probe ? lines.findIndex((l) => /^\s*(?:assistant|agent)\s*:/i.test(l) && l.toLowerCase().includes(probe)) : -1;
  for (let i = (at < 0 ? lines.length : at) - 1; i >= 0; i--) if (/^\s*user\s*:/i.test(lines[i])) return lines[i].replace(/^\s*user\s*:\s*/i, "");
  return "";
}

// Pure: what a planned promise opens after the call. Every keepable promise opens something; "none" only at the cap, where the
// call was told not to promise (services/callContext.ts capacity line) and the one search still runs.
export function promiseOpens(p: Pick<PlannedPromise, "coveredBy" | "asked">): "task_from_call" | "their_ask" | "promise_thread" {
  return p.coveredBy ? "task_from_call" : p.asked ? "their_ask" : "promise_thread";
}

async function openPromiseThread(userId: string, p: PlannedPromise, transcript: string): Promise<"opened" | "blocked" | "failed"> {
  const { startTask } = await import("../services/coTasks.js");
  // Never a look-out that names another member (the same guard as a text reply's promise, services/promises.ts trackPromise).
  const { linkedMemberNames } = await import("../services/memberSafeMemories.js");
  // A failed lookup blocks it: no names meant no check.
  const names = await linkedMemberNames(userId).catch(() => null);
  if (!names || namesAMember(p.what, names)) return "blocked";
  const t = promiseThreadTask(p, theirLineBefore(transcript, p.quotes[0] ?? ""));
  const r = await startTask({ userId, ...t });
  const result = r.ok
    ? `Cue said on the call it would keep an eye out for "${p.what}". It's open as task #${r.task.id}: Cue keeps looking and texts when something real turns up.`
    : null;
  if (result) {
    await writeMemory(userId, "promise_result", result).catch(() => null);
    await pool
      .query(`INSERT INTO call_promise_results (user_id, call_key, content) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [userId, callKey(transcript), result])
      .catch(() => null);
  }
  return r.ok ? "opened" : "failed";
}

// dryRun: reads only (the member's texts, records and open tasks) and returns the plan; nothing is written or searched.
// claims: use these instead of asking the model (a replay of a call's recorded audit).
export async function auditCall(
  userId: string,
  transcript: string,
  knownBefore: string | { facts: string; impressions: string },
  // doneOnCall: what Cue's tools did on the call (services/callLedger.ts); foundOnCall: what its searches found on it; offerFlags: the
  // call's offer source check (services/offerGuard.ts unsourcedInCall), held to the record and done checks before any is saved.
  // correctionsHeld: why no correction may be written for this call (its done list couldn't be read, so a real send or find could be
  // "taken back"); the promises are still kept.
  opts: { dryRun?: boolean; claims?: CallClaim[]; tasks?: OpenCallTask[]; doneOnCall?: DoneItem[]; foundOnCall?: FoundOnCall[]; offerFlags?: OfferFlag[]; correctionsHeld?: string } = {},
): Promise<AuditPlan | null> {
  const facts = typeof knownBefore === "string" ? knownBefore : knownBefore.facts;
  const impressions = typeof knownBefore === "string" ? undefined : knownBefore.impressions;
  try {
    let claims = opts.claims;
    if (!claims) {
      const { text } = await generateText({
        model: anthropic(MODELS.sonnet),
        providerOptions: { anthropic: { effort: "low" } },
        experimental_telemetry: { isEnabled: true, functionId: "call.grounding.audit" },
        // A long call's claims ran past the default and the JSON came back cut off, so the whole audit, every promise with it, was
        // lost (2026-10-08, #113). "ok" statements are no longer listed, and there is room for the rest.
        maxOutputTokens: 8000,
        prompt: callAuditPrompt(transcript, facts, impressions, opts.doneOnCall ?? [], opts.foundOnCall ?? []),
      });
      claims = parseModelJson<{ claims?: CallClaim[] }>(text).claims ?? [];
    }
    // source is code's mark (the offer source check's), never the audit's.
    claims = claims.filter((c) => c && typeof c.quote === "string").map(({ source: _code, ...c }) => c);
    const checks = callAuditChecks(claims);
    const [records, tasks] = await Promise.all([
      memberRecordText(userId).catch(() => ""),
      opts.tasks ? Promise.resolve(opts.tasks) : recentOpenTasks(userId).catch(() => [] as OpenCallTask[]),
    ]);
    const plan = planCallAudit(claims, transcript, { knownBefore: `${facts}\n${impressions ?? ""}`, records, tasks, doneOnCall: opts.doneOnCall ?? [], foundOnCall: opts.foundOnCall ?? [], offerFlags: opts.offerFlags });
    if (opts.dryRun) return plan;

    // Keep the promises Co can keep, once per commitment. Carried by a task already open from this call: that task is the
    // promise, so nothing else opens or searches. Asked for in their own words: their ask. Otherwise Co's own note, and a look.
    for (const p of plan.promises) {
      const c = { what: p.what };
      if (p.coveredBy) {
        await writeMemory(
          userId,
          "system",
          `Cue promised on a call: "${c.what}". ${p.asked ? `They asked for it in their own words ("${p.asked.slice(0, 160)}")` : "Cue offered it on its own"}; task #${p.coveredBy} is carrying it.`,
        ).catch(() => null);
      } else if (p.asked) {
        await captureIntentForTurn(userId, `user: ${c.what}`, { timeoutMs: 6000 }).catch(() => null);
      } else {
        await writeMemory(
          userId,
          "system",
          `Cue promised on a call to look into: "${c.what}" — Cue's own initiative, not something the person actually asked for.`,
        ).catch(() => null);
        // A real thread, not one search (#113: "you'll hear from me" has to open something that keeps going): a promise task Co
        // owns, woken daily, texting only when it has something real. If none can open (at the cap), the one search still runs.
        const opened = await openPromiseThread(userId, p, transcript).catch(() => "failed" as const);
        if (opened === "failed") {
          // And actually look (2026-09-23: "I'll dig into those communities
          // and text you" was only ever written down, so nothing searched).
          await keepCallPromise(userId, c.what, transcript).catch((err: any) =>
            console.error("callGrounding: keepCallPromise failed (non-fatal):", err?.message ?? err),
          );
        }
      }
    }
    // Remember what needs correcting: only what survived the registry and record checks. Tied to this call (call_key), so this
    // call's follow-up text is the one that carries it (jobs/postCallFollowUp.ts); else the next text reply, if it comes up.
    // Held (the done list unread): none is written, and the record says why.
    const corrections = plan.corrections;
    for (const c of opts.correctionsHeld ? [] : corrections) {
      const specifics = Array.isArray(c.specifics) ? c.specifics.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 8).map((x) => x.slice(0, 120)) : [];
      await writeMemory(userId, "call_correction", JSON.stringify({ quote: c.quote.slice(0, 200), type: c.type, note: c.what?.slice(0, 200) ?? null, call_key: callKey(transcript), ...(c.source ? { source: c.source } : {}), ...(specifics.length ? { specifics } : {}) }));
    }

    await recordDecision({
      layer: 8,
      decision: "call.grounding",
      userId,
      outcome: corrections.length ? "skip" : "act",
      action: corrections.length ? (opts.correctionsHeld ? "corrections_held" : "corrections_recorded") : "grounded",
      proposal: { claims, refused: plan.refused, promises: plan.promises },
      checks: [
        ...checks,
        ...corrections.filter((c) => c.source === "offer_source").map((c) => ({ name: "call_offer_unsourced", pass: false, reason: `"${c.quote.slice(0, 140)}" (${(c.what ?? "").slice(0, 100)})` })),
        ...plan.refused.map((r) => ({ name: `call_${r.type}_refused`, pass: true, reason: `"${r.quote.slice(0, 140)}" not saved: ${r.why.slice(0, 160)}` })),
      ],
      reason: corrections.length ? `${corrections.length} unsupported statement(s) on the call${opts.correctionsHeld ? `; none written: ${opts.correctionsHeld}` : ""}` : null,
    });
    return plan;
  } catch (err: any) {
    console.error("auditCall failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

// Corrections from calls in the last week, for the next text reply. A retired row (the follow-up found it was about something Cue
// really did or found on the call) never feeds one. One the call's follow-up text was drafted with (delivered_at)
// is still there: nothing confirms the text's words took it back (joint review F9, 2026-10-29), so it says the text was meant to, and
// Cue never stands by it and corrects it plainly if it comes up.
export async function recentCallCorrections(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_correction' AND created_at > NOW() - INTERVAL '7 days' AND content NOT LIKE '%"retired_at":%' ORDER BY created_at DESC LIMIT 3`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows
    .map((r: any) => {
      try {
        const c = JSON.parse(r.content);
        if (c.delivered_at) return `On a recent call Cue said "${c.quote}", which ${correctionWhy(c.type)}. Cue's text after that call was meant to take it back: never stand by it, and if it comes up, correct it plainly.`;
        return `On a recent call Cue said "${c.quote}", which ${c.type === "invented_fact" ? "wasn't based on anything Cue actually knew" : c.type === "capability" ? "isn't true about what Cue can do" : "is a promise Cue can't keep"}${c.note ? ` (${c.note})` : ""}. If it comes up, correct it plainly.`;
      } catch {
        return null;
      }
    })
    .filter((x): x is string => !!x);
}

// ---------------------------------------------------------------- the call's follow-up text corrects it (Royce, 2026-10-29)

const correctionWhy = (type: string) => (type === "invented_fact" ? "wasn't based on anything Cue actually knew" : type === "capability" ? "isn't true about what Cue can do" : "is a promise Cue can't keep");

export type CallCorrection = { id: string; quote: string; type: "invented_fact" | "capability" | "promise_unkeepable"; note: string | null; callKey: string | null; source: "audit" | "offer_source"; deliveredAt: string | null; specifics?: string[]; retiredAt?: string | null };

// Pure: one call_correction row, as written by auditCall. Anything else (an older row without its call, a broken one) is null.
export function parseCallCorrection(row: { id: unknown; content: unknown }): CallCorrection | null {
  try {
    const c = JSON.parse(String(row.content));
    if (!c || typeof c.quote !== "string" || !c.quote.trim()) return null;
    if (!["invented_fact", "capability", "promise_unkeepable"].includes(c.type)) return null;
    return { id: String(row.id), quote: c.quote, type: c.type, note: typeof c.note === "string" && c.note.trim() ? c.note : null, callKey: typeof c.call_key === "string" ? c.call_key : null, source: c.source === "offer_source" ? "offer_source" : "audit", deliveredAt: typeof c.delivered_at === "string" ? c.delivered_at : null, specifics: Array.isArray(c.specifics) ? c.specifics.filter((x: unknown): x is string => typeof x === "string") : [], retiredAt: typeof c.retired_at === "string" ? c.retired_at : null };
  } catch {
    return null;
  }
}

// Pure: a promise Cue couldn't keep that has since been kept (a done task, something they now have) is no longer a mistake to take
// back. Only promises: an invented fact or a capability claim stays wrong whatever was done since.
export function keptSince(c: Pick<CallCorrection, "type" | "quote" | "note">, kept: string[]): boolean {
  if (c.type !== "promise_unkeepable") return false;
  const about = `${c.note ?? ""} ${c.quote}`;
  return kept.some((k) => !!k && (sameSubject(about, k) || overlap(about, k) >= 0.5));
}

// Pure: what the follow-up may carry. Only this call's corrections (its key), not yet delivered, not kept since; a promise only when
// what was kept could be read (kept null: unknown, so it waits for the next text); never one about something Cue did or found on the
// call (correctionDoneOnCall; the done list unread, none); and only when the member fence leaves the line
// whole (a line naming someone else never rides). Oldest first, at most two: a correction is a line, never a list.
export const FOLLOW_UP_CORRECTIONS_MAX = 2;
export function correctionsToCarry(rows: CallCorrection[], key: string, kept: string[] | null, strip: ((s: string) => string | null) | null, done: { items: (string | DoneItem)[]; found: FoundOnCall[] } | null): CallCorrection[] {
  return planCarry(rows, key, kept, strip, done).carry;
}
// Pure: the carry, and the rows to retire: this call's rows about something Cue really did or found on it, which no text, the
// follow-up or a reply, may ever "correct" (recentCallCorrections skips them).
export function planCarry(rows: CallCorrection[], key: string, kept: string[] | null, strip: ((s: string) => string | null) | null, done: { items: (string | DoneItem)[]; found: FoundOnCall[] } | null): { carry: CallCorrection[]; retire: { id: string; why: string }[] } {
  // The done list unread: nothing can be checked against it, so nothing rides (it waits for the next text) and nothing is retired.
  if (!done) return { carry: [], retire: [] };
  const mine = rows.filter((c) => c.callKey === key && !c.deliveredAt && !c.retiredAt);
  const retire = mine.flatMap((c) => {
    const why = correctionDoneOnCall({ quote: c.quote, specifics: c.specifics }, done.items, done.found);
    return why ? [{ id: c.id, why }] : [];
  });
  if (!strip) return { carry: [], retire };
  const whole = (s: string | null) => s === null || strip(s) === s;
  const carry = mine
    .filter((c) => !retire.some((r) => r.id === c.id))
    .filter((c) => (c.type === "promise_unkeepable" ? kept !== null && !keptSince(c, kept) : true))
    .filter((c) => whole(c.quote) && whole(c.note))
    .slice(0, FOLLOW_UP_CORRECTIONS_MAX);
  return { carry, retire };
}

// Pure: a correction as the follow-up's draft reads it: Cue's own words from the call and why they don't hold, from the audit row
// only (never anything the draft could take as true).
export function correctionFact(c: Pick<CallCorrection, "quote" | "type" | "note">): string {
  const why = c.type === "invented_fact" ? "you had nothing behind it" : c.type === "capability" ? "it isn't true about what you can do" : "it's a promise you can't keep";
  return `On the call you said "${c.quote}", but ${why}${c.note ? ` (${c.note})` : ""}`;
}

// This call's corrections, from the audit's rows (the last week, as the reply path reads them).
export async function callCorrectionsFor(userId: string, transcript: string): Promise<CallCorrection[]> {
  const key = callKey(transcript);
  const { rows } = await pool.query(
    `SELECT id, content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_correction' AND created_at > NOW() - INTERVAL '7 days' AND content LIKE $2 ORDER BY created_at`,
    [userId, `%"call_key":"${key}"%`],
  );
  return rows.map(parseCallCorrection).filter((c: CallCorrection | null): c is CallCorrection => !!c && c.callKey === key);
}

// A row the follow-up found was about something Cue really did or found on the call: retired, so no text ever "corrects" it.
export async function retireCallCorrections(userId: string, retire: { id: string; why: string }[], at = new Date()): Promise<number> {
  if (!retire.length) return 0;
  const { rows } = await pool.query(`SELECT id, content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_correction' AND id::text = ANY($2::text[])`, [userId, retire.map((r) => r.id)]);
  let n = 0;
  for (const r of rows) {
    try {
      const c = JSON.parse(String(r.content));
      if (!c || typeof c !== "object" || c.retired_at) continue;
      const why = retire.find((x) => x.id === String(r.id))?.why ?? "";
      await pool.query(`UPDATE co_memories SET content = $3 WHERE id = $1 AND user_id = $2 AND memory_type = 'call_correction'`, [r.id, userId, JSON.stringify({ ...c, retired_at: at.toISOString(), retired_why: why.slice(0, 160) })]);
      n++;
    } catch {
      continue;
    }
  }
  return n;
}

// Pure: the row's content with when its follow-up carried it.
export function deliveredContent(content: string, at: Date): string | null {
  try {
    const c = JSON.parse(content);
    if (!c || typeof c !== "object") return null;
    return JSON.stringify({ ...c, delivered_at: c.delivered_at ?? at.toISOString() });
  } catch {
    return null;
  }
}

// After the follow-up drafted with them went: marked delivered, so the next text knows that text was meant to take them back (and
// never brings them up on its own). Their own rows only.
export async function markCallCorrectionsDelivered(userId: string, ids: string[], at = new Date()): Promise<number> {
  if (!ids.length) return 0;
  const { rows } = await pool.query(`SELECT id, content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_correction' AND id::text = ANY($2::text[])`, [userId, ids]);
  let n = 0;
  for (const r of rows) {
    const next = deliveredContent(String(r.content), at);
    if (!next || next === r.content) continue;
    await pool.query(`UPDATE co_memories SET content = $3 WHERE id = $1 AND user_id = $2 AND memory_type = 'call_correction'`, [r.id, userId, next]);
    n++;
  }
  return n;
}
