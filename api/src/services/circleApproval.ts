// Shared by every path that puts a new circle in front of the Moderator for
// approval — the initial /place route and the reject-triggered rematch in
// sendblue.ts — so a low-confidence placement always gets the same
// no-silent-auto-approve treatment regardless of which path created it.
import pool from "../db/db.js";
import { LOW_CONFIDENCE_GROUP_SCORE, min_group_score } from "./matching.js";
import sendblue from "./sendblue.js";

export async function notifyModeratorOfPendingCircle(params: {
  circleId: string;
  memberIds: string[];
  memberNames: string;
  city: string;
  chapter: string;
  finalScore: number;
}): Promise<void> {
  const { circleId, memberIds, memberNames, city, chapter, finalScore } = params;

  const lowConfidence = finalScore < LOW_CONFIDENCE_GROUP_SCORE;
  const confidenceNote = lowConfidence
    ? `Borderline match — score ${finalScore.toFixed(2)}, just above the ${min_group_score} floor.`
    : null;

  const base = `New circle ready for review. ${memberIds.length} people, ${city}, ${chapter}. Members: ${memberNames}.`;
  const message = lowConfidence
    ? `${base} ${confidenceNote} This one needs your call — reply APPROVE or REJECT, no auto-approval on this one.`
    : `${base} Reply APPROVE or REJECT within 4 hours — Co will auto-approve if no response.`;

  try {
    await sendblue.messages.send({
      number: process.env.KEANA_PHONE_NUMBER!,
      content: message,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  } catch (err: any) {
    console.error(`Failed to notify Moderator of pending circle ${circleId}:`, err?.message ?? err);
  }

  await pool.query(
    `UPDATE circles SET keana_notified_at = NOW(), requires_moderator_reply = $2, confidence_note = $3 WHERE id = $1`,
    [circleId, lowConfidence, confidenceNote],
  );
}
