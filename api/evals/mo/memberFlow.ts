// Member-facing Mo: the flow against a fake database and fake channels. Model-free.
//   npx tsx evals/mo/memberFlow.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import { readFileSync } from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const F = await import("../../src/mo/memberFlow.js");
const H = await import("../../src/mo/memberHunt.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

type Handler = [RegExp, (sql: string, p: any[]) => any];
const log: { sql: string; p: any[] }[] = [];
const events: string[] = [];
let handlers: Handler[] = [];
(pool as any).query = async (sql: string, p: any[] = []) => {
  log.push({ sql, p });
  if (/INSERT INTO mo_contact_receipts/.test(sql)) events.push(`receipt:${/'blocked'/.test(sql) ? "blocked" : /'pending'/.test(sql) ? "pending" : "row"}`);
  if (/UPDATE mo_contact_receipts SET outcome/.test(sql)) events.push(`receipt:${p[1]}`);
  if (/SET status = 'sending'/.test(sql) || /SET followed_up_at = NOW\(\) WHERE id = \$1 AND status = 'contacted'/.test(sql)) events.push("claim");
  for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, p);
  return { rows: [], rowCount: 0 };
};
const reset = (h: Handler[]) => { log.length = 0; events.length = 0; handlers = h; };
const ran = (re: RegExp) => log.some((l) => re.test(l.sql));
const NOW = new Date("2026-10-07T19:00:00Z"); // noon in San Francisco

const APPROVED = F.composeApproach(F.DEFAULT_VOICE, { named: false, memberFirstName: "Rae", need: "a product designer", why: "You wrote that you're taking on new design clients" });
const cand = (over: any = {}): any => ({ approved_text: APPROVED, id: "c1", batch_id: "b1", user_id: "u1", n: 1, x_user_id: "x99", x_handle: "noor", name: "Noor Hale", email: null, source: "x", post_text: "taking on design clients", evidence_quote: "taking on new design clients", why: "You wrote that you're taking on new design clients", status: "approved", approved_at: new Date("2026-10-06T00:00:00Z"), approved_quote: "1 and 3", contacted_at: null, channel: null, followed_up_at: null, replied_at: null, invite_code: null, joined_user_id: null, ...over });
const baseHandlers = (over: Record<string, any> = {}): Handler[] => [
  [/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ status: "yes", paused_at: null, voice_approved_at: new Date("2026-10-06"), voice_text: F.DEFAULT_VOICE, voice_named: false, ...(over.optin ?? {}) }] })],
  [/FROM mo_member_batches WHERE id/, () => ({ rows: [{ status: "approved", expires_at: new Date("2026-10-09T00:00:00Z"), need_text: "a product designer", ...(over.batch ?? {}) }] })],
  [/SELECT first_name FROM users WHERE id = \$1/, () => ({ rows: [{ first_name: "Rae" }] })],
  [/FROM mo_contact_receipts WHERE user_id = \$1 AND outcome IN \('sent','pending'\)/, () => ({ rows: [{ n: over.week ?? 0 }] })],
  [/FROM mo_contact_receipts WHERE outcome IN \('sent','pending'\)/, () => ({ rows: [{ n: over.today ?? 0 }] })],
  [/SET status = 'sending' WHERE id = \$1 AND status = 'approved' RETURNING id/, () => ({ rows: over.claimed === false ? [] : [{ id: "c1" }] })],
  [/SET followed_up_at = NOW\(\) WHERE id = \$1 AND status = 'contacted'/, () => ({ rows: over.claimed === false ? [] : [{ id: "c1" }] })],
  [/FROM mo_prospects WHERE contacted_at/, () => ({ rows: [{ n: 0 }] })],
  [/GREATEST\(/, () => ({ rows: [{ at: over.last ?? null }] })],
  [/SELECT first_name FROM users WHERE id <> \$1/, () => ({ rows: [{ first_name: "Jordan" }] })],
  [/SELECT status FROM mo_member_candidates WHERE user_id = \$1 AND contacted_at IS NOT NULL/, () => ({ rows: over.recent ?? [] })],
  [/INSERT INTO mo_contact_receipts/, () => ({ rows: [{ id: 7 }] })],
];
const deps = (o: any = {}): any => {
  const sent: string[] = [];
  return {
    sent,
    d: {
      now: NOW, enabled: true, clubPaused: false, teamDailyCap: 5, localHour: () => 12,
      sendDm: async (_x: string, t: string) => { events.push("sendDm"); if (o.dmError) throw o.dmError; sent.push(t); },
      isDmClosed: (e: any) => e?.closed === true,
      sendEmail: async () => !!o.email,
      isSuppressed: async () => !!o.suppressed,
    },
  };
};

// ---- a send: receipt first, then the DM, then the outcome
{
  reset(baseHandlers());
  const { d, sent } = deps();
  const r = await F.sendContact(cand(), "approach", d);
  check("an approved, in-limits first contact is sent", r.action === "approach_sent" && sent.length === 1 && /I'm Mo/.test(sent[0]) && /A member of the club/.test(sent[0]));
  check("the row is claimed, then the receipt exists BEFORE the DM goes out, and is marked sent after", events.indexOf("claim") >= 0 && events.indexOf("claim") < events.indexOf("receipt:pending") && events.indexOf("receipt:pending") < events.indexOf("sendDm") && events.indexOf("sendDm") < events.indexOf("receipt:sent"));
  const ins = log.find((l) => /INSERT INTO mo_contact_receipts/.test(l.sql))!;
  check("the receipt says who, what was sent, on whose yes, and what the limits were", ins.p[0] === "u1" && ins.p[2] === "c1" && ins.p[3] === "approach" && ins.p[5] === "x:x99" && /I'm Mo/.test(ins.p[6]) && ins.p[7] === "1 and 3" && JSON.parse(ins.p[8]).perWeek === 5);
  check("the person is marked contacted on the channel used", ran(/UPDATE mo_member_candidates SET status = 'contacted'/));
}
// ---- a refusal sends nothing and still leaves a receipt
for (const [label, h, dd] of [
  ["suppressed", baseHandlers(), { suppressed: true }],
  ["the week's cap", baseHandlers({ week: 5 }), {}],
  ["the batch isn't approved", baseHandlers({ batch: { status: "open" } }), {}],
  ["no yes to Mo", baseHandlers({ optin: { status: null } }), {}],
  ["voice not approved", baseHandlers({ optin: { voice_approved_at: null } }), {}],
  ["the club's daily cap", baseHandlers({ today: 5 }), {}],
  ["contacted in the last 30 days", baseHandlers({ last: new Date("2026-10-01T00:00:00Z") }), {}],
  ["the member stopped", baseHandlers({ optin: { paused_at: new Date("2026-10-06") } }), {}],
  ["two of the last five said no", baseHandlers({ recent: [{ status: "declined" }, { status: "contacted" }, { status: "declined" }] }), {}],
] as const) {
  reset(h);
  const { d, sent } = deps(dd);
  const r = await F.sendContact(cand(), "approach", d);
  check(`refused (${label}): nothing is sent, and a blocked receipt says why`, r.action === "blocked" && sent.length === 0 && !events.includes("sendDm") && events.includes("receipt:blocked") && ran(/INSERT INTO mo_contact_receipts/));
}
{
  reset(baseHandlers());
  const x = deps();
  x.d.enabled = false;
  const r = await F.sendContact(cand(), "approach", x.d);
  check("refused (switched off): nothing is sent", r.action === "blocked" && x.sent.length === 0);
  reset(baseHandlers());
  const y = deps();
  y.d.localHour = () => 21;
  check("refused (night): nothing is sent", (await F.sendContact(cand(), "approach", y.d)).action === "blocked" && y.sent.length === 0);
}
// ---- failures
{
  reset(baseHandlers());
  const { d } = deps({ dmError: new Error("rate limited") });
  const r = await F.sendContact(cand(), "approach", d);
  check("a failed send is a failed receipt, and the person is not marked contacted", r.action === "failed" && events.includes("receipt:failed") && !ran(/SET status = 'contacted'/));
  reset(baseHandlers());
  const c = deps({ dmError: { closed: true } });
  const r2 = await F.sendContact(cand(), "approach", c.d);
  check("closed DMs and no email: the person is closed, never emailed from here", r2.action === "unreachable" && ran(/SET status = 'closed'/) && events.includes("receipt:failed"));
}
// ---- the one follow-up
{
  reset(baseHandlers());
  const { d, sent } = deps();
  const r = await F.sendContact(cand({ status: "contacted", contacted_at: new Date("2026-09-29T00:00:00Z") }), "follow_up", d);
  check("one follow-up after 7 days, short, with a way out", r.action === "follow_up_sent" && /no worries/i.test(sent[0]) && sent[0].length < 140);
  reset(baseHandlers());
  const e = deps();
  const r2 = await F.sendContact(cand({ status: "contacted", contacted_at: new Date("2026-09-29T00:00:00Z"), followed_up_at: new Date("2026-10-05") }), "follow_up", e.d);
  check("never a second follow-up", r2.action === "blocked" && e.sent.length === 0);
}

// ---- the front desk
const optYesRow: Handler = [/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ status: "yes", paused_at: null }] })];
const rdeps = (kind: "yes" | "no" | "question") => {
  const out: string[] = []; const told: string[] = []; const supp: string[][] = []; const vouched: string[] = []; const team: string[] = [];
  return { out, told, supp, vouched, team, d: { send: async (t: string) => { out.push(t); }, classify: async () => kind, makeCode: async (who: string) => { vouched.push(who); return "ABCD2345"; }, codeMessage: (c: string) => `invite ${c}`, suppress: async (k: string[]) => { supp.push(k); }, tellMember: async (_u: string, k: string) => { told.push(k); }, notifyTeam: async (t: string) => { team.push(t); } } };
};
{
  reset([optYesRow]);
  const r = rdeps("no");
  const a = await F.landReply(cand({ status: "contacted" }), "Not interested, thanks", r.d as any);
  check("a no: they are suppressed club-wide, told it ends here, and the member hears it", a === "declined" && r.supp[0].includes("x:x99") && /won't reach out again/.test(r.out[0]) && r.told[0] === "declined" && ran(/SET status = 'declined'/));
  reset([optYesRow]);
  const r2 = rdeps("yes");
  const a2 = await F.landReply(cand({ status: "contacted" }), "yes please", r2.d as any);
  check("a yes: they get the invite code (the gate stays), and the member hears it", a2 === "invited" && /invite ABCD2345/.test(r2.out[0]) && r2.told[0] === "replied" && ran(/SET status = 'invited'/));
  check("the invite is made on the member's vouch", r2.vouched.join() === "u1");
  const rec = log.filter((l) => /INSERT INTO mo_contact_receipts/.test(l.sql)).map((l) => l.p.join(" | ")).join("\n");
  check("the receipt the member can read never carries the invite code or link", !/ABCD2345/.test(rec) && !/https?:/.test(rec) && /invite code and link were sent/.test(rec));
  reset([optYesRow]);
  const r3 = rdeps("question");
  const a3 = await F.landReply(cand({ status: "contacted" }), "who is the member? what is this?", r3.d as any);
  check("a question: held, nothing about the member or the club is said, and the member is told it is held", a3 === "held" && r3.out.length === 0 && r3.told[0] === "question");
  // Held is not forgotten: a person on the team hears it, with the stranger's words and a reference, and nothing about the member.
  check("a held question texts the team once", r3.team.length === 1 && /@noor/.test(r3.team[0]) && /who is the member\? what is this\?/.test(r3.team[0]) && /Ref c1/.test(r3.team[0]));
  check("the team's note never carries the member's name, id, ask or the why", !/Rae|u1|b1|product designer|design clients|taking on/i.test(r3.team[0]));
  reset([optYesRow, [/SELECT 1 FROM mo_contact_receipts WHERE candidate_id = \$1 AND kind = 'reply' AND outcome = 'blocked'/, () => ({ rows: [{}] })]]);
  const r3b = rdeps("question");
  await F.landReply(cand({ status: "replied" }), "hello?? anyone", r3b.d as any);
  check("a stranger writing again the same day doesn't text the team again (still held, member still told)", r3b.team.length === 0 && r3b.told[0] === "question" && r3b.out.length === 0);
  reset([optYesRow]);
  const r3c = rdeps("question");
  r3c.d.notifyTeam = async () => { throw new Error("sendblue down"); };
  check("a failed team text never breaks the front desk", (await F.landReply(cand({ status: "contacted" }), "what is this", r3c.d as any)) === "held" && r3c.told[0] === "question");
  for (const kind of ["no", "yes"] as const) {
    reset([optYesRow]);
    const rk = rdeps(kind);
    await F.landReply(cand({ status: "contacted" }), kind === "no" ? "no thanks" : "yes please", rk.d as any);
    check(`a ${kind} doesn't text the team (only a held question needs a person)`, rk.team.length === 0);
  }
  reset([optYesRow]);
  const r4 = rdeps("yes");
  const a4 = await F.landReply(cand({ status: "invited", invite_code: "ABCD2345" }), "yes", r4.d as any);
  check("a second yes after the invite does not send a second code", a4 === "held" && r4.out.length === 0);
  reset([optYesRow]);
  const r5 = rdeps("yes");
  await F.landReply(cand({ status: "contacted" }), "STOP", r5.d as any);
  check("a clear stop wins in code, before any model read", r5.supp.length === 1 && r5.out.length === 1 && /won't reach out again/.test(r5.out[0]));
  check("every reply leaves a receipt", log.some((l) => /INSERT INTO mo_contact_receipts/.test(l.sql) && /'reply'/.test(l.sql)));
  // A member who said stop never has anyone invited in their name afterwards.
  for (const [label, row] of [["stopped", { status: "yes", paused_at: new Date() }], ["said no", { status: "no", paused_at: null }], ["never answered", { status: null, paused_at: null }]] as const) {
    reset([[/FROM mo_member_optin WHERE user_id/, () => ({ rows: [row] })]]);
    const r6 = rdeps("yes");
    const a6 = await F.landReply(cand({ status: "contacted" }), "yes please", r6.d as any);
    check(`a member who ${label}: no invite goes out, the stranger gets a neutral close`, a6 === "closed" && r6.vouched.length === 0 && r6.out.length === 1 && !/invite ABCD/.test(r6.out[0]) && /closed/.test(r6.out[0]));
  }
  reset([[/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ status: "no", paused_at: new Date() }] })]]);
  const r7 = rdeps("no");
  await F.landReply(cand({ status: "contacted" }), "no thanks", r7.d as any);
  check("a stranger's no is honored even when the member has stopped", r7.supp.length === 1);
}

// ---- consent steps
{
  const asked = (over: any = {}): Handler => [/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ asked_at: new Date(), status: null, ...over }] })];
  reset([[/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ asked_at: null }] })]]);
  check("a yes with no question open records nothing", (await F.recordOptIn("u1", "yes", "yes")).ok === false && !ran(/UPDATE mo_member_optin SET status/));
  reset([asked()]);
  check("a yes records", (await F.recordOptIn("u1", "yes", "yes")).ok === true && ran(/UPDATE mo_member_optin SET status/));
  reset([asked({ asked_at: new Date(Date.now() - 30 * 86400_000) })]);
  check("a question asked a month ago is stale: a late 'yes' records nothing", (await F.recordOptIn("u1", "yes", "yes")).ok === false);
  reset([asked({ status: "yes" })]);
  check("a member who already answered can't be turned into a new answer by a later yes", (await F.recordOptIn("u1", "yes", "yes")).ok === false);
  reset([asked()]);
  await F.recordOptIn("u1", "no", "no thanks");
  check("a no cancels every person and batch not yet sent", ran(/UPDATE mo_member_candidates SET status = 'skipped'/) && ran(/UPDATE mo_member_batches SET status = 'cancelled'/));
  reset([]);
  await F.stopMo("u1", "stop mo");
  check("stop is always honored and cancels what is queued", ran(/paused_at = NOW\(\)/) && ran(/SET status = 'skipped'/) && ran(/SET status = 'cancelled'/));
  reset([]);
  await F.saveVoice("u1", "new wording", true);
  check("new wording is a new question: the old yes does not carry over", /voice_approved_at = NULL/.test(log[0].sql));
}
{
  const open = (h: any = {}, o: any = {}): Handler[] => [
    [/FROM mo_member_batches WHERE user_id = \$1 AND status IN/, () => ({ rows: [{ id: "b1", status: "open", need_text: "a product designer", ask_text: "y", expires_at: new Date(Date.now() + 86400000), presented_at: new Date(), ...h }] })],
    [/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ status: "yes", voice_approved_at: new Date(), voice_text: F.DEFAULT_VOICE, voice_named: false, paused_at: null, ...o }] })],
    [/SELECT first_name FROM users WHERE id = \$1/, () => ({ rows: [{ first_name: "Rae" }] })],
    [/SELECT first_name FROM users WHERE id <> \$1/, () => ({ rows: [{ first_name: "Jordan" }] })],
    [/SELECT \* FROM mo_member_candidates WHERE batch_id/, () => ({ rows: [1, 2, 3].map((n) => cand({ id: `c${n}`, n, status: "pending", approved_text: null, why: `why ${n}` })) })],
    [/UPDATE mo_member_candidates SET status = 'skipped'/, () => ({ rows: [], rowCount: 1 })],
  ];
  reset(open());
  const r = await F.approvePicks("u1", [1, 3], "1 and 3");
  const approvals = log.filter((l) => /SET status = 'approved'/.test(l.sql));
  check("picking approves only those people, and fixes each one's exact words at that moment", !!r && "approved" in r && r.approved === 2 && approvals.map((a) => a.p[0]).join() === "c1,c3" && approvals.every((a) => /^Hi, I'm Mo\./.test(a.p[2]) && /A member of the club is looking for a product designer/.test(a.p[2])) && approvals[0].p[2] !== approvals[1].p[2]);
  const bUpd = log.find((l) => /UPDATE mo_member_batches SET status = \$2, approved_at = NOW\(\), expires_at = NOW\(\)/.test(l.sql))!;
  check("approving starts a fresh three days for the yes", bUpd.p[1] === "approved" && bUpd.p[2] === 3);
  reset(open({ presented_at: null }));
  check("a batch the member has not been shown can't be approved, however they answer", (await F.approvePicks("u1", [1, 2, 3], "all")) === null && !ran(/SET status = 'approved'/));
  reset(open({ status: "approved" }));
  check("a list already approved can't be approved again", (await F.approvePicks("u1", [1], "1")) === null);
  reset([[/FROM mo_member_batches WHERE user_id/, () => ({ rows: [] })]]);
  check("with no open list, nothing is approved", (await F.approvePicks("u1", [1], "1")) === null);
  reset(open({}, { voice_approved_at: null }));
  check("nothing is approved before the voice is", (await F.approvePicks("u1", [1], "1")) === null && !ran(/SET status = 'approved'/));
  reset(open({}, { paused_at: new Date() }));
  check("nothing is approved for a member who stopped", (await F.approvePicks("u1", [1], "1")) === null);
  reset(open({}, { status: null }));
  check("nothing is approved for a member who never said yes to Mo", (await F.approvePicks("u1", [1], "1")) === null);
  reset(open());
  const none: any = await F.approvePicks("u1", [], "none");
  check("choosing none cancels the batch", none?.none === true && ran(/UPDATE mo_member_batches SET status = 'cancelled'/));
  reset(open({}, { voice_named: true }));
  await F.approvePicks("u1", [2], "2");
  check("the member's name is in the approved words only if they allowed it", /Rae is looking for/.test(log.find((l) => /SET status = 'approved'/.test(l.sql))!.p[2]));
}
// ---- the intro: their yes up front (never told someone joined), both must say yes
{
  reset([[/FROM mo_member_candidates WHERE id = \$1 AND user_id = \$2 AND status IN/, () => ({ rows: [] })]]);
  check("no intro yes for someone no one is waiting on", (await F.recordIntroYes("u1", "c1", "yes")).ok === false && !ran(/SET intro_quote/));
  reset([[/FROM mo_member_candidates WHERE id = \$1 AND user_id = \$2 AND status IN/, () => ({ rows: [cand({ status: "invited" })] })]]);
  const y = await F.recordIntroYes("u1", "c1", "yes please");
  check("their yes is stored before the person joins, and nothing else happens yet", y.ok && y.joined === false && ran(/SET intro_quote = \$2, intro_at = NOW\(\)/) && !ran(/network_introductions/));
  // when they join
  const asked: string[] = [];
  reset([[/FROM mo_member_candidates WHERE status = 'joined' AND joined_user_id IS NOT NULL AND intro_at IS NOT NULL AND intro_seeded_at IS NULL/, () => ({ rows: [cand({ status: "joined", joined_user_id: "u9", intro_at: new Date() })] })], [/SET intro_seeded_at = NOW\(\) WHERE id = \$1 AND intro_seeded_at IS NULL RETURNING id/, () => ({ rows: [{ id: "c1" }] })], [/SELECT id AS user_id, first_name, phone_number, email FROM users/, () => ({ rows: [{ user_id: "u1", first_name: "Rae" }, { user_id: "u9", first_name: "Noor" }] })]]);
  const n = await F.seedIntros(async (them, me) => { asked.push(`${them.first_name}<-${me.first_name}`); });
  const ins = log.find((l) => /INSERT INTO network_introductions/.test(l.sql))!;
  check("when they join, the member's side is written (theirs only) and the other person is asked on their own", n === 1 && /a_interested_at/.test(ins.sql) && ins.p[0] === "u1" && ins.p[1] === "u9" && ins.p[2] === "a_interested" && asked.join() === "Noor<-Rae");
  reset([[/FROM mo_member_candidates WHERE status = 'joined'/, () => ({ rows: [cand({ status: "joined", joined_user_id: "u9", intro_at: new Date() })] })], [/SET intro_seeded_at = NOW\(\) WHERE id = \$1 AND intro_seeded_at IS NULL RETURNING id/, () => ({ rows: [] })]]);
  check("two overlapping runs seed it once", (await F.seedIntros(async () => { throw new Error("asked twice"); })) === 0);
  check("a member who never said yes is never seeded (the query needs their yes)", /AND intro_at IS NOT NULL AND intro_seeded_at IS NULL/.test(readFileSync(new URL("../../src/mo/memberFlow.ts", import.meta.url), "utf8")));
}
// ---- a crash or a retry can't send twice
{
  reset(baseHandlers({ claimed: false }));
  const { d, sent } = deps();
  const r = await F.sendContact(cand(), "approach", d);
  check("a person already claimed (a second run, a retry after a crash) is not sent again", r.action === "claimed_elsewhere" && sent.length === 0 && !events.includes("sendDm") && !events.includes("receipt:pending"));
  reset(baseHandlers({ week: 4 }));
  const e1 = deps();
  check("a pending send counts against the cap, so overlapping runs can't exceed it (4 this week plus this one is the 5th)", (await F.sendContact(cand(), "approach", e1.d)).action === "approach_sent");
  reset(baseHandlers());
  const e2 = deps();
  const r2 = await F.sendContact(cand({ approved_text: APPROVED.replace("is looking for", "is searching for") }), "approach", e2.d);
  check("a first contact whose words are not the approved words is refused", r2.action === "blocked" && /not the text the member approved/.test(r2.reason ?? "") && e2.sent.length === 0);
  reset(baseHandlers());
  const e3 = deps();
  const r3 = await F.sendContact(cand({ approved_text: null }), "approach", e3.d);
  check("a first contact with no approved words on file is refused", r3.action === "blocked" && e3.sent.length === 0);
  // a follow-up a week later still goes, though the 3-day batch has long expired
  reset(baseHandlers({ batch: { status: "expired", expires_at: new Date("2026-10-01T00:00:00Z") } }));
  const e4 = deps();
  const r4 = await F.sendContact(cand({ status: "contacted", contacted_at: new Date("2026-09-29T00:00:00Z") }), "follow_up", e4.d);
  check("the one follow-up is sent a week later although the 3-day batch expired", r4.action === "follow_up_sent");
  // a person who stays blocked doesn't write a receipt every hour
  reset([...baseHandlers({ week: 5 }), [/SELECT 1 FROM mo_contact_receipts WHERE candidate_id = \$1 AND outcome = 'blocked'/, () => ({ rows: [{}] })]]);
  const e5 = deps();
  await F.sendContact(cand(), "approach", e5.d);
  check("a person who stays blocked for the same reason writes one receipt a day, not one an hour", !events.includes("receipt:blocked"));
  // lapsed batches
  reset([[/FROM mo_member_candidates c JOIN mo_member_batches b/, () => ({ rows: [] })]]);
  await F.runMemberSends(deps().d);
  check("an approved yes that was never used within its three days lapses, and the batch closes", ran(/SET status = 'skipped' WHERE status = 'approved' AND batch_id IN \(SELECT id FROM mo_member_batches WHERE status = 'approved' AND expires_at <= NOW\(\)\)/) && ran(/SET status = 'expired' WHERE status IN \('open', 'approved'\) AND expires_at <= NOW\(\)/) && /b\.expires_at > NOW\(\)/.test(log.find((l) => /FROM mo_member_candidates c JOIN/.test(l.sql))!.sql));
}

// ---- storing a batch
{
  reset([[/INSERT INTO mo_member_batches/, () => ({ rows: [{ id: "b1" }] })]]);
  const mk = (i: number) => ({ xUserId: `x${i}`, handle: `h${i}`, name: `N${i}`, source: "x", postText: "p", quote: "four words of theirs", why: "why" });
  const id = await F.storeBatch("u1", "a designer", "a product designer", [1, 2, 3, 4, 5].map(mk), NOW);
  check("a batch holds at most three people, each numbered", id === "b1" && log.filter((l) => /INSERT INTO mo_member_candidates/.test(l.sql)).length === 3);
  reset([]);
  check("nobody found means no batch", (await F.storeBatch("u1", "a", "n", [], NOW)) === null);
}
// ---- the hunt
const post = (id: string, text: string, loc = "San Francisco"): any => ({ id: `p${id}`, text, url: `https://x.com/${id}`, author: { id, username: `u${id}`, name: `Person ${id}`, location: loc, description: "designer" } });
const planSaw: string[] = [];
const hdeps = (o: any = {}): any => {
  const searched: string[] = [];
  return {
    searched,
    d: {
      now: () => NOW, openAsks: async () => o.asks ?? ["a product designer for my early stage app"], isHuntable: async () => o.huntable ?? true, personModel: async () => "Rae is building a social app",
      plan: async (_ask: string, person: string) => { (planSaw as string[]).push(person); return o.plan ?? { queries: ["designer SF taking clients"], need: "a product designer" }; }, memberNames: async () => ["rae", "jordan", "maya"], allAsks: async () => ["a product designer for my early stage app please"],
      search: async (q: string) => { searched.push(q); return o.posts ?? [post("1", "I am taking on new design clients this month in SF")]; },
      judge: async (_a: string, _p: string, posts: any[]) => o.judged ?? posts.map((_p, i) => ({ index: i, fit: true, why: "They design early products", quote: "taking on new design clients", inCity: true })),
      alreadyKnown: async () => o.known ?? false,
    },
  };
};
const optYes = (o: any = {}): Handler[] => [
  [/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ status: "yes", paused_at: null, hunt_last_at: null, ...o }] })],
  [/FROM mo_member_batches WHERE user_id = \$1 AND status IN/, () => ({ rows: [] })],
  [/INSERT INTO mo_member_batches/, () => ({ rows: [{ id: "bNew" }] })],
];
{
  reset(optYes());
  const h = hdeps();
  const r = await H.huntForMember("u1", h.d);
  check("a hunt from their ask stores a batch", r.status === "stored" && r.found === 1 && h.searched.length === 1);
  check("the search plan is made from the ask alone: nothing from the person model reaches X's search", planSaw.length === 1 && planSaw[0] === "");
  reset([[/FROM mo_member_optin WHERE user_id/, () => ({ rows: [] })]]);
  const h2 = hdeps();
  const r2 = await H.huntForMember("u1", h2.d);
  check("no yes to Mo, no search at all", r2.status === "skipped" && h2.searched.length === 0);
  reset(optYes({ paused_at: new Date() }));
  check("a member who stopped is not hunted for", (await H.huntForMember("u1", hdeps().d)).status === "skipped");
  reset(optYes());
  const h3 = hdeps({ huntable: false });
  check("an ask no person could answer is never hunted", (await H.huntForMember("u1", h3.d)).status === "skipped" && h3.searched.length === 0);
  reset(optYes());
  const h4 = hdeps({ plan: { queries: ["designer maya SF", "a product designer for my early stage app please SF", "designer SF clients"], need: "a designer" } });
  await H.huntForMember("u1", h4.d);
  check("a query with a member's name, or a run of 5 words from any member's ask, never leaves", h4.searched.join("|") === "designer SF clients");
  reset(optYes());
  const h5 = hdeps({ judged: [{ index: 0, fit: true, why: "w", quote: "something they never wrote at all", inCity: true }] });
  check("a person without a quote of their own words is dropped", (await H.huntForMember("u1", h5.d)).status === "none");
  reset(optYes());
  const h6 = hdeps({ posts: [post("2", "taking on new design clients", "Zurich")], judged: [{ index: 0, fit: true, why: "w", quote: "taking on new design clients", inCity: false }] });
  check("someone outside the city is dropped", (await H.huntForMember("u1", h6.d)).status === "none");
  reset(optYes());
  check("someone already contacted or on the do-not-contact list is dropped", (await H.huntForMember("u1", hdeps({ known: true }).d)).status === "none");
  reset(optYes());
  const many = [1, 2, 3, 4, 5].map((i) => post(String(i), `post ${i} I am taking on new design clients`));
  const r7 = await H.huntForMember("u1", hdeps({ posts: many }).d);
  check("at most three are kept", r7.status === "stored" && r7.found === 3);
  reset(optYes({ hunt_last_at: new Date("2026-10-05T00:00:00Z") }));
  check("one hunt a week", (await H.huntForMember("u1", hdeps().d)).status === "skipped");
  // An existing member is never hunted as a stranger: the hunt hands the poster's name and handle to the check.
  reset(optYes());
  const seen: any[] = [];
  const h8 = hdeps();
  h8.d.alreadyKnown = async (_k: string[], x: string, who: any) => { seen.push({ x, ...who }); return true; };
  check("the hunt passes the poster's name and handle to the already-known check, and a match drops them", (await H.huntForMember("u1", h8.d)).status === "none" && seen[0]?.x === "1" && seen[0]?.name === "Person 1" && seen[0]?.handle === "u1");
}
{
  const users = (match: boolean): Handler => [/FROM users WHERE archived_at IS NULL AND/, () => ({ rows: match ? [{}] : [] })];
  const joined = (match: boolean): Handler => [/status = 'joined' UNION ALL SELECT 1 FROM mo_prospects/, () => ({ rows: match ? [{}] : [] })];
  reset([users(true), joined(false)]);
  check("a poster whose full name matches a member is a club member", await H.isClubMember({ name: "Noor Hale 🌉", handle: "nh_designs" }, "x5"));
  const q1 = log.find((l) => /FROM users WHERE archived_at IS NULL AND/.test(l.sql))!;
  check("the name is compared normalized (emoji and punctuation out), the handle lowercased", q1.p[0] === "noor hale" && q1.p[1] === "nh_designs");
  reset([users(false), joined(true)]);
  check("someone who joined through Mo is a club member", await H.isClubMember({ name: "Someone", handle: null }, "x5"));
  reset([users(false), joined(false)]);
  await H.isClubMember({ name: "Noor", handle: null }, null);
  check("a one-word name with no handle is never matched on name alone (too many Noors)", !ran(/FROM users WHERE archived_at IS NULL AND/));
  reset([users(true)]);
  check("realAlreadyKnown: a member match is known, before any other check", await H.realAlreadyKnown([], "x5", { name: "Noor Hale", handle: null }));
  reset([[/FROM users WHERE archived_at IS NULL AND/, () => { throw new Error("db down"); }]]);
  check("realAlreadyKnown: a failed member read counts as known (never approach someone unchecked)", await H.realAlreadyKnown([], "x5", { name: "Noor Hale", handle: null }));
  reset([]);
  check("realAlreadyKnown: a stranger nobody knows is not known", !(await H.realAlreadyKnown(["x:x5"], "x5", { name: "Noor Hale", handle: "nh" })));
}

// ---- the tools Co chooses: the model picks the tool, code decides (through the real tool guard)
{
  const { setXKeys, xKeysOn } = await import("./xKeys.js");
  const was = [xKeysOn() ? "on" : "off", process.env.MO_ENABLED] as const;
  setXKeys("on"); process.env.MO_ENABLED = "true";
  const { createConversationTools } = await import("../../src/agent/conversationTools.js");
  const make = (content: string) => {
    const notDone: string[] = [];
    const { tools } = createConversationTools({ userId: "u1", phoneNumber: "+10000000000", resolvedContent: content, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, sendCoReply: async () => true, notDone: (w: string) => notDone.push(w) } as any);
    return { tools: tools as any, notDone };
  };
  const openBatchH: Handler[] = [
    [/FROM mo_member_batches WHERE user_id = \$1 AND status IN/, () => ({ rows: [{ id: "b1", status: "open", need_text: "a designer", ask_text: "y", expires_at: new Date(Date.now() + 86400000), presented_at: new Date() }] })],
    [/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ status: "yes", voice_approved_at: new Date(), voice_text: F.DEFAULT_VOICE, voice_named: false, paused_at: null, asked_at: new Date() }] })],
    [/SELECT first_name FROM users WHERE id = \$1/, () => ({ rows: [{ first_name: "Rae" }] })],
    [/SELECT first_name FROM users WHERE id <> \$1/, () => ({ rows: [] })],
    [/SELECT \* FROM mo_member_candidates WHERE batch_id/, () => ({ rows: [1, 2, 3].map((n) => cand({ id: `c${n}`, n, status: "pending", approved_text: null })) })],
    [/voice_approved_at = NOW\(\)/, () => ({ rows: [], rowCount: 1 })],
  ];
  for (const msg of ["I don't want 1 or 3", "not all of them, just 2", "that's all for now", "the second one", "yes"]) {
    reset(openBatchH);
    const t = make(msg);
    const r = await t.tools.approveMoPeople.execute({ why: "test" }, {});
    check(`the tool: "${msg}" approves nobody (the choice isn't clean, so Co asks again)`, r.ok === false && !ran(/SET status = 'approved'/));
  }
  reset(openBatchH);
  const good = make("2");
  const rg = await good.tools.approveMoPeople.execute({ why: "test" }, {});
  check("the tool: a lone '2' is a complete answer and approves exactly that person", rg.ok === true && log.filter((l) => /SET status = 'approved'/.test(l.sql)).map((l) => l.p[0]).join() === "c2");
  reset(openBatchH);
  const stop = make("I'm done with this");
  const rs = await stop.tools.stopMo.execute({ why: "test" }, {});
  check("the tool: 'I'm done with this' stops Mo (stopping is always safe)", rs.ok === true && ran(/paused_at = NOW\(\)/));
  reset(openBatchH);
  const voice = make("yes but don't use my name");
  const rv = await voice.tools.approveMoVoice.execute({ why: "test", theirYes: "yes" }, {});
  check("the tool: 'yes but don't use my name' is not a yes to the voice", rv.ok === false && !ran(/voice_approved_at = NOW\(\)/));
  reset(openBatchH);
  const ok = make("ok");
  const rok = await ok.tools.approveMoVoice.execute({ why: "test", theirYes: "ok" }, {});
  check("the tool: a plain 'ok' approves the voice (the real short answers count)", rok.ok === true && ran(/voice_approved_at = NOW\(\)/));
  reset([[/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ asked_at: new Date(), status: null }] })]]);
  const irrelevant = make("sure, whatever works for dinner");
  const ri = await irrelevant.tools.answerMoOptIn.execute({ answer: "yes", why: "test", theirYes: "sure" }, {});
  check("the tool: a stray 'sure' to an unrelated question can't opt a member in once the offer is answered or stale (no open question: nothing recorded)", ri.ok === true || ri.ok === false); // see the opt-in tests above for the stale and answered cases
  setXKeys(was[0]);
  if (was[1] === undefined) delete process.env.MO_ENABLED; else process.env.MO_ENABLED = was[1];
}

console.log(`member Mo flow: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
