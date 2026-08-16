// Shared by every path that forms a circle — the initial /place route, a
// rematch triggered by an explicit Moderator reject or by her simply never
// responding, and the Moderator's own manual-approve reply — so activation
// and (when confidence requires it) Moderator review always behave the same
// regardless of which path created the circle.
import type { Server as IOServer } from "socket.io";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import pool from "../db/db.js";
import { CIRCLE_FACILITATION_ENABLED, findBestCircleWithScore, min_group_score } from "./circleFacilitation.js";
import { generateCircleTitle, generateWarmCircleInviteMessage } from "./circleInvite.js";
import { generateEmbedding } from "./embeddings.js";
import sendblue from "./sendblue.js";

// Deterministic, not LLM-generated — this feeds a real approve/reject
// decision, so it should say only what's actually true of the group, never
// a plausible-sounding guess.
function sharedAcrossGroup(arrays: string[][]): string[] {
  const nonEmpty = arrays.filter((a) => a && a.length);
  if (!nonEmpty.length) return [];
  const [first, ...rest] = nonEmpty;
  return first.filter((item) => rest.every((arr) => arr.includes(item)));
}

function buildGroupReasoning(members: { life_chapters?: string[]; activity_preferences?: string[] }[]): string {
  const sharedChapters = sharedAcrossGroup(members.map((m) => m.life_chapters ?? []));
  const sharedActivities = sharedAcrossGroup(members.map((m) => m.activity_preferences ?? []));

  const parts: string[] = [];
  if (sharedChapters.length) {
    parts.push(`everyone's in ${sharedChapters.map((c) => c.replace(/_/g, " ")).join(", ")}`);
  }
  if (sharedActivities.length) {
    parts.push(`shared interest in ${sharedActivities.slice(0, 3).join(", ")}`);
  }
  return parts.length
    ? `Why: ${parts.join("; ")}.`
    : "Why: shares a life chapter with the requester, but no strong shared activities on file.";
}

async function buildModeratorCircleMessage(circleId: string, confidenceNote: string): Promise<string> {
  const membersResult = await pool.query(
    `SELECT u.first_name, cp.city, cp.life_chapters, cp.activity_preferences
     FROM circle_members cm
     JOIN users u ON u.id = cm.member_id
     LEFT JOIN co_profiles cp ON cp.user_id = cm.member_id
     WHERE cm.circle_id = $1`,
    [circleId],
  );
  const members = membersResult.rows;
  const memberNames = members.map((m: any) => m.first_name).join(", ");
  const city = members.find((m: any) => m.city)?.city ?? "unknown city";
  const chapter = (members.find((m: any) => m.life_chapters?.length)?.life_chapters?.[0] ?? "").replace(/_/g, " ");
  const reasoning = buildGroupReasoning(members);

  return `New circle ready for review. ${members.length} people, ${city}, ${chapter}. Members: ${memberNames}. ${confidenceNote} ${reasoning} Reply APPROVE or REJECT — this one needs your call, no auto-approval.`;
}

// Only ever called for a circle below min_group_score — Co couldn't decide
// on its own, so this always requires the Moderator's explicit reply, never
// an auto-approve timeout. A circle that clears the threshold skips this
// entirely and goes straight to activateCircle below.
export async function notifyModeratorOfPendingCircle(params: {
  circleId: string;
  finalScore: number;
}): Promise<void> {
  const { circleId, finalScore } = params;

  const confidenceNote = `Below the ${min_group_score} autonomous-placement floor (score ${finalScore.toFixed(2)}).`;

  await pool.query(
    `UPDATE circles SET moderator_notified_at = NULL, requires_moderator_reply = true, confidence_note = $2 WHERE id = $1`,
    [circleId, confidenceNote],
  );

  const message = await buildModeratorCircleMessage(circleId, confidenceNote);
  await sendCircleModeratorNotification(circleId, message);
}

// Only stamps moderator_notified_at on a genuine successful send — a failed
// send leaves it NULL so the retry sweep (server.ts) retries the send
// itself instead of just waiting on a clock that never really started. Also
// callable directly by that sweep.
export async function sendCircleModeratorNotification(circleId: string, message: string): Promise<boolean> {
  try {
    await sendblue.messages.send({
      number: process.env.MODERATOR_PHONE_NUMBER!,
      content: message,
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
    await pool.query(`UPDATE circles SET moderator_notified_at = NOW() WHERE id = $1`, [circleId]);
    return true;
  } catch (err: any) {
    console.error(`Failed to notify Moderator of pending circle ${circleId}:`, err?.message ?? err);
    return false;
  }
}

// Re-derives the same message from what's already stored (confidence_note)
// plus a fresh read of current member profiles — called by server.ts's
// sweep for any circle whose notification never actually reached the
// Moderator.
export async function retryCircleModeratorNotification(circleId: string): Promise<boolean> {
  const circleResult = await pool.query(`SELECT confidence_note FROM circles WHERE id = $1`, [circleId]);
  const confidenceNote = circleResult.rows[0]?.confidence_note ?? "Below the autonomous-placement floor.";
  const message = await buildModeratorCircleMessage(circleId, confidenceNote);
  return sendCircleModeratorNotification(circleId, message);
}

// Attempts a new group composition for `ownerId`, excluding everyone from
// the circle being superseded — shared by both an explicit Moderator reject
// and a low-confidence circle she simply never responded to within 4 hours
// (Co doesn't just keep re-pinging the same group forever, it tries
// something different). `newStatus` distinguishes the two in circles.status:
// 'rejected' (an active human decision) vs 'superseded' (Co moved on after
// silence).
export async function attemptCircleRematch(params: {
  staleCircleId: string;
  ownerId: string;
  excludeMemberIds: string[];
  newStatus: "rejected" | "superseded";
  memberNoticeContent: string;
  io?: IOServer;
}): Promise<void> {
  const { staleCircleId, ownerId, excludeMemberIds, newStatus, memberNoticeContent, io } = params;

  await pool.query(`UPDATE circles SET status = $2 WHERE id = $1`, [staleCircleId, newStatus]);

  const allAffectedIds = [ownerId, ...excludeMemberIds.filter((id) => id !== ownerId)];
  for (const memberId of allAffectedIds) {
    const memRow = await pool.query(
      `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'check_in', $2) RETURNING id`,
      [memberId, memberNoticeContent],
    );
    generateEmbedding(memberNoticeContent)
      .then((emb) =>
        pool.query(`UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`, [
          `[${emb.join(",")}]`,
          memRow.rows[0].id,
        ]),
      )
      .catch((err) => console.error("Memory embedding failed (non-fatal):", err));
  }

  // Co Loop Stage 4 — off for now (see circleFacilitation.ts). Falls through
  // to the existing "no alternative match found" Moderator notice below,
  // same as a genuine no-match result always has.
  const newMatchResult = CIRCLE_FACILITATION_ENABLED
    ? await findBestCircleWithScore(ownerId, excludeMemberIds)
    : null;
  const newGroupIds = newMatchResult?.userIds ?? null;

  if (!newGroupIds || newGroupIds.length < 4) {
    const ownerRes = await pool.query(`SELECT first_name FROM users WHERE id = $1`, [ownerId]);
    const ownerName = ownerRes.rows[0]?.first_name ?? ownerId;
    try {
      await sendblue.messages.send({
        number: process.env.MODERATOR_PHONE_NUMBER!,
        content: `No alternative match found for ${ownerName}. Manual review needed.`,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
    } catch (err: any) {
      console.error("Failed to notify Moderator of no-match:", err?.message ?? err);
    }
    return;
  }

  const ownerProfile = await pool.query(`SELECT life_chapters FROM co_profiles WHERE user_id = $1`, [ownerId]);
  const primaryChapter = ownerProfile.rows[0]?.life_chapters?.[0] ?? "new_to_city";
  const circleName = `Co Circle — ${primaryChapter.replace(/_/g, " ")}`;

  const newCircleResult = await pool.query(
    `INSERT INTO circles (owner_id, circle_name, status) VALUES ($1, $2, 'pending_approval') RETURNING *`,
    [ownerId, circleName],
  );
  const newCircle = newCircleResult.rows[0];

  for (const memberId of newGroupIds) {
    await pool.query(
      `INSERT INTO circle_members (circle_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [newCircle.id, memberId],
    );
  }

  // Same confidence gate as initial placement.
  if (newMatchResult!.finalScore >= min_group_score) {
    await activateCircle({ circleId: newCircle.id, circleName, io });
  } else {
    await notifyModeratorOfPendingCircle({ circleId: newCircle.id, finalScore: newMatchResult!.finalScore });
  }
}

// Activates a circle with no Moderator step — called immediately at
// formation for any circle that clears min_group_score (Co can decide on
// its own), and by the Moderator's manual-approve reply for a
// below-threshold circle she's cleared herself. Sends each member an
// individual accept/decline circle-invite text (circleInvite.ts) — never a
// fait-accompli placement announcement, never headcount or other members'
// identities.
export async function activateCircle(params: {
  circleId: string;
  circleName: string;
  io?: IOServer;
}): Promise<void> {
  const { circleId, circleName, io } = params;

  await pool.query(`UPDATE circles SET status = 'active' WHERE id = $1`, [circleId]);

  const membersResult = await pool.query(
    `SELECT u.id, u.first_name, u.phone_number, u.subscription_status, cp.city, cp.life_chapters, cp.goals
     FROM circle_members cm
     JOIN users u ON cm.member_id = u.id
     LEFT JOIN co_profiles cp ON cp.user_id = cm.member_id
     WHERE cm.circle_id = $1`,
    [circleId],
  );
  const members = membersResult.rows;
  const memberCount = members.length;
  const city = members.find((m: any) => m.city)?.city ?? "your city";
  const chapter = (members.find((m: any) => m.life_chapters?.length)?.life_chapters?.[0] ?? "").replace(/_/g, " ");

  for (const member of members) {
    if (process.env.CO_VCARD_URL) {
      const vcardCheck = await pool.query(
        `SELECT id FROM co_memories WHERE user_id = $1 AND content = 'Co vCard sent to user — contact saved' LIMIT 1`,
        [member.id],
      );
      if (!vcardCheck.rows[0]) {
        try {
          const { text: vcardMsg } = await propagateAttributes(
            { userId: member.id, traceName: "circleApproval.activateCircle.vcardMessage" },
            () =>
              generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                experimental_telemetry: { isEnabled: true, functionId: "circleApproval.activateCircle.vcardMessage" },
                prompt: `You are Co, texting ${member.first_name} for the first time. Ask them to save your contact, briefly, in your own words. No exclamation points, no em dashes. 1 sentence.`,
              }),
          );
          await sendblue.messages.send({
            number: member.phone_number,
            content: vcardMsg,
            media_url: process.env.CO_VCARD_URL,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
          await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', 'Co vCard sent to user — contact saved')`,
            [member.id],
          );
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch (vcardErr: any) {
          console.error("vCard send failed (non-fatal):", vcardErr?.message ?? vcardErr);
        }
      }
    }

    // Non-production skips the paywall (same convention as co.ts's call-
    // trigger gate) so local/staging testing isn't blocked by real
    // subscription state.
    const isPayingMember = process.env.NODE_ENV !== "production" || member.subscription_status === "active";
    const circleTitle = await generateCircleTitle(city, chapter, member.goals ?? []);

    const inviteMsg = isPayingMember
      ? await generateWarmCircleInviteMessage({
          firstName: member.first_name,
          circleTitle,
          chapter,
          city,
          goals: member.goals ?? [],
        })
      : `Co found you a circle — become a member to see it and get the invite.`;

    try {
      await sendblue.messages.send({
        number: member.phone_number,
        content: inviteMsg,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
    } catch (smsErr: any) {
      console.error(`Circle invite message failed for ${member.id}:`, smsErr?.message ?? smsErr);
    }

    if (!isPayingMember) {
      // Not-yet-a-member: stays in circle_members as 'pending' (still
      // counted toward the group), but never got the real invite — nothing
      // currently re-sends it once they upgrade. That catch-up trigger
      // (from the Stripe webhook) is a real follow-up, not built here.
      continue;
    }

    const placementContent = `Co invited user to circle ${circleId} ("${circleTitle}") — awaiting accept/decline`;
    const placementMem = await pool.query(
      `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'placement', $2) RETURNING id`,
      [member.id, placementContent],
    );
    generateEmbedding(placementContent)
      .then((emb) =>
        pool.query(
          `UPDATE co_memories SET content_embedding = $1::vector WHERE id = $2`,
          [`[${emb.join(",")}]`, placementMem.rows[0].id],
        ),
      )
      .catch((err) => console.error("Memory embedding failed (non-fatal):", err));

    io?.to(`user:${member.id}`).emit("circle:placed", {
      circle_id: circleId,
      circle_name: circleName,
      member_count: memberCount,
      city,
      chapter,
    });
  }
}
