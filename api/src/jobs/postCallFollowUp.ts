import pool from "../db/db.js";
import { buildContextSummary } from "../services/callContext.js";
import { enqueueCandidate, draftProactive, type OutputRules } from "../harness/proactive.js";
import { callKey } from "../services/callKey.js";
import { RECAP_OFFER_RULE } from "../services/documentOffer.js";

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
  const contextSummary = await buildContextSummary(userId).catch(() => "");
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
  const { liveClaimsRendered } = await import("../services/claims.js");
  const labelled = await liveClaimsRendered(userId, new Date()).catch(() => ({ theySaid: [] as string[], coInferred: [] as string[], enduring: [] as string[] }));
  // The confirmation already sent the moment they hung up (services/callFollowThrough.ts): this text never says it again.
  const { confirmationSentFor } = await import("../services/callFollowThrough.js");
  const confirmed = await confirmationSentFor(userId, transcript).catch(() => null);
  const recap = await recapOfferFor(userId, followUpId, { callAt, confirmed: !!confirmed, coCommitted: promised.length > 0 }).catch(() => false);
  return draftPostCallText(firstName, transcript, contextSummary, promised.map((r: any) => String(r.content)), { theySaid: [...labelled.enduring, ...labelled.theySaid], coInferred: labelled.coInferred }, confirmed, recap);
}

// May this post-call text carry one line offering a one-page recap (2026-10-08 review A5). Code checks the facts: the shared offer
// cooldown and record (services/documentOffer.ts), a heavy call or a hard time, their night, a commitment Co made on the call or the
// confirmation text that already went (services/callFollowThrough.ts), a document delivered since. Whether the call landed a decision
// in their words is Co's read of the transcript.
export async function recapOfferFor(userId: string, followUpId: string, o: { callAt: Date; confirmed: boolean; coCommitted: boolean; now?: Date }): Promise<boolean> {
  const now = o.now ?? new Date();
  const [{ loadOfferHistory, postCallRecapAllowed }, { getEmotionalContext }, { memberZone, localOf }, R] = await Promise.all([
    import("../services/documentOffer.js"),
    import("../harness/emotion.js"),
    import("../services/memberTime.js"),
    import("../services/deliveryReceipts.js"),
  ]);
  const [history, emo, zone, receipts] = await Promise.all([
    loadOfferHistory(userId),
    getEmotionalContext(userId, now).catch(() => null),
    memberZone(userId),
    R.pgReceipts.forUser(userId, 10).catch(() => []),
  ]);
  const heavyCall = (emo?.lastCall?.moments ?? []).some((m) => m.intensity === "high" && m.valence === "negative");
  const r = postCallRecapAllowed({
    gate: { now, needsCare: !!emo?.needsCare, heavyNow: heavyCall, history },
    localHour: localOf(now, zone).hour,
    confirmationSent: o.confirmed,
    coCommitted: o.coCommitted,
    deliveredSinceCall: receipts.some((x) => x.deliveredAt.getTime() >= o.callAt.getTime()),
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
      what_co_said_it_would_look_into: promiseResults.length ? promiseResults.join("\n") : null,
      confirmation_you_already_sent_after_the_call: confirmationSent,
      may_offer_a_one_page_recap: recapOffer && !confirmationSent ? RECAP_OFFER_RULE : null,
    },
    maxSentences: 3,
    // The call that just ended is fresh: what THEY said in it can back a day. The background is only who they are.
    freshKeys: ["call_transcript"],
    task: `You just got off a call with them. Text the follow-up a thoughtful friend who was really listening would send, and trust your gut on which kind fits this call best. It can be a follow-up question that picks up a thread they left open (or where they said they'd carry on by text), a piece of kind, concrete advice if they were stuck, weighing a decision, or venting, or a short reflection of what stood out to them with one question that shows you got it. Whatever you choose, start with a few of your own words that show you heard them, then the question or the advice; never send a bare question. Don't offer to keep an eye out, watch for, or look for anything. Send the one a friend would most likely send; a real follow-up every time, not a summary. Use only what THEY said on the call (never Co's own lines, never background they didn't say on the call), and never credit them with a question that was Co's. When they were stuck or weighing a decision, lean toward giving one concrete, kind thought that helps them see a way forward, and let a question be optional. Advice is a thought, not an order: plain words, no lists, no lecturing. Never announce that you were thinking about it ("Been thinking about", "Still turning over", "Kept thinking"); just say it. Call the product Co, never "Compatible" or "CoPatible", even if they did. If what_co_said_it_would_look_into says nothing turned up, say plainly what you looked for and that nothing real has turned up yet, without promising to keep looking; if it says something was found, don't describe it, it comes in its own text. If it says Co started working on something they asked for, and confirmation_you_already_sent_after_the_call is empty, say it in this shape: what you understood they want, that you'll text it to them, and when only if you named a time on the call. If confirmation_you_already_sent_after_the_call has a text, they already know what's coming: never say it again, write about something else they said. Never narrate your own state or process ("starting", "working on", "on it", "looking into", "in progress"), and never make sending their own thing depend on your judgment ("once it's worth sending", "nothing good enough"). Write straight to them as "you", never their name in the third person. Reread it before you answer: it has to make complete sense to someone reading it cold. Never recap the whole call, never mention scheduling or logistics. If the transcript has nothing real from them (for example Co did all the talking), return SKIP.`,
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
