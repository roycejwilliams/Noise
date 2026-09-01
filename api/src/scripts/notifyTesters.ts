// Manually-triggered broadcast to the named co-test testers (Royce,
// Jacqueline — see TESTER_FIRST_NAMES below) announcing a real update
// (Royce, 2026-08-31: "text users who are using [co-test] updates we've
// pushed... Co should have a welcoming message plus the updates whenever
// an update has been made," narrowed the same day to "only Me and
// Jacqueline," not every co-test user). Deliberately NOT automatic on
// every deploy — a human decides when an update is actually worth telling
// testers about, and writes the summary text, rather than every tiny fix
// or a deploy that turns out broken minutes later triggering a broadcast
// on its own.
//
// Run from api/: npm run notify-testers -- "<update summary>"
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

// One shared intro, not regenerated per person — the update summary itself
// is the part that must never drift or get invented, so it's sent
// verbatim, never paraphrased by an LLM. Only the warm opening line is
// drafted, once, and reused for everyone, keeping cost and content both
// predictable for a broadcast that could go to N testers.
async function draftIntro(): Promise<string> {
  try {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      experimental_telemetry: { isEnabled: true, functionId: "notifyTesters.draftIntro" },
      prompt: `You are Co, texting someone who's helping test Co before launch. Write ONE short, warm sentence (no em dashes, no exclamation points) welcoming them and saying Co just got a real update worth knowing about. Do not describe what the update actually is — that gets appended separately after your sentence. Return ONLY that one sentence, nothing else.`,
    });
    const trimmed = text.trim();
    return trimmed || "Hey, Co just shipped something new worth knowing about.";
  } catch (err: any) {
    console.error("notifyTesters: draftIntro failed (non-fatal, using default):", err?.message ?? err);
    return "Hey, Co just shipped something new worth knowing about.";
  }
}

async function main() {
  const summary = process.argv[2];
  if (!summary) {
    console.error(`Usage: npm run notify-testers -- "<update summary>"`);
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

  const intro = await draftIntro();
  console.log(`notifyTesters: about to send to ${users.length} user(s):\n"${intro}\n\n${summary}"\n`);

  let sentCount = 0;
  for (const user of users) {
    const greeting = user.first_name ? `Hey ${user.first_name} — ` : "Hey — ";
    const content = cleanCoMessage(`${greeting}${intro}\n\n${summary}`);
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
