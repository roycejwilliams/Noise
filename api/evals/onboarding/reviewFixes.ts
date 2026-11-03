// The independent review of the onboarding branch (2026-11-03), findings 1-7 and 9, through the real decision paths. Ruling A: name and
// email are asked once, inside the conversation, never held hostage; a member who declines email gets everything else.
//   1. every proactive and member path gates on a verified member (invite-verified, not archived), never on name/email on file;
//   2. a texted email correction after the call's confirmation really updates users.email, and Cue says "updated" only then;
//   3. a name is only ever theirs when they name themselves; the extraction runs only when a text could carry their name or email;
//   4. the placeholder email is never a send address, and an intro to a member with no email goes by text (Royce, 2026-11-03);
//   5. the first call's opening words never carry breakups, layoffs, sobriety, mental health or distress (SENSITIVE);
//   6. the welcome never names the inviter (Royce, 2026-11-03);
//   7. "asked once" counts address, contact and "what should I call you" shapes, on texts and calls, and the old door's line;
//   9. no automatic call offer on any path.
// Layer 1: zero tokens, a fake database, nothing sent. Invented members (Jordan, Noor, Ellis, Priya).
//   TZ=UTC node evals/runLayer1.mjs evals/onboarding/reviewFixes.ts
process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
delete process.env.PROACTIVE_PAUSED;
import { readFileSync } from "fs";
const { default: pool } = await import("../../src/db/db.js");
// writeMemory embeds what it writes: a stub client here, never OpenAI.
(await import("../../src/services/embeddings.js")).setEmbeddingsClientForTests({ embeddings: { create: async (b: any) => ({ data: (Array.isArray(b.input) ? b.input : [b.input]).map((_: unknown, index: number) => ({ index, embedding: new Array(1536).fill(0) })) }) } } as any);

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const realQuery = (pool as any).query;

// ---------------------------------------------------------------- 1. a verified member, email on file or not
// The members each real selection query is evaluated against: the query's own membership conditions decide who it would pick.
type Row = { id: string; invite_verified: boolean; identity_captured: boolean; archived_at: string | null };
const PEOPLE: Row[] = [
  { id: "full", invite_verified: true, identity_captured: true, archived_at: null },
  { id: "no-email", invite_verified: true, identity_captured: false, archived_at: null },
  { id: "no-invite", invite_verified: false, identity_captured: false, archived_at: null },
  { id: "archived", invite_verified: true, identity_captured: true, archived_at: "2026-10-01" },
];
const picks = (sql: string) =>
  PEOPLE.filter((p) => (!/\binvite_verified = true/.test(sql) || p.invite_verified) && (!/\bidentity_captured = true/.test(sql) || p.identity_captured) && (!/\barchived_at IS NULL/.test(sql) || !p.archived_at)).map((p) => p.id).join(",");
const memberSelects = async (label: string, run: () => Promise<unknown>, pick: (sql: string) => boolean = (q) => /FROM users u/.test(q)) => {
  const seen: string[] = [];
  (pool as any).query = async (sql: string) => { seen.push(String(sql)); return { rows: [], rowCount: 0 }; };
  await run().catch(() => {});
  (pool as any).query = realQuery;
  const q = seen.find(pick);
  check(`${label}: a member who declined email is picked; no invite or archived is not`, !!q && picks(q) === "full,no-email", { picked: q && picks(q), q: q?.slice(0, 300) });
};
await memberSelects("heavy-moment check-ins", async () => (await import("../../src/services/heavyMoment.js")).queueHeavyCheckins(new Date("2026-11-03T18:00:00Z")));
await memberSelects("memory compaction (recaps)", async () => (await import("../../src/services/memoryCompaction.js")).findUsersDueForRecap());
await memberSelects("weekly reflections", async () => (await import("../../src/harness/memberReflection.js")).runWeeklyReflections());
await memberSelects("the picker after each sweep", async () => (await import("../../src/services/sweepShadow.js")).pickerUserIds(), (q) => /FROM users/.test(q));
await memberSelects("the daily sweep's rollup", async () => (await import("../../src/services/dailySweep.js")).dailySweepRollup(14, new Date("2026-11-03T18:00:00Z")));
await memberSelects("engagement rhythm", async () => (await import("../../src/services/engagementRhythm.js")).engagementRhythm(28));
{
  const DS = await import("../../src/services/dailySweep.js");
  check("the daily sweep (finds) picks a member who declined email", picks(DS.MEMBERS_SQL) === "full,no-email", picks(DS.MEMBERS_SQL));
  const jobs = src("src/jobs/index.ts");
  const checkin = jobs.slice(jobs.indexOf("WHERE u.sms_opted_out = false\n           AND u.archived_at IS NULL\n           AND u.invite_verified"), jobs.indexOf("cp.last_recap_at IS NOT NULL"));
  check("companion check-ins pick a member who declined email (the cron's own query)", checkin.length > 0 && picks(checkin) === "full,no-email", checkin.slice(-300));
}
{
  const CG = await import("../../src/services/cueGrants.js");
  const db = (who: Row) => ({ query: async (sql: string) => ({ rows: picks(sql).split(",").includes(who.id) ? [{ x: 1 }] : [] }) });
  check("Google grants: a member who declined email may connect; no invite or archived may not", (await CG.isGrantMember("u", db(PEOPLE[1]))) && (await CG.isGrantMember("u", db(PEOPLE[0]))) && !(await CG.isGrantMember("u", db(PEOPLE[2]))) && !(await CG.isGrantMember("u", db(PEOPLE[3]))));
  const A = await import("../../src/services/coEventAnnouncement.js");
  const people = [{ id: "no-email", city: "Oakland", optedOut: false, member: true }, { id: "no-invite", city: "Oakland", optedOut: false, member: false }, { id: "opted", city: "Oakland", optedOut: true, member: true }];
  check("a new Cue event is announced to a nearby member who declined email; never without an invite, never opted out", A.announcementAudience(people, () => true).map((p) => p.id).join() === "no-email");
  const ann = src("src/services/coEventAnnouncement.ts");
  check("the announcement's member flag is invite-verified and not archived", /\(COALESCE\(u\.invite_verified, false\) = true AND u\.archived_at IS NULL\) AS member/.test(ann) && !/identity_captured/.test(ann));
  const G = await import("../../src/harness/callGate.js");
  const base = { subscriptionActive: true, hadRealCall: false, hasRealProfile: false, attempts: 0, lastAttemptAt: null };
  check("the call gate's intake kind: a member is eligible with no email; a non-member isn't", G.decideAutoIntake({ ...base, member: true }, new Date()).eligible && !G.decideAutoIntake({ ...base, member: false }, new Date()).eligible);
  const sb = src("src/routes/sendblue.ts");
  check("the inviter hears their friend joined even if the inviter declined email (a member, not archived)", /WHERE id = \$1 AND invite_verified = true AND archived_at IS NULL AND NOT sms_opted_out/.test(sb));
  check("kept on identity, for a real reason: changing a phone number emails a code to the email on file", /if \(hasText && user\.identity_captured\) \{\s*const phoneChangeReply = await handlePhoneChange/.test(sb));
  check("the draft never reads 'You're texting .' for a member with no name yet", /You're texting \$\{opts\.firstName\?\.trim\(\) \|\| "them"\}/.test(src("src/harness/proactive.ts")));
}

// ---------------------------------------------------------------- 2. a texted email correction really updates the email
{
  const I = await import("../../src/harness/intake.js");
  const run = async (o: { text: string; lastCo: string; taken?: boolean; dup?: boolean; email?: string }) => {
    const writes: { sql: string; args: unknown[] }[] = [];
    const db = {
      query: async (sql: string, args: unknown[] = []) => {
        if (/content LIKE 'Co replied:%'/.test(sql)) return { rows: [{ content: `Co replied: ${o.lastCo}` }] };
        if (/lower\(email\) = lower\(\$1\)/.test(sql)) return { rows: o.taken ? [{ x: 1 }] : [] };
        if (/^UPDATE users SET email/.test(sql)) {
          if (o.dup) throw Object.assign(new Error("dup"), { code: "23505" });
          writes.push({ sql, args });
          return { rows: [{ id: "u-jordan" }] };
        }
        return { rows: [] };
      },
    };
    const r = await I.correctEmailFromText({ userId: "u-jordan", text: o.text, email: o.email ?? "jordan.lea@gmail.com" }, db);
    return { r, writes, note: I.emailCorrectionNote(r) };
  };
  const CONFIRM = "Got your email as jordan.lea@gmail.com. If that's not right, just text me the right one.";
  const fixed = await run({ text: "oops it's jordan.lee@gmail.com", lastCo: CONFIRM });
  check("right after the confirmation, the address they text replaces the one on file (saved: users.email)", fixed.r.action === "updated" && fixed.writes.length === 1 && fixed.writes[0].args[1] === "jordan.lee@gmail.com" && fixed.writes[0].args[2] === "jordan.lea@gmail.com", fixed);
  check("the reply is told it was updated, as a fact of this turn", fixed.note.fact === "Updated their email on file to jordan.lee@gmail.com (it was jordan.lea@gmail.com)." && !fixed.note.instruction);
  const taken = await run({ text: "use priya@shah.co", lastCo: CONFIRM, taken: true });
  check("an address on another account: nothing written, the reply is told it was not saved and never to say updated", taken.r.action === "taken" && !taken.writes.length && /was not saved/.test(taken.note.instruction ?? "") && /Never say it was updated/.test(taken.note.instruction ?? "") && !taken.note.fact);
  const race = await run({ text: "jordan.lee@gmail.com", lastCo: CONFIRM, dup: true });
  check("a lost race on the unique email: treated as taken, nothing saved", race.r.action === "taken" && !race.writes.length);
  const bad = await run({ text: "jordan.lee@gmail", lastCo: CONFIRM });
  check("an incomplete address: nothing written, the reply says so and never says updated", bad.r.action === "invalid" && !bad.writes.length && /Never say it was updated/.test(bad.note.instruction ?? ""));
  const unrelated = await run({ text: "can you email noor@studio.co the deck?", lastCo: "Here's the deck you asked for." });
  check("an address in a text that isn't right after Cue said their email back changes nothing", unrelated.r.action === "not_a_correction" && !unrelated.writes.length && !unrelated.note.fact && !unrelated.note.instruction);
  const pending = await run({ text: "jordan@x.co", lastCo: CONFIRM, email: "pending-ab12@copatible.pending" });
  check("no real email on file: left to the intake path (which already holds a newer address)", pending.r.action === "not_a_correction" && !pending.writes.length);
  const sb = src("src/routes/sendblue.ts");
  check("the text path runs it for a member with identity captured, and hands the reply only what happened", /\} else if \(hasText\) \{[\s\S]{0,400}emailFix = await correctEmailFromText\(\{ userId: user\.id, text: content, email: user\.email \}\)/.test(sb) && /const fixNote = emailCorrectionNote\(emailFix\);/.test(sb));
  const CE = await import("../../src/services/callEmail.js");
  check("the confirmation line it backs is unchanged", CE.EMAIL_CONFIRM_FALLBACK("{email}") === "Got your email as {email}. If that's not right, just text me the right one.");
}

// ---------------------------------------------------------------- 3. whose name, and when the extraction runs
{
  const I = await import("../../src/harness/intake.js");
  const state = (o: Partial<Parameters<typeof I.decideIntake>[0]> = {}) => ({ userId: "u-jordan", knownName: "Jordan Lee", knownEmail: null, partialEmail: null, retries: 1, lastCoLine: null, recentCoLines: [], ...o });
  const extractor = (json: string) => { let n = 0; return { n: () => n, fn: async () => { n++; return json; } }; };
  const priya = `{"full_name": "Priya Shah", "email": null, "is_acknowledgment": false}`;
  {
    const x = extractor(priya);
    const s = state({ lastCoLine: "What's your full name and email?", recentCoLines: ["What's your full name and email?"] });
    const r = await I.textIntakeProposal({ text: "Can you introduce me to Priya Shah?", state: s, extract: x.fn });
    const d = I.decideIntake(s, r.proposal, { emailTakenByOtherAccount: false, replyText: "Can you introduce me to Priya Shah?" });
    check("'introduce me to Priya Shah' right after the ask: read, but the name is someone else's and theirs stays (saved state: Jordan Lee)", x.n() === 1 && r.nameDropped === "Priya Shah" && r.proposal.full_name === null && d.name === "Jordan Lee", { r, name: d.name });
  }
  {
    const x = extractor(`{"full_name": "Jordan Lee", "email": null}`);
    const s = state({ knownName: null, recentCoLines: ["Glad you're here."] });
    const r = await I.textIntakeProposal({ text: "I'm Jordan Lee, by the way", state: s, extract: x.fn });
    check("a self-introduction is theirs, even unasked", x.n() === 1 && r.proposal.full_name === "Jordan Lee");
  }
  {
    const x = extractor(`{"full_name": "Jordan Lee", "email": null}`);
    const s = state({ knownName: null, lastCoLine: "What should I call you?", recentCoLines: ["What should I call you?"] });
    const r = await I.textIntakeProposal({ text: "Jordan Lee", state: s, extract: x.fn });
    check("a bare name in reply to 'what should I call you?' is theirs", r.proposal.full_name === "Jordan Lee");
  }
  {
    const x = extractor(priya);
    const s = state({ knownName: null, recentCoLines: ["Packaging is a good niche.", "Glad you're here."] });
    const r = await I.textIntakeProposal({ text: "Priya Shah is the person I most want to meet this month", state: s, extract: x.fn });
    check("a member who declined, texting about someone: no extraction at all (no model call)", x.n() === 0 && r.extracted === false && r.proposal.full_name === null);
  }
  {
    const x = extractor(`{"full_name": null, "email": "jordan@studio.co"}`);
    const r = await I.textIntakeProposal({ text: "here you go jordan@studio.co", state: state({ recentCoLines: ["Glad you're here."] }), extract: x.fn });
    check("an '@' is read whenever it comes", x.n() === 1 && r.proposal.email === "jordan@studio.co");
  }
  {
    const x = extractor(`{"full_name": null, "email": null}`);
    await I.textIntakeProposal({ text: "sure thing", state: state({ recentCoLines: ["Nice.", "Best address to send event details to?"] }), extract: x.fn });
    const y = extractor(`{"full_name": null, "email": null}`);
    await I.textIntakeProposal({ text: "sure thing", state: state({ recentCoLines: ["Nice.", "Sounds good.", "Best address to send event details to?"] }), extract: y.fn });
    check(`within ${I.INTAKE_EXTRACT_WINDOW} of Cue's texts after an ask it's read; past that it isn't`, x.n() === 1 && y.n() === 0);
  }
  check("the text door uses the gated extraction (no per-text model call forever)", /const read = await textIntakeProposal\(\{/.test(src("src/routes/sendblue.ts")) && !/prompt: buildIntakeExtractionPrompt\(intakeState, content\)/.test(src("src/routes/sendblue.ts")));
  check("the call side still takes no name", /full_name: null, email \}/.test(src("src/services/callEmail.ts")));
}

// ---------------------------------------------------------------- 4. the placeholder is never a send address; no email means a text
{
  const ID = await import("../../src/services/identity.js");
  check("usableEmail: the placeholder is no email", ID.usableEmail("pending-ab12@copatible.pending") === null && ID.usableEmail("jordan@studio.co") === "jordan@studio.co" && ID.usableEmail("") === null && ID.usableEmail(null) === null);
  check("the plan sheet's email address is usableEmail (never the placeholder)", /usableEmail\(rows\[0\]\?\.email\)/.test(src("src/agent/loopTools.ts")));
  check("every templated email (otpActions sendEmail) refuses the placeholder", /if \(!usableEmail\(email\)\) return;/.test(src("src/otpActions.ts")));
  const OA = await import("../../src/otpActions.js");
  await OA.sendEmail({ email: "pending-ab12@copatible.pending", welcome: true } as any);
  check("sendEmail to the placeholder returns without a send (the layer-1 guard fails the run on any outside call)", true);

  const IT = await import("../../src/services/introByText.js");
  const jordan = { user_id: "a-jordan", first_name: "Jordan", phone_number: "+14155550101", email: "pending-ab12@copatible.pending" };
  const noor = { user_id: "b-noor", first_name: "Noor", phone_number: "+14155550102", email: "noor@studio.co" };
  const ch = IT.introChannels(jordan, noor);
  check("channels: the member with only the placeholder gets a text, the other the email", ch.text.map((p) => p.user_id).join() === "a-jordan" && ch.email.map((p) => p.user_id).join() === "b-noor");
  const toNoor = IT.introText(noor, jordan, ["Body."], "Close.");
  check("the text never shows the placeholder as their email", !/copatible\.pending/.test(toNoor) && !/email:/.test(toNoor));

  // The real event intro path (sendHeldIntro -> sendIntroEmail) on a fake database: the email goes to Noor only, Jordan gets the same
  // content by text, and the pair is saved as introduced only once both went.
  const run = async (o: { textOk: boolean }) => {
    const writes: string[] = [], texts: any[] = [], logs: string[] = [];
    (pool as any).query = async (sql: string, args: any[] = []) => {
      const q = String(sql).replace(/\s+/g, " ").trim();
      if (/FROM users WHERE id = ANY/.test(q)) return { rows: [jordan, noor] };
      if (/FROM event_guest_match_opt_ins/.test(q)) return { rows: [{ x: 1 }] };
      if (/FROM co_test_events/.test(q)) return { rows: [{ api_id: args[0], name: "Thursday Supper", start_at: "2026-11-05T02:00:00Z", end_at: null, timezone: "America/Los_Angeles", venue: null }] };
      if (/^SELECT \* FROM co_pairs/.test(q)) return { rows: [{ event_id: "test-supper", origin: "cue", intro_sent_at: null }] };
      if (/UPDATE co_pairs SET intro_claimed_at/.test(q)) return { rows: [{ x: 1 }], rowCount: 1 };
      if (/^(INSERT|UPDATE|DELETE)\b/.test(q)) { writes.push(q.slice(0, 120)); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    };
    IT.setIntroTextSendForTests(async (s) => { texts.push(s); return o.textOk ? { sent: true, queued: false } : { sent: false, queued: false, reason: "opted out" }; });
    const log = console.log, err = console.error;
    console.log = (...a: any[]) => { logs.push(a.join(" ")); };
    console.error = () => {};
    const H = await import("../../src/services/eventGuestMatchHandoff.js");
    const ok = await H.sendHeldIntro("test-supper", "a-jordan", "b-noor").catch((e: any) => { logs.push(`THREW ${e?.message}`); return false; });
    console.log = log; console.error = err;
    IT.setIntroTextSendForTests(null);
    (pool as any).query = realQuery;
    return { ok, writes, texts, logs };
  };
  const went = await run({ textOk: true });
  const emailLog = went.logs.find((l) => /sendIntroEmail stub/.test(l)) ?? "";
  check("event intro: the email goes to the member with a real email only, never the placeholder", /to noor@studio\.co:/.test(emailLog) && !/copatible\.pending/.test(emailLog), went.logs);
  check("event intro: the member without an email gets the same content by text, through the gated send", went.texts.length === 1 && went.texts[0].userId === "a-jordan" && went.texts[0].phoneNumber === "+14155550101" && went.texts[0].text.startsWith("Jordan, meet Noor.") && went.texts[0].text.includes("You were both at Thursday Supper, and Cue thought you two should meet. Consider this your introduction.") && went.texts[0].text.includes("You both said yes. Take it from here.") && went.texts[0].text.includes("Noor's email: noor@studio.co"), went.texts);
  check("event intro: saved as introduced (co_pairs intro_sent_at) once both went", went.ok === true && went.writes.some((w) => /UPDATE co_pairs SET intro_sent_at/.test(w)), went.writes);
  const held = await run({ textOk: false });
  check("event intro: a text that can't go leaves the pair not introduced and counted as a failed try", held.ok === false && !held.writes.some((w) => /SET intro_sent_at/.test(w)) && held.writes.some((w) => /SET intro_attempts/.test(w)), held.writes);
  const RG = await import("../../src/harness/replyGrounding.js");
  const d = new Date("2026-11-03T18:00:00Z");
  check("the reply's record of an intro by text says by text (Cue never claims an email it didn't send)", RG.introRecordLines("event_intro_email_sent", 'Sent an intro by text connecting Jordan and Noor ahead of "Thursday Supper".', d, "Jordan").some((l: string) => /one intro by text connecting them with Noor/.test(l)));
  const nis = src("src/services/networkIntroNudge.ts");
  check("network intro: the same split (email to real addresses, text to the rest), never both addresses blindly", /const channels = IT\.introChannels\(a as any, b as any\);/.test(nis) && /to: emailTo,/.test(nis) && !/to: \[p1\.email, p2\.email\]/.test(nis) && /IT\.textIntro\(/.test(nis));
}

// ---------------------------------------------------------------- 5. the opening words: never the hard stuff
{
  const F = await import("../../src/services/firstCall.js");
  const { SENSITIVE } = await import("../../src/services/callReason.js");
  const PROBES = [
    "I'm moving out next month because my partner and I split up",
    "Got laid off from my job last week and honestly I'm scared",
    "Planning to tell my team I'm getting sober and taking a step back from client dinners",
    "Work has been rough, a lot of anxiety since the layoff at work",
    "My wife and I are separating so I'm planning a move to Austin",
  ];
  for (const p of PROBES) check(`never in the opening: "${p}"`, SENSITIVE.test(p) && F.openingWords([p]) === null, F.openingWords([p]));
  check("work and plans still pass", F.openingWords(["We're raising a seed round in March and hiring two engineers"]) === "We're raising a seed round in March and hiring two engineers");
}

// ---------------------------------------------------------------- 6. the welcome never names the inviter
{
  const sb = src("src/routes/sendblue.ts");
  const fn = sb.slice(sb.indexOf("async function welcomeLineFor("), sb.indexOf("// Once someone who came in on a member's invite finishes onboarding"));
  check("the welcome's draft gets no inviter (no lookup, no name, the plain WELCOME lines as examples and fallback)", !/inviterFirstName|WELCOME_INVITED|\{inviter\}|mustInclude: inviter/.test(fn) && /examples: WELCOME,/.test(fn) && /fallback: pickLine\(WELCOME\)/.test(fn) && /mustInclude: \[\]/.test(fn));
  check("WELCOME_INVITED is sent from nowhere", !/WELCOME_INVITED/.test(sb) && !/WELCOME_INVITED/.test(src("src/otpActions.ts")));
}

// ---------------------------------------------------------------- 7. asked once, in any of its shapes
{
  const I = await import("../../src/harness/intake.js");
  const CE = await import("../../src/services/callEmail.js");
  check("text: 'best address to send event details to?' counts as the email ask", I.replyAskedFor(["email"], "Love that. Best address to send event details to?") && I.replyAskedFor(["name", "email"], "What's the best contact for you?"));
  check("text: 'what should I call you?' counts as the name ask", I.replyAskedFor(["name"], "Before I forget, what should I call you?"));
  check("text: a venue's address in a statement isn't an ask", !I.replyAskedFor(["email"], "The address is 12 Valencia, doors at 7."));
  check("call: the same shapes count on a call", CE.cueAskedForEmail("assistant: Best address to send event details to?\nuser: later") && !CE.cueAskedForEmail("assistant: The address is 12 Valencia.\nuser: ok"));
  check("old door: a member who only got NAME_EMAIL counts as asked once", I.intakeAlreadyAsked({ retries: 0, oldLineAsked: true }) && !I.intakeAlreadyAsked({ retries: 0, oldLineAsked: false }));
  const OL = await import("../../src/services/onboardingLines.js");
  const seen: { sql: string; args: any[] }[] = [];
  (pool as any).query = async (sql: string, args: any[] = []) => {
    seen.push({ sql, args });
    if (/content = ANY/.test(sql)) return { rows: args[1]?.includes(`Co replied: ${OL.NAME_EMAIL[1]}`) ? [{ x: 1 }] : [] };
    return { rows: [] };
  };
  const st = await I.gatherIntakeState({ id: "u-ellis", first_name: "", last_name: "", email: "pending-x@copatible.pending", intake_retries: 0 });
  (pool as any).query = realQuery;
  check("gatherIntakeState reads the old line from their history", st.oldLineAsked === true && I.intakeAskFor({ knownName: null, knownEmail: null, partialEmail: null, asked: I.intakeAlreadyAsked(st) }).length === 0);
  check("the text door and the first call both use it", /asked: intakeAlreadyAsked\(intakeState\)/.test(src("src/routes/sendblue.ts")) && /emailAsked: Number\(user\?\.intake_retries \?\? 0\) > 0 \|\| oldLine/.test(src("src/services/firstCall.ts")));
}

// ---------------------------------------------------------------- 9. no automatic call offer on any path
{
  const R = await import("../../src/agent/conversationReply.js");
  const none = { hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none" };
  check("a thin profile's first message gets no call offer", !R.callOfferEligibleFor(none, false));
  check("the in-conversation offer stays, when a call would help", R.callOfferEligibleFor({ ...none, callAction: "would_benefit" }, false) && !R.callOfferEligibleFor({ ...none, callAction: "would_benefit", hasPendingOffer: true }, false) && !R.callOfferEligibleFor({ ...none, callAction: "would_benefit" }, true));
  const cr = src("src/agent/conversationReply.ts");
  check("the default-offer instruction is gone from the reply prompt", !/This is the first real thing they've shared and nothing is known about them yet/.test(cr) && /const callOfferEligible = callOfferEligibleFor\(input/.test(cr));
}

console.log(`onboarding review fixes: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
