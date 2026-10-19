// The rename (Royce, 2026-10-14: the agent is Cue, the company Noise). Layer 1, zero tokens: the "hey co" alias and its end date,
// the one "I'm going by Cue now" text (once per member, riding or alone, including two sends at once), the readers of transcripts
// in both the old and new forms, and the team-line parsers that keep old rows fenced out. Test members are invented (Jordan, Noor,
// Ellis); nothing is sent: the ledger and Sendblue are faked (evals/lib/fakeLedger.ts).
//
//   npx tsx evals/proactive/nameChange.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
import fs from "node:fs";
import { installFakeLedger } from "../lib/fakeLedger.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
};
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- 1. the alias
const N = await import("../../src/services/agentName.js");
check("the alias ends on the agreed day", N.CO_ALIAS_UNTIL === "2027-01-31");
check("alias: on during the grace period, to the last minute of Jan 31 Pacific", N.coAliasActive(new Date("2026-10-14T20:00:00Z")) && N.coAliasActive(new Date("2027-02-01T07:30:00Z")));
check("alias: off after it", !N.coAliasActive(new Date("2027-02-01T08:30:00Z")) && !N.coAliasActive(new Date("2027-06-01T00:00:00Z")));
check("the names it answers to: both during, Cue only after", N.addressNames(new Date("2026-12-01T00:00:00Z")).join() === "cue,co" && N.addressNames(new Date("2027-03-01T00:00:00Z")).join() === "cue");
const E = await import("../../src/services/elevenLabsCalls.js");
check("the call's speech keywords listen for Cue, and for Co only during the alias", E.standingCallKeywords(new Date("2026-12-01T00:00:00Z")).slice(0, 2).join() === "Cue,Co" && !E.standingCallKeywords(new Date("2027-03-01T00:00:00Z")).includes("Co") && E.standingCallKeywords(new Date("2027-03-01T00:00:00Z"))[0] === "Cue");
check("\"Noise\" is never a speech keyword (a common word)", !E.standingCallKeywords(new Date("2026-12-01T00:00:00Z")).includes("Noise"));
const { CO_VOICE } = await import("../../src/services/coVoice.js");
check("Cue's voice: its name, the company, and that \"co\" is still it until the alias ends", /You are Cue\b/.test(CO_VOICE) && /The company is Noise/.test(CO_VOICE) && /used to be Co/.test(CO_VOICE) && /January 31, 2027/.test(CO_VOICE) && /answer as Cue/.test(CO_VOICE));
check("Cue's voice: history lines marked Co are its own", /Lines in your history marked Co/.test(CO_VOICE));
check("the call's voice layer (also Hume's prompt) says the same", /You are Cue\b/.test(fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8")) && /used to be Co/.test(fs.readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8")));
const CC = await import("../../src/services/conversationClose.js");
check("\"thanks cue\" and \"thanks co\" close like \"thanks\"", ["thanks cue", "Thanks Co.", "thanks"].every((t) => CC.closingReaction(t) !== null), ["thanks cue", "Thanks Co.", "thanks"].map((t) => CC.closingReaction(t)));
const SR = await import("../../src/services/searchRules.js");
check("\"any updates on cue?\" and \"any updates on co?\" are the bare updates ask", SR.isOnlyUpdatesAsk("any updates on cue?") && SR.isOnlyUpdatesAsk("any updates on co?"));
const IR = await import("../../src/services/issueReports.js");
check("issue capture reads feedback about Cue the way it read feedback about Co", typeof IR === "object" && /\|co\|co's\|cue\|cue's\|/.test(src("services/issueReports.ts")));
const PE = await import("../../src/services/profileExtraction.js");
// "cue" is a common word (the ASR check, 2026-10-14): only the name counts as being about the agent.
check("\"my cue to leave\", \"a pool cue\" and \"cue up\" are about them; \"updates from Cue\" and \"co\" are about the agent", !PE.isAboutCo("that was my cue to leave") && !PE.isAboutCo("the pool cue broke") && !PE.isAboutCo("Cue up the next one") && PE.isAboutCo("not enough updates from Cue") && PE.isAboutCo("lack of information from co"));
check("the venue QR text works with either name", /at\\s\+a\\s\+\(\?:co\|cue\|noise\)\\s\+/.test(src("services/eventWalkinCheckin.ts")));

// ---------------------------------------------------------------- 2. the announcement
const P = await import("../../src/harness/proactive.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const NC = await import("../../src/services/nameChange.js");
const A = await import("../../src/services/askRetire.js");
const { carryLaneNotes } = await import("../../src/services/laneMoves.js");
const { default: pool } = await import("../../src/db/db.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");

check("its own text is light, in Cue's voice, and one thing", NC.NAME_CHANGE_TEXT === "Quick one: I'm going by Cue now. Same me, new name.");
check("it passes the proactive draft checks as written", P.checkDraft(NC.NAME_CHANGE_TEXT, { maxChars: 120, maxSentences: 3 }).every((c) => c.pass), P.checkDraft(NC.NAME_CHANGE_TEXT, { maxChars: 120, maxSentences: 3 }).filter((c) => !c.pass));
check("its riding line says the same, as an aside", NC.carriesNameChange(NC.NAME_CHANGE_RIDE) && NC.carriesNameChange(NC.NAME_CHANGE_TEXT) && !NC.carriesNameChange("I'll keep an eye on it."));
check("it expires when the alias does", NC.NAME_CHANGE_EXPIRES.getTime() === Date.parse("2027-02-01T07:59:59Z"));
check("one key per member, the same every time", NC.NAME_CHANGE_KEY === "name_change:cue");
check("lowest priority of every kind", P.TYPE_POLICY.name_change.priority < Math.min(...Object.entries(P.TYPE_POLICY).filter(([t]) => t !== "name_change").map(([, p]) => p.priority)));
check("held while they're struggling", P.HOLD_WHILE_STRUGGLING.has("name_change"));

const day = new Date();
const cand = (o: { id: string; userId: string; type: string; targetKey: string }): any => ({ ...o, topicKey: o.targetKey, summary: "", priority: 1, dueAt: new Date(day.getTime() - 60_000), expiresAt: null, payload: {}, attempts: 0, createdAt: day });
const checksFor = (c: any, extra: Record<string, unknown>) => P.candidateChecks(c, { now: day, sends: [], lastInboundAt: null, needsCare: false, safetyHold: false, undeliveredYes: false, suppressedKinds: [], away: null, joinedAt: null, ...extra } as any);
check("a safety hold holds it", checksFor(cand({ id: "1", userId: "u", type: "name_change", targetKey: NC.NAME_CHANGE_KEY }), { safetyHold: true }).some((c) => c.name === "safety_hold" && !c.pass));
check("struggling holds it", checksFor(cand({ id: "1", userId: "u", type: "name_change", targetKey: NC.NAME_CHANGE_KEY }), { needsCare: true }).some((c) => c.name === "emotional_timing" && !c.pass));
check("already on the ledger: never again", checksFor(cand({ id: "1", userId: "u", type: "name_change", targetKey: NC.NAME_CHANGE_KEY }), { sends: [{ type: "name_change", targetKey: NC.NAME_CHANGE_KEY, topicKey: NC.NAME_CHANGE_KEY, sentAt: new Date(day.getTime() - 86_400_000), exempt: true }] }).some((c) => c.name === "not_sent_before" && !c.pass));

// Riding: the line goes after what the text says, and a question stays last.
const rode = A.rideAlong(["https://example.com/supper", "Saw this one for you. Worth a look?"], NC.NAME_CHANGE_RIDE, (d, p) => carryLaneNotes(d, p));
check("riding: the line is in the caption, the link left alone, the question still last", rode[0] === "https://example.com/supper" && NC.carriesNameChange(rode[1]) && rode[1].trim().endsWith("?"), rode);

// A zone where it's midday now, so the hours check passes for the real clock.
function zoneAtHour(hour: number): string {
  let off = (hour - new Date().getUTCHours() + 24) % 24;
  if (off > 14) off -= 24;
  return off === 0 ? "Etc/GMT" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
}
const person = (name: string, phone: string) => ({ userId: `u-${name.toLowerCase()}`, firstName: name, phoneNumber: phone, city: "San Francisco", timezone: zoneAtHour(13) });
const told = (outbox: { content: string }[], phone: string) => outbox.filter((m) => (m as any).to === phone && NC.carriesNameChange(m.content)).length;

{
  // Alone: Jordan gets it once; a second dispatch of the same candidate is refused.
  const f = installFakeLedger(pool, sendblue);
  try {
    const jordan = person("Jordan", "+14155550101");
    const c = cand({ id: "n1", userId: jordan.userId, type: "name_change", targetKey: NC.NAME_CHANGE_KEY });
    const first = await P.sendWithLedgerForTests(c, jordan, [NC.NAME_CHANGE_TEXT]);
    const second = await P.sendWithLedgerForTests(c, jordan, [NC.NAME_CHANGE_TEXT]);
    check("alone: it goes once", first.sent === true && told(f.ledger.outbox, jordan.phoneNumber) === 1, f.ledger.outbox);
    check("alone: the second try is refused at the ledger", second.sent === false && told(f.ledger.outbox, jordan.phoneNumber) === 1, second);
    const drafted = await proactiveRegistry.name_change.draft(c, jordan);
    check("alone: the draft re-reads the ledger and skips once told", "skip" in drafted, drafted);
  } finally {
    f.restore();
  }
}
{
  // Riding: Noor's check-in carries it; the queued notice is then marked sent and its own send is refused.
  const f = installFakeLedger(pool, sendblue);
  try {
    const noor = person("Noor", "+14155550102");
    const notice = cand({ id: "n2", userId: noor.userId, type: "name_change", targetKey: NC.NAME_CHANGE_KEY });
    const checkin = cand({ id: "c2", userId: noor.userId, type: "companion", targetKey: "companion:week" });
    const without = ["How did the pitch land with the second fund?"];
    const withLine = A.rideAlong(without, NC.NAME_CHANGE_RIDE, (d, p) => carryLaneNotes(d, p));
    const rideSend = await P.sendWithLedgerForTests(checkin, noor, withLine, {}, [], { candidate: notice, without });
    const own = await P.sendWithLedgerForTests(notice, noor, [NC.NAME_CHANGE_TEXT]);
    check("riding: one text, carrying the line", rideSend.sent === true && f.ledger.outbox.length === 1 && told(f.ledger.outbox, noor.phoneNumber) === 1, f.ledger.outbox);
    check("riding: the notice is ledgered with that text and marked sent", f.ledger.sends.some((s) => s.target_key === NC.NAME_CHANGE_KEY && s.exempt) && f.ledger.sentCandidates.includes("n2"), f.ledger);
    check("riding: its own send afterwards is refused", own.sent === false && told(f.ledger.outbox, noor.phoneNumber) === 1);
  } finally {
    f.restore();
  }
}
{
  // A race: Ellis's check-in (with the line riding) and the notice's own send start together. Exactly one of them tells him.
  const f = installFakeLedger(pool, sendblue);
  try {
    const ellis = person("Ellis", "+14155550103");
    const notice = cand({ id: "n3", userId: ellis.userId, type: "name_change", targetKey: NC.NAME_CHANGE_KEY });
    const checkin = cand({ id: "c3", userId: ellis.userId, type: "companion", targetKey: "companion:week3" });
    const without = ["Thinking of you before Thursday's demo."];
    const withLine = A.rideAlong(without, NC.NAME_CHANGE_RIDE, (d, p) => carryLaneNotes(d, p));
    const [a, b] = await Promise.all([P.sendWithLedgerForTests(checkin, ellis, withLine, {}, [], { candidate: notice, without }), P.sendWithLedgerForTests(notice, ellis, [NC.NAME_CHANGE_TEXT])]);
    check("race: the name is told exactly once", told(f.ledger.outbox, ellis.phoneNumber) === 1, { a, b, outbox: f.ledger.outbox });
    check("race: the check-in still goes, with or without the line", f.ledger.outbox.some((m) => m.content.startsWith("Thinking of you before Thursday's demo.")), f.ledger.outbox);
    check("race: one ledger row for the notice", f.ledger.sends.filter((s) => s.target_key === NC.NAME_CHANGE_KEY).length === 1);
  } finally {
    f.restore();
  }
}
{
  // Many runs of the race, either order winning: never twice.
  let twice = 0, never = 0;
  for (let i = 0; i < 20; i++) {
    const f = installFakeLedger(pool, sendblue);
    try {
      const p = person("Jordan", `+1415555${String(200 + i).padStart(4, "0")}`);
      const notice = cand({ id: `n${i}`, userId: p.userId, type: "name_change", targetKey: NC.NAME_CHANGE_KEY });
      const checkin = cand({ id: `c${i}`, userId: p.userId, type: "companion", targetKey: `companion:${i}` });
      const without = ["Hope the week's been kind."];
      const withLine = A.rideAlong(without, NC.NAME_CHANGE_RIDE, (d, q) => carryLaneNotes(d, q));
      const sends = [() => P.sendWithLedgerForTests(checkin, p, withLine, {}, [], { candidate: notice, without }), () => P.sendWithLedgerForTests(notice, p, [NC.NAME_CHANGE_TEXT])];
      await Promise.all(i % 2 ? sends.reverse().map((s) => s()) : sends.map((s) => s()));
      const n = told(f.ledger.outbox, p.phoneNumber);
      if (n > 1) twice++;
      if (n === 0) never++;
    } finally {
      f.restore();
    }
  }
  check("race, 20 runs either way round: never told twice, never lost", twice === 0 && never === 0, { twice, never });
}

// The dispatcher's wiring (harness/proactive.ts): it never competes for the pick, rides on the stop-note terms, and its key is
// claimed inside the send lock.
const pr = src("harness/proactive.ts");
check("dispatch: never in the pick while anything else is ready", /const withoutName = nameNotice && ev\.eligible\.length > 1 \? ev\.eligible\.filter\(\(x\) => x\.type !== "name_change"\) : ev\.eligible;/.test(pr) && /const pickable = \(await import\("\.\.\/services\/announcements\.js"\)\)\.quietDayOnly\(withoutName\);/.test(pr) && /choosePick\(pickable,/.test(pr));
check("dispatch: rides only where a stopped-looking line may, never with one, never in a composed bundle", /if \(!composed && !rideNote && nameNotice && c\.type !== "name_change"\)/.test(pr) && /A\.noteMayRide\(c, heldForMood\(member\.state\)\) && !N\.carriesNameChange/.test(pr));
check("send: the riding key is claimed inside the lock, and the text goes without the line if it was taken", pr.indexOf("The riding note's key, claimed first") > pr.indexOf("pg_advisory_xact_lock(hashtext($1))`, [`proactive:${person.userId}`]") && /else messages = ride\.without;/.test(pr));
// The queue is the update announcements' (services/announcements.ts RENAME), the same SQL it always ran.
const ncSrc = src("services/announcements.ts");
check("queue: the rename's queue is the registry's rename entry", /return A\.queueAnnouncement\(A\.RENAME, now\);/.test(src("services/nameChange.ts")));
check("queue: only members who knew it as Co, never archived, opted out, without a number or unfinished", /u\.created_at < \$1 AND u\.archived_at IS NULL AND COALESCE\(u\.sms_opted_out, false\) = false/.test(ncSrc) && /u\.phone_number IS NOT NULL AND u\.identity_captured = true/.test(ncSrc));
check("queue: the cutoff is fixed by the first queued notice, so a member who joins later never gets it", /SELECT MIN\(created_at\) AS at FROM proactive_candidates WHERE type = 'name_change'/.test(ncSrc));
check("queue: runs daily and once after start, through the normal dispatch", /queueNameChange\(\)/.test(src("jobs/index.ts")) && /cron\.schedule\("40 9 \* \* \*", queueNames/.test(src("jobs/index.ts")));
check("archiving skips everything queued, the notice included", /UPDATE proactive_candidates SET status = 'skipped', skip_reason = 'account archived'/.test(src("services/accountArchive.ts")));

// ---------------------------------------------------------------- 3. transcript readers: the stored prefix stays "Co replied:"
// New writes keep "Co replied:" (stored rows and their SQL readers stay as they are); what reads a transcript accepts both forms.
const Y = await import("../../src/services/theirYes.js");
const both = (fn: (s: string) => unknown, a: string, b: string) => JSON.stringify(fn(a)) === JSON.stringify(fn(b));
check("turnsFromLog: Co replied and Cue replied are both the agent", both(Y.turnsFromLog, "User said: hi\nCo replied: want me to look?", "User said: hi\nCue replied: want me to look?") && Y.turnsFromLog("Cue replied: x")[0]?.side === "co");
check("offerLines: \"Co: \" and \"Cue: \" lines are both offers", Y.offerLines("Co: Want me to look into it?\nMember: yes")[0] === "Want me to look into it?" && Y.offerLines("Cue: Want me to look into it?\nMember: yes")[0] === "Want me to look into it?");
check("exchangeText writes the agent's side as Cue", /^Cue: /m.test(Y.exchangeText([{ side: "co", text: "hello" }, { side: "member", text: "hi" }])));
const AS = await import("../../src/services/askSplit.js");
const ex1 = await AS.exchangeFromTranscript("Co replied: Want me to find a caterer?\nUser said: yes please");
const ex2 = await AS.exchangeFromTranscript("Cue replied: Want me to find a caterer?\nUser said: yes please");
check("askSplit: both prefixes give the same exchange", ex1.message === "yes please" && ex2.message === "yes please" && ex1.recent === ex2.recent, { ex1, ex2 });
const RA = await import("../../src/harness/repeatAsk.js");
check("repeatAsk: both prefixes are the agent's turns", both((s) => RA.turnsFromConversation(s), "Co replied: How was it?\nUser said: good", "Cue replied: How was it?\nUser said: good"));
const SL = await import("../../src/harness/stockLines.js");
check("stockLines: \"Co:\" and \"Cue:\" transcript lines are the agent's", SL.coLinesOf("Co: one\nuser: two\nCue: three").join("|") === "one|three");
const PW = await import("../../src/harness/profileWrite.js");
{
  const sp = PW.splitSpeakers("Co replied: You said Denver.\nCue replied: It was Austin.\nUser said: Austin");
  check("profileWrite: both prefixes are the agent's, kept out of their words", sp.theirs.toLowerCase() === "user said: austin" && /denver/i.test(sp.cos) && /it was austin/i.test(sp.cos), sp);
}
const MK = await import("../../src/services/memberKnowledge.js");
check("memberKnowledge: both prefixes read as the agent's lines", MK.exchangeOf({ content: "Co replied: hi", at: day })?.from === "co" && MK.exchangeOf({ content: "Cue replied: hi", at: day })?.from === "co" && MK.exchangeOf({ content: "User said: hi", at: day })?.from === "member");
const SF = await import("../../src/services/sourceFence.js");
check("the fence keeps both prefixes as the agent's side", SF.fenceExchange({ strip: (t: string) => t }, [{ at: day, content: "Co replied: a" }, { at: day, content: "Cue replied: b" }]).map((l) => `${l.from}:${l.text}`).join("|") === "co:a|co:b");
const CL = await import("../../src/services/claims.js");
check("a recap's read section is found under either name", CL.splitRecap("Who they are\nx\n\nCo's read\ny").coRead === "Co's read\ny" && CL.splitRecap("Who they are\nx\n\nCue's read\ny").coRead === "Cue's read\ny");
const KR = await import("../../src/services/kindRestraint.js");
check("a threaded reply to the agent's text is read under either name", KR.readInbound({ at: day, text: "sounds good [Replying to Co's text: \"Supper?\"]" }).quoted === "Supper?" && KR.readInbound({ at: day, text: "sounds good [Replying to Cue's text: \"Supper?\"]" }).quoted === "Supper?");
const IF = await import("../../src/services/inboundFile.js");
check("an unreadable file is recognized under either name", ["[sent a PDF Co couldn't open]", "[sent a PDF Cue couldn't open]"].every((t) => /couldn't be opened/.test(IF.fileRecordFact([{ at: day, content: `User said: here ${t}` }], "did you get it?") ?? "")));
const MR = await import("../../src/services/messageRouter.js");
check("a stored call offer reads under either name", ["| Co offered: Want to talk it through?", "| Cue offered: Want to talk it through?"].every((d) => /"Want to talk it through\?"/.test(MR.describeOpenItem("call_offer", `Asked about a call ${d}`))));
const DC = await import("../../src/services/coPages/deckClaims.js");
check("a deck approval pairs with the agent's last text under either name", DC.approvalPair(["Co: Want the deck?", "Them: yes"]) !== "" && DC.approvalPair(["Cue: Want the deck?", "Them: yes"]) !== "");
check("nothing writes \"Cue replied:\" yet (if something starts to, every SQL reader of 'Co replied:%' must change with it)", !/[`"']Cue replied:/.test(fs.readdirSync(new URL("../../src/", import.meta.url), { recursive: true } as any).filter((f: any) => String(f).endsWith(".ts")).map((f: any) => src(String(f))).join("\n")));

// ---------------------------------------------------------------- 4. team lines (a privacy guard): old rows stay fenced out
const TL = await import("../../src/services/teamLines.js");
const thread = ["User said: hi", "User said: pause it [to Mo]", "Mo replied: paused", "Mo said: done", "Co tagged Mo: @Mo", "Co replied: sure", "Cue replied: and this"].join("\n");
check("team lines: their texts to a teammate, its replies and Co's tag drop; both agent prefixes stay", TL.withoutTeammateLines(thread) === "User said: hi\nCo replied: sure\nCue replied: and this");
check("team lines: the SQL fence leaves out a trailing [to Name]", TL.notToTeammate().includes(String.raw`\[to [A-Za-z]+\]$`) && TL.notToTeammate("m").startsWith("m.content"));
check("team lines: an old text to Mo never reaches the fenced exchange", SF.fenceTheirTexts({ strip: (t: string) => t }, [{ at: day, text: "tell Jordan the plan [to Mo]" }]).length === 0);

console.log(`name change: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
