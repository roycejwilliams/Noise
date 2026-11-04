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
  const CONFIRM = "Got your email as jordan.lea@gmail.com. If that's not right, just text me the right one.";
  const run = async (o: { text: string; lastCo: string; taken?: boolean; dup?: boolean; email?: string; confirm?: string | null }) => {
    const writes: { sql: string; args: unknown[] }[] = [];
    const db = {
      query: async (sql: string, args: unknown[] = []) => {
        if (/content LIKE 'Co replied:%'/.test(sql)) return { rows: [{ content: `Co replied: ${o.lastCo}` }] };
        if (/FROM proactive_sends WHERE user_id = \$1 AND target_key LIKE 'call_email:%'/.test(sql)) return { rows: o.confirm === null ? [] : [{ message: o.confirm ?? CONFIRM }] };
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
  const fixed = await run({ text: "oops it's jordan.lee@gmail.com", lastCo: CONFIRM });
  check("right after the confirmation, the address they text replaces the one on file (saved: users.email)", fixed.r.action === "updated" && fixed.writes.length === 1 && fixed.writes[0].args[1] === "jordan.lee@gmail.com" && fixed.writes[0].args[2] === "jordan.lea@gmail.com", fixed);
  check("the reply is told it was updated, as a fact of this turn", fixed.note.fact === "Updated their email on file to jordan.lee@gmail.com (it was jordan.lea@gmail.com)." && !fixed.note.instruction);
  const taken = await run({ text: "use priya@shah.co", lastCo: CONFIRM, taken: true });
  check("an address on another account: nothing written, the reply is told it was not saved and never to say updated", taken.r.action === "taken" && !taken.writes.length && /was not saved/.test(taken.note.instruction ?? "") && /Never say it was updated/.test(taken.note.instruction ?? "") && !taken.note.fact);
  const race = await run({ text: "jordan.lee@gmail.com", lastCo: CONFIRM, dup: true });
  check("a lost race on the unique email: treated as taken, nothing saved", race.r.action === "taken" && !race.writes.length);
  // Re-review: only a reply to the confirmation text itself; the last address that differs; never someone else's.
  const named = await run({ text: "oh and the right one is jordan.lee@gmail.com", lastCo: "Sent the plan to jordan.lea@gmail.com.", confirm: CONFIRM });
  check("Cue's last line named their address but wasn't the confirmation: nothing changes", named.r.action === "not_saved" && !named.writes.length);
  const noConfirm = await run({ text: "jordan.lee@gmail.com", lastCo: CONFIRM, confirm: null });
  check("no confirmation text on record: nothing changes", noConfirm.r.action === "not_saved" && !noConfirm.writes.length);
  const cofounder = await run({ text: "can you also invite my cofounder sam@acme.com?", lastCo: CONFIRM });
  check("'invite my cofounder sam@acme.com' right after the confirmation: never their email", cofounder.r.action === "not_saved" && !cofounder.writes.length);
  const forward = await run({ text: "great, forward it to priya@shah.co too", lastCo: CONFIRM });
  check("asking Cue to forward to someone: never their email", forward.r.action === "not_saved" && !forward.writes.length);
  const typo = await run({ text: "it's not jordan.lea@gmail.com, it's jordan.lee@gmail.com", lastCo: CONFIRM });
  check("'it's not X, it's Y': the last address that differs is saved", typo.r.action === "updated" && typo.writes[0]?.args[1] === "jordan.lee@gmail.com", typo);
  const bad = await run({ text: "jordan.lee@gmail", lastCo: CONFIRM });
  check("an incomplete address: nothing written, the reply says so and never says updated", bad.r.action === "invalid" && !bad.writes.length && /Never say it was updated/.test(bad.note.instruction ?? ""));
  const unrelated = await run({ text: "can you email noor@studio.co the deck?", lastCo: "Here's the deck you asked for." });
  check("an address in a text that isn't a reply to the confirmation changes nothing", unrelated.r.action === "not_saved" && !unrelated.writes.length && !unrelated.note.fact);
  // Final review: a missed correction isn't silent: the reply is told it wasn't saved, never to say updated, and to ask once if they meant it.
  check("a missed correction: the reply gets the not-saved note, word for word", cofounder.note.instruction === "The email in their text was not saved; their email on file is still jordan.lea@gmail.com. Never say it was updated. If it looks like they meant to change their own email, ask once." && named.note.instruction === cofounder.note.instruction && !cofounder.note.fact);
  check("no address in their text: no note at all", (await run({ text: "sounds good", lastCo: CONFIRM })).note.instruction === null);
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
  check("hasPendingEmail ignores case and spaces", ID.hasPendingEmail("Pending-AB12@COPATIBLE.PENDING ") && ID.usableEmail("Pending-AB12@COPATIBLE.PENDING") === null);
  check("usableEmail: the placeholder is no email", ID.usableEmail("pending-ab12@copatible.pending") === null && ID.usableEmail("jordan@studio.co") === "jordan@studio.co" && ID.usableEmail("") === null && ID.usableEmail(null) === null);
  check("every templated email (otpActions sendEmail) refuses the placeholder", /if \(!usableEmail\(email\)\) return;/.test(src("src/otpActions.ts")));
  const OA = await import("../../src/otpActions.js");
  await OA.sendEmail({ email: "pending-ab12@copatible.pending", welcome: true } as any);
  check("sendEmail to the placeholder returns without a send (the layer-1 guard fails the run on any outside call)", true);

  const IT = await import("../../src/services/introByText.js");
  const jordan = { user_id: "a-jordan", first_name: "Jordan", phone_number: "+14155550101", email: "pending-ab12@copatible.pending" };
  const noor = { user_id: "b-noor", first_name: "Noor", phone_number: "+14155550102", email: "noor@studio.co" };
  const ch = IT.introChannels(jordan, noor);
  check("channels: the member with only the placeholder gets a text, the other the email", ch.text.map((p) => p.user_id).join() === "a-jordan" && ch.email.map((p) => p.user_id).join() === "b-noor");
  const ellis = { user_id: "c-ellis", first_name: "Ellis", phone_number: "+14155550103", email: null };
  // The intro text, word for word (Cue's first person; the lines are in the PR's Copy section for Royce).
  check("intro text (event, the other has email): first person, minimal, their email to reach them", IT.introText(jordan, noor, { event: "Thursday Supper" }, true) === "Jordan, meet Noor. You were both at Thursday Supper, and I thought you two should meet. You both said yes. You can reach Noor at noor@studio.co.");
  check("intro text (network, neither has email, relay on): Cue passes things on, never a phone number", IT.introText(ellis, jordan, { reason: "You're both building in climate" }, true) === "Ellis, meet Jordan. You're both building in climate. I thought you two should meet. You both said yes. Text me anything for Jordan and I'll pass it on." && !/\+1|555/.test(IT.introText(ellis, jordan, { reason: "x" }, true)));
  check("intro text: relay off, no promise to pass anything on", !/pass it on/.test(IT.introText(ellis, jordan, { event: "E" }, false)));
  check("intro text never shows the placeholder", !/copatible\.pending/.test(IT.introText(noor, jordan, { event: "E" }, true)));
  check("the emailed member's close points to the relay when the other has no email (relay on), never 'reply to this email'", IT.emailCloseFor(ch, true) === "You both said yes. To reach Jordan, text Cue and it'll pass it on." && IT.emailCloseFor(ch, false) === IT.EMAIL_CLOSE && IT.emailCloseFor({ text: [] }, true) === IT.EMAIL_CLOSE);
  check("the event email carries that close", (await import("../../src/services/eventGuestMatchHandoff.js")).introEmailContent("Supper", noor, jordan, IT.emailCloseFor(ch, true)).html.includes("To reach Jordan, text Cue and it&#39;ll pass it on.") || (await import("../../src/services/eventGuestMatchHandoff.js")).introEmailContent("Supper", noor, jordan, IT.emailCloseFor(ch, true)).html.includes("To reach Jordan, text Cue and it'll pass it on."));
  // The same-turn reply knows who got what (re-review finding 3).
  check("reply note: a member with no email is never told to check their email", /Never tell them to check their email or inbox/.test(IT.introHowNote(jordan, noor)) && /to them by email and to Jordan by text/.test(IT.introHowNote(noor, jordan)) && /Never mention email/.test(IT.introHowNote(jordan, ellis)));
  check("network same-turn lines carry the note and never say 'intro email'", !/intro email/.test(src("src/services/networkIntroNudge.ts").slice(src("src/services/networkIntroNudge.ts").indexOf("export function alreadyIntroducedLine"))) && /you've already sent the intro\. \$\{how\}/.test(src("src/services/networkIntroNudge.ts")));
  // Final review: the reply's fact comes from what happened (the state), never from the instruction's wording.
  const N = await import("../../src/services/networkIntroNudge.js");
  const facts: Record<string, RegExp> = {
    sent: /^Noor had already said yes, so Cue sent the intro\. HOW$/,
    held: /hasn't gone out yet; Cue will send it\. HOW$/,
    failed: /didn't go through yet; Cue will try again\. HOW$/,
    already: /^They and Noor were already introduced earlier\. No new intro went this turn\. HOW$/,
    pending: /on its way and isn't confirmed sent yet\. HOW$/,
    unconfirmed: /can't confirm the intro went through\. HOW$/,
    asked: /^Asked Noor whether they're open to an intro\. Waiting to hear back; no intro has been made\./,
    declined: /^Recorded that they passed on an intro to Noor\.$/,
  };
  for (const [state, re] of Object.entries(facts)) check(`network intro fact, ${state}`, re.test(N.networkIntroFact(state as any, "Noor", "HOW")), N.networkIntroFact(state as any, "Noor", "HOW"));
  check("only 'sent' says Cue sent the intro this turn; no other state says no intro was made except 'asked'", Object.keys(facts).filter((k) => /Cue sent the intro/.test(N.networkIntroFact(k as any, "Noor", ""))).join() === "sent" && Object.keys(facts).filter((k) => /no intro has been made/.test(N.networkIntroFact(k as any, "Noor", ""))).join() === "asked");
  // A repeat yes through the real resolver: the pair is already introduced, and the state says so (it used to fall to "no intro").
  const repeat = async (row: Record<string, unknown>) => {
    (pool as any).query = async (sql: string) => (/INSERT INTO network_introductions/.test(sql) ? { rows: [{ status: "introduced", both_interested: true, match_reason: "x", ...row }] } : { rows: [] });
    const r = await N.resolveNetworkIntroReplyState({ user_id: "a-jordan", first_name: "Jordan", phone_number: "+14155550101", email: "pending-ab12@copatible.pending" } as any, { askId: null, candidate: { candidate_id: "b-noor", first_name: "Noor", phone_number: "+14155550102", email: "noor@studio.co", match_reason: "x" } as any }, "interested").catch((e: any) => ({ state: `threw ${e?.message}` }) as any);
    (pool as any).query = realQuery;
    return r;
  };
  check("repeat yes, intro recorded sent: state 'already'", (await repeat({ email_sent: true, email_outcome: null }))?.state === "already");
  check("repeat yes, intro claimed and in flight: state 'pending'", (await repeat({ email_sent: false, email_outcome: null }))?.state === "pending");
  check("repeat yes, intro can't be confirmed: state 'unconfirmed'", (await repeat({ email_sent: false, email_outcome: "unknown" }))?.state === "unconfirmed");
  const dec = await (async () => { (pool as any).query = async () => ({ rows: [] }); const r = await N.resolveNetworkIntroReplyState({ user_id: "a-jordan", first_name: "Jordan" } as any, { askId: null, candidate: { candidate_id: "b-noor", first_name: "Noor", match_reason: "x" } as any }, "not_interested"); (pool as any).query = realQuery; return r; })();
  check("a no: state 'declined'", dec?.state === "declined");
  check("sendblue picks the fact from the state", /networkIntroFact\(resolved\.state, /.test(src("src/routes/sendblue.ts")) && !/\/you've already sent the intro\/\.test\(context\)/.test(src("src/routes/sendblue.ts")));
  // Final review: every text recipient passes the preflight before any text goes; one that can't means none go.
  {
    const sent: string[] = [];
    const r = await IT.textIntro({ to: [jordan, ellis], pair: [jordan, ellis], why: { event: "Supper" }, relayOn: true, key: "k" }, async (s) => { sent.push(s.userId); return { sent: true, queued: false }; }, async (p) => (p.user_id === "c-ellis" ? "opted out of texts" : null));
    check("two members with no email, one opted out: nothing is sent to either", !r.ok && sent.length === 0 && r.results.some((x) => x.reason === "opted out of texts"), { r, sent });
    const sent2: string[] = [];
    const r2 = await IT.textIntro({ to: [jordan, ellis], pair: [jordan, ellis], why: { event: "Supper" }, relayOn: true, key: "k" }, async (s) => { sent2.push(s.userId); return { sent: true, queued: false }; }, async () => null);
    check("both can get it: both are sent", r2.ok && sent2.join() === "a-jordan,c-ellis");
    const sent3: string[] = [];
    const r3 = await IT.textIntro({ to: [jordan], pair: [jordan, noor], why: { event: "  " }, relayOn: true, key: "k" }, async (s) => { sent3.push(s.userId); return { sent: true, queued: false }; }, async () => null);
    check("no real body (no event name): nothing is sent", !r3.ok && !sent3.length && r3.results[0]?.reason === "no real body");
  }
  check("the resolver's 'how' (who got a text, who an email) rides on every state's fact", /const how = \(await import\("\.\/introByText\.js"\)\)\.introHowNote\(person/.test(src("src/services/networkIntroNudge.ts")) && /networkIntroFact\(resolved\.state, resolvedIntro\.item\.ref\.pending\.candidate\.first_name, resolved\.how\)/.test(src("src/routes/sendblue.ts")) && !/Cue sent an intro email to both of them/.test(src("src/routes/sendblue.ts")));

  // The real event intro path (sendHeldIntro -> sendIntroEmail) on a fake database: the email goes to Noor only, Jordan gets the same
  // content by text, and the pair is saved as introduced only once both went.
  const run = async (o: { textOk: boolean }) => {
    process.env.CO_RELAY = "on";
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
    IT.setIntroTextSendForTests(async (s) => { texts.push(s); return o.textOk ? { sent: true, queued: false } : { sent: false, queued: false, reason: "opted out" }; }, async () => null);
    const log = console.log, err = console.error;
    console.log = (...a: any[]) => { logs.push(a.join(" ")); };
    console.error = () => {};
    const H = await import("../../src/services/eventGuestMatchHandoff.js");
    const ok = await H.sendHeldIntro("test-supper", "a-jordan", "b-noor").catch((e: any) => { logs.push(`THREW ${e?.message}`); return false; });
    console.log = log; console.error = err;
    IT.setIntroTextSendForTests(null);
    (pool as any).query = realQuery;
    delete process.env.CO_RELAY;
    return { ok, writes, texts, logs };
  };
  const went = await run({ textOk: true });
  const emailLog = went.logs.find((l) => /sendIntroEmail stub/.test(l)) ?? "";
  check("event intro: the email goes to the member with a real email only, never the placeholder", /to noor@studio\.co:/.test(emailLog) && !/copatible\.pending/.test(emailLog), went.logs);
  check("event intro: the member without an email gets it by text, through the gated send", went.texts.length === 1 && went.texts[0].userId === "a-jordan" && went.texts[0].phoneNumber === "+14155550101" && went.texts[0].text === "Jordan, meet Noor. You were both at Thursday Supper, and I thought you two should meet. You both said yes. You can reach Noor at noor@studio.co.", went.texts);
  check("event intro: saved as introduced (co_pairs intro_sent_at) once both went", went.ok === true && went.writes.some((w) => /UPDATE co_pairs SET intro_sent_at/.test(w)), went.writes);
  const held = await run({ textOk: false });
  check("event intro: a text that can't go leaves the pair not introduced, counted as a failed try, and NO email goes", held.ok === false && !held.writes.some((w) => /SET intro_sent_at/.test(w)) && held.writes.some((w) => /SET intro_attempts/.test(w)) && !held.logs.some((l) => /sendIntroEmail stub/.test(l)), { writes: held.writes, logs: held.logs });
  const hs = src("src/services/eventGuestMatchHandoff.ts");
  check("event intro: in the code, the text is sent before any email", hs.indexOf("IT.textIntro(") > 0 && hs.indexOf("IT.textIntro(") < hs.indexOf("resend.emails.send({ from: CO_EMAIL_FROM, to: emailTo"));
  const ns = src("src/services/networkIntroNudge.ts");
  check("network intro: the text is sent before any email too", ns.indexOf("IT.textIntro(") > 0 && ns.indexOf("IT.textIntro(") < ns.indexOf("resend.emails.send({ from: CO_EMAIL_FROM, to: emailTo"));
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
  // Re-review 8: casual words alone don't trip it; anchored ones do.
  check("not sensitive: 'we fired up the kiln', 'afraid we'll run late', 'let go of the old logo'", !SENSITIVE.test("We fired up the kiln for the launch") && !SENSITIVE.test("afraid we'll run late to the launch") && !SENSITIVE.test("let go of the old logo for the studio"));
  check("sensitive: 'got fired', 'was let go', 'I'm scared'", SENSITIVE.test("I got fired on Friday") && SENSITIVE.test("I was let go from the agency") && SENSITIVE.test("honestly I'm scared"));
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
  // Re-review: only questions about THEIR email or name.
  for (const t of ["What's the address of the venue?", "Want me to reach out to the host's contact?", "I'll email you the plan.", "What's the name of the bakery?"]) check(`not an ask: "${t}"`, !I.askedForEmail(t) && !I.askedForName(t) && !I.replyAskedFor(["name", "email"], t) && !I.replyAskedFor(["name"], t));
  check("call: 'I'll email you the plan' on a call isn't the ask", !CE.cueAskedForEmail("assistant: I'll email you the plan.\nuser: great") && !CE.cueAskedForEmail("assistant: What's the address of the venue?\nuser: 12 Valencia"));
  check("still asks: your email, best email, what should I call you, your name", I.askedForEmail("What's your email?") && I.askedForEmail("What's the best email for you?") && I.askedForName("What should I call you?") && I.askedForName("What's your name?"));
  // Names from the wrong question (re-review 7): a bare answer is theirs only after a question about THEIR name.
  check("'Nopa' after 'the name of the place?' is not their name", !I.nameIsTheirs("Nopa", "Nopa", "What's the name of the place?"));
  check("'Priya Shah' after 'the name of the guy?' is not their name", !I.nameIsTheirs("Priya Shah", "Priya Shah", "What's the name of the guy?"));
  check("a bare name after 'what's your name?' is theirs", I.nameIsTheirs("Jordan Lee", "Jordan Lee", "What's your name?"));
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
