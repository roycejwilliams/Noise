// Member-facing Mo: the flow against a fake database and fake channels. Model-free.
//   npx tsx evals/mo/memberFlow.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
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
  for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, p);
  return { rows: [], rowCount: 0 };
};
const reset = (h: Handler[]) => { log.length = 0; events.length = 0; handlers = h; };
const ran = (re: RegExp) => log.some((l) => re.test(l.sql));
const NOW = new Date("2026-10-07T19:00:00Z"); // noon in San Francisco

const cand = (over: any = {}): any => ({ id: "c1", batch_id: "b1", user_id: "u1", n: 1, x_user_id: "x99", x_handle: "noor", name: "Noor Hale", email: null, source: "x", post_text: "taking on design clients", evidence_quote: "taking on new design clients", why: "You wrote that you're taking on new design clients", status: "approved", approved_at: new Date("2026-10-06T00:00:00Z"), approved_quote: "1 and 3", contacted_at: null, channel: null, followed_up_at: null, replied_at: null, invite_code: null, joined_user_id: null, ...over });
const baseHandlers = (over: Record<string, any> = {}): Handler[] => [
  [/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ status: "yes", paused_at: null, voice_approved_at: new Date("2026-10-06"), voice_text: F.DEFAULT_VOICE, voice_named: false, ...(over.optin ?? {}) }] })],
  [/FROM mo_member_batches WHERE id/, () => ({ rows: [{ status: "approved", expires_at: new Date("2026-10-09T00:00:00Z"), need_text: "a product designer", ...(over.batch ?? {}) }] })],
  [/SELECT first_name FROM users WHERE id = \$1/, () => ({ rows: [{ first_name: "Rae" }] })],
  [/FROM mo_contact_receipts WHERE user_id = \$1 AND outcome = 'sent'/, () => ({ rows: [{ n: over.week ?? 0 }] })],
  [/FROM mo_contact_receipts WHERE outcome = 'sent'/, () => ({ rows: [{ n: over.today ?? 0 }] })],
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
  check("the receipt exists BEFORE the DM goes out, and is marked sent after", events.indexOf("receipt:pending") >= 0 && events.indexOf("receipt:pending") < events.indexOf("sendDm") && events.indexOf("sendDm") < events.indexOf("receipt:sent"));
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
const rdeps = (kind: "yes" | "no" | "question") => {
  const out: string[] = []; const told: string[] = []; const supp: string[][] = [];
  return { out, told, supp, d: { send: async (t: string) => { out.push(t); }, classify: async () => kind, makeCode: async () => "ABCD2345", codeMessage: (c: string) => `invite ${c}`, suppress: async (k: string[]) => { supp.push(k); }, tellMember: async (_u: string, k: string) => { told.push(k); } } };
};
{
  reset([]);
  const r = rdeps("no");
  const a = await F.landReply(cand({ status: "contacted" }), "Not interested, thanks", r.d as any);
  check("a no: they are suppressed club-wide, told it ends here, and the member hears it", a === "declined" && r.supp[0].includes("x:x99") && /won't reach out again/.test(r.out[0]) && r.told[0] === "declined" && ran(/SET status = 'declined'/));
  reset([]);
  const r2 = rdeps("yes");
  const a2 = await F.landReply(cand({ status: "contacted" }), "yes please", r2.d as any);
  check("a yes: they get the invite code (the gate stays), and the member hears it", a2 === "invited" && /invite ABCD2345/.test(r2.out[0]) && r2.told[0] === "replied" && ran(/SET status = 'invited'/));
  reset([]);
  const r3 = rdeps("question");
  const a3 = await F.landReply(cand({ status: "contacted" }), "who is the member? what is this?", r3.d as any);
  check("a question: held, nothing about the member or the club is said, and the member is told it is held", a3 === "held" && r3.out.length === 0 && r3.told[0] === "question");
  reset([]);
  const r4 = rdeps("yes");
  const a4 = await F.landReply(cand({ status: "invited", invite_code: "ABCD2345" }), "yes", r4.d as any);
  check("a second yes after the invite does not send a second code", a4 === "held" && r4.out.length === 0);
  reset([]);
  const r5 = rdeps("yes");
  await F.landReply(cand({ status: "contacted" }), "STOP", r5.d as any);
  check("a clear stop wins in code, before any model read", r5.supp.length === 1 && r5.out.length === 1 && /won't reach out again/.test(r5.out[0]));
  check("every reply leaves a receipt", log.some((l) => /INSERT INTO mo_contact_receipts/.test(l.sql) && /'reply'/.test(l.sql)));
}

// ---- consent steps
{
  reset([[/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ asked_at: null }] })]]);
  check("a yes with no question open records nothing", (await F.recordOptIn("u1", "yes", "yes")).ok === false && !ran(/UPDATE mo_member_optin SET status/));
  reset([[/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ asked_at: new Date() }] })]]);
  check("a yes records", (await F.recordOptIn("u1", "yes", "yes")).ok === true && ran(/UPDATE mo_member_optin SET status/));
  reset([[/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ asked_at: new Date() }] })]]);
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
  const open = (h: any = {}): Handler[] => [
    [/FROM mo_member_batches WHERE user_id = \$1 AND status IN/, () => ({ rows: [{ id: "b1", status: "open", need_text: "x", ask_text: "y", expires_at: new Date(Date.now() + 86400000), presented_at: new Date(), ...h }] })],
    [/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ status: "yes", voice_approved_at: new Date() }] })],
    [/UPDATE mo_member_candidates SET status = 'approved'/, () => ({ rows: [], rowCount: 2 })],
    [/UPDATE mo_member_candidates SET status = 'skipped'/, () => ({ rows: [], rowCount: 1 })],
  ];
  reset(open());
  const r = await F.approvePicks("u1", [1, 3], "1 and 3");
  check("picking approves only those numbers and skips the rest", !!r && "approved" in r && r.approved === 2 && log.find((l) => /SET status = 'approved'/.test(l.sql))!.p[3].join() === "1,3");
  reset(open({ status: "approved" }));
  check("a list already approved can't be approved again", (await F.approvePicks("u1", [1], "1")) === null);
  reset([[/FROM mo_member_batches WHERE user_id/, () => ({ rows: [] })]]);
  check("with no open list, nothing is approved", (await F.approvePicks("u1", [1], "1")) === null);
  reset([...open().slice(0, 1), [/FROM mo_member_optin WHERE user_id/, () => ({ rows: [{ status: "yes", voice_approved_at: null }] })]]);
  check("nothing is approved before the voice is", (await F.approvePicks("u1", [1], "1")) === null && !ran(/SET status = 'approved'/));
  reset(open());
  const none: any = await F.approvePicks("u1", [], "none");
  check("choosing none cancels the batch", none?.none === true && ran(/UPDATE mo_member_batches SET status = 'cancelled'/));
}
// ---- the intro: the member's side only, both must say yes
{
  reset([[/FROM mo_member_candidates WHERE id = \$1 AND user_id = \$2 AND status = 'joined'/, () => ({ rows: [] })]]);
  check("no intro for someone who hasn't joined", (await F.recordIntroYes("u1", "c1", "yes")).ok === false && !ran(/network_introductions/));
  reset([[/FROM mo_member_candidates WHERE id = \$1 AND user_id = \$2 AND status = 'joined'/, () => ({ rows: [cand({ status: "joined", joined_user_id: "u9" })] })]]);
  const r = await F.recordIntroYes("u1", "c1", "yes please");
  const ins = log.find((l) => /INSERT INTO network_introductions/.test(l.sql))!;
  check("the member's yes is recorded on THEIR side only (the other person is asked separately)", r.ok && /a_interested_at/.test(ins.sql) && !/b_interested_at/.test(ins.sql.split("ON CONFLICT")[0]) && ins.p[0] === "u1" && ins.p[1] === "u9" && /'a_interested'/.test(ins.sql) === false && ins.p[2] === "a_interested");
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
const hdeps = (o: any = {}): any => {
  const searched: string[] = [];
  return {
    searched,
    d: {
      now: () => NOW, openAsks: async () => o.asks ?? ["a product designer for my early stage app"], isHuntable: async () => o.huntable ?? true, personModel: async () => "Rae is building a social app",
      plan: async () => o.plan ?? { queries: ["designer SF taking clients"], need: "a product designer" }, memberNames: async () => ["rae", "jordan", "maya"], allAsks: async () => ["a product designer for my early stage app please"],
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
}

console.log(`member Mo flow: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
