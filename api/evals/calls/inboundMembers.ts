// Inbound calls reach only members (Royce, 2026-10-16: the call fix merges before partner guests, #212). A users row isn't membership:
// every texter has one, partner-night guests included, and a call gets the full call agent. Zero tokens; the database is a stub.
//   npx tsx evals/calls/inboundMembers.ts
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const G = await import("../../src/harness/callGate.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  }
};
const db = (row: any) => ({ query: async () => ({ rows: row ? [row] : [] }) });
const member = { id: "u-member", invite_verified: true, identity_captured: true, archived_at: null };

check("a member's call reaches the call agent", (await G.inboundCallMember("+14155550101", db(member))).userId === "u-member");
const guest = await G.inboundCallMember("+14155550102", db({ ...member, id: "u-guest", invite_verified: false }));
check("a partner-night guest (texted the door QR, never a member) is declined like an unknown number", guest.userId === null && /not a member/.test(guest.why ?? ""));
check("an applicant whose code isn't verified is declined", (await G.inboundCallMember("+14155550103", db({ ...member, invite_verified: null }))).userId === null);
check("an archived account is declined", (await G.inboundCallMember("+14155550104", db({ ...member, archived_at: new Date() }))).userId === null);
// Ruling A (2026-11-02): an invited member whose name or email isn't on file yet is a member; the first call asks for the email once.
check("an invited member without name or email on file yet is admitted (ruling A: never a condition)", (await G.inboundCallMember("+14155550105", db({ ...member, identity_captured: false }))).userId === "u-member");
check("no account, or no caller number: declined", (await G.inboundCallMember("+14155550106", db(null))).userId === null && (await G.inboundCallMember(null, db(member))).userId === null);
const route = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
const handler = route.slice(route.indexOf('"/incoming-call"'), route.indexOf("registerElevenLabsCall({", route.indexOf('"/incoming-call"')));
check("the inbound call route reads the caller through the member check, before anything is loaded",
  /const caller = await inboundCallMember\(from\);/.test(handler) && !/SELECT id FROM users WHERE phone_number = \$1/.test(handler) && handler.indexOf("inboundCallMember(from)") < handler.indexOf("buildCallContextSummary"));
check("a declined caller hears the same line as an unknown number (no new words)", /we don't recognize this number/.test(handler));

console.log(`inbound members: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
