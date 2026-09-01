// Manually-triggered broadcast to the named co-test testers (Royce,
// Jacqueline — see TESTER_FIRST_NAMES below) announcing a real update
// (Royce, 2026-08-31: "text users who are using [co-test] updates we've
// pushed... Co should have a welcoming message plus the updates whenever
// an update has been made," narrowed the same day to "only Me and
// Jacqueline," not every co-test user). Deliberately NOT automatic on
// every deploy — a human decides when an update is actually worth telling
// testers about, and writes the update items themselves, rather than every
// tiny fix or a deploy that turns out broken minutes later triggering a
// broadcast on its own.
//
// Run from api/: npm run notify-testers -- "<update 1>" "<update 2>" ...
// Each argument becomes its own bullet point.
//
// Reads whichever .env is loaded (same default-cwd behavior as
// server.ts's "dotenv/config") — points at co-test when run against
// co-test's DATABASE_URL/SENDBLUE_* vars, same as every other script in
// this directory.
import "dotenv/config";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import sendblue, { cleanCoMessage } from "../services/sendblue.js";

// Shared intro/closing, not regenerated per person, and neither one ever
// contains a greeting or the person's name — the code owns "Hey {name},"
// exactly once (bug fix, 2026-08-31: the drafted intro used to open with
// its own "Hey" too, on top of the hardcoded one, reading as a stutter).
// The update bullets themselves are never touched by an LLM — what
// actually changed must never drift or get invented, so each item is sent
// verbatim, exactly as written.
async function draftLine(instruction: string, fallback: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "notifyTesters.draftLine" },
      prompt: `You are Co, texting someone who's helping test Co before launch. ${instruction} No greeting, no "Hey", no using their name — that's handled separately. No em dashes, no exclamation points. Return ONLY that one short line, nothing else.`,
    });
    const trimmed = text.trim();
    return trimmed || fallback;
  } catch (err: any) {
    console.error("notifyTesters: draftLine failed (non-fatal, using default):", err?.message ?? err);
    return fallback;
  }
}

async function main() {
  const updates = process.argv.slice(2);
  if (!updates.length) {
    console.error(`Usage: npm run notify-testers -- "<update 1>" "<update 2>" ...`);
    process.exit(1);
  }

  // Scoped to named testers only (Royce, 2026-08-31: "make sure the
  // testers are only Me and Jacqueline") — NOT every co-test user, despite
  // this being the co-test database. Name-filtered rather than by
  // hardcoded phone/email so it stays correct without baking in contact
  // details here; update this list directly as the tester group changes.
  const TESTER_FIRST_NAMES = ["Royce", "Jacqueline"];
  const { rows: users } = await pool.query(
    `SELECT id, first_name, phone_number FROM users WHERE phone_number IS NOT NULL AND first_name = ANY($1)`,
    [TESTER_FIRST_NAMES],
  );
  if (!users.length) {
    console.log(`notifyTesters: no matching testers (${TESTER_FIRST_NAMES.join(", ")}) found with a phone number on file — nothing to send.`);
    process.exit(0);
  }

  const intro = await draftLine(
    "Write a short, warm phrase thanking them for helping test Co and saying here's what's new.",
    "thanks so much for helping test Co — here's what's new:",
  );
  const closing = await draftLine(
    "Write a short, warm closing line inviting them to share what they think after trying it.",
    "Let Co know what you think once you've had a chance to try it.",
  );
  const bulletList = updates.map((u) => `• ${u}`).join("\n");

  console.log(`notifyTesters: about to send to ${users.length} user(s), e.g.:\nHey {name}, ${intro}\n\n${bulletList}\n\n${closing}\n`);

  let sentCount = 0;
  for (const user of users) {
    const greeting = user.first_name ? `Hey ${user.first_name}, ` : "Hey, ";
    const content = cleanCoMessage(`${greeting}${intro}\n\n${bulletList}\n\n${closing}`);
    try {
      await sendblue.messages.send({
        number: user.phone_number,
        content,
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      });
      sentCount++;
      console.log(`notifyTesters: sent to ${user.id}`);
    } catch (err: any) {
      console.error(`notifyTesters: failed to send to ${user.id}:`, err?.message ?? err);
    }
  }

  console.log(`notifyTesters: done — sent to ${sentCount}/${users.length} user(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("notifyTesters: fatal error:", err?.message ?? err);
  process.exit(1);
});
