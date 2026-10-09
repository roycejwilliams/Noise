import pool from "../db/db.js";
import { buildContextSummary } from "../services/callContext.js";
import { enqueueCandidate, draftProactive, type OutputRules } from "../harness/proactive.js";
import { callKey } from "../services/callKey.js";
import { RECAP_OFFER_RULE } from "../services/documentOffer.js";
import { DateTime } from "luxon";
import { KINDS } from "../services/factLabels.js";
import { memberKnowledge, memberRules, type MemberKnowledge } from "../services/memberKnowledge.js";
import { localStamp } from "../services/memberTime.js";
import { saidDay, uncorrectedClaims } from "../harness/callGrounding.js";

// Relationship text after a call: one real thought from what they said.
//
// Layer 7 (2026-09-14): the old job waited a random 2h-2d, then sent on its
// own, and live that meant four texts in one 9-second burst, 3-5 days late.
// Now each call becomes a "post_call" candidate due right away (the harness
// holds it for local hours and caps) that expires 24 hours after the call:
// past that, a "kept thinking about what you said" text reads as scripted,
// so it's skipped instead of sent late.
const POST_CALL_EXPIRY_HOURS = 24;

export async function enqueueDuePostCallFollowUps(): Promise<void> {
  // Anything older than the expiry window is closed out without sending.
  await pool.query(
    `UPDATE post_call_follow_ups SET harness_status = 'expired'
     WHERE sent_at IS NULL AND harness_status IS NULL AND created_at <= NOW() - ($1 || ' hours')::interval`,
    [POST_CALL_EXPIRY_HOURS],
  );
  const { rows } = await pool.query(
    `SELECT id, user_id, created_at FROM post_call_follow_ups
     WHERE sent_at IS NULL AND harness_status IS NULL
     LIMIT 50`,
  );
  for (const row of rows) {
    const createdAt = new Date(row.created_at);
    // Only mark 'queued' when enqueueCandidate actually queued it (code
    // review, 2026-09-17): this used to mark 'queued' unconditionally,
    // including when the call threw (swallowed by .catch, ignoring the
    // result) or came back {queued:false} (already sent/dropped, an
    // idempotency no-op, not success) — either way harness_status='queued'
    // made this row look like a real in-flight candidate forever, with
    // nothing ever polling it again to notice it wasn't.
    const result = await enqueueCandidate({
      userId: row.user_id,
      type: "post_call",
      targetKey: `post_call:${row.id}`,
      summary: `Short text about one specific thing they said on a call ${Math.round((Date.now() - createdAt.getTime()) / 3600000)}h ago`,
      payload: { followUpId: row.id },
      dueAt: new Date(createdAt.getTime() + 20 * 60 * 1000),
      expiresAt: new Date(createdAt.getTime() + POST_CALL_EXPIRY_HOURS * 60 * 60 * 1000),
    }).catch((err: any) => {
      console.error(`postCallFollowUp: enqueue failed for ${row.id} (non-fatal):`, err?.message ?? err);
      return { queued: false };
    });
    await pool.query(`UPDATE post_call_follow_ups SET harness_status = $2 WHERE id = $1`, [row.id, result.queued ? "queued" : "skipped"]);
  }
}

export async function draftPostCall(userId: string, firstName: string, followUpId: string): Promise<{ text: string; rules: OutputRules } | null> {
  const { rows } = await pool.query(`SELECT transcript, created_at FROM post_call_follow_ups WHERE id = $1 AND user_id = $2`, [followUpId, userId]);
  const transcript: string | undefined = rows[0]?.transcript;
  if (!transcript) return null;
  const callAt = rows[0]?.created_at ? new Date(rows[0].created_at) : new Date();
  // What Co knows about them, from the shared layer (services/memberKnowledge.ts): what they already have, what Co is carrying,
  // lessons, corrections, claims, restraint and their recent texts with when, stripped of other members inside. It fails closed (a
  // failed name read rejects): then the text is drafted from the call and the (separately stripped) summary alone, with no claims.
  const [contextSummary, k] = await Promise.all([
    buildContextSummary(userId).catch(() => ""),
    memberKnowledge(userId, { include: POST_CALL_SECTIONS, exchanges: 10, exchangeDays: 7 }).catch(() => null),
  ]);
  // What came of anything Co said on THIS call it would look into
  // (harness/callGrounding.ts keepCallPromise), matched by the call's
  // transcript fingerprint (services/callKey.ts). Second review, 2026-09-24:
  // time windows put a quick callback's results in the wrong call's text.
  const { rows: promised } = await pool
    .query(
      `SELECT content FROM call_promise_results WHERE user_id = $1 AND call_key = $2 ORDER BY created_at`,
      [userId, callKey(transcript)],
    )
    .catch(() => ({ rows: [] as any[] }));
  // What Co holds about them that is still inside its lifetime (services/claims.ts), apart by label: what THEY said, and Co's read.
  // From the layer (stripped). When the layer rejected (fails closed), none: never the un-stripped claims read in its place.
  const labelled = k ? labelClaims(k) : { theySaid: [] as string[], coInferred: [] as string[], enduring: [] as string[] };
  // The confirmation already sent the moment they hung up (services/callFollowThrough.ts): this text never says it again.
  const { confirmationSentFor } = await import("../services/callFollowThrough.js");
  const confirmed = await confirmationSentFor(userId, transcript).catch(() => null);
  const recap = await recapOfferFor(userId, followUpId, { callAt, confirmed: !!confirmed, coCommitted: promised.length > 0 }, k).catch(() => false);
  return draftPostCallText(firstName, transcript, contextSummary, promised.map((r: any) => String(r.content)), { theySaid: [...labelled.enduring, ...labelled.theySaid], coInferred: labelled.coInferred }, confirmed, recap, k);
}

// The sections the post-call text reads from the layer.
export const POST_CALL_SECTIONS = ["delivered", "carrying", "lessons", "corrections", "claims", "restraint", "exchanges"] as const;

// Pure: the layer's live claims in the labels the draft reads (the same split as factLabels.ts renderLive: what they said, enduring
// or not, apart from Co's read), each with the day it was said (their local date, as renderLive labels it) and, for an ephemeral one,
// the last day it holds. A claim holding a value they corrected away is dropped (harness/callGrounding.ts uncorrectedClaims).
export function labelClaims(k: Pick<MemberKnowledge, "claims" | "corrections">): { theySaid: string[]; coInferred: string[]; enduring: string[] } {
  const claims = uncorrectedClaims(k.claims, k.corrections);
  const fmt = (c: MemberKnowledge["claims"][number]) => {
    const day = saidDay(c.saidOn);
    const until = c.expiresOn ? `, until ${DateTime.fromISO(c.expiresOn.slice(0, 10), { zone: "utc" }).minus({ days: 1 }).toFormat("LLL d")}` : "";
    return `${c.text} (${c.provenance === "user_said" ? `they said, ${day}` : `Co's read, ${day}`}${until})`;
  };
  const enduring = (c: MemberKnowledge["claims"][number]) => KINDS[c.kind]?.lifetime === "enduring";
  return {
    enduring: claims.filter((c) => c.provenance === "user_said" && enduring(c)).map(fmt),
    theySaid: claims.filter((c) => c.provenance === "user_said" && !enduring(c)).map(fmt),
    coInferred: claims.filter((c) => c.provenance === "co_inferred").map(fmt),
  };
}

// Pure: the shared picture and the member-level rules, for the post-call draft's task. None of it goes in CONFIRMED_FACTS: what
// they have and what Co is carrying are there so the text never restates or teases them (#115), and nothing here can back a day,
// an event or a commitment in the draft (harness/proactiveSpecifics.ts reads only the facts).
export function postCallKnowledgeSection(k: MemberKnowledge): string {
  const tz = k.identity.timeZone;
  const day = (at: string) => DateTime.fromISO(at).setZone(tz).toFormat("LLL d");
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}...` : s);
  const rules = memberRules(k);
  const have = [
    ...k.delivered.slice(0, 8).map((d) => `- "${cut(d.what, 140)}" (${d.kind}, ${day(d.at)}${d.reaction ? `, they reacted ${d.reaction}` : ""})`),
    ...k.carrying.filter((c) => c.theyHaveIt).slice(0, 4).map((c) => `- ${cut(c.what, 140)}`),
  ];
  const carrying = k.carrying.filter((c) => !c.theyHaveIt && c.state !== "done").slice(0, 8).map((c) => `- ${cut(c.what, 140)}`);
  const texts = k.exchanges
    .filter((x) => !x.call)
    .slice(-10)
    .map((x) => `- ${localStamp(x.verifiedAt, k.identity.zone)} ${x.from === "member" ? "They" : "Co"}: ${cut(x.text.replace(/\s*\n+\s*/g, " "), 220)}`);
  const parts = [
    have.length ? `THEY ALREADY HAVE THESE (never restate, resend or re-offer one; it isn't news):\n${have.join("\n")}` : null,
    carrying.length ? `WORK CO IS CARRYING FOR THEM (never in this text: each arrives in its own message when it's real; write about something else):\n${carrying.join("\n")}` : null,
    k.corrections.length ? `THEY CORRECTED (only the corrected version exists):\n${k.corrections.slice(0, 6).map((c) => `- ${c.field}${c.now ? `: ${cut(c.now, 120)}` : ": what Co had no longer holds"}`).join("\n")}` : null,
    k.lessons.length ? `WHAT CO HAS LEARNED FROM MOMENTS THEY CORRECTED IT (how to be with them; never quote it):\n${k.lessons.slice(0, 4).map((l) => `- ${cut(l.text, 200)}`).join("\n")}` : null,
    texts.length ? `RECENT TEXTS, WITH WHEN (what they already heard from Co and said; context only, never a source for a day or a commitment):\n${texts.join("\n")}` : null,
    `MEMBER RULES (the same everywhere Co talks with them. Whether and when this text goes is already decided in code: restraint and quiet hours shape how you write it, never a reason to SKIP)\n${[rules.discretion, rules.memberSafety, rules.grounding, rules.deliveryShape, rules.restraint, rules.quietHours].filter(Boolean).join("\n\n")}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

// May this post-call text carry one line offering a one-page recap (2026-10-08 review A5). Code checks the facts: the shared offer
// cooldown and record (services/documentOffer.ts), a heavy call or a hard time, their night, a commitment Co made on the call or the
// confirmation text that already went (services/callFollowThrough.ts), a document delivered since. Whether the call landed a decision
// in their words is Co's read of the transcript. Member state (their zone, whether they're having a hard time, what they've been
// delivered) is read from the shared layer (services/memberKnowledge.ts), the draft's own copy when it has one; how heavy the call
// itself was is the call's, read from its emotion moments.
export async function recapOfferFor(
  userId: string,
  followUpId: string,
  o: { callAt: Date; confirmed: boolean; coCommitted: boolean; now?: Date },
  known: Pick<MemberKnowledge, "identity" | "restraint" | "delivered"> | null = null,
): Promise<boolean> {
  const now = o.now ?? new Date();
  const [{ loadOfferHistory, postCallRecapAllowed }, { getEmotionalContext }, { localOf }] = await Promise.all([
    import("../services/documentOffer.js"),
    import("../harness/emotion.js"),
    import("../services/memberTime.js"),
  ]);
  const [history, emo, k] = await Promise.all([
    loadOfferHistory(userId),
    getEmotionalContext(userId, now).catch(() => null),
    known ?? memberKnowledge(userId, { now, include: ["restraint", "delivered"] }),
  ]);
  const heavyCall = (emo?.lastCall?.moments ?? []).some((m) => m.intensity === "high" && m.valence === "negative");
  const r = postCallRecapAllowed({
    gate: { now, needsCare: k.restraint ? k.restraint.needsCare : !!emo?.needsCare, heavyNow: heavyCall, history },
    localHour: localOf(now, k.identity.zone).hour,
    confirmationSent: o.confirmed,
    coCommitted: o.coCommitted,
    // A document they were handed since the call (a receipt), not an offer or a plain text.
    deliveredSinceCall: k.delivered.some((d) => d.via.includes("receipt") && Date.parse(d.at) >= o.callAt.getTime()),
    callKey: recapKey(followUpId),
  });
  return r.ok;
}
export const recapKey = (followUpId: string) => `call ${followUpId}`;

export async function draftPostCallText(
  firstName: string,
  transcript: string,
  contextSummary: string,
  promiseResults: string[] = [],
  claims: { theySaid: string[]; coInferred: string[] } = { theySaid: [], coInferred: [] },
  confirmationSent: string | null = null,
  // Code allowed one line offering a one-page recap (recapOfferFor); whether the call landed a decision is Co's read.
  recapOffer = false,
  // The shared picture and member rules (services/memberKnowledge.ts); null drafts from the summary and claims alone.
  knowledge: MemberKnowledge | null = null,
): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "jobs.postCallFollowUp",
    firstName,
    facts: {
      call_transcript: transcript.slice(-6000),
      background_you_already_knew: contextSummary ? contextSummary.slice(0, 1500) : null,
      // Labelled: only what they said, and still live, can be stated back; Co's read is orientation only.
      live_things_they_said: claims.theySaid.length ? claims.theySaid : null,
      background_co_read_orientation_only_never_say_you_told_me: claims.coInferred.length ? claims.coInferred : null,
      // Never in this text (#115): the delivery is its own one message. Kept out of the facts so it can't be restated.
      what_co_said_it_would_look_into: null,
      confirmation_you_already_sent_after_the_call: confirmationSent,
      may_offer_a_one_page_recap: recapOffer && !confirmationSent ? RECAP_OFFER_RULE : null,
    },
    maxSentences: 3,
    // The call that just ended is fresh: what THEY said in it can back a day. The background is only who they are.
    freshKeys: ["call_transcript"],
    task: `You just got off a call with them. Text the follow-up a thoughtful friend who was really listening would send, and trust your gut on which kind fits this call best. It can be a follow-up question that picks up a thread they left open (or where they said they'd carry on by text), a piece of kind, concrete advice if they were stuck, weighing a decision, or venting, or a short reflection of what stood out to them with one question that shows you got it. Whatever you choose, start with a few of your own words that show you heard them, then the question or the advice; never send a bare question. Don't offer to keep an eye out, watch for, or look for anything. Send the one a friend would most likely send; a real follow-up every time, not a summary. Use only what THEY said on the call (never Co's own lines, never background they didn't say on the call), and never credit them with a question that was Co's. When they were stuck or weighing a decision, lean toward giving one concrete, kind thought that helps them see a way forward, and let a question be optional. Advice is a thought, not an order: plain words, no lists, no lecturing. Never announce that you were thinking about it ("Been thinking about", "Still turning over", "Kept thinking"); just say it. Call the product Co, never "Compatible" or "CoPatible", even if they did. Anything Co said on the call it would send, find or look into arrives in its own message when it's real (Royce, 2026-10-08: silence until there's something real, then one message): never mention it here, not that it's coming, not that you're on it, not that nothing turned up. Write about something else they said. Never narrate your own state or process ("starting", "working on", "on it", "looking into", "in progress"), and never make sending their own thing depend on your judgment ("once it's worth sending", "nothing good enough"). Write straight to them as "you", never their name in the third person. Reread it before you answer: it has to make complete sense to someone reading it cold. Never recap the whole call, never mention scheduling or logistics. If the transcript has nothing real from them (for example Co did all the talking), return SKIP.${knowledge ? `\n\n${postCallKnowledgeSection(knowledge)}` : ""}`,
  });
  if (!text) return null;
  return { text, rules: { maxSentences: 3, maxChars: 360 } };
}

export async function markPostCallSent(followUpId: string): Promise<void> {
  await pool.query(`UPDATE post_call_follow_ups SET sent_at = NOW(), harness_status = 'sent' WHERE id = $1`, [followUpId]);
}

// The recap offer, recorded when the text that went out makes it, so it shares the cooldown and is never made twice.
export async function recordRecapOffer(userId: string, followUpId: string, messages: string[]): Promise<boolean> {
  const { madeArtifactOffer, recordArtifactOffer } = await import("../services/documentOffer.js");
  if (!madeArtifactOffer(messages.join("\n"), "recap")) return false;
  await recordArtifactOffer(userId, "recap", recapKey(followUpId));
  return true;
}

export async function markPostCallDropped(followUpId: string, status: string): Promise<void> {
  await pool.query(`UPDATE post_call_follow_ups SET harness_status = $2 WHERE id = $1`, [followUpId, status]);
}
