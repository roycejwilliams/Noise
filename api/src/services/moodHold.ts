// A hard day decides when, never whether (Royce, 2026-10-18: "The situation decides what Cue looks for and which helpers run. What we
// know about a member shapes how, never which helper." For the holds that read how they feel, option (a): "timing only, with the
// cap. A check-in in the middle of a bad week can land wrong, and the cap stops it from being skipped forever. The risk is Cue
// guessing a member's mood wrong and waiting too long."). And the older rule: feelings shape how Cue says it, never whether a member
// gets events or people.
// These places held something while they were struggling (harness/emotion.ts needsCare), with nothing to end the hold but the read
// clearing:
//   checkin_hold      the check-ins and nudges in harness/proactive.ts HOLD_WHILE_STRUGGLING (the emotional_timing check);
//   stop_note_hold    the stopped-looking line (services/askRetire.ts): in a reply (harness/replyGrounding.ts) and riding a paced
//                     text (noteMayRide in proactive.ts dispatch);
//   bundle_skip_wait  a find the bundle composer skipped in the prompt that sees how they feel (harness/bundleComposer.ts): it was
//                     dropped (a lead, or a morning tier pick skipped twice) or offered again into the same read.
//   recap_hold        the offer of a one-page recap after a call (jobs/postCallFollowUp.ts recapOfferFor): a hard time or a heavy
//                     call blocked it, and it rode only the post-call text, so it never came back for that call (Royce, 2026-10-19:
//                     "feelings change timing and tone, never cancel"). Now it's held for that call and goes on its own, gently.
// Each one now waits and is never dropped for a mood read: it goes once they're okay again (the read clears, or they text normally),
// and at the latest MOOD_HOLD_CAP_HOURS after the hard stretch began, whatever the read says then. What goes then is drafted the way
// it always is, from the same feeling read, so a hard week still shapes how it's said. Only the send waits: searches, plans and
// memory carry on (none of these is a sweep blocker), and a held item still expires on its own clock (an event that passed, a
// deadline gone): the cap never extends it.
// Safety holds are not mood and are not here (services/safety.ts; proactive.ts safety_hold, safetyFollowUp).
import { RIGHT_NOW_HOURS, type EmotionalContext } from "../harness/emotion.js";

// 48 hours, one value for every hold here. needsCare lasts a day after the last hard read, so a hold reaches the cap only after at least
// two days of hard reads. Shorter than 72 because the check-ins it holds that expire soonest (calendar_follow, goal_recheck) live 3
// days from when they're queued: at 72 a held one could run out on its own clock before the cap let it go.
export const MOOD_HOLD_CAP_HOURS = 48;
// "They text normally": a text from them at least this long after the last hard read, which the read didn't mark hard (every text is
// read; a hard one would itself be the last hard read). The same window the emotion read counts as how they feel right now, so a
// "thanks" right after hard news doesn't count.
export const OKAY_AFTER_HOURS = RIGHT_NOW_HOURS;

export type MoodRule = "checkin_hold" | "stop_note_hold" | "bundle_skip_wait" | "heavy_offer_hold" | "recap_hold" | "draft_skip_wait" | "frustration_hold";
// The feeling-based holds this module rules on, and Royce's ruling on each (pinned in evals/proactive/moodHolds.ts). Not every
// place a feeling read decides whether something runs: FEELING_PICKS_NOT_CHANGED lists the others found, documented, not changed.
// test: the layer 1 file that proves it waits, never cancels (evals/proactive/moodNeverCancels.ts checks each is registered).
export const MOOD_RULES: Record<MoodRule, { where: string; ruling: string; test: string }> = {
  checkin_hold: { where: "harness/proactive.ts HOLD_WHILE_STRUGGLING (emotional_timing)", ruling: "timing only, capped (Royce 2026-10-18, option a)", test: "evals/proactive/moodHolds.ts" },
  stop_note_hold: { where: "harness/replyGrounding.ts stopNote, proactive.ts noteMayRide", ruling: "timing only, capped (Royce 2026-10-18, option a)", test: "evals/proactive/moodHolds.ts" },
  bundle_skip_wait: { where: "harness/proactive.ts composer skips (moodSkipAt, mood_wait)", ruling: "timing only, capped (Royce 2026-10-18, option a)", test: "evals/proactive/moodHolds.ts" },
  // Royce, 2026-10-19: "feelings change timing and tone, never cancel." The door, the cold-start question and a document offer in a
  // heavy moment wait for a later reply, at most the cap (harness/replyGrounding.ts heavyHold).
  // The document offer's own gate (services/documentOffer.ts offerGate, #260) waits on the same cap (offerMoodHeld): the offerDocument
  // tool's re-check and any caller without the reply's moment; the notice stays owed. One log rule: a reply logs it here.
  heavy_offer_hold: { where: "harness/replyGrounding.ts heavyMoment -> heavyHold (door, cold-start steer, document offer moment); services/documentOffer.ts offerGate (offerMoodHeld)", ruling: "timing only, capped (Royce 2026-10-19)", test: "evals/proactive/moodHeavyOffers.ts" },
  recap_hold: { where: "jobs/postCallFollowUp.ts recapOfferFor, holdRecapForMood; harness/proactive.ts recapWaitRead (recap_mood_wait)", ruling: "timing only, capped (Royce 2026-10-19: feelings change timing and tone, never cancel)", test: "evals/calls/recapMoodHold.ts" },
  // Royce, 2026-10-19: "feelings change timing and tone, never cancel." A draft that saw the feeling and chose SKIP while they're
  // struggling waits once (moodDraftSkipAt, mood_draft_wait) and is written again later, the feeling as tone only.
  draft_skip_wait: { where: "harness/proactive.ts drafting (feelingForDraft) -> a model SKIP while struggling waits once (moodDraftSkipAt, mood_draft_wait)", ruling: "timing only, capped (Royce 2026-10-19)", test: "evals/proactive/moodDraftSkips.ts" },
  // Frustration with Cue holds the door and the cold-start question for one capped wait per item, measured from the first frustration
  // read since the item was owed (harness/replyGrounding.ts frustrationHold).
  frustration_hold: { where: "harness/replyGrounding.ts frustrated (door, cold-start steer) -> frustrationHold", ruling: "timing only, capped (Royce 2026-10-19)", test: "evals/proactive/moodFrustration.ts" },
};

// Other places a feeling read decides whether something runs (review of #253). Documented only, not changed here: each needs Royce.
export const FEELING_PICKS_NOT_CHANGED: { where: string; what: string; status: string }[] = [
];

// Model-facing guidance, never a line handed to the member: what waited for a hard stretch goes gently when it's released (early or at
// the cap). The door, the cold-start question and a document offer in a reply (harness/replyGrounding.ts); the same idea as the document
// offer's own line (#260).
export const GENTLE_AFTER_HARD = "They've had a hard stretch lately and this waited for it: bring it up gently, in one soft line that's easy to pass on, never a push, and only if this message feels okay for it.";
// The one fixed line for the last path where a SKIP beside a hard day could still drop something (harness/proactive.ts
// moodFallbackDecision): an item that used its one wait and whose draft says SKIP again while they're still struggling. Approved by Royce
// 2026-10-19 (option A, PR #261). Word for word; never changed without his yes.
export const MOOD_FALLBACK_LINE = "No rush on anything. I'm around whenever you want to pick things back up.";
// The ledger key prefix (the stretch's start is the rest of the key). Once a stretch is read from the ledger, not the key: no second
// fallback while they haven't been okay since the last one (harness/proactive.ts okaySinceFallback).
export const MOOD_FALLBACK_KEY = "mood_fallback:";
// Pure: the log line for a fallback sent in an item's place. The rule, the kind, ids; never member text.
export function moodFallbackLogLine(o: { kind: string; ref: string }): string {
  return `mood hold: rule=draft_skip_wait kind=${o.kind} ref=${o.ref} the approved fallback line went in its place`;
}

// none: not struggling; held: it waits; released_okay: struggling by the read, but they've texted normally since; released_cap: the
// hard stretch reached the cap.
export type MoodHoldState = "none" | "held" | "released_okay" | "released_cap";
export type MoodHold = { state: MoodHoldState; hold: boolean; heldHours: number | null };
const HOUR = 3_600_000;

// Pure: whether a hard day holds what waits on it now. lastInboundAt: their last text or call (a timestamp only). In a reply turn it's
// now: the message being answered, whose feeling the read already holds.
export function moodHold(e: Pick<EmotionalContext, "needsCare" | "hardAt" | "hardSince"> | null | undefined, o: { now: Date; lastInboundAt: Date | null }): MoodHold {
  if (!e?.needsCare) return { state: "none", hold: false, heldHours: null };
  const since = e.hardSince ?? e.hardAt ?? null;
  const heldHours = since ? Math.max(0, (o.now.getTime() - since.getTime()) / HOUR) : null;
  if (e.hardAt && o.lastInboundAt && o.lastInboundAt.getTime() - e.hardAt.getTime() >= OKAY_AFTER_HOURS * HOUR) return { state: "released_okay", hold: false, heldHours };
  if (heldHours !== null && heldHours >= MOOD_HOLD_CAP_HOURS) return { state: "released_cap", hold: false, heldHours };
  return { state: "held", hold: true, heldHours };
}

// Pure: the log line. The rule, the kind, a reference (ids, never words), the state and how long the hard stretch has run. Never
// member text.
export function moodHoldLine(o: { rule: MoodRule; kind: string; ref: string; state: MoodHoldState | "released_cleared"; heldHours: number | null }): string {
  const what = o.state === "held" ? "held" : o.state === "released_okay" ? "released: they texted normally" : o.state === "released_cap" ? `released: the ${MOOD_HOLD_CAP_HOURS}h cap` : "released: the read cleared";
  return `mood hold: rule=${o.rule} kind=${o.kind} ref=${o.ref} ${what}${o.heldHours !== null ? ` (hard stretch ${Math.round(o.heldHours)}h)` : ""}`;
}

// Each hold and release logged once (dispatch looks every 30 minutes; a reply reads it every turn), not every look.
const seen = new Map<string, MoodHoldState>();
export function noteMoodHold(rule: MoodRule, kind: string, ref: string, read: MoodHold, log: (line: string) => void = console.log): string | null {
  const key = `${rule}|${ref}`;
  const prev = seen.get(key);
  let line: string | null = null;
  if (read.state === "none") {
    if (prev === "held") line = moodHoldLine({ rule, kind, ref, state: "released_cleared", heldHours: read.heldHours });
    seen.delete(key);
  } else if (prev !== read.state) {
    line = moodHoldLine({ rule, kind, ref, state: read.state, heldHours: read.heldHours });
    if (seen.size > 5_000) seen.clear();
    seen.set(key, read.state);
  }
  if (line) log(line);
  return line;
}
// The held recap's own text (jobs/postCallFollowUp.ts HELD_RECAP_TASK): approved by Royce, 2026-10-19, with his SKIP addition ("If the
// member has since texted about something else, SKIP."). While false, a released held recap stayed pending, never drafted or sent
// (harness/proactive.ts awaiting_prompt_approval). A code constant: no env switch.
export const HELD_RECAP_APPROVED: boolean = true;

// Tests only.
export function resetMoodHoldLog(): void {
  seen.clear();
}
