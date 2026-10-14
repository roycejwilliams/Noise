// Model-free checks for "never go silent" (services/turnFailure.ts and its
// wiring in routes/sendblue.ts). No network.
//
//   npx tsx evals/silence/rules.ts
import { readFileSync } from "fs";
import { TURN_FAILED_NOTE, turnFailedNoteBlocked, TURN_FAILED_NOTE_COOLDOWN_MS } from "../../src/services/turnFailure.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// The client wants a key at import; nothing here sends.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { cleanCoMessage } = await import("../../src/services/sendblue.js");

const now = new Date("2026-09-23T20:00:00Z");
const base = { member: { optedOut: false, archived: false }, coRepliedSince: false, lastNoteAt: null, receivedAt: new Date(now.getTime() - 30_000), now };
check("a crashed turn gets the note", turnFailedNoteBlocked(base) === null);
check("never to someone who opted out", turnFailedNoteBlocked({ ...base, member: { optedOut: true, archived: false } }) === "opted_out");
check("never to an archived account", turnFailedNoteBlocked({ ...base, member: { optedOut: false, archived: true } }) === "archived");
check("never to an unknown number", turnFailedNoteBlocked({ ...base, member: null }) === "no_member");
check("not when Cue answered anyway", turnFailedNoteBlocked({ ...base, coRepliedSince: true }) === "already_answered");
check("one note per outage, not a string of apologies", turnFailedNoteBlocked({ ...base, lastNoteAt: new Date(now.getTime() - 60_000) }) === "just_told_them");
check("a later failure gets a fresh note", turnFailedNoteBlocked({ ...base, lastNoteAt: new Date(now.getTime() - TURN_FAILED_NOTE_COOLDOWN_MS - 1000) }) === null);
check("a text from hours ago isn't answered out of nowhere", turnFailedNoteBlocked({ ...base, receivedAt: new Date(now.getTime() - 3 * 3600_000) }) === "too_old");

check("the note owns the miss without asking them to redo anything, and promises no retry", !/send it again|resend/i.test(TURN_FAILED_NOTE) && !/\b(I'll|I will|retry|trying again|give me a)\b/i.test(TURN_FAILED_NOTE));
check("the note survives Cue's send cleanup unchanged (so the cooldown can find it)", cleanCoMessage(TURN_FAILED_NOTE) === TURN_FAILED_NOTE);
check("no em dashes", !/[—–]/.test(TURN_FAILED_NOTE));

const sb = src("src/routes/sendblue.ts");
check("a turn that crashes after the text was read tells the member", /if \(lockKey && isGenuineInbound && !isGroupMessage\) \{\n\s+await tellMemberTurnFailed\(lockKey, replay\?\.receivedAt \?\? turnStartedAt, "turn_error"/.test(sb));
check("hold lines ('one sec') don't count as having answered", /r\.content <> ALL\(\$3::text\[\]\)/.test(sb) && /\[\.\.\.HOLD_LINES, \.\.\.OWED_AFTER\]\.map\(\(l\) => `Co replied: \$\{l\}`\), `Co replied: \$\{TURN_FAILED_NOTE\}`/.test(sb));
check("a restart mid-turn tells the member too (1:1 texts only)", /await tellMemberTurnFailed\(phone, new Date\(row\.received_at\), "restart"/.test(sb) && /!isGroup\)/.test(sb));
check("every outcome is logged as turn.failed", /decision: "turn\.failed"/.test(sb));
check("the columns the restart check reads actually exist", /ALTER TABLE inbound_webhook_handles ADD COLUMN IF NOT EXISTS payload JSONB, ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ/.test(src("src/db/migrations.ts")));
check("saved message copies are dropped after two days", /SET payload = NULL WHERE payload IS NOT NULL AND received_at < NOW\(\) - INTERVAL '2 days'/.test(sb));
check("co-test runs the restart check too", /reportUnfinishedTurns\(\)/.test(src("../co-test/src/server.ts")));

console.log(`silence rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
