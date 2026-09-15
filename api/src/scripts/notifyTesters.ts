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
// Also persists the update to product_updates (Royce, 2026-08-31: "if
// [a user] asks 'any updates' just send them that") so sendblue.ts can
// answer that question later for anyone, not just the people on this
// broadcast list — see migrations.ts's product_updates table.
//
// Run from api/: npm run notify-testers -- "<update 1>" "<update 2>" ...
// Each argument becomes its own bullet point. If no arguments are given,
// reads updates from stdin instead, one per line — use this form when the
// update text has apostrophes, since shell quoting otherwise tends to
// strip them (confirmed live, 2026-08-31: "Co's" came out as "Cos"):
//   npm run notify-testers <<'EOF'
//   Co's own events now show up alongside public Luma events
//   Co follows up after you meet someone Co matched you with
//   EOF
//
// Reads whichever .env is loaded (same default-cwd behavior as
// server.ts's "dotenv/config") — points at co-test when run against
// co-test's DATABASE_URL/SENDBLUE_* vars, same as every other script in
// this directory.
import "dotenv/config";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { createHash } from "crypto";
import { cleanCoMessage } from "../services/sendblue.js";
import { enqueueCandidate } from "../harness/proactive.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "../services/coVoice.js";
import { MODELS } from "../models.js";

// Shared intro/closing, not regenerated per person, and neither one ever
// contains a greeting or the person's name — the code owns "Hey {name},"
// exactly once (bug fix, 2026-08-31: the drafted intro used to open with
// its own "Hey" too, on top of the hardcoded one, reading as a stutter).
// The update bullets themselves are never touched by an LLM — what
// actually changed must never drift or get invented, so each item is sent
// verbatim, exactly as written.
// One-line intro/closing, human bullets stay verbatim; narrow work, so Haiku.
const LINE_MODEL = MODELS.haiku;

async function draftLine(instruction: string, fallback: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: anthropic(LINE_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "notifyTesters.draftLine" },
      prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} You're texting someone who's helping test Co before launch. ${instruction} No greeting, no "Hey", no using their name — that's handled separately. No em dashes, no exclamation points. Return ONLY that one short line, nothing else.`,
    });
    const trimmed = text.trim();
    return trimmed || fallback;
  } catch (err: any) {
    console.error("notifyTesters: draftLine failed (non-fatal, using default):", err?.message ?? err);
    return fallback;
  }
}

async function readStdin(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function main() {
  const argUpdates = process.argv.slice(2);
  const updates = argUpdates.length ? argUpdates : await readStdin();
  if (!updates.length) {
    console.error(`Usage: npm run notify-testers -- "<update 1>" "<update 2>" ...\n   or: npm run notify-testers <<'EOF' (one update per line, apostrophe-safe)`);
    process.exit(1);
  }

  // NOTIFY_INTRO / NOTIFY_CLOSING pin the exact lines (e.g. after the text
  // was approved word for word); otherwise they're drafted.
  const intro = process.env.NOTIFY_INTRO ?? await draftLine(
    "Write a short, warm phrase thanking them for helping test Co and saying here's what's new.",
    "thanks for helping test Co. Here's what's new:",
  );
  const closing = process.env.NOTIFY_CLOSING ?? await draftLine(
    "Write a short, warm closing line inviting them to share what they think after trying it.",
    "Let Co know what you think once you've had a chance to try it.",
  );
  // Blank line between bullets (Royce, 2026-08-31: "put some spacing
  // between bullet points") — cramped together read as one dense block on
  // a phone screen.
  const bulletList = updates.map((u) => `• ${u}`).join("\n\n");

  // Persisted independent of who's on TESTER_FIRST_NAMES below — someone
  // who joins co-test later and asks Co "any updates?" should still get
  // this, even though they weren't a recipient of the original text.
  await pool
    .query(`INSERT INTO product_updates (content) VALUES ($1)`, [bulletList])
    .catch((err: any) => console.error("notifyTesters: product_updates write failed (non-fatal):", err?.message ?? err));

  // Scoped to named testers only (Royce, 2026-08-31: "make sure the
  // testers are only Me and Jacqueline") — NOT every co-test user, despite
  // this being the co-test database. Name-filtered rather than by
  // hardcoded phone/email so it stays correct without baking in contact
  // details here; update this list directly as the tester group changes.
  // Royce, 2026-09-15: "send to all co-test users" (Royce, Jacqueline, Celine).
  const TESTER_FIRST_NAMES = ["Royce", "Jacqueline", "Celine"];
  const { rows: users } = await pool.query(
    `SELECT id, first_name, phone_number FROM users WHERE phone_number IS NOT NULL AND first_name = ANY($1)`,
    [TESTER_FIRST_NAMES],
  );
  if (!users.length) {
    console.log(`notifyTesters: no matching testers (${TESTER_FIRST_NAMES.join(", ")}) found with a phone number on file — update saved, but nothing texted.`);
    process.exit(0);
  }

  // Layer 7 (2026-09-14): queued as a "product_update" candidate, not sent
  // directly. The proactive harness sends it inside the person's local
  // hours, at most one update a week, and never on a day Co already texted
  // them first or while an earlier text is still unanswered.
  const updateKey = createHash("sha1").update(bulletList).digest("hex").slice(0, 16);
  let queuedCount = 0;
  for (const user of users) {
    const { queued } = await enqueueCandidate({
      userId: user.id,
      type: "product_update",
      targetKey: `product_update:${updateKey}`,
      summary: `Product update for testers: ${updates.join("; ").slice(0, 200)}`,
      payload: { intro: cleanCoMessage(intro), closing: cleanCoMessage(closing), bulletList },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    if (queued) queuedCount++;
    console.log(`notifyTesters: ${queued ? "queued" : "already queued or sent"} for ${user.id}`);
  }

  console.log(`notifyTesters: done — queued for ${queuedCount}/${users.length} user(s); the proactive harness sends it.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("notifyTesters: fatal error:", err?.message ?? err);
  process.exit(1);
});
