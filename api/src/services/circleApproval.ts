// Shared by every path that forms a circle — the initial /place route, the
// reject-triggered rematch in sendblue.ts, and Keana's own manual-approve
// reply — so activation and (when confidence requires it) Moderator review
// always behave the same regardless of which path created the circle.
import type { Server as IOServer } from "socket.io";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { min_group_score } from "./matching.js";
import { generateCircleTitle, generateWarmCircleInviteMessage } from "./circleInvite.js";
import { generateEmbedding } from "./embeddings.js";
import sendblue from "./sendblue.js";

// Only ever called for a circle below LOW_CONFIDENCE_GROUP_SCORE — Co
// couldn't decide on its own, so this always requires Keana's explicit
// reply, never an auto-approve timeout. A circle that clears the threshold
// skips this entirely and goes straight to activateCircle below.
export async function notifyModeratorOfPendingCircle(params: {
  circleId: string;
  memberIds: string[];
  memberNames: string;
  city: string;
  chapter: string;
  finalScore: number;
}): Promise<void> {
  const { circleId, memberIds, memberNames, city, chapter, finalScore } = params;

  const confidenceNote = `Borderline match — score ${finalScore.toFixed(2)}, just above the ${min_group_score} floor.`;
  const message = `New circle ready for review. ${memberIds.length} people, ${city}, ${chapter}. Members: ${memberNames}. ${confidenceNote} This one needs your call — reply APPROVE or REJECT, no auto-approval on this one.`;

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
    `UPDATE circles SET keana_notified_at = NOW(), requires_moderator_reply = true, confidence_note = $2 WHERE id = $1`,
    [circleId, confidenceNote],
  );
}

// Activates a circle with no Moderator step — called immediately at
// formation for any circle that clears LOW_CONFIDENCE_GROUP_SCORE (Co can
// decide on its own), and by Keana's manual-approve reply for a
// low-confidence circle she's cleared herself. Sends each member an
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
    `SELECT u.id, u.first_name, u.phone_number, cp.city, cp.life_chapters, cp.goals
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
          const { text: vcardMsg } = await generateText({
            model: anthropic("claude-haiku-4-5-20251001"),
            prompt: `You are Co, texting ${member.first_name} for the first time. Ask them to save your contact, briefly, in your own words. No exclamation points, no em dashes. 1 sentence.`,
          });
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

    const circleTitle = await generateCircleTitle(city, chapter, member.goals ?? []);
    const inviteMsg = await generateWarmCircleInviteMessage({
      firstName: member.first_name,
      circleTitle,
      chapter,
      city,
      goals: member.goals ?? [],
    });

    try {
      await sendblue.messages.send({
        number: member.phone_number,
        content: inviteMsg,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
    } catch (smsErr: any) {
      console.error(`Circle invite message failed for ${member.id}:`, smsErr?.message ?? smsErr);
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
