// The first conversation (Royce, 2026-11-02, onboarding rulings 1-3 on ~/cue-worktrees/notes/onboarding-proposal-1102.md):
//   1. a first call (no past call transcript) gets the approved first-call guidance in place of the four phases; GPT-Live's opening gets
//      one line of their own texted words (at most 160 characters, work or plans only, through the SENSITIVE filter) as background;
//   2. the inviter is named only when the member wrote that name themselves;
//   3. text sign-up: Cue answers the first text and every text while it collects name and email, asked once, never a condition; the
//      automatic call offer modelled on Boardy's is gone;
//   4. email on a call: asked once near the end when it isn't on file, captured by the intake extraction, one text to confirm.
// Layer 1: zero tokens, no database (stubs), nothing sent. Invented members (Jordan, Noor, Ellis).
//   TZ=UTC node evals/runLayer1.mjs evals/onboarding/firstConversation.ts
process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
import { readFileSync } from "fs";

const G = await import("../../src/services/gptLive.js");
const F = await import("../../src/services/firstCall.js");
const I = await import("../../src/harness/intake.js");
const CE = await import("../../src/services/callEmail.js");
const OL = await import("../../src/services/onboardingLines.js");
const { SENSITIVE } = await import("../../src/services/callReason.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const VOICE = src("prompts/co-system-prompt.md");

// ---------------------------------------------------------------- the approved guidance, word for word (the proposal's [COPY] block)
const APPROVED = [
  "This is your first real conversation with {{first_name}}. You're not taking a profile. Find out what they're in the middle of, what they want from it and what they could give someone, then stop.",
  "Start from what you have. Their texts, who brought them in and what they asked for are already said: build on them and never ask again. If you have nothing, ask what's going on for them lately and follow where they take it.",
  "Ask as many questions as one thread needs, but never switch topics to fill a list. Where they live, when they're free and their tastes come later, unless the thread needs them now.",
  "Keep turns to one or two sentences. A reaction of your own often beats another question.",
  "Once, when you've heard enough, say back one thing they didn't say outright: how what they're in the middle of connects to who or what would help. Use their terms and make it a read they can correct. Don't recap, and say nothing about their character or feelings.",
  "Then give a real next step: what you'll do after the call, or one thing worth doing this week. Never promise a person. Nobody is named until both have said yes. When you describe what you'll do, say plainly that you'll check with both people first.",
  "If their email isn't on file, ask once near the end, say why in a few words, and drop it if they'd rather not.",
  "If what they're in the middle of is hard, stay with that; connections can wait. Don't describe how you're different unless asked. Ten minutes or less. If they're short on time, go straight to the read and the next step.",
];
const section = VOICE.slice(VOICE.indexOf(G.FIRST_CALL_SECTION), VOICE.indexOf("\n───", VOICE.indexOf(G.FIRST_CALL_SECTION) + 5));
check("the call prompt carries the approved first-call guidance word for word, as its own section", section.split("\n").slice(1).join("\n") === APPROVED.join("\n"), section);
check("the call prompt stays dash-free (spoken dashes)", !/[—–]/.test(VOICE.replace(/─+|━+/g, "")));

// ---------------------------------------------------------------- 1. the first-call flag
check("first-call flag: no past call transcript", F.isFirstCall(0) && !F.isFirstCall(1));
type Q = { sql: string; args?: unknown[] };
const fakeDb = (o: { pastCall?: boolean; texts?: string[]; inviter?: string | null; email?: string; asked?: number; fail?: boolean; removed?: { old: string }[] }) => {
  const seen: Q[] = [];
  return {
    seen,
    query: async (sql: string, args?: unknown[]) => {
      seen.push({ sql, args });
      if (o.fail) throw new Error("db down");
      if (/memory_type = 'call_transcript'/.test(sql)) return { rows: o.pastCall ? [{ "?column?": 1 }] : [] };
      if (/User said:/.test(sql)) return { rows: (o.texts ?? []).map((t) => ({ content: `User said: ${t}` })) };
      if (/FROM invite_codes/.test(sql)) return { rows: o.inviter ? [{ first_name: o.inviter }] : [] };
      if (/SELECT email, intake_retries FROM users/.test(sql)) return { rows: [{ email: o.email ?? "pending-ab12@copatible.pending", intake_retries: o.asked ?? 0 }] };
      if (/FROM profile_corrections/.test(sql)) return { rows: (o.removed ?? []).map((r, i) => ({ field: "text", old_value: r.old, new_value: null, item_ref: `t${i}`, removed: true })) };
      return { rows: [] };
    },
  };
};
{
  const later = await F.firstCallFacts("u-jordan", fakeDb({ pastCall: true, texts: ["I'm leaving the agency to freelance in packaging design"] }));
  check("a member with a past call transcript is not on a first call, however much they texted", later.firstCall === false && !("theirWords" in later && later.theirWords));
  const first = await F.firstCallFacts("u-jordan", fakeDb({ texts: ["gave notice, last day the 21st, freelance or join a studio?"] }));
  check("a member with texts but no past call is on a first call (never 'empty context')", first.firstCall === true && first.theirWords === "gave notice, last day the 21st, freelance or join a studio?", first);
  check("a failed read is not a first call (the four phases, as before)", (await F.firstCallFacts("u-jordan", fakeDb({ fail: true }))).firstCall === false);
  const route = src("src/routes/co.ts");
  const answer = route.slice(route.indexOf("async function gptLiveAnswer"), route.indexOf("async function gptLiveRefusalTwiml"));
  check("every GPT-Live call (inbound and outbound) reads the flag and passes it to buildLiveCall", /firstCallFacts\(o\.userId\)/.test(answer) && /zone\), first \}\);/.test(answer));
  check("the call context no longer calls an empty context a first conversation", !/If that's empty, this is your first real conversation/.test(src("src/services/elevenLabsCalls.ts")));
}

// ---------------------------------------------------------------- 1. the guidance on first calls only
const base = { userId: "u-jordan", callSid: "CA1", firstName: "Jordan", team: false, voiceLayer: VOICE, contextSummary: "Where things stand now: leaving the agency on the 21st.", rightNow: "Tuesday 2pm.", findsNow: "", callReason: "", timeOfDay: "Tuesday afternoon" };
const firstIn = G.buildLiveCall({ ...base, direction: "inbound", first: { firstCall: true, theirWords: "gave notice, last day the 21st, freelance or join a studio?", inviter: "Noor", emailOnFile: false, emailAsked: false } });
const laterIn = G.buildLiveCall({ ...base, direction: "inbound", first: { firstCall: false } });
const noFlag = G.buildLiveCall({ ...base, direction: "inbound" });
check("a first call's thinking gets the first-call guidance, filled with their name", firstIn.backendSystem.includes("This is your first real conversation with Jordan. You're not taking a profile.") && APPROVED.slice(1).every((l) => firstIn.backendSystem.includes(l)));
check("a first call's thinking has no four-phase interview (no nine-item checklist, no recap phase, no stock close)", !/THE FOUR PHASES|nine things|PHASE 2: CONFIRM UNDERSTANDING|Location and availability, where they are|when something real fits, you'll text them/.test(firstIn.backendSystem));
check("a later call keeps the four phases and never sees the first-call section", /THE FOUR PHASES/.test(laterIn.backendSystem) && /nine things/.test(laterIn.backendSystem) && !laterIn.backendSystem.includes(G.FIRST_CALL_SECTION) && !laterIn.backendSystem.includes("You're not taking a profile"));
check("no flag at all is a later call (callers that don't pass it keep today's prompt)", noFlag.backendSystem === laterIn.backendSystem);
for (const [label, c] of [["first", firstIn], ["later", laterIn]] as const) {
  const b = c.backendSystem;
  check(`${label} call: crisis handling stays (guardrails, 988)`, /# Guardrails/.test(b) && /988/.test(b));
  check(`${label} call: the goodbye and closing rules stay (say it once, rewritten for GPT-Live)`, /Say that goodbye once\./.test(b) && /"Sounds good," "thank you," and "okay" are them answering/.test(b) && !/\bend_call\b/.test(b));
  check(`${label} call: their rules for how Cue treats them stay (#355-#363 preferences)`, /The rules they set for how you treat them are listed there too/.test(b));
  check(`${label} call: never names a person as a match (double opt-in)`, /Never promise a person|introduc/i.test(b));
  check(`${label} call: nothing GPT-Live may never say`, !G.GPT_LIVE_FORBIDDEN.some((re) => re.test(b) || re.test(c.instructions)));
}
check("the first call's thinking knows the email isn't on file, and the inviter they named", /Their email isn't on file yet\./.test(firstIn.given.contextSummary) && /Who brought them in: Noor, a member\. They named Noor themselves\./.test(firstIn.given.contextSummary));
check("a later call carries no first-call facts", !/Their email (isn't|is) on file/.test(laterIn.given.contextSummary) && !/Who brought them in/.test(laterIn.given.contextSummary));

// ---------------------------------------------------------------- 1. the opening's background: their words, through the filter
check("their words: the newest work-or-plans line", F.openingWords(["sounds good", "We're raising a seed round in March and hiring two engineers"]) === "We're raising a seed round in March and hiring two engineers");
check("their words: never a sensitive line (SENSITIVE)", F.openingWords(["My biopsy results come back Friday, then I start the new job", "The divorce is final so I'm moving to Oakland for work"]) === null);
check("their words: never feelings or other people's business without work or plans", F.openingWords(["I've been so lonely lately and it's hard", "my sister is visiting"]) === null);
check("their words: never the invite code, an email, a number or a link", F.openingWords(["Hi Cue, Noor invited me. Code: 6VGF76VK", "my work email is jordan@studio.co", "call my work line 415 555 0101", "here's the project https://x.test/p"]) === null);
const long = "I'm leaving the agency after six years to start a packaging design studio of my own with two old clients who keep asking me to do their branding work on the side";
const cut = F.openingWords([long]);
check("their words: at most 160 characters, cut at a word", !!cut && cut.length <= 160 && long.startsWith(cut) && /\w$/.test(cut), cut);
check("every line the opening can carry passes the SENSITIVE filter", [cut, F.openingWords(["We're raising a seed round in March and hiring two engineers"])].every((w) => !!w && !SENSITIVE.test(w)));
{
  const removed = await F.firstCallFacts("u-jordan", fakeDb({ texts: ["I'm interviewing at Stripe for a design role next week"], removed: [{ old: "interviewing at Stripe for a design role" }] }));
  check("their words: a line they removed never reaches the opening (ruling B)", removed.firstCall && !removed.theirWords, removed);
}
check("inbound first call: their words are background in GPT-Live's instructions, framed never to read out", firstIn.instructions.includes(G.theirWordsNote("gave notice, last day the 21st, freelance or join a studio?")) && /never to read out/.test(G.theirWordsNote("x")) && firstIn.instructions.includes(G.FIRST_CALL_LINE));
check("GPT-Live may build its opening on that background (one clause in what it says on its own)", firstIn.instructions.includes(`${G.SAY_ON_YOUR_OWN} ${G.OPENING_MAY_USE_BACKGROUND}`));
check("a later call's opening has none of it", !laterIn.instructions.includes(G.FIRST_CALL_LINE) && !/What they texted you/.test(laterIn.instructions));
const firstOut = G.buildLiveCall({ ...base, direction: "outbound", callReason: "They asked Cue to call.", first: { firstCall: true, theirWords: "gave notice, last day the 21st, freelance or join a studio?", inviter: "Noor", emailOnFile: false } });
check("outbound first call: their words and the inviter wait for a person on the line (voicemail/AMD hold), never in the instructions", !/gave notice|Noor/.test(firstOut.instructions) && firstOut.instructions.includes(G.FIRST_CALL_LINE) && G.heldOpeningNote(firstOut.opening).includes("gave notice") && G.heldOpeningNote(firstOut.opening).includes("Noor") && G.heldOpeningNote(firstOut.opening).startsWith(G.reasonNote("They asked Cue to call.")));
check("outbound later call: the held note is the reason alone, as before", G.heldOpeningNote(G.buildLiveCall({ ...base, direction: "outbound", callReason: "R." }).opening) === G.reasonNote("R."));
check("the bridge sends the held note only on confirmPerson", /const held = heldOpeningNote\(call\.opening\);\s*\n\s*if \(held\) send\(ai, \{ type: "session\.thinking\.append", event_id: "reason"/.test(src("src/services/gptLiveBridge.ts")));
{
  const worst = G.buildLiveCall({ ...base, firstName: "Alexandria-Maximiliana", direction: "inbound", team: true, first: { firstCall: true, theirWords: "x".repeat(400), inviter: "Bartholomew", emailOnFile: false } });
  check("GPT-Live's instructions stay under the session cap with every first-call line at its longest", worst.instructions.length <= G.GPT_LIVE.maxInstructionChars && worst.opening.theirWords!.length === 160, worst.instructions.length);
}

// ---------------------------------------------------------------- 2. the inviter, only when they wrote the name
check("the inviter is named when they wrote it", F.inviterNamedByThem("Noor", ["Hi Cue, Noor invited me. Code: 6VGF76VK"]) === "Noor");
check("never when they didn't", F.inviterNamedByThem("Noor", ["Hi Cue, I was invited. Code: 6VGF76VK", "a friend sent me"]) === null);
check("a name inside another word isn't theirs to have written", F.inviterNamedByThem("Al", ["I work in sales at Alphabet"]) === null);
check("no inviter, no name", F.inviterNamedByThem(null, ["Noor invited me"]) === null);
{
  const named = await F.firstCallFacts("u-ellis", fakeDb({ texts: ["Hi Cue, Noor invited me. Code: 6VGF76VK"], inviter: "Noor" }));
  const unnamed = await F.firstCallFacts("u-ellis", fakeDb({ texts: ["Hi Cue, I was invited. Code: 6VGF76VK"], inviter: "Noor" }));
  check("firstCallFacts: inviter only when they wrote the name", named.inviter === "Noor" && unnamed.inviter === null, { named, unnamed });
  const callUnnamed = G.buildLiveCall({ ...base, direction: "inbound", first: unnamed });
  check("a call whose member never wrote the inviter's name never carries it, anywhere", !/Noor/.test(callUnnamed.instructions) && !/Noor/.test(callUnnamed.backendSystem));
  check("the existing ban stays: GPT-Live names no person on its own (SAY_ON_YOUR_OWN unchanged)", /any event, place, time, person or link/.test(G.SAY_ON_YOUR_OWN));
}

// ---------------------------------------------------------------- 3. text sign-up: answered while collecting, asked once, never a condition
check("ask once: both missing, nothing asked yet", I.intakeAskFor({ knownName: null, knownEmail: null, partialEmail: null, asked: false }).join() === "name,email");
check("ask once: never again once asked", I.intakeAskFor({ knownName: null, knownEmail: null, partialEmail: null, asked: true }).length === 0);
check("ask once: only what's missing (a held email counts)", I.intakeAskFor({ knownName: null, knownEmail: null, partialEmail: "jordan@studio.co", asked: false }).join() === "name" && I.intakeAskFor({ knownName: "Jordan Lee", knownEmail: null, partialEmail: null, asked: false }).join() === "email");
const ask = I.intakeInstruction(["name", "email"], null) ?? "";
check("the ask is an instruction to the reply (its own words), after answering, never a condition", /after you've answered what they said/.test(ask) && /never a condition/.test(ask) && /help them fully either way/.test(ask) && /if they skip it, leave it/.test(ask) && !/"[^"]+[.?!]"/.test(ask));
check("no ask and no correction: no instruction", I.intakeInstruction([], null) === null);
check("a wrong email is answered, not held against them", /doesn't look complete/.test(I.intakeInstruction([], "email_invalid") ?? "") && /already on another account/.test(I.intakeInstruction([], "email_taken") ?? ""));
check("correction read from the gate's checks", I.intakeCorrection(I.decideIntake({ userId: "x", knownName: null, knownEmail: null, partialEmail: null, retries: 0, lastCoLine: null }, { full_name: null, email: "jordan@studio" }, { emailTakenByOtherAccount: false, replyText: "jordan@studio" })) === "email_invalid");
check("asked once is counted only when a reply that went out asked it", I.replyAskedFor(["name", "email"], "Glad you're here. What's your full name and email, so I can send you event details?") && !I.replyAskedFor(["name", "email"], "Packaging is a great niche.") && I.replyAskedFor(["name"], "And what name should I use?") && !I.replyAskedFor([], "email?"));
{
  const route = src("src/routes/sendblue.ts");
  const door = route.slice(route.indexOf("// Step 1.2 — Name/email intake"), route.indexOf("// Step 1.5 — First contact"));
  check("the text door never returns before the reply: no unanswered first text, no retry line", !/return res\.status\(200\)/.test(door) && !/intake_started|intake_incomplete|identity_captured"/.test(door) && !/intake\.reply|missingReply/.test(door));
  check("the first text gets the welcome, how Cue works and the card, and no name/email stock line", /welcome: true/.test(door) && /intro: true/.test(door) && /save_contact: true/.test(door) && !/intake_ask: true/.test(door));
  check("a good invite code falls through to the reply too (logged once, by the main path)", !/firstTryRedeemed\.ok\) \{\s*await logTextExchange/.test(route) && /if \(!redeemed\.ok\) await logTextExchange/.test(route));
  check("the reply gets the ask and marks it asked only from what went out", /const intakeNote = intakeInstruction\(intakeAsk, intakeFix\);/.test(route) && /deliveredThisTurn\.some\(\(m\) => replyAskedFor\(intakeAsk, m\)\)/.test(route));
  check("a new member's name isn't on file yet: the reply prompt still reads", /const name = input\.firstName\?\.trim\(\) \|\| "a new member";/.test(src("src/agent/conversationReply.ts")));
  check("the placeholder email is never told to Cue as theirs", /PENDING_EMAIL_DOMAIN/.test(src("src/services/memberKit.ts")));

  // ---------------------------------------------------------------- no Boardy call offer
  check("no automatic call offer: CALL_OFFER is gone and nothing in the door offers a five-minute call", !("CALL_OFFER" in OL) && !/CALL_OFFER\b|kickoffMsg|\$\{ONBOARDING_CALL_OFFER_PREFIX\} Asked/.test(route) && !Object.values(OL).some((v) => Array.isArray(v) && v.some((l) => /five-minute call|5-minute call/i.test(String(l)))));
  check("the reply's own call offer stays", /callOfferEligible/.test(src("src/agent/conversationReply.ts")));
}

// ---------------------------------------------------------------- 4. email on a call: asked once, captured, one text
{
  const T_ASKED = "assistant: Hi Jordan, it's Cue.\nuser: I'm going freelance.\nassistant: Best email for anything too long for a text?\nuser: jordan dot lee at gmail dot com\nassistant: Got it. Good luck, Jordan.";
  const T_NONE = "assistant: Hi Jordan.\nuser: I'm going freelance, my cofounder Priya Shah is at priya@shah.co\nassistant: Good luck.";
  const run = async (o: { transcript: string; email?: string; name?: string | null; extract?: string; taken?: boolean; draft?: string | null }) => {
    const writes: string[] = [], sends: any[] = [], records: any[] = [];
    let extracted = 0;
    const db = {
      query: async (sql: string, args?: unknown[]) => {
        if (/^SELECT first_name/.test(sql)) return { rows: [{ first_name: o.name === null ? "" : "Jordan", last_name: o.name === null ? "" : "Lee", email: o.email ?? "pending-ab12@copatible.pending", phone_number: "+14155550199", intake_partial_email: null, intake_retries: 0, sms_opted_out: false, archived_at: null }] };
        writes.push(`${sql} ${JSON.stringify(args)}`);
        return { rows: [] };
      },
    };
    const r = await CE.captureEmailFromCall("u-jordan", o.transcript, {
      db,
      extract: async () => { extracted++; return o.extract ?? `{"full_name": null, "email": "jordan.lee@gmail.com", "is_acknowledgment": false}`; },
      emailTaken: async () => !!o.taken,
      draft: async () => (o.draft === undefined ? "Got jordan.lee@gmail.com down for you." : o.draft),
      send: async (s) => { sends.push(s); return { sent: true }; },
      zone: async () => "America/Los_Angeles",
      record: (async (x: any) => { records.push(x); }) as any,
    });
    return { r, writes, sends, records, extracted };
  };
  const onFile = await run({ transcript: T_ASKED, email: "jordan@studio.co" });
  check("email on file: nothing read, written or sent", onFile.r.action === "on_file" && onFile.extracted === 0 && !onFile.writes.length && !onFile.sends.length);
  const got = await run({ transcript: T_ASKED });
  check("a spoken email goes through the intake extraction and gate, and is written", got.r.action === "confirmed" && got.extracted === 1 && got.writes.some((w) => /identity_captured = true/.test(w) && w.includes("jordan.lee@gmail.com")));
  check("Cue asking on the call counts as the one ask", got.writes.some((w) => /intake_retries = GREATEST/.test(w)));
  check("one text confirms the address, once per call", got.sends.length === 1 && got.sends[0].text.includes("jordan.lee@gmail.com") && /^call_email:/.test(got.sends[0].key));
  const fallback = await run({ transcript: T_ASKED, draft: "Thanks for sharing!" });
  check("a draft without the address falls back to the line for review", fallback.sends[0]?.text === CE.EMAIL_CONFIRM_FALLBACK("jordan.lee@gmail.com"));
  const notTheirs = await run({ transcript: T_NONE, extract: `{"full_name": "Priya Shah", "email": "priya@shah.co"}` });
  check("only their email is taken from a call, never a name (call lines name other people)", !notTheirs.writes.some((w) => /Priya/.test(w)));
  const invented = await run({ transcript: T_ASKED, extract: `{"full_name": null, "email": "jordan@lee.com"}` });
  check("an address that isn't in their words is dropped: nothing written, no text", invented.r.action === "dropped" && !invented.writes.some((w) => /jordan@lee\.com/.test(w)) && !invented.sends.length);
  const taken = await run({ transcript: T_ASKED, taken: true });
  check("an address on another account is dropped quietly", taken.r.action === "dropped" && !taken.sends.length);
  const noName = await run({ transcript: T_ASKED, name: null });
  check("no name on file yet: the email is held as the partial email, as on texts", noName.writes.some((w) => /intake_partial_email = \$2/.test(w)) && !noName.writes.some((w) => /identity_captured = true/.test(w)));
  const quiet = await run({ transcript: "assistant: Best email?\nuser: I'd rather not, text is fine." });
  check("they'd rather not: dropped, no model call, the ask still counted once", quiet.r.action === "none_said" && quiet.extracted === 0 && quiet.writes.some((w) => /intake_retries = GREATEST/.test(w)));
  check("asked once across text and call: a first call after the text asked says not to ask again", /already asked for once: don't ask again/.test(G.withFirstCallFacts("", { firstCall: true, emailOnFile: false, emailAsked: true })) && /never ask for it/.test(G.withFirstCallFacts("", { firstCall: true, emailOnFile: true })));
  check("post-call processing runs the email capture", /captureEmailFromCall\(user_id, cleanTranscript\)/.test(src("src/routes/co.ts")));
}

// ---------------------------------------------------------------- with #367 (the quiet first day) and #368 (the whole-exchange moves)
{
  const A = await import("../../src/harness/attention.js");
  const X = await import("../../src/services/exchangeRecord.js");
  const CG = await import("../../src/harness/callGate.js");
  const now = new Date("2026-11-03T18:00:00Z");
  const att = { sent: [], inbound: [], sentToday: [], lastAsked: null } as any;
  const firstDay = (cls: any, channel: any) => A.attentionChecks({ now, zone: "America/Los_Angeles", cls, channel, joinedAt: new Date(now.getTime() - 3_600_000), att, prefs: [] });
  check("#367 first-day quiet holds only what Cue starts: the email confirmation after a call (call_confirm, requested) is never held", firstDay("requested", "text").length === 0 && firstDay("checkin", "call").some((k) => k.name === "first_day_quiet"));
  check("#367: the first call they ask for is never a Cue-started call (no attention read)", !CG.CUE_STARTED_CALLS.has("router_decision") && !CG.CUE_STARTED_CALLS.has("user_initiated") && !CG.CUE_STARTED_CALLS.has("scheduled_call"));
  const route = src("src/routes/sendblue.ts");
  const door = route.slice(route.indexOf("// Step 1.2 — Name/email intake"), route.indexOf("// Step 1.5 — First contact"));
  check("#367: the text door's replies go through the reply agent, never the attention gate", !/attention/i.test(door) && !/sendExempt/.test(door));
  const fc = G.withFirstCallFacts("", { firstCall: true, emailOnFile: false });
  check("#368: the first-call facts square the guidance with the moves (a thread question is the needed ask; the email ask never in a close)", fc.includes(G.FIRST_CALL_MOVES) && /"close" only when their latest message closes/.test(X.MOVES_GUIDE) && /No new question/.test(X.MOVE_MEANINGS.close));
  check("#368: a later call gets no first-call moves line", !G.withFirstCallFacts("ctx", { firstCall: false }).includes(G.FIRST_CALL_MOVES));
  check("#368: the text ask waits when the reply's move is close, feeling or quiet", /move is close, feeling or quiet, leave the ask/.test(I.intakeInstruction(["email"], null) ?? ""));
  check("#367: the call prompt keeps the check-in feeling line beside the first-call guidance", firstIn.backendSystem.includes((await import("../../src/services/elevenLabsCalls.js")).CALL_CHECKIN_FEELING));
  check("the approved email confirmation line, word for word", CE.EMAIL_CONFIRM_FALLBACK("{email}") === "Got your email as {email}. If that's not right, just text me the right one.");
}

console.log(`first conversation: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
