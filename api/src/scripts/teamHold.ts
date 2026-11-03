// A team-side hold (services/teamHold.ts): quiet one member for a reason, until it expires. Team only; nothing member-facing reads it.
// Replies to their own texts and safety follow-ups still go; everything else Cue sends or calls waits for the expiry.
//
//   npx tsx src/scripts/teamHold.ts <user id>                                             show the hold in force, if any
//   npx tsx src/scripts/teamHold.ts <user id> --set --by royce --reason "tester" --hours 48 set one (or --until 2026-11-09T17:00Z)
//   npx tsx src/scripts/teamHold.ts <user id> --lift --by royce                           lift it early (the row stays)
//
// On co-test, where this scripts folder isn't built:
//   node --input-type=module -e "const m = await import('/app/co-test/dist/api/src/services/teamHold.js'); console.log(await m.setTeamHold({ userId: '<id>', setBy: 'royce', reason: 'tester', expiresAt: new Date(Date.now() + 48 * 3600e3) }))"
import "dotenv/config";
import pool from "../db/db.js";
import { activeTeamHold, liftTeamHold, setTeamHold } from "../services/teamHold.js";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const userId = args[0];
try {
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("give the member's user id first");
  if (args.includes("--set")) {
    const hours = arg("hours");
    const expiresAt = arg("until") ? new Date(String(arg("until"))) : hours ? new Date(Date.now() + Number(hours) * 3_600_000) : new Date(NaN);
    const h = await setTeamHold({ userId, setBy: String(arg("by") ?? ""), reason: String(arg("reason") ?? ""), expiresAt });
    console.log(`hold ${h.id} set by ${h.setBy} until ${h.expiresAt.toISOString()}`);
  } else if (args.includes("--lift")) {
    console.log(`lifted ${await liftTeamHold({ userId, liftedBy: String(arg("by") ?? "") })} hold(s)`);
  } else {
    const h = await activeTeamHold(userId);
    console.log(h ? `hold ${h.id}: set by ${h.setBy} at ${h.setAt.toISOString()}, until ${h.expiresAt.toISOString()}; reason: ${h.reason}` : "No team hold in force.");
  }
} catch (err: any) {
  console.error("teamHold failed:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
