// The next-day check-in (Royce, 2026-10-04): when a member goes through
// something genuinely hard in a conversation (venting, bad news, visible
// frustration about their life), Co reaches out once, the next day, the way a
// person would. Not the same night, not a list of their problems, one quiet
// touch, and if they don't pick it up it is dropped, never repeated.
//
// It rides the existing proactive flow as a "companion" candidate, so every
// cap in harness/proactive.ts applies (local hours, one a day, spacing, the
// unanswered pauses, the 4-day gap between companion texts) and it can never
// stack with another touch. The trigger is the emotion read already made on
// every text and call (emotion_signals); this file only decides which of those
// count as an episode, and when the check-in is due.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { enqueueCandidate } from "../harness/proactive.js";
import { signalTarget, type EmotionSignal } from "../harness/emotion.js";
import { getTimezoneForCity } from "./geocoding.js";

export const HEAVY = {
  // How far back a signal can be and still start a check-in.
  lookbackHours: 36,
  // Readings this far apart are one episode.
  episodeGapHours: 18,
  // Due at this local hour on the day after the episode, and gone by the evening.
  dueHour: 10,
  expiresAfterHours: 12,
  // No second heavy check-in this soon after one was sent.
  quietDaysAfterSend: 3,
  // Medium readings need company to count as more than an everyday complaint.
  mediumsNeeded: 2,
  priority: 50,
};

export type HeavySignal = Pick<EmotionSignal, "source" | "emotion" | "intensity" | "valence" | "about" | "quote" | "target" | "basis"> & { at: Date };

export type HeavyEpisode = {
  key: string;
  endedAt: Date;
  dueAt: Date;
  expiresAt: Date;
  about: string | null;
  quote: string | null;
  emotion: string;
  // Sent the local day after, so it may say yesterday.
  when: "yesterday";
};

// Anything about hurting themselves is for the conversation, never an
// automated text: no check-in is drafted from it.
const SELF_HARM = /\b(?:suicid\w*|kill (?:my|him|her)self|end(?:ing)? (?:it all|my life)|hurt(?:ing)? myself|self[- ]?harm|disappear|better off without me|don'?t want to (?:be here|wake up|live))\b/i;

// Frustration that is really about Co (its calls, search, replies) is not a hard
// moment in their life, whatever the read's target says.
const ABOUT_CO_TOO = /\bco\b|\bcalls?\b.*\b(?:connect|drop|fail|break|work)|not connecting|\bthe app\b|take (?:the )?lead|take ownership|plan out the event|\bsearch(?:es|ing)?\b|\bresults?\b|\b(?:your|its) (?:reply|replies|response|text|texts)\b|you (?:didn'?t|aren'?t|never|keep)/i;

// Pure: the episode worth one check-in, or null. `signals` are one member's,
// any order; `now` and `timezone` decide the day it is due.
export function pickEpisode(signals: HeavySignal[], now: Date, timezone: string | null): HeavyEpisode | null {
  const since = now.getTime() - HEAVY.lookbackHours * 3_600_000;
  const life = signals
    .filter((s) => s.at.getTime() >= since && s.at <= now && signalTarget(s) === "life")
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  // Frustration with Co, and the voice score on its own, are not their life.
  const negative = life.filter((s) => s.valence === "negative" && s.basis !== "frustration_score" && !ABOUT_CO_TOO.test(`${s.about ?? ""} ${s.quote ?? ""}`.slice(0, 400)));
  if (!negative.length) return null;
  // The latest episode: walk back while readings are close together.
  const gap = HEAVY.episodeGapHours * 3_600_000;
  let start = negative.length - 1;
  while (start > 0 && negative[start].at.getTime() - negative[start - 1].at.getTime() <= gap) start--;
  const episode = negative.slice(start);
  const highs = episode.filter((s) => s.intensity === "high");
  const mediums = episode.filter((s) => s.intensity === "medium");
  if (!highs.length && mediums.length < HEAVY.mediumsNeeded) return null;
  if (episode.some((s) => SELF_HARM.test(`${s.about ?? ""} ${s.quote ?? ""}`))) return null;
  const endedAt = episode[episode.length - 1].at;
  // They have since had a good moment: it already passed.
  if (life.some((s) => s.valence === "positive" && s.at > endedAt)) return null;
  const zone = timezone && DateTime.now().setZone(timezone).isValid ? timezone : "America/Los_Angeles";
  const local = DateTime.fromJSDate(endedAt).setZone(zone);
  const due = local.plus({ days: 1 }).set({ hour: HEAVY.dueHour, minute: 0, second: 0, millisecond: 0 });
  const lead = (highs.length ? highs : mediums).slice(-1)[0];
  return {
    key: local.toFormat("yyyy-MM-dd"),
    endedAt,
    dueAt: due.toJSDate(),
    expiresAt: due.plus({ hours: HEAVY.expiresAfterHours }).toJSDate(),
    about: lead.about,
    quote: lead.quote,
    emotion: lead.emotion,
    // It goes out the local day after the episode (due, and gone by evening), so "yesterday" is true when it is read.
    when: "yesterday",
  };
}

export const HEAVY_KEY_PREFIX = "companion:heavy:";

// Hourly: queue one check-in for each member whose last day held a hard
// moment. Idempotent: the key is the episode's day, so it queues once, and a
// sent or expired one is never queued again.
export async function queueHeavyCheckins(now = new Date()): Promise<number> {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.city
     FROM users u
     WHERE u.sms_opted_out = false AND u.archived_at IS NULL AND u.identity_captured = true
       AND EXISTS (SELECT 1 FROM emotion_signals e WHERE e.user_id = u.id AND e.valence = 'negative' AND e.created_at > $1)
       AND NOT EXISTS (SELECT 1 FROM proactive_sends ps WHERE ps.user_id = u.id AND ps.target_key LIKE $2 AND ps.sent_at > $3)
       -- One waiting at a time: a hard stretch over several days is one episode's worth of care, not a text a day.
       AND NOT EXISTS (SELECT 1 FROM proactive_candidates pc WHERE pc.user_id = u.id AND pc.target_key LIKE $2 AND pc.status = 'pending')
     LIMIT 100`,
    [new Date(now.getTime() - HEAVY.lookbackHours * 3_600_000), `${HEAVY_KEY_PREFIX}%`, new Date(now.getTime() - HEAVY.quietDaysAfterSend * 86_400_000)],
  );
  let queued = 0;
  for (const u of rows) {
    const { rows: sig } = await pool.query(
      `SELECT source, emotion, intensity, valence, about, quote, target, basis, created_at AS at
       FROM emotion_signals WHERE user_id = $1 AND created_at > $2 ORDER BY created_at`,
      [u.user_id, new Date(now.getTime() - HEAVY.lookbackHours * 3_600_000)],
    );
    const tz = u.city ? await getTimezoneForCity(u.city).catch(() => null) : null;
    const ep = pickEpisode(sig.map((s: any) => ({ ...s, at: new Date(s.at) })), now, tz);
    if (!ep) continue;
    const { queued: ok } = await enqueueCandidate({
      userId: u.user_id,
      type: "companion",
      targetKey: `${HEAVY_KEY_PREFIX}${ep.key}`,
      topicKey: "companion",
      summary: "One quiet check-in the day after something hard they shared (skip if it wouldn't read as natural)",
      payload: { recap: "", heavy: { about: ep.about, quote: ep.quote, emotion: ep.emotion, when: ep.when } },
      priority: HEAVY.priority,
      dueAt: ep.dueAt,
      expiresAt: ep.expiresAt,
    }).catch(() => ({ queued: false }));
    await recordDecision({ layer: 7, decision: "proactive.heavyEpisode", userId: u.user_id, outcome: ok ? "act" : "skip", action: ep.key, proposal: { dueAt: ep.dueAt, emotion: ep.emotion } }).catch(() => {});
    if (ok) queued++;
  }
  return queued;
}
