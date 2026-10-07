// Member-facing Mo is off by default, and the switch really gates it: every entry point (the three jobs, the tools Co is
// given, the four proactive texts, the capability sheet, the DM front desk) does nothing for a member while it is off, and
// a stranger's "stop" is still honored. Model-free, against a fake database.
//   npx tsx evals/mo/memberGate.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.MO_MEMBER_ENABLED;
delete process.env.MO_ENABLED;
const { default: pool } = await import("../../src/db/db.js");
const J = await import("../../src/mo/memberJobs.js");
const C = await import("../../src/services/capabilities.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const { moRuntime } = await import("../../src/mo/extension.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

const log: { sql: string; p: any[] }[] = [];
let candidateRow: any = null;
(pool as any).query = async (sql: string, p: any[] = []) => {
  log.push({ sql, p });
  if (/FROM mo_member_candidates WHERE x_user_id = \$1 AND status IN/.test(sql)) return { rows: candidateRow ? [candidateRow] : [] };
  return { rows: [], rowCount: 0 };
};
const ran = (re: RegExp) => log.some((l) => re.test(l.sql));
const set = (member: string | undefined, team: string | undefined) => {
  if (member === undefined) delete process.env.MO_MEMBER_ENABLED; else process.env.MO_MEMBER_ENABLED = member;
  if (team === undefined) delete process.env.MO_ENABLED; else process.env.MO_ENABLED = team;
};
const tools = () => Object.keys(createConversationTools({ userId: "u1", phoneNumber: "+10000000000", resolvedContent: "yes", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, sendCoReply: async () => true, notDone: () => {} } as any).tools);
const MO_TOOLS = C.memberMoTools();
const MO_TYPES = ["mo_member_offer", "mo_member_voice", "mo_member_batch", "mo_member_update"] as const;
const cand = (over: any = {}) => ({ id: "c1", batch_id: "b1", user_id: "u1", n: 1, x_user_id: "x99", x_handle: "noor", name: "Noor Hale", email: null, source: "x", status: "contacted", last_dm_event_id: null, ...over });

check("there are member Mo tools to gate", MO_TOOLS.length >= 5);

// ---- the default: nothing set means off
for (const [label, m, t] of [["neither switch set (the default)", undefined, undefined], ["only MO_MEMBER_ENABLED", "true", undefined], ["only MO_ENABLED (team Mo on)", undefined, "true"], ["MO_MEMBER_ENABLED=1 (only the exact 'true' counts)", "1", "true"], ["MO_MEMBER_ENABLED=false", "false", "true"]] as const) {
  set(m, t);
  check(`off with ${label}: both switches read off`, !J.memberMoEnabled() && !C.memberMoOn() && !J.memberMoCanSend());
  log.length = 0;
  const hunts = await J.runMemberHunts();
  const offers = await J.runMemberOffers();
  const out = await J.runMemberOutreach();
  check(`off with ${label}: the three jobs do nothing and read nothing`, hunts.hunted === 0 && offers === 0 && out.sent === 0 && out.joined === 0 && log.length === 0);
  const ts = tools();
  check(`off with ${label}: Co is given none of member Mo's tools`, MO_TOOLS.every((n) => !ts.includes(n)));
  const sheet = C.capabilitySheet().join("\n");
  check(`off with ${label}: Co's capability sheet never mentions member Mo`, !/\bMo\b/.test(sheet));
  for (const type of MO_TYPES) {
    log.length = 0;
    const r: any = await proactiveRegistry[type]!.draft({ userId: "u1", type, payload: { need: "a designer", candidateId: "c1", kind: "question" } } as any, { firstName: "Rae" } as any);
    check(`off with ${label}: the ${type} text is skipped before any read`, r?.skip === "member Mo is off" && log.length === 0);
  }
  // the front desk
  candidateRow = cand();
  log.length = 0;
  const handled = await J.handleMemberDm({ id: "200", senderId: "x99", text: "what is this about?", createdAt: new Date() } as any);
  check(`off with ${label}: a stranger's question is taken off the team's path but nothing is said or recorded`, handled === true && !ran(/mo_contact_receipts/) && !ran(/mo_suppression/) && !ran(/UPDATE mo_member_candidates/));
  log.length = 0;
  await J.handleMemberDm({ id: "201", senderId: "x99", text: "STOP", createdAt: new Date() } as any);
  check(`off with ${label}: a stranger's stop is still honored (club-wide do-not-contact, and they're marked declined)`, log.some((l) => /INSERT INTO mo_suppression/.test(l.sql) && l.p[0] === "x:x99") && ran(/SET status = 'declined'/));
  candidateRow = null;
  log.length = 0;
  check(`off with ${label}: a DM from someone who isn't a member's person is left to the team's path`, (await J.handleMemberDm({ id: "202", senderId: "x1", text: "hi", createdAt: new Date() } as any)) === false);
}

// ---- on: the same entry points open (so the checks above are testing the switch, not something else)
set("true", "true");
check("on: both switches read on", J.memberMoEnabled() && C.memberMoOn());
check("on: Co is given every member Mo tool", MO_TOOLS.every((n) => tools().includes(n)));
check("on: the capability sheet lists member Mo", /\bMo\b/.test(C.capabilitySheet().join("\n")));
log.length = 0;
await J.runMemberHunts();
check("on: the weekly hunt reads its members", ran(/FROM mo_member_optin o JOIN users u/));
log.length = 0;
const r: any = await proactiveRegistry.mo_member_update!.draft({ userId: "u1", type: "mo_member_update", payload: { candidateId: "c1", kind: "question" } } as any, { firstName: "Rae" } as any);
check("on: the proactive update reads the member's own row (and only theirs)", r?.skip !== "member Mo is off" && log.some((l) => /FROM mo_member_candidates WHERE id = \$1 AND user_id = \$2/.test(l.sql) && l.p[1] === "u1"));

// ---- the jobs are registered, and each one is gated inside (so registering them alone sends nothing)
const names = (moRuntime.jobs ?? []).map((j) => j.name);
check("the three member jobs are registered with Mo", ["mo member offers", "mo member hunts", "mo member outreach"].every((n) => names.includes(n)));

set(undefined, undefined);
console.log(`member Mo gate: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
